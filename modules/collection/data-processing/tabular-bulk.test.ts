import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { createTabularRowSemantics, TABULAR_CONTRACT_VERSION, tabularDigest, tabularIdentityRule,
  type TabularTableContract } from '../../../contracts/tabular-batch.js';
import { freezeRegisteredTabularBulkProfile, TabularBulkProfileStore,
  type FrozenTabularBulkProfile } from '../tabular-bulk-profile.js';
import { SourceFieldProfileStore } from '../source-field-profile.js';
import { compileTabularBulk, freezeTabularBulkPlan, readTabularBulkChunk, readTabularBulkLocators } from './tabular-bulk.js';

const tableContract = (fields = ['category','code','label'], key_fields = ['code'], partition_field: string | null = 'category'): TabularTableContract => {
  const contract = { version: TABULAR_CONTRACT_VERSION, fields, key_fields, partition_field, time: { kind: 'unknown' } } as const;
  return { ...contract, digest: tabularDigest(contract) };
};
function registration(table = tableContract()) {
  return {
    version: 'bd.tabular-bulk-profile/1', profileId: 'synthetic-catalog', mappingVersion: 1, sourceId: 'example',
    series: 'categories', confirmation: { basis: '隔离测试的原列和复合键已核对', confirmedBy: 'synthetic-review', confirmedAtUtc: '2026-11-13T00:00:00Z' },
    columns: table.fields.map(fieldCode => ({ fieldCode, originalHeader: fieldCode, ...(fieldCode === 'label' ? { aliases: ['名称'] } : {}) })),
    tableContract: table, targetTemplate: { outputKey: 'source.categories', subject: { id: 'categories', kind: 'entity' },
      inputMode: 'partial_observation', definition: { semantic_code: 'source.categories', measurement_nature: 'mixed_observation',
        time_role: 'observation', unit_code: 'per_field', field_definitions: table.fields.map(field_code =>
          ({ field_code, data_type: 'text', unit_code: 'not_applicable', measurement_nature: 'mixed_observation', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
          identity: { subject_kind: 'entity', identity_resolution_rule: tabularIdentityRule(table) },
          time: { roles: { public_time: 'unknown' } } } },
      coverage: { scope: { subject_id: 'categories' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } },
  };
}
const source = (series: string) => ({ source_id: 'example', provider: 'synthetic', requested_url: 'file:///' + series + '/rows.csv',
  requested_at_utc: '2026-11-13T00:00:00Z', acquired_at_utc: '2026-11-13T00:00:00Z', usage_scope: 'synthetic only' });
const params = (bytes: Buffer, profile: FrozenTabularBulkProfile, partitionValue?: string) => ({
  profile, source: source(profile.profile.series), namespace: 'synthetic.local', datasetId: 'catalog-dataset', parentSnapshotId: null,
  materialId: 'catalog-material', sourceSha256: wfdSha256(bytes), sourceBytes: bytes.length, targetIdentity: { requestId: 'synthetic' },
  ...(partitionValue === undefined ? {} : { partitionValue }),
});
async function* blocks(bytes: Buffer, size = 1) { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size); }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'bd-tabular-bulk-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('registered non-minute table compiles checked original text, sorted cells and real byte locators', async t => {
  const path = await fixture(t), config = join(path, 'profiles'), stagingDir = join(path, 'staging');
  await mkdir(config); await mkdir(stagingDir);
  const registered = registration();
  await writeFile(join(config, 'catalog.json'), JSON.stringify(registered));
  const store = new TabularBulkProfileStore(config);
  assert.equal(store.match({ sourceId: 'example', series: 'wrong' }), null);
  assert.equal(store.match({ sourceId: 'example', series: 'categories', profileId: 'other' }), null);
  const profile = store.match({ sourceId: 'example', series: 'categories' })!;
  const rowZ = '"名""称\r\n尾",𐀀,分类/不作路径\r\n', rowA = ',,分类/不作路径';
  const bytes = Buffer.from('\uFEFF名称,code,category\r\n' + rowZ + rowA);
  const plan = freezeTabularBulkPlan(params(bytes, profile));
  const manifest = await compileTabularBulk({ plan, original: blocks(bytes), stagingDir });
  assert.deepEqual(manifest.partition, { value: '分类/不作路径' });
  assert.deepEqual(manifest.fieldCodes, ['category','code','label']);
  assert.equal(manifest.check.standardMarketCalculation, false);
  assert.ok(manifest.check.checkScope.includes('original_cells_preserved') || manifest.check.checkScope.includes('explicit_scalar_types'));
  const chunk = manifest.chunks[0]!;
  const rows = await readTabularBulkChunk(stagingDir, chunk, 3);
  assert.deepEqual(rows, [['分类/不作路径','',''], ['分类/不作路径','𐀀','名"称\r\n尾']]);
  const locators = await readTabularBulkLocators(stagingDir, chunk, manifest.locatorDigests[0]!);
  assert.deepEqual(locators.map(loc => bytes.subarray(loc.startByte, loc.endByte).toString()), [rowA, rowZ]);
  const row = createTabularRowSemantics(manifest.tableContract, manifest.partition).semanticRow(rows[0]!, manifest.target.subject);
  assert.deepEqual(row.observation_time, { status: 'unknown' });
  assert.equal(row.business_key, 'tabular_' + wfdSha256(JSON.stringify(['分类/不作路径', ['']])));
  assert.deepEqual(await readdir(stagingDir), ['c000000.json','c000000.loc.json']);
});

test('registered stream enforces 1 to 64 columns, duplicate and partition checks', async t => {
  const path = await fixture(t);
  for (const count of [1, 64]) {
    const fields = Array.from({ length: count }, (_, i) => 'c' + i);
    const profile = freezeRegisteredTabularBulkProfile(registration(tableContract(fields, ['c0'], null)));
    const bytes = Buffer.from(fields.join(',') + '\n' + fields.join(','));
    assert.throws(() => freezeTabularBulkPlan(params(bytes, profile)), /常量分区值/);
    const stagingDir = join(path, String(count)); await mkdir(stagingDir);
    const manifest = await compileTabularBulk({ plan: freezeTabularBulkPlan(params(bytes, profile, '常量')),
      original: blocks(bytes, 7), stagingDir });
    assert.deepEqual(await readTabularBulkChunk(stagingDir, manifest.chunks[0]!, count), [fields]);
  }
  assert.throws(() => freezeRegisteredTabularBulkProfile(registration(tableContract(
    Array.from({ length: 65 }, (_, i) => 'c' + i), ['c0'], null))), /字段/);
  const profile = freezeRegisteredTabularBulkProfile(registration());
  for (const [i, [csv, expected]] of [
    ['category,code,label\na,x,one\na,x,two', /业务键重复/],
    ['category,code,label\na,x,one\nb,y,two', /分区字段/],
    ['category,code,label\na, \t,one', /非空白/],
  ].entries()) {
    const bytes = Buffer.from(csv as string), stagingDir = join(path, 'fail' + i); await mkdir(stagingDir);
    await assert.rejects(compileTabularBulk({ plan: freezeTabularBulkPlan(params(bytes, profile)), original: blocks(bytes), stagingDir }), expected as RegExp);
  }
});

test('existing audited minute profile adapts to the same table compiler and preserves minute evidence', async t => {
  const path = await fixture(t), stagingDir = join(path, 'staging'), legacy = join(path, 'legacy');
  await mkdir(stagingDir); await mkdir(legacy);
  const headers = ['证券代码','证券名称','交易日期','分钟时间','开盘价（元）','最高价（元）','最低价（元）',
    '收盘价（元）','成交量','成交额','复权因子'];
  await writeFile(join(legacy, 'minute.json'), JSON.stringify({
    version:'bd.source-field-profile/1', mappingVersion:1, profileId:'synthetic-minute', sourceId:'example', series:'1min',
    confirmation:{ status:'operator_confirmed', basis:'核对十一项合成来源原报表头', confirmedAtUtc:'2026-11-13T00:00:00Z' },
    frequency:'minute', timeBucket:{ labelSemantics:'unknown', interval:'unknown', lengthMinutes:1, timezone:'Asia/Shanghai' },
    adjustment:{status:'unknown'}, fields: headers.map((originalHeader,i)=>({originalHeader,fieldCode:'src_'+i,dataType:'text',
      unitCode:i===2?'date':'not_applicable', role:['identity','value','date','minute'][i]??'value', ...(i>=4?{measurementStatus:'unknown'}:{}) })),
  }));
  const profile = new TabularBulkProfileStore(join(path,'profiles'), new SourceFieldProfileStore(legacy)).match({sourceId:'example',series:'1min'})!;
  assert.ok(profile);
  const bytes = Buffer.from(headers.join(',') + '\n000001,甲,20260407,2026-04-07 09:30:00,0.0,0,,0,0,0,0');
  const manifest = await compileTabularBulk({ plan: freezeTabularBulkPlan(params(bytes, profile)), original: blocks(bytes), stagingDir });
  assert.equal(manifest.tableContract.time.kind, 'source_minute');
  const [row] = await readTabularBulkChunk(stagingDir, manifest.chunks[0]!, 11);
  assert.equal(row![6], '');
  assert.deepEqual(createTabularRowSemantics(manifest.tableContract, manifest.partition).semanticRow(row!, {}).observation_time, {
    status: 'known', earliest_utc: '2026-04-07T01:30:00Z', latest_exclusive_utc: '2026-04-07T01:31:00Z',
    precision: 'minute', source_timezone: 'Asia/Shanghai',
  });
  assert.equal(Object.values(manifest.target.definition.field_semantic_context as Record<string, {content:{assertion_status:string}}>).
    filter(field => field.content.assertion_status === 'source_reported_lexeme_unit_unknown').length, 7);
});

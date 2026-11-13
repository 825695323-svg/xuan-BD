import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { profileFingerprint, readSourceFieldProfile, sourceFieldProfileDigest } from '../source-field-profile.js';
import {
  compileSourceMinuteBulk, freezeSourceMinuteBulkPlan, readSourceMinuteBulkChunk, readSourceMinuteBulkLocators,
  sourceMinuteBulkKey, SOURCE_MINUTE_BULK_LIMITS, type SourceMinuteBulkPlanInput,
} from './source-minute-bulk.js';

const headers = ['证券代码', '证券名称', '交易日期', '分钟时间', '开盘价（元）', '最高价（元）', '最低价（元）',
  '收盘价（元）', '成交量', '成交额', '复权因子'];
const date = '20260407', minute = '2026-04-07 09:30:00';
const header = '\ufeff' + headers.join(',') + '\r\n';
const dayRow = (id: string, name = '甲', rawDate = date, label = minute) =>
  [id, name, rawDate, label, '0.0', '0', '', '-1.00', '3.0', ' ', '未报'].join(',');
function testProfile() {
  const profile = readSourceFieldProfile({
    version: 'bd.source-field-profile/1', mappingVersion: 1, profileId: 'synthetic-minute', sourceId: 'test-source', series: 'synthetic-series',
    confirmation: { status: 'operator_confirmed', basis: '合成夹具：仅原报文字', confirmedAtUtc: '2026-01-01T00:00:00Z' },
    frequency: 'minute', timeBucket: { labelSemantics: 'unknown', interval: 'unknown', lengthMinutes: 1, timezone: 'Asia/Shanghai' },
    adjustment: { status: 'unknown' },
    fields: headers.map((originalHeader, i) => ({ originalHeader, fieldCode: 'src_' + i, dataType: 'text',
      unitCode: i === 2 ? 'date' : 'not_applicable', role: ['identity', 'value', 'date', 'minute'][i] ?? 'value',
      ...(i >= 4 ? { measurementStatus: 'unknown' } : {}) })),
  }, 'synthetic');
  return { profile, digest: sourceFieldProfileDigest(profile), fingerprint: profileFingerprint(profile) };
}
function params(original: Buffer): SourceMinuteBulkPlanInput {
  return {
    profile: testProfile(), materialId: 'm-synthetic', sourceSha256: wfdSha256(original), sourceBytes: original.length,
    namespace: 'synthetic.local', datasetId: 'test-dataset', parentSnapshotId: null,
    source: { source_id: 'test-source', provider: 'synthetic', requested_url: 'file:///synthetic-series/day.csv',
      requested_at_utc: '2026-11-13T00:00:00Z', acquired_at_utc: '2026-11-13T00:00:00Z', usage_scope: 'synthetic only' },
    targetIdentity: { runtime: 'synthetic', requestId: 'same-request', duplicatePolicy: 'append-complete-partition' },
  };
}
async function* splits(original: Buffer, size: number) {
  for (let start = 0; start < original.length; start += size) yield original.subarray(start, start + size);
}
async function temp(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(await realpath(process.env.BD_SYNTHETIC_BULK_TMP ?? tmpdir()), 'bd-source-minute-bulk-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('bulk compiles cross-block BOM/UTF-8/quotes/CRLF and preserves lexical values and source byte locations', async t => {
  const path = await temp(t), one = join(path, 'one'), two = join(path, 'two');
  await mkdir(one); await mkdir(two);
  const rowA = dayRow('', '"名""称\r\n续"'), rowB = dayRow('𐀀'), rowC = dayRow('000001', '尾');
  const original = Buffer.from(header + rowB + '\r\n' + rowA + '\r\n' + rowC);
  const plan = freezeSourceMinuteBulkPlan(params(original));
  const manifest = await compileSourceMinuteBulk({ plan, original: splits(original, 1), stagingDir: one });
  const replay = await compileSourceMinuteBulk({ plan: JSON.parse(JSON.stringify(plan)), original: splits(original, 97), stagingDir: two });
  assert.deepEqual(replay, manifest);
  assert.equal(manifest.rowCount, 3);
  assert.deepEqual(manifest.evidenceRange, { startByte: 0, endByte: original.length, sha256: 'sha256:' + wfdSha256(original) });
  assert.equal(manifest.check.standardMarketCalculation, false);
  assert.equal(manifest.target.definition.semantic_code, manifest.target.outputKey);
  assert.match(manifest.target.outputKey, /^source_minute\./);
  assert.match(String((manifest.target.definition.semantic_context as any).identity.identity_resolution_rule), /^wfd\.source-minute-key\/1:/);
  assert.equal(Object.values(manifest.target.definition.field_semantic_context as Record<string, any>)
    .filter(field => field.content.assertion_status === 'source_reported_lexeme_unit_unknown').length, 7);
  assert.deepEqual(manifest.partition, { date, date_field: 'src_2', minute_field: 'src_3', identity_field: 'src_0',
    timezone: 'Asia/Shanghai', key_algorithm: 'wfd.source-minute-key/1' });
  const chunk = manifest.chunks[0]!;
  const cells = await readSourceMinuteBulkChunk(one, chunk);
  assert.deepEqual(cells.map(row => row[0]), ['000001', '', '𐀀']); // UTF-8 order differs from UTF-16 here
  assert.equal(cells[1]![1], '名"称\r\n续');
  assert.deepEqual(cells[0]!.slice(4), ['0.0', '0', null, '-1.00', '3.0', ' ', '未报']);
  assert.equal(manifest.rowsDigest, 'sha256:' + createHash('sha256').update(cells.map(row => canonicalWfdJson(row) + '\n').join('')).digest('hex'));
  const locs = await readSourceMinuteBulkLocators(one, chunk, manifest.locatorDigests[0]!);
  assert.deepEqual(locs.map(loc => [loc.sourceRow, loc.sourceLine]), [[4, 5], [3, 3], [2, 2]]);
  assert.deepEqual(locs.map(loc => original.subarray(loc.startByte, loc.endByte).toString('utf8')), [rowC, rowA + '\r\n', rowB + '\r\n']);
  assert.deepEqual(await readdir(one), ['c000000.json', 'c000000.loc.json']);
  assert.equal(sourceMinuteBulkKey(date, '000001', minute), 'source_minute_20260407_' + wfdSha256(JSON.stringify(['000001', minute])));
  const data = await readFile(join(one, 'c000000.json'));
  data[data.indexOf(48)] = 49;
  await writeFile(join(one, 'c000000.json'), data);
  await assert.rejects(readSourceMinuteBulkChunk(one, chunk), /冻结摘要不一致/);
});

test('bulk fails closed on malformed tail, date disagreement, empty identity, and changed frozen source', async t => {
  const path = await temp(t);
  const cases = [
    [Buffer.from(header + dayRow('000001') + '\r\n' + dayRow('000002', '"错尾')), /未闭合引号/],
    [Buffer.from(header + dayRow('000001') + '\r\n' + dayRow('000002', '乙', '20260408', '2026-04-08 09:30:00')), /单日期分区/],
    [Buffer.from(header + dayRow('000001', '乙', date, '2026-04-07T09:30:00')), /单日期分区/],
    [Buffer.from(header + dayRow('000001', '乙', date, '2026-04-07 09:30:01')), /原报分钟标签/],
    [Buffer.from(header + dayRow(' \t', '乙')), /非空原报身份/],
    [Buffer.from(header + dayRow('000001') + '\r\n2,bad'), /行列数不一致/],
    [Buffer.concat([Buffer.from(header + dayRow('000001') + '\r\n'), Buffer.from([255]), Buffer.from(dayRow('000002'))]), /严格 UTF-8/],
  ] as const;
  for (const [index, [original, expected]] of cases.entries()) {
    const stagingDir = join(path, String(index)); await mkdir(stagingDir);
    await assert.rejects(compileSourceMinuteBulk({ plan: freezeSourceMinuteBulkPlan(params(original)),
      original: splits(original, 7), stagingDir }), expected);
    assert.equal((await readdir(stagingDir)).filter(name => name.startsWith('c')).length, 0);
  }
  const original = Buffer.from(header + dayRow('000001'));
  const stagingDir = join(path, 'hash'); await mkdir(stagingDir);
  const plan = freezeSourceMinuteBulkPlan({ ...params(original), sourceSha256: '0'.repeat(64) });
  await assert.rejects(compileSourceMinuteBulk({ plan, original: splits(original, 3), stagingDir }), /完整受管原件与冻结 SHA-256 不符/);
});

test('bulk rejects identical source keys across processing and external sort runs', async t => {
  const stagingDir = await temp(t);
  // The line length forces many processing segments, and the total exceeds the 4 MiB sort run size.
  const body = Array.from({ length: 1250 }, (_, i) => dayRow(String(i).padStart(6, '0'), 'x'.repeat(3400))).join('\n');
  const original = Buffer.from(header + body + '\n' + dayRow('000000', 'x'.repeat(3400)));
  await assert.rejects(compileSourceMinuteBulk({ plan: freezeSourceMinuteBulkPlan(params(original)),
    original: splits(original, 65536), stagingDir }), /来源身份和分钟重复/);
});

test('bulk rejects over-budget input and invalid original-measurement qualification', async t => {
  const stagingDir = await temp(t);
  const original = Buffer.from(header + dayRow('000001', 'x'.repeat(SOURCE_MINUTE_BULK_LIMITS.recordBytes)));
  const input = params(original);
  await assert.rejects(compileSourceMinuteBulk({ plan: freezeSourceMinuteBulkPlan(input),
    original: splits(original, 4096), stagingDir }), /单条字节预算/);
  assert.throws(() => freezeSourceMinuteBulkPlan({ ...input, sourceBytes: SOURCE_MINUTE_BULK_LIMITS.sourceBytes + 1 }), /单件接收预算/);
  const profile = structuredClone(input.profile.profile);
  delete profile.fields[4]!.measurementStatus;
  assert.throws(() => freezeSourceMinuteBulkPlan({ ...input, profile: { profile,
    digest: sourceFieldProfileDigest(profile), fingerprint: profileFingerprint(profile) } }), /七个明确未知计量/);
});

test('bulk aborts before exposing a manifest and validates temporary run bytes before publishing chunk metadata', async t => {
  const path = await temp(t), aborted = join(path, 'abort'), corrupt = join(path, 'corrupt');
  await mkdir(aborted); await mkdir(corrupt);
  const original = Buffer.from(header + dayRow('000001'));
  const plan = freezeSourceMinuteBulkPlan(params(original));
  const controller = new AbortController();
  await assert.rejects(compileSourceMinuteBulk({ plan, original: splits(original, 64), stagingDir: aborted,
    signal: controller.signal, onProgress: p => { if (p.stage === 'sort') controller.abort(new Error('synthetic abort')); } }), /synthetic abort/);
  assert.equal((await readdir(aborted)).filter(name => name.startsWith('c')).length, 0);
  await assert.rejects(compileSourceMinuteBulk({ plan, original: splits(original, 64), stagingDir: corrupt, onProgress: async p => {
    if (p.stage !== 'sort') return;
    const run = join(corrupt, 'run-0-0.ndjson');
    const bytes = await readFile(run, 'utf8');
    await writeFile(run, bytes.replace('0.0', '0.1'), 'utf8');
  } }), /排序片段末尾或内容与生成时不一致/);
});

test('bulk sorts across transport boundaries and obtains the same ordered digest from reordered input', async t => {
  const path = await temp(t), a = join(path, 'a'), b = join(path, 'b');
  await mkdir(a); await mkdir(b);
  const rows = Array.from({ length: 5300 }, (_, i) => dayRow(String(i).padStart(6, '0')));
  const original = Buffer.from(header + rows.slice().reverse().join('\n')), reordered = Buffer.from(header + rows.join('\n'));
  const result = await compileSourceMinuteBulk({ plan: freezeSourceMinuteBulkPlan(params(original)),
    original: splits(original, 32768), stagingDir: a });
  const comparison = await compileSourceMinuteBulk({ plan: freezeSourceMinuteBulkPlan(params(reordered)),
    original: splits(reordered, 65536), stagingDir: b });
  assert.equal(result.rowsDigest, comparison.rowsDigest);
  assert.notEqual(result.manifestDigest, comparison.manifestDigest);
  assert.deepEqual(result.chunks, comparison.chunks);
  assert.deepEqual(result.chunks.map(chunk => [chunk.ordinal, chunk.row_count]), [[0, 5000], [1, 300]]);
  assert.equal((await readSourceMinuteBulkChunk(a, result.chunks[0]!)).at(-1)?.[0], '004999');
  assert.equal((await readSourceMinuteBulkChunk(a, result.chunks[1]!))[0]?.[0], '005000');
});

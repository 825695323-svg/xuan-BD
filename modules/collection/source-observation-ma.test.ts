import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { R1ConnectionIdentity, R1RequestView, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { parseTableSource } from './candidate-pipeline.js';
import { sourceReportedCode, type CandidateSourceProjection } from './source-reported-table.js';
import { buildSourceObservationMA, sourceObservationMAAlgorithmDefinition, summarizeCalculatedMAProof,
  type SourceObservationMAInput } from './source-observation-ma.js';
import { R1AutoBatchService } from './r1-auto-batch.js';
import type { R1AutoService, R1AutoView } from './r1-auto.js';
import type { MaterialService } from './materials/service.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import { CoreDatabase } from '../../platform/state/database.js';

const connection: R1ConnectionIdentity = { connectionId: 'isolated-test', protocol: 'wfd.structured-ingest/1.0',
  profile: 'data_only', mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'isolated', store: '/isolated/store', runtime: '/isolated/runtime',
  callerId: 'isolated', namespace: 'isolated', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
  entrySha256: '3'.repeat(64), pythonPath: '/isolated/python', entryPath: '/isolated/entry' };
const source: R1SourceDeclaration = { source_id: 'synthetic', provider: 'isolated auxiliary fixture',
  requested_url: 'file:///explicit-auxiliary', requested_at_utc: '2026-01-10T00:00:00Z', acquired_at_utc: '2026-01-10T00:00:00Z',
  usage_scope: 'isolated arithmetic check', authorization: { status: 'authorized', basis: 'operator selected auxiliary calculation fixtures' } };
const subject = { kind: 'entity', namespace: 'isolated', id: 'source_series' };
const code = (column: string) => sourceReportedCode('src_', column)!;
const projection: CandidateSourceProjection = { version: 'source-reported-table/1', dateColumn: 'date', dateEncoding: 'yyyymmdd',
  timezone: 'Asia/Shanghai', keyColumns: ['date', 'symbol'], sourceColumns: ['date', 'symbol', 'reading'],
  fields: ['date', 'symbol', 'reading'].map((column, index) => ({ column, fieldCode: code(column), stateColumn: '__bd_source_state_' + index })) };

/** Auxiliary fixed-read envelopes support the pure arithmetic checks; they are not WFD integration evidence. */
function input(id: string, rows: string[][], selectedProjection: CandidateSourceProjection = projection): SourceObservationMAInput {
  const original = Buffer.from(selectedProjection.sourceColumns.join(',')+'\n' + rows.map(row => row.join(',')).join('\n') + '\n');
  const parsed = parseTableSource(original, { materialId: id, format: 'csv', sourceProjection: selectedProjection });
  const get = (row: typeof parsed.rows[number], column: string) => row[parsed.columns.indexOf(column)]!.value;
  const associations = parsed.rows.map(row => ({ product_id: 'source_product', snapshot_id: 'snapshot_' + id,
    definition_digest: 'definition', record_id: get(row, '__bd_source_key'), record_version: 'rev_' + id + '_' + get(row, '__bd_source_key') }));
  const fixedRows: WfdRecord[] = parsed.rows.map((row, index) => ({ record_ref: {
    logical_key: associations[index]!.record_id, revision_id: associations[index]!.record_version },
    values: Object.fromEntries(rows[index]!.map((value, column) => [code(selectedProjection.sourceColumns[column]!), {
      data_type: column === selectedProjection.sourceColumns.length-1 ? 'decimal' : 'text', value: value === '' ? null : value,
      value_state: value === '' ? 'unknown' : 'valid_value', unit: { unit_code: column === selectedProjection.sourceColumns.length-1 ? 'source_unit' : 'not_applicable' } }])) }));
  const request: R1RequestView = { requestId: 'request_' + id, state: 'associated', datasetId: 'observations',
    outputKey: 'source_family', documentSha256: '0'.repeat(64), connection, planId: 'plan_' + id, outputId: 'observations',
    rowCount: rows.length, previewRows: [{ subject }], submitTaskId: 'submit_' + id, requiresRecovery: false,
    local: { associations, local_refs: { sourceRefs: [{ ...source, sha256: wfdSha256(original), bytes: original.length }] } }, error: null };
  return { materialId: id, original, source, projection:selectedProjection, request, fixedRows };
}
const selection = { method: 'source_observation_ma' as const, period: 2, valueColumn: 'reading' };

test('minute observation MA sorts the original minute labels and never groups minutes as separate securities', () => {
  const columns=['date','symbol','minute','reading'];
  const minuteProjection:CandidateSourceProjection={...projection,version:'source-reported-table/2',
    keyColumns:['date','minute','symbol'],sourceColumns:columns,minute:{column:'minute',encoding:'iso-local-minute'},
    fields:columns.map((column,index)=>({column,fieldCode:code(column),stateColumn:'__bd_source_state_'+index}))};
  const late=input('minute-late',[
    ['20260407','A','2026-04-07 09:32:00','3'],['20260407','B','2026-04-07 09:31:00','200']],minuteProjection);
  const early=input('minute-early',[
    ['20260407','A','2026-04-07 09:30:00','1'],['20260407','B','2026-04-07 09:30:00','100'],
    ['20260407','A','2026-04-07 09:31:00','2']],minuteProjection);
  const generated=buildSourceObservationMA(selection,[late,early]);
  assert.deepEqual(generated.proof.lineage.map(row=>[row.groupValues[0],row.minute,row.value]),[
    ['A','2026-04-07T09:30:00',null],['A','2026-04-07T09:31:00','1.50000000'],['A','2026-04-07T09:32:00','2.50000000'],
    ['B','2026-04-07T09:30:00',null],['B','2026-04-07T09:31:00','150.00000000']]);
  assert.deepEqual(generated.proof.groupColumns,['symbol']);
  assert.equal(generated.proof.minuteColumn,'minute');
  assert.equal(generated.proof.methodVersion,'1.1.0');
  assert.equal(generated.proof.minuteLabelMeaning,'unknown');
  assert.deepEqual(JSON.parse(generated.bytes.toString()).map((row:WfdRecord)=>row['bd.precision']),Array(5).fill('minute'));
  assert.deepEqual(buildSourceObservationMA(selection,[early,late]).bytes,generated.bytes);
  const mixed=input('daily-same-product',[['20260408','A','5']]);
  assert.throws(()=>buildSourceObservationMA(selection,[early,mixed]),{code:'R1_MA_INCOMPATIBLE_INPUTS'});
  const changedMinute=structuredClone(early);
  ((changedMinute.fixedRows[0]!.values as WfdRecord)[code('minute')] as WfdRecord).value='2026-04-07 09:40:00';
  assert.throws(()=>buildSourceObservationMA(selection,[changedMinute]),{code:'R1_MA_VALUE_MISMATCH'});
  const duplicate=input('minute-normalized-duplicate',[
    ['20260407','A','2026-04-07 09:30:00','1'],['20260407','A','2026-04-07T09:30:00','1']],minuteProjection);
  assert.throws(()=>buildSourceObservationMA(selection,[duplicate]),{code:'R1_MA_DUPLICATE'});
});

test('source observation MA groups and sorts all batch files, preserving exact input references and isolated windows', () => {
  const late = input('late', [['20260103', 'A', '3'], ['20260102', 'B', '200']]);
  const early = input('early', [['20260102', 'A', '2'], ['20260101', 'B', '100'], ['20260101', 'A', '1']]);
  const generated = buildSourceObservationMA(selection, [late, early]);
  assert.deepEqual(generated.proof.lineage.map(row => [row.groupValues[0], row.date, row.status, row.value]), [
    ['A', '2026-01-01', 'warmup', null], ['A', '2026-01-02', 'valid', '1.50000000'], ['A', '2026-01-03', 'valid', '2.50000000'],
    ['B', '2026-01-01', 'warmup', null], ['B', '2026-01-02', 'valid', '150.00000000']]);
  assert.deepEqual(generated.proof.counts, { rows: 5, groups: 2, valid: 3, warmup: 2, windowMissing: 0 });
  assert.equal(generated.proof.version,'bd.source-observation-ma-proof/1');
  assert.equal(generated.proof.methodVersion,'1.0.0');
  assert.equal(generated.proof.minuteColumn,undefined);
  assert.equal(generated.proof.lineage[2]!.sourceIndex, 0); assert.equal(generated.proof.lineage[2]!.sourceRow, 1);
  assert.equal(generated.proof.lineage[2]!.windowStart, 1); assert.equal(generated.proof.lineage[2]!.windowCount, 2);
  assert.equal(generated.proof.lineage[3]!.windowStart, 3, 'A values cannot cross into B');
  assert.deepEqual(buildSourceObservationMA(selection, [early, late]).bytes, generated.bytes, 'Upload order does not change values or product semantics');
  const summary = summarizeCalculatedMAProof(generated.proof);
  assert.equal(summary.proofSha256, wfdSha256(canonicalWfdJson(generated.proof)));
  assert.equal(summary.lineageSha256, wfdSha256(canonicalWfdJson(generated.proof.lineage)));
  assert.equal('lineage' in summary, false);
  const definition = sourceObservationMAAlgorithmDefinition(generated.proof);
  assert.deepEqual(definition.constants, { period: 2, output_scale: 8 });
  assert.notEqual(buildSourceObservationMA({ ...selection, period: 3 }, [early, late]).proof.derivativeSemanticCode, generated.proof.derivativeSemanticCode);
});

test('full-window missing input propagates without dropping rows, filling values or confusing warmup with missing', () => {
  const generated = buildSourceObservationMA(selection, [input('missing', [
    ['20260101', 'A', '1'], ['20260102', 'A', ''], ['20260103', 'A', '3'], ['20260104', 'A', '5']])]);
  assert.deepEqual(generated.proof.lineage.map(row => [row.status, row.value]), [
    ['warmup', null], ['window_missing', null], ['window_missing', null], ['valid', '4.00000000']]);
  const rows = JSON.parse(generated.bytes.toString('utf8')) as WfdRecord[];
  assert.deepEqual(rows.map(row => row.value_state), ['unknown', 'unknown', 'unknown', 'valid_value']);
  assert.deepEqual(generated.proof.counts, { rows: 4, groups: 1, valid: 1, warmup: 1, windowMissing: 2 });
});

test('exact decimal mean uses final half-even rounding for positive and negative ties and preserves integers above binary64 precision', () => {
  const generated = buildSourceObservationMA(selection, [input('rounding', [
    ['20260101', 'A', '0'], ['20260102', 'A', '0.00000001'], ['20260103', 'A', '0.00000002'],
    ['20260101', 'B', '-0.00000001'], ['20260102', 'B', '-0.00000002'],
    ['20260101', 'C', '9007199254740993'], ['20260102', 'C', '9007199254740995']])]);
  assert.deepEqual(generated.proof.lineage.filter(row => row.status === 'valid').map(row => row.value), [
    '0.00000000', '0.00000002', '-0.00000002', '9007199254740994.00000000']);
});

test('conflicting batch keys, altered fixed values/versions and incompatible source scopes block calculation', () => {
  const a = input('first', [['20260101', 'A', '1']]), duplicate = input('again', [['20260101', 'A', '1']]);
  assert.throws(() => buildSourceObservationMA(selection, [a, duplicate]), { code: 'R1_MA_DUPLICATE' });
  const changedValue = input('value', [['20260102', 'A', '2']]);
  ((changedValue.fixedRows[0]!.values as WfdRecord)[code('reading')] as WfdRecord).value = '200';
  assert.throws(() => buildSourceObservationMA(selection, [changedValue]), { code: 'R1_MA_VALUE_MISMATCH' });
  const changedVersion = input('version', [['20260102', 'A', '2']]);
  (changedVersion.fixedRows[0]!.record_ref as WfdRecord).revision_id = 'other_revision';
  assert.throws(() => buildSourceObservationMA(selection, [changedVersion]), { code: 'R1_MA_INPUT_BINDING' });
  const differentScope = input('scope', [['20260102', 'A', '2']]);
  differentScope.source = { ...source, provider: 'another supplier' };
  (differentScope.request.local.local_refs as WfdRecord).sourceRefs = [{ ...differentScope.source,
    sha256: wfdSha256(differentScope.original), bytes: differentScope.original.length }];
  assert.throws(() => buildSourceObservationMA(selection, [a, differentScope]), { code: 'R1_MA_INCOMPATIBLE_INPUTS' });
  assert.throws(() => buildSourceObservationMA({ ...selection, period: 1 }, [a]), { code: 'R1_MA_SELECTION' });
});

test('a loaded implementation retains its original digest and rejects subsequent source drift in an isolated module copy', async () => {
  const originalUrl = new URL('./source-observation-ma.ts', import.meta.url);
  const source = readFileSync(originalUrl, 'utf8').replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/gu,
    (_match, before: string, specifier: string, after: string) => before + new URL(specifier.replace(/\.js$/u, '.ts'), originalUrl).href + after);
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'ma-loaded-code-'));
  const file = join(root, 'source-observation-ma.ts'); writeFileSync(file, source, { flag: 'wx' });
  const loaded = await import(pathToFileURL(file).href) as typeof import('./source-observation-ma.js');
  const initialDigest = loaded.sourceObservationMACodeDigest();
  assert.equal(initialDigest, wfdSha256(source));
  loaded.assertSourceObservationMAImplementationCurrent();
  writeFileSync(file, source + '\n// The isolated source changes after its functions were loaded.\n');
  assert.notEqual(wfdSha256(readFileSync(file)), initialDigest);
  assert.equal(loaded.sourceObservationMACodeDigest(), initialDigest, 'Old process code never claims a new on-disk digest');
  assert.throws(() => loaded.buildSourceObservationMA(selection, [input('drift', [['20260101', 'A', '1']])]),
    { code: 'R1_MA_IMPLEMENTATION_CHANGED' });
});

test('the batch rejects an oversized already-associated input set before calling the fixed product reader', async () => {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'ma-pre-read-budget-'));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  const originals = [Buffer.from('date,symbol,close\n20260101,A,1\n'), Buffer.from('date,symbol,close\n20260102,A,2\n')];
  const tasksByRequest = new Map<string, string>(), autoViews = new Map<string, R1AutoView>();
  let fixedReads = 0;
  // These are explicit unit ports: the assertion concerns dispatch before any WFD read,
  // not the business qualification or successful publication of 5,002 actual records.
  const tasks = { getControl: () => ({ stopped: false, generation: 1 }),
    get: (id: string) => ({ id, status: 'succeeded', version: 1 }) } as unknown as TaskService;
  const materials = { requestTask: (requestId: string) => {
    if (!tasksByRequest.has(requestId)) tasksByRequest.set(requestId, `custody-${tasksByRequest.size}`);
    return { id: tasksByRequest.get(requestId)! };
  }, getByTask: (taskId: string) => {
    const index = Number(taskId.slice('custody-'.length));
    return { envelope: { materialId: `material-${index}`, sha256: wfdSha256(originals[index]!), byteLength: originals[index]!.length } };
  }, readOriginal: (materialId:string) => ({bytes:originals[Number(materialId.slice('material-'.length))]!}) } as unknown as MaterialService;
  const auto = { start: (value: { requestId: string; materialId: string }) => {
    const view = { ...value, state: 'associated', error: null, updatedAt: 1, currentRequest: {
      ...input('envelope', [['20260101', 'A', '1']]).request, rowCount: 2501 } } as unknown as R1AutoView;
    autoViews.set(value.requestId, view); return view;
  }, get: (requestId: string) => autoViews.get(requestId) ?? (() => { throw new TaskError('R1_AUTO_NOT_FOUND', 'No auxiliary auto request yet.'); })() } as unknown as R1AutoService;
  const service = new R1AutoBatchService({ database, tasks: () => tasks, materials, auto, connection: () => connection,
    accept: async () => assert.fail('No new derived material may be accepted after the input row budget fails'),
    readCalculationInput: async () => { fixedReads++; assert.fail('The fixed product reader must not be called for an oversized input set'); } });
  try {
    service.start({ batchId: 'oversized-observations', source, datasetId: 'observations', calculation: {...selection,valueColumn:'close'},
      files: originals.map((bytes, index) => ({ name: `input-${index}.csv`, relativePath: `input-${index}.csv`,
        sha256: wfdSha256(bytes), byteLength: bytes.length })) }, {
      operatorId: 'isolated-test', requestId: 'batch-budget', method: 'POST', path: '/r1/batches/start', remoteAddress: '127.0.0.1', observedAt: Date.now() });
    await new Promise<void>(resolve => setImmediate(resolve));
    const result = service.get('oversized-observations');
    assert.equal(result.items.length, 2); assert.ok(result.items.every(item => item.state === 'associated'));
    assert.equal(result.calculation!.state, 'blocked'); assert.equal(result.calculation!.error!.code, 'R1_MA_ROW_BUDGET');
    assert.equal(result.calculation!.materialId, null); assert.equal(fixedReads, 0);
  } finally { await service.dispose(); database.close(); }
});

test('frozen-series continuation warms from prior acquisitions and selects corrections by the frozen published revision', () => {
  const first = input('first-series', [['20260101', 'A', '1'], ['20260102', 'A', '2']]);
  const second = input('second-series', [['20260103', 'A', '3'], ['20260104', 'A', '4']]);
  const correction = input('correction-series', [['20260102', 'A', '20']]);
  const versions = Object.fromEntries([first, second, correction].flatMap(item => (item.request.local.associations as WfdRecord[])
    .map(ref => [String(ref.record_id), String(ref.record_version)])));
  const context = { snapshotId: 'frozen-current-snapshot', productId: 'source_product', versions };
  const generated = buildSourceObservationMA(selection, [first, second, correction], context);
  assert.deepEqual(generated.proof.lineage.map(row => [row.date, row.value]), [
    ['2026-01-01', null], ['2026-01-02', '10.50000000'], ['2026-01-03', '11.50000000'], ['2026-01-04', '3.50000000']]);
  assert.equal(generated.proof.lineage[1]!.sourceIndex, 2);
  assert.equal(generated.proof.continuation!.omittedRevisions, 1);
  assert.equal(generated.proof.inputScope, 'frozen_series_snapshot');
  assert.equal(generated.proof.methodVersion, '2.0.0');
  assert.deepEqual(buildSourceObservationMA(selection, [correction, second, first], context).bytes, generated.bytes);
  const full = input('full-independent', [['20260101', 'A', '1'], ['20260102', 'A', '20'], ['20260103', 'A', '3'], ['20260104', 'A', '4']]);
  assert.deepEqual(buildSourceObservationMA(selection, [full]).proof.lineage.map(row => [row.date, row.value]),
    generated.proof.lineage.map(row => [row.date, row.value]));
  assert.throws(() => buildSourceObservationMA(selection, [first, second], context), { code: 'R1_MA_CONTEXT_REVISION_MISSING' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { readWfdMASource, readWfdSourceMACalculation, checkWfdMACandidate,
  WFD_SOURCE_MA_VERSION } from './wfd-source-ma.js';
import { checkUnifiedStructuredForWfd } from './unified-polars-derived.js';
import type { UnifiedPolarsResult } from './unified-polars-execution.js';
import type { FinancialReader } from '../collection/data-processing/financial-fixed.js';

const digest = (x: unknown) => wfdSha256(canonicalWfdJson(x));
const calculation = { version: WFD_SOURCE_MA_VERSION, snapshotId: 'snap-fixed', productId: 'daily-one', valueField: 'close' };
const subject = { kind: 'entity', namespace: 'test.market', id: 'one' };
const rows: WfdRecord[] = Array.from({ length: 21 }, (_, i) => {
  const start = new Date(Date.UTC(2026, 0, i + 1)), end = new Date(start.getTime() + 86400000);
  return {
    record_ref: { logical_key: 'daily-' + String(i + 1), revision_id: 'revision-' + i,
      product_id: 'daily-one', snapshot_id: 'snap-fixed' },
    subject, business_time: { status: 'known', precision: 'day',
      earliest_utc: start.toISOString().replace('.000Z', 'Z'),
      latest_exclusive_utc: end.toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' },
    values: { close: { data_type: 'decimal', value: String(i + 1),
      value_state: 'valid_value', unit: { unit_code: 'count' } } },
  };
});
const failCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
function reader(values = rows, connection = { instanceId: 'fixture' }): FinancialReader {
  return async (value) => {
    assert.equal(value.snapshotId, calculation.snapshotId);
    assert.equal(value.productId, calculation.productId);
    const second = value.cursor === 'second';
    assert.ok(!value.cursor || second);
    return { connection, result: {
      snapshot_id: calculation.snapshotId, product_id: calculation.productId,
      history_mode: 'snapshot_contents',
      rows: second ? values.slice(15) : values.slice(0, 15),
      page: { has_more: !second, next_cursor: second ? null : 'second' },
    } as WfdRecord };
  };
}
const signal = () => new AbortController().signal;

test('WFD-only MA20 scans every page and preserves all warmup rows plus independent exact values', async () => {
  assert.deepEqual(readWfdSourceMACalculation(calculation), calculation);
  const source = await readWfdMASource(calculation, reader(), signal());
  assert.equal(source.rows.length, 21);
  assert.equal(source.rows[0]?.value, null);
  assert.equal(source.rows[0]?.calculation_status, 'warmup');
  assert.equal(source.rows[19]?.value, '10.50000000');
  assert.equal(source.rows[20]?.value, '11.50000000');
  assert.equal(source.rows[20]?.unit, 'count');
  assert.equal(source.input.length, 21);
  assert.equal(source.historicalQualification, 'not_asserted');
  checkWfdMACandidate(source, source.rows);
  assert.throws(() => checkWfdMACandidate(source, source.rows.map((item, i) =>
    i === 20 ? { ...item, value: '12.00000000' } : item)), failCode('WFD_MA_RESULT_MISMATCH'));
});

test('WFD MA20 refuses arbitrary source rows, latest snapshots, duplicate revisions and changed account', async () => {
  assert.throws(() => readWfdSourceMACalculation({ ...calculation, snapshotId: 'latest' }),
    failCode('WFD_MA_CONTRACT'));
  assert.throws(() => readWfdSourceMACalculation({ ...calculation, rows }),
    failCode('WFD_MA_CONTRACT'));
  const duplicate = structuredClone(rows);
  (duplicate[20]!.record_ref as WfdRecord).logical_key = 'daily-1';
  await assert.rejects(readWfdMASource(calculation, reader(duplicate), signal()),
    failCode('WFD_MA_ROW_IDENTITY'));
  const changed = async (value: any) => {
    const result = await reader()(value);
    return { ...result, connection: value.cursor ? { instanceId: 'different-account' } : { instanceId: 'fixture' } };
  };
  await assert.rejects(readWfdMASource(calculation, changed as FinancialReader, signal()),
    failCode('WFD_MA_CONNECTION_CHANGED'));
});

test('WFD-only MA20 maps every window into one signed R1 scalar output with explicit unknown states', async () => {
  const source = await readWfdMASource(calculation, reader(), signal());
  const evidence: WfdRecord = {
    version: WFD_SOURCE_MA_VERSION, fixedCalculation: calculation,
    frozenInput: source.input, sourceRowsSha256: source.sourceRowsSha256,
    recordVersionsSha256: source.recordVersionsSha256,
    subject: source.subject, unitCode: source.unitCode, timeZone: source.timeZone,
    connection: source.connection, historicalQualification: 'not_asserted',
    algorithmDefinition: source.algorithmDefinition,
    workerSha256: 'a'.repeat(64),
  };
  const result = {
    version: 'bd.algorithms.polars/1', taskId: 'ma20_task_one',
    methodId: 'source_observation_ma', methodVersion: WFD_SOURCE_MA_VERSION,
    implementationVersion: 'a'.repeat(64), calculation,
    inputDigest: 'b'.repeat(64), source: { kind: 'fixed_snapshot' },
    candidateSha256: digest(source.rows), rows: source.rows,
    algorithmDefinition: source.algorithmDefinition, evidence,
    computedAt: '2026-02-01T00:00:00.000Z', publication: 'candidate_only',
  } as UnifiedPolarsResult;
  const published = checkUnifiedStructuredForWfd(result, {
    namespace: 'fixture.bd', mode: 'user_test', expectedParentSnapshotId: null,
  }, 'bd-derived:test-ma20');
  assert.equal(published.structured.payload.kind, 'scalar_rows');
  const outputs = published.structured.payload.rows as WfdRecord[];
  assert.equal(outputs.length, 21);
  assert.equal(outputs[0]?.value_decimal, null);
  assert.equal(outputs[0]?.value_state, 'insufficient_warmup');
  assert.equal(outputs[19]?.value_decimal, '10.50000000');
  assert.equal(outputs[19]?.value_state, 'valid_value');
  assert.equal(published.structured.definition.unit_code, 'count');
  const changed = structuredClone(result);
  changed.rows[20]!.value = '999.00000000';
  changed.candidateSha256 = digest(changed.rows);
  assert.throws(() => checkUnifiedStructuredForWfd(changed, {
    namespace: 'fixture.bd', mode: 'user_test', expectedParentSnapshotId: null,
  }, 'bd-derived:test-ma20'), failCode('WFD_MA_DERIVED'));
});

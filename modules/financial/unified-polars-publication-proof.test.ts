import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { projectFinancialFixed, type FinancialCalculation, type FinancialReader } from '../collection/data-processing/financial-fixed.js';
import { macroYoYAlgorithmDefinition, polarsFixedVersionBinding,
  POLARS_DEPENDENCY_VERSION, POLARS_FIXED_VERSION, type MacroYoYCalculation } from '../collection/data-processing/polars-fixed.js';
import { verifyUnifiedPolarsForPublication } from './unified-polars-publication-proof.js';

const signal = () => new AbortController().signal;
const decimalUnit = { unit_code: 'cny', definition: { dimension: 'money' },
  digest: 'sha256:' + wfdSha256(canonicalWfdJson({ code: 'cny', definition: { dimension: 'money' } })), resolved: true };
const fixedFinancialRow = (key: string, amount: string, end_date: string, snapshot: string, revision = 'r1') => {
  const original = { subject_scheme: 'SSE', subject_code: '600592', accounting_standard: 'CAS', currency: 'CNY',
    scope: 'consolidated', unit: 'cny', concept: 'net_profit_total', report_id: key, report_version: 'v1',
    dimension: 'current', period_type: 'duration', start_date: '2024-01-01', end_date, value: amount };
  return { record_ref: { logical_key: key, product_id: 'financial', snapshot_id: snapshot,
    revision_id: revision }, values: Object.fromEntries(Object.entries(original).map(([field, value]) =>
      [field, { value, value_state: 'valid_value', data_type: field === 'value' ? 'decimal' : 'text',
        unit: field === 'value' ? decimalUnit : { unit_code: 'text' } }])) };
};
async function financialCase() {
  const a = fixedFinancialRow('q2', '12.345', '2024-06-30', 'snapshot-Q2');
  const b = fixedFinancialRow('q1', '2.345', '2024-03-31', 'snapshot-Q1');
  const source = [a,b] as WfdRecord[];
  const calculation: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'quarter_difference',
    inputs: source.map(row => ({ snapshotId: String((row.record_ref as WfdRecord).snapshot_id),
      productId: 'financial', businessKeys: [String((row.record_ref as WfdRecord).logical_key)] })) };
  const reader: FinancialReader = async selection => {
    const found = source.find(row => (row.record_ref as WfdRecord).snapshot_id === selection.snapshotId)!;
    return { connection: { instance: 'actual-WFD', namespace: 'test' }, result: {
      snapshot_id: selection.snapshotId, product_id: selection.productId, history_mode: 'snapshot_contents',
      rows: [found], page: { has_more: false, next_cursor: null },
    } };
  };
  const computed = await projectFinancialFixed(calculation, reader, signal(), () => { throw new Error('unexpected review'); });
  return { calculation, evidence: computed.evidence as WfdRecord,
    rows: JSON.parse(computed.jsonBytes.toString()) as WfdRecord[], reader, source };
}
function macroCase() {
  const calculation: MacroYoYCalculation = {
    version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents', knowledgeCutoff: '2026-02-15T00:00:00Z',
    inputs: [
      { snapshotId: 'snapshot-2026', productId: 'macro', businessKey: 'current', recordVersion: 'r2026' },
      { snapshotId: 'snapshot-2025', productId: 'macro', businessKey: 'previous', recordVersion: 'r2025' },
    ],
  };
  const current = { series_code: 'series', region: 'CN', unit: 'count', seasonal_adjustment: 'none',
    base_period: '2020', period_start: '2026-01-01', period_end: '2026-01-31',
    published_at: '2026-02-14T00:00:00Z', release_id: 'release-now', value: '120' };
  const previous = { ...current, period_start: '2025-01-01', period_end: '2025-01-31',
    published_at: '2025-02-14T00:00:00Z', release_id: 'release-prior', value: '100' };
  const all = [current, previous];
  const source = calculation.inputs.map((item, index) => ({
    record_ref: { logical_key: item.businessKey, product_id: item.productId,
      snapshot_id: item.snapshotId, revision_id: item.recordVersion },
    values: Object.fromEntries(Object.entries(all[index]!).map(([field, value]) =>
      [field, { value, value_state: 'valid_value' }])),
  })) as WfdRecord[];
  const inputs = calculation.inputs.map((item,index) => ({
    ...item, record: source[index]!.record_ref, selectedSha256: wfdSha256(canonicalWfdJson(source[index])),
    values: all[index]!,
  }));
  const request = { version: POLARS_FIXED_VERSION, method: 'macro_yoy', rows: [{ current: '120', previous: '100' }],
    parameters: { scale: 8, rounding: 'half_even', output_unit: 'percent' } };
  const evidence: WfdRecord = {
    version: POLARS_FIXED_VERSION, method: 'macro_yoy', inputs, connection: { instance: 'actual-WFD', namespace: 'test' },
    knowledgeCutoff: calculation.knowledgeCutoff, historicalQualification: 'not_asserted',
    releaseSelection: 'explicit business-key and record-version; never latest',
    algorithmDefinition: macroYoYAlgorithmDefinition(),
    workerSha256: polarsFixedVersionBinding().polarsWorker,
    execution: { version: POLARS_FIXED_VERSION, executor: 'polars',
      polars_version: POLARS_DEPENDENCY_VERSION, method: 'macro_yoy',
      input_sha256: wfdSha256(canonicalWfdJson(request)), rows: [{ value: '20.00000000', state: 'valid_value' }],
      resources: {}, publication: 'candidate_only' }, publication: 'candidate_only',
  };
  const rows: WfdRecord[] = [{ ...current,
    business_key: 'macro_yoy_' + wfdSha256(canonicalWfdJson(inputs)),
    value: '20.00000000', value_state: 'valid_value', calculation_status: 'valid_value',
    unit: 'percent', method: 'exact_yoy_percentage',
    start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-02-01T00:00:00Z',
  }];
  const reader: FinancialReader = async selection => ({
    connection: { instance: 'actual-WFD', namespace: 'test' }, result: {
      snapshot_id: selection.snapshotId, product_id: selection.productId,
      history_mode: 'snapshot_contents', rows: [source.find(row =>
        (row.record_ref as WfdRecord).snapshot_id === selection.snapshotId)!],
      page: { has_more: false, next_cursor: null },
    },
  });
  return { calculation, rows, evidence, source, reader };
}
test('financial quarter independent proof re-reads the exact original WFD rows before publication', async () => {
  const sample = await financialCase();
  const result = await verifyUnifiedPolarsForPublication({
    methodId: 'financial_linear', ...sample,
    verifyFinancialReview: () => { throw new Error('not expected'); },
  }, sample.reader, signal());
  assert.equal(result.methodId, 'financial_linear');
  assert.equal(result.historyQualification, 'not_asserted');
  assert.equal(result.fixedSourceRowsSha256.length, 2);
});
test('macro YoY proof re-reads both actual WFD releases and binds the original calculation receipt', async () => {
  const sample = macroCase();
  const result = await verifyUnifiedPolarsForPublication({ methodId: 'macro_yoy', ...sample }, sample.reader, signal());
  assert.equal(result.methodId, 'macro_yoy');
  assert.equal(result.fixedSourceRowsSha256.length, 2);
  assert.equal(result.historyQualification, 'not_asserted');
});
test('changed WFD values, revision, account and supplied outputs cannot pass publication verification', async () => {
  const sample = macroCase();
  const fail = async (changedReader: FinancialReader, evidence = sample.evidence, rows = sample.rows) =>
    assert.rejects(verifyUnifiedPolarsForPublication({
      methodId: 'macro_yoy', calculation: sample.calculation, evidence, rows,
    }, changedReader, signal()), /来源|连接|摘要|版本|候选|结果/u);
  await fail(async input => ({
    connection: { instance: 'actual-WFD', namespace: 'test' },
    result: { snapshot_id: input.snapshotId, product_id: input.productId,
      rows: [{ ...sample.source.find(row => (row.record_ref as WfdRecord).snapshot_id === input.snapshotId)!,
        values: { ...sample.source[0]!.values, value: { value: '999', value_state: 'valid_value' } } }],
      page: { has_more: false, next_cursor: null } },
  }));
  await fail(async input => ({
    connection: { instance: 'another-WFD-account' },
    result: { snapshot_id: input.snapshotId, product_id: input.productId,
      rows: [sample.source.find(row => (row.record_ref as WfdRecord).snapshot_id === input.snapshotId)!],
      page: { has_more: false, next_cursor: null } },
  }));
  const broken = structuredClone(sample.rows);
  broken[0]!.value = '20.00000001';
  await fail(sample.reader, sample.evidence, broken);
});
test('financial proof rejects changed selected row even when business key and revision are unchanged', async () => {
  const s = await financialCase();
  const badReader: FinancialReader = async input => {
    const page = await s.reader(input);
    const rows = structuredClone(page.result.rows as WfdRecord[]);
    ((rows[0]!.values as WfdRecord).value as WfdRecord).value = '999';
    return { ...page, result: { ...page.result, rows } };
  };
  await assert.rejects(verifyUnifiedPolarsForPublication({
    methodId: 'financial_linear', ...s,
    verifyFinancialReview: () => { throw new Error('not expected'); },
  }, badReader, signal()), /财务.*来源|原行/u);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFinancialFixed, type FinancialCalculation, type FinancialReader } from './financial-fixed.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';

function valueUnit(code = 'cny', definition: WfdRecord = { dimension: 'money' }) {
  return { unit_code: code, definition, digest: 'sha256:' + wfdSha256(canonicalWfdJson({ code, definition })), resolved: true };
}

function row(key: string, value: string, start: string, end: string, changes: WfdRecord = {}): WfdRecord {
  const values = { subject_scheme: 'SSE', subject_code: '600592', accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated',
    unit: 'cny', concept: 'net_profit_total', report_id: key, report_version: 'v1', dimension: 'current', period_type: 'duration',
    start_date: start, end_date: end, value, ...changes };
  return { record_ref: { logical_key: key, record_id: key, revision_id: 'r1' }, values: Object.fromEntries(Object.entries(values).map(([code, value]) => [code,
    { value, value_state: 'valid_value', data_type: code === 'value' ? 'decimal' : 'text', unit: code === 'value' ? valueUnit() : { unit_code: 'text' } }])) };
}
function calculation(operation: FinancialCalculation['operation'], rows: WfdRecord[]) {
  const input: FinancialCalculation = { version: 'bd-financial-fixed/1', operation,
    inputs: rows.map((row, i) => ({ snapshotId: 'snapshot-' + i, productId: 'product-' + i, businessKeys: [String((row.record_ref as WfdRecord).logical_key)] })) };
  const reader: FinancialReader = async ref => {
    const index = Number(ref.productId.split('-')[1]);
    return { connection: { connectionId: 'test-unit-reader' }, result: { snapshot_id: ref.snapshotId, product_id: ref.productId,
      rows: [rows[index]], page: { has_more: false, next_cursor: null } } };
  };
  return { input, reader };
}
const compute = async (operation: FinancialCalculation['operation'], rows: WfdRecord[]) => {
  const { input, reader } = calculation(operation, rows);
  return projectFinancialFixed(input, reader, new AbortController().signal, () => { throw new Error('unreviewed'); });
};
test('financial fixed exact decimal quarters and TTM retain actual fixed input versions', async () => {
  const half = row('h1', '63660855.54', '2024-01-01', '2024-06-30'), q1 = row('q1', '34313568.7', '2024-01-01', '2024-03-31');
  const result = await compute('quarter_difference', [half, q1]), values = JSON.parse(result.jsonBytes.toString());
  assert.equal(values[0].value, '29347286.84'); assert.equal(values[0].start_date, '2024-04-01');
  assert.equal(((result.evidence.inputs[0] as WfdRecord).recordVersions as unknown[]).length, 1);
  const ttm = await compute('ttm', [row('fy', '161118273.03', '2023-01-01', '2023-12-31', { dimension: 'comparison' }),
    row('nine', '160107315.65', '2024-01-01', '2024-09-30'), row('prior-nine', '159545853.68', '2023-01-01', '2023-09-30', { dimension: 'comparison' })]);
  assert.equal(JSON.parse(ttm.jsonBytes.toString())[0].value, '161679735');
  assert.equal(JSON.parse(ttm.jsonBytes.toString())[0].start_date, '2023-10-01');
});
test('financial period guards refuse stocks, EPS, scope/currency differences and non-adjacent/fiscal periods', async () => {
  const good = row('half', '10', '2024-01-01', '2024-06-30'), prior = row('q1', '3', '2024-01-01', '2024-03-31');
  for (const changes of [{ concept: 'total_assets', period_type: 'instant' }, { concept: 'eps_basic' }, { scope: 'parent' }, { currency: 'USD' },
    { start_date: '2024-02-01' }, { end_date: '2024-09-30' }]) {
    await assert.rejects(compute('quarter_difference', [row('half', '10', '2024-01-01', '2024-06-30', changes), prior]));
  }
  await assert.rejects(compute('ttm', [row('fy', '15', '2023-04-01', '2024-03-31'), good, prior]));
});
test('different report revisions require specific preserved net profit compatibility review', async () => {
  const first = row('half', '10', '2024-01-01', '2024-06-30'), second = row('q1', '3', '2024-01-01', '2024-03-31', { report_version: 'v0' });
  await assert.rejects(compute('quarter_difference', [first, second]), /相容依据/u);
  const { input, reader } = calculation('quarter_difference', [first, second]);
  input.compatibilityReview = { materialId: 'held-correction', originalSha256: '1'.repeat(64), quote: '真实已保管更正说明：本次更正不会对净利润产生影响。' };
  let verified = false;
  await projectFinancialFixed(input, reader, new AbortController().signal, () => { verified = true; });
  assert.equal(verified, true);
});
test('fixed input reads never accept missing keys or caller-supplied values', async () => {
  const { input, reader } = calculation('standardize', [row('r1', '10', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' })]);
  input.inputs[0]!.businessKeys = ['not-present'];
  await assert.rejects(projectFinancialFixed(input, reader, new AbortController().signal, () => {}), /缺所选业务键/u);
  await assert.rejects(projectFinancialFixed({ ...input, value: '100' } as unknown as FinancialCalculation, reader,
    new AbortController().signal, () => {}), /客户端数值/u);
});

test('financial periods require registered CAS/CNY whole-statement roles, without equating report columns and segments', async () => {
  for (const changes of [{ accounting_standard: 'IFRS', currency: 'USD', unit: 'usd' }, { accounting_standard: 'IFRS' },
    { currency: 'USD', unit: 'usd' }, { unit: 'cny_thousand' }]) {
    await assert.rejects(compute('quarter_difference', [row('half', '10', '2024-01-01', '2024-06-30', changes),
      row('q1', '3', '2024-01-01', '2024-03-31', changes)]), /CAS、人民币元/u);
  }
  for (const dimensions of [['segment-east', 'segment-west'], ['segment-east', 'segment-east'],
    ['before_correction', 'after_correction'], ['adjustment', 'current']]) {
    await assert.rejects(compute('quarter_difference', [row('half', '10', '2024-01-01', '2024-06-30', { dimension: dimensions[0] }),
      row('q1', '3', '2024-01-01', '2024-03-31', { dimension: dimensions[1] })]), /维度|dimension/u);
  }
  const missingDimension = row('half', '10', '2024-01-01', '2024-06-30');
  delete (missingDimension.values as WfdRecord).dimension;
  await assert.rejects(compute('quarter_difference', [missingDimension, row('q1', '3', '2024-01-01', '2024-03-31')]), /dimension/u);
  const all = await compute('quarter_difference', [row('half', '10', '2024-01-01', '2024-06-30', { dimension: 'all' }),
    row('q1', '3', '2024-01-01', '2024-03-31', { dimension: 'all' })]);
  assert.equal(JSON.parse(all.jsonBytes.toString())[0].value, '7');
  const standardized = await compute('standardize', [row('r1', '10', '2024-01-01', '2024-06-30',
    { concept: '其中：营业收入', dimension: 'segment-east' })]);
  assert.equal(JSON.parse(standardized.jsonBytes.toString())[0].dimension, 'segment-east');
});

test('financial arithmetic and mapped concepts require resolved numeric CNY cells with an exact base-money definition digest', async () => {
  const invalidCells = [
    { unit: valueUnit('count', { dimension: 'count' }) },
    { data_type: 'text' },
    { unit: { ...valueUnit(), resolved: false } },
    { unit: { ...valueUnit(), digest: 'sha256:' + '0'.repeat(64) } },
    { unit: valueUnit('cny', { dimension: 'currency' }) },
    { unit: valueUnit('cny', { dimension: 'money', multiplier: 1000 }) },
    { unit: { unit_code: 'cny', resolved: true } },
    { unit: null },
  ];
  for (const patch of invalidCells) {
    const first = row('half', '10', '2024-01-01', '2024-06-30');
    Object.assign((first.values as WfdRecord).value as WfdRecord, patch);
    await assert.rejects(compute('quarter_difference', [first, row('q1', '3', '2024-01-01', '2024-03-31')]), /数值单元/u);
    const mapped = row('mapped', '10', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' });
    Object.assign((mapped.values as WfdRecord).value as WfdRecord, patch);
    await assert.rejects(compute('standardize', [mapped]), /数值单元/u);
  }
  const integer = row('half', '10', '2024-01-01', '2024-06-30');
  ((integer.values as WfdRecord).value as WfdRecord).data_type = 'integer';
  assert.equal(JSON.parse((await compute('quarter_difference', [integer, row('q1', '3', '2024-01-01', '2024-03-31')])).jsonBytes.toString())[0].value, '7');
  const mapped = row('mapped', '0', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' });
  Object.assign((mapped.values as WfdRecord).value as WfdRecord, { data_type: 'integer', value_state: 'reported_zero' });
  const unmapped = row('unmapped', '5', '2024-01-01', '2024-06-30', { concept: '未登记科目' });
  ((unmapped.values as WfdRecord).value as WfdRecord).unit = valueUnit('count', { dimension: 'count' });
  const standardized = await compute('standardize', [mapped, unmapped]);
  assert.equal(JSON.parse(standardized.jsonBytes.toString())[0].value_state, 'reported_zero');
  assert.deepEqual(standardized.evidence.unmapped, [{ record: unmapped.record_ref, concept: '未登记科目' }]);
});

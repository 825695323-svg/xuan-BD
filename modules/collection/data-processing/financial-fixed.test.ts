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
function calculation(rows: WfdRecord[]) {
  const input: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'standardize',
    inputs: rows.map((row, i) => ({ snapshotId: 'snapshot-' + i, productId: 'product-' + i, businessKeys: [String((row.record_ref as WfdRecord).logical_key)] })) };
  const reader: FinancialReader = async ref => {
    const index = Number(ref.productId.split('-')[1]);
    return { connection: { connectionId: 'test-unit-reader' }, result: { snapshot_id: ref.snapshotId, product_id: ref.productId,
      rows: [rows[index]], page: { has_more: false, next_cursor: null } } };
  };
  return { input, reader };
}
const project = async (rows: WfdRecord[]) => {
  const { input, reader } = calculation(rows);
  return projectFinancialFixed(input, reader, new AbortController().signal);
};
test('fixed input reads never accept missing keys or caller-supplied values', async () => {
  const { input, reader } = calculation([row('r1', '10', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' })]);
  input.inputs[0]!.businessKeys = ['not-present'];
  await assert.rejects(projectFinancialFixed(input, reader, new AbortController().signal), /缺所选业务键/u);
  await assert.rejects(projectFinancialFixed({ ...input, value: '100' } as unknown as FinancialCalculation, reader,
    new AbortController().signal), /客户端数值/u);
});

test('financial mapping preserves original decimal values, dimensions and fixed source versions', async () => {
  const mapped = row('r1', '9007199254740993.1200', '2024-01-01', '2024-06-30',
    { concept: '其中：营业收入', dimension: 'segment-east' });
  const result = await project([mapped]);
  const [output] = JSON.parse(result.jsonBytes.toString());
  assert.equal(output.concept, 'revenue');
  assert.equal(output.original_concept, '其中：营业收入');
  assert.equal(output.value, '9007199254740993.1200');
  assert.equal(output.dimension, 'segment-east');
  assert.deepEqual(result.evidence.inputs[0]?.recordVersions, [mapped.record_ref]);
});

test('financial mapping requires resolved numeric CNY cells with an exact base-money definition digest', async () => {
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
    const mapped = row('mapped', '10', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' });
    Object.assign((mapped.values as WfdRecord).value as WfdRecord, patch);
    await assert.rejects(project([mapped]), /数值单元/u);
  }
  const mapped = row('mapped', '0', '2024-01-01', '2024-06-30', { concept: '其中：营业收入' });
  Object.assign((mapped.values as WfdRecord).value as WfdRecord, { data_type: 'integer', value_state: 'reported_zero' });
  const unmapped = row('unmapped', '5', '2024-01-01', '2024-06-30', { concept: '未登记科目' });
  ((unmapped.values as WfdRecord).value as WfdRecord).unit = valueUnit('count', { dimension: 'count' });
  const standardized = await project([mapped, unmapped]);
  assert.equal(JSON.parse(standardized.jsonBytes.toString())[0].value_state, 'reported_zero');
  assert.deepEqual(standardized.evidence.unmapped, [{ record: unmapped.record_ref, concept: '未登记科目' }]);
});

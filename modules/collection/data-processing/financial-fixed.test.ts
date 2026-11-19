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

const periods = [{ startDate: '2024-01-01', endDate: '2024-03-31' }, { startDate: '2024-01-01', endDate: '2024-06-30' }];
const compatibleRows = (): WfdRecord[] => periods.map((period, i) => ({ ...row('quarter-' + i, String(i + 1), period.startDate, period.endDate,
  { concept: '其中：营业收入', report_nature: 'formal', fiscal_calendar: 'declared-calendar-year', comparability_basis: 'same-reviewed-basis' }),
subject: { kind: 'entity', namespace: 'synthetic', id: 'company' } }));
async function compatible(rows: WfdRecord[], changes: Partial<FinancialCalculation> = {}) {
  const { input, reader } = calculation(rows);
  input.inputs.forEach(ref => { ref.snapshotId = 'fixed-catalog-snapshot'; });
  return projectFinancialFixed({ ...input, compatibleInputs: { periodType: 'duration', periods }, ...changes }, reader, new AbortController().signal);
}
test('explicit compatible financial inputs reject mixed scope, calendar, unit, identity and missing periods without calculation', async () => {
  const valid = await compatible(compatibleRows());
  assert.equal(valid.evidence.compatibility?.calculation, 'not_requested');
  assert.equal(valid.evidence.historicalQualification, 'not_asserted');
  for (const [key, changed] of Object.entries({ subject_code: 'other-company', scope: 'parent_only', dimension: 'segment-other', currency: 'USD',
    unit: 'cny_thousand', fiscal_calendar: 'noncalendar-fiscal-year', comparability_basis: 'different-correction-basis',
    accounting_standard: 'IFRS', report_nature: 'forecast', concept: '资产总计', period_type: 'instant', start_date: '2024-02-30' })) {
    const rows = compatibleRows();
    ((rows[1]!.values as WfdRecord)[key] as WfdRecord).value = changed;
    await assert.rejects(compatible(rows), key);
  }
  const changedSubject = compatibleRows(); (changedSubject[1]!.subject as WfdRecord).id = 'different-formal-entity';
  await assert.rejects(compatible(changedSubject), /主体/u);
  const missing = compatibleRows(); delete (missing[1]!.values as WfdRecord).fiscal_calendar;
  await assert.rejects(compatible(missing), /fiscal_calendar/u);
  const unknown = compatibleRows(); ((unknown[1]!.values as WfdRecord).comparability_basis as WfdRecord).value = 'unknown';
  await assert.rejects(compatible(unknown), /未知/u);
  for (const marker of [' unknown ', '\tUnresolved\n', '\u3000unspecified\u3000']) {
    const padded = compatibleRows();
    for (const item of padded) ((item.values as WfdRecord).comparability_basis as WfdRecord).value = marker;
    await assert.rejects(compatible(padded), /未知/u);
  }
  await assert.rejects(compatible(compatibleRows().slice(0, 1)), /期间缺失/u);
  await assert.rejects(compatible(compatibleRows(), { compatibleInputs: { periodType: 'duration', periods: [periods[0]!, periods[0]!] } }), /不能重复/u);
  const { input, reader } = calculation(compatibleRows());
  await assert.rejects(projectFinancialFixed({ ...input, compatibleInputs: { periodType: 'duration', periods } }, reader,
    new AbortController().signal), /同一目录快照/u);
});

test('ordinary standardization validates source period dates and nature without enabling calculations', async () => {
  for (const changes of [
    { start_date: '2024-02-30' }, { end_date: '2024-02-30' }, { end_date: '1900-02-29' },
    { start_date: '2024-07-01', end_date: '2024-06-30' },
    { period_type: 'unknown' }, { period_type: 'instant' },
    { concept: '资产总计', period_type: 'duration' },
    { concept: '资产总计', period_type: 'instant', end_date: '2024-06-30' },
    { end_date: '9999-12-31' },
  ]) {
    await assert.rejects(project([row('invalid-period', '10', '2024-01-01', '2024-06-30',
      { concept: '其中：营业收入', ...changes })]), /期间/u);
  }
  const century = await project([row('century-leap', '10', '2000-02-29', '2000-02-29', { concept: '其中：营业收入' })]);
  assert.equal(JSON.parse(century.jsonBytes.toString())[0].end_utc, '2000-03-01T00:00:00Z');
  for (const [concept, period_type] of [['其中：营业收入', 'duration'], ['资产总计', 'instant']]) {
    const result = await project([row('leap-day', '10.0000', '2024-02-29', '2024-02-29', { concept, period_type })]);
    const [output] = JSON.parse(result.jsonBytes.toString());
    assert.equal(output.start_utc, '2024-02-29T00:00:00Z');
    assert.equal(output.end_utc, '2024-03-01T00:00:00Z');
    assert.equal(output.value, '10.0000');
    assert.equal(result.evidence.compatibility, null);
  }
});

test('compatible inputs require explicit report identities and versions but allow distinct known editions', async () => {
  for (const key of ['report_id', 'report_version']) {
    for (const marker of ['unknown', ' unresolved ', '\tUnspecified\n']) {
      const rows = compatibleRows();
      ((rows[1]!.values as WfdRecord)[key] as WfdRecord).value = marker;
      await assert.rejects(compatible(rows), /未知/u, key + ': ' + JSON.stringify(marker));
    }
  }
  const rows = compatibleRows();
  ((rows[1]!.values as WfdRecord).report_version as WfdRecord).value = 'v2';
  ((rows[1]!.values as WfdRecord).report_nature as WfdRecord).value = 'correction';
  const result = await compatible(rows);
  assert.equal(result.evidence.compatibility?.status, 'declared_basis_compatible');
  assert.equal(result.evidence.compatibility?.calculation, 'not_requested');
  assert.deepEqual(JSON.parse(result.jsonBytes.toString()).map((item: WfdRecord) => item.report_version), ['v1', 'v2']);
});

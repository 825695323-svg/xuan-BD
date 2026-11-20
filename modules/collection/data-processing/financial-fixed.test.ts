import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFinancialFixed, verifyFinancialStatementArticulation, type FinancialCalculation, type FinancialReader } from './financial-fixed.js';
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

test('legacy not_reported nulls remain compatible while unit conflicts, cross-company articulation and unlabelled restatements are rejected', async () => {
  // 1. Legacy v1 & v2 preserve legitimate not_reported null values
  const missingRow = row('missing-val', '1', '2025-01-01', '2025-03-31', { concept: '其中：营业收入' });
  Object.assign((missingRow.values as WfdRecord).value as WfdRecord, { value: null, value_state: 'not_reported' });
  const legacyRes = await project([missingRow]);
  const [legacyOut] = JSON.parse(legacyRes.jsonBytes.toString());
  assert.equal(legacyOut.value_state, 'not_reported');
  assert.equal(legacyOut.value, null);

  // 2. Row unit vs numeric cell unit mismatch must be rejected under allowUnitScale
  const conflictRow = row('unit-conflict', '12', '2025-01-01', '2025-03-31', { concept: '营业收入', unit: 'cny_million' });
  Object.assign((conflictRow.values as WfdRecord).value as WfdRecord, {
    unit: valueUnit('cny_thousand', { dimension: 'money', scale_factor: '1000', currency: 'CNY' }),
  });
  const { input: cIn, reader: cRd } = calculation([conflictRow]);
  await assert.rejects(
    projectFinancialFixed({ ...cIn, mappingProfile: 'cas-primary-statements/2', allowUnitScale: true }, cRd, new AbortController().signal),
    /冲突/u,
  );

  // 3. Default v2 EPS rejects money unit cny and accepts money_per_share unit cny_per_share
  const epsWrong = row('eps-wrong', '1.25', '2025-01-01', '2025-03-31', { concept: '基本每股收益', unit: 'cny' });
  const { input: ewIn, reader: ewRd } = calculation([epsWrong]);
  await assert.rejects(
    projectFinancialFixed({ ...ewIn, mappingProfile: 'cas-primary-statements/2' }, ewRd, new AbortController().signal),
    /量纲|单位/u,
  );
  const epsRight = row('eps-right', '1.25', '2025-01-01', '2025-03-31', { concept: '基本每股收益', unit: 'cny_per_share' });
  Object.assign((epsRight.values as WfdRecord).value as WfdRecord, { unit: valueUnit('cny_per_share', { dimension: 'money_per_share' }) });
  const { input: erIn, reader: erRd } = calculation([epsRight]);
  const epsOk = await projectFinancialFixed({ ...erIn, mappingProfile: 'cas-primary-statements/2' }, erRd, new AbortController().signal);
  assert.equal(JSON.parse(epsOk.jsonBytes.toString())[0].unit, 'cny_per_share');

  // 4. Cross-company BS-01 (A assets 100, B liabilities 30, C equity 70) must NEVER balance as exact_match
  const mixed = [
    { ...row('a', '100', '2025-12-31', '2025-12-31', { concept: '资产总计', period_type: 'instant', subject_code: 'A' }), subject: { kind: 'entity', namespace: 'sse', id: 'A' } },
    { ...row('b', '30', '2025-12-31', '2025-12-31', { concept: '负债合计', period_type: 'instant', subject_code: 'B' }), subject: { kind: 'entity', namespace: 'sse', id: 'B' } },
    { ...row('c', '70', '2025-12-31', '2025-12-31', { concept: '所有者权益（或股东权益）合计', period_type: 'instant', subject_code: 'C' }), subject: { kind: 'entity', namespace: 'sse', id: 'C' } },
  ];
  const { input: mIn, reader: mRd } = calculation(mixed);
  const mixedRes = await projectFinancialFixed({ ...mIn, mappingProfile: 'cas-primary-statements/2', articulationCheck: true }, mRd, new AbortController().signal);
  const bs01Results = mixedRes.evidence.articulation?.filter(item => item.ruleId === 'BS-01') ?? [];
  assert.ok(bs01Results.length === 3 && bs01Results.every(item => item.status === 'indeterminate'));

  // Duplicate concept in same subject/period must report duplicateConcepts and indeterminate
  const dup = [
    row('a1', '100', '2025-12-31', '2025-12-31', { concept: '资产总计', period_type: 'instant' }),
    row('a2', '100', '2025-12-31', '2025-12-31', { concept: '资产总计', period_type: 'instant' }),
    row('l1', '30', '2025-12-31', '2025-12-31', { concept: '负债合计', period_type: 'instant' }),
    row('e1', '70', '2025-12-31', '2025-12-31', { concept: '所有者权益（或股东权益）合计', period_type: 'instant' }),
  ];
  const duplicateReportAxes = { report_id: 'annual-2025', report_nature: 'formal', fiscal_calendar: 'calendar-year',
    comparability_basis: 'same-annual-report', column_role: 'current_period' };
  for (const item of dup) {
    item.subject = { kind: 'entity', namespace: 'sse', id: '600592' };
    Object.assign(item.values as WfdRecord,
      Object.fromEntries(Object.entries(duplicateReportAxes).map(([key, value]) => [key, { value, value_state: 'valid_value' }])));
  }
  const { input: dIn, reader: dRd } = calculation(dup);
  const dupRes = await projectFinancialFixed({ ...dIn, mappingProfile: 'cas-primary-statements/2', articulationCheck: true }, dRd, new AbortController().signal);
  const dupBs01 = dupRes.evidence.articulation?.find(item => item.ruleId === 'BS-01');
  assert.equal(dupBs01?.status, 'indeterminate');
  assert.deepEqual(dupBs01?.duplicateConcepts, ['total_assets']);

  for (const state of ['not_reported', 'unknown']) {
    Object.assign((dup[1]!.values as WfdRecord).value as WfdRecord, { value: null, value_state: state });
    const { input, reader } = calculation(dup);
    const result = await projectFinancialFixed({ ...input, mappingProfile: 'cas-primary-statements/2', articulationCheck: true }, reader, new AbortController().signal);
    const balance = result.evidence.articulation?.find(item => item.ruleId === 'BS-01');
    assert.equal(balance?.status, 'indeterminate', state);
    assert.deepEqual(balance?.duplicateConcepts, ['total_assets']);
    assert.equal(balance?.residual, null);
  }

  // 5. restatement_carrier without explicit column_role must be rejected
  const carrierRows = compatibleRows();
  ((carrierRows[0]!.values as WfdRecord).column_role = { value: 'current_period', value_state: 'valid_value', data_type: 'text', unit: { unit_code: 'text' } });
  ((carrierRows[1]!.values as WfdRecord).report_nature as WfdRecord).value = 'restatement_carrier';
  await assert.rejects(
    compatible(carrierRows, { mappingProfile: 'cas-primary-statements/2' }),
    /列角色|column_role/u,
  );
});


test('financial articulation only compares known axes in the same actual report', async () => {
  const rows: WfdRecord[] = ['资产总计', '负债合计', '所有者权益（或股东权益）合计'].map((concept, index) => ({
    ...row('line-' + index, ['100', '30', '70'][index]!, '2025-12-31', '2025-12-31', {
      concept, period_type: 'instant', report_id: 'annual-2025', report_nature: 'formal',
      fiscal_calendar: 'calendar-year', comparability_basis: 'same-annual-report', column_role: 'current_period',
    }),
    subject: { kind: 'entity', namespace: 'sse', id: '600592' },
  }));
  const checked = async (items: WfdRecord[]) => {
    const { input, reader } = calculation(items);
    const result = await projectFinancialFixed({ ...input, mappingProfile: 'cas-primary-statements/2',
      articulationCheck: true }, reader, new AbortController().signal);
    assert.equal(result.evidence.outputRows, 3);
    return result.evidence.articulation!.filter(item => item.ruleId === 'BS-01');
  };
  assert.deepEqual((await checked(rows)).map(item => item.status), ['exact_match']);
  for (const axis of ['report_id', 'fiscal_calendar', 'report_nature', 'column_role', 'comparability_basis']) {
    const unresolved = structuredClone(rows);
    Object.assign((unresolved[2]!.values as WfdRecord)[axis] as WfdRecord, { value: null, value_state: 'not_reported' });
    const result = await checked(unresolved);
    assert.ok(result.every(item => item.status === 'indeterminate'), axis);
    assert.ok(result.some(item => item.reason === 'report_basis_unresolved'), axis);
  }
  for (const placeholder of ['not_asserted', '未知', '未明确']) {
    const unresolved = structuredClone(rows);
    for (const item of unresolved) {
      ((item.values as WfdRecord).comparability_basis as WfdRecord).value = placeholder;
    }
    const [result] = await checked(unresolved);
    assert.equal(result?.status, 'indeterminate', placeholder);
    assert.equal(result?.reason, 'report_basis_unresolved', placeholder);
  }
  const distinctReports = structuredClone(rows);
  ((distinctReports[2]!.values as WfdRecord).report_id as WfdRecord).value = 'other-report-with-same-v1';
  assert.deepEqual((await checked(distinctReports)).map(item => item.status), ['indeterminate', 'indeterminate']);
});

test('cash-flow reconciliation never replaces missing FX or invents the balance-period bridge', () => {
  const term = (concept: string, scaledValue: string | null) => ({
    concept, scaledValue, declaredPrecisionHalfUlp: scaledValue === null ? null : '0',
  });
  const flows = [term('net_cash_operating', '5'), term('net_cash_investing', '-2'),
    term('net_cash_financing', '1'), term('net_cash_increase', '4')];
  for (const input of [flows, [...flows, term('fx_effect_on_cash', null)]]) {
    const cf01 = verifyFinancialStatementArticulation(input).find(item => item.ruleId === 'CF-01')!;
    assert.equal(cf01.status, 'indeterminate');
    assert.deepEqual(cf01.missingConcepts, ['fx_effect_on_cash']);
    assert.equal(cf01.residual, null);
  }
  const results = verifyFinancialStatementArticulation([...flows, term('fx_effect_on_cash', '0'),
    term('cash_and_equivalents_begin', '10'), term('cash_and_equivalents_end', '14')]);
  assert.equal(results.find(item => item.ruleId === 'CF-01')!.status, 'exact_match');
  const cf02 = results.find(item => item.ruleId === 'CF-02')!;
  assert.equal(cf02.status, 'indeterminate');
  assert.equal(cf02.reason, 'period_alignment_unverified');
  assert.equal(cf02.residual, null);
});

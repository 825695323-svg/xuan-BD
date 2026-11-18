import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { isExplicitUtcInstant } from '../../../contracts/financial-value.js';
import { readFixedHistorySelection, selectWfdFixedRecords, type WfdFixedRecordReader, type WfdFixedHistorySelection } from './wfd-fixed-selection.js';

export const FINANCIAL_FIXED_VERSION = 'bd-financial-fixed/1';
export const FINANCIAL_MAPPING_VERSION = 'cas-primary-statements/1';
export interface FinancialCalculation {
  version: typeof FINANCIAL_FIXED_VERSION;
  operation: 'standardize';
  inputs: { snapshotId: string; productId: string; businessKeys: string[] }[];
  history?: WfdFixedHistorySelection;
  compatibleInputs?: { periodType: 'duration' | 'instant'; periods: { startDate: string; endDate: string }[] };
}
export type FinancialReader = WfdFixedRecordReader;
function fail(message: string): never { throw new TaskError('FINANCIAL_FIXED', message); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) && !/^(latest|current)$/iu.test(value);
const codes: Record<string, { code: string; additive: boolean }> = {
  '其中：营业收入': { code: 'revenue', additive: true },
  '其中：营业成本': { code: 'cost_of_sales', additive: true },
  '五、净利润（净亏损以“－”号填列）': { code: 'net_profit_total', additive: true },
  '五、净利润（净亏损以“-”号填列）': { code: 'net_profit_total', additive: true },
  '资产总计': { code: 'total_assets', additive: false },
  '负债合计': { code: 'total_liabilities', additive: false },
  '所有者权益（或股东权益）合计': { code: 'total_equity', additive: false },
  '经营活动产生的现金流量净额': { code: 'net_cash_operating', additive: true },
  '投资活动产生的现金流量净额': { code: 'net_cash_investing', additive: true },
  '筹资活动产生的现金流量净额': { code: 'net_cash_financing', additive: true },
  '五、现金及现金等价物净增加额': { code: 'net_cash_increase', additive: true },
  '六、期末现金及现金等价物余额': { code: 'cash_and_equivalents_end', additive: false },
};
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && isExplicitUtcInstant(value + 'T00:00:00Z');
export function readFinancialCalculation(raw: unknown): FinancialCalculation {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['version', 'operation', 'inputs', 'history', 'compatibleInputs'].includes(key))
    || raw.version !== FINANCIAL_FIXED_VERSION || raw.operation !== 'standardize'
    || !Array.isArray(raw.inputs) || !raw.inputs.length || raw.inputs.length > 16) fail('财务固定变换需要明确已登记版本、操作和固定输入引用，不能提交客户端数值。');
  for (const input of raw.inputs as unknown[]) {
    if (!isWfdRecord(input) || Object.keys(input).sort().join(',') !== 'businessKeys,productId,snapshotId'
      || !id(input.snapshotId) || !id(input.productId) || !Array.isArray(input.businessKeys) || !input.businessKeys.length
      || input.businessKeys.length > 1000 || !input.businessKeys.every(id) || new Set(input.businessKeys).size !== input.businessKeys.length) fail('固定输入须逐项指定真实快照、产品及准确业务键；不读取最新值或目录通配。');
  }
  if (raw.history !== undefined) readFixedHistorySelection(raw.history);
  if (raw.compatibleInputs !== undefined) {
    const spec = raw.compatibleInputs;
    if (!isWfdRecord(spec) || Object.keys(spec).sort().join(',') !== 'periodType,periods'
      || !['duration', 'instant'].includes(String(spec.periodType)) || !Array.isArray(spec.periods)
      || !spec.periods.length || spec.periods.length > 8) fail('相容财报输入须明确期间性质和最多八个所需期间，不隐式生成单季或TTM。');
    const seen = new Set<string>();
    for (const period of spec.periods) {
      if (!isWfdRecord(period) || Object.keys(period).sort().join(',') !== 'endDate,startDate'
        || !validDate(period.startDate) || !validDate(period.endDate) || period.startDate > period.endDate
        || spec.periodType === 'instant' && period.startDate !== period.endDate) fail('所需财报期间必须是实际有效日期及对应的时点/区间，不猜财年。');
      const key = period.startDate + '/' + period.endDate;
      if (seen.has(key)) fail('相容输入的所需期间不能重复。');
      seen.add(key);
    }
  }
  return structuredClone(raw) as unknown as FinancialCalculation;
}
const field = (row: WfdRecord, key: string): string => {
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values[key]) ? row.values[key] as WfdRecord : null;
  if (!cell || !['valid_value', 'reported_zero'].includes(String(cell.value_state)) || typeof cell.value !== 'string' || !cell.value.trim()) return fail(`固定输入缺明确 ${key}；不按同名或最新值补齐。`);
  return cell.value;
};
function assertFinancialValueUnit(row: WfdRecord): void {
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values.value) ? row.values.value : null;
  const unit = cell && isWfdRecord(cell.unit) ? cell.unit : null;
  if (!cell || (cell.data_type !== 'decimal' && cell.data_type !== 'integer') || !unit || unit.unit_code !== 'cny' || unit.resolved !== true
    || !isWfdRecord(unit.definition) || Object.keys(unit.definition).length !== 1 || unit.definition.dimension !== 'money'
    || unit.digest !== 'sha256:' + wfdSha256(canonicalWfdJson({ code: unit.unit_code, definition: unit.definition }))) {
    fail('财务数值单元须为十进制或整数，并具有已解析的人民币元基本金额单位及相符定义摘要；未知尺度或其他单位不能按行内标签参与变换。');
  }
}
const nextDay = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
export async function projectFinancialFixed(raw: FinancialCalculation, reader: FinancialReader, signal: AbortSignal) {
  const calculation = readFinancialCalculation(raw);
  const fixed = await selectWfdFixedRecords(calculation.inputs.map(item => ({
    snapshotId: item.snapshotId, productId: item.productId, businessKeys: item.businessKeys,
  })), reader, signal, reason => fail(reason), calculation.history);
  const inputs = fixed.selections.map((selection, index) => ({
    ref: calculation.inputs[index]!, rows: selection.rows,
  }));
  const inputEvidence: WfdRecord[] = fixed.selections.map((selection, index) => ({
    ...calculation.inputs[index]!, selectedRows: selection.rows.length,
    selectedRowsSha256: selection.selectedRowsSha256, recordVersions: selection.recordVersions,
  }));
  let compatibility: WfdRecord | null = null;
  if (calculation.compatibleInputs) {
    const spec = calculation.compatibleInputs;
    if (new Set(calculation.inputs.map(input => input.snapshotId)).size !== 1) fail('相容财报输入必须固定同一目录快照，不能分别取各产品不同发布集合。');
    const selected = inputs.flatMap(input => input.rows);
    const expected = new Set(spec.periods.map(period => period.startDate + '/' + period.endDate));
    const seen = new Set<string>();
    let basis: string | undefined;
    for (const row of selected) {
      const original = field(row, 'concept'), mapping = codes[original];
      if (!mapping) fail('相容输入含未登记科目，不能丢弃该行后冒充完整期间集合。');
      if ((spec.periodType === 'duration') !== mapping.additive || field(row, 'period_type') !== spec.periodType)
        fail('财报流量与时点余额不相容；余额不能作为累计流量差分输入。');
      if (!['formal', 'correction'].includes(field(row, 'report_nature'))) fail('相容输入只接受明确正式报告或更正，不能把预告/快报混入。');
      const start = field(row, 'start_date'), end = field(row, 'end_date');
      const period = start + '/' + end;
      if (!validDate(start) || !validDate(end) || !expected.has(period) || seen.has(period)) fail('财报期间不符、重复或存在混合版本；不任取最新报告。');
      seen.add(period);
      const identity = Object.fromEntries(['subject_scheme', 'subject_code', 'accounting_standard', 'scope',
        'dimension', 'currency', 'unit', 'fiscal_calendar', 'comparability_basis'].map(key => [key, field(row, key)]));
      const formalSubject = row.subject;
      if (!isWfdRecord(formalSubject) || !['kind', 'namespace', 'id'].every(key => typeof formalSubject[key] === 'string' && formalSubject[key])
        || Object.values(identity).some(value => /^(unknown|unresolved|unspecified)$/iu.test(value.trim()))) fail('相容输入缺少正式主体或明确财年/范围等依据，未知标签不能当相同口径。');
      const key = canonicalWfdJson({ subject: row.subject, ...identity, concept: mapping.code, periodType: spec.periodType });
      if (basis !== undefined && basis !== key) fail('主体、科目、准则、范围、维度、币种、单位、财年或修订相容依据不一致。');
      basis = key;
      field(row, 'report_id'); field(row, 'report_version');
      assertFinancialValueUnit(row);
    }
    if (seen.size !== expected.size) fail('所需财报期间缺失；不补零、不改读最新数据。');
    compatibility = { status: 'declared_basis_compatible', periodType: spec.periodType,
      periods: spec.periods, basis: JSON.parse(basis!), calculation: 'not_requested',
      assurance: 'fixed_record_declarations_checked_not_independent_report_verification' };
  }
  const connection = fixed.connection;
  const lineage: WfdRecord[] = [], unmapped: WfdRecord[] = [];
  const rows = inputs.flatMap(input => input.rows.flatMap(row => {
    const original = field(row, 'concept'), mapping = codes[original];
    if (!mapping) { unmapped.push({ record: row.record_ref, concept: original }); return []; }
    if (field(row, 'accounting_standard') !== 'CAS' || field(row, 'currency') !== 'CNY' || field(row, 'unit') !== 'cny') fail('当前映射只对明确CAS、人民币元原值开放；其他币种、单位或准则须另有映射。');
    assertFinancialValueUnit(row);
    const startDate = field(row, 'start_date'), endDate = field(row, 'end_date'), periodType = field(row, 'period_type');
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate
      || !['duration', 'instant'].includes(periodType) || (periodType === 'duration') !== mapping.additive
      || periodType === 'instant' && startDate !== endDate) {
      fail('财务固定映射期间须为实际有效日期、正确次序及相符时点/区间性质；不归一化不存在的日期或猜测期间。');
    }
    const endExclusive = nextDay(endDate);
    if (!validDate(endExclusive)) fail('财务固定映射期间超出可表达的半开日期边界。');
    const values = Object.fromEntries(Object.entries(row.values as WfdRecord).map(([key, cell]) => [key, (cell as WfdRecord).value]));
    const identity = { snapshot: input.ref.snapshotId, product: input.ref.productId, record: row.record_ref, mapping: FINANCIAL_MAPPING_VERSION };
    const key = 'standardized_' + wfdSha256(canonicalWfdJson(identity));
    const result = { ...values, concept: mapping.code, original_concept: original, value_state: (row.values as any).value.value_state,
      business_key: key, start_utc: startDate + 'T00:00:00Z', end_utc: endExclusive + 'T00:00:00Z' };
    lineage.push({ businessKey: key, source: identity, additive: mapping.additive, unitFactor: '1' });
    return [result];
  }));
  if (!rows.length || rows.length > 1000) fail('本次固定映射没有合格输出或超过1000条输出预算；未补值或静默截断。');
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { version: FINANCIAL_FIXED_VERSION, mappingVersion: FINANCIAL_MAPPING_VERSION,
    operation: calculation.operation, connection, inputs: inputEvidence, outputRows: rows.length, unmapped, lineage,
    historicalQualification: fixed.historyQualification,
    ...(fixed.historySelection ? { historySelection: fixed.historySelection } : {}), compatibility } };
}

import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { selectWfdFixedRecords, type WfdFixedRecordReader } from './wfd-fixed-selection.js';

export const FINANCIAL_FIXED_VERSION = 'bd-financial-fixed/1';
export const FINANCIAL_MAPPING_VERSION = 'cas-primary-statements/1';
export interface FinancialCalculation {
  version: typeof FINANCIAL_FIXED_VERSION;
  operation: 'standardize';
  inputs: { snapshotId: string; productId: string; businessKeys: string[] }[];
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
export function readFinancialCalculation(raw: unknown): FinancialCalculation {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['version', 'operation', 'inputs'].includes(key))
    || raw.version !== FINANCIAL_FIXED_VERSION || raw.operation !== 'standardize'
    || !Array.isArray(raw.inputs) || !raw.inputs.length || raw.inputs.length > 16) fail('财务固定变换需要明确已登记版本、操作和固定输入引用，不能提交客户端数值。');
  for (const input of raw.inputs as unknown[]) {
    if (!isWfdRecord(input) || Object.keys(input).sort().join(',') !== 'businessKeys,productId,snapshotId'
      || !id(input.snapshotId) || !id(input.productId) || !Array.isArray(input.businessKeys) || !input.businessKeys.length
      || input.businessKeys.length > 1000 || !input.businessKeys.every(id) || new Set(input.businessKeys).size !== input.businessKeys.length) fail('固定输入须逐项指定真实快照、产品及准确业务键；不读取最新值或目录通配。');
  }
  return structuredClone(raw) as unknown as FinancialCalculation;
}
const field = (row: WfdRecord, key: string): string => {
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values[key]) ? row.values[key] as WfdRecord : null;
  if (!cell || !['valid_value', 'reported_zero'].includes(String(cell.value_state)) || typeof cell.value !== 'string') return fail(`固定输入缺明确 ${key}；不按同名或最新值补齐。`);
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
  })), reader, signal, reason => fail(reason));
  const inputs = fixed.selections.map((selection, index) => ({
    ref: calculation.inputs[index]!, rows: selection.rows,
  }));
  const inputEvidence: WfdRecord[] = fixed.selections.map((selection, index) => ({
    ...calculation.inputs[index]!, selectedRows: selection.rows.length,
    selectedRowsSha256: selection.selectedRowsSha256, recordVersions: selection.recordVersions,
  }));
  const connection = fixed.connection;
  const lineage: WfdRecord[] = [], unmapped: WfdRecord[] = [];
  const rows = inputs.flatMap(input => input.rows.flatMap(row => {
    const original = field(row, 'concept'), mapping = codes[original];
    if (!mapping) { unmapped.push({ record: row.record_ref, concept: original }); return []; }
    if (field(row, 'accounting_standard') !== 'CAS' || field(row, 'currency') !== 'CNY' || field(row, 'unit') !== 'cny') fail('当前映射只对明确CAS、人民币元原值开放；其他币种、单位或准则须另有映射。');
    assertFinancialValueUnit(row);
    const values = Object.fromEntries(Object.entries(row.values as WfdRecord).map(([key, cell]) => [key, (cell as WfdRecord).value]));
    const identity = { snapshot: input.ref.snapshotId, product: input.ref.productId, record: row.record_ref, mapping: FINANCIAL_MAPPING_VERSION };
    const key = 'standardized_' + wfdSha256(canonicalWfdJson(identity));
    const result = { ...values, concept: mapping.code, original_concept: original, value_state: (row.values as any).value.value_state,
      business_key: key, start_utc: field(row, 'start_date') + 'T00:00:00Z', end_utc: nextDay(field(row, 'end_date')) + 'T00:00:00Z' };
    lineage.push({ businessKey: key, source: identity, additive: mapping.additive, unitFactor: '1' });
    return [result];
  }));
  if (!rows.length || rows.length > 1000) fail('本次固定映射没有合格输出或超过1000条输出预算；未补值或静默截断。');
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { version: FINANCIAL_FIXED_VERSION, mappingVersion: FINANCIAL_MAPPING_VERSION,
    operation: calculation.operation, connection, inputs: inputEvidence, outputRows: rows.length, unmapped, lineage,
    historicalQualification: 'not_asserted' } };
}

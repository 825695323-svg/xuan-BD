import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { selectWfdFixedRecords, type WfdFixedRecordReader } from '../../financial/wfd-fixed-selection.js';

export const FINANCIAL_FIXED_VERSION = 'bd-financial-fixed/1';
export const FINANCIAL_MAPPING_VERSION = 'cas-primary-statements/1';
export const FINANCIAL_LINEAR_ADMISSION_VERSION = 'bd-financial-linear-admission/1';
export interface FinancialCalculation {
  version: typeof FINANCIAL_FIXED_VERSION;
  operation: 'standardize' | 'quarter_difference' | 'ttm';
  inputs: { snapshotId: string; productId: string; businessKeys: string[] }[];
  /** 跨披露修订的相容性须由实际保管原文核对；客户端不能提供输入值。 */
  compatibilityReview?: { materialId: string; originalSha256: string; quote: string };
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
const additive = new Set(Object.values(codes).filter(value => value.additive).map(value => value.code));
export function readFinancialCalculation(raw: unknown): FinancialCalculation {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['version', 'operation', 'inputs', 'compatibilityReview'].includes(key))
    || raw.version !== FINANCIAL_FIXED_VERSION || !['standardize', 'quarter_difference', 'ttm'].includes(String(raw.operation))
    || !Array.isArray(raw.inputs) || !raw.inputs.length || raw.inputs.length > 16) fail('财务固定变换需要明确已登记版本、操作和固定输入引用，不能提交客户端数值。');
  for (const input of raw.inputs as unknown[]) {
    if (!isWfdRecord(input) || Object.keys(input).sort().join(',') !== 'businessKeys,productId,snapshotId'
      || !id(input.snapshotId) || !id(input.productId) || !Array.isArray(input.businessKeys) || !input.businessKeys.length
      || input.businessKeys.length > 1000 || !input.businessKeys.every(id) || new Set(input.businessKeys).size !== input.businessKeys.length) fail('固定输入须逐项指定真实快照、产品及准确业务键；不读取最新值或目录通配。');
  }
  if (raw.operation !== 'standardize' && raw.inputs.length !== (raw.operation === 'ttm' ? 3 : 2)) fail('单季差分须有两项，TTM须有年度、本期累计、上年同期累计三项有序固定输入。');
  if (raw.compatibilityReview !== undefined) {
    const review = raw.compatibilityReview;
    if (!isWfdRecord(review) || Object.keys(review).sort().join(',') !== 'materialId,originalSha256,quote'
      || !id(review.materialId) || typeof review.originalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(review.originalSha256)
      || typeof review.quote !== 'string' || review.quote.length < 20 || review.quote.length > 10_000) fail('跨修订相容性核对需要受管材料的准确摘要及完整影响范围原文。');
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
function decimal(value: string): { c: bigint; scale: number } {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || value.length > 128) return fail('财务变换仅接受完整规范十进制字符串。');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 18 || whole!.replace('-', '').length + fraction.length > 38) fail('财务值超过已验证的38位/18位小数预算。');
  return { c: BigInt(whole! + fraction), scale: fraction.length };
}
function linear(values: string[], signs: number[]): string {
  const parts = values.map(decimal), scale = Math.max(...parts.map(value => value.scale));
  const coefficient = parts.reduce((sum, value, index) => sum + BigInt(signs[index]!) * value.c * 10n ** BigInt(scale - value.scale), 0n);
  const negative = coefficient < 0n; let digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale) digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  if (scale) digits = digits.replace(/0+$/u, '').replace(/\.$/u, '');
  const result = (negative ? '-' : '') + digits; decimal(result); return result;
}
const nextDay = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
export function financialAlgorithmDefinition(operation: FinancialCalculation['operation']): WfdRecord {
  return { definition_version: operation === 'standardize' ? '1.0.0' : '1.1.0', result_semantics: operation === 'standardize'
    ? 'CAS主表受控科目映射；原人民币元不换币，不改范围和原披露版本；未映射科目保留缺口，存量不转流量。'
    : '同主体、CAS、人民币元、同合并范围的可加流量；仅接整表时间列角色current/comparison或显式all，不接分部、权益分项或更正调整列。单季与TTM为确定性派生，原披露和单季另存。跨修订仅对经实际更正原文核对不变的净利润开放。',
    mathematical_definition: operation === 'standardize' ? 'Explicit cas-primary-statements/1 concept mapping; value_out = exact_decimal(value_in), unit factor = 1. No allocation, estimation, scope merging or missing-value filling.'
      : operation === 'quarter_difference' ? 'Q = YTD_current - YTD_previous. Same fiscal-year start and adjacent source endpoints; additive flows only. Exact decimal integer arithmetic; no rounding.'
        : 'TTM = FY_previous + YTD_current - YTD_previous_same_period. Exact contiguous calendar-year periods and additive flows only. Exact decimal integer arithmetic; no rounding.',
    window: { type: 'financial_period', count: operation === 'ttm' ? 3 : operation === 'quarter_difference' ? 2 : 1,
      interval: 'closed', unit: 'explicit_fixed_financial_periods' }, constants: { unit_factor: 1 } };
}

/** 时间列角色不是业务分部；当前仅对已支持的整表角色做期间算术。 */
function financialLinearRow(calculation: FinancialCalculation, sourceRows: WfdRecord[], inputEvidence: WfdRecord[],
  verifyReview: (review: NonNullable<FinancialCalculation['compatibilityReview']>) => void): WfdRecord {
  const signature = (row: WfdRecord) => ['subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'scope', 'unit', 'concept'].map(key => field(row, key));
  if (new Set(sourceRows.map(row => canonicalWfdJson(signature(row)))).size !== 1) fail('财务主体、准则、币种、单位、范围或科目不相容；未因同名合并。');
  if (sourceRows.some(row => field(row, 'accounting_standard') !== 'CAS' || field(row, 'currency') !== 'CNY' || field(row, 'unit') !== 'cny')) {
    fail('当前期间算术只对明确CAS、人民币元原值开放；其他币种、单位或准则须另有登记方法。');
  }
  sourceRows.forEach(assertFinancialValueUnit);
  if (sourceRows.some(row => !['current', 'comparison', 'all'].includes(field(row, 'dimension')))) {
    fail('期间算术仅支持整表时间列角色current/comparison或显式all；分部、权益分项、更正调整列和未知维度须另行核定，不能相减或拼接。');
  }
  const first = sourceRows[0]!, concept = field(first, 'concept');
  if (!additive.has(concept) || sourceRows.some(row => field(row, 'period_type') !== 'duration')) fail('存量、EPS、比率、平均量或未登记可加性科目不能套累计减法/TTM。');
  if (new Set(sourceRows.map(row => field(row, 'report_version'))).size !== 1) {
    if (concept !== 'net_profit_total' || !calculation.compatibilityReview) fail('披露修订不同，尚无此科目的明确相容依据。');
    verifyReview(calculation.compatibilityReview);
  }
  let start: string, end: string, value: string;
  if (calculation.operation === 'quarter_difference') {
    const previous = sourceRows[1]!;
    const currentStart = field(first, 'start_date'), previousStart = field(previous, 'start_date');
    end = field(first, 'end_date'); start = nextDay(field(previous, 'end_date'));
    if (currentStart !== previousStart || !currentStart.endsWith('-01-01') || start > end || currentStart.slice(0, 4) !== end.slice(0, 4)) fail('累计期间不在同财年或不能衔接；未假定任意两期可相减。');
    const allowed = new Map([['03-31', '06-30'], ['06-30', '09-30'], ['09-30', '12-31']]);
    if (allowed.get(field(previous, 'end_date').slice(5)) !== end.slice(5)) fail('本版单季只验证自然财年的相邻季度端点，变更财年或非相邻期须另行适配。');
    value = linear(sourceRows.map(row => field(row, 'value')), [1, -1]);
  } else {
    const current = sourceRows[1]!, previous = sourceRows[2]!;
    const fyStart = field(first, 'start_date'), fyEnd = field(first, 'end_date'), currentStart = field(current, 'start_date');
    end = field(current, 'end_date'); start = nextDay(field(previous, 'end_date'));
    if (!fyStart.endsWith('-01-01') || !fyEnd.endsWith('-12-31') || fyStart.slice(0, 4) !== fyEnd.slice(0, 4)
      || currentStart !== nextDay(fyEnd) || field(previous, 'start_date') !== fyStart
      || field(previous, 'end_date').slice(5) !== end.slice(5) || end.slice(0, 4) !== currentStart.slice(0, 4)) fail('TTM输入不是前一完整自然年度和相容的本期/上年同期累计；未拼接不连续期间。');
    value = linear(sourceRows.map(row => field(row, 'value')), [1, 1, -1]);
  }
  const base = Object.fromEntries(Object.entries(first.values as WfdRecord).map(([key, cell]) => [key, (cell as WfdRecord).value]));
  const key = 'financial_derived_' + wfdSha256(canonicalWfdJson({ calculation, inputs: inputEvidence }));
  return { ...base, business_key: key, report_id: 'derived-' + calculation.operation, report_version: FINANCIAL_FIXED_VERSION,
    dimension: 'derived', period_type: 'duration', start_date: start, end_date: end, value, value_state: 'valid_value',
    start_utc: start + 'T00:00:00Z', end_utc: nextDay(end) + 'T00:00:00Z', original_concept: concept };
}

/** 发布前沿原冻结引用和所选行证据重新核定；不改旧结果，也不把缺证据当作已合格。 */
export function assertFinancialLinearCandidate(raw: FinancialCalculation, evidence: WfdRecord, rows: WfdRecord[],
  verifyReview: (review: NonNullable<FinancialCalculation['compatibilityReview']>) => void): void {
  const calculation = readFinancialCalculation(raw), proof = evidence.linearAdmission;
  if (calculation.operation === 'standardize' || !isWfdRecord(proof) || proof.version !== FINANCIAL_LINEAR_ADMISSION_VERSION
    || proof.calculationSha256 !== wfdSha256(canonicalWfdJson(calculation)) || !Array.isArray(proof.rows)
    || proof.rows.length !== calculation.inputs.length || !Array.isArray(evidence.inputs) || evidence.inputs.length !== calculation.inputs.length) {
    throw new TaskError('FINANCIAL_FIXED_PROOF_REQUIRED', '原财务候选缺当前准入版本的受信固定行证据；旧结果仍可读取。请沿原固定输入引用另建计算任务，核定口径后再准备新发布。');
  }
  const sourceRows = proof.rows as WfdRecord[], inputEvidence = evidence.inputs as WfdRecord[];
  for (const [index, input] of calculation.inputs.entries()) {
    const row = sourceRows[index], item = inputEvidence[index];
    if (!isWfdRecord(row) || !isWfdRecord(row.record_ref) || !isWfdRecord(row.values) || !isWfdRecord(item)
      || input.businessKeys.length !== 1 || row.record_ref.logical_key !== input.businessKeys[0]
      || typeof row.record_ref.revision_id !== 'string' || !row.record_ref.revision_id
      || item.snapshotId !== input.snapshotId || item.productId !== input.productId
      || canonicalWfdJson(item.businessKeys) !== canonicalWfdJson(input.businessKeys) || item.selectedRows !== 1
      || item.selectedRowsSha256 !== wfdSha256(canonicalWfdJson([row]))
      || canonicalWfdJson(item.recordVersions) !== canonicalWfdJson([row.record_ref])) fail('财务候选的原固定输入、记录版本或所选行摘要不符，不能新发布。');
  }
  const expected = financialLinearRow(calculation, sourceRows, inputEvidence, verifyReview);
  if (canonicalWfdJson(rows) !== canonicalWfdJson([expected])
    || canonicalWfdJson(evidence.algorithmDefinition) !== canonicalWfdJson(financialAlgorithmDefinition(calculation.operation))) fail('财务候选与原固定行的准入口径、期间算术或算法定义不符，不能新发布。');
}

export async function projectFinancialFixed(raw: FinancialCalculation, reader: FinancialReader, signal: AbortSignal,
  verifyReview: (review: NonNullable<FinancialCalculation['compatibilityReview']>) => void) {
  const calculation = readFinancialCalculation(raw);
  // 财务与宏观使用同一套受信 WFD 固定行选择与分页身份核验；本方法继续
  // 负责 CAS/币种/整表期间/数值口径，不把读取资格当成计算或发布资格。
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
  let rows: WfdRecord[];
  if (calculation.operation === 'standardize') {
    rows = inputs.flatMap(input => input.rows.flatMap(row => {
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
  } else {
    if (inputs.some(input => input.rows.length !== 1)) fail('本版每次财务期间变换只处理一个科目/主体组合；每项固定输入须准确一行。');
    const sourceRows = inputs.map(input => input.rows[0]!);
    rows = [financialLinearRow(calculation, sourceRows, inputEvidence, verifyReview)];
    lineage.push({ businessKey: rows[0]!.business_key, inputs: inputEvidence, operation: calculation.operation });
  }
  if (!rows.length || rows.length > 1000) fail('本次固定映射没有合格输出或超过1000条输出预算；未补值或静默截断。');
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { version: FINANCIAL_FIXED_VERSION, mappingVersion: FINANCIAL_MAPPING_VERSION,
    operation: calculation.operation, connection, inputs: inputEvidence, outputRows: rows.length, unmapped, lineage,
    ...(calculation.operation === 'standardize' ? {} : { linearAdmission: { version: FINANCIAL_LINEAR_ADMISSION_VERSION,
      calculationSha256: wfdSha256(canonicalWfdJson(calculation)), rows: inputs.map(input => input.rows[0]!) } }),
    historicalQualification: 'not_asserted', arithmetic: 'exact-decimal-integer-no-rounding', algorithmDefinition: financialAlgorithmDefinition(calculation.operation) } };
}

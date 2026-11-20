import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../../contracts/financial-value.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

export const FINANCIAL_COLUMN_ROLES = ['current_period', 'prior_period_comparative_unchanged', 'prior_period_restated'] as const;
export type FinancialColumnRole = typeof FINANCIAL_COLUMN_ROLES[number];
export const FINANCIAL_SCOPES = ['consolidated', 'parent_only'] as const;
export type FinancialStatementScope = typeof FINANCIAL_SCOPES[number];
export const FINANCIAL_REPORT_NATURES = ['forecast', 'preliminary', 'formal', 'correction', 'restatement_carrier'] as const;
export type FinancialReportNature = typeof FINANCIAL_REPORT_NATURES[number];

const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const known = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  && !/^(unknown|unresolved|unspecified|not_asserted|not_reported|未知|未明确)$/iu.test(value);
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && isExplicitUtcInstant(`${value}T00:00:00Z`);

const forecastBounds = ['lower_bound', 'upper_bound', 'forecast_lower_bound', 'forecast_upper_bound'] as const;
const isReportNature = (value: unknown): value is FinancialReportNature => FINANCIAL_REPORT_NATURES.some(nature => nature === value);

export function assertActualFinancialReport(row: WfdRecord, storedValues?: WfdRecord): void {
  const cell = storedValues?.report_nature;
  const storedNature = isWfdRecord(cell) ? cell.value : cell;
  if (row.report_nature === 'forecast' || storedNature === 'forecast'
    || forecastBounds.some(key => Object.hasOwn(row, key) || storedValues && Object.hasOwn(storedValues, key))) {
    throw new TaskError('FINANCIAL_FORECAST_NOT_ACTUAL', '业绩预告或携带预告区间的行只进入 management_claim_or_event，不能进入实际三表 L2/L3。');
  }
  // 只兼容历史行缺省类别的情况。显式的未知类别及未解析的类别单元须拒绝。
  if (Object.hasOwn(row, 'report_nature') && !isReportNature(row.report_nature)
    || storedValues && Object.hasOwn(storedValues, 'report_nature') && (!isReportNature(storedNature)
      || !isWfdRecord(cell) || cell.value_state !== 'valid_value' && cell.value_state !== 'reported_zero')) {
    throw new TaskError('FINANCIAL_REPORT_NATURE', '实际财务行的报告类别须为已登记的明确类别。');
  }
}

/** 报告分类只依据明确的载体声明；预告区间用十进制字符串保留披露精度。 */
export function classifyAndValidateReportNature(input: {
  report_nature: FinancialReportNature;
  audit_status?: string;
  lower_bound?: string;
  upper_bound?: string;
  target?: 'actual_financial_statements' | 'management_claim_or_event';
}) {
  const { report_nature, lower_bound, upper_bound, target } = input;
  if (target === 'actual_financial_statements') assertActualFinancialReport(input);
  const fail = (message: string): never => { throw new TaskError('FINANCIAL_REPORT_NATURE', message); };
  if (!isReportNature(report_nature)
    || target !== undefined && target !== 'actual_financial_statements' && target !== 'management_claim_or_event')
    fail('须明确声明财报载体类别与目标域。');
  if (report_nature === 'forecast') {
    if (typeof lower_bound !== 'string' || typeof upper_bound !== 'string' || lower_bound.length > 1024 || upper_bound.length > 1024
      || !decimal.test(lower_bound) || !decimal.test(upper_bound)) return fail('业绩预告须有明确十进制区间上下限。');
    const scale = Math.max(lower_bound.split('.')[1]?.length ?? 0, upper_bound.split('.')[1]?.length ?? 0);
    const scaled = (value: string) => {
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole! + fraction.padEnd(scale, '0'));
    };
    if (scaled(lower_bound) > scaled(upper_bound)) fail('业绩预告区间下限不得大于上限。');
    return { report_nature, domain: 'management_claim_or_event', lower_bound, upper_bound } as const;
  }
  if (target === 'management_claim_or_event' || lower_bound !== undefined || upper_bound !== undefined)
    fail('实际披露点值与业绩预告区间必须分别声明。');
  if (report_nature === 'preliminary' && known(input.audit_status)
    && !['unaudited', 'preliminary_unaudited'].includes(input.audit_status)) fail('业绩快报的审计声明与未经审计的载体类别冲突。');
  if (report_nature !== 'preliminary' && input.audit_status === 'preliminary_unaudited') fail('正式、更正及重述报告不能带业绩快报审计标签。');
  return { report_nature, domain: 'actual_financial_statements',
    audit_status: report_nature === 'preliminary' ? 'preliminary_unaudited' : input.audit_status ?? 'unknown' } as const;
}

export interface FinancialPeriod {
  start_date: string;
  end_date: string;
}

export interface ComparativeFinancialFact extends FinancialPeriod {
  subject_scheme: string;
  subject_code: string;
  accounting_standard: string;
  currency: string;
  statement: string;
  scope: FinancialStatementScope;
  section: string;
  concept: string;
  dimension: string;
  period_type: 'instant' | 'duration';
  unit: string;
  fiscal_calendar: string;
  report_id: string;
  report_version: string;
  report_nature: FinancialReportNature;
  audit_status?: string;
  column_role: FinancialColumnRole;
  comparability_basis: string;
  /** 载有本列的报告实际公开时间。比较列也使用载体报告的时间。 */
  public_time: string | null;
}

type PairingGap = 'public_time_unresolved' | 'basis_unresolved' | 'incompatible_series'
  | 'current_period_missing' | 'compatible_comparative_missing' | 'ambiguous_version';
const sameSeriesAxes = ['subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'statement',
  'scope', 'section', 'concept', 'dimension', 'period_type', 'unit', 'fiscal_calendar'] as const;
const rolePriority: Record<FinancialColumnRole, number> = {
  current_period: 0, prior_period_comparative_unchanged: 1, prior_period_restated: 2,
};
const periodKey = (period: FinancialPeriod) => `${period.start_date}/${period.end_date}`;
const carrierKey = (row: ComparativeFinancialFact) => canonicalWfdJson([row.report_id, row.report_version]);

/** periods 首项明确给出当期，其余为调用方已核定的基期，按返回顺序保留。 */
export function pairComparativeFinancialPeriods<T extends ComparativeFinancialFact>(input: {
  rows: readonly T[];
  periods: readonly FinancialPeriod[];
  market_known_at: string;
}): { status: 'paired'; current: T; comparisons: T[]; comparability_basis: string }
  | { status: 'indeterminate'; reason: PairingGap; period?: FinancialPeriod } {
  const { rows, periods, market_known_at } = input;
  if (!isExplicitUtcInstant(market_known_at)) throw new TaskError('FINANCIAL_MARKET_CUTOFF', '市场知悉截止须为明确 UTC 时刻。');
  if (periods.length < 2 || new Set(periods.map(periodKey)).size !== periods.length
    || periods.some((period, index) => !validDate(period.start_date) || !validDate(period.end_date)
      || period.start_date > period.end_date || index > 0 && period.end_date >= periods[0]!.end_date))
    throw new TaskError('FINANCIAL_COMPARATIVE_PERIODS', '须给出实际有效的当期和各个较早基期，不从公历日期推定财年。');
  const gap = (reason: PairingGap) => ({ status: 'indeterminate', reason } as const);
  const requested = new Set(periods.map(periodKey));
  const cutoff = Date.parse(market_known_at);
  const possiblyVisible = rows.flatMap(row => {
    const time = isExplicitUtcInstant(row.public_time) ? Date.parse(row.public_time) : null;
    return time === null || time <= cutoff ? [{ row, time }] : [];
  });
  const relevant = possiblyVisible.filter(({ row }) => requested.has(periodKey(row)));
  if (relevant.some(({ time }) => time === null)) return gap('public_time_unresolved');
  const carrierTimes = new Map(relevant.map(({ row, time }) => [carrierKey(row), time]));
  if (possiblyVisible.some(({ row, time }) => {
    const publicTime = carrierTimes.get(carrierKey(row));
    return publicTime !== undefined && time !== publicTime;
  })) return gap('public_time_unresolved');

  const visible = relevant.map(({ row }) => row);
  if (visible.some(row => ![row.report_id, row.report_version, row.comparability_basis, ...sameSeriesAxes.map(axis => row[axis])].every(known)
    || !FINANCIAL_COLUMN_ROLES.includes(row.column_role) || !FINANCIAL_SCOPES.includes(row.scope)
    || !['instant', 'duration'].includes(row.period_type) || row.period_type === 'instant' && row.start_date !== row.end_date
    || row.report_nature === 'restatement_carrier' && row.column_role === 'current_period')) return gap('basis_unresolved');
  for (const row of visible) classifyAndValidateReportNature({ ...row, target: 'actual_financial_statements' });

  const quality = (row: T) => Number(row.report_nature !== 'preliminary');
  const newest = (a: T, b: T) => Date.parse(b.public_time!) - Date.parse(a.public_time!);
  const currentOrder = (a: T, b: T) => quality(b) - quality(a) || newest(a, b);
  const anchors = visible.filter(row => periodKey(row) === periodKey(periods[0]!) && row.column_role === 'current_period');
  if (!anchors.length) return gap('current_period_missing');
  const current = anchors.sort(currentOrder)[0]!;
  if (visible.some(row => sameSeriesAxes.some(axis => row[axis] !== current[axis]))) return gap('incompatible_series');
  if (anchors[1] && currentOrder(current, anchors[1]) === 0) return gap('ambiguous_version');

  const sameCarrier = (row: T) => Number(carrierKey(row) === carrierKey(current));
  const comparisonOrder = (a: T, b: T) => rolePriority[b.column_role] - rolePriority[a.column_role]
    || sameCarrier(b) - sameCarrier(a) || newest(a, b);
  const comparisons: T[] = [];
  for (const period of periods.slice(1)) {
    const eligible = visible.filter(row => periodKey(row) === periodKey(period)
      && row.comparability_basis === current.comparability_basis && quality(row) === quality(current)).sort(comparisonOrder);
    const [prior, other] = eligible;
    if (!prior) return { ...gap('compatible_comparative_missing'), period };
    if (other && comparisonOrder(prior, other) === 0) return { ...gap('ambiguous_version'), period };
    comparisons.push(prior);
  }
  return { status: 'paired', current, comparisons, comparability_basis: current.comparability_basis };
}

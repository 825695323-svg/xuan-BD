import { add, divide, formatExactDecimal, multiply, negative, readExactDecimal,
  type DecimalInput, type Fraction } from '../collection/numeric-precision.js';

const cumulativePeriods = ['Q1_YTD', 'H1', 'Q3_YTD', 'FY'] as const;
const quarterPeriods = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
export type FinancialQuarter = typeof quarterPeriods[number];
type FinancialPeriod = typeof cumulativePeriods[number] | FinancialQuarter;

export interface FinancialBasis {
  subject: string;
  accounting_standard: string;
  currency: string;
  scope: string;
  comparability_basis: string;
  unit: string;
  fiscalCalendar?: string;
}

export interface FinancialObservation extends FinancialBasis {
  concept: string;
  fiscalCalendar: string;
  fiscalYear: number;
  period: FinancialPeriod;
  periodType: 'duration' | 'instant';
  additive: boolean;
  value: DecimalInput | null;
  sourceRef?: string;
}

interface Diagnostic {
  code: 'MISSING_INPUT' | 'ZERO_BASE' | 'NON_POSITIVE_BASE' | 'ZERO_DENOMINATOR' | 'UNAVAILABLE_COMPONENT';
  output: string;
  fields: readonly string[];
}

const basisAxes = ['subject', 'accounting_standard', 'currency', 'scope', 'comparability_basis', 'unit'] as const;
const subtract = (a: Fraction, b: Fraction) => add(a, negative(b));
const missing = (value: unknown): value is null | undefined => value === null || value === undefined;
const known = (value: unknown): value is string => typeof value === 'string' && !!value && value.trim() === value
  && !/^(?:unknown|unresolved|unspecified|unverified|not_asserted|未知|未明确)$/iu.test(value);

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code: 'FINANCIAL_' + code });
}

function validateBasis(basis: FinancialBasis, requireFiscalCalendar: boolean): void {
  for (const axis of basisAxes) {
    if (!known(basis[axis])) reject('BASIS_REQUIRED', '缺少明确财务口径 ' + axis);
  }
  if ((requireFiscalCalendar || basis.fiscalCalendar !== undefined) && !known(basis.fiscalCalendar))
    reject('BASIS_REQUIRED', '缺少明确财历。');
}

function validateObservation(row: FinancialObservation, reference: FinancialObservation): void {
  validateBasis(row, true);
  if (!known(row.concept)) reject('BASIS_REQUIRED', '缺少明确财务科目。');
  for (const axis of [...basisAxes, 'concept', 'fiscalCalendar', 'periodType', 'additive'] as const) {
    if (row[axis] !== reference[axis]) reject('BASIS_MISMATCH', '财务观测口径不一致 ' + axis);
  }
  if (!['duration', 'instant'].includes(row.periodType) || typeof row.additive !== 'boolean'
    || !Number.isInteger(row.fiscalYear) || row.fiscalYear < 1 || row.fiscalYear > 9999
    || ![...cumulativePeriods, ...quarterPeriods].includes(row.period)) reject('PERIOD', '财务观测期间声明无效。');
}

function additiveInputs(observations: readonly FinancialObservation[]) {
  const first = observations[0];
  if (!first) reject('MISSING_PERIOD', '缺少财务期间。');
  const periods = new Set<string>();
  return observations.map(row => {
    validateObservation(row, first);
    if (row.periodType !== 'duration' || row.additive !== true) reject('NON_ADDITIVE', '期间运算要求可加性的区间科目。');
    const key = row.fiscalYear + '/' + row.period;
    if (periods.has(key)) reject('DUPLICATE_PERIOD', '财务期间重复 ' + key);
    periods.add(key);
    if (missing(row.value)) reject('MISSING_INPUT', '财务期间缺值 ' + key);
    return { row, value: readExactDecimal(row.value, key) };
  });
}

/** Convert a contiguous prefix of a fiscal year's cumulative reports into single quarters. */
export function computeFinancialSingleQuarter(observations: readonly FinancialObservation[]) {
  const inputs = additiveInputs(observations)
    .sort((a, b) => cumulativePeriods.findIndex(period => period === a.row.period)
      - cumulativePeriods.findIndex(period => period === b.row.period));
  return inputs.map(({ row, value }, index) => {
    if (row.fiscalYear !== inputs[0].row.fiscalYear || row.period !== cumulativePeriods[index]) {
      reject('MISSING_PERIOD', '累计转单季要求同一财年从 Q1_YTD 连续到目标期。');
    }
    const previous = inputs[index - 1];
    return { ...row, period: quarterPeriods[index],
      value: formatExactDecimal(previous ? subtract(value, previous.value) : value),
      lineage: { method: 'cumulative_to_single_quarter', inputs: previous ? [{ ...previous.row }, { ...row }] : [{ ...row }] },
      diagnostics: [] as Diagnostic[] };
  });
}

export function computeFinancialTtm(observations: readonly FinancialObservation[]) {
  const inputs = additiveInputs(observations);
  const result = (method: 'four_quarters' | 'fy_plus_ytd_delta', rows: typeof inputs, value: Fraction) => ({
    value: formatExactDecimal(value),
    lineage: { method, inputs: rows.map(({ row }) => ({ ...row })) },
    diagnostics: [] as Diagnostic[],
  });
  if (inputs.length === 4 && inputs.every(({ row }) => quarterPeriods.some(period => period === row.period))) {
    const index = (row: FinancialObservation) => row.fiscalYear * 4 + quarterPeriods.indexOf(row.period as FinancialQuarter);
    inputs.sort((a, b) => index(a.row) - index(b.row));
    if (inputs.every(({ row }, position) => index(row) === index(inputs[0].row) + position)) {
      return result('four_quarters', inputs, inputs.map(item => item.value).reduce(add));
    }
  }
  if (inputs.length === 3) {
    const fy = inputs.find(({ row }) => row.period === 'FY');
    const current = inputs.find(({ row }) => row.period !== 'FY' && row.fiscalYear === (fy?.row.fiscalYear ?? 0) + 1);
    const prior = inputs.find(({ row }) => row.period === current?.row.period && row.fiscalYear === fy?.row.fiscalYear);
    if (fy && current && prior && cumulativePeriods.slice(0, -1).some(period => period === current.row.period)) {
      return result('fy_plus_ytd_delta', [fy, current, prior], add(fy.value, subtract(current.value, prior.value)));
    }
  }
  return reject('MISSING_PERIOD', 'TTM 要求连续四个单季，或上年 FY 加当前 YTD 减上年同期间 YTD。');
}

export interface FinancialGrowthOptions {
  comparison: 'yoy' | 'qoq';
  mode?: 'growth_rate' | 'percentage_points';
  allowSignedBase?: boolean;
}

export function computeFinancialGrowth(current: FinancialObservation, prior: FinancialObservation, options: FinancialGrowthOptions) {
  validateObservation(current, current);
  validateObservation(prior, current);
  const { comparison, mode = 'growth_rate', allowSignedBase = false } = options;
  if (!['yoy', 'qoq'].includes(comparison) || !['growth_rate', 'percentage_points'].includes(mode)
    || typeof allowSignedBase !== 'boolean') reject('GROWTH_OPTIONS', '增长须明确同比或环比及计算方式。');
  const currentQuarter = quarterPeriods.findIndex(period => period === current.period);
  const priorQuarter = quarterPeriods.findIndex(period => period === prior.period);
  const comparable = comparison === 'yoy' ? current.fiscalYear === prior.fiscalYear + 1 && current.period === prior.period
    : currentQuarter >= 0 && priorQuarter >= 0 && current.fiscalYear * 4 + currentQuarter === prior.fiscalYear * 4 + priorQuarter + 1;
  if (!comparable) reject('PERIOD', '同比要求上年同期间，环比要求连续单季。');
  if (mode === 'percentage_points' && current.unit !== 'ratio') reject('GROWTH_OPTIONS', '百分点差要求小数比率单位 ratio。');

  const lineage = { comparison, mode, allowSignedBase, inputs: [{ ...current }, { ...prior }] };
  const actual = missing(current.value) ? null : readExactDecimal(current.value, 'current');
  const base = missing(prior.value) ? null : readExactDecimal(prior.value, 'prior');
  const unavailable = (code: Diagnostic['code'], fields: string[]) => ({
    value: null, lineage, diagnostics: [{ code, output: 'value', fields }],
  });
  if (!actual || !base) return unavailable('MISSING_INPUT', [...(!actual ? ['current'] : []), ...(!base ? ['prior'] : [])]);
  const delta = subtract(actual, base);
  if (mode === 'growth_rate' && base.n === 0n) return unavailable('ZERO_BASE', ['prior']);
  if (mode === 'growth_rate' && base.n < 0n && !allowSignedBase) return unavailable('NON_POSITIVE_BASE', ['prior']);
  const value = mode === 'percentage_points' ? multiply(delta, { n: 100n, d: 1n }) : divide(delta, base);
  return { value: formatExactDecimal(value), lineage, diagnostics: [] as Diagnostic[] };
}

const snapshotFields = ['revenue', 'costOfRevenue', 'netProfit', 'averageAssets', 'averageEquity', 'currentAssets', 'currentLiabilities',
  'averageReceivables', 'averageInventory', 'averagePayables', 'periodDays', 'cfo', 'capex'] as const;
type SnapshotField = typeof snapshotFields[number];

/** Supply a single comparable period and monetary unit. CAPEX is a positive outflow magnitude. */
export type FinancialRatioSnapshot = FinancialBasis & Partial<Record<SnapshotField, DecimalInput | null>> & {
  periodRef: string;
  sourceRefs?: Partial<Record<SnapshotField, string>>;
};

export function computeFinancialRatios(snapshot: FinancialRatioSnapshot) {
  validateBasis(snapshot, false);
  if (!known(snapshot.periodRef)) reject('PERIOD', '比率快照须声明期间。');
  const diagnostics: Diagnostic[] = [];
  const inputs = new Map<SnapshotField, Fraction>();
  for (const field of snapshotFields) {
    const raw = snapshot[field];
    if (!missing(raw)) inputs.set(field, readExactDecimal(raw, field));
  }
  const days = inputs.get('periodDays'), capex = inputs.get('capex');
  if (days && (days.n <= 0n || days.d !== 1n)) reject('PERIOD', 'periodDays 必须为正整数。');
  if (capex && capex.n < 0n) reject('INPUT_SIGN', 'capex 必须按支出绝对额提供。');

  const metric = (output: string, fields: readonly SnapshotField[], calculate: (...args: Fraction[]) => Fraction,
    denominator?: SnapshotField) => {
    const gaps = fields.filter(field => !inputs.has(field));
    if (gaps.length) { diagnostics.push({ code: 'MISSING_INPUT', output, fields: gaps }); return null; }
    if (denominator && inputs.get(denominator)?.n === 0n) {
      diagnostics.push({ code: 'ZERO_DENOMINATOR', output, fields: [denominator] }); return null;
    }
    return calculate(...fields.map(field => inputs.get(field)!));
  };
  const ratio = (output: string, numerator: SnapshotField, denominator: SnapshotField) =>
    metric(output, [numerator, denominator], divide, denominator);
  const turnoverDays = (output: string, balance: SnapshotField, flow: SnapshotField) =>
    metric(output, [balance, flow, 'periodDays'], (amount, total, period) => divide(multiply(amount, period), total), flow);
  const combine = (output: string, parts: Record<string, Fraction | null>, calculate: (...args: Fraction[]) => Fraction) => {
    const gaps = Object.keys(parts).filter(field => parts[field] === null);
    if (gaps.length) { diagnostics.push({ code: 'UNAVAILABLE_COMPONENT', output, fields: gaps }); return null; }
    return calculate(...Object.values(parts) as Fraction[]);
  };

  const netMargin = ratio('netMargin', 'netProfit', 'revenue');
  const assetTurnover = ratio('assetTurnover', 'revenue', 'averageAssets');
  const equityMultiplier = ratio('equityMultiplier', 'averageAssets', 'averageEquity');
  const dso = turnoverDays('dso', 'averageReceivables', 'revenue');
  const dio = turnoverDays('dio', 'averageInventory', 'costOfRevenue');
  const dpo = turnoverDays('dpo', 'averagePayables', 'costOfRevenue');
  const results = {
    grossMargin: metric('grossMargin', ['revenue', 'costOfRevenue'], (revenue, cost) => divide(subtract(revenue, cost), revenue), 'revenue'),
    netMargin, roe: ratio('roe', 'netProfit', 'averageEquity'), roa: ratio('roa', 'netProfit', 'averageAssets'),
    assetTurnover, equityMultiplier,
    dupontRoe: combine('dupontRoe', { netMargin, assetTurnover, equityMultiplier }, (margin, turnover, leverage) =>
      multiply(multiply(margin, turnover), leverage)),
    workingCapital: metric('workingCapital', ['currentAssets', 'currentLiabilities'], subtract),
    dso, dio, dpo,
    ccc: combine('ccc', { dso, dio, dpo }, (receivable, inventory, payable) => subtract(add(receivable, inventory), payable)),
    freeCashFlow: metric('freeCashFlow', ['cfo', 'capex'], subtract),
    earningsQuality: ratio('earningsQuality', 'cfo', 'netProfit'),
  };
  const values = Object.fromEntries(Object.entries(results).map(([field, value]) =>
    [field, value === null ? null : formatExactDecimal(value)])) as Record<keyof typeof results, string | null>;
  const lineage = { snapshot: { ...snapshot, ...(snapshot.sourceRefs && { sourceRefs: { ...snapshot.sourceRefs } }) },
    assetAndEquityBasis: 'period_average', dpoDenominator: 'cost_of_revenue' };
  return { values, lineage, diagnostics };
}

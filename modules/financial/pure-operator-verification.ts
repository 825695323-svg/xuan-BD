import { isDeepStrictEqual } from 'node:util';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { add, compare, divide, formatExactDecimal, multiply, negative, readExactDecimal, type Fraction } from '../collection/numeric-precision.js';
import { financialBasisAxes, knownFinancialLabel, type FinancialGrowthOptions, type FinancialObservation, type FinancialRatioSnapshot } from './financial-l4-operators.js';
import { declaredMarketUnitScale, type MarketAdjustmentBasis, type MarketAdjustmentInput, type MarketCorporateAction } from './market-adjustment-contract.js';
import { PURE_VERIFICATION_VERSION } from './algorithm-pure-operators.js';

export type PureOperatorInput =
  | { methodId: 'financial_single_quarter' | 'financial_ttm'; observations: FinancialObservation[] }
  | { methodId: 'financial_growth'; current: FinancialObservation; prior: FinancialObservation; options: FinancialGrowthOptions }
  | { methodId: 'financial_ratios'; snapshot: FinancialRatioSnapshot }
  | { methodId: 'price_adjustment'; market: MarketAdjustmentInput; basis: MarketAdjustmentBasis };

const zero = { n: 0n, d: 1n }, one = { n: 1n, d: 1n };
const ytd = ['Q1_YTD', 'H1', 'Q3_YTD', 'FY'], quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
const difference = (a: Fraction, b: Fraction) => add(a, negative(b));
function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new TaskError('PURE_OPERATOR_VERIFICATION_FAILED', '独立数学核验失败 ' + name);
}
function record(value: unknown): WfdRecord {
  check(isWfdRecord(value), 'result_shape');
  return value;
}
// 有限十进制须精确相等。循环小数只在与输出契约相同的最终舍入位置比较一次。
function exact(actual: unknown, expected: Fraction, name: string) {
  check(typeof actual === 'string' && actual === formatExactDecimal(expected), name);
}
function comparable(rows: FinancialObservation[], additive: boolean) {
  check(rows.length > 0, 'observations_required');
  for (const row of rows) {
    for (const axis of [...financialBasisAxes, 'fiscalCalendar', 'concept'] as const)
      check(knownFinancialLabel(row[axis]) && row[axis] === rows[0][axis], 'comparable_' + axis);
    check(Number.isInteger(row.fiscalYear) && row.fiscalYear >= 1 && row.fiscalYear <= 9999
      && [...quarters, ...ytd].includes(row.period) && ['duration', 'instant'].includes(row.periodType)
      && row.periodType === rows[0].periodType && typeof row.additive === 'boolean' && row.additive === rows[0].additive, 'fiscal_period');
    if (additive) check(row.periodType === 'duration' && row.additive && row.value != null, 'additive_duration');
  }
}

function singleQuarter(rows: FinancialObservation[], result: unknown) {
  comparable(rows, true);
  check(Array.isArray(result) && result.length === rows.length && rows.length <= 4, 'quarter_count');
  let accumulated = zero;
  const ordered = [...rows].sort((a, b) => ytd.indexOf(a.period) - ytd.indexOf(b.period));
  for (const [i, original] of ordered.entries()) {
    const row = record(result[i]);
    check(original.fiscalYear === ordered[0].fiscalYear && original.period === ytd[i] && row.period === quarters[i], 'continuous_ytd');
    const { period: _period, value: _value, ...basis } = original;
    for (const [key, v] of Object.entries(basis)) check(row[key] === v, 'quarter_basis');
    check(typeof row.value === 'string', 'quarter_decimal');
    accumulated = add(accumulated, readExactDecimal(row.value, 'quarter'));
    exact(row.value, difference(readExactDecimal(original.value, 'ytd'),
      i ? readExactDecimal(ordered[i - 1].value, 'previous_ytd') : zero), 'linearity');
    check(compare(accumulated, readExactDecimal(original.value, 'ytd')) === 0, 'cumulative_reconstruction');
    check(record(row.lineage).method === 'cumulative_to_single_quarter' && isDeepStrictEqual(row.diagnostics, []) && isDeepStrictEqual(record(row.lineage).inputs,
      i ? [ordered[i - 1], original] : [original]), 'quarter_lineage');
  }
  return ['continuous_comparable_periods', 'linearity', 'cumulative_reconstruction'];
}

function ttm(rows: FinancialObservation[], result: WfdRecord) {
  comparable(rows, true);
  const lineage = record(result.lineage);
  check(isDeepStrictEqual(result.diagnostics, []), 'ttm_diagnostics');
  if (rows.length === 4) {
    const index = (r: FinancialObservation) => r.fiscalYear * 4 + quarters.indexOf(r.period);
    const ordered = [...rows].sort((a, b) => index(a) - index(b));
    check(ordered.every((r, i) => quarters.includes(r.period) && index(r) === index(ordered[0]) + i), 'continuous_quarters');
    exact(result.value, ordered.reduce((sum, row) => add(sum, readExactDecimal(row.value, 'quarter')), zero), 'four_quarter_sum');
    check(lineage.method === 'four_quarters' && isDeepStrictEqual(lineage.inputs, ordered), 'ttm_lineage');
    return ['continuous_comparable_periods', 'four_quarter_sum'];
  }
  const ordered = [...rows].sort((a, b) => a.fiscalYear - b.fiscalYear || ytd.indexOf(a.period) - ytd.indexOf(b.period));
  const [prior, annual, current] = ordered;
  check(rows.length === 3 && annual.period === 'FY' && annual.fiscalYear === prior.fiscalYear
    && current.fiscalYear === prior.fiscalYear + 1 && current.period === prior.period && ytd.slice(0, 3).includes(current.period), 'fy_ytd_periods');
  // 独立拆成上年剩余区间和本年已报告区间。
  const remainder = difference(readExactDecimal(annual.value, 'fy'), readExactDecimal(prior.value, 'prior_ytd'));
  exact(result.value, add(remainder, readExactDecimal(current.value, 'current_ytd')), 'fy_ytd_bridge');
  check(lineage.method === 'fy_plus_ytd_delta' && isDeepStrictEqual(lineage.inputs, [annual, current, prior]), 'ttm_lineage');
  return ['adjacent_comparable_fiscal_years', 'fy_ytd_bridge'];
}

type NullDiagnostic = { output: string; code: string; fields: string[] };
function growth(input: Extract<PureOperatorInput, { methodId: 'financial_growth' }>, result: WfdRecord) {
  const { current, prior, options } = input;
  comparable([current, prior], false);
  const { comparison, mode = 'growth_rate', allowSignedBase = false } = options;
  const qi = quarters.indexOf(current.period), pi = quarters.indexOf(prior.period);
  check(comparison === 'yoy' ? current.fiscalYear === prior.fiscalYear + 1 && current.period === prior.period
    : comparison === 'qoq' && qi >= 0 && pi >= 0 && 4 * (current.fiscalYear - prior.fiscalYear) + qi - pi === 1, 'growth_periods');
  check(mode === 'growth_rate' || mode === 'percentage_points' && current.unit === 'ratio', 'growth_mode');
  const missing = [current.value == null && 'current', prior.value == null && 'prior'].filter((v): v is string => !!v);
  const diagnostics: NullDiagnostic[] = [];
  if (missing.length) diagnostics.push({ output: 'value', code: 'MISSING_INPUT', fields: missing });
  else {
    const a = readExactDecimal(current.value, 'current'), b = readExactDecimal(prior.value, 'prior');
    if (mode === 'growth_rate' && (b.n === 0n || b.n < 0n && !allowSignedBase))
      diagnostics.push({ output: 'value', code: b.n === 0n ? 'ZERO_BASE' : 'NON_POSITIVE_BASE', fields: ['prior'] });
    else exact(result.value, mode === 'percentage_points' ? multiply(difference(a, b), { n: 100n, d: 1n })
      : difference(divide(a, b), one), 'growth_value');
  }
  check(!diagnostics.length || result.value === null, 'growth_null');
  check(isDeepStrictEqual(result.diagnostics, diagnostics) && isDeepStrictEqual(result.lineage,
    { comparison, mode, allowSignedBase, inputs: [current, prior] }), 'growth_evidence');
  return ['comparable_growth_periods', 'growth_value', 'null_diagnostics'];
}

function ratios(snapshot: FinancialRatioSnapshot, result: WfdRecord) {
  check([...financialBasisAxes, 'fiscalCalendar', 'periodRef'].every(axis => knownFinancialLabel(snapshot[axis as keyof FinancialRatioSnapshot])), 'ratio_basis');
  const values = record(result.values), expected = new Map<string, Fraction | null>();
  const diagnostics: NullDiagnostic[] = [];
  type Field = keyof FinancialRatioSnapshot;
  function metric(name: string, fields: Field[], calc: (...args: Fraction[]) => Fraction, denominator?: Field) {
    const missing = fields.filter(field => snapshot[field] == null);
    if (missing.length) diagnostics.push({ output: name, code: 'MISSING_INPUT', fields: missing });
    else if (denominator && readExactDecimal(snapshot[denominator], denominator).n === 0n)
      diagnostics.push({ output: name, code: 'ZERO_DENOMINATOR', fields: [denominator] });
    else { expected.set(name, calc(...fields.map(field => readExactDecimal(snapshot[field], field)))); return; }
    expected.set(name, null);
  }
  function derived(name: string, components: string[], evaluate: (...args: Fraction[]) => Fraction) {
    const missing = components.filter(field => expected.get(field) === null);
    if (missing.length) diagnostics.push({ output: name, code: 'UNAVAILABLE_COMPONENT', fields: missing });
    expected.set(name, missing.length ? null : evaluate(...components.map(field => expected.get(field)!)));
  }
  metric('grossMargin', ['revenue', 'costOfRevenue'], (sales, cost) => difference(one, divide(cost, sales)), 'revenue');
  for (const [name, numerator, denominator] of [
    ['netMargin', 'netProfit', 'revenue'], ['assetTurnover', 'revenue', 'averageAssets'],
    ['equityMultiplier', 'averageAssets', 'averageEquity'], ['roe', 'netProfit', 'averageEquity'],
    ['roa', 'netProfit', 'averageAssets'], ['earningsQuality', 'cfo', 'netProfit'],
  ] as const) metric(name, [numerator, denominator], divide, denominator);
  derived('dupontRoe', ['netMargin', 'assetTurnover', 'equityMultiplier'], (m, t, e) => multiply(m, multiply(t, e)));
  const dupont = expected.get('dupontRoe');
  if (dupont) check(compare(dupont, expected.get('roe')!) === 0, 'dupont_identity');
  for (const [name, amount, flow] of [['dso', 'averageReceivables', 'revenue'], ['dio', 'averageInventory', 'costOfRevenue'],
    ['dpo', 'averagePayables', 'costOfRevenue']] as const)
    metric(name, [amount, flow, 'periodDays'], (balance, total, days) => multiply(days, divide(balance, total)), flow);
  derived('ccc', ['dso', 'dio', 'dpo'], (s, i, p) => add(s, difference(i, p)));
  metric('workingCapital', ['currentAssets', 'currentLiabilities'], difference);
  metric('freeCashFlow', ['cfo', 'capex'], difference);
  for (const [name, value] of expected)
    if (value) exact(values[name], value, name); else check(values[name] === null, name + '_null');
  check(Object.keys(values).length === expected.size && Array.isArray(result.diagnostics)
    && result.diagnostics.length === diagnostics.length && diagnostics.every(d => (result.diagnostics as unknown[]).some(item => isDeepStrictEqual(item, d)))
    && isDeepStrictEqual(record(result.lineage).snapshot, snapshot), 'ratio_evidence');
  return ['exact_ratios', 'dupont_identity', 'cash_cycle', 'null_diagnostics'];
}

/** Reconstruct the comparable sets from every sealed row without using the runner's basis decision. */
function verifyMarketBasis(market: MarketAdjustmentInput, basis: MarketAdjustmentBasis) {
  check(basis && Array.isArray(basis.bars) && basis.bars.length > 0 && basis.bars.length === market.bars.length
    && Array.isArray(basis.actions) && basis.actions.length === market.actions.length, 'market_basis_rows');
  const subjects = new Set<string>(), currencies = new Set<string>(), definitions = new Map<string, string>();
  for (const row of [...basis.bars, ...basis.actions]) {
    const subject = record(row.subject);
    check(['kind', 'namespace', 'id'].every(key => knownFinancialLabel(subject[key])) && subject.id === row.subjectId, 'market_subject');
    check(knownFinancialLabel(row.currency) && isWfdRecord(row.units), 'market_currency_units');
    subjects.add(canonicalWfdJson(subject)); currencies.add(row.currency);
    for (const unit of Object.values(row.units)) {
      check(isWfdRecord(unit) && knownFinancialLabel(unit.unit_code), 'declared_unit');
      const signature = canonicalWfdJson(unit), prior = definitions.get(unit.unit_code);
      check(prior === undefined || prior === signature, 'unit_definition');
      definitions.set(unit.unit_code, signature);
    }
  }
  check(subjects.size === 1 && currencies.size === 1, 'comparable_market_rows');
  const prices = basis.bars.flatMap(row => ['open', 'high', 'low', 'close'].map(key => row.units[key]));
  const ratios: WfdRecord[] = [];
  for (const [i, action] of market.actions.entries()) {
    const units = basis.actions[i].units;
    if (action.kind === 'cash_dividend') prices.push(units.cashPerShare);
    else ratios.push(action.kind === 'split' ? units.splitRatio : units.sharesPerShare);
  }
  check(prices.every(unit => declaredMarketUnitScale(unit) !== null)
    && new Set(prices.map(unit => canonicalWfdJson(unit))).size === 1, 'same_price_and_cash_unit');
  check(ratios.every(unit => {
    const scale = declaredMarketUnitScale(unit);
    return scale !== null && scale.n === scale.d && ['ratio', 'shares_per_share'].includes(String(unit.unit_code));
  }) && new Set(ratios.map(unit => canonicalWfdJson(unit))).size <= 1, 'unscaled_share_ratio');
}

function adjustment(input: MarketAdjustmentInput, result: WfdRecord) {
  check(input.adjustment === 'none' && input.frequency === '1d', 'raw_daily');
  const bars = [...input.bars].sort((a, b) => a.date.localeCompare(b.date));
  const forward = input.direction === 'forward_qfq', end = bars.length - 1;
  check((forward || input.direction === 'backward_hfq') && bars.length && bars[forward ? end : 0].date === input.anchorDate, 'anchor_date');
  const byDate = new Map<string, MarketCorporateAction[]>();
  for (const action of input.actions) {
    check(action.claimStatus === 'confirmed' && action.effectiveStatus === 'effective', 'confirmed_effective');
    if (action.effectiveDate <= bars[0].date || action.effectiveDate > bars[end].date) continue;
    const events = byDate.get(action.effectiveDate) ?? [];
    events.push(action); byDate.set(action.effectiveDate, events);
  }
  const lineage = record(result.lineage);
  check(lineage.method === 'theoretical_ex_price_ratio' && lineage.anchorDate === input.anchorDate && lineage.direction === input.direction && lineage.frequency === '1d'
    && lineage.adjustment === 'none' && Array.isArray(lineage.appliedActions) && lineage.appliedActions.length === byDate.size, 'event_lineage');
  check(Array.isArray(result.rows) && result.rows.length === bars.length, 'bar_count');
  const factors: Fraction[] = [], steps = new Map<number, Fraction>();
  let applied = 0;
  for (const [i, bar] of bars.entries()) {
    const events = byDate.get(bar.date);
    if (!events) continue;
    const previous = bars[i - 1], previousClose = readExactDecimal(previous.close, 'previous_close');
    let exPrice = previousClose, newShares = one;
    for (const e of events) {
      if (e.kind === 'cash_dividend') exPrice = difference(exPrice, readExactDecimal(e.cashPerShare, 'cash'));
      else if (e.kind === 'split') newShares = add(newShares, difference(readExactDecimal(e.splitRatio, 'split'), one));
      else newShares = add(newShares, readExactDecimal(e.sharesPerShare, 'shares'));
    }
    const step = divide(divide(exPrice, newShares), previousClose), audit = record(lineage.appliedActions[applied++]);
    check(step.n > 0n && audit.effectiveDate === bar.date && audit.previousDate === previous.date
      && audit.previousClose === previous.close && isDeepStrictEqual(audit.events, events), 'event_chain');
    exact(audit.stepFactor, step, 'event_factor'); steps.set(i, step);
  }
  check(applied === byDate.size, 'effective_bar_required');
  // 从锚点向另一端直接累乘或累除，不复用主实现的公共基准归一化。
  factors[forward ? end : 0] = one;
  for (let k = 1; k <= end; k++) {
    if (forward) factors[end - k] = multiply(factors[end - k + 1], steps.get(end - k + 1) ?? one);
    else factors[k] = divide(factors[k - 1], steps.get(k) ?? one);
  }
  for (const [i, bar] of bars.entries()) {
    const row = record(result.rows[i]), adjusted = record(row.adjusted);
    check(row.date === bar.date, 'bar_order');
    exact(row.adj_factor, factors[i], 'anchored_factor_chain');
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      check(row[field] === bar[field], 'raw_ohlc');
      exact(adjusted[field], multiply(readExactDecimal(bar[field], field), factors[i]), 'adjusted_' + field);
    }
    const low = readExactDecimal(adjusted.low, 'low'), high = readExactDecimal(adjusted.high, 'high');
    for (const field of ['open', 'close']) {
      const price = readExactDecimal(adjusted[field], field);
      check(low.n > 0n && compare(low, price) <= 0 && compare(price, high) <= 0, 'ohlc_order');
    }
  }
  return ['confirmed_effective_raw_daily', 'unit_anchor', 'event_factor_chain', 'ohlc_order'];
}

export function verifyPureOperator(input: PureOperatorInput, result: unknown) {
  let checks: string[];
  switch (input.methodId) {
    case 'financial_single_quarter': checks = singleQuarter(input.observations, result); break;
    case 'financial_ttm': checks = ttm(input.observations, record(result)); break;
    case 'financial_growth': checks = growth(input, record(result)); break;
    case 'financial_ratios': checks = ratios(input.snapshot, record(result)); break;
    case 'price_adjustment':
      verifyMarketBasis(input.market, input.basis);
      checks = ['fixed_subject_and_units', ...adjustment(input.market, record(result))]; break;
  }
  return { status: 'verified' as const, methodId: input.methodId, version: PURE_VERIFICATION_VERSION, checks,
    inputSha256: wfdSha256(canonicalWfdJson(input)), resultSha256: wfdSha256(canonicalWfdJson(result)) };
}

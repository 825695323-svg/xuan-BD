import assert from 'node:assert/strict';
import test from 'node:test';
import { factorLibraryView } from '../collection/production-module-ports.js';
import { ALGORITHM_DEFINITIONS } from './algorithm-definitions.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';
import { ALGORITHM_METHOD_IDS, type AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract } from './basic-algorithm-tool-contract.js';
import { computeFinancialGrowth, computeFinancialRatios, computeFinancialSingleQuarter, computeFinancialTtm,
  type FinancialObservation } from './financial-l4-operators.js';
import { computeAdjustedMarketSeries, type MarketAdjustmentInput } from './market-adjustment-contract.js';
import { ToolLibraryService } from './tool-library.js';

// All financial amounts, OHLC and action terms below are synthetic test inputs.
const basis = { subject: 'synthetic_issuer', accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated',
  comparability_basis: 'synthetic_reviewed_revision', unit: 'cny', fiscalCalendar: 'synthetic_calendar' };

function observation(fiscalYear: number, period: FinancialObservation['period'], value: FinancialObservation['value']): FinancialObservation {
  return { ...basis, concept: 'revenue', fiscalYear, period, periodType: 'duration', additive: true, value,
    sourceRef: `synthetic/${fiscalYear}/${period}` };
}

test('累计转单季及 TTM 按相容期间精确计算并保留源观测', () => {
  const q1 = observation(2025, 'Q1_YTD', '10000000000000000.000000000000000001');
  const h1 = observation(2025, 'H1', '10000000000000000.000000000000000003');
  const q3 = observation(2025, 'Q3_YTD', '10000000000000000.100000000000000003');
  const fy = observation(2025, 'FY', '10000000000000000.300000000000000003');
  const quarters = computeFinancialSingleQuarter([fy, q3, q1, h1]);
  assert.deepEqual(quarters.map(({ period, value }) => [period, value]),
    [['Q1', q1.value], ['Q2', '0.000000000000000002'], ['Q3', '0.1'], ['Q4', '0.2']]);
  assert.ok(quarters.every(row => row.fiscalCalendar === basis.fiscalCalendar));
  assert.deepEqual(quarters[1].lineage.inputs, [q1, h1]);
  const currentQ1 = observation(2026, 'Q1', '0.4');
  const ttmQuarters = computeFinancialTtm([currentQ1, ...quarters.slice(1)]);
  const ttmYtd = computeFinancialTtm([h1, fy, observation(2026, 'H1', '0.7')]);
  assert.equal(computeFinancialTtm(quarters).value, fy.value);
  assert.equal(ttmQuarters.value, '0.700000000000000002');
  assert.equal(ttmQuarters.lineage.method, 'four_quarters');
  assert.equal(ttmYtd.value, '1');
  assert.equal(ttmYtd.lineage.method, 'fy_plus_ytd_delta');
});

test('财务期间算子拒绝跨口径、非加性科目、缺期、重复或无效数值', () => {
  const q1 = observation(2025, 'Q1_YTD', '1'), h1 = observation(2025, 'H1', '2');
  for (const axis of ['subject', 'accounting_standard', 'currency', 'scope', 'comparability_basis', 'unit', 'fiscalCalendar'] as const) {
    assert.throws(() => computeFinancialSingleQuarter([q1, { ...h1, [axis]: 'other_basis' }]), { code: 'FINANCIAL_BASIS_MISMATCH' });
  }
  const missingCalendar = [q1, h1].map(({ fiscalCalendar: _calendar, ...row }) => row as FinancialObservation);
  assert.throws(() => computeFinancialSingleQuarter(missingCalendar), { code: 'FINANCIAL_BASIS_REQUIRED' });
  assert.throws(() => computeFinancialSingleQuarter([q1, missingCalendar[1]!]), { code: 'FINANCIAL_BASIS_REQUIRED' });
  for (const fiscalCalendar of ['', 'unknown', 'unresolved', 'unspecified']) {
    assert.throws(() => computeFinancialSingleQuarter([q1, { ...h1, fiscalCalendar }]), { code: 'FINANCIAL_BASIS_REQUIRED' });
  }
  const eps = { ...q1, concept: 'basic_eps', additive: false };
  assert.throws(() => computeFinancialSingleQuarter([eps]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialTtm([eps]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, periodType: 'instant' }]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialSingleQuarter([q1, observation(2025, 'Q3_YTD', 3)]), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialSingleQuarter([q1, q1]), { code: 'FINANCIAL_DUPLICATE_PERIOD' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, value: null }]), { code: 'FINANCIAL_MISSING_INPUT' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, value: Infinity }]), { code: 'NUMERIC_PRECISION_VALUE' });
  const quarters = computeFinancialSingleQuarter([q1, h1, observation(2025, 'Q3_YTD', 4), observation(2025, 'FY', 5)]);
  assert.throws(() => computeFinancialTtm(quarters.slice(1)), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialTtm([...quarters.slice(1), observation(2026, 'Q2', 1)]), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialTtm([...quarters.slice(1), { ...quarters[0], comparability_basis: 'revision_b' }]),
    { code: 'FINANCIAL_BASIS_MISMATCH' });
  assert.throws(() => computeFinancialTtm([h1, observation(2025, 'FY', 5), observation(2026, 'Q3_YTD', 4)]),
    { code: 'FINANCIAL_MISSING_PERIOD' });
});

test('同比、环比和百分点差有明确期间与基期规则', () => {
  const current = observation(2026, 'Q1', '5'), prior = observation(2025, 'Q1', '4');
  assert.equal(computeFinancialGrowth(current, prior, { comparison: 'yoy' }).value, '0.25');
  assert.equal(computeFinancialGrowth(current, { ...prior, period: 'Q4' }, { comparison: 'qoq' }).value, '0.25');
  assert.throws(() => computeFinancialGrowth(current, prior, { comparison: 'qoq' }), { code: 'FINANCIAL_PERIOD' });
  for (const [value, code] of [[0, 'ZERO_BASE'], [-2, 'NON_POSITIVE_BASE'], [null, 'MISSING_INPUT']] as const) {
    const result = computeFinancialGrowth(current, { ...prior, value }, { comparison: 'yoy' });
    assert.equal(result.value, null);
    assert.deepEqual(result.diagnostics, [{ code, output: 'value', fields: ['prior'] }]);
  }
  assert.equal(computeFinancialGrowth(current, { ...prior, value: -2 },
    { comparison: 'yoy', allowSignedBase: true }).value, '-3.5');
  assert.equal(computeFinancialGrowth({ ...current, unit: 'ratio', value: '0.031' }, { ...prior, unit: 'ratio', value: 0 },
    { comparison: 'yoy', mode: 'percentage_points' }).value, '3.1');
});

test('比率、杜邦和 CCC 保留分项，缺项和零分母各有诊断', () => {
  const snapshot = { ...basis, periodRef: 'synthetic/2025/Q1', revenue: 100, costOfRevenue: 60, netProfit: 10,
    averageAssets: 200, averageEquity: 50, currentAssets: 60, currentLiabilities: 25,
    averageReceivables: 20, averageInventory: 30, averagePayables: 10, periodDays: 90, cfo: 25, capex: 5 };
  const result = computeFinancialRatios(snapshot);
  assert.deepEqual(result.values, { grossMargin: '0.4', netMargin: '0.1', roe: '0.2', roa: '0.05',
    assetTurnover: '0.5', equityMultiplier: '4', dupontRoe: '0.2', workingCapital: '35',
    dso: '18', dio: '45', dpo: '15', ccc: '48', freeCashFlow: '20', earningsQuality: '2.5' });
  assert.deepEqual(result.diagnostics, []);
  const partial = computeFinancialRatios({ ...snapshot, revenue: 0, netProfit: 0, averagePayables: null, capex: null });
  assert.equal(partial.values.earningsQuality, null);
  assert.equal(partial.values.dupontRoe, null);
  assert.equal(partial.values.ccc, null);
  assert.equal(partial.values.dio, '45');
  assert.equal(partial.values.freeCashFlow, null);
  assert.ok(partial.diagnostics.some(item => item.output === 'earningsQuality' && item.code === 'ZERO_DENOMINATOR'));
  assert.ok(partial.diagnostics.some(item => item.output === 'freeCashFlow' && item.fields.includes('capex')));
});

const bars = [
  { date: '2026-03-02', open: 100, high: 120, low: 80, close: '100.00' },
  { date: '2026-03-03', open: 40, high: 48, low: 32, close: 40 },
  { date: '2026-03-04', open: 20, high: 24, low: 16, close: 20 },
];
const confirmed = { claimStatus: 'confirmed', effectiveStatus: 'effective', effectiveDate: bars[1].date };
const marketInput: MarketAdjustmentInput = {
  direction: 'forward_qfq', anchorDate: bars[2].date, adjustment: 'none', frequency: '1d', bars,
  actions: [
    { ...confirmed, id: 'cash', kind: 'cash_dividend', cashPerShare: 20 },
    { ...confirmed, id: 'stock', kind: 'stock_dividend', sharesPerShare: '0.25' },
    { ...confirmed, id: 'capital', kind: 'capitalization', sharesPerShare: '0.75' },
    { ...confirmed, effectiveDate: bars[2].date, id: 'split', kind: 'split', splitRatio: 2 },
  ],
};

test('前后复权按各自锚点归一，四种行动因子可核对且原价完整保留', () => {
  const forward = computeAdjustedMarketSeries({ ...marketInput, bars: [...bars].reverse() });
  const backward = computeAdjustedMarketSeries({ ...marketInput, direction: 'backward_hfq', anchorDate: bars[0].date });
  assert.deepEqual(forward.rows.map(row => row.adj_factor), ['0.2', '0.5', '1']);
  assert.deepEqual(backward.rows.map(row => row.adj_factor), ['1', '2.5', '5']);
  for (const [index, bar] of bars.entries()) {
    const { adjusted, adj_factor, ...raw } = forward.rows[index];
    assert.deepEqual(raw, bar);
    assert.deepEqual(adjusted, { open: '20', high: '24', low: '16', close: '20' });
    assert.deepEqual(backward.rows[index].adjusted, { open: '100', high: '120', low: '80', close: '100' });
    assert.equal(Number(adj_factor) * 5, Number(backward.rows[index].adj_factor));
  }
  assert.equal(forward.lineage.direction, 'forward_qfq');
  assert.equal(forward.lineage.anchorDate, bars[2].date);
  assert.deepEqual(forward.lineage.appliedActions.map(item => item.stepFactor), ['0.4', '0.5']);
  assert.deepEqual(forward.lineage.appliedActions.flatMap(item => item.events), marketInput.actions);
});

test('复权拒绝来源主张、未知生效状态、隐式锚点或方向、以及缺少生效日原价', () => {
  for (const status of [{ claimStatus: 'source_claim' }, { effectiveStatus: 'unknown' }]) {
    assert.throws(() => computeAdjustedMarketSeries({ ...marketInput,
      actions: [{ ...marketInput.actions[0], ...status }] }), { code: 'MARKET_ADJUSTMENT_ACTION_NOT_EFFECTIVE' });
  }
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, anchorDate: undefined as never }), { code: 'MARKET_ADJUSTMENT_ANCHOR' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, direction: undefined as never }), { code: 'MARKET_ADJUSTMENT_DIRECTION' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, adjustment: 'forward_qfq' as never }),
    { code: 'MARKET_ADJUSTMENT_RAW_DAILY_REQUIRED' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, bars: [bars[0], bars[2]] }),
    { code: 'MARKET_ADJUSTMENT_ACTION_BAR_MISSING' });
});

test('统一登记表、定义和两个目录显示同一组 15 项，Python 契约保留十个方法', () => {
  const pureIds = ['financial_single_quarter', 'financial_ttm', 'financial_growth', 'financial_ratios', 'price_adjustment'];
  assert.equal(ALGORITHM_METHOD_IDS.length, 10);
  const ids = [...ALGORITHM_METHOD_IDS, ...pureIds];
  const catalog = { methods: ALGORITHM_METHOD_IDS.map(id => ({ id, status: 'ready' })) } as AlgorithmCatalogView;
  const toolLibrary = new ToolLibraryService({ algorithms: { catalog: () => catalog } }).view();
  const factors = factorLibraryView();
  assert.equal(factors.total, 15);
  assert.deepEqual(ALGORITHM_REGISTRY.map(item => item.id), ids);
  assert.deepEqual(ALGORITHM_DEFINITIONS.map(item => item.registryId), ids);
  assert.deepEqual(factors.items.map(item => item.id), ids);
  assert.deepEqual(toolLibrary.tools.map(item => item.id), ids);
  assert.deepEqual(factors.items.map(item => item.definition), ALGORITHM_DEFINITIONS);
  assert.deepEqual(toolLibrary.tools.map(item => item.definition), ALGORITHM_DEFINITIONS);
  assert.deepEqual(toolLibrary.tools.filter(item => item.status === 'ready' && item.state === 'executable').map(item => item.id),
    ALGORITHM_METHOD_IDS);
  for (const directory of [toolLibrary.tools, factors.items]) {
    assert.deepEqual(directory.filter(item => item.state === 'assets_only').map(item => item.id), pureIds);
    for (const item of directory.filter(item => pureIds.includes(item.id))) {
      assert.equal(item.status, 'unavailable');
      assert.equal(item.reason, '纯 TS 受控算子已登记，尚未接入 `algorithms.calculate` 通用任务执行入口');
    }
  }
  assert.deepEqual(toolLibrary.registry?.counts, { executable: 10, assets_only: 5, not_implemented: 0, needs_data: 0 });
  assert.deepEqual(factors.counts, toolLibrary.registry?.counts);
  assert.deepEqual(toolLibrary.tools.slice(-5).map(item => item.category), ['financial', 'financial', 'financial', 'financial', 'adjustment']);
  assert.deepEqual(basicAlgorithmToolContract(catalog).methods.map(item => item.methodId), ALGORITHM_METHOD_IDS);
  assert.equal(basicAlgorithmToolContract(catalog, 'price_adjustment').unknownMethod, true);
  const detached = new ToolLibraryService().view().tools;
  assert.ok(detached.every(item => item.status === 'unavailable'));
});

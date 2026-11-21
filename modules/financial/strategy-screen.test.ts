import assert from 'node:assert/strict';
import test from 'node:test';
import { screenStrategy, StrategyScreenError, STRATEGY_SCREEN_LIMITS, type StrategyScreenInput } from './strategy-screen.js';

/** 所有行情与阈值均为合成样本，不表示实际策略参数或收益。 */
const base = (): StrategyScreenInput => ({ rows: [
  { code: 'B', momentum: 3, quality: 1 }, { code: 'C', momentum: 2, quality: 1 },
  { code: 'A', momentum: 3, quality: 1 }, { code: 'D', momentum: 1, quality: -1 },
], factorNames: ['momentum', 'quality'], keyField: 'code', filter: 'quality > 0', orderBy: 'momentum', topN: 2 });
const hasCode = (code: string) => (error: unknown) => error instanceof StrategyScreenError && error.code === code;

test('fixed cross section returns stable ordered candidates, basis and partitioned exclusions without mutation', () => {
  const input = base(), before = structuredClone(input);
  Object.freeze(input.rows); for (const row of input.rows) Object.freeze(row);
  const result = screenStrategy(input);
  assert.deepEqual(result.selected.map(row => row.key), ['A', 'B']);
  assert.deepEqual(result.selected.map(row => [row.score, row.position, row.rowIndex]), [[3, 1, 2], [3, 2, 0]]);
  assert.deepEqual(result.selected[0]!.factors, { momentum: 3, quality: 1 });
  assert.deepEqual(result.counts, { input: 4, filterMatched: 3, eligible: 3, selected: 2, excluded: 2 });
  assert.equal(result.exclusionCounts.filter_false, 1); assert.equal(result.exclusionCounts.top_n, 1);
  assert.equal(Object.values(result.exclusionCounts).reduce((a, b) => a + b, 0), result.counts.excluded);
  assert.deepEqual(input, before);
});

test('rank uses the entire supplied valid operand universe with average ranks for ties, before filtering', () => {
  const result = screenStrategy({ ...base(), filter: 'quality > 0 and rank(momentum) >= .5', orderBy: 'rank(momentum)', topN: 4 });
  assert.deepEqual(result.selected.map(row => [row.key, row.score]), [['A', .875], ['B', .875], ['C', .5]]);
  assert.equal(result.semantics.rankUniverse, 'all_input_rows_with_valid_operand');
  const changedFilter = screenStrategy({ ...base(), filter: 'momentum == 3', orderBy: 'rank(momentum)', topN: 4 });
  assert.equal(changedFilter.selected[0]!.score, .875, 'filter must not recalculate rank on two survivors');
});

test('missing and malformed values cannot pass inequality, negation, or an otherwise true disjunction', () => {
  const rows = [{ code: 'missing', momentum: null, quality: 1 }, { code: 'boolean', momentum: true, quality: 1 },
    { code: 'infinite', momentum: Infinity, quality: 1 }, { code: 'valid', momentum: 3, quality: 1 }];
  for (const filter of ['momentum != 1', 'not (momentum == 1)', 'quality > 0 or momentum > 0']) {
    const result = screenStrategy({ ...base(), rows, filter, topN: 4 });
    assert.deepEqual(result.selected.map(row => row.key), ['valid']);
    assert.equal(result.exclusionCounts.missing_factor, 1);
    assert.equal(result.exclusionCounts.invalid_factor, 2);
  }
});

test('zero divisors and overflow remain invalid under not and or, and in sorting', () => {
  for (const filter of ['not (momentum / 0 > 1)', 'quality > 0 or momentum / 0 < 1']) {
    const result = screenStrategy({ ...base(), filter });
    assert.equal(result.selected.length, 0); assert.equal(result.exclusionCounts.division_by_zero, 4);
  }
  const overflow = screenStrategy({ ...base(), filter: '', orderBy: 'momentum * 1e308' });
  assert.deepEqual(overflow.selected.map(row => row.key), ['D']);
  assert.equal(overflow.exclusionCounts.non_finite_result, 3);
  const sorting = screenStrategy({ ...base(), filter: '', orderBy: 'momentum / (quality - 1)' });
  assert.deepEqual(sorting.selected.map(row => row.key), ['D']);
  assert.equal(sorting.exclusionCounts.division_by_zero, 3);
});

test('numeric conversion is explicit decimal text only; no truthiness or blank-string zero coercion', () => {
  const rows = [
    { code: 'decimal', momentum: '1.2500', quality: '2e0' }, { code: 'blank', momentum: '', quality: 1 },
    { code: 'hex', momentum: '0xff', quality: 1 }, { code: 'spaces', momentum: ' 2 ', quality: 1 },
    { code: 'object', momentum: {}, quality: 1 }, { code: 'array', momentum: [3], quality: 1 },
  ];
  const result = screenStrategy({ ...base(), rows, filter: 'quality > 0', orderBy: '+momentum * 2 - -quality', topN: 4 });
  assert.deepEqual(result.selected.map(row => [row.key, row.score]), [['decimal', 4.5]]);
  assert.equal(result.exclusionCounts.invalid_factor, 5);
});

test('closed grammar rejects property access, calls, booleans in arithmetic, unknown names, and chained comparisons', () => {
  for (const orderBy of ['momentum.constructor', 'momentum[0]', 'Math.random()', 'eval(momentum)',
    'momentum ** 2', 'momentum > 2', 'rank(momentum, quality)', '"momentum"', '1e999', 'momentum; quality']) {
    assert.throws(() => screenStrategy({ ...base(), orderBy }), StrategyScreenError, orderBy);
  }
  for (const filter of ['momentum', 'quality + 1', '1 < momentum < 5', 'quality and momentum > 0', 'not momentum']) {
    assert.throws(() => screenStrategy({ ...base(), filter }), hasCode('STRATEGY_SCREEN_EXPRESSION'), filter);
  }
  assert.throws(() => screenStrategy({ ...base(), orderBy: 'unlisted' }), hasCode('STRATEGY_SCREEN_FACTOR_UNKNOWN'));
});

test('syntax, input, topN and depth limits reject excess work before evaluation', () => {
  for (const topN of [0, -1, 1.5, NaN, STRATEGY_SCREEN_LIMITS.topN + 1])
    assert.throws(() => screenStrategy({ ...base(), topN }), hasCode('STRATEGY_SCREEN_BUDGET'));
  assert.throws(() => screenStrategy({ ...base(), filter: ' '.repeat(STRATEGY_SCREEN_LIMITS.expressionLength + 1) }), hasCode('STRATEGY_SCREEN_BUDGET'));
  assert.throws(() => screenStrategy({ ...base(), orderBy: '('.repeat(13) + 'momentum' + ')'.repeat(13) }), hasCode('STRATEGY_SCREEN_BUDGET'));
  assert.throws(() => screenStrategy({ ...base(), orderBy: 'rank('.repeat(13) + 'momentum' + ')'.repeat(13) }), hasCode('STRATEGY_SCREEN_BUDGET'));
  assert.throws(() => screenStrategy({ ...base(), rows: Array(STRATEGY_SCREEN_LIMITS.rows + 1).fill({ code: 'A', momentum: 1 }) }), hasCode('STRATEGY_SCREEN_BUDGET'));
});

test('factor whitelist and explicit unique security keys are enforced even for no-filter rules', () => {
  assert.throws(() => screenStrategy({ ...base(), factorNames: ['momentum', 'momentum'] }), hasCode('STRATEGY_SCREEN_INPUT'));
  assert.throws(() => screenStrategy({ ...base(), factorNames: ['momentum', 'rank'] }), hasCode('STRATEGY_SCREEN_INPUT'));
  assert.throws(() => screenStrategy({ ...base(), rows: [{ code: 'A' }, { code: 'A' }] }), hasCode('STRATEGY_SCREEN_KEY'));
  assert.throws(() => screenStrategy({ ...base(), rows: [{ code: 600519, momentum: 1 }] }), hasCode('STRATEGY_SCREEN_KEY'));
  assert.throws(() => screenStrategy({ ...base(), rows: [{ momentum: 1 }] }), hasCode('STRATEGY_SCREEN_KEY'));
  const empty = screenStrategy({ ...base(), rows: [], filter: '' });
  assert.equal(empty.selected.length, 0); assert.equal(empty.counts.excluded, 0);
});

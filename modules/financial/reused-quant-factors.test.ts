import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureAssets, PYTHON_BRIDGE } from '../../plugins/financial/local-compute/assets.js';
import { ALGORITHM_METHODS, invalidAlgorithmParameter, type AlgorithmData, type AlgorithmMethodId } from './algorithm-types.js';

const factorIds = ['alpha191_014', 'alpha191_031', 'alpha191_116', 'alpha191_168', 'alpha191_189'] as const;
type FactorId = typeof factorIds[number];
type Execution = { ok: boolean; rows: Record<string, number | string | null>[];
  diagnostics: { timestamp: string; output: string; reason: string }[]; error?: string };
const configuredPython = process.env.WFD_PYTHON;
const bundle = captureAssets(fileURLToPath(new URL('../../plugins/financial/local-compute/assets', import.meta.url)));

function syntheticInput(prices: number[], volumes?: number[]): AlgorithmData {
  const rows = prices.map((close, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return { timestamp, close, available_at: `${timestamp}T18:00:00.000Z`, bar_closed: true as const,
      ...(volumes ? { volume: volumes[index]! } : {}) };
  });
  return { rows, metadata: { series_id: 'reused-factors-synthetic', subject: '公式合成测试样本', frequency: '1d', timezone: 'UTC',
    price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustment_basis: 'synthetic fixture',
    window_start: rows[0]!.timestamp, window_end: rows.at(-1)!.timestamp, as_of: '2026-04-01T00:00:00.000Z',
    availability_basis: 'explicit_per_bar', bar_closed: true, observations_are_consecutive: true,
    calendar_verification: 'dense', synthetic: true, ...(volumes ? { volume_unit: 'share' } : {}) } };
}

function execute(methodId: AlgorithmMethodId, data: AlgorithmData, params = {}): Execution {
  assert.ok(configuredPython);
  const method = ALGORITHM_METHODS[methodId];
  const completed = spawnSync(configuredPython, ['-I', '-S', '-B', '-c', PYTHON_BRIDGE], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 5_000,
    input: JSON.stringify({ files: bundle.files, request: { version: 1, kind: method.kind, operation: method.operation, params, data } }),
  });
  assert.equal(completed.status, 0, completed.error?.message ?? completed.stderr);
  return JSON.parse(completed.stdout) as Execution;
}

function column(id: FactorId, prices: number[], volumes?: number[]): (number | null)[] {
  const result = execute(id, syntheticInput(prices, volumes));
  assert.equal(result.ok, true, result.error ?? 'Python 计算未成功');
  return result.rows.map(row => row[ALGORITHM_METHODS[id].outputFields[0]!] as number | null);
}

function near(actual: number | null | undefined, expected: number): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual! - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

test('五个复用公式登记固定身份、来源提交及封闭参数', () => {
  for (const id of factorIds) {
    const method = ALGORITHM_METHODS[id];
    assert.match(method.reference, /2edbc3eaf799f4d8f42c99fccba3b8fc08554f10/u);
    assert.match(method.reference, /app\/services\/alpha191_formulas\.py:alpha_/u);
    assert.equal(invalidAlgorithmParameter(id, {}), null);
    assert.equal(invalidAlgorithmParameter(id, { period: 3 }), 'period');
    assert.equal(invalidAlgorithmParameter(id, { source: 'latest' }), 'source');
  }
});

describe('复用因子的真实封闭 Python 资产', { skip: configuredPython ? false : '未显式设置 WFD_PYTHON' }, () => {
  test('固定预热后得到可手算的线性序列值，包含嵌套窗口', () => {
    const prices = Array.from({ length: 30 }, (_, index) => 10 + index * 2);
    const volumes = prices.map(() => 100);
    const cases: [FactorId, number, number][] = [
      ['alpha191_014', 5, 10],
      ['alpha191_031', 11, 100 * (32 - 21) / 21],
      ['alpha191_116', 19, 2],
      ['alpha191_168', 19, -1],
      ['alpha191_189', 10, 5],
    ];
    for (const [id, warmup, first] of cases) {
      const values = column(id, prices, id === 'alpha191_168' ? volumes : undefined);
      assert.equal(values.length, prices.length);
      assert.deepEqual(values.slice(0, warmup), Array(warmup).fill(null));
      near(values[warmup], first);
      assert.ok(values.slice(warmup).every(value => typeof value === 'number' && Number.isFinite(value)));
    }
  });

  test('不足预热只产生空值和诊断，不补零或补历史', () => {
    for (const id of factorIds) {
      const result = execute(id, syntheticInput([10, 12, 11], id === 'alpha191_168' ? [1, 2, 3] : undefined));
      assert.equal(result.ok, true);
      assert.ok(result.rows.every(row => row[ALGORITHM_METHODS[id].outputFields[0]!] === null));
      assert.equal(result.diagnostics.length, 3);
      assert.ok(result.diagnostics.every(row => row.reason === 'insufficient_warmup'));
    }
  });

  test('增加未来行不会改变已给历史前缀', () => {
    const prices = Array.from({ length: 36 }, (_, index) => 20 + index / 4 + (index % 5));
    const volumes = prices.map((_, index) => 10 + (index * 13) % 80);
    for (const id of factorIds) {
      const volume = id === 'alpha191_168' ? volumes : undefined;
      const full = column(id, prices, volume);
      const prefix = column(id, prices.slice(0, 26), volume?.slice(0, 26));
      assert.deepEqual(full.slice(0, 26), prefix);
    }
  });

  test('双层偏离使用各时点均值，趋势斜率对平移不变', () => {
    const prices = Array.from({ length: 24 }, (_, index) => 100 + (index % 7) ** 2);
    const nested = column('alpha191_189', prices);
    for (let index = 10; index < prices.length; index++) {
      let total = 0;
      for (let end = index - 5; end <= index; end++) {
        const average = prices.slice(end - 5, end + 1).reduce((sum, value) => sum + value, 0) / 6;
        total += Math.abs(prices[end]! - average);
      }
      near(nested[index], total / 6);
    }
    const original = column('alpha191_116', prices), shifted = column('alpha191_116', prices.map(value => value + 1_000_000));
    for (let index = 19; index < prices.length; index++) near(shifted[index], original[index]!);
  });

  test('相对量保持缩放不变，全零窗口未定义且下一个有效窗口恢复', () => {
    const prices = Array(25).fill(10) as number[];
    const volumes = prices.map((_, index) => index < 20 ? 0 : 100);
    const result = execute('alpha191_168', syntheticInput(prices, volumes));
    assert.equal(result.rows[19]!.ALPHA191_168, null);
    assert.deepEqual(result.diagnostics.at(-1), { timestamp: '2026-01-20', output: 'ALPHA191_168', reason: 'undefined_zero_denominator' });
    near(result.rows[20]!.ALPHA191_168 as number, -20);
    const nonzero = prices.map((_, index) => 20 + index);
    const base = column('alpha191_168', prices, nonzero);
    const scaled = column('alpha191_168', prices, nonzero.map(value => value * 100));
    for (let index = 19; index < prices.length; index++) near(scaled[index], base[index]!);
    assert.deepEqual(column('alpha191_168', prices, prices.map(() => Number.MIN_VALUE)).slice(19), Array(6).fill(-1));
  });

  test('缺失或负成交量在执行层拒绝，不作为零量填补', () => {
    const input = syntheticInput(Array(22).fill(10), Array(22).fill(100));
    delete input.rows[5]!.volume;
    assert.equal(execute('alpha191_168', input).ok, false);
    input.rows[5]!.volume = -1;
    assert.equal(execute('alpha191_168', input).ok, false);
  });
});

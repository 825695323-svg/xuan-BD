import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { ALGORITHM_METHODS, invalidAlgorithmParameter, type AlgorithmBar, type AlgorithmComputedResult,
  type AlgorithmData, type AlgorithmMethodId, type AlgorithmParametersByMethod } from './algorithm-types.js';

const mismatch = (message: string): never => { throw new TaskError('DERIVED_NUMERIC_MISMATCH', message); };
const same = (actual: unknown, expected: number | null) => expected === null ? actual === null
  : typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));

type NumericResult = Pick<AlgorithmComputedResult, 'metadata' | 'methodId' | 'parameters' | 'rows'>;

/** 从原任务冻结的行重算，与 Python 实现和原输出声明独立。 */
export function verifyAlgorithmNumbers(result: NumericResult, input: AlgorithmData): void {
  const rows = result.rows, source = input.rows;
  if (source.length !== rows.length || !source.length || input.metadata.series_id !== result.metadata.series_id
    || canonicalWfdJson(input.metadata) !== canonicalWfdJson(result.metadata)) {
    mismatch('固定输入与原算法持久结果的行数、序列或期间不一致。');
  }
  const close = source.map((row, index) => {
    if (row.timestamp !== rows[index]?.timestamp || row.available_at !== rows[index]?.available_at
      || typeof row.close !== 'number' || !Number.isFinite(row.close)) {
      mismatch(`第 ${index + 1} 行固定输入、时间或收盘价格不同。`);
    }
    return row.close;
  });
  const { methodId, parameters } = result;
  if (methodId === 'macd') {
    verifyMacdNumbers(result, close);
    return;
  }
  const method = ALGORITHM_METHODS[methodId];
  if (invalidAlgorithmParameter(methodId, parameters) !== null) mismatch(`${method.operation} 参数不符合登记。`);
  if (method.closeDomain === 'positive' && close.some(value => value <= 0)) mismatch(`${method.operation} 要求正收盘价。`);
  const request = { methodId, parameters } as IndicatorRequest;
  const expected = referenceColumns(request, close, source);
  for (const field of method.outputFields) {
    for (const [index, value] of expected[field]!.entries()) {
      if (!same(rows[index]?.[field], value)) mismatch(`第 ${index + 1} 行 ${field} 的独立数值核对不一致。`);
    }
  }
}

function verifyMacdNumbers(result: NumericResult, close: number[]): void {
  const p = isWfdRecord(result.parameters) ? result.parameters : {};
  if (p.short_period !== 12 || p.long_period !== 26 || p.signal_period !== 9 || p.init !== 'first_valid')
    mismatch('MACD 参数不是固定 12/26/9 首值初始化。');
  let short = close[0]!, long = close[0]!, dea = 0;
  for (let i = 0; i < result.rows.length; i++) {
    if (i) {
      short = short + (close[i]! - short) * (2 / 13);
      long = long + (close[i]! - long) * (2 / 27);
    }
    const diff = short - long;
    dea = i ? dea + (diff - dea) * (2 / 10) : 0;
    const row = result.rows[i]!;
    if (!same(row.DIFF, diff) || !same(row.DEA, dea)
      || !same(row.MACD, 2 * (diff - dea)) || !same(row.ZERO, 0)) {
      mismatch(`第 ${i + 1} 行 MACD 的独立递推与原结果不一致。`);
    }
  }
}

type IndicatorId = Exclude<AlgorithmMethodId, 'macd'>;
type IndicatorRequest = { [Id in IndicatorId]: { methodId: Id; parameters: AlgorithmParametersByMethod[Id] } }[IndicatorId];
type NumericSeries = (number | null)[];

function referenceColumns(request: IndicatorRequest, close: number[], source: AlgorithmBar[]): Record<string, NumericSeries> {
  const { methodId, parameters } = request;
  switch (methodId) {
    case 'ma':
      return { MA: close.map((_, index) => index + 1 < parameters.period ? null
        : mean(close.slice(index + 1 - parameters.period, index + 1))) };
    case 'ema': {
      const weight = 2 / (parameters.period + 1);
      let ema = close[0]!;
      return { EMA: close.map((value, index) => index === 0 ? ema : (ema = weight * value + (1 - weight) * ema)) };
    }
    case 'rsi':
      return { RSI: relativeStrength(close, parameters.period) };
    case 'boll': {
      const mid: NumericSeries = [], upper: NumericSeries = [], lower: NumericSeries = [];
      const { period, std_dev } = parameters;
      for (const [index] of close.entries()) {
        if (index + 1 < period) {
          mid.push(null); upper.push(null); lower.push(null);
          continue;
        }
        const window = close.slice(index + 1 - period, index + 1);
        const center = mean(window), width = std_dev * deviation(window, center, period);
        mid.push(center); upper.push(center + width); lower.push(center - width);
      }
      return { BOLL_MID: mid, BOLL_UPPER: upper, BOLL_LOWER: lower };
    }
    case 'roc':
      return { ROC: returns(close, parameters.period, 'simple').map(value => value === null ? null : 100 * value) };
    case 'obv': {
      let balance = 0;
      return { OBV: source.map(({ volume, close }, index) => {
        if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0)
          return mismatch(`第 ${index + 1} 行缺少已核实的非负成交量。`);
        if (index > 0) balance += Math.sign(close - source[index - 1]!.close) * volume;
        return balance;
      }) };
    }
    case 'returns':
      return { RETURN: returns(close, parameters.period, parameters.mode) };
    case 'volatility': {
      const daily = returns(close, 1, 'simple');
      const { period, annualization_factor } = parameters;
      const scale = annualization_factor === undefined ? 1 : Math.sqrt(annualization_factor);
      return { VOLATILITY: daily.map((_, index) => {
        if (index < period) return null;
        const window = daily.slice(index + 1 - period, index + 1);
        if (window.some(value => value === null)) return null;
        const complete = window as number[];
        return scale * deviation(complete, mean(complete), period - 1);
      }) };
    }
    case 'max_drawdown': {
      const drawdown: NumericSeries = [], peaks: NumericSeries = [];
      const { period } = parameters;
      for (const [end, last] of close.entries()) {
        if (period !== undefined && end + 1 < period) {
          drawdown.push(null); peaks.push(null);
          continue;
        }
        const start = period === undefined ? 0 : end + 1 - period;
        let trough = last, peak = last, worst = 0;
        for (let index = end - 1; index >= start; index--) {
          const price = close[index]!;
          trough = Math.min(trough, price);
          peak = Math.max(peak, price);
          worst = Math.min(worst, trough / price - 1);
        }
        drawdown.push(worst); peaks.push(peak);
      }
      return { MAX_DRAWDOWN: drawdown, PEAK_CLOSE: peaks };
    }
    case 'alpha191_014':
      return { ALPHA191_014: close.map((value, index) => index < 5 ? null : value - close[index - 5]!) };
    case 'alpha191_031':
      return { ALPHA191_031: close.map((value, index) => {
        if (index < 11) return null;
        const window = close.slice(index - 11, index + 1), scale = Math.max(...window);
        if (scale === 0) return null;
        const scaled = window.map(price => price / scale), last = value / scale;
        // mean(last - price) = last - mean(price), evaluated entirely in the scaled window.
        return 100 * (mean(scaled.map(price => last - price)) / mean(scaled));
      }) };
    case 'alpha191_116':
      return { ALPHA191_116: close.map((_, index) => {
        if (index < 19) return null;
        const window = close.slice(index - 19, index + 1);
        // Opposite weights cancel before summation, including exactly symmetric prices.
        let slope = 0, correction = 0;
        for (let i = 0; i < 10; i++) {
          const pair = ((9.5 - i) / 665) * (window[19 - i]! - window[i]!);
          const term = pair - correction, next = slope + term;
          correction = (next - slope) - term;
          slope = next;
        }
        return slope;
      }) };
    case 'alpha191_168': {
      const volume = source.map((row, index) => {
        if (typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0)
          return mismatch(`第 ${index + 1} 行缺少已核实的非负成交量。`);
        return row.volume;
      });
      return { ALPHA191_168: volume.map((value, index) => {
        if (index < 19) return null;
        const window = volume.slice(index - 19, index + 1), scale = Math.max(...window);
        return scale === 0 ? null : -(value / scale) / mean(window.map(item => item / scale));
      }) };
    }
    case 'alpha191_189':
      return { ALPHA191_189: close.map((_, index) => {
        if (index < 10) return null;
        const deviations = Array.from({ length: 6 }, (_, offset) => {
          const end = index - offset;
          return Math.abs(close[end]! - nonnegativeMean(close.slice(end - 5, end + 1)));
        });
        return nonnegativeMean(deviations);
      }) };
  }
}

function mean(values: number[]): number {
  let sum = 0, correction = 0;
  for (const value of values) {
    const term = value / values.length - correction, next = sum + term;
    correction = (next - sum) - term;
    sum = next;
  }
  return sum;
}

function nonnegativeMean(values: number[]): number {
  const scale = Math.max(...values);
  return scale === 0 ? 0 : mean(values.map(value => value / scale)) * scale;
}

function deviation(values: number[], center: number, denominator: number): number {
  const divisor = Math.sqrt(denominator);
  return Math.hypot(...values.map(value => (value - center) / divisor));
}

function relativeStrength(close: number[], period: number): NumericSeries {
  // Keep the period sums unscaled so the first subnormal change survives initialization.
  const decay = 1 - 1 / period;
  let gains = 0, losses = 0;
  return close.map((value, index) => {
    if (index === 0) return null;
    const change = value - close[index - 1]!;
    if (index > period) {
      gains *= decay;
      losses *= decay;
    }
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
    const total = gains + losses;
    return index < period || total === 0 ? null : 100 * (gains / total);
  });
}

function returns(close: number[], lag: number, mode: 'simple' | 'log'): NumericSeries {
  return close.map((value, index) => {
    if (index < lag) return null;
    const previous = close[index - lag]!;
    if (mode === 'log') return previous > 0 && value > 0 ? Math.log(value) - Math.log(previous) : null;
    return previous === 0 ? null : (value - previous) / previous;
  });
}

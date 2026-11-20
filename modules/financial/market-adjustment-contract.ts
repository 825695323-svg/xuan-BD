import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import { add, compare, divide, formatExactDecimal, multiply, negative, readExactDecimal,
  type DecimalInput } from '../collection/numeric-precision.js';

export type MarketAdjustmentDirection = 'forward_qfq' | 'backward_hfq';

export interface UnadjustedDailyBar {
  date: string;
  open: DecimalInput;
  high: DecimalInput;
  low: DecimalInput;
  close: DecimalInput;
}

export type MarketCorporateAction = {
  id: string;
  effectiveDate: string;
  claimStatus: string;
  effectiveStatus: string;
  sourceRef?: string;
} & (
  | { kind: 'cash_dividend'; cashPerShare: DecimalInput }
  | { kind: 'stock_dividend' | 'capitalization'; sharesPerShare: DecimalInput }
  | { kind: 'split'; splitRatio: DecimalInput }
);

export interface MarketAdjustmentInput {
  adjustment: 'none';
  frequency: '1d';
  direction: MarketAdjustmentDirection;
  anchorDate: string;
  bars: readonly UnadjustedDailyBar[];
  actions: readonly MarketCorporateAction[];
}

const ONE = { n: 1n, d: 1n };
const ZERO = { n: 0n, d: 1n };
const validDate = (date: unknown): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date)
  && isExplicitUtcInstant(date + 'T00:00:00Z');

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code: 'MARKET_ADJUSTMENT_' + code });
}

/**
 * Single-listing raw daily OHLC. Cash and new shares are denominated per pre-event share.
 * A split ratio gives final shares per original share before adding same-day distributions.
 * QFQ uses the last supplied session as anchor, HFQ the first.
 */
export function computeAdjustedMarketSeries(input: MarketAdjustmentInput) {
  const { adjustment, frequency, direction, anchorDate } = input;
  if (direction !== 'forward_qfq' && direction !== 'backward_hfq') reject('DIRECTION', '须显式指定复权方向。');
  if (!validDate(anchorDate)) reject('ANCHOR', '须显式指定有效锚点日期。');
  if (adjustment !== 'none' || frequency !== '1d') reject('RAW_DAILY_REQUIRED', '复权只接收明确未复权的日线价格。');
  if (!Array.isArray(input.actions)) reject('ACTIONS_REQUIRED', '须提供明确的公司行动清单。');

  const ids = new Set<string>();
  const byDate = new Map<string, MarketCorporateAction[]>();
  for (const action of input.actions as readonly MarketCorporateAction[]) {
    if (action.claimStatus !== 'confirmed' || action.effectiveStatus !== 'effective') {
      reject('ACTION_NOT_EFFECTIVE', `公司行动 ${action.id} 须已确认且生效（${action.claimStatus}/${action.effectiveStatus}）。`);
    }
    if (typeof action.id !== 'string' || !action.id.trim() || ids.has(action.id) || !validDate(action.effectiveDate)) {
      reject('ACTION_IDENTITY', '公司行动须提供唯一标识及有效生效日期。');
    }
    ids.add(action.id);
    const events = byDate.get(action.effectiveDate) ?? [];
    events.push(action);
    byDate.set(action.effectiveDate, events);
  }

  if (!Array.isArray(input.bars) || !input.bars.length) reject('BARS_REQUIRED', '缺少原价日线。');
  const dates = new Set<string>();
  const bars = input.bars.map((raw: UnadjustedDailyBar) => {
    if (!validDate(raw.date) || dates.has(raw.date)) reject('BAR_DATE', '日线日期无效或重复。');
    dates.add(raw.date);
    const prices = {
      open: readExactDecimal(raw.open, 'open'), high: readExactDecimal(raw.high, 'high'),
      low: readExactDecimal(raw.low, 'low'), close: readExactDecimal(raw.close, 'close'),
    };
    if (prices.low.n <= 0n || [prices.open, prices.close].some(price =>
      compare(price, prices.low) < 0 || compare(price, prices.high) > 0)) {
      reject('BAR_PRICE', 'OHLC 须为正数且高低价须覆盖开盘与收盘。');
    }
    return { raw, prices };
  }).sort((a, b) => a.raw.date < b.raw.date ? -1 : 1);
  const firstDate = bars[0].raw.date, lastDate = bars[bars.length - 1].raw.date;
  const anchor = direction === 'forward_qfq' ? lastDate : firstDate;
  if (anchorDate !== anchor) reject('ANCHOR', '前复权锚点须为原价序列末日，后复权须为首日。');

  const positions = new Map(bars.map(({ raw }, index) => [raw.date, index]));
  const steps = new Map<string, typeof ONE>();
  const appliedActions = [];
  for (const date of [...byDate.keys()].sort()) {
    const events = byDate.get(date)!;
    let cash = ZERO, shares = ZERO, split = null;
    for (const event of events) {
      switch (event.kind) {
        case 'cash_dividend': {
          const amount = readExactDecimal(event.cashPerShare, 'cashPerShare');
          if (amount.n <= 0n) reject('ACTION_TERMS', '每股现金分红须为正数。');
          cash = add(cash, amount);
          break;
        }
        case 'stock_dividend':
        case 'capitalization': {
          const amount = readExactDecimal(event.sharesPerShare, 'sharesPerShare');
          if (amount.n <= 0n) reject('ACTION_TERMS', '每股送转股数须为正数。');
          shares = add(shares, amount);
          break;
        }
        case 'split':
          if (split) reject('ACTION_TERMS', '同一生效日须提供统一拆股比例。');
          split = readExactDecimal(event.splitRatio, 'splitRatio');
          if (split.n <= 0n) reject('ACTION_TERMS', '拆股比例须为正数。');
          break;
        default:
          reject('ACTION_TERMS', '公司行动类型未登记。');
      }
    }
    if (date <= firstDate || date > lastDate) continue;
    // Interior events need an observed effective-date bar and the preceding raw close.
    const index = positions.get(date);
    if (index === undefined) reject('ACTION_BAR_MISSING', '生效日缺原价日线 ' + date);
    const previous = bars[index - 1];
    const afterCash = add(previous.prices.close, negative(cash));
    if (afterCash.n <= 0n) reject('ACTION_TERMS', '现金分红须小于生效前原价收盘。');
    const step = divide(afterCash, multiply(previous.prices.close, add(split ?? ONE, shares)));
    steps.set(date, step);
    appliedActions.push({ effectiveDate: date, previousDate: previous.raw.date, previousClose: previous.raw.close,
      stepFactor: formatExactDecimal(step), events: events.map(event => ({ ...event })) });
  }

  let cumulative = ONE;
  const factors = bars.map(({ raw }) => {
    const step = steps.get(raw.date);
    if (step) cumulative = divide(cumulative, step);
    return cumulative;
  });
  const anchorFactor = direction === 'forward_qfq' ? factors[factors.length - 1] : ONE;
  const rows = bars.map(({ raw, prices }, index) => {
    const factor = divide(factors[index], anchorFactor);
    return { ...raw, adj_factor: formatExactDecimal(factor), adjusted: {
      open: formatExactDecimal(multiply(prices.open, factor)),
      high: formatExactDecimal(multiply(prices.high, factor)),
      low: formatExactDecimal(multiply(prices.low, factor)),
      close: formatExactDecimal(multiply(prices.close, factor)),
    } };
  });
  return { rows, lineage: { adjustment, frequency, direction, anchorDate, method: 'theoretical_ex_price_ratio', appliedActions } };
}

import { createHash } from 'node:crypto';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { SourceAssetScope, SourceDataCapability, SourceOperationId } from '../../contracts/source-settings.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';

export type PublicKlineProviderId = 'eastmoney' | 'sina' | 'tencent';
export type PublicKlineOperationId = Extract<SourceOperationId, 'minute_bars' | 'daily_bars'>;
export type PublicDailyProviderId = 'tencent' | 'eastmoney';
export interface PublicDailyRequest { symbol: string; start: string; end: string; adjustment: 'none'; limit?: number }
export interface PublicDailyBar {
  symbol: string; trade_date: string; open: string; high: string; low: string; close: string;
  /** 保留供应商原值；本解码器不声明手、股或倍率。 */
  volume?: string; amount?: string;
}
export interface DecodedPublicDailyBars {
  decoderVersion: 'public-unadjusted-daily/1'; providerId: PublicDailyProviderId; symbol: string; adjustment: 'none';
  requestedStart: string; requestedEnd: string; actualStart: string | null; actualEnd: string | null;
  recordCount: number; rawSha256: string; rows: PublicDailyBar[];
  volumeUnit: 'native_unverified'; amountUnit: 'native_unverified';
}

export interface PublicKlineOperation {
  id: PublicKlineOperationId;
  label: string;
  dataCapability: SourceDataCapability;
  assetScope: SourceAssetScope;
}

export interface PublicKlineProvider {
  id: PublicKlineProviderId;
  title: string;
  alias: string;
  shortLabel: string;
  upstream: string;
  applicationUrl: string;
  baseUrl: string;
  operations: PublicKlineOperation[];
  buildUrl(operation: PublicKlineOperationId, parameters: Record<string, JsonValue>): URL;
  headers?: Record<string, string>;
}

const symbolOf = (value: JsonValue): { code: string; market: 'SH' | 'SZ' } => {
  if (typeof value !== 'string') throw new DirectError('SOURCE_PARAMETERS_INVALID', '请提供完整的A股代码，例如 600519.SH。');
  const match = /^(\d{6})\.(SH|SZ)$/u.exec(value);
  if (!match) throw new DirectError('SOURCE_PARAMETERS_INVALID', '请提供完整的A股代码，例如 600519.SH。');
  return { code: match[1]!, market: match[2] as 'SH' | 'SZ' };
};
const limitOf = (value: JsonValue, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new DirectError('SOURCE_PARAMETERS_INVALID', `条数需要是1至${max}的整数。`);
  return Number(value);
};
const dateOf = (value: JsonValue): string => {
  if (typeof value !== 'string' || !/^\d{8}$/u.test(value)) throw new DirectError('SOURCE_PARAMETERS_INVALID', '日期需要是YYYYMMDD格式。');
  return value;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function dailyFailure(message: string): never { throw new DirectError('SOURCE_DAILY_RESPONSE_INVALID', message); }
function dailyDate(value: unknown): string {
  if (typeof value !== 'string') throw new DirectError('SOURCE_PARAMETERS_INVALID', '日线日期需要YYYY-MM-DD或YYYYMMDD格式。');
  const day = /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
    throw new DirectError('SOURCE_PARAMETERS_INVALID', '日线日期必须是有效自然日。');
  }
  return day;
}
/** 只在显式不复权请求中使用；未提供adjustment的既有请求保持原行为。 */
export function normalizePublicDailyRequest(parameters: Record<string, JsonValue>): Required<PublicDailyRequest> {
  if (parameters.adjustment !== 'none' || Object.keys(parameters).some(key => !['symbol', 'start', 'end', 'adjustment', 'limit'].includes(key))) {
    throw new DirectError('SOURCE_PARAMETERS_INVALID', '受控日线只接受明确证券、起止日期、条数和adjustment:none（不复权）。');
  }
  symbolOf(parameters.symbol);
  const start = dailyDate(parameters.start), end = dailyDate(parameters.end), limit = limitOf(parameters.limit ?? 320, 320);
  if (start > end) throw new DirectError('SOURCE_PARAMETERS_INVALID', '日线结束日期不能早于开始日期。');
  return { symbol: String(parameters.symbol), start, end, adjustment: 'none', limit };
}

const eastmoney: PublicKlineProvider = {
  id: 'eastmoney', title: '东方财富公开行情', alias: '东方财富 · 公开行情', shortLabel: '东方财富', upstream: 'push2his.eastmoney.com', applicationUrl: 'https://quote.eastmoney.com/',
  baseUrl: 'https://push2his.eastmoney.com',
  operations: [
    { id: 'minute_bars', label: '1分钟K线', dataCapability: 'history', assetScope: 'equity' },
    { id: 'daily_bars', label: '日线行情', dataCapability: 'history', assetScope: 'equity' },
  ],
  buildUrl(operation, parameters) {
    const controlled = parameters.adjustment === undefined ? null : normalizePublicDailyRequest(parameters);
    if (controlled && operation !== 'daily_bars') throw new DirectError('SOURCE_PARAMETERS_INVALID', '显式不复权受控请求目前只支持日线。');
    const symbol = symbolOf(parameters.symbol), start = controlled ? controlled.start.replaceAll('-', '') : dateOf(parameters.start),
      end = controlled ? controlled.end.replaceAll('-', '') : dateOf(parameters.end), limit = controlled ? controlled.limit : limitOf(parameters.limit, 1000);
    const url = new URL('/api/qt/stock/kline/get', this.baseUrl);
    const fields = { secid: `${symbol.market === 'SH' ? '1' : '0'}.${symbol.code}`, klt: operation === 'minute_bars' ? '1' : '101', fqt: '0',
      beg: start, end, lmt: String(limit), fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' };
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    return url;
  },
};

const sina: PublicKlineProvider = {
  id: 'sina', title: '新浪财经公开行情', alias: '新浪财经 · 公开行情', shortLabel: '新浪财经', upstream: 'quotes.sina.cn', applicationUrl: 'https://finance.sina.com.cn/',
  baseUrl: 'https://quotes.sina.cn',
  operations: [{ id: 'daily_bars', label: '日线行情', dataCapability: 'history', assetScope: 'equity' }],
  headers: { Referer: 'https://finance.sina.com.cn/' },
  buildUrl(_operation, parameters) {
    if (parameters.adjustment !== undefined) throw new DirectError('SOURCE_KIND_UNSUPPORTED', '新浪未登记受控不复权日线契约，不能作为同口径备用。');
    const symbol = symbolOf(parameters.symbol), limit = limitOf(parameters.limit, 1023);
    const url = new URL('/cn/api/json_v2.php/CN_MarketDataService.getKLineData', this.baseUrl);
    for (const [key, value] of Object.entries({ symbol: `${symbol.market.toLowerCase()}${symbol.code}`, scale: '240', ma: 'no', datalen: String(limit) })) url.searchParams.set(key, value);
    return url;
  },
};

const tencent: PublicKlineProvider = {
  id: 'tencent', title: '腾讯财经公开行情', alias: '腾讯财经 · 公开行情', shortLabel: '腾讯财经', upstream: 'web.ifzq.gtimg.cn', applicationUrl: 'https://gu.qq.com/',
  baseUrl: 'https://web.ifzq.gtimg.cn',
  operations: [{ id: 'daily_bars', label: '日线行情', dataCapability: 'history', assetScope: 'equity' }],
  buildUrl(_operation, parameters) {
    const controlled = parameters.adjustment === undefined ? null : normalizePublicDailyRequest(parameters);
    const symbol = symbolOf(parameters.symbol), limit = controlled ? controlled.limit : limitOf(parameters.limit, 320);
    const url = new URL('/appstock/app/fqkline/get', this.baseUrl);
    url.searchParams.set('param', controlled
      ? `${symbol.market.toLowerCase()}${symbol.code},day,${controlled.start},${controlled.end},${limit},`
      : `${symbol.market.toLowerCase()}${symbol.code},day,,,${limit},qfq`);
    return url;
  },
};

export const publicKlineProviders: readonly PublicKlineProvider[] = Object.freeze([eastmoney, sina, tencent]);
export const publicKlineProviderIds = publicKlineProviders.map(provider => provider.id);
export function publicKlineProvider(id: string): PublicKlineProvider | undefined {
  return publicKlineProviders.find(provider => provider.id === id);
}

/** 解码已保管的显式不复权请求原件；调用方须核对回执URL、原请求及原件摘要。无历史可得性或入库资格推定。 */
export function decodePublicDailyBars(providerId: PublicDailyProviderId, request: PublicDailyRequest, rawBytes: Uint8Array): DecodedPublicDailyBars {
  const bound = normalizePublicDailyRequest({ ...request }), symbol = symbolOf(bound.symbol);
  if (rawBytes.byteLength > 2 * 1024 * 1024) dailyFailure('日线原件超过2MiB解码预算。');
  let response: unknown;
  try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)); }
  catch { dailyFailure('日线原件不是完整UTF-8 JSON（结构化文本），未修补或猜测响应。'); }
  if (!object(response)) dailyFailure('日线响应必须是供应商业务对象。');
  const decimal = (value: unknown, price = false): string => {
    if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
      || price && !/[1-9]/u.test(value)) dailyFailure('日线价格和原生成交值必须保留非负十进制字符串；价格须为正。');
    return value;
  };
  const rows: PublicDailyBar[] = [];
  if (providerId === 'tencent') {
    const key = `${symbol.market.toLowerCase()}${symbol.code}`;
    if (response.code !== 0 || !object(response.data) || Object.keys(response.data).length !== 1 || !object(response.data[key])) {
      dailyFailure('腾讯日线业务状态或唯一证券身份不符，未接受混合证券或错误响应。');
    }
    const series = response.data[key];
    if (Object.hasOwn(series, 'qfqday') || Object.hasOwn(series, 'hfqday') || !Array.isArray(series.day)) {
      dailyFailure('腾讯日线须为day（不复权日线）分支，不能采用前复权、后复权或未知分支。');
    }
    for (const row of series.day) {
      if (!Array.isArray(row) || row.length < 6) dailyFailure('腾讯日线原生字段不完整。');
      rows.push({ symbol: bound.symbol, trade_date: String(row[0]), open: decimal(row[1], true), close: decimal(row[2], true),
        high: decimal(row[3], true), low: decimal(row[4], true), volume: decimal(row[5]) });
    }
  } else if (providerId === 'eastmoney') {
    if (response.rc !== 0 || !object(response.data) || response.data.code !== symbol.code || response.data.market !== (symbol.market === 'SH' ? 1 : 0)
      || !Array.isArray(response.data.klines) || response.data.fqt !== undefined && response.data.fqt !== 0) {
      dailyFailure('东方财富日线业务状态、证券市场或已声明复权口径不符。');
    }
    for (const line of response.data.klines) {
      if (typeof line !== 'string') dailyFailure('东方财富日线必须保留原生记录字符串。');
      const row = line.split(',');
      if (row.length < 7) dailyFailure('东方财富日线原生字段不完整。');
      rows.push({ symbol: bound.symbol, trade_date: row[0]!, open: decimal(row[1], true), close: decimal(row[2], true),
        high: decimal(row[3], true), low: decimal(row[4], true), volume: decimal(row[5]), amount: decimal(row[6]) });
    }
  } else dailyFailure('此供应商未登记受控不复权日线解码器。');
  if (rows.length > bound.limit) dailyFailure('日线实际记录数超过明确条数预算。');
  let previous = '';
  for (const row of rows) {
    let day: string;
    try { day = dailyDate(row.trade_date); } catch { dailyFailure('日线含无效业务日期。'); }
    if (day !== row.trade_date || day < bound.start || day > bound.end || day <= previous) {
      dailyFailure('日线含越窗、重复或逆序日期，未截断、排序或静默去重。');
    }
    previous = day;
    const scale = Math.max(...[row.open, row.high, row.low, row.close].map(value => value.split('.')[1]?.length ?? 0));
    const integer = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole! + fraction.padEnd(scale, '0')); };
    if (integer(row.high) < integer(row.low) || [row.open, row.close].some(value => integer(value) < integer(row.low) || integer(value) > integer(row.high))) {
      dailyFailure('日线开收盘与最高最低价关系不符。');
    }
  }
  return { decoderVersion: 'public-unadjusted-daily/1', providerId, symbol: bound.symbol, adjustment: 'none',
    requestedStart: bound.start, requestedEnd: bound.end, actualStart: rows[0]?.trade_date ?? null, actualEnd: rows.at(-1)?.trade_date ?? null,
    recordCount: rows.length, rawSha256: createHash('sha256').update(rawBytes).digest('hex'), rows,
    volumeUnit: 'native_unverified', amountUnit: 'native_unverified' };
}

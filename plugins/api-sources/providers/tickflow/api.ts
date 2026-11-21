import { createHash } from 'node:crypto';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { parseSourceJson, sourceNumberRoundTrips } from '../../source-acquisition.js';
import { DirectError } from '../../../../platform/runtime/file-workspace.js';

/** 按公开接口协议实现，未复制参考项目的客户端、缓存或调度代码。 */
export const tickflowReference = Object.freeze({
  project: 'https://github.com/henrylin99/quantitative_analysis',
  commit: '2edbc3eaf799f4d8f42c99fccba3b8fc08554f10',
  path: 'app/utils/data_sources/tickflow_client.py',
  official: 'https://github.com/tickflow-org/tickflow/blob/main/tickflow/resources/klines.py',
  service: 'https://tickflow.org/',
});

export interface TickflowDailyRequest {
  symbol: string; start: string; end: string; adjustment: 'none'; limit: number;
}
const numericFields = ['open', 'high', 'low', 'close', 'volume', 'amount'] as const;
type NumericField = typeof numericFields[number];
export interface TickflowDailyBar {
  symbol: string; trade_date: string; timestamp: number;
  open: number | null; high: number | null; low: number | null; close: number | null;
  volume: number | null; amount: number | null;
  rawText: Record<NumericField, string | null>;
}
const BASE_URL = 'https://free-api.tickflow.org';
const fail = (message: string): never => { throw new DirectError('SOURCE_PARAMETERS_INVALID', message); };
const invalid = (message: string): never => { throw new DirectError('SOURCE_DAILY_RESPONSE_INVALID', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function dateOf(value: unknown): string {
  if (typeof value !== 'string') return fail('TickFlow 日线须提供起止自然日。');
  const day = /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
    return fail('TickFlow 日期必须是有效的 YYYY-MM-DD 或 YYYYMMDD 自然日。');
  return day;
}

const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', calendar: 'iso8601', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
});

function shanghaiDateNumber(instant: number): number {
  const parts = Object.fromEntries(shanghaiDay.formatToParts(instant).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return year * 10000 + Number(parts.month) * 100 + Number(parts.day);
}

/** 找到该交易地自然日的边界；历史夏令时转换日也不能假设一天恒为 24 小时。 */
function shanghaiBoundary(day: string, end: boolean): number {
  const utc = Date.parse(day), target = Number(day.replaceAll('-', ''));
  let low = utc - 86400000, high = utc + 86400000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const local = shanghaiDateNumber(mid);
    if (local < target || end && local === target) low = mid + 1;
    else high = mid;
  }
  return end ? low - 1 : low;
}

/** 行情动作在参数校验、构造 URL 和已有原件解码时使用同一条数预算。 */
export function publicDailyLimit(value: JsonValue | undefined, maximum = 10_000): number {
  const limit = value === undefined ? 320 : value;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maximum)
    return fail(`日线 limit 必须为 1 至 ${maximum} 的整数。`);
  return Number(limit);
}
export function normalizeTickflowDailyRequest(parameters: Record<string, JsonValue>): TickflowDailyRequest {
  if (Object.keys(parameters).some(key => !['symbol', 'start', 'end', 'adjustment', 'limit'].includes(key))
    || typeof parameters.symbol !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/u.test(parameters.symbol)
    || parameters.adjustment !== 'none') return fail('TickFlow 仅接受明确沪深京证券、日期窗、条数及 adjustment:none（不复权）。');
  const limit = publicDailyLimit(parameters.limit);
  const start = dateOf(parameters.start), end = dateOf(parameters.end);
  if (start > end) return fail('TickFlow 日线日期窗逆序。');
  return { symbol: parameters.symbol, start, end, adjustment: 'none', limit };
}

/** 无 I/O；免费历史日线请求不读取凭证、不探测套餐，也不隐式请求标的名称。 */
export function buildTickflowDailyRequest(parameters: Record<string, JsonValue>) {
  const request = normalizeTickflowDailyRequest(parameters);
  const url = new URL('/v1/klines', BASE_URL);
  for (const [key, value] of Object.entries({ symbol: request.symbol, period: '1d', adjust: 'none', count: String(request.limit),
    start_time: String(shanghaiBoundary(request.start, false)),
    end_time: String(shanghaiBoundary(request.end, true)) })) url.searchParams.set(key, value);
  return { url, method: 'GET' as const, headers: { Accept: 'application/json' }, request };
}

/** 解码调用方已保管的响应；原件摘要随结果返回，不声明覆盖完整或历史当时可得。 */
export function decodeTickflowDailyBars(request: TickflowDailyRequest, rawBytes: Uint8Array) {
  const bound = normalizeTickflowDailyRequest({ ...request });
  if (rawBytes.byteLength > 2 * 1024 * 1024) return invalid('TickFlow 日线原件超过本适配器的 2MiB 解码预算。');
  let payload: unknown;
  const lexemes = new WeakMap<unknown[], string[]>();
  try {
    payload = parseSourceJson(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes), (parent, key, value, raw) => {
      if (Array.isArray(parent)) {
        const column = lexemes.get(parent) ?? [];
        column[Number(key)] = raw;
        lexemes.set(parent, column);
      }
      return key === 'code' && !sourceNumberRoundTrips(value, raw) ? null : value;
    });
  } catch { return invalid('TickFlow 响应不是完整 UTF-8 JSON。'); }
  if (!object(payload) || !object(payload.data) || payload.success === false
    || payload.code !== undefined && payload.code !== 0 && payload.code !== '0') return invalid('TickFlow 未返回成功的数据对象。');
  const data = payload.data;
  for (const [field, expected] of [['symbol', bound.symbol], ['period', '1d'], ['adjust', 'none'], ['adjustment', 'none']] as const)
    if (data[field] !== undefined && data[field] !== expected) return invalid(`TickFlow 返回的 ${field} 与显式请求不符。`);
  if (!Array.isArray(data.timestamp) || data.timestamp.length > bound.limit) return invalid('TickFlow 时间列缺失或超过显式条数预算。');
  const count = data.timestamp.length;
  for (const field of ['open', 'high', 'low', 'close', 'volume'])
    if (!Array.isArray(data[field]) || data[field].length !== count) return invalid(`TickFlow ${field} 列缺失或列长不一致。`);
  if (data.amount !== undefined && (!Array.isArray(data.amount) || data.amount.length !== count))
    return invalid('TickFlow amount 列长不一致；不补齐或截断。');
  const numberText = (field: string, index: number): string | null => {
    const column = data[field] as unknown[] | undefined;
    if (column === undefined || column[index] === null) return null;
    const value = column[index], raw = lexemes.get(column)?.[index];
    if (typeof value !== 'number' || raw === undefined || field !== 'timestamp' && value < 0 || !sourceNumberRoundTrips(value, raw))
      return invalid(`TickFlow ${field} 的数值类型、范围或十进制往返精度不符。`);
    return raw;
  };
  const rows: TickflowDailyBar[] = [];
  const start = Number(bound.start.replaceAll('-', '')), end = Number(bound.end.replaceAll('-', ''));
  let previous = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const timestamp: unknown = data.timestamp[index];
    numberText('timestamp', index);
    if (!Number.isSafeInteger(timestamp)) return invalid('TickFlow 时间戳必须是毫秒整数。');
    const instant = new Date(Number(timestamp));
    if (!Number.isFinite(instant.getTime())) return invalid('TickFlow 时间戳超出可表示范围。');
    const localDate = shanghaiDateNumber(instant.getTime());
    if (localDate < start || localDate > end || localDate <= previous) return invalid('TickFlow 日线包含越窗、重复或逆序日期；未排序、去重或删除。');
    previous = localDate;
    const digits = String(localDate).padStart(8, '0');
    const day = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
    const rawText = Object.fromEntries(numericFields.map(field => [field, numberText(field, index)])) as TickflowDailyBar['rawText'];
    const numeric = (key: NumericField) => rawText[key] === null ? null : Number(rawText[key]);
    const row: TickflowDailyBar = { symbol: bound.symbol, trade_date: day, timestamp: Number(timestamp), rawText,
      open: numeric('open'), high: numeric('high'), low: numeric('low'), close: numeric('close'),
      volume: numeric('volume'), amount: numeric('amount') };
    if (row.high !== null && row.low !== null && (row.high < row.low
      || [row.open, row.close].some(value => value !== null && (value < row.low! || value > row.high!))))
      return invalid('TickFlow 日线开收盘与最高最低价关系不符。');
    rows.push(row);
  }
  return { decoderVersion: 'tickflow-unadjusted-daily/1' as const, providerId: 'tickflow' as const,
    symbol: bound.symbol, adjustment: 'none' as const, requestedStart: bound.start, requestedEnd: bound.end,
    actualStart: rows[0]?.trade_date ?? null, actualEnd: rows.at(-1)?.trade_date ?? null, recordCount: rows.length, rows,
    rawSha256: createHash('sha256').update(rawBytes).digest('hex'), timestampUnit: 'epoch_milliseconds' as const,
    identityProvenance: { symbol: data.symbol === undefined ? 'request' : 'response',
      period: data.period === undefined ? 'request' : 'response',
      adjustment: data.adjust === undefined && data.adjustment === undefined ? 'request' : 'response' },
    tradeDateTimezone: 'Asia/Shanghai' as const, volumeUnit: 'native_unverified' as const, amountUnit: 'native_unverified' as const,
    coverageState: 'not_established' as const, historyAvailability: 'not_established' as const,
    limitReached: count === bound.limit, continuation: 'not_declared' as const };
}

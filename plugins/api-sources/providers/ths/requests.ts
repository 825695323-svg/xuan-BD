import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { DirectError } from '../../../../platform/runtime/file-workspace.js';
import { thsSource } from './api.js';

// 协议参考 quantitative_analysis@2edbc3eaf799f4d8f42c99fccba3b8fc08554f10
// app/utils/data_sources/fuyao_client.py；仅适配端点协议，不迁移上游存储、环境变量或调度代码。
const financialEndpoints = { income: 'income-statements', balance_sheet: 'balance-sheets', cash_flow: 'cash-flow-statements' } as const;
function invalid(message: string): never { throw new DirectError('SOURCE_PARAMETERS_INVALID', message); }
const record = (value: unknown): value is Record<string, JsonValue> => !!value && typeof value === 'object' && !Array.isArray(value);

export function buildThsRequest(base: string, operation: string, parameters: Record<string, JsonValue>): URL {
  if (base !== thsSource.apiBaseUrl) invalid('同花顺连接必须使用已登记的服务地址。');
  const allowed = operation === 'index_constituents' ? ['thscode']
    : operation === 'daily_bars' ? ['thscode', 'start', 'end']
      : operation === 'financial_statements' ? ['thscode', 'statement', 'period', 'limit'] : [];
  if (!allowed.length || Object.keys(parameters).some(key => !allowed.includes(key)))
    invalid('接口参数包含当前动作未定义的字段；凭据只从连接安全引用取得。');
  const symbol = parameters.thscode;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{4,12}\.(?:SH|SZ|TI|BJ)$/u.test(symbol))
    invalid('请提供完整证券或指数代码。');
  let path: string;
  if (operation === 'financial_statements') {
    if (!/^\d{6}\.(SH|SZ|BJ)$/u.test(symbol)) invalid('财报目前只接受沪深京完整股票代码。');
    if (typeof parameters.statement !== 'string' || !Object.hasOwn(financialEndpoints, parameters.statement))
      invalid('statement 必须为 income、balance_sheet 或 cash_flow。');
    if (parameters.period !== 'quarterly') invalid('首版财报接入要求显式 period:quarterly，报告累计口径保留为来源原值。');
    if (!Number.isSafeInteger(parameters.limit) || Number(parameters.limit) < 1 || Number(parameters.limit) > 20)
      invalid('本次财报读取需明确 1–20 条记录预算。');
    path = `/api/a-share/financials/${financialEndpoints[parameters.statement as keyof typeof financialEndpoints]}`;
  } else path = operation === 'index_constituents' ? '/api/a-share-index/constituents/ths-stock-list' : '/api/a-share/prices/historical';
  const url = new URL(path, base);
  url.searchParams.set('thscode', symbol);
  if (operation === 'daily_bars') {
    if (!Number.isSafeInteger(parameters.start) || !Number.isSafeInteger(parameters.end)
      || Number(parameters.start) <= 0 || Number(parameters.end) < Number(parameters.start))
      invalid('日线需要明确的起止毫秒时间戳。');
    for (const [key, value] of Object.entries({ interval: '1d', start: String(parameters.start), end: String(parameters.end), adjust: 'none' }))
      url.searchParams.set(key, value);
  } else if (operation === 'financial_statements') {
    url.searchParams.set('period', String(parameters.period)); url.searchParams.set('limit', String(parameters.limit));
  }
  return url;
}

export function decodeThsResponse(bytes: Uint8Array): Record<string, JsonValue> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DirectError('SOURCE_RESPONSE_INVALID', '来源响应不是完整 UTF-8 JSON，原件应保留。'); }
  if (!record(value)) throw new DirectError('SOURCE_RESPONSE_INVALID', '来源响应必须是业务对象。');
  if (value.code === 4001) throw new DirectError('SOURCE_RATE_LIMITED', '来源返回 code 4001 限流；不自动重试或切换同账号别名。');
  if (value.code !== 0) throw new DirectError('SOURCE_BUSINESS_ERROR', `来源业务状态 code ${String(value.code ?? 'unknown')}，未当作成功数据。`);
  return value;
}

export function projectThsFinancials(parameters: Record<string, JsonValue>, bytes: Uint8Array) {
  buildThsRequest(thsSource.apiBaseUrl, 'financial_statements', parameters);
  const response = decodeThsResponse(bytes);
  if (!record(response.data) || !Array.isArray(response.data.item) || response.data.item.length > Number(parameters.limit)
    || response.data.item.some(row => !record(row) || row.thscode !== undefined && row.thscode !== parameters.thscode))
    throw new DirectError('SOURCE_FINANCIAL_RESPONSE_INVALID', '财报原始记录、标的或记录预算不符；未把缺失 item 当成空表。');
  return { decoderVersion: 'ths-financial-native/1', providerId: 'ths', statement: parameters.statement,
    symbol: parameters.thscode, period: parameters.period, recordCount: response.data.item.length,
    rows: response.data.item, timestampPolicy: 'retain_source_values_and_precision',
    periodSemantics: 'source_reported_not_single_quarter_or_ttm',
    historicalAvailability: 'not_established', coverageState: 'not_established' };
}

import { isFinancialStatement, type FinancialStatement } from '../../../../contracts/source-acquisition.js';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { DirectError } from '../../../../platform/runtime/file-workspace.js';
import { parseSourceJson, sourceNumberRoundTrips } from '../../source-acquisition.js';
import { thsApi, thsSource } from './api.js';

// 协议参考 quantitative_analysis@2edbc3eaf799f4d8f42c99fccba3b8fc08554f10
// app/utils/data_sources/fuyao_client.py；仅适配端点协议，不迁移上游存储、环境变量或调度代码。
const financialEndpoints = { income: 'income-statements', balance_sheet: 'balance-sheets', cash_flow: 'cash-flow-statements' } as const satisfies Record<FinancialStatement, string>;
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
    if (!isFinancialStatement(parameters.statement))
      invalid('statement 必须为 income、balance_sheet 或 cash_flow。');
    if (parameters.period !== 'quarterly') invalid('首版财报接入要求显式 period:quarterly，报告累计口径保留为来源原值。');
    if (!Number.isSafeInteger(parameters.limit) || Number(parameters.limit) < 1 || Number(parameters.limit) > 20)
      invalid('本次财报读取需明确 1–20 条记录预算。');
    path = `/api/a-share/financials/${financialEndpoints[parameters.statement]}`;
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

/** 财报投影把数值词素转为文本，包括嵌套字段。业务码始终按外层对象的原始数值类型核对。 */
export function decodeThsResponse(bytes: Uint8Array | string, financial = false): Record<string, JsonValue> {
  let value: unknown;
  const codes = new WeakMap<object, number>();
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = parseSourceJson(text, (parent, key, value, raw) => {
      if (key === 'code' && Number.isSafeInteger(value) && sourceNumberRoundTrips(value, raw)) codes.set(parent, value);
      return financial ? raw : value;
    });
  } catch { throw new DirectError('SOURCE_RESPONSE_INVALID', '来源响应不是完整的 JSON。'); }
  if (!record(value)) throw new DirectError('SOURCE_RESPONSE_INVALID', '来源响应必须是业务对象。');
  const code = codes.get(value);
  switch (code) {
    case thsApi.successCode: value.code = 0; return value;
    case thsApi.rateLimitedCode: throw new DirectError('SOURCE_RATE_LIMITED', '来源返回 code 4001 限流，本次任务停止。');
    case thsApi.unauthenticatedCode: throw new DirectError('SOURCE_UNAUTHORIZED', '来源返回 code 2001，凭据认证失败。');
    case thsApi.permissionDeniedCode: throw new DirectError('SOURCE_FORBIDDEN', '来源返回 code 2003，账号缺少所需权限。');
    default: throw new DirectError('SOURCE_BUSINESS_ERROR', '来源业务状态 code unknown，未当作成功数据。');
  }
}

const reportKeys = new Set(['report_date', 'report_date_ms', 'report_period', 'period_end', 'period_end_ms', 'fiscal_period',
  'end_date', 'reportDate', 'reportPeriod', 'report_date_ts', 'reportDateMs', 'periodEnd', 'periodEndMs', '报告期', '报告日期']);
const financialFields = {
  income: ['operating_income', 'operating_revenue', 'total_revenue', 'net_profit', 'netProfit', 'revenue', 'operatingIncome', '营业收入', '净利润'],
  balance_sheet: ['total_assets', 'total_liabilities', 'total_equity', 'totalAssets', 'totalLiabilities', '资产总计', '负债合计'],
  cash_flow: ['operating_cash_flow', 'net_cash_flow', 'net_cash_from_operating_activities', 'operatingCashFlow', '经营活动产生的现金流量净额'],
} as const;

export function projectThsFinancials(parameters: Record<string, JsonValue>, bytes: Uint8Array) {
  buildThsRequest(thsSource.apiBaseUrl, 'financial_statements', parameters);
  const response = decodeThsResponse(bytes, true);
  const fields = new Set<string>(financialFields[parameters.statement as keyof typeof financialFields]);
  if (!record(response.data) || !Array.isArray(response.data.item) || response.data.item.length > Number(parameters.limit)
    || response.data.item.some(row => !record(row) || row.thscode !== undefined && row.thscode !== parameters.thscode
      || !Object.entries(row).some(([key, value]) => (reportKeys.has(key) || fields.has(key))
        && typeof value === 'string' && value.trim().length > 0)))
    throw new DirectError('SOURCE_FINANCIAL_RESPONSE_INVALID', '财报记录缺少可识别的报表期间或财务字段，或标的、条数与请求不符。');
  return { decoderVersion: 'ths-financial-native/2', providerId: 'ths', statement: parameters.statement,
    symbol: parameters.thscode, period: parameters.period, recordCount: response.data.item.length,
    rows: response.data.item, numericEncoding: 'source_decimal_text', timestampPolicy: 'retain_source_values_and_precision',
    periodSemantics: 'source_reported_not_single_quarter_or_ttm',
    historicalAvailability: 'not_established', coverageState: 'not_established' };
}

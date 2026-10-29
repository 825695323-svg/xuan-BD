import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError } from '../../../platform/runtime/file-workspace.js';

/** 东方财富网页使用的只读分钟端点；属于站点采集，不登记为独立API产品。 */
export function eastmoneyMinuteRequest(parameters: Record<string, JsonValue>): URL {
  const { symbol, start, end } = parameters;
  if (typeof symbol !== 'string' || !/^\d{6}\.(SH|SZ)$/u.test(symbol)
    || typeof start !== 'string' || !/^\d{8}$/u.test(start) || typeof end !== 'string' || !/^\d{8}$/u.test(end) || end < start) {
    throw new DirectError('SOURCE_PARAMETERS_INVALID', '分钟采集需要明确的六位A股代码（含.SH或.SZ）和YYYYMMDD起止日期。');
  }
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  const fields = { secid: `${symbol.endsWith('.SH') ? '1' : '0'}.${symbol.slice(0, 6)}`, klt: '1', fqt: '0', beg: start, end,
    lmt: '1000', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' };
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  return url;
}

import { createHash } from 'node:crypto';
import type { AcquisitionBinding, AcquisitionOriginal, AcquisitionPage, AcquisitionRequest } from '../../contracts/source-acquisition.js';
import { parseEndpointSource, readEndpointAdapterConfig, type EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';
import { sourceFailureDisposition } from './source-acquisition.js';

export type OfficialJsonProvider = 'hkma' | 'treasury';
export interface OfficialPageSelection { provider: OfficialJsonProvider; start: string; end: string; pageSize: number; page: number }
const roots = {
  hkma: 'https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily',
  treasury: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange',
} as const;
export const OFFICIAL_PUBLIC_DOCUMENTATION = {
  hkma: 'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily/',
  treasury: 'https://fiscaldata.treasury.gov/api-documentation/',
  worldbank: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation',
  ecb: 'https://data.ecb.europa.eu/help/api/data-examples',
} as const;
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'OFFICIAL_RESPONSE_INVALID' }); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('官方响应不是声明的对象。');
  return value as Record<string, unknown>;
};
const day = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    return fail('日期必须为有效自然日；不猜测时区或披露时间。');
  return value;
};
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail('分页元数据不是非负整数。');
  return value as number;
};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const urlIdentity = (value: string) => { const url = new URL(value); url.searchParams.sort(); return url.href; };

/** 构造固定官方端点的一页请求；不发送网络、不注册账号、不选择加工模块。 */
export function officialPageRequest(input: OfficialPageSelection) {
  if (!Object.hasOwn(roots, input.provider) || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 100
    || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) return fail('官方来源或本任务页预算无效。');
  const start = day(input.start), end = day(input.end);
  if (start > end) return fail('起止日期逆序。');
  const url = new URL(roots[input.provider]);
  const offset = (input.page - 1) * input.pageSize;
  const fields = input.provider === 'hkma' ? ['end_of_day', 'usd', 'cny', 'eur']
    : ['record_date', 'country_currency_desc', 'exchange_rate', 'effective_date'];
  if (input.provider === 'hkma') {
    for (const [key, value] of Object.entries({ choose: 'end_of_day', from: start, to: end,
      pagesize: String(input.pageSize), offset: String(offset), sortby: 'end_of_day', sortorder: 'asc', fields: fields.join(',') }))
      url.searchParams.set(key, value);
  } else {
    url.searchParams.set('fields', fields.join(','));
    url.searchParams.set('filter', start === end ? 'record_date:eq:' + start : 'record_date:gte:' + start + ',record_date:lte:' + end);
    url.searchParams.set('sort', 'country_currency_desc,effective_date');
    url.searchParams.set('page[size]', String(input.pageSize)); url.searchParams.set('page[number]', String(input.page));
  }
  const request: AcquisitionRequest = { scopeId: input.provider === 'hkma' ? 'HK/OFFICIAL_STATISTICS' : 'US/OFFICIAL_STATISTICS',
    operationId: 'official_fx_observations', subjectId: input.provider === 'hkma' ? 'HKD_PER_FOREIGN_UNIT:USD,CNY,EUR' : 'TREASURY_REPORTING_FX',
    start, end, adjustment: 'not_applicable' };
  const binding: AcquisitionBinding = { providerId: input.provider, connectionId: input.provider + '.public',
    configurationDigest: digest(JSON.stringify(['official-page/1', roots[input.provider], fields, input.pageSize])) };
  return { url: url.href, request, binding, cursor: input.page === 1 ? null : String(input.provider === 'hkma' ? offset : input.page), fields };
}

/** 财政部原件直接复用现有声明式解析器；没有另写数值转换和发布代码。 */
export function treasuryAdapterConfig(): EndpointAdapterConfig {
  return readEndpointAdapterConfig({ contract: 'bd.endpoint-adapter/1', adapterId: 'official.treasury.reporting-fx', version: '1',
    match: { endpoint: roots.treasury, protocol: 'fiscal-data-json/v1', frequency: 'other', adjustment: 'none' },
    carrier: { kind: 'json', charset: 'utf-8' },
    response: { success: null, container: { path: 'data', kind: 'array' }, ignore: ['meta', 'links'] },
    fields: [
      { name: 'record_date', source: { kind: 'key', key: 'record_date' }, type: 'text', timeFormat: 'iso-date' },
      { name: 'country_currency_desc', source: { kind: 'key', key: 'country_currency_desc' }, type: 'text' },
      { name: 'exchange_rate', source: { kind: 'key', key: 'exchange_rate' }, type: 'decimal' },
      { name: 'effective_date', source: { kind: 'key', key: 'effective_date' }, type: 'text', timeFormat: 'iso-date' },
    ], evidence: { sourceId: 'us-treasury-fiscal-data', provider: 'U.S. Treasury Bureau of the Fiscal Service',
      coverage: '本请求限定的报告日期与当前返回页，不声明实时汇率或历史当时可得', basis: OFFICIAL_PUBLIC_DOCUMENTATION.treasury } });
}

/** 仅接受实际回执绑定的原字节。元数据读取不改写任何金融数值。 */
export function inspectOfficialJsonPage(selection: OfficialPageSelection, bytes: Uint8Array,
  receipt: AcquisitionOriginal & { requestedUrl: string }) {
  const selected = officialPageRequest(selection);
  if (!receipt.fileRefId || bytes.byteLength > 1_048_576 || digest(bytes) !== receipt.sha256
    || urlIdentity(receipt.requestedUrl) !== urlIdentity(selected.url)) return fail('原件摘要或实际请求不匹配。');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('官方响应不是完整 UTF-8 JSON；未修补。'); }
  const root = record(raw);
  let rows: Record<string, unknown>[], nextCursor: string | null | undefined, reportedTotal: number | null = null;
  if (selection.provider === 'hkma') {
    const header = record(root.header), result = record(root.result);
    if (header.success !== true || header.err_code !== '0000' || !Array.isArray(result.records)) return fail('金管局未返回成功记录信封。');
    rows = result.records.map(record);
    if (integer(result.datasize) !== rows.length) return fail('金管局本页 datasize 与实际行数不一致。');
    // datasize 是本页数，不是总体数。满页仅产生待验证的 offset，不伪造结束或历史完整。
    nextCursor = rows.length === selection.pageSize ? String(selection.page * selection.pageSize) : undefined;
    for (const row of rows) {
      if (Object.keys(row).sort().join(',') !== [...selected.fields].sort().join(',')) return fail('金管局字段改变，未默默丢弃。');
      for (const field of ['usd', 'cny', 'eur']) if (row[field] !== null && (typeof row[field] !== 'number' || !Number.isFinite(row[field])))
        return fail('金管局汇率字段类型漂移；原词面保留，不转换成零。');
    }
  } else {
    const meta = record(root.meta), links = record(root.links);
    if (!Array.isArray(root.data)) return fail('财政部没有 data 数组。');
    rows = root.data.map(record);
    const totalPages = integer(meta['total-pages']); reportedTotal = integer(meta['total-count']);
    if (integer(meta.count) !== rows.length || totalPages !== Math.ceil(reportedTotal / selection.pageSize)
      || selection.page > Math.max(1, totalPages)) return fail('财政部分页元数据不一致。');
    const checkLink = (value: unknown, expectedPage: number) => {
      if (typeof value !== 'string' || !value.startsWith('&') || value.length > 300) return fail('财政部分页链接不是受限参数引用。');
      const params = new URLSearchParams(value.slice(1));
      if ([...params.keys()].sort().join(',') !== 'page[number],page[size]'
        || params.get('page[number]') !== String(expectedPage) || params.get('page[size]') !== String(selection.pageSize))
        return fail('财政部分页链接改变请求页或行预算；不跟随外部链接。');
    };
    checkLink(links.self, selection.page);
    if (selection.page < totalPages) { checkLink(links.next, selection.page + 1); nextCursor = String(selection.page + 1); }
    else { if (links.next !== null) return fail('末页没有明确结束标记。'); nextCursor = null; }
    if (rows.length) parseEndpointSource(bytes, treasuryAdapterConfig(), { maxRecords: selection.pageSize });
  }
  if (rows.length > selection.pageSize) return fail('响应超过本次页预算；不截断。');
  const keys = rows.map(row => {
    const date = day(selection.provider === 'hkma' ? row.end_of_day : row.record_date);
    if (date < selection.start || date > selection.end) return fail('响应超出请求日期范围。');
    if (selection.provider === 'hkma') return date;
    if (typeof row.country_currency_desc !== 'string' || !row.country_currency_desc) return fail('财政部币种身份缺失。');
    return JSON.stringify([date, row.country_currency_desc, day(row.effective_date)]);
  });
  const page: AcquisitionPage = { cursor: selected.cursor, ...(nextCursor === undefined ? {} : { nextCursor }),
    original: { fileRefId: receipt.fileRefId, sha256: receipt.sha256 }, rowCount: rows.length, keys };
  return { ...selected, page, reportedTotal, semanticStatus: 'not_verified' as const,
    scope: 'acquisition_metadata_only' as const, returnTo: 'agents' as const, publication: 'not_requested' as const };
}

export function officialHttpDisposition(status: number) {
  return sourceFailureDisposition(status === 401 || status === 403 ? 'SOURCE_PERMISSION_DENIED'
    : status === 429 ? 'SOURCE_RATE_LIMITED' : 'SOURCE_HTTP_ERROR');
}

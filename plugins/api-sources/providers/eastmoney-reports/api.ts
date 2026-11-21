import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { DirectError } from '../../../../platform/runtime/file-workspace.js';

/** 使用端点与字段约定实现，不迁入上游缓存、PDF 下载及自动发送链。 */
export const eastmoneyReportReference = Object.freeze({
  project: 'https://github.com/henrylin99/quantitative_analysis',
  commit: '2edbc3eaf799f4d8f42c99fccba3b8fc08554f10',
  paths: ['app/utils/data_sources/eastmoney_report_client.py', 'app/services/research_report_service.py'],
  source: 'https://data.eastmoney.com/report/',
});
export type EastmoneyReportCategory = 'industry' | 'stock' | 'strategy' | 'macro' | 'new_stock';
export interface EastmoneyReportRequest {
  category: EastmoneyReportCategory; start: string; end: string; page: number; pageSize: number; symbol?: string;
}
export interface EastmoneyReportDetailRequest { category: 'strategy' | 'macro'; encodeUrl: string }
const categories: readonly string[] = ['industry', 'stock', 'strategy', 'macro', 'new_stock'];
const endpoints = { industry: '/report/list', stock: '/report/list2', strategy: '/report/jg', macro: '/report/jg', new_stock: '/report/newStockList' };
const detailPaths = { strategy: '/report/zw_strategy.jshtml', macro: '/report/zw_macresearch.jshtml' };
const headers = { Accept: 'application/json', Referer: 'https://data.eastmoney.com/' };
// 宿主单次检索预算，不表示供应商公布的限制，也不自动发起后续页请求。
const MAX_PAGE = 10_000, MAX_PAGE_SIZE = 100;
const fail = (message: string): never => { throw new DirectError('SOURCE_PARAMETERS_INVALID', message); };
const invalid = (message: string): never => { throw new DirectError('SOURCE_REPORT_RESPONSE_INVALID', message); };
const object = (value: unknown): value is Record<string, JsonValue> => !!value && typeof value === 'object' && !Array.isArray(value);

function dateOf(value: unknown): string {
  if (typeof value !== 'string') return fail('研报检索须提供起止日期。');
  const day = /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
    return fail('研报日期必须是有效的 YYYY-MM-DD 或 YYYYMMDD 自然日。');
  return day;
}
const integer = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) return invalid(`研报 ${name} 不是非负整数。`);
  return Number(parsed);
};
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return invalid(`研报 ${name} 字段类型改变。`);
  return value;
};
const infoCodeOf = (value: unknown): string | null => {
  const code = text(value, 'infoCode');
  if (code !== null && !/^AP\d{8,20}$/u.test(code)) return invalid('研报 infoCode 格式无效。');
  return code;
};

export function normalizeEastmoneyReportRequest(parameters: Record<string, JsonValue>): EastmoneyReportRequest {
  if (Object.keys(parameters).some(key => !['category', 'start', 'end', 'page', 'pageSize', 'symbol'].includes(key))
    || typeof parameters.category !== 'string' || !categories.includes(parameters.category)) return fail('研报类别或参数名称无效。');
  if (!Number.isSafeInteger(parameters.page) || Number(parameters.page) < 1 || Number(parameters.page) > MAX_PAGE
    || !Number.isSafeInteger(parameters.pageSize) || Number(parameters.pageSize) < 1 || Number(parameters.pageSize) > MAX_PAGE_SIZE)
    return fail('研报 page 与 pageSize 须为正整数，且不超过宿主的 10000 页定位 / 每页 100 条预算。');
  const start = dateOf(parameters.start), end = dateOf(parameters.end);
  if (start > end) return fail('研报日期窗逆序。');
  const category = parameters.category as EastmoneyReportCategory;
  if (category === 'stock' ? typeof parameters.symbol !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/u.test(parameters.symbol) : parameters.symbol !== undefined)
    return fail('个股研报须提供完整沪深京证券代码；其他类别不接受证券参数。');
  if (!Number.isSafeInteger((Number(parameters.page) - 1) * Number(parameters.pageSize))) return fail('研报分页偏移超出可表示范围。');
  return { category, start, end, page: Number(parameters.page), pageSize: Number(parameters.pageSize),
    ...(category === 'stock' ? { symbol: String(parameters.symbol) } : {}) };
}

/** 单次请求结构；POST 仅用于公开个股检索，不执行网络或自动翻页。 */
export function buildEastmoneyReportRequest(parameters: Record<string, JsonValue>) {
  const request = normalizeEastmoneyReportRequest(parameters);
  const url = new URL(endpoints[request.category], 'https://reportapi.eastmoney.com');
  const params: Record<string, string | number> = { pageSize: request.pageSize, pageNo: request.page, beginTime: request.start, endTime: request.end };
  if (request.category === 'industry' || request.category === 'stock') Object.assign(params, {
    qType: request.category === 'stock' ? '0' : '1', industry: '*', industryCode: '*', rating: '*', ratingChange: '*', orgCode: '', rcode: '', fields: '',
  });
  if (request.category === 'stock') params.code = request.symbol!.split('.')[0]!;
  if (request.category === 'strategy' || request.category === 'macro') Object.assign(params, { qType: request.category === 'strategy' ? '2' : '3', orgCode: '' });
  if (request.category === 'stock') return { url, method: 'POST' as const, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(params), request };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return { url, method: 'GET' as const, headers, request };
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > 2 * 1024 * 1024) return invalid('研报原件超过本适配器的 2MiB 解码预算。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return invalid('研报原件不是完整 UTF-8 文本。'); }
}

/** 原始时间完整保留。单页检索完成不等于历史覆盖或 WFD 准入。 */
export function decodeEastmoneyReports(request: EastmoneyReportRequest, rawBytes: Uint8Array) {
  const bound = normalizeEastmoneyReportRequest({ ...request });
  let payload: unknown;
  try { payload = JSON.parse(decodeUtf8(rawBytes)); } catch (error) {
    if (error instanceof DirectError) throw error;
    return invalid('研报列表不是完整 JSON。');
  }
  if (!object(payload) || !Array.isArray(payload.data) || payload.success === false
    || payload.code !== undefined && payload.code !== 0 && payload.code !== '0') return invalid('研报列表缺少有效 data 数组或返回业务错误。');
  const total = integer(payload.hits, 'hits'), totalPages = integer(payload.TotalPage, 'TotalPage'), reportedPage = integer(payload.pageNo, 'pageNo');
  if (reportedPage !== null && reportedPage !== bound.page) return invalid('研报返回页号与请求不符。');
  if (payload.data.length > bound.pageSize || total !== null && payload.data.length > total
    || totalPages !== null && bound.page > Math.max(1, totalPages)
    || total !== null && totalPages !== null && totalPages !== Math.ceil(total / bound.pageSize))
    return invalid('研报条数或分页元数据矛盾。');
  if (total !== null && payload.data.length !== Math.min(bound.pageSize, Math.max(0, total - (bound.page - 1) * bound.pageSize)))
    return invalid('研报当前页记录数与来源声明的总数不一致。');
  if (totalPages !== null && bound.page < totalPages && payload.data.length === 0) return invalid('研报返回空中间页；不把缺页当成结束。');
  const ids = new Set<string>();
  const rows = payload.data.map((value, index) => {
    if (!object(value)) return invalid('研报记录必须是对象。');
    const infoCode = infoCodeOf(value.infoCode), encodeUrl = text(value.encodeUrl, 'encodeUrl');
    if (!infoCode && !encodeUrl) return invalid('研报缺少可追溯的 infoCode 或 encodeUrl。');
    if (!infoCode && bound.category !== 'strategy' && bound.category !== 'macro') return invalid('此类研报缺少 infoCode。');
    const key = `${bound.category}:${infoCode ?? encodeUrl}`;
    if (ids.has(key)) return invalid('研报单页包含重复身份；未静默删除。');
    ids.add(key);
    const publishTimeRaw = text(value.publishDate, 'publishDate');
    let publishDate: string | null = null;
    if (publishTimeRaw !== null) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/u.exec(publishTimeRaw);
      if (!match) return invalid('研报发布日期格式改变；未猜测。');
      try { publishDate = dateOf(match[1]); } catch { return invalid('研报发布日期不是有效自然日。'); }
      if (publishDate < bound.start || publishDate > bound.end) return invalid('研报发布日期超出显式检索窗。');
    }
    const stockCode = text(value.stockCode, 'stockCode');
    if (bound.category === 'stock' && stockCode !== null && stockCode !== bound.symbol!.split('.')[0])
      return invalid('个股研报返回了其他证券。');
    const detailUrl = infoCode ? `https://data.eastmoney.com/report/info/${infoCode}.html`
      : buildEastmoneyReportDetailRequest({ category: bound.category, encodeUrl: encodeUrl! }).url.href;
    return { report_key: key, category: bound.category, info_code: infoCode, encode_url: encodeUrl,
      title: text(value.title, 'title'), stock_code: stockCode, stock_name: text(value.stockName, 'stockName'),
      org_name: text(value.orgSName, 'orgSName') ?? text(value.orgName, 'orgName'),
      publish_time_raw: publishTimeRaw, publish_date: publishDate,
      publication_precision: publishTimeRaw === null ? 'missing' : publishTimeRaw.length === 10 ? 'date' : 'source_text',
      publication_timezone: 'not_established', researchers: text(value.researcher, 'researcher'),
      rating: text(value.emRatingName, 'emRatingName') ?? text(value.sRatingName, 'sRatingName'),
      attachment_pages: integer(value.attachPages, 'attachPages'), detail_url: detailUrl,
      pdf_url: infoCode ? `https://pdf.dfcfw.com/pdf/H3_${infoCode}_1.pdf` : null,
      source_page: bound.page, source_row: index + 1, raw: value };
  });
  const continuation = reportedPage === null || totalPages === null ? 'not_declared'
    : bound.page < totalPages ? 'available' : 'finished';
  return { decoderVersion: 'eastmoney-reports/1' as const, providerId: 'eastmoney' as const, request: bound,
    recordCount: rows.length, rows, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    page: bound.page, reportedPage, total, totalPages, nextPage: continuation === 'available' ? bound.page + 1 : null,
    continuation, coverageState: 'not_established' as const, historyAvailability: 'not_established' as const,
    paginationRaw: { hits: payload.hits ?? null, TotalPage: payload.TotalPage ?? null, pageNo: payload.pageNo ?? null, size: payload.size ?? null } };
}

/** 只定位策略/宏观详情；infoCode 类列表已经给出附件定位，不制造额外请求。 */
export function buildEastmoneyReportDetailRequest(parameters: Record<string, JsonValue>) {
  if (Object.keys(parameters).some(key => !['category', 'encodeUrl'].includes(key))
    || parameters.category !== 'strategy' && parameters.category !== 'macro'
    || typeof parameters.encodeUrl !== 'string' || !parameters.encodeUrl.trim() || parameters.encodeUrl.length > 2048)
    return fail('研报详情须提供 strategy/macro 类别和有效 encodeUrl。');
  const request: EastmoneyReportDetailRequest = { category: parameters.category, encodeUrl: parameters.encodeUrl };
  const url = new URL(detailPaths[request.category], 'https://data.eastmoney.com');
  url.searchParams.set('encodeUrl', request.encodeUrl);
  return { url, method: 'GET' as const, headers: { Accept: 'text/html', Referer: headers.Referer }, request };
}

/** 复用现有 HTML 解析依赖；仅返回同源固定格式 PDF 定位，不下载、不执行脚本。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const { document } = parseHTML(decodeUtf8(rawBytes));
  const candidates = new Map<string, string>();
  const collect = (candidate: string) => {
    let url: URL;
    try { url = new URL(candidate, bound.url); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.port || url.username || url.password) return;
    const match = /^\/pdf\/H3_(AP\d{8,20})_1\.pdf$/u.exec(url.pathname);
    if (match) candidates.set(url.href, match[1]!);
  };
  for (const element of document.querySelectorAll('a[href], iframe[src], embed[src], object[data]'))
    collect(element.getAttribute('href') ?? element.getAttribute('src') ?? element.getAttribute('data') ?? '');
  for (const script of document.querySelectorAll('script'))
    for (const match of (script.textContent ?? '').matchAll(/https:\/\/pdf\.dfcfw\.com\/pdf\/H3_AP\d{8,20}_1\.pdf(?=["'\s<>)]|$)/gu)) collect(match[0]);
  if (candidates.size !== 1) return invalid(candidates.size ? '研报详情存在多个不同附件定位，须明确选择。' : '研报详情没有可验证的 PDF 附件定位。');
  const [pdfUrl, infoCode] = [...candidates.entries()][0]!;
  return { decoderVersion: 'eastmoney-report-detail/1' as const, providerId: 'eastmoney' as const, request: bound.request,
    detailUrl: bound.url.href, infoCode, pdfUrl, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    attachmentFetched: false as const, historyAvailability: 'not_established' as const };
}

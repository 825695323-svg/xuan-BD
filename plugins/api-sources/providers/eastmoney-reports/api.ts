import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { isReportEncodeUrl } from '../../../../contracts/source-acquisition.js';
import type { ReportSubjectEvidence } from '../../../../contracts/source-settings.js';
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
    || totalPages === 0 && payload.data.length > 0 || totalPages !== null && bound.page > Math.max(1, totalPages)
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
    if (bound.category === 'stock' && stockCode !== null && stockCode !== bound.symbol && stockCode !== bound.symbol!.split('.')[0])
      return invalid('个股研报返回了其他证券。');
    const detailUrl = infoCode ? `https://data.eastmoney.com/report/info/${infoCode}.html`
      : buildEastmoneyReportDetailRequest({ category: bound.category, encodeUrl: encodeUrl! }).url.href;
    return { report_key: key, category: bound.category, info_code: infoCode, encode_url: encodeUrl,
      ...(bound.symbol ? { requested_symbol: bound.symbol, subject_verified: stockCode === bound.symbol,
        subjectVerification: stockCode === null ? 'unverified_missing_stock_code' : stockCode === bound.symbol
          ? 'verified_full_code' : 'code_prefix_only_exchange_unverified' } : {}),
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
  let subject: ReportSubjectEvidence | undefined;
  if (bound.symbol) {
    const stock_codes = [...new Set(rows.map(row => row.stock_code).filter(code => code !== null))];
    const subject_verified = rows.length > 0 && rows.every(row => row.subject_verified);
    subject = { requested_symbol: bound.symbol, stock_codes, subject_verified,
      subjectVerification: !rows.length ? 'no_rows' : rows.some(row => row.stock_code === null) ? 'unverified_missing_stock_code'
        : subject_verified ? 'verified_full_code' : 'code_prefix_only_exchange_unverified' };
  }
  const continuation = reportedPage === null || totalPages === null ? 'not_declared'
    : bound.page < totalPages ? 'available' : 'finished';
  return { decoderVersion: 'eastmoney-reports/1' as const, providerId: 'eastmoney' as const, request: bound,
    recordCount: rows.length, rows, ...(subject ? { subject } : {}), rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    page: bound.page, reportedPage, total, totalPages, nextPage: continuation === 'available' ? bound.page + 1 : null,
    continuation, coverageState: 'not_established' as const, historyAvailability: 'not_established' as const,
    paginationRaw: { hits: payload.hits ?? null, TotalPage: payload.TotalPage ?? null, pageNo: payload.pageNo ?? null, size: payload.size ?? null } };
}

/** 只定位策略/宏观详情；infoCode 类列表已经给出附件定位，不制造额外请求。 */
export function buildEastmoneyReportDetailRequest(parameters: Record<string, JsonValue>) {
  if (Object.keys(parameters).some(key => !['category', 'encodeUrl'].includes(key))
    || parameters.category !== 'strategy' && parameters.category !== 'macro'
    || !isReportEncodeUrl(parameters.encodeUrl))
    return fail('研报详情须提供 strategy/macro 类别和有效 encodeUrl。');
  const request: EastmoneyReportDetailRequest = { category: parameters.category, encodeUrl: parameters.encodeUrl };
  const url = new URL(detailPaths[request.category], 'https://data.eastmoney.com');
  url.searchParams.set('encodeUrl', request.encodeUrl);
  return { url, method: 'GET' as const, headers: { Accept: 'text/html', Referer: headers.Referer }, request };
}

/** 接受 JSON 或仅含静态字符串的旧式 JS 对象字面量；脚本从不执行。 */
function detailMetadata(literal: string): Record<string, JsonValue> | null {
  try {
    const parsed: unknown = JSON.parse(literal);
    return object(parsed) ? parsed : null;
  } catch { /* 旧式详情脚本也会使用未加引号的字段名或单引号字符串。 */ }
  const body = literal.slice(1, -1).trim();
  const field = /\s*(?:([a-zA-Z_][\w]*)|"([\w]+)"|'([\w]+)')\s*:\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*(?:,|$)/gy;
  const values: Record<string, string> = Object.create(null);
  while (field.lastIndex < body.length) {
    const match = field.exec(body);
    if (!match) return null;
    const key = match[1] ?? match[2] ?? match[3];
    if (Object.hasOwn(values, key)) return null;
    values[key] = match[4] ?? match[5];
  }
  return values;
}

const kwBreakPattern = '(?:[^\\S\\r\\n\\u2028\\u2029]*[\\r\\n\\u2028\\u2029]+[^\\S\\r\\n\\u2028\\u2029]*)?';
const relatedKwPattern = `(?:相${kwBreakPattern}关${kwBreakPattern}阅${kwBreakPattern}读`
  + `|相${kwBreakPattern}关${kwBreakPattern}研${kwBreakPattern}报`
  + `|推${kwBreakPattern}荐${kwBreakPattern}阅${kwBreakPattern}读`
  + `|延${kwBreakPattern}伸${kwBreakPattern}阅${kwBreakPattern}读)`;
const relatedTitle = new RegExp(`^[【[(\\s（]*${relatedKwPattern}(?:$|[\\s】\\])））：:—\\-·•]+|(?=[《「【[(（]|\\[\\d{1,3}\\]|[(（]\\d{1,3}[)）]|\\d{1,3}(?:\\.(?!\\d)|[、)）])|[①-⑳]))`, 'u');
const relatedHeadingAtBoundary = new RegExp(`^${relatedKwPattern}(?:$|(?:\\s*[】\\])））：:—\\-·•]+)+|\\s+|(?=[《「【[(（]|\\[\\d{1,3}\\]|[(（]\\d{1,3}[)）]|\\d{1,3}(?:\\.(?!\\d)|[、)）])|[①-⑳]))`, 'u');
const relatedAfterAnchor = new RegExp(`^${relatedKwPattern}(?:$|(?:\\s*[】\\])））：:—\\-·•]+)+|(?=\\s*(?:[《「【[(（]|\\[\\d{1,3}\\]|[(（]\\d{1,3}[)）]|\\d{1,3}(?:\\.(?!\\d)|[、)）])|[①-⑳])))`, 'u');
const relatedBeforeTarget = new RegExp(`(?:^|(?<=[\\s。！？；.!?])|(?<=(?:^|[\\s。！？；.!?])[【[(（]))${relatedKwPattern}[\\s】\\])））：:—\\-·•]*$`, 'u');
const relatedWrapperTitle = new RegExp(`^[【[(\\s（]*${relatedKwPattern}[\\s】\\])））：:]*$`, 'u');
const relatedBareKeywordCore = new RegExp(`^[【[]*\\s*${relatedKwPattern}(?:\\s*[】\\])）：:—\\-·•]+)*`, 'u');
const titleLinkRightBoundary = /^(?:[\s】\])））：:—\-·•《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳])/u;
const inlineRelatedHeading = new RegExp(`(?:^|(?<=[\\s。！？；.!?])|(?<=(?:^|[\\s。！？；.!?])[【[(（]))(${relatedKwPattern})(?:$|[\\s】\\])））：:—\\-·•]+|(?=[《「【[(（]|\\[\\d{1,3}\\]|[(（]\\d{1,3}[)）]|\\d{1,3}(?:\\.(?!\\d)|[、)）])|[①-⑳]))`, 'gu');
const mainAttachmentHeading = /^[【[(\s]*(?:本?研报附件|本?报告附件|正文附件|原文附件|研报原文|原文下载|下载本?研报|下载原文|附件下载)(?:$|[\s】\])：:—\-·•（(])/u;
const mainAttachmentWrapperTitle = /^[【[(\s（]*(?:本?研报附件|本?报告附件|正文附件|原文附件|研报原文|原文下载|下载本?研报|下载原文|附件下载)[\s】\])））：:]*$/u;
const leadingListItem = /^[\s\n]*(?:\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳])(?=$|[\s\n\p{L}\p{N}《「【])/u;
const proseBodyCueGlobal = /(?:详见正文|参见正文|请见正文|见正文|详见下文|参见下文|见下文|详见本?报告|参见本?报告|请见本?报告|详见本?研报|参见本?研报|请见本?研报|本(?:研报|报告)的?(?:下载地址|原文地址|下载链接|原文链接|下载入口|原文|附件)(?:见|参见|详见|请见|如下|在此)|请参阅|正文说明)/gu;
const proseDownloadTailCue = /(?:下载地址|原文地址|下载链接|原文链接|下载入口|本?研报附件|正文附件|原文附件|附件|原文|下载|入口|链接)见[\s：:]*$/u;
const foreignReportRefCue = /(?:上一|其他|另一|他稿)/u;
const proseAnchorText = /^(?:详见|参见|请见|请参阅|见)?(?:正文|下文|上文|本?(?:研报|报告))(?:说明|内容|分析|第\s*\d+\s*[节章条页])?[。！？；.!?\s]*$/u;
const midSentencePrevChar = /[\p{L}\p{N}，,、”’"'）)\]]/u;
const lineOrSentenceBreakChar = /[\r\n\u2028\u2029。！？；.!?]/u;
const horizWhitespaceChar = /[^\S\r\n\u2028\u2029]/u;
const explicitSectionHeadings = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend,dt';
const rootBoundaryContainers = '#zwinfo,article,section,main,body,html';
const relatedSelector = 'aside,nav,footer,[role="navigation"],[aria-label*="相关"],[aria-label*="推荐"],[aria-label*="延伸阅读"],'
  + '[class*="related" i],[id*="related" i],[class*="recommend" i],[id*="recommend" i],.rel-list,.xgyd,.xgyb';
const inlineFlowElements = 'span,strong,b,em,i,small,u,mark,font,sub,sup,label,abbr,cite,code,time,ins,del,s,q,bdi,bdo,ruby,rt,rp,kbd,samp,var,data,dfn';
const decorativeInlineTags = new Set(['WBR', 'IMG', 'INPUT', 'SVG', 'PICTURE', 'SOURCE', 'CANVAS']);
const isolatedContainerTags = new Set([
  'HEAD', 'ARTICLE', 'SECTION', 'MAIN', 'BODY', 'HTML',
  'DETAILS', 'FIGURE', 'FIELDSET', 'DIALOG', 'TABLE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'DD', 'DL',
  'FORM', 'SELECT', 'OPTION', 'OPTGROUP', 'TEXTAREA', 'BUTTON', 'DATALIST', 'OUTPUT',
]);
const listTags = new Set(['UL', 'OL', 'LI', 'DL']);
const nonContentTags = new Set(['META', 'LINK', 'TITLE', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function isEastmoneyPdfHref(href: string | null, baseUrl: string): boolean {
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.port || url.username || url.password) {
    return false;
  }
  return /^\/pdf\/H3_AP\d{8,20}_1\.pdf$/u.test(url.pathname);
}

function appendNormalizedOwnText(current: string, piece: string, limit = 128): string {
  if (!piece || current.length >= limit) return current;
  let out = current;
  let lastCh = out.length > 0 ? out[out.length - 1]! : '';
  for (let i = 0; i < piece.length && out.length < limit; i += 1) {
    const ch = piece[i]!;
    if (/[\r\n\u2028\u2029]/u.test(ch)) {
      if (lastCh === ' ') {
        out = out.slice(0, -1) + '\n';
        lastCh = '\n';
      } else if (lastCh !== '\n') {
        out += '\n';
        lastCh = '\n';
      }
    } else if (/\s/u.test(ch)) {
      if (lastCh !== ' ' && lastCh !== '\n') {
        out += ' ';
        lastCh = ' ';
      }
    } else {
      out += ch;
      lastCh = ch;
    }
  }
  return out;
}

function headingLevel(element: Element): number {
  if (/^H[1-6]$/u.test(element.tagName)) return Number(element.tagName[1]);
  const aria = element.getAttribute('aria-level');
  return aria && /^[1-6]$/u.test(aria) ? Number(aria) : 2;
}

type DomFlags = {
  canFlattenInline: WeakMap<Element, boolean>;
  hasRootBoundary: WeakMap<Element, boolean>;
  hasNestedExplicitHeading: WeakMap<Element, boolean>;
  stopsOuterRelated: WeakMap<Element, boolean>;
  hasCandidateBeforeHeading: WeakMap<Element, boolean>;
  ownText: WeakMap<Element, string>;
};

function precomputeDomFlags(document: Document, baseUrl: string): DomFlags {
  const canFlattenInline = new WeakMap<Element, boolean>();
  const hasRootBoundary = new WeakMap<Element, boolean>();
  const hasNestedExplicitHeading = new WeakMap<Element, boolean>();
  const stopsOuterRelated = new WeakMap<Element, boolean>();
  const hasCandidateBeforeHeading = new WeakMap<Element, boolean>();
  const isIsolatedBoundary = new WeakMap<Element, boolean>();
  const ownText = new WeakMap<Element, string>();
  const hasAnchorOrFrame = new WeakMap<Element, boolean>();
  const stack: Array<{
    node: Element;
    parentIsZwinfo: boolean;
    inZwinfo: boolean;
    inDownloadBox: boolean;
    hasEncodeUrl: boolean;
    inList: boolean;
    needOwnText: boolean;
    visited: boolean;
  }> = [];
  const docChildren: NodeListOf<ChildNode> = document.childNodes;
  for (let i = docChildren.length - 1; i >= 0; i -= 1) {
    const child: ChildNode = docChildren[i]!;
    if (child.nodeType === 1) {
      stack.push({
        node: child as Element,
        parentIsZwinfo: false,
        inZwinfo: false,
        inDownloadBox: false,
        hasEncodeUrl: false,
        inList: false,
        needOwnText: false,
        visited: false,
      });
    }
  }
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const el = top.node;
    if (!top.visited) {
      top.visited = true;
      const isRel = el.matches(relatedSelector);
      const isBox = el.matches('.report-download');
      const isRootSelf = el.matches(rootBoundaryContainers);
      const isIsoSelf = isRel || isBox || isRootSelf || isolatedContainerTags.has(el.tagName) || nonContentTags.has(el.tagName);
      isIsolatedBoundary.set(el, isIsoSelf);
      const selfConsumesOwnText = el.matches(explicitSectionHeadings)
        || el.tagName === 'A'
        || (el.hasAttribute('class') && el.matches('[class*="title" i]'));
      const nextNeedOwnText = selfConsumesOwnText || top.needOwnText;
      top.needOwnText = nextNeedOwnText;
      const nextInList = top.inList || listTags.has(el.tagName);
      top.inList = nextInList;
      const isZw = el.id === 'zwinfo';
      const nextInZw = top.inZwinfo || isZw;
      const nextInBox = top.inDownloadBox || isBox;
      const nextHasEncode = top.hasEncodeUrl || el.hasAttribute('data-encode-url');
      top.inZwinfo = nextInZw;
      top.inDownloadBox = nextInBox;
      top.hasEncodeUrl = nextHasEncode;
      const children: NodeListOf<ChildNode> = el.childNodes;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child: ChildNode = children[i]!;
        if (child.nodeType === 1) {
          const ce = child as Element;
          const childIso = ce.matches(relatedSelector)
            || ce.matches('.report-download')
            || ce.matches(rootBoundaryContainers)
            || isolatedContainerTags.has(ce.tagName)
            || nonContentTags.has(ce.tagName);
          stack.push({
            node: ce,
            parentIsZwinfo: isZw,
            inZwinfo: nextInZw,
            inDownloadBox: nextInBox,
            hasEncodeUrl: nextHasEncode,
            inList: nextInList,
            needOwnText: nextNeedOwnText && !childIso,
            visited: false,
          });
        }
      }
      continue;
    }
    stack.pop();
    const isRel = el.matches(relatedSelector);
    const isBox = el.matches('.report-download');
    const isRootSelf = el.matches(rootBoundaryContainers);
    const isIsoSelf = Boolean(isIsolatedBoundary.get(el));

    const isExplicitH = el.matches(explicitSectionHeadings);
    let rootB = isRootSelf;
    let nestedH = false;
    let childStopsOuter = false;
    let allFlat = true;
    let linkOrFrameChild = false;
    const selfIsCandidate = !isRel && !isRootSelf && !nonContentTags.has(el.tagName) && (
      (
        el.tagName === 'A'
        && isEastmoneyPdfHref(el.getAttribute('href'), baseUrl)
        && (isBox || (top.inZwinfo && el.hasAttribute('download')) || top.inDownloadBox || top.hasEncodeUrl)
      )
      || (el.tagName === 'IFRAME' && top.parentIsZwinfo && isEastmoneyPdfHref(el.getAttribute('src'), baseUrl))
    );
    let candidateBeforeH = selfIsCandidate;
    let hitHeading = false;
    let own = '';
    const children: NodeListOf<ChildNode> = el.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      const child: ChildNode = children[i]!;
      if (child.nodeType === 3) {
        if (top.needOwnText && own.length < 128) {
          own = appendNormalizedOwnText(own, child.textContent ?? '', 128);
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const ce = child as Element;
      const childNestedH = ce.matches(explicitSectionHeadings) || Boolean(hasNestedExplicitHeading.get(ce));
      const ceStopsOuter = Boolean(stopsOuterRelated.get(ce));
      if (hasRootBoundary.get(ce)) rootB = true;
      if (childNestedH) nestedH = true;
      if (ceStopsOuter) childStopsOuter = true;
      if (!canFlattenInline.get(ce)) allFlat = false;
      if (ce.tagName === 'A' || ce.tagName === 'IFRAME' || hasAnchorOrFrame.get(ce)) linkOrFrameChild = true;
      if (!hitHeading && !isRel && !isRootSelf && !nonContentTags.has(el.tagName)) {
        if (hasCandidateBeforeHeading.get(ce)) candidateBeforeH = true;
        if (ceStopsOuter) hitHeading = true;
      }
      if (top.needOwnText && own.length < 128 && !isIsolatedBoundary.get(ce)) {
        const piece = ce.tagName === 'BR' || ce.tagName === 'HR' ? '\n' : (ownText.get(ce) ?? '');
        own = appendNormalizedOwnText(own, piece, 128);
      }
    }
    let selfStopsLevel2 = false;
    if (isExplicitH && !isIsoSelf && !rootB && !nestedH) {
      const hText = own.trim();
      if (hText.length > 0 && hText.length <= 64 && !/[。！？；]/u.test(hText) && !relatedTitle.test(hText)) {
        selfStopsLevel2 = top.inList
          ? mainAttachmentHeading.test(hText)
          : (headingLevel(el) <= 2 || mainAttachmentHeading.test(hText));
      }
    }
    if (selfStopsLevel2 && !selfIsCandidate) candidateBeforeH = false;
    hasRootBoundary.set(el, rootB);
    hasNestedExplicitHeading.set(el, nestedH);
    stopsOuterRelated.set(el, !isIsoSelf && (selfStopsLevel2 || childStopsOuter));
    hasCandidateBeforeHeading.set(el, candidateBeforeH);
    hasAnchorOrFrame.set(el, linkOrFrameChild);
    if (top.needOwnText) ownText.set(el, own);
    let flat = false;
    if (el.tagName === 'BR' || el.tagName === 'HR') {
      flat = true;
    } else if (decorativeInlineTags.has(el.tagName)) {
      flat = !linkOrFrameChild && !rootB && !nestedH && allFlat;
    } else if (el.tagName === 'IFRAME') {
      flat = !isRel && !isBox;
    } else if (el.tagName === 'A' || el.matches(inlineFlowElements)) {
      flat = allFlat
        && !isRel
        && !isRootSelf
        && !isBox
        && !isExplicitH;
    }
    canFlattenInline.set(el, flat);
  }
  return {
    canFlattenInline,
    hasRootBoundary,
    hasNestedExplicitHeading,
    stopsOuterRelated,
    hasCandidateBeforeHeading,
    ownText,
  };
}

type Scope = {
  relatedLevel: number | null;
  inRelatedSelector: boolean;
  inList: boolean;
  isDownloadBox: boolean;
  outerRelated: boolean;
  boxAncestorLocalRelated: boolean;
  inAttachmentLink: boolean;
};

type AttrScope = {
  nearestEncodeUrl: string | null;
  nearestInfoCode: string | null;
  nearestDownloadBox: Element | null;
  inZwinfo: boolean;
  inHrefAnchor: boolean;
};

type AttachmentInfo = {
  inRelatedSelector: boolean;
  outerRelated: boolean;
  localRelated: boolean;
  owner: string | null;
  expectedInfoCode: string | null;
  downloadBox: Element | null;
};

type AttachmentEntry = {
  element: Element;
  info: AttachmentInfo;
};

type RunTarget = {
  element: Element;
  start: number;
  end: number;
  owner: string | null;
  expectedInfoCode: string | null;
  inRelatedSelf: boolean;
};

type TitleLinkTrigger = {
  start: number;
  end: number;
  endsWithPunct: boolean;
  isRoundParen: boolean;
  isTitleElem: boolean;
  hasHref: boolean;
};

function recordRunTargets(
  targets: RunTarget[],
  fromIndex: number,
  toIndex: number,
  inRelatedSelector: boolean,
  outerRelated: boolean,
  localRelated: boolean,
  downloadBox: Element | null,
  attachmentMap: WeakSet<Element>,
  attachments: AttachmentEntry[],
): void {
  for (let i = fromIndex; i < toIndex; i += 1) {
    const t = targets[i]!;
    if (!attachmentMap.has(t.element)) {
      attachmentMap.add(t.element);
      attachments.push({
        element: t.element,
        info: {
          inRelatedSelector: inRelatedSelector || t.inRelatedSelf,
          outerRelated,
          localRelated,
          owner: t.owner,
          expectedInfoCode: t.expectedInfoCode,
          downloadBox,
        },
      });
    }
  }
}

function scanInlineRun(
  container: Element | Document,
  nodes: ChildNode[],
  onlyRun: boolean,
  followedByCandidate: boolean,
  baseUrl: string,
  flags: DomFlags,
  cur: Scope,
  attr: AttrScope,
  attachmentMap: WeakSet<Element>,
  attachments: AttachmentEntry[],
): void {
  type CloseAnchorFrame = {
    kind: 'closeAnchor';
    el: Element;
    start: number;
    targetIndex: number;
    hasHref: boolean;
    hasExplicitReportAttr: boolean;
  };
  type CloseTitleFrame = {
    kind: 'closeTitle';
    el: Element;
    start: number;
    inHref: boolean;
  };
  type RunFrame =
    | {
        kind: 'node';
        node: ChildNode;
        owner: string | null;
        infoCode: string | null;
        isTopChild: boolean;
        hasExplicitReportAttr: boolean;
      }
    | CloseAnchorFrame
    | CloseTitleFrame;
  const stack: RunFrame[] = [];
  const initialHasExplicitAttr = attr.nearestEncodeUrl !== null || attr.nearestInfoCode !== null;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    stack.push({
      kind: 'node',
      node: nodes[i]!,
      owner: attr.nearestEncodeUrl,
      infoCode: attr.nearestInfoCode,
      isTopChild: true,
      hasExplicitReportAttr: initialHasExplicitAttr,
    });
  }
  let runText = '';
  let inAnchorDepth = 0;
  let inHrefAnchorDepth = attr.inHrefAnchor ? 1 : 0;
  let hasNonEmptyTitleElem = false;
  let hasHrefAnchor = attr.inHrefAnchor;
  const runTargets: RunTarget[] = [];
  const titleLinkTriggers: TitleLinkTrigger[] = [];
  const topAnchorSpans: Array<{ start: number; end: number }> = [];
  const hrefAnchorSpans: Array<{ start: number; end: number }> = [];
  const titleSpans: Array<{ start: number; end: number }> = [];
  const anchorStarts = new Set<number>();
  const nonEmptyAnchorStarts = new Set<number>();
  const anchorEnds = new Set<number>();
  const targetStarts = new Set<number>();
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.kind === 'closeTitle') {
      const end = runText.length;
      if (end > frame.start) {
        titleSpans.push({ start: frame.start, end });
        if (!frame.inHref) hasNonEmptyTitleElem = true;
      }
      const titleText = (flags.ownText.get(frame.el) ?? '').trim();
      if (titleText.length > 0 && titleText.length <= 16 && relatedWrapperTitle.test(titleText)) {
        titleLinkTriggers.push({
          start: frame.start,
          end,
          endsWithPunct: /[】\])））：:—\-·•]$/u.test(titleText),
          isRoundParen: /^[（(]/u.test(titleText) && !/[：:]/u.test(titleText),
          isTitleElem: true,
          hasHref: frame.inHref,
        });
      }
      continue;
    }
    if (frame.kind === 'closeAnchor') {
      inAnchorDepth -= 1;
      if (frame.hasHref) inHrefAnchorDepth -= 1;
      const end = runText.length;
      if (end > frame.start) {
        nonEmptyAnchorStarts.add(frame.start);
        anchorEnds.add(end);
        if (frame.hasHref) {
          hrefAnchorSpans.push({ start: frame.start, end });
        }
      }
      const linkText = (flags.ownText.get(frame.el) ?? '').trim();
      const anchorIsTitle = frame.el.hasAttribute('class') && frame.el.matches('[class*="title" i]');
      if (anchorIsTitle && end > frame.start) {
        titleSpans.push({ start: frame.start, end });
        if (!frame.hasHref && inHrefAnchorDepth === 0) {
          hasNonEmptyTitleElem = true;
        }
      }
      if (inAnchorDepth === 0 && end > frame.start && linkText.length > 0) {
        const rawHref = (frame.el.getAttribute('href') ?? '').trim();
        if (
          rawHref.length > 0
          && !rawHref.toLowerCase().startsWith('javascript:')
          && (frame.hasExplicitReportAttr || !proseAnchorText.test(linkText))
        ) {
          topAnchorSpans.push({ start: frame.start, end });
        }
      }
      if (frame.targetIndex !== -1) {
        const target = runTargets[frame.targetIndex]!;
        target.end = end;
        target.inRelatedSelf = linkText.length > 0 && relatedTitle.test(linkText);
      }
      if (linkText.length > 0 && linkText.length <= 16 && relatedWrapperTitle.test(linkText)) {
        titleLinkTriggers.push({
          start: frame.start,
          end,
          endsWithPunct: /[】\])））：:—\-·•]$/u.test(linkText),
          isRoundParen: /^[（(]/u.test(linkText) && !/[：:]/u.test(linkText),
          isTitleElem: anchorIsTitle,
          hasHref: frame.hasHref,
        });
      }
      continue;
    }
    const { node } = frame;
    if (node.nodeType === 3) {
      const text = node.textContent ?? '';
      if (text) runText += text;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.tagName === 'BR' || el.tagName === 'HR') {
      runText += '\n';
      continue;
    }
    if (decorativeInlineTags.has(el.tagName)) continue;
    const nextOwner = el.getAttribute('data-encode-url') ?? frame.owner;
    const nextInfoCode = el.getAttribute('data-info-code') ?? frame.infoCode;
    const nextExplicitAttr = frame.hasExplicitReportAttr
      || el.hasAttribute('data-encode-url')
      || el.hasAttribute('data-info-code');
    if (el.tagName === 'IFRAME') {
      const isZwinfoDirect = frame.isTopChild && container.nodeType === 1 && (container as Element).id === 'zwinfo';
      if (isZwinfoDirect && isEastmoneyPdfHref(el.getAttribute('src'), baseUrl)) {
        targetStarts.add(runText.length);
        runTargets.push({
          element: el,
          start: runText.length,
          end: runText.length,
          owner: nextOwner,
          expectedInfoCode: nextInfoCode,
          inRelatedSelf: false,
        });
      }
      continue;
    }
    if (el.tagName === 'A') {
      const anchorStart = runText.length;
      anchorStarts.add(anchorStart);
      const hasHref = el.hasAttribute('href');
      if (hasHref) hasHrefAnchor = true;
      const isCandidate = isEastmoneyPdfHref(el.getAttribute('href'), baseUrl)
        && ((attr.inZwinfo && el.hasAttribute('download')) || attr.nearestDownloadBox !== null || nextOwner !== null);
      let targetIndex = -1;
      if (isCandidate) {
        targetIndex = runTargets.length;
        targetStarts.add(anchorStart);
        runTargets.push({
          element: el,
          start: anchorStart,
          end: anchorStart,
          owner: nextOwner,
          expectedInfoCode: nextInfoCode,
          inRelatedSelf: false,
        });
      }
      inAnchorDepth += 1;
      if (hasHref) inHrefAnchorDepth += 1;
      stack.push({
        kind: 'closeAnchor',
        el,
        start: anchorStart,
        targetIndex,
        hasHref,
        hasExplicitReportAttr: nextExplicitAttr,
      });
      const ac: NodeListOf<ChildNode> = el.childNodes;
      for (let i = ac.length - 1; i >= 0; i -= 1) {
        stack.push({
          kind: 'node',
          node: ac[i]!,
          owner: nextOwner,
          infoCode: nextInfoCode,
          isTopChild: false,
          hasExplicitReportAttr: nextExplicitAttr,
        });
      }
      continue;
    }
    if (el.hasAttribute('class') && el.matches('[class*="title" i]')) {
      stack.push({ kind: 'closeTitle', el, start: runText.length, inHref: inHrefAnchorDepth > 0 });
    }
    const ic: NodeListOf<ChildNode> = el.childNodes;
    for (let i = ic.length - 1; i >= 0; i -= 1) {
      stack.push({
        kind: 'node',
        node: ic[i]!,
        owner: nextOwner,
        infoCode: nextInfoCode,
        isTopChild: false,
        hasExplicitReportAttr: nextExplicitAttr,
      });
    }
  }

  // 独占块主附件标题停靠（如 <p><span class="title">本研报附件</span></p>），拒绝带后续正文的句子或超链接。
  if (onlyRun && runTargets.length === 0 && !hasHrefAnchor && !cur.inList && !cur.inRelatedSelector && cur.relatedLevel !== null
    && container.nodeType === 1 && ((container as Element).matches('[class*="title" i]') || hasNonEmptyTitleElem)
    && mainAttachmentWrapperTitle.test(runText.trim())) {
    cur.relatedLevel = null;
    return;
  }

  if (cur.inRelatedSelector || cur.relatedLevel !== null) {
    recordRunTargets(
      runTargets,
      0,
      runTargets.length,
      cur.inRelatedSelector,
      cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null),
      cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null),
      attr.nearestDownloadBox,
      attachmentMap,
      attachments,
    );
    return;
  }

  if (runText.length === 0 && runTargets.length === 0) return;

  const len = runText.length;
  const nextBoundaryOrNonSpace = new Int32Array(len + 1);
  const nextElemBoundary = new Int32Array(len + 1);
  const nextNonSpace = new Int32Array(len + 1);
  nextBoundaryOrNonSpace[len] = len;
  nextElemBoundary[len] = len;
  nextNonSpace[len] = len;
  for (let i = len - 1; i >= 0; i -= 1) {
    const isElemStart = nonEmptyAnchorStarts.has(i) || targetStarts.has(i);
    const isNonSpace = !/\s/u.test(runText[i]!);
    nextElemBoundary[i] = isElemStart ? i : nextElemBoundary[i + 1]!;
    nextNonSpace[i] = isNonSpace ? i : nextNonSpace[i + 1]!;
    if (isElemStart || isNonSpace) {
      nextBoundaryOrNonSpace[i] = i;
    } else {
      nextBoundaryOrNonSpace[i] = nextBoundaryOrNonSpace[i + 1]!;
    }
  }

  const titleLeadStarts = new Set<number>();
  for (let i = 0; i < titleSpans.length; i += 1) {
    const sp = titleSpans[i]!;
    const lead = nextNonSpace[sp.start]!;
    if (lead < sp.end) titleLeadStarts.add(lead);
  }
  const anchorDiff = new Int32Array(len + 1);
  for (let i = 0; i < hrefAnchorSpans.length; i += 1) {
    const sp = hrefAnchorSpans[i]!;
    anchorDiff[sp.start] += 1;
    anchorDiff[sp.end] -= 1;
  }
  const midState = new Uint8Array(len + 1);
  let anchorDepthAt = 0;
  let lastNonHoriz = '';
  let roundParenMidSentence = false;
  for (let i = 0; i < len; i += 1) {
    anchorDepthAt += anchorDiff[i]!;
    const ch = runText[i]!;
    if (ch === '（' || ch === '(') {
      if (midSentencePrevChar.test(lastNonHoriz)) roundParenMidSentence = true;
    }
    let state = titleLeadStarts.has(i) ? 4 : 0;
    if (anchorDepthAt > 0) state |= 8;
    if (midSentencePrevChar.test(lastNonHoriz)) state |= 1;
    if (roundParenMidSentence) state |= 2;
    midState[i] = state;
    if (ch === '）' || ch === ')' || lineOrSentenceBreakChar.test(ch)) {
      roundParenMidSentence = false;
    }
    if (lineOrSentenceBreakChar.test(ch)) {
      lastNonHoriz = '';
    } else if (!horizWhitespaceChar.test(ch)) {
      lastNonHoriz = ch;
    }
  }
  midState[len] = (midSentencePrevChar.test(lastNonHoriz) ? 1 : 0) | (roundParenMidSentence ? 2 : 0);

  const clampPostKeywordEnd = (kwEnd: number, rawEnd: number): number => {
    const bound = nextElemBoundary[kwEnd]!;
    return bound < rawEnd ? bound : rawEnd;
  };

  const triggers: number[] = [];
  if (len > 0) {
    inlineRelatedHeading.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRelatedHeading.exec(runText)) !== null) {
      const mStart = m.index;
      const kwLen = m[1]!.length;
      const kwEnd = mStart + kwLen;
      const rawEnd = clampPostKeywordEnd(kwEnd, mStart + m[0].length);
      let coreMatchEnd = rawEnd;
      while (coreMatchEnd > mStart && /\s/u.test(runText[coreMatchEnd - 1]!)) coreMatchEnd -= 1;
      const matchEnd = nextBoundaryOrNonSpace[coreMatchEnd]!;
      const st = midState[mStart]!;
      const isTitleLead = (st & 4) !== 0;
      const inHrefAnchor = (st & 8) !== 0;
      if (!isTitleLead) {
        if (!inHrefAnchor && (st & 2) !== 0 && !/[：:]/u.test(runText.slice(mStart, rawEnd))) {
          continue;
        }
        const tail = runText.slice(kwEnd, rawEnd);
        const isBareSpaceTail = tail.length > 0 && /^[^\S\r\n\u2028\u2029]+$/u.test(tail);
        if (isBareSpaceTail && (st & 1) !== 0) {
          const nextSlice = runText.slice(matchEnd, matchEnd + 16);
          const followedByMarker = matchEnd === len
            || nonEmptyAnchorStarts.has(matchEnd)
            || targetStarts.has(matchEnd)
            || /^[《「【[(（]/u.test(nextSlice)
            || leadingListItem.test(nextSlice);
          if (!followedByMarker) continue;
        }
      }
      triggers.push(matchEnd);
    }
    for (const target of runTargets) {
      if (target.start > 0) {
        const sliceStart = Math.max(0, target.start - 20);
        const prefixSlice = (sliceStart > 0 ? 'X' : '') + runText.slice(sliceStart, target.start);
        if (relatedBeforeTarget.test(prefixSlice)) triggers.push(target.start);
      }
      if (target.end < len) {
        const afterTarget = relatedHeadingAtBoundary.exec(runText.slice(target.end, target.end + 32));
        if (afterTarget) {
          const kwMatch = /^(?:相|推|延)[\s\S]*?(?:读|报)/u.exec(afterTarget[0]);
          const kwEnd = target.end + (kwMatch ? kwMatch[0].length : 4);
          let coreEndPos = clampPostKeywordEnd(kwEnd, target.end + afterTarget[0].length);
          while (coreEndPos > target.end && /\s/u.test(runText[coreEndPos - 1]!)) coreEndPos -= 1;
          triggers.push(nextBoundaryOrNonSpace[coreEndPos]!);
        }
      }
    }
    for (const endPos of anchorEnds) {
      if (endPos < len) {
        const afterAnchor = relatedAfterAnchor.exec(runText.slice(endPos, endPos + 32));
        if (afterAnchor) {
          const kwMatch = /^(?:相|推|延)[\s\S]*?(?:读|报)/u.exec(afterAnchor[0]);
          const kwEnd = endPos + (kwMatch ? kwMatch[0].length : 4);
          let coreEndPos = clampPostKeywordEnd(kwEnd, endPos + afterAnchor[0].length);
          while (coreEndPos > endPos && /\s/u.test(runText[coreEndPos - 1]!)) coreEndPos -= 1;
          triggers.push(nextBoundaryOrNonSpace[coreEndPos]!);
        } else {
          const p0 = nextBoundaryOrNonSpace[endPos]!;
          const bare = relatedBareKeywordCore.exec(runText.slice(p0, p0 + 24));
          if (bare) {
            const kwMatch = /^[【[]*\s*(?:相|推|延)[\s\S]*?(?:读|报)/u.exec(bare[0]);
            const kwEnd = p0 + (kwMatch ? kwMatch[0].length : bare[0].length);
            const clampedEnd = clampPostKeywordEnd(kwEnd, p0 + bare[0].length);
            const p1 = nextBoundaryOrNonSpace[clampedEnd]!;
            if (p1 === len || nonEmptyAnchorStarts.has(p1) || targetStarts.has(p1)) {
              triggers.push(p1);
            }
          }
        }
      }
    }
  }
  for (const t of titleLinkTriggers) {
    const leftOk = t.start === 0
      || t.isTitleElem
      || /[\s。！？；.!?【[(（]/u.test(runText[t.start - 1]!)
      || anchorEnds.has(t.start);
    if (!leftOk) continue;
    const nextPos = nextBoundaryOrNonSpace[t.end]!;
    if (!t.isTitleElem) {
      const st = midState[t.start]!;
      if (!t.hasHref && t.isRoundParen && (st & 2) !== 0) continue;
      if (!t.endsWithPunct && (st & 1) !== 0) {
        const nextSlice = runText.slice(nextPos, nextPos + 16);
        const followedByMarker = nextPos === len
          || nonEmptyAnchorStarts.has(nextPos)
          || targetStarts.has(nextPos)
          || /^[】\])））：:—\-·•《「【[(（]/u.test(nextSlice)
          || leadingListItem.test(nextSlice);
        if (!followedByMarker) continue;
      }
    }
    const rightOk = t.endsWithPunct
      || nextPos === len
      || nonEmptyAnchorStarts.has(nextPos)
      || targetStarts.has(nextPos)
      || titleLinkRightBoundary.test(runText.slice(t.end, t.end + 16));
    if (rightOk) triggers.push(nextPos);
  }
  if (triggers.length === 0) {
    recordRunTargets(runTargets, 0, runTargets.length, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap, attachments);
    return;
  }
  if (triggers.length > 1) {
    let sorted = true;
    for (let i = 1; i < triggers.length; i += 1) {
      if (triggers[i]! < triggers[i - 1]!) {
        sorted = false;
        break;
      }
    }
    if (!sorted) {
      const seen = new Uint8Array(len + 1);
      for (let i = 0; i < triggers.length; i += 1) seen[triggers[i]!] = 1;
      triggers.length = 0;
      for (let pos = 0; pos <= len; pos += 1) {
        if (seen[pos]) triggers.push(pos);
      }
    }
  }

  const anchorTrimmedEnd = new Map<number, number>();
  let nonTitleRunText = runText;
  if (topAnchorSpans.length > 0) {
    let out = '';
    let cursor = 0;
    for (let i = 0; i < topAnchorSpans.length; i += 1) {
      const span = topAnchorSpans[i]!;
      let s = span.start;
      let e = span.end;
      while (s < e && /\s/u.test(runText[s]!)) s += 1;
      while (e > s && /\s/u.test(runText[e - 1]!)) e -= 1;
      if (s < e) anchorTrimmedEnd.set(s, e);
      if (span.start > cursor) out += runText.slice(cursor, span.start);
      if (span.end > span.start) out += '\0'.repeat(span.end - span.start);
      cursor = span.end;
    }
    if (cursor < len) out += runText.slice(cursor);
    nonTitleRunText = out;
  }

  let targetIdx = 0;
  let prevGapEnd = 0;
  let cachedGapEnd = -1;
  let trimmedEnd = 0;
  let lastFullStop = -1;
  let lastProseChar = -1;
  let coreEnd = -1;
  let lastNonPunct = -1;
  let prevCloseGuillemet = -1;
  let prevCloseCorner = -1;
  let prevCloseLenticular = -1;
  let lastProseCueStart = -1;
  let nonSpaceIdx = 0;

  for (let ti = 0; ti < triggers.length; ti += 1) {
    const triggerEnd = triggers[ti]!;
    if (ti > 0 && triggerEnd === triggers[ti - 1]) continue;
    while (targetIdx < runTargets.length && runTargets[targetIdx]!.start < triggerEnd) targetIdx += 1;
    const nextTarget = targetIdx < runTargets.length ? runTargets[targetIdx]! : null;
    const gapEnd = nextTarget ? nextTarget.start : len;

    if (gapEnd !== cachedGapEnd) {
      const floor = cachedGapEnd === -1 ? 0 : prevGapEnd;
      prevGapEnd = cachedGapEnd === -1 ? 0 : cachedGapEnd;
      trimmedEnd = gapEnd;
      while (trimmedEnd > floor && /\s/u.test(runText[trimmedEnd - 1]!)) trimmedEnd -= 1;
      lastFullStop = -1;
      lastProseChar = -1;
      coreEnd = -1;
      lastNonPunct = -1;
      prevCloseGuillemet = -1;
      prevCloseCorner = -1;
      prevCloseLenticular = -1;
      for (let i = trimmedEnd - 1; i >= floor; i -= 1) {
        const ch = runText[i]!;
        if (lastFullStop === -1 && nonTitleRunText[i] === '。') lastFullStop = i;
        if (lastProseChar === -1 && !/[\s【】[\]()（）：:—\-·•]/u.test(ch)) lastProseChar = i;
        if (coreEnd === -1 && !/[\s"'”’）)】\]]/u.test(ch)) coreEnd = i;
        if (lastNonPunct === -1) {
          if (!/[\s。！？；.!?,，:：—\-·•]/u.test(ch)) lastNonPunct = i;
        } else {
          if (prevCloseGuillemet === -1 && ch === '》') prevCloseGuillemet = i;
          if (prevCloseCorner === -1 && ch === '」') prevCloseCorner = i;
          if (prevCloseLenticular === -1 && ch === '】') prevCloseLenticular = i;
        }
        if (
          lastFullStop !== -1
          && lastProseChar !== -1
          && coreEnd !== -1
          && lastNonPunct !== -1
          && prevCloseGuillemet !== -1
          && prevCloseCorner !== -1
          && prevCloseLenticular !== -1
        ) {
          break;
        }
      }
      lastProseCueStart = -1;
      if (trimmedEnd > floor) {
        const gapSlice = nonTitleRunText.slice(floor, trimmedEnd);
        proseBodyCueGlobal.lastIndex = 0;
        let cm: RegExpExecArray | null;
        while ((cm = proseBodyCueGlobal.exec(gapSlice)) !== null) {
          lastProseCueStart = floor + cm.index;
        }
        if (nextTarget !== null && !foreignReportRefCue.test(gapSlice)) {
          const tailStart = Math.max(0, gapSlice.length - 24);
          const tailSlice = gapSlice.slice(tailStart);
          const tm = proseDownloadTailCue.exec(tailSlice);
          if (tm) {
            const cuePos = floor + tailStart + tm.index;
            if (cuePos > lastProseCueStart) lastProseCueStart = cuePos;
          }
        }
      }
      cachedGapEnd = gapEnd;
      prevGapEnd = gapEnd;
    }

    if (nonSpaceIdx < triggerEnd) nonSpaceIdx = triggerEnd;
    while (nonSpaceIdx < trimmedEnd && /\s/u.test(runText[nonSpaceIdx]!)) nonSpaceIdx += 1;

    let isProse: boolean;
    if (lastProseChar < triggerEnd) {
      isProse = false;
    } else {
      const openChar = nonSpaceIdx < trimmedEnd ? runText[nonSpaceIdx] : '';
      const closeChar = openChar === '《' ? '》' : openChar === '「' ? '」' : openChar === '【' ? '】' : '';
      const prevClose = closeChar === '》'
        ? prevCloseGuillemet
        : closeChar === '」'
          ? prevCloseCorner
          : closeChar === '】'
            ? prevCloseLenticular
            : -1;
      const isBareQuotedTitle = Boolean(
        closeChar && lastNonPunct > nonSpaceIdx && runText[lastNonPunct] === closeChar
        && prevClose <= nonSpaceIdx,
      );
      const linkedEnd = anchorTrimmedEnd.get(nonSpaceIdx) ?? -1;
      const isBareLinkedTitle = linkedEnd !== -1 && (linkedEnd === trimmedEnd || linkedEnd === lastNonPunct + 1);
      const isNumbered = nonSpaceIdx < trimmedEnd && leadingListItem.test(runText.slice(nonSpaceIdx, nonSpaceIdx + 16));
      if (isNumbered || isBareQuotedTitle || isBareLinkedTitle) {
        isProse = false;
      } else if (
        lastFullStop >= triggerEnd
        || lastProseCueStart >= triggerEnd
        || (coreEnd >= nonSpaceIdx && (
          /[。！？；!?]/u.test(nonTitleRunText[coreEnd]!)
          || (nonTitleRunText[coreEnd]! === '.' && coreEnd > nonSpaceIdx && !/[\d.]/u.test(runText[coreEnd - 1]!))
        ))
      ) {
        isProse = true;
      } else {
        isProse = nextTarget === null && !followedByCandidate;
      }
    }
    if (isProse) continue;

    recordRunTargets(runTargets, 0, targetIdx, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap, attachments);
    recordRunTargets(
      runTargets,
      targetIdx,
      runTargets.length,
      false,
      cur.outerRelated || !cur.isDownloadBox,
      cur.boxAncestorLocalRelated || cur.isDownloadBox,
      attr.nearestDownloadBox,
      attachmentMap,
      attachments,
    );
    cur.relatedLevel = 2;
    return;
  }

  recordRunTargets(runTargets, 0, runTargets.length, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap, attachments);
}

/** 单趟前序文档作用域遍历：严格 O(N)，零递归，隔离根边界与多层下载框。 */
function analyzeEastmoneySections(document: Document, baseUrl: string) {
  const flags = precomputeDomFlags(document, baseUrl);
  const scripts: Element[] = [];
  const attachmentMap = new WeakSet<Element>();
  const attachments: AttachmentEntry[] = [];
  const scopeStack: Scope[] = [{
    relatedLevel: null,
    inRelatedSelector: false,
    inList: false,
    isDownloadBox: false,
    outerRelated: false,
    boxAncestorLocalRelated: false,
    inAttachmentLink: false,
  }];
  const attrStack: AttrScope[] = [{
    nearestEncodeUrl: null,
    nearestInfoCode: null,
    nearestDownloadBox: null,
    inZwinfo: false,
    inHrefAnchor: false,
  }];

  type DfsFrame =
    | { kind: 'visit'; node: Element; inZwinfoDirect: boolean; followedByCandidate: boolean }
    | { kind: 'run'; container: Element | Document; nodes: ChildNode[]; onlyRun: boolean; followedByCandidate: boolean; hasRunCandidate: boolean }
    | { kind: 'leave'; popScope: boolean; popAttr: boolean };
  const dfsStack: DfsFrame[] = [];

  const enqueueChildren = (
    container: Element | Document,
    parentFollowedByCandidate: boolean,
    includeLeave?: { popScope: boolean; popAttr: boolean },
  ) => {
    const children: NodeListOf<ChildNode> = container.childNodes;
    const steps: DfsFrame[] = [];
    let runNodes: ChildNode[] = [];
    let runHasMeaningful = false;
    let runHasCandidate = false;
    const flushRun = () => {
      if (runNodes.length > 0) {
        if (runHasMeaningful) {
          steps.push({
            kind: 'run',
            container,
            nodes: runNodes,
            onlyRun: false,
            followedByCandidate: false,
            hasRunCandidate: runHasCandidate,
          });
        }
        runNodes = [];
        runHasMeaningful = false;
        runHasCandidate = false;
      }
    };
    const parentIsZwinfo = container.nodeType === 1 && (container as Element).id === 'zwinfo';
    for (let i = 0; i < children.length; i += 1) {
      const child: ChildNode = children[i]!;
      if (child.nodeType === 3) {
        const text = child.textContent ?? '';
        if (text.length > 0) {
          runNodes.push(child);
          if (!runHasMeaningful && /\S/u.test(text)) runHasMeaningful = true;
        }
      } else if (child.nodeType === 1) {
        const ce = child as Element;
        if (flags.canFlattenInline.get(ce)) {
          runNodes.push(child);
          runHasMeaningful = true;
          if (flags.hasCandidateBeforeHeading.get(ce)) runHasCandidate = true;
        } else {
          flushRun();
          steps.push({ kind: 'visit', node: ce, inZwinfoDirect: parentIsZwinfo, followedByCandidate: false });
        }
      }
    }
    flushRun();
    if (steps.length === 1 && steps[0]!.kind === 'run') {
      steps[0]!.onlyRun = true;
    }
    let seenCandidateAfter = parentFollowedByCandidate;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i]!;
      if (step.kind === 'run') {
        step.followedByCandidate = seenCandidateAfter;
        if (step.hasRunCandidate) seenCandidateAfter = true;
      } else if (step.kind === 'visit') {
        const ce = step.node;
        step.followedByCandidate = seenCandidateAfter;
        if (flags.hasCandidateBeforeHeading.get(ce)) {
          seenCandidateAfter = true;
        } else if (flags.stopsOuterRelated.get(ce)) {
          seenCandidateAfter = false;
        }
      }
    }
    if (includeLeave && (includeLeave.popScope || includeLeave.popAttr)) dfsStack.push({ kind: 'leave', ...includeLeave });
    for (let i = steps.length - 1; i >= 0; i -= 1) dfsStack.push(steps[i]!);
  };

  enqueueChildren(document, false);

  while (dfsStack.length) {
    const frame = dfsStack.pop()!;
    if (frame.kind === 'leave') {
      if (frame.popScope) scopeStack.pop();
      if (frame.popAttr) attrStack.pop();
      continue;
    }
    const cur = scopeStack[scopeStack.length - 1]!;
    const attr = attrStack[attrStack.length - 1]!;
    if (frame.kind === 'run') {
      scanInlineRun(
        frame.container,
        frame.nodes,
        frame.onlyRun,
        frame.followedByCandidate,
        baseUrl,
        flags,
        cur,
        attr,
        attachmentMap,
        attachments,
      );
      continue;
    }

    const el = frame.node;
    if (nonContentTags.has(el.tagName)) continue;
    if (el.tagName === 'SCRIPT') {
      if (
        !el.hasAttribute('src')
        && !el.matches(relatedSelector)
        && !cur.inRelatedSelector
        && cur.relatedLevel === null
        && !cur.boxAncestorLocalRelated
        && !cur.outerRelated
      ) {
        scripts.push(el);
      }
      continue;
    }

    if (el.tagName === 'IFRAME') {
      if (frame.inZwinfoDirect && isEastmoneyPdfHref(el.getAttribute('src'), baseUrl) && !attachmentMap.has(el)) {
        const isRel = cur.inRelatedSelector || el.matches(relatedSelector);
        attachmentMap.add(el);
        attachments.push({
          element: el,
          info: {
            inRelatedSelector: isRel,
            outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null),
            localRelated: cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null),
            owner: el.getAttribute('data-encode-url') ?? attr.nearestEncodeUrl,
            expectedInfoCode: el.getAttribute('data-info-code') ?? attr.nearestInfoCode,
            downloadBox: attr.nearestDownloadBox,
          },
        });
      }
      continue;
    }

    const isRelSelector = el.matches(relatedSelector);
    const isDownloadBox = el.matches('.report-download');
    const isRootBoundary = el.matches(rootBoundaryContainers);
    const isIsolated = isRelSelector || isDownloadBox || isRootBoundary || isolatedContainerTags.has(el.tagName);

    const hasEncodeAttr = el.hasAttribute('data-encode-url');
    const hasInfoAttr = el.hasAttribute('data-info-code');
    const isZwinfoId = el.id === 'zwinfo';
    const nextEncodeUrl = hasEncodeAttr ? el.getAttribute('data-encode-url') : attr.nearestEncodeUrl;
    const nextInfoCode = hasInfoAttr ? el.getAttribute('data-info-code') : attr.nearestInfoCode;

    const isPdfAnchor = el.tagName === 'A'
      && isEastmoneyPdfHref(el.getAttribute('href'), baseUrl)
      && (isDownloadBox || (attr.inZwinfo && el.hasAttribute('download')) || attr.nearestDownloadBox !== null || nextEncodeUrl !== null);

    if (isPdfAnchor && !attachmentMap.has(el)) {
      const outerRel = cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null);
      const localRel = cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null);
      const anchorText = (flags.ownText.get(el) ?? '').trim();
      attachmentMap.add(el);
      attachments.push({
        element: el,
        info: {
          inRelatedSelector: cur.inRelatedSelector || isRelSelector || relatedTitle.test(anchorText),
          outerRelated: outerRel,
          localRelated: localRel,
          owner: nextEncodeUrl,
          expectedInfoCode: nextInfoCode,
          downloadBox: isDownloadBox ? el : attr.nearestDownloadBox,
        },
      });
    }

    let popScope = false;
    if (isIsolated || isPdfAnchor) {
      popScope = true;
      if (isRelSelector) {
        scopeStack.push({
          ...cur,
          inRelatedSelector: true,
          inList: cur.inList || listTags.has(el.tagName),
          inAttachmentLink: cur.inAttachmentLink || isPdfAnchor,
        });
      } else if (isDownloadBox) {
        scopeStack.push({
          relatedLevel: null,
          inRelatedSelector: cur.inRelatedSelector,
          inList: cur.inList || listTags.has(el.tagName),
          isDownloadBox: true,
          outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null),
          boxAncestorLocalRelated: cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null),
          inAttachmentLink: cur.inAttachmentLink || isPdfAnchor,
        });
      } else {
        scopeStack.push({
          ...cur,
          inList: cur.inList || listTags.has(el.tagName),
          inAttachmentLink: cur.inAttachmentLink || isPdfAnchor,
        });
      }
    }

    const isNonFragmentHrefAnchor = el.tagName === 'A'
      && el.hasAttribute('href')
      && (!(el.getAttribute('href') ?? '').trim().startsWith('#') || hasEncodeAttr || hasInfoAttr || nextEncodeUrl !== null || nextInfoCode !== null);
    const pushAttr = hasEncodeAttr || hasInfoAttr || isZwinfoId || isDownloadBox || isNonFragmentHrefAnchor;
    if (pushAttr) {
      attrStack.push({
        nearestEncodeUrl: nextEncodeUrl,
        nearestInfoCode: nextInfoCode,
        nearestDownloadBox: isDownloadBox ? el : attr.nearestDownloadBox,
        inZwinfo: attr.inZwinfo || isZwinfoId,
        inHrefAnchor: attr.inHrefAnchor || isNonFragmentHrefAnchor,
      });
    }

    const activeScope = scopeStack[scopeStack.length - 1]!;
    const activeAttr = attrStack[attrStack.length - 1]!;
    if (el.matches(explicitSectionHeadings)
      && !el.matches(`${rootBoundaryContainers},.report-download`)
      && !flags.hasRootBoundary.get(el)
      && !flags.hasNestedExplicitHeading.get(el)) {
      const text = (flags.ownText.get(el) ?? '').trim();
      if (text.length > 0) {
        if (relatedTitle.test(text)) {
          const targetScope = isPdfAnchor && !isIsolated ? cur : activeScope;
          if (!targetScope.inRelatedSelector) {
            const level = headingLevel(el);
            targetScope.relatedLevel = targetScope.relatedLevel === null ? level : Math.min(targetScope.relatedLevel, level);
            if (targetScope !== activeScope) activeScope.relatedLevel = targetScope.relatedLevel;
          }
        } else if (
          !activeScope.inAttachmentLink
          && !activeAttr.inHrefAnchor
          && !activeScope.inRelatedSelector
          && activeScope.relatedLevel !== null
          && text.length <= 64
          && !/[。！？；]/u.test(text)
        ) {
          const shouldStop = activeScope.inList
            ? mainAttachmentHeading.test(text)
            : (headingLevel(el) <= activeScope.relatedLevel || mainAttachmentHeading.test(text));
          if (shouldStop) activeScope.relatedLevel = null;
        }
      }
    }

    const childFollowedByCandidate = popScope ? false : frame.followedByCandidate;
    enqueueChildren(el, childFollowedByCandidate, { popScope, popAttr: pushAttr });
  }

  return { scripts, attachments };
}

/** 复用现有 HTML 解析依赖；仅返回同源固定格式 PDF 定位，不下载、不执行脚本。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const { document } = parseHTML(decodeUtf8(rawBytes));
  const candidates = new Map<string, string>(), declaredCodes = new Set<string>();
  const sections = analyzeEastmoneySections(document, bound.url.href);
  const collect = (candidate: string, expectedInfoCode?: string | null) => {
    let url: URL;
    try { url = new URL(candidate, bound.url); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.port || url.username || url.password) return;
    const match = /^\/pdf\/H3_(AP\d{8,20})_1\.pdf$/u.exec(url.pathname);
    if (match && expectedInfoCode && match[1] !== expectedInfoCode) return invalid('研报详情标识与附件标识不符。');
    if (match) candidates.set(url.href, match[1]!);
  };
  // 只读详情变量的静态赋值。普通脚本中的字符串、相关推荐和任意独立链接没有报告归属。
  for (const script of sections.scripts) {
    let source = (script.textContent ?? '').trim();
    // 同一脚本可依次声明元数据和附件。只消费可识别的静态赋值，不执行页面代码。
    while (source) {
      const pdf = /^window\.pdf\s*=\s*(["'])(https:\/\/pdf\.dfcfw\.com\/pdf\/H3_AP\d{8,20}_1\.pdf)\1\s*(?:;|$)/u.exec(source);
      if (pdf) {
        collect(pdf[2]);
        source = source.slice(pdf[0].length).trimStart();
        continue;
      }
      const assignment = /^(?:(?:var|let|const)\s+|window\.)?zwinfo\s*=\s*(\{[\s\S]*?\})\s*(?:;|$)/u.exec(source);
      if (!assignment) {
        const code = /^(?:window\s*\.\s*)?zwinfo\s*\.\s*infoCode\s*=\s*(["'])(AP\d{8,20})\1\s*(?:;|$)/u.exec(source);
        if (code) {
          declaredCodes.add(code[2]);
          source = source.slice(code[0].length).trimStart();
          continue;
        }
        if (/\b(?:zwinfo(?:\s*\.\s*infoCode)?|window\s*\.\s*pdf)\s*=(?!=)/u.test(source))
          return invalid('详情脚本包含无法静态核对的研报或附件声明。');
        break;
      }
      const info = detailMetadata(assignment[1]);
      if (!info) return invalid('研报详情元数据无法核对。');
      if (info.encodeUrl !== undefined && info.encodeUrl !== request.encodeUrl) return invalid('研报详情标识与请求不符。');
      const infoCode = infoCodeOf(info.infoCode);
      if (infoCode) declaredCodes.add(infoCode);
      for (const key of ['pdfUrl', 'pdf_url', 'attachUrl', 'attach_url'])
        if (typeof info[key] === 'string') collect(info[key], infoCode);
      source = source.slice(assignment[0].length).trimStart();
    }
  }
  for (const { element, info: status } of sections.attachments) {
    if (status.owner != null && status.owner !== request.encodeUrl) continue;
    const boxOwner = status.downloadBox?.getAttribute('data-encode-url');
    const boxInfoCode = status.downloadBox?.getAttribute('data-info-code');
    const attestedMainDownload = Boolean(
      status.downloadBox
      && boxOwner === request.encodeUrl && status.owner === request.encodeUrl
      && boxInfoCode && declaredCodes.has(boxInfoCode) && status.expectedInfoCode === boxInfoCode
      && !status.inRelatedSelector
      && !status.localRelated,
    );
    if (status.inRelatedSelector || status.localRelated || (!attestedMainDownload && status.outerRelated)) continue;
    collect(element.getAttribute('href') ?? element.getAttribute('src')!, status.expectedInfoCode);
  }
  if (new Set([...declaredCodes, ...candidates.values()]).size > 1) return invalid('研报详情元数据与附件声明指向不同的 infoCode。');
  if (candidates.size !== 1) return invalid(candidates.size ? '研报详情存在多个不同附件定位，须明确选择。' : '研报详情没有可验证的 PDF 附件定位。');
  const [pdfUrl, infoCode] = [...candidates.entries()][0]!;
  return { decoderVersion: 'eastmoney-report-detail/1' as const, providerId: 'eastmoney' as const, request: bound.request,
    detailUrl: bound.url.href, infoCode, pdfUrl, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    attachmentFetched: false as const, historyAvailability: 'not_established' as const };
}

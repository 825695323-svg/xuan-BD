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

const relatedTitle = /^[【[(\s（]*(?:相关阅读|相关研报|推荐阅读|延伸阅读)(?:$|[\s】\])））：:—\-·•]+|(?=[《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳]))/u;
const relatedWrapperTitle = /^[【[(\s（]*(?:相关阅读|相关研报|推荐阅读|延伸阅读)[\s】\])））：:]*$/u;
const inlineRelatedHeading = /(?:^|(?<=[\s。！？；.!?【[(（]))(?:相关阅读|相关研报|推荐阅读|延伸阅读)(?:$|[\s】\])））：:—\-·•]+|(?=[《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳]))/gu;
const mainAttachmentHeading = /^[【[(\s]*(?:本?研报附件|本?报告附件|正文附件|原文附件|研报原文|原文下载|下载本?研报|下载原文|附件下载)(?:$|[\s】\])：:—\-·•（(])/u;
const explicitSectionHeadings = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend,dt';
const sectionHeadings = `${explicitSectionHeadings},[class*="title" i]`;
const rootBoundaryContainers = '#zwinfo,article,section,main,body,html';
const standaloneTitleBlocks = 'div,p,header,summary,figcaption';
const spillableInlineBlocks = 'div,p,header,summary,figcaption';
const skippedScanTags = new Set([
  'HTML', 'HEAD', 'META', 'LINK', 'TITLE', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE',
  'A', 'IFRAME', 'BR', 'HR', 'WBR', 'IMG', 'INPUT', 'SVG', 'PICTURE', 'SOURCE', 'CANVAS',
  'VIDEO', 'AUDIO', 'AREA', 'BASE', 'COL', 'EMBED', 'PARAM', 'TRACK', 'OBJECT',
]);
const relatedSelector = 'aside,nav,footer,[role="navigation"],[aria-label*="相关"],[aria-label*="推荐"],[aria-label*="延伸阅读"],'
  + '[class*="related" i],[id*="related" i],[class*="recommend" i],[id*="recommend" i],.rel-list,.xgyd,.xgyb';

function headingLevel(element: Element): number {
  if (/^H[1-6]$/u.test(element.tagName)) return Number(element.tagName[1]);
  const aria = element.getAttribute('aria-level');
  return aria && /^[1-6]$/u.test(aria) ? Number(aria) : 2;
}

const inlineWrapperElements = 'div,span,header,strong,b,em,i,small,u,mark,p';
const inlineTextElements = 'span,strong,b,em,i,small,u,mark';
const inlineFlowElements = 'span,strong,b,em,i,small,u,mark,font,sub,sup,label,abbr,cite,code,time,ins,del,s,q,bdi,bdo,ruby,rt,rp,kbd,samp,var,data,dfn';
const decorativeInlineTags = new Set(['WBR', 'IMG', 'INPUT', 'SVG', 'PICTURE', 'SOURCE', 'CANVAS']);
const inlineNonBlockForbidden = 'a,iframe,ul,ol,li,dl,table,section,article,aside,nav,main,body,html,#zwinfo,.report-download,div,p,h1,h2,h3,h4,h5,h6,[role="heading"],legend,dt,form,blockquote,pre';

function isHarmlessWrapper(parent: Element, heading: Element): boolean {
  if (heading.matches(`${rootBoundaryContainers},.report-download`)
    || parent.matches(`${rootBoundaryContainers},.report-download`)
    || !parent.matches(inlineWrapperElements)) return false;
  if (!(parent.textContent?.trim() === heading.textContent?.trim() || relatedWrapperTitle.test(parent.textContent?.trim() ?? ''))) return false;
  for (const child of parent.children) {
    if (child === heading) continue;
    if (['BR', 'HR', 'WBR'].includes(child.tagName)) continue;
    if (decorativeInlineTags.has(child.tagName)
      && !(child.textContent ?? '').trim() && !child.querySelector('a,iframe')) continue;
    if (child.matches(inlineTextElements)
      && !(child.textContent ?? '').trim() && !child.querySelector('a,iframe')) continue;
    return false;
  }
  return true;
}

function isPureInlineTitleBlock(element: Element): boolean {
  return !element.querySelector(inlineNonBlockForbidden);
}

function outermostDownloadBox(element: Element): Element | null {
  let box = element.closest('.report-download');
  while (box?.parentElement) {
    const outer = box.parentElement.closest('.report-download');
    if (!outer) break;
    box = outer;
  }
  return box;
}

function leadingHeading(element: Element): Element | null {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (current.matches(sectionHeadings)) return current;
    if (!current.matches('div,section,article,header,main')) return null;
    let first: Element | null = null;
    for (const child of current.childNodes) {
      if (child.nodeType === 3) {
        if ((child.textContent ?? '').trim()) return null;
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (['BR', 'HR', 'WBR'].includes(el.tagName)) continue;
        first = el;
        break;
      }
    }
    current = first;
  }
  return null;
}

type InlinePiece = { node: ChildNode; text: string; start: number; end: number };
type InlineSegment = { pieces: InlinePiece[]; endedAt: Element | null };

const leadingListItem = /^[\s\n]*(?:\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳])(?=$|[\s\n\p{L}\p{N}《「【])/u;

function pushChildNodesReversed(parent: Node, stack: ChildNode[]): void {
  const children = parent.childNodes;
  for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
}

function collectInlineSegments(container: Document | Element): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let pieces: InlinePiece[] = [], offset = 0;
  const stack: ChildNode[] = [];
  pushChildNodesReversed(container, stack);
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      const text = node.textContent ?? '';
      if (!text) continue;
      pieces.push({ node, text, start: offset, end: offset + text.length });
      offset += text.length;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.tagName === 'BR' || el.tagName === 'HR') {
      pieces.push({ node: el, text: '\n', start: offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    if (el.matches(relatedSelector) || el.matches(`${rootBoundaryContainers},.report-download`)) {
      if (pieces.length) segments.push({ pieces, endedAt: el });
      pieces = [];
      offset = 0;
      continue;
    }
    if (decorativeInlineTags.has(el.tagName) && (el.childNodes.length === 0 || !el.querySelector('a,iframe'))) continue;
    if (el.matches(inlineFlowElements) && !el.matches(explicitSectionHeadings)) {
      pushChildNodesReversed(el, stack);
      continue;
    }
    if (pieces.length) segments.push({ pieces, endedAt: el });
    pieces = [];
    offset = 0;
  }
  if (pieces.length) segments.push({ pieces, endedAt: null });
  return segments;
}

function isStoppingHeading(heading: Element, level: number): boolean {
  if (heading.tagName === 'A' && heading.getAttribute('role') !== 'heading') return false;
  const text = heading.textContent?.trim() ?? '';
  if (relatedTitle.test(text)) return false;
  if (heading.matches(explicitSectionHeadings)) {
    return headingLevel(heading) <= level || mainAttachmentHeading.test(text);
  }
  return !heading.matches(inlineFlowElements)
    && !heading.closest('ul,ol,li,a')
    && mainAttachmentHeading.test(text);
}

function findFirstStoppingHeading(element: Element, level: number): Element | null {
  if (element.matches(sectionHeadings) && isStoppingHeading(element, level)) return element;
  for (const heading of element.querySelectorAll(sectionHeadings)) {
    if (isStoppingHeading(heading, level)) return heading;
  }
  return null;
}

function walkBeforeStop(root: Node, stopHeading: Element, onBefore: (node: ChildNode) => boolean | void): void {
  if (stopHeading === root) return;
  const pathToStop = new Set<Node>();
  for (let anc: Node | null = stopHeading; anc && anc !== root; anc = anc.parentNode) pathToStop.add(anc);
  let current: Node | null = root;
  while (current && current !== stopHeading) {
    let nextCursor: Node | null = null;
    const children: NodeListOf<ChildNode> = current.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      const child: ChildNode = children[i]!;
      if (child === stopHeading || pathToStop.has(child)) {
        nextCursor = child;
        break;
      }
      if (onBefore(child) === true) return;
    }
    current = nextCursor;
  }
}

function hasLinkBeforeStoppingHeading(container: Element, stopHeading: Element): boolean {
  let found = false;
  walkBeforeStop(container, stopHeading, child => {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.matches('a,iframe') || Boolean(el.querySelector('a,iframe'))) {
        found = true;
        return true;
      }
    }
  });
  return found;
}

/** 从阅读小节标题到同级或更高标题之间的内容，限定在同一正文容器内。 */
function relatedSections(document: Document) {
  const excluded = new WeakSet<Node>();
  const selfRelatedBoxes = new WeakSet<Element>();
  const isExcluded = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) if (excluded.has(node)) return true;
    return false;
  };
  const hasInternalExclusion = (element: Element, boundary: Element): boolean => {
    if (selfRelatedBoxes.has(boundary)) return true;
    for (let node: Element | null = element; node && node !== boundary; node = node.parentElement) {
      if (excluded.has(node) || selfRelatedBoxes.has(node)) return true;
    }
    return false;
  };
  function markFollowing(title: Node, level: number): boolean {
    for (let node: Node | null = title.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === 1) {
        const next = node as Element;
        const stopHeading = findFirstStoppingHeading(next, level);
        if (stopHeading) {
          if (stopHeading !== next) walkBeforeStop(next, stopHeading, child => { excluded.add(child); });
          return true;
        }
      }
      excluded.add(node);
    }
    return false;
  }
  function markFollowingWithinContainer(startNode: ChildNode, container: Document | Element, level: number): boolean {
    let current: Node | null = startNode;
    while (current && current !== container) {
      if (current.nodeType === 1 && (current as Element).matches(`${rootBoundaryContainers},.report-download`)) return true;
      if (markFollowing(current, level)) return true;
      current = current.parentNode;
    }
    return false;
  }
  function scanContainer(container: Document | Element, allowParentSiblings: boolean): void {
    // 兼容正文中以普通句子结尾或带前缀的拆散行内相关阅读标题（如“正文<span> </span><em>相关</em>阅读：”）。
    for (const segment of collectInlineSegments(container)) {
      if (excluded.has(segment.pieces[0]!.node)) continue;
      const fullText = segment.pieces.map(piece => piece.text).join('');
      inlineRelatedHeading.lastIndex = 0;
      let match = inlineRelatedHeading.exec(fullText);
      if (!match) continue;

      const hasTrailingLinkOrList = Boolean(
        segment.endedAt && (segment.endedAt.matches('a,iframe,ul,ol') || (() => {
          const stopHeading = findFirstStoppingHeading(segment.endedAt, 2);
          return stopHeading
            ? hasLinkBeforeStoppingHeading(segment.endedAt, stopHeading)
            : Boolean(segment.endedAt.querySelector('a,iframe'));
        })()),
      );
      let trimmedEnd = fullText.length;
      while (trimmedEnd > 0 && /\s/u.test(fullText[trimmedEnd - 1]!)) trimmedEnd -= 1;
      const lastFullStop = trimmedEnd > 0 ? fullText.lastIndexOf('。', trimmedEnd - 1) : -1;
      let lastProseChar = trimmedEnd - 1;
      while (lastProseChar >= 0 && /[\s【】[\]()（）：:—\-·•]/u.test(fullText[lastProseChar]!)) lastProseChar -= 1;
      let coreEnd = trimmedEnd - 1;
      while (coreEnd >= 0 && /[\s"'”’）)】\]]/u.test(fullText[coreEnd]!)) coreEnd -= 1;

      let shouldStopContainer = false;
      let pieceIndex = 0;
      let nonSpaceIdx = 0;
      do {
        const matchEnd = match.index + match[0].length;
        while (pieceIndex + 1 < segment.pieces.length && segment.pieces[pieceIndex]!.end < matchEnd) pieceIndex += 1;
        if (nonSpaceIdx < matchEnd) nonSpaceIdx = matchEnd;
        while (nonSpaceIdx < trimmedEnd && /\s/u.test(fullText[nonSpaceIdx]!)) nonSpaceIdx += 1;

        let isProse = false;
        if (!hasTrailingLinkOrList) {
          isProse = lastProseChar >= matchEnd;
        } else if (nonSpaceIdx < trimmedEnd && !leadingListItem.test(fullText.slice(nonSpaceIdx, nonSpaceIdx + 16))) {
          if (lastFullStop >= matchEnd) {
            isProse = true;
          } else if (coreEnd >= nonSpaceIdx) {
            const lastCh = fullText[coreEnd]!;
            if (/[。！？；!?]/u.test(lastCh)
              || (lastCh === '.' && coreEnd > nonSpaceIdx && !/[\d.]/u.test(fullText[coreEnd - 1]!))) {
              isProse = true;
            }
          }
        }
        if (isProse) continue;

        const targetPiece = segment.pieces[pieceIndex]!;
        const stoppedInside = markFollowingWithinContainer(targetPiece.node, container, 2);
        if (!stoppedInside) {
          if (allowParentSiblings && container.nodeType === 1 && !(container as Element).matches(rootBoundaryContainers)) {
            markFollowing(container, 2);
          }
          shouldStopContainer = true;
        }
        break;
      } while ((match = inlineRelatedHeading.exec(fullText)) !== null);
      if (shouldStopContainer) break;
    }
  }
  for (const element of document.querySelectorAll('*')) {
    if (skippedScanTags.has(element.tagName) && element.getAttribute('role') !== 'heading') continue;
    const isBoundaryContainer = element.matches(`${rootBoundaryContainers},.report-download`);
    const isExplicitHeading = element.matches(explicitSectionHeadings);
    const isSectionHeading = isExplicitHeading || element.matches('[class*="title" i]');
    const isInlineFlow = element.matches(inlineFlowElements);
    if (isInlineFlow && !isSectionHeading && !isBoundaryContainer) continue;
    if (element.closest(relatedSelector)) continue;
    const downloadBox = outermostDownloadBox(element);
    const alreadyExcluded = downloadBox ? hasInternalExclusion(element, downloadBox) : isExcluded(element);
    if (alreadyExcluded) continue;
    const isStandaloneBlockTitle = !isInlineFlow
      && element.matches(standaloneTitleBlocks)
      && !isBoundaryContainer
      && isPureInlineTitleBlock(element)
      && relatedWrapperTitle.test(element.textContent?.trim() ?? '');
    if (isSectionHeading || isStandaloneBlockTitle) {
      let heading = element;
      // 标题可以独占一层包装（可含 <br> 等空排版标签），链接列表与包装节点同级。
      while (heading.parentElement && isHarmlessWrapper(heading.parentElement, heading)) heading = heading.parentElement;
      if ((isExplicitHeading || !isSectionHeading || !isInlineFlow || heading !== element)
        && !heading.querySelector('#zwinfo,.report-download')
        && relatedTitle.test(heading.textContent?.trim() ?? '')) {
        excluded.add(heading);
        if (heading.matches('.report-download')) selfRelatedBoxes.add(heading);
        if (!heading.matches(`${rootBoundaryContainers},.report-download`)) {
          markFollowing(heading, headingLevel(element));
        }
        continue;
      }
    }
    if ((isInlineFlow && !isBoundaryContainer) || isExplicitHeading) continue;
    const allowParentSiblings = element.matches(spillableInlineBlocks) && !isBoundaryContainer;
    scanContainer(element, allowParentSiblings);
  }
  scanContainer(document, false);
  return {
    isRelated(element: Element) {
      if (element.closest(relatedSelector) || element.tagName === 'A' && relatedTitle.test(element.textContent?.trim() ?? '')) return true;
      return isExcluded(element);
    },
    hasInternalExclusion,
  };
}

/** 复用现有 HTML 解析依赖；仅返回同源固定格式 PDF 定位，不下载、不执行脚本。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const { document } = parseHTML(decodeUtf8(rawBytes));
  const candidates = new Map<string, string>(), declaredCodes = new Set<string>();
  const related = relatedSections(document);
  const collect = (candidate: string, expectedInfoCode?: string | null) => {
    let url: URL;
    try { url = new URL(candidate, bound.url); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.port || url.username || url.password) return;
    const match = /^\/pdf\/H3_(AP\d{8,20})_1\.pdf$/u.exec(url.pathname);
    if (match && expectedInfoCode && match[1] !== expectedInfoCode) return invalid('研报详情标识与附件标识不符。');
    if (match) candidates.set(url.href, match[1]!);
  };
  // 只读详情变量的静态赋值。普通脚本中的字符串、相关推荐和任意独立链接没有报告归属。
  for (const script of document.querySelectorAll('script:not([src])')) {
    if (related.isRelated(script)) continue;
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
  const attachment = '#zwinfo a[download][href], #zwinfo > iframe[src], .report-download a[href], a.report-download[href], a[data-encode-url][href], [data-encode-url] a[href]';
  for (const element of document.querySelectorAll(attachment)) {
    const owner = element.closest('[data-encode-url]')?.getAttribute('data-encode-url');
    if (owner != null && owner !== request.encodeUrl) continue;
    const expectedInfoCode = element.closest('[data-info-code]')?.getAttribute('data-info-code');
    const downloadBox = element.closest('.report-download') ?? (element.matches('a.report-download[href]') ? element : null);
    const outerBox = outermostDownloadBox(element);
    const boxOwner = downloadBox?.getAttribute('data-encode-url');
    const boxInfoCode = downloadBox?.getAttribute('data-info-code');
    const boxHeading = downloadBox ? leadingHeading(downloadBox) : null;
    const outerHeading = outerBox ? leadingHeading(outerBox) : null;
    const attestedMainDownload = Boolean(
      downloadBox
      && boxOwner === request.encodeUrl && owner === request.encodeUrl
      && boxInfoCode && declaredCodes.has(boxInfoCode) && expectedInfoCode === boxInfoCode
      && !element.closest(relatedSelector)
      && !(element.tagName === 'A' && relatedTitle.test(element.textContent?.trim() ?? ''))
      && !relatedTitle.test(downloadBox.textContent?.trim() ?? '')
      && !(outerBox && relatedTitle.test(outerBox.textContent?.trim() ?? ''))
      && !(boxHeading && relatedTitle.test(boxHeading.textContent?.trim() ?? ''))
      && !(outerHeading && relatedTitle.test(outerHeading.textContent?.trim() ?? ''))
      && !related.hasInternalExclusion(element, downloadBox)
      && !(outerBox && related.hasInternalExclusion(element, outerBox)),
    );
    if (!attestedMainDownload && related.isRelated(element)) continue;
    collect(element.getAttribute('href') ?? element.getAttribute('src')!, expectedInfoCode);
  }
  if (new Set([...declaredCodes, ...candidates.values()]).size > 1) return invalid('研报详情元数据与附件声明指向不同的 infoCode。');
  if (candidates.size !== 1) return invalid(candidates.size ? '研报详情存在多个不同附件定位，须明确选择。' : '研报详情没有可验证的 PDF 附件定位。');
  const [pdfUrl, infoCode] = [...candidates.entries()][0]!;
  return { decoderVersion: 'eastmoney-report-detail/1' as const, providerId: 'eastmoney' as const, request: bound.request,
    detailUrl: bound.url.href, infoCode, pdfUrl, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    attachmentFetched: false as const, historyAvailability: 'not_established' as const };
}

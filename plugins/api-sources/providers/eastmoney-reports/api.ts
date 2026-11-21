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
const relatedHeadingAtBoundary = /^(?:相关阅读|相关研报|推荐阅读|延伸阅读)(?:$|[\s】\])））：:—\-·•]+|(?=[《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳]))/u;
const relatedBeforeTarget = /(?:^|(?<=[\s。！？；.!?])|(?<=(?:^|[\s。！？；.!?])[【[(（]))(?:相关阅读|相关研报|推荐阅读|延伸阅读)[\s】\])））：:—\-·•]*$/u;
const relatedWrapperTitle = /^[【[(\s（]*(?:相关阅读|相关研报|推荐阅读|延伸阅读)[\s】\])））：:]*$/u;
const inlineRelatedHeading = /(?:^|(?<=[\s。！？；.!?])|(?<=(?:^|[\s。！？；.!?])[【[(（]))(?:相关阅读|相关研报|推荐阅读|延伸阅读)(?:$|[\s】\])））：:—\-·•]+|(?=[《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳]))/gu;
const mainAttachmentHeading = /^[【[(\s]*(?:本?研报附件|本?报告附件|正文附件|原文附件|研报原文|原文下载|下载本?研报|下载原文|附件下载)(?:$|[\s】\])：:—\-·•（(])/u;
const leadingListItem = /^[\s\n]*(?:\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳])(?=$|[\s\n\p{L}\p{N}《「【])/u;
const explicitSectionHeadings = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend,dt';
const rootBoundaryContainers = '#zwinfo,article,section,main,body,html';
const relatedSelector = 'aside,nav,footer,[role="navigation"],[aria-label*="相关"],[aria-label*="推荐"],[aria-label*="延伸阅读"],'
  + '[class*="related" i],[id*="related" i],[class*="recommend" i],[id*="recommend" i],.rel-list,.xgyd,.xgyb';
const inlineFlowElements = 'span,strong,b,em,i,small,u,mark,font,sub,sup,label,abbr,cite,code,time,ins,del,s,q,bdi,bdo,ruby,rt,rp,kbd,samp,var,data,dfn';
const decorativeInlineTags = new Set(['WBR', 'IMG', 'INPUT', 'SVG', 'PICTURE', 'SOURCE', 'CANVAS']);
const isolatedContainerTags = new Set(['ARTICLE', 'SECTION', 'MAIN', 'BODY', 'HTML', 'DETAILS', 'FIGURE', 'FIELDSET', 'DIALOG', 'TABLE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'DD', 'DL']);
const listTags = new Set(['UL', 'OL', 'LI', 'DL']);
const nonContentTags = new Set(['HEAD', 'META', 'LINK', 'TITLE', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function headingLevel(element: Element): number {
  if (/^H[1-6]$/u.test(element.tagName)) return Number(element.tagName[1]);
  const aria = element.getAttribute('aria-level');
  return aria && /^[1-6]$/u.test(aria) ? Number(aria) : 2;
}

type DomFlags = {
  canFlattenInline: WeakMap<Element, boolean>;
  hasRootBoundary: WeakMap<Element, boolean>;
  hasNestedExplicitHeading: WeakMap<Element, boolean>;
};

function precomputeDomFlags(document: Document): DomFlags {
  const canFlattenInline = new WeakMap<Element, boolean>();
  const hasRootBoundary = new WeakMap<Element, boolean>();
  const hasNestedExplicitHeading = new WeakMap<Element, boolean>();
  const hasAnchorOrFrame = new WeakMap<Element, boolean>();
  const stack: Array<{ node: Element; visited: boolean }> = [];
  const docChildren: NodeListOf<ChildNode> = document.childNodes;
  for (let i = docChildren.length - 1; i >= 0; i -= 1) {
    const child: ChildNode = docChildren[i]!;
    if (child.nodeType === 1) stack.push({ node: child as Element, visited: false });
  }
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    const el = top.node;
    if (!top.visited) {
      top.visited = true;
      const children: NodeListOf<ChildNode> = el.childNodes;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child: ChildNode = children[i]!;
        if (child.nodeType === 1) stack.push({ node: child as Element, visited: false });
      }
      continue;
    }
    stack.pop();
    let rootB = el.matches(rootBoundaryContainers);
    let nestedH = false;
    let allFlat = true;
    let linkOrFrameChild = false;
    const children: NodeListOf<ChildNode> = el.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      const child: ChildNode = children[i]!;
      if (child.nodeType !== 1) continue;
      const ce = child as Element;
      if (hasRootBoundary.get(ce)) rootB = true;
      if (ce.matches(explicitSectionHeadings) || hasNestedExplicitHeading.get(ce)) nestedH = true;
      if (!canFlattenInline.get(ce)) allFlat = false;
      if (ce.tagName === 'A' || ce.tagName === 'IFRAME' || hasAnchorOrFrame.get(ce)) linkOrFrameChild = true;
    }
    hasRootBoundary.set(el, rootB);
    hasNestedExplicitHeading.set(el, nestedH);
    hasAnchorOrFrame.set(el, linkOrFrameChild);
    let flat = false;
    if (el.tagName === 'BR' || el.tagName === 'HR') {
      flat = true;
    } else if (decorativeInlineTags.has(el.tagName)) {
      flat = !linkOrFrameChild && !rootB && !nestedH && allFlat;
    } else if (el.tagName === 'IFRAME') {
      flat = !el.matches(relatedSelector) && !el.matches('.report-download');
    } else if (el.tagName === 'A' || el.matches(inlineFlowElements)) {
      flat = allFlat
        && !el.matches(relatedSelector)
        && !el.matches(rootBoundaryContainers)
        && !el.matches('.report-download')
        && !el.matches(explicitSectionHeadings);
    }
    canFlattenInline.set(el, flat);
  }
  return { canFlattenInline, hasRootBoundary, hasNestedExplicitHeading };
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
};

type AttachmentInfo = {
  inRelatedSelector: boolean;
  outerRelated: boolean;
  localRelated: boolean;
  owner: string | null;
  expectedInfoCode: string | null;
  downloadBox: Element | null;
};

type RunTarget = {
  element: Element;
  start: number;
  end: number;
  owner: string | null;
  expectedInfoCode: string | null;
  inRelatedSelf: boolean;
};

type TitleLinkTrigger = { start: number; end: number; endsWithPunct: boolean };

function recordRunTargets(
  targets: RunTarget[],
  fromIndex: number,
  toIndex: number,
  inRelatedSelector: boolean,
  outerRelated: boolean,
  localRelated: boolean,
  downloadBox: Element | null,
  attachmentMap: WeakMap<Element, AttachmentInfo>,
): void {
  for (let i = fromIndex; i < toIndex; i += 1) {
    const t = targets[i]!;
    if (!attachmentMap.has(t.element)) {
      attachmentMap.set(t.element, {
        inRelatedSelector: inRelatedSelector || t.inRelatedSelf,
        outerRelated,
        localRelated,
        owner: t.owner,
        expectedInfoCode: t.expectedInfoCode,
        downloadBox,
      });
    }
  }
}

function scanInlineRun(
  container: Element | Document,
  startIdx: number,
  endIdx: number,
  onlyRun: boolean,
  cur: Scope,
  attr: AttrScope,
  attachmentMap: WeakMap<Element, AttachmentInfo>,
): void {
  const children: NodeListOf<ChildNode> = container.childNodes;
  type RunFrame =
    | { kind: 'node'; node: ChildNode; owner: string | null; infoCode: string | null }
    | { kind: 'closeAnchor'; el: Element; start: number; owner: string | null; infoCode: string | null };
  const stack: RunFrame[] = [];
  for (let i = endIdx - 1; i >= startIdx; i -= 1) {
    stack.push({ kind: 'node', node: children[i]!, owner: attr.nearestEncodeUrl, infoCode: attr.nearestInfoCode });
  }
  let runText = '';
  let hasTitleClass = false;
  const runTargets: RunTarget[] = [];
  const titleLinkTriggers: TitleLinkTrigger[] = [];
  const anchorStarts = new Set<number>();
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.kind === 'closeAnchor') {
      const end = runText.length;
      const linkText = runText.slice(frame.start, end).trim();
      const el = frame.el;
      const isCandidate = el.hasAttribute('href')
        && ((attr.inZwinfo && el.hasAttribute('download')) || attr.nearestDownloadBox !== null || frame.owner !== null);
      if (isCandidate) {
        runTargets.push({
          element: el,
          start: frame.start,
          end,
          owner: frame.owner,
          expectedInfoCode: frame.infoCode,
          inRelatedSelf: relatedTitle.test(linkText),
        });
      }
      if (relatedWrapperTitle.test(linkText)) {
        titleLinkTriggers.push({
          start: frame.start,
          end,
          endsWithPunct: /[】\])））：:—\-·•]$/u.test(linkText),
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
    if (el.tagName === 'IFRAME') {
      const isZwinfoDirect = container.nodeType === 1 && (container as Element).id === 'zwinfo';
      if (isZwinfoDirect && el.hasAttribute('src')) {
        runTargets.push({
          element: el,
          start: runText.length,
          end: runText.length,
          owner: frame.owner,
          expectedInfoCode: frame.infoCode,
          inRelatedSelf: false,
        });
      }
      continue;
    }
    const nextOwner = el.getAttribute('data-encode-url') ?? frame.owner;
    const nextInfoCode = el.getAttribute('data-info-code') ?? frame.infoCode;
    if (el.tagName === 'A') {
      const anchorStart = runText.length;
      anchorStarts.add(anchorStart);
      stack.push({ kind: 'closeAnchor', el, start: anchorStart, owner: nextOwner, infoCode: nextInfoCode });
      const ac: NodeListOf<ChildNode> = el.childNodes;
      for (let i = ac.length - 1; i >= 0; i -= 1) stack.push({ kind: 'node', node: ac[i]!, owner: nextOwner, infoCode: nextInfoCode });
      continue;
    }
    if (el.hasAttribute('class') && el.matches('[class*="title" i]')) hasTitleClass = true;
    const ic: NodeListOf<ChildNode> = el.childNodes;
    for (let i = ic.length - 1; i >= 0; i -= 1) stack.push({ kind: 'node', node: ic[i]!, owner: nextOwner, infoCode: nextInfoCode });
  }

  // 独占块主附件标题停靠（如 <p><span class="title">本研报附件</span></p>）。
  if (onlyRun && runTargets.length === 0 && !cur.inList && !cur.inRelatedSelector && cur.relatedLevel !== null
    && container.nodeType === 1 && ((container as Element).matches('[class*="title" i]') || hasTitleClass)
    && mainAttachmentHeading.test(runText.trim())) {
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
    );
    return;
  }

  if (runText.length === 0 && runTargets.length === 0) return;

  const triggers: number[] = [];
  if (runText.length > 0) {
    inlineRelatedHeading.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRelatedHeading.exec(runText)) !== null) {
      triggers.push(m.index + m[0].length);
    }
    for (const target of runTargets) {
      if (target.start > 0) {
        const sliceStart = Math.max(0, target.start - 16);
        const prefixSlice = (sliceStart > 0 ? 'X' : '') + runText.slice(sliceStart, target.start);
        if (relatedBeforeTarget.test(prefixSlice)) triggers.push(target.start);
      }
      if (target.end < runText.length) {
        const afterTarget = relatedHeadingAtBoundary.exec(runText.slice(target.end, target.end + 32));
        if (afterTarget) triggers.push(target.end + afterTarget[0].length);
      }
    }
  }
  for (const t of titleLinkTriggers) {
    const leftOk = t.start === 0 || /[\s。！？；.!?【[(（]/u.test(runText[t.start - 1]!) || anchorStarts.has(t.start);
    if (!leftOk) continue;
    const rightOk = t.endsWithPunct
      || t.end === runText.length
      || anchorStarts.has(t.end)
      || /^[\s】\])））：:—\-·•《「【[(（]|\[\d{1,3}\]|[(（]\d{1,3}[)）]|\d{1,3}(?:\.(?!\d)|[、)）])|[①-⑳]/u.test(runText.slice(t.end, t.end + 16));
    if (rightOk) triggers.push(t.end);
  }
  if (triggers.length === 0) {
    recordRunTargets(runTargets, 0, runTargets.length, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap);
    return;
  }
  triggers.sort((a, b) => a - b);

  let targetIdx = 0;
  let prevGapEnd = 0;
  let cachedGapEnd = -1;
  let trimmedEnd = 0;
  let lastFullStop = -1;
  let lastProseChar = -1;
  let coreEnd = -1;
  let lastNonPunct = -1;
  let nonSpaceIdx = 0;

  for (let ti = 0; ti < triggers.length; ti += 1) {
    const triggerEnd = triggers[ti]!;
    if (ti > 0 && triggerEnd === triggers[ti - 1]) continue;
    while (targetIdx < runTargets.length && runTargets[targetIdx]!.start < triggerEnd) targetIdx += 1;
    const nextTarget = targetIdx < runTargets.length ? runTargets[targetIdx]! : null;
    const gapEnd = nextTarget ? nextTarget.start : runText.length;

    if (gapEnd !== cachedGapEnd) {
      const floor = cachedGapEnd === -1 ? 0 : prevGapEnd;
      prevGapEnd = cachedGapEnd === -1 ? 0 : cachedGapEnd;
      trimmedEnd = gapEnd;
      while (trimmedEnd > floor && /\s/u.test(runText[trimmedEnd - 1]!)) trimmedEnd -= 1;
      lastFullStop = -1;
      lastProseChar = -1;
      coreEnd = -1;
      lastNonPunct = -1;
      for (let i = trimmedEnd - 1; i >= floor; i -= 1) {
        const ch = runText[i]!;
        if (lastFullStop === -1 && ch === '。') lastFullStop = i;
        if (lastProseChar === -1 && !/[\s【】[\]()（）：:—\-·•]/u.test(ch)) lastProseChar = i;
        if (coreEnd === -1 && !/[\s"'”’）)】\]]/u.test(ch)) coreEnd = i;
        if (lastNonPunct === -1 && !/[\s。！？；.!?,，:：—\-·•]/u.test(ch)) lastNonPunct = i;
        if (lastFullStop !== -1 && lastProseChar !== -1 && coreEnd !== -1 && lastNonPunct !== -1) break;
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
      const isBareQuotedTitle = Boolean(
        closeChar && lastNonPunct > nonSpaceIdx && runText[lastNonPunct] === closeChar
        && runText.indexOf(closeChar, nonSpaceIdx + 1) === lastNonPunct,
      );
      const isNumbered = nonSpaceIdx < trimmedEnd && leadingListItem.test(runText.slice(nonSpaceIdx, nonSpaceIdx + 16));
      if (isNumbered || isBareQuotedTitle) {
        isProse = false;
      } else if (
        lastFullStop >= triggerEnd
        || (coreEnd >= nonSpaceIdx && (
          /[。！？；!?]/u.test(runText[coreEnd]!)
          || (runText[coreEnd]! === '.' && coreEnd > nonSpaceIdx && !/[\d.]/u.test(runText[coreEnd - 1]!))
        ))
      ) {
        isProse = true;
      } else {
        isProse = nextTarget === null;
      }
    }
    if (isProse) continue;

    recordRunTargets(runTargets, 0, targetIdx, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap);
    recordRunTargets(
      runTargets,
      targetIdx,
      runTargets.length,
      false,
      cur.outerRelated || !cur.isDownloadBox,
      cur.boxAncestorLocalRelated || cur.isDownloadBox,
      attr.nearestDownloadBox,
      attachmentMap,
    );
    cur.relatedLevel = 2;
    return;
  }

  recordRunTargets(runTargets, 0, runTargets.length, false, cur.outerRelated, cur.boxAncestorLocalRelated, attr.nearestDownloadBox, attachmentMap);
}

/** 单趟前序文档作用域遍历：严格 O(N)，零递归，隔离根边界与多层下载框。 */
function analyzeEastmoneySections(document: Document) {
  const flags = precomputeDomFlags(document);
  const excludedScripts = new WeakSet<Element>();
  const attachmentMap = new WeakMap<Element, AttachmentInfo>();
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
  }];

  type DfsFrame =
    | { kind: 'visit'; node: Element; inZwinfoDirect: boolean }
    | { kind: 'run'; container: Element | Document; start: number; end: number; onlyRun: boolean }
    | { kind: 'leave'; popScope: boolean; popAttr: boolean };
  const dfsStack: DfsFrame[] = [];

  const enqueueChildren = (container: Element | Document, includeLeave?: { popScope: boolean; popAttr: boolean }) => {
    const children: NodeListOf<ChildNode> = container.childNodes;
    const steps: DfsFrame[] = [];
    let runStart = -1;
    const flushRun = (end: number) => {
      if (runStart !== -1) {
        steps.push({ kind: 'run', container, start: runStart, end, onlyRun: false });
        runStart = -1;
      }
    };
    const parentIsZwinfo = container.nodeType === 1 && (container as Element).id === 'zwinfo';
    for (let i = 0; i < children.length; i += 1) {
      const child: ChildNode = children[i]!;
      if (child.nodeType === 3) {
        if (runStart === -1) runStart = i;
      } else if (child.nodeType === 1) {
        const ce = child as Element;
        if (flags.canFlattenInline.get(ce)) {
          if (runStart === -1) runStart = i;
        } else {
          flushRun(i);
          steps.push({ kind: 'visit', node: ce, inZwinfoDirect: parentIsZwinfo });
        }
      }
    }
    flushRun(children.length);
    if (steps.length === 1 && steps[0]!.kind === 'run') steps[0]!.onlyRun = true;
    if (includeLeave && (includeLeave.popScope || includeLeave.popAttr)) dfsStack.push({ kind: 'leave', ...includeLeave });
    for (let i = steps.length - 1; i >= 0; i -= 1) dfsStack.push(steps[i]!);
  };

  enqueueChildren(document);

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
      scanInlineRun(frame.container, frame.start, frame.end, frame.onlyRun, cur, attr, attachmentMap);
      continue;
    }

    const el = frame.node;
    if (nonContentTags.has(el.tagName)) continue;
    if (el.tagName === 'SCRIPT') {
      if (cur.inRelatedSelector || cur.relatedLevel !== null || cur.boxAncestorLocalRelated || cur.outerRelated) {
        excludedScripts.add(el);
      }
      continue;
    }

    if (el.tagName === 'IFRAME') {
      if (frame.inZwinfoDirect && el.hasAttribute('src')) {
        const isRel = cur.inRelatedSelector || el.matches(relatedSelector);
        attachmentMap.set(el, {
          inRelatedSelector: isRel,
          outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null),
          localRelated: cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null),
          owner: el.getAttribute('data-encode-url') ?? attr.nearestEncodeUrl,
          expectedInfoCode: el.getAttribute('data-info-code') ?? attr.nearestInfoCode,
          downloadBox: attr.nearestDownloadBox,
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

    const isAnchorCandidate = el.tagName === 'A' && el.hasAttribute('href')
      && (isDownloadBox || (attr.inZwinfo && el.hasAttribute('download')) || attr.nearestDownloadBox !== null || nextEncodeUrl !== null);

    if (isAnchorCandidate) {
      const outerRel = cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null);
      const localRel = cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null);
      const anchorText = el.textContent?.trim() ?? '';
      attachmentMap.set(el, {
        inRelatedSelector: cur.inRelatedSelector || isRelSelector || relatedTitle.test(anchorText),
        outerRelated: outerRel,
        localRelated: localRel,
        owner: nextEncodeUrl,
        expectedInfoCode: nextInfoCode,
        downloadBox: isDownloadBox ? el : attr.nearestDownloadBox,
      });
    }

    let popScope = false;
    if (isIsolated || isAnchorCandidate) {
      popScope = true;
      if (isRelSelector) {
        scopeStack.push({
          ...cur,
          inRelatedSelector: true,
          inList: cur.inList || listTags.has(el.tagName),
          inAttachmentLink: cur.inAttachmentLink || isAnchorCandidate,
        });
      } else if (isDownloadBox) {
        scopeStack.push({
          relatedLevel: null,
          inRelatedSelector: cur.inRelatedSelector,
          inList: cur.inList || listTags.has(el.tagName),
          isDownloadBox: true,
          outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedLevel !== null),
          boxAncestorLocalRelated: cur.boxAncestorLocalRelated || (cur.isDownloadBox && cur.relatedLevel !== null),
          inAttachmentLink: cur.inAttachmentLink || isAnchorCandidate,
        });
      } else {
        scopeStack.push({
          ...cur,
          inList: cur.inList || listTags.has(el.tagName),
          inAttachmentLink: cur.inAttachmentLink || isAnchorCandidate,
        });
      }
    }

    const pushAttr = hasEncodeAttr || hasInfoAttr || isZwinfoId || isDownloadBox;
    if (pushAttr) {
      attrStack.push({
        nearestEncodeUrl: nextEncodeUrl,
        nearestInfoCode: nextInfoCode,
        nearestDownloadBox: isDownloadBox ? el : attr.nearestDownloadBox,
        inZwinfo: attr.inZwinfo || isZwinfoId,
      });
    }

    const activeScope = scopeStack[scopeStack.length - 1]!;
    if (el.matches(explicitSectionHeadings)
      && !el.matches(`${rootBoundaryContainers},.report-download`)
      && !flags.hasRootBoundary.get(el)
      && !flags.hasNestedExplicitHeading.get(el)) {
      const text = el.textContent?.trim() ?? '';
      if (relatedTitle.test(text)) {
        if (!activeScope.inRelatedSelector) {
          const level = headingLevel(el);
          activeScope.relatedLevel = activeScope.relatedLevel === null ? level : Math.min(activeScope.relatedLevel, level);
        }
      } else if (!activeScope.inAttachmentLink && !activeScope.inRelatedSelector && activeScope.relatedLevel !== null) {
        const shouldStop = activeScope.inList
          ? mainAttachmentHeading.test(text)
          : (headingLevel(el) <= activeScope.relatedLevel || mainAttachmentHeading.test(text));
        if (shouldStop) activeScope.relatedLevel = null;
      }
    }

    enqueueChildren(el, { popScope, popAttr: pushAttr });
  }

  return {
    isScriptExcluded: (script: Element) => excludedScripts.has(script),
    getAttachment: (element: Element) => attachmentMap.get(element),
  };
}

/** 复用现有 HTML 解析依赖；仅返回同源固定格式 PDF 定位，不下载、不执行脚本。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const { document } = parseHTML(decodeUtf8(rawBytes));
  const candidates = new Map<string, string>(), declaredCodes = new Set<string>();
  const sections = analyzeEastmoneySections(document);
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
    if (sections.isScriptExcluded(script)) continue;
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
    const status = sections.getAttachment(element);
    if (!status) continue;
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

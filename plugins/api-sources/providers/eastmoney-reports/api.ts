import { createHash } from 'node:crypto';
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

const DUPLICATE_JSON_KEY = Symbol('DUPLICATE_JSON_KEY');
const MAX_JSON_DEPTH = 32;

/** 严格 RFC 8259 JSON 对象解析（拒绝任意层级的重复键，避免 JSON.parse 静默覆盖）。 */
function parseStrictJsonObject(literal: string): Record<string, JsonValue> | typeof DUPLICATE_JSON_KEY | null {
  let pos = 0;
  const len = literal.length;
  const skipWs = () => {
    while (pos < len) {
      const c = literal.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) pos += 1;
      else break;
    }
  };
  const parseString = (): string | null => {
    if (literal[pos] !== '"') return null;
    const start = pos;
    pos += 1;
    while (pos < len) {
      const ch = literal[pos]!;
      if (ch === '\\') {
        pos += 2;
        if (pos > len) return null;
      } else if (ch === '"') {
        pos += 1;
        try {
          const decoded: unknown = JSON.parse(literal.slice(start, pos));
          return typeof decoded === 'string' ? decoded : null;
        } catch {
          return null;
        }
      } else if (ch.charCodeAt(0) < 0x20) {
        return null;
      } else {
        pos += 1;
      }
    }
    return null;
  };
  const parseValue = (depth: number): JsonValue | typeof DUPLICATE_JSON_KEY | undefined => {
    if (depth > MAX_JSON_DEPTH) return undefined;
    skipWs();
    if (pos >= len) return undefined;
    const ch = literal[pos]!;
    if (ch === '"') return parseString() ?? undefined;
    if (ch === '{') {
      pos += 1;
      const obj: Record<string, JsonValue> = Object.create(null);
      skipWs();
      if (literal[pos] === '}') {
        pos += 1;
        return obj;
      }
      while (pos < len) {
        skipWs();
        const key = parseString();
        if (key === null) return undefined;
        if (Object.hasOwn(obj, key)) return DUPLICATE_JSON_KEY;
        skipWs();
        if (literal[pos] !== ':') return undefined;
        pos += 1;
        const val = parseValue(depth + 1);
        if (val === undefined || val === DUPLICATE_JSON_KEY) return val;
        obj[key] = val;
        skipWs();
        if (literal[pos] === ',') {
          pos += 1;
          continue;
        }
        if (literal[pos] === '}') {
          pos += 1;
          return obj;
        }
        return undefined;
      }
      return undefined;
    }
    if (ch === '[') {
      pos += 1;
      const arr: JsonValue[] = [];
      skipWs();
      if (literal[pos] === ']') {
        pos += 1;
        return arr;
      }
      while (pos < len) {
        const val = parseValue(depth + 1);
        if (val === undefined || val === DUPLICATE_JSON_KEY) return val;
        arr.push(val);
        skipWs();
        if (literal[pos] === ',') {
          pos += 1;
          continue;
        }
        if (literal[pos] === ']') {
          pos += 1;
          return arr;
        }
        return undefined;
      }
      return undefined;
    }
    if (literal.startsWith('true', pos)) { pos += 4; return true; }
    if (literal.startsWith('false', pos)) { pos += 5; return false; }
    if (literal.startsWith('null', pos)) { pos += 4; return null; }
    const numRe = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numRe.lastIndex = pos;
    const numMatch = numRe.exec(literal);
    if (!numMatch) return undefined;
    const num = Number(numMatch[0]);
    if (!Number.isFinite(num)) return undefined;
    pos += numMatch[0].length;
    return num;
  };
  skipWs();
  if (literal[pos] !== '{') return null;
  const root = parseValue(0);
  if (root === DUPLICATE_JSON_KEY) return DUPLICATE_JSON_KEY;
  if (root === undefined || !object(root)) return null;
  skipWs();
  return pos === len ? root : null;
}

/** 接受严格无重复键 JSON 或仅含静态字符串的旧式 JS 对象字面量；脚本从不执行。 */
function detailMetadata(literal: string): Record<string, JsonValue> | null {
  const strictJson = parseStrictJsonObject(literal);
  if (strictJson === DUPLICATE_JSON_KEY) return null;
  if (strictJson !== null) return strictJson;
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

const namedHtmlEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwj: '\u200d',
  zwnj: '\u200c',
  shy: '\u00ad',
});

function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  let out = '';
  let i = 0;
  const len = input.length;
  while (i < len) {
    const amp = input.indexOf('&', i);
    if (amp === -1) {
      out += input.slice(i);
      break;
    }
    if (amp > i) out += input.slice(i, amp);
    if (amp + 1 < len && input[amp + 1] === '#') {
      let j = amp + 2;
      let hex = false;
      if (j < len && (input[j] === 'x' || input[j] === 'X')) {
        hex = true;
        j += 1;
      }
      const digitsStart = j;
      while (j < len) {
        const c = input.charCodeAt(j);
        const ok = hex
          ? ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))
          : (c >= 48 && c <= 57);
        if (!ok) break;
        j += 1;
      }
      if (j > digitsStart) {
        const rawNum = input.slice(digitsStart, j);
        if (j < len && input[j] === ';') j += 1;
        const cp = Number.parseInt(rawNum.slice(0, 8), hex ? 16 : 10);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) out += '\ufffd';
        else out += String.fromCodePoint(cp);
        i = j;
        continue;
      }
    } else {
      let j = amp + 1;
      while (j < len && j - amp <= 12) {
        const c = input.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j += 1;
        else break;
      }
      if (j > amp + 1 && j < len && input[j] === ';') {
        const name = input.slice(amp + 1, j);
        const resolved = namedHtmlEntities[name] ?? namedHtmlEntities[name.toLowerCase()];
        if (resolved !== undefined) {
          out += resolved;
          i = j + 1;
          continue;
        }
      }
    }
    out += '&';
    i = amp + 1;
  }
  return out;
}

const voidHtmlTags = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const rawTextTags = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
const formControlTags = new Set([
  'form', 'fieldset', 'select', 'option', 'optgroup', 'textarea', 'button', 'input', 'datalist', 'output', 'meter', 'progress',
]);
const isolatedAuxiliaryTags = new Set(['head', 'details', 'figure', 'dialog', ...formControlTags]);
const nonContentSubtreeTags = new Set(['meta', 'link', 'title', 'style', 'noscript', 'template', 'xmp', 'noembed', 'noframes']);
const rootBoundaryTags = new Set(['main', 'body', 'html']);
const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'legend']);
const landmarkRelatedTags = new Set(['aside', 'nav', 'footer']);
const relatedClassTokens = new Set(['rel-list', 'xgyd', 'xgyb']);
const blockBoundaryTags = new Set([
  'html', 'head', 'body', 'main', 'article', 'section', 'aside', 'nav', 'header', 'footer', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'p', 'div', 'pre', 'blockquote', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'details', 'summary', 'dialog',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'form', 'fieldset', 'legend', 'select', 'option', 'optgroup', 'textarea', 'button', 'input', 'datalist', 'output', 'meter', 'progress',
  'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'svg', 'img', 'picture', 'map', 'area',
  'script', 'style', 'noscript', 'template', 'title', 'meta', 'link', 'xmp', 'noembed', 'noframes',
]);
const jsMimeEssences = new Set([
  'text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript',
  'application/x-javascript', 'text/x-javascript', 'text/javascript1.0', 'text/javascript1.1',
  'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'application/x-ecmascript', 'module',
]);
const relatedKeywordsWithCountGuard = new Set(['相关阅读', '推荐阅读', '延伸阅读']);

function isExecutableScriptType(typeAttr: string | null): boolean {
  if (typeAttr === null) return true;
  const trimmed = typeAttr.trim();
  if (trimmed === '') return true;
  const semi = trimmed.indexOf(';');
  const essence = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim().toLowerCase();
  return jsMimeEssences.has(essence);
}

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

type TagAttrs = {
  id: string | null;
  className: string | null;
  role: string | null;
  ariaLabel: string | null;
  href: string | null;
  src: string | null;
  hasSrc: boolean;
  hasDownload: boolean;
  type: string | null;
  encodeUrl: string | null;
  hasEncodeUrl: boolean;
  hasForeignEncodeUrl: boolean;
  infoCode: string | null;
  hasInfoCode: boolean;
  hasInfoCodeConflict: boolean;
};

function hasClassToken(className: string | null, expected: string): boolean {
  if (!className) return false;
  const tokens = className.split(/\s+/u);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === expected) return true;
  }
  return false;
}

function isRelatedElement(tag: string, attrs: TagAttrs): boolean {
  if (landmarkRelatedTags.has(tag)) return true;
  if (attrs.role !== null && attrs.role.trim().toLowerCase() === 'navigation') return true;
  if (attrs.ariaLabel !== null && (attrs.ariaLabel.includes('相关') || attrs.ariaLabel.includes('推荐') || attrs.ariaLabel.includes('延伸阅读'))) {
    return true;
  }
  if (attrs.id !== null) {
    const idLower = attrs.id.toLowerCase();
    if (idLower.includes('related') || idLower.includes('recommend')) return true;
  }
  if (attrs.className !== null) {
    const clsLower = attrs.className.toLowerCase();
    if (clsLower.includes('related') || clsLower.includes('recommend')) return true;
    const tokens = attrs.className.split(/\s+/u);
    for (let i = 0; i < tokens.length; i += 1) {
      if (relatedClassTokens.has(tokens[i]!)) return true;
    }
  }
  return false;
}

function isLandmarkRelatedElement(tag: string, attrs: TagAttrs): boolean {
  return landmarkRelatedTags.has(tag) || (attrs.role !== null && attrs.role.trim().toLowerCase() === 'navigation');
}

function isHeadingElement(tag: string, attrs: TagAttrs): boolean {
  return headingTags.has(tag) || (attrs.role !== null && attrs.role.trim().toLowerCase() === 'heading');
}

type KeywordState = {
  tail: string;
  pendingRelated: boolean;
};

type BoxRecord = {
  owner: string | null;
  infoCode: string | null;
  hasForeignEncodeUrl: boolean;
  hasInfoCodeConflict: boolean;
  hasAnyRelated: boolean;
  parent: BoxRecord | null;
};

type RelBoxRecord = {
  sawRelatedKeyword: boolean;
  hasDescendantPdfOrScript: boolean;
  tail: string;
  pendingRelated: boolean;
  parent: RelBoxRecord | null;
};

type CandidateAnchor = {
  url: string;
  owner: string | null;
  expectedInfoCode: string | null;
  hasForeignEncodeUrl: boolean;
  hasInfoCodeConflict: boolean;
  boxRecord: BoxRecord | null;
  inRelatedSelector: boolean;
  outerRelated: boolean;
  poisoned: boolean;
  parent: CandidateAnchor | null;
};

type Scope = {
  inRelatedSelector: boolean;
  isDownloadBox: boolean;
  outerRelated: boolean;
  relatedSeen: boolean;
  tail: string;
  pendingRelated: boolean;
  nearestBox: BoxRecord | null;
  activeRelBox: RelBoxRecord | null;
};

type AttrScope = {
  nearestEncodeUrl: string | null;
  hasForeignEncodeUrl: boolean;
  nearestInfoCode: string | null;
  hasInfoCodeConflict: boolean;
  nearestBox: BoxRecord | null;
  inZwinfo: boolean;
  inFormControl: boolean;
};

type AttachmentEntry = {
  url: string;
  inRelatedSelector: boolean;
  outerRelated: boolean;
  owner: string | null;
  hasForeignEncodeUrl: boolean;
  expectedInfoCode: string | null;
  hasInfoCodeConflict: boolean;
  boxRecord: BoxRecord | null;
  candidateRecord: CandidateAnchor | null;
};

type ScriptEntry = {
  content: string;
  inRelatedSelector: boolean;
  outerRelated: boolean;
  hasForeignEncodeUrl: boolean;
  expectedInfoCode: string | null;
  hasInfoCodeConflict: boolean;
  boxRecord: BoxRecord | null;
  enclosingCandidate: CandidateAnchor | null;
};

function scanKeywordText(state: KeywordState, text: string, onHit: () => void): void {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/[\s\u200b-\u200d\ufeff\u00ad]/u.test(ch)) {
      if (state.pendingRelated) {
        state.pendingRelated = false;
        onHit();
        return;
      }
      continue;
    }
    if (state.pendingRelated) {
      if (ch === '量') {
        state.pendingRelated = false;
      } else {
        state.pendingRelated = false;
        onHit();
        return;
      }
    }
    state.tail = (state.tail + ch).slice(-4);
    if (state.tail === '相关研报') {
      onHit();
      return;
    }
    if (relatedKeywordsWithCountGuard.has(state.tail)) {
      state.pendingRelated = true;
    }
  }
}

/** 单趟 O(N) 定位 rawtext/script 结束标签，严格遵守 HTML5 script-data-escaped 状态。 */
function findRawElementClose(html: string, startPos: number, tag: string): { contentEnd: number; nextPos: number } {
  const len = html.length;
  const tagLen = tag.length;
  let pos = startPos;
  let escaped = false;
  let doubleEscaped = false;
  const isScript = tag === 'script';
  while (pos < len) {
    if (isScript) {
      if (!escaped && html.startsWith('<!--', pos)) {
        escaped = true;
        pos += 4;
        continue;
      }
      if (escaped && html.startsWith('-->', pos)) {
        escaped = false;
        doubleEscaped = false;
        pos += 3;
        continue;
      }
      if (escaped && !doubleEscaped && html[pos] === '<' && pos + 1 + tagLen <= len
        && html.slice(pos + 1, pos + 1 + tagLen).toLowerCase() === 'script') {
        const after = pos + 1 + tagLen;
        if (after === len || /[\s/>]/u.test(html[after]!)) {
          doubleEscaped = true;
          pos = after;
          continue;
        }
      }
    }
    if (html[pos] === '<' && pos + 2 + tagLen <= len && html[pos + 1] === '/') {
      if (html.slice(pos + 2, pos + 2 + tagLen).toLowerCase() === tag) {
        const after = pos + 2 + tagLen;
        if (after === len || /[\s/>]/u.test(html[after]!)) {
          if (isScript && doubleEscaped) {
            doubleEscaped = false;
            pos = after;
            continue;
          }
          const gt = html.indexOf('>', after);
          return { contentEnd: pos, nextPos: gt === -1 ? len : gt + 1 };
        }
      }
    }
    pos += 1;
  }
  return { contentEnd: len, nextPos: len };
}

/**
 * 严格 fail-closed、单趟 O(N) 流式 HTML5 解析与作用域分析（零递归、属性名统一小写、未匹配闭合标签 O(1) 跳过）：
 * - 不做自然语言正文猜测；在同一作用域内一旦出现相关/推荐/延伸阅读标记，后续无显式归属证明的链接、iframe 与脚本一律保守拒收；
 * - 仅允许不在相关选择器内、整框无局部相关标记、无冲突归属且与 zwinfo 元数据一致的 `.report-download` 主下载框跨越外层相关标记。
 */
function analyzeEastmoneySections(html: string, baseUrl: string, expectedEncodeUrl: string) {
  const scripts: ScriptEntry[] = [];
  const attachments: AttachmentEntry[] = [];
  const allBoxes: BoxRecord[] = [];
  const allCandidates: CandidateAnchor[] = [];

  const scopeStack: Scope[] = [{
    inRelatedSelector: false,
    isDownloadBox: false,
    outerRelated: false,
    relatedSeen: false,
    tail: '',
    pendingRelated: false,
    nearestBox: null,
    activeRelBox: null,
  }];
  const attrStack: AttrScope[] = [{
    nearestEncodeUrl: null,
    hasForeignEncodeUrl: false,
    nearestInfoCode: null,
    hasInfoCodeConflict: false,
    nearestBox: null,
    inZwinfo: false,
    inFormControl: false,
  }];
  const candidateAnchorStack: CandidateAnchor[] = [];

  type OpenElemFrame = {
    tag: string;
    isZwinfoId: boolean;
    popScope: boolean;
    popAttr: boolean;
    resetParentTail: boolean;
    closeCandidate: boolean;
    closeBox: BoxRecord | null;
    closeRelBox: RelBoxRecord | null;
    enterNonContent: boolean;
    enterForeign: boolean;
  };
  const openStack: OpenElemFrame[] = [];
  const openTagCounts = new Map<string, number>();
  let nonContentDepth = 0;
  let foreignDepth = 0;

  const markScopeRelated = (scope: Scope): void => {
    scope.pendingRelated = false;
    scope.relatedSeen = true;
    if (scope.nearestBox !== null) scope.nearestBox.hasAnyRelated = true;
    if (candidateAnchorStack.length > 0) {
      candidateAnchorStack[candidateAnchorStack.length - 1]!.poisoned = true;
    }
  };

  const flushScopePending = (scope: Scope): void => {
    if (scope.pendingRelated) markScopeRelated(scope);
    if (scope.activeRelBox !== null && scope.activeRelBox.pendingRelated) {
      scope.activeRelBox.pendingRelated = false;
      scope.activeRelBox.sawRelatedKeyword = true;
    }
  };

  const feedText = (rawText: string): void => {
    if (nonContentDepth > 0 || !rawText) return;
    const text = decodeHtmlEntities(rawText);
    const cur = scopeStack[scopeStack.length - 1]!;
    if (cur.activeRelBox !== null && !cur.activeRelBox.sawRelatedKeyword) {
      scanKeywordText(cur.activeRelBox, text, () => {
        cur.activeRelBox!.sawRelatedKeyword = true;
      });
    }
    if (!cur.inRelatedSelector && !cur.relatedSeen) {
      scanKeywordText(cur, text, () => markScopeRelated(cur));
    }
  };

  const leaveElement = (frame: OpenElemFrame): void => {
    const count = openTagCounts.get(frame.tag) ?? 0;
    if (count <= 1) openTagCounts.delete(frame.tag);
    else openTagCounts.set(frame.tag, count - 1);

    if (frame.enterNonContent) nonContentDepth -= 1;
    if (frame.enterForeign) foreignDepth -= 1;

    const activeScope = scopeStack[scopeStack.length - 1]!;
    if (frame.closeCandidate) {
      flushScopePending(activeScope);
      const candidate = candidateAnchorStack.pop()!;
      if (candidate.poisoned && candidate.parent !== null) candidate.parent.poisoned = true;
      const effOuterRelated = activeScope.outerRelated || (!activeScope.isDownloadBox && activeScope.relatedSeen);
      if (activeScope.isDownloadBox && activeScope.relatedSeen && candidate.boxRecord !== null) {
        candidate.boxRecord.hasAnyRelated = true;
      }
      candidate.outerRelated = effOuterRelated;
      if (activeScope.inRelatedSelector) candidate.inRelatedSelector = true;
      attachments.push({
        url: candidate.url,
        inRelatedSelector: candidate.inRelatedSelector,
        outerRelated: candidate.outerRelated,
        owner: candidate.owner,
        hasForeignEncodeUrl: candidate.hasForeignEncodeUrl,
        expectedInfoCode: candidate.expectedInfoCode,
        hasInfoCodeConflict: candidate.hasInfoCodeConflict,
        boxRecord: candidate.boxRecord,
        candidateRecord: candidate,
      });
    }

    if (frame.closeBox !== null && frame.closeBox.hasAnyRelated && frame.closeBox.parent !== null) {
      frame.closeBox.parent.hasAnyRelated = true;
    }

    if (frame.popScope) {
      flushScopePending(activeScope);
      scopeStack.pop();
    } else if (frame.resetParentTail) {
      flushScopePending(activeScope);
      activeScope.tail = '';
      if (activeScope.activeRelBox !== null) activeScope.activeRelBox.tail = '';
    }

    if (frame.closeRelBox !== null) {
      if (frame.closeRelBox.pendingRelated) {
        frame.closeRelBox.pendingRelated = false;
        frame.closeRelBox.sawRelatedKeyword = true;
      }
      if (frame.closeRelBox.hasDescendantPdfOrScript && frame.closeRelBox.parent !== null) {
        frame.closeRelBox.parent.hasDescendantPdfOrScript = true;
      }
      if (!frame.closeRelBox.hasDescendantPdfOrScript && frame.closeRelBox.sawRelatedKeyword) {
        const parentScope = scopeStack[scopeStack.length - 1]!;
        if (!parentScope.inRelatedSelector) markScopeRelated(parentScope);
      }
    }

    if (frame.popAttr) attrStack.pop();
  };

  const handleCloseTag = (tag: string): void => {
    if ((openTagCounts.get(tag) ?? 0) === 0) return;
    while (openStack.length > 0) {
      const frame = openStack.pop()!;
      leaveElement(frame);
      if (frame.tag === tag) break;
    }
  };

  const handleOpenTag = (tag: string, attrs: TagAttrs, selfClosing: boolean, rawBody?: string): void => {
    const isVoid = voidHtmlTags.has(tag) || (foreignDepth > 0 && selfClosing);
    const cur = scopeStack[scopeStack.length - 1]!;
    const attr = attrStack[attrStack.length - 1]!;

    if (nonContentDepth > 0 || nonContentSubtreeTags.has(tag)) {
      if (!isVoid && rawBody === undefined) {
        const enterNonContent = nonContentSubtreeTags.has(tag);
        if (enterNonContent) nonContentDepth += 1;
        openStack.push({
          tag,
          isZwinfoId: false,
          popScope: false,
          popAttr: false,
          resetParentTail: false,
          closeCandidate: false,
          closeBox: null,
          closeRelBox: null,
          enterNonContent,
          enterForeign: false,
        });
        openTagCounts.set(tag, (openTagCounts.get(tag) ?? 0) + 1);
      }
      return;
    }

    const isRelSelector = isRelatedElement(tag, attrs);
    const isDownloadBox = hasClassToken(attrs.className, 'report-download');
    const isZwinfoId = attrs.id === 'zwinfo';
    const isRootBoundary = isZwinfoId || rootBoundaryTags.has(tag);
    const isFormControl = formControlTags.has(tag);
    const isIsolated = isRelSelector || isDownloadBox || isRootBoundary || isolatedAuxiliaryTags.has(tag);
    const isBlockBoundary = isIsolated || blockBoundaryTags.has(tag);

    if (isRelSelector) {
      if (candidateAnchorStack.length > 0) {
        candidateAnchorStack[candidateAnchorStack.length - 1]!.poisoned = true;
      }
      if (cur.nearestBox !== null) {
        cur.nearestBox.hasAnyRelated = true;
      }
      if (isHeadingElement(tag, attrs) && !cur.inRelatedSelector) {
        markScopeRelated(cur);
      }
    }

    const nextForeignEncode = attr.hasForeignEncodeUrl
      || attrs.hasForeignEncodeUrl
      || (attrs.hasEncodeUrl && attrs.encodeUrl !== expectedEncodeUrl);
    const nextEncodeUrl = attrs.hasEncodeUrl ? attrs.encodeUrl : attr.nearestEncodeUrl;
    const nextInfoCodeConflict = attr.hasInfoCodeConflict
      || attrs.hasInfoCodeConflict
      || (attrs.hasInfoCode && attr.nearestInfoCode !== null && attrs.infoCode !== attr.nearestInfoCode);
    const nextInfoCode = attrs.hasInfoCode ? attrs.infoCode : attr.nearestInfoCode;

    if (tag === 'script') {
      flushScopePending(cur);
      if (cur.activeRelBox !== null) cur.activeRelBox.hasDescendantPdfOrScript = true;
      if (
        !attrs.hasSrc
        && !attr.inFormControl
        && isExecutableScriptType(attrs.type)
        && !isRelSelector
        && !cur.inRelatedSelector
        && !nextForeignEncode
        && rawBody !== undefined
      ) {
        const effOuterRelated = cur.outerRelated || (!cur.isDownloadBox && cur.relatedSeen);
        const effBoxLocal = cur.isDownloadBox && cur.relatedSeen;
        if (!effBoxLocal) {
          scripts.push({
            content: rawBody,
            inRelatedSelector: false,
            outerRelated: effOuterRelated,
            hasForeignEncodeUrl: nextForeignEncode,
            expectedInfoCode: nextInfoCode,
            hasInfoCodeConflict: nextInfoCodeConflict,
            boxRecord: cur.nearestBox,
            enclosingCandidate: candidateAnchorStack.length > 0 ? candidateAnchorStack[candidateAnchorStack.length - 1]! : null,
          });
        }
      }
      return;
    }

    if (tag === 'iframe') {
      flushScopePending(cur);
      const isDirectZwinfoChild = openStack.length > 0 && openStack[openStack.length - 1]!.isZwinfoId;
      const validSrc = isEastmoneyPdfHref(attrs.src, baseUrl);
      if (validSrc && cur.activeRelBox !== null) cur.activeRelBox.hasDescendantPdfOrScript = true;
      if (isDirectZwinfoChild && !attr.inFormControl && validSrc && attrs.src !== null) {
        attachments.push({
          url: attrs.src,
          inRelatedSelector: cur.inRelatedSelector || isRelSelector,
          outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedSeen),
          owner: nextEncodeUrl,
          hasForeignEncodeUrl: nextForeignEncode,
          expectedInfoCode: nextInfoCode,
          hasInfoCodeConflict: nextInfoCodeConflict,
          boxRecord: cur.nearestBox,
          candidateRecord: candidateAnchorStack.length > 0 ? candidateAnchorStack[candidateAnchorStack.length - 1]! : null,
        });
      }
      return;
    }

    if (tag === 'textarea') {
      flushScopePending(cur);
      cur.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.tail = '';
      if (rawBody && candidateAnchorStack.length > 0) {
        const probe: KeywordState = { tail: '', pendingRelated: false };
        scanKeywordText(probe, decodeHtmlEntities(rawBody), () => {
          candidateAnchorStack[candidateAnchorStack.length - 1]!.poisoned = true;
        });
        if (probe.pendingRelated) {
          candidateAnchorStack[candidateAnchorStack.length - 1]!.poisoned = true;
        }
      }
      return;
    }

    if (isBlockBoundary) {
      flushScopePending(cur);
      cur.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.tail = '';
    } else if (tag === 'a' || tag === 'br') {
      flushScopePending(cur);
    }

    const validPdfHref = tag === 'a' && isEastmoneyPdfHref(attrs.href, baseUrl);
    if (validPdfHref && cur.activeRelBox !== null) cur.activeRelBox.hasDescendantPdfOrScript = true;

    const isPdfAnchor = validPdfHref
      && !attr.inFormControl
      && !isFormControl
      && attrs.href !== null
      && (isDownloadBox || (attr.inZwinfo && attrs.hasDownload) || attr.nearestBox !== null || nextEncodeUrl !== null);

    let boxRecord: BoxRecord | null = null;
    if (isDownloadBox) {
      boxRecord = {
        owner: attrs.hasEncodeUrl ? attrs.encodeUrl : null,
        infoCode: attrs.hasInfoCode ? attrs.infoCode : null,
        hasForeignEncodeUrl: nextForeignEncode,
        hasInfoCodeConflict: nextInfoCodeConflict,
        hasAnyRelated: false,
        parent: cur.nearestBox,
      };
      allBoxes.push(boxRecord);
    }
    const nextNearestBox = boxRecord ?? cur.nearestBox;

    let createdRelBox: RelBoxRecord | null = null;
    if (isRelSelector && !isLandmarkRelatedElement(tag, attrs)) {
      createdRelBox = {
        sawRelatedKeyword: false,
        hasDescendantPdfOrScript: false,
        tail: '',
        pendingRelated: false,
        parent: cur.activeRelBox,
      };
    }

    let popScope = false;
    if (isIsolated) {
      popScope = true;
      const inheritedOuter = cur.outerRelated || (!cur.isDownloadBox && cur.relatedSeen);
      if (cur.isDownloadBox && cur.relatedSeen && cur.nearestBox !== null) {
        cur.nearestBox.hasAnyRelated = true;
      }
      scopeStack.push({
        inRelatedSelector: cur.inRelatedSelector || isRelSelector,
        isDownloadBox,
        outerRelated: inheritedOuter,
        relatedSeen: false,
        tail: '',
        pendingRelated: false,
        nearestBox: nextNearestBox,
        activeRelBox: createdRelBox ?? cur.activeRelBox,
      });
    }

    const pushAttr = attrs.hasEncodeUrl || attrs.hasInfoCode || isZwinfoId || isDownloadBox || isFormControl;
    if (pushAttr) {
      attrStack.push({
        nearestEncodeUrl: nextEncodeUrl,
        hasForeignEncodeUrl: nextForeignEncode,
        nearestInfoCode: nextInfoCode,
        hasInfoCodeConflict: nextInfoCodeConflict,
        nearestBox: nextNearestBox,
        inZwinfo: attr.inZwinfo || isZwinfoId,
        inFormControl: attr.inFormControl || isFormControl,
      });
    }

    if (isPdfAnchor) {
      const candidate: CandidateAnchor = {
        url: attrs.href!,
        owner: nextEncodeUrl,
        expectedInfoCode: nextInfoCode,
        hasForeignEncodeUrl: nextForeignEncode,
        hasInfoCodeConflict: nextInfoCodeConflict,
        boxRecord: nextNearestBox,
        inRelatedSelector: cur.inRelatedSelector || isRelSelector,
        outerRelated: false,
        poisoned: false,
        parent: candidateAnchorStack.length > 0 ? candidateAnchorStack[candidateAnchorStack.length - 1]! : null,
      };
      allCandidates.push(candidate);
      candidateAnchorStack.push(candidate);
    }

    const enterForeign = tag === 'svg' || tag === 'math';
    if (isVoid) {
      if (isPdfAnchor) {
        const fakeFrame: OpenElemFrame = {
          tag,
          isZwinfoId,
          popScope,
          popAttr: pushAttr,
          resetParentTail: !popScope && isBlockBoundary,
          closeCandidate: true,
          closeBox: boxRecord,
          closeRelBox: createdRelBox,
          enterNonContent: false,
          enterForeign: false,
        };
        openTagCounts.set(tag, (openTagCounts.get(tag) ?? 0) + 1);
        leaveElement(fakeFrame);
      } else {
        if (popScope) {
          flushScopePending(scopeStack[scopeStack.length - 1]!);
          scopeStack.pop();
        }
        if (pushAttr) attrStack.pop();
      }
      return;
    }

    if (enterForeign) foreignDepth += 1;
    openStack.push({
      tag,
      isZwinfoId,
      popScope,
      popAttr: pushAttr,
      resetParentTail: !popScope && isBlockBoundary,
      closeCandidate: isPdfAnchor,
      closeBox: boxRecord,
      closeRelBox: createdRelBox,
      enterNonContent: false,
      enterForeign,
    });
    openTagCounts.set(tag, (openTagCounts.get(tag) ?? 0) + 1);
  };

  let pos = 0;
  const len = html.length;
  let textStart = 0;
  const flushTextUntil = (end: number) => {
    if (end > textStart) feedText(html.slice(textStart, end));
  };

  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      flushTextUntil(len);
      break;
    }
    const nextCh = lt + 1 < len ? html[lt + 1]! : '';
    if (nextCh === '!') {
      flushTextUntil(lt);
      if (html.startsWith('<!--', lt)) {
        const cur = scopeStack[scopeStack.length - 1]!;
        if (nonContentDepth === 0) flushScopePending(cur);
        if (html.startsWith('<!-->', lt)) pos = lt + 5;
        else if (html.startsWith('<!--->', lt)) pos = lt + 6;
        else {
          const endComment = html.indexOf('-->', lt + 4);
          pos = endComment === -1 ? len : endComment + 3;
        }
      } else if (html.startsWith('<![CDATA[', lt)) {
        const endCdata = html.indexOf(']]>', lt + 9);
        pos = endCdata === -1 ? len : endCdata + 3;
      } else {
        const gt = html.indexOf('>', lt + 2);
        pos = gt === -1 ? len : gt + 1;
      }
      textStart = pos;
      continue;
    }
    if (nextCh === '?') {
      flushTextUntil(lt);
      const gt = html.indexOf('>', lt + 2);
      pos = gt === -1 ? len : gt + 1;
      textStart = pos;
      continue;
    }
    if (nextCh === '/') {
      flushTextUntil(lt);
      let j = lt + 2;
      if (j < len && /[A-Za-z]/u.test(html[j]!)) {
        const nameStart = j;
        while (j < len && !/[\s/>]/u.test(html[j]!)) j += 1;
        const closeTag = html.slice(nameStart, j).toLowerCase();
        const gt = html.indexOf('>', j);
        pos = gt === -1 ? len : gt + 1;
        handleCloseTag(closeTag);
      } else {
        const gt = html.indexOf('>', j);
        pos = gt === -1 ? len : gt + 1;
      }
      textStart = pos;
      continue;
    }
    if (/[A-Za-z]/u.test(nextCh)) {
      flushTextUntil(lt);
      let j = lt + 1;
      while (j < len && !/[\s/>]/u.test(html[j]!)) j += 1;
      const tag = html.slice(lt + 1, j).toLowerCase();
      const attrs: TagAttrs = {
        id: null,
        className: null,
        role: null,
        ariaLabel: null,
        href: null,
        src: null,
        hasSrc: false,
        hasDownload: false,
        type: null,
        encodeUrl: null,
        hasEncodeUrl: false,
        hasForeignEncodeUrl: false,
        infoCode: null,
        hasInfoCode: false,
        hasInfoCodeConflict: false,
      };
      let selfClosing = false;
      while (j < len) {
        while (j < len && /[\s]/u.test(html[j]!)) j += 1;
        if (j >= len) break;
        const c = html[j]!;
        if (c === '>') {
          j += 1;
          break;
        }
        if (c === '/') {
          if (j + 1 < len && html[j + 1] === '>') {
            selfClosing = true;
            j += 2;
            break;
          }
          j += 1;
          continue;
        }
        const attrStart = j;
        while (j < len && !/[\s=/>]/u.test(html[j]!)) j += 1;
        const attrName = html.slice(attrStart, j).toLowerCase();
        while (j < len && /[\s]/u.test(html[j]!)) j += 1;
        let attrVal = '';
        if (j < len && html[j] === '=') {
          j += 1;
          while (j < len && /[\s]/u.test(html[j]!)) j += 1;
          if (j < len && (html[j] === '"' || html[j] === "'")) {
            const quote = html[j]!;
            j += 1;
            const valStart = j;
            const endQuote = html.indexOf(quote, j);
            if (endQuote === -1) {
              attrVal = html.slice(valStart);
              j = len;
            } else {
              attrVal = html.slice(valStart, endQuote);
              j = endQuote + 1;
            }
          } else {
            const valStart = j;
            while (j < len && !/[\s>]/u.test(html[j]!)) j += 1;
            attrVal = html.slice(valStart, j);
          }
        }
        if (attrName === 'id') {
          if (attrs.id === null) attrs.id = decodeHtmlEntities(attrVal);
        } else if (attrName === 'class') {
          if (attrs.className === null) attrs.className = decodeHtmlEntities(attrVal);
        } else if (attrName === 'role') {
          if (attrs.role === null) attrs.role = decodeHtmlEntities(attrVal);
        } else if (attrName === 'aria-label') {
          if (attrs.ariaLabel === null) attrs.ariaLabel = decodeHtmlEntities(attrVal);
        } else if (attrName === 'href') {
          if (attrs.href === null) attrs.href = decodeHtmlEntities(attrVal);
        } else if (attrName === 'src') {
          attrs.hasSrc = true;
          if (attrs.src === null) attrs.src = decodeHtmlEntities(attrVal);
        } else if (attrName === 'download') {
          attrs.hasDownload = true;
        } else if (attrName === 'type') {
          if (attrs.type === null) attrs.type = decodeHtmlEntities(attrVal);
        } else if (attrName === 'data-encode-url') {
          const decoded = decodeHtmlEntities(attrVal);
          if (!attrs.hasEncodeUrl) {
            attrs.hasEncodeUrl = true;
            attrs.encodeUrl = decoded;
          } else if (attrs.encodeUrl !== decoded) {
            attrs.hasForeignEncodeUrl = true;
          }
          if (decoded !== expectedEncodeUrl) attrs.hasForeignEncodeUrl = true;
        } else if (attrName === 'data-info-code') {
          const decoded = decodeHtmlEntities(attrVal);
          if (!attrs.hasInfoCode) {
            attrs.hasInfoCode = true;
            attrs.infoCode = decoded;
          } else if (attrs.infoCode !== decoded) {
            attrs.hasInfoCodeConflict = true;
          }
        }
      }
      pos = j;
      if (rawTextTags.has(tag)) {
        const raw = findRawElementClose(html, pos, tag);
        const body = html.slice(pos, raw.contentEnd);
        pos = raw.nextPos;
        handleOpenTag(tag, attrs, selfClosing, body);
      } else {
        handleOpenTag(tag, attrs, selfClosing);
      }
      textStart = pos;
      continue;
    }
    pos = lt + 1;
  }

  while (openStack.length > 0) {
    leaveElement(openStack.pop()!);
  }
  flushScopePending(scopeStack[0]!);

  for (let i = 0; i < allBoxes.length; i += 1) {
    const box = allBoxes[i]!;
    if (box.parent?.hasAnyRelated) box.hasAnyRelated = true;
  }
  for (let i = 0; i < allCandidates.length; i += 1) {
    const c = allCandidates[i]!;
    if (c.parent?.poisoned) c.poisoned = true;
  }

  return { scripts, attachments };
}

function stripLeadingJsTrivia(source: string): string {
  let pos = 0;
  const len = source.length;
  while (pos < len) {
    const ch = source[pos]!;
    if (/\s/u.test(ch)) {
      pos += 1;
      continue;
    }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '/') {
      const nl = source.indexOf('\n', pos + 2);
      pos = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      pos = end === -1 ? len : end + 2;
      continue;
    }
    break;
  }
  return source.slice(pos);
}

/** 按平衡花括号提取 JS 对象字面量，跳过字符串与注释，严格 O(N)。 */
function extractBalancedObjectLiteral(source: string, openBracePos: number): number {
  if (source[openBracePos] !== '{') return -1;
  let pos = openBracePos;
  let depth = 0;
  const len = source.length;
  while (pos < len) {
    const ch = source[pos]!;
    if (ch === '"' || ch === "'") {
      const q = ch;
      pos += 1;
      while (pos < len) {
        if (source[pos] === '\\') pos += 2;
        else if (source[pos] === q) { pos += 1; break; }
        else pos += 1;
      }
      continue;
    }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '/') {
      const nl = source.indexOf('\n', pos + 2);
      pos = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      pos = end === -1 ? len : end + 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return pos + 1;
    }
    pos += 1;
  }
  return -1;
}

type JsToken = { kind: 'ident' | 'string' | 'punct'; value: string; escaped?: boolean };
const regexAllowedBefore = new Set([
  '(', '[', '{', ',', ';', ':', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '^=', '|=', '&&=', '||=', '??=',
  '!', '&', '|', '&&', '||', '??', '?', '+', '-', '*', '/', '%', '^', '~', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '=>',
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'else', 'do', 'yield', 'await',
]);
const jsAssignOps = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '^=', '|=', '&&=', '||=', '??=',
]);
const globalReceivers = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames', 'this']);

function decodeJsUnicodeEscape(source: string, pos: number): { ch: string; nextPos: number } | null {
  if (source[pos] !== '\\' || source[pos + 1] !== 'u') return null;
  if (source[pos + 2] === '{') {
    const end = source.indexOf('}', pos + 3);
    if (end === -1 || end === pos + 3 || end - (pos + 3) > 6) return null;
    const hex = source.slice(pos + 3, end);
    if (!/^[0-9a-fA-F]+$/u.test(hex)) return null;
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff) return null;
    return { ch: String.fromCodePoint(cp), nextPos: end + 1 };
  }
  const hex = source.slice(pos + 2, pos + 6);
  if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return null;
  return { ch: String.fromCharCode(Number.parseInt(hex, 16)), nextPos: pos + 6 };
}

function tokenizeJs(source: string): JsToken[] {
  const tokens: JsToken[] = [];
  let pos = 0;
  const len = source.length;
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  const pushToken = (kind: JsToken['kind'], value: string, escaped?: boolean) => {
    tokens.push(escaped ? { kind, value, escaped } : { kind, value });
  };
  const canStartRegex = () => {
    if (tokens.length === 0) return true;
    const prev = tokens[tokens.length - 1]!;
    return regexAllowedBefore.has(prev.value);
  };
  const scanTemplateRest = () => {
    let chunk = '';
    let escaped = false;
    while (pos < len) {
      const ch = source[pos]!;
      if (ch === '\\') {
        escaped = true;
        if (pos + 1 < len) chunk += source[pos + 1]!;
        pos += 2;
        continue;
      }
      if (ch === '`') {
        pos += 1;
        pushToken('string', chunk, escaped);
        return;
      }
      if (ch === '$' && pos + 1 < len && source[pos + 1] === '{') {
        pushToken('string', chunk, escaped);
        pushToken('punct', '${');
        pos += 2;
        braceDepth += 1;
        templateBraceDepths.push(braceDepth);
        return;
      }
      chunk += ch;
      pos += 1;
    }
    pushToken('string', chunk, escaped);
  };
  while (pos < len) {
    const ch = source[pos]!;
    if (/\s/u.test(ch)) { pos += 1; continue; }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '/') {
      const nl = source.indexOf('\n', pos + 2);
      pos = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === '/' && pos + 1 < len && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      pos = end === -1 ? len : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      pos += 1;
      let val = '';
      let escaped = false;
      while (pos < len) {
        const c = source[pos]!;
        if (c === '\\') {
          escaped = true;
          if (pos + 1 < len) val += source[pos + 1]!;
          pos += 2;
        } else if (c === q) {
          pos += 1;
          break;
        } else {
          val += c;
          pos += 1;
        }
      }
      pushToken('string', val, escaped);
      continue;
    }
    if (ch === '`') {
      pos += 1;
      scanTemplateRest();
      continue;
    }
    if (ch === '/' && canStartRegex()) {
      pos += 1;
      let inClass = false;
      while (pos < len) {
        const c = source[pos]!;
        if (c === '\\') { pos += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { pos += 1; break; }
        else if (c === '\n' || c === '\r') break;
        pos += 1;
      }
      while (pos < len && /[a-z]/iu.test(source[pos]!)) pos += 1;
      pushToken('string', '');
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch) || (ch === '\\' && source[pos + 1] === 'u')) {
      let ident = '';
      while (pos < len) {
        const c = source[pos]!;
        if (/[\w$]/u.test(c)) {
          ident += c;
          pos += 1;
        } else if (c === '\\') {
          const decoded = decodeJsUnicodeEscape(source, pos);
          if (!decoded) break;
          ident += decoded.ch;
          pos = decoded.nextPos;
        } else {
          break;
        }
      }
      if (ident.length > 0) {
        pushToken('ident', ident);
        continue;
      }
    }
    if (/[0-9]/u.test(ch)) {
      pos += 1;
      while (pos < len && /[\w.]/u.test(source[pos]!)) pos += 1;
      pushToken('punct', '0');
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      pushToken('punct', '{');
      pos += 1;
      continue;
    }
    if (ch === '}') {
      if (templateBraceDepths.length > 0 && templateBraceDepths[templateBraceDepths.length - 1] === braceDepth) {
        templateBraceDepths.pop();
        braceDepth -= 1;
        pushToken('punct', '}');
        pos += 1;
        scanTemplateRest();
        continue;
      }
      if (braceDepth > 0) braceDepth -= 1;
      pushToken('punct', '}');
      pos += 1;
      continue;
    }
    const four = source.slice(pos, pos + 4);
    if (four === '>>>=') { pushToken('punct', four); pos += 4; continue; }
    const three = source.slice(pos, pos + 3);
    if (three === '===' || three === '!==' || three === '**=' || three === '<<=' || three === '>>=' || three === '&&=' || three === '||=' || three === '??=') {
      pushToken('punct', three);
      pos += 3;
      continue;
    }
    const two = source.slice(pos, pos + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '=>' || two === '+=' || two === '-='
      || two === '*=' || two === '/=' || two === '%=' || two === '&=' || two === '^=' || two === '|='
      || two === '&&' || two === '||' || two === '??' || two === '?.') {
      pushToken('punct', two);
      pos += 2;
      continue;
    }
    pushToken('punct', ch);
    pos += 1;
  }
  return tokens;
}

/** 扫描脚本剩余代码令牌（跳过字符串与注释，严格 O(N)），拦截所有对 zwinfo / window.pdf 的动态或未识别修改。 */
function hasUnverifiedScriptAssignment(source: string): boolean {
  const tokens = tokenizeJs(source);
  const matchCloseBracket = new Int32Array(tokens.length);
  matchCloseBracket.fill(-1);
  const openBrackets: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind === 'punct' && tk.value === '[') {
      openBrackets.push(i);
    } else if (tk.kind === 'punct' && tk.value === ']' && openBrackets.length > 0) {
      matchCloseBracket[openBrackets.pop()!] = i;
    }
  }
  const skipMemberChain = (startIdx: number): number => {
    let idx = startIdx;
    while (idx < tokens.length) {
      const tk = tokens[idx]!;
      if (tk.kind === 'punct' && (tk.value === '.' || tk.value === '?.')) {
        idx += 1;
        if (idx < tokens.length && tokens[idx]!.kind === 'ident') idx += 1;
        continue;
      }
      if (tk.kind === 'punct' && tk.value === '[') {
        const close = matchCloseBracket[idx]!;
        idx = close === -1 ? tokens.length : close + 1;
        continue;
      }
      break;
    }
    return idx;
  };
  const followedByMutation = (idx: number): boolean => {
    let j = idx;
    while (j < tokens.length && tokens[j]!.kind === 'punct' && (tokens[j]!.value === ')' || tokens[j]!.value === '}' || tokens[j]!.value === ']')) {
      j += 1;
    }
    return j < tokens.length && tokens[j]!.kind === 'punct' && jsAssignOps.has(tokens[j]!.value);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind !== 'ident') continue;
    if (tk.value === 'zwinfo') {
      const prev = i > 0 ? tokens[i - 1]! : null;
      if (prev && prev.kind === 'punct' && prev.value === '.') continue;
      if (prev && prev.kind === 'ident' && prev.value === 'delete') return true;
      const after = skipMemberChain(i + 1);
      if (followedByMutation(after)) return true;
      continue;
    }
    if (globalReceivers.has(tk.value)) {
      const prev = i > 0 ? tokens[i - 1]! : null;
      if (prev && prev.kind === 'punct' && prev.value === '.') continue;
      const next = i + 1 < tokens.length ? tokens[i + 1]! : null;
      if (!next || next.kind !== 'punct') continue;
      if (next.value === '.' || next.value === '?.') {
        const prop = i + 2 < tokens.length ? tokens[i + 2]! : null;
        if (prop && prop.kind === 'ident' && (prop.value === 'pdf' || prop.value === 'zwinfo')) {
          if (prev && prev.kind === 'ident' && prev.value === 'delete') return true;
          const after = skipMemberChain(i + 3);
          if (followedByMutation(after)) return true;
        }
      } else if (next.value === '[') {
        const closeBracket = matchCloseBracket[i + 1]!;
        const firstCloseIdx = closeBracket === -1 ? tokens.length : closeBracket + 1;
        const insideLen = closeBracket === -1 ? 0 : closeBracket - (i + 2);
        const singleSafeLiteral = insideLen === 1
          && tokens[i + 2]!.kind === 'string'
          && !tokens[i + 2]!.escaped
          && tokens[i + 2]!.value !== 'pdf'
          && tokens[i + 2]!.value !== 'zwinfo';
        if (!singleSafeLiteral) {
          if (prev && prev.kind === 'ident' && prev.value === 'delete') return true;
          const after = skipMemberChain(firstCloseIdx);
          if (followedByMutation(after)) return true;
        }
      }
      continue;
    }
    if ((tk.value === 'Object' || tk.value === 'Reflect') && i + 4 < tokens.length
      && tokens[i + 1]!.kind === 'punct' && tokens[i + 1]!.value === '.'
      && tokens[i + 2]!.kind === 'ident' && (tokens[i + 2]!.value === 'assign' || tokens[i + 2]!.value === 'defineProperty' || tokens[i + 2]!.value === 'defineProperties' || tokens[i + 2]!.value === 'set')
      && tokens[i + 3]!.kind === 'punct' && tokens[i + 3]!.value === '(') {
      const target = tokens[i + 4]!;
      if (target.kind === 'ident' && (target.value === 'zwinfo' || globalReceivers.has(target.value))) {
        return true;
      }
    }
  }
  return false;
}

/** 零递归严格 fail-closed 解析详情页；仅返回同源固定格式 PDF 定位，不下载、不执行脚本。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const rawHtml = decodeUtf8(rawBytes);
  const candidates = new Map<string, string>(), declaredCodes = new Set<string>();
  const sections = analyzeEastmoneySections(rawHtml, bound.url.href, request.encodeUrl);
  const collect = (candidate: string, expectedInfoCode?: string | null) => {
    let url: URL;
    try { url = new URL(candidate, bound.url); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'pdf.dfcfw.com' || url.port || url.username || url.password) return;
    const match = /^\/pdf\/H3_(AP\d{8,20})_1\.pdf$/u.exec(url.pathname);
    if (match && expectedInfoCode && match[1] !== expectedInfoCode) return invalid('研报详情标识与附件标识不符。');
    if (match) candidates.set(url.href, match[1]!);
  };
  const processScript = (script: ScriptEntry, requiredInfoCode: string | null) => {
    if (script.hasInfoCodeConflict) return invalid('研报详情标识与附件标识不符。');
    let source = stripLeadingJsTrivia(script.content);
    while (source) {
      const pdf = /^window\.pdf\s*=\s*(["'])(https:\/\/pdf\.dfcfw\.com\/pdf\/H3_AP\d{8,20}_1\.pdf)\1\s*(?:;|$)/u.exec(source);
      if (pdf) {
        collect(pdf[2], requiredInfoCode);
        source = stripLeadingJsTrivia(source.slice(pdf[0].length));
        continue;
      }
      const zwHead = /^(?:(?:var|let|const)\s+|window\.)?zwinfo\s*=\s*/u.exec(source);
      if (zwHead && source[zwHead[0].length] === '{') {
        const objEnd = extractBalancedObjectLiteral(source, zwHead[0].length);
        if (objEnd === -1) return invalid('研报详情元数据无法核对。');
        const tailMatch = /^\s*(?:;|$)/u.exec(source.slice(objEnd));
        if (!tailMatch) return invalid('详情脚本包含无法静态核对的研报或附件声明。');
        const info = detailMetadata(source.slice(zwHead[0].length, objEnd));
        if (!info) return invalid('研报详情元数据无法核对。');
        if (info.encodeUrl !== undefined && info.encodeUrl !== request.encodeUrl) return invalid('研报详情标识与请求不符。');
        const infoCode = infoCodeOf(info.infoCode);
        if (infoCode && requiredInfoCode && infoCode !== requiredInfoCode) return invalid('研报详情标识与附件标识不符。');
        if (infoCode) declaredCodes.add(infoCode);
        const effCode = infoCode ?? requiredInfoCode;
        for (const key of ['pdfUrl', 'pdf_url', 'attachUrl', 'attach_url'])
          if (typeof info[key] === 'string') collect(info[key], effCode);
        source = stripLeadingJsTrivia(source.slice(objEnd + tailMatch[0].length));
        continue;
      }
      const code = /^(?:window\s*\.\s*)?zwinfo\s*\.\s*infoCode\s*=\s*(["'])(AP\d{8,20})\1\s*(?:;|$)/u.exec(source);
      if (code) {
        if (requiredInfoCode && code[2] !== requiredInfoCode) return invalid('研报详情标识与附件标识不符。');
        declaredCodes.add(code[2]);
        source = stripLeadingJsTrivia(source.slice(code[0].length));
        continue;
      }
      if (hasUnverifiedScriptAssignment(source))
        return invalid('详情脚本包含无法静态核对的研报或附件声明。');
      break;
    }
  };

  const isAttestedBox = (box: BoxRecord | null, owner: string | null, expectedInfoCode: string | null): boolean => Boolean(
    box
    && !box.hasAnyRelated
    && !box.hasForeignEncodeUrl
    && !box.hasInfoCodeConflict
    && box.owner === request.encodeUrl && owner === request.encodeUrl
    && box.infoCode && declaredCodes.has(box.infoCode) && expectedInfoCode === box.infoCode,
  );

  // 第一遍：仅处理非外层相关区域的静态脚本，建立可信 declaredCodes。
  const deferredBoxScripts: ScriptEntry[] = [];
  for (const script of sections.scripts) {
    if (script.hasForeignEncodeUrl || script.inRelatedSelector || script.enclosingCandidate?.poisoned) continue;
    if (script.boxRecord?.hasAnyRelated) continue;
    if (script.outerRelated) {
      if (script.boxRecord !== null) deferredBoxScripts.push(script);
      continue;
    }
    processScript(script, script.expectedInfoCode);
  }
  // 第二遍：允许位于已证明主下载框内的脚本跨越外层相关标记。
  for (const script of deferredBoxScripts) {
    if (!isAttestedBox(script.boxRecord, script.boxRecord?.owner ?? null, script.expectedInfoCode)) continue;
    processScript(script, script.expectedInfoCode);
  }

  for (const status of sections.attachments) {
    if (status.hasForeignEncodeUrl || status.inRelatedSelector || status.candidateRecord?.poisoned) continue;
    if (status.owner != null && status.owner !== request.encodeUrl) continue;
    if (status.boxRecord?.hasAnyRelated) continue;
    const attestedMainDownload = isAttestedBox(status.boxRecord, status.owner, status.expectedInfoCode);
    if (!attestedMainDownload && status.outerRelated) continue;
    if (status.hasInfoCodeConflict) return invalid('研报详情标识与附件标识不符。');
    collect(status.url, status.expectedInfoCode);
  }
  if (new Set([...declaredCodes, ...candidates.values()]).size > 1) return invalid('研报详情元数据与附件声明指向不同的 infoCode。');
  if (candidates.size !== 1) return invalid(candidates.size ? '研报详情存在多个不同附件定位，须明确选择。' : '研报详情没有可验证的 PDF 附件定位。');
  const [pdfUrl, infoCode] = [...candidates.entries()][0]!;
  return { decoderVersion: 'eastmoney-report-detail/1' as const, providerId: 'eastmoney' as const, request: bound.request,
    detailUrl: bound.url.href, infoCode, pdfUrl, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    attachmentFetched: false as const, historyAvailability: 'not_established' as const };
}

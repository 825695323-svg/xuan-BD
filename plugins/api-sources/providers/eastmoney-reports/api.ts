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

/** 迭代式严格 RFC 8259 JSON 对象解析（零递归、无任意浅深度截断、拒绝任意层级的重复键）。 */
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
  type ContainerFrame =
    | { kind: 'object'; value: Record<string, JsonValue>; key: string | null }
    | { kind: 'array'; value: JsonValue[] };
  const frames: ContainerFrame[] = [];
  let root: JsonValue | undefined;
  const attachValue = (val: JsonValue): boolean => {
    if (frames.length === 0) {
      root = val;
      return true;
    }
    const top = frames[frames.length - 1]!;
    if (top.kind === 'array') {
      top.value.push(val);
      return true;
    }
    if (top.key === null) return false;
    top.value[top.key] = val;
    top.key = null;
    return true;
  };
  const expectValue = (): 'need_value' | 'after_value' | 'error' | typeof DUPLICATE_JSON_KEY => {
    skipWs();
    if (pos >= len) return 'error';
    const ch = literal[pos]!;
    if (ch === '{') {
      pos += 1;
      const obj: Record<string, JsonValue> = Object.create(null);
      if (!attachValue(obj)) return 'error';
      skipWs();
      if (literal[pos] === '}') {
        pos += 1;
        return 'after_value';
      }
      const key = parseString();
      if (key === null) return 'error';
      skipWs();
      if (literal[pos] !== ':') return 'error';
      pos += 1;
      frames.push({ kind: 'object', value: obj, key });
      return 'need_value';
    }
    if (ch === '[') {
      pos += 1;
      const arr: JsonValue[] = [];
      if (!attachValue(arr)) return 'error';
      skipWs();
      if (literal[pos] === ']') {
        pos += 1;
        return 'after_value';
      }
      frames.push({ kind: 'array', value: arr });
      return 'need_value';
    }
    if (ch === '"') {
      const str = parseString();
      if (str === null || !attachValue(str)) return 'error';
      return 'after_value';
    }
    if (literal.startsWith('true', pos)) { pos += 4; return attachValue(true) ? 'after_value' : 'error'; }
    if (literal.startsWith('false', pos)) { pos += 5; return attachValue(false) ? 'after_value' : 'error'; }
    if (literal.startsWith('null', pos)) { pos += 4; return attachValue(null) ? 'after_value' : 'error'; }
    const numRe = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numRe.lastIndex = pos;
    const numMatch = numRe.exec(literal);
    if (!numMatch) return 'error';
    const num = Number(numMatch[0]);
    if (!Number.isFinite(num) || !attachValue(num)) return 'error';
    pos += numMatch[0].length;
    return 'after_value';
  };

  skipWs();
  if (literal[pos] !== '{') return null;
  let state: 'need_value' | 'after_value' = 'need_value';
  while (true) {
    if (state === 'need_value') {
      const next = expectValue();
      if (next === DUPLICATE_JSON_KEY) return DUPLICATE_JSON_KEY;
      if (next === 'error') return null;
      state = next;
      continue;
    }
    if (frames.length === 0) break;
    skipWs();
    const top = frames[frames.length - 1]!;
    if (top.kind === 'object') {
      if (literal[pos] === ',') {
        pos += 1;
        skipWs();
        const key = parseString();
        if (key === null) return null;
        if (Object.hasOwn(top.value, key)) return DUPLICATE_JSON_KEY;
        skipWs();
        if (literal[pos] !== ':') return null;
        pos += 1;
        top.key = key;
        state = 'need_value';
        continue;
      }
      if (literal[pos] === '}') {
        pos += 1;
        frames.pop();
        continue;
      }
      return null;
    }
    if (literal[pos] === ',') {
      pos += 1;
      state = 'need_value';
      continue;
    }
    if (literal[pos] === ']') {
      pos += 1;
      frames.pop();
      continue;
    }
    return null;
  }
  skipWs();
  return pos === len && object(root) ? root : null;
}

/** 接受严格无重复键 JSON 或仅含单行静态字符串的旧式 JS 对象字面量；脚本从不执行。 */
function detailMetadata(literal: string): Record<string, JsonValue> | null {
  const strictJson = parseStrictJsonObject(literal);
  if (strictJson === DUPLICATE_JSON_KEY) return null;
  if (strictJson !== null) return strictJson;
  const body = literal.slice(1, -1).trim();
  const field = /\s*(?:([a-zA-Z_][\w]*)|"([\w]+)"|'([\w]+)')\s*:\s*(?:"([^"\\\r\n\u2028\u2029]*)"|'([^'\\\r\n\u2028\u2029]*)')\s*(?:,|$)/gy;
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
  Tab: '\t',
  NewLine: '\n',
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: '\u00a0',
  NonBreakingSpace: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  emsp13: '\u2004',
  emsp14: '\u2005',
  numsp: '\u2007',
  puncsp: '\u2008',
  thinsp: '\u2009',
  ThinSpace: '\u2009',
  hairsp: '\u200a',
  VeryThinSpace: '\u200a',
  ZeroWidthSpace: '\u200b',
  NegativeThinSpace: '\u200b',
  NegativeMediumSpace: '\u200b',
  NegativeThickSpace: '\u200b',
  NegativeVeryThinSpace: '\u200b',
  MediumSpace: '\u205f',
  ThickSpace: '\u205f\u200a',
  zwj: '\u200d',
  zwnj: '\u200c',
  shy: '\u00ad',
  colon: ':',
  semi: ';',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lcub: '{',
  rcub: '}',
  comma: ',',
  period: '.',
  excl: '!',
  quest: '?',
  num: '#',
  percnt: '%',
  plus: '+',
  equals: '=',
  ast: '*',
  lowbar: '_',
  hyphen: '-',
  dash: '\u2010',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  hellip: '\u2026',
  copy: '\u00a9',
  COPY: '\u00a9',
  reg: '\u00ae',
  REG: '\u00ae',
  trade: '\u2122',
  TRADE: '\u2122',
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
        let sigStart = digitsStart;
        while (sigStart < j && input[sigStart] === '0') sigStart += 1;
        const significant = input.slice(sigStart, j);
        if (j < len && input[j] === ';') j += 1;
        const cp = significant.length === 0 ? 0
          : significant.length > 7 ? 0x110000
          : Number.parseInt(significant, hex ? 16 : 10);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) out += '\ufffd';
        else out += String.fromCodePoint(cp);
        i = j;
        continue;
      }
    } else {
      let j = amp + 1;
      while (j < len && j - amp <= 32) {
        const c = input.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j += 1;
        else break;
      }
      if (j > amp + 1 && j < len && input[j] === ';') {
        const name = input.slice(amp + 1, j);
        if (Object.hasOwn(namedHtmlEntities, name)) {
          out += namedHtmlEntities[name]!;
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

function isAsciiWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function trimAsciiWs(value: string): string {
  let s = 0;
  let e = value.length;
  while (s < e && isAsciiWs(value.charCodeAt(s))) s += 1;
  while (e > s && isAsciiWs(value.charCodeAt(e - 1))) e -= 1;
  return value.slice(s, e);
}

const voidHtmlTags = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const rawTextTags = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
const formControlTags = new Set([
  'form', 'fieldset', 'object', 'select', 'option', 'optgroup', 'textarea', 'button', 'input', 'datalist', 'output', 'meter', 'progress',
]);
const isolatedAuxiliaryTags = new Set(['head', 'details', 'figure', 'dialog', ...formControlTags]);
const nonContentSubtreeTags = new Set(['meta', 'link', 'title', 'style', 'noscript', 'template', 'xmp', 'noembed', 'noframes']);
const rootBoundaryTags = new Set(['main', 'body', 'html']);
const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'legend']);
const landmarkRelatedTags = new Set(['aside', 'nav', 'footer']);
const relatedClassTokens = new Set(['rel-list', 'xgyd', 'xgyb']);
const pAutoCloseTags = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul',
]);
const buttonScopeBarrierTags = new Set([
  'applet', 'button', 'caption', 'html', 'marquee', 'math', 'object', 'svg', 'table', 'td', 'template', 'th',
]);
const blockBoundaryTags = new Set([
  'html', 'head', 'body', 'main', 'article', 'section', 'aside', 'nav', 'header', 'footer', 'address', 'search', 'menu', 'center',
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
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'application/x-ecmascript',
]);
const relatedKeywordsWithCountGuard = new Set(['相关阅读', '推荐阅读', '延伸阅读']);

/** 严格按 WHATWG HTML §4.12.1.1 判定可执行脚本类型（精确 essence 匹配，不截断分号参数，核对 language 属性）。 */
function isExecutableScriptType(typeAttr: string | null, languageAttr: string | null): boolean {
  if (typeAttr !== null) {
    const trimmed = trimAsciiWs(typeAttr);
    if (trimmed === '') return true;
    const lower = trimmed.toLowerCase();
    return lower === 'module' || jsMimeEssences.has(lower);
  }
  if (languageAttr !== null) {
    const trimmed = trimAsciiWs(languageAttr);
    if (trimmed === '') return true;
    return jsMimeEssences.has(`text/${trimmed.toLowerCase()}`);
  }
  return true;
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
  hasSrcdoc: boolean;
  hasDownload: boolean;
  type: string | null;
  language: string | null;
  encodeUrl: string | null;
  hasEncodeUrl: boolean;
  hasForeignEncodeUrl: boolean;
  infoCode: string | null;
  hasInfoCode: boolean;
  hasInfoCodeConflict: boolean;
};

function hasClassToken(className: string | null, expected: string): boolean {
  if (!className) return false;
  const tokens = className.split(/[ \t\n\f\r]+/u);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === expected) return true;
  }
  return false;
}

function isRelatedElement(tag: string, attrs: TagAttrs): boolean {
  if (landmarkRelatedTags.has(tag)) return true;
  if (attrs.role !== null && trimAsciiWs(attrs.role).toLowerCase() === 'navigation') return true;
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
    const tokens = attrs.className.split(/[ \t\n\f\r]+/u);
    for (let i = 0; i < tokens.length; i += 1) {
      if (relatedClassTokens.has(tokens[i]!)) return true;
    }
  }
  return false;
}

function isLandmarkRelatedElement(tag: string, attrs: TagAttrs): boolean {
  return landmarkRelatedTags.has(tag) || (attrs.role !== null && trimAsciiWs(attrs.role).toLowerCase() === 'navigation');
}

function isHeadingElement(tag: string, attrs: TagAttrs): boolean {
  return headingTags.has(tag) || (attrs.role !== null && trimAsciiWs(attrs.role).toLowerCase() === 'heading');
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

function isTagDelimiter(html: string, idx: number): boolean {
  if (idx >= html.length) return true;
  const ch = html[idx]!;
  return ch === '/' || ch === '>' || isAsciiWs(ch.charCodeAt(0));
}

function findHtmlCommentEnd(html: string, startPos: number): number {
  let pos = startPos;
  const len = html.length;
  while (pos < len) {
    const dash = html.indexOf('--', pos);
    if (dash === -1) return len;
    if (dash + 2 < len && html[dash + 2] === '>') return dash + 3;
    if (dash + 3 < len && html[dash + 2] === '!' && html[dash + 3] === '>') return dash + 4;
    pos = dash + 1;
  }
  return len;
}

/** 单趟 O(N) 定位 rawtext/script 结束标签，严格遵守 HTML5 script-data-escaped 状态与 EOF 闭合要求。 */
function findRawElementClose(html: string, startPos: number, tag: string): { contentEnd: number; nextPos: number; closed: boolean } {
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
        if (isTagDelimiter(html, after)) {
          doubleEscaped = true;
          pos = after;
          continue;
        }
      }
    }
    if (html[pos] === '<' && pos + 2 + tagLen <= len && html[pos + 1] === '/') {
      if (html.slice(pos + 2, pos + 2 + tagLen).toLowerCase() === tag) {
        const after = pos + 2 + tagLen;
        if (isTagDelimiter(html, after)) {
          if (isScript && doubleEscaped) {
            doubleEscaped = false;
            pos = after;
            continue;
          }
          const gt = html.indexOf('>', after);
          return gt === -1
            ? { contentEnd: len, nextPos: len, closed: false }
            : { contentEnd: pos, nextPos: gt + 1, closed: true };
        }
      }
    }
    pos += 1;
  }
  return { contentEnd: len, nextPos: len, closed: false };
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
    pushButtonScope: boolean;
    countedP: boolean;
  };
  const openStack: OpenElemFrame[] = [];
  const openTagCounts = new Map<string, number>();
  const pCountInButtonScope: number[] = [0];
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

  const feedText = (rawText: string, decodeEntities = true): void => {
    if (nonContentDepth > 0 || !rawText) return;
    const text = decodeEntities ? decodeHtmlEntities(rawText) : rawText;
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

    if (frame.countedP) {
      pCountInButtonScope[pCountInButtonScope.length - 1] = Math.max(0, pCountInButtonScope[pCountInButtonScope.length - 1]! - 1);
    }
    if (frame.pushButtonScope && pCountInButtonScope.length > 1) {
      pCountInButtonScope.pop();
    }
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

    if (frame.popScope) {
      flushScopePending(activeScope);
      scopeStack.pop();
    } else if (frame.resetParentTail) {
      flushScopePending(activeScope);
      activeScope.tail = '';
      if (activeScope.activeRelBox !== null) activeScope.activeRelBox.tail = '';
    }

    if (frame.closeBox !== null && frame.closeBox.hasAnyRelated && frame.closeBox.parent !== null) {
      frame.closeBox.parent.hasAnyRelated = true;
    }

    if (frame.closeRelBox !== null) {
      if (frame.closeRelBox.pendingRelated) {
        frame.closeRelBox.pendingRelated = false;
        frame.closeRelBox.sawRelatedKeyword = true;
      }
      if (frame.closeRelBox.hasDescendantPdfOrScript && frame.closeRelBox.parent !== null) {
        frame.closeRelBox.parent.hasDescendantPdfOrScript = true;
      }
      if (frame.closeRelBox.sawRelatedKeyword && frame.closeRelBox.parent !== null) {
        frame.closeRelBox.parent.sawRelatedKeyword = true;
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

  const handleOpenTag = (tag: string, attrs: TagAttrs, selfClosing: boolean, rawBody?: string, rawClosed = true): void => {
    if (nonContentDepth === 0 && pAutoCloseTags.has(tag) && pCountInButtonScope[pCountInButtonScope.length - 1]! > 0) {
      handleCloseTag('p');
    }

    const enterForeign = tag === 'svg' || tag === 'math';
    const isVoid = voidHtmlTags.has(tag) || ((foreignDepth > 0 || enterForeign) && selfClosing);
    const cur = scopeStack[scopeStack.length - 1]!;
    const attr = attrStack[attrStack.length - 1]!;

    if (nonContentDepth > 0 || nonContentSubtreeTags.has(tag)) {
      if (!isVoid && rawBody === undefined) {
        const enterNonContent = nonContentSubtreeTags.has(tag);
        if (enterNonContent) nonContentDepth += 1;
        const pushButtonScope = buttonScopeBarrierTags.has(tag);
        if (pushButtonScope) pCountInButtonScope.push(0);
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
          pushButtonScope,
          countedP: false,
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
      cur.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.hasDescendantPdfOrScript = true;
      if (
        rawClosed
        && !attrs.hasSrc
        && !attr.inFormControl
        && isExecutableScriptType(attrs.type, attrs.language)
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
      cur.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.tail = '';
      const isDirectZwinfoChild = openStack.length > 0 && openStack[openStack.length - 1]!.isZwinfoId;
      const validSrc = !attrs.hasSrcdoc && isEastmoneyPdfHref(attrs.src, baseUrl);
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
          pushButtonScope: false,
          countedP: false,
        };
        openTagCounts.set(tag, (openTagCounts.get(tag) ?? 0) + 1);
        leaveElement(fakeFrame);
      } else {
        if (popScope) {
          flushScopePending(scopeStack[scopeStack.length - 1]!);
          scopeStack.pop();
        }
        if (boxRecord !== null && boxRecord.hasAnyRelated && boxRecord.parent !== null) {
          boxRecord.parent.hasAnyRelated = true;
        }
        if (pushAttr) attrStack.pop();
      }
      return;
    }

    if (enterForeign) foreignDepth += 1;
    const pushButtonScope = buttonScopeBarrierTags.has(tag);
    if (pushButtonScope) pCountInButtonScope.push(0);
    const countedP = tag === 'p';
    if (countedP) pCountInButtonScope[pCountInButtonScope.length - 1]! += 1;
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
      pushButtonScope,
      countedP,
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
        if (html.startsWith('<!-->', lt)) pos = lt + 5;
        else if (html.startsWith('<!--->', lt)) pos = lt + 6;
        else pos = findHtmlCommentEnd(html, lt + 4);
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
        while (j < len && !isTagDelimiter(html, j)) j += 1;
        const closeTag = html.slice(nameStart, j).toLowerCase();
        const gt = html.indexOf('>', j);
        if (gt === -1) {
          pos = len;
        } else {
          pos = gt + 1;
          handleCloseTag(closeTag);
        }
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
      while (j < len && !isTagDelimiter(html, j)) j += 1;
      const tag = html.slice(lt + 1, j).toLowerCase();
      const attrs: TagAttrs = {
        id: null,
        className: null,
        role: null,
        ariaLabel: null,
        href: null,
        src: null,
        hasSrc: false,
        hasSrcdoc: false,
        hasDownload: false,
        type: null,
        language: null,
        encodeUrl: null,
        hasEncodeUrl: false,
        hasForeignEncodeUrl: false,
        infoCode: null,
        hasInfoCode: false,
        hasInfoCodeConflict: false,
      };
      let selfClosing = false;
      let tagClosed = false;
      while (j < len) {
        while (j < len && isAsciiWs(html.charCodeAt(j))) j += 1;
        if (j >= len) break;
        const c = html[j]!;
        if (c === '>') {
          tagClosed = true;
          j += 1;
          break;
        }
        if (c === '/') {
          if (j + 1 < len && html[j + 1] === '>') {
            selfClosing = true;
            tagClosed = true;
            j += 2;
            break;
          }
          j += 1;
          continue;
        }
        const attrStart = j;
        while (j < len) {
          const ch = html[j]!;
          if (ch === '=' || ch === '/' || ch === '>' || isAsciiWs(ch.charCodeAt(0))) break;
          j += 1;
        }
        const attrName = html.slice(attrStart, j).toLowerCase();
        while (j < len && isAsciiWs(html.charCodeAt(j))) j += 1;
        let attrVal = '';
        if (j < len && html[j] === '=') {
          j += 1;
          while (j < len && isAsciiWs(html.charCodeAt(j))) j += 1;
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
            while (j < len && html[j] !== '>' && !isAsciiWs(html.charCodeAt(j))) j += 1;
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
        } else if (attrName === 'srcdoc') {
          attrs.hasSrcdoc = true;
        } else if (attrName === 'download') {
          attrs.hasDownload = true;
        } else if (attrName === 'type') {
          if (attrs.type === null) attrs.type = decodeHtmlEntities(attrVal);
        } else if (attrName === 'language') {
          if (attrs.language === null) attrs.language = decodeHtmlEntities(attrVal);
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
      if (!tagClosed) {
        textStart = pos;
        break;
      }
      if (tag === 'plaintext') {
        const curScope = scopeStack[scopeStack.length - 1]!;
        flushScopePending(curScope);
        curScope.tail = '';
        if (curScope.activeRelBox !== null) curScope.activeRelBox.tail = '';
        if (pos < len) feedText(html.slice(pos), false);
        pos = len;
        textStart = len;
        break;
      }
      if (rawTextTags.has(tag)) {
        const raw = findRawElementClose(html, pos, tag);
        const body = html.slice(pos, raw.contentEnd);
        pos = raw.nextPos;
        handleOpenTag(tag, attrs, selfClosing, body, raw.closed);
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

  for (let i = allBoxes.length - 1; i >= 0; i -= 1) {
    const box = allBoxes[i]!;
    if (box.hasAnyRelated && box.parent !== null) box.parent.hasAnyRelated = true;
  }
  for (let i = 0; i < allBoxes.length; i += 1) {
    const box = allBoxes[i]!;
    if (box.parent?.hasAnyRelated) box.hasAnyRelated = true;
  }
  for (let i = allCandidates.length - 1; i >= 0; i -= 1) {
    const c = allCandidates[i]!;
    if (c.poisoned && c.parent !== null) c.parent.poisoned = true;
  }
  for (let i = 0; i < allCandidates.length; i += 1) {
    const c = allCandidates[i]!;
    if (c.parent?.poisoned) c.poisoned = true;
  }

  return { scripts, attachments };
}

function isJsLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function findJsLineEnd(source: string, start: number): number {
  const len = source.length;
  for (let i = start; i < len; i += 1) {
    const c = source.charCodeAt(i);
    if (isJsLineTerminator(c)) {
      return c === 13 && i + 1 < len && source.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }
  return len;
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
      pos = findJsLineEnd(source, pos + 2);
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
      pos = findJsLineEnd(source, pos + 2);
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
const regexPunctAllowedBefore = new Set([
  '(', '[', '{', ',', ';', ':', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '^=', '|=', '&&=', '||=', '??=',
  '!', '&', '|', '&&', '||', '??', '?', '+', '-', '*', '/', '%', '^', '~', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '=>',
  '${', '}',
]);
const regexKeywordAllowedBefore = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'else', 'do', 'yield', 'await',
]);
const conditionParenKeywords = new Set(['if', 'while', 'for', 'with']);
const jsAssignOps = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '^=', '|=', '&&=', '||=', '??=',
]);
const jsUpdateOps = new Set(['++', '--']);
const globalReceivers = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames', 'this']);

function decodeJsUnicodeEscape(source: string, pos: number): { ch: string; nextPos: number } | null {
  const len = source.length;
  if (source[pos] !== '\\' || source[pos + 1] !== 'u') return null;
  if (source[pos + 2] === '{') {
    const limit = Math.min(len, pos + 10);
    let end = -1;
    for (let k = pos + 3; k < limit; k += 1) {
      if (source[k] === '}') {
        end = k;
        break;
      }
    }
    if (end === -1 || end === pos + 3) return null;
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
  const parenIsCondition: boolean[] = [];
  let lastCloseParenIsCondition = false;
  let braceDepth = 0;
  const pushToken = (kind: JsToken['kind'], value: string, escaped?: boolean) => {
    tokens.push(escaped ? { kind, value, escaped } : { kind, value });
  };
  const canStartRegex = () => {
    if (tokens.length === 0) return true;
    const prev = tokens[tokens.length - 1]!;
    if (prev.kind === 'punct') {
      if (prev.value === ')') return lastCloseParenIsCondition;
      return regexPunctAllowedBefore.has(prev.value);
    }
    if (prev.kind === 'ident' && regexKeywordAllowedBefore.has(prev.value)) {
      const prev2 = tokens.length >= 2 ? tokens[tokens.length - 2]! : null;
      return !(prev2 && prev2.kind === 'punct' && (prev2.value === '.' || prev2.value === '?.'));
    }
    return false;
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
      pos = findJsLineEnd(source, pos + 2);
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
        } else if (isJsLineTerminator(c.charCodeAt(0))) {
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
        else if (isJsLineTerminator(c.charCodeAt(0))) break;
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
    if (ch === '(') {
      const prev = tokens.length > 0 ? tokens[tokens.length - 1]! : null;
      const prev2 = tokens.length >= 2 ? tokens[tokens.length - 2]! : null;
      const isCond = Boolean(
        prev && prev.kind === 'ident' && conditionParenKeywords.has(prev.value)
        && !(prev2 && prev2.kind === 'punct' && (prev2.value === '.' || prev2.value === '?.')),
      );
      parenIsCondition.push(isCond);
      pushToken('punct', '(');
      pos += 1;
      continue;
    }
    if (ch === ')') {
      lastCloseParenIsCondition = parenIsCondition.pop() ?? false;
      pushToken('punct', ')');
      pos += 1;
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
      || two === '&&' || two === '||' || two === '??' || two === '?.' || two === '++' || two === '--') {
      pushToken('punct', two);
      pos += 2;
      continue;
    }
    pushToken('punct', ch);
    pos += 1;
  }
  return tokens;
}

/** 扫描脚本剩余代码令牌（跳过字符串与注释，严格 O(N)），拦截对 zwinfo / window.pdf / 裸 pdf 的动态或未识别修改。 */
function hasUnverifiedScriptAssignment(source: string): boolean {
  const tokens = tokenizeJs(source);
  const n = tokens.length;
  const matchCloseBracket = new Int32Array(n);
  const matchCloseBrace = new Int32Array(n);
  matchCloseBracket.fill(-1);
  matchCloseBrace.fill(-1);
  const openBrackets: number[] = [];
  const openBraces: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const tk = tokens[i]!;
    if (tk.kind !== 'punct') continue;
    if (tk.value === '[') openBrackets.push(i);
    else if (tk.value === ']' && openBrackets.length > 0) matchCloseBracket[openBrackets.pop()!] = i;
    else if (tk.value === '{') openBraces.push(i);
    else if (tk.value === '}' && openBraces.length > 0) matchCloseBrace[openBraces.pop()!] = i;
  }

  // O(N) 反向预处理：每个位置跳过任意连续 ')' 后的首个索引，以及连续成员链 .x / ?.x / [...] 结束索引。
  const nextNonParen = new Int32Array(n + 1);
  nextNonParen[n] = n;
  const memberChainEnd = new Int32Array(n + 1);
  memberChainEnd[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const tk = tokens[i]!;
    nextNonParen[i] = tk.kind === 'punct' && tk.value === ')' ? nextNonParen[i + 1]! : i;
    if (tk.kind === 'punct' && (tk.value === '.' || tk.value === '?.')) {
      const nextIdx = i + 1 < n && tokens[i + 1]!.kind === 'ident' ? i + 2 : i + 1;
      memberChainEnd[i] = memberChainEnd[nextIdx]!;
    } else if (tk.kind === 'punct' && tk.value === '[') {
      const close = matchCloseBracket[i]!;
      memberChainEnd[i] = close === -1 ? n : memberChainEnd[close + 1]!;
    } else {
      memberChainEnd[i] = i;
    }
  }

  const isDirectMutationAt = (idx: number): boolean => {
    const j = nextNonParen[idx]!;
    return j < n && tokens[j]!.kind === 'punct' && (jsAssignOps.has(tokens[j]!.value) || jsUpdateOps.has(tokens[j]!.value));
  };

  let destructTargetDepth = 0;
  const destructStack: Array<{ closeIdx: number; isTarget: boolean }> = [];
  const canPrecedeSubscript = (idx: number): boolean => {
    if (idx <= 0) return false;
    const prev = tokens[idx - 1]!;
    if (prev.kind === 'ident') return !regexKeywordAllowedBefore.has(prev.value);
    if (prev.kind === 'string') return true;
    return prev.value === ')' || prev.value === ']';
  };

  for (let i = 0; i < n; i += 1) {
    while (destructStack.length > 0 && destructStack[destructStack.length - 1]!.closeIdx === i) {
      if (destructStack.pop()!.isTarget) destructTargetDepth -= 1;
    }
    const tk = tokens[i]!;
    if (tk.kind === 'punct' && (tk.value === '{' || tk.value === '[')) {
      const closeIdx = tk.value === '{' ? matchCloseBrace[i]! : matchCloseBracket[i]!;
      if (closeIdx !== -1) {
        const afterClose = nextNonParen[closeIdx + 1]!;
        const followedByEq = afterClose < n && tokens[afterClose]!.kind === 'punct' && tokens[afterClose]!.value === '=';
        const isTarget = followedByEq && (tk.value === '{' || !canPrecedeSubscript(i));
        destructStack.push({ closeIdx, isTarget });
        if (isTarget) destructTargetDepth += 1;
      }
      continue;
    }
    if (tk.kind !== 'ident') continue;

    const prev = i > 0 ? tokens[i - 1]! : null;
    const isPropAfterDot = Boolean(prev && prev.kind === 'punct' && (prev.value === '.' || prev.value === '?.'));
    const hasPrefixMutation = Boolean(prev && ((prev.kind === 'ident' && prev.value === 'delete') || (prev.kind === 'punct' && jsUpdateOps.has(prev.value))));

    if (tk.value === 'zwinfo' || tk.value === 'pdf') {
      if (isPropAfterDot) continue;
      const next = i + 1 < n ? tokens[i + 1]! : null;
      const isObjPropKey = Boolean(next && next.kind === 'punct' && next.value === ':' && prev && prev.kind === 'punct' && (prev.value === '{' || prev.value === ','));
      if (isObjPropKey) continue;
      if (hasPrefixMutation || destructTargetDepth > 0) return true;
      if (isDirectMutationAt(memberChainEnd[i + 1]!)) return true;
      continue;
    }
    if (globalReceivers.has(tk.value)) {
      if (isPropAfterDot) continue;
      const next = i + 1 < n ? tokens[i + 1]! : null;
      if (!next || next.kind !== 'punct') continue;
      if (next.value === '.' || next.value === '?.') {
        const prop = i + 2 < n ? tokens[i + 2]! : null;
        if (prop && prop.kind === 'ident' && (prop.value === 'pdf' || prop.value === 'zwinfo')) {
          if (hasPrefixMutation || destructTargetDepth > 0) return true;
          if (isDirectMutationAt(memberChainEnd[i + 3]!)) return true;
        }
      } else if (next.value === '[') {
        const closeBracket = matchCloseBracket[i + 1]!;
        const firstCloseIdx = closeBracket === -1 ? n : closeBracket + 1;
        const insideLen = closeBracket === -1 ? 0 : closeBracket - (i + 2);
        const singleSafeLiteral = insideLen === 1
          && tokens[i + 2]!.kind === 'string'
          && !tokens[i + 2]!.escaped
          && tokens[i + 2]!.value !== 'pdf'
          && tokens[i + 2]!.value !== 'zwinfo';
        if (!singleSafeLiteral) {
          if (hasPrefixMutation || destructTargetDepth > 0) return true;
          if (isDirectMutationAt(memberChainEnd[firstCloseIdx]!)) return true;
        }
      }
      continue;
    }
    if ((tk.value === 'Object' || tk.value === 'Reflect') && i + 4 < n
      && tokens[i + 1]!.kind === 'punct' && tokens[i + 1]!.value === '.'
      && tokens[i + 2]!.kind === 'ident' && (tokens[i + 2]!.value === 'assign' || tokens[i + 2]!.value === 'defineProperty' || tokens[i + 2]!.value === 'defineProperties' || tokens[i + 2]!.value === 'set')
      && tokens[i + 3]!.kind === 'punct' && tokens[i + 3]!.value === '(') {
      const target = tokens[i + 4]!;
      if (target.kind === 'ident') {
        if (target.value === 'zwinfo') return true;
        if (globalReceivers.has(target.value)) {
          const afterTarget = i + 5 < n ? tokens[i + 5]! : null;
          if (!afterTarget || (afterTarget.kind === 'punct' && afterTarget.value === ',')) {
            return true;
          }
          if (afterTarget.kind === 'punct' && (afterTarget.value === '.' || afterTarget.value === '?.')) {
            const prop = i + 6 < n ? tokens[i + 6]! : null;
            if (prop && prop.kind === 'ident' && (prop.value === 'zwinfo' || prop.value === 'pdf')) return true;
          } else if (afterTarget.kind === 'punct' && afterTarget.value === '[') {
            const closeBracket = matchCloseBracket[i + 5]!;
            const insideLen = closeBracket === -1 ? 0 : closeBracket - (i + 6);
            const singleSafeLiteral = insideLen === 1
              && tokens[i + 6]!.kind === 'string'
              && !tokens[i + 6]!.escaped
              && tokens[i + 6]!.value !== 'pdf'
              && tokens[i + 6]!.value !== 'zwinfo';
            if (!singleSafeLiteral) return true;
          }
        }
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
      const pdf = /^window\.pdf\s*=\s*(["'])(https:\/\/pdf\.dfcfw\.com\/pdf\/H3_AP\d{8,20}_1\.pdf)\1[^\S\r\n\u2028\u2029]*(?:;|[\r\n\u2028\u2029]+|$)/u.exec(source);
      if (pdf) {
        collect(pdf[2], requiredInfoCode);
        source = stripLeadingJsTrivia(source.slice(pdf[0].length));
        continue;
      }
      const zwHead = /^(?:(?:var|let|const)\s+|window\.)?zwinfo\s*=\s*/u.exec(source);
      if (zwHead && source[zwHead[0].length] === '{') {
        const objEnd = extractBalancedObjectLiteral(source, zwHead[0].length);
        if (objEnd === -1) return invalid('研报详情元数据无法核对。');
        const tailMatch = /^[^\S\r\n\u2028\u2029]*(?:;|[\r\n\u2028\u2029]+|$)/u.exec(source.slice(objEnd));
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
      const code = /^(?:window\s*\.\s*)?zwinfo\s*\.\s*infoCode\s*=\s*(["'])(AP\d{8,20})\1[^\S\r\n\u2028\u2029]*(?:;|[\r\n\u2028\u2029]+|$)/u.exec(source);
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

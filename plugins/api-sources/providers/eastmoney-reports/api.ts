import { createHash } from 'node:crypto';
import vm from 'node:vm';
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
      if (key === null || key === '__proto__') return 'error';
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
        if (key === null || key === '__proto__') return null;
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
    if (key === '__proto__' || Object.hasOwn(values, key)) return null;
    values[key] = match[4] ?? match[5];
  }
  return values;
}

// WHATWG named character references：全部允许省略分号的历史名称，按 ASCII 大小写区分。
const legacyNoSemiEntities: Readonly<Record<string, string>> = Object.freeze({
  AElig: "\u00c6", AMP: "&", Aacute: "\u00c1", Acirc: "\u00c2", Agrave: "\u00c0", Aring: "\u00c5",
  Atilde: "\u00c3", Auml: "\u00c4", COPY: "\u00a9", Ccedil: "\u00c7", ETH: "\u00d0", Eacute: "\u00c9",
  Ecirc: "\u00ca", Egrave: "\u00c8", Euml: "\u00cb", GT: ">", Iacute: "\u00cd", Icirc: "\u00ce",
  Igrave: "\u00cc", Iuml: "\u00cf", LT: "<", Ntilde: "\u00d1", Oacute: "\u00d3", Ocirc: "\u00d4",
  Ograve: "\u00d2", Oslash: "\u00d8", Otilde: "\u00d5", Ouml: "\u00d6", QUOT: "\"", REG: "\u00ae",
  THORN: "\u00de", Uacute: "\u00da", Ucirc: "\u00db", Ugrave: "\u00d9", Uuml: "\u00dc", Yacute: "\u00dd",
  aacute: "\u00e1", acirc: "\u00e2", acute: "\u00b4", aelig: "\u00e6", agrave: "\u00e0", amp: "&",
  aring: "\u00e5", atilde: "\u00e3", auml: "\u00e4", brvbar: "\u00a6", ccedil: "\u00e7", cedil: "\u00b8",
  cent: "\u00a2", copy: "\u00a9", curren: "\u00a4", deg: "\u00b0", divide: "\u00f7", eacute: "\u00e9",
  ecirc: "\u00ea", egrave: "\u00e8", eth: "\u00f0", euml: "\u00eb", frac12: "\u00bd", frac14: "\u00bc",
  frac34: "\u00be", gt: ">", iacute: "\u00ed", icirc: "\u00ee", iexcl: "\u00a1", igrave: "\u00ec",
  iquest: "\u00bf", iuml: "\u00ef", laquo: "\u00ab", lt: "<", macr: "\u00af", micro: "\u00b5",
  middot: "\u00b7", nbsp: "\u00a0", not: "\u00ac", ntilde: "\u00f1", oacute: "\u00f3", ocirc: "\u00f4",
  ograve: "\u00f2", ordf: "\u00aa", ordm: "\u00ba", oslash: "\u00f8", otilde: "\u00f5", ouml: "\u00f6",
  para: "\u00b6", plusmn: "\u00b1", pound: "\u00a3", quot: "\"", raquo: "\u00bb", reg: "\u00ae",
  sect: "\u00a7", shy: "\u00ad", sup1: "\u00b9", sup2: "\u00b2", sup3: "\u00b3", szlig: "\u00df",
  thorn: "\u00fe", times: "\u00d7", uacute: "\u00fa", ucirc: "\u00fb", ugrave: "\u00f9", uml: "\u00a8",
  uuml: "\u00fc", yacute: "\u00fd", yen: "\u00a5", yuml: "\u00ff",
});

const namedHtmlEntities: Readonly<Record<string, string>> = Object.freeze({
  ...legacyNoSemiEntities,
  // 这些带分号的长名称优先于其历史短前缀（例如 notin; 优先于 not）。
  centerdot: "\u00b7", copysr: "\u2117", divideontimes: "\u22c7", gtcc: "\u2aa7", gtcir: "\u2a7a",
  gtdot: "\u22d7", gtlPar: "\u2995", gtquest: "\u2a7c", gtrapprox: "\u2a86", gtrarr: "\u2978",
  gtrdot: "\u22d7", gtreqless: "\u22db", gtreqqless: "\u2a8c", gtrless: "\u2277", gtrsim: "\u2273",
  ltcc: "\u2aa6", ltcir: "\u2a79", ltdot: "\u22d6", lthree: "\u22cb", ltimes: "\u22c9", ltlarr: "\u2976",
  ltquest: "\u2a7b", ltrPar: "\u2996", ltri: "\u25c3", ltrie: "\u22b4", ltrif: "\u25c2", notin: "\u2209",
  notinE: "\u22f9\u0338", notindot: "\u22f5\u0338", notinva: "\u2209", notinvb: "\u22f7", notinvc: "\u22f6",
  notni: "\u220c", notniva: "\u220c", notnivb: "\u22fe", notnivc: "\u22fd", parallel: "\u2225",
  timesb: "\u22a0", timesbar: "\u2a31", timesd: "\u2a30",
  Tab: '\t',
  NewLine: '\n',
  apos: "'",
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
  hyphen: '\u2010',
  dash: '\u2010',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  hellip: '\u2026',
  trade: '\u2122',
  TRADE: '\u2122',
});

function decodeHtmlEntities(input: string, isAttributeValue = false): string {
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
      // 最长历史前缀优先。属性中其后若仍是 ASCII 字母、数字或等号，则按原文保留。
      let end = Math.min(j, amp + 7);
      while (end > amp + 1 && !Object.hasOwn(legacyNoSemiEntities, input.slice(amp + 1, end))) end -= 1;
      if (end > amp + 1 && !(isAttributeValue && /[A-Za-z0-9=]/u.test(input[end] ?? ''))) {
        out += legacyNoSemiEntities[input.slice(amp + 1, end)];
        i = end;
        continue;
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
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'keygen', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const rawTextTags = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
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
  'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'summary', 'listing', 'plaintext', 'xmp', 'table', 'ul',
]);
const htmlScopeBarriers = new Set(['applet', 'caption', 'html', 'marquee', 'object', 'table', 'td', 'template', 'th']);
const listContainers = new Set(['ol', 'ul', 'menu']);
const tableSectionTags = new Set(['thead', 'tbody', 'tfoot']);
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

type ScriptKind = 'classic' | 'module' | 'inert';

function scriptKind(attrs: TagAttrs): ScriptKind {
  const { type, language } = attrs;
  if (type?.toLowerCase() === 'module') return 'module';
  const mime = type === null ? (language ? 'text/' + language : 'text/javascript')
    : type === '' ? 'text/javascript' : trimAsciiWs(type);
  if (attrs.hasNomodule || !jsMimeEssences.has(mime.toLowerCase())) return 'inert';
  if (attrs.for !== null && attrs.event !== null) {
    const event = trimAsciiWs(attrs.event).toLowerCase();
    if (trimAsciiWs(attrs.for).toLowerCase() !== 'window' || (event !== 'onload' && event !== 'onload()')) return 'inert';
  }
  return 'classic';
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
  hasNomodule: boolean;
  type: string | null;
  language: string | null;
  for: string | null;
  event: string | null;
  encoding: string | null;
  hasFontAttribute: boolean;
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
  statements: StaticStatement[];
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

/** 起始与结束标签共用属性状态。before attribute name 中的首个等号是属性名字符。 */
function scanTagClose(html: string, pos: number, attribute?: (name: string, value: string) => void) {
  while (pos < html.length) {
    const ch = html[pos]!;
    if (isAsciiWs(html.charCodeAt(pos))) { pos += 1; continue; }
    if (ch === '>') return { nextPos: pos + 1, closed: true, selfClosing: false };
    if (ch === '/') {
      if (html[pos + 1] === '>') return { nextPos: pos + 2, closed: true, selfClosing: true };
      pos += 1;
      continue;
    }
    const start = pos++;
    while (pos < html.length && html[pos] !== '=' && !isTagDelimiter(html, pos)) pos += 1;
    const end = pos;
    while (isAsciiWs(html.charCodeAt(pos))) pos += 1;
    let value = '';
    if (html[pos] === '=') {
      pos += 1;
      while (isAsciiWs(html.charCodeAt(pos))) pos += 1;
      const quote = html[pos];
      if (quote === '"' || quote === "'") {
        const endQuote = html.indexOf(quote, pos + 1);
        if (endQuote < 0) break;
        if (attribute) value = html.slice(pos + 1, endQuote);
        pos = endQuote + 1;
      } else {
        const startValue = pos;
        while (pos < html.length && html[pos] !== '>' && !isAsciiWs(html.charCodeAt(pos))) pos += 1;
        if (attribute) value = html.slice(startValue, pos);
      }
    }
    attribute?.(html.slice(start, end).toLowerCase(), value);
  }
  return { nextPos: html.length, closed: false, selfClosing: false };
}

/** 单趟 O(N) 定位 rawtext/script 结束标签，严格遵守 HTML5 script-data-escaped 状态、引号扫描与 EOF 闭合要求。 */
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
          const closeRes = scanTagClose(html, after);
          return closeRes.closed
            ? { contentEnd: pos, nextPos: closeRes.nextPos, closed: true }
            : { contentEnd: len, nextPos: len, closed: false };
        }
      }
    }
    pos += 1;
  }
  return { contentEnd: len, nextPos: len, closed: false };
}

const emptyTagAttrs: TagAttrs = {
  id: null,
  className: null,
  role: null,
  ariaLabel: null,
  href: null,
  src: null,
  hasSrc: false,
  hasSrcdoc: false,
  hasDownload: false,
  hasNomodule: false,
  type: null,
  language: null,
  for: null,
  event: null,
  encoding: null,
  hasFontAttribute: false,
  encodeUrl: null,
  hasEncodeUrl: false,
  hasForeignEncodeUrl: false,
  infoCode: null,
  hasInfoCode: false,
  hasInfoCodeConflict: false,
};

function readDetailAttribute(attrs: TagAttrs, attrName: string, attrVal: string, expectedEncodeUrl: string) {
  if (attrName === 'id') {
    if (attrs.id === null) attrs.id = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'class') {
    if (attrs.className === null) attrs.className = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'role') {
    if (attrs.role === null) attrs.role = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'aria-label') {
    if (attrs.ariaLabel === null) attrs.ariaLabel = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'href') {
    if (attrs.href === null) attrs.href = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'src') {
    attrs.hasSrc = true;
    if (attrs.src === null) attrs.src = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'srcdoc') {
    attrs.hasSrcdoc = true;
  } else if (attrName === 'download') {
    attrs.hasDownload = true;
  } else if (attrName === 'nomodule') {
    attrs.hasNomodule = true;
  } else if (attrName === 'type') {
    if (attrs.type === null) attrs.type = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'language') {
    if (attrs.language === null) attrs.language = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'for' || attrName === 'event' || attrName === 'encoding') {
    if (attrs[attrName] === null) attrs[attrName] = decodeHtmlEntities(attrVal, true);
  } else if (attrName === 'color' || attrName === 'face' || attrName === 'size') {
    attrs.hasFontAttribute = true;
  } else if (attrName === 'data-encode-url') {
    const decoded = decodeHtmlEntities(attrVal, true);
    if (!attrs.hasEncodeUrl) {
      attrs.hasEncodeUrl = true;
      attrs.encodeUrl = decoded;
    } else if (attrs.encodeUrl !== decoded) {
      attrs.hasForeignEncodeUrl = true;
    }
    if (decoded !== expectedEncodeUrl) attrs.hasForeignEncodeUrl = true;
  } else if (attrName === 'data-info-code') {
    const decoded = decodeHtmlEntities(attrVal, true);
    if (!attrs.hasInfoCode) {
      attrs.hasInfoCode = true;
      attrs.infoCode = decoded;
    } else if (attrs.infoCode !== decoded) {
      attrs.hasInfoCodeConflict = true;
    }
  }
}

type Namespace = 'html' | 'svg' | 'math';
type ElementToken = {
  tag: string; attrs: TagAttrs; leaf: boolean; rawBody?: string; rawClosed?: boolean;
  selectors?: { related: boolean; landmark: boolean; heading: boolean; download: boolean };
};
type DetailEvent = ElementToken | string | null;
type EventStream = (DetailEvent | EventStream)[];

const inHeadTags = new Set(['html', 'head', 'base', 'basefont', 'bgsound', 'link', 'meta', 'noscript', 'noframes', 'script', 'style', 'template', 'title']);
const tableContainers = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);
const tableParts = new Set(['caption', 'col', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const tableCells = new Set(['td', 'th']);
const definitionItems = new Set(['dt', 'dd']);
const rubyParts = new Set(['rb', 'rt', 'rtc', 'rp']);
const impliedEndTags = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', ...rubyParts]);
const scopedBlockEnds = new Set([
  'address', 'article', 'aside', 'blockquote', 'button', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'listing', 'main', 'nav', 'pre', 'search', 'section', 'summary', ...listContainers,
]);
// HTML 的 li / dt / dd 回扫在最近的 special 元素停止，address、div、p 是规范列出的例外。
const specialHtmlTags = new Set([
  ...scopedBlockEnds, ...htmlScopeBarriers, ...tableParts, ...voidHtmlTags, ...rawTextTags,
  'body', 'dd', 'dt', 'form', 'frameset', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'li', 'plaintext', 'select',
]);
const listItemBoundaries = new Set([...specialHtmlTags].filter(tag => tag !== 'address' && tag !== 'div' && tag !== 'p'));
const formattingTags = new Set(['b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
const mathTextPoints = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const svgHtmlPoints = new Set(['foreignobject', 'desc', 'title']);
const foreignBreakoutTags = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);

// HTML 初始插入模式中切换到 quirks mode 的历史 PUBLIC 标识前缀。
const quirksPublicPrefixes = [
  "+//silmaril//dtd html pro v0r11 19970101//", "-//advasoft ltd//dtd html 3.0 aswedit + extensions//",
  "-//as//dtd html 3.0 aswedit + extensions//", "-//ietf//dtd html 2.0 level 1//", "-//ietf//dtd html 2.0 level 2//",
  "-//ietf//dtd html 2.0 strict level 1//", "-//ietf//dtd html 2.0 strict level 2//",
  "-//ietf//dtd html 2.0 strict//", "-//ietf//dtd html 2.0//", "-//ietf//dtd html 2.1e//", "-//ietf//dtd html 3.0//",
  "-//ietf//dtd html 3.2 final//", "-//ietf//dtd html 3.2//", "-//ietf//dtd html 3//", "-//ietf//dtd html level 0//",
  "-//ietf//dtd html level 1//", "-//ietf//dtd html level 2//", "-//ietf//dtd html level 3//",
  "-//ietf//dtd html strict level 0//", "-//ietf//dtd html strict level 1//", "-//ietf//dtd html strict level 2//",
  "-//ietf//dtd html strict level 3//", "-//ietf//dtd html strict//", "-//ietf//dtd html//",
  "-//metrius//dtd metrius presentational//", "-//microsoft//dtd internet explorer 2.0 html strict//",
  "-//microsoft//dtd internet explorer 2.0 html//", "-//microsoft//dtd internet explorer 2.0 tables//",
  "-//microsoft//dtd internet explorer 3.0 html strict//", "-//microsoft//dtd internet explorer 3.0 html//",
  "-//microsoft//dtd internet explorer 3.0 tables//", "-//netscape comm. corp.//dtd html//",
  "-//netscape comm. corp.//dtd strict html//", "-//o'reilly and associates//dtd html 2.0//",
  "-//o'reilly and associates//dtd html extended 1.0//",
  "-//o'reilly and associates//dtd html extended relaxed 1.0//",
  "-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
  "-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//", "-//spyglass//dtd html 2.0 extended//",
  "-//sq//dtd html 2.0 hotmetal + extensions//", "-//sun microsystems corp.//dtd hotjava html//",
  "-//sun microsystems corp.//dtd hotjava strict html//", "-//w3c//dtd html 3 1995-03-24//",
  "-//w3c//dtd html 3.2 draft//", "-//w3c//dtd html 3.2 final//", "-//w3c//dtd html 3.2//",
  "-//w3c//dtd html 3.2s draft//", "-//w3c//dtd html 4.0 frameset//", "-//w3c//dtd html 4.0 transitional//",
  "-//w3c//dtd html experimental 19960712//", "-//w3c//dtd html experimental 970421//", "-//w3c//dtd w3 html//",
  "-//w3o//dtd w3 html 3.0//", "-//webtechs//dtd mozilla html 2.0//", "-//webtechs//dtd mozilla html//",
];

function usesQuirksMode(doctype: string): boolean {
  const value = trimAsciiWs(doctype).toLowerCase();
  const name = /^[^\t\n\f\r ]+/u.exec(value)?.[0];
  if (name !== 'html') return true;
  let rest = trimAsciiWs(value.slice(name.length));
  if (!rest) return false;
  const readId = (): string | null => {
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") return null;
    const end = rest.indexOf(quote, 1);
    if (end < 0) return null;
    const id = rest.slice(1, end);
    rest = trimAsciiWs(rest.slice(end + 1));
    return id;
  };
  let publicId = '';
  if (rest.startsWith('public')) {
    rest = trimAsciiWs(rest.slice(6));
    const id = readId();
    if (id === null) return true;
    publicId = id;
  } else if (rest.startsWith('system')) {
    rest = trimAsciiWs(rest.slice(6));
    if (!rest) return true;
  } else {
    return true;
  }
  const hasSystemId = rest !== '';
  if (hasSystemId) {
    const systemId = readId();
    if (systemId === null || systemId === 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd') return true;
  }
  return !hasSystemId && (publicId.startsWith('-//w3c//dtd html 4.01 frameset//') || publicId.startsWith('-//w3c//dtd html 4.01 transitional//'))
    || quirksPublicPrefixes.some(prefix => publicId.startsWith(prefix))
    || ['html', '-//w3o//dtd w3 html strict 3.0//en//', '-/w3c/dtd html 4.0 transitional/en'].includes(publicId);
}

/** 保存树顺序的开、闭、文本事件。每张表前的独立事件流使 foster parenting 无须移动已有节点。 */
function parseDetailHtml(html: string, expectedEncodeUrl: string) {
  const events: EventStream = [];
  let initial = true, quirks = true;
  type Frame = {
    tag: string; ns: Namespace; integration: 'html' | 'math-text' | null;
    lastHtml: number; lastIntegration: number; scopeBarrier: number; listItemBoundary: number; previous: number; next: number;
    stream: EventStream | null; startStream: EventStream | null; position: number; token: ElementToken; beforeTable?: EventStream;
  };
  // 相邻帧间预留一个位置。锚点修复可在块后插入克隆，后代帧的位置与作用域索引保持有效。
  const stack: (Frame | undefined)[] = [];
  const indices = new Map<string, number>();
  const last = (tag: string) => indices.get(tag) ?? -1;
  const top = () => stack.at(-1);
  const lastOf = (tags: Set<string>) => {
    let index = -1;
    for (const tag of tags) index = Math.max(index, last(tag));
    return index;
  };
  const unlinkFrame = (index: number) => {
    const frame = stack[index]!;
    if (frame.previous >= 0) stack[frame.previous]!.next = frame.next;
    if (frame.next >= 0) stack[frame.next]!.previous = frame.previous;
    else {
      const key = frame.ns === 'html' ? frame.tag : ':' + frame.tag;
      if (frame.previous === -1) indices.delete(key);
      else indices.set(key, frame.previous);
    }
    stack[index] = undefined;
  };
  const trimStack = () => {
    while (stack.length && !top()) stack.pop();
  };
  const popTo = (length: number) => {
    while (stack.length > length) {
      const frame = top();
      if (frame) {
        frame.stream?.push(null);
        unlinkFrame(stack.length - 1);
      }
      stack.pop();
    }
    trimStack();
  };
  const closeInScope = (index: number, barrier: number) => {
    if (index > barrier) popTo(index);
  };
  const exitForeign = () => {
    const current = top();
    if (current) popTo(Math.max(current.lastHtml, current.lastIntegration) + 1);
  };
  const inheritedForeignNamespace = (tag: string, attrs: TagAttrs): Namespace | null => {
    const current = top();
    if (current && current.ns !== 'html'
      && current.integration !== 'html'
      && !(current.integration === 'math-text' && tag !== 'mglyph' && tag !== 'malignmark')
      && !(current.ns === 'math' && current.tag === 'annotation-xml' && tag === 'svg')) {
      if (!foreignBreakoutTags.has(tag) && !(tag === 'font' && attrs.hasFontAttribute)) return current.ns;
      exitForeign();
    }
    return null;
  };
  const streamFor = (foster: boolean): EventStream | null => {
    const current = top();
    if (!current) return events;
    if (foster && current.ns === 'html' && tableContainers.has(current.tag) && last('table') > last('template')) {
      return stack[last('table')]!.beforeTable!;
    }
    return current.stream;
  };
  const pushFrame = (tag: string, ns: Namespace, token: ElementToken, stream: EventStream | null, position: number,
    beforeTable?: EventStream, startStream = stream, index = stack.length + 1, parent = top()) => {
    const isHtml = ns === 'html', attrs = token.attrs;
    const key = isHtml ? tag : ':' + tag;
    const integration = ns === 'svg' && svgHtmlPoints.has(tag) ? 'html'
      : ns === 'math' && mathTextPoints.has(tag) ? 'math-text'
      : ns === 'math' && tag === 'annotation-xml' && /^(?:text\/html|application\/xhtml\+xml)$/iu.test(attrs.encoding ?? '') ? 'html' : null;
    const foreignBarrier = !!integration || ns === 'math' && tag === 'annotation-xml';
    const previous = last(key);
    if (previous >= 0) stack[previous]!.next = index;
    stack[index] = { tag, ns, integration, stream, startStream, position, token, beforeTable, previous, next: -1,
      lastHtml: isHtml ? index : parent?.lastHtml ?? -1,
      lastIntegration: integration ? index : parent?.lastIntegration ?? -1,
      scopeBarrier: foreignBarrier || isHtml && htmlScopeBarriers.has(tag) ? index : parent?.scopeBarrier ?? -1,
      listItemBoundary: foreignBarrier || isHtml && listItemBoundaries.has(tag) ? index : parent?.listItemBoundary ?? -1 };
    indices.set(key, index);
  };

  const insert = (tag: string, ns: Namespace, attrs: TagAttrs, leaf: boolean, rawBody?: string, rawClosed?: boolean) => {
    const isHtml = ns === 'html';
    const inertTemplate = last('template') >= 0 || (isHtml && tag === 'template');
    const foster = !(isHtml && (tableParts.has(tag) || tag === 'script' || tag === 'style' || tag === 'template'
      || tag === 'form' || (tag === 'input' && attrs.type?.toLowerCase() === 'hidden')));
    const stream = inertTemplate ? null : streamFor(foster);
    let beforeTable: EventStream | undefined;
    if (isHtml && tag === 'table' && stream) {
      beforeTable = [];
      stream.push(beforeTable);
    }
    const token = { tag: isHtml ? tag : '#foreign', attrs, leaf, rawBody, rawClosed };
    const position = stream?.length ?? -1;
    stream?.push(token);
    if (!leaf) pushFrame(tag, ns, token, stream, position, beforeTable);
  };

  // 新锚点结束旧锚点。跨过块元素时在原开标签处拆分旧锚点，使块及仍活动的格式元素保留真实归属。
  const closeAnchorForStart = (anchor: number) => {
    const original = stack[anchor]!;
    if (!original.stream || anchor === stack.length - 1) { popTo(anchor); return; }
    const stream = original.stream;
    unlinkFrame(anchor);
    let inline: number[] = [];
    let blocks = 0;
    const splitAnchor = (output: EventStream, beforeBlock: boolean) => {
      for (let i = 0; i <= inline.length; i += 1) output.push(null);
      for (const [i, index] of inline.entries()) {
        const frame = stack[index]!;
        // 在块前，adoption agency 的内循环只重建最近三个节点中的活动格式元素。
        if (formattingTags.has(frame.tag) && (!beforeBlock || i >= inline.length - 3)) {
          frame.startStream = output;
          frame.position = output.push(frame.token) - 1;
        } else unlinkFrame(index);
      }
      inline = [];
    };
    for (let index = anchor + 1; index < stack.length; index += 1) {
      const frame = stack[index];
      if (!frame) continue;
      if (!specialHtmlTags.has(frame.tag)) { inline.push(index); continue; }
      const split: EventStream = [];
      splitAnchor(split, true);
      frame.startStream![frame.position] = split;
      frame.startStream = split;
      frame.position = split.push(frame.token) - 1;
      const clone = split.push(original.token) - 1;
      if (++blocks === 8) {
        // HTML 外循环在第八次返回。保留块内仍打开的锚点，后续 token 从此处继续修复。
        pushFrame('a', 'html', original.token, stream, clone, undefined, split, index + 1, frame);
        return;
      }
    }
    splitAnchor(stream, false);
    trimStack();
  };

  const prepareHtmlStart = (tag: string): boolean => {
    const template = last('template');
    const scope = Math.max(template, top()?.lastIntegration ?? -1);
    if (!inHeadTags.has(tag)) closeInScope(last('head'), scope);
    const inScope = top()?.scopeBarrier ?? -1;
    if (tag === 'li' || definitionItems.has(tag)) {
      const boundary = top()?.listItemBoundary ?? -1;
      const previous = stack[boundary];
      if (previous?.ns === 'html' && (tag === 'li' ? previous.tag === 'li' : definitionItems.has(previous.tag))) popTo(boundary);
    } else if (tag === 'a' && last('a') > inScope) {
      closeAnchorForStart(last('a'));
    } else if (tag === 'option' || tag === 'optgroup' || tag === 'hr' || rubyParts.has(tag)) {
      const ruby = rubyParts.has(tag);
      if ((ruby ? last('ruby') : last('select')) > inScope) {
        const except = tag === 'option' ? 'optgroup' : tag === 'rt' || tag === 'rp' ? 'rtc' : null;
        while (top()?.ns === 'html' && impliedEndTags.has(top()!.tag) && top()!.tag !== except) popTo(stack.length - 1);
      } else if (!ruby && tag !== 'hr' && top()?.tag === 'option') popTo(stack.length - 1);
    }
    if (pAutoCloseTags.has(tag) && !(tag === 'table' && quirks)) closeInScope(last('p'), Math.max(top()?.scopeBarrier ?? -1, last('button')));
    const table = last('table');
    if (table <= scope) return !tableParts.has(tag) || template >= 0;
    if (tag !== 'col' && tag !== 'template') closeInScope(last('colgroup'), table);
    if (tag === 'table' && Math.max(last('caption'), lastOf(tableCells)) < table) popTo(table);
    if (!tableParts.has(tag)) return true;
    if (tag === 'td' || tag === 'th' || tag === 'tr') {
      const row = last('tr');
      if (tag !== 'tr' && row > table) {
        popTo(row + 1);
      } else {
        const section = lastOf(tableSectionTags);
        popTo(Math.max(table, section) + 1);
        if (section < table) insert('tbody', 'html', emptyTagAttrs, false);
        if (tag !== 'tr') insert('tr', 'html', emptyTagAttrs, false);
      }
    } else if (tag === 'col' && last('colgroup') > table) {
      popTo(last('colgroup') + 1);
    } else {
      popTo(table + 1);
      if (tag === 'col') insert('colgroup', 'html', emptyTagAttrs, false);
    }
    return true;
  };

  const handleCloseTag = (tag: string) => {
    const current = top();
    if (current && current.ns !== 'html') {
      if (tag === 'p' || tag === 'br') {
        exitForeign();
      } else {
        const foreign = last(':' + tag);
        if (foreign > current.lastHtml) { popTo(foreign); return; }
      }
    }
    const target = last(tag);
    if (target < 0) return;
    if (tag === 'template') { popTo(target); return; }
    let barrier = last('template');
    if (tableParts.has(tag)) barrier = Math.max(barrier, last('table'));
    if (scopedBlockEnds.has(tag) || definitionItems.has(tag) || tag === 'p' || tag === 'a' || tag === 'li' || tag === 'select') {
      barrier = Math.max(barrier, top()?.scopeBarrier ?? -1);
    }
    if (tag === 'li') barrier = Math.max(barrier, lastOf(listContainers));
    if (tag === 'p') barrier = Math.max(barrier, last('button'));
    closeInScope(target, barrier);
  };

  const writeText = (source: string, decode = true) => {
    if (!source || last('template') >= 0) return;
    const current = top();
    if (current && current.ns !== 'html' && !current.integration) return;
    const value = decode ? decodeHtmlEntities(source) : source;
    const nonWhitespace = /[^\t\n\f\r ]/u.test(value);
    if (nonWhitespace) initial = false;
    if (nonWhitespace && current?.tag === 'head') popTo(stack.length - 1);
    if (nonWhitespace && current?.tag === 'colgroup') popTo(stack.length - 1);
    streamFor(nonWhitespace)?.push(value);
  };
  let pos = 0;
  let textStart = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    const next = html[lt + 1] ?? '';
    if (next !== '!' && next !== '?' && next !== '/' && !/[A-Za-z]/u.test(next)) {
      pos = lt + 1;
      continue;
    }
    writeText(html.slice(textStart, lt));
    if (next === '!' || next === '?') {
      if (html.startsWith('<!--', lt)) {
        if (html.startsWith('<!-->', lt)) pos = lt + 5;
        else if (html.startsWith('<!--->', lt)) pos = lt + 6;
        else pos = findHtmlCommentEnd(html, lt + 4);
      } else if (top() && top()!.ns !== 'html' && html.startsWith('<![CDATA[', lt)) {
        const end = html.indexOf(']]>', lt + 9);
        writeText(html.slice(lt + 9, end < 0 ? html.length : end), false);
        pos = end < 0 ? html.length : end + 3;
      } else {
        const gt = html.indexOf('>', lt + 2);
        if (initial && html.slice(lt, lt + 9).toLowerCase() === '<!doctype') {
          quirks = gt < 0 || usesQuirksMode(html.slice(lt + 9, gt));
          initial = false;
        }
        pos = gt < 0 ? html.length : gt + 1;
      }
    } else {
      initial = false;
      const closing = next === '/';
      const start = lt + (closing ? 2 : 1);
      if (closing && !/[A-Za-z]/u.test(html[start] ?? '')) {
        const gt = html.indexOf('>', start);
        pos = textStart = gt < 0 ? html.length : gt + 1;
        continue;
      }
      let end = start + 1;
      while (!isTagDelimiter(html, end)) end += 1;
      const tag = html.slice(start, end).toLowerCase();
      const attrs = closing || html[end] === '>' ? emptyTagAttrs : { ...emptyTagAttrs };
      const close = scanTagClose(html, end, closing ? undefined : (name, value) => readDetailAttribute(attrs, name, value, expectedEncodeUrl));
      pos = close.nextPos;
      if (close.closed && closing) handleCloseTag(tag);
      else if (close.closed) {
        const foreign = inheritedForeignNamespace(tag, attrs);
        if (!foreign && !prepareHtmlStart(tag)) { textStart = pos; continue; }
        const ns = foreign ?? (tag === 'svg' || tag === 'math' ? tag : 'html');
        if (ns === 'html' && tag === 'plaintext') {
          insert(tag, ns, attrs, false);
          writeText(html.slice(pos), false);
          pos = html.length;
        } else if (ns === 'html' && rawTextTags.has(tag)) {
          const raw = findRawElementClose(html, pos, tag);
          insert(tag, ns, attrs, true, html.slice(pos, raw.contentEnd), raw.closed);
          pos = raw.nextPos;
        } else {
          const tableForm = tag === 'form' && last('table') > Math.max(last('template'), last('caption'), lastOf(tableCells));
          insert(tag, ns, attrs, ns === 'html' ? voidHtmlTags.has(tag) || tableForm : close.selfClosing);
        }
      }
    }
    textStart = pos;
  }
  writeText(html.slice(textStart));
  popTo(0);
  return events;
}

function* eventsInTreeOrder(events: EventStream): Generator<DetailEvent> {
  const streams = [events.values()];
  while (streams.length) {
    const next = streams.at(-1)!.next();
    if (next.done) streams.pop();
    else if (Array.isArray(next.value)) streams.push(next.value.values());
    else yield next.value;
  }
}

function documentBase(events: EventStream, documentUrl: string): URL {
  for (const event of eventsInTreeOrder(events)) {
    if (event && typeof event !== 'string' && event.tag === 'base' && event.attrs.href !== null) {
      try {
        const base = new URL(event.attrs.href, documentUrl);
        if (base.protocol === 'https:' || base.protocol === 'http:') return base;
      } catch { /* 首个带 href 的基准元素解析失败，回退到文档 URL。 */ }
      break;
    }
  }
  return new URL(documentUrl);
}

/** 在还原的 HTML 树顺序上判断归属；同一作用域的相关标记须由明确的下载框与元数据证明跨越。 */
function analyzeEastmoneySections(html: string, baseUrl: string, expectedEncodeUrl: string) {
  const scripts: ScriptEntry[] = [];
  const attachments: AttachmentEntry[] = [];
  const allBoxes: BoxRecord[] = [];
  const allCandidates: CandidateAnchor[] = [];
  const events = parseDetailHtml(html, expectedEncodeUrl);
  const resolveHref = pdfHrefResolver(documentBase(events, baseUrl));
  let sawZwinfoObject = false;
  const registerZwinfoObject = () => {
    if (sawZwinfoObject) return unverifiedScript();
    sawZwinfoObject = true;
  };

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
    isZwinfoId: boolean;
    popScope: boolean;
    popAttr: boolean;
    resetParentTail: boolean;
    closeCandidate: boolean;
    closeBox: BoxRecord | null;
    closeRelBox: RelBoxRecord | null;
  };
  const openStack: OpenElemFrame[] = [];

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

  const feedText = (text: string): void => {
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

  const handleOpenTag = (token: ElementToken): void => {
    const { tag, attrs, leaf, rawBody, rawClosed } = token;
    if (nonContentSubtreeTags.has(tag) || tag === 'base') return;
    const cur = scopeStack[scopeStack.length - 1]!;
    const attr = attrStack[attrStack.length - 1]!;
    let statements: StaticStatement[] = [];
    if (tag === 'script') {
      const kind = scriptKind(attrs);
      if (kind === 'inert' || attrs.hasSrc || !rawClosed || !rawBody?.trim()) return;
      statements = readStaticStatements(rawBody, kind, registerZwinfoObject);
    }

    // 收养算法的克隆共享原始 token，长 class/role 属性只扫描一次。
    const selectors = token.selectors ??= {
      related: isRelatedElement(tag, attrs), landmark: isLandmarkRelatedElement(tag, attrs),
      heading: isHeadingElement(tag, attrs), download: hasClassToken(attrs.className, 'report-download'),
    };
    const isRelSelector = selectors.related, isDownloadBox = selectors.download;
    const isZwinfoId = attrs.id === 'zwinfo';
    const isRootBoundary = isZwinfoId || rootBoundaryTags.has(tag);
    const isFormControl = formControlTags.has(tag);
    const isInlineNestedRel = isRelSelector && !selectors.landmark && !blockBoundaryTags.has(tag) && cur.activeRelBox !== null;
    const isIsolated = isRelSelector || isDownloadBox || isRootBoundary || isolatedAuxiliaryTags.has(tag);
    const isBlockBoundary = (!isInlineNestedRel && isIsolated) || blockBoundaryTags.has(tag) || tag === '#foreign';

    if (isRelSelector) {
      if (candidateAnchorStack.length > 0) {
        candidateAnchorStack[candidateAnchorStack.length - 1]!.poisoned = true;
      }
      if (cur.nearestBox !== null) {
        cur.nearestBox.hasAnyRelated = true;
      }
      if (selectors.heading && !cur.inRelatedSelector) {
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
      if (statements.length && !attr.inFormControl) {
        scripts.push({
          statements,
          inRelatedSelector: isRelSelector || cur.inRelatedSelector,
          outerRelated: cur.outerRelated || (!cur.isDownloadBox && cur.relatedSeen),
          hasForeignEncodeUrl: nextForeignEncode,
          expectedInfoCode: nextInfoCode,
          hasInfoCodeConflict: nextInfoCodeConflict,
          boxRecord: cur.nearestBox,
          enclosingCandidate: candidateAnchorStack.at(-1) ?? null,
        });
      }
      return;
    }

    if (tag === 'iframe') {
      flushScopePending(cur);
      cur.tail = '';
      if (cur.activeRelBox !== null) cur.activeRelBox.tail = '';
      const isDirectZwinfoChild = openStack.length > 0 && openStack[openStack.length - 1]!.isZwinfoId;
      if (attrs.hasSrcdoc || attrs.src === null) return;
      if (cur.activeRelBox && !cur.activeRelBox.hasDescendantPdfOrScript && resolveHref(attrs.src)) cur.activeRelBox.hasDescendantPdfOrScript = true;
      if (isDirectZwinfoChild && !attr.inFormControl) {
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
        scanKeywordText(probe, decodeHtmlEntities(rawBody, false), () => {
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

    if (tag === 'a' && attrs.href !== null && cur.activeRelBox && !cur.activeRelBox.hasDescendantPdfOrScript && resolveHref(attrs.href)) {
      cur.activeRelBox.hasDescendantPdfOrScript = true;
    }
    const isCandidateAnchor = tag === 'a' && attrs.href !== null && !attr.inFormControl
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
    if (isRelSelector && !selectors.landmark && !isInlineNestedRel) {
      createdRelBox = {
        sawRelatedKeyword: false,
        hasDescendantPdfOrScript: false,
        tail: '',
        pendingRelated: false,
        parent: cur.activeRelBox,
      };
    }

    let popScope = false;
    if (isIsolated && !isInlineNestedRel) {
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

    if (isCandidateAnchor) {
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

    const frame = { isZwinfoId, popScope, popAttr: pushAttr, resetParentTail: !popScope && isBlockBoundary,
      closeCandidate: isCandidateAnchor, closeBox: boxRecord, closeRelBox: createdRelBox };
    if (leaf) leaveElement(frame);
    else openStack.push(frame);
  };

  for (const event of eventsInTreeOrder(events)) {
    if (event === null) leaveElement(openStack.pop()!);
    else if (typeof event === 'string') feedText(event);
    else handleOpenTag(event);
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

  return { scripts, attachments, resolveHref };
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

function stripLeadingJsTrivia(source: string, atLineStart: boolean): string | null {
  let pos = 0;
  while (pos < source.length) {
    if (/\s/u.test(source[pos]!)) {
      if (isJsLineTerminator(source.charCodeAt(pos))) atLineStart = true;
      pos += 1;
    } else if (source.startsWith('/*', pos)) {
      const end = source.indexOf('*/', pos + 2);
      if (end < 0) return null;
      if (!atLineStart) atLineStart = /[\r\n\u2028\u2029]/u.test(source.slice(pos + 2, end));
      pos = end + 2;
    } else if (source.startsWith('//', pos) || source.startsWith('<!--', pos) || (atLineStart && source.startsWith('-->', pos))) {
      pos = findJsLineEnd(source, pos + 2);
      atLineStart = true;
    } else {
      break;
    }
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

/** 非元数据脚本只识别可能触及声明的源码。注释、解构目标和间接全局访问均保守处理。 */
function hasUnverifiedScriptReference(source: string): boolean {
  if (source.includes('zwinfo') || source.includes('\\u')) return true;
  const mentionsPdf = /\bpdf\b/u.test(source);
  if (/\b(?:window|self|globalThis|top|parent|frames|this)\b/u.test(source) && (mentionsPdf || /[\\[]/u.test(source))) return true;
  if (!mentionsPdf) return false;
  if (/\+\+|--|\b(?:delete|Object|Reflect)\b/u.test(source)) return true;
  // 同时覆盖声明、解构和 ASI；分号、括号和所有赋值运算符都可以跟在目标名称之后。
  return /\bpdf\b[^\S\r\n\u2028\u2029]*[\r\n\u2028\u2029]/u.test(source)
    || /\bpdf\b\s*(?:[+\-*%&|^<>=?,{}\[\]();]|\/[=*/]|(?:of|in|extends)\b|$)/u.test(source);
}

function consumeStaticStatementEnd(rest: string): string | null {
  const tail = stripLeadingJsTrivia(rest, false);
  if (!tail) return tail;
  return tail[0] === ';' ? stripLeadingJsTrivia(tail.slice(1), false) : null;
}

const unverifiedScript = (): never => invalid('详情脚本包含无法静态核对的研报或附件声明。');

type StaticStatement =
  | { kind: 'object'; info: Record<string, JsonValue> }
  | { kind: 'infoCode' | 'pdf'; value: string };

const staticObjectHead = /^(?:(var|let|const)\s+|window\.)?zwinfo\s*=\s*(?=\{)/u;
const staticPdf = /^window\.pdf\s*=\s*(["'])(https:\/\/pdf\.dfcfw\.com\/pdf\/H3_AP\d{8,20}_1\.pdf)\1/u;
const staticCode = /^(window\s*\.\s*)?zwinfo\s*\.\s*infoCode\s*=\s*(["'])(AP\d{8,20})\2/u;

/** V8 编译完整经典脚本。之后只读取获准的静态语句和数据，从不运行来源代码。 */
function readStaticStatements(content: string, kind: 'classic' | 'module', registerObject: () => void): StaticStatement[] {
  const statements: StaticStatement[] = [];
  const first = kind === 'classic' ? stripLeadingJsTrivia(content, true) : content;
  if (first === null) return unverifiedScript();
  if (kind === 'module' || !(staticPdf.test(first) || staticObjectHead.test(first) || staticCode.test(first))) {
    if (first && hasUnverifiedScriptReference(content)) return unverifiedScript();
    return statements;
  }
  try {
    new vm.Script(content);
  } catch {
    if (staticObjectHead.test(first)) return invalid('研报详情元数据无法核对。');
    return unverifiedScript();
  }
  let source = first;
  let wroteProperty = false;
  let lexicalObject = false;
  while (source) {
    let end: number;
    const head = staticObjectHead.exec(source);
    if (head) {
      registerObject();
      if (wroteProperty) return unverifiedScript();
      lexicalObject = head[1] === 'let' || head[1] === 'const';
      end = extractBalancedObjectLiteral(source, head[0].length);
      const info = end < 0 ? null : detailMetadata(source.slice(head[0].length, end));
      if (!info) return invalid('研报详情元数据无法核对。');
      statements.push({ kind: 'object', info });
    } else {
      const pdf = staticPdf.exec(source);
      if (pdf) {
        statements.push({ kind: 'pdf', value: pdf[2]! });
        end = pdf[0].length;
      } else {
        const code = staticCode.exec(source);
        if (!code || (lexicalObject && code[1])) return unverifiedScript();
        wroteProperty = true;
        statements.push({ kind: 'infoCode', value: code[3]! });
        end = code[0].length;
      }
    }
    const next = consumeStaticStatementEnd(source.slice(end));
    if (next === null) return unverifiedScript();
    source = next;
  }
  return statements;
}

type PdfLocation = { pdfUrl: string; infoCode: string };

function pdfLocation(url: URL): PdfLocation | null {
  if (url.origin !== 'https://pdf.dfcfw.com' || url.username || url.password) return null;
  const match = /^\/pdf\/H3_(AP\d{8,20})_1\.pdf$/u.exec(url.pathname);
  if (!match) return null;
  url.hash = '';
  return { pdfUrl: url.href, infoCode: match[1]! };
}

/** 引用只针对固定主机、两段路径的 PDF。每次交给 URL 解析器的基准长度受本次输入长度约束。 */
function pdfHrefResolver(base: URL) {
  const protocol = base.protocol;
  const basePath = base.pathname;
  const basePdf = pdfLocation(base);
  const allowedOrigin = base.origin === 'https://pdf.dfcfw.com' && !base.username && !base.password;
  const origin = allowedOrigin ? base.origin : protocol + '//invalid.invalid';
  const directoryDepth = basePath.split('/').length - 2;
  const firstDirectory = basePath.startsWith('/pdf/') ? 'pdf/' : 'x/';
  const queryBase = origin + (basePdf ? basePath : '/x');
  const seenRawHrefs = new Map<string, PdfLocation | null>();
  return (raw: string): PdfLocation | null => {
    const known = seenRawHrefs.get(raw);
    if (known !== undefined) return known;
    // URL Standard 预处理先于片段和同协议判断。所有纯片段共享同一个空引用。
    let start = 0, end = raw.length;
    while (start < end && raw.charCodeAt(start) <= 32) start += 1;
    while (end > start && raw.charCodeAt(end - 1) <= 32) end -= 1;
    let ref = raw[start] === '#' ? '' : raw.slice(start, end).replace(/[\t\n\r]/gu, '');
    const path = ref.slice(0, protocol.length).toLowerCase() === protocol ? ref.slice(protocol.length) : ref;
    if (!path || path.startsWith('#')) ref = '';
    const cached = seenRawHrefs.get(ref);
    if (cached !== undefined) {
      if (ref && ref !== raw) seenRawHrefs.set(raw, cached);
      return cached;
    }
    let result = basePdf;
    if (ref) {
      // 路径引用每退一级至少消耗一个输入字符。超过该界限的祖先无法到达；
      // 只有首段 pdf 能成为合法附件的继承目录。查询引用保留基准文件名。
      const depth = Math.min(directoryDepth, ref.length + 2);
      const relativeBase = path.startsWith('?') ? queryBase
        : origin + '/' + (depth > 0 ? firstDirectory + 'x/'.repeat(depth - 1) : '') + 'x';
      try { result = pdfLocation(new URL(ref, relativeBase)); } catch { result = null; }
    }
    seenRawHrefs.set(ref, result);
    if (ref && ref !== raw) seenRawHrefs.set(raw, result);
    return result;
  };
}

/** 仅返回同源固定格式 PDF 定位。 */
export function decodeEastmoneyReportDetail(request: EastmoneyReportDetailRequest, rawBytes: Uint8Array) {
  const bound = buildEastmoneyReportDetailRequest({ ...request });
  const sections = analyzeEastmoneySections(decodeUtf8(rawBytes), bound.url.href, request.encodeUrl);
  let declaredCode: string | null = null;
  const selected: { attachment?: PdfLocation } = {};
  const codeConflict = (): never => invalid('研报详情元数据与附件声明指向不同的 infoCode。');
  const collect = (raw: string, expectedInfoCode: string | null) => {
    const pdf = sections.resolveHref(raw);
    if (!pdf) return;
    if (expectedInfoCode && pdf.infoCode !== expectedInfoCode) return invalid('研报详情标识与附件标识不符。');
    if (declaredCode && declaredCode !== pdf.infoCode) return codeConflict();
    if (selected.attachment) {
      if (selected.attachment.infoCode !== pdf.infoCode) return codeConflict();
      if (selected.attachment.pdfUrl !== pdf.pdfUrl) return invalid('研报详情存在多个不同附件定位，须明确选择。');
    } else {
      selected.attachment = pdf;
    }
  };
  const processScript = (script: ScriptEntry) => {
    if (script.hasInfoCodeConflict) return invalid('研报详情标识与附件标识不符。');
    const required = script.expectedInfoCode;
    for (const statement of script.statements) {
      if (statement.kind === 'pdf') {
        collect(statement.value, required);
        continue;
      }
      const info = statement.kind === 'object' ? statement.info : null;
      if (info?.encodeUrl !== undefined && info.encodeUrl !== request.encodeUrl) return invalid('研报详情标识与请求不符。');
      const code = statement.kind === 'infoCode' ? statement.value : infoCodeOf(info?.infoCode);
      if (code && required && code !== required) return invalid('研报详情标识与附件标识不符。');
      if (code) {
        if (declaredCode && declaredCode !== code || selected.attachment && selected.attachment.infoCode !== code) return codeConflict();
        declaredCode = code;
      }
      if (info) {
        for (const key of ['pdfUrl', 'pdf_url', 'attachUrl', 'attach_url']) {
          if (typeof info[key] === 'string') collect(info[key], code ?? required);
        }
      }
    }
  };
  const isAttestedBox = (box: BoxRecord | null, owner: string | null, expectedInfoCode: string | null): boolean => Boolean(
    box && !box.hasAnyRelated && !box.hasForeignEncodeUrl && !box.hasInfoCodeConflict
    && box.owner === request.encodeUrl && owner === request.encodeUrl
    && box.infoCode && declaredCode === box.infoCode && expectedInfoCode === box.infoCode,
  );

  const deferredBoxScripts: ScriptEntry[] = [];
  for (const script of sections.scripts) {
    if (script.hasForeignEncodeUrl || script.inRelatedSelector || script.enclosingCandidate?.poisoned || script.boxRecord?.hasAnyRelated) continue;
    if (!script.outerRelated) processScript(script);
    else if (script.boxRecord) deferredBoxScripts.push(script);
  }
  for (const script of deferredBoxScripts) {
    if (isAttestedBox(script.boxRecord, script.boxRecord?.owner ?? null, script.expectedInfoCode)) processScript(script);
  }
  for (const status of sections.attachments) {
    if (status.hasForeignEncodeUrl || status.inRelatedSelector || status.candidateRecord?.poisoned || status.boxRecord?.hasAnyRelated) continue;
    if (status.owner !== null && status.owner !== request.encodeUrl) continue;
    if (status.outerRelated && !isAttestedBox(status.boxRecord, status.owner, status.expectedInfoCode)) continue;
    if (status.hasInfoCodeConflict && sections.resolveHref(status.url)) return invalid('研报详情标识与附件标识不符。');
    collect(status.url, status.expectedInfoCode);
  }
  if (!selected.attachment) return invalid('研报详情没有可验证的 PDF 附件定位。');
  return { decoderVersion: 'eastmoney-report-detail/1' as const, providerId: 'eastmoney' as const, request: bound.request,
    detailUrl: bound.url.href, ...selected.attachment, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
    attachmentFetched: false as const, historyAvailability: 'not_established' as const };
}

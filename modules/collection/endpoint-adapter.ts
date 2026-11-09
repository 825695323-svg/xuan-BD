import iconv from 'iconv-lite';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { MaterialCell, MaterialColumn, MaterialLocation, MaterialScalar, MaterialTable } from './materials/contracts.js';

/**
 * 声明式端点适配：一个通用解析算子 + 每个端点一份版本化配置。
 * 配置只描述载体、信封、容器、字段位置与逐字段单位依据；证券与日期是调用输入，不进入配置匹配键。
 * 本模块不使用 eval、动态函数或任意表达式；全部取值为受控路径、位置与十进制字面量。
 */
export const ENDPOINT_ADAPTER_CONTRACT = 'bd.endpoint-adapter/1';
export const ENDPOINT_ADAPTER_LIMITS = Object.freeze({ maxBytes: 67_108_864, maxFields: 256, maxRecords: 100_000,
  maxDepth: 24, maxNodes: 4_000_000, maxCellCharacters: 1_048_576, maxPosition: 1023, maxDelimiterLength: 4 });

export type AdapterCarrierKind = 'json' | 'jsonp' | 'js-variable-assignment' | 'json-embedded-delimited';
export type AdapterCharset = 'utf-8' | 'gbk' | 'gb18030';
export type AdapterFieldType = 'text' | 'decimal' | 'integer';
export type AdapterTimeFormat = 'iso-date' | 'yyyymmdd' | 'iso-local-minute' | 'iso-datetime' | 'epoch-second'
  | 'epoch-millisecond' | 'hhmmss';

export type AdapterFieldSource = { kind: 'key'; key: string } | { kind: 'position'; index: number };
export interface AdapterUnitConversion { source: string; target: string; factor: string; basis: string }
export interface EndpointAdapterField {
  name: string;
  source: AdapterFieldSource;
  type: AdapterFieldType;
  /** 声明原单位到目标单位的换算；factor 为精确十进制字面量，basis 为来源依据。缺依据不得换算。 */
  unit?: AdapterUnitConversion;
  /** 只声明原报时间写法，不隐式转换时区或业务日期。 */
  timeFormat?: AdapterTimeFormat;
}
export interface EndpointAdapterConfig {
  contract: typeof ENDPOINT_ADAPTER_CONTRACT;
  adapterId: string;
  version: string;
  match: {
    /** 固定端点身份（不含查询串、证券代码或日期）。 */
    endpoint: string;
    /** 载体/协议版本标签，影响语义的 fields/fields2 一并声明。 */
    protocol: string;
    frequency: 'day' | 'minute' | 'event' | 'other';
    adjustment: 'none' | 'qfq' | 'hfq' | 'unknown';
    /** 影响语义的请求字段，按实际请求顺序声明；顺序本身是语义的一部分。 */
    fields?: string[];
    fields2?: string[];
    /** 必要的市场规则标识（如 cn-a-share）；缺省表示未声明，不是"适用于所有市场"。 */
    market?: string;
  };
  carrier: {
    kind: AdapterCarrierKind;
    charset: AdapterCharset;
    /** JSONP 函数名前缀；调用时只接受此前缀下的单一调用。 */
    callbackPrefix?: string;
    /** JS 变量赋值名前缀。 */
    variablePrefix?: string;
    /** 内嵌分隔记录的单记录字段分隔符。 */
    delimiter?: string;
    /** 单一字符串承载多条记录时的记录分隔符；缺省为换行。 */
    recordSeparator?: string;
  };
  response: {
    success: { path: string; equals: string } | null;
    container: { path: string; kind: 'array' | 'object-index-map' | 'delimited-array' };
    /** 上游分页声明：本页记录数与游标必须同时闭合，否则不声明完整系列。 */
    pagination?: { totalPath: string; cursorPath: string };
    /** 明确归为元信息（非业务数据）的顶层键；未列出的并列结构一律阻断。 */
    ignore?: string[];
  };
  fields: EndpointAdapterField[];
  evidence: { sourceId: string; provider: string; coverage: string; basis: string };
}

/** 计划与请求只携带引用；完整配置由服务在规范化时按已采用版本冻结。 */
export interface AdapterBindingRef { adapterId: string; version: string; configDigest: string }
/**
 * 本材料实际取得回执的受信摘要（来自既有下载回执的 url/sha256/请求参数）。
 * 没有它时结构解析可以继续，但依赖匹配的算法/发布用途不能由已采用配置自动取得。
 */
export interface AdapterSourceContext {
  kind: 'receipt' | 'synthetic';
  url: string;
  materialSha256: string;
  observedAt: string;
  protocol?: string;
  fields?: string[];
  fields2?: string[];
  frequency?: EndpointAdapterConfig['match']['frequency'];
  adjustment?: EndpointAdapterConfig['match']['adjustment'];
  market?: string;
  basis: string;
}
export interface AdapterMatchEvidence {
  /** 真实取得回执已核：地址、参数与材料字节/文件引用一致。 */
  verified: boolean;
  /** 声明维度内部一致（含合成样本）；不等于来源真实性已核。 */
  consistent: boolean;
  kind: 'receipt' | 'synthetic' | 'unverified';
  url: string | null; observedAt: string | null; gaps: string[];
}
export interface FrozenAdapterBinding extends AdapterBindingRef {
  config: EndpointAdapterConfig;
  /** 与材料实际取得回执的匹配结论；未提供上下文时为未核。 */
  match?: AdapterMatchEvidence;
}

export interface AdapterCell {
  /** 载体原值：单位换算前，永不因换算被覆盖。 */
  original: MaterialScalar;
  /** 本算子按声明换算后的值；未声明换算时与 original 相同。 */
  value: MaterialScalar;
  sourceType: MaterialCell['sourceType']; quote: string; location: MaterialLocation;
}
export interface AdapterParseResult {
  sourceSha256: string;
  decoded: { charset: AdapterCharset; byteLength: number; characterCount: number; losslessRoundTrip: true; byteOrderMark: boolean };
  carrier: { kind: AdapterCarrierKind; scope: 'source-text' | 'decoded-string'; callback?: string; variable?: string };
  success: { path: string; expected: string; actual: string } | null;
  container: { path: string; kind: EndpointAdapterConfig['response']['container']['kind']; records: number };
  columns: string[];
  rows: AdapterCell[][];
  conversions: { field: string; source: string; target: string; factor: string; basis: string; applied: number }[];
  /** true=本页即完整系列；false=已证实未完成（此时解析直接失败）；null=配置未声明上游分页，完整性未知。 */
  seriesComplete: boolean | null;
  gaps: string[];
  totalRows: number;
}

const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const adapterIdPattern = /^[a-z0-9][a-z0-9._-]{2,99}$/u;
const versionPattern = /^[0-9]{1,4}$/u;
const pathPattern = /^(?:\$|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\.[0-9]+)*)$/u;
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const timeFormats: readonly AdapterTimeFormat[] = ['iso-date', 'yyyymmdd', 'iso-local-minute', 'iso-datetime',
  'epoch-second', 'epoch-millisecond', 'hhmmss'];
const charsets: readonly AdapterCharset[] = ['utf-8', 'gbk', 'gb18030'];

export function adapterConfigDigest(config: EndpointAdapterConfig): string { return digest(config); }

/** 适配字段类型到结构步骤类型的固定映射；字段重命名不改变该映射。 */
export function adapterColumnType(field: EndpointAdapterField): 'string' | 'safe_integer' | 'decimal_string' {
  if (field.type === 'text') return 'string';
  // 源值为整数但换算系数含小数时，有效值已是十进制，不能继续按安全整数表示。
  if (field.type === 'integer' && field.unit && !/^-?(?:0|[1-9][0-9]*)$/u.test(field.unit.factor)) return 'decimal_string';
  return field.type === 'integer' ? 'safe_integer' : 'decimal_string';
}
/**
 * 计划声明类型与适配配置类型的兼容关系：整数列可按精确十进制字符串表示（值已在解析时核为整数），
 * 其余必须完全一致；不允许把文本或布尔降级成数值。
 */
export function adapterTypeCompatible(declared: string, configured: string): boolean {
  return declared === configured || configured === 'safe_integer' && declared === 'decimal_string';
}

/** 严格读取配置：未知键、缺依据的单位换算、越界位置都直接拒绝，不做默认补齐。 */
export function readEndpointAdapterConfig(value: unknown): EndpointAdapterConfig {
  const record = exactRecord(value, ['contract', 'adapterId', 'version', 'match', 'carrier', 'response', 'fields', 'evidence'], 'ADAPTER_CONFIG');
  if (record.contract !== ENDPOINT_ADAPTER_CONTRACT) fail('ADAPTER_CONFIG', '适配配置契约版本不符。');
  const adapterId = record.adapterId, version = record.version;
  if (typeof adapterId !== 'string' || !adapterIdPattern.test(adapterId)) fail('ADAPTER_CONFIG', '适配编号须为小写稳定端点身份。');
  if (typeof version !== 'string' || !versionPattern.test(version)) fail('ADAPTER_CONFIG', '适配版本须为明确数字版本。');
  const match = exactRecord(record.match, ['endpoint', 'protocol', 'frequency', 'adjustment', 'fields', 'fields2', 'market'], 'ADAPTER_CONFIG');
  const endpoint = match.endpoint, protocol = match.protocol;
  if (typeof endpoint !== 'string' || !endpoint.trim() || endpoint.length > 512 || /[\s?#\u0000-\u001f]/u.test(endpoint))
    fail('ADAPTER_CONFIG', '端点身份须为不含查询、证券或日期的稳定地址。');
  if (typeof protocol !== 'string' || !protocol.trim() || protocol.length > 128 || /[\u0000-\u001f]/u.test(protocol))
    fail('ADAPTER_CONFIG', '协议版本标签须为明确文本。');
  if (!['day', 'minute', 'event', 'other'].includes(String(match.frequency))) fail('ADAPTER_CONFIG', '频率须为 day、minute、event 或 other。');
  if (!['none', 'qfq', 'hfq', 'unknown'].includes(String(match.adjustment))) fail('ADAPTER_CONFIG', '复权口径须为 none、qfq、hfq 或 unknown。');
  const readFieldList = (value: unknown, label: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.length > 64
      || value.some(field => typeof field !== 'string' || !field.trim() || field.length > 128 || /[\u0000-\u001f]/u.test(field))
      || new Set(value).size !== value.length) fail('ADAPTER_CONFIG', `${label}须为不重复的明确文本。`);
    // 顺序本身影响字段语义（例如 fields2 的列序），不排序、不压平。
    return [...value as string[]];
  };
  const matchFields = readFieldList(match.fields, '影响语义的字段清单'), matchFields2 = readFieldList(match.fields2, 'fields2 字段清单');
  let market: string | undefined;
  if (match.market !== undefined) {
    if (typeof match.market !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(match.market)) fail('ADAPTER_CONFIG', '市场规则标识须为小写稳定编码。');
    market = match.market;
  }
  const carrier = exactRecord(record.carrier, ['kind', 'charset', 'callbackPrefix', 'variablePrefix', 'delimiter', 'recordSeparator'], 'ADAPTER_CONFIG');
  const kind = String(carrier.kind) as AdapterCarrierKind;
  if (!['json', 'jsonp', 'js-variable-assignment', 'json-embedded-delimited'].includes(kind)) fail('ADAPTER_CONFIG', '载体类型不在受支持范围。');
  if (!charsets.includes(carrier.charset as AdapterCharset)) fail('ADAPTER_CONFIG', '字符集须为 utf-8、gbk 或 gb18030；不接受猜测。');
  const readToken = (name: 'callbackPrefix' | 'variablePrefix', max: number) => {
    const token = carrier[name];
    if (token === undefined) return undefined;
    if (typeof token !== 'string' || !token || token.length > max || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(token)) fail('ADAPTER_CONFIG', `${name} 须为明确标识符前缀。`);
    return token;
  };
  const callbackPrefix = readToken('callbackPrefix', 128), variablePrefix = readToken('variablePrefix', 128);
  if (kind === 'jsonp' && !callbackPrefix) fail('ADAPTER_CONFIG', 'JSONP 载体须声明受信函数名前缀。');
  if (kind === 'js-variable-assignment' && !variablePrefix) fail('ADAPTER_CONFIG', 'JS 变量赋值载体须声明受信变量名前缀。');
  let delimiter: string | undefined, recordSeparator: string | undefined;
  if (kind === 'json-embedded-delimited') {
    if (typeof carrier.delimiter !== 'string' || !carrier.delimiter || carrier.delimiter.length > ENDPOINT_ADAPTER_LIMITS.maxDelimiterLength
      || /[\r\n\u0000]/u.test(carrier.delimiter)) fail('ADAPTER_CONFIG', '内嵌记录须声明 1 至 4 字符的单记录分隔符。');
    delimiter = carrier.delimiter;
  }
  if (carrier.delimiter !== undefined && delimiter === undefined) {
    if (typeof carrier.delimiter !== 'string' || !carrier.delimiter || carrier.delimiter.length > ENDPOINT_ADAPTER_LIMITS.maxDelimiterLength
      || /[\r\n\u0000]/u.test(carrier.delimiter)) fail('ADAPTER_CONFIG', '单记录分隔符须为 1 至 4 字符且不含换行。');
    delimiter = carrier.delimiter;
  }
  if (carrier.recordSeparator !== undefined) {
    if (typeof carrier.recordSeparator !== 'string' || !carrier.recordSeparator || carrier.recordSeparator.length > 2
      || /[\u0000]/u.test(carrier.recordSeparator)) fail('ADAPTER_CONFIG', '记录分隔符须为明确 1 至 2 字符。');
    recordSeparator = carrier.recordSeparator;
  }
  const response = exactRecord(record.response, ['success', 'container', 'pagination', 'ignore'], 'ADAPTER_CONFIG');
  let success: EndpointAdapterConfig['response']['success'] = null;
  if (response.success !== null) {
    const entry = exactRecord(response.success, ['path', 'equals'], 'ADAPTER_CONFIG');
    if (typeof entry.path !== 'string' || !pathPattern.test(entry.path)) fail('ADAPTER_CONFIG', '成功判定路径须为受控对象路径。');
    if (typeof entry.equals !== 'string' || !entry.equals || entry.equals.length > 128) fail('ADAPTER_CONFIG', '成功判定须为明确文本期望值。');
    success = { path: entry.path, equals: entry.equals };
  }
  let pagination: EndpointAdapterConfig['response']['pagination'];
  if (response.pagination !== undefined) {
    const entry = exactRecord(response.pagination, ['totalPath', 'cursorPath'], 'ADAPTER_CONFIG');
    for (const key of ['totalPath', 'cursorPath'] as const) if (typeof entry[key] !== 'string' || !pathPattern.test(entry[key]))
      fail('ADAPTER_CONFIG', '分页声明须使用受控对象路径。');
    if (entry.totalPath === entry.cursorPath) fail('ADAPTER_CONFIG', '分页总数与游标不能使用同一路径。');
    pagination = { totalPath: entry.totalPath, cursorPath: entry.cursorPath };
  }
  let ignore: string[] | undefined;
  if (response.ignore !== undefined) {
    if (!Array.isArray(response.ignore) || !response.ignore.length || response.ignore.length > 16
      || response.ignore.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))
      || new Set(response.ignore).size !== response.ignore.length) fail('ADAPTER_CONFIG', '元信息键须为不重复的明确顶层键名。');
    ignore = [...response.ignore as string[]];
  }
  const container = exactRecord(response.container, ['path', 'kind'], 'ADAPTER_CONFIG');
  if (typeof container.path !== 'string' || !pathPattern.test(container.path)) fail('ADAPTER_CONFIG', '记录容器路径须为受控对象路径。');
  const containerKind = String(container.kind) as EndpointAdapterConfig['response']['container']['kind'];
  if (!['array', 'object-index-map', 'delimited-array'].includes(containerKind)) fail('ADAPTER_CONFIG', '记录容器类型不在受支持范围。');
  if (kind === 'json-embedded-delimited' && containerKind !== 'delimited-array')
    fail('ADAPTER_CONFIG', 'JSON 内嵌分隔记录载体须声明分隔记录容器。');
  if (containerKind === 'delimited-array' && !delimiter)
    fail('ADAPTER_CONFIG', '分隔记录容器须声明单记录字段分隔符。');
  if (containerKind !== 'delimited-array' && (delimiter !== undefined || recordSeparator !== undefined))
    fail('ADAPTER_CONFIG', '字段/记录分隔符只适用于分隔记录容器。');
  const fields = readAdapterFields(record.fields);
  const evidence = exactRecord(record.evidence, ['sourceId', 'provider', 'coverage', 'basis'], 'ADAPTER_CONFIG');
  for (const key of ['sourceId', 'provider', 'coverage', 'basis'] as const) {
    const text = evidence[key];
    if (typeof text !== 'string' || text.trim().length < 2 || text.length > 2000 || /[\u0000-\u001f]/u.test(text))
      fail('ADAPTER_CONFIG', `适配依据 ${key} 须为明确来源/覆盖说明。`);
  }
  return { contract: ENDPOINT_ADAPTER_CONTRACT, adapterId, version,
    match: { endpoint, protocol, frequency: match.frequency as EndpointAdapterConfig['match']['frequency'],
      adjustment: match.adjustment as EndpointAdapterConfig['match']['adjustment'], ...(matchFields ? { fields: matchFields } : {}),
      ...(matchFields2 ? { fields2: matchFields2 } : {}), ...(market ? { market } : {}) },
    carrier: { kind, charset: carrier.charset as AdapterCharset, ...(callbackPrefix ? { callbackPrefix } : {}),
      ...(variablePrefix ? { variablePrefix } : {}), ...(delimiter ? { delimiter } : {}), ...(recordSeparator ? { recordSeparator } : {}) },
    response: { success, container: { path: container.path, kind: containerKind }, ...(pagination ? { pagination } : {}),
      ...(ignore ? { ignore } : {}) }, fields,
    evidence: { sourceId: String(evidence.sourceId), provider: String(evidence.provider),
      coverage: String(evidence.coverage), basis: String(evidence.basis) } };
}

function readAdapterFields(value: unknown): EndpointAdapterField[] {
  if (!Array.isArray(value) || !value.length || value.length > ENDPOINT_ADAPTER_LIMITS.maxFields)
    throw new TaskError('ADAPTER_CONFIG', '字段须为 1 至 256 项明确声明。');
  const list = value as unknown[];
  const names = new Set<string>(), positions = new Set<number>();
  return list.map((item: unknown) => {
    const field = exactRecord(item, ['name', 'source', 'type', 'unit', 'timeFormat'], 'ADAPTER_CONFIG');
    const name = field.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\u0000-\u001f]/u.test(name) || names.has(name))
      fail('ADAPTER_CONFIG', '字段名须非空、唯一且不含控制字符。');
    names.add(name);
    const source = exactRecord(field.source, ['kind', 'key', 'index'], 'ADAPTER_CONFIG');
    let parsedSource: AdapterFieldSource;
    if (source.kind === 'key') {
      if (typeof source.key !== 'string' || !source.key || source.key.length > 256 || /[\u0000-\u001f]/u.test(source.key)) fail('ADAPTER_CONFIG', '字段键名无效。');
      parsedSource = { kind: 'key', key: source.key };
    } else if (source.kind === 'position') {
      if (!Number.isSafeInteger(source.index) || Number(source.index) < 0 || Number(source.index) > ENDPOINT_ADAPTER_LIMITS.maxPosition
        || positions.has(Number(source.index))) fail('ADAPTER_CONFIG', '字段位置须为 0 至 1023 的不重复整数。');
      positions.add(Number(source.index));
      parsedSource = { kind: 'position', index: Number(source.index) };
    } else return fail('ADAPTER_CONFIG', '字段来源须为 key 或 position。');
    if (!['text', 'decimal', 'integer'].includes(String(field.type))) fail('ADAPTER_CONFIG', '字段类型须为 text、decimal 或 integer。');
    let unit: AdapterUnitConversion | undefined;
    if (field.unit !== undefined) {
      const entry = exactRecord(field.unit, ['source', 'target', 'factor', 'basis'], 'ADAPTER_CONFIG');
      if (typeof entry.factor !== 'string' || !decimalPattern.test(entry.factor) || /^0(?:\.0+)?$/u.test(entry.factor))
        fail('ADAPTER_CONFIG', '单位换算系数须为明确非零十进制字面量；不接受表达式。');
      for (const key of ['source', 'target'] as const) if (typeof entry[key] !== 'string' || !entry[key].trim() || entry[key].length > 64) fail('ADAPTER_CONFIG', '原/目标单位须为明确文本。');
      if (typeof entry.basis !== 'string' || entry.basis.trim().length < 8 || entry.basis.length > 1000) fail('ADAPTER_CONFIG', '单位换算须有具体来源依据，不能凭习惯换算。');
      if (field.type === 'text') fail('ADAPTER_CONFIG', '文本字段不能声明数值单位换算。');
      unit = { source: entry.source as string, target: entry.target as string, factor: entry.factor, basis: entry.basis };
    }
    let timeFormat: AdapterTimeFormat | undefined;
    if (field.timeFormat !== undefined) {
      if (!timeFormats.includes(field.timeFormat as AdapterTimeFormat)) fail('ADAPTER_CONFIG', '时间写法不在已登记范围。');
      timeFormat = field.timeFormat as AdapterTimeFormat;
    }
    return { name, source: parsedSource, type: field.type as AdapterFieldType, ...(unit ? { unit } : {}), ...(timeFormat ? { timeFormat } : {}) };
  });
}

const sourceContextKeys = ['kind', 'url', 'materialSha256', 'observedAt', 'protocol', 'fields', 'fields2', 'frequency',
  'adjustment', 'market', 'basis'] as const;
export function readAdapterSourceContext(value: unknown): AdapterSourceContext {
  const record = exactRecord(value, [...sourceContextKeys], 'ADAPTER_CONTEXT');
  if (record.kind !== 'receipt' && record.kind !== 'synthetic') fail('ADAPTER_CONTEXT', '来源上下文须明确为 receipt 或 synthetic。');
  // 正文自报 receipt 不是受信取得：真实回执只能由宿主按已有来源任务/回执解析。
  if (record.kind === 'receipt') fail('ADAPTER_CONTEXT_UNTRUSTED', '真实取得回执不能由请求正文自报；须由宿主按已有来源任务解析。');
  if (typeof record.url !== 'string' || !/^https?:\/\//u.test(record.url) || record.url.length > 2048 || /[\u0000-\u001f]/u.test(record.url))
    fail('ADAPTER_CONTEXT', '来源上下文须提供明确请求地址。');
  if (typeof record.materialSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.materialSha256))
    fail('ADAPTER_CONTEXT', '来源上下文须绑定材料摘要。');
  if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)))
    fail('ADAPTER_CONTEXT', '来源上下文须提供明确取得时间。');
  if (typeof record.basis !== 'string' || record.basis.trim().length < 8 || record.basis.length > 1000)
    fail('ADAPTER_CONTEXT', '来源上下文须说明依据；合成样本必须如实标注。');
  const fields = record.fields === undefined ? undefined : readAdapterFieldOrder(record.fields, 'fields');
  const fields2 = record.fields2 === undefined ? undefined : readAdapterFieldOrder(record.fields2, 'fields2');
  if (record.protocol !== undefined && (typeof record.protocol !== 'string' || !record.protocol || record.protocol.length > 128))
    fail('ADAPTER_CONTEXT', '协议标签无效。');
  if (record.frequency !== undefined && !['day', 'minute', 'event', 'other'].includes(String(record.frequency)))
    fail('ADAPTER_CONTEXT', '频率声明无效。');
  if (record.adjustment !== undefined && !['none', 'qfq', 'hfq', 'unknown'].includes(String(record.adjustment)))
    fail('ADAPTER_CONTEXT', '复权声明无效。');
  if (record.market !== undefined && (typeof record.market !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(record.market)))
    fail('ADAPTER_CONTEXT', '市场声明无效。');
  return { kind: record.kind, url: record.url, materialSha256: record.materialSha256, observedAt: new Date(Date.parse(record.observedAt)).toISOString(),
    ...(record.protocol === undefined ? {} : { protocol: record.protocol as string }), ...(fields ? { fields } : {}),
    ...(fields2 ? { fields2 } : {}), ...(record.frequency === undefined ? {} : { frequency: record.frequency as AdapterSourceContext['frequency'] }),
    ...(record.adjustment === undefined ? {} : { adjustment: record.adjustment as AdapterSourceContext['adjustment'] }),
    ...(record.market === undefined ? {} : { market: record.market as string }), basis: record.basis };
}
function readAdapterFieldOrder(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64
    || value.some(field => typeof field !== 'string' || !field.trim() || field.length > 128)
    || new Set(value).size !== value.length) fail('ADAPTER_CONTEXT', `${label} 须为不重复的明确文本。`);
  return [...value as string[]];
}

/**
 * 用本材料实际取得回执核对已采用配置的匹配条件。
 * 地址、协议、请求字段顺序、fields2、频率、复权与市场任一不符都拒绝；缺项保留未知，不自动取得用途。
 */
export function matchAdapterContext(config: EndpointAdapterConfig, context: AdapterSourceContext,
  materialSha256: string): AdapterMatchEvidence {
  if (context.materialSha256 !== materialSha256)
    fail('ADAPTER_CONTEXT_MATERIAL', '来源上下文绑定的材料摘要与本材料不符；未按其他材料的回执匹配。');
  const endpoint = config.match.endpoint, prefix = endpoint.includes('{') ? endpoint.slice(0, endpoint.indexOf('{')) : endpoint;
  const url = context.url.split('?')[0]!;
  // 固定 origin+path 精确匹配；只有声明中的 {code}/{date} 模板段允许受控变化，不接受父路径或同前缀端点。
  // 协议与主机必须完全一致：http 与 https、不同主机不能抹平。
  let urlValue: URL, endpointValue: URL;
  try { urlValue = new URL(context.url); endpointValue = new URL(endpoint); }
  catch { return fail('ADAPTER_CONTEXT_MISMATCH', '来源地址或适配端点不是有效绝对地址。'); }
  if (urlValue.protocol !== endpointValue.protocol || urlValue.host !== endpointValue.host)
    fail('ADAPTER_CONTEXT_MISMATCH', `来源地址 ${context.url} 的协议或主机与适配端点 ${endpoint} 不一致；未抹平 http/https 或跨主机复用。`);
  // URL 会把 {code} 百分号编码；声明侧先还原占位再逐段比较，来源侧保持原样。
  const urlPath = urlValue.pathname;
  let endpointPath: string;
  try { endpointPath = decodeURIComponent(endpointValue.pathname); } catch { endpointPath = endpointValue.pathname; }
  // 段数必须一致；只有声明中的 {code}/{date}/{symbol} 占位可对应非空内容，其余字符逐段精确相等。
  const placeholder = /\{(?:code|date|symbol)\}/u;
  const matchSegment = (pattern: string, actual: string): boolean => {
    if (!placeholder.test(pattern)) return pattern === actual;
    const parts = pattern.split(/\{(?:code|date|symbol)\}/u);
    if (parts.length === 2) return actual.length > parts[0]!.length + parts[1]!.length
      && actual.startsWith(parts[0]!) && actual.endsWith(parts[1]!);
    let index = 0;
    for (const [position, part] of parts.entries()) {
      if (position === 0) { if (!actual.startsWith(part)) return false; index = part.length; continue; }
      if (position === parts.length - 1) return actual.endsWith(part) && actual.length > index + part.length - 1;
      const at = actual.indexOf(part, index); if (at < 0) return false; index = at + part.length;
    }
    return false;
  };
  const endpointSegments = endpointPath.split('/'), urlSegments = urlPath.split('/');
  const matched = endpointSegments.length === urlSegments.length
    && endpointSegments.every((segment, index) => matchSegment(segment, urlSegments[index] ?? ''));
  if (!matched) fail('ADAPTER_CONTEXT_MISMATCH', `来源地址 ${context.url} 与适配声明的端点 ${endpoint} 不精确匹配；未跨端点或按同前缀复用配置。`);
  const compare = <T>(label: string, declared: T | undefined, actual: T | undefined, required = true) => {
    // 配置未声明且回执未提供：该维度不参与匹配，也不产生"未核"缺口。
    if (declared === undefined && actual === undefined) return null;
    if (actual === undefined) return required ? `${label}未提供，匹配未核` : null;
    if (declared === undefined) fail('ADAPTER_CONTEXT_MISMATCH', `适配配置未声明${label}，但本材料回执提供了该声明；未忽略实际语义。`);
    if (canonicalWfdJson(declared) !== canonicalWfdJson(actual))
      fail('ADAPTER_CONTEXT_MISMATCH', `${label}不符：回执 ${JSON.stringify(actual)}，配置 ${JSON.stringify(declared)}；未按其他变体继续。`);
    return null;
  };
  const gaps: string[] = [];
  for (const gap of [compare('协议', config.match.protocol, context.protocol), compare('请求字段', config.match.fields, context.fields),
    compare('fields2', config.match.fields2, context.fields2), compare('频率', config.match.frequency, context.frequency),
    compare('复权', config.match.adjustment, context.adjustment), compare('市场', config.match.market, context.market)])
    if (gap) gaps.push(gap);
  if (context.kind === 'synthetic') {
    // 内部一致先于合成标注：合成只说明未取得来源真实性，不改变已核的声明一致性。
    const consistent = gaps.length === 0;
    gaps.push('来源上下文为合成等价样本，不是供应商实际下载回执；结构一致不等于来源真实性已核。');
    return { verified: false, consistent, kind: 'synthetic', url: context.url, observedAt: context.observedAt, gaps };
  }
  // 真实回执：任一必要维度缺失或与声明不符都不能升级为已核。
  return { verified: gaps.length === 0, consistent: gaps.length === 0, kind: context.kind,
    url: context.url, observedAt: context.observedAt, gaps };
}

export function readAdapterBindingRef(value: unknown): AdapterBindingRef {
  const record = exactRecord(value, ['adapterId', 'version', 'configDigest'], 'ADAPTER_BINDING');
  if (typeof record.adapterId !== 'string' || !adapterIdPattern.test(record.adapterId)) fail('ADAPTER_BINDING', '适配引用须指向已登记端点适配。');
  if (typeof record.version !== 'string' || !versionPattern.test(record.version)) fail('ADAPTER_BINDING', '适配引用须固定版本。');
  if (typeof record.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.configDigest)) fail('ADAPTER_BINDING', '适配引用须携带配置摘要。');
  return { adapterId: record.adapterId, version: record.version, configDigest: record.configDigest };
}

/* ── 载体解码 ─────────────────────────────────────────────────────────────── */

export interface DecodedAdapterSource { text: string; charset: AdapterCharset; byteOrderMark: boolean; losslessRoundTrip: true }
/** 显式字符集无损解码；UTF-8 严格失败、GBK 往返不一致都直接拒绝，不替换非法字节。 */
export function decodeAdapterSource(bytes: Uint8Array, charset: AdapterCharset): DecodedAdapterSource {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) fail('ADAPTER_EMPTY', '端点原件为空，未生成虚构记录。');
  if (bytes.byteLength > ENDPOINT_ADAPTER_LIMITS.maxBytes) fail('ADAPTER_BUDGET', '端点原件超过本次解析字节预算。');
  const byteOrderMark = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (charset === 'utf-8') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail('ADAPTER_CHARSET', '原件不是严格 UTF-8；须按实际编码声明后重新解析，不替换非法字节。'); }
    if (text.includes('\u0000')) fail('ADAPTER_CHARSET', '原件含空字节，未作为文本解析。');
    return { text, charset, byteOrderMark, losslessRoundTrip: true };
  }
  if (!iconv.encodingExists(charset)) fail('ADAPTER_CHARSET', '未登记的字符集。');
  const text = iconv.decode(bytes, charset, { stripBOM: false });
  if (text.includes('\u0000')) fail('ADAPTER_CHARSET', '原件含空字节，未作为文本解析。');
  if (!iconv.encode(text, charset).equals(Buffer.from(bytes))) fail('ADAPTER_CHARSET', '原件无法按声明编码无损解码；须核对真实编码，不猜测或替换字节。');
  return { text, charset, byteOrderMark: false, losslessRoundTrip: true };
}

interface JsonNode { type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'; start: number; end: number;
  value?: MaterialScalar; entries?: { key: JsonNode; value: JsonNode }[]; items?: JsonNode[] }

/** 带原位置的 JSON 解析：只接受标准 JSON，不执行正文，节点与深度均受预算约束。 */
function parseJsonPositions(text: string, offset: number): JsonNode {
  let i = offset, nodes = 0;
  const skip = () => { while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n') i++; };
  const bad = (): never => fail('ADAPTER_JSON', '载体 JSON 语法无效；未自动修复或执行正文。');
  const parse = (depth: number): JsonNode => {
    if (depth > ENDPOINT_ADAPTER_LIMITS.maxDepth) fail('ADAPTER_JSON', '载体嵌套深度超过预算。');
    if (++nodes > ENDPOINT_ADAPTER_LIMITS.maxNodes) fail('ADAPTER_JSON', '载体节点数超过预算。');
    skip(); const start = i, char = text[i];
    if (char === '"') {
      i++; let escaped = false;
      while (i < text.length) {
        const next = text[i++];
        if (!escaped && next === '"') {
          let value: string;
          try { value = JSON.parse(text.slice(start, i)) as string; } catch { return bad(); }
          if (value.length > ENDPOINT_ADAPTER_LIMITS.maxCellCharacters) fail('ADAPTER_BUDGET', '载体字符串超过单元格字符预算。');
          return { type: 'string', value, start, end: i };
        }
        if (!escaped && next === '\\') escaped = true; else escaped = false;
      }
      return bad();
    }
    if (char === '[' || char === '{') {
      i++; skip();
      const items: JsonNode[] = [], entries: { key: JsonNode; value: JsonNode }[] = [], keys = new Set<string>(), close = char === '[' ? ']' : '}';
      if (text[i] !== close) while (true) {
        if (char === '[') items.push(parse(depth + 1));
        else {
          skip(); if (text[i] !== '"') return bad();
          const key = parse(depth + 1); skip();
          if (text[i++] !== ':') return bad();
          const name = String(key.value);
          if (keys.has(name)) fail('ADAPTER_JSON', '载体对象含重复键，未用后值覆盖原值。');
          keys.add(name); entries.push({ key, value: parse(depth + 1) });
        }
        skip(); if (text[i] === close) break;
        if (text[i++] !== ',') return bad();
      }
      i++; return { type: char === '[' ? 'array' : 'object', start, end: i, ...(char === '[' ? { items } : { entries }) };
    }
    for (const [token, value] of [['null', null], ['true', true], ['false', false]] as const) {
      if (text.startsWith(token, i)) { i += token.length; return { type: value === null ? 'null' : 'boolean', value, start, end: i }; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(i));
    if (number) {
      i += number[0].length;
      if (number[0].length > 1024) fail('ADAPTER_BUDGET', '载体数字字面量超过预算。');
      return { type: 'number', value: number[0], start, end: i };
    }
    return bad();
  };
  const root = parse(0); skip();
  if (i !== text.length) fail('ADAPTER_JSON', '载体在 JSON 之后仍有多余内容；未截取局部冒充完整响应。');
  return root;
}

function resolvePath(root: JsonNode, path: string): JsonNode | null {
  if (path === '$') return root;
  let node: JsonNode | undefined = root;
  for (const segment of path.split('.')) {
    if (!node) return null;
    if (/^[0-9]+$/u.test(segment)) { node = node.type === 'array' ? node.items?.[Number(segment)] : undefined; continue; }
    node = node.type === 'object' ? node.entries?.find(entry => entry.key.value === segment)?.value : undefined;
  }
  return node ?? null;
}
function scalarText(node: JsonNode): string | null {
  if (node.type === 'string') return String(node.value);
  if (node.type === 'number') return String(node.value);
  if (node.type === 'boolean') return node.value === true ? 'true' : 'false';
  return null;
}

interface Unwrapped { root: JsonNode; carrier: AdapterParseResult['carrier']; body: string }
function unwrapCarrier(text: string, config: EndpointAdapterConfig): Unwrapped {
  const carrier = config.carrier;
  if (carrier.kind === 'json') return { root: parseJsonPositions(text, 0), carrier: { kind: 'json', scope: 'source-text' }, body: text };
  if (carrier.kind === 'jsonp') {
    const prefix = carrier.callbackPrefix!;
    const open = text.indexOf('(');
    if (open < 0) fail('ADAPTER_CARRIER', 'JSONP 载体缺少受信函数调用封装。');
    const callback = text.slice(0, open).trim();
    if (!callback.startsWith(prefix) || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/u.test(callback)) fail('ADAPTER_CARRIER', 'JSONP 函数名不在声明前缀内；未执行或猜测脚本。');
    let end = text.length;
    while (end > open && /[\s;]/u.test(text[end - 1]!)) end--;
    if (text[end - 1] !== ')') fail('ADAPTER_CARRIER', 'JSONP 载体未以单一函数调用闭合；未截取局部内容。');
    if (text.slice(open + 1, end - 1).includes(')(')) fail('ADAPTER_CARRIER', 'JSONP 载体含多次调用，未按单次响应解析。');
    return { root: parseJsonPositions(text.slice(0, end - 1), open + 1), carrier: { kind: 'jsonp', scope: 'source-text', callback }, body: text };
  }
  if (carrier.kind === 'js-variable-assignment') {
    const prefix = carrier.variablePrefix!;
    const match = /^\s*(?:var\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*;?\s*$/u.exec(text);
    if (!match) throw new TaskError('ADAPTER_CARRIER', 'JS 变量赋值载体不是单一字符串赋值；未执行脚本或求值。');
    const variable = match[1]!;
    if (!variable.startsWith(prefix)) fail('ADAPTER_CARRIER', 'JS 变量名不在声明前缀内。');
    let decoded: string;
    try { decoded = JSON.parse(match[2]!) as string; } catch { return fail('ADAPTER_CARRIER', 'JS 字符串字面量无法按 JSON 转义无损解码。'); }
    // 解引用后的负载是独立文本：原值与定位都以该负载为准，并明确标注作用域。
    return { root: parseJsonPositions(decoded, 0), carrier: { kind: 'js-variable-assignment', scope: 'decoded-string', variable }, body: decoded };
  }
  return { root: parseJsonPositions(text, 0), carrier: { kind: 'json-embedded-delimited', scope: 'source-text' }, body: text };
}

/* ── 精确十进制换算（不使用浮点） ─────────────────────────────────────────── */

function decimalParts(value: string): { negative: boolean; digits: string; scale: number } | null {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? '';
  let digits = (match[2]! + fraction).replace(/^0+/u, '') || '0';
  return { negative: match[1] === '-', digits, scale: fraction.length };
}
/** 逐位相乘；结果保留完整小数位，不做舍入。 */
export function scaleDecimalExact(value: string, factor: string): string {
  const left = decimalParts(value), right = decimalParts(factor);
  if (!left || !right) throw new TaskError('ADAPTER_NUMBER', '单位换算只接受明确十进制字面量。');
  const product = (BigInt(left.digits) * BigInt(right.digits)).toString();
  const scale = left.scale + right.scale;
  let digits = product, result: string;
  if (scale === 0) result = digits;
  else if (scale >= digits.length) result = '0.' + '0'.repeat(scale - digits.length) + digits;
  else result = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  const [whole, fraction = ''] = result.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  result = trimmed ? `${whole}.${trimmed}` : whole!;
  return (left.negative !== right.negative && result !== '0' ? '-' : '') + result;
}

/* ── 解析 ─────────────────────────────────────────────────────────────────── */

export function parseEndpointSource(bytes: Uint8Array, config: EndpointAdapterConfig, limits?: { maxRecords?: number }): AdapterParseResult {
  const decoded = decodeAdapterSource(bytes, config.carrier.charset);
  const { root, carrier, body } = unwrapCarrier(decoded.text, config);
  const sourceSha256 = wfdSha256(bytes);
  let success: AdapterParseResult['success'] = null;
  if (config.response.success) {
    const node = resolvePath(root, config.response.success.path);
    const actual = node ? scalarText(node) : null;
    if (actual === null) throw new TaskError('ADAPTER_SUCCESS_MISSING', `响应缺少成功判定路径 ${config.response.success.path}；未把未知当成功。`);
    if (actual !== config.response.success.equals) fail('ADAPTER_SUCCESS_MISMATCH',
      `响应成功判定不符：${config.response.success.path}=${JSON.stringify(actual)}，期望 ${JSON.stringify(config.response.success.equals)}；未解析或隔离该响应。`);
    success = { path: config.response.success.path, expected: config.response.success.equals, actual };
  }
  // 容器外的并列结构可能是另一类业务数据（例如日线旁的榜单）：逐层核对每个祖先对象，不只查顶层。
  {
    const segments = config.response.container.path === '$' ? [] : config.response.container.path.split('.');
    const meta = new Set<string>([...(config.response.success ? [config.response.success.path.split('.')[0]!] : []),
      ...(config.response.pagination ? [config.response.pagination.totalPath.split('.')[0]!, config.response.pagination.cursorPath.split('.')[0]!] : []),
      ...(config.response.ignore ?? [])]);
    let node: JsonNode | null = root;
    for (const [depth, segment] of segments.entries()) {
      if (!node) break;
      if (node.type !== 'object') fail('ADAPTER_CONTAINER', '记录容器路径经过非对象层级；配置漂移已隔离。');
      const allowed = new Set<string>([segment, ...(depth === 0 ? meta : [])]);
      const extra = (node.entries ?? []).map(entry => String(entry.key.value)).filter(key => !allowed.has(key));
      if (extra.length) fail('ADAPTER_EXTRA_STRUCTURE',
        `第 ${depth + 1} 层「${segments.slice(0, depth).join('.') || '根'}」含未声明的并列结构「${extra.join('、')}」；`
        + '未把容器外业务数据当作已覆盖，也未默认归为元信息。');
      node = node.entries?.find(entry => String(entry.key.value) === segment)?.value ?? null;
    }
    if (!segments.length && root.type === 'object') {
      const extra = (root.entries ?? []).map(entry => String(entry.key.value)).filter(key => !meta.has(key));
      if (extra.length) fail('ADAPTER_EXTRA_STRUCTURE', `根对象含未声明的并列结构「${extra.join('、')}」。`);
    }
  }
  const containerNode = resolvePath(root, config.response.container.path);
  if (!containerNode) throw new TaskError('ADAPTER_CONTAINER', `响应缺少记录容器 ${config.response.container.path}；配置漂移已隔离，未回退到其他结构。`);
  const records = readRecords(containerNode, config, body);
  if (!records.length) fail('ADAPTER_EMPTY', '记录容器为空，未生成虚构记录。');
  // 额外业务维度不能静默丢弃：声明字段集以外的键必须显式失败，由操作者决定新增字段还是新配置。
  const declaredKeys = new Set(config.fields.filter(field => field.source.kind === 'key').map(field => (field.source as { key: string }).key));
  if (declaredKeys.size) for (const record of records) {
    if (record.node.type !== 'object') fail('ADAPTER_RECORD_TYPE', '记录容器含非对象项；键式配置未按位置猜测，也未跳过该项。');
    const extra = (record.node.entries ?? []).map(entry => String(entry.key.value)).filter(key => !declaredKeys.has(key));
    if (extra.length) fail('ADAPTER_EXTRA_FIELDS', `记录含未声明业务字段「${extra.join('、')}」；未静默丢弃额外维度，也未把它并入既有字段。`);
  }
  if (!declaredKeys.size && records.some(record => !record.fields))
    fail('ADAPTER_RECORD_TYPE', '位置式配置遇到非分隔记录；混合容器未被当作同一张表。');
  const maxRecords = Math.min(limits?.maxRecords ?? ENDPOINT_ADAPTER_LIMITS.maxRecords, ENDPOINT_ADAPTER_LIMITS.maxRecords);
  if (records.length > maxRecords) fail('ADAPTER_ROW_BUDGET', `记录数 ${records.length} 超过本次 ${maxRecords} 行预算；未截断提交。`);
  // 位置式记录必须逐条核对每个实际位置：中间未声明位置与尾部额外位置一样不能被省略。
  const positions = config.fields.filter(field => field.source.kind === 'position').map(field => (field.source as { index: number }).index);
  if (positions.length) {
    const declared = new Set(positions), width = Math.max(...positions) + 1;
    for (const [rowIndex, record] of records.entries()) {
      const actual = record.fields?.length ?? 0;
      if (actual > width) fail('ADAPTER_EXTRA_POSITIONS',
        `第 ${rowIndex + 1} 条分隔记录有 ${actual} 个位置，配置只声明 ${width} 个；未静默丢弃额外位置。`);
      const undeclared = Array.from({ length: actual }, (_, index) => index).filter(index => !declared.has(index));
      if (undeclared.length) fail('ADAPTER_UNDECLARED_POSITION',
        `第 ${rowIndex + 1} 条分隔记录的第 ${undeclared.map(index => index + 1).join('、')} 个位置未声明；未省略中间业务维度。`);
    }
  }
  const columns: string[] = config.fields.map(field => field.name);
  const rows: AdapterCell[][] = [];
  const conversions = new Map<string, { field: string; source: string; target: string; factor: string; basis: string; applied: number }>();
  for (const field of config.fields) if (field.unit && field.unit.factor !== '1')
    conversions.set(field.name, { field: field.name, source: field.unit.source, target: field.unit.target, factor: field.unit.factor, basis: field.unit.basis, applied: 0 });
  const gaps = new Set<string>();
  for (const [rowIndex, record] of records.entries()) {
    const row = config.fields.map(field => {
      const cell = readFieldCell(record, field, body);
      if (cell.original === null || cell.original === '') return cell;
      if (field.timeFormat && !validTimeValue(String(cell.original), field.timeFormat))
        fail('ADAPTER_TIME', `第 ${rowIndex + 1} 行「${field.name}」不是声明的 ${field.timeFormat} 写法；未猜测时区或格式。`);
      if (field.type === 'integer' && !/^-?(?:0|[1-9][0-9]*)$/u.test(String(cell.original)))
        fail('ADAPTER_TYPE', `第 ${rowIndex + 1} 行「${field.name}」不是配置声明的整数；未按浮点或四舍五入准入。`);
      if (field.type === 'decimal' && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(String(cell.original)))
        fail('ADAPTER_TYPE', `第 ${rowIndex + 1} 行「${field.name}」不是配置声明的十进制字面量；未猜测数值。`);
      const conversion = conversions.get(field.name);
      if (!conversion) return cell;
      const scaled = scaleDecimalExact(String(cell.original), conversion.factor);
      conversion.applied++;
      return { ...cell, value: scaled };
    });
    rows.push(row);
  }
  // 分页未完成的上游响应不能因本页完整解析就声明完整系列。
  let seriesComplete: boolean | null = null;
  if (config.response.pagination) {
    const totalNode = resolvePath(root, config.response.pagination.totalPath);
    const cursorNode = resolvePath(root, config.response.pagination.cursorPath);
    const total = totalNode ? Number(scalarText(totalNode)) : Number.NaN;
    // 游标缺失或为对象/数组是结构漂移，不能当成"已到末页"。
    const cursor = cursorNode ? scalarText(cursorNode) : null;
    const cursorTerminated = cursor !== null && ['', '0', 'false', 'null', 'none'].includes(cursor.trim().toLowerCase());
    if (!cursorNode || cursor === null)
      fail('ADAPTER_PAGINATION_INCOMPLETE', `响应缺少可核的终止游标（${config.response.pagination.cursorPath} ${cursorNode ? '类型不是标量' : '缺失'}）；本页不声明完整系列。`);
    if (!Number.isSafeInteger(total) || total !== records.length || !cursorTerminated)
      fail('ADAPTER_PAGINATION_INCOMPLETE', `响应分页未闭合（total=${totalNode ? scalarText(totalNode) : '缺失'}, records=${records.length}, cursor=${JSON.stringify(cursor)}）；本页不声明完整系列。`);
    seriesComplete = true;
  } else gaps.add('配置未声明上游分页/游标：本页完整解析不等于来源系列完整，覆盖范围仍未知。');
  if (config.fields.some(field => field.source.kind === 'position'))
    gaps.add('字段按载体位置映射：载体无字段名，字段含义依据来源文档与既有样本，不是来源自报列名。');
  if (!config.response.success) gaps.add('载体没有成功标志；只按结构核对，不把 HTTP 200 当作业务成功。');
  if (config.match.adjustment === 'unknown') gaps.add('复权口径未知：不得与已知口径序列拼接或用于收益率比较。');
  if (config.match.adjustment !== 'unknown') gaps.add(`复权口径按配置声明为 ${config.match.adjustment}，未经独立因子或第二来源复核。`);
  if (config.match.market === undefined) gaps.add('未声明必要市场规则；历史涨跌停、交易日历等规则不能按当前市场默认补齐。');
  if (config.fields.some(field => field.timeFormat)) gaps.add('时间写法按配置逐值核对并保留原词面，未转换时区、未证明业务时间精度。');
  if (config.evidence.coverage.trim().length) gaps.add(`来源覆盖声明：${config.evidence.coverage}`);
  return { sourceSha256, decoded: { charset: decoded.charset, byteLength: bytes.byteLength, characterCount: decoded.text.length,
    losslessRoundTrip: true, byteOrderMark: decoded.byteOrderMark }, carrier, success,
    container: { path: config.response.container.path, kind: config.response.container.kind, records: records.length },
    columns, rows, conversions: [...conversions.values()], seriesComplete, gaps: [...gaps], totalRows: rows.length };
}

/** 时间写法只做"是否符合声明"的内容核对，不推断时区或业务含义。 */
function validTimeValue(value: string, format: AdapterTimeFormat): boolean {
  const date = (text: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
    const time = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
  };
  switch (format) {
    case 'iso-date': return date(value);
    case 'yyyymmdd': return /^\d{8}$/u.test(value) && date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
    case 'iso-local-minute': { const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):00$/u.exec(value);
      return !!match && date(match[1]!) && Number(match[2]) < 24 && Number(match[3]) < 60; }
    case 'iso-datetime': { const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value);
      return !!match && date(match[1]!) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60; }
    case 'epoch-second': return /^\d{9,11}$/u.test(value);
    case 'epoch-millisecond': return /^\d{12,14}$/u.test(value);
    case 'hhmmss': { if (!/^\d{1,6}$/u.test(value)) return false;
      const padded = value.padStart(6, '0');
      return Number(padded.slice(0, 2)) < 24 && Number(padded.slice(2, 4)) < 60 && Number(padded.slice(4, 6)) < 60; }
    default: return false;
  }
}

interface AdapterRecord { node: JsonNode; fields: JsonNode[] | null; sourceStart: number }
function readRecords(container: JsonNode, config: EndpointAdapterConfig, text: string): AdapterRecord[] {
  if (config.response.container.kind === 'object-index-map') {
    const entries = container.type === 'object' ? container.entries : undefined;
    if (!entries) throw new TaskError('ADAPTER_CONTAINER', '记录容器声明为下标对象，但载体不是对象；配置漂移已隔离。');
    const keys = entries.map((entry: { key: JsonNode }) => String(entry.key.value));
    if (keys.some(key => !/^[0-9]+$/u.test(key))) fail('ADAPTER_CONTAINER', '下标对象含非数字键；未按插入顺序冒充行号。');
    const ordered = [...entries].sort((a, b) => Number(a.key.value) - Number(b.key.value));
    return ordered.map(entry => ({ node: entry.value, fields: null, sourceStart: entry.value.start }));
  }
  if (config.response.container.kind === 'array') {
    const items = container.type === 'array' ? container.items : undefined;
    if (!items) throw new TaskError('ADAPTER_CONTAINER', '记录容器声明为数组，但载体不是数组；配置漂移已隔离。');
    return items.map(item => ({ node: item, fields: null, sourceStart: item.start }));
  }
  // delimited-array：字符串数组，或单字符串内以记录分隔符分条。
  const separator = config.carrier.recordSeparator ?? '\n';
  const delimiter = config.carrier.delimiter!;
  const strings: JsonNode[] = container.type === 'array' ? (container.items ?? []) : [container];
  if (strings.some(node => node.type !== 'string')) fail('ADAPTER_CONTAINER', '内嵌分隔记录容器含非字符串项；未展开嵌套结构。');
  const records: AdapterRecord[] = [];
  for (const node of strings) {
    if (text.slice(node.start, node.end).includes('\\')) fail('ADAPTER_CARRIER', '内嵌记录字符串含转义，原值与位置无法一一对应；未猜测定位。');
    const value = String(node.value);
    const base = node.start + 1; // 跳过开引号，指向字符串内容起点
    let offset = 0;
    for (const part of value.split(separator)) {
      if (part.trim()) records.push({ node, fields: splitDelimited(part, delimiter, base + offset), sourceStart: base + offset });
      offset += part.length + separator.length;
    }
  }
  return records;
}
function splitDelimited(part: string, delimiter: string, base: number): JsonNode[] {
  const fields: JsonNode[] = [];
  let offset = 0;
  for (const value of part.split(delimiter)) {
    fields.push({ type: 'string', value, start: base + offset, end: base + offset + value.length });
    offset += value.length + delimiter.length;
  }
  return fields;
}
function readFieldCell(record: AdapterRecord, field: EndpointAdapterField, text: string): AdapterCell {
  const missing = (): AdapterCell => ({ original: null, value: null, sourceType: 'missing', quote: '', location: locationAt(text, record.sourceStart, record.sourceStart) });
  if (field.source.kind === 'position') {
    const node = record.fields?.[field.source.index];
    return node ? cellFromNode(node, text) : missing();
  }
  if (record.fields) return missing();
  const entries = record.node.type === 'object' ? record.node.entries : undefined;
  if (!entries) throw new TaskError('ADAPTER_RECORD', '记录不是对象，不能按键取值；未按位置猜测。');
  const source = field.source;
  const found = entries.find(item => String(item.key.value) === source.key);
  return found ? cellFromNode(found.value, text) : missing();
}
function cellFromNode(node: JsonNode, text: string): AdapterCell {
  const quote = text.slice(node.start, node.end);
  const location = locationAt(text, node.start, node.end);
  if (node.type === 'null') return { original: null, value: null, sourceType: 'null', quote, location };
  if (node.type === 'boolean') return { original: node.value === true, value: node.value === true, sourceType: 'boolean', quote, location };
  if (node.type === 'number') return { original: String(node.value), value: String(node.value), sourceType: 'number', quote, location };
  if (node.type === 'string') return { original: String(node.value), value: String(node.value), sourceType: 'string', quote, location };
  return fail('ADAPTER_RECORD', '记录字段为嵌套对象或数组；未自动展开或拍平。');
}
function locationAt(text: string, start: number, end: number): MaterialLocation {
  let line = 1, lineStart = 0;
  for (let index = 0; index < start; index++) if (text[index] === '\n') { line++; lineStart = index + 1; }
  return { start, end, line, column: start - lineStart + 1 };
}

/** 把解析结果映射为材料表形态，供既有五步共用同一行结构。 */
export function adapterMaterialTable(result: AdapterParseResult): MaterialTable {
  const columns: MaterialColumn[] = result.columns.map((name, index) => ({ name, proposedName: name,
    quote: name, location: { start: 0, end: 0, line: 1, column: index + 1, field: index + 1 } }));
  const rows: MaterialCell[][] = result.rows.map((row, rowIndex) => row.map((cell, columnIndex) => ({
    sourceType: cell.sourceType, original: cell.original,
    proposed: cell.value !== cell.original ? cell.value : cell.original,
    ...(cell.value !== cell.original ? { converted: cell.value } : {}),
    quote: cell.quote, location: { ...cell.location, row: rowIndex + 1, field: columnIndex + 1 } })));
  return { columns, rows, totalRows: rows.length, previewTruncated: false };
}

/** 解析证据写入步骤产物；原值、原定位、换算依据与配置身份一并保留。 */
export function adapterParseEvidence(config: EndpointAdapterConfig, result: AdapterParseResult): WfdRecord {
  return { contract: ENDPOINT_ADAPTER_CONTRACT, adapter_id: config.adapterId, adapter_version: config.version,
    config_digest: adapterConfigDigest(config), endpoint: config.match.endpoint, protocol: config.match.protocol,
    frequency: config.match.frequency, adjustment: config.match.adjustment, ...(config.match.fields ? { fields: config.match.fields } : {}),
    charset: result.decoded.charset, lossless_round_trip: true, byte_order_mark: result.decoded.byteOrderMark,
    carrier: result.carrier, success: result.success, container: result.container,
    series_complete: result.seriesComplete, conversions: result.conversions, gaps: result.gaps,
    evidence: { source_id: config.evidence.sourceId, provider: config.evidence.provider, coverage: config.evidence.coverage, basis: config.evidence.basis } };
}

/* ── 自动发现：只生成候选，不产生已采用版本 ─────────────────────────────── */

export interface AdapterProposal { config: EndpointAdapterConfig; status: 'candidate'; basis: string[]; gaps: string[]; confidence: 'low' | 'medium' }
export function discoverEndpointAdapter(bytes: Uint8Array, hints: { adapterId: string; version: string; endpoint: string;
  protocol?: string; frequency?: EndpointAdapterConfig['match']['frequency']; sourceId: string; provider: string; coverage: string }): AdapterProposal {
  const basis: string[] = [], gaps: string[] = ['自动发现只依据单份样本结构，字段金融含义、单位与复权须由操作者按来源文档确认。'];
  let charset: AdapterCharset = 'utf-8', text: string;
  try { text = decodeAdapterSource(bytes, 'utf-8').text; basis.push('样本可按严格 UTF-8 解码。'); }
  catch {
    text = decodeAdapterSource(bytes, 'gbk').text; charset = 'gbk';
    basis.push('严格 UTF-8 解码失败，样本可按 GBK 无损往返解码；编码依据仅为结构探测。');
  }
  let kind: AdapterCarrierKind = 'json', callbackPrefix: string | undefined, variablePrefix: string | undefined;
  let jsonText = text, offset = 0;
  const jsonp = /^\s*([A-Za-z_$][A-Za-z0-9_$.]*)\(/u.exec(text);
  const variable = /^\s*(?:var\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*;?\s*$/u.exec(text);
  if (jsonp) {
    const open = text.indexOf('('), close = text.lastIndexOf(')');
    kind = 'jsonp'; callbackPrefix = jsonp[1]!;
    jsonText = text.slice(0, close); offset = open + 1;
    basis.push(`样本以单一函数调用 ${callbackPrefix}(...) 包裹。`);
  } else if (variable) {
    kind = 'js-variable-assignment'; variablePrefix = variable[1]!;
    jsonText = JSON.parse(variable[2]!) as string; offset = 0;
    basis.push(`样本为单一 JS 字符串变量赋值 ${variablePrefix}="..."。`);
  } else if (!/^\s*[[{]/u.test(text)) fail('ADAPTER_DISCOVERY', '样本不是 JSON、JSONP 或 JS 变量赋值载体，未生成候选。');
  let root: JsonNode;
  try { root = kind === 'js-variable-assignment' ? { type: 'string', value: jsonText, start: 0, end: jsonText.length } : parseJsonPositions(jsonText, offset); }
  catch { return fail('ADAPTER_DISCOVERY', '样本结构无法按受控 JSON 读取，未生成候选。'); }
  const found = findRecordArray(root);
  if (!found) throw new TaskError('ADAPTER_DISCOVERY', '样本中没有可识别的记录数组，未生成候选。');
  const { path, node } = found;
  const first = node.items![0]!;
  let delimiter: string | undefined;
  let fields: EndpointAdapterField[];
  let containerKind: EndpointAdapterConfig['response']['container']['kind'] = 'array';
  if (first.type === 'object') {
    fields = (first.entries ?? []).map((entry: { key: JsonNode; value: JsonNode }, index: number) => ({ name: String(entry.key.value) || `field_${index + 1}`,
      source: { kind: 'key' as const, key: String(entry.key.value) }, type: guessType(entry.value) }));
    basis.push(`记录为对象数组，首条记录含 ${fields.length} 个键。`);
  } else if (first.type === 'string') {
    for (const candidate of [',', '~', '|']) if (String(first.value).split(candidate).length > 1) { delimiter = candidate; break; }
    if (!delimiter) throw new TaskError('ADAPTER_DISCOVERY', '记录字符串没有可识别的字段分隔符，未生成候选。');
    kind = 'json-embedded-delimited'; containerKind = 'delimited-array';
    const width = String(first.value).split(delimiter).length;
    fields = Array.from({ length: width }, (_, index) => ({ name: `field_${index + 1}`, source: { kind: 'position' as const, index }, type: 'text' as const }));
    gaps.push(`内嵌记录按「${delimiter}」分隔，共 ${width} 个位置字段；字段名与类型须按来源文档逐项命名，当前仅为占位候选。`);
    basis.push('记录为分隔字符串数组，须以 JSON 内嵌分隔记录载体解析。');
  } else return fail('ADAPTER_DISCOVERY', '记录既不是对象也不是分隔字符串，未生成候选。');
  const config: EndpointAdapterConfig = { contract: ENDPOINT_ADAPTER_CONTRACT, adapterId: hints.adapterId, version: hints.version,
    match: { endpoint: hints.endpoint, protocol: hints.protocol ?? (kind === 'json-embedded-delimited' ? 'json-embedded-csv/v1'
      : kind === 'jsonp' ? 'jsonp/v1' : kind === 'js-variable-assignment' ? 'js-variable/v1' : 'json/v1'),
      frequency: hints.frequency ?? 'other', adjustment: 'unknown' },
    carrier: { kind, charset, ...(callbackPrefix ? { callbackPrefix } : {}), ...(variablePrefix ? { variablePrefix } : {}),
      ...(delimiter ? { delimiter, recordSeparator: '\n' } : {}) },
    response: { success: null, container: { path, kind: containerKind } }, fields,
    evidence: { sourceId: hints.sourceId, provider: hints.provider, coverage: hints.coverage,
      basis: '自动发现的结构候选；未核对来源文档、单位与复权依据。' } };
  return { config: readEndpointAdapterConfig(config), status: 'candidate', basis, gaps, confidence: kind === 'json' ? 'medium' : 'low' };
}
function findRecordArray(root: JsonNode): { path: string; node: JsonNode } | null {
  const queue: { node: JsonNode; path: string; depth: number }[] = [{ node: root, path: '', depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.node.type === 'array' && current.node.items?.length && ['object', 'string'].includes(current.node.items[0]!.type))
      return { path: current.path || '$', node: current.node };
    if (current.depth >= 4) continue;
    if (current.node.type === 'object') for (const entry of current.node.entries ?? [])
      queue.push({ node: entry.value, path: current.path ? `${current.path}.${String(entry.key.value)}` : String(entry.key.value), depth: current.depth + 1 });
    if (current.node.type === 'array') for (const [index, item] of (current.node.items ?? []).entries())
      queue.push({ node: item, path: current.path ? `${current.path}.${index}` : String(index), depth: current.depth + 1 });
  }
  return null;
}
function guessType(node: JsonNode): AdapterFieldType {
  if (node.type === 'number') return /^-?(?:0|[1-9][0-9]*)$/u.test(String(node.value)) ? 'integer' : 'decimal';
  if (node.type === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(String(node.value))) return 'decimal';
  return 'text';
}

/** 只做键集合核对；值仍由各字段的显式类型检查逐项验证。 */
function exactRecord(value: unknown, keys: string[], code: string): Record<string, any> {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail(code, `需要明确对象且只接受字段：${keys.join(', ')}。`);
  return value as Record<string, any>;
}

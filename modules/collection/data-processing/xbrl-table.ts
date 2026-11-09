import { SaxesParser, type SaxesTagNS } from 'saxes';
import { canonicalWfdJson, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { normalizeNumericLexeme } from './numeric-format.js';

const X = 'http://www.xbrl.org/2003/instance', D = 'http://xbrl.org/2006/xbrldi';
const IX = 'http://www.xbrl.org/2013/inlineXBRL', XSI = 'http://www.w3.org/2001/XMLSchema-instance';
export const XBRL_ADAPTER_VERSION = 'bd-xbrl-numeric/1';
export interface XbrlSelection { version: typeof XBRL_ADAPTER_VERSION; reportId: string; reportVersion: string; concepts: string[] }
interface Node { tag: SaxesTagNS; ns: Record<string, string>; children: Node[]; content: (Node | string)[]; start: number; end: number; line: number; column: number }
const fail = (message: string): never => { throw new TaskError('XBRL_ADAPTER', message); };
const name = (node: Node) => `{${node.tag.uri}}${node.tag.local}`;
const attr = (node: Node, local: string, uri = '') => Object.values(node.tag.attributes).find(value => value.local === local && value.uri === uri)?.value;
const kids = (node: Node, local: string, uri = X) => node.children.filter(child => child.tag.local === local && child.tag.uri === uri);
const one = (node: Node, local: string, uri = X): Node => { const values = kids(node, local, uri); if (values.length !== 1) fail(`须有唯一 ${local}，未猜测缺失或重复上下文。`); return values[0]!; };
const text = (node: Node): string => node.content.map(part => typeof part === 'string' ? part : text(part)).join('');
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const qname = (node: Node, lexical: string): string => {
  const match = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)$/u.exec(lexical.trim());
  if (!match || !node.ns[match[1] ?? '']) return fail('QName 缺少可解析的命名空间 URI；未按字面前缀合并。');
  return `{${node.ns[match[1] ?? '']}}${match[2]}`;
};
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('本适配只支持有效公历日期期间；日期时刻须专门适配。');
  return value;
}
const nextDay = (value: string) => new Date(Date.parse(value + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);

export function readXbrlSelection(raw: unknown): XbrlSelection {
  const value = raw as XbrlSelection;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'concepts,reportId,reportVersion,version'
    || value.version !== XBRL_ADAPTER_VERSION || ![value.reportId, value.reportVersion].every(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(id))
    || !Array.isArray(value.concepts) || value.concepts.length > 256
    || value.concepts.some(code => typeof code !== 'string' || !/^\{[^{}]+\}[A-Za-z_][\w.-]*$/u.test(code))
    || new Set(value.concepts).size !== value.concepts.length) fail('XBRL 计划须固定报告、修订及扩展名称形式的概念选集；空选集表示全部支持的数值事实。');
  return structuredClone(value);
}

/** XML 只由 saxes 6.0.0 解释，不取 taxonomy/DTD/远程引用，不执行正文。 */
function tree(source: string): Node {
  if (Buffer.byteLength(source) > 16_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(source)) fail('XML 超过 16MB 或含 DTD/实体声明；未读取外部资源。');
  const parser = new SaxesParser({ xmlns: true, position: true });
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/gu)) lineStarts.push(match.index! + match[0].length);
  const stack: Node[] = []; let root: Node | undefined, count = 0, opening = 0;
  parser.on('opentagstart', () => { opening = parser.position - 1; while (opening > 0 && source[opening] !== '<') opening--; });
  parser.on('opentag', tag => {
    if (++count > 100_000 || stack.length >= 128) fail('XML 节点或嵌套超过本次预算。');
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid]! <= opening) lo = mid; else hi = mid; }
    const node: Node = { tag, ns: { ...(stack.at(-1)?.ns ?? {}), ...tag.ns }, children: [], content: [], start: opening,
      end: 0, line: lo + 1, column: opening - lineStarts[lo]! + 1 };
    if (stack.length) { stack.at(-1)!.children.push(node); stack.at(-1)!.content.push(node); } else root = node;
    stack.push(node);
  });
  const append = (value: string) => { if (stack.length) stack.at(-1)!.content.push(value); };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop()!.end = parser.position; });
  parser.on('doctype', () => fail('禁止 DTD。'));
  parser.on('error', error => fail(`XML 语法无效：${error.message}`));
  parser.write(source).close();
  if (!root) fail('XML 无根。');
  return root!;
}

export function projectXbrlTable(bytes: Uint8Array, raw: XbrlSelection) {
  const selection = readXbrlSelection(raw);
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('XBRL 需要严格 UTF-8 原件。'); }
  const root = tree(source), nodes = all(root);
  const instance = root.tag.uri === X && root.tag.local === 'xbrl';
  const inline = nodes.some(node => node.tag.uri === IX && ['nonFraction', 'resources'].includes(node.tag.local));
  if (!instance && !inline) fail('本适配支持 XBRL 2.1 实例及 XML 形式的 inline XBRL 1.1 数值事实。');
  if (nodes.some(node => node.tag.uri === IX && ['fraction', 'tuple', 'continuation'].includes(node.tag.local))) fail('分数、元组或续段需要专门适配，未截断为单值。');
  const contexts = new Map<string, { entity_scheme: string; entity_code: string; period_type: string; start_date: string; end_date: string; dimensions: string }>();
  const units = new Map<string, string>();
  for (const node of nodes.filter(node => node.tag.uri === X && node.tag.local === 'context')) {
    const id = attr(node, 'id'), entity = one(node, 'entity'), identifier = one(entity, 'identifier'), scheme = attr(identifier, 'scheme'), code = text(identifier).trim();
    if (!id || contexts.has(id) || !scheme?.trim() || !code) fail('上下文主体须保留唯一原 context ID、标识方案与原代码。');
    const period = one(node, 'period'), instant = kids(period, 'instant');
    const end = date(text(instant.length ? one(period, 'instant') : one(period, 'endDate')).trim());
    const start = instant.length ? end : date(text(one(period, 'startDate')).trim());
    if (instant.length ? period.children.length !== 1 : period.children.length !== 2 || end < start) fail('期间结构不明确或终止早于起始。');
    const dimensions: [string, string][] = [];
    for (const member of all(node).filter(value => value.tag.uri === D)) {
      if (member.tag.local !== 'explicitMember') fail('typedMember 尚无本适配的类型合同；未按文本合并。');
      dimensions.push([qname(member, attr(member, 'dimension') ?? ''), qname(member, text(member))]);
    }
    if (new Set(dimensions.map(([axis]) => axis)).size !== dimensions.length) fail('上下文维度重复。');
    const nonDim = all(node).filter(value => ['segment', 'scenario'].includes(value.tag.local) && value.tag.uri === X)
      .flatMap(value => value.children).some(value => value.tag.uri !== D);
    if (nonDim) fail('非维度 segment/scenario 需要专门解释，未丢弃。');
    contexts.set(id!, { entity_scheme: scheme!, entity_code: code, period_type: instant.length ? 'instant' : 'duration', start_date: start,
      end_date: end, dimensions: canonicalWfdJson(dimensions.sort(([a], [b]) => a.localeCompare(b))) });
  }
  for (const node of nodes.filter(node => node.tag.uri === X && node.tag.local === 'unit')) {
    const id = attr(node, 'id'); if (!id || units.has(id)) fail('单位 ID 缺失或重复。');
    const measures = (parent: Node) => { const list = kids(parent, 'measure'); if (list.length !== parent.children.length || !list.length) fail('单位只能使用已解释的 measure。'); return list.map(value => qname(value, text(value))).sort(); };
    const divide = kids(node, 'divide');
    const value = divide.length ? { numerator: measures(one(one(node, 'divide'), 'unitNumerator')), denominator: measures(one(one(node, 'divide'), 'unitDenominator')) }
      : { numerator: measures(node), denominator: [] };
    if (divide.length && (node.children.length !== 1 || divide[0]!.children.length !== 2)) fail('复合单位结构无效。');
    units.set(id!, canonicalWfdJson(value));
  }
  const rows: Record<string, string | null>[] = [], facts: Record<string, unknown>[] = [], byKey = new Map<string, number>();
  let availableFacts = 0, excludedFacts = 0;
  for (const node of nodes) {
    const isInline = node.tag.uri === IX && node.tag.local === 'nonFraction';
    const contextId = attr(node, 'contextRef');
    if (!contextId || node.tag.uri === X) continue;
    availableFacts++;
    const concept = isInline ? qname(node, attr(node, 'name') ?? '') : name(node);
    if (selection.concepts.length && !selection.concepts.includes(concept)) { excludedFacts++; continue; }
    const unitId = attr(node, 'unitRef'), context = contexts.get(contextId) ?? fail('选中事实缺有效 context 引用。');
    const unit = unitId ? units.get(unitId) ?? fail('选中事实缺有效 unit 引用。') : fail('非数值事实需单独适配。');
    const decimals = attr(node, 'decimals'), precision = attr(node, 'precision');
    if (decimals !== undefined && precision !== undefined || decimals === undefined && precision === undefined
      || decimals !== undefined && !/^(?:INF|0|-?[1-9]\d{0,3})$/u.test(decimals)
      || precision !== undefined && !/^(?:INF|[1-9]\d{0,3})$/u.test(precision)) fail('数值精度声明缺失、冲突或超出支持预算；scale 不代替精度。');
    const nil = attr(node, 'nil', XSI), lexical = text(node).trim();
    if (nil !== undefined && !['true', 'false', '1', '0'].includes(nil)) fail('nil 声明无效。');
    const isNil = nil === 'true' || nil === '1';
    if (isNil && lexical) fail('nil 事实不能同时携带数值。');
    if (!isInline && node.children.length) fail('选中事实含子结构，未按普通数值解释。');
    let value: string | null = null;
    if (!isNil) {
      const format = attr(node, 'format'); let comma = false;
      if (format) {
        const expanded = qname(node, format);
        if (!/^\{http:\/\/www\.xbrl\.org\/inlineXBRL\/transformation\/2020-02-12\}num-(?:dot|comma)-decimal$/u.test(expanded)) fail('内联转换不在本次明确支持列表。');
        comma = expanded.endsWith('num-comma-decimal');
      }
      value = normalizeNumericLexeme(lexical, { decimal: comma ? ',' : '.', grouping: isInline && format ? comma ? '.' : ',' : null,
        negative: 'minus', plus: false, percent: 'reject' });
      const scale = attr(node, 'scale'), sign = attr(node, 'sign');
      if (!isInline && (scale !== undefined || sign !== undefined)) fail('普通 XBRL 事实不接受内联 scale/sign。');
      if (scale !== undefined) {
        if (!/^-?\d{1,2}$/u.test(scale) || Math.abs(Number(scale)) > 18) fail('内联倍率超过本次精确十进制预算。');
        const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
        const digits = whole! + fraction, point = whole!.length + Number(scale);
        const shifted = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
        const parts = shifted.split('.');
        value = normalizeNumericLexeme((negative ? '-' : '') + parts[0]!.replace(/^0+(?=\d)/u, '') + (parts[1] ? '.' + parts[1] : ''), { decimal: '.', grouping: null, negative: 'minus', plus: false, percent: 'reject' });
      }
      if (sign !== undefined) { if (sign !== '-' || value.startsWith('-')) fail('内联 sign 无效或与数值词面重复。'); if (value !== '0') value = '-' + value; }
    }
    const identity = { report_id: selection.reportId, report_version: selection.reportVersion, concept, ...context, unit };
    const key = 'xbrl_' + wfdSha256(canonicalWfdJson(identity));
    const evidence = { contextId, unitId, concept, originalLexeme: lexical, decimals: decimals ?? null, precision: precision ?? null,
      scale: attr(node, 'scale') ?? null, sign: attr(node, 'sign') ?? null, start: node.start, end: node.end,
      quote: source.slice(node.start, node.end), line: node.line, column: node.column };
    const old = byKey.get(key);
    if (old !== undefined) {
      if (rows[old]!.value !== value) fail('相同业务身份存在矛盾事实；未去重吞掉冲突。');
      (facts[old]!.locations as unknown[]).push(evidence); continue;
    }
    byKey.set(key, rows.length);
    rows.push({ business_key: key, ...identity, value, value_state: isNil ? 'not_reported' : value === '0' ? 'reported_zero' : 'valid_value',
      start_utc: context.start_date + 'T00:00:00Z', end_utc: nextDay(context.end_date) + 'T00:00:00Z' });
    facts.push({ businessKey: key, locations: [evidence] });
  }
  if (!rows.length || rows.length > 5000) fail('选中数值事实须为1–5000条；未截断或补造。');
  if (selection.concepts.some(concept => !rows.some(row => row.concept === concept))) fail('显式选中的概念没有可解释事实，未忽略缺项。');
  const jsonBytes = Buffer.from(canonicalWfdJson(rows));
  return { jsonBytes, evidence: { adapter: XBRL_ADAPTER_VERSION, parser: 'saxes/6.0.0', sourceSha256: wfdSha256(bytes), selection,
    availableFacts, excludedFacts, publishedCandidates: rows.length, scope: 'selected-supported-numeric-facts', facts } };
}

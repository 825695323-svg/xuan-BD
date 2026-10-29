import { posix } from 'node:path';
import iconv from 'iconv-lite';
import type { ConversionPayload, ConversionIssue } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError } from '../../runtime/file-workspace.js';
import { attr, decodeText, parseXml, xmlChildren, xmlNodes, zipMembers, type ArchiveMember } from './formats.js';

type Native = { [key: string]: JsonValue };
const local = (node: Element): string => node.localName.split(':').at(-1)!;
const direct = (node: Element, name: string): Element[] => xmlChildren(node).filter(child => local(child) === name);
const text = (node?: Element): string => node?.textContent ?? '';
type Relation = { id: string; target: string; mode: string; type: string; part: string | null };

/** 不跟随外链，不执行域/宏；relationships 的 Target 原文始终保留。 */
export function officeNative(bytes: Buffer, format: 'docx' | 'pptx' | 'xlsx', signal: AbortSignal): ConversionPayload {
  const members = zipMembers(bytes), byPath = new Map(members.map(value => [value.path, value]));
  const parts = new Map<string, { xml: string; document: Document }>(), issues: ConversionIssue[] = [];
  let nodeCount = 0;
  const tick = () => { signal.throwIfAborted(); if (++nodeCount > 100_000) throw new DirectError('OFFICE_NODE_LIMIT', 'Office 原生节点超过本次预算。'); };
  const part = (path: string): Document => {
    signal.throwIfAborted(); const existing = parts.get(path); if (existing) return existing.document;
    const entry = byPath.get(path); if (!entry || entry.kind !== 'file') throw new DirectError('OFFICE_PART_MISSING', `Office 缺少原生部件：${path}`);
    const xml = decodeText(entry.read()).text, document = parseXml(xml); parts.set(path, { xml, document }); return document;
  };
  const relationships = (path: string): Relation[] => {
    const relPath = posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels');
    if (!byPath.has(relPath)) return [];
    return xmlNodes(part(relPath), 'Relationship').map(relation => {
      const target = attr(relation, 'Target') ?? '', mode = attr(relation, 'TargetMode') ?? 'Internal';
      const resolved = mode === 'External' || !target ? null : target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(path), target));
      return { id: attr(relation, 'Id') ?? '', target, mode, type: attr(relation, 'Type') ?? '', part: resolved };
    });
  };
  const links = (path: string, id: string | null, anchor?: string | null): Native => {
    const relation = id ? relationships(path).find(value => value.id === id) : undefined;
    if (id && !relation) issues.push({ code: 'RELATIONSHIP_MISSING', message: '原文链接关系未找到，保留原始关系编号。', location: { part: path, id } });
    return { relationshipId: id, target: relation?.target ?? (anchor ? '#' + anchor : null), mode: relation?.mode ?? (anchor ? 'Internal' : null), anchor: anchor ?? null };
  };
  const unknown = (node: Element, path: string, at: string): Native => {
    issues.push({ code: 'OFFICE_NATIVE_OBJECT', message: '原生对象保留 XML 和位置，未把图形、嵌入对象或替代部件转换成伪正文。', location: { part: path, path: at, name: node.tagName } });
    return { type: 'native-object', name: node.tagName, location: { part: path, path: at }, rawXml: node.outerHTML };
  };
  const word = (node: Element, path: string, at: string, depth = 0): Native => {
    tick(); if (depth > 128) throw new DirectError('OFFICE_DEPTH_LIMIT', 'Office 结构嵌套超过本次预算。');
    const name = local(node), location = { part: path, path: at };
    if (['drawing', 'pict', 'object', 'altChunk', 'oMath', 'oMathPara'].includes(name)) return unknown(node, path, at);
    if (name === 't' || name === 'delText') return { type: name === 't' ? 'text' : 'deleted-text', text: text(node), xmlSpace: attr(node, 'space'), location };
    if (name === 'instrText') return { type: 'field-instruction', instruction: text(node), location };
    if (name === 'tab') return { type: 'tab', text: '\t', location };
    if (name === 'br' || name === 'cr' || name === 'lastRenderedPageBreak') return { type: 'break', breakType: attr(node, 'type') ?? (name === 'lastRenderedPageBreak' ? 'last-rendered-page' : 'line'), text: '\n', location };
    if (name === 'footnoteReference' || name === 'endnoteReference') return { type: name, id: attr(node, 'id'), location };
    if (name === 'fldChar') return { type: 'field-marker', fieldType: attr(node, 'fldCharType'), location };
    if (name === 'bookmarkStart' || name === 'bookmarkEnd') return { type: name, id: attr(node, 'id'), name: attr(node, 'name'), location };
    const children = xmlChildren(node).filter(child => !['pPr', 'rPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'sectPr'].includes(local(child)))
      .map((child, index) => word(child, path, `${at}/${child.tagName}[${index + 1}]`, depth + 1));
    const result: Native = { type: ({ p: 'paragraph', r: 'run', tbl: 'table', tr: 'row', tc: 'cell', hyperlink: 'hyperlink', footnote: 'footnote', endnote: 'endnote', comment: 'comment', hdr: 'header', ftr: 'footer', ins: 'insertion', del: 'deletion' } as Record<string, string>)[name] ?? name, children, location };
    if (name === 'p') {
      const properties = direct(node, 'pPr')[0];
      if (properties) result.properties = { style: attr(xmlNodes(properties, 'pStyle')[0] ?? properties, 'val'), outlineLevel: attr(xmlNodes(properties, 'outlineLvl')[0] ?? properties, 'val'),
        numberingId: attr(xmlNodes(properties, 'numId')[0] ?? properties, 'val'), numberingLevel: attr(xmlNodes(properties, 'ilvl')[0] ?? properties, 'val'), rawXml: properties.outerHTML };
    }
    if (name === 'r') { const properties = direct(node, 'rPr')[0]; if (properties) result.rawProperties = properties.outerHTML; }
    if (name === 'hyperlink') Object.assign(result, links(path, attr(node, 'id'), attr(node, 'anchor')));
    if (name === 'fldSimple') result.instruction = attr(node, 'instr');
    if (['footnote', 'endnote', 'comment'].includes(name)) result.id = attr(node, 'id');
    if (name === 'tc') {
      const properties = direct(node, 'tcPr')[0];
      result.gridSpan = properties ? attr(xmlNodes(properties, 'gridSpan')[0] ?? properties, 'val') : null;
      const merge = properties ? xmlNodes(properties, 'vMerge')[0] : undefined;
      result.verticalMerge = merge ? attr(merge, 'val') ?? 'continue' : null;
    }
    if (!children.length && !['p', 'r', 'body', 'document', 'tr', 'tc', 'tbl'].includes(name)) result.rawXml = node.outerHTML;
    return result;
  };
  const drawingText = (node: Element, path: string, at: string): Native => {
    tick(); const name = local(node), location = { part: path, path: at };
    if (name === 't') return { type: 'text', text: text(node), location };
    if (name === 'br') return { type: 'break', text: '\n', location };
    const children = xmlChildren(node).filter(child => !['pPr', 'rPr', 'endParaRPr', 'tcPr', 'tblPr', 'tblGrid'].includes(local(child)))
      .map((child, index) => drawingText(child, path, `${at}/${child.tagName}[${index + 1}]`));
    const result: Native = { type: ({ p: 'paragraph', r: 'run', tbl: 'table', tr: 'row', tc: 'cell' } as Record<string, string>)[name] ?? name, children, location };
    const click = xmlNodes(node, 'hlinkClick')[0];
    if (click && ['r', 'fld'].includes(name)) result.hyperlink = links(path, attr(click, 'id'), attr(click, 'action'));
    if (name === 'tc') { result.rowSpan = attr(node, 'rowSpan'); result.gridSpan = attr(node, 'gridSpan'); result.horizontalMerge = attr(node, 'hMerge'); result.verticalMerge = attr(node, 'vMerge'); }
    return result;
  };
  let native: JsonValue;
  if (format === 'docx') {
    const path = 'word/document.xml', document = part(path), body = xmlNodes(document, 'body')[0];
    if (!body) throw new DirectError('OFFICE_PART_INVALID', 'Word 原件缺少正文 body。');
    const blocks = xmlChildren(body).filter(child => local(child) !== 'sectPr').map((node, index) => word(node, path, `/body/${node.tagName}[${index + 1}]`));
    const supplements: Native[] = [];
    for (const entry of members.filter(value => /^word\/(?:footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/u.test(value.path))) {
      supplements.push({ part: entry.path, blocks: xmlChildren(part(entry.path).documentElement).map((node, index) => word(node, entry.path, `/${node.tagName}[${index + 1}]`)) });
    }
    for (const extra of ['word/styles.xml', 'word/numbering.xml']) if (byPath.has(extra)) part(extra);
    native = { format, readingOrder: 'native-body-order', blocks, supplements };
  } else if (format === 'pptx') {
    const presentation = 'ppt/presentation.xml', relations = relationships(presentation), slideIds = xmlNodes(part(presentation), 'sldId'), slides: Native[] = [];
    for (const [index, slideId] of slideIds.entries()) {
      const relation = relations.find(value => value.id === attr(slideId, 'id') && value.type.endsWith('/slide'));
      // p:sldId 同时有 id 与 r:id；关系编号明确按完整属性名读取。
      const rid = slideId.getAttribute('r:id') ?? Array.from(slideId.attributes).find(value => value.name.endsWith(':id'))?.value;
      const slidePath = relations.find(value => value.id === rid)?.part ?? relation?.part;
      if (!slidePath || !byPath.has(slidePath)) throw new DirectError('OFFICE_PART_MISSING', 'PPT 页关系缺失。');
      const doc = part(slidePath), tree = xmlNodes(doc, 'spTree')[0];
      const shapes = tree ? xmlChildren(tree).filter(node => ['sp', 'graphicFrame', 'pic', 'grpSp', 'cxnSp'].includes(local(node))) : [];
      const blocks = shapes.map((shape, shapeIndex): Native => {
        tick(); const at = `/slide/spTree/${shape.tagName}[${shapeIndex + 1}]`, bounds = xmlNodes(shape, 'xfrm')[0], off = bounds ? xmlNodes(bounds, 'off')[0] : undefined, ext = bounds ? xmlNodes(bounds, 'ext')[0] : undefined;
        const tables = xmlNodes(shape, 'tbl'), paragraphs = xmlNodes(shape, 'txBody');
        if (local(shape) === 'pic' || local(shape) === 'grpSp') return unknown(shape, slidePath, at);
        return { type: local(shape), location: { slide: index + 1, part: slidePath, path: at },
          boundsEmu: { x: off ? attr(off, 'x') : null, y: off ? attr(off, 'y') : null, width: ext ? attr(ext, 'cx') : null, height: ext ? attr(ext, 'cy') : null },
          blocks: (tables.length ? tables : paragraphs).map((node, blockIndex) => drawingText(node, slidePath, `${at}/${node.tagName}[${blockIndex + 1}]`)) };
      });
      const notes = relationships(slidePath).filter(value => value.type.endsWith('/notesSlide') && value.part && byPath.has(value.part)).map(value => {
        const path = value.part!; return { part: path, blocks: xmlNodes(part(path), 'txBody').map((node, n) => drawingText(node, path, `/notes/txBody[${n + 1}]`)) };
      });
      slides.push({ slide: index + 1, nativeId: slideId.getAttribute('id'), part: slidePath, blocks, notes });
    }
    native = { format, readingOrder: 'presentation-slide-order/native-shape-order', slides };
  } else {
    const workbookPath = 'xl/workbook.xml', workbook = part(workbookPath), relations = relationships(workbookPath);
    const shared = byPath.has('xl/sharedStrings.xml') ? xmlNodes(part('xl/sharedStrings.xml'), 'si').map(node => {
      const segments = xmlChildren(node).filter(child => ['t', 'r'].includes(local(child)));
      return { value: segments.map(child => local(child) === 't' ? text(child) : xmlNodes(child, 't').map(item => text(item)).join('')).join(''), rawXml: node.outerHTML };
    }) : [];
    const sheets: Native[] = [];
    for (const sheet of xmlNodes(workbook, 'sheet')) {
      const rid = sheet.getAttribute('r:id') ?? attr(sheet, 'id'), path = relations.find(value => value.id === rid)?.part;
      if (!path || !byPath.has(path)) throw new DirectError('OFFICE_PART_MISSING', 'Excel 工作表关系缺失。');
      if (!relations.find(value => value.id === rid)?.type.endsWith('/worksheet')) { issues.push({ code: 'XLSX_NON_WORKSHEET', message: '图表工作表只保留关系与原生部件。', location: { part: path } }); part(path); continue; }
      const doc = part(path), rows = xmlNodes(doc, 'row').map(row => {
        tick(); return { row: attr(row, 'r'), cells: direct(row, 'c').map(cell => {
          tick(); const rawValue = direct(cell, 'v')[0], inline = direct(cell, 'is')[0], formula = direct(cell, 'f')[0], type = attr(cell, 't') ?? 'n';
          const rawStorage = rawValue ? text(rawValue) : null;
          const sharedIndex = type === 's' && rawStorage !== null && /^\d+$/u.test(rawStorage) ? Number(rawStorage) : undefined;
          if (sharedIndex !== undefined && !shared[sharedIndex]) issues.push({ code: 'XLSX_SHARED_STRING_MISSING', message: '单元格共享字符串索引缺失，未填补原值。', location: { part: path, cell: attr(cell, 'r') } });
          return { address: attr(cell, 'r'), location: { part: path, sheet: attr(sheet, 'name'), cell: attr(cell, 'r') }, storageType: type, rawStorage,
            resolvedSharedString: sharedIndex === undefined ? null : shared[sharedIndex]?.value ?? null,
            inlineString: inline ? xmlChildren(inline).filter(child => ['t', 'r'].includes(local(child))).map(child => local(child) === 't' ? text(child) : xmlNodes(child, 't').map(item => text(item)).join('')).join('') : null,
            formula: formula ? { expression: text(formula), attributes: Array.from(formula.attributes).map(value => ({ name: value.name, value: value.value })) } : null,
            styleIndex: attr(cell, 's'), rawXml: cell.outerHTML };
        }) };
      });
      const hyperlinks = xmlNodes(doc, 'hyperlink').map(node => ({ cellRange: attr(node, 'ref'), display: attr(node, 'display'), ...links(path, node.getAttribute('r:id'), attr(node, 'location')) }));
      sheets.push({ name: attr(sheet, 'name'), nativeId: attr(sheet, 'sheetId'), state: attr(sheet, 'state'), part: path, rows, hyperlinks,
        mergedRanges: xmlNodes(doc, 'mergeCell').map(node => attr(node, 'ref')) });
    }
    if (byPath.has('xl/styles.xml')) part('xl/styles.xml');
    native = { format, valueInterpretation: 'native-storage-only/no-recalculation/no-date-or-unit-conversion',
      date1904: xmlNodes(workbook, 'workbookPr')[0] ? attr(xmlNodes(workbook, 'workbookPr')[0]!, 'date1904') : null, sharedStrings: shared, sheets };
  }
  for (const entry of members.filter(value => /(?:vbaProject\.bin|\/embeddings\/)/iu.test(value.path))) {
    issues.push({ code: 'OFFICE_ATTACHMENT_NOT_CONVERTED', message: '原件含宏或嵌入附件；只列原生成员，需显式选件拆解。', location: { part: entry.path } });
  }
  const partList = [...parts.keys()];
  const relationList = partList.filter(path => !path.endsWith('.rels')).map(path => ({ part: path, relationships: relationships(path) }));
  const content = { native, relationships: relationList, originalParts: [...parts].map(([path, value]) => ({ path, xml: value.xml })),
    attachments: members.filter(value => /(?:\/(?:media|embeddings)\/|vbaProject\.bin)/iu.test(value.path)).map(value => ({ path: value.path, bytes: value.bytes })) };
  return { status: issues.length ? 'partial' : 'complete', issues, content, text: format === 'xlsx' ? undefined : nativeText(native) };
}
export function nativeText(value: JsonValue): string {
  if (Array.isArray(value)) return value.map(nativeText).join('');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  const body = ['children', 'blocks', 'slides', 'supplements', 'notes'].map(key => key in value ? nativeText(value[key]!) : '').join('');
  return body + (['paragraph', 'row', 'slide'].includes(String(value.type ?? '')) ? '\n' : '');
}

/** 有限 RTF 原生解析：原始控制树与源偏移完整保留；不支持的目的地保持 partial。 */
export function rtfNative(bytes: Buffer, signal: AbortSignal): ConversionPayload {
  const input = bytes.toString('latin1'), issues: ConversionIssue[] = [], unknowns = new Set<string>();
  type RNode = { type: 'group'; start: number; end: number; children: RNode[] } | { type: 'control'; name: string; parameter: number | null; start: number; end: number } | { type: 'text'; text: string; start: number; end: number };
  type State = { codepage: string; unicodeFallback: number; skip: number };
  let cursor = 0, count = 0;
  const fonts = new Map<number, string>(), documentCodepage = 'cp' + (input.match(/\\ansicpg(\d+)/u)?.[1] ?? '1252');
  if (!iconv.encodingExists(documentCodepage)) throw new DirectError('RTF_ENCODING_UNSUPPORTED', 'RTF 原始代码页未支持。');
  const charset: Record<number, string> = { 0: documentCodepage, 128: 'shift_jis', 129: 'cp949', 134: 'gbk', 136: 'big5', 161: 'cp1253', 162: 'cp1254', 177: 'cp1255', 178: 'cp1256', 186: 'cp1257', 204: 'cp1251', 222: 'cp874', 238: 'cp1250' };
  for (const match of input.matchAll(/\{\\f(\d+)[^{}]*?\\fcharset(\d+)[^{}]*\}/gu)) if (charset[Number(match[2])]) fonts.set(Number(match[1]), charset[Number(match[2])]!);
  const group = (state: State, depth: number): RNode => {
    signal.throwIfAborted(); if (depth > 128 || ++count > 100_000 || input[cursor] !== '{') throw new DirectError('RTF_LIMIT', 'RTF 结构无效或超过本次深度预算。');
    const start = cursor++, children: RNode[] = [], current = { ...state };
    const append = (value: string, at: number, end: number) => { if (current.skip > 0) { const n = Math.min(current.skip, value.length); value = value.slice(n); current.skip -= n; } if (value) children.push({ type: 'text', text: value, start: at, end }); };
    while (cursor < input.length && input[cursor] !== '}') {
      if (++count > 100_000) throw new DirectError('RTF_LIMIT', 'RTF 超过本次节点预算。');
      const at = cursor, char = input[cursor++];
      if (char === '{') { cursor--; children.push(group(current, depth + 1)); continue; }
      if (char !== '\\') {
        while (cursor < input.length && !['{', '}', '\\'].includes(input[cursor]!)) cursor++;
        const raw = bytes.subarray(at, cursor), filtered = Buffer.from(raw.filter(value => value !== 10 && value !== 13));
        append(iconv.decode(filtered, current.codepage), at, cursor); continue;
      }
      const symbol = input[cursor++];
      if (symbol === "'") {
        const hex: number[] = []; let position = cursor - 2;
        while (input.slice(position, position + 2) === "\\'") { const token = input.slice(position + 2, position + 4); if (!/^[a-f\d]{2}$/iu.test(token)) throw new DirectError('RTF_INVALID', 'RTF 十六进制转义无效。'); hex.push(Number.parseInt(token, 16)); position += 4; }
        cursor = position; append(iconv.decode(Buffer.from(hex), current.codepage), at, cursor); continue;
      }
      if (symbol && ['\\', '{', '}'].includes(symbol)) { append(symbol, at, cursor); continue; }
      if (symbol && ['~', '-', '_'].includes(symbol)) { append(symbol === '~' ? '\u00a0' : symbol === '_' ? '\u2011' : '\u00ad', at, cursor); continue; }
      if (!symbol || !/[a-z]/iu.test(symbol)) { children.push({ type: 'control', name: symbol ?? '', parameter: null, start: at, end: cursor }); continue; }
      cursor--; const matched = input.slice(cursor).match(/^([a-z]+)(-?\d+)? ?/iu)!; cursor += matched[0].length;
      const name = matched[1]!, parameter = matched[2] === undefined ? null : Number(matched[2]);
      children.push({ type: 'control', name, parameter, start: at, end: cursor });
      if (name === 'ansicpg' || name === 'cpg') { const codepage = 'cp' + parameter; if (!iconv.encodingExists(codepage)) throw new DirectError('RTF_ENCODING_UNSUPPORTED', 'RTF 声明了未支持的代码页。'); current.codepage = codepage; }
      if (name === 'f' && parameter !== null && fonts.has(parameter)) current.codepage = fonts.get(parameter)!;
      if (name === 'uc' && parameter !== null) { if (parameter < 0 || parameter > 16) throw new DirectError('RTF_INVALID', 'RTF Unicode 回退长度无效。'); current.unicodeFallback = parameter; }
      if (name === 'u' && parameter !== null) { children.push({ type: 'text', text: String.fromCharCode((parameter + 65536) % 65536), start: at, end: cursor }); current.skip = current.unicodeFallback; }
      if (name === 'bin') {
        if (parameter === null || parameter < 0 || cursor + parameter > input.length) throw new DirectError('RTF_INVALID', 'RTF 二进制对象长度无效。');
        cursor += parameter; unknowns.add('bin');
      }
    }
    if (input[cursor++] !== '}') throw new DirectError('RTF_INVALID', 'RTF 控制组未闭合。');
    return { type: 'group', start, end: cursor, children };
  };
  const root = group({ codepage: documentCodepage, unicodeFallback: 1, skip: 0 }, 0);
  if (input.slice(cursor).trim()) throw new DirectError('RTF_INVALID', 'RTF 根控制组后有未解析内容。');
  const omitted = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'generator', 'filetbl', 'revtbl', 'rsidtbl', 'latentstyles', 'xmlnstbl']);
  const objects = new Set(['pict', 'object', 'objdata', 'shp', 'shpinst', 'nonshppict', 'themedata', 'datastore']);
  const controls = { par: '\n', line: '\n', tab: '\t', cell: '\t', row: '\n', page: '\f', column: '\n', emdash: '\u2014', endash: '\u2013', bullet: '\u2022', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d' } as Record<string, string>;
  const links: Native[] = [], notes: Native[] = [];
  const render = (node: RNode, hidden = false): string => {
    if (node.type === 'text') return hidden ? '' : node.text;
    if (node.type === 'control') return hidden ? '' : controls[node.name] ?? '';
    const first = node.children.find(child => child.type === 'control' && child.name !== '*');
    const name = first?.type === 'control' ? first.name : '';
    const starred = node.children[0]?.type === 'control' && node.children[0].name === '*';
    if (objects.has(name)) { unknowns.add(name); return ''; }
    if (starred && !['fldinst', 'bkmkstart', 'bkmkend'].includes(name) && !omitted.has(name)) { unknowns.add(name); return ''; }
    if (omitted.has(name) || name === 'fldinst') return '';
    if (name === 'field') {
      const instruction = node.children.filter(child => child.type === 'group').find(child => child.type === 'group' && child.children.some(item => item.type === 'control' && item.name === 'fldinst'));
      if (instruction?.type === 'group') {
        const rawInstruction = instruction.children.map(child => child.type === 'text' ? child.text : '').join('');
        const match = rawInstruction.match(/HYPERLINK\s+(?:"([^"]*)"|(\S+))/iu);
        links.push({ target: match?.[1] ?? match?.[2] ?? null, rawInstruction, location: { byteOffset: node.start, endByteOffset: node.end } });
      }
    }
    const rendered = node.children.map(child => render(child, hidden)).join('');
    if (name === 'footnote') { notes.push({ text: rendered, location: { byteOffset: node.start, endByteOffset: node.end } }); return ''; }
    return rendered;
  };
  const body = render(root);
  for (const name of unknowns) issues.push({ code: 'RTF_NATIVE_DESTINATION', message: `RTF 原生目的地 ${name} 只保留原始控制树和字节范围。`, location: { destination: name } });
  // 表格边界以 cell/row 控制词保留在树中；不把视觉宽度猜成逻辑列。
  const paragraphs = body.split('\n').map((value, index) => ({ paragraph: index + 1, text: value }));
  return { status: issues.length ? 'partial' : 'complete', issues, text: body, content: { format: 'rtf', offsetUnit: 'byte', nativeTree: root as unknown as JsonValue, paragraphs, links, notes, originalRtfLatin1: input } };
}

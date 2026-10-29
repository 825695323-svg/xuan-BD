import { inflateRawSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DOMParser } from 'linkedom';
import iconv from 'iconv-lite';
import type { ConversionPayload } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError } from '../../runtime/file-workspace.js';

export const MAX_SOURCE = 20_000_000;
export const MAX_EXPANDED = 64_000_000;
export const MAX_ENTRIES = 2048;
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string): never => { throw new DirectError(code, message); };
export type Format = 'pdf' | 'rtf' | 'docx' | 'pptx' | 'xlsx' | 'zip' | 'gzip' | 'tar' | 'png' | 'jpeg' | 'webp'
  | 'gif' | 'wav' | 'mp3' | 'flac' | 'ogg' | 'mp4' | 'matroska' | 'aiff' | 'aac' | 'json' | 'xml' | 'html' | 'csv' | 'subtitle' | 'text' | 'ole' | 'unknown';
export interface Inspection { format: Format; method: 'signature' | 'container-parts' | 'validated-text' | 'text-with-name-hint' | 'unknown'; encoding?: string; declaredExtension: string }
export interface ArchiveMember { path: string; bytes: number; kind: 'file' | 'directory'; read(): Buffer }
export function memberName(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/iu.test(value)
    || value.split('/').some(part => part === '..' || part === '.') || value.length > 1024) fail('ARCHIVE_PATH_REFUSED', '压缩包含绝对路径、上级路径或歧义成员名。');
  return value;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

/** 只读取中央目录，逐项解压受 maxOutputLength 约束；不跟随链接、不递归、不执行附件。 */
export function zipMembers(bytes: Buffer): ArchiveMember[] {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) return fail('ZIP_INVALID', 'ZIP 中央目录不完整。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || count === 65535 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count || start + size !== end) return fail('ZIP_LIMIT', 'ZIP 分卷、ZIP64 或目录预算超出本轮支持范围。');
  const members: ArchiveMember[] = [], names = new Set<string>();
  let position = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) return fail('ZIP_INVALID', 'ZIP 成员目录无效。');
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20), expanded = bytes.readUInt32LE(position + 24), nameSize = bytes.readUInt16LE(position + 28);
    const next = position + 46 + nameSize + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const offset = bytes.readUInt32LE(position + 42), mode = bytes.readUInt32LE(position + 38) >>> 16;
    if (next > end || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || flags & 1 || ![0, 8].includes(method)
      || (mode & 0xf000) === 0xa000 || expanded > MAX_EXPANDED || (total += expanded) > MAX_EXPANDED) return fail('ZIP_MEMBER_REFUSED', 'ZIP 含加密、链接、不支持压缩或超限成员。');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameSize);
    const name = memberName(flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) : iconv.decode(nameBytes, 'cp437'));
    if (names.has(name)) return fail('ARCHIVE_DUPLICATE_NAME', '压缩包含重名成员，无法唯一选择。');
    names.add(name);
    const localNameSize = bytes.readUInt16LE(offset + 26), localExtraSize = bytes.readUInt16LE(offset + 28), dataStart = offset + 30 + localNameSize + localExtraSize;
    if (bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || dataStart + compressed > start
      || !bytes.subarray(offset + 30, offset + 30 + localNameSize).equals(nameBytes)) return fail('ZIP_INVALID', 'ZIP 本地成员与中央目录不一致。');
    const input = bytes.subarray(dataStart, dataStart + compressed);
    members.push({ path: name, bytes: expanded, kind: name.endsWith('/') ? 'directory' : 'file', read() {
      const value = method === 0 ? Buffer.from(input) : inflateRawSync(input, { maxOutputLength: Math.max(1, expanded) });
      if (value.length !== expanded || crc32(value) !== checksum) return fail('ZIP_CHECKSUM_MISMATCH', 'ZIP 成员大小或 CRC 摘要不符。');
      return value;
    } });
    position = next;
  }
  if (position !== end) return fail('ZIP_INVALID', 'ZIP 目录结束位置不符。');
  return members;
}
export function archiveMembers(bytes: Buffer, format: Format, filename: string): ArchiveMember[] {
  if (['zip', 'docx', 'pptx', 'xlsx'].includes(format)) return zipMembers(bytes);
  let content = bytes;
  if (format === 'gzip') content = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
  if (format === 'tar' || content.subarray(257, 262).toString('ascii') === 'ustar') {
    if (content.length < 1024 || content.length % 512 !== 0) return fail('TAR_TRUNCATED', 'TAR 缺少完整头块或末尾终止块。');
    const result: ArchiveMember[] = [], names = new Set<string>(); let offset = 0, total = 0;
    while (offset + 512 <= content.length) {
      const header = content.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {
        if (offset + 1024 > content.length || !content.subarray(offset).every(byte => byte === 0)) return fail('TAR_TERMINATOR_INVALID', 'TAR 缺少两个完整零终止块或终止后含未解析内容。');
        return result;
      }
      const octal = (part: Buffer) => { const value = part.toString('ascii').replace(/\0.*$/su, '').trim(); if (!/^[0-7]*$/u.test(value)) return fail('TAR_INVALID', 'TAR 数值字段不是受支持的八进制。'); return value ? Number.parseInt(value, 8) : 0; };
      const checksum = octal(header.subarray(148, 156));
      if (header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) !== checksum) return fail('TAR_INVALID', 'TAR 头校验失败。');
      const string = (part: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(part.subarray(0, part.indexOf(0) >= 0 ? part.indexOf(0) : part.length));
      const prefix = string(header.subarray(345, 500)), leaf = string(header.subarray(0, 100)), name = memberName(prefix ? prefix + '/' + leaf : leaf);
      const size = octal(header.subarray(124, 136)), type = header[156], start = offset + 512;
      if (![0, 48, 53].includes(type!) || size > MAX_EXPANDED || (total += size) > MAX_EXPANDED || start + size > content.length
        || start + Math.ceil(size / 512) * 512 > content.length || result.length >= MAX_ENTRIES || names.has(name)) return fail('TAR_MEMBER_REFUSED', 'TAR 含链接、扩展头、重名、截断或超限成员；本轮不自动扩展解析。');
      names.add(name); result.push({ path: name, bytes: size, kind: type === 53 ? 'directory' : 'file', read: () => Buffer.from(content.subarray(start, start + size)) });
      offset = start + Math.ceil(size / 512) * 512;
    }
    return fail('TAR_TERMINATOR_INVALID', 'TAR 在两个零终止块之前结束。');
  }
  if (format === 'gzip') return [{ path: memberName(filename.replace(/\.gz$/iu, '') || 'payload'), bytes: content.length, kind: 'file', read: () => content }];
  return fail('ARCHIVE_UNSUPPORTED', '选件拆解支持 ZIP、TAR、GZIP 和 Office 内嵌成员；其他格式请使用现有受控解包入口。');
}

export function decodeText(bytes: Buffer, requested?: string): { text: string; encoding: string; bomBytes: number } {
  let encoding = requested?.toLowerCase(), bomBytes = 0;
  const mark = bytes.subarray(0, 4).toString('hex');
  if (mark.startsWith('efbbbf')) { encoding ??= 'utf-8'; bomBytes = 3; }
  else if (mark.startsWith('fffe0000')) { encoding ??= 'utf-32le'; bomBytes = 4; }
  else if (mark.startsWith('0000feff')) { encoding ??= 'utf-32be'; bomBytes = 4; }
  else if (mark.startsWith('fffe')) { encoding ??= 'utf-16le'; bomBytes = 2; }
  else if (mark.startsWith('feff')) { encoding ??= 'utf-16be'; bomBytes = 2; }
  encoding ??= 'utf-8';
  if (!/^[a-z0-9_-]{1,40}$/u.test(encoding) || !iconv.encodingExists(encoding)) return fail('ENCODING_UNSUPPORTED', '未提供受支持的明确编码。');
  const data = bytes.subarray(bomBytes);
  try {
    const text = /^utf-?8$/u.test(encoding) ? new TextDecoder('utf-8', { fatal: true }).decode(data) : iconv.decode(data, encoding, { stripBOM: false });
    if (text.includes('\0') || !iconv.encode(text, encoding).equals(data)) return fail('ENCODING_AMBIGUOUS', '原件无法按本次编码无损解码；需要明确原始编码。');
    return { text, encoding, bomBytes };
  } catch (error) { if (error instanceof DirectError) throw error; return fail('ENCODING_AMBIGUOUS', '原件不是严格 UTF-8；请明确原始编码，不自动猜测或替换字节。'); }
}
export function inspectFormat(bytes: Buffer, name: string, requestedEncoding?: string): Inspection {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  const hit = (format: Format, method: Inspection['method'] = 'signature', encoding?: string): Inspection => ({ format, method, declaredExtension: extension, ...(encoding ? { encoding } : {}) });
  const prefix = bytes.subarray(0, 16), ascii = prefix.toString('ascii');
  if (bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return hit('ole');
  if (ascii.startsWith('%PDF-')) return hit('pdf');
  if (ascii.startsWith('{\\rtf')) return hit('rtf');
  if (prefix.subarray(0, 4).toString('hex') === '504b0304' || prefix.subarray(0, 4).toString('hex') === '504b0506') {
    const entries = zipMembers(bytes), paths = new Set(entries.map(entry => entry.path)), declaration = entries.find(entry => entry.path === '[Content_Types].xml');
    const types = declaration ? xmlNodes(parseXml(decodeText(declaration.read()).text), 'Override') : [];
    const main = (part: string, suffixes: string[]) => paths.has(part) && types.some(type => attr(type, 'PartName') === '/' + part && suffixes.some(suffix => (attr(type, 'ContentType') ?? '').endsWith(suffix)));
    return hit(main('word/document.xml', ['wordprocessingml.document.main+xml', 'word.document.macroEnabled.main+xml']) ? 'docx'
      : main('ppt/presentation.xml', ['presentationml.presentation.main+xml', 'powerpoint.presentation.macroEnabled.main+xml']) ? 'pptx'
      : main('xl/workbook.xml', ['spreadsheetml.sheet.main+xml', 'excel.sheet.macroEnabled.main+xml']) ? 'xlsx' : 'zip', 'container-parts');
  }
  if (prefix.subarray(0, 2).toString('hex') === '1f8b') return hit('gzip');
  if (bytes.subarray(257, 262).toString('ascii') === 'ustar') return hit('tar');
  if (prefix.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return hit('png');
  if (prefix.subarray(0, 3).toString('hex') === 'ffd8ff') return hit('jpeg');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return hit('gif');
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return hit('webp');
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return hit('wav');
  if (ascii.startsWith('FORM') && ['AIFF', 'AIFC'].includes(ascii.slice(8, 12))) return hit('aiff');
  if (ascii.startsWith('fLaC')) return hit('flac');
  if (ascii.startsWith('OggS')) return hit('ogg');
  if (prefix.subarray(0, 4).toString('hex') === '1a45dfa3') return hit('matroska');
  if (ascii.slice(4, 8) === 'ftyp') return hit('mp4');
  if (ascii.startsWith('ID3') || prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0 && (prefix[1]! & 0x06) !== 0) return hit('mp3');
  if (prefix[0] === 0xff && (prefix[1]! & 0xf6) === 0xf0) return hit('aac');
  try {
    const decoded = decodeText(bytes, requestedEncoding), trimmed = decoded.text.trimStart();
    if (/^<!DOCTYPE html/iu.test(trimmed) || /^<html(?:\s|>)/iu.test(trimmed)) return hit('html', 'validated-text', decoded.encoding);
    if (['.html', '.htm'].includes(extension) && trimmed.startsWith('<')) return hit('html', 'text-with-name-hint', decoded.encoding);
    if (trimmed.startsWith('<')) { parseXml(decoded.text); return hit('xml', 'validated-text', decoded.encoding); }
    if (extension === '.csv' || extension === '.tsv') return hit('csv', 'text-with-name-hint', decoded.encoding);
    if (/^[{["\d\-tfn]/u.test(trimmed)) { try { parseJsonNative(decoded.text); return hit('json', 'validated-text', decoded.encoding); } catch { /* 普通文字也可能以这些字符开始。 */ } }
    if (['.srt', '.vtt', '.ass', '.ssa', '.ttml'].includes(extension)) return hit('subtitle', 'text-with-name-hint', decoded.encoding);
    return hit('text', 'validated-text', decoded.encoding);
  } catch { return hit('unknown', 'unknown'); }
}

/** DOM 只用于本地结构读取；拒绝实体声明，不解析外部资源。 */
export function parseXml(text: string): Document {
  if (Buffer.byteLength(text) > 16_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(text)) return fail('XML_REFUSED', 'XML 超限或含 DTD/实体声明，本轮不读取外部资源。');
  // linkedom 的 XML 模式不会拒绝所有错配标签；先核对原文，避免宽容解析静默修复结构。
  const stack: string[] = []; let position = 0, roots = 0, elements = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position), preceding = text.slice(position, start < 0 ? text.length : start);
    if ((!stack.length && preceding.trim()) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/u.test(preceding)) return fail('XML_INVALID', 'XML 根外文本或实体引用无效。');
    if (start < 0) break;
    if (text.startsWith('<!--', start)) { const end = text.indexOf('-->', start + 4); if (end < 0 || text.slice(start + 4, end).includes('--')) return fail('XML_INVALID', 'XML 注释无效。'); position = end + 3; continue; }
    if (text.startsWith('<![CDATA[', start)) { const end = text.indexOf(']]>', start + 9); if (end < 0 || !stack.length) return fail('XML_INVALID', 'XML CDATA 无效。'); position = end + 3; continue; }
    if (text.startsWith('<?', start)) { const end = text.indexOf('?>', start + 2); if (end < 0) return fail('XML_INVALID', 'XML 处理指令未闭合。'); position = end + 2; continue; }
    let end = start + 1, quote = '';
    for (; end < text.length; end++) { const char = text[end]!; if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; }
    if (end >= text.length || quote) return fail('XML_INVALID', 'XML 标签未闭合。');
    const token = text.slice(start + 1, end), closing = token.startsWith('/'), self = /\/\s*$/u.test(token), match = token.match(closing ? /^\/([\p{L}_:][\p{L}\p{N}_.:\-]*)\s*$/u : /^([\p{L}_:][\p{L}\p{N}_.:\-]*)([\s\S]*)$/u);
    if (!match) return fail('XML_INVALID', 'XML 标签名称或声明无效。');
    const name = match[1]!;
    if (closing) { if (stack.pop() !== name) return fail('XML_INVALID', 'XML 结束标签与原始结构不符。'); }
    else {
      if (++elements > 100_000 || stack.length > 128 || !stack.length && ++roots > 1) return fail('XML_LIMIT', 'XML 多根或超过本次节点、深度预算。');
      let attributes = match[2]!.replace(/\/\s*$/u, ''); const names = new Set<string>();
      while (attributes.length) {
        if (!attributes.trim()) break;
        const found = attributes.match(/^\s+([\p{L}_:][\p{L}\p{N}_.:\-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u);
        if (!found || names.has(found[1]!) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/u.test(found[2] ?? found[3] ?? '')) return fail('XML_INVALID', 'XML 属性或实体引用无效。');
        names.add(found[1]!); attributes = attributes.slice(found[0].length);
      }
      if (!self) stack.push(name);
    }
    position = end + 1;
  }
  if (stack.length || roots !== 1) return fail('XML_INVALID', 'XML 原始标签未闭合或没有根。');
  const doc = new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) return fail('XML_INVALID', 'XML 结构无效。');
  return doc;
}
export function xmlNodes(node: Element | Document, localName: string): Element[] { return Array.from(node.querySelectorAll('*')).filter(element => element.localName.split(':').at(-1) === localName); }
export function xmlChildren(node: Element): Element[] { return Array.from(node.children); }
export function attr(node: Element, name: string): string | null {
  const found = Array.from(node.attributes).find(value => value.name === name || value.name.split(':').at(-1) === name);
  return found?.value ?? null;
}
export function xmlTree(doc: Document): JsonValue {
  let count = 0;
  const visit = (node: Node, depth: number): JsonValue => {
    if (++count > 100_000 || depth > 128) return fail('XML_LIMIT', 'XML 结构超过本次节点或深度预算。');
    if (node.nodeType === 1) {
      const element = node as Element;
      return { type: 'element', name: element.tagName, attributes: Array.from(element.attributes).map(value => ({ name: value.name, value: value.value })),
        children: Array.from(node.childNodes).map(child => visit(child, depth + 1)) };
    }
    return { type: node.nodeType === 4 ? 'cdata' : node.nodeType === 8 ? 'comment' : node.nodeType === 7 ? 'processing-instruction' : 'text', value: node.nodeValue ?? '' };
  };
  return visit(doc.documentElement, 0);
}

/** 保留数值词素、空白、重复键与成员顺序；不经 JSON.parse 的浮点数转换。 */
export function parseJsonNative(text: string): JsonValue {
  let cursor = 0, count = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/u.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const value = (path: string, depth: number): JsonValue => {
    whitespace(); const start = cursor;
    if (++count > 100_000 || depth > 128) return fail('JSON_LIMIT', 'JSON 超过本次节点或深度预算。');
    if (text[cursor] === '{') {
      cursor++; whitespace(); const members: JsonValue[] = [];
      if (text[cursor] !== '}') while (true) {
        whitespace(); if (text[cursor] !== '"') return fail('JSON_INVALID', 'JSON 对象键无效。');
        const key = string(); whitespace(); if (text[cursor++] !== ':') return fail('JSON_INVALID', 'JSON 缺少冒号。');
        members.push({ key: key.decoded, keyRaw: key.raw, value: value(path + '/' + key.decoded.replace(/~/gu, '~0').replace(/\//gu, '~1'), depth + 1) }); whitespace();
        if (text[cursor] !== ',') break; cursor++;
      }
      if (text[cursor++] !== '}') return fail('JSON_INVALID', 'JSON 对象未闭合。');
      return { type: 'object', path, offset: start, endOffset: cursor, members };
    }
    if (text[cursor] === '[') {
      cursor++; whitespace(); const items: JsonValue[] = [];
      if (text[cursor] !== ']') while (true) { items.push(value(path + '/' + items.length, depth + 1)); whitespace(); if (text[cursor] !== ',') break; cursor++; }
      if (text[cursor++] !== ']') return fail('JSON_INVALID', 'JSON 数组未闭合。');
      return { type: 'array', path, offset: start, endOffset: cursor, items };
    }
    if (text[cursor] === '"') { const parsed = string(); return { type: 'string', path, offset: start, endOffset: cursor, raw: parsed.raw, value: parsed.decoded }; }
    const token = text.slice(cursor).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u)?.[0];
    if (!token) return fail('JSON_INVALID', 'JSON 原始值词素无效。'); cursor += token.length;
    return { type: token === 'null' ? 'null' : token === 'true' || token === 'false' ? 'boolean' : 'number', path, offset: start, endOffset: cursor, raw: token };
  };
  const string = (): { raw: string; decoded: string } => {
    const start = cursor++; let escaped = false;
    while (cursor < text.length) { const char = text[cursor++]!; if (char === '"' && !escaped) { const raw = text.slice(start, cursor); try { return { raw, decoded: JSON.parse(raw) as string }; } catch { return fail('JSON_INVALID', 'JSON 字符串转义无效。'); } } escaped = char === '\\' && !escaped; }
    return fail('JSON_INVALID', 'JSON 字符串未闭合。');
  };
  const parsed = value('', 0); whitespace(); if (cursor !== text.length) return fail('JSON_INVALID', 'JSON 后有未读取内容。'); return parsed;
}
export function csvNative(text: string, delimiter = ','): JsonValue {
  if (![';', ',', '\t', '|'].includes(delimiter)) return fail('CSV_DELIMITER_INVALID', 'CSV 分隔符需要明确选择逗号、分号、制表符或竖线。');
  const records: JsonValue[] = []; let cursor = 0, line = 1, cells = 0;
  while (cursor < text.length) {
    const start = cursor, startLine = line, row: JsonValue[] = [];
    while (true) {
      const cellStart = cursor; let decoded = '';
      if (text[cursor] === '"') {
        cursor++; let closed = false;
        while (cursor < text.length) { const char = text[cursor++]!; if (char === '"') { if (text[cursor] === '"') { decoded += '"'; cursor++; } else { closed = true; break; } } else { decoded += char; if (char === '\n') line++; } }
        if (!closed || cursor < text.length && ![delimiter, '\r', '\n'].includes(text[cursor]!)) return fail('CSV_INVALID', 'CSV 引号字段未闭合或字段结束后含歧义字符。');
      } else {
        while (cursor < text.length && ![delimiter, '\r', '\n'].includes(text[cursor]!)) { if (text[cursor] === '"') return fail('CSV_INVALID', 'CSV 未引用字段内含引号。'); decoded += text[cursor++]!; }
      }
      if (++cells > 100_000) return fail('CSV_LIMIT', 'CSV 单元格超过本次预算。');
      row.push({ column: row.length + 1, value: decoded, raw: text.slice(cellStart, cursor), offset: cellStart, endOffset: cursor });
      if (text[cursor] !== delimiter) break; cursor++;
    }
    let ending = ''; if (text[cursor] === '\r') ending += text[cursor++]; if (text[cursor] === '\n') ending += text[cursor++]; if (ending) line++;
    records.push({ row: records.length + 1, line: startLine, offset: start, endOffset: cursor, lineEnding: ending, cells: row });
  }
  return { delimiter, headerInterpretation: 'none', offsetUnit: 'utf16-code-unit', records };
}
export function structuredText(bytes: Buffer, format: Format, encoding?: string, delimiter?: string): ConversionPayload {
  const decoded = decodeText(bytes, encoding), text = decoded.text;
  const native = format === 'csv' ? csvNative(text, delimiter) : format === 'json' ? parseJsonNative(text) : format === 'xml' ? xmlTree(parseXml(text)) : fail('STRUCTURED_UNSUPPORTED', '结构化转换支持 CSV、JSON、XML 和 XLSX。');
  return { status: 'complete', issues: [], content: { format, encoding: decoded.encoding, bomBytes: decoded.bomBytes, offsetUnit: 'utf16-code-unit', originalText: text, native } };
}

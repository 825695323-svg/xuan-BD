import type { MaterialAdapterDefinition, MaterialCell, MaterialChange, MaterialColumn, MaterialDeclaration, MaterialEvidence,
  MaterialFormat, MaterialInspectionInput, MaterialIssue, MaterialLimits, MaterialLocation, MaterialParserAdapter, MaterialPreview,
  MaterialScalar, MaterialSemantic, MaterialSemanticKey, MaterialTable } from '../../materials/contracts.js';

export const MATERIAL_INSPECTOR_VERSION = 'local-material-preview/1.3';
export const DEFAULT_MATERIAL_LIMITS: Readonly<MaterialLimits> = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxCharacters: 200_000,
  maxRows: 1000, maxColumns: 64, maxCellCharacters: 10_000, maxPreviewRows: 50, maxChanges: 500 });
export class MaterialError extends Error {
  constructor(readonly code: string, message: string, readonly location?: MaterialLocation) { super(message); this.name = 'MaterialError'; }
}
const aliases: Record<string, MaterialSemanticKey> = {
  unit: 'unit', 单位: 'unit', currency: 'currency', 币种: 'currency', period: 'period', frequency: 'period', 周期: 'period', 频率: 'period',
  adjustment: 'adjustment', 复权: 'adjustment', 复权方式: 'adjustment', timeAvailability: 'timeAvailability', timeavailability: 'timeAvailability', time_availability: 'timeAvailability', 时间可得性: 'timeAvailability',
  methodName: 'methodName', method: 'methodName', 方法: 'methodName', 方法名: 'methodName', parameters: 'parameters', 参数: 'parameters',
  dependencies: 'dependencies', 依赖: 'dependencies', version: 'version', 版本: 'version', source: 'source', 来源: 'source',
};
const dataKeys: MaterialSemanticKey[] = ['unit', 'currency', 'period', 'adjustment', 'timeAvailability'];
const toolKeys: MaterialSemanticKey[] = ['methodName', 'parameters', 'dependencies', 'version', 'source'];

export function materialLimits(input: Partial<MaterialLimits> = {}): MaterialLimits {
  const limits = { ...DEFAULT_MATERIAL_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_MATERIAL_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MATERIAL_LIMITS[key as keyof MaterialLimits]) {
      throw new MaterialError('INVALID_MATERIAL_LIMIT', '材料预算必须为正整数，且不能超过默认安全预算。');
    }
  }
  return limits;
}

export function validateDeclarations(input: unknown): MaterialDeclaration[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 50) throw new MaterialError('INVALID_DECLARATIONS', '用户声明须为最多 50 项的明确声明数组。');
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['key', 'value', 'scope', 'statement'].includes(key))
      || ![...dataKeys, ...toolKeys].includes(item.key) || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 500
      || typeof item.statement !== 'string' || !item.statement.trim() || item.statement.length > 2000
      || (item.scope !== undefined && (typeof item.scope !== 'string' || !item.scope.trim() || item.scope.length > 512))) {
      throw new MaterialError('INVALID_DECLARATIONS', '每项用户声明须提供有效语义键、值和原声明文字。');
    }
    return structuredClone(item) as MaterialDeclaration;
  });
}

export const DEFAULT_MATERIAL_ADAPTERS: readonly MaterialParserAdapter[] = Object.freeze([
  { id: 'utf8-csv', version: '1', capabilities: [{ category: 'data', format: 'csv' }], parse: ({ text, limits }) => parseCsv(text, limits) },
  { id: 'utf8-json-table', version: '1', capabilities: [{ category: 'data', format: 'json-table' }], parse: ({ text, limits }) => parseJsonTable(text, limits) },
  { id: 'utf8-readonly-text', version: '1', capabilities: [{ category: 'data', format: 'text' }, { category: 'tool', format: 'text' },
    { category: 'tool', format: 'csv' }, { category: 'tool', format: 'json-table' },
    { category: 'unclassified', format: 'text' }, { category: 'unclassified', format: 'csv' },
    { category: 'unclassified', format: 'json-table' }], parse: ({ text }) => ({ text: { original: text, proposed: text } }) },
]);

export function materialAdapterCatalog(adapters: readonly MaterialParserAdapter[] = DEFAULT_MATERIAL_ADAPTERS): MaterialAdapterDefinition[] {
  const ids = new Set<string>(), capabilities = new Set<string>();
  return adapters.map(adapter => {
    if (!adapter || typeof adapter.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(adapter.id)
      || typeof adapter.version !== 'string' || !adapter.version || adapter.version.length > 100 || typeof adapter.parse !== 'function'
      || !Array.isArray(adapter.capabilities) || !adapter.capabilities.length || ids.has(adapter.id)) {
      throw new MaterialError('INVALID_MATERIAL_ADAPTER', '材料适配器身份、版本或解析实现无效。');
    }
    ids.add(adapter.id);
    for (const capability of adapter.capabilities) {
      const key = `${capability.category}:${capability.format}`;
      if (!['unclassified', 'data', 'tool'].includes(capability.category) || !['csv', 'json-table', 'text'].includes(capability.format) || capabilities.has(key)) {
        throw new MaterialError('INVALID_MATERIAL_ADAPTER', '当前适配器只支持明确且不重复的 UTF-8 材料能力。');
      }
      capabilities.add(key);
    }
    return { id: adapter.id, version: adapter.version, capabilities: structuredClone(adapter.capabilities) };
  });
}

/** 只读原字节并生成待核对候选；不读写文件、不执行上传代码、不调用模型。 */
export function inspectMaterial(bytes: Uint8Array, input: MaterialInspectionInput): MaterialPreview {
  return inspectMaterialBytes(bytes, input, bytes?.byteLength);
}

/** 超出预览预算时只需要真实原件的魔数前缀，不能把局部内容作为完整预览。 */
export function inspectOversizedMaterial(prefix: Uint8Array, byteLength: number, input: MaterialInspectionInput): MaterialPreview {
  if (!Number.isSafeInteger(byteLength) || byteLength <= materialLimits(input.limits).maxBytes || prefix.byteLength < Math.min(12, byteLength)) {
    throw new MaterialError('INVALID_MATERIAL_INPUT', '超预算材料预览须提供原件的真实长度和魔数前缀。');
  }
  return inspectMaterialBytes(prefix, input, byteLength);
}

function inspectMaterialBytes(bytes: Uint8Array, input: MaterialInspectionInput, byteLength: number): MaterialPreview {
  if (!(bytes instanceof Uint8Array) || !['unclassified', 'data', 'tool'].includes(input.category) || typeof input.filename !== 'string' || !input.filename.trim()
    || input.filename.length > 512 || /[\u0000-\u001f\u007f]/u.test(input.filename) || (input.mediaType !== undefined && (typeof input.mediaType !== 'string' || input.mediaType.length > 256))) {
    throw new MaterialError('INVALID_MATERIAL_INPUT', '材料须提供原始字节、有效接收类别和文件名。');
  }
  const limits = materialLimits(input.limits), declarations = validateDeclarations(input.declaredMetadata);
  const adapters = input.adapters ?? DEFAULT_MATERIAL_ADAPTERS;
  materialAdapterCatalog(adapters);
  const format = detectFormat(bytes, input.filename, input.mediaType), adapter = adapters.find(item => item.capabilities.some(capability => capability.category === input.category && capability.format === format));
  const support = adapter ? 'supported' : format === 'unknown' ? 'unsupported' : 'needs_adapter';
  const preview: MaterialPreview = { category: input.category, format, support,
    reason: adapter ? '已选择明确能力的本地只读适配器。' : support === 'needs_adapter' ? '原件可保留；此格式需要独立解析适配器，当前未进行抽取或 OCR。' : '原件可保留；未识别受支持的格式能力。',
    adapter: adapter ? { id: adapter.id, version: adapter.version } : null, source: null, table: null, text: null,
    semantics: (input.category === 'unclassified' ? [] : input.category === 'data' ? dataKeys : toolKeys).map(key => ({ key, status: 'unknown', candidates: [] })),
    cleaning: { applied: false, changes: [], totalChanges: 0, changesTruncated: false },
    checks: { status: 'needs_confirmation', issues: [] },
    limitations: ['本地确定性预览只提供候选与证据，未正式入库、注册计算或验证方法有效性。', '缺失单位、币种、周期、复权和时间可得性不自动补齐；原值不转换日期、数值或价格尺度。'],
    pending: [] };
  for (const [declarationIndex, declaration] of declarations.entries()) addSemantic(preview.semantics, declaration.key, declaration.value,
    { source: 'user-declaration', quote: declaration.statement, declarationIndex }, declaration.scope);
  if (byteLength > limits.maxBytes) return blocked(preview, 'MATERIAL_BYTE_BUDGET', '原件超过本次字节预算，未进行解析。');
  if (!adapter) return finalize(preview);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return blocked(preview, 'INVALID_UTF8', '原件不是有效 UTF-8 文本；未替换非法字节或猜测编码。'); }
  preview.source = { encoding: 'utf-8', byteOrderMark: text.startsWith('\ufeff'), characterCount: text.length, lineCount: text.split(/\r\n|\r|\n/u).length, positionUnit: 'UTF-16' };
  if (text.length > limits.maxCharacters) return blocked(preview, 'MATERIAL_CHARACTER_BUDGET', '解码字符超过预算；原件保留但没有生成局部内容冒充完整预览。');
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.exec(text);
  if (control) return blocked(preview, 'UNSUPPORTED_TEXT_CONTROL', '文本含不支持的控制字符，未将二进制内容作为正文处理。', location(text, control.index, control.index + control[0].length));
  try {
    const parsed = adapter.parse({ text, limits });
    preview.table = parsed.table ?? null; preview.text = parsed.text ?? null;
    const changes = parsed.changes ?? [];
    preview.cleaning = { applied: false, changes: changes.slice(0, limits.maxChanges), totalChanges: changes.length, changesTruncated: changes.length > limits.maxChanges };
    if (preview.table) {
      for (const column of preview.table.columns) {
        const evidence: MaterialEvidence = { source: 'original', quote: column.quote, location: column.location };
        addSemantic(preview.semantics, 'field', column.name, evidence, `column:${column.location.field}`);
        for (const match of column.name.matchAll(/\b(unit|currency|period|adjustment|timeAvailability)\s*=\s*([^;\]\)]+)/gu)) {
          addSemantic(preview.semantics, aliases[match[1]!]!, match[2]!.trim(), evidence, `field:${column.proposedName}`);
        }
      }
      if (input.category === 'data') for (const [columnIndex, column] of preview.table.columns.entries()) {
        const key = aliases[column.proposedName] ?? aliases[column.proposedName.toLowerCase()];
        if (!key || !dataKeys.includes(key)) continue;
        for (const row of preview.table.rows) {
          const cell = row[columnIndex];
          if (!cell || cell.sourceType === 'missing' || cell.proposed === null || !String(cell.proposed).trim()) continue;
          addSemantic(preview.semantics, key, String(cell.proposed), { source: 'original', quote: cell.quote, location: cell.location }, `column:${column.proposedName}`);
        }
      }
      const names = new Set<string>();
      for (const column of preview.table.columns) {
        if (!column.proposedName || names.has(column.proposedName)) preview.checks.issues.push({ code: 'HEADER_CONFLICT', message: '清洗后表头为空或重复，不能作为结构化字段登记。', location: column.location });
        names.add(column.proposedName);
      }
      if (preview.table.previewTruncated) preview.limitations.push(`只展示前 ${limits.maxPreviewRows} 行，已核对结构的总数据行数为 ${preview.table.totalRows}。`);
      preview.table.rows = preview.table.rows.slice(0, limits.maxPreviewRows);
      preview.limitations.push('JSON 数字以精确原文字面量字符串展示；CSV 字段保留文本，不自动推断数值类型。');
    }
    if (preview.text) {
      if (input.category !== 'unclassified') collectTextSemantics(text, preview);
      preview.limitations.push('正文保持原样；代码、公式及其中的指令只作材料文本，不执行、导入、启用插件或改变规则。');
    }
  } catch (error) {
    if (!(error instanceof MaterialError)) throw error;
    return blocked(preview, error.code, error.message, error.location);
  }
  return finalize(preview);
}

function detectFormat(bytes: Uint8Array, filename: string, mediaType = ''): MaterialFormat {
  const head = [...bytes.subarray(0, 12)], ascii = String.fromCharCode(...head);
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (ascii.startsWith('PK\u0003\u0004') || ascii.startsWith('PK\u0005\u0006')) return /\.(xlsx|xlsm|ods)$/iu.test(filename) ? 'excel' : 'archive';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'excel';
  if ((head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') || (head[0] === 0xff && head[1] === 0xd8) || ascii.startsWith('GIF8')
    || ascii.startsWith('BM') || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') || ascii.startsWith('II*\u0000') || ascii.startsWith('MM\u0000*')) return 'image';
  const type = mediaType.split(';', 1)[0]!.trim().toLowerCase(), ext = filename.toLowerCase().split('.').at(-1);
  if (ext === 'csv' || type === 'text/csv') return 'csv';
  if (ext === 'json' || ['application/json', 'text/json'].includes(type)) return 'json-table';
  if (['txt', 'md', 'markdown', 'py', 'js', 'ts', 'sql', 'formula'].includes(ext ?? '') || ['text/plain', 'text/markdown', 'text/x-python', 'text/javascript', 'application/javascript', 'application/typescript', 'application/sql'].includes(type)) return 'text';
  if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext ?? '') || ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(type)) return 'excel';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic'].includes(ext ?? '') || type.startsWith('image/')) return 'image';
  // 这里只登记候选格式；真实音轨与时长由转录插件的本机解码检查核证。
  if (['wav', 'mp3', 'flac', 'aac', 'ogg', 'opus', 'm4a'].includes(ext ?? '') || type.startsWith('audio/')) return 'audio';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(ext ?? '') || type.startsWith('video/')) return 'video';
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext ?? '')) return 'archive';
  return 'unknown';
}

function location(text: string, start: number, end: number, extra: Partial<MaterialLocation> = {}): MaterialLocation {
  const prefix = text.slice(0, start), breaks = [...prefix.matchAll(/\r\n|\r|\n/gu)], last = breaks.at(-1);
  return { start, end, line: breaks.length + 1, column: start - (last ? last.index! + last[0].length : 0) + 1, ...extra };
}
function changed(cell: MaterialCell, changes: MaterialChange[]): void {
  if (cell.sourceType !== 'string') return;
  const value = String(cell.original), trimmed = value.trim();
  cell.proposed = trimmed || null;
  if (cell.proposed !== cell.original) changes.push({ operation: trimmed ? 'trim' : 'empty_to_null', original: cell.original, proposed: cell.proposed,
    location: cell.location, reason: trimmed ? '去除字段两端空白；不转换内容类型。' : '空字符串或仅空白字符串拟规范化为 null；不填补业务值。' });
}

function parseCsv(text: string, limits: MaterialLimits): { table: MaterialTable; changes: MaterialChange[] } {
  const locate = locationFactory(text);
  const records: MaterialCell[][] = []; let row: MaterialCell[] = [], i = text.startsWith('\ufeff') ? 1 : 0;
  if (i === text.length) throw new MaterialError('EMPTY_MATERIAL', 'CSV 没有表头。');
  while (i <= text.length) {
    const start = i; let value = '';
    if (text[i] === '"') {
      i++; let closed = false;
      while (i < text.length) {
        if (text[i] === '"') { if (text[i + 1] === '"') { value += '"'; i += 2; } else { i++; closed = true; break; } }
        else value += text[i++];
        if (value.length > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'CSV 字段超过字符预算。', locate(start, i));
      }
      if (!closed || (i < text.length && ![',', '\r', '\n'].includes(text[i]!))) throw new MaterialError('INVALID_CSV_QUOTES', 'CSV 引号未闭合或引号后有非分隔内容。', locate(start, i));
    } else {
      while (i < text.length && ![',', '\r', '\n'].includes(text[i]!)) {
        if (text[i] === '"') throw new MaterialError('INVALID_CSV_QUOTES', '未加引号字段中出现引号。', locate(i, i + 1));
        value += text[i++];
        if (value.length > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'CSV 字段超过字符预算。', locate(start, i));
      }
    }
    row.push({ sourceType: 'string', original: value, proposed: value, quote: text.slice(start, i), location: locate(start, i, { row: records.length + 1, field: row.length + 1 }) });
    if (row.length > limits.maxColumns) throw new MaterialError('COLUMN_BUDGET', 'CSV 列数超过预算。');
    const separator = text[i];
    if (separator === ',') { i++; continue; }
    records.push(row); row = [];
    if (records.length > limits.maxRows + 1) throw new MaterialError('ROW_BUDGET', 'CSV 数据行数超过预算。');
    if (i >= text.length) break;
    i += separator === '\r' && text[i + 1] === '\n' ? 2 : 1;
    if (i === text.length) break;
  }
  const headers = records.shift()!, changes: MaterialChange[] = [];
  const columns = headers.map(cell => {
    const name = String(cell.original), proposedName = name.trim();
    if (name !== proposedName) changes.push({ operation: 'trim', original: name, proposed: proposedName, location: cell.location, reason: '拟去除字段名两端空白。' });
    return { name, proposedName, quote: cell.quote, location: cell.location };
  });
  for (const record of records) {
    if (record.length !== columns.length) throw new MaterialError('RAGGED_CSV', 'CSV 行列数不一致；不补列、不丢列。', record[0]?.location);
    record.forEach(cell => changed(cell, changes));
  }
  return { table: { columns, rows: records, totalRows: records.length, previewTruncated: records.length > limits.maxPreviewRows }, changes };
}

interface JsonNode { type: MaterialCell['sourceType'] | 'object' | 'array'; start: number; end: number; value?: MaterialScalar; entries?: { key: JsonNode; value: JsonNode }[]; items?: JsonNode[] }
function parseJsonTable(text: string, limits: MaterialLimits): { table: MaterialTable; changes: MaterialChange[] } {
  const locate = locationFactory(text);
  let i = text.startsWith('\ufeff') ? 1 : 0, nodes = 0;
  const skip = () => { while (/[\x20\t\r\n]/u.test(text[i] ?? '\u0000')) i++; };
  const fail = () => { throw new MaterialError('INVALID_JSON', 'JSON 语法无效；未自动修复或执行正文。', locate(i, Math.min(i + 1, text.length))); };
  const parse = (depth: number): JsonNode => {
    if (depth > 16 || ++nodes > limits.maxRows * limits.maxColumns * 3 + 100) throw new MaterialError('JSON_STRUCTURE_BUDGET', 'JSON 嵌套或节点超过结构预算。');
    skip(); const start = i, char = text[i];
    if (char === '"') {
      i++; let escaped = false;
      while (i < text.length) { const next = text[i++]; if (!escaped && next === '"') {
        let value: string; try { value = JSON.parse(text.slice(start, i)) as string; } catch { return fail(); }
        if (value.length > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'JSON 字符串超过字段字符预算。', locate(start, i));
        return { type: 'string', value, start, end: i };
      } if (!escaped && next === '\\') escaped = true; else escaped = false; }
      return fail();
    }
    if (char === '[' || char === '{') {
      i++; skip(); const items: JsonNode[] = [], entries: { key: JsonNode; value: JsonNode }[] = [], keys = new Set<string>(), end = char === '[' ? ']' : '}';
      if (text[i] !== end) while (true) {
        if (char === '[') items.push(parse(depth + 1));
        else {
          skip(); if (text[i] !== '"') return fail(); const key = parse(depth + 1); skip();
          if (text[i++] !== ':') return fail();
          if (keys.has(String(key.value))) throw new MaterialError('DUPLICATE_JSON_KEY', 'JSON 对象含重复字段，未用后值覆盖原值。', locate(key.start, key.end));
          keys.add(String(key.value)); entries.push({ key, value: parse(depth + 1) });
        }
        skip(); if (text[i] === end) break; if (text[i++] !== ',') return fail();
      }
      i++; return { type: char === '[' ? 'array' : 'object', start, end: i, ...char === '[' ? { items } : { entries } };
    }
    for (const [token, value] of [['null', null], ['true', true], ['false', false]] as const) if (text.startsWith(token, i)) { i += token.length; return { type: value === null ? 'null' : 'boolean', value, start, end: i }; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(i));
    if (number) { i += number[0].length; if (number[0].length > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'JSON 数字字面量超过字符预算。'); return { type: 'number', value: number[0], start, end: i }; }
    return fail();
  };
  const root = parse(0); skip(); if (i !== text.length) fail();
  if (root.type !== 'array' || root.items!.some(row => row.type !== 'object')) throw new MaterialError('JSON_TABLE_REQUIRED', 'JSON 表格仅支持行对象数组；其他结构需适配器。');
  if (root.items!.length > limits.maxRows) throw new MaterialError('ROW_BUDGET', 'JSON 表格行数超过预算。');
  const columns: MaterialColumn[] = [], columnKeys = new Set<string>(), changes: MaterialChange[] = [];
  for (const [rowIndex, row] of root.items!.entries()) for (const entry of row.entries!) {
    const name = String(entry.key.value);
    if (!columnKeys.has(name)) {
      columnKeys.add(name);
      const loc = locate(entry.key.start, entry.key.end, { row: rowIndex + 1, field: columns.length + 1, jsonPath: `$[${rowIndex}][${JSON.stringify(name)}]` });
      const proposedName = name.trim(); columns.push({ name, proposedName, quote: text.slice(entry.key.start, entry.key.end), location: loc });
      if (name !== proposedName) changes.push({ operation: 'trim', original: name, proposed: proposedName, location: loc, reason: '拟去除字段名两端空白。' });
      if (columns.length > limits.maxColumns) throw new MaterialError('COLUMN_BUDGET', 'JSON 表格列数超过预算。');
    }
    if (['object', 'array'].includes(entry.value.type)) throw new MaterialError('NESTED_JSON_CELL', 'JSON 表格单元格仅支持标量；嵌套值未自动展开。', locate(entry.value.start, entry.value.end));
  }
  const rows = root.items!.map((row, rowIndex) => columns.map((column, columnIndex): MaterialCell => {
    const node = row.entries!.find(entry => entry.key.value === column.name)?.value;
    const loc = locate(node?.start ?? row.start, node?.end ?? row.end, { row: rowIndex + 1, field: columnIndex + 1, jsonPath: `$[${rowIndex}][${JSON.stringify(column.name)}]` });
    if (!node) {
      changes.push({ operation: 'align_missing_key', original: null, proposed: null, location: loc, reason: '原行没有此键；拟结构对齐为 null，缺失事实仍由 missing 类型保留。' });
      return { sourceType: 'missing', original: null, proposed: null, location: loc, quote: '' };
    }
    const cell: MaterialCell = { sourceType: node.type as MaterialCell['sourceType'], original: node.value!, proposed: node.value!, quote: text.slice(node.start, node.end), location: loc };
    changed(cell, changes); return cell;
  }));
  return { table: { columns, rows, totalRows: rows.length, previewTruncated: rows.length > limits.maxPreviewRows }, changes };
}

function addSemantic(semantics: MaterialSemantic[], key: MaterialSemanticKey, value: string, evidence: MaterialEvidence, scope?: string): void {
  if (!value) return;
  let semantic = semantics.find(item => item.key === key && item.scope === scope);
  if (!semantic) { semantic = { key, ...scope ? { scope } : {}, status: 'unknown', candidates: [] }; semantics.push(semantic); }
  let candidate = semantic.candidates.find(item => item.value === value);
  if (!candidate) { candidate = { value, evidence: [] }; semantic.candidates.push(candidate); }
  candidate.evidence.push(evidence);
  semantic.status = semantic.candidates.length > 1 && !scope?.startsWith('column:') && !['field', 'methodName', 'parameters', 'dependencies'].includes(key) ? 'conflict' : 'candidate';
}
function collectTextSemantics(text: string, preview: MaterialPreview): void {
  for (const match of text.matchAll(/^[\t ]*(?:[#*>-][\t ]*)?([A-Za-z\u4e00-\u9fff]+)[\t ]*[:：=][\t ]*([^\r\n]+)$/gmu)) {
    const key = aliases[match[1]!];
    if (key && (preview.category === 'data' ? dataKeys : toolKeys).includes(key)) addSemantic(preview.semantics, key, match[2]!.trim(),
      { source: 'original', quote: match[0], location: location(text, match.index!, match.index! + match[0].length) });
  }
  if (preview.category !== 'tool') return;
  for (const match of text.matchAll(/^[\t ]*(?:async[\t ]+)?(?:def|function)[\t ]+([A-Za-z_$][\w$]*)[\t ]*\(([^\r\n()]*)\)/gmu)) {
    const evidence: MaterialEvidence = { source: 'original', quote: match[0], location: location(text, match.index!, match.index! + match[0].length) };
    addSemantic(preview.semantics, 'methodName', match[1]!, evidence);
    if (match[2]!.trim()) addSemantic(preview.semantics, 'parameters', match[2]!.trim(), evidence, `method:${match[1]}`);
  }
  for (const match of text.matchAll(/^[\t ]*(?:from[\t ]+([A-Za-z_][\w.]*)[\t ]+import\b[^\r\n]*|import[\t ]+([A-Za-z_][\w.]*))/gmu)) {
    addSemantic(preview.semantics, 'dependencies', (match[1] ?? match[2])!, { source: 'original', quote: match[0], location: location(text, match.index!, match.index! + match[0].length) });
  }
}
function blocked(preview: MaterialPreview, code: string, message: string, loc?: MaterialLocation): MaterialPreview {
  preview.checks.issues.push({ code, message, ...loc ? { location: loc } : {} });
  preview.checks.status = 'blocked';
  return finalize(preview);
}
function finalize(preview: MaterialPreview): MaterialPreview {
  preview.semantics = preview.semantics.filter(item => !(item.status === 'unknown' && !item.scope && preview.semantics.some(other => other.key === item.key && other.scope && other.candidates.length)));
  const unknown = preview.semantics.filter(item => item.status === 'unknown'), conflicts = preview.semantics.filter(item => item.status === 'conflict');
  preview.pending = [...unknown.map(item => `待确认 ${item.scope ? `${item.scope} ` : ''}${item.key}：材料未提供明确证据。`),
    ...conflicts.map(item => `冲突 ${item.scope ? `${item.scope} ` : ''}${item.key}：存在多个不同候选，请核对原文和声明。`),
    ...preview.semantics.filter(item => item.scope?.startsWith('column:') && item.candidates.length > 1)
      .map(item => `待确认 ${item.scope} ${item.key}：原列含多种逐行值，未认定为整表统一语义。`)];
  if (preview.support !== 'supported') preview.pending.unshift('待装配并验收相应解析适配器，原件尚未形成语义预览。');
  if (preview.category === 'unclassified') preview.pending.unshift('材料用途待当前会话代理根据原文与自然语言需求判断；未声明为数据或工具。');
  if (preview.checks.issues.length) preview.checks.status = 'blocked';
  else preview.checks.status = preview.pending.length || preview.support !== 'supported' ? 'needs_confirmation' : 'preview_only';
  return preview;
}
function locationFactory(text: string): (start: number, end: number, extra?: Partial<MaterialLocation>) => MaterialLocation {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/gu)) starts.push(match.index! + match[0].length);
  return (start, end, extra = {}) => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (starts[middle]! <= start) low = middle; else high = middle; }
    return { start, end, line: low + 1, column: start - starts[low]! + 1, ...extra };
  };
}

import type { ConversionPayload } from '../../../contracts/conversion.js';
import { wfdSha256 } from '../../../adapters/database/wfd-transport.js';

export const XLSX_TABLE_ADAPTER_VERSION = 'bd-xlsx-explicit-rectangle/1';
export const XLSX_TABLE_LIMITS = Object.freeze({ maxRows: 5000, maxColumns: 256, maxCells: 100_000, maxJsonBytes: 64_000_000,
  maxEvidenceBytes: 64_000_000 });

export type XlsxColumnType = 'string' | 'decimal_string' | 'safe_integer' | 'boolean';
export interface XlsxTableSelection {
  sheetName: string;
  headerRow: number;
  firstDataRow: number;
  lastDataRow: number;
  firstColumn: string;
  lastColumn: string;
  columns: { column: string; header: string; name: string; type?: XlsxColumnType }[];
}
export interface XlsxCellEvidence {
  address: string;
  location: { part: string; sheet: string; cell: string };
  storageType: string;
  rawStorage: string | null;
  resolvedSharedString: string | null;
  sharedStringRawXml: string | null;
  inlineString: string | null;
  styleIndex: string | null;
  rawXml: string;
}
export interface XlsxSelectionEvidence {
  adapter: { id: 'bd-xlsx-explicit-rectangle'; version: '1' };
  parserVersion: '1';
  sourceSha256: string;
  sheetName: string;
  sheetPart: string;
  headerRow: number;
  firstDataRow: number;
  lastDataRow: number;
  firstColumn: string;
  lastColumn: string;
  columns: { column: string; header: string; name: string; type?: XlsxColumnType; cell: XlsxCellEvidence }[];
  rows: { row: number; cells: XlsxCellEvidence[] }[];
  selectedRows: number;
  selectedCells: number;
  /** 投影 JSON 中的字符偏移属于派生产物；原工作簿位置只能由上面的 part/sheet/cell 查回。 */
  projectionLocation: 'derived-json-only';
}
export interface XlsxTableProjection {
  jsonBytes: Buffer;
  jsonSha256: string;
  planTypes: Record<string, XlsxColumnType>;
  evidence: XlsxSelectionEvidence;
}

interface NativeCell {
  address: string | null;
  location: { part: string; sheet: string | null; cell: string | null };
  storageType: string;
  rawStorage: string | null;
  resolvedSharedString: string | null;
  inlineString: string | null;
  formula: unknown | null;
  styleIndex: string | null;
  rawXml: string;
}
interface NativeSheet {
  name: string | null;
  part: string;
  rows: { row: string | null; cells: NativeCell[] }[];
  mergedRanges: (string | null)[];
}
interface NativeWorkbook { format: string; sheets: NativeSheet[]; sharedStrings: { value: string; rawXml: string }[] }

export class XlsxTableError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'XlsxTableError'; }
}
const fail = (code: string, message: string): never => { throw new XlsxTableError(code, message); };
const cellRef = /^([A-Z]{1,3})([1-9]\d*)$/u;
const numberLexeme = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const columnTypes: readonly XlsxColumnType[] = ['string', 'decimal_string', 'safe_integer', 'boolean'];

function columnNumber(column: string): number {
  if (!/^[A-Z]{1,3}$/u.test(column)) return fail('XLSX_SELECTION', '工作簿列须使用 A 至 XFD 的大写列地址。');
  let index = 0;
  for (const letter of column) index = index * 26 + letter.charCodeAt(0) - 64;
  if (index > 16_384) return fail('XLSX_SELECTION', '工作簿列超出 XFD。');
  return index;
}
function address(value: string): { column: number; row: number } {
  const match = cellRef.exec(value);
  if (!match) return fail('XLSX_CELL_ADDRESS', '原生单元格缺少明确有效地址。');
  const row = Number(match[2]), column = columnNumber(match[1]!);
  if (!Number.isSafeInteger(row) || row > 1_048_576) return fail('XLSX_CELL_ADDRESS', '原生单元格行号超出工作簿范围。');
  return { column, row };
}
function evidence(cell: NativeCell, sheet: NativeSheet, sharedRawXml: string | null): XlsxCellEvidence {
  if (!cell.address || cell.location?.part !== sheet.part || cell.location.sheet !== sheet.name || cell.location.cell !== cell.address
    || typeof cell.rawXml !== 'string' || !cell.rawXml) return fail('XLSX_LOCATION', '原生单元格位置或原文片段不一致。');
  return { address: cell.address, location: { part: sheet.part, sheet: sheet.name!, cell: cell.address }, storageType: cell.storageType,
    rawStorage: cell.rawStorage, resolvedSharedString: cell.resolvedSharedString, sharedStringRawXml: sharedRawXml,
    inlineString: cell.inlineString, styleIndex: cell.styleIndex, rawXml: cell.rawXml };
}
function cellValue(cell: NativeCell, sheet: NativeSheet, native: NativeWorkbook): { value: string | boolean; evidence: XlsxCellEvidence } {
  if (cell.formula !== null) return fail('XLSX_FORMULA', `选区含公式 ${cell.address}；不采用缓存值或计算公式。`);
  const type = cell.storageType;
  if (type === 's') {
    const raw = cell.rawStorage;
    if (raw === null || !/^\d+$/u.test(raw) || cell.inlineString !== null) return fail('XLSX_SHARED_STRING', `共享字符串 ${cell.address} 的索引不明确。`);
    if (raw.length > 15) return fail('XLSX_SHARED_STRING', `共享字符串 ${cell.address} 的索引超出安全范围。`);
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index >= native.sharedStrings.length) return fail('XLSX_SHARED_STRING', `共享字符串 ${cell.address} 缺失。`);
    const entry = native.sharedStrings[index];
    if (!entry || typeof entry.value !== 'string' || typeof entry.rawXml !== 'string' || cell.resolvedSharedString !== entry.value)
      return fail('XLSX_SHARED_STRING', `共享字符串 ${cell.address} 的原文与解析值不一致。`);
    return { value: entry.value, evidence: evidence(cell, sheet, entry.rawXml) };
  }
  if (type === 'inlineStr') {
    if (cell.inlineString === null || cell.rawStorage !== null || cell.resolvedSharedString !== null)
      return fail('XLSX_CELL_VALUE', `内联字符串 ${cell.address} 原值不明确。`);
    return { value: cell.inlineString, evidence: evidence(cell, sheet, null) };
  }
  if (cell.inlineString !== null || cell.resolvedSharedString !== null || cell.rawStorage === null)
    return fail('XLSX_CELL_VALUE', `单元格 ${cell.address} 的原值缺失或有冲突。`);
  if (type === 'b') {
    if (cell.rawStorage !== '0' && cell.rawStorage !== '1') return fail('XLSX_CELL_VALUE', `布尔单元格 ${cell.address} 原值不明确。`);
    return { value: cell.rawStorage === '1', evidence: evidence(cell, sheet, null) };
  }
  if (type === 'n') {
    if (cell.rawStorage.length > 1024 || !numberLexeme.test(cell.rawStorage)) return fail('XLSX_NUMBER', `数值单元格 ${cell.address} 不是受支持的原始十进制词面。`);
    return { value: cell.rawStorage, evidence: evidence(cell, sheet, null) };
  }
  if (type === 'str') return { value: cell.rawStorage, evidence: evidence(cell, sheet, null) };
  return fail('XLSX_CELL_TYPE', `单元格 ${cell.address} 的原生类型 ${type} 未声明可投影；错误、日期和未知类型不猜测。`);
}

/** 校验并复制用户显式选择；计划冻结与实际投影共用同一套边界。 */
export function readXlsxTableSelection(value: unknown): XlsxTableSelection {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object'
    && !Array.isArray(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item));
  if (!record(value) || Object.keys(value).some(key => !['sheetName', 'headerRow', 'firstDataRow', 'lastDataRow', 'firstColumn', 'lastColumn', 'columns'].includes(key)))
    return fail('XLSX_SELECTION', '工作簿选区只接受明确工作表、表头、行列范围及逐列声明。');
  const s = value;
  if (typeof s.sheetName !== 'string' || !s.sheetName || s.sheetName.length > 255
    || !Number.isSafeInteger(s.headerRow) || !Number.isSafeInteger(s.firstDataRow)
    || !Number.isSafeInteger(s.lastDataRow) || (s.headerRow as number) < 1 || (s.headerRow as number) >= (s.firstDataRow as number)
    || (s.lastDataRow as number) < (s.firstDataRow as number) || (s.lastDataRow as number) > 1_048_576
    || (s.lastDataRow as number) - (s.firstDataRow as number) + 1 > XLSX_TABLE_LIMITS.maxRows
    || !Array.isArray(s.columns) || typeof s.firstColumn !== 'string' || typeof s.lastColumn !== 'string')
    return fail('XLSX_SELECTION', '须明确工作表、表头行、1–5000 个连续数据行及列矩形。');
  const first = columnNumber(s.firstColumn), last = columnNumber(s.lastColumn), width = last - first + 1;
  if (width < 1 || width > XLSX_TABLE_LIMITS.maxColumns || s.columns.length !== width
    || width * ((s.lastDataRow as number) - (s.firstDataRow as number) + 1) > XLSX_TABLE_LIMITS.maxCells)
    return fail('XLSX_SELECTION_LIMIT', '所选列或单元格超出本次有界矩形预算。');
  const headers = new Set<string>(), names = new Set<string>(), columns: XlsxTableSelection['columns'] = [];
  for (const [index, column] of s.columns.entries()) {
    if (!record(column) || Object.keys(column).some(key => !['column', 'header', 'name', 'type'].includes(key))
      || typeof column.column !== 'string' || columnNumber(column.column) !== first + index
      || typeof column.header !== 'string' || !column.header.trim() || column.header.length > 1024
      || typeof column.name !== 'string' || !column.name.trim() || column.name.length > 256
      || column.type !== undefined && !columnTypes.includes(column.type as XlsxColumnType))
      return fail('XLSX_SELECTION', '逐列须按原列顺序给出非空精确表头、输出列名和受支持的可选类型。');
    if (headers.has(column.header)) return fail('XLSX_DUPLICATE_HEADER', '选区原表头重复，不能用后值覆盖。');
    if (names.has(column.name)) return fail('XLSX_DUPLICATE_FIELD', '投影列名重复，不能用后值覆盖。');
    headers.add(column.header); names.add(column.name);
    columns.push({ column: column.column, header: column.header, name: column.name,
      ...(column.type === undefined ? {} : { type: column.type as XlsxColumnType }) });
  }
  return { sheetName: s.sheetName, headerRow: s.headerRow as number, firstDataRow: s.firstDataRow as number,
    lastDataRow: s.lastDataRow as number, firstColumn: s.firstColumn, lastColumn: s.lastColumn, columns };
}

/** 只处理调用者已完成原生转换的受信内容；不读取文件、不计算公式、不解释日期或单位。 */
export function projectXlsxNativeSelection(payload: ConversionPayload, sourceSha256: string,
  selection: XlsxTableSelection): XlsxTableProjection {
  if (payload.status !== 'complete' || payload.issues.length || !/^[0-9a-f]{64}$/u.test(sourceSha256))
    return fail('XLSX_CONVERSION', '需要完整原生 XLSX 转换及实际原件 SHA-256。');
  const native = (payload.content as { native?: unknown })?.native as NativeWorkbook | undefined;
  if (native?.format !== 'xlsx' || !Array.isArray(native.sheets) || !Array.isArray(native.sharedStrings))
    return fail('XLSX_CONVERSION', '转换内容不是完整 XLSX 原生工作簿。');
  const s = readXlsxTableSelection(selection);
  const first = columnNumber(s.firstColumn), last = columnNumber(s.lastColumn), width = last - first + 1;
  const planTypes: Record<string, XlsxColumnType> = Object.create(null);
  for (const column of s.columns) if (column.type !== undefined) planTypes[column.name] = column.type;
  const matches = native.sheets.filter(sheet => sheet.name === s.sheetName);
  if (matches.length !== 1) return fail('XLSX_SHEET', '所选工作表不存在或名称不唯一。');
  const sheet = matches[0]!;
  if (!sheet.part || !Array.isArray(sheet.rows) || !Array.isArray(sheet.mergedRanges)) return fail('XLSX_SHEET', '工作表原生结构缺失。');
  for (const range of sheet.mergedRanges) {
    if (typeof range !== 'string') return fail('XLSX_MERGE', '合并范围不明确。');
    const [start, end, extra] = range.split(':');
    if (extra || !start || !end) return fail('XLSX_MERGE', '合并范围不明确。');
    const a = address(start), b = address(end);
    if (a.column > b.column || a.row > b.row) return fail('XLSX_MERGE', '合并范围无效。');
    if (a.column <= last && b.column >= first && (a.row <= s.headerRow && b.row >= s.headerRow
      || a.row <= s.lastDataRow && b.row >= s.firstDataRow)) return fail('XLSX_MERGE', '选区与合并单元格相交，不能展开或猜填。');
  }
  const rows = new Map<number, Map<number, NativeCell>>();
  let priorRow = 0;
  for (const row of sheet.rows) {
    // 数组/共享公式的 ref 可覆盖没有自身 <f> 的缓存格；核整张表的声明而非只看选中格。
    for (const cell of row.cells) if (cell.formula !== null) {
      const formula = cell.formula as { expression?: string; attributes?: { name: string; value: string }[] };
      if (!Array.isArray(formula.attributes)) return fail('XLSX_FORMULA', '公式范围元数据不明确，不能采用缓存值。');
      const refs = formula.attributes.filter(attribute => attribute.name === 'ref');
      const kind = formula.attributes.find(attribute => attribute.name === 't')?.value;
      if (refs.length > 1 || (!refs.length && (kind === 'array' || kind === 'shared' && formula.expression)))
        return fail('XLSX_FORMULA', '数组或共享公式缺少唯一覆盖范围，不能判断缓存格资格。');
      if (refs.length) {
        const match = /^([A-Z]{1,3}[1-9]\d*)(?::([A-Z]{1,3}[1-9]\d*))?$/u.exec(refs[0]!.value);
        if (!match) return fail('XLSX_FORMULA', '公式覆盖范围无效，不能采用缓存值。');
        const a = address(match[1]!), b = address(match[2] ?? match[1]!);
        if (a.column > b.column || a.row > b.row) return fail('XLSX_FORMULA', '公式覆盖范围逆序。');
        if (a.column <= last && b.column >= first && (a.row <= s.headerRow && b.row >= s.headerRow
          || a.row <= s.lastDataRow && b.row >= s.firstDataRow)) return fail('XLSX_FORMULA', '选区被公式覆盖，不采用公式缓存值。');
      }
    }
    if (!row.row || !/^[1-9]\d*$/u.test(row.row) || !Number.isSafeInteger(Number(row.row)) || Number(row.row) > 1_048_576)
      return fail('XLSX_ROW_ADDRESS', '工作表存在未明确定位的原生行。');
    const number = Number(row.row);
    if (number <= priorRow) return fail('XLSX_ROW_ORDER', '工作表原生行号重复或逆序。');
    priorRow = number;
    if (number !== s.headerRow && (number < s.firstDataRow || number > s.lastDataRow)) continue;
    if (!Array.isArray(row.cells)) return fail('XLSX_ROW_ADDRESS', '所选行没有完整原生单元格列表。');
    const cells = new Map<number, NativeCell>();
    for (const cell of row.cells) {
      if (!cell.address) return fail('XLSX_CELL_ADDRESS', `所选第 ${number} 行含未定位单元格。`);
      const point = address(cell.address);
      if (point.row !== number || cells.has(point.column)) return fail('XLSX_CELL_ADDRESS', `所选第 ${number} 行含错位或重复单元格。`);
      cells.set(point.column, cell);
    }
    rows.set(number, cells);
  }
  const get = (row: number, col: number): NativeCell => {
    const cell = rows.get(row)?.get(col);
    if (!cell) return fail('XLSX_NON_RECTANGULAR', `所选矩形缺少第 ${row} 行第 ${col} 列原生单元格。`);
    return cell;
  };
  const columns = s.columns.map((declared, index) => {
    const actual = cellValue(get(s.headerRow, first + index), sheet, native);
    if (typeof actual.value !== 'string' || actual.value !== declared.header)
      return fail('XLSX_HEADER_MISMATCH', `第 ${index + 1} 列原表头与显式声明不一致。`);
    return { column: declared.column, header: declared.header, name: declared.name,
      ...(declared.type ? { type: declared.type } : {}), cell: actual.evidence };
  });
  const data: Record<string, string | boolean>[] = [], rowEvidence: XlsxSelectionEvidence['rows'] = [];
  for (let row = s.firstDataRow; row <= s.lastDataRow; row++) {
    const output: Record<string, string | boolean> = Object.create(null), cells: XlsxCellEvidence[] = [];
    for (const [index, column] of s.columns.entries()) {
      const actual = cellValue(get(row, first + index), sheet, native);
      output[column.name] = actual.value; cells.push(actual.evidence);
    }
    data.push(output); rowEvidence.push({ row, cells });
  }
  const jsonBytes = Buffer.from(JSON.stringify(data), 'utf8');
  if (jsonBytes.length > XLSX_TABLE_LIMITS.maxJsonBytes) return fail('XLSX_PROJECTION_LIMIT', '投影 JSON 超出本次 64 MB 预算。');
  const evidenceRecord: XlsxSelectionEvidence = { adapter: { id: 'bd-xlsx-explicit-rectangle', version: '1' }, parserVersion: '1', sourceSha256,
    sheetName: s.sheetName, sheetPart: sheet.part, headerRow: s.headerRow, firstDataRow: s.firstDataRow, lastDataRow: s.lastDataRow,
    firstColumn: s.firstColumn, lastColumn: s.lastColumn, columns, rows: rowEvidence,
    selectedRows: data.length, selectedCells: width * data.length, projectionLocation: 'derived-json-only' };
  if (Buffer.byteLength(JSON.stringify(evidenceRecord)) > XLSX_TABLE_LIMITS.maxEvidenceBytes)
    return fail('XLSX_EVIDENCE_LIMIT', '原生位置和词面证据超出本次 64 MB 预算。');
  return { jsonBytes, jsonSha256: wfdSha256(jsonBytes), planTypes, evidence: evidenceRecord };
}

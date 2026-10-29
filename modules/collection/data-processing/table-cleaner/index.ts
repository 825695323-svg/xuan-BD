import type { MaterialCell, MaterialLimits, MaterialLocation, MaterialTable } from '../../materials/contracts.js';
import type { AppliedMaterialChange, MaterialDateFormat, MaterialSemanticProposal, SemanticProcessedTable, SemanticQuestion } from '../../materials/semantic-contracts.js';
import { DEFAULT_MATERIAL_ADAPTERS, MaterialError } from '../material-inspector/index.js';

export function parseSemanticMaterialTable(text: string, format: string, proposal: MaterialSemanticProposal, limits: MaterialLimits): MaterialTable {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail('UNSUPPORTED_TEXT_CONTROL', '表格含不支持的控制字符，未进行清洗。');
  let offset = 0;
  if (format === 'csv' && proposal.table) {
    const starts = [0]; for (const match of text.matchAll(/\r\n|\r|\n/gu)) starts.push(match.index! + match[0].length);
    offset = starts[proposal.table.headerLine - 1] ?? -1;
    const lineEnd = text.slice(offset).search(/\r\n|\r|\n/u), end = lineEnd === -1 ? text.length : offset + lineEnd;
    const evidence = proposal.table.headerEvidence;
    if (offset < 0 || evidence.start! > offset + (text[offset] === '\ufeff' ? 1 : 0) || evidence.end! < end) fail('MATERIAL_HEADER_EVIDENCE', '表头行号与覆盖该原件行的证据不一致。');
  } else if (format === 'json-table' && proposal.table && proposal.table.headerLine !== 1) fail('MATERIAL_HEADER_EVIDENCE', 'JSON 表格不能通过 CSV 表头行跳过正文。');
  const adapter = DEFAULT_MATERIAL_ADAPTERS.find(a => a.capabilities.some(c => c.category === 'data' && c.format === format));
  const table = adapter!.parse({ text: text.slice(offset), limits }).table!;
  const locate = locator(text);
  const rebase = (cell: MaterialCell | { location: MaterialLocation }) => {
    const old = cell.location;
    cell.location = { ...old, ...locate(old.start + offset, old.end + offset) };
  };
  table.columns.forEach(rebase); table.rows.forEach(row => row.forEach(rebase));
  for (const item of [...(proposal.table?.fields ?? []), ...proposal.cleaning.dates, ...proposal.cleaning.decimals]) if (item.column > table.columns.length) fail('MATERIAL_FIELD_MAPPING', '清洗或映射引用不存在的字段。');
  return table;
}
/** 实际材料清洗的共享纯函数；问题出现时整体不采用，不产生部分清洗结果。 */
export function applySemanticTableCleaning(table: MaterialTable, proposal: MaterialSemanticProposal, limits: MaterialLimits): {
  table: SemanticProcessedTable | null; changes: AppliedMaterialChange[]; questions: SemanticQuestion[];
} {
  const questions: SemanticQuestion[] = [];
  const changes: AppliedMaterialChange[] = [];
  const appliedTable = { columns: table.columns.map(column => ({ original: column.name, applied: column.name, location: column.location, quote: column.quote })),
    rows: table.rows.map(row => row.map(cell => ({ original: cell.original, applied: cell.original, sourceType: cell.sourceType, location: cell.location, quote: cell.quote }))), totalRows: table.totalRows };
  for (const [index, column] of appliedTable.columns.entries()) {
    let name = proposal.cleaning.trim ? column.original.trim() : column.original;
    if (name !== column.original) changes.push({ operation: 'trim', original: column.original, applied: name, location: column.location, quote: column.quote });
    const mapping = proposal.table?.fields.find(field => field.column === index + 1);
    if (mapping) {
      if (!mapping.evidence.some(e => e.source === 'original' && e.start! <= column.location.start && e.end! >= column.location.end)) {
        fail('MATERIAL_FIELD_EVIDENCE', '字段映射须引用对应原件表头，不得只引用无关文字。');
      }
      if (name !== mapping.name) changes.push({ operation: 'field_mapping', original: name, applied: mapping.name, location: column.location, quote: column.quote });
      name = mapping.name;
    }
    column.applied = name;
  }
  const columnNames = appliedTable.columns.map(c => c.applied);
  if (columnNames.some(name => !name.trim()) || new Set(columnNames).size !== columnNames.length) {
    return { table: null, changes: [], questions: [{ id: 'header-conflict', prompt: '清洗或映射后字段名为空或重复，请明确字段映射。' }] };
  }
  const change = (cell: (typeof appliedTable.rows)[number][number], operation: AppliedMaterialChange['operation'], value: typeof cell.applied) => {
    if (cell.applied !== value || operation === 'align_missing_key') changes.push({ operation, original: cell.applied, applied: value, location: cell.location, quote: cell.quote });
    cell.applied = value;
  };
  for (const row of appliedTable.rows) for (const [index, cell] of row.entries()) {
    if (cell.sourceType === 'missing') change(cell, 'align_missing_key', null);
    if (typeof cell.applied === 'string' && proposal.cleaning.trim) change(cell, 'trim', cell.applied.trim());
    if (cell.applied === '' && proposal.cleaning.emptyToNull) change(cell, 'empty_to_null', null);
    if (cell.applied === null) continue;
    const dateRule = proposal.cleaning.dates.find(rule => rule.column === index + 1);
    if (dateRule) {
      const normalized = typeof cell.applied === 'string' ? normalizeDate(cell.applied, dateRule.format) : null;
      if (normalized === null) questions.push({ id: `date-value:${index + 1}`, prompt: `第 ${index + 1} 列存在不符合 ${dateRule.format} 的日期；没有部分执行。` });
      else change(cell, 'date_normalize', normalized);
    }
    if (proposal.cleaning.decimals.some(rule => rule.column === index + 1)) {
      const normalized = typeof cell.applied === 'string' ? normalizeDecimal(cell.applied) : null;
      if (normalized === null) questions.push({ id: `decimal-value:${index + 1}`, prompt: `第 ${index + 1} 列存在非十进制字面量；没有猜测分隔符、单位或科学记数法。` });
      else change(cell, 'decimal_normalize', normalized);
    }
  }
  if (changes.length > limits.maxChanges) questions.push({ id: 'change-budget', prompt: `实际变化超过 ${limits.maxChanges} 项预算，未执行；请缩小材料。` });
  if (questions.length) return { table: null, changes: [], questions: [...new Map(questions.map(q => [q.id, q])).values()] };
  return { table: appliedTable, changes, questions: [] };
}

function normalizeDate(value: string, format: MaterialDateFormat): string | null {
  const pattern = format === 'YYYYMMDD' ? /^(\d{4})(\d{2})(\d{2})$/u : format === 'YYYY-MM-DD' ? /^(\d{4})-(\d{2})-(\d{2})$/u : format === 'YYYY/MM/DD' ? /^(\d{4})\/(\d{2})\/(\d{2})$/u : /^(\d{2})\/(\d{2})\/(\d{4})$/u;
  const match = pattern.exec(value); if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day] = format === 'DD/MM/YYYY' ? [parts[2]!, parts[1]!, parts[0]!] : format === 'MM/DD/YYYY' ? [parts[2]!, parts[0]!, parts[1]!] : parts;
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  if (!year || month! < 1 || month! > 12 || day! < 1 || day! > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1]!) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function normalizeDecimal(value: string): string | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return null;
  const negative = value.startsWith('-'), unsigned = value.replace(/^[+-]/u, ''), [integer = '', fraction = ''] = unsigned.split('.');
  const whole = integer.replace(/^0+/u, '') || '0', tail = fraction.replace(/0+$/u, ''), normalized = `${whole}${tail ? `.${tail}` : ''}`;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}
export function locator(text: string): (start: number, end: number) => MaterialLocation {
  const starts = [0]; for (const match of text.matchAll(/\r\n|\r|\n/gu)) starts.push(match.index! + match[0].length);
  return (start, end) => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (starts[mid]! <= start) low = mid; else high = mid - 1; }
    return { start, end, line: low + 1, column: start - starts[low]! + 1 };
  };
}

function fail(code: string, message: string): never { throw new MaterialError(code, message); }

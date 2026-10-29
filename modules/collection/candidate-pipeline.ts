import { DEFAULT_MATERIAL_ADAPTERS } from './data-processing/material-inspector/index.js';
import type { MaterialCell, MaterialLimits, MaterialLocation, MaterialScalar } from './materials/contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

export const CANDIDATE_PIPELINE_VERSION = 'bd-declared-table/2';
export const CANDIDATE_LIMITS = Object.freeze({ maxOutputs: 16, maxOriginals: 32, maxObjectBytes: 268_435_456,
  maxStructuredBytes: 67_108_864, maxRows: 100_000, maxFields: 256, chunkBytes: 1_048_576 });
export const CANDIDATE_STAGE_VERSIONS = Object.freeze({ parse: 'bd-source-parsers/1', clean: 'bd-explicit-clean/1',
  structure: 'bd-explicit-types/1', annotate: 'bd-explicit-constants/1', check: 'bd-table-integrity/1' });
export interface CandidateTablePlan {
  materialId: string; format: 'csv' | 'json';
  fieldMapping?: Record<string, string>;
  types?: Record<string, 'string' | 'safe_integer' | 'decimal_string' | 'boolean' | 'binary64_hex'>;
  trim?: string[]; emptyToNull?: string[];
  annotations?: Record<string, string | number | boolean | null>;
}
/** 一个原值单元格的受管证据；original 永不因清洗或类型转换被覆盖。 */
export interface CandidateCellEvidence {
  original: MaterialScalar; value: MaterialScalar | number; sourceType: MaterialCell['sourceType'];
  quote: string; location: MaterialLocation;
}
export interface ParsedCandidateTable {
  kind: 'parsed-table'; format: 'csv' | 'json'; source_sha256: string;
  adapter: { id: string; version: string }; source_columns: string[]; columns: string[]; fields: string[];
  mapping: Record<string, string>; types: CandidateTablePlan['types']; trim: string[]; emptyToNull: string[];
  annotations: Record<string, string | number | boolean | null>; rows: CandidateCellEvidence[][]; total_rows: number;
}
export interface CleanedCandidateTable extends Omit<ParsedCandidateTable, 'kind'> {
  kind: 'cleaned-table'; changes: WfdRecord[]; changes_total: number; change_window_limit: number;
}
export interface StructuredCandidateTable extends Omit<CleanedCandidateTable, 'kind'> { kind: 'structured-table' }
export interface AnnotatedCandidateTable extends Omit<StructuredCandidateTable, 'kind'> { kind: 'annotated-table' }
export interface CandidateCheckEvidence {
  version: string; fields: string[]; row_count: number; structured_sha256: string; changes_total: number;
  check_scope: string[]; gaps: string[]; sources: { source_sha256: string; row_count: number }[];
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const sha = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const scalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value);
const typeNames = ['string', 'safe_integer', 'decimal_string', 'boolean', 'binary64_hex'] as const;

/**
 * 解析步骤：只读冻结原字节，产出带原值、原类型、原句与原位置的行；不做业务语义判断。
 * 结果可独立持久化，供后续步骤在重开进程后继续使用。
 */
export function parseTableSource(bytes: Uint8Array, plan: CandidateTablePlan): ParsedCandidateTable {
  if (!['csv', 'json'].includes(plan.format) || bytes.byteLength > CANDIDATE_LIMITS.maxStructuredBytes) fail('CANDIDATE_PARSE_BUDGET', '表源格式或本次 64 MiB 解析预算不符。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('CANDIDATE_ENCODING', '表源不是严格 UTF-8；须先显式转换并保留转换证据。'); }
  const adapter = DEFAULT_MATERIAL_ADAPTERS.find(item => item.id === (plan.format === 'csv' ? 'utf8-csv' : 'utf8-json-table'))!;
  const limits: MaterialLimits = { maxBytes: CANDIDATE_LIMITS.maxStructuredBytes, maxCharacters: CANDIDATE_LIMITS.maxStructuredBytes,
    maxRows: CANDIDATE_LIMITS.maxRows, maxColumns: CANDIDATE_LIMITS.maxFields, maxCellCharacters: 1_048_576,
    maxPreviewRows: CANDIDATE_LIMITS.maxRows, maxChanges: 1000 };
  const parsed = adapter.parse({ text, limits }).table;
  if (!parsed || !parsed.rows.length) fail('CANDIDATE_EMPTY_TABLE', '完整表源为空，未生成虚构记录。');
  const sourceNames = parsed!.columns.map(column => column.name), mapping = plan.fieldMapping ?? {};
  if (new Set(sourceNames).size !== sourceNames.length || sourceNames.some(name => !name)) fail('CANDIDATE_FIELDS', '原始字段名必须非空且唯一；请先提供明确修订来源。');
  if (Object.keys(mapping).some(name => !sourceNames.includes(name)) || Object.values(mapping).some(name => typeof name !== 'string' || !name || name.length > 256)) fail('CANDIDATE_MAPPING', '映射须引用实际原列及有效目标字段。');
  const names = sourceNames.map(name => mapping[name] ?? name);
  if (new Set(names).size !== names.length) fail('CANDIDATE_MAPPING', '多个原列不能覆盖到同一个目标字段。');
  const annotations = plan.annotations ?? {};
  if (!isWfdRecord(annotations) || Object.entries(annotations).some(([name, value]) => !name || names.includes(name) || !scalar(value))) fail('CANDIDATE_ANNOTATIONS', '标注只接受不覆盖原字段的明确常量标量。');
  const fields = [...names, ...Object.keys(annotations)];
  if (fields.length > CANDIDATE_LIMITS.maxFields || Object.keys(plan.types ?? {}).some(name => !names.includes(name))
    || Object.values(plan.types ?? {}).some(type => !typeNames.includes(type as typeof typeNames[number]))
    || [...(plan.trim ?? []), ...(plan.emptyToNull ?? [])].some(name => !names.includes(name))) fail('CANDIDATE_RULES', '规则必须逐项绑定实际目标字段，且不得超过字段预算。');
  const rows = parsed!.rows.map(row => row.map(cell => {
    const original = originalCell(cell);
    return { original, value: original, sourceType: cell.sourceType, quote: cell.quote, location: cell.location };
  }));
  return { kind: 'parsed-table', format: plan.format, source_sha256: wfdSha256(bytes), adapter: { id: adapter.id, version: adapter.version },
    source_columns: sourceNames, columns: names, fields, mapping: { ...mapping }, types: { ...(plan.types ?? {}) },
    trim: [...(plan.trim ?? [])], emptyToNull: [...(plan.emptyToNull ?? [])], annotations: { ...annotations },
    rows, total_rows: rows.length };
}

/** 清洗步骤：只执行逐字段声明的 trim / empty_to_null，逐项保存原值与变更位置。 */
export function cleanCandidateTable(parsed: ParsedCandidateTable, rules?: { trim?: string[]; emptyToNull?: string[] }): CleanedCandidateTable {
  const trim = rules?.trim ?? parsed.trim, emptyToNull = rules?.emptyToNull ?? parsed.emptyToNull;
  const changes: WfdRecord[] = []; let changesTotal = 0;
  const rows = parsed.rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const name = parsed.columns[columnIndex]!; let value = cell.value;
    if (typeof value === 'string' && trim.includes(name)) value = value.trim();
    if (value === '' && emptyToNull.includes(name)) value = null;
    if (value !== cell.value) {
      changesTotal++;
      if (changes.length < 1000) changes.push({ row: rowIndex + 1, field: name, original: cell.original,
        before: cell.value, after: value, location: cell.location });
    }
    return { ...cell, value };
  }));
  return { ...parsed, kind: 'cleaned-table', trim, emptyToNull, rows, changes, changes_total: changesTotal, change_window_limit: 1000 };
}

/** 结构化步骤：按显式类型与 JSON 数字原文字面量转换，先核无损精度，绝不静默舍入。 */
export function structureCandidateTable(cleaned: CleanedCandidateTable, types?: CandidateTablePlan['types']): StructuredCandidateTable {
  const applied = types ?? cleaned.types;
  const rows = cleaned.rows.map(row => row.map((cell, columnIndex) => {
    const name = cleaned.columns[columnIndex]!;
    return { ...cell, value: typedCell(cell.value, applied?.[name], cell.sourceType) };
  }));
  return { ...cleaned, kind: 'structured-table', types: applied, rows };
}

/** 标注步骤：只加入不与原列重名的明确常量，不覆盖原值。 */
export function annotateCandidateTable(structured: StructuredCandidateTable, annotations?: Record<string, string | number | boolean | null>): AnnotatedCandidateTable {
  const applied = annotations ?? structured.annotations;
  return { ...structured, kind: 'annotated-table', annotations: { ...applied }, fields: [...structured.columns, ...Object.keys(applied)] };
}

/**
 * 核对步骤：合并已完成结构产物，核字段一致、行数、有限标量与输出摘要。
 * 只证明结构完整性；来源真实性、业务语义、单位和 174 条业务规则仍是明确缺口。
 */
export function checkCandidateTables(tables: AnnotatedCandidateTable[]): { bytes: Buffer; rows: WfdRecord[]; evidence: CandidateCheckEvidence } {
  if (!tables.length) fail('CANDIDATE_CHECK_SCOPE', '核对步骤至少需要一个已完成结构产物。');
  const fieldsOf = (table: AnnotatedCandidateTable) => [...table.columns, ...Object.keys(table.annotations)];
  const first = tables[0]!, fields = fieldsOf(first);
  const rows: WfdRecord[] = [];
  for (const table of tables) {
    if (canonicalWfdJson(fieldsOf(table)) !== canonicalWfdJson(fields)) fail('CANDIDATE_CHECK_FIELDS', '多个表源的最终字段不一致；未擅自取并集或补列。');
    if (!table.rows.length) fail('CANDIDATE_CHECK_SCOPE', '结构产物没有数据行，不能形成完整表核对证明。');
    for (const row of table.rows) {
      if (row.length !== table.columns.length) fail('CANDIDATE_CHECK_FIELDS', '结构产物的行与字段数量不一致。');
      const object: WfdRecord = {};
      table.columns.forEach((name, index) => { object[name] = row[index]!.value; });
      for (const [name, value] of Object.entries(table.annotations)) object[name] = value;
      for (const value of Object.values(object)) if (!scalar(value)) fail('CANDIDATE_CHECK_VALUE', '结构产物含非有限标量，未形成通过结果。');
      rows.push(object);
      if (rows.length > CANDIDATE_LIMITS.maxRows) fail('CANDIDATE_ROW_BUDGET', '合并后的完整表超过行数预算。');
    }
  }
  const bytes = Buffer.from(canonicalWfdJson({ rows }));
  if (bytes.byteLength > CANDIDATE_LIMITS.maxStructuredBytes) fail('CANDIDATE_OUTPUT_BUDGET', '完整结构结果超过 64 MiB；没有截断提交。');
  return { bytes, rows, evidence: { version: CANDIDATE_STAGE_VERSIONS.check, fields: [...fields], row_count: rows.length,
    structured_sha256: wfdSha256(bytes), changes_total: tables.reduce((total, table) => total + (Number.isFinite(table.changes_total) ? table.changes_total : 0), 0),
    check_scope: ['strict_utf8_decoding', 'table_shape', 'unique_nonempty_fields', 'explicit_field_mapping', 'explicit_scalar_types',
      'finite_scalars', 'decimal_precision_roundtrip', 'row_budget', 'output_digest'],
    gaps: ['未验证来源真实性或来源声明', '未验证业务语义、单位、时间与对象身份', '未验证产品合同、历史覆盖或正式准入',
      '未执行或伪造未实现的 174 条业务规则'],
    sources: tables.map(table => ({ source_sha256: table.source_sha256, row_count: table.total_rows })) } };
}

/** 兼容既有候选路径：同一纯函数链一次完成五步，步骤仍由独立可调用函数产生。 */
export function prepareCandidateTable(bytes: Uint8Array, plan: CandidateTablePlan) {
  const parsed = parseTableSource(bytes, plan);
  const cleaned = cleanCandidateTable(parsed, { trim: plan.trim ?? [], emptyToNull: plan.emptyToNull ?? [] });
  const structured = structureCandidateTable(cleaned, plan.types ?? {});
  const annotated = annotateCandidateTable(structured, plan.annotations ?? {});
  const checked = checkCandidateTables([annotated]);
  const steps: WfdRecord[] = [
    { stage: 'parse', version: parsed.adapter.version + ':' + parsed.adapter.id, input_sha256: sha({ sha256: wfdSha256(bytes), format: plan.format }),
      output_sha256: sha(parsed), parameters: { fieldMapping: parsed.mapping } },
    { stage: 'clean', version: CANDIDATE_STAGE_VERSIONS.clean, input_sha256: sha(parsed), output_sha256: sha(cleaned),
      parameters: { trim: parsed.trim, emptyToNull: parsed.emptyToNull } },
    { stage: 'structure', version: CANDIDATE_STAGE_VERSIONS.structure, input_sha256: sha(cleaned), output_sha256: sha(structured),
      parameters: { types: parsed.types } },
    { stage: 'annotate', version: CANDIDATE_STAGE_VERSIONS.annotate, input_sha256: sha(structured), output_sha256: sha(annotated),
      parameters: parsed.annotations },
    { stage: 'check', version: CANDIDATE_STAGE_VERSIONS.check, input_sha256: sha(annotated), output_sha256: checked.evidence.structured_sha256,
      parameters: { row_count: checked.evidence.row_count, fields: checked.evidence.fields, check_scope: checked.evidence.check_scope, gaps: checked.evidence.gaps } },
  ];
  return { bytes: checked.bytes, rows: checked.rows, steps, evidence: { version: CANDIDATE_PIPELINE_VERSION, source_sha256: wfdSha256(bytes),
    plan, fields: checked.evidence.fields, row_count: checked.evidence.row_count, changes: cleaned.changes,
    change_window_limit: 1000, check: checked.evidence, steps } };
}

function originalCell(cell: MaterialCell): MaterialScalar {
  if (cell.sourceType === 'missing') return fail('CANDIDATE_MISSING_KEY', 'JSON 记录存在缺键，须提供显式补缺规则或修订原件；未自动填 null。');
  return cell.original; // JSON 数字原文字面量保留到显式类型步骤，字符串规则不会先丢精度。
}
function decimal(value: string): string {
  if (value.length > 1024 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) return fail('CANDIDATE_NUMBER', '明确数值规则遇到非 JSON 数字字面量或超长数值。');
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value)!;
  const exponent = Number(match[4] ?? 0), fraction = match[3] ?? '';
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) return fail('CANDIDATE_NUMBER_PRECISION', '数值指数超出本次数值展开预算。');
  let digits = (match[2]! + fraction).replace(/^0+/, '') || '0';
  let scale = fraction.length - exponent;
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1) || '0'; scale--; }
  if (digits === '0') return '0';
  if (scale <= 0) digits += '0'.repeat(-scale);
  else if (scale >= digits.length) digits = '0.' + '0'.repeat(scale - digits.length) + digits;
  else digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  return match[1] + digits;
}
function numeric(value: string, integer: boolean) {
  const normalized = decimal(value), number = Number(value);
  if (!Number.isFinite(number) || decimal(String(number)) !== normalized || Number.isInteger(number) && !Number.isSafeInteger(number)
    || integer && !Number.isSafeInteger(number)) return fail('CANDIDATE_NUMBER_PRECISION', '原数字不能无损落入本次有限数字/安全整数范围；请显式保留 string 或 decimal_string。');
  return number;
}
function typedCell(value: MaterialScalar | number, type?: string, sourceType?: string): MaterialScalar | number {
  if (value === null) return value;
  if (type === 'string') return String(value);
  if (type === 'decimal_string') { const result = decimal(String(value)); if (result.length > 128) return fail('CANDIDATE_NUMBER_PRECISION', '完整十进制字符串超过数据库128字符预算。'); return result; }
  if (type === 'safe_integer') return typeof value === 'string' || typeof value === 'number' ? numeric(String(value), true) : fail('CANDIDATE_TYPE', '布尔值不能隐式转为整数。');
  if (type === 'binary64_hex') {
    if (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)) { const number = Buffer.from(value, 'hex').readDoubleBE(); if (Number.isFinite(number)) return value; }
    const number = numeric(String(value), false), bytes = Buffer.alloc(8); bytes.writeDoubleBE(number); return bytes.toString('hex');
  }
  if (type === 'boolean' && (typeof value === 'boolean' || value === 'true' || value === 'false')) return value === true || value === 'true';
  if (type) return fail('CANDIDATE_TYPE', '明确类型规则与原值不符。');
  return sourceType === 'number' ? numeric(String(value), false) : value;
}

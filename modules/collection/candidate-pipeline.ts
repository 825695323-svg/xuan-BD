import { readFileSync } from 'node:fs';
import { DEFAULT_MATERIAL_ADAPTERS } from './data-processing/material-inspector/index.js';
import type { MaterialCell, MaterialLimits, MaterialLocation, MaterialScalar, MaterialTable } from './materials/contracts.js';
import { candidateCsvRecords } from './candidate-csv-records.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { verifyProductionRows } from './production-verifier.js';
import { officeNative } from '../../platform/capabilities/conversion/office.js';
import { MAX_SOURCE } from '../../platform/capabilities/conversion/formats.js';
import { projectXlsxNativeSelection, type XlsxTableSelection, type XlsxSelectionEvidence } from './data-processing/xlsx-table.js';
import { projectSourceReportedTable, type CandidateSourceProjection } from './source-reported-table.js';
import { normalizeNumericLexeme, readNumericFormat, type NumericFormat } from './data-processing/numeric-format.js';
import { projectXbrlTable, type XbrlSelection } from './data-processing/xbrl-table.js';
import { projectNecessaryText, type NecessaryTextSelection } from './data-processing/necessary-text.js';
import { adapterColumnType, adapterConfigDigest, adapterMaterialTable, adapterParseEvidence, adapterTypeCompatible,
  parseEndpointSource, type AdapterBindingRef, type FrozenAdapterBinding } from './endpoint-adapter.js';

export const CANDIDATE_PIPELINE_VERSION = 'bd-declared-table/4';
export const CANDIDATE_LIMITS = Object.freeze({ maxOutputs: 16, maxOriginals: 32, maxObjectBytes: 268_435_456,
  maxStructuredBytes: 67_108_864, maxRows: 100_000, maxFields: 256, chunkBytes: 1_048_576 });
export const CANDIDATE_SELECTION_LIMITS = Object.freeze({ maxSelectedRows: 5000, maxScannedRows: 2_000_000 });
/**
 * 独立处理函数实现摘要：覆盖解析/投影/数值规则，不定义自动执行顺序。
 * 端点适配重放把它作为实现证据，任一实现变化都会使旧重放失效。
 */
export function candidateImplementationDigest(): string {
  const files = ['./candidate-pipeline.ts', './candidate-csv-records.ts', './source-reported-table.ts',
    './data-processing/xlsx-table.ts', './data-processing/numeric-format.ts', './data-processing/xbrl-table.ts',
    './data-processing/necessary-text.ts', './data-processing/financial-pdf.ts', './data-processing/financial-fixed.ts',
    './materials/contracts.ts', '../../adapters/database/wfd-transport.ts'].map(path => readFileSync(new URL(path, import.meta.url)));
  return wfdSha256(Buffer.concat(files));
}
export const CANDIDATE_STAGE_VERSIONS = Object.freeze({ parse: 'bd-source-parsers/3', clean: 'bd-explicit-clean/1',
  structure: 'bd-explicit-types/2', annotate: 'bd-explicit-constants/1', check: 'bd-table-integrity/2' });
export interface CandidateCsvSelection {
  predicate: { column: string; equals: string };
  maxSelectedRows: number;
  maxScannedRows: number;
}
export interface CandidateCsvSelectionEvidence extends CandidateCsvSelection {
  selectionComplete: true; scannedRows: number; selectedRows: number; excludedRows: number;
  sourceBytes: number; sourceSha256: string;
}
export interface CandidateTablePlan {
  materialId: string; format: 'csv' | 'json' | 'xlsx' | 'xbrl' | 'text' | 'pdf' | 'financial-fixed';
  /** 已采用端点适配：请求只提供引用，宿主在规范化时解析并冻结完整配置。 */
  sourceAdapter?: AdapterBindingRef | FrozenAdapterBinding;
  /** 本材料实际取得回执摘要；规范化时用于匹配核对，不原样持久化。 */
  sourceContext?: unknown;
  /** 已有来源任务编号；宿主从该任务结果解析取得回执并核文件关联。 */
  sourceReceiptTaskId?: string;
  financialCalculation?: import('./data-processing/financial-fixed.js').FinancialCalculation;
  /** 宿主在计划建立时冻结；外部readTables参数不接收此字段。 */
  financialReaderBinding?: string;
  xbrlSelection?: XbrlSelection;
  necessaryTextSelection?: NecessaryTextSelection;
  pdfSelection?: import('./data-processing/financial-pdf.js').FinancialPdfSelection;
  numericFormats?: Record<string, NumericFormat>;
  xlsxSelection?: XlsxTableSelection;
  selection?: CandidateCsvSelection;
  sourceProjection?: CandidateSourceProjection;
  fieldMapping?: Record<string, string>;
  types?: Record<string, 'string' | 'safe_integer' | 'decimal_string' | 'boolean' | 'binary64_hex'>;
  trim?: string[]; emptyToNull?: string[];
  annotations?: Record<string, string | number | boolean | null>;
}
/** 一个原值单元格的受管证据；original 永不因清洗或类型转换被覆盖。 */
export interface CandidateCellEvidence {
  original: MaterialScalar; value: MaterialScalar | number; sourceType: MaterialCell['sourceType'];
  quote: string; location: MaterialLocation;
  /** 适配声明的单位换算：原值、换算值与依据逐格保留，original 永不改成换算值。 */
  conversion?: { source: string; target: string; factor: string; basis: string };
  projection?: { version: CandidateSourceProjection['version']; operation: 'business_key' | 'date_start' | 'date_end' | 'minute_label_start' | 'minute_label_end' | 'value_state';
    sources: { column: string; original: MaterialScalar; quote: string; location: MaterialLocation }[] };
}
export interface ParsedCandidateTable {
  kind: 'parsed-table'; format: CandidateTablePlan['format']; source_sha256: string;
  numericFormats?: Record<string, NumericFormat>;
  financial_evidence?: WfdRecord;
  necessary_text_evidence?: WfdRecord;
  /** 端点适配身份、载体、字符集、单位换算依据与缺口；随步骤产物持久化。 */
  adapter_evidence?: WfdRecord;
  source_projection?: { kind: 'xlsx-explicit-selection'; json_sha256: string; location_scope: 'derived-json-utf16'; evidence: XlsxSelectionEvidence };
  adapter: { id: string; version: string }; source_columns: string[]; columns: string[]; fields: string[];
  mapping: Record<string, string>; types: CandidateTablePlan['types']; trim: string[]; emptyToNull: string[];
  annotations: Record<string, string | number | boolean | null>; rows: CandidateCellEvidence[][]; total_rows: number;
  selection?: CandidateCsvSelectionEvidence;
  sourceProjection?: CandidateSourceProjection;
}
export interface CleanedCandidateTable extends Omit<ParsedCandidateTable, 'kind'> {
  kind: 'cleaned-table'; changes: WfdRecord[]; changes_total: number; change_window_limit: number;
}
export interface CandidateTypeChange {
  operation: 'decimal_lexeme' | 'type_conversion'; row: number; field: string;
  original: MaterialScalar; before: MaterialScalar | number; after: MaterialScalar | number;
  quote: string; location: MaterialLocation;
}
export interface StructuredCandidateTable extends Omit<CleanedCandidateTable, 'kind'> {
  kind: 'structured-table'; type_changes: CandidateTypeChange[]; type_changes_total: number;
  decimal_lexeme_changes_total: number; type_change_window_limit: number; type_changes_truncated: boolean;
}
export interface AnnotatedCandidateTable extends Omit<StructuredCandidateTable, 'kind'> { kind: 'annotated-table' }
export interface CandidateCheckEvidence {
  version: string; fields: string[]; row_count: number; structured_sha256: string; changes_total: number;
  type_changes_total: number; decimal_lexeme_changes_total: number;
  check_scope: string[]; gaps: string[]; sources: { source_sha256: string; row_count: number; selection?: CandidateCsvSelectionEvidence }[];
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const scalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value);
const typeNames = ['string', 'safe_integer', 'decimal_string', 'boolean', 'binary64_hex'] as const;
const CHANGE_WINDOW_LIMIT = 1000;

/**
 * 解析步骤：只读冻结原字节，产出带原值、原类型、原句与原位置的行；不做业务语义判断。
 * 结果可独立持久化，供后续步骤在重开进程后继续使用。
 */
export function parseTableSource(bytes: Uint8Array, plan: CandidateTablePlan): ParsedCandidateTable {
  if (plan.format === 'xbrl' || plan.format === 'text') {
    if (plan.selection || plan.xlsxSelection || plan.sourceProjection || Object.keys(plan.fieldMapping ?? {}).length || plan.pdfSelection)
      fail('CANDIDATE_RULES', '财报标记及必要文字专用投影不接受其他格式选区或字段重命名。');
    const projection = plan.format === 'xbrl' ? projectXbrlTable(bytes, plan.xbrlSelection!) : projectNecessaryText(bytes, plan.necessaryTextSelection!);
    const parsed = parseTableSource(projection.jsonBytes, { ...plan, format: 'json', xbrlSelection: undefined, necessaryTextSelection: undefined });
    return { ...parsed, format: plan.format, source_sha256: wfdSha256(bytes),
      adapter: { id: plan.format === 'xbrl' ? 'bd-xbrl-numeric' : 'bd-necessary-business-paragraph', version: '1' },
      ...(plan.format === 'xbrl' ? { financial_evidence: projection.evidence as unknown as WfdRecord }
        : { necessary_text_evidence: projection.evidence as unknown as WfdRecord }) };
  }
  if (plan.format === 'pdf' || plan.format === 'financial-fixed') fail('CANDIDATE_PDF_ASYNC', 'PDF财报/固定财务变换须由受管处理计划异步读取；不通过同步表解析绕过。');
  if (plan.xbrlSelection || plan.necessaryTextSelection || plan.pdfSelection) fail('CANDIDATE_RULES', '专用投影规则与表源格式不一致。');
  if (plan.format === 'xlsx') {
    if (!plan.xlsxSelection || plan.selection) fail('XLSX_SELECTION_REQUIRED', '工作簿须明确工作表、表头、行列范围；不接受 CSV 选件规则。');
    if (bytes.byteLength > MAX_SOURCE) fail('CANDIDATE_PARSE_BUDGET', '工作簿超过原生转换原件预算；未放大转换保护。');
    const sourceSha256 = wfdSha256(bytes);
    const projection = projectXlsxNativeSelection(officeNative(Buffer.from(bytes), 'xlsx', new AbortController().signal), sourceSha256, plan.xlsxSelection!);
    const types: NonNullable<CandidateTablePlan['types']> = Object.assign(Object.create(null), Object.fromEntries(Object.entries(projection.planTypes).map(([name, type]) => [plan.fieldMapping && Object.hasOwn(plan.fieldMapping, name) ? plan.fieldMapping[name]! : name, type])));
    for (const [name, type] of Object.entries(plan.types ?? {})) {
      if (types[name] && types[name] !== type) fail('CANDIDATE_RULES', '工作簿选区类型与后续结构类型声明冲突。');
      types[name] = type;
    }
    const parsed = parseTableSource(projection.jsonBytes, { ...plan, format: 'json', xlsxSelection: undefined, types });
    return { ...parsed, format: 'xlsx', source_sha256: sourceSha256,
      adapter: { id: 'xlsx-explicit-selection', version: projection.evidence.parserVersion },
      source_projection: { kind: 'xlsx-explicit-selection', json_sha256: projection.jsonSha256,
        location_scope: 'derived-json-utf16', evidence: projection.evidence } };
  }
  if (plan.xlsxSelection !== undefined) fail('XLSX_SELECTION_FORMAT', '工作簿选区只能用于明确 XLSX 原件。');
  if (plan.sourceAdapter) return parseAdapterTable(bytes, plan);
  const selection = readCsvSelection(plan), byteBudget = selection ? CANDIDATE_LIMITS.maxObjectBytes : CANDIDATE_LIMITS.maxStructuredBytes;
  if (!['csv', 'json'].includes(plan.format) || bytes.byteLength > byteBudget) fail('CANDIDATE_PARSE_BUDGET', selection
    ? 'CSV 选件原件超过本次 256 MiB 扫描字节预算。' : '表源格式或本次 64 MiB 解析预算不符。');
  const sourceSha256 = selection ? wfdSha256(bytes) : null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: !!selection }).decode(bytes); } catch { return fail('CANDIDATE_ENCODING', '表源不是严格 UTF-8；须先显式转换并保留转换证据。'); }
  const defaultAdapter = DEFAULT_MATERIAL_ADAPTERS.find(item => item.id === (plan.format === 'csv' ? 'utf8-csv' : 'utf8-json-table'))!;
  const limits: MaterialLimits = { maxBytes: byteBudget, maxCharacters: byteBudget,
    maxRows: CANDIDATE_LIMITS.maxRows, maxColumns: CANDIDATE_LIMITS.maxFields, maxCellCharacters: 1_048_576,
    maxPreviewRows: CANDIDATE_LIMITS.maxRows, maxChanges: 1000 };
  const selected = selection ? selectCsvRecords(text, selection, limits, bytes.byteLength, sourceSha256!) : null;
  const parsed = selected?.table ?? defaultAdapter.parse({ text, limits }).table;
  if (selection && wfdSha256(bytes) !== sourceSha256) fail('CANDIDATE_SOURCE_CHANGED', '完整扫描期间原字节摘要发生变化，未声明选件完成。');
  const adapter = selection ? { id: 'utf8-csv-exact-selection', version: '1' } : defaultAdapter;
  return finishParsedTable(parsed, wfdSha256(bytes), adapter, plan, selected ? { selection: selected.evidence } : {});
}

/**
 * 端点适配分支：同一算子按已采用配置解析三种载体。
 * 只有冻结配置与摘要一致才执行；未采用、摘要变化或载体不符都在此阻断，不回退到通用 CSV/JSON 解析。
 */
function parseAdapterTable(bytes: Uint8Array, plan: CandidateTablePlan): ParsedCandidateTable {
  const binding = plan.sourceAdapter as FrozenAdapterBinding;
  if (!('config' in binding) || !binding.config) fail('CANDIDATE_ADAPTER_NOT_FROZEN', '适配引用尚未解析为冻结配置；未按未冻结版本解析。');
  if (!['csv', 'json'].includes(plan.format)) fail('CANDIDATE_ADAPTER_FORMAT', '端点适配只用于声明为 CSV/JSON 载体族的表源；其他格式须使用各自专用规则。');
  if (plan.selection || plan.xlsxSelection || plan.xbrlSelection || plan.necessaryTextSelection
    || plan.pdfSelection || plan.financialCalculation || plan.numericFormats)
    fail('CANDIDATE_ADAPTER_RULES', '端点适配表源不接受选区、专用投影或区域数值规则；这些规则会与载体声明冲突。');
  if (adapterConfigDigest(binding.config) !== binding.configDigest) fail('CANDIDATE_ADAPTER_CHANGED', '冻结适配配置与摘要不符；未按其他版本继续。');
  if (binding.config.adapterId !== binding.adapterId || binding.config.version !== binding.version)
    fail('CANDIDATE_ADAPTER_CHANGED', '冻结适配身份与配置内容不一致。');
  const result = parseEndpointSource(bytes, binding.config, { maxRecords: CANDIDATE_LIMITS.maxRows });
  if (result.sourceSha256 !== wfdSha256(bytes)) fail('CANDIDATE_SOURCE_CHANGED', '解析期间原字节摘要发生变化。');
  // 类型与换算都按 fieldMapping 之后的目标字段名登记；原值与原定位仍保留原字段身份。
  const target = (name: string) => plan.fieldMapping?.[name] ?? name;
  const types: NonNullable<CandidateTablePlan['types']> = Object.assign(Object.create(null),
    Object.fromEntries(binding.config.fields.map(field => [target(field.name), adapterColumnType(field)])));
  for (const [name, type] of Object.entries(plan.types ?? {})) {
    if (types[name] && !adapterTypeCompatible(type, types[name]!)) fail('CANDIDATE_ADAPTER_RULES', '结构类型声明与适配字段类型冲突。');
    types[name] = type;
  }
  const conversions = Object.fromEntries(result.conversions.map(conversion => [target(conversion.field),
    { source: conversion.source, target: conversion.target, factor: conversion.factor, basis: conversion.basis }]));
  return finishParsedTable(adapterMaterialTable(result), result.sourceSha256,
    { id: binding.adapterId, version: binding.version }, { ...plan, types },
    { adapter_evidence: adapterParseEvidence(binding.config, result), conversions });
}

/** 通用收尾：原值、原定位、字段映射、类型与标注校验在适配与非适配路径完全一致。 */
function finishParsedTable(parsed: MaterialTable | null | undefined, sourceSha256: string,
  adapter: { id: string; version: string }, plan: CandidateTablePlan,
  extras: { selection?: CandidateCsvSelectionEvidence; adapter_evidence?: WfdRecord;
    conversions?: Record<string, { source: string; target: string; factor: string; basis: string }> }): ParsedCandidateTable {
  if (!parsed || !parsed.rows.length) fail('CANDIDATE_EMPTY_TABLE', '完整表源为空，未生成虚构记录。');
  const sourceNames = parsed!.columns.map(column => column.name), mapping = plan.fieldMapping ?? {};
  if (new Set(sourceNames).size !== sourceNames.length || sourceNames.some(name => !name)) fail('CANDIDATE_FIELDS', '原始字段名必须非空且唯一；请先提供明确修订来源。');
  if (Object.keys(mapping).some(name => !sourceNames.includes(name)) || Object.values(mapping).some(name => typeof name !== 'string' || !name || name.length > 256)) fail('CANDIDATE_MAPPING', '映射须引用实际原列及有效目标字段。');
  const names = sourceNames.map(name => Object.hasOwn(mapping, name) ? mapping[name]! : name);
  if (new Set(names).size !== names.length) fail('CANDIDATE_MAPPING', '多个原列不能覆盖到同一个目标字段。');
  const annotations = plan.annotations ?? {};
  if (!isWfdRecord(annotations) || Object.entries(annotations).some(([name, value]) => !name || names.includes(name) || !scalar(value))) fail('CANDIDATE_ANNOTATIONS', '标注只接受不覆盖原字段的明确常量标量。');
  const fields = [...names, ...Object.keys(annotations)];
  if (fields.length > CANDIDATE_LIMITS.maxFields || Object.keys(plan.types ?? {}).some(name => !names.includes(name))
    || Object.values(plan.types ?? {}).some(type => !typeNames.includes(type as typeof typeNames[number]))
    || [...(plan.trim ?? []), ...(plan.emptyToNull ?? [])].some(name => !names.includes(name))) fail('CANDIDATE_RULES', '规则必须逐项绑定实际目标字段，且不得超过字段预算。');
  const numericFormats = plan.numericFormats ?? {};
  if (!isWfdRecord(numericFormats) || Object.keys(numericFormats).some(name => !names.includes(name) || plan.types?.[name] !== 'decimal_string'))
    fail('CANDIDATE_RULES', '区域数值规则须绑定明确 decimal_string 原值列；代码或文本列不能隐式转数。');
  Object.values(numericFormats).forEach(readNumericFormat);
  const rows = parsed!.rows.map(row => row.map((cell, columnIndex) => {
    const original = originalCell(cell), column = names[columnIndex]!;
    const converted = cell.converted !== undefined ? cell.converted : undefined;
    const conversion = converted !== undefined ? extras.conversions?.[column] : undefined;
    if (converted !== undefined && !conversion)
      fail('CANDIDATE_ADAPTER_RULES', '适配单元格声明了换算值但缺少逐字段换算依据。');
    return { original, value: converted !== undefined ? converted : original, sourceType: cell.sourceType, quote: cell.quote,
      location: cell.location, ...(conversion ? { conversion } : {}) };
  }));
  const table: ParsedCandidateTable = { kind: 'parsed-table', format: plan.format, source_sha256: sourceSha256, adapter: { id: adapter.id, version: adapter.version },
    source_columns: sourceNames, columns: names, fields, mapping: { ...mapping }, types: { ...(plan.types ?? {}) },
    trim: [...(plan.trim ?? [])], emptyToNull: [...(plan.emptyToNull ?? [])], annotations: { ...annotations },
    rows, total_rows: rows.length, ...(Object.keys(numericFormats).length ? { numericFormats } : {}),
    ...(extras.selection ? { selection: extras.selection } : {}), ...(extras.adapter_evidence ? { adapter_evidence: extras.adapter_evidence } : {}) };
  return plan.sourceProjection ? projectSourceReportedTable(table, plan.sourceProjection) : table;
}

function readCsvSelection(plan: CandidateTablePlan): CandidateCsvSelection | null {
  if (plan.selection === undefined) return null;
  const selection = plan.selection;
  if (plan.format !== 'csv' || !isWfdRecord(selection) || Object.keys(selection).some(key => !['predicate', 'maxSelectedRows', 'maxScannedRows'].includes(key))
    || !isWfdRecord(selection.predicate) || Object.keys(selection.predicate).some(key => !['column', 'equals'].includes(key))
    || typeof selection.predicate.column !== 'string' || !selection.predicate.column || typeof selection.predicate.equals !== 'string'
    || !Number.isSafeInteger(selection.maxSelectedRows) || selection.maxSelectedRows < 1 || selection.maxSelectedRows > CANDIDATE_SELECTION_LIMITS.maxSelectedRows
    || !Number.isSafeInteger(selection.maxScannedRows) || selection.maxScannedRows < 1 || selection.maxScannedRows > CANDIDATE_SELECTION_LIMITS.maxScannedRows) {
    return fail('CANDIDATE_SELECTION', '选件仅接受 CSV 原列名和原字符串精确相等条件、1–5000 选中行及 1–2000000 完整扫描行预算。');
  }
  return { predicate: { column: selection.predicate.column, equals: selection.predicate.equals },
    maxSelectedRows: selection.maxSelectedRows, maxScannedRows: selection.maxScannedRows };
}

function selectCsvRecords(text: string, selection: CandidateCsvSelection, limits: MaterialLimits, sourceBytes: number,
  sourceSha256: string): { table: MaterialTable; evidence: CandidateCsvSelectionEvidence } {
  const records = candidateCsvRecords(text, limits), first = records.next();
  if (first.done) return fail('CANDIDATE_EMPTY_TABLE', '完整表源为空，未生成虚构记录。');
  const header = first.value;
  const sourceNames = header.map(field => field.value);
  if (new Set(sourceNames).size !== sourceNames.length || sourceNames.some(name => !name)) fail('CANDIDATE_FIELDS', '原始字段名必须非空且唯一；请先提供明确修订来源。');
  const predicateIndex = sourceNames.indexOf(selection.predicate.column);
  if (predicateIndex < 0) fail('CANDIDATE_SELECTION_FIELD', '精确选件条件必须引用实际原列名，不能使用映射后字段。');
  const rows: MaterialCell[][] = []; let scannedRows = 0;
  for (const record of records) {
    scannedRows++;
    if (scannedRows > selection.maxScannedRows) fail('CANDIDATE_SCAN_BUDGET', '原件尚未完整扫至文件结尾即超过显式行扫描预算；未截断或声明选件完成。');
    if (record.length !== sourceNames.length) fail('RAGGED_CSV', 'CSV 行列数不一致；不补列、不丢列。');
    if (record[predicateIndex]!.value !== selection.predicate.equals) continue;
    if (rows.length >= selection.maxSelectedRows) fail('CANDIDATE_SELECTION_ROW_BUDGET', '原件精确匹配行超过显式选中行预算；未截断选件。');
    rows.push(record.map(field => ({ sourceType: 'string', original: field.value, proposed: field.value,
      quote: text.slice(field.location.start, field.location.end), location: field.location })));
  }
  if (!scannedRows) fail('CANDIDATE_EMPTY_TABLE', '完整表源为空，未生成虚构记录。');
  if (!rows.length) fail('CANDIDATE_EMPTY_SELECTION', '完整扫描原件后没有精确匹配行，未生成虚构记录。');
  return { table: { columns: header.map(field => ({ name: field.value, proposedName: field.value,
    quote: text.slice(field.location.start, field.location.end), location: field.location })), rows, totalRows: rows.length, previewTruncated: false },
  evidence: { ...selection, selectionComplete: true, scannedRows, selectedRows: rows.length, excludedRows: scannedRows - rows.length,
    sourceBytes, sourceSha256 } };
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
      if (changes.length < CHANGE_WINDOW_LIMIT) changes.push({ row: rowIndex + 1, field: name, original: cell.original,
        before: cell.value, after: value, location: cell.location });
    }
    return { ...cell, value };
  }));
  return { ...parsed, kind: 'cleaned-table', trim, emptyToNull, rows, changes, changes_total: changesTotal, change_window_limit: CHANGE_WINDOW_LIMIT };
}

/** 结构化步骤：按显式类型与 JSON 数字原文字面量转换，先核无损精度，绝不静默舍入。 */
export function structureCandidateTable(cleaned: CleanedCandidateTable | ParsedCandidateTable, types?: CandidateTablePlan['types']): StructuredCandidateTable {
  const applied = types ?? cleaned.types;
  // 未声明清洗规则的计划会直接传递解析产物；该步的变化计数明确为零。
  const changes = cleaned.kind === 'cleaned-table' ? cleaned.changes : [];
  const changesTotal = cleaned.kind === 'cleaned-table' ? cleaned.changes_total : 0;
  const changeWindowLimit = cleaned.kind === 'cleaned-table' ? cleaned.change_window_limit : CHANGE_WINDOW_LIMIT;
  const typeChanges: CandidateTypeChange[] = []; let typeChangesTotal = 0, decimalLexemeChangesTotal = 0;
  const rows = cleaned.rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const name = cleaned.columns[columnIndex]!;
    const declaredType = applied && Object.hasOwn(applied, name) ? applied[name] : undefined;
    const format = cleaned.numericFormats?.[name];
    const lexeme = format && cell.value !== null ? typeof cell.value === 'string' ? normalizeNumericLexeme(cell.value, format)
      : fail('CANDIDATE_NUMERIC_FORMAT', '区域数值规则只消费原始字符串，不从浮点数还原词面。') : cell.value;
    const value = typedCell(lexeme, declaredType, cell.sourceType);
    if (value !== cell.value) {
      const decimalLexeme = declaredType === 'decimal_string' && typeof cell.value === 'string' && typeof value === 'string';
      typeChangesTotal++;
      if (decimalLexeme) decimalLexemeChangesTotal++;
      if (typeChanges.length < changeWindowLimit) typeChanges.push({ operation: decimalLexeme ? 'decimal_lexeme' : 'type_conversion',
        row: rowIndex + 1, field: name, original: cell.original, before: cell.value, after: value, quote: cell.quote, location: cell.location });
    }
    return { ...cell, value };
  }));
  return { ...cleaned, kind: 'structured-table', types: applied, rows, changes, changes_total: changesTotal,
    change_window_limit: changeWindowLimit, type_changes: typeChanges,
    type_changes_total: typeChangesTotal, decimal_lexeme_changes_total: decimalLexemeChangesTotal,
    type_change_window_limit: changeWindowLimit, type_changes_truncated: typeChangesTotal > typeChanges.length };
}

/** 标注步骤：只加入不与原列重名的明确常量，不覆盖原值。 */
export function annotateCandidateTable(structured: StructuredCandidateTable, annotations?: Record<string, string | number | boolean | null>): AnnotatedCandidateTable {
  const applied = annotations ?? structured.annotations;
  return { ...structured, kind: 'annotated-table', annotations: { ...applied }, fields: [...structured.columns, ...Object.keys(applied)] };
}

/**
 * 核对步骤：合并已完成结构产物，核字段一致、行数、有限标量与输出摘要。
 * 只证明结构完整性；来源真实性、业务语义、单位与已列绑定之外的规则适用性及实现覆盖仍待核。
 */
export function checkCandidateTables(tables: (AnnotatedCandidateTable | StructuredCandidateTable)[]): { bytes: Buffer; rows: WfdRecord[]; evidence: CandidateCheckEvidence } {
  if (!tables.length) fail('CANDIDATE_CHECK_SCOPE', '核对步骤至少需要一个已完成结构产物。');
  const enabledAnnotations = (table: AnnotatedCandidateTable | StructuredCandidateTable) => table.kind === 'annotated-table' ? table.annotations : {};
  const fieldsOf = (table: AnnotatedCandidateTable | StructuredCandidateTable) => [...table.columns, ...Object.keys(enabledAnnotations(table))];
  const first = tables[0]!, fields = fieldsOf(first);
  const rows: WfdRecord[] = [];
  for (const table of tables) {
    const role = table.columns.indexOf('text_role');
    if ((role >= 0 && table.rows.some(row => row[role]?.value === 'necessary_condition') || enabledAnnotations(table).text_role === 'necessary_condition') && !table.necessary_text_evidence)
      fail('NECESSARY_TEXT_REVIEW', '必要条件标签不是选择证明；须核定原文版本、完整段范围、用途和发布内容摘要。');
    if (table.necessary_text_evidence) {
      const contents = table.rows.map(row => Object.fromEntries(table.columns.map((name, index) => [name, row[index]!.value])));
      if (wfdSha256(canonicalWfdJson(contents)) !== table.necessary_text_evidence.publishedContentSha256)
        fail('NECESSARY_TEXT_REVIEW', '待发布必要文字与已核定原文选择摘要不一致。');
    }
    if (canonicalWfdJson(fieldsOf(table)) !== canonicalWfdJson(fields)) fail('CANDIDATE_CHECK_FIELDS', '多个表源的最终字段不一致；未擅自取并集或补列。');
    if (!table.rows.length) fail('CANDIDATE_CHECK_SCOPE', '结构产物没有数据行，不能形成完整表核对证明。');
    for (const row of table.rows) {
      if (row.length !== table.columns.length) fail('CANDIDATE_CHECK_FIELDS', '结构产物的行与字段数量不一致。');
      const object: WfdRecord = Object.fromEntries([...table.columns.map((name, index) => [name, row[index]!.value]), ...Object.entries(enabledAnnotations(table))]);
      for (const value of Object.values(object)) if (!scalar(value)) fail('CANDIDATE_CHECK_VALUE', '结构产物含非有限标量，未形成通过结果。');
      rows.push(object);
      if (rows.length > CANDIDATE_LIMITS.maxRows) fail('CANDIDATE_ROW_BUDGET', '合并后的完整表超过行数预算。');
    }
  }
  // 与正式派生算法共用生产结构/精度核对，既保留全部来源行也不静默填充坏值。
  const checked = verifyProductionRows({ kind: 'source', rows, fields,
    maxRows: CANDIDATE_LIMITS.maxRows, maxBytes: CANDIDATE_LIMITS.maxStructuredBytes });
  const bytes = checked.bytes;
  return { bytes, rows, evidence: { version: CANDIDATE_STAGE_VERSIONS.check, fields: [...fields], row_count: rows.length,
    structured_sha256: wfdSha256(bytes), changes_total: tables.reduce((total, table) => total + (Number.isFinite(table.changes_total) ? table.changes_total : 0), 0),
    type_changes_total: tables.reduce((total, table) => total + table.type_changes_total, 0),
    decimal_lexeme_changes_total: tables.reduce((total, table) => total + table.decimal_lexeme_changes_total, 0),
    check_scope: ['strict_utf8_decoding', 'table_shape', 'unique_nonempty_fields', 'explicit_field_mapping', 'explicit_scalar_types',
      'finite_scalars', 'decimal_precision_roundtrip', 'type_changes_recorded', 'row_budget', 'output_digest'],
    gaps: ['未验证来源真实性或来源声明', '未验证业务语义、单位、时间与对象身份', '未验证产品合同、历史覆盖或正式准入',
      '已列绑定之外业务规则的适用性与实现覆盖未核定，未签发执行证明'],
    sources: tables.map(table => ({ source_sha256: table.source_sha256, row_count: table.total_rows,
      ...(table.selection ? { selection: table.selection } : {}) })) } };
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

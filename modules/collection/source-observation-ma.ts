import { readFileSync } from 'node:fs';
import type { R1RequestView, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { parseTableSource } from './candidate-pipeline.js';
import type { FrozenAdapterBinding } from './endpoint-adapter.js';
import { SOURCE_REPORT_COLUMNS, readSourceProjection, sourceReportedDate, sourceReportedMinute, type CandidateSourceProjection } from './source-reported-table.js';
import type { MaterialLocation } from './materials/contracts.js';

export const SOURCE_OBSERVATION_MA_VERSION = 'bd.source-observation-ma/1';
export const SOURCE_OBSERVATION_MA_METHOD_VERSION = '1.0.0';
export const SOURCE_OBSERVATION_MINUTE_MA_METHOD_VERSION = '1.1.0';
export const SOURCE_OBSERVATION_MA_LIMITS = Object.freeze({ maxRows: 5000, minPeriod: 2, maxPeriod: 1000,
  outputScale: 8, maxProofBytes: 1_048_576, maxResultBytes: 2_097_152 });
export interface SourceObservationMASelection { method: 'source_observation_ma'; period: number; valueColumn: string }
export interface SourceObservationMAInput {
  materialId: string; original: Buffer; source: R1SourceDeclaration; projection: CandidateSourceProjection;
  request: R1RequestView; fixedRows: WfdRecord[];
  /** 原件实际载体格式与已冻结适配；均线复核必须按同一解析路径重读原件。 */
  format?: 'csv' | 'json';
  sourceAdapter?: FrozenAdapterBinding;
}
/** A current snapshot is frozen before reading any earlier acquisition. */
export interface SourceObservationMAContext {
  snapshotId: string; productId: string; versions: Record<string, string>;
}
export interface CalculatedMASource {
  materialId: string; materialSha256: string; requestId: string; source: R1SourceDeclaration;
  productId: string; snapshotId: string; definitionDigest: string;
}
export type CalculatedMAStatus = 'valid' | 'warmup' | 'window_missing';
/** Windows refer to consecutive indices in this grouped, date-sorted array; no repeated window copies. */
export interface CalculatedMARow {
  businessKey: string; date: string; groupValues: string[]; sourceIndex: number; sourceRow: number;
  minute?: string;
  location: MaterialLocation; recordVersion: string; inputValue: string | null; inputState: string;
  windowStart: number; windowCount: number; status: CalculatedMAStatus; value: string | null;
}
export interface CalculatedMAProof {
  version: 'bd.source-observation-ma-proof/1' | 'bd.source-observation-ma-proof/2' | 'bd.source-observation-ma-proof/3'; method: 'source_observation_ma'; methodVersion: string;
  implementationVersion: string; codeDigest: string; materialSha256: string; derivativeSemanticCode: string;
  sourceProductId: string; period: number; valueColumn: string; unitCode: string; timeZone: string;
  subject: WfdRecord; groupColumns: string[]; dateColumn: string;
  minuteColumn?: string; minuteLabelMeaning?: 'unknown'; sessionContinuity?: 'not_asserted';
  outputScale: 8; rounding: 'half_even'; windowKind: 'observation_rows'; inputScope: 'selected_batch_only' | 'frozen_series_snapshot';
  continuation?: { snapshotId: string; versionPolicy: 'matching_fixed_snapshot'; omittedRevisions: number;
    recompute: 'complete_selected_series'; reason: string };
  historicalAvailability: 'unknown'; priceBasis: 'source_reported_unverified';
  sources: CalculatedMASource[]; lineage: CalculatedMARow[];
  counts: { rows: number; groups: number; valid: number; warmup: number; windowMissing: number };
}
export interface CalculatedMAProofSummary extends Omit<CalculatedMAProof, 'lineage'> { proofSha256: string; lineageSha256: string }
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const currentSourceCodeDigest = (): string => wfdSha256(readFileSync(new URL(import.meta.url)));
const LOADED_CODE_DIGEST = currentSourceCodeDigest();
export const sourceObservationMACodeDigest = (): string => LOADED_CODE_DIGEST;
export function assertSourceObservationMAImplementationCurrent(): void {
  if (currentSourceCodeDigest() !== LOADED_CODE_DIGEST)
    fail('R1_MA_IMPLEMENTATION_CHANGED', '磁盘源码与本进程加载时冻结的均线实现不同；须明确重开采用，未用旧函数签发新源码摘要。');
}

export function readSourceObservationMASelection(value: unknown): SourceObservationMASelection {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !['method', 'period', 'valueColumn'].includes(key))
    || value.method !== 'source_observation_ma' || !Number.isSafeInteger(value.period)
    || Number(value.period) < SOURCE_OBSERVATION_MA_LIMITS.minPeriod || Number(value.period) > SOURCE_OBSERVATION_MA_LIMITS.maxPeriod
    || typeof value.valueColumn !== 'string' || !value.valueColumn.trim() || value.valueColumn.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.valueColumn)) return fail('R1_MA_SELECTION', '来源观测均线需要明确原数值列和 2–1000 条观测窗口。');
  return { method: 'source_observation_ma', period: Number(value.period), valueColumn: String(value.valueColumn) };
}

/** Only the business definition enters WFD. Code, input records and custody proofs stay in BD. */
export const sourceObservationMAMethodVersion = (proof: Pick<CalculatedMAProof,'minuteColumn'> & Partial<Pick<CalculatedMAProof,'inputScope'>>): string => proof.inputScope === 'frozen_series_snapshot'
  ? proof.minuteColumn ? '2.1.0' : '2.0.0' : proof.minuteColumn ? SOURCE_OBSERVATION_MINUTE_MA_METHOD_VERSION : SOURCE_OBSERVATION_MA_METHOD_VERSION;
export function sourceObservationMAAlgorithmDefinition(proof: Pick<CalculatedMAProof, 'period' | 'valueColumn' | 'groupColumns' | 'dateColumn' | 'minuteColumn'> & Partial<Pick<CalculatedMAProof,'inputScope'>>): WfdRecord {
  const scope = proof.inputScope === 'frozen_series_snapshot' ? '同系列已关联原件的冻结快照观测（含前批预热与已发布更正）' : '本批所供观测';
  return { definition_version: sourceObservationMAMethodVersion(proof),
    result_semantics: proof.minuteColumn
      ? `来源原报列「${proof.valueColumn}」在${scope}中的简单移动均值；分组列 ${JSON.stringify(proof.groupColumns)}，原日期列「${proof.dateColumn}」及分钟标签列「${proof.minuteColumn}」升序。UTC 区间仅保存分钟标签桶，标签起止含义未知，不证明交易分钟完整性、交易时段连续性、复权或历史公开资格；不足窗口和含缺失窗口分别返回未知值与原因。`
      : `来源原报列「${proof.valueColumn}」在${scope}中的简单移动均值；分组列 ${JSON.stringify(proof.groupColumns)}，日期列「${proof.dateColumn}」升序。不证明交易日完整性、复权或历史公开资格；不足窗口和含缺失窗口分别返回未知值与原因。`,
    mathematical_definition: 'MA[i] = sum(x[j], j=i-period+1..i) / period. Full observation-row windows only; no row dropping, filling, interpolation or cross-group windows. Exact decimal integer arithmetic; round the final quotient to 8 decimal places using round-half-to-even. Missing input makes the affected full window unknown. Output dates use the target source row label.',
    window: { type: 'observation_rows', count: proof.period, interval: 'closed', unit: 'selected_source_observations' },
    constants: { period: proof.period, output_scale: 8 } };
}

interface Decimal { coefficient: bigint; scale: number }
function decimal(value: unknown): Decimal {
  if (typeof value !== 'string' || value.length > 128 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value))
    return fail('R1_MA_DECIMAL', '均线只接受已核定的精确十进制数值；不猜区域格式、不先转二进制浮点。');
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e'), power = Number(exponent);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 38) return fail('R1_MA_DECIMAL', '原值十进制指数超出已验证范围。');
  const negative = mantissa!.startsWith('-'), unsigned = negative ? mantissa!.slice(1) : mantissa!;
  const [integer, fraction = ''] = unsigned.split('.');
  let coefficient = BigInt(integer! + fraction) * (negative ? -1n : 1n), scale = fraction.length - power;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  if (scale > 18 || coefficient.toString().replace('-', '').length > 38) return fail('R1_MA_DECIMAL', '输入超过 38 位有效十进制整数或 18 位小数的已验证范围。');
  return { coefficient, scale };
}
function sameDecimal(a: unknown, b: unknown): boolean {
  const left = decimal(a), right = decimal(b), scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale) === right.coefficient * 10n ** BigInt(scale - right.scale);
}
export function meanExactDecimal(values: string[]): string {
  const parts = values.map(decimal), scale = Math.max(...parts.map(part => part.scale));
  const sum = parts.reduce((total, part) => total + part.coefficient * 10n ** BigInt(scale - part.scale), 0n);
  const numerator = sum * 100_000_000n, denominator = BigInt(parts.length) * 10n ** BigInt(scale);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator, magnitude = remainder < 0n ? -remainder : remainder;
  if (2n * magnitude > denominator || 2n * magnitude === denominator && rounded % 2n !== 0n) rounded += numerator < 0n ? -1n : 1n;
  const negative = rounded < 0n, digits = (negative ? -rounded : rounded).toString().padStart(9, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) return fail('R1_MA_INPUT_BINDING', `${what} 缺少固定身份。`);
  return value;
}
function object(value: unknown, what: string): WfdRecord {
  if (!isWfdRecord(value)) return fail('R1_MA_INPUT_BINDING', `${what} 不是可核对象。`);
  return value;
}
interface Observation extends CalculatedMARow { start: string; end: string; groupKey: string }

/** Re-reads original cells and exact associated WFD versions before any calculation. */
export function buildSourceObservationMA(rawSelection: SourceObservationMASelection, inputs: SourceObservationMAInput[], context?: SourceObservationMAContext): { bytes: Buffer; proof: CalculatedMAProof } {
  assertSourceObservationMAImplementationCurrent();
  const selection = readSourceObservationMASelection(rawSelection);
  if (!inputs.length || inputs.length > 100) fail('R1_MA_INPUT_BINDING', '均线需要本批明确选定并完成固定读回的原件。');
  const sources: CalculatedMASource[] = [], observations: Observation[] = [];
  let firstProjection: CandidateSourceProjection | null = null, binding: string | null = null, unitCode = '', subject: WfdRecord = {};
  const seen = new Set<string>();
  const selectedKeys = new Set<string>(), activeKeys = new Set<string>();
  let omittedRevisions = 0;
  for (const [sourceIndex, input] of inputs.entries()) {
    const projection = readSourceProjection(input.projection), request = input.request;
    if (request.state !== 'associated' || request.requiresRecovery || request.connection.profile !== 'data_only')
      fail('R1_MA_INPUT_NOT_ASSOCIATED', '原数据须先按原请求完成发布、固定读回与来源关联。');
    const field = projection.fields.find(field => field.column === selection.valueColumn);
    if (!field || projection.keyColumns.includes(selection.valueColumn)) fail('R1_MA_FIELD', '均线必须选择本批原件已交接的数值列，不能把身份键用作数值。');
    const groupColumns = projection.keyColumns.filter(column => column !== projection.dateColumn && column !== projection.minute?.column);
    if (!groupColumns.length) fail('R1_MA_GROUP_REQUIRED', '本切片要求明确的原报对象身份列；不把全表当作同一证券。');
    const associations = Array.isArray(request.local.associations) ? request.local.associations.filter(isWfdRecord) : [];
    if (associations.length !== request.rowCount || !associations.length || input.fixedRows.length !== request.rowCount)
      fail('R1_MA_INPUT_BINDING', '固定读取与本次原请求的完整行关联数量不符。');
    const first = associations[0]!, productId = text(first.product_id, '原产品'), snapshotId = text(first.snapshot_id, '固定快照');
    const refs = object(request.local.local_refs, '来源回链'), originalSource = Array.isArray(refs.sourceRefs) ? refs.sourceRefs[0] : null;
    const originalSha256 = wfdSha256(input.original);
    if (!isWfdRecord(originalSource) || originalSource.sha256 !== originalSha256 || originalSource.bytes !== input.original.length
      || canonicalWfdJson(Object.fromEntries(Object.entries(originalSource).filter(([key]) => !['sha256', 'bytes'].includes(key)))) !== canonicalWfdJson(input.source))
      fail('R1_MA_INPUT_BINDING', '原件字节、来源和本次已关联的保管身份不一致。');
    const parsed = parseTableSource(input.original, { materialId: input.materialId,
      format: input.sourceAdapter ? 'json' : input.format ?? 'csv', sourceProjection: projection,
      ...(input.sourceAdapter ? { sourceAdapter: input.sourceAdapter } : {}) });
    if (parsed.rows.length !== request.rowCount || !context && observations.length + parsed.rows.length > SOURCE_OBSERVATION_MA_LIMITS.maxRows)
      fail('R1_MA_ROW_BUDGET', '均线仅接收完整原件合计不超过 5000 条观测；没有截断或扩大预算。');
    const fixedByKey = new Map<string, WfdRecord>();
    for (const row of input.fixedRows) {
      const record = object(row.record_ref, '固定行引用'), key = text(record.logical_key, '固定行逻辑键');
      if (fixedByKey.has(key)) fail('R1_MA_INPUT_BINDING', '固定读取返回重复业务键，未取第一行。');
      fixedByKey.set(key, row);
    }
    const index = (column: string) => parsed.columns.indexOf(column);
    for (const [sourceRow, cells] of parsed.rows.entries()) {
      const businessKey = text(cells[index(SOURCE_REPORT_COLUMNS.key)]?.value, '原报业务键');
      const fixed = fixedByKey.get(businessKey) ?? fail('R1_MA_INPUT_BINDING', '原报业务键未在本次固定读取中出现。');
      const association = associations.find(association => association.record_id === businessKey), record = object(fixed.record_ref, '固定行引用');
      if (!association || association.product_id !== productId || association.snapshot_id !== snapshotId
        || association.definition_digest !== first.definition_digest || association.record_version !== record.revision_id)
        fail('R1_MA_INPUT_BINDING', '输入行版本、产品、快照或定义与本次原请求关联不符。');
      const values = object(fixed.values, '固定值'), cell = object(values[field!.fieldCode], '固定数值'), unit = object(cell.unit, '固定数值单位');
      if (!['decimal', 'integer'].includes(String(cell.data_type))) fail('R1_MA_FIELD', '均线输入必须在实际产品中具有明确数值类型。');
      const actualUnit = text(unit.unit_code, '已登记单位');
      const rowSubject = object(request.previewRows[0]?.subject, '原报产品主体');
      const currentBinding = canonicalWfdJson({ connection: request.connection, datasetId: request.datasetId, productId,
        groupColumns, dateColumn: projection.dateColumn, dateEncoding: projection.dateEncoding, timeZone: projection.timezone,
        ...(projection.minute ? {minute:projection.minute} : {}),
        valueColumn: selection.valueColumn, unitCode: actualUnit, subject: rowSubject, sourceId: input.source.source_id,
        provider: input.source.provider, usageScope: input.source.usage_scope,
        // 已知频率/复权/市场属于序列口径：未知与已知、不同已知值都不能拼成同一均线。
        ...(input.sourceAdapter ? { adapterSemantics: { frequency: input.sourceAdapter.config.match.frequency,
          adjustment: input.sourceAdapter.config.match.adjustment, market: input.sourceAdapter.config.match.market ?? null } } : {}) });
      if (binding !== null && binding !== currentBinding) fail('R1_MA_INCOMPATIBLE_INPUTS', '本批输入的产品、身份规则、时间、单位、来源或用途不同；未跨口径拼接。');
      binding = currentBinding; unitCode = actualUnit; subject = rowSubject; firstProjection = projection;
      // 发布与固定读回使用有效换算值；原值只作原始证据，不能在这里二次换算或按原词面比对。
      const valueCell = cells[index(selection.valueColumn)]!, originalValue = valueCell.original;
      const effectiveValue = valueCell.value, inputState = text(cell.value_state, '数值状态');
      const missing = !['valid_value', 'reported_zero'].includes(inputState);
      if (missing ? effectiveValue !== null && effectiveValue !== '' || cell.value !== null
        : typeof effectiveValue !== 'string' || !sameDecimal(effectiveValue, cell.value))
        fail('R1_MA_VALUE_MISMATCH', '有效数值和已关联固定行值或缺失状态不一致，未计算。');
      const groupValues = groupColumns.map(column => {
        const original = text(cells[index(column)]?.original, '分组原值');
        const groupField = projection.fields.find(item => item.column === column) ?? fail('R1_MA_GROUP_REQUIRED', '分组字段未随原数据交接。');
        const fixedCell = object(values[groupField.fieldCode], '固定分组值');
        if (fixedCell.value !== original || !['valid_value', 'reported_zero'].includes(String(fixedCell.value_state))) fail('R1_MA_VALUE_MISMATCH', '分组身份与固定原行不一致。');
        return original;
      });
      const date = sourceReportedDate(cells[index(projection.dateColumn)]?.original, projection.dateEncoding) ?? fail('R1_MA_DATE', '原日期标签不能解释为明确公历日。');
      const dateField = projection.fields.find(item => item.column === projection.dateColumn) ?? fail('R1_MA_DATE', '原日期标签没有随原数据交接。');
      const fixedDate = object(values[dateField.fieldCode], '固定原日期');
      if (fixedDate.value !== cells[index(projection.dateColumn)]?.original || fixedDate.value_state !== 'valid_value')
        fail('R1_MA_VALUE_MISMATCH', '原日期标签与已关联固定行不一致。');
      let minute: string | undefined;
      if (projection.minute) {
        const minuteCell = cells[index(projection.minute.column)]!, minuteField = projection.fields.find(item=>item.column===projection.minute!.column)
          ?? fail('R1_MA_DATE','原报分钟标签没有随原数据交接。');
        minute = sourceReportedMinute(minuteCell.original) ?? fail('R1_MA_DATE','原报分钟标签无效，未降级成日。');
        const fixedMinute = object(values[minuteField.fieldCode],'固定原分钟');
        if (fixedMinute.value !== minuteCell.original || fixedMinute.value_state !== 'valid_value')
          fail('R1_MA_VALUE_MISMATCH','原报分钟标签与已关联固定行不一致。');
      }
      const groupKey = canonicalWfdJson(groupValues), unique = canonicalWfdJson([groupKey, minute ?? date]);
      if (context) {
        if (context.productId !== productId || !Object.hasOwn(context.versions, businessKey))
          fail('R1_MA_CONTEXT_BINDING', '前批业务键未在冻结的同产品快照中出现，未以最新值替代原输入。');
        selectedKeys.add(businessKey);
        if (context.versions[businessKey] !== record.revision_id || seen.has(unique)) { omittedRevisions++; continue; }
        activeKeys.add(businessKey);
      }
      if (seen.has(unique)) fail('R1_MA_DUPLICATE', '同一对象与原日期/分钟标签在本批重复；不去重、不按上传顺序选择版本。');
      seen.add(unique);
      observations.push({ businessKey, date,...(minute ? {minute} : {}), groupValues, sourceIndex, sourceRow: sourceRow + 1,
        location: cells[index(selection.valueColumn)]!.location, recordVersion: text(record.revision_id, '原行版本'),
        inputValue: missing ? null : String(effectiveValue), inputState,
        windowStart: 0, windowCount: 0, status: 'warmup', value: null,
        start: text(cells[index(SOURCE_REPORT_COLUMNS.start)]?.value, '原日期起点'),
        end: text(cells[index(SOURCE_REPORT_COLUMNS.end)]?.value, '原日期终点'), groupKey });
    }
    sources.push({ materialId: input.materialId, materialSha256: originalSha256, requestId: request.requestId, source: input.source,
      productId, snapshotId, definitionDigest: text(first.definition_digest, '原定义摘要') });
  }
  if ([...selectedKeys].some(key => !activeKeys.has(key)))
    fail('R1_MA_CONTEXT_REVISION_MISSING', '冻结快照中的当前更正版本没有对应已授权原件，未静默丢失该观测。');
  if (!observations.length || observations.length > SOURCE_OBSERVATION_MA_LIMITS.maxRows)
    fail('R1_MA_ROW_BUDGET', '冻结系列有效观测须为 1–5000 行；未截取历史预热或修订范围。');
  observations.sort((a, b) => a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : (a.minute ?? a.date).localeCompare(b.minute ?? b.date));
  let groupStart = 0, groupCount = 0;
  for (const [index, row] of observations.entries()) {
    if (!index || row.groupKey !== observations[index - 1]!.groupKey) { groupStart = index; groupCount++; }
    row.windowStart = Math.max(groupStart, index - selection.period + 1); row.windowCount = index - row.windowStart + 1;
    const window = observations.slice(row.windowStart, index + 1);
    row.status = row.windowCount < selection.period ? 'warmup' : window.some(item => item.inputValue === null) ? 'window_missing' : 'valid';
    row.value = row.status === 'valid' ? meanExactDecimal(window.map(item => item.inputValue!)) : null;
  }
  const projection = firstProjection!, groupColumns = projection.keyColumns.filter(column => column !== projection.dateColumn && column !== projection.minute?.column);
  const minute = projection.minute, inputScope = context ? 'frozen_series_snapshot' as const : 'selected_batch_only' as const;
  const methodVersion = sourceObservationMAMethodVersion({minuteColumn:minute?.column, inputScope});
  const semanticCode = 'derived.source_observation_ma.' + digest({ productId: sources[0]!.productId, selection, groupColumns,
    dateColumn: projection.dateColumn,...(minute ? {minute} : {}), timeZone: projection.timezone, unitCode, version: methodVersion }).slice(0, 40);
  const rows = observations.map(row => ({ business_key: row.businessKey, start_utc: row.start, end_utc: row.end,
    value: row.value, value_state: row.status === 'valid' ? 'valid_value' : 'unknown', calculation_status: row.status,
    'bd.semantic_code': semanticCode, 'bd.subject_kind': subject.kind, 'bd.subject_id': subject.id,
    'bd.frequency': minute ? 'source_reported_minute' : 'source_reported_day', 'bd.precision': minute ? 'minute' : 'day', 'bd.timezone': projection.timezone, 'bd.period_type': 'natural',
    'bd.type.value': 'decimal', 'bd.unit.value': unitCode, 'bd.measurement.value': 'derived',
    'bd.type.calculation_status': 'text', 'bd.unit.calculation_status': 'not_applicable',
    'bd.measurement.calculation_status': 'derived', 'bd.state.calculation_status': '@all_valid' }));
  const bytes = Buffer.from(canonicalWfdJson(rows));
  if (bytes.length > SOURCE_OBSERVATION_MA_LIMITS.maxResultBytes) fail('R1_MA_RESULT_BUDGET', '派生材料超过 2 MiB 的封闭单项预算，未截断。');
  const proof: CalculatedMAProof = { version: context ? 'bd.source-observation-ma-proof/3' : minute ? 'bd.source-observation-ma-proof/2' : 'bd.source-observation-ma-proof/1', method: selection.method,
    methodVersion, implementationVersion: SOURCE_OBSERVATION_MA_VERSION,
    codeDigest: sourceObservationMACodeDigest(), materialSha256: wfdSha256(bytes), derivativeSemanticCode: semanticCode,
    sourceProductId: sources[0]!.productId, period: selection.period, valueColumn: selection.valueColumn,
    unitCode, timeZone: projection.timezone, subject, groupColumns, dateColumn: projection.dateColumn,
    ...(minute ? {minuteColumn:minute.column,minuteLabelMeaning:'unknown' as const,sessionContinuity:'not_asserted' as const} : {}),
    outputScale: 8, rounding: 'half_even', windowKind: 'observation_rows', inputScope,
    ...(context ? { continuation: { snapshotId: context.snapshotId, versionPolicy: 'matching_fixed_snapshot' as const,
      omittedRevisions, recompute: 'complete_selected_series' as const, reason: '完整重算冻结系列，覆盖更正行及其后续依赖窗口并保留全部前置预热。' } } : {}),
    historicalAvailability: 'unknown', priceBasis: 'source_reported_unverified', sources,
    lineage: observations.map(({ start: _start, end: _end, groupKey: _groupKey, ...row }) => row),
    counts: { rows: observations.length, groups: groupCount, valid: observations.filter(row => row.status === 'valid').length,
      warmup: observations.filter(row => row.status === 'warmup').length, windowMissing: observations.filter(row => row.status === 'window_missing').length } };
  if (Buffer.byteLength(canonicalWfdJson(proof)) > SOURCE_OBSERVATION_MA_LIMITS.maxProofBytes) fail('R1_MA_PROOF_BUDGET', '完整计算证明超过 1 MiB 预算；未丢失窗口引用或假报成功。');
  assertSourceObservationMAImplementationCurrent();
  return { bytes, proof };
}

export function summarizeCalculatedMAProof(proof: CalculatedMAProof): CalculatedMAProofSummary {
  const { lineage, ...summary } = proof;
  return { ...summary, proofSha256: digest(proof), lineageSha256: digest(lineage) };
}

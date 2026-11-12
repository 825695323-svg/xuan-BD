import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { meanExactDecimal, sourceObservationMAAlgorithmDefinition } from '../collection/source-observation-ma.js';
import type { FinancialReader } from '../collection/data-processing/financial-fixed.js';

/**
 * WFD-only daily MA20: only a pinned snapshot/product and a declared numeric field.
 * The entire product is paged and checked. No caller-supplied values, original uploads,
 * latest pointer, source truncation, hidden historical privilege, or automatic backfill.
 */
export const WFD_SOURCE_MA_VERSION = 'bd.wfd-source-ma20/1';
export interface WfdSourceMACalculation {
  version: typeof WFD_SOURCE_MA_VERSION;
  snapshotId: string;
  productId: string;
  valueField: string;
}
export interface WfdMARow {
  business_key: string; start_utc: string; end_utc: string;
  value: string | null; value_state: 'valid_value' | 'unknown';
  calculation_status: 'valid' | 'warmup' | 'window_missing';
  unit: string;
}
export interface WfdMASource {
  calculation: WfdSourceMACalculation;
  input: Array<{ key: string; revision: string; start: string; end: string; value: string | null;
    state: string; originalSha256: string }>;
  rows: WfdMARow[];
  subject: WfdRecord;
  unitCode: string;
  timeZone: string;
  sourceRowsSha256: string;
  recordVersionsSha256: string;
  connection: unknown;
  historicalQualification: 'not_asserted';
  algorithmDefinition: WfdRecord;
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const sha = (x: unknown) => wfdSha256(canonicalWfdJson(x));
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(v)
  && !/^(latest|current)$/iu.test(v);
const fixed = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(v);
const utc = (x: unknown) => typeof x === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(x)
  && Number.isFinite(Date.parse(x));
const decimal = (x: unknown) => typeof x === 'string' && x.length <= 128
  && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(x);

export function readWfdSourceMACalculation(raw: unknown): WfdSourceMACalculation {
  if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'productId,snapshotId,valueField,version'
    || raw.version !== WFD_SOURCE_MA_VERSION || !id(raw.productId) || !id(raw.snapshotId)
    || !fixed(raw.valueField))
    return fail('WFD_MA_CONTRACT', '观测均线只接受 WFD 固定快照、产品和原已登记数值字段；不接受原始行、latest 或路径。');
  return { version: WFD_SOURCE_MA_VERSION, snapshotId: raw.snapshotId as string,
    productId: raw.productId as string, valueField: raw.valueField as string };
}

export async function readWfdMASource(raw: WfdSourceMACalculation, reader: FinancialReader,
  signal: AbortSignal): Promise<WfdMASource> {
  const calculation = readWfdSourceMACalculation(raw);
  let cursor: string | undefined, connection: unknown;
  const seenCursors = new Set<string>(), seenKeys = new Set<string>();
  const rawRows: WfdRecord[] = [];
  let subject: WfdRecord | null = null, unitCode: string | null = null, timeZone: string | null = null;
  do {
    signal.throwIfAborted();
    const response = await reader({ snapshotId: calculation.snapshotId, productId: calculation.productId,
      ...(cursor ? { cursor } : {}) }, signal);
    if (connection !== undefined && canonicalWfdJson(response.connection ?? null) !== canonicalWfdJson(connection))
      fail('WFD_MA_CONNECTION_CHANGED', '固定系列分页期间数据连接身份发生变化。');
    connection = response.connection ?? null;
    const page = response.result, pageRows = page.rows, paging = page.page;
    if (page.snapshot_id !== calculation.snapshotId || page.product_id !== calculation.productId
      || page.history_mode !== undefined && page.history_mode !== 'snapshot_contents'
      || !Array.isArray(pageRows) || !isWfdRecord(paging)
      || typeof paging.has_more !== 'boolean' || pageRows.length > 100)
      fail('WFD_MA_PAGE_INVALID', '固定 WFD 产品、历史读取模式或分页回执不符合契约。');
    for (const row of pageRows as WfdRecord[]) {
      if (!isWfdRecord(row) || !isWfdRecord(row.record_ref)
        || !isWfdRecord(row.subject) || !isWfdRecord(row.values) || !isWfdRecord(row.business_time))
        fail('WFD_MA_ROW_INVALID', '源观测缺固定身份、主体、业务时间或值。');
      const record = row.record_ref, key = record.logical_key ?? record.record_id;
      if (!id(key) || !id(record.revision_id) || seenKeys.has(key as string)
        || record.snapshot_id !== undefined && record.snapshot_id !== calculation.snapshotId
        || record.product_id !== undefined && record.product_id !== calculation.productId)
        fail('WFD_MA_ROW_IDENTITY', '源观测业务键、记录版本或固定快照不唯一。');
      seenKeys.add(key as string);
      const businessTime = row.business_time;
      if (businessTime.status !== undefined && businessTime.status !== 'known'
        || businessTime.precision !== 'day' || !utc(businessTime.earliest_utc)
        || !utc(businessTime.latest_exclusive_utc)
        || Date.parse(businessTime.earliest_utc as string) >= Date.parse(businessTime.latest_exclusive_utc as string)
        || typeof businessTime.source_timezone !== 'string' || !businessTime.source_timezone)
        fail('WFD_MA_TIME_INVALID', '日线均线需要明确的公历日业务区间和原时区，不能当分钟线或伪造交易时点。');
      if (subject && canonicalWfdJson(subject) !== canonicalWfdJson(row.subject)
        || timeZone !== null && timeZone !== businessTime.source_timezone)
        fail('WFD_MA_MIXED_SUBJECT', '当前固定算法一次只允许同一来源主体和时间口径的完整日线序列。');
      subject ??= row.subject; timeZone ??= businessTime.source_timezone as string;
      if (!id(row.subject.kind) || !id(row.subject.namespace) || !id(row.subject.id))
        fail('WFD_MA_SUBJECT', '源产品缺可复核的实体主体身份。');
      const cell = row.values[calculation.valueField];
      if (!isWfdRecord(cell) || !isWfdRecord(cell.unit)
        || !id(cell.unit.unit_code) || !['decimal', 'integer'].includes(String(cell.data_type)))
        fail('WFD_MA_FIELD', '实际 WFD 数值字段缺明确十进制类型和单位。');
      if (unitCode && unitCode !== cell.unit.unit_code)
        fail('WFD_MA_UNIT', '固定系列数值单位发生变化，不拼接均线。');
      unitCode = cell.unit.unit_code as string;
      const state = String(cell.value_state);
      if (!['valid_value', 'reported_zero'].includes(state)
        ? cell.value !== null
        : !decimal(cell.value))
        fail('WFD_MA_VALUE', '有效值必须为精确十进制，未知值必须为空；不将损坏数字改写为 null。');
      rawRows.push(row);
      if (rawRows.length > 5000) fail('WFD_MA_BUDGET', '固定产品超过5000行，不能截断预热窗口或漏行计算。');
    }
    const next = paging.has_more ? paging.next_cursor : null;
    if (next !== null && (typeof next !== 'string' || !next || next.length > 8192
      || seenCursors.has(next))) fail('WFD_MA_CURSOR', 'WFD 固定产品返回了无效或循环分页游标。');
    if (!paging.has_more && paging.next_cursor !== null) fail('WFD_MA_CURSOR', 'WFD 最后一页仍有游标。');
    cursor = next ?? undefined;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  if (!rawRows.length || !subject || !unitCode || !timeZone)
    fail('WFD_MA_EMPTY', '冻结来源完整扫描后没有可执行的日线观测。');
  const sorted = rawRows.sort((a, b) => String((a.business_time as WfdRecord).earliest_utc)
    .localeCompare(String((b.business_time as WfdRecord).earliest_utc)));
  const input: WfdMASource['input'] = sorted.map(row => {
    const record = row.record_ref as WfdRecord, time = row.business_time as WfdRecord;
    const cell = (row.values as WfdRecord)[calculation.valueField] as WfdRecord;
    return { key: (record.logical_key ?? record.record_id) as string,
      revision: record.revision_id as string, start: time.earliest_utc as string,
      end: time.latest_exclusive_utc as string,
      value: typeof cell.value === 'string' ? cell.value : null,
      state: String(cell.value_state), originalSha256: sha(row) };
  });
  for (let i=1;i<input.length;i++)
    if (input[i-1]!.start === input[i]!.start || input[i-1]!.end > input[i]!.start)
      fail('WFD_MA_DUPLICATE_TIME', '同一固定来源主体存在同日或重叠日期，不自行选一条。');
  const actualUnit = unitCode ?? fail('WFD_MA_EMPTY', '来源没有统一单位。');
  const actualSubject = subject ?? fail('WFD_MA_EMPTY', '来源主体不存在。');
  const actualTimeZone = timeZone ?? fail('WFD_MA_EMPTY', '来源时间口径不存在。');
  const rows = evaluateWfdMA20(input, actualUnit);
  const algorithmDefinition = sourceObservationMAAlgorithmDefinition({
    period: 20, valueColumn: calculation.valueField, groupColumns: ['WFD pinned subject'],
    dateColumn: 'business_time', inputScope: 'frozen_series_snapshot',
  });
  return { calculation, input, rows, subject: actualSubject, unitCode: actualUnit, timeZone: actualTimeZone,
    sourceRowsSha256: sha(sorted), recordVersionsSha256: sha(input.map(x=>[x.key,x.revision])),
    connection: connection ?? null, historicalQualification: 'not_asserted', algorithmDefinition };
}

/** Independent BigInt decimal oracle for the fixed Polars 20-observation window. */
export function evaluateWfdMA20(source: WfdMASource['input'], unitCode: string): WfdMARow[] {
  return source.map((item, index) => {
    const window = source.slice(Math.max(0, index - 19), index + 1);
    const status = window.length < 20 ? 'warmup' as const
      : window.some(x=>x.value === null) ? 'window_missing' as const : 'valid' as const;
    const value = status === 'valid' ? meanExactDecimal(window.map(x=>x.value!)) : null;
    return { business_key: item.key, start_utc: item.start, end_utc: item.end,
      value, value_state: status === 'valid' ? 'valid_value' : 'unknown',
      calculation_status: status, unit: unitCode };
  });
}

export function checkWfdMACandidate(source: WfdMASource, candidate: WfdMARow[]): void {
  const oracle = evaluateWfdMA20(source.input, source.unitCode);
  if (sha(candidate) !== sha(oracle) || candidate.length !== source.input.length)
    fail('WFD_MA_RESULT_MISMATCH', 'Polars 移动均线候选与全量冻结来源的独立精确验证不一致。');
}

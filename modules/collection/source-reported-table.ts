import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { CandidateCellEvidence, ParsedCandidateTable } from './candidate-pipeline.js';

/** 只投影来源原报的日期/分钟标签、业务键和空格状态；不解释为交易时段或公开时间。 */
export interface CandidateSourceProjection {
  version: 'source-reported-table/1' | 'source-reported-table/2';
  dateColumn: string;
  dateEncoding: 'yyyymmdd' | 'iso-date';
  minute?: { column: string; encoding: 'iso-local-minute' };
  timezone: string;
  keyColumns: string[];
  sourceColumns: string[];
  fields: { column: string; fieldCode: string; stateColumn: string }[];
}
export const SOURCE_REPORT_COLUMNS = Object.freeze({ key: '__bd_source_key', start: '__bd_source_start', end: '__bd_source_end' });
export const SOURCE_REPORTED_MINUTE_HEADER = /^(?:分钟时间|分钟标签|minute_time|minute_timestamp)$/iu;
const fail = (message: string): never => { throw new TaskError('SOURCE_REPORTED_PROJECTION', message); };
const ownKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(name => typeof name === 'string' && !!name && name.length <= 256)
  && new Set(value).size === value.length;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function sourceReportedCode(prefix: 'src_' | 'srcunit_', original: string): string | null {
  const value = prefix + Buffer.from(original, 'utf8').toString('base64url');
  return identifier.test(value) ? value : null;
}

/** 此窄规则本身可被固定在计划中；不能以自由脚本、任意常量或行号补造记录身份。 */
export function readSourceProjection(value: unknown): CandidateSourceProjection {
  if (!isWfdRecord(value) || !ownKeys(value, ['version','dateColumn','dateEncoding','minute','timezone','keyColumns','sourceColumns','fields'])
    || !['source-reported-table/1','source-reported-table/2'].includes(String(value.version)) || typeof value.dateColumn !== 'string' || !value.dateColumn
    || !['yyyymmdd','iso-date'].includes(String(value.dateEncoding)) || typeof value.timezone !== 'string'
    || !names(value.keyColumns) || !value.keyColumns.length || !value.keyColumns.includes(value.dateColumn) || !names(value.sourceColumns)
    || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 256) return fail('来源原报投影需要明确版本、原日期列、编码、时区及含日期的原列业务键。');
  const minute = value.minute;
  if (value.version === 'source-reported-table/2'
    ? !isWfdRecord(minute) || !ownKeys(minute,['column','encoding']) || typeof minute.column !== 'string' || !minute.column
      || minute.column === value.dateColumn || minute.encoding !== 'iso-local-minute' || !value.keyColumns.includes(minute.column)
    : minute !== undefined) return fail('分钟投影须使用独立版本、明确原报分钟列及格式，并在业务键中保留分钟标签。');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { return fail('来源日期投影时区无效。'); }
  const fields = value.fields.map(field => {
    if (!isWfdRecord(field) || !ownKeys(field, ['column','fieldCode','stateColumn'])
      || typeof field.column !== 'string' || !field.column || typeof field.fieldCode !== 'string' || !identifier.test(field.fieldCode)
      || typeof field.stateColumn !== 'string' || !/^__bd_source_state_[0-9]+$/u.test(field.stateColumn)) return fail('每个来源原列须有唯一稳定字段码和受限状态列。');
    return { column: field.column, fieldCode: field.fieldCode, stateColumn: field.stateColumn };
  });
  if (new Set(fields.map(field => field.column)).size !== fields.length
    || new Set(fields.map(field => field.fieldCode)).size !== fields.length
    || new Set(fields.map(field => field.stateColumn)).size !== fields.length) fail('来源原列、字段码或状态列存在重复。');
  return { version: value.version as CandidateSourceProjection['version'], dateColumn: value.dateColumn,
    dateEncoding: value.dateEncoding as CandidateSourceProjection['dateEncoding'], timezone: value.timezone,
    ...(isWfdRecord(minute) ? {minute:{column:String(minute.column),encoding:'iso-local-minute' as const}} : {}),
    keyColumns: [...value.keyColumns], sourceColumns: [...value.sourceColumns], fields };
}

export function sourceReportedDate(value: unknown, encoding: CandidateSourceProjection['dateEncoding']): string | null {
  if (typeof value !== 'string') return null;
  const date = encoding === 'yyyymmdd' && /^\d{8}$/u.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`
    : encoding === 'iso-date' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
  if (!date) return null;
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0,10) === date ? date : null;
}

/** 保留完整本地分钟标签；秒不为零、无日期或带未经约定时区的格式均不降级成日。 */
export function sourceReportedMinute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):00$/u.exec(value);
  return match && sourceReportedDate(match[1],'iso-date') && Number(match[2]) < 24 && Number(match[3]) < 60
    ? `${match[1]}T${match[2]}:${match[3]}:00` : null;
}

/** UTC（协调世界时）区间只是本地标签的储存桶；不推断原行情标签表示开端还是终点。 */
function minuteBucket(label: string, formatter: Intl.DateTimeFormat): [string,string] {
  const target = Date.parse(label+'Z');
  const localMilliseconds = (utc: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(part=>[part.type,part.value]));
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  };
  const offsets = new Set([-86_400_000,0,86_400_000].map(delta=>localMilliseconds(target+delta)-(target+delta)));
  const instants = [...offsets].map(offset=>target-offset).filter(instant=>localMilliseconds(instant)===target);
  if (instants.length !== 1) return fail(`原报分钟 ${label} 在所选时区不能唯一对应 UTC；须提供明确时间映射。`);
  return [instants[0]!,instants[0]!+60_000].map(instant=>new Date(instant).toISOString().replace('.000Z','Z')) as [string,string];
}

/** Share the exact civil-time mapping between source projection and fixed bulk readback. */
export function createSourceReportedMinuteResolver(timezone: string): (label: string) => [string, string] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const cache = new Map<string, [string, string]>();
  return label => {
    const normalized = sourceReportedMinute(label);
    if (!normalized) return fail('原报分钟标签无效。');
    let result = cache.get(normalized);
    if (!result) {
      result = minuteBucket(normalized, formatter);
      if (cache.size < 512) cache.set(normalized, result);
    }
    return [...result];
  };
}

function midnight(date: string, timezone: string): string {
  const target = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  const localMilliseconds = (utc: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(part => [part.type, part.value]));
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const difference = target - localMilliseconds(instant);
    if (!difference) return new Date(instant).toISOString().replace('.000Z','Z');
    instant += difference;
  }
  return fail(`来源日期 ${date} 在所选时区没有可核对的午夜；须提供明确时间映射。`);
}

/** 原列不覆盖、不删减；每个新增单元格都回指实际输入单元格及固定投影规则。 */
export function projectSourceReportedTable(parsed: ParsedCandidateTable, raw: CandidateSourceProjection): ParsedCandidateTable {
  const projection = readSourceProjection(raw);
  const originalNames = parsed.columns;
  const generated = [SOURCE_REPORT_COLUMNS.key, SOURCE_REPORT_COLUMNS.start, SOURCE_REPORT_COLUMNS.end, ...projection.fields.map(field => field.stateColumn)];
  if (canonicalWfdJson(projection.sourceColumns) !== canonicalWfdJson(originalNames) || projection.fields.some(field => !originalNames.includes(field.column))
    || projection.keyColumns.some(column => !projection.fields.some(field => field.column === column))
    || projection.keyColumns.some(column => !originalNames.includes(column)) || !originalNames.includes(projection.dateColumn)
    || generated.some(column => originalNames.includes(column) || Object.hasOwn(parsed.annotations, column))
    || originalNames.length + generated.length + Object.keys(parsed.annotations).length > 256) fail('来源原报投影须绑定完整原列目录、保留所有身份轴，且不得覆盖原列或超出字段预算。');
  const dateIndex = originalNames.indexOf(projection.dateColumn), keyIndices = projection.keyColumns.map(column => originalNames.indexOf(column));
  const seen = new Set<string>();
  const resolveMinute = projection.minute && createSourceReportedMinuteResolver(projection.timezone);
  const rows = parsed.rows.map((row, rowIndex) => {
    const dateCell = row[dateIndex]!, date = sourceReportedDate(dateCell.original, projection.dateEncoding);
    if (!date) return fail(`第 ${rowIndex+1} 行「${projection.dateColumn}」不是有效的原报公历日期；未从文件名补日期。`);
    const minuteCell = projection.minute ? row[originalNames.indexOf(projection.minute.column)]! : undefined;
    const minute = minuteCell ? sourceReportedMinute(minuteCell.original) : null;
    if (projection.minute && (!minute || minute.slice(0,10) !== date)) return fail(`第 ${rowIndex+1} 行原报分钟标签无效或与原日期不同；未降级成日线。`);
    const keyCells = keyIndices.map(index => row[index]!);
    if (keyCells.some(cell => cell.original === null || cell.original === '')) fail(`第 ${rowIndex+1} 行业务键包含空格；未用行号或数值代替对象身份。`);
    const key = 'source_row_' + wfdSha256(canonicalWfdJson(keyCells.map(cell => cell.original)));
    if (seen.has(key)) fail('原报日期和选定维度存在重复业务键；请核对真实复合维度，未丢行或以行号伪造身份。');
    seen.add(key);
    const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0,10);
    const derived = (value: string, operation: NonNullable<CandidateCellEvidence['projection']>['operation'], sources: CandidateCellEvidence[], columns: string[]): CandidateCellEvidence => ({
      original: null, value, sourceType: 'null', quote: sources[0]!.quote, location: sources[0]!.location,
      projection: { version: projection.version, operation,
        sources: sources.map((cell,index) => ({ column: columns[index]!, original: cell.original, quote: cell.quote, location: cell.location })) },
    });
    let interval: [string, string];
    if (minute && resolveMinute) interval = resolveMinute(minute);
    else interval = [midnight(date,projection.timezone),midnight(nextDate,projection.timezone)];
    const timeSources = minuteCell ? [dateCell,minuteCell] : [dateCell], timeColumns = projection.minute ? [projection.dateColumn,projection.minute.column] : [projection.dateColumn];
    return [...row, derived(key, 'business_key', keyCells, projection.keyColumns),
      derived(interval[0]!, minute ? 'minute_label_start' : 'date_start', timeSources, timeColumns),
      derived(interval[1]!, minute ? 'minute_label_end' : 'date_end', timeSources, timeColumns),
      ...projection.fields.map(field => {
        const cell = row[originalNames.indexOf(field.column)]!;
        // 空格没有缺失原因；非空零也没有自动成为 reported_zero 的依据。
        return derived(cell.original === null || cell.original === '' ? 'unknown' : 'valid_value', 'value_state', [cell], [field.column]);
      })];
  });
  return { ...parsed, sourceProjection: projection, columns: [...originalNames, ...generated],
    fields: [...originalNames, ...generated, ...Object.keys(parsed.annotations)], rows };
}

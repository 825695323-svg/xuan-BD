import { readFileSync } from 'node:fs';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { checkR1Cell, parseR1Utc, compileR1TabularDeclaration, checkR1TabularRows, isR1TabularDeclaration } from './r1-tabular.js';

export const R1_EVENT_RULE_VERSION = 'bd.r1-event/2';
const implementation = wfdSha256(readFileSync(new URL(import.meta.url)));
const cellRules = compileR1TabularDeclaration(null).ruleDigest;
const fail = (message: string): never => { throw new TaskError('R1_EVENT_MAPPING', message); };
const object = (value: unknown): WfdRecord => isWfdRecord(value) ? value : fail('事件合同须为显式对象。');
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const exact = (value: WfdRecord, keys: string[]) => {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('事件合同存在缺失或未声明字段。');
};
export function isR1EventDeclaration(value: unknown): boolean {
  return isWfdRecord(value) && value.protocol === 'wfd.structured-ingest/1.0' && isWfdRecord(value.mapping) && value.mapping.kind === 'event_records';
}
function read(value: unknown) {
  const declaration = object(value), mapping = object(declaration.mapping), target = object(declaration.target);
  exact(mapping, ['kind', 'eventId', 'eventType', 'assertionKind', 'contentNature', 'status', 'eventTime', 'publicTime', 'fields', ...(mapping.expectedTime === undefined ? [] : ['expectedTime']), ...(mapping.caseId === undefined ? [] : ['caseId'])]);
  if (mapping.kind !== 'event_records' || !['source_claim', 'plan', 'forecast', 'observed_fact', 'outcome'].includes(String(mapping.contentNature)) || !identifier(mapping.status)
    || ['eventId', 'eventType', 'assertionKind'].some(key => !identifier(mapping[key]))) fail('事件交接须采用明确的既有WFD性质和状态。');
  if (['plan', 'forecast'].includes(String(mapping.contentNature)) && (!mapping.expectedTime || ['completed', 'realized'].includes(String(mapping.status)))) fail('计划或预测须有明确预计时间（可unknown），不能冒充已完成事实。');
  for (const key of ['eventTime', 'publicTime', ...(mapping.expectedTime === undefined ? [] : ['expectedTime'])]) readTimeMapping(mapping[key]);
  if (!Array.isArray(mapping.fields) || !mapping.fields.length || mapping.fields.length > 256) fail('需要明确逐字段映射。');
  const fields = (mapping.fields as unknown[]).map(value => { const field = object(value); exact(field, ['fieldCode', 'value', 'state']);
    if (Object.values(field).some(value => !identifier(value))) fail('映射列须有界且明确。'); return field; });
  if (new Set(fields.map(field => field.fieldCode)).size !== fields.length) fail('映射字段重复。');
  if (mapping.caseId !== undefined && !identifier(mapping.caseId)) fail('事件case身份必须映射到实际列。');
  const definition = object(target.definition), context = object(definition.semantic_context);
  if (context.version !== 'wfd.semantic-context/1.0' || context.content_nature !== (mapping.contentNature === 'outcome' ? 'actual_outcome' : mapping.contentNature)
    || definition.time_role !== 'event' || definition.measurement_nature !== 'event' || definition.unit_code !== 'not_applicable') fail('事件目标须明确为event角色的匹配行性质的逐字段合同。');
  const subject = object(target.subject), coverage = object(target.coverage);
  if (['kind', 'namespace', 'id'].some(key => !identifier(subject[key])) || !isWfdRecord(coverage.scope)
    || !Object.keys(coverage.scope).length || ['basis', 'completeness', 'absence_means'].some(key => typeof coverage[key] !== 'string' || !String(coverage[key]).trim())) fail('主体与覆盖须完整明确，不能猜测。');
  if (Array.isArray(context.unknown_axes) && context.unknown_axes.some(axis => ['identity', 'measurement', 'content'].includes(String(axis)))) fail('事件身份、计量或主张性质仍不确定。');
  const definitions = definition.field_definitions;
  if (!Array.isArray(definitions) || definitions.length !== fields.length || !definitions.every(isWfdRecord)
    || new Set(definitions.map(field => field.field_code)).size !== fields.length
    || definitions.some(field => !fields.some(rule => rule.fieldCode === field.field_code)
      || !['decimal', 'integer', 'text', 'boolean'].includes(String(field.data_type)) || !identifier(field.unit_code)
      || field.time_role !== 'event' || !identifier(field.measurement_nature))) fail('事件逐字段定义必须与映射精确一致。');
  return { mapping, target, fields, definitions: definitions as WfdRecord[] };
}
export function compileR1EventDeclaration(value: unknown) {
  const applicable = isR1EventDeclaration(value);
  if (applicable) read(value);
  return { applicable, ruleVersion: R1_EVENT_RULE_VERSION, ruleDigest: wfdSha256(canonicalWfdJson({ value, implementation, cellRules })),
    checkScope: ['explicit_event_nature_mapping', 'distinct_event_public_expected_time', 'no_event_truth_inference'], gaps: [] as string[] };
}
export function checkR1EventRows(rows: unknown[], value: unknown) {
  const compiled = compileR1EventDeclaration(value), { mapping, target, fields, definitions } = read(value);
  if (!rows.length || rows.length > 5000) fail('事件小切片需要1–5000行，不截断。');
  const seen = new Set<string>();
  const mapped = rows.map(raw => {
    const row = object(raw), eventId = row[String(mapping.eventId)], eventType = row[String(mapping.eventType)];
    if (!identifier(eventId) || !identifier(eventType) || row[String(mapping.assertionKind)] !== mapping.contentNature) fail('实际加工行缺明确事件身份/类型/来源主张，禁止将计划或主张洗成事实。');
    if (target.inputMode !== 'partial_observation' && seen.has(String(eventId))) fail('事件键重复。'); seen.add(String(eventId));
    if (mapping.caseId !== undefined && !identifier(row[String(mapping.caseId)])) fail('实际事件case身份缺失或无效，不猜计划与结果关系。');
    const values: WfdRecord = {};
    for (const field of definitions) {
      const rule = fields.find(rule => rule.fieldCode === field.field_code)!;
      if (!Object.hasOwn(row, String(rule.value)) || typeof row[String(rule.state)] !== 'string') fail('实际事件字段及值状态列缺失。');
      const cell = row[String(rule.value)], state = String(row[String(rule.state)]);
      checkR1Cell(String(field.data_type), state, cell, String(field.field_code));
      values[String(field.field_code)] = { data_type: field.data_type, value_state: state, value: cell };
    }
    return { event_id: eventId, ...(mapping.caseId === undefined ? {} : { case_id: row[String(mapping.caseId)] }), subject: target.subject, event_type: eventType, content_nature: mapping.contentNature,
      event_time: mappedTime(row, mapping.eventTime), public_time: mappedTime(row, mapping.publicTime),
      ...(mapping.expectedTime === undefined ? {} : { expected_time: mappedTime(row, mapping.expectedTime) }), status: mapping.status, values };
  });
  return { ...compiled, rows: mapped, quality: 'pass' as const };
}
export const isR1MappedDeclaration = (value: unknown) => isR1TabularDeclaration(value) || isR1EventDeclaration(value);
export const compileR1MappedDeclaration = (value: unknown) => isR1EventDeclaration(value) ? compileR1EventDeclaration(value) : compileR1TabularDeclaration(value);
export const checkR1MappedRows = (rows: unknown[], value: unknown) => isR1EventDeclaration(value) ? checkR1EventRows(rows, value) : checkR1TabularRows(rows, value);

function readTimeMapping(value: unknown): WfdRecord {
  const time = object(value);
  exact(time, ['status', 'sourceTimezone', ...(time.status === 'known' ? ['earliestUtc', 'latestExclusiveUtc', 'precision'] : [])]);
  if (!['known', 'unknown'].includes(String(time.status)) || typeof time.sourceTimezone !== 'string' || !time.sourceTimezone) fail('事件时间状态与时区须明确。');
  try { new Intl.DateTimeFormat('en', { timeZone: String(time.sourceTimezone) }); } catch { fail('时区无效。'); }
  if (time.status === 'known' && (!identifier(time.earliestUtc) || !identifier(time.latestExclusiveUtc) || !['day', 'minute', 'second'].includes(String(time.precision)))) fail('已知事件时间须为精度明确的实际列映射。');
  return time;
}
function mappedTime(row: WfdRecord, value: unknown): WfdRecord {
  const time = readTimeMapping(value);
  if (time.status === 'unknown') return { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: time.sourceTimezone };
  const start = row[String(time.earliestUtc)], end = row[String(time.latestExclusiveUtc)];
  if (typeof start !== 'string' || typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(start)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(end) || !Number.isFinite(parseR1Utc(start)) || !Number.isFinite(parseR1Utc(end))
    || parseR1Utc(end) <= parseR1Utc(start)) fail('事件各时间角色须为有效原值UTC区间，不滚转、不补日期或丢弃精度。');
  return { status: 'known', precision: time.precision, earliest_utc: start, latest_exclusive_utc: end, source_timezone: time.sourceTimezone };
}

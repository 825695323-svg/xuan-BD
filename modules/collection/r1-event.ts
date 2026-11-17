import { readFileSync } from 'node:fs';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { checkR1Cell, compileR1TabularDeclaration, checkR1TabularRows, isR1TabularDeclaration } from './r1-tabular.js';

export const R1_EVENT_RULE_VERSION = 'bd.r1-event-source-claim/1';
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
  exact(mapping, ['kind', 'eventId', 'eventType', 'assertionKind', 'contentNature', 'status', 'eventTime', 'publicTime', 'fields']);
  if (mapping.kind !== 'event_records' || mapping.contentNature !== 'source_claim' || mapping.status !== 'unknown'
    || ['eventId', 'eventType', 'assertionKind'].some(key => !identifier(mapping[key]))) fail('首批事件交接仅支持显式来源主张，不支持推断已发生事实或生命周期。');
  for (const key of ['eventTime', 'publicTime']) {
    const time = object(mapping[key]); exact(time, ['status', 'sourceTimezone']);
    if (typeof time.sourceTimezone !== 'string' || !time.sourceTimezone) fail('未知时间仍须明确存储时区。');
    try { new Intl.DateTimeFormat('en', { timeZone: String(time.sourceTimezone) }); } catch { fail('时区无效。'); }
    if (time.status !== 'unknown') fail('未知事件和公开时间不能以取得时间、预计时间或默认时间补造。');
  }
  if (!Array.isArray(mapping.fields) || !mapping.fields.length || mapping.fields.length > 256) fail('需要明确逐字段映射。');
  const fields = (mapping.fields as unknown[]).map(value => { const field = object(value); exact(field, ['fieldCode', 'value', 'state']);
    if (Object.values(field).some(value => !identifier(value))) fail('映射列须有界且明确。'); return field; });
  if (new Set(fields.map(field => field.fieldCode)).size !== fields.length) fail('映射字段重复。');
  const definition = object(target.definition), context = object(definition.semantic_context);
  if (context.version !== 'wfd.semantic-context/1.0' || context.content_nature !== 'source_claim'
    || definition.time_role !== 'event' || definition.measurement_nature !== 'event' || definition.unit_code !== 'not_applicable') fail('事件目标须明确为event角色的source_claim逐字段合同。');
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
    checkScope: ['explicit_source_claim_event_mapping', 'unknown_event_and_public_time', 'no_event_truth_inference'], gaps: [] as string[] };
}
export function checkR1EventRows(rows: unknown[], value: unknown) {
  const compiled = compileR1EventDeclaration(value), { mapping, target, fields, definitions } = read(value);
  if (!rows.length || rows.length > 5000) fail('事件小切片需要1–5000行，不截断。');
  const seen = new Set<string>();
  const mapped = rows.map(raw => {
    const row = object(raw), eventId = row[String(mapping.eventId)], eventType = row[String(mapping.eventType)];
    if (!identifier(eventId) || !identifier(eventType) || row[String(mapping.assertionKind)] !== 'source_claim') fail('实际加工行缺明确事件身份/类型/来源主张，禁止将计划或主张洗成事实。');
    if (target.inputMode !== 'partial_observation' && seen.has(String(eventId))) fail('事件键重复。'); seen.add(String(eventId));
    const values: WfdRecord = {};
    for (const field of definitions) {
      const rule = fields.find(rule => rule.fieldCode === field.field_code)!;
      if (!Object.hasOwn(row, String(rule.value)) || typeof row[String(rule.state)] !== 'string') fail('实际事件字段及值状态列缺失。');
      const cell = row[String(rule.value)], state = String(row[String(rule.state)]);
      checkR1Cell(String(field.data_type), state, cell, String(field.field_code));
      values[String(field.field_code)] = { data_type: field.data_type, value_state: state, value: cell };
    }
    return { event_id: eventId, subject: target.subject, event_type: eventType, content_nature: 'source_claim',
      event_time: { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: object(mapping.eventTime).sourceTimezone },
      public_time: { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: object(mapping.publicTime).sourceTimezone }, status: 'unknown', values };
  });
  return { ...compiled, rows: mapped, quality: 'pass' as const };
}
export const isR1MappedDeclaration = (value: unknown) => isR1TabularDeclaration(value) || isR1EventDeclaration(value);
export const compileR1MappedDeclaration = (value: unknown) => isR1EventDeclaration(value) ? compileR1EventDeclaration(value) : compileR1TabularDeclaration(value);
export const checkR1MappedRows = (rows: unknown[], value: unknown) => isR1EventDeclaration(value) ? checkR1EventRows(rows, value) : checkR1TabularRows(rows, value);

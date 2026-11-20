import { readFileSync } from 'node:fs';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { checkR1Cell, compileR1TabularDeclaration, parseR1Utc } from './r1-tabular.js';

export const R1_RELATION_RULE_VERSION = 'bd.r1-relation/1';
const implementation = wfdSha256(readFileSync(new URL(import.meta.url)));
const commonSchema = readFileSync(new URL('../../wfd/product/protocol/schemas/wfd-common.schema.json', import.meta.url));
const identityKinds: readonly string[] = JSON.parse(commonSchema.toString('utf8')).$defs.IdentityRef.properties.kind.enum;
const cellRules = compileR1TabularDeclaration(null).ruleDigest;
const COMPLETE_SNAPSHOT_ALLOWED_RELATIONS = new Set([
  'classified_as', 'member_of_theme', 'parent_theme_of',
  'cross_market_theme_map', 'commodity_industry_map', 'listed_as',
]);
const NON_COMPLETE_RELATION_TYPES = new Set([
  'trade_flow_projection', 'supplies_to', 'purchases_from', 'competes_with',
  'logistics_connected_via', 'process_input_to', 'conditionally_substitutable_by',
]);
const NON_COMPLETE_DOMAINS = new Set(['bilateral_trade', 'supply_chain_observation', 'trade_observation']);
const fail = (message: string): never => { throw new TaskError('R1_RELATION_MAPPING', message); };
const object = (value: unknown): WfdRecord => isWfdRecord(value) ? value : fail('关系合同及实际行必须是明确对象。');
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
function exact(value: WfdRecord, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('关系映射存在缺失或未声明字段。');
}
function identity(value: unknown): WfdRecord {
  const ref = object(value); exact(ref, ['kind', 'namespace', 'id']);
  if (!identityKinds.includes(String(ref.kind)) || !identifier(ref.namespace) || !identifier(ref.id)) fail('关系主体或客体必须是完整既有 IdentityRef，不从名称推断身份。');
  return { ...ref };
}
function timeMapping(value: unknown): WfdRecord {
  const time = object(value);
  exact(time, ['status', 'sourceTimezone', ...(time.status === 'known' ? ['earliestUtc', 'latestExclusiveUtc', 'precision'] : [])]);
  if (!['known', 'unknown'].includes(String(time.status)) || typeof time.sourceTimezone !== 'string' || !time.sourceTimezone) fail('关系时间须明确 known/unknown 和时区。');
  try { new Intl.DateTimeFormat('en', { timeZone: String(time.sourceTimezone) }); } catch { fail('关系时区无效。'); }
  if (time.status === 'known' && (!identifier(time.earliestUtc) || !identifier(time.latestExclusiveUtc) || !['day', 'minute', 'second'].includes(String(time.precision)))) fail('已知关系时间须映射实际 UTC 列并声明精度。');
  return time;
}
function mappedTime(row: WfdRecord, value: unknown): WfdRecord {
  const time = timeMapping(value);
  if (time.status === 'unknown') return { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: time.sourceTimezone };
  const start = row[String(time.earliestUtc)], end = row[String(time.latestExclusiveUtc)];
  if (typeof start !== 'string' || typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(start)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(end) || !Number.isFinite(parseR1Utc(start)) || !Number.isFinite(parseR1Utc(end))
    || parseR1Utc(end) <= parseR1Utc(start)) fail('关系时间必须是有效原值 UTC 区间；不补日期、滚转或截去精度。');
  return { status: 'known', precision: time.precision, earliest_utc: start, latest_exclusive_utc: end, source_timezone: time.sourceTimezone };
}
export function isR1RelationDeclaration(value: unknown): boolean {
  return isWfdRecord(value) && value.protocol === 'wfd.structured-ingest/1.0' && isWfdRecord(value.mapping) && value.mapping.kind === 'relation_edges';
}
function read(value: unknown) {
  const declaration = object(value);
  if (!isR1RelationDeclaration(declaration)) fail('关系交接须使用现有 WFD relation_edges 合同。');
  const mapping = object(declaration.mapping), target = object(declaration.target);
  exact(mapping, ['kind', 'businessKey', 'relationType', 'object', 'effectivePeriod', 'publicTime', 'fields']);
  if (!identifier(mapping.businessKey) || !identifier(mapping.relationType)) fail('关系键和类型必须映射实际列。');
  const objectColumns = object(mapping.object); exact(objectColumns, ['kind', 'namespace', 'id']);
  if (Object.values(objectColumns).some(value => !identifier(value))) fail('关系客体三元组必须逐列显式映射。');
  timeMapping(mapping.effectivePeriod); timeMapping(mapping.publicTime);
  const subject = identity(target.subject);
  const inputMode = String(target.inputMode ?? '');
  if (!['partial_observation', 'complete_snapshot', 'source_correction'].includes(inputMode)) {
    fail('关系切片仅支持 partial_observation、显式成分集 complete_snapshot 或有修订依据的 source_correction。');
  }
  const definition = object(target.definition), context = object(definition.semantic_context), coverage = object(target.coverage);
  if (context.version !== 'wfd.semantic-context/1.0' || context.content_nature !== 'source_claim'
    || definition.measurement_nature !== 'relation' || definition.time_role !== 'validity' || definition.unit_code !== 'not_applicable'
    || !identifier(definition.semantic_code) || !identifier(definition.definition_authority)) fail('关系目标只能是显式 source_claim、relation/validity 合同，不宣称事实核实。');
  if (Array.isArray(context.unknown_axes) && context.unknown_axes.some(axis => ['identity', 'measurement', 'content'].includes(String(axis)))) fail('关系身份、计量或主张性质仍未知。');
  if (!isWfdRecord(coverage.scope) || !Object.keys(coverage.scope).length) fail('关系覆盖范围不能为空。');
  if (inputMode === 'partial_observation') {
    if (['definitionMode', 'definitionRef', 'revisions'].some(key => Object.hasOwn(target, key))) {
      fail('partial_observation 关系切片不携带隐式修订或定义复用引用。');
    }
    if (coverage.basis !== 'observed_partial' || coverage.completeness !== 'partial' || coverage.absence_means !== 'unknown') {
      fail('局部观察关系切片须显式部分覆盖（observed_partial / partial / unknown），未出现不能推断不存在。');
    }
  } else if (inputMode === 'complete_snapshot') {
    if (['definitionMode', 'definitionRef', 'revisions'].some(key => Object.hasOwn(target, key))) {
      fail('complete_snapshot 关系切片不携带单行修订映射。');
    }
    const scope = object(coverage.scope);
    const scopeKeys = Object.keys(scope);
    const domain = String(scope.domain ?? scope.product ?? '');
    const validWfdScope = scopeKeys.length > 0 && scopeKeys.every(k => ['product', 'business_keys'].includes(k))
      && (scope.product === undefined || identifier(scope.product))
      && (scope.business_keys === undefined || (Array.isArray(scope.business_keys) && scope.business_keys.length > 0 && scope.business_keys.every(identifier)));
    if (!validWfdScope || NON_COMPLETE_DOMAINS.has(domain)
      || coverage.basis !== 'declared_full' || coverage.completeness !== 'complete' || coverage.absence_means !== 'explicitly_absent') {
      fail('完整关系快照仅允许使用 WFD 支持的 product/business_keys 作用域，且限可证明完整性的成分集（declared_full / complete / explicitly_absent）；贸易缺报或供应链观测不能声称未出现即关系终止。');
    }
  } else {
    if (target.definitionMode !== 'reuse' || !isWfdRecord(target.definitionRef) || !isWfdRecord(target.revisions)
      || !Object.keys(target.revisions).length) {
      fail('source_correction 关系修订必须显式复用既有定义并提供非空 revisions 前驱映射。');
    }
    const revisions = target.revisions as WfdRecord;
    for (const [revKey, revVal] of Object.entries(revisions)) {
      const prev = isWfdRecord(revVal) && isWfdRecord(revVal.previous) ? revVal.previous : null;
      if (!identifier(revKey) || !isWfdRecord(revVal) || !prev
        || !['product_id', 'logical_key', 'revision_id'].every(k => identifier(prev[k]))
        || (prev.snapshot_id !== undefined && !identifier(prev.snapshot_id))
        || prev.logical_key !== revKey
        || typeof revVal.reason !== 'string' || revVal.reason.trim().length < 4) {
        fail('关系修订须逐键绑定前驱记录身份（product_id/snapshot_id/logical_key/revision_id 且键一致）及明确修订原因。');
      }
    }
    if (coverage.basis !== 'observed_partial' || coverage.completeness !== 'partial' || coverage.absence_means !== 'unknown') {
      fail('source_correction 关系修订须保持局部观察覆盖声明（observed_partial / partial / unknown）。');
    }
  }
  if (!Array.isArray(mapping.fields) || !mapping.fields.length || mapping.fields.length > 256) fail('关系字段映射需要1–256个明确字段。');
  const fields = (mapping.fields as unknown[]).map(value => {
    const field = object(value); exact(field, ['fieldCode', 'value', 'state']);
    if (Object.values(field).some(value => !identifier(value))) fail('关系字段映射必须包含实际值与状态列。');
    return field;
  });
  const definitions = definition.field_definitions;
  if (!Array.isArray(definitions) || definitions.length !== fields.length || !definitions.every(isWfdRecord)
    || new Set(fields.map(field => field.fieldCode)).size !== fields.length
    || new Set(definitions.map(field => field.field_code)).size !== fields.length) fail('关系字段定义与映射必须精确一一对应。');
  for (const field of definitions as WfdRecord[]) {
    if (!fields.some(rule => rule.fieldCode === field.field_code) || !['decimal', 'integer', 'text', 'boolean'].includes(String(field.data_type))
      || !identifier(field.unit_code) || field.measurement_nature !== 'relation' || field.time_role !== 'validity') fail('关系字段类型、计量和时间角色须与明确合同一致。');
  }
  return { mapping, target, objectColumns, subject, fields, definitions: definitions as WfdRecord[] };
}
export function compileR1RelationDeclaration(value: unknown) {
  const applicable = isR1RelationDeclaration(value);
  if (applicable) read(value);
  return { applicable, ruleVersion: R1_RELATION_RULE_VERSION,
    ruleDigest: wfdSha256(canonicalWfdJson({ value, implementation, cellRules, identitySchema: wfdSha256(commonSchema) })),
    checkScope: ['explicit_relation_identity_columns', 'independent_public_and_effective_time', 'source_claim_only_no_relation_inference'], gaps: [] as string[] };
}
export function checkR1RelationRows(rows: unknown[], value: unknown) {
  const compiled = compileR1RelationDeclaration(value), { mapping, target, objectColumns, subject, fields, definitions } = read(value);
  if (!rows.length || rows.length > 5000) fail('关系小切片需要1–5000行，不截断。');
  const seenKeys = new Set<string>();
  const mapped: WfdRecord[] = rows.map(raw => {
    const row = object(raw), key = row[String(mapping.businessKey)], type = row[String(mapping.relationType)];
    if (!identifier(key) || !identifier(type)) fail('实际关系键或类型缺失，不自动生成。');
    if (target.inputMode === 'complete_snapshot') {
      if (NON_COMPLETE_RELATION_TYPES.has(String(type)) || !COMPLETE_SNAPSHOT_ALLOWED_RELATIONS.has(String(type))) {
        fail(`关系类型 ${String(type)} 不属于可证明完整性的分类或成分集关系，不能作为 complete_snapshot 推断未出现即关系终止。`);
      }
      if (seenKeys.has(String(key))) fail(`完整关系快照中业务键 ${String(key)} 重复。`);
      seenKeys.add(String(key));
    } else if (target.inputMode === 'source_correction') {
      if (!Object.hasOwn(target.revisions as WfdRecord, String(key))) {
        fail(`source_correction 关系修订行 ${String(key)} 缺少对应的 revisions 前驱记录声明。`);
      }
      if (seenKeys.has(String(key))) fail(`关系修订中业务键 ${String(key)} 重复。`);
      seenKeys.add(String(key));
    }
    const objectRef = identity(Object.fromEntries(Object.entries(objectColumns).map(([key, column]) => [key, row[String(column)]])));
    const values: WfdRecord = {};
    for (const field of definitions as WfdRecord[]) {
      const rule = fields.find(rule => rule.fieldCode === field.field_code)!;
      if (!Object.hasOwn(row, String(rule.value)) || typeof row[String(rule.state)] !== 'string') fail('实际关系字段或值状态缺失。');
      const cell = row[String(rule.value)], state = String(row[String(rule.state)]);
      checkR1Cell(String(field.data_type), state, cell, String(field.field_code));
      values[String(field.field_code)] = { data_type: field.data_type, value_state: state, value: cell };
    }
    return { business_key: key, subject: { ...subject }, object: objectRef, relation_type: type,
      effective_period: mappedTime(row, mapping.effectivePeriod), public_time: mappedTime(row, mapping.publicTime), values };
  });
  // Duplicate append/conflict decisions remain with existing WFD admission.
  return { ...compiled, rows: mapped, quality: 'pass' as const };
}

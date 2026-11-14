import { constants, openSync, closeSync, fstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1PrepareInput, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { TABULAR_CONTRACT_VERSION, TABULAR_FIELD_CODE, readTabularTableContract, tabularDigest, tabularIdentityRule,
  type TabularTableContract } from '../../contracts/tabular-batch.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { parseTableSource } from './candidate-pipeline.js';
import { resolveSourceReportedEvidence } from './r1-evidence.js';
import { profileFingerprint, readSourceFieldProfile, sourceFieldProfileDigest,
  type FrozenSourceFieldProfile, type SourceFieldProfile, type SourceFieldProfileStore } from './source-field-profile.js';

export const TABULAR_BULK_PROFILE_VERSION = 'bd.tabular-bulk-profile/1' as const;
export interface TabularBulkProfileColumn { originalHeader: string; aliases?: string[]; fieldCode: string }
export type TabularBulkTargetTemplate = Omit<R1PrepareInput['target'], 'datasetId' | 'expectedParentSnapshotId'>;
interface ProfileBase {
  version: typeof TABULAR_BULK_PROFILE_VERSION;
  profileId: string;
  /** 仅兼容旧版已冻结登记；当前来源字段语义无需映射修订序号。 */
  mappingVersion?: number;
  sourceId: string;
  series: string;
  confirmation: { basis: string; confirmedBy: string; confirmedAtUtc: string };
  columns: TabularBulkProfileColumn[];
  tableContract: TabularTableContract;
}
export type RegisteredTabularBulkProfile = ProfileBase & { targetTemplate: TabularBulkTargetTemplate };
export type TabularBulkProfile = RegisteredTabularBulkProfile |
  (ProfileBase & { sourceFieldProfile: FrozenSourceFieldProfile });
export interface FrozenTabularBulkProfile { profile: TabularBulkProfile; digest: string }

const fail = (message: string): never => { throw new TaskError('TABULAR_BULK_PROFILE', message); };
const allowed = (value: WfdRecord, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= limit && !/[\p{Cc}\p{Cs}]/u.test(value);
const realBasis = (value: unknown): value is string => text(value) && value.trim().length >= 8
  && !/^(authorized|approved|unknown|pending|待核|待确认|已确认|无依据)$/iu.test(value.trim());
const code = (value: unknown): value is string => typeof value === 'string' && TABULAR_FIELD_CODE.test(value);

function validateDefinition(definition: WfdRecord, table: TabularTableContract) {
  const fields = definition.field_definitions, context = definition.semantic_context;
  if (Object.hasOwn(definition, 'algorithm_definition') || !Array.isArray(fields) || fields.length !== table.fields.length
    || fields.some((field, i) => !isWfdRecord(field) || field.field_code !== table.fields[i] || field.data_type !== 'text'
      || !code(field.unit_code) || !text(field.measurement_nature) || !text(field.time_role))
    || !isWfdRecord(context) || context.version !== 'wfd.semantic-context/1.0' || context.content_nature !== 'source_claim'
    || !isWfdRecord(context.identity) || context.identity.identity_resolution_rule !== tabularIdentityRule(table))
    return fail('产品定义须按契约顺序覆盖全部原文列、登记单位和身份规则，并保留来源原报语义。');
  const time = context.time;
  if (table.time.kind === 'unknown') {
    if (time !== undefined && (!isWfdRecord(time) || !allowed(time, ['roles'])
      || (time.roles !== undefined && (!isWfdRecord(time.roles) || !allowed(time.roles, ['public_time']) || time.roles.public_time !== 'unknown'))))
      fail('未知时间轴不得声明频率、时区或已确认的公开时间。');
  } else {
    const fieldContexts = definition.field_semantic_context;
    const claim = (key: string) => {
      const field = isWfdRecord(fieldContexts) && fieldContexts[key];
      return isWfdRecord(field) && isWfdRecord(field.content) ? field.content.assertion_status : null;
    };
    if (!isWfdRecord(time) || time.period_type !== 'natural' || time.frequency !== 'source_reported_minute'
      || time.interval !== 'half_open' || time.timezone !== table.time.timezone || !isWfdRecord(time.roles)
      || time.roles.business_interval !== 'minute_label_bucket_not_verified_bar_interval' || time.roles.public_time !== 'unknown'
      || claim(table.time.date_field) !== 'source_reported_date_label' || claim(table.time.minute_field) !== 'source_reported_minute_label')
      fail('分钟语义与契约登记的原报日期、分钟、时区或半开储存桶不一致。');
  }
}

export function readTabularBulkProfile(value: unknown): RegisteredTabularBulkProfile {
  if (!isWfdRecord(value) || !allowed(value, ['version','profileId','mappingVersion','sourceId','series','confirmation','columns','tableContract','targetTemplate'])
    || value.version !== TABULAR_BULK_PROFILE_VERSION || !text(value.profileId) || !text(value.sourceId) || !text(value.series)
    || (value.mappingVersion !== undefined && (!Number.isSafeInteger(value.mappingVersion) || Number(value.mappingVersion) < 1)))
    return fail('宿主登记档案版本、编号、来源或系列不完整。');
  const confirmation = value.confirmation;
  if (!isWfdRecord(confirmation) || !allowed(confirmation, ['basis','confirmedBy','confirmedAtUtc'])
    || !realBasis(confirmation.basis) || !text(confirmation.confirmedBy)
    || typeof confirmation.confirmedAtUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(confirmation.confirmedAtUtc)
    || !Number.isFinite(Date.parse(confirmation.confirmedAtUtc))
    || new Date(confirmation.confirmedAtUtc).toISOString().replace('.000Z','Z') !== confirmation.confirmedAtUtc.replace('.000Z','Z'))
    return fail('档案缺少有效审核人、明确审核时间或实际审核依据。');
  const table = readTabularTableContract(value.tableContract);
  const headers = new Set<string>(), fieldCodes = new Set<string>();
  if (!Array.isArray(value.columns) || value.columns.length !== table.fields.length) return fail('档案列须完整覆盖契约字段。');
  for (const column of value.columns) {
    if (!isWfdRecord(column) || !allowed(column, ['originalHeader','aliases','fieldCode']) || !text(column.originalHeader)
      || typeof column.fieldCode !== 'string' || !table.fields.includes(column.fieldCode) || fieldCodes.has(column.fieldCode)
      || (column.aliases !== undefined && (!Array.isArray(column.aliases) || !column.aliases.every(name => text(name)))))
      return fail('原列、别名与契约字段须完整一一对应。');
    fieldCodes.add(column.fieldCode);
    for (const header of [column.originalHeader, ...(Array.isArray(column.aliases) ? column.aliases as string[] : [])]) {
      if (headers.has(header)) return fail('原列表头或别名重复。');
      headers.add(header);
    }
  }
  const target = value.targetTemplate;
  if (!isWfdRecord(target) || !allowed(target, ['outputKey','subject','definition','inputMode','coverage'])
    || !code(target.outputKey) || target.inputMode !== 'partial_observation'
    || !isWfdRecord(target.subject) || !allowed(target.subject, ['kind','id'])
    || !text(target.subject.id) || !text(target.subject.kind)
    || !isWfdRecord(target.definition) || Object.hasOwn(target.definition,'definition_authority') || !text(target.definition.semantic_code)
    || !text(target.definition.measurement_nature) || target.definition.unit_code !== 'per_field' || !text(target.definition.time_role)
    || !isWfdRecord(target.coverage) || !isWfdRecord(target.coverage.scope) || target.coverage.scope.subject_id !== target.subject.id)
    return fail('已审核目标须绑定主体、逐字段定义和覆盖范围，命名空间、数据集及父快照由宿主填写。');
  validateDefinition(target.definition, table);
  return structuredClone(value) as unknown as RegisteredTabularBulkProfile;
}

const freeze = (profile: TabularBulkProfile): FrozenTabularBulkProfile => ({ profile, digest: tabularDigest(profile) });

/** The existing minute source archive supplies semantics, never channel or parser selection. */
export function adaptSourceMinuteBulkProfile(input: FrozenSourceFieldProfile): FrozenTabularBulkProfile | null {
  const profile = readSourceFieldProfile(input.profile, 'tabular-bulk-source-minute');
  if (sourceFieldProfileDigest(profile) !== input.digest || profileFingerprint(profile) !== input.fingerprint)
    return fail('来源档案摘要不一致。');
  const byRole = (role: string) => profile.fields.filter(field => field.role === role);
  const { timeBucket } = profile, dates = byRole('date'), minutes = byRole('minute'), identities = byRole('identity');
  if (!profile.series || profile.adapter || profile.frequency !== 'minute' || timeBucket.lengthMinutes !== 1
    || timeBucket.labelSemantics !== 'unknown' || timeBucket.interval !== 'unknown' || profile.adjustment.status !== 'unknown'
    || dates.length !== 1 || minutes.length !== 1 || !identities.length || profile.fields.some(field => field.dataType !== 'text'))
    return null;
  const date_field = dates[0]!.fieldCode, minute_field = minutes[0]!.fieldCode;
  const contract = { version: TABULAR_CONTRACT_VERSION, fields: profile.fields.map(field => field.fieldCode),
    key_fields: [...identities.map(field => field.fieldCode), minute_field], partition_field: date_field,
    time: { kind: 'source_minute', date_field, minute_field, timezone: timeBucket.timezone } } as const;
  const tableContract = readTabularTableContract({ ...contract, digest: tabularDigest(contract) });
  const columns = profile.fields.map(({ originalHeader, aliases, fieldCode }) =>
    ({ originalHeader, ...(aliases === undefined ? {} : { aliases }), fieldCode }));
  return freeze({ version: TABULAR_BULK_PROFILE_VERSION, profileId: profile.profileId,
    ...(profile.mappingVersion === undefined ? {} : { mappingVersion: profile.mappingVersion }),
    sourceId: profile.sourceId, series: profile.series, confirmation: { ...profile.confirmation, confirmedBy: 'legacy-source-field-profile' },
    columns, tableContract, sourceFieldProfile: { profile, digest: input.digest, fingerprint: input.fingerprint } });
}

export function freezeRegisteredTabularBulkProfile(value: unknown): FrozenTabularBulkProfile {
  return freeze(readTabularBulkProfile(value));
}

export function verifyFrozenTabularBulkProfile(value: FrozenTabularBulkProfile): FrozenTabularBulkProfile {
  const frozen = 'sourceFieldProfile' in value.profile ? adaptSourceMinuteBulkProfile(value.profile.sourceFieldProfile)
    : freezeRegisteredTabularBulkProfile(value.profile);
  if (!frozen || frozen.digest !== value.digest || tabularDigest(value.profile) !== value.digest) return fail('冻结语义档案已改变。');
  return frozen;
}

function readRegistration(path: string): FrozenTabularBulkProfile {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) return fail('已审核语义档案不是普通文件或超过配置预算。');
    return freezeRegisteredTabularBulkProfile(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}

export class TabularBulkProfileStore {
  constructor(private readonly directory: string, private readonly sourceFields?: SourceFieldProfileStore) {}
  match(input: { sourceId: string; series: string; profileId?: string }): FrozenTabularBulkProfile | null {
    let names: string[];
    try { names = readdirSync(this.directory).filter(name => name.endsWith('.json')).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    const hits = names.map(name => readRegistration(join(this.directory, name))).filter(({ profile }) =>
      profile.sourceId === input.sourceId && profile.series === input.series && (input.profileId === undefined || profile.profileId === input.profileId));
    if (hits.length > 1) return fail('来源系列同时命中多个已审核语义档案；须显式指定唯一档案。');
    if (hits.length) return hits[0]!;
    const legacy: SourceFieldProfile | null | undefined = this.sourceFields?.match({ sourceId: input.sourceId, series: input.series });
    if (!legacy || legacy.series !== input.series || (input.profileId !== undefined && legacy.profileId !== input.profileId)) return null;
    return adaptSourceMinuteBulkProfile({ profile: legacy, digest: sourceFieldProfileDigest(legacy), fingerprint: profileFingerprint(legacy) });
  }
}

export function buildTabularBulkTarget(input: { profile: FrozenTabularBulkProfile; namespace: string; datasetId: string;
  parentSnapshotId: string | null; source: R1SourceDeclaration; materialId: string }, actual: Buffer, columns: string[]): R1PrepareInput['target'] {
  const { profile } = input.profile;
  if ('targetTemplate' in profile) {
    const target = structuredClone(profile.targetTemplate);
    target.subject.namespace = input.namespace;
    target.definition.definition_authority = input.namespace;
    return { ...target, datasetId: input.datasetId, expectedParentSnapshotId: input.parentSnapshotId };
  }
  const table = profile.tableContract, time = table.time;
  if (time.kind !== 'source_minute') return fail('原报分钟档案缺少登记时间映射。');
  const name = (field: string) => columns[table.fields.indexOf(field)]!;
  const date = name(time.date_field), minute = name(time.minute_field);
  const actualTable = parseTableSource(actual, { materialId: input.materialId, format: 'csv' });
  const review = resolveSourceReportedEvidence({ namespace: input.namespace, datasetId: input.datasetId, parentSnapshotId: input.parentSnapshotId,
    source: input.source, sourceFieldProfile: profile.sourceFieldProfile,
    registeredKeyColumns: [date, minute, ...table.key_fields.filter(field => field !== time.minute_field).map(name)],
    answers: { source_series: profile.series,
      [/^(?:交易日期|trade_date)$/iu.test(date) ? 'source_trade_date_timezone' : 'source_date_timezone']: time.timezone } }, actualTable, 'csv');
  if (!review.proposal || review.questions.length)
    return fail('来源原报档案仍有待核证据：' + review.questions.map(question => question.key).join(', '));
  const projection = review.proposal.sourceProjection;
  if (projection?.dateEncoding !== 'yyyymmdd' || projection.dateColumn !== date || projection.minute?.column !== minute
    || review.proposal.mapping.bar || review.proposal.mapping.publicTime)
    return fail('实际证据中的日期、分钟或行情角色与来源原报档案不一致。');
  const target = review.proposal.target;
  const definition = target.definition, context = definition.semantic_context as WfdRecord;
  const identity = context.identity as WfdRecord;
  const family = tabularDigest({ sourceFamily: target.outputKey, tableContract: table.digest }).slice(7, 39);
  target.outputKey = 'tabular.' + family;
  target.subject.id = 'tabular_table.' + family;
  target.coverage.scope = { subject_id: target.subject.id };
  definition.semantic_code = target.outputKey;
  identity.identity_resolution_rule = tabularIdentityRule(table);
  const fields = definition.field_definitions as WfdRecord[];
  definition.field_definitions = table.fields.map(fieldCode => fields.find(field => field.field_code === fieldCode));
  validateDefinition(definition, table);
  return target;
}

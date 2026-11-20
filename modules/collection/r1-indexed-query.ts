import { createHash } from 'node:crypto';
import type { R1MembershipSelection, R1TabularSelection } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

export const R1_INDEXED_LIMITS = Object.freeze({ pageSize: 500, maxScanRows: 50_000_000,
  maxScanBytes: 268_435_456, maxResultBytes: 2_097_152, maxDiscoveryProducts: 1000,
  maxFields: 64, timeoutMs: 120_000, maxPartitions: 366, maxMatchValues: 20_000, maxMembershipRows: 50_000 });
const code = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const snapshot = (value: unknown): value is string => typeof value === 'string' && /^s_[0-9a-f]{24}$/u.test(value);
const sha = (value: unknown): string => 'sha256:' + createHash('sha256').update(canonicalWfdJson(value)).digest('hex');
const compare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const DAY_MS = 86_400_000;
function fail(message: string, errorCode = 'R1_INDEXED_INPUT'): never { throw new TaskError(errorCode, message); }
function badResponse(message: string): never { return fail(message, 'R1_READ_RESPONSE_INVALID'); }
function object(value: unknown, allowed: readonly string[]): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('表格查询包含未支持的字段或不是对象。');
  return value;
}
function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function localTime(value: unknown): value is string {
  return typeof value === 'string' && day(value.slice(0, 10))
    && (value.length === 10 || /^T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(value.slice(10)));
}
function set(value: unknown, maximum: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && !value.length)
    || value.some(item => !text(item))) fail('筛选集合必须是有界的原始文本数组，保留代码前导零。');
  return [...new Set(value as string[])].sort(compare);
}

export function parseTabularSelection(value: unknown): R1TabularSelection {
  const input = object(value, ['partitions', 'match', 'dateRange', 'timeRange']);
  const result: R1TabularSelection = {};
  if (input.partitions !== undefined) {
    result.partitions = set(input.partitions, R1_INDEXED_LIMITS.maxPartitions, false);
    if (result.partitions.some(item => !item)) fail('分区标签不得为空。');
  }
  if (input.match !== undefined) {
    if (!isWfdRecord(input.match) || Object.keys(input.match).length > 64 || Object.keys(input.match).some(key => !code(key)))
      fail('匹配条件必须使用实际声明的字段编号。');
    result.match = {};
    for (const field of Object.keys(input.match).sort(compare)) result.match[field] = set(input.match[field], R1_INDEXED_LIMITS.maxMatchValues, true);
    if (Object.values(result.match).reduce((count, values) => count + values.length, 0) > R1_INDEXED_LIMITS.maxMatchValues)
      fail('匹配值超过本地查询预算。');
  }
  if (input.dateRange !== undefined) {
    const range = object(input.dateRange, ['field', 'format', 'start', 'end']);
    if (!code(range.field) || !['YYYYMMDD', 'YYYY-MM-DD'].includes(String(range.format))
      || !day(range.start) || !day(range.end) || range.end < range.start) fail('日期筛选须声明字段、原值格式和合法起止日期。');
    result.dateRange = range as unknown as NonNullable<R1TabularSelection['dateRange']>;
  }
  if (input.timeRange !== undefined) {
    const range = object(input.timeRange, ['role', 'start', 'end', 'timezone']);
    if (range.role !== 'observation' || !localTime(range.start) || !localTime(range.end)
      || !text(range.timezone) || !range.timezone)
      fail('分钟范围须明确 observation（观测时间）、起止和声明时区。');
    result.timeRange = range as unknown as NonNullable<R1TabularSelection['timeRange']>;
  }
  if (!result.partitions && !result.dateRange && !result.timeRange) fail('请选择明确分区或映射到分区的日期、时间范围。');
  return result;
}

export function parseMembership(value: unknown): R1MembershipSelection {
  const input = object(value, ['productId', 'selection', 'memberField', 'targetField', 'basis', 'mapping']);
  if (![input.productId, input.memberField, input.targetField].every(code) || input.basis !== 'reported_snapshot')
    fail('分类读取须选择正式成分产品、成员字段、目标字段，并明确使用已报告快照的成员集合。');
  const result: R1MembershipSelection = { productId: input.productId as string, memberField: input.memberField as string,
    targetField: input.targetField as string, basis: 'reported_snapshot', selection: parseTabularSelection(input.selection) };
  if (input.mapping !== undefined) {
    const map = object(input.mapping, ['productId', 'selection', 'sourceField', 'targetField']);
    if (![map.productId, map.sourceField, map.targetField].every(code)) fail('代码映射必须引用正式产品及其已声明字段。');
    result.mapping = { productId: map.productId as string, sourceField: map.sourceField as string,
      targetField: map.targetField as string, selection: parseTabularSelection(map.selection) };
  }
  return result;
}

export function assertSelectionFields(selection: R1TabularSelection, fields: readonly string[]): void {
  const requested = [...Object.keys(selection.match ?? {}), ...(selection.dateRange ? [selection.dateRange.field] : [])];
  if (requested.some(field => !fields.includes(field))) fail('筛选字段未在固定快照产品中声明。', 'R1_READ_FIELDS');
}

export function wireSelection(selection: R1TabularSelection, contextDigest?: string): WfdRecord {
  return { ...(selection.partitions ? { partitions: selection.partitions } : {}),
    ...(selection.match ? { match: selection.match } : {}), ...(selection.dateRange ? { date_range: selection.dateRange } : {}),
    ...(contextDigest ? { context_digest: contextDigest } : {}) };
}

function utcSecond(value: unknown): number | null {
  if (typeof value !== 'string' || !value.endsWith('Z') || value.length !== 20
    || !localTime(value.slice(0, -1))) return null;
  const tick = Date.parse(value);
  return Number.isFinite(tick) ? tick : null;
}

function zonedClock(timezone: string): (tick: number) => string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch {
    return badResponse('查询时区无法核对。');
  }
  return tick => {
    const parts = Object.fromEntries(formatter.formatToParts(tick).map(part => [part.type, part.value]));
    return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
}

function normalizedTime(result: WfdRecord, range: NonNullable<R1TabularSelection['timeRange']>) {
  const returned = result.business_time_range;
  if (!isWfdRecord(returned) || returned.role !== range.role || returned.start !== range.start
    || returned.end !== range.end || returned.timezone !== range.timezone) badResponse('观测时间查询的原始条件不一致。');
  const start = utcSecond(returned.start_utc), end = utcSecond(returned.end_utc);
  if (start === null || end === null || end <= start) badResponse('观测时间查询的 UTC 区间不合法。');
  const clock = zonedClock(range.timezone);
  const localStart = range.start.length === 10 ? range.start + 'T00:00:00' : range.start;
  if (clock(start) !== localStart) badResponse('观测时间区间的起点与声明时区不符。');
  const endMatches = range.end.length === 10
    ? clock(end) === new Date(Date.parse(range.end + 'T00:00:00Z') + DAY_MS).toISOString().slice(0, 10) + 'T00:00:00'
    : clock(end - 1000) === range.end;
  if (!endMatches) badResponse('观测时间区间的排他终点与请求不符。');
  return { start, end };
}

function partitionLabels(left: number, right: number, format: 'YYYYMMDD' | 'YYYY-MM-DD'): string[] {
  const partitions: string[] = [];
  for (let tick = left; tick <= right && partitions.length <= R1_INDEXED_LIMITS.maxPartitions; tick += DAY_MS) {
    const label = new Date(tick).toISOString().slice(0, 10);
    partitions.push(format === 'YYYYMMDD' ? label.replaceAll('-', '') : label);
  }
  return partitions;
}

function dayTick(tick: number): number { return Math.floor(tick / DAY_MS) * DAY_MS; }

function derivedPartitions(selection: R1TabularSelection, contract: WfdRecord,
  time: { start: number; end: number } | null): string[] {
  if (selection.partitions) return selection.partitions;
  const dayRange = selection.dateRange;
  if (dayRange && contract.partition_field === dayRange.field)
    return partitionLabels(Date.parse(dayRange.start + 'T00:00:00Z'), Date.parse(dayRange.end + 'T00:00:00Z'), dayRange.format);
  const mapping = contract.time;
  if (time && selection.timeRange && isWfdRecord(mapping) && mapping.kind === 'source_minute'
    && typeof contract.partition_field === 'string' && contract.partition_field === mapping.date_field) {
    const range = selection.timeRange;
    if (mapping.timezone === range.timezone) return partitionLabels(Date.parse(range.start.slice(0, 10) + 'T00:00:00Z'),
      Date.parse(range.end.slice(0, 10) + 'T00:00:00Z'), 'YYYYMMDD');
    return partitionLabels(dayTick(time.start) - DAY_MS, dayTick(time.end - 1000) + DAY_MS, 'YYYYMMDD');
  }
  return badResponse('服务器未证明日期或观测时间字段可定位这些分区。');
}

function matchesCivilDate(value: unknown, range: NonNullable<R1TabularSelection['dateRange']>): boolean {
  if (typeof value !== 'string') return false;
  const civil = range.format === 'YYYYMMDD' && /^[0-9]{8}$/u.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : range.format === 'YYYY-MM-DD' ? value : '';
  return day(civil) && range.start <= civil && civil <= range.end;
}

function validateObservedTime(row: WfdRecord, values: WfdRecord, mapping: WfdRecord, time: { start: number; end: number } | null,
  clock: ((tick: number) => string) | null): void {
  const observation = row.business_time;
  if (!isWfdRecord(observation) || row.business_time_role !== 'observation'
    || !isWfdRecord(row.times) || canonicalWfdJson(row.times.observation_time) !== canonicalWfdJson(observation))
    badResponse('返回行缺少结构化观测时间。');
  if (mapping.kind === 'unknown') {
    if (time || observation.status !== 'unknown') badResponse('时间未知的产品不能返回已知分钟。');
    return;
  }
  const left = utcSecond(observation.earliest_utc), right = utcSecond(observation.latest_exclusive_utc);
  if (observation.status !== 'known' || observation.precision !== 'minute' || observation.source_timezone !== mapping.timezone
    || left === null || right !== left + 60_000 || time && (left < time.start || right > time.end) || !clock)
    badResponse('返回行的分钟区间不在已核对的观测时间范围。');
  const minute = clock(left).replace('T', ' '), dateLabel = minute.slice(0, 10).replaceAll('-', '');
  const minuteField = String(mapping.minute_field), dateField = String(mapping.date_field);
  if (minuteField in values && (values[minuteField] as WfdRecord).value !== minute
    || dateField in values && (values[dateField] as WfdRecord).value !== dateLabel)
    badResponse('返回行的原报日期或分钟字段与观测时间不符。');
}

function validatePage(result: WfdRecord, proof: Map<string, WfdRecord>, selection: R1TabularSelection, cursor: unknown): void {
  const page = result.page as WfdRecord, returned = (result.rows as unknown[]).length;
  const total = Number(page.total_rows), remaining = Number(page.remaining_rows);
  const maxRows = [...proof.values()].reduce((count, part) => count + Number(part.row_count), 0);
  const resumed = cursor !== undefined && cursor !== null;
  if (total > maxRows || remaining < returned || remaining > total || page.has_more !== (remaining > returned)
    || page.cursor_applied !== resumed || (!resumed && remaining !== total) || (resumed && remaining >= total)
    || (remaining > 0 && returned === 0) || page.next_cursor !== null && page.next_cursor === cursor
    || result.complete !== !page.has_more || Object.values(selection.match ?? {}).some(set => set.length === 0) && total !== 0)
    badResponse('返回的精确总数、续页位置或空集合条件无法核对。');
}

/** Check the server-applied conditions and every returned row against the requested scope. */
export function validateIndexedResult(result: WfdRecord, selection: R1TabularSelection, fields: string[], declaredFields: string[],
  cursor: unknown, contextDigest?: string): void {
  const indexed = result.indexed_tabular;
  if (!isWfdRecord(indexed) || !isWfdRecord(indexed.selection) || !isWfdRecord(indexed.table_contract)
    || !Array.isArray(indexed.partitions) || !Array.isArray(indexed.missing_partitions)
    || !Array.isArray(indexed.selection.partitions) || !indexed.selection.partitions.length
    || indexed.selection.partitions.some(label => !text(label) || !label)
    || canonicalWfdJson(indexed.selection.match) !== canonicalWfdJson(selection.match ?? {})
    || canonicalWfdJson(indexed.selection.date_range) !== canonicalWfdJson(selection.dateRange ?? null)
    || indexed.selection.context_digest !== (contextDigest ?? null))
    badResponse('固定表格查询的实际条件、分区或成员证明与请求不符。');
  const labels = indexed.selection.partitions as string[];
  const { digest: contractDigest, ...contract } = indexed.table_contract;
  const mapping = contract.time;
  if (contractDigest !== sha(contract) || indexed.table_contract_digest !== contractDigest
    || !['wfd.tabular-batch/1', 'wfd.source-minute-batch/1'].includes(String(indexed.protocol_version))
    || !Array.isArray(contract.fields) || contract.fields.some(field => !code(field))
    || canonicalWfdJson([...contract.fields].sort(compare)) !== canonicalWfdJson([...declaredFields].sort(compare))
    || canonicalWfdJson(result.sort) !== canonicalWfdJson(['partition', 'row_index'])
    || !isWfdRecord(mapping) || !['source_minute', 'unknown'].includes(String(mapping.kind))
    || mapping.kind === 'source_minute' && (!text(mapping.timezone) || !mapping.timezone
      || !contract.fields.includes(mapping.date_field) || !contract.fields.includes(mapping.minute_field)))
    badResponse('表格查询的字段契约摘要、声明轴或时间映射不一致。');
  const time = selection.timeRange ? normalizedTime(result, selection.timeRange) : null;
  if (labels.length > R1_INDEXED_LIMITS.maxPartitions
    || canonicalWfdJson(derivedPartitions(selection, contract, time)) !== canonicalWfdJson(labels))
    badResponse('返回分区集合遗漏或扩展了请求范围。');
  const proven = new Map<string, WfdRecord>();
  for (const part of indexed.partitions) {
    if (!isWfdRecord(part) || !text(part.partition) || !labels.includes(part.partition) || proven.has(part.partition)
      || !Number.isSafeInteger(part.row_count) || Number(part.row_count) <= 0
      || !digest(part.result_root) || !digest(part.rows_digest) || !snapshot(part.publication_snapshot_id))
      badResponse('返回分区缺少正式发布快照、结果根、摘要或完整计数。');
    proven.set(part.partition, part);
  }
  const absent = indexed.missing_partitions;
  if (absent.some(label => !text(label) || !labels.includes(label) || proven.has(label))
    || new Set(absent).size !== absent.length || labels.some(label => !proven.has(label) && !absent.includes(label)))
    badResponse('分区覆盖声明与实际返回证明不一致。');
  validatePage(result, proven, selection, cursor);
  const clock = mapping.kind === 'source_minute' ? zonedClock(String(mapping.timezone)) : null;
  let previous: { partition: string; index: number } | undefined;
  for (const row of result.rows as WfdRecord[]) {
    const part = proven.get(String(row.partition)), values = row.values as WfdRecord, ref = row.record_ref as WfdRecord;
    if (!part || !Number.isSafeInteger(row.row_index) || Number(row.row_index) < 0 || Number(row.row_index) >= Number(part.row_count)
      || row.product_id !== result.product_id || ref.product_id !== result.product_id || ref.snapshot_id !== result.snapshot_id
      || !code(row.record_id) || typeof row.record_version !== 'string' || !/^r_[a-f0-9]{32}$/u.test(row.record_version)
      || ref.logical_key !== row.record_id || ref.revision_id !== row.record_version
      || canonicalWfdJson(Object.keys(values).sort(compare)) !== canonicalWfdJson([...fields].sort(compare)))
      badResponse('查询行不属于固定分区、产品或声明投影。');
    if (previous && (compare(previous.partition, String(row.partition)) > 0
      || previous.partition === row.partition && previous.index >= Number(row.row_index)))
      badResponse('查询页的行顺序不稳定或重复。');
    previous = { partition: String(row.partition), index: Number(row.row_index) };
    const projected = new Map<string, string | null>();
    for (const [field, value] of Object.entries(values)) {
      if (!isWfdRecord(value) || value.field_code !== field || value.data_type !== 'text'
        || !(value.value_state === 'valid_value' && typeof value.value === 'string' || value.value_state === 'unknown' && value.value === null))
        badResponse('返回行的声明文本字段或空值状态无效。');
      projected.set(field, value.value as string | null);
    }
    for (const [field, allowed] of Object.entries(selection.match ?? {})) {
      const cell = projected.get(field);
      if (projected.has(field) && (typeof cell !== 'string' || !allowed.includes(cell)))
        badResponse('查询结果不满足请求的字段匹配条件。');
    }
    if (selection.dateRange && projected.has(selection.dateRange.field)
      && !matchesCivilDate(projected.get(selection.dateRange.field), selection.dateRange))
      badResponse('查询结果的日期超出声明筛选范围。');
    if (typeof contract.partition_field === 'string' && projected.has(contract.partition_field)
      && projected.get(contract.partition_field) !== row.partition) badResponse('返回行的分区字段与目录定位不符。');
    validateObservedTime(row, values, mapping, time, clock);
  }
}

type PageReader = (productId: string, selection: R1TabularSelection, fields: string[], cursor?: string | null) => Promise<WfdRecord>;
async function collect(reader: PageReader, productId: string, selection: R1TabularSelection, fields: string[]): Promise<{ rows: WfdRecord[]; proof: WfdRecord }> {
  const rows: WfdRecord[] = [], seen = new Set<string>();
  let cursor: string | null = null, queryHash: unknown, expected: number | undefined, partitionProof: string | undefined;
  let previous: { partition: string; index: number } | undefined;
  do {
    const page = await reader(productId, selection, fields, cursor), info = page.page as WfdRecord;
    const indexed = page.indexed_tabular as WfdRecord;
    if ((indexed.missing_partitions as unknown[]).length > 0)
      fail('正式分类或代码映射有分区缺口，无法证明完整成员集。', 'R1_MEMBERSHIP_PARTITION_MISSING');
    const fixedProof = canonicalWfdJson(indexed);
    if (queryHash !== undefined && (queryHash !== page.query_hash || expected !== info.total_rows || partitionProof !== fixedProof))
      fail('成员集合的固定查询、计数或分区证明在分页中变化。', 'R1_MEMBERSHIP_CHANGED');
    queryHash = page.query_hash; expected = info.total_rows as number; partitionProof = fixedProof;
    if (expected > R1_INDEXED_LIMITS.maxMembershipRows) fail('分类或代码映射成员数量超过本地有界预算。', 'R1_MEMBERSHIP_BUDGET');
    for (const row of page.rows as WfdRecord[]) {
      const key = canonicalWfdJson(row.record_ref);
      if (seen.has(key)) fail('分类或映射分页重复返回同一正式记录。', 'R1_MEMBERSHIP_CHANGED');
      const position = { partition: String(row.partition), index: Number(row.row_index) };
      if (previous && (compare(previous.partition, position.partition) > 0
        || previous.partition === position.partition && previous.index >= position.index))
        fail('分类或映射记录的跨页排序不一致。', 'R1_MEMBERSHIP_CHANGED');
      previous = position;
      seen.add(key); rows.push(row);
    }
    const next = info.next_cursor as string | null;
    if (rows.length > expected || rows.length > R1_INDEXED_LIMITS.maxMembershipRows
      || next !== null && (next === cursor || !(page.rows as unknown[]).length))
      fail('分类或映射分页范围无法核对。', 'R1_MEMBERSHIP_CHANGED');
    cursor = next;
  } while (cursor !== null);
  if (rows.length !== expected) fail('成员集合没有完整读回。', 'R1_MEMBERSHIP_CHANGED');
  return { rows, proof: { productId, queryHash, selection, rows: rows.length,
    recordVersionsDigest: sha(rows.map(row => row.record_ref)), partitionProof: JSON.parse(partitionProof!) } };
}
function memberValue(row: WfdRecord, field: string): string {
  const value = (row.values as WfdRecord)[field];
  if (!isWfdRecord(value) || value.data_type !== 'text' || value.value_state !== 'valid_value'
    || typeof value.value !== 'string' || !value.value.trim())
    fail('分类或代码映射包含未知成员标识，不能当作完整成员集合。', 'R1_MEMBERSHIP_MEMBER_UNKNOWN');
  return value.value;
}

interface FieldDomain {
  productId: string;
  field: string;
  identityResolutionRule: string;
  aliasScope: string;
  definitionDigests: string[];
}

function declaredDomain(products: WfdRecord[], productId: string, field: string, membership: boolean): FieldDomain {
  const candidates = products.filter(product => product.product_id === productId);
  if (!candidates.length)
    fail('分类或映射产品不在指定固定快照。', 'R1_READ_PRODUCT_NOT_FOUND');
  const domains = candidates.map(product => {
    const definition = product.declaration, ref = product.definition_ref;
    if (!isWfdRecord(definition) || !isWfdRecord(ref) || !digest(ref.digest) || ref.digest !== sha(definition)
      || !Array.isArray(definition.field_definitions)
      || !definition.field_definitions.some(item => isWfdRecord(item) && item.field_code === field && item.data_type === 'text')
      || !isWfdRecord(definition.field_semantic_context))
      fail('分类或映射字段缺少正式文本声明及固定定义引用。', 'R1_MEMBERSHIP_DECLARATION_REQUIRED');
    const fieldContext = definition.field_semantic_context[field], semantic = definition.semantic_context;
    if (!isWfdRecord(fieldContext) || !isWfdRecord(fieldContext.identity))
      fail('正式字段缺少经审核的身份解析规则和别名范围。', 'R1_MEMBERSHIP_IDENTITY_REQUIRED');
    const rule = fieldContext.identity.identity_resolution_rule, scope = fieldContext.identity.alias_scope;
    const declared = (value: unknown): value is string => text(value) && value.trim() === value
      && value.length > 0 && !['unknown', 'not_applicable'].includes(value.toLowerCase());
    if (!declared(rule) || !declared(scope))
      fail('正式字段的身份规则和别名范围须明确。', 'R1_MEMBERSHIP_IDENTITY_REQUIRED');
    if (membership && (!isWfdRecord(semantic) || semantic.content_nature !== 'source_claim'
      || !isWfdRecord(fieldContext.content) || fieldContext.content.assertion_status !== 'source_reported_membership'))
      fail('所选成分字段须正式声明为来源报告的成员关系。', 'R1_MEMBERSHIP_DECLARATION_REQUIRED');
    return { rule, scope, definition: ref.digest };
  });
  const first = domains[0]!;
  if (domains.some(domain => domain.rule !== first.rule || domain.scope !== first.scope))
    fail('同一固定产品的身份领域声明存在歧义。', 'R1_MEMBERSHIP_IDENTITY_MISMATCH');
  return { productId, field, identityResolutionRule: first.rule, aliasScope: first.scope,
    definitionDigests: [...new Set(domains.map(domain => domain.definition))].sort(compare) };
}

export function validateMembershipDeclarations(membership: R1MembershipSelection, products: WfdRecord[],
  targetProductId: string) {
  const source = declaredDomain(products, membership.productId, membership.memberField, true);
  const target = declaredDomain(products, targetProductId, membership.targetField, false);
  const requireSame = (left: FieldDomain, right: FieldDomain) => {
    if (left.identityResolutionRule !== right.identityResolutionRule || left.aliasScope !== right.aliasScope)
      fail('所选字段的已声明身份域不一致。请核对正式代码映射的两端字段。', 'R1_MEMBERSHIP_IDENTITY_MISMATCH');
  };
  const map = membership.mapping;
  if (!map) {
    requireSame(source, target);
    return { source, target, mapping: null };
  }
  const from = declaredDomain(products, map.productId, map.sourceField, false);
  const to = declaredDomain(products, map.productId, map.targetField, false);
  requireSame(source, from);
  requireSame(to, target);
  return { source, target, mapping: { from, to } };
}

export async function resolveMembership(reader: PageReader, membership: R1MembershipSelection,
  target: R1TabularSelection, domains: ReturnType<typeof validateMembershipDeclarations>, snapshotId: string):
  Promise<{ selection: R1TabularSelection; proof: WfdRecord; digest: string }> {
  const original = await collect(reader, membership.productId, membership.selection, [membership.memberField]);
  let members = [...new Set(original.rows.map(row => memberValue(row, membership.memberField)))].sort(compare);
  let mappingProof: WfdRecord | null = null;
  if (members.length > R1_INDEXED_LIMITS.maxMatchValues) fail('分类成员超过查询集合预算。', 'R1_MEMBERSHIP_BUDGET');
  if (membership.mapping) {
    const map = membership.mapping, selection = intersectMatch(map.selection, map.sourceField, members);
    const mapped = await collect(reader, map.productId, selection, [...new Set([map.sourceField, map.targetField])].sort(compare));
    const identities = new Map<string, string>();
    const requested = new Set(members);
    for (const row of mapped.rows) {
      const from = memberValue(row, map.sourceField), to = memberValue(row, map.targetField), old = identities.get(from);
      if (!requested.has(from) || old !== undefined && old !== to) fail('正式代码映射有冲突，未猜测或去除交易所后缀。', 'R1_MEMBERSHIP_MAPPING_AMBIGUOUS');
      identities.set(from, to);
    }
    if (members.some(member => !identities.has(member))) fail('正式映射未覆盖全部分类成员。', 'R1_MEMBERSHIP_MAPPING_INCOMPLETE');
    members = [...new Set(identities.values())].sort(compare); mappingProof = mapped.proof;
  }
  const selection = intersectMatch(target, membership.targetField, members);
  const proof: WfdRecord = { version: 'bd.fixed-membership/1', basis: membership.basis, snapshotId,
    historicalEffectiveMembership: 'not_asserted', source: original.proof, mapping: mappingProof,
    domains, targetField: membership.targetField, memberCount: members.length, membersDigest: sha(members) };
  return { selection, proof, digest: sha(proof) };
}

function intersectMatch(selection: R1TabularSelection, field: string, members: string[]): R1TabularSelection {
  const existing = selection.match?.[field], allowed = new Set(members);
  return { ...selection, match: { ...selection.match, [field]: existing ? existing.filter(member => allowed.has(member)) : members } };
}

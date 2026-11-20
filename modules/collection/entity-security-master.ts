import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { evaluateCalendarQualification } from './dual-source-market-governance.js';
import { sourceReportedDate } from './source-reported-table.js';

export const ENTITY_SECURITY_MASTER_VERSION = 'bd.entity-security-master/1';

type MasterIdentityKind = 'entity' | 'instrument' | 'listing' | 'market';
export interface MasterIdentityRef<Kind extends MasterIdentityKind = MasterIdentityKind> {
  readonly kind: Kind;
  readonly namespace: string;
  readonly id: string;
}

const SCHEME_KINDS = {
  cn_uscc: ['entity'], lei: ['entity'], csrc_issuer_id: ['entity'],
  isin: ['instrument'], share_class_figi: ['instrument'], composite_figi: ['instrument', 'listing'],
  figi: ['listing'], exchange_ticker: ['listing'], iso10383_mic: ['market'],
} as const satisfies Record<string, readonly MasterIdentityKind[]>;
export type ExternalIdentifierScheme = keyof typeof SCHEME_KINDS;

type KnownEffectiveDateRange = { readonly status: 'known'; readonly validFrom: string; readonly validUntilExclusive: string | null };
export type EffectiveDateRange = KnownEffectiveDateRange
  | { readonly status: 'unknown'; readonly validFrom: null; readonly validUntilExclusive: null };

const PUBLIC_PRECISIONS = ['year', 'quarter', 'month', 'day', 'hour', 'minute', 'second', 'interval'] as const;
export type TimeWithPrecision = {
  readonly source_timezone: string;
  readonly evidence_ref?: string | null;
} & (
  | { readonly status: 'known'; readonly precision: typeof PUBLIC_PRECISIONS[number];
      readonly earliest_utc: string; readonly latest_exclusive_utc: string }
  | { readonly status: 'unknown' | 'not_applicable'; readonly precision: 'unknown';
      readonly earliest_utc: null; readonly latest_exclusive_utc: null }
);

interface DatedMasterEvidence {
  readonly effectivePeriod: EffectiveDateRange;
  readonly publicTime: TimeWithPrecision;
  readonly sourceEvidenceRef: string;
}

interface ExternalIdentifierKey {
  readonly scheme: ExternalIdentifierScheme;
  readonly code: string;
  readonly marketMic?: string;
}

export interface ExternalIdentifierBinding extends ExternalIdentifierKey, DatedMasterEvidence {
  readonly target: MasterIdentityRef;
}

const LIFECYCLE_TRANSITIONS = {
  ipo_listed: 'active_trading', ticker_changed: null, short_name_changed: null, board_transferred: null,
  trading_suspended: 'suspended', trading_resumed: 'active_trading', delisted: 'delisted', relisted: 'active_trading',
} as const;
export type ListingLifecycleState = 'pre_listing' | 'active_trading' | 'suspended' | 'delisted' | 'unknown';
type StateTransition = NonNullable<(typeof LIFECYCLE_TRANSITIONS)[keyof typeof LIFECYCLE_TRANSITIONS]>;

export interface ListingLifecycleEvent extends DatedMasterEvidence {
  readonly event: keyof typeof LIFECYCLE_TRANSITIONS;
  readonly listing: MasterIdentityRef<'listing'>;
  readonly marketMic: string;
}

const CONTINUITY_EVENTS = [
  'legal_name_changed', 'reverse_merger_backdoor', 'merged_absorbed_into', 'demerger_split_into', 'domicile_changed',
] as const;
export interface EntityContinuityRecord extends DatedMasterEvidence {
  readonly event: typeof CONTINUITY_EVENTS[number];
  readonly predecessor: MasterIdentityRef<'entity'>;
  readonly successors: readonly MasterIdentityRef<'entity'>[];
  readonly newDisplayName?: string;
}

export interface EntitySecurityMasterBundle {
  readonly version: typeof ENTITY_SECURITY_MASTER_VERSION;
  readonly bindings: readonly ExternalIdentifierBinding[];
  readonly lifecycleEvents: readonly ListingLifecycleEvent[];
  readonly continuityRecords: readonly EntityContinuityRecord[];
}

const identityToken = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
const marketMic = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{4}$/u.test(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const validDay = (value: unknown): value is string => sourceReportedDate(value, 'iso-date') !== null
  && typeof value === 'string' && !value.startsWith('0000-');
const isSecondUtcInstant = (value: unknown): value is string => isExplicitUtcInstant(value) && value.length === 20;
const hasOnly = (record: WfdRecord, fields: readonly string[]) => Object.keys(record).every(field => fields.includes(field));
const sameIdentity = (a: MasterIdentityRef, b: MasterIdentityRef) => a.kind === b.kind && a.namespace === b.namespace && a.id === b.id;
const identityKey = (ref: MasterIdentityRef) => canonicalWfdJson([ref.kind, ref.namespace, ref.id]);
const identifierKey = (ref: ExternalIdentifierKey) => canonicalWfdJson([ref.scheme, ref.code, ref.marketMic ?? null]);
const digest = (value: unknown) => `sha256:${wfdSha256(canonicalWfdJson(value))}`;

function rejectNameOnly(input: WfdRecord): void {
  if (input.matchBy === 'name' || input.deduplicateBy === 'name'
    || ((input.name !== undefined || input.displayName !== undefined) && input.code === undefined && input.id === undefined)) {
    throw new TaskError('MASTER_NAME_ONLY_FORBIDDEN', '主数据身份查询和查重须使用固定身份引用或有范围的外部编码。');
  }
}

export function validateMasterIdentityRef(input: unknown): asserts input is MasterIdentityRef {
  if (isWfdRecord(input)) rejectNameOnly(input);
  if (!isWfdRecord(input) || !hasOnly(input, ['kind', 'namespace', 'id'])
    || (input.kind !== 'entity' && input.kind !== 'instrument' && input.kind !== 'listing' && input.kind !== 'market')
    || !identityToken(input.namespace) || !identityToken(input.id)) {
    throw new TaskError('MASTER_IDENTITY_INVALID', '身份引用须包含 WFD 允许的类型、命名空间和固定编号。');
  }
}

function validateIdentifierKey(input: WfdRecord): asserts input is WfdRecord & ExternalIdentifierKey {
  rejectNameOnly(input);
  if (typeof input.scheme !== 'string' || !Object.hasOwn(SCHEME_KINDS, input.scheme) || !nonblank(input.code)) {
    throw new TaskError('MASTER_IDENTIFIER_INVALID', '须提供白名单中的编码体系和明确编码。');
  }
  if (input.scheme === 'exchange_ticker' && !marketMic(input.marketMic)) {
    throw new TaskError('MASTER_TICKER_MARKET_REQUIRED', '交易所代码须附有效的市场 MIC。');
  }
  if ((input.marketMic !== undefined && !marketMic(input.marketMic)) || (input.scheme === 'iso10383_mic' && !marketMic(input.code))) {
    throw new TaskError('MASTER_MIC_INVALID', '市场 MIC 须为四位大写字母或数字。');
  }
}

function validateEffectivePeriod(value: unknown): asserts value is EffectiveDateRange {
  if (isWfdRecord(value) && hasOnly(value, ['status', 'validFrom', 'validUntilExclusive'])) {
    if (value.status === 'unknown' && value.validFrom === null && value.validUntilExclusive === null) return;
    if (value.status === 'known' && validDay(value.validFrom)
      && (value.validUntilExclusive === null || (validDay(value.validUntilExclusive) && value.validFrom < value.validUntilExclusive))) return;
  }
  throw new TaskError('MASTER_EFFECTIVE_RANGE_INVALID', '有效区间须为实际自然日的左闭右开区间，或显式保留未知边界。');
}

function validatePublicTime(value: unknown): asserts value is TimeWithPrecision {
  if (isWfdRecord(value) && hasOnly(value, ['status', 'precision', 'earliest_utc', 'latest_exclusive_utc', 'source_timezone', 'evidence_ref'])
    && typeof value.source_timezone === 'string'
    && (!Object.hasOwn(value, 'evidence_ref') || value.evidence_ref === null || typeof value.evidence_ref === 'string')) {
    const { status, precision, earliest_utc, latest_exclusive_utc } = value;
    if ((status === 'unknown' || status === 'not_applicable') && precision === 'unknown'
      && earliest_utc === null && latest_exclusive_utc === null) return;
    if (status === 'known' && PUBLIC_PRECISIONS.some(allowed => allowed === precision)
      && isSecondUtcInstant(earliest_utc) && isSecondUtcInstant(latest_exclusive_utc)
      && earliest_utc < latest_exclusive_utc) return;
  }
  throw new TaskError('MASTER_PUBLIC_TIME_INVALID', '公开时间须保留 WFD 时间状态、精度、来源时区和合法的 UTC 边界。');
}

const EVIDENCE_FIELDS = ['effectivePeriod', 'publicTime', 'sourceEvidenceRef'] as const;
function validateDatedEvidence(record: WfdRecord): asserts record is WfdRecord & DatedMasterEvidence {
  validateEffectivePeriod(record.effectivePeriod);
  validatePublicTime(record.publicTime);
  if (!nonblank(record.sourceEvidenceRef)) throw new TaskError('MASTER_EVIDENCE_REQUIRED', '主数据记录须固定来源证据引用。');
}

function validateBinding(record: unknown): asserts record is ExternalIdentifierBinding {
  if (!isWfdRecord(record)) throw new TaskError('MASTER_BINDING_INVALID', '外部编码绑定须为对象。');
  validateIdentifierKey(record);
  if (!hasOnly(record, ['scheme', 'code', 'marketMic', 'target', ...EVIDENCE_FIELDS])) {
    throw new TaskError('MASTER_BINDING_INVALID', '外部编码绑定仅接受登记字段。');
  }
  const { target } = record;
  validateMasterIdentityRef(target);
  if (!SCHEME_KINDS[record.scheme].some(kind => kind === target.kind)) {
    throw new TaskError('MASTER_SCHEME_KIND_MISMATCH', `编码体系 ${record.scheme} 不能绑定 ${target.kind} 层。`);
  }
  validateDatedEvidence(record);
}

function validateLifecycleEvent(record: unknown): asserts record is ListingLifecycleEvent {
  if (!isWfdRecord(record) || !hasOnly(record, ['event', 'listing', 'marketMic', ...EVIDENCE_FIELDS])
    || typeof record.event !== 'string' || !Object.hasOwn(LIFECYCLE_TRANSITIONS, record.event) || !marketMic(record.marketMic)) {
    throw new TaskError('MASTER_LIFECYCLE_INVALID', '挂牌事件须提供登记的事件类型及市场 MIC。');
  }
  validateMasterIdentityRef(record.listing);
  if (record.listing.kind !== 'listing') throw new TaskError('MASTER_LIFECYCLE_INVALID', '挂牌事件须指向 listing 层。');
  validateDatedEvidence(record);
}

function validateContinuity(record: unknown): asserts record is EntityContinuityRecord {
  if (!isWfdRecord(record) || !hasOnly(record, ['event', 'predecessor', 'successors', 'newDisplayName', ...EVIDENCE_FIELDS])
    || !CONTINUITY_EVENTS.some(event => record.event === event) || !Array.isArray(record.successors) || !record.successors.length
    || (record.newDisplayName !== undefined && !nonblank(record.newDisplayName))) {
    throw new TaskError('MASTER_CONTINUITY_INVALID', '主体连续性须显式登记前驱、后继和事件类型。');
  }
  const { predecessor, successors } = record;
  validateMasterIdentityRef(predecessor);
  const successorKeys = new Set<string>();
  for (const successor of successors as unknown[]) {
    validateMasterIdentityRef(successor);
    if (successor.kind !== 'entity') throw new TaskError('MASTER_CONTINUITY_INVALID', '后继身份须指向 entity 层。');
    successorKeys.add(identityKey(successor));
  }
  if (predecessor.kind !== 'entity' || successorKeys.size !== successors.length) {
    throw new TaskError('MASTER_CONTINUITY_INVALID', '前驱须指向 entity 层，后继须使用各自的唯一身份。');
  }
  const retainsPredecessor = successorKeys.has(identityKey(predecessor));
  if ((record.event === 'legal_name_changed' || record.event === 'domicile_changed') && (successors.length !== 1 || !retainsPredecessor)
    || record.event === 'merged_absorbed_into' && (successors.length !== 1 || retainsPredecessor)
    || record.event === 'demerger_split_into' && successors.length === Number(retainsPredecessor)) {
    throw new TaskError('MASTER_CONTINUITY_INVALID', '更名或迁址保留主体身份，吸收合并与分拆须显式登记独立后继。');
  }
  validateDatedEvidence(record);
}

const includesDay = (period: KnownEffectiveDateRange, day: string) => period.validFrom <= day
  && (period.validUntilExclusive === null || day < period.validUntilExclusive);

function validateBindingOverlaps(bindings: readonly ExternalIdentifierBinding[]): void {
  type Interval = { period: KnownEffectiveDateRange; target: MasterIdentityRef };
  const groups = new Map<string, Interval[]>();
  for (const { scheme, code, marketMic, target, effectivePeriod } of bindings) {
    if (effectivePeriod.status !== 'known') continue;
    const key = identifierKey({ scheme, code, marketMic });
    const intervals = groups.get(key) ?? [];
    intervals.push({ period: effectivePeriod, target });
    groups.set(key, intervals);
  }
  for (const intervals of groups.values()) {
    intervals.sort((a, b) => a.period.validFrom.localeCompare(b.period.validFrom));
    let active: Interval | undefined;
    for (const interval of intervals) {
      if (!active || !includesDay(active.period, interval.period.validFrom)) {
        active = interval;
        continue;
      }
      if (!sameIdentity(active.target, interval.target)) {
        throw new TaskError('MASTER_OVERLAPPING_EFFECTIVE_RANGE', '同一体系、编码和市场在重叠有效期内指向多个身份。');
      }
      const end = interval.period.validUntilExclusive;
      if (active.period.validUntilExclusive !== null && (end === null || end > active.period.validUntilExclusive)) active = interval;
    }
  }
}

function validateLifecycleConflicts(events: readonly ListingLifecycleEvent[]): void {
  const transitions = new Map<string, StateTransition>();
  for (const { event, listing, marketMic, effectivePeriod } of events) {
    const state = LIFECYCLE_TRANSITIONS[event];
    if (!state || effectivePeriod.status !== 'known') continue;
    const key = canonicalWfdJson([identityKey(listing), marketMic, effectivePeriod.validFrom]);
    const existing = transitions.get(key);
    if (existing && existing !== state) {
      throw new TaskError('MASTER_LIFECYCLE_CONFLICT', '同一挂牌和生效日有无法按日期排序的交易状态事件。');
    }
    transitions.set(key, state);
  }
}

function replayBundle(raw: unknown): EntitySecurityMasterBundle {
  if (!isWfdRecord(raw) || !hasOnly(raw, ['version', 'bindings', 'lifecycleEvents', 'continuityRecords'])
    || raw.version !== ENTITY_SECURITY_MASTER_VERSION || !Array.isArray(raw.bindings)
    || !Array.isArray(raw.lifecycleEvents) || !Array.isArray(raw.continuityRecords)) {
    throw new TaskError('MASTER_BUNDLE_INVALID', '候选包须声明主数据契约版本、外部编码绑定、挂牌事件和主体连续性。');
  }
  const { bindings, lifecycleEvents, continuityRecords } = raw;
  bindings.forEach(validateBinding);
  lifecycleEvents.forEach(validateLifecycleEvent);
  continuityRecords.forEach(validateContinuity);
  validateBindingOverlaps(bindings);
  validateLifecycleConflicts(lifecycleEvents);
  return { version: ENTITY_SECURITY_MASTER_VERSION, bindings, lifecycleEvents, continuityRecords };
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

interface MasterReplay {
  readonly candidateDigest: string;
  readonly replayDigest: string;
  readonly diagnostics: Readonly<{
    bindings: number;
    lifecycleEvents: number;
    continuityRecords: number;
    unknownEffectivePeriods: number;
    unresolvedPublicTimes: number;
  }>;
}

export interface MasterAdoptionReceipt {
  readonly receiptId: string;
  readonly operator: Readonly<{ operatorId: string; source: 'trusted-host' | 'operator-http' | 'conversation' }>;
  readonly candidateDigest: string;
  readonly replayDigest: string;
  readonly observedAtUtc: string;
  readonly receiptDigest: string;
}

export function masterAdoptionReceiptDigest(receipt: Omit<MasterAdoptionReceipt, 'receiptDigest'>): string {
  const { receiptId, operator, candidateDigest, replayDigest, observedAtUtc } = receipt;
  return digest({ action: 'adopt-entity-security-master', version: ENTITY_SECURITY_MASTER_VERSION,
    receiptId, operator, candidateDigest, replayDigest, observedAtUtc });
}

export interface EntitySecurityMasterSnapshot extends EntitySecurityMasterBundle {
  readonly status: 'adopted';
  readonly candidateDigest: string;
  readonly replayDigest: string;
  readonly confirmationReceipt: MasterAdoptionReceipt;
}

type TrustedReceiptVerifier = (receipt: MasterAdoptionReceipt) => boolean;
interface RegisteredCandidate {
  readonly canonical: string;
  replay?: { bundle: EntitySecurityMasterBundle; result: MasterReplay };
  snapshot?: EntitySecurityMasterSnapshot;
}

function adoptionAuthority(message: string): never {
  throw new TaskError('MASTER_ADOPTION_AUTHORITY', message);
}

/** 由受信宿主装配登记表与核验器。候选内容、回放结果和采用快照按摘要固定。 */
export class EntitySecurityMasterRegistry {
  readonly #candidates = new Map<string, RegisteredCandidate>();
  readonly #trustedReceiptVerifier: TrustedReceiptVerifier | undefined;

  constructor(trustedReceiptVerifier?: TrustedReceiptVerifier) {
    this.#trustedReceiptVerifier = trustedReceiptVerifier;
  }

  registerCandidate(bundle: unknown): { candidateDigest: string } {
    let canonical: string;
    try {
      canonical = canonicalWfdJson(bundle);
      JSON.parse(canonical);
    } catch {
      throw new TaskError('MASTER_BUNDLE_INVALID', '候选包须由可固定摘要的 JSON 记录组成。');
    }
    const candidateDigest = `sha256:${wfdSha256(canonical)}`;
    if (!this.#candidates.has(candidateDigest)) this.#candidates.set(candidateDigest, { canonical });
    return { candidateDigest };
  }

  replayCandidate(candidateDigest: string): MasterReplay {
    const candidate = this.#candidates.get(candidateDigest);
    if (!candidate) throw new TaskError('MASTER_CANDIDATE_NOT_FOUND', '回放须选择已登记的固定候选摘要。');
    if (candidate.replay) return candidate.replay.result;

    const bundle = freezeJson(replayBundle(JSON.parse(candidate.canonical)));
    const records = [...bundle.bindings, ...bundle.lifecycleEvents, ...bundle.continuityRecords];
    const diagnostics = {
      bindings: bundle.bindings.length,
      lifecycleEvents: bundle.lifecycleEvents.length,
      continuityRecords: bundle.continuityRecords.length,
      unknownEffectivePeriods: records.filter(record => record.effectivePeriod.status === 'unknown').length,
      unresolvedPublicTimes: records.filter(record => record.publicTime.status !== 'known').length,
    };
    const replay = { candidateDigest, diagnostics };
    const result = freezeJson({ ...replay, replayDigest: digest({ version: bundle.version, ...replay }) });
    candidate.replay = { bundle, result };
    return result;
  }

  adoptCandidate(candidateDigest: string, replayDigest: string, rawReceipt: unknown): EntitySecurityMasterSnapshot {
    const verifyReceipt = this.#trustedReceiptVerifier;
    if (!verifyReceipt) return adoptionAuthority('登记表须预先装配受信宿主回执核验器。');
    if (!isWfdRecord(rawReceipt) || !hasOnly(rawReceipt, ['receiptId', 'operator', 'candidateDigest', 'replayDigest', 'observedAtUtc', 'receiptDigest'])
      || !isWfdRecord(rawReceipt.operator) || !hasOnly(rawReceipt.operator, ['operatorId', 'source'])
      || (rawReceipt.operator.source !== 'trusted-host' && rawReceipt.operator.source !== 'operator-http')
      || !identityToken(rawReceipt.operator.operatorId) || !identityToken(rawReceipt.receiptId)
      || !isExplicitUtcInstant(rawReceipt.observedAtUtc) || typeof rawReceipt.receiptDigest !== 'string') {
      return adoptionAuthority('采用须提交完整的受信宿主操作员回执。');
    }
    const candidate = this.#candidates.get(candidateDigest);
    if (!candidate?.replay || replayDigest !== candidate.replay.result.replayDigest
      || rawReceipt.candidateDigest !== candidateDigest || rawReceipt.replayDigest !== replayDigest) {
      return adoptionAuthority('确认回执须关联同一候选及其通过的回放摘要。');
    }
    const receipt = freezeJson<MasterAdoptionReceipt>({
      receiptId: rawReceipt.receiptId,
      operator: { operatorId: rawReceipt.operator.operatorId, source: rawReceipt.operator.source },
      candidateDigest, replayDigest, observedAtUtc: rawReceipt.observedAtUtc, receiptDigest: rawReceipt.receiptDigest,
    });
    if (receipt.receiptDigest !== masterAdoptionReceiptDigest(receipt)) return adoptionAuthority('确认回执摘要不符。');
    let verified: boolean;
    try {
      verified = verifyReceipt(receipt) === true;
    } catch {
      return adoptionAuthority('受信宿主回执核验失败。');
    }
    if (!verified) return adoptionAuthority('受信宿主未核实该确认回执。');
    if (candidate.snapshot && candidate.snapshot.confirmationReceipt.receiptDigest !== receipt.receiptDigest) {
      return adoptionAuthority('已采用快照的确认回执须保持原版本。');
    }
    candidate.snapshot ??= Object.freeze({ ...candidate.replay.bundle, status: 'adopted', candidateDigest, replayDigest, confirmationReceipt: receipt });
    return candidate.snapshot;
  }

  getAdoptedSnapshot(candidateDigest: string): EntitySecurityMasterSnapshot | null {
    return this.#candidates.get(candidateDigest)?.snapshot ?? null;
  }
}

interface MasterTimeQuery {
  readonly asOfDate: string;
  readonly marketKnownAtUtc?: string;
}
export interface MasterIdentityRequest extends ExternalIdentifierKey, MasterTimeQuery {}

function readTimeQuery(input: MasterTimeQuery): number | undefined {
  if (!validDay(input.asOfDate)) throw new TaskError('MASTER_AS_OF_DATE_INVALID', '业务截止须为实际自然日。');
  if (input.marketKnownAtUtc === undefined) return undefined;
  if (!isExplicitUtcInstant(input.marketKnownAtUtc)) throw new TaskError('MASTER_KNOWLEDGE_CUTOFF_INVALID', '市场知悉截止须为明确的 UTC 时刻。');
  return Date.parse(input.marketKnownAtUtc);
}

/** 主数据查询和按编码查重共享此入口。matchBy / deduplicateBy 的 name 模式会明确拒绝。 */
export function validateMasterIdentityRequest(request: unknown): asserts request is MasterIdentityRequest {
  if (typeof request === 'string') throw new TaskError('MASTER_NAME_ONLY_FORBIDDEN', '显示名称或无编码体系的字符串不能作为身份。');
  if (!isWfdRecord(request)) throw new TaskError('MASTER_IDENTIFIER_INVALID', '身份查询须提供编码体系、编码和业务日期。');
  validateIdentifierKey(request);
  if (!hasOnly(request, ['scheme', 'code', 'marketMic', 'asOfDate', 'marketKnownAtUtc'])) {
    throw new TaskError('MASTER_IDENTIFIER_INVALID', '身份查询仅接受已登记的编码及时间字段。');
  }
  if (!validDay(request.asOfDate)) throw new TaskError('MASTER_AS_OF_DATE_INVALID', '业务截止须为实际自然日。');
  if (request.marketKnownAtUtc !== undefined && !isExplicitUtcInstant(request.marketKnownAtUtc)) {
    throw new TaskError('MASTER_KNOWLEDGE_CUTOFF_INVALID', '市场知悉截止须为明确的 UTC 时刻。');
  }
}

function publicVisibility(time: TimeWithPrecision, cutoff: number | undefined): 'visible' | 'future' | 'unresolved' {
  if (time.status !== 'known') return 'unresolved';
  if (cutoff === undefined || Date.parse(time.latest_exclusive_utc) <= cutoff) return 'visible';
  if (Date.parse(time.earliest_utc) > cutoff) return 'future';
  return 'unresolved';
}

export type MasterIdentityResolution =
  | { status: 'resolved_unique'; target: MasterIdentityRef; bindings: readonly ExternalIdentifierBinding[] }
  | { status: 'ambiguous_conflict'; candidates: readonly ExternalIdentifierBinding[] }
  | { status: 'indeterminate_temporal_evidence' | 'not_found_unknown' };

export function resolveMasterIdentity(request: MasterIdentityRequest, snapshot: Pick<EntitySecurityMasterBundle, 'bindings'>): MasterIdentityResolution {
  validateMasterIdentityRequest(request);
  const cutoff = request.marketKnownAtUtc === undefined ? undefined : Date.parse(request.marketKnownAtUtc);
  const matches: ExternalIdentifierBinding[] = [];
  for (const binding of snapshot.bindings) {
    validateBinding(binding);
    if (binding.scheme !== request.scheme || binding.code !== request.code || binding.marketMic !== request.marketMic) continue;
    const visibility = publicVisibility(binding.publicTime, cutoff);
    if (visibility === 'future') continue;
    const period = binding.effectivePeriod;
    if (period.status === 'known' && !includesDay(period, request.asOfDate)) continue;
    if (visibility === 'unresolved') return { status: 'indeterminate_temporal_evidence' };
    if (period.status === 'known') matches.push(binding);
  }
  const first = matches[0];
  if (!first) return { status: 'not_found_unknown' };
  if (matches.some(binding => !sameIdentity(first.target, binding.target))) return { status: 'ambiguous_conflict', candidates: matches };
  return { status: 'resolved_unique', target: first.target, bindings: matches };
}

interface ListingStateRequest extends MasterTimeQuery {
  readonly listing: MasterIdentityRef<'listing'>;
  readonly marketMic: string;
}

export function resolveListingLifecycleState(request: ListingStateRequest,
  snapshot: Pick<EntitySecurityMasterBundle, 'lifecycleEvents'>): ListingLifecycleState {
  validateMasterIdentityRef(request.listing);
  if (request.listing.kind !== 'listing' || !marketMic(request.marketMic)) {
    throw new TaskError('MASTER_LIFECYCLE_INVALID', '挂牌状态查询须绑定 listing 身份及市场 MIC。');
  }
  const cutoff = readTimeQuery(request);
  let upcomingIpo = false;
  let latestDate: string | undefined;
  let latestState: StateTransition | undefined;
  let latestCoversDate = false;
  let conflicting = false;
  for (const record of snapshot.lifecycleEvents) {
    if (!sameIdentity(record.listing, request.listing) || record.marketMic !== request.marketMic) continue;
    const { effectivePeriod: period, event, publicTime } = record;
    const visibility = publicVisibility(publicTime, cutoff);
    if (period.status !== 'known') return 'unknown';
    if (period.validFrom > request.asOfDate) {
      if (event === 'ipo_listed' && visibility === 'visible') upcomingIpo = true;
      continue;
    }

    // 业务日期已经涉及的事件若缺公开资格，不能据较早事件断言交易状态。
    if (visibility !== 'visible') return 'unknown';
    const state = LIFECYCLE_TRANSITIONS[event];
    if (!state || (latestDate !== undefined && period.validFrom < latestDate)) continue;
    if (period.validFrom !== latestDate) {
      latestDate = period.validFrom;
      latestState = state;
      latestCoversDate = false;
      conflicting = false;
    }
    conflicting ||= state !== latestState;
    latestCoversDate ||= includesDay(period, request.asOfDate);
  }
  if (latestState) return latestCoversDate && !conflicting ? latestState : 'unknown';
  return upcomingIpo ? 'pre_listing' : 'unknown';
}

type CalendarQualificationResult = ReturnType<typeof evaluateCalendarQualification>;
export interface ListingCoverageInput extends ListingStateRequest {
  readonly masterSnapshotDigest?: string;
  readonly calendar: Parameters<typeof evaluateCalendarQualification>[0];
  readonly calendarContent?: { readonly open: readonly string[]; readonly closed: readonly string[] };
}

export type ListingCoverageExpectation = 'expected_observation' | 'not_expected_market_closed' | 'not_expected_suspended'
  | 'not_expected_outside_listing_window' | 'unknown_coverage_expectation';

/** 宿主提供受信的日历核验记录和主数据登记表，查询用候选摘要定位已采用快照。 */
export function evaluateListingCoverageExpectation(input: ListingCoverageInput,
  trustedCalendarSnapshots?: ReadonlyMap<string, string>,
  trustedMasterRegistry?: EntitySecurityMasterRegistry): ListingCoverageExpectation {
  const unknown = 'unknown_coverage_expectation';
  const { listing, marketMic, asOfDate, marketKnownAtUtc, masterSnapshotDigest } = input;
  if (!isSecondUtcInstant(marketKnownAtUtc) || typeof masterSnapshotDigest !== 'string') return unknown;
  const snapshot = trustedMasterRegistry?.getAdoptedSnapshot(masterSnapshotDigest);
  if (!snapshot || snapshot.candidateDigest !== masterSnapshotDigest) return unknown;
  const state = resolveListingLifecycleState({ listing, marketMic, asOfDate, marketKnownAtUtc }, snapshot);
  if (state === 'unknown') return unknown;
  const qualified: CalendarQualificationResult = evaluateCalendarQualification(input.calendar, trustedCalendarSnapshots);
  if (!qualified.authoritativeFullCalendar || qualified.calendarRef.exchangeCode !== marketMic
    || asOfDate < qualified.calendarRef.effectiveFrom || asOfDate > qualified.calendarRef.effectiveTo) return unknown;

  const { calendarContent, calendar: { evidence } } = input;
  if (!isWfdRecord(evidence) || !isWfdRecord(calendarContent) || !hasOnly(calendarContent, ['open', 'closed'])
    || !Array.isArray(calendarContent.open) || !Array.isArray(calendarContent.closed)
    || !calendarContent.open.every(validDay) || !calendarContent.closed.every(validDay)
    || wfdSha256(canonicalWfdJson(calendarContent)) !== evidence.snapshotContentSha256) return unknown;
  const open = calendarContent.open.includes(asOfDate);
  const closed = calendarContent.closed.includes(asOfDate);
  if (open === closed) return unknown;
  if (closed) return 'not_expected_market_closed';
  if (state === 'suspended') return 'not_expected_suspended';
  if (state === 'pre_listing' || state === 'delisted') return 'not_expected_outside_listing_window';
  return 'expected_observation';
}

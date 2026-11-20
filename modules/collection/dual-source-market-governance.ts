import { canonicalWfdJson, isFixedWfdSnapshot, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import type { AcquisitionOriginal } from '../../contracts/source-acquisition.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import {
  decodePublicDailyBars, normalizePublicDailyRequest,
  type PublicDailyProviderId, type PublicDailyRequest,
} from '../../plugins/api-sources/public-kline.js';
import { compareProfileSemantics, readSourceFieldProfile, type SourceFieldMapping, type SourceFieldProfile } from './source-field-profile.js';
import { sourceReportedDate } from './source-reported-table.js';

const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
const QUANTITY_FIELDS = ['volume', 'amount'] as const;
const PRICE_MEASUREMENTS = { open: '未复权每股开盘价', high: '未复权每股最高价', low: '未复权每股最低价', close: '未复权每股收盘价' };
const DAILY_PRICE_PROJECTION: readonly SourceFieldMapping[] = [
  { originalHeader: 'symbol', fieldCode: 'symbol', dataType: 'text', unitCode: 'not_applicable', role: 'identity' },
  { originalHeader: 'trade_date', fieldCode: 'trade_date', dataType: 'text', unitCode: 'date', role: 'date' },
  ...PRICE_FIELDS.map((fieldCode): SourceFieldMapping => ({
    originalHeader: fieldCode, fieldCode, dataType: 'decimal', unitCode: 'cny_per_share',
    role: 'value', measurement: PRICE_MEASUREMENTS[fieldCode],
  })),
];
const validDay = (value: unknown): value is string => sourceReportedDate(value, 'iso-date') !== null;
const fixedIdentity = (value: unknown): value is string => isFixedWfdSnapshot(value)
  && !/^(?:unknown|unverified|unspecified|pending)$/iu.test(value);
const evidenceRef = (value: unknown): value is AcquisitionOriginal => isWfdRecord(value) && fixedIdentity(value.fileRefId)
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256);

/** 以解码后的列作为来源列。量额是待核字段，档案不承诺每个供应商都返回原值。 */
export function buildDualSourceDailyFieldProfile(providerId: PublicDailyProviderId, options: {
  profileId?: string;
  confirmation: SourceFieldProfile['confirmation'];
}): SourceFieldProfile {
  if (providerId !== 'tencent' && providerId !== 'eastmoney') {
    throw new TaskError('SOURCE_FIELD_PROFILE', '只有腾讯与东方财富登记了受控不复权日线。');
  }
  return readSourceFieldProfile({
    version: 'bd.source-field-profile/1', profileId: options.profileId ?? `${providerId}.daily.raw`,
    sourceId: providerId, series: 'daily_bars', frequency: 'day',
    timeBucket: { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 1440, timezone: 'Asia/Shanghai' },
    adjustment: { status: 'raw' }, domainScope: { domain: 'market_series', periodBasis: 'day' },
    confirmation: options.confirmation,
    fields: [...DAILY_PRICE_PROJECTION, ...QUANTITY_FIELDS.map(fieldCode => ({
      originalHeader: fieldCode, fieldCode, dataType: 'decimal', unitCode: 'native_unverified', role: 'value',
    }))],
  }, providerId);
}

const ACTION_DATES = ['announcement_date', 'ex_dividend_date', 'record_date', 'payment_date'] as const;
const ACTION_VALUES = ['cash_dividend_per_share', 'bonus_share_ratio', 'capital_reserve_transfer_ratio', 'split_ratio'] as const;
const ACTION_FIELDS = [...ACTION_DATES, ...ACTION_VALUES, 'differentiated_dividend_note'] as const;
const ACTION_KEYS: readonly string[] = [...ACTION_FIELDS, 'claimStatus', 'public_time', 'effective_status'];
export type CorporateActionClaim = Record<typeof ACTION_FIELDS[number], string | null> & {
  claimStatus: 'source_claim';
  /** 原文独列的明确 UTC 时刻，或显式未知。 */
  public_time: string;
  effective_status: 'unknown';
};

/** 日期仅保留原报角色。公开时刻须独立提供，行动主张没有生效资格。 */
export function validateCorporateActionClaim(raw: unknown): CorporateActionClaim {
  const fail = (message: string): never => { throw new TaskError('CORPORATE_ACTION_CLAIM_INVALID', message); };
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !ACTION_KEYS.includes(key))) {
    return fail('公司行动只接受已登记的来源主张字段。');
  }
  if (raw.claimStatus !== undefined && raw.claimStatus !== 'source_claim') {
    return fail('公司行动须保持 source_claim（来源主张）。');
  }
  if ((raw.effective_status ?? 'unknown') !== 'unknown') {
    return fail('未经生效证据核验的公司行动，其生效状态须保持 unknown。');
  }
  const publicTime = raw.public_time ?? 'unknown';
  if (publicTime !== 'unknown' && !isExplicitUtcInstant(publicTime)) {
    return fail('公开时间须为原文单列的明确 UTC 时刻，或保留 unknown。');
  }
  const fields = {} as Record<typeof ACTION_FIELDS[number], string | null>;
  for (const field of ACTION_DATES) {
    const value = raw[field] ?? null;
    fields[field] = value === null || validDay(value) ? value : fail(`${field} 须为有效的 YYYY-MM-DD 日期。`);
  }
  for (const field of ACTION_VALUES) {
    const value = raw[field] ?? null;
    if (value !== null && (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))) {
      return fail(`${field} 须保留非负精确十进制字符串。`);
    }
    fields[field] = value;
  }
  const note = raw.differentiated_dividend_note ?? null;
  if (note !== null && (typeof note !== 'string' || !note.trim() || note.length > 4096 || note.includes('\0'))) {
    return fail('差异化分红说明须保留有界的原报文字。');
  }
  fields.differentiated_dividend_note = note;
  if (Object.values(fields).every(value => value === null)) return fail('公司行动至少须有一项原报字段值。');
  return { ...fields, claimStatus: 'source_claim', public_time: publicTime, effective_status: 'unknown' };
}

interface DailySourceInput {
  providerId: PublicDailyProviderId;
  /** 调用方先按既有来源回执核对原请求和原件。 */
  request: PublicDailyRequest;
  rawBytes: Uint8Array;
  completeRangeEvidence?: {
    status: 'verified';
    receiptId: string;
    verifiedBy: string;
    providerId: PublicDailyProviderId;
    request: Required<PublicDailyRequest>;
    rawSha256: string;
    /** 上述回执正文的 canonicalWfdJson（规范 JSON）SHA-256。 */
    receiptDigest: string;
    /** 独立核验回执的材料引用。 */
    evidence: AcquisitionOriginal;
  };
}
export interface DualSourceDailyComparisonInput {
  left: DailySourceInput;
  right: DailySourceInput;
  /** 同一证券在该固定区间的有据预期日期，由调用方声明。 */
  expectedTradeDates?: readonly string[];
}
type DailyObservation = 'observed' | 'not_observed' | 'unknown';

function verifiedRangeEvidence(proof: DailySourceInput['completeRangeEvidence'], providerId: PublicDailyProviderId,
  request: Required<PublicDailyRequest>, rawSha256: string,
  trustedCompletenessReceipts: ReadonlyMap<string, string> | undefined): AcquisitionOriginal | null {
  if (!trustedCompletenessReceipts || !proof || proof.status !== 'verified'
    || !fixedIdentity(proof.receiptId) || !fixedIdentity(proof.verifiedBy)
    || proof.providerId !== providerId || proof.rawSha256 !== rawSha256 || !isWfdRecord(proof.request)
    || !evidenceRef(proof.evidence) || proof.evidence.sha256 === rawSha256 || proof.receiptDigest !== proof.evidence.sha256) {
    return null;
  }
  const { symbol, start, end, limit, adjustment } = proof.request;
  if (symbol !== request.symbol || start !== request.start || end !== request.end || limit !== request.limit
    || adjustment !== request.adjustment) return null;
  const rawReferences = [rawSha256, `sha256:${rawSha256}`];
  if (rawReferences.includes(proof.receiptId) || rawReferences.includes(proof.evidence.fileRefId)) return null;

  const receipt = { status: proof.status, receiptId: proof.receiptId, verifiedBy: proof.verifiedBy, providerId, request, rawSha256 };
  const receiptDigest = wfdSha256(canonicalWfdJson(receipt));
  if (receiptDigest !== proof.receiptDigest || trustedCompletenessReceipts.get(receipt.receiptId) !== receiptDigest) return null;
  return { ...proof.evidence };
}

function dailySource(source: DailySourceInput, request: Required<PublicDailyRequest>,
  trustedCompletenessReceipts: ReadonlyMap<string, string> | undefined) {
  const decoded = decodePublicDailyBars(source.providerId, request, source.rawBytes);
  const limitReached = decoded.recordCount === request.limit;
  const rangeEvidence = limitReached ? null
    : verifiedRangeEvidence(source.completeRangeEvidence, decoded.providerId, request, decoded.rawSha256, trustedCompletenessReceipts);
  const rangeCoverageGap = limitReached ? '来源响应已达到请求条数上限。'
    : rangeEvidence ? null : '缺少受信宿主核验通过的区间完整性回执。';
  return {
    rows: new Map(decoded.rows.map(row => [row.trade_date, row])),
    summary: {
      providerId: decoded.providerId, rawSha256: decoded.rawSha256, recordCount: decoded.recordCount,
      limit: request.limit, limitReached, rangeCoverage: rangeEvidence ? 'confirmed' as const : 'unknown' as const,
      rangeEvidence, rangeCoverageGap,
    },
  };
}

/** 解码器已经校验十进制语法。只消去小数尾零以比较精确数值。 */
const decimalValue = (value: string) => value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;

/** 受信宿主单独传入已核验的 receiptId → 规范回执 SHA-256 登记。 */
export function compareDualSourceDailyBars(input: DualSourceDailyComparisonInput,
  trustedCompletenessReceipts?: ReadonlyMap<string, string>) {
  const leftRequest = normalizePublicDailyRequest({ ...input.left.request });
  const rightRequest = normalizePublicDailyRequest({ ...input.right.request });
  const { symbol, start, end, adjustment } = leftRequest;
  if (input.left.providerId === input.right.providerId || symbol !== rightRequest.symbol
    || start !== rightRequest.start || end !== rightRequest.end) {
    throw new TaskError('DUAL_SOURCE_DAILY_INPUT', '双源日线须为两个不同供应商对同一证券和固定区间的受控不复权请求。');
  }
  const expected = new Set<string>();
  for (const day of input.expectedTradeDates ?? []) {
    if (!validDay(day) || day < start || day > end || expected.has(day)) {
      throw new TaskError('DUAL_SOURCE_DAILY_INPUT', '预期日期须为固定区间内有效且不重复的业务日期。');
    }
    expected.add(day);
  }
  const left = dailySource(input.left, leftRequest, trustedCompletenessReceipts);
  const right = dailySource(input.right, rightRequest, trustedCompletenessReceipts);
  const dates = [...new Set([...expected, ...left.rows.keys(), ...right.rows.keys()])].sort();
  const observation = (observed: boolean, rangeConfirmed: boolean): DailyObservation => {
    if (observed) return 'observed';
    return rangeConfirmed ? 'not_observed' : 'unknown';
  };
  return {
    symbol, start, end, adjustment, left: left.summary, right: right.summary,
    // 受控解码器的两种来源均只声明 native_unverified。
    units: { volume: 'unit_unverified', amount: 'unit_unverified' } as const,
    dates: dates.map(tradeDate => {
      const a = left.rows.get(tradeDate), b = right.rows.get(tradeDate);
      const priceDifferences = a && b ? PRICE_FIELDS.filter(field => decimalValue(a[field]) !== decimalValue(b[field])) : [];
      const priceComparison = a && b ? priceDifferences.length ? 'price_discrepancy' : 'exact_match' : 'not_comparable';
      return {
        tradeDate, expected: expected.has(tradeDate),
        left: observation(a !== undefined, left.summary.rangeCoverage === 'confirmed'),
        right: observation(b !== undefined, right.summary.rangeCoverage === 'confirmed'),
        priceComparison, priceDifferences,
      } as const;
    }),
  };
}

export function evaluateDualSourceSwitchEligibility(input: DualSourceDailyComparisonInput & {
  leftProfile: SourceFieldProfile;
  rightProfile: SourceFieldProfile;
}, trustedCompletenessReceipts?: ReadonlyMap<string, string>) {
  const comparison = compareDualSourceDailyBars(input, trustedCompletenessReceipts);
  const left = readSourceFieldProfile(input.leftProfile, '双源左侧来源');
  const right = readSourceFieldProfile(input.rightProfile, '双源右侧来源');
  const semantics = compareProfileSemantics(left, right);
  const result = { comparison, semantics };
  if (left.sourceId !== comparison.left.providerId || right.sourceId !== comparison.right.providerId) {
    return { ...result, status: 'blocked_needs_evidence' as const, reasons: ['G5 档案须绑定对应来源。'] };
  }
  if (semantics.status === 'different_semantics') {
    return { ...result, status: 'split_definition_required' as const, reasons: semantics.differences };
  }
  const reasons = [...semantics.gaps];
  for (const profile of [left, right]) {
    const fields = new Map(profile.fields.map(field => [field.fieldCode, field]));
    const coversPrices = DAILY_PRICE_PROJECTION.every(expected => {
      const field = fields.get(expected.fieldCode);
      return field?.originalHeader === expected.originalHeader && field.dataType === expected.dataType
        && field.unitCode === expected.unitCode && field.role === expected.role;
    });
    if (!coversPrices || profile.frequency !== 'day' || profile.adjustment.status !== 'raw') {
      reasons.push(`来源 ${profile.sourceId} 的档案须覆盖与解码列对应的不复权日线证券、日期和 OHLC。`);
    }
    if (QUANTITY_FIELDS.some(field => fields.has(field))) {
      reasons.push(`来源 ${profile.sourceId} 的档案含成交量或成交额，其原生单位仍待核实。`);
    } else if (profile.fields.length > DAILY_PRICE_PROJECTION.length) {
      reasons.push(`来源 ${profile.sourceId} 的档案含本次日线原件未核对的字段。`);
    }
  }
  if (comparison.left.rangeCoverage === 'unknown' || comparison.right.rangeCoverage === 'unknown') {
    reasons.push('至少一侧未证实区间完整，或已达到请求条数上限。');
  }
  if (!comparison.dates.length || comparison.dates.some(day => !day.expected || day.left !== 'observed' || day.right !== 'observed')) {
    reasons.push('须有明确预期日期，且两侧逐日实见的业务键与预期一致。');
  }
  if (comparison.dates.some(day => day.priceComparison === 'price_discrepancy')) reasons.push('双源 OHLC 存在精确数值差异。');
  return { ...result, status: reasons.length ? 'blocked_needs_evidence' as const : 'reuse_same_product_allowed' as const, reasons };
}

export interface AuthoritativeCalendarRef {
  calendarId: string;
  exchangeCode: string;
  marketScope: string;
  timezone: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string;
  snapshotId: string;
  sourceAuthority: string;
}
const CALENDAR_FIELDS: readonly (keyof AuthoritativeCalendarRef)[] = [
  'calendarId', 'exchangeCode', 'marketScope', 'timezone', 'version', 'effectiveFrom', 'effectiveTo', 'snapshotId', 'sourceAuthority',
];
const PARTIAL_HOLIDAY_COVERAGE = /^(?:\d{4}_)?partial_holiday_notice_only$/u;

/** 受信宿主单独传入 snapshotId → 已核验的规范快照载荷 SHA-256 登记。 */
export function evaluateCalendarQualification(input: {
  coverage: string;
  calendarRef?: unknown;
  evidence?: unknown;
}, trustedCalendarSnapshots?: ReadonlyMap<string, string>) {
  const unqualified = { authoritativeFullCalendar: false, calendarRef: null, securityLifecycle: 'unknown' } as const;
  const evidence = isWfdRecord(input.evidence) ? input.evidence : null;
  const evidenceKind = evidence?.evidenceKind;
  if (PARTIAL_HOLIDAY_COVERAGE.test(input.coverage) || evidenceKind === 'holiday_notice_announcement'
    || (typeof evidence?.coverage === 'string' && PARTIAL_HOLIDAY_COVERAGE.test(evidence.coverage))) {
    return { ...unqualified, status: 'partial_holiday_notice_only' as const };
  }
  const blocked = { ...unqualified, status: 'blocked_needs_evidence' } as const;
  const ref = isWfdRecord(input.calendarRef) ? { ...input.calendarRef } : null;
  if (input.coverage !== 'authoritative_full_calendar' || evidenceKind !== 'authoritative_calendar_snapshot'
    || !evidence || !evidenceRef(evidence) || !ref
    || Object.keys(ref).length !== CALENDAR_FIELDS.length
    || !CALENDAR_FIELDS.every(field => Object.hasOwn(ref, field) && fixedIdentity(ref[field])
      && Object.hasOwn(evidence, field) && evidence[field] === ref[field])
    || !validDay(ref.effectiveFrom) || !validDay(ref.effectiveTo) || ref.effectiveFrom > ref.effectiveTo) {
    return blocked;
  }
  try { new Intl.DateTimeFormat('en', { timeZone: String(ref.timezone) }); }
  catch { return blocked; }
  const calendarRef = ref as unknown as AuthoritativeCalendarRef;
  const unverified = { ...unqualified, status: 'caller_supplied_not_verified' } as const;
  const { snapshotContentSha256 } = evidence;
  if (typeof snapshotContentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshotContentSha256)) return unverified;

  const snapshotDigest = wfdSha256(canonicalWfdJson({ ...calendarRef, evidenceKind, snapshotContentSha256 }));
  if (snapshotDigest !== evidence.sha256 || trustedCalendarSnapshots?.get(calendarRef.snapshotId) !== snapshotDigest) return unverified;
  return { status: 'authoritative_full_calendar', authoritativeFullCalendar: true,
    calendarRef, securityLifecycle: 'unknown' } as const;
}

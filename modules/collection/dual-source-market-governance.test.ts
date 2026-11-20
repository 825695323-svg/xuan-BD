import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { decodePublicDailyBars, type PublicDailyProviderId, type PublicDailyRequest } from '../../plugins/api-sources/public-kline.js';
import {
  buildDualSourceDailyFieldProfile, compareDualSourceDailyBars, evaluateCalendarQualification,
  evaluateDualSourceSwitchEligibility, validateCorporateActionClaim, type AuthoritativeCalendarRef,
} from './dual-source-market-governance.js';
import { assertCrossSourceProductAdmission, compareProfileSemantics, type SourceFieldProfile } from './source-field-profile.js';

// 内存合成样本。日期、证券、取数预算和证据引用均不代表真实市场、供应商或文件。
const first = '2042-07-01', second = '2042-07-02', third = '2042-07-03';
const request: Required<PublicDailyRequest> = { symbol: '000000.SH', start: first, end: third, adjustment: 'none', limit: 10 };
const bar = { day: first, open: '10.25', high: '12', low: '9', close: '11.1', volume: '1000', amount: '816.28' };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const evidence = { fileRefId: 'fixture-reviewed-original', sha256: 'a'.repeat(64) };
const confirmation: SourceFieldProfile['confirmation'] = {
  status: 'operator_confirmed', basis: '离线合成的档案核对依据', confirmedAtUtc: '2042-07-10T02:00:00Z',
};

function source(providerId: PublicDailyProviderId, rows: readonly (typeof bar)[], bound = request) {
  const [code, market] = bound.symbol.split('.');
  const rawBytes = providerId === 'tencent'
    ? bytes({ code: 0, data: { [market.toLowerCase() + code]: {
      day: rows.map(row => [row.day, row.open, row.close, row.high, row.low, row.volume]),
    } } })
    : bytes({ rc: 0, data: { code, market: market === 'SH' ? 1 : 0, fqt: 0,
      klines: rows.map(row => [row.day, row.open, row.close, row.high, row.low, row.volume, row.amount].join(',')),
    } });
  const decoded = decodePublicDailyBars(providerId, bound, rawBytes);
  const receipt = { status: 'verified' as const, receiptId: `fixture-${providerId}-receipt`, verifiedBy: 'fixture-reviewer',
    providerId, request: bound, rawSha256: decoded.rawSha256 };
  const receiptDigest = wfdSha256(canonicalWfdJson(receipt));
  return { providerId, request: bound, rawBytes,
    completeRangeEvidence: { ...receipt, receiptDigest, evidence: { ...evidence, sha256: receiptDigest } } };
}

function trustedReceipts(...sources: ReturnType<typeof source>[]): ReadonlyMap<string, string> {
  return new Map(sources.map(({ completeRangeEvidence: { receiptId, receiptDigest } }) => [receiptId, receiptDigest]));
}

function priceProfile(providerId: PublicDailyProviderId): SourceFieldProfile {
  const profile = buildDualSourceDailyFieldProfile(providerId, { confirmation });
  return { ...profile, fields: profile.fields.filter(field => field.fieldCode !== 'volume' && field.fieldCode !== 'amount') };
}

function switchInput() {
  return { left: source('tencent', [bar]), right: source('eastmoney', [bar]), expectedTradeDates: [first],
    leftProfile: priceProfile('tencent'), rightProfile: priceProfile('eastmoney') };
}

test('G5 不复权日线模板锁定频率与复权，量额继续阻断共用产品', () => {
  const options = { confirmation, profileId: 'fixture-tencent', frequency: 'minute', adjustment: 'qfq', volumeUnit: 'share' };
  const tencent = buildDualSourceDailyFieldProfile('tencent', options);
  const eastmoney = buildDualSourceDailyFieldProfile('eastmoney', { confirmation });
  assert.equal(tencent.profileId, 'fixture-tencent');
  for (const [providerId, profile] of [['tencent', tencent], ['eastmoney', eastmoney]] as const) {
    assert.equal(profile.sourceId, providerId);
    assert.equal(profile.frequency, 'day');
    assert.deepEqual(profile.adjustment, { status: 'raw' });
    assert.deepEqual(profile.fields.map(field => field.fieldCode), ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'amount']);
    assert.deepEqual(profile.fields.slice(-2).map(field => field.unitCode), ['native_unverified', 'native_unverified']);
  }
  assert.equal(compareProfileSemantics(tencent, eastmoney).status, 'needs_evidence');
  assert.throws(() => assertCrossSourceProductAdmission(eastmoney, [tencent]), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED' });
  assert.throws(() => buildDualSourceDailyFieldProfile('tencent', {
    confirmation: { ...confirmation, basis: 'unknown' },
  }), { code: 'SOURCE_FIELD_PROFILE' });
});

const action = {
  announcement_date: first, ex_dividend_date: '2042-07-11', record_date: '2042-07-10', payment_date: '2042-07-12',
  cash_dividend_per_share: '0.02500', bonus_share_ratio: '0', capital_reserve_transfer_ratio: '0.125',
  split_ratio: '1.5', differentiated_dividend_note: '合成样本的差异化说明',
};

test('公司行动逐字段保留日期、十进制和差异化说明，缺证时间与状态显式未知', () => {
  assert.deepEqual(validateCorporateActionClaim(action), {
    ...action, claimStatus: 'source_claim', public_time: 'unknown', effective_status: 'unknown',
  });
  const explicit = validateCorporateActionClaim({
    ...action, claimStatus: 'source_claim', public_time: '2042-07-02T01:23:45.678Z', effective_status: null,
  });
  assert.equal(explicit.public_time, '2042-07-02T01:23:45.678Z');
  assert.equal(explicit.effective_status, 'unknown');
  const partial = validateCorporateActionClaim({ record_date: first, public_time: 'unknown' });
  assert.equal(partial.announcement_date, null);
  assert.equal(partial.cash_dividend_per_share, null);
  assert.equal(partial.differentiated_dividend_note, null);
});

test('公司行动拒绝事实升级、仅日期公开时间、无效日期和数字转换', () => {
  for (const override of [
    { claimStatus: 'observed_fact' }, { effective_status: 'effective' }, { adjustment_factor: '1.1' },
    { public_time: first }, { public_time: action.ex_dividend_date }, { public_time: '2042-07-02T01:23:45' },
    { announcement_date: '2042-02-30' }, { record_date: '2042-07-01T00:00:00Z' },
    { cash_dividend_per_share: 0.025 }, { bonus_share_ratio: '-0.5' }, { split_ratio: '1e-4' },
    { differentiated_dividend_note: '' },
  ]) {
    assert.throws(() => validateCorporateActionClaim({ ...action, ...override }), { code: 'CORPORATE_ACTION_CLAIM_INVALID' });
  }
  assert.throws(() => validateCorporateActionClaim({ public_time: 'unknown' }), { code: 'CORPORATE_ACTION_CLAIM_INVALID' });
});

test('腾讯与东方财富的原价逐日精确比较，小数尾零和原生量额均不会制造价差', () => {
  const precise = { ...bar, day: second, high: '9007199254740994', close: '9007199254740993.00000000000001' };
  const left = source('tencent', [bar, precise]);
  const right = source('eastmoney', [
    { ...bar, open: '10.2500', high: '12.00', volume: '7', amount: '9999' },
    { ...precise, close: '9007199254740993.00000000000002' },
  ]);
  const decodedLeft = decodePublicDailyBars('tencent', request, left.rawBytes);
  const decodedRight = decodePublicDailyBars('eastmoney', request, right.rawBytes);
  assert.equal(decodedLeft.rows[0]?.amount, undefined);
  assert.equal(decodedRight.rows[0]?.amount, '9999');
  assert.equal(decodedLeft.volumeUnit, 'native_unverified');
  assert.equal(decodedRight.amountUnit, 'native_unverified');
  const result = compareDualSourceDailyBars({ left, right, expectedTradeDates: [second, first] });
  assert.deepEqual(result.units, { volume: 'unit_unverified', amount: 'unit_unverified' });
  assert.deepEqual(result.dates, [
    { tradeDate: first, expected: true, left: 'observed', right: 'observed', priceComparison: 'exact_match', priceDifferences: [] },
    { tradeDate: second, expected: true, left: 'observed', right: 'observed', priceComparison: 'price_discrepancy', priceDifferences: ['close'] },
  ]);
});

test('覆盖逐日区分已见、已证区间缺行与未知，命中请求上限仍保留已见价格', () => {
  const left = source('tencent', [bar, { ...bar, day: third }]);
  const right = source('eastmoney', [bar]);
  const expectedTradeDates = [first, second, third];
  const result = compareDualSourceDailyBars({ left, right, expectedTradeDates }, trustedReceipts(left));
  assert.equal(result.left.rangeCoverage, 'confirmed');
  assert.equal(result.left.rangeCoverageGap, null);
  assert.equal(result.right.rangeCoverage, 'unknown');
  assert.deepEqual(result.dates.map(day => [day.tradeDate, day.left, day.right, day.priceComparison]), [
    [first, 'observed', 'observed', 'exact_match'], [second, 'not_observed', 'unknown', 'not_comparable'],
    [third, 'observed', 'unknown', 'not_comparable'],
  ]);
  const limited = source('tencent', [bar], { ...request, limit: 1 });
  const capped = compareDualSourceDailyBars({ left: limited, right, expectedTradeDates }, trustedReceipts(limited, right));
  assert.equal(capped.left.limitReached, true);
  assert.equal(capped.left.rangeCoverage, 'unknown');
  assert.equal(capped.left.rangeEvidence, null);
  assert.equal(capped.dates[0]?.priceComparison, 'exact_match');
  assert.equal(capped.dates[1]?.left, 'unknown');
  assert.equal(capped.dates[1]?.right, 'not_observed');
});

test('自算日线回执须匹配宿主登记的回执 ID 与规范摘要才能证实缺行', () => {
  const { left, right } = switchInput();
  const { receiptId, receiptDigest } = left.completeRangeEvidence;
  const input = { left, right, expectedTradeDates: [first, second] };
  for (const registry of [undefined, new Map(), new Map([[receiptId, evidence.sha256]]),
    new Map([['fixture-other-receipt', receiptDigest]])]) {
    const result = compareDualSourceDailyBars(input, registry);
    assert.equal(result.left.rangeCoverage, 'unknown');
    assert.equal(result.left.rangeEvidence, null);
    assert.match(result.left.rangeCoverageGap ?? '', /受信宿主/u);
    assert.equal(result.dates[1]?.left, 'unknown');
  }
  const confirmed = compareDualSourceDailyBars(input, trustedReceipts(left));
  assert.deepEqual(confirmed.left.rangeEvidence, left.completeRangeEvidence.evidence);
  assert.equal(confirmed.dates[1]?.left, 'not_observed');
});

test('完整性回执须绑定本方供应商、证券、请求区间、条数上限及原件摘要', () => {
  const { left, right } = switchInput();
  const proof = left.completeRangeEvidence;
  const registry = trustedReceipts(left, right);
  for (const completeRangeEvidence of [
    { ...proof, providerId: right.providerId }, { ...proof, rawSha256: right.completeRangeEvidence.rawSha256 },
    { ...proof, request: { ...request, symbol: '000001.SH' } }, { ...proof, request: { ...request, start: second } },
    { ...proof, request: { ...request, end: second } }, { ...proof, request: { ...request, limit: request.limit + 1 } },
    { ...proof, evidence: { ...evidence, sha256: 'unknown' } },
    { ...proof, receiptId: 'fixture-other-receipt' }, { ...proof, verifiedBy: 'fixture-other-reviewer' },
    { ...proof, receiptDigest: 'b'.repeat(64) },
  ]) {
    const result = compareDualSourceDailyBars({ left: { ...left, completeRangeEvidence }, right, expectedTradeDates: [first, second] }, registry);
    assert.equal(result.left.rangeCoverage, 'unknown');
    assert.equal(result.dates[1]?.left, 'unknown');
  }
});

test('原始响应即使标注已核验也不能作为独立完整性回执', () => {
  const { left, right } = switchInput();
  const proof = left.completeRangeEvidence;
  const responseOriginal = { fileRefId: 'fixture-response-original', sha256: proof.rawSha256 };
  const result = compareDualSourceDailyBars({
    left: { ...left, completeRangeEvidence: { ...proof, receiptDigest: proof.rawSha256, evidence: responseOriginal } },
    right, expectedTradeDates: [first, second],
  }, trustedReceipts(left, right));
  assert.equal(result.left.rangeCoverage, 'unknown');
  assert.equal(result.left.rangeEvidence, null);
  assert.equal(result.dates[1]?.left, 'unknown');
});

test('双源比较拒绝同源、跨证券、跨区间、复权及错分支的输入', () => {
  const { left, right } = switchInput();
  for (const mismatched of [
    left,
    source('eastmoney', [bar], { ...request, symbol: '000001.SZ' }),
    source('eastmoney', [bar], { ...request, end: second }),
  ]) assert.throws(() => compareDualSourceDailyBars({ left, right: mismatched }), { code: 'DUAL_SOURCE_DAILY_INPUT' });
  assert.throws(() => compareDualSourceDailyBars({ left, right: {
    ...right, request: { ...request, adjustment: 'qfq' as PublicDailyRequest['adjustment'] },
  } }), { code: 'SOURCE_PARAMETERS_INVALID' });
  assert.throws(() => compareDualSourceDailyBars({ right, left: {
    ...left, rawBytes: bytes({ code: 0, data: { sh000000: { qfqday: [] } } }),
  } }), { code: 'SOURCE_DAILY_RESPONSE_INVALID' });
  for (const expectedTradeDates of [[first, first], ['2042-02-30'], ['2042-07-04']]) {
    assert.throws(() => compareDualSourceDailyBars({ left, right, expectedTradeDates }), { code: 'DUAL_SOURCE_DAILY_INPUT' });
  }
});

test('仅原价且逐日和语义都核对一致时可共用产品，有已知口径差异时需分定义', () => {
  const input = switchInput();
  const registry = trustedReceipts(input.left, input.right);
  const eligible = evaluateDualSourceSwitchEligibility(input, registry);
  assert.equal(eligible.status, 'reuse_same_product_allowed');
  assert.equal(eligible.semantics.status, 'candidate_equivalent');
  assert.deepEqual(eligible.reasons, []);
  const rightProfile = { ...input.rightProfile, fields: input.rightProfile.fields.map(field =>
    field.fieldCode === 'close' ? { ...field, unitCode: 'cny_per_lot' } : field) };
  const split = evaluateDualSourceSwitchEligibility({ ...input, rightProfile }, registry);
  assert.equal(split.status, 'split_definition_required');
  assert.equal(split.semantics.status, 'different_semantics');
  assert.match(split.reasons.join(' '), /close.*单位/u);
});

test('原价差异、覆盖不足、档案错绑或未核量额均阻断同产品切源', () => {
  const input = switchInput();
  const registry = trustedReceipts(input.left, input.right);
  assert.equal(evaluateDualSourceSwitchEligibility(input).status, 'blocked_needs_evidence');
  for (const override of [
    { left: { ...input.left, completeRangeEvidence: undefined } },
    { left: source('tencent', [bar], { ...request, limit: 1 }) },
    { right: source('eastmoney', [{ ...bar, open: '10.26' }]) },
    { expectedTradeDates: undefined }, { expectedTradeDates: [first, second] }, { expectedTradeDates: [second] },
    { leftProfile: priceProfile('eastmoney') },
    { leftProfile: { ...input.leftProfile, fields: input.leftProfile.fields.map(field =>
      field.fieldCode === 'open' ? { ...field, originalHeader: 'other_open' } : field) } },
  ]) {
    const result = evaluateDualSourceSwitchEligibility({ ...input, ...override }, registry);
    assert.equal(result.status, 'blocked_needs_evidence');
    assert.ok(result.reasons.length);
  }
  const bothEmpty = { ...input, left: source('tencent', []), right: source('eastmoney', []), expectedTradeDates: [] };
  assert.equal(evaluateDualSourceSwitchEligibility(bothEmpty, trustedReceipts(bothEmpty.left, bothEmpty.right)).status, 'blocked_needs_evidence');

  const withQuantities = (providerId: PublicDailyProviderId, claimedUnit?: string) => {
    const profile = buildDualSourceDailyFieldProfile(providerId, { confirmation });
    return { ...profile, fields: profile.fields.map(field => field.unitCode === 'native_unverified' && claimedUnit
      ? { ...field, unitCode: claimedUnit, measurement: '合成档案声称单位已知' } : field) };
  };
  for (const claimedUnit of [undefined, 'fixture-unit']) {
    const result = evaluateDualSourceSwitchEligibility({ ...input,
      leftProfile: withQuantities('tencent', claimedUnit), rightProfile: withQuantities('eastmoney', claimedUnit),
    }, registry);
    assert.equal(result.status, 'blocked_needs_evidence');
    assert.ok(result.reasons.some(reason => reason.includes('原生单位仍待核实')));
  }
});

const calendarRef: AuthoritativeCalendarRef = {
  calendarId: 'fixture-calendar', exchangeCode: 'TEST-EXCHANGE', marketScope: 'TEST/MARKET', timezone: 'Asia/Shanghai',
  version: 'fixture-v1', effectiveFrom: first, effectiveTo: third, snapshotId: 'fixture-snapshot', sourceAuthority: 'fixture-authority',
};
const calendarSnapshot = { ...calendarRef, evidenceKind: 'authoritative_calendar_snapshot',
  snapshotContentSha256: wfdSha256(canonicalWfdJson({ open: [first, third], closed: [second] })) };
const calendarEvidence = { ...calendarSnapshot, fileRefId: evidence.fileRefId, sha256: wfdSha256(canonicalWfdJson(calendarSnapshot)) };
const trustedCalendarSnapshots = new Map([[calendarRef.snapshotId, calendarEvidence.sha256]]);

test('局部休市公告始终保留部分覆盖资格，即使一同提交完整形状的固定引用', () => {
  const expected = { status: 'partial_holiday_notice_only', authoritativeFullCalendar: false, calendarRef: null, securityLifecycle: 'unknown' };
  for (const coverage of ['2026_partial_holiday_notice_only', '2042_partial_holiday_notice_only', 'partial_holiday_notice_only']) {
    assert.deepEqual(evaluateCalendarQualification({ coverage, calendarRef, evidence: calendarEvidence }, trustedCalendarSnapshots), expected);
    assert.deepEqual(evaluateCalendarQualification({ coverage: 'authoritative_full_calendar', calendarRef,
      evidence: { ...calendarEvidence, coverage },
    }, trustedCalendarSnapshots), expected);
  }
  assert.deepEqual(evaluateCalendarQualification({ coverage: 'authoritative_full_calendar', calendarRef,
    evidence: { ...calendarEvidence, evidenceKind: 'holiday_notice_announcement', coverage: 'authoritative_full_calendar' },
  }, trustedCalendarSnapshots), expected);
});

test('完整日历资格需要证据类别、摘要及绑定的固定引用，日历始终不推断个券状态', () => {
  const input = { coverage: 'authoritative_full_calendar', calendarRef, evidence: calendarEvidence };
  assert.deepEqual(evaluateCalendarQualification(input, trustedCalendarSnapshots), {
    status: 'authoritative_full_calendar', authoritativeFullCalendar: true, calendarRef, securityLifecycle: 'unknown',
  });
  const { sourceAuthority: _sourceAuthority, ...withoutAuthority } = calendarRef;
  for (const override of [
    { coverage: 'unknown' }, { evidence: undefined }, { evidence }, { calendarRef: withoutAuthority },
    { evidence: { ...calendarEvidence, sha256: 'unknown' } },
    { evidence: { ...calendarEvidence, exchangeCode: 'OTHER-EXCHANGE' } },
    { evidence: { ...calendarEvidence, snapshotId: 'fixture-other-snapshot' } },
    { evidence: { ...calendarEvidence, calendarId: 'fixture-other-calendar' } },
    { evidence: { ...calendarEvidence, version: 'fixture-v2' } },
    { evidence: { ...calendarEvidence, effectiveFrom: second } },
    { evidence: { ...calendarEvidence, effectiveTo: second } },
    { evidence: { ...calendarEvidence, marketScope: 'OTHER/MARKET' } },
    { evidence: { ...calendarEvidence, timezone: 'UTC' } },
    { evidence: { ...calendarEvidence, sourceAuthority: 'fixture-other-authority' } },
    { calendarRef: { ...calendarRef, snapshotId: 'latest' } },
    { calendarRef: { ...calendarRef, timezone: 'Unknown/Zone' } },
    { calendarRef: { ...calendarRef, effectiveFrom: '2042-07-04' } },
    { calendarRef: { ...calendarRef, effectiveTo: '2042-02-30' } },
    { calendarRef: { ...calendarRef, sourceAuthority: 'unknown' } },
    { calendarRef: { ...calendarRef, inferredSuspension: true } },
  ]) {
    assert.deepEqual(evaluateCalendarQualification({ ...input, ...override }, trustedCalendarSnapshots), {
      status: 'blocked_needs_evidence', authoritativeFullCalendar: false, calendarRef: null, securityLifecycle: 'unknown',
    });
  }
});

test('完整日历须有宿主登记及绑定证据种类与内容哈希的摘要，休市公告改标签仍不得升级', () => {
  const input = { coverage: 'authoritative_full_calendar', calendarRef, evidence: calendarEvidence };
  const unverified = { status: 'caller_supplied_not_verified', authoritativeFullCalendar: false,
    calendarRef: null, securityLifecycle: 'unknown' };
  assert.deepEqual(evaluateCalendarQualification(input), unverified);
  assert.deepEqual(evaluateCalendarQualification(input, new Map()), unverified);
  assert.deepEqual(evaluateCalendarQualification(input, new Map([['fixture-other-snapshot', calendarEvidence.sha256]])), unverified);

  const { evidenceKind, snapshotContentSha256 } = calendarSnapshot;
  for (const payload of [
    { ...calendarRef, evidenceKind: 'holiday_notice_announcement', snapshotContentSha256 },
    { ...calendarRef, snapshotContentSha256 },
    { ...calendarRef, evidenceKind },
  ]) {
    const sha256 = wfdSha256(canonicalWfdJson(payload));
    assert.deepEqual(evaluateCalendarQualification({ ...input, evidence: { ...calendarEvidence, sha256 } },
      new Map([[calendarRef.snapshotId, sha256]])), unverified);
  }
  for (const contentSha256 of [undefined, 'f'.repeat(64)]) {
    assert.deepEqual(evaluateCalendarQualification({ ...input,
      evidence: { ...calendarEvidence, snapshotContentSha256: contentSha256 },
    }, trustedCalendarSnapshots), unverified);
  }
});

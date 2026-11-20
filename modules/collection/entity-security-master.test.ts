import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { AuthoritativeCalendarRef } from './dual-source-market-governance.js';
import {
  ENTITY_SECURITY_MASTER_VERSION, EntitySecurityMasterRegistry, evaluateListingCoverageExpectation,
  masterAdoptionReceiptDigest, resolveListingLifecycleState, resolveMasterIdentity, validateMasterIdentityRef, validateMasterIdentityRequest,
  type EffectiveDateRange, type EntityContinuityRecord, type EntitySecurityMasterBundle, type ExternalIdentifierBinding,
  type ListingLifecycleEvent, type MasterAdoptionReceipt, type MasterIdentityRef, type TimeWithPrecision,
} from './entity-security-master.js';

// 合成 A+H 架构及市场代码。全部编码、公告、回执和交易日仅用于测试。
const makeRef = <K extends MasterIdentityRef['kind']>(kind: K, id: string) => ({ kind, namespace: 'synthetic', id });
const issuer = makeRef('entity', 'issuer');
const successor = makeRef('entity', 'successor');
const aShare = makeRef('instrument', 'a-share');
const hShare = makeRef('instrument', 'h-share');
const aListing = makeRef('listing', 'a-listing');
const hListing = makeRef('listing', 'h-listing');
const mainland = makeRef('market', 'mainland');
const aMic = 'CA01';
const hMic = 'HK01';
const date = (day: string) => `2040-12-${day}`;
const time = (day: string) => `${date(day)}T01:00:00Z`;
const period = (validFrom: string, validUntilExclusive: string | null = null): EffectiveDateRange =>
  ({ status: 'known', validFrom, validUntilExclusive });
const published = (day: string): TimeWithPrecision => ({
  status: 'known', precision: 'second', earliest_utc: time(day), latest_exclusive_utc: `${date(day)}T01:00:01Z`,
  source_timezone: 'UTC', evidence_ref: `synthetic-publication-${day}`,
});
const unknownTime: TimeWithPrecision = {
  status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'UTC',
};
const dayOnlyTime: TimeWithPrecision = {
  status: 'known', precision: 'day', earliest_utc: '2040-12-03T16:00:00Z', latest_exclusive_utc: '2040-12-04T16:00:00Z',
  source_timezone: 'Asia/Shanghai', evidence_ref: 'synthetic-date-precision',
};
const binding = (scheme: ExternalIdentifierBinding['scheme'], code: string, target: MasterIdentityRef,
  overrides: Partial<ExternalIdentifierBinding> = {}): ExternalIdentifierBinding => ({
  scheme, code, target, effectivePeriod: period(date('01')), publicTime: published('01'),
  sourceEvidenceRef: `synthetic-binding-${target.id}`, ...overrides,
});
const ticker = (target: MasterIdentityRef<'listing'>, marketMic = aMic, overrides?: Partial<ExternalIdentifierBinding>) =>
  binding('exchange_ticker', 'SYN1', target, { marketMic, ...overrides });
const listingEvent = (event: ListingLifecycleEvent['event'], effectiveDay: string, publicTime = published('01')): ListingLifecycleEvent => ({
  event, listing: aListing, marketMic: aMic, effectivePeriod: period(date(effectiveDay)), publicTime,
  sourceEvidenceRef: `synthetic-event-${event}`,
});
const bundle = (overrides: Partial<EntitySecurityMasterBundle> = {}): EntitySecurityMasterBundle => ({
  version: ENTITY_SECURITY_MASTER_VERSION, bindings: [], lifecycleEvents: [], continuityRecords: [], ...overrides,
});
const tickerQuery = { scheme: 'exchange_ticker', code: 'SYN1', marketMic: aMic, asOfDate: date('04') } as const;
const replay = (input: unknown, registry = new EntitySecurityMasterRegistry()) =>
  registry.replayCandidate(registry.registerCandidate(input).candidateDigest);

function receiptFor(replayed: ReturnType<typeof replay>, overrides: Partial<Omit<MasterAdoptionReceipt, 'receiptDigest'>> = {}): MasterAdoptionReceipt {
  const unsigned = { receiptId: 'synthetic-receipt', operator: { source: 'trusted-host', operatorId: 'synthetic-operator' } as const,
    candidateDigest: replayed.candidateDigest, replayDigest: replayed.replayDigest, observedAtUtc: time('10'), ...overrides };
  return { ...unsigned, receiptDigest: masterAdoptionReceiptDigest(unsigned) };
}

function adopt(input: EntitySecurityMasterBundle) {
  const hostReceipts = new Map<string, string>();
  const registry = new EntitySecurityMasterRegistry(receipt => hostReceipts.get(receipt.receiptId) === receipt.receiptDigest);
  const replayed = replay(input, registry);
  const receipt = receiptFor(replayed);
  hostReceipts.set(receipt.receiptId, receipt.receiptDigest);
  const snapshot = registry.adoptCandidate(replayed.candidateDigest, replayed.replayDigest, receipt);
  return { registry, snapshot };
}

test('A+H 一个主体、两个证券、两个挂牌分别解析，同字符串按编码体系和 MIC 隔离', () => {
  const bindings = [
    binding('cn_uscc', 'SYN1', issuer), binding('lei', 'SYN-LEI', issuer), binding('csrc_issuer_id', 'SYN-CSRC', issuer),
    binding('isin', 'SYN1', aShare), binding('isin', 'SYN-H-ISIN', hShare), binding('share_class_figi', 'SYN-H-CLASS', hShare),
    binding('composite_figi', 'SYN-A-COMP', aShare), binding('composite_figi', 'SYN-H-COMP', hListing),
    binding('figi', 'SYN-A-FIGI', aListing), ticker(aListing), ticker(hListing, hMic), binding('iso10383_mic', aMic, mainland),
  ];
  const { snapshot } = adopt(bundle({ bindings }));
  for (const expected of bindings) {
    const { scheme, code, marketMic } = expected;
    assert.deepEqual(resolveMasterIdentity({ scheme, code, marketMic, asOfDate: date('04') }, snapshot), {
      status: 'resolved_unique', target: expected.target, bindings: [expected],
    });
  }
  assert.throws(() => resolveMasterIdentity({ ...tickerQuery, marketMic: undefined }, snapshot), { code: 'MASTER_TICKER_MARKET_REQUIRED' });
  assert.throws(() => replay(bundle({ bindings: [ticker(aListing, 'ca01')] })), { code: 'MASTER_TICKER_MARKET_REQUIRED' });
  assert.throws(() => resolveMasterIdentity(tickerQuery, { bindings: [ticker(aListing, 'ca01')] }),
    { code: 'MASTER_TICKER_MARKET_REQUIRED' });
  assert.deepEqual(resolveMasterIdentity({ ...tickerQuery, marketMic: 'ZZ00' }, snapshot), { status: 'not_found_unknown' });
});

test('不同挂牌可在退市后复用同一编码，前闭后开区间与同目标多证据保持明确', () => {
  const reusedListing = makeRef('listing', 'reused-listing');
  const old = ticker(aListing, aMic, { effectivePeriod: period(date('01'), date('04')) });
  const corroboration = { ...old, sourceEvidenceRef: 'synthetic-corroboration', effectivePeriod: period(date('02'), date('03')) };
  const current = ticker(reusedListing, aMic, { effectivePeriod: period(date('04')) });
  const { snapshot } = adopt(bundle({ bindings: [current, corroboration, old], lifecycleEvents: [listingEvent('delisted', '04')] }));
  assert.deepEqual(resolveMasterIdentity({ ...tickerQuery, asOfDate: date('02') }, snapshot), {
    status: 'resolved_unique', target: aListing, bindings: [corroboration, old],
  });
  assert.deepEqual(resolveMasterIdentity(tickerQuery, snapshot), { status: 'resolved_unique', target: reusedListing, bindings: [current] });

  const overlap = { ...current, effectivePeriod: period(date('03')) };
  assert.throws(() => replay(bundle({ bindings: [overlap, corroboration, old] })), { code: 'MASTER_OVERLAPPING_EFFECTIVE_RANGE' });
  assert.deepEqual(resolveMasterIdentity({ ...tickerQuery, asOfDate: date('03') }, { bindings: [old, overlap] }), {
    status: 'ambiguous_conflict', candidates: [old, overlap],
  });
});

test('回放和直接解析均拒绝跨层绑定，姓名或显示名不得参与身份解析和查重', () => {
  for (const invalid of [binding('lei', 'SYN', aListing), binding('lei', 'SYN', aShare), binding('isin', 'SYN', aListing),
    binding('composite_figi', 'SYN', issuer), binding('figi', 'SYN', aShare), binding('iso10383_mic', aMic, issuer),
    binding('exchange_ticker', 'SYN', issuer, { marketMic: aMic })]) {
    assert.throws(() => replay(bundle({ bindings: [invalid] })), { name: 'TaskError', code: 'MASTER_SCHEME_KIND_MISMATCH' });
    const { scheme, code, marketMic } = invalid;
    assert.throws(() => resolveMasterIdentity({ scheme, code, marketMic, asOfDate: date('04') }, { bindings: [invalid] }),
      { code: 'MASTER_SCHEME_KIND_MISMATCH' });
  }
  assert.throws(() => validateMasterIdentityRequest({ ...tickerQuery, scheme: 'toString' }), { code: 'MASTER_IDENTIFIER_INVALID' });
  for (const request of ['合成显示名', { displayName: '合成显示名', asOfDate: date('04') },
    { ...tickerQuery, matchBy: 'name' }, { ...tickerQuery, deduplicateBy: 'name' }]) {
    assert.throws(() => validateMasterIdentityRequest(request), { code: 'MASTER_NAME_ONLY_FORBIDDEN' });
  }
  assert.throws(() => validateMasterIdentityRef({ kind: 'entity', name: '合成显示名' }), { code: 'MASTER_NAME_ONLY_FORBIDDEN' });
  for (const invalid of [{ ...issuer, namespace: 'bad/namespace' }, { ...issuer, id: 'a'.repeat(129) },
    { ...issuer, id: 'issuer\n' }, { ...issuer, kind: 'event' }, { ...issuer, displayName: '合成显示名' }]) {
    assert.throws(() => validateMasterIdentityRef(invalid), { code: 'MASTER_IDENTITY_INVALID' });
  }
});

test('回放严格区分有效自然日和 WFD 公开时间，明确统计未知证据', () => {
  const base = ticker(aListing);
  for (const effectivePeriod of [period('2041-02-29'), period(date('04'), date('04')), period(date('04'), date('03')),
    { status: 'unknown', validFrom: date('04'), validUntilExclusive: null }]) {
    assert.throws(() => replay(bundle({ bindings: [{ ...base, effectivePeriod } as ExternalIdentifierBinding] })),
      { code: 'MASTER_EFFECTIVE_RANGE_INVALID' });
  }
  for (const publicTime of [date('01'), { ...published('01'), earliest_utc: date('01') },
    { ...published('01'), earliest_utc: '2040-02-30T01:00:00Z' }, { ...published('01'), latest_exclusive_utc: time('01') },
    { ...published('01'), earliest_utc: '2040-12-01T01:00:00.000Z' }, { ...unknownTime, precision: 'day' }]) {
    assert.throws(() => replay({ ...bundle(), bindings: [{ ...base, publicTime }] }), { code: 'MASTER_PUBLIC_TIME_INVALID' });
  }
  const unknownPeriod = { status: 'unknown', validFrom: null, validUntilExclusive: null } as const;
  const unresolved = { ...base, publicTime: unknownTime, effectivePeriod: unknownPeriod };
  assert.deepEqual(replay(bundle({ bindings: [{ ...base, effectivePeriod: period('2040-02-29') }, unresolved] })).diagnostics, {
    bindings: 2, lifecycleEvents: 0, continuityRecords: 0, unknownEffectivePeriods: 1, unresolvedPublicTimes: 1,
  });
  assert.deepEqual(resolveMasterIdentity(tickerQuery, { bindings: [unresolved] }), { status: 'indeterminate_temporal_evidence' });
  assert.throws(() => resolveMasterIdentity({ ...tickerQuery, marketKnownAtUtc: date('04') }, { bindings: [base] }),
    { code: 'MASTER_KNOWLEDGE_CUTOFF_INVALID' });
  assert.throws(() => replay(bundle({ bindings: [{ ...base, sourceEvidenceRef: '' }] })), { code: 'MASTER_EVIDENCE_REQUIRED' });
});

test('市场历史排除晚公开的更名与吸收合并证据，保持前驱身份和原绑定不变', () => {
  const initial = binding('lei', 'SYN-ISSUER', issuer, { effectivePeriod: period(date('01'), date('07')) });
  const renamed = { ...initial, sourceEvidenceRef: 'synthetic-name-change', publicTime: published('06'),
    effectivePeriod: period(date('03'), date('07')) };
  const absorbed = binding('lei', initial.code, successor, { sourceEvidenceRef: 'synthetic-absorption',
    publicTime: published('07'), effectivePeriod: period(date('07')) });
  const continuityRecords: EntityContinuityRecord[] = [
    { event: 'legal_name_changed', predecessor: issuer, successors: [issuer], newDisplayName: '合成新名称',
      effectivePeriod: renamed.effectivePeriod, publicTime: renamed.publicTime, sourceEvidenceRef: renamed.sourceEvidenceRef },
    { event: 'merged_absorbed_into', predecessor: issuer, successors: [successor], effectivePeriod: absorbed.effectivePeriod,
      publicTime: absorbed.publicTime, sourceEvidenceRef: absorbed.sourceEvidenceRef },
  ];
  const { snapshot } = adopt(bundle({ bindings: [absorbed, renamed, initial], continuityRecords }));
  const query = { scheme: 'lei', code: initial.code, asOfDate: date('04'), marketKnownAtUtc: time('05') } as const;
  assert.deepEqual(resolveMasterIdentity(query, snapshot), { status: 'resolved_unique', target: issuer, bindings: [initial] });
  assert.deepEqual(resolveMasterIdentity({ ...query, marketKnownAtUtc: time('07') }, snapshot), {
    status: 'resolved_unique', target: issuer, bindings: [renamed, initial],
  });
  assert.deepEqual(resolveMasterIdentity({ ...query, asOfDate: date('08') }, snapshot), { status: 'not_found_unknown' });
  assert.deepEqual(resolveMasterIdentity({ ...query, asOfDate: date('08'), marketKnownAtUtc: time('08') }, snapshot), {
    status: 'resolved_unique', target: successor, bindings: [absorbed],
  });
  // 独立读入的冲突候选也须先排除晚公开记录，再决定是否冲突。
  const retroactive = { ...absorbed, effectivePeriod: initial.effectivePeriod };
  assert.deepEqual(resolveMasterIdentity(query, { bindings: [retroactive, initial] }), {
    status: 'resolved_unique', target: issuer, bindings: [initial],
  });
  assert.equal(resolveMasterIdentity({ ...query, marketKnownAtUtc: time('08') }, { bindings: [retroactive, initial] }).status,
    'ambiguous_conflict');
  assert.deepEqual(snapshot.continuityRecords, continuityRecords);
  assert.throws(() => replay(bundle({ continuityRecords: [{ ...continuityRecords[0], successors: [successor] }] })),
    { code: 'MASTER_CONTINUITY_INVALID' });
  assert.throws(() => replay(bundle({ continuityRecords: [{ ...continuityRecords[1], successors: [issuer] }] })),
    { code: 'MASTER_CONTINUITY_INVALID' });
});

test('未知、不可用或跨过截止点的公开时间保留未决，其他生效区间不干扰', () => {
  const known = ticker(aListing);
  const request = { ...tickerQuery, marketKnownAtUtc: time('04') };
  assert.deepEqual(resolveMasterIdentity(tickerQuery, { bindings: [{ ...known, publicTime: unknownTime }] }),
    { status: 'indeterminate_temporal_evidence' });
  for (const publicTime of [unknownTime, { ...unknownTime, status: 'not_applicable' } as const, dayOnlyTime]) {
    const unresolved = { ...known, publicTime };
    assert.deepEqual(resolveMasterIdentity(request, { bindings: [known, unresolved] }), { status: 'indeterminate_temporal_evidence' });
    const irrelevant = { ...unresolved, effectivePeriod: period(date('05')) };
    assert.deepEqual(resolveMasterIdentity(request, { bindings: [known, irrelevant] }), {
      status: 'resolved_unique', target: aListing, bindings: [known],
    });
  }
  const dated = { ...known, publicTime: dayOnlyTime };
  assert.equal(resolveMasterIdentity({ ...request, marketKnownAtUtc: '2040-12-03T15:59:59.999Z' }, { bindings: [dated] }).status,
    'not_found_unknown');
  assert.equal(resolveMasterIdentity({ ...request, marketKnownAtUtc: dayOnlyTime.latest_exclusive_utc }, { bindings: [dated] }).status,
    'resolved_unique');
});

test('采用仅接受构造时受信核验、关联同一回放的回执，历史快照与原回执不可覆写', () => {
  const hostReceipts = new Map<string, string>();
  let verificationCalls = 0;
  const registry = new EntitySecurityMasterRegistry(receipt => {
    verificationCalls++;
    assert.ok(Object.isFrozen(receipt.operator));
    return hostReceipts.get(receipt.receiptId) === receipt.receiptDigest;
  });
  const initial = bundle({ bindings: [ticker(aListing)] });
  const { candidateDigest } = registry.registerCandidate(initial);
  const invalidDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => registry.adoptCandidate(candidateDigest, invalidDigest, receiptFor({ candidateDigest, replayDigest: invalidDigest,
    diagnostics: { bindings: 0, lifecycleEvents: 0, continuityRecords: 0, unknownEffectivePeriods: 0, unresolvedPublicTimes: 0 } })),
  { code: 'MASTER_ADOPTION_AUTHORITY' });
  assert.equal(Reflect.set(initial.bindings[0]!, 'code', 'CHANGED'), true);
  const result = registry.replayCandidate(candidateDigest);
  const { replayDigest } = result;
  const receipt = receiptFor(result);
  assert.equal(registry.replayCandidate(candidateDigest), result);
  assert.equal(registry.getAdoptedSnapshot(candidateDigest), null);

  const unconfigured = new EntitySecurityMasterRegistry();
  replay(bundle({ bindings: [ticker(aListing)] }), unconfigured);
  assert.throws(() => Reflect.apply(unconfigured.adoptCandidate, unconfigured, [candidateDigest, replayDigest, receipt, () => true]),
    { code: 'MASTER_ADOPTION_AUTHORITY' });
  for (const untrusted of [receiptFor(result, { operator: { ...receipt.operator, source: 'conversation' } }),
    { ...receipt, receiptDigest: invalidDigest }, receiptFor(result, { candidateDigest: invalidDigest }),
    receiptFor(result, { replayDigest: invalidDigest }), { ...receipt, trustedReceiptVerifier: () => true }]) {
    assert.throws(() => registry.adoptCandidate(candidateDigest, replayDigest, untrusted), { code: 'MASTER_ADOPTION_AUTHORITY' });
  }
  assert.equal(verificationCalls, 0);
  assert.throws(() => registry.adoptCandidate(candidateDigest, replayDigest, receipt), { code: 'MASTER_ADOPTION_AUTHORITY' });
  assert.equal(verificationCalls, 1);
  hostReceipts.set(receipt.receiptId, receipt.receiptDigest);
  const snapshot = registry.adoptCandidate(candidateDigest, replayDigest, receipt);
  assert.equal(snapshot, registry.adoptCandidate(candidateDigest, replayDigest, receipt));
  assert.equal(snapshot.bindings[0]?.code, 'SYN1');
  assert.equal(Reflect.set(snapshot.bindings[0]!.target, 'id', 'rewritten'), false);

  const replacementReceipt = receiptFor(result, { receiptId: 'synthetic-replacement' });
  hostReceipts.set(replacementReceipt.receiptId, replacementReceipt.receiptDigest);
  assert.throws(() => registry.adoptCandidate(candidateDigest, replayDigest, replacementReceipt), { code: 'MASTER_ADOPTION_AUTHORITY' });
  const revised = replay(bundle({ bindings: [ticker(aListing), ticker(hListing, hMic)] }), registry);
  const secondReceipt = receiptFor(revised, { receiptId: 'synthetic-receipt-2' });
  hostReceipts.set(secondReceipt.receiptId, secondReceipt.receiptDigest);
  assert.equal(registry.adoptCandidate(revised.candidateDigest, revised.replayDigest, secondReceipt).bindings.length, 2);
  assert.equal(registry.getAdoptedSnapshot(candidateDigest), snapshot);
  assert.equal(snapshot.bindings.length, 1);
  assert.equal(snapshot.confirmationReceipt.receiptId, receipt.receiptId);
});

const calendarRef: AuthoritativeCalendarRef = {
  calendarId: 'synthetic-calendar', exchangeCode: aMic, marketScope: 'synthetic-market', timezone: 'UTC',
  version: 'synthetic-1', effectiveFrom: date('01'), effectiveTo: date('08'), snapshotId: 'synthetic-calendar-snapshot',
  sourceAuthority: 'synthetic-exchange',
};
const calendarContent = { open: ['01', '02', '04', '05', '06', '07', '08'].map(date), closed: [date('03')] };
const calendarManifest = { ...calendarRef, evidenceKind: 'authoritative_calendar_snapshot',
  snapshotContentSha256: wfdSha256(canonicalWfdJson(calendarContent)) };
const calendar = { coverage: 'authoritative_full_calendar', calendarRef, evidence: {
  ...calendarManifest, fileRefId: 'synthetic-calendar-evidence', sha256: wfdSha256(canonicalWfdJson(calendarManifest)),
} };
const trustedCalendars = new Map([[calendarRef.snapshotId, calendar.evidence.sha256]]);
const ipo = listingEvent('ipo_listed', '02');
const coverage = { listing: aListing, marketMic: aMic, asOfDate: date('04'), marketKnownAtUtc: time('10'), calendar, calendarContent };

function coverageFor(lifecycleEvents: readonly ListingLifecycleEvent[] = [ipo]) {
  const { registry, snapshot } = adopt(bundle({ lifecycleEvents }));
  return { registry, snapshot, query: { ...coverage, masterSnapshotDigest: snapshot.candidateDigest } };
}

test('权威日历与有据挂牌、停牌、复牌、退市、再上市形成五态覆盖', () => {
  const { registry, snapshot, query } = coverageFor([listingEvent('relisted', '07'), ipo, listingEvent('trading_suspended', '04'),
    listingEvent('trading_resumed', '05'), listingEvent('delisted', '06'), ...(['ticker_changed', 'short_name_changed', 'board_transferred'] as const)
      .map(event => listingEvent(event, '05'))]);
  for (const [day, state, expected] of [
    ['01', 'pre_listing', 'not_expected_outside_listing_window'],
    ['02', 'active_trading', 'expected_observation'],
    ['03', 'active_trading', 'not_expected_market_closed'],
    ['04', 'suspended', 'not_expected_suspended'],
    ['05', 'active_trading', 'expected_observation'],
    ['06', 'delisted', 'not_expected_outside_listing_window'],
    ['07', 'active_trading', 'expected_observation'],
    ['09', 'active_trading', 'unknown_coverage_expectation'],
  ]) {
    const request = { ...query, asOfDate: date(day) };
    assert.equal(resolveListingLifecycleState(request, snapshot), state);
    assert.equal(evaluateListingCoverageExpectation(request, trustedCalendars, registry), expected);
  }
});

test('覆盖查询按摘要读取受信登记表，伪造、未登记或未采用的停牌快照不能证明缺行', () => {
  const { registry, snapshot, query } = coverageFor();
  const lifecycleEvents = [ipo, listingEvent('trading_suspended', '04')];
  const bareQuery = { ...coverage, snapshot: { lifecycleEvents } };
  assert.equal(evaluateListingCoverageExpectation(bareQuery, trustedCalendars, registry), 'unknown_coverage_expectation');

  const forgedQuery = { ...query, snapshot: { ...snapshot, lifecycleEvents } };
  assert.equal(evaluateListingCoverageExpectation(forgedQuery, trustedCalendars), 'unknown_coverage_expectation');
  assert.equal(evaluateListingCoverageExpectation(forgedQuery, trustedCalendars, registry), 'expected_observation');

  const unadopted = new EntitySecurityMasterRegistry();
  const { candidateDigest: masterSnapshotDigest } = replay(bundle({ lifecycleEvents }), unadopted);
  const unverifiedQuery = { ...query, masterSnapshotDigest };
  assert.equal(evaluateListingCoverageExpectation(unverifiedQuery, trustedCalendars, registry), 'unknown_coverage_expectation');
  assert.equal(evaluateListingCoverageExpectation(unverifiedQuery, trustedCalendars, unadopted), 'unknown_coverage_expectation');
});

test('覆盖查询要求秒级 UTC 截止，晚公开或公开时间未决的停牌保持未知', () => {
  const suspension = listingEvent('trading_suspended', '04', published('05'));
  const { registry, query } = coverageFor([ipo, suspension]);
  assert.equal(evaluateListingCoverageExpectation(query, trustedCalendars, registry), 'not_expected_suspended');
  const { marketKnownAtUtc, ...withoutCutoff } = query;
  assert.equal(evaluateListingCoverageExpectation(withoutCutoff, trustedCalendars, registry), 'unknown_coverage_expectation');
  for (const cutoff of [date('10'), marketKnownAtUtc.replace('Z', '.000Z'), '2040-02-30T01:00:00Z', time('04')]) {
    assert.equal(evaluateListingCoverageExpectation({ ...query, marketKnownAtUtc: cutoff }, trustedCalendars, registry),
      'unknown_coverage_expectation');
  }
  for (const publicTime of [unknownTime, dayOnlyTime]) {
    const { registry, query } = coverageFor([ipo, { ...suspension, publicTime }]);
    assert.equal(evaluateListingCoverageExpectation({ ...query, marketKnownAtUtc: time('04') }, trustedCalendars, registry),
      'unknown_coverage_expectation');
  }
});

test('局部休市、日历摘要不符或缺少挂牌状态证据都保持未知', () => {
  const { registry, query } = coverageFor();
  assert.equal(evaluateListingCoverageExpectation(query, undefined, registry), 'unknown_coverage_expectation');
  for (const overrides of [
    { calendar: { ...calendar, coverage: '2040_partial_holiday_notice_only' } },
    { calendar: { ...calendar, evidence: { ...calendar.evidence, evidenceKind: 'holiday_notice_announcement' } } },
    { calendarContent: { open: calendarContent.open.filter(day => day !== date('04')), closed: [date('03'), date('04')] } },
  ]) {
    assert.equal(evaluateListingCoverageExpectation({ ...query, ...overrides }, trustedCalendars, registry), 'unknown_coverage_expectation');
  }
  const boundedSuspension = { ...listingEvent('trading_suspended', '03'), effectivePeriod: period(date('03'), date('04')) };
  for (const lifecycleEvents of [[], [{ ...ipo, marketMic: hMic }], [listingEvent('ticker_changed', '02')], [ipo, boundedSuspension]]) {
    const { registry, query } = coverageFor(lifecycleEvents);
    assert.equal(evaluateListingCoverageExpectation(query, trustedCalendars, registry), 'unknown_coverage_expectation');
  }
  const empty = coverageFor([]);
  assert.equal(evaluateListingCoverageExpectation({ ...empty.query, asOfDate: date('03') }, trustedCalendars, empty.registry),
    'unknown_coverage_expectation');
  assert.throws(() => replay(bundle({ lifecycleEvents: [ipo, listingEvent('delisted', '02')] })), { code: 'MASTER_LIFECYCLE_CONFLICT' });
});

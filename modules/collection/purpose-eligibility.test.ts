import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { deriveOutputRouting, emptyDimensions } from './processing-routing.js';
import {
  PURPOSE_ELIGIBILITY_RULE_VERSION, assertPurposeEligibility, combinePurposeEligibilityResults,
  evaluatePurposeEligibility, materialPublicationTimeEvidence, purposeClaimsFromDimensionEvidence,
  wfdFixedReadEvidence, wfdRestrictionEvidence,
  type DerivedCalculationEvidence, type PurposeEligibilityInput, type RevisionEvidence,
  type WfdHistorySupportEvidence,
} from './purpose-eligibility.js';

const sha = (value: unknown): string => wfdSha256(canonicalWfdJson(value));
const object = 'a'.repeat(64);
const version = 'r_0123456789abcdef01234567';
const product = {
  product_id: 'p_0123456789abcdef01234567',
  contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at', 'system_held_at'] } },
  declaration: { semantic_context: { version_axis: { revision_mode: 'source_correction' } } },
  definition_ref: { version: 'definition-1', digest: 'sha256:' + 'b'.repeat(64) },
  contract_ref: { digest: 'sha256:' + 'c'.repeat(64) },
};
const snapshot = 's_0123456789abcdef01234567';

function purposeClaim(purpose: PurposeEligibilityInput['purpose'] = 'historical_view', overrides: Record<string, unknown> = {}) {
  return {
    purpose,
    authority: 'operator-http' as const,
    quote: '按当时可知信息回放，不看之后修订',
    observedAtUtc: '2026-04-30T00:00:00Z',
    evidenceSha256: sha({ request: 'r1', field: 'usage' }),
    requestId: 'request-historical-1',
    ...overrides,
  };
}

function wfdRow(input: {
  publicTime?: unknown;
  revisionState?: string;
  eligibility?: { decision: 'eligible' | 'ineligible' | 'indeterminate'; reason: string };
  perspective?: string;
  at?: string | null;
  recordVersion?: string;
  usageGovernance?: unknown;
}) {
  return {
    product_id: product.product_id,
    record_ref: { product_id: product.product_id, snapshot_id: snapshot, logical_key: '2025-annual-report', revision_id: input.recordVersion ?? version },
    revision: { logical_key: '2025-annual-report', revision_id: input.recordVersion ?? version, supersedes: null, withdrawn: false, reason: null },
    revision_state: input.revisionState ?? 'current',
    definition_ref: { version: 'definition-1', digest: 'sha256:' + 'b'.repeat(64) },
    contract_ref: { digest: 'sha256:' + 'c'.repeat(64) },
    row: { business_key: '2025-annual-report', public_time: input.publicTime ?? {
      status: 'known', precision: 'day', earliest_utc: '2026-03-15T00:00:00Z',
      latest_exclusive_utc: '2026-03-16T00:00:00Z', source_timezone: 'Asia/Shanghai' } },
    eligibility: input.eligibility ?? { decision: 'eligible', reason: 'evidence_interval_ended_before_cutoff' },
    ...(input.usageGovernance ? { usage_governance: input.usageGovernance } : {}),
  };
}

function wfdInput(input: {
  row?: ReturnType<typeof wfdRow>;
  purpose?: PurposeEligibilityInput['purpose'];
  mode?: PurposeEligibilityInput['history']['mode'];
  cutoff?: string | null;
  perspective?: string | null;
  readPerspective?: string | null;
  readAt?: string | null;
  recordVersion?: string;
  productOverride?: Record<string, unknown>;
  revisionOverride?: RevisionEvidence | null;
  restriction?: PurposeEligibilityInput['restriction'];
  derived?: DerivedCalculationEvidence | null;
  purposeEvidence?: PurposeEligibilityInput['purposeEvidence'];
} = {}): PurposeEligibilityInput {
  const row = input.row ?? wfdRow({});
  const evidence = wfdFixedReadEvidence({
    objectSha256: object,
    product: input.productOverride ?? product,
    result: { snapshot_id: snapshot,
      perspective: input.readPerspective === undefined ? input.mode ?? 'market_known_at' : input.readPerspective,
      at: input.readAt === undefined ? input.cutoff ?? '2026-04-30T00:00:00Z' : input.readAt },
    row,
    contentBasis: '实际 WFD fixed_read 返回重新核对',
    checkedAtUtc: '2026-04-30T00:00:00Z',
  });
  return {
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
    purpose: input.purpose ?? 'historical_view',
    purposeEvidence: input.purposeEvidence === undefined ? [purposeClaim(input.purpose ?? 'historical_view')] : input.purposeEvidence,
    history: { mode: input.mode === undefined ? 'market_known_at' : input.mode,
      cutoff: input.cutoff === undefined ? '2026-04-30T00:00:00Z' : input.cutoff,
      perspective: input.perspective === undefined ? 'market_known_at' : input.perspective },
    object: { ...evidence.object, recordVersion: input.recordVersion === undefined ? evidence.object.recordVersion : input.recordVersion },
    publicationTime: evidence.publicationTime,
    holdingTime: null,
    revisions: input.revisionOverride === null ? null : [input.revisionOverride ?? { ...evidence.revision,
      stateAtCutoff: 'current' }],
    wfdHistory: evidence.wfdHistory,
    restriction: input.restriction === undefined ? evidence.restriction : input.restriction,
    derived: input.derived ?? null,
    wfdDecision: evidence.wfdDecision,
  };
}

function codes(input: PurposeEligibilityInput): string[] {
  return evaluatePurposeEligibility(input).gaps.filter(gap => gap.blocking).map(gap => gap.code);
}

test('保管、解析与结构检查不依赖公开时间；未知公开时间仍合法', () => {
  for (const purpose of ['custody', 'parse', 'structure_check'] as const) {
    const result = evaluatePurposeEligibility({
      ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION, purpose, purposeEvidence: null,
      history: { mode: null, cutoff: null, perspective: null },
      object: { objectSha256: object, origin: 'managed_original', productId: null, snapshotId: null,
        recordVersion: object, definitionRevision: null, contentVerified: true, contentBasis: '原件字节重新读取并核对摘要' },
      publicationTime: materialPublicationTimeEvidence({ objectSha256: object, recordVersion: object,
        earliestUtc: null, latestExclusiveUtc: null, precision: null, sourceTimezone: null,
        basis: '文件无公开时间列', evidenceSha256: sha({ material: object }) }),
      holdingTime: null, revisions: null, wfdHistory: null,
      restriction: null, derived: null, wfdDecision: null,
    });
    assert.equal(result.status, 'eligible', `${purpose}: ${JSON.stringify(result.gaps)}`);
    assert.equal(result.historyUse, null);
  }
});

test('当前内容计算允许公开时间未知，但实际暂停证据不得绕过', () => {
  const base = wfdInput({ purpose: 'current_compute', mode: null, cutoff: null, perspective: null,
    purposeEvidence: null, restriction: null });
  const eligible = evaluatePurposeEligibility(base);
  assert.equal(eligible.status, 'eligible', JSON.stringify(eligible.gaps));
  assert.ok(eligible.gaps.some(gap => gap.code === 'RESTRICTION_NOT_CHECKED' && !gap.blocking));

  const restrictedInput = { ...base,
    restriction: { authority: 'wfd_usage_governance' as const, publishable: false, computeEligible: false,
      auditReproduction: false, checkedAtUtc: '2026-04-30T00:00:00Z', issueCodes: ['CASE-1'],
      evidenceSha256: sha({ governance: 'restricted' }) } };
  const restricted = evaluatePurposeEligibility(restrictedInput);
  assert.equal(restricted.status, 'ineligible');
  assert.ok(codes(restrictedInput).includes('USAGE_RESTRICTED'));
});

test('发布用途需要真实用途证据与实际限制证据，审计复现不能重标为发布', () => {
  const base = wfdInput({ purpose: 'current_publish', mode: null, cutoff: null, perspective: null });
  const missingPurpose = evaluatePurposeEligibility({ ...base, purposeEvidence: null });
  assert.equal(missingPurpose.status, 'insufficient_evidence');
  assert.ok(codes({ ...base, purposeEvidence: null }).includes('PURPOSE_EVIDENCE_REQUIRED'));

  const modelEvidence = evaluatePurposeEligibility({ ...base,
    purposeEvidence: [{ ...purposeClaim('current_publish'), authority: 'model-proposal' } as any] });
  assert.equal(modelEvidence.status, 'insufficient_evidence');
  assert.ok(codes({ ...base, purposeEvidence: [{ ...purposeClaim('current_publish'), authority: 'model-proposal' } as any] })
    .includes('PURPOSE_EVIDENCE_UNTRUSTED'));

  const noRestriction = evaluatePurposeEligibility({ ...base, restriction: null,
    purposeEvidence: [purposeClaim('current_publish')], boundary: 'prepare' });
  assert.equal(noRestriction.status, 'insufficient_evidence', JSON.stringify(noRestriction.gaps));
  assert.ok(noRestriction.gaps.some(gap => gap.code === 'RESTRICTION_EVIDENCE_REQUIRED' && gap.blocking));
  const candidateOnly = evaluatePurposeEligibility({ ...base, restriction: null,
    purposeEvidence: [purposeClaim('current_publish')], boundary: 'candidate' });
  assert.equal(candidateOnly.status, 'eligible', JSON.stringify(candidateOnly.gaps));

  const audit = evaluatePurposeEligibility({ ...base, purposeEvidence: [purposeClaim('current_publish')],
    restriction: { authority: 'wfd_usage_governance', publishable: false, computeEligible: false,
      auditReproduction: true, checkedAtUtc: '2026-04-30T00:00:00Z', issueCodes: ['CASE-1'],
      evidenceSha256: sha({ governance: 'audit' }) } });
  assert.equal(audit.status, 'ineligible');
});

test('3月原报/5月修订：4月历史用途只接受3月版本，5月修订明确拒绝', () => {
  const march = wfdInput({ row: wfdRow({}), cutoff: '2026-04-30T00:00:00Z' });
  const accepted = evaluatePurposeEligibility(march);
  assert.equal(accepted.status, 'eligible', JSON.stringify(accepted.gaps));
  assert.equal(accepted.historyUse, 'known_at_cutoff');
  assert.ok(accepted.checks.some(check => check.id === 'revision_selection' && check.status === 'pass'));

  const mayRow = wfdRow({
    publicTime: { status: 'known', precision: 'day', earliest_utc: '2026-05-20T00:00:00Z',
      latest_exclusive_utc: '2026-05-21T00:00:00Z', source_timezone: 'Asia/Shanghai' },
    revisionState: 'superseded',
    recordVersion: 'r_fedcba9876543210fedcba98',
    eligibility: { decision: 'ineligible', reason: 'time_interval_starts_after_cutoff' },
  });
  const mayEvidence = wfdFixedReadEvidence({ objectSha256: object, product,
    result: { snapshot_id: snapshot, perspective: 'market_known_at', at: '2026-04-30T00:00:00Z' },
    row: mayRow, contentBasis: '实际 WFD fixed_read 返回重新核对', checkedAtUtc: '2026-04-30T00:00:00Z' });
  const refused = evaluatePurposeEligibility({
    ...march,
    object: { ...mayEvidence.object, recordVersion: 'r_fedcba9876543210fedcba98' },
    publicationTime: mayEvidence.publicationTime,
    revisions: [{ ...mayEvidence.revision, stateAtCutoff: 'superseded' }],
    wfdDecision: mayEvidence.wfdDecision,
  });
  assert.equal(refused.status, 'ineligible');
  assert.ok(refused.gaps.some(gap => gap.code === 'WFD_ROW_INELIGIBLE' && gap.blocking));
  assert.ok(refused.gaps.some(gap => gap.code === 'PUBLICATION_AFTER_CUTOFF' && gap.blocking));
  assert.ok(refused.gaps.some(gap => gap.code === 'REVISION_NOT_CURRENT_AT_CUTOFF' && gap.blocking));
});

test('固定快照内容不等于历史可知资格；快照内容历史请求明确拒绝', () => {
  const result = evaluatePurposeEligibility(wfdInput({ mode: 'snapshot_contents', cutoff: null, perspective: 'snapshot_contents' }));
  assert.equal(result.status, 'ineligible');
  assert.ok(result.gaps.some(gap => gap.code === 'SNAPSHOT_CONTENTS_NOT_HISTORICAL' && gap.blocking));
});

test('历史截止缺失、公开时间未知、当前-only 产品均不得放行', () => {
  const noCutoff = evaluatePurposeEligibility(wfdInput({ cutoff: null }));
  assert.equal(noCutoff.status, 'insufficient_evidence');
  assert.ok(noCutoff.gaps.some(gap => gap.code === 'HISTORY_CUTOFF_REQUIRED'));

  const unknownTime = evaluatePurposeEligibility(wfdInput({
    row: wfdRow({ publicTime: { status: 'unknown' },
      eligibility: { decision: 'indeterminate', reason: 'PUBLICATION_OR_HELD_TIME_UNKNOWN' } }) }));
  assert.equal(unknownTime.status, 'insufficient_evidence');
  assert.ok(unknownTime.gaps.some(gap => gap.code === 'PUBLIC_TIME_UNKNOWN'));
  assert.ok(unknownTime.gaps.some(gap => gap.code === 'WFD_ROW_INDETERMINATE'));

  const currentOnly = { ...product, declaration: { semantic_context: { version_axis: { revision_mode: 'current_only_business' } } },
    contracts: { read: { perspectives: ['snapshot_contents'] } } };
  const refused = evaluatePurposeEligibility(wfdInput({ productOverride: currentOnly }));
  assert.equal(refused.status, 'ineligible');
  assert.ok(refused.gaps.some(gap => gap.code === 'CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED' && gap.blocking));
});

test('实际读取视角/截止与请求不一致属于证据不足，不静默采用', () => {
  const result = evaluatePurposeEligibility(wfdInput({
    mode: 'market_known_at', cutoff: '2026-04-30T00:00:00Z',
    readPerspective: 'snapshot_contents', readAt: '2026-05-31T00:00:00Z',
  }));
  assert.equal(result.status, 'insufficient_evidence');
  assert.ok(result.gaps.some(gap => gap.code === 'WFD_HISTORY_EVIDENCE_MISMATCH'));
});

test('修订状态：superseded/withdrawn 拒绝，unknown/缺证据证据不足', () => {
  const superseded = evaluatePurposeEligibility(wfdInput({ revisionOverride: {
    authority: 'wfd_product_read', recordVersion: version, stateAtCutoff: 'superseded',
    supersedes: version, supersededBy: 'r_new', selectionBasis: 'today latest', evidenceSha256: sha({ revision: 'superseded' }) } }));
  assert.equal(superseded.status, 'ineligible');
  assert.ok(superseded.gaps.some(gap => gap.code === 'REVISION_NOT_CURRENT_AT_CUTOFF'));

  const withdrawn = evaluatePurposeEligibility(wfdInput({ revisionOverride: {
    authority: 'wfd_product_read', recordVersion: version, stateAtCutoff: 'withdrawn',
    supersedes: null, supersededBy: null, selectionBasis: 'withdrawn', evidenceSha256: sha({ revision: 'withdrawn' }) } }));
  assert.equal(withdrawn.status, 'ineligible');
  assert.ok(withdrawn.gaps.some(gap => gap.code === 'REVISION_WITHDRAWN'));

  const unknown = evaluatePurposeEligibility(wfdInput({ revisionOverride: {
    authority: 'wfd_product_read', recordVersion: version, stateAtCutoff: 'unknown',
    supersedes: null, supersededBy: null, selectionBasis: 'unknown', evidenceSha256: sha({ revision: 'unknown' }) } }));
  assert.equal(unknown.status, 'insufficient_evidence');

  const missing = evaluatePurposeEligibility(wfdInput({ revisionOverride: null }));
  assert.equal(missing.status, 'insufficient_evidence');
  assert.ok(missing.gaps.some(gap => gap.code === 'REVISION_EVIDENCE_REQUIRED'));
});

test('system_held_at：未知持有时间/范围拒绝历史资格，实际台账在截止前才放行', () => {
  const base = wfdInput({ mode: 'system_held_at', cutoff: '2026-04-30T00:00:00Z', perspective: 'system_held_at' });
  const unknown = evaluatePurposeEligibility({ ...base, holdingTime: null });
  assert.equal(unknown.status, 'insufficient_evidence');
  assert.ok(unknown.gaps.some(gap => gap.code === 'HOLDING_TIME_EVIDENCE_REQUIRED'));

  const known = evaluatePurposeEligibility({ ...base, holdingTime: {
    authority: 'wfd_holding_ledger', status: 'known', objectSha256: object, recordVersion: version,
    receivedAtUtc: '2026-03-20T00:00:00Z', heldScope: 'received_structured', usableStage: 'published_readable',
    basis: '实例持有台账', evidenceSha256: sha({ holding: version }) } });
  assert.equal(known.status, 'eligible', JSON.stringify(known.gaps));
});

test('派生窗口：任一输入晚于截止即拒绝；截止后重算保留实际计算时间并标为回放', () => {
  const derivedBase: DerivedCalculationEvidence = {
    methodVersion: 'ma/full-window-v1', businessTime: '2026-03-31',
    inputs: [
      { ref: 'input-a', latestAvailableAtUtc: '2026-03-01T00:00:00Z', basis: 'wfd.public_time', evidenceSha256: sha({ a: 1 }) },
      { ref: 'input-b', latestAvailableAtUtc: '2026-03-02T00:00:00Z', basis: 'wfd.public_time', evidenceSha256: sha({ b: 1 }) },
    ],
    computedAtUtc: '2026-04-29T00:00:00Z', computedAtBasis: '实际任务完成时间', publishedAtUtc: null, usableAtUtc: null,
    resultObjectSha256: object,
  };
  const base = wfdInput({ purpose: 'historical_compute', derived: derivedBase });
  const early = evaluatePurposeEligibility(base);
  assert.equal(early.status, 'eligible', JSON.stringify(early.gaps));
  assert.equal(early.timings?.latestInputAvailableAtUtc, '2026-03-02T00:00:00Z');
  assert.equal(early.timings?.computedAtUtc, '2026-04-29T00:00:00Z');
  assert.equal(early.timings?.existedAtCutoff, true);

  const replay = evaluatePurposeEligibility({ ...base, derived: { ...derivedBase, computedAtUtc: '2026-06-01T00:00:00Z' } });
  assert.equal(replay.status, 'eligible', JSON.stringify(replay.gaps));
  assert.equal(replay.timings?.existedAtCutoff, false);
  assert.equal(replay.historyUse, 'replay');
  assert.ok(replay.gaps.some(gap => gap.code === 'REPLAY_COMPUTED_AFTER_CUTOFF' && !gap.blocking));

  const late = evaluatePurposeEligibility({ ...base, derived: { ...derivedBase,
    inputs: [derivedBase.inputs[0]!, { ...derivedBase.inputs[1]!, latestAvailableAtUtc: '2026-05-02T00:00:00Z' }] } });
  assert.equal(late.status, 'ineligible');
  assert.ok(codes({ ...base, derived: { ...derivedBase,
    inputs: [derivedBase.inputs[0]!, { ...derivedBase.inputs[1]!, latestAvailableAtUtc: '2026-05-02T00:00:00Z' }] } })
    .includes('DERIVED_INPUT_AFTER_CUTOFF'));
});

test('同一实际证据从共用判定得到同一结果与摘要；证据变化改变摘要', () => {
  const input = wfdInput({ restriction: wfdRestrictionEvidence({ snapshot_id: snapshot, perspective: 'snapshot_contents', at: null },
    { checkedAtUtc: '2026-04-30T00:00:00Z' }), purpose: 'current_compute', mode: null, cutoff: null, perspective: null });
  const first = evaluatePurposeEligibility(input);
  const second = evaluatePurposeEligibility(structuredClone(input));
  assert.equal(first.status, second.status);
  assert.deepEqual(first.gaps, second.gaps);
  assert.equal(first.evidenceSha256, second.evidenceSha256);
  const changed = evaluatePurposeEligibility({ ...input, object: { ...input.object, objectSha256: 'd'.repeat(64) } });
  assert.notEqual(first.evidenceSha256, changed.evidenceSha256);
});

test('断言入口对不合格/证据不足给出稳定错误码与完整判决', () => {
  const refused = wfdInput({ mode: 'snapshot_contents', cutoff: null, perspective: 'snapshot_contents' });
  assert.throws(() => assertPurposeEligibility(refused), (error: any) => {
    assert.equal(error.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE');
    const payload = JSON.parse(error.message);
    assert.equal(payload.status, 'ineligible');
    assert.ok(payload.gaps.some((gap: any) => gap.code === 'SNAPSHOT_CONTENTS_NOT_HISTORICAL'));
    return true;
  });
  const insufficient = wfdInput({ cutoff: null });
  assert.throws(() => assertPurposeEligibility(insufficient), (error: any) => {
    assert.equal(error.code, 'PURPOSE_ELIGIBILITY_INSUFFICIENT');
    return true;
  });
});


test('六维用途证据适配只保留真实操作者/用户消息，模型建议不进入', () => {
  const claims = purposeClaimsFromDimensionEvidence([
    { source: 'operator-http', quote: '本机操作者要求发布', purpose: 'current_publish', requestId: 'request-1', observedAt: 1_777_000_000_000 },
    { source: 'user-message', quote: '请按当前口径发布', purpose: 'current_publish', messageId: 'message-1', observedAt: 1_777_000_000_000 },
    { source: 'operator-http', quote: '任意原话但无结构化用途', requestId: 'request-2', observedAt: 1_777_000_000_000 },
    { source: 'model-proposal', quote: '模型建议发布', purpose: 'current_publish' },
    { source: 'material', quote: '材料自述用途', purpose: 'current_publish' },
  ]);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map(claim => claim.authority), ['operator-http', 'user-message']);
  assert.ok(claims.every(claim => claim.purpose === 'current_publish' && claim.evidenceSha256.length === 64));
});

test('多行汇总：任一不合格即不合格，任一证据不足即证据不足，不丢缺口', () => {
  const eligible = evaluatePurposeEligibility(wfdInput({ purpose: 'current_compute', mode: null, cutoff: null, perspective: null,
    purposeEvidence: null, restriction: null }));
  const ineligible = evaluatePurposeEligibility(wfdInput({ mode: 'snapshot_contents', cutoff: null, perspective: 'snapshot_contents' }));
  const insufficient = evaluatePurposeEligibility(wfdInput({ cutoff: null }));
  assert.equal(combinePurposeEligibilityResults([eligible]).status, 'eligible');
  assert.equal(combinePurposeEligibilityResults([eligible, insufficient]).status, 'insufficient_evidence');
  assert.equal(combinePurposeEligibilityResults([eligible, ineligible, insufficient]).status, 'ineligible');
  const combined = combinePurposeEligibilityResults([eligible, ineligible]);
  assert.ok(combined.gaps.some(gap => gap.code === 'SNAPSHOT_CONTENTS_NOT_HISTORICAL' && gap.blocking));
});

test('实际 WFD 治理证据映射：有 usage_governance 时保留 publishable/compute_eligible，无时明确无已知事项', () => {
  const restricted = wfdRestrictionEvidence({ snapshot_id: snapshot,
    usage_governance: { publishable: false, compute_eligible: false, audit_reproduction: false,
      known_issues: [{ issue_id: 'CASE-1', reason: 'suspension' }] } }, { checkedAtUtc: '2026-04-30T00:00:00Z' });
  assert.equal(restricted.authority, 'wfd_usage_governance');
  if (restricted.authority === 'wfd_usage_governance') {
    assert.equal(restricted.publishable, false);
    assert.equal(restricted.computeEligible, false);
    assert.deepEqual(restricted.issueCodes, ['CASE-1']);
  }
  const none = wfdRestrictionEvidence({ snapshot_id: snapshot }, { checkedAtUtc: '2026-04-30T00:00:00Z' });
  assert.equal(none.authority, 'wfd_usage_governance_check');
  if (none.authority === 'wfd_usage_governance_check') assert.equal(none.result, 'no_known_issue');
});


test('实际计算/发布暂停证据不阻断保管、解析与结构检查', () => {
  const suspended = { authority: 'wfd_usage_governance' as const, publishable: false, computeEligible: false,
    auditReproduction: false, checkedAtUtc: '2026-04-30T00:00:00Z', issueCodes: ['CASE-1'],
    evidenceSha256: sha({ governance: 'suspended' }) };
  for (const purpose of ['custody', 'parse', 'structure_check'] as const) {
    const result = evaluatePurposeEligibility({
      ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION, purpose, purposeEvidence: null,
      history: { mode: null, cutoff: null, perspective: null },
      object: { objectSha256: object, origin: 'managed_original', productId: null, snapshotId: null,
        recordVersion: object, definitionRevision: null, contentVerified: true, contentBasis: '原件字节核对' },
      publicationTime: materialPublicationTimeEvidence({ objectSha256: object, recordVersion: object,
        earliestUtc: null, latestExclusiveUtc: null, precision: null, sourceTimezone: null,
        basis: '无公开时间', evidenceSha256: sha({ material: object }) }),
      holdingTime: null, revisions: null, wfdHistory: null, restriction: suspended, derived: null, wfdDecision: null,
    });
    assert.equal(result.status, 'eligible', `${purpose}: ${JSON.stringify(result.gaps)}`);
    assert.equal(result.checks.find(check => check.id === 'restriction')?.status, 'not_required');
  }
});


test('U01：共用用途判决非eligible时输出路由不得continue为ready_candidate', () => {
  const dimensions = emptyDimensions().map(item => ({ ...item, status: 'known' as const, value: 'explicit', evidence: [] }));
  const decision = deriveOutputRouting({
    material: { materialId: 'material-1', filename: 'source.csv', sha256: object, byteLength: 1, mediaType: 'text/csv',
      format: 'csv', support: 'supported', adapter: { id: 'utf8-csv', version: '1' }, custodyState: 'received' },
    dimensions, target: { present: true, kind: 'declaration', expectedSnapshotId: null },
    rejected: false, outputId: 'out-1', outputState: 'structured', intendedAction: 'publish',
    processingGaps: [], adapterGaps: [],
    usage: { status: 'ineligible', gaps: ['用途资格: DECLARED_BAR_CLOSE_NOT_PUBLIC_EVIDENCE: 声明收盘时间不是公开证据'],
      checkedScope: ['publication_time'], evidenceSha256: sha({ usage: 'ineligible' }), historyUse: null },
  });
  assert.equal(decision.routingState, 'needs_review');
  assert.ok(decision.gaps.some(gap => gap.includes('DECLARED_BAR_CLOSE_NOT_PUBLIC_EVIDENCE')));
});


test('WFD 拒绝粒度分开：仅 publish 受限不误伤计算，仅 compute 受限不误伤发布', () => {
  const base = wfdInput({ purpose: 'current_compute', mode: null, cutoff: null, perspective: null,
    purposeEvidence: null });
  const publishOnly = { authority: 'wfd_usage_governance' as const, publishable: false, computeEligible: true,
    auditReproduction: false, checkedAtUtc: '2026-04-30T00:00:00Z', issueCodes: ['CASE-PUBLISH'],
    evidenceSha256: sha({ governance: 'publish-only' }) };
  const computeOnly = { authority: 'wfd_usage_governance' as const, publishable: true, computeEligible: false,
    auditReproduction: false, checkedAtUtc: '2026-04-30T00:00:00Z', issueCodes: ['CASE-COMPUTE'],
    evidenceSha256: sha({ governance: 'compute-only' }) };
  const computeAllowed = evaluatePurposeEligibility({ ...base, restriction: publishOnly });
  assert.equal(computeAllowed.status, 'eligible', JSON.stringify(computeAllowed.gaps));
  const publishBlocked = evaluatePurposeEligibility({ ...base, purpose: 'current_publish',
    purposeEvidence: [purposeClaim('current_publish')], boundary: 'prepare', restriction: publishOnly });
  assert.equal(publishBlocked.status, 'ineligible');
  const publishAllowed = evaluatePurposeEligibility({ ...base, purpose: 'current_publish',
    purposeEvidence: [purposeClaim('current_publish')], boundary: 'prepare', restriction: computeOnly });
  assert.equal(publishAllowed.status, 'eligible', JSON.stringify(publishAllowed.gaps));
  const computeBlocked = evaluatePurposeEligibility({ ...base, restriction: computeOnly });
  assert.equal(computeBlocked.status, 'ineligible');
});

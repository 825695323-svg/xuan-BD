import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import {
  assertBoundG5AdmissionReceipt, evaluatePublicationSetG5Admission, evaluateR1G5Admission, G5_ADMISSION_RECEIPT_VERSION, verifyG5AdmissionReceiptDigest,
  type R1G5AdmissionRequest,
} from './g5-admission-receipt.js';
import { readSourceFieldProfile, sourceFieldProfileDigest, type SourceDomainScope } from './source-field-profile.js';

function syntheticProfile(sourceId: string, domainScope: SourceDomainScope = { domain: 'market_series' }) {
  const market = domainScope.domain === 'market_series';
  return readSourceFieldProfile({
    version: 'bd.source-field-profile/1', profileId: sourceId + '-profile', sourceId, series: 'synthetic-series',
    fields: [{ originalHeader: 'Synthetic ID', fieldCode: 'object_id', dataType: 'text', unitCode: 'not_applicable', role: 'identity' }],
    frequency: market ? 'day' : 'other', domainScope,
    timeBucket: market ? { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 1440, timezone: 'UTC' }
      : { kind: 'not_applicable', timezone: 'UTC' },
    adjustment: { status: market ? 'raw' : 'not_applicable' },
    confirmation: { status: 'operator_confirmed', basis: '本测试合成口径', confirmedAtUtc: '2026-11-21T01:02:03Z' },
  }, 'synthetic.json');
}

const event: SourceDomainScope = { domain: 'event_claim', eventSemantics: {
  contentNature: 'source_claim', occurrencePolicy: 'preserve_distinct_propagation',
  timePrecisionPolicy: 'preserve_unknown_no_midnight_fill',
} };
const relation: SourceDomainScope = { domain: 'relation_claim', taxonomyAuthority: 'synthetic-taxonomy/v1',
  effectivePeriodPolicy: 'explicit_range' };
const base = { sourceId: 'synthetic-a', datasetId: 'synthetic-dataset', outputKey: 'synthetic-output', requestId: 'synthetic-request',
  targetProductId: 'synthetic-product', evaluatedAtUtc: '2026-11-21T02:03:04Z',
  profile: syntheticProfile('synthetic-a'), peerSourceIds: [] };
const other = syntheticProfile('synthetic-b');

test('tabular and source-correction entries distinguish first source, same-source repeat and equivalent peer', () => {
  const entries: R1G5AdmissionRequest[] = [
    { ...base, entryPoint: 'r1_auto' },
    { ...base, entryPoint: 'r1_minute_bulk' },
    { ...base, entryPoint: 'r1_workspace_tabular' },
    { ...base, entryPoint: 'r1_publication_set_member', targetKind: 'tabular' },
    { ...base, entryPoint: 'post_publication_correction', correctionKind: 'source_correction' },
  ];
  for (const entry of entries) {
    const first = evaluateR1G5Admission(entry);
    assert.equal(first.policy, 'cross_source_required');
    assert.equal(first.decision, 'allow_first_source_for_target');
    assert.equal(first.allowed, true);
    const repeat = evaluateR1G5Admission({ ...entry, peerSourceIds: [base.sourceId] });
    assert.equal(repeat.decision, 'allow_same_source_repeat');
    assert.equal(repeat.allowed, true);
    const reuse = evaluateR1G5Admission({ ...entry, peerSourceIds: [other.sourceId, base.sourceId], peerProfiles: [other] });
    assert.equal(reuse.decision, 'allow_reuse_product');
    assert.equal(reuse.allowed, true);
    assert.equal(reuse.peerComparisons[0]?.status, 'candidate_equivalent');
    assert.equal(reuse.peerComparisons[0]?.profileDigest, sourceFieldProfileDigest(other));
  }
});

test('derived and processing repair entries are explicitly exempt', () => {
  const entries = [
    { entryPoint: 'derived_wfd_publisher', exemptionCode: 'deterministic_derived_from_fixed_wfd_snapshot' },
    { entryPoint: 'post_publication_correction', correctionKind: 'processing_repair', exemptionCode: 'same_original_processing_repair' },
  ] as const;
  for (const { exemptionCode, ...entry } of entries) {
    const receipt = evaluateR1G5Admission({ ...base, ...entry, profile: null, peerSourceIds: [other.sourceId] });
    assert.equal(receipt.policy, 'explicitly_exempt');
    assert.equal(receipt.exemptionCode, exemptionCode);
    assert.equal(receipt.decision, 'allow_exempt_entry');
    assert.equal(receipt.allowed, true);
    assert.deepEqual(receipt.peerComparisons, []);
  }
});

test('event workspace and set members preserve distinct propagation with a complete event profile', () => {
  const entries = [
    { entryPoint: 'r1_workspace_event' },
    { entryPoint: 'r1_publication_set_member', targetKind: 'event_records' },
  ] as const;
  for (const entry of entries) {
    const request = { ...base, ...entry, profile: syntheticProfile(base.sourceId, event), peerSourceIds: [other.sourceId] };
    const receipt = evaluateR1G5Admission(request);
    assert.equal(receipt.policy, 'domain_profile_only_no_cross_merge');
    assert.equal(receipt.exemptionCode, 'event_distinct_propagation_preserved');
    assert.equal(receipt.decision, 'allow_domain_profile_only');
    assert.equal(receipt.allowed, true);
    assert.deepEqual(receipt.peerComparisons, []);
    assert.equal(evaluateR1G5Admission({ ...request, peerProfiles: [other], profile: base.profile }).decision, 'block_evidence_required');
    assert.equal(evaluateR1G5Admission({ ...request, peerProfiles: [other], profile: syntheticProfile(base.sourceId, { domain: 'event_claim' }) })
      .decision, 'block_evidence_required');
    assert.equal(evaluateR1G5Admission({ ...request, peerProfiles: [other], profile: null }).decision, 'block_missing_profile');
  }
});

test('exact event IDs require historical peer evidence for both event entries', () => {
  const exact: SourceDomainScope = { ...event, eventSemantics: { ...event.eventSemantics!, occurrencePolicy: 'exact_event_id_only' } };
  const entries = [
    { entryPoint: 'r1_workspace_event' },
    { entryPoint: 'r1_publication_set_member', targetKind: 'event_records' },
  ] as const;
  for (const entry of entries) {
    const request = { ...base, ...entry, profile: syntheticProfile(base.sourceId, exact), peerSourceIds: [other.sourceId] };
    const blocked = evaluateR1G5Admission(request);
    assert.equal(blocked.policy, 'cross_source_required');
    assert.equal(blocked.exemptionCode, null);
    assert.equal(blocked.decision, 'block_peer_profile_unavailable');
    assert.equal(evaluateR1G5Admission({ ...request, peerProfiles: [syntheticProfile(other.sourceId, exact)] })
      .decision, 'allow_reuse_product');
    assert.throws(() => evaluateR1G5Admission({ ...request, peerSourceIds: undefined }), { code: 'G5_ADMISSION_REQUEST' });
  }
});

test('relation workspace and set members require peer evidence for other historical sources', () => {
  const entries = [
    { entryPoint: 'r1_workspace_relation' },
    { entryPoint: 'r1_publication_set_member', targetKind: 'relation_edges' },
  ] as const;
  for (const entry of entries) {
    const request = { ...base, ...entry, profile: syntheticProfile(base.sourceId, relation) };
    for (const peerSourceIds of [[], [base.sourceId]]) {
      const receipt = evaluateR1G5Admission({ ...request, peerSourceIds });
      assert.equal(receipt.policy, 'domain_profile_only_no_cross_merge');
      assert.equal(receipt.decision, 'allow_domain_profile_only');
      assert.equal(receipt.allowed, true);
    }
    assert.equal(evaluateR1G5Admission({ ...request, profile: syntheticProfile(base.sourceId, { domain: 'relation_claim' }) })
      .decision, 'block_evidence_required');
    const crossSource = { ...request, peerSourceIds: [other.sourceId] };
    const missing = evaluateR1G5Admission(crossSource);
    assert.equal(missing.policy, 'cross_source_required');
    assert.equal(missing.decision, 'block_peer_profile_unavailable');
    assert.equal(missing.allowed, false);
    assert.deepEqual(missing.missingPeerSourceIds, [other.sourceId]);
    const peer = syntheticProfile(other.sourceId, relation);
    assert.equal(evaluateR1G5Admission({ ...crossSource, peerProfiles: [peer] }).decision, 'allow_reuse_product');
  }
});

test('missing or invalid profiles fail closed even when another peer is equivalent', () => {
  const request = { ...base, entryPoint: 'r1_workspace_tabular' } as const;
  const absent = evaluateR1G5Admission({ ...request, profile: null });
  assert.equal(absent.decision, 'block_missing_profile');
  assert.equal(absent.allowed, false);
  assert.equal(evaluateR1G5Admission({ ...request, profile: other }).decision, 'block_evidence_required');
  const invalid = { ...other, confirmation: { ...other.confirmation, basis: 'unknown' } };
  for (const peerProfiles of [[], [null], [invalid], [other, other]]) {
    const unavailable = evaluateR1G5Admission({ ...request, peerSourceIds: [other.sourceId], peerProfiles,
      allowNewDefinitionVersion: true });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.decision, 'block_peer_profile_unavailable');
    assert.equal(unavailable.diagnostics[0]?.ruleId, 'G5_PEER_PROFILE_UNAVAILABLE');
  }
  const unavailable = evaluateR1G5Admission({ ...request, peerSourceIds: ['synthetic-c', other.sourceId], peerProfiles: [other] });
  assert.equal(unavailable.decision, 'block_peer_profile_unavailable');
  assert.equal(unavailable.peerComparisons[0]?.status, 'candidate_equivalent');
  assert.deepEqual(unavailable.missingPeerSourceIds, ['synthetic-c']);
});

test('confirmed conflict requires a new definition and unresolved gaps take precedence', () => {
  const peer = { ...other, adjustment: { status: 'qfq', method: 'synthetic-method', basis: 'synthetic-basis' } } as const;
  const request = { ...base, entryPoint: 'r1_auto', peerSourceIds: [other.sourceId], peerProfiles: [peer] } as const;
  const blocked = evaluateR1G5Admission(request);
  assert.equal(blocked.decision, 'block_semantic_conflict');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.diagnostics[0]?.severity, 'error');
  const versioned = evaluateR1G5Admission({ ...request, allowNewDefinitionVersion: true });
  assert.equal(versioned.decision, 'allow_new_definition_version');
  assert.equal(versioned.allowed, true);
  assert.equal(versioned.diagnostics[0]?.severity, 'warning');

  const peerWithGap = { ...peer, adjustment: { status: 'qfq', method: 'synthetic-method' } } as const;
  const unresolved = evaluateR1G5Admission({ ...request, allowNewDefinitionVersion: true, peerProfiles: [peerWithGap] });
  assert.equal(unresolved.peerComparisons[0]?.status, 'different_semantics');
  assert.equal(unresolved.decision, 'block_evidence_required');
  assert.equal(unresolved.allowed, false);
  const selfWithGap = { ...base.profile, adjustment: { status: 'unknown' } } as const;
  const repeat = evaluateR1G5Admission({ ...request, profile: selfWithGap, peerSourceIds: [base.sourceId] });
  assert.equal(repeat.decision, 'block_evidence_required');
  assert.equal(repeat.allowed, false);
});

test('publication set evaluates every member and blocks the set on one conflict', () => {
  const different = { ...other, frequency: 'tick' } as const;
  const members = [
    { ...base, targetKind: 'tabular', peerSourceIds: [other.sourceId], peerProfiles: [different] },
    { ...base, targetKind: 'event_records', profile: syntheticProfile(base.sourceId, event) },
    { ...base, targetKind: 'relation_edges', profile: syntheticProfile(base.sourceId, relation) },
  ] as const;
  const set = evaluatePublicationSetG5Admission(members);
  assert.equal(set.allowed, false);
  assert.deepEqual(set.receipts.map(receipt => receipt.decision),
    ['block_semantic_conflict', 'allow_domain_profile_only', 'allow_domain_profile_only']);
  assert.deepEqual(set.blockingDiagnostics.map(item => [item.memberIndex, item.ruleId]), [[0, 'G5_SEMANTIC_CONFLICT']]);
  assert.equal(evaluatePublicationSetG5Admission(members.slice(1)).allowed, true);
});

test('new product set members compare concurrent sources and bind their own output', () => {
  const first = { ...base, targetKind: 'tabular', outputKey: 'first-output' } as const;
  const second = { ...first, sourceId: other.sourceId, outputKey: 'second-output', profile: other };
  const conflicting = { ...second, profile: { ...other, frequency: 'tick' } } as const;
  const blocked = evaluatePublicationSetG5Admission([first, conflicting]);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.receipts.map(receipt => receipt.decision), ['block_semantic_conflict', 'block_semantic_conflict']);
  assert.deepEqual(blocked.receipts.map(receipt => receipt.peerSourceIds), [[other.sourceId], [first.sourceId]]);

  const allowed = evaluatePublicationSetG5Admission([first, second]);
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.receipts.map(receipt => receipt.decision), ['allow_reuse_product', 'allow_reuse_product']);
  const receipt = allowed.receipts[0]!;
  assert.deepEqual(receipt.binding, { entryPoint: 'r1_publication_set_member', requestId: base.requestId,
    target: { datasetId: base.datasetId, productId: base.targetProductId, outputKey: first.outputKey },
    candidateSource: { sourceId: first.sourceId } });
  assert.throws(() => assertBoundG5AdmissionReceipt(receipt, allowed.receipts[1]!.binding), { code: 'R1_G5_EVIDENCE_MISMATCH' });
  assert.equal(evaluatePublicationSetG5Admission([first, { ...conflicting, datasetId: 'another-dataset' }]).allowed, true);
});

test('receipts are deterministic and verify over the complete canonical body', () => {
  const third = syntheticProfile('synthetic-c');
  const request = { ...base, entryPoint: 'r1_auto', peerSourceIds: [third.sourceId, other.sourceId],
    peerProfiles: [third, other] } as const;
  const receipt = evaluateR1G5Admission(request);
  assert.deepEqual(receipt, evaluateR1G5Admission({
    ...request, peerSourceIds: [other.sourceId, third.sourceId, third.sourceId], peerProfiles: [other, third],
  }));
  assert.equal(receipt.version, G5_ADMISSION_RECEIPT_VERSION);
  assert.equal(receipt.authority, 'bd_trusted_g5_gate');
  assert.equal(receipt.wfdAuthorization, 'not_granted_by_g5');
  assert.equal(receipt.evaluatedAtUtc, base.evaluatedAtUtc);
  assert.equal(verifyG5AdmissionReceiptDigest(JSON.parse(JSON.stringify(receipt))), true);
  assertBoundG5AdmissionReceipt(receipt, receipt.binding);
  const { binding } = receipt;
  for (const different of [{ ...binding, entryPoint: 'r1_workspace_tabular' as const },
    { ...binding, requestId: 'different-request' }, { ...binding, candidateSource: { sourceId: 'different-source' } },
    { ...binding, target: { ...binding.target, datasetId: 'different-dataset' } },
    { ...binding, target: { ...binding.target, productId: 'different-product' } },
    { ...binding, target: { ...binding.target, outputKey: 'different-output' } }]) {
    assert.equal(verifyG5AdmissionReceiptDigest(receipt, different), false);
    assert.throws(() => assertBoundG5AdmissionReceipt(receipt, different), { code: 'R1_G5_EVIDENCE_MISMATCH' });
  }
  assert.equal(verifyG5AdmissionReceiptDigest({ ...receipt, targetProductId: 'other-product' }), false);
  assert.equal(verifyG5AdmissionReceiptDigest({ ...receipt, allowed: false }), false);
  assert.equal(verifyG5AdmissionReceiptDigest({ ...receipt, peerComparisons: [] }), false);
  assert.equal(verifyG5AdmissionReceiptDigest(null), false);
  assert.throws(() => evaluateR1G5Admission({ ...request, evaluatedAtUtc: '2026-11-21' }), { code: 'G5_ADMISSION_REQUEST' });
  assert.throws(() => evaluateR1G5Admission({ ...request, peerSourceIds: [''] }), { code: 'G5_ADMISSION_REQUEST' });
});

test('request identity is mandatory even for a receipt with a recomputed digest', () => {
  const request = { ...base, entryPoint: 'r1_auto' as const };
  const { requestId: _requestId, ...requestWithoutId } = request;
  assert.throws(() => evaluateR1G5Admission(requestWithoutId as unknown as R1G5AdmissionRequest), { code: 'G5_ADMISSION_REQUEST' });
  assert.throws(() => evaluateR1G5Admission({ ...request, requestId: ' ' }), { code: 'G5_ADMISSION_REQUEST' });
  const receipt = evaluateR1G5Admission(request);
  const { requestId: _boundId, ...bindingWithoutId } = receipt.binding;
  const { receiptDigest: _digest, ...body } = receipt;
  const unbound = { ...body, binding: bindingWithoutId };
  assert.equal(verifyG5AdmissionReceiptDigest({ ...unbound, receiptDigest: wfdSha256(canonicalWfdJson(unbound)) }), false);
  assert.throws(() => assertBoundG5AdmissionReceipt(receipt, bindingWithoutId as typeof receipt.binding),
    { code: 'R1_G5_EVIDENCE_MISMATCH' });
  assert.notEqual(evaluateR1G5Admission({ ...request, requestId: 'another-request' }).receiptDigest, receipt.receiptDigest);
});

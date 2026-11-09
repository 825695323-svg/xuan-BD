import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { restrictionEvidenceFromUsageStatus, publishRestrictionTarget } from './wfd-publish-restriction.js';
import { PURPOSE_ELIGIBILITY_RULE_VERSION, evaluatePurposeEligibility } from './purpose-eligibility.js';

const now = Date.parse('2026-11-07T12:00:00Z');
const target = { purpose: 'current_publish' as const, snapshotId: 's_0123456789abcdef01234567',
  productIds: ['p_0123456789abcdef01234567'], recordVersions: ['r_0123456789abcdef01234567'] };
function status(issues: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return { format_version: 'wfd.usage-suspension/1', issues, tickets: [],
    active_issues: issues.filter((issue: any) => issue.state === 'active').length,
    suspended_record_versions: issues.reduce((sum: number, issue: any) => sum + (Array.isArray(issue.scopes)
      ? issue.scopes.reduce((count: number, scope: any) => count + (Array.isArray(scope.record_versions) ? scope.record_versions.length : 0), 0) : 0), 0),
    ...overrides };
}
const issue = (usages = ['publish', 'compute']) => ({ issue_id: 'CASE-1', state: 'active', scopes: [{
  product_id: target.productIds[0], snapshot_id: target.snapshotId, record_versions: target.recordVersions, usages }] });

test('matching restriction maps publish/compute separately', () => {
  const evidence = restrictionEvidenceFromUsageStatus(status([issue(['publish'])]), target, now);
  assert.equal(evidence.authority, 'wfd_usage_governance');
  if (evidence.authority === 'wfd_usage_governance') {
    assert.equal(evidence.publishable, false);
    assert.equal(evidence.computeEligible, true);
    assert.deepEqual(evidence.issueCodes, ['CASE-1']);
    assert.equal(evidence.scope?.purpose, 'current_publish');
  }
  const both = restrictionEvidenceFromUsageStatus(status([issue()]), target, now);
  if (both.authority === 'wfd_usage_governance') {
    assert.equal(both.publishable, false); assert.equal(both.computeEligible, false);
  }
});

test('scope mismatch stays no_known_issue, not a blanket no-limit claim', () => {
  const other = issue(); (other.scopes[0] as any).product_id = 'p_ffffffffffffffffffffffff';
  const evidence = restrictionEvidenceFromUsageStatus(status([other]), target, now);
  assert.equal(evidence.authority, 'wfd_usage_governance_check');
  if (evidence.authority === 'wfd_usage_governance_check') {
    assert.equal(evidence.result, 'no_known_issue');
    assert.deepEqual(evidence.scope?.productIds, target.productIds);
  }
  const versionMismatch = issue(); (versionMismatch.scopes[0] as any).record_versions = ['r_ffffffffffffffffffffffff'];
  const versionEvidence = restrictionEvidenceFromUsageStatus(status([versionMismatch]), target, now);
  assert.equal(versionEvidence.authority, 'wfd_usage_governance_check');
});

test('incomplete/partial usage_status is rejected, never interpreted as no_known_issue', () => {
  assert.throws(() => restrictionEvidenceFromUsageStatus({ format_version: 'wfd.usage-suspension/1', issues: [] }, target, now),
    { code: 'R1_USAGE_STATUS_INCOMPLETE' });
  assert.throws(() => restrictionEvidenceFromUsageStatus({ ...status([issue()]), active_issues: 0 }, target, now),
    { code: 'R1_USAGE_STATUS_INCOMPLETE' });
  assert.throws(() => restrictionEvidenceFromUsageStatus({ ...status([issue()]), suspended_record_versions: 0 }, target, now),
    { code: 'R1_USAGE_STATUS_INCOMPLETE' });
});

test('evidence expiry blocks at publish boundary and candidate scope remains separate', () => {
  const evidence = restrictionEvidenceFromUsageStatus(status(), target, now);
  assert.equal(evidence.authority, 'wfd_usage_governance_check');
  const base = { ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION, purpose: 'current_publish' as const,
    purposeEvidence: [{ purpose: 'current_publish' as const, authority: 'operator-http' as const,
      quote: 'structured action: intendedAction=publish', observedAtUtc: '2026-11-07T11:59:00Z',
      evidenceSha256: wfdSha256(canonicalWfdJson({ request: 'publish' })), requestId: 'request-1' }],
    history: { mode: null, cutoff: null, perspective: null },
    object: { objectSha256: 'a'.repeat(64), origin: 'managed_original' as const, productId: target.productIds[0],
      snapshotId: target.snapshotId, recordVersion: null, definitionRevision: null, contentVerified: true,
      contentBasis: 'test bytes' },
    publicationTime: null, holdingTime: null, revisions: null, wfdHistory: null,
    restriction: evidence, derived: null, wfdDecision: null, boundary: 'first_send' as const };
  const fresh = evaluatePurposeEligibility({ ...base, nowUtc: '2026-11-07T12:01:00Z' });
  assert.equal(fresh.status, 'eligible', JSON.stringify(fresh.gaps));
  const expired = evaluatePurposeEligibility({ ...base, nowUtc: '2026-11-07T12:07:00Z' });
  assert.equal(expired.status, 'insufficient_evidence');
  assert.ok(expired.gaps.some(gap => gap.code === 'RESTRICTION_EVIDENCE_EXPIRED' && gap.blocking));
  const candidate = evaluatePurposeEligibility({ ...base, boundary: 'candidate', nowUtc: '2026-11-07T12:07:00Z' });
  assert.equal(candidate.status, 'insufficient_evidence', 'expiry still blocks if evidence is expired');
});

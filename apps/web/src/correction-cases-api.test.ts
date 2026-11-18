import assert from 'node:assert/strict';
import test from 'node:test';
import { correctionDetail, correctionSummary } from './correction-cases-api.js';
const raw = () => ({ caseId: 'case-1', kind: 'processing_repair', state: 'authorization_pending', coverage: 'proven_subset_only',
  itemCount: 1, items: [{ productId: 'product', snapshotId: 'snapshot', businessKey: 'row', recordVersion: 'revision', state: 'suspended', verification: { raw: 'private-value' } }],
  authorizationTaskId: 'task-1', repairTaskId: 'task-1', impactSha256: 'a'.repeat(64), frozenSha256: 'b'.repeat(64),
  suspension: { state: 'active', credential: 'private-value' }, gaps: ['no_proven_impact', 'path:/private/value?token=private-value'],
  evidence: 'private-value', result: { payload: 'private-value' } });
test('correction view projects only explicit identifiers and states, never raw evidence or diagnostic suffixes', () => {
  const summary = correctionSummary(raw()), detail = correctionDetail(raw());
  assert.deepEqual(summary.taskIds, ['task-1']);
  assert.equal(detail.suspension, 'active');
  assert.deepEqual(detail.gaps, ['no_proven_impact', 'additional_gap_details_withheld']);
  assert.equal(detail.gapCount, 2);
  assert.doesNotMatch(JSON.stringify({ summary, detail }), /private-value|token=|credential|verification|payload|evidence/u);
  assert.equal(detail.state, 'authorization_pending');
});
test('correction projections reject unknown contracts, mismatched membership and malformed identities', () => {
  for (const patch of [{ coverage: 'complete' }, { state: 'published' }, { caseId: '../bad?token=x' }, { itemCount: -1 },
    { authorizationTaskId: { id: 'task' } }, { gaps: [null] }]) assert.throws(() => correctionSummary({ ...raw(), ...patch }));
  for (const patch of [{ itemCount: 2 }, { impactSha256: 'bad' }, { items: [{}] }]) assert.throws(() => correctionDetail({ ...raw(), ...patch }));
  const missing = raw(); missing.suspension = null as never;
  assert.equal(correctionDetail(missing).suspension, 'unknown');
});

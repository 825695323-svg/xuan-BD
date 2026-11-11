import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { R1HandoffService, buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import { macroYoYAlgorithmDefinition, polarsFixedVersionBinding } from '../collection/data-processing/polars-fixed.js';
import { checkUnifiedStructuredForWfd } from './unified-polars-derived.js';
import type { UnifiedPolarsResult } from './unified-polars-execution.js';

const version = 'bd.algorithms.polars/1' as const;
function fixture() {
  const database = new CoreDatabase();
  const output = { business_key: 'macro_yoy_v1', start_utc: '2026-01-01T00:00:00Z',
    end_utc: '2026-02-01T00:00:00Z', value: '20.00000000', value_state: 'valid_value',
    region: 'CN', unit: 'percent' };
  const def = macroYoYAlgorithmDefinition();
  const result: UnifiedPolarsResult = { version, taskId: 'task-algo-one', methodId: 'macro_yoy',
    methodVersion: 'bd.macro-yoy/1',
    implementationVersion: polarsFixedVersionBinding().polarsWorker, source: { kind: 'fixed_snapshot' },
    calculation: { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
      knowledgeCutoff: '2026-02-15T00:00:00Z', inputs: [
        { snapshotId: 's_current', productId: 'p_macro', businessKey: 'current', recordVersion: 'r_2026' },
        { snapshotId: 's_previous', productId: 'p_macro', businessKey: 'previous', recordVersion: 'r_2025' },
      ] },
    inputDigest: 'a'.repeat(64), candidateSha256: wfdSha256(canonicalWfdJson([output])),
    evidence: { workerSha256: polarsFixedVersionBinding().polarsWorker, algorithmDefinition: def },
    algorithmDefinition: def, rows: [output], computedAt: '2026-02-16T00:00:00.000Z', publication: 'candidate_only' };
  const checked = checkUnifiedStructuredForWfd(result, {
    namespace: 'fixture', mode: 'user_test', expectedParentSnapshotId: null,
  }, 'bd-derived:fixture');
  let attempts = 0, sent = 0;
  const handoff = new R1HandoffService({
    database,
    verifyFixedDerived(refs, documentSha256) {
      attempts++;
      const ref = refs.fixedAlgorithm;
      assert.equal(ref?.kind, 'structured_polars');
      assert.equal(ref?.taskId, result.taskId);
      assert.equal(ref?.resultSha256, checked.resultSha256);
      assert.equal(documentSha256, wfdSha256(canonicalWfdJson(
        buildStructuredIngestDocument(checked.structured))));
    },
    async verifyFixedDerivedRemote() {
      throw new TaskError('TEST_WFD_CHANGED', 'WFD source revision changed before first submit.');
    },
  });
  const registered = handoff.registerOriginal({ bytes: checked.originalBytes,
    originalName: 'macro.json', source: checked.source });
  const refs = { originalIds: [registered.originalId], materialIds: [], sourceRefs: [checked.source],
    processRefs: [], evidenceRefs: [{ ref_id: 'algorithm:' + result.taskId,
      content_sha256: checked.sourceSha256, kind: 'fixed-algorithm-output' }],
    fixedAlgorithm: { kind: 'structured_polars' as const, taskId: result.taskId,
      requestId: checked.structured.requestId, resultSha256: checked.resultSha256,
      namespace: 'fixture', mode: 'user_test' as const, expectedParentSnapshotId: null } };
  return { database, handoff, checked, refs, getCalls: () => ({ attempts, sent }),
    async close() { database.close(); } };
}

test('a structured algorithm uses existing R1 original refs and never sends without remote WFD re-verification', async () => {
  const f = fixture();
  try {
    const first = f.handoff.prepare({ structured: f.checked.structured, localRefs: f.refs });
    assert.equal(first.requestId, f.checked.structured.requestId);
    assert.ok(f.getCalls().attempts > 0);
    const before = f.handoff.attempt(first.requestId);
    assert.equal(before.state, 'prepared_profile_pending', '未装配真实 WFD profile 时仍保留原待核身份');
    // 单独检查同一个首次发送前远端来源闸门；此隔离宿主没有正式 WFD profile，
    // 不伪造通过 profile 再发送的条件。
    await assert.rejects(f.handoff.assertRemoteCalculationReadyToSend(
      first.requestId, new AbortController().signal),
      (error: unknown) => (error as { code?: string }).code === 'TEST_WFD_CHANGED');
    const after = f.handoff.attempt(first.requestId);
    assert.equal(after.state, 'prepared_profile_pending', 'Failed remote check cannot move an external request into sending.');
    assert.equal(after.document_sha256, before.document_sha256);
  } finally { await f.close(); }
});

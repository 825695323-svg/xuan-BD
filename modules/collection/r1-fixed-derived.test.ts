import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument, R1HandoffService, type R1LocalReferences, type R1StructuredRequest } from './r1-structured-handoff.js';

test('固定算法可凭独立结果核对直接准备 WFD，不需要伪造五步加工引用', () => {
  const database = new CoreDatabase();
  try {
    const bytes = Buffer.from('[{"timestamp":"2026-11-01","MA":12.5}]');
    const sha = wfdSha256(bytes);
    const source = { source_id: 'bd.algorithm.ma', provider: 'BD registered deterministic algorithm',
      requested_url: 'urn:bd:algorithm:test-1',
      requested_at_utc: '2026-11-10T09:00:00Z', acquired_at_utc: '2026-11-10T09:00:00Z',
      usage_scope: 'fixed derived result', authorization: { status: 'authorized' as const,
        basis: 'Input, method and output provenance verified by registered BD fixed algorithm.' },
      sha256: sha, bytes: bytes.length };
    let verifications = 0;
    const service = new R1HandoffService({ database, verifyFixedDerived: (refs, digest) => {
      assert.equal(refs.fixedAlgorithm?.taskId, 'test-1');
      assert.ok(digest.match(/^[a-f0-9]{64}$/u));
      verifications++;
    } });
    const registered = service.registerOriginal({ bytes, originalName: 'computed.json', source });
    const structured: R1StructuredRequest = {
      datasetId: 'bd-test', namespace: 'bd.test', producerNamespace: 'bd.test',
      requestId: 'bd-derived:test-1', submissionDigest: 'sha256:' + '0'.repeat(64),
      expectedParentSnapshotId: null, outputKey: 'bd.derived.ma',
      subject: { kind: 'instrument', namespace: 'bd.test', id: 'stock-1' },
      definition: { semantic_code: 'bd.derived.ma', measurement_nature: 'derived' },
      inputMode: 'partial_observation', coverage: { scope: { unit: 'test' }, basis: 'derived',
        completeness: 'partial', absence_means: 'unknown' },
      payload: { kind: 'tabular_rows', rows: [{ business_key: 'derived-1', values: { MA:
        { data_type: 'decimal', value_state: 'valid_value', value: '12.5' } } }] },
    };
    const ref: R1LocalReferences = {
      originalIds: [registered.originalId], materialIds: [], sourceRefs: [source],
      processRefs: [], evidenceRefs: [{ ref_id: 'algorithm:test-1',
        content_sha256: sha, kind: 'fixed-algorithm-output' }],
      fixedAlgorithm: { taskId: 'test-1', requestId: structured.requestId, resultSha256: '1'.repeat(64),
        namespace: 'bd.test', mode: 'user_test', expectedParentSnapshotId: null },
    };
    const response = service.prepare({ structured, localRefs: ref });
    assert.equal(response.requestId, structured.requestId);
    assert.equal(response.state, 'prepared_profile_pending');
    assert.equal(response.documentSha256, wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(structured))));
    assert.equal(verifications, 1);
    assert.throws(() => service.prepare({ structured: { ...structured, requestId: 'bd-derived:test-2' },
      localRefs: { ...ref, fixedAlgorithm: undefined } }), { code: 'R1_PROCESSING_UNBOUND' });
  } finally { database.close(); }
});

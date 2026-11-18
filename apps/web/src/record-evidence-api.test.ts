import assert from 'node:assert/strict';
import test from 'node:test';
import { recordIdentity, projectRecordEvidence } from './record-evidence-api.js';
const identity = { datasetId: 'dataset', productId: 'product', recordId: 'row', recordVersion: 'version' };
const raw = () => ({ ...identity, schema: 'bd.record-evidence/1', snapshotId: 'original-snapshot', requestId: 'request',
  sourceBytesStatus: 'verified', qualification: 'fixed_record_source_association', factVerification: 'not_established',
  processingRefsStatus: 'frozen_reference_not_revalidated', evidenceRefsStatus: 'frozen_reference_not_revalidated',
  source: { sha256: 'a'.repeat(64), bytes: 10, requested_url: 'https://private.invalid?token=secret' },
  materials: [{ materialId: 'material', filename: 'report.csv', sha256: 'a'.repeat(64), bytes: 10, originalUrl: '/api/bd/materials/material/original' }], gaps: [], evidenceRefs: ['private'], processRefs: ['private'] });
test('snapshot record identity has no aliases, missing-version or wrong-scope fallback', () => {
  const ref = { snapshot_id: 'read-snapshot', product_id: 'product', logical_key: 'row', revision_id: 'version' };
  assert.deepEqual(recordIdentity('dataset', 'product', 'read-snapshot', ref), identity);
  for (const patch of [{ snapshot_id: 'wrong' }, { product_id: 'wrong' }, { revision_id: undefined, record_version: 'version' }, { logical_key: undefined, record_id: 'row' }])
    assert.equal(recordIdentity('dataset', 'product', 'read-snapshot', { ...ref, ...patch }), null);
});
test('evidence projects bytes and exact material route without claiming snapshot equality or source truth', () => {
  const result = projectRecordEvidence(raw(), identity);
  assert.equal(result.snapshotId, 'original-snapshot');
  assert.doesNotMatch(JSON.stringify(result), /secret|private|requested_url|processRefs|evidenceRefs/u);
  assert.equal(projectRecordEvidence({ ...raw(), materials: [], gaps: [{ code: 'DOWNLOAD_MATERIAL_LINK_UNAVAILABLE' }] }, identity).downloadUnavailable, true);
  for (const patch of [{ productId: 'other' }, { recordVersion: 'other' }, { sourceBytesStatus: 'unknown' }, { factVerification: 'verified' }, { materials: [] }, { gaps: [{ code: 'arbitrary' }] }])
    assert.throws(() => projectRecordEvidence({ ...raw(), ...patch }, identity));
  for (const originalUrl of ['https://evil.invalid/original', '//evil.invalid/original', '/api/bd/materials/other/original', '/api/bd/materials/material/original?x=1'])
    assert.throws(() => projectRecordEvidence({ ...raw(), materials: [{ ...raw().materials[0], originalUrl }] }, identity));
});

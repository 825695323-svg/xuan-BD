import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { projectOcrClaim, ocrPacketDigest, readOcrClaimSelection, assertOcrClaimDeclaration, OCR_CLAIM_FIELDS } from '../../modules/collection/data-processing/ocr-claim.js';
import { parseTableSource, structureCandidateTable, annotateCandidateTable, checkCandidateTables } from '../../modules/collection/candidate-pipeline.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { prepareSyntheticOcrClaim } from './ocr-claim-test-support.js';
import { createCanvas } from '@napi-rs/canvas';
function syntheticPacket(bytes: Buffer, materialId = 'synthetic') {
  const packet: any = { schema: 'bd-ocr-review-packet/1', taskId: 'synthetic-reader-port', source: { materialId, sha256: wfdSha256(bytes) },
    textBasis: 'ocr_recognition', coordinateUnit: 'original_image_page_1_top_left_normalized', reviewStatus: 'not_recorded', eventEligibility: 'not_established',
    observations: [{ page: 1, text: 'SYNTHETIC CONTRACT INPUT', confidence: 0.5, boundingBox: { x: 0, y: 0, width: 0.8, height: 0.2 } }],
    recognizer: { revision: 1, osVersion: 'synthetic-not-recognition', languages: ['zh-Hans', 'en-US'] },
    textReference: { fileRefId: 'synthetic-text', fileRefVersion: 1, sha256: '1'.repeat(64) },
    evidenceReference: { fileRefId: 'synthetic-evidence', fileRefVersion: 1, sha256: '2'.repeat(64) }, image: { width: 100, height: 100 } };
  packet.packetSha256 = ocrPacketDigest(packet); return packet;
}
test('OCR claim projection is explicit derived evidence, not original text or a human answer', () => {
  const bytes = Buffer.from('synthetic-port-only'), packet = syntheticPacket(bytes);
  const selection = { taskId: packet.taskId, packetSha256: packet.packetSha256, sourceSha256: packet.source.sha256, observationIndex: 0, eventId: 'claim', eventType: 'statement' };
  const projected = projectOcrClaim(bytes, 'synthetic', selection, packet), rows = JSON.parse(projected.jsonBytes.toString());
  assert.equal(rows[0].human_verification, 'unknown'); assert.equal(rows[0].assertion_kind, 'source_claim');
  for (const invalid of [{ ...selection, confirmed: true }, { ...selection, observationIndex: -1 }, { ...selection, packetSha256: '0'.repeat(64) }])
    assert.throws(() => projectOcrClaim(bytes, 'synthetic', invalid, packet));
  assert.throws(() => readOcrClaimSelection({ ...selection, questionId: 'answered' }));
  assert.throws(() => projectOcrClaim(Buffer.from('different'), 'synthetic', selection, packet));
  assert.throws(() => projectOcrClaim(bytes, 'other', selection, packet));
  for (const change of [
    (p: any) => { p.observations[0].boundingBox.width = 1.1; },
    (p: any) => { p.observations[0].page = 2; },
    (p: any) => { p.reviewStatus = 'confirmed'; },
    (p: any) => { p.eventEligibility = 'established'; },
  ]) {
    const changed = structuredClone(packet); change(changed); changed.packetSha256 = ocrPacketDigest(changed);
    assert.throws(() => projectOcrClaim(bytes, 'synthetic', { ...selection, packetSha256: changed.packetSha256 }, changed));
  }
  const declaration = { target: { inputMode: 'partial_observation' }, mapping: { kind: 'event_records', contentNature: 'source_claim', status: 'unknown',
    eventId: 'event_id', eventType: 'event_type', assertionKind: 'assertion_kind', eventTime: { status: 'unknown' }, publicTime: { status: 'unknown' },
    fields: OCR_CLAIM_FIELDS.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'value_state' })) } };
  assert.doesNotThrow(() => assertOcrClaimDeclaration(declaration));
  for (const change of [
    (d: any) => { d.mapping.status = 'completed'; }, (d: any) => { d.mapping.publicTime.status = 'known'; },
    (d: any) => { d.target.definitionPublicTime = { status: 'known' }; },
    (d: any) => { d.mapping.fields.pop(); }, (d: any) => { d.target.inputMode = 'source_correction'; },
  ]) { const changed = structuredClone(declaration); change(changed); assert.throws(() => assertOcrClaimDeclaration(changed)); }

  const parsed = { ...parseTableSource(projected.jsonBytes, { materialId: 'synthetic', format: 'json' }), ocr_claim_evidence: projected.evidence };
  const structured = structureCandidateTable(parsed, {}), annotated = annotateCandidateTable(structured, {});
  assert.equal(checkCandidateTables([annotated]).rows[0]!.text_basis, 'ocr_recognition');
  assert.throws(() => checkCandidateTables([annotateCandidateTable(structured, { statement: 'manually replaced' })]));
  const noProof = { ...annotated }; delete (noProof as any).ocr_claim_evidence;
  assert.throws(() => checkCandidateTables([noProof]));
  assert.throws(() => assertOcrClaimDeclaration({ mapping: { contentNature: 'observed_fact' }, target: {} }));
});

test('synthetic reader-port contract runs actual processing and WFD but is not an OCR recognition test',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'ocr-claim-contract', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const bytes = createCanvas(100, 100).toBuffer('image/png');
      const uploaded = await host.upload('synthetic.png', 'data', bytes, 'ocr-contract-image');
      assert.equal((await host.settled(uploaded.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(uploaded.jobId)!.envelope.materialId;
      const packet = syntheticPacket(bytes, materialId); let invalid = false;
      // Typed reader-port double only; no successful OCR task/call/link is forged or claimed.
      host.services.processing!.bindOcrClaimReader(async () => invalid ? { ...packet, textBasis: 'forged' } : packet);
      const p = await prepareSyntheticOcrClaim(host.base, host.services, packet);
      invalid = true;
      await p.call('/r1/prepare', p.input, 409);
      invalid = false;
      const prepared = await p.call('/r1/prepare', p.input, 201);
      await p.call('/r1/requests/synthetic-ocr-publish/submit', {}, 409);
      await p.call('/r1/requests/synthetic-ocr-publish/submit', { confirmationDigest: '0'.repeat(64) }, 409);
      invalid = true;
      const accepted = await p.call('/r1/requests/synthetic-ocr-publish/submit', { confirmationDigest: prepared.documentSha256 });
      const refused = await p.settled(accepted.jobId);
      assert.equal(refused.status, 'failed');
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM task_effects WHERE attempt_id=?').get(refused.currentAttemptId)!.n, 0, 'Evidence failure precedes external effect marker.');
      assert.equal((await p.call('/r1/products/snapshot', {}, 200)).snapshotId, null);
      invalid = false;
      const input = { ...p.input, requestId: 'synthetic-ocr-valid' };
      const valid = await p.call('/r1/prepare', input, 201);
      const sent = await p.call('/r1/requests/synthetic-ocr-valid/submit', { confirmationDigest: valid.documentSha256 });
      const done = await p.settled(sent.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const result = await p.call('/r1/requests/synthetic-ocr-valid');
      assert.equal(result.state, 'associated');
      const ref = result.local.associations[0];
      const read = await p.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id }, 200);
      assert.equal(read.result.rows[0].values.human_verification.value, 'unknown');
      assert.equal(read.result.rows[0].times.public_time.status, 'unknown');
      const fixed = (await host.services.r1Runtime!.client.fixedRead(ref.snapshot_id, ref.product_id)).result;
      assert.equal((fixed.rows as any[])[0].row.content_nature, 'source_claim');
    } finally { await host.close(); }
  });

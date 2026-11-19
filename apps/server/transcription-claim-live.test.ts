import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { readTranscriptionReviewPacket } from './transcription-review.js';
import { openMediaReviewHost as open, invokeMediaAction as invoke } from './media-review-test-support.js';
import { prepareSyntheticOcrClaim } from './ocr-claim-test-support.js';

const bundle = process.env.XUAN_TEST_TRANSCRIPTION_BUNDLE;
test('real local Whisper yields an unverified source claim only after exact R1 confirmation and pinned media recheck', {
  skip: process.platform !== 'darwin' || !bundle || !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT
    ? 'Requires macOS, the explicit verified bundle, locked WFD and an isolated runtime.' : false,
  timeout: 300000,
}, async () => {
  const fixture = createFullChainFixture({ name: 'transcription-claim-live', machine: true, units: { text: { dimension: 'text' } },
    bundledTranscription: true, bundledCodeRoot: bundle });
  const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
  registry.manual_ingest_connection_id = 'full-chain-test';
  writeFileSync(fixture.registryPath, JSON.stringify(registry));
  // Local-only speech synthesis of test-authored words. No voice installation, network, or supplier/user material.
  const speech = join(fixture.root, 'synthetic-speech.aiff'), path = join(fixture.root, 'synthetic-claim.wav');
  execFileSync('/usr/bin/say', ['-o', speech, 'This is a synthetic test. No event has been verified.'], { timeout: 20000 });
  // Pad the source to keep recognizer tail padding separate from the strict selected interval limit.
  execFileSync(join(fixture.root, 'bundled-transcription', 'ffmpeg'), ['-nostdin', '-n', '-loglevel', 'error',
    '-protocol_whitelist', 'file', '-i', speech, '-af', 'apad=pad_dur=2', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path], { timeout: 20000 });
  const bytes = readFileSync(path), sha = wfdSha256(bytes);
  let host = await open(fixture);
  try {
    assert.ok(host.companion.r1Runtime, host.companion.r1Configuration?.reason ?? 'WFD unavailable');
    const conversationId = host.core.defaultConversationId;
    const ref = host.services.files.register({ path, source: 'user-attached', conversationId });
    host.services.permissions.grant({ label: 'isolated synthetic audio read only', scope: { kind: 'persistent' },
      capabilities: [{ action: 'read', target: { kind: 'file', path: ref.invocationPath } }] });
    const receipt = host.core.sendMessage(conversationId, 'Transcribe this synthetic test audio; make no factual assertion.', 'synthetic-claim-input',
      { attachmentRefs: [{ fileRefId: ref.id, version: ref.version, category: 'unclassified' }] });
    const input = await host.backend.waitForInput(receipt.commandId);
    const read = await invoke(host, input, 'material.read', { fileRefId: ref.id }, 'transcription-claim-read');
    const materialId = String((read.result!.data as { materialId: string }).materialId);
    const recognized = await invoke(host, input, 'material.transcribe', { fileRefId: ref.id, materialId }, 'transcription-claim-recognize');
    const packet = await readTranscriptionReviewPacket(host.services, materialId, recognized.id);
    assert.equal(packet.source.sha256, sha);
    assert.equal(packet.recognizer.modelSha256, wfdSha256(readFileSync(fixture.modelPath!)));
    assert.equal(packet.coordinateUnit, 'original_media_milliseconds_half_open');
    assert.equal(packet.eventEligibility, 'not_established');
    const segmentIndex = packet.segments.findIndex(({ text, location }) => /synthetic test/iu.test(text)
      && 0 <= location.startMs && location.startMs < location.endMs && location.endMs <= packet.recognizer.durationMs);
    assert.notEqual(segmentIndex, -1, JSON.stringify(packet.segments));
    const segment = packet.segments[segmentIndex]!;
    const p = await prepareSyntheticOcrClaim(host.base, host.companion, packet, { kind: 'transcription', segmentIndex });
    const pathFor = (id: string) => '/r1/requests/' + id;
    const prepared = await p.call('/r1/prepare', p.input, 201);
    assert.throws(() => host.companion.r1Workspace!.prepare({ ...p.input, requestId: 'sync-not-allowed' }));
    // These are synthetic HTTP fixture submissions, not user statements or real publication approval.
    await p.call(pathFor(p.input.requestId) + '/submit', { confirmed: true }, 409);
    await p.call(pathFor(p.input.requestId) + '/submit', { confirmationDigest: '0'.repeat(64) }, 409);
    const original = host.companion.materials!.readOriginal(materialId);
    const update = host.companion.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?');
    update.run(Buffer.from('synthetic corrupt original'), materialId);
    try {
      const send = await p.call(pathFor(p.input.requestId) + '/submit', { confirmationDigest: prepared.documentSha256 });
      const failed = await p.settled(send.jobId);
      assert.equal(failed.status, 'failed');
      assert.equal(host.companion.database.connection.prepare('SELECT count(*) AS n FROM task_effects WHERE attempt_id=?').get(failed.currentAttemptId)!.n, 0);
      assert.equal((await p.call('/r1/products/snapshot', {}, 200)).snapshotId, null);
    } finally { update.run(original.bytes, materialId); }
    const acceptedId = 'transcription-claim-accepted';
    const valid = await p.call('/r1/prepare', { ...p.input, requestId: acceptedId }, 201);
    const caller = () => p.call(pathFor(acceptedId) + '/submit', { confirmationDigest: valid.documentSha256 });
    const send = await caller();
    const done = await p.settled(send.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const taskCount = () => host.companion.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
    const count = taskCount();
    assert.equal((await caller()).jobId, send.jobId);
    assert.deepEqual(taskCount(), count);
    const view = await p.call(pathFor(acceptedId)); assert.equal(view.state, 'associated');
    const association = view.local.associations[0];
    const fixedRead = async () => (await host.companion.r1Runtime!.client.fixedRead(association.snapshot_id, association.product_id)).result;
    const fixed = await fixedRead(), row = (fixed.rows as any[])[0].row;
    assert.equal(row.content_nature, 'source_claim'); assert.equal(row.status, 'unknown');
    assert.equal(row.values.statement.value, segment.text);
    assert.equal(row.values.source_sha256.value, sha);
    assert.equal(row.values.text_basis.value, 'transcription_recognition');
    assert.match(row.values.media_evidence_sha256.value, /^[a-f0-9]{64}$/u);
    assert.equal(row.values.human_verification.value, 'unknown'); assert.equal(row.values.fact_verification.value, 'unknown');
    assert.equal(row.event_time.status, 'unknown'); assert.equal(row.public_time.status, 'unknown');
    await p.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id,
      historyMode: 'market_known_at', at: '2026-12-01T00:00:00Z' }, 409);
    assert.equal(wfdSha256(host.companion.materials!.readOriginal(materialId).bytes), sha);
    await host.close(); host = await open(fixture);
    assert.deepEqual(await readTranscriptionReviewPacket(host.services, materialId, recognized.id), packet);
    assert.deepEqual(await fixedRead(), fixed);
    assert.deepEqual(taskCount(), count);
  } finally { await host.close(); }
});

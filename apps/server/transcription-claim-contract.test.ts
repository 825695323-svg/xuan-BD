import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { assertOcrClaimDeclaration, mediaPacketDigest, OCR_CLAIM_FIELDS, projectTranscriptionClaim,
  readTranscriptionClaimSelection } from '../../modules/collection/data-processing/ocr-claim.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { prepareSyntheticOcrClaim } from './ocr-claim-test-support.js';

function syntheticPacket(bytes: Buffer, materialId = 'synthetic') {
  const artifact = (name: string) => ({ fileRefId: name, fileRefVersion: 1, sha256: '1'.repeat(64) });
  const packet = { schema: 'bd-transcription-review-packet/1', taskId: 'synthetic-transcription-port', source: { materialId, sha256: wfdSha256(bytes) },
    textBasis: 'transcription_recognition', coordinateUnit: 'original_media_milliseconds_half_open', reviewStatus: 'not_recorded', eventEligibility: 'not_established',
    segments: [{ text: ' Synthetic port only', location: { startMs: 50, endMs: 1000, cueIndex: 1 } }],
    recognizer: { backend: 'whisper.cpp-local', modelSha256: '2'.repeat(64), durationMs: 1000 },
    taskVersions: { implementation: 'synthetic-not-recognition' },
    accessBinding: null, textReference: artifact('synthetic-text'), evidenceReference: artifact('synthetic-native'), probeReference: artifact('synthetic-probe') };
  return { ...packet, packetSha256: mediaPacketDigest(packet) };
}
const selectionFor = (packet: ReturnType<typeof syntheticPacket>) => ({ taskId: packet.taskId, packetSha256: packet.packetSha256,
  sourceSha256: packet.source.sha256, eventId: 'synthetic-claim', eventType: 'synthetic_statement', segmentIndex: 0 });

test('transcription claim freezes one native half-open segment and refuses fabricated time or confirmation', () => {
  const bytes = Buffer.from('synthetic test only'), packet = syntheticPacket(bytes), selection = selectionFor(packet);
  const projected = projectTranscriptionClaim(bytes, 'synthetic', selection, packet);
  const [row] = JSON.parse(projected.jsonBytes.toString());
  assert.equal(row.statement, packet.segments[0]!.text);
  assert.equal(row.assertion_kind, 'source_claim');
  assert.equal(row.text_basis, 'transcription_recognition');
  assert.equal(row.human_verification, 'unknown'); assert.equal(row.fact_verification, 'unknown');
  assert.match(row.media_evidence_sha256, /^[a-f0-9]{64}$/u);
  for (const changed of [{ ...selection, segmentIndex: -1 }, { ...selection, segmentIndex: 1 },
    { ...selection, packetSha256: '0'.repeat(64) }]) assert.throws(() => projectTranscriptionClaim(bytes, 'synthetic', changed, packet));
  assert.throws(() => readTranscriptionClaimSelection({ ...selection, confirmed: true }));
  assert.throws(() => readTranscriptionClaimSelection({ ...selection, questionId: 'answered' }));
  assert.throws(() => projectTranscriptionClaim(Buffer.from('other'), 'synthetic', selection, packet));
  for (const location of [{ startMs: -1, endMs: 50, cueIndex: 1 }, { startMs: 50, endMs: 50, cueIndex: 1 },
    { startMs: 50, endMs: 1001, cueIndex: 1 }, { startMs: 0.1, endMs: 20, cueIndex: 1 }]) {
    const changed = { ...packet, segments: [{ ...packet.segments[0]!, location }] };
    changed.packetSha256 = mediaPacketDigest(changed);
    assert.throws(() => projectTranscriptionClaim(bytes, 'synthetic', selectionFor(changed), changed));
  }
  const mapping = { kind: 'event_records', contentNature: 'source_claim', status: 'unknown',
    eventId: 'event_id', eventType: 'event_type', assertionKind: 'assertion_kind',
    eventTime: { status: 'unknown' }, publicTime: { status: 'unknown' },
    fields: OCR_CLAIM_FIELDS.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'value_state' })) };
  const target = { inputMode: 'partial_observation' };
  assert.doesNotThrow(() => assertOcrClaimDeclaration({ mapping, target }));
  assert.throws(() => assertOcrClaimDeclaration({ mapping: { ...mapping, publicTime: { status: 'known' } }, target }));
  assert.throws(() => assertOcrClaimDeclaration({ mapping: { ...mapping, contentNature: 'observed_fact' }, target }));
});

/** Valid bounded silent PCM container for the transport double; never passed to a recognizer. */
function silentPcm() {
  const bytes = Buffer.alloc(44 + 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  return bytes;
}

test('synthetic transcription reader port exercises real HTTP and WFD without claiming actual recognition', {
  skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 180000,
}, async () => {
  const fixture = createFullChainFixture({ name: 'transcription-claim-contract', machine: true, units: { text: { dimension: 'text' } } });
  const host = await openFullChainHost(fixture);
  try {
    const bytes = silentPcm(), uploaded = await host.upload('synthetic.wav', 'data', bytes, 'transcription-contract-wave');
    assert.equal((await host.settled(uploaded.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(uploaded.jobId)!.envelope.materialId;
    const packet = syntheticPacket(bytes, materialId);
    let current = packet;
    // Only this trusted reader port is doubled. No OCR/Whisper process or speaker evidence exists.
    host.services.processing!.bindTranscriptionClaimReader(async () => current);
    const p = await prepareSyntheticOcrClaim(host.base, host.services, packet, { kind: 'transcription' });
    const changeProbe = () => {
      current = { ...packet, probeReference: { ...packet.probeReference, sha256: 'a'.repeat(64) } };
      current.packetSha256 = mediaPacketDigest(current);
    };
    changeProbe();
    await p.call('/r1/prepare', p.input, 409);
    current = packet;
    const prepared = await p.call('/r1/prepare', p.input, 201);
    const submit = '/r1/requests/' + p.input.requestId + '/submit';
    await p.call(submit, { confirmationDigest: '0'.repeat(64) }, 409);
    await p.call(submit, {}, 409);
    changeProbe();
    const accepted = await p.call(submit, { confirmationDigest: prepared.documentSha256 });
    const failed = await p.settled(accepted.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM task_effects WHERE attempt_id=?').get(failed.currentAttemptId)!.n, 0);
    assert.equal((await p.call('/r1/products/snapshot', {}, 200)).snapshotId, null);

    current = packet;
    const id = 'transcription-valid', valid = await p.call('/r1/prepare', { ...p.input, requestId: id }, 201);
    const sent = await p.call('/r1/requests/' + id + '/submit', { confirmationDigest: valid.documentSha256 });
    const done = await p.settled(sent.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const result = await p.call('/r1/requests/' + id); assert.equal(result.state, 'associated');
    const ref = result.local.associations[0];
    const read = await p.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id }, 200);
    assert.equal(read.result.rows[0].values.statement.value, packet.segments[0]!.text);
    assert.equal(read.result.rows[0].values.text_basis.value, 'transcription_recognition');
    assert.equal(read.result.rows[0].values.human_verification.value, 'unknown');
    assert.equal(read.result.rows[0].times.public_time.status, 'unknown');
  } finally { await host.close(); }
});

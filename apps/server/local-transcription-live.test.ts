import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { parseWhisperTranscription } from '../../platform/capabilities/transcription/local.js';
import { readTranscriptionReviewPacket } from './transcription-review.js';
import { createFullChainFixture, grantSelectedFile, openFullChainHost, startDirect } from './full-chain-test-support.js';

const bundle = process.env.XUAN_TEST_TRANSCRIPTION_BUNDLE, audio = process.env.XUAN_TEST_TRANSCRIPTION_AUDIO;
// Explicit opt-in public sample from whisper.cpp; no private media, model service or downloaded executable.
const sampleSha256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
test('actual manifest-verified local Whisper preserves native transcript evidence and does not imply source-truth verification',
  { skip: !bundle || !audio || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires explicitly selected verified bundle, public JFK sample, and isolated test root.' : false, timeout: 300000 }, async () => {
    assert.equal(wfdSha256(readFileSync(audio!)), sampleSha256);
    const fixture = createFullChainFixture({ name: 'local-transcription-public', bundledTranscription: true, bundledCodeRoot: bundle });
    let host = await openFullChainHost(fixture);
    try {
      const ref = grantSelectedFile(host, audio!, 'public-whisper-jfk-sample-local-read-only');
      const materialTask = host.services.materials!.submit({ fileRefId: ref.id, category: 'unclassified', mediaType: 'audio/wav', expectedSha256: sampleSha256 }, 'public-audio-custody');
      assert.equal((await host.settled(materialTask.id)).status, 'succeeded');
      const material = host.services.materials!.getByTask(materialTask.id)!;
      assert.equal(material.envelope.sha256, sampleSha256);
      assert.equal(host.services.direct.registry.get('audio.transcribe').availability.available, true);
      const task = startDirect(host, 'audio.transcribe', { fileRefId: ref.id }, 'public-local-transcription');
      const finished = await host.settled(task.id, 240000);
      const progressEvents = host.services.tasks.events(task.id).filter(e => ['PROGRESS', 'WORKER_STATE', 'SIDE_EFFECT_RESULT'].includes(e.type));
      console.log('TRANSCRIPTION_NUMERIC_DIAGNOSTICS', JSON.stringify({ budget: host.services.tasks.getBudget(task.id),
        events: progressEvents.map(e => ({ type: e.type, timestamp: e.timestamp,
          ...(e.type === 'PROGRESS' && (e.data as any).data?.basis === 'whisper_native_progress' ? { nativePercent: (e.data as any).data.percent } : {}) })) }));
      assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
      const data = finished.result!.data as any;
      assert.equal(data.backend, 'whisper.cpp-local'); assert.equal(data.source.sha256, sampleSha256);
      const artifact = (reference: any) => {
        const selected = host.services.files.verify(reference.fileRefId);
        assert.equal(selected.version, reference.fileRefVersion);
        const bytes = readFileSync(selected.invocationPath); assert.equal(wfdSha256(bytes), reference.sha256); return bytes;
      };
      const text = artifact(data.textReference).toString('utf8'), evidence = artifact(data.evidenceReference).toString('utf8');
      // The sample duration is 11 seconds; these are native recognizer offsets, not reconstructed from words.
      const segments = parseWhisperTranscription(evidence, text, 11000);
      const packet = await readTranscriptionReviewPacket(host.services, material.envelope.materialId, task.id);
      assert.deepEqual(packet.segments, segments); assert.equal(packet.source.fileRefId, ref.id);
      assert.equal(packet.source.sha256, sampleSha256); assert.equal(packet.reviewStatus, 'not_recorded');
      assert.ok(segments.length > 0); assert.equal(data.segmentCount, segments.length);
      assert.match(text, /ask not/iu, 'A coarse fixture anchor, not word-for-word recognition certification.');
      assert.throws(() => parseWhisperTranscription(evidence, text + '\nNot spoken in the source.', 11000), /核对/);
      const tampered = JSON.parse(evidence); tampered.transcription[0].offsets.to = 999999;
      assert.throws(() => parseWhisperTranscription(JSON.stringify(tampered), text, 11000), /时间轴/);
      assert.equal(host.services.direct.registry.get('material.ocr').availability.available, false, 'Unwired OCR is not replaced with a test recognizer');
      const planned = await host.call('/processing/plans', { requestId: 'audio-is-not-source-text', input: {
        routing: { materials: [{ materialId: material.envelope.materialId, intendedAction: 'inspect' }] },
        outputs: [{ outputId: 'claim', materialIds: [material.envelope.materialId], intendedAction: 'inspect', stages: ['parse', 'structure', 'check'],
          tables: [{ materialId: material.envelope.materialId, format: 'text', eventTextSelection: { version: EVENT_TEXT_VERSION, sourceSha256: sampleSha256,
            occurrence: { namespace: 'synthetic', publisherId: 'sample', publicationId: 'recognizer-output', kind: 'original', upstreamPublicationId: null },
            reviewBasis: 'Negative fixture: ASR text must not masquerade as exact original audio text.', excerpts: [{ start: 0, end: text.length, quote: text }] } }] }] } }, 202);
      assert.equal((await host.settled(planned.jobId)).status, 'succeeded');
      const plan = host.services.processing!.getByTask(planned.jobId)!.plan!;
      const parsed = plan.steps.find(step => step.kind === 'parse')!;
      const attempted = await host.call(`/processing/plans/${plan.planId}/steps/${parsed.stepId}/execute`, { requestId: 'no-asr-laundering' }, 202);
      const blocked = await host.settled(attempted.jobId);
      assert.equal(blocked.status, 'failed'); assert.equal(blocked.error?.code, 'PROCESSING_STEP_BLOCKED');
      assert.equal(host.services.processing!.get(plan.planId).outputs[0]!.publishEligible, false);
      const count = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = await openFullChainHost(fixture);
      assert.equal(host.services.tasks.get(task.id).status, 'succeeded');
      assert.deepEqual(await readTranscriptionReviewPacket(host.services, material.envelope.materialId, task.id), packet);
      assert.equal(artifact(data.textReference).toString('utf8'), text);
      assert.equal(artifact(data.evidenceReference).toString('utf8'), evidence);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
      assert.equal(wfdSha256(readFileSync(audio!)), sampleSha256);
    } finally { await host.close(); }
  });

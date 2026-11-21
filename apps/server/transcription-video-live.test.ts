import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { conversionArguments } from '../../platform/capabilities/local-actions.js';
import { createFullChainFixture, settleFixtureTask } from './full-chain-test-support.js';
import { openMediaReviewHost, invokeMediaAction, prepareTranscriptionParse } from './media-review-test-support.js';
import { readTranscriptionReviewPacket, readTranscriptionSourceClaim } from './transcription-review.js';

const bundle = process.env.XUAN_TEST_TRANSCRIPTION_BUNDLE, audio = process.env.XUAN_TEST_TRANSCRIPTION_AUDIO;
test('four local video containers retain the original, first audio stream, model and native intervals through claim projection',
  { skip: !bundle || !audio || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires pinned local bundle and public JFK sample.' : false, timeout: 300000 }, async () => {
    assert.equal(wfdSha256(readFileSync(audio!)), '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e');
    const f = createFullChainFixture({ name: 'transcription-video', bundledTranscription: true, bundledCodeRoot: bundle });
    const resources = new ResourceBindings(f.runtime), ffmpeg = resources.path('ffmpeg'), frame = join(f.root, 'synthetic-black.ivf');
    // A single synthetic 16x16 black VP8 frame. The tested bundle includes the decoder/muxer.
    writeFileSync(frame, Buffer.from('REtJRgAAIABWUDgwEAAQABkAAAABAAAAAQAAAAAAAAAfAAAAAAAAAAAAAAAQAgCdASoQABAAAEcIhYWIhYSIAgIADA1gAP7/q1CA', 'base64'));
    const host = await openMediaReviewHost(f, false);
    try {
      const samples = [['mp4', 'video/mp4'], ['mov', 'video/quicktime'], ['mkv', 'video/x-matroska'], ['webm', 'video/webm'], ['silent.mp4', 'video/mp4']] as const;
      const inputs = samples.map(([suffix, mime]) => {
        const silent = suffix === 'silent.mp4', webm = suffix === 'webm', mov = suffix.endsWith('mp4') || suffix === 'mov';
        const path = join(f.root, 'synthetic.' + suffix);
        execFileSync(ffmpeg, ['-v', 'error', '-i', frame, ...(silent ? [] : [...(suffix === 'mov' ? ['-itsoffset', '1'] : []), '-i', audio!]),
          '-c:v', mov ? 'libx264' : 'copy', ...(silent ? ['-an'] : webm ? ['-c:a', 'opus', '-strict', 'experimental', '-ar', '48000']
            : ['-c:a', suffix === 'mp4' ? 'aac' : 'pcm_s16le']), path]);
        const reference = host.services.files.register({ path, source: 'user-attached', conversationId: host.core.defaultConversationId });
        host.services.permissions.grant({ label: 'isolated public video fixture', scope: { kind: 'persistent' },
          capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
        return { path, reference, suffix, mime, silent };
      });
      const accepted = host.core.sendMessage(host.core.defaultConversationId, '转录已选的公开测试视频并核对来源。', 'synthetic-video-input',
        { attachmentRefs: inputs.map(({ reference }) => ({ fileRefId: reference.id, version: reference.version, category: 'unclassified' })) });
      const input = await host.backend.waitForInput(accepted.commandId);
      for (const { path, reference, suffix, mime, silent } of inputs) {
        const fileRefId = reference.id, read = await invokeMediaAction(host, input, 'material.read', { fileRefId }, 'read-' + suffix);
        const materialId = String((read.result!.data as any).materialId), held = host.companion.materials!.get(materialId);
        assert.equal(held.preview.format, 'video'); assert.equal(held.envelope.mediaType, mime);
        let task;
        if (suffix === 'mp4' || suffix === 'mkv') {
          task = await invokeMediaAction(host, input, 'material.transcribe', { materialId, fileRefId }, 'transcribe-' + suffix);
        } else {
          const action = 'audio.transcribe', args = { fileRefId };
          const direct = host.services.tasks.create({ action, args, requestId: 'direct-' + suffix, runtimeId: 'direct', title: 'isolated direct video transcription',
            versions: host.services.direct.registry.captureVersions(action, args) });
          host.services.tasks.start(direct.id, direct.version);
          task = await settleFixtureTask(host.services.tasks, direct.id, 180_000);
        }
        if (silent) {
          assert.equal(task.status, 'failed'); assert.equal(task.error?.code, 'MEDIA_NO_AUDIO_STREAM');
          await assert.rejects(readTranscriptionReviewPacket(host.services, materialId, task.id));
          await assert.rejects(invokeMediaAction(host, input, 'material.transcribe', { materialId, fileRefId }, 'silent-material'),
            /MEDIA_NO_AUDIO_STREAM/u);
          continue;
        }
        assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
        const packet = await readTranscriptionReviewPacket(host.services, materialId, task.id), bytes = readFileSync(path);
        assert.equal(packet.source.sha256, wfdSha256(bytes)); assert.equal(packet.recognizer.modelSha256, wfdSha256(readFileSync(f.modelPath!)));
        assert.equal(packet.coordinateUnit, 'original_media_milliseconds_half_open');
        assert.equal(packet.media!.audioStreamIndex, 1);
        if (suffix === 'mov') {
          assert.equal(packet.media!.audioStartMs, 1000);
          const wave = join(f.root, 'clock-check.wav');
          execFileSync(ffmpeg, conversionArguments(path, '.mov', wave, 'wav', true));
          const duration = execFileSync(resources.path('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', wave], { encoding: 'utf8' });
          assert.equal(Number(duration), 12, 'The actual Whisper input retains one second before the 11s audio track.');
        }
        assert.equal(packet.reviewStatus, 'not_recorded'); assert.equal(packet.eventEligibility, 'not_established');
        const segmentIndex = packet.segments.findIndex(s => s.location.endMs <= packet.recognizer.durationMs); assert.ok(segmentIndex >= 0);
        const selection = { taskId: task.id, packetSha256: packet.packetSha256, sourceSha256: packet.source.sha256,
          segmentIndex, eventId: 'synthetic', eventType: 'test' };
        const { plan, step, operator } = await prepareTranscriptionParse(host.companion, materialId, selection);
        assert.equal(step.applicability, 'applicable', JSON.stringify(step.gaps));
        const parsed = await settleFixtureTask(host.companion.tasks, host.companion.processing!.executeStep(plan.planId, step.stepId,
          { ...operator, requestId: 'parse-' + materialId }).id);
        assert.equal(parsed.status, 'succeeded', JSON.stringify(parsed.error));
        const claim = await readTranscriptionSourceClaim(host.services, materialId, selection);
        const [row] = JSON.parse(claim.jsonBytes.toString());
        assert.match(packet.text, /ask not/iu); assert.equal(row.statement, packet.segments[segmentIndex]!.text);
        assert.equal(row.assertion_kind, 'source_claim'); assert.equal(row.fact_verification, 'unknown');
      }
    } finally { await host.close(); }
  });

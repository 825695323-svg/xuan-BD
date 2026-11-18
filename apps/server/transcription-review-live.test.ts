import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { assertLateMediaOriginalRejected, openMediaReviewHost as open, invokeMediaAction as invoke, model, unusedPiContext } from './media-review-test-support.js';
import { readTranscriptionReviewPacket } from './transcription-review.js';
import { readTranscriptionReviewHandoff } from './transcription-handoff.js';
const bundle = process.env.XUAN_TEST_TRANSCRIPTION_BUNDLE, audio = process.env.XUAN_TEST_TRANSCRIPTION_AUDIO;
const sampleSha256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';

test('real conversation local transcription preserves native evidence and literal confirmation remains a user statement',
  { skip: !bundle || !audio || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires explicit verified existing bundle, public JFK sample and isolated test root.' : false, timeout: 300000 }, async () => {
    assert.equal(wfdSha256(readFileSync(audio!)), sampleSha256);
    const fixture = createFullChainFixture({ name: 'transcription-review-live', bundledTranscription: true, bundledCodeRoot: bundle });
    let host = await open(fixture);
    try {
      const conversationId = host.core.defaultConversationId;
      const reference = host.services.files.register({ path: audio!, source: 'user-attached', conversationId });
      host.services.permissions.grant({ label: 'explicit public JFK sample read only', scope: { kind: 'persistent' },
        capabilities: [{ action: 'read', target: { kind: 'file', path: reference.invocationPath } }] });
      const accepted = host.core.sendMessage(conversationId, '对明确附上的公开测试音频使用已装配本机转录，提供人工核对材料，不发布事件。', 'synthetic-transcription-input',
        { attachmentRefs: [{ fileRefId: reference.id, version: reference.version, category: 'unclassified' }] });
      const input = await host.backend.waitForInput(accepted.commandId);
      const readTask = await invoke(host, input, 'material.read', { fileRefId: reference.id }, 'transcription-material-read');
      const materialId = String((readTask.result!.data as any).materialId);
      const task = await invoke(host, input, 'material.transcribe', { fileRefId: reference.id, materialId }, 'transcription-material-recognize');
      const result = (task.result!.data as any).mediaResult;
      const endpoint = `/api/ui/materials/${materialId}/transcription-review/${task.id}`;
      const response = await fetch(host.base + endpoint); assert.equal(response.status, 200, await response.clone().text());
      const packet = await response.json(); assert.deepEqual(packet, await readTranscriptionReviewPacket(host.services, materialId, task.id));
      assert.equal(packet.schema, 'bd-transcription-review-packet/1'); assert.match(packet.text, /ask not/iu);
      assert.equal(packet.recognizer.backend, 'whisper.cpp-local'); assert.equal(packet.recognizer.modelSha256, wfdSha256(readFileSync(fixture.modelPath!)));
      assert.equal(packet.recognizer.durationMs, 11000); assert.ok(packet.segments.length > 0);
      assert.equal(packet.coordinateUnit, 'original_media_milliseconds_half_open');
      assert.equal(packet.textBasis, 'transcription_recognition'); assert.equal(packet.reviewStatus, 'not_recorded'); assert.equal(packet.eventEligibility, 'not_established');
      const originalResponse = await fetch(host.base + packet.original.url); assert.equal(originalResponse.status, 200);
      assert.equal(wfdSha256(Buffer.from(await originalResponse.arrayBuffer())), sampleSha256);
      for (const ref of [packet.textReference, packet.evidenceReference, packet.probeReference] as { fileRefId: string; fileRefVersion: number; sha256: string }[]) {
        const current = host.services.files.verify(ref.fileRefId); assert.equal(current.version, ref.fileRefVersion);
        assert.equal(wfdSha256(readFileSync(current.invocationPath)), ref.sha256);
      }
      await assertLateMediaOriginalRejected(host.services, materialId, result.textReference.fileRefId, () => readTranscriptionReviewPacket(host.services, materialId, task.id));
      assert.deepEqual(await readTranscriptionReviewPacket(host.services, materialId, task.id), packet);
      const handoffEndpoint = endpoint + '/handoff';
      const initialResponse = await fetch(host.base + handoffEndpoint); assert.equal(initialResponse.status, 200);
      const initial = await initialResponse.json(); assert.equal(initial.state, 'awaiting_question');
      const wrongQuestion = await fetch(host.base + handoffEndpoint + '/missing-question');
      assert.equal(wrongQuestion.status, 409);
      assert.equal((await wrongQuestion.json()).code, 'TRANSCRIPTION_HANDOFF_UNAVAILABLE');
      const tools = host.services.modelTools.toolFactory({ model, getCurrentInput: () => input });
      assert.ok(!tools.some(tool => /answer|confirm/iu.test(tool.name)));
      const ask = tools.find(tool => tool.name === 'ask_user'); assert.ok(ask);
      await ask.execute('transcription-review-question', { question: initial.question, options: initial.options }, undefined, undefined, unusedPiContext);
      const question = host.database.connection.prepare('SELECT id FROM agent_questions WHERE run_id=? AND generation=? AND tool_call_id=?').get(input.runId, input.generation, 'transcription-review-question')!;
      assert.equal((await readTranscriptionReviewHandoff(host.services, materialId, task.id, String(question.id))).state, 'awaiting_user');
      // Explicit synthetic fixture response, not the owner's statement or authorization.
      const answerText = '全部确认无误';
      const answered = await fetch(host.base + `/api/questions/${question.id}/answer`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify({ answer: answerText, requestId: 'synthetic-transcription-answer' }) });
      assert.equal(answered.status, 202);
      const received = await readTranscriptionReviewHandoff(host.services, materialId, task.id, String(question.id));
      assert.equal(received.state, 'user_statement_received'); assert.equal(received.response!.text, answerText);
      assert.equal(received.response!.basis, 'user_statement'); assert.equal(received.humanVerification, 'not_established'); assert.equal(received.eventEligibility, 'not_established');
      assert.equal((await fetch(host.base + endpoint + '?confirmed=true')).status, 400);
      assert.equal((await fetch(host.base + handoffEndpoint + '/' + question.id + '?confirmed=true')).status, 400);
      const post = await fetch(host.base + handoffEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: '{"confirmed":true}' }); assert.ok(post.status >= 400);
      await assert.rejects(readTranscriptionReviewPacket(host.services, materialId, readTask.id));
      await assert.rejects(readTranscriptionReviewPacket(host.services, 'different-material', task.id));
      const count = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      const negative = async (mutate: (result: any) => void) => {
        host.database.connection.exec('BEGIN');
        try {
          const changed = structuredClone(task.result) as any; mutate(changed.data.mediaResult);
          host.database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(changed), task.id);
          await assert.rejects(readTranscriptionReviewPacket(host.services, materialId, task.id));
        } finally { host.database.connection.exec('ROLLBACK'); }
      };
      await negative(r => { delete r.recognition; }); await negative(r => { delete r.probeReference; });
      await negative(r => { r.recognition.modelSha256 = '0'.repeat(64); });
      await negative(r => { r.recognition.durationMs++; });
      await negative(r => { r.segments[0].location.startMs = 1; });
      await negative(r => { r.evidenceReference = r.textReference; });
      await host.close(); host = await open(fixture);
      assert.deepEqual(await readTranscriptionReviewPacket(host.services, materialId, task.id), packet);
      const reopenedAnswer = await readTranscriptionReviewHandoff(host.services, materialId, task.id, String(question.id));
      const delivery = host.core.store.command(received.response!.commandId).state;
      assert.deepEqual(reopenedAnswer, { ...received, response: { ...received.response, deliveryState: delivery } }, 'Restart preserves original answer and identity while exposing the real queued-to-held transition.');
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
      const nativePath = host.services.files.verify(result.evidenceReference.fileRefId).invocationPath;
      const native = JSON.parse(readFileSync(nativePath, 'utf8')); native.transcription[0].offsets.to = 999999;
      writeFileSync(nativePath, JSON.stringify(native));
      await assert.rejects(readTranscriptionReviewPacket(host.services, materialId, task.id));
      // Test text corruption independently by reading it before native evidence.
      const textPath = host.services.files.verify(result.textReference.fileRefId).invocationPath;
      writeFileSync(textPath, 'forged words not in the source');
      await assert.rejects(readTranscriptionReviewPacket(host.services, materialId, task.id));
      assert.equal(wfdSha256(readFileSync(audio!)), sampleSha256);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
    } finally { await host.close(); }
  });

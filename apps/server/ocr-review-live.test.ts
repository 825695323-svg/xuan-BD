import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { readOcrReviewHandoff } from './ocr-handoff.js';
import { readOcrReviewPacket } from './ocr-review.js';
import { assertLateMediaOriginalRejected, openMediaReviewHost as open, invokeMediaAction as invoke, model, unusedPiContext } from './media-review-test-support.js';
const binary = process.env.XUAN_TEST_VISION_OCR;
test('real conversation material read and Vision OCR produce a read-only, unreviewed evidence packet',
  { skip: process.platform !== 'darwin' || !binary || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires macOS, explicit compiled helper and isolated full-chain root.' : false, timeout: 240000 }, async () => {
    const fixture = createFullChainFixture({ name: 'ocr-review-live' });
    const bindingPath = join(fixture.runtime, 'config/machine.bindings.json');
    const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
    bindings.resources.vision_ocr = { path: realpathSync(binary!), kind: 'program', sha256: wfdSha256(readFileSync(binary!)) };
    writeFileSync(bindingPath, JSON.stringify(bindings));
    const imagePath = join(fixture.root, 'synthetic-announcement.png');
    const canvas = createCanvas(1000, 240), ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 240); ctx.fillStyle = 'black'; ctx.font = '52px Arial';
    ctx.fillText('SYNTHETIC TEST 2026', 40, 110);
    const original = canvas.toBuffer('image/png'); writeFileSync(imagePath, original);
    let host = await open(fixture);
    try {
      const conversationId = host.core.defaultConversationId;
      const reference = host.services.files.register({ path: imagePath, source: 'user-attached', conversationId });
      host.services.permissions.grant({ label: 'synthetic selected image only', scope: { kind: 'persistent' },
        capabilities: [{ action: 'read', target: { kind: 'file', path: imagePath } }] });
      const accepted = host.core.sendMessage(conversationId, '请读取明确附上的合成测试图片，并用本机 OCR 识别，只提供人工核对材料，不确认事实或发布事件。', 'synthetic-ocr-input',
        { attachmentRefs: [{ fileRefId: reference.id, version: reference.version, category: 'unclassified' }] });
      const input = await host.backend.waitForInput(accepted.commandId);
      const readTask = await invoke(host, input, 'material.read', { fileRefId: reference.id }, 'synthetic-material-read');
      const materialId = String((readTask.result!.data as any).materialId);
      const ocrTask = await invoke(host, input, 'material.ocr', { fileRefId: reference.id, materialId }, 'synthetic-material-ocr');
      const result = (ocrTask.result!.data as any).mediaResult;
      assert.ok(result.evidenceReference);
      const endpoint = `/api/ui/materials/${materialId}/ocr-review/${ocrTask.id}`;
      const response = await fetch(host.base + endpoint); assert.equal(response.status, 200);
      const packet = await response.json();
      assert.deepEqual(packet, await readOcrReviewPacket(host.services, materialId, ocrTask.id));
      const crossSite = await fetch(host.base + endpoint, { headers: { origin: 'https://untrusted.example.test', 'sec-fetch-site': 'cross-site' } });
      assert.equal(crossSite.status, 403, 'Existing real local-origin gate rejects third-party reads; this is not a lifecycle revocation test.');
      const suppliedConfirmation = await fetch(host.base + endpoint + '?confirmed=true');
      assert.equal(suppliedConfirmation.status, 400, 'A caller cannot supply a review confirmation.');
      const originalResponse = await fetch(host.base + packet.original.url);
      assert.equal(originalResponse.status, 200, 'Packet original URL must resolve through the personal-to-workspace route.');
      assert.equal(wfdSha256(Buffer.from(await originalResponse.arrayBuffer())), wfdSha256(original));
      assert.equal(packet.schema, 'bd-ocr-review-packet/1');
      assert.equal(packet.source.materialId, materialId); assert.equal(packet.source.sha256, wfdSha256(original));
      assert.equal(packet.taskId, ocrTask.id); assert.match(packet.text, /SYNTHETIC TEST/u);
      assert.ok(packet.observations.length > 0); assert.ok(packet.recognizer.revision > 0);
      assert.equal(packet.reviewStatus, 'not_recorded'); assert.equal(packet.eventEligibility, 'not_established');
      assert.equal(packet.textBasis, 'ocr_recognition');
      const count = () => host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      // Synthetic HTTP answers below are test fixtures, never the owner's approval.
      await assertLateMediaOriginalRejected(host.services, materialId, result.textReference.fileRefId, () => readOcrReviewPacket(host.services, materialId, ocrTask.id));
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocrTask.id), packet);
      const handoffEndpoint = endpoint + '/handoff';
      const initialResponse = await fetch(host.base + handoffEndpoint); assert.equal(initialResponse.status, 200);
      const initial = await initialResponse.json();
      assert.equal(initial.schema, 'bd-ocr-human-handoff/1'); assert.equal(initial.state, 'awaiting_question');
      assert.equal(initial.questionId, null); assert.equal(initial.response, null);
      assert.equal(initial.eventEligibility, 'not_established'); assert.equal(initial.humanVerification, 'not_established');
      const tools = host.services.modelTools.toolFactory({ model, getCurrentInput: () => input });
      assert.ok(!tools.some(tool => /answer|confirm/iu.test(tool.name)), 'The model has no user-answer or signing tool.');
      const ask = tools.find(tool => tool.name === 'ask_user'); assert.ok(ask);
      const askQuestion = async (callId: string) => {
        await ask.execute(callId, { question: initial.question, options: initial.options }, undefined, undefined, unusedPiContext);
        const row = host.database.connection.prepare('SELECT id FROM agent_questions WHERE run_id=? AND generation=? AND tool_call_id=?').get(input.runId, input.generation, callId);
        assert.ok(row); return String(row.id);
      };
      const questionId = await askQuestion('synthetic-ocr-review-question');
      const pending = await readOcrReviewHandoff(host.services, materialId, ocrTask.id, questionId);
      assert.equal(pending.state, 'awaiting_user'); assert.equal(pending.digest, initial.digest);
      const fakeQuery = await fetch(host.base + handoffEndpoint + '/' + questionId + '?confirmed=true');
      assert.equal(fakeQuery.status, 400);
      const fakePost = await fetch(host.base + handoffEndpoint + '/' + questionId, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify({ confirmed: true }) });
      assert.ok(fakePost.status >= 400);
      // Synthetic HTTP test input, never a real user's attestation. Even an unqualified affirmative must not upgrade evidence.
      const answerText = '全部确认无误'; // Synthetic answer: the word 确认 must not imply verification.
      const answerResponse = await fetch(host.base + `/api/questions/${questionId}/answer`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ answer: answerText, requestId: 'synthetic-ocr-answer-001' }) });
      assert.equal(answerResponse.status, 202);
      const answeredReceipt = await answerResponse.json();
      const receivedResponse = await fetch(host.base + handoffEndpoint + '/' + questionId); assert.equal(receivedResponse.status, 200);
      const received = await receivedResponse.json();
      assert.equal(received.state, 'user_statement_received'); assert.equal(received.response.text, answerText);
      assert.equal(received.response.basis, 'user_statement');
      assert.equal(received.response.commandId, answeredReceipt.receipt.commandId);
      assert.equal(received.response.messageId, null, 'A queued genuine answer need not have a user message yet.');
      assert.ok(['queued', 'held'].includes(received.response.deliveryState));
      assert.equal(received.humanVerification, 'not_established'); assert.equal(received.eventEligibility, 'not_established');
      const rejectedMutation = async (mutate: () => void) => {
        host.database.connection.exec('BEGIN');
        try { mutate(); await assert.rejects(readOcrReviewHandoff(host.services, materialId, ocrTask.id, questionId)); }
        finally { host.database.connection.exec('ROLLBACK'); }
      };
      // Synthetic branch-provenance fault, not a claim of UI branch switching.
      await rejectedMutation(() => {
        const branch = host.database.connection.prepare('SELECT * FROM branches WHERE id=?').get(input.branchId)!;
        const alternateId = 'synthetic-ocr-other-branch';
        host.database.connection.prepare('INSERT INTO branches(id,conversation_id,head_message_id,session_ref,checkpoint_json,checkpoint_head_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(alternateId, branch.conversation_id, null, null, null, null, branch.created_at, branch.updated_at);
        host.database.connection.prepare('UPDATE agent_questions SET branch_id=? WHERE id=?').run(alternateId, questionId);
      });
      await rejectedMutation(() => { host.database.connection.prepare('UPDATE agent_questions SET question=? WHERE id=?').run('Changed OCR question', questionId); });
      await rejectedMutation(() => { host.database.connection.prepare('UPDATE agent_questions SET options_json=? WHERE id=?').run('["confirmed"]', questionId); });
      await rejectedMutation(() => { host.database.connection.prepare('UPDATE agent_questions SET receipt_json=? WHERE id=?').run(JSON.stringify({ commandId: input.inputId, runId: input.runId, status: 'consumed' }), questionId); });
      await rejectedMutation(() => { host.database.connection.prepare("UPDATE commands SET state='cancelled' WHERE id=?").run(received.response.commandId); });
      await rejectedMutation(() => { host.database.connection.prepare("UPDATE messages SET role='assistant' WHERE id=?").run(input.messageId); });
      await rejectedMutation(() => { host.database.connection.prepare('DELETE FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?').run(input.runId, input.generation, 'synthetic-ocr-review-question'); });
      assert.equal((await readOcrReviewHandoff(host.services, materialId, ocrTask.id, questionId)).state, 'user_statement_received');
      const dismissId = await askQuestion('synthetic-ocr-dismiss-question');
      const dismissedResponse = await fetch(host.base + `/api/questions/${dismissId}/dismiss`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: '{}' });
      assert.equal(dismissedResponse.status, 200);
      const dismissed = await readOcrReviewHandoff(host.services, materialId, ocrTask.id, dismissId);
      assert.equal(dismissed.state, 'dismissed'); assert.equal(dismissed.response, null);
      assert.equal(dismissed.humanVerification, 'not_established');
      const before = count();
      await assert.rejects(readOcrReviewPacket(host.services, 'wrong-material', ocrTask.id));
      await assert.rejects(readOcrReviewPacket(host.services, materialId, readTask.id));
      assert.deepEqual(count(), before);
      await host.close(); host = await open(fixture);
      assert.equal(host.services.tasks.get(ocrTask.id).status, 'succeeded');
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocrTask.id), packet);
      const reopenedHandoff = await readOcrReviewHandoff(host.services, materialId, ocrTask.id, questionId);
      assert.equal(reopenedHandoff.state, 'user_statement_received');
      assert.equal(reopenedHandoff.response?.text, answerText);
      assert.equal(reopenedHandoff.response?.commandId, received.response.commandId);
      assert.equal(reopenedHandoff.humanVerification, 'not_established');
      assert.equal((await readOcrReviewHandoff(host.services, materialId, ocrTask.id, dismissId)).state, 'dismissed');
      assert.deepEqual(count(), before);
      assert.equal(wfdSha256(readFileSync(imagePath)), wfdSha256(original));
      // Fault injection only AFTER a real successful pipeline. Rollback restores
      // the genuine recorded row; it never creates a successful provenance row.
      host.database.connection.exec('BEGIN');
      try {
        host.database.connection.prepare('DELETE FROM conversation_material_calls WHERE local_task_id=?').run(ocrTask.id);
        await assert.rejects(readOcrReviewPacket(host.services, materialId, ocrTask.id));
      } finally { host.database.connection.exec('ROLLBACK'); }
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocrTask.id), packet);
      host.database.connection.exec('BEGIN');
      try {
        const tamperedResult = structuredClone(ocrTask.result) as any;
        tamperedResult.data.mediaResult.segments[0].text = 'not the native OCR observation';
        host.database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(tamperedResult), ocrTask.id);
        await assert.rejects(readOcrReviewPacket(host.services, materialId, ocrTask.id));
      } finally { host.database.connection.exec('ROLLBACK'); }
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocrTask.id), packet);
      const evidencePath = host.services.files.verify(result.evidenceReference.fileRefId).invocationPath;
      writeFileSync(evidencePath, Buffer.from('tampered'));
      await assert.rejects(readOcrReviewPacket(host.services, materialId, ocrTask.id));
      assert.equal(wfdSha256(readFileSync(imagePath)), wfdSha256(original));
      assert.deepEqual(count(), before);
    } finally { await host.close(); }
  });

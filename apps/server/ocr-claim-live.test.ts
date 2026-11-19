import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { readOcrReviewPacket } from './ocr-review.js';
import { openMediaReviewHost as open, invokeMediaAction as invoke } from './media-review-test-support.js';
import { prepareSyntheticOcrClaim } from './ocr-claim-test-support.js';
const binary = process.env.XUAN_TEST_VISION_OCR;
test('real local Vision observation becomes only a confirmed unverified source claim through processing and WFD',
  { skip: process.platform !== 'darwin' || !binary || !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT
    ? 'Requires actual macOS Vision, explicit helper, locked WFD and isolated runtime.' : false, timeout: 240000 }, async () => {
    const fixture = createFullChainFixture({ name: 'ocr-claim-live', machine: true, units: { text: { dimension: 'text' } } });
    const bindingPath = join(fixture.runtime, 'config/machine.bindings.json'), bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
    bindings.resources.vision_ocr = { path: realpathSync(binary!), kind: 'program', sha256: wfdSha256(readFileSync(binary!)) };
    writeFileSync(bindingPath, JSON.stringify(bindings));
    const path = join(fixture.root, 'synthetic-claim.png'), canvas = createCanvas(1000, 240), ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 240); ctx.fillStyle = 'black'; ctx.font = '52px Arial';
    ctx.fillText('SYNTHETIC CLAIM ONLY', 40, 110);
    const bytes = canvas.toBuffer('image/png'); writeFileSync(path, bytes);
    let host = await open(fixture);
    try {
      assert.ok(host.companion.r1Runtime, host.companion.r1Configuration?.reason ?? 'WFD unavailable');
      const conversationId = host.core.defaultConversationId;
      const ref = host.services.files.register({ path, source: 'user-attached', conversationId });
      host.services.permissions.grant({ label: 'isolated synthetic image only', scope: { kind: 'persistent' }, capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
      const inputReceipt = host.core.sendMessage(conversationId, 'Synthetic test: recognize this self-drawn image; no factual verification.', 'synthetic-claim-input',
        { attachmentRefs: [{ fileRefId: ref.id, version: ref.version, category: 'unclassified' }] });
      const input = await host.backend.waitForInput(inputReceipt.commandId);
      const read = await invoke(host, input, 'material.read', { fileRefId: ref.id }, 'claim-read');
      const materialId = String((read.result!.data as any).materialId);
      const ocr = await invoke(host, input, 'material.ocr', { fileRefId: ref.id, materialId }, 'claim-ocr');
      const packet = await readOcrReviewPacket(host.services, materialId, ocr.id);
      assert.match(packet.observations[0]!.text, /SYNTHETIC/u);
      assert.equal(packet.eventEligibility, 'not_established');
      const p = await prepareSyntheticOcrClaim(host.base, host.companion, packet);
      const prepared = await p.call('/r1/prepare', p.input, 201);
      assert.throws(() => host.companion.r1Workspace!.prepare({ ...p.input, requestId: 'sync-not-allowed' }));
      // Synthetic HTTP test operator, not the owner's approval or an ask_user/model answer.
      await p.call('/r1/requests/synthetic-ocr-publish/submit', { confirmed: true }, 409);
      await p.call('/r1/requests/synthetic-ocr-publish/submit', { confirmationDigest: '0'.repeat(64) }, 409);
      const original = host.companion.materials!.readOriginal(materialId);
      host.companion.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('synthetic corrupt original'), materialId);
      try {
        const accepted = await p.call('/r1/requests/synthetic-ocr-publish/submit', { confirmationDigest: prepared.documentSha256 });
        const task = await p.settled(accepted.jobId); assert.equal(task.status, 'failed');
        assert.equal(host.companion.database.connection.prepare('SELECT count(*) AS n FROM task_effects WHERE attempt_id=?').get(task.currentAttemptId)!.n, 0);
        assert.equal((await p.call('/r1/products/snapshot', {}, 200)).snapshotId, null);
      } finally { host.companion.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(original.bytes, materialId); }
      const validInput = { ...p.input, requestId: 'ocr-claim-accepted' };
      const valid = await p.call('/r1/prepare', validInput, 201);
      const send = await p.call('/r1/requests/ocr-claim-accepted/submit', { confirmationDigest: valid.documentSha256 });
      const done = await p.settled(send.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      assert.equal((await p.call('/r1/requests/ocr-claim-accepted/submit', { confirmationDigest: valid.documentSha256 })).jobId, send.jobId);
      const view = await p.call('/r1/requests/ocr-claim-accepted'); assert.equal(view.state, 'associated');
      const association = view.local.associations[0];
      const fixed = (await host.companion.r1Runtime!.client.fixedRead(association.snapshot_id, association.product_id)).result;
      const row = (fixed.rows as any[])[0].row;
      assert.equal(row.content_nature, 'source_claim'); assert.equal(row.status, 'unknown');
      assert.equal(row.values.statement.value, packet.observations[0]!.text);
      assert.equal(row.values.source_sha256.value, wfdSha256(bytes));
      assert.equal(row.values.text_basis.value, 'ocr_recognition');
      assert.equal(row.values.human_verification.value, 'unknown'); assert.equal(row.values.fact_verification.value, 'unknown');
      assert.equal(row.event_time.status, 'unknown'); assert.equal(row.public_time.status, 'unknown');
      await p.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id,
        historyMode: 'market_known_at', at: '2026-12-01T00:00:00Z' }, 409);
      assert.equal(wfdSha256(host.companion.materials!.readOriginal(materialId).bytes), wfdSha256(bytes));
      const count = host.companion.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = await open(fixture);
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocr.id), packet);
      assert.deepEqual((await host.companion.r1Runtime!.client.fixedRead(association.snapshot_id, association.product_id)).result, fixed);
      assert.deepEqual(host.companion.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
    } finally { await host.close(); }
  });

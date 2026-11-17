import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from './app.js';
import { createCanvas } from '@napi-rs/canvas';
import type { Backend, BackendCheckpoint, BackendEvent, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createApplicationServices } from './services.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { readOcrReviewPacket } from './ocr-review.js';

const binary = process.env.XUAN_TEST_VISION_OCR;
const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const model = { provider: 'synthetic-receiver', model: 'no-network-model', baseUrl: 'https://model.invalid.test/v1' };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, provider: model.provider, model: model.model, notice: 'Synthetic transport only; actual local Vision OCR.' };
const unusedPiContext = {} as Parameters<ToolDefinition['execute']>[4];
// Transport double only: Core consumes the real attachment/user input, and its
// real model tool gateway creates origins. No task/call/link success rows are fabricated.
class CapturingBackend implements Backend {
  readonly id = 'r1-conversation-no-model';
  private readonly inputs = new Map<string, BackendInput>();
  private readonly waiting = new Map<string, (input: BackendInput) => void>();
  private capture(input: BackendInput): void {
    this.inputs.set(input.inputId, input);
    this.waiting.get(input.inputId)?.(input); this.waiting.delete(input.inputId);
  }
  async createSession(): Promise<BackendSession> {
    const checkpoint: BackendCheckpoint = { backendId: this.id, format: 'synthetic-capture', version: 1,
      sessionRef: 'capture-only', payload: null };
    let finish: () => void = () => {}, current: BackendInput | undefined;
    let emitCurrent: ((event: BackendEvent) => Promise<void>) | undefined;
    return { id: 'capture-only', send: async (input, emit) => {
      const gate = new Promise<void>(resolve => { finish = resolve; });
      current = input; emitCurrent = emit;
      await emit({ type: 'run_started' });
      await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      this.capture(input);
      await gate;
      return { outcome: 'interrupted', rawStopReason: 'fixture-closed', checkpoint };
    }, steer: async input => {
      assert.ok(emitCurrent && current, 'Only Core-dispatched steering inputs can be captured.');
      const messageKey = 'capture-assistant-' + current.inputId;
      await emitCurrent({ type: 'message_started', messageKey, role: 'assistant' });
      await emitCurrent({ type: 'message_finalized', messageKey, role: 'assistant',
        text: 'Synthetic transport boundary only; no model inference.', rawStopReason: 'fixture-boundary' });
      await emitCurrent({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      current = input; this.capture(input); return { disposition: 'handled' };
    }, exportCheckpoint: async () => checkpoint,
    abort: async () => { finish(); }, dispose: () => { finish(); } };
  }
  waitForInput(inputId: string): Promise<BackendInput> {
    const input = this.inputs.get(inputId);
    if (input) return Promise.resolve(input);
    return new Promise(resolve => { this.waiting.set(inputId, resolve); });
  }
}

async function open(f: ReturnType<typeof createFullChainFixture>) {
  const resources = new ResourceBindings(f.runtime);
  const companionDatabase = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(new CapturingBackend(), { database: companionDatabase });
  const companion = createApplicationServices(companionCore, companionDatabase, { role: 'service', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources,
    materials: { environment: 'synthetic-test' } });
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const backend = new CapturingBackend(), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/personal-private'), resources,
    processRuntime: new ProcessRuntime(resources), workspaceServices: companion, modelConfigurationVersion: 'synthetic-receiver-v1' });
  services.permissions.grant({ label: 'isolated generated OCR artifacts', scope: { kind: 'persistent' },
    capabilities: ['read', 'write', 'delete'].map(action => ({ action: action as 'read' | 'write' | 'delete', target: { kind: 'directory' as const, path: services.artifactRoot, recursive: true } })) });
  services.permissions.grant({ label: 'explicit compiled local OCR helper', scope: { kind: 'persistent' },
    capabilities: [{ action: 'execute', target: { kind: 'file', path: realpathSync(binary!) } }] });
  const server = createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return { base, database, companionDatabase, backend, core, services, companion,
    async close() { if (closed) return; closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await services.tasks.dispose(); await core.dispose(); database.close();
      await companion.tasks.dispose(); await companionCore.dispose(); companionDatabase.close();
    } };
}
type Host = Awaited<ReturnType<typeof open>>;
async function invoke(h: Host, input: BackendInput, action: string, args: Record<string, unknown>, toolCallId: string) {
  const perform = h.services.modelTools.toolFactory({ model, getCurrentInput: () => input }).find(tool => tool.name === 'perform_action');
  assert.ok(perform);
  try { await perform.execute(toolCallId, { action, args }, undefined, undefined, unusedPiContext); }
  catch (error) {
    const tasks = h.services.tasks.list();
    throw new Error(`${String(error)}; actual task failures: ${JSON.stringify(tasks.map(t => ({ action: t.action, status: t.status, error: t.error })))}`);
  }
  const row = h.database.connection.prepare('SELECT task_id FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?').get(input.runId, input.generation, toolCallId);
  assert.ok(row?.task_id);
  const task = h.services.tasks.get(String(row.task_id)); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  return task;
}

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
      const before = count();
      await assert.rejects(readOcrReviewPacket(host.services, 'wrong-material', ocrTask.id));
      await assert.rejects(readOcrReviewPacket(host.services, materialId, readTask.id));
      assert.deepEqual(count(), before);
      await host.close(); host = await open(fixture);
      assert.equal(host.services.tasks.get(ocrTask.id).status, 'succeeded');
      assert.deepEqual(await readOcrReviewPacket(host.services, materialId, ocrTask.id), packet);
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

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from './app.js';
import type { Backend, BackendCheckpoint, BackendEvent, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApplicationServices } from './services.js';
import type { createFullChainFixture } from './full-chain-test-support.js';
const binary = process.env.XUAN_TEST_VISION_OCR;
const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
export const model = { provider: 'synthetic-receiver', model: 'no-network-model', baseUrl: 'https://model.invalid.test/v1' };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, provider: model.provider, model: model.model, notice: 'Synthetic transport only; actual local media recognizers.' };
export const unusedPiContext = {} as Parameters<ToolDefinition['execute']>[4];
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

export async function openMediaReviewHost(f: ReturnType<typeof createFullChainFixture>) {
  const resources = new ResourceBindings(f.runtime);
  const companionDatabase = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(new CapturingBackend(), { database: companionDatabase });
  const companion = createApplicationServices(companionCore, companionDatabase, { role: 'service', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources,
    materials: { environment: 'synthetic-test' }, whisperModelPath: f.modelPath });
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const backend = new CapturingBackend(), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/personal-private'), resources,
    processRuntime: new ProcessRuntime(resources), whisperModelPath: f.modelPath, workspaceServices: companion, modelConfigurationVersion: 'synthetic-receiver-v1' });
  services.permissions.grant({ label: 'isolated generated OCR artifacts', scope: { kind: 'persistent' },
    capabilities: ['read', 'write', 'delete'].map(action => ({ action: action as 'read' | 'write' | 'delete', target: { kind: 'directory' as const, path: services.artifactRoot, recursive: true } })) });
  if (binary) services.permissions.grant({ label: 'explicit compiled local OCR helper', scope: { kind: 'persistent' },
    capabilities: [{ action: 'execute', target: { kind: 'file', path: realpathSync(binary!) } }] });
  if (f.bundledTranscription) {
    assert.ok(f.modelPath);
    services.permissions.grant({ label: 'explicit isolated local transcription components', scope: { kind: 'persistent' },
      capabilities: [{ action: 'read', target: { kind: 'file', path: f.modelPath } },
        ...(['ffmpeg', 'ffprobe', 'whisper_cli'] as const).map(key => ({ action: 'execute' as const, target: { kind: 'file' as const, path: resources.path(key) } }))] });
  }
  const server = createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return { base, database, companionDatabase, backend, core, services, companion,
    async close() { if (closed) return; closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      services.segments?.close(); services.files.closeTemporaryRetention(); services.options.processRuntime?.closeTemporaryRetention();
      companion.segments?.close(); companion.files.closeTemporaryRetention(); companion.options.processRuntime?.closeTemporaryRetention();
      await services.tasks.dispose(); await core.dispose(); database.close();
      await companion.tasks.dispose(); await companionCore.dispose(); companionDatabase.close();
    } };
}
type Host = Awaited<ReturnType<typeof openMediaReviewHost>>;
export async function invokeMediaAction(h: Host, input: BackendInput, action: string, args: Record<string, unknown>, toolCallId: string) {
  const perform = h.services.modelTools.toolFactory({ model, getCurrentInput: () => input }).find(tool => tool.name === 'perform_action');
  assert.ok(perform);
  try { await perform.execute(toolCallId, { action, args }, undefined, undefined, unusedPiContext); }
  catch (error) {
    const tasks = h.services.tasks.list();
    throw new Error(`${String(error)}; actual task failures: ${JSON.stringify(tasks.map(t => ({ action: t.action, status: t.status, error: t.error, budget: h.services.tasks.getBudget(t.id), events: h.services.tasks.events(t.id).filter(e => ['PROGRESS', 'WORKER_STATE', 'SIDE_EFFECT_RESULT'].includes(e.type)).map(e => ({ type: e.type, timestamp: e.timestamp, ...(e.type === 'PROGRESS' && (e.data as any).data?.basis === 'whisper_native_progress' ? { nativePercent: (e.data as any).data.percent } : {}) })) })))}`);
  }
  const row = h.database.connection.prepare('SELECT task_id FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?').get(input.runId, input.generation, toolCallId);
  assert.ok(row?.task_id);
  const task = h.services.tasks.get(String(row.task_id)); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  return task;
}

import { createHash } from 'node:crypto';
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
import { createApplicationServices, type ServiceOptions } from './services.js';
import { settleFixtureTask, type createFullChainFixture } from './full-chain-test-support.js';
import type { TranscriptionClaimSelection } from '../../modules/collection/data-processing/ocr-claim.js';
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

export function openMediaReviewCompanion(f: ReturnType<typeof createFullChainFixture>, options: Pick<ServiceOptions, 'baiduDrive' | 'localData'> = {}) {
  const resources = new ResourceBindings(f.runtime);
  const companionDatabase = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(new CapturingBackend(), { database: companionDatabase });
  const companion = createApplicationServices(companionCore, companionDatabase, { role: 'service', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources,
    materials: { environment: 'synthetic-test' }, whisperModelPath: f.modelPath, r1ConnectionId: f.machine ? 'full-chain-test' : undefined,
    processRuntime: options.baiduDrive ? new ProcessRuntime(resources) : undefined, ...options });
  return { resources, companionDatabase, companion, async close() {
    companion.segments?.close(); companion.files.closeTemporaryRetention(); companion.options.processRuntime?.closeTemporaryRetention();
    await companion.tasks.dispose(); await companionCore.dispose(); companionDatabase.close();
  } };
}

export async function openMediaReviewHost(f: ReturnType<typeof createFullChainFixture>, listen = true, localData?: ServiceOptions['localData']) {
  const serviceHost = openMediaReviewCompanion(f, { localData }), { resources, companionDatabase, companion } = serviceHost;
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const backend = new CapturingBackend(), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/personal-private'), resources,
    processRuntime: new ProcessRuntime(resources), whisperModelPath: f.modelPath, workspaceServices: companion, localData, modelConfigurationVersion: 'synthetic-receiver-v1' });
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
  const server = listen ? createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1') : null;
  let base = '';
  if (server) {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  }
  let closed = false;
  return { base, database, companionDatabase, backend, core, services, companion,
    async close() { if (closed) return; closed = true;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      services.segments?.close(); services.files.closeTemporaryRetention(); services.options.processRuntime?.closeTemporaryRetention();
      await services.tasks.dispose(); await core.dispose(); database.close();
      await serviceHost.close();
    } };
}
export async function prepareTranscriptionParse(services: ReturnType<typeof createApplicationServices>, materialId: string,
  selection: TranscriptionClaimSelection) {
  const processing = services.processing!;
  const operator = { operatorId: 'synthetic', requestId: 'plan-' + materialId, method: 'POST', path: '/processing/plans',
    remoteAddress: null, observedAt: Date.now() };
  const task = processing.preparePlan({ routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
    outputs: [{ outputId: 'claim', materialIds: [materialId], intendedAction: 'inspect', stages: ['parse'],
      tables: [{ materialId, format: 'transcription-review', transcriptionClaimSelection: selection }] }] }, operator);
  const prepared = await settleFixtureTask(services.tasks, task.id);
  assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared.error));
  const plan = processing.getByTask(task.id)!.plan!, step = plan.steps.find(item => item.kind === 'parse');
  assert.ok(step);
  return { plan, step, operator };
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

/** Corrupt only already-custodied fixture bytes after a real artifact read has yielded.
 * No task, recognizer result, source link or successful receipt is fabricated. */
export async function assertLateMediaOriginalRejected(services: ReturnType<typeof createApplicationServices>, materialId: string,
  textRef: string, read: () => Promise<unknown>) {
  const baseline = await read();
  const companion = services.options.workspaceServices!, original = companion.materials!.readOriginal(materialId);
  const link = services.database.connection.prepare('SELECT * FROM conversation_material_links WHERE material_id=?').get(materialId)!;
  const custody = companion.tasks.get(String(link.service_task_id));
  const file = services.database.connection.prepare('SELECT metadata,version FROM file_references WHERE id=?').get(link.file_ref_id)!;
  const record = companion.database.connection.prepare('SELECT envelope_json,envelope_digest FROM material_object_records WHERE material_id=?').get(materialId)!;
  const verify = services.files.verify.bind(services.files), assertPath = services.direct.assertPublicPath.bind(services.direct);
  const sourcePath = services.files.verify(String(link.file_ref_id)).invocationPath;
  const cases = ['bytes', 'custody', 'file-version', 'material', 'source-path-denied'] as const;
  for (const fault of cases) {
    let checks = 0, injected = false;
    services.files.verify = id => {
      const ref = verify(id);
      // artifact(), readArtifactForDownload(), initial verify(), then pinned read after await root/open.
      if (id === textRef && ++checks === 4) {
        if (fault === 'bytes') companion.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?')
          .run(Buffer.from('isolated late original corruption'), materialId);
        if (fault === 'custody') companion.database.connection.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(custody.id);
        if (fault === 'file-version') {
          const metadata = JSON.parse(String(file.metadata)); metadata.version++;
          services.database.connection.prepare('UPDATE file_references SET metadata=?,version=version+1 WHERE id=?').run(JSON.stringify(metadata), link.file_ref_id);
        }
        if (fault === 'material') {
          const envelope = JSON.parse(String(record.envelope_json)); envelope.filename = 'changed-fixture-name';
          const json = JSON.stringify(envelope);
          companion.database.connection.prepare('UPDATE material_object_records SET envelope_json=?,envelope_digest=? WHERE material_id=?')
            .run(json, createHash('sha256').update(json).digest('hex'), materialId);
        }
        injected = true;
      }
      return ref;
    };
    // Explicit host-path gate fault, not a claim of user revocation or changed account permissions.
    services.direct.assertPublicPath = (path, allowMissing) => {
      if (injected && fault === 'source-path-denied' && path === sourcePath) throw new Error('ISOLATED_SOURCE_PATH_DENIED');
      return assertPath(path, allowMissing);
    };
    try { await assert.rejects(read(), `Late media source ${fault} must reject the packet`); }
    finally {
      services.files.verify = verify; services.direct.assertPublicPath = assertPath;
      companion.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(original.bytes, materialId);
      companion.database.connection.prepare('UPDATE tasks SET version=? WHERE id=?').run(custody.version, custody.id);
      services.database.connection.prepare('UPDATE file_references SET metadata=?,version=? WHERE id=?').run(file.metadata, file.version, link.file_ref_id);
      companion.database.connection.prepare('UPDATE material_object_records SET envelope_json=?,envelope_digest=? WHERE material_id=?')
        .run(record.envelope_json, record.envelope_digest, materialId);
    }
    assert.ok(injected, 'The real pinned artifact read must reach the injected post-await check');
    assert.deepEqual(await read(), baseline, `Restored ${fault} fixture must return the original packet`);
  }
}

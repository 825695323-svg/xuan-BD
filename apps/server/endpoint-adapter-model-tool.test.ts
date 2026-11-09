import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Backend, BackendCheckpoint, BackendEvent, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { ConversationAttachmentRef, HealthResponse } from '../../contracts/contracts.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createApplicationServices } from '../../apps/server/services.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { acceptWorkspaceMaterial } from '../../modules/collection/accept-material.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import type { EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';

/**
 * 真实受控模型工具路径：个人 Core + 真实会话/分支/父运行 + CoreModelTools.perform_action
 * → 真实 TaskService 审批（approve/deny/cancel）→ 真实适配登记采用。
 * 传输层只替模型收发（CapturingBackend），不替权限、任务、会话或材料保管；不调用外部模型。
 */
const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, provider: 'fixture-receiver',
  model: 'fixture-no-provider', notice: 'Synthetic transport only; no model or network calls.' };
const model = Object.freeze({ provider: 'fixture-receiver', model: 'fixture-no-provider', baseUrl: 'https://model.invalid.test/v1' });
const unusedPiContext = Object.freeze({}) as Parameters<ToolDefinition['execute']>[4];
const GOOD = Buffer.from(JSON.stringify([{ day: '2026-04-13', qty: '1.25' }]), 'utf8');
const BAD = Buffer.from(JSON.stringify([{ day: '2026-04-13' }]), 'utf8');
const config: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'test.model.tool', version: '1',
  match: { endpoint: 'https://example.test/kline', protocol: 'json/v1', frequency: 'day', adjustment: 'none' },
  carrier: { kind: 'json', charset: 'utf-8' },
  response: { success: null, container: { path: '$', kind: 'array' } },
  fields: [{ name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'qty', source: { kind: 'key', key: 'qty' }, type: 'decimal',
      unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送；1 手 = 100 股为本次声明规则，未与第二来源对齐。' } }],
  evidence: { sourceId: 'synthetic', provider: '合成等价样本', coverage: '单日单标的', basis: '仅用于受控工具链的合成响应。' } };

class CapturingBackend implements Backend {
  readonly id = 'adapter-model-tool-no-model';
  private readonly inputs = new Map<string, BackendInput>();
  private readonly waiting = new Map<string, (input: BackendInput) => void>();
  private capture(input: BackendInput): void {
    this.inputs.set(input.inputId, input);
    this.waiting.get(input.inputId)?.(input); this.waiting.delete(input.inputId);
  }
  async createSession(): Promise<BackendSession> {
    const checkpoint: BackendCheckpoint = { backendId: this.id, format: 'synthetic-capture', version: 1, sessionRef: 'capture-only', payload: null };
    let finish: () => void = () => {};
    return { id: 'capture-only', send: async (input, emit) => {
      const gate = new Promise<void>(resolve => { finish = resolve; });
      await emit({ type: 'run_started' });
      await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      this.capture(input);
      await gate;
      return { outcome: 'interrupted', rawStopReason: 'fixture-closed', checkpoint };
    }, steer: async () => ({ disposition: 'handled' }), exportCheckpoint: async () => checkpoint,
    abort: async () => { finish(); }, dispose: () => { finish(); } };
  }
  waitForInput(inputId: string): Promise<BackendInput> {
    const input = this.inputs.get(inputId);
    if (input) return Promise.resolve(input);
    return new Promise(resolve => { this.waiting.set(inputId, resolve); });
  }
}

function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }

function fixture() { return createFullChainFixture({ name: 'adapter-model-tool' }); }

async function host(f: ReturnType<typeof fixture>) {
  const companionDatabase = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(new CapturingBackend(), { database: companionDatabase });
  const companion = createApplicationServices(companionCore, companionDatabase, { role: 'service', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/companion-private'),
    resources: new ResourceBindings(f.runtime), materials: { environment: 'synthetic-test' } });
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const backend = new CapturingBackend(), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/personal-private'),
    resources: new ResourceBindings(f.runtime), workspaceServices: companion, modelConfigurationVersion: 'fixture-receiver-v1' });
  let closed = false;
  return { root: f.root, companionDatabase, companionCore, companion, database, backend, core, services,
    async close() {
      if (closed) return; closed = true;
      await services.tasks.dispose(); await core.dispose(); database.close();
      await companion.tasks.dispose(); await companionCore.dispose(); companionDatabase.close();
    } };
}
type Host = Awaited<ReturnType<typeof host>>;

function performFor(h: Host, input: BackendInput) {
  const tools = h.services.modelTools.toolFactory({ model, getCurrentInput: () => input });
  const perform = tools.find(tool => tool.name === 'perform_action'); assert.ok(perform);
  return perform;
}
function taskFor(h: Host, input: BackendInput, toolCallId: string): TaskRecord | null {
  const row = h.database.connection.prepare('SELECT task_id FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?')
    .get(input.runId, input.generation, toolCallId);
  return row?.task_id ? h.services.tasks.get(String(row.task_id)) : null;
}
async function waitTask(h: Host, input: BackendInput, toolCallId: string, predicate: (task: TaskRecord) => boolean) {
  for (let tries = 0; tries < 1200; tries++) {
    const task = taskFor(h, input, toolCallId);
    if (task && predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('任务未达到预期状态：' + JSON.stringify(taskFor(h, input, toolCallId)));
}
async function startInput(h: Host, text: string, requestId: string,
  options: { conversationId?: string; attachmentRefs?: ConversationAttachmentRef[] } = {}) {
  const conversationId = options.conversationId ?? h.core.defaultConversationId;
  const accepted = h.core.sendMessage(conversationId, text, requestId, { attachmentRefs: options.attachmentRefs });
  const input = await h.backend.waitForInput(accepted.commandId);
  assert.equal(h.core.isRunActive(input.runId, input.generation), true);
  return input;
}
function attach(h: Host, path: string, conversationId: string, bytes: Buffer): ConversationAttachmentRef {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const reference = h.services.files.register({ path, source: 'user-attached', conversationId });
  h.services.permissions.grant({ label: 'Fixture synthetic adapter sample', scope: { kind: 'persistent' },
    capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
  return { fileRefId: reference.id, version: reference.version, category: 'data' };
}
/** 自动动作（如 material.read）直接执行；不触发审批。 */
async function invoke(h: Host, input: BackendInput, action: string, args: Record<string, unknown>, toolCallId: string) {
  const perform = performFor(h, input);
  return preview(await perform.execute(toolCallId, { action, args }, undefined, undefined, unusedPiContext));
}
/** 真实受控工具调用：先不 await，等真实任务 waiting_approval，再由隔离 API 批准/拒绝/取消。 */
async function callWithDecision(h: Host, input: BackendInput, action: string, args: Record<string, unknown>,
  decision: 'approve' | 'deny' | 'cancel', toolCallId: string) {
  const perform = performFor(h, input);
  const pending = perform.execute(toolCallId, { action, args }, undefined, undefined, unusedPiContext);
  pending.catch(() => {});
  const waiting = await waitTask(h, input, toolCallId, task => task.status === 'waiting_approval');
  assert.ok(waiting.approvalId, JSON.stringify(waiting));
  if (decision === 'approve') h.services.tasks.approve(waiting.approvalId);
  else if (decision === 'deny') h.services.tasks.deny(waiting.approvalId);
  else await h.services.tasks.cancel(waiting.id);
  return { pending, taskId: waiting.id, approvalId: waiting.approvalId };
}
function preview(result: { content: readonly { type: string; text?: string }[] }): Record<string, any> {
  return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''));
}

test('受控模型工具：真实会话分支 perform_action → 任务审批 → 适配候选/重放/采用，拒绝取消不写', { skip:
  !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT（隔离测试根）', timeout: 300_000 }, async () => {
  const f = fixture();
  const h = await host(f);
  try {
    const conversationId = h.core.defaultConversationId;
    const goodAttachment = attach(h, join(h.root, 'adapter-good.json'), conversationId, GOOD);
    const badAttachment = attach(h, join(h.root, 'adapter-bad.json'), conversationId, BAD);
    const input = await startInput(h, '请按已附的隔离合成响应处理端点适配；采用须经本机审批。', 'adapter-model-user',
      { attachmentRefs: [goodAttachment, badAttachment] });
    // 真实材料保管与分支链接（material.read 经同一受控工具）。
    const goodMaterial = String((await invoke(h, input, 'material.read', { fileRefId: goodAttachment.fileRefId }, 'adapter-read-good')).data.materialId);
    const badMaterial = String((await invoke(h, input, 'material.read', { fileRefId: badAttachment.fileRefId }, 'adapter-read-bad')).data.materialId);

    // 候选：批准后登记，未采用。
    const propose = await callWithDecision(h, input, 'data.adapters.propose', { configJson: JSON.stringify(config) }, 'approve', 'adapter-propose');
    const proposed = preview(await propose.pending);
    assert.equal(proposed.data.status, 'candidate');
    // 重放：批准后实际五步重放。
    const replay = await callWithDecision(h, input, 'data.adapters.replay', { adapterId: config.adapterId, version: '1',
      samplesJson: JSON.stringify([{ materialId: goodMaterial, expectation: 'accept', expect: { values: { qty: '125' } } },
        { materialId: badMaterial, expectation: 'reject' }]) }, 'approve', 'adapter-replay');
    const replayView = preview(await replay.pending).data;
    assert.equal(replayView.passed, true);
    const digest = h.companion.endpointAdapters!.list(config.adapterId)[0]!.configDigest as string;
    const adoptArgs = { adapterId: config.adapterId, version: '1', configDigest: digest,
      evidenceDigest: replayView.evidenceDigest, confirmationDigest: replayView.evidenceDigest };

    // 异常过滤：真实 recordDrift 写入当前材料与一个外部分支材料，capabilities 只返回当前项。
    h.companion.endpointAdapters!.recordDrift({ adapterId: config.adapterId, version: '1', configDigest: digest,
      materialId: goodMaterial, code: 'SYNTHETIC_CURRENT_DRIFT', message: '当前分支合成漂移', detail: { source: 'synthetic-current' } });
    h.companion.endpointAdapters!.recordDrift({ adapterId: config.adapterId, version: '1', configDigest: digest,
      materialId: 'external-branch-material-id', code: 'SYNTHETIC_EXTERNAL_DRIFT', message: '外部分支异常内容', detail: { source: 'synthetic-external' } });
    const capabilities = await invoke(h, input, 'data.adapters.capabilities', {}, 'adapter-capabilities');
    const exceptionItems = (capabilities.data.exceptions as { items: { materialId: string; code: string }[]; hidden: number });
    assert.ok(exceptionItems.items.some(item => item.materialId === goodMaterial && item.code === 'SYNTHETIC_CURRENT_DRIFT'));
    assert.equal(JSON.stringify(capabilities).includes('external-branch-material-id'), false);
    assert.equal(JSON.stringify(capabilities).includes('外部分支异常内容'), false);
    assert.ok(exceptionItems.hidden >= 1);

    // 拒绝：任务失败，登记仍为 candidate。
    const denied = await callWithDecision(h, input, 'data.adapters.adopt', adoptArgs, 'deny', 'adapter-adopt-deny');
    await assert.rejects(denied.pending, (error: unknown) => error instanceof Error);
    assert.equal(h.companion.endpointAdapters!.list(config.adapterId)[0]!.status, 'candidate');
    // 取消：任务取消，登记仍为 candidate。
    const cancelled = await callWithDecision(h, input, 'data.adapters.adopt', adoptArgs, 'cancel', 'adapter-adopt-cancel');
    await assert.rejects(cancelled.pending, (error: unknown) => error instanceof Error);
    assert.equal(h.companion.endpointAdapters!.list(config.adapterId)[0]!.status, 'candidate');
    // 单次批准：采用成功；同一审批回执不能二次批准。
    const approved = await callWithDecision(h, input, 'data.adapters.adopt', adoptArgs, 'approve', 'adapter-adopt-approve');
    const adoptedView = preview(await approved.pending);
    assert.equal(adoptedView.data.status, 'adopted');
    assert.equal(h.companion.endpointAdapters!.list(config.adapterId)[0]!.status, 'adopted');
    assert.throws(() => h.services.tasks.approve(approved.approvalId), (error: unknown) => error instanceof Error);
    // 采用任务只发起一次审批请求、只有一次批准记录。
    const requested = h.database.connection.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND type='APPROVAL_REQUESTED'")
      .get(approved.taskId)!.n;
    assert.equal(Number(requested), 1);
    const approvals = h.database.connection.prepare('SELECT status FROM permission_approvals WHERE id=?').get(approved.approvalId) as { status?: string };
    assert.equal(approvals?.status, 'approved');

    // 跨分支：不经本分支 material.read 的受管材料不能在本分支重放（批准也失败）。
    const foreignTaskId = await acceptWorkspaceMaterial(h.companion, { bytes: GOOD, name: 'adapter-foreign.json',
      category: 'data', requestId: 'adapter-foreign-intake' });
    const foreignTask = await h.companion.tasks.wait(foreignTaskId);
    assert.equal(foreignTask.status, 'succeeded', JSON.stringify(foreignTask.error));
    const foreignMaterial = h.companion.materials!.getByTask(foreignTask.id)!.envelope.materialId;
    const foreignReplay = await callWithDecision(h, input, 'data.adapters.replay', { adapterId: config.adapterId, version: '1',
      samplesJson: JSON.stringify([{ materialId: foreignMaterial, expectation: 'accept' }]) }, 'approve', 'adapter-replay-foreign');
    await assert.rejects(foreignReplay.pending, (error: unknown) => error instanceof Error);
    assert.match(String(taskFor(h, input, 'adapter-replay-foreign')?.error?.code), /MATERIAL|PROCESSING_ORIGIN/u);

    // 同会话另一分支：旧分支材料不能在新分支重放（真实 createBranch + sendMessage）。
    await h.core.abort(input.runId, input.conversationId);
    const beforeBranch = h.core.getState(input.conversationId);
    const branched = h.core.createBranch(input.conversationId, beforeBranch.treeRevision);
    assert.notEqual(branched.branchId, input.branchId);
    const branchInput = await startInput(h, '同会话另一分支，仅做隔离核对。', 'adapter-branch-user',
      { conversationId: input.conversationId });
    // 旧分支真实存在的材料与其异常，在新分支查看时不得返回（同一会话不同 branchId 的隐私边界）。
    const branchCapabilities = await invoke(h, branchInput, 'data.adapters.capabilities', {}, 'adapter-branch-capabilities');
    assert.equal(JSON.stringify(branchCapabilities).includes(goodMaterial), false);
    assert.equal(JSON.stringify(branchCapabilities).includes('SYNTHETIC_CURRENT_DRIFT'), false);
    assert.equal(JSON.stringify(branchCapabilities).includes('当前分支合成漂移'), false);
    const branchReplay = await callWithDecision(h, branchInput, 'data.adapters.replay', { adapterId: config.adapterId, version: '1',
      samplesJson: JSON.stringify([{ materialId: goodMaterial, expectation: 'accept' }]) }, 'approve', 'adapter-replay-branch');
    await assert.rejects(branchReplay.pending, (error: unknown) => error instanceof Error);
    assert.match(String(taskFor(h, branchInput, 'adapter-replay-branch')?.error?.code), /MATERIAL|PROCESSING_ORIGIN/u);

    // 磁盘重开：采用状态与摘要按原身份读回。
    await h.close();
    const reopened = await host(f);
    try {
      const row = reopened.companion.endpointAdapters!.list(config.adapterId)[0]!;
      assert.equal(row.status, 'adopted');
      assert.equal(row.configDigest, digest);
    } finally { await reopened.close(); }
  } finally { await h.close().catch(() => {}); }
});

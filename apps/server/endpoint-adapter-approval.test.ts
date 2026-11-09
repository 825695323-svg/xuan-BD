import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PersonalCore } from '../../modules/agent/runtime/core.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService, type TaskExecutionContext, type TaskRuntime } from '../../platform/jobs/tasks.js';
import { ConversationProcessingBridge } from '../../modules/collection/conversation-processing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import type { EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';

/**
 * 适配采用的真实控制面：真实 TaskService + 真实 PermissionService，
 * 任务进入 waiting_approval → 拒绝不写 / 单次批准后采用 → 重复批准被拒 → 关库重开读回。
 * 外部模型不参与；运行时只补"模型分享能力"这一层（与 model-tools.controlledContext 同义），不模拟授权结论。
 */
const config: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'test.approval', version: '1',
  match: { endpoint: 'https://example.test/kline', protocol: 'json/v1', frequency: 'day', adjustment: 'none' },
  carrier: { kind: 'json', charset: 'utf-8' },
  response: { success: null, container: { path: '$', kind: 'array' } },
  fields: [{ name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'qty', source: { kind: 'key', key: 'qty' }, type: 'decimal',
      unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送；1 手 = 100 股为本次声明规则，未与第二来源对齐。' } }],
  evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于真实审批控制面的合成响应。' } };
const good = Buffer.from(JSON.stringify([{ day: '2026-04-13', qty: '1.25' }]), 'utf8');
const bad = Buffer.from(JSON.stringify([{ day: '2026-04-13' }]), 'utf8');

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string): Promise<T> {
  for (let tries = 0; tries < 600; tries++) {
    const value = read();
    if (done(value)) return value;
    await delay(25);
  }
  assert.fail('未达到预期状态：' + label + ' ' + JSON.stringify(read()));
}

test('适配采用经真实任务审批：waiting_approval→拒绝不写→单次批准→重开读回', { skip:
  !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT' }, async () => {
  const fixture = createFullChainFixture({ name: 'adapter-approval' });
  const host = await openFullChainHost(fixture);
  let tasks: TaskService | undefined, closed = false;
  try {
    const registry = host.services.endpointAdapters!;
    // 真实材料：两条上传，一正一反。
    const upload = async (name: string, bytes: Buffer, requestId: string) => {
      const accepted = await host.upload(name, 'data', bytes, requestId);
      const done = await host.settled(accepted.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      return host.services.materials!.getByTask(done.id)!.envelope.materialId;
    };
    const goodId = await upload('approval-good.json', good, 'approval-good');
    const badId = await upload('approval-bad.json', bad, 'approval-bad');
    await host.call('/processing/adapters/candidates', { requestId: 'approval-candidate', input: { config } }, 201);
    const replay = await host.call('/processing/adapters/test.approval/1/replay', { requestId: 'approval-replay',
      input: { adapterId: config.adapterId, version: '1', samples: [
        { materialId: goodId, expectation: 'accept', expect: { values: { qty: '125' } } },
        { materialId: badId, expectation: 'reject' }] } });
    assert.equal(replay.passed, true, JSON.stringify(replay.results));
    const digest = registry.list(config.adapterId)[0]!.configDigest as string;
    const adoptArgs = { adapterId: config.adapterId, version: '1', configDigest: digest,
      evidenceDigest: replay.evidenceDigest, confirmationDigest: replay.evidenceDigest };

    const bridge = new ConversationProcessingBridge({ database: host.database, core: host.core as PersonalCore,
      companion: host.services as unknown as WorkspaceServices,
      origin: () => ({ conversationId: 'c1', branchId: 'b1', messageId: 'm1' }) as never });
    // 会话分支材料链接（重放样本归属核对）。
    host.database.connection.prepare(`CREATE TABLE IF NOT EXISTS conversation_material_links(ref_id TEXT NOT NULL, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, material_id TEXT, origin_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(ref_id,kind))`).run();
    for (const id of [goodId, badId]) host.database.connection.prepare('INSERT INTO conversation_material_links VALUES(?,?,?,?,?,?)')
      .run(id, 't1', 'material', id, JSON.stringify({ conversationId: 'c1', branchId: 'b1' }), Date.now());

    const runtimes = new TaskRuntimeRegistry();
    const capability = { action: 'read' as const, target: { kind: 'directory' as const, path: host.services.artifactRoot, recursive: true } };
    const runtime: TaskRuntime = { id: 'adapter-approval-test', execute: async (context: TaskExecutionContext) => {
      // 只补模型分享能力层（同 model-tools.controlledContext），审批与授权结论仍由真实服务给出。
      const withShare = (operation: Record<string, unknown>) => ({ ...operation,
        targets: [...((operation.targets as unknown[] | undefined) ?? []), capability.target] });
      const wrapped = { ...context,
        assertAuthorized: (operation: never, capabilities: never, authorization?: { approvalId?: string }) =>
          context.assertAuthorized(withShare(operation as never) as never,
            [...(capabilities as unknown as unknown[]), capability] as never, authorization),
        requestApproval: (operation: never, capabilities: never, options?: { signal?: AbortSignal }) =>
          context.requestApproval(withShare(operation as never) as never,
            [...(capabilities as unknown as unknown[]), capability] as never, options) };
      return bridge.execute(wrapped as never, context.task.action, context.task.args as never);
    }, recover: async () => ({ outcome: 'not_applied', evidence: '审批测试没有外部副作用。', effects: [] }) };
    runtimes.register(runtime);
    let service!: TaskService;
    const permissions = new PermissionService({ database: host.database, isRunActive: (run, generation) => service.isRunActive(run, generation) });
    service = new TaskService({ database: host.database, runtimes, permissions, controlsAllTasks: true, isConversationActive: () => true });
    tasks = service;

    const startAdopt = (requestId: string) => {
      const created = service.create({ title: '适配采用', ownerRole: 'service', runtimeId: 'adapter-approval-test',
        action: 'data.adapters.adopt', args: adoptArgs, requestId, versions: {} });
      return created.status === 'ready' ? service.start(created.id, created.version) : created;
    };

    // 拒绝：任务停在 waiting_approval，拒绝后失败且登记仍为 candidate。
    const denied = startAdopt('approval-deny');
    const waitingDeny = await waitFor(() => service.get(denied.id), task => task.status === 'waiting_approval', 'deny waiting');
    assert.ok(waitingDeny.approvalId, JSON.stringify(waitingDeny));
    assert.equal(registry.list(config.adapterId)[0]!.status, 'candidate');
    service.deny(waitingDeny.approvalId!);
    const deniedDone = await service.wait(denied.id);
    assert.equal(deniedDone.status, 'failed', JSON.stringify(deniedDone.error));
    assert.equal(registry.list(config.adapterId)[0]!.status, 'candidate');

    // 单次批准：采用成功；再次批准同一回执被拒（不能二次使用）。
    const approved = startAdopt('approval-approve');
    const waitingApprove = await waitFor(() => service.get(approved.id), task => task.status === 'waiting_approval', 'approve waiting');
    service.approve(waitingApprove.approvalId!);
    const approvedDone = await service.wait(approved.id);
    assert.equal(approvedDone.status, 'succeeded', JSON.stringify(approvedDone.error));
    assert.equal(registry.list(config.adapterId)[0]!.status, 'adopted');
    assert.throws(() => service.approve(waitingApprove.approvalId!), (error: unknown) => error instanceof Error);

    // 取消：等待中的采用被取消后不写采用状态。
    const cancelled = startAdopt('approval-cancel');
    const waitingCancel = await waitFor(() => service.get(cancelled.id), task => task.status === 'waiting_approval', 'cancel waiting');
    assert.ok(waitingCancel.approvalId);
    await service.cancel(cancelled.id);
    const cancelledDone = await service.wait(cancelled.id);
    assert.equal(cancelledDone.status, 'cancelled', JSON.stringify(cancelledDone.error));
    assert.equal(registry.list(config.adapterId)[0]!.status, 'adopted');

    // 跨分支：未链接到本分支的材料不能重放（即使审批通过也失败）。
    const foreign = await upload('approval-foreign.json', good, 'approval-foreign');
    const replayTask = service.create({ title: '适配重放', ownerRole: 'service', runtimeId: 'adapter-approval-test',
      action: 'data.adapters.replay', args: { adapterId: config.adapterId, version: '1',
        samplesJson: JSON.stringify([{ materialId: foreign, expectation: 'accept' }]) }, requestId: 'approval-foreign-replay', versions: {} });
    if (replayTask.status === 'ready') service.start(replayTask.id, replayTask.version);
    const replayWaiting = await waitFor(() => service.get(replayTask.id), task => task.status === 'waiting_approval', 'replay waiting');
    service.approve(replayWaiting.approvalId!);
    const replayDone = await service.wait(replayTask.id);
    assert.equal(replayDone.status, 'failed', JSON.stringify(replayDone.error));
    assert.match(String(replayDone.error?.code), /MATERIAL|PROCESSING_ORIGIN/u);

    // 关库重开：采用状态与配置摘要按原身份读回。
    const adoptedDigest = registry.list(config.adapterId)[0]!.configDigest;
    await service.dispose(); tasks = undefined;
    await host.close(); closed = true;
    const reopened = await openFullChainHost(fixture);
    try {
      const row = reopened.services.endpointAdapters!.list(config.adapterId)[0]!;
      assert.equal(row.status, 'adopted');
      assert.equal(row.configDigest, adoptedDigest);
    } finally { await reopened.close(); }
  } finally {
    if (tasks) await tasks.dispose().catch(() => {});
    if (!closed) await host.close().catch(() => {});
  }
});

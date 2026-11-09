import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { MaterialService } from './materials/service.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import { ConversationProcessingBridge } from './conversation-processing.js';
import { EndpointAdapterRegistry } from './endpoint-adapter-registry.js';
import { isModelActionAllowed, modelActionApprovalMode } from '../agent/model-tools.js';
import type { OperatorContext } from './processing-plan.js';
import type { EndpointAdapterConfig } from './endpoint-adapter.js';

const sha = 'a'.repeat(64);
const config: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'test.conversation', version: '1',
  match: { endpoint: 'https://example.test/kline', protocol: 'json/v1', frequency: 'day', adjustment: 'none' },
  carrier: { kind: 'json', charset: 'utf-8' },
  response: { success: null, container: { path: '$', kind: 'array' } },
  fields: [{ name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'qty', source: { kind: 'key', key: 'qty' }, type: 'decimal',
      unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送；1 手 = 100 股为本次声明规则，未与第二来源对齐。' } }],
  evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于会话工具登记的合成响应。' } };
const hostOperator: OperatorContext = { operatorId: 'host.tester', requestId: 'host-request', method: 'POST',
  path: '/processing/adapters/candidates', remoteAddress: '127.0.0.1', observedAt: Date.now() };
const conversationOperator: OperatorContext = { operatorId: 'conversation:c1', requestId: 'conversation:t1', method: 'conversation',
  path: '/conversation/c1/b1', remoteAddress: null, observedAt: Date.now(), source: 'conversation',
  conversation: { conversationId: 'c1', branchId: 'b1' } };

test('适配工具登记在模型许可清单与会话桥，且采用保留审核', () => {
  for (const action of ['data.adapters.capabilities', 'data.adapters.propose', 'data.adapters.replay', 'data.adapters.adopt'])
    assert.equal(isModelActionAllowed(action), true, action);
  // 只读查看可自动；候选、重放、采用都必须经审核，不能进入自动动作集合。
  assert.equal(modelActionApprovalMode('data.adapters.capabilities', {}), 'automatic');
  for (const action of ['data.adapters.propose', 'data.adapters.replay', 'data.adapters.adopt'])
    assert.equal(modelActionApprovalMode(action, {}), 'review', action);

  const database = new CoreDatabase(':memory:');
  try {
    const registry = new EndpointAdapterRegistry({ database,
      materials: { get: () => ({ envelope: { sha256: sha } }), readOriginal: () => ({ bytes: Buffer.alloc(0), sha256: sha }) } as unknown as MaterialService });
    const bridge = new ConversationProcessingBridge({ database, core: {} as PersonalCore,
      companion: { endpointAdapters: registry } as unknown as WorkspaceServices, origin: () => null });
    for (const action of ['data.adapters.capabilities', 'data.adapters.propose', 'data.adapters.replay', 'data.adapters.adopt']) {
      assert.equal(bridge.handles(action), true, action);
      assert.equal(bridge.registrations.some(registration => registration.action === action), true, action);
    }
    const adopt = bridge.registrations.find(registration => registration.action === 'data.adapters.adopt')!;
    assert.deepEqual(adopt.fields.map(field => field.key), ['adapterId', 'version', 'configDigest', 'evidenceDigest', 'confirmationDigest']);

    // 会话操作者不能自行采用：采用依据必须是本机受信入口/审批回执，不是正文自报。
    registry.propose({ config }, hostOperator);
    assert.throws(() => registry.adopt({ adapterId: config.adapterId, version: config.version, configDigest: sha,
      evidenceDigest: sha, confirmationDigest: sha }, conversationOperator),
    (error: unknown) => error instanceof TaskError && error.code === 'ADAPTER_ADOPTION_AUTHORITY');
  } finally { database.close(); }
});

test('真实桥执行：候选→重放→待审批→单次批准后采用并读回，重放同一收据被拒绝', async () => {
  const { PermissionService } = await import('../../platform/security/permissions.js');
  const { acquireAuthority } = await import('../../platform/runtime/file-workspace.js');
  const { wfdSha256 } = await import('../../adapters/database/wfd-transport.js');
  const good = Buffer.from(JSON.stringify([{ day: '2026-04-13', qty: '1.25' }]), 'utf8');
  const bad = Buffer.from(JSON.stringify([{ day: '2026-04-13' }]), 'utf8');
  const materials = new Map([[ 'mat-good', good], ['mat-bad', bad]]);
  const database = new CoreDatabase(':memory:');
  try {
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const registry = new EndpointAdapterRegistry({ database, materials: {
      get: (id: string) => ({ envelope: { materialId: id, sha256: wfdSha256(materials.get(id)!) } }),
      readOriginal: (id: string) => ({ bytes: materials.get(id)!, sha256: wfdSha256(materials.get(id)!) }),
    } as unknown as MaterialService });
    const bridge = new ConversationProcessingBridge({ database, core: {} as PersonalCore,
      companion: { endpointAdapters: registry, bd: { assertDispatch: () => {} } } as unknown as WorkspaceServices,
      origin: () => ({ conversationId: 'c1', branchId: 'b1', messageId: 'm1' }) as never });
    // 分支材料链接：重放只接受本分支材料。
    database.connection.prepare(`CREATE TABLE IF NOT EXISTS conversation_material_links(ref_id TEXT NOT NULL, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, material_id TEXT, origin_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(ref_id,kind))`).run();
    for (const id of ['mat-good', 'mat-bad']) database.connection.prepare('INSERT INTO conversation_material_links VALUES(?,?,?,?,?,?)')
      .run(id, 't1', 'material', id, JSON.stringify({ conversationId: 'c1', branchId: 'b1' }), Date.now());

    const contextFor = (mode: 'pending' | 'approve-once', reused?: string) => {
      let approvalId: string | undefined = reused;
      // 宿主在受信上下文里补齐运行/尝试/代次与目标；这里只模拟运行身份，不模拟授权结论。
      const scope = (operation: Record<string, unknown>) => ({ ...operation, runId: 'run-adapter-1', attemptId: 'attempt-adapter-1',
        generation: 1, targets: [{ kind: 'directory', path: '/tmp', recursive: true }] }) as never;
      const caps = (capabilities: never) => ((capabilities as unknown as unknown[]).length ? capabilities
        : [{ action: 'read', target: { kind: 'directory', path: '/tmp', recursive: true } }] as never);
      const context = {
        task: { id: 'task-adapter-1', action: 'data.adapters.adopt', args: {}, versions: {} },
        signal: new AbortController().signal,
        assertAuthorized: (operation: never, capabilities: never, authorization?: { approvalId?: string }) =>
          permissions.assertAuthorized(scope(operation as never), caps(capabilities), authorization),
        requestApproval: async (operation: never, capabilities: never) => {
          const scoped = scope(operation as never), needed = caps(capabilities);
          if (mode === 'pending') { const pending = permissions.requestApproval(scoped, needed); return { approvalId: pending.id }; }
          const id = approvalId ?? permissions.requestApproval(scoped, needed).id;
          permissions.approve(id, needed); approvalId = id;
          return { approvalId: id };
        },
      };
      return { context, current: () => approvalId };
    };

    const propose = await bridge.execute({ ...contextFor('approve-once').context } as never, 'data.adapters.propose',
      { configJson: JSON.stringify(config) } as never);
    assert.equal((propose.data as { modelPreview: { status: string } }).modelPreview.status, 'candidate');
    const replay = await bridge.execute({ ...contextFor('approve-once').context } as never, 'data.adapters.replay',
      { adapterId: config.adapterId, version: '1', samplesJson: JSON.stringify([
        { materialId: 'mat-good', expectation: 'accept', expect: { values: { qty: '125' } } },
        { materialId: 'mat-bad', expectation: 'reject' }]) } as never);
    const replayView = (replay.data as { modelPreview: { passed: boolean; evidenceDigest: string } }).modelPreview;
    assert.equal(replayView.passed, true);
    assert.equal(registry.list(config.adapterId)[0]!.status, 'candidate');

    const adoptArgs = { adapterId: config.adapterId, version: '1', configDigest: registry.list(config.adapterId)[0]!.configDigest,
      evidenceDigest: replayView.evidenceDigest, confirmationDigest: replayView.evidenceDigest };
    // 待审批：真实 permission 请求已创建，但未批准前不会写入采用。
    const pending = contextFor('pending');
    await assert.rejects(async () => bridge.execute(pending.context as never, 'data.adapters.adopt', adoptArgs as never),
      (error: unknown) => error instanceof Error);
    assert.equal(registry.list(config.adapterId)[0]!.status, 'candidate');
    // 单次批准后采用成功并读回。
    const approved = contextFor('approve-once');
    await bridge.execute(approved.context as never, 'data.adapters.adopt', adoptArgs as never);
    assert.equal(registry.list(config.adapterId)[0]!.status, 'adopted');
    // 复用同一收据再次采用：权限层拒绝，状态不重复推进。
    const reused = contextFor('approve-once', approved.current());
    await assert.rejects(async () => bridge.execute(reused.context as never, 'data.adapters.adopt', adoptArgs as never),
      (error: unknown) => error instanceof Error);
    assert.equal(registry.list(config.adapterId)[0]!.status, 'adopted');
    void acquireAuthority;
  } finally { database.close(); }
});

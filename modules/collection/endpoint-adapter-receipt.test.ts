import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApplicationServices } from '../../apps/server/services.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { PersonalCore } from '../agent/runtime/core.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { acceptWorkspaceMaterial } from './accept-material.js';
import { ConversationMaterialBridge } from './conversation-materials.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { adapterConfigDigest, parseEndpointSource, readEndpointAdapterConfig } from './endpoint-adapter.js';
import { EndpointAdapterRegistry, readSourceReceiptFromTask } from './endpoint-adapter-registry.js';

// 合成的 HTTP 200 业务失败与成功备用响应；没有调用供应商或改写历史来源任务。
const originals = [
  { fileRefId: 'synthetic-failed-primary', bytes: Buffer.from('{"code":5003,"data":null}'),
    url: 'https://primary.example.test/kline' },
  { fileRefId: 'synthetic-successful-backup', bytes: Buffer.from('{"code":0,"data":[{"day":"2026-01-05","close":"11.25"}]}'),
    url: 'https://backup.example.test/kline' },
];
const receipts = originals.map(item => ({ url: item.url, sha256: wfdSha256(item.bytes), fileRefId: item.fileRefId,
  contentType: 'application/json', status: 200, transport: 'https' }));
const originalRef = (entry: typeof receipts[number]) => ({ fileRefId: entry.fileRefId, sha256: entry.sha256 });
const feedback = (originalRefs: unknown) => ({ contract: 'bd.source-candidate-feedback/1', evidence: { originalRefs } });
const data = () => ({ operation: 'daily_bars', scopeId: 'CN/A_STOCK', sourceId: 'eastmoney',
  observedAt: '2026-01-06T01:00:00Z', requested: { adjustment: 'none' },
  attempts: [{ connectionId: 'synthetic-primary', outcome: 'skipped_or_failed', reason: '业务失败' },
    { connectionId: 'synthetic-backup', outcome: 'used' }],
  sourceReceipts: receipts, candidateFeedback: feedback([originalRef(receipts[1]!)]) });
const sourceTask = (value: Record<string, unknown>, action = 'source.kline.read') => ({
  action, runtimeId: 'direct', status: 'succeeded', requiresReview: false, result: { data: value },
});
const issue = (value: Record<string, unknown>, action?: string) => readSourceReceiptFromTask(sourceTask(value, action), ['direct']);
const project = (entry: typeof receipts[number]) => ({ url: entry.url, sha256: entry.sha256,
  fileRefId: entry.fileRefId, contentType: entry.contentType });

const config = readEndpointAdapterConfig({
  contract: 'bd.endpoint-adapter/1', adapterId: 'synthetic.receipt-owner', version: '1',
  match: { endpoint: receipts[1]!.url, protocol: 'daily_bars|application/json', frequency: 'day',
    adjustment: 'none', market: 'cn-a-share' },
  carrier: { kind: 'json', charset: 'utf-8' },
  response: { success: { path: 'code', equals: '0' }, container: { path: 'data', kind: 'array' } },
  fields: [{ name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'close', source: { kind: 'key', key: 'close' }, type: 'decimal' }],
  evidence: { sourceId: 'synthetic', provider: '合成回执', coverage: '单日', basis: '只验证失败尝试与成功原件的归属。' },
});

test('成功备用的 issuer 回执只绑定成功原件，HTTP 200 业务失败原件不能取得适配上下文', () => {
  for (const action of ['source.kline.read', 'source.api.read']) {
    const result = data(), before = structuredClone(result);
    assert.deepEqual(issue(result, action)?.receipts, [project(receipts[1]!)]);
    assert.deepEqual(result, before, '原任务的失败尝试与原件审计保持原值');
  }

  const database = new CoreDatabase(':memory:');
  try {
    const registry = new EndpointAdapterRegistry({ database, sourceReceipt: () => issue(data()),
      materials: {
        get: (id: string) => { const entry = receipts.find(item => item.fileRefId === id)!;
          return { envelope: { materialId: id, sha256: entry.sha256, fileRefId: entry.fileRefId } }; },
        readOriginal: (id: string) => { const entry = originals.find(item => item.fileRefId === id)!;
          return { bytes: entry.bytes, sha256: wfdSha256(entry.bytes) }; },
      } as never });
    registry.propose({ config }, { operatorId: 'synthetic.host', requestId: 'synthetic-receipt-candidate',
      method: 'POST', path: '/synthetic', remoteAddress: null, observedAt: 0 });
    database.connection.prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    const binding = { adapterId: config.adapterId, version: '1', configDigest: adapterConfigDigest(config) };
    assert.equal(registry.resolve(binding, { materialId: receipts[1]!.fileRefId, sourceReceiptTaskId: 'synthetic-task' }).match?.verified, true);
    assert.throws(() => registry.resolve(binding, { materialId: receipts[0]!.fileRefId, sourceReceiptTaskId: 'synthetic-task' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ADAPTER_CONTEXT_MATERIAL');
  } finally { database.close(); }
});

test('成功原件集合须完整精确且无歧义，显式失败与残缺反馈不能退回历史宽松路径', () => {
  const selected = receipts[1]!;
  for (const references of [[], null, [null], [{ fileRefId: selected.fileRefId, sha256: receipts[0]!.sha256 }],
    [{ fileRefId: 'synthetic-other-file', sha256: selected.sha256 }], [originalRef(selected), originalRef(selected)]])
    assert.equal(issue({ ...data(), candidateFeedback: feedback(references) }), null);
  for (const candidateFeedback of [null, {}, { contract: 'unknown', evidence: { originalRefs: [originalRef(selected)] } }])
    assert.equal(issue({ ...data(), candidateFeedback }), null);
  assert.equal(issue({ ...data(), sourceReceipts: [...receipts, selected] }), null, '同一原件的重复回执不构成唯一绑定');
  assert.equal(issue({ ...data(), sourceReceipts: [...receipts, { ...selected, sha256: receipts[0]!.sha256 }] }), null);
  for (const status of [206, 302, 429, 500])
    assert.equal(issue({ ...data(), sourceReceipts: [receipts[0], { ...selected, status }] }), null);
});

test('旧行情与 API 多原件不靠 HTTP 200 或旧 feedback 的全量原件集合猜成功归属', () => {
  const { candidateFeedback: _feedback, ...legacy } = data();
  for (const action of ['source.kline.read', 'source.api.read']) {
    assert.equal(issue(legacy, action), null);
    assert.equal(issue({ ...legacy, candidateFeedback: feedback(receipts.map(originalRef)) }, action), null);
    assert.equal(issue({ ...legacy, sourceReceipts: [null, receipts[1]] }, action), null);
    const { status: _status, ...withoutStatus } = receipts[1]!;
    assert.deepEqual(issue({ ...legacy, sourceReceipts: [withoutStatus] }, action)?.receipts, [project(receipts[1]!)]);
    assert.equal(issue({ ...legacy, sourceReceipts: [{ ...receipts[1], status: 500 }] }, action), null);
  }
});

test('合法官方页面与附件多原件保持可关联；缺少原有元数据和 WeRSS 不扩入此 issuer', () => {
  const page = { ...receipts[0]!, url: 'https://www.sse.com.cn/synthetic/page.html', contentType: 'text/html' };
  const attachment = { ...receipts[1]!, url: 'https://www.sse.com.cn/synthetic/attachment.pdf', contentType: 'application/pdf' };
  const historical = { operation: 'official_document', sourceId: 'official_web', observedAt: '2026-01-06T01:00:00Z',
    sourceReceipts: [page, attachment] };
  assert.deepEqual(issue(historical, 'source.fetch')?.receipts, [project(page), project(attachment)]);
  assert.deepEqual(issue({ ...historical, candidateFeedback: feedback([originalRef(page), originalRef(attachment)]) }, 'source.fetch')?.receipts,
    [project(page), project(attachment)]);
  for (const status of [undefined, null, 206, 404])
    assert.equal(issue({ ...historical, sourceReceipts: [page, { ...attachment, status }] }, 'source.fetch'), null);
  assert.equal(issue({ ...historical, sourceId: 'tdx' }, 'source.fetch'), null);
  const { operation: _operation, ...withoutOperation } = historical;
  assert.equal(issue(withoutOperation, 'source.fetch'), null, '当前官方下载原本没有适配操作，不伪造该元数据扩大接纳范围');
  assert.equal(issue(historical, 'source.werss.read'), null, 'WeRSS 继续使用自己的 locator/material 管路');
});

test('投影、成功尝试与候选反馈必须指向同一原件', () => {
  const good = receipts[1]!, bad = receipts[0]!;
  for (const field of ['projection', 'dailyValidation']) {
    assert.deepEqual(issue({ ...data(), [field]: { rawSha256: good.sha256 } })?.receipts, [project(good)]);
    for (const invalid of [null, [], 'raw', 123, {}, { rawSha256: null }, { rawSha256: bad.sha256 }])
      assert.equal(issue({ ...data(), [field]: invalid }), null);
    for (const sha256 of ['x', 'A'.repeat(64), '0'.repeat(63)]) {
      assert.equal(issue({ operation: 'daily_bars', observedAt: data().observedAt, sourceId: data().sourceId, sourceReceipts: [{ ...good, sha256 }],
        [field]: { rawSha256: sha256 } }), null);
    }
  }
  assert.equal(issue({ ...data(), attempts: [{ outcome: 'used', connectionId: 'synthetic-backup', ...originalRef(bad) }] }), null);
  assert.equal(issue({ ...data(), sourceReceipts: [bad, { ...good, connectionId: 'synthetic-primary' }] }), null);
});

test('个人来源任务经 material.read 交接到独立工作台库，适配器重开后只消费成功的受管原件', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'source-dual-db-')));
  const personal = new CoreDatabase(join(root, 'personal.sqlite')), workspace = new CoreDatabase(join(root, 'workspace.sqlite'));
  const workspaceCore = new PersonalCore({ id: 'fixture', createSession: async () => { throw Error('Unexpected model call'); } }, { database: workspace });
  const companion = createApplicationServices(workspaceCore, workspace, { role: 'service', projectRoot: root,
    privateRoot: join(root, 'workspace'), codeRoot: fileURLToPath(new URL('../..', import.meta.url)),
    health: { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'Synthetic SQLite test' },
    materials: { environment: 'synthetic-test' } });
  const runtimes = new TaskRuntimeRegistry();
  const permissions = new PermissionService({ database: personal, isRunActive: (id, gen) => tasks.isRunActive(id, gen) });
  const files = new FileReferenceService({ database: personal, permissions });
  const tasks: TaskService = new TaskService({ database: personal, runtimes, permissions, isConversationActive: () => true });
  const origin: ModelTaskOrigin = { callId: 'call', conversationId: 'conversation', branchId: 'branch', parentRunId: 'parent',
    parentGeneration: 1, inputId: 'input', messageId: 'message', modelDigest: 'fixture', endpointDigest: 'fixture',
    toolCallId: 'call', toolName: 'perform_action', notice: '', receiver: { provider: 'fixture', model: 'fixture', origin: 'fixture' } };
  // 合成会话身份和下载传输，任务、权限、文件登记、材料保管、回执签发均走真实服务。
  let attached: string | undefined, noModelOrigin: string | undefined;
  const bridge = new ConversationMaterialBridge({ database: personal, files, companion, origin: id => id === noModelOrigin ? null : origin,
    core: { selectedAttachmentsForInput: () => attached ? [{ fileRefId: attached, version: files.verify(attached).version, category: 'unclassified' }] : [], store: { command: () => ({ text: '合成来源原件' }),
      message: () => ({ role: 'user', text: '合成来源原件', conversation_id: origin.conversationId, parent_id: null }) } } as unknown as PersonalCore,
    assertPath: path => assert.equal(path.startsWith(root + '/'), true) });
  runtimes.register({ id: 'direct', async execute(context) {
    const args = context.task.args as Record<string, JsonValue>;
    if (context.task.action === 'material.read') return bridge.execute(context, context.task.action, args);
    const stored = originals.map((original, index) => {
      const path = join(root, context.task.id + '-' + index + '.json');
      writeFileSync(path, original.bytes);
      const file = files.register({ path, source: 'generated', taskId: context.task.id });
      permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
      return { ...receipts[index]!, fileRefId: file.id, sha256: args.wrongDigest && index === 1 ? 'f'.repeat(64) : receipts[index]!.sha256 };
    });
    return { summary: '合成来源响应', artifactIds: stored.map(item => item.fileRefId),
      data: { ...data(), sourceReceipts: stored, candidateFeedback: feedback([originalRef(stored[1]!)]) } as JsonValue };
  } });
  const run = async (action: string, args: Record<string, JsonValue>, requestId: string) => {
    const task = tasks.create({ title: '合成来源与材料交接', ownerRole: 'personal', conversationId: origin.conversationId, runtimeId: 'direct', action, args, requestId });
    if (task.status === 'ready') tasks.start(task.id, task.version);
    return tasks.wait(task.id);
  };
  try {
    const source = await run('source.kline.read', {}, 'synthetic-download');
    assert.equal(source.status, 'succeeded', JSON.stringify(source.error));
    const [badRef, goodRef] = source.result!.artifactIds!;
    assert.equal(bridge.canSelectGeneratedMaterial(badRef, origin), false);
    assert.equal(bridge.canSelectGeneratedMaterial(goodRef, origin), true);
    assert.equal((await run('material.read', { fileRefId: badRef }, 'read-failed-original')).error?.code, 'MATERIAL_NOT_SELECTED');
    const wrong = await run('source.kline.read', { wrongDigest: true }, 'bad-source-digest');
    assert.equal((await run('material.read', { fileRefId: wrong.result!.artifactIds![1] }, 'read-bad-digest')).error?.code, 'MATERIAL_RECEIPT_MISMATCH');
    const read = await run('material.read', { fileRefId: goodRef }, 'read-successful-original');
    assert.equal(read.status, 'succeeded', JSON.stringify(read.error));
    const materialId = String((read.result!.data as Record<string, JsonValue>).materialId);
    const envelope = companion.materials!.get(materialId).envelope;
    assert.notEqual(envelope.fileRefId, goodRef);
    assert.equal(envelope.sha256, receipts[1].sha256);
    assert.equal(workspace.connection.prepare('SELECT id FROM tasks WHERE id=?').get(source.id), undefined);
    noModelOrigin = source.id;
    assert.equal(bridge.canSelectGeneratedMaterial(goodRef, origin), false);
    attached = goodRef;
    assert.equal((await run('material.read', { fileRefId: goodRef }, 'read-original-again')).status, 'succeeded');
    assert.equal(workspace.connection.prepare('SELECT count(*) n FROM source_receipt_handoffs').get()!.n, 1);
    const attachedOnly = await run('source.kline.read', {}, 'no-model-origin-download');
    noModelOrigin = attachedOnly.id; attached = attachedOnly.result!.artifactIds![1];
    const readAttachment = await run('material.read', { fileRefId: attached }, 'explicit-attachment');
    assert.equal(readAttachment.status, 'succeeded', JSON.stringify(readAttachment.error));
    const unrelatedCopy = String((readAttachment.result!.data as Record<string, JsonValue>).materialId);
    assert.equal(companion.materials!.get(unrelatedCopy).envelope.sha256, envelope.sha256);
    assert.throws(() => companion.endpointAdapters!.resolveSourceReceiptForMaterial(source.id, unrelatedCopy), { code: 'ADAPTER_CONTEXT_MATERIAL' });
    assert.equal(companion.endpointAdapters!.resolveSourceReceiptForMaterial(attachedOnly.id, unrelatedCopy).entry.fileRefId, attached);
    const registry = companion.endpointAdapters!;
    const negativeTask = await acceptWorkspaceMaterial(companion, { bytes: originals[0].bytes, name: 'failed.json', category: 'data', requestId: 'negative-material' });
    assert.equal((await companion.tasks.wait(negativeTask)).status, 'succeeded');
    const negativeId = companion.materials!.getByTask(negativeTask)!.envelope.materialId;
    const operator = { operatorId: 'synthetic.host', requestId: 'synthetic-handoff', method: 'POST', path: '/synthetic', remoteAddress: null, observedAt: 0 };
    registry.propose({ config }, operator);
    const binding = { adapterId: config.adapterId, version: config.version, configDigest: adapterConfigDigest(config) };
    const replay = registry.replay({ adapterId: config.adapterId, version: config.version, samples: [
      { materialId, expectation: 'accept' }, { materialId: negativeId, expectation: 'reject' }] }, operator);
    assert.equal(replay.passed, true, JSON.stringify(replay.results));
    registry.adopt({ ...binding, evidenceDigest: replay.evidenceDigest, confirmationDigest: replay.evidenceDigest }, operator);
    const sourceEvidence = readSourceReceiptFromTask(source, ['direct'])!;
    const handoff = { sourceTaskId: source.id, sourceFileRefId: goodRef, materialId, workspaceFileRefId: envelope.fileRefId!,
      sha256: envelope.sha256, evidence: sourceEvidence };
    assert.throws(() => registry.recordTrustedSourceHandoff({ ...handoff, sourceFileRefId: badRef }), { code: 'ADAPTER_CONTEXT_MATERIAL' });
    assert.throws(() => registry.recordTrustedSourceHandoff({ ...handoff, workspaceFileRefId: goodRef }), { code: 'ADAPTER_CONTEXT_MATERIAL' });
    assert.throws(() => registry.recordTrustedSourceHandoff({ ...handoff, sourceTaskId: wrong.id }), { code: 'ADAPTER_HANDOFF_CONFLICT' });
    await tasks.dispose(); personal.close();
    const reopened = new CoreDatabase(workspace.path);
    try {
      const reader = new EndpointAdapterRegistry({ database: reopened, materials: companion.materials! });
      const resolved = reader.resolve(binding, { materialId, sourceReceiptTaskId: source.id });
      assert.equal(resolved.match?.verified, true);
      assert.deepEqual(parseEndpointSource(companion.materials!.readOriginal(materialId).bytes, resolved.config).rows[0].map(cell => cell.value),
        ['2026-01-05', '11.25']);
      assert.throws(() => reader.resolve(binding, { materialId: negativeId, sourceReceiptTaskId: source.id }));
      assert.throws(() => reader.resolve(binding, { materialId, sourceReceiptTaskId: wrong.id }), { code: 'ADAPTER_CONTEXT_MATERIAL' });
      reopened.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(originals[0].bytes, materialId);
      assert.throws(() => reader.resolve(binding, { materialId, sourceReceiptTaskId: source.id }), { code: 'MATERIAL_ORIGINAL_CHANGED' });
    } finally { reopened.close(); }
  } finally {
    if (personal.connection.isOpen) { await tasks.dispose(); personal.close(); }
    companion.segments?.close(); companion.files.closeTemporaryRetention();
    await companion.tasks.dispose(); await workspaceCore.dispose(); workspace.close(); rmSync(root, { recursive: true });
  }
});

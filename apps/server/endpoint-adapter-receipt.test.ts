import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService, type TaskExecutionContext, type TaskRuntime } from '../../platform/jobs/tasks.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import type { EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';

/**
 * 真实宿主取得回执：真实 services 装配的 issuer（TaskService.get + 材料保管）解析合成来源任务结果，
 * 正例按本材料 sha/fileRefId 选中回执；错误任务/错误原件/字段冲突都不得升级为已核。
 * 合成 fixture 明确标注，不冒充供应商真实下载。
 */
const BYTES = Buffer.from(JSON.stringify({ rc: 0, data: { klines: ['2026-04-13,1444.00,1443.31,1446.50,1433.00,25214,3629675490.00'] } }), 'utf8');
const config: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'eastmoney.kline.receipt', version: '1',
  match: { endpoint: 'https://push2his.eastmoney.example.test/api/qt/stock/kline/get', protocol: 'daily_bars|application/json',
    frequency: 'day', adjustment: 'none', market: 'cn-a-share', fields2: ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57'] },
  carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
  response: { success: { path: 'rc', equals: '0' }, container: { path: 'data.klines', kind: 'delimited-array' }, ignore: ['rt'] },
  fields: [
    { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' },
    { name: 'open', source: { kind: 'position', index: 1 }, type: 'decimal' },
    { name: 'close', source: { kind: 'position', index: 2 }, type: 'decimal' },
    { name: 'high', source: { kind: 'position', index: 3 }, type: 'decimal' },
    { name: 'low', source: { kind: 'position', index: 4 }, type: 'decimal' },
    { name: 'volume', source: { kind: 'position', index: 5 }, type: 'integer' },
    { name: 'amount', source: { kind: 'position', index: 6 }, type: 'decimal' },
  ], evidence: { sourceId: 'synthetic', provider: '合成等价样本', coverage: '单日单标的',
    basis: '按格式对照矩阵结构构造的合成响应；不是供应商真实下载。' } };

test('真实宿主 issuer：TaskService.get 读取得回执，按材料 sha+fileRefId 选条目并核实际 URL 字段', { skip:
  !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT' }, async () => {
  const fixture = createFullChainFixture({ name: 'adapter-receipt' });
  const host = await openFullChainHost(fixture);
  let sourceTasks: TaskService | undefined;
  try {
    const uploaded = await host.upload('eastmoney-receipt.json', 'data', BYTES, 'receipt-material');
    const intake = await host.settled(uploaded.jobId);
    assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
    const material = host.services.materials!.getByTask(intake.id)!.envelope;

    // 采用该配置（真实重放：正样本 + 失败样本）。
    await host.call('/processing/adapters/candidates', { requestId: 'receipt-candidate', input: { config } }, 201);
    const badUpload = await host.upload('eastmoney-receipt-bad.json', 'data',
      Buffer.from(JSON.stringify({ rc: 1, data: { klines: ['2026-04-13,1,1,1,1,1,1'] } }), 'utf8'), 'receipt-bad');
    const badIntake = await host.settled(badUpload.jobId);
    const badId = host.services.materials!.getByTask(badIntake.id)!.envelope.materialId;
    const replay = await host.call('/processing/adapters/eastmoney.kline.receipt/1/replay', { requestId: 'receipt-replay',
      input: { adapterId: config.adapterId, version: '1', samples: [
        { materialId: material.materialId, expectation: 'accept', expect: { values: { close: '1443.31' } } },
        { materialId: badId, expectation: 'reject' }] } });
    assert.equal(replay.passed, true, JSON.stringify(replay.results));
    const adopted = await host.call('/processing/adapters/eastmoney.kline.receipt/1/adopt', { requestId: 'receipt-adopt',
      input: { adapterId: config.adapterId, version: '1', evidenceDigest: replay.evidenceDigest, confirmationDigest: replay.evidenceDigest } });
    const binding = { adapterId: config.adapterId, version: '1', configDigest: adopted.configDigest };

    // 真实来源任务（合成结果）：第二个 TaskService 写入同一库，host 的 issuer 通过真实 TaskService.get 读取。
    const runtimes = new TaskRuntimeRegistry();
    const receiptData = (sha256: string, fileRefId: string, url: string, requested?: Record<string, unknown>) => ({
      status: 'downloaded', sourceId: 'eastmoney', operation: 'daily_bars', scopeId: 'CN/A_STOCK',
      observedAt: '2026-11-06T01:00:00Z', requested: requested ?? { adjustment: 'none' },
      dailyValidation: { adjustment: 'none' },
      sourceReceipts: [{ url, sha256, fileRefId, contentType: 'application/json', status: 200 }] });
    let pending: { sha: string; fileRef: string; url: string; requested?: Record<string, unknown> } = {
      sha: material.sha256, fileRef: material.fileRefId!, url: 'https://push2his.eastmoney.example.test/api/qt/stock/kline/get?fields2=f51,f52,f53,f54,f55,f56,f57&secid=1.600519' };
    // 用 direct 运行时身份承载合成来源结果：真实 issuer 只信任 direct 生产者，这里不额外放宽信任名单。
    const runtime: TaskRuntime = { id: 'direct', execute: async (context: TaskExecutionContext) => ({
      summary: '合成来源下载完成。', data: receiptData(pending.sha, pending.fileRef, pending.url, pending.requested) as never }) };
    runtimes.register(runtime);
    let service!: TaskService;
    const permissions = new PermissionService({ database: host.database, isRunActive: (run, generation) => service.isRunActive(run, generation) });
    service = new TaskService({ database: host.database, runtimes, permissions, controlsAllTasks: true, isConversationActive: () => true });
    sourceTasks = service;
    const runDownload = async (requestId: string, action: string) => {
      const created = service.create({ title: '合成来源下载', ownerRole: 'service', runtimeId: 'direct',
        action, args: {}, requestId, versions: { directConfiguration: 'synthetic-1' } });
      if (created.status === 'ready') service.start(created.id, created.version);
      return service.wait(created.id);
    };

    const positive = await runDownload('receipt-task-positive', 'source.api.read');
    assert.equal(positive.status, 'succeeded', JSON.stringify(positive.error));
    const resolved = host.services.endpointAdapters!.resolve(binding, { materialId: material.materialId, sourceReceiptTaskId: positive.id });
    assert.equal(resolved.match?.verified, true);
    assert.equal(resolved.match?.kind, 'receipt');

    // 错误原件：同一任务回执的 sha/fileRef 与另一材料不符。
    const otherUpload = await host.upload('eastmoney-receipt-other.json', 'data', BYTES, 'receipt-other');
    const otherIntake = await host.settled(otherUpload.jobId);
    const otherId = host.services.materials!.getByTask(otherIntake.id)!.envelope.materialId;
    assert.throws(() => host.services.endpointAdapters!.resolve(binding, { materialId: otherId, sourceReceiptTaskId: positive.id }),
      (error: unknown) => (error as { code?: string }).code === 'ADAPTER_CONTEXT_MATERIAL');

    // 错误任务：动作不是来源下载 → 不构成取得回执。
    const wrongAction = await runDownload('receipt-task-wrong-action', 'data.processing.plan');
    assert.equal(wrongAction.status, 'succeeded', JSON.stringify(wrongAction.error));
    assert.throws(() => host.services.endpointAdapters!.resolve(binding, { materialId: material.materialId, sourceReceiptTaskId: wrongAction.id }),
      (error: unknown) => (error as { code?: string }).code === 'ADAPTER_RECEIPT_MISSING');

    // 冲突：任务声明 fields2 与实际 URL 不一致 → 拒绝。
    pending = { ...pending, requested: { adjustment: 'none', fields2: ['f51', 'f99'] } };
    const conflict = await runDownload('receipt-task-conflict', 'source.api.read');
    assert.throws(() => host.services.endpointAdapters!.resolve(binding, { materialId: material.materialId, sourceReceiptTaskId: conflict.id }),
      (error: unknown) => (error as { code?: string }).code === 'ADAPTER_CONTEXT_CONFLICT');
  } finally {
    if (sourceTasks) await sourceTasks.dispose().catch(() => {});
    await host.close().catch(() => {});
  }
});

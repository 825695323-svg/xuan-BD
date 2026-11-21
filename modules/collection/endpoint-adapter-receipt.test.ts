import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { adapterConfigDigest, readEndpointAdapterConfig } from './endpoint-adapter.js';
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
    const config = readEndpointAdapterConfig({
      contract: 'bd.endpoint-adapter/1', adapterId: 'synthetic.receipt-owner', version: '1',
      match: { endpoint: receipts[1]!.url, protocol: 'daily_bars|application/json', frequency: 'day',
        adjustment: 'none', market: 'cn-a-share' },
      carrier: { kind: 'json', charset: 'utf-8' },
      response: { success: { path: 'code', equals: '0' }, container: { path: 'data', kind: 'array' } },
      fields: [{ name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' }],
      evidence: { sourceId: 'synthetic', provider: '合成回执', coverage: '单日', basis: '只验证失败尝试与成功原件的归属。' },
    });
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

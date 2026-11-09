import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApp } from './app.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null,
  notice: 'isolated retrieval test; model disabled' };
const backend: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('No model calls in retrieval tests'); } };
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');

function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'xuan-retrieval-')));
  const runtime = join(root, 'bd'), identity = 'isolated-retrieval-test'; mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'file' | 'directory' }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path); resources[name] = { path, kind: 'directory' };
  }
  json(join(runtime, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity });
  json(join(runtime, 'config/machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity: identity, resources });
  return { root, runtime };
}

/** 与真实 `conversion.document` 产物同形的信封：页面几何由 PDF 抽取给出。 */
function envelope(source: { fileRefId: string; sha256: string }, operation = 'conversion.document',
  headline = '半导体行业研究报告') {
  return { schemaVersion: '1.0', implementation: { name: 'harness-native-conversion', version: '1.0.0' },
    operation, source: { ...source, declaredName: 'report.pdf', detectedType: 'pdf' },
    status: 'complete', issues: [], text: '半导体行业研究报告\n营业收入 1,200 1,500',
    content: { format: 'pdf', pageCount: 1, implementation: { pdfjs: '6.4.299', normalization: 'disabled' }, pages: [{
      page: 1, pageLabel: '1', width: 595, height: 842, text: '',
      originalItems: [
        { index: 0, str: headline, transform: [1, 0, 0, 1, 72, 800], width: 108, height: 12, hasEOL: true },
        { index: 1, str: '项目', transform: [1, 0, 0, 1, 72, 650], width: 32, height: 11, hasEOL: false },
        { index: 2, str: '2024', transform: [1, 0, 0, 1, 300, 650], width: 32, height: 11, hasEOL: false },
        { index: 3, str: '2025', transform: [1, 0, 0, 1, 420, 650], width: 32, height: 11, hasEOL: true },
        { index: 4, str: '营业收入', transform: [1, 0, 0, 1, 72, 630], width: 48, height: 11, hasEOL: false },
        { index: 5, str: '1,200', transform: [1, 0, 0, 1, 300, 630], width: 40, height: 11, hasEOL: false },
        { index: 6, str: '1,500', transform: [1, 0, 0, 1, 420, 630], width: 40, height: 11, hasEOL: true },
        { index: 7, str: '净利润', transform: [1, 0, 0, 1, 72, 610], width: 32, height: 11, hasEOL: false },
        { index: 8, str: '120', transform: [1, 0, 0, 1, 300, 610], width: 24, height: 11, hasEOL: false },
        { index: 9, str: '180', transform: [1, 0, 0, 1, 420, 610], width: 24, height: 11, hasEOL: true },
      ],
      tableCandidates: [
        { row: 2, baselineY: 650, cells: [{ x: 72, endX: 104, text: '项目', itemIndexes: [1] },
          { x: 300, endX: 332, text: '2024', itemIndexes: [2] }, { x: 420, endX: 452, text: '2025', itemIndexes: [3] }] },
        { row: 3, baselineY: 630, cells: [{ x: 72, endX: 120, text: '营业收入', itemIndexes: [4] },
          { x: 300, endX: 340, text: '1,200', itemIndexes: [5] }, { x: 420, endX: 460, text: '1,500', itemIndexes: [6] }] },
        { row: 4, baselineY: 610, cells: [{ x: 72, endX: 104, text: '净利润', itemIndexes: [7] },
          { x: 300, endX: 324, text: '120', itemIndexes: [8] }, { x: 420, endX: 444, text: '180', itemIndexes: [9] }] },
      ] }] } };
}

async function host() {
  const f = fixture();
  const database = new CoreDatabase(join(f.runtime, 'state/core.sqlite'));
  const core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'service', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/private'), resources: new ResourceBindings(f.runtime),
    materials: { environment: 'synthetic-test' } });
  const server: Server = createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/bd`;
  const call = async (path: string, body?: unknown, expected = 200): Promise<any> => {
    const response = await fetch(base + path, { headers: { 'x-mashiro-client': 'web',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const upload = async (name: string, requestId: string): Promise<any> => {
    const query = new URLSearchParams({ name, category: 'unclassified', requestId });
    const response = await fetch(base + '/materials/upload?' + query, { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' }, body: new Uint8Array(pdfBytes) });
    const value = await response.json();
    assert.equal(response.status, 202, JSON.stringify(value));
    return value;
  };
  const settled = async (taskId: string, timeoutMs = 30_000): Promise<TaskRecord> => {
    const terminal = (task: TaskRecord) => ['succeeded', 'failed', 'cancelled', 'needs_review', 'waiting_approval', 'blocked', 'interrupted'].includes(task.status);
    const current = services.tasks.get(taskId); if (terminal(current)) return current;
    return await new Promise<TaskRecord>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Task did not settle: ' + taskId)); }, timeoutMs);
      const unsubscribe = services.tasks.subscribe(({ task }) => {
        if (task.id === taskId && terminal(task)) { clearTimeout(timer); unsubscribe(); resolve(task); }
      });
    });
  };
  const registerArtifact = (name: string, value: unknown) => {
    const path = join(f.root, name);
    writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    const reference = services.files.register({ path, source: 'generated', displayName: name });
    services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: reference.invocationPath } }],
      label: `retrieval-artifact:${name}`, scope: { kind: 'persistent' } });
    return reference;
  };
  const material = async (name: string, requestId: string) => {
    const task = await upload(name, requestId);
    const settledTask = await settled(String(task.jobId));
    assert.equal(settledTask.status, 'succeeded', JSON.stringify(settledTask.error));
    return services.materials!.getByTask(String(task.jobId))!;
  };
  const settleIngest = async (body: Record<string, unknown>) =>
    settled(String((await call('/retrieval/artifacts', body, 202)).jobId));
  return { f, services, base, call, upload, settled, registerArtifact, material, settleIngest, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    services.segments?.close();
    await services.tasks.dispose(); await core.dispose(); database.close();
  } };
}

test('未建索引时如实报 index_missing，能力声明列出双历史资格与处理策略', async () => {
  const h = await host();
  try {
    const capabilities = await h.call('/retrieval/capabilities');
    assert.equal(capabilities.schema, 'bd.doc-retrieval/2');
    assert.deepEqual(capabilities.historyModes, ['system_held_at', 'market_known_at']);
    assert.deepEqual(capabilities.timeStates, ['known', 'unknown', 'not_applicable']);
    assert.deepEqual(capabilities.segmentableArtifactTypes, ['conversion.document', 'pdf.extract']);
    assert.deepEqual(capabilities.settings, { autoRegister: 'enabled', autoSegment: 'enabled', autoIndex: 'enabled' });
    assert.equal(capabilities.structuredSide.wired, false);

    const result = await h.call('/retrieval/search', { method: 'keyword', query: '半导体' });
    assert.equal(result.status, 'index_missing');
    assert.equal(result.qualification.mode, 'system_held_at');
    assert.equal(result.qualification.applied, false);
    assert.equal(result.structured, null);
    assert.ok(result.gaps.includes('no_index_at_as_of'));
  } finally { await h.close(); }
});

test('产物入库：证据账本登记 → 自动片段化 → 自动增量建索引 → 引用回页码与单元格', async () => {
  const h = await host();
  try {
    const material = await h.material('report.pdf', 'upload-1');
    const artifact = h.registerArtifact('artifact-1.json',
      envelope({ fileRefId: material.envelope.fileRefId, sha256: material.envelope.sha256 }));

    const task = await h.settleIngest({ requestId: 'ingest-1', materialId: material.envelope.materialId,
      artifactRef: artifact.id, eventTime: { state: 'known', value: '2024-03-31', precision: 'date' },
      disclosedAt: { state: 'known', value: '2024-04-30T00:00:00Z' } });
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    const data = task.result?.data as unknown as Record<string, any>;
    assert.equal(data.segmented, true);
    assert.equal(data.disposition, 'inserted');
    assert.equal(data.parserVersion, 'bd.segmenter/1+pdfjs-6.4.299');
    assert.ok(data.segmentCount >= 2);
    assert.ok(String(data.indexVersion).startsWith('idx_'), '登记后应自动增量建索引');

    const ledger = await h.call(`/retrieval/documents/${material.envelope.materialId}/artifacts`);
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].artifact_type, 'conversion.document');
    assert.equal(String(ledger.items[0].artifact_sha256).length, 64);
    assert.equal(ledger.items[0].material_sha256, material.envelope.sha256, '原件摘要与产物摘要分别保存');
    assert.equal(ledger.items[0].processing_status, 'segmented');
    assert.equal(ledger.items[0].conversion_run_id, 'direct:conversion.document',
      '未给转换任务号时如实记为 direct:<action>，不冒充任务');

    const documents = await h.call('/retrieval/documents');
    const recorded = documents.items[0];
    assert.deepEqual(recorded.event_time, { state: 'known', value: Date.parse('2024-03-31'), precision: 'date',
      upper: Date.parse('2024-04-01T00:00:00Z') }, '日期精度的半开上界是次日零点，不按当日零点放行');
    assert.deepEqual(recorded.disclosed_at, { state: 'known', value: Date.parse('2024-04-30T00:00:00Z'),
      precision: 'datetime', upper: Date.parse('2024-04-30T00:00:00Z') },
    '带时分的 ISO 就是瞬时精度');
    assert.equal(recorded.artifact_sha256, ledger.items[0].artifact_sha256);

    const keyword = await h.call('/retrieval/search', { method: 'keyword', query: '半导体' });
    assert.equal(keyword.status, 'matched');
    const paragraph = keyword.citations.find((citation: any) => citation.kind === 'paragraph');
    assert.equal(paragraph.page_number, 1);
    assert.equal(paragraph.artifact_ref, artifact.id);
    assert.equal(paragraph.index_version, data.indexVersion);

    const exact = await h.call('/retrieval/search', { method: 'exact', query: '1,500' });
    const table = exact.citations.find((citation: any) => citation.kind === 'table');
    assert.ok(table);
    assert.equal(table.table.unit, null);
    assert.match(String(table.table.first_cell_ref), /:r\d+c1$/u);

    // 显式重建同一成员集：内容寻址，幂等复用，不无效膨胀版本
    const rebuilt = await h.call('/retrieval/index', {}, 201);
    assert.equal(rebuilt.indexVersion, data.indexVersion);
    assert.equal(rebuilt.reused, true);
  } finally { await h.close(); }
});

test('关闭自动片段化只登记不入索引；重新打开后可显式补建', async () => {
  const h = await host();
  try {
    const settings = await h.call('/retrieval/settings', { requestId: 'settings-1', autoSegment: 'disabled' });
    assert.deepEqual(settings, { autoRegister: 'enabled', autoSegment: 'disabled', autoIndex: 'enabled' });

    const material = await h.material('report.pdf', 'upload-2');
    const artifact = h.registerArtifact('artifact-2.json',
      envelope({ fileRefId: material.envelope.fileRefId, sha256: material.envelope.sha256 }));
    const first = await h.settleIngest({ requestId: 'ingest-off', materialId: material.envelope.materialId,
      artifactRef: artifact.id });
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
    assert.equal((first.result?.data as any).segmented, false);
    assert.equal((first.result?.data as any).reason, 'auto_segment_disabled');
    assert.equal((await h.call('/retrieval/documents')).items.length, 0);
    assert.equal((await h.call(`/retrieval/documents/${material.envelope.materialId}/artifacts`)).items[0].processing_status,
      'registered');

    await h.call('/retrieval/settings', { requestId: 'settings-2', autoSegment: 'enabled' });
    const second = await h.settleIngest({ requestId: 'ingest-on', materialId: material.envelope.materialId,
      artifactRef: artifact.id });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.error));
    assert.equal((second.result?.data as any).segmented, true);
    assert.equal((await h.call('/retrieval/documents')).items.length, 1);
    // 账本仍只有一条：同一 (材料, 版本, 产物引用) 不重复登记
    assert.equal((await h.call(`/retrieval/documents/${material.envelope.materialId}/artifacts`)).items.length, 1);
  } finally { await h.close(); }
});

test('已有片段在自动索引重新开启后补齐检查点，重复登记复用同一版本', async () => {
  const h = await host();
  try {
    await h.call('/retrieval/settings', { requestId: 'index-off', autoIndex: 'disabled' });
    const material = await h.material('report.pdf', 'upload-index-recovery');
    const artifact = h.registerArtifact('artifact-index-recovery.json',
      envelope({ fileRefId: material.envelope.fileRefId, sha256: material.envelope.sha256 }));
    const input = { materialId: material.envelope.materialId, artifactRef: artifact.id };
    const first = await h.settleIngest({ ...input, requestId: 'segmented-without-index' });
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
    assert.equal((await h.call('/retrieval/search', { method: 'keyword', query: '半导体' })).status, 'index_missing');
    await h.call('/retrieval/settings', { requestId: 'index-on', autoIndex: 'enabled' });
    const second = await h.settleIngest({ ...input, requestId: 'resume-index' });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.error));
    assert.equal((second.result?.data as any).disposition, 'existing');
    const indexVersion = (second.result?.data as any).indexVersion;
    assert.ok(String(indexVersion).startsWith('idx_'));
    const result = await h.call('/retrieval/search', { method: 'keyword', query: '半导体', indexVersion });
    assert.equal(result.status, 'matched');
    assert.ok(result.citations.every((citation: any) => citation.index_version === indexVersion));
    const third = await h.settleIngest({ ...input, requestId: 'resume-index-again' });
    assert.equal(third.status, 'succeeded', JSON.stringify(third.error));
    assert.equal((third.result?.data as any).indexVersion, indexVersion);
    assert.equal((third.result?.data as any).indexReused, true);
    assert.equal((await h.call('/retrieval/storage')).database.indexVersions, 1);
  } finally { await h.close(); }
});

test('时间适用性与双历史资格：不适用不挡、系统持有与市场公开分开', async () => {
  const h = await host();
  try {
    const first = await h.material('report.pdf', 'upload-a');
    const firstArtifact = h.registerArtifact('artifact-a.json',
      envelope({ fileRefId: first.envelope.fileRefId, sha256: first.envelope.sha256 }, 'conversion.document', '半导体行业研究报告'));
    const firstTask = await h.settleIngest({ requestId: 'ingest-a', materialId: first.envelope.materialId,
      artifactRef: firstArtifact.id, eventTime: { state: 'not_applicable' },
      disclosedAt: { state: 'known', value: '2024-01-15T00:00:00Z' } });
    assert.equal(firstTask.status, 'succeeded', JSON.stringify(firstTask.error));

    const second = await h.material('report.pdf', 'upload-b');
    const secondArtifact = h.registerArtifact('artifact-b.json',
      envelope({ fileRefId: second.envelope.fileRefId, sha256: second.envelope.sha256 }, 'conversion.document', '普通正文一句'));
    const secondTask = await h.settleIngest({ requestId: 'ingest-b', materialId: second.envelope.materialId,
      artifactRef: secondArtifact.id, disclosedAt: { state: 'known', value: '2024-01-15T00:00:00Z' } });
    assert.equal(secondTask.status, 'succeeded', JSON.stringify(secondTask.error));

    const documents = await h.call('/retrieval/documents');
    const noEvent = documents.items.find((item: any) => item.document_id === first.envelope.materialId);
    assert.deepEqual(noEvent.event_time, { state: 'not_applicable', value: null, precision: null, upper: null });
    assert.ok(noEvent.issues.includes('event_time_not_applicable'));

    // 系统持有：未来时点全部可见；事件“不适用”不构成门槛，事件“未知”仍被挡
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const held = await h.call('/retrieval/search', { method: 'keyword', query: '半导体', asOf: future });
    assert.equal(held.status, 'matched');
    assert.equal(held.qualification.mode, 'system_held_at');
    assert.equal(held.qualification.reconstruction, 'none');
    assert.deepEqual([...new Set(held.coverage.excluded.map((entry: any) => entry.reason))], ['event_time_unknown'],
      '事件未知的文档被挡，事件不适用的文档不被挡');

    // 严格系统回放：2024 年当时连索引都没有，如实报索引缺失（built_at 门槛对这条模式合理）
    const strictPast = await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2024-06-01T00:00:00Z' });
    assert.equal(strictPast.status, 'index_missing');
    assert.ok(strictPast.gaps.includes('no_index_at_as_of'));

    // 市场公开历史：同样的 2024 时点，已公开的来源可作事后重建，且标明是 post_hoc
    const market = await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2024-06-01T00:00:00Z', mode: 'market_known_at' });
    assert.equal(market.status, 'matched');
    assert.equal(market.qualification.mode, 'market_known_at');
    assert.equal(market.qualification.reconstruction, 'post_hoc');
    assert.deepEqual(market.coverage.excluded, []);

    // 市场模式下公开时间仍必须早于 as_of
    const beforeDisclosure = await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2024-01-01T00:00:00Z', mode: 'market_known_at' });
    assert.equal(beforeDisclosure.status, 'history_unavailable');
    assert.deepEqual([...new Set(beforeDisclosure.coverage.excluded.map((entry: any) => entry.reason))],
      ['disclosed_after_as_of']);

    const storage = await h.call('/retrieval/storage');
    assert.equal(storage.database.segments > 0, true);
    assert.equal(storage.database.textBytes > 0, true);
    assert.equal(storage.database.ftsTokenBytes, 0);
    assert.equal(storage.database.ftsIndexBytes > 0, true);
    assert.equal(storage.policy.automaticDeletion, false);
    assert.deepEqual(storage.policy.rebuildable, { segments: false, index: true });
  } finally { await h.close(); }
});

test('页图产物只登记不入索引；来源不符与未登记操作被拒；空索引报明确错误', async () => {
  const h = await host();
  try {
    const material = await h.material('report.pdf', 'upload-3');
    const source = { fileRefId: material.envelope.fileRefId, sha256: material.envelope.sha256 };
    const rendered = h.registerArtifact('rendered-1.json', envelope(source, 'conversion.pdf_render'));
    const registered = await h.settleIngest({ requestId: 'ingest-render',
      materialId: material.envelope.materialId, artifactRef: rendered.id });
    assert.equal(registered.status, 'succeeded', JSON.stringify(registered.error));
    assert.equal((registered.result?.data as any).segmented, false);
    assert.equal((registered.result?.data as any).reason, 'artifact_type_not_segmentable');

    const ledger = await h.call(`/retrieval/documents/${material.envelope.materialId}/artifacts`);
    assert.deepEqual(ledger.items.map((item: any) => item.artifact_type), ['conversion.pdf_render']);

    const foreign = h.registerArtifact('artifact-foreign.json',
      envelope({ fileRefId: 'file_someone_else', sha256: material.envelope.sha256 }));
    const mismatched = await h.settleIngest({ requestId: 'ingest-foreign',
      materialId: material.envelope.materialId, artifactRef: foreign.id });
    assert.equal(mismatched.status, 'failed');
    assert.equal(mismatched.error?.code, 'SEGMENT_ARTIFACT_MISMATCH');

    const madeUp = h.registerArtifact('artifact-unknown.json', envelope(source, 'conversion.made_up'));
    const unknown = await h.settleIngest({ requestId: 'ingest-unknown',
      materialId: material.envelope.materialId, artifactRef: madeUp.id });
    assert.equal(unknown.status, 'failed');
    assert.equal(unknown.error?.code, 'SEGMENT_ARTIFACT_OPERATION');

    // 声称的转换任务必须真的引用了这份产物；拿材料任务充数会被拒
    const wrongRun = await h.settleIngest({ requestId: 'ingest-run', materialId: material.envelope.materialId,
      artifactRef: rendered.id, conversionTaskId: material.envelope.taskId });
    assert.equal(wrongRun.status, 'failed');
    assert.equal(wrongRun.error?.code, 'SEGMENT_ARTIFACT_RUN_MISMATCH');

    assert.equal((await h.call('/retrieval/documents')).items.length, 0);
    const emptyIndex = await h.call('/retrieval/index', {}, 409);
    assert.match(String(emptyIndex.code), /SEGMENT_INDEX_EMPTY/u);
  } finally { await h.close(); }
});

test('R09 两个边界走真实 HTTP：版本收敛只答当时版本，月精度不提前放行', async () => {
  const h = await host();
  try {
    const material = await h.material('report.pdf', 'upload-rev');
    const source = { fileRefId: material.envelope.fileRefId, sha256: material.envelope.sha256 };

    // v1：2024 年 1 月公开的原始版本
    const original = h.registerArtifact('rev-v1.json', envelope(source, 'conversion.document', '半导体行业研究报告'));
    const first = await h.settleIngest({ requestId: 'ingest-v1', materialId: material.envelope.materialId,
      artifactRef: original.id, documentVersion: 'v1',
      disclosedAt: { state: 'known', value: '2024-01', precision: 'month' },
      eventTime: { state: 'not_applicable' } });
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));

    // v2：2025 年才发布的更正版本
    const corrected = h.registerArtifact('rev-v2.json', envelope(source, 'conversion.document', '更正后的正文一句'));
    const second = await h.settleIngest({ requestId: 'ingest-v2', materialId: material.envelope.materialId,
      artifactRef: corrected.id, documentVersion: 'v2',
      disclosedAt: { state: 'known', value: '2025-06-01T00:00:00Z' },
      eventTime: { state: 'not_applicable' } });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.error));

    // 边界二：只知道“2024 年 1 月”，1 月 15 日不能声称当时已公开
    const midJanuary = await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2024-01-15T00:00:00Z', mode: 'market_known_at' });
    assert.equal(midJanuary.status, 'history_unavailable');
    assert.deepEqual([...new Set(midJanuary.coverage.excluded.map((entry: any) => entry.reason))],
      ['disclosed_after_as_of']);

    // 整月过去后，v1 可见；v2 尚未发布，不得出现
    const afterMonth = await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2024-06-01T00:00:00Z', mode: 'market_known_at' });
    assert.equal(afterMonth.status, 'matched');
    assert.deepEqual([...new Set(afterMonth.citations.map((citation: any) => citation.document_version))], ['v1'],
      '边界一：2024 年时点只能拿到当时公开的 v1');

    // 更正发布后：只答 v2，v1 标为被取代
    const afterCorrection = await h.call('/retrieval/search', { method: 'keyword', query: '更正后',
      asOf: '2026-01-01T00:00:00Z', mode: 'market_known_at' });
    assert.equal(afterCorrection.status, 'matched');
    assert.deepEqual([...new Set(afterCorrection.citations.map((citation: any) => citation.document_version))], ['v2']);
    assert.deepEqual(afterCorrection.coverage.excluded, [{ document_id: material.envelope.materialId,
      document_version: 'v1', reason: 'superseded_by_revision' }]);
    assert.equal((await h.call('/retrieval/search', { method: 'keyword', query: '半导体',
      asOf: '2026-01-01T00:00:00Z', mode: 'market_known_at' })).citations.length, 0,
    '被取代的旧版本内容不再出现');
  } finally { await h.close(); }
});

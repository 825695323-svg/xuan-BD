import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import type { TaskExecutionContext, TaskOperation } from '../../../../platform/jobs/tasks.js';
import type { TaskRecord } from '../../../../contracts/task-contracts.js';
import { CoreDatabase } from '../../../../platform/state/database.js';
import { PermissionService } from '../../../../platform/security/permissions.js';
import { FileReferenceService } from '../../../../platform/resources/files.js';
import { SourceSettingsService } from '../../../../platform/config/source-settings.js';
import { createSourceRuntime } from '../../runtime.js';
import { WERSS_CACHE_LIMIT } from './cache.js';
import { acquireAuthority, directoryCapability, fileCapability } from '../../../../platform/runtime/file-workspace.js';
import { ConversationMaterialBridge } from '../../../../modules/collection/conversation-materials.js';
import { CoreModelTools } from '../../../../modules/agent/model-tools.js';
import { SkillRegistry } from '../../../../platform/plugins/registry.js';
import type { BackendInput } from '../../../../contracts/backend.js';
import type { PersonalCore } from '../../../../modules/agent/runtime/core.js';
import type { ModelTaskOrigin } from '../../../../modules/agent/model-tools.js';
import type { TaskService } from '../../../../platform/jobs/tasks.js';
import type { WorkspaceServices } from '../../../../contracts/workspace-services.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const item = (id: string) => ({ id, title: `缓存标题${id}`, description: null, link: null,
  updated: '2026-10-30T10:00:00+08:00', content: `<p>缓存正文${id}</p>`, channel_name: '测试',
  feed: { id: 'feed-1', name: null, cover: null, intro: null } });
const bytes = Buffer.from(JSON.stringify({ name: null, link: null, description: null, language: 'zh', cover: null,
  items: [item('a'), item('b')] }));

test('受控 WeRSS 缓存只请求固定路径，生成引用逐层核对并阻断跨分支/伪造', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-werss-runtime-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const requests: string[] = [];
  let mode: 'page' | 'empty' | 'redirect' | 'gzip' | 'rate' | 'badfeed' | 'oversize' = 'page';
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://mp.weixin.qq.com/forbidden' }); res.end('redirect'); return; }
    if (mode === 'rate') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"rate"}'); return; }
    if (mode === 'oversize') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(Buffer.alloc(WERSS_CACHE_LIMIT + 1, 0x20)); return; }
    if (mode === 'gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(gzipSync(bytes)); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mode === 'badfeed' ? Buffer.from(JSON.stringify({ name: null, link: null, description: null,
      language: 'zh', cover: null, items: [{ ...item('a'), feed: { id: 'other', name: null, cover: null, intro: null } }] }))
      : mode === 'empty' ? Buffer.from(JSON.stringify({ name: null, link: null, description: null,
      language: 'zh', cover: null, items: [] })) : bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    database.connection.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,action TEXT,args TEXT,status TEXT,result TEXT,versions TEXT,conversation_id TEXT);
      CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,parent_id TEXT);`);
    database.connection.prepare('INSERT INTO messages VALUES(?,?,?)').run('prior', 'conversation-1', null);
    database.connection.prepare('INSERT INTO messages VALUES(?,?,?)').run('current', 'conversation-1', 'prior');
    database.connection.prepare('INSERT INTO messages VALUES(?,?,?)').run('other', 'conversation-1', null);
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const files = new FileReferenceService({ database, permissions });
    permissions.grant({ capabilities: (['read', 'write', 'delete'] as const).map(action => directoryCapability(action, artifactRoot)) });
    const networkGrant = permissions.grant({ capabilities: [{ action: 'network', target: { kind: 'network', origin: baseUrl } }] });
    const settings = new SourceSettingsService(join(root, 'source-settings.json'), database);
    assert.equal(settings.get().plugins.find(plugin => plugin.id === 'werss')?.enabled, false);
    const initial = settings.get();
    const legacyCandidate = { ...initial, plugins: initial.plugins.filter(plugin => plugin.id !== 'werss') };
    const legacySaved = { ...legacyCandidate, revision: 2, updatedAt: '2026-10-30T00:00:00.000Z' };
    writeFileSync(settings.path, JSON.stringify(legacySaved));
    const legacyHash = (value: typeof legacyCandidate) => hash(Buffer.from(JSON.stringify({ ...value, updatedAt: null })));
    database.connection.prepare(`INSERT INTO source_settings_operations(request_id,content_hash,expected_revision,status,body,
      saved_revision,adopted_revision,result_hash,result_body,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('legacy-try-1', legacyHash(legacyCandidate), 1, 'saved', JSON.stringify(legacyCandidate), 2, null,
        legacyHash(legacySaved), JSON.stringify(legacySaved), null, legacySaved.updatedAt, legacySaved.updatedAt);
    assert.equal(settings.operation('legacy-try-1')?.status, 'adopted');
    assert.equal(settings.operation('legacy-try-1')?.actualMatches, true);
    const legacyFileBytes = readFileSync(settings.path);
    assert.equal(settings.update(legacyCandidate, 'legacy-try-1').revision, 2, 'exact historical replay is read-only');
    assert.ok(readFileSync(settings.path).equals(legacyFileBytes));
    const legacyRow = database.connection.prepare('SELECT body,result_body FROM source_settings_operations WHERE request_id=?')
      .get('legacy-try-1') as { body: string; result_body: string };
    assert.equal(legacyRow.body, JSON.stringify(legacyCandidate));
    assert.equal(legacyRow.result_body, JSON.stringify(legacySaved));
    const migrated = settings.get();
    assert.equal(migrated.plugins.find(plugin => plugin.id === 'werss')?.enabled, false, 'old settings remain disabled in memory');
    settings.update({ ...migrated, execution: { ...migrated.execution, minimumIntervalMs: 0 },
      plugins: migrated.plugins.map(plugin => plugin.id === 'werss' ? { ...plugin, enabled: true } : plugin),
      connections: [...initial.connections, { id: 'werss-test', pluginId: 'werss', alias: 'isolated cache', enabled: true,
        baseUrl, credential: null, scopes: [], feedIds: ['feed-1'] }] }, 'werss-config-1');
    assert.equal(settings.operation('legacy-try-1')?.actualMatches, false, 'new WeRSS connection changes current whole settings');
    const configured = settings.get();
    assert.throws(() => settings.update({ ...configured, connections: configured.connections.map(connection =>
      connection.id === 'werss-test' ? { ...connection, scopes: null } : connection) }, 'werss-bad-scope'),
    { code: 'SOURCE_SETTINGS_INVALID' });
    assert.throws(() => settings.update({ ...configured, policies: configured.policies.map(policy =>
      policy.scopeId === 'global' ? { ...policy, primary: 'werss-test' } : policy) }, 'werss-bad-market'),
    { code: 'SOURCE_SETTINGS_INVALID' });
    assert.throws(() => settings.update({ ...configured, connections: configured.connections.map(connection =>
      connection.id === 'werss-test' ? { ...connection, feedIds: Array.from({ length: 21 }, (_, index) => `feed-${index}`) } : connection) },
    'werss-too-many-feeds'), { code: 'SOURCE_SETTINGS_INVALID' });
    const source = createSourceRuntime({ settings, files, artifactRoot });
    const budgetCandidate = settings.get();
    const longId = `w${'x'.repeat(99)}`;
    settings.update({ ...budgetCandidate, connections: budgetCandidate.connections.map(connection => connection.id === 'werss-test'
      ? { ...connection, id: longId, alias: 'A'.repeat(200), feedIds: Array.from({ length: 20 }, (_, index) =>
        `f${String(index).padStart(2, '0')}${'x'.repeat(77)}`) } : connection) }, 'werss-option-budget');
    const descriptor = new SkillRegistry(source.registrations).get('source.werss.read');
    assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) < 23_000, 'maximum registered feeds remain within model action sharing budget');
    const budgetCurrent = settings.get();
    settings.update({ ...budgetCurrent, connections: budgetCurrent.connections.map(connection => connection.id === longId
      ? { ...connection, id: 'werss-test', alias: 'isolated cache', feedIds: ['feed-1'] } : connection) }, 'werss-option-restore');
    const args = { connectionId: 'werss-test', feedId: 'feed-1', limit: 2, offset: 0 };
    const registration = source.registrations.find(entry => entry.action === 'source.werss.read')!;
    assert.deepEqual(registration.fieldsForRequest!().slice(0, 2).map(field => field.options?.map(option => option.value)),
      [['werss-test'], ['feed-1']]);
    assert.deepEqual(registration.available(), { available: true });
    registration.validate!(args);
    assert.throws(() => registration.validate!({ ...args, feedId: 'unlisted-feed' }), { code: 'SOURCE_FEED_NOT_CONFIGURED' });
    const context = (taskId: string, action: string): TaskExecutionContext => {
      const runId = `run-${taskId}`, attemptId = `attempt-${taskId}`, generation = 1;
      const operationScope = (operation: TaskOperation) => ({ ...operation, runId, attemptId, generation });
      return { task: { id: taskId, action, args, conversationId: 'conversation-1' } as unknown as TaskRecord,
        runId, attemptId, generation, controlGeneration: null, signal: new AbortController().signal,
        emit: async () => {}, consumeBudget: () => {}, operationScope,
        assertAuthorized: (operation: Parameters<TaskExecutionContext['assertAuthorized']>[0],
          capabilities: Parameters<TaskExecutionContext['assertAuthorized']>[1],
          authorization: Parameters<TaskExecutionContext['assertAuthorized']>[2]) => permissions.assertAuthorized(operationScope(operation), capabilities, authorization),
        requestApproval: async () => { throw new Error('Unexpected approval request'); } } as unknown as TaskExecutionContext;
    };
    const result = await source.execute(context('source-1', 'source.werss.read'), 'source.werss.read', args);
    const data = result.data as Record<string, any>;
    assert.equal(data.status, 'received_page'); assert.equal(data.articleCount, 2);
    assert.deepEqual(requests, ['GET /feed/feed-1.json?ctype=html&limit=2&offset=0&is_update=false']);
    assert.equal(hash(readFileSync(files.getRef(data.rawRef).invocationPath)), hash(bytes));
    const table = JSON.parse(readFileSync(files.getRef(data.articleTableRef).invocationPath, 'utf8'));
    assert.deepEqual(table.map((row: any) => row.article_id), ['a', 'b']);
    assert.equal(table[0].description, null); assert.equal(table[0].visible_text, '缓存正文a');
    assert.deepEqual({ rawVersion: files.getRef(data.rawRef).version, expectedRawVersion: data.rawRefVersion,
      locatorVersion: files.getRef(data.locatorRef).version, expectedLocatorVersion: data.locatorRefVersion,
      receiptVersion: files.getRef(data.receiptRef).version, expectedReceiptVersion: data.receiptRefVersion,
      rawSize: files.getRef(data.rawRef).size, rawBytes: data.rawBytes, projectionVersion: data.projectionVersion,
      articleCount: data.articleCount, articleLength: data.articles.length },
    { rawVersion: data.rawRefVersion, expectedRawVersion: data.rawRefVersion,
      locatorVersion: data.locatorRefVersion, expectedLocatorVersion: data.locatorRefVersion,
      receiptVersion: data.receiptRefVersion, expectedReceiptVersion: data.receiptRefVersion,
      rawSize: data.rawBytes, rawBytes: data.rawBytes, projectionVersion: data.projectionVersion,
      articleCount: data.articleCount, articleLength: data.articleCount });
    database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run('source-1', 'source.werss.read', JSON.stringify(args),
      'succeeded', JSON.stringify(result), '{}', 'conversation-1');
    database.connection.prepare('INSERT INTO task_runs VALUES(?,?)').run('opaque-source-result', 'source-1');
    const origin = (messageId: string, branchId = 'branch-1'): ModelTaskOrigin => ({ callId: 'call-1', conversationId: 'conversation-1',
      branchId, parentRunId: 'run-1', parentGeneration: 1, inputId: 'input-1', messageId,
      modelDigest: 'model-1', endpointDigest: 'endpoint-1', toolCallId: 'tool-1', toolName: 'perform_action',
      notice: '', receiver: { provider: 'test', model: 'test', origin: 'test' } });
    const origins = new Map([['source-1', origin('prior')], ['material-1', origin('current')]]);
    const messages = new Map([['prior', { conversation_id: 'conversation-1', parent_id: null }],
      ['current', { conversation_id: 'conversation-1', parent_id: 'prior' }],
      ['other', { conversation_id: 'conversation-1', parent_id: null }]]);
    const core = { selectedAttachmentsForInput: () => [{ fileRefId: data.articleTableRef, version: 1, category: 'unclassified' }],
      store: { command: () => ({ text: '整理缓存文章' }), message: (id: string) => messages.get(id) } } as unknown as PersonalCore;
    const bridge = new ConversationMaterialBridge({ database, core, files, companion: {} as WorkspaceServices,
      origin: id => origins.get(id) ?? null, assertPath: () => {} });
    const sourceTask = { id: 'source-1', action: 'source.werss.read', status: 'succeeded', requiresReview: false,
      ownerRole: 'personal', conversationId: 'conversation-1', resultRef: 'task-result:opaque-source-result', result } as TaskRecord;
    const modelTools = new CoreModelTools({ database, core: { isRunActive: () => true } as unknown as PersonalCore,
      permissions, files, registry: new SkillRegistry([...bridge.registrations, { action: 'file.read', title: 'read', description: 'read',
        fields: [{ key: 'fileRefId', label: 'file', type: 'file', required: true }], runtimeId: 'direct', kind: 'direct',
        modelCalls: 0, permissionSummary: [], available: () => ({ available: true }) }]),
      getTasks: () => ({ get: (id: string) => { if (id !== 'source-1') throw new Error('Wrong task ID lookup'); return sourceTask; },
        list: () => [sourceTask] } as unknown as TaskService),
      ensureModelChannel: () => [{ action: 'network', target: { kind: 'network', origin: 'https://model.example.org' } }],
      selectedAttachmentsForInput: () => [], canSelectGeneratedMaterial: (id, input) => bridge.canSelectGeneratedMaterial(id, input) });
    database.connection.prepare(`INSERT INTO model_tool_calls(id,conversation_id,branch_id,parent_run_id,parent_generation,input_id,
      message_id,tool_call_id,tool_name,action,args_json,payload_digest,model_json,model_digest,selection_json,task_request_id,
      task_id,ticket_json,preview_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('source-model-call', 'conversation-1', 'branch-1', 'old-run', 1, 'old-input', 'prior', 'old-tool',
        'perform_action', 'source.werss.read', JSON.stringify(args), 'old-payload',
        JSON.stringify({ provider: 'fixture', model: 'fixture', baseUrl: 'https://model.example.org', endpointDigest: 'fixture' }),
        'old-model-digest', '[]', 'model-tool:old', 'source-1', null, null, 'returned', Date.now(), Date.now());
    const reserveInput: BackendInput = { conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'current',
      runId: 'new-run', generation: 1, inputId: 'new-input', text: '整理缓存文章' };
    const factory = { getCurrentInput: () => reserveInput,
      model: { provider: 'fixture', model: 'fixture', baseUrl: 'https://model.example.org' } };
    await assert.rejects(modelTools['personalTool'](factory as never, 'wrong-result-ref', 'core_task_get',
      { taskId: sourceTask.resultRef }), { code: 'MODEL_TASK_ID_REQUIRED' });
    await assert.rejects(modelTools['personalTool'](factory as never, 'wrong-result-suffix', 'core_task_get',
      { taskId: 'opaque-source-result' }), { code: 'MODEL_TASK_ID_REQUIRED' });
    const readback = await modelTools['personalTool'](factory as never, 'correct-source-id', 'core_task_get', { taskId: sourceTask.id });
    const readbackTask = (JSON.parse((readback.content[0] as { text: string }).text) as { task: any }).task;
    assert.equal(readbackTask.id, sourceTask.id); assert.equal(readbackTask.resultRefIsTaskId, false);
    assert.deepEqual(readbackTask.sourceMaterialCandidates.items.map((entry: any) => entry.role),
      ['article-table', 'visible-text', 'visible-text']);
    assert.equal(readbackTask.sourceMaterialCandidates.items[0].fileRefId, data.articleTableRef);
    const otherBranchFactory = { ...factory, getCurrentInput: () => ({ ...reserveInput, branchId: 'other-branch' }) };
    const otherBranch = await modelTools['personalTool'](otherBranchFactory as never, 'other-branch-id', 'core_task_get', { taskId: sourceTask.id });
    assert.equal((JSON.parse((otherBranch.content[0] as { text: string }).text) as { task: any }).task.sourceMaterialCandidates, undefined);
    const nonAncestorFactory = { ...factory, getCurrentInput: () => ({ ...reserveInput, messageId: 'other' }) };
    const nonAncestor = await modelTools['personalTool'](nonAncestorFactory as never, 'non-ancestor-id', 'core_task_get', { taskId: sourceTask.id });
    assert.equal((JSON.parse((nonAncestor.content[0] as { text: string }).text) as { task: any }).task.sourceMaterialCandidates, undefined);
    let reserveIndex = 0;
    const reserve = (id: string, branchId = 'branch-1', action = 'material.read') => modelTools['reserve']({ ...reserveInput, branchId },
      `tool-${++reserveIndex}`, 'perform_action', action, { fileRefId: id }, `fixture-${reserveIndex}`,
      { provider: 'fixture', model: 'fixture', baseUrl: 'https://model.example.org', endpointDigest: 'fixture', capabilities: [] } as never,
      'fixture-model-digest');
    assert.equal(JSON.parse(reserve(data.articleTableRef).selection_json)[0].id, data.articleTableRef);
    assert.throws(() => reserve(data.articleTableRef, 'other-branch'), { code: 'MODEL_FILE_NOT_SELECTED' });
    assert.throws(() => reserve(data.rawRef), { code: 'MODEL_FILE_NOT_SELECTED' });
    assert.throws(() => reserve(data.rawRef, 'branch-1', 'file.read'), { code: 'MODEL_FILE_NOT_SELECTED' });
    assert.throws(() => reserve(data.articleTableRef, 'other-branch', 'file.read'), { code: 'MODEL_FILE_NOT_SELECTED' });
    const listing = modelTools['reserve'](reserveInput, `tool-${++reserveIndex}`, 'list_attached_files',
      'model.files.metadata', { query: '', limit: 50 }, `fixture-${reserveIndex}`,
      { provider: 'fixture', model: 'fixture', baseUrl: 'https://model.example.org', endpointDigest: 'fixture', capabilities: [] } as never,
      'fixture-model-digest');
    const listedIds = (JSON.parse(listing.selection_json) as Array<{ id: string }>).map(entry => entry.id);
    assert.ok(listedIds.includes(data.articleTableRef));
    for (const id of [data.rawRef, data.locatorRef, data.receiptRef, data.articles[0].htmlRef]) assert.ok(!listedIds.includes(id));
    const tableEvidence = bridge['generatedMaterial'](data.articleTableRef, origin('current'))?.werss;
    assert.ok(tableEvidence); assert.equal(tableEvidence.kind, 'article-table');
    const authority = await acquireAuthority(context('material-1', 'material.read'), 'material.read', { fileRefId: data.articleTableRef },
      [tableEvidence.body, tableEvidence.raw, tableEvidence.locator, tableEvidence.receipt].map(ref => fileCapability('read', ref.invocationPath)));
    const verified = await bridge['verifyWerssMaterial'](context('material-1', 'material.read'), tableEvidence, authority);
    assert.equal(hash(verified), data.articleTableSha256);
    assert.equal(bridge.canSelectGeneratedMaterial(data.articleTableRef, origin('current', 'other-branch')), false);
    assert.equal(bridge.canSelectGeneratedMaterial(data.articleTableRef, origin('other')), false);
    await assert.rejects(bridge.execute(context('material-1', 'material.read'), 'material.read', { fileRefId: data.rawRef }),
      { code: 'MATERIAL_WERSS_BODY_REQUIRED' });
    origins.set('material-1', origin('current', 'other-branch'));
    await assert.rejects(bridge.execute(context('material-1', 'material.read'), 'material.read', { fileRefId: data.articleTableRef }),
      { code: 'MATERIAL_NOT_SELECTED' });
    origins.set('material-1', origin('current'));
    const forged = structuredClone(result); (forged.data as Record<string, any>).rawSha256 = '0'.repeat(64);
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(forged), 'source-1');
    const forgedEvidence = bridge['generatedMaterial'](data.articleTableRef, origin('current'))?.werss;
    assert.ok(forgedEvidence);
    await assert.rejects(bridge['verifyWerssMaterial'](context('material-1', 'material.read'), forgedEvidence, authority),
      { code: 'MATERIAL_WERSS_PROVENANCE' });
    mode = 'empty';
    const empty = await source.execute(context('source-empty', 'source.werss.read'), 'source.werss.read', args);
    assert.equal((empty.data as Record<string, any>).status, 'received_empty');
    assert.equal((empty.data as Record<string, any>).articleTableRef, null);
    assert.equal(empty.artifactIds?.length, 3);
    mode = 'redirect';
    await assert.rejects(source.execute(context('source-redirect', 'source.werss.read'), 'source.werss.read', args),
      { code: 'WERSS_RESPONSE_REJECTED' });
    const redirectRefs = files.getRefs({ taskId: 'source-redirect' });
    assert.equal(redirectRefs.length, 2, 'redirect body and rejection receipt are retained without following Location');
    assert.equal(JSON.parse(readFileSync(redirectRefs.find(ref => ref.displayName.endsWith('receipt.json'))!.invocationPath, 'utf8')).reason,
      'redirect_not_followed');
    mode = 'gzip';
    await assert.rejects(source.execute(context('source-gzip', 'source.werss.read'), 'source.werss.read', args),
      { code: 'WERSS_RESPONSE_REJECTED' });
    const gzipRefs = files.getRefs({ taskId: 'source-gzip' });
    assert.equal(hash(readFileSync(gzipRefs.find(ref => ref.displayName.endsWith('raw.json'))!.invocationPath)), hash(gzipSync(bytes)),
      'compressed entity bytes stay unmodified and are rejected');
    assert.equal(JSON.parse(readFileSync(gzipRefs.find(ref => ref.displayName.endsWith('receipt.json'))!.invocationPath, 'utf8')).reason,
      'compressed_response_not_decoded');
    mode = 'rate';
    await assert.rejects(source.execute(context('source-rate', 'source.werss.read'), 'source.werss.read', args),
      { code: 'SOURCE_RATE_LIMITED' });
    assert.equal(files.getRefs({ taskId: 'source-rate' }).length, 2);
    mode = 'badfeed';
    await assert.rejects(source.execute(context('source-badfeed', 'source.werss.read'), 'source.werss.read', args),
      { code: 'WERSS_FEED_MISMATCH' });
    const badfeedReceipt = files.getRefs({ taskId: 'source-badfeed' }).find(ref => ref.displayName.endsWith('receipt.json'));
    assert.ok(badfeedReceipt);
    assert.equal(JSON.parse(readFileSync(badfeedReceipt.invocationPath, 'utf8')).reason, 'WERSS_FEED_MISMATCH');
    mode = 'oversize';
    await assert.rejects(source.execute(context('source-oversize', 'source.werss.read'), 'source.werss.read', args),
      { code: 'WERSS_RESPONSE_BUDGET' });
    assert.equal(files.getRefs({ taskId: 'source-oversize' }).length, 0, 'over-budget body is never retained as a complete raw or article');
    const countWithNetwork = requests.length;
    assert.equal(permissions.revoke(networkGrant.id), true);
    await assert.rejects(source.execute(context('source-no-network', 'source.werss.read'), 'source.werss.read', args),
      /Unexpected approval request/u);
    assert.equal(requests.length, countWithNetwork, 'network permission denial blocks before HTTP GET');
    assert.equal(files.getRefs({ taskId: 'source-no-network' }).length, 0);
    assert.ok(requests.every(request => request === 'GET /feed/feed-1.json?ctype=html&limit=2&offset=0&is_update=false'));
    const enabled = settings.get();
    settings.update({ ...enabled, plugins: enabled.plugins.map(plugin => plugin.id === 'werss' ? { ...plugin, enabled: false } : plugin) },
      'werss-config-off');
    await assert.rejects(source.execute(context('source-disabled', 'source.werss.read'), 'source.werss.read', args),
      { code: 'SOURCE_DISABLED' });
    assert.equal(requests.length, 7, 'disabled configuration blocks before any network request');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
});

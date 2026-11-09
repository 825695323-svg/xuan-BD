import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestOperationArgs, type AuthorizationReceipt } from '../../platform/security/permissions.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { acquireAuthority, directoryCapability, fileCapability } from '../../platform/runtime/file-workspace.js';
import { extractPublicWebHtml, publishRawPage, publishRawPdf } from '../../platform/capabilities/browser/raw-page.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { BackendInput } from '../../contracts/backend.js';
import type { TaskExecutionContext, TaskOperation } from '../../platform/jobs/tasks.js';
import { SkillRegistry } from '../../platform/plugins/registry.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { CoreModelTools } from '../agent/model-tools.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { ConversationMaterialBridge, authorizedMaterialAdoption } from './conversation-materials.js';

const operation = {
  runId: 'run-1', attemptId: 'attempt-1', generation: 1,
  operationId: 'model.material.process', operationVersion: 1,
  argsDigest: 'a'.repeat(64), targets: [{ kind: 'file' as const, path: '/selected/material.csv' }],
};

test('材料语义自动授权可冻结为完整 JSON，且保留真实自动回执', () => {
  const receipt: AuthorizationReceipt = { policyVersion: 1, operation: { ...operation, approvalMode: 'automatic' },
    grantIds: [], approvalId: null };
  const adoption = authorizedMaterialAdoption('message-1', receipt);
  assert.equal(Object.hasOwn(adoption, 'approvalId'), false);
  assert.deepEqual(adoption, { kind: 'authorized-rule', operationId: operation.operationId,
    argsDigest: operation.argsDigest, requestMessageId: 'message-1', grantIds: [], authorization: receipt });
  assert.throws(() => digestOperationArgs({ ...adoption, approvalId: undefined }), { code: 'INVALID_ARGUMENTS' });
  assert.match(digestOperationArgs({ proposalId: 'proposal-1', adoption }), /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(adoption)), adoption);
});

test('材料语义显式批准保留审批编号而不伪造自动回执', () => {
  const receipt: AuthorizationReceipt = { policyVersion: 1, operation: { ...operation, approvalMode: 'review' },
    grantIds: [], approvalId: 'approval-1' };
  const adoption = authorizedMaterialAdoption('message-1', receipt);
  assert.equal(adoption.kind, 'authorized-rule');
  assert.equal(adoption.approvalId, 'approval-1');
  assert.equal(Object.hasOwn(adoption, 'authorization'), false);
  assert.match(digestOperationArgs({ proposalId: 'proposal-1', adoption }), /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(adoption)), adoption);
});

test('材料语义回执区分服务任务、本地提案、业务状态和正式交付', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-semantic-view-')));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    database.connection.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
    database.connection.prepare('INSERT INTO tasks(id) VALUES(?)').run('local-process');
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const files = new FileReferenceService({ database, permissions });
    const path = join(root, 'source.html');
    writeFileSync(path, '<html>partial article</html>');
    const reference = files.register({ path, source: 'user-attached', conversationId: 'conversation-1' });
    permissions.grant({ capabilities: [fileCapability('read', path)] });
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const materialId = 'material-1', serviceTaskId = 'semantic-1', proposalId = 'proposal-1';
    let reject = false;
    const record = { envelope: { proposalId, serviceTaskId, materialId, originalSha256: sha256 },
      result: { status: 'needs_adapter', applied: false, formalIngest: false } };
    const origin: ModelTaskOrigin = { callId: 'call-1', conversationId: 'conversation-1', branchId: 'branch-1',
      parentRunId: 'run-1', parentGeneration: 1, inputId: 'input-1', messageId: 'message-1',
      modelDigest: 'model-1', endpointDigest: 'endpoint-1', toolCallId: 'tool-1', toolName: 'perform_action',
      notice: '', receiver: { provider: 'test', model: 'test', origin: 'test' } };
    const core = { selectedAttachmentsForInput: () => [{ fileRefId: reference.id, version: reference.version, category: 'unclassified' }],
      store: { command: () => ({ text: '整理这份网页材料' }), message: () => ({ conversation_id: 'conversation-1',
        role: 'user', text: '整理这份网页材料', parent_id: null }) } } as unknown as PersonalCore;
    const companion = { bd: { assertDispatch: () => {} }, tasks: {
      get: () => ({ args: { category: 'unclassified' } }), wait: async () => ({ id: serviceTaskId, status: 'succeeded' }),
    }, semantics: { submitProposal: () => {
      if (reject) throw Object.assign(new Error('evidence mismatch'), { code: 'MATERIAL_EVIDENCE_MISMATCH' });
      return { id: serviceTaskId };
    }, getByTask: () => record,
      modelPreview: () => ({ proposalId, materialId, serviceTaskId, status: 'needs_adapter', applied: false,
        persistence: 'not_requested', knownValues: [], rowCount: 0, columns: [] }) } } as unknown as WorkspaceServices;
    const bridge = new ConversationMaterialBridge({ database, core, files, companion,
      origin: () => origin, assertPath: () => {} });
    database.connection.prepare('INSERT INTO conversation_material_links VALUES(?,?,?,?,?,?,?)')
      .run(materialId, 'receive-1', sha256, reference.id, reference.version, JSON.stringify(origin), Date.now());
    const context = { task: { id: 'local-process', action: 'material.process' }, runId: 'run-1', attemptId: 'attempt-1', generation: 1,
      signal: new AbortController().signal, emit: async () => {},
      operationScope: (operation: TaskOperation) => ({ ...operation, runId: 'run-1', attemptId: 'attempt-1', generation: 1 }),
      assertAuthorized: (operation: TaskOperation, capabilities: any, options: any) => permissions.assertAuthorized(
        { ...operation, runId: 'run-1', attemptId: 'attempt-1', generation: 1 }, capabilities, options),
    } as unknown as TaskExecutionContext;
    const result = await bridge.execute(context, 'material.process', { fileRefId: reference.id, materialId,
      proposalJson: JSON.stringify({ materialId, originalSha256: sha256 }) });
    const view = (result.data as Record<string, any>).modelPreview;
    assert.equal(view.semanticTaskId, serviceTaskId);
    assert.equal(view.semanticTaskStatus, 'succeeded');
    assert.deepEqual(view.localProposal, { status: 'saved', readback: 'verified', proposalId });
    assert.equal(view.status, 'needs_adapter');
    assert.equal(view.applied, false);
    assert.equal(view.formalIngest, false);
    assert.equal(Object.hasOwn(view, 'persistence'), false);
    reject = true;
    const rejected = await bridge.execute(context, 'material.process', { fileRefId: reference.id, materialId,
      proposalJson: JSON.stringify({ materialId, originalSha256: sha256 }) });
    const rejectedView = (rejected.data as Record<string, any>).modelPreview;
    assert.equal(rejectedView.status, 'proposal_rejected');
    assert.equal(rejectedView.semanticTaskId, null);
    assert.equal(rejectedView.semanticTaskStatus, 'not_created');
    assert.deepEqual(rejectedView.localProposal, { status: 'rejected', readback: 'not_applicable' });
    assert.equal(rejectedView.applied, false);
    assert.equal(rejectedView.formalIngest, false);
    const tools = new CoreModelTools({ database, core, permissions, files, registry: new SkillRegistry(bridge.registrations),
      getTasks: () => { throw new Error('No task lookup needed for replay projection.'); }, ensureModelChannel: () => [] });
    const legacy = structuredClone(result);
    const legacyData = legacy.data as Record<string, any>, legacyPreview = legacyData.modelPreview;
    delete legacyPreview.semanticTaskId; delete legacyPreview.semanticTaskStatus; delete legacyPreview.localProposal;
    delete legacyPreview.formalIngest; legacyPreview.persistence = 'not_requested';
    const replay = tools['materialProcessReplay']({ id: 'local-process', status: 'succeeded', requiresReview: false, result: legacy } as TaskRecord);
    assert.equal((replay.data as Record<string, any>).localProposal.status, 'saved');
    assert.equal((replay.data as Record<string, any>).localProposal.readback, 'task_result');
    assert.equal((replay.data as Record<string, any>).status, 'needs_adapter');
    assert.equal((replay.data as Record<string, any>).formalIngest, false);
    assert.equal(Object.hasOwn(replay.data as object, 'persistence'), false);
    const mismatched = structuredClone(legacy);
    ((mismatched.data as Record<string, any>).semanticRecord.envelope as Record<string, unknown>).originalSha256 = '0'.repeat(64);
    const mismatchView = tools['materialProcessReplay']({ id: 'local-process', status: 'succeeded', requiresReview: false, result: mismatched } as TaskRecord);
    assert.equal((mismatchView.data as Record<string, any>).localProposal.status, 'unknown');
    const missing = structuredClone(legacy);
    delete (missing.data as Record<string, any>).semanticRecord;
    const missingView = tools['materialProcessReplay']({ id: 'local-process', status: 'succeeded', requiresReview: false, result: missing } as TaskRecord);
    assert.equal((missingView.data as Record<string, any>).localProposal.status, 'unknown');
    assert.equal((missingView.data as Record<string, any>).semanticTaskStatus, 'unknown');
    const failedView = tools['materialProcessReplay']({ id: 'local-process', status: 'failed', requiresReview: false, result: legacy } as TaskRecord);
    assert.equal((failedView.data as Record<string, any>).localProposal.status, 'unknown');
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('网页正文只接续同分支祖先成功任务，并核对三份产物、定位与状态', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-web-material-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    database.connection.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,action TEXT,args TEXT,status TEXT,result TEXT,versions TEXT)');
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const files = new FileReferenceService({ database, permissions });
    permissions.grant({ capabilities: ['read', 'write', 'delete'].map(action =>
      directoryCapability(action as 'read' | 'write' | 'delete', artifactRoot)) });
    const url = 'https://public.example.org/article';
    const origins = new Map<string, ModelTaskOrigin>();
    const origin = (messageId: string, branchId = 'branch-1'): ModelTaskOrigin => ({
      callId: 'call-1', conversationId: 'conversation-1', parentRunId: 'run-1', parentGeneration: 1,
      inputId: 'input-1', branchId, messageId, modelDigest: 'model-1', endpointDigest: 'endpoint-1',
      toolCallId: 'tool-1', toolName: 'perform_action', notice: '', receiver: { provider: 'test', model: 'test', origin: 'test' },
    });
    const messages = new Map([
      ['prior', { conversation_id: 'conversation-1', parent_id: null }],
      ['assistant', { conversation_id: 'conversation-1', parent_id: 'prior' }],
      ['current', { conversation_id: 'conversation-1', parent_id: 'assistant' }],
      ['unrelated', { conversation_id: 'conversation-1', parent_id: null }],
    ]);
    let selectedId = '';
    const core = { selectedAttachmentsForInput: () => selectedId ? [{ fileRefId: selectedId, version: 1, category: 'unclassified' }] : [],
      store: { command: () => ({ text: '继续整理网页材料' }),
        message: (id: string) => { const message = messages.get(id); assert.ok(message); return message; } } } as unknown as PersonalCore;
    const bridge = new ConversationMaterialBridge({ database, core, files, companion: {} as WorkspaceServices,
      origin: taskId => origins.get(taskId) ?? null, assertPath: () => {} });
    const context = (taskId: string): TaskExecutionContext => {
      const runId = 'run-1', attemptId = `attempt-${taskId}`, generation = 1;
      const operationScope = (operation: TaskOperation) => ({ ...operation, runId, attemptId, generation });
      return { task: { id: taskId, action: 'web.read_public', args: { url }, conversationId: 'conversation-1' } as unknown as TaskRecord,
        runId, attemptId, generation, controlGeneration: null, signal: new AbortController().signal,
        emit: async () => {}, consumeBudget: () => { throw new Error('Unexpected budget use.'); }, operationScope,
        assertAuthorized: (operation, capabilities, options) => permissions.assertAuthorized(operationScope(operation), capabilities, options),
        requestApproval: async () => { throw new Error('Unexpected approval request.'); } };
    };
    const publish = async (taskId: string, html: string, finalURL = url) => {
      const bytes = Buffer.from(html);
      const result = await publishRawPage(context(taskId), files, artifactRoot, { action: 'web.read_public', sourceURL: url,
        finalURL, bytes, contentType: 'text/html', charset: 'utf-8', sourceKind: 'http-response',
        httpStatus: 200, extraction: extractPublicWebHtml(html) });
      database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId, 'web.read_public', JSON.stringify({ url }),
        'succeeded', JSON.stringify(result), '{}');
      origins.set(taskId, origin('prior'));
      return result;
    };
    const current = origin('current');
    origins.set('current-task', current);
    const complete = await publish('web-complete', '<html><body><main><p>Real article body</p></main></body></html>');
    const data = complete.data as Record<string, unknown>, bodyId = String(data.textRef);
    const selectedPath = join(artifactRoot, 'current-attachment.csv'); writeFileSync(selectedPath, 'a,b\n1,2\n');
    const selected = files.register({ path: selectedPath, source: 'user-attached', conversationId: 'conversation-1' });
    const modelTools = new CoreModelTools({ database, core: { isRunActive: () => true } as unknown as PersonalCore,
      permissions, files, registry: new SkillRegistry([...bridge.registrations, { action: 'file.read', title: 'read', description: 'read',
        fields: [{ key: 'fileRefId', label: 'file', type: 'file', required: true }], runtimeId: 'direct', kind: 'direct',
        modelCalls: 0, permissionSummary: [], available: () => ({ available: true }) }]), getTasks: () => { throw new Error('No unresolved tasks.'); },
      ensureModelChannel: () => [], selectedAttachmentsForInput: () => [{ fileRefId: selected.id, version: selected.version }],
      canSelectGeneratedMaterial: (id, input) => bridge.canSelectGeneratedMaterial(id, input) });
    const reserveInput: BackendInput = { conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'current',
      runId: 'new-run', generation: 1, inputId: 'new-input', text: '继续处理正文，同时附上另一文件' };
    let reserveSequence = 0;
    const reserve = (id: string, branchId = 'branch-1', action = 'material.read') => modelTools['reserve']({ ...reserveInput, branchId },
      `tool-${++reserveSequence}`, 'perform_action', action, { fileRefId: id }, 'fixture-digest',
      { provider: 'fixture', model: 'fixture', baseUrl: 'https://model.example.org', endpointDigest: 'fixture', capabilities: [] } as never,
      'fixture-model-digest');
    const reserved = reserve(bodyId);
    assert.equal(JSON.parse(reserved.selection_json)[0].id, bodyId, '有当前附件时旧正文仍按精确引用承接');
    assert.throws(() => reserve(bodyId, 'branch-2'), { code: 'MODEL_FILE_NOT_SELECTED' });
    assert.throws(() => reserve(bodyId, 'branch-1', 'file.read'), { code: 'MODEL_FILE_NOT_SELECTED' });
    const generated = bridge['generatedMaterial'](bodyId, current);
    assert.ok(generated?.web); assert.equal(generated.web.status, 'complete');
    assert.equal(bridge.canSelectGeneratedMaterial(bodyId, current), true);
    assert.equal(bridge.canSelectGeneratedMaterial(bodyId, origin('current', 'branch-2')), false);
    const ctx = context('verify');
    const authority = await acquireAuthority(ctx, 'material.read', { fileRefId: bodyId },
      [generated.web.body, generated.web.raw, generated.web.locator].map(ref => fileCapability('read', ref.invocationPath)));
    assert.equal((await bridge['verifyWebMaterial'](ctx, generated.web, authority)).toString(), 'Real article body');
    assert.equal(bridge['generatedMaterial'](bodyId, origin('current', 'branch-2')), undefined);
    assert.equal(bridge['generatedMaterial'](bodyId, origin('unrelated')), undefined);
    assert.throws(() => bridge['generatedMaterial'](String(data.rawRef), current), { code: 'MATERIAL_WEB_BODY_REQUIRED' });
    assert.throws(() => bridge['generatedMaterial'](String(data.locatorRef), current), { code: 'MATERIAL_WEB_BODY_REQUIRED' });
    const badHash = structuredClone(complete); (badHash.data as Record<string, unknown>).textSha256 = '0'.repeat(64);
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(badHash), 'web-complete');
    const corrupt = bridge['generatedMaterial'](bodyId, current);
    assert.ok(corrupt?.web);
    await assert.rejects(bridge['verifyWebMaterial'](ctx, corrupt.web, authority), { code: 'MATERIAL_WEB_PROVENANCE' });
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(complete), 'web-complete');
    const badSource = structuredClone(complete); (badSource.data as Record<string, unknown>).sourceURL = 'https://other.example.org/article';
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(badSource), 'web-complete');
    assert.throws(() => bridge['generatedMaterial'](bodyId, current), { code: 'MATERIAL_WEB_PROVENANCE' });
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(complete), 'web-complete');
    const originalLocator = JSON.parse(readFileSync(files.getRef(String(data.locatorRef)).invocationPath, 'utf8')) as Record<string, unknown>;
    const falseLocatorPath = join(artifactRoot, 'false-source.json');
    writeFileSync(falseLocatorPath, JSON.stringify({ ...originalLocator, sourceURL: 'https://other.example.org/article' }));
    const falseLocator = files.register({ path: falseLocatorPath, source: 'generated', taskId: 'web-complete' });
    const falseLocatorResult = structuredClone(complete), falseData = falseLocatorResult.data as Record<string, unknown>;
    falseLocatorResult.artifactIds = [...falseLocatorResult.artifactIds!.filter(id => id !== data.locatorRef), falseLocator.id];
    falseData.locatorRef = falseLocator.id; falseData.locatorRefVersion = falseLocator.version;
    falseData.locatorSha256 = createHash('sha256').update(readFileSync(falseLocatorPath)).digest('hex');
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(falseLocatorResult), 'web-complete');
    const falseCandidate = bridge['generatedMaterial'](bodyId, current);
    assert.ok(falseCandidate?.web);
    const falseAuthority = await acquireAuthority(ctx, 'material.read', { fileRefId: bodyId },
      [falseCandidate.web.body, falseCandidate.web.raw, falseCandidate.web.locator].map(ref => fileCapability('read', ref.invocationPath)));
    await assert.rejects(bridge['verifyWebMaterial'](ctx, falseCandidate.web, falseAuthority), { code: 'MATERIAL_WEB_PROVENANCE' });
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(complete), 'web-complete');
    const oldResult = structuredClone(complete); delete (oldResult.data as Record<string, unknown>).textSha256;
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(oldResult), 'web-complete');
    assert.equal(bridge.canSelectGeneratedMaterial(bodyId, current), true, '旧网页任务仍进入桥给出明确重读原因');
    assert.throws(() => bridge['generatedMaterial'](bodyId, current), { code: 'MATERIAL_WEB_PROVENANCE' });
    const partial = await publish('web-partial', '<html><body><main><p>Static portion</p></main><script>loadMore()</script></body></html>');
    const partialCandidate = bridge['generatedMaterial'](String((partial.data as Record<string, unknown>).textRef), current);
    assert.equal(partialCandidate?.web?.status, 'partial');
    assert.ok(partialCandidate?.web?.reasons.includes('script-content-not-executed'));
    const deceptive = structuredClone(partial);
    (deceptive.data as Record<string, unknown>).finalURL = 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?token=redacted';
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(deceptive), 'web-partial');
    assert.throws(() => bridge['generatedMaterial'](String((partial.data as Record<string, unknown>).textRef), current), { code: 'MATERIAL_WEB_GATE' });
    const wechat = await publish('web-wechat-gate', '<html><body>环境异常，请先完成验证后再继续访问<script>check()</script></body></html>',
      'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?redirect=article');
    assert.equal((wechat.data as Record<string, unknown>).status, 'captcha');
    assert.ok(((wechat.data as Record<string, unknown>).reasons as string[]).includes('captcha-gate-url-observed'));
    assert.throws(() => bridge['generatedMaterial'](String((wechat.data as Record<string, unknown>).textRef), current), { code: 'MATERIAL_WEB_GATE' });
    const captcha = await publish('web-captcha', '<html><head><title>Captcha</title></head><body><form action="/captcha">Verify</form></body></html>');
    assert.throws(() => bridge['generatedMaterial'](String((captcha.data as Record<string, unknown>).textRef), current), { code: 'MATERIAL_WEB_GATE' });
    selectedId = String((captcha.data as Record<string, unknown>).textRef);
    await assert.rejects(bridge.execute(context('current-task'), 'material.read', { fileRefId: selectedId }), { code: 'MATERIAL_WEB_GATE' });
    const login = await publish('web-login', '<html><head><title>Sign in</title></head><body><input type="password"></body></html>');
    assert.throws(() => bridge['generatedMaterial'](String((login.data as Record<string, unknown>).textRef), current), { code: 'MATERIAL_WEB_GATE' });
    const pdf = await publishRawPdf(context('web-pdf'), files, artifactRoot, { kind: 'pdf', action: 'web.read_public',
      sourceURL: url, finalURL: url, bytes: Buffer.from('%PDF-1.7\n%%EOF\n'), contentType: 'application/pdf',
      sourceKind: 'http-response', httpStatus: 200 });
    database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('web-pdf', 'web.read_public', JSON.stringify({ url }),
      'succeeded', JSON.stringify(pdf), '{}');
    origins.set('web-pdf', origin('prior'));
    assert.throws(() => bridge['generatedMaterial'](String((pdf.data as Record<string, unknown>).rawRef), current),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'MATERIAL_WEB_BODY_REQUIRED'
        && /无正文引用/u.test((error as { message?: string }).message ?? ''));
    const convertedPath = join(artifactRoot, 'converted.json'); writeFileSync(convertedPath, '{"rows":[]}');
    const converted = files.register({ path: convertedPath, source: 'generated', taskId: 'conversion-1', conversationId: 'conversation-1' });
    database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('conversion-1', 'conversion.structured', '{}',
      'succeeded', JSON.stringify({ summary: 'converted', artifactIds: [converted.id] }), '{}');
    origins.set('conversion-1', origin('prior'));
    const existingConversion = bridge['generatedMaterial'](converted.id, current);
    assert.equal(existingConversion?.processingTask.action, 'conversion.structured');
    assert.equal(existingConversion?.web, undefined);
    assert.equal(bridge.canSelectGeneratedMaterial(converted.id, current), true);
    assert.equal(JSON.parse(reserve(converted.id).selection_json)[0].id, converted.id);
    database.connection.prepare('UPDATE tasks SET status=? WHERE id=?').run('failed', 'conversion-1');
    assert.equal(bridge.canSelectGeneratedMaterial(converted.id, current), false);
    assert.throws(() => reserve(converted.id), { code: 'MODEL_FILE_NOT_SELECTED' });
    const arbitraryPath = join(artifactRoot, 'arbitrary.txt'); writeFileSync(arbitraryPath, 'not a tool output');
    const arbitrary = files.register({ path: arbitraryPath, source: 'generated', conversationId: 'conversation-1' });
    assert.equal(bridge.canSelectGeneratedMaterial(arbitrary.id, current), false);
    assert.throws(() => reserve(arbitrary.id), { code: 'MODEL_FILE_NOT_SELECTED' });
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

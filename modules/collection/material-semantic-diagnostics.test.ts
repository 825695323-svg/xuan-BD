import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { directoryCapability } from '../../platform/runtime/file-workspace.js';
import type { TaskExecutionContext, TaskOperation } from '../../platform/jobs/tasks.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { ConversationMaterialBridge } from './conversation-materials.js';
import type { MaterialService } from './materials/service.js';
import type { TrustedMaterialOrigin } from './materials/semantic-contracts.js';
import { MaterialSemanticError, MaterialSemanticService } from './materials/semantic.js';

const originalSha256 = 'a'.repeat(64);
const validProposal = () => ({ materialId: 'material-1', originalSha256, proposalVersion: 1,
  rulesVersion: 'material-cleaning/1', judgments: [
    { id: 'known-1', key: 'unit', status: 'known', value: 'yuan', evidence: [{ source: 'original', quote: 'yuan' }] },
    { id: 'unknown-1', key: 'period', status: 'unknown', evidence: [] },
  ], cleaning: { trim: false, emptyToNull: false, dates: [], decimals: [] } });
const origin: TrustedMaterialOrigin = { provider: 'test', model: 'test', modelDigest: 'b'.repeat(64), endpointDigest: 'c'.repeat(64),
  conversationId: 'conversation-1', branchId: 'branch-1', parentRunId: 'run-1', parentGeneration: 1,
  inputId: 'input-1', messageId: 'message-1', toolCallId: 'tool-1', callId: 'call-1', localBridgeTaskId: 'task-1',
  userMessages: [{ id: 'message-1', text: '保留未知' }], adoption: { kind: 'user-confirmation', evidence: { source: 'user-message', messageId: 'message-1', quote: '保留未知' } } };

test('材料提案诊断指出受控路径和静态原因，不回显提案值或自造键', () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-semantic-diagnostic-')));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    const semantics = new MaterialSemanticService({ database,
      materials: { get: () => { throw new Error('PASSED_VALIDATION'); } } as unknown as MaterialService,
      tasks: () => { throw new Error('Unexpected task use.'); } });
    const proposal = validProposal() as Record<string, unknown>;
    proposal.requiredJudgmentIds = [];
    const unresolved = (proposal.judgments as Record<string, unknown>[])[1]!;
    delete unresolved.evidence;
    unresolved.value = '/private/secret marker';
    assert.throws(() => semantics.submitProposal(proposal, origin, 'request-1'), (error: unknown) => {
      assert.ok(error instanceof MaterialSemanticError);
      assert.equal(error.code, 'INVALID_MATERIAL_SEMANTIC_PROPOSAL');
      assert.deepEqual(error.validationIssues.map(issue => issue.path), [
        'proposal.requiredJudgmentIds', 'proposal.judgments[1].evidence', 'proposal.judgments[1].value',
      ]);
      assert.match(error.validationIssues[0]!.reason, /cleaning\.requiredJudgmentIds/u);
      assert.match(error.validationIssues[1]!.reason, /缺少必需字段/u);
      assert.match(error.validationIssues[2]!.reason, /不能携带/u);
      assert.ok(Buffer.byteLength(JSON.stringify(error.validationIssues), 'utf8') <= 1_000);
      assert.ok(!JSON.stringify({ message: error.message, issues: error.validationIssues }).includes('/private/secret'));
      return true;
    });

    const unknownExtra = validProposal() as Record<string, unknown>;
    unknownExtra['/private/secret-key'] = 'private body marker';
    assert.throws(() => semantics.submitProposal(unknownExtra, origin, 'request-2'), (error: unknown) => {
      assert.ok(error instanceof MaterialSemanticError);
      assert.deepEqual(error.validationIssues.map(issue => issue.path), ['proposal']);
      assert.ok(!JSON.stringify(error.validationIssues).includes('/private/secret'));
      assert.ok(!JSON.stringify(error.validationIssues).includes('private body marker'));
      return true;
    });
    const manyErrors = validProposal() as Record<string, unknown>;
    Object.assign(manyErrors, { materialId: '', originalSha256: 'invalid', proposalVersion: 2, rulesVersion: 'invalid',
      cleaning: { trim: 'invalid', emptyToNull: 'invalid', dates: 'invalid', decimals: 'invalid' } });
    assert.throws(() => semantics.submitProposal(manyErrors, origin, 'request-many'), (error: unknown) => {
      assert.ok(error instanceof MaterialSemanticError);
      assert.equal(error.validationIssues.length, 4);
      assert.ok(Buffer.byteLength(JSON.stringify(error.validationIssues), 'utf8') <= 1_000);
      return true;
    });
    const knownWithoutEvidence = validProposal();
    knownWithoutEvidence.judgments[0]!.evidence = [];
    assert.throws(() => semantics.submitProposal(knownWithoutEvidence, origin, 'request-3'), (error: unknown) => {
      assert.ok(error instanceof MaterialSemanticError);
      assert.equal(error.code, 'MATERIAL_KNOWN_WITHOUT_EVIDENCE');
      assert.equal(error.validationIssues[0]?.path, 'proposal.judgments[0].evidence');
      return true;
    });
    assert.throws(() => semantics.submitProposal(validProposal(), origin, 'request-4'), /PASSED_VALIDATION/u,
      '正确的 known 和 unknown 提案须通过结构校验，继续进入材料核对');
    const instructions = (semantics.modelContract() as { instructions: string[] }).instructions.join('\n');
    assert.match(instructions, /cleaning\.requiredJudgmentIds/u);
    assert.match(instructions, /id:"j-unknown",key:"period",status:"unknown",evidence:\[\]/u);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('材料提案拒绝只向模型返回固定原因，不透传内部错误正文', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-semantic-preview-')));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    database.connection.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const files = new FileReferenceService({ database, permissions });
    permissions.grant({ capabilities: [directoryCapability('read', root)] });
    const path = join(root, 'selected.txt'); writeFileSync(path, 'yuan');
    const reference = files.register({ path, source: 'user-attached', conversationId: 'conversation-1' });
    const current: ModelTaskOrigin = { callId: 'call-1', conversationId: 'conversation-1', parentRunId: 'run-1', parentGeneration: 1,
      inputId: 'input-1', branchId: 'branch-1', messageId: 'message-1', modelDigest: 'b'.repeat(64), endpointDigest: 'c'.repeat(64),
      toolCallId: 'tool-1', toolName: 'perform_action', notice: '', receiver: { provider: 'test', model: 'test', origin: 'test' } };
    const core = { selectedAttachmentsForInput: () => [{ fileRefId: reference.id, version: reference.version, category: 'unclassified' }],
      store: { command: () => ({ text: '保留未知' }), message: () => ({ conversation_id: 'conversation-1', role: 'user',
        text: '保留未知', parent_id: null }) } } as unknown as PersonalCore;
    let rejection: Error & { code: string } = Object.assign(new Error('/private/secret marker'), { code: 'MATERIAL_CONFIRMATION_REQUIRED' });
    const companion = { bd: { assertDispatch: () => {} }, tasks: { get: () => ({ args: { category: 'unclassified' } }) },
      semantics: { submitProposal: () => { throw rejection; } } } as unknown as WorkspaceServices;
    const bridge = new ConversationMaterialBridge({ database, core, files, companion,
      origin: () => current, assertPath: () => {} });
    database.connection.prepare('INSERT INTO conversation_material_links VALUES(?,?,?,?,?,?,?)').run('material-1', 'service-1',
      originalSha256, reference.id, reference.version, '{}', Date.now());
    const context = { task: { id: 'local-1', action: 'material.process' } as TaskRecord,
      runId: 'run-1', attemptId: 'attempt-1', generation: 1, controlGeneration: null, signal: new AbortController().signal,
      emit: async () => {}, consumeBudget: () => { throw new Error('Unexpected budget use.'); },
      operationScope: (operation: TaskOperation) => ({ ...operation, runId: 'run-1', attemptId: 'attempt-1', generation: 1 }),
      assertAuthorized: (operation: TaskOperation, capabilities: Parameters<PermissionService['assertAuthorized']>[1], options?: Parameters<PermissionService['assertAuthorized']>[2]) =>
        permissions.assertAuthorized({ ...operation, runId: 'run-1', attemptId: 'attempt-1', generation: 1 }, capabilities, options),
      requestApproval: async () => { throw new Error('Unexpected approval request.'); } } as TaskExecutionContext;
    const args = { fileRefId: reference.id, materialId: 'material-1', proposalJson: JSON.stringify(validProposal()) };
    const first = await bridge.execute(context, 'material.process', args);
    assert.equal((first.data as { modelPreview: { code: string } }).modelPreview.code, 'MATERIAL_CONFIRMATION_REQUIRED');
    assert.ok(!JSON.stringify(first).includes('/private/secret'));
    rejection = new MaterialSemanticError('INVALID_MATERIAL_SEMANTIC_PROPOSAL', [
      { path: 'proposal.judgments[1].evidence', reason: '缺少必需字段。' }]);
    const second = await bridge.execute(context, 'material.process', args);
    const preview = (second.data as { modelPreview: { validationIssues: { path: string }[] } }).modelPreview;
    assert.deepEqual(preview.validationIssues.map(issue => issue.path), ['proposal.judgments[1].evidence']);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

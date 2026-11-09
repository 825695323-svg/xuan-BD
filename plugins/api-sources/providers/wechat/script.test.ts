import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { CoreDatabase } from '../../../../platform/state/database.js';
import { SourceSettingsService, WECHAT_EXTRACT_SHA256 } from '../../../../platform/config/source-settings.js';
import { PermissionService } from '../../../../platform/security/permissions.js';
import { FileReferenceService } from '../../../../platform/resources/files.js';
import { acquireAuthority, directoryCapability, fileCapability } from '../../../../platform/runtime/file-workspace.js';
import { ConversationMaterialBridge } from '../../../../modules/collection/conversation-materials.js';
import type { PersonalCore } from '../../../../modules/agent/runtime/core.js';
import type { ModelTaskOrigin } from '../../../../modules/agent/model-tools.js';
import type { WorkspaceServices } from '../../../../contracts/workspace-services.js';
import type { TaskExecutionContext, TaskOperation } from '../../../../platform/jobs/tasks.js';
import type { TaskRecord } from '../../../../contracts/task-contracts.js';
import { wechatArticleUrl } from './script.js';

test('公众号动作只接受单篇文章短链', () => {
  const url = 'https://mp.weixin.qq.com/s/PADfXTpUXxjXiA3c29Iwhw';
  assert.equal(wechatArticleUrl(url), url);
  for (const bad of [
    'http://mp.weixin.qq.com/s/PADfXTpUXxjXiA3c29Iwhw',
    'https://other.example/s/PADfXTpUXxjXiA3c29Iwhw',
    'https://mp.weixin.qq.com.evil.example/s/PADfXTpUXxjXiA3c29Iwhw',
    url + '?redirect=https://other.example', url + '#section',
    'https://mp.weixin.qq.com/s/',
  ]) assert.throws(() => wechatArticleUrl(bad), { code: 'WECHAT_URL_INVALID' });
});

test('旧来源设置只在内存补停用脚本，受控保存拒绝错误脚本', () => {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-wechat-setting-'));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    const settings = new SourceSettingsService(join(root, 'source-settings.json'), database);
    const initial = settings.get();
    const { wechatExtract: _newField, ...oldSetting } = initial;
    writeFileSync(settings.path, JSON.stringify(oldSetting));
    assert.deepEqual(settings.get().wechatExtract, { enabled: false, scriptPath: null, sha256: WECHAT_EXTRACT_SHA256 });
    assert.throws(() => settings.wechatScriptVersion(), { code: 'SOURCE_DISABLED' });
    assert.throws(() => settings.update({ ...initial, wechatExtract: { enabled: true,
      scriptPath: join(root, 'wechat_extract.py'), sha256: WECHAT_EXTRACT_SHA256 } }), { code: 'WECHAT_SCRIPT_CHANGED' });
    assert.equal(settings.get().revision, initial.revision);
    assert.throws(() => settings.update({ ...initial, wechatExtract: { enabled: true,
      scriptPath: join(root, 'wechat_extract.py'), sha256: '0'.repeat(64) } }), { code: 'SOURCE_SETTINGS_INVALID' });
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('已明确选择的固定脚本经来源设置保存后读回同一摘要', { skip: !process.env.XUAN_WECHAT_SCRIPT_PATH }, () => {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-wechat-setting-'));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    const settings = new SourceSettingsService(join(root, 'source-settings.json'), database);
    const initial = settings.get();
    const saved = settings.update({ ...initial, wechatExtract: { enabled: true,
      scriptPath: process.env.XUAN_WECHAT_SCRIPT_PATH!, sha256: WECHAT_EXTRACT_SHA256 } }, 'wechat-script-test-1');
    assert.equal(saved.revision, initial.revision + 1);
    assert.equal(settings.operation('wechat-script-test-1')?.status, 'adopted');
    assert.equal(settings.wechatScriptVersion().sha256, WECHAT_EXTRACT_SHA256);
    assert.deepEqual(settings.get().wechatExtract, saved.wechatExtract);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('公众号正文只从同分支成功任务接续，并逐件读回原页面、JSON、正文与回执', async () => {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-wechat-material-'));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  try {
    database.connection.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,action TEXT,args TEXT,status TEXT,result TEXT,versions TEXT)');
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const files = new FileReferenceService({ database, permissions });
    permissions.grant({ capabilities: ['read', 'write', 'delete'].map(action =>
      directoryCapability(action as 'read' | 'write' | 'delete', artifactRoot)) });
    const url = 'https://mp.weixin.qq.com/s/PADfXTpUXxjXiA3c29Iwhw', taskId = 'wechat-task';
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const add = (name: string, text: string) => {
      const path = join(artifactRoot, name); writeFileSync(path, text);
      return files.register({ path, source: 'generated', taskId, conversationId: 'conversation-1' });
    };
    database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId, 'source.wechat.extract', JSON.stringify({ url }),
      'succeeded', null, '{}');
    const text = '这是一篇用于验证来源链和材料保管的公众号文章正文。'.repeat(4);
    const raw = add('raw.html', '<html><div id="js_content">' + text + '</div></html>');
    const cleaned = { url, title: '测试文章', author: '测试公众号', publish_time: '2026/10/31 10:00:00',
      content_text: text, paragraphs: [text], word_count: Array.from(text).length, extract_method: 'curl+regex', ocr_text: '' };
    const jsonText = JSON.stringify(cleaned), json = add('cleaned.json', jsonText), body = add('visible.txt', text);
    const receiptText = JSON.stringify({ schemaVersion: 1, source: 'wechat-fixed-script', status: 'extracted', url,
      scriptSha256: WECHAT_EXTRACT_SHA256, configurationRevision: 2, title: cleaned.title, author: cleaned.author,
      publishTime: cleaned.publish_time, wordCount: cleaned.word_count, paragraphCount: 1, bodyChars: Array.from(text).length,
      exitCode: 0, rawRef: raw.id, rawRefVersion: raw.version, rawSha256: sha('<html><div id="js_content">' + text + '</div></html>'),
      jsonRef: json.id, jsonRefVersion: json.version, jsonSha256: sha(jsonText),
      textRef: body.id, textRefVersion: body.version, textSha256: sha(text), extraction: 'curl+regex', ocr: false,
      completeness: 'script-validated-body; source-page-completeness-unknown' });
    const receipt = add('receipt.json', receiptText);
    const data = { source: 'wechat-fixed-script', status: 'extracted', scriptSha256: WECHAT_EXTRACT_SHA256,
      configurationRevision: 2, url, title: cleaned.title, author: cleaned.author, publishTime: cleaned.publish_time,
      wordCount: cleaned.word_count, paragraphCount: 1, bodyChars: Array.from(text).length, exitCode: 0,
      rawRef: raw.id, rawRefVersion: raw.version, rawSha256: sha('<html><div id="js_content">' + text + '</div></html>'),
      jsonRef: json.id, jsonRefVersion: json.version, jsonSha256: sha(jsonText),
      textRef: body.id, textRefVersion: body.version, textSha256: sha(text),
      receiptRef: receipt.id, receiptRefVersion: receipt.version, receiptSha256: sha(receiptText), ocr: false,
      completeness: 'script-validated-body; source-page-completeness-unknown' };
    const result = { summary: 'synthetic', artifactIds: [raw.id, json.id, body.id, receipt.id], data };
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(result), taskId);
    const origin = (messageId: string, branchId = 'branch-1'): ModelTaskOrigin => ({ callId: 'call-1', conversationId: 'conversation-1',
      branchId, messageId, parentRunId: 'run-1', parentGeneration: 1, inputId: 'input-1', modelDigest: 'model-1', endpointDigest: 'endpoint-1',
      toolCallId: 'tool-1', toolName: 'perform_action', notice: '', receiver: { provider: 'test', model: 'test', origin: 'test' } });
    const core = { store: { message: (id: string) => ({ conversation_id: 'conversation-1',
      parent_id: id === 'current' ? 'prior' : null }) } } as unknown as PersonalCore;
    const bridge = new ConversationMaterialBridge({ database, core, files, companion: {} as WorkspaceServices,
      origin: id => id === taskId ? origin('prior') : null, assertPath: () => {} });
    const current = origin('current');
    assert.equal(bridge.canSelectGeneratedMaterial(body.id, current), true);
    assert.equal(bridge.canSelectGeneratedMaterial(raw.id, current), false);
    assert.equal(bridge.canSelectGeneratedMaterial(body.id, origin('current', 'other-branch')), false);
    const evidence = bridge['generatedMaterial'](body.id, current)?.wechat;
    assert.ok(evidence);
    const runId = 'run-1', attemptId = 'attempt-1', generation = 1;
    const operationScope = (operation: TaskOperation) => ({ ...operation, runId, attemptId, generation });
    const context = { task: { id: 'material-task' } as TaskRecord, runId, attemptId, generation, controlGeneration: null,
      signal: new AbortController().signal, emit: async () => {}, consumeBudget: () => { throw new Error('unexpected budget use'); }, operationScope,
      assertAuthorized: (operation: TaskOperation, capabilities: Parameters<PermissionService['assertAuthorized']>[1], options: Parameters<PermissionService['assertAuthorized']>[2]) =>
        permissions.assertAuthorized(operationScope(operation), capabilities, options),
      requestApproval: async () => { throw new Error('unexpected approval'); } } as TaskExecutionContext;
    const authority = await acquireAuthority(context, 'material.read', { fileRefId: body.id },
      [body, raw, json, receipt].map(item => fileCapability('read', item.invocationPath)));
    assert.equal((await bridge['verifyWechatMaterial'](context, evidence, authority)).toString(), text);
    const changed = { ...result, data: { ...data, textSha256: '0'.repeat(64) } };
    database.connection.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(changed), taskId);
    const wrong = bridge['generatedMaterial'](body.id, current)?.wechat;
    assert.ok(wrong);
    await assert.rejects(bridge['verifyWechatMaterial'](context, wrong, authority), { code: 'MATERIAL_WECHAT_PROVENANCE' });
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

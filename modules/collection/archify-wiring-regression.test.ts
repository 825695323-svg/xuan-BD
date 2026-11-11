import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isModelActionAllowed, modelActionApprovalMode } from '../agent/model-tools.js';
import { nativeOptionalDependencyMatches, directImplementationVersion } from '../../platform/plugins/direct-versions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { artifactReleaseBlockers } from './artifact-lifecycle.js';

test('model can discover every registered artifact tool; destructive actions remain reviewed', () => {
  const safe = ['artifact.manifest', 'artifact.inspect', 'artifact.candidates.inspect'];
  const gated = ['artifact.archive', 'artifact.restore', 'artifact.release', 'artifact.candidates.prune'];
  for (const action of [...safe, ...gated]) assert.equal(isModelActionAllowed(action), true, action);
  for (const action of safe) assert.equal(modelActionApprovalMode(action, {}), 'automatic', action);
  for (const action of gated) assert.equal(modelActionApprovalMode(action, {}), 'review', action);
  assert.equal(isModelActionAllowed('artifact.deleteAll'), false);
  assert.equal(isModelActionAllowed('data.r1.submit-unsafe'), false);
  assert.equal(isModelActionAllowed('data.r1.submit'), false, '旧模型直接提交动作已取消');
});

test('Linux native optional dependencies match GNU and musl separately', () => {
  const gnu = '@openclaw/fs-safe-linux-x64-gnu';
  const musl = '@openclaw/fs-safe-linux-x64-musl';
  assert.equal(nativeOptionalDependencyMatches(gnu, 'linux', 'x64', 'gnu'), true);
  assert.equal(nativeOptionalDependencyMatches(musl, 'linux', 'x64', 'gnu'), false);
  assert.equal(nativeOptionalDependencyMatches(gnu, 'linux', 'x64', 'musl'), false);
  assert.equal(nativeOptionalDependencyMatches(musl, 'linux', 'x64', 'musl'), true);
  assert.equal(nativeOptionalDependencyMatches('@openclaw/fs-safe-linux-arm64-gnu', 'linux', 'x64', 'gnu'), false);
  assert.equal(nativeOptionalDependencyMatches('@openclaw/fs-safe-darwin-arm64', 'darwin', 'arm64', null), true);
  assert.equal(nativeOptionalDependencyMatches('@openclaw/fs-safe-win32-x64', 'win32', 'x64', null), true);
  assert.equal(nativeOptionalDependencyMatches('@openclaw/fs-safe-win32-arm64', 'win32', 'x64', null), false);
});

test('every artifact implementation participates in frozen runtime version hashing', () => {
  const baseline = directImplementationVersion(['assembly']);
  for (const group of ['artifactManifest', 'artifactArchive', 'artifactRestore', 'artifactLifecycle', 'candidateReclaim'] as const) {
    const actual = directImplementationVersion(['assembly', group]);
    assert.match(actual, /^[a-f0-9]{64}$/u, group);
    assert.notEqual(actual, baseline, group);
  }
});

test('real segment/processing field names never cause permanent unverifiable release blockers', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'schema-guard-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const file = join(artifactRoot, 'output.json'); writeFileSync(file, '{}');
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  const permissions = new PermissionService({ database, isRunActive: () => false });
  const files = new FileReferenceService({ database, permissions });
  const tasks = new TaskService({ database, permissions, runtimes: new TaskRuntimeRegistry() });
  try {
    const task = tasks.create({ title: 'signed source', runtimeId: 'direct', action: 'source.example',
      args: {}, ownerRole: 'service', requestId: 'guard-source' });
    const reference = files.register({ path: file, source: 'generated', taskId: task.id });
    database.connection.exec([
      'CREATE TABLE segment_requests(input_json TEXT NOT NULL);',
      'CREATE TABLE processing_plans(plan_json TEXT NOT NULL,material_manifest_json TEXT NOT NULL);',
      'CREATE TABLE processing_plan_steps(input_json TEXT,output_json TEXT,parameters_json TEXT);',
      'CREATE TABLE processing_plan_outputs(structured_json TEXT,dimensions_json TEXT);',
    ].join('\n'));
    const blockers = () => artifactReleaseBlockers(database, files, task.id, reference, artifactRoot);
    assert.deepEqual(blockers(), [], '真实字段可读且没有消费者时，不得误报不可核对');
    const examples = [
      ['segment_requests', 'INSERT INTO segment_requests VALUES(?)', [JSON.stringify({ artifactRef: reference.id })]],
      ['processing_plans', 'INSERT INTO processing_plans VALUES(?,?)', [JSON.stringify({ fileRefId: reference.id }), '{}']],
      ['processing_plan_steps', 'INSERT INTO processing_plan_steps VALUES(?,?,?)', [null, JSON.stringify({ fileRefId: reference.id }), null]],
      ['processing_plan_outputs', 'INSERT INTO processing_plan_outputs VALUES(?,?)', [JSON.stringify({ fileRefId: reference.id }), null]],
    ] as const;
    for (const [table, query, args] of examples) {
      database.connection.prepare(query).run(...args);
      assert.ok(blockers().includes(table + '-reference'), table + ' 应阻断真正的消费引用');
      database.connection.exec('DELETE FROM ' + table);
      assert.deepEqual(blockers(), [], table + ' 清除引用后不应留下永久阻断');
    }
  } finally {
    await tasks.dispose();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

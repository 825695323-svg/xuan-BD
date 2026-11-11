import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { createArtifactArchiveActions } from './artifact-archive.js';
import { createArtifactLifecycleActions } from './artifact-lifecycle.js';
import { createArtifactManifestActions } from './artifact-manifest.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'artifact-manifest-')));
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  const database = new CoreDatabase(join(root, 'db.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions });
  const runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, runtimes, permissions });
  createArtifactArchiveActions({ database, files, tasks: () => tasks });
  const lifecycle = createArtifactLifecycleActions({ database, files, tasks: () => tasks, artifactRoot: artifacts });
  const manifest = createArtifactManifestActions({ database, files, tasks: () => tasks });
  let ids: string[] = [];
  runtimes.register({ id: 'producer', execute: async () => ({ summary: 'public page captured', artifactIds: [...ids, ids[0]!],
    data: { sourceReceipts: [{ fileRefId: ids[0], contentType: 'text/html' }],
      rawRef: ids[0], textRef: ids[1], locatorRef: ids[2], privateEvidenceRefs: ['private-do-not-share'] } }) });
  runtimes.register({ id: 'direct', execute: context => context.task.action === 'artifact.manifest'
    ? manifest.execute(context, context.task.args as never)
    : lifecycle.execute(context, context.task.action, context.task.args as never) });
  const task = tasks.create({ title: 'capture source', runtimeId: 'producer', action: 'source.fetch',
    args: {}, ownerRole: 'service', requestId: 'captured-page' });
  for (const [i, name] of ['raw.html', 'body.txt', 'source.json'].entries()) {
    const path = join(artifacts, name); writeFileSync(path, Buffer.from('data-' + i));
    ids.push(files.register({ path, source: 'generated', taskId: task.id }).id);
  }
  const call = async (sourceTaskId: string) => {
    const job = tasks.create({ title: 'manifest', runtimeId: 'direct', action: 'artifact.manifest',
      args: { sourceTaskId }, ownerRole: 'service', requestId: randomUUID() });
    tasks.start(job.id, job.version);
    return tasks.wait(job.id);
  };
  return { root, task, tasks, files, database, ids, call,
    async produce() {
      tasks.start(task.id, task.version);
      assert.equal((await tasks.wait(task.id)).status, 'succeeded');
    },
    async close() { await tasks.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('source manifest deduplicates signed artifacts and reports roles without exposing private evidence IDs', async () => {
  const f = fixture();
  try {
    await f.produce();
    const reported = await f.call(f.task.id);
    assert.equal(reported.status, 'succeeded', JSON.stringify(reported.error));
    const result = reported.result!.data as any;
    assert.equal(result.count, 3);
    assert.equal(result.privateEvidenceCount, 1);
    assert.equal(result.wfdPublication, 'not_checked');
    assert.equal(result.archiveByteVerification, 'not_performed');
    assert.equal(result.items[0].suggestedDisposition, 'archive-original');
    assert.ok(result.items[0].sourceRoles.includes('source-raw-response'));
    assert.equal(result.items[1].suggestedDisposition, 'archive-evidence');
    assert.equal(result.items[2].suggestedDisposition, 'retain-lightweight-source-locator');
    assert.equal(result.items[0].nextAction, 'artifact.archive');
    assert.doesNotMatch(JSON.stringify(result), /private-do-not-share/u);
    const inspectJob = f.tasks.create({ title: 'inspect after manifest', runtimeId: 'direct', action: 'artifact.inspect',
      args: { sourceTaskId: f.task.id, fileRefId: f.ids[0]! }, ownerRole: 'service', requestId: randomUUID() });
    f.tasks.start(inspectJob.id, inspectJob.version);
    const inspection = await f.tasks.wait(inspectJob.id);
    assert.equal(inspection.status, 'succeeded', JSON.stringify(inspection.error));
    assert.ok(!(inspection.result?.data as any).blockers.includes('downstream-task-reference'),
      '只读清单任务不能因展示文件编号而创建虚假的内容消费关系');
    const ref = f.files.getRef(f.ids[0]!);
    const sha = createHash('sha256').update(Buffer.from('data-0')).digest('hex');
    f.database.connection.prepare('INSERT INTO artifact_archive_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.task.id, ref.id, ref.version, sha, ref.size, '资讯', '来源原件',
        '/apps/bdpan/证据盘/资讯/来源原件/archive.dat', '{}', '123456', 'confirmed', Date.now());
    const second = await f.call(f.task.id);
    const item = (second.result!.data as any).items[0];
    assert.equal(item.archiveState, 'confirmed');
    assert.equal(item.archiveEvidence, 'remote_name_size_id_only');
    assert.equal(item.nextAction, 'artifact.inspect');
  } finally { await f.close(); }
});
test('unsettled source task cannot manufacture a complete artifact manifest', async () => {
  const f = fixture();
  try {
    const reported = await f.call(f.task.id);
    assert.equal(reported.status, 'failed');
    assert.equal(reported.error?.code, 'ARTIFACT_MANIFEST_SOURCE');
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { cloudEvidenceDirectory, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';
import { createArtifactArchiveActions } from './artifact-archive.js';
import { createArtifactRestoreActions } from './artifact-restore.js';

const bytes = Buffer.from('frozen invoice,source-date,original number\n2026-01-02,2026-01-01,123.00\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'cross-restore-')));
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  const path = join(root, 'input.csv'); writeFileSync(path, bytes);
  const db = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database: db, permissions });
  const runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database: db, runtimes, permissions });
  permissions.grant({ capabilities: [
    { action: 'read', target: { kind: 'file', path } },
    ...(['read', 'write', 'delete'] as const).map(action => ({ action, target: { kind: 'directory' as const, path: artifacts, recursive: true } })),
  ] });
  const objects = new Map<string, { object: CloudObject; bytes: Buffer }>();
  const state = { uploads: 0, remoteReads: 0, writes: [] as boolean[] };
  const backend: CloudCustodyBackend = {
    versionBinding: { cloudBackend: 'isolated-restore/1', cloudBinding: 'stable-account' },
    availability: () => ({ available: true }),
    open: async (_context, input) => {
      state.writes.push(input.allowUpload);
      return {
        list: async (directory, offset, limit) => {
          const items = [...objects.values()].map(value => value.object).filter(value => posix.dirname(value.path) === directory);
          return { items: items.slice(offset, offset + limit), hasMore: offset + limit < items.length,
            nextOffset: offset + limit < items.length ? offset + limit : null };
        },
        lookup: async target => objects.get(target)?.object ?? null,
        read: async (remote, maxBytes) => {
          assert.equal(input.allowUpload, false);
          assert.equal(input.verifyBytes, true);
          const current = objects.get(remote.path);
          if (!current || current.object.id !== remote.id || current.object.size > maxBytes) throw Error('changed remote');
          state.remoteReads++;
          return Buffer.from(current.bytes);
        },
        prepareDirectory: async directory => {
          assert.equal(directory, cloudEvidenceDirectory('资讯', '加工证据'));
          return true;
        },
        put: async (value, target) => {
          assert.equal(input.allowUpload, true); state.uploads++;
          const object: CloudObject = { id: '90071992547409931234', path: target, kind: 'file', size: value.length, md5: null };
          objects.set(target, { object, bytes: Buffer.from(value) });
          return object;
        },
        copy: async () => { throw Error('unexpected copy'); },
        close: async () => {},
      };
    },
  };
  const archive = createArtifactArchiveActions({ database: db, files, tasks: () => tasks, backend });
  const restore = createArtifactRestoreActions({ database: db, files, tasks: () => tasks, backend, artifactRoot: artifacts });
  let publishedId = '';
  runtimes.register({ id: 'producer', execute: async () => ({ summary: 'output', artifactIds: [publishedId] }) });
  runtimes.register({ id: 'archive', execute: context => archive.execute(context, context.task.args as never) });
  runtimes.register({ id: 'restore', execute: context => restore.execute(context, context.task.args as never) });
  const producer = tasks.create({ title: 'producer', runtimeId: 'producer', action: 'source.fixture',
    args: {}, requestId: 'producer-one', ownerRole: 'service' });
  const ref = files.register({ path, source: 'generated', taskId: producer.id });
  publishedId = ref.id;
  const args = { sourceTaskId: producer.id, fileRefId: ref.id };
  const execute = async (runtimeId: string, action: string, input: Record<string, string>) => {
    const task = tasks.create({ title: action, runtimeId, action, args: input,
      requestId: randomUUID(), ownerRole: 'service' });
    tasks.start(task.id, task.version);
    return tasks.wait(task.id);
  };
  return { files, state, objects, path, args, archive, restore, execute,
    async produceAndArchive() {
      tasks.start(producer.id, producer.version);
      assert.equal((await tasks.wait(producer.id)).status, 'succeeded');
      const stored = await execute('archive', 'artifact.archive', { ...args, topic: '资讯', purpose: '加工证据' });
      assert.equal(stored.status, 'succeeded', JSON.stringify(stored.error));
      assert.equal((stored.result?.data as Record<string, unknown>).state, 'confirmed');
      return stored;
    },
    async close() { await tasks.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('explicit restore rehydrates a missing local artifact without rewriting its original reference', async () => {
  const f = fixture();
  try {
    await f.produceAndArchive();
    rmSync(f.path);
    // 原本地文件已不存在时，沿冻结归档身份重查仍只能读远端元数据。
    const rechecked = await f.execute('archive', 'artifact.archive',
      { ...f.args, topic: '资讯', purpose: '加工证据' });
    assert.equal(rechecked.status, 'succeeded', JSON.stringify(rechecked.error));
    assert.equal((rechecked.result?.data as Record<string, unknown>).state, 'confirmed');
    assert.equal(f.state.uploads, 1); assert.equal(f.state.remoteReads, 0);
    const result = await f.execute('restore', 'artifact.restore', f.args);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal((result.result?.data as Record<string, unknown>).state, 'restored_verified');
    const generated = result.result!.artifactIds![0]!;
    assert.notEqual(generated, f.args.fileRefId);
    assert.equal(sha(await (await import('node:fs/promises')).readFile(f.files.verify(generated).invocationPath)), sha(bytes));
    assert.equal(f.state.uploads, 1);
    assert.equal(f.state.remoteReads, 1);
    assert.deepEqual(f.state.writes, [true, false]);
    assert.equal(f.files.getRef(f.args.fileRefId).id, f.args.fileRefId);
  } finally { await f.close(); }
});

test('changed object identity or same-size content corruption blocks verified restore', async () => {
  for (const fault of ['identity', 'content'] as const) {
    const f = fixture();
    try {
      await f.produceAndArchive();
      const current = [...f.objects.values()][0]!;
      if (fault === 'identity') current.object = { ...current.object, id: '99999' };
      else current.bytes = Buffer.from(current.bytes.map((value, index) => index === 0 ? value ^ 1 : value));
      const result = await f.execute('restore', 'artifact.restore', f.args);
      assert.equal(result.status, 'failed', JSON.stringify(result.result));
      assert.equal(result.result?.artifactIds?.length ?? 0, 0);
      assert.equal(f.state.uploads, 1);
    } finally { await f.close(); }
  }
});

test('cannot restore an unarchived file or unknown originating task', async () => {
  const f = fixture();
  try {
    const result = await f.execute('restore', 'artifact.restore', f.args);
    assert.equal(result.status, 'failed');
    assert.equal(f.state.remoteReads, 0);
    assert.equal(f.state.uploads, 0);
  } finally { await f.close(); }
});

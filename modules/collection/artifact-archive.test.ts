import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { cloudEvidenceDirectory, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';
import { createArtifactArchiveActions } from './artifact-archive.js';

const bytes = Buffer.from('published article evidence with original line positions\n');
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'cross-artifact-')));
  const db = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database: db, permissions });
  const runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database: db, runtimes, permissions });
  const objects = new Map<string, CloudObject>();
  const state = { puts: 0, reads: 0, failAfterPut: false, openWriteModes: [] as boolean[] };
  const backend: CloudCustodyBackend = {
    versionBinding: { cloudBackend: 'isolated-archive/1', cloudBinding: 'same-account' },
    availability: () => ({ available: true }),
    open: async (_context, input) => {
      state.openWriteModes.push(input.allowUpload);
      return {
        list: async (path, offset, limit) => {
          const items = [...objects.values()].filter(item => posix.dirname(item.path) === path).slice(offset, offset + limit);
          return { items, hasMore: false, nextOffset: null };
        },
        lookup: async path => objects.get(path) ?? null,
        prepareDirectory: async (path, create) => {
          assert.equal(path, cloudEvidenceDirectory('资讯', '加工证据'));
          assert.equal(create, true);
          return true;
        },
        put: async (contents, path) => {
          assert.equal(input.allowUpload, true); state.puts++;
          assert.deepEqual(contents, bytes);
          const object: CloudObject = { id: '90071992547409930003', path, kind: 'file', size: contents.length, md5: null };
          objects.set(path, object);
          if (state.failAfterPut) throw new Error('unknown remote write receipt');
          return object;
        },
        copy: async () => { throw Error('unexpected cloud copy'); },
        read: async () => { state.reads++; throw Error('metadata archive cannot read remote bytes'); },
        close: async () => {},
      };
    },
  };
  const archive = createArtifactArchiveActions({ database: db, files, tasks: () => tasks, backend });
  let producedFileId = '';
  runtimes.register({ id: 'producer', execute: async () => ({ summary: 'source produced',
    artifactIds: [producedFileId] }) });
  runtimes.register({ id: 'direct', execute: context => archive.execute(context, context.task.args as never) });
  const path = join(root, 'body.txt'); writeFileSync(path, bytes);
  permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
  const producer = tasks.create({ title: 'source', runtimeId: 'producer', action: 'source.example',
    args: {}, requestId: 'example-produce', ownerRole: 'service' });
  const reference = files.register({ path, source: 'generated', taskId: producer.id });
  producedFileId = reference.id;
  const args = { sourceTaskId: producer.id, fileRefId: reference.id, topic: '资讯', purpose: '加工证据' };
  return { db, tasks, files, backend, archive, state, objects, args,
    async produce() {
      tasks.start(producer.id, producer.version);
      assert.equal((await tasks.wait(producer.id)).status, 'succeeded');
    },
    async archiveOnce(data: Record<string, string> = args) {
      const task = tasks.create({ title: 'archive', runtimeId: 'direct', action: 'artifact.archive',
        args: data, requestId: randomUUID(), ownerRole: 'service' });
      tasks.start(task.id, task.version);
      const done = await tasks.wait(task.id);
      return done;
    },
    async close() { await tasks.dispose(); db.close(); },
  };
}

test('all source formats share a task-bound metadata archive without remote download or deleting local output', async () => {
  const f = fixture();
  try {
    await f.produce();
    const first = await f.archiveOnce();
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
    assert.equal((first.result?.data as Record<string, unknown>).state, 'confirmed');
    assert.equal((first.result?.data as Record<string, unknown>).localDeletion, 'forbidden');
    assert.equal(f.state.puts, 1); assert.equal(f.state.reads, 0);
    assert.equal(f.files.verify(f.args.fileRefId).status, 'available');
    const second = await f.archiveOnce();
    assert.equal(second.status, 'succeeded', JSON.stringify(second.error));
    assert.equal((second.result?.data as Record<string, unknown>).state, 'confirmed');
    assert.equal(f.state.puts, 1); assert.deepEqual(f.state.openWriteModes, [true, false]);
  } finally { await f.close(); }
});

test('unknown upload response only rechecks the frozen target, never sends a second upload', async () => {
  const f = fixture();
  try {
    await f.produce();
    f.state.failAfterPut = true;
    const first = await f.archiveOnce();
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
    assert.equal((first.result?.data as Record<string, unknown>).state, 'needs_review');
    assert.equal(f.state.puts, 1);
    f.state.failAfterPut = false;
    const resumed = await f.archiveOnce();
    assert.equal((resumed.result?.data as Record<string, unknown>).state, 'confirmed');
    assert.equal(f.state.puts, 1); assert.equal(f.state.reads, 0);
  } finally { await f.close(); }
});

test('reject unowned files and changing the frozen archive classification', async () => {
  const f = fixture();
  try {
    await f.produce();
    const unowned = await f.archiveOnce({ ...f.args, sourceTaskId: 'not-source-task' });
    assert.equal(unowned.status, 'failed');
    assert.equal(f.state.puts, 0);
    const first = await f.archiveOnce(); assert.equal(first.status, 'succeeded');
    const changed = await f.archiveOnce({ ...f.args, topic: '财报' });
    assert.equal(changed.status, 'failed');
    assert.equal(f.state.puts, 1);
  } finally { await f.close(); }
});

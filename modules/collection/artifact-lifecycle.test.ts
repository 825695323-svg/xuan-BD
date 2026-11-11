import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { createArtifactArchiveActions } from './artifact-archive.js';
import { createArtifactRestoreActions } from './artifact-restore.js';
import { createArtifactLifecycleActions } from './artifact-lifecycle.js';
import type { CloudCustodyBackend, CloudObject } from '../../plugins/storage/baidu-drive.js';

const contents = Buffer.from('2026-01-01,market,100.20\n2026-01-02,market,100.40\n');
const digest = createHash('sha256').update(contents).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'artifact-release-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const file = join(artifactRoot, 'published-candidate.csv'); writeFileSync(file, contents);
  const database = new CoreDatabase(join(root, 'db.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions });
  const runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, runtimes, permissions });
  permissions.grant({ capabilities: (['read', 'write', 'delete'] as const).map(action =>
    ({ action, target: { kind: 'directory' as const, path: artifactRoot, recursive: true } })) });
  const remote = new Map<string, { object: CloudObject; bytes: Buffer }>();
  const state = { uploads: 0, reads: 0, opens: [] as boolean[] };
  const backend: CloudCustodyBackend = {
    versionBinding: { cloudBackend: 'offline-cleanup/1', cloudBinding: 'account-A' },
    availability: () => ({ available: true }),
    open: async (_context, input) => {
      state.opens.push(input.allowUpload);
      return {
        list: async (path, offset, limit) => {
          const all = [...remote.values()].map(item => item.object).filter(item => posix.dirname(item.path) === path);
          return { items: all.slice(offset, offset + limit), hasMore: offset + limit < all.length,
            nextOffset: offset + limit < all.length ? offset + limit : null };
        },
        lookup: async path => remote.get(path)?.object ?? null,
        read: async object => {
          assert.equal(input.verifyBytes, true);
          state.reads++;
          const found = remote.get(object.path);
          assert.ok(found); assert.equal(found.object.id, object.id);
          return Buffer.from(found.bytes);
        },
        prepareDirectory: async () => true,
        put: async (bytes, path) => {
          assert.equal(input.allowUpload, true); state.uploads++;
          const object: CloudObject = { id: '90071992547409930011', kind: 'file', path, size: bytes.length,
            md5: createHash('md5').update(bytes).digest('hex') };
          remote.set(path, { object, bytes: Buffer.from(bytes) });
          return object;
        },
        copy: async () => { throw Error('No in-drive copy in cleanup test'); },
        close: async () => {},
      };
    },
  };
  const archive = createArtifactArchiveActions({ database, files, tasks: () => tasks, backend });
  const restore = createArtifactRestoreActions({ database, files, tasks: () => tasks, backend, artifactRoot });
  const lifecycle = createArtifactLifecycleActions({ database, files, tasks: () => tasks, backend, artifactRoot });
  let fileRefId = '';
  runtimes.register({ id: 'producer', execute: async () => ({ summary: 'published', artifactIds: [fileRefId] }) });
  runtimes.register({ id: 'direct', execute: async context => {
    const args = context.task.args as Record<string, any>;
    if (context.task.action === 'artifact.archive') return archive.execute(context, args);
    if (context.task.action === 'artifact.restore') return restore.execute(context, args);
    if (lifecycle.handles(context.task.action)) return lifecycle.execute(context, context.task.action, args);
    throw Error('unknown task');
  } });
  const producer = tasks.create({ title: 'source fixture', runtimeId: 'producer', action: 'source.fixture', ownerRole: 'service',
    args: {}, requestId: 'fixture-producer' });
  fileRefId = files.register({ path: file, source: 'generated', taskId: producer.id }).id;
  const shared = { sourceTaskId: producer.id, fileRefId };
  const run = async (action: string, args: Record<string, string>) => {
    const job = tasks.create({ title: action, runtimeId: 'direct', action, ownerRole: 'service',
      args, requestId: randomUUID() });
    tasks.start(job.id, job.version);
    return tasks.wait(job.id);
  };
  return { root, artifactRoot, file, files, tasks, database, producer, remote, shared, state, run,
    async prepare() {
      tasks.start(producer.id, producer.version);
      assert.equal((await tasks.wait(producer.id)).status, 'succeeded');
      const archived = await run('artifact.archive', { ...shared, topic: '资讯', purpose: '加工证据' });
      assert.equal(archived.status, 'succeeded', JSON.stringify(archived.error));
      assert.equal((archived.result?.data as any)?.state, 'confirmed');
    },
    async close() { await tasks.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('archived generated output can be explicitly released and later restored as a new reference', async () => {
  const f = fixture();
  try {
    await f.prepare();
    const inspected = await f.run('artifact.inspect', f.shared);
    assert.equal(inspected.status, 'succeeded', JSON.stringify(inspected.error));
    assert.equal((inspected.result?.data as any).eligible, true);
    assert.equal((inspected.result?.data as any).remoteStatus, 'metadata_checked');
    const released = await f.run('artifact.release', { ...f.shared, expectedSha256: digest });
    assert.equal(released.status, 'succeeded', JSON.stringify(released.error));
    assert.equal((released.result?.data as any).bytesReleased, contents.length);
    assert.equal(existsSync(f.file), false);
    assert.equal(f.files.observe(f.shared.fileRefId).status, 'missing');
    assert.equal(f.state.reads, 0, 'archive/inspect/release must not download remote bytes');
    const again = await f.run('artifact.release', { ...f.shared, expectedSha256: digest });
    assert.equal(again.status, 'succeeded'); assert.equal((again.result?.data as any).state, 'released');
    const restored = await f.run('artifact.restore', f.shared);
    assert.equal(restored.status, 'succeeded', JSON.stringify(restored.error));
    const newId = restored.result!.artifactIds![0]!;
    assert.notEqual(newId, f.shared.fileRefId);
    assert.deepEqual(readFileSync(f.files.verify(newId).invocationPath), contents);
    assert.equal(f.state.uploads, 1); assert.equal(f.state.reads, 1);
  } finally { await f.close(); }
});

test('a pending downstream task prevents release despite a confirmed cloud archive', async () => {
  const f = fixture();
  try {
    await f.prepare();
    f.tasks.create({ title: 'still needs bytes', runtimeId: 'direct', action: 'conversion.document', ownerRole: 'service',
      args: { fileRefId: f.shared.fileRefId }, requestId: 'next-consumer' });
    const inspected = await f.run('artifact.inspect', f.shared);
    assert.equal((inspected.result?.data as any).eligible, false);
    assert.ok((inspected.result?.data as any).blockers.includes('downstream-task-reference'));
    const refused = await f.run('artifact.release', { ...f.shared, expectedSha256: digest });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error?.code, 'ARTIFACT_RELEASE_BLOCKED');
    assert.deepEqual(readFileSync(f.file), contents);
  } finally { await f.close(); }
});

test('an existing material content reference prevents release even after successful cloud upload', async () => {
  const f = fixture();
  try {
    await f.prepare();
    f.database.connection.exec('CREATE TABLE material_objects(envelope_json TEXT)');
    f.database.connection.prepare('INSERT INTO material_objects VALUES(?)').run(JSON.stringify({ fileRefId: f.shared.fileRefId }));
    const inspected = await f.run('artifact.inspect', f.shared);
    assert.ok((inspected.result?.data as any).blockers.includes('material_objects-reference'));
    const refused = await f.run('artifact.release', { ...f.shared, expectedSha256: digest });
    assert.equal(refused.status, 'failed');
    assert.equal(existsSync(f.file), true);
  } finally { await f.close(); }
});

test('remote object change or an incorrect SHA-256 blocks local deletion', async () => {
  for (const fault of ['remote', 'digest'] as const) {
    const f = fixture();
    try {
      await f.prepare();
      if (fault === 'remote') {
        const original = [...f.remote.values()][0]!;
        original.object = { ...original.object, id: '999' };
      }
      const refused = await f.run('artifact.release', { ...f.shared,
        expectedSha256: fault === 'digest' ? 'f'.repeat(64) : digest });
      assert.equal(refused.status, 'failed');
      assert.equal(existsSync(f.file), true);
      assert.equal(f.state.reads, 0);
    } finally { await f.close(); }
  }
});

test('unresolved deletion intent with missing local bytes remains a review gap, not a successful release', async () => {
  const f = fixture();
  try {
    await f.prepare();
    f.database.connection.prepare('INSERT INTO artifact_local_releases VALUES(?,?,?,?,?,?,?,?,?)')
      .run(f.shared.sourceTaskId, f.shared.fileRefId, 1, digest,
        [...f.remote.keys()][0], JSON.stringify(f.files.getRef(f.shared.fileRefId).identity),
        'pending', Date.now(), null);
    rmSync(f.file);
    const again = await f.run('artifact.release', { ...f.shared, expectedSha256: digest });
    assert.equal(again.status, 'failed'); assert.equal(again.error?.code, 'ARTIFACT_RELEASE_UNKNOWN');
  } finally { await f.close(); }
});

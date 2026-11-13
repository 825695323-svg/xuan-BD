import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { MaterialService } from './materials/service.js';
import { ManagedOriginalStore } from './managed-originals.js';
import { planMaterialOriginalSharing } from './original-storage.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function setup(path = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'managed-original-'))),
  assertGrowth?: (externalPath: string, bytes: number) => void, external = join(path, 'owned')) {
  if (!lstatSync(join(path, 'config'), { throwIfNoEntry: false })) {
    if (!lstatSync(external, { throwIfNoEntry: false })) mkdirSync(external, { mode: 0o700 });
    mkdirSync(join(path, 'config'));
    const stat = lstatSync(external, { bigint: true });
    writeFileSync(join(path, '.xuan-runtime.json'), JSON.stringify({ application: 'xuan-bd', version: 1, identity: 'fixture' }));
    writeFileSync(join(path, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'fixture',
      resources: { bulk_originals: { path: external, kind: 'directory', owned: true, identity: 'fixture:bulk', device: String(stat.dev), inode: String(stat.ino) } } }));
  }
  const bindings = new ResourceBindings(path), database = new CoreDatabase(join(path, 'core.sqlite'));
  const runtimes = new TaskRuntimeRegistry();
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  tasks = new TaskService({ database, runtimes, permissions });
  const files = new FileReferenceService({ database, permissions, resources: bindings });
  const materials = new MaterialService({ database, tasks: () => tasks, files, resources: bindings, environment: 'synthetic-test' });
  runtimes.register(materials.runtime);
  const store = new ManagedOriginalStore({ database, materials, bindings, ownedRoot: 'bulk_originals', assertGrowth });
  return { store, materials, files, permissions, tasks, database, path, external, async close() { await tasks.dispose(); database.close(); } };
}
const raw = Buffer.from('code,分钟,value\n01,09:30,1.0\n');
const header = (intakeId: string, bytes = raw, sha256 = sha(bytes)) => ({ intakeId, filename: 'fixture.csv', byteLength: bytes.length, sha256 });
function upload(f: ReturnType<typeof setup>, id: string, offset: number, bytes: Buffer) {
  return f.store.upload(id, { offset, bytes, sha256: sha(bytes) });
}
function managed(f: ReturnType<typeof setup>, id: string) {
  return join(f.external, `bd-bulk-${id}.original`);
}
async function collect(stream: AsyncGenerator<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('receiving recovery truncates an uncommitted tail; exact retry preserves identity and bytes', async () => {
  let f = setup();
  const accepted = f.store.start(header('receive'));
  const part = managed(f, accepted.materialId);
  try {
    const first = raw.subarray(0, 9), rest = raw.subarray(9);
    assert.equal(upload(f, 'receive', 0, first).committedOffset, 9);
    f.database.connection.exec(`CREATE TRIGGER fixture_crash_before_offset BEFORE UPDATE OF committed_offset ON managed_original_receipts
      BEGIN SELECT RAISE(ABORT,'fixture: write committed to file but not SQLite'); END;`);
    assert.throws(() => upload(f, 'receive', 9, rest), /write committed to file but not SQLite/);
    assert.deepEqual(readFileSync(part), raw);
    f.database.connection.exec('DROP TRIGGER fixture_crash_before_offset');
    await f.close();
    f = setup(f.path);
    assert.equal(f.store.start(header('receive')).materialId, accepted.materialId);
    assert.equal(f.store.status('receive').committedOffset, 9);
    assert.throws(() => f.store.start(header('receive', Buffer.from('another original'))), { code: 'MANAGED_ORIGINAL_CONFLICT' });
    assert.throws(() => upload(f, 'receive', 0, Buffer.from('different')), { code: 'MANAGED_ORIGINAL_CHUNK_CONFLICT' });
    assert.throws(() => upload(f, 'receive', 7, rest), { code: 'MANAGED_ORIGINAL_CHUNK_ORDER' });
    await assert.rejects(f.store.seal('receive'), { code: 'MANAGED_ORIGINAL_INCOMPLETE' });
    assert.equal(upload(f, 'receive', 0, first).committedOffset, 9);
    assert.deepEqual(readFileSync(part), first);
    assert.equal(upload(f, 'receive', 9, rest).committedOffset, raw.length);
    const sealed = await f.store.seal('receive');
    assert.equal(sealed.materialId, accepted.materialId);
    assert.equal(sealed.state, 'sealed');
    assert.deepEqual(upload(f, 'receive', 9, rest), sealed);
    assert.deepEqual(await collect(f.store.readStream('receive')), raw);
    assert.deepEqual(f.store.readRange('receive', 4, 7), raw.subarray(4, 11));
  } finally { await f.close(); }
});

test('initial receipt witness allocates a stable inode without acknowledging any original bytes', async () => {
  let denyGrowth = false;
  const f = setup(undefined, () => { if (denyGrowth) throw new Error('fixture: stop before allocation'); });
  try {
    const one = Buffer.from('A');
    const accepted = f.store.start(header('one', one));
    const path = managed(f, accepted.materialId);
    const initial = lstatSync(path, { bigint: true });
    assert.equal(accepted.committedOffset, 0);
    await assert.rejects(f.store.seal('one'), { code: 'MANAGED_ORIGINAL_INCOMPLETE' });
    f.database.connection.exec(`CREATE TRIGGER fixture_crash_before_first_offset BEFORE UPDATE OF committed_offset ON managed_original_receipts
      BEGIN SELECT RAISE(ABORT,'fixture: first offset not committed'); END;`);
    assert.throws(() => upload(f, 'one', 0, one), /first offset not committed/);
    f.database.connection.exec('DROP TRIGGER fixture_crash_before_first_offset');
    assert.equal(f.store.status('one').committedOffset, 0);
    assert.equal(upload(f, 'one', 0, one).committedOffset, 1);
    assert.equal((await f.store.seal('one')).materialId, accepted.materialId);
    assert.equal(lstatSync(path, { bigint: true }).ino, initial.ino);
    assert.deepEqual(readFileSync(path), one);

    f.database.connection.exec(`CREATE TRIGGER fixture_crash_before_inode BEFORE UPDATE OF inode ON managed_original_receipts
      BEGIN SELECT RAISE(ABORT,'fixture: witness persisted but inode not committed'); END;`);
    assert.throws(() => f.store.start(header('witness')), /witness persisted but inode not committed/);
    f.database.connection.exec('DROP TRIGGER fixture_crash_before_inode');
    const reserved = f.store.status('witness');
    assert.equal(f.store.start(header('witness')).materialId, reserved.materialId);

    denyGrowth = true;
    assert.throws(() => f.store.start(header('occupied')), /stop before allocation/);
    const occupied = f.store.status('occupied');
    const foreign = Buffer.alloc(16, 0x78);
    const occupiedPath = managed(f, occupied.materialId);
    writeFileSync(occupiedPath, foreign, { mode: 0o600, flag: 'wx' });
    denyGrowth = false;
    assert.throws(() => f.store.start(header('occupied')), { code: 'MANAGED_ORIGINAL_CHANGED' });
    assert.deepEqual(readFileSync(occupiedPath), foreign);
    assert.equal(f.store.status('occupied').committedOffset, 0);
  } finally { await f.close(); }
});

test('original hash mismatch does not seal; interrupted SQL seal restarts with same inode and full digest', async () => {
  const f = setup();
  try {
    const bad = f.store.start(header('bad', raw, sha(Buffer.from('wrong'))));
    upload(f, 'bad', 0, raw);
    await assert.rejects(f.store.seal('bad'), { code: 'MANAGED_ORIGINAL_CHANGED' });
    assert.equal(f.store.status('bad').state, 'receiving');
    assert.throws(() => f.store.adoptMaterial('bad', { requestId: 'wrong' }), { code: 'MANAGED_ORIGINAL_NOT_SEALED' });
    assert.deepEqual(readFileSync(managed(f, bad.materialId)), raw);

    const pending = f.store.start(header('seal'));
    upload(f, 'seal', 0, raw);
    const path = managed(f, pending.materialId);
    const original = lstatSync(path, { bigint: true });
    f.database.connection.exec(`CREATE TRIGGER fixture_crash_before_seal BEFORE UPDATE OF sealed_json ON managed_original_receipts
      BEGIN SELECT RAISE(ABORT,'fixture: sync completed but seal did not commit'); END;`);
    await assert.rejects(f.store.seal('seal'), /sync completed but seal did not commit/);
    f.database.connection.exec('DROP TRIGGER fixture_crash_before_seal');
    assert.equal(f.store.status('seal').state, 'receiving');
    assert.throws(() => f.store.readRange('seal', 0, 1), { code: 'MANAGED_ORIGINAL_NOT_SEALED' });
    const sealed = await f.store.seal('seal');
    assert.equal(sealed.materialId, pending.materialId);
    assert.deepEqual(await f.store.seal('seal'), sealed);
    assert.equal(lstatSync(path, { bigint: true }).ino, original.ino);
    assert.deepEqual(readFileSync(path), raw);
  } finally { await f.close(); }
});

test('adopts one existing material identity and TaskService reference without a BLOB; legacy BLOB still reads', async () => {
  const f = setup();
  try {
    const oldFile = join(f.path, 'user.csv');
    writeFileSync(oldFile, raw);
    const oldRef = f.files.register({ path: oldFile, source: 'user-selected' });
    f.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: oldFile } }] });
    const old = f.materials.submit({ fileRefId: oldRef.id, category: 'data' }, 'legacy');
    assert.equal((await f.tasks.wait(old.id)).status, 'succeeded');
    const oldMaterial = f.materials.getByTask(old.id)!;
    assert.deepEqual(f.materials.readOriginal(oldMaterial.envelope.materialId).bytes, raw);

    const accepted = f.store.start(header('material'));
    upload(f, 'material', 0, raw);
    await f.store.seal('material');
    const task = f.store.adoptMaterial('material', { requestId: 'material' });
    const done = await f.tasks.wait(task.id);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.equal(f.store.adoptMaterial('material', { requestId: 'material' }).id, task.id);
    assert.throws(() => f.store.adoptMaterial('material', { requestId: 'other' }), { code: 'REQUEST_CONFLICT' });
    const record = f.materials.getByTask(task.id)!;
    assert.equal(record.envelope.materialId, accepted.materialId);
    assert.equal(record.envelope.originalStorage, 'managed-file/v1');
    assert.equal(record.preview.table?.totalRows, 1);
    const reference = f.files.verify(record.envelope.fileRefId);
    assert.equal(reference.source, 'generated');
    assert.deepEqual(reference.relations, [{ kind: 'artifact', id: accepted.materialId }, { kind: 'task', id: task.id }]);
    assert.deepEqual(await collect(f.materials.readOriginalStream(accepted.materialId)), raw);
    assert.deepEqual(f.materials.readOriginalRange(accepted.materialId, 2, 3), raw.subarray(2, 5));
    assert.deepEqual(f.materials.readOriginal(accepted.materialId).bytes, raw);
    assert.equal(f.database.connection.prepare('SELECT original_bytes FROM material_objects WHERE material_id=?').get(accepted.materialId)!.original_bytes, null);
    assert.equal(f.database.connection.prepare('SELECT count(*) n FROM r1_original_contents').get()!.n, 1);
    assert.throws(() => planMaterialOriginalSharing(f.database.connection), /受管外置原件/);
    assert.deepEqual(readFileSync(oldFile), raw);
  } finally { await f.close(); }
});

test('bounds preview memory for oversized material and rejects a changed file at stream completion', async () => {
  const f = setup();
  try {
    const payload = Buffer.concat([raw, Buffer.alloc(2 * 1024 * 1024, 0x61)]);
    const accepted = f.store.start(header('oversized', payload));
    upload(f, 'oversized', 0, payload.subarray(0, 2 * 1024 * 1024));
    upload(f, 'oversized', 2 * 1024 * 1024, payload.subarray(2 * 1024 * 1024));
    await f.store.seal('oversized');
    const task = f.store.adoptMaterial('oversized', { requestId: 'oversized' });
    assert.equal((await f.tasks.wait(task.id)).status, 'succeeded');
    const { preview, envelope } = f.materials.getByTask(task.id)!;
    assert.equal(envelope.byteLength, payload.length);
    assert.equal(preview.checks.issues[0]?.code, 'MATERIAL_BYTE_BUDGET');
    assert.equal(preview.table, null);
    assert.equal(f.database.connection.prepare('SELECT count(*) n FROM r1_original_contents').get()!.n, 0);
    const blockSize = 2 * 1024 * 1024;
    assert.deepEqual(f.materials.readOriginalRange(accepted.materialId, blockSize - 2, 4), payload.subarray(blockSize - 2, blockSize + 2));
    const iterator = f.materials.readOriginalStream(accepted.materialId);
    assert.equal((await iterator.next()).done, false);
    appendFileSync(managed(f, accepted.materialId), 'unexpected');
    await assert.rejects(collect(iterator), { code: 'MANAGED_ORIGINAL_CHANGED' });
    assert.throws(() => f.materials.readOriginalRange(accepted.materialId, 0, 1), { code: 'MANAGED_ORIGINAL_CHANGED' });
  } finally { await f.close(); }
});

test('replacement binding, symlink, missing volume and growth denial preserve the original request', async () => {
  let rejectGrowth = true;
  const f = setup(undefined, () => { if (rejectGrowth) throw new Error('fixture: no space above internal reserve'); });
  try {
    assert.throws(() => f.store.start(header('disk')), /no space/);
    const reserved = f.store.status('disk');
    rejectGrowth = false;
    const accepted = f.store.start(header('disk'));
    assert.equal(accepted.materialId, reserved.materialId);
    rejectGrowth = true;
    assert.throws(() => upload(f, 'disk', 0, raw), /no space/);
    assert.equal(f.store.status('disk').committedOffset, 0);
    rejectGrowth = false;
    upload(f, 'disk', 0, raw);
    await f.store.seal('disk');
    const final = managed(f, accepted.materialId);
    renameSync(final, final + '.saved');
    symlinkSync(final + '.saved', final);
    assert.throws(() => f.store.readRange('disk', 0, 1), { code: 'MANAGED_ORIGINAL_UNAVAILABLE' });
    renameSync(f.external, f.external + '.saved');
    assert.throws(() => f.store.status('disk'), { code: 'MANAGED_ORIGINAL_UNAVAILABLE' });
    mkdirSync(f.external);
    assert.throws(() => f.store.start(header('disk')), { code: 'MANAGED_ORIGINAL_UNAVAILABLE' });
  } finally { await f.close(); }
});


test('range reads authenticate full blocks even when file timestamps match the seal', async () => {
  const f = setup();
  try {
    const original = f.store.start(header('same-stat'));
    upload(f, 'same-stat', 0, raw);
    await f.store.seal('same-stat');
    const path = managed(f, original.materialId);
    const changed = Buffer.from(raw);
    changed[changed.length - 1] ^= 1;
    writeFileSync(path, changed);
    // Model a coarse filesystem reporting the same trusted metadata for a different byte version.
    // Rebind only the timestamps to bypass that earlier rejection on the APFS fixture.
    const stat = lstatSync(path, { bigint: true });
    const row = f.database.connection.prepare('SELECT sealed_json FROM managed_original_receipts WHERE intake_id=?').get('same-stat')!;
    const sealed = JSON.parse(String(row.sealed_json));
    sealed.mtimeNs = String(stat.mtimeNs);
    sealed.ctimeNs = String(stat.ctimeNs);
    f.database.connection.prepare('UPDATE managed_original_receipts SET sealed_json=? WHERE intake_id=?').run(JSON.stringify(sealed), 'same-stat');
    assert.throws(() => f.store.readRange('same-stat', 0, 1), /实际范围块摘要已改变/);
    await assert.rejects(collect(f.store.readStream('same-stat')), /SHA-256 摘要已改变/);
  } finally { await f.close(); }
});


test('runs an isolated custody lifecycle on an explicitly selected external fixture volume',
  { skip: !process.env.XUAN_TEST_MANAGED_EXTERNAL_PROBE_ROOT }, async () => {
    const external = mkdtempSync(join(process.env.XUAN_TEST_MANAGED_EXTERNAL_PROBE_ROOT!, '.bd-managed-synthetic-test-'));
    const f = setup(undefined, undefined, external);
    let path: string | undefined;
    try {
      const original = f.store.start(header('external'));
      path = managed(f, original.materialId);
      const first = raw.subarray(0, 6);
      upload(f, 'external', 0, first);
      upload(f, 'external', 6, raw.subarray(6));
      const sealed = await f.store.seal('external');
      assert.equal(sealed.materialId, original.materialId);
      assert.deepEqual(await collect(f.store.readStream('external')), raw);
      assert.deepEqual(f.store.readRange('external', 1, 5), raw.subarray(1, 6));
      assert.deepEqual(upload(f, 'external', 0, first), sealed);
      const task = f.store.adoptMaterial('external', { requestId: 'external' });
      const done = await f.tasks.wait(task.id);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      assert.deepEqual(f.materials.readOriginalRange(original.materialId, 1, 5), raw.subarray(1, 6));
      const fd = openSync(path, 'r+');
      try { writeSync(fd, Buffer.from('X'), 0, 1, raw.length - 1); fsyncSync(fd); } finally { closeSync(fd); }
      assert.throws(() => f.store.readRange('external', 0, 1), { code: 'MANAGED_ORIGINAL_CHANGED' });
    } finally {
      await f.close();
      if (path && lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
      rmdirSync(external);
    }
  });

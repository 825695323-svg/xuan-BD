import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CoreDatabase } from '../state/database.js';
import { TaskRuntimeRegistry, TaskService } from '../jobs/tasks.js';
import { FileReferenceService } from './files.js';
import { TemporaryRetention } from './temporary-retention.js';
import { inspectPath, PermissionService } from '../security/permissions.js';

test('three-day temporary retention survives reopen and never removes live, referenced, unresolved or replaced directories', async () => {
  const parent = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'retention-'));
  const root = join(parent, 'artifacts'); mkdirSync(root);
  let db = new CoreDatabase(join(parent, 'core.sqlite')), now = Date.now();
  const runtimes = new TaskRuntimeRegistry(); runtimes.register({ id: 'retention-fixture', execute: async () => ({ summary: 'done' }) });
  let tasks = new TaskService({ database: db, runtimes });
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks.isRunActive(id, generation) }), files = new FileReferenceService({ database: db, permissions });
  let retention = new TemporaryRetention(db, root, () => now);
  const complete = async () => { const task = tasks.create({ title: 'fixture', runtimeId: 'retention-fixture', action: 'done', args: {}, requestId: randomUUID() }); tasks.start(task.id, task.version); return await tasks.wait(task.id); };
  const task = await complete(); assert.equal(task.status, 'succeeded');
  const make = (taskId = task.id) => { const path = join(root, '.direct-' + randomUUID()); mkdirSync(path); writeFileSync(join(path, 'scratch.txt'), 'temporary bytes'); retention.retire(path, taskId, inspectPath(path)); return path; };
  const expired = make(), referenced = make(), swapped = make();
  files.register({ path: join(referenced, 'scratch.txt'), source: 'generated', taskId: task.id });
  const pending = tasks.create({ title: 'unresolved', runtimeId: 'retention-fixture', action: 'done', args: {}, requestId: randomUUID() }), active = make(pending.id);
  const originalMoved = swapped + '-original'; renameSync(swapped, originalMoved);
  const outside = join(parent, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'never-delete.txt'), 'retain'); symlinkSync(outside, swapped);
  const unregistered = join(root, '.direct-' + randomUUID()); mkdirSync(unregistered); writeFileSync(join(unregistered, 'unknown.txt'), 'not released');
  now += 3 * 24 * 60 * 60 * 1000 - 1; assert.equal(retention.sweep().removed, 0); assert.equal(existsSync(expired), true);
  retention.close(); await tasks.dispose(); db.close();
  db = new CoreDatabase(join(parent, 'core.sqlite')); tasks = new TaskService({ database: db, runtimes }); retention = new TemporaryRetention(db, root, () => now);
  now++; assert.equal(retention.sweep().removed, 1); assert.equal(existsSync(expired), false);
  for (const path of [referenced, active, originalMoved, swapped, outside, unregistered]) assert.equal(existsSync(path), true, path);
  assert.equal(existsSync(join(outside, 'never-delete.txt')), true);
  assert.equal(retention.status().temporaryRetentionDays, 3); assert.equal(retention.status().cloudEvidenceExpires, false);
  assert.equal(retention.sweep().removed, 0);
  retention.close(); await tasks.dispose(); db.close();
});

test('controlled process scratch expires after three days while unknown, live and unrecognized roots remain', async () => {
  const { statSync, readFileSync } = await import('node:fs');
  const { ResourceBindings } = await import('./bindings.js');
  const { ProcessRuntime } = await import('../runtime/programs.js');
  const { runDirectProcess } = await import('../runtime/process.js');
  const parent = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'process-retention-'));
  mkdirSync(join(parent, 'config'));
  const resources: Record<string, unknown> = { node: { path: process.execPath, kind: 'program' } };
  for (const key of ['cache', 'temp', 'downloads']) {
    const path = join(parent, key); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[key] = { path, kind: 'directory', owned: true, identity: key, device: String(stat.dev), inode: String(stat.ino) };
  }
  writeFileSync(join(parent, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'retention-test' }));
  writeFileSync(join(parent, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'retention-test', resources }));
  const bindings = new ResourceBindings(parent), runtime = new ProcessRuntime(bindings);
  const db = new CoreDatabase(join(parent, 'core.sqlite')), permissions = new PermissionService({ database: db, isRunActive: () => false });
  const files = new FileReferenceService({ database: db, permissions, resources: bindings });
  runtime.registerTemporaryReferenceGuard(db.path, path => files.hasReferenceWithin(path));
  const done = await runDirectProcess({ binary: 'node', runtime, args: ['-e', 'process.stdout.write("actual child settled")'], cwd: parent,
    signal: new AbortController().signal, assertAuthorized() {} });
  assert.equal(done.stdout, 'actual child settled');
  const { readdirSync } = await import('node:fs');
  const id = readdirSync(join(parent, 'temp')).find(name => /^[a-f0-9-]{36}$/u.test(name))!, path = join(parent, 'temp', id), marker = JSON.parse(readFileSync(join(path, 'process.json'), 'utf8'));
  assert.equal(marker.state, 'released'); assert.equal(existsSync(path), true);
  const unknown = runtime.prepare('node'); unknown.record('unknown'); assert.throws(() => unknown.cleanup());
  const active = runtime.prepare('node'); active.record('started', { pid: process.pid, startIdentity: 'live-fixture' }); active.cleanup();
  const referenced = runtime.prepare('node'); const referencedFile = join(referenced.downloads, 'registered.txt'); writeFileSync(referencedFile, 'persistent evidence');
  const otherDb = new CoreDatabase(join(parent, 'other.sqlite')), otherFiles = new FileReferenceService({ database: otherDb, permissions, resources: bindings });
  const otherRuntime = new ProcessRuntime(bindings); otherRuntime.registerTemporaryReferenceGuard(otherDb.path, path => otherFiles.hasReferenceWithin(path));
  const reference = otherFiles.register({ path: referencedFile, source: 'generated' }); referenced.cleanup();
  const unrecognized = join(parent, 'temp', randomUUID()); mkdirSync(unrecognized);
  assert.equal(runtime.sweepTemporary(marker.expiresAt - 1), 0); assert.equal(runtime.sweepTemporary(marker.expiresAt), 1);
  assert.equal(existsSync(path), false); assert.equal(existsSync(join(parent, 'downloads', id)), false);
  for (const kept of [unknown.temporary, active.temporary, referenced.temporary, referenced.downloads, unrecognized]) assert.equal(existsSync(kept), true);
  assert.equal(otherFiles.verify(reference.id).status, 'available');
  runtime.closeTemporaryRetention(); otherRuntime.closeTemporaryRetention(); db.close(); otherDb.close();
});

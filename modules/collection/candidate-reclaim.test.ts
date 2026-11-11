import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { migrateCandidateObjects } from './candidate-object-storage.js';
import { createCandidateReclaimActions } from './candidate-reclaim.js';

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const largeRows = Array.from({ length: 12000 }, (_, i) => [i, i + 1, i + 2]);
const first = Buffer.from(JSON.stringify({ rows: largeRows, source: 'A' }));
const second = Buffer.from(JSON.stringify({ rows: largeRows, source: 'B' }));
function fixture(shared = false) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'candidate-reclaim-')));
  const database = new CoreDatabase(join(root, 'db.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  permissions.grant({ capabilities: [{ action: 'secret', target: { kind: 'secret', name: 'bd-candidate-storage-maintenance' } }] });
  const registry = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, permissions, runtimes: registry });
  database.connection.exec([
    'CREATE TABLE candidate_objects(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,bytes BLOB NOT NULL);',
    'CREATE TABLE processing_plan_steps(output_json TEXT, input_json TEXT,parameters_json TEXT,spec_digest TEXT);',
    'CREATE TABLE processing_plan_outputs(structured_json TEXT);',
    'CREATE TABLE processing_plans(document_json TEXT, material_manifest_json TEXT);',
    'CREATE TABLE r1_handoff_attempts(state TEXT,local_refs_json TEXT,document_json TEXT);',
  ].join(''));
  const insert = (value: Buffer, shaOverride?: string) => {
    const sha = shaOverride ?? digest(value);
    database.connection.prepare('INSERT INTO candidate_objects VALUES(?,?,?)').run(sha, value.length, value);
    return sha;
  };
  const a = insert(first), b = insert(second);
  database.connection.prepare('INSERT INTO processing_plan_steps VALUES(?,?,?,?)').run(
    JSON.stringify({ kind: 'stored-object', sha256: a }), null, null, null);
  if (shared) migrateCandidateObjects(database.connection);
  const actions = createCandidateReclaimActions({ database });
  registry.register({ id: 'direct', execute: ctx => actions.execute(ctx, ctx.task.action, ctx.task.args as never) });
  const call = async (action: string, args: Record<string, string> = {}) => {
    const task = tasks.create({ title: action, ownerRole: 'service', action, runtimeId: 'direct', args, requestId: randomUUID() });
    tasks.start(task.id, task.version);
    return tasks.wait(task.id);
  };
  return { root, database, tasks, actions, a, b, call, insert,
    async close() { await tasks.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
test('shared row-block candidate cleanup only removes truly unreferenced objects', async () => {
  const f = fixture(true);
  try {
    assert.equal(f.database.connection.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()?.type, 'view');
    const initialBlocks = Number(f.database.connection.prepare('SELECT count(*) n FROM candidate_row_blocks').get()?.n);
    assert.ok(initialBlocks > 0, 'large shared JSON rows must have deduplicated storage');
    const inspected = await f.call('artifact.candidates.inspect');
    assert.equal(inspected.status, 'succeeded', JSON.stringify(inspected.error));
    const plan = inspected.result!.data as any;
    assert.ok(plan.candidates.some((item: any) => item.sha256 === f.b));
    assert.ok(!plan.candidates.some((item: any) => item.sha256 === f.a));
    const pruned = await f.call('artifact.candidates.prune', { expectedPlanDigest: plan.planDigest });
    assert.equal(pruned.status, 'succeeded', JSON.stringify(pruned.error));
    assert.equal((pruned.result?.data as any).removed, 1);
    assert.equal(f.database.connection.prepare('SELECT 1 FROM candidate_objects WHERE sha256=?').get(f.b), undefined);
    const retained = f.database.connection.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?').get(f.a)?.bytes;
    assert.ok(retained instanceof Uint8Array);
    assert.deepEqual(Buffer.from(retained as Uint8Array), first);
    assert.equal(Number(f.database.connection.prepare('SELECT count(*) n FROM candidate_row_blocks').get()?.n), initialBlocks);
    const retry = await f.call('artifact.candidates.prune', { expectedPlanDigest: plan.planDigest });
    assert.equal(retry.status, 'failed');
    assert.equal(retry.error?.code, 'CANDIDATE_RECLAIM_STALE');
  } finally { await f.close(); }
});
test('unfinished R1 handoff blocks every candidate deletion', async () => {
  const f = fixture();
  try {
    f.database.connection.prepare('INSERT INTO r1_handoff_attempts VALUES(?,?,?)').run('pending_receipt', '{}', '{}');
    const inspected = await f.call('artifact.candidates.inspect');
    const plan = inspected.result!.data as any;
    assert.equal(plan.candidates.length, 0);
    assert.ok(plan.globalBlockers.includes('unsettled-r1-handoff'));
    const pruning = await f.call('artifact.candidates.prune', { expectedPlanDigest: plan.planDigest });
    assert.equal(pruning.status, 'failed'); assert.equal(pruning.error?.code, 'CANDIDATE_RECLAIM_BLOCKED');
    assert.equal(Number(f.database.connection.prepare('SELECT count(*) n FROM candidate_objects').get()?.n), 2);
  } finally { await f.close(); }
});
test('corrupt orphan is preserved for investigation, and no partial deletion is committed', async () => {
  const f = fixture();
  try {
    const broken = f.insert(Buffer.from('broken-but-same-shape'), 'f'.repeat(64));
    const inspected = await f.call('artifact.candidates.inspect');
    const plan = inspected.result!.data as any;
    assert.ok(plan.candidates.some((item: any) => item.sha256 === broken));
    const prune = await f.call('artifact.candidates.prune', { expectedPlanDigest: plan.planDigest });
    assert.equal(prune.status, 'failed'); assert.equal(prune.error?.code, 'CANDIDATE_RECLAIM_CORRUPT');
    assert.ok(f.database.connection.prepare('SELECT 1 FROM candidate_objects WHERE sha256=?').get(f.b));
    assert.ok(f.database.connection.prepare('SELECT 1 FROM candidate_objects WHERE sha256=?').get(broken));
  } finally { await f.close(); }
});
test('unrelated task frozen reference prevents candidate pruning', async () => {
  const f = fixture();
  try {
    f.tasks.create({ title: 'needs candidate', ownerRole: 'service', runtimeId: 'direct', action: 'processing.review',
      args: { storedObject: { sha256: f.b } }, requestId: 'candidate-pending' });
    const inspected = await f.call('artifact.candidates.inspect');
    const plan = inspected.result!.data as any;
    assert.equal(plan.candidates.length, 0, 'active processing work blocks all pruning');
    assert.ok(plan.globalBlockers.includes('active-processing-or-r1-tasks'));
  } finally { await f.close(); }
});

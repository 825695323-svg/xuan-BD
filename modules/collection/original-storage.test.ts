import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { MaterialService } from './materials/service.js';
import { R1HandoffService, type R1SourceRef } from './r1-structured-handoff.js';
import { migrateMaterialOriginalSharing, planMaterialOriginalSharing } from './original-storage.js';

const raw = Buffer.from('business_key,value\nfixture:1,12.30\n');
const source = (sourceId = 'fixture:one'): R1SourceRef => ({ source_id: sourceId, provider: 'synthetic-test',
  requested_url: 'https://example.test/input.csv', requested_at_utc: '2026-01-02T00:00:00Z',
  acquired_at_utc: '2026-01-02T00:01:00Z', sha256: wfdSha256(raw), bytes: raw.length,
  usage_scope: 'isolated-test', authorization: { status: 'authorized', basis: 'isolated storage test' } });
const LEGACY_MATERIAL_SCHEMA = `CREATE TABLE material_inputs (
 material_id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE material_objects(material_id TEXT PRIMARY KEY REFERENCES material_inputs(material_id),
 envelope_json TEXT NOT NULL,envelope_digest TEXT NOT NULL,preview_json TEXT NOT NULL,preview_digest TEXT NOT NULL,
 original_bytes BLOB NOT NULL);`;
function fixture(order: 'materials-first' | 'r1-first', path?: string, legacy = false) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'original-sharing-')));
  const database = new CoreDatabase(path ?? join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions });
  const runtimes = new TaskRuntimeRegistry(); tasks = new TaskService({ database, runtimes, permissions });
  if (legacy) database.migrate('materials', 1, LEGACY_MATERIAL_SCHEMA);
  let handoff: R1HandoffService | undefined;
  if (order === 'r1-first') handoff = new R1HandoffService({ database });
  const materials = new MaterialService({ database, tasks: () => tasks, files, environment: 'synthetic-test' });
  handoff ??= new R1HandoffService({ database });
  runtimes.register(materials.runtime);
  return { root, database, materials, handoff, async accept(name = 'input.csv') {
    const path = join(root, randomUUID() + '.csv'); writeFileSync(path, raw);
    const reference = files.register({ path, displayName: name, source: 'user-attached' });
    permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
    const task = materials.submit({ fileRefId: reference.id, category: 'data', expectedSha256: wfdSha256(raw) }, randomUUID());
    const done = await tasks.wait(task.id); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    return materials.getByTask(task.id)!.envelope.materialId;
  }, async close() { await tasks.dispose(); database.close(); } };
}

for (const order of ['materials-first', 'r1-first'] as const) test(`originals share one physical byte object with ${order}`, async () => {
  const f = fixture(order);
  try {
    if (order === 'r1-first') f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const materialOne = await f.accept(), materialTwo = await f.accept('another-source.csv');
    const originalOne = f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const originalTwo = f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source('fixture:two') });
    assert.notEqual(materialOne, materialTwo); assert.notEqual(originalOne.originalId, originalTwo.originalId);
    assert.equal(f.database.connection.prepare("SELECT type FROM sqlite_schema WHERE name='material_objects'").get()!.type, 'view');
    assert.equal(f.database.connection.prepare('SELECT count(*) n FROM r1_original_contents').get()!.n, 1);
    assert.equal(f.database.connection.prepare('SELECT sum(length(original_bytes)) n FROM r1_original_contents').get()!.n, raw.length);
    assert.deepEqual(f.materials.readOriginal(materialOne).bytes, raw);
    assert.deepEqual(f.materials.readOriginal(materialTwo).bytes, raw);
    assert.deepEqual(f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() }), originalOne);
    writeFileSync(join(f.root, 'byte-accounting.json'), JSON.stringify({ materialIds: [materialOne, materialTwo],
      originalIds: [originalOne.originalId, originalTwo.originalId], plan: planMaterialOriginalSharing(f.database.connection) }, null, 2));
  } finally { await f.close(); }
});

test('legacy migration preserves existing service readers, six-column intake, source IDs and exact metadata', async () => {
  let f = fixture('materials-first', undefined, true);
  const path = f.database.path;
  try {
    const one = await f.accept(), two = await f.accept('different-source.csv');
    const original = f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const oldRecord = f.materials.get(one), before = planMaterialOriginalSharing(f.database.connection);
    assert.equal(before.mode, 'legacy'); assert.equal(before.reclaimablePayloadBytes, raw.length * 2);
    const migrated = migrateMaterialOriginalSharing(f.database.connection);
    assert.equal(migrated.applied, true); assert.equal(migrated.after.currentPayloadBytes, raw.length);
    assert.equal(f.database.connection.prepare("SELECT version FROM schema_versions WHERE module='materials'").get()!.version, 1);
    assert.equal(f.database.connection.prepare("SELECT version FROM schema_versions WHERE module='r1-structured-handoff'").get()!.version, 3);
    // These are the same already-constructed methods and six-column INSERT used by old in-memory services.
    assert.deepEqual(f.materials.get(one), oldRecord); assert.deepEqual(f.materials.readOriginal(two).bytes, raw);
    const three = await f.accept('old-live-intake.csv');
    assert.deepEqual(f.materials.readOriginal(three).bytes, raw);
    assert.deepEqual(f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() }), original);
    assert.notEqual(f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source('fixture:two') }).originalId, original.originalId);
    assert.equal(planMaterialOriginalSharing(f.database.connection).currentPayloadBytes, raw.length);
    assert.equal(migrateMaterialOriginalSharing(f.database.connection).applied, false);
    writeFileSync(join(f.root, 'migration-byte-accounting.json'), JSON.stringify(migrated, null, 2));
    await f.close(); f = fixture('r1-first', path);
    assert.deepEqual(f.materials.get(one), oldRecord); assert.deepEqual(f.materials.readOriginal(three).bytes, raw);
    assert.deepEqual(f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() }), original);
  } finally { await f.close(); }
});

test('existing legacy data is kept until explicit migration and CLI preview never creates or edits a database', async () => {
  const f = fixture('r1-first', undefined, true);
  try {
    await f.accept(); const expected = planMaterialOriginalSharing(f.database.connection);
    const script = fileURLToPath(new URL('../../scripts/share-material-originals.ts', import.meta.url));
    const preview = spawnSync(process.execPath, ['--import', 'tsx', script, '--database=' + f.database.path], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr); assert.deepEqual(JSON.parse(preview.stdout).plan, expected);
    assert.equal(f.database.connection.prepare("SELECT type FROM sqlite_schema WHERE name='material_objects'").get()!.type, 'table');
    const missing = join(f.root, 'does-not-exist.sqlite');
    const absent = spawnSync(process.execPath, ['--import', 'tsx', script, '--database=' + missing, '--apply'], { encoding: 'utf8' });
    assert.notEqual(absent.status, 0); assert.throws(() => readFileSync(missing), { code: 'ENOENT' });
    const applied = spawnSync(process.execPath, ['--import', 'tsx', script, '--database=' + f.database.path, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).applied, true);
    assert.equal(planMaterialOriginalSharing(f.database.connection).mode, 'shared');
  } finally { await f.close(); }
});

test('corrupt material or existing shared content aborts conversion without rewriting the source', async () => {
  const f = fixture('materials-first', undefined, true);
  try {
    const materialId = await f.accept();
    f.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('damaged'), materialId);
    assert.throws(() => migrateMaterialOriginalSharing(f.database.connection), /材料原件/);
    assert.equal(f.database.connection.prepare("SELECT type FROM sqlite_schema WHERE name='material_objects'").get()!.type, 'table');
    assert.equal(f.database.connection.prepare('SELECT count(*) n FROM r1_original_contents').get()!.n, 0);
    f.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(raw, materialId);
    const original = f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    migrateMaterialOriginalSharing(f.database.connection);
    f.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('damaged'), materialId);
    assert.throws(() => f.materials.readOriginal(materialId), { code: 'MATERIAL_ORIGINAL_CHANGED' });
    assert.throws(() => f.handoff.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() }), { code: 'R1_ORIGINAL_CHANGED' });
    assert.equal(f.database.connection.prepare('SELECT original_id FROM r1_originals').get()!.original_id, original.originalId);
    assert.throws(() => migrateMaterialOriginalSharing(f.database.connection), /已有共享内容摘要不符/);
  } finally { await f.close(); }
});

test('conversion rolls back copied bytes and schema together, then the same migration can retry', async () => {
  const f = fixture('r1-first', undefined, true);
  try {
    const materialId = await f.accept(), before = planMaterialOriginalSharing(f.database.connection);
    const exec = f.database.connection.exec.bind(f.database.connection);
    f.database.connection.exec = sql => { if (sql === 'DROP TABLE material_objects') throw new Error('INJECTED_BEFORE_REPLACEMENT'); exec(sql); };
    try { assert.throws(() => migrateMaterialOriginalSharing(f.database.connection), /INJECTED_BEFORE_REPLACEMENT/); }
    finally { f.database.connection.exec = exec; }
    assert.deepEqual(planMaterialOriginalSharing(f.database.connection), before);
    assert.equal(f.database.connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='material_object_records'").get()!.n, 0);
    assert.deepEqual(f.materials.readOriginal(materialId).bytes, raw);
    assert.equal(migrateMaterialOriginalSharing(f.database.connection).applied, true);
  } finally { await f.close(); }
});

test('process termination before commit reopens the original SQLite state and retries with unchanged material IDs', async () => {
  let f = fixture('materials-first', undefined, true);
  const path = f.database.path, materialId = await f.accept(), before = planMaterialOriginalSharing(f.database.connection);
  await f.close();
  const moduleUrl = new URL('./original-storage.ts', import.meta.url).href;
  const worker = `import {DatabaseSync} from 'node:sqlite'; import {migrateMaterialOriginalSharing} from ${JSON.stringify(moduleUrl)};
    const db=new DatabaseSync(process.argv[1],{enableForeignKeyConstraints:true});
    const exec=db.exec.bind(db); db.exec=sql=>{if(sql==='DROP TABLE material_objects')process.kill(process.pid,'SIGKILL');exec(sql)};
    migrateMaterialOriginalSharing(db);`;
  const killed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, path], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  f = fixture('r1-first', path);
  try {
    assert.deepEqual(planMaterialOriginalSharing(f.database.connection), before);
    assert.deepEqual(f.materials.readOriginal(materialId).bytes, raw);
    assert.equal(migrateMaterialOriginalSharing(f.database.connection).applied, true);
    assert.deepEqual(f.materials.readOriginal(materialId).bytes, raw);
  } finally { await f.close(); }
});

test('migration refuses uninitialized older R1 modules without creating a conflicting content table', () => {
  const db = new CoreDatabase();
  try {
    db.connection.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)'); db.migrate('materials', 1, LEGACY_MATERIAL_SCHEMA);
    assert.throws(() => migrateMaterialOriginalSharing(db.connection), /R1 v2 初始化/);
    assert.equal(db.connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='r1_original_contents'").get()!.n, 0);
    // The old R1 schema can still initialize after the refused conversion.
    db.migrate('r1-structured-handoff', 1, 'CREATE TABLE r1_originals(original_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,media_type TEXT NOT NULL,source_json TEXT NOT NULL,source_digest TEXT NOT NULL,original_bytes BLOB NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE r1_record_associations (  dataset_id TEXT NOT NULL, product_id TEXT NOT NULL, definition_digest TEXT NOT NULL,  snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL,  request_id TEXT NOT NULL, original_id TEXT NOT NULL, source_id TEXT NOT NULL,  process_refs_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at INTEGER NOT NULL,  PRIMARY KEY(dataset_id,product_id,record_id,record_version));  CREATE INDEX r1_assoc_request ON r1_record_associations(request_id);');
    new R1HandoffService({ database: db }); assert.equal(migrateMaterialOriginalSharing(db.connection).applied, true);
  } finally { db.close(); }
});

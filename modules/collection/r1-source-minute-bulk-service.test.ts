import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { SOURCE_MINUTE_BATCH_PROTOCOL, type SourceMinuteBatchChunk } from '../../contracts/source-minute-batch.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { ManagedOriginalStore } from './managed-originals.js';
import { MaterialService } from './materials/service.js';
import { R1ChunkedCsvService } from './r1-chunked-csv.js';
import type { R1AutoService } from './r1-auto.js';
import { assertSourceMinuteDiskGrowth, R1_SOURCE_MINUTE_ACTIONS, R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS, R1SourceMinuteBulkService, type R1SourceMinuteBulkTransport } from './r1-source-minute-bulk-service.js';
import { buildSourceMinuteBatchHeader } from './r1-source-minute-transport.js';
import { R1_WORKSPACE_RUNTIME, R1WorkspaceService } from './r1-workspace.js';
import type { R1Runtime } from './r1-runtime.js';
import type { R1HandoffService } from './r1-structured-handoff.js';
import { SourceFieldProfileStore } from './source-field-profile.js';
import type { OperatorContext, ProcessingPlanService } from './processing-plan.js';

const columns = ['证券代码', '证券名称', '交易日期', '分钟时间', '开盘价（元）', '最高价（元）', '最低价（元）', '收盘价（元）', '成交量', '成交额', '复权因子'];
const bytes = Buffer.from(columns.join(',') + '\r\n000001,合成,20260407,2026-04-07 09:30:00,0.0,1,0,0.0,0,,1.0\r\n');
const profile = {
  version: 'bd.source-field-profile/1', mappingVersion: 1, profileId: 'bulk.synthetic', sourceId: 'synthetic-source', series: 'source-series',
  confirmation: { status: 'operator_confirmed', basis: '合成测试使用来源原报标签', confirmedAtUtc: '2026-04-07T00:00:00Z' },
  frequency: 'minute', timeBucket: { labelSemantics: 'unknown', interval: 'unknown', lengthMinutes: 1, timezone: 'Asia/Shanghai' },
  adjustment: { status: 'unknown' },
  fields: columns.map((originalHeader, i) => ({ originalHeader, fieldCode: 'src_' + i, dataType: 'text', unitCode: i === 2 ? 'date' : 'not_applicable',
    role: ['identity', 'value', 'date', 'minute'][i] ?? 'value', ...(i >= 4 ? { measurementStatus: 'unknown' } : {}) })),
};
const source = { source_id: 'synthetic-source', provider: 'synthetic-provider', requested_url: 'file:///synthetic/source-series/file.csv',
  requested_at_utc: '2026-04-07T00:00:00Z', acquired_at_utc: '2026-04-07T00:01:00Z', usage_scope: 'synthetic verification only',
  authorization: { status: 'authorized', basis: 'fixture generated for this test' } };
const input = (intakeId: string) => ({ intakeId, name: 'synthetic.csv', sha256: wfdSha256(bytes), byteLength: bytes.length, source, datasetId: 'synthetic' });
const bulkInput = (id: string) => ({ ...input(id), mode: 'source_minute_bulk_v1', sourceValueColumns: columns, partitionDate: '20260407' });
const operator = (requestId: string): OperatorContext => ({ operatorId: 'synthetic.local', requestId, method: 'POST',
  path: '/api/bd/r1/batches/chunked', remoteAddress: null, observedAt: Date.now() });
type Test = { after(fn: () => Promise<void>): void };

function setup(t: Test) {
  const path = realpathSync(mkdtempSync(join(process.env.BD_SYNTHETIC_BULK_TMP ?? tmpdir(), 'bd-bulk-controller-')));
  const external = join(path, 'owned'), config = join(path, 'config');
  mkdirSync(external); mkdirSync(config);
  const stat = statSync(external, { bigint: true });
  writeFileSync(join(path, '.xuan-runtime.json'), JSON.stringify({ application: 'xuan-bd', version: 1, identity: 'fixture' }));
  writeFileSync(join(config, 'machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'fixture',
    resources: { bulk_csv: { path: external, kind: 'directory', owned: true, identity: 'fixture:bulk', device: String(stat.dev), inode: String(stat.ino) } } }));
  const profileDirectory = join(config, 'source-fields'); mkdirSync(profileDirectory);
  const profilePath = join(profileDirectory, 'fixture.json'); writeFileSync(profilePath, JSON.stringify(profile));
  const resources = new ResourceBindings(path), database = new CoreDatabase(join(path, 'core.sqlite'));
  const runtimes = new TaskRuntimeRegistry();
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks.isRunActive(id, generation) });
  const commitBudgetPolicy = Object.freeze({ runtimeId: R1_WORKSPACE_RUNTIME, action: R1_SOURCE_MINUTE_ACTIONS[1],
    maxNoProgressMs: R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS });
  tasks = new TaskService({ database, runtimes, permissions, initialBudgetPolicy: commitBudgetPolicy });
  const files = new FileReferenceService({ database, permissions, resources });
  const materials = new MaterialService({ database, tasks: () => tasks, files, resources, environment: 'synthetic-test' });
  runtimes.register(materials.runtime);
  const store = new ManagedOriginalStore({ database, materials, bindings: resources, ownedRoot: 'bulk_csv' });
  const connection: R1ConnectionIdentity = { connectionId: 'synthetic', protocol: 'wfd.structured-ingest/1.0', profile: 'data_only',
    mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'fixture', store: external, runtime: path, callerId: 'fixture', namespace: 'synthetic.local',
    configSha256: 'a', schemaSha256: 'b', entrySha256: 'c', pythonPath: path, entryPath: path };
  let frozenChunks: SourceMinuteBatchChunk[] = [], remote = '', activation: WfdRecord = {};
  let finalizeCalls = 0, beginCalls = 0, verifiedCheckpoint = false, readbackAttempts = 0, legacyAccept = 0;
  const problems = { putLoss: false, finalizeLoss: false, badReceipt: false, readbackInterrupted: false, activationObserved: true,
    cleanupRequired: false, waitOnPut: null as (() => Promise<void>) | null };
  const received = new Set<number>();
  const reply = (result: WfdRecord) => ({ result });
  const phase = (batch_id: string) => reply(remote ? { protocol_version: SOURCE_MINUTE_BATCH_PROTOCOL, batch_id,
    expected_chunks: frozenChunks.length, received_chunks: received.size, chunk_offset: 0, next_chunk_offset: null,
    chunks: frozenChunks.map(chunk => ({ ...chunk, received: received.has(chunk.ordinal) })), phase: remote, ...activation }
    : { phase: 'not_found', status: 'not_found', batch_id });
  const client = {
    batchStatus: async (id: string) => phase(id),
    sourceMinuteBatchBegin: async (id: string, _header: unknown, chunks: SourceMinuteBatchChunk[]) => {
      beginCalls++; frozenChunks = chunks; if (!remote) remote = 'collecting'; return phase(id);
    },
    sourceMinuteBatchPut: async (id: string, _output: string, chunk: SourceMinuteBatchChunk, cells: (string | null)[][]) => {
      assert.equal(cells[0]![4], '0.0'); assert.equal(cells[0]![9], null);
      if (problems.waitOnPut) await problems.waitOnPut();
      received.add(chunk.ordinal); if (received.size === frozenChunks.length) remote = 'ready';
      if (problems.putLoss) { problems.putLoss = false; throw new Error('lost staged response'); }
      return phase(id);
    },
    batchFinalize: async (id: string) => {
      finalizeCalls++;
      if (problems.finalizeLoss) {
        problems.finalizeLoss = false;
        remote = problems.cleanupRequired ? 'finalized' : 'finalizing';
        activation = problems.cleanupRequired ? { state: 'published_formal', formal_publication_verified: true, staging_cleanup_required: true }
          : problems.activationObserved ? { recovery_required: true, activation_state: 'activated',
            result_root: 'sha256:' + 'c'.repeat(64), snapshot_id: 's_' + 'a'.repeat(24), partition: '20260407' }
            : { recovery_required: true, activation_state: 'not_activated' };
        throw new Error('lost finalize response');
      }
      remote = 'finalized'; activation = { state: 'published_formal', formal_publication_verified: true, staging_cleanup_required: false }; return phase(id);
    },
    sourceMinuteReadPage: async (request: { snapshot_id: string; product_id: string; partition: string; result_root: string }) => {
      assert.equal(request.snapshot_id, 's_' + 'a'.repeat(24));
      assert.equal(request.product_id, 'p_' + 'b'.repeat(24));
      assert.equal(request.partition, '20260407');
      assert.equal(request.result_root, 'sha256:' + 'c'.repeat(64));
      return reply({ snapshot_id: request.snapshot_id, product_id: request.product_id, partition: request.partition,
        result_root: request.result_root, row_count: 1,
        rows_digest: (database.connection.prepare("SELECT json_extract(record_json, '$.manifest.rowsDigest') AS digest FROM r1_source_minute_bulk").get()?.digest),
        rows: [{ cells: ['000001'], row_index: 0 }], next_cursor: null });
    },
  };
  const runtime = { connection: { client, store: external, runtime: path }, currentIdentity: () => ({ ...connection }), client: {
    usageStatus: async () => reply({ format_version: 'wfd.usage-suspension/1', issues: [], tickets: [], active_issues: 0, suspended_record_versions: 0 }),
  } } as unknown as R1Runtime;
  const processing = { moduleCapability: () => ({ status: 'ready' }) } as unknown as ProcessingPlanService;
  const workspace = new R1WorkspaceService({ database, tasks: () => tasks, runtime, processing, materials,
    configuration: { state: 'ready', reason: null }, handoff: {} as R1HandoffService });
  runtimes.register(workspace.runtime);
  const transport: R1SourceMinuteBulkTransport = {
    buildHeader: buildSourceMinuteBatchHeader,
    verifyReceipt: (_header, manifest, result) => {
      assert.equal((result as WfdRecord).formal_publication_verified, true);
      if (problems.badReceipt) throw new Error('wrong fixed receipt');
      return { snapshot_id: 's_' + 'a'.repeat(24), product_id: 'p_' + 'b'.repeat(24), partition: '20260407',
        result_root: 'sha256:' + 'c'.repeat(64), row_summary: { inserted: manifest.rowCount, duplicate_skipped: 0, conflict_pending: 0 } };
    },
    verifyReadback: async ({ checkpoint, onCheckpoint, assertCurrent }) => {
      readbackAttempts++; assertCurrent(); verifiedCheckpoint = checkpoint?.verifiedRows === 1;
      await onCheckpoint({ verifiedRows: 1, verifiedChunks: 1 });
      if (problems.readbackInterrupted) { problems.readbackInterrupted = false; throw new Error('lost readback'); }
      return { complete: true, rowCount: 1 };
    },
  };
  const bulk = new R1SourceMinuteBulkService({ database, tasks: () => tasks, materials, store, resources, profileStore: new SourceFieldProfileStore(profileDirectory),
    runtime, processing, workspace: { snapshotStatus: async () => ({ snapshotId: null, connection: { roles: ['read', 'submit', 'publish'] } } as never) },
    transport, commitBudgetPolicy });
  workspace.setSourceMinuteBulkHandler(bulk);
  const legacyOptions = { database, tasks: () => tasks, materials, auto: {} as R1AutoService, connection: () => connection,
    accept: async () => { legacyAccept++; throw new Error('old publication must not run during this fixture'); } };
  const chunked = new R1ChunkedCsvService({ ...legacyOptions, bulk });
  t.after(async () => { await chunked.dispose(); await tasks.dispose(); database.close(); rmSync(path, { recursive: true, force: true }); });
  const status = async (id: string, kind: 'stage' | 'commit') => {
    const view = chunked.get(id).bulk!;
    const task = await tasks.wait((kind === 'stage' ? view.stageTaskId : view.commitTaskId)!);
    return { task, view: chunked.get(id) };
  };
  return { database, tasks, chunked, store, external, profilePath, connection, legacyOptions, problems, status,
    counters: () => ({ beginCalls, finalizeCalls, legacyAccept, verifiedCheckpoint, readbackAttempts }) };
}

test('explicit batch stages, confirms, reads back and reclaims only derived files', async t => {
  const f = setup(t), id = 'whole-file';
  const withoutBulk = new R1ChunkedCsvService(f.legacyOptions);
  await assert.rejects(withoutBulk.startAny(bulkInput(id), operator(id)), { code: 'R1_BULK_UNAVAILABLE' });
  const legacy = withoutBulk.start(input('legacy'), operator('legacy'));
  assert.equal(legacy.mode, undefined);
  assert.equal(withoutBulk.upload('legacy', 0, bytes).receivedBytes, bytes.length);
  const accepted = await f.chunked.startAny(bulkInput(id), operator(id));
  assert.equal(accepted.mode, 'source_minute_bulk_v1');
  assert.equal(accepted.state, 'receiving');
  assert.throws(() => f.chunked.start(input(id), operator(id)), { code: 'R1_CSV_CONFLICT' });
  assert.throws(() => f.chunked.upload(id, 0, bytes), { code: 'R1_BULK_CHUNK_DIGEST' });
  f.chunked.upload(id, 0, bytes, wfdSha256(bytes));
  await f.chunked.advance(id);
  const staged = await f.status(id, 'stage');
  assert.equal(staged.task.status, 'succeeded', JSON.stringify(staged.task.error));
  assert.equal(staged.view.bulk?.phase, 'ready_to_commit');
  assert.equal(f.counters().finalizeCalls, 0);
  await assert.rejects(f.chunked.readBulkPage(id, { pageSize: 1, cursor: null }), { code: 'R1_BULK_READ_NOT_READY' });
  assert.equal(f.counters().legacyAccept, 0);
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM r1_csv_upload_chunks WHERE intake_id=?').get(id)?.n, 0);
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM r1_csv_pages WHERE intake_id=?').get(id)?.n, 0);
  await assert.rejects(f.chunked.reclaim(id), { code: 'R1_BULK_RECLAIM_NOT_READY' });
  await assert.rejects(f.chunked.commit(id, 'sha256:' + '0'.repeat(64)), { code: 'R1_BULK_CONFIRMATION' });
  await f.chunked.commit(id, staged.view.bulk!.manifestDigest);
  const completed = await f.status(id, 'commit');
  assert.equal(completed.task.status, 'succeeded', JSON.stringify(completed.task.error));
  assert.equal(completed.view.state, 'completed');
  assert.equal(completed.view.bulk?.association?.materialId, completed.view.materialId);
  assert.equal(f.counters().finalizeCalls, 1);
  assert.equal(f.counters().readbackAttempts, 1);
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM r1_source_minute_associations').get()?.n, 1);
  await assert.rejects(f.chunked.readBulkPage(id, { pageSize: 1, cursor: null, snapshotId: 'untrusted' }), { code: 'R1_BULK_READ_INPUT' });
  const page = await f.chunked.readBulkPage(id, { pageSize: 1, cursor: null });
  assert.equal(page.row_count, 1);
  // Simulate the durable BD association surviving the crash before TaskService records success.
  const commitId = completed.task.id;
  f.database.connection.prepare("UPDATE tasks SET status='interrupted',result=NULL WHERE id=?").run(commitId);
  await assert.rejects(f.chunked.reclaim(id), { code: 'R1_BULK_RECLAIM_NOT_READY' });
  await f.chunked.advance(id);
  const recovered = await f.status(id, 'commit');
  assert.equal(recovered.task.status, 'succeeded', JSON.stringify(recovered.task.error));
  assert.equal(recovered.task.id, commitId);
  assert.equal(f.counters().finalizeCalls, 1);
  assert.equal(f.counters().readbackAttempts, 1);
  await f.tasks.stopControl('synthetic stop after completion');
  f.tasks.resumeControl(f.tasks.getControl().generation, 'synthetic resume after completion');
  await f.chunked.reclaim(id);
  assert.equal(f.store.status(id).state, 'sealed');
  assert.deepEqual(f.store.readRange(id, 0, bytes.length), bytes);
  assert.equal(readdirSync(f.external).some(name => name.startsWith('bd-source-minute-stage-')), false);
});

test('same task and request recover lost stage/finalize and resume verified readback boundary', async t => {
  const f = setup(t), id = 'recover';
  await f.chunked.startAny(bulkInput(id), operator(id));
  f.chunked.upload(id, 0, bytes, wfdSha256(bytes));
  f.problems.putLoss = true;
  await f.chunked.advance(id);
  const stage = await f.status(id, 'stage');
  assert.equal(stage.task.status, 'needs_review');
  await f.chunked.advance(id);
  const recovered = await f.status(id, 'stage');
  assert.equal(recovered.task.id, stage.task.id);
  assert.equal(recovered.task.status, 'succeeded', JSON.stringify(recovered.task.error));
  const digest = recovered.view.bulk!.manifestDigest;
  f.problems.finalizeLoss = true;
  await f.chunked.commit(id, digest);
  const commit = await f.status(id, 'commit');
  assert.equal(commit.task.status, 'needs_review');
  assert.equal(f.counters().finalizeCalls, 1);
  f.problems.readbackInterrupted = true;
  writeFileSync(f.profilePath, JSON.stringify({ ...profile, confirmation: { ...profile.confirmation, basis: 'new profile after activation' } }));
  // Simulate the elapsed budget at the time the original finalize response was lost.
  f.database.connection.prepare('UPDATE task_budgets SET active_ms=210001, progress_active_ms=0 WHERE scope=?').run(commit.task.budgetScope);
  await f.chunked.advance(id);
  const interrupted = await f.status(id, 'commit');
  assert.equal(interrupted.task.status, 'failed', JSON.stringify(interrupted.task.error));
  assert.equal(interrupted.view.bulk?.phase, 'published_readback');
  assert.ok(f.tasks.getBudget(commit.task.id).activeMs >= 210001);
  assert.ok(f.tasks.getBudget(commit.task.id).progressActiveMs >= 210001);
  await f.chunked.advance(id);
  const completed = await f.status(id, 'commit');
  assert.equal(completed.task.status, 'succeeded', JSON.stringify(completed.task.error));
  assert.equal(completed.task.id, commit.task.id);
  assert.equal(f.counters().finalizeCalls, 2);
  assert.equal(f.counters().verifiedCheckpoint, true);
});

test('control, profile and connection drift block work; malformed formal receipt cannot associate', async t => {
  const f = setup(t), id = 'drift';
  await f.chunked.startAny(bulkInput(id), operator(id));
  await f.tasks.stopControl('synthetic stop');
  assert.throws(() => f.chunked.upload(id, 0, bytes, wfdSha256(bytes)), { code: 'BD_STOPPED' });
  f.tasks.resumeControl(f.tasks.getControl().generation, 'synthetic resume');
  await f.chunked.advance(id);
  f.chunked.upload(id, 0, bytes, wfdSha256(bytes));
  writeFileSync(f.profilePath, JSON.stringify({ ...profile, confirmation: { ...profile.confirmation, basis: 'edited by fixture' } }));
  await assert.rejects(f.chunked.advance(id), { code: 'R1_BULK_PROFILE_CHANGED' });
  writeFileSync(f.profilePath, JSON.stringify(profile));
  f.connection.entrySha256 = 'changed';
  await assert.rejects(f.chunked.advance(id), { code: 'R1_BULK_BINDING_CHANGED' });
  f.connection.entrySha256 = 'c';
  await f.chunked.advance(id);
  const stage = await f.status(id, 'stage');
  assert.equal(stage.task.status, 'succeeded', JSON.stringify(stage.task.error));
  f.problems.badReceipt = true;
  await f.chunked.commit(id, stage.view.bulk!.manifestDigest);
  const rejected = await f.status(id, 'commit');
  assert.equal(rejected.view.bulk?.association, null);
  assert.equal(rejected.task.status, 'needs_review');
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM r1_source_minute_associations').get()?.n, 0);
  assert.equal(f.counters().readbackAttempts, 0);
});

test('WFD preparation and SQLite consume the internal reserve when formal store is on a separate device', () => {
  const gib = 1024 ** 3, mib = 1024 ** 2;
  let internalFree = 5n * BigInt(gib) + 16n * BigInt(mib);
  const inspect = (path: string) => path.startsWith('/internal')
    ? { device: 1n, free: internalFree } : { device: 2n, free: 6n * BigInt(gib) };
  const destinations = [{ root: '/internal/wfd-runtime', bytes: gib }, { root: '/external/wfd-store', bytes: 512 * mib }];
  assert.throws(() => assertSourceMinuteDiskGrowth('/internal/state/core.sqlite', '/external/bulk', 768 * mib, destinations, inspect),
    { code: 'R1_BULK_DISK_BUDGET' });
  internalFree = 5n * BigInt(gib) + 64n * BigInt(mib);
  assert.doesNotThrow(() => assertSourceMinuteDiskGrowth('/internal/state/core.sqlite', '/external/bulk', 768 * mib, destinations, inspect));
});

test('finalized WFD status with outstanding cleanup completes the same ledger before fixed readback', async t => {
  const f = setup(t), id = 'cleanup';
  await f.chunked.startAny(bulkInput(id), operator(id));
  f.chunked.upload(id, 0, bytes, wfdSha256(bytes));
  await f.chunked.advance(id);
  const stage = await f.status(id, 'stage');
  f.problems.finalizeLoss = true;
  f.problems.cleanupRequired = true;
  await f.chunked.commit(id, stage.view.bulk!.manifestDigest);
  assert.equal((await f.status(id, 'commit')).task.status, 'needs_review');
  await f.chunked.advance(id);
  assert.equal((await f.status(id, 'commit')).view.state, 'completed');
  assert.equal(f.counters().finalizeCalls, 2);
  assert.equal(f.counters().readbackAttempts, 1);
});

test('a no-progress budget is not extended by an unactivated status alone', async t => {
  const f = setup(t), id = 'not-activated';
  await f.chunked.startAny(bulkInput(id), operator(id));
  f.chunked.upload(id, 0, bytes, wfdSha256(bytes));
  await f.chunked.advance(id);
  const stage = await f.status(id, 'stage');
  f.problems.finalizeLoss = true;
  f.problems.activationObserved = false;
  await f.chunked.commit(id, stage.view.bulk!.manifestDigest);
  const commit = await f.status(id, 'commit');
  f.database.connection.prepare('UPDATE task_budgets SET active_ms=210001, progress_active_ms=0 WHERE scope=?').run(commit.task.budgetScope);
  await assert.rejects(f.chunked.advance(id), { code: 'TASK_NO_PROGRESS' });
  assert.equal(f.tasks.getBudget(commit.task.id).progressActiveMs, 0);
  assert.equal(f.counters().finalizeCalls, 1);
});

test('only a newly settled external milestone refreshes TaskService progress, once per key', async t => {
  const database = new CoreDatabase(), runtimes = new TaskRuntimeRegistry();
  const tasks = new TaskService({ database, runtimes });
  t.after(async () => { await tasks.dispose(); database.close(); });
  let verifyEffect = false;
  runtimes.register({
    id: 'synthetic.budget',
    execute: async context => {
      await context.emit({ type: 'side_effect_started', effectId: 'external', description: 'fixture response dropped' });
      throw new Error('fixture response dropped');
    },
    recover: async ({ effects }) => ({ outcome: 'not_applied', evidence: 'fixture external confirmation',
      progressEvidenceKey: 'same-external-milestone',
      effects: verifyEffect ? effects.filter(effect => effect.status === 'started').map(effect => ({
        attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'succeeded' as const, evidence: 'same external milestone',
      })) : [] }),
  });
  const task = tasks.create({ title: 'budget evidence', requestId: 'budget-evidence', args: {}, ownerRole: 'service',
    runtimeId: 'synthetic.budget', action: 'synthetic.budget' });
  tasks.start(task.id);
  assert.equal((await tasks.wait(task.id)).status, 'needs_review');
  await assert.rejects(tasks.recover(task.id), { code: 'INVALID_RECOVERY' });
  assert.equal(tasks.getBudget(task.id).progressActiveMs, 0);
  verifyEffect = true;
  database.connection.prepare('UPDATE task_budgets SET active_ms=120001 WHERE scope=?').run(task.budgetScope);
  let resumed = await tasks.recover(task.id);
  assert.equal(resumed.status, 'interrupted');
  assert.equal(tasks.getBudget(task.id).progressActiveMs, 120001);
  tasks.resume(task.id, resumed.version);
  assert.equal((await tasks.wait(task.id)).status, 'needs_review');
  database.connection.prepare('UPDATE task_budgets SET active_ms=240002 WHERE scope=?').run(task.budgetScope);
  resumed = await tasks.recover(task.id);
  assert.equal(resumed.status, 'interrupted');
  assert.equal(tasks.getBudget(task.id).progressActiveMs, 120001);
  assert.throws(() => tasks.resume(task.id, resumed.version), { code: 'TASK_NO_PROGRESS' });
});

test('an active whole-file stage blocks receiving and launching other bulk IDs', async t => {
  const f = setup(t), first = 'serial-first', second = 'serial-second', third = 'serial-third';
  await f.chunked.startAny(bulkInput(first), operator(first));
  await f.chunked.startAny(bulkInput(second), operator(second));
  f.chunked.upload(first, 0, bytes, wfdSha256(bytes));
  f.chunked.upload(second, 0, bytes, wfdSha256(bytes));
  let entered!: () => void, unblock!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { unblock = resolve; });
  f.problems.waitOnPut = async () => { entered(); await release; };
  try {
    await f.chunked.advance(first);
    await reached;
    await assert.rejects(f.chunked.advance(second), { code: 'R1_BULK_TASK_BUSY' });
    assert.throws(() => f.chunked.upload(second, 0, bytes, wfdSha256(bytes)), { code: 'R1_BULK_TASK_BUSY' });
    await assert.rejects(f.chunked.startAny(bulkInput(third), operator(third)), { code: 'R1_BULK_TASK_BUSY' });
  } finally { unblock(); }
  assert.equal((await f.status(first, 'stage')).task.status, 'succeeded');
  assert.equal((await f.chunked.startAny(bulkInput(third), operator(third))).state, 'receiving');
});

test('only the trusted initial bulk commit budget survives a 150 second machine call', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const database = new CoreDatabase(), runtimes = new TaskRuntimeRegistry();
  const policy = Object.freeze({ runtimeId: R1_WORKSPACE_RUNTIME, action: R1_SOURCE_MINUTE_ACTIONS[1],
    maxNoProgressMs: R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS });
  const tasks = new TaskService({ database, runtimes, initialBudgetPolicy: policy });
  t.after(async () => { await tasks.dispose(); database.close(); });
  let machineCompleted!: () => void, machineStarted!: () => void, signal: AbortSignal | undefined;
  const machine = new Promise<void>(resolve => { machineCompleted = resolve; });
  const started = new Promise<void>(resolve => { machineStarted = resolve; });
  runtimes.register({ id: policy.runtimeId, execute: async context => {
    await context.emit({ type: 'side_effect_started', effectId: 'fixture-finalize', description: '等待隔离机器回执' });
    signal = context.signal; machineStarted();
    await machine;
    context.signal.throwIfAborted();
    await context.emit({ type: 'side_effect_result', effectId: 'fixture-finalize', outcome: 'succeeded', evidence: '收到隔离机器回执' });
    return { summary: '隔离提交完成' };
  } });
  const input = { title: 'isolated bulk commit', requestId: 'isolated-budget', runtimeId: policy.runtimeId,
    action: policy.action, ownerRole: 'service' as const, args: {} };
  const old = tasks.create(input);
  assert.equal(tasks.getBudget(old.id).maxNoProgressMs, 120_000);
  const expanded = { ...input, budget: { maxNoProgressMs: policy.maxNoProgressMs } };
  assert.throws(() => tasks.create({ ...expanded, requestId: 'public-exact-action' }), { code: 'INVALID_BUDGET' });
  assert.throws(() => database.transaction(() => tasks.createInTransaction(expanded, policy)), { code: 'REQUEST_CONFLICT' });
  assert.equal(tasks.getBudget(old.id).maxNoProgressMs, 120_000);
  assert.throws(() => database.transaction(() => tasks.createInTransaction({ ...expanded, requestId: 'wrong-action',
    action: R1_SOURCE_MINUTE_ACTIONS[0] }, policy)), { code: 'INVALID_BUDGET' });
  assert.throws(() => database.transaction(() => tasks.createInTransaction({ ...expanded, requestId: 'copied-token' },
    { ...policy })), { code: 'INVALID_BUDGET' });
  const accepted = database.transaction(() => tasks.createInTransaction({ ...expanded, requestId: 'initial-bulk-commit' }, policy));
  accepted.publish();
  const limits = tasks.getBudget(accepted.task.id);
  assert.equal(limits.maxNoProgressMs, 210_000);
  assert.equal(limits.maxActiveMs, 900_000);
  assert.equal(limits.maxAttempts, 32);
  assert.equal(limits.maxModelRequests, 32);
  tasks.start(accepted.task.id, accepted.task.version);
  await started;
  try {
    for (let i = 0; i < 30; i++) t.mock.timers.tick(5_000);
    assert.equal(tasks.get(accepted.task.id).status, 'running');
    assert.equal(signal?.aborted, false);
    assert.ok(tasks.getBudget(accepted.task.id).activeMs >= 150_000);
  } finally { machineCompleted(); }
  assert.equal((await tasks.wait(accepted.task.id)).status, 'succeeded');
});

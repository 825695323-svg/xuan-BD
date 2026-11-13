import { lstatSync, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity, R1RowSummary, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { SOURCE_MINUTE_BATCH_PROTOCOL, type SourceMinuteBatchHeader } from '../../contracts/source-minute-batch.js';
import { TABULAR_BATCH_PROTOCOL, TABULAR_MAX_FIELDS, type TabularBatchHeader } from '../../contracts/tabular-batch.js';
import type { JsonValue, TaskRecord, TaskResult } from '../../contracts/task-contracts.js';
import { TaskError, type TaskExecutionContext, type TaskInitialBudgetPolicy, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { ResourceBindings, ResourceReference } from '../../platform/resources/bindings.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { compileSourceMinuteBulk, freezeSourceMinuteBulkPlan, readSourceMinuteBulkChunk, SOURCE_MINUTE_BULK_LIMITS,
  type SourceMinuteBulkManifest, type SourceMinuteBulkPlan } from './data-processing/source-minute-bulk.js';
import { compileTabularBulk, freezeTabularBulkPlan, readTabularBulkChunk, TABULAR_BULK_LIMITS, TABULAR_BULK_VERSION,
  type TabularBulkManifest, type TabularBulkPlan } from './data-processing/tabular-bulk.js';
import type { TabularBulkProfileStore } from './tabular-bulk-profile.js';
import type { ManagedOriginalStore } from './managed-originals.js';
import type { MaterialService } from './materials/service.js';
import type { OperatorContext, ProcessingPlanService } from './processing-plan.js';
import type { R1ChunkedCsvStart, R1ChunkedCsvView } from './r1-chunked-csv.js';
import { declaredSourceSeries } from './r1-evidence.js';
import type { R1Runtime } from './r1-runtime.js';
import { assertKnownR1Source, parseR1Utc } from './r1-structured-handoff.js';
import { R1_WORKSPACE_RUNTIME, type R1WorkspaceService } from './r1-workspace.js';
import { profileFingerprint, sourceFieldProfileDigest, type SourceFieldProfileStore } from './source-field-profile.js';

export const R1_SOURCE_MINUTE_MODE = 'source_minute_bulk_v1' as const;
export const R1_TABULAR_BULK_MODE = 'tabular_bulk_v1' as const;
export type R1BulkMode = typeof R1_TABULAR_BULK_MODE | typeof R1_SOURCE_MINUTE_MODE;
export const isR1BulkMode = (value: unknown): value is R1BulkMode => value === R1_TABULAR_BULK_MODE || value === R1_SOURCE_MINUTE_MODE;
// Persisted task action IDs identify the common lifecycle, including already accepted v1 tasks.
export const R1_TABULAR_BULK_ACTIONS = ['data.r1.source-minute.stage', 'data.r1.source-minute.commit'] as const;
const [STAGE, COMMIT] = R1_TABULAR_BULK_ACTIONS;
// A single formal finalize call may legitimately wait for the machine's 180 s deadline.
export const R1_TABULAR_BULK_COMMIT_NO_PROGRESS_MS = 210_000;
const ROOT = 'bulk_csv';
const LEGACY_VERSION = 'bd.r1-source-minute-bulk/1';
const RESERVE = 4n * 1024n ** 3n;
const METADATA_RESERVE = 32 * 1024 ** 2;
// Transport and preparation share the native WFD runtime. Activation writes to the bound formal store.
const WFD_RUNTIME_RESERVE = 1024 ** 3;
const WFD_STORE_RESERVE = 512 * 1024 ** 2;
type WfdGrowth = 'prepare' | 'activate' | 'transport';
const diskFree = (path: string) => { const fs = statfsSync(path, { bigint: true }); return fs.bavail * fs.bsize; };
const fail = (code: string, message: string): never => { throw new TaskError('R1_BULK_' + code, message); };
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const hash = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const same = (a: unknown, b: unknown) => canonicalWfdJson(a) === canonicalWfdJson(b);
const asJson = (value: unknown): JsonValue => JSON.parse(canonicalWfdJson(value));
const taskAction = (value: string) => value === STAGE || value === COMMIT;
type Action = typeof R1_TABULAR_BULK_ACTIONS[number];
type BulkPhase = 'receiving' | 'custody' | 'processing' | 'staging' | 'ready_to_commit'
  | 'committing' | 'published_readback' | 'completed' | 'conflicts_pending' | 'blocked';
export interface R1TabularBulkStatus {
  phase: BulkPhase; stageTaskId: string | null; commitTaskId: string | null; manifestDigest: string | null;
  batchId: string; stagedChunks: number; readbackVerified: boolean;
  association: WfdRecord | null;
}
export type R1TabularBulkView = R1ChunkedCsvView & { mode: R1BulkMode; bulk: R1TabularBulkStatus };
export type R1SourceMinuteBulkView = R1TabularBulkView & { mode: typeof R1_SOURCE_MINUTE_MODE };
export type R1SourceMinuteBulkClient = Pick<WfdProductMachineClient,
  'batchStatus' | 'batchFinalize' | 'sourceMinuteBatchBegin' | 'sourceMinuteBatchPut' | 'sourceMinuteReadPage'>;
type R1TabularBulkClient = Pick<WfdProductMachineClient, 'tabularBatchBegin' | 'tabularBatchPut' | 'tabularReadPage'>;
export interface R1SourceMinuteBulkTransport {
  buildHeader(manifest: SourceMinuteBulkManifest, input: { requestId: string; namespace: string }): SourceMinuteBatchHeader;
  verifyReceipt(header: SourceMinuteBatchHeader, manifest: SourceMinuteBulkManifest, result: unknown): WfdRecord;
  verifyReadback(input: { header: SourceMinuteBatchHeader; manifest: SourceMinuteBulkManifest; receipt: WfdRecord;
    client: R1SourceMinuteBulkClient; checkpoint: WfdRecord | null; onCheckpoint(value: WfdRecord): void | Promise<void>;
    signal: AbortSignal; assertCurrent(): void }): Promise<WfdRecord>;
}
export interface R1TabularBulkTransport {
  buildHeader(manifest: TabularBulkManifest, input: { requestId: string; namespace: string }): TabularBatchHeader;
  verifyReceipt(header: TabularBatchHeader, manifest: TabularBulkManifest, result: unknown): WfdRecord;
  verifyReadback(input: { header: TabularBatchHeader; manifest: TabularBulkManifest; receipt: WfdRecord;
    client: R1TabularBulkClient; checkpoint: WfdRecord | null; onCheckpoint(value: WfdRecord): void | Promise<void>;
    signal: AbortSignal; assertCurrent(): void }): Promise<WfdRecord>;
}
type BulkInput = R1ChunkedCsvStart & (
  { mode: typeof R1_SOURCE_MINUTE_MODE; partitionDate?: string; sourceValueColumns: string[] } |
  { mode: typeof R1_TABULAR_BULK_MODE; profileId?: string; partitionValue?: string });
type BulkPlan = SourceMinuteBulkPlan | TabularBulkPlan;
type BulkManifest = SourceMinuteBulkManifest | TabularBulkManifest;
type BulkHeader = SourceMinuteBatchHeader | TabularBatchHeader;
interface BulkRecord {
  input: BulkInput; operatorId: string; connection: R1ConnectionIdentity; generation: number;
  plan: BulkPlan; binding: ResourceReference & { identityDigest: string }; stageRef: (ResourceReference & { device: string; inode: string }) | null;
  receivedBytes: number; phase: BulkPhase; custodyTaskId: string | null; stageTaskId: string | null; commitTaskId: string | null;
  manifest: BulkManifest | null; stagedChunks: number; checkpoint: WfdRecord | null;
  receipt: WfdRecord | null; proof: WfdRecord | null; rowSummary: R1RowSummary | null;
  confirmedDigest: string | null; error: { code: string; message: string } | null; createdAt: number; updatedAt: number;
}
interface Options {
  database: CoreDatabase; tasks(): TaskService; materials: MaterialService; store: ManagedOriginalStore;
  resources: ResourceBindings; profileStore: SourceFieldProfileStore; runtime: R1Runtime;
  processing: Pick<ProcessingPlanService, 'moduleCapability'>; workspace: Pick<R1WorkspaceService, 'snapshotStatus'>;
  transport: R1SourceMinuteBulkTransport; tabular?: { profiles: TabularBulkProfileStore; transport: R1TabularBulkTransport };
  commitBudgetPolicy: TaskInitialBudgetPolicy;
}
const requestKey = (id: string, kind: string) => 'r1-bulk-' + kind + ':' + hash(id).slice(0, 48);

export function assertTabularBulkDiskGrowth(databasePath: string, externalRoot: string, externalBytes: number,
  destinations: readonly { root: string; bytes: number }[] = [],
  inspect = inspectStorageVolume): void {
  const checks = new Map<bigint, { free: bigint; bytes: number }>();
  const add = (path: string, bytes: number) => {
    const { device, free } = inspect(path);
    const current = checks.get(device);
    checks.set(device, { free: current && current.free < free ? current.free : free, bytes: bytes + (current?.bytes ?? 0) });
  };
  if (databasePath !== ':memory:') add(dirname(databasePath), METADATA_RESERVE);
  add(externalRoot, externalBytes);
  for (const target of destinations) add(target.root, target.bytes);
  for (const check of checks.values()) if (check.free < RESERVE + BigInt(check.bytes))
    fail('DISK_BUDGET', '实际存储卷无法保留 4 GiB 余量及本次增长预算，原编号和原件继续保留。');
}

function inspectStorageVolume(path: string): { device: bigint; free: bigint } {
  if (!isAbsolute(path) || path !== resolve(path)) return fail('DISK_BUDGET', '存储预算需要规范绝对目录。');
  let existing = path;
  for (;;) {
    const info = lstatSync(existing, { bigint: true, throwIfNoEntry: false });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(existing) !== existing)
        return fail('DISK_BUDGET', '无法核对增长位置的实际目录。');
      return { device: info.dev, free: diskFree(existing) };
    }
    const parent = dirname(existing);
    if (parent === existing) return fail('DISK_BUDGET', '无法核对增长位置所在卷。');
    existing = parent;
  }
}

export class R1TabularBulkService {
  private readonly actions = new Set<string>();
  private readonly starts = new Map<string, { digest: string; result: Promise<R1TabularBulkView> }>();
  constructor(private readonly options: Options) {
    options.database.migrate('r1-source-minute-bulk', 1, `CREATE TABLE r1_source_minute_bulk (
      intake_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,record_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE r1_source_minute_associations (intake_id TEXT PRIMARY KEY REFERENCES r1_source_minute_bulk(intake_id),
        proof_json TEXT NOT NULL,proof_digest TEXT NOT NULL,associated_at INTEGER NOT NULL);`);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }
  private get client() { return this.options.runtime.connection.client; }
  private get tabular() { return this.options.tabular ?? fail('UNAVAILABLE', '通用表格契约档案与传输尚未装配。'); }

  isStarting(id: string): boolean { return this.starts.has(id); }
  has(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM r1_source_minute_bulk WHERE intake_id=?').get(id); }
  private record(id: string): BulkRecord {
    if (!key(id)) return fail('ID', '需要稳定接收编号。');
    const row = this.db.prepare('SELECT record_json FROM r1_source_minute_bulk WHERE intake_id=?').get(id);
    if (!row) return fail('NOT_FOUND', '没有批量接收记录。');
    return JSON.parse(String(row.record_json)) as BulkRecord;
  }
  private save(record: BulkRecord) {
    record.updatedAt = Date.now();
    this.db.prepare('UPDATE r1_source_minute_bulk SET record_json=?,updated_at=? WHERE intake_id=?')
      .run(canonicalWfdJson(record), record.updatedAt, record.input.intakeId);
  }
  private assertControl() {
    const control = this.tasks.getControl();
    if (control.stopped) throw new TaskError('BD_STOPPED', '服务已停止，请恢复后明确继续原接收编号。');
    return control.generation;
  }
  private binding(): BulkRecord['binding'] {
    const binding = this.options.resources.document.resources[ROOT];
    if (!binding?.owned || binding.kind !== 'directory' || !binding.identity)
      return fail('UNAVAILABLE', '批量接收需要明确绑定的 bulk_csv 受管目录。');
    const reference = { root: ROOT, identity: binding.identity, relative: 'bd-source-minute-binding-check',
      identityDigest: hash({ binding, absolutePath: this.options.resources.path(ROOT) }) };
    this.options.resources.resolve(reference);
    return reference;
  }
  private assertBinding(record: BulkRecord) {
    if (!same(this.binding(), record.binding) || !same(this.options.runtime.currentIdentity(), record.connection))
      fail('BINDING_CHANGED', '原连接或受管存储绑定已变化。');
    assertKnownR1Source(record.input.source);
  }
  private assertProfile(record: BulkRecord) {
    const identity = { sourceId: record.input.source.source_id, series: record.plan.profile.profile.series };
    const digest = record.input.mode === R1_TABULAR_BULK_MODE
      ? this.tabular.profiles.match({ ...identity, profileId: record.input.profileId })?.digest
      : this.legacyProfileDigest(identity);
    if (digest !== record.plan.profile.digest)
      fail('PROFILE_CHANGED', '已采用来源档案与原接收档案不同，请核对原冻结档案后继续。');
  }
  private legacyProfileDigest(identity: { sourceId: string; series: string }) {
    const profile = this.options.profileStore.match(identity);
    return profile && sourceFieldProfileDigest(profile);
  }
  private assertCurrent(record: BulkRecord, context?: TaskExecutionContext) {
    context?.signal.throwIfAborted();
    if (this.assertControl() !== record.generation
      || context && (!this.tasks.isRunActive(context.runId, context.generation)
        || this.tasks.get(context.task.id).currentAttemptId !== context.attemptId))
      fail('TASK_NOT_ACTIVE', '原任务或停止代次已失效，请明确继续。');
    this.assertBinding(record);
  }
  private disk(additional = 0, wfdGrowth?: WfdGrowth) {
    const destinations = [];
    const { runtime, store } = this.options.runtime.connection;
    if (wfdGrowth) destinations.push({ root: runtime, bytes: wfdGrowth === 'transport' ? TABULAR_BULK_LIMITS.chunkBytes : WFD_RUNTIME_RESERVE });
    if (wfdGrowth === 'prepare' || wfdGrowth === 'activate') destinations.push({ root: store, bytes: WFD_STORE_RESERVE });
    assertTabularBulkDiskGrowth(this.options.database.path, this.options.resources.path(ROOT), additional, destinations);
  }

  start(value: unknown, operator: OperatorContext): Promise<R1TabularBulkView> {
    const input = readInput(value);
    if (!key(operator?.operatorId) || operator.requestId !== input.intakeId || operator.method !== 'POST'
      || operator.source === 'conversation') return fail('OPERATOR', '需要真实的本次批量操作入口。');
    const digest = hash({ input, operatorId: operator.operatorId });
    const active = this.starts.get(input.intakeId);
    if (active) {
      if (active.digest !== digest) return fail('CONFLICT', '同一接收编号已有不同的原批量清单。');
      return active.result;
    }
    const result = this.create(input, operator.operatorId, digest).finally(() => this.starts.delete(input.intakeId));
    this.starts.set(input.intakeId, { digest, result });
    return result;
  }
  private assertSingleActive(id: string) {
    const active = this.db.prepare(`SELECT 1 FROM tasks WHERE runtime_id=? AND action IN (?,?)
      AND status IN ('running','waiting_approval','pausing','cancelling')
      AND json_extract(args,'$.intakeId') <> ? LIMIT 1`).get(R1_WORKSPACE_RUNTIME, STAGE, COMMIT, id);
    if (active) fail('TASK_BUSY', '请先完成当前正在执行的整件批量任务，再开始另一件。');
  }
  private async create(input: BulkInput, operatorId: string, digest: string) {
    const previous = this.db.prepare('SELECT input_digest FROM r1_source_minute_bulk WHERE intake_id=?').get(input.intakeId);
    if (previous) {
      if (previous.input_digest !== digest) fail('CONFLICT', '同一接收编号已有不同的原批量清单。');
      const record = this.record(input.intakeId);
      if (record.phase === 'receiving') {
        this.assertCurrent(record);
        const original = this.options.store.start({ intakeId: input.intakeId, filename: input.name, byteLength: input.byteLength, sha256: input.sha256 });
        if (original.materialId !== record.plan.materialId) fail('CUSTODY', '原材料身份与接收计划不同。');
      }
      return this.get(input.intakeId);
    }
    this.assertLegacyIdFree(input.intakeId);
    this.assertSingleActive(input.intakeId);
    const generation = this.assertControl();
    const binding = this.binding(), connection = this.options.runtime.currentIdentity();
    const series = declaredSourceSeries(input.source);
    if (!series) return fail('PROFILE', '来源文件 URI 必须能定位到已采用的明确系列。');
    const parent = await this.options.workspace.snapshotStatus();
    if (!parent.connection.roles.includes('submit') || !parent.connection.roles.includes('publish'))
      fail('WFD_PERMISSION', '已采用连接缺少 WFD 提交或发布权限。');
    if (this.assertControl() !== generation || !same(this.binding(), binding) || !same(this.options.runtime.currentIdentity(), connection))
      fail('BINDING_CHANGED', '核对父快照期间控制状态、连接或资源已改变。');
    this.assertLegacyIdFree(input.intakeId);
    this.assertSingleActive(input.intakeId);
    const limits = input.mode === R1_TABULAR_BULK_MODE ? TABULAR_BULK_LIMITS : SOURCE_MINUTE_BULK_LIMITS;
    this.disk(input.byteLength + limits.stagedBytes, 'prepare');
    const targetIdentity = { connection, requestId: input.intakeId, operatorId, duplicatePolicy: 'append_complete_partition' };
    const base = { source: input.source, namespace: connection.namespace, datasetId: input.datasetId,
      parentSnapshotId: parent.snapshotId, sourceSha256: input.sha256, sourceBytes: input.byteLength };
    const freeze = this.planFactory(input, series, base, targetIdentity);
    // Validate the frozen source and contract before creating a durable material receipt.
    freeze('validation');
    const original = this.options.store.start({ intakeId: input.intakeId, filename: input.name, byteLength: input.byteLength, sha256: input.sha256 });
    const plan = freeze(original.materialId);
    const now = Date.now();
    const record: BulkRecord = { input, operatorId, connection, binding, generation, plan, stageRef: null,
      receivedBytes: original.committedOffset, phase: 'receiving', custodyTaskId: null, stageTaskId: null, commitTaskId: null, manifest: null,
      stagedChunks: 0, checkpoint: null, receipt: null, proof: null, rowSummary: null, confirmedDigest: null, error: null, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO r1_source_minute_bulk VALUES(?,?,?,?)').run(input.intakeId, digest, canonicalWfdJson(record), now);
    return this.get(input.intakeId);
  }
  private planFactory(input: BulkInput, series: string,
    base: Pick<TabularBulkPlan, 'source' | 'namespace' | 'datasetId' | 'parentSnapshotId' | 'sourceSha256' | 'sourceBytes'>,
    targetIdentity: WfdRecord): (materialId: string) => BulkPlan {
    const identity = { sourceId: input.source.source_id, series };
    if (input.mode === R1_TABULAR_BULK_MODE) {
      const profile = this.tabular.profiles.match({ ...identity, profileId: input.profileId });
      if (!profile || input.sourceValueColumns && (profile.profile.columns.length !== input.sourceValueColumns.length
        || profile.profile.columns.some(column => !input.sourceValueColumns!.includes(column.originalHeader))))
        return fail('PROFILE', '来源与系列须引用已审核的表格档案，显式选列须完整对应档案。');
      return materialId => freezeTabularBulkPlan({ ...base, profile, materialId, targetIdentity,
        ...(input.partitionValue !== undefined ? { partitionValue: input.partitionValue } : {}) });
    }
    const profile = this.options.profileStore.match(identity);
    if (!profile || profile.series !== series || profile.fields.length !== input.sourceValueColumns.length
      || profile.fields.some(field => !input.sourceValueColumns.includes(field.originalHeader)))
      return fail('PROFILE', '旧批量入口须引用匹配的已采用来源档案和完整原列。');
    const frozen = { profile, digest: sourceFieldProfileDigest(profile), fingerprint: profileFingerprint(profile) };
    return materialId => freezeSourceMinuteBulkPlan({ ...base, profile: frozen, materialId,
      targetIdentity: { ...targetIdentity, sourceValueColumns: input.sourceValueColumns },
      ...(input.partitionDate ? { partitionDate: input.partitionDate } : {}) });
  }
  private assertLegacyIdFree(intakeId: string) {
    const legacy = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='r1_csv_intakes'").get();
    if (legacy && this.db.prepare('SELECT 1 FROM r1_csv_intakes WHERE intake_id=?').get(intakeId))
      fail('CONFLICT', '该接收编号已用于旧分块模式。');
  }
  list(): R1TabularBulkView[] {
    return this.db.prepare('SELECT intake_id FROM r1_source_minute_bulk ORDER BY updated_at DESC LIMIT 20').all().map(row => this.get(String(row.intake_id)));
  }
  get(id: string): R1TabularBulkView {
    const record = this.record(id);
    const taskId = record.commitTaskId ?? record.stageTaskId;
    const task = taskId ? this.tasks.get(taskId) : null;
    let error = record.error ?? (task?.error ? { code: task.error.code, message: task.error.message } : null);
    const phase = record.phase;
    const state = phase === 'completed' || phase === 'conflicts_pending' ? phase
      : task?.status === 'needs_review' ? 'recovering'
      : task && ['paused', 'interrupted', 'cancelled'].includes(task.status) ? 'stopped'
      : phase === 'blocked' || task?.status === 'failed' ? 'blocked'
      : phase === 'receiving' || phase === 'custody' ? phase : phase === 'processing' ? 'parsing' : 'publishing';
    let receivedBytes = record.receivedBytes;
    try { receivedBytes = this.options.store.status(id).committedOffset; } catch (failure) {
      error ??= { code: 'R1_BULK_CUSTODY_UNAVAILABLE', message: failure instanceof Error ? failure.message : String(failure) };
    }
    const associated = this.association(record);
    const rows = record.manifest?.rowCount ?? 0, chunks = record.manifest?.chunks.length ?? 0;
    return { mode: record.input.mode, intakeId: id, name: record.input.name, source: record.input.source,
      sha256: record.input.sha256, byteLength: record.input.byteLength, datasetId: record.input.datasetId, state,
      receivedBytes, chunkBytes: 2 * 1024 ** 2, custodyTaskId: record.custodyTaskId,
      materialId: record.custodyTaskId && this.options.materials.getByTask(record.custodyTaskId) ? record.plan.materialId : null,
      parsed: !!record.manifest, totalRows: rows, totalPages: chunks, publishedPages: 0, publishedRows: associated ? record.rowSummary?.inserted ?? 0 : 0,
      rowSummary: record.rowSummary, processedPages: record.stagedChunks, processedRows: associated ? rows : 0,
      conflictPages: [], activePage: null, error, createdAt: record.createdAt, updatedAt: record.updatedAt,
      bulk: { phase, stageTaskId: record.stageTaskId, commitTaskId: record.commitTaskId, manifestDigest: record.manifest?.manifestDigest ?? null,
        batchId: id, stagedChunks: record.stagedChunks, readbackVerified: !!associated, association: associated } };
  }
  upload(id: string, offset: number, bytes: Buffer, suppliedDigest?: string): R1TabularBulkView {
    const record = this.record(id);
    this.assertCurrent(record); this.assertSingleActive(id); this.disk(bytes.byteLength);
    if (record.phase !== 'receiving') {
      const original = this.options.store.status(id);
      if (original.state !== 'sealed') fail('CHUNK_STATE', '原件已离开接收阶段。');
    }
    if (typeof suppliedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(suppliedDigest)) return fail('CHUNK_DIGEST', '需要本片原字节的 SHA-256。');
    const original = this.options.store.upload(id, { offset, bytes, sha256: suppliedDigest });
    if (record.receivedBytes !== original.committedOffset) { record.receivedBytes = original.committedOffset; this.save(record); }
    return this.get(id);
  }
  async advance(id: string): Promise<R1TabularBulkView> {
    return this.act(id, () => this.advanceOriginal(id));
  }
  private async advanceOriginal(id: string): Promise<R1TabularBulkView> {
    const record = this.record(id);
    if (record.phase === 'conflicts_pending' || this.completedTask(record)) return this.get(id);
    if (record.phase === 'ready_to_commit' && !record.confirmedDigest && record.stageTaskId
      && this.tasks.get(record.stageTaskId).status === 'succeeded') return this.get(id);
    this.assertBinding(record);
    if (!record.confirmedDigest) this.assertProfile(record);
    const generation = this.assertControl();
    if (this.options.store.status(id).committedOffset !== record.input.byteLength) {
      if (record.phase === 'receiving' && record.generation !== generation) {
        record.generation = generation; this.save(record); return this.get(id);
      }
      fail('INCOMPLETE', '原件尚有接收字节缺口。');
    }
    this.disk();
    record.generation = generation; record.error = null;
    this.save(record);
    await this.launch(record, record.confirmedDigest ? COMMIT : STAGE);
    return this.get(id);
  }
  async commit(id: string, manifestDigest: unknown): Promise<R1TabularBulkView> {
    return this.act(id, () => this.confirmOriginal(id, manifestDigest));
  }
  private async confirmOriginal(id: string, manifestDigest: unknown): Promise<R1TabularBulkView> {
    const record = this.record(id);
    if (!sha(manifestDigest) || record.manifest?.manifestDigest !== manifestDigest)
      fail('CONFIRMATION', '确认必须匹配已展示的整件清单摘要。');
    if (record.phase === 'conflicts_pending' || this.completedTask(record)) return this.get(id);
    this.assertBinding(record);
    record.generation = this.assertControl();
    if (record.confirmedDigest === null) {
      this.assertProfile(record);
      if (record.phase !== 'ready_to_commit' || record.stagedChunks !== record.manifest!.chunks.length
        || !record.stageTaskId || this.tasks.get(record.stageTaskId).status !== 'succeeded')
        fail('NOT_READY', '所有分片经同号暂存并核对后才能正式提交。');
      record.confirmedDigest = manifestDigest as string;
    }
    this.disk();
    record.error = null;
    this.save(record);
    await this.launch(record, COMMIT);
    return this.get(id);
  }
  private completedTask(record: BulkRecord): boolean {
    if (record.phase !== 'completed') return false;
    if (!record.commitTaskId || record.confirmedDigest !== record.manifest?.manifestDigest)
      return fail('TASK_BINDING', '已关联记录缺少原正式提交任务。');
    return this.tasks.get(record.commitTaskId).status === 'succeeded';
  }
  private async act(id: string, execute: () => Promise<R1TabularBulkView>) {
    if (this.actions.has(id)) return fail('TASK_BUSY', '该批量接收正在处理另一个续办操作。');
    this.actions.add(id);
    try { return await execute(); } finally { this.actions.delete(id); }
  }
  private args(record: BulkRecord, action: Action) {
    return { intakeId: record.input.intakeId, planDigest: record.plan.digest,
      confirmation: action === COMMIT ? record.confirmedDigest : null };
  }
  private versions(record: BulkRecord) {
    return { bulk: this.version(record), connection: hash(record.connection), profile: record.plan.profile.digest,
      plan: record.plan.digest, protocol: this.protocol(record) };
  }
  private version(record: BulkRecord) {
    return record.input.mode === R1_TABULAR_BULK_MODE ? TABULAR_BULK_VERSION : LEGACY_VERSION;
  }
  private protocol(record: BulkRecord) {
    return record.input.mode === R1_TABULAR_BULK_MODE ? TABULAR_BATCH_PROTOCOL : SOURCE_MINUTE_BATCH_PROTOCOL;
  }
  private async launch(record: BulkRecord, action: Action) {
    this.assertSingleActive(record.input.intakeId);
    const field = action === COMMIT ? 'commitTaskId' : 'stageTaskId';
    const current = record[field];
    if (!current) {
      let accepted!: ReturnType<TaskService['createInTransaction']>;
      this.options.database.transaction(() => {
        this.assertCurrent(record);
        accepted = this.tasks.createInTransaction({ title: action === STAGE ? 'R1 批量表格保管、加工及暂存' : 'R1 批量表格正式提交及固定读回',
          ownerRole: 'service', runtimeId: R1_WORKSPACE_RUNTIME, action, args: this.args(record, action),
          requestId: requestKey(record.input.intakeId, action === STAGE ? 'stage' : 'commit'), versions: this.versions(record),
          ...(action === COMMIT ? { budget: { maxNoProgressMs: R1_TABULAR_BULK_COMMIT_NO_PROGRESS_MS } } : {}),
        }, action === COMMIT ? this.options.commitBudgetPolicy : undefined);
        record[field] = accepted.task.id; this.save(record);
      });
      accepted.publish(); this.tasks.start(accepted.task.id, accepted.task.version); return;
    }
    let task = this.tasks.get(current);
    if (task.status === 'needs_review' || task.requiresReview) {
      task = await this.tasks.recover(current);
      if (task.requiresReview || task.status === 'needs_review' || this.record(record.input.intakeId).error?.code === 'R1_BULK_WFD_REJECTED') return;
      this.assertCurrent(this.record(record.input.intakeId));
      this.assertSingleActive(record.input.intakeId);
    }
    if (task.status === 'ready') this.tasks.start(current, task.version);
    else if (task.status === 'paused' || task.status === 'interrupted') this.tasks.resume(current, task.version);
    else if (task.status === 'failed' || task.status === 'cancelled') this.tasks.retry(current, task.version);
  }

  private boundTask(task: TaskRecord) {
    if (!taskAction(task.action) || task.runtimeId !== R1_WORKSPACE_RUNTIME || task.ownerRole !== 'service'
      || !isWfdRecord(task.args) || !key(task.args.intakeId)) return fail('TASK_BINDING', '任务不属于已登记的批量接收。');
    const record = this.record(task.args.intakeId);
    if (task.id !== (task.action === STAGE ? record.stageTaskId : record.commitTaskId)
      || !same(task.args, this.args(record, task.action as Action)) || !same(task.versions, this.versions(record)))
      return fail('TASK_BINDING', '批量任务版本或参数与原接收冻结记录不符。');
    return record;
  }

  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const record = this.boundTask(context.task);
    this.assertCurrent(record, context);
    this.assertSingleActive(record.input.intakeId);
    if (context.task.action === STAGE) {
      this.assertProfile(record);
      return this.stage(record, context);
    }
    return this.publish(record, context);
  }

  private async stage(record: BulkRecord, context: TaskExecutionContext): Promise<TaskResult> {
    const id = record.input.intakeId;
    const current = () => this.assertCurrent(record, context);
    if (record.phase === 'ready_to_commit') return this.stageResult(record);
    if (record.confirmedDigest) return fail('TASK_BINDING', '正式提交已绑定原清单，不能重新暂存。');
    const moduleKinds = ['parse', 'clean', 'structure', 'annotate', 'check'] as const;
    for (const kind of moduleKinds) {
      const capability = this.options.processing.moduleCapability(kind);
      if (capability.status !== 'ready') fail('PROCESSING_UNAVAILABLE', capability.reason ?? '批量加工的共用步骤未装配。');
    }
    current(); this.disk();
    record.phase = 'custody'; this.save(record);
    const original = await this.options.store.seal(id, current);
    current();
    if (original.materialId !== record.plan.materialId || original.sha256 !== record.input.sha256)
      fail('CUSTODY', '封存原件与冻结材料身份或字节摘要不一致。');
    current(); this.disk();
    let custody = this.options.store.adoptMaterial(id, { requestId: requestKey(id, 'custody'),
      parentTaskId: context.task.id, category: 'data', mediaType: 'text/csv' });
    if (record.custodyTaskId && record.custodyTaskId !== custody.id) fail('CUSTODY', '保管任务的原身份已变化。');
    record.custodyTaskId = custody.id; this.save(record);
    if (['paused', 'interrupted', 'cancelled', 'failed'].includes(custody.status))
      custody = this.options.materials.resume(custody.id, custody.version);
    custody = await this.tasks.wait(custody.id);
    current();
    const material = this.options.materials.getByTask(custody.id);
    if (custody.status !== 'succeeded' || material?.envelope.materialId !== record.plan.materialId
      || material.envelope.originalStorage !== 'managed-file/v1')
      return fail('CUSTODY', custody.error?.message ?? '受管原件尚未取得实际材料回执。');
    const stagingDir = await this.compile(record, context, current);
    const manifest = record.manifest!;
    this.assertProfile(record);
    const header = this.header(record);
    current(); this.disk();
    record.phase = 'staging'; this.save(record);
    // Read the original external identity before any same-ID continuation, including retries.
    const prior = (await this.client.batchStatus(id, context.signal)).result;
    current();
    if (!this.notFound(id, prior)) {
      const status = this.status(record, prior);
      if (!['collecting', 'ready'].includes(status.phase))
        fail('EXTERNAL_PHASE', '原 WFD 编号已越过暂存边界，未继续加工或发出正式提交。');
    }
    const effectId = 'r1-bulk-stage:' + id;
    await context.emit({ type: 'side_effect_started', effectId, description: '按原请求号暂存完整分片清单',
      operation: { requestId: id, manifestDigest: manifest.manifestDigest } });
    current(); this.assertProfile(record); this.disk(0, 'prepare');
    const begun = header.protocol_version === TABULAR_BATCH_PROTOCOL
      ? await this.client.tabularBatchBegin(id, header, manifest.chunks, context.signal)
      : await this.client.sourceMinuteBatchBegin(id, header, manifest.chunks, context.signal);
    let status = this.status(record, begun.result);
    current();
    if (!['collecting', 'ready'].includes(status.phase)) fail('EXTERNAL_PHASE', 'WFD 原暂存编号不处于可暂存状态。');
    const accepted = new Set(status.receivedOrdinals);
    await context.emit({ type: 'progress', message: '整件加工完成，WFD 暂存编号已核对。',
      progress: 0.55 + 0.44 * status.received / manifest.chunks.length });
    if (status.phase !== 'ready') for (const chunk of manifest.chunks) {
      if (accepted.has(chunk.ordinal)) continue;
      current(); this.disk(0, 'transport');
      const cells = await this.readChunk(stagingDir, manifest, chunk);
      current();
      const put = header.protocol_version === TABULAR_BATCH_PROTOCOL
        ? await this.client.tabularBatchPut(id, manifest.target.outputKey, chunk, cells, context.signal)
        : await this.client.sourceMinuteBatchPut(id, manifest.target.outputKey, chunk, cells, context.signal);
      status = this.status(record, put.result);
      current();
      if (!['collecting', 'ready'].includes(status.phase)) fail('EXTERNAL_PHASE', 'WFD 暂存分片时返回异常阶段。');
      record.stagedChunks = status.received;
      if (chunk.ordinal % 16 === 0) {
        this.save(record);
        await context.emit({ type: 'progress', message: '按原编号暂存已验证的来源原报分片。',
          progress: 0.55 + 0.44 * status.received / manifest.chunks.length, data: { stagedChunks: status.received } });
      }
    }
    if (status.phase !== 'ready' || status.received !== manifest.chunks.length)
      fail('STAGING_INCOMPLETE', 'WFD 尚未回执整件分片已就绪。');
    current();
    record.stagedChunks = status.received; record.phase = 'ready_to_commit'; this.save(record);
    await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '同号 WFD 暂存已覆盖整件冻结分片清单。' });
    return this.stageResult(record);
  }

  private async compile(record: BulkRecord, context: TaskExecutionContext, current: () => void) {
    if (record.stageRef && record.manifest) {
      const stagingDir = this.stagePath(record.stageRef);
      try {
        for (const chunk of record.manifest.chunks) {
          current();
          await this.readChunk(stagingDir, record.manifest, chunk);
        }
        return stagingDir;
      } catch (error) {
        current();
        if (!(error instanceof TaskError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (record.stageRef) await this.removeStage(record, current);
    const generic = record.plan.version === TABULAR_BULK_VERSION;
    const limits = generic ? TABULAR_BULK_LIMITS : SOURCE_MINUTE_BULK_LIMITS;
    current(); this.disk(limits.stagedBytes, 'prepare');
    const ref = { ...record.binding, relative: (generic ? 'bd-tabular-stage-' : 'bd-source-minute-stage-') + randomUUID() };
    const stagingDir = this.options.resources.resolve(ref);
    mkdirSync(stagingDir, { mode: 0o700 });
    const dir = lstatSync(stagingDir, { bigint: true });
    record.stageRef = { ...ref, device: String(dir.dev), inode: String(dir.ino) };
    record.phase = 'processing'; this.save(record);
    const options: Omit<Parameters<typeof compileSourceMinuteBulk>[0], 'plan'> = { original: this.options.store.readStream(record.input.intakeId),
      stagingDir, signal: context.signal, assertGrowth: bytes => {
        current(); this.stagePath(record.stageRef!); this.disk(bytes);
      }, onProgress: async progress => {
        current(); this.disk();
        const fraction = progress.stage === 'parse' ? 0.49 * progress.sourceBytes / record.plan.sourceBytes
          : progress.stage === 'sort' ? 0.5 : 0.54;
        await context.emit({ type: 'progress', message: '核对整件来源原报加工。', progress: fraction, data: asJson(progress) });
      } };
    const manifest = record.plan.version === TABULAR_BULK_VERSION
      ? await compileTabularBulk({ ...options, plan: record.plan })
      : await compileSourceMinuteBulk({ ...options, plan: record.plan });
    current();
    if (record.manifest && !same(manifest, record.manifest)) fail('MANIFEST_CHANGED', '重建清单与原确认身份不同。');
    record.manifest = manifest; this.save(record);
    return stagingDir;
  }
  private readChunk(stagingDir: string, manifest: BulkManifest, chunk: BulkManifest['chunks'][number]) {
    return manifest.version === TABULAR_BULK_VERSION
      ? readTabularBulkChunk(stagingDir, chunk, manifest.fieldCodes.length)
      : readSourceMinuteBulkChunk(stagingDir, chunk);
  }
  private header(record: BulkRecord): BulkHeader {
    const manifest = record.manifest ?? fail('MANIFEST', '整件加工清单未完成。');
    const identity = { requestId: record.input.intakeId, namespace: record.connection.namespace };
    if (record.input.mode === R1_TABULAR_BULK_MODE && manifest.version === TABULAR_BULK_VERSION)
      return this.tabular.transport.buildHeader(manifest, identity);
    if (record.input.mode === R1_SOURCE_MINUTE_MODE && manifest.version !== TABULAR_BULK_VERSION)
      return this.options.transport.buildHeader(manifest, identity);
    return fail('MANIFEST', '接收模式与冻结清单协议不符。');
  }
  private notFound(id: string, result: WfdRecord) {
    return result.phase === 'not_found' && result.status === 'not_found' && result.batch_id === id;
  }
  private status(record: BulkRecord, result: WfdRecord) {
    const manifest = record.manifest ?? fail('MANIFEST', '尚无可核对的分片清单。');
    if (result.protocol_version !== this.protocol(record) || result.batch_id !== record.input.intakeId
      || result.expected_chunks !== manifest.chunks.length || !Number.isInteger(result.received_chunks)
      || Number(result.received_chunks) < 0 || Number(result.received_chunks) > manifest.chunks.length || typeof result.phase !== 'string'
      || !Array.isArray(result.chunks) || result.chunks.length > 50 || result.chunk_offset !== 0
      || result.next_chunk_offset !== (manifest.chunks.length > 50 ? 50 : null)
      || result.phase === 'finalized' && typeof result.staging_cleanup_required !== 'boolean')
      return fail('STATUS', 'WFD 暂存回执身份、分片计数或目录无效。');
    const receivedOrdinals: number[] = [];
    for (const [index, value] of result.chunks.entries()) {
      const expected = manifest.chunks[index];
      if (!expected || !isWfdRecord(value) || value.chunk_id !== expected.chunk_id || value.ordinal !== expected.ordinal
        || value.row_count !== expected.row_count || value.digest !== expected.digest || typeof value.received !== 'boolean')
        fail('STATUS', 'WFD 回执中的分片声明与冻结清单不符。');
      if ((value as WfdRecord).received) receivedOrdinals.push(index);
    }
    if (result.chunks.length !== Math.min(50, manifest.chunks.length) || receivedOrdinals.length > Number(result.received_chunks)
      || (manifest.chunks.length <= 50 && receivedOrdinals.length !== Number(result.received_chunks))
      || ['ready', 'finalizing', 'finalized'].includes(result.phase) && (Number(result.received_chunks) !== manifest.chunks.length
        || receivedOrdinals.length !== result.chunks.length))
      return fail('STATUS', 'WFD 暂存状态与实际分片目录不一致。');
    return { phase: result.phase, received: Number(result.received_chunks), receivedOrdinals };
  }

  private async publish(record: BulkRecord, context: TaskExecutionContext): Promise<TaskResult> {
    if (record.phase === 'completed') return this.completion(record);
    const id = record.input.intakeId, manifest = record.manifest ?? fail('MANIFEST', '整件加工清单未完成。');
    if (record.confirmedDigest !== manifest.manifestDigest || record.stagedChunks !== manifest.chunks.length)
      fail('CONFIRMATION', '确认的整件清单或 WFD 已就绪分片不符合原任务。');
    const current = () => this.assertCurrent(record, context), header = this.header(record);
    const result = (await this.client.batchStatus(id, context.signal)).result;
    current();
    const { phase } = this.status(record, result);
    if (phase === 'rejected') return this.rejectTask(record, result);
    const cleanupPending = phase === 'finalized' && result.staging_cleanup_required === true;
    if (phase === 'finalized') this.acceptReceipt(record, header, result);
    if (phase !== 'finalized' || cleanupPending) {
      const activated = cleanupPending || result.activation_state === 'activated' && result.recovery_required === true;
      const notActivated = result.activation_state === 'not_activated' && result.recovery_required === true;
      if (phase !== 'ready' && !activated && !notActivated)
        fail('RECOVERY_PENDING', 'WFD 尚未确定原正式提交结果，继续保留同一请求。');
      // WFD derives the exact product identity and enforces its usage policy under publication authority.
      if (!activated) this.assertProfile(record);
      this.disk(0, 'activate');
      record.phase = 'committing'; this.save(record);
      const effectId = 'r1-bulk-commit:' + id;
      await context.emit({ type: 'checkpoint', checkpoint: { requestId: id, manifestDigest: manifest.manifestDigest } });
      await context.emit({ type: 'side_effect_started', effectId, description: '向冻结 WFD 连接正式提交整件',
        operation: { requestId: id, manifestDigest: manifest.manifestDigest } });
      current();
      if (!activated) this.assertProfile(record);
      const finalized = (await this.client.batchFinalize(id, context.signal)).result;
      current();
      const status = this.status(record, finalized);
      if (status.phase === 'rejected') {
        await context.emit({ type: 'side_effect_result', effectId, outcome: 'not_applied', evidence: 'WFD 已明确拒绝整件，未正式发布。' });
        return this.rejectTask(record, finalized);
      }
      if (status.phase !== 'finalized' || finalized.staging_cleanup_required !== false)
        fail('RECOVERY_PENDING', '原编号正式回执或暂存收尾尚未齐全。');
      this.acceptReceipt(record, header, finalized);
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '原批号正式回执与冻结清单已核对。' });
    }
    current();
    this.disk();
    await context.emit({ type: 'progress', message: '正式回执已核对，正在验证原固定快照。', progress: 0.1 });
    const readbackInput = { receipt: record.receipt!,
      client: this.client, checkpoint: record.checkpoint, signal: context.signal, assertCurrent: current,
      onCheckpoint: async (checkpoint: WfdRecord) => {
        current(); this.disk();
        if (Buffer.byteLength(canonicalWfdJson(checkpoint)) > 64 * 1024) fail('CHECKPOINT', '固定读回续办位置超出元数据预算。');
        record.checkpoint = checkpoint; this.save(record);
        await context.emit({ type: 'progress', message: '已核对正式快照的一段完整来源原报。',
          progress: 0.1 + 0.89 * Number(checkpoint.verifiedRows ?? 0) / manifest.rowCount, data: {
          verifiedChunks: Number(checkpoint.verifiedChunks ?? 0), verifiedRows: Number(checkpoint.verifiedRows ?? 0),
        } });
      } };
    const readback = header.protocol_version === TABULAR_BATCH_PROTOCOL && manifest.version === TABULAR_BULK_VERSION
      ? await this.tabular.transport.verifyReadback({ ...readbackInput, header, manifest })
      : header.protocol_version === SOURCE_MINUTE_BATCH_PROTOCOL && manifest.version !== TABULAR_BULK_VERSION
        ? await this.options.transport.verifyReadback({ ...readbackInput, header, manifest })
        : fail('MANIFEST', '固定读回协议与冻结清单不符。');
    current(); this.disk();
    const proof = { version: this.version(record), intakeId: id, materialId: record.plan.materialId, planDigest: record.plan.digest,
      manifestDigest: manifest.manifestDigest, rowCount: manifest.rowCount, snapshotId: record.receipt!.snapshot_id,
      productId: record.receipt!.product_id, partition: record.receipt!.partition, resultRoot: record.receipt!.result_root,
      rowsDigest: manifest.rowsDigest, readback };
    this.options.database.transaction(() => {
      const previous = this.db.prepare('SELECT proof_digest FROM r1_source_minute_associations WHERE intake_id=?').get(id);
      if (previous && previous.proof_digest !== hash(proof)) fail('ASSOCIATION', '整件已有不同的原关联根。');
      if (!previous) this.db.prepare('INSERT INTO r1_source_minute_associations VALUES(?,?,?,?)').run(id, canonicalWfdJson(proof), hash(proof), Date.now());
      record.proof = proof; record.phase = 'completed'; record.checkpoint = null; this.save(record);
    });
    return this.completion(record);
  }

  private rejected(record: BulkRecord, result: WfdRecord) {
    record.phase = result.state === 'conflicts_pending' ? 'conflicts_pending' : 'blocked';
    const issue = Array.isArray(result.errors) ? result.errors.find(isWfdRecord) : undefined;
    const code = issue && typeof issue.code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(issue.code) ? issue.code : null;
    const summary = result.row_summary;
    if (isWfdRecord(summary) && summary.inserted === 0 && summary.duplicate_skipped === 0
      && summary.conflict_pending === record.manifest?.rowCount)
      record.rowSummary = { inserted: 0, duplicate_skipped: 0, conflict_pending: Number(summary.conflict_pending) };
    record.error = { code: 'R1_BULK_WFD_REJECTED', message: 'WFD 已明确拒绝原整件，正式发布未发生。'
      + (code ? ' WFD 错误编号为 ' + code + '。' : '') };
    this.disk();
    this.save(record);
    return record.error;
  }
  private rejectTask(record: BulkRecord, result: WfdRecord): never {
    const error = this.rejected(record, result);
    throw new TaskError(error.code, error.message);
  }
  private acceptReceipt(record: BulkRecord, header: BulkHeader, result: WfdRecord) {
    const manifest = record.manifest ?? fail('MANIFEST', '整件加工清单未完成。');
    const receipt = header.protocol_version === TABULAR_BATCH_PROTOCOL && manifest.version === TABULAR_BULK_VERSION
      ? this.tabular.transport.verifyReceipt(header, manifest, result)
      : header.protocol_version === SOURCE_MINUTE_BATCH_PROTOCOL && manifest.version !== TABULAR_BULK_VERSION
        ? this.options.transport.verifyReceipt(header, manifest, result)
        : fail('MANIFEST', '正式回执协议与冻结清单不符。');
    this.disk();
    if (record.receipt && !same(record.receipt, receipt)) fail('RECEIPT_CHANGED', '同号正式回执改变，固定读回未继续。');
    record.receipt = receipt;
    const summary = receipt.row_summary as WfdRecord;
    record.rowSummary = { inserted: Number(summary.inserted), duplicate_skipped: Number(summary.duplicate_skipped), conflict_pending: Number(summary.conflict_pending) };
    record.phase = 'published_readback'; this.save(record);
  }
  private stageResult(record: BulkRecord): TaskResult {
    return { summary: '完整来源原报分片已暂存，等待清单摘要确认。', data: { intakeId: record.input.intakeId, manifestDigest: record.manifest!.manifestDigest } };
  }
  private association(record: BulkRecord): WfdRecord | null {
    if (record.phase !== 'completed') return null;
    const row = this.db.prepare('SELECT proof_json,proof_digest FROM r1_source_minute_associations WHERE intake_id=?').get(record.input.intakeId);
    if (!row || !record.proof || row.proof_digest !== hash(record.proof) || row.proof_json !== canonicalWfdJson(record.proof))
      return fail('ASSOCIATION', '固定关联证明与已完成接收记录不一致。');
    return record.proof;
  }
  private completion(record: BulkRecord): TaskResult {
    return { summary: '同号整件正式回执与全部固定读回已核对，关联根已登记。', data: asJson(this.association(record)) };
  }

  async recover(input: Parameters<NonNullable<TaskRuntime['recover']>>[0]): ReturnType<NonNullable<TaskRuntime['recover']>> {
    const { task, signal, effects } = input;
    const record = this.boundTask(task), id = record.input.intakeId;
    this.assertBinding(record); signal.throwIfAborted();
    const result = (await this.client.batchStatus(id, signal)).result;
    this.assertBinding(record); signal.throwIfAborted();
    const currentTask = this.tasks.get(task.id);
    if (currentTask.version !== task.version || currentTask.currentAttemptId !== task.currentAttemptId)
      return fail('TASK_NOT_ACTIVE', '核对期间原尝试已变化。');
    const phase = this.notFound(id, result) ? 'not_found' : this.status(record, result).phase;
    const settled = (outcome: 'succeeded' | 'not_applied', evidence: string) => effects
      .filter(effect => effect.status === 'started').map(effect => ({ attemptId: effect.attemptId, effectId: effect.effectId, outcome, evidence }));
    if (task.action === STAGE && ['collecting', 'ready', 'not_found'].includes(phase)) {
      const evidence = '已核对原 WFD 批号暂存状态，可同号继续未完操作。';
      if (phase === 'ready') {
        this.disk();
        record.stagedChunks = record.manifest!.chunks.length;
        record.phase = 'ready_to_commit';
        this.save(record);
        return { outcome: 'succeeded', evidence, result: this.stageResult(record), effects: settled('succeeded', evidence) };
      }
      return { outcome: 'not_applied', evidence, effects: settled(phase === 'not_found' ? 'not_applied' : 'succeeded', evidence) };
    }
    if (task.action === COMMIT && phase === 'finalized') {
      const evidence = '原批号已产生已验证的正式回执，可以继续固定读回。';
      if (record.phase === 'completed') return { outcome: 'succeeded', evidence, result: this.completion(record), effects: settled('succeeded', evidence) };
      this.acceptReceipt(record, this.header(record), result);
      const updates = settled('succeeded', evidence);
      return { outcome: 'not_applied', evidence, effects: updates, ...(updates.length
        ? { progressEvidenceKey: (record.input.mode === R1_TABULAR_BULK_MODE ? 'wfd-tabular-formal:' : 'wfd-source-minute-formal:') + String(record.receipt!.result_root) } : {}) };
    }
    if (task.action === COMMIT && result.recovery_required === true && result.activation_state === 'activated') {
      if (!sha(result.result_root) || typeof result.snapshot_id !== 'string' || !/^s_[a-f0-9]{24}$/u.test(result.snapshot_id)
        || result.partition !== (record.manifest?.version === TABULAR_BULK_VERSION ? record.manifest.partition.value : record.manifest?.partition.date))
        return fail('STATUS', '激活核对结果缺少原分区的固定候选。');
      const evidence = 'WFD 已核对原候选激活，需同一批号补齐正式回执。';
      const updates = settled('succeeded', evidence);
      return { outcome: 'not_applied', evidence, effects: updates, ...(updates.length
        ? { progressEvidenceKey: (record.input.mode === R1_TABULAR_BULK_MODE ? 'wfd-tabular-activated:' : 'wfd-source-minute-activated:') + result.result_root } : {}) };
    }
    if (task.action === COMMIT && (phase === 'ready' || result.recovery_required === true && result.activation_state === 'not_activated')) {
      const evidence = '原批号仍仅为暂存就绪，未进入正式提交。';
      return { outcome: 'not_applied', evidence, effects: settled('not_applied', evidence) };
    }
    if (task.action === COMMIT && phase === 'rejected') {
      this.rejected(record, result);
      const evidence = '原批号整件已由 WFD 拒绝。';
      return { outcome: 'failed', evidence, effects: settled('not_applied', evidence) };
    }
    return { outcome: 'pending', evidence: '原批号正式结果仍未知，保留现有编号和证据。', effects: [] };
  }

  async readPage(id: string, input: unknown): Promise<WfdRecord> {
    if (!isWfdRecord(input) || Object.keys(input).some(key => key !== 'cursor' && key !== 'pageSize')
      || !Number.isSafeInteger(input.pageSize) || Number(input.pageSize) < 1 || Number(input.pageSize) > 200
      || !(input.cursor === null || typeof input.cursor === 'string' && input.cursor.length > 0 && input.cursor.length <= 8192))
      return fail('READ_INPUT', '读取需要有限页长及原固定读回游标。');
    const record = this.record(id);
    const proof = this.association(record) ?? fail('READ_NOT_READY', '整件固定关联尚未完成。');
    const generation = this.assertControl();
    this.assertBinding(record);
    const request = { snapshot_id: String(proof.snapshotId), product_id: String(proof.productId), partition: String(proof.partition),
      result_root: String(proof.resultRoot), page_size: Number(input.pageSize), cursor: input.cursor };
    const page = (record.input.mode === R1_TABULAR_BULK_MODE
      ? await this.client.tabularReadPage({ ...request, protocol_version: TABULAR_BATCH_PROTOCOL })
      : await this.client.sourceMinuteReadPage(request)).result;
    if (generation !== this.assertControl()) return fail('TASK_NOT_ACTIVE', '读取期间停止代次改变，本页未采用。');
    this.assertBinding(record);
    const receipt = record.receipt ?? fail('ASSOCIATION', '固定关联缺正式回执。');
    if (page.snapshot_id !== request.snapshot_id || page.product_id !== request.product_id || page.partition !== request.partition
      || page.result_root !== request.result_root || page.row_count !== proof.rowCount || page.rows_digest !== proof.rowsDigest
      || !same(page.definition_ref ?? null, receipt.definition_ref ?? null) || !same(page.contract_refs ?? null, receipt.contract_refs ?? null)
      || !same(page.contract_bundle_ref ?? null, receipt.contract_bundle_ref ?? null)
      || !Array.isArray(page.rows) || page.rows.length > request.page_size
      || !(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor.length > 0 && page.next_cursor.length <= 8192))
      return fail('READ_PAGE', '结果页与已验证的固定关联不一致。');
    return page;
  }

  async reclaim(id: string): Promise<R1TabularBulkView> {
    return this.act(id, () => this.reclaimOriginal(id));
  }
  private async reclaimOriginal(id: string): Promise<R1TabularBulkView> {
    const record = this.record(id);
    const generation = this.assertControl();
    const current = () => {
      if (this.assertControl() !== generation) fail('TASK_NOT_ACTIVE', '回收期间停止代次已改变。');
      this.assertBinding(record);
    };
    current();
    if (!this.association(record)
      || !record.commitTaskId || this.tasks.get(record.commitTaskId).status !== 'succeeded'
      || this.options.store.status(id).state !== 'sealed')
      fail('RECLAIM_NOT_READY', '须完成固定读回及关联并保有原件，方可回收加工暂存。');
    // The task's verified material remains reconstructible from the durable original.
    const material = this.options.materials.get(record.plan.materialId);
    if (material.envelope.sha256 !== record.input.sha256 || material.envelope.originalStorage !== 'managed-file/v1')
      fail('RECLAIM_NOT_READY', '原件保管回执无法核对，保留加工暂存。');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of this.options.store.readStream(id)) {
      current();
      hash.update(chunk); bytes += chunk.byteLength;
    }
    if (bytes !== record.input.byteLength || hash.digest('hex') !== record.input.sha256)
      fail('RECLAIM_NOT_READY', '整件原始字节无法重建原清单，保留加工暂存。');
    current();
    await this.removeStage(record, current);
    return this.get(id);
  }
  private stagePath(reference: NonNullable<BulkRecord['stageRef']>) {
    const path = this.options.resources.resolve(reference);
    const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (info && (!info.isDirectory() || String(info.dev) !== reference.device || String(info.ino) !== reference.inode))
      fail('STAGING', '加工目录已被替换。');
    return path;
  }
  private async removeStage(record: BulkRecord, assertCurrent: () => void = () => {}) {
    if (!record.stageRef) return;
    if (!/^bd-(?:source-minute|tabular)-stage-[0-9a-f-]{36}$/u.test(record.stageRef.relative)
      || record.stageRef.root !== record.binding.root || record.stageRef.identity !== record.binding.identity)
      fail('STAGING', '加工目录身份与原接收冻结绑定不同。');
    const path = this.stagePath(record.stageRef);
    const info = lstatSync(path, { throwIfNoEntry: false });
    assertCurrent();
    if (info) await rm(path, { recursive: true, force: false });
    assertCurrent();
    record.stageRef = null; this.save(record);
  }
}

// Retain the v1 API exports for callers that inspect or resume historical intakes.
export { R1TabularBulkService as R1SourceMinuteBulkService, assertTabularBulkDiskGrowth as assertSourceMinuteDiskGrowth,
  R1_TABULAR_BULK_ACTIONS as R1_SOURCE_MINUTE_ACTIONS,
  R1_TABULAR_BULK_COMMIT_NO_PROGRESS_MS as R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS };
export type R1SourceMinuteBulkStatus = R1TabularBulkStatus;

function readInput(value: unknown): BulkInput {
  if (!isWfdRecord(value) || !isR1BulkMode(value.mode)) return fail('INPUT', '需要已登记的批量接收模式。');
  const generic = value.mode === R1_TABULAR_BULK_MODE;
  const fields = ['mode', 'intakeId', 'name', 'sha256', 'byteLength', 'source', 'datasetId', 'sourceValueColumns',
    ...(generic ? ['profileId', 'partitionValue'] : ['datePolicy', 'partitionDate'])];
  if (Object.keys(value).some(field => !fields.includes(field))
    || !requestId(value.intakeId) || !key(value.datasetId) || typeof value.name !== 'string' || !/\.csv$/iu.test(value.name)
    || value.name.length > 512 || /[/\\\u0000-\u001f\u007f]/u.test(value.name) || typeof value.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1
    || Number(value.byteLength) > (generic ? TABULAR_BULK_LIMITS : SOURCE_MINUTE_BULK_LIMITS).sourceBytes
    || value.datePolicy !== undefined && value.datePolicy !== 'a_share_calendar_day_asia_shanghai'
    || value.partitionDate !== undefined && (typeof value.partitionDate !== 'string' || !/^\d{8}$/u.test(value.partitionDate))
    || value.profileId !== undefined && !key(value.profileId))
    return fail('INPUT', '批量接收需要原 CSV 完整身份和已登记的来源档案引用。');
  const columns = value.sourceValueColumns;
  if ((!generic || columns !== undefined) && (!Array.isArray(columns) || columns.length < 1
    || (generic ? columns.length > TABULAR_MAX_FIELDS : columns.length !== 11) || new Set(columns).size !== columns.length
    || columns.some(name => typeof name !== 'string' || !name || name.length > 256)))
    return fail('INPUT', '显式选列需要唯一、完整的原列名。');
  const allowed = ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope', 'license', 'authorization'];
  if (!isWfdRecord(value.source) || Object.keys(value.source).some(name => !allowed.includes(name)))
    return fail('SOURCE', '来源声明含未登记字段。');
  const source = value.source as unknown as R1SourceDeclaration;
  assertKnownR1Source(source);
  if (source.license !== undefined && (typeof source.license !== 'string' || source.license.length > 4096
    || /[\u0000-\u001f]/u.test(source.license))) fail('SOURCE', '来源许可原文超出声明范围。');
  const requested = parseR1Utc(source.requested_at_utc), acquired = parseR1Utc(source.acquired_at_utc);
  if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested)
    return fail('SOURCE_TIME', '原来源请求及实际取得时间必须是有序有效 UTC。');
  return structuredClone(value) as unknown as BulkInput;
}

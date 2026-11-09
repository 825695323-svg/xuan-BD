/**
 * 文档片段与精选索引的服务装配（R01—R06、R09）。
 *
 * 职责边界：
 * - 输入只接受**已登记的转换产物**（`conversion.document` / `pdf.extract`），经
 *   `FileReferenceService` 在任务内按 `file:read` 读回；不直接调底层 PDF 能力。
 * - 登记进 4.3 证据账本（`conversion_artifacts`，一对多），片段与文档时间进独立
 *   `segments.sqlite`；两者都不写 WFD 正式数据。
 * - 检索结果必须带历史资格、覆盖与缺口；未命中不得合并成“无结果”。
 *
 * 规则来源：《4.2-文档片段化实现契约-v1》§一—§十、4.3 §8、4.8 §8、V2.0 §8.3。
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import type { CoreDatabase } from '../../../platform/state/database.js';
import { TaskError, type TaskExecutionContext, type TaskOperation, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../../platform/jobs/tasks.js';
import { digestOperationArgs, PermissionError } from '../../../platform/security/permissions.js';
import type { FileReferenceService } from '../../../platform/resources/files.js';
import type { MaterialService } from '../materials/service.js';
import {
  NOT_APPLICABLE_TIME, REGISTRABLE_ARTIFACT_TYPES, SEGMENT_RETRIEVAL_SCHEMA, SEGMENTABLE_ARTIFACT_TYPES,
  SEGMENT_TOKENIZER, SEGMENTER_VERSION, SEGMENT_ISSUES, UNKNOWN_TIME,
  type ConversionArtifactRecord, type DocSegment, type DocumentTimeRecord, type RetrievalCitation, type RetrievalCoverage,
  type RetrievalExclusion, type RetrievalHistoryMode, type RetrievalQualification, type SegmentRetrievalResult,
  type SegmentRetrievalStatus, type TimeDimension, type TimePrecision,
} from './contracts.js';
import { segmentsFromConversionArtifact, type ConversionArtifactEnvelope } from './from-conversion.js';
import { discoverArtifacts, ensureArtifactLedger, recordArtifact, setArtifactStatus } from './artifacts.js';
import {
  createCurrentIndexVersion, documentsWithoutTextLayer, ensureSegmentSchema, listDocumentVersions,
  listIndexVersions, listSegments, putDocumentSegments, putDocumentVersion, readDocumentVersion, readSegment,
  resolveIndexVersion, resolveVisibleVersions, searchSegments, searchSegmentsExact, segmentStorage, upperOf,
} from './store.js';

export const SEGMENT_RUNTIME = 'bd.doc-segment-runtime';
export const ARTIFACT_ACTION = 'retrieval.artifact';
export const SEGMENT_OPERATION_VERSION = 2;
export const SEGMENT_ARTIFACT_MAX_BYTES = 64_000_000;
const EXCERPT_LIMIT = 2_000;
const REQUEST_SCHEMA = 'bd.segment-request/2';

export interface SegmentServiceOptions {
  /** 核心状态库：任务接收、请求记录与 4.3 产物账本都在这里。 */
  database: CoreDatabase;
  /** 片段与索引的独立库；不放进 core.sqlite。 */
  databasePath: string;
  tasks: () => TaskService;
  files: FileReferenceService;
  materials: MaterialService;
}

/** 时间输入：字符串/对象/空值三种写法，统一解析成显式状态。 */
export type TimeInput = string | { state: TimeDimension['state']; value?: string; precision?: TimePrecision } | null;

export interface ArtifactIngestInput {
  materialId: string;
  /** 已登记转换产物的 fileRefId（structured-conversion）。 */
  artifactRef: string;
  /** 来源版本；缺省取 4.3 材料版本，不按文件名或当前时间编造。 */
  documentVersion?: string;
  /** 业务/事件时间。规划未定义取得通道，只能显式提供或标 unknown/not_applicable。 */
  eventTime?: TimeInput;
  /** 首次合格公开时间（披露/发布）。同上。 */
  disclosedAt?: TimeInput;
  /** 产生该产物的转换任务；提供则核对该任务回执确实引用了这份产物。 */
  conversionTaskId?: string;
}

export interface SearchRequestInput {
  method: 'keyword' | 'exact';
  query: string;
  limit?: number;
  indexVersion?: string;
  asOf?: string | null;
  mode?: RetrievalHistoryMode;
  documentIds?: readonly string[];
}

export interface SegmentSettings { autoRegister: 'enabled' | 'disabled'; autoSegment: 'enabled' | 'disabled'; autoIndex: 'enabled' | 'disabled' }

/** 持久化后的请求绑定：时间已解析为显式状态，不再保留调用方的原始写法。 */
interface ArtifactRequestBinding {
  materialId: string;
  artifactRef: string;
  requestId: string;
  documentVersion?: string;
  eventTime: TimeDimension;
  disclosedAt: TimeDimension;
  conversionTaskId?: string;
}

const REQUEST_SQL = `
CREATE TABLE IF NOT EXISTS segment_requests (
  request_key TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segment_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const DEFAULT_SETTINGS: SegmentSettings = { autoRegister: 'enabled', autoSegment: 'enabled', autoIndex: 'enabled' };

export class SegmentService {
  private db: DatabaseSync | null = null;
  private coreMigrated = false;
  private jointEntry: string | null = null;

  attachJointRetrieval(entry: string): void { this.jointEntry = entry; }
  private autoUnsubscribe?: () => void;
  private autoScheduled = false;
  private closed = false;

  constructor(private readonly options: SegmentServiceOptions) {}

  private get connection(): DatabaseSync {
    if (this.db) return this.db;
    const path = this.options.databasePath;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      ensureSegmentSchema(db);
    } catch (error) { db.close(); throw error; }
    this.db = db;
    return db;
  }

  /** 请求表与处理策略表只迁移一次；迁移自身会开事务，不能在别的核心事务里触发。 */
  private get core(): DatabaseSync {
    if (!this.coreMigrated) {
      this.options.database.migrate('bd.segment-requests', 2, REQUEST_SQL);
      this.coreMigrated = true;
    }
    return this.options.database.connection;
  }

  close(): void { this.closed = true; this.autoUnsubscribe?.(); this.autoUnsubscribe = undefined; this.db?.close(); this.db = null; }

  /** 已受理材料的本机转换自动接续；启用前的历史任务继续按原入口登记。 */
  attach(): void {
    if (this.autoUnsubscribe || this.closed) return;
    this.options.database.migrate('bd.segment-automatic', 1, `
      CREATE TABLE segment_auto_registrations (
        conversion_task_id TEXT NOT NULL, material_id TEXT NOT NULL, artifact_ref TEXT NOT NULL,
        task_id TEXT, error_json TEXT, PRIMARY KEY(conversion_task_id,material_id));
    `);
    ensureArtifactLedger(this.options.database);
    this.core.prepare(`INSERT OR IGNORE INTO segment_settings VALUES('conversion_start_rowid',
      CAST((SELECT coalesce(max(rowid),0) FROM tasks) AS TEXT),?)`).run(Date.now());
    this.autoUnsubscribe = this.options.tasks().subscribe(({task, event}) => {
      if (event.type === 'TASK_SUCCEEDED' && ['conversion.document', 'pdf.extract', 'materials.inspect'].includes(task.action)) this.scheduleRegistration();
    });
    this.scheduleRegistration();
  }

  automatic(materialId: string): JsonValue[] {
    return this.core.prepare('SELECT * FROM segment_auto_registrations WHERE material_id=? ORDER BY rowid DESC LIMIT 50').all(materialId)
      .map(row => ({ conversionTaskId: String(row.conversion_task_id), artifactRef: String(row.artifact_ref),
        task: row.task_id ? this.options.tasks().get(String(row.task_id)) : null,
        error: row.error_json ? JSON.parse(String(row.error_json)) : null } as unknown as JsonValue));
  }

  reconcileConversions(): void { this.scheduleRegistration(); }

  private scheduleRegistration(): void {
    if (!this.autoUnsubscribe || this.closed || this.autoScheduled) return;
    this.autoScheduled = true;
    queueMicrotask(() => { this.autoScheduled = false; if (!this.closed) this.registerConversions(); });
  }

  private registerConversions(): void {
    if (this.settings().autoRegister === 'disabled' || this.options.tasks().getControl().stopped) return;
    this.core.prepare(`INSERT OR IGNORE INTO segment_auto_registrations(conversion_task_id,material_id,artifact_ref)
      SELECT t.id,m.material_id,json_extract(t.result,'$.data.structuredReference.fileRefId')
      FROM tasks t JOIN material_objects m ON json_extract(m.envelope_json,'$.fileRefId')=json_extract(t.result,'$.data.source.fileRefId')
      WHERE t.rowid>CAST((SELECT value FROM segment_settings WHERE key='conversion_start_rowid') AS INTEGER)
      AND t.runtime_id='direct' AND t.action IN ('conversion.document','pdf.extract') AND t.status='succeeded'
      AND json_extract(t.result,'$.data.status') IN ('complete','partial')
      AND json_extract(t.result,'$.data.source.sha256')=json_extract(m.envelope_json,'$.sha256')
      AND json_type(t.result,'$.data.structuredReference.fileRefId')='text'
      AND NOT EXISTS(SELECT 1 FROM conversion_artifacts a WHERE a.material_id=m.material_id
        AND a.artifact_ref=json_extract(t.result,'$.data.structuredReference.fileRefId'))`).run();
    const rows = this.core.prepare('SELECT * FROM segment_auto_registrations WHERE task_id IS NULL AND error_json IS NULL').all();
    for (const row of rows) {
      if (this.closed || this.options.tasks().getControl().stopped) return;
      try {
        const task = this.requestArtifact({ materialId: String(row.material_id), artifactRef: String(row.artifact_ref),
          conversionTaskId: String(row.conversion_task_id) }, `auto:${row.conversion_task_id}:${row.material_id}`);
        this.core.prepare('UPDATE segment_auto_registrations SET task_id=? WHERE conversion_task_id=? AND material_id=?')
          .run(task.id,row.conversion_task_id,row.material_id);
      } catch (error) {
        this.core.prepare('UPDATE segment_auto_registrations SET error_json=? WHERE conversion_task_id=? AND material_id=?')
          .run(JSON.stringify({ code: error instanceof TaskError ? error.code : 'AUTO_REGISTRATION_FAILED',
            message: error instanceof Error ? error.message : '自动登记未完成。' }),row.conversion_task_id,row.material_id);
      }
    }
  }

  capabilities(): JsonValue {
    return { schema: SEGMENT_RETRIEVAL_SCHEMA, tokenizer: SEGMENT_TOKENIZER,
      // 出站只报文件名：本机绝对路径不随能力描述外发（4.3 §四）。
      databaseFile: this.options.databasePath.split('/').pop() ?? 'segments.sqlite',
      segmentableArtifactTypes: [...SEGMENTABLE_ARTIFACT_TYPES],
      registrableArtifactTypes: [...REGISTRABLE_ARTIFACT_TYPES],
      historyModes: ['system_held_at', 'market_known_at'],
      timeStates: ['known', 'unknown', 'not_applicable'],
      indexes: ['keyword', 'exact'],
      settings: this.settings(),
      structuredSide: { wired: this.jointEntry !== null, entry: this.jointEntry,
        reason: this.jointEntry ? '联合入口按已核对的WFD记录/版本关联材料；独立文档结果保持bd.doc-retrieval/2。'
          : '当前实例未装配联合入口。' },
      permissionScope: { wired: false, reason: '本地材料没有逐文档权限模型；4.3 §8.5 的“权限收紧”状态本轮不可产生。' },
      ocr: { wired: false, reason: 'OCR 未接入；无文字层的页面不生成片段，只记缺口，不补字。' } } as unknown as JsonValue;
  }

  // ── 处理策略 ──────────────────────────────────────────────────────────

  settings(): SegmentSettings {
    const rows = this.core.prepare('SELECT key, value FROM segment_settings').all() as unknown as { key: string; value: string }[];
    const stored = new Map(rows.map(row => [row.key, row.value]));
    const read = (key: keyof SegmentSettings): 'enabled' | 'disabled' =>
      stored.get(key) === 'disabled' ? 'disabled' : 'enabled';
    return { autoRegister: read('autoRegister'), autoSegment: read('autoSegment'), autoIndex: read('autoIndex') };
  }

  updateSettings(input: Partial<SegmentSettings>, requestId: string): SegmentSettings {
    const entries = Object.entries(input).filter(([, value]) => value !== undefined) as [keyof SegmentSettings, string][];
    if (!entries.length) throw new TaskError('SEGMENT_SETTINGS_EMPTY', '没有需要更新的处理策略。');
    for (const [key, value] of entries) {
      if (!(key in DEFAULT_SETTINGS) || (value !== 'enabled' && value !== 'disabled'))
        throw new TaskError('SEGMENT_SETTINGS', `处理策略 ${key} 只接受 enabled 或 disabled。`);
    }
    const now = Date.now();
    for (const [key, value] of entries) {
      this.core.prepare(`INSERT INTO segment_settings VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, now);
    }
    void requestId;
    this.scheduleRegistration();
    return this.settings();
  }

  // ── 写入：产物登记 + 片段化 + 增量建索引 ────────────────────────────────

  requestArtifact(input: ArtifactIngestInput, requestId: string): TaskRecord {
    const normalized = normalizeArtifactRequest(input);
    const requestKey = `retrieval.artifact:${requestId}`;
    const digest = digestOperationArgs({ ...normalized, requestId });
    const previous = this.request(requestKey);
    if (previous) {
      if (previous.input_digest !== digest) throw new TaskError('REQUEST_CONFLICT', '同一入库请求不能更换材料、产物或时间。');
      return this.options.tasks().get(previous.task_id);
    }
    const tasks = this.options.tasks();
    const binding: ArtifactRequestBinding = { ...normalized, requestId,
      eventTime: parseTimeDimension(normalized.eventTime, 'eventTime'),
      disclosedAt: parseTimeDimension(normalized.disclosedAt, 'disclosedAt') };
    const args = JSON.parse(JSON.stringify({ materialId: normalized.materialId, artifactRef: normalized.artifactRef,
      documentVersion: normalized.documentVersion ?? null,
      conversionTaskId: normalized.conversionTaskId ?? null, requestId })) as JsonValue;
    let accepted!: { task: TaskRecord; publish(): void };
    this.options.database.transaction(() => {
      accepted = tasks.createInTransaction({ title: `转换产物入库：${normalized.materialId}`, ownerRole: 'service',
        runtimeId: SEGMENT_RUNTIME, action: ARTIFACT_ACTION, args, requestId: requestKey,
        ...(normalized.conversionTaskId ? { parentTaskId: normalized.conversionTaskId } : {}),
        versions: { segmenter: SEGMENT_RETRIEVAL_SCHEMA, requestSchema: REQUEST_SCHEMA,
          operationVersion: String(SEGMENT_OPERATION_VERSION) } });
      this.core.prepare('INSERT INTO segment_requests VALUES(?,?,?,?,?,?)').run(requestKey, requestId, accepted.task.id,
        JSON.stringify(binding), digest, Date.now());
    });
    accepted.publish();
    return tasks.start(accepted.task.id, accepted.task.version);
  }

  readonly runtime: TaskRuntime = { id: SEGMENT_RUNTIME, execute: async (context: TaskExecutionContext): Promise<TaskResult> => {
    if (context.task.action !== ARTIFACT_ACTION) throw new TaskError('SEGMENT_ACTION_DISABLED', '产物入库运行时只接受已登记转换产物。');
    const binding = this.requestByTask(context.task.id);
    const material = this.options.materials.get(binding.materialId);
    const documentVersion = binding.documentVersion ?? String(material.envelope.version);
    const reference = this.options.files.verify(binding.artifactRef);
    if (reference.status !== 'available') throw new TaskError('SEGMENT_ARTIFACT_UNAVAILABLE', '产物引用当前不可读取。');

    const operation: TaskOperation = { operationId: ARTIFACT_ACTION, operationVersion: SEGMENT_OPERATION_VERSION,
      argsDigest: digestOperationArgs({ materialId: binding.materialId, artifactRef: binding.artifactRef, documentVersion }),
      targets: [{ kind: 'file', path: reference.invocationPath }] };
    const capabilities = [{ action: 'read' as const, target: { kind: 'file' as const, path: reference.invocationPath } }];
    let approvalId: string | undefined;
    try { context.assertAuthorized(operation, capabilities); }
    catch (error) {
      if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
      approvalId = (await context.requestApproval(operation, capabilities)).approvalId ?? undefined;
    }
    context.signal.throwIfAborted();
    const bytes = await this.options.files.readBytes(binding.artifactRef,
      { operation: context.operationScope(operation), approvalId, maxBytes: SEGMENT_ARTIFACT_MAX_BYTES });
    context.signal.throwIfAborted();

    let envelope: ConversionArtifactEnvelope & { operation?: string };
    try { envelope = JSON.parse(bytes.toString('utf8')) as typeof envelope; }
    catch { throw new TaskError('SEGMENT_ARTIFACT_INVALID', '产物不是可解析的转换信封 JSON。'); }
    const artifactType = typeof envelope.operation === 'string' ? envelope.operation : '';
    if (!(REGISTRABLE_ARTIFACT_TYPES as readonly string[]).includes(artifactType))
      throw new TaskError('SEGMENT_ARTIFACT_OPERATION', `产物操作 ${artifactType || '(缺失)'} 未登记，不能进入证据账本。`);
    // 产物必须属于该材料的那份原件：校验它自称的来源身份，不用文件名、不用当前时间。
    if (envelope.source?.fileRefId !== material.envelope.fileRefId || envelope.source?.sha256 !== material.envelope.sha256)
      throw new TaskError('SEGMENT_ARTIFACT_MISMATCH', '产物来源与 4.3 保管材料的原件身份或摘要不一致。');

    // 转换运行身份只用可核对的事实：给了任务号就核对它的回执确实引用了这份产物。
    const runId = binding.conversionTaskId === undefined ? `direct:${artifactType}`
      : this.verifyConversionRun(binding.conversionTaskId, binding.artifactRef, material.envelope.materialId);
    const ledger = recordArtifact(this.options.database, { material_id: binding.materialId,
      material_version: documentVersion, material_sha256: material.envelope.sha256,
      conversion_run_id: runId,
      artifact_ref: binding.artifactRef, artifact_type: artifactType,
      artifact_sha256: digestOf(bytes), artifact_bytes: bytes.byteLength,
      parser_version: pdfjsOf(envelope) ?? null, declared_source_sha256: envelope.source?.sha256 ?? null });

    const segmentable = (SEGMENTABLE_ARTIFACT_TYPES as readonly string[]).includes(artifactType);
    const settings = this.settings();
    if (!segmentable || settings.autoSegment === 'disabled') {
      return artifactResult(ledger, { segmented: false, reason: segmentable ? 'auto_segment_disabled' : 'artifact_type_not_segmentable' });
    }

    let built;
    try { built = segmentsFromConversionArtifact(envelope, { artifactRef: binding.artifactRef,
      documentId: binding.materialId, documentVersion }); }
    catch (error) { throw new TaskError('SEGMENT_BUILD_FAILED', error instanceof Error ? error.message : String(error)); }

    const parserVersion = built.segments[0]?.parser_version ?? `${SEGMENTER_VERSION}`;
    const recorded = readDocumentVersion(this.connection, binding.materialId, documentVersion, parserVersion);
    if (recorded && recorded.artifact_ref !== binding.artifactRef)
      throw new TaskError('SEGMENT_PARSE_DRIFT', '同一文档版本已由另一份产物生成片段；换产物须升 parser_version 后重新解析。');
    if (recorded && recorded.segment_count === built.segments.length) {
      setArtifactStatus(this.options.database, ledger.artifact_record_id, 'segmented');
      const index = settings.autoIndex === 'enabled' && recorded.segment_count > 0
        ? this.buildIndex(`auto:${ledger.artifact_record_id}`) : null;
      return artifactResult(ledger, { segmented: true, disposition: 'existing', record: recorded, index });
    }
    const issues = new Set<string>(built.documentIssues.map(issue => issue.code));
    const eventIssue = timeIssue(binding.eventTime, 'event'), disclosureIssue = timeIssue(binding.disclosedAt, 'disclosure');
    if (eventIssue !== null) issues.add(eventIssue);
    if (disclosureIssue !== null) issues.add(disclosureIssue);
    const now = Date.now();
    const record: DocumentTimeRecord = { document_id: binding.materialId, document_version: documentVersion,
      parser_version: parserVersion, artifact_ref: binding.artifactRef, artifact_sha256: ledger.artifact_sha256,
      origin_sha256: material.envelope.sha256, acquired_at: material.envelope.createdAt,
      event_time: binding.eventTime, disclosed_at: binding.disclosedAt, parsed_at: now,
      page_count: new Set(built.segments.map(segment => segment.page_number)).size,
      segment_count: built.segments.length, issues: [...issues].sort() };
    let written = { inserted: 0, existing: 0 };
    let index: { indexVersion: string; reused: boolean } | null = null;
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      written = putDocumentSegments(this.connection, built.segments, now);
      putDocumentVersion(this.connection, record);
      if (settings.autoIndex === 'enabled' && built.segments.length > 0) {
        const builtIndex = this.buildIndex(`auto:${ledger.artifact_record_id}`);
        index = { indexVersion: builtIndex.indexVersion, reused: builtIndex.reused };
      }
      this.connection.exec('COMMIT');
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch { /* 事务可能已结束。 */ }
      if (error instanceof Error && /解析漂移|身份冲突|时间记录冲突|UNIQUE/u.test(error.message))
        throw new TaskError('SEGMENT_PARSE_DRIFT', error.message);
      throw error;
    }
    setArtifactStatus(this.options.database, ledger.artifact_record_id, 'segmented');
    await context.emit({ type: 'checkpoint', checkpoint: { documentId: binding.materialId, documentVersion,
      parserVersion, inserted: written.inserted, existing: written.existing, segmentCount: built.segments.length,
      artifactRecordId: ledger.artifact_record_id, ...(index ? { indexVersion: index.indexVersion } : {}) } });
    return artifactResult(ledger, { segmented: true, disposition: 'inserted', record, index });
  } };

  // ── 索引版本 ──────────────────────────────────────────────────────────

  buildIndex(note?: string): { indexVersion: string; builtAt: number; segmentCount: number; documentCount: number; reused: boolean } {
    try { return createCurrentIndexVersion(this.connection, note); }
    catch (error) {
      if (error instanceof Error && /至少需要一个片段/u.test(error.message))
        throw new TaskError('SEGMENT_INDEX_EMPTY', '还没有任何片段；先对已登记转换产物做片段化。');
      throw error;
    }
  }

  indexVersions(): ReturnType<typeof listIndexVersions> { return listIndexVersions(this.connection); }

  // ── 检索 ─────────────────────────────────────────────────────────────

  search(input: SearchRequestInput): SegmentRetrievalResult {
    const method: 'keyword' | 'exact' = input.method === 'exact' ? 'exact' : 'keyword';
    const query = typeof input.query === 'string' ? input.query : '';
    if (!query.trim()) throw new TaskError('SEGMENT_QUERY_REQUIRED', '检索需要非空查询文本。');
    const mode: RetrievalHistoryMode = input.mode === 'market_known_at' ? 'market_known_at' : 'system_held_at';
    const asOfMs = parseOptionalTime(input.asOf ?? null);
    if (input.documentIds !== undefined && (!Array.isArray(input.documentIds) || input.documentIds.length > 500
      || input.documentIds.some(id => typeof id !== 'string' || !id || id.length > 128))) {
      throw new TaskError('SEGMENT_DOCUMENT_SCOPE_INVALID', '文档范围必须是最多500个已关联材料身份。');
    }
    const gaps: string[] = [...(this.jointEntry ? [] : ['structured_query_not_wired']), 'permission_scope_not_implemented'];
    const versions = this.indexVersions();
    // 严格系统持有按 built_at 钉住版本；市场公开历史用当前索引，并标为事后重建。
    const resolved = input.indexVersion
      ? versions.find(version => version.index_version === input.indexVersion) ?? null
      : (() => { const pointer = resolveIndexVersion(this.connection, mode === 'market_known_at' ? null : asOfMs);
        return pointer === null ? null : versions.find(version => version.index_version === pointer.index_version) ?? null; })();
    if (!resolved) {
      return { schema: SEGMENT_RETRIEVAL_SCHEMA, structured: null, status: 'index_missing',
        query: { method, text: query, as_of: input.asOf ?? null },
        qualification: qualificationOf(mode, asOfMs, null), citations: [],
        coverage: { index_version: null, index_built_at: null, indexed_segments: 0, indexed_documents: 0,
          documents_without_text_layer: documentsWithoutTextLayer(this.connection), as_of: asOfMs, excluded: [] },
        gaps: [...gaps, input.indexVersion ? 'index_version_not_found' : 'no_index_at_as_of'] };
    }
    const indexVersion = resolved.index_version;
    // 时间门与版本收敛在 store 里一次算清：历史时点只答“当时可见的最后版本”。
    const view = asOfMs === null ? null
      : resolveVisibleVersions(this.connection, { indexVersion, asOf: asOfMs, mode });
    const hits = (method === 'exact' ? searchSegmentsExact : searchSegments)(this.connection,
      { indexVersion, query, limit: input.limit, visibleVersions: view?.allowed ?? null, documentIds: input.documentIds });
    const excluded: RetrievalExclusion[] = (view?.excluded ?? []).filter(item => input.documentIds === undefined || input.documentIds.includes(item.document_id));
    const coverage: RetrievalCoverage = { index_version: indexVersion, index_built_at: resolved.built_at,
      indexed_segments: resolved.segment_count, indexed_documents: resolved.document_count,
      documents_without_text_layer: documentsWithoutTextLayer(this.connection), as_of: asOfMs, excluded };
    if (coverage.documents_without_text_layer > 0) gaps.push('documents_without_text_layer');
    const status: SegmentRetrievalStatus = hits.length ? 'matched'
      : (asOfMs !== null && excluded.length ? 'history_unavailable' : 'no_match');
    return { schema: SEGMENT_RETRIEVAL_SCHEMA, structured: null, status,
      query: { method, text: query, as_of: input.asOf ?? null },
      qualification: qualificationOf(mode, asOfMs, resolved.built_at),
      citations: hits.map(hit => citation(hit.segment, indexVersion)), coverage, gaps };
  }

  segment(segmentId: string): RetrievalCitation {
    const found = readSegment(this.connection, segmentId);
    if (!found) throw new TaskError('SEGMENT_NOT_FOUND', '没有该片段。');
    return citation(found, null);
  }

  documents(): ReturnType<typeof listDocumentVersions> { return listDocumentVersions(this.connection); }

  segments(documentId: string, documentVersion?: string): RetrievalCitation[] {
    return listSegments(this.connection, documentId, documentVersion).map(segment => citation(segment, null));
  }

  /** 产物发现：按“可进索引”优先列出该材料已登记的转换产物。 */
  artifacts(materialId: string, materialVersion?: string): ConversionArtifactRecord[] {
    return discoverArtifacts(this.options.database, materialId, materialVersion ?? '1',
      SEGMENTABLE_ARTIFACT_TYPES).slice(0, 100);
  }

  /** 检索区实际占用与保存策略。程序不自动删除片段，容量与保留期由运营显式决定。 */
  storage(): JsonValue {
    const report = segmentStorage(this.connection);
    const sizes = fileSizes(this.options.databasePath);
    return { database: { file: this.options.databasePath.split('/').pop() ?? 'segments.sqlite', bytes: sizes.total, walBytes: sizes.wal,
        segments: report.segments, documents: report.documents, indexVersions: report.indexVersions,
        textBytes: report.textBytes, ftsTokenBytes: report.tokenBytes, ftsIndexBytes: report.ftsIndexBytes,
        indexMembershipRows: report.membershipRows, sharedIndexVersions: report.sharedIndexVersions, pages: report.pages,
        oldestParsedAt: report.oldestParsedAt, newestParsedAt: report.newestParsedAt },
      policy: { scope: 'bd-retrieval-workspace',
        summary: '全量片段与全文索引只属 BD 检索工作区，不是金融数据准入规则，也不写入 WFD 正式数据。',
        automaticDeletion: false,
        rebuildable: { segments: false, index: true },
        notes: ['片段属证据侧，程序不自动删；清理须由运营按明确范围操作。',
          'FTS 不再另存词项正文；倒排词项仍含原文信息，索引占用与访问权限仍须核对。',
          '完整原件的归档职责仍按 4.4；本地检索区不替代归档。'] } } as unknown as JsonValue;
  }

  /** 只核对“该任务回执确实引用了这份产物”，不推断任务内容或批准。 */
  private verifyConversionRun(taskId: string, artifactRef: string, materialId: string): string {
    const task = this.options.tasks().get(taskId);
    const ids = fileRefIdsOf(task.result?.data);
    if (!ids.includes(artifactRef))
      throw new TaskError('SEGMENT_ARTIFACT_RUN_MISMATCH', `转换任务 ${taskId} 的回执没有引用该产物，不能作为运行身份。`);
    if (task.action === undefined || task.runtimeId === undefined)
      throw new TaskError('SEGMENT_ARTIFACT_RUN_MISMATCH', '转换任务身份不完整。');
    void materialId;
    return taskId;
  }

  private request(key: string): { task_id: string; input_digest: string } | null {
    const row = this.core.prepare('SELECT task_id, input_digest FROM segment_requests WHERE request_key=?').get(key) as
      { task_id?: string; input_digest?: string } | undefined;
    return row?.task_id ? { task_id: row.task_id, input_digest: String(row.input_digest) } : null;
  }

  private requestByTask(taskId: string): ArtifactRequestBinding {
    const row = this.core.prepare('SELECT input_json FROM segment_requests WHERE task_id=?').get(taskId) as { input_json?: string } | undefined;
    if (!row?.input_json) throw new TaskError('SEGMENT_TASK_NOT_FOUND', '没有找到此产物入库任务输入。');
    const raw = JSON.parse(String(row.input_json)) as ArtifactRequestBinding;
    return { materialId: raw.materialId, artifactRef: raw.artifactRef, requestId: raw.requestId,
      ...(raw.documentVersion ? { documentVersion: raw.documentVersion } : {}),
      ...(raw.conversionTaskId ? { conversionTaskId: raw.conversionTaskId } : {}),
      eventTime: raw.eventTime ?? UNKNOWN_TIME, disclosedAt: raw.disclosedAt ?? UNKNOWN_TIME };
  }
}

// ── 输入规范化 ──────────────────────────────────────────────────────────

function normalizeArtifactRequest(input: ArtifactIngestInput): ArtifactIngestInput {
  const materialId = requireText(input.materialId, 'materialId', '缺少材料身份。');
  const artifactRef = requireText(input.artifactRef, 'artifactRef', '缺少已登记产物引用。');
  return { materialId, artifactRef,
    ...(input.documentVersion ? { documentVersion: requireText(input.documentVersion, 'documentVersion', '版本不能为空。') } : {}),
    ...(input.conversionTaskId
      ? { conversionTaskId: requireText(input.conversionTaskId, 'conversionTaskId', '转换任务编号无效。') } : {}),
    eventTime: input.eventTime ?? null, disclosedAt: input.disclosedAt ?? null };
}

function requireText(value: unknown, field: string, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TaskError('SEGMENT_INPUT', `${message}（${field}）`);
  return value.trim();
}

/** 时间只接受显式 ISO 8601 或显式状态；不解析自然语言，也不用当前时间顶替。 */
function parseTimeDimension(value: TimeInput | undefined, field: string): TimeDimension {
  if (value === undefined || value === null) return UNKNOWN_TIME;
  if (typeof value === 'string') return knownTime(value, null, field);
  if (typeof value !== 'object') throw new TaskError('SEGMENT_TIME', `${field} 必须是字符串或显式状态对象。`);
  if (value.state === 'unknown') return UNKNOWN_TIME;
  if (value.state === 'not_applicable') return NOT_APPLICABLE_TIME;
  if (value.state === 'known') {
    if (typeof value.value !== 'string') throw new TaskError('SEGMENT_TIME', `${field} 的 known 状态需要 value。`);
    const precision = value.precision ?? null;
    if (precision !== null && !['datetime', 'date', 'month', 'quarter', 'year'].includes(precision))
      throw new TaskError('SEGMENT_TIME', `${field} 的时间精度取值无效：${String(precision)}`);
    return knownTime(value.value, precision, field);
  }
  throw new TaskError('SEGMENT_TIME', `${field} 的时间状态无效。`);
}

function knownTime(value: string, precision: TimePrecision | null, field: string): TimeDimension {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TaskError('SEGMENT_TIME', `${field} 无法解析为 ISO 8601：${value}`);
  // 未显式声明精度时按字符串本身的粒度认定，不当成瞬时。
  const resolved = precision ?? inferPrecision(value);
  const dimension: TimeDimension = { state: 'known', value: parsed, precision: resolved, upper: null };
  return { ...dimension, upper: upperOf(dimension) };
}

/** 精度推断只认字面粒度，不猜含义。 */
function inferPrecision(value: string): TimePrecision {
  if (/^\d{4}$/u.test(value)) return 'year';
  if (/^\d{4}-\d{2}$/u.test(value)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return 'date';
  return 'datetime';
}

function parseOptionalTime(value: string | null): number | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new TaskError('SEGMENT_TIME', '时间必须是 ISO 8601 字符串。');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TaskError('SEGMENT_TIME', `无法解析时间：${value}`);
  return parsed;
}

function timeIssue(dimension: TimeDimension, kind: 'event' | 'disclosure'): string | null {
  if (dimension.state === 'unknown') return kind === 'event' ? SEGMENT_ISSUES.eventTimeUnknown : SEGMENT_ISSUES.disclosureTimeUnknown;
  if (dimension.state === 'not_applicable') return kind === 'event' ? SEGMENT_ISSUES.eventTimeNotApplicable : SEGMENT_ISSUES.disclosureTimeNotApplicable;
  return null;
}

function qualificationOf(mode: RetrievalHistoryMode, asOfMs: number | null, indexBuiltAt: number | null): RetrievalQualification {
  return { mode, applied: asOfMs !== null,
    reconstruction: mode === 'market_known_at' && asOfMs !== null && indexBuiltAt !== null && indexBuiltAt > asOfMs
      ? 'post_hoc' : 'none',
    index_built_at: indexBuiltAt };
}

// ── 派生 ────────────────────────────────────────────────────────────────

/** 从转换回执里取已发布产物的引用；只认明确字段，不递归猜结构。 */
function fileRefIdsOf(data: JsonValue | undefined): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const found: string[] = [];
  const push = (value: unknown) => { if (typeof value === 'string' && value.trim()) found.push(value); };
  push(record.fileRefId);
  for (const key of ['structuredReference', 'textReference']) {
    const entry = record[key];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) push((entry as Record<string, unknown>).fileRefId);
  }
  if (Array.isArray(record.artifacts)) {
    for (const entry of record.artifacts) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) push((entry as Record<string, unknown>).fileRefId);
    }
  }
  return found;
}

function digestOf(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function pdfjsOf(envelope: { content?: unknown; implementation?: { pdfjs?: string } }): string | undefined {
  return (envelope.content as { implementation?: { pdfjs?: string } } | undefined)?.implementation?.pdfjs
    ?? envelope.implementation?.pdfjs;
}

function fileSizes(path: string): { total: number; wal: number } {
  if (path === ':memory:') return { total: 0, wal: 0 };
  const size = (target: string) => { try { return statSync(target).size; } catch { return 0; } };
  return { total: size(path), wal: size(`${path}-wal`) };
}

function citation(segment: DocSegment, indexVersion: string | null): RetrievalCitation {
  const table = segment.table;
  return { segment_id: segment.segment_id, document_id: segment.document_id, document_version: segment.document_version,
    parser_version: segment.parser_version, ordinal: segment.ordinal, kind: segment.kind,
    page_number: segment.page_number, page_label: segment.page_label, section_path: segment.section_path,
    bbox: segment.bbox,
    table: table === null ? null : { table_id: table.table_id, part: table.part, parts: table.parts,
      header: table.header, period_axis: table.period_axis, unit: table.unit, verification: table.verification,
      first_cell_ref: table.rows[0]?.cells[0]?.cell_ref ?? null,
      last_cell_ref: table.rows.at(-1)?.cells.at(-1)?.cell_ref ?? null },
    excerpt: segment.text.length > EXCERPT_LIMIT ? segment.text.slice(0, EXCERPT_LIMIT) : segment.text,
    excerpt_truncated: segment.text.length > EXCERPT_LIMIT,
    text_digest: segment.text_digest, char_start: segment.char_start, char_end: segment.char_end,
    artifact_ref: segment.source_ref, index_version: indexVersion ?? '', issues: segment.issues };
}

function artifactResult(ledger: ConversionArtifactRecord, outcome: {
  segmented: boolean; reason?: string; disposition?: 'inserted' | 'existing'; record?: DocumentTimeRecord;
  index?: { indexVersion: string; reused: boolean } | null;
}): TaskResult {
  const data = { artifactRecordId: ledger.artifact_record_id, materialId: ledger.material_id,
    artifactType: ledger.artifact_type, artifactSha256: ledger.artifact_sha256, conversionRunId: ledger.conversion_run_id,
    segmented: outcome.segmented, ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.disposition ? { disposition: outcome.disposition } : {}),
    ...(outcome.record ? { documentVersion: outcome.record.document_version, parserVersion: outcome.record.parser_version,
      segmentCount: outcome.record.segment_count, pageCount: outcome.record.page_count,
      eventTime: outcome.record.event_time, disclosedAt: outcome.record.disclosed_at,
      issues: outcome.record.issues } : {}),
    ...(outcome.index ? { indexVersion: outcome.index.indexVersion, indexReused: outcome.index.reused } : {}) };
  const summary = outcome.segmented
    ? `转换产物已登记并入索引：${ledger.artifact_type}${outcome.record ? `，${outcome.record.segment_count} 个片段` : ''}。`
    : `转换产物已登记，未进入文档索引：${outcome.reason === 'auto_segment_disabled' ? '自动片段化已关闭' : '该产物类型不进索引'}。`;
  return { summary, artifactIds: [ledger.artifact_ref], data: data as unknown as JsonValue };
}

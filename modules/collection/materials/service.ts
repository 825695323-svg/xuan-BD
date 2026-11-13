import { createHash, randomUUID } from 'node:crypto';
import type { ResourceBindings } from '../../../platform/resources/bindings.js';
import type { CoreDatabase } from '../../../platform/state/database.js';
import { FileReferenceError, type FileReferenceService } from '../../../platform/resources/files.js';
import { digestOperationArgs, PermissionError } from '../../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../../platform/jobs/tasks.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import type { MaterialCategory, MaterialDeclaration, MaterialEnvelope, MaterialEnvironment, MaterialLimits, MaterialParserAdapter, MaterialPreview, MaterialRecord, MaterialSubmitInput } from './contracts.js';
import { DEFAULT_MATERIAL_ADAPTERS, inspectMaterial, inspectOversizedMaterial, MATERIAL_INSPECTOR_VERSION, MaterialError, materialAdapterCatalog, materialLimits, validateDeclarations } from '../data-processing/material-inspector/index.js';
import { MANAGED_MATERIAL_RECORDS_SCHEMA, MANAGED_MATERIAL_VIEW_MIGRATION, SHARED_MATERIAL_OBJECTS_SCHEMA } from '../original-storage.js';
import { MANAGED_ORIGINAL_MAX_BYTES, readManagedBytes, readManagedRange, streamManagedOriginal,
  verifyManagedPath, type ManagedOriginalFile } from '../managed-original-file.js';

const MATERIAL_CUSTODY_LIMIT = MANAGED_ORIGINAL_MAX_BYTES;
export const MATERIAL_RUNTIME = 'bd.materials';
export const MATERIAL_OPERATION = 'materials.inspect';
interface InputBinding extends MaterialSubmitInput { materialId: string; filename: string; fileRefVersion: number; mediaType: string; managed?: ManagedOriginalFile }
export interface MaterialServiceOptions {
  database: CoreDatabase;
  tasks(): TaskService;
  files: FileReferenceService;
  resources?: ResourceBindings;
  environment?: MaterialEnvironment;
  limits?: Partial<MaterialLimits>;
  adapters?: readonly MaterialParserAdapter[];
}
const SCHEMA = `
CREATE TABLE material_inputs (
 material_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 binding_json TEXT NOT NULL, binding_digest TEXT NOT NULL, created_at INTEGER NOT NULL
);
${SHARED_MATERIAL_OBJECTS_SCHEMA}
`;

/** 本表只保存输入与材料事实；运行、审批、停止和恢复状态由唯一 TaskService 拥有。 */
export class MaterialService {
  private readonly limits: MaterialLimits;
  private readonly adapters: readonly MaterialParserAdapter[];
  private readonly environment: MaterialEnvironment;
  readonly versionBinding: Record<string, string | null>;

  constructor(private readonly options: MaterialServiceOptions) {
    this.environment = options.environment ?? 'local-review';
    if (!['local-review', 'synthetic-test'].includes(this.environment)) throw new MaterialError('INVALID_MATERIAL_ENVIRONMENT', '材料入口环境无效。');
    this.limits = materialLimits(options.limits);
    this.adapters = (options.adapters ?? DEFAULT_MATERIAL_ADAPTERS).map(adapter => ({ ...adapter, capabilities: structuredClone(adapter.capabilities), parse: adapter.parse.bind(adapter) }));
    this.versionBinding = Object.freeze({ materials: MATERIAL_INSPECTOR_VERSION, environment: this.environment,
      configuration: digest(JSON.stringify({ limits: this.limits, adapters: materialAdapterCatalog(this.adapters) })) });
    options.database.migrate('materials', 1, SCHEMA);
    if (this.db.prepare("SELECT type FROM sqlite_schema WHERE name='material_objects'").get()?.type === 'view') {
      this.enableManagedRecords();
    }
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  catalog() {
    return { environment: this.environment, limits: { ...this.limits }, custodyMaxBytes: MATERIAL_CUSTODY_LIMIT, adapters: materialAdapterCatalog(this.adapters),
      reservedFormats: ['excel', 'pdf', 'image', 'archive'], localOnly: true, automaticIngest: false, computationRegistration: false, versions: { ...this.versionBinding } };
  }

  requestTask(requestId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE runtime_id=? AND request_id=?').get(MATERIAL_RUNTIME, requestKey(requestId));
    return row ? this.tasks.get(String(row.id)) : null;
  }

  submit(input: MaterialSubmitInput, requestId: string, parentTaskId?: string): TaskRecord {
    const normalized = validateInput(input), previous = this.requestTask(requestId);
    if (previous) {
      const binding = this.input(previous.id);
      const original = { fileRefId: binding.fileRefId, category: binding.category, mediaType: binding.mediaType,
        declaredMetadata: binding.declaredMetadata ?? [], ...binding.expectedSha256 ? { expectedSha256: binding.expectedSha256 } : {} };
      if (binding.managed || digestOperationArgs(original) !== digestOperationArgs(normalized) || (previous.parentTaskId ?? undefined) !== parentTaskId) {
        throw new TaskError('REQUEST_CONFLICT', '同一材料请求标识不能用于不同文件、类别、声明或摘要。');
      }
      return previous;
    }
    this.assertDispatch();
    const reference = this.options.files.verify(normalized.fileRefId);
    if (reference.kind !== 'file') throw new MaterialError('NOT_A_FILE', '材料入口只接受已登记普通文件。');
    if (reference.size > MATERIAL_CUSTODY_LIMIT) throw new MaterialError('MATERIAL_BYTE_BUDGET', '原件超过材料入口字节预算。');
    const binding: InputBinding = { ...normalized, materialId: randomUUID(), filename: reference.displayName, fileRefVersion: reference.version };
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      this.assertDispatch();
      accepted = this.tasks.createInTransaction({ title: `材料预览：${reference.displayName}`, ownerRole: 'service', runtimeId: MATERIAL_RUNTIME,
        action: MATERIAL_OPERATION, args: asJson(binding), requestId: requestKey(requestId), parentTaskId,
        versions: { ...this.versionBinding, originalSha256: normalized.expectedSha256 ?? null, fileRefVersion: String(reference.version) } });
      this.db.prepare('INSERT INTO material_inputs VALUES(?,?,?,?,?)')
        .run(binding.materialId, accepted.task.id, JSON.stringify(binding), digestOperationArgs(binding), Date.now());
    });
    this.options.files.link(reference.id, { taskId: accepted.task.id });
    accepted.publish();
    return this.tasks.start(accepted.task.id, accepted.task.version);
  }

  /** Trusted host only: adopt the exact durable file sealed by the HTTP receiver. */
  submitManaged(input: { materialId: string; filename: string; file: ManagedOriginalFile; requestId: string;
    parentTaskId?: string; category?: MaterialCategory; mediaType?: string; declaredMetadata?: MaterialDeclaration[] }): TaskRecord {
    const { materialId, filename, file, requestId, parentTaskId } = input;
    validId(materialId);
    const fields = { category: input.category ?? 'data', mediaType: input.mediaType ?? 'text/csv',
      expectedSha256: file.sha256, declaredMetadata: validateDeclarations(input.declaredMetadata) };
    this.assertManagedSeal(materialId, filename, file);
    const path = verifyManagedPath(this.options.resources, file);
    const previous = this.requestTask(requestId);
    if (previous) {
      const binding = this.input(previous.id);
      const expected = { ...binding, ...fields, materialId, filename, managed: file };
      if (!binding.managed || digestOperationArgs(binding) !== digestOperationArgs(expected) || (previous.parentTaskId ?? undefined) !== parentTaskId) {
        throw new TaskError('REQUEST_CONFLICT', '同一材料请求不能改绑受管原件、声明或父任务。');
      }
      return previous.status === 'ready' ? this.resume(previous.id, previous.version) : previous;
    }
    this.assertDispatch();
    this.enableManagedRecords();
    const existing = this.db.prepare('SELECT task_id FROM material_inputs WHERE material_id=?').get(materialId);
    if (existing) throw new TaskError('REQUEST_CONFLICT', '受管原件已绑定原材料请求；请沿用同一请求号。');
    const { accepted } = this.options.database.transaction(() => {
      this.assertDispatch();
      this.assertManagedSeal(materialId, filename, file);
      verifyManagedPath(this.options.resources, file);
      const reference = this.options.files.registerInTransaction({ path, source: 'generated', displayName: filename });
      if (digestOperationArgs(reference.resource) !== digestOperationArgs(file.resource) || reference.size !== file.byteLength
        || reference.device !== file.device || reference.inode !== file.inode || reference.mtimeNs !== file.mtimeNs) {
        throw new MaterialError('MATERIAL_ORIGINAL_CHANGED', '原件登记与受管固化身份不一致。');
      }
      const binding: InputBinding = { ...validateInput({ fileRefId: reference.id, ...fields }), materialId, filename,
        fileRefVersion: reference.version, managed: file };
      const accepted = this.tasks.createInTransaction({ title: `材料预览：${filename}`, ownerRole: 'service', runtimeId: MATERIAL_RUNTIME,
        action: MATERIAL_OPERATION, args: asJson(binding), requestId: requestKey(requestId), parentTaskId,
        versions: { ...this.versionBinding, originalSha256: file.sha256, fileRefVersion: String(reference.version), originalStorage: 'managed-file/v1' } });
      this.db.prepare('INSERT INTO material_inputs VALUES(?,?,?,?,?)')
        .run(materialId, accepted.task.id, JSON.stringify(binding), digestOperationArgs(binding), Date.now());
      this.options.files.linkInTransaction(reference.id, { taskId: accepted.task.id, artifactId: materialId });
      return { accepted };
    });
    accepted.publish();
    return this.tasks.start(accepted.task.id, accepted.task.version);
  }

  private enableManagedRecords() {
    if (this.db.prepare("SELECT type FROM sqlite_schema WHERE name='material_objects'").get()?.type !== 'view') {
      throw new MaterialError('MANAGED_MATERIAL_SCHEMA', '历史材料物理表需先按既有共享迁移入口核对，批量保管不能隐式转换原件。');
    }
    this.options.database.migrate('managed-material-records', 1, MANAGED_MATERIAL_RECORDS_SCHEMA + MANAGED_MATERIAL_VIEW_MIGRATION);
  }

  private assertManagedSeal(materialId: string, filename: string, file: ManagedOriginalFile): void {
    const row = this.db.prepare('SELECT filename,sealed_json FROM managed_original_receipts WHERE material_id=?').get(materialId);
    if (!row || row.filename !== filename || row.sealed_json !== JSON.stringify(file)) {
      throw new MaterialError('MATERIAL_ORIGINAL_CHANGED', '仅可保管与持久接收凭据完全相符的受管原件。');
    }
  }

  list(limit = 50): MaterialEnvelope[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MaterialError('INVALID_MATERIAL_LIMIT', '材料列表上限须在 1 到 200 之间。');
    const rows = this.db.prepare('SELECT i.material_id FROM material_inputs i JOIN material_objects o ON o.material_id=i.material_id ORDER BY i.created_at DESC,i.material_id LIMIT ?').all(limit);
    return rows.map(row => this.get(String(row.material_id)).envelope);
  }

  /** 有界检索已保管的材料；未完成接收的任务不冒充材料记录。 */
  listPage(options: { query?: string; after?: { createdAt: number; id: string }; limit?: number } = {}) {
    const limit = options.limit ?? 50, query = options.query ?? '', after = options.after;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MaterialError('INVALID_MATERIAL_LIMIT', '材料列表每页须在 1 到 50 条之间。');
    if (typeof query !== 'string' || query.length > 256) throw new MaterialError('INVALID_MATERIAL_SEARCH', '材料查询无效。');
    if (after && (!Number.isSafeInteger(after.createdAt) || typeof after.id !== 'string' || !after.id || after.id.length > 160)) throw new MaterialError('INVALID_CURSOR', '材料列表游标无效。');
    let where = `(instr(lower(json_extract(o.envelope_json,'$.filename')),lower(?))>0
      OR instr(lower(i.material_id),lower(?))>0 OR instr(lower(json_extract(o.envelope_json,'$.category')),lower(?))>0)`;
    const parameters: (string | number)[] = [query, query, query];
    if (after) { where += ' AND (i.created_at<? OR (i.created_at=? AND i.material_id>?))'; parameters.push(after.createdAt, after.createdAt, after.id); }
    const rows = this.db.prepare(`SELECT i.material_id,i.created_at FROM material_inputs i JOIN material_objects o ON o.material_id=i.material_id
      WHERE ${where} ORDER BY i.created_at DESC,i.material_id LIMIT ?`).all(...parameters, limit + 1);
    const visible = rows.slice(0, limit), last = visible.at(-1);
    return { items: visible.map(row => this.get(String(row.material_id)).envelope),
      next: rows.length > limit && last ? { createdAt: Number(last.created_at), id: String(last.material_id) } : null };
  }

  get(materialId: string): MaterialRecord {
    validId(materialId);
    const row = this.db.prepare('SELECT envelope_json,envelope_digest,preview_json,preview_digest FROM material_objects WHERE material_id=?').get(materialId);
    if (!row) throw new MaterialError('MATERIAL_NOT_READY', '材料原件与预览尚未保管完成，或没有此材料身份。');
    const envelopeJson = String(row.envelope_json), previewJson = String(row.preview_json);
    if (digest(envelopeJson) !== row.envelope_digest || digest(previewJson) !== row.preview_digest) throw new MaterialError('MATERIAL_RECORD_CHANGED', '持久材料身份或预览摘要不一致。');
    let envelope: MaterialEnvelope, preview: MaterialPreview;
    try { envelope = JSON.parse(envelopeJson) as MaterialEnvelope; preview = JSON.parse(previewJson) as MaterialPreview; }
    catch { throw new MaterialError('MATERIAL_RECORD_CHANGED', '持久材料记录无法解析。'); }
    if (envelope.materialId !== materialId || envelope.version !== 1 || envelope.localOnly !== true || !/^[a-f0-9]{64}$/u.test(envelope.sha256)
      || (envelope.originalStorage !== undefined && envelope.originalStorage !== 'managed-file/v1')) throw new MaterialError('MATERIAL_RECORD_CHANGED', '持久材料信封身份无效。');
    return structuredClone({ envelope, preview });
  }

  getByTask(taskId: string): MaterialRecord | null {
    this.getTask(taskId);
    const row = this.db.prepare('SELECT i.material_id FROM material_inputs i JOIN material_objects o ON o.material_id=i.material_id WHERE i.task_id=?').get(taskId);
    return row ? this.get(String(row.material_id)) : null;
  }

  /** 只允许受信宿主按材料身份取原件；不会解析任意路径或沿原路径重读。 */
  readOriginal(materialId: string): { bytes: Buffer; filename: string; mediaType: string; sha256: string } {
    const { envelope } = this.get(materialId);
    if (envelope.originalStorage === 'managed-file/v1') {
      const bytes = readManagedBytes(this.options.resources, this.managedFile(envelope));
      return { bytes, filename: envelope.filename, mediaType: envelope.mediaType, sha256: envelope.sha256 };
    }
    const row = this.db.prepare('SELECT original_bytes FROM material_objects WHERE material_id=?').get(materialId)!;
    if (!(row.original_bytes instanceof Uint8Array)) throw new MaterialError('MATERIAL_ORIGINAL_CHANGED', '持久原件不是有效字节。');
    const bytes = Buffer.from(row.original_bytes);
    if (bytes.byteLength !== envelope.byteLength || digest(bytes) !== envelope.sha256) throw new MaterialError('MATERIAL_ORIGINAL_CHANGED', '持久原件与冻结大小或 SHA-256 摘要不一致。');
    return { bytes, filename: envelope.filename, mediaType: envelope.mediaType, sha256: envelope.sha256 };
  }

  /** Only normal completion of this stream validates the whole managed original. */
  async *readOriginalStream(materialId: string): AsyncGenerator<Buffer> {
    const { envelope } = this.get(materialId);
    if (envelope.originalStorage === 'managed-file/v1') {
      yield* streamManagedOriginal(this.options.resources, this.managedFile(envelope));
    } else yield this.readOriginal(materialId).bytes;
  }

  readOriginalRange(materialId: string, offset: number, length: number): Buffer {
    const { envelope } = this.get(materialId);
    return readManagedRange(this.options.resources, this.managedFile(envelope), offset, length);
  }

  private managedFile(envelope: MaterialEnvelope): ManagedOriginalFile {
    const binding = this.input(envelope.taskId), file = binding.managed;
    if (envelope.originalStorage !== 'managed-file/v1' || !file || binding.materialId !== envelope.materialId
      || binding.fileRefId !== envelope.fileRefId || binding.fileRefVersion !== envelope.fileRefVersion
      || file.sha256 !== envelope.sha256 || file.byteLength !== envelope.byteLength || binding.filename !== envelope.filename) {
      throw new MaterialError('MATERIAL_ORIGINAL_CHANGED', '受管保管信封与冻结输入不一致。');
    }
    this.assertManagedSeal(envelope.materialId, envelope.filename, file);
    return file;
  }

  resume(taskId: string, expectedVersion: number): TaskRecord {
    const task = this.getTask(taskId); this.assertBinding(task); this.assertDispatch();
    if (task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请按当前版本明确继续。');
    if (task.status === 'succeeded') return task;
    if (task.status === 'needs_review' || task.requiresReview) throw new TaskError('UNKNOWN_RESULT', '任务结果待核对，不能自动重放。');
    if (task.status === 'ready') return this.tasks.start(taskId, expectedVersion);
    if (task.status === 'paused' || task.status === 'interrupted') return this.tasks.resume(taskId, expectedVersion);
    if (task.status === 'failed' || task.status === 'cancelled') return this.tasks.retry(taskId, expectedVersion);
    throw new TaskError('TASK_BUSY', '当前材料任务尚未收束。');
  }

  readonly runtime: TaskRuntime = { id: MATERIAL_RUNTIME, execute: async context => {
    try {
    this.assertBinding(context.task); this.assertActive(context);
    if (context.task.action !== MATERIAL_OPERATION) throw new TaskError('MATERIAL_OPERATION_DISABLED', '材料运行时只支持只读预览。');
    const binding = this.input(context.task.id), existing = this.getByTask(context.task.id);
    if (existing) {
      if (binding.managed) for await (const block of this.readOriginalStream(binding.materialId)) { this.assertActive(context); void block; }
      else this.readOriginal(binding.materialId);
      return result(existing);
    }
    if (binding.managed) return await this.inspectManaged(context, binding, binding.managed);
    const reference = this.options.files.verify(binding.fileRefId);
    if (reference.version !== binding.fileRefVersion || reference.displayName !== binding.filename) throw new MaterialError('MATERIAL_INPUT_CHANGED', '文件引用版本或材料名称已变化，不能作为原受理版本继续。');
    const operation = { operationId: MATERIAL_OPERATION, operationVersion: 1, argsDigest: digestOperationArgs(binding),
      targets: [{ kind: 'file' as const, path: reference.invocationPath }] };
    const capabilities = [{ action: 'read' as const, target: { kind: 'file' as const, path: reference.invocationPath } }];
    let approvalId: string | undefined;
    try { context.assertAuthorized(operation, capabilities); }
    catch (error) {
      if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
      approvalId = (await context.requestApproval(operation, capabilities)).approvalId ?? undefined;
    }
    this.assertActive(context);
    const bytes = await this.options.files.readBytes(binding.fileRefId, { operation: context.operationScope(operation), approvalId, maxBytes: MATERIAL_CUSTODY_LIMIT });
    this.assertActive(context);
    const sha256 = digest(bytes);
    if (binding.expectedSha256 && sha256 !== binding.expectedSha256) throw new MaterialError('MATERIAL_INPUT_CHANGED', '读取原件与受理时冻结 SHA-256 摘要不同，未继续解析。');
    const preview = inspectMaterial(bytes, { category: binding.category, filename: binding.filename, mediaType: binding.mediaType,
      declaredMetadata: binding.declaredMetadata, limits: this.limits, adapters: this.adapters });
    const envelope: MaterialEnvelope = { materialId: binding.materialId, taskId: context.task.id, category: binding.category, environment: this.environment,
      filename: binding.filename, mediaType: binding.mediaType, byteLength: bytes.byteLength, sha256, version: 1, fileRefId: binding.fileRefId,
      fileRefVersion: binding.fileRefVersion, inspectorVersion: MATERIAL_INSPECTOR_VERSION, adapter: preview.adapter, createdAt: Date.now(), localOnly: true };
    const envelopeJson = JSON.stringify(envelope), previewJson = JSON.stringify(preview);
    this.options.database.transaction(() => {
      this.assertActive(context);
      this.db.prepare('INSERT INTO material_objects VALUES(?,?,?,?,?,?)')
        .run(binding.materialId, envelopeJson, digest(envelopeJson), previewJson, digest(previewJson), bytes);
    });
    await context.emit({ type: 'checkpoint', checkpoint: { materialId: binding.materialId, sha256, version: 1 } });
    return result({ envelope, preview });
    } catch (error) {
      if (error instanceof MaterialError || error instanceof FileReferenceError) throw new TaskError(error.code, error.message);
      throw error;
    }
  } };

  private async inspectManaged(context: TaskExecutionContext, binding: InputBinding, file: ManagedOriginalFile): Promise<TaskResult> {
    this.assertManagedSeal(binding.materialId, binding.filename, file);
    const reference = this.options.files.verify(binding.fileRefId);
    if (reference.version !== binding.fileRefVersion || reference.source !== 'generated' || reference.displayName !== binding.filename
      || digestOperationArgs(reference.resource) !== digestOperationArgs(file.resource)) {
      throw new MaterialError('MATERIAL_INPUT_CHANGED', '受管原件引用与已冻结文件身份不符。');
    }
    // The persisted seal is the authorization boundary for this private HTTP receive copy.
    // This action never opens a caller-provided path or a user-selected original.
    const oversized = file.byteLength > this.limits.maxBytes;
    const bytes = Buffer.alloc(oversized ? Math.min(12, file.byteLength) : file.byteLength);
    let used = 0;
    for await (const chunk of streamManagedOriginal(this.options.resources, file)) {
      this.assertActive(context);
      const copied = chunk.copy(bytes, used, 0, Math.min(chunk.length, bytes.length - used));
      used += copied;
    }
    this.assertActive(context);
    const inspection = { category: binding.category, filename: binding.filename, mediaType: binding.mediaType,
      declaredMetadata: binding.declaredMetadata, limits: this.limits, adapters: this.adapters };
    const preview = oversized ? inspectOversizedMaterial(bytes, file.byteLength, inspection) : inspectMaterial(bytes, inspection);
    const envelope: MaterialEnvelope = { materialId: binding.materialId, taskId: context.task.id, category: binding.category, environment: this.environment,
      filename: binding.filename, mediaType: binding.mediaType, byteLength: file.byteLength, sha256: file.sha256, version: 1, fileRefId: binding.fileRefId,
      fileRefVersion: binding.fileRefVersion, inspectorVersion: MATERIAL_INSPECTOR_VERSION, adapter: preview.adapter, createdAt: Date.now(),
      localOnly: true, originalStorage: 'managed-file/v1' };
    const envelopeJson = JSON.stringify(envelope), previewJson = JSON.stringify(preview);
    this.options.database.transaction(() => {
      this.assertActive(context);
      this.assertManagedSeal(binding.materialId, binding.filename, file);
      verifyManagedPath(this.options.resources, file);
      this.db.prepare('INSERT INTO managed_material_object_records VALUES(?,?,?,?,?)')
        .run(binding.materialId, envelopeJson, digest(envelopeJson), previewJson, digest(previewJson));
    });
    await context.emit({ type: 'checkpoint', checkpoint: { materialId: binding.materialId, sha256: file.sha256, version: 1 } });
    return result({ envelope, preview });
  }

  private input(taskId: string): InputBinding {
    const row = this.db.prepare('SELECT binding_json,binding_digest FROM material_inputs WHERE task_id=?').get(taskId);
    if (!row) throw new MaterialError('MATERIAL_TASK_NOT_FOUND', '没有找到此材料任务输入。');
    const binding = JSON.parse(String(row.binding_json)) as InputBinding;
    if (digestOperationArgs(binding) !== row.binding_digest) throw new MaterialError('MATERIAL_INPUT_CHANGED', '持久受理材料输入摘要已变化。');
    return binding;
  }
  private getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.runtimeId !== MATERIAL_RUNTIME || task.ownerRole !== 'service') throw new MaterialError('MATERIAL_TASK_NOT_FOUND', '此任务不属于材料服务。');
    return task;
  }
  private assertBinding(task: TaskRecord): void {
    for (const [key, value] of Object.entries(this.versionBinding)) if (task.versions[key] !== value) throw new MaterialError('MATERIAL_VERSION_CONFLICT', '材料任务配置或适配器版本已变化，不能静默用新版继续旧任务。');
    const binding = this.input(task.id);
    if (digestOperationArgs(task.args) !== digestOperationArgs(binding)) throw new MaterialError('MATERIAL_INPUT_CHANGED', '任务参数与冻结材料输入不一致。');
    if (task.versions.originalSha256 !== (binding.expectedSha256 ?? null) || task.versions.fileRefVersion !== String(binding.fileRefVersion)
      || (task.versions.originalStorage ?? null) !== (binding.managed ? 'managed-file/v1' : null)) {
      throw new MaterialError('MATERIAL_VERSION_CONFLICT', '任务冻结原件摘要或文件版本不一致。');
    }
  }
  private assertDispatch(): void {
    if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '服务已停止，材料入口不接受新派发。');
  }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted();
    const task = this.tasks.get(context.task.id);
    if (!this.tasks.isRunActive(context.runId, context.generation) || task.currentAttemptId !== context.attemptId || task.runtimeId !== MATERIAL_RUNTIME) {
      throw new TaskError('TASK_NOT_ACTIVE', '材料运行已不再拥有当前任务，未写入迟到结果。');
    }
  }
}

function validateInput(input: MaterialSubmitInput): MaterialSubmitInput & { mediaType: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['fileRefId', 'category', 'mediaType', 'expectedSha256', 'declaredMetadata'].includes(key))) {
    throw new MaterialError('INVALID_MATERIAL_INPUT', '材料入口只接受明确文件引用和材料元数据。');
  }
  validId(input.fileRefId);
  if (!['unclassified', 'data', 'tool'].includes(input.category)) throw new MaterialError('INVALID_MATERIAL_INPUT', '材料接收类别无效。');
  const mediaType = input.mediaType ?? 'application/octet-stream';
  if (typeof mediaType !== 'string' || !mediaType.trim() || mediaType.length > 256 || /[\u0000-\u001f\u007f]/u.test(mediaType)) throw new MaterialError('INVALID_MATERIAL_INPUT', '材料媒体类型无效。');
  if (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedSha256))) throw new MaterialError('INVALID_MATERIAL_INPUT', '原件冻结摘要须为小写 SHA-256。');
  return { fileRefId: input.fileRefId, category: input.category, mediaType, declaredMetadata: validateDeclarations(input.declaredMetadata),
    ...input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {} };
}
function validId(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/u.test(value)) throw new MaterialError('INVALID_MATERIAL_ID', '材料入口须使用受控身份，不接受文件路径。');
}
function requestKey(requestId: string): string { validId(requestId); return `${MATERIAL_OPERATION}:${requestId}`; }
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function result(record: MaterialRecord): TaskResult {
  return { summary: `原件已本地保管，材料只读预览已完成（${record.preview.checks.status}）。`, artifactIds: [record.envelope.materialId],
    data: { materialId: record.envelope.materialId, sha256: record.envelope.sha256, byteLength: record.envelope.byteLength,
      support: record.preview.support, checkStatus: record.preview.checks.status, localOnly: true, formalIngest: false, computationRegistered: false } };
}

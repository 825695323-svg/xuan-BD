import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { posix } from 'node:path';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { CLOUD_EVIDENCE_ROOT, CLOUD_EVIDENCE_TOPICS, CLOUD_MAX_BYTES, CLOUD_ROOT, cloudEvidenceDirectory, cloudPath, type CloudCustodyBackend, type CloudEvidenceTopic, type CloudObject, type CloudSession } from '../../plugins/storage/baidu-drive.js';
import { classifyCloudEvidenceTopic } from './cloud-evidence-classification.js';
import { CloudEvidenceReader, normalizeEvidenceSource, type CloudEvidenceBinding, type CloudEvidenceSource } from './cloud-evidence-source.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { LocalAlgorithmService } from '../financial/algorithm-service.js';
import type { MaterialService } from './materials/service.js';

export const CLOUD_CUSTODY_RUNTIME = 'bd.cloud-custody';
export const CLOUD_CUSTODY_LIMITS = Object.freeze({ maxEntries: 1000, maxPages: 10, pageSize: 100,
  maxReadCandidates: 20, maxReadBytes: 512 * 1024 * 1024, maxObjectBytes: CLOUD_MAX_BYTES });
export interface CloudCustodyInput {
  materialId: string;
  evidenceSource?: CloudEvidenceSource;
  /** 仅查询所选目录的直接子项，不递归扫描。 */
  scopePath: string;
  sourceRemotePath?: string;
  purpose: string;
  authorization: { status: 'authorized'; basis: string };
  /** 缺省只核对名称和元数据；完整下载核证需明确选择。 */
  verifyBytes?: boolean;
  allowUpload?: boolean;
  targetDirectory?: string;
  evidenceTopic?: CloudEvidenceTopic;
}
export interface CloudEvidenceClassification { topic: CloudEvidenceTopic; basis: string; directory: string; purpose: '来源原件' | '加工证据' }
export interface CloudArchiveReference { taskId: string; remoteObject: CloudObject }
type NormalizedInput = CloudCustodyInput & { verifyBytes: boolean; allowUpload: boolean };
type State = 'pending' | 'checking' | 'candidates_found' | 'missing' | 'source_verified' | 'reused_verified' | 'uploading' | 'uploaded_verified' | 'copying' | 'copied_verified' | 'restored_verified' | 'needs_review';
export interface CloudCustodyRecord {
  taskId: string; requestId: string; mode: 'check' | 'restore'; originalTaskId: string | null;
  material: { materialId: string; version: number; filename: string; sha256: string; byteLength: number };
  input: NormalizedInput;
  state: State; remoteObject: CloudObject | null; verifiedSha256: string | null;
  uploadAttempted: boolean; restoredBytesAvailable: boolean;
  evidence?: CloudEvidenceBinding;
  copyAttempted?: boolean;
  writeIntent?: { operation: 'upload' | 'copy'; targetPath: string; source: CloudObject | null };
  evidenceClassification?: CloudEvidenceClassification;
  /** 逻辑主题不改变既有物理对象；关联首次完整核证的保管回执。 */
  archiveReference?: CloudArchiveReference;
  directoryPreparation?: 'pending' | 'ready';
  coverage: { recursive: false; globalExistence: 'unknown'; scopeComplete: boolean; directories: { path: string; complete: boolean }[];
    pages: number; entries: number; skippedDirectories: number; readCandidates: number; readBytes: number };
  candidates: CloudObject[];
  gaps: { code: string; message: string }[];
  updatedAt: number;
}
export interface CloudCustodyView { task: TaskRecord; record: CloudCustodyRecord }
export interface CloudCustodyCapabilities {
  version: string; available: boolean; reason: string | null; registeredRoot: string; evidenceRoot: string;
  evidenceTopics: readonly CloudEvidenceTopic[];
  recursive: false; defaultVerifyBytes: false; limits: typeof CLOUD_CUSTODY_LIMITS;
  versions: Record<string, string | null>;
}
interface Binding { evidence?: CloudEvidenceBinding; requestedInput: NormalizedInput; input: NormalizedInput; material: CloudCustodyRecord['material']; targetPath: string | null; evidenceRoot?: string;
  evidenceClassification?: CloudEvidenceClassification; automaticEvidenceClassification?: { topic: CloudEvidenceTopic; basis: string };
  archiveReference?: CloudArchiveReference;
  mode: 'check' | 'restore'; originalTaskId: string | null; actor: string }
type Row = { task_id: string; request_id: string; binding_json: string; binding_digest: string; record_json: string; record_digest: string;
  upload_started: number; restored_bytes: Uint8Array | null };
type ArchiveRow = Pick<Row, 'task_id' | 'binding_json' | 'binding_digest' | 'record_json' | 'record_digest' | 'upload_started'>;
const ARCHIVE_COLUMNS = 'task_id,binding_json,binding_digest,record_json,record_digest,upload_started';
const SCHEMA = `
CREATE TABLE cloud_custody_requests (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), request_id TEXT NOT NULL UNIQUE, material_id TEXT NOT NULL,
 binding_json TEXT NOT NULL, binding_digest TEXT NOT NULL, record_json TEXT NOT NULL, record_digest TEXT NOT NULL,
 upload_started INTEGER NOT NULL DEFAULT 0, restored_bytes BLOB, created_at INTEGER NOT NULL
);
CREATE INDEX cloud_custody_material ON cloud_custody_requests(material_id,created_at DESC);
CREATE TABLE cloud_custody_audit (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES cloud_custody_requests(task_id),
 event TEXT NOT NULL, facts_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE cloud_custody_upload_claims (
 binding TEXT NOT NULL, scope_path TEXT NOT NULL, sha256 TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES cloud_custody_requests(task_id),
 PRIMARY KEY(binding,scope_path,sha256)
);`;

/** 从已保管原件分支。只新增存储事实与恢复证据，不改来源、加工、R1 或正式金融状态。 */
export class CloudCustodyService {
  readonly versionBinding: Record<string, string | null>;
  private readonly evidence?: CloudEvidenceReader;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; materials: MaterialService;
    files?: FileReferenceService; backend?: CloudCustodyBackend; processing?(): ProcessingPlanService | undefined; algorithms?(): LocalAlgorithmService | undefined }) {
    this.evidence = options.files ? new CloudEvidenceReader({ ...options, files: options.files }) : undefined;
    this.versionBinding = Object.freeze({ cloudCustody: 'bd-cloud-custody/5', ...options.backend?.versionBinding });
    options.database.migrate('cloud_custody', 1, SCHEMA);
    options.database.migrate('cloud_custody_targets', 1, `CREATE TABLE cloud_custody_target_claims (
      binding TEXT NOT NULL, target_path TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES cloud_custody_requests(task_id),
      PRIMARY KEY(binding,target_path)
    );`);
    options.database.migrate('cloud_custody_content', 1, `
      CREATE INDEX cloud_custody_content ON cloud_custody_requests(
        json_extract(binding_json,'$.material.sha256'),json_extract(binding_json,'$.material.byteLength'),created_at);
      CREATE INDEX cloud_custody_claim_content ON cloud_custody_upload_claims(binding,sha256);
    `);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }
  capabilities(): CloudCustodyCapabilities {
    const status = this.options.backend?.availability() ?? { available: false, reason: '网盘字节插件尚未装配。' };
    return { version: 'bd-cloud-custody/5', ...status, reason: status.reason ?? null, registeredRoot: CLOUD_ROOT, evidenceRoot: CLOUD_EVIDENCE_ROOT, evidenceTopics: [...CLOUD_EVIDENCE_TOPICS],
      recursive: false, defaultVerifyBytes: false, limits: { ...CLOUD_CUSTODY_LIMITS }, versions: { ...this.versionBinding } };
  }
  submit(input: unknown, requestId: string): TaskRecord {
    validId(requestId);
    const previous = this.rowByRequest(requestId);
    if (previous) {
      const old = this.binding(previous), normalized = normalize(input, { evidencePolicy: !!old.evidenceRoot, targetDirectory: old.evidenceClassification?.directory ?? old.evidenceRoot });
      if (digestOperationArgs(old.requestedInput) !== digestOperationArgs(normalized) || old.mode !== 'check') {
        throw new TaskError('REQUEST_CONFLICT', '原网盘保管请求已经绑定另一份材料、范围或授权。');
      }
      return this.tasks.get(previous.task_id);
    }
    let normalized = normalize(input, { evidencePolicy: true });
    this.assertDispatch();
    if (!this.capabilities().available) throw new TaskError('CLOUD_UNAVAILABLE', this.capabilities().reason!);
    const original = this.options.materials.readOriginal(normalized.materialId), envelope = this.options.materials.get(normalized.materialId).envelope;
    const evidence = normalized.evidenceSource ? this.evidence?.resolve(normalized.materialId, normalized.evidenceSource).binding : undefined;
    if (normalized.evidenceSource && !evidence) throw new TaskError('CLOUD_EVIDENCE_UNAVAILABLE', '本实例未装配加工证据读取器。');
    const automatic = classifyCloudEvidenceTopic(original.bytes), classification = evidenceClassification(automatic, normalized.evidenceTopic, evidence ? '加工证据' : '来源原件');
    if (normalized.targetDirectory && normalized.targetDirectory !== classification.directory) throw new TaskError('CLOUD_EVIDENCE_ROOT_REQUIRED', '新归档目标必须与本次受控主题及证据用途的目录完全一致，不能指定根目录或其他位置。');
    normalized = { ...normalized, targetDirectory: classification.directory };
    const known = normalized.sourceRemotePath ?? (evidence ? undefined : this.knownSourcePath(normalized.materialId));
    // 只有用户已经选择的目录内可信旧关联可自动带入；其他目录仍需显式选择该文件。
    const effective = !normalized.sourceRemotePath && known && [normalized.scopePath, normalized.targetDirectory].includes(posix.dirname(known))
      ? { ...normalized, sourceRemotePath: known } : normalized;
    return this.create(requestId, { requestedInput: normalized, input: effective, evidenceRoot: CLOUD_EVIDENCE_ROOT,
      evidenceClassification: classification, automaticEvidenceClassification: automatic, ...(evidence ? { evidence } : {}),
      material: { materialId: envelope.materialId, version: envelope.version, filename: evidence?.filename ?? envelope.filename, sha256: evidence?.sha256 ?? original.sha256, byteLength: evidence?.byteLength ?? original.bytes.length },
      targetPath: normalized.allowUpload ? posix.join(normalized.targetDirectory!, `${evidence?.sha256 ?? original.sha256}-${randomUUID()}.${evidence ? 'bd-evidence' : 'bd-original'}`) : null,
      mode: 'check', originalTaskId: null,
      // 审计只需可关联的操作者标识；本机 uid 不进审计出站（4.3 §四）。
      actor: 'local-os:' + createHash('sha256').update(String(userInfo().uid)).digest('hex').slice(0, 8) });
  }
  view(taskId: string): CloudCustodyView {
    const task = this.task(taskId), row = this.row(taskId);
    const record = this.record(row);
    return { task, record };
  }
  listForMaterial(materialId: string) {
    this.options.materials.get(materialId);
    const rows = this.db.prepare('SELECT task_id FROM cloud_custody_requests WHERE material_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(materialId);
    let classification: CloudEvidenceClassification | null = null;
    try { classification = evidenceClassification(classifyCloudEvidenceTopic(this.options.materials.readOriginal(materialId).bytes)); }
    catch { /* 预览缺失不阻断按冻结对象恢复；损坏或丢失原件不据文件名猜主题。 */ }
    return { items: rows.map(row => this.view(String(row.task_id))), knownSourceRemotePath: this.knownSourcePath(materialId), evidenceClassification: classification, evidenceSources: this.evidence?.list(materialId) ?? [] };
  }
  /** 明确创建只读恢复任务；从原目标/原引用取原版本，不重新上传，不覆盖材料原表。 */
  recover(taskId: string, expectedVersion: number, requestId: string): TaskRecord {
    validId(requestId);
    const originalTask = this.task(taskId), old = this.row(taskId), binding = this.binding(old), record = this.record(old);
    const previous = this.rowByRequest(requestId);
    if (previous) {
      if (this.binding(previous).originalTaskId !== taskId || this.binding(previous).mode !== 'restore') throw new TaskError('REQUEST_CONFLICT', '恢复请求已绑定其他原任务。');
      return this.tasks.get(previous.task_id);
    }
    if (!Number.isSafeInteger(expectedVersion) || originalTask.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '原网盘任务已变化，请按当前版本核对。');
    if (['ready', 'running', 'waiting_approval', 'pausing', 'cancelling'].includes(originalTask.status)) throw new TaskError('CLOUD_TASK_BUSY', '请先等待原操作收束，再核对原远端对象。');
    if (!binding.input.verifyBytes) throw new TaskError('CLOUD_READ_AUTHORIZATION_REQUIRED', '原请求仅授权目录与文件名核对；请明确选择完整原件核证后建立新请求。');
    const remotePath = record.archiveReference?.remoteObject.path ?? record.writeIntent?.targetPath
      ?? (record.uploadAttempted || record.copyAttempted ? binding.targetPath : record.remoteObject?.path ?? binding.targetPath);
    if (!remotePath) throw new TaskError('CLOUD_RECOVERY_REFERENCE_REQUIRED', '原请求没有可核对的远端文件身份或独立归档目标；不能猜测恢复来源。');
    for (const key of new Set([...Object.keys(originalTask.versions), ...Object.keys(this.versionBinding)])) {
      if (key !== 'cloudCustody' && originalTask.versions[key] !== this.versionBinding[key]) throw new TaskError('CLOUD_VERSION_CONFLICT', '原网盘连接或账号绑定已变化，不能用新绑定恢复旧对象。');
    }
    this.assertDispatch();
    return this.create(requestId, { ...binding, ...(record.archiveReference ? { archiveReference: record.archiveReference } : {}),
      targetPath: remotePath, input: { ...binding.input, sourceRemotePath: remotePath, allowUpload: false, verifyBytes: true },
      mode: 'restore', originalTaskId: taskId }, record.remoteObject?.path === remotePath ? record.remoteObject : null);
  }
  readRestored(taskId: string) {
    const row = this.row(taskId), binding = this.binding(row), record = this.record(row);
    if (record.state !== 'restored_verified' || !(row.restored_bytes instanceof Uint8Array)) throw new TaskError('CLOUD_RESTORE_NOT_READY', '此任务尚无经过完整核证并持久保存的恢复原件。');
    const bytes = Buffer.from(row.restored_bytes);
    if (bytes.length !== binding.material.byteLength || hash(bytes) !== binding.material.sha256) throw new TaskError('CLOUD_RESTORE_STORAGE_CHANGED', '恢复原件的持久字节与原请求摘要不符。');
    return { bytes, filename: binding.material.filename, sha256: binding.material.sha256 };
  }
  audit(taskId: string) {
    this.row(taskId);
    return this.db.prepare('SELECT sequence,event,facts_json,created_at FROM cloud_custody_audit WHERE task_id=? ORDER BY sequence').all(taskId)
      .map(row => ({ sequence: Number(row.sequence), event: String(row.event), facts: JSON.parse(String(row.facts_json)), createdAt: Number(row.created_at) }));
  }

  readonly runtime: TaskRuntime = { id: CLOUD_CUSTODY_RUNTIME, execute: async context => {
    const row = this.row(context.task.id), binding = this.binding(row), record = this.record(row);
    for (const [key, version] of Object.entries(this.versionBinding)) if (context.task.versions[key] !== version) throw new TaskError('CLOUD_VERSION_CONFLICT', '原网盘保管实现或连接绑定已变化，不能静默改用新配置。');
    if (digestOperationArgs(context.task.args) !== digestOperationArgs(binding)) throw new TaskError('CLOUD_BINDING_CHANGED', '原任务参数与持久保管意图不一致。');
    if (['source_verified', 'reused_verified', 'uploaded_verified', 'copied_verified', 'restored_verified', 'missing', 'candidates_found'].includes(record.state)) return taskResult(record);
    this.assertActive(context);
    let session: CloudSession | undefined;
    let writeIntentPersisted = row.upload_started === 1;
    const checked = new Set<string>(), observed = new Map<string, CloudObject>();
    const save = (event: string, facts: unknown = {}) => { this.save(record); this.append(record.taskId, event, facts); };
    const inspectBytes = async (remote: CloudObject): Promise<Buffer | null> => {
      if (remote.kind !== 'file') throw new TaskError('CLOUD_SOURCE_IS_DIRECTORY', '所选远端线索是目录，不能当作期待文件。');
      if (remote.size !== binding.material.byteLength) return null;
      if (checked.has(remote.path + ':' + remote.id)) return null;
      checked.add(remote.path + ':' + remote.id);
      if (++record.coverage.readCandidates > CLOUD_CUSTODY_LIMITS.maxReadCandidates
        || record.coverage.readBytes + remote.size > CLOUD_CUSTODY_LIMITS.maxReadBytes) throw new TaskError('CLOUD_READ_BUDGET', '同长度候选超过本次下载核证预算，未核范围保持未知。');
      this.assertActive(context);
      const bytes = await session!.read(remote, remote.size);
      this.assertActive(context); record.coverage.readBytes += bytes.length;
      if (bytes.length !== remote.size) throw new TaskError('CLOUD_READBACK_MISMATCH', '远端读回原件长度不一致，不能把失败当作缺失。');
      const sha256 = hash(bytes);
      this.append(record.taskId, 'candidate_readback', { remote, byteLength: bytes.length, sha256, matches: sha256 === binding.material.sha256 });
      return sha256 === binding.material.sha256 ? bytes : null;
    };
    const remember = async (remote: CloudObject): Promise<Buffer | null> => {
      if (remote.kind === 'file' && (remote.size === binding.material.byteLength || posix.basename(remote.path) === binding.material.filename)
        && record.candidates.length < 50 && !record.candidates.some(item => item.path === remote.path)) record.candidates.push(remote);
      return binding.input.verifyBytes ? inspectBytes(remote) : null;
    };
    const scan = async (directory: string, sourcePath?: string): Promise<{ remote: CloudObject; bytes: Buffer | null } | null> => {
      let offset = 0;
      const coverage = { path: directory, complete: false };
      record.coverage.directories.push(coverage);
      if (sourcePath && session!.lookup) {
        if (posix.dirname(cloudPath(sourcePath)) !== directory) throw new TaskError('INVALID_CLOUD_RANGE', '精确目标不在本次指定目录。');
        this.assertActive(context);
        const remote = await session!.lookup(sourcePath);
        this.assertActive(context);
        this.append(record.taskId, 'exact_object_checked', { path: sourcePath, present: remote !== null });
        // One exact object does not establish complete directory coverage.
        if (!remote) return null;
        if (remote.path !== sourcePath || !remote.id || !Number.isSafeInteger(remote.size) || remote.size < 0)
          throw new TaskError('CLOUD_OBJECT_UNVERIFIED', '精确对象的路径、编号或长度无法核对。');
        if (remote.kind !== 'file') throw new TaskError('CLOUD_SOURCE_IS_DIRECTORY', '原网盘文件线索实际指向目录，未下载或上传。');
        observed.set(remote.path, remote); record.coverage.entries++;
        return { remote, bytes: await remember(remote) };
      }
      const paths = new Set<string>();
      while (true) {
        this.assertActive(context);
        if (++record.coverage.pages > CLOUD_CUSTODY_LIMITS.maxPages) throw new TaskError('CLOUD_SCAN_BUDGET', '所选目录超过本次有界分页预算，没有递归或判定全盘缺失。');
        const page = await session!.list(directory, offset, CLOUD_CUSTODY_LIMITS.pageSize);
        if (!Array.isArray(page.items) || page.items.length > CLOUD_CUSTODY_LIMITS.pageSize || typeof page.hasMore !== 'boolean') throw new TaskError('CLOUD_LIST_UNVERIFIED', '目录清单或分页结束事实不可核对。');
        for (const remote of page.items) {
          if (posix.dirname(cloudPath(remote.path)) !== directory || paths.has(remote.path) || !['file', 'directory'].includes(remote.kind)
            || !remote.id || !Number.isSafeInteger(remote.size) || remote.size < 0) throw new TaskError('CLOUD_DIRECTORY_AMBIGUOUS', '目录返回了自身、范围外、重复或类型不明的对象。');
          paths.add(remote.path);
          observed.set(remote.path, remote);
          if (++record.coverage.entries > CLOUD_CUSTODY_LIMITS.maxEntries) throw new TaskError('CLOUD_SCAN_BUDGET', '所选目录超过本次条目预算，未扫描范围保持未知。');
          if (sourcePath) {
            if (remote.path !== sourcePath) continue;
            if (remote.kind !== 'file') throw new TaskError('CLOUD_SOURCE_IS_DIRECTORY', '原网盘文件线索实际指向目录，未下载或上传。');
            return { remote, bytes: await remember(remote) };
          }
          if (remote.kind === 'directory') { record.coverage.skippedDirectories++; continue; }
          const bytes = await remember(remote);
          if (bytes) return { remote, bytes };
        }
        if (!page.hasMore) { coverage.complete = true; return null; }
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! <= offset || !page.items.length) throw new TaskError('CLOUD_LIST_UNVERIFIED', '分页游标无进度，不能证明所选目录已读完。');
        offset = page.nextOffset!;
      }
    };
    const accept = (remote: CloudObject, bytes: Buffer) => {
      this.assertActive(context);
      record.remoteObject = remote; record.verifiedSha256 = hash(bytes);
      record.state = binding.mode === 'restore' ? 'restored_verified'
        : !record.archiveReference && binding.evidenceRoot && posix.dirname(remote.path) !== (binding.evidenceClassification?.directory ?? binding.evidenceRoot) ? 'source_verified' : 'reused_verified';
      record.gaps = record.state === 'source_verified' ? [{ code: 'CLOUD_SOURCE_NOT_ARCHIVED', message: '来源原件已完整核证，但尚未存入专用证据盘；归档需要另外明确授权复制。' }] : [];
      record.restoredBytesAvailable = binding.mode === 'restore';
      this.options.database.transaction(() => {
        this.assertActive(context);
        if (binding.mode === 'restore') this.db.prepare('UPDATE cloud_custody_requests SET restored_bytes=? WHERE task_id=?').run(bytes, record.taskId);
        this.save(record); this.append(record.taskId, record.state, { remote, sha256: record.verifiedSha256, byteLength: bytes.length });
      });
      if (binding.mode === 'restore') this.readRestored(record.taskId);
    };
    const reuseArchive = async (reference: CloudArchiveReference): Promise<TaskResult> => {
      this.assertActive(context);
      record.archiveReference = reference; record.remoteObject = reference.remoteObject;
      save('archive_reference_frozen', { reference });
      if (session) { await session.close(); session = undefined; }
      // 仅为明确归档或原引用恢复打开这一件已登记对象，不把其他主题加入目录扫描。
      session = await this.options.backend!.open(context, { ...binding.input,
        sourceRemotePath: reference.remoteObject.path, verifyBytes: true, allowUpload: false });
      const bytes = await inspectBytes(reference.remoteObject);
      if (!bytes) throw new TaskError('CLOUD_ARCHIVE_REFERENCE_UNVERIFIED', '已登记证据盘对象的完整字节与原摘要不符；保留原引用，不复制或上传替代品。');
      accept(reference.remoteObject, bytes);
      this.append(record.taskId, 'archive_reference_verified', { reference, sha256: record.verifiedSha256 });
      return taskResult(record);
    };
    try {
      // 恢复使用冻结的请求摘要；即使本地工作副本丢失也不回写/替换材料原表。
      const evidenceBytes = binding.mode === 'check' && binding.evidence ? await this.evidence!.read(binding.evidence, context) : null;
      const local = binding.mode === 'check' ? evidenceBytes ? { bytes: evidenceBytes, sha256: hash(evidenceBytes) } : this.options.materials.readOriginal(binding.material.materialId) : null;
      if (local && (local.sha256 !== binding.material.sha256 || local.bytes.length !== binding.material.byteLength)) throw new TaskError('CLOUD_ORIGINAL_CHANGED', '已保管原件与冻结请求的版本不符。');
      const alreadyStarted = row.upload_started === 1;
      const archiveDirectory = binding.evidenceClassification?.directory;
      if (record.archiveReference) return await reuseArchive(record.archiveReference);
      if (binding.mode === 'check' && binding.input.allowUpload && binding.input.verifyBytes) {
        const reference = this.verifiedArchive(binding.material);
        if (reference) return await reuseArchive(reference);
        this.assertContentUnclaimed(binding.material.sha256);
      }
      if (binding.mode === 'check' && binding.input.allowUpload && !alreadyStarted
        && (binding.evidenceRoot !== CLOUD_EVIDENCE_ROOT || !binding.evidenceClassification
          || archiveDirectory !== cloudEvidenceDirectory(binding.evidenceClassification.topic, binding.evidence ? '加工证据' : '来源原件')
          || binding.input.targetDirectory !== archiveDirectory || !binding.targetPath || posix.dirname(binding.targetPath) !== archiveDirectory)) {
        throw new TaskError('CLOUD_EVIDENCE_ROOT_REQUIRED', '旧网盘意图不能继续向原目录新增写入；请另建专用证据盘归档请求，旧对象仍按原引用只读恢复。');
      }
      record.state = 'checking'; save('check_started', { mode: binding.mode, actor: binding.actor });
      session = await this.options.backend!.open(context, { ...binding.input, allowUpload: binding.input.allowUpload && !alreadyStarted && binding.mode === 'check' });
      if (binding.mode === 'restore' || alreadyStarted) {
        const source = binding.mode === 'restore' ? binding.targetPath : record.writeIntent?.targetPath ?? binding.targetPath;
        const found = source ? await scan(posix.dirname(source), source) : null;
        if (found?.bytes) {
          if (record.remoteObject && record.remoteObject.id !== found.remote.id) throw new TaskError('CLOUD_OBJECT_CHANGED', '原远端文件编号已变化，不能改指同名另一对象完成恢复。');
          accept(found.remote, found.bytes); return taskResult(record);
        }
        throw new TaskError('CLOUD_RECOVERY_UNVERIFIED', '原目标或原版本尚未取得完整一致的字节；保留未决事实，不重新复制或上传。');
      }
      // 新请求先核专用证据盘；来源相同字节只作为复制依据，不冒充已经单独归档。
      const archiveExists = archiveDirectory ? await session.prepareDirectory(archiveDirectory, false) : false;
      if (archiveDirectory) this.append(record.taskId, 'archive_directory_checked', { directory: archiveDirectory, exists: archiveExists });
      if (archiveDirectory && archiveExists) {
        const found = await scan(archiveDirectory);
        if (found?.bytes) { accept(found.remote, found.bytes); return taskResult(record); }
      }
      let sourceMatch: { remote: CloudObject; bytes: Buffer | null } | null = null;
      if (binding.input.sourceRemotePath) sourceMatch = await scan(posix.dirname(binding.input.sourceRemotePath), binding.input.sourceRemotePath);
      if (!sourceMatch?.bytes && binding.input.scopePath !== binding.evidenceRoot && binding.input.scopePath !== archiveDirectory) sourceMatch = await scan(binding.input.scopePath);
      if (sourceMatch?.bytes && (!binding.evidenceRoot || !binding.input.allowUpload)) {
        accept(sourceMatch.remote, sourceMatch.bytes); return taskResult(record);
      }
      record.coverage.scopeComplete = record.coverage.directories.some(item => item.path === binding.input.scopePath && item.complete);
      if (!binding.input.verifyBytes) {
        record.state = record.candidates.length ? 'candidates_found' : 'needs_review';
        record.gaps = [{ code: 'CLOUD_CONTENT_NOT_CHECKED', message: '本次只核对所选目录直接子项的名称和元数据；没有下载原件核证，其他目录和同字节原件是否存在仍未知。' }];
        save('names_checked'); return taskResult(record);
      }
      const copySource = sourceMatch?.bytes ? sourceMatch.remote : null;
      if (!copySource) {
        if (record.coverage.skippedDirectories) throw new TaskError('CLOUD_SUBDIRECTORIES_NOT_CHECKED', '所选目录含未扫描的子目录；未递归、未判定全盘缺失，也不上传。请选择包含原件的具体目录或文件。');
        record.state = 'missing'; save('missing_in_selected_directories');
        if (!binding.input.allowUpload) return taskResult(record);
      }
      const operation = copySource ? 'copy' : 'upload';
      const targetPath = copySource ? posix.join(archiveDirectory!, posix.basename(copySource.path)) : binding.targetPath!;
      if (binding.evidenceRoot !== CLOUD_EVIDENCE_ROOT || !archiveDirectory || binding.input.targetDirectory !== archiveDirectory
        || posix.dirname(targetPath) !== archiveDirectory) throw new TaskError('CLOUD_EVIDENCE_ROOT_REQUIRED', '新归档只能写入本次冻结主题及证据用途的目录，不能回写来源目录。');
      if (observed.has(targetPath)) throw new TaskError('CLOUD_TARGET_CONFLICT', '证据盘已有同名对象且未核证为相同内容；保留来源与冲突对象，不覆盖、改名或从本地重传。');
      if (record.coverage.readCandidates >= CLOUD_CUSTODY_LIMITS.maxReadCandidates
        || record.coverage.readBytes + binding.material.byteLength > CLOUD_CUSTODY_LIMITS.maxReadBytes) throw new TaskError('CLOUD_READ_BUDGET', '剩余预算不能完成归档后的完整读回核证，本次不写入。');
      this.assertActive(context);
      this.assertContentUnclaimed(binding.material.sha256);
      this.options.database.transaction(() => {
        this.db.prepare('UPDATE cloud_custody_requests SET upload_started=1 WHERE task_id=?').run(record.taskId);
        record.writeIntent = { operation, targetPath, source: copySource };
        record.directoryPreparation = archiveExists ? 'ready' : 'pending'; this.save(record);
        this.append(record.taskId, operation + '_intent_persisted', { ...record.writeIntent, actor: binding.actor, purpose: binding.input.purpose });
      });
      writeIntentPersisted = true;
      const effectId = randomUUID();
      await context.emit({ type: 'side_effect_started', effectId, description: operation === 'copy' ? '将已核证来源复制进专用证据盘' : '上传本次明确授权的独立原件保管副本',
        operation: { handoffId: record.taskId, requestId: record.requestId, targetPath, sha256: binding.material.sha256, ...(copySource ? { source: json(copySource) } : {}) } });
      if (!archiveExists) {
        if (!await session.prepareDirectory(archiveDirectory, true)) throw new TaskError('CLOUD_DIRECTORY_UNVERIFIED', '本次归档目录尚未核实创建完成；保留原目录与原对象意图，只读恢复。');
        this.assertActive(context); record.directoryPreparation = 'ready'; save('archive_directory_ready', { directory: archiveDirectory });
      }
      this.assertActive(context);
      // 文件占位只在目录就绪后取得；同内容覆盖所有主题，并兼容旧叶目录占位。
      let concurrentArchive: CloudArchiveReference | null = null;
      this.options.database.transaction(() => {
        concurrentArchive = this.verifiedArchive(binding.material);
        if (concurrentArchive) return;
        this.assertContentUnclaimed(binding.material.sha256);
        const connection = this.claimBinding(), legacyConnection = this.versionBinding.cloudConnection ?? this.versionBinding.cloudBinding ?? '';
        const targetClaims = this.db.prepare('SELECT task_id FROM cloud_custody_target_claims WHERE binding IN (?,?) AND target_path=?').all(connection, legacyConnection, targetPath);
        if (targetClaims.some(claim => this.sameCloudBinding(this.tasks.get(String(claim.task_id)).versions)))
          throw new TaskError('CLOUD_TARGET_CLAIMED', '证据盘同名目标已有文件归档意图；先沿原请求核对，不能并发覆盖或改走本地上传。');
        this.db.prepare('INSERT INTO cloud_custody_upload_claims VALUES(?,?,?,?)').run(connection, CLOUD_EVIDENCE_ROOT, binding.material.sha256, record.taskId);
        this.db.prepare('INSERT INTO cloud_custody_target_claims VALUES(?,?,?)').run(connection, targetPath, record.taskId);
        record.uploadAttempted = operation === 'upload'; record.copyAttempted = operation === 'copy';
        record.state = operation === 'copy' ? 'copying' : 'uploading'; this.save(record); this.append(record.taskId, operation + '_started', { targetPath });
      });
      if (concurrentArchive) return await reuseArchive(concurrentArchive);
      const written = copySource ? await session.copy(copySource, archiveDirectory) : await session.put(local!.bytes, targetPath);
      this.assertActive(context);
      if (written.path !== targetPath || written.kind !== 'file' || written.size !== binding.material.byteLength) throw new TaskError('CLOUD_WRITE_UNKNOWN_RESULT', '远端归档回执没有绑定本次独立文件，不能确认完成。');
      record.remoteObject = written; save(operation + '_receipt_observed', { remote: record.remoteObject });
      // 复制和上传都须实际从远端重新下载原字节，不能由退出码、同名或 MD5 代替 SHA-256 核证。
      const bytes = await inspectBytes(record.remoteObject);
      if (!bytes) throw new TaskError('CLOUD_WRITE_UNKNOWN_RESULT', '归档后的实际远端原件与冻结 SHA-256 不符。');
      this.assertActive(context);
      record.state = operation === 'copy' ? 'copied_verified' : 'uploaded_verified'; record.verifiedSha256 = hash(bytes);
      save(record.state, { remote: record.remoteObject, sha256: record.verifiedSha256 });
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '明确独立目标的远端编号及完整原件 SHA-256 读回已核对。' });
      return taskResult(record);
    } catch (error) {
      const known = error instanceof TaskError;
      record.state = 'needs_review'; record.gaps = [{ code: known ? error.code : 'CLOUD_CHECK_UNVERIFIED', message: known ? error.message : '本次网盘核对没有取得可验证结果；未核范围保持未知。' }];
      save('needs_review', { gaps: record.gaps, uploadAttempted: record.uploadAttempted, copyAttempted: record.copyAttempted === true });
      if (writeIntentPersisted || context.signal.aborted) throw new TaskError('CLOUD_UPLOAD_PENDING', '原网盘操作已停止或结果待核；请沿原请求恢复核对，不重复建目录、复制或上传。');
      return taskResult(record);
    } finally { if (session) await session.close(); }
  } };

  private create(requestId: string, binding: Binding, remote: CloudObject | null = null): TaskRecord {
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      this.assertDispatch();
      accepted = this.tasks.createInTransaction({ title: binding.mode === 'restore' ? `网盘原件恢复：${binding.material.filename}` : `原件网盘核对：${binding.material.filename}`,
        ownerRole: 'service', runtimeId: CLOUD_CUSTODY_RUNTIME, action: binding.mode === 'restore' ? 'cloud.custody.restore' : 'cloud.custody.check',
        args: json(binding), requestId: `cloud.custody:${requestId}`, versions: { ...this.versionBinding },
        ...(binding.originalTaskId ? { parentTaskId: binding.originalTaskId } : {}) });
      const record: CloudCustodyRecord = { taskId: accepted.task.id, requestId, mode: binding.mode, originalTaskId: binding.originalTaskId,
        material: binding.material, input: binding.input, ...(binding.evidence ? { evidence: binding.evidence } : {}), state: 'pending', remoteObject: remote, verifiedSha256: null, uploadAttempted: false, copyAttempted: false,
        ...(binding.evidenceClassification ? { evidenceClassification: binding.evidenceClassification } : {}),
        ...(binding.archiveReference ? { archiveReference: binding.archiveReference } : {}),
        restoredBytesAvailable: false, candidates: [], gaps: [], updatedAt: Date.now(),
        coverage: { recursive: false, globalExistence: 'unknown', scopeComplete: false, directories: [], pages: 0, entries: 0, skippedDirectories: 0, readCandidates: 0, readBytes: 0 } };
      const recordJson = JSON.stringify(record);
      this.db.prepare('INSERT INTO cloud_custody_requests(task_id,request_id,material_id,binding_json,binding_digest,record_json,record_digest,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(accepted.task.id, requestId, binding.material.materialId, JSON.stringify(binding), digestOperationArgs(binding), recordJson, hash(recordJson), Date.now());
      this.append(accepted.task.id, 'accepted', { actor: binding.actor, purpose: binding.input.purpose, material: binding.material, input: binding.input });
    });
    accepted.publish();
    return this.tasks.start(accepted.task.id, accepted.task.version);
  }
  private knownSourcePath(materialId: string): string | null {
    const material = this.options.materials.get(materialId).envelope;
    const rows = this.db.prepare(`SELECT ${ARCHIVE_COLUMNS} FROM cloud_custody_requests WHERE material_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`)
      .iterate(materialId) as unknown as Iterable<ArchiveRow>;
    for (const row of rows) {
      const record = this.record(row);
      if (record.remoteObject && record.verifiedSha256 === material.sha256) return record.remoteObject.path;
    }
    try {
      const file = this.options.files?.getRef(material.fileRefId);
      for (const relation of file?.relations ?? []) {
        if (relation.kind !== 'task') continue;
        const task = this.tasks.get(relation.id), args = task.args as Record<string, JsonValue>, data = task.result?.data as Record<string, JsonValue> | undefined;
        if (task.action === 'baidu.drive' && task.status === 'succeeded' && args.operation === 'download'
          && task.result?.artifactIds?.includes(file!.id) && data?.fileRefId === file!.id && data?.sha256 === material.sha256) return cloudPath(args.path);
      }
    } catch { /* 没有可核对来源关系时保持未知，不从本机文件名猜远端位置。 */ }
    return null;
  }
  /** 内容只索引既有账本；跨主题候选还须核同账号绑定、证据盘位置与完整核证回执。 */
  private verifiedArchive(material: CloudCustodyRecord['material']): CloudArchiveReference | null {
    const rows = this.db.prepare(`SELECT ${ARCHIVE_COLUMNS} FROM cloud_custody_requests
      WHERE json_extract(binding_json,'$.material.sha256')=? AND json_extract(binding_json,'$.material.byteLength')=?
      ORDER BY created_at,rowid`).iterate(material.sha256, material.byteLength) as unknown as Iterable<ArchiveRow>;
    for (const row of rows) {
      const task = this.tasks.get(row.task_id);
      if (task.status !== 'succeeded' || !this.sameCloudBinding(task.versions)) continue;
      const binding = this.binding(row), record = this.record(row), remote = record.remoteObject;
      if (binding.evidenceRoot !== CLOUD_EVIDENCE_ROOT || record.verifiedSha256 !== material.sha256
        || !['reused_verified', 'uploaded_verified', 'copied_verified', 'restored_verified'].includes(record.state)
        || !remote || remote.kind !== 'file' || remote.size !== material.byteLength || !remote.id
        || !remote.path.startsWith(CLOUD_EVIDENCE_ROOT + '/')) continue;
      if (record.state === 'restored_verified' && !this.managedRestore(binding, remote, material.sha256)) continue;
      return { taskId: record.archiveReference?.taskId ?? record.taskId, remoteObject: remote };
    }
    return null;
  }
  /** 只读来源即使位于证据根内，也不能靠恢复状态升格；恢复须沿原受管回执/已发文件目标核对。 */
  private managedRestore(binding: Binding, remote: CloudObject, sha256: string): boolean {
    const seen = new Set<string>();
    let originalTaskId = binding.originalTaskId;
    while (originalTaskId && !seen.has(originalTaskId)) {
      seen.add(originalTaskId);
      const row = this.db.prepare(`SELECT ${ARCHIVE_COLUMNS} FROM cloud_custody_requests WHERE task_id=?`).get(originalTaskId) as ArchiveRow | undefined;
      if (!row || !this.sameCloudBinding(this.tasks.get(originalTaskId).versions)) return false;
      const originalBinding = this.binding(row), original = this.record(row);
      if (originalBinding.mode === 'restore') { originalTaskId = originalBinding.originalTaskId; continue; }
      if (originalBinding.evidenceRoot !== CLOUD_EVIDENCE_ROOT) return false;
      if (['reused_verified', 'uploaded_verified', 'copied_verified'].includes(original.state)
        && original.verifiedSha256 === sha256 && original.remoteObject?.id === remote.id && original.remoteObject.path === remote.path) return true;
      return row.upload_started === 1 && originalBinding.input.allowUpload && (original.uploadAttempted || original.copyAttempted === true)
        && (original.writeIntent?.targetPath ?? originalBinding.targetPath) === remote.path;
    }
    return false;
  }
  private sameCloudBinding(versions: Record<string, string | null>): boolean {
    if (!(this.versionBinding.cloudConnection || this.versionBinding.cloudBinding)) return false;
    return [...new Set([...Object.keys(versions), ...Object.keys(this.versionBinding)])]
      .every(key => key === 'cloudCustody' || versions[key] === this.versionBinding[key]);
  }
  private assertContentUnclaimed(sha256: string): void {
    const connection = this.claimBinding(), legacyConnection = this.versionBinding.cloudConnection ?? this.versionBinding.cloudBinding ?? '';
    const claims = this.db.prepare('SELECT task_id FROM cloud_custody_upload_claims WHERE binding IN (?,?) AND sha256=?').all(connection, legacyConnection, sha256);
    for (const claim of claims) {
      if (this.sameCloudBinding(this.tasks.get(String(claim.task_id)).versions)) {
        throw new TaskError('CLOUD_PREVIOUS_UPLOAD_PENDING', `同内容已有文件归档意图（${claim.task_id}）；请沿原请求核对，不能按其他主题或新编号重复复制或上传。`);
      }
    }
  }
  private claimBinding(): string {
    return digestOperationArgs(Object.fromEntries(Object.entries(this.versionBinding).filter(([key]) => key !== 'cloudCustody')));
  }
  private row(taskId: string): Row {
    validId(taskId);
    const row = this.db.prepare('SELECT * FROM cloud_custody_requests WHERE task_id=?').get(taskId) as Row | undefined;
    if (!row) throw new TaskError('CLOUD_TASK_NOT_FOUND', '没有这条独立网盘保管请求。');
    return row;
  }
  private rowByRequest(requestId: string): Row | undefined { return this.db.prepare('SELECT * FROM cloud_custody_requests WHERE request_id=?').get(requestId) as Row | undefined; }
  private task(taskId: string) { const task = this.tasks.get(taskId); if (task.runtimeId !== CLOUD_CUSTODY_RUNTIME) throw new TaskError('CLOUD_TASK_NOT_FOUND', '此任务不属于网盘保管支路。'); return task; }
  private binding(row: Pick<Row, 'binding_json' | 'binding_digest'>): Binding { const binding = JSON.parse(row.binding_json) as Binding; if (digestOperationArgs(binding) !== row.binding_digest) throw new TaskError('CLOUD_BINDING_CHANGED', '持久网盘意图摘要不一致。'); return binding; }
  private record(row: Pick<Row, 'record_json' | 'record_digest'>): CloudCustodyRecord { if (hash(row.record_json) !== row.record_digest) throw new TaskError('CLOUD_RECORD_CHANGED', '持久网盘核对记录摘要不一致。'); return JSON.parse(row.record_json) as CloudCustodyRecord; }
  private save(record: CloudCustodyRecord) { record.updatedAt = Date.now(); const value = JSON.stringify(record); this.db.prepare('UPDATE cloud_custody_requests SET record_json=?,record_digest=? WHERE task_id=?').run(value, hash(value), record.taskId); }
  private append(taskId: string, event: string, facts: unknown) { this.db.prepare('INSERT INTO cloud_custody_audit(task_id,event,facts_json,created_at) VALUES(?,?,?,?)').run(taskId, event, JSON.stringify(facts), Date.now()); }
  private assertDispatch() { if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '本服务已停止新增派发。'); }
  private assertActive(context: TaskExecutionContext) {
    context.signal.throwIfAborted();
    if (!this.tasks.isRunActive(context.runId, context.generation) || this.tasks.get(context.task.id).currentAttemptId !== context.attemptId) throw new TaskError('CLOUD_TASK_STOPPED', '原网盘尝试已不再拥有写入结果的权限。');
  }
}
function normalize(input: unknown, options: { evidencePolicy?: boolean; targetDirectory?: string } = {}): NormalizedInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['materialId', 'scopePath', 'sourceRemotePath', 'purpose', 'authorization', 'verifyBytes', 'allowUpload', 'targetDirectory', 'evidenceTopic', 'evidenceSource'].includes(key))) throw new TaskError('INVALID_CLOUD_INPUT', '网盘保管只接受已保管材料、明确目录/文件线索、受控主题、本次用途和授权。');
  const value = input as Record<string, unknown>; validId(value.materialId);
  const evidenceSource = normalizeEvidenceSource(value.evidenceSource);
  const scopePath = cloudPath(value.scopePath), auth = value.authorization;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).some(key => !['status', 'basis'].includes(key))
    || (auth as Record<string, unknown>).status !== 'authorized' || !text((auth as Record<string, unknown>).basis, 1000)
    || /^(authorized|已授权|授权|同意|允许|true|yes|ok)$/iu.test(String((auth as Record<string, unknown>).basis).trim())
    || !text(value.purpose, 500)) throw new TaskError('CLOUD_AUTHORIZATION_REQUIRED', '需要明确的本次用途及具体授权依据；来源链接或纯状态词不能授予网盘访问。');
  for (const key of ['verifyBytes', 'allowUpload']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TaskError('INVALID_CLOUD_INPUT', '下载核证和上传必须使用明确的布尔选择。');
  const verifyBytes = value.verifyBytes === true, allowUpload = value.allowUpload === true;
  const sourceRemotePath = value.sourceRemotePath === undefined ? undefined : cloudPath(value.sourceRemotePath);
  let targetDirectory = value.targetDirectory === undefined ? undefined : cloudPath(value.targetDirectory);
  if (value.evidenceTopic !== undefined && !CLOUD_EVIDENCE_TOPICS.includes(value.evidenceTopic as CloudEvidenceTopic)) throw new TaskError('INVALID_CLOUD_INPUT', '证据主题必须是登记的中文分类，不接受自由路径或未登记主题。');
  if (options.targetDirectory) {
    if (targetDirectory && targetDirectory !== options.targetDirectory) throw new TaskError('CLOUD_EVIDENCE_ROOT_REQUIRED', '新归档只能使用本次冻结主题及证据用途的目录，不能指定其他位置。');
    targetDirectory = options.targetDirectory;
  }
  if (allowUpload && (!verifyBytes || !options.evidencePolicy && !targetDirectory)) throw new TaskError('CLOUD_UPLOAD_AUTHORIZATION_REQUIRED', '归档需要另外明确选择完整字节核证和专用证据盘写入授权。');
  return { materialId: String(value.materialId), scopePath, purpose: String(value.purpose).trim(), authorization: { status: 'authorized', basis: String((auth as Record<string, unknown>).basis).trim() },
    verifyBytes, allowUpload, ...(evidenceSource ? { evidenceSource } : {}), ...(sourceRemotePath ? { sourceRemotePath } : {}), ...(targetDirectory ? { targetDirectory } : {}),
    ...(value.evidenceTopic !== undefined ? { evidenceTopic: value.evidenceTopic as CloudEvidenceTopic } : {}) };
}
function evidenceClassification(automatic: { topic: CloudEvidenceTopic; basis: string }, selected?: CloudEvidenceTopic, purpose: CloudEvidenceClassification['purpose'] = '来源原件'): CloudEvidenceClassification {
  const topic = selected ?? automatic.topic;
  return { topic, basis: selected ? `操作者按本次授权明确指定主题“${selected}”；自动判定为“${automatic.topic}”：${automatic.basis}` : automatic.basis,
    directory: cloudEvidenceDirectory(topic, purpose), purpose };
}
function validId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) throw new TaskError('INVALID_CLOUD_ID', '网盘保管需要受控材料和请求身份，不接收本机文件路径。'); }
function text(value: unknown, limit: number) { return typeof value === 'string' && value.trim().length >= 3 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value); }
function hash(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function taskResult(record: CloudCustodyRecord): TaskResult {
  const summaries: Record<State, string> = { pending: '网盘核对已受理。', checking: '网盘核对进行中。', candidates_found: '已找到名称或长度候选；尚未下载核证原件。',
    missing: '本次分类归档目录及明确所选来源中未发现同字节原件；未扫描其他主题或推断其他目录。', source_verified: '来源原件通过完整 SHA-256 核证，尚未归档到证据盘。', reused_verified: '已有网盘原件通过完整 SHA-256 读回，已复用；未上传。',
    uploading: '已持久登记上传意图，远端结果待核对。', uploaded_verified: '新保管副本已上传并从远端完整读回核证。',
    copying: '已持久登记原网盘来源与证据盘目标，复制结果待核对。', copied_verified: '原网盘来源已复制到专用证据盘，并从目标完整读回核证。',
    restored_verified: '已按原远端引用恢复完整原件，并独立持久保存、读回核证。', needs_review: '网盘存在性或原件保管结果仍待核对；未核范围保持未知。' };
  return { summary: summaries[record.state], data: { state: record.state, materialId: record.material.materialId,
    sha256: record.material.sha256, remoteObject: json(record.remoteObject), uploadAttempted: record.uploadAttempted, copyAttempted: record.copyAttempted === true,
    restoredBytesAvailable: record.restoredBytesAvailable, ...(record.archiveReference ? { archiveReference: json(record.archiveReference) } : {}), globalExistence: 'unknown' } };
}

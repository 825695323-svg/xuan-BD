import { createHash } from 'node:crypto';
import { basename, dirname, posix } from 'node:path';
import { root } from '@openclaw/fs-safe';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService, FileReference } from '../../platform/resources/files.js';
import { TaskError, type TaskExecutionContext, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { inspectPath, samePathIdentity } from '../../platform/security/permissions.js';
import { acquireAuthority, fileCapability } from '../../platform/runtime/file-workspace.js';
import { cloudEvidenceDirectory, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';

const SCHEMA = [
  'CREATE TABLE artifact_local_releases (',
  ' source_task_id TEXT NOT NULL, file_ref_id TEXT NOT NULL, file_version INTEGER NOT NULL,',
  ' source_sha256 TEXT NOT NULL, remote_path TEXT NOT NULL, local_identity_json TEXT NOT NULL,',
  " state TEXT NOT NULL CHECK(state IN ('pending','released')), started_at INTEGER NOT NULL,",
  ' completed_at INTEGER, PRIMARY KEY(source_task_id,file_ref_id)',
  ');',
].join('\n');
type Input = { sourceTaskId: string; fileRefId: string; expectedSha256?: string };
type Receipt = { source_task_id: string; file_ref_id: string; file_version: number; sha256: string;
  byte_length: number; target_path: string; topic: string; purpose: string;
  binding_json: string; state: string; remote_id: string | null };
type ReleaseRow = { source_task_id: string; file_ref_id: string; file_version: number;
  source_sha256: string; remote_path: string; local_identity_json: string;
  state: 'pending' | 'released'; started_at: number; completed_at: number | null };
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/u.test(value);
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** 失败封闭的旧引用守卫：不基于文件年龄、后缀或“已上传”判断可以删除。 */
export function artifactReleaseBlockers(db: CoreDatabase, files: FileReferenceService,
  sourceTaskId: string, reference: FileReference, artifactRoot: string): string[] {
  const blockers: string[] = [], connection = db.connection, fileRefId = reference.id;
  if (reference.source !== 'generated' || reference.kind !== 'file' || reference.resource
    || dirname(reference.invocationPath) !== artifactRoot
    || reference.identity.links.length > 0) blockers.push('not-owned-artifact-root');
  if (!reference.relations.some(item => item.kind === 'task' && item.id === sourceTaskId))
    blockers.push('source-task-relation-missing');
  if (reference.relations.some(item => item.kind === 'conversation'
      || item.kind === 'task' && item.id !== sourceTaskId
      || item.kind === 'artifact' && item.id !== fileRefId))
    blockers.push('other-file-relations');
  if (connection.prepare('SELECT id FROM file_references WHERE id<>? AND (invocation_path=? OR json_extract(metadata,\'$.canonicalPath\')=?) LIMIT 1')
    .get(fileRefId, reference.invocationPath, reference.canonicalPath))
    blockers.push('other-path-references');
  // 只有归档、元数据查询和恢复动作不构成独立消费端；其他任务均保守判定为依赖。
  const used = connection.prepare([
    'SELECT id FROM tasks WHERE id<>? AND action NOT IN',
    " ('artifact.archive','artifact.restore','artifact.inspect','artifact.release')",
    ' AND (EXISTS (SELECT 1 FROM json_tree(tasks.args) WHERE atom=? AND type=\'text\')',
    ' OR EXISTS (SELECT 1 FROM json_tree(tasks.result) WHERE atom=? AND type=\'text\')',
    ' OR EXISTS (SELECT 1 FROM json_tree(tasks.checkpoint) WHERE atom=? AND type=\'text\')) LIMIT 1',
  ].join('')).get(sourceTaskId, fileRefId, fileRefId, fileRefId);
  if (used) blockers.push('downstream-task-reference');
  const relation = connection.prepare([
    'SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.task_id',
    ' WHERE d.dependency_id=? AND t.action NOT IN',
    " ('artifact.archive','artifact.restore','artifact.inspect','artifact.release') LIMIT 1",
  ].join('')).get(sourceTaskId);
  if (relation) blockers.push('dependent-task');
  const guards: { table: string; condition: string }[] = [
    { table: 'material_objects', condition: "json_extract(envelope_json,'$.fileRefId')=?" },
    { table: 'conversion_artifacts', condition: 'artifact_ref=?' },
    { table: 'segment_requests', condition: 'instr(binding_json,?)>0' },
    { table: 'r1_handoff_attempts', condition: 'instr(local_refs_json,?)>0' },
    { table: 'processing_plans', condition: 'instr(document_json,?)>0' },
  ];
  for (const item of guards) {
    const exists = connection.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?")
      .get(item.table);
    if (!exists) continue;
    try {
      if (connection.prepare('SELECT 1 FROM ' + item.table + ' WHERE ' + item.condition + ' LIMIT 1').get(fileRefId))
        blockers.push(item.table + '-reference');
    } catch {
      blockers.push(item.table + '-unverifiable');
    }
  }
  return blockers;
}
export function createArtifactLifecycleActions(options: {
  database: CoreDatabase; files: FileReferenceService; tasks(): TaskService;
  artifactRoot: string; backend?: CloudCustodyBackend;
}) {
  options.database.migrate('artifact-local-releases', 1, SCHEMA);
  const db = options.database.connection;
  const backend = options.backend;
  const available = () => backend?.availability() ?? { available: false, reason: '百度网盘 Skill（技能）尚未绑定。' };
  const archiveBinding = () => JSON.stringify({ artifactArchive: 'bd.artifact-archive/1', ...(backend?.versionBinding ?? {}) });
  const fields: SkillRegistration['fields'] = [
    { key: 'sourceTaskId', label: '来源任务编号', type: 'text', required: true, maxLength: 200 },
    { key: 'fileRefId', label: '已发布文件引用编号', type: 'file', required: true },
  ];
  const inspect: SkillRegistration = {
    action: 'artifact.inspect', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '查询产物归档与本地回收资格',
    description: '只读查看原文件、冻结网盘回执、下游引用及可回收缺口，不更改文件。',
    fields, available: () => ({ available: true }),
    permissionSummary: ['只读本机归档账本及下游引用', '不扫描目录、不删除文件、不发起上传'],
  };
  const release: SkillRegistration = {
    action: 'artifact.release', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '明确回收已归档、无人依赖的本地生成产物',
    description: '仅在远端元数据身份、原文件 SHA-256 及所有本地引用守卫通过后，明确回收本机自有产物。原回执和历史引用保留。',
    fields: [...fields, { key: 'expectedSha256', label: '确认要回收的冻结 SHA-256', type: 'text', required: true, maxLength: 64 }],
    available, permissionSummary: ['回收是独立受控动作，需要精确内容摘要和本地删除权限',
      '任何仍被任务、检索、材料或 WFD 交接依赖的文件都拒绝回收', '不删远端文件，不触碰 WFD 快照和数据库原件'],
  };
  const validate = (raw: Record<string, JsonValue>, destructive: boolean): Input => {
    const keys = destructive ? ['sourceTaskId', 'fileRefId', 'expectedSha256'] : ['sourceTaskId', 'fileRefId'];
    if (Object.keys(raw).some(key => !keys.includes(key)) || !id(raw.sourceTaskId) || !id(raw.fileRefId)
      || destructive && (typeof raw.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.expectedSha256)))
      throw new TaskError('ARTIFACT_RELEASE_INPUT', '必须使用原任务、文件引用及完整冻结摘要。');
    return raw as Input;
  };
  const receiptFor = (sourceTaskId: string, fileRefId: string) => db.prepare(
    'SELECT * FROM artifact_archive_receipts WHERE source_task_id=? AND file_ref_id=?')
    .get(sourceTaskId, fileRefId) as Receipt | undefined;
  const releaseFor = (sourceTaskId: string, fileRefId: string) => db.prepare(
    'SELECT * FROM artifact_local_releases WHERE source_task_id=? AND file_ref_id=?')
    .get(sourceTaskId, fileRefId) as ReleaseRow | undefined;
  const state = (input: Input) => {
    const task = options.tasks().get(input.sourceTaskId);
    if (task.status !== 'succeeded' || task.requiresReview || !task.result?.artifactIds?.includes(input.fileRefId))
      throw new TaskError('ARTIFACT_RELEASE_SOURCE', '来源任务未成功或文件不属于已签发的生成产物。');
    const reference = options.files.getRef(input.fileRefId), receipt = receiptFor(input.sourceTaskId, input.fileRefId);
    const previous = releaseFor(input.sourceTaskId, input.fileRefId);
    const blockers = artifactReleaseBlockers(options.database, options.files, input.sourceTaskId, reference, options.artifactRoot);
    if (!receipt || receipt.state !== 'confirmed' || !receipt.remote_id || receipt.binding_json !== archiveBinding()
      || receipt.file_version !== reference.version || receipt.byte_length !== reference.size)
      blockers.push('archive-not-confirmed-or-binding-changed');
    if (previous && (previous.file_version !== reference.version || previous.source_sha256 !== receipt?.sha256
      || previous.remote_path !== receipt?.target_path)) blockers.push('release-intent-conflict');
    return { reference, receipt, previous, blockers };
  };
  const checkRemote = async (context: TaskExecutionContext, receipt: Receipt): Promise<boolean> => {
    if (!backend || !available().available || !receipt.remote_id) return false;
    const directory = cloudEvidenceDirectory(receipt.topic as never, receipt.purpose as never);
    if (posix.dirname(receipt.target_path) !== directory) return false;
    const session = await backend.open(context, { scopePath: directory, sourceRemotePath: receipt.target_path,
      targetDirectory: directory, allowUpload: false, verifyBytes: false });
    try {
      if (session.lookup) {
        const remote = await session.lookup(receipt.target_path);
        return !!remote && remote.kind === 'file' && remote.path === receipt.target_path
          && remote.id === receipt.remote_id && remote.size === receipt.byte_length;
      }
      let offset = 0;
      for (let i = 0; i < 20; i++) {
        const page = await session.list(directory, offset, 100);
        if (page.items.length > 100 || page.items.some(item => posix.dirname(item.path) !== directory))
          throw new TaskError('ARTIFACT_RELEASE_REMOTE_LIST', '网盘目录返回的对象或范围异常。');
        const found = page.items.filter(item => item.path === receipt.target_path);
        if (found.length > 1) return false;
        if (found.length === 1) {
          return found[0]!.kind === 'file' && found[0]!.id === receipt.remote_id && found[0]!.size === receipt.byte_length;
        }
        if (!page.hasMore) return false;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! <= offset) return false;
        offset = page.nextOffset!;
      }
      return false;
    } finally { await session.close(); }
  };
  const report = (input: Input, condition: ReturnType<typeof state>, remote: string): TaskResult => ({
    summary: '已核对本地文件引用及网盘归档事实；不进行上传、下载或删除。',
    data: { sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId,
      localStatus: condition.reference.status, localBytes: condition.reference.size,
      archiveState: condition.receipt?.state ?? 'absent', sha256: condition.receipt?.sha256 ?? null,
      remotePath: condition.receipt?.target_path ?? null, remoteId: condition.receipt?.remote_id ?? null,
      remoteStatus: remote, releaseState: condition.previous?.state ?? 'not_requested',
      eligible: condition.blockers.length === 0 && !condition.previous && remote === 'metadata_checked',
      blockers: condition.blockers, localDeletion: 'explicit_release_only' }
  });
  return {
    registrations: [inspect, release],
    handles(action: string) { return action === inspect.action || action === release.action; },
    versionBinding() { return { artifactLifecycle: 'bd.artifact-lifecycle/1', ...(backend?.versionBinding ?? {}) }; },
    async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
      const isRelease = action === release.action;
      if (!isRelease && action !== inspect.action) throw new TaskError('ARTIFACT_RELEASE_ACTION', '未登记的产物生命周期动作。');
      const input = validate(args, isRelease);
      const condition = state(input);
      if (!isRelease) {
        const checked = condition.receipt && condition.blockers.length === 0 && condition.receipt.state === 'confirmed'
          ? await checkRemote(context, condition.receipt).catch(() => false) : false;
        return report(input, condition, checked ? 'metadata_checked' : 'not_confirmed');
      }
      if (condition.blockers.length || !condition.receipt) throw new TaskError('ARTIFACT_RELEASE_BLOCKED',
        '仍有本地消费者、来源或归档身份缺口：' + condition.blockers.join('、'));
      const { reference, receipt, previous } = condition;
      if (input.expectedSha256 !== receipt.sha256)
        throw new TaskError('ARTIFACT_RELEASE_HASH', '明确确认的 SHA-256 与冻结原件摘要不同。');
      const current = inspectPath(reference.invocationPath, { allowMissing: true });
      if (previous?.state === 'released') {
        if (current.exists) throw new TaskError('ARTIFACT_RELEASE_CONFLICT', '已记录释放后原位置重新出现文件，不能覆盖或再次删除。');
        return { summary: '原回收记录已确认；没有再次删除本地文件。',
          data: { state: 'released', sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId,
            remotePath: receipt.target_path, bytesReleased: receipt.byte_length } };
      }
      if (!current.exists) throw new TaskError('ARTIFACT_RELEASE_UNKNOWN',
        previous ? '原释放意图未收束且本地已缺失，必须人工核对。' : '本地原件已经缺失，不冒充本次成功回收。');
      if (!samePathIdentity(reference.identity, current, true) || current.links.length)
        throw new TaskError('ARTIFACT_RELEASE_CHANGED', '原本地文件路径、链接或对象身份已变化。');
      const authority = await acquireAuthority(context, 'artifact.release.local', {
        sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId, sha256: receipt.sha256 },
        [fileCapability('read', reference.invocationPath), fileCapability('delete', reference.invocationPath)]);
      const bytes = await options.files.readBytes(reference.id, { operation: context.operationScope(authority.operation),
        approvalId: authority.approvalId, maxBytes: 268_435_456 });
      authority.assert();
      if (bytes.length !== receipt.byte_length || sha(bytes) !== receipt.sha256)
        throw new TaskError('ARTIFACT_RELEASE_CHANGED', '本地字节与归档冻结摘要不一致。');
      if (!await checkRemote(context, receipt))
        throw new TaskError('ARTIFACT_RELEASE_REMOTE_CHANGED', '网盘原目标编号、路径或大小没有通过核对，保留本地原件。');
      // 两次引用核对夹住外部只读检查，避免期间已出现新消费任务仍继续删除。
      const latest = state(input);
      if (latest.blockers.length) throw new TaskError('ARTIFACT_RELEASE_BLOCKED', '核对期间出现新的产物引用。');
      if (previous && !samePathIdentity(JSON.parse(previous.local_identity_json), current, true))
        throw new TaskError('ARTIFACT_RELEASE_CONFLICT', '上次删除意图冻结的文件身份不一致。');
      if (!previous) db.prepare('INSERT INTO artifact_local_releases VALUES(?,?,?,?,?,?,?,?,?)')
        .run(input.sourceTaskId, input.fileRefId, reference.version, receipt.sha256, receipt.target_path,
          JSON.stringify(current), 'pending', Date.now(), null);
      const effectId = createHash('sha256').update(context.task.id + receipt.sha256).digest('hex').slice(0, 32);
      await context.emit({ type: 'side_effect_started', effectId,
        description: '删除已核远端保管且没有下游消费者的本机生成产物',
        operation: { sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId,
          localPath: reference.invocationPath, remotePath: receipt.target_path } });
      const owner = await root(options.artifactRoot, { mutationSymlinks: 'reject', symlinks: 'reject',
        assertBeforeMutation: () => {
          authority.assert(); context.signal.throwIfAborted();
          const now = inspectPath(reference.invocationPath);
          if (!samePathIdentity(current, now, true) || artifactReleaseBlockers(options.database, options.files,
            input.sourceTaskId, reference, options.artifactRoot).length)
            throw new TaskError('ARTIFACT_RELEASE_CHANGED', '删除前文件身份或下游引用已变化。');
        } });
      await owner.remove(basename(reference.invocationPath), { recursive: false, signal: context.signal });
      if (inspectPath(reference.invocationPath, { allowMissing: true }).exists)
        throw new TaskError('ARTIFACT_RELEASE_UNKNOWN', '删除后仍观察到本地文件，保留回收意图待核。');
      db.prepare("UPDATE artifact_local_releases SET state='released',completed_at=? WHERE source_task_id=? AND file_ref_id=? AND state='pending'")
        .run(Date.now(), input.sourceTaskId, input.fileRefId);
      options.files.observe(reference.id);
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded',
        evidence: '旧本地身份已删除且不存在；远端身份仍按原回执追溯。' });
      return { summary: '原本机生成产物已明确释放；冻结网盘回执和旧文件引用保留，后续需明确恢复新文件。',
        data: { state: 'released', sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId,
          remotePath: receipt.target_path, bytesReleased: receipt.byte_length, remoteReadback: false } };
    },
  };
}

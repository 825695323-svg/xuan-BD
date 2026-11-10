import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import { TaskError, type TaskExecutionContext, type TaskService } from '../../platform/jobs/tasks.js';
import { acquireAuthority, directoryCapability, DirectError, DirectWorkspace, prepareDestination } from '../../platform/runtime/file-workspace.js';
import { CLOUD_EVIDENCE_ROOT, CLOUD_MAX_BYTES, cloudPath, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';
import { createHash } from 'node:crypto';
import { ARTIFACT_ARCHIVE_VERSION } from './artifact-archive.js';

export const ARTIFACT_RESTORE_VERSION = 'bd.artifact-restore/1';
interface Receipt {
  source_task_id: string; file_ref_id: string; file_version: number; sha256: string; byte_length: number;
  topic: string; purpose: string; target_path: string; binding_json: string;
  remote_id: string | null; state: 'pending' | 'confirmed';
}
type RestoreInput = { sourceTaskId: string; fileRefId: string };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/u.test(value);

export function createArtifactRestoreActions(options: {
  database: CoreDatabase; files: FileReferenceService; tasks(): TaskService; artifactRoot: string;
  backend?: CloudCustodyBackend;
}) {
  const backend = options.backend;
  const available = () => backend?.availability() ?? { available: false, reason: '网盘归档技能尚未装配。' };
  const versionBinding = () => ({ artifactArchive: ARTIFACT_ARCHIVE_VERSION, ...(backend?.versionBinding ?? {}) });
  const registration: SkillRegistration = {
    action: 'artifact.restore', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '明确从原归档引用恢复文件',
    description: '只接受原来源任务的冻结归档引用；远端先核路径、大小与编号，再明确下载字节核对原 SHA-256。只发布新本地文件，不覆盖旧文件或自动删文件。',
    fields: [
      { key: 'sourceTaskId', label: '原成功任务编号', type: 'text', required: true, maxLength: 200 },
      { key: 'fileRefId', label: '原文件引用编号', type: 'file', required: true },
    ],
    permissionSummary: ['使用原网盘账号及冻结的远端对象身份，只读下载', 'SHA-256 全内容核验通过才发布新文件引用', '新文件不覆盖旧文件，失败不冒充已恢复'],
    available,
    validate(args) {
      if (Object.keys(args).some(key => !['sourceTaskId', 'fileRefId'].includes(key))
        || !validId(args.sourceTaskId) || !validId(args.fileRefId))
        throw new TaskError('ARTIFACT_RESTORE_INPUT', '必须使用原任务和原文件的合法编号。');
    },
  };
  const lookup = async (session: Awaited<ReturnType<CloudCustodyBackend['open']>>, target: string): Promise<CloudObject | null> => {
    if (session.lookup) return session.lookup(target);
    const directory = posix.dirname(target);
    let offset = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await session.list(directory, offset, 100);
      if (page.items.length > 100 || !page.items.every(item => posix.dirname(item.path) === directory))
        throw new TaskError('ARTIFACT_RESTORE_LIST_INVALID', '远端目录查询范围不可信。');
      const matching = page.items.filter(item => item.path === target);
      if (matching.length > 1) throw new TaskError('ARTIFACT_RESTORE_AMBIGUOUS', '远端返回了同路径多个对象。');
      if (matching[0]) return matching[0];
      if (!page.hasMore) return null;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! <= offset)
        throw new TaskError('ARTIFACT_RESTORE_LIST_INVALID', '远端目录没有可靠分页进度。');
      offset = page.nextOffset!;
    }
    throw new TaskError('ARTIFACT_RESTORE_LIST_BUDGET', '远端目录超过当前读取范围。');
  };
  return {
    registration, available, versionBinding,
    async execute(context: TaskExecutionContext, args: Record<string, JsonValue>): Promise<TaskResult> {
      registration.validate!(args);
      const { sourceTaskId, fileRefId } = args as RestoreInput;
      if (!backend || !available().available) throw new TaskError('ARTIFACT_RESTORE_UNAVAILABLE', available().reason ?? '网盘未配置。');
      const source = options.tasks().get(sourceTaskId);
      if (source.status !== 'succeeded' || source.requiresReview || !source.result?.artifactIds?.includes(fileRefId))
        throw new TaskError('ARTIFACT_RESTORE_SOURCE', '原任务不是成功的已发布来源，不能用任意编号取回。');
      const original = options.files.getRef(fileRefId);
      if (original.kind !== 'file' || original.source !== 'generated'
        || !original.relations.some(relation => relation.kind === 'task' && relation.id === sourceTaskId))
        throw new TaskError('ARTIFACT_RESTORE_SOURCE', '没有原任务生成文件的可信关系。');
      const record = options.database.connection.prepare(
        "SELECT * FROM artifact_archive_receipts WHERE source_task_id=? AND file_ref_id=?")
        .get(sourceTaskId, fileRefId) as Receipt | undefined;
      if (!record || record.state !== 'confirmed' || !record.remote_id || record.file_version !== original.version
        || !/^[a-f0-9]{64}$/u.test(record.sha256) || record.byte_length !== original.size
        || record.byte_length < 1 || record.byte_length > CLOUD_MAX_BYTES
        || record.binding_json !== JSON.stringify(versionBinding()))
        throw new TaskError('ARTIFACT_RESTORE_UNCONFIRMED', '原网盘回执不完整、文件版本或账号已变化；禁止猜测远端位置。');
      const remotePath = cloudPath(record.target_path);
      if (!remotePath.startsWith(CLOUD_EVIDENCE_ROOT + '/') || posix.dirname(remotePath) !== posix.join(CLOUD_EVIDENCE_ROOT, record.topic, record.purpose))
        throw new TaskError('ARTIFACT_RESTORE_SCOPE', '原归档目标不在冻结的证据主题和用途中。');
      const authority = await acquireAuthority(context, 'artifact.restore.local-output',
        { sourceTaskId, fileRefId }, (['read', 'write', 'delete'] as const).map(action =>
          directoryCapability(action, options.artifactRoot)));
      const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
      let session: Awaited<ReturnType<CloudCustodyBackend['open']>> | undefined;
      try {
        await workspace.create();
        session = await backend.open(context, { scopePath: posix.dirname(remotePath),
          sourceRemotePath: remotePath, allowUpload: false, verifyBytes: true });
        const remote = await lookup(session, remotePath);
        if (!remote || remote.kind !== 'file' || remote.path !== remotePath || remote.id !== record.remote_id
          || remote.size !== record.byte_length)
          throw new TaskError('ARTIFACT_RESTORE_CHANGED', '网盘远端对象编号、路径或大小与冻结记录不同。');
        const bytes = await session.read(remote, record.byte_length);
        if (bytes.length !== record.byte_length || sha(bytes) !== record.sha256)
          throw new TaskError('ARTIFACT_RESTORE_HASH_MISMATCH', '远端恢复内容与原本地 SHA-256 摘要不一致。');
        authority.assert(); context.signal.throwIfAborted();
        const staged = await workspace.createBytes('restored-bytes', bytes);
        const basename = 'restored-' + randomUUID() + '.bin';
        const published = await workspace.publishFile(staged,
          prepareDestination(join(options.artifactRoot, basename)), 'artifact.restore', args, CLOUD_MAX_BYTES);
        await workspace.cleanup();
        return { summary: '已按原账号和远端编号恢复完整原件；SHA-256 已核对，新文件独立发布，旧引用不变。',
          artifactIds: [published.id], data: { state: 'restored_verified',
            sourceTaskId, originalFileRefId: fileRefId, newFileRefId: published.id,
            remotePath, remoteId: remote.id, sha256: record.sha256, byteLength: record.byte_length,
            overwrite: false, localDeletion: 'forbidden' } };
      } catch (error) {
        if (!(error instanceof DirectError && error.unknown)) {
          try { await workspace.cleanup(); } catch { await workspace.recordRetained(); }
        } else await workspace.recordRetained();
        throw error;
      } finally { await session?.close(); }
    },
  };
}

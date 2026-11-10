import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { TaskExecutionContext, TaskService } from '../../platform/jobs/tasks.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { acquireAuthority, fileCapability } from '../../platform/runtime/file-workspace.js';
import { cloudEvidenceDirectory, CLOUD_EVIDENCE_PURPOSES, CLOUD_EVIDENCE_TOPICS, CLOUD_MAX_BYTES, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';

export const ARTIFACT_ARCHIVE_VERSION = 'bd.artifact-archive/1';
type Topic = typeof CLOUD_EVIDENCE_TOPICS[number];
type Purpose = typeof CLOUD_EVIDENCE_PURPOSES[number];
type Input = { sourceTaskId: string; fileRefId: string; topic: Topic; purpose: Purpose };
interface ArchiveRow {
  source_task_id: string; file_ref_id: string; file_version: number; sha256: string; byte_length: number;
  topic: string; purpose: string; target_path: string; binding_json: string;
  remote_id: string | null; state: 'pending' | 'confirmed'; created_at: number;
}
const SCHEMA = `
CREATE TABLE artifact_archive_receipts (
  source_task_id TEXT NOT NULL, file_ref_id TEXT NOT NULL, file_version INTEGER NOT NULL,
  sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, topic TEXT NOT NULL, purpose TEXT NOT NULL,
  target_path TEXT NOT NULL UNIQUE, binding_json TEXT NOT NULL, remote_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed')), created_at INTEGER NOT NULL,
  PRIMARY KEY(source_task_id,file_ref_id)
);
`;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
const sameBinding = (row: ArchiveRow, expected: Record<string, string | null>) =>
  row.binding_json === JSON.stringify(expected);
function inputOf(value: Record<string, JsonValue>): Input {
  const keys = ['sourceTaskId', 'fileRefId', 'topic', 'purpose'];
  if (Object.keys(value).some(key => !keys.includes(key)) || !validId(value.sourceTaskId) || !validId(value.fileRefId)
    || !(CLOUD_EVIDENCE_TOPICS as readonly string[]).includes(String(value.topic))
    || !(CLOUD_EVIDENCE_PURPOSES as readonly string[]).includes(String(value.purpose))) {
    throw new TaskError('ARTIFACT_ARCHIVE_INPUT', '归档必须明确选择已成功来源任务、已发布文件、证据主题与用途；不接受任意本机路径。');
  }
  return value as Input;
}
function result(row: ArchiveRow, status: 'confirmed' | 'needs_review'): TaskResult {
  return { summary: status === 'confirmed' ? '已用网盘 Skill 确认产物文件名、大小及远端编号；本地原件仍保留。'
    : '远端归档结果尚未确认，已保存原目标；不得更换编号自动重传或删除本地文件。',
    data: { state: status, sourceTaskId: row.source_task_id, fileRefId: row.file_ref_id,
      sourceSha256: row.sha256, byteLength: row.byte_length, remotePath: row.target_path,
      remoteId: row.remote_id, confirmation: status === 'confirmed' ? 'skill_name_size_id' : 'unconfirmed',
      localDeletion: 'forbidden', contentReadback: false } };
}

/** 同一文件仅登记一个目标；重入永远只查询旧目标，不自动重传。 */
export function createArtifactArchiveActions(options: {
  database: CoreDatabase; files: FileReferenceService; tasks(): TaskService;
  backend?: CloudCustodyBackend;
}) {
  options.database.migrate('artifact_archive', 1, SCHEMA);
  const backend = options.backend;
  const available = () => backend?.availability() ?? { available: false, reason: '尚未装配百度网盘 Skill 归档后端。' };
  const versionBinding = () => ({ artifactArchive: ARTIFACT_ARCHIVE_VERSION, ...(backend?.versionBinding ?? {}) });
  const registration: SkillRegistration = {
    action: 'artifact.archive', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '将已发布来源产物归档百度网盘',
    description: '按原成功任务与已发布文件引用办理网盘归档；只核远端文件名、大小及编号，不下载读回，不删除本地文件；同一对象重入仅核原目标。',
    fields: [
      { key: 'sourceTaskId', label: '原成功任务编号', type: 'text', required: true, maxLength: 200 },
      { key: 'fileRefId', label: '原任务已发布文件编号', type: 'file', required: true },
      { key: 'topic', label: '证据主题', type: 'select', required: true, options: CLOUD_EVIDENCE_TOPICS.map(value => ({ value, label: value })) },
      { key: 'purpose', label: '证据用途', type: 'select', required: true, options: CLOUD_EVIDENCE_PURPOSES.map(value => ({ value, label: value })) },
    ],
    permissionSummary: ['只接受原成功任务已发布并登记的文件', '本地只读、远端写入均使用任务独立授权',
      '不下载读回、不删除源文件；异常保留原目标、只读核对'],
    available,
    validate: inputOf,
  };
  const db = options.database.connection;
  const find = (task: string, file: string) => db.prepare('SELECT * FROM artifact_archive_receipts WHERE source_task_id=? AND file_ref_id=?')
    .get(task, file) as ArchiveRow | undefined;
  const lookup = async (session: Awaited<ReturnType<CloudCustodyBackend['open']>>, target: string): Promise<CloudObject | null> => {
    if (session.lookup) return session.lookup(target);
    const directory = posix.dirname(target);
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const page = await session.list(directory, offset, 100);
      if (page.items.length > 100 || !page.items.every(item => posix.dirname(item.path) === directory))
        throw new TaskError('ARTIFACT_ARCHIVE_LIST_INVALID', '网盘返回的目录内容或范围无法核对。');
      const matches = page.items.filter(item => item.path === target);
      if (matches.length > 1) throw new TaskError('ARTIFACT_ARCHIVE_IDENTITY_CONFLICT', '同一远端目标对应多个对象。');
      if (matches[0]) return matches[0];
      if (!page.hasMore) return null;
      if (!page.nextOffset || page.nextOffset <= offset) throw new TaskError('ARTIFACT_ARCHIVE_LIST_INVALID', '网盘目录查询没有前进。');
      offset = page.nextOffset;
    }
    throw new TaskError('ARTIFACT_ARCHIVE_LIST_BUDGET', '网盘目录超出只读核对范围。');
  };
  return { registration, versionBinding, available,
    async execute(context: TaskExecutionContext, raw: Record<string, JsonValue>): Promise<TaskResult> {
      const input = inputOf(raw);
      if (!backend || !available().available) throw new TaskError('ARTIFACT_ARCHIVE_UNAVAILABLE', available().reason ?? '网盘不可用。');
      if (context.task.id === input.sourceTaskId) throw new TaskError('ARTIFACT_ARCHIVE_SELF', '归档任务不能将自己当作来源。');
      const source = options.tasks().get(input.sourceTaskId);
      if (source.status !== 'succeeded' || source.requiresReview || !source.result?.artifactIds?.includes(input.fileRefId))
        throw new TaskError('ARTIFACT_ARCHIVE_SOURCE', '原任务未成功、仍待复核，或此文件不属于其已发布产物。');
      const reference = options.files.verify(input.fileRefId);
      if (reference.source !== 'generated' || reference.kind !== 'file'
        || !reference.relations.some(item => item.kind === 'task' && item.id === input.sourceTaskId)
        || reference.size < 1 || reference.size > CLOUD_MAX_BYTES) {
        throw new TaskError('ARTIFACT_ARCHIVE_SOURCE', '只接受原任务登记的非空生成文件，且不能超出 256 MiB 单件上限。');
      }
      const read = await acquireAuthority(context, 'artifact.archive.read', { sourceTaskId: input.sourceTaskId, fileRefId: input.fileRefId },
        [fileCapability('read', reference.invocationPath)]);
      const bytes = await options.files.readBytes(reference.id, { operation: context.operationScope(read.operation),
        approvalId: read.approvalId ?? undefined, maxBytes: CLOUD_MAX_BYTES });
      read.assert();
      const sha = digest(bytes);
      const directory = cloudEvidenceDirectory(input.topic, input.purpose);
      let row = find(input.sourceTaskId, input.fileRefId);
      if (row && (row.file_version !== reference.version || row.sha256 !== sha || row.byte_length !== bytes.length
        || row.topic !== input.topic || row.purpose !== input.purpose)) {
        throw new TaskError('ARTIFACT_ARCHIVE_FROZEN', '原产物内容、版本或归档分类与冻结记录不同；禁止替换旧远端目标。');
      }
      if (row && !sameBinding(row, versionBinding()))
        throw new TaskError('ARTIFACT_ARCHIVE_BINDING_CHANGED', '原网盘程序或账号绑定已经变化，不能通过另一账号确认旧归档。');
      let session: Awaited<ReturnType<CloudCustodyBackend['open']>> | undefined;
      try {
        session = await backend.open(context, { scopePath: directory, targetDirectory: directory,
          allowUpload: !row, verifyBytes: false });
        if (row) {
          const found = await lookup(session, row.target_path);
          if (!found || found.kind !== 'file' || found.size !== row.byte_length
            || row.remote_id && found.id !== row.remote_id) return result(row, 'needs_review');
          db.prepare("UPDATE artifact_archive_receipts SET state='confirmed',remote_id=? WHERE source_task_id=? AND file_ref_id=?")
            .run(found.id, input.sourceTaskId, input.fileRefId);
          return result({ ...row, state: 'confirmed', remote_id: found.id }, 'confirmed');
        }
        await session.prepareDirectory(directory, true);
        const extension = /\.[a-zA-Z0-9]{1,12}$/u.exec(reference.displayName)?.[0]?.toLowerCase() ?? '';
        const target = posix.join(directory, sha + '-' + randomUUID() + extension);
        // 写入意图必须在远端上传之前持久化；任何不确定结果之后均不重复写入。
        db.prepare('INSERT INTO artifact_archive_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          input.sourceTaskId, reference.id, reference.version, sha, bytes.length,
          input.topic, input.purpose, target, JSON.stringify(versionBinding()), null, 'pending', Date.now());
        row = find(input.sourceTaskId, input.fileRefId)!;
        const before = await lookup(session, target);
        if (before) return result(row, 'needs_review');
        try {
          const uploaded = await session.put(bytes, target);
          const confirmed = await lookup(session, target);
          if (!confirmed || confirmed.kind !== 'file' || confirmed.path !== target
            || confirmed.size !== bytes.length || confirmed.id !== uploaded.id) return result(row, 'needs_review');
          db.prepare("UPDATE artifact_archive_receipts SET state='confirmed',remote_id=? WHERE source_task_id=? AND file_ref_id=?")
            .run(confirmed.id, input.sourceTaskId, reference.id);
          return result({ ...row, state: 'confirmed', remote_id: confirmed.id }, 'confirmed');
        } catch (error) {
          if (context.signal.aborted) throw error;
          return result(row, 'needs_review');
        }
      } finally { await session?.close(); }
    },
  };
}

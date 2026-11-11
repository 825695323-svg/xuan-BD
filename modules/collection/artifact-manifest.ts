import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { TaskError, type TaskExecutionContext, type TaskService } from '../../platform/jobs/tasks.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { CoreDatabase } from '../../platform/state/database.js';

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/u.test(value);
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const roleFor = (name: string): string =>
  /^[a-z][a-z0-9-]{0,63}$/u.test(name) ? name : 'unknown';

export function createArtifactManifestActions(options: {
  database: CoreDatabase; files: FileReferenceService; tasks(): TaskService;
}) {
  const registration: SkillRegistration = {
    action: 'artifact.manifest', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '列出某一来源任务的全部已发布产物与归档进度',
    description: '仅按来源成功任务的 artifactIds（已签发产物清单）汇总文件、来源角色、网盘归档账本和释放状态；不扫描文件夹、不执行上传或清理。',
    fields: [{ key: 'sourceTaskId', label: '成功来源任务编号', type: 'text', required: true, maxLength: 200 }],
    permissionSummary: ['读取单个已完成任务签发的文件身份', '仅汇总原任务自身已签发产物及其归档状态，不暴露私有采集证据',
      '不自动推断金融数据是否已正式写入 WFD，不上传、不下载、不删除'],
    available: () => ({ available: true }),
  };
  const db = options.database.connection;
  return {
    registration,
    versionBinding() { return { artifactManifest: 'bd.artifact-manifest/1' }; },
    execute(_context: TaskExecutionContext, args: Record<string, JsonValue>): Promise<TaskResult> {
      if (Object.keys(args).some(key => key !== 'sourceTaskId') || !id(args.sourceTaskId))
        throw new TaskError('ARTIFACT_MANIFEST_INPUT', '需要已有成功来源任务编号，不接受目录路径或额外参数。');
      const sourceTaskId = args.sourceTaskId as string;
      const task = options.tasks().get(sourceTaskId);
      if (task.status !== 'succeeded' || task.requiresReview || !task.result)
        throw new TaskError('ARTIFACT_MANIFEST_SOURCE', '原任务尚未成功收束或仍需独立复核。');
      const sourceIds = task.result.artifactIds ?? [];
      if (sourceIds.length > 200 || sourceIds.some(value => !id(value)))
        throw new TaskError('ARTIFACT_MANIFEST_LIMIT', '来源签发文件编号超出单次预算或身份格式无效。');
      const roles = new Map<string, Set<string>>();
      const append = (value: unknown, role: string) => {
        if (!id(value)) return;
        const found = roles.get(value) ?? new Set<string>();
        found.add(roleFor(role)); roles.set(value, found);
      };
      const data = obj(task.result.data);
      if (data) {
        for (const item of Array.isArray(data.sourceReceipts) ? data.sourceReceipts : [])
          append(obj(item)?.fileRefId, 'source-raw-response');
        for (const item of Array.isArray(data.artifacts) ? data.artifacts : [])
          append(obj(item)?.fileRefId, typeof obj(item)?.role === 'string' ? String(obj(item)!.role) : 'conversion-artifact');
        for (const [key, role] of [
          ['rawRef', 'web-raw-response'], ['textRef', 'visible-text'], ['domRef', 'web-dom'],
          ['resultRef', 'site-result'], ['locatorRef', 'source-locator'],
          ['articleTableRef', 'article-table'],
        ] as const) append(data[key], role);
        for (const [key, role] of [
          ['textReference', 'transcription-text'], ['evidenceReference', 'transcription-evidence'],
          ['structuredReference', 'structured-conversion'], ['source', 'source-subtitle-or-media'],
        ] as const) append(obj(data[key])?.fileRefId, role);
        for (const item of Array.isArray(data.articles) ? data.articles : []) {
          append(obj(item)?.textRef, 'article-text');
          append(obj(item)?.htmlRef, 'article-html');
        }
      }
      const items = [...new Set(sourceIds)].map(fileRefId => {
        const ref = options.files.getRef(fileRefId);
        const producerMatched = ref.source === 'generated' && ref.kind === 'file'
          && ref.relations.some(link => link.kind === 'task' && link.id === sourceTaskId);
        const archive = db.prepare('SELECT state,sha256,remote_id,target_path FROM artifact_archive_receipts WHERE source_task_id=? AND file_ref_id=?')
          .get(sourceTaskId, fileRefId) as { state: string; sha256: string; remote_id: string | null; target_path: string } | undefined;
        const release = db.prepare('SELECT state FROM artifact_local_releases WHERE source_task_id=? AND file_ref_id=?')
          .get(sourceTaskId, fileRefId) as { state: string } | undefined;
        const annotated = [...(roles.get(fileRefId) ?? new Set(['unclassified']))];
        const original = annotated.some(role => ['source-raw-response', 'web-raw-response', 'source-subtitle-or-media'].includes(role));
        const evidence = annotated.some(role => ['transcription-evidence', 'article-html', 'article-text', 'visible-text', 'web-dom', 'site-result'].includes(role));
        return { fileRefId, name: ref.displayName, bytes: ref.size, registeredStatus: ref.status,
          sourceRoles: annotated, producerMatched, archiveState: archive?.state ?? 'not_archived',
          remotePath: archive?.target_path ?? null, remoteId: archive?.remote_id ?? null,
          archiveEvidence: archive?.state === 'confirmed' ? 'remote_name_size_id_only' : 'none',
          releaseState: release?.state ?? 'not_requested',
          suggestedDisposition: original ? 'archive-original' : evidence ? 'archive-evidence'
            : annotated.includes('source-locator') ? 'retain-lightweight-source-locator' : 'review-derived-or-unclassified',
          nextAction: !producerMatched ? 'source-reference-mismatch' : !archive || archive.state !== 'confirmed'
            ? 'artifact.archive' : release?.state === 'released' ? 'artifact.restore-if-needed' : 'artifact.inspect',
        };
      });
      const privateEvidence = Array.isArray(data?.privateEvidenceRefs) ? data.privateEvidenceRefs.length : 0;
      return Promise.resolve({ summary: '已汇总原来源任务签发的产物、证据角色和归档/释放账本；没有执行远端读写。',
        data: { sourceTaskId: args.sourceTaskId, sourceAction: task.action, status: task.status,
          wfdPublication: 'not_checked', archiveByteVerification: 'not_performed', privateEvidenceCount: privateEvidence,
          count: items.length, items, instructions: '按用途核对后选择 artifact.archive；正式 WFD 准入独立核对，再用 artifact.inspect 判断是否能释放。' } });
    },
  };
}

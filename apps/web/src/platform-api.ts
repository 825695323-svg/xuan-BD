import { request, RequestError } from './api';
import { localDataGeneration, localDataRevision, notifyLocalDataRevoked } from './local-data-context';
import type { FileReference } from '../../../platform/resources/files';
import type { ApprovalRequest, PermissionGrant } from '../../../platform/security/permissions';
import type { SkillDescriptor } from '../../../contracts/skill-contracts';
import type { JsonValue, TaskAttempt, TaskEvent, TaskRecord, TaskRun } from '../../../contracts/task-contracts';
import type { MemoryForgetPreview, MemoryInput, MemoryRecord, MemoryScope, MemorySource } from '../../../contracts/memory-contracts';

interface PrivateContext { generation: number; revision: number }

/** 私有写请求只使用本页已核实的代次；尚未核实时不发送，也不猜代次。 */
function privateContext(action: string): PrivateContext {
  const generation = localDataGeneration();
  if (generation === null) throw new RequestError(`本地资料资格尚未确认，请重新核对后再${action}。`, 409, 'LOCAL_DATA_CONTEXT_MISSING');
  return { generation, revision: localDataRevision() };
}

/** 迟到回执所属代次已被替换或停用时，不把它登记进当前界面。 */
function assertCurrent(context: PrivateContext, action: string): void {
  if (localDataRevision() !== context.revision || localDataGeneration() !== context.generation)
    throw new RequestError(`${action}的回执属于旧代次，未用于当前界面。`, 409, 'STALE_LOCAL_DATA_GENERATION');
}

function revocationCode(body: unknown): string | null {
  const code = isObject(body) && typeof body.code === 'string' ? body.code : null;
  return code && (code.startsWith('LOCAL_DATA_') || code === 'STALE_LOCAL_DATA_GENERATION') ? code : null;
}

export const getSkills = async () => await request('/api/skills') as SkillDescriptor[];
export type FileView = FileReference & { downloadUrl?: string | null };
export const getFiles = async (id: string) => await request(`/api/files?conversationId=${encodeURIComponent(id)}`) as FileView[];
export const registerFile = async (id: string, path: string) => await request('/api/files', 'POST', { conversationId: id, path }) as FileReference;
export const observeFile = async (id: string) => await request(`/api/files/${encodeURIComponent(id)}/observe`, 'POST', {});
export async function uploadFile(conversationId: string, file: File): Promise<FileReference> {
  if (file.size > 25 * 1024 * 1024) throw new RequestError('附件上限为 25 MB；更大的文件请登记本机路径。');
  if (!file.size) throw new RequestError('请选择一个非空文件。');
  const context = privateContext('上传附件');
  let response: Response;
  try {
    response = await fetch(`/api/files/upload?conversationId=${encodeURIComponent(conversationId)}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-local-data-generation': String(context.generation) },
      body: file, credentials: 'same-origin', signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new RequestError('未收到附件保存确认。请先核对当前会话的文件列表，再决定是否重新上传。'); }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new RequestError('附件保存确认无法读取，请先核对文件列表。', response.status); }
  if (!response.ok) {
    const code = revocationCode(body);
    if (code) notifyLocalDataRevoked(code);
    throw new RequestError(isObject(body) && typeof body.error === 'string' ? body.error : '附件保存失败。', response.status,
      isObject(body) && typeof body.code === 'string' ? body.code : null);
  }
  assertCurrent(context, '附件上传');
  if (!isObject(body) || typeof body.id !== 'string' || body.source !== 'user-attached') throw new RequestError('附件保存确认无效，请先核对文件列表。');
  return body as unknown as FileReference;
}
export const getTasks = async (id: string) => await request(`/api/tasks?conversationId=${encodeURIComponent(id)}`) as TaskRecord[];
export const createTask = async (input: { title: string; action: string; args: JsonValue; conversationId: string; requestId: string; dependencies?: string[]; reviewRequired?: boolean }) => await request('/api/tasks', 'POST', input) as TaskRecord;
export const getTaskDetails = async (id: string) => await request(`/api/tasks/${encodeURIComponent(id)}`) as { task: TaskRecord; runs: TaskRun[]; attempts: TaskAttempt[]; events: TaskEvent[] };
export const commandTask = async (task: TaskRecord, command: string, extra: { reason?: string; dependencies?: string[] } = {}) => await request(`/api/tasks/${encodeURIComponent(task.id)}/command`, 'POST', {
  command, ...(command === 'pause' || command === 'cancel' ? { generation: task.generation, runId: task.currentRunId } : { version: task.version }), ...extra,
}) as TaskRecord;
export const reconcileTask = async (task: TaskRecord, outcome: string, evidence: string) => await request(`/api/tasks/${encodeURIComponent(task.id)}/reconcile`, 'POST', { version: task.version, outcome, evidence }) as TaskRecord;
export type ApprovalView = ApprovalRequest & { task?: Pick<TaskRecord, 'title' | 'action' | 'args'>; origin?: {
  notice: string; receiver: { provider: string; model: string; origin: string }; conversationId: string;
} | null };
export const getApproval = async (id: string) => await request(`/api/approvals/${encodeURIComponent(id)}`) as ApprovalView;
export const decideApproval = async (id: string, decision: 'approve' | 'deny') => await request(`/api/approvals/${encodeURIComponent(id)}`, 'POST', { decision });
export const getPermissions = async () => await request('/api/permissions') as PermissionGrant[];
export const revokePermission = async (id: string) => await request(`/api/permissions/${encodeURIComponent(id)}/revoke`, 'POST', {});
export const getPermissionSnapshot = async () => await request('/api/permissions/snapshot') as { grants: PermissionGrant[]; policyVersion: number };
export const restorePermission = async (id: string, policyVersion: number) => await request(`/api/permissions/${encodeURIComponent(id)}/restore`, 'POST', { policyVersion });

export const getMemories = async (query = '') => await request(`/api/memory?query=${encodeURIComponent(query)}`) as MemoryRecord[];
export const getMemory = async (id: string) => await request(`/api/memory/${encodeURIComponent(id)}`) as { record: MemoryRecord; history: MemoryRecord[] };
export const sourceForMessage = async (conversationId: string, messageId: string) => await request('/api/memory/source/message', 'POST', { conversationId, messageId }) as MemorySource;
export const saveMemory = async (input: MemoryInput, requestId: string, existing?: MemoryRecord) => existing
  ? await request(`/api/memory/${encodeURIComponent(existing.id)}`, 'PUT', { input, version: existing.version }) as MemoryRecord
  : await request('/api/memory', 'POST', { input, requestId }) as MemoryRecord;
export const confirmMemory = async (record: MemoryRecord) => await request(`/api/memory/${encodeURIComponent(record.id)}/confirm`, 'POST', { version: record.version });
export const rejectMemory = async (record: MemoryRecord) => await request(`/api/memory/${encodeURIComponent(record.id)}/reject`, 'POST', { version: record.version });
export const resolveMemory = async (record: MemoryRecord, supersede: { id: string; version: number }[]) => await request(`/api/memory/${encodeURIComponent(record.id)}/resolve`, 'POST', { version: record.version, supersede });
export const previewForget = async (id: string) => await request(`/api/memory/${encodeURIComponent(id)}/forget-preview`) as MemoryForgetPreview;
export const forgetMemory = async (id: string, digest: string) => await request(`/api/memory/${encodeURIComponent(id)}/forget`, 'POST', { digest });

export async function getConflictReview(id: string): Promise<{ selected: MemoryRecord; others: MemoryRecord[] }> {
  const { record: selected } = await getMemory(id);
  if (selected.status !== 'conflict') throw new RequestError('这条记忆的状态已变化，请重新查看。');
  const others = await Promise.all(selected.conflictsWith.map(async (other) => (await getMemory(other)).record));
  return { selected, others };
}
export async function getForgetReview(id: string): Promise<{ preview: MemoryForgetPreview; records: MemoryRecord[] }> {
  const preview = await previewForget(id);
  const records = await Promise.all(preview.recordIds.map(async (recordId) => (await getMemory(recordId)).record));
  if (records.some((record) => record.version !== preview.versions[record.id])) throw new RequestError('删除范围在读取期间已变化，请重新预览。');
  return { preview, records };
}

/** HTTP 快照、事件与写入回执均按同一任务的持久序号合并，不让较早回执覆盖新状态。 */
export function mergeTasks(current: readonly TaskRecord[], update: { tasks?: readonly TaskRecord[]; task?: TaskRecord }, conversationId: string): TaskRecord[] {
  const next = new Map(current.filter((task) => task.conversationId === conversationId).map((task) => [task.id, task]));
  for (const task of [...(update.tasks ?? []), ...(update.task ? [update.task] : [])]) {
    if (task.conversationId !== conversationId) continue;
    const previous = next.get(task.id);
    if (!previous || previous.sequence < task.sequence) next.set(task.id, task);
    else if (previous.sequence === task.sequence && task.worker && (!previous.worker || task.worker.lastHeartbeatAt >= previous.worker.lastHeartbeatAt)) next.set(task.id, { ...previous, worker: task.worker });
  }
  return [...next.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function readTaskUpdate(data: string): { tasks?: TaskRecord[]; task?: TaskRecord } {
  const value: unknown = JSON.parse(data);
  const valid = (task: unknown): task is TaskRecord => isObject(task) && typeof task.id === 'string'
    && ['blocked', 'awaiting_review', 'ready', 'running', 'waiting_approval', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted', 'needs_review'].includes(String(task.status))
    && (task.conversationId === null || typeof task.conversationId === 'string') && Number.isSafeInteger(task.sequence) && Number(task.sequence) >= 0
    && Number.isSafeInteger(task.version) && Number(task.version) > 0 && Number.isSafeInteger(task.createdAt);
  if (!isObject(value) || (value.tasks === undefined && value.task === undefined)
    || (value.tasks !== undefined && (!Array.isArray(value.tasks) || !value.tasks.every(valid)))
    || (value.task !== undefined && !valid(value.task))) throw new RequestError('任务状态暂时无法读取。');
  return value as { tasks?: TaskRecord[]; task?: TaskRecord };
}
export function memoryScopeLabel(scope: MemoryScope, conversationId?: string): string {
  return scope.kind === 'global' ? '全局' : scope.kind === 'project' ? `项目：${scope.id}` : scope.id === conversationId ? '当前会话' : `会话：${scope.id}`;
}
export function memorySourceLabel(key: string): string {
  const index = key.indexOf(':');
  const kind = index >= 0 ? key.slice(0, index) : key, id = index >= 0 ? key.slice(index + 1) : '';
  const title = ({ manual: '明确输入', message: '会话消息', task: '任务结果', file: '关联文件', memory: '派生记忆' } as Record<string, string>)[kind] ?? '关联来源';
  return `${title}${id ? ` · ${id}` : ''}`;
}
export async function memoryInputFromForm(input: Omit<MemoryInput, 'sources'>, source: MemorySource | null, requiresMessageSource: boolean): Promise<MemoryInput> {
  if (requiresMessageSource && !source) throw new RequestError('所选消息的来源尚未确认，请重试核对来源后再保存。');
  if (source) return { ...input, sources: [source] };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input.text.trim())));
  const manual: MemorySource = { kind: 'manual', id: crypto.randomUUID(), version: '1',
    contentHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''), observedAt: new Date().toISOString() };
  return { ...input, sources: [manual] };
}
export async function setConversationProject(id: string, projectId: string | null): Promise<void> {
  const context = privateContext('保存项目设置');
  let response: Response;
  try { response = await fetch(`/api/conversations/${encodeURIComponent(id)}/project`, { method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web', 'x-local-data-generation': String(context.generation) },
    body: JSON.stringify({ projectId }), signal: AbortSignal.timeout(30_000) }); }
  catch { throw new RequestError('未收到项目设置的保存确认，请核对会话详情。'); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new RequestError('项目设置的保存确认无法读取，请核对会话详情。', response.status); }
  if (!response.ok) {
    const code = revocationCode(value);
    if (code) notifyLocalDataRevoked(code);
    throw new RequestError(isObject(value) && typeof value.error === 'string' ? value.error : '项目设置暂未保存。', response.status,
      isObject(value) && typeof value.code === 'string' ? value.code : null);
  }
  assertCurrent(context, '项目设置');
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

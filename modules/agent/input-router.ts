import { extname } from 'node:path';
import { CoreError } from '../../platform/runtime/errors.js';
import type { PersonalCore } from './runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { InputRuleService } from './input-rules.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { TaskService } from '../../platform/jobs/tasks.js';
import type { DirectRuntimeBundle } from '../../contracts/direct-runtime.js';
import type { SendReceipt, SendRequestMode, SendRequestRoute } from '../../contracts/contracts.js';
import type { DirectConversationService } from './direct-conversations.js';
interface Options { database: CoreDatabase; core: PersonalCore; files: FileReferenceService; rules: InputRuleService; tasks: TaskService; direct: DirectRuntimeBundle; directConversations: DirectConversationService }
interface ReceiptRow { request_id: string; digest: string; conversation_id: string; branch_id: string; task_id: string; state: 'pending' | 'accepted'; intent_json: string }
export class InputRouter {
  constructor(private readonly options: Options) {
    const current = Number(options.database.connection.prepare('SELECT version FROM schema_versions WHERE module=?').get('input_routes')?.version ?? 0);
    options.database.migrate('input_routes', 2, current === 0
      ? `CREATE TABLE input_routes (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), branch_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL, state TEXT NOT NULL, intent_json TEXT NOT NULL);`
      : `ALTER TABLE input_routes ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';`);
  }
  /**
   * 冻结前由受信宿主选择实际路由：模型会话空闲发送先匹配本机规则，匹配后冻结规则
   * 版本、动作、参数摘要和实现版本；没有匹配才是模型路由。本机会话始终走本机路由。
   */
  routeFor(conversationId: string, text: string, mode: SendRequestMode, attachmentCount = 0): SendRequestRoute {
    const state = this.options.core.getState(conversationId), isDirect = state.pluginId === 'direct';
    if (isDirect && (mode !== 'send' || attachmentCount)) {
      throw new CoreError('DIRECT_RUNTIME_ONLY', '本机会话只接受空闲时的普通发送，不支持附件、排队、引导或打断。', 409);
    }
    const match = mode === 'send' && attachmentCount === 0 ? this.options.rules.match(text) : null;
    if (isDirect && !match) {
      return { kind: 'local', ruleId: null, ruleRevision: null, action: 'local.message',
        subjectDigest: digestOperationArgs({ text }), versionsDigest: null };
    }
    if (!match) return { kind: 'model', ruleId: null, ruleRevision: null, action: null, subjectDigest: null, versionsDigest: null };
    // 规则版本与动作/参数一起冻结；这些动作的实现版本与参数无关，空参数即可取得真实版本。
    const versions = this.options.direct.registry.captureVersions(match.action, match.action === 'video.transcribe_url' ? { url: match.value } : {});
    return { kind: 'local', ruleId: match.rule.id, ruleRevision: match.rule.revision, action: match.action,
      subjectDigest: digestOperationArgs({ value: match.value, isReference: match.isReference }),
      versionsDigest: digestOperationArgs(versions) };
  }
  /** 恢复时重新选择路由；规则版本、动作、参数或实现版本变化都拒绝改投。 */
  assertRoute(conversationId: string, text: string, mode: SendRequestMode, attachmentCount: number, expected: SendRequestRoute): void {
    const actual = this.routeFor(conversationId, text, mode, attachmentCount);
    if (digestOperationArgs(actual) !== digestOperationArgs(expected)) {
      throw new CoreError('SEND_REQUEST_ROUTE_CHANGED', '输入规则或本机动作已变化，原请求不能改投其他动作；请重新编辑后发送。', 409);
    }
  }
  route(conversationId: string, text: string, requestId: string, draft?: { key: string; revision: number },
    matched?: ReturnType<InputRuleService['match']>, options: { automatic?: boolean } = {}): SendReceipt | null {
    if (!requestId || requestId.length > 160 || typeof text !== 'string' || !text.trim() || text.length > 32_000) throw new CoreError('INVALID_INPUT', '输入或请求编号无效。', 400);
    const state = this.options.core.getState(conversationId), isDirect = state.pluginId === 'direct';
    // 冻结记录存在时必须重新核对实际路由；本机会话的用户发送不允许绕过冻结。
    const frozen = this.options.core.store.sendRequest(requestId);
    // 已冻结请求的接收身份以冻结草稿修订为准；后续页面草稿变化只影响旧修订是否退休。
    let receiptDraft = draft;
    if (frozen) {
      if (frozen.conversation_id !== conversationId || frozen.branch_id !== state.branchId || frozen.mode !== 'send' || frozen.text !== text) {
        throw new CoreError('SEND_REQUEST_CONFLICT', '原请求与本机路由的会话、分支、方式或正文不一致。', 409);
      }
      receiptDraft = { key: frozen.draft_key, revision: frozen.draft_revision };
      // 已受理请求回到原任务；只有尚未受理的请求才要求当前路由与冻结路由一致。
      if (frozen.state !== 'accepted') this.assertRoute(conversationId, text, 'send', 0, JSON.parse(frozen.route_json) as SendRequestRoute);
    } else if (isDirect && !options.automatic) {
      throw new CoreError('SEND_REQUEST_REQUIRED', '本机直接执行需要先持久冻结本次请求；不能无编号直接接收。', 409);
    }
    const digest = digestOperationArgs({ conversationId, text, draft: receiptDraft ?? null });
    const localMessage = this.options.directConversations.previous(requestId, conversationId, digest);
    if (localMessage && !localMessage.taskId) return { commandId: 'direct:' + requestId, runId: null, status: 'accepted' };
    const previous = this.options.database.connection.prepare('SELECT * FROM input_routes WHERE request_id=?').get(requestId) as unknown as ReceiptRow | undefined;
    if (previous && previous.branch_id && previous.branch_id !== state.branchId) throw new CoreError('REQUEST_CONFLICT', '此请求编号已经用于其他分支的本机输入。', 409);
    if (this.options.core.store.one('SELECT id FROM commands WHERE request_id=?', requestId)) return null;
    const match = matched ?? this.options.rules.match(text);
    if (!previous && !match) {
      if (!isDirect) return null;
      this.options.core.acknowledgeDirectInput(conversationId, text, receiptDraft, () => {
        this.options.directConversations.record({ requestId, conversationId, digest, text,
          response: '本机直接执行可以处理明确指令，例如“读取文件 /完整路径”“打开文件 /完整路径”“转录 /完整路径”，或单独发送公开视频链接。\n\n也可以从加号里的“文件与附件”选择文件，或在“任务与结果”选择动作。当前输入尚未触发动作；需要理解与讨论时，可以切换到 Pi（智能对话）。' });
      });
      return { commandId: 'direct:' + requestId, runId: null, status: 'accepted' };
    }
    if (previous && (previous.digest !== digest || previous.conversation_id !== conversationId)) throw new CoreError('REQUEST_CONFLICT', '此请求编号已经用于不同输入。', 409);
    let taskId: string;
    let inserted = false;
    if (previous) taskId = previous.task_id;
    else {
      if (state.visibility !== 'active' || state.activeRunId) throw new CoreError('CONVERSATION_BUSY', '请等当前运行结束后再提交确定性动作。', 409);
      const args = match!.action === 'video.transcribe_url' ? { url: match!.value } : (() => {
        const reference = match!.isReference ? this.options.files.getRef(match!.value.slice(1)) : (this.options.direct.assertPublicPath(match!.value), this.options.files.register({ path: match!.value, source: 'user-selected', conversationId }));
        if (match!.isReference && !reference.relations.some((relation) => relation.kind === 'conversation' && relation.id === conversationId)) throw new CoreError('FILE_NOT_SELECTED', '请选择当前会话已登记的文件。', 409);
        return { fileRefId: reference.id };
      })();
      const action = this.options.direct.router.route({ action: match!.action, args });
      const intent = { ...action, title: this.options.direct.registry.get(action.action).title, conversationId, requestId: 'input:' + requestId,
        versions: this.options.direct.registry.captureVersions(action.action, action.args) };
      this.options.database.connection.prepare("INSERT INTO input_routes(request_id,digest,conversation_id,task_id,state,intent_json,branch_id) VALUES(?,?,?,?,'pending',?,?)").run(requestId, digest, conversationId, '', JSON.stringify(intent), state.branchId);
      inserted = true; taskId = '';
    }
    const accepted = previous?.state === 'accepted';
    const row = this.options.database.connection.prepare('SELECT * FROM input_routes WHERE request_id=?').get(requestId) as unknown as ReceiptRow;
    let task;
    if (accepted) task = this.options.tasks.get(taskId);
    else {
      let committed: ReturnType<TaskService['createInTransaction']> | undefined;
      try {
        this.options.core.acknowledgeDirectInput(conversationId, text, receiptDraft, () => {
          committed = this.options.tasks.createInTransaction(JSON.parse(row.intent_json) as Parameters<TaskService['create']>[0]);
          this.options.database.connection.prepare("UPDATE input_routes SET state='accepted',task_id=? WHERE request_id=? AND digest=?").run(committed.task.id, requestId, digest);
          if (isDirect) this.options.directConversations.record({ requestId, conversationId, digest, text, taskId: committed.task.id });
        });
      } catch (error) {
        // 核心接收事务未提交时，清掉本次预写的待办路由；原冻结请求仍保持未受理，可稍后按原编号继续，
        // 不能留下“已受理但没有任务”的假回执。
        if (inserted) this.options.database.connection.prepare("DELETE FROM input_routes WHERE request_id=? AND state='pending' AND task_id=''").run(requestId);
        throw error;
      }
      if (!committed) throw new CoreError('DIRECT_RECEIPT_INCOMPLETE', '本次输入接收未完成，草稿仍可核对。', 409);
      committed.publish(); task = committed.task;
    }
    // 显式重发同一接收请求可以补上尚未开始的首次任务；不重跑已尝试、取消或未知动作。
    if (task.status === 'ready' && task.generation === 0 && task.currentAttemptId === null) this.options.tasks.start(task.id, task.version);
    return { commandId: 'direct:' + requestId, runId: null, status: 'accepted', taskId: task.id };
  }
  routeAttachment(conversationId: string, fileRefId: string, requestId: string): SendReceipt | null {
    const rule = this.options.rules.list().find((rule) => rule.matcher === 'audio-attachment' && rule.enabled);
    if (!rule) return null;
    const reference = this.options.files.getRef(fileRefId);
    if (!reference.relations.some((relation) => relation.kind === 'conversation' && relation.id === conversationId) || !['.wav', '.mp3', '.flac', '.aac', '.ogg', '.opus', '.m4a'].includes(extname(reference.invocationPath).toLowerCase())) return null;
    // 复用同一接收事务，自动音频规则不依赖文字快捷指令是否启用。
    return this.route(conversationId, '/转录 @' + fileRefId, requestId, undefined, { rule, action: 'audio.transcribe', value: '@' + fileRefId, isReference: true }, { automatic: true });
  }
}

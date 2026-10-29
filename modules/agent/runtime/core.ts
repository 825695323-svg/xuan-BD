import { createHash, randomUUID } from 'node:crypto';
import { BackendAbortedError, ConfigError, CoreError, SessionInvalidError } from '../../../platform/runtime/errors.js';
import { type Backend, type BackendEvent, type BackendFailureCode, type BackendInput, type BackendRunResult, type BackendCompactionResult, type BackendSession } from '../../../contracts/backend.js';
import { type BackendRegistry } from '../../../platform/runtime/backends.js';
import type { ConversationAttachmentRef, ConversationPlugin, ConversationState, ConversationSummary, ConversationThinking, ConversationVisibility, CoreEvent, DraftState, FreezeSendRequestInput, MessageHistoryPage, SendReceipt, SendRequestDependencies, SendRequestMode, SendRequestRoute, SendRequestState, SendRequestView, StateEnvelope, ThinkingLevel } from '../../../contracts/contracts.js';
import { CoreDatabase } from '../../../platform/state/database.js';
import { ConversationStore, commandReceipt, normalizeAttachmentRefs, readAttachmentRefs, windowConversationState, type BranchRow, type CommandRow, type RunRow, type SendRequestRow } from '../state/store.js';
import type { FrozenRunConfiguration } from '../../../contracts/ui-contracts.js';
import type { TaskCompletionClaim } from '../../../contracts/task-contracts.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { digestOperationArgs } from '../../../platform/security/permissions.js';
import type { CompletionDisposition, ConversationCompletionOrigin } from '../task-completions.js';

interface ActiveRun {
  id: string; conversationId: string; branchId: string; generation: number; commandId: string;
  kind: 'chat' | 'compaction'; treeRevision?: number;
  thinkingLevel: ThinkingLevel;
  userMessageId: string; assistantMessageId: string; cursorId: string; placeholderUsed: boolean;
  historyHead: string | null; restoreBranch: BranchRow; cancelled: boolean; started: boolean;
  mainConsumed: boolean; session?: BackendSession; abortDone?: Promise<void>; steerDone?: Promise<void>;
  steerDispatching: boolean; sendingDone: boolean; dispatchedInputs: Set<string>;
  messages: Map<string, string>; done: Promise<void>; settle: () => void;
}
interface CachedSession { session: BackendSession; branchId: string; headId: string | null }
export interface CoreOptions { database?: CoreDatabase; registry?: BackendRegistry; recover?: boolean }
export interface SendOptions {
  mode?: 'send' | 'queue' | 'steer'; draft?: { key: string; revision: number }; taskId?: string; attachmentRefs?: ConversationAttachmentRef[];
  /** 只接受已持久冻结的原请求；缺记录时拒绝，不回退为临时受理。 */
  sendRequest?: boolean;
  /** 受信宿主提供的当前权限策略版本；冻结记录有值时须一致。 */
  permissionPolicyVersion?: number | null;
}
export interface InterruptSendOptions {
  draft?: { key: string; revision: number };
  attachmentRefs?: ConversationAttachmentRef[];
  expectedRunId?: string;
  /** 只收束此旧运行所属的外层任务；不得取消无关任务。 */
  settleRelatedRun?: (runId: string, taskId: string) => Promise<void>;
  sendRequest?: boolean;
  permissionPolicyVersion?: number | null;
}
interface PendingInterrupt { requestId: string; done: Promise<SendReceipt> }
interface FrozenDispatch {
  row: SendRequestRow;
  configuration: FrozenRunConfiguration;
  draft: { key: string; revision: number };
  thinkingLevel: ThinkingLevel;
}
export interface FreezeSendRequestOptions { permissionPolicyVersion?: number | null; route?: SendRequestRoute }
export interface FrozenDispatchPayload {
  mode: SendRequestMode;
  text: string;
  attachmentRefs: ConversationAttachmentRef[];
  expectedRunId?: string | null;
  route?: SendRequestRoute;
}

/** 核心数据库拥有会话、分支、草稿与运行；模型会话是可重建的执行投影。 */
export class PersonalCore {
  readonly store: ConversationStore;
  private defaultId: string;
  private readonly ownerEpoch = randomUUID();
  private readonly active = new Map<string, ActiveRun>();
  private readonly interrupts = new Map<string, PendingInterrupt>();
  private readonly sessions = new Map<string, CachedSession>();
  private readonly listeners = new Set<{ callback: (value: StateEnvelope) => void; conversationId?: string }>();
  private closing = false;
  private storageFailure: string | null = null;
  private readonly ownsDatabase: boolean;
  private runtimePreferences?: {
    thinkingLevel(): ThinkingLevel;
    capture(thinkingLevel: ThinkingLevel): FrozenRunConfiguration;
    validate(configuration: FrozenRunConfiguration, restoring: boolean): void;
    assertDispatch(): void;
  };

  constructor(private readonly backend: Backend, private readonly options: CoreOptions = {}) {
    this.ownsDatabase = !options.database;
    this.store = new ConversationStore(options.database ?? new CoreDatabase());
    const completionVersion = Number(this.store.one<{ version: number }>('SELECT version FROM schema_versions WHERE module=?', 'conversation-internal-completions')?.version ?? 0);
    this.store.database.migrate('conversation-internal-completions', 2, completionVersion === 0 ? `
      CREATE TABLE conversation_completion_inputs (
        command_id TEXT PRIMARY KEY REFERENCES commands(id),
        origin_json TEXT NOT NULL, completion_json TEXT NOT NULL,
        control_generation INTEGER, consumed_checkpoint_head_id TEXT
      );
    ` : 'ALTER TABLE conversation_completion_inputs ADD COLUMN control_generation INTEGER; ALTER TABLE conversation_completion_inputs ADD COLUMN consumed_checkpoint_head_id TEXT;');
    if (options.recover !== false) this.recoverInterruptedRuns();
    this.defaultId = this.store.list('active', '', 'pi')[0]?.conversationId ?? this.store.createConversation(backend.id, undefined, 'pi').conversationId;
  }

  get healthy(): boolean { return !this.storageFailure; }
  private acceptedInputObserver?: (commandId: string) => void;
  /** 同步位于命令接收事务内；新约束先冻结旧派发，不能等待模型消费后才生效。 */
  configureAcceptedInputObserver(observer: (commandId: string) => void): void {
    if (this.acceptedInputObserver) throw new Error('输入接收观察器已装配。');
    this.acceptedInputObserver = observer;
  }
  /** 受信组合层只接入既有配置与控制，客户端不能提供快照正文或解除闸门。 */
  configureRuntimePreferences(value: NonNullable<PersonalCore['runtimePreferences']>): void {
    if (this.runtimePreferences) throw new Error('运行偏好已装配。');
    this.runtimePreferences = value;
  }
  runConfiguration(runId: string): FrozenRunConfiguration | null {
    const value = this.store.run(runId).configuration_json;
    return value ? JSON.parse(value) as FrozenRunConfiguration : null;
  }
  get defaultConversationId(): string {
    const current = this.store.conversation(this.defaultId);
    if (current.visibility === 'active' && current.plugin_id === 'pi') return this.defaultId;
    const next = this.store.list('active', '', 'pi')[0];
    if (next) this.defaultId = next.conversationId;
    else {
      this.assertWritable();
      this.defaultId = this.createConversation().conversationId;
    }
    return this.defaultId;
  }
  getState(id = this.defaultConversationId): ConversationState {
    try {
      const state = { ...this.store.state(id, this.supportsCompaction(id)), thinking: this.conversationThinking(id) };
      return this.storageFailure ? { ...state, status: 'ERROR', error: this.storageFailure, storageError: this.storageFailure } : state;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
  }
  getStateWindow(id: string, limit = 40): ConversationState {
    try {
      const state = { ...this.store.state(id, this.supportsCompaction(id), limit), thinking: this.conversationThinking(id) };
      return this.storageFailure ? { ...state, status: 'ERROR', error: this.storageFailure, storageError: this.storageFailure } : state;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
  }
  projectStateWindow(state: ConversationState, limit = 40): ConversationState { return windowConversationState(state, limit); }
  getHistoryPage(id: string, branchId: string, before: string, limit = 40): MessageHistoryPage {
    try { return this.store.historyPage(id, branchId, before, limit); }
    catch (error) {
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
  }

  /** 供受信工具桥读取本次输入及其祖先消息的挂载；活动草稿和旁支不参与。 */
  selectedAttachmentsForInput(input: BackendInput, options: { validateCurrent?: boolean } = {}): ConversationAttachmentRef[] {
    if (!this.isRunActive(input.runId, input.generation)) throw new CoreError('STALE_INPUT', '附件请求不属于当前核心持有的活动运行。');
    const conversation = this.store.conversation(input.conversationId), run = this.store.run(input.runId);
    const command = this.store.command(input.inputId);
    if (run.conversation_id !== input.conversationId || run.branch_id !== input.branchId || run.generation !== input.generation
      || conversation.selected_branch_id !== input.branchId || conversation.generation !== input.generation
      || !['starting', 'running'].includes(run.state) || command.conversation_id !== input.conversationId
      || command.branch_id !== input.branchId || command.run_id !== input.runId || command.generation !== input.generation) {
      throw new CoreError('STALE_INPUT', '附件请求不属于当前会话的活动运行。');
    }
    if (run.kind === 'compaction') return [];
    if (command.input_message_id !== input.messageId || command.text !== input.text
      || !['accepted', 'steering', 'consumed'].includes(command.state)) {
      throw new CoreError('STALE_INPUT', '附件请求没有对应的已接收输入。');
    }
    const refs = readAttachmentRefs(command.attachment_refs_json), selected = new Map(refs.map((ref) => [ref.fileRefId, ref]));
    const message = this.store.one<{ parent_id: string | null; conversation_id: string; role: string; attachment_refs_json: string }>(
      'SELECT parent_id,conversation_id,role,attachment_refs_json FROM messages WHERE id=?', input.messageId);
    if (message && (message.conversation_id !== input.conversationId || message.role !== 'user'
      || message.attachment_refs_json !== command.attachment_refs_json)) throw new CoreError('STALE_INPUT', '附件绑定与当前用户消息不一致。');
    if (!message && command.kind !== 'steer') throw new CoreError('STALE_INPUT', '附件绑定的用户消息尚未提交。');
    // 引导尚未消费时使用接收命令时冻结的祖先；消费后使用实际用户消息的父链。
    let head = message ? message.parent_id : command.source_message_id;
    const seen = new Set<string>();
    while (head) {
      if (seen.has(head)) throw new CoreError('HISTORY_CORRUPT', '附件所属的消息路径不完整。');
      seen.add(head);
      const ancestor = this.store.message(head);
      if (ancestor.conversation_id !== input.conversationId) throw new CoreError('INVALID_PARENT', '附件祖先不属于当前会话。');
      if (ancestor.role === 'user') {
        for (const ref of readAttachmentRefs(ancestor.attachment_refs_json)) if (!selected.has(ref.fileRefId)) selected.set(ref.fileRefId, ref);
      }
      head = ancestor.parent_id;
    }
    return [...selected.values()].map(ref => options.validateCurrent === false ? ref : this.store.validateAttachmentRefs(input.conversationId, [ref])[0]!);
  }
  listConversations(view: ConversationVisibility = 'active', query?: string, pluginId: ConversationPlugin = 'pi'): ConversationSummary[] {
    if (!['active', 'archived', 'trashed'].includes(view)) throw new CoreError('INVALID_VIEW', '请选择当前会话、归档或最近删除。', 400);
    validateConversationPlugin(pluginId);
    if (query !== undefined && (typeof query !== 'string' || query.length > 240 || query.includes('\u0000'))) {
      throw new CoreError('INVALID_QUERY', '搜索内容需为不超过240个字符的文本。', 400);
    }
    return this.store.list(view, query?.trim(), pluginId);
  }
  supportsCompaction(id = this.defaultConversationId): boolean {
    const conversation = this.store.conversation(id);
    if (conversation.plugin_id === 'direct') return false;
    try { return this.backendFor(conversation.backend_id).supportsCompaction === true; }
    catch (error) { if (error instanceof ConfigError) return false; throw error; }
  }
  createConversation(title?: string, backendId = this.backend.id, pluginId: ConversationPlugin = 'pi'): ConversationState {
    this.assertWritable(); validateConversationPlugin(pluginId);
    if (pluginId === 'pi') this.backendFor(backendId);
    try { return this.getState(this.store.createConversation(backendId, title, pluginId).conversationId); }
    catch (error) { if (error instanceof CoreError) throw error; this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503); }
  }
  forkConversation(conversationId: string, treeRevision: number, requestId?: string): ConversationState {
    this.assertWritable();
    if (requestId !== undefined) {
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId)) throw new CoreError('INVALID_REQUEST_ID', '分支会话需要有效请求编号。', 400);
      const previous = this.store.one<{ source_id: string; source_revision: number; target_id: string }>('SELECT * FROM conversation_forks WHERE request_id=?', requestId);
      if (previous) {
        if (previous.source_id !== conversationId || previous.source_revision !== treeRevision) throw new CoreError('REQUEST_CONFLICT', '同一分支请求不能更换来源或历史版本。');
        return this.getState(previous.target_id);
      }
    }
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    try {
      const state = this.store.forkConversation(conversationId, requestId === undefined ? undefined : { id: requestId, revision: treeRevision });
      this.publishLatest(state.conversationId);
      return this.getState(state.conversationId);
    } catch (error) { if (error instanceof CoreError) throw error; this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503); }
  }
  renameConversation(id: string, title: string): ConversationState {
    this.assertWritable();
    if (!title.trim() || title.length > 120) throw new CoreError('INVALID_TITLE', '会话名称需为1到120个字符。', 400);
    this.change(id, 'CONVERSATION_UPDATED', {}, () => this.store.execute('UPDATE conversations SET title=? WHERE id=?', title.trim(), id));
    return this.getState(id);
  }
  setThinkingLevel(id: string, level: unknown): ConversationState {
    this.assertWritable(); this.assertActiveConversation(id); this.assertModelConversation(id);
    if (typeof level !== 'string' || !['off', 'low', 'high', 'max'].includes(level)) throw new CoreError('INVALID_THINKING_LEVEL', '请选择关闭、低、高或最高思考档位。', 400);
    const selected = this.acceptedThinkingLevel(id, level as ThinkingLevel);
    // 只保存后续发送的选择，正在运行的原生会话和已接收命令保持各自冻结值。
    this.change(id, 'CONVERSATION_UPDATED', {}, () => this.store.execute('UPDATE conversations SET thinking_level=? WHERE id=?', selected, id));
    return this.getState(id);
  }
  setConversationVisibility(id: string, visibility: ConversationVisibility, expectedRevision?: number): ConversationState {
    this.assertWritable();
    if (!['active', 'archived', 'trashed'].includes(visibility)) throw new CoreError('INVALID_VISIBILITY', '会话可见状态无效。', 400);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new CoreError('INVALID_REVISION', '会话版本必须是非负整数。', 400);
    }
    const current = this.store.conversation(id);
    const sequence = expectedRevision ?? current.sequence;
    this.assertConversationSequence(id, sequence);
    if (current.visibility === visibility) return this.getState(id);
    this.change(id, 'CONVERSATION_UPDATED', {}, () => {
      this.assertConversationSequence(id, sequence);
      this.assertIdle(id);
      if (visibility !== 'active') this.assertNoActiveTasks(id);
      this.holdQueued(id, '会话可见状态已改变，待发输入保留，恢复后需明确继续。');
      const now = new Date().toISOString();
      this.store.execute('UPDATE conversations SET visibility=?,archived_at=?,deleted_at=?,queue_paused=1 WHERE id=?',
        visibility, visibility === 'archived' ? now : null, visibility === 'trashed' ? now : null, id);
    }, false);
    void this.discardSession(id);
    this.publishLatest(id);
    return this.getState(id);
  }
  setConversationProject(id: string, projectId: string | null): ConversationState {
    this.assertWritable(); this.assertIdle(id);
    if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 120)) {
      throw new CoreError('INVALID_PROJECT', '项目名称需为1到120个字符；清除项目请使用null。', 400);
    }
    const project = projectId?.trim() ?? null;
    if (this.store.conversation(id).project_id === project) return this.getState(id);
    this.change(id, 'CONVERSATION_UPDATED', {}, () => {
      this.assertIdle(id);
      this.store.execute('UPDATE conversations SET project_id=? WHERE id=?', project, id);
    });
    return this.getState(id);
  }
  subscribe(callback: (value: StateEnvelope) => void, conversationId?: string): () => void {
    if (conversationId) this.store.conversation(conversationId);
    const listener = { callback, conversationId };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  captureTaskCompletionOrigin(commandId: string): ConversationCompletionOrigin {
    this.assertWritable();
    const command = this.store.command(commandId);
    this.assertActiveConversation(command.conversation_id);
    this.assertModelConversation(command.conversation_id);
    const conversation = this.store.conversation(command.conversation_id);
    const latest = this.store.one<{ id: string }>(`SELECT id FROM commands WHERE conversation_id=? AND branch_id=?
      AND kind NOT IN ('compact','completion') ORDER BY COALESCE(queue_order,rowid) DESC,rowid DESC LIMIT 1`, command.conversation_id, command.branch_id);
    if (!command.input_message_id || command.state !== 'consumed' || !command.run_id
      || ['compact', 'completion'].includes(command.kind) || latest?.id !== command.id
      || conversation.selected_branch_id !== command.branch_id
      || this.store.message(command.input_message_id).role !== 'user') {
      throw new CoreError('COMPLETION_ORIGIN_STALE', '完成通知必须固定到当前分支已消费的原始用户请求。');
    }
    return { conversationId: command.conversation_id, branchId: command.branch_id, sourceCommandId: command.id,
      sourceMessageId: command.input_message_id, sourceGeneration: command.generation,
      configurationDigest: payloadHash(command.configuration_json) };
  }

  /** Called inside the same transaction as the durable task completion ACK. No model is started here. */
  acceptTaskCompletion(origin: ConversationCompletionOrigin, completion: TaskCompletionClaim): CompletionDisposition {
    if (!this.store.database.connection.isTransaction) throw new CoreError('TRANSACTION_REQUIRED', '完成事件接收须与确认处于同一事务。');
    let current: ConversationCompletionOrigin;
    try { current = this.captureTaskCompletionOrigin(origin.sourceCommandId); }
    catch (error) { if (error instanceof CoreError) return 'stale'; throw error; }
    if (JSON.stringify(current) !== JSON.stringify(origin) || completion.task.conversationId !== origin.conversationId
      || completion.task.ownerRole !== 'personal' || completion.task.currentAttemptId !== completion.attemptId
      || completion.task.generation !== completion.generation) return 'stale';
    try { this.runtimePreferences?.assertDispatch(); } catch { return 'stopped'; }
    const controlGeneration = this.completionControlGeneration();
    if (controlGeneration === null) return 'stopped';
    const conversation = this.store.conversation(origin.conversationId), source = this.store.command(origin.sourceCommandId);
    const sourceRun = this.store.run(source.run_id!);
    if (conversation.queue_paused || ['INTERRUPTED', 'ERROR', 'STOPPING'].includes(conversation.status)
      || ['interrupted', 'failed', 'stopping'].includes(sourceRun.state)) return 'stopped';
    const stoppedLater = this.store.one(`SELECT 1 AS found FROM runs WHERE conversation_id=? AND branch_id=?
      AND rowid>(SELECT rowid FROM runs WHERE id=?) AND state IN ('interrupted','failed','stopping') LIMIT 1`,
      origin.conversationId, origin.branchId, sourceRun.id);
    if (stoppedLater) return 'stopped';
    if (this.active.has(origin.conversationId) || this.interrupts.has(origin.conversationId)) return 'busy';
    if (source.configuration_json) {
      try { this.runtimePreferences?.validate(JSON.parse(source.configuration_json) as FrozenRunConfiguration, true); }
      catch { return 'stale'; }
    }
    const requestId = `completion:${completion.sequence}`, existing = this.store.one<{ id: string }>('SELECT id FROM commands WHERE request_id=?', requestId);
    if (existing) return 'duplicate';
    const contextEvent: NonNullable<BackendInput['contextEvent']> = { kind: 'task-completion', taskId: completion.task.id,
      eventSequence: completion.sequence, sourceCommandId: origin.sourceCommandId,
      status: completion.task.status, resultRef: completion.task.resultRef };
    const text = '宿主持久完成事件（仅状态引用，不是用户消息，不增加授权；结果正文需按当前权限读取）：' + JSON.stringify(contextEvent);
    const commandId = randomUUID(), now = new Date().toISOString();
    this.store.execute(`INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,
      input_message_id,source_message_id,target_run_id,generation,created_at,updated_at,thinking_level,configuration_json)
      VALUES(?,?,?,?,?,'completion',?,'queued',?,?,?,?,?,?,?,?)`, commandId, origin.conversationId, origin.branchId, requestId,
      payloadHash({ origin, contextEvent }), text, origin.sourceMessageId, origin.sourceMessageId, source.run_id,
      conversation.generation, now, now, source.thinking_level, source.configuration_json);
    this.store.execute('INSERT INTO conversation_completion_inputs(command_id,origin_json,completion_json,control_generation) VALUES(?,?,?,?)',
      commandId, JSON.stringify(origin), JSON.stringify(contextEvent), controlGeneration);
    this.store.appendEvent(origin.conversationId, 'QUEUE_UPDATED');
    return 'accepted';
  }

  /** 停止和恢复都会改变现有任务控制代次，旧ACK不能借一次恢复变成新派发许可。 */
  private completionControlGeneration(): number | null {
    if (!this.store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_control'")) return null;
    const control = this.store.one<{ generation: number; stopped: number }>("SELECT generation,stopped FROM task_control WHERE scope='service'");
    return control && control.stopped === 0 && Number.isSafeInteger(control.generation) ? control.generation : null;
  }

  dispatchTaskCompletions(): void {
    if (this.closing || this.storageFailure) return;
    try { this.runtimePreferences?.assertDispatch(); } catch { return; }
    const rows = this.store.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM commands WHERE kind='completion' AND state='queued' LIMIT 100");
    for (const row of rows) {
      this.publishLatest(row.conversation_id);
      queueMicrotask(() => this.drainQueue(row.conversation_id));
    }
  }

  /** 保留单会话调用入口，所有接收仍走同一持久化路径。 */
  send(text: string, requestId: string): { runId: string } {
    const receipt = this.sendMessage(this.defaultConversationId, text, requestId);
    if (!receipt.runId) throw new CoreError('QUEUED', '输入已进入待发队列。');
    return { runId: receipt.runId };
  }

  /** 派发前把本次输入、草稿修订、分支和实际派发路由固定下来；不创建队列或任务。 */
  freezeSendRequest(conversationId: string, input: FreezeSendRequestInput, options: FreezeSendRequestOptions = {}): SendRequestView {
    this.assertWritable(); validateInput(input.text, input.requestId);
    this.assertActiveConversation(conversationId);
    if (!['send', 'queue', 'steer', 'interrupt'].includes(input.mode)) throw new CoreError('INVALID_MODE', '输入方式无效。', 400);
    if (typeof input.branchId !== 'string' || !input.branchId) throw new CoreError('INVALID_BRANCH', '发送请求需要所属分支。', 400);
    validateDraftReference(input.draft);
    if (!input.draft) throw new CoreError('INVALID_DRAFT', '发送请求需要已保存的草稿修订。', 400);
    const conversation = this.store.conversation(conversationId);
    if (input.branchId !== conversation.selected_branch_id) {
      throw new CoreError('SEND_REQUEST_BRANCH_MISMATCH', '发送请求属于原分支，当前会话已切换分支；请回到原分支核对。', 409);
    }
    const attachmentRefs = this.store.validateAttachmentRefs(conversationId, input.attachmentRefs);
    const route = normalizeSendRoute(options.route);
    const directPlugin = conversation.plugin_id === 'direct';
    if (directPlugin) {
      if (input.mode !== 'send') throw new CoreError('DIRECT_RUNTIME_ONLY', '本机会话只执行普通发送，不支持排队、引导或打断。', 409);
      if (attachmentRefs.length) throw new CoreError('DIRECT_ATTACHMENTS_UNSUPPORTED', '本机直接执行暂不接受会话附件。', 400);
      if (route.kind !== 'local') throw new CoreError('INVALID_ROUTE', '本机会话必须使用本机路由，不能冻结模型派发。', 400);
    } else {
      this.assertModelConversation(conversationId);
      // 模型会话也可能由宿主规则直接执行；这种请求不需要模型配置，但不能是排队/引导/打断。
      if (route.kind === 'local' && (input.mode !== 'send' || attachmentRefs.length)) {
        throw new CoreError('INVALID_ROUTE', '本机动作只接受空闲时的普通发送。', 409);
      }
    }
    let expectedRunId = input.expectedRunId ?? null;
    if (expectedRunId !== null && (typeof expectedRunId !== 'string' || !expectedRunId || expectedRunId.length > 160)) {
      throw new CoreError('INVALID_RUN', '发送请求绑定的原运行无效。', 400);
    }
    if ((input.mode === 'send' || input.mode === 'queue') && expectedRunId) {
      throw new CoreError('INVALID_RUN', '普通发送不绑定原运行。', 400);
    }
    // 先按原请求编号/原内容核对，重复保存不能因草稿随后变化而变成新请求。
    const lookupDigest = sendRequestDigest(conversationId, input.branchId, input.mode, input.text, attachmentRefs, expectedRunId);
    const previous = this.store.sendRequest(input.requestId);
    if (previous) {
      if (previous.conversation_id !== conversationId || previous.branch_id !== input.branchId
        || previous.mode !== input.mode || previous.digest !== lookupDigest
        || !sameSendRoute(readSendRoute(previous.route_json), route)) {
        throw new CoreError('SEND_REQUEST_CONFLICT', '此请求编号已经用于其他会话、分支、内容或路由。', 409);
      }
      return this.sendRequestView(previous);
    }
    // 请求编号是跨账本的全局身份：先拒绝旧 commands/input_routes/direct_messages，避免冻结后借用别人的受理记录。
    // 同一正文的另一次发送仍是另一个请求身份；不按内容摘要合并到旧请求。
    this.assertRequestIdUnused(input.requestId);
    const mainKey = `${conversationId}:${conversation.selected_branch_id}:main:`;
    if (input.draft.key !== mainKey) throw new CoreError('INVALID_DRAFT', '只有当前会话主草稿可以冻结发送。', 400);
    const draft = this.store.draft(conversationId, conversation.selected_branch_id, mainKey);
    if (draft.revision !== input.draft.revision || draft.text !== input.text
      || JSON.stringify(draft.attachmentRefs ?? []) !== JSON.stringify(attachmentRefs)) {
      const conflict = new CoreError('DRAFT_CONFLICT', '草稿已变化，请从当前输入重新发送。');
      Object.assign(conflict, { draft });
      throw conflict;
    }
    const active = this.active.get(conversationId);
    if (input.mode === 'steer') {
      if (route.kind === 'local') throw new CoreError('INVALID_ROUTE', '本机动作不能作为引导。', 409);
      if (!active) throw new CoreError('NOT_RUNNING', '只有正在运行的会话可以冻结引导。', 409);
      if (expectedRunId && expectedRunId !== active.id) throw new CoreError('STALE_RUN', '引导请求属于较早或不同的运行。', 409);
      expectedRunId = active.id;
    } else if (input.mode === 'interrupt') {
      if (route.kind === 'local') throw new CoreError('INVALID_ROUTE', '本机动作不能作为打断。', 409);
      if (expectedRunId && active && expectedRunId !== active.id) throw new CoreError('STALE_RUN', '打断请求属于较早或不同的运行。', 409);
      if (!expectedRunId && active) expectedRunId = active.id;
    }
    const digest = sendRequestDigest(conversationId, input.branchId, input.mode, input.text, attachmentRefs, expectedRunId);
    let thinkingLevel: ThinkingLevel, configuration: FrozenRunConfiguration, dependency: SendRequestDependencies;
    if (route.kind === 'local') {
      // 本机动作不依赖模型配置；只冻结路由身份，避免模型设置变化误伤，也不伪造模型配置。
      thinkingLevel = 'off'; configuration = {} as FrozenRunConfiguration;
      dependency = { modelId: null, provider: null, modelConfigurationVersion: null, thinkingLevel,
        preferenceRevision: null, personaSelectionRevision: 0, internalAgentRules: null,
        permissionPolicyVersion: options.permissionPolicyVersion ?? null, configurationDigest: payloadHash(route) };
    } else {
      const preferences = this.runtimePreferences;
      if (!preferences) throw new CoreError('SEND_REQUEST_CONFIGURATION_UNAVAILABLE', '当前没有可冻结的模型与运行配置，不能保存发送请求。', 409);
      preferences.assertDispatch();
      if (input.mode === 'steer') {
        const frozen = this.runConfiguration(active!.id);
        if (!frozen) throw new CoreError('RUN_CONFIGURATION_UNAVAILABLE', '原运行缺少模型与人设配置快照，不能用当前设置替代引导。', 409);
        thinkingLevel = active!.thinkingLevel; configuration = frozen;
      } else {
        thinkingLevel = this.acceptedThinkingLevel(conversationId);
        configuration = preferences.capture(thinkingLevel);
        preferences.validate(configuration, false);
      }
      dependency = sendRequestDependencies(configuration, thinkingLevel, options.permissionPolicyVersion ?? null);
    }
    const now = new Date().toISOString();
    const row: SendRequestRow = {
      request_id: input.requestId, conversation_id: conversationId, branch_id: input.branchId, mode: input.mode,
      text: input.text, attachment_refs_json: JSON.stringify(attachmentRefs), draft_key: mainKey, draft_revision: input.draft.revision,
      expected_run_id: expectedRunId, digest, state: 'frozen', route_json: JSON.stringify(route), thinking_level: thinkingLevel,
      configuration_json: JSON.stringify(configuration),
      dependency_json: JSON.stringify(dependency),
      command_id: null, run_id: null, task_id: null, error_code: null, error: null,
      created_at: now, updated_at: now, accepted_at: null,
    };
    try { this.store.insertSendRequest(row); }
    catch (error) {
      const raced = this.store.sendRequest(input.requestId);
      if (raced && raced.conversation_id === conversationId && raced.branch_id === input.branchId
        && raced.mode === input.mode && raced.digest === digest && sameSendRoute(readSendRoute(raced.route_json), route)) return this.sendRequestView(raced);
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
    return this.sendRequestView(row);
  }

  getSendRequest(conversationId: string, requestId: string): SendRequestView {
    const row = this.store.sendRequest(requestId);
    if (!row || row.conversation_id !== conversationId) throw new CoreError('SEND_REQUEST_NOT_FOUND', '没有找到此会话的发送请求。', 404);
    return this.sendRequestView(row);
  }

  /** 待核与明确未受理的原请求；已受理项按命令或任务回到原记录，不在这里排队。 */
  listSendRequests(conversationId: string): SendRequestView[] {
    this.store.conversation(conversationId);
    return this.store.attentionSendRequests(conversationId).map((row) => this.sendRequestView(row));
  }

  abandonSendRequest(conversationId: string, requestId: string): SendRequestView {
    this.assertWritable();
    const row = this.store.sendRequest(requestId);
    if (!row || row.conversation_id !== conversationId) throw new CoreError('SEND_REQUEST_NOT_FOUND', '没有找到此会话的发送请求。', 404);
    const view = this.sendRequestView(row);
    if (view.state === 'accepted') throw new CoreError('SEND_REQUEST_ACCEPTED', '原请求已经受理，不能按未发送放弃；请回原任务或队列核对。', 409);
    if (view.state === 'unknown') throw new CoreError('SEND_REQUEST_UNKNOWN', '原请求受理事实尚未核清，不能放弃。', 409);
    if (view.state !== 'abandoned') this.store.abandonSendRequest(requestId);
    return this.sendRequestView(this.store.sendRequest(requestId)!);
  }

  /** 本机动作路由在派发前核对同一冻结身份；命令或任务仍是受理权威。 */
  assertSendRequest(conversationId: string, requestId: string,
    payload: Omit<FrozenDispatchPayload, 'expectedRunId'> & { draft?: { key: string; revision: number } }): void {
    this.assertWritable(); validateInput(payload.text, requestId);
    const row = this.store.sendRequest(requestId);
    if (!row) {
      // 旧客户端只留下已受理命令时继续凭原命令核对；没有命令必须回到冻结入口。
      if (!this.store.one('SELECT id FROM commands WHERE request_id=?', requestId)) {
        throw new CoreError('SEND_REQUEST_REQUIRED', '发送前需要先持久保存本次请求；未确认的发送不能换号重发。', 409);
      }
      return;
    }
    if (row.conversation_id !== conversationId) throw new CoreError('SEND_REQUEST_CONFLICT', '发送请求不属于当前会话。', 409);
    const conversation = this.store.conversation(conversationId);
    if (row.branch_id !== conversation.selected_branch_id) throw new CoreError('SEND_REQUEST_BRANCH_MISMATCH', '发送请求属于原分支，当前会话已切换分支。', 409);
    if (row.mode !== payload.mode) throw new CoreError('SEND_REQUEST_CONFLICT', '发送方式已变化，不能沿用原请求。', 409);
    const digest = sendRequestDigest(conversationId, row.branch_id, payload.mode, payload.text, payload.attachmentRefs, row.expected_run_id);
    if (row.digest !== digest) throw new CoreError('SEND_REQUEST_CONFLICT', '同一请求编号不能承载不同内容。', 409);
    if (row.state === 'abandoned') throw new CoreError('SEND_REQUEST_ABANDONED', '原发送请求已放弃，请重新编辑后发送。', 409);
    // 已受理请求回到原命令/任务，不因之后规则变化改投；未受理请求才重新核对外层路由。
    if (row.state === 'accepted') {
      const view = this.sendRequestView(row);
      if (view.state === 'accepted') return;
      throw new CoreError('SEND_REQUEST_UNKNOWN', '原请求没有可核对的命令或任务，受理事实待核。', 409);
    }
    // 冻结后输入规则或本机动作选择发生变化时，不能把原文本静默改投另一个动作。
    const frozenRoute = readSendRoute(row.route_json);
    if (payload.route) {
      if (!sameSendRoute(frozenRoute, normalizeSendRoute(payload.route))) {
        throw new CoreError('SEND_REQUEST_ROUTE_CHANGED', '输入规则或本机动作已变化，原请求不能改投其他动作；请重新编辑后发送。', 409);
      }
    } else if (frozenRoute.kind === 'local') {
      throw new CoreError('SEND_REQUEST_ROUTE_REQUIRED', '原请求绑定本机动作，派发前需要由宿主重新核对实际路由。', 409);
    }
  }

  /** 路由任务受理后回到同一冻结请求；不另建发送队列。 */
  noteSendRequestReceipt(conversationId: string, requestId: string, receipt: SendReceipt): void {
    const row = this.store.sendRequest(requestId);
    if (!row || row.conversation_id !== conversationId) return;
    if (receipt.status === 'failed' || receipt.status === 'cancelled') {
      this.store.rejectSendRequest(requestId, 'ROUTE_NOT_ACCEPTED', '本机动作未受理，原请求仍保留。');
      return;
    }
    // 任务身份也必须属于同一会话；不把另一会话的任务并入这条冻结请求。
    if (receipt.taskId && this.tableExists('tasks')
      && this.store.one<{ conversation_id: string }>('SELECT conversation_id FROM tasks WHERE id=?', receipt.taskId)?.conversation_id !== conversationId) {
      this.store.rejectSendRequest(requestId, 'ROUTE_IDENTITY_MISMATCH', '本机受理的任务不属于当前会话，原请求保留待核。');
      return;
    }
    this.store.acceptSendRequest(requestId, receipt.commandId, receipt.runId, receipt.taskId ?? null);
  }

  sendMessage(conversationId: string, text: string, requestId: string, options: SendOptions = {}): SendReceipt {
    this.assertWritable(); validateInput(text, requestId); validateDraftReference(options.draft);
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const mode = options.mode ?? 'send';
    if (!['send', 'queue', 'steer'].includes(mode)) throw new CoreError('INVALID_MODE', '输入方式无效。', 400);
    const attachmentRefs = normalizeAttachmentRefs(options.attachmentRefs);
    const digest = payloadHash({ conversationId, text, kind: mode, ...attachmentPayload(attachmentRefs) });
    const previous = this.previousReceipt(requestId, digest);
    if (previous) return previous;
    const frozen = options.sendRequest
      ? this.frozenDispatch(conversationId, requestId, { mode, text, attachmentRefs, expectedRunId: null }, options.permissionPolicyVersion)
      : undefined;
    this.runtimePreferences?.assertDispatch();
    this.store.validateAttachmentRefs(conversationId, attachmentRefs);
    if (this.interrupts.has(conversationId)) throw new CoreError('BUSY', '正在收束上一轮并接收新输入，请等待这条请求确认。');
    const c = this.store.conversation(conversationId), branch = this.store.branch(c.selected_branch_id);
    const active = this.active.get(conversationId);
    const thinkingLevel = frozen ? this.acceptedThinkingLevel(conversationId, frozen.thinkingLevel)
      : (mode === 'steer' && active ? active.thinkingLevel : this.acceptedThinkingLevel(conversationId));
    if (mode === 'steer' && active?.kind === 'compaction') throw new CoreError('COMPACTION_BUSY', '正在整理上下文；输入可保存草稿或排队，不能进入摘要。');
    if (mode === 'send' && active) throw new CoreError('BUSY', active.cancelled ? '正在停止，请稍后发送。' : '当前回复尚未结束，可选择排队或引导。');
    if (mode === 'steer' && (!active || active.cancelled)) throw new CoreError('NOT_RUNNING', '只有正在运行的会话可以接收引导。');
    if (mode !== 'send') {
      const commandId = randomUUID(), now = new Date().toISOString();
      const configuration = frozen?.configuration ?? (mode === 'steer' && active ? this.runConfiguration(active.id) : this.runtimePreferences?.capture(thinkingLevel));
      try {
        this.change(conversationId, 'QUEUE_UPDATED', { runId: active?.id ?? null }, () => {
          this.assertActiveConversation(conversationId);
          this.store.execute(`INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,run_id,input_message_id,generation,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, commandId, conversationId, branch.id, requestId, digest, mode, text,
          c.queue_paused && mode === 'queue' ? 'held' : 'queued', mode === 'steer' ? active!.id : null,
          mode === 'steer' ? randomUUID() : null, active?.generation ?? c.generation, now, now);
          this.store.execute('UPDATE commands SET attachment_refs_json=?,source_message_id=?,thinking_level=?,configuration_json=? WHERE id=?', JSON.stringify(attachmentRefs), mode === 'steer' ? branch.head_message_id : null, thinkingLevel, configuration ? JSON.stringify(configuration) : null, commandId);
          this.acceptedInputObserver?.(commandId);
          this.store.retireDraft(conversationId, branch.id, frozen?.draft ?? options.draft, { kind: 'main', targetId: '', text, attachmentRefs });
        });
      } catch (error) {
        if (frozen) this.markSendRequestRejected(frozen.row.request_id, error);
        throw error;
      }
      if (mode === 'steer') queueMicrotask(() => { void this.deliverSteer(active!); });
      else queueMicrotask(() => this.drainQueue(conversationId));
      const receipt = commandReceipt(this.store.command(commandId));
      if (frozen) this.markSendRequestAccepted(frozen.row.request_id, receipt);
      return receipt;
    }
    try {
      const receipt = this.startRun({ conversationId, branch, text, requestId, digest, kind: 'send', draft: frozen?.draft ?? options.draft,
        taskId: options.taskId, attachmentRefs, configuration: frozen?.configuration, thinkingLevel: frozen?.thinkingLevel });
      if (frozen) this.markSendRequestAccepted(frozen.row.request_id, receipt);
      return receipt;
    } catch (error) {
      if (frozen) this.markSendRequestRejected(frozen.row.request_id, error);
      throw error;
    }
  }

  /** 新输入先提交到命令表；旧运行完整收束后才进入下一轮。 */
  interruptAndSend(conversationId: string, text: string, requestId: string, options: InterruptSendOptions = {}): Promise<SendReceipt> {
    this.assertWritable(); validateInput(text, requestId); validateDraftReference(options.draft);
    if (options.expectedRunId !== undefined && (typeof options.expectedRunId !== 'string' || !options.expectedRunId || options.expectedRunId.length > 160)) {
      throw new CoreError('INVALID_RUN', '打断请求的运行标识无效。', 400);
    }
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const attachmentRefs = normalizeAttachmentRefs(options.attachmentRefs);
    const existingCommand = this.store.one<CommandRow>('SELECT * FROM commands WHERE request_id=?', requestId);
    const existing = this.interrupts.get(conversationId);
    // 已存在命令时先按原命定核对；冻结记录只在尚无命令时解析，避免把已受理回执误判为新派发。
    const frozen = options.sendRequest && !existingCommand
      ? this.frozenDispatch(conversationId, requestId, { mode: 'interrupt', text, attachmentRefs, expectedRunId: options.expectedRunId ?? null }, options.permissionPolicyVersion)
      : undefined;
    const expectedRunId = frozen?.row.expected_run_id ?? options.expectedRunId;
    const digest = payloadHash({ conversationId, text, kind: 'interrupt', expectedRunId: expectedRunId ?? null, ...attachmentPayload(attachmentRefs) });
    if (existingCommand) {
      if (existingCommand.payload_hash !== digest) throw new CoreError('REQUEST_CONFLICT', '同一请求标识不能用于不同输入或操作。');
      return existing?.requestId === requestId ? existing.done : Promise.resolve(commandReceipt(existingCommand));
    }
    this.runtimePreferences?.assertDispatch();
    this.store.validateAttachmentRefs(conversationId, attachmentRefs);
    if (existing) throw new CoreError('BUSY', '已有打断并发送请求正在等待上一轮收束。');
    const conversation = this.store.conversation(conversationId), branch = this.store.branch(conversation.selected_branch_id);
    const run = this.active.get(conversationId);
    const target = run ? this.store.run(run.id) : expectedRunId
      ? this.store.one<RunRow>('SELECT * FROM runs WHERE id=?', expectedRunId) : undefined;
    if ((run && expectedRunId && run.id !== expectedRunId)
      || (expectedRunId && (!target || target.conversation_id !== conversationId || target.branch_id !== branch.id))) {
      throw new CoreError('STALE_RUN', '打断请求属于较早或不同的运行，当前回应未被中断。');
    }
    if (!run) this.assertIdle(conversationId);
    const commandId = randomUUID(), now = new Date().toISOString();
    const thinkingLevel = frozen ? this.acceptedThinkingLevel(conversationId, frozen.thinkingLevel) : this.acceptedThinkingLevel(conversationId);
    const configuration = frozen?.configuration ?? this.runtimePreferences?.capture(thinkingLevel);
    let event: CoreEvent;
    try {
      event = this.change(conversationId, 'QUEUE_UPDATED', { runId: run?.id ?? null }, () => {
        this.assertActiveConversation(conversationId);
        if (run) this.fence(run); else this.assertIdle(conversationId);
        if (options.draft && !frozen) {
          const current = this.store.draft(conversationId, branch.id);
          if (current.key !== options.draft.key || current.revision !== options.draft.revision || current.text !== text
            || JSON.stringify(current.attachmentRefs) !== JSON.stringify(attachmentRefs)) {
            const conflict = new CoreError('DRAFT_CONFLICT', '输入草稿已变化，新输入尚未接收，当前回应继续保留。');
            Object.assign(conflict, { draft: current }); throw conflict;
          }
        }
        this.holdQueued(conversationId, '打断并发送保留了旧待发输入；请明确继续这些输入。');
        this.store.execute(`INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,target_run_id,generation,created_at,updated_at)
          VALUES(?,?,?,?,?,'interrupt',?,'queued',?,?,?,?)`, commandId, conversationId, branch.id, requestId, digest, text,
        target?.id ?? null, conversation.generation, now, now);
        this.store.execute('UPDATE commands SET attachment_refs_json=?,thinking_level=?,configuration_json=? WHERE id=?', JSON.stringify(attachmentRefs), thinkingLevel, configuration ? JSON.stringify(configuration) : null, commandId);
        this.acceptedInputObserver?.(commandId);
        this.store.retireDraft(conversationId, branch.id, frozen?.draft ?? options.draft, { kind: 'main', targetId: '', text, attachmentRefs });
        this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', conversationId);
        if (run) {
          this.store.execute("UPDATE runs SET state='stopping' WHERE id=?", run.id);
          this.store.execute("UPDATE conversations SET status='STOPPING' WHERE id=?", conversationId);
          this.store.appendEvent(conversationId, 'RUN_STOPPING', { runId: run.id, messageId: run.kind === 'chat' ? run.assistantMessageId : null });
        }
      }, false);
    } catch (error) {
      if (frozen) this.markSendRequestRejected(frozen.row.request_id, error);
      throw error;
    }
    if (frozen) this.markSendRequestAccepted(frozen.row.request_id, commandReceipt(this.store.command(commandId)));
    if (run) run.cancelled = true;
    let resolve!: (receipt: SendReceipt) => void, reject!: (error: unknown) => void;
    const pending: PendingInterrupt = { requestId, done: new Promise<SendReceipt>((done, failed) => { resolve = done; reject = failed; }) };
    void pending.done.catch(() => {});
    this.interrupts.set(conversationId, pending);
    try { this.publish({ event, state: this.getState(conversationId) }); }
    finally {
      if (run) this.abortBackend(run);
      void this.completeInterrupt(conversationId, commandId, pending, run, target, options.settleRelatedRun).then(resolve, reject);
    }
    return pending.done;
  }

  private async completeInterrupt(conversationId: string, commandId: string, pending: PendingInterrupt, run: ActiveRun | undefined,
    target: RunRow | undefined, settleRelatedRun: InterruptSendOptions['settleRelatedRun']): Promise<SendReceipt> {
    try {
      if (run) await run.done;
      if (target?.task_id && settleRelatedRun) await settleRelatedRun(target.id, target.task_id);
      this.assertWritable(); this.assertActiveConversation(conversationId); this.assertNoActiveTasks(conversationId);
      const command = this.store.command(commandId), conversation = this.store.conversation(conversationId);
      if (command.state !== 'queued') return commandReceipt(command);
      if (conversation.selected_branch_id !== command.branch_id) throw new CoreError('STALE_BRANCH', '新输入仍保留在原分支，请核对后继续。');
      // 释放命令接收锁与同步启动之间没有异步间隙；终态订阅者不能抢占此新输入。
      if (this.interrupts.get(conversationId) === pending) this.interrupts.delete(conversationId);
      return this.startRun({ conversationId, branch: this.store.branch(command.branch_id), text: command.text,
        requestId: command.request_id, digest: command.payload_hash, kind: 'interrupt', queuedCommandId: command.id });
    } catch (error) {
      if (!this.storageFailure) {
        const command = this.store.command(commandId);
        if (command.state === 'queued') {
          const event = this.change(conversationId, 'QUEUE_UPDATED', {}, () => {
          this.store.execute("UPDATE commands SET state='held',error=?,updated_at=? WHERE id=? AND state='queued'",
            error instanceof CoreError ? error.message : '上一轮关联执行尚未确认收束，新输入已保留，请核对后明确继续。', new Date().toISOString(), commandId);
          }, false);
          if (this.interrupts.get(conversationId) === pending) this.interrupts.delete(conversationId);
          this.publish({ event, state: this.getState(conversationId) });
        }
        return commandReceipt(this.store.command(commandId));
      }
      throw error;
    } finally {
      if (this.interrupts.get(conversationId) === pending) this.interrupts.delete(conversationId);
    }
  }

  compactConversation(conversationId: string, requestId: string, treeRevision: number): SendReceipt {
    this.assertWritable(); validateInput('整理上下文', requestId);
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const digest = payloadHash({ conversationId, kind: 'compact', treeRevision });
    const previous = this.previousReceipt(requestId, digest); if (previous) return previous;
    this.runtimePreferences?.assertDispatch();
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    if (!this.supportsCompaction(conversationId)) throw new CoreError('COMPACTION_UNAVAILABLE', '当前运行后端不支持原生上下文整理。', 400);
    const c = this.store.conversation(conversationId), branch = this.store.branch(c.selected_branch_id);
    if (!branch.head_message_id) throw new CoreError('COMPACTION_EMPTY', '当前会话还没有可整理的历史。', 400);
    const id = randomUUID(), commandId = randomUUID(), now = new Date().toISOString(), generation = c.generation + 1;
    const thinkingLevel = this.acceptedThinkingLevel(conversationId);
    const configuration = this.runtimePreferences?.capture(thinkingLevel);
    if (configuration) this.runtimePreferences?.validate(configuration, false);
    let settle!: () => void;
    const run: ActiveRun = { id, kind: 'compaction', conversationId, branchId: branch.id, generation, commandId, treeRevision, thinkingLevel,
      userMessageId: branch.head_message_id, assistantMessageId: branch.head_message_id, cursorId: branch.head_message_id,
      placeholderUsed: false, historyHead: branch.head_message_id, restoreBranch: branch, cancelled: false, started: false,
      mainConsumed: false, steerDispatching: false, sendingDone: false, dispatchedInputs: new Set(), messages: new Map(),
      done: new Promise<void>((resolve) => { settle = resolve; }), settle: () => settle() };
    this.change(conversationId, 'RUN_ACCEPTED', { runId: id }, () => {
      this.assertActiveConversation(conversationId);
      this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
      this.store.execute(`INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,run_id,generation,created_at,updated_at)
        VALUES(?,?,?,?,?,'compact','整理上下文','accepted',?,?,?,?)`, commandId, conversationId, branch.id, requestId, digest, id, generation, now, now);
      this.store.execute(`INSERT INTO runs(id,conversation_id,branch_id,command_id,kind,state,generation,owner_epoch,started_at)
        VALUES(?,?,?,?,'compaction','starting',?,?,?)`, id, conversationId, branch.id, commandId, generation, this.ownerEpoch, now);
      this.store.execute('UPDATE commands SET thinking_level=?,configuration_json=? WHERE id=?', thinkingLevel, configuration ? JSON.stringify(configuration) : null, commandId);
      this.store.execute('UPDATE runs SET thinking_level=?,configuration_json=? WHERE id=?', thinkingLevel, configuration ? JSON.stringify(configuration) : null, id);
      this.store.execute("UPDATE conversations SET status='RUNNING',error=NULL,generation=? WHERE id=?", generation, conversationId);
    }, false);
    this.active.set(conversationId, run);
    try { this.publishLatest(conversationId); }
    finally { void this.executeCompaction(run); }
    return commandReceipt(this.store.command(commandId));
  }

  editMessage(conversationId: string, messageId: string, text: string, requestId: string, treeRevision: number,
    draft?: { key: string; revision: number }, selectedAttachmentRefs?: ConversationAttachmentRef[]): SendReceipt {
    this.assertWritable(); validateInput(text, requestId); validateDraftReference(draft);
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const source = this.store.message(messageId);
    if (source.conversation_id !== conversationId || source.role !== 'user') throw new CoreError('INVALID_SOURCE', '只能编辑当前会话的用户消息。', 400);
    const attachmentRefs = normalizeAttachmentRefs(selectedAttachmentRefs === undefined ? readAttachmentRefs(source.attachment_refs_json) : selectedAttachmentRefs);
    const digest = payloadHash({ conversationId, kind: 'edit', messageId, text, ...attachmentPayload(attachmentRefs) });
    const previous = this.previousReceipt(requestId, digest); if (previous) return previous;
    this.store.validateAttachmentRefs(conversationId, attachmentRefs);
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    const c = this.store.conversation(conversationId), branch = this.store.branch(c.selected_branch_id);
    return this.startRun({ conversationId, branch, text, requestId, digest, kind: 'edit', forkParentId: source.parent_id, sourceMessageId: messageId, draft, attachmentRefs });
  }

  retryMessage(conversationId: string, messageId: string, requestId: string, treeRevision: number): SendReceipt {
    this.assertWritable();
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const source = this.store.message(messageId);
    if (source.conversation_id !== conversationId || source.role !== 'assistant') throw new CoreError('INVALID_SOURCE', '只能重试当前会话的助手回复。', 400);
    let parent = source.parent_id ? this.store.message(source.parent_id) : undefined;
    while (parent?.role === 'assistant' && parent.parent_id) parent = this.store.message(parent.parent_id);
    if (!parent || parent.role !== 'user') throw new CoreError('INVALID_SOURCE', '没有找到这条回复对应的用户输入。', 400);
    const attachmentRefs = readAttachmentRefs(parent.attachment_refs_json);
    const digest = payloadHash({ conversationId, kind: 'retry', messageId, ...attachmentPayload(attachmentRefs) });
    const previous = this.previousReceipt(requestId, digest); if (previous) return previous;
    this.store.validateAttachmentRefs(conversationId, attachmentRefs);
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    validateInput(parent.text, requestId);
    const c = this.store.conversation(conversationId), branch = this.store.branch(c.selected_branch_id);
    return this.startRun({ conversationId, branch, text: parent.text, requestId, digest, kind: 'retry',
      forkParentId: parent.parent_id, reuseUserId: parent.id, sourceMessageId: messageId, attachmentRefs });
  }

  selectBranch(conversationId: string, headId: string | null, treeRevision: number): ConversationState {
    const c = this.store.conversation(conversationId), current = this.store.branch(c.selected_branch_id);
    if (current.head_message_id === headId) return this.selectBranchById(conversationId, current.id, treeRevision);
    if (!headId) throw new CoreError('INVALID_BRANCH', '已有历史不能通过选择空分支清除。', 400);
    const branch = this.store.one<BranchRow>('SELECT * FROM branches WHERE conversation_id=? AND head_message_id=?', conversationId, headId);
    if (!branch) throw new CoreError('INVALID_BRANCH', '没有找到对应的持久分支。', 404);
    return this.selectBranchById(conversationId, branch.id, treeRevision);
  }

  selectBranchById(conversationId: string, branchId: string, treeRevision: number): ConversationState {
    this.assertWritable(); this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    const branch = this.store.branch(branchId);
    if (branch.conversation_id !== conversationId) throw new CoreError('INVALID_BRANCH', '分支不属于当前会话。', 400);
    if (this.store.conversation(conversationId).selected_branch_id === branchId) return this.getState(conversationId);
    this.change(conversationId, 'BRANCH_CHANGED', { messageId: branch.head_message_id }, () => {
      this.holdQueued(conversationId, '切换分支后，原待发输入需要明确继续。');
      this.store.execute("UPDATE conversations SET selected_branch_id=?,tree_revision=tree_revision+1,status='IDLE',error=NULL WHERE id=?", branch.id, conversationId);
    });
    void this.discardSession(conversationId);
    return this.getState(conversationId);
  }

  createBranch(conversationId: string, treeRevision: number): ConversationState {
    this.assertWritable(); this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    const current = this.store.branch(this.store.conversation(conversationId).selected_branch_id);
    if (!current.head_message_id) throw new CoreError('INVALID_BRANCH', '当前会话还没有可创建分支的历史。', 400);
    const branchId = randomUUID(), now = new Date().toISOString();
    this.change(conversationId, 'BRANCH_CHANGED', { messageId: current.head_message_id }, () => {
      this.store.execute(`INSERT INTO branches(id,conversation_id,head_message_id,checkpoint_json,checkpoint_head_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`, branchId, conversationId, current.head_message_id, current.checkpoint_json, current.checkpoint_head_id, now, now);
      this.store.ensureDraft(conversationId, branchId);
      this.holdQueued(conversationId, '创建分支后，原待发输入需要明确继续。');
      this.store.execute("UPDATE conversations SET selected_branch_id=?,tree_revision=tree_revision+1,status='IDLE',error=NULL WHERE id=?", branchId, conversationId);
    });
    void this.discardSession(conversationId);
    return this.getState(conversationId);
  }

  selectBackend(conversationId: string, backendId: string, treeRevision: number): ConversationState {
    this.assertWritable(); this.assertModelConversation(conversationId); this.assertIdle(conversationId); this.assertTreeRevision(conversationId, treeRevision);
    this.backendFor(backendId);
    const current = this.store.conversation(conversationId);
    if (current.backend_id === backendId) return this.getState(conversationId);
    this.change(conversationId, 'CONVERSATION_UPDATED', {}, () => {
      this.holdQueued(conversationId, '运行后端已切换，原待发输入需明确继续。');
      this.store.execute("UPDATE conversations SET backend_id=?,tree_revision=tree_revision+1,status='IDLE',error=NULL WHERE id=?", backendId, conversationId);
    }, false);
    void this.discardSession(conversationId);
    this.publishLatest(conversationId);
    return this.getState(conversationId);
  }

  getDraft(conversationId: string, kind = 'main', targetId = '', branchId?: string): DraftState {
    const c = this.store.conversation(conversationId);
    const branch = this.store.branch(branchId ?? c.selected_branch_id);
    if (branch.conversation_id !== conversationId) throw new CoreError('INVALID_DRAFT', '草稿分支不属于当前会话。', 400);
    if (kind !== 'main' && kind !== 'edit') throw new CoreError('INVALID_DRAFT', '草稿类型无效。', 400);
    if (kind === 'main' && targetId) throw new CoreError('INVALID_DRAFT', '普通草稿不能指定编辑消息。', 400);
    if (kind === 'edit') {
      const message = this.store.message(targetId);
      if (message.conversation_id !== conversationId || message.role !== 'user') throw new CoreError('INVALID_DRAFT', '编辑草稿没有对应的用户消息。', 400);
    }
    this.assertWritable();
    try { return this.store.database.transaction(() => this.store.ensureDraft(conversationId, branch.id, kind, targetId,
      kind === 'edit' ? readAttachmentRefs(this.store.message(targetId).attachment_refs_json) : [])); }
    catch (error) {
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
  }

  saveDraft(conversationId: string, text: string, revision: number, key?: string, selectedAttachmentRefs?: ConversationAttachmentRef[]): DraftState {
    this.assertWritable();
    if (typeof text !== 'string' || text.length > 100_000 || !Number.isSafeInteger(revision) || revision < 0) throw new CoreError('INVALID_DRAFT', '草稿内容或版本无效。', 400);
    const c = this.store.conversation(conversationId);
    const attachmentRefs = this.store.validateAttachmentRefs(conversationId, selectedAttachmentRefs);
    let draft!: DraftState;
    this.change(conversationId, 'DRAFT_UPDATED', {}, () => {
      draft = this.store.updateDraft(conversationId, key ?? this.store.draft(conversationId, c.selected_branch_id).key, text, revision, attachmentRefs);
    });
    return draft;
  }

  /** Direct 请求映射由路由拥有；接收映射与匹配草稿退休在同一核心事务提交。 */
  acknowledgeDirectInput(conversationId: string, text: string, draft?: { key: string; revision: number }, commitReceipt?: () => void): ConversationState {
    this.assertWritable(); validateInput(text, 'direct-ack'); validateDraftReference(draft);
    this.change(conversationId, 'DRAFT_UPDATED', {}, () => {
      this.assertActiveConversation(conversationId); this.assertIdle(conversationId); this.assertNoActiveTasks(conversationId);
      const conversation = this.store.conversation(conversationId);
      // 冻结请求的正文、附件和依赖已经独立于冻结之后的草稿；当前修订只决定旧草稿是否退休，
      // 不能反过来阻塞已核身份的请求，也不能为了接收旧请求而回退或清空后来编辑的草稿。
      if (draft) {
        const current = this.store.draft(conversationId, conversation.selected_branch_id);
        if (current.key === draft.key && current.revision === draft.revision && current.text === text
          && !(current.attachmentRefs ?? []).length) {
          this.store.retireDraft(conversationId, conversation.selected_branch_id, draft, { kind: 'main', targetId: '', text });
        }
      }
      const committed: unknown = commitReceipt?.();
      if (committed && (typeof committed === 'object' || typeof committed === 'function') && 'then' in committed) {
        void Promise.resolve(committed).catch(() => {});
        throw new CoreError('INVALID_RECEIPT_COMMIT', '输入接收事务只能同步保存请求映射。', 400);
      }
      if (conversation.plugin_id === 'direct' && conversation.title === '新会话') {
        this.store.execute("UPDATE conversations SET title=? WHERE id=? AND plugin_id='direct' AND title='新会话'",
          text.trim().replace(/\s+/g, ' ').slice(0, 48), conversationId);
      }
    });
    return this.getState(conversationId);
  }

  /** 修改尚未派发的输入：旧请求保留，替代输入沿原队列位置接收。 */
  editQueued(conversationId: string, commandId: string, text: string, requestId: string, expectedText: string): ConversationState {
    validateInput(text, requestId);
    if (typeof expectedText !== 'string') throw new CoreError('INVALID_QUEUE_EDIT', '修改待发消息需要核对原正文。', 400);
    return this.replaceQueued(conversationId, commandId, requestId, { text, expectedText });
  }

  /** 用户把一条待发输入明确交给当前运行；不复用旧运行或重新投递已交付的引导。 */
  steerQueued(conversationId: string, commandId: string, requestId: string, expectedRunId: string): ConversationState {
    validateInput('引导待发消息', requestId);
    if (typeof expectedRunId !== 'string' || !expectedRunId || expectedRunId.length > 160) throw new CoreError('INVALID_RUN', '引导需要当前运行标识。', 400);
    return this.replaceQueued(conversationId, commandId, requestId, { expectedRunId });
  }

  private replaceQueued(conversationId: string, commandId: string, requestId: string,
    input: { text: string; expectedText: string } | { expectedRunId: string }): ConversationState {
    this.assertWritable();
    const steering = 'expectedRunId' in input;
    const digest = payloadHash({ conversationId, commandId, kind: steering ? 'queue-steer' : 'queue-edit', ...input });
    if (this.previousReceipt(requestId, digest)) return this.getState(conversationId);
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    const conversation = this.store.conversation(conversationId), branch = this.store.branch(conversation.selected_branch_id);
    const command = this.store.one<CommandRow & { position: number }>('SELECT *,COALESCE(queue_order,rowid) AS position FROM commands WHERE id=?', commandId);
    if (!command || command.conversation_id !== conversationId) throw new CoreError('NOT_FOUND', '待发消息不属于当前会话。', 404);
    if (command.branch_id !== branch.id) throw new CoreError('STALE_BRANCH', '待发消息属于另一分支，请刷新后处理。');
    if (!['queue', 'interrupt'].includes(command.kind) || !['queued', 'held'].includes(command.state)) {
      throw new CoreError('ALREADY_DELIVERED', '这条消息已交付、处理或撤回，不能再修改或转为引导。');
    }
    if (this.interrupts.has(conversationId)) throw new CoreError('BUSY', '正在收束上一轮并发送新消息，请稍后处理待发消息。');
    if (!steering && command.text !== input.expectedText) throw new CoreError('QUEUE_EDIT_CONFLICT', '这条待发消息已变化，请刷新后再修改。');
    const active = this.active.get(conversationId);
    if (steering) {
      this.runtimePreferences?.assertDispatch();
      if (!active || active.cancelled || active.sendingDone || active.id !== input.expectedRunId) throw new CoreError('STALE_RUN', '当前运行已结束或变化，待发消息仍保留。');
      if (active.kind !== 'chat') throw new CoreError('COMPACTION_BUSY', '正在整理上下文，消息仍保留在队列中。');
      this.fence(active);
    }
    const attachments = this.store.validateAttachmentRefs(conversationId, readAttachmentRefs(command.attachment_refs_json));
    const thinking = steering ? active!.thinkingLevel : this.acceptedThinkingLevel(conversationId, command.thinking_level ?? undefined);
    const configuration = steering ? this.runConfiguration(active!.id) : this.runtimePreferences?.capture(thinking);
    const id = randomUUID(), now = new Date().toISOString(), text = steering ? command.text : input.text;
    this.change(conversationId, 'QUEUE_UPDATED', { runId: steering ? active!.id : null }, () => {
      if (steering) this.fence(active!);
      this.store.execute("UPDATE commands SET state='cancelled',error=?,updated_at=? WHERE id=?", steering ? '已转为当前运行的引导输入。' : '已由修改后的待发输入替代。', now, command.id);
      this.store.execute('INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,run_id,input_message_id,source_message_id,generation,created_at,updated_at,attachment_refs_json,thinking_level,configuration_json,queue_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, conversationId, branch.id, requestId, digest, steering ? 'steer' : 'queue', text, steering ? 'queued' : command.state,
        steering ? active!.id : null, steering ? randomUUID() : null, steering ? branch.head_message_id : null,
        active?.generation ?? conversation.generation, now, now, JSON.stringify(attachments), thinking,
        configuration ? JSON.stringify(configuration) : null, command.position);
      this.acceptedInputObserver?.(id);
    });
    if (steering) queueMicrotask(() => { void this.deliverSteer(active!); });
    else queueMicrotask(() => this.drainQueue(conversationId));
    return this.getState(conversationId);
  }

  cancelQueued(conversationId: string, commandId: string): ConversationState {
    this.assertWritable();
    this.assertActiveConversation(conversationId);
    const conversation = this.store.conversation(conversationId);
    const command = this.store.command(commandId);
    if (command.conversation_id !== conversationId) throw new CoreError('NOT_FOUND', '待发输入不属于当前会话。', 404);
    if (command.branch_id !== conversation.selected_branch_id) throw new CoreError('STALE_BRANCH', '待发消息属于另一分支，请刷新后处理。');
    const active = this.active.get(conversationId);
    if (command.state === 'steering' || (command.kind === 'steer' && command.state === 'held' && active?.id === command.run_id)) {
      throw new CoreError('ALREADY_DELIVERED', '这条引导已交给运行时；停止当前运行后再处理。');
    }
    if (['consumed', 'accepted'].includes(command.state)) throw new CoreError('ALREADY_STARTED', '这条输入已经开始运行，请使用当前运行的停止操作。');
    this.change(conversationId, 'QUEUE_UPDATED', {}, () => this.store.execute("UPDATE commands SET state='cancelled',updated_at=? WHERE id=?", new Date().toISOString(), commandId));
    return this.getState(conversationId);
  }

  resumeQueue(conversationId: string): ConversationState {
    this.assertWritable();
    this.runtimePreferences?.assertDispatch();
    this.assertActiveConversation(conversationId); this.assertModelConversation(conversationId);
    if (this.active.get(conversationId)?.cancelled || this.interrupts.has(conversationId)) throw new CoreError('BUSY', '正在停止，请在运行收束后继续待发队列。');
    const c = this.store.conversation(conversationId);
    this.change(conversationId, 'QUEUE_UPDATED', {}, () => {
      this.assertActiveConversation(conversationId);
      this.store.execute("UPDATE commands SET state='queued',kind=CASE WHEN kind='steer' THEN 'queue' ELSE kind END,run_id=NULL,error=NULL,updated_at=? WHERE conversation_id=? AND branch_id=? AND state='held'", new Date().toISOString(), conversationId, c.selected_branch_id);
      this.store.execute('UPDATE conversations SET queue_paused=0 WHERE id=?', conversationId);
    });
    queueMicrotask(() => this.drainQueue(conversationId));
    return this.getState(conversationId);
  }

  isRunActive(runId: string, generation: number): boolean {
    if (this.closing || this.storageFailure) return false;
    const run = [...this.active.values()].find((current) => current.id === runId && current.generation === generation);
    if (!run || run.cancelled || run.sendingDone) return false;
    try { this.runtimePreferences?.assertDispatch(); } catch { return false; }
    try { return this.ownsPersistedRun(run, false); }
    catch { this.failStorage(); return false; }
  }

  async abort(runId: string, conversationId?: string): Promise<ConversationState> {
    const row = this.store.one<RunRow>('SELECT * FROM runs WHERE id=?', runId);
    const id = conversationId ?? row?.conversation_id ?? this.defaultConversationId;
    const run = this.active.get(id);
    if (!run) return this.getState(id);
    if (run.id !== runId) throw new CoreError('STALE_RUN', '停止请求属于较早的运行，当前回复未被中断。');
    if (run.cancelled && this.interrupts.has(id) && !this.storageFailure) {
      this.change(id, 'QUEUE_UPDATED', { runId }, () => {
        this.store.execute("UPDATE commands SET state='held',error='已请求停止，新的打断输入仍保留；请核对后明确继续。',updated_at=? WHERE conversation_id=? AND kind='interrupt' AND target_run_id=? AND state='queued'",
          new Date().toISOString(), id, runId);
      });
    }
    if (!run.cancelled) {
      run.cancelled = true;
      try {
        if (!this.storageFailure) this.change(id, 'RUN_STOPPING', { runId, messageId: run.kind === 'compaction' ? null : run.assistantMessageId }, () => {
          this.fence(run);
          this.store.execute("UPDATE runs SET state='stopping' WHERE id=?", run.id);
          this.store.execute("UPDATE conversations SET status='STOPPING',queue_paused=1 WHERE id=?", id);
          this.holdQueued(id, '当前运行已停止，待发输入需明确继续。');
        });
      } finally { this.abortBackend(run); }
    }
    await run.done;
    return this.getState(id);
  }

  /**
   * 单份资料停用时的真实执行收束：中止当前模型运行，并把待发队列保持在原会话中等待明确处理。
   * 不删除消息、草稿或外部结果，也不自动重发。
   */
  async quiesceForDeactivation(reason: string): Promise<{ activeRuns: number; remainingRuns: number; heldQueued: number }> {
    const active = [...this.active.values()];
    await Promise.all(active.map((run) => this.abort(run.id, run.conversationId).catch(() => {})));
    // cancelled 只表示已请求停止；真正退出前仍占用活动运行，不能用来伪证收束。
    const remainingRuns = this.active.size;
    const now = new Date().toISOString();
    let heldQueued = 0;
    this.store.database.transaction(() => {
      const queued = this.store.all<{ id: string; conversation_id: string }>("SELECT id,conversation_id FROM commands WHERE state IN ('queued','held')");
      heldQueued = queued.length;
      for (const command of queued) {
        this.store.execute("UPDATE commands SET state='held',error=?,updated_at=? WHERE id=? AND state IN ('queued','held')", reason, now, command.id);
      }
      this.store.execute('UPDATE conversations SET queue_paused=1,updated_at=? WHERE id IN (SELECT conversation_id FROM commands WHERE state=\'held\')', now);
    });
    return { activeRuns: active.length, remainingRuns, heldQueued };
  }

  activeRunCount(): number {
    // 包含已取消但尚未退出的运行；只有从 active 移除才是真实退出。
    return this.active.size;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.active.values()].map((run) => this.abort(run.id, run.conversationId).catch(() => {})));
    await Promise.all([...this.interrupts.values()].map((pending) => pending.done.catch(() => {})));
    await Promise.all([...this.sessions.keys()].map((id) => this.discardSession(id)));
    this.sessions.clear(); this.listeners.clear();
    if (this.ownsDatabase) this.store.database.close();
  }

  private startRun(input: { conversationId: string; branch: BranchRow; text: string; requestId: string; digest: string;
    kind: CommandRow['kind']; draft?: { key: string; revision: number }; taskId?: string;
    forkParentId?: string | null; reuseUserId?: string; sourceMessageId?: string; queuedCommandId?: string; attachmentRefs?: ConversationAttachmentRef[];
    /** 已冻结的本次模型与人设配置；缺省时沿用队列、原任务或当前偏好。 */
    configuration?: FrozenRunConfiguration; thinkingLevel?: ThinkingLevel }): SendReceipt {
    const c = this.store.conversation(input.conversationId);
    this.runtimePreferences?.assertDispatch();
    this.assertActiveConversation(c.id); this.assertModelConversation(c.id);
    this.assertIdle(c.id);
    const queued = input.queuedCommandId ? this.store.command(input.queuedCommandId) : undefined;
    const sourceRunId = input.kind === 'retry' && input.sourceMessageId ? this.store.message(input.sourceMessageId).run_id : null;
    const sourceRun = sourceRunId ? this.store.run(sourceRunId) : input.taskId
      ? this.store.one<RunRow>('SELECT * FROM runs WHERE task_id=? ORDER BY rowid LIMIT 1', input.taskId) : undefined;
    const inherited = queued?.configuration_json ?? sourceRun?.configuration_json;
    if (this.runtimePreferences && ((sourceRun && !sourceRun.configuration_json) || (queued && !queued.configuration_json))) {
      throw new CoreError('RUN_CONFIGURATION_UNAVAILABLE', '原任务缺少完整模型与人设配置快照，不能用当前设置替代恢复；请明确建立新任务。');
    }
    const thinkingLevel = this.acceptedThinkingLevel(c.id, input.thinkingLevel ?? queued?.thinking_level ?? sourceRun?.thinking_level ?? undefined);
    // 旧记录只有档位时沿用已知档位；没有旧人设快照不能声称已恢复原人设。
    const configuration = input.configuration ?? (inherited ? JSON.parse(inherited) as FrozenRunConfiguration : sourceRun
      ? undefined : this.runtimePreferences?.capture(thinkingLevel));
    if (configuration) this.runtimePreferences?.validate(configuration, input.configuration === undefined ? !!inherited : false);
    const attachmentRefs = this.store.validateAttachmentRefs(c.id, input.queuedCommandId
      ? readAttachmentRefs(this.store.command(input.queuedCommandId).attachment_refs_json) : input.attachmentRefs);
    const fork = input.kind === 'edit' || input.kind === 'retry';
    const branchId = fork ? randomUUID() : input.branch.id;
    const historyHead = fork ? input.forkParentId ?? null : input.branch.head_message_id;
    if (input.kind === 'completion' && !historyHead) throw new CoreError('COMPLETION_ORIGIN_STALE', '完成通知缺少可核对的原历史头，不能派发。');
    const id = randomUUID(), commandId = input.queuedCommandId ?? randomUUID();
    const userMessageId = input.reuseUserId ?? randomUUID(), assistantMessageId = randomUUID();
    const now = new Date().toISOString(), generation = c.generation + 1;
    let settle!: () => void;
    const run: ActiveRun = { id, kind: 'chat', conversationId: c.id, branchId, generation, commandId, userMessageId, assistantMessageId, thinkingLevel,
      cursorId: input.kind === 'completion' ? historyHead! : userMessageId, placeholderUsed: false, historyHead, restoreBranch: input.branch,
      cancelled: false, started: false, mainConsumed: false, steerDispatching: false, sendingDone: false,
      dispatchedInputs: new Set(), messages: new Map(),
      done: new Promise<void>((resolve) => { settle = resolve; }), settle: () => settle() };
    this.change(c.id, 'RUN_ACCEPTED', { runId: id, messageId: assistantMessageId }, () => {
      this.assertActiveConversation(c.id);
      if (fork) {
        this.holdQueued(c.id, '创建分支后，原待发输入需要明确继续。');
        this.store.execute('INSERT INTO branches(id,conversation_id,created_at,updated_at) VALUES(?,?,?,?)', branchId, c.id, now, now);
        this.store.ensureDraft(c.id, branchId);
      }
      if (!input.queuedCommandId) this.store.execute(`INSERT INTO commands(id,conversation_id,branch_id,request_id,payload_hash,kind,text,state,run_id,input_message_id,source_message_id,generation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'accepted',?,?,?,?,?,?)`, commandId, c.id, branchId, input.requestId, input.digest, input.kind, input.text, id, userMessageId, input.sourceMessageId ?? null, generation, now, now);
      else this.store.execute("UPDATE commands SET state='accepted',run_id=?,input_message_id=?,generation=?,updated_at=? WHERE id=?", id, userMessageId, generation, now, commandId);
      if (!input.queuedCommandId) this.store.execute('UPDATE commands SET attachment_refs_json=? WHERE id=?', JSON.stringify(attachmentRefs), commandId);
      this.store.execute("INSERT INTO runs(id,conversation_id,branch_id,command_id,task_id,state,generation,owner_epoch,started_at) VALUES(?,?,?,?,?,'starting',?,?,?)", id, c.id, branchId, commandId, input.taskId ?? null, generation, this.ownerEpoch, now);
      this.store.execute('UPDATE commands SET thinking_level=?,configuration_json=? WHERE id=?', thinkingLevel, configuration ? JSON.stringify(configuration) : null, commandId);
      this.store.execute('UPDATE runs SET thinking_level=?,configuration_json=? WHERE id=?', thinkingLevel, configuration ? JSON.stringify(configuration) : null, id);
      if (!input.reuseUserId) this.insertMessage(userMessageId, c.id, historyHead, id, 'user', input.text, 'complete', attachmentRefs);
      this.insertMessage(assistantMessageId, c.id, input.kind === 'completion' ? historyHead : userMessageId, id, 'assistant', '', 'running');
      if (input.kind !== 'completion') this.acceptedInputObserver?.(commandId);
      this.store.execute('UPDATE branches SET head_message_id=?,updated_at=? WHERE id=?', assistantMessageId, now, branchId);
      this.store.execute("UPDATE conversations SET selected_branch_id=?,generation=?,tree_revision=tree_revision+1,status='RUNNING',error=NULL,title=CASE WHEN title='新会话' THEN ? ELSE title END WHERE id=?", branchId, generation, input.text.replace(/\s+/g, ' ').slice(0, 48), c.id);
      this.store.retireDraft(c.id, input.branch.id, input.draft, { kind: input.kind === 'edit' ? 'edit' : 'main',
        targetId: input.kind === 'edit' ? input.sourceMessageId! : '', text: input.text, attachmentRefs });
    }, false);
    this.active.set(c.id, run);
    try { this.publishLatest(c.id); }
    finally { void this.execute(run, input.text); }
    return commandReceipt(this.store.command(commandId));
  }

  private async execute(run: ActiveRun, text: string): Promise<void> {
    let result: BackendRunResult | undefined, failure: string | undefined, failureCode: BackendFailureCode | undefined;
    try {
      if (run.cancelled || this.storageFailure) throw new BackendAbortedError();
      const c = this.store.conversation(run.conversationId);
      this.assertModelConversation(c.id);
      let cached = this.sessions.get(c.id);
      if (cached && (cached.branchId !== run.branchId || cached.headId !== run.historyHead)) {
        await this.discardSession(c.id); cached = undefined;
      }
      if (!cached) {
        const session = await this.backendFor(c.backend_id).createSession({ conversationId: c.id, branchId: run.branchId,
          history: this.store.history(c.id, run.historyHead), checkpoint: this.store.checkpoint(run.restoreBranch, run.historyHead, c.backend_id) });
        cached = { session, branchId: run.branchId, headId: run.historyHead };
        this.sessions.set(c.id, cached);
      }
      run.session = cached.session;
      if (run.cancelled) { this.abortBackend(run); throw new BackendAbortedError(); }
      result = await cached.session.send(this.backendInput(run, run.commandId, run.userMessageId, text), (event) => this.handleBackendEvent(run, event));
      failureCode = result.failureCode;
      if (result.outcome === 'completed') {
        const last = this.store.one<{ text: string; status: string; failure_code: string | null }>(
          "SELECT text,status,failure_code FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1", run.id);
        if (!run.mainConsumed || !last || last.status === 'running') failureCode = 'protocol';
        else if (result.rawStopReason === 'length') failureCode = 'length';
        else if (result.rawStopReason && !['stop', 'aborted'].includes(result.rawStopReason)) failureCode = 'protocol';
        else if (last.failure_code) failureCode = last.failure_code as BackendFailureCode;
        else if (!last.text.trim()) failureCode = 'empty';
      }
      if (result.outcome === 'error' || failureCode) failure = failureText(failureCode);
      if (result.rawStopReason === 'aborted') run.cancelled = true;
      if (result.failureCode === 'storage') this.failStorage();
    } catch (error) {
      if (error instanceof BackendAbortedError) run.cancelled = true;
      else {
        failure = safeError(error);
        failureCode = error instanceof SessionInvalidError || error instanceof CoreError ? 'protocol' : run.started ? 'provider' : 'not_started';
        if (run.started) this.abortBackend(run);
      }
    } finally {
      run.sendingDone = true;
      let terminal: StateEnvelope | undefined;
      try {
        if (run.steerDone) await run.steerDone;
        if (run.abortDone) await run.abortDone;
        if (!result || !run.mainConsumed || failure || this.storageFailure) await this.discardSession(run.conversationId);
        if (!this.storageFailure) terminal = this.finish(run, result, failure, failureCode);
      } catch { this.failStorage(); }
      finally {
        if (this.active.get(run.conversationId) === run) this.active.delete(run.conversationId);
        run.settle();
      }
      // 终态可触发下一次发送，因此先释放内存锁，再向订阅者发布已提交的快照。
      if (terminal) this.publish(terminal);
      if (!this.storageFailure) queueMicrotask(() => this.drainQueue(run.conversationId));
    }
  }

  private async executeCompaction(run: ActiveRun): Promise<void> {
    let result: BackendCompactionResult | undefined, failure: string | undefined, failureCode: BackendFailureCode | undefined;
    try {
      if (run.cancelled || this.storageFailure) throw new BackendAbortedError();
      this.fence(run);
      const c = this.store.conversation(run.conversationId);
      this.assertModelConversation(c.id);
      let cached = this.sessions.get(c.id);
      if (cached && (cached.branchId !== run.branchId || cached.headId !== run.historyHead)) { await this.discardSession(c.id); cached = undefined; }
      if (!cached) {
        const session = await this.backendFor(c.backend_id).createSession({ conversationId: c.id, branchId: run.branchId,
          history: this.store.history(c.id, run.historyHead), checkpoint: this.store.checkpoint(run.restoreBranch, run.historyHead, c.backend_id) });
        cached = { session, branchId: run.branchId, headId: run.historyHead }; this.sessions.set(c.id, cached);
      }
      run.session = cached.session;
      if (run.cancelled) { this.abortBackend(run); throw new BackendAbortedError(); }
      if (!cached.session.compact) throw new SessionInvalidError('此后端没有提供原生上下文整理操作。');
      result = await cached.session.compact(this.backendInput(run, run.commandId, run.userMessageId, '整理上下文'), (event) => this.handleBackendEvent(run, event));
      if (result.outcome === 'interrupted') run.cancelled = true;
      if (result.failureCode === 'storage') this.failStorage();
      if (result.outcome === 'error') { failureCode = result.failureCode ?? 'protocol'; failure = failureText(failureCode); }
      if (result.outcome === 'completed' && (result.changed ? !result.checkpoint || ![0, 1].includes(result.modelRequests) : !!result.checkpoint || result.modelRequests !== 0)) {
        failureCode = 'protocol'; failure = failureText(failureCode);
      }
    } catch (error) {
      if (error instanceof BackendAbortedError) run.cancelled = true;
      else { failure = safeError(error); failureCode = error instanceof SessionInvalidError || error instanceof CoreError ? 'protocol' : 'not_started'; }
    } finally {
      run.sendingDone = true;
      let terminal: StateEnvelope | undefined;
      try {
        if (run.abortDone) await run.abortDone;
        if (!result || failure || run.cancelled || this.storageFailure) await this.discardSession(run.conversationId);
        if (!this.storageFailure) {
          try { terminal = this.finishCompaction(run, result, failure, failureCode); }
          catch (error) {
            if (!(error instanceof CoreError) || error.code !== 'TREE_CONFLICT') throw error;
            await this.discardSession(run.conversationId);
            terminal = this.finishCompaction(run, result, '历史已变化，摘要未安装；原始历史和检查点仍保留。', 'protocol');
          }
        }
      } catch { this.failStorage(); }
      finally { if (this.active.get(run.conversationId) === run) this.active.delete(run.conversationId); run.settle(); }
      if (terminal) this.publish(terminal);
      if (!this.storageFailure) queueMicrotask(() => this.drainQueue(run.conversationId));
    }
  }

  private finishCompaction(run: ActiveRun, result?: BackendCompactionResult, failure?: string, failureCode?: BackendFailureCode): StateEnvelope | undefined {
    if (this.active.get(run.conversationId) !== run) return;
    const interrupted = run.cancelled || result?.outcome === 'interrupted';
    const succeeded = !interrupted && !failure && result?.outcome === 'completed';
    const event = this.change(run.conversationId, interrupted ? 'RUN_INTERRUPTED' : succeeded ? 'RUN_FINISHED' : 'RUN_ERROR',
      { runId: run.id, ...(succeeded && result.contextUsage ? { contextUsage: result.contextUsage } : {}), ...(failure && !interrupted ? { error: failure } : {}) }, () => {
        this.fence(run);
        if (succeeded && result.changed) {
          const c = this.store.conversation(run.conversationId), branch = this.store.branch(run.branchId);
          if (c.tree_revision !== run.treeRevision || branch.head_message_id !== run.historyHead) throw new CoreError('TREE_CONFLICT', '历史已变化，旧摘要不能安装。');
          this.store.saveCheckpoint(run.branchId, run.historyHead, result.checkpoint!);
        }
        const stats = result ? { changed: succeeded && result.changed, modelRequests: result.modelRequests,
          ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
          ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}) } : null;
        this.store.execute('UPDATE runs SET state=?,settled_at=?,raw_stop_reason=?,failure_code=?,session_ref=?,compaction_json=? WHERE id=?',
          interrupted ? 'interrupted' : succeeded ? 'succeeded' : 'failed', new Date().toISOString(), result?.rawStopReason ?? (interrupted ? 'aborted' : null),
          failureCode ?? null, run.session?.id ?? null, stats ? JSON.stringify(stats) : null, run.id);
        if (!run.mainConsumed) this.store.execute("UPDATE commands SET state='failed',error=? WHERE id=?", interrupted ? '整理开始前被停止。' : failure ?? '整理未能开始。', run.commandId);
        this.store.execute('UPDATE conversations SET status=?,error=? WHERE id=?', interrupted ? 'INTERRUPTED' : succeeded ? 'IDLE' : 'ERROR',
          interrupted ? null : failure ?? null, run.conversationId);
      }, false);
    return { event, state: this.getState(run.conversationId) };
  }

  private async handleBackendEvent(run: ActiveRun, event: BackendEvent): Promise<void> {
    if (this.storageFailure) throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure, 503);
    if (this.active.get(run.conversationId) !== run || run.sendingDone) return;
    this.fence(run);
    if (event.type === 'context_usage') {
      if (run.cancelled) return;
      this.change(run.conversationId, 'CONTEXT_USAGE_UPDATED', { runId: run.id, messageId: null, contextUsage: event.contextUsage }, () => this.fence(run));
      return;
    }
    if (run.kind === 'compaction' && event.type !== 'run_started') throw new CoreError('INVALID_RUNTIME_EVENT', '摘要不能追加聊天消息或提前提交检查点。');
    const fields = { runId: run.id, messageId: run.kind === 'compaction' ? null : run.assistantMessageId };
    if (event.type === 'run_started') {
      this.change(run.conversationId, 'RUN_STARTED', fields, () => {
        this.fence(run);
        this.store.execute("UPDATE runs SET state=?,session_ref=? WHERE id=?", run.cancelled ? 'stopping' : 'running', run.session!.id, run.id);
        if (run.kind === 'compaction') this.store.execute("UPDATE commands SET state='consumed',updated_at=? WHERE id=?", new Date().toISOString(), run.commandId);
      }, false);
      run.started = true;
      if (run.kind === 'compaction') run.mainConsumed = true;
      this.publishLatest(run.conversationId);
      queueMicrotask(() => { void this.deliverSteer(run); });
      return;
    }
    if (event.type === 'input_consumed') {
      const command = this.store.command(event.inputId);
      if (command.conversation_id !== run.conversationId || command.run_id !== run.id || command.generation !== run.generation) throw new CoreError('STALE_INPUT', '运行时消费了不属于当前运行的输入。');
      if (command.state === 'consumed') {
        if (run.messages.get(event.messageKey) !== command.input_message_id) throw new CoreError('INVALID_RUNTIME_EVENT', '重复消费回执改变了消息映射。');
        return;
      }
      const main = command.id === run.commandId;
      if (!command.input_message_id || run.messages.has(event.messageKey) || (main ? command.state !== 'accepted'
        : command.kind !== 'steer' || !run.dispatchedInputs.has(command.id) || !['steering', 'held'].includes(command.state))) {
        throw new CoreError('INVALID_RUNTIME_EVENT', '运行时消费回执没有对应的已接收输入。');
      }
      if (!main && this.store.message(run.assistantMessageId).status === 'running') throw new CoreError('INVALID_RUNTIME_EVENT', '上一条助手消息结束前不能消费下一条引导。');
      const assistantId = main ? run.assistantMessageId : randomUUID();
      this.change(run.conversationId, 'INPUT_CONSUMED', { runId: run.id, messageId: command.input_message_id }, () => {
        this.fence(run);
        if (!main) {
          const userId = command.input_message_id!;
          this.insertMessage(userId, run.conversationId, run.cursorId, run.id, 'user', command.text, 'complete', readAttachmentRefs(command.attachment_refs_json));
          this.insertMessage(assistantId, run.conversationId, userId, run.id, 'assistant', '', 'running');
          this.store.execute('UPDATE branches SET head_message_id=? WHERE id=?', assistantId, run.branchId);
          this.store.execute('UPDATE conversations SET tree_revision=tree_revision+1 WHERE id=?', run.conversationId);
        }
        this.store.execute("UPDATE commands SET state='consumed',error=NULL,updated_at=? WHERE id=?", new Date().toISOString(), command.id);
        if (event.checkpoint) {
          const checkpointHead = command.kind === 'completion' ? run.historyHead : command.input_message_id;
          this.store.saveCheckpoint(run.branchId, checkpointHead, event.checkpoint);
          if (command.kind === 'completion') this.store.execute('UPDATE conversation_completion_inputs SET consumed_checkpoint_head_id=? WHERE command_id=?', checkpointHead, command.id);
        }
      }, false);
      if (main) run.mainConsumed = true;
      else { run.assistantMessageId = assistantId; run.placeholderUsed = false; run.cursorId = command.input_message_id; }
      run.messages.set(event.messageKey, command.input_message_id);
      this.publishLatest(run.conversationId);
      queueMicrotask(() => { void this.deliverSteer(run); });
      return;
    }
    if (event.type === 'message_started') {
      if (event.role === 'user') {
        // Pi 先发用户消息开始，再发消费回执；权威映射只在消费事务中建立。
        const mapped = run.messages.get(event.messageKey);
        if (mapped && this.store.message(mapped).role !== 'user') throw new CoreError('INVALID_RUNTIME_EVENT', '用户消息标识改变了角色。');
        if (event.inputId) {
          const command = this.store.command(event.inputId);
          if (command.conversation_id !== run.conversationId || command.run_id !== run.id || command.generation !== run.generation) throw new CoreError('STALE_INPUT', '用户消息不属于当前运行的输入。');
        }
        return;
      }
      if (run.messages.has(event.messageKey)) {
        if (this.store.message(run.messages.get(event.messageKey)!).role !== event.role) throw new CoreError('INVALID_RUNTIME_EVENT', '运行时消息标识改变了角色。');
        return;
      }
      if (!run.mainConsumed || (run.placeholderUsed && this.store.message(run.assistantMessageId).status === 'running')) throw new CoreError('INVALID_RUNTIME_EVENT', '助手消息开始顺序无效。');
      const assistantId = run.placeholderUsed ? randomUUID() : run.assistantMessageId;
      this.change(run.conversationId, 'MESSAGE_STARTED', { runId: run.id, messageId: assistantId }, () => {
        this.fence(run);
        if (run.placeholderUsed) {
          this.insertMessage(assistantId, run.conversationId, run.cursorId, run.id, 'assistant', '', 'running');
          this.store.execute('UPDATE branches SET head_message_id=? WHERE id=?', assistantId, run.branchId);
          this.store.execute('UPDATE conversations SET tree_revision=tree_revision+1 WHERE id=?', run.conversationId);
        }
      }, false);
      run.assistantMessageId = assistantId;
      run.messages.set(event.messageKey, assistantId); run.placeholderUsed = true;
      this.publishLatest(run.conversationId);
      return;
    }
    if (event.type === 'text_delta') {
      if (run.cancelled || !event.delta) return;
      const messageId = run.messages.get(event.messageKey);
      if (!messageId || this.store.message(messageId).role !== 'assistant' || this.store.message(messageId).status !== 'running') throw new CoreError('INVALID_RUNTIME_EVENT', '文本事件没有对应的正在生成的助手消息。');
      this.change(run.conversationId, 'TEXT_DELTA', { runId: run.id, messageId, delta: event.delta }, () => {
        this.fence(run);
        this.store.execute('UPDATE messages SET text=text||? WHERE id=?', event.delta, messageId);
      });
      if (this.store.message(messageId).text.length > 1_000_000) void this.abort(run.id, run.conversationId);
      return;
    }
    if (event.type === 'thinking_delta') {
      if (run.cancelled || !event.delta) return;
      const messageId = run.messages.get(event.messageKey);
      if (!messageId || this.store.message(messageId).role !== 'assistant' || this.store.message(messageId).status !== 'running') throw new CoreError('INVALID_RUNTIME_EVENT', '思考事件没有对应的正在生成的助手消息。');
      this.change(run.conversationId, 'THINKING_DELTA', { runId: run.id, messageId, delta: event.delta }, () => this.fence(run));
      return;
    }
    if (event.type === 'message_finalized') {
      const messageId = run.messages.get(event.messageKey);
      if (!messageId) throw new CoreError('INVALID_RUNTIME_EVENT', '最终消息没有对应的核心消息。');
      const stored = this.store.message(messageId);
      if (stored.role !== event.role || (event.role === 'user' && stored.text !== event.text)) throw new CoreError('INVALID_RUNTIME_EVENT', '最终消息改变了已接收的角色或用户输入。');
      this.change(run.conversationId, 'MESSAGE_FINALIZED', { runId: run.id, messageId }, () => {
        this.fence(run);
        const status = event.role === 'user' ? 'complete' : run.cancelled || event.rawStopReason === 'aborted' ? 'interrupted' : event.failureCode ? 'error' : 'complete';
        this.store.execute('UPDATE messages SET text=?,status=?,native_json=?,usage_json=?,raw_stop_reason=?,failure_code=?,finalized_at=? WHERE id=?',
          run.cancelled && event.role === 'assistant' ? stored.text : event.text, status, event.nativeMessage ? JSON.stringify(event.nativeMessage) : null, event.usage ? JSON.stringify(event.usage) : null,
          event.rawStopReason ?? null, event.failureCode ?? null, new Date().toISOString(), messageId);
        if (event.checkpoint) this.store.saveCheckpoint(run.branchId, messageId, event.checkpoint);
      }, false);
      run.cursorId = messageId;
      this.publishLatest(run.conversationId);
      return;
    }
    if (event.type === 'checkpoint') {
      try { this.store.database.transaction(() => { this.fence(run); this.store.saveCheckpoint(run.branchId, run.cursorId, event.checkpoint); }); }
      catch (error) { if (error instanceof CoreError) throw error; this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503); }
      return;
    }
    if (event.type === 'context_appended') {
      const messageId = run.messages.get(event.afterMessageKey);
      if (!messageId || this.store.message(messageId).role !== 'assistant' || !Array.isArray(event.nativeMessages) || !event.nativeMessages.length) throw new CoreError('INVALID_RUNTIME_EVENT', '附加上下文没有对应的助手消息。');
      try {
        this.store.database.transaction(() => {
          this.fence(run);
          const previous = this.store.message(messageId).native_context_json;
          const following = previous ? JSON.parse(previous) as unknown[] : [];
          this.store.execute('UPDATE messages SET native_context_json=? WHERE id=?', JSON.stringify([...following, ...event.nativeMessages]), messageId);
          this.store.saveCheckpoint(run.branchId, messageId, event.checkpoint);
        });
      } catch (error) { if (error instanceof CoreError) throw error; this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503); }
      return;
    }
    if (event.type === 'input_missed') {
      const command = this.store.command(event.inputId);
      if (command.conversation_id !== run.conversationId || command.run_id !== run.id || command.generation !== run.generation || command.kind !== 'steer') throw new CoreError('STALE_INPUT', '未消费回执不属于当前运行的引导。');
      if (command.state === 'consumed') return;
      this.change(run.conversationId, 'QUEUE_UPDATED', { runId: run.id }, () => {
        this.fence(run);
        this.store.execute("UPDATE commands SET state='held',error='引导尚未进入模型，等待明确继续。' WHERE id=? AND state IN ('queued','steering','held')", event.inputId);
        this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', run.conversationId);
      });
    }
  }

  private finish(run: ActiveRun, result?: BackendRunResult, failure?: string, failureCode?: BackendFailureCode): StateEnvelope | undefined {
    if (this.active.get(run.conversationId) !== run) return;
    const interrupted = run.cancelled || result?.outcome === 'interrupted';
    const type = interrupted ? 'RUN_INTERRUPTED' : failure ? 'RUN_ERROR' : 'RUN_FINISHED';
    const event = this.change(run.conversationId, type, { runId: run.id, messageId: run.assistantMessageId, ...(failure && !interrupted ? { error: failure } : {}) }, () => {
      this.fence(run);
      const now = new Date().toISOString();
      this.store.execute('UPDATE runs SET state=?,settled_at=?,raw_stop_reason=?,failure_code=?,session_ref=? WHERE id=?',
        interrupted ? 'interrupted' : failure ? 'failed' : 'succeeded', now, result?.rawStopReason ?? (interrupted ? 'aborted' : null), failureCode ?? null, run.session?.id ?? null, run.id);
      this.store.execute("UPDATE messages SET status=?,finalized_at=?,raw_stop_reason=COALESCE(raw_stop_reason,?),failure_code=COALESCE(failure_code,?) WHERE run_id=? AND role='assistant' AND status='running'",
        interrupted ? 'interrupted' : failure ? 'error' : 'complete', now, result?.rawStopReason ?? (interrupted ? 'aborted' : null), failureCode ?? null, run.id);
      if (failure && !interrupted) this.store.execute("UPDATE messages SET status='error',failure_code=COALESCE(failure_code,?) WHERE id=? AND status='complete'", failureCode ?? 'provider', run.assistantMessageId);
      if (!run.mainConsumed) this.store.execute("UPDATE commands SET state='failed',error=? WHERE id=?", interrupted ? '输入开始前被停止。' : failure ?? '运行没有消费输入。', run.commandId);
      const missed = this.store.one("SELECT id FROM commands WHERE run_id=? AND kind='steer' AND state IN ('queued','steering','held')", run.id);
      if (missed) {
        this.store.execute("UPDATE commands SET state='held',error='当前运行已结束，此引导尚未消费。' WHERE run_id=? AND kind='steer' AND state IN ('queued','steering')", run.id);
        this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', run.conversationId);
      }
      this.store.execute('UPDATE conversations SET status=?,error=? WHERE id=?', interrupted ? 'INTERRUPTED' : failure ? 'ERROR' : 'IDLE', interrupted ? null : failure ?? null, run.conversationId);
      const head = this.store.branch(run.branchId).head_message_id;
      // 未消费输入或写入失败时，执行投影不代表已提交历史，保留最后确认的检查点。
      if (result && run.mainConsumed) this.store.saveCheckpoint(run.branchId, head, result.checkpoint);
    }, false);
    const head = this.store.branch(run.branchId).head_message_id;
    const cached = this.sessions.get(run.conversationId); if (cached) cached.headId = head;
    return { event, state: this.getState(run.conversationId) };
  }

  private deliverSteer(run: ActiveRun): Promise<void> {
    if (run.kind === 'compaction') return Promise.resolve();
    if (this.closing || this.storageFailure || run.cancelled || run.sendingDone || !run.started || !run.session || run.steerDispatching || this.active.get(run.conversationId) !== run) return Promise.resolve();
    let command: CommandRow | undefined;
    try {
      if (this.store.one("SELECT id FROM commands WHERE run_id=? AND kind='steer' AND state='steering'", run.id)) return Promise.resolve();
      command = this.store.one<CommandRow>("SELECT * FROM commands WHERE run_id=? AND kind='steer' AND state='queued' ORDER BY COALESCE(queue_order,rowid),rowid LIMIT 1", run.id);
    } catch { this.failStorage(); return Promise.resolve(); }
    if (!command) return Promise.resolve();
    run.steerDispatching = true;
    run.steerDone = this.dispatchSteer(run, command);
    return run.steerDone;
  }

  private async dispatchSteer(run: ActiveRun, command: CommandRow): Promise<void> {
    try {
      this.store.validateAttachmentRefs(run.conversationId, readAttachmentRefs(command.attachment_refs_json));
      this.change(run.conversationId, 'QUEUE_UPDATED', { runId: run.id }, () => {
        this.fence(run); this.store.execute("UPDATE commands SET state='steering' WHERE id=?", command.id);
      });
      run.dispatchedInputs.add(command.id);
      const disposition = await run.session!.steer(this.backendInput(run, command.id, command.input_message_id!, command.text));
      if (disposition.disposition !== 'queued' && !this.storageFailure && this.active.get(run.conversationId) === run && this.store.command(command.id).state !== 'consumed') {
        this.change(run.conversationId, 'QUEUE_UPDATED', { runId: run.id }, () => {
          this.fence(run);
          this.store.execute("UPDATE commands SET state='held',error='引导未进入模型，请明确重新投递。' WHERE id=? AND state<>'consumed'", command.id);
          this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', run.conversationId);
        });
      }
    } catch {
      if (!this.storageFailure && this.active.get(run.conversationId) === run) {
        try {
          this.change(run.conversationId, 'QUEUE_UPDATED', { runId: run.id }, () => {
            this.fence(run);
            if (this.store.command(command.id).state === 'consumed') return;
            this.store.execute("UPDATE commands SET state='held',error='运行时暂未接收引导，输入已保留。' WHERE id=? AND state<>'consumed'", command.id);
            this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', run.conversationId);
          });
        } catch { /* 持久化失败已经关闭写入；旧运行不再投递。 */ }
      }
    } finally {
      run.steerDispatching = false;
      if (!run.sendingDone) queueMicrotask(() => { void this.deliverSteer(run); });
    }
  }

  private drainQueue(conversationId: string): void {
    if (this.closing || this.storageFailure || this.active.has(conversationId) || this.interrupts.has(conversationId)) return;
    let pending: CommandRow | undefined;
    try {
      const c = this.store.conversation(conversationId);
      if (c.plugin_id !== 'pi' || c.visibility !== 'active' || c.queue_paused) return;
      const command = this.store.one<CommandRow>("SELECT * FROM commands WHERE conversation_id=? AND branch_id=? AND state='queued' AND kind IN ('queue','interrupt','completion') ORDER BY COALESCE(queue_order,rowid),rowid LIMIT 1", conversationId, c.selected_branch_id);
      if (!command) return;
      pending = command;
      if (command.kind === 'completion') {
        const row = this.store.one<{ origin_json: string; control_generation: number | null }>('SELECT origin_json,control_generation FROM conversation_completion_inputs WHERE command_id=?', command.id);
        let valid = false;
        try { valid = !!row && row.control_generation !== null && row.control_generation === this.completionControlGeneration()
          && JSON.stringify(this.captureTaskCompletionOrigin(JSON.parse(row.origin_json).sourceCommandId)) === row.origin_json; } catch { /* Stale origins remain visible, but never replay. */ }
        if (!valid) {
          this.change(conversationId, 'QUEUE_UPDATED', {}, () => this.store.execute("UPDATE commands SET state='cancelled',error='原始请求、分支或停止控制代次已变化，完成事件不再唤醒。' WHERE id=?", command.id));
          return;
        }
      }
      this.startRun({ conversationId, branch: this.store.branch(command.branch_id), text: command.text, requestId: command.request_id,
        digest: command.payload_hash, kind: command.kind, queuedCommandId: command.id,
        ...(command.kind === 'completion' ? { reuseUserId: command.input_message_id! } : {}) });
    }
    catch (error) {
      if (error instanceof TaskError) return;
      if (!(error instanceof CoreError)) this.failStorage();
      else if (pending && ['ATTACHMENT_NOT_FOUND', 'INVALID_ATTACHMENT_SOURCE', 'STALE_ATTACHMENT', 'ATTACHMENT_UNAVAILABLE', 'UNSUPPORTED_THINKING_LEVEL', 'RUN_CONFIGURATION_UNAVAILABLE'].includes(error.code)) {
        this.change(conversationId, 'QUEUE_UPDATED', {}, () => {
          this.store.execute("UPDATE commands SET state='held',error=? WHERE id=? AND state='queued'", error.message, pending!.id);
          this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', conversationId);
        });
      }
    }
  }

  private recoverInterruptedRuns(): void {
    const runs = this.store.all<RunRow>("SELECT * FROM runs WHERE state IN ('starting','running','stopping')");
    this.store.database.transaction(() => {
      for (const run of runs) {
        const completion = this.store.one<{ consumed_checkpoint_head_id: string | null }>(`SELECT i.consumed_checkpoint_head_id
          FROM commands c JOIN conversation_completion_inputs i ON i.command_id=c.id WHERE c.id=? AND c.kind='completion' AND c.state='consumed'`, run.command_id);
        if (completion?.consumed_checkpoint_head_id) {
          const branch = this.store.branch(run.branch_id);
          const placeholder = branch.head_message_id ? this.store.message(branch.head_message_id) : null;
          if (branch.checkpoint_json && placeholder?.run_id === run.id && placeholder.role === 'assistant'
            && placeholder.status === 'running' && !placeholder.native_json && placeholder.parent_id === branch.checkpoint_head_id) {
            const ancestor = this.store.one(`WITH RECURSIVE path(id,parent_id) AS (
              SELECT id,parent_id FROM messages WHERE id=? AND conversation_id=?
              UNION SELECT m.id,m.parent_id FROM messages m JOIN path p ON m.id=p.parent_id WHERE m.conversation_id=?
            ) SELECT id FROM path WHERE id=?`, branch.checkpoint_head_id, run.conversation_id, run.conversation_id, completion.consumed_checkpoint_head_id);
            // 已消费的宿主事实留在最后确认的执行检查点。未finalized的流式片段仍留界面，不能伪造为已完成原生消息。
            if (ancestor) this.store.execute('UPDATE branches SET checkpoint_head_id=? WHERE id=?', placeholder.id, branch.id);
          }
        }
        this.store.execute("UPDATE runs SET state='interrupted',settled_at=?,failure_code='restart' WHERE id=?", new Date().toISOString(), run.id);
        this.store.execute("UPDATE messages SET status='interrupted',failure_code='restart' WHERE run_id=? AND status='running'", run.id);
        this.store.execute("UPDATE conversations SET status='INTERRUPTED',error='上次运行因服务重启中断，已保存内容仍保留。',queue_paused=1 WHERE id=?", run.conversation_id);
        this.store.execute("UPDATE commands SET state='failed',error='输入已接收但未确认消费时服务重启；不会自动重放。' WHERE run_id=? AND state='accepted'", run.id);
        this.store.appendEvent(run.conversation_id, 'RUN_INTERRUPTED', { runId: run.id, error: '服务重启，原运行不自动重放。' });
      }
      const pending = this.store.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM commands WHERE state IN ('queued','steering') AND kind<>'completion'");
      for (const row of pending) {
        this.holdQueued(row.conversation_id, '服务重启，待发输入需明确继续。');
        this.store.appendEvent(row.conversation_id, 'QUEUE_UPDATED');
      }
    });
  }

  private insertMessage(id: string, conversationId: string, parentId: string | null, runId: string, role: 'user' | 'assistant', text: string, status: string, attachmentRefs: ConversationAttachmentRef[] = []): void {
    if (parentId && this.store.message(parentId).conversation_id !== conversationId) throw new CoreError('INVALID_PARENT', '消息父节点不属于当前会话。');
    this.store.execute('INSERT INTO messages(id,conversation_id,parent_id,run_id,role,text,status,created_at,attachment_refs_json) VALUES(?,?,?,?,?,?,?,?,?)', id, conversationId, parentId, runId, role, text, status, new Date().toISOString(), JSON.stringify(attachmentRefs));
  }
  private holdQueued(conversationId: string, reason: string): void {
    if (!this.store.one("SELECT id FROM commands WHERE conversation_id=? AND state IN ('queued','steering')", conversationId)) return;
    this.store.execute("UPDATE commands SET state='held',error=? WHERE conversation_id=? AND state IN ('queued','steering')", reason, conversationId);
    this.store.execute('UPDATE conversations SET queue_paused=1 WHERE id=?', conversationId);
  }
  private tableExists(name: string): boolean {
    return !!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
  }
  /** 请求编号在命令、本机路由和本机消息账本中全局唯一；冻结前先拒绝旧记录。 */
  private assertRequestIdUnused(requestId: string): void {
    for (const table of ['commands', 'input_routes', 'direct_messages']) {
      if (this.tableExists(table) && this.store.one(`SELECT 1 FROM ${table} WHERE request_id=?`, requestId)) {
        throw new CoreError('SEND_REQUEST_CONFLICT', '此请求编号已在其他会话或本机记录中使用；不能为新冻结请求沿用。', 409);
      }
    }
  }
  /**
   * 只在尚无已受理命令时解析冻结请求。分支、内容、模式或运行必须与冻结身份一致；
   * 模型/人设配置使用冻结快照，并在派发时重新核对当前可用性。
   */
  private frozenDispatch(conversationId: string, requestId: string, payload: FrozenDispatchPayload, permissionPolicyVersion?: number | null): FrozenDispatch {
    const row = this.store.sendRequest(requestId);
    if (!row) throw new CoreError('SEND_REQUEST_REQUIRED', '发送前需要先持久保存本次请求；未确认的发送不能换号重发。', 409);
    if (row.conversation_id !== conversationId) throw new CoreError('SEND_REQUEST_CONFLICT', '发送请求不属于当前会话。', 409);
    const conversation = this.store.conversation(conversationId);
    if (row.branch_id !== conversation.selected_branch_id) {
      throw new CoreError('SEND_REQUEST_BRANCH_MISMATCH', '发送请求属于原分支，当前会话已切换分支；请回到原分支核对。', 409);
    }
    if (row.mode !== payload.mode) throw new CoreError('SEND_REQUEST_CONFLICT', '发送方式已变化，不能沿用原请求。', 409);
    if ((payload.mode === 'send' || payload.mode === 'queue') && row.expected_run_id !== null) {
      throw new CoreError('SEND_REQUEST_CONFLICT', '普通发送不能绑定原运行。', 409);
    }
    if (payload.mode === 'interrupt' && payload.expectedRunId !== undefined && payload.expectedRunId !== null
      && payload.expectedRunId !== row.expected_run_id) {
      throw new CoreError('SEND_REQUEST_CONFLICT', '打断请求绑定的原运行已变化。', 409);
    }
    const digest = sendRequestDigest(conversationId, row.branch_id, payload.mode, payload.text, payload.attachmentRefs, row.expected_run_id);
    if (row.digest !== digest) throw new CoreError('SEND_REQUEST_CONFLICT', '同一请求编号不能承载不同内容。', 409);
    if (readSendRoute(row.route_json).kind !== 'model') {
      throw new CoreError('SEND_REQUEST_ROUTE_REQUIRED', '原请求绑定本机动作，不能进入模型派发。', 409);
    }
    if (row.state === 'abandoned') throw new CoreError('SEND_REQUEST_ABANDONED', '原发送请求已放弃，请重新编辑后发送。', 409);
    if (row.state === 'accepted') {
      if (this.sendRequestView(row).state === 'unknown') throw new CoreError('SEND_REQUEST_UNKNOWN', '原请求没有可核对的命令或任务，受理事实待核。', 409);
      throw new CoreError('SEND_REQUEST_ALREADY_ACCEPTED', '原请求已受理，请回原任务或队列核对。', 409);
    }
    const dependencies = JSON.parse(row.dependency_json) as SendRequestDependencies;
    if (permissionPolicyVersion !== undefined && permissionPolicyVersion !== null
      && dependencies.permissionPolicyVersion !== null && permissionPolicyVersion !== dependencies.permissionPolicyVersion) {
      throw new CoreError('SEND_REQUEST_PERMISSION_CHANGED', '权限策略已变化，原请求不能沿用；请重新核对后发送。', 409);
    }
    const configuration = JSON.parse(row.configuration_json) as FrozenRunConfiguration;
    if (payload.mode === 'steer') {
      const active = this.active.get(conversationId);
      if (!active) throw new CoreError('STALE_RUN', '原运行已结束，引导请求仍保留但不能派发。', 409);
      if (row.expected_run_id !== active.id) throw new CoreError('STALE_RUN', '原运行已变化，引导请求不能改投其他运行。', 409);
      const activeConfiguration = this.runConfiguration(active.id);
      if (!activeConfiguration || JSON.stringify(activeConfiguration) !== JSON.stringify(configuration)
        || row.thinking_level !== active.thinkingLevel) {
        throw new CoreError('SEND_REQUEST_CONFIGURATION_CHANGED', '原运行的模型配置已变化，引导不能套用其他配置。', 409);
      }
    } else {
      // 不能悄悄改用当前默认模型：冻结快照必须仍与当前实际运行配置一致。
      this.runtimePreferences?.validate(configuration, false);
    }
    return { row, configuration, draft: { key: row.draft_key, revision: row.draft_revision }, thinkingLevel: row.thinking_level };
  }
  private sendRequestView(row: SendRequestRow): SendRequestView {
    const route = readSendRoute(row.route_json);
    // 受理记录必须同时匹配请求编号、会话、分支和内容身份；不借用其他会话的命令或任务。
    const expectedDigest = digestOperationArgs({ conversationId: row.conversation_id, text: row.text,
      draft: { key: row.draft_key, revision: row.draft_revision } });
    const commandCandidate = this.store.one<CommandRow>('SELECT * FROM commands WHERE request_id=?', row.request_id);
    const command = commandCandidate && commandCandidate.conversation_id === row.conversation_id
      && commandCandidate.branch_id === row.branch_id && commandCandidate.text === row.text
      && commandCandidate.attachment_refs_json === row.attachment_refs_json
      && commandCandidate.kind === row.mode ? commandCandidate : undefined;
    const inputRouteHasBranch = !!this.store.one("SELECT name FROM pragma_table_info('input_routes') WHERE name='branch_id'");
    const routeCandidate = this.tableExists('input_routes')
      ? this.store.one<{ digest: string; conversation_id: string; branch_id: string; task_id: string }>(
        `SELECT digest,conversation_id,${inputRouteHasBranch ? 'branch_id' : "'' AS branch_id"},task_id FROM input_routes WHERE request_id=?`, row.request_id) : undefined;
    const inputRoute = routeCandidate && routeCandidate.conversation_id === row.conversation_id
      && (routeCandidate.branch_id === '' || routeCandidate.branch_id === row.branch_id)
      && routeCandidate.digest === expectedDigest ? routeCandidate : undefined;
    const directCandidate = this.tableExists('direct_messages')
      ? this.store.one<{ digest: string; conversation_id: string; task_id: string | null }>('SELECT digest,conversation_id,task_id FROM direct_messages WHERE request_id=?', row.request_id) : undefined;
    const directMessage = directCandidate && directCandidate.conversation_id === row.conversation_id && directCandidate.digest === expectedDigest ? directCandidate : undefined;
    const foreign = (!!commandCandidate && !command) || (!!routeCandidate && !inputRoute) || (!!directCandidate && !directMessage);
    const run = command?.run_id ? this.store.one<RunRow>('SELECT * FROM runs WHERE id=?', command.run_id) : undefined;
    let state: SendRequestState = row.state;
    if (command || inputRoute || directMessage) state = 'accepted';
    else if (state === 'accepted') state = 'unknown';
    const taskId = run?.task_id ?? inputRoute?.task_id ?? directMessage?.task_id ?? null;
    if (state === 'accepted' && taskId && this.tableExists('tasks')) {
      const task = this.store.one<{ conversation_id: string | null }>('SELECT conversation_id FROM tasks WHERE id=?', taskId);
      // 任务也必须属于本会话；历史无会话任务保持兼容，但不采用其他会话的任务。
      if (!task || (task.conversation_id !== null && task.conversation_id !== row.conversation_id)) state = 'unknown';
    }
    if (state === 'accepted' && row.state !== 'accepted') {
      try {
        if (command) this.store.acceptSendRequest(row.request_id, command.id, command.run_id, run?.task_id ?? null);
        else if (inputRoute) this.store.acceptSendRequest(row.request_id, `route:${row.request_id}`, null, inputRoute.task_id);
        else if (directMessage) this.store.acceptSendRequest(row.request_id, `direct:${row.request_id}`, null, directMessage.task_id);
      } catch { /* 命令或任务仍是受理权威；读取时继续按原记录核对。 */ }
    }
    const error = state === 'unknown'
      ? (foreign ? '受理记录与冻结身份不匹配，当前仅保留待核，不采用其他会话记录。' : '受理记录缺少可核对的命令或任务，当前只能保留待核，不能换号重发。')
      : row.error;
    const accepted = state === 'accepted';
    return {
      requestId: row.request_id, conversationId: row.conversation_id, branchId: row.branch_id, mode: row.mode,
      text: row.text, attachmentRefs: readAttachmentRefs(row.attachment_refs_json), draft: { key: row.draft_key, revision: row.draft_revision },
      expectedRunId: row.expected_run_id, state, route, dependencies: JSON.parse(row.dependency_json) as SendRequestDependencies,
      commandId: accepted ? command?.id ?? (inputRoute || directMessage ? `direct:${row.request_id}` : null) : null,
      runId: accepted ? command?.run_id ?? null : null, taskId: accepted ? taskId : null,
      commandState: command?.state ?? (state === 'accepted' ? 'accepted' : null), error,
      createdAt: row.created_at, updatedAt: row.updated_at, acceptedAt: row.accepted_at,
    };
  }
  private markSendRequestAccepted(requestId: string, receipt: SendReceipt): void {
    try { this.store.acceptSendRequest(requestId, receipt.commandId, receipt.runId, receipt.taskId ?? null); }
    catch { /* 命令已提交时，投影修复不能反向否定受理事实。 */ }
  }
  private markSendRequestRejected(requestId: string, error: unknown): void {
    try {
      const command = this.store.one<CommandRow>('SELECT * FROM commands WHERE request_id=?', requestId);
      if (command) { this.markSendRequestAccepted(requestId, commandReceipt(command)); return; }
      if (error instanceof CoreError && ['SEND_REQUEST_CONFLICT', 'SEND_REQUEST_ABANDONED', 'SEND_REQUEST_UNKNOWN',
        'SEND_REQUEST_REQUIRED', 'SEND_REQUEST_ALREADY_ACCEPTED'].includes(error.code)) return;
      const code = error instanceof CoreError ? error.code
        : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DISPATCH_FAILED';
      const message = error instanceof Error ? error.message : '发送尚未受理，草稿与原请求仍保留。';
      this.store.rejectSendRequest(requestId, code, message.slice(0, 1_000));
    } catch { /* 保留原请求记录，读取时按命令核对受理事实。 */ }
  }
  private previousReceipt(requestId: string, digest: string): SendReceipt | undefined {
    const previous = this.store.one<CommandRow>('SELECT * FROM commands WHERE request_id=?', requestId);
    if (!previous) {
      for (const table of ['input_routes', 'direct_messages']) {
        if (this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)
          && this.store.one(`SELECT request_id FROM ${table} WHERE request_id=?`, requestId)) {
          throw new CoreError('REQUEST_CONFLICT', '此请求编号已经用于本机输入，不能改为另一条会话输入。');
        }
      }
      return undefined;
    }
    if (previous.payload_hash !== digest) throw new CoreError('REQUEST_CONFLICT', '同一请求标识不能用于不同输入或操作。');
    return commandReceipt(previous);
  }
  private backendInput(run: ActiveRun, inputId: string, messageId: string, text: string): BackendInput {
    const completion = this.store.one<{ completion_json: string }>('SELECT completion_json FROM conversation_completion_inputs WHERE command_id=?', inputId);
    return { inputId, messageId, text, conversationId: run.conversationId, branchId: run.branchId, runId: run.id, generation: run.generation, thinkingLevel: run.thinkingLevel,
      ...(completion ? { contextEvent: JSON.parse(completion.completion_json) as BackendInput['contextEvent'] } : {}) };
  }
  private conversationThinking(id: string): ConversationThinking | undefined {
    const conversation = this.store.conversation(id);
    if (conversation.plugin_id !== 'pi') return undefined;
    let configuration;
    try { configuration = this.backendFor(conversation.backend_id).thinking; }
    catch (error) { if (!(error instanceof ConfigError)) throw error; }
    return { defaultLevel: configuration?.defaultLevel ?? 'off', supportedLevels: [...(configuration?.supportedLevels ?? ['off'])],
      level: this.runtimePreferences?.thinkingLevel() ?? conversation.thinking_level ?? configuration?.defaultLevel ?? 'off' };
  }
  private acceptedThinkingLevel(id: string, requested?: ThinkingLevel): ThinkingLevel {
    const configuration = this.conversationThinking(id)!;
    const level = requested ?? configuration.level;
    if (!configuration.supportedLevels.includes(level)) throw new CoreError('UNSUPPORTED_THINKING_LEVEL', '当前模型不支持所保存的思考档位，请重新选择后再发送。', 400);
    return level;
  }
  private abortBackend(run: ActiveRun): void {
    if (run.session && !run.abortDone) run.abortDone = Promise.resolve().then(() => run.session!.abort()).catch(() => {});
  }
  private async discardSession(conversationId: string): Promise<void> {
    const cached = this.sessions.get(conversationId); this.sessions.delete(conversationId);
    if (cached) {
      try { await cached.session.dispose(); } catch { /* 执行实例已经隔离，清理故障不能阻止运行确认结束。 */ }
    }
  }
  private backendFor(id: string): Backend { return id === this.backend.id ? this.backend : this.options.registry?.get(id) ?? (() => { throw new ConfigError(`运行后端 ${id} 当前不可用。`); })(); }
  private assertIdle(id: string): void {
    if (this.active.has(id) || this.interrupts.has(id) || this.store.one("SELECT id FROM runs WHERE conversation_id=? AND state IN ('starting','running','stopping')", id)) throw new CoreError('BUSY', '当前会话尚未结束，请先停止或等待。');
  }
  private assertActiveConversation(id: string): void {
    if (this.store.conversation(id).visibility !== 'active') throw new CoreError('CONVERSATION_INACTIVE', '请先恢复此会话，再发送、重试或继续队列。');
  }
  private assertModelConversation(id: string): void {
    if (this.store.conversation(id).plugin_id !== 'pi') {
      throw new CoreError('DIRECT_RUNTIME_ONLY', '本机会话只执行已配置的输入规则。请配置本机动作规则后发送，或切换到智能对话使用模型。', 409);
    }
  }
  private assertConversationSequence(id: string, sequence: number): void {
    if (this.store.conversation(id).sequence !== sequence) throw new CoreError('CONVERSATION_CONFLICT', '会话已更新，请刷新后重新操作。');
  }
  private assertNoActiveTasks(id: string): void {
    if (!this.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")) return;
    if (this.store.one("SELECT id FROM tasks WHERE conversation_id=? AND status IN ('starting','running','waiting_approval','pausing','cancelling','stopping') LIMIT 1", id)) {
      throw new CoreError('TASK_BUSY', '此会话仍有关联任务正在执行或等待审批，请先处理任务。');
    }
  }
  private assertTreeRevision(id: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || this.store.conversation(id).tree_revision !== revision) throw new CoreError('TREE_CONFLICT', '历史结构已更新，请以最新会话重新操作。');
  }
  private assertWritable(): void {
    if (this.storageFailure) throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure, 503);
    if (this.closing) throw new CoreError('CLOSING', '服务正在关闭。', 503);
  }
  private fence(run: ActiveRun): void {
    if (!this.ownsPersistedRun(run)) throw new CoreError('STALE_RUN', '运行所有权已变化，旧结果不能覆盖当前状态。');
  }
  private ownsPersistedRun(run: ActiveRun, includeStopping = true): boolean {
    // 一次SQLite读取同时核对运行所有权和会话代次；旧进程的内存锁不构成动作资格。
    return !!this.store.one(`SELECT r.id FROM runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.id=? AND r.owner_epoch=? AND r.generation=? AND r.conversation_id=? AND r.branch_id=?
      AND r.state IN ('starting','running',?) AND c.generation=? AND c.selected_branch_id=?`,
    run.id, this.ownerEpoch, run.generation, run.conversationId, run.branchId, includeStopping ? 'stopping' : 'running', run.generation, run.branchId);
  }
  private change(id: string, type: CoreEvent['type'], fields: Partial<CoreEvent>, mutation: () => void, publish = true): CoreEvent {
    let event!: CoreEvent;
    try { this.store.database.transaction(() => { mutation(); event = this.store.appendEvent(id, type, fields); }); }
    catch (error) {
      if (error instanceof CoreError) throw error;
      this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503);
    }
    if (publish) this.publish({ event, state: this.getState(id) });
    return event;
  }
  private publishLatest(id: string): void {
    try {
      const row = this.store.one<{ payload_json: string }>('SELECT payload_json FROM events WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1', id);
      this.publish({ state: this.getState(id), ...(row ? { event: JSON.parse(row.payload_json) as CoreEvent } : {}) });
    } catch (error) { if (error instanceof CoreError) throw error; this.failStorage(); throw new CoreError('STORAGE_UNAVAILABLE', this.storageFailure!, 503); }
  }
  private publish(envelope: StateEnvelope): void {
    for (const listener of this.listeners) {
      if (listener.conversationId && listener.conversationId !== envelope.state.conversationId) continue;
      try { listener.callback(envelope); } catch { /* 视图故障不能回滚已提交状态。 */ }
    }
  }
  private failStorage(): void {
    if (this.storageFailure) return;
    this.storageFailure = '本机存储暂时不可用，已停止新运行。请恢复存储后重启服务核对状态。';
    this.closing = true;
    for (const run of this.active.values()) { run.cancelled = true; this.abortBackend(run); }
    for (const id of new Set([...this.active.keys(), this.defaultId].filter(Boolean))) {
      try { this.publish({ state: this.getState(id) }); } catch { /* 数据库连读取也失败时，不能推测新的终态。 */ }
    }
  }
}

function validateInput(text: string, requestId: string): void {
  if (typeof text !== 'string' || !text.trim() || text.length > 32_000) throw new CoreError('INVALID_TEXT', '请输入1到32,000个字符。', 400);
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new CoreError('INVALID_REQUEST', '请求标识无效。', 400);
}
function validateDraftReference(draft?: { key: string; revision: number }): void {
  if (draft && (typeof draft.key !== 'string' || !Number.isSafeInteger(draft.revision) || draft.revision < 0)) throw new CoreError('INVALID_DRAFT', '草稿引用或版本无效。', 400);
}
function validateConversationPlugin(pluginId: ConversationPlugin): void {
  if (pluginId !== 'pi' && pluginId !== 'direct') throw new CoreError('INVALID_PLUGIN', '请选择智能对话或本机直接执行。', 400);
}
function payloadHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const MODEL_SEND_ROUTE: SendRequestRoute = Object.freeze({ kind: 'model', ruleId: null, ruleRevision: null,
  action: null, subjectDigest: null, versionsDigest: null });
function normalizeSendRoute(value: SendRequestRoute | undefined): SendRequestRoute {
  if (!value) return MODEL_SEND_ROUTE;
  if (!['model', 'local'].includes(value.kind)
    || (value.ruleId !== null && typeof value.ruleId !== 'string')
    || (value.ruleRevision !== null && !Number.isSafeInteger(value.ruleRevision))
    || (value.action !== null && typeof value.action !== 'string')
    || (value.subjectDigest !== null && typeof value.subjectDigest !== 'string')
    || (value.versionsDigest !== null && typeof value.versionsDigest !== 'string')) {
    throw new CoreError('INVALID_ROUTE', '发送请求的实际派发路由无效。', 400);
  }
  if (value.kind === 'model') return MODEL_SEND_ROUTE;
  return { kind: 'local', ruleId: value.ruleId, ruleRevision: value.ruleRevision, action: value.action,
    subjectDigest: value.subjectDigest, versionsDigest: value.versionsDigest };
}
function readSendRoute(json: string): SendRequestRoute {
  try {
    const value = JSON.parse(json) as SendRequestRoute;
    return normalizeSendRoute(value);
  } catch { return MODEL_SEND_ROUTE; }
}
function sameSendRoute(left: SendRequestRoute, right: SendRequestRoute): boolean {
  return left.kind === right.kind && left.ruleId === right.ruleId && left.ruleRevision === right.ruleRevision
    && left.action === right.action && left.subjectDigest === right.subjectDigest && left.versionsDigest === right.versionsDigest;
}
/**
 * 请求身份只包含会话、分支、方式、文字、附件版本和原运行；草稿修订另行保存，
 * 用于只退休原修订。相同内容可安全沿用同一请求，不因自动保存推进版本而换号。
 */
function sendRequestDigest(conversationId: string, branchId: string, mode: SendRequestMode, text: string,
  attachmentRefs: ConversationAttachmentRef[], expectedRunId: string | null): string {
  return payloadHash({ version: 1, conversationId, branchId, mode, text, ...attachmentPayload(attachmentRefs), expectedRunId });
}
function sendRequestDependencies(configuration: FrozenRunConfiguration, thinkingLevel: ThinkingLevel,
  permissionPolicyVersion: number | null): SendRequestDependencies {
  return {
    modelId: configuration.modelId, provider: configuration.provider,
    modelConfigurationVersion: configuration.modelConfigurationVersion, thinkingLevel,
    preferenceRevision: configuration.preferenceRevision, personaSelectionRevision: configuration.personaSelectionRevision,
    internalAgentRules: configuration.internalAgentRules ?? null,
    permissionPolicyVersion, configurationDigest: payloadHash(configuration),
  };
}
function attachmentPayload(refs: ConversationAttachmentRef[]): { attachmentRefs?: ConversationAttachmentRef[] } {
  return refs.length ? { attachmentRefs: refs } : {};
}
function failureText(code?: string): string {
  if (code === 'budget') return '本轮或原业务目标的模型请求预算已用完，已停止新的请求；已有对话、工具结果和任务记录已保留。';
  if (code === 'length') return '本轮达到模型输出预算，已有内容已保存，可以重试或继续。';
  if (code === 'empty') return '模型结束但没有返回文本；已有会话保留，请检查模型参数或重新发送。';
  if (code === 'protocol') return '模型返回内容与运行协议不一致，已保存可核对记录。';
  if (code === 'storage') return '本机存储未确认写入，当前运行需要恢复核对。';
  return '模型请求失败，请检查服务配置或稍后重试。已有对话仍保留。';
}
function safeError(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof SessionInvalidError || error instanceof CoreError) return failureText('protocol');
  return failureText('provider');
}

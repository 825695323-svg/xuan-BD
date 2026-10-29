import { createHash, randomUUID } from 'node:crypto';
import type { PersonalCore } from './core.js';
import { TaskError, type TaskRuntime } from '../../../platform/jobs/tasks.js';
import { CoreError } from '../../../platform/runtime/errors.js';
import type { StateEnvelope } from '../../../contracts/contracts.js';
import type { JsonValue, TaskRecoveryResult } from '../../../contracts/task-contracts.js';
import type { AgentSkillService } from '../agent-skills.js';

export interface PiTaskRuntimeOptions { timeoutMs?: number; stopTimeoutMs?: number; agentSkills?: AgentSkillService }
type Completion = { terminal: StateEnvelope } | { unknown: true };
export function piTaskRequestId(taskId: string, attemptId: string): string {
  return 'task_' + createHash('sha256').update(taskId + ':' + attemptId).digest('hex');
}

/** 智能任务复用同一会话执行链；每次尝试只提交一次输入，并等待可确认的运行终态。 */
export function createPiTaskRuntime(core: PersonalCore, onConversationInterrupted: (taskId: string) => void, options: PiTaskRuntimeOptions = {}): TaskRuntime {
  const timeoutMs = options.timeoutMs ?? 20 * 60_000, stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000
    || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60_000) throw new TaskError('INVALID_TIMEOUT', '智能任务时限无效。');
  return {
    id: 'pi',
    async execute(context) {
      const args = context.task.args;
      if (!['pi.prompt', 'pi.skill'].includes(context.task.action) || !args || typeof args !== 'object' || Array.isArray(args)
        || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32_000) {
        throw new TaskError('INVALID_TASK', '智能任务需要明确的文字请求。');
      }
      context.signal.throwIfAborted();
      if (context.task.action === 'pi.skill') {
        if (!options.agentSkills) throw new TaskError('AGENT_SKILL_UNAVAILABLE', '指令技能尚未配置。');
        const binding = options.agentSkills.bindAttempt(context);
        await context.emit({ type: 'checkpoint', checkpoint: { skillBindingId: binding.id, skillId: binding.skillId,
          skillVersion: binding.skillVersion, skillDigest: binding.digest } });
        context.signal.throwIfAborted();
      }
      let conversationId = context.task.conversationId;
      if (!conversationId) {
        const creationId = randomUUID();
        await context.emit({ type: 'side_effect_started', effectId: creationId, description: '建立任务的关联会话' });
        if (context.signal.aborted) await context.emit({ type: 'side_effect_result', effectId: creationId, outcome: 'not_applied', evidence: '停止发生在关联会话创建之前。' });
        context.signal.throwIfAborted();
        conversationId = core.createConversation(context.task.title).conversationId;
        await context.emit({ type: 'side_effect_result', effectId: creationId, outcome: 'succeeded', evidence: '关联会话已保存。', data: { conversationId } });
      }
      const id = conversationId, effectId = randomUUID();
      try { core.getState(id); } catch (error) { throw taskFailure(error); }
      const requestId = piTaskRequestId(context.task.id, context.attemptId);
      let chatRunId: string | undefined, terminal: StateEnvelope | undefined;
      let resultAttempted = false, effectStarted = false, stopReason: TaskError | undefined, progressFailure: unknown;
      let progress = Promise.resolve(), latestProgressAt = 0;
      let resolve!: (completion: Completion) => void;
      const completed = new Promise<Completion>((done) => { resolve = done; });
      let stopping: Promise<void> | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined;
      const captureTerminal = () => {
        if (!chatRunId || terminal) return;
        const row = core.store.run(chatRunId);
        if (!['succeeded', 'failed', 'interrupted'].includes(row.state) || !row.settled_at) return;
        const state = core.getState(id);
        const type = row.state === 'succeeded' ? 'RUN_FINISHED' : row.state === 'interrupted' ? 'RUN_INTERRUPTED' : 'RUN_ERROR';
        terminal = { state, event: { type, conversationId: id, runId: chatRunId, messageId: null, sequence: state.sequence, timestamp: row.settled_at } };
        resolve({ terminal });
      };
      const requestStop = (reason: TaskError) => {
        stopReason ??= reason;
        if (stopping || !chatRunId || terminal) return;
        stopTimer = setTimeout(() => resolve({ unknown: true }), stopTimeoutMs);
        stopping = core.abort(chatRunId, id).then(() => { try { captureTerminal(); } catch { /* 持久终态无法读取时继续等待有界核对。 */ } })
          .catch(() => { /* 停止失败不能推断动作未发生；等待终态或保留未知。 */ });
      };
      const stop = () => requestStop(new TaskError('TASK_STOPPED', '任务已请求停止。'));
      const unsubscribe = core.subscribe((envelope) => {
        if (envelope.state.conversationId !== id) return;
        const event = envelope.event;
        if (!event && envelope.state.storageError) { requestStop(new TaskError('STORAGE_UNAVAILABLE', '会话存储需要恢复，运行结果尚未确认。')); return; }
        if (!event?.runId) return;
        if (!chatRunId) {
          try {
            const row = core.store.run(event.runId);
            if (row.task_id !== context.task.id || core.store.command(row.command_id).request_id !== requestId) return;
            chatRunId = event.runId;
          } catch { return; }
        }
        if (event.runId !== chatRunId) return;
        if (['RUN_FINISHED', 'RUN_ERROR', 'RUN_INTERRUPTED'].includes(event.type)) {
          terminal = envelope; resolve({ terminal: envelope });
        } else if (event.type === 'TEXT_DELTA' && !context.signal.aborted && !stopReason && !progressFailure && Date.now() - latestProgressAt >= 500) {
          latestProgressAt = Date.now();
          progress = progress.then(async () => {
            if (context.signal.aborted || stopReason) return;
            await context.emit({ type: 'progress', message: '正在整理回复，内容显示在关联会话中。' });
          }).catch((error: unknown) => { progressFailure = error; requestStop(new TaskError('PROGRESS_NOT_SAVED', '任务进度未能保存，正在停止关联会话。')); });
        }
      }, id);
      context.signal.addEventListener('abort', stop, { once: true });
      const deadline = setTimeout(() => requestStop(new TaskError('TASK_TIMEOUT', '智能任务超过本次运行时限，已请求停止。')), timeoutMs);
      const confirm = async (envelope: StateEnvelope) => {
        if (resultAttempted) return;
        resultAttempted = true;
        const row = core.store.run(chatRunId!);
        await context.emit({ type: 'side_effect_result', effectId, outcome: row.state === 'succeeded' ? 'succeeded' : 'failed',
          evidence: '核心运行 ' + chatRunId + ' 已持久化终态 ' + row.state + '。',
          data: { conversationId: id, chatRunId: chatRunId!, status: row.state, failureCode: row.failure_code, rawStopReason: row.raw_stop_reason } });
        await context.emit({ type: 'checkpoint', checkpoint: { conversationId: id, chatRunId: chatRunId!, requestId,
          settled: true, status: row.state, stopConfirmed: !!stopReason } });
        const usage = runUsage(core, chatRunId!);
        if (usage.tokens > 0 || usage.estimatedCostMicros > 0) context.consumeBudget(usage);
      };
      const retainUnknown = async () => {
        await context.emit({ type: 'checkpoint', checkpoint: { conversationId: id, chatRunId: chatRunId ?? null, requestId,
          stopRequested: true, stopConfirmed: false, outcome: 'unknown', reason: stopReason?.code ?? 'STOP_UNCONFIRMED' } });
      };
      try {
        await context.emit({ type: 'side_effect_started', effectId, description: '运行关联会话', operation: { conversationId: id, requestId } });
        effectStarted = true;
        try {
          context.signal.throwIfAborted();
          if (stopReason) throw stopReason;
          const receipt = core.sendMessage(id, args.prompt, requestId, { taskId: context.task.id });
          chatRunId = receipt.runId ?? chatRunId;
          if (!chatRunId) throw new TaskError('RUN_NOT_STARTED', '智能任务没有获得运行编号。');
        } catch (error) {
          // 接收之后的返回失败不能重新发送；先从同一请求的持久回执恢复所有权。
          let known = false;
          try {
            const command = core.store.one<{ run_id: string | null }>('SELECT run_id FROM commands WHERE request_id=?', requestId);
            known = true; chatRunId ??= command?.run_id ?? undefined;
          } catch { /* 无法查看接收结果时保留未确认副作用。 */ }
          if (!chatRunId) {
            if (known) {
              resultAttempted = true;
              await context.emit({ type: 'side_effect_result', effectId, outcome: 'not_applied', evidence: '同一请求的持久回执确认没有启动新的会话运行。' });
            }
            throw taskFailure(error);
          }
          await context.emit({ type: 'checkpoint', checkpoint: { conversationId: id, chatRunId, requestId, receiptError: taskFailure(error).code } });
        }
        await context.emit({ type: 'checkpoint', checkpoint: { conversationId: id, chatRunId: chatRunId!, requestId } });
        if (context.signal.aborted) stop();
        captureTerminal();
        const completion = await completed;
        await progress;
        if ('unknown' in completion) { await retainUnknown(); throw new TaskError('STOP_UNCONFIRMED', '尚未确认关联会话已经停止，请先核对。'); }
        await confirm(completion.terminal);
        if (progressFailure) throw taskFailure(progressFailure);
        const row = core.store.run(chatRunId!);
        if (row.state === 'interrupted') {
          if (!context.signal.aborted && !stopReason) onConversationInterrupted(context.task.id);
          throw stopReason ?? new TaskError('TASK_STOPPED', '关联会话已停止。');
        }
        if (row.state !== 'succeeded') throw new TaskError(failureCode(row.failure_code), completion.terminal.state.error ?? '智能任务未能完成。');
        const text = completion.terminal.state.messageTree.filter((message) => message.runId === chatRunId && message.role === 'assistant').map((message) => message.text).join('\n\n');
        return { summary: text.slice(0, 4000) || '智能任务已完成，结果保存在关联会话中。',
          data: { conversationId: id, chatRunId: chatRunId!, text: text.slice(0, 24_000), truncated: text.length > 24_000 } };
      } catch (error) {
        if (effectStarted && chatRunId && !resultAttempted) {
          requestStop(taskFailure(error));
          const completion = terminal ? { terminal } : await completed;
          await progress;
          if ('terminal' in completion) await confirm(completion.terminal);
          else await retainUnknown();
        }
        if (error instanceof TaskError && error.code === 'STOP_UNCONFIRMED' && terminal && resultAttempted) throw stopReason ?? new TaskError('TASK_STOPPED', '关联会话已停止。');
        throw taskFailure(error);
      } finally {
        clearTimeout(deadline); if (stopTimer) clearTimeout(stopTimer);
        context.signal.removeEventListener('abort', stop); unsubscribe();
        // 不能在 finally 中无界等待停止，也不能让迟到事件写入下一次任务尝试。
      }
    },
    /** 只读核对原会话、命令与运行身份；不调用核心发送入口，也不重新派发。 */
    async recover({ task, effects, signal }) {
      const checkpoint = record(task.checkpoint);
      const conversationId = typeof checkpoint?.conversationId === 'string' ? checkpoint.conversationId : null;
      const updates: TaskRecoveryResult['effects'] = [];
      const notes: string[] = [];
      let pending = false;
      for (const effect of effects) {
        if (effect.status !== 'started') continue;
        if (signal.aborted) throw new TaskError('RECOVERY_TIMEOUT', '原身份核对超时，事实仍未知。');
        const operation = record(effect.operation);
        const requestId = typeof operation?.requestId === 'string' ? operation.requestId : null;
        const effectConversation = typeof operation?.conversationId === 'string' ? operation.conversationId : conversationId;
        const update = (outcome: TaskRecoveryResult['effects'][number]['outcome'], evidence: string) => {
          updates.push({ attemptId: effect.attemptId, effectId: effect.effectId, outcome, evidence });
          notes.push(`${effect.effectId}: ${evidence}`);
        };
        const hold = (evidence: string) => { pending = true; notes.push(`${effect.effectId}: ${evidence}`); };
        if (!requestId) {
          // 会话创建动作：只核会话是否已持久存在；没有会话身份时保留待核。
          if (!effectConversation) { hold('没有可核对的会话身份。'); continue; }
          try { core.getState(effectConversation); update('succeeded', '关联会话已持久存在。'); }
          catch { update('not_applied', '关联会话未建立。'); }
          continue;
        }
        let command: { run_id: string | null } | undefined;
        try { command = core.store.one<{ run_id: string | null }>('SELECT run_id FROM commands WHERE request_id=?', requestId); }
        catch { hold('命令账读取失败。'); continue; }
        if (!command) { update('not_applied', '同一请求没有持久受理记录。'); continue; }
        if (!command.run_id) { hold('请求已受理但尚无关联运行。'); continue; }
        let run: { id: string; state: string };
        try { run = core.store.run(command.run_id); }
        catch { hold('运行记录不可读。'); continue; }
        if (run.state === 'succeeded') update('succeeded', `核心运行 ${run.id} 已持久化终态 succeeded。`);
        else if (run.state === 'failed' || run.state === 'interrupted') update('failed', `核心运行 ${run.id} 已持久化终态 ${run.state}。`);
        else hold(`核心运行 ${run.id} 尚未收束（${run.state}）。`);
      }
      if (updates.length === 0 && !pending) { pending = true; notes.push('没有已开始的副作用可供核对。'); }
      const outcome: TaskRecoveryResult['outcome'] = pending ? 'pending'
        : updates.every((update) => update.outcome === 'not_applied') ? 'not_applied'
          : updates.every((update) => update.outcome === 'succeeded') ? 'succeeded' : 'failed';
      const evidence = (outcome === 'pending' ? '原身份核对未全部收束：' : '原身份核对完成：') + notes.join('；');
      return { outcome, evidence: evidence.slice(0, 32_000), effects: updates };
    },
  };
}
function record(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}
/** 只读取原运行已持久化的用量；宿主未返回的费用记为 0，不伪造确认费用。 */
function runUsage(core: PersonalCore, runId: string): { tokens: number; estimatedCostMicros: number } {
  let rows: { usage_json: string | null; native_json: string | null }[];
  try { rows = core.store.all<{ usage_json: string | null; native_json: string | null }>(
    "SELECT usage_json,native_json FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid", runId); }
  catch { return { tokens: 0, estimatedCostMicros: 0 }; }
  let tokens = 0, estimatedCostMicros = 0;
  for (const row of rows) {
    try {
      const usage = row.usage_json ? JSON.parse(row.usage_json) as { inputTokens?: unknown; outputTokens?: unknown } : null;
      if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
        tokens += Number(usage.inputTokens) + Number(usage.outputTokens);
      }
    } catch { /* 单条用量损坏时保留其余已持久化事实。 */ }
    try {
      const native = row.native_json ? JSON.parse(row.native_json) as { usage?: { cost?: { total?: unknown } } } : null;
      const total = native?.usage?.cost?.total;
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) estimatedCostMicros += Math.round(total * 1_000_000);
    } catch { /* 费用未知时保留未知，不补造。 */ }
  }
  return { tokens, estimatedCostMicros };
}
function taskFailure(error: unknown): TaskError {
  if (error instanceof TaskError) return error;
  if (error instanceof CoreError) return new TaskError(error.code, error.message);
  if (error instanceof Error && error.name === 'AbortError') return new TaskError('TASK_STOPPED', '任务已请求停止。');
  return new TaskError('PI_RUNTIME_FAILED', '智能任务执行失败，已有运行记录已保留。');
}
function failureCode(value: string | null): string {
  return ({ provider: 'PI_PROVIDER_FAILED', empty: 'PI_EMPTY_RESPONSE', length: 'PI_RESPONSE_LIMIT', budget: 'MODEL_BUDGET_EXHAUSTED', protocol: 'PI_PROTOCOL_ERROR',
    storage: 'PI_STORAGE_FAILED', not_started: 'PI_RUN_NOT_STARTED' } as Record<string, string>)[value ?? ''] ?? 'PI_RUN_FAILED';
}

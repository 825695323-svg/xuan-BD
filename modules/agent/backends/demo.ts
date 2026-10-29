import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionInvalidError } from '../../../platform/runtime/errors.js';
import { type Backend, type BackendCheckpoint, type BackendHistoryMessage, type BackendInput, type BackendEvent, type BackendRunResult } from '../../../contracts/backend.js';

interface DemoCheckpointPayload { turn: number; messages: BackendHistoryMessage[] }
interface DemoRun {
  input: BackendInput;
  controller: AbortController;
  inputs: BackendInput[];
  done: Promise<void>;
  settle(): void;
}

/** 本地演示遵守持久会话、真实输入消费和停止收口的统一契约。 */
export function createDemoBackend(intervalMs = 35): Backend {
  return {
    id: 'demo',
    async createSession(restore) {
      const checkpoint = restore?.checkpoint;
      let messages = structuredClone([...(restore?.history ?? [])]);
      let turn = messages.filter((message) => message.role === 'user').length;
      let id = `demo-${randomUUID()}`;
      if (checkpoint) {
        const payload = checkpoint.payload as Partial<DemoCheckpointPayload> | null;
        if (checkpoint.backendId !== 'demo' || checkpoint.format !== 'demo-session-v1' || checkpoint.version !== 1
          || !payload || !Number.isSafeInteger(payload.turn) || payload.turn! < 0 || !Array.isArray(payload.messages)
          || payload.messages.some((message) => !message || typeof message.id !== 'string'
            || typeof message.text !== 'string' || !['user', 'assistant'].includes(message.role))) {
          throw new SessionInvalidError('演示会话检查点无效。');
        }
        turn = payload.turn!;
        messages = structuredClone(payload.messages);
        id = checkpoint.sessionRef;
      }
      let active: DemoRun | undefined;
      let disposed = false;
      let unusable = false;
      let owner = restore ? { conversationId: restore.conversationId, branchId: restore.branchId } : undefined;
      const exportCheckpoint = async (): Promise<BackendCheckpoint> => ({
        backendId: 'demo', format: 'demo-session-v1', version: 1, sessionRef: id,
        payload: structuredClone({ turn, messages }),
      });
      const abort = async () => {
        const run = active;
        if (!run) return;
        run.controller.abort();
        await run.done;
      };
      return {
        id,
        exportCheckpoint,
        async send(input, emit) {
          if (disposed) throw new Error('演示会话已关闭。');
          if (unusable) throw new SessionInvalidError('演示状态提交失败，需要从已保存会话恢复。');
          if (active) throw new Error('演示会话正在生成。');
          if (owner && (input.conversationId !== owner.conversationId || input.branchId !== owner.branchId)) {
            throw new SessionInvalidError('输入不属于当前演示会话。');
          }
          owner ??= { conversationId: input.conversationId, branchId: input.branchId };
          let settle!: () => void;
          const run: DemoRun = { input, controller: new AbortController(), inputs: [input],
            done: new Promise<void>((resolve) => { settle = resolve; }), settle: () => settle() };
          active = run;
          let outcome: BackendRunResult['outcome'] = 'completed';
          let failureCode: BackendRunResult['failureCode'];
          const publish = async (event: BackendEvent) => {
            try { await emit(event); } catch {
              failureCode = 'storage';
              unusable = true;
              run.controller.abort();
              throw new Error('核心事件提交失败。');
            }
          };
          try {
            await publish({ type: 'run_started' });
            while (run.inputs.length > 0 && !run.controller.signal.aborted) {
              const next = run.inputs.shift()!;
              const createdAt = new Date().toISOString();
              const user: BackendHistoryMessage = { id: next.messageId, parentId: messages.at(-1)?.id ?? null,
                role: 'user', text: next.text, createdAt, status: 'complete' };
              messages.push(user);
              await publish({ type: 'message_started', messageKey: user.id, role: 'user', inputId: next.inputId });
              await publish({ type: 'input_consumed', inputId: next.inputId, messageKey: user.id,
                checkpoint: await exportCheckpoint() });
              await publish({ type: 'message_finalized', messageKey: user.id, role: 'user', text: user.text,
                nativeMessage: structuredClone(user), checkpoint: await exportCheckpoint() });
              turn += 1;
              const assistant: BackendHistoryMessage = { id: randomUUID(), parentId: user.id, role: 'assistant',
                text: '', createdAt, status: 'running' };
              messages.push(assistant);
              await publish({ type: 'message_started', messageKey: assistant.id, role: 'assistant' });
              const response = `这是本地演示的第 ${turn} 轮，没有调用模型。\n\n你发送了：${next.text}\n\n文字正在逐步显示。可以点击停止，再继续发送消息，检查同一会话的运行控制。接入模型后，这里将显示 Pi 返回的真实内容。`;
              try {
                for (const character of response) {
                  await delay(intervalMs, undefined, { signal: run.controller.signal });
                  assistant.text += character;
                  await publish({ type: 'text_delta', messageKey: assistant.id, delta: character });
                }
              } catch (error) {
                assistant.status = 'interrupted';
                if (!run.controller.signal.aborted) throw error;
              }
              assistant.status = run.controller.signal.aborted ? 'interrupted' : 'complete';
              if (!failureCode) await publish({ type: 'message_finalized', messageKey: assistant.id, role: 'assistant',
                text: assistant.text, nativeMessage: structuredClone(assistant),
                rawStopReason: run.controller.signal.aborted ? 'aborted' : 'stop', checkpoint: await exportCheckpoint() });
            }
            if (!failureCode) for (const missed of run.inputs) {
              await publish({ type: 'input_missed', inputId: missed.inputId, reason: '演示运行结束前未消费输入。' });
            }
          } catch {
            outcome = failureCode ? 'error' : 'interrupted';
          } finally {
            if (failureCode) outcome = 'error';
            else if (run.controller.signal.aborted) outcome = 'interrupted';
            active = undefined;
            run.settle();
          }
          return { outcome, failureCode, rawStopReason: outcome === 'completed' ? 'stop' : 'aborted',
            checkpoint: await exportCheckpoint() };
        },
        async steer(input) {
          const run = active;
          if (!run || run.controller.signal.aborted || disposed || unusable) return { disposition: 'missed' };
          if (input.conversationId !== run.input.conversationId || input.branchId !== run.input.branchId
            || input.runId !== run.input.runId || input.generation !== run.input.generation) {
            throw new SessionInvalidError('纠偏输入不属于当前演示运行。');
          }
          if (input.inputId === run.input.inputId || run.inputs.some((item) => item.inputId === input.inputId)) {
            throw new SessionInvalidError('演示运行已登记此输入。');
          }
          run.inputs.push(input);
          return { disposition: 'queued' };
        },
        abort,
        async dispose() { disposed = true; await abort(); },
      };
    },
  };
}

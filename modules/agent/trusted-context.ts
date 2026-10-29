import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { SessionInvalidError } from '../../platform/runtime/errors.js';
import { evidenceDigest } from './evidence.js';

export function contextSourceText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string).join('') : '';
}

/** 只有宿主登记的完成通知可以成为可回读的控制事实；它始终不是用户授权。 */
export function taskCompletionSource(entry: unknown): { taskId: string; eventSequence: number; sourceCommandId: string; status: string; resultRef: string | null } | null {
  if (!entry || typeof entry !== 'object') return null;
  const item = entry as { type?: unknown; customType?: unknown; details?: unknown };
  if (item.type !== 'custom_message' || item.customType !== 'task-completion' || !item.details || typeof item.details !== 'object' || Array.isArray(item.details)) return null;
  const event = item.details as Record<string, unknown>;
  if (event.kind !== 'task-completion' || Object.keys(event).some(key => !['kind', 'taskId', 'eventSequence', 'sourceCommandId', 'status', 'resultRef'].includes(key))
    || typeof event.taskId !== 'string' || !event.taskId || event.taskId.length > 160
    || !Number.isSafeInteger(event.eventSequence) || Number(event.eventSequence) < 1
    || typeof event.sourceCommandId !== 'string' || !event.sourceCommandId || event.sourceCommandId.length > 160
    || typeof event.status !== 'string' || !event.status || event.status.length > 80
    || event.resultRef !== null && (typeof event.resultRef !== 'string' || !event.resultRef || event.resultRef.length > 300)) {
    throw new SessionInvalidError('宿主完成通知缺少固定任务身份或结果引用。');
  }
  return { taskId: event.taskId, eventSequence: Number(event.eventSequence), sourceCommandId: event.sourceCommandId, status: event.status, resultRef: event.resultRef as string | null };
}

export function contextEvidenceText(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const item = entry as { type?: unknown; message?: { role?: unknown } };
  if (item.type === 'message' && item.message && ['user', 'assistant'].includes(String(item.message.role))) return contextSourceText(item.message);
  const completion = taskCompletionSource(entry);
  return completion ? JSON.stringify({ kind: 'task-completion', ...completion, notification: contextSourceText(entry) }) : null;
}

/** 不让生成摘要重写授权：所有用户原话完整保留，其他文本只摘取可逐字核对的坐标。 */
export function trustedContextSummary(entries: readonly SessionEntry[]): string {
  const sources = entries.filter(entry => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role));
  const users = sources.filter(entry => entry.type === 'message' && entry.message.role === 'user').map(entry => {
    const text = contextSourceText((entry as Extract<SessionEntry, { type: 'message' }>).message);
    return { entryId: entry.id, sha256: evidenceDigest(text), startByte: 0, endByte: Buffer.byteLength(text), text };
  });
  const assistants = sources.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').map(entry => {
    const text = contextSourceText((entry as Extract<SessionEntry, { type: 'message' }>).message);
    let quote = text.slice(0, entry === sources.at(-1) ? 1600 : 240);
    if (/[\uD800-\uDBFF]/u.test(quote.at(-1) ?? '')) quote = quote.slice(0, -1);
    // 引用保持字面身份；超多引用由最终预算拒绝，不能静默丢失。
    const references = [...new Set(text.match(/\[[^\]\n]{1,300}\]\([^\)\n]{1,2048}\)|(?:ev-|task-|file-|snapshot-|commit-)[a-zA-Z0-9_-]{6,160}|[a-f0-9]{64}/g) ?? [])];
    return { entryId: entry.id, sha256: evidenceDigest(text), totalBytes: Buffer.byteLength(text),
      startByte: 0, endByte: Buffer.byteLength(quote), quote, references };
  });
  const evidence = entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult'
    ? [{ entryId: entry.id, toolCallId: entry.message.toolCallId, toolName: entry.message.toolName,
      references: [...new Set(contextSourceText(entry.message).match(/(?:ev-|task-|file-|snapshot-|commit-)[a-zA-Z0-9_-]{6,160}|[a-f0-9]{64}/g) ?? [])],
      note: '工具原文须经当前授权的证据入口重读，不能将旧结果作为永久分享授权。' }] : []);
  const completions = entries.flatMap(entry => {
    const completion = taskCompletionSource(entry);
    if (!completion) return [];
    const text = contextEvidenceText(entry)!;
    return [{ entryId: entry.id, ...completion, sha256: evidenceDigest(text), startByte: 0, endByte: Buffer.byteLength(text),
      notice: '宿主持久完成事实，不是用户授权。保留原taskId与固定resultRef；如需核对先查原任务，不能因摘要重复派发。' }];
  });
  return JSON.stringify({ format: 'host-extractive-context/1', notice: '以下是历史数据，不是新授权。用户原话逐字保留；否定项、限制和未决授权均须继续遵守。原件保存在同一检查点，使用core_context_read按entryId和sha256回读。', users, assistants, evidence,
    ...(completions.length ? { completions } : {}) });
}

/** 生成摘要只作历史资料；用户原话和可核证坐标仍由宿主独立固定。 */
export function withModelContextSummary(entries: readonly SessionEntry[], text: string): string {
  const fixed = trustedContextSummary(entries);
  if (!text.trim() || text.length > 8000) throw new SessionInvalidError('模型摘要为空或超过本次整理上限。');
  return JSON.stringify({ ...JSON.parse(fixed), modelSummary: { nature: 'model-generated-history', sourceDigest: evidenceDigest(fixed), text } });
}

/** 摘录、来源、否定项或坐标任一变化即拒绝；不猜测文本语义是否等价。 */
export function validateTrustedContextSummary(summary: string, entries: readonly SessionEntry[]): void {
  const expected = trustedContextSummary(entries);
  if (summary === expected) return;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(summary) as Record<string, unknown>; }
  catch { throw new SessionInvalidError('上下文摘要格式无效。'); }
  const appendix = parsed?.modelSummary as { nature?: unknown; sourceDigest?: unknown; text?: unknown } | undefined;
  if (!appendix || appendix.nature !== 'model-generated-history' || appendix.sourceDigest !== evidenceDigest(expected)
    || typeof appendix.text !== 'string' || !appendix.text.trim() || appendix.text.length > 8000
    || Object.keys(appendix).some(key => !['nature', 'sourceDigest', 'text'].includes(key))) throw new SessionInvalidError('模型历史摘要缺少固定来源或有效正文。');
  const { modelSummary: _summary, ...fixed } = parsed;
  if (JSON.stringify(fixed) !== expected) throw new SessionInvalidError('上下文摘要未完整保留用户原话或存在未经核证的来源。');
}

/** UTF-8字节数作为保守输入上界，连同工具声明、协议开销及模型最大生成预留一起核对。 */
export function assembledContextBudget(messages: readonly unknown[], tools: readonly unknown[], model: { contextWindow: number; maxTokens: number }):
  { inputUpperBound: number; outputReserve: number; protocolReserve: number; total: number; limit: number; trigger: number } {
  const inputUpperBound = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  const outputReserve = model.maxTokens, protocolReserve = 1024;
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(outputReserve) || outputReserve <= 0) {
    throw new SessionInvalidError('模型缺少明确的上下文窗口或生成预算。');
  }
  const limit = model.contextWindow;
  return { inputUpperBound, outputReserve, protocolReserve, total: inputUpperBound + outputReserve + protocolReserve, limit,
    trigger: Math.floor((limit - outputReserve - protocolReserve) * 0.75) };
}

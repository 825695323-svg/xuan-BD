import type { ConversationContextUsage, ThinkingConfiguration, ThinkingLevel } from './contracts.js';

export interface BackendCheckpoint {
  backendId: string;
  format: string;
  version: number;
  sessionRef: string;
  payload: unknown;
}

export interface BackendHistoryMessage {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: 'running' | 'complete' | 'interrupted' | 'error';
  /** 适配器产生并经核心保存的原生消息，不接受浏览器提供。 */
  nativeMessage?: unknown;
  /** 跟随该消息的原生上下文（如配对的工具结果）；仅由适配器写入。 */
  nativeFollowing?: readonly unknown[];
}

export interface RestoreSessionInput {
  conversationId: string;
  branchId: string;
  history: readonly BackendHistoryMessage[];
  checkpoint?: BackendCheckpoint;
}

export interface BackendInput {
  inputId: string;
  messageId: string;
  conversationId: string;
  branchId: string;
  runId: string;
  generation: number;
  text: string;
  thinkingLevel?: ThinkingLevel;
  /** Host-owned event; it is never a new user instruction or an authorization. */
  contextEvent?: { kind: 'task-completion'; taskId: string; eventSequence: number; sourceCommandId: string; status: string; resultRef: string | null };
}

export interface BackendUsage {
  /** Pi归一化后的非缓存输入；公开展示须加上cacheReadTokens及cacheWriteTokens。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type BackendFailureCode = 'provider' | 'empty' | 'length' | 'budget' | 'protocol' | 'storage' | 'not_started';
export type BackendEvent =
  | { type: 'run_started' }
  | { type: 'input_consumed'; inputId: string; messageKey: string; checkpoint?: BackendCheckpoint }
  | { type: 'message_started'; messageKey: string; role: 'user' | 'assistant'; inputId?: string }
  | { type: 'text_delta'; messageKey: string; delta: string }
  | { type: 'thinking_delta'; messageKey: string; delta: string }
  | { type: 'context_usage'; contextUsage: ConversationContextUsage }
  | { type: 'message_finalized'; messageKey: string; role: 'user' | 'assistant'; text: string;
      nativeEntryRef?: string; nativeMessage?: unknown; rawStopReason?: string;
      failureCode?: BackendFailureCode; usage?: BackendUsage; checkpoint?: BackendCheckpoint }
  | { type: 'checkpoint'; checkpoint: BackendCheckpoint }
  | { type: 'context_appended'; afterMessageKey: string; nativeMessages: readonly unknown[]; checkpoint: BackendCheckpoint }
  | { type: 'input_missed'; inputId: string; reason: string };

export interface BackendRunResult {
  outcome: 'completed' | 'interrupted' | 'error';
  rawStopReason?: string;
  failureCode?: BackendFailureCode;
  checkpoint: BackendCheckpoint;
}

export interface BackendCompactionResult {
  outcome: 'completed' | 'interrupted' | 'error';
  changed: boolean;
  modelRequests: number;
  tokensBefore?: number;
  tokensAfter?: number;
  rawStopReason?: string;
  failureCode?: BackendFailureCode;
  /** 只有原生摘要安装成功后提供；失败或取消不得替换核心检查点。 */
  checkpoint?: BackendCheckpoint;
  contextUsage?: ConversationContextUsage;
}

export interface BackendSession {
  readonly id: string;
  send(input: BackendInput, emit: (event: BackendEvent) => Promise<void>): Promise<BackendRunResult>;
  compact?(input: BackendInput, emit: (event: BackendEvent) => Promise<void>): Promise<BackendCompactionResult>;
  steer(input: BackendInput): Promise<{ disposition: 'queued' | 'handled' | 'missed' }>;
  exportCheckpoint(): Promise<BackendCheckpoint>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface Backend {
  readonly id: string;
  readonly supportsCompaction?: boolean;
  readonly thinking?: ThinkingConfiguration;
  createSession(input?: RestoreSessionInput): Promise<BackendSession>;
}


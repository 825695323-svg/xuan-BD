export type MemoryCategory = 'identity' | 'profile' | 'preference' | 'decision' | 'experience' | 'project';
export type MemoryClaim = 'user_statement' | 'observation' | 'inference';
export type MemoryStatus = 'confirmed' | 'candidate' | 'conflict' | 'rejected' | 'superseded' | 'forgotten';
export type MemoryScope = { kind: 'global' } | { kind: 'conversation' | 'project'; id: string };
export interface MemorySource {
  kind: 'manual' | 'message' | 'file' | 'task' | 'memory';
  id: string;
  version: string;
  contentHash: string;
  observedAt: string;
}
export interface MemoryRecord {
  id: string;
  version: number;
  category: MemoryCategory;
  claim: MemoryClaim;
  scope: MemoryScope;
  topic: string;
  text: string;
  status: MemoryStatus;
  modelAllowed: boolean;
  sources: MemorySource[];
  createdAt: string;
  updatedAt: string;
  conflictsWith: string[];
}
export interface MemoryInput {
  category: MemoryCategory;
  claim: MemoryClaim;
  scope: MemoryScope;
  topic: string;
  text: string;
  /** 仅此条内容进入模型的明确许可；省略为 false，不授予文件或执行权限。 */
  modelAllowed?: boolean;
  sources: MemorySource[];
}
export interface MemoryContext {
  text: string;
  records: { id: string; version: number; contentHash: string }[];
  omitted: number;
  sourceWarnings: number;
  retrieval?: { mode: 'fts5-cjk-bigram' | 'lexical-cjk-bigram'; matched: number; anchored: number };
}
export interface MemoryForgetPreview {
  /** 选定记录、共享选定来源的记录，以及它们的派生记录。 */
  recordIds: string[];
  versions: Record<string, number>;
  /** 选定记录各版本的来源与被清除记录标识；不扩张派生记录的无关来源。 */
  sourceKeys: string[];
  retained: string[];
  digest: string;
}

export interface ContextLedgerInput {
  runId: string;
  generation: number;
  conversationId: string;
  memoryRecords: Array<{ id: string; version: number; contentHash: string }>;
  personaRecords: Array<{ id: string; version: number; digest: string }>;
}
/** 准备账本不能证明请求已发出或供应方已接收。它只记录本次准备的版本。 */
export interface ContextLedgerRecord extends ContextLedgerInput {
  id: string;
  ordinal: number;
  phase: 'prepared';
  manifestHash: string;
  createdAt: string;
}

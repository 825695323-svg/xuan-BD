import type { JsonValue } from '../../contracts/task-contracts.js';

/** 通用数据库端口尚未装配；现有 WFD 连接的绑定状态由连接服务单独提供。 */
export const DATABASE_PORT_RESERVATION = Object.freeze({
  state: 'unbound',
  code: 'DATABASE_PORT_UNBOUND',
  categories: Object.freeze(['query', 'coverage', 'receive', 'status', 'snapshot', 'feedback'] as const),
});

export type DatabaseOperation = 'query' | 'coverage' | 'receive' | 'status' | 'cancel' | 'resolve_snapshot' | 'read' | 'feedback';
export type DatabaseLookup = { job_id: string; request_id?: never } | { request_id: string; job_id?: never };
export interface DatabaseQuery { query?: string; dataset_id?: string }
export interface DatabaseScope { dataset_id: string; scope?: Record<string, JsonValue> }
export interface DatabaseSnapshot { dataset_id: string; snapshot_id: string }
export interface DatabaseRead extends DatabaseSnapshot {
  scope?: Record<string, JsonValue>;
  fields?: string[];
  limit?: number;
  cursor?: string;
  temporal_mode?: 'latest' | 'historical_public' | 'system_replay';
}
export interface DatabaseCancel { request_id: string; job_id: string; reason: string }

/** 对象须由双方受控取回；本机绝对路径不作为远端可读证据。 */
export type DatabaseObjectReference = {
  readonly sha256: string;
  readonly byte_length: number;
  readonly media_type: string;
} & (
  { readonly kind: 'inline-bytes'; readonly bytes_base64: string }
  | { readonly kind: 'controlled-object'; readonly binding_id: string; readonly object_id: string }
);

/** 后续交接重试保持这些身份和输入；正式合同绑定前不会发送此载荷。 */
export interface DatabaseHandoff {
  readonly request_id: string;
  readonly handoff_id: string;
  readonly collection_task_id: string;
  readonly processing_task_id: string;
  readonly dataset_id: string;
  readonly contract_version: string;
  readonly input_sha256: string;
  readonly processing: {
    readonly processor_id: string;
    readonly processor_version: string;
    readonly method_id: string;
    readonly method_version: string;
  };
  readonly completion: 'received' | 'committed';
  readonly structured_result: DatabaseObjectReference;
  readonly original_evidence: readonly DatabaseObjectReference[];
  readonly verification_evidence: readonly DatabaseObjectReference[];
}

interface DatabaseReceiptIdentity {
  readonly request_id: string;
  readonly handoff_id: string;
}

/** 身份仅来自实际数据库回执；受理、保管输入和正式提交分别核对。 */
export type DatabaseHandoffReceipt = DatabaseReceiptIdentity & (
  { readonly state: 'accepted'; readonly job_id: string }
  | { readonly state: 'received'; readonly receipt_id: string; readonly job_id?: string }
  | { readonly state: 'committed'; readonly receipt_id: string; readonly job_id: string; readonly commit_id: string; readonly snapshot_id: string }
  | { readonly state: 'unknown'; readonly reason: string; readonly job_id?: string; readonly receipt_id?: string }
  | { readonly state: 'rejected' | 'failed'; readonly reason: string; readonly job_id?: string; readonly receipt_id?: string }
);

export interface DatabaseQualityFeedback extends DatabaseSnapshot {
  readonly request_id: string;
  readonly feedback_id: string;
  readonly issue: string;
  readonly evidence: readonly DatabaseObjectReference[];
}

export interface DatabaseCallOptions {
  signal?: AbortSignal;
  context?: { caller?: string; session_id?: string; task_id?: string; workspace_root?: string; sandbox_mode?: string };
}

export interface DatabasePort {
  availability(operation: DatabaseOperation): { available: boolean; code?: string; reason?: string };
  query(input?: DatabaseQuery, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  coverage(input: DatabaseScope, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  receive(input: DatabaseHandoff, options?: DatabaseCallOptions): Promise<DatabaseHandoffReceipt>;
  status(input: DatabaseLookup, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  cancel(input: DatabaseCancel, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  resolveSnapshot(input: DatabaseSnapshot, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  read(input: DatabaseRead, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
  feedback(input: DatabaseQualityFeedback, options?: DatabaseCallOptions): Promise<Record<string, unknown>>;
}

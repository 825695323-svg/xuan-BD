import type { JsonValue } from '../../contracts/task-contracts.js';

/** 框架内部封闭候选，不是 WFD 线协议；正式字段映射只在 wfd-port 中维护。 */
export interface SealedCollectionObject {
  name: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  bytesBase64: string;
}
export interface CollectionHandoffIntent {
  environment: 'synthetic-test';
  requestId: string;
  handoffId: string;
  collectionTaskId: string;
  processingTaskId: string;
  datasetId: string;
  inputDigest: string;
  planDigest: string;
  source: { id: string; version: string; collectedAt: string; kind: 'file' | 'source'; definitionDigest: string };
  completionCondition: 'received' | 'committed';
  /** 受理候选时明确固定的数据库当前快照；null 仅表示首次提交预期为空。 */
  expectedSnapshotId: string | null;
  output: JsonValue;
  originals: SealedCollectionObject[];
  evidence: SealedCollectionObject[];
  steps: JsonValue[];
}
export interface CollectionOutputIdentity {
  unitId: string; outputId: string; definitionRevision: string; schemaRevision: string;
}
export interface CollectionDatabaseReceipt {
  environment: 'synthetic-test';
  ownerService: 'wfd';
  handoffId: string;
  requestId: string;
  state: 'accepted' | 'received' | 'committed' | 'rejected' | 'failed' | 'cancelled' | 'unknown' | 'not_found';
  databaseTaskId?: string;
  receiptId?: string;
  commitId?: string;
  snapshotId?: string;
  outputIdentity?: CollectionOutputIdentity;
  /** 数据库实际验证并接手的封闭内容摘要，不由框架推算外部回执。 */
  contentDigest?: string;
  raw: JsonValue;
}
export interface CollectionReadback {
  environment: 'synthetic-test';
  ownerService: 'wfd';
  snapshotId: string;
  outputIdentity: CollectionOutputIdentity;
  rows: JsonValue[];
  raw: JsonValue;
}
export interface CollectionDatabasePort {
  /** 只有被明确装配的隔离测试端口才返回可用。 */
  readonly binding: 'unbound' | 'isolated-synthetic';
  readonly contractVersion: string | null;
  readonly contractDigest: string | null;
  ingest(intent: Readonly<CollectionHandoffIntent>, options?: { signal?: AbortSignal }): Promise<CollectionDatabaseReceipt>;
  lookup(handoffId: string, options?: { signal?: AbortSignal; intent?: Readonly<CollectionHandoffIntent> }): Promise<CollectionDatabaseReceipt>;
  resume(handoffId: string, options?: { signal?: AbortSignal; intent?: Readonly<CollectionHandoffIntent> }): Promise<CollectionDatabaseReceipt>;
  cancel(handoffId: string, cancellationId: string, options?: { signal?: AbortSignal; intent?: Readonly<CollectionHandoffIntent> }): Promise<CollectionDatabaseReceipt>;
  readSnapshot(receipt: Readonly<CollectionDatabaseReceipt>, options?: { signal?: AbortSignal; intent?: Readonly<CollectionHandoffIntent> }): Promise<CollectionReadback>;
}

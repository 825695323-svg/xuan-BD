import type { R1SourceAuthorization } from '../modules/collection/r1-source.js';

/** Public local-Web slice: one processed material and explicit UTC intervals. */
export interface R1TimeMapping {
  earliestUtc: string; latestExclusiveUtc: string;
  precision: 'day' | 'minute' | 'second'; sourceTimezone: string;
}
export interface R1ScalarMapping extends R1TimeMapping { businessKey: string; value: string }
export interface R1TabularMapping extends R1TimeMapping {
  kind: 'tabular_rows';
  businessKey: string;
  /** Every declared field maps to actual processed columns; no implicit value state. */
  fields: { fieldCode: string; value: string; state?: string }[];
  /** Explicit market roles only. A table without market roles omits bar. */
  bar?: { frequency: 'day' | 'minute'; open?: string; high?: string; low?: string; close?: string; volume?: string; amount?: string };
  /** Absence preserves unknown historical availability; acquisition time is never substituted. */
  publicTime?: R1TimeMapping;
}
export type R1Mapping = R1ScalarMapping | R1TabularMapping;
export interface R1SourceDeclaration {
  source_id: string; provider: string; requested_url: string;
  requested_at_utc: string; acquired_at_utc: string; usage_scope: string;
  /** Legacy BD source text only; it does not determine R1 admission. */
  license?: string;
  /** Missing in old frozen requests; every new prepare treats absence as unknown. */
  authorization?: R1SourceAuthorization;
}
export interface R1PrepareInput {
  requestId: string; planId: string; outputId: string;
  source: R1SourceDeclaration;
  mapping: R1Mapping;
  target: { datasetId: string; outputKey: string; expectedParentSnapshotId: string | null;
    subject: Record<string, unknown>; definition: Record<string, unknown>;
    inputMode: 'partial_observation' | 'complete_snapshot'; coverage: Record<string, unknown> };
}
interface R1ConnectionIdentityBase {
  connectionId: string; protocol: 'wfd.structured-ingest/1.0'; profile: 'data_only';
  runtimeIdentity: string;
  store: string; runtime: string; callerId: string; namespace: string;
  configSha256: string; schemaSha256: string; entrySha256: string;
  pythonPath: string; entryPath: string;
}
export type R1ConnectionIdentity = R1ConnectionIdentityBase &
  ({ mode: 'user_test'; purpose: 'user_test' } | { mode: 'production'; purpose: 'production' });
export interface R1RowSummary { inserted: number; duplicate_skipped: number; conflict_pending: number }
export interface R1ConflictRecord {
  record_id: string; record_version: string; snapshot_id: string; product_id: string;
  definition_ref: Record<string, unknown>; withdrawn?: boolean;
}
export type R1RowResult = { row_index: number; business_key: string } & (
  { state: 'inserted' | 'duplicate_skipped'; record_id: string; record_version: string }
  | { state: 'conflict_pending'; reason: string; difference_fields: string[]; existing_records: R1ConflictRecord[] }
);
export interface R1RequestSummary {
  requestId: string; state: string; rowCount: number; errorCode: string | null;
}
export interface R1RequestView {
  requestId: string; state: string; datasetId: string; outputKey: string;
  documentSha256: string; connection: R1ConnectionIdentity;
  planId: string; outputId: string; rowCount: number; previewRows: Record<string, unknown>[];
  submitTaskId: string | null; requiresRecovery: boolean;
  local: Record<string, unknown>; error: Record<string, unknown> | null;
  duplicatePolicy?: 'skip_identical_append'; rowSummary?: R1RowSummary;
}
export interface R1CapabilitiesView {
  protocol: 'wfd.structured-ingest/1.0'; profile: 'data_only';
  configuration: { state: string; reason: string | null }; connection: R1ConnectionIdentity | null;
  limits: { maxRows: number; maxDocumentBytes: number; maxMaterials: 1; payload: 'scalar_rows';
    supportedPayloads?: readonly ('scalar_rows' | 'tabular_rows')[] };
  automaticSubmit: false; legacyReplay: false;
}

export interface R1ReadConnection {
  connectionId: string; profile: 'data_only'; mode: 'user_test' | 'production';
  runtimeIdentity: string; callerId: string; namespace: string;
}
export interface R1SnapshotStatus {
  snapshotId: string | null; empty: boolean; authority: 'active_head';
  connection: R1ReadConnection & { roles: string[] };
  units: Record<string, { definition: Record<string, unknown>; digest: string }>;
}
export interface R1ReadLimits {
  pageSize: number; maxScanRows: number; maxScanBytes: number;
  maxResultBytes: number; maxDiscoveryProducts: number; maxFields: number; timeoutMs: number;
}
export interface R1ProductSelection {
  productId: string; datasetId: string; payloadKind: string; subject: Record<string, unknown>;
  fields: string[]; readable: boolean; reason: string | null;
}
export interface R1ProductDiscovery {
  snapshotId: string; historyMode: 'snapshot_contents'; connection: R1ReadConnection;
  selections: R1ProductSelection[]; products: Record<string, unknown>[]; limits: R1ReadLimits;
}
export interface R1ProductRead {
  snapshotId: string; productId: string; historyMode: 'snapshot_contents'; connection: R1ReadConnection;
  result: Record<string, unknown>; limits: R1ReadLimits;
}
export interface R1ProductReadInput {
  snapshotId: string; productId: string; cursor?: string | null;
  /** Only fields declared by this product in the selected fixed snapshot; omitted means all. */
  fields?: string[];
}


export const R1_CONTEXT_OPERATIONS = ['read_company_context', 'read_relation_graph', 'read_applicable_rules', 'read_event_timeline'] as const;
export type R1ContextOperation = typeof R1_CONTEXT_OPERATIONS[number];
export interface R1ContextReadInput {
  operation: R1ContextOperation; snapshotId: string; datasetId: string; subject: Record<string, unknown>;
  fields?: string[]; pageSize?: number; cursor?: string | null; maxDepth?: number;
  relationTypes?: string[]; eventTypes?: string[]; ruleCodes?: string[]; businessTimeRange?: Record<string, unknown> | null;
}
export interface R1ContextRead {
  operation: R1ContextOperation; snapshotId: string; datasetId: string; subject: Record<string, unknown>;
  historyMode: 'snapshot_contents'; connection: R1ReadConnection; result: Record<string, unknown>; limits: R1ReadLimits;
}

export interface R1DefinitionIntent {
  snapshotId: string | null; datasetId: string; subject: Record<string, unknown>; semanticCode: string; fieldCodes: string[];
}
export interface R1DefinitionReview extends R1DefinitionIntent {
  protocol: 'wfd.definition-review/1'; disposition: 'return_to_bd' | 'candidate_found';
  code: 'FAMILY_DEFINITION_REQUIRED' | 'FIELD_DEFINITION_REQUIRED' | 'CANDIDATE_FIELDS_PRESENT';
  productIds: string[]; missingFields: string[]; machineRequestId: string;
}

import type { R1PublicationSetView } from './r1-publication-set.js';
import type { R1SourceAuthorization } from '../modules/collection/r1-source.js';
import type { EligibilityHistoryMode } from '../modules/collection/purpose-eligibility.js';

/** Public local-Web slice: one processed material and explicit UTC intervals. */
export interface R1TimeMapping {
  earliestUtc: string; latestExclusiveUtc: string;
  precision: 'day' | 'minute' | 'second'; sourceTimezone: string;
}
export interface R1ScalarMapping extends R1TimeMapping { businessKey: string; value: string }
export interface R1SupplyTradeMapping {
  kind: 'geo_commodity_observation' | 'bilateral_trade_observation';
  regionId: string;
  commodityId: string;
  stageCode: string;
  quantityBasis: string;
  unitCode: string;
  periodBasis: string;
  periodLabel: string;
  value: string;
  category?: string;
  capacityStatus?: string;
  inventoryScope?: string;
  partnerRegionId?: string;
  partnerRole?: string;
  flow?: string;
  isSubFlowOf?: string;
  valuationBasis?: string;
  currencyCode?: string;
  primaryValue?: string;
  externalScheme?: string;
  externalVersion?: string;
  externalCode?: string;
  externalParentCode?: string;
  externalMappingQuality?: string;
}
export interface R1TabularMapping extends R1TimeMapping {
  kind: 'tabular_rows';
  businessKey: string;
  /** Every declared field maps to actual processed columns; no implicit value state. */
  fields: { fieldCode: string; value: string; state?: string }[];
  /** Explicit market roles only. A table without market roles omits bar. */
  bar?: { frequency: 'day' | 'minute'; open?: string; high?: string; low?: string; close?: string; volume?: string; amount?: string };
  /** Explicit global supply & bilateral trade roles; mutually exclusive with bar. */
  supplyTrade?: R1SupplyTradeMapping;
  /** Absence preserves unknown historical availability; acquisition time is never substituted. */
  publicTime?: R1TimeMapping;
}
/** Explicit WFD event nature and distinct event/public/expected temporal roles. */
export type R1EventTimeMapping = { status: 'unknown'; sourceTimezone: string } | ({ status: 'known' } & R1TimeMapping);
export interface R1EventMapping {
  kind: 'event_records'; eventId: string; eventType: string; assertionKind: string; caseId?: string;
  contentNature: 'source_claim' | 'plan' | 'forecast' | 'observed_fact' | 'outcome'; status: string;
  eventTime: R1EventTimeMapping; publicTime: R1EventTimeMapping; expectedTime?: R1EventTimeMapping;
  fields: { fieldCode: string; value: string; state: string }[];
}
/** Explicit source-claim relation; identity, validity and public time are independent. */
export interface R1RelationMapping {
  kind: 'relation_edges'; businessKey: string; relationType: string;
  object: { kind: string; namespace: string; id: string };
  effectivePeriod: R1EventTimeMapping; publicTime: R1EventTimeMapping;
  fields: { fieldCode: string; value: string; state: string }[];
}
export type R1Mapping = R1ScalarMapping | R1TabularMapping | R1EventMapping | R1RelationMapping;
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
  /** Optional explicit field-profile evidence. The host validates the profile and any frozen digest. */
  sourceFieldProfile?: unknown;
  mapping: R1Mapping;
  target: { datasetId: string; outputKey: string; expectedParentSnapshotId: string | null; expectedCommitId?: string;
    subject: Record<string, unknown>; definition: Record<string, unknown>;
    inputMode: 'partial_observation' | 'complete_snapshot' | 'source_correction'; coverage: Record<string, unknown>;
    /** Independent explicit definition availability; never inferred from row/source dates. */
    definitionPublicTime?: Record<string, unknown>;
    definitionMode?: 'reuse'; definitionRef?: Record<string, unknown>;
    revisions?: Record<string, { previous: { product_id: string; snapshot_id: string; logical_key: string; revision_id: string }; reason: string }> };
}
export interface R1ReadBinding { readSchemaSha256: string; queryImplSha256: string }
const SHA256_HEX = /^[0-9a-f]{64}$/u;
export function isValidR1ReadBinding(value: unknown): value is R1ReadBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('readSchemaSha256') || !keys.includes('queryImplSha256')) return false;
  const record = value as Record<string, unknown>;
  return typeof record.readSchemaSha256 === 'string' && SHA256_HEX.test(record.readSchemaSha256)
    && typeof record.queryImplSha256 === 'string' && SHA256_HEX.test(record.queryImplSha256);
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
  publicationSet?: R1PublicationSetView;
}
export interface R1CapabilitiesView {
  protocol: 'wfd.structured-ingest/1.0'; profile: 'data_only';
  configuration: { state: string; reason: string | null }; connection: R1ConnectionIdentity | null;
  /** 只有显式 true 证明固定产品读取可用。兼容宿主省略此字段时能力未证实。 */
  readProductSupported?: boolean;
  limits: { maxRows: number; maxDocumentBytes: number; maxMaterials: 1; payload: 'scalar_rows';
    supportedPayloads?: readonly ('scalar_rows' | 'tabular_rows' | 'event_records' | 'relation_edges')[] };
  automaticSubmit: false; legacyReplay: false;
  publicationSets?: { prepareKind: 'publication_set'; maxOutputs: 16; membership: 'frozen_plan'; atomicity: 'declared_set' };
}

export interface R1ReadConnection {
  connectionId: string; profile: 'data_only'; mode: 'user_test' | 'production';
  runtimeIdentity: string; callerId: string; namespace: string;
}
export interface R1SnapshotStatus {
  /** Actual bound WFD instance only; does not assert any usable stage or invent holding facts. */
  holdingInstance?: { instanceId: string; bindingSource: 'volume_binding' | 'target_instance' } | null;
  snapshotId: string | null; empty: boolean; authority: 'active_head' | 'joint_commit'; jointCommitId?: string;
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
  snapshotId: string; productId: string; historyMode: EligibilityHistoryMode; connection: R1ReadConnection;
  /** 固定快照发现登记中的产品主体，独立于读取页的产品包络。 */
  productSubject?: Record<string, unknown>;
  result: Record<string, unknown>; limits: R1ReadLimits;
}
export interface R1ProductReadInput {
  snapshotId: string; productId: string; cursor?: string | null;
  /** 不传时仍只读固定快照；历史模式与截止必须由调用方明确选择。 */
  historyMode?: EligibilityHistoryMode;
  /** 显式秒级 UTC 截止。日期粒度的来源证据不得由此改写成午夜。 */
  at?: string;
  /** system_held_at 必须同时固定范围及实际可用阶段，不自动升级为正式可读。 */
  heldScope?: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable';
  /** Only fields declared by this product in the selected fixed snapshot; omitted means all. */
  fields?: string[];
  selection?: R1TabularSelection;
  membership?: R1MembershipSelection;
  pageSize?: number;
}

/** Field names are discovered contract codes; text values retain their original form. */
export interface R1TabularSelection {
  partitions?: string[];
  match?: Record<string, string[]>;
  dateRange?: { field: string; format: 'YYYYMMDD' | 'YYYY-MM-DD'; start: string; end: string };
  timeRange?: { role: 'observation'; start: string; end: string; timezone: string };
}

/** Selects a cohort from a published membership snapshot. */
export interface R1MembershipSelection {
  productId: string;
  selection: R1TabularSelection;
  memberField: string;
  targetField: string;
  basis: 'reported_snapshot';
  mapping?: { productId: string; selection: R1TabularSelection; sourceField: string; targetField: string };
}

export const R1_CONTEXT_OPERATIONS = ['read_company_context', 'read_relation_graph', 'read_applicable_rules', 'read_event_timeline'] as const;
export type R1ContextOperation = typeof R1_CONTEXT_OPERATIONS[number];
export interface R1ContextReadInput {
  operation: R1ContextOperation; snapshotId: string; datasetId: string; subject: Record<string, unknown>;
  fields?: string[]; pageSize?: number; cursor?: string | null; maxDepth?: number;
  /** Explicit market cutoff for event timelines; relation graphs additionally support system_held_at and require validity range. Other contexts remain snapshot-only. */
  historyMode?: EligibilityHistoryMode; at?: string;
  heldScope?: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable';
  relationTypes?: string[]; eventTypes?: string[]; ruleCodes?: string[]; businessTimeRange?: Record<string, unknown> | null;
}
export interface R1ContextRead {
  operation: R1ContextOperation; snapshotId: string; datasetId: string; subject: Record<string, unknown>;
  historyMode: EligibilityHistoryMode; connection: R1ReadConnection; result: Record<string, unknown>; limits: R1ReadLimits;
}

export interface R1DefinitionIntent {
  snapshotId: string | null; datasetId: string; subject: Record<string, unknown>; semanticCode: string; fieldCodes: string[];
}
export interface R1DefinitionReview extends R1DefinitionIntent {
  protocol: 'wfd.definition-review/1'; disposition: 'return_to_bd' | 'candidate_found';
  code: 'FAMILY_DEFINITION_REQUIRED' | 'FIELD_DEFINITION_REQUIRED' | 'CANDIDATE_FIELDS_PRESENT';
  productIds: string[]; missingFields: string[]; machineRequestId: string;
}

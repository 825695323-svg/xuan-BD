import type { WfdRecord } from '../adapters/database/wfd-transport.js';

/** An explicitly unqualified source report. This is not a standard price-bar contract. */
export const SOURCE_MINUTE_BATCH_PROTOCOL = 'wfd.source-minute-batch/1' as const;
export const SOURCE_MINUTE_KEY_ALGORITHM = 'wfd.source-minute-key/1' as const;
export type SourceMinuteCell = string | null;

export interface SourceMinuteBatchChunk {
  chunk_id: string;
  ordinal: number;
  row_count: number;
  digest: string;
}

export interface SourceMinutePartition {
  date: string;
  date_field: string;
  minute_field: string;
  identity_field: string;
  timezone: 'Asia/Shanghai';
  key_algorithm: typeof SOURCE_MINUTE_KEY_ALGORITHM;
}

export interface SourceMinuteBatchHeader {
  protocol_version: typeof SOURCE_MINUTE_BATCH_PROTOCOL;
  request_identity: {
    dataset_id: string;
    trusted_actor_namespace: string;
    request_id: string;
    submission_digest: string;
  };
  producer_namespace: string;
  expected_parent_snapshot_id: string | null;
  outputs: WfdRecord[];
  field_codes: string[];
  partition: SourceMinutePartition;
  row_count: number;
  rows_digest: string;
}

/** A locator must be bound to an actual formal receipt, never a mutable current-head query. */
export interface SourceMinuteReadLocator {
  snapshot_id: string;
  product_id: string;
  partition: string;
  result_root: string;
}

export interface SourceMinuteReadPage extends SourceMinuteReadLocator {
  page_size: number;
  cursor: string | null;
}

export interface SourceMinuteFixedRow {
  cells: SourceMinuteCell[];
  record_id: string;
  record_version: string;
  row_index: number;
}

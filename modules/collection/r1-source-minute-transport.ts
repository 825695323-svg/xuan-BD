import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { SOURCE_MINUTE_BATCH_PROTOCOL, type SourceMinuteBatchHeader } from '../../contracts/source-minute-batch.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { sourceMinuteBulkKey, type SourceMinuteBulkManifest } from './data-processing/source-minute-bulk.js';
import { buildBulkBatchHeader, verifyBulkBatchReadback, verifyBulkBatchReceipt,
  type BulkSemanticAdapter } from './r1-bulk-transport.js';
import { createSourceReportedMinuteResolver, sourceReportedMinute } from './source-reported-table.js';

const resolvers = new WeakMap<SourceMinuteBatchHeader, ReturnType<typeof createSourceReportedMinuteResolver>>();
/** Persisted v1 identity, time interpretation and checkpoint formats remain unchanged. */
const adapter: BulkSemanticAdapter<SourceMinuteBatchHeader, SourceMinuteBulkManifest> = {
  protocol: SOURCE_MINUTE_BATCH_PROTOCOL,
  checkpointVersion: 'bd.source-minute-readback/1', proofVersion: 'bd.source-minute-association/1',
  headerFields: manifest => ({ partition: manifest.partition }),
  validPartition: value => /^\d{8}$/u.test(value),
  partitionValue: header => header.partition.date,
  keyLength: () => 2,
  semanticRow(header, cells, subject) {
    const identity = cells[header.field_codes.indexOf(header.partition.identity_field)];
    const minute = cells[header.field_codes.indexOf(header.partition.minute_field)];
    const date = cells[header.field_codes.indexOf(header.partition.date_field)];
    if (typeof identity !== 'string' || !identity.replace(/[\s\u001c-\u001f\u0085]/gu, '') || typeof minute !== 'string'
      || sourceReportedMinute(minute)?.replace('T', ' ') !== minute || date !== header.partition.date
      || minute.slice(0, 10).replaceAll('-', '') !== header.partition.date)
      throw new TaskError('R1_BULK_READBACK_ORDER', '固定读回的来源身份、分钟或日期不符合原冻结契约。');
    let resolver = resolvers.get(header);
    if (!resolver) { resolver = createSourceReportedMinuteResolver(header.partition.timezone); resolvers.set(header, resolver); }
    const [start, end] = resolver(minute);
    return { key: [identity, minute], row: { business_key: sourceMinuteBulkKey(header.partition.date, identity, minute), subject,
      observation_time: { status: 'known', earliest_utc: start, latest_exclusive_utc: end, precision: 'minute', source_timezone: header.partition.timezone },
      values: Object.fromEntries(header.field_codes.map((code, i) => [code, { data_type: 'text', value_state: cells[i] === null ? 'unknown' : 'valid_value', value: cells[i] }])) } };
  },
};

export function buildSourceMinuteBatchHeader(manifest: SourceMinuteBulkManifest, input: { requestId: string; namespace: string }): SourceMinuteBatchHeader {
  return buildBulkBatchHeader(manifest, input, adapter);
}
export function verifySourceMinuteBatchReceipt(header: SourceMinuteBatchHeader, manifest: SourceMinuteBulkManifest, result: unknown): WfdRecord {
  return verifyBulkBatchReceipt(header, manifest, result, adapter);
}
export interface SourceMinuteReadbackInput {
  header: SourceMinuteBatchHeader; manifest: SourceMinuteBulkManifest; receipt: WfdRecord;
  client: Pick<WfdProductMachineClient, 'sourceMinuteReadPage'>;
  checkpoint?: WfdRecord | null; onCheckpoint(value: WfdRecord): void | Promise<void>;
  signal?: AbortSignal; assertCurrent(): void;
}
export function verifySourceMinuteBatchReadback(input: SourceMinuteReadbackInput): Promise<WfdRecord> {
  return verifyBulkBatchReadback({ ...input, readPage: (page, signal) => input.client.sourceMinuteReadPage(page, signal) }, adapter);
}

import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TABULAR_BATCH_PROTOCOL, createTabularRowSemantics, readTabularTableContract, tabularPartitionValue,
  type TabularBatchHeader } from '../../contracts/tabular-batch.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { TabularBulkManifest } from './data-processing/tabular-bulk.js';
import { buildBulkBatchHeader, verifyBulkBatchReadback, verifyBulkBatchReceipt,
  type BulkSemanticAdapter } from './r1-bulk-transport.js';

const semantics = new WeakMap<TabularBatchHeader, ReturnType<typeof createTabularRowSemantics>>();
const adapter: BulkSemanticAdapter<TabularBatchHeader, TabularBulkManifest> = {
  protocol: TABULAR_BATCH_PROTOCOL,
  checkpointVersion: 'bd.tabular-readback/1', proofVersion: 'bd.tabular-association/1',
  headerFields(manifest) {
    const contract = readTabularTableContract(manifest.tableContract);
    if (JSON.stringify(contract.fields) !== JSON.stringify(manifest.fieldCodes))
      throw new TaskError('R1_BULK_CONTRACT', '加工字段顺序与冻结表格契约不一致。');
    return { partition: { value: tabularPartitionValue(manifest.partition.value) }, table_contract: contract };
  },
  validPartition(value) {
    try { return tabularPartitionValue(value) === value; } catch { return false; }
  },
  partitionValue: header => header.partition.value,
  receiptBinding: header => ({ table_contract_digest: header.table_contract.digest }),
  keyLength: header => header.table_contract.key_fields.length,
  semanticRow(header, cells, subject) {
    let current = semantics.get(header);
    if (!current) { current = createTabularRowSemantics(header.table_contract, header.partition); semantics.set(header, current); }
    return { key: current.keyValues(cells), row: current.semanticRow(cells, subject as WfdRecord) };
  },
};

export function buildTabularBatchHeader(manifest: TabularBulkManifest, input: { requestId: string; namespace: string }): TabularBatchHeader {
  return buildBulkBatchHeader(manifest, input, adapter);
}
export function verifyTabularBatchReceipt(header: TabularBatchHeader, manifest: TabularBulkManifest, result: unknown): WfdRecord {
  return verifyBulkBatchReceipt(header, manifest, result, adapter);
}
export interface TabularReadbackInput {
  header: TabularBatchHeader; manifest: TabularBulkManifest; receipt: WfdRecord;
  client: Pick<WfdProductMachineClient, 'tabularReadPage'>;
  checkpoint?: WfdRecord | null; onCheckpoint(value: WfdRecord): void | Promise<void>;
  signal?: AbortSignal; assertCurrent(): void;
}
export function verifyTabularBatchReadback(input: TabularReadbackInput): Promise<WfdRecord> {
  return verifyBulkBatchReadback({ ...input,
    readPage: (page, signal) => input.client.tabularReadPage({ ...page, protocol_version: TABULAR_BATCH_PROTOCOL }, signal) }, adapter);
}

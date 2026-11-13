import { createHash } from 'node:crypto';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1PrepareInput } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { assertR1ContractBinding, readR1ContractBinding } from './r1-tabular.js';

/** Transport capacity is independent of the frozen data semantics. */
export interface BulkManifest {
  manifestDigest: string; planDigest: string; materialId: string; sourceSha256: string;
  target: R1PrepareInput['target']; fieldCodes: string[]; rowCount: number; rowsDigest: string;
  chunks: { chunk_id: string; ordinal: number; row_count: number; digest: string }[];
}
export interface BulkBatchHeader {
  protocol_version: string;
  request_identity: { dataset_id: string; trusted_actor_namespace: string; request_id: string; submission_digest: string };
  producer_namespace: string; expected_parent_snapshot_id: string | null; outputs: WfdRecord[];
  field_codes: string[]; row_count: number; rows_digest: string;
}
export interface BulkReadLocator { snapshot_id: string; product_id: string; partition: string; result_root: string }
export interface BulkReadPage extends BulkReadLocator { page_size: number; cursor: string | null }
export interface BulkSemanticAdapter<H extends BulkBatchHeader, M extends BulkManifest> {
  protocol: H['protocol_version']; checkpointVersion: string; proofVersion: string;
  headerFields(manifest: M): object;
  validPartition(value: string): boolean;
  partitionValue(header: H): string;
  receiptBinding?(header: H): WfdRecord;
  keyLength(header: H): number;
  semanticRow(header: H, cells: (string | null)[], subject: unknown): { key: string[]; row: WfdRecord };
}
export function compareBulkKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = Buffer.compare(Buffer.from(a[i]!, 'utf8'), Buffer.from(b[i]!, 'utf8'));
    if (order) return order;
  }
  return a.length - b.length;
}

const fail = (code: string, message: string): never => { throw new TaskError('R1_BULK_' + code, message); };
const digest = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const same = (a: unknown, b: unknown) => canonicalWfdJson(a) === canonicalWfdJson(b);
const sha = (v: unknown): v is string => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/u.test(v);
const object = (v: unknown): WfdRecord => isWfdRecord(v) ? v : fail('READBACK_FORMAT', '固定读回缺少结构化对象。');

/** No source paths, material identities or transport boundaries enter the formal semantic header. */
export function buildBulkBatchHeader<H extends BulkBatchHeader, M extends BulkManifest>(manifest: M, input: { requestId: string; namespace: string }, adapter: BulkSemanticAdapter<H, M>): H {
  const { manifestDigest, ...body } = manifest;
  if (manifestDigest !== digest(body) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.requestId)
    || !input.namespace || manifest.rowCount < 1 || manifest.chunks.reduce((count, chunk) => count + chunk.row_count, 0) !== manifest.rowCount
    || manifest.chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal || !sha(chunk.digest)))
    return fail('MANIFEST', '原件加工清单、分块计数或冻结请求身份不一致。');
  const target = manifest.target;
  const header = {
    protocol_version: adapter.protocol,
    request_identity: { dataset_id: target.datasetId, trusted_actor_namespace: input.namespace, request_id: input.requestId, submission_digest: '' },
    producer_namespace: input.namespace, expected_parent_snapshot_id: target.expectedParentSnapshotId,
    outputs: [{ output_key: target.outputKey, logical_domain: 'observations', subject: target.subject,
      definition_mode: 'create', input_mode: target.inputMode, coverage: target.coverage,
      payload: { kind: 'tabular_rows' }, definition: target.definition }],
    field_codes: manifest.fieldCodes, ...adapter.headerFields(manifest), row_count: manifest.rowCount, rows_digest: manifest.rowsDigest,
  } as unknown as H;
  const preimage = structuredClone(header) as unknown as WfdRecord;
  delete object(preimage.request_identity).submission_digest;
  header.request_identity.submission_digest = digest(preimage);
  return structuredClone(header);
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => contains(actual[i], v));
  if (isWfdRecord(expected)) return isWfdRecord(actual) && Object.entries(expected).every(([key, v]) => Object.hasOwn(actual, key) && contains(actual[key], v));
  return actual === expected;
}
function sameRawDefinition(actual: WfdRecord, expected: WfdRecord): boolean {
  return same(Object.keys(actual).sort(), Object.keys(expected).sort()) && Object.keys(expected).every(key =>
    key === 'semantic_context' ? contains(actual[key], expected[key]) : same(actual[key], expected[key]));
}
function locator(receipt: WfdRecord, validPartition: (value: string) => boolean): BulkReadLocator {
  if (typeof receipt.snapshot_id !== 'string' || !/^s_[a-f0-9]{24}$/u.test(receipt.snapshot_id)
    || typeof receipt.product_id !== 'string' || !/^p_[a-f0-9]{24}$/u.test(receipt.product_id)
    || typeof receipt.partition !== 'string' || !validPartition(receipt.partition) || !sha(receipt.result_root))
    return fail('RECEIPT', '正式回执缺少固定快照、产品、日期或不可变结果根。');
  return { snapshot_id: receipt.snapshot_id, product_id: receipt.product_id, partition: receipt.partition, result_root: receipt.result_root };
}

export function verifyBulkBatchReceipt<H extends BulkBatchHeader, M extends BulkManifest>(header: H, manifest: M, result: unknown, adapter: BulkSemanticAdapter<H, M>): WfdRecord {
  if (!same(header, buildBulkBatchHeader(manifest, { requestId: header.request_identity.request_id, namespace: header.producer_namespace }, adapter)))
    return fail('HEADER', '待核回执与冻结整件交接头不一致。');
  const receipt = object(result), fixed = locator(receipt, adapter.validPartition), output = header.outputs[0]!;
  const summary = object(receipt.row_summary), definition = object(receipt.definition), ref = object(receipt.definition_ref);
  const definitionDigest = digest(definition), definitionHash = definitionDigest.slice(7);
  const definitionRef = { kind: 'definition_version', dataset_id: header.request_identity.dataset_id, namespace: 'wfd.product',
    id: 'def_' + definitionHash.slice(0, 24), version: 'v_' + definitionHash.slice(0, 16), digest: definitionDigest,
    resolution: 'pinned', required: true, dependency_type: 'read' };
  if (receipt.protocol_version !== adapter.protocol || receipt.formal_publication_verified !== true
    || !['published_formal', 'unchanged'].includes(String(receipt.state)) || fixed.partition !== adapter.partitionValue(header)
    || receipt.row_count !== manifest.rowCount || receipt.rows_digest !== manifest.rowsDigest
    || receipt.output_key !== output.output_key || !same(receipt.subject, output.subject)
    || !sha(receipt.partition_fingerprint) || !same(ref, definitionRef) || !sameRawDefinition(definition, object(output.definition))
    || summary.conflict_pending !== 0 || summary.pending_publication !== 0
    || !((summary.inserted === manifest.rowCount && summary.duplicate_skipped === 0 && receipt.state === 'published_formal'
      && receipt.partition_fingerprint === header.request_identity.submission_digest)
      || (summary.inserted === 0 && summary.duplicate_skipped === manifest.rowCount && receipt.state === 'unchanged')))
    return fail('RECEIPT', '正式回执的完整行数、原报合同、语义摘要或重复处理结果与原件不符。');
  const contracts = readR1ContractBinding(receipt, header.request_identity.dataset_id, fixed.product_id, true)!;
  const binding = adapter.receiptBinding?.(header) ?? {};
  if (!Object.entries(binding).every(([key, value]) => same(receipt[key], value)))
    return fail('RECEIPT', '正式回执未绑定冻结的表格契约。');
  for (const [role, value] of Object.entries(contracts.contract_refs)) {
    const ref = object(value), suffix = wfdSha256(canonicalWfdJson([header.request_identity.dataset_id, fixed.product_id, role])).slice(0, 24);
    if (ref.namespace !== 'wfd.product' || ref.id !== `contract_${role}_${suffix}` || ref.version !== 'v_' + String(ref.digest).slice(7, 23)
      || ref.required !== true || ref.dependency_type !== 'read') return fail('RECEIPT', '独立固定合同的正式身份与摘要不符。');
  }
  const bundle = contracts.contract_bundle_ref;
  if (bundle.namespace !== 'wfd.product' || bundle.id !== 'cb_' + String(bundle.digest).slice(7, 31)
    || bundle.version !== 'v_' + String(bundle.digest).slice(7, 23) || bundle.required !== true || bundle.dependency_type !== 'read')
    return fail('RECEIPT', '固定合同包的正式身份与摘要不符。');
  return structuredClone({ ...fixed, protocol_version: adapter.protocol, state: receipt.state,
    formal_publication_verified: true, row_count: receipt.row_count, rows_digest: receipt.rows_digest,
    row_summary: summary, partition_fingerprint: receipt.partition_fingerprint, output_key: receipt.output_key,
    subject: receipt.subject, definition, definition_ref: ref, ...contracts, ...binding });
}

export interface BulkReadbackInput<H extends BulkBatchHeader, M extends BulkManifest> {
  header: H; manifest: M; receipt: WfdRecord;
  readPage(input: BulkReadPage, signal?: AbortSignal): Promise<{ result: WfdRecord }>;
  checkpoint?: WfdRecord | null; onCheckpoint(value: WfdRecord): void | Promise<void>;
  signal?: AbortSignal; assertCurrent(): void;
}

/** Verify every source chunk independently; only completed chunk boundaries can be resumed.
 * Checkpoints are owned by the trusted local state database, never accepted from request input.
 * Their public checksum detects damage and cross-request reuse, not hostile database modification.
 */
export async function verifyBulkBatchReadback<H extends BulkBatchHeader, M extends BulkManifest>(input: BulkReadbackInput<H, M>, adapter: BulkSemanticAdapter<H, M>): Promise<WfdRecord> {
  const { header, manifest } = input;
  const receipt = verifyBulkBatchReceipt(header, manifest, input.receipt, adapter), fixed = locator(receipt, adapter.validPartition);
  const contracts = readR1ContractBinding(receipt, header.request_identity.dataset_id, fixed.product_id, true)!;
  const binding = digest({ header, manifestDigest: manifest.manifestDigest, receipt });
  const checkpoint = input.checkpoint;
  let verifiedChunks = 0, verifiedRows = 0, cursor: string | null = null, lastKey: string[] | null = null;
  if (checkpoint) {
    const { digest: savedDigest, ...body } = checkpoint;
    if (checkpoint.version !== adapter.checkpointVersion || checkpoint.binding !== binding || savedDigest !== digest(body)
      || !Number.isSafeInteger(checkpoint.verifiedChunks) || Number(checkpoint.verifiedChunks) < 0 || Number(checkpoint.verifiedChunks) > manifest.chunks.length
      || checkpoint.verifiedRows !== manifest.chunks.slice(0, Number(checkpoint.verifiedChunks)).reduce((n, c) => n + c.row_count, 0)
      || !(checkpoint.cursor === null || typeof checkpoint.cursor === 'string' && checkpoint.cursor.length > 0)
      || !(checkpoint.lastKey === null || Array.isArray(checkpoint.lastKey) && checkpoint.lastKey.length === adapter.keyLength(header) && checkpoint.lastKey.every(v => typeof v === 'string')))
      return fail('CHECKPOINT', '读回检查点与原件、回执或完整分片边界不符。');
    verifiedChunks = Number(checkpoint.verifiedChunks); verifiedRows = Number(checkpoint.verifiedRows);
    cursor = checkpoint.cursor as string | null; lastKey = checkpoint.lastKey as string[] | null;
    if ((verifiedRows === 0) !== (lastKey === null) || (verifiedRows > 0 && verifiedRows < manifest.rowCount) !== (cursor !== null))
      return fail('CHECKPOINT', '读回检查点的游标或末行位置无效。');
  }
  for (; verifiedChunks < manifest.chunks.length; verifiedChunks++) {
    const chunk = manifest.chunks[verifiedChunks]!, hash = createHash('sha256');
    hash.update('['); let chunkRows = 0;
    while (chunkRows < chunk.row_count) {
      input.signal?.throwIfAborted(); input.assertCurrent();
      // The independent WFD byte ceiling may return fewer rows; never cross a source-chunk checkpoint.
      const pageSize = Math.min(5000, chunk.row_count - chunkRows);
      const { result: page } = await input.readPage({ ...fixed, page_size: pageSize, cursor }, input.signal);
      input.signal?.throwIfAborted(); input.assertCurrent();
      if (!same(locator(page, adapter.validPartition), fixed) || page.row_count !== manifest.rowCount || page.rows_digest !== manifest.rowsDigest
        || page.partition_fingerprint !== receipt.partition_fingerprint || page.output_key !== receipt.output_key
        || !same(page.subject, receipt.subject) || !same(page.definition_ref, receipt.definition_ref)
        || !same(page.definition, receipt.definition) || !Array.isArray(page.rows) || !page.rows.length || page.rows.length > pageSize
        || !(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor.length > 0)
        || page.next_cursor !== null && page.next_cursor === cursor)
        return fail('READBACK_PAGE', '固定读回页的结果根、合同、计数、游标或范围不符。');
      assertR1ContractBinding(page, contracts);
      if (!Object.entries(adapter.receiptBinding?.(header) ?? {}).every(([key, value]) => same(page[key], value)))
        return fail('READBACK_PAGE', '固定读回页的表格契约摘要与原请求不同。');
      for (const value of page.rows) {
        const row = object(value), cells = row.cells;
        if (!Array.isArray(cells) || cells.length !== header.field_codes.length || cells.some(v => v !== null && typeof v !== 'string')
          || row.row_index !== verifiedRows + chunkRows)
          return fail('READBACK_ROW', '固定读回行的列数、原报值类型或连续位置不符。');
        const { key, row: semanticRow } = adapter.semanticRow(header, cells as (string | null)[], receipt.subject);
        if (lastKey && compareBulkKeys(key, lastKey) <= 0)
          return fail('READBACK_ORDER', '固定读回的业务键不符合冻结契约的唯一排序。');
        const businessKey = semanticRow.business_key;
        const version = 'r_' + wfdSha256(canonicalWfdJson([fixed.product_id, semanticRow, 'partial_observation', null,
          String(receipt.partition_fingerprint).slice(7), receipt.output_key])).slice(0, 32);
        if (row.record_id !== businessKey || row.record_version !== version)
          return fail('READBACK_IDENTITY', '实际记录身份或正式行版本与冻结原报值不一致。');
        if (chunkRows++) hash.update(',');
        hash.update(canonicalWfdJson(cells)); lastKey = key;
      }
      cursor = page.next_cursor as string | null;
      if ((verifiedRows + chunkRows < manifest.rowCount) !== (cursor !== null))
        return fail('READBACK_CURSOR', '固定读回过早结束或在完整行数后仍声明后续页。');
    }
    hash.update(']');
    if ('sha256:' + hash.digest('hex') !== chunk.digest) return fail('READBACK_VALUES', '实际固定读回的完整原报列值与对应加工分片不同。');
    verifiedRows += chunkRows;
    const body = { version: adapter.checkpointVersion, binding, verifiedChunks: verifiedChunks + 1, verifiedRows, cursor, lastKey };
    input.signal?.throwIfAborted(); input.assertCurrent();
    await input.onCheckpoint({ ...body, digest: digest(body) });
  }
  input.signal?.throwIfAborted(); input.assertCurrent();
  if (verifiedRows !== manifest.rowCount || cursor !== null) return fail('READBACK_COUNT', '实际读回未覆盖整件全部行。');
  const proof = { version: adapter.proofVersion, ...fixed, material_id: manifest.materialId, source_sha256: manifest.sourceSha256,
    plan_digest: manifest.planDigest, manifest_digest: manifest.manifestDigest, request_id: header.request_identity.request_id,
    row_count: verifiedRows, rows_digest: manifest.rowsDigest, definition_ref: receipt.definition_ref, ...contracts,
    partition_fingerprint: receipt.partition_fingerprint, output_key: receipt.output_key, verified_chunks: verifiedChunks,
    verification: 'all_cells_and_record_versions', standard_market_calculation: false };
  return { ...proof, digest: digest(proof) };
}

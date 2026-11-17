import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { R1Runtime } from './r1-runtime.js';
import type { MaterialService } from './materials/service.js';
import type { R1HandoffService, R1LocalReferences } from './r1-structured-handoff.js';
import { assertR1ContractBinding, frozenR1RowMatches, readR1ContractBinding } from './r1-tabular.js';
import { r1PayloadRowKey } from './r1-paged-readback.js';

/** Local provenance is not WFD data, publication permission, or verification of a source claim. */
export async function readRecordEvidence(value: unknown, options: {
  database: CoreDatabase; handoff: R1HandoffService; materials: MaterialService;
  assertCurrent(requestId: string): R1Runtime; control(): { generation: number; stopped: boolean };
}, signal?: AbortSignal): Promise<WfdRecord> {
  const keys = ['datasetId', 'productId', 'recordId', 'recordVersion'];
  if (!isWfdRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => typeof value[key] !== 'string'
    || !(value[key] as string).length || (value[key] as string).length > 512 || /[\u0000-\u001f]/u.test(value[key] as string))) fail('INPUT', '须提供精确数据集、产品、行及版本，不接受来源或路径。');
  const identity = value as { datasetId: string; productId: string; recordId: string; recordVersion: string };
  const found = options.handoff.recordMaterials(identity, 'read_only');
  if (!found) fail('ASSOCIATION_MISSING', '该精确正式行版本没有本地来源关联，未推断或回退。');
  const runtime = options.assertCurrent(found.requestId), generation = options.control().generation;
  const attempt = options.handoff.attempt(found.requestId), frozen = canonicalWfdJson(attempt);
  const document = object(JSON.parse(String(attempt.document_json))), receipt = object(JSON.parse(String(attempt.receipt_json)));
  const allRefs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
  const members = allRefs.outputs ? records(receipt.members) : [receipt];
  const matches = members.filter(item => item.product_id === identity.productId && item.snapshot_id === found.snapshotId);
  if (matches.length !== 1) fail('MEMBER', '冻结回执没有唯一对应产品成员。');
  const member = matches[0]!, refs = allRefs.outputs ? allRefs.outputs[String(member.output_key)] : allRefs;
  const outputs = records(document.outputs).filter(item => item.output_key === member.output_key);
  if (!refs || outputs.length !== 1 || member.dataset_id !== identity.datasetId
    || !records(member.rows).some(row => row.record_id === identity.recordId && row.record_version === identity.recordVersion)) fail('MEMBER', '行版本不属于冻结成员。');
  const output = outputs[0]!, expected = records(object(output.payload).rows).filter(row => row[r1PayloadRowKey(output)] === identity.recordId);
  if (expected.length !== 1) fail('ROW', '冻结输入没有唯一对应行。');
  const binding = readR1ContractBinding(member, identity.datasetId, identity.productId, true)!;
  signal?.throwIfAborted();
  const { result } = await runtime.client.fixedReadHistory(found.snapshotId, identity.productId, signal);
  signal?.throwIfAborted();
  const checkCurrent = () => {
    options.assertCurrent(found.requestId);
    if (options.control().generation !== generation || canonicalWfdJson(options.handoff.attempt(found.requestId)) !== frozen
      || canonicalWfdJson(options.handoff.recordMaterials(identity, 'read_only')) !== canonicalWfdJson(found)) fail('CHANGED', '等待期间服务、冻结请求或关联变化，未返回来源。');
  };
  checkCurrent();
  if (Buffer.byteLength(canonicalWfdJson(result)) > 8 * 1024 * 1024 || result.snapshot_id !== found.snapshotId) fail('READBACK', '固定读回快照或预算不符。');
  const products = records(result.products).filter(item => item.product_id === identity.productId && item.dataset_id === identity.datasetId
    && object(item.definition_ref).digest === member.definition_digest);
  const rows = records(result.rows).filter(item => item.product_id === identity.productId && item.record_id === identity.recordId && item.record_version === identity.recordVersion);
  if (products.length !== 1 || rows.length !== 1 || !frozenR1RowMatches(expected[0]!, object(rows[0]!.row))) fail('READBACK', '实际固定行、内容或定义与原回执不符。');
  assertR1ContractBinding(products[0]!, binding);
  const rowRef = object(rows[0]!.record_ref);
  if (rowRef.snapshot_id !== found.snapshotId || rowRef.product_id !== identity.productId || rowRef.logical_key !== identity.recordId
    || rowRef.revision_id !== identity.recordVersion) fail('READBACK', '实际记录引用不符。');
  if (refs.sourceRefs.length !== 1 || refs.originalIds.length + refs.materialIds.length !== 1)
    fail('SOURCE_BYTES_UNVERIFIED', '冻结成员缺唯一实际原件身份，不能将来源声明当作已核对字节。');
  const source = refs.sourceRefs[0]!;
  // Read permission belongs to the existing private local-data boundary. Do not apply current_publish admission here.
  for (const originalId of refs.originalIds) {
    const original = options.database.connection.prepare(`SELECT o.source_json,o.source_digest,o.sha256,c.original_bytes
      FROM r1_originals o JOIN r1_original_contents c ON c.sha256=o.sha256 WHERE original_id=?`).get(originalId);
    if (!original || wfdSha256(String(original.source_json)) !== original.source_digest
      || canonicalWfdJson(JSON.parse(String(original.source_json))) !== canonicalWfdJson(source)
      || !(original.original_bytes instanceof Uint8Array) || original.original_bytes.byteLength !== source.bytes
      || wfdSha256(original.original_bytes) !== source.sha256 || original.sha256 !== source.sha256) fail('SOURCE', '原件或冻结来源摘要不符。');
  }
  const materials = found.materialIds.map(materialId => {
    const material = options.materials.get(materialId), original = options.materials.readOriginal(materialId);
    if (original.sha256 !== source.sha256 || original.bytes.byteLength !== source.bytes) fail('SOURCE', '材料实际原件不符。');
    return { materialId, sha256: original.sha256, bytes: original.bytes.byteLength, filename: material.envelope.filename,
      originalUrl: `/api/bd/materials/${encodeURIComponent(materialId)}/original` };
  });
  checkCurrent();
  return { schema: 'bd.record-evidence/1', ...identity, requestId: found.requestId, snapshotId: found.snapshotId,
    source, materials, originalIds: found.originalIds, processRefs: refs.processRefs, evidenceRefs: refs.evidenceRefs,
    gaps: materials.length ? [] : [{ code: 'DOWNLOAD_MATERIAL_LINK_UNAVAILABLE' }],
    sourceBytesStatus: 'verified', processingRefsStatus: 'frozen_reference_not_revalidated',
    evidenceRefsStatus: 'frozen_reference_not_revalidated',
    qualification: 'fixed_record_source_association', factVerification: 'not_established',
    limitations: ['local private-access gate; no per-document ACL', 'source association does not verify source claims', 'not historical knowledge qualification'] };
}
function records(value: unknown): WfdRecord[] { return Array.isArray(value) ? value.filter(isWfdRecord) : []; }
function object(value: unknown): WfdRecord { return isWfdRecord(value) ? value : {}; }
function fail(code: string, message: string): never { throw new TaskError('R1_EVIDENCE_' + code, message); }

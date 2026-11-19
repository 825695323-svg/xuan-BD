import { fixedRowConsumption } from './r1-fixed-row-consumption.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { R1HandoffService, R1LocalReferences } from './r1-structured-handoff.js';
import type { R1Runtime } from './r1-runtime.js';
import { assertR1ContractBinding, frozenR1RowMatches, readR1ContractBinding } from './r1-tabular.js';
import { r1PayloadRowKey } from './r1-paged-readback.js';
import { readRecordDependencySelection } from './processing-record-dependencies.js';

/** Bounded output-level provenance, not record-level causation or an exhaustive impact graph. */
export async function readOutputDependencies(requestId: string, value: unknown, options: {
  database: CoreDatabase; processing: ProcessingPlanService; handoff: R1HandoffService;
  assertCurrent(planId: string, outputId: string): R1Runtime;
  control(): { generation: number; stopped: boolean };
}, checkAccess: () => void, signal?: AbortSignal, mode: 'output' | 'fixed_rows' = 'output') {
  if (!isWfdRecord(value) || Object.keys(value).sort().join(',') !== 'outputId,planId,recordRefs'
    || !identifier(value.planId) || !identifier(value.outputId)) fail('INPUT', '须明确单一加工计划、输出及完整固定输入引用。');
  const planId = value.planId, outputId = value.outputId;
  const recordRefs = readRecordDependencySelection({ recordRefs: value.recordRefs });
  checkAccess();
  const runtime = options.assertCurrent(planId, outputId), generation = options.control().generation;
  const attempt = options.handoff.attempt(requestId), frozen = canonicalWfdJson(attempt);
  if (attempt.state !== 'associated') fail('NOT_ASSOCIATED', '该请求尚无完整正式关联；未知发送结果不表示未发布。');
  const document = object(JSON.parse(String(attempt.document_json)));
  const receipt = object(JSON.parse(String(attempt.receipt_json)));
  const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
  const outputs = records(document.outputs);
  if (outputs.length !== 1 || refs.outputs || !Array.isArray(refs.processRefs) || refs.processRefs.length !== 1)
    fail('SCOPE', '本查询只支持指定单输出请求，不猜测集合成员或跨输出传播。');
  const dependency = options.processing.fieldDependencies(planId, outputId, { recordRefs });
  const process = refs.processRefs[0]!;
  if (process.plan_id !== planId || process.output_id !== outputId || process.output_sha256 !== dependency.outputSha256
    || process.document_sha256 !== attempt.document_sha256) fail('OUTPUT_CHANGED', '请求冻结的加工输出与当前已核产物不一致。');
  const output = outputs[0]!, expected = records(object(output.payload).rows);
  if (!expected.length || expected.length > 128 || !Array.isArray(receipt.rows) || receipt.rows.length !== expected.length
    || receipt.output_key !== output.output_key) fail('BUDGET_OR_MEMBER', '本查询最多核对128个正式记录且必须完整匹配单一冻结成员。');
  const rowProof = mode === 'fixed_rows' ? fixedRowConsumption(options.processing, planId, outputId, runtime.currentIdentity(), expected) : null;
  const snapshotId = String(receipt.snapshot_id), productId = String(receipt.product_id), datasetId = String(receipt.dataset_id);
  const binding = readR1ContractBinding(receipt, datasetId, productId, true)!;
  const associations = () => options.database.connection.prepare(`SELECT snapshot_id,product_id,dataset_id,record_id,record_version,definition_digest
    FROM r1_record_associations WHERE request_id=? ORDER BY product_id,record_id,record_version LIMIT 129`).all(requestId) as unknown as WfdRecord[];
  const local = associations(), localFrozen = canonicalWfdJson(local);
  if (local.length !== expected.length) fail('ASSOCIATION', '正式关联条数与完整冻结成员不一致。');
  const current = () => {
    signal?.throwIfAborted(); checkAccess(); options.assertCurrent(planId, outputId);
    if (options.control().generation !== generation || canonicalWfdJson(options.handoff.attempt(requestId)) !== frozen
      || canonicalWfdJson(associations()) !== localFrozen
      || canonicalWfdJson(options.processing.fieldDependencies(planId, outputId, { recordRefs })) !== canonicalWfdJson(dependency))
      fail('CHANGED', '读取期间身份、冻结请求、关联或加工证据变化，未返回旧关联。');
    if (rowProof && canonicalWfdJson(fixedRowConsumption(options.processing, planId, outputId, runtime.currentIdentity(), expected)) !== canonicalWfdJson(rowProof))
      fail('CHANGED', '逐行消费证据在读取期间变化。');
  };
  current();
  const { result } = await runtime.client.fixedReadHistory(snapshotId, productId, signal);
  current();
  if (Buffer.byteLength(canonicalWfdJson(result)) > 8 * 1024 * 1024 || result.snapshot_id !== snapshotId)
    fail('READBACK', '固定读回快照或预算不符。');
  const products = records(result.products).filter(p => p.product_id === productId && p.dataset_id === datasetId
    && object(p.definition_ref).digest === receipt.definition_digest);
  if (products.length !== 1) fail('READBACK', '固定产品合同不唯一或不符。');
  assertR1ContractBinding(products[0]!, binding);
  const published = local.map(a => {
    if (a.snapshot_id !== snapshotId || a.product_id !== productId || a.dataset_id !== datasetId
      || a.definition_digest !== receipt.definition_digest) fail('ASSOCIATION', '正式关联属于另一快照、产品或合同。');
    const input = expected.filter(r => r[r1PayloadRowKey(output)] === a.record_id);
    const members = records(receipt.rows).filter(r => r.record_id === a.record_id && r.record_version === a.record_version);
    const rows = records(result.rows).filter(r => r.product_id === productId && r.record_id === a.record_id && r.record_version === a.record_version);
    if (input.length !== 1 || members.length !== 1 || rows.length !== 1 || !frozenR1RowMatches(input[0]!, object(rows[0]!.row)))
      fail('READBACK', '正式行、内容或版本与冻结成员不符。');
    const expectedRef = { snapshot_id: snapshotId, product_id: productId, logical_key: a.record_id, revision_id: a.record_version };
    if (canonicalWfdJson(rows[0]!.record_ref) !== canonicalWfdJson(expectedRef)) fail('READBACK', '正式记录四元组不符。');
    return expectedRef;
  });
  current();
  if (rowProof) return { schema: 'bd.fixed-row-consumption/1', requestId, planId, outputId,
    outputSha256: dependency.outputSha256, coverage: 'selected_request_output_only',
    transformation: 'financial_standardize_unchanged_rows', fullDownstreamImpact: 'unknown',
    inputInstance: rowProof.status === 'verified' ? { connectionId: runtime.currentIdentity().connectionId,
      runtimeIdentity: runtime.currentIdentity().runtimeIdentity, bindingSha256: wfdSha256(canonicalWfdJson(runtime.currentIdentity())) } : null,
    publication: { status: 'fixed_output_publication_verified', snapshotId, productId, datasetId, records: published },
    results: recordRefs.map(sourceRecordRef => {
      const matches = rowProof.edges.filter(e => canonicalWfdJson(e.source) === canonicalWfdJson(sourceRecordRef));
      return { sourceRecordRef, status: rowProof.status === 'unknown' ? 'unknown' : matches.length ? 'consumed' : 'not_observed',
        reason: rowProof.reason, outputRecords: matches.flatMap(e => published.filter(p => p.logical_key === e.outputKey)) };
    }), limitations: ['only this fixed output; no full downstream absence claim',
      'unchanged applies only to parsed rows through final structure; frozen R1 mapping may project source fields',
      'consumption is not numerical-change or complete financial-semantic preservation',
      'no current-use, historical-knowledge or independent source-truth qualification', 'no new ACL or write action'] };
  return { schema: 'bd.output-publication-dependencies/1', requestId, planId, outputId,
    outputSha256: dependency.outputSha256, inputObservations: dependency.recordImpact,
    publication: { status: 'fixed_output_publication_verified', snapshotId, productId, datasetId, records: published },
    coverage: 'selected_request_output_only', rowAttribution: 'unknown', fullDownstreamImpact: 'unknown',
    limitations: ['parse observations are not published-row causation', 'no full-library scan or cross-output inference',
      'fixed publication is not current-use or historical-knowledge qualification', 'existing private local-data gate; no new per-document ACL'] };
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value); }
function records(value: unknown): WfdRecord[] { return Array.isArray(value) ? value.filter(isWfdRecord) : []; }
function object(value: unknown): WfdRecord { return isWfdRecord(value) ? value : {}; }
function fail(code: string, message: string): never { throw new TaskError('R1_OUTPUT_DEPENDENCIES_' + code, message); }

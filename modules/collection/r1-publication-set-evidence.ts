import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1PrepareInput } from '../../contracts/r1-contracts.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { R1HandoffService, R1LocalReferences } from './r1-structured-handoff.js';
import type { R1Runtime } from './r1-runtime.js';
import { verifyFixedPublishedRows } from './r1-output-dependencies.js';
import { checkR1MappedRows } from './r1-event.js';
import { readR1ContractBinding } from './r1-tabular.js';

/** Explicit complete set only. No write, continuation, impact inference or fallback to another request. */
export async function readPublicationSetEvidence(requestId: string, value: unknown, options: {
  database: CoreDatabase; processing: ProcessingPlanService; handoff: R1HandoffService;
  current(planId: string, setId: string): { runtime: R1Runtime; inputs: R1PrepareInput[] };
  generation(): number;
}, checkAccess: () => void, signal?: AbortSignal) {
  if (!isWfdRecord(value) || Object.keys(value).sort().join(',') !== 'planId,setId'
    || ![value.planId,value.setId].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/u.test(v))) fail('INPUT');
  const deadline = AbortSignal.timeout(180_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  signal.throwIfAborted();
  const planId = String(value.planId), setId = String(value.setId);
  checkAccess();
  const { runtime, inputs } = options.current(planId,setId), generation = options.generation();
  const frozenInputs = canonicalWfdJson(inputs), attempt = options.handoff.attempt(requestId), frozenAttempt = canonicalWfdJson(attempt);
  if (attempt.state !== 'associated') fail('NOT_ASSOCIATED');
  const document = obj(JSON.parse(String(attempt.document_json))), receipt = obj(JSON.parse(String(attempt.receipt_json)));
  const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
  const outputs = list(document.outputs), members = list(receipt.members), outcomes = list(receipt.output_results);
  const keys = inputs.map(i => i.target.outputKey).sort();
  if (inputs.length < 2 || inputs.length > 16 || new Set(keys).size !== keys.length
    || refs.publicationSetId !== setId || !refs.outputs || !sameKeys(Object.keys(refs.outputs),keys)
    || !sameKeys(outputs.map(o=>o.output_key),keys) || !sameKeys(members.map(o=>o.output_key),keys)
    || !sameKeys(outcomes.map(o=>o.output_key),keys)
    || Object.keys(obj(document.consistency_groups)).join(',') !== setId
    || !sameKeys(obj(document.consistency_groups)[setId],keys)
    || receipt.kind !== 'publication_set' || !['published_formal','published_sandbox'].includes(String(receipt.wfd_state))
    || !Array.isArray(receipt.failed_outputs) || receipt.failed_outputs.length
    || canonicalWfdJson(receipt.request_identity) !== canonicalWfdJson(document.request_identity)) fail('MEMBERS');
  const total = outputs.reduce((n,o)=>n+list(obj(o.payload).rows).length,0);
  if (!total || total > 128 || new Set(members.map(m=>m.product_id)).size !== members.length) fail('BUDGET_OR_OVERLAP');
  const associations = () => options.database.connection.prepare(`SELECT snapshot_id,product_id,dataset_id,record_id,record_version,definition_digest
    FROM r1_record_associations WHERE request_id=? ORDER BY product_id,record_id,record_version LIMIT 129`).all(requestId) as unknown as WfdRecord[];
  const local = associations(), frozenLocal = canonicalWfdJson(local);
  if (local.length !== total || new Set(local.map(r=>canonicalWfdJson([r.product_id,r.record_id]))).size !== total) fail('ASSOCIATIONS');
  const process = inputs.map(input => {
    const key = input.target.outputKey, own = refs.outputs![key]!;
    if (own.outputs || !Array.isArray(own.processRefs) || own.processRefs.length !== 1) fail('PROCESS');
    const p = own.processRefs[0]!, candidate = options.processing.candidateOutput(planId,input.outputId);
    const bytes = options.processing.outputArtifact(planId,input.outputId).bytes;
    if (p.plan_id !== planId || p.output_id !== input.outputId || p.output_sha256 !== candidate.ref.sha256
      || p.document_sha256 !== attempt.document_sha256 || wfdSha256(bytes) !== candidate.ref.sha256) fail('PROCESS');
    const rows = obj(JSON.parse(bytes.toString('utf8'))).rows;
    if (!Array.isArray(rows)) fail('PROCESS');
    const checked = checkR1MappedRows(rows, candidate.target?.declaration);
    if (checked.quality !== 'pass' || canonicalWfdJson(checked.rows) !== canonicalWfdJson(obj(outputs.find(o=>o.output_key===key)!.payload).rows)) fail('PROCESS');
    return { input, process: p, outputSha256: candidate.ref.sha256 };
  });
  if (!Array.isArray(refs.processRefs) || canonicalWfdJson([...refs.processRefs].sort((a,b)=>String(a.output_id).localeCompare(String(b.output_id))))
    !== canonicalWfdJson(process.map(p=>p.process).sort((a,b)=>String(a.output_id).localeCompare(String(b.output_id))))) fail('PROCESS');
  const current = () => {
    signal?.throwIfAborted(); checkAccess();
    if (options.generation() !== generation || canonicalWfdJson(options.current(planId,setId).inputs) !== frozenInputs
      || canonicalWfdJson(options.handoff.attempt(requestId)) !== frozenAttempt || canonicalWfdJson(associations()) !== frozenLocal)
      fail('CHANGED');
    for (const p of process) if (options.processing.candidateOutput(planId,p.input.outputId).ref.sha256 !== p.outputSha256
      || wfdSha256(options.processing.outputArtifact(planId,p.input.outputId).bytes) !== p.outputSha256) fail('CHANGED');
  };
  const verified = []; let readBytes = 0;
  for (const p of process) {
    const key = p.input.target.outputKey, member = members.find(m=>m.output_key===key)!, outcome = outcomes.find(m=>m.output_key===key)!;
    if (typeof receipt.snapshot_id !== 'string' || !receipt.snapshot_id || member.snapshot_id !== receipt.snapshot_id
      || outcome.snapshot_id !== receipt.snapshot_id || outcome.product_id !== member.product_id
      || member.dataset_id !== p.input.target.datasetId || member.dataset_id !== attempt.dataset_id
      || outcome.publication_state !== receipt.wfd_state || obj(outcome.definition_ref).digest !== member.definition_digest
      || canonicalWfdJson(member.request_identity) !== canonicalWfdJson(document.request_identity)
      || canonicalWfdJson(readR1ContractBinding(outcome,String(member.dataset_id),String(member.product_id),true))
        !== canonicalWfdJson(readR1ContractBinding(member,String(member.dataset_id),String(member.product_id),true))) fail('RECEIPT');
    const memberRecords = list(member.rows).map(r=>[r.record_id,r.record_version]).sort();
    if (canonicalWfdJson(list(outcome.records).map(r=>[r.record_id,r.record_version]).sort()) !== canonicalWfdJson(memberRecords)) fail('RECEIPT');
    current();
    const { result } = await runtime.client.fixedReadHistory(String(member.snapshot_id),String(member.product_id),signal);
    current(); readBytes += Buffer.byteLength(canonicalWfdJson(result));
    if (readBytes > 8*1024*1024) fail('BUDGET_OR_OVERLAP');
    const records = verifyFixedPublishedRows(outputs.find(o=>o.output_key===key)!,member,local.filter(a=>a.product_id===member.product_id),result);
    verified.push({ outputId:p.input.outputId,outputKey:key,outputSha256:p.outputSha256,
      snapshotId:member.snapshot_id,productId:member.product_id,datasetId:member.dataset_id,records });
  }
  current();
  return { schema:'bd.publication-set-evidence/1',requestId,planId,setId,status:'complete_fixed_set_verified',coverage:'selected_set_only',
    snapshotId:receipt.snapshot_id,publicationState:receipt.wfd_state,members:verified,recordCount:total,impact:'unknown',
    limitations:['fixed publication is not current-use, source-truth or historical qualification','no downstream causation or full-library scan','no suspend, correction, approval or recovery action'] };
}
function obj(v: unknown): WfdRecord { return isWfdRecord(v) ? v : {}; }
function list(v: unknown): WfdRecord[] { if(!Array.isArray(v)||v.some(x=>!isWfdRecord(x))) fail('MEMBERS'); return v as WfdRecord[]; }
function sameKeys(v:unknown, keys:string[]): boolean { return Array.isArray(v) && v.length===keys.length && v.every(x=>typeof x==='string') && canonicalWfdJson([...v].sort())===canonicalWfdJson(keys); }
function fail(code:string):never { throw new TaskError('R1_SET_EVIDENCE_'+code,'指定发布集合的完整固定证据未通过核验；未返回部分成功、未执行恢复或变更。'); }

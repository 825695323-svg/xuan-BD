import { request, RequestError } from './api';
import { readBound, correctionDetail, type CorrectionCaseDetail } from './correction-cases-api';
export interface FixedRef { snapshot_id: string; product_id: string; logical_key: string; revision_id: string }
export interface OutputSelection { planId: string; outputId: string; requestId: string }
export interface DownstreamView extends OutputSelection {
  outputSha256: string; snapshotId: string; productId: string; datasetId: string; records: FixedRef[];
  inputs: { ref: FixedRef; status: 'observed' | 'not_observed' | 'unknown' }[]; gapCount: number;
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const outputIdentifier = (x: string) => /^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const fixed = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f]/u.test(x) && !/^(latest|current)$/iu.test(x);
const digest = (x: unknown): x is string => typeof x === 'string' && /^(sha256:)?[a-f0-9]{64}$/u.test(x);
function invalid(): never { throw new RequestError('CORRECTION_DOWNSTREAM_INVALID', null, 'CORRECTION_DOWNSTREAM_INVALID'); }
function ref(raw: unknown): FixedRef {
  if (!object(raw) || Object.keys(raw).sort().join(',') !== 'logical_key,product_id,revision_id,snapshot_id'
    || ![raw.snapshot_id, raw.product_id, raw.logical_key, raw.revision_id].every(fixed)) invalid();
  return { snapshot_id: String(raw.snapshot_id), product_id: String(raw.product_id), logical_key: String(raw.logical_key), revision_id: String(raw.revision_id) };
}
const equal = (a: FixedRef, b: FixedRef) => JSON.stringify(a) === JSON.stringify(b);
export function caseInputRefs(detail: CorrectionCaseDetail): FixedRef[] {
  if (!detail.records.length || detail.records.length > 128 || detail.records.length !== detail.itemCount) invalid();
  const refs = detail.records.map(r => ref({ snapshot_id: r.snapshotId, product_id: r.productId, logical_key: r.businessKey, revision_id: r.recordVersion }));
  if (new Set(refs.map(r => JSON.stringify(r))).size !== refs.length) invalid();
  return refs;
}
/** Candidate observations and verified output publication remain separate claims. Never project match rows as published-row attribution. */
export function downstreamView(raw: unknown, selection: OutputSelection, refs: FixedRef[]): DownstreamView {
  if (!object(raw) || raw.schema !== 'bd.output-publication-dependencies/1' || raw.coverage !== 'selected_request_output_only'
    || raw.rowAttribution !== 'unknown' || raw.fullDownstreamImpact !== 'unknown' || !digest(raw.outputSha256)
    || !Object.entries(selection).every(([k,v]) => raw[k] === v) || !object(raw.publication) || !object(raw.inputObservations)) invalid();
  const p = raw.publication, input = raw.inputObservations;
  if (p.status !== 'fixed_output_publication_verified' || ![p.snapshotId,p.productId,p.datasetId].every(fixed)
    || !Array.isArray(p.records) || p.records.length < 1 || p.records.length > 128
    || input.coverage !== 'selected_output_verified_parse_candidate_edges_only' || input.downstreamImpact !== 'unknown'
    || input.publishedProductQualification !== 'not_asserted' || !Array.isArray(input.results) || input.results.length !== refs.length
    || !Array.isArray(input.gaps) || !input.gaps.every(g => typeof g === 'string')) invalid();
  const gapCount = input.gaps.length;
  const records = p.records.map(ref);
  if (records.some(r => r.snapshot_id !== p.snapshotId || r.product_id !== p.productId) || new Set(records.map(r => JSON.stringify(r))).size !== records.length) invalid();
  const inputs = input.results.map((r, index) => {
    if (!object(r) || !equal(ref(r.sourceRecordRef),refs[index]!) || !['observed','not_observed','unknown'].includes(String(r.status)) || !Array.isArray(r.matches)) invalid();
    if ((r.status === 'observed') !== (r.matches.length > 0) || r.status === 'not_observed' && gapCount || r.status === 'unknown' && !gapCount) invalid();
    for (const m of r.matches) if (!object(m) || !equal(ref(m.sourceRecordRef),refs[index]!) || !fixed(m.parsedBusinessKey)
      || !fixed(m.stepId) || !digest(m.specDigest) || !digest(m.sourceArtifactSha256)) invalid();
    return { ref: refs[index]!, status: r.status as DownstreamView['inputs'][number]['status'] };
  });
  return { ...selection, outputSha256: raw.outputSha256, snapshotId: String(p.snapshotId), productId: String(p.productId), datasetId: String(p.datasetId), records, inputs, gapCount };
}
export async function readCorrectionDownstream(detail: CorrectionCaseDetail, selection: OutputSelection, connection: string) {
  if (!Object.values(selection).every(outputIdentifier)) invalid();
  const refs = caseInputRefs(detail);
  return readBound(async () => {
    const sameCase = async () => { const current = correctionDetail(await request(`/api/bd/corrections/cases/${encodeURIComponent(detail.caseId)}`));
      if (JSON.stringify(current) !== JSON.stringify(detail)) invalid(); };
    await sameCase();
    const result = downstreamView(await request(`/api/bd/r1/requests/${encodeURIComponent(selection.requestId)}/output-dependencies`, 'POST',
    { planId: selection.planId, outputId: selection.outputId, recordRefs: refs }, { requireLocalData: true }), selection, refs);
    await sameCase(); return result;
  }, connection);
}

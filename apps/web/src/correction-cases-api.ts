import { request, RequestError } from './api';
import { dataBrowserApi } from './data-browser-api';
import { localDataGeneration, localDataRevision } from './local-data-context';

const states = ['registered', 'impact_incomplete', 'impact_frozen', 'suspend_failed', 'suspended', 'prepared',
  'authorization_pending', 'authorization_rejected', 'repairing', 'verified', 'resolved', 'blocked'] as const;
export type CorrectionState = typeof states[number];
export interface CorrectionCaseSummary {
  caseId: string; kind: 'processing_repair' | 'source_correction'; state: CorrectionState;
  itemCount: number; gapCount: number; taskIds: string[];
}
export interface CorrectionCaseDetail extends CorrectionCaseSummary {
  impactSha256: string | null; frozenSha256: string | null;
  suspension: 'active' | 'resolved' | 'unknown';
  records: { productId: string; snapshotId: string; businessKey: string; recordVersion: string; state: string }[];
  gaps: string[];
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/u.test(x);
const digest = (x: unknown) => x === null || typeof x === 'string' && /^(sha256:)?[a-f0-9]{64}$/u.test(x);
function invalid(): never { throw new RequestError('CORRECTION_VIEW_INVALID', null, 'CORRECTION_VIEW_INVALID'); }
// Only identifiers/state/counts are projected. Free-form evidence, error messages, raw payloads and paths are not rendered.
export function correctionSummary(raw: unknown): CorrectionCaseSummary {
  if (!object(raw) || !id(raw.caseId) || !['processing_repair', 'source_correction'].includes(String(raw.kind))
    || !states.includes(raw.state as CorrectionState) || raw.coverage !== 'proven_subset_only'
    || !Number.isSafeInteger(raw.itemCount) || Number(raw.itemCount) < 0
    || !Array.isArray(raw.gaps) || !raw.gaps.every(x => typeof x === 'string')) invalid();
  const taskIds = [raw.authorizationTaskId, raw.repairTaskId];
  if (!taskIds.every(x => x === null || id(x))) invalid();
  return { caseId: raw.caseId, kind: raw.kind as CorrectionCaseSummary['kind'], state: raw.state as CorrectionState,
    itemCount: Number(raw.itemCount), gapCount: raw.gaps.length, taskIds: [...new Set(taskIds.filter(id))] };
}
const knownGaps = ['no_proven_impact', 'no_plan_matches_error_binding', 'plan_scan_over_budget',
  'coverage:proven_associations_only;missing_or_unsent_products_not_provable_in_this_scope'];
export function correctionDetail(raw: unknown): CorrectionCaseDetail {
  const summary = correctionSummary(raw);
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length !== summary.itemCount
    || !digest(raw.impactSha256) || !digest(raw.frozenSha256)) invalid();
  const records = raw.items.map(item => {
    if (!object(item) || ![item.productId, item.snapshotId, item.businessKey, item.recordVersion].every(id)
      || !['suspended', 'corrected', 'pending', 'unknown'].includes(String(item.state))) invalid();
    return { productId: String(item.productId), snapshotId: String(item.snapshotId), businessKey: String(item.businessKey),
      recordVersion: String(item.recordVersion), state: String(item.state) };
  });
  const suspension = object(raw.suspension) && ['active', 'resolved'].includes(String(raw.suspension.state))
    ? raw.suspension.state as 'active' | 'resolved' : 'unknown';
  return { ...summary, records, suspension, impactSha256: raw.impactSha256 as string | null, frozenSha256: raw.frozenSha256 as string | null,
    gaps: (raw.gaps as string[]).map(gap => knownGaps.includes(gap) ? gap : 'additional_gap_details_withheld') };
}
async function capabilities() {
  const raw = await request('/api/bd/corrections/capabilities');
  if (!object(raw) || raw.version !== 'bd.post-publication-correction/1' || raw.coverage !== 'proven_subset_only'
    || typeof raw.connectionSha256 !== 'string' || !digest(raw.connectionSha256)) invalid();
  return raw.connectionSha256;
}
/** Same bound connection and local qualification before/after each existing read. No corrective commands here. */
export async function readBound<T>(read: () => Promise<T>, expected?: string) {
  const generation = localDataGeneration(), revision = localDataRevision();
  const connection = await capabilities();
  if (expected !== undefined && expected !== connection) throw new RequestError('CORRECTION_SCOPE_CHANGED', null, 'CORRECTION_SCOPE_CHANGED');
  const value = await read();
  if (await capabilities() !== connection || generation !== localDataGeneration() || revision !== localDataRevision())
    throw new RequestError('CORRECTION_SCOPE_CHANGED', null, 'CORRECTION_SCOPE_CHANGED');
  return { connection, value };
}
export const correctionCasesApi = {
  list: () => readBound(async () => {
    const raw = await request('/api/bd/corrections/cases');
    if (!object(raw) || !Array.isArray(raw.items)) invalid();
    const items = raw.items.map(correctionSummary);
    if (new Set(items.map(item => item.caseId)).size !== items.length) invalid();
    return items;
  }),
  detail: (caseId: string, connection: string) => readBound(async () => {
    const detail = correctionDetail(await request(`/api/bd/corrections/cases/${encodeURIComponent(caseId)}`));
    if (detail.caseId !== caseId) invalid();
    return detail;
  }, connection),
  task: (taskId: string, connection: string) => readBound(async () => {
    const task = await dataBrowserApi.processingTask(taskId);
    if (task.jobId !== taskId || task.operation !== 'data.correction.repair') invalid();
    return { jobId: task.jobId, requestId: task.requestId, status: task.status, requiresReview: task.requiresReview };
  }, connection),
};

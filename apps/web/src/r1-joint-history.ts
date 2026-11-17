import type { R1ProductDiscovery } from '../../../contracts/r1-contracts';
import { assertR1FilterEcho } from './r1-filter-history';
import { R1HistoryError } from './r1-read-history';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = (): never => { throw new R1HistoryError('R1_JOINT_ECHO_MISMATCH', '联合检索的固定时间、索引或精确资料关联无法核对；未采用本页。', 'The fixed time, index or exact evidence association cannot be verified; this page was not accepted.'); };
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
async function sha(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Existing snapshot and public-history contracts only. Document holding is not a WFD instance/stage assertion. */
export async function assertR1JointEcho(input: { structured: RecordValue; documents: RecordValue }, result: RecordValue,
  discovery: R1ProductDiscovery, previousHash?: string): Promise<void> {
  const plan = input.structured, docs = input.documents, mode = plan.history_mode, historical = mode === 'market_known_at';
  if (!['snapshot_contents', 'market_known_at'].includes(String(mode))) throw new R1HistoryError('R1_JOINT_HISTORY_UNSUPPORTED',
    '本入口不把文档持有时间映射为 WFD 实例或阶段资格。', 'This UI does not map document holding times to WFD instance or stage eligibility.');
  const asOf = historical ? object(plan.knowledge_cutoff).earliest_utc : null;
  if (docs.mode !== (historical ? mode : null) || docs.asOf !== asOf || !identifier(docs.indexVersion)
    || !['keyword', 'exact'].includes(String(docs.method)) || !identifier(docs.query)) fail();
  const structured = object(result.structured), qualification = object(result.qualification);
  assertR1FilterEcho(plan, structured, discovery, previousHash);
  if (result.schema !== 'bd.structured-document-retrieval/1' || qualification.mode !== mode || qualification.as_of !== asOf
    || qualification.same_historical_cutoff !== historical || qualification.historical_claim !== historical
    || qualification.snapshot_content_only !== !historical || qualification.document_index_version !== docs.indexVersion
    || canonical(result.page) !== canonical(structured.page) || !Array.isArray(result.objects) || !Array.isArray(result.gaps)
    || result.context_digest !== 'sha256:' + await sha(canonical({ schema: 'bd.structured-document-retrieval/1', documents: docs }))) fail();
  const expectedGaps = historical ? [] : [{ code: 'SNAPSHOT_CONTENTS_HAS_NO_HISTORICAL_QUALIFICATION' }];
  if (canonical(result.gaps) !== canonical(expectedGaps)) fail();
  const expected = structured.objects as unknown[];
  if ((result.objects as unknown[]).length !== expected.length) fail();
  for (let index = 0; index < expected.length; index++) {
    const source = object(expected[index]), joined = object((result.objects as unknown[])[index]);
    for (const key of ['subject', 'values', 'record_refs']) if (canonical(source[key]) !== canonical(joined[key])) fail();
    if (!Array.isArray(joined.associations) || !Array.isArray(joined.gaps)) fail();
    const references = Object.values(object(source.record_refs)).map(raw => {
      const ref = object(raw), record = object(ref.record_ref);
      return { datasetId: plan.dataset_id, productId: ref.product_id, recordId: record.logical_key, recordVersion: record.revision_id };
    });
    const documentIds = new Set<string>(), seen = new Set<string>();
    for (const raw of joined.associations as unknown[]) {
      const association = object(raw), tuple = Object.fromEntries(['datasetId', 'productId', 'recordId', 'recordVersion'].map(key => [key, association[key]]));
      const key = canonical(tuple);
      if (seen.has(key) || !references.some(ref => canonical(ref) === key) || !identifier(association.requestId) || !identifier(association.snapshotId)
        || !Array.isArray(association.materialIds) || !association.materialIds.every(identifier)) fail();
      seen.add(key); (association.materialIds as string[]).forEach(id => documentIds.add(id));
    }
    if (joined.documents === null) {
      if (documentIds.size || !(joined.gaps as unknown[]).some(raw => { const gap = object(raw); return ['BD_RECORD_ASSOCIATION_MISSING', 'DOCUMENT_MATERIAL_LINK_MISSING'].includes(String(gap.code))
        && Object.hasOwn(object(source.record_refs), String(gap.metric)); })) fail();
      continue;
    }
    const retrieval = object(joined.documents), query = object(retrieval.query), coverage = object(retrieval.coverage), q = object(retrieval.qualification);
    if (!documentIds.size || retrieval.schema !== 'bd.doc-retrieval/2' || query.method !== docs.method || query.text !== docs.query || query.as_of !== asOf
      || q.mode !== (historical ? 'market_known_at' : 'system_held_at') || q.applied !== historical
      || !Array.isArray(retrieval.citations) || !Array.isArray(retrieval.gaps) || !Array.isArray(coverage.excluded)
      || coverage.as_of !== (historical ? Date.parse(String(asOf)) : null)) fail();
    if (!['matched', 'no_match', 'index_missing', 'history_unavailable'].includes(String(retrieval.status))
      || !(retrieval.gaps as unknown[]).includes('permission_scope_not_implemented')) fail();
    if (retrieval.status === 'index_missing') {
      if (coverage.index_version !== null || coverage.index_built_at !== null || q.index_built_at !== null || (retrieval.citations as unknown[]).length || (coverage.excluded as unknown[]).length) fail();
    } else if (coverage.index_version !== docs.indexVersion || typeof coverage.index_built_at !== 'number' || q.index_built_at !== coverage.index_built_at) fail();
    if (retrieval.status !== 'index_missing' && retrieval.status !== ((retrieval.citations as unknown[]).length ? 'matched'
      : historical && (coverage.excluded as unknown[]).length ? 'history_unavailable' : 'no_match')) fail();
    const requiredGap = retrieval.status === 'index_missing' ? 'DOCUMENT_INDEX_MISSING' : retrieval.status === 'history_unavailable' ? 'DOCUMENT_HISTORY_UNAVAILABLE' : retrieval.status === 'no_match' ? 'NO_DOCUMENT_MATCH_IN_VERIFIED_SCOPE' : null;
    if (requiredGap && !(joined.gaps as unknown[]).some(raw => { const gap = object(raw); return gap.code === requiredGap
      && (requiredGap !== 'DOCUMENT_INDEX_MISSING' || gap.indexVersion === docs.indexVersion)
      && (requiredGap !== 'DOCUMENT_HISTORY_UNAVAILABLE' || canonical(gap.excluded) === canonical(coverage.excluded)); })) fail();
    if (q.reconstruction !== (historical && typeof q.index_built_at === 'number' && q.index_built_at > Date.parse(String(asOf)) ? 'post_hoc' : 'none')) fail();
    for (const raw of coverage.excluded as unknown[]) if (!documentIds.has(String(object(raw).document_id))) fail();
    for (const raw of retrieval.citations as unknown[]) {
      const cite = object(raw);
      if (!documentIds.has(String(cite.document_id)) || cite.index_version !== docs.indexVersion
        || !['segment_id', 'document_version', 'parser_version', 'artifact_ref'].every(key => identifier(cite[key]))
        || typeof cite.text_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(cite.text_digest)
        || typeof cite.excerpt !== 'string' || typeof cite.excerpt_truncated !== 'boolean'
        || !Number.isSafeInteger(cite.page_number) || Number(cite.page_number) < 1
        || !Number.isSafeInteger(cite.char_start) || !Number.isSafeInteger(cite.char_end)
        || Number(cite.char_start) < 0 || Number(cite.char_end) < Number(cite.char_start)) fail();
      const span = Number(cite.char_end) - Number(cite.char_start), excerptLength = (cite.excerpt as string).length;
      if (cite.excerpt_truncated ? excerptLength >= span : excerptLength !== span) fail();
      // A shortened excerpt cannot prove the full segment digest. Never invent omitted bytes.
      if (!cite.excerpt_truncated && await sha(cite.excerpt as string) !== cite.text_digest) fail();
    }
  }
  const complete = (result.objects as unknown[]).every(raw => (object(raw).gaps as unknown[]).length === 0) && object(structured.coverage).data_complete === true;
  const expectedStatus = structured.status === 'matched' ? complete ? 'matched' : 'coverage_insufficient' : structured.status;
  if (result.status !== expectedStatus) fail();
}

import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { R1HandoffService } from './r1-structured-handoff.js';
import type { SegmentService } from './segments/service.js';
import type { SegmentRetrievalResult } from './segments/contracts.js';

export const JOINT_RETRIEVAL_SCHEMA = 'bd.structured-document-retrieval/1';
interface StructuredQueryPort { filterObjects(value: unknown, signal?: AbortSignal, contextDigest?: string): Promise<WfdRecord> }

/** Joins exact verified record versions to BD evidence. No fuzzy subject inference or new evidence registrations. */
export class StructuredRetrievalService {
  constructor(private readonly options: { structured: StructuredQueryPort; handoff: Pick<R1HandoffService, 'recordMaterials'>;
    segments: SegmentService }) {
    options.segments.attachJointRetrieval('/api/bd/retrieval/joint');
  }

  capabilities(): WfdRecord {
    return { schema: JOINT_RETRIEVAL_SCHEMA, structuredProtocol: 'wfd.filter-objects/1.4-product1',
      documentSchema: 'bd.doc-retrieval/2', identityJoin: 'verified dataset/product/record/version association -> material document',
      historicalModes: ['market_known_at', 'system_held_at'],
      asOfRule: 'both sides use structured knowledge_cutoff.earliest_utc; coarse cutoffs remain conservative',
      fixedDocumentIndexRequired: true, maxDocumentLimitPerObject: 50,
      snapshotContents: 'current content association only; no historical qualification and no history-mode mapping',
      limitations: ['no inferred entity/listing relationships', 'missing BD row association or document index remains a specific gap',
        'local documents have no per-document permission model', 'WFD current-only business policy remains enforced'] };
  }

  async search(value: unknown, signal?: AbortSignal): Promise<WfdRecord> {
    const input = object(value, ['structured', 'documents']);
    const plan = object(input.structured, ['dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage',
      'universe', 'metrics', 'business_time_range', 'predicate', 'order_by', 'page_size', 'cursor']);
    const docs = object(input.documents, ['method', 'query', 'limit', 'indexVersion', 'mode', 'asOf']);
    if (!['keyword', 'exact'].includes(String(docs.method)) || typeof docs.query !== 'string' || !docs.query.trim()
      || docs.query.length > 2048 || typeof docs.indexVersion !== 'string' || !docs.indexVersion || docs.indexVersion.length > 128
      || (docs.limit !== undefined && (!Number.isSafeInteger(docs.limit) || Number(docs.limit) < 1 || Number(docs.limit) > 50))) {
      fail('JOINT_RETRIEVAL_INPUT', '联合检索须固定文档索引、检索方式和非空文本；每个对象最多50条证据。');
    }
    const history = plan.history_mode ?? 'snapshot_contents';
    const historical = history === 'system_held_at' || history === 'market_known_at';
    let asOf: string | null = null;
    if (historical) {
      const cutoff = plan.knowledge_cutoff;
      if (!isWfdRecord(cutoff) || cutoff.status !== 'known' || typeof cutoff.earliest_utc !== 'string'
        || docs.mode !== history || docs.asOf !== cutoff.earliest_utc) {
        fail('JOINT_HISTORY_MISMATCH', '两侧须明确使用同一种历史资格和同一知识截止，不能以业务日期或当前索引代替。');
      }
      asOf = cutoff.earliest_utc;
    } else if (history !== 'snapshot_contents' || docs.mode !== null || docs.asOf !== null) {
      fail('JOINT_SNAPSHOT_HISTORY_UNSUPPORTED', '快照内容联合只接受mode=null/asOf=null，不把固定内容映射成文档历史资格。');
    }
    // The document/index context is included in the WFD-signed query cursor.
    // A later page cannot silently replace the text, index or history mode.
    const contextDigest = 'sha256:' + wfdSha256(canonicalWfdJson({ schema: JOINT_RETRIEVAL_SCHEMA, documents: docs }));
    const structured = await this.options.structured.filterObjects(plan, signal, contextDigest);
    const objects = Array.isArray(structured.objects) ? structured.objects : [];
    const joined: WfdRecord[] = [];
    for (const item of objects) {
      if (!isWfdRecord(item) || !isWfdRecord(item.subject) || !isWfdRecord(item.record_refs)) {
        fail('JOINT_STRUCTURED_RESPONSE', '筛选对象缺少可核对的主体和记录版本。');
      }
      const materialIds = new Set<string>(), associations: WfdRecord[] = [], gaps: WfdRecord[] = [];
      const seen = new Set<string>();
      for (const [metric, record] of Object.entries(item.record_refs)) {
        const ref = isWfdRecord(record) && isWfdRecord(record.record_ref) ? record.record_ref : null;
        if (!isWfdRecord(record) || !ref || typeof ref.logical_key !== 'string' || typeof ref.revision_id !== 'string'
          || typeof record.product_id !== 'string' || typeof structured.dataset_id !== 'string') {
          fail('JOINT_STRUCTURED_RESPONSE', '筛选数值缺少精确产品、行和版本引用。');
        }
        const identity = { datasetId: structured.dataset_id, productId: record.product_id,
          recordId: ref.logical_key, recordVersion: ref.revision_id };
        const key = canonicalWfdJson(identity);
        if (seen.has(key)) continue;
        seen.add(key);
        const found = this.options.handoff.recordMaterials(identity);
        if (!found) { gaps.push({ code: 'BD_RECORD_ASSOCIATION_MISSING', metric, ...identity }); continue; }
        if (!found.materialIds.length) { gaps.push({ code: 'DOCUMENT_MATERIAL_LINK_MISSING', metric, requestId: found.requestId }); continue; }
        found.materialIds.forEach(id => materialIds.add(id));
        associations.push({ ...identity, ...found });
      }
      const retrieval: SegmentRetrievalResult | null = materialIds.size ? this.options.segments.search({
        method: docs.method as 'keyword' | 'exact', query: docs.query as string,
        limit: Number(docs.limit ?? 20), indexVersion: docs.indexVersion as string,
        asOf, ...(historical ? { mode: history } : {}), documentIds: [...materialIds].sort(),
      }) : null;
      if (retrieval?.status === 'index_missing') gaps.push({ code: 'DOCUMENT_INDEX_MISSING', indexVersion: docs.indexVersion });
      if (retrieval?.status === 'history_unavailable') gaps.push({ code: 'DOCUMENT_HISTORY_UNAVAILABLE', excluded: retrieval.coverage.excluded });
      if (retrieval?.status === 'no_match') gaps.push({ code: 'NO_DOCUMENT_MATCH_IN_VERIFIED_SCOPE' });
      if (retrieval && !retrieval.citations.length && !retrieval.coverage.excluded.length && retrieval.status !== 'index_missing') {
        const indexed = new Set(this.options.segments.documents().map(document => document.document_id));
        for (const id of materialIds) if (!indexed.has(id)) gaps.push({ code: 'DOCUMENT_NOT_INDEXED', materialId: id });
      }
      joined.push({ subject: item.subject, values: item.values, record_refs: item.record_refs,
        associations, documents: retrieval, gaps });
    }
    const complete = joined.every(item => Array.isArray(item.gaps) && !item.gaps.length)
      && isWfdRecord(structured.coverage) && structured.coverage.data_complete === true;
    return { schema: JOINT_RETRIEVAL_SCHEMA, structured,
      status: structured.status === 'matched' ? complete ? 'matched' : 'coverage_insufficient' : structured.status,
      qualification: { mode: history, as_of: asOf, same_historical_cutoff: historical,
        historical_claim: historical, snapshot_content_only: !historical,
        document_index_version: docs.indexVersion,
        note: historical ? '两侧分别执行同一种资格门后按精确行版本关联。' : '固定内容关联；两侧均不声明历史可知或当时持有。' },
      objects: joined, context_digest: contextDigest,
      page: structured.page,
      gaps: historical ? [] : [{ code: 'SNAPSHOT_CONTENTS_HAS_NO_HISTORICAL_QUALIFICATION' }] };
  }
}

function fail(code: string, message: string): never { throw new TaskError(code, message); }
function object(value: unknown, allowed: string[]): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail('JOINT_RETRIEVAL_INPUT', '参数须符合已登记的窄查询入口。');
  }
  return value as WfdRecord;
}

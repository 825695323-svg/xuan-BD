import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

export const EVENT_TEXT_VERSION = 'bd-event-source-excerpts/1';
export interface EventTextSelection {
  version: typeof EVENT_TEXT_VERSION;
  sourceSha256: string;
  occurrence: { namespace: string; publisherId: string; publicationId: string; kind: 'original' | 'repost';
    upstreamPublicationId: string | null };
  reviewBasis: string;
  excerpts: { start: number; end: number; quote: string }[];
}
const fail = (message: string): never => { throw new TaskError('EVENT_TEXT_SELECTION', message); };
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
/** 显式登记原文位置及传播身份；身份声明不自动证明发布权限、独立来源或事件真实发生。 */
export function readEventTextSelection(raw: unknown): EventTextSelection {
  if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'excerpts,occurrence,reviewBasis,sourceSha256,version'
    || raw.version !== EVENT_TEXT_VERSION || typeof raw.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sourceSha256)
    || !text(raw.reviewBasis, 4000) || !isWfdRecord(raw.occurrence)) fail('事件选录须有固定原件摘要、传播身份与明确核定依据。');
  const value = raw as unknown as EventTextSelection, occurrence = value.occurrence;
  if (Object.keys(occurrence).sort().join(',') !== 'kind,namespace,publicationId,publisherId,upstreamPublicationId'
    || !text(occurrence.namespace) || !text(occurrence.publisherId) || !text(occurrence.publicationId)
    || !['original', 'repost'].includes(occurrence.kind)
    || !(occurrence.upstreamPublicationId === null || text(occurrence.upstreamPublicationId))
    || occurrence.kind === 'original' && occurrence.upstreamPublicationId !== null
    || !Array.isArray(value.excerpts) || !value.excerpts.length || value.excerpts.length > 64
    || value.excerpts.some(item => !isWfdRecord(item) || Object.keys(item).sort().join(',') !== 'end,quote,start'
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.end <= item.start
      || !text(item.quote, 65536))) fail('传播身份或原文位置不完整；转载上游未知须明确留空，不猜独立来源。');
  return structuredClone(value);
}

export function projectEventText(bytes: Uint8Array, raw: EventTextSelection) {
  const selection = readEventTextSelection(raw);
  if (wfdSha256(bytes) !== selection.sourceSha256) fail('事件原文字节与冻结摘要不符。');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('事件原文须为明确 UTF-8；识别或翻译结果不能伪装原文。'); }
  const { occurrence } = selection;
  const occurrenceId = 'occurrence_' + wfdSha256(canonicalWfdJson({ namespace: occurrence.namespace,
    publisherId: occurrence.publisherId, publicationId: occurrence.publicationId }));
  let previousEnd = -1;
  const records = selection.excerpts.map(excerpt => {
    if (excerpt.start < previousEnd || excerpt.end > source.length || source.slice(excerpt.start, excerpt.end) !== excerpt.quote)
      fail('事件原文范围重叠、乱序、越界或与引用不一致。');
    previousEnd = excerpt.end;
    return { business_key: 'claim_' + wfdSha256(canonicalWfdJson({ occurrenceId,
      sourceSha256: selection.sourceSha256, start: excerpt.start, end: excerpt.end })),
      occurrence_id: occurrenceId, source_namespace: occurrence.namespace, publisher_id: occurrence.publisherId,
      publication_id: occurrence.publicationId, publication_kind: occurrence.kind,
      upstream_publication_id: occurrence.upstreamPublicationId, independence_status: 'not_established',
      assertion_kind: 'source_claim', occurrence_identity_basis: 'operator_declared', text_role: 'source_excerpt', text: excerpt.quote,
      content_sha256: wfdSha256(excerpt.quote), source_sha256: selection.sourceSha256,
      source_start: excerpt.start, source_end: excerpt.end, position_unit: 'utf16_code_units',
      public_time_status: 'unknown' };
  });
  const jsonBytes = Buffer.from(canonicalWfdJson(records));
  return { jsonBytes, evidence: { version: EVENT_TEXT_VERSION, selection,
    publishedContentSha256: wfdSha256(jsonBytes), scope: 'exact_source_excerpts_and_declared_occurrence',
    independentSemanticVerification: false, publicTimeEstablished: false, eventOccurrenceEstablished: false } };
}

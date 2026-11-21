import { wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import type { DocSegment } from './contracts.js';
import type { SegmentSourceRef } from './from-conversion.js';
import { segmentId } from './segmenter.js';

/** 原生节点的身份、产物来源与文本坐标沿用同一片段合同。 */
export function nativeSegment(ref: SegmentSourceRef, parserVersion: string, ordinal: number, anchor: unknown,
  value: Pick<DocSegment, 'page_number' | 'page_label' | 'section_path' | 'bbox' | 'text' | 'table' | 'issues'>): DocSegment {
  const textDigest = wfdSha256(value.text), kind = value.table ? 'table' : 'paragraph';
  return { ...value, kind, ordinal, document_id: ref.documentId, document_version: ref.documentVersion,
    parser_version: parserVersion, source_ref: ref.artifactRef, text_digest: textDigest, char_start: 0, char_end: 0,
    segment_id: segmentId({ ...ref, parserVersion, kind, pageNumber: value.page_number, anchor, textDigest }) };
}

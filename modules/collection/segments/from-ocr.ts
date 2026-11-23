import { isWfdRecord, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { parseVisionObservations } from '../../../platform/capabilities/ocr/evidence.js';
import { mediaPacketDigest } from '../data-processing/ocr-claim.js';
import { OCR_PACKET_SCHEMA, SEGMENTER_VERSION } from './contracts.js';
import type { SegmentSourceRef } from './from-conversion.js';
import { nativeSegment } from './native-segment.js';
import { finishSegments } from './segmenter.js';

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,128}$/u.test(v);
function reference(v: unknown) {
  return isWfdRecord(v) && id(v.fileRefId) && Number.isSafeInteger(v.fileRefVersion) && Number(v.fileRefVersion) > 0 && sha(v.sha256);
}
export const OCR_PARSER_VERSION = SEGMENTER_VERSION + '+ocr-review-1';
export const OCR_REVIEW_REF = /^ocr-review:([\w.:-]{1,128}):([a-f0-9]{64})$/u;

/** Byte/shape validation for deterministic replay. Admission also requires the independent host reader. */
export function checkOcrPacket(packet: unknown, documentId: string) {
  if (!isWfdRecord(packet) || packet.schema !== OCR_PACKET_SCHEMA || 'operation' in packet || 'content' in packet || !id(packet.taskId)
    || !isWfdRecord(packet.source) || packet.source.materialId !== documentId || packet.source.detectedType === 'xlsx' || !reference(packet.source)
    || !isWfdRecord(packet.original) || packet.original.sha256 !== packet.source.sha256
    || packet.reviewStatus !== 'not_recorded' || packet.eventEligibility !== 'not_established'
    || packet.textBasis !== 'ocr_recognition' || packet.coordinateUnit !== 'original_image_page_1_top_left_normalized'
    || !isWfdRecord(packet.textReference) || !reference(packet.textReference) || !isWfdRecord(packet.evidenceReference) || !reference(packet.evidenceReference)
    || packet.textReference.fileRefId === packet.evidenceReference.fileRefId || typeof packet.text !== 'string'
    || packet.textReference.sha256 !== wfdSha256(packet.text) || !sha(packet.packetSha256) || mediaPacketDigest(packet) !== packet.packetSha256)
    throw new Error('OCR 核对包的来源、产物摘要、坐标单位或核对状态不一致。');
  const observations = parseVisionObservations(packet.observations, packet.text);
  if (!observations.length || observations.some(item => !item.text.trim())) throw new Error('OCR 核对包缺少可用识别文本。');
  return { taskId: packet.taskId, packetSha256: packet.packetSha256, observations, evidenceSha256: packet.evidenceReference.sha256 };
}

export function segmentsFromOcrPacket(packet: unknown, ref: SegmentSourceRef) {
  const { observations, evidenceSha256 } = checkOcrPacket(packet, ref.documentId);
  const issue = 'ocr_unverified_recognition';
  const segments = observations.map(({ page, text, boundingBox: box }, index) =>
    nativeSegment(ref, OCR_PARSER_VERSION, index + 1, [evidenceSha256, index], {
      page_number: page, page_label: null, section_path: [], text, table: null, issues: [issue],
      bbox: { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height,
        coordinate_unit: 'original_image_page_1_top_left_normalized' },
    }));
  return { ...finishSegments(segments, [{ code: issue, page: 1 }]), pageCount: 1 };
}

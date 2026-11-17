import { CoreError } from '../../platform/runtime/errors.js';
import { parseVisionEvidence } from '../../platform/capabilities/ocr/evidence.js';
import { readMediaReviewSource, sameMediaEvidence as same, type MediaReviewServices } from './media-review-source.js';

const unavailable = (): never => { throw new CoreError('OCR_REVIEW_UNAVAILABLE', 'OCR 原件、任务来源或完整证据未能一致核对；未生成核对结论。', 409); };
/** Existing OCR packet shape and interpretation remain unchanged. */
export async function readOcrReviewPacket(services: MediaReviewServices, materialId: string, taskId: string) {
  const source = readMediaReviewSource(services, materialId, taskId, 'material.ocr', unavailable);
  const { result, artifact } = source;
  const text = await artifact(result.textReference), json = await artifact(result.evidenceReference);
  let evidence: ReturnType<typeof parseVisionEvidence>;
  try { evidence = parseVisionEvidence(json, text); } catch { return unavailable(); }
  if (!evidence.observations.length || !Array.isArray(result.segments) || result.segments.length > 200
    || result.segmentCount !== evidence.observations.length || result.segmentsTruncated !== (result.segments.length !== evidence.observations.length)) return unavailable();
  const fullSegments = evidence.observations.map(item => ({ text: item.text, location: { page: item.page, region: item.boundingBox } }));
  if (!same(result.segments, fullSegments.slice(0, result.segments.length))) return unavailable();
  source.assertCurrent();
  return { schema: 'bd-ocr-review-packet/1', taskId, source: source.source,
    original: source.original,
    textReference: result.textReference, evidenceReference: result.evidenceReference, text, observations: evidence.observations,
    image: { width: evidence.width, height: evidence.height },
    recognizer: { revision: evidence.revision, osVersion: evidence.osVersion, languages: evidence.languages },
    coordinateUnit: 'original_image_page_1_top_left_normalized', textBasis: 'ocr_recognition',
    reviewStatus: 'not_recorded', eventEligibility: 'not_established',
    limitations: ['识别文字和检测框尚未逐字核对，不是原件文本偏移或已核实事实。', '不记录人工确认、不建立事件候选资格、不创建任务或修改原件。'] };
}

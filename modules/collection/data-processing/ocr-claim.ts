import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

const fail = (): never => { throw new TaskError('OCR_CLAIM_EVIDENCE', '媒体识别派生主张须来自固定原件与当前可核的识别包；未核实事实或人工签认。'); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export interface OcrClaimSelection { taskId: string; packetSha256: string; sourceSha256: string; observationIndex: number; eventId: string; eventType: string }
export type OcrClaimReader = (materialId: string, taskId: string) => Promise<unknown>;
export function readOcrClaimSelection(v: unknown): OcrClaimSelection {
  if (!isWfdRecord(v) || Object.keys(v).sort().join(',') !== 'eventId,eventType,observationIndex,packetSha256,sourceSha256,taskId'
    || !id(v.taskId) || !id(v.eventId) || !id(v.eventType) || !sha(v.packetSha256) || !sha(v.sourceSha256)
    || !Number.isSafeInteger(v.observationIndex) || Number(v.observationIndex) < 0) return fail();
  return structuredClone(v) as unknown as OcrClaimSelection;
}
export function mediaPacketDigest(packet: WfdRecord): string {
  const fixed = { ...packet }; delete fixed.packetSha256;
  return wfdSha256(canonicalWfdJson(fixed));
}
export const ocrPacketDigest = mediaPacketDigest;
export const OCR_CLAIM_FIELDS = ['statement', 'text_basis', 'source_sha256', 'media_evidence_sha256', 'human_verification', 'fact_verification'] as const;
/** This is a claim about recognition output, never a claim that the depicted statement is true. */
export function projectOcrClaim(bytes: Uint8Array, materialId: string, raw: unknown, packet: unknown) {
  const selection = readOcrClaimSelection(raw);
  if (!isWfdRecord(packet) || packet.schema !== 'bd-ocr-review-packet/1' || packet.taskId !== selection.taskId
    || packet.textBasis !== 'ocr_recognition' || packet.coordinateUnit !== 'original_image_page_1_top_left_normalized'
    || packet.reviewStatus !== 'not_recorded' || packet.eventEligibility !== 'not_established'
    || !isWfdRecord(packet.source) || packet.source.materialId !== materialId || packet.source.sha256 !== selection.sourceSha256
    || wfdSha256(bytes) !== selection.sourceSha256 || ocrPacketDigest(packet) !== selection.packetSha256
    || packet.packetSha256 !== selection.packetSha256 || !Array.isArray(packet.observations)) return fail();
  const observation = packet.observations[selection.observationIndex];
  if (!isWfdRecord(observation) || typeof observation.text !== 'string' || !observation.text.trim() || observation.text.length > 16384
    || !isWfdRecord(observation.boundingBox) || observation.page !== 1) return fail();
  const box = observation.boundingBox;
  if (!['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]))
    || Number(box.x) < 0 || Number(box.y) < 0 || Number(box.width) <= 0 || Number(box.height) <= 0
    || Number(box.x) + Number(box.width) > 1 || Number(box.y) + Number(box.height) > 1) return fail();
  const evidence = { schema: 'bd.ocr-source-claim/1', selection, source: packet.source, textReference: packet.textReference,
    evidenceReference: packet.evidenceReference, recognizer: packet.recognizer, image: packet.image,
    coordinateUnit: packet.coordinateUnit, observation, accessBinding: packet.accessBinding ?? null };
  return projectClaimRow(selection, observation.text, 'ocr_recognition', evidence);
}
function projectClaimRow(selection: OcrClaimSelection | TranscriptionClaimSelection, text: string, basis: string, evidence: WfdRecord) {
  const row = { event_id: selection.eventId, event_type: selection.eventType, assertion_kind: 'source_claim',
    statement: text, text_basis: basis, source_sha256: selection.sourceSha256,
    media_evidence_sha256: wfdSha256(canonicalWfdJson(evidence)), human_verification: 'unknown', fact_verification: 'unknown', value_state: 'valid_value' };
  return { jsonBytes: Buffer.from(canonicalWfdJson([row])), evidence: { ...evidence, publishedContentSha256: wfdSha256(canonicalWfdJson([row])) } };
}
export function assertOcrClaimDeclaration(declaration: unknown): void {
  if (!isWfdRecord(declaration) || !isWfdRecord(declaration.mapping) || !isWfdRecord(declaration.target)) return fail();
  const m = declaration.mapping, t = declaration.target;
  if (m.kind !== 'event_records' || m.contentNature !== 'source_claim' || m.status !== 'unknown'
    || m.eventId !== 'event_id' || m.eventType !== 'event_type' || m.assertionKind !== 'assertion_kind'
    || !isWfdRecord(m.eventTime) || m.eventTime.status !== 'unknown' || !isWfdRecord(m.publicTime) || m.publicTime.status !== 'unknown'
    || m.caseId !== undefined || m.expectedTime !== undefined || t.inputMode !== 'partial_observation'
    || t.definitionPublicTime !== undefined || !Array.isArray(m.fields) || m.fields.length !== OCR_CLAIM_FIELDS.length
    || !OCR_CLAIM_FIELDS.every(key => (m.fields as unknown[]).some((f: unknown) => isWfdRecord(f) && f.fieldCode === key && f.value === key && f.state === 'value_state'))) return fail();
}


export interface TranscriptionClaimSelection extends Omit<OcrClaimSelection, 'observationIndex'> { segmentIndex: number }
export function readTranscriptionClaimSelection(v: unknown): TranscriptionClaimSelection {
  if (!isWfdRecord(v) || Object.keys(v).sort().join(',') !== 'eventId,eventType,packetSha256,segmentIndex,sourceSha256,taskId') return transcriptionFail();
  const { segmentIndex, ...rest } = v;
  try { readOcrClaimSelection({ ...rest, observationIndex: segmentIndex }); } catch { return transcriptionFail(); }
  return structuredClone(v) as unknown as TranscriptionClaimSelection;
}
const transcriptionFail = (): never => { throw new TaskError('TRANSCRIPTION_CLAIM_EVIDENCE', '转录主张须来自固定原件、模型与原生时段，不代表已核实事实或人工签认。'); };
export function projectTranscriptionClaim(bytes: Uint8Array, materialId: string, raw: unknown, packet: unknown) {
  const selection = readTranscriptionClaimSelection(raw);
  if (!isWfdRecord(packet) || packet.schema !== 'bd-transcription-review-packet/1' || packet.taskId !== selection.taskId
    || packet.textBasis !== 'transcription_recognition' || packet.coordinateUnit !== 'original_media_milliseconds_half_open'
    || packet.reviewStatus !== 'not_recorded' || packet.eventEligibility !== 'not_established'
    || !isWfdRecord(packet.source) || packet.source.materialId !== materialId || packet.source.sha256 !== selection.sourceSha256
    || wfdSha256(bytes) !== selection.sourceSha256 || mediaPacketDigest(packet) !== selection.packetSha256
    || packet.packetSha256 !== selection.packetSha256 || !Array.isArray(packet.segments)
    || !isWfdRecord(packet.recognizer) || packet.recognizer.backend !== 'whisper.cpp-local'
    || !sha(packet.recognizer.modelSha256) || !Number.isSafeInteger(packet.recognizer.durationMs) || Number(packet.recognizer.durationMs) <= 0
    || !isWfdRecord(packet.probeReference)) return transcriptionFail();
  const segment = packet.segments[selection.segmentIndex];
  if (!isWfdRecord(segment) || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.length > 16384
    || !isWfdRecord(segment.location)) return transcriptionFail();
  const { startMs, endMs, cueIndex } = segment.location;
  // Review tolerates native trailing estimates; publication does not clamp or adopt out-of-source intervals.
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || Number(startMs) < 0 || Number(endMs) <= Number(startMs)
    || Number(endMs) > Number(packet.recognizer.durationMs) || cueIndex !== selection.segmentIndex + 1) return transcriptionFail();
  const evidence = { schema: 'bd.transcription-source-claim/1', selection, source: packet.source, textReference: packet.textReference,
    evidenceReference: packet.evidenceReference, probeReference: packet.probeReference, recognizer: packet.recognizer,
    taskVersions: packet.taskVersions, coordinateUnit: packet.coordinateUnit, segment, accessBinding: packet.accessBinding ?? null };
  return projectClaimRow(selection, segment.text, 'transcription_recognition', evidence);
}
export const assertMediaClaimDeclaration = assertOcrClaimDeclaration;

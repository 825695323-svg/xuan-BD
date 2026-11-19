import { mediaPacketDigest } from '../../modules/collection/data-processing/ocr-claim.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { parseWhisperTranscription } from '../../platform/capabilities/transcription/local.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { readMediaReviewSource, sameMediaEvidence, type MediaReviewServices } from './media-review-source.js';

const unavailable = (): never => { throw new CoreError('TRANSCRIPTION_REVIEW_UNAVAILABLE', '转录原件、执行模型、原生时段或完整证据未能一致核对；未生成核对结论。', 409); };
/** Pure engine-specific validation. Inputs must first be read from pinned task-owned artifacts. */
export function parseTranscriptionReviewEvidence(recognition: unknown, probeJson: string, nativeJson: string, text: string, sourceSha256: string) {
  if (!isWfdRecord(recognition) || Object.keys(recognition).sort().join(',') !== 'backend,durationMs,modelSha256'
    || recognition.backend !== 'whisper.cpp-local' || typeof recognition.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(recognition.modelSha256)
    || !Number.isSafeInteger(recognition.durationMs) || Number(recognition.durationMs) <= 0 || Number(recognition.durationMs) > 3600000) return unavailable();
  for (const value of [probeJson, nativeJson, text]) if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024) return unavailable();
  let envelope: unknown, probe: unknown;
  try { envelope = JSON.parse(probeJson); } catch { return unavailable(); }
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256) || !isWfdRecord(envelope)
    || Object.keys(envelope).sort().join(',') !== 'modelSha256,probeOutput,schema,sourceSha256'
    || envelope.schema !== 'bd-local-transcription-probe/1' || envelope.sourceSha256 !== sourceSha256
    || envelope.modelSha256 !== recognition.modelSha256 || typeof envelope.probeOutput !== 'string') return unavailable();
  try { probe = JSON.parse(envelope.probeOutput); } catch { return unavailable(); }
  if (!isWfdRecord(probe) || !isWfdRecord(probe.format) || !Array.isArray(probe.streams)
    || !probe.streams.some(stream => isWfdRecord(stream) && stream.codec_type === 'audio')) return unavailable();
  const rawDuration = probe.format.duration;
  if (typeof rawDuration !== 'number' && (typeof rawDuration !== 'string' || !/^\d+(?:\.\d+)?$/u.test(rawDuration))) return unavailable();
  const seconds = Number(rawDuration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600 || Math.ceil(seconds * 1000) !== recognition.durationMs) return unavailable();
  let segments: ReturnType<typeof parseWhisperTranscription>;
  try { segments = parseWhisperTranscription(nativeJson, text, Number(recognition.durationMs)); } catch { return unavailable(); }
  return { recognizer: { backend: 'whisper.cpp-local' as const, modelSha256: recognition.modelSha256, durationMs: Number(recognition.durationMs) }, segments };
}

export async function readTranscriptionReviewPacket(services: MediaReviewServices, materialId: string, taskId: string) {
  const lifecycle = services.options.localData;
  const accessBinding = lifecycle ? { dataId: lifecycle.dataId, generation: lifecycle.lifecycle.assertActive().generation } : null;
  const source = readMediaReviewSource(services, materialId, taskId, 'material.transcribe', unavailable);
  const { result, artifact } = source;
  // Missing historical execution metadata is never filled from current bindings or segment ends.
  const text = await artifact(result.textReference), json = await artifact(result.evidenceReference), probe = await artifact(result.probeReference);
  const evidence = parseTranscriptionReviewEvidence(result.recognition, probe, json, text, String(source.source.sha256));
  if (!Array.isArray(result.segments) || result.segments.length > 200 || result.segmentCount !== evidence.segments.length
    || result.segmentsTruncated !== (result.segments.length !== evidence.segments.length)
    || !sameMediaEvidence(result.segments, evidence.segments.slice(0, result.segments.length))) return unavailable();
  source.assertCurrent();
  if (accessBinding) lifecycle!.lifecycle.assertPrivateAccess(accessBinding.generation);
  const packet = { accessBinding, taskVersions: services.tasks.get(taskId).versions, schema: 'bd-transcription-review-packet/1', taskId, source: source.source, original: source.original,
    textReference: result.textReference, evidenceReference: result.evidenceReference, probeReference: result.probeReference,
    text, segments: evidence.segments, recognizer: evidence.recognizer,
    coordinateUnit: 'original_media_milliseconds_half_open', textBasis: 'transcription_recognition',
    reviewStatus: 'not_recorded', eventEligibility: 'not_established',
    limitations: ['转录文字及原生时段尚未逐字核对，不是已核实事实或原件文本偏移。',
      '沿用既有转录校验：文本换行和行首尾空白规范化比对，末端允许最多1000毫秒识别容差；不据字数推算位置。',
      '不记录人工确认、不自行建立事件候选资格、不创建任务或修改原件。'] };
  return { ...packet, packetSha256: mediaPacketDigest(packet) };
}

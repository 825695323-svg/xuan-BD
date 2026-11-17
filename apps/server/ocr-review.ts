import { CoreError } from '../../platform/runtime/errors.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { parseVisionEvidence } from '../../platform/capabilities/ocr/evidence.js';
import { readArtifactForDownload } from './platform-routes.js';
import type { ApplicationServices } from './services.js';

type Services = Pick<ApplicationServices, 'database' | 'tasks' | 'files' | 'direct' | 'artifactRoot' | 'options'>;
const unavailable = (): never => { throw new CoreError('OCR_REVIEW_UNAVAILABLE', 'OCR 原件、任务来源或完整证据未能一致核对；未生成核对结论。', 409); };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
const same = (a: unknown, b: unknown) => { try { return canonicalWfdJson(a) === canonicalWfdJson(b); } catch { return false; } };

/** Authenticated local UI read only. Uses existing personal task/cross-store links,
 * never accepts caller paths, OCR text, review flags, or a prior run's authority. */
export async function readOcrReviewPacket(services: Services, materialId: string, taskId: string) {
  if (!id(materialId) || !id(taskId)) return unavailable();
  const companion = services.options.workspaceServices;
  if (!companion?.materials || !services.database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_material_calls'").get()) return unavailable();
  const task = services.tasks.get(taskId);
  if (task.runtimeId !== 'direct' || task.action !== 'material.ocr' || task.status !== 'succeeded' || task.requiresReview) return unavailable();
  const args = task.args, data = task.result?.data;
  if (!isWfdRecord(args) || args.materialId !== materialId || !isWfdRecord(data) || data.kind !== 'conversation-material'
    || data.materialId !== materialId || !isWfdRecord(data.mediaResult)) return unavailable();
  const call = services.database.connection.prepare('SELECT service_task_id,material_id,operation FROM conversation_material_calls WHERE local_task_id=?').get(taskId);
  const link = services.database.connection.prepare('SELECT service_task_id,sha256,file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?').get(materialId);
  if (!call || !link || call.material_id !== materialId || call.operation !== 'material.ocr' || call.service_task_id !== link.service_task_id
    || data.serviceTaskId !== link.service_task_id || data.fileRefId !== link.file_ref_id || args.fileRefId !== link.file_ref_id) return unavailable();
  const custody = companion.tasks.get(String(link.service_task_id));
  if (custody.status !== 'succeeded') return unavailable();
  const material = companion.materials.getByTask(String(link.service_task_id));
  if (!material || material.envelope.materialId !== materialId) return unavailable();
  if (material.envelope.sha256 !== link.sha256 || data.originalSha256 !== link.sha256) return unavailable();
  const result = data.mediaResult;
  const expectedSource = { materialId, fileRefId: link.file_ref_id, fileRefVersion: link.file_ref_version, sha256: link.sha256 };
  if (!same(result.source, expectedSource) || !isWfdRecord(result.plugin) || result.plugin.id !== 'material.ocr' || result.plugin.version !== '1') return unavailable();
  // Only re-read the already-custodied original, not arbitrary external user paths.
  const original = companion.materials.readOriginal(materialId);
  if (original.sha256 !== link.sha256 || wfdSha256(original.bytes) !== link.sha256) return unavailable();
  const sourceRef = services.files.verify(String(link.file_ref_id));
  services.direct.assertPublicPath(sourceRef.invocationPath);
  if (sourceRef.kind !== 'file' || sourceRef.version !== link.file_ref_version) return unavailable();
  const artifact = async (raw: unknown) => {
    if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'fileRefId,fileRefVersion,sha256' || !id(raw.fileRefId)
      || !Number.isSafeInteger(raw.fileRefVersion) || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)) return unavailable();
    const reference = services.files.verify(raw.fileRefId);
    if (reference.version !== raw.fileRefVersion || reference.size > 8 * 1024 * 1024
      || !reference.relations.some(relation => relation.kind === 'task' && relation.id === taskId)
      || !task.result?.artifactIds?.includes(raw.fileRefId)) return unavailable();
    // Existing download path enforces generated/artifact ownership, application
    // artifact root, public-path protection, stable file handles and no links.
    const { buffer } = await readArtifactForDownload(services, raw.fileRefId);
    if (wfdSha256(buffer) !== raw.sha256) return unavailable();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return unavailable(); }
  };
  const text = await artifact(result.textReference), json = await artifact(result.evidenceReference);
  let evidence: ReturnType<typeof parseVisionEvidence>;
  try { evidence = parseVisionEvidence(json, text); } catch { return unavailable(); }
  if (!evidence.observations.length || !Array.isArray(result.segments) || result.segments.length > 200
    || result.segmentCount !== evidence.observations.length || result.segmentsTruncated !== (result.segments.length !== evidence.observations.length)) return unavailable();
  const fullSegments = evidence.observations.map(item => ({ text: item.text, location: { page: item.page, region: item.boundingBox } }));
  if (!same(result.segments, fullSegments.slice(0, result.segments.length))) return unavailable();
  // Detect task/link changes during the asynchronous artifact reads.
  if (services.tasks.get(taskId).version !== task.version
    || !same(link, services.database.connection.prepare('SELECT service_task_id,sha256,file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?').get(materialId))
    || !same(call, services.database.connection.prepare('SELECT service_task_id,material_id,operation FROM conversation_material_calls WHERE local_task_id=?').get(taskId))) return unavailable();
  return { schema: 'bd-ocr-review-packet/1', taskId, source: expectedSource,
    original: { filename: material.envelope.filename, mediaType: material.envelope.mediaType, sha256: link.sha256,
      url: `/api/bd/materials/${encodeURIComponent(materialId)}/original` },
    textReference: result.textReference, evidenceReference: result.evidenceReference, text, observations: evidence.observations,
    image: { width: evidence.width, height: evidence.height },
    recognizer: { revision: evidence.revision, osVersion: evidence.osVersion, languages: evidence.languages },
    coordinateUnit: 'original_image_page_1_top_left_normalized', textBasis: 'ocr_recognition',
    reviewStatus: 'not_recorded', eventEligibility: 'not_established',
    limitations: ['识别文字和检测框尚未逐字核对，不是原件文本偏移或已核实事实。', '不记录人工确认、不建立事件候选资格、不创建任务或修改原件。'] };
}

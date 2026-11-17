import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { readArtifactForDownload } from './platform-routes.js';
import type { ApplicationServices } from './services.js';

export type MediaReviewServices = Pick<ApplicationServices, 'database' | 'tasks' | 'files' | 'direct' | 'artifactRoot' | 'options'>;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
export const sameMediaEvidence = (a: unknown, b: unknown) => { try { return canonicalWfdJson(a) === canonicalWfdJson(b); } catch { return false; } };
const same = sameMediaEvidence;
/** Shared read-only provenance and pinned artifacts; no new tasks, permissions, or fallback sources. */
export function readMediaReviewSource(services: MediaReviewServices, materialId: string, taskId: string,
  action: 'material.ocr' | 'material.transcribe', unavailable: () => never) {
  if (!id(materialId) || !id(taskId)) return unavailable();
  const companion = services.options.workspaceServices;
  if (!companion?.materials || !services.database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_material_calls'").get()) return unavailable();
  const task = services.tasks.get(taskId);
  if (task.runtimeId !== 'direct' || task.action !== action || task.status !== 'succeeded' || task.requiresReview) return unavailable();
  const args = task.args, data = task.result?.data;
  if (!isWfdRecord(args) || args.materialId !== materialId || !isWfdRecord(data) || data.kind !== 'conversation-material'
    || data.materialId !== materialId || !isWfdRecord(data.mediaResult)) return unavailable();
  const call = services.database.connection.prepare('SELECT service_task_id,material_id,operation FROM conversation_material_calls WHERE local_task_id=?').get(taskId);
  const link = services.database.connection.prepare('SELECT service_task_id,sha256,file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?').get(materialId);
  if (!call || !link || call.material_id !== materialId || call.operation !== action || call.service_task_id !== link.service_task_id
    || data.serviceTaskId !== link.service_task_id || data.fileRefId !== link.file_ref_id || args.fileRefId !== link.file_ref_id) return unavailable();
  const custody = companion.tasks.get(String(link.service_task_id));
  if (custody.status !== 'succeeded') return unavailable();
  const material = companion.materials.getByTask(String(link.service_task_id));
  if (!material || material.envelope.materialId !== materialId) return unavailable();
  if (material.envelope.sha256 !== link.sha256 || data.originalSha256 !== link.sha256) return unavailable();
  const result = data.mediaResult;
  const expectedSource = { materialId, fileRefId: link.file_ref_id, fileRefVersion: link.file_ref_version, sha256: link.sha256 };
  if (!same(result.source, expectedSource) || !isWfdRecord(result.plugin) || result.plugin.id !== action || result.plugin.version !== '1') return unavailable();
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
  const assertCurrent = () => {
    if (services.tasks.get(taskId).version !== task.version
      || !same(link, services.database.connection.prepare('SELECT service_task_id,sha256,file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?').get(materialId))
      || !same(call, services.database.connection.prepare('SELECT service_task_id,material_id,operation FROM conversation_material_calls WHERE local_task_id=?').get(taskId))) return unavailable();
  };
  return { result, source: expectedSource, artifact, assertCurrent,
    original: { filename: material.envelope.filename, mediaType: material.envelope.mediaType, sha256: link.sha256,
      url: `/api/bd/materials/${encodeURIComponent(materialId)}/original` } };
}

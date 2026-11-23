import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { readArtifactForDownload } from './platform-routes.js';
import type { ApplicationServices } from './services.js';

export type MediaReviewServices = Pick<ApplicationServices, 'database' | 'tasks' | 'files' | 'direct' | 'artifactRoot' | 'options' | 'materials'>;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
export const sameMediaEvidence = (a: unknown, b: unknown) => { try { return canonicalWfdJson(a) === canonicalWfdJson(b); } catch { return false; } };
const same = sameMediaEvidence;
/** Shared read-only provenance and pinned artifacts; no new tasks, permissions, or fallback sources. */
export function readMediaReviewSource(services: MediaReviewServices, materialId: string, taskId: string,
  action: 'material.ocr' | 'material.transcribe', unavailable: () => never) {
  if (!id(materialId) || !id(taskId)) return unavailable();
  const task = services.tasks.get(taskId);
  const directAudio = action === 'material.transcribe' && task.action === 'audio.transcribe';
  if (task.runtimeId !== 'direct' || (!directAudio && task.action !== action) || task.status !== 'succeeded' || task.requiresReview) return unavailable();
  const args = task.args, data = task.result?.data;
  if (!isWfdRecord(args) || !isWfdRecord(data)) return unavailable();
  const companion = services.options.workspaceServices;
  // Personal and custody file ids differ. Only the original material link can cross that boundary.
  const owner = companion ?? services;
  if (!owner.materials || (!companion && !directAudio)) return unavailable();
  const db = services.database.connection;
  if (companion && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_material_calls'").get()) return unavailable();
  const readPersonalLink = () => db.prepare('SELECT service_task_id,sha256,file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?').get(materialId);
  const personalLink = companion ? readPersonalLink() : undefined;
  if (companion && (!personalLink || personalLink.file_ref_id !== args.fileRefId)) return unavailable();
  const material = personalLink ? owner.materials.getByTask(String(personalLink.service_task_id)) : owner.materials.get(materialId);
  if (!material || material.envelope.materialId !== materialId) return unavailable();
  const link = personalLink ?? { service_task_id: material.envelope.taskId, sha256: material.envelope.sha256,
    file_ref_id: material.envelope.fileRefId, file_ref_version: material.envelope.fileRefVersion };
  if (args.fileRefId !== link.file_ref_id || material.envelope.sha256 !== link.sha256
    || material.envelope.taskId !== link.service_task_id) return unavailable();
  const custody = owner.tasks.get(String(link.service_task_id));
  if (custody.status !== 'succeeded') return unavailable();
  const readCall = () => directAudio ? null : db.prepare('SELECT service_task_id,material_id,operation FROM conversation_material_calls WHERE local_task_id=?').get(taskId);
  const call = readCall();
  const fileSource = { fileRefId: link.file_ref_id, fileRefVersion: link.file_ref_version, sha256: link.sha256 };
  const expectedSource = { materialId, ...fileSource };
  const result = directAudio ? data : data.mediaResult;
  if (!isWfdRecord(result)) return unavailable();
  if (directAudio) {
    if (data.backend !== 'whisper.cpp-local' || !same(data.source, fileSource)) return unavailable();
  } else if (!call || call.material_id !== materialId || call.operation !== action || call.service_task_id !== link.service_task_id
    || args.materialId !== materialId || data.kind !== 'conversation-material' || data.materialId !== materialId
    || data.serviceTaskId !== link.service_task_id || data.fileRefId !== link.file_ref_id || data.originalSha256 !== link.sha256
    || !same(result.source, expectedSource) || !isWfdRecord(result.plugin) || result.plugin.id !== action || result.plugin.version !== '1') return unavailable();
  // The original is the already-custodied object, not an arbitrary external path.
  // Reuse the same source gate before and after asynchronous artifact reads.
  const assertSourceCurrent = () => {
    const currentCustody = owner.tasks.get(String(link.service_task_id));
    const currentMaterial = owner.materials!.getByTask(String(link.service_task_id));
    if (currentCustody.status !== 'succeeded' || currentCustody.version !== custody.version
      || !currentMaterial || !same(currentMaterial.envelope, material.envelope)) return unavailable();
    const sourceRef = services.files.verify(String(link.file_ref_id));
    services.direct.assertPublicPath(sourceRef.invocationPath);
    if (sourceRef.kind !== 'file' || sourceRef.version !== link.file_ref_version) return unavailable();
    const original = owner.materials!.readOriginal(materialId);
    if (original.sha256 !== link.sha256 || original.bytes.length !== material.envelope.byteLength
      || wfdSha256(original.bytes) !== link.sha256) return unavailable();
  };
  assertSourceCurrent();
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
      || companion && !same(link, readPersonalLink())
      || !same(call, readCall())) return unavailable();
    assertSourceCurrent();
  };
  return { result, source: expectedSource, artifact, assertCurrent,
    original: { filename: material.envelope.filename, mediaType: material.envelope.mediaType, sha256: link.sha256,
      url: `/api/bd/materials/${encodeURIComponent(materialId)}/original` } };
}

import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { segmentsFromConversionArtifact } from '../../modules/collection/segments/from-conversion.js';
import { OCR_PACKET_SCHEMA, type RetrievalEvidenceResult, type RetrievalIntegrityCheck } from '../../modules/collection/segments/contracts.js';
import { OCR_REVIEW_REF } from '../../modules/collection/segments/from-ocr.js';
import { readArtifactForDownload } from './platform-routes.js';
import type { ApplicationServices } from './services.js';

const MAX_BYTES = 8 * 1024 * 1024;
const unknown = (reason: string): RetrievalIntegrityCheck => ({ status: 'unknown', reason });
const mismatch = (reason: string): RetrievalIntegrityCheck => ({ status: 'mismatch', reason });
const verified = (reason: string): RetrievalIntegrityCheck => ({ status: 'verified', reason });
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
/** Explicit current byte verification; it neither grants fact/history qualification nor modifies cached hits. */
export async function readRetrievalEvidence(services: ApplicationServices, input: unknown, assertReadAccess: () => void = () => {}): Promise<RetrievalEvidenceResult> {
  if (!isWfdRecord(input) || Object.keys(input).sort().join(',') !== 'indexVersion,segmentId'
    || [input.indexVersion, input.segmentId].some(value => typeof value !== 'string' || !/^[\w.:-]{1,200}$/u.test(value)))
    throw new TaskError('RETRIEVAL_EVIDENCE_INPUT', '需要固定索引和片段身份，不接受路径或最新索引。');
  assertReadAccess();
  const segments = services.segments!, materials = services.materials!;
  const generation = services.localData?.assertActive().generation;
  const binding = segments.evidenceBinding(String(input.indexVersion), String(input.segmentId));
  const frozen = canonicalWfdJson(binding);
  const assertCurrent = () => {
    assertReadAccess();
    if (generation !== undefined) services.localData!.assertPrivateAccess(generation);
    if (canonicalWfdJson(segments.evidenceBinding(String(input.indexVersion), String(input.segmentId))) !== frozen)
      throw new TaskError('RETRIEVAL_EVIDENCE_CHANGED', '等待期间固定证据绑定变化，未返回结果。');
  };
  const { segment, document, artifact } = binding;
  let artifactCheck = unknown('registered_artifact_missing'), originalCheck = unknown('registered_source_missing');
  const consistent = document && artifact && document.artifact_ref === segment.source_ref
    && document.artifact_sha256 === artifact.artifact_sha256 && document.origin_sha256 === artifact.material_sha256
    && artifact.declared_source_sha256 === artifact.material_sha256;
  if (document && artifact && !consistent) artifactCheck = mismatch('registered_binding_mismatch');
  if (consistent) {
    let artifactSourceRef: unknown;
    try {
      const pinned = artifact.artifact_type === OCR_PACKET_SCHEMA && OCR_REVIEW_REF.exec(artifact.artifact_ref);
      const size = pinned ? artifact.artifact_bytes : services.files.verify(artifact.artifact_ref).size;
      if (size > MAX_BYTES || artifact.artifact_bytes > MAX_BYTES) artifactCheck = unknown('artifact_byte_budget');
      else {
        const buffer = pinned ? await segments.readPinnedOcrArtifact(segment.document_id, pinned[1]!, pinned[2]!)
          : (await readArtifactForDownload(services, artifact.artifact_ref)).buffer;
        assertCurrent();
        if (buffer.length !== artifact.artifact_bytes || wfdSha256(buffer) !== artifact.artifact_sha256)
          artifactCheck = mismatch('artifact_bytes_mismatch');
        else {
          const envelope = JSON.parse(buffer.toString('utf8'));
          const ocr = artifact.artifact_type === OCR_PACKET_SCHEMA;
          // OCR's personal fileRef is distinct from the companion custody copy.
          artifactSourceRef = ocr ? envelope.source?.materialId : envelope.source?.fileRefId;
          if (ocr !== (envelope.schema === OCR_PACKET_SCHEMA) || ocr && envelope.taskId !== artifact.conversion_run_id
            || envelope.source?.sha256 !== artifact.material_sha256)
            artifactCheck = mismatch('artifact_source_mismatch');
          else {
            // A stored packet file also has native text/evidence references owned by its recognition task.
            if (ocr && !pinned) {
              await segments.readPinnedOcrArtifact(segment.document_id, artifact.conversion_run_id, envelope.packetSha256);
              assertCurrent();
            }
            const rebuilt = segmentsFromConversionArtifact(envelope, { documentId: segment.document_id,
              documentVersion: segment.document_version, artifactRef: segment.source_ref }).segments.find(item => item.segment_id === segment.segment_id);
            artifactCheck = rebuilt && canonicalWfdJson(rebuilt) === canonicalWfdJson(segment)
              ? verified('complete_artifact_and_exact_segment') : mismatch('artifact_segment_mismatch');
          }
        }
      }
    } catch (error) {
      if (['FILE_REF_NOT_FOUND', 'FILE_MISSING', 'ENOENT', 'SEGMENT_OCR_READER_UNAVAILABLE', 'OCR_REVIEW_UNAVAILABLE'].includes(code(error))) artifactCheck = unknown('artifact_unavailable');
      else if (['FILE_CHANGED', 'FILE_UNAVAILABLE', 'SEGMENT_OCR_PACKET_MISMATCH'].includes(code(error))) artifactCheck = mismatch('artifact_identity_changed');
      else throw error;
    }
    assertCurrent();
    try {
      // Logical document versions may be explicit ('v1'); they are not custody envelope schema versions.
      const material = materials.get(segment.document_id).envelope;
      if (artifactCheck.status === 'verified' && artifactSourceRef !== (artifact.artifact_type === OCR_PACKET_SCHEMA ? material.materialId : material.fileRefId)) artifactCheck = mismatch('artifact_source_mismatch');
      if (material.sha256 !== artifact.material_sha256) originalCheck = mismatch('material_identity_mismatch');
      else if (material.byteLength > MAX_BYTES) originalCheck = unknown('source_byte_budget');
      else {
        const original = materials.readOriginal(segment.document_id);
        originalCheck = original.bytes.length === material.byteLength && wfdSha256(original.bytes) === artifact.material_sha256
          ? verified('complete_original_bytes') : mismatch('source_bytes_mismatch');
      }
    } catch (error) {
      if (['MATERIAL_ORIGINAL_CHANGED'].includes(code(error))) originalCheck = mismatch('source_bytes_mismatch');
      else if (['ENOENT', 'MATERIAL_NOT_READY'].includes(code(error))) originalCheck = unknown('source_unavailable');
      else throw error;
    }

  }
  assertCurrent();
  return { schema: 'bd.retrieval-evidence/1', citation: binding.citation,
    cache: verified('complete_segment_text_digest_not_excerpt'), artifact: artifactCheck, original: originalCheck,
    factVerification: 'not_established', historicalQualification: 'not_evaluated',
    limitations: ['current local private-access gate; no per-document ACL', 'byte integrity does not verify source claims'],
    limits: { maxArtifactBytes: MAX_BYTES, maxOriginalBytes: MAX_BYTES } };
}

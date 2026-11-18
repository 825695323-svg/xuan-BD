import type { R1ReadConnection } from '../../../contracts/r1-contracts';
import { request, RequestError } from './api';
import { r1Api } from './r1-api';
import { sameR1ReadConnection } from './r1-read-history';
import { localDataGeneration, localDataRevision, notifyLocalDataRevoked } from './local-data-context';

export interface RecordIdentity { datasetId: string; productId: string; recordId: string; recordVersion: string }
export interface EvidenceMaterial { materialId: string; sha256: string; bytes: number; filename: string; originalUrl: string }
export interface RecordEvidence extends RecordIdentity { snapshotId: string; requestId: string; sha256: string; bytes: number; materials: EvidenceMaterial[]; downloadUnavailable: boolean }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const bytes = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function fail(): never { throw new RequestError('RECORD_EVIDENCE_UNVERIFIED', null, 'RECORD_EVIDENCE_UNVERIFIED'); }
export function recordIdentity(datasetId: string, productId: string, snapshotId: string, ref: unknown): RecordIdentity | null {
  if (!object(ref) || ref.snapshot_id !== snapshotId || ref.product_id !== productId
    || ![datasetId, productId, ref.logical_key, ref.revision_id].every(id)) return null;
  return { datasetId, productId, recordId: String(ref.logical_key), recordVersion: String(ref.revision_id) };
}
export function projectRecordEvidence(raw: unknown, identity: RecordIdentity): RecordEvidence {
  if (!object(raw) || raw.schema !== 'bd.record-evidence/1' || Object.entries(identity).some(([key, value]) => raw[key] !== value)
    || !id(raw.snapshotId) || !id(raw.requestId) || raw.sourceBytesStatus !== 'verified'
    || raw.qualification !== 'fixed_record_source_association' || raw.factVerification !== 'not_established'
    || raw.processingRefsStatus !== 'frozen_reference_not_revalidated' || raw.evidenceRefsStatus !== 'frozen_reference_not_revalidated'
    || !object(raw.source) || !sha(raw.source.sha256) || !bytes(raw.source.bytes)
    || !Array.isArray(raw.materials) || raw.materials.length > 1 || !Array.isArray(raw.gaps)) fail();
  const source = raw.source as Record<string, unknown>;
  const materials = (raw.materials as unknown[]).map(item => {
    if (!object(item) || !id(item.materialId) || !id(item.filename) || item.sha256 !== source.sha256 || item.bytes !== source.bytes
      || item.originalUrl !== `/api/bd/materials/${encodeURIComponent(item.materialId)}/original`) fail();
    return { materialId: item.materialId as string, filename: item.filename as string, sha256: item.sha256 as string,
      bytes: item.bytes as number, originalUrl: item.originalUrl as string };
  });
  if (materials.length > 0 && (raw.gaps as unknown[]).length > 0) fail();
  if (!(raw.gaps as unknown[]).every(gap => object(gap) && gap.code === 'DOWNLOAD_MATERIAL_LINK_UNAVAILABLE')
    || materials.length === 0 && !(raw.gaps as unknown[]).some(gap => object(gap) && gap.code === 'DOWNLOAD_MATERIAL_LINK_UNAVAILABLE')) fail();
  return { ...identity, snapshotId: raw.snapshotId as string, requestId: raw.requestId as string,
    sha256: source.sha256 as string, bytes: source.bytes as number, materials, downloadUnavailable: materials.length === 0 };
}
async function bound<T>(connection: R1ReadConnection, work: () => Promise<T>): Promise<T> {
  const generation = localDataGeneration(), revision = localDataRevision();
  if (generation === null) fail();
  const before = await r1Api.capabilities();
  if (!before.connection || !sameR1ReadConnection(before.connection, connection)) fail();
  const value = await work(), after = await r1Api.capabilities();
  if (!after.connection || JSON.stringify(before.connection) !== JSON.stringify(after.connection)
    || generation !== localDataGeneration() || revision !== localDataRevision()) fail();
  return value;
}
export const recordEvidenceApi = {
  read: (identity: RecordIdentity, connection: R1ReadConnection) => bound(connection, async () =>
    projectRecordEvidence(await request('/api/bd/r1/records/evidence', 'POST', identity, { requireLocalData: true }), identity)),
  download: (material: EvidenceMaterial, connection: R1ReadConnection) => bound(connection, async () => {
    if (material.bytes > 25 * 1024 * 1024 || material.originalUrl !== `/api/bd/materials/${encodeURIComponent(material.materialId)}/original`) fail();
    const response = await fetch(material.originalUrl, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'x-local-data-generation': String(localDataGeneration()) }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (object(body) && typeof body.code === 'string' && (body.code.startsWith('LOCAL_DATA_') || body.code === 'STALE_LOCAL_DATA_GENERATION')) notifyLocalDataRevoked(body.code);
      fail();
    }
    const reader = response.body?.getReader(); if (!reader) fail();
    const chunks: Uint8Array<ArrayBuffer>[] = []; let count = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength;
      if (count > material.bytes) fail(); chunks.push(new Uint8Array(next.value)); } }
    finally { await reader.cancel(); }
    if (count !== material.bytes) fail();
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== material.sha256) fail();
    return blob;
  }),
};

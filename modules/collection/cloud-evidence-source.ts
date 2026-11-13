import { createHash } from 'node:crypto';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { digestOperationArgs, PermissionError } from '../../platform/security/permissions.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { MaterialService } from './materials/service.js';
import type { ProcessingPlanService } from './processing-plan.js';
import { findArtifact, listArtifacts } from './segments/artifacts.js';
import { CLOUD_MAX_BYTES } from '../../plugins/storage/baidu-drive.js';

export type CloudEvidenceSource = { kind: 'conversion'; artifactRecordId: string }
  | { kind: 'processing'; planId: string; outputId: string };
export interface CloudEvidenceBinding {
  source: CloudEvidenceSource;
  original: { materialId: string; version: number; sha256: string };
  filename: string; sha256: string; byteLength: number; lineage: JsonValue;
  file?: { id: string; version: number };
}
interface Options { database: CoreDatabase; materials: MaterialService; files: FileReferenceService;
  processing?(): ProcessingPlanService | undefined }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
function fail(message: string): never { throw new TaskError('CLOUD_EVIDENCE_SOURCE_MISMATCH', message); }

/** 只从登记账本和受信结果读取器解析；请求不能指定路径、字节或自报谱系。 */
export class CloudEvidenceReader {
  constructor(private readonly options: Options) {}
  resolve(materialId: string, source: CloudEvidenceSource): { binding: CloudEvidenceBinding; bytes?: Buffer } {
    const envelope = this.options.materials.get(materialId).envelope;
    const original = { materialId, version: envelope.version, sha256: envelope.sha256 };
    if (source.kind === 'conversion') {
      const record = findArtifact(this.options.database, source.artifactRecordId);
      if (!record || record.material_id !== materialId || record.material_version !== String(envelope.version)
        || record.material_sha256 !== envelope.sha256) fail('解析产物不属于所选原件及其冻结版本。');
      const reference = this.options.files.verify(record.artifact_ref);
      if (reference.source !== 'generated' || reference.status !== 'available' || reference.size !== record.artifact_bytes) fail('已登记解析产物当前版本不可核对。');
      return { binding: { source, original, filename: reference.displayName, sha256: record.artifact_sha256,
        byteLength: record.artifact_bytes, file: { id: reference.id, version: reference.version }, lineage: json(record) } };
    }
    if (source.kind !== 'processing') fail('加工证据只接受当前登记的解析或处理产物。');
    const processing = this.options.processing?.();
    if (!processing) fail('本实例未装配加工产物读取器。');
    const output = processing.candidateOutput(source.planId, source.outputId);
    if (!output.materials.some(item => item.materialId === materialId && item.sha256 === envelope.sha256)) fail('加工产物没有所选原件的已核对谱系。');
    const artifact = processing.outputArtifact(source.planId, source.outputId);
    const lineage = json(output), filename = `${source.planId}-${source.outputId}.processing-evidence.json`;
    const bytes = Buffer.from(JSON.stringify({ schema: 'bd.processing-evidence/1', lineage,
      artifact: { ref: artifact.ref, encoding: 'base64', bytes: artifact.bytes.toString('base64') } }));
    if (bytes.length > CLOUD_MAX_BYTES) throw new TaskError('CLOUD_EVIDENCE_TOO_LARGE', '加工证据超过本次归档字节预算。');
    return { binding: { source, original, filename, sha256: sha(bytes), byteLength: bytes.length, lineage }, bytes };
  }
  async read(binding: CloudEvidenceBinding, context: TaskExecutionContext): Promise<Buffer> {
    const current = this.resolve(binding.original.materialId, binding.source);
    if (digestOperationArgs(current.binding) !== digestOperationArgs(binding)) fail('加工证据的原件、产物版本或谱系已变化，不能继续原归档请求。');
    let bytes = current.bytes;
    if (binding.file) {
      const reference = this.options.files.verify(binding.file.id);
      const operation = { operationId: 'cloud.custody.evidence.read', operationVersion: 1,
        argsDigest: digestOperationArgs(binding), targets: [{ kind: 'file' as const, path: reference.invocationPath }] };
      const capabilities = [{ action: 'read' as const, target: { kind: 'file' as const, path: reference.invocationPath } }];
      let approvalId: string | undefined;
      try { context.assertAuthorized(operation, capabilities); }
      catch (error) {
        if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
        approvalId = (await context.requestApproval(operation, capabilities)).approvalId ?? undefined;
      }
      bytes = await this.options.files.readBytes(binding.file.id, { operation: context.operationScope(operation), approvalId, maxBytes: CLOUD_MAX_BYTES });
    }
    context.signal.throwIfAborted();
    if (!bytes || bytes.length !== binding.byteLength || sha(bytes) !== binding.sha256) fail('加工证据实际字节与冻结摘要或长度不符。');
    return bytes;
  }
  list(materialId: string) {
    const material = this.options.materials.get(materialId).envelope;
    const sources: CloudEvidenceSource[] = listArtifacts(this.options.database, { materialId, materialVersion: String(material.version), limit: 100 })
      .map(row => ({ kind: 'conversion', artifactRecordId: row.artifact_record_id }));
    const db = this.options.database.connection;
    if (this.options.processing?.()) {
      const rows = db.prepare(`SELECT DISTINCT p.plan_id FROM processing_plans p JOIN processing_plan_outputs o ON o.plan_id=p.plan_id
        WHERE o.state='structured' AND EXISTS(SELECT 1 FROM json_each(p.material_manifest_json) WHERE json_extract(value,'$.materialId')=?) ORDER BY p.created_at DESC LIMIT 100`).all(materialId);
      for (const row of rows) for (const output of this.options.processing!()!.get(String(row.plan_id)).outputs) {
        if (output.state === 'structured' && output.materialIds.includes(materialId)) sources.push({ kind: 'processing', planId: String(row.plan_id), outputId: output.outputId });
      }
    }
    return sources.map(source => {
      try { return { available: true, ...this.resolve(materialId, source).binding, reason: null }; }
      catch (error) { return { source, available: false, reason: error instanceof Error ? error.message : '无法核对产物。' }; }
    });
  }
}

export function normalizeEvidenceSource(value: unknown): CloudEvidenceSource | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('加工证据必须使用登记的来源引用。');
  const v = value as Record<string, unknown>;
  const keys = v.kind === 'conversion' ? ['kind', 'artifactRecordId'] : v.kind === 'processing' ? ['kind', 'planId', 'outputId'] : [];
  if (!keys.length || Object.keys(v).sort().join() !== [...keys].sort().join()
    || keys.filter(key => key !== 'kind').some(key => typeof v[key] !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(String(v[key])))) fail('加工证据引用的类型或身份字段无效。');
  return { ...v } as CloudEvidenceSource;
}

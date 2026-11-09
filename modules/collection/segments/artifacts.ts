/**
 * 4.3 证据账本：材料 ↔ 转换产物的一对多登记。
 *
 * 为什么单独一张表：一份材料会派生出正文、结构化、页图以及不同解析器版本的多个产物，
 * 关系必须保留历史，不能只在材料主表挂一个 `latestArtifactRef`。原件摘要与产物摘要
 * 分别保存；校验的是“产物自称的来源身份与原件一致”，不是“转换后字节哈希等于原 PDF 哈希”。
 */
import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../../platform/state/database.js';
import type { ArtifactProcessingStatus, ConversionArtifactRecord } from './contracts.js';

export const ARTIFACT_LEDGER_SCHEMA = 'bd.conversion-artifact/1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversion_artifacts (
  artifact_record_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  material_version TEXT NOT NULL,
  material_sha256 TEXT NOT NULL,
  conversion_run_id TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_bytes INTEGER NOT NULL,
  parser_version TEXT,
  declared_source_sha256 TEXT,
  processing_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(material_id, material_version, artifact_ref)
);
CREATE INDEX IF NOT EXISTS conversion_artifacts_material ON conversion_artifacts(material_id, material_version, created_at);
`;

export function ensureArtifactLedger(db: CoreDatabase): void {
  db.migrate('bd.conversion-artifacts', 1, SCHEMA_SQL);
}

export type NewArtifactRecord = Omit<ConversionArtifactRecord, 'artifact_record_id' | 'created_at' | 'processing_status'>
  & { processing_status?: ArtifactProcessingStatus };

/** 幂等登记：同一 (材料, 版本, 产物引用) 只保留一条，重复登记返回原记录。 */
export function recordArtifact(db: CoreDatabase, input: NewArtifactRecord): ConversionArtifactRecord {
  ensureArtifactLedger(db);
  const existing = findArtifactByRef(db, input.material_id, input.material_version, input.artifact_ref);
  if (existing) {
    const same = existing.artifact_type === input.artifact_type && existing.artifact_sha256 === input.artifact_sha256
      && existing.material_sha256 === input.material_sha256 && existing.conversion_run_id === input.conversion_run_id;
    if (!same) throw new Error(`产物登记冲突：${input.material_id}@${input.material_version} 的 ${input.artifact_ref} 已存在且内容不同。`);
    return existing;
  }
  const record: ConversionArtifactRecord = { ...input, artifact_record_id: `art_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    processing_status: input.processing_status ?? 'registered', created_at: Date.now() };
  db.connection.prepare(`INSERT INTO conversion_artifacts (artifact_record_id, material_id, material_version, material_sha256,
    conversion_run_id, artifact_ref, artifact_type, artifact_sha256, artifact_bytes, parser_version, declared_source_sha256,
    processing_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.artifact_record_id, record.material_id,
    record.material_version, record.material_sha256, record.conversion_run_id, record.artifact_ref, record.artifact_type,
    record.artifact_sha256, record.artifact_bytes, record.parser_version, record.declared_source_sha256,
    record.processing_status, record.created_at);
  return record;
}

export function findArtifact(db: CoreDatabase, recordId: string): ConversionArtifactRecord | null {
  ensureArtifactLedger(db);
  const row = db.connection.prepare('SELECT * FROM conversion_artifacts WHERE artifact_record_id=?').get(recordId);
  return row ? toRecord(row) : null;
}

export function findArtifactByRef(db: CoreDatabase, materialId: string, materialVersion: string,
  artifactRef: string): ConversionArtifactRecord | null {
  ensureArtifactLedger(db);
  const row = db.connection.prepare(`SELECT * FROM conversion_artifacts
    WHERE material_id=? AND material_version=? AND artifact_ref=?`).get(materialId, materialVersion, artifactRef);
  return row ? toRecord(row) : null;
}

export function listArtifacts(db: CoreDatabase, input: { materialId?: string; materialVersion?: string;
  limit?: number } = {}): ConversionArtifactRecord[] {
  ensureArtifactLedger(db);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = input.materialId === undefined
    ? db.connection.prepare('SELECT * FROM conversion_artifacts ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
    : db.connection.prepare(`SELECT * FROM conversion_artifacts WHERE material_id=? AND material_version=?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(input.materialId, input.materialVersion ?? '1', limit);
  return (rows as unknown as Record<string, unknown>[]).map(toRecord);
}

export function setArtifactStatus(db: CoreDatabase, recordId: string, status: ArtifactProcessingStatus): void {
  ensureArtifactLedger(db);
  db.connection.prepare('UPDATE conversion_artifacts SET processing_status=? WHERE artifact_record_id=?').run(status, recordId);
}

/** 产物发现：给片段化与人工核对用的候选清单，按“可进索引”优先排序。 */
export function discoverArtifacts(db: CoreDatabase, materialId: string, materialVersion: string,
  segmentable: readonly string[]): ConversionArtifactRecord[] {
  return listArtifacts(db, { materialId, materialVersion })
    .sort((left, right) => Number(segmentable.includes(right.artifact_type)) - Number(segmentable.includes(left.artifact_type)));
}

function toRecord(row: unknown): ConversionArtifactRecord {
  const value = row as Record<string, unknown>;
  return { artifact_record_id: String(value.artifact_record_id), material_id: String(value.material_id),
    material_version: String(value.material_version), material_sha256: String(value.material_sha256),
    conversion_run_id: String(value.conversion_run_id), artifact_ref: String(value.artifact_ref),
    artifact_type: String(value.artifact_type), artifact_sha256: String(value.artifact_sha256),
    artifact_bytes: Number(value.artifact_bytes),
    parser_version: value.parser_version === null ? null : String(value.parser_version),
    declared_source_sha256: value.declared_source_sha256 === null ? null : String(value.declared_source_sha256),
    processing_status: String(value.processing_status) as ArtifactProcessingStatus,
    created_at: Number(value.created_at) };
}

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const MATERIAL_RECORDS_SCHEMA = `CREATE TABLE material_object_records (
 material_id TEXT PRIMARY KEY REFERENCES material_inputs(material_id),
 envelope_json TEXT NOT NULL, envelope_digest TEXT NOT NULL, preview_json TEXT NOT NULL, preview_digest TEXT NOT NULL,
 content_sha256 TEXT NOT NULL REFERENCES r1_original_contents(sha256)
);`;
const SHARED_MATERIAL_SELECT = `SELECT m.material_id,m.envelope_json,m.envelope_digest,m.preview_json,m.preview_digest,c.original_bytes
 FROM material_object_records m LEFT JOIN r1_original_contents c ON c.sha256=m.content_sha256`;
const MATERIAL_VIEW_SCHEMA = `CREATE VIEW material_objects AS ${SHARED_MATERIAL_SELECT};`;
const MANAGED_MATERIAL_VIEW = `CREATE VIEW material_objects AS ${SHARED_MATERIAL_SELECT}
 UNION ALL SELECT material_id,envelope_json,envelope_digest,preview_json,preview_digest,NULL
 FROM managed_material_object_records;`;
const MATERIAL_VIEW_TRIGGERS = `
CREATE TRIGGER material_objects_insert INSTEAD OF INSERT ON material_objects BEGIN
 SELECT CASE WHEN typeof(NEW.original_bytes)<>'blob'
   OR length(NEW.original_bytes) IS NOT json_extract(NEW.envelope_json,'$.byteLength')
   OR length(json_extract(NEW.envelope_json,'$.sha256')) IS NOT 64
   OR json_extract(NEW.envelope_json,'$.materialId') IS NOT NEW.material_id
   THEN RAISE(ABORT,'MATERIAL_ORIGINAL_CHANGED') END;
 INSERT INTO r1_original_contents(sha256,original_bytes)
   VALUES(json_extract(NEW.envelope_json,'$.sha256'),NEW.original_bytes) ON CONFLICT(sha256) DO NOTHING;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM r1_original_contents
   WHERE sha256=json_extract(NEW.envelope_json,'$.sha256') AND original_bytes=NEW.original_bytes)
   THEN RAISE(ABORT,'MATERIAL_ORIGINAL_CHANGED') END;
 INSERT INTO material_object_records VALUES(NEW.material_id,NEW.envelope_json,NEW.envelope_digest,
   NEW.preview_json,NEW.preview_digest,json_extract(NEW.envelope_json,'$.sha256'));
END;
-- Existing maintenance callers can still expose storage corruption through the old column.
-- Normal intake is insert-only; all consumers verify the frozen digest before using bytes.
CREATE TRIGGER material_objects_update_bytes INSTEAD OF UPDATE OF original_bytes ON material_objects BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM material_object_records WHERE material_id=OLD.material_id)
   THEN RAISE(ABORT,'MATERIAL_ORIGINAL_CHANGED') END;
 UPDATE r1_original_contents SET original_bytes=NEW.original_bytes
   WHERE sha256=(SELECT content_sha256 FROM material_object_records WHERE material_id=OLD.material_id);
END;`;
const MATERIAL_SHARING_VERSION = `INSERT INTO schema_versions(module,version) VALUES('material-original-sharing',1);`;
// Reuse R1's existing content table. Acquisitions and material envelopes retain separate IDs.
export const SHARED_MATERIAL_OBJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS r1_original_contents (sha256 TEXT PRIMARY KEY, original_bytes BLOB NOT NULL);
${MATERIAL_RECORDS_SCHEMA}
${MATERIAL_VIEW_SCHEMA}
${MATERIAL_VIEW_TRIGGERS}
${MATERIAL_SHARING_VERSION}`;

export const MANAGED_MATERIAL_RECORDS_SCHEMA = `
CREATE TABLE managed_material_object_records (
 material_id TEXT PRIMARY KEY REFERENCES material_inputs(material_id),
 envelope_json TEXT NOT NULL, envelope_digest TEXT NOT NULL, preview_json TEXT NOT NULL, preview_digest TEXT NOT NULL
);`;
export const MANAGED_MATERIAL_VIEW_MIGRATION = `DROP VIEW material_objects;
${MANAGED_MATERIAL_VIEW}
${MATERIAL_VIEW_TRIGGERS}`;

export interface OriginalSharingPlan {
  mode: 'legacy' | 'shared'; materialCount: number; materialLogicalBytes: number;
  existingContentCount: number; existingContentBytes: number; projectedContentCount: number;
  projectedContentBytes: number; currentPayloadBytes: number; reclaimablePayloadBytes: number;
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never { throw new Error('ORIGINAL_SHARING: ' + message); }
function objectType(db: DatabaseSync, name: string): string | undefined {
  return db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name)?.type as string | undefined;
}

/** Read-only, exact-byte qualification. It never initializes an absent module or discards a content object. */
export function planMaterialOriginalSharing(db: DatabaseSync): OriginalSharingPlan {
  const type = objectType(db, 'material_objects');
  if (!['table', 'view'].includes(String(type))) fail('材料表尚未初始化。');
  if (Number(db.prepare("SELECT version FROM schema_versions WHERE module='materials'").get()?.version) !== 1) fail('材料模块版本不受此入口支持。');
  const mode = type === 'table' ? 'legacy' : 'shared';
  if (mode === 'shared' && (Number(db.prepare("SELECT version FROM schema_versions WHERE module='material-original-sharing'").get()?.version) !== 1
    || objectType(db, 'material_object_records') !== 'table')) fail('共享材料格式或版本无法核对。');
  if (objectType(db, 'managed_material_object_records') === 'table'
    && db.prepare('SELECT 1 FROM managed_material_object_records LIMIT 1').get()) {
    fail('材料包含受管外置原件；旧 BLOB 共享维护入口不处理此格式。');
  }
  const hasContents = objectType(db, 'r1_original_contents') === 'table';
  if (mode === 'legacy') {
    if (![2,3].includes(Number(db.prepare("SELECT version FROM schema_versions WHERE module='r1-structured-handoff'").get()?.version)) || !hasContents) {
      fail('先由兼容程序完成既有 R1 v2 初始化；本入口不代替旧组件初始化或升级。');
    }
    const custom = db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='material_objects' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    if (custom.length) fail('材料表有额外索引或触发器，须先核对其语义。');
    for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
      const quoted = '"' + String(table.name).replaceAll('"', '""') + '"';
      if (db.prepare(`PRAGMA foreign_key_list(${quoted})`).all().some(row => row.table === 'material_objects')) {
        fail('其他表以外键引用材料旧物理表，须先核对其约束。');
      }
    }
  }
  const contents = new Map<string, number>(); let existingContentBytes = 0;
  if (hasContents) for (const content of db.prepare('SELECT sha256,original_bytes FROM r1_original_contents').iterate()) {
    if (!(content.original_bytes instanceof Uint8Array) || sha(content.original_bytes) !== content.sha256) fail('已有共享内容摘要不符，未覆盖或删除。');
    contents.set(String(content.sha256), content.original_bytes.byteLength); existingContentBytes += content.original_bytes.byteLength;
  }
  const existingContentCount = contents.size, originals = new Map<string, string>();
  let materialCount = 0, materialLogicalBytes = 0, projectedContentBytes = existingContentBytes;
  for (const row of db.prepare('SELECT * FROM material_objects').iterate()) {
    const envelopeText = String(row.envelope_json), previewText = String(row.preview_json);
    if (sha(envelopeText) !== row.envelope_digest || sha(previewText) !== row.preview_digest) fail('材料元数据或预览摘要不符。');
    let envelope: { materialId?: unknown; sha256?: unknown; byteLength?: unknown };
    try { envelope = JSON.parse(envelopeText); JSON.parse(previewText); } catch { return fail('材料元数据或预览不是有效 JSON。'); }
    if (!envelope || envelope.materialId !== row.material_id || typeof envelope.sha256 !== 'string'
      || !(row.original_bytes instanceof Uint8Array) || row.original_bytes.byteLength !== envelope.byteLength
      || sha(row.original_bytes) !== envelope.sha256) fail('材料原件与冻结身份、大小或摘要不符。');
    if (mode === 'shared') {
      const binding = db.prepare('SELECT content_sha256 FROM material_object_records WHERE material_id=?').get(String(row.material_id));
      if (binding?.content_sha256 !== envelope.sha256) fail('材料内容引用与冻结摘要不符。');
    }
    const existing = hasContents ? db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(envelope.sha256) : undefined;
    if (existing && (!(existing.original_bytes instanceof Uint8Array) || !Buffer.from(existing.original_bytes).equals(row.original_bytes))) fail('相同摘要对应不同字节。');
    const previous = originals.get(envelope.sha256);
    if (previous) {
      const bytes = db.prepare('SELECT original_bytes FROM material_objects WHERE material_id=?').get(previous)?.original_bytes;
      if (!(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(row.original_bytes)) fail('材料相同摘要对应不同字节。');
    } else originals.set(envelope.sha256, String(row.material_id));
    if (!contents.has(envelope.sha256)) { contents.set(envelope.sha256, row.original_bytes.byteLength); projectedContentBytes += row.original_bytes.byteLength; }
    materialCount++; materialLogicalBytes += row.original_bytes.byteLength;
  }
  const currentPayloadBytes = existingContentBytes + (mode === 'legacy' ? materialLogicalBytes : 0);
  return { mode, materialCount, materialLogicalBytes, existingContentCount, existingContentBytes,
    projectedContentCount: contents.size, projectedContentBytes, currentPayloadBytes,
    reclaimablePayloadBytes: currentPayloadBytes - projectedContentBytes };
}

/** Explicit atomic conversion of an existing v1 material table; retry after interruption uses the same identities. */
export function migrateMaterialOriginalSharing(db: DatabaseSync): { applied: boolean; before: OriginalSharingPlan; after: OriginalSharingPlan } {
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) fail('迁移连接必须启用外键。');
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = planMaterialOriginalSharing(db);
    if (before.mode === 'shared') { db.exec('COMMIT'); return { applied: false, before, after: before }; }
    // Copy into the shared table first; all source records and metadata stay intact until exact readback passes.
    for (const row of db.prepare('SELECT material_id,envelope_json,original_bytes FROM material_objects').iterate()) {
      const envelope = JSON.parse(String(row.envelope_json)) as { sha256: string };
      db.prepare('INSERT INTO r1_original_contents VALUES(?,?) ON CONFLICT(sha256) DO NOTHING').run(envelope.sha256, row.original_bytes);
      const readback = db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(envelope.sha256)?.original_bytes;
      if (!(readback instanceof Uint8Array) || !Buffer.from(readback).equals(row.original_bytes as Uint8Array)) fail('共享内容写入读回与原件不同。');
    }
    // Preserve the six-column SQL interface used by already-running material services.
    db.exec(`${MATERIAL_RECORDS_SCHEMA}
      INSERT INTO material_object_records SELECT material_id,envelope_json,envelope_digest,preview_json,preview_digest,
        json_extract(envelope_json,'$.sha256') FROM material_objects;`);
    const mismatches = db.prepare(`SELECT count(*) n FROM material_objects o LEFT JOIN material_object_records m USING(material_id)
      LEFT JOIN r1_original_contents c ON c.sha256=m.content_sha256
      WHERE m.material_id IS NULL OR o.envelope_json<>m.envelope_json OR o.envelope_digest<>m.envelope_digest
        OR o.preview_json<>m.preview_json OR o.preview_digest<>m.preview_digest
        OR c.original_bytes IS NULL OR o.original_bytes<>c.original_bytes`).get();
    if (Number(mismatches?.n) !== 0) fail('原件或元数据逐项读回不符。');
    db.exec('DROP TABLE material_objects');
    db.exec((objectType(db, 'managed_material_object_records') === 'table' ? MANAGED_MATERIAL_VIEW : MATERIAL_VIEW_SCHEMA)
      + MATERIAL_VIEW_TRIGGERS + MATERIAL_SHARING_VERSION);
    const after = planMaterialOriginalSharing(db);
    if (after.materialCount !== before.materialCount || after.materialLogicalBytes !== before.materialLogicalBytes
      || after.existingContentBytes !== before.projectedContentBytes || db.prepare('PRAGMA foreign_key_check').all().length) fail('迁移后的数量、字节或外键核对不符。');
    db.exec('COMMIT'); return { applied: true, before, after };
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } throw error; }
}

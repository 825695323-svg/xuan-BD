/**
 * 片段存储与检索：片段行不可重建（证据侧），索引版本可核验后重建。
 * 索引与片段同库（node:sqlite），不引入外部检索服务。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DocSegment, DocumentTimeRecord, RetrievalExclusion, RetrievalHistoryMode, SearchHit, SegmentTable,
  TimeDimension, TimeDimensionState, TimePrecision } from './contracts.js';
import { NOT_APPLICABLE_TIME, SEGMENT_TOKENIZER, UNKNOWN_TIME } from './contracts.js';
import { ftsQuery, indexTokens } from './tokenize.js';

export const SEGMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS doc_segments (
  segment_id TEXT PRIMARY KEY,
  segment_seq INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('paragraph','table')),
  page_number INTEGER NOT NULL,
  page_label TEXT,
  section_path_json TEXT NOT NULL,
  bbox_json TEXT NOT NULL,
  table_json TEXT,
  source_ref TEXT NOT NULL,
  text TEXT NOT NULL,
  text_digest TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  issues_json TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS doc_segments_ordinal ON doc_segments(document_id, document_version, parser_version, ordinal);
CREATE TABLE IF NOT EXISTS doc_index_versions (
  index_version TEXT PRIMARY KEY,
  tokenizer TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  note TEXT,
  segment_cutoff INTEGER
);
CREATE TABLE IF NOT EXISTS doc_index_members (
  index_version TEXT NOT NULL REFERENCES doc_index_versions(index_version),
  segment_id TEXT NOT NULL REFERENCES doc_segments(segment_id),
  PRIMARY KEY(index_version, segment_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_segments_fts USING fts5(
  tokens,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS doc_document_versions (
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL DEFAULT '',
  origin_sha256 TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  event_time INTEGER,
  event_time_state TEXT NOT NULL DEFAULT 'unknown',
  event_time_precision TEXT,
  disclosed_at INTEGER,
  disclosed_at_state TEXT NOT NULL DEFAULT 'unknown',
  disclosed_at_precision TEXT,
  parsed_at INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  issues_json TEXT NOT NULL,
  PRIMARY KEY(document_id, document_version, parser_version)
);
CREATE TABLE IF NOT EXISTS doc_segment_storage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  schema_version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  content_digest TEXT NOT NULL
);
`;

/** 同一库在旧版本下建过表时补列；只加列，不改已有行的事实。 */
const DOCUMENT_TIME_UPGRADES: readonly [string, string][] = [
  ['artifact_sha256', `ALTER TABLE doc_document_versions ADD COLUMN artifact_sha256 TEXT NOT NULL DEFAULT ''`],
  ['event_time_state', `ALTER TABLE doc_document_versions ADD COLUMN event_time_state TEXT NOT NULL DEFAULT 'unknown'`],
  ['event_time_precision', `ALTER TABLE doc_document_versions ADD COLUMN event_time_precision TEXT`],
  ['disclosed_at_state', `ALTER TABLE doc_document_versions ADD COLUMN disclosed_at_state TEXT NOT NULL DEFAULT 'unknown'`],
  ['disclosed_at_precision', `ALTER TABLE doc_document_versions ADD COLUMN disclosed_at_precision TEXT`],
];

const STORAGE_VERSION = 1;
const EMPTY_DIGEST = createHash('sha256').update('bd.segment-prefix/1').digest('hex');
interface SegmentState { last_seq: number; segment_count: number; document_count: number; content_digest: string }

let savepointSequence = 0;
function segmentTransaction<T>(db: DatabaseSync, work: () => T): T {
  const savepoint = db.isTransaction ? `bd_segments_${++savepointSequence}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    } catch { /* 提交失败可能已结束事务。 */ }
    throw error;
  }
}

function nextDigest(previous: string, segmentId: string): string {
  return createHash('sha256').update(previous).update('\0').update(segmentId).digest('hex');
}

function storageVersion(db: DatabaseSync): number | null {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='doc_segment_storage' AND type='table'").get()) return null;
  const row = db.prepare('SELECT schema_version FROM doc_segment_storage WHERE id=1').get();
  return row ? Number(row.schema_version) : null;
}

/**
 * 旧库只压缩可证明等价的索引表示，片段、文档时间和索引身份不变。
 * 稳定序号不依赖 SQLite 隐含 rowid（VACUUM 可能改变它）；全量版本只保存序号上界。
 * 升级、FTS 切换与状态头在同一写事务中，失败或进程中断后仍为完整旧格式。
 */
export function ensureSegmentSchema(db: DatabaseSync): void {
  const version = storageVersion(db);
  if (version === STORAGE_VERSION) return;
  if (version !== null && version > STORAGE_VERSION) throw new Error('片段库格式比当前程序更新，不能降级读取。');
  segmentTransaction(db, () => {
    // 另一连接可能在等待写锁期间已完成升级。
    const lockedVersion = storageVersion(db);
    if (lockedVersion === STORAGE_VERSION) return;
    if (lockedVersion !== null && lockedVersion > STORAGE_VERSION) throw new Error('片段库格式比当前程序更新，不能降级读取。');
    const oldFts = db.prepare("SELECT sql FROM sqlite_schema WHERE name='doc_segments_fts'").get() as { sql?: string } | undefined;
    db.exec(SEGMENT_SCHEMA_SQL);
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(row => row.name));
    const segmentColumns = columns('doc_segments');
    if (!segmentColumns.has('segment_seq')) {
      db.exec('ALTER TABLE doc_segments ADD COLUMN segment_seq INTEGER');
      db.exec('UPDATE doc_segments SET segment_seq=rowid');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS doc_segments_sequence ON doc_segments(segment_seq)');
    if (!columns('doc_index_versions').has('segment_cutoff')) db.exec('ALTER TABLE doc_index_versions ADD COLUMN segment_cutoff INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS doc_index_versions_cutoff ON doc_index_versions(segment_cutoff,tokenizer,built_at)');
    const timeColumns = columns('doc_document_versions');
    for (const [name, sql] of DOCUMENT_TIME_UPGRADES) if (!timeColumns.has(name)) db.exec(sql);

    const oldContent = oldFts && !/contentless_delete\s*=\s*1/iu.test(oldFts.sql ?? '');
    if (oldContent) {
      db.exec("INSERT INTO doc_segments_fts(doc_segments_fts,rank) VALUES('integrity-check',1)");
      const count = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT segment_id) AS distinct_n FROM doc_segments_fts').get()!;
      const segmentCount = db.prepare('SELECT COUNT(*) AS n FROM doc_segments').get()!;
      if (count.n !== segmentCount.n || count.distinct_n !== count.n) throw new Error('旧全文索引缺项或重复；未压缩，须先核对原索引。');
      for (const row of db.prepare(`SELECT f.segment_id, f.tokens, s.text FROM doc_segments_fts f
        LEFT JOIN doc_segments s ON s.segment_id=f.segment_id`).iterate()) {
        if (typeof row.text !== 'string' || row.tokens !== indexTokens(row.text))
          throw new Error(`旧全文索引与片段不一致：${row.segment_id}；未压缩。`);
      }
      db.exec(`CREATE VIRTUAL TABLE doc_segments_fts_next USING fts5(tokens, content='', contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2')`);
    }
    const insertFts = oldContent ? db.prepare('INSERT INTO doc_segments_fts_next(rowid,tokens) VALUES (?,?)') : null;
    let lastSeq = 0, segmentCount = 0, digest = EMPTY_DIGEST;
    const documents = new Set<string>();
    for (const row of db.prepare('SELECT segment_id,segment_seq,document_id,text FROM doc_segments ORDER BY segment_seq').iterate()) {
      const seq = Number(row.segment_seq);
      if (!Number.isSafeInteger(seq) || seq <= lastSeq) throw new Error('片段稳定序号无效；未压缩。');
      lastSeq = seq; segmentCount++; documents.add(String(row.document_id));
      digest = nextDigest(digest, String(row.segment_id));
      insertFts?.run(seq, indexTokens(String(row.text)));
    }
    if (!oldFts && segmentCount > 0) throw new Error('已有片段缺少原全文索引；未自动重建。');
    if (oldContent) {
      db.exec('DROP TABLE doc_segments_fts; ALTER TABLE doc_segments_fts_next RENAME TO doc_segments_fts');
    }
    const versions = db.prepare(`SELECT v.index_version,v.segment_count,v.document_count,
      COUNT(m.segment_id) AS members,COUNT(s.segment_id) AS found,COUNT(DISTINCT s.document_id) AS documents,
      MAX(s.segment_seq) AS cutoff FROM doc_index_versions v
      LEFT JOIN doc_index_members m ON m.index_version=v.index_version
      LEFT JOIN doc_segments s ON s.segment_id=m.segment_id
      WHERE v.segment_cutoff IS NULL GROUP BY v.index_version`).all();
    const countPrefix = db.prepare('SELECT COUNT(*) AS n FROM doc_segments WHERE segment_seq <= ?');
    const compactVersion = db.prepare('UPDATE doc_index_versions SET segment_cutoff=? WHERE index_version=?');
    const removeMembers = db.prepare('DELETE FROM doc_index_members WHERE index_version=?');
    for (const row of versions) {
      if (row.members !== row.segment_count || row.found !== row.members || row.documents !== row.document_count)
        throw new Error(`旧索引成员与版本计数不一致：${row.index_version}；未压缩。`);
      if (Number(row.members) > 0 && countPrefix.get(row.cutoff)?.n === row.members) {
        compactVersion.run(row.cutoff, row.index_version);
        removeMembers.run(row.index_version);
      }
    }
    db.prepare(`INSERT INTO doc_segment_storage(id,schema_version,last_seq,segment_count,document_count,content_digest)
      VALUES (1,?,?,?,?,?)`).run(STORAGE_VERSION, lastSeq, segmentCount, documents.size, digest);
  });
}

interface SegmentRow {
  segment_id: string; document_id: string; document_version: string; parser_version: string;
  ordinal: number; kind: string; page_number: number; page_label: string | null;
  section_path_json: string; bbox_json: string; table_json: string | null; source_ref: string;
  text: string; text_digest: string; char_start: number; char_end: number; issues_json: string;
}

function toSegment(row: SegmentRow): DocSegment {
  return {
    segment_id: row.segment_id, document_id: row.document_id, document_version: row.document_version,
    parser_version: row.parser_version, ordinal: row.ordinal,
    kind: row.kind === 'table' ? 'table' : 'paragraph',
    page_number: row.page_number, page_label: row.page_label,
    section_path: JSON.parse(row.section_path_json) as string[],
    bbox: JSON.parse(row.bbox_json) as DocSegment['bbox'],
    table: row.table_json === null ? null : JSON.parse(row.table_json) as SegmentTable,
    source_ref: row.source_ref, text: row.text, text_digest: row.text_digest,
    char_start: row.char_start, char_end: row.char_end,
    issues: JSON.parse(row.issues_json) as string[],
  };
}

export interface PutSegmentsResult { inserted: number; existing: number }

/**
 * 写入片段并同步 FTS 行。片段不可变：
 * - 同 id 同摘要 = 重复写入，幂等；
 * - 同 id 不同摘要 = 身份冲突（id 派生含摘要，出现即伪造或派生规则被改）；
 * - 同 (document, version, parser_version, ordinal) 但 id 不同 = 解析漂移，
 *   说明同一解析器版本产生了不同输出。此时**拒绝写入并报明原因**，不得静默丢弃，
 *   也不得为漂移静默换版本号——正确做法是升 parser_version 后重解析。
 */
export function putDocumentSegments(db: DatabaseSync, segments: DocSegment[], now = Date.now()): PutSegmentsResult {
  ensureSegmentSchema(db);
  return segmentTransaction(db, () => {
    const insert = db.prepare(`INSERT INTO doc_segments (segment_id, document_id, document_version,
      parser_version, ordinal, kind, page_number, page_label, section_path_json, bbox_json, table_json, source_ref,
      text, text_digest, char_start, char_end, issues_json, built_at, segment_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const byId = db.prepare('SELECT text_digest FROM doc_segments WHERE segment_id = ?');
    const byOrdinal = db.prepare(`SELECT segment_id FROM doc_segments
      WHERE document_id = ? AND document_version = ? AND parser_version = ? AND ordinal = ?`);
    const hasDocument = db.prepare('SELECT 1 FROM doc_segments WHERE document_id=? LIMIT 1');
    const insertFts = db.prepare('INSERT INTO doc_segments_fts (rowid, tokens) VALUES (?, ?)');
    const state = db.prepare('SELECT * FROM doc_segment_storage WHERE id=1').get() as unknown as SegmentState;
    let inserted = 0, existing = 0;
    for (const segment of segments) {
      const stored = byId.get(segment.segment_id) as { text_digest?: string } | undefined;
      if (stored) {
        if (stored.text_digest !== segment.text_digest) throw new Error(`片段身份冲突：${segment.segment_id} 已存在但摘要不同。`);
        existing += 1;
        continue;
      }
      const occupied = byOrdinal.get(segment.document_id, segment.document_version, segment.parser_version, segment.ordinal) as { segment_id?: string } | undefined;
      if (occupied?.segment_id) {
        throw new Error(`解析漂移：${segment.document_id}@${segment.document_version} 的 ${segment.parser_version} `
          + `在序号 ${segment.ordinal} 已有片段 ${occupied.segment_id}，本次解析得到 ${segment.segment_id}。`
          + '同一解析器版本输出不一致，须升 parser_version 后重新解析，不得覆盖或混写。');
      }
      if (!hasDocument.get(segment.document_id)) state.document_count++;
      state.last_seq++;
      insert.run(segment.segment_id, segment.document_id, segment.document_version, segment.parser_version,
        segment.ordinal, segment.kind, segment.page_number, segment.page_label, JSON.stringify(segment.section_path),
        JSON.stringify(segment.bbox), segment.table === null ? null : JSON.stringify(segment.table), segment.source_ref,
        segment.text, segment.text_digest, segment.char_start, segment.char_end, JSON.stringify(segment.issues), now, state.last_seq);
      inserted += 1;
      state.segment_count++;
      state.content_digest = nextDigest(state.content_digest, segment.segment_id);
      insertFts.run(state.last_seq, indexTokens(segment.text));
    }
    if (inserted) db.prepare(`UPDATE doc_segment_storage SET last_seq=?,segment_count=?,document_count=?,content_digest=? WHERE id=1`)
      .run(state.last_seq, state.segment_count, state.document_count, state.content_digest);
    return { inserted, existing };
  });
}

export interface IndexVersionInput { indexVersion: string; segmentIds: string[]; note?: string }

export function createIndexVersion(db: DatabaseSync, input: IndexVersionInput, now = Date.now()): { segmentCount: number; documentCount: number } {
  ensureSegmentSchema(db);
  return segmentTransaction(db, () => {
    if (!input.indexVersion.trim()) throw new Error('索引版本名不能为空。');
    if (!input.segmentIds.length) throw new Error('索引版本至少需要一个片段。');
    const unique = [...new Set(input.segmentIds)];
    const find = db.prepare('SELECT document_id,segment_seq FROM doc_segments WHERE segment_id = ?');
    const documents = new Set<string>();
    let cutoff = 0;
    for (const id of unique) {
      const row = find.get(id) as { document_id?: string; segment_seq: number } | undefined;
      if (!row?.document_id) throw new Error(`索引版本引用了不存在的片段：${id}。`);
      documents.add(row.document_id);
      cutoff = Math.max(cutoff, row.segment_seq);
    }
    const exists = db.prepare('SELECT index_version FROM doc_index_versions WHERE index_version = ?').get(input.indexVersion);
    if (exists) throw new Error(`索引版本已存在且不可改写：${input.indexVersion}。`);
    const prefix = db.prepare('SELECT COUNT(*) AS n FROM doc_segments WHERE segment_seq <= ?').get(cutoff)?.n === unique.length;
    db.prepare(`INSERT INTO doc_index_versions (index_version, tokenizer, built_at, segment_count, document_count, note, segment_cutoff)
      VALUES (?,?,?,?,?,?,?)`).run(input.indexVersion, SEGMENT_TOKENIZER, now, unique.length, documents.size, input.note ?? null, prefix ? cutoff : null);
    if (!prefix) {
      const member = db.prepare('INSERT INTO doc_index_members (index_version, segment_id) VALUES (?, ?)');
      for (const id of unique) member.run(input.indexVersion, id);
    }
    return { segmentCount: unique.length, documentCount: documents.size };
  });
}

/** 新增片段时只追加一个共享检查点；重复建索引直接复用，不枚举或复制全量成员。 */
export function createCurrentIndexVersion(db: DatabaseSync, note?: string, now = Date.now()): {
  indexVersion: string; builtAt: number; segmentCount: number; documentCount: number; reused: boolean;
} {
  ensureSegmentSchema(db);
  return segmentTransaction(db, () => {
    const state = db.prepare('SELECT * FROM doc_segment_storage WHERE id=1').get() as unknown as SegmentState;
    if (!state.segment_count) throw new Error('索引版本至少需要一个片段。');
    const existing = db.prepare(`SELECT index_version,built_at,segment_count,document_count FROM doc_index_versions
      WHERE segment_cutoff=? AND tokenizer=? ORDER BY built_at DESC,rowid DESC LIMIT 1`).get(state.last_seq, SEGMENT_TOKENIZER);
    if (existing) return { indexVersion: String(existing.index_version), builtAt: Number(existing.built_at),
      segmentCount: Number(existing.segment_count), documentCount: Number(existing.document_count), reused: true };
    const digest = createHash('sha256').update(SEGMENT_TOKENIZER).update('\0').update(state.content_digest).digest('hex');
    const indexVersion = `idx_${digest.slice(0, 24)}`;
    db.prepare(`INSERT INTO doc_index_versions(index_version,tokenizer,built_at,segment_count,document_count,note,segment_cutoff)
      VALUES (?,?,?,?,?,?,?)`).run(indexVersion, SEGMENT_TOKENIZER, now, state.segment_count, state.document_count, note ?? null, state.last_seq);
    return { indexVersion, builtAt: now, segmentCount: state.segment_count, documentCount: state.document_count, reused: false };
  });
}

export interface SearchInput { indexVersion: string; query: string; limit?: number;
  /** Explicit evidence documents from a verified structured row association; applied before LIMIT. */
  documentIds?: readonly string[];
  /**
   * 已解析的可见版本键（`document_id@document_version`）。
   * `null` / 缺省＝不施加时间门（当前视图）；空数组＝该时点一个版本都不可见。
   */
  visibleVersions?: readonly string[] | null }

const SEGMENT_COLUMNS = `s.segment_id, s.document_id, s.document_version, s.parser_version, s.ordinal, s.kind,
  s.page_number, s.page_label, s.section_path_json, s.bbox_json, s.table_json, s.source_ref, s.text, s.text_digest,
  s.char_start, s.char_end, s.issues_json`;

const TIME_JOIN = `JOIN doc_document_versions d ON d.document_id = s.document_id
  AND d.document_version = s.document_version AND d.parser_version = s.parser_version`;

/** 时间门与版本收敛都在 `resolveVisibleVersions` 里算；SQL 只按解析结果过滤。 */
const VERSION_FILTER = `AND (d.document_id || '@' || d.document_version) IN (SELECT value FROM json_each(?))`;
const INDEX_JOIN = 'JOIN doc_index_versions v ON v.index_version = ?';
const INDEX_FILTER = `AND ((v.segment_cutoff IS NOT NULL AND s.segment_seq <= v.segment_cutoff)
  OR (v.segment_cutoff IS NULL AND EXISTS (SELECT 1 FROM doc_index_members m
    WHERE m.index_version=v.index_version AND m.segment_id=s.segment_id)))`;

function versionParams(input: SearchInput): string[] | null {
  if (input.visibleVersions === null || input.visibleVersions === undefined) return null;
  return [JSON.stringify([...input.visibleVersions])];
}

/** 关键词检索：按 BM25 排序，稳定片段ID解开修订版本平局，保证限量结果可复现。 */
export function searchSegments(db: DatabaseSync, input: SearchInput): SearchHit[] {
  ensureSegmentSchema(db);
  const expression = ftsQuery(input.query);
  if (expression === null) return [];
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 500);
  const filter = versionParams(input);
  const documents = input.documentIds === undefined ? [] : [JSON.stringify(input.documentIds)];
  const documentFilter = documents.length ? 'AND s.document_id IN (SELECT value FROM json_each(?))' : '';
  if (filter !== null) {
    const rows = db.prepare(`SELECT ${SEGMENT_COLUMNS}, bm25(doc_segments_fts) AS rank
      FROM doc_segments_fts
      JOIN doc_segments s ON s.segment_seq = doc_segments_fts.rowid
      ${INDEX_JOIN}
      ${TIME_JOIN}
      WHERE doc_segments_fts MATCH ? ${INDEX_FILTER} ${VERSION_FILTER} ${documentFilter}
      ORDER BY rank, s.document_id, s.ordinal, s.segment_id
      LIMIT ?`).all(input.indexVersion, expression, ...filter, ...documents, limit) as unknown as (SegmentRow & { rank: number })[];
    return rows.map(row => ({ segment: toSegment(row), matched: 'keyword' as const, score: row.rank }));
  }
  const rows = db.prepare(`SELECT ${SEGMENT_COLUMNS}, bm25(doc_segments_fts) AS rank
    FROM doc_segments_fts
    JOIN doc_segments s ON s.segment_seq = doc_segments_fts.rowid
    ${INDEX_JOIN}
    WHERE doc_segments_fts MATCH ? ${INDEX_FILTER} ${documentFilter}
    ORDER BY rank, s.document_id, s.ordinal, s.segment_id
    LIMIT ?`).all(input.indexVersion, expression, ...documents, limit) as unknown as (SegmentRow & { rank: number })[];
  return rows.map(row => ({ segment: toSegment(row), matched: 'keyword' as const, score: row.rank }));
}

/** 精确检索：不做分词的大小写敏感子串匹配，用于代码、公告编号、期间等确定性标识。 */
export function searchSegmentsExact(db: DatabaseSync, input: SearchInput): SearchHit[] {
  ensureSegmentSchema(db);
  const term = input.query.trim();
  if (!term) return [];
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 500);
  const filter = versionParams(input);
  const documents = input.documentIds === undefined ? [] : [JSON.stringify(input.documentIds)];
  const documentFilter = documents.length ? 'AND s.document_id IN (SELECT value FROM json_each(?))' : '';
  if (filter !== null) {
    const rows = db.prepare(`SELECT ${SEGMENT_COLUMNS}
      FROM doc_segments s
      ${INDEX_JOIN}
      ${TIME_JOIN}
      WHERE instr(s.text, ?) > 0 ${INDEX_FILTER} ${VERSION_FILTER} ${documentFilter}
      ORDER BY s.document_id, s.ordinal, s.segment_id
      LIMIT ?`).all(input.indexVersion, term, ...filter, ...documents, limit) as unknown as SegmentRow[];
    return rows.map(row => ({ segment: toSegment(row), matched: 'exact' as const }));
  }
  const rows = db.prepare(`SELECT ${SEGMENT_COLUMNS}
    FROM doc_segments s
    ${INDEX_JOIN}
    WHERE instr(s.text, ?) > 0 ${INDEX_FILTER} ${documentFilter}
    ORDER BY s.document_id, s.ordinal, s.segment_id
    LIMIT ?`).all(input.indexVersion, term, ...documents, limit) as unknown as SegmentRow[];
  return rows.map(row => ({ segment: toSegment(row), matched: 'exact' as const }));
}

export function readSegment(db: DatabaseSync, segmentId: string): DocSegment | null {
  ensureSegmentSchema(db);
  const row = db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM doc_segments s WHERE s.segment_id = ?`).get(segmentId) as unknown as SegmentRow | undefined;
  return row ? toSegment(row) : null;
}

export function listSegments(db: DatabaseSync, documentId: string, documentVersion?: string): DocSegment[] {
  ensureSegmentSchema(db);
  const rows = (documentVersion === undefined
    ? db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM doc_segments s WHERE s.document_id = ? ORDER BY s.parser_version, s.ordinal`).all(documentId)
    : db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM doc_segments s WHERE s.document_id = ? AND s.document_version = ?
        ORDER BY s.parser_version, s.ordinal`).all(documentId, documentVersion)) as unknown as SegmentRow[];
  return rows.map(toSegment);
}

export function listIndexVersions(db: DatabaseSync): { index_version: string; tokenizer: string; built_at: number; segment_count: number; document_count: number }[] {
  ensureSegmentSchema(db);
  return db.prepare(`SELECT index_version, tokenizer, built_at, segment_count, document_count
    FROM doc_index_versions ORDER BY built_at`).all() as unknown as {
      index_version: string; tokenizer: string; built_at: number; segment_count: number; document_count: number }[];
}

// ── 文档版本时间资格与索引解析（R09 / 4.8 §8） ─────────────────────────────

interface DocumentRow {
  document_id: string; document_version: string; parser_version: string; artifact_ref: string; artifact_sha256: string;
  origin_sha256: string; acquired_at: number; event_time: number | null; event_time_state: string;
  event_time_precision: string | null; disclosed_at: number | null; disclosed_at_state: string;
  disclosed_at_precision: string | null; parsed_at: number; page_count: number; segment_count: number; issues_json: string;
}

function dimensionOf(state: string, value: number | null, precision: string | null): TimeDimension {
  if (state === 'known' && typeof value === 'number') {
    const dimension: TimeDimension = { state: 'known', value, precision: (precision ?? null) as TimePrecision | null, upper: null };
    return { ...dimension, upper: upperOf(dimension) };
  }
  if (state === 'not_applicable') return NOT_APPLICABLE_TIME;
  return UNKNOWN_TIME;
}

function toDocumentTime(row: DocumentRow): DocumentTimeRecord {
  return { document_id: row.document_id, document_version: row.document_version, parser_version: row.parser_version,
    artifact_ref: row.artifact_ref, artifact_sha256: row.artifact_sha256, origin_sha256: row.origin_sha256,
    acquired_at: row.acquired_at,
    event_time: dimensionOf(row.event_time_state, row.event_time, row.event_time_precision),
    disclosed_at: dimensionOf(row.disclosed_at_state, row.disclosed_at, row.disclosed_at_precision),
    parsed_at: row.parsed_at, page_count: row.page_count, segment_count: row.segment_count,
    issues: JSON.parse(row.issues_json) as string[] };
}

function sameDimension(left: TimeDimension, right: TimeDimension): boolean {
  return left.state === right.state && left.value === right.value && left.precision === right.precision
    && left.upper === right.upper;
}

/** 文档版本时间记录不可变：同身份重复写入只允许完全相同的内容。 */
export function putDocumentVersion(db: DatabaseSync, record: DocumentTimeRecord): 'inserted' | 'existing' {
  ensureSegmentSchema(db);
  const existing = readDocumentVersion(db, record.document_id, record.document_version, record.parser_version);
  if (existing) {
    const same = JSON.stringify(existing.issues) === JSON.stringify(record.issues)
      && existing.artifact_ref === record.artifact_ref && existing.artifact_sha256 === record.artifact_sha256
      && existing.origin_sha256 === record.origin_sha256 && existing.acquired_at === record.acquired_at
      && sameDimension(existing.event_time, record.event_time)
      && sameDimension(existing.disclosed_at, record.disclosed_at)
      && existing.parsed_at === record.parsed_at
      && existing.page_count === record.page_count && existing.segment_count === record.segment_count;
    if (!same) throw new Error(`文档时间记录冲突：${record.document_id}@${record.document_version}/${record.parser_version} 已存在且内容不同。`);
    return 'existing';
  }
  // upper 是派生量，读时按 value + precision 现算，不落列：避免同一事实存两处而漂移。
  db.prepare(`INSERT INTO doc_document_versions (document_id, document_version, parser_version, artifact_ref,
    artifact_sha256, origin_sha256, acquired_at, event_time, event_time_state, event_time_precision,
    disclosed_at, disclosed_at_state, disclosed_at_precision, parsed_at, page_count, segment_count,
    issues_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.document_id, record.document_version,
    record.parser_version, record.artifact_ref, record.artifact_sha256, record.origin_sha256, record.acquired_at,
    record.event_time.state === 'known' ? record.event_time.value : null,
    record.event_time.state, record.event_time.state === 'known' ? record.event_time.precision : null,
    record.disclosed_at.state === 'known' ? record.disclosed_at.value : null,
    record.disclosed_at.state, record.disclosed_at.state === 'known' ? record.disclosed_at.precision : null,
    record.parsed_at, record.page_count, record.segment_count, JSON.stringify(record.issues));
  return 'inserted';
}

export function readDocumentVersion(db: DatabaseSync, documentId: string, documentVersion: string, parserVersion: string): DocumentTimeRecord | null {
  ensureSegmentSchema(db);
  const row = db.prepare(`SELECT * FROM doc_document_versions
    WHERE document_id=? AND document_version=? AND parser_version=?`).get(documentId, documentVersion, parserVersion) as unknown as DocumentRow | undefined;
  return row ? toDocumentTime(row) : null;
}

export function listDocumentVersions(db: DatabaseSync): DocumentTimeRecord[] {
  ensureSegmentSchema(db);
  const rows = db.prepare('SELECT * FROM doc_document_versions ORDER BY document_id, document_version, parser_version').all() as unknown as DocumentRow[];
  return rows.map(toDocumentTime);
}

/** 当前视图取最新索引版本；历史视图取 `built_at <= as_of` 的最新版本，重建不改变旧时点回答。 */
export function resolveIndexVersion(db: DatabaseSync, asOf: number | null): { index_version: string; built_at: number } | null {
  ensureSegmentSchema(db);
  const row = (asOf === null
    ? db.prepare('SELECT index_version, built_at FROM doc_index_versions ORDER BY built_at DESC, rowid DESC LIMIT 1').get()
    : db.prepare('SELECT index_version, built_at FROM doc_index_versions WHERE built_at <= ? ORDER BY built_at DESC, rowid DESC LIMIT 1').get(asOf)) as
    { index_version?: string; built_at?: number } | undefined;
  return row?.index_version === undefined ? null : { index_version: row.index_version, built_at: Number(row.built_at) };
}

/**
 * 精度区间的**半开上界**（下一段的起点，本身不属于本区间）。
 * `2024-01` 的上界是 `2024-02-01T00:00:00.000Z`：`as_of` 到达该点才放行，之前一律拒绝。
 * 低精度时间只有整段过去才算“当时已可得”，不得按起点提前放行。
 * 边界按 UTC 计算；业务时区口径见契约 §11.9（待定，不在代码里臆定）。
 */
export function upperOf(dimension: TimeDimension): number {
  const value = dimension.value ?? 0;
  const date = new Date(value);
  switch (dimension.precision) {
    case 'date': return value + 86_400_000;
    case 'month': return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    case 'quarter': return Date.UTC(date.getUTCFullYear(), (Math.floor(date.getUTCMonth() / 3) + 1) * 3, 1);
    case 'year': return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
    default: return value;
  }
}

function gatePass(record: DocumentTimeRecord, asOf: number, mode: RetrievalHistoryMode): RetrievalExclusion['reason'] | null {
  const disclosed = record.disclosed_at;
  if (mode === 'market_known_at') {
    if (disclosed.state === 'not_applicable') return 'disclosure_time_not_applicable';
    if (disclosed.state !== 'known' || disclosed.value === null) return 'disclosure_time_unknown';
    return upperOf(disclosed) <= asOf ? null : 'disclosed_after_as_of';
  }
  if (record.acquired_at > asOf) return 'not_yet_acquired';
  if (record.parsed_at > asOf) return 'not_yet_parsed';
  if (disclosed.state === 'known') { if (upperOf(disclosed) > asOf) return 'disclosed_after_as_of'; }
  else if (disclosed.state === 'unknown') return 'disclosure_time_unknown';
  const event = record.event_time;
  if (event.state === 'known') { if (upperOf(event) > asOf) return 'event_time_after_as_of'; }
  else if (event.state === 'unknown') return 'event_time_unknown';
  return null;
}

/**
 * 目标时点可见的文档版本集合，并给出被排除的原因。
 *
 * 两条正确性边界：
 * 1. **版本收敛**：同一 `document_id` 有多个版本时，只取当时已公开的最后一个版本；
 *    后来才发布的修订正文不进入历史结果（`superseded_by_revision`）。可见版本排序
 *    需要各自披露时间已知，无法排序时整份排除（`version_order_unresolved`），不猜。
 * 2. **精度区间**：比较用区间末端，不把“2024 年 1 月”当 1 月 1 日零点已公开。
 */
export function resolveVisibleVersions(db: DatabaseSync, input: { indexVersion: string; asOf: number;
  mode?: RetrievalHistoryMode }): { allowed: string[]; excluded: RetrievalExclusion[] } {
  ensureSegmentSchema(db);
  const mode = input.mode ?? 'system_held_at';
  const records = db.prepare(`SELECT d.* FROM doc_document_versions d
    WHERE EXISTS (SELECT 1 FROM doc_segments s ${INDEX_JOIN}
      WHERE s.document_id = d.document_id ${INDEX_FILTER}
        AND s.document_version = d.document_version AND s.parser_version = d.parser_version)
    ORDER BY d.document_id, d.document_version`).all(input.indexVersion) as unknown as DocumentRow[];
  const byDocument = new Map<string, { key: string; record: DocumentTimeRecord; reason: RetrievalExclusion['reason'] | null }[]>();
  const excluded: RetrievalExclusion[] = [];
  const allowed: string[] = [];
  for (const row of records) {
    const record = toDocumentTime(row);
    const entry = { key: `${record.document_id}@${record.document_version}`, record,
      reason: gatePass(record, input.asOf, mode) };
    const list = byDocument.get(record.document_id) ?? [];
    list.push(entry);
    byDocument.set(record.document_id, list);
  }
  for (const [, versions] of byDocument) {
    const visible = versions.filter(version => version.reason === null);
    if (versions.length <= 1) {
      for (const version of versions) {
        if (version.reason === null) allowed.push(version.key);
        else excluded.push(exclusionOf(version));
      }
      continue;
    }
    // 多版本：需要能排出“当时最后一个公开版本”，否则整份排除
    const orderable = visible.every(version => version.record.disclosed_at.state === 'known');
    if (!orderable) {
      for (const version of versions) excluded.push({ document_id: version.record.document_id,
        document_version: version.record.document_version, reason: 'version_order_unresolved' });
      continue;
    }
    const winner = [...visible].sort((left, right) =>
      (Number(right.record.disclosed_at.value ?? 0) - Number(left.record.disclosed_at.value ?? 0))
      || right.record.document_version.localeCompare(left.record.document_version))[0];
    for (const version of versions) {
      if (version.reason !== null) excluded.push(exclusionOf(version));
      else if (version.key === winner?.key) allowed.push(version.key);
      else excluded.push({ document_id: version.record.document_id, document_version: version.record.document_version,
        reason: 'superseded_by_revision' });
    }
  }
  return { allowed: allowed.sort(), excluded };
}

function exclusionOf(version: { record: DocumentTimeRecord; reason: RetrievalExclusion['reason'] | null }): RetrievalExclusion {
  return { document_id: version.record.document_id, document_version: version.record.document_version,
    reason: version.reason ?? 'version_order_unresolved' };
}

/** 只取排除清单（测试与诊断用）。 */
export function timeExclusions(db: DatabaseSync, input: { indexVersion: string; asOf: number;
  mode?: RetrievalHistoryMode }): RetrievalExclusion[] {
  return resolveVisibleVersions(db, input).excluded;
}

/** 建索引的成员集合：当前全部片段（v1 契约：全量片段落本地、索引全部片段）。 */
export function indexableSegmentIds(db: DatabaseSync): string[] {
  ensureSegmentSchema(db);
  return (db.prepare('SELECT segment_id FROM doc_segments ORDER BY document_id, document_version, parser_version, ordinal').all() as unknown as { segment_id: string }[])
    .map(row => row.segment_id);
}

/** 整份没有文字层（0 片段）的文档版本数：解析失败的事实，不当成“无结果”。 */
export function documentsWithoutTextLayer(db: DatabaseSync): number {
  ensureSegmentSchema(db);
  const row = db.prepare('SELECT COUNT(*) AS n FROM doc_document_versions WHERE segment_count = 0').get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export interface SegmentStorageReport {
  segments: number; documents: number; indexVersions: number;
  /** 片段正文字节数：这是被落盘的原文，不是“索引元数据”。 */
  textBytes: number;
  /** 另存的 FTS 词项正文字节数；新格式为 0，不代表倒排索引不占存储。 */
  tokenBytes: number;
  ftsIndexBytes: number;
  membershipRows: number;
  sharedIndexVersions: number;
  pages: number;
  oldestParsedAt: number | null;
  newestParsedAt: number | null;
}

/** 检索区实际占用：容量与保留期由运营据此显式决定，程序不自动删除片段。 */
export function segmentStorage(db: DatabaseSync): SegmentStorageReport {
  ensureSegmentSchema(db);
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const segments = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM doc_segments').n ?? 0);
  const documents = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM doc_document_versions').n ?? 0);
  const indexVersions = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM doc_index_versions').n ?? 0);
  const textBytes = Number(one<{ n: number }>('SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))),0) AS n FROM doc_segments').n ?? 0);
  const tokenBytes = Number(one<{ n: number }>('SELECT COALESCE(SUM(LENGTH(CAST(tokens AS BLOB))),0) AS n FROM doc_segments_fts').n ?? 0);
  const ftsIndexBytes = Number(one<{ n: number }>(`SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat
    WHERE name IN ('doc_segments_fts_data','doc_segments_fts_idx','doc_segments_fts_docsize','doc_segments_fts_config')`).n ?? 0);
  const membershipRows = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM doc_index_members').n ?? 0);
  const sharedIndexVersions = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM doc_index_versions WHERE segment_cutoff IS NOT NULL').n ?? 0);
  const pages = Number(one<{ n: number }>('SELECT COALESCE(SUM(page_count),0) AS n FROM doc_document_versions').n ?? 0);
  const range = one<{ lo: number | null; hi: number | null }>(
    'SELECT MIN(parsed_at) AS lo, MAX(parsed_at) AS hi FROM doc_document_versions');
  return { segments, documents, indexVersions, textBytes, tokenBytes, ftsIndexBytes, membershipRows, sharedIndexVersions, pages,
    oldestParsedAt: range.lo === null ? null : Number(range.lo),
    newestParsedAt: range.hi === null ? null : Number(range.hi) };
}

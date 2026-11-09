import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { DocSegment } from './segments/contracts.js';
import { syntheticPages } from './segments/fixture.js';
import { buildDocumentSegments } from './segments/segmenter.js';
import { createCurrentIndexVersion, createIndexVersion, ensureSegmentSchema, indexableSegmentIds,
  listIndexVersions, putDocumentSegments, readSegment, resolveVisibleVersions, searchSegments, searchSegmentsExact,
  segmentStorage } from './segments/store.js';
import { ftsQuery, indexTokens } from './segments/tokenize.js';
import { compactSegmentStorage } from '../../scripts/compact-segment-storage.js';

// 冻结升级前实际使用的 SQLite 格式，不能由新格式反向生成旧夹具。
const LEGACY_SCHEMA = `
CREATE TABLE doc_segments (segment_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,document_version TEXT NOT NULL,
 parser_version TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,page_number INTEGER NOT NULL,page_label TEXT,
 section_path_json TEXT NOT NULL,bbox_json TEXT NOT NULL,table_json TEXT,source_ref TEXT NOT NULL,text TEXT NOT NULL,
 text_digest TEXT NOT NULL,char_start INTEGER NOT NULL,char_end INTEGER NOT NULL,issues_json TEXT NOT NULL,built_at INTEGER NOT NULL);
CREATE UNIQUE INDEX doc_segments_ordinal ON doc_segments(document_id,document_version,parser_version,ordinal);
CREATE TABLE doc_index_versions (index_version TEXT PRIMARY KEY,tokenizer TEXT NOT NULL,built_at INTEGER NOT NULL,
 segment_count INTEGER NOT NULL,document_count INTEGER NOT NULL,note TEXT);
CREATE TABLE doc_index_members (index_version TEXT NOT NULL REFERENCES doc_index_versions(index_version),
 segment_id TEXT NOT NULL REFERENCES doc_segments(segment_id),PRIMARY KEY(index_version,segment_id));
CREATE VIRTUAL TABLE doc_segments_fts USING fts5(segment_id UNINDEXED,tokens,tokenize='unicode61 remove_diacritics 2');
CREATE TABLE doc_document_versions (document_id TEXT NOT NULL,document_version TEXT NOT NULL,parser_version TEXT NOT NULL,
 artifact_ref TEXT NOT NULL,artifact_sha256 TEXT NOT NULL DEFAULT '',origin_sha256 TEXT NOT NULL,acquired_at INTEGER NOT NULL,
 event_time INTEGER,event_time_state TEXT NOT NULL DEFAULT 'unknown',event_time_precision TEXT,disclosed_at INTEGER,
 disclosed_at_state TEXT NOT NULL DEFAULT 'unknown',disclosed_at_precision TEXT,parsed_at INTEGER NOT NULL,page_count INTEGER NOT NULL,
 segment_count INTEGER NOT NULL,issues_json TEXT NOT NULL,PRIMARY KEY(document_id,document_version,parser_version));`;
const segmentColumns = `segment_id,document_id,document_version,parser_version,ordinal,kind,page_number,page_label,
 section_path_json,bbox_json,table_json,source_ref,text,text_digest,char_start,char_end,issues_json,built_at`;
const root = () => realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-segment-compact-')));
const t0 = Date.parse('2024-01-01T00:00:00Z');

function legacyFixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_SCHEMA);
  const all: DocSegment[] = [];
  const insert = db.prepare(`INSERT INTO doc_segments(${segmentColumns}) VALUES (${Array(18).fill('?').join(',')})`);
  const fts = db.prepare('INSERT INTO doc_segments_fts(segment_id,tokens) VALUES (?,?)');
  const version = (name: string, members: DocSegment[], at: number) => {
    db.prepare('INSERT INTO doc_index_versions VALUES (?,?,?,?,?,?)').run(name, 'cjk-bigram+unicode61-v1', at,
      members.length, new Set(members.map(s => s.document_id)).size, '旧版证据，不改身份');
    const member = db.prepare('INSERT INTO doc_index_members VALUES (?,?)');
    for (const segment of members) member.run(name, segment.segment_id);
  };
  for (let i = 0; i < 3; i++) {
    const pages = syntheticPages();
    pages[0]!.items[1]!.text = i === 1 ? '先进封装需求持续增长。先进封装需求持续增长。' : '先进封装需求持续增长。';
    const doc = i === 2 ? 'mat_0' : `mat_${i}`;
    const docVersion = i === 2 ? 'v2' : 'v1';
    const built = buildDocumentSegments({ documentId: doc, documentVersion: docVersion, sourceRef: `artifact:${i}`, pages });
    for (const s of built.segments) {
      insert.run(s.segment_id, s.document_id, s.document_version, s.parser_version, s.ordinal, s.kind, s.page_number,
        s.page_label, JSON.stringify(s.section_path), JSON.stringify(s.bbox), s.table ? JSON.stringify(s.table) : null,
        s.source_ref, s.text, s.text_digest, s.char_start, s.char_end, JSON.stringify(s.issues), t0 + i);
      fts.run(s.segment_id, indexTokens(s.text)); all.push(s);
    }
    db.prepare('INSERT INTO doc_document_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(doc, docVersion,
      built.segments[0]!.parser_version, `artifact:${i}`, 'a'.repeat(64), 'b'.repeat(64), t0 + i,
      null, 'not_applicable', null, t0 + i, 'known', 'datetime', t0 + i, 2, built.segments.length, '[]');
    version(`old_${i}`, all, t0 + i);
  }
  version('old_subset', all.filter(s => s.kind === 'table'), t0 + 4);
  return { db, all };
}

function legacyHits(db: DatabaseSync, version: string, query: string, method: 'keyword' | 'exact') {
  // 旧SQL的主排序键保留；同文档修订平局明确按稳定ID收尾，不依赖成员扫描顺序。
  if (method === 'keyword') return db.prepare(`SELECT s.segment_id,bm25(doc_segments_fts) AS score
    FROM doc_segments_fts JOIN doc_index_members m ON m.segment_id=doc_segments_fts.segment_id AND m.index_version=?
    JOIN doc_segments s ON s.segment_id=doc_segments_fts.segment_id WHERE doc_segments_fts MATCH ?
    ORDER BY score,s.document_id,s.ordinal,s.segment_id LIMIT 500`).all(version, ftsQuery(query)).map(row => ({ id: row.segment_id, score: row.score }));
  return db.prepare(`SELECT s.segment_id FROM doc_segments s JOIN doc_index_members m
    ON m.segment_id=s.segment_id AND m.index_version=? WHERE instr(s.text,?)>0 ORDER BY s.document_id,s.ordinal,s.segment_id LIMIT 500`)
    .all(version, query).map(row => ({ id: row.segment_id }));
}

test('真实旧格式迁移保留所有索引身份、任意选集、中文结果及 BM25 分值；重开与 VACUUM 后不漂移', () => {
  const path = join(root(), 'old.sqlite');
  const { db, all } = legacyFixture(path);
  const versions = db.prepare('SELECT * FROM doc_index_versions ORDER BY built_at').all();
  const documents = db.prepare('SELECT * FROM doc_document_versions ORDER BY document_id,document_version').all();
  const beforeSegments = db.prepare(`SELECT ${segmentColumns} FROM doc_segments ORDER BY segment_id`).all();
  const queries = ['先进封装', '半导体', '营业收入', '净利润', '1,500', '2024', '不存在'];
  const cases = versions.flatMap(v => queries.flatMap(query => (['keyword', 'exact'] as const)
    .map(method => ({ version: String(v.index_version), query, method,
      hits: legacyHits(db, String(v.index_version), query, method) }))));
  ensureSegmentSchema(db);
  const verify = (connection: DatabaseSync) => {
    assert.deepEqual(connection.prepare(`SELECT ${segmentColumns} FROM doc_segments ORDER BY segment_id`).all(), beforeSegments);
    assert.deepEqual(connection.prepare('SELECT * FROM doc_document_versions ORDER BY document_id,document_version').all(), documents);
    assert.deepEqual(connection.prepare(`SELECT index_version,tokenizer,built_at,segment_count,document_count,note
      FROM doc_index_versions ORDER BY built_at`).all(), versions);
    for (const c of cases) {
      const result = (c.method === 'keyword' ? searchSegments : searchSegmentsExact)(connection,
        { indexVersion: c.version, query: c.query, limit: 500 });
      assert.deepEqual(result.map(hit => ({ id: hit.segment.segment_id, ...(c.method === 'keyword' ? { score: hit.score } : {}) })), c.hits);
      // LIMIT 可恰好截断同文档/序号的两个修订；迁移、rowid改变、压实与重开均须选同一ID。
      for (const limit of [1, 2]) {
        const limited = (c.method === 'keyword' ? searchSegments : searchSegmentsExact)(connection,
          { indexVersion: c.version, query: c.query, limit });
        assert.deepEqual(limited.map(hit => ({ id: hit.segment.segment_id,
          ...(c.method === 'keyword' ? { score: hit.score } : {}) })), c.hits.slice(0, limit));
      }
    }
    for (const segment of all) assert.deepEqual(readSegment(connection, segment.segment_id), segment);
  };
  verify(db);
  assert.equal(segmentStorage(db).sharedIndexVersions, 3);
  assert.equal(segmentStorage(db).membershipRows, 3, '非全量的旧选集继续保存准确成员');
  assert.equal(createCurrentIndexVersion(db).indexVersion, 'old_2', '迁移后复用原全量版本，保留旧ID');
  assert.deepEqual(resolveVisibleVersions(db, { indexVersion: 'old_2', asOf: t0 + 1, mode: 'market_known_at' }).allowed,
    ['mat_0@v1', 'mat_1@v1']);
  assert.deepEqual(resolveVisibleVersions(db, { indexVersion: 'old_2', asOf: t0 + 9, mode: 'market_known_at' }).allowed,
    ['mat_0@v2', 'mat_1@v1']);
  db.exec('UPDATE doc_segments SET rowid=rowid+1000');
  verify(db);
  db.exec('VACUUM'); verify(db); db.close();
  const reopened = new DatabaseSync(path);
  try { verify(reopened); assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); }
  finally { reopened.close(); }
});

test('升级中途失败回滚整个格式切换，旧库可继续读并可用同一身份重试', () => {
  const { db } = legacyFixture();
  const expected = legacyHits(db, 'old_2', '先进封装', 'keyword');
  db.setAuthorizer((action, name) => action === constants.SQLITE_DROP_VTABLE && name === 'doc_segments_fts'
    ? constants.SQLITE_DENY : constants.SQLITE_OK);
  assert.throws(() => ensureSegmentSchema(db), /not authorized/iu);
  db.setAuthorizer(null);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='doc_segment_storage'").get(), undefined);
  assert.deepEqual(legacyHits(db, 'old_2', '先进封装', 'keyword'), expected);
  ensureSegmentSchema(db);
  assert.equal(createCurrentIndexVersion(db).indexVersion, 'old_2');
  db.close();
});

test('旧FTS与正文不一致时停止压缩，保留原库供核对', () => {
  const { db } = legacyFixture();
  db.exec("UPDATE doc_segments_fts SET tokens='错误词项' WHERE rowid=1");
  assert.throws(() => ensureSegmentSchema(db), /旧全文索引与片段不一致/u);
  assert.equal(db.prepare('SELECT tokens FROM doc_segments_fts WHERE rowid=1').get()?.tokens, '错误词项');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='doc_segment_storage'").get(), undefined);
  db.close();
});

test('单次片段批写冲突及外层回滚均不留下半份内容、FTS或索引头', () => {
  const db = new DatabaseSync(':memory:');
  const first = buildDocumentSegments({ documentId: 'first', documentVersion: '1', sourceRef: 'first', pages: syntheticPages() });
  const second = buildDocumentSegments({ documentId: 'second', documentVersion: '1', sourceRef: 'second', pages: syntheticPages() });
  putDocumentSegments(db, first.segments);
  const index = createCurrentIndexVersion(db);
  assert.throws(() => putDocumentSegments(db, [second.segments[0]!, { ...first.segments[0]!, text_digest: 'f'.repeat(64) }]), /片段身份冲突/u);
  assert.equal(readSegment(db, second.segments[0]!.segment_id), null);
  assert.equal(createCurrentIndexVersion(db).indexVersion, index.indexVersion);
  db.exec('BEGIN IMMEDIATE');
  putDocumentSegments(db, second.segments); createCurrentIndexVersion(db);
  db.exec('ROLLBACK');
  assert.equal(listIndexVersions(db).length, 1);
  assert.equal(createCurrentIndexVersion(db).indexVersion, index.indexVersion);
  putDocumentSegments(db, second.segments);
  const next = createCurrentIndexVersion(db);
  assert.equal(next.segmentCount, 8); assert.equal(next.documentCount, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doc_segments_fts').get()?.n, 8);
  assert.equal(searchSegments(db, { indexVersion: index.indexVersion, query: '封装' }).length, 1);
  db.close();
});

test('进程在旧FTS切换前被终止，重开仍能读取完整旧库并再次升级', { timeout: 20_000 }, async () => {
  const path = join(root(), 'interrupted.sqlite');
  const fixture = legacyFixture(path);
  const expected = legacyHits(fixture.db, 'old_2', '先进封装', 'keyword');
  fixture.db.close();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { DatabaseSync, constants } from 'node:sqlite';
    import { ensureSegmentSchema } from ${JSON.stringify(new URL('./segments/store.ts', import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.setAuthorizer((action,name) => {
      if (action===constants.SQLITE_DROP_VTABLE && name==='doc_segments_fts') {
        process.send('before-swap');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
      return constants.SQLITE_OK;
    });
    ensureSegmentSchema(db);
  `], { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const message = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(message[0], 'before-swap');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual(legacyHits(db, 'old_2', '先进封装', 'keyword'), expected);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='doc_segment_storage'").get(), undefined);
      ensureSegmentSchema(db);
      assert.equal(createCurrentIndexVersion(db).indexVersion, 'old_2');
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { db.close(); }
  } finally { child.kill('SIGKILL'); }
});

test('两个真实进程并发升级、追加与建索引，稳定序号和快照成员不会丢写', { timeout: 30_000 }, async () => {
  const path = join(root(), 'concurrent.sqlite');
  legacyFixture(path).db.close();
  const code = (writer: string) => `
    import { DatabaseSync } from 'node:sqlite';
    import { ensureSegmentSchema,putDocumentSegments,createCurrentIndexVersion } from ${JSON.stringify(new URL('./segments/store.ts', import.meta.url).href)};
    import { buildDocumentSegments } from ${JSON.stringify(new URL('./segments/segmenter.ts', import.meta.url).href)};
    import { syntheticPages } from ${JSON.stringify(new URL('./segments/fixture.ts', import.meta.url).href)};
    const db=new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA busy_timeout=10000'); ensureSegmentSchema(db);
    for(let i=0;i<40;i++) {
      const doc=${JSON.stringify(writer)}+i;
      putDocumentSegments(db,buildDocumentSegments({documentId:doc,documentVersion:'1',sourceRef:doc,pages:syntheticPages()}).segments);
      createCurrentIndexVersion(db);
    }
    db.close();
  `;
  const run = (writer: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code(writer)],
      { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.on('exit', status => status === 0 ? resolve() : reject(new Error(`并发子进程失败：${status} ${errorText}`)));
  });
  await Promise.all([run('writer_a_'), run('writer_b_')]);
  const db = new DatabaseSync(path);
  try {
    const current = createCurrentIndexVersion(db);
    assert.equal(current.segmentCount, 332); assert.equal(current.documentCount, 82);
    assert.equal(segmentStorage(db).membershipRows, 3);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT segment_seq) AS n FROM doc_segments').get()?.n, 332);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_segments_fts').get()?.n, 332);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM doc_index_versions v WHERE segment_cutoff IS NOT NULL
      AND segment_count != (SELECT COUNT(*) FROM doc_segments s WHERE s.segment_seq<=v.segment_cutoff)`).get()?.n, 0);
    assert.equal(searchSegments(db, { indexVersion: 'old_0', query: '封装', limit: 500 }).length, 1);
    assert.equal(searchSegments(db, { indexVersion: current.indexVersion, query: '封装', limit: 500 }).length, 83);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { db.close(); }
});

test('显式压缩工具只读预览不改字节，应用和回收后重开可用，缺库不会新建', () => {
  const directory = root(), path = join(directory, 'selected.sqlite');
  legacyFixture(path).db.close();
  const original = readFileSync(path);
  assert.equal(compactSegmentStorage({ databasePath: path }).status, 'planned');
  assert.deepEqual(readFileSync(path), original);
  const result = compactSegmentStorage({ databasePath: path, apply: true, vacuum: true });
  assert.equal(result.status, 'compacted');
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(searchSegments(db, { indexVersion: 'old_0', query: '封装' }).length, 1); }
  finally { db.close(); }
  const missing = join(directory, 'missing.sqlite');
  assert.throws(() => compactSegmentStorage({ databasePath: missing, apply: true }), /ENOENT/u);
  assert.equal(existsSync(missing), false);
});

test('逐件全量检查点共享片段集合，不累计复制所有旧成员', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (let i = 0; i < 24; i++) {
      const built = buildDocumentSegments({ documentId: `mat_${i}`, documentVersion: '1',
        sourceRef: `artifact:${i}`, pages: syntheticPages() });
      putDocumentSegments(db, built.segments);
      createIndexVersion(db, { indexVersion: `idx_${i}`, segmentIds: indexableSegmentIds(db) }, i);
    }
    const members = db.prepare('SELECT COUNT(*) AS n FROM doc_index_members').get();
    assert.equal(members?.n, 0, '全量索引以固定上界共享片段，不保存逐版本的全量成员副本');
    assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_0', query: '2024', limit: 500 }).length, 1);
    assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_23', query: '2024', limit: 500 }).length, 24);
  } finally { db.close(); }
});

test('全文索引不再保存词项正文，中文召回与 BM25 排序仍然可用', () => {
  const db = new DatabaseSync(':memory:');
  try {
    ensureSegmentSchema(db);
    const built = buildDocumentSegments({ documentId: 'mat_tokens', documentVersion: '1',
      sourceRef: 'artifact:tokens', pages: syntheticPages() });
    putDocumentSegments(db, built.segments);
    createIndexVersion(db, { indexVersion: 'idx_tokens', segmentIds: indexableSegmentIds(db) });
    assert.equal(db.prepare('SELECT COUNT(tokens) AS n FROM doc_segments_fts').get()?.n, 0);
    const hits = searchSegments(db, { indexVersion: 'idx_tokens', query: '先进封装' });
    assert.equal(hits.length, 1);
    assert.equal(typeof hits[0]!.score, 'number');
  } finally { db.close(); }
});

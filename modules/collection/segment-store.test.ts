import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildDocumentSegments } from './segments/segmenter.js';
import { syntheticPages } from './segments/fixture.js';
import {
  createIndexVersion, ensureSegmentSchema, listIndexVersions, listSegments, putDocumentSegments, readSegment,
  searchSegments, searchSegmentsExact,
} from './segments/store.js';

function seeded() {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_1', documentVersion: 'v1', sourceRef: 'src_1', pages: syntheticPages() });
  putDocumentSegments(db, built.segments);
  createIndexVersion(db, { indexVersion: 'idx_1', segmentIds: built.segments.map(segment => segment.segment_id), note: 'fixture' });
  return { db, built };
}

test('FTS5 可用且中文 2 字词可召回', () => {
  const { db } = seeded();
  const hits = searchSegments(db, { indexVersion: 'idx_1', query: '封装' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.matched, 'keyword');
  assert.match(hits[0]!.segment.text, /先进封装需求持续增长/u);
});

test('4 字词按 bigram AND 召回，单元格内容也可命中', () => {
  const { db } = seeded();
  assert.equal(searchSegments(db, { indexVersion: 'idx_1', query: '先进封装' }).length, 1);
  const tableHit = searchSegments(db, { indexVersion: 'idx_1', query: '营业收入' });
  assert.equal(tableHit.length, 1);
  assert.equal(tableHit[0]!.segment.kind, 'table');
});

test('精确检索按子串命中代码与期间，不经过分词', () => {
  const { db } = seeded();
  assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_1', query: '2024' }).length, 1);
  assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_1', query: '营业收入' }).length, 1);
  assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_1', query: '不存在的标识' }).length, 0);
});

test('空查询返回空，不退化为全表扫描', () => {
  const { db } = seeded();
  assert.deepEqual(searchSegments(db, { indexVersion: 'idx_1', query: '  ，。 ' }), []);
  assert.deepEqual(searchSegmentsExact(db, { indexVersion: 'idx_1', query: '   ' }), []);
});

test('片段读回保留表格结构、坐标与缺口', () => {
  const { db, built } = seeded();
  const table = built.segments.find(segment => segment.kind === 'table')!;
  assert.deepEqual(readSegment(db, table.segment_id), table);
  assert.equal(listSegments(db, 'mat_1').length, 4);
  assert.equal(listSegments(db, 'mat_1', 'v1').length, 4);
  assert.equal(listSegments(db, 'mat_1', 'v2').length, 0);
  assert.equal(readSegment(db, 'sg_不存在'), null);
});

test('重建只产生新索引版本，旧版本查询结果不变', () => {
  const { db, built } = seeded();
  const paragraphIds = built.segments.filter(segment => segment.kind === 'paragraph').map(segment => segment.segment_id);
  createIndexVersion(db, { indexVersion: 'idx_2', segmentIds: paragraphIds });
  assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_2', query: '2024' }).length, 0);
  assert.equal(searchSegmentsExact(db, { indexVersion: 'idx_1', query: '2024' }).length, 1);
  const versions = listIndexVersions(db);
  assert.deepEqual(versions.map(version => [version.index_version, version.segment_count, version.document_count]),
    [['idx_1', 4, 1], ['idx_2', 3, 1]]);
});

test('重复写入幂等；同身份不同摘要被拒绝', () => {
  const { db, built } = seeded();
  assert.deepEqual(putDocumentSegments(db, built.segments), { inserted: 0, existing: 4 });
  const forged = { ...built.segments[0]!, text: '被改写的正文', text_digest: 'f'.repeat(64) };
  assert.throws(() => putDocumentSegments(db, [forged]), /片段身份冲突/u);
});

test('同一解析器版本解析漂移被明确拒绝，原片段不被覆盖', () => {
  const { db, built } = seeded();
  const edited = syntheticPages();
  edited[0]!.items[1]!.text = '先进封装需求显著增长。';
  const drifted = buildDocumentSegments({ documentId: 'mat_1', documentVersion: 'v1', sourceRef: 'src_1', pages: edited });
  assert.throws(() => putDocumentSegments(db, drifted.segments), /解析漂移/u);
  assert.equal(listSegments(db, 'mat_1').length, 4);
  assert.deepEqual(readSegment(db, built.segments[0]!.segment_id), built.segments[0]);
});

test('索引版本不可复用名称，也不能引用不存在的片段', () => {
  const { db, built } = seeded();
  assert.throws(() => createIndexVersion(db, { indexVersion: 'idx_1', segmentIds: [built.segments[0]!.segment_id] }), /不可改写/u);
  assert.throws(() => createIndexVersion(db, { indexVersion: 'idx_3', segmentIds: ['sg_缺失'] }), /不存在/u);
  assert.throws(() => createIndexVersion(db, { indexVersion: 'idx_4', segmentIds: [] }), /至少需要一个片段/u);
});

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { NOT_APPLICABLE_TIME, UNKNOWN_TIME, type DocumentTimeRecord, type RetrievalHistoryMode,
  type TimeDimension } from './segments/contracts.js';
import { buildDocumentSegments } from './segments/segmenter.js';
import { syntheticPages, twoRowPages } from './segments/fixture.js';
import { createIndexVersion, documentsWithoutTextLayer, ensureSegmentSchema, indexableSegmentIds,
  putDocumentSegments, putDocumentVersion, resolveIndexVersion, resolveVisibleVersions, searchSegments,
  searchSegmentsExact, segmentStorage, timeExclusions, upperOf } from './segments/store.js';

const day = 86_400_000;
const t0 = Date.parse('2024-01-01T00:00:00Z');
const known = (value: number, precision: TimeDimension['precision'] = null): TimeDimension => {
  const dimension: TimeDimension = { state: 'known', value, precision, upper: null };
  return { ...dimension, upper: upperOf(dimension) };
};

/** 先算可见版本，再检索：历史模式不会自己放开版本。 */
function keyword(db: DatabaseSync, indexVersion: string, query: string,
  options: { asOf?: number; mode?: RetrievalHistoryMode } = {}) {
  const visible = options.asOf === undefined ? null
    : resolveVisibleVersions(db, { indexVersion, asOf: options.asOf, mode: options.mode }).allowed;
  return searchSegments(db, { indexVersion, query, visibleVersions: visible });
}

function exact(db: DatabaseSync, indexVersion: string, query: string,
  options: { asOf?: number; mode?: RetrievalHistoryMode } = {}) {
  const visible = options.asOf === undefined ? null
    : resolveVisibleVersions(db, { indexVersion, asOf: options.asOf, mode: options.mode }).allowed;
  return searchSegmentsExact(db, { indexVersion, query, visibleVersions: visible });
}

function record(overrides: Partial<DocumentTimeRecord> & { document_id: string }): DocumentTimeRecord {
  return { document_version: '1', parser_version: 'bd.segmenter/1',
    artifact_ref: `artifact:${overrides.document_id}`, artifact_sha256: 'a'.repeat(64), origin_sha256: 'b'.repeat(64),
    acquired_at: t0, event_time: known(t0 + day), disclosed_at: known(t0 + 2 * day), parsed_at: t0 + 3 * day,
    page_count: 2, segment_count: 1, issues: [], ...overrides };
}

function seeded() {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const docA = buildDocumentSegments({ documentId: 'mat_a', documentVersion: '1', sourceRef: 'artifact:a',
    pages: syntheticPages() });
  const docB = buildDocumentSegments({ documentId: 'mat_b', documentVersion: '1', sourceRef: 'artifact:b',
    pages: twoRowPages() });
  for (const built of [docA, docB]) putDocumentSegments(db, built.segments, t0 + 3 * day);
  const recordA = record({ document_id: 'mat_a', parser_version: docA.segments[0]!.parser_version,
    segment_count: docA.segments.length });
  const recordB = record({ document_id: 'mat_b', parser_version: docB.segments[0]!.parser_version,
    artifact_sha256: 'd'.repeat(64), origin_sha256: 'c'.repeat(64), event_time: UNKNOWN_TIME,
    disclosed_at: UNKNOWN_TIME, segment_count: docB.segments.length,
    issues: ['event_time_unknown', 'disclosure_time_unknown'] });
  putDocumentVersion(db, recordA); putDocumentVersion(db, recordB);
  const indexVersion = 'idx_test_v1';
  createIndexVersion(db, { indexVersion, segmentIds: indexableSegmentIds(db) }, t0 + 4 * day);
  return { db, indexVersion, docA, docB, recordA, recordB };
}

test('当前视图不施加时间门：两份文档都进结果', () => {
  const { db, indexVersion } = seeded();
  assert.deepEqual([...new Set(keyword(db, indexVersion, '半导体').map(hit => hit.segment.document_id))], ['mat_a']);
  assert.equal(exact(db, indexVersion, '普通正文').length, 1);
});

test('严格系统持有：as_of 早于取得/解析时间即整份排除', () => {
  const { db, indexVersion } = seeded();
  assert.equal(keyword(db, indexVersion, '半导体', { asOf: t0 - day }).length, 0);
  assert.deepEqual([...new Set(timeExclusions(db, { indexVersion, asOf: t0 - day }).map(entry => entry.reason))],
    ['not_yet_acquired']);
  assert.deepEqual([...new Set(timeExclusions(db, { indexVersion, asOf: t0 + day }).map(entry => entry.reason))],
    ['not_yet_parsed']);
});

test('披露时间未知的文档不可见，原因单列，不冒充无结果', () => {
  const { db, indexVersion } = seeded();
  const asOf = t0 + 5 * day;
  assert.deepEqual(timeExclusions(db, { indexVersion, asOf }), [
    { document_id: 'mat_b', document_version: '1', reason: 'disclosure_time_unknown' },
  ]);
  assert.equal(keyword(db, indexVersion, '普通正文', { asOf }).length, 0);
  assert.equal(keyword(db, indexVersion, '半导体', { asOf }).length >= 1, true);
});

test('事件时间与披露时间晚于 as_of 分开记录', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_d', documentVersion: '1', sourceRef: 'artifact:d',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_d', parsed_at: t0, event_time: known(t0 + 2 * day),
    disclosed_at: known(t0), segment_count: built.segments.length }));
  createIndexVersion(db, { indexVersion: 'idx_d', segmentIds: indexableSegmentIds(db) }, t0);
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_d', asOf: t0 + day }),
    [{ document_id: 'mat_d', document_version: '1', reason: 'event_time_after_as_of' }]);
});

test('not_applicable 的维度不构成门槛：没有业务事件时间的财报在严格模式下仍可见', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_reports', documentVersion: '1', sourceRef: 'artifact:r',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_reports', parsed_at: t0, event_time: NOT_APPLICABLE_TIME,
    disclosed_at: known(t0), segment_count: built.segments.length, issues: ['event_time_not_applicable'] }));
  createIndexVersion(db, { indexVersion: 'idx_reports', segmentIds: indexableSegmentIds(db) }, t0);
  const asOf = t0 + 30 * day;
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_reports', asOf }), [],
    '不适用的事件时间不能把整份财报挡掉');
  assert.equal(keyword(db, 'idx_reports', '半导体', { asOf }).length >= 1, true);
});

test('市场公开历史：来源当时已公开即可重建，不受取得/解析/索引时间限制', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_public', documentVersion: '1', sourceRef: 'artifact:p',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0 + 700 * day);
  putDocumentVersion(db, record({ document_id: 'mat_public', acquired_at: t0 + 700 * day,
    parsed_at: t0 + 700 * day, disclosed_at: known(t0), event_time: NOT_APPLICABLE_TIME,
    segment_count: built.segments.length }));
  createIndexVersion(db, { indexVersion: 'idx_public', segmentIds: indexableSegmentIds(db) }, t0 + 701 * day);
  const asOf = t0 + 30 * day;
  assert.equal(keyword(db, 'idx_public', '半导体', { asOf, mode: 'market_known_at' }).length >= 1, true,
    '公开于 as_of 之前的历史资料应可重建');
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_public', asOf, mode: 'market_known_at' }), []);
  assert.equal(keyword(db, 'idx_public', '半导体', { asOf, mode: 'system_held_at' }).length, 0,
    '系统当时没取得，严格模式必须挡住');
  assert.deepEqual([...new Set(timeExclusions(db, { indexVersion: 'idx_public', asOf,
    mode: 'system_held_at' }).map(entry => entry.reason))], ['not_yet_acquired']);
});

test('市场公开历史的边界：披露晚于 as_of 或披露不适用都被排除', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_late', documentVersion: '1', sourceRef: 'artifact:l',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_late', parsed_at: t0, disclosed_at: known(t0 + 10 * day),
    event_time: NOT_APPLICABLE_TIME, segment_count: built.segments.length }));
  putDocumentSegments(db, buildDocumentSegments({ documentId: 'mat_na', documentVersion: '1', sourceRef: 'artifact:n',
    pages: twoRowPages() }).segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_na', parsed_at: t0, disclosed_at: NOT_APPLICABLE_TIME,
    event_time: NOT_APPLICABLE_TIME, segment_count: 1 }));
  createIndexVersion(db, { indexVersion: 'idx_late', segmentIds: indexableSegmentIds(db) }, t0);
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_late', asOf: t0 + day, mode: 'market_known_at' }), [
    { document_id: 'mat_late', document_version: '1', reason: 'disclosed_after_as_of' },
    { document_id: 'mat_na', document_version: '1', reason: 'disclosure_time_not_applicable' },
  ]);
});

test('R09 边界一：历史公开只取当时已发布的版本，后来才发的修订不进入旧时点', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const original = buildDocumentSegments({ documentId: 'mat_corrected', documentVersion: 'v1',
    sourceRef: 'artifact:s1', pages: syntheticPages() });
  const corrected = buildDocumentSegments({ documentId: 'mat_corrected', documentVersion: 'v2',
    sourceRef: 'artifact:s2', pages: twoRowPages() });
  putDocumentSegments(db, original.segments, t0);
  putDocumentSegments(db, corrected.segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_corrected', document_version: 'v1',
    artifact_ref: 'artifact:s1', parser_version: original.segments[0]!.parser_version, parsed_at: t0,
    acquired_at: t0, disclosed_at: known(t0), event_time: NOT_APPLICABLE_TIME,
    segment_count: original.segments.length }));
  putDocumentVersion(db, record({ document_id: 'mat_corrected', document_version: 'v2',
    artifact_ref: 'artifact:s2', parser_version: corrected.segments[0]!.parser_version, parsed_at: t0 + 400 * day,
    acquired_at: t0 + 400 * day, disclosed_at: known(t0 + 400 * day), event_time: NOT_APPLICABLE_TIME,
    segment_count: corrected.segments.length }));
  createIndexVersion(db, { indexVersion: 'idx_rev', segmentIds: indexableSegmentIds(db) }, t0 + 401 * day);

  // 2024 年时点：只有 v1 公开过，v2 不能出现
  const view = resolveVisibleVersions(db, { indexVersion: 'idx_rev', asOf: t0 + 30 * day, mode: 'market_known_at' });
  assert.deepEqual(view.allowed, ['mat_corrected@v1']);
  assert.equal(view.excluded.some(entry => entry.reason === 'superseded_by_revision'), false,
    '当时 v1 就是当前版本，不能被后来的版本状态回写成“已被取代”');
  assert.deepEqual(view.excluded, [{ document_id: 'mat_corrected', document_version: 'v2',
    reason: 'disclosed_after_as_of' }]);
  const historical = keyword(db, 'idx_rev', '半导体', { asOf: t0 + 30 * day, mode: 'market_known_at' });
  assert.deepEqual([...new Set(historical.map(hit => hit.segment.document_version))], ['v1']);

  // 更正发布之后：取 v2，v1 标为被取代，不再混入
  const later = resolveVisibleVersions(db, { indexVersion: 'idx_rev', asOf: t0 + 500 * day, mode: 'market_known_at' });
  assert.deepEqual(later.allowed, ['mat_corrected@v2']);
  assert.deepEqual(later.excluded, [{ document_id: 'mat_corrected', document_version: 'v1',
    reason: 'superseded_by_revision' }]);
  assert.deepEqual([...new Set(exact(db, 'idx_rev', '普通正文',
    { asOf: t0 + 500 * day, mode: 'market_known_at' }).map(hit => hit.segment.document_version))], ['v2'],
  '更正后只能拿到更正版本，不能两版都返回');
  assert.equal(keyword(db, 'idx_rev', '半导体', { asOf: t0 + 500 * day, mode: 'market_known_at' }).length, 0,
    '被取代的旧版本内容不应再出现');

  // 严格系统持有同样收敛，不因严格而同时返回两版
  assert.deepEqual(resolveVisibleVersions(db, { indexVersion: 'idx_rev', asOf: t0 + 500 * day }).allowed,
    ['mat_corrected@v2']);
});

test('R09 边界一之二：多版本无法按披露时间排序时整份排除，不猜当时版本', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_amb', documentVersion: 'v1', sourceRef: 'artifact:u1',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0);
  putDocumentSegments(db, buildDocumentSegments({ documentId: 'mat_amb', documentVersion: 'v2',
    sourceRef: 'artifact:u2', pages: twoRowPages() }).segments, t0);
  putDocumentVersion(db, record({ document_id: 'mat_amb', document_version: 'v1', artifact_ref: 'artifact:u1',
    parsed_at: t0, disclosed_at: NOT_APPLICABLE_TIME, event_time: NOT_APPLICABLE_TIME,
    segment_count: built.segments.length }));
  putDocumentVersion(db, record({ document_id: 'mat_amb', document_version: 'v2', artifact_ref: 'artifact:u2',
    parsed_at: t0, disclosed_at: NOT_APPLICABLE_TIME, event_time: NOT_APPLICABLE_TIME, segment_count: 1 }));
  createIndexVersion(db, { indexVersion: 'idx_amb', segmentIds: indexableSegmentIds(db) }, t0);
  const view = resolveVisibleVersions(db, { indexVersion: 'idx_amb', asOf: t0 + 10 * day });
  assert.deepEqual(view.allowed, []);
  assert.deepEqual(view.excluded.map(entry => entry.reason),
    ['version_order_unresolved', 'version_order_unresolved']);
});

test('R09 边界二：低精度时间按区间末端比较，不提前放行', () => {
  const db = new DatabaseSync(':memory:');
  ensureSegmentSchema(db);
  const built = buildDocumentSegments({ documentId: 'mat_month', documentVersion: '1', sourceRef: 'artifact:mm',
    pages: syntheticPages() });
  putDocumentSegments(db, built.segments, t0);
  const january = known(Date.parse('2024-01-01T00:00:00Z'), 'month');
  assert.equal(january.upper, Date.parse('2024-02-01T00:00:00Z'), '一月精度的半开上界是 2 月 1 日零点');
  putDocumentVersion(db, record({ document_id: 'mat_month', parsed_at: t0, acquired_at: t0,
    disclosed_at: january, event_time: NOT_APPLICABLE_TIME, segment_count: built.segments.length }));
  createIndexVersion(db, { indexVersion: 'idx_month', segmentIds: indexableSegmentIds(db) }, t0);

  // 1 月 15 日：只知道“一月”，不能声称当时已公开
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_month', asOf: Date.parse('2024-01-15T00:00:00Z'),
    mode: 'market_known_at' }), [{ document_id: 'mat_month', document_version: '1',
    reason: 'disclosed_after_as_of' }]);
  // 边界前 1 毫秒仍必须拒绝（半开区间：上界本身不属于本区间）
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_month',
    asOf: Date.parse('2024-02-01T00:00:00Z') - 1, mode: 'market_known_at' }),
  [{ document_id: 'mat_month', document_version: '1', reason: 'disclosed_after_as_of' }]);
  // 到达边界才放行
  assert.deepEqual(timeExclusions(db, { indexVersion: 'idx_month', asOf: Date.parse('2024-02-01T00:00:00Z'),
    mode: 'market_known_at' }), []);
  assert.equal(keyword(db, 'idx_month', '半导体', { asOf: Date.parse('2024-02-01T00:00:00Z'),
    mode: 'market_known_at' }).length >= 1, true);
  // 年精度同理：2024 年内不算公开，2025 年起才算
  assert.equal(known(Date.parse('2024-01-01T00:00:00Z'), 'year').upper, Date.parse('2025-01-01T00:00:00Z'));
  assert.equal(known(Date.parse('2024-01-01T00:00:00Z'), 'quarter').upper, Date.parse('2024-04-01T00:00:00Z'));
});

test('索引版本按 built_at 钉住：重建不改变旧时点解析到的版本', () => {
  const { db } = seeded();
  assert.equal(resolveIndexVersion(db, null)?.index_version, 'idx_test_v1');
  assert.equal(resolveIndexVersion(db, t0 + 3 * day), null, '索引建成前没有版本可解析');
  createIndexVersion(db, { indexVersion: 'idx_test_v2', segmentIds: indexableSegmentIds(db) }, t0 + 10 * day);
  assert.equal(resolveIndexVersion(db, t0 + 5 * day)?.index_version, 'idx_test_v1');
  assert.equal(resolveIndexVersion(db, t0 + 11 * day)?.index_version, 'idx_test_v2');
});

test('文档时间记录不可改写：同身份不同内容直接报错', () => {
  const { db, recordA } = seeded();
  assert.equal(putDocumentVersion(db, recordA), 'existing');
  assert.throws(() => putDocumentVersion(db, { ...recordA, acquired_at: t0 + 1 }), /时间记录冲突/u);
  assert.throws(() => putDocumentVersion(db, { ...recordA, disclosed_at: known(t0) }), /时间记录冲突/u);
});

test('检索区占用可核：正文、倒排索引与零片段文档分别计数', () => {
  const { db } = seeded();
  const report = segmentStorage(db);
  assert.ok(report.segments >= 2);
  assert.ok(report.textBytes > 0);
  assert.equal(report.tokenBytes, 0);
  assert.ok(report.ftsIndexBytes > 0);
  assert.equal(report.membershipRows, 0);
  assert.equal(report.sharedIndexVersions, 1);
  assert.equal(report.indexVersions, 1);
  assert.equal(documentsWithoutTextLayer(db), 0);
  putDocumentVersion(db, record({ document_id: 'mat_blank', segment_count: 0, page_count: 3,
    issues: ['page_text_layer_incomplete'], disclosed_at: NOT_APPLICABLE_TIME, event_time: NOT_APPLICABLE_TIME }));
  assert.equal(documentsWithoutTextLayer(db), 1);
  assert.equal(segmentStorage(db).documents, 3);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentsFromConversionArtifact } from './segments/from-conversion.js';
import { SEGMENT_ISSUES } from './segments/contracts.js';

const ref = { artifactRef: 'artifact:structured-conversion:1', documentId: 'mat_1', documentVersion: 'v1' };

function envelope() {
  return {
    status: 'partial' as const,
    implementation: { name: 'harness-native-conversion', version: '1.0.0', pdfjs: '6.4.299' },
    source: { sha256: 'a'.repeat(64), declaredName: '样本.pdf', fileRefId: 'file_1', fileRefVersion: 1 },
    issues: [
      { code: 'PDF_READING_ORDER_UNVERIFIED', message: '无结构树', location: { page: 1 } },
      { code: 'PDF_GEOMETRIC_CANDIDATES', message: '几何表格候选', location: { page: 1 } },
      { code: 'PDF_PAGE_LIMIT', message: '文档级缺口，无页码' },
    ],
    content: { format: 'pdf', pageCount: 1, pages: [{
      page: 1, pageLabel: '1', width: 595, height: 842, text: '',
      originalItems: [
        { index: 0, str: '半导体行业研究报告', transform: [1, 0, 0, 1, 72, 800], width: 108, height: 12, hasEOL: true },
        { index: 1, str: '项目', transform: [1, 0, 0, 1, 72, 650], width: 32, height: 11, hasEOL: false },
        { index: 2, str: '2024', transform: [1, 0, 0, 1, 300, 650], width: 32, height: 11, hasEOL: false },
        { index: 3, str: '2025', transform: [1, 0, 0, 1, 420, 650], width: 32, height: 11, hasEOL: true },
        { index: 4, str: '营业收入', transform: [1, 0, 0, 1, 72, 630], width: 48, height: 11, hasEOL: false },
        { index: 5, str: '1,200', transform: [1, 0, 0, 1, 300, 630], width: 40, height: 11, hasEOL: false },
        { index: 6, str: '1,500', transform: [1, 0, 0, 1, 420, 630], width: 40, height: 11, hasEOL: true },
        { index: 7, str: '净利润', transform: [1, 0, 0, 1, 72, 610], width: 32, height: 11, hasEOL: false },
        { index: 8, str: '120', transform: [1, 0, 0, 1, 300, 610], width: 24, height: 11, hasEOL: false },
        { index: 9, str: '180', transform: [1, 0, 0, 1, 420, 610], width: 24, height: 11, hasEOL: true },
      ],
      tableCandidates: [
        { row: 2, baselineY: 650, cells: [{ x: 72, endX: 104, text: '项目', itemIndexes: [1] },
          { x: 300, endX: 332, text: '2024', itemIndexes: [2] }, { x: 420, endX: 452, text: '2025', itemIndexes: [3] }] },
        { row: 3, baselineY: 630, cells: [{ x: 72, endX: 120, text: '营业收入', itemIndexes: [4] },
          { x: 300, endX: 340, text: '1,200', itemIndexes: [5] }, { x: 420, endX: 460, text: '1,500', itemIndexes: [6] }] },
        { row: 4, baselineY: 610, cells: [{ x: 72, endX: 104, text: '净利润', itemIndexes: [7] },
          { x: 300, endX: 324, text: '120', itemIndexes: [8] }, { x: 420, endX: 444, text: '180', itemIndexes: [9] }] },
      ],
    }] },
  };
}

test('从已登记转换产物生成片段：来源引用与解析器版本可追溯', () => {
  const built = segmentsFromConversionArtifact(envelope(), ref);
  assert.equal(built.segments.length, 2);
  assert.deepEqual(built.segments.map(segment => segment.kind), ['paragraph', 'table']);
  for (const segment of built.segments) {
    assert.equal(segment.source_ref, ref.artifactRef);
    assert.equal(segment.parser_version, 'bd.segmenter/1+pdfjs-6.4.299');
    assert.equal(segment.document_id, 'mat_1');
  }
  const table = built.segments[1]!;
  assert.deepEqual(table.table!.header, ['项目', '2024', '2025']);
  assert.equal(table.table!.rows[0]!.cells[2]!.text, '1,500');
});

test('转换缺口按页落到片段：阅读顺序/几何候选不被吞掉', () => {
  const built = segmentsFromConversionArtifact(envelope(), ref);
  const [paragraph, table] = built.segments;
  assert.ok(paragraph!.issues.includes('reading_order_unverified'));
  assert.ok(table!.issues.includes('reading_order_unverified'));
  assert.ok(table!.issues.includes(SEGMENT_ISSUES.tableGeometryUnverified));
  // 几何候选只影响表格，不应污染正文的判断
  assert.equal(paragraph!.issues.includes(SEGMENT_ISSUES.tableGeometryUnverified), false);
  assert.equal(built.documentIssues.length, 0);
});

test('失败产物与缺少产物引用都拒绝，不生成半成品', () => {
  assert.throws(() => segmentsFromConversionArtifact({ ...envelope(), status: 'failed' }, ref), /failed/u);
  assert.throws(() => segmentsFromConversionArtifact(envelope(), { ...ref, artifactRef: '  ' }), /产物引用/u);
  assert.throws(() => segmentsFromConversionArtifact(envelope(), { ...ref, documentId: '' }), /documentId/u);
  assert.throws(() => segmentsFromConversionArtifact(envelope(), { ...ref, documentVersion: '' }), /documentVersion/u);
  assert.throws(() => segmentsFromConversionArtifact({ ...envelope(), content: {} }, ref), /content\.pages/u);
});

test('同一产物两次生成片段 id 完全一致', () => {
  const once = segmentsFromConversionArtifact(envelope(), ref);
  const twice = segmentsFromConversionArtifact(envelope(), ref);
  assert.deepEqual(once.segments.map(segment => segment.segment_id), twice.segments.map(segment => segment.segment_id));
});

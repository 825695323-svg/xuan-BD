import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentSegments, pdfPagesFromConversion } from './segments/segmenter.js';
import { SEGMENT_ISSUES } from './segments/contracts.js';
import { emptyTextPages, syntheticPages, twoRowPages } from './segments/fixture.js';

const base = { documentId: 'mat_1', documentVersion: 'v1', sourceRef: 'src_1' };

test('正文段落按间距断开，表格只在连续三行候选时成立', () => {
  const result = buildDocumentSegments({ ...base, pages: syntheticPages() });
  assert.equal(result.segments.length, 4);
  assert.deepEqual(result.segments.map(segment => segment.kind), ['paragraph', 'paragraph', 'table', 'paragraph']);
  assert.equal(result.segments[0]!.text, '半导体行业研究报告\n先进封装需求持续增长。\n产能扩张需要资本开支支持。');
  assert.equal(result.segments[1]!.text, '估值与风险部分单独讨论。');
  assert.equal(result.segments[0]!.page_number, 1);
  assert.equal(result.segments[0]!.page_label, '1');
  assert.equal(result.segments[3]!.page_number, 2);
  assert.equal(result.segments[3]!.page_label, 'ii');
  assert.deepEqual(result.segments[0]!.section_path, []);
  assert.ok(result.segments[0]!.issues.includes(SEGMENT_ISSUES.sectionUnavailable));
});

test('表格保留表头、期间轴、行标签与单元格坐标', () => {
  const [table] = buildDocumentSegments({ ...base, pages: syntheticPages() }).segments.filter(segment => segment.kind === 'table');
  assert.ok(table?.table);
  assert.equal(table.table.table_id, 'mat_1#p1-t1');
  assert.deepEqual(table.table.header, ['项目', '2024', '2025']);
  assert.deepEqual(table.table.period_axis, ['2024', '2025']);
  assert.equal(table.table.rows.length, 2);
  assert.equal(table.table.rows[0]!.label, '营业收入');
  assert.equal(table.table.rows[0]!.cells[0]!.cell_ref, 'mat_1#p1-t1:r2c1');
  assert.equal(table.table.rows[1]!.cells[2]!.cell_ref, 'mat_1#p1-t1:r3c3');
  assert.equal(table.table.rows[1]!.cells[2]!.text, '180');
  assert.equal(table.table.row_count, 2);
  assert.equal(table.table.cell_count, 9);
  assert.equal(table.table.verification, 'unverified-geometry');
  assert.equal(table.table.unit, null);
  assert.ok(table.issues.includes(SEGMENT_ISSUES.tableUnitNotExtracted));
  assert.ok(table.issues.includes(SEGMENT_ISSUES.tableGeometryUnverified));
  assert.equal(table.text, '项目 | 2024 | 2025\n营业收入 | 1,200 | 1,500\n净利润 | 120 | 180');
  assert.ok(table.bbox.x0 <= 72 && table.bbox.x1 >= 420 + 32 - 8);
});

test('字符偏移与全文一致，片段可回到原文范围', () => {
  const result = buildDocumentSegments({ ...base, pages: syntheticPages() });
  for (const [index, segment] of result.segments.entries()) {
    assert.equal(result.fullText.slice(segment.char_start, segment.char_end), segment.text);
    if (index > 0) assert.equal(segment.char_start, result.segments[index - 1]!.char_end + 1);
  }
});

test('segment_id 由位置、解析器版本与摘要派生，重建稳定、换版即变', () => {
  const once = buildDocumentSegments({ ...base, pages: syntheticPages() });
  const twice = buildDocumentSegments({ ...base, pages: syntheticPages() });
  assert.deepEqual(once.segments.map(segment => segment.segment_id), twice.segments.map(segment => segment.segment_id));
  assert.equal(new Set(once.segments.map(segment => segment.segment_id)).size, once.segments.length);

  const upgraded = buildDocumentSegments({ ...base, parserVersion: 'bd.segmenter/2', pages: syntheticPages() });
  assert.equal(upgraded.segments.some(segment => once.segments.some(older => older.segment_id === segment.segment_id)), false);

  const editedPages = syntheticPages();
  editedPages[1]!.items[0]!.text = '第二页补充说明！';
  const edited = buildDocumentSegments({ ...base, pages: editedPages });
  assert.equal(edited.segments[0]!.segment_id, once.segments[0]!.segment_id);
  assert.notEqual(edited.segments[3]!.segment_id, once.segments[3]!.segment_id);
});

test('不足三行的表格候选回到正文，不冒充表格', () => {
  const result = buildDocumentSegments({ ...base, pages: twoRowPages() });
  assert.deepEqual([...new Set(result.segments.map(segment => segment.kind))], ['paragraph']);
  assert.ok(result.segments.every(segment => segment.table === null));
  assert.match(result.segments.map(segment => segment.text).join('\n'), /营业收入/u);
});

test('无文字层页面只记文档级缺口，不生成片段', () => {  const result = buildDocumentSegments({ ...base, pages: emptyTextPages() });
  assert.equal(result.segments.length, 0);
  assert.equal(result.fullText, '');
  assert.deepEqual(result.documentIssues.map(issue => issue.code), [SEGMENT_ISSUES.pageTextLayerIncomplete]);
  assert.equal(result.documentIssues[0]!.page, 1);
});

test('孤立短数字行保留为片段并标候选，不删除内容', () => {
  const pages = [{ page: 1, pageLabel: '1', width: 595, height: 842,
    items: [
      { index: 0, text: '正文第一段。', x: 72, y: 800, width: 60, height: 12, endOfLine: true },
      { index: 1, text: '2', x: 300, y: 700, width: 8, height: 12, endOfLine: true },
    ], tableCandidates: [] }];
  const result = buildDocumentSegments({ ...base, pages });
  assert.equal(result.segments.length, 2);
  const short = result.segments.find(segment => segment.text === '2');
  assert.ok(short);
  assert.ok(short.issues.includes(SEGMENT_ISSUES.isolatedShortLine));
  assert.equal(result.segments[0]!.issues.includes(SEGMENT_ISSUES.isolatedShortLine), false);
});

test('与表格行部分重叠的行交回正文，表格标重叠缺口', () => {
  // 表头行中间混入一个不属于任何表格单元格的原文字项：该行不得被表格吞掉。
  const [header] = syntheticPages()[0]!.tableCandidates;
  const page = {
    page: 1, pageLabel: null, width: 595, height: 842,
    items: [
      { index: 0, text: '表外文字', x: 500, y: 650, width: 48, height: 11, endOfLine: false },
      { index: 1, text: header!.cells[0]!.text, x: 72, y: 650, width: 32, height: 11, endOfLine: false },
      { index: 2, text: header!.cells[1]!.text, x: 300, y: 650, width: 32, height: 11, endOfLine: false },
      { index: 3, text: header!.cells[2]!.text, x: 420, y: 650, width: 32, height: 11, endOfLine: true },
      { index: 4, text: '营业收入', x: 72, y: 630, width: 48, height: 11, endOfLine: false },
      { index: 5, text: '1,200', x: 300, y: 630, width: 40, height: 11, endOfLine: false },
      { index: 6, text: '1,500', x: 420, y: 630, width: 40, height: 11, endOfLine: true },
      { index: 7, text: '净利润', x: 72, y: 610, width: 32, height: 11, endOfLine: false },
      { index: 8, text: '120', x: 300, y: 610, width: 24, height: 11, endOfLine: false },
      { index: 9, text: '180', x: 420, y: 610, width: 24, height: 11, endOfLine: true },
    ],
    tableCandidates: [
      { row: 1, baselineY: 650, cells: [{ x: 72, endX: 104, text: '项目', itemIndexes: [1] },
        { x: 300, endX: 332, text: '2024', itemIndexes: [2] }, { x: 420, endX: 452, text: '2025', itemIndexes: [3] }] },
      { row: 2, baselineY: 630, cells: [{ x: 72, endX: 120, text: '营业收入', itemIndexes: [4] },
        { x: 300, endX: 340, text: '1,200', itemIndexes: [5] }, { x: 420, endX: 460, text: '1,500', itemIndexes: [6] }] },
      { row: 3, baselineY: 610, cells: [{ x: 72, endX: 104, text: '净利润', itemIndexes: [7] },
        { x: 300, endX: 324, text: '120', itemIndexes: [8] }, { x: 420, endX: 444, text: '180', itemIndexes: [9] }] },
    ],
  };
  const result = buildDocumentSegments({ ...base, pages: [page] });
  const table = result.segments.find(segment => segment.kind === 'table');
  assert.ok(table?.issues.includes(SEGMENT_ISSUES.tableLineOverlap));
  assert.ok(result.segments.some(segment => segment.kind === 'paragraph' && segment.text.includes('表外文字')));
});

test('首行即数据行时不伪造表头，全部按数据行处理', () => {
  const page = {
    page: 1, pageLabel: null, width: 595, height: 842,
    items: [
      { index: 0, text: '营业收入', x: 72, y: 650, width: 40, height: 11, endOfLine: false },
      { index: 1, text: '1,200', x: 300, y: 650, width: 40, height: 11, endOfLine: false },
      { index: 2, text: '1,500', x: 420, y: 650, width: 40, height: 11, endOfLine: true },
      { index: 3, text: '净利润', x: 72, y: 630, width: 32, height: 11, endOfLine: false },
      { index: 4, text: '120', x: 300, y: 630, width: 24, height: 11, endOfLine: false },
      { index: 5, text: '180', x: 420, y: 630, width: 24, height: 11, endOfLine: true },
      { index: 6, text: '每股收益', x: 72, y: 610, width: 48, height: 11, endOfLine: false },
      { index: 7, text: '1.24', x: 300, y: 610, width: 28, height: 11, endOfLine: false },
      { index: 8, text: '1.18', x: 420, y: 610, width: 28, height: 11, endOfLine: true },
    ],
    tableCandidates: [
      { row: 1, baselineY: 650, cells: [{ x: 72, endX: 112, text: '营业收入', itemIndexes: [0] },
        { x: 300, endX: 340, text: '1,200', itemIndexes: [1] }, { x: 420, endX: 460, text: '1,500', itemIndexes: [2] }] },
      { row: 2, baselineY: 630, cells: [{ x: 72, endX: 104, text: '净利润', itemIndexes: [3] },
        { x: 300, endX: 324, text: '120', itemIndexes: [4] }, { x: 420, endX: 444, text: '180', itemIndexes: [5] }] },
      { row: 3, baselineY: 610, cells: [{ x: 72, endX: 120, text: '每股收益', itemIndexes: [6] },
        { x: 300, endX: 328, text: '1.24', itemIndexes: [7] }, { x: 420, endX: 448, text: '1.18', itemIndexes: [8] }] },
    ],
  };
  const table = buildDocumentSegments({ ...base, pages: [page] }).segments.find(segment => segment.kind === 'table');
  assert.ok(table?.table);
  assert.deepEqual(table.table.header, []);
  assert.deepEqual(table.table.period_axis, []);
  assert.equal(table.table.rows.length, 3);
  assert.equal(table.table.rows[0]!.cells[0]!.cell_ref, `${table.table.table_id}:r1c1`);
  assert.ok(table.issues.includes(SEGMENT_ISSUES.tableHeaderNotFound));
  assert.equal(table.table.header_adjacent, null);
});

test('上方相邻行作为未确认表头单独保留，不并入期间轴', () => {
  const page = {
    page: 1, pageLabel: null, width: 595, height: 842,
    items: [
      { index: 0, text: '期间', x: 72, y: 670, width: 24, height: 11, endOfLine: false },
      { index: 1, text: '2026年1-6月', x: 300, y: 670, width: 70, height: 11, endOfLine: false },
      { index: 2, text: '2025年1-6月', x: 420, y: 670, width: 70, height: 11, endOfLine: true },
      { index: 3, text: '营业收入', x: 72, y: 640, width: 40, height: 11, endOfLine: false },
      { index: 4, text: '1,200', x: 300, y: 640, width: 40, height: 11, endOfLine: false },
      { index: 5, text: '1,500', x: 420, y: 640, width: 40, height: 11, endOfLine: true },
      { index: 6, text: '净利润', x: 72, y: 620, width: 32, height: 11, endOfLine: false },
      { index: 7, text: '120', x: 300, y: 620, width: 24, height: 11, endOfLine: false },
      { index: 8, text: '180', x: 420, y: 620, width: 24, height: 11, endOfLine: true },
      { index: 9, text: '每股收益', x: 72, y: 600, width: 48, height: 11, endOfLine: false },
      { index: 10, text: '1.24', x: 300, y: 600, width: 28, height: 11, endOfLine: false },
      { index: 11, text: '1.18', x: 420, y: 600, width: 28, height: 11, endOfLine: true },
    ],
    tableCandidates: [
      { row: 1, baselineY: 670, cells: [{ x: 72, endX: 96, text: '期间', itemIndexes: [0] },
        { x: 300, endX: 370, text: '2026年1-6月', itemIndexes: [1] }, { x: 420, endX: 490, text: '2025年1-6月', itemIndexes: [2] }] },
      { row: 3, baselineY: 640, cells: [{ x: 72, endX: 112, text: '营业收入', itemIndexes: [3] },
        { x: 300, endX: 340, text: '1,200', itemIndexes: [4] }, { x: 420, endX: 460, text: '1,500', itemIndexes: [5] }] },
      { row: 4, baselineY: 620, cells: [{ x: 72, endX: 104, text: '净利润', itemIndexes: [6] },
        { x: 300, endX: 324, text: '120', itemIndexes: [7] }, { x: 420, endX: 444, text: '180', itemIndexes: [8] }] },
      { row: 5, baselineY: 600, cells: [{ x: 72, endX: 120, text: '每股收益', itemIndexes: [9] },
        { x: 300, endX: 328, text: '1.24', itemIndexes: [10] }, { x: 420, endX: 448, text: '1.18', itemIndexes: [11] }] },
    ],
  };
  const result = buildDocumentSegments({ ...base, pages: [page] });
  const table = result.segments.find(segment => segment.kind === 'table');
  assert.ok(table?.table);
  assert.deepEqual(table.table.header, []);
  assert.deepEqual(table.table.header_adjacent, ['期间', '2026年1-6月', '2025年1-6月']);
  assert.ok(table.issues.includes(SEGMENT_ISSUES.tableHeaderNotFound));
  assert.ok(table.issues.includes(SEGMENT_ISSUES.tableHeaderAdjacentUnverified));
  assert.ok(result.segments.some(segment => segment.kind === 'paragraph' && segment.text.includes('期间')));
});

test('超过 200 行的表格按行分片，表头每片重复，单元格引用跨片唯一', () => {
  const items: { index: number; text: string; x: number; y: number; width: number; height: number; endOfLine: boolean }[] = [];
  const rows: { row: number; baselineY: number; cells: { x: number; endX: number; text: string; itemIndexes: number[] }[] }[] = [];
  let index = 0;
  for (let line = 0; line < 205; line++) {
    const cells = [0, 1, 2].map(column => {
      const text = line === 0 ? ['项目', '2024', '2025'][column]! : (column === 0 ? `指标${line}` : `${1000 + line}`);
      const x = [72, 300, 420][column]!;
      const itemIndex = index++;
      items.push({ index: itemIndex, text, x, y: 800 - line * 12, width: Math.max(text.length * 8, 8), height: 11, endOfLine: column === 2 });
      return { x, endX: x + Math.max(text.length * 8, 8), text, itemIndexes: [itemIndex] };
    });
    rows.push({ row: line + 1, baselineY: 800 - line * 12, cells });
  }
  const page = { page: 1, pageLabel: null, width: 595, height: 842, items, tableCandidates: rows };
  const tables = buildDocumentSegments({ ...base, pages: [page] }).segments.filter(segment => segment.kind === 'table');
  assert.equal(tables.length, 4);
  assert.deepEqual(tables.map(segment => segment.table!.parts), [4, 4, 4, 4]);
  assert.deepEqual(tables.map(segment => segment.table!.part), [1, 2, 3, 4]);
  for (const table of tables) assert.deepEqual(table.table!.header, ['项目', '2024', '2025']);
  assert.equal(tables[1]!.table!.rows[0]!.row, 67);
  const refs = tables.flatMap(segment => segment.table!.rows.flatMap(row => row.cells.map(cell => cell.cell_ref)));
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(tables[0]!.table!.rows.reduce((total, row) => total + row.cells.length, 0), 66 * 3);
  // 每个分片的 bbox 只覆盖本片行：后面的分片 y 更小（PDF 坐标向下为负方向）。
  assert.ok(tables[1]!.bbox.y1 < tables[0]!.bbox.y0, '分片 bbox 不应包含前面分片或表头的范围');
});

test('同页插入无关内容不改变其他片段的 segment_id', () => {
  const before = buildDocumentSegments({ ...base, pages: syntheticPages() });
  const pages = syntheticPages();
  // 在页首插入一行新正文：只应改变它自己所属的那一段。
  pages[0]!.items.unshift({ index: -1, text: '新增开头一句。', x: 72, y: 820, width: 80, height: 12, endOfLine: true });
  const after = buildDocumentSegments({ ...base, pages });
  assert.equal(after.segments.length, before.segments.length);
  // 插入行与首段合并，首段 id 变化；第二段与表格 id 保持。
  assert.notEqual(after.segments[0]!.segment_id, before.segments[0]!.segment_id);
  assert.equal(after.segments[1]!.segment_id, before.segments[1]!.segment_id);
  assert.equal(after.segments[2]!.segment_id, before.segments[2]!.segment_id);
});

test('表头首格本身是年份时按无标签列处理，期间轴取整个表头', () => {
  const page = {
    page: 1, pageLabel: null, width: 595, height: 842,
    items: [
      { index: 0, text: '2026年', x: 72, y: 650, width: 40, height: 11, endOfLine: false },
      { index: 1, text: '2025年', x: 300, y: 650, width: 40, height: 11, endOfLine: false },
      { index: 2, text: '2024年', x: 420, y: 650, width: 40, height: 11, endOfLine: true },
      { index: 3, text: '1,200', x: 72, y: 630, width: 40, height: 11, endOfLine: false },
      { index: 4, text: '1,100', x: 300, y: 630, width: 40, height: 11, endOfLine: false },
      { index: 5, text: '1,000', x: 420, y: 630, width: 40, height: 11, endOfLine: true },
      { index: 6, text: '120', x: 72, y: 610, width: 24, height: 11, endOfLine: false },
      { index: 7, text: '110', x: 300, y: 610, width: 24, height: 11, endOfLine: false },
      { index: 8, text: '100', x: 420, y: 610, width: 24, height: 11, endOfLine: true },
      { index: 9, text: '12', x: 72, y: 590, width: 16, height: 11, endOfLine: false },
      { index: 10, text: '11', x: 300, y: 590, width: 16, height: 11, endOfLine: false },
      { index: 11, text: '10', x: 420, y: 590, width: 16, height: 11, endOfLine: true },
    ],
    tableCandidates: [
      { row: 1, baselineY: 650, cells: [{ x: 72, endX: 112, text: '2026年', itemIndexes: [0] },
        { x: 300, endX: 340, text: '2025年', itemIndexes: [1] }, { x: 420, endX: 460, text: '2024年', itemIndexes: [2] }] },
      { row: 2, baselineY: 630, cells: [{ x: 72, endX: 112, text: '1,200', itemIndexes: [3] },
        { x: 300, endX: 340, text: '1,100', itemIndexes: [4] }, { x: 420, endX: 460, text: '1,000', itemIndexes: [5] }] },
      { row: 3, baselineY: 610, cells: [{ x: 72, endX: 96, text: '120', itemIndexes: [6] },
        { x: 300, endX: 324, text: '110', itemIndexes: [7] }, { x: 420, endX: 444, text: '100', itemIndexes: [8] }] },
      { row: 4, baselineY: 590, cells: [{ x: 72, endX: 88, text: '12', itemIndexes: [9] },
        { x: 300, endX: 316, text: '11', itemIndexes: [10] }, { x: 420, endX: 436, text: '10', itemIndexes: [11] }] },
    ],
  };
  const table = buildDocumentSegments({ ...base, pages: [page] }).segments.find(segment => segment.kind === 'table');
  assert.ok(table?.table);
  assert.deepEqual(table.table.period_axis, ['2026年', '2025年', '2024年']);
  assert.equal(table.table.rows.every(row => row.label === null), true);
  assert.equal(table.table.rows[0]!.cells[0]!.cell_ref, `${table.table.table_id}:r2c1`);
});

test('conversion content 适配器按原字段取值，结构不符即报错', () => {
  const pages = pdfPagesFromConversion({ pages: [{ page: 1, pageLabel: null, width: 595, height: 842, text: '',
    originalItems: [{ index: 0, str: '正文', transform: [1, 0, 0, 1, 72, 700], width: 20, height: 12, hasEOL: true },
      { index: 1, str: '', transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0, hasEOL: false }],
    tableCandidates: [{ row: 1, baselineY: 600, cells: [{ x: 72, endX: 100, text: '项目', itemIndexes: [0] },
      { x: 300, endX: 340, text: '2024', itemIndexes: [0] }] }] }] });
  assert.equal(pages[0]!.items.length, 2);
  assert.equal(pages[0]!.items[0]!.text, '正文');
  assert.equal(pages[0]!.items[0]!.x, 72);
  assert.equal(pages[0]!.pageLabel, null);
  assert.equal(pages[0]!.tableCandidates.length, 1);
  assert.deepEqual(pages[0]!.tableCandidates[0]!.cells[1]!.itemIndexes, [0]);
  assert.throws(() => pdfPagesFromConversion({}), /content\.pages/u);
  assert.throws(() => pdfPagesFromConversion({ pages: [{ page: 0 }] }), /page/u);
});

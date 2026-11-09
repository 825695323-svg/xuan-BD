/** 片段生成与存储的测试夹具：合成页面几何，不冒充真实 PDF 证据。 */
import type { PdfPageInput } from './contracts.js';

interface TextLineSpec { text: string; y: number; height?: number }
interface TableRowSpec { cells: string[]; y: number }

function page(page: number, pageLabel: string | null, lines: TextLineSpec[], rows: TableRowSpec[]): PdfPageInput {
  const items: PdfPageInput['items'] = [];
  let index = 0;
  for (const line of lines) {
    items.push({ index: index++, text: line.text, x: 72, y: line.y, width: Math.max(line.text.length * 8, 8),
      height: line.height ?? 12, endOfLine: true });
  }
  const tableCandidates: PdfPageInput['tableCandidates'] = rows.map((row, rowPosition) => {
    const cells = row.cells.map((text, columnPosition) => {
      const x = [72, 300, 420][columnPosition] ?? 520;
      const itemIndex = index++;
      items.push({ index: itemIndex, text, x, y: row.y, width: Math.max(text.length * 8, 8), height: 11,
        endOfLine: columnPosition === row.cells.length - 1 });
      return { x, endX: x + Math.max(text.length * 8, 8), text, itemIndexes: [itemIndex] };
    });
    return { row: rowPosition + 1, baselineY: row.y, cells };
  });
  return { page, pageLabel, width: 595, height: 842, items, tableCandidates };
}

export function syntheticPages(): PdfPageInput[] {
  return [
    page(1, '1', [
      { text: '半导体行业研究报告', y: 800 },
      { text: '先进封装需求持续增长。', y: 780 },
      { text: '产能扩张需要资本开支支持。', y: 760 },
      { text: '估值与风险部分单独讨论。', y: 700 },
    ], [
      { cells: ['项目', '2024', '2025'], y: 650 },
      { cells: ['营业收入', '1,200', '1,500'], y: 630 },
      { cells: ['净利润', '120', '180'], y: 610 },
    ]),
    page(2, 'ii', [{ text: '第二页补充说明。', y: 800 }], []),
  ];
}

/** 只有两行的表格候选：不成立表格，应回到正文。 */
export function twoRowPages(): PdfPageInput[] {
  return [page(1, null, [{ text: '普通正文一句。', y: 800 }], [
    { cells: ['项目', '2024'], y: 650 }, { cells: ['营业收入', '1,200'], y: 630 },
  ])];
}

/** 无文字层页面：不生成片段，只记文档级缺口。 */
export function emptyTextPages(): PdfPageInput[] {
  const value = page(1, null, [], []);
  return [value];
}

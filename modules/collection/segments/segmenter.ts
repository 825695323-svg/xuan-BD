/**
 * 片段生成：把 PDF 抽取已给出的原文字项与几何表格候选，转成确定性片段。
 * 不调用模型、不做句子重排、不推断标题层级与单位。
 */
import { createHash } from 'node:crypto';
import type {
  DocSegment, PdfItemInput, PdfPageInput, PdfRowInput, SegmentBBox, SegmentBuildInput, SegmentBuildResult,
  SegmentTable, TableRow,
} from './contracts.js';
import { SEGMENT_ISSUES, SEGMENT_SCHEMA, SEGMENTER_VERSION } from './contracts.js';

const MAX_PARAGRAPH_CHARS = 4000;
const MAX_TABLE_ROWS_PER_PART = 200;
const MAX_TABLE_CELLS_PER_PART = 200;
const MIN_TABLE_ROWS = 3;
const LINE_GAP_FACTOR = 1.8;

interface Line {
  items: number[];
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  height: number;
  baseline: number;
}

interface TablePlan {
  /** 该表在页内的稳定定位：首个候选行号。 */
  firstRow: number;
  /** 表头；连续候选段首行是数据行时为 null（不伪造表头）。 */
  header: PdfRowInput | null;
  headerAdjacent: string[] | null;
  /** 表头首格本身是年份/期间：没有标签列，期间轴取整个表头，行标签为 null。 */
  headerIsPeriodFirst: boolean;
  parts: PdfRowInput[][];
  /** 属于该表格的原文字项；用于判断行归属，不用几何行号。 */
  itemIndexes: Set<number>;
  /** 完全落在该表格内的行位置（下标对应 reconstructLines 结果）。 */
  linePositions: Set<number>;
}

function sha256Hex(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

function unionBox(boxes: SegmentBBox[]): SegmentBBox {
  const present = boxes.filter(box => [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite));
  if (!present.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...present.map(box => box.x0)), y0: Math.min(...present.map(box => box.y0)),
    x1: Math.max(...present.map(box => box.x1)), y1: Math.max(...present.map(box => box.y1)),
  };
}

function segmentId(fields: {
  documentId: string; documentVersion: string; parserVersion: string; kind: string; pageNumber: number;
  anchor: unknown; textDigest: string;
}): string {
  const key = JSON.stringify([SEGMENT_SCHEMA, fields.documentId, fields.documentVersion, fields.parserVersion,
    fields.kind, fields.pageNumber, fields.anchor, fields.textDigest]);
  return `sg_${sha256Hex(key).slice(0, 24)}`;
}

/** 从 conversion payload 的 content 取页面几何；结构不符即报错，不静默补字段。 */
export function pdfPagesFromConversion(content: unknown): PdfPageInput[] {
  if (typeof content !== 'object' || content === null) throw new Error('PDF 转换内容缺失：content 不是对象。');
  const pages = (content as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) throw new Error('PDF 转换内容缺失：content.pages 不是数组。');
  return pages.map((raw, position) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`第 ${position + 1} 页结构不符。`);
    const page = raw as Record<string, unknown>;
    const pageNumber = page.page;
    if (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error(`第 ${position + 1} 页缺少合法 page。`);
    const items: PdfItemInput[] = [];
    for (const entry of Array.isArray(page.originalItems) ? page.originalItems : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.str !== 'string') continue;
      const transform = Array.isArray(item.transform) ? item.transform : [];
      const x = Number(transform[4]), y = Number(transform[5]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push({ index: typeof item.index === 'number' ? item.index : items.length, text: item.str, x, y,
        width: Number.isFinite(Number(item.width)) ? Number(item.width) : 0,
        height: Number.isFinite(Number(item.height)) ? Number(item.height) : 0,
        endOfLine: item.hasEOL === true });
    }
    const tableCandidates: PdfRowInput[] = [];
    for (const entry of Array.isArray(page.tableCandidates) ? page.tableCandidates : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const cells = (Array.isArray(row.cells) ? row.cells : []).flatMap(cell => {
        if (typeof cell !== 'object' || cell === null) return [];
        const value = cell as Record<string, unknown>;
        const x = Number(value.x), endX = Number(value.endX);
        if (!Number.isFinite(x) || !Number.isFinite(endX) || typeof value.text !== 'string') return [];
        return [{ x, endX, text: value.text, itemIndexes: (Array.isArray(value.itemIndexes) ? value.itemIndexes : []).filter(
          (index): index is number => typeof index === 'number' && Number.isSafeInteger(index)) }];
      });
      if (cells.length < 2) continue;
      tableCandidates.push({ row: typeof row.row === 'number' ? row.row : tableCandidates.length + 1,
        baselineY: Number.isFinite(Number(row.baselineY)) ? Number(row.baselineY) : 0, cells });
    }
    return { page: pageNumber, pageLabel: typeof page.pageLabel === 'string' ? page.pageLabel : null,
      width: Number.isFinite(Number(page.width)) ? Number(page.width) : 0,
      height: Number.isFinite(Number(page.height)) ? Number(page.height) : 0, items, tableCandidates };
  });
}

/** 按原文字项顺序重建行；与 page.text 的换行逻辑同源，不做几何重排。 */
function reconstructLines(page: PdfPageInput): Line[] {
  const items = [...page.items].sort((left, right) => left.index - right.index);
  const lines: Line[] = [];
  let current: Line | null = null;
  const close = () => {
    if (!current) return;
    current.text = current.text.trim();
    lines.push(current);
    current = null;
  };
  for (const item of items) {
    if (!current) current = { items: [], text: '', x0: item.x, y0: item.y, x1: item.x + item.width,
      y1: item.y + item.height, height: item.height, baseline: item.y };
    current.items.push(item.index);
    current.text += item.text;
    current.x0 = Math.min(current.x0, item.x);
    current.x1 = Math.max(current.x1, item.x + item.width);
    current.y0 = Math.min(current.y0, item.y);
    current.y1 = Math.max(current.y1, item.y + item.height);
    current.height = Math.max(current.height, item.height);
    current.baseline = item.y;
    if (item.endOfLine) close();
  }
  close();
  return lines;
}

const YEAR_LABEL = /^(?:19|20)\d{2}(?:年)?$/u;
const PERIOD_LABEL = /^(?:\d{1,2}月(?:\d{1,2}日)?|\d{1,2}-\d{1,2}月|本期|上年同期|期末|期初|年初|上年末|增减|本期同比.*|期末较上年末)$/u;

/** 数值单元格（含千分位、小数、百分号、括号负数、缺数符号）；年份与期间标签不算数值。 */
function numericValue(text: string): boolean {
  const value = text.trim().replace(/[\s,，]/gu, '');
  if (!value || YEAR_LABEL.test(value) || PERIOD_LABEL.test(value)) return false;
  if (/^[-—–]$/u.test(value)) return true;
  return /^[（(]?[-+]?(?:\d+(?:\.\d*)?|\.\d+)[%％]?[)）]?$/u.test(value);
}

/** 年份/期间标签：用于识别「无标签列」的表头（首格本身是期间）。 */
function isPeriodLabel(text: string): boolean {
  const value = text.trim().replace(/[\s,，]/gu, '');
  return value.length > 0 && (YEAR_LABEL.test(value) || PERIOD_LABEL.test(value));
}

/** 首列之外的过半单元格为数值，才判为数据行；否则视为表头候选。 */
function dataLikeRow(row: PdfRowInput): boolean {
  const cells = row.cells.slice(1).map(cell => cell.text.trim()).filter(Boolean);
  if (!cells.length) return false;
  return cells.filter(numericValue).length * 2 >= cells.length;
}

function splitTableParts(rows: PdfRowInput[]): PdfRowInput[][] {
  const parts: PdfRowInput[][] = [];
  let current: PdfRowInput[] = [];
  const cellsOf = (list: PdfRowInput[]) => list.reduce((total, row) => total + row.cells.length, 0);
  for (const row of rows) {
    if (current.length && (current.length >= MAX_TABLE_ROWS_PER_PART || cellsOf([...current, row]) > MAX_TABLE_CELLS_PER_PART)) {
      parts.push(current); current = [row]; continue;
    }
    current.push(row);
  }
  if (current.length) parts.push(current);
  return parts;
}

/** 连续 ≥3 行、每行 ≥2 格、首格 x 对齐，才成立表格；否则那些行回到正文。 */
function findTablePlans(page: PdfPageInput, lines: Line[], tolerance: number): { plans: TablePlan[]; overlapped: Set<number> } {
  // 空白字项（列间空隙）不属于任何单元格，但不构成表外内容：判定行归属时忽略。
  const blankItems = new Set(page.items.filter(item => item.text.trim().length === 0).map(item => item.index));
  const candidates = [...page.tableCandidates].sort((left, right) => left.row - right.row);
  const groups: PdfRowInput[][] = [];
  let group: PdfRowInput[] = [];
  for (const row of candidates) {
    const previous = group.at(-1);
    if (!previous) { group = [row]; continue; }
    const aligned = Math.abs(row.cells[0]!.x - previous.cells[0]!.x) <= tolerance;
    if (row.row === previous.row + 1 && aligned) group.push(row); else { groups.push(group); group = [row]; }
  }
  if (group.length) groups.push(group);

  const plans: TablePlan[] = [];
  for (const rows of groups) {
    if (rows.length < MIN_TABLE_ROWS) continue;
    const first = rows[0]!;
    const header = dataLikeRow(first) ? null : first;
    const headerIsPeriodFirst = header !== null && isPeriodLabel(first.cells[0]?.text ?? '');
    const dataRows = header ? rows.slice(1) : rows;
    if (!dataRows.length) continue;
    // 上方相邻候选行（跨行表头的另一半）：只记录不合并，避免伪造期间轴。
    const above = candidates.filter(row => row.row < first.row && row.cells.length === first.cells.length
      && row.baselineY > first.baselineY && row.baselineY - first.baselineY <= 3 * tolerance).at(-1);
    // 仅当本段没有表头时，才把上方相邻候选行作为“未确认表头另一半”记下。
    const headerAdjacent = !header && above && !dataLikeRow(above) ? above.cells.map(cell => cell.text.trim()) : null;
    const itemIndexes = new Set<number>();
    for (const row of rows) for (const cell of row.cells) for (const index of cell.itemIndexes) itemIndexes.add(index);
    plans.push({
      firstRow: first.row, header, headerAdjacent, headerIsPeriodFirst, parts: splitTableParts(dataRows), itemIndexes,
      linePositions: new Set(lines.flatMap((line, position) =>
        line.items.length > 0 && line.items.every(index => itemIndexes.has(index) || blankItems.has(index)) ? [position] : [])),
    });
  }
  const overlapped = new Set<number>();
  for (const plan of plans) {
    lines.forEach((line, position) => {
      if (plan.linePositions.has(position)) return;
      if (line.items.some(index => plan.itemIndexes.has(index) && !blankItems.has(index))) overlapped.add(position);
    });
  }
  return { plans, overlapped };
}

function renderTable(plan: TablePlan, rows: PdfRowInput[], tableId: string, part: number, parts: number,
  lineHeight: number, rowOffset: number): { text: string; table: SegmentTable; bbox: SegmentBBox } {
  // 行号跨分片连续（不按片重置），否则同一表格不同分片会出现相同的 cell_ref。
  const hasLabelColumn = !plan.headerIsPeriodFirst;
  const rowsOut: TableRow[] = rows.map((row, rowPosition) => ({
    row: rowOffset + rowPosition + 1,
    label: hasLabelColumn && row.cells[0] ? row.cells[0].text.trim() || null : null,
    cells: row.cells.map((cell, columnPosition) => ({
      cell_ref: `${tableId}:r${rowOffset + rowPosition + (plan.header ? 2 : 1)}c${columnPosition + 1}`,
      text: cell.text.trim(), x0: cell.x, x1: cell.endX,
    })),
  }));
  const headerTexts = plan.header ? plan.header.cells.map(cell => cell.text.trim()) : [];
  const text = [...(plan.header ? [headerTexts.join(' | ')] : []),
    ...rowsOut.map(row => row.cells.map(cell => cell.text).join(' | '))].join('\n');
  const boxes: SegmentBBox[] = [...(part === 1 && plan.header ? [plan.header] : []), ...rows].map(row => ({
    x0: Math.min(...row.cells.map(cell => cell.x)),
    y0: row.baselineY - lineHeight / 2,
    x1: Math.max(...row.cells.map(cell => cell.endX)),
    y1: row.baselineY + lineHeight / 2,
  }));
  return {
    text, bbox: unionBox(boxes),
    table: {
      table_id: tableId, part, parts, header: headerTexts,
      period_axis: plan.headerIsPeriodFirst ? headerTexts : headerTexts.slice(1),
      rows: rowsOut, row_count: rowsOut.length,
      cell_count: headerTexts.length + rowsOut.reduce((total, row) => total + row.cells.length, 0),
      verification: 'unverified-geometry', unit: null, header_adjacent: plan.headerAdjacent,
    },
  };
}

export function buildDocumentSegments(input: SegmentBuildInput): SegmentBuildResult {
  const parserVersion = input.parserVersion ?? SEGMENTER_VERSION;
  const segments: DocSegment[] = [];
  const documentIssues: SegmentBuildResult['documentIssues'] = [];
  let ordinal = 0;

  for (const page of input.pages) {
    const lines = reconstructLines(page);
    if (!lines.some(line => line.text.length)) {
      documentIssues.push({ code: SEGMENT_ISSUES.pageTextLayerIncomplete, page: page.page, detail: '本页无可提取原文字层，未调用 OCR。' });
      continue;
    }
    const lineHeight = median(lines.map(line => line.height).filter(height => height > 0));
    const tolerance = Math.max(6, lineHeight);
    const { plans, overlapped } = findTablePlans(page, lines, tolerance);
    const planByLine = new Map<number, TablePlan>();
    for (const plan of plans) for (const position of plan.linePositions) planByLine.set(position, plan);

    const consumed = new Set<TablePlan>();
    let paragraph: Line[] = [];
    // 页内「同类型同摘要」的出现序号：身份只依赖内容与页，不依赖字项序号，
    // 同页插入无关内容不会改变其他片段的 segment_id。
    const occurrences = new Map<string, number>();
    const nextOccurrence = (kind: string, digest: string) => {
      const key = `${kind}:${digest}`;
      const value = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, value);
      return value;
    };
    const pushSegment = (segment: DocSegment) => { ordinal += 1; segments.push({ ...segment, ordinal }); };
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const first = paragraph[0]!, last = paragraph[paragraph.length - 1]!;
      const text = paragraph.map(line => line.text).join('\n');
      const digest = sha256Hex(text);
      const issues: string[] = [SEGMENT_ISSUES.sectionUnavailable];
      // 页码、编号等孤立短行保留原样，只标候选，供检索侧按需降权；不删除内容。
      if (paragraph.length === 1 && text.length <= 3 && !/[\u3400-\u4DBF\u4E00-\u9FFF]/u.test(text)) issues.push(SEGMENT_ISSUES.isolatedShortLine);
      pushSegment({
        segment_id: segmentId({ documentId: input.documentId, documentVersion: input.documentVersion, parserVersion,
          kind: 'paragraph', pageNumber: page.page, anchor: { occurrence: nextOccurrence('paragraph', digest) }, textDigest: digest }),
        document_id: input.documentId, document_version: input.documentVersion, parser_version: parserVersion,
        ordinal: 0, kind: 'paragraph', page_number: page.page, page_label: page.pageLabel, section_path: [],
        bbox: unionBox(paragraph.map(line => ({ x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 }))),
        table: null, source_ref: input.sourceRef, text, text_digest: digest, char_start: 0, char_end: 0,
        issues,
      });
      paragraph = [];
    };

    lines.forEach((line, position) => {
      const plan = planByLine.get(position);
      if (!plan) {
        if (!line.text.length) { flushParagraph(); return; }
        const previous = paragraph.at(-1);
        const tooFar = previous ? previous.baseline - line.baseline > LINE_GAP_FACTOR * Math.max(lineHeight, 1) : false;
        const tooLong = [...paragraph, line].reduce((total, entry) => total + entry.text.length + 1, 0) > MAX_PARAGRAPH_CHARS;
        if (previous && (tooFar || tooLong)) flushParagraph();
        paragraph.push(line);
        return;
      }
      flushParagraph();
      if (consumed.has(plan)) return;
      consumed.add(plan);
      const tableId = `${input.documentId}#p${page.page}-t${plan.firstRow}`;
      const baseIssues = [SEGMENT_ISSUES.tableGeometryUnverified, SEGMENT_ISSUES.tableUnitNotExtracted,
        ...(overlapped.size ? [SEGMENT_ISSUES.tableLineOverlap] : []),
        ...(plan.header ? [] : [SEGMENT_ISSUES.tableHeaderNotFound]),
        ...(plan.headerAdjacent ? [SEGMENT_ISSUES.tableHeaderAdjacentUnverified] : [])];
      plan.parts.forEach((rows, partPosition) => {
        const rowOffset = plan.parts.slice(0, partPosition).reduce((total, previous) => total + previous.length, 0);
        const rendered = renderTable(plan, rows, tableId, partPosition + 1, plan.parts.length, lineHeight, rowOffset);
        const digest = sha256Hex(rendered.text);
        pushSegment({
          segment_id: segmentId({ documentId: input.documentId, documentVersion: input.documentVersion, parserVersion,
            kind: 'table', pageNumber: page.page,
            anchor: { table_id: tableId, part: partPosition + 1, occurrence: nextOccurrence('table', digest) },
            textDigest: digest }),
          document_id: input.documentId, document_version: input.documentVersion, parser_version: parserVersion,
          ordinal: 0, kind: 'table', page_number: page.page, page_label: page.pageLabel, section_path: [],
          bbox: rendered.bbox, table: rendered.table, source_ref: input.sourceRef,
          text: rendered.text, text_digest: digest, char_start: 0, char_end: 0, issues: [...baseIssues],
        });
      });
    });
    flushParagraph();
  }

  // 相邻两页首尾都是表格时提示跨页续表，但不合并。
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1]!, current = segments[index]!;
    if (previous.kind === 'table' && current.kind === 'table' && current.page_number === previous.page_number + 1) {
      if (!previous.issues.includes(SEGMENT_ISSUES.tableContinuedSuspected)) previous.issues.push(SEGMENT_ISSUES.tableContinuedSuspected);
      if (!current.issues.includes(SEGMENT_ISSUES.tableContinuedSuspected)) current.issues.push(SEGMENT_ISSUES.tableContinuedSuspected);
    }
  }

  let cursor = 0;
  for (const segment of segments) {
    segment.char_start = cursor;
    segment.char_end = cursor + segment.text.length;
    cursor = segment.char_end + 1;
  }
  return { segments, fullText: segments.map(segment => segment.text).join('\n'), documentIssues };
}

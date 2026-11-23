import { isWfdRecord, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { attr, parseXml, xmlNodes } from '../../../platform/capabilities/conversion/formats.js';
import type { DocSegment, SegmentBuildResult, SegmentTable, TableRow } from './contracts.js';
import { SEGMENT_ISSUES, SEGMENTER_VERSION } from './contracts.js';
import type { ConversionArtifactEnvelope, SegmentSourceRef } from './from-conversion.js';
import { nativeSegment } from './native-segment.js';
import { finishSegments, splitTableParts } from './segmenter.js';

function invalid(): never { throw new Error('Office 原生节点、部件或页序不完整，无法生成可回放片段。'); }
function nodes(value: unknown): WfdRecord[] {
  if (!Array.isArray(value) || !value.every(isWfdRecord)) return invalid();
  return value;
}
function partName(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:word|ppt)\/.+\.xml$/u.test(value)
    || /[\\:\u0000-\u001f]/u.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) return invalid();
  return value;
}
function children(node: WfdRecord): WfdRecord[] {
  return nodes(node.children ?? node.blocks ?? []);
}
function descendants(parent: WfdRecord, type: 'row' | 'cell' | 'table', level = 0): WfdRecord[] {
  if (level > 128) return invalid();
  return children(parent).flatMap(child => {
    if (child.type === type) return [child];
    if (child.type === 'table' || child.type === 'deletion' || child.type === 'native-object') return [];
    return descendants(child, type, level + 1);
  });
}

function outline(value: unknown): number | undefined {
  return typeof value === 'string' && /^[0-9]$/u.test(value) ? Number(value)
    : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9 ? value : undefined;
}
/** 样式继承只取原生 outlineLvl；不从样式名或视觉字号猜标题。 */
function styleLevels(content: WfdRecord) {
  const styles = new Map<string, { level?: number; parent?: string }>();
  const part = Array.isArray(content.originalParts) && content.originalParts.find(p => isWfdRecord(p) && p.path === 'word/styles.xml');
  if (part && typeof part.xml === 'string') {
    for (const node of xmlNodes(parseXml(part.xml), 'style')) {
      const id = attr(node, 'styleId'), properties = xmlNodes(node, 'pPr')[0];
      if (!id || attr(node, 'type') !== 'paragraph') continue;
      const level = properties && xmlNodes(properties, 'outlineLvl')[0], parent = xmlNodes(node, 'basedOn')[0];
      styles.set(id, { level: level ? outline(attr(level, 'val')) : undefined, parent: parent ? attr(parent, 'val') ?? undefined : undefined });
    }
  }
  return (id: unknown) => {
    const seen = new Set<string>();
    while (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      const style = styles.get(id);
      if (!style || style.level !== undefined) return style?.level;
      id = style.parent;
    }
    return undefined;
  };
}

function nodeText(node: WfdRecord, depth = 0): string {
  if (depth > 128) return invalid();
  if (['native-object', 'deleted-text', 'deletion', 'table'].includes(String(node.type))) return '';
  if (['text', 'break', 'tab'].includes(String(node.type))) return typeof node.text === 'string' ? node.text : invalid();
  return children(node).map(child => nodeText(child, depth + 1)).join('') + (node.type === 'paragraph' ? '\n' : '');
}

export function segmentsFromOffice(envelope: ConversionArtifactEnvelope, content: WfdRecord, native: WfdRecord, ref: SegmentSourceRef) {
  const word = native.format === 'docx', slides = word ? [] : nodes(native.slides);
  const parserVersion = `${SEGMENTER_VERSION}+${native.format}-native-1` + (envelope.implementation?.version ? '+' + envelope.implementation.version : '');
  const segments: DocSegment[] = [], documentIssues: SegmentBuildResult['documentIssues'] = [];
  const issueMap = new Map<string, Set<string>>();
  const addIssue = (key: string, code: string) => {
    const set = issueMap.get(key) ?? new Set<string>(); set.add(code); issueMap.set(key, set);
  };
  const partPages = new Map<string, number>();
  const anchors = new Set<string>();
  slides.forEach((slide, index) => {
    const numbers = [slide.slide, slide.slideNumber, slide.page].filter(value => value !== undefined);
    const part = partName(slide.part);
    if (!numbers.length || numbers.some(n => n !== index + 1) || partPages.has(part)) return invalid();
    partPages.set(part, index + 1);
    for (const note of nodes(slide.notes ?? [])) partPages.set(partName(note.part), index + 1);
  });
  for (const issue of envelope.issues) {
    const loc = isWfdRecord(issue.location) ? issue.location : {};
    const part = typeof loc.part === 'string' ? loc.part : '', path = typeof loc.path === 'string' ? loc.path : '';
    const code = 'conversion_issue:' + issue.code;
    documentIssues.push({ code, page: partPages.get(part) ?? null, detail: [part, path, issue.message].filter(Boolean).join(' ') });
    if (!path) addIssue(part, code);
    for (let prefix = path; prefix.includes('/'); prefix = prefix.slice(0, prefix.lastIndexOf('/')))
      addIssue(part + '#' + prefix, code);
  }
  const levelOf = word ? styleLevels(content) : () => undefined;
  let tableNumber = 0;
  function visitRoot(blocks: unknown, part: string, page: number | null, prefix: string[]) {
    const headings = new Map<number, string>();
    const section = () => [...prefix, ...headings.values()];
    const start = segments.length;
    function visit(node: WfdRecord, depth: number) {
      if (depth > 128) return invalid();
      const loc = isWfdRecord(node.location) ? node.location : {};
      const path = loc.path;
      const append = (text: string, table: SegmentTable | null, extra: string[] = []) => {
        if (loc.part !== part || typeof path !== 'string' || !path) return invalid();
        const anchor = JSON.stringify([part, page, path, table?.part ?? 0]);
        if (anchors.has(anchor)) return invalid();
        anchors.add(anchor);
        const sections = section();
        const issues = [...new Set([...(word ? ['office_pagination_unavailable'] : []), 'office_bbox_unavailable',
          ...(sections.length ? [] : [SEGMENT_ISSUES.sectionUnavailable]),
          ...(issueMap.get(part) ?? []), ...(issueMap.get(part + '#' + path) ?? []), ...extra])];
        segments.push(nativeSegment(ref, parserVersion, segments.length + 1, [part, path, table?.part ?? 0],
          { page_number: page, page_label: page === null ? null : String(page), section_path: sections, bbox: null, text, table, issues }));
      };
      if (node.type === 'paragraph') {
        const text = nodeText(node).slice(0, -1);
        if (!text.trim()) return;
        const props = isWfdRecord(node.properties) ? node.properties : {};
        const level = outline(props.outlineLevel) ?? levelOf(props.style);
        if (word && level !== undefined && level < 9) {
          for (const previous of headings.keys()) if (previous >= level) headings.delete(previous);
          headings.set(level, text);
        }
        append(text, null);
      } else if (node.type === 'table') {
        const tableId = `${ref.documentId}#t${++tableNumber}`;
        const rows: TableRow[] = [], nested: WfdRecord[] = [];
        for (const [i, row] of descendants(node, 'row').entries()) {
          let column = 1;
          const cells = descendants(row, 'cell').map(cell => {
            for (const inner of descendants(cell, 'table')) nested.push(inner);
            const coordinate = `${tableId}:r${i + 1}c${column}`;
            // Word omits covered grid cells. DrawingML keeps one tc per grid column (including hMerge).
            const span = word && cell.gridSpan != null ? Number(cell.gridSpan) : 1;
            if (!Number.isSafeInteger(span) || span < 1 || !Number.isSafeInteger(column + span)) return invalid();
            column += span;
            return { cell_ref: coordinate, text: nodeText(cell).replace(/\n$/u, ''), x0: null, x1: null };
          });
          rows.push({ row: i + 1, label: null, cells });
        }
        const parts = splitTableParts(rows);
        for (const [i, group] of parts.entries()) {
          if (!group.some(row => row.cells.some(cell => cell.text.trim()))) continue;
          append(group.map(row => row.cells.map(cell => cell.text).join(' | ')).join('\n'), {
            table_id: tableId, part: i + 1, parts: parts.length, rows: group, row_count: group.length,
            cell_count: group.reduce((n, row) => n + row.cells.length, 0), header: [], period_axis: [],
            header_adjacent: null, verification: 'native-structure', unit: null,
          }, [SEGMENT_ISSUES.tableHeaderNotFound, SEGMENT_ISSUES.tableUnitNotExtracted]);
        }
        for (const inner of nested) visit(inner, depth + 1);
      } else if (node.type !== 'native-object' && node.type !== 'deletion') {
        for (const child of children(node)) visit(child, depth + 1);
      }
    }
    for (const block of nodes(blocks)) visit(block, 0);
    if (segments.length === start) documentIssues.push({ code: 'office_no_native_text', page, detail: part });
  }
  if (word) {
    documentIssues.push({ code: 'office_pagination_unavailable', page: null });
    visitRoot(native.blocks, 'word/document.xml', null, []);
    for (const extra of nodes(native.supplements ?? [])) {
      const part = partName(extra.part); visitRoot(extra.blocks, part, null, [part]);
    }
  } else {
    for (const slide of slides) {
      const part = partName(slide.part), page = partPages.get(part)!;
      visitRoot(slide.blocks, part, page, [part]);
      for (const note of nodes(slide.notes ?? [])) {
        const notePart = partName(note.part); visitRoot(note.blocks, notePart, page, [part, notePart]);
      }
    }
  }
  if (!segments.length) throw new Error('Office 文档没有可用原生正文或表格文本。' + documentIssues.map(issue => issue.code).join(','));
  return { ...finishSegments(segments, documentIssues), pageCount: word ? null : slides.length };
}

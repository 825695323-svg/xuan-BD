import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ConversionPayload, ConversionIssue } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError } from '../../runtime/file-workspace.js';

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
export async function openPdf(bytes: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false,
    stopAtErrors: true, disableAutoFetch: true, disableStream: true, useWorkerFetch: false, maxImageSize: 24_000_000,
    cMapUrl: join(pdfRoot, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
    wasmUrl: join(pdfRoot, 'wasm') + '/', enableXfa: false });
}
function safeJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array ? { byteLength: item.byteLength } : item)) as JsonValue; }
export async function pdfNative(bytes: Buffer, signal: AbortSignal): Promise<ConversionPayload> {
  const loading = await openPdf(bytes), document = await loading.promise;
  const issues: ConversionIssue[] = [], pages: JsonValue[] = []; let totalItems = 0, outputText = '';
  try {
    if (document.numPages > 300) throw new DirectError('PDF_PAGE_LIMIT', 'PDF 页数超过本次 300 页预算。');
    const labels = await document.getPageLabels();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      let content: Awaited<ReturnType<typeof page.getTextContent>>;
      try { content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true }); }
      catch (error) {
        if (signal.aborted) throw error;
        const reason = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        issues.push({ code: 'PDF_TEXT_EXTRACT_FAILED', message: `此页原文字层解析失败（pdfjs-dist：${reason}）；未生成文字或推测结构，其余页面继续按原生文字项处理。`, location: { page: pageNumber } });
        outputText += pageNumber > 1 ? '\f' : '';
        pages.push({ page: pageNumber, pageLabel: labels?.[pageNumber - 1] ?? null, width: viewport.width, height: viewport.height,
          rotation: page.rotate, coordinateSystem: 'PDF-user-space/origin-native/transform-retained', originalView: safeJson(page.view),
          extraction: { status: 'failed', code: 'PDF_TEXT_EXTRACT_FAILED' }, originalItems: [],
          readingOrder: { basis: 'unavailable', structureTree: null, nativeItemIndexes: [], geometricCandidateItemIndexes: [] },
          tableCandidates: [], footnoteCandidates: [], links: [], styles: {}, text: '' });
        page.cleanup();
        continue;
      }
      if ((totalItems += content.items.length) > 200_000) throw new DirectError('PDF_TEXT_LIMIT', 'PDF 原文字项超过本次预算。');
      const items = content.items.map((item, index) => ({ index, ...safeJson(item) as Record<string, JsonValue> }));
      const textItems = content.items.flatMap((item, index) => 'str' in item ? [{ index, text: item.str, x: item.transform[4]!, y: item.transform[5]!, width: item.width, height: item.height, endOfLine: item.hasEOL }] : []);
      const tags = await page.getStructTree();
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (annotations.length > 10_000) throw new DirectError('PDF_ANNOTATION_LIMIT', 'PDF 页注释超过本次预算。');
      const links = annotations.filter(annotation => annotation.subtype === 'Link').map(annotation => ({
        target: annotation.unsafeUrl ?? annotation.url ?? null, resolvedUrl: annotation.url ?? null, destination: safeJson(annotation.dest ?? null), rect: safeJson(annotation.rect ?? null),
        newWindow: annotation.newWindow ?? null, annotationId: annotation.id ?? null,
      }));
      const sorted = [...textItems].sort((left, right) => Math.abs(right.y - left.y) > Math.max(1, Math.min(left.height, right.height) * 0.3) ? right.y - left.y : left.x - right.x);
      const lines: typeof sorted[] = [];
      for (const item of sorted) {
        const last = lines.at(-1);
        if (last && Math.abs(last[0]!.y - item.y) <= Math.max(1, item.height * 0.3)) last.push(item); else lines.push([item]);
      }
      const rows = lines.map((line, index) => {
        const cells: { x: number; endX: number; text: string; itemIndexes: number[] }[] = [];
        const gapItemIndexes: number[] = [];
        for (const item of line) {
          // PDF.js 可能把跨列空隙表示成零字高宽空格；候选结构单列引用这些项，不改原文字项。
          if (!item.text || /^\s+$/u.test(item.text) && item.width > Math.max(6, item.height)) { gapItemIndexes.push(item.index); continue; }
          const previous = cells.at(-1);
          if (previous && item.x - previous.endX <= Math.max(6, item.height)) { previous.text += item.text; previous.endX = Math.max(previous.endX, item.x + item.width); previous.itemIndexes.push(item.index); }
          else cells.push({ x: item.x, endX: item.x + item.width, text: item.text, itemIndexes: [item.index] });
        }
        return { row: index + 1, baselineY: line[0]?.y ?? 0, cells, gapItemIndexes };
      });
      const tableCandidates = rows.filter(row => row.cells.length > 1).map(row => ({ ...row, inferred: true, verification: 'unverified-geometric-candidate' }));
      const heights = textItems.map(item => item.height).filter(height => height > 0).sort((left, right) => left - right);
      const median = heights[Math.floor(heights.length / 2)] ?? 0;
      const footnoteCandidates = textItems.filter(item => item.text.length > 0 && item.height > 0 && item.y < page.view[1]! + (page.view[3]! - page.view[1]!) * 0.2 && item.height < median * 0.85)
        .map(item => ({ itemIndex: item.index, inferred: true, verification: 'unverified-geometric-candidate' }));
      if (!tags) issues.push({ code: 'PDF_READING_ORDER_UNVERIFIED', message: '此页没有可用原生标签树；几何顺序、表格行列及脚注候选未经语义确认，原文字项与坐标保留。', location: { page: pageNumber } });
      if (!textItems.some(item => item.text.length)) issues.push({ code: 'PDF_NO_TEXT_LAYER', message: '此页没有可提取的原文字层；未自动调用 OCR。', location: { page: pageNumber } });
      if (tableCandidates.length || footnoteCandidates.length) issues.push({ code: 'PDF_GEOMETRIC_CANDIDATES', message: '几何表格或脚注只作为候选；标签树及原文字项才是原生证据。', location: { page: pageNumber } });
      const pageText = textItems.map(item => item.text + (item.endOfLine ? '\n' : '')).join('');
      outputText += (pageNumber > 1 ? '\f' : '') + pageText;
      pages.push({ page: pageNumber, pageLabel: labels?.[pageNumber - 1] ?? null, width: viewport.width, height: viewport.height, rotation: page.rotate,
        coordinateSystem: 'PDF-user-space/origin-native/transform-retained', originalView: safeJson(page.view), originalItems: items,
        readingOrder: { basis: tags ? 'native-structure-tree' : 'unverified-geometry', structureTree: tags ? safeJson(tags) : null,
          nativeItemIndexes: textItems.map(item => item.index), geometricCandidateItemIndexes: sorted.map(item => item.index) },
        tableCandidates, footnoteCandidates, links, styles: safeJson(content.styles), text: pageText });
      page.cleanup();
    }
    return { status: issues.length ? 'partial' : 'complete', issues, text: outputText, content: { format: 'pdf', pageCount: document.numPages,
      implementation: { pdfjs: '6.4.299', normalization: 'disabled' }, pages } };
  } finally { await loading.destroy(); }
}

export function selectedPages(value: string, count?: number): number[] {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) throw new DirectError('PDF_PAGE_SELECTION_INVALID', '页码需显式写为 1,3-5，最多 20 页。');
  const pages = new Set<number>();
  for (const token of value.split(',')) {
    const [first, last = first] = token.split('-').map(Number);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first! < 1 || last! < first! || last! - first! > 19 || count !== undefined && last! > count) throw new DirectError('PDF_PAGE_SELECTION_INVALID', '所选页码超限或不在原件内。');
    for (let page = first!; page <= last!; page++) pages.add(page);
    if (pages.size > 20) throw new DirectError('PDF_PAGE_LIMIT', '一次按页渲染最多 20 页。');
  }
  return [...pages];
}
export async function renderPdf(bytes: Buffer, selection: string, scale: number, signal: AbortSignal): Promise<{ payload: ConversionPayload; binaries: { name: string; bytes: Buffer; location: JsonValue }[] }> {
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 3) throw new DirectError('PDF_SCALE_INVALID', 'PDF 渲染比例需在 0.25 到 3 之间。');
  const { createCanvas } = await import('@napi-rs/canvas'), loading = await openPdf(bytes), document = await loading.promise;
  const binaries: { name: string; bytes: Buffer; location: JsonValue }[] = [];
  let totalPixels = 0, totalBytes = 0;
  try {
    for (const pageNumber of selectedPages(selection, document.numPages)) {
      signal.throwIfAborted(); const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      if (width * height > 24_000_000 || (totalPixels += width * height) > 80_000_000) throw new DirectError('PDF_PIXEL_LIMIT', '所选页面超过本次像素预算，请缩小比例或减少页面。');
      const canvas = createCanvas(width, height), context = canvas.getContext('2d');
      const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport });
      const abort = () => task.cancel(); signal.addEventListener('abort', abort, { once: true });
      try { await task.promise; } finally { signal.removeEventListener('abort', abort); }
      const output = await canvas.encode('png');
      if ((totalBytes += output.length) > 64_000_000) throw new DirectError('PDF_RENDER_BYTES_LIMIT', '按页渲染产物超过本次大小预算。');
      binaries.push({ name: `page-${pageNumber}.png`, bytes: output, location: { page: pageNumber, width, height, scale, rotation: page.rotate } });
      page.cleanup();
    }
    return { payload: { status: 'complete', issues: [], content: { format: 'pdf-page-images', originalPageCount: document.numPages,
      pages: binaries.map(value => ({ name: value.name, location: value.location })) } }, binaries };
  } finally { await loading.destroy(); }
}
/** PDF.js 公共接口没有单附件解码前字节上限；只读目录，不调用内容解码器。 */
export async function pdfAttachments(bytes: Buffer): Promise<{ path: string; filename: string; rawFilename: string; description: string; bytes: null; extractionAvailable: false }[]> {
  const loading = await openPdf(bytes), document = await loading.promise;
  try {
    const attachments = await document.getAttachments(), entries = attachments ? Array.from(attachments.entries()) : [];
    if (entries.length > 2048) throw new DirectError('PDF_ATTACHMENT_LIMIT', 'PDF 附件数量超出本次预算。');
    return entries.map(([key, attachment]) => ({ path: key, filename: attachment.filename, rawFilename: attachment.rawFilename,
      description: attachment.description, bytes: null, extractionAvailable: false }));
  } finally { await loading.destroy(); }
}

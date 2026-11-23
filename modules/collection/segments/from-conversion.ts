/** 只消费固定的原生转换信封或 OCR 核对包。执行权限、任务和字节核对由宿主管理。 */
import type { SegmentBuildResult } from './contracts.js';
import { isWfdRecord } from '../../../adapters/database/wfd-transport.js';
import { segmentsFromOffice } from './from-office.js';
import { segmentsFromOcrPacket } from './from-ocr.js';
import { OCR_PACKET_SCHEMA, SEGMENT_ISSUES, SEGMENTER_VERSION } from './contracts.js';
import { buildDocumentSegments, pdfPagesFromConversion } from './segmenter.js';

/** 产物中的转换信封（与 ConversionEnvelope 同形，只取生成片段所需字段）。 */
export interface ConversionArtifactEnvelope {
  operation?: string;
  status: 'complete' | 'partial' | 'failed';
  issues: { code: string; message?: string; location?: unknown }[];
  content: unknown;
  text?: string;
  implementation?: { name?: string; version?: string; pdfjs?: string };
  source?: { detectedType?: string; sha256?: string; declaredName?: string; fileRefId?: string; fileRefVersion?: number };
}

export interface SegmentSourceRef {
  /** 已登记产物的 fileRefId 或绑定任务和摘要的 OCR 核对包引用。 */
  artifactRef: string;
  /** 原件身份：4.3 保管材料 id，不用文件名。 */
  documentId: string;
  documentVersion: string;
}

/** 转换缺口 → 片段缺口：只映射有确定语义的几种，其余原样带出，不猜测后果。 */
const CONVERSION_ISSUE_MAP: Record<string, string> = {
  PDF_NO_TEXT_LAYER: SEGMENT_ISSUES.pageTextLayerIncomplete,
  PDF_TEXT_EXTRACT_FAILED: SEGMENT_ISSUES.pageTextLayerIncomplete,
  PDF_GEOMETRIC_CANDIDATES: SEGMENT_ISSUES.tableGeometryUnverified,
  PDF_READING_ORDER_UNVERIFIED: 'reading_order_unverified',
};

export function segmentsFromConversionArtifact(value: unknown, ref: SegmentSourceRef): SegmentBuildResult & { pageCount: number | null } {
  if (!ref.artifactRef.trim()) throw new Error('缺少产物引用：片段化必须指向已登记的转换产物。');
  if (!ref.documentId.trim()) throw new Error('缺少原件身份 documentId。');
  if (!ref.documentVersion.trim()) throw new Error('缺少原件版本 documentVersion。');
  if (!isWfdRecord(value)) throw new Error('片段化需要登记产物的 JSON 对象。');
  if (value.schema === OCR_PACKET_SCHEMA) return segmentsFromOcrPacket(value, ref);
  const envelope = value as unknown as ConversionArtifactEnvelope;
  const content = isWfdRecord(envelope.content) ? envelope.content : {};
  const native = isWfdRecord(content.native) ? content.native : {};
  const formats = [envelope.source?.detectedType, content.format, native.format].filter(v => v !== undefined);
  if (envelope.operation === 'conversion.structured' || formats.includes('xlsx'))
    throw new Error('结构化表产物须走结构化表登记路线，不能进入文档片段库。');
  if (!['complete', 'partial', 'failed'].includes(envelope.status) || !Array.isArray(envelope.issues))
    throw new Error('转换状态或缺口清单不完整。');
  if (envelope.status === 'failed') {
    throw new Error(`转换产物状态为 failed，不能生成片段：${(envelope.issues ?? []).map(issue => issue.code).join(',') || '无缺口码'}`);
  }
  if (envelope.operation !== undefined && !['conversion.document', 'pdf.extract'].includes(envelope.operation))
    throw new Error('该转换操作未登记为文档片段来源。');
  if (envelope.operation === 'pdf.extract' && formats.some(format => format !== 'pdf'))
    throw new Error('PDF 抽取操作与已登记格式不符。');
  if (new Set(formats).size > 1) throw new Error('原件与转换内容的格式身份冲突。');
  if (native.format === 'docx' || native.format === 'pptx') return segmentsFromOffice(envelope, content, native, ref);
  // Historical registered page-geometry envelopes also carry producer-specific format labels.
  if (formats.some(format => format === 'docx' || format === 'pptx')
    || formats.length && !formats.includes('pdf') && !Array.isArray(content.pages))
    throw new Error('该格式缺少受支持的文档原生结构。');
  // 解析器版本必须能追溯到实际转换实现：不写死，避免产物换版后片段仍用旧版本号。
  // 真实 PDF 转换把 pdfjs 版本放在 content.implementation.pdfjs；顶层 implementation 只有插件名与版本。
  const pdfjs = (envelope.content as { implementation?: { pdfjs?: string } } | undefined)?.implementation?.pdfjs
    ?? envelope.implementation?.pdfjs;
  const parserVersion = pdfjs ? `${SEGMENTER_VERSION}+pdfjs-${pdfjs}` : SEGMENTER_VERSION;
  const pages = pdfPagesFromConversion(envelope.content);
  const pageCount = (envelope.content as { pageCount?: unknown }).pageCount;
  if (!Number.isSafeInteger(pageCount) || Number(pageCount) < 1 || pageCount !== pages.length
    || pages.some((page, index) => page.page !== index + 1)) {
    throw new Error('PDF 转换页数或逐页身份不完整，未把部分页面视作完整文档。');
  }
  const built = buildDocumentSegments({ documentId: ref.documentId, documentVersion: ref.documentVersion,
    parserVersion, sourceRef: ref.artifactRef, pages });

  // 转换缺口按页落到片段上：几何/阅读顺序未经确认时，片段必须自带该状态。
  const pageIssues = new Map<number, string[]>();
  for (const issue of envelope.issues ?? []) {
    const page = (issue.location as { page?: unknown } | undefined)?.page;
    if (typeof page !== 'number') continue;
    const mapped = CONVERSION_ISSUE_MAP[issue.code] ?? `conversion_issue:${issue.code}`;
    const list = pageIssues.get(page) ?? [];
    if (!list.includes(mapped)) list.push(mapped);
    pageIssues.set(page, list);
  }
  for (const segment of built.segments) {
    for (const issue of pageIssues.get(segment.page_number) ?? []) {
      if (issue === SEGMENT_ISSUES.tableGeometryUnverified && segment.kind !== 'table') continue;
      if (!segment.issues.includes(issue)) segment.issues.push(issue);
    }
  }
  return { ...built, pageCount: Number(pageCount) };
}

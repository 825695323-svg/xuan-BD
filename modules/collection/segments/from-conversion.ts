/**
 * 从**已登记的转换产物**生成片段。
 * 入口用 `conversion.document` / `pdf.extract` 的产物（ConversionEnvelope），
 * 而不是直接调底层 pdfNative：权限、预算、产物登记与证据由动作外壳负责。
 * 本文件只做「产物 → 片段」的确定性转换，不重新解析原件。
 */
import type { SegmentBuildResult } from './contracts.js';
import { SEGMENT_ISSUES, SEGMENTER_VERSION } from './contracts.js';
import { buildDocumentSegments, pdfPagesFromConversion } from './segmenter.js';

/** 产物中的转换信封（与 ConversionEnvelope 同形，只取生成片段所需字段）。 */
export interface ConversionArtifactEnvelope {
  status: 'complete' | 'partial' | 'failed';
  issues: { code: string; message?: string; location?: unknown }[];
  content: unknown;
  text?: string;
  implementation?: { name?: string; version?: string; pdfjs?: string };
  source?: { sha256?: string; declaredName?: string; fileRefId?: string; fileRefVersion?: number };
}

export interface SegmentSourceRef {
  /** 已登记产物引用（structured-conversion / original-text-view 的 fileRefId）。 */
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

export function segmentsFromConversionArtifact(envelope: ConversionArtifactEnvelope, ref: SegmentSourceRef): SegmentBuildResult {
  if (!ref.artifactRef.trim()) throw new Error('缺少产物引用：片段化必须指向已登记的转换产物。');
  if (!ref.documentId.trim()) throw new Error('缺少原件身份 documentId。');
  if (!ref.documentVersion.trim()) throw new Error('缺少原件版本 documentVersion。');
  if (envelope.status === 'failed') {
    throw new Error(`转换产物状态为 failed，不能生成片段：${(envelope.issues ?? []).map(issue => issue.code).join(',') || '无缺口码'}`);
  }
  // 解析器版本必须能追溯到实际转换实现：不写死，避免产物换版后片段仍用旧版本号。
  // 真实 PDF 转换把 pdfjs 版本放在 content.implementation.pdfjs；顶层 implementation 只有插件名与版本。
  const pdfjs = (envelope.content as { implementation?: { pdfjs?: string } } | undefined)?.implementation?.pdfjs
    ?? envelope.implementation?.pdfjs;
  const parserVersion = pdfjs ? `${SEGMENTER_VERSION}+pdfjs-${pdfjs}` : SEGMENTER_VERSION;
  const pages = pdfPagesFromConversion(envelope.content);
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
  return built;
}

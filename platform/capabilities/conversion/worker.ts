import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { ConversionPayload } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { archiveMembers, decodeText, digest, inspectFormat, MAX_EXPANDED, memberName, structuredText } from './formats.js';
import { officeNative, rtfNative } from './office.js';
import { pdfAttachments, pdfNative, renderPdf } from './pdf.js';
import { convertImage, subtitleNative, type BinaryOutput } from './media.js';
import { DirectError } from '../../runtime/file-workspace.js';
import { extractPublicWebHtml } from '../browser/html-extraction.js';

export interface PureConversionInput { operation: string; bytes: Uint8Array; name: string; args: Record<string, JsonValue> }
export interface PureConversionOutput { payload: ConversionPayload; binaries: BinaryOutput[]; inspection: ReturnType<typeof inspectFormat> }
let reportedInspection: ReturnType<typeof inspectFormat> | undefined;

/** 静态、有限输入的字节转换工作线程；没有路径输入、命令调度、网络或任务运行权。 */
export async function convertBytes(input: PureConversionInput): Promise<PureConversionOutput> {
  const bytes = Buffer.from(input.bytes), encoding = typeof input.args.encoding === 'string' ? input.args.encoding : undefined;
  const inspection = inspectFormat(bytes, input.name, encoding), format = inspection.format, signal = new AbortController().signal;
  reportedInspection = inspection;
  const done = (payload: ConversionPayload, binaries: BinaryOutput[] = []): PureConversionOutput => ({ payload, binaries, inspection });
  if (input.operation === 'conversion.inspect') return done({ status: 'complete', issues: [], content: { ...inspection, bytes: bytes.length,
    filenameIsAuthority: false, legacyOfficeSupported: false, typeStatement: inspection.method === 'text-with-name-hint' ? 'text syntax plus declared filename hint; not a unique magic signature' : inspection.method } });
  if (input.operation === 'conversion.document' || input.operation === 'pdf.extract') {
    if (input.operation === 'pdf.extract' && format !== 'pdf') throw new DirectError('FORMAT_MISMATCH', 'PDF 提取动作的实际原件不是 PDF。');
    if (format === 'pdf') return done(await pdfNative(bytes, signal));
    if (format === 'docx' || format === 'pptx') return done(officeNative(bytes, format, signal));
    if (format === 'rtf') return done(rtfNative(bytes, signal));
    if (format === 'html') {
      const decoded = decodeText(bytes, encoding), extracted = extractPublicWebHtml(decoded.text);
      return done({ status: extracted.status === 'complete' ? 'complete' : 'partial', text: extracted.text,
        issues: extracted.reasons.map(reason => ({ code: 'HTML_' + reason.toUpperCase().replace(/-/gu, '_'), message: reason })),
        content: { format, originalHtml: decoded.text, encoding: decoded.encoding, extraction: extracted as unknown as JsonValue } });
    }
    if (format === 'text') { const decoded = decodeText(bytes, encoding); return done({ status: 'complete', issues: [], text: decoded.text, content: { format, ...decoded } }); }
    throw new DirectError(format === 'ole' ? 'LEGACY_OFFICE_UNSUPPORTED' : 'DOCUMENT_FORMAT_UNSUPPORTED', '正文转换支持原生 PDF、RTF、DOCX、PPTX、纯文本；旧 DOC/PPT/XLS 未支持，HTML 使用固定网页正文转换。');
  }
  if (input.operation === 'conversion.structured') {
    if (format === 'xlsx') return done(officeNative(bytes, format, signal));
    return done(structuredText(bytes, format, encoding, typeof input.args.delimiter === 'string' ? input.args.delimiter : undefined));
  }
  if (input.operation === 'conversion.subtitle') return done(subtitleNative(bytes, input.name, encoding));
  if (input.operation === 'conversion.pdf_render') {
    if (format !== 'pdf') throw new DirectError('FORMAT_MISMATCH', '按页渲染的实际原件不是 PDF。');
    const rendered = await renderPdf(bytes, String(input.args.pages), Number(input.args.scale ?? 1), signal); return done(rendered.payload, rendered.binaries);
  }
  if (input.operation === 'conversion.image') {
    const converted = await convertImage(bytes, { rotate: Number(input.args.rotate ?? 0),
      ...(input.args.cropX === undefined ? {} : { cropX: Number(input.args.cropX) }), ...(input.args.cropY === undefined ? {} : { cropY: Number(input.args.cropY) }),
      ...(input.args.cropWidth === undefined ? {} : { cropWidth: Number(input.args.cropWidth) }), ...(input.args.cropHeight === undefined ? {} : { cropHeight: Number(input.args.cropHeight) }) });
    return done(converted.payload, converted.binaries);
  }
  if (input.operation === 'conversion.archive') {
    let selected: unknown = [];
    if (input.args.memberPaths !== undefined) { try { selected = JSON.parse(String(input.args.memberPaths)); } catch { throw new DirectError('ARCHIVE_SELECTION_INVALID', '选件需为成员路径的 JSON 字符串数组。'); } }
    if (!Array.isArray(selected) || selected.length > 100 || selected.some(value => typeof value !== 'string') || new Set(selected).size !== selected.length) throw new DirectError('ARCHIVE_SELECTION_INVALID', '选件需为最多 100 个不重复的原生成员路径；空数组只列清单。');
    if (format === 'pdf') {
      const members = await pdfAttachments(bytes), extractionRequested = selected.length > 0;
      return done({ status: extractionRequested ? 'failed' : 'complete', content: { format, selection: selected as string[], recursiveExpansion: false,
        extractionAvailable: false, members }, issues: extractionRequested ? [{ code: 'PDF_ATTACHMENT_SIZE_UNVERIFIED',
        message: 'PDF 附件只列原生目录；当前解码器不能在解码前约束单附件大小，未读取或拆解任何附件内容。' }] : [] });
    }
    const members = archiveMembers(bytes, format, input.name);
    const selectedSet = new Set(selected as string[]), binaries: BinaryOutput[] = [];
    let selectedBytes = 0;
    for (const name of selectedSet) {
      const member = members.find(value => value.path === name);
      if (!member || member.kind !== 'file') throw new DirectError('ARCHIVE_MEMBER_NOT_FOUND', '所选成员不是本原件内唯一的普通文件。');
      const output = member.read(); if ((selectedBytes += output.length) > MAX_EXPANDED) throw new DirectError('ARCHIVE_SELECTION_LIMIT', '选件拆解超过本次解码预算。');
      binaries.push({ name: `member-${binaries.length + 1}.bin`, bytes: output, location: { memberPath: name, originalBytes: output.length, sha256: digest(output) } });
    }
    return done({ status: 'complete', issues: [], content: { format, selection: [...selectedSet], recursiveExpansion: false,
      members: members.map(value => ({ path: value.path, bytes: value.bytes, kind: value.kind, selected: selectedSet.has(value.path) })) } }, binaries);
  }
  throw new DirectError('CONVERSION_OPERATION_UNKNOWN', '未登记的转换操作。');
}

if (!isMainThread) {
  try { parentPort!.postMessage({ ok: true, result: await convertBytes(workerData as PureConversionInput) }); }
  catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof DirectError ? error.code : 'CONVERSION_PARSE_FAILED',
    message: error instanceof DirectError ? error.message : '原件解析失败；未生成推测内容。', inspection: reportedInspection }); }
}

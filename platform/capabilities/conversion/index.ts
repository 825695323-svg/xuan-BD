import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CONVERSION_ACTION_IDS, PDF_EXTRACT_ALIAS, type ConversionEnvelope, type ConversionPayload } from '../../../contracts/conversion.js';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import type { SkillField } from '../../../contracts/skill-contracts.js';
import type { SkillRegistration } from '../../plugins/registry.js';
import type { FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { acquireAuthority, directoryCapability, fileCapability, DirectError, DirectWorkspace, prepareDestination, type DirectAuthority } from '../../runtime/file-workspace.js';
import { DirectProcessError } from '../../runtime/process.js';
import type { ProcessRuntime } from '../../runtime/programs.js';
import { digest, inspectFormat, MAX_SOURCE } from './formats.js';
import { convertMedia } from './media.js';
import type { PureConversionInput, PureConversionOutput } from './worker.js';
import { CONVERSION_IMPLEMENTATION, CONVERSION_SCHEMA_VERSION, storedConversionEnvelope } from './storage.js';

export interface ConversionActionsOptions { files: FileReferenceService; artifactRoot: string; processRuntime?: ProcessRuntime; assertPath(path: string): void;
  managedSource?: (fileRefId: string, action: string) => { path: string; sha256: string; bytes: number } | null }
const IDS = new Set<string>([...CONVERSION_ACTION_IDS, PDF_EXTRACT_ALIAS]);
const file: SkillField = { key: 'fileRefId', label: '已选择的原件', type: 'file', required: true };
const destination: SkillField = { key: 'destination', label: '新的主产物文件', type: 'text', maxLength: 4096 };
const encoding: SkillField = { key: 'encoding', label: '原始编码（无 BOM 且不是 UTF-8 时需明确）', type: 'text', maxLength: 40 };
const textExport: SkillField = { key: 'textExport', label: '正文导出（省略只保留结构产物）', type: 'select',
  options: [{ value: 'none', label: '不另存正文' }, { value: 'txt', label: '另存完整 TXT（纯文本）' }] };
const textField = (key: string, label: string, required = false, maxLength = 10000): SkillField => ({ key, label, type: 'text', required, maxLength });
const numberField = (key: string, label: string, minimum: number, maximum: number, required = false): SkillField => ({ key, label, type: 'number', minimum, maximum, required });

/** 仅从已完成的原生 XLSX 结构取有界首批格；完整原值仍在独立侧车。 */
export function xlsxModelPreview(payload: ConversionPayload): JsonValue | undefined {
  type Cell = { address: string | null; location: { part: string; sheet: string | null; cell: string | null };
    storageType: string; rawStorage: string | null; resolvedSharedString: string | null; inlineString: string | null;
    formula: { expression: string; attributes: { name: string; value: string }[] } | null; styleIndex: string | null; rawXml: string };
  const native = (payload.content as { native?: { sheets?: { name: string | null; nativeId: string | null; state: string | null;
    part: string; rows: { row: string | null; cells: Cell[] }[] }[] } })?.native;
  if (!native?.sheets) return undefined;
  let fieldsTruncated = false;
  const clip = (value: string | null, maxBytes: number, field: string, clipped: string[]): string | null => {
    if (value === null) return null;
    let bytes = 0, end = 0;
    for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; bytes += size; end += character.length; }
    if (end < value.length) { clipped.push(field); fieldsTruncated = true; }
    return value.slice(0, end);
  };
  const sheets = native.sheets.map(sheet => ({ name: clip(sheet.name, 80, 'sheet.name', []),
    nativeId: clip(sheet.nativeId, 40, 'sheet.nativeId', []), state: clip(sheet.state, 40, 'sheet.state', []),
    part: clip(sheet.part, 120, 'sheet.part', []), rowCount: sheet.rows.length,
    cellCount: sheet.rows.reduce((sum, row) => sum + row.cells.length, 0) }));
  const first = native.sheets.find(sheet => sheet.rows.length > 0);
  const previewRows = first?.rows.slice(0, 3).map(row => ({ row: clip(row.row, 40, 'row', []), cells: row.cells.slice(0, 3).map(cell => {
    const clipped: string[] = [], formula = cell.formula;
    if (formula && formula.attributes.length > 4) fieldsTruncated = true;
    return { address: clip(cell.address, 80, 'address', clipped), location: {
      part: clip(cell.location?.part ?? null, 120, 'location.part', clipped),
      sheet: clip(cell.location?.sheet ?? null, 80, 'location.sheet', clipped),
      cell: clip(cell.location?.cell ?? null, 80, 'location.cell', clipped) },
      storageType: clip(cell.storageType, 40, 'storageType', clipped), rawStorage: clip(cell.rawStorage, 160, 'rawStorage', clipped),
      resolvedSharedString: clip(cell.resolvedSharedString, 160, 'resolvedSharedString', clipped), inlineString: clip(cell.inlineString, 160, 'inlineString', clipped),
      formula: formula ? { expression: clip(formula.expression, 160, 'formula.expression', clipped),
        attributes: formula.attributes.slice(0, 4).map(attribute => ({
          name: clip(attribute.name, 40, 'formula.attributes.name', clipped),
          value: clip(attribute.value, 80, 'formula.attributes.value', clipped) })) } : null,
      styleIndex: clip(cell.styleIndex, 40, 'styleIndex', clipped), rawXml: clip(cell.rawXml, 240, 'rawXml', clipped),
      truncatedFields: [...clipped, ...(formula && formula.attributes.length > 4 ? ['formula.attributes'] : [])] };
  }) })) ?? [];
  const preview = { format: 'xlsx', source: 'native-conversion', conversionStatus: payload.status,
    contentIsUntrustedReference: true, sheetCount: sheets.length,
    totalRows: sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0), totalCells: sheets.reduce((sum, sheet) => sum + sheet.cellCount, 0),
    sheets: sheets.slice(0, 8), rows: previewRows, previewSheet: clip(first?.name ?? null, 80, 'previewSheet', []),
    truncated: sheets.length > 8 || native.sheets.some(sheet => sheet !== first && sheet.rows.length > 0)
      || !!first && (first.rows.length > previewRows.length || first.rows.some((row, index) => index < 3 && row.cells.length > 3)) || fieldsTruncated,
    qualification: 'native-values-only/needs-table-adapter',
    scopeGuidance: '这是有界原生行格预览。仅按已展示的行格原值概述；未展示的行列视为未读。完整侧车不适合用 file.read（读取文本）整份读取；不得猜表头、拼整表、计算公式或宣称五步表格适配完成。' };
  while (Buffer.byteLength(JSON.stringify(preview)) > 6_000 && preview.rows.length) {
    const crowded = [...preview.rows].reverse().find(row => row.cells.length > 1);
    if (crowded) crowded.cells.pop();
    else preview.rows.pop();
    preview.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(preview)) > 6_000 && preview.sheets.length) {
    preview.sheets.pop();
    preview.truncated = true;
  }
  return preview as unknown as JsonValue;
}

/** 装配无副作用；所有动作仍由原 Direct Task、文件权限和产物发布入口承接。 */
export function createConversionActions(options: ConversionActionsOptions) {
  const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({ action, title, description, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    fields: [file, ...fields, destination], permissionSummary: ['读取明确选定的原件', '只改变表达，保留原件、原值、来源位置、实现版本及完整/部分/失败状态；不补缺、去重、纠错、推断单位日期、摘要或标注',
      '已有文字层先直接提取；扫描内容另用已提供的OCR（文字识别），识字成功不代表表格结构正确；清洗另按明确任务调用已登记能力', '保存来源摘要及结构证据', '新建产物并受控清理本任务暂存'],
    available: () => {
      if (action === 'conversion.media') {
        try { options.processRuntime!.path('ffmpeg'); options.processRuntime!.path('ffprobe'); } catch { return { available: false, reason: '此动作缺少已登记的随包 FFmpeg/FFprobe。' }; }
      }
      return { available: true };
    },
  });
  const registrations = [
    registration('conversion.inspect', '识别实际类型与编码', '按原件字节、原生容器和严格解码识别；文件名只作提示，不自动猜测编码。', [encoding]),
    registration('conversion.document', '转换原生文档正文', '保留 RTF、DOCX、PPTX 和 PDF 原文、结构、完整链接及来源；正文 TXT 按需导出，不清洗、不自动识字。', [encoding, textExport]),
    registration('conversion.structured', '转换结构化记录', '保留 XLSX、CSV、JSON、XML 原值、单元格和成员顺序，不计算公式或解释日期单位。', [encoding, { key: 'delimiter', label: 'CSV 明确分隔符', type: 'select', options: [{ value: ',', label: '逗号' }, { value: ';', label: '分号' }, { value: '\t', label: '制表符' }, { value: '|', label: '竖线' }] }]),
    registration('conversion.archive', '列出并拆解所选附件', '列出 ZIP、TAR、GZIP、Office 成员并仅拆解显式选件；PDF 只列原生附件目录。', [textField('memberPaths', '成员路径 JSON 字符串数组（省略只列清单）')]),
    registration('conversion.pdf_render', '按页渲染 PDF', '仅渲染明确页码为 PNG，保留原件、页码和比例。', [textField('pages', '明确页码，例如 1,3-5', true, 200),
      { key: 'scale', label: '渲染比例', type: 'select', options: ['0.25', '0.5', '1', '1.5', '2', '3'].map(value => ({ value, label: value })) }]),
    registration('conversion.image', '旋转或裁切图片', '仅按明确角度及矩形转换静态 PNG、JPEG、WebP。', [{ key: 'rotate', label: '顺时针角度', type: 'select', options: [0, 90, 180, 270].map(value => ({ value: String(value), label: String(value) })) },
      ...['cropX', 'cropY', 'cropWidth', 'cropHeight'].map(key => numberField(key, key, 0, 20000))]),
    registration('conversion.media', '转换指定音轨与时间段', '按实际音轨索引与毫秒起止转换；保留原件时轴及实际输出时长。', [{ key: 'format', label: '目标格式', type: 'select', required: true, options: ['wav', 'mp3', 'mp4'].map(value => ({ value, label: value.toUpperCase() })) },
      numberField('track', '原件中的音轨索引', 0, 63, true), numberField('startMs', '开始毫秒', 0, Number.MAX_SAFE_INTEGER, true), numberField('endMs', '结束毫秒', 1, Number.MAX_SAFE_INTEGER, true)]),
    registration('conversion.subtitle', '解析原生字幕', '保留 SRT、WebVTT、ASS/SSA、TTML 的原文、标记与原生时间，不清洗或翻译。', [encoding]),
    registration(PDF_EXTRACT_ALIAS, '提取 PDF 原文字层', '兼容原 PDF 动作；以两端共用实现保存原文 TXT 与结构 JSON，不调用系统 PDF 工具。', []),
  ];
  return { registrations, handles: (action: string) => IDS.has(action), async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
    if (!IDS.has(action) || context.task.runtimeId !== 'direct' || context.task.action !== action) throw new DirectError('RUNTIME_MISMATCH', '转换动作必须保留原任务身份。');
    context.signal.throwIfAborted();
    const source = options.files.verify(String(args.fileRefId));
    if (source.kind !== 'file') throw new DirectError('NOT_A_FILE', '转换需要已选择的普通原件。');
    const managed = options.managedSource?.(source.id, action);
    if (!managed || managed.path !== source.invocationPath) options.assertPath(source.invocationPath);
    if (args.destination !== undefined) options.assertPath(String(args.destination));
    const capabilities = [fileCapability('read', source.invocationPath), directoryCapability('read', options.artifactRoot), directoryCapability('write', options.artifactRoot), directoryCapability('delete', options.artifactRoot)];
    if (action === 'conversion.media') for (const name of ['ffprobe', 'ffmpeg'] as const) {
      if (!options.processRuntime) throw new DirectError('TOOL_UNAVAILABLE', '媒体转换未获得随包程序绑定。'); capabilities.push(fileCapability('execute', options.processRuntime.path(name)));
    }
    const authority = await acquireAuthority(context, action, args, capabilities), workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
    const references: { role: string; fileRefId: string; fileRefVersion: number; sha256: string; bytes: number; location?: JsonValue }[] = [];
    try {
      await workspace.create();
      let payload: ConversionPayload, inspection: ReturnType<typeof inspectFormat>, sourceHash: string, sourceBytes: number;
      const publish = async (path: string, role: string, suggestedName: string, limit: number, location?: JsonValue, target?: string) => {
        authority.assert(); context.signal.throwIfAborted(); options.files.verify(source.id);
        const extension = extname(suggestedName), stem = extension ? suggestedName.slice(0, -extension.length) : suggestedName;
        const fingerprint = await workspace.fingerprint(path, limit), reference = await workspace.publishFile(path,
          prepareDestination(target ?? join(options.artifactRoot, `${stem}-${randomUUID()}${extension}`)), action, args, limit);
        const entry = { role, fileRefId: reference.id, fileRefVersion: reference.version, ...fingerprint, ...(location ? { location } : {}) }; references.push(entry); return entry;
      };
      if (action === 'conversion.media') {
        const staged = await workspace.copyReference(source, 'media-input.bin', 256_000_000), fingerprint = await workspace.fingerprint(staged, 256_000_000);
        sourceHash = fingerprint.sha256; sourceBytes = fingerprint.bytes;
        inspection = inspectFormat(await workspace.readPrefix(staged, 1024), source.displayName);
        const converted = await convertMedia(context, workspace, authority, options.processRuntime!, staged, inspection.format,
          { format: String(args.format) as 'wav' | 'mp3' | 'mp4', track: Number(args.track), startMs: Number(args.startMs), endMs: Number(args.endMs) }); payload = converted.payload;
        const fingerprintAfter = await workspace.fingerprint(staged, 256_000_000); if (fingerprintAfter.sha256 !== sourceHash) throw new DirectError('SOURCE_CHANGED', '暂存原件在媒体转换期间已变化。');
        const resultFingerprint = await workspace.fingerprint(converted.output, 128_000_000); if (!resultFingerprint.bytes || resultFingerprint.bytes >= 128_000_000) throw new DirectError('MEDIA_OUTPUT_LIMIT', '媒体输出为空或达到截断上限，不发布。');
        await publish(converted.output, 'converted-media', 'segment.' + args.format, 128_000_000, { streamIndex: Number(args.track), startMs: Number(args.startMs), endMs: Number(args.endMs) }, args.destination === undefined ? undefined : String(args.destination));
      } else {
        const bytes = await options.files.readBytes(source.id, { operation: context.operationScope(authority.operation), approvalId: authority.approvalId, maxBytes: MAX_SOURCE });
        sourceHash = digest(bytes); sourceBytes = bytes.length;
        if (managed && (managed.sha256 !== sourceHash || managed.bytes !== sourceBytes)) throw new DirectError('MATERIAL_SOURCE_CHANGED', '上传原件与已保管版本不一致。');
        inspection = { format: 'unknown', method: 'unknown', declaredExtension: extname(source.displayName) };
        const converted = await inWorker({ operation: action, bytes, name: source.displayName, args }, context, authority, workspace);
        payload = converted.payload; inspection = converted.inspection;
        for (const [index, binary] of converted.binaries.entries()) {
          const path = await workspace.createBytes(`binary-${index}.bin`, binary.bytes);
          await publish(path, 'converted-member', binary.name, 64_000_000, binary.location,
            converted.binaries.length === 1 && ['conversion.image', 'conversion.pdf_render'].includes(action) && args.destination !== undefined ? String(args.destination) : undefined);
        }
      }
      authority.assert(); context.signal.throwIfAborted(); options.files.verify(source.id);
      const envelope: ConversionEnvelope = { schemaVersion: CONVERSION_SCHEMA_VERSION, implementation: CONVERSION_IMPLEMENTATION, operation: action,
        source: { fileRefId: source.id, fileRefVersion: source.version, sha256: sourceHash, bytes: sourceBytes, declaredName: source.displayName, detectedType: inspection.format,
          ...(inspection.encoding ? { encoding: inspection.encoding } : {}) }, ...payload };
      // 侧车从同一原任务登记；完整结果不塞进模型的有限工具回执。
      const stored = storedConversionEnvelope(envelope);
      const serial = inspection.format === 'pdf' || action === 'conversion.structured' && inspection.format === 'xlsx'
        ? JSON.stringify({ ...stored, artifacts: references }) : JSON.stringify({ ...stored, artifacts: references }, null, 2);
      if (Buffer.byteLength(serial) > 64_000_000) throw new DirectError('CONVERSION_RESULT_LIMIT', '完整结构产物超过本次 64 MB 预算；本次不截断正文。');
      const structured = await workspace.createText('conversion.json', serial);
      const structureTarget = args.destination !== undefined && ['conversion.document', 'conversion.structured', 'conversion.inspect', 'conversion.subtitle', 'conversion.archive'].includes(action) ? String(args.destination) : undefined;
      const evidence = await publish(structured, 'structured-conversion', 'conversion.json', 64_000_000, undefined, structureTarget);
      let textReference: typeof evidence | undefined;
      if (payload.text !== undefined && (args.textExport === 'txt' || action === PDF_EXTRACT_ALIAS)) {
        const textPath = await workspace.createText('original-text.txt', payload.text);
        textReference = await publish(textPath, 'original-text-view', 'converted-text.txt', 64_000_000, undefined,
          action === PDF_EXTRACT_ALIAS && args.destination !== undefined ? String(args.destination) : undefined);
      }
      await workspace.cleanup();
      const preview = payload.text?.slice(0, 16000), main = textReference && action === PDF_EXTRACT_ALIAS ? textReference : references.find(value => value.role === 'converted-media') ?? evidence;
      const modelPreview = action === 'conversion.structured' && inspection.format === 'xlsx' && payload.status !== 'failed' ? xlsxModelPreview(payload) : undefined;
      return { summary: payload.status === 'failed' ? '原件转换失败；来源与失败原因已保存。' : payload.status === 'partial' ? '原件转换部分完成；原生证据与未确认项已保存。' : '原件转换已完成，来源与产物已核对。',
        artifactIds: references.map(value => value.fileRefId), data: { status: payload.status, implementation: envelope.implementation, source: envelope.source as unknown as JsonValue,
          fileRefId: main.fileRefId, sha256: main.sha256, bytes: main.bytes, structuredReference: evidence, ...(textReference ? { textReference } : {}),
          artifacts: references, issues: payload.issues as unknown as JsonValue, ...(preview !== undefined ? { text: preview, truncated: preview.length < payload.text!.length, characterCount: payload.text!.length } : {}),
          ...(modelPreview ? { modelPreview } : {}), modelCalls: 0 } };
    } catch (error) {
      if (!(error instanceof DirectError && error.unknown) && !(error instanceof DirectProcessError && error.disposition === 'unknown')) {
        try { await workspace.cleanup(); } catch (cleanup) { await workspace.recordRetained(); throw cleanup; }
      }
      await workspace.recordRetained(); throw error;
    }
  } };
}

/** 仅运行随包固定文件，等待工作线程终止回执后才允许 Task 清理或发布。 */
async function inWorker(input: PureConversionInput, context: TaskExecutionContext, authority: DirectAuthority, workspace: DirectWorkspace): Promise<PureConversionOutput> {
  context.signal.throwIfAborted(); authority.assert(); workspace.assertCurrent();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: input, execArgv: ['--import', 'tsx'],
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } });
  let timer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
  const threadId = worker.threadId;
  try {
    await context.emit({ type: 'checkpoint', checkpoint: { conversionWorkerThreadId: threadId, conversionOperation: input.operation, workerState: 'started' } });
    context.signal.throwIfAborted();
    return await new Promise<PureConversionOutput>((resolve, reject) => {
      let finished = false;
      const abort = () => { if (!finished) { finished = true; reject(context.signal.reason ?? new DirectError('CONVERSION_CANCELLED', '本任务已停止转换。')); } };
      context.signal.addEventListener('abort', abort, { once: true });
      const settle = (error?: unknown, value?: PureConversionOutput) => { if (finished) return; finished = true; context.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value!); };
      timer = setTimeout(() => settle(new DirectError('CONVERSION_TIME_LIMIT', '原件转换达到本次 120 秒预算。')), 120000);
      interval = setInterval(() => { try { authority.assert(); workspace.assertCurrent(); context.signal.throwIfAborted(); } catch (error) { settle(error); } }, 1000);
      worker.once('message', (message: { ok: boolean; result?: PureConversionOutput; code?: string; message?: string; inspection?: PureConversionOutput['inspection'] }) => {
        if (message.ok && message.result) return settle(undefined, message.result);
        const inspection = message.inspection ?? { format: 'unknown', method: 'unknown', declaredExtension: extname(input.name) };
        settle(undefined, { inspection, binaries: [], payload: { status: 'failed', content: { format: inspection.format }, issues: [{ code: message.code ?? 'CONVERSION_PARSE_FAILED', message: message.message ?? '原件无法转换。' }] } });
      });
      worker.once('error', error => settle(new DirectError('CONVERSION_WORKER_FAILED', `转换工作线程未能完成：${error instanceof Error ? error.message.slice(0, 300) : '未报告原因'}`)));
      worker.once('exit', code => { if (!finished) settle(new DirectError('CONVERSION_WORKER_EXITED', `转换工作线程提前结束（${code}）。`)); });
    });
  } finally {
    if (timer) clearTimeout(timer); if (interval) clearInterval(interval);
    const exitCode = await worker.terminate();
    await context.emit({ type: 'checkpoint', checkpoint: { conversionWorkerThreadId: threadId, conversionOperation: input.operation, workerState: 'terminated', exitCode } });
  }
}

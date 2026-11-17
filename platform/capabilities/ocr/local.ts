import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import type { FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { acquireAuthority, directoryCapability, fileCapability, DirectError, DirectWorkspace, prepareDestination, type DirectAuthority } from '../../runtime/file-workspace.js';
import { DirectProcessError, type DirectBinary, type DirectProcessResult } from '../../runtime/process.js';
import { parseVisionEvidence } from './evidence.js';

export interface LocalOcrInput { fileRefId: string; fileRefVersion: number; expectedSha256: string }
type Reference = { fileRefId: string; fileRefVersion: number; sha256: string };
export interface LocalOcrResult {
  source: Reference; textReference: Reference; evidenceReference: Reference;
  segments: { text: string; location: { page: number; region: { x: number; y: number; width: number; height: number } } }[]; backend: 'apple-vision-local';
}
interface Options {
  files: FileReferenceService; artifactRoot: string; binary: string; assertPath(path: string): void;
  runTool(context: TaskExecutionContext, workspace: DirectWorkspace, authority: DirectAuthority,
    binary: DirectBinary, args: string[], path: string, timeout?: number): Promise<DirectProcessResult>;
}
const MAX_SOURCE = 25 * 1024 * 1024, MAX_OUTPUT = 8 * 1024 * 1024;
/** 复用原 TaskService、权限与受控进程；不安装、联网、修改原件或猜测缺失位置。 */
export async function recognizeLocalImage(context: TaskExecutionContext, input: LocalOcrInput, options: Options): Promise<LocalOcrResult> {
  context.signal.throwIfAborted();
  const reference = options.files.verify(input.fileRefId), extension = extname(reference.canonicalPath).toLowerCase();
  if (reference.kind !== 'file' || reference.version !== input.fileRefVersion || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) throw new DirectError('MATERIAL_REFERENCE_CHANGED', '图片原件版本或摘要无效。');
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new DirectError('UNSUPPORTED_INPUT', '本机 OCR 只接受单张 PNG/JPEG；PDF 需独立明确渲染，不能自动替代。');
  options.assertPath(reference.invocationPath);
  const authority = await acquireAuthority(context, context.task.action, context.task.args, [fileCapability('read', reference.invocationPath),
    fileCapability('execute', options.binary), ...(['read', 'write', 'delete'] as const).map(action => directoryCapability(action, options.artifactRoot))]);
  const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
  try {
    await workspace.create();
    const staged = await workspace.copyReference(reference, 'input' + extension, MAX_SOURCE);
    const source = await workspace.fingerprint(staged, MAX_SOURCE);
    if (!source.bytes || source.sha256 !== input.expectedSha256) throw new DirectError('MATERIAL_SOURCE_MISMATCH', '图片原件与保管摘要不符。');
    const jsonPath = join(workspace.path, 'ocr.json'), textPath = join(workspace.path, 'ocr.txt');
    await options.runTool(context, workspace, authority, 'vision-ocr', [staged, jsonPath, textPath], options.binary, 120_000);
    const evidence = await workspace.readText(jsonPath, MAX_OUTPUT), text = await workspace.readText(textPath, MAX_OUTPUT);
    let native: ReturnType<typeof parseVisionEvidence>;
    try { native = parseVisionEvidence(evidence, text); } catch { throw new DirectError('OCR_EVIDENCE_INVALID', '识别文本与原生坐标证据未通过一致性核对。'); }
    if (!native.observations.length) throw new DirectError('EMPTY_OCR', '本机识别没有产生文字；未填补未知。');
    const segments = native.observations.map(item => ({ text: item.text, location: { page: item.page, region: item.boundingBox } }));
    authority.assert(); options.files.verify(reference.id);
    if ((await workspace.fingerprint(staged, MAX_SOURCE)).sha256 !== source.sha256) throw new DirectError('MATERIAL_SOURCE_MISMATCH', '识别期间暂存原件发生变化。');
    const textHash = await workspace.fingerprint(textPath, MAX_OUTPUT), evidenceHash = await workspace.fingerprint(jsonPath, MAX_OUTPUT);
    const publishedEvidence = await workspace.publishFile(jsonPath, prepareDestination(join(options.artifactRoot, `ocr-evidence-${randomUUID()}.json`)), context.task.action, context.task.args, MAX_OUTPUT);
    const publishedText = await workspace.publishFile(textPath, prepareDestination(join(options.artifactRoot, `ocr-${randomUUID()}.txt`)), context.task.action, context.task.args, MAX_OUTPUT);
    await workspace.cleanup();
    return { source: { fileRefId: reference.id, fileRefVersion: reference.version, sha256: source.sha256 },
      textReference: { fileRefId: publishedText.id, fileRefVersion: publishedText.version, sha256: textHash.sha256 },
      evidenceReference: { fileRefId: publishedEvidence.id, fileRefVersion: publishedEvidence.version, sha256: evidenceHash.sha256 }, segments, backend: 'apple-vision-local' };
  } catch (error) {
    if (!(error instanceof DirectError && error.unknown) && !(error instanceof DirectProcessError && error.disposition === 'unknown')) {
      try { await workspace.cleanup(); } catch (cleanupError) { await workspace.recordRetained(); throw cleanupError; }
    }
    await workspace.recordRetained(); throw error;
  }
}

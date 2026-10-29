import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { root } from '@openclaw/fs-safe';
import type { FileReference, FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, fileCapability, prepareDestination, verifyFileHandle, type DirectAuthority } from '../../runtime/file-workspace.js';

export const COMPARE_LIMITS = Object.freeze({ inputBytes: 512 * 1024, inputLines: 10_000, lineBytes: 64 * 1024,
  outputBytes: 2 * 1024 * 1024, timeoutMs: 500, hardTimeoutMs: 2000, stopTimeoutMs: 1000, maxEditLength: 4096 });
interface ComparedText { reference: FileReference; text: string; sha256: string; authority: DirectAuthority }
export interface TextPatch { patch: string; additions: number; deletions: number; hunks: number }
export class DiffComputationError extends DirectError {
  constructor(code: string, message: string, readonly disposition: 'not_started' | 'settled' | 'unknown') {
    super(code, message, disposition === 'unknown');
  }
}

/** 仅比较明确选择的文件；读取、计算、产物发布分别核对，不应用补丁。 */
export async function compareRegisteredFiles(context: TaskExecutionContext, args: { leftFileRefId: string; rightFileRefId: string },
  files: FileReferenceService, artifactRoot: string): Promise<TaskResult> {
  const left = await readSelected(context, files, args.leftFileRefId, 'left', args);
  const right = await readSelected(context, files, args.rightFileRefId, 'right', args);
  const verifyInputs = () => {
    for (const input of [left, right]) { input.authority.assert(); assertReference(files, input.reference); }
  };
  verifyInputs();
  const effectId = randomUUID();
  await context.emit({ type: 'side_effect_started', effectId, description: '比较两份已选择的文本',
    operation: { leftFileRefId: left.reference.id, leftVersion: left.reference.version, rightFileRefId: right.reference.id, rightVersion: right.reference.version } });
  let difference: TextPatch;
  try {
    verifyInputs();
    difference = await computeTextPatch(left.text, right.text, headerName(left.reference, 'a'), headerName(right.reference, 'b'), context.signal, {},
      async () => { await context.emit({ type: 'progress', message: '正在比较两份文本。', data: { phase: 'compare' } }); });
  } catch (error) {
    if (!(error instanceof DiffComputationError && error.disposition === 'unknown')) {
      await context.emit({ type: 'side_effect_result', effectId, outcome: error instanceof DiffComputationError && error.disposition === 'settled' ? 'failed' : 'not_applied',
        evidence: error instanceof DiffComputationError && error.disposition === 'settled' ? '本次计算线程已结束，尚未发布任何差异文件。' : '本次计算没有启动，尚未发布任何差异文件。' });
    } else await context.emit({ type: 'checkpoint', checkpoint: { phase: 'compare', computationStopped: false, outcome: 'unknown', leftFileRefId: args.leftFileRefId, rightFileRefId: args.rightFileRefId } });
    throw error;
  }
  await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '差异计算结果已收到，计算线程已正常结束。' });
  verifyInputs();
  const authority = await acquireAuthority(context, 'file.compare.output', args, ['read', 'write', 'delete'].map((action) => directoryCapability(action as 'read' | 'write' | 'delete', artifactRoot)));
  const workspace = new DirectWorkspace(context, files, artifactRoot, authority);
  try {
    verifyInputs(); await workspace.create();
    const staged = await workspace.createText('comparison.diff', difference.patch);
    verifyInputs();
    const output = await workspace.publishFile(staged, prepareDestination(join(artifactRoot, 'comparison-' + randomUUID() + '.diff')), 'file.compare', args, COMPARE_LIMITS.outputBytes);
    await workspace.cleanup();
    const identical = difference.hunks === 0, preview = patchPreview(difference.patch);
    const inputs = [left, right].map((input) => ({ fileRefId: input.reference.id, version: input.reference.version,
      name: input.reference.displayName, bytes: input.reference.size, sha256: input.sha256 }));
    return { summary: identical ? '两份文本内容相同，比较结果已保存。' : '文本差异已保存：新增 ' + difference.additions + ' 行，移除 ' + difference.deletions + ' 行。',
      artifactIds: [output.id], data: { kind: 'file-diff', modelCalls: 0, ...preview, diff: { format: 'unified', identical,
        additions: difference.additions, deletions: difference.deletions, hunks: difference.hunks, inputs, artifactId: output.id } } };
  } catch (error) {
    let failure = error;
    if (!(error instanceof DirectError && error.unknown)) { try { await workspace.cleanup(); } catch (cleanupError) { failure = cleanupError; } }
    await workspace.recordRetained(); throw failure;
  }
}

async function readSelected(context: TaskExecutionContext, files: FileReferenceService, id: string, side: 'left' | 'right', args: JsonValue): Promise<ComparedText> {
  const reference = files.getRef(id);
  if (reference.kind !== 'file') throw new DirectError('NOT_A_FILE', '文本比较需要选择两个普通文件。');
  if (reference.size > COMPARE_LIMITS.inputBytes) throw new DirectError('COMPARE_INPUT_LIMIT', '每份文本上限为 512 KiB，请选择较小文本后比较。');
  const authority = await acquireAuthority(context, 'file.compare.read.' + side, { args, side, fileRefId: id, version: reference.version }, [fileCapability('read', reference.invocationPath)]);
  authority.assert(); assertReference(files, reference);
  const owner = await root(dirname(reference.canonicalPath), { symlinks: 'reject', hardlinks: 'reject' });
  const opened = await owner.open(basename(reference.canonicalPath));
  let text: string, sha256: string;
  try {
    const before = await opened.handle.stat({ bigint: true }); verifyFileHandle(before, reference);
    authority.assert(); assertReference(files, reference);
    const stream = opened.handle.createReadStream({ autoClose: false, start: 0, end: COMPARE_LIMITS.inputBytes, highWaterMark: 64 * 1024, signal: context.signal });
    const chunks: Buffer[] = [], digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of stream) {
      authority.assert(); assertReference(files, reference);
      if (!Buffer.isBuffer(chunk)) throw new DirectError('INVALID_TEXT_INPUT', '文本读取返回了无效字节。');
      bytes += chunk.length;
      if (bytes > COMPARE_LIMITS.inputBytes) throw new DirectError('COMPARE_INPUT_LIMIT', '文本超过本次读取上限。');
      chunks.push(chunk); digest.update(chunk);
    }
    const after = await opened.handle.stat({ bigint: true }); verifyFileHandle(after, reference);
    if (before.ctimeNs !== after.ctimeNs || bytes !== reference.size) throw new DirectError('FILE_CHANGED', '读取期间所选文本的内容版本已变化。');
    authority.assert(); assertReference(files, reference);
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { throw new DirectError('NOT_UTF8_TEXT', '文本比较仅支持有效 UTF-8 文件。'); }
    sha256 = digest.digest('hex');
  } finally { await opened.handle.close(); }
  assertTextBudget(text);
  return { reference, text, sha256, authority };
}
function assertReference(files: FileReferenceService, expected: FileReference): void {
  const current = files.verify(expected.id);
  if (current.version !== expected.version || current.canonicalPath !== expected.canonicalPath || current.invocationPath !== expected.invocationPath
    || current.device !== expected.device || current.inode !== expected.inode || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs) {
    throw new DirectError('FILE_CHANGED', '比较期间所选文件或引用已变化，请重新选择当前版本。');
  }
}
function assertTextBudget(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > COMPARE_LIMITS.inputBytes) throw new DirectError('COMPARE_INPUT_LIMIT', '文本超过本次读取上限。');
  if (text.includes('\0')) throw new DirectError('NOT_TEXT_FILE', '所选文件含二进制零字节，不能作为普通文本比较。');
  const lines = text.split('\n');
  if (lines.length > COMPARE_LIMITS.inputLines || lines.some((line) => Buffer.byteLength(line, 'utf8') > COMPARE_LIMITS.lineBytes)) {
    throw new DirectError('COMPARE_TEXT_LIMIT', '每份文本最多 10000 行，单行最多 64 KiB，请选择较小文本片段。');
  }
}
function headerName(reference: FileReference, side: 'a' | 'b'): string {
  return side + '/' + basename(reference.displayName.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
}
function patchPreview(patch: string): { text: string; truncated: boolean; bytes: number; characterCount: number } {
  let text = patch.split('\n').slice(0, 600).join('\n').slice(0, 32_000);
  while (Buffer.byteLength(JSON.stringify(text), 'utf8') > 80_000) text = text.slice(0, Math.floor(text.length / 2));
  if (text.length && /[\ud800-\udbff]/u.test(text.at(-1)!)) text = text.slice(0, -1);
  return { text, truncated: text.length < patch.length, bytes: Buffer.byteLength(patch, 'utf8'), characterCount: patch.length };
}

const diffModule = createRequire(import.meta.url).resolve('diff');
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { structuredPatch, formatPatch, FILE_HEADERS_ONLY } = require(workerData.diffModule);
const patch = structuredPatch(workerData.oldName, workerData.newName, workerData.left, workerData.right, undefined, undefined,
  { context: 3, timeout: workerData.timeoutMs, maxEditLength: workerData.maxEditLength, ignoreWhitespace: false, stripTrailingCr: false });
if (!patch) parentPort.postMessage({ error: 'DIFF_BUDGET_EXCEEDED' });
else {
  const text = formatPatch(patch, FILE_HEADERS_ONLY);
  if (Buffer.byteLength(text, 'utf8') > workerData.outputBytes) parentPort.postMessage({ error: 'DIFF_OUTPUT_LIMIT' });
  else {
    let additions = 0, deletions = 0;
    for (const hunk of patch.hunks) for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    parentPort.postMessage({ patch: text, additions, deletions, hunks: patch.hunks.length });
  }
}
`;

/** 固定成熟差异库在独立线程运行；结果只能在 exit 之后返回。参数预算只供内部验证缩小。 */
export async function computeTextPatch(left: string, right: string, oldName: string, newName: string, signal: AbortSignal,
  budget: Partial<{ timeoutMs: number; hardTimeoutMs: number; maxEditLength: number }> = {}, onStarted?: () => Promise<void>): Promise<TextPatch> {
  assertTextBudget(left); assertTextBudget(right);
  const timeoutMs = budget.timeoutMs ?? COMPARE_LIMITS.timeoutMs, hardTimeoutMs = budget.hardTimeoutMs ?? COMPARE_LIMITS.hardTimeoutMs, maxEditLength = budget.maxEditLength ?? COMPARE_LIMITS.maxEditLength;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > COMPARE_LIMITS.timeoutMs || !Number.isSafeInteger(hardTimeoutMs)
    || hardTimeoutMs < 1 || hardTimeoutMs > COMPARE_LIMITS.hardTimeoutMs || !Number.isSafeInteger(maxEditLength) || maxEditLength < 0 || maxEditLength > COMPARE_LIMITS.maxEditLength) {
    throw new DiffComputationError('INVALID_COMPARE_BUDGET', '文本比较预算无效。', 'not_started');
  }
  if (signal.aborted) throw new DiffComputationError('TASK_STOPPED', '文本比较已请求停止。', 'not_started');
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], env: {}, name: 'mashiro-text-diff', stdout: true, stderr: true,
      workerData: { diffModule, left, right, oldName, newName, timeoutMs, maxEditLength, outputBytes: COMPARE_LIMITS.outputBytes },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  } catch { throw new DiffComputationError('DIFF_NOT_STARTED', '本机文本比较未能启动。', 'not_started'); }
  worker.stdout?.resume(); worker.stderr?.resume();
  let response: TextPatch | undefined, failure: DiffComputationError | undefined, finished = false, stopping = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: TextPatch) => void, reject!: (error: DiffComputationError) => void;
  const completed = new Promise<TextPatch>((a, b) => { resolve = a; reject = b; });
  void completed.catch(() => {});
  const finish = (error?: DiffComputationError) => {
    if (finished) return;
    finished = true; clearTimeout(deadline); if (stopTimer) clearTimeout(stopTimer); signal.removeEventListener('abort', abort);
    if (error) reject(error); else resolve(response!);
  };
  const stop = (reason: DiffComputationError) => {
    failure ??= reason;
    if (stopping || finished) return;
    stopping = true;
    stopTimer = setTimeout(() => { worker.unref(); finish(new DiffComputationError('DIFF_STOP_UNKNOWN', '尚未确认本机比较已停止，结果需要核对。', 'unknown')); }, COMPARE_LIMITS.stopTimeoutMs);
    void worker.terminate().catch(() => {});
  };
  const abort = () => stop(new DiffComputationError('TASK_STOPPED', '文本比较已请求停止。', 'settled'));
  const deadline = setTimeout(() => stop(new DiffComputationError('DIFF_TIMEOUT', '文本差异超过本次计算时限，请选择较小片段后重试。', 'settled')), hardTimeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  worker.on('message', (value: unknown) => {
    if (finished) return;
    if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
      failure = new DiffComputationError(value.error === 'DIFF_OUTPUT_LIMIT' ? 'DIFF_OUTPUT_LIMIT' : 'DIFF_BUDGET_EXCEEDED', '文本差异超过本次计算预算，请选择较小片段后重试。', 'settled'); return;
    }
    if (!value || typeof value !== 'object' || !('patch' in value) || typeof value.patch !== 'string' || Buffer.byteLength(value.patch, 'utf8') > COMPARE_LIMITS.outputBytes
      || !('additions' in value) || !Number.isSafeInteger(value.additions) || !('deletions' in value) || !Number.isSafeInteger(value.deletions) || !('hunks' in value) || !Number.isSafeInteger(value.hunks)) {
      stop(new DiffComputationError('DIFF_PROTOCOL_ERROR', '本机文本比较返回了无法核对的结果。', 'settled')); return;
    }
    response = value as TextPatch;
  });
  worker.on('error', () => { failure ??= new DiffComputationError('DIFF_COMPUTE_FAILED', '本机文本比较失败，尚未发布结果。', 'settled'); });
  worker.on('exit', (code) => finish(failure ?? (code !== 0 || !response ? new DiffComputationError('DIFF_COMPUTE_FAILED', '本机文本比较未返回完整结果。', 'settled') : undefined)));
  if (signal.aborted) abort();
  try { await onStarted?.(); }
  catch { stop(new DiffComputationError('DIFF_PROGRESS_NOT_SAVED', '比较进度未能保存，已请求停止。', 'settled')); }
  return await completed;
}

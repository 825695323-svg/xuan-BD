import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import type { FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { acquireAuthority, directoryCapability, fileCapability, DirectError, DirectWorkspace, prepareDestination, type DirectAuthority } from '../../runtime/file-workspace.js';
import { DirectProcessError, type DirectBinary, type DirectProcessResult } from '../../runtime/process.js';

export interface TranscriptionSegment {
  text: string;
  location: { startMs: number; endMs: number; cueIndex?: number };
}
export interface TranscriptionReference { fileRefId: string; fileRefVersion: number; sha256: string }
export function transcriptionSegmentPreview(segments: readonly TranscriptionSegment[]): {
  segments: TranscriptionSegment[]; segmentCount: number; segmentsTruncated: boolean;
} {
  const preview: TranscriptionSegment[] = [];
  let bytes = 0;
  for (const segment of segments) {
    const size = Buffer.byteLength(JSON.stringify(segment));
    if (preview.length >= 200 || bytes + size > 80_000) break;
    preview.push(segment); bytes += size;
  }
  return { segments: preview, segmentCount: segments.length, segmentsTruncated: preview.length !== segments.length };
}
export interface LocalTranscriptionInput {
  fileRefId: string;
  fileRefVersion?: number;
  expectedSha256?: string;
  destination?: string;
}
export interface LocalTranscriptionResult {
  source: TranscriptionReference;
  textReference: TranscriptionReference;
  evidenceReference: TranscriptionReference;
  text: string;
  segments: TranscriptionSegment[];
  backend: 'whisper.cpp-local';
}
export interface LocalTranscriptionOptions {
  files: FileReferenceService;
  artifactRoot: string;
  modelPath: string;
  binary(name: 'ffmpeg' | 'ffprobe' | 'whisper-cli'): string;
  assertPath(path: string): void;
  assertModelPath(path: string): void;
  runTool(context: TaskExecutionContext, workspace: DirectWorkspace, authority: DirectAuthority,
    binary: DirectBinary, args: string[], path: string, timeout?: number): Promise<DirectProcessResult>;
  convert(input: string, extension: string, output: string, format: string): string[];
  validateModel(header: Buffer): void;
  validateProbe(value: string, maxSeconds?: number): void;
}
const DEMUXERS: Readonly<Record<string, string>> = { '.wav': 'wav', '.mp3': 'mp3', '.flac': 'flac', '.aac': 'aac',
  '.ogg': 'ogg', '.opus': 'ogg', '.m4a': 'mov', '.mp4': 'mov', '.mov': 'mov', '.mkv': 'matroska', '.webm': 'matroska' };
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 2_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只接收 whisper.cpp 的原生毫秒偏移；缺失或倒序时停止，绝不从行号猜时间。 */
export function parseWhisperTranscription(value: string, text: string, durationMs: number): TranscriptionSegment[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new DirectError('INVALID_TRANSCRIPT_OUTPUT', '本机模型没有生成有效的时间段结果。'); }
  if (!object(parsed) || !Array.isArray(parsed.transcription) || parsed.transcription.length > 20_000) {
    throw new DirectError('INVALID_TRANSCRIPT_OUTPUT', '本机模型的时间段结构无效或超过上限。');
  }
  const segments: TranscriptionSegment[] = [];
  let previousEnd = 0;
  for (const cue of parsed.transcription) {
    if (!object(cue) || typeof cue.text !== 'string' || cue.text.includes('\0') || !object(cue.offsets)) {
      throw new DirectError('INVALID_TRANSCRIPT_OUTPUT', '转录时间段缺少原文或原生时间偏移。');
    }
    if (!cue.text.trim()) continue;
    if (Buffer.byteLength(cue.text) > 64_000) throw new DirectError('TRANSCRIPT_SEGMENT_LIMIT', '单个转录时间段原文超过分享与结果保存上限。');
    const startMs = cue.offsets.from, endMs = cue.offsets.to;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || (startMs as number) < previousEnd
      || (endMs as number) <= (startMs as number) || (endMs as number) > durationMs + 1000) {
      throw new DirectError('INVALID_TRANSCRIPT_TIMELINE', '转录时间段不在可核对的原件时间轴内。');
    }
    previousEnd = endMs as number;
    segments.push({ text: cue.text, location: { startMs: startMs as number, endMs: endMs as number, cueIndex: segments.length + 1 } });
  }
  const normalized = (input: string) => input.replace(/\r\n?/gu, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  if (!segments.length || !text.trim()) throw new DirectError('EMPTY_TRANSCRIPT', '本机模型没有生成转录原文。');
  if (normalized(segments.map(segment => segment.text).join('\n')) !== normalized(text)) {
    throw new DirectError('TRANSCRIPT_TEXT_MISMATCH', '转录文本与原生时间段的原文未能核对。');
  }
  return segments;
}

/** 平台字幕必须带原生时间片段；纯文本或缺结束时间的条目不生成伪位置。 */
export function parseSubtitleSegments(value: string, extension: string, durationMs: number): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  const append = (text: unknown, startMs: unknown, endMs: unknown, cueIndex: number) => {
    if (typeof text !== 'string' || !text.trim()) return;
    if (Buffer.byteLength(text) > 64_000) throw new DirectError('SUBTITLE_LIMIT', '单个字幕时间段原文超过本次上限。');
    const start = Number(startMs), end = Number(endMs);
    if (text.includes('\0') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || end > durationMs + 1000 || segments.length > 0 && start < segments.at(-1)!.location.startMs) {
      throw new DirectError('SUBTITLE_TIMELINE_INVALID', '平台字幕缺少可核对的原生时间段。');
    }
    if (segments.length >= 20_000) throw new DirectError('SUBTITLE_LIMIT', '字幕时间片段超过本次上限。');
    segments.push({ text: text.trim(), location: { startMs: start, endMs: end, cueIndex } });
  };
  if (extension === 'json3' || extension === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new DirectError('SUBTITLE_INVALID', '平台字幕不是有效结构化文本。'); }
    if (!object(parsed)) throw new DirectError('SUBTITLE_INVALID', '平台字幕结构无效。');
    if (Array.isArray(parsed.events)) {
      parsed.events.forEach((cue, index) => {
        if (!object(cue) || !Array.isArray(cue.segs)) return;
        const text = cue.segs.map(segment => object(segment) && typeof segment.utf8 === 'string' ? segment.utf8 : '').join('');
        append(text, cue.tStartMs, typeof cue.tStartMs === 'number' && typeof cue.dDurationMs === 'number' ? cue.tStartMs + cue.dDurationMs : NaN, index + 1);
      });
    } else if (Array.isArray(parsed.body)) {
      parsed.body.forEach((cue, index) => {
        if (!object(cue)) return;
        append(cue.content, typeof cue.from === 'number' ? Math.round(cue.from * 1000) : NaN,
          typeof cue.to === 'number' ? Math.round(cue.to * 1000) : NaN, index + 1);
      });
    } else throw new DirectError('SUBTITLE_INVALID', '平台字幕没有受支持的时间片段字段。');
  } else if (extension === 'vtt' || extension === 'srt') {
    const timestamp = (input: string) => {
      const matched = input.trim().match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/u);
      if (!matched || Number(matched[2]) > 59 || Number(matched[3]) > 59) return NaN;
      return ((Number(matched[1] ?? 0) * 60 + Number(matched[2])) * 60 + Number(matched[3])) * 1000 + Number(matched[4]);
    };
    const blocks = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split(/\n\s*\n/u);
    let index = 0;
    for (const block of blocks) {
      if (/^\s*(NOTE|STYLE|REGION)(?:\s|$)/u.test(block)) continue;
      const lines = block.split('\n'), timing = lines.findIndex(line => line.includes('-->'));
      if (timing < 0) continue;
      const match = lines[timing]!.trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u);
      if (!match) throw new DirectError('SUBTITLE_TIMELINE_INVALID', '字幕时间行无法核对。');
      const text = lines.slice(timing + 1).join('\n').replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&')
        .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&nbsp;/gu, ' ');
      append(text, timestamp(match[1]!), timestamp(match[2]!), ++index);
    }
  } else throw new DirectError('SUBTITLE_INVALID', '平台字幕格式尚未支持。');
  if (!segments.length) throw new DirectError('SUBTITLE_EMPTY', '平台字幕没有非空原文与有效时间片段。');
  return segments;
}

/** 同一内置实现供个人动作与材料适配器复用；权限和发布始终保留原任务身份。 */
export async function transcribeLocalFile(context: TaskExecutionContext, input: LocalTranscriptionInput,
  options: LocalTranscriptionOptions): Promise<LocalTranscriptionResult> {
  context.signal.throwIfAborted();
  const reference = options.files.verify(input.fileRefId);
  if (reference.kind !== 'file' || (input.fileRefVersion !== undefined && reference.version !== input.fileRefVersion)) {
    throw new DirectError('MATERIAL_REFERENCE_CHANGED', '选定的媒体原件版本已变化。');
  }
  options.assertPath(reference.invocationPath); options.assertModelPath(options.modelPath);
  if (input.destination) options.assertPath(input.destination);
  const extension = extname(reference.canonicalPath).toLowerCase(), demuxer = DEMUXERS[extension];
  if (!demuxer) throw new DirectError('UNSUPPORTED_INPUT', '转录仅接受已登记的本地音频或视频；播放列表与外部引用格式不会被读取。');
  const binaries = { ffmpeg: options.binary('ffmpeg'), ffprobe: options.binary('ffprobe'), 'whisper-cli': options.binary('whisper-cli') };
  const authority = await acquireAuthority(context, context.task.action, context.task.args, [
    fileCapability('read', reference.invocationPath), fileCapability('read', options.modelPath),
    ...Object.values(binaries).map(path => fileCapability('execute', path)),
    directoryCapability('read', options.artifactRoot), directoryCapability('write', options.artifactRoot), directoryCapability('delete', options.artifactRoot),
  ]);
  const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
  try {
    await workspace.create();
    const staged = await workspace.copyReference(reference, 'input' + extension, MAX_SOURCE_BYTES);
    const sourceFingerprint = await workspace.fingerprint(staged, MAX_SOURCE_BYTES);
    if (!sourceFingerprint.bytes || input.expectedSha256 !== undefined && sourceFingerprint.sha256 !== input.expectedSha256) {
      throw new DirectError('MATERIAL_SOURCE_MISMATCH', '转录原件为空或与保管摘要不符。');
    }
    const probe = await options.runTool(context, workspace, authority, 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
      '-format_whitelist', demuxer, '-f', demuxer, ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
      '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', staged], binaries.ffprobe, 30_000);
    options.validateProbe(probe.stdout);
    const duration = Number((JSON.parse(probe.stdout) as { format?: { duration?: unknown } }).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new DirectError('INVALID_MEDIA_DURATION', '音视频原件的实际时长未知或超过一小时，未开始转录。');
    const modelRef = options.files.register({ path: options.modelPath, source: 'user-selected', taskId: context.task.id });
    const model = await workspace.copyReference(modelRef, 'whisper-model.bin', 4 * 1024 * 1024 * 1024);
    options.validateModel(await workspace.readPrefix(model, 48));
    const wav = join(workspace.path, 'audio.wav');
    await options.runTool(context, workspace, authority, 'ffmpeg', options.convert(staged, extension, wav, 'wav'), binaries.ffmpeg, 180_000);
    const wave = await workspace.fingerprint(wav, 512 * 1024 * 1024);
    if (wave.bytes <= 44 || wave.bytes >= 512 * 1024 * 1024) throw new DirectError('INVALID_AUDIO_OUTPUT', '音频标准化没有生成完整、有效的音轨。');
    const prefix = join(workspace.path, 'transcript');
    const response = await options.runTool(context, workspace, authority, 'whisper-cli', [
      '-m', model, '-f', wav, '-l', 'auto', '-t', '4', '-p', '1', '-otxt', '-oj', '-of', prefix, '-ng',
    ], binaries['whisper-cli'], 30 * 60_000);
    if (/no tensors loaded|empty model for testing/iu.test(response.stderr)) throw new DirectError('WHISPER_TEST_MODEL', '所选文件没有模型权重，不能用于真实转录。');
    const text = await workspace.readText(prefix + '.txt', MAX_TEXT_BYTES);
    const native = await workspace.readText(prefix + '.json', MAX_TEXT_BYTES);
    const segments = parseWhisperTranscription(native, text, Math.ceil(duration * 1000));
    authority.assert(); options.files.verify(reference.id); options.files.verify(modelRef.id);
    if ((await workspace.fingerprint(staged, MAX_SOURCE_BYTES)).sha256 !== sourceFingerprint.sha256) throw new DirectError('MATERIAL_SOURCE_MISMATCH', '暂存原件在转录期间已变化。');
    const textFingerprint = await workspace.fingerprint(prefix + '.txt', MAX_TEXT_BYTES);
    const evidenceFingerprint = await workspace.fingerprint(prefix + '.json', MAX_TEXT_BYTES);
    const evidence = await workspace.publishFile(prefix + '.json', prepareDestination(join(options.artifactRoot, `transcript-evidence-${randomUUID()}.json`)),
      context.task.action, context.task.args, MAX_TEXT_BYTES);
    const output = await workspace.publishFile(prefix + '.txt', prepareDestination(input.destination ?? join(options.artifactRoot, `transcript-${randomUUID()}.txt`)),
      context.task.action, context.task.args, MAX_TEXT_BYTES);
    await workspace.cleanup();
    return { source: { fileRefId: reference.id, fileRefVersion: reference.version, sha256: sourceFingerprint.sha256 },
      textReference: { fileRefId: output.id, fileRefVersion: output.version, sha256: textFingerprint.sha256 },
      evidenceReference: { fileRefId: evidence.id, fileRefVersion: evidence.version, sha256: evidenceFingerprint.sha256 },
      text, segments, backend: 'whisper.cpp-local' };
  } catch (error) {
    if (!(error instanceof DirectError && error.unknown) && !(error instanceof DirectProcessError && error.disposition === 'unknown')) {
      try { await workspace.cleanup(); } catch (cleanupError) { await workspace.recordRetained(); throw cleanupError; }
    }
    await workspace.recordRetained(); throw error;
  }
}

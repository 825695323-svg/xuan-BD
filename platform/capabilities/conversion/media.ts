import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ConversionPayload } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError, type DirectAuthority, type DirectWorkspace } from '../../runtime/file-workspace.js';
import { runDirectProcess, DirectProcessError, type DirectBinary } from '../../runtime/process.js';
import type { ProcessRuntime } from '../../runtime/programs.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { decodeText, inspectFormat, parseXml, xmlNodes, attr, type Format } from './formats.js';

export interface BinaryOutput { name: string; bytes: Buffer; location: JsonValue }
export interface ImageOperation { rotate: number; cropX?: number; cropY?: number; cropWidth?: number; cropHeight?: number }
function dimensions(bytes: Buffer, format: Format): { width: number; height: number } {
  if (format === 'png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (format === 'webp' && bytes.length >= 30) {
    const type = bytes.subarray(12, 16).toString('ascii');
    if (type === 'VP8X') { if (bytes[20]! & 2) throw new DirectError('IMAGE_ANIMATION_REFUSED', '动态图像需要明确选帧；本动作只转换静态图片。'); return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }; }
    if (type === 'VP8 ' && bytes.subarray(23, 26).toString('hex') === '9d012a') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (type === 'VP8L' && bytes[20] === 0x2f) { const value = bytes.readUInt32LE(21); return { width: (value & 0x3fff) + 1, height: ((value >>> 14) & 0x3fff) + 1 }; }
  }
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break; while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!; if (marker === 0xd9 || marker === 0xda) break; if ([0x01, 0xd8, ...Array.from({ length: 8 }, (_, i) => 0xd0 + i)].includes(marker)) continue;
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  throw new DirectError('IMAGE_HEADER_INVALID', '静态图片尺寸无法从原件字节核对。');
}
export async function convertImage(bytes: Buffer, input: ImageOperation): Promise<{ payload: ConversionPayload; binaries: BinaryOutput[] }> {
  const format = inspectFormat(bytes, '').format;
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new DirectError('IMAGE_FORMAT_UNSUPPORTED', '旋转裁切接受按原字节核对的 PNG、JPEG、静态 WebP。');
  const declared = dimensions(bytes, format);
  if (!declared.width || !declared.height || declared.width > 20000 || declared.height > 20000 || declared.width * declared.height > 24_000_000) throw new DirectError('IMAGE_PIXEL_LIMIT', '图片超过本次 2400 万像素预算。');
  if (![0, 90, 180, 270].includes(input.rotate)) throw new DirectError('IMAGE_ROTATION_INVALID', '旋转角度需明确选择 0、90、180 或 270 度。');
  const { loadImage, createCanvas } = await import('@napi-rs/canvas'), image = await loadImage(bytes);
  const cropped = [input.cropX, input.cropY, input.cropWidth, input.cropHeight], enabled = cropped.some(value => value !== undefined);
  const [x, y, width, height] = enabled ? cropped : [0, 0, image.width, image.height];
  if ([x, y, width, height].some(value => !Number.isSafeInteger(value)) || x! < 0 || y! < 0 || width! < 1 || height! < 1 || x! + width! > image.width || y! + height! > image.height) throw new DirectError('IMAGE_CROP_INVALID', '裁切需提供完整整数矩形，且位于解码后的原图范围内。');
  const swap = input.rotate === 90 || input.rotate === 270, canvas = createCanvas(swap ? height! : width!, swap ? width! : height!), context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(input.rotate * Math.PI / 180);
  context.drawImage(image, x!, y!, width!, height!, -width! / 2, -height! / 2, width!, height!);
  const output = await canvas.encode('png'), location = { coordinateSystem: 'decoded-image-pixels/top-left', sourceWidth: image.width, sourceHeight: image.height,
    crop: { x: x!, y: y!, width: width!, height: height! }, clockwiseRotation: input.rotate, outputWidth: canvas.width, outputHeight: canvas.height };
  return { payload: { status: 'complete', issues: [], content: { format: 'png', location, operationOrder: 'crop-then-clockwise-rotate' } }, binaries: [{ name: 'image.png', bytes: output, location }] };
}

function timestamp(value: string, centiseconds = false): number {
  const matched = value.match(centiseconds ? /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/u : /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/u);
  if (!matched || Number(matched[2]) > 59 || Number(matched[3]) > 59) throw new DirectError('SUBTITLE_TIME_INVALID', '字幕原生时间戳无效。');
  const result = ((Number(matched[1] ?? 0) * 60 + Number(matched[2])) * 60 + Number(matched[3])) * 1000 + Number(matched[4]) * (centiseconds ? 10 : 1);
  if (!Number.isSafeInteger(result)) throw new DirectError('SUBTITLE_TIME_INVALID', '字幕时间戳超过可表示范围。'); return result;
}
export function subtitleNative(bytes: Buffer, name: string, encoding?: string): ConversionPayload {
  const decoded = decodeText(bytes, encoding), original = decoded.text, cues: JsonValue[] = [], unresolvedCues: JsonValue[] = [], issues: ConversionPayload['issues'] = [];
  const append = (entry: Record<string, JsonValue>, startMs: number, endMs: number) => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || cues.length >= 20_000) throw new DirectError('SUBTITLE_TIME_INVALID', '字幕时间范围无效或超过本次时间片段预算。');
    cues.push({ ...entry, cueIndex: cues.length + 1, startMs, endMs });
  };
  if (/\.(ass|ssa)$/iu.test(name)) {
    let inEvents = false, fields: string[] = [];
    const lines = original.split(/\r\n|\n|\r/u);
    lines.forEach((line, index) => {
      if (/^\[.*\]$/u.test(line)) { inEvents = line.toLowerCase() === '[events]'; return; }
      if (!inEvents) return;
      if (/^Format:/iu.test(line)) { fields = line.slice(line.indexOf(':') + 1).split(',').map(value => value.trim().toLowerCase()); return; }
      if (!/^Dialogue:/iu.test(line)) return;
      if (!fields.length || fields.at(-1) !== 'text' || !fields.includes('start') || !fields.includes('end')) throw new DirectError('SUBTITLE_FORMAT_INVALID', 'ASS/SSA 缺少明确事件字段声明。');
      const values: string[] = []; let rest = line.slice(line.indexOf(':') + 1);
      for (let i = 0; i < fields.length - 1; i++) { const comma = rest.indexOf(','); if (comma < 0) throw new DirectError('SUBTITLE_FORMAT_INVALID', '字幕事件字段数量不足。'); values.push(rest.slice(0, comma)); rest = rest.slice(comma + 1); } values.push(rest);
      append({ raw: line, line: index + 1, text: values.at(-1)!, fields: fields.map((field, i) => ({ name: field, raw: values[i]! })) }, timestamp(values[fields.indexOf('start')]!.trim(), true), timestamp(values[fields.indexOf('end')]!.trim(), true));
    });
  } else if (/\.(ttml|dfxp)$/iu.test(name) || /^\s*<\??/u.test(original)) {
    const doc = parseXml(original);
    const ttmlTime = (value: string): number => {
      const offset = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/u);
      return offset ? Number(offset[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[offset[2]!]! : timestamp(value);
    };
    for (const node of xmlNodes(doc, 'p')) {
      const begin = attr(node, 'begin'), end = attr(node, 'end'), duration = attr(node, 'dur');
      const ancestors: JsonValue[] = []; let inherited = false;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const declarations = Array.from(ancestor.attributes).filter(value => ['begin', 'end', 'dur', 'timeContainer', 'timeBase', 'frameRate', 'frameRateMultiplier', 'tickRate'].includes(value.name.split(':').at(-1)!))
          .map(value => ({ name: value.name, value: value.value }));
        if (declarations.length) ancestors.push({ tag: ancestor.tagName, declarations });
        if (declarations.some(value => ['begin', 'end', 'dur'].includes(value.name.split(':').at(-1)!) || value.name.split(':').at(-1) === 'timeContainer' && value.value === 'seq'
          || value.name.split(':').at(-1) === 'timeBase' && value.value !== 'media')) inherited = true;
      }
      const originalTiming = { begin, end, duration, ancestors };
      if (attr(node, 'timeContainer') === 'seq' || Array.from(node.querySelectorAll('*')).some(child => ['begin', 'end', 'dur', 'timeContainer'].some(key => attr(child, key) !== null))) inherited = true;
      if (inherited || begin === null || end === null && duration === null) {
        issues.push({ code: 'TTML_INHERITED_TIMING_UNSUPPORTED', message: '此字幕片段依赖祖先时间或继承时基；保留原始声明和 XML，不发布猜测的绝对时间。' });
        unresolvedCues.push({ text: node.textContent ?? '', rawXml: node.outerHTML, originalTiming, reason: 'inherited-timeline-not-resolved' }); continue;
      }
      try {
        const start = ttmlTime(begin); append({ text: node.textContent ?? '', rawXml: node.outerHTML, originalTiming }, start, end !== null ? ttmlTime(end) : start + ttmlTime(duration!));
      } catch (error) {
        if (!(error instanceof DirectError)) throw error;
        issues.push({ code: 'TTML_TIMEBASE_UNSUPPORTED', message: '此字幕时间表达无法按已支持时基核对；原始声明保留，未发布推测时间。' });
        unresolvedCues.push({ text: node.textContent ?? '', rawXml: node.outerHTML, originalTiming, reason: 'native-time-expression-not-resolved' });
      }
    }
  } else {
    const normalized = original.replace(/\r\n|\r/gu, '\n'); let offset = 0;
    for (const block of normalized.split(/(\n{2,})/u)) {
      const blockOffset = offset; offset += block.length;
      if (/^\n{2,}$/u.test(block)) continue;
      if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/u.test(block)) continue;
      const lines = block.split('\n'), timing = lines.findIndex(line => line.includes('-->'));
      if (timing < 0) continue;
      const matched = lines[timing]!.match(/^(\S+)\s+-->\s+(\S+)(.*)$/u);
      if (!matched) throw new DirectError('SUBTITLE_FORMAT_INVALID', '字幕时间行无效。');
      append({ id: timing > 0 ? lines.slice(0, timing).join('\n') : null, text: lines.slice(timing + 1).join('\n'), settings: matched[3]!, rawNormalizedBlock: block,
        location: { normalizedUtf16Offset: blockOffset } }, timestamp(matched[1]!), timestamp(matched[2]!));
    }
  }
  if (!cues.length && !issues.length) throw new DirectError('SUBTITLE_EMPTY', '字幕没有可解析的原生时间片段。');
  return { status: issues.length ? 'partial' : 'complete', issues, content: { format: 'native-subtitle-cues', originalText: original, encoding: decoded.encoding,
    textPolicy: 'native-markup-and-whitespace-retained', cues, unresolvedCues } };
}

const MEDIA_DEMUXERS: Partial<Record<Format, string>> = { wav: 'wav', mp3: 'mp3', flac: 'flac', aac: 'aac', ogg: 'ogg', mp4: 'mov', matroska: 'matroska', aiff: 'aiff' };
export interface MediaSelection { format: 'wav' | 'mp3' | 'mp4'; track: number; startMs: number; endMs: number }
export async function convertMedia(context: TaskExecutionContext, workspace: DirectWorkspace, authority: DirectAuthority, runtime: ProcessRuntime,
  source: string, sourceFormat: Format, selection: MediaSelection): Promise<{ output: string; payload: ConversionPayload }> {
  const demuxer = MEDIA_DEMUXERS[sourceFormat]; if (!demuxer) throw new DirectError('MEDIA_FORMAT_UNSUPPORTED', '本轮选段只接受按字节核对的独立音视频容器。');
  if (!['wav', 'mp3', 'mp4'].includes(selection.format) || !Number.isSafeInteger(selection.track) || selection.track < 0 || selection.track > 63
    || !Number.isSafeInteger(selection.startMs) || !Number.isSafeInteger(selection.endMs) || selection.startMs < 0 || selection.endMs <= selection.startMs || selection.endMs - selection.startMs > 3600000) throw new DirectError('MEDIA_SELECTION_INVALID', '音轨索引和毫秒范围需明确提供；单段最多一小时。');
  const input = ['-protocol_whitelist', 'file', '-format_whitelist', demuxer, '-f', demuxer,
    ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : [])];
  const tool = async (binary: DirectBinary, argv: string[], timeout: number) => {
    const path = runtime.path(binary), effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '执行本任务受控媒体转换', operation: { binary } });
    try {
      const output = await runDirectProcess({ runtime, binary, binaryPath: path, args: argv, cwd: workspace.path, signal: context.signal, timeoutMs: timeout, maxOutputBytes: 1_000_000,
        assertAuthorized: () => { authority.assert(); workspace.assertCurrent(); if (runtime.path(binary) !== path) throw new DirectError('TOOL_CHANGED', '媒体程序绑定已变化。'); },
        onProcessState: event => context.emit({ type: 'process_state', ...event }), onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }) });
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '受控媒体进程和输出流已收束。' }); return output;
    } catch (error) {
      if (!(error instanceof DirectProcessError && error.disposition === 'unknown')) await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '媒体进程已收束，尚未发布目标。' });
      throw error;
    }
  };
  const probe = await tool('ffprobe', ['-v', 'error', ...input, '-show_entries', 'format=duration:stream=index,codec_type,duration,start_time,channels,sample_rate', '-of', 'json', source], 30000);
  const metadata = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: { index: number; codec_type: string }[] };
  const durationMs = Number(metadata.format?.duration) * 1000, streams = metadata.streams;
  if (!Array.isArray(streams) || !streams.length || !Number.isFinite(durationMs) || selection.endMs > durationMs + 1) throw new DirectError('MEDIA_TIMELINE_UNVERIFIED', '实际容器时长未知或所选范围超出原件。');
  const stream = streams.find(value => value.index === selection.track);
  if (!stream || stream.codec_type !== 'audio') throw new DirectError('MEDIA_TRACK_INVALID', '指定索引不是原件中的音轨。');
  if (selection.format === 'mp4' && !streams.some(value => value.codec_type === 'video')) throw new DirectError('MEDIA_TRACK_INVALID', '所选 MP4 输出需要原件中的视频轨。');
  const output = join(workspace.path, 'segment.' + selection.format), common = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', ...input, '-i', source,
    '-ss', String(selection.startMs / 1000), '-t', String((selection.endMs - selection.startMs) / 1000), '-map_metadata', '-1', '-threads', '2', '-fs', '128000000'];
  const codecs = selection.format === 'wav' ? ['-map', `0:${selection.track}`, '-vn', '-c:a', 'pcm_s16le', '-f', 'wav'] : selection.format === 'mp3'
    ? ['-map', `0:${selection.track}`, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3']
    : ['-map', '0:v:0', '-map', `0:${selection.track}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4'];
  await tool('ffmpeg', [...common, ...codecs, output], 180000);
  const outputProbe = await tool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=index,codec_type', '-of', 'json', output], 30000);
  const observed = JSON.parse(outputProbe.stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] }, observedMs = Number(observed.format?.duration) * 1000;
  if (!Number.isFinite(observedMs) || observedMs <= 0 || Math.abs(observedMs - (selection.endMs - selection.startMs)) > 1500 || !observed.streams?.some(value => value.codec_type === 'audio')) throw new DirectError('MEDIA_OUTPUT_UNVERIFIED', '媒体输出时长或音轨未能核对。');
  return { output, payload: { status: 'complete', issues: [], content: { format: selection.format, sourceProbe: metadata as unknown as JsonValue,
    sourceLocation: { streamIndex: selection.track, startMs: selection.startMs, endMs: selection.endMs }, outputProbe: observed as unknown as JsonValue,
    observedDurationMs: observedMs, timingPrecision: 'container/codec-timebase; re-encoded segment; output duration verified within 1500ms' } } };
}

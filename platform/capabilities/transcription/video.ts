import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import type { TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, directoryCapability, fileCapability, DirectError, DirectWorkspace, prepareDestination, type DirectAuthority } from '../../runtime/file-workspace.js';
import { assertPublicWebAddress, pinnedGet, resolvePublic, validatePublicWebUrl } from '../browser/public-web.js';
import { createVideoProxy } from './network.js';
import { DirectProcessError, type DirectBinary, type DirectProcessResult } from '../../runtime/process.js';
import { parseSubtitleSegments, parseWhisperTranscription, transcriptionSegmentPreview, type TranscriptionSegment } from './local.js';

interface VideoOptions {
  files: FileReferenceService; artifactRoot: string; modelPath?: string; maxMinutes: number; maxBytes: number;
  runTool(context: TaskExecutionContext, workspace: DirectWorkspace, authority: DirectAuthority, binary: DirectBinary, args: string[], path: string, timeout?: number): Promise<DirectProcessResult>;
  convert(input: string, extension: string, output: string, format: string): string[];
  validateModel(header: Buffer): void;
  validateProbe(value: string, maxSeconds?: number): void;
  assertPath(path: string): void;
  binary(name: 'whisper-cli' | 'ffmpeg' | 'ffprobe' | 'yt-dlp'): string;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateVideoUrl(value: string): URL {
  const url = validatePublicWebUrl(value), host = url.hostname.toLowerCase();
  const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host);
  const bilibili = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host);
  if ((!youtube && !bilibili) || (url.searchParams.has('list') && !url.searchParams.has('v'))) throw new DirectError('VIDEO_URL_UNSUPPORTED', '请提供单个公开视频的 YouTube 或哔哩哔哩链接。');
  return url;
}


/** 只取公开视频元数据、字幕和一个 HTTPS 音轨。不会执行远端脚本、加载用户插件或使用登录状态。 */
export async function transcribeVideo(context: TaskExecutionContext, rawUrl: string, options: VideoOptions): Promise<TaskResult> {
  const tool = options.binary;
  const originalUrl = validateVideoUrl(rawUrl), yt = tool('yt-dlp');
  const url = originalUrl.hostname === 'b23.tv' ? await resolveVideoShortLink(context, originalUrl) : originalUrl;
  const authority = await acquireAuthority(context, 'video.prepare', { url: url.href }, [fileCapability('execute', yt),
    directoryCapability('read', options.artifactRoot), directoryCapability('write', options.artifactRoot), directoryCapability('delete', options.artifactRoot)]);
  const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
  try {
    await workspace.create();
    await context.emit({ type: 'progress', message: '正在读取视频信息，优先查找已有字幕', progress: 0.1 });
    const proxy = await createVideoProxy(context, 16 * 1024 * 1024);
    let metadataText: string;
    try {
      metadataText = (await options.runTool(context, workspace, authority, 'yt-dlp', [
        '--ignore-config', '--no-plugin-dirs', '--no-js-runtimes', '--no-remote-components', '--no-cache-dir',
        '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--no-progress', '--no-check-formats',
        '--no-cookies', '--no-cookies-from-browser', '--no-update', '--socket-timeout', '300',
        '--retries', '0', '--extractor-retries', '0', '--use-extractors', 'youtube$,bilibili$',
        '--proxy', proxy.url, '--', url.href,
      ], yt, 10 * 60_000)).stdout;
    } finally { await proxy.close(); }
    let metadata: unknown;
    try { metadata = JSON.parse(metadataText); } catch { throw new DirectError('VIDEO_METADATA_INVALID', '视频平台没有返回可核对的信息。'); }
    if (!object(metadata) || ('entries' in metadata) || metadata.is_live === true || metadata.live_status === 'is_live') throw new DirectError('VIDEO_UNSUPPORTED', '当前处理单个已结束的公开视频，直播和播放列表不支持。');
    const duration = Number(metadata.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > options.maxMinutes * 60) throw new DirectError('VIDEO_DURATION_LIMIT', `视频时长未知或超过当前 ${options.maxMinutes} 分钟上限。`);
    const title = String(metadata.title ?? '视频').slice(0, 300);
    const subtitle = chooseSubtitle(metadata);
    let text: string, method: string, sourcePath: string, sourceExtension: string, evidencePath: string;
    let segments: TranscriptionSegment[];
    if (subtitle) {
      const bytes = await downloadPublicBytes(context, subtitle.url, 4 * 1024 * 1024, url);
      segments = parseSubtitleSegments(new TextDecoder('utf-8', { fatal: true }).decode(bytes), subtitle.ext, Math.ceil(duration * 1000));
      text = segments.map(segment => segment.text).join('\n');
      sourceExtension = '.' + subtitle.ext;
      sourcePath = await workspace.createBytes('subtitle-source' + sourceExtension, bytes); evidencePath = sourcePath;
      method = subtitle.automatic ? 'platform-automatic-subtitles' : 'platform-subtitles';
    } else {
      if (!options.modelPath) throw new DirectError('WHISPER_MODEL_UNAVAILABLE', '视频没有可用字幕，内置语音模型资源尚未就绪；请核对应用资源清单。');
      options.assertPath(options.modelPath);
      const media = chooseAudio(metadata);
      if (!media) throw new DirectError('VIDEO_AUDIO_UNSUPPORTED', '视频未提供可直接读取的 HTTPS 音轨；当前不处理加密、登录、播放列表或分段流。');
      if (typeof media.filesize === 'number' && media.filesize > options.maxBytes) throw new DirectError('VIDEO_SIZE_LIMIT', '视频音轨超过当前下载大小上限。');
      const local = await acquireAuthority(context, 'video.local_transcription', { url: url.href, modelPath: options.modelPath }, [
        fileCapability('read', options.modelPath), ...(['ffmpeg', 'ffprobe', 'whisper-cli'] as const).map((name) => fileCapability('execute', tool(name))),
      ]);
      const combined: DirectAuthority = { ...authority, assert: () => { authority.assert(); local.assert(); } };
      await context.emit({ type: 'progress', message: '没有平台字幕，正在下载音轨供本机转录', progress: 0.3 });
      const bytes = await downloadPublicBytes(context, String(media.url), options.maxBytes, url);
      const extension = '.' + String(media.ext), input = await workspace.createBytes('audio-source' + extension, bytes);
      sourcePath = input; sourceExtension = extension;
      const demuxer = ['.m4a', '.mp4'].includes(extension) ? 'mov' : extension === '.webm' ? 'matroska' : 'mp3';
      const probe = await options.runTool(context, workspace, combined, 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', demuxer, '-f', demuxer,
        ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input], tool('ffprobe'), 30_000);
      options.validateProbe(probe.stdout, options.maxMinutes * 60);
      const actualDuration = Number((JSON.parse(probe.stdout) as { format?: { duration?: string } }).format?.duration);
      if (!Number.isFinite(actualDuration) || actualDuration <= 0 || actualDuration > options.maxMinutes * 60) throw new DirectError('VIDEO_DURATION_LIMIT', '实际音轨时长未知或超过配置上限。');
      const reference = options.files.register({ path: options.modelPath, source: 'user-selected', taskId: context.task.id });
      const model = await workspace.copyReference(reference, 'model.bin', 4 * 1024 * 1024 * 1024, local);
      local.assert(); options.validateModel(await workspace.readPrefix(model, 48));
      const wav = join(workspace.path, 'audio.wav');
      await options.runTool(context, workspace, combined, 'ffmpeg', options.convert(input, extension, wav, 'wav'), tool('ffmpeg'), 180_000);
      const prefix = join(workspace.path, 'transcript');
      await context.emit({ type: 'progress', message: '正在本机识别语音', progress: 0.6 });
      const response = await options.runTool(context, workspace, combined, 'whisper-cli', ['-m', model, '-f', wav, '-l', 'auto', '-t', '4', '-p', '1', '-otxt', '-oj', '-of', prefix, '-ng'], tool('whisper-cli'), 30 * 60_000);
      if (/no tensors loaded|empty model for testing/iu.test(response.stderr)) throw new DirectError('WHISPER_TEST_MODEL', '语音模型没有有效权重。');
      text = await workspace.readText(prefix + '.txt'); method = 'whisper.cpp-local';
      evidencePath = prefix + '.json';
      segments = parseWhisperTranscription(await workspace.readText(evidencePath), text, Math.ceil(actualDuration * 1000));
    }
    if (!text.trim()) throw new DirectError('VIDEO_EMPTY_TRANSCRIPT', '视频没有生成可用文字。');
    // Whisper 已有 transcript.txt；不再为同一内容额外写临时副本。
    const transcript = subtitle ? await workspace.createText('video-text.txt', text) : join(workspace.path, 'transcript.txt');
    const sourceFingerprint = await workspace.fingerprint(sourcePath, options.maxBytes);
    const evidenceFingerprint = await workspace.fingerprint(evidencePath, 4 * 1024 * 1024);
    const textFingerprint = await workspace.fingerprint(transcript, 4 * 1024 * 1024);
    // 视频链接仅保留来源地址和音轨摘要；下载音轨只是转写暂存，不发布成长久文件。
    // 平台原生字幕仍属于不可替代的文字证据，按原方式保留引用。
    const sourceReference = subtitle ? await workspace.publishFile(sourcePath,
      prepareDestination(join(options.artifactRoot, `video-source-${randomUUID()}${sourceExtension}`)),
      context.task.action, context.task.args, options.maxBytes) : null;
    const evidenceReference = evidencePath === sourcePath && sourceReference ? sourceReference
      : await workspace.publishFile(evidencePath, prepareDestination(join(options.artifactRoot, `video-evidence-${randomUUID()}.json`)), context.task.action, context.task.args, 4 * 1024 * 1024);
    const published = await workspace.publishFile(transcript, prepareDestination(join(options.artifactRoot, `video-${randomUUID()}.txt`)), 'video.transcribe_url', { url: url.href }, 4 * 1024 * 1024);
    await workspace.cleanup();
    return { summary: `已提取“${title}”的文字。`, artifactIds: [...new Set([...(sourceReference ? [sourceReference.id] : []), evidenceReference.id, published.id])], data: { title, url: url.href, duration, method,
      source: sourceReference ? { fileRefId: sourceReference.id, fileRefVersion: sourceReference.version, sha256: sourceFingerprint.sha256 }
        : { kind: 'remote-audio-temporary', url: url.href, sha256: sourceFingerprint.sha256,
          byteLength: sourceFingerprint.bytes, localRetained: false },
      textReference: { fileRefId: published.id, fileRefVersion: published.version, sha256: textFingerprint.sha256 },
      evidenceReference: { fileRefId: evidenceReference.id, fileRefVersion: evidenceReference.version, sha256: evidenceFingerprint.sha256 },
      ...JSON.parse(JSON.stringify(transcriptionSegmentPreview(segments))), sha256: textFingerprint.sha256,
      text: text.slice(0, 16_000), characterCount: text.length, truncated: text.length > 16_000, fileRefId: published.id, modelCalls: 0 } };
  } catch (error) {
    if (!(error instanceof DirectError && error.unknown) && !(error instanceof DirectProcessError && error.disposition === 'unknown')) {
      try { await workspace.cleanup(); } catch { await workspace.recordRetained(); throw new DirectError('VIDEO_CLEANUP_UNKNOWN', '视频处理已结束，暂存清理尚未核对。', true); }
    }
    await workspace.recordRetained(); throw error;
  }
}

function chooseSubtitle(metadata: ObjectValue): { url: string; ext: string; automatic: boolean } | null {
  for (const key of ['subtitles', 'automatic_captions']) {
    const languages = metadata[key]; if (!object(languages)) continue;
    for (const language of Object.keys(languages).sort((a, b) => (a.startsWith('zh') ? 0 : a.startsWith('en') ? 1 : 2) - (b.startsWith('zh') ? 0 : b.startsWith('en') ? 1 : 2))) {
      const tracks = languages[language]; if (!Array.isArray(tracks)) continue;
      for (const ext of ['json3', 'json', 'vtt', 'srt']) {
        const track = tracks.find((entry) => object(entry) && entry.ext === ext && typeof entry.url === 'string' && entry.url.startsWith('https://'));
        if (object(track)) return { url: String(track.url), ext, automatic: key === 'automatic_captions' };
      }
    }
  }
  return null;
}
function chooseAudio(metadata: ObjectValue): ObjectValue | undefined {
  if (!Array.isArray(metadata.formats)) return undefined;
  return metadata.formats.filter((entry): entry is ObjectValue => object(entry) && typeof entry.url === 'string' && entry.url.startsWith('https://')
    && entry.protocol === 'https' && entry.acodec !== 'none' && entry.vcodec === 'none' && !entry.has_drm && ['m4a', 'mp4', 'webm', 'mp3'].includes(String(entry.ext)))
    .sort((a, b) => Number(a.abr ?? a.tbr ?? 128) - Number(b.abr ?? b.tbr ?? 128))[0];
}
export function subtitleText(value: string, extension: string): string {
  if (extension === 'json3' || extension === 'json') {
    const parsed: unknown = JSON.parse(value);
    if (!object(parsed)) throw new DirectError('SUBTITLE_INVALID', '字幕格式无法读取。');
    if (Array.isArray(parsed.events)) return parsed.events.flatMap((event) => object(event) && Array.isArray(event.segs)
      ? [event.segs.map((segment) => object(segment) && typeof segment.utf8 === 'string' ? segment.utf8 : '').join('')] : []).join('\n').trim();
    if (Array.isArray(parsed.body)) return parsed.body.map((entry) => object(entry) && typeof entry.content === 'string' ? entry.content : '').filter(Boolean).join('\n');
    throw new DirectError('SUBTITLE_INVALID', '字幕内容字段无法读取。');
  }
  const lines = value.replace(/\r/gu, '').split('\n'), result: string[] = [];
  for (const line of lines) {
    if (!line.trim() || /^(WEBVTT|NOTE|Kind:|Language:|\d+$)/u.test(line.trim()) || line.includes('-->')) continue;
    const text = line.replace(/<[^>]*>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&nbsp;/gu, ' ').trim();
    if (text && result.at(-1) !== text) result.push(text);
  }
  return result.join('\n');
}
async function downloadPublicBytes(context: TaskExecutionContext, value: string, maximum: number, source: URL): Promise<Buffer> {
  let url = new URL(value); const visited = new Set<string>();
  const timeout = AbortSignal.timeout(10 * 60_000), signal = AbortSignal.any([context.signal, timeout]);
  for (let hop = 0; hop <= 3; hop++) {
    // Signed CDN query strings are needed for public media, but never enter logs or task results.
    if (url.username || url.password || url.protocol !== 'https:' || (url.port && url.port !== '443') || visited.has(url.href)) throw new DirectError('VIDEO_NETWORK_REFUSED', '视频资源地址不受支持。');
    validatePublicWebUrl(url.origin); visited.add(url.href);
    const authority = await acquireAuthority({ ...context, signal }, 'video.download.' + hop, { origin: url.origin }, [{ action: 'network', target: { kind: 'network', origin: url.origin } }]);
    const addresses = await resolvePublic(url.hostname, signal); addresses.forEach(assertPublicWebAddress);
    if (!addresses.length || addresses.length > 32) throw new DirectError('VIDEO_DNS_FAILED', '视频资源未解析到公开地址。');
    const effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '读取一次已批准的公开视频资源', operation: { origin: url.origin } });
    let response: Awaited<ReturnType<typeof pinnedGet>> | undefined, failure: unknown, next: URL | undefined, output: Buffer | undefined;
    try {
      response = await pinnedGet({ url, headers: { accept: '*/*', referer: source.href, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }, address: addresses.find((entry) => entry.family === 4) ?? addresses[0]!, signal, assertAuthorized: () => { signal.throwIfAborted(); authority.assert(); } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.location;
        if (hop === 3 || typeof target !== 'string') throw new DirectError('VIDEO_REDIRECT_LIMIT', '视频资源重定向次数超限。');
        next = new URL(target, url);
      } else {
        if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new DirectError('VIDEO_DOWNLOAD_FAILED', '平台没有返回完整可读资源。');
        const declared = response.headers['content-length'];
        if (declared && (typeof declared !== 'string' || !/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new DirectError('VIDEO_SIZE_LIMIT', '视频资源超过本次大小上限。');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response.body) { signal.throwIfAborted(); authority.assert(); size += chunk.byteLength;
          if (size > maximum) throw new DirectError('VIDEO_SIZE_LIMIT', '视频资源超过本次大小上限。'); chunks.push(Buffer.from(chunk)); }
        if (!size || declared && Number(declared) !== size) throw new DirectError('VIDEO_INCOMPLETE', '视频资源为空或下载不完整。');
        output = Buffer.concat(chunks);
      }
    } catch (error) { failure = error; }
    finally { if (response) { try { await response.close(); } catch { throw new DirectError('VIDEO_NETWORK_UNKNOWN', '视频网络资源关闭未确认。', true); } } }
    await context.emit({ type: 'side_effect_result', effectId, outcome: failure ? 'failed' : 'succeeded', evidence: '本次网络读取与自有资源已收束；只在完整内容核对后继续。' });
    if (failure) throw failure;
    if (output) return output;
    url = next!;
  }
  throw new DirectError('VIDEO_DOWNLOAD_FAILED', '视频资源没有下载完成。');
}

async function resolveVideoShortLink(context: TaskExecutionContext, original: URL): Promise<URL> {
  let current = original;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
  for (let hop = 0; hop < 3; hop++) {
    const authority = await acquireAuthority({ ...context, signal }, 'video.shortlink.' + hop, { origin: current.origin }, [{ action: 'network', target: { kind: 'network', origin: current.origin } }]);
    const addresses = await resolvePublic(current.hostname, signal); addresses.forEach(assertPublicWebAddress);
    if (!addresses.length || addresses.length > 32) throw new DirectError('VIDEO_DNS_FAILED', '短链接没有解析到公开地址。');
    const effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '核对公开视频短链接的跳转目标', operation: { origin: current.origin } });
    let response: Awaited<ReturnType<typeof pinnedGet>> | undefined, target: URL | undefined, failure: unknown;
    try {
      response = await pinnedGet({ url: current, address: addresses.find((entry) => entry.family === 4) ?? addresses[0]!, signal, assertAuthorized: () => { signal.throwIfAborted(); authority.assert(); } });
      if (![301, 302, 303, 307, 308].includes(response.status) || typeof response.headers.location !== 'string') throw new DirectError('VIDEO_SHORTLINK_FAILED', '短链接没有返回可核对的视频跳转，请使用完整视频链接。');
      target = validateVideoUrl(new URL(response.headers.location, current).href);
    } catch (error) { failure = error; }
    finally { if (response) { try { await response.close(); } catch { throw new DirectError('VIDEO_NETWORK_UNKNOWN', '视频短链接网络资源关闭未确认。', true); } } }
    await context.emit({ type: 'side_effect_result', effectId, outcome: failure ? 'failed' : 'succeeded', evidence: '短链接响应与网络资源已收束，跳转目标已核对。' });
    if (failure) throw failure;
    if (target!.hostname !== 'b23.tv') return target!;
    current = target!;
  }
  throw new DirectError('VIDEO_REDIRECT_LIMIT', '短链接跳转次数超过上限，请提供完整视频链接。');
}

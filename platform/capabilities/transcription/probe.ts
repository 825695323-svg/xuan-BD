import { DirectError } from '../../runtime/file-workspace.js';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const seconds = (v: unknown) => typeof v === 'number' || typeof v === 'string' && /^-?\d+(?:\.\d+)?$/u.test(v) ? Number(v) : NaN;

/** ffmpeg maps 0:a:0. Read that same stream from the frozen probe, in stream order. */
export function transcriptionProbe(stdout: string, requireVideoClock: boolean) {
  const probe: unknown = JSON.parse(stdout);
  if (!record(probe) || !record(probe.format) || !Array.isArray(probe.streams))
    throw new DirectError('INVALID_MEDIA_PROBE', '媒体探测结果缺少容器或流信息。');
  const audio = probe.streams.find(stream => record(stream) && stream.codec_type === 'audio');
  if (!audio) throw new DirectError('MEDIA_NO_AUDIO_STREAM', '原件没有音轨，无法转录。');
  const duration = seconds(probe.format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    throw new DirectError('INVALID_MEDIA_DURATION', '原件时长未知或超过一小时。');
  const durationMs = Math.ceil(duration * 1000);
  const hasVideo = probe.streams.some(stream => record(stream) && stream.codec_type === 'video'
    && !(record(stream.disposition) && stream.disposition.attached_pic === 1));
  if (!hasVideo) return { durationMs, media: null };
  if (!requireVideoClock) throw new DirectError('INVALID_MEDIA_TIMELINE', '旧视频探测回执缺少原件与音轨的时间轴绑定。');
  const start = seconds(probe.format.start_time), audioStart = seconds(audio.start_time);
  if (!Number.isFinite(start) || !Number.isFinite(audioStart) || !Number.isSafeInteger(audio.index) || audio.index < 0
    || typeof audio.codec_name !== 'string' || !audio.codec_name || typeof probe.format.format_name !== 'string' || !probe.format.format_name
    || audioStart - start < -0.001 || audioStart - start >= duration)
    throw new DirectError('INVALID_MEDIA_TIMELINE', '视频容器与选定音轨的原生时间轴未能核对。');
  return { durationMs, media: { container: probe.format.format_name, audioCodec: audio.codec_name as string,
    audioStreamIndex: Number(audio.index), audioStartMs: Math.round((audioStart - start) * 1000),
    timeline: 'container_relative_wav' as const } };
}

import type { SkillRegistration } from '../../../platform/plugins/registry.js';
import type { TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import type { MaterialEnvelope } from './contracts.js';
import type { SkillAvailability } from '../../../contracts/skill-contracts.js';

export type MaterialMediaPluginId = 'material.ocr' | 'material.transcribe';
/** 由受信宿主从已保管原件取得；不接受材料正文提供的路径或命令。 */
export type MaterialMediaSourceReference = Pick<MaterialEnvelope, 'materialId' | 'fileRefId' | 'fileRefVersion' | 'sha256'>;

export interface MaterialOcrSegment {
  text: string;
  /** 页码从 1 开始；区域按左上原点、0 到 1 的归一化坐标表示。 */
  location: { page: number; region?: { x: number; y: number; width: number; height: number } };
}
export interface MaterialTranscriptionSegment {
  text: string;
  /** 原件时间轴毫秒，从 0 开始、结束点不包含；字幕序号从 1 开始。 */
  location: { startMs: number; endMs: number; cueIndex?: number };
}
export type MaterialMediaTextResult = {
  source: MaterialMediaSourceReference;
  /** 抽取原文另存为受控结果文件，不覆盖原件；不是模型语义结论。 */
  textReference: { fileRefId: string; fileRefVersion: number; sha256: string };
  /** 组件原生时间段输出另存，不把进度输出或模型推断当作定位证据。 */
  evidenceReference?: { fileRefId: string; fileRefVersion: number; sha256: string };
  /** 完整时间段留在原生输出；有界任务结果明确返回截断状态。 */
  segmentCount?: number;
  segmentsTruncated?: boolean;
} & (
  { plugin: { id: 'material.ocr'; version: string }; segments: MaterialOcrSegment[] }
  | { plugin: { id: 'material.transcribe'; version: string }; segments: MaterialTranscriptionSegment[] }
);
export type MaterialMediaOutcome =
  | { status: 'extracted'; result: MaterialMediaTextResult }
  | { status: 'not_configured' | 'empty' | 'failed' | 'cancelled'; reason: string; code?: string; result: null };

/** 由受信宿主绑定；权限、操作编号和取消复用当前任务，不另建推理循环。 */
export interface MaterialMediaAdapter {
  readonly id: MaterialMediaPluginId;
  readonly version: string;
  readonly acceptedFormats: readonly ('image' | 'pdf' | 'audio' | 'video')[];
  availability(): SkillAvailability;
  execute(source: MaterialMediaSourceReference, context: TaskExecutionContext): Promise<MaterialMediaOutcome>;
}
export interface MaterialMediaPluginDescriptor {
  id: MaterialMediaPluginId;
  version: string;
  title: string;
  description: string;
  status: 'configured' | 'unavailable' | 'not_configured';
  available: boolean;
  reason: string;
  adapter: { id: string; version: string } | null;
  acceptedFormats: ('image' | 'pdf' | 'audio' | 'video')[];
  reservedFormats: ('image' | 'pdf' | 'audio' | 'video')[];
  localOnly: true;
}

const mediaPlugins: readonly MaterialMediaPluginDescriptor[] = [
  { id: 'material.ocr', version: '1', title: '材料 OCR（文字识别）接口',
    description: '为当前消息原件的图片或 PDF（便携文档）文字识别保留插件入口；未来结果须保留页码、区域和原件摘要。当前未接入组件，不能执行抽取。',
    status: 'not_configured', available: false, reason: 'OCR（文字识别）适配器尚未接入。', adapter: null,
    acceptedFormats: [], reservedFormats: ['image', 'pdf'], localOnly: true },
  { id: 'material.transcribe', version: '1', title: '材料视频/音频转录接口',
    description: '为当前消息原件的视频/音频文字转录保留插件入口；未来结果须保留原件时间段、字幕位置和原件摘要。当前未接入组件，不能执行转录。',
    status: 'not_configured', available: false, reason: '视频/音频转录适配器尚未接入。', adapter: null,
    acceptedFormats: [], reservedFormats: ['audio', 'video'], localOnly: true },
];

export function mediaPluginCatalog(adapters: readonly MaterialMediaAdapter[] = []): MaterialMediaPluginDescriptor[] {
  return mediaPlugins.map(plugin => {
    const adapter = adapters.find(candidate => candidate.id === plugin.id);
    if (!adapter) return structuredClone(plugin);
    const available = adapter.availability();
    return { ...structuredClone(plugin), version: adapter.version,
      title: plugin.id === 'material.transcribe' ? '材料音频/视频本机转录' : plugin.title,
      description: plugin.id === 'material.transcribe'
        ? '使用已装配的本机 Whisper（语音识别程序）转录当前消息选定的音频或视频；保留原件、原生时间段及独立输出摘要，不上传或切换组件。' : plugin.description,
      status: available.available ? 'configured' : 'unavailable', available: available.available,
      reason: available.reason ?? (available.available ? '已装配受控本机组件；实际执行仍须通过当前任务权限核对。' : '已装配组件当前不可用。'),
      adapter: { id: adapter.id, version: adapter.version }, acceptedFormats: [...adapter.acceptedFormats] };
  });
}

/** 保留在现有能力目录中；路由先以 SKILL_UNAVAILABLE 拒绝，不创建伪成功任务。 */
export function createMediaPluginRegistrations(adapters: () => readonly MaterialMediaAdapter[] = () => []): readonly SkillRegistration[] {
  return mediaPlugins.map(plugin => ({
  action: plugin.id, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
  title: plugin.id === 'material.transcribe' ? '材料音频/视频本机转录' : plugin.title,
  description: plugin.id === 'material.transcribe'
    ? '先读取并保管当前消息的媒体原件，再调用目录中已装配的本机转录组件；返回原件摘要、原生时间段与独立输出引用，组件不可用时停止。' : plugin.description,
  fields: [{ key: 'fileRefId', label: '消息原件引用', type: 'file', required: true },
    { key: 'materialId', label: '先读取并保管的材料编号', type: 'text', required: true, maxLength: 160 }],
  permissionSummary: ['核对当前消息选定原件及保管摘要', '本机转录工具、模型读取与产物发布分别核权', '保留原件与真实时间段，不上传或自动替代组件'],
  available: () => {
    const selected = mediaPluginCatalog(adapters()).find(candidate => candidate.id === plugin.id)!;
    return { available: selected.available, reason: selected.reason };
  },
}));
}
export const mediaPluginRegistrations = createMediaPluginRegistrations();

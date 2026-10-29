import { RequestError, request } from './api';

/** 八项固定采集动作；sourceId 只由这些动作明确映射，不从自由文本推断。 */
export const captureActions = [
  { sourceId: 'bilibili', action: 'capture.bilibili.read', zh: '哔哩哔哩', en: 'Bilibili' },
  { sourceId: 'wechat', action: 'capture.wechat.read', zh: '微信公众号', en: 'WeChat' },
  { sourceId: 'xiaohongshu', action: 'capture.xiaohongshu.read', zh: '小红书', en: 'Xiaohongshu' },
  { sourceId: 'weibo', action: 'capture.weibo.read', zh: '微博', en: 'Weibo' },
  { sourceId: 'zhihu', action: 'capture.zhihu.read', zh: '知乎', en: 'Zhihu' },
  { sourceId: 'google', action: 'capture.google.read', zh: 'Google 搜索', en: 'Google' },
  { sourceId: 'eastmoney', action: 'capture.eastmoney.read', zh: '东方财富', en: 'Eastmoney' },
  { sourceId: 'xueqiu', action: 'capture.xueqiu.read', zh: '雪球', en: 'Xueqiu' },
] as const;

export type CaptureSourceId = (typeof captureActions)[number]['sourceId'];
export const captureSourceIds = captureActions.map((item) => item.sourceId) as readonly CaptureSourceId[];

const states = ['first_use', 'login_open', 'saved', 'public', 'expired', 'revoked', 'unknown', 'unavailable'] as const;
const modes = ['unselected', 'authenticated', 'public'] as const;
export type CaptureState = (typeof states)[number];
export type CaptureMode = (typeof modes)[number];

export interface CaptureSource {
  sourceId: CaptureSourceId;
  label: string;
  state: CaptureState;
  mode: CaptureMode;
  needsAttention: boolean;
  message: string;
  loginOpened: boolean;
  /** 采集进行中；界面只提供状态读取和刷新。 */
  busy: boolean;
  savedAt?: string;
  lastCheckedAt?: string;
}

/** 由固定任务动作解析采集来源；非采集动作返回 null。 */
export function captureSourceForAction(action: unknown): CaptureSourceId | null {
  if (typeof action !== 'string') return null;
  return captureActions.find((item) => item.action === action)?.sourceId ?? null;
}

export function isCaptureSourceId(value: unknown): value is CaptureSourceId {
  return typeof value === 'string' && (captureSourceIds as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSource(value: unknown): CaptureSource {
  if (!isObject(value) || !isCaptureSourceId(value.sourceId) || typeof value.label !== 'string'
    || !states.includes(value.state as CaptureState) || !modes.includes(value.mode as CaptureMode)
    || typeof value.needsAttention !== 'boolean' || typeof value.message !== 'string' || typeof value.loginOpened !== 'boolean'
    || typeof value.busy !== 'boolean'
    || (value.savedAt !== undefined && value.savedAt !== null && typeof value.savedAt !== 'string')
    || (value.lastCheckedAt !== undefined && value.lastCheckedAt !== null && typeof value.lastCheckedAt !== 'string')) {
    throw new RequestError('采集来源状态暂时无法读取。');
  }
  return {
    sourceId: value.sourceId, label: value.label, state: value.state as CaptureState, mode: value.mode as CaptureMode,
    needsAttention: value.needsAttention, message: value.message, loginOpened: value.loginOpened, busy: value.busy,
    ...(typeof value.savedAt === 'string' ? { savedAt: value.savedAt } : {}),
    ...(typeof value.lastCheckedAt === 'string' ? { lastCheckedAt: value.lastCheckedAt } : {}),
  };
}

/** GET 只读，不启动浏览器；结果按固定顺序补齐，缺失项标为 unknown，不猜测已保存。 */
export async function getCaptureSources(): Promise<CaptureSource[]> {
  const value = await request('/api/capture-sources');
  if (!isObject(value) || !Array.isArray(value.sources)) throw new RequestError('采集来源状态暂时无法读取。');
  const received = new Map(value.sources.filter(isObject).filter((item) => isCaptureSourceId(item.sourceId)).map((item) => [item.sourceId as CaptureSourceId, readSource(item)]));
  return captureActions.map(({ sourceId, zh }): CaptureSource => received.get(sourceId) ?? {
    sourceId, label: zh, state: 'unknown', mode: 'unselected', needsAttention: true, message: '', loginOpened: false, busy: false,
  });
}


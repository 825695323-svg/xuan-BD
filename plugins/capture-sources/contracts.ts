import type { SkillAvailability } from '../../contracts/skill-contracts.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { BrowserConfiguration } from '../../platform/capabilities/browser/index.js';

export const CAPTURE_SOURCE_IDS = ['bilibili', 'wechat', 'xiaohongshu', 'weibo', 'zhihu', 'google', 'eastmoney', 'xueqiu', 'douyin', 'baidu', 'sogouwechat'] as const;
export type CaptureSourceId = typeof CAPTURE_SOURCE_IDS[number];
export const CAPTURE_SOURCES: Readonly<Record<CaptureSourceId, { label: string; loginRequired: boolean }>> = Object.freeze({
  bilibili: { label: '哔哩哔哩', loginRequired: true },
  wechat: { label: '微信', loginRequired: false },
  xiaohongshu: { label: '小红书', loginRequired: true },
  weibo: { label: '微博', loginRequired: true },
  zhihu: { label: '知乎', loginRequired: true },
  google: { label: 'Google', loginRequired: true },
  eastmoney: { label: '东方财富', loginRequired: true },
  xueqiu: { label: '雪球', loginRequired: true },
  douyin: { label: '抖音', loginRequired: false },
  baidu: { label: '百度', loginRequired: false },
  sogouwechat: { label: '搜狗微信', loginRequired: false },
});

/** 宿主独占站点登录态；配置只交给可信执行代码，不放入任务结果或模型预览。 */
export interface CaptureSessions {
  availability?(sourceId: CaptureSourceId): SkillAvailability;
  /** 宿主只投影本站已选择模式及固定资源身份；不读取 Cookie（登录凭据）或可变缓存。 */
  dependencyVersion?(sourceId: CaptureSourceId): unknown;
  /** 明确登录失效只更新原saved（已保存）状态；public（仅公开）不外推为曾登录。 */
  markExpired?(sourceId: CaptureSourceId): Promise<void>;
  withCaptureSession<T>(sourceId: CaptureSourceId, context: TaskExecutionContext,
    operation: (configuration: CaptureBrowserConfiguration, assertCurrent: () => void) => Promise<T>): Promise<T>;
}
export interface CaptureBrowserConfiguration extends BrowserConfiguration { networkIsolation: 'intercept-only-proxy' }

export type CaptureStatus = 'complete' | 'partial' | 'login' | 'captcha' | 'failed';
export interface CaptureSourceResponse {
  url: string; status: number; contentType: string; body: string; base64Encoded: boolean;
}
export interface CapturePageResult {
  sourceURL: string; finalURL: string; domHTML: string; result: unknown; responses: CaptureSourceResponse[];
  observation: { ownedTargetClosed: true; connectionClosed: true; blockedRequests: number; loaded: boolean; scriptsExecuted: true; credentials: 'site-profile'; rawResponsesComplete: boolean };
}

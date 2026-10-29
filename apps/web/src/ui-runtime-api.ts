import { request, RequestError, isConversationAttachmentRefs } from './api';
import type { ConversationAttachmentRef } from '../../../contracts/contracts';
import type { UiPreferences, UiPreferenceUpdate, UiRuntimeView, UiSettingsView, UiStopResult } from '../../../contracts/ui-contracts';
export type { UiPreferences, UiPreferenceUpdate, UiRuntimeView, UiSettingsView, UiStopResult, UiIndicator, UiStorageLocation, UiControlView } from '../../../contracts/ui-contracts';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function preferences(value: unknown): UiPreferences {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !['system', 'light', 'dark'].includes(String(value.theme))
    || !['zh-CN', 'en'].includes(String(value.language)) || typeof value.fontScale !== 'number'
    || !['enter', 'mod-enter'].includes(String(value.sendShortcut)) || !['off', 'low', 'high', 'max'].includes(String(value.thinkingLevel))
    || !(value.modelId === null || typeof value.modelId === 'string') || typeof value.updatedAt !== 'string') throw new RequestError('界面偏好暂时无法读取。');
  return value as unknown as UiPreferences;
}
function runtime(value: unknown): UiRuntimeView {
  const items = record(value) && Array.isArray(value.indicators) ? value.indicators : [];
  if (!record(value) || !Array.isArray(value.indicators) || value.indicators.length !== 3
    || !['data_sources', 'database', 'tool_library'].every((id, index) => record(items[index]) && items[index].id === id)
    || !record(value.control) || typeof value.control.stopped !== 'boolean' || !Array.isArray(value.activeRuns)) throw new RequestError('框架运行状态暂时无法核对。');
  return value as unknown as UiRuntimeView;
}
export const uiApi = {
  preferences: async () => preferences(await request('/api/ui/preferences')),
  savePreferences: async (update: UiPreferenceUpdate) => preferences(await request('/api/ui/preferences', 'PUT', update)),
  runtime: async () => runtime(await request('/api/ui/runtime')),
  materialDraftReference: async (materialId: string): Promise<ConversationAttachmentRef> => {
    const value = await request(`/api/ui/materials/${encodeURIComponent(materialId)}/draft-reference`);
    if (!isConversationAttachmentRefs([value])) throw new RequestError('材料原件引用暂时无法核对。');
    return value as ConversationAttachmentRef;
  },
  settings: async (): Promise<UiSettingsView> => {
    const value = await request('/api/ui/settings');
    if (!record(value) || !record(value.model) || !Array.isArray(value.storage) || !record(value.sources) || !Array.isArray(value.plugins)
      || !record(value.security) || !record(value.advanced)) throw new RequestError('设置来源暂时无法读取。');
    return value as unknown as UiSettingsView;
  },
  stop: async (scope: 'current' | 'all', conversationId?: string, runId?: string): Promise<UiStopResult> => {
    const value = await request('/api/ui/stop', 'POST', { scope, ...(conversationId ? { conversationId } : {}), ...(runId ? { runId } : {}) });
    runtime(value);
    if (!record(value) || typeof value.confirmed !== 'boolean' || !Array.isArray(value.issues)) throw new RequestError('停止结果暂未确认。');
    return value as unknown as UiStopResult;
  },
  resume: async (personalGeneration: number, workspaceGeneration?: number): Promise<UiRuntimeView> => runtime(await request('/api/ui/resume', 'POST', { personalGeneration, ...(workspaceGeneration === undefined ? {} : { workspaceGeneration }) })),
};

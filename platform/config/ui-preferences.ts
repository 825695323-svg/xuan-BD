import type { CoreDatabase } from '../state/database.js';
import { CoreError } from '../runtime/errors.js';
import type { ThinkingConfiguration } from '../../contracts/contracts.js';
import type { UiPreferences, UiPreferenceUpdate } from '../../contracts/ui-contracts.js';

/** 客户端偏好复用核心 app_settings；不创建另一个状态根或任务账本。 */
export class UiPreferenceService {
  constructor(private readonly database: CoreDatabase, private readonly modelId: string | null,
    private readonly thinking: ThinkingConfiguration) {
    database.connection.prepare('INSERT OR IGNORE INTO app_settings(key,value_json) VALUES(?,?)').run('ui.preferences', JSON.stringify({
      revision: 1, theme: 'system', language: 'zh-CN', fontScale: 1, sendShortcut: 'enter',
      modelId, thinkingLevel: thinking.defaultLevel, updatedAt: new Date().toISOString(),
    } satisfies UiPreferences));
  }
  get(): UiPreferences {
    const saved = JSON.parse(String(this.database.connection.prepare('SELECT value_json FROM app_settings WHERE key=?').get('ui.preferences')!.value_json)) as UiPreferences;
    // 模型身份只投影受信宿主的实际装配，旧偏好不能成为另一份运行配置。
    return { ...saved, modelId: this.modelId };
  }
  update(update: UiPreferenceUpdate): UiPreferences {
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).some(key => !['revision', 'theme', 'language', 'fontScale', 'sendShortcut', 'modelId', 'thinkingLevel', 'marketLayout', 'marketSelection'].includes(key))
      || !Number.isSafeInteger(update.revision) || update.revision < 1) throw new CoreError('INVALID_PREFERENCES', '偏好字段或版本无效。', 400);
    return this.database.transaction(() => {
      const previous = this.get();
      if (previous.revision !== update.revision) throw new CoreError('PREFERENCES_CONFLICT', '偏好已在其他页面变化，请重新读取后保存。');
      const next = { ...previous, ...update, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      if (!['system', 'light', 'dark'].includes(next.theme) || !['zh-CN', 'en'].includes(next.language)
        || typeof next.fontScale !== 'number' || !Number.isFinite(next.fontScale) || next.fontScale < 0.875 || next.fontScale > 1.25
        || !['enter', 'mod-enter'].includes(next.sendShortcut)) throw new CoreError('INVALID_PREFERENCES', '外观、语言、文字大小或发送快捷键无效。', 400);
      if (next.modelId !== this.modelId) throw new CoreError('MODEL_NOT_CONFIGURED', '所选模型未在当前连接中登记，偏好未保存。', 400);
      if (!this.thinking.supportedLevels.includes(next.thinkingLevel)) throw new CoreError('UNSUPPORTED_THINKING_LEVEL', '当前模型不支持所选推理等级，偏好未保存。', 400);
      if (next.marketLayout !== undefined) {
        const layout = next.marketLayout;
        if (!layout || typeof layout !== 'object' || !Array.isArray(layout.root) || !Array.isArray(layout.other)
          || layout.root.length + layout.other.length > 40) throw new CoreError('INVALID_PREFERENCES', '地区目录布局无效。', 400);
        const ids = [...layout.root, ...layout.other];
        if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/u.test(id)) || new Set(ids).size !== ids.length)
          throw new CoreError('INVALID_PREFERENCES', '地区目录布局包含无效或重复项。', 400);
      }
      if (next.marketSelection !== undefined) {
        const selection = next.marketSelection as Record<string, unknown> | null;
        if (!selection || typeof selection !== 'object') throw new CoreError('INVALID_PREFERENCES', '市场选择无效。', 400);
        for (const value of Object.values(selection)) if (value !== undefined && (typeof value !== 'string' || value.length > 40))
          throw new CoreError('INVALID_PREFERENCES', '市场选择无效。', 400);
      }
      this.database.connection.prepare('UPDATE app_settings SET value_json=? WHERE key=?').run(JSON.stringify(next), 'ui.preferences');
      return next;
    });
  }
}

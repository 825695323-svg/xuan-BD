import type { ThinkingLevel, RunSummary } from './contracts.js';
import type { TaskControlState } from './task-contracts.js';

export interface UiPreferences {
  revision: number;
  theme: 'system' | 'light' | 'dark';
  language: 'zh-CN' | 'en';
  fontScale: number;
  sendShortcut: 'enter' | 'mod-enter';
  modelId: string | null;
  thinkingLevel: ThinkingLevel;
  /** 地区市场目录布局：哪些在市场列表、哪些收在其他地区。 */
  marketLayout?: { root: string[]; other: string[] };
  /** 上次选中的市场与筛选条件。 */
  marketSelection?: { selected?: string; country?: string; assetScope?: string; dataCap?: string };
  updatedAt: string;
}
export type UiPreferenceUpdate = Partial<Omit<UiPreferences, 'revision' | 'updatedAt'>> & { revision: number };
export interface RunConfiguration {
  modelId: string | null;
  provider: string | null;
  thinkingLevel: ThinkingLevel;
  preferenceRevision: number | null;
  modelConfigurationVersion: string | null;
  personaSelectionRevision: number;
  agentDisplayName: string | null;
  personaRecords: Array<{ id: string; version: number; digest: string }>;
  /** 旧历史可缺省；实际运行由核心装配并核对。 */
  internalAgentRules?: { id: string; version: number; digest: string };
}
/** 只存核心数据库；网页只收到移除了正文的 RunConfiguration。 */
export interface FrozenRunConfiguration extends RunConfiguration { personaText: string; internalAgentRulesText?: string }
export interface UiIndicator {
  id: 'data_sources' | 'database' | 'tool_library';
  name: string;
  status: 'missing' | 'unknown' | 'available' | 'partial' | 'failed';
  source: string;
  scope: string;
  checkedAt: string | null;
  observedAt: string;
  staleAfterMs: number | null;
  issues: string[];
  settingsTarget: 'sources' | 'storage' | 'plugins';
}
export interface UiControlView {
  stopped: boolean;
  persisted: boolean;
  activeCount: number;
  pendingCount: number;
  personal: TaskControlState;
  workspace: TaskControlState | null;
}
export interface UiRuntimeView {
  indicators: UiIndicator[];
  control: UiControlView;
  activeRuns: RunSummary[];
  observedAt: string;
}
export interface UiStopResult extends UiRuntimeView {
  scope: 'current' | 'all';
  confirmed: boolean;
  issues: string[];
}
export interface UiStorageLocation {
  id: string;
  group: 'data' | 'database' | 'tools' | 'sources' | 'system' | 'evidence';
  purpose: string;
  location: string | null;
  owner: 'local' | 'workspace_service' | 'external';
  editable: false;
  access: 'managed' | 'not_checked' | 'missing';
  version: string | null;
}
export interface UiSettingsView {
  model: {
    id: string | null; displayName: string | null; provider: string | null; configured: boolean;
    endpoint: string | null; protocol: string | null;
    availability: 'not_probed' | 'not_configured'; supportedThinkingLevels: ThinkingLevel[];
    configurationVersion: string | null;
    credential: { configured: boolean; referenceName: string | null; secretExposed: false };
  };
  storage: UiStorageLocation[];
  sources: { status: 'missing' | 'registered'; source: string; note: string; items: unknown[] };
  plugins: Array<{ id: string; title: string; available: boolean; reason: string | null; source: string }>;
  security: { policyVersion: number; grantCount: number; pendingApprovalCount: number; secretExposed: false };
  advanced: {
    schemaVersions: Array<{ module: string; version: number }>;
    backgroundExecution: 'requires_running_service';
    recovery: string;
  };
}

import type { CredentialReference } from '../platform/config/model.js';
import type { JsonValue, TaskRecord } from './task-contracts.js';
import type { CaptureSourceId } from '../plugins/capture-sources/contracts.js';

export type SourceDataKind = 'minute_bars' | 'announcement' | 'index_change';
export interface SourceScope { id: string; country: string; market: string; label: string }
export interface SourceConnection {
  id: string; pluginId: string; alias: string; enabled: boolean; baseUrl: string;
  credential: CredentialReference | null; scopes: string[];
  tdxMode?: 'data_service' | 'client_http';
  /** WeRSS 本地缓存仅访问这里明确登记的 feed，不读取账号订阅清单。 */
  feedIds?: string[];
}
export interface SourcePolicy { scopeId: string; enabled: boolean; mode: 'inherit' | 'override'; primary: string | null; backups: string[] }
export type SourceOperationId = 'minute_bars' | 'daily_bars' | 'index_constituents';
export interface SourceOperationPolicy { scopeId: string; operationId: SourceOperationId; primary: string | null; backups: string[] }
/** 来源操作同时描述可见能力与已登记的真实执行器，禁止页面自行分派。 */
export interface SourceOperationView {
  id: SourceOperationId; label: string; dataCapability: SourceDataCapability; assetScope: SourceAssetScope;
  run: { action: 'source.kline.read' | 'source.api.read' } | { action: 'source.fetch'; sourceId: 'tdx' };
}
export interface CaptureSourceSetting {
  sourceId: CaptureSourceId; enabled: boolean; operation: string;
  parameters: Record<string, string | number>; watchTargets: string[];
}
export interface SourceSettingsDocument {
  revision: number; updatedAt: string | null;
  plugins: Array<{ id: string; enabled: boolean }>;
  connections: SourceConnection[]; policies: SourcePolicy[]; operationPolicies: SourceOperationPolicy[]; capture: CaptureSourceSetting[];
  /** 仅当前固定版公众号正文提取脚本；路径由本机来源设置受控保存，模型不能提交。 */
  wechatExtract: { enabled: boolean; scriptPath: string | null; sha256: string };
  execution: { maxConcurrentPerAccount: 1; minimumIntervalMs: number };
}
export interface SourceCheck {
  id: string; checkedAt: string; configurationRevision: number;
  configurationDigest?: string; validUntil?: string;
  status: 'passed' | 'partial' | 'blocked';
  reachable: boolean | null; authorized: boolean | null; capabilityAvailable: boolean | null; freshness: 'unknown';
  reason: string;
}
export type SourceDataCapability = 'history' | 'snapshot' | 'stream';
export type SourceAssetScope = 'equity' | 'futures' | 'bond' | 'other';
export interface SourceSettingsView extends SourceSettingsDocument {
  scopes: SourceScope[];
  apiPlugins: Array<{ id: string; title: string; shortLabel: string; upstream: string; version: string; applicationUrl: string | null;
    defaultBaseUrl: string; connectionModes?: Array<{ id: 'data_service' | 'client_http'; label: string; baseUrl?: string }>;
    operations: SourceOperationView[];
    capabilities: Array<{ kind: SourceDataKind | 'index_constituents'; supported: boolean; reason: string }> }>;
  capturePlugins: Array<{ sourceId: CaptureSourceId; label: string; available: boolean; reason: string | null;
    operations: Array<{ operation: string; parameters: Record<string, { kind: string; required?: boolean; min?: number; max?: number; values?: readonly string[] }> }>;
    scheduling: { supported: false; reason: string } }>;
  checks: SourceCheck[];
  supportedKinds: SourceDataKind[];
  supportedApiOperations: Array<{ id: string; label: string }>;
  concurrency: { scope: 'shared_account'; activeLimit: 1; numericOfficialLimit: null; reason: string; references: Array<{ title: string; url: string }> };
  usage: Array<{ accountId: string; connectionIds: string[]; measurement: 'local_attempts'; attempts: number; lastAttemptedAt: string | null }>;
}
export interface SourceRunRequest { sourceId: 'tdx' | 'eastmoney' | 'official_web'; requestId: string; scopeId: string; parameters: Record<string, JsonValue> }
export interface SourceRunView { task: TaskRecord; events: unknown[]; artifacts: unknown[] }

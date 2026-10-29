import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PermissionCapability, PermissionService } from '../../platform/security/permissions.js';
import type { TaskExecutionContext, TaskRecord, TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';

export const FINANCIAL_RUNTIME = 'harness.financial';
export const FINANCIAL_PLUGIN_ID = 'xuen.local-finance';
export const FINANCIAL_PLUGIN_VERSION = '1.0.0';
export const FINANCIAL_CONTRACT_VERSION = 'financial-tools/1';
export const FINANCIAL_CAPABILITIES = ['xuen.local-finance.ma', 'xuen.local-finance.bullish_engulfing', 'xuen.local-finance.macd'] as const;
export const FINANCIAL_MACD_PARAMETERS = Object.freeze({ short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' as const });
export const FINANCIAL_MACD_FIELDS = ['DIFF', 'DEA', 'MACD', 'ZERO'] as const;
export const FINANCIAL_MACD_LIMITATIONS = [
  'MACD仅在本次不超过十个自然日的观测窗口以首值初始化；不含窗口之前历史，不能视为完整历史MACD。',
  '本适配不接受递推状态续算；原工具返回的state仅作为计算证据保留，不授予续算或自动保存权限。',
] as const;
export type FinancialCapabilityId = typeof FINANCIAL_CAPABILITIES[number];
export type FinancialEnvironment = 'local-review' | 'synthetic-test';
export type FinancialField = 'timestamp' | 'open' | 'high' | 'low' | 'close' | 'available_at' | 'bar_closed';

/** 只接受明确单位、日线口径和逐行可得时刻；声明不替代交易日历或供应方核验。 */
export interface FinancialMetadata {
  series_id: string;
  frequency: '1d';
  timezone: string;
  price_unit: 'currency_per_share';
  currency: string;
  adjustment: 'unadjusted' | 'forward_adjusted' | 'backward_adjusted' | 'as_stored';
  adjustment_basis: string;
  window_start: string;
  window_end: string;
  observations_are_consecutive: true;
  as_of: string;
  availability_basis: 'explicit_per_bar';
  synthetic: boolean;
}
export interface FinancialBar {
  timestamp: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  available_at: string;
  bar_closed: true;
}
export interface FinancialData { metadata: FinancialMetadata; rows: FinancialBar[] }
export interface FinancialDirectInput { kind: 'direct'; inputId: string; data: FinancialData }
export interface FinancialOutputIdentity { unitId: string; outputId: string; definitionRevision: string; schemaRevision: string }
export interface FinancialReferenceDependency { referenceId: string; snapshotId: string }
export interface FinancialSnapshotInput {
  kind: 'snapshot';
  productId: string;
  snapshotId: string;
  outputIdentity: FinancialOutputIdentity;
  referenceDependencies: FinancialReferenceDependency[];
  fields: FinancialField[];
  range: { start: string; end: string };
  useMode: 'analysis';
}
export type FinancialInput = FinancialDirectInput | FinancialSnapshotInput;
export interface FinancialSnapshotRead {
  /** 必须与本次请求逐字段相同，不接受 latest（最新）或偷偷扩围。 */
  reference: FinancialSnapshotInput;
  data: FinancialData;
  raw: JsonValue;
}
export interface FinancialCallArgs {
  capabilityId: FinancialCapabilityId;
  pluginVersion: string;
  methodVersion: string;
  implementationVersion: string;
  input: FinancialInput;
  parameters: { period: number } | typeof FINANCIAL_MACD_PARAMETERS | Record<string, never>;
}
export interface FinancialPluginMutation {
  pluginId: string;
  pluginVersion: string;
  expectedVersion: number;
}
export interface FinancialPluginStatus {
  pluginId: string;
  pluginVersion: string;
  contractVersion: string;
  implementationVersion: string;
  environment: FinancialEnvironment;
  enabled: boolean;
  version: number;
  capabilities: FinancialCapabilityId[];
  permissionVersion: number;
}
export interface FinancialToolDescription {
  capabilityId: FinancialCapabilityId;
  pluginId: string;
  pluginVersion: string;
  methodVersion: string;
  contractVersion: string;
  implementationVersion: string;
  title: string;
  description: string;
  enabled: boolean;
  parameters: JsonValue;
  inputContract: JsonValue;
  outputContract: JsonValue;
  methodEvidence: JsonValue;
  executionConstraints: JsonValue;
  publicContract?: JsonValue;
}
/** 仅受信宿主可传；在任务首次启动前持久绑定调用来源，不来自模型参数。 */
export interface FinancialHostSubmission {
  beforeStart?(task: TaskRecord): void;
}
export interface FinancialServiceOptions {
  environment: FinancialEnvironment;
  database: CoreDatabase;
  tasks(): TaskService;
  permissions: PermissionService;
  computeAssetsRoot: string;
  /** 受控采用入口固定的五文件版本；构造时在任何状态迁移前核对。 */
  expectedAssetsVersion?: string;
  pythonExecutable: string;
  processRuntime: ProcessRuntime;
  readSnapshot?(reference: FinancialSnapshotInput, context: TaskExecutionContext): Promise<FinancialSnapshotRead>;
  /** 受信宿主按持久任务来源重新核当前个人运行、分支及附件资格；包括已封闭输入的重试。 */
  assertFinancialTaskReadable?(context: TaskExecutionContext): void;
  /** 受信宿主绑定读取所需权限；金融工具不会自行创建取数通路。 */
  snapshotCapabilities?: readonly PermissionCapability[];
  snapshotBinding?: { version: string; contractDigest: string };
}
export interface FinancialInvalidInterval { start: string; end: string; reason: 'insufficient_history'; count: number }
export interface FinancialComputedCandidate {
  status: 'computed';
  persistence: 'not_requested';
  environment: FinancialEnvironment;
  taskId: string;
  capabilityId: FinancialCapabilityId;
  pluginVersion: string;
  methodVersion: string;
  contractVersion: string;
  implementationVersion: string;
  inputDigest: string;
  inputReference: JsonValue;
  parameters: JsonValue;
  metadata: FinancialMetadata;
  rows: Array<{ timestamp: string; available_at: string; [field: string]: JsonValue }>;
  validInterval: { start: string; end: string } | null;
  invalidIntervals: FinancialInvalidInterval[];
  diagnostics: JsonValue[];
  method: JsonValue;
  rawToolResult: JsonValue;
  limitations: string[];
  externalActionExecuted: false;
}

import type { FileReferenceService } from '../platform/resources/files.js';
import type { PermissionCapability } from '../platform/security/permissions.js';
import type { TaskExecutionContext, TaskRuntime } from '../platform/jobs/tasks.js';
import type { SkillRegistry, SkillRegistration } from '../platform/plugins/registry.js';
import type { DirectRouter } from '../platform/plugins/router.js';
import type { ProcessRuntime } from '../platform/runtime/programs.js';
import type { JsonValue, TaskResult } from './task-contracts.js';
import type { SkillAvailability } from './skill-contracts.js';
import type { PublicWebOptions } from '../platform/capabilities/browser/public-web.js';
import type { BaiduDriveConfiguration } from '../plugins/capture-sources/baidu-drive/index.js';
import type { CustomSourceRegistry } from '../plugins/capture-sources/custom-register.js';
import type { BrowserConfiguration } from '../platform/capabilities/browser/index.js';
import type { LocalTranscriptionInput, LocalTranscriptionResult } from '../platform/capabilities/transcription/local.js';
import type { AgentImageOcrRunner } from './llm.js';
import type { CaptureSessions } from '../plugins/capture-sources/contracts.js';
import type { ResourceBindings } from '../platform/resources/bindings.js';
import type { SourceSettingsService } from '../platform/config/source-settings.js';
import type { SourceCheck } from './source-settings.js';

export interface ShortcutDefinition {
  id: string;
  name: string;
  userSelected: true;
  effectDescription: string;
  capabilities: readonly PermissionCapability[];
  verification?: { kind: 'new-file'; path: string; nonempty?: boolean };
}
export interface DirectRuntimeOptions {
  files: FileReferenceService;
  /** 已存在的应用产物目录；初始化与持久权限由 Core 管理。 */
  artifactRoot: string;
  whisperModelPath?: string;
  processRuntime?: ProcessRuntime;
  /** 只由受信宿主提供实际已装配的位置身份；不接受客户端版本。 */
  resources?: ResourceBindings;
  agentImageOcrVersion?: () => Record<string, string | null>;
  videoMaxMinutes?: number;
  videoMaxBytes?: number;
  shortcuts?: readonly ShortcutDefinition[];
  /** Core 明确列举的控制面与凭据路径，普通文件动作不得触及。 */
  protectedPaths?: readonly string[];
  /** 公开网页读取的受控测试传输；普通应用使用成熟 HTTPS 传输。 */
  publicWeb?: PublicWebOptions;
  /** 仅受信启动器选定的原生网盘程序与账号配置位置。 */
  baiduDrive?: BaiduDriveConfiguration;
  browser?: BrowserConfiguration;
  browserUnavailableReason?: string;
  /** 仅个人宿主装配的站点独立会话；不暴露给模型参数。 */
  captureSessions?: CaptureSessions;
  capturePrivateArtifactRoot?: string;
  captureUnavailableReason?: string;
  sourceSettings?: SourceSettingsService;
  /** 运行根登记的自定义来源卡片存储；只登记卡片信息，不执行站点脚本。 */
  customSources?: CustomSourceRegistry;
  tdxaidataPackage?: { path: string; sha256: string };
  /** 只由当前内置代理任务绑定；不另建供应方或脱离原预算发送图片。 */
  agentImageOcr?: AgentImageOcrRunner;
  agentImageOcrAvailability?: () => SkillAvailability;
  /** Only the trusted host supplies these closed, registered actions. */
  conversationMaterials?: {
    registrations: readonly SkillRegistration[];
    handles(action: string): boolean;
    execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult>;
  };
  conversationMaterialVersions?: (action: string) => unknown;
}
/** 当前 direct 运行时实际加载的配置；只读快照，用于区分持久一致与运行一致。 */
export interface DirectRuntimeConfiguration {
  whisperModelPath: string | null;
  shortcuts: readonly ShortcutDefinition[];
  videoMaxMinutes: number;
  videoMaxBytes: number;
}
export interface DirectRuntimeBundle {
  runtime: TaskRuntime; registry: SkillRegistry; router: DirectRouter;
  configure(input: { videoMaxMinutes?: number; videoMaxBytes?: number; whisperModelPath?: string; shortcuts?: readonly ShortcutDefinition[]; shortcutConfigPath?: string }): void;
  /** 先完成所有可失败准备；返回的安装动作只更新已核定的运行值。 */
  prepareConfiguration(input: Parameters<DirectRuntimeBundle['configure']>[0]): () => void;
  /** 只读当前实际运行值；不触发加载、安装或文件访问。 */
  configuration(): DirectRuntimeConfiguration;
  assertPublicPath(path: string, allowMissing?: boolean): void;
  sourceChecks?: { check(connectionId: string): Promise<SourceCheck> };
  localTranscription: {
    availability(): SkillAvailability;
    captureVersions(action: 'audio.transcribe' | 'material.transcribe'): Record<string, string | null>;
    execute(context: TaskExecutionContext, input: LocalTranscriptionInput): Promise<LocalTranscriptionResult>;
  };
}

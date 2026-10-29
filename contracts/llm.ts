import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BackendInput } from './backend.js';
import type { ThinkingLevel } from './contracts.js';
import type { TaskExecutionContext } from '../platform/jobs/tasks.js';
import type { OperationScope } from '../platform/security/permissions.js';

export interface PiModelInfo { provider: string; model: string; baseUrl: string; api?: string; input?: readonly ('text' | 'image')[] }

export interface PiImageOcrResult {
  text: string; model: { provider: string; model: string; api: string }; imageSha256: string;
  usage: { inputTokens: number; outputTokens: number };
}
/** 只由宿主绑定到当前已审批的image.ocr尝试，不接受模型/浏览器指定连接或凭据。 */
export type AgentImageOcrRunner = (context: TaskExecutionContext, request: {
  fileRefId: string; operation: OperationScope; approvalId?: string; assertAuthorized: () => void;
}) => Promise<PiImageOcrResult>;
export interface PiImageOcrRequest {
  data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; imageSha256: string;
}
export interface PiToolFactoryContext {
  getCurrentInput(): Readonly<BackendInput>;
  model: Readonly<PiModelInfo>;
  /** 仅宿主OCR适配器可用；与当前Agent共享连接、思考档位及模型请求计数。 */
  runImageOcr?: (image: Readonly<PiImageOcrRequest>, signal: AbortSignal, assertAuthorized: () => void) => Promise<PiImageOcrResult>;
}
export interface PiRequestHooks {
  /** 同步核对当前分支、最新输入和权限身份；不能产生新授权或重复扣模型预算。 */
  contextIdentity?: (input: Readonly<BackendInput>, model: Readonly<PiModelInfo>, signal?: AbortSignal) => string;
  contextProvider?: (input: Readonly<BackendInput>, signal?: AbortSignal) => string | Promise<string>;
  beforeModelRequest?: (input: BackendInput, requestIndex: number, signal: AbortSignal | undefined,
    model: Readonly<PiModelInfo>) => Promise<void>;
  /** 只投影本次允许外发的工具结果，保留原生调用配对；不改变本机会话。 */
  projectToolResult?: (result: Readonly<ToolResultMessage>, input: Readonly<BackendInput>, signal: AbortSignal | undefined,
    model: Readonly<PiModelInfo>) => ToolResultMessage;
}
export interface PiBackendConfig extends PiRequestHooks {
  provider?: string;
  model?: string;
  defaultThinkingLevel?: ThinkingLevel;
  apiKey?: string;
  resolveApiKey?: () => Promise<string>;
  customModel?: PiCustomModelConfig;
  toolFactory?: (context: PiToolFactoryContext) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>;
  /** 含首次请求；工具模式显式配置1到8次，另加已接受的引导输入。 */
  maxModelRequests?: number;
  /** 受信宿主的角色提示；不从用户或模型输入读取。 */
  systemPrompt?: string;
}

/** 输入模态由宿主明确声明；认证不使用Pi配置插值，不自动升级现用模型配置。 */
export interface PiCustomModelConfig {
  api: 'openai-completions';
  baseUrl: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: readonly ['text'] | readonly ['text', 'image'];
  reasoning?: boolean;
}


/** 指令技能独立于动作菜单；来源只是文档标识，不会被当成路径、脚本或扩展加载。 */
export interface AgentSkillSource { kind: 'builtin' | 'user'; identifier: string; revision: string }
export interface AgentSkillResource { path: string; body: string; digest: string; kind: 'reference' | 'template' | 'asset' }
export interface AgentSkillDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  body: string;
  source: AgentSkillSource;
  /** 已审核的文本快照；不会被作为本机路径或代码执行。 */
  resources?: AgentSkillResource[];
  originalBody?: string;
  adaptationNotes?: string[];
  /** 当前核心动作编号，仅声明依赖，不授予执行资格。 */
  requiresTools?: string[];
  unsupportedReasons?: string[];
  /** 只用于首次登记；重复初始化不能重新启用用户已经停用的技能。 */
  enabled?: boolean;
}
export interface AgentSkillRecord extends Omit<AgentSkillDefinition, 'enabled'> {
  digest: string;
  enabled: boolean;
  /** 方法文本可读与依赖动作可执行分开；缺少动作不会隐藏方法及缺口。 */
  readable: boolean;
  missingTools: string[];
  available: boolean;
  unavailableReason: string | null;
  currentRevision: number;
  latest: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AgentSkillTaskArgs { skill: string; prompt: string }
export interface AgentSkillAttemptScope { taskId: string; runId: string; attemptId: string; generation: number }
export interface AgentSkillBinding extends AgentSkillAttemptScope {
  id: string;
  skillId: string;
  skillVersion: number;
  digest: string;
  source: AgentSkillSource;
  argsDigest: string;
  createdAt: string;
}
/** 普通自然会话仍使用当前模型循环，选择事实绑定核心运行及分支。 */
export interface AgentSkillRunScope { conversationId: string; branchId: string; runId: string; generation: number }
export interface AgentSkillRunBinding extends AgentSkillRunScope {
  id: string;
  skillId: string;
  skillVersion: number;
  digest: string;
  source: AgentSkillSource;
  enableRevision: number;
  createdAt: string;
}

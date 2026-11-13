import type { AlgorithmDefinition, AlgorithmDefinitionSummary } from './algorithm-definition.js';

export interface ToolLibraryParameter { key: string; label: string; defaultValue: number; min: number; max: number }

/**
 * 登记状态，说明这项算法卡在哪一层：
 * - executable：本工程受控入口已放行，可从受管表或固定快照计算。
 * - assets_only：实现已在本工程计算资产内，但受控入口尚未放行该操作。
 * - not_implemented：本工程没有实现；方法来自外部资料包，需按受控入口另行接入。
 * - needs_data：方法与其输入契约已知，但本批输入数据不存在，即使实现也不能算。
 */
export type ToolLibraryState = 'executable' | 'assets_only' | 'not_implemented' | 'needs_data';

export interface ToolLibraryTool {
  /** 稳定登记标识；不等于可执行方法标识，只有 executable 项可提交计算。 */
  id: string; title: string; description: string;
  status: 'ready' | 'blocked' | 'unavailable'; reason: string | null;
  parameters: ToolLibraryParameter[]; outputFields: string[]; limitations: string[];
  /** 以下为登记层字段；旧视图消费方可忽略。 */
  category?: 'market' | 'statistics' | 'financial' | 'utility';
  state?: ToolLibraryState;
  /** 该算法需要的输入字段；空数组表示尚未登记明确输入。 */
  requiredInputs?: string[];
  /** 具体缺失项，逐条可核对；不写成“待补充”这类无法行动的措辞。 */
  missing?: string[];
  /** 方法来源：本工程资产位置或外部资料包位置。 */
  sources?: string[];
  /** 只读算法定义：公式、口径、实现、配置、数据产品与旧编号映射；不改变登记状态。 */
  definition?: AlgorithmDefinition;
}

export interface ToolLibraryView {
  tools: ToolLibraryTool[];
  status: 'ready' | 'unavailable'; reason: string | null;
  /** 登记清单自身的版本与计数；不表示这些算法已启用。 */
  registry?: { version: string; registeredAt: string; note: string; counts: Record<ToolLibraryState, number> };
  /** 定义层摘要：只统计独立算法定义，不把固定参数、频率与批量作业重复计数。 */
  definitions?: AlgorithmDefinitionSummary;
}

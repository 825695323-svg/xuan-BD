/**
 * 算法定义的只读分层登记。
 *
 * 与 `algorithm-registry.ts`（登记清单）、受控白名单、固定方法表分开：
 * - 登记清单回答“这项登记到哪一步、还缺什么”；
 * - 定义层回答“这个算法是什么、公式与口径是什么、由哪些实现与配置承载、
 *   产出了哪些数据产品、旧登记编号如何对应”。
 *
 * 定义层不改任何 state/status，也不构成采用回执。发布、数据与运行三维
 * 不写在这里：它们必须按每次请求的真实运行目录判定，不能由静态文件代替。
 */

/** 算法在目录中的角色：基础算子、独立指标、形态、财务或工具。 */
export type AlgorithmDefinitionKind = 'operator' | 'indicator' | 'pattern' | 'pattern_family' | 'financial' | 'utility';

/**
 * 定义状态：
 * - frozen：公式与口径已固定，可直接按此实现；
 * - conflict：存在明确未统一的口径，引用前必须先裁决；
 * - unrecorded：本工程未实现且未登记冻结的公式版本。
 */
export type AlgorithmDefinitionState = 'frozen' | 'conflict' | 'unrecorded';

/** 实现状态：本工程是否已有可运行实现，及其覆盖程度。 */
export type AlgorithmImplementationState = 'present' | 'partial' | 'absent';

/** 验证状态：只有登记了独立数值预期回执才可写 passed；当前一律未通过。 */
export type AlgorithmVerificationState = 'unrecorded' | 'not_run' | 'passed';

export interface AlgorithmFormulaLine {
  /** 该式对应的输出字段；多输出算法逐条列出。 */
  readonly output: string;
  /** 公式原文，纯文本；不引入外部排版依赖。 */
  readonly expression: string;
  /** 该式的限定条件或口径提示。 */
  readonly note?: string;
}

export interface AlgorithmSemantic {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** fixed 已固定；conflict 存在未统一口径；unresolved 尚未冻结。 */
  readonly state: 'fixed' | 'conflict' | 'unresolved';
}

export interface AlgorithmImplementationRef {
  readonly id: string;
  readonly role: 'primary' | 'reference';
  readonly language: string;
  /** 工程内相对位置；不写本机绝对路径。 */
  readonly location: string;
  readonly version?: string;
  readonly note?: string;
}

export interface AlgorithmConfiguration {
  readonly id: string;
  readonly label: string;
  readonly frequency: string;
  readonly parameters: string;
  readonly entry: 'library' | 'fixed' | 'batch';
  readonly note?: string;
}

export interface AlgorithmProduct {
  readonly id: string;
  readonly label: string;
  readonly kind: 'fixed' | 'batch';
  /** 对应左侧目录里的数据产品条目编号。 */
  readonly entryId: string;
  readonly configurationId: string;
  readonly note: string;
}

/** 旧登记编号到新算法 / 配置 / 产品的映射；迁移期保证旧记录仍可查询。 */
export interface AlgorithmLegacyAlias {
  readonly alias: string;
  readonly mapsTo: string;
  readonly kind: 'library' | 'fixed' | 'batch';
  readonly note: string;
}

export interface AlgorithmDefinitionStatus {
  readonly definition: { readonly state: AlgorithmDefinitionState; readonly basis: string };
  readonly implementation: { readonly state: AlgorithmImplementationState; readonly basis: string };
  readonly verification: { readonly state: AlgorithmVerificationState; readonly basis: string };
}

export interface AlgorithmDefinition {
  readonly kind: 'definition';
  /** 唯一算法定义编号；与旧登记编号分开，旧编号保留在 legacyAliases。 */
  readonly id: string;
  /** 现行登记清单编号；迁移完成前两者并存。 */
  readonly registryId: string;
  readonly title: string;
  readonly definitionKind: AlgorithmDefinitionKind;
  readonly summary: string;
  readonly formula: readonly AlgorithmFormulaLine[];
  readonly semantics: readonly AlgorithmSemantic[];
  readonly warmup: string;
  readonly missingPolicy: string;
  readonly implementations: readonly AlgorithmImplementationRef[];
  readonly configurations: readonly AlgorithmConfiguration[];
  readonly products: readonly AlgorithmProduct[];
  readonly legacyAliases: readonly AlgorithmLegacyAlias[];
  readonly status: AlgorithmDefinitionStatus;
  /** 形态单项指向所属形态族；只表达归属，不合并状态。 */
  readonly relation?: { readonly parentId: string; readonly role: 'member'; readonly note: string };
}

export interface AlgorithmDefinitionSummary {
  readonly kind: 'definition';
  readonly version: string;
  readonly note: string;
  readonly counts: {
    readonly definitions: number;
    readonly operators: number;
    readonly withProducts: number;
    readonly definitionConflicts: number;
    readonly implemented: number;
    readonly legacyAliases: number;
  };
}

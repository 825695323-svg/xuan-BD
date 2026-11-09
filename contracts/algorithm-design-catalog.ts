/**
 * 规划附件的只读设计目录（design_only）。
 *
 * 与 `algorithm-design-dispositions.ts` 同一来源，但覆盖的是规划的另一半：
 * BD 预计算产品、A 股制度与披露产品、A 股短线情绪方法、情绪评分规范、
 * 落地批次与外部规则核对。
 *
 * 边界：只做只读登记与展示，不创建产品、不注册数据集、不启用算法、
 * 不改任何采用记录、白名单或发布资格。每个产品仍须自身验收回执后才可前进。
 */

export interface DesignProduct {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly coverage: string;
  readonly inputs: string;
  readonly calculation: string;
  readonly trigger: string;
  readonly gate: string;
  readonly h02: string;
  readonly sourceCues: string;
}

export interface DesignInstitutional {
  readonly id: string;
  readonly name: string;
  readonly coverage: string;
  readonly inputs: string;
  readonly calculation: string;
  readonly trigger: string;
  readonly gate: string;
  readonly h02: string;
  readonly provenanceNote: string;
  readonly sourceFiles: readonly string[];
}

export interface DesignSentimentMethod {
  readonly id: string;
  readonly name: string;
  readonly layer: string;
  readonly evidence: string;
  readonly inputs: string;
  readonly formula: string;
  readonly gate: string;
  readonly sources: readonly string[];
}

export interface DesignWeight { readonly dimension: string; readonly weight: string }
export interface DesignBand { readonly range: string; readonly label: string }
export interface DesignStage { readonly name: string; readonly rule: string }
export interface DesignFixture { readonly sample: string; readonly expected: string }

export interface DesignSentimentSpec {
  readonly title: string;
  /** 五条原式与判定顺序，逐字取自规划。 */
  readonly rules: readonly string[];
  readonly weights: readonly DesignWeight[];
  readonly bands: readonly DesignBand[];
  readonly stages: readonly DesignStage[];
  readonly fixtures: readonly DesignFixture[];
  readonly production: readonly string[];
  readonly publish: readonly string[];
}

export interface DesignBatch {
  readonly batch: string;
  readonly delivery: string;
  readonly acceptance: string;
}

export interface DesignExternalTopic {
  readonly topic: string;
  readonly note: string;
  readonly links: readonly { readonly name: string; readonly url: string }[];
}

export interface DesignNote {
  readonly title: string;
  /** 原文段落与表格行，逐字保留；页面按等宽文本展示。 */
  readonly text: string;
}

export interface DesignArchiveNote {
  readonly item: string;
  readonly count: number;
  readonly location: string;
  readonly note: string;
}

export interface AlgorithmDesignCatalog {
  readonly kind: 'design_only';
  readonly version: string;
  readonly source: string;
  readonly note: string;
  readonly products: readonly DesignProduct[];
  readonly institutional: readonly DesignInstitutional[];
  readonly sentiment: readonly DesignSentimentMethod[];
  readonly sentimentSpec: DesignSentimentSpec;
  readonly batches: readonly DesignBatch[];
  readonly external: readonly DesignExternalTopic[];
  readonly archive: readonly DesignArchiveNote[];
  readonly notes: readonly DesignNote[];
  readonly counts: {
    readonly products: number;
    readonly institutional: number;
    readonly sentiment: number;
    readonly batches: number;
    readonly externalLinks: number;
    readonly archivedObjects: number;
    readonly archivedSamples: number;
    readonly archivedProbes: number;
  };
}

import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { EligibilityHistoryMode, EligibilityPurpose, PurposeEvidenceClaim, RestrictionEvidence } from './purpose-eligibility.js';

/** 保管状态只有三项，与路由状态分开保存；处理拒绝不得回写或删除保管事实。 */
export const CUSTODY_STATES = ['inventoried', 'receiving', 'received'] as const;
export type CustodyState = typeof CUSTODY_STATES[number];
/** 六个路由状态来自接收专篇，不合并为单一状态机，也不作为数据库提交状态。 */
export const ROUTING_STATES = ['needs_classification', 'needs_adapter', 'needs_target', 'needs_review', 'ready_candidate', 'rejected'] as const;
export type RoutingState = typeof ROUTING_STATES[number];
export const DIMENSION_KEYS = ['role', 'informationNature', 'businessObject', 'objectTime', 'purpose', 'structureGranularity'] as const;
export type DimensionKey = typeof DIMENSION_KEYS[number];
export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  role: '材料角色', informationNature: '信息性质', businessObject: '业务对象', objectTime: '对象与时间',
  purpose: '使用目的', structureGranularity: '结构与粒度',
};
/** 这四维回答“这是什么、属于谁、以什么粒度存在”；未知时先待分类。 */
export const CLASSIFICATION_DIMENSIONS: readonly DimensionKey[] = ['role', 'informationNature', 'businessObject', 'structureGranularity'];
/** 这两维决定用途资格和时间身份；未知时待核对，而不是不适用。 */
export const REVIEW_DIMENSIONS: readonly DimensionKey[] = ['objectTime', 'purpose'];

export interface DimensionSuggestion {
  source: 'model-proposal'; proposalId: string | null; judgmentId: string | null; value: string; adopted: false;
}
export interface NormalizedEvidence {
  source: 'material' | 'operator-http' | 'user-message';
  quote: string;
  start?: number; end?: number; line?: number; column?: number;
  materialId?: string; materialSha256?: string;
  requestId?: string; field?: string; method?: string; path?: string; remoteAddress?: string | null; observedAt?: number;
  messageId?: string;
  table?: { selectionSha256: string; projectionSha256: string; sheetName: string; sheetPart: string; column: string;
    scope: 'header' | 'column_constant'; headerCell: string; firstDataRow: number; lastDataRow: number; selectedRows: number };
}
export interface NormalizedDimension {
  key: DimensionKey;
  status: 'known' | 'unknown' | 'conflict';
  value: string | null;
  gap: string | null;
  evidence: NormalizedEvidence[];
  suggestions: DimensionSuggestion[];
}
export interface MaterialFacts {
  materialId: string; filename: string; sha256: string; byteLength: number; mediaType: string;
  format: string; support: string; adapter: { id: string; version: string } | null;
  custodyState: Extract<CustodyState, 'received'>;
}
export interface StructuredUsage {
  purpose: EligibilityPurpose;
  historyMode: EligibilityHistoryMode | null;
  cutoff: string | null;
  perspective: string | null;
  /** 由受信结构化动作构造；不接受把任意原话重贴成另一用途。 */
  purposeEvidence: PurposeEvidenceClaim[];
  /** 实际 WFD 治理读取/检查证据；发布边界缺失时阻断。 */
  restriction?: RestrictionEvidence;
}
export interface UsageQualification {
  status: 'eligible' | 'ineligible' | 'insufficient_evidence';
  gaps: string[];
  checkedScope: string[];
  evidenceSha256: string;
  historyUse: string | null;
}
export interface RoutingDecisionFacts {
  material: MaterialFacts;
  dimensions: NormalizedDimension[];
  target?: { present: boolean; kind: 'productRef' | 'declaration' | 'none'; expectedSnapshotId: string | null };
  /** 只接受受信请求里的明确动作；自然语言用途说明不参与发布判定。 */
  intendedAction?: 'inspect' | 'publish';
  /** 共用用途资格的实际判决；非 eligible 时不能形成 ready_candidate/publishEligible。 */
  usage?: UsageQualification | null;
  rejected: boolean;
  outputId: string | null;
}
export interface RoutingDecision {
  custodyState: CustodyState;
  routingState: RoutingState;
  gaps: string[];
}

/** 固定政策：只签发已列明并实际执行的受控规则；专用适配不授予通用业务核验资格。 */
export const PROCESSING_POLICY = Object.freeze({
  version: 'bd-processing-policy/2',
  scope: 'CSV/JSON row tables and explicit XLSX cells; declared exact numeric grammar; namespace-resolved numeric XBRL subset; reviewed whole UTF-8 business paragraphs; frozen native PDF table regions; trusted fixed CAS/CNY standardization and legal natural-year quarter/TTM calculations. Per-output applicability and gaps remain explicit.',
  ruleCoverage: '仅已列明且本输出实际执行的规则；未适配概念、单位、维度、财年、文字用途或修订相容性保持缺口，其余业务规则不能由结构检查批量签发通过。',
  unknownPolicy: 'unknown/conflict 保持缺口；不按不适用跳过，也不阻断不依赖它的解析、清洗或结构完整性检查。发布/算法具体用途资格单独判断；结构检查成功不等于来源真实性或业务语义已验证。',
  purposePolicy: '使用目的只能由真实操作者请求字段或真实用户消息证据确认；模型建议只作未采用建议。',
  reusePolicy: '相同固定输入、规则、实现版本和政策的已完成步骤可复用；变化只重算受影响步骤及下游。',
  excluded: ['来源真实性', '业务单位与时间身份', '产品合同与历史覆盖', 'OCR/转录语义', '代码执行', '正式数据库提交'],
});
export const PROCESSING_POLICY_DIGEST = wfdSha256(canonicalWfdJson(PROCESSING_POLICY));

export function dimensionLabel(key: DimensionKey): string { return DIMENSION_LABELS[key]; }

export function emptyDimensions(): NormalizedDimension[] {
  return DIMENSION_KEYS.map(key => ({ key, status: 'unknown' as const, value: null,
    gap: `未提供${dimensionLabel(key)}；明确保留未知，未按不适用跳过。`, evidence: [], suggestions: [] }));
}

export function mergeDimensions(base: NormalizedDimension[], overrides: NormalizedDimension[]): NormalizedDimension[] {
  const byKey = new Map(overrides.map(item => [item.key, item]));
  return DIMENSION_KEYS.map(key => byKey.get(key) ?? base.find(item => item.key === key) ?? emptyDimensions().find(item => item.key === key)!);
}

export function gapsForDimensions(dimensions: NormalizedDimension[]): string[] {
  return dimensions.filter(item => item.status !== 'known').map(item => `${item.key}: ${item.gap ?? '未知'}`);
}

export function isPublishAction(action: unknown): boolean {
  return action === 'publish';
}

/**
 * 材料级路由只回答“原件已保管后下一步是什么”。即使六维已齐，没有处理计划也不能声称候选就绪。
 * 输出级路由在 refresh 后还会叠加 structured/failed/blocked 事实。
 */
export function deriveMaterialRouting(facts: RoutingDecisionFacts): RoutingDecision {
  const gaps = unique(gapsForDimensions(facts.dimensions));
  if (facts.rejected) return { custodyState: facts.material.custodyState, routingState: 'rejected', gaps: unique([...gaps, '操作者明确拒绝该材料用途。']) };
  if (facts.material.support !== 'supported') return { custodyState: facts.material.custodyState, routingState: 'needs_adapter', gaps: unique([...gaps, `材料解析支持状态为 ${facts.material.support}；缺适配器。`]) };
  if (CLASSIFICATION_DIMENSIONS.some(key => facts.dimensions.find(item => item.key === key)?.status !== 'known')) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_classification', gaps: unique([...gaps, '材料角色、信息性质、业务对象或结构粒度待分类。']) };
  }
  if (REVIEW_DIMENSIONS.some(key => facts.dimensions.find(item => item.key === key)?.status !== 'known')) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '对象与时间或使用目的待核对；用途不能由材料或模型自授。']) };
  }
  if (isPublishAction(facts.intendedAction) && !facts.target?.present) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_target', gaps: unique([...gaps, '发布用途尚无已有产品引用或完整新声明。']) };
  }
  return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '材料级六维已齐，但尚未编译并完成独立输出处理步骤。']) };
}

export interface OutputRoutingFacts extends RoutingDecisionFacts {
  outputState: 'pending' | 'structured' | 'blocked' | 'failed' | 'custody_only';
  processingGaps: string[];
  adapterGaps: string[];
  /** 仅显式金融表格目标要求此门；通用结构检查与旧标量计划不因此改变。 */
  semantic?: { quality: 'pending' | 'pass' | 'fail' | 'indeterminate'; gaps: string[] } | null;
}
/** 输出级路由：逐输出独立；已完成核对为 ready_candidate，发布用途仍须目标。 */
export function deriveOutputRouting(facts: OutputRoutingFacts): RoutingDecision {
  const gaps = unique([...gapsForDimensions(facts.dimensions), ...facts.adapterGaps, ...facts.processingGaps, ...(facts.semantic?.gaps ?? [])]);
  if (facts.rejected) return { custodyState: facts.material.custodyState, routingState: 'rejected', gaps: unique([...gaps, '操作者明确拒绝该输出用途。']) };
  if (facts.adapterGaps.length || facts.material.support !== 'supported') return { custodyState: facts.material.custodyState, routingState: 'needs_adapter', gaps };
  if (CLASSIFICATION_DIMENSIONS.some(key => facts.dimensions.find(item => item.key === key)?.status !== 'known')) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_classification', gaps: unique([...gaps, '输出角色、信息性质、业务对象或结构粒度待分类。']) };
  }
  if (REVIEW_DIMENSIONS.some(key => facts.dimensions.find(item => item.key === key)?.status !== 'known')) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '输出对象与时间或使用目的待核对；未知未按不适用跳过。']) };
  }
  if (facts.outputState === 'failed') return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '输出处理失败；保留原件与上游产物，未形成通过证明。']) };
  if (facts.outputState === 'blocked') return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '输出处理仍有阻塞步骤；未形成候选。']) };
  if (facts.usage && facts.usage.status !== 'eligible') {
    return { custodyState: facts.material.custodyState, routingState: 'needs_review',
      gaps: unique([...gaps, ...facts.usage.gaps]) };
  }
  if (isPublishAction(facts.intendedAction) && !facts.target?.present) {
    return { custodyState: facts.material.custodyState, routingState: 'needs_target', gaps: unique([...gaps, '发布用途尚无冻结的已有产品引用或完整新声明。']) };
  }
  if (facts.semantic && facts.semantic.quality !== 'pass') {
    return { custodyState: facts.material.custodyState, routingState: 'needs_review',
      gaps: unique([...gaps, `本输出金融规则核对为 ${facts.semantic.quality}；结构产物不代表金融发布资格。`]) };
  }
  if (facts.outputState === 'structured') return { custodyState: facts.material.custodyState, routingState: 'ready_candidate', gaps };
  if (facts.outputState === 'custody_only') return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '仅保管原件，尚未声明可执行表源规则。']) };
  return { custodyState: facts.material.custodyState, routingState: 'needs_review', gaps: unique([...gaps, '处理步骤尚未完成。']) };
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

import type { R1ProductReadInput } from './r1-contracts.js';
import type { TaskFailure, TaskStatus } from './task-contracts.js';
import type { FinancialCalculation } from '../modules/collection/data-processing/financial-fixed.js';
import type { MacroYoYCalculation } from '../modules/collection/data-processing/polars-fixed.js';

export const FIXED_CALCULATION_VERSION = 'bd.fixed-calculations/1';
/** 唯一固定方法表。登记不启用已撤销的旧金融资产，也不提供调用方选引擎的入口。 */
export const FIXED_CALCULATION_METHODS = Object.freeze({
  observation_ma20: { title: '日线观测20期均值', defaultImplementation: 'polars',
    legacyDescription: 'explicit source-observation rows, full window20, 8-place half-even',
    description: '按来源原报的完整日线系列计算20期均值，完整窗口后出值，缺值保留未知。',
    input: 'associated_daily_sources', scope: '来源观测；价格基准、币种及历史公开资格不在本次计算中补定。' },
  financial_linear: { title: '财务单季与近十二个月', defaultImplementation: 'polars',
    legacyDescription: 'existing financial-fixed contract and fixed trusted reader; quarter difference or TTM',
    description: '对同主体、同范围的中国企业会计准则和人民币元可加流量，计算相邻累计差或近十二个月值。',
    input: 'fixed_financial_records', scope: '每次一个科目；仅自然财年明确期间及整表本期、比较期或整体列，分部、权益分项和更正调整列不适用。同披露修订直接核对，跨修订另需受信原文核验；不将存量、比率或未知值套入累计算术。' },
  macro_yoy: { title: '宏观同比', defaultImplementation: 'polars',
    legacyDescription: 'two explicit fixed source releases with comparable series/base/seasonality; snapshot contents only',
    description: '从本期与去年同期间两条明确来源版本计算百分比，系列、地区、单位、季调及基期须一致。',
    input: 'fixed_macro_records', scope: '只声明固定快照内容；来源公布时间校验不授予历史可知资格。' },
} as const);
export type FixedCalculationMethodId = keyof typeof FIXED_CALCULATION_METHODS;
export type FixedCalculationInput = { requestId: string } & (
  { method: 'observation_ma20'; autoRequestIds: string[]; valueColumn: string }
  | { method: 'financial_linear'; calculation: FinancialCalculation }
  | { method: 'macro_yoy'; calculation: MacroYoYCalculation });
export interface FixedCalculationCapabilities {
  version: typeof FIXED_CALCULATION_VERSION;
  configured: boolean;
  methods: Array<{ id: FixedCalculationMethodId } & typeof FIXED_CALCULATION_METHODS[FixedCalculationMethodId]>;
  routing: 'fixed_by_method';
  query: { engine: 'duckdb'; role: 'query_only'; registeredCalculationMethods: 0 };
  existingWorkflows: { method: 'source_observation_ma'; scope: 'existing_daily_minute_batch'; implementation: 'existing_exact_decimal'; period: 'saved_batch_settings' };
  publication: 'candidate_only';
  limits: { inputRows: number; inputBytes: number; outputBytes: number; processTimeoutMs: number };
  reason: string | null;
}
export interface FixedCalculationSource {
  autoRequestId: string; materialId: string; filename: string; rowCount: number;
  productId: string; snapshotId: string; valueColumns: string[];
}
export interface FixedCalculationProduct {
  productId: string; datasetId: string; subject: Record<string, unknown>; semanticCode: string;
  methods: Array<'financial_linear' | 'macro_yoy'>;
}
export interface FixedCalculationInputs {
  snapshotId: string | null; sources: FixedCalculationSource[]; products: FixedCalculationProduct[];
  sourceLimit: 20; gaps: string[];
}
export interface FixedCalculationRecordPage {
  snapshotId: string; productId: string;
  rows: Array<{ businessKey: string; recordVersion: string; values: Record<string, unknown> }>;
  page: { hasMore: boolean; nextCursor: string | null };
}
export type FixedCalculationRecordsInput = Pick<R1ProductReadInput, 'snapshotId' | 'productId' | 'cursor'>;
export interface FixedCalculationTaskView {
  version: typeof FIXED_CALCULATION_VERSION;
  methodId: FixedCalculationMethodId;
  implementation: 'polars';
  task: { id: string; requestId: string; status: TaskStatus; version: number; updatedAt: number;
    requiresReview: boolean; error: TaskFailure | null };
  result: { rowCount: number; sha256: string; rows: Record<string, unknown>[];
    algorithmDefinition: Record<string, unknown> } | null;
  candidate: { custodyTaskId: string | null; materialId: string | null } | null;
}
export interface FixedCalculationCandidateSelection {
  taskId: string; materialId: string; methodId: FixedCalculationMethodId;
  algorithmDefinition: Record<string, unknown>;
}

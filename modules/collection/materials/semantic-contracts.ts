import type { MaterialCategory, MaterialLocation, MaterialScalar, MaterialSemanticKey } from './contracts.js';
import type { AuthorizationReceipt } from '../../../platform/security/permissions.js';

export const MATERIAL_SEMANTIC_PROPOSAL_VERSION = 1 as const;
export const MATERIAL_CLEANING_RULES_VERSION = 'material-cleaning/1' as const;
/** 无偏移时只接受唯一原句；持久记录总是补齐精确偏移和行列。 */
export type OriginalSemanticEvidence = { source: 'original'; start?: number; end?: number; quote: string; line?: number; column?: number };
export type UserMessageSemanticEvidence = { source: 'user-message'; messageId: string; start?: number; end?: number; quote: string; line?: number; column?: number };
export type SemanticEvidence = OriginalSemanticEvidence | UserMessageSemanticEvidence;
export interface SemanticJudgment {
  id: string;
  key: MaterialSemanticKey | 'dateFormat' | 'decimalFormat';
  /** 无 scope 为整份材料；column:N 为 1 基字段。 */
  scope?: string;
  status: 'known' | 'unknown' | 'conflict';
  value?: string;
  evidence: SemanticEvidence[];
}
export type MaterialDateFormat = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYYMMDD';
export interface SemanticQuestion { id: string; prompt: string; judgmentIds?: string[] }
export interface MaterialSemanticProposal {
  materialId: string;
  originalSha256: string;
  proposalVersion: typeof MATERIAL_SEMANTIC_PROPOSAL_VERSION;
  rulesVersion: typeof MATERIAL_CLEANING_RULES_VERSION;
  supersedesProposalId?: string;
  /** 同一原件的模型用途判断；不改接收类别，不充当用户声明。 */
  classification?: { category: 'data' | 'tool'; reason: string; evidence: SemanticEvidence[] };
  judgments: SemanticJudgment[];
  table?: {
    /** 物理原件行号，从 1 开始；允许跳过前言，绝不从模型接受数据行。 */
    headerLine: number;
    headerEvidence: OriginalSemanticEvidence;
    fields: { column: number; name: string; evidence: SemanticEvidence[] }[];
  };
  cleaning: {
    trim: boolean;
    emptyToNull: boolean;
    dates: { column: number; format: MaterialDateFormat; evidence: SemanticEvidence[] }[];
    decimals: { column: number; evidence: SemanticEvidence[] }[];
    requiredJudgmentIds?: string[];
  };
  questions?: SemanticQuestion[];
  /** 新提案引用旧提案问题及宿主实际收到的新用户回复；不接受 confirmed 布尔值。 */
  confirmations?: { proposalId?: string; questionId: string; evidence: UserMessageSemanticEvidence }[];
}
export type SemanticAdoption = {
  kind: 'authorized-rule'; requestMessageId: string; operationId: string; argsDigest: string;
  approvalId?: string; grantIds?: string[];
  /** 自动范围沿用宿主实际权限回执；不伪造审批或持续授权编号。 */
  authorization?: AuthorizationReceipt;
} | { kind: 'user-confirmation'; evidence: UserMessageSemanticEvidence };
/** 仅受信宿主构造；这些身份与授权不得来自模型提案参数。 */
export interface TrustedMaterialOrigin {
  provider: string; model: string; modelDigest: string; endpointDigest: string;
  conversationId: string; branchId: string; parentRunId: string; parentGeneration: number;
  inputId: string; messageId: string; toolCallId: string; callId: string; localBridgeTaskId: string;
  userMessages: { id: string; text: string }[];
  adoption: SemanticAdoption;
}
export interface AppliedMaterialChange {
  operation: 'trim' | 'empty_to_null' | 'field_mapping' | 'date_normalize' | 'decimal_normalize' | 'align_missing_key';
  original: MaterialScalar; applied: MaterialScalar; location: MaterialLocation; quote: string;
}
export interface SemanticProcessedTable {
  columns: { original: string; applied: string; location: MaterialLocation; quote: string }[];
  rows: { original: MaterialScalar; applied: MaterialScalar; sourceType: string; location: MaterialLocation; quote: string }[][];
  totalRows: number;
}
export interface MaterialSemanticRecord {
  envelope: {
    proposalId: string; serviceTaskId: string; materialId: string; originalSha256: string;
    proposalVersion: number; rulesVersion: string; processorVersion: string; createdAt: number; localOnly: true;
  };
  proposal: MaterialSemanticProposal;
  origin: TrustedMaterialOrigin;
  result: {
    status: 'processed' | 'candidates_saved' | 'needs_confirmation' | 'needs_adapter' | 'unsupported';
    applied: boolean;
    /** 身份沿用本记录的 materialId、originalSha256 和 proposalId。 */
    classification: { category: MaterialCategory; source: 'pending' | 'intake-category' | 'model-proposal'; reason: string };
    /** unknown/conflict 绝不进入已采用事实；证据原始类型始终保留。 */
    adoptedKnown: SemanticJudgment[];
    questions: SemanticQuestion[];
    table: SemanticProcessedTable | null;
    changes: AppliedMaterialChange[];
    originalPreserved: true; formalIngest: false; computationRegistered: false;
    limitations: string[];
  };
}

const originalEvidenceSchema = { type: 'object', additionalProperties: false, required: ['source', 'quote'], properties: {
  source: { const: 'original' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 10000 }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
} };
const userEvidenceSchema = { type: 'object', additionalProperties: false, required: ['source', 'messageId', 'quote'], properties: {
  source: { const: 'user-message' }, messageId: { type: 'string', minLength: 1, maxLength: 200 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 10000 }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
} };
const evidenceArraySchema = { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [originalEvidenceSchema, userEvidenceSchema] } };
/** 提供给同一 Pi 会话的提案结构；运行身份、授权、数据行只能由宿主/程序给出。 */
export const SEMANTIC_PROPOSAL_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['materialId', 'originalSha256', 'proposalVersion', 'rulesVersion', 'judgments', 'cleaning'],
  properties: {
    materialId: { type: 'string', minLength: 1, maxLength: 200 }, originalSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    proposalVersion: { const: MATERIAL_SEMANTIC_PROPOSAL_VERSION }, rulesVersion: { const: MATERIAL_CLEANING_RULES_VERSION },
    supersedesProposalId: { type: 'string', minLength: 1, maxLength: 200 },
    classification: { type: 'object', additionalProperties: false, required: ['category', 'reason', 'evidence'], properties: {
      category: { enum: ['data', 'tool'] }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, evidence: evidenceArraySchema,
    } },
    judgments: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false,
      required: ['id', 'key', 'status', 'evidence'], properties: {
        id: { type: 'string', minLength: 1, maxLength: 200 }, key: { enum: ['field', 'unit', 'currency', 'period', 'adjustment', 'timeAvailability', 'methodName', 'parameters', 'dependencies', 'version', 'source', 'dateFormat', 'decimalFormat'] },
        scope: { type: 'string', minLength: 1, maxLength: 200 }, status: { enum: ['known', 'unknown', 'conflict'] },
        value: { type: 'string', minLength: 1, maxLength: 2000 }, evidence: { ...evidenceArraySchema, minItems: 0 },
      } } },
    table: { type: 'object', additionalProperties: false, required: ['headerLine', 'headerEvidence', 'fields'], properties: {
      headerLine: { type: 'integer', minimum: 1 }, headerEvidence: originalEvidenceSchema,
      fields: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['column', 'name', 'evidence'], properties: {
        column: { type: 'integer', minimum: 1, maximum: 64 }, name: { type: 'string', minLength: 1, maxLength: 512 }, evidence: evidenceArraySchema,
      } } },
    } },
    cleaning: { type: 'object', additionalProperties: false, required: ['trim', 'emptyToNull', 'dates', 'decimals'], properties: {
      trim: { type: 'boolean' }, emptyToNull: { type: 'boolean' },
      dates: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['column', 'format', 'evidence'], properties: {
        column: { type: 'integer', minimum: 1, maximum: 64 }, format: { enum: ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD'] }, evidence: evidenceArraySchema,
      } } },
      decimals: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['column', 'evidence'], properties: {
        column: { type: 'integer', minimum: 1, maximum: 64 }, evidence: evidenceArraySchema,
      } } },
      requiredJudgmentIds: { type: 'array', maxItems: 80, items: { type: 'string', minLength: 1, maxLength: 200 } },
    } },
    questions: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['id', 'prompt'], properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 }, prompt: { type: 'string', minLength: 1, maxLength: 2000 }, judgmentIds: { type: 'array', maxItems: 80, items: { type: 'string', minLength: 1, maxLength: 200 } },
    } } },
    confirmations: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['questionId', 'evidence'], properties: {
      proposalId: { type: 'string', minLength: 1, maxLength: 200 }, questionId: { type: 'string', minLength: 1, maxLength: 200 }, evidence: userEvidenceSchema,
    } } },
  },
});

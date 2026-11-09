import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

/**
 * 共用用途资格的最小确定性判定器。
 *
 * 本模块只做一件事：给定固定的对象/产物摘要、具体版本、实际证据、真实授权用途、
 * 历史模式/截止和规则版本，返回合格、不合格或证据不足，以及检查范围和缺口。
 * 它不读库、不写库、不发布、不暂停事项、不产生新版本，也不实现第二套 WFD 历史
 * 选择规则。历史请求的版本与公开/持有证据以 WFD 实际读取结果或实际来源回执为准；
 * 调用者只能提供预期，不能把声明当事实。
 *
 * 用途义务：
 * - custody/parse/structure_check：只依赖固定内容；公开时间未知不影响。
 * - current_compute：当前内容计算；公开时间未知不影响，但实际限制证据若显示暂停则拒绝。
 * - current_publish：当前发布；需要真实用途证据与实际限制检查，发布授权仍由 R1 单独核对。
 * - historical_view/historical_compute：依赖历史可得性；必须有显式历史模式、截止、
 *   具体版本和实际公开/持有证据。固定快照内容本身不等于历史可知资格。
 */
export const PURPOSE_ELIGIBILITY_RULE_VERSION = 'bd.purpose-eligibility/2';

export const ELIGIBILITY_PURPOSES = [
  'custody', 'parse', 'structure_check', 'current_compute', 'current_publish',
  'historical_view', 'historical_compute', 'historical_publish',
] as const;
export type EligibilityPurpose = typeof ELIGIBILITY_PURPOSES[number];

export const ELIGIBILITY_HISTORY_MODES = ['snapshot_contents', 'market_known_at', 'system_held_at'] as const;
export type EligibilityHistoryMode = typeof ELIGIBILITY_HISTORY_MODES[number];

export type EligibilityStatus = 'eligible' | 'ineligible' | 'insufficient_evidence';
export type EvidenceTimePrecision = 'day' | 'minute' | 'second';
export type ObjectOrigin = 'wfd_product' | 'managed_original' | 'derived_candidate';

export interface PurposeEvidenceClaim {
  /** 该证据实际支持的用途；与请求用途不同即冲突，不静默取其一。 */
  purpose: EligibilityPurpose;
  /** 只接受真实操作者请求字段或受信宿主核对过的真实用户消息；模型建议不能进入此结构。 */
  authority: 'operator-http' | 'user-message';
  quote: string;
  observedAtUtc: string;
  evidenceSha256: string;
  requestId?: string;
  messageId?: string;
}

export interface HistoryRequest {
  /** 复用现有 history_mode/perspective 稳定名称。 */
  mode: EligibilityHistoryMode | null;
  /** 历史请求必须固定截止；未声明历史时保持 null，不自动提升历史资格。 */
  cutoff: string | null;
  perspective: string | null;
}

export interface FixedObjectEvidence {
  objectSha256: string;
  origin: ObjectOrigin;
  productId: string | null;
  snapshotId: string | null;
  recordVersion: string | null;
  definitionRevision: string | null;
  /** 实际字节/固定返回已重新核对，不只是调用者声明。 */
  contentVerified: boolean;
  contentBasis: string;
}

export interface PublicationTimeEvidence {
  authority: 'wfd_product_read' | 'publication_receipt' | 'material_public_time_field' | 'declared_bar_close';
  status: 'known' | 'unknown';
  objectSha256: string;
  recordVersion: string | null;
  earliestUtc: string | null;
  latestExclusiveUtc: string | null;
  precision: EvidenceTimePrecision | null;
  sourceTimezone: string | null;
  basis: string;
  evidenceSha256: string;
  /** 来源文件自带公开时间时为 false；仍作为实际文件证据使用，但明确未独立核验。 */
  independentlyVerified: boolean;
}

export interface HoldingTimeEvidence {
  authority: 'wfd_holding_ledger';
  status: 'known' | 'unknown';
  objectSha256: string;
  recordVersion: string | null;
  receivedAtUtc: string | null;
  heldScope: string | null;
  usableStage: string | null;
  basis: string;
  evidenceSha256: string;
}

export interface RevisionEvidence {
  authority: 'wfd_product_read' | 'publication_receipt' | 'material_public_time_field';
  recordVersion: string;
  /** 在该历史视角/截止下 WFD 实际给出的修订状态；current 才可作为当时有效叶。 */
  stateAtCutoff: 'current' | 'superseded' | 'withdrawn' | 'unknown';
  supersedes: string | null;
  supersededBy: string | null;
  selectionBasis: string;
  evidenceSha256: string;
}

export interface WfdHistorySupportEvidence {
  authority: 'wfd_product_contract';
  productId: string;
  snapshotId: string;
  /** 实际产品合同 contracts.read.perspectives，不是调用者声明。 */
  readPerspectives: EligibilityHistoryMode[];
  currentOnlyBusiness: boolean;
  readPerspective: EligibilityHistoryMode | null;
  readAt: string | null;
  evidenceSha256: string;
  currentOnlyBusinessBasis: string;
}

export type RestrictionEvidence =
  | {
    authority: 'wfd_usage_governance';
    publishable: boolean;
    computeEligible: boolean;
    auditReproduction: boolean;
    checkedAtUtc: string;
    validUntilUtc?: string;
    scope?: Record<string, unknown>;
    issueCodes: string[];
    evidenceSha256: string;
  }
  | {
    authority: 'wfd_usage_governance_check';
    result: 'no_known_issue';
    checkedAtUtc: string;
    validUntilUtc?: string;
    scope?: Record<string, unknown>;
    evidenceSha256: string;
  };

export interface DerivedInputEvidence {
  ref: string;
  latestAvailableAtUtc: string | null;
  basis: string;
  evidenceSha256: string;
}

export interface DerivedCalculationEvidence {
  methodVersion: string;
  businessTime: string | null;
  inputs: DerivedInputEvidence[];
  computedAtUtc: string | null;
  computedAtBasis: string;
  publishedAtUtc: string | null;
  usableAtUtc: string | null;
  resultObjectSha256: string;
}

export interface WfdDecisionEvidence {
  decision: 'eligible' | 'ineligible' | 'indeterminate';
  reason: string;
}

export interface PurposeEligibilityInput {
  ruleVersion: string;
  purpose: EligibilityPurpose;
  purposeEvidence: PurposeEvidenceClaim[] | null;
  history: HistoryRequest;
  object: FixedObjectEvidence;
  publicationTime: PublicationTimeEvidence | null;
  holdingTime: HoldingTimeEvidence | null;
  revisions: RevisionEvidence[] | null;
  wfdHistory: WfdHistorySupportEvidence | null;
  restriction: RestrictionEvidence | null;
  derived: DerivedCalculationEvidence | null;
  /** WFD 实际读取对该行给出的资格决定；调用者不能自行改写。 */
  wfdDecision: WfdDecisionEvidence | null;
  /** 使用边界：候选形成、R1准备、首次发送；仅影响缺失限制证据的严格度。 */
  boundary?: 'candidate' | 'prepare' | 'first_send';
  /** 当前核对时刻；用于拒绝过期限制证据。缺省不做墙钟判断。 */
  nowUtc?: string | null;
}

export interface EligibilityCheck {
  id: string;
  status: 'pass' | 'fail' | 'unknown' | 'not_required' | 'not_applicable';
  detail: string;
}

export interface EligibilityGap {
  code: string;
  scope: string;
  message: string;
  /** blocking=true 时阻止该用途；blocking=false 只保留明确缺口。 */
  blocking: boolean;
  kind: 'ineligible' | 'unknown' | 'advisory';
}

export interface EligibilityTimings {
  businessTime: string | null;
  latestInputAvailableAtUtc: string | null;
  computedAtUtc: string | null;
  publishedAtUtc: string | null;
  usableAtUtc: string | null;
  /** false 表示“今天按旧信息重算的回放产物”，不得冒称截止前已存在。 */
  existedAtCutoff: boolean | null;
}

export interface PurposeEligibilityResult {
  ruleVersion: string;
  status: EligibilityStatus;
  purpose: EligibilityPurpose;
  purposeEvidence: 'declared' | 'not_declared';
  history: { mode: EligibilityHistoryMode | null; cutoff: string | null; perspective: string | null; historical: boolean };
  checks: EligibilityCheck[];
  gaps: EligibilityGap[];
  checkedScope: string[];
  historyUse: 'current' | 'snapshot_contents' | 'known_at_cutoff' | 'replay' | null;
  timings: EligibilityTimings | null;
  evidenceSha256: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HISTORY_PURPOSES = new Set<EligibilityPurpose>(['historical_view', 'historical_compute', 'historical_publish']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function canonicalInstant(value: string): string { return new Date(Date.parse(value)).toISOString().replace('.000Z', 'Z'); }
function day(value: unknown): boolean {
  return typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }

/**
 * 纯函数判定。同一输入（同一证据）必须得到同一输出；不读取当前时间、不写库。
 */
export function evaluatePurposeEligibility(input: PurposeEligibilityInput): PurposeEligibilityResult {
  const checks: EligibilityCheck[] = [];
  const gaps: EligibilityGap[] = [];
  const check = (id: string, status: EligibilityCheck['status'], detail: string): void => {
    checks.push({ id, status, detail });
  };
  const gap = (code: string, scope: string, message: string, kind: EligibilityGap['kind']): void => {
    gaps.push({ code, scope, message, blocking: kind !== 'advisory', kind });
  };

  const historyMode = input.history?.mode ?? null;
  const cutoff = input.history?.cutoff ?? null;
  const perspective = input.history?.perspective ?? null;
  const historical = HISTORY_PURPOSES.has(input.purpose);
  const cutoffMs = instant(cutoff);
  const ruleOk = input.ruleVersion === PURPOSE_ELIGIBILITY_RULE_VERSION;
  check('rule_version', ruleOk ? 'pass' : 'fail',
    ruleOk ? PURPOSE_ELIGIBILITY_RULE_VERSION : `实际规则版本 ${String(input.ruleVersion)} 与当前 ${PURPOSE_ELIGIBILITY_RULE_VERSION} 不同。`);
  if (!ruleOk) gap('RULE_VERSION_MISMATCH', 'rule', '规则版本不符；不能沿用旧规则签当前资格。', 'ineligible');

  // 固定内容：所有用途的最低义务；未知公开时间不影响保管、解析和结构检查。
  const object = input.object;
  const objectOk = isRecord(object) && hash(object.objectSha256) && object.contentVerified === true
    && text(object.contentBasis) && (object.origin === 'wfd_product' || object.origin === 'managed_original' || object.origin === 'derived_candidate');
  check('content_fixed', objectOk ? 'pass' : object?.contentVerified === false ? 'fail' : 'unknown',
    objectOk ? `${object.contentBasis}；对象摘要 ${object.objectSha256}。` : '固定对象摘要或实际内容核对缺失。');
  if (!objectOk) gap('CONTENT_NOT_FIXED', 'content', '没有可核对的实际固定内容/产物摘要；来源声明不能代替实际字节或固定返回。', object?.contentVerified === false ? 'ineligible' : 'unknown');

  // 真实授权用途。
  const claims = input.purposeEvidence;
  const declared = Array.isArray(claims) && claims.length > 0;
  const claimProblems: string[] = [];
  if (declared) {
    for (const [index, claim] of claims.entries()) {
      if (!isRecord(claim) || !(ELIGIBILITY_PURPOSES as readonly unknown[]).includes(claim.purpose)
        || (claim.authority !== 'operator-http' && claim.authority !== 'user-message')
        || !text(claim.quote) || !hash(claim.evidenceSha256) || instant(claim.observedAtUtc) === null
        || (claim.authority === 'operator-http' ? !text(claim.requestId) : !text(claim.messageId))) {
        claimProblems.push(`claims[${index}]`);
        continue;
      }
      if (claim.purpose !== input.purpose) claimProblems.push(`claims[${index}].purpose`);
    }
  }
  const purposeRequired = historical || input.purpose === 'current_publish';
  if (claimProblems.length) {
    check('purpose_evidence', 'fail', `用途证据结构不可信：${claimProblems.join(',')}`);
    gap('PURPOSE_EVIDENCE_UNTRUSTED', 'purpose', '用途须由真实操作者请求字段或受信用户消息支持；模型建议、材料自述或结构不全的声明不能自授用途。', 'unknown');
  } else if (declared) {
    check('purpose_evidence', 'pass', `${claims!.length} 条真实来源证据与用途 ${input.purpose} 一致。`);
  } else if (purposeRequired) {
    check('purpose_evidence', 'unknown', `用途 ${input.purpose} 需要真实操作者/用户证据，实际未声明。`);
    gap('PURPOSE_EVIDENCE_REQUIRED', 'purpose', '该用途不能默认自授；缺少真实操作者请求或用户消息证据。', 'unknown');
  } else {
    check('purpose_evidence', 'not_required', '当前内容用途不依赖发布/历史资格；未声明用途不提升任何资格。');
    gap('PURPOSE_NOT_DECLARED', 'purpose', '未声明真实用途；按当前内容用途处理，不授予发布或历史资格。', 'advisory');
  }

  // 历史模式/截止/视角的一致性。
  let historyOk = true;
  if (historical) {
    if (historyMode === null) {
      historyOk = false; check('history_request', 'unknown', '历史用途未声明历史模式。');
      gap('HISTORY_MODE_REQUIRED', 'history', '历史请求必须显式选择现有 history_mode/perspective，不能默认为快照内容。', 'unknown');
    } else if (historyMode === 'snapshot_contents') {
      historyOk = false; check('history_request', 'fail', 'snapshot_contents 只证明快照内容固定，不产生历史可知资格。');
      gap('SNAPSHOT_CONTENTS_NOT_HISTORICAL', 'history', '固定快照内容不是公开/持有时间证据；历史用途须改用实际 market_known_at/system_held_at 证据。', 'ineligible');
    } else if (cutoffMs === null) {
      historyOk = false; check('history_request', 'unknown', '历史用途未声明有效截止。');
      gap('HISTORY_CUTOFF_REQUIRED', 'history', '历史请求必须固定有效的知识截止时刻。', 'unknown');
    } else if (perspective !== null && perspective !== historyMode) {
      historyOk = false; check('history_request', 'fail', `视角 ${perspective} 与历史模式 ${historyMode} 不一致。`);
      gap('HISTORY_PERSPECTIVE_MISMATCH', 'history', '视角名称必须与历史模式一致，不能用一个标签绕过另一个。', 'ineligible');
    } else {
      check('history_request', 'pass', `历史模式 ${historyMode}，截止 ${cutoff}。`);
    }
  } else if (historyMode !== null && historyMode !== 'snapshot_contents') {
    historyOk = false; check('history_request', 'fail', `当前用途 ${input.purpose} 携带历史模式 ${historyMode}。`);
    gap('HISTORY_MODE_WITHOUT_HISTORICAL_PURPOSE', 'history', '历史模式与用途不一致；不静默升级为历史资格，也不降级冒充当前。', 'ineligible');
  } else {
    check('history_request', 'not_applicable', '当前内容用途；不声明历史资格。');
  }

  // 历史模式的产品支持、current_only_business 与 WFD 实际读取视角。
  if (historical && historyOk && historyMode && cutoff) {
    const support = input.wfdHistory;
    if (object.origin === 'wfd_product') {
      if (!isRecord(support)) {
        check('wfd_history_support', 'unknown', 'WFD 产品历史合同未提供。');
        gap('WFD_HISTORY_SUPPORT_REQUIRED', 'wfd_history', 'WFD 产品历史用途须引用实际产品合同与固定读取返回；不能只凭本机声明。', 'unknown');
      } else {
        const supportProblems: string[] = [];
        if (!hash(support.evidenceSha256) || support.productId !== object.productId || support.snapshotId !== object.snapshotId) {
          supportProblems.push('evidence_binding');
        }
        if (!(ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(historyMode)
          || !Array.isArray(support.readPerspectives) || !support.readPerspectives.includes(historyMode)) {
          supportProblems.push('read_perspectives');
        }
        if (support.currentOnlyBusiness && historyMode !== 'snapshot_contents') supportProblems.push('current_only_business');
        if (support.readPerspective !== historyMode || support.readAt === null || !instant(support.readAt)
          || canonicalInstant(support.readAt) !== canonicalInstant(cutoff)) supportProblems.push('actual_read_perspective');
        if (supportProblems.length) {
          if (supportProblems.includes('current_only_business')) {
            check('wfd_history_support', 'fail', '产品合同为 current_only_business，历史视角不受支持。');
            gap('CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED', 'wfd_history',
              `current_only_business（${support.currentOnlyBusinessBasis || 'contracts.read.perspectives'}）明确不支持 ${historyMode} 历史视角。`, 'ineligible');
          } else if (supportProblems.includes('read_perspectives')) {
            check('wfd_history_support', 'fail', `产品合同 read.perspectives=${support.readPerspectives.join(',')} 不含 ${historyMode}。`);
            gap('WFD_HISTORY_MODE_UNSUPPORTED', 'wfd_history', 'WFD 产品合同未声明该历史模式；不自行实现更宽松的替代规则。', 'ineligible');
          } else {
            check('wfd_history_support', 'unknown', `历史证据未绑定到本次对象/读取视角/截止：${supportProblems.join(',')}。`);
            gap('WFD_HISTORY_EVIDENCE_MISMATCH', 'wfd_history', '产品合同、读取视角、截止或对象摘要与本次历史请求不一致。', 'unknown');
          }
        } else {
          check('wfd_history_support', 'pass', `实际读取视角 ${support.readPerspective} @ ${support.readAt}；合同声明包含该模式。`);
        }
      }
    } else {
      check('wfd_history_support', 'not_applicable', '非 WFD 产品入口；按文件/回执的实际公开或持有证据判定。');
    }

    // WFD 实际资格决定（若该行走 WFD 读取）。
    if (input.wfdDecision) {
      const decision = input.wfdDecision;
      if (decision.decision === 'eligible') {
        check('wfd_row_eligibility', 'pass', `WFD 实际决定 eligible：${decision.reason || '无附加原因'}。`);
      } else if (decision.decision === 'ineligible') {
        check('wfd_row_eligibility', 'fail', `WFD 实际决定 ineligible：${decision.reason}。`);
        gap('WFD_ROW_INELIGIBLE', 'wfd_history', `WFD 实际读取判定该版本不满足 ${historyMode} @ ${cutoff}：${decision.reason}。`, 'ineligible');
      } else {
        check('wfd_row_eligibility', 'unknown', `WFD 实际决定 indeterminate：${decision.reason}。`);
        gap('WFD_ROW_INDETERMINATE', 'wfd_history', `WFD 实际读取不能确定该版本在截止时可知：${decision.reason}。`, 'unknown');
      }
    }

    // 公开时间 / 持有时间证据。派生结果自身的"公开时间"不是其历史可知依据；
    // 派生窗口由依赖可得时间与实际计算完成时间单独判定。
    if (object.origin === 'derived_candidate') {
      check('publication_time', 'not_applicable', '派生结果按依赖可得时间与实际计算完成时间判定；不伪造结果自身公开时间。');
    } else if (historyMode === 'market_known_at') {
      const publication = input.publicationTime;
      if (!isRecord(publication)) {
        check('publication_time', 'unknown', '缺少实际公开时间证据。');
        gap('PUBLIC_TIME_EVIDENCE_REQUIRED', 'publication', 'market_known_at 历史用途须有该具体版本的实际公开时间证据。', 'unknown');
      } else if (publication.objectSha256 !== object.objectSha256
        || (publication.recordVersion ?? null) !== (object.recordVersion ?? null)) {
        check('publication_time', 'unknown', '公开时间证据未绑定到本次对象/记录版本。');
        gap('PUBLIC_TIME_EVIDENCE_MISMATCH', 'publication', '公开时间证据属于另一对象或另一记录版本；不能移用到本次版本。', 'unknown');
      } else if (!hash(publication.evidenceSha256)) {
        check('publication_time', 'unknown', '公开时间证据摘要无效。');
        gap('PUBLIC_TIME_EVIDENCE_UNBOUND', 'publication', '公开时间缺少实际来源记录摘要。', 'unknown');
      } else if (publication.authority === 'declared_bar_close') {
        check('publication_time', 'fail', '声明收盘时间不是具体版本的实际公开时间证据。');
        gap('DECLARED_BAR_CLOSE_NOT_PUBLIC_EVIDENCE', 'publication',
          'bar_close 只是输入可得性声明；缺实际公开字段、回执或 WFD 公开时间时，不能签发 market_known_at 历史资格。', 'ineligible');
      } else if (publication.status !== 'known') {
        check('publication_time', 'unknown', '公开时间明确未知。');
        gap('PUBLIC_TIME_UNKNOWN', 'publication', '公开时间未知，不能补造或按业务日期替代。', 'unknown');
      } else if (!instant(publication.earliestUtc) || (publication.latestExclusiveUtc !== null && !instant(publication.latestExclusiveUtc))) {
        check('publication_time', 'unknown', '公开时间区间无效。');
        gap('PUBLIC_TIME_INVALID', 'publication', '公开时间区间不是有效时刻。', 'unknown');
      } else {
        const start = Date.parse(publication.earliestUtc!);
        const end = publication.latestExclusiveUtc === null ? start : Date.parse(publication.latestExclusiveUtc);
        if (end <= start) {
          check('publication_time', 'fail', '公开时间区间终点不晚于起点。');
          gap('PUBLIC_TIME_INVALID', 'publication', '公开时间区间无效。', 'ineligible');
        } else if (end <= cutoffMs!) {
          check('publication_time', 'pass', `公开时间 ${publication.earliestUtc}–${publication.latestExclusiveUtc ?? publication.earliestUtc} 已在截止前结束。`);
          if (!publication.independentlyVerified) {
            gap('PUBLIC_TIME_SOURCE_PROVIDED', 'publication', '公开时间来自来源文件字段，内容已固定但未独立核验；按实际文件证据保留该限制。', 'advisory');
          }
        } else if (start >= cutoffMs!) {
          check('publication_time', 'fail', `公开时间起点 ${publication.earliestUtc} 晚于截止 ${cutoff}。`);
          gap('PUBLICATION_AFTER_CUTOFF', 'publication', '该版本在历史截止之后才公开，不能用于该截止的历史用途。', 'ineligible');
        } else {
          check('publication_time', 'unknown', '公开时间区间跨越截止，精度不足。');
          gap('TIME_PRECISION_INSUFFICIENT', 'publication', '公开时间区间跨越截止，不能确定截止时是否已公开。', 'unknown');
        }
      }
    } else if (historyMode === 'system_held_at') {
      const holding = input.holdingTime;
      if (!isRecord(holding)) {
        check('holding_time', 'unknown', '缺少实际实例持有证据。');
        gap('HOLDING_TIME_EVIDENCE_REQUIRED', 'holding', 'system_held_at 历史用途须有实际实例持有台账证据。', 'unknown');
      } else if (holding.objectSha256 !== object.objectSha256
        || (holding.recordVersion ?? null) !== (object.recordVersion ?? null)) {
        check('holding_time', 'unknown', '持有证据未绑定到本次对象/记录版本。');
        gap('HOLDING_TIME_EVIDENCE_MISMATCH', 'holding', '持有证据属于另一对象或版本。', 'unknown');
      } else if (!hash(holding.evidenceSha256)) {
        check('holding_time', 'unknown', '持有证据摘要无效。');
        gap('HOLDING_TIME_EVIDENCE_UNBOUND', 'holding', '持有时间缺少实际台账摘要。', 'unknown');
      } else if (holding.status !== 'known' || instant(holding.receivedAtUtc) === null) {
        check('holding_time', 'unknown', '持有时间未知或无效。');
        gap('HOLDING_TIME_UNKNOWN', 'holding', '实例持有时间未知；来源取得邮件时间不能冒充目标实例持有。', 'unknown');
      } else if (!text(holding.heldScope) || !text(holding.usableStage)) {
        check('holding_time', 'unknown', '持有范围或可用阶段未知。');
        gap('HOLDING_SCOPE_UNKNOWN', 'holding', 'system_held_at 须显式固定 held_scope 与 usable_stage。', 'unknown');
      } else if (Date.parse(holding.receivedAtUtc!) > cutoffMs!) {
        check('holding_time', 'fail', `持有时间 ${holding.receivedAtUtc} 晚于截止 ${cutoff}。`);
        gap('HOLDING_AFTER_CUTOFF', 'holding', '该版本在历史截止之后才由目标实例持有。', 'ineligible');
      } else {
        check('holding_time', 'pass', `持有时间 ${holding.receivedAtUtc}；范围 ${holding.heldScope}；阶段 ${holding.usableStage}。`);
      }
    }

    // 修订选择：历史版本先按当时可得证据选择，不能被今天的最新修订替代。
    if (object.origin === 'wfd_product') {
      const revisions = input.revisions;
      if (revisions === null || revisions === undefined) {
        check('revision_selection', 'unknown', '缺少修订/版本状态证据。');
        gap('REVISION_EVIDENCE_REQUIRED', 'revision', '历史用途须核对具体记录版本及其在截止时的修订状态。', 'unknown');
      } else if (!object.recordVersion) {
        check('revision_selection', 'unknown', '未指定具体记录版本。');
        gap('RECORD_VERSION_REQUIRED', 'revision', '历史用途须显式到具体记录/修订版本，不能用最新版本代替。', 'unknown');
      } else {
        const matches = revisions.filter(item => isRecord(item) && item.recordVersion === object.recordVersion);
        if (matches.length !== 1) {
          check('revision_selection', 'unknown', `记录版本 ${object.recordVersion} 匹配 ${matches.length} 条修订证据。`);
          gap('REVISION_SELECTION_AMBIGUOUS', 'revision', '所选记录版本在修订证据中不唯一或不存在。', 'unknown');
        } else {
          const revision = matches[0]!;
          if (!hash(revision.evidenceSha256)) {
            check('revision_selection', 'unknown', '修订证据摘要无效。');
            gap('REVISION_EVIDENCE_UNBOUND', 'revision', '修订状态缺少实际读取证据摘要。', 'unknown');
          } else if (revision.stateAtCutoff === 'withdrawn') {
            check('revision_selection', 'fail', '所选版本在截止时已撤回。');
            gap('REVISION_WITHDRAWN', 'revision', '截止时已撤回的版本不能作为历史有效值。', 'ineligible');
          } else if (revision.stateAtCutoff === 'superseded') {
            check('revision_selection', 'fail', '所选版本在截止时已被更早可知的修订替代。');
            gap('REVISION_NOT_CURRENT_AT_CUTOFF', 'revision', '截止时已有更晚修订生效；应选择当时唯一有效叶，而不是今天读到的最新或任意旧版。', 'ineligible');
          } else if (revision.stateAtCutoff !== 'current') {
            check('revision_selection', 'unknown', '所选版本在截止时的修订状态未知。');
            gap('REVISION_STATE_UNKNOWN', 'revision', '不能确定该版本在截止时是否为有效叶。', 'unknown');
          } else {
            check('revision_selection', 'pass', `版本 ${revision.recordVersion} 在截止时为 current；依据 ${revision.selectionBasis}。`);
          }
        }
      }
    } else {
      check('revision_selection', 'not_applicable',
        object.origin === 'derived_candidate'
          ? '派生结果是本次新形成的回放产物；修订选择义务落在其依赖输入上，不伪造成 WFD 记录修订。'
          : '受管原件以固定内容摘要作为具体版本，不套用 WFD 记录修订链。');
    }
  }

  // 派生结果时间：业务时间、最晚依赖可得时间、实际计算时间与发布/可用时间分列。
  let timings: EligibilityTimings | null = null;
  if (input.derived) {
    const derived = input.derived;
    const inputTimes = Array.isArray(derived.inputs) ? derived.inputs : [];
    const computedAtMs = instant(derived.computedAtUtc);
    const invalidInputs = inputTimes.filter(item => !isRecord(item) || !text(item.ref) || instant(item.latestAvailableAtUtc) === null || !hash(item.evidenceSha256));
    const latestInput = inputTimes.length && !invalidInputs.length
      ? Math.max(...inputTimes.map(item => Date.parse(item.latestAvailableAtUtc!)))
      : null;
    timings = {
      businessTime: day(derived.businessTime) ? derived.businessTime : null,
      latestInputAvailableAtUtc: latestInput === null ? null : canonicalInstant(new Date(latestInput).toISOString()),
      computedAtUtc: computedAtMs === null ? null : canonicalInstant(new Date(computedAtMs).toISOString()),
      publishedAtUtc: instant(derived.publishedAtUtc) === null ? null : canonicalInstant(derived.publishedAtUtc!),
      usableAtUtc: instant(derived.usableAtUtc) === null ? null : canonicalInstant(derived.usableAtUtc!),
      existedAtCutoff: null,
    };
    const derivedOk = inputTimes.length > 0 && !invalidInputs.length && computedAtMs !== null && hash(derived.resultObjectSha256);
    check('derived_timings', derivedOk ? 'pass' : 'unknown',
      derivedOk ? `业务时间 ${timings.businessTime ?? 'unknown'}；依赖最晚可得 ${timings.latestInputAvailableAtUtc}；实际计算完成 ${timings.computedAtUtc}。`
        : '派生结果缺少完整依赖、实际计算时间或对象摘要。');
    if (!derivedOk) gap('DERIVED_EVIDENCE_INCOMPLETE', 'derived', '派生结果须保留业务时间、完整依赖的最晚可得时间、实际计算完成时间和结果摘要。', 'unknown');
    if (derived.resultObjectSha256 !== object.objectSha256) {
      gap('DERIVED_RESULT_MISMATCH', 'derived', '派生证据绑定的结果摘要与实际固定产物不同。', 'unknown');
      check('derived_binding', 'unknown', '派生证据与本次对象摘要不一致。');
    } else {
      check('derived_binding', 'pass', '派生证据绑定本次实际产物摘要。');
    }
    if (historical && historyOk && cutoffMs !== null && derivedOk) {
      if (invalidInputs.length || latestInput === null) {
        gap('DERIVED_INPUT_TIME_UNKNOWN', 'derived', '存在可得时间未知的依赖；不能证明整个窗口在截止前已知。', 'unknown');
      } else if (latestInput > cutoffMs) {
        check('derived_window', 'fail', `任一依赖最晚可得 ${timings.latestInputAvailableAtUtc} 晚于截止 ${cutoff}。`);
        gap('DERIVED_INPUT_AFTER_CUTOFF', 'derived', '派生窗口含晚于截止的任一输入，拒绝该历史用途。', 'ineligible');
      } else if (computedAtMs! > cutoffMs) {
        timings.existedAtCutoff = false;
        check('derived_window', 'pass', '全部依赖不晚于截止；但结果在截止后才实际算出，按回放产物处理。');
        gap('REPLAY_COMPUTED_AFTER_CUTOFF', 'derived',
          `结果实际计算完成于 ${timings.computedAtUtc}，晚于截止 ${cutoff}；只能标注为后来回放，不能冒称当时已有该结果。`, 'advisory');
      } else {
        timings.existedAtCutoff = true;
        check('derived_window', 'pass', '全部依赖及实际计算完成均不晚于截止。');
      }
    }
  } else if (historical && object.origin === 'derived_candidate') {
    check('derived_timings', 'unknown', '派生候选缺少派生时间证据。');
    gap('DERIVED_EVIDENCE_REQUIRED', 'derived', '派生结果的历史用途须保留依赖可得时间与实际计算完成时间。', 'unknown');
  } else {
    check('derived_timings', 'not_applicable', '非派生结果，未附加派生时间。');
  }

  // 实际限制证据：只消费，不自行暂停/解除事项。
  const restriction = input.restriction;
  const restrictionRelevant = input.purpose === 'current_compute' || input.purpose === 'current_publish'
    || input.purpose === 'historical_view' || input.purpose === 'historical_compute' || input.purpose === 'historical_publish';
  if (!restrictionRelevant) {
    check('restriction', 'not_required', '保管/解析/结构检查不依赖实际用途暂停证据；不据此阻断内容保管。');
  } else if (!isRecord(restriction) || !hash(restriction.evidenceSha256) || instant(restriction.checkedAtUtc) === null) {
    const publishBoundary = input.purpose === 'current_publish' || input.purpose === 'historical_publish';
    const strictBoundary = input.boundary !== 'candidate';
    if (publishBoundary && strictBoundary) {
      check('restriction', 'unknown', '发布准备/首次发送缺少实际 WFD 限制证据。');
      gap('RESTRICTION_EVIDENCE_REQUIRED', 'restriction',
        '发布准备/首次发送须消费实际 WFD 治理读取结果；候选阶段可保留缺口，发布边界不得降为 advisory。', 'unknown');
    } else {
      check('restriction', 'not_required', '本判定未取得实际限制证据；权威读取/提交闸口仍由 WFD 执行。');
      gap('RESTRICTION_NOT_CHECKED', 'restriction', '本入口未取得实际 WFD 限制证据；不声称已检查用途暂停，也不以本地标记替代 WFD 闸口。', 'advisory');
    }
  } else if (restriction.validUntilUtc !== undefined && input.nowUtc !== undefined && input.nowUtc !== null
    && instant(restriction.validUntilUtc) !== null && instant(input.nowUtc) !== null
    && Date.parse(input.nowUtc) > Date.parse(restriction.validUntilUtc)) {
    check('restriction', 'unknown', `限制证据已于 ${restriction.validUntilUtc} 过期。`);
    gap('RESTRICTION_EVIDENCE_EXPIRED', 'restriction', '限制证据超过有效期；须重新读取 WFD 权威状态，不能沿用旧证明。', 'unknown');
  } else if (restriction.authority === 'wfd_usage_governance') {
    const issueCodes = Array.isArray(restriction.issueCodes) ? restriction.issueCodes.filter(text) : [];
    const publishPurpose = input.purpose === 'current_publish' || input.purpose === 'historical_publish';
    const computePurpose = input.purpose === 'current_compute' || input.purpose === 'historical_view'
      || input.purpose === 'historical_compute';
    const denied = publishPurpose ? restriction.publishable !== true
      : computePurpose ? restriction.computeEligible !== true : false;
    if (denied) {
      check('restriction', 'fail', `实际治理：publishable=${String(restriction.publishable)}；compute_eligible=${String(restriction.computeEligible)}；issues=${issueCodes.join(',') || 'none'}。`);
      gap('USAGE_RESTRICTED', 'restriction', '实际 WFD 治理证据显示该用途受限；不自行解除或重标。', 'ineligible');
    } else if (restriction.auditReproduction) {
      check('restriction', 'fail', '审计复现结果不能作为默认业务/发布资格。');
      gap('AUDIT_REPRODUCTION_NOT_BUSINESS', 'restriction', '审计复现只用于技术读取；不能重标为发布或默认计算用途。', 'ineligible');
    } else {
      check('restriction', 'pass', '实际治理证据：无暂停，publishable/compute_eligible 为 true。');
    }
  } else if (restriction.authority === 'wfd_usage_governance_check' && restriction.result === 'no_known_issue') {
    check('restriction', 'pass', `实际 WFD 读取完成且未返回 usage_governance；检查时间 ${restriction.checkedAtUtc}。`);
  } else {
    check('restriction', 'unknown', '限制证据结构无效。');
    gap('RESTRICTION_EVIDENCE_INVALID', 'restriction', '限制证据结构或权威无法核对。', 'unknown');
  }

  check('authorization', 'not_applicable', '本规则只判定用途资格；R1 真实提交授权、目标合同和权限仍由 R1 边界单独核对。');

  const blocking = gaps.some(item => item.blocking);
  const status: EligibilityStatus = blocking
    ? (gaps.some(item => item.blocking && item.kind === 'ineligible') ? 'ineligible' : 'insufficient_evidence')
    : 'eligible';
  const checkedScope = checks.filter(item => item.status !== 'not_required' && item.status !== 'not_applicable').map(item => item.id);
  const historyUse: PurposeEligibilityResult['historyUse'] = historical
    ? (status !== 'eligible' ? null : timings !== null ? (timings.existedAtCutoff === null ? 'known_at_cutoff' : timings.existedAtCutoff ? 'known_at_cutoff' : 'replay') : 'known_at_cutoff')
    : historyMode === 'snapshot_contents' ? 'snapshot_contents' : input.purpose === 'current_compute' || input.purpose === 'current_publish' ? 'current' : null;
  return {
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
    status,
    purpose: input.purpose,
    purposeEvidence: declared ? 'declared' : 'not_declared',
    history: { mode: historyMode, cutoff: cutoff === null ? null : (cutoffMs === null ? cutoff : canonicalInstant(cutoff)), perspective, historical },
    checks,
    gaps,
    checkedScope,
    historyUse,
    timings,
    evidenceSha256: wfdSha256(canonicalWfdJson(input)),
  };
}

/**
 * 把已带结构化 purpose 字段的证据映射为共用用途声明。
 * 调用者不能传入一个“目标用途”给任意原话重新贴标签；没有 purpose 字段的证据一律不采用。
 */
export interface DimensionPurposeEvidenceLike {
  source: string;
  quote: string;
  purpose?: string;
  requestId?: string;
  messageId?: string;
  observedAt?: number;
}
export function purposeClaimsFromDimensionEvidence(
  evidence: readonly DimensionPurposeEvidenceLike[] | null | undefined): PurposeEvidenceClaim[] {
  const claims: PurposeEvidenceClaim[] = [];
  for (const item of evidence ?? []) {
    if (!item || (item.source !== 'operator-http' && item.source !== 'user-message') || !text(item.quote)) continue;
    if (item.purpose === undefined || !(ELIGIBILITY_PURPOSES as readonly unknown[]).includes(item.purpose)) continue;
    const authority = item.source;
    if (authority === 'user-message' && !text(item.messageId)) continue;
    const observedAt = typeof item.observedAt === 'number' && Number.isFinite(item.observedAt)
      ? new Date(item.observedAt).toISOString().replace('.000Z', 'Z') : null;
    if (observedAt === null) continue;
    claims.push({ purpose: item.purpose as EligibilityPurpose, authority, quote: item.quote, observedAtUtc: observedAt,
      evidenceSha256: wfdSha256(canonicalWfdJson(item)),
      ...(authority === 'operator-http' ? { requestId: text(item.requestId) ? item.requestId : 'operator-request' }
        : { messageId: item.messageId! }) });
  }
  return claims;
}

/**
 * 多行/多输入入口的确定性汇总：任一不合格即不合格；否则任一证据不足即证据不足。
 * 不丢掉各行缺口，不用“样本通过”代表整组通过。
 */
export function combinePurposeEligibilityResults(results: readonly PurposeEligibilityResult[]): PurposeEligibilityResult {
  if (!results.length) throw new TaskError('PURPOSE_ELIGIBILITY_INPUT', '至少需要一个实际行/输入判决。');
  const first = results[0]!;
  const status: EligibilityStatus = results.some(item => item.status === 'ineligible') ? 'ineligible'
    : results.some(item => item.status === 'insufficient_evidence') ? 'insufficient_evidence' : 'eligible';
  const gaps: EligibilityGap[] = [];
  const seen = new Set<string>();
  for (const result of results) for (const gap of result.gaps) {
    const key = `${gap.code}\u0000${gap.scope}\u0000${gap.message}`;
    if (seen.has(key)) continue; seen.add(key); gaps.push(gap);
  }
  const checks: EligibilityCheck[] = [];
  const checkSeen = new Set<string>();
  for (const result of results) for (const check of result.checks) {
    const key = `${check.id}\u0000${check.status}\u0000${check.detail}`;
    if (checkSeen.has(key)) continue; checkSeen.add(key); checks.push(check);
  }
  const latestInput = results.map(item => item.timings?.latestInputAvailableAtUtc).filter((item): item is string => !!item);
  const computed = results.map(item => item.timings?.computedAtUtc).filter((item): item is string => !!item);
  const timed = results.filter(item => item.timings);
  const timings: EligibilityTimings | null = timed.length ? {
    businessTime: first.timings?.businessTime ?? null,
    latestInputAvailableAtUtc: latestInput.length ? new Date(Math.max(...latestInput.map(item => Date.parse(item)))).toISOString().replace('.000Z', 'Z') : null,
    computedAtUtc: computed.length ? new Date(Math.max(...computed.map(item => Date.parse(item)))).toISOString().replace('.000Z', 'Z') : null,
    publishedAtUtc: first.timings?.publishedAtUtc ?? null,
    usableAtUtc: first.timings?.usableAtUtc ?? null,
    existedAtCutoff: timed.every(item => item.timings?.existedAtCutoff === true) ? true
      : timed.some(item => item.timings?.existedAtCutoff === false) ? false : null,
  } : null;
  return {
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
    status,
    purpose: first.purpose,
    purposeEvidence: results.every(item => item.purposeEvidence === 'declared') ? 'declared' : 'not_declared',
    history: first.history,
    checks,
    gaps,
    checkedScope: [...new Set(results.flatMap(item => item.checkedScope))],
    historyUse: results.every(item => item.historyUse === first.historyUse) ? first.historyUse
      : status === 'eligible' ? (first.history.historical ? 'known_at_cutoff' : 'current') : null,
    timings,
    evidenceSha256: wfdSha256(canonicalWfdJson(results.map(item => item.evidenceSha256))),
  };
}

/** 入口断言：合格返回原结果；不合格/证据不足抛出稳定 TaskError，附完整判决与缺口。 */
export function assertPurposeEligibility(input: PurposeEligibilityInput): PurposeEligibilityResult {
  const result = evaluatePurposeEligibility(input);
  if (result.status === 'eligible') return result;
  const payload = canonicalWfdJson({
    ruleVersion: result.ruleVersion, status: result.status, purpose: result.purpose,
    history: result.history, historyUse: result.historyUse, timings: result.timings,
    gaps: result.gaps.filter(item => item.blocking), checks: result.checks,
    evidenceSha256: result.evidenceSha256,
  });
  throw new TaskError(result.status === 'ineligible' ? 'PURPOSE_ELIGIBILITY_INELIGIBLE' : 'PURPOSE_ELIGIBILITY_INSUFFICIENT', payload);
}

function record(value: unknown): Record<string, unknown> | null { return isRecord(value) ? value : null; }
function wfdTime(value: unknown): { status: 'known' | 'unknown'; earliestUtc: string | null; latestExclusiveUtc: string | null;
  precision: EvidenceTimePrecision | null; sourceTimezone: string | null } {
  if (!isRecord(value) || value.status !== 'known') {
    return { status: 'unknown', earliestUtc: null, latestExclusiveUtc: null, precision: null, sourceTimezone: null };
  }
  const precision = value.precision === 'day' || value.precision === 'minute' || value.precision === 'second' ? value.precision : null;
  return {
    status: 'known',
    earliestUtc: instant(value.earliest_utc) === null ? null : canonicalInstant(String(value.earliest_utc)),
    latestExclusiveUtc: instant(value.latest_exclusive_utc) === null ? null : canonicalInstant(String(value.latest_exclusive_utc)),
    precision,
    sourceTimezone: text(value.source_timezone) ? value.source_timezone : null,
  };
}

/**
 * 从一次实际 WFD `fixed_read` 产品/行返回提取共用证据。
 * 调用者只提供实际返回；不提供可改写结论的字段。
 */
export function wfdFixedReadEvidence(input: {
  objectSha256: string;
  product: Record<string, unknown> | null;
  result: Record<string, unknown>;
  row: Record<string, unknown>;
  contentBasis: string;
  checkedAtUtc: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable' | null;
}): {
  object: FixedObjectEvidence;
  publicationTime: PublicationTimeEvidence;
  holdingTime: HoldingTimeEvidence | null;
  revision: RevisionEvidence;
  wfdHistory: WfdHistorySupportEvidence;
  restriction: RestrictionEvidence;
  wfdDecision: WfdDecisionEvidence | null;
} {
  const row = input.row, result = input.result, product = input.product;
  const recordRef = record(row.record_ref) ?? {};
  const revision = record(row.revision) ?? {};
  const rowObject = record(row.row) ?? {};
  const eligibility = record(row.eligibility);
  const productId = typeof recordRef.product_id === 'string' ? recordRef.product_id : (typeof row.product_id === 'string' ? row.product_id : '');
  const snapshotId = typeof recordRef.snapshot_id === 'string' ? recordRef.snapshot_id : (typeof result.snapshot_id === 'string' ? result.snapshot_id : '');
  const recordVersion = typeof recordRef.revision_id === 'string' ? recordRef.revision_id : null;
  const definitionRef = record(row.definition_ref) ?? record(product?.definition_ref) ?? {};
  const contractRef = record(row.contract_ref) ?? record(product?.contract_ref) ?? {};
  const contracts = record(product?.contracts) ?? {};
  const read = record(contracts.read) ?? {};
  const perspectives = Array.isArray(read.perspectives)
    ? read.perspectives.filter((item): item is EligibilityHistoryMode => (ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(item))
    : [];
  const declaration = record(product?.declaration) ?? {};
  const versionAxis = record(record(declaration.semantic_context)?.version_axis) ?? {};
  const currentOnlyBusiness = versionAxis.revision_mode === 'current_only_business';
  const readPerspective = typeof result.perspective === 'string' && (ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(result.perspective)
    ? result.perspective as EligibilityHistoryMode : null;
  const readAt = typeof result.at === 'string' && instant(result.at) !== null ? canonicalInstant(result.at) : null;
  const publicTime = wfdTime(rowObject.public_time ?? row.public_time);
  const governance = record(result.usage_governance);
  const rowSha = wfdSha256(canonicalWfdJson(row));
  const dateBasis = `wfd.fixed_read row ${recordVersion ?? 'unknown'} public_time`;
  const eligibilityRecord = eligibility;
  const heldAtRaw = text(row.held_at) ? row.held_at
    : eligibilityRecord && text(eligibilityRecord.held_at) ? eligibilityRecord.held_at : null;
  const heldAt = heldAtRaw !== null && instant(heldAtRaw) !== null ? canonicalInstant(heldAtRaw) : null;
  const heldScope = text(row.held_scope) ? String(row.held_scope)
    : text(result.held_scope) ? String(result.held_scope) : null;
  const usableStage = text(row.usable_stage) ? String(row.usable_stage) : null;
  const holdingTime: HoldingTimeEvidence | null = readPerspective === 'system_held_at'
    ? { authority: 'wfd_holding_ledger', status: heldAt === null ? 'unknown' : 'known',
      objectSha256: input.objectSha256, recordVersion, receivedAtUtc: heldAt, heldScope, usableStage,
      basis: heldAt === null
        ? 'WFD data_only system_held_at 未返回逐行 held_at；实际收到时刻保持未知，不以查询 cutoff 冒充'
        : 'WFD data_only system_held_at 逐行实际返回 held_at/held_scope/usable_stage',
      evidenceSha256: wfdSha256(canonicalWfdJson({ snapshot_id: snapshotId, record_ref: recordRef,
        perspective: readPerspective, at: readAt, held_at: heldAt, held_scope: heldScope,
        usable_stage: usableStage, eligibility: eligibilityRecord ?? null })) }
    : null;
  return {
    object: {
      objectSha256: input.objectSha256,
      origin: 'wfd_product',
      productId: productId || null,
      snapshotId: snapshotId || null,
      recordVersion,
      definitionRevision: typeof definitionRef.version === 'string' ? definitionRef.version : null,
      contentVerified: true,
      contentBasis: input.contentBasis,
    },
    holdingTime,
    publicationTime: {
      authority: 'wfd_product_read',
      status: publicTime.status,
      objectSha256: input.objectSha256,
      recordVersion,
      earliestUtc: publicTime.earliestUtc,
      latestExclusiveUtc: publicTime.latestExclusiveUtc,
      precision: publicTime.precision,
      sourceTimezone: publicTime.sourceTimezone,
      basis: dateBasis,
      evidenceSha256: rowSha,
      independentlyVerified: true,
    },
    revision: {
      authority: 'wfd_product_read',
      recordVersion: recordVersion ?? '',
      stateAtCutoff: row.revision_state === 'current' || row.revision_state === 'superseded' || row.revision_state === 'withdrawn'
        ? row.revision_state : 'unknown',
      supersedes: typeof revision.supersedes === 'string' ? revision.supersedes : null,
      supersededBy: null,
      selectionBasis: `wfd.fixed_read revision_state=${String(row.revision_state ?? 'missing')}; perspective=${String(result.perspective ?? 'missing')}; at=${String(result.at ?? 'null')}`,
      evidenceSha256: wfdSha256(canonicalWfdJson({ record_ref: recordRef, revision, revision_state: row.revision_state ?? null, perspective: result.perspective ?? null, at: result.at ?? null })),
    },
    wfdHistory: {
      authority: 'wfd_product_contract',
      productId: productId,
      snapshotId,
      readPerspectives: perspectives,
      currentOnlyBusiness,
      readPerspective,
      readAt,
      evidenceSha256: wfdSha256(canonicalWfdJson({ product_id: productId, snapshot_id: snapshotId,
        read_perspectives: perspectives, revision_mode: versionAxis.revision_mode ?? null,
        contract_ref: contractRef, definition_ref: definitionRef })),
      currentOnlyBusinessBasis: `declaration.semantic_context.version_axis.revision_mode=${String(versionAxis.revision_mode ?? 'missing')}`,
    },
    restriction: governance
      ? {
        authority: 'wfd_usage_governance',
        publishable: governance.publishable === true,
        computeEligible: governance.compute_eligible === true,
        auditReproduction: governance.audit_reproduction === true,
        checkedAtUtc: input.checkedAtUtc,
        issueCodes: Array.isArray(governance.known_issues)
          ? governance.known_issues.map(issue => record(issue)).filter((issue): issue is Record<string, unknown> => !!issue && text(issue.issue_id)).map(issue => String(issue.issue_id))
          : [],
        evidenceSha256: wfdSha256(canonicalWfdJson(governance)),
      }
      : {
        authority: 'wfd_usage_governance_check',
        result: 'no_known_issue',
        checkedAtUtc: input.checkedAtUtc,
        evidenceSha256: wfdSha256(canonicalWfdJson({ snapshot_id: result.snapshot_id ?? null, perspective: result.perspective ?? null,
          at: result.at ?? null, usage_governance: null })),
      },
    wfdDecision: eligibility && (eligibility.decision === 'eligible' || eligibility.decision === 'ineligible' || eligibility.decision === 'indeterminate')
      ? { decision: eligibility.decision, reason: typeof eligibility.reason === 'string' ? eligibility.reason : '' }
      : null,
  };
}

/** 受管原件/文件入口的公开时间证据：来源字段内容固定，但不冒称独立核验。 */
export function materialPublicationTimeEvidence(input: {
  objectSha256: string;
  recordVersion: string | null;
  earliestUtc: string | null;
  latestExclusiveUtc: string | null;
  precision: EvidenceTimePrecision | null;
  sourceTimezone: string | null;
  basis: string;
  evidenceSha256: string;
}): PublicationTimeEvidence {
  const known = instant(input.earliestUtc) !== null;
  return {
    authority: 'material_public_time_field',
    status: known ? 'known' : 'unknown',
    objectSha256: input.objectSha256,
    recordVersion: input.recordVersion,
    earliestUtc: known ? canonicalInstant(input.earliestUtc!) : null,
    latestExclusiveUtc: instant(input.latestExclusiveUtc) === null ? null : canonicalInstant(input.latestExclusiveUtc!),
    precision: input.precision,
    sourceTimezone: input.sourceTimezone,
    basis: input.basis,
    evidenceSha256: input.evidenceSha256,
    independentlyVerified: false,
  };
}

/** 便捷构造：把实际 WFD 读取的治理结果映射成共用限制证据。 */
export function wfdRestrictionEvidence(result: unknown, input: { checkedAtUtc: string; evidenceSha256?: string }): RestrictionEvidence {
  const value = record(result);
  const governance = record(value?.usage_governance);
  if (!governance) {
    return { authority: 'wfd_usage_governance_check', result: 'no_known_issue', checkedAtUtc: input.checkedAtUtc,
      evidenceSha256: input.evidenceSha256 ?? wfdSha256(canonicalWfdJson({ usage_governance: null, snapshot_id: value?.snapshot_id ?? null })) };
  }
  return {
    authority: 'wfd_usage_governance',
    publishable: governance.publishable === true,
    computeEligible: governance.compute_eligible === true,
    auditReproduction: governance.audit_reproduction === true,
    checkedAtUtc: input.checkedAtUtc,
    issueCodes: Array.isArray(governance.known_issues)
      ? governance.known_issues.map(issue => record(issue)).filter((issue): issue is Record<string, unknown> => !!issue && text(issue.issue_id)).map(issue => String(issue.issue_id))
      : [],
    evidenceSha256: input.evidenceSha256 ?? wfdSha256(canonicalWfdJson(governance)),
  };
}

/** 便捷构造：实际 WFD 产品合同的历史视角声明。 */
export function wfdHistorySupportFromProduct(input: {
  product: Record<string, unknown>;
  snapshotId: string;
  readPerspective: EligibilityHistoryMode | null;
  readAt: string | null;
  evidenceSha256?: string;
}): WfdHistorySupportEvidence {
  const product = input.product;
  const contracts = record(product.contracts) ?? {};
  const read = record(contracts.read) ?? {};
  const perspectives = Array.isArray(read.perspectives)
    ? read.perspectives.filter((item): item is EligibilityHistoryMode => (ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(item))
    : [];
  const context = record(record(product.declaration)?.semantic_context) ?? {};
  const versionAxis = record(context.version_axis) ?? {};
  return {
    authority: 'wfd_product_contract',
    productId: typeof product.product_id === 'string' ? product.product_id : '',
    snapshotId: input.snapshotId,
    readPerspectives: perspectives,
    currentOnlyBusiness: versionAxis.revision_mode === 'current_only_business',
    readPerspective: input.readPerspective,
    readAt: input.readAt,
    evidenceSha256: input.evidenceSha256 ?? wfdSha256(canonicalWfdJson({ product_id: product.product_id ?? null,
      read_perspectives: perspectives, version_axis: versionAxis })),
    currentOnlyBusinessBasis: `declaration.semantic_context.version_axis.revision_mode=${String(versionAxis.revision_mode ?? 'missing')}`,
  };
}

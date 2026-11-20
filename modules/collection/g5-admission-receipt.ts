import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import {
  compareProfileSemantics, profileFingerprint, profileSemanticGaps, readSourceFieldProfile, sourceFieldProfileDigest,
  type SourceFieldProfile, type SourceSemanticComparison,
} from './source-field-profile.js';

export const G5_ADMISSION_RECEIPT_VERSION = 'bd.g5.admission-receipt/1';

const entryPoints = ['r1_auto', 'r1_minute_bulk', 'r1_workspace_tabular', 'r1_workspace_relation',
  'r1_workspace_event', 'r1_publication_set_member', 'derived_wfd_publisher', 'post_publication_correction'] as const;
const targetKinds = ['tabular', 'relation_edges', 'event_records'] as const;
const correctionKinds = ['processing_repair', 'source_correction'] as const;
export type R1WriteEntryPoint = typeof entryPoints[number];
export type G5AdmissionPolicy = 'cross_source_required' | 'domain_profile_only_no_cross_merge' | 'explicitly_exempt';
export type G5ExemptionCode = 'event_distinct_propagation_preserved' | 'deterministic_derived_from_fixed_wfd_snapshot'
  | 'same_original_processing_repair';
export type G5AdmissionDecision = 'allow_same_source_repeat' | 'allow_first_source_for_target' | 'allow_reuse_product'
  | 'allow_new_definition_version' | 'allow_domain_profile_only' | 'allow_exempt_entry' | 'block_missing_profile'
  | 'block_peer_profile_unavailable' | 'block_evidence_required' | 'block_semantic_conflict';
type AdmissionTargetKind = typeof targetKinds[number];
type CorrectionKind = typeof correctionKinds[number];

export interface G5DiagnosticItem {
  readonly ruleId: 'G5_PROFILE_MISSING' | 'G5_PROFILE_INVALID' | 'G5_PROFILE_DOMAIN_REQUIRED'
    | 'G5_PEER_PROFILE_UNAVAILABLE' | 'G5_SEMANTIC_EVIDENCE_REQUIRED' | 'G5_SEMANTIC_CONFLICT';
  readonly severity: 'error' | 'warning';
  readonly axis: 'source_profile' | 'domain' | 'peer_profile' | 'semantics';
  readonly sourceId: string;
  readonly message: string;
}

interface G5ProfileEvidence {
  readonly sourceId: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly profileFingerprint: string;
}

export interface G5PeerComparisonEvidence extends G5ProfileEvidence {
  readonly status: SourceSemanticComparison['status'];
  readonly differences: readonly string[];
  readonly gaps: readonly string[];
}

export interface G5AdmissionBinding {
  readonly entryPoint: R1WriteEntryPoint;
  readonly requestId: string;
  readonly target: { readonly datasetId: string; readonly productId: string; readonly outputKey: string };
  readonly candidateSource: { readonly sourceId: string };
}

export interface G5AdmissionReceipt {
  readonly version: typeof G5_ADMISSION_RECEIPT_VERSION;
  readonly authority: 'bd_trusted_g5_gate';
  readonly wfdAuthorization: 'not_granted_by_g5';
  readonly entryPoint: R1WriteEntryPoint;
  readonly targetProductId: string;
  readonly targetKind: AdmissionTargetKind | null;
  readonly correctionKind: CorrectionKind | null;
  readonly sourceId: string;
  readonly binding: G5AdmissionBinding;
  readonly evaluatedAtUtc: string;
  readonly policy: G5AdmissionPolicy;
  readonly exemptionCode: G5ExemptionCode | null;
  readonly decision: G5AdmissionDecision;
  readonly allowed: boolean;
  readonly sourceProfile: G5ProfileEvidence | null;
  readonly peerSourceIds: readonly string[];
  readonly missingPeerSourceIds: readonly string[];
  readonly peerComparisons: readonly G5PeerComparisonEvidence[];
  readonly diagnostics: readonly G5DiagnosticItem[];
  readonly receiptDigest: string;
}

interface AdmissionInput {
  readonly sourceId: string;
  readonly datasetId: string;
  readonly outputKey: string;
  readonly requestId: string;
  readonly targetProductId: string;
  readonly evaluatedAtUtc: string;
  readonly profile?: SourceFieldProfile | null;
  /** 跨源和关系入口由受信调用方提供全部历史来源 ID，含已写入的本方来源；无历史时传空数组。 */
  readonly peerSourceIds?: readonly string[];
  /** 当前目标下每个历史来源的档案。缺失、无效或重复时视为不可用。 */
  readonly peerProfiles?: readonly (SourceFieldProfile | null)[];
  readonly allowNewDefinitionVersion?: boolean;
  /** 旧自动/分钟原报或同源修订的保留入口。其他来源出现后仍须提交完整语义证据。 */
  readonly legacySourceOnly?: true;
}

export type PublicationSetG5AdmissionMember = AdmissionInput & {
  readonly entryPoint?: 'r1_publication_set_member';
  readonly targetKind: AdmissionTargetKind;
};

export type R1G5AdmissionRequest = AdmissionInput & (
  | { readonly entryPoint: Exclude<R1WriteEntryPoint, 'r1_publication_set_member' | 'post_publication_correction'> }
  | { readonly entryPoint: 'r1_publication_set_member'; readonly targetKind: AdmissionTargetKind }
  | { readonly entryPoint: 'post_publication_correction'; readonly correctionKind: CorrectionKind }
);

function readMatchingProfile(value: SourceFieldProfile, sourceId: string): SourceFieldProfile | null {
  try {
    const profile = readSourceFieldProfile(value, sourceId);
    return profile.sourceId === sourceId ? profile : null;
  } catch (error) {
    if (error instanceof TaskError && error.code === 'SOURCE_FIELD_PROFILE') return null;
    throw error;
  }
}

function profileEvidence(profile: SourceFieldProfile): G5ProfileEvidence {
  return { sourceId: profile.sourceId, profileId: profile.profileId,
    profileDigest: sourceFieldProfileDigest(profile), profileFingerprint: profileFingerprint(profile) };
}

/** 仅消费受信调用方交付的目标、历史清单和时间，不读取存储或系统时钟。 */
export function evaluateR1G5Admission(request: R1G5AdmissionRequest): G5AdmissionReceipt {
  const { entryPoint, sourceId, targetProductId, evaluatedAtUtc } = request;
  const binding: G5AdmissionBinding = {
    entryPoint, target: { datasetId: request.datasetId, productId: targetProductId, outputKey: request.outputKey },
    candidateSource: { sourceId }, requestId: request.requestId,
  };
  if (!validBinding(binding)) throw new TaskError('G5_ADMISSION_REQUEST', '准入评估需要完整的请求号、入口、数据集、产品、输出和来源绑定。');
  if (!isExplicitUtcInstant(evaluatedAtUtc))
    throw new TaskError('G5_ADMISSION_REQUEST', '准入评估时间必须是带 Z 的真实 UTC 时刻。');

  const targetKind = entryPoint === 'r1_publication_set_member' ? request.targetKind : null;
  const correctionKind = entryPoint === 'post_publication_correction' ? request.correctionKind : null;
  if (!entryPoints.includes(entryPoint)
    || (entryPoint === 'r1_publication_set_member' && !targetKinds.includes(request.targetKind))
    || (entryPoint === 'post_publication_correction' && !correctionKinds.includes(request.correctionKind)))
    throw new TaskError('G5_ADMISSION_REQUEST', '准入入口或其目标、纠正类型无效。');
  const requiredDomain = entryPoint === 'r1_workspace_event' || targetKind === 'event_records' ? 'event_claim'
    : entryPoint === 'r1_workspace_relation' || targetKind === 'relation_edges' ? 'relation_claim' : null;
  const exempt = entryPoint === 'derived_wfd_publisher' ? 'deterministic_derived_from_fixed_wfd_snapshot'
    : correctionKind === 'processing_repair' ? 'same_original_processing_repair' : null;
  const profile = !exempt && request.profile ? readMatchingProfile(request.profile, sourceId) : null;
  const domain = profile?.domainScope?.domain;
  const preservesPropagation = requiredDomain === 'event_claim' && domain === 'event_claim'
    && profile?.domainScope?.eventSemantics?.occurrencePolicy === 'preserve_distinct_propagation';
  const needsHistory = !exempt && !preservesPropagation;
  if ((needsHistory || request.peerSourceIds !== undefined) && (!Array.isArray(request.peerSourceIds)
    || request.peerSourceIds.some(id => typeof id !== 'string' || !id.trim())))
    throw new TaskError('G5_ADMISSION_REQUEST', '准入评估需要目标的历史来源清单，包括已确认无历史的空清单。');
  const history = [...new Set(request.peerSourceIds)].sort();
  const otherSourceIds = history.filter(id => id !== sourceId);
  const policy: G5AdmissionPolicy = exempt ? 'explicitly_exempt'
    : preservesPropagation || (requiredDomain === 'relation_claim' && !otherSourceIds.length)
      ? 'domain_profile_only_no_cross_merge' : 'cross_source_required';
  const exemptionCode = exempt ?? (preservesPropagation ? 'event_distinct_propagation_preserved' : null);

  const diagnostics: G5DiagnosticItem[] = [];
  const peerComparisons: G5PeerComparisonEvidence[] = [];
  const missingPeerSourceIds: string[] = [];
  const issue = (ruleId: G5DiagnosticItem['ruleId'], axis: G5DiagnosticItem['axis'], id: string,
    message: string, severity: G5DiagnosticItem['severity'] = 'error') => {
    diagnostics.push({ ruleId, axis, severity, sourceId: id, message });
  };
  const finish = (decision: G5AdmissionDecision): G5AdmissionReceipt => {
    const receipt: Omit<G5AdmissionReceipt, 'receiptDigest'> = {
      version: G5_ADMISSION_RECEIPT_VERSION, authority: 'bd_trusted_g5_gate', wfdAuthorization: 'not_granted_by_g5',
      entryPoint, targetProductId, targetKind, correctionKind, sourceId, binding, evaluatedAtUtc,
      policy, exemptionCode, decision, allowed: decision.startsWith('allow_'),
      sourceProfile: profile ? profileEvidence(profile) : null,
      peerSourceIds: history, missingPeerSourceIds, peerComparisons, diagnostics,
    };
    return { ...receipt, receiptDigest: wfdSha256(canonicalWfdJson(receipt)) };
  };

  if (exempt) return finish('allow_exempt_entry');
  const legacySourceOnly = request.legacySourceOnly === true && !otherSourceIds.length
    && (entryPoint === 'r1_auto' || entryPoint === 'r1_minute_bulk' || (correctionKind === 'source_correction' && history.length > 0));
  if (!request.profile && !legacySourceOnly) {
    issue('G5_PROFILE_MISSING', 'source_profile', sourceId, '本方来源缺少字段档案。');
  }
  if (request.profile && !profile) {
    issue('G5_PROFILE_INVALID', 'source_profile', sourceId, '本方字段档案无效或来源身份不匹配。');
  }

  if (profile && requiredDomain && domain !== requiredDomain)
    issue('G5_PROFILE_DOMAIN_REQUIRED', 'domain', sourceId, `此入口要求 ${requiredDomain} 字段档案。`);
  const sourceGaps = new Set(profile ? profileSemanticGaps(profile) : []);
  for (const gap of sourceGaps)
    issue('G5_SEMANTIC_EVIDENCE_REQUIRED', 'semantics', sourceId, gap,
      legacySourceOnly && entryPoint === 'r1_minute_bulk' ? 'warning' : 'error');

  if (policy === 'cross_source_required') {
    for (const id of otherSourceIds) {
      const matches = request.peerProfiles?.filter(item => item?.sourceId === id) ?? [];
      const peer = matches.length === 1 ? readMatchingProfile(matches[0]!, id) : null;
      if (!peer) {
        missingPeerSourceIds.push(id);
        issue('G5_PEER_PROFILE_UNAVAILABLE', 'peer_profile', id, '历史来源的字段档案缺失、无效或不唯一。');
        continue;
      }
      if (!profile) continue;
      const { status, gaps, differences } = compareProfileSemantics(profile, peer);
      peerComparisons.push({ ...profileEvidence(peer), status, gaps, differences });
      for (const gap of gaps) {
        if (!sourceGaps.has(gap)) issue('G5_SEMANTIC_EVIDENCE_REQUIRED', 'semantics', id, gap);
      }
    }
  }

  const conflict = peerComparisons.some(peer => peer.status === 'different_semantics');
  const evidenceRequired = diagnostics.some(item => item.severity === 'error' && (item.ruleId === 'G5_PROFILE_DOMAIN_REQUIRED'
    || item.ruleId === 'G5_SEMANTIC_EVIDENCE_REQUIRED'));
  const allowNewVersion = conflict && !missingPeerSourceIds.length && !evidenceRequired
    && request.allowNewDefinitionVersion === true;
  for (const peer of peerComparisons) {
    for (const difference of peer.differences)
      issue('G5_SEMANTIC_CONFLICT', 'semantics', peer.sourceId, difference, allowNewVersion ? 'warning' : 'error');
  }
  if (missingPeerSourceIds.length) return finish('block_peer_profile_unavailable');
  if (!request.profile && !legacySourceOnly) return finish('block_missing_profile');
  if (request.profile && !profile) return finish('block_evidence_required');
  if (evidenceRequired) return finish('block_evidence_required');
  if (conflict) return finish(allowNewVersion ? 'allow_new_definition_version' : 'block_semantic_conflict');
  if (policy === 'domain_profile_only_no_cross_merge') return finish('allow_domain_profile_only');
  if (otherSourceIds.length) return finish('allow_reuse_product');
  return finish(history.length ? 'allow_same_source_repeat' : 'allow_first_source_for_target');
}

function validBinding(value: unknown): value is G5AdmissionBinding {
  if (!isWfdRecord(value) || !entryPoints.includes(value.entryPoint as R1WriteEntryPoint)
    || !isWfdRecord(value.target) || !isWfdRecord(value.candidateSource)) return false;
  return Object.hasOwn(value, 'requestId') && [value.requestId, value.target.datasetId, value.target.productId,
    value.target.outputKey, value.candidateSource.sourceId].every(field => typeof field === 'string' && !!field.trim());
}

/** 核对完整回执与交接绑定。宿主持久签发记录另行验证。 */
export function verifyG5AdmissionReceiptDigest(value: unknown, binding?: G5AdmissionBinding): value is G5AdmissionReceipt {
  if (!isWfdRecord(value) || value.version !== G5_ADMISSION_RECEIPT_VERSION
    || value.authority !== 'bd_trusted_g5_gate' || value.wfdAuthorization !== 'not_granted_by_g5'
    || !validBinding(value.binding) || value.entryPoint !== value.binding.entryPoint
    || value.targetProductId !== value.binding.target.productId || value.sourceId !== value.binding.candidateSource.sourceId
    || typeof value.decision !== 'string' || typeof value.allowed !== 'boolean' || value.allowed !== value.decision.startsWith('allow_')
    || !['targetKind', 'correctionKind', 'policy', 'exemptionCode', 'sourceProfile'].every(key => Object.hasOwn(value, key))
    || !['peerSourceIds', 'missingPeerSourceIds', 'peerComparisons', 'diagnostics'].every(key => Array.isArray(value[key]))
    || !isExplicitUtcInstant(value.evaluatedAtUtc) || typeof value.receiptDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.receiptDigest)) return false;
  const { receiptDigest, ...body } = value;
  try {
    return receiptDigest === wfdSha256(canonicalWfdJson(body))
      && (binding === undefined || validBinding(binding) && canonicalWfdJson(value.binding) === canonicalWfdJson(binding));
  } catch {
    return false;
  }
}

export function assertBoundG5AdmissionReceipt(value: unknown, binding: G5AdmissionBinding): asserts value is G5AdmissionReceipt {
  if (!binding || !verifyG5AdmissionReceiptDigest(value, binding) || value.allowed !== true)
    throw new TaskError('R1_G5_EVIDENCE_MISMATCH', '缺少有效的 G5 准入回执，或回执与当前请求、目标、来源、入口不符。');
}

export function evaluatePublicationSetG5Admission(members: readonly PublicationSetG5AdmissionMember[]) {
  const groups = new Map<string, PublicationSetG5AdmissionMember[]>();
  const targetKey = (member: PublicationSetG5AdmissionMember) => canonicalWfdJson([member.datasetId, member.targetProductId]);
  for (const member of members) {
    const key = targetKey(member), group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const receipts = members.map(member => {
    const historicalIds = new Set(member.peerSourceIds);
    const peerSourceIds = new Set(historicalIds);
    const peerProfiles = [...member.peerProfiles ?? []];
    for (const peer of groups.get(targetKey(member))!) {
      if (peer.sourceId === member.sourceId) continue;
      peerSourceIds.add(peer.sourceId);
      const profile = peer.profile && readMatchingProfile(peer.profile, peer.sourceId);
      const known = peerProfiles.filter(candidate => candidate?.sourceId === peer.sourceId);
      if (profile && (!historicalIds.has(peer.sourceId) || known.length)
        && !known.some(candidate => canonicalWfdJson(candidate) === canonicalWfdJson(profile))) peerProfiles.push(profile);
    }
    return evaluateR1G5Admission({ ...member, entryPoint: 'r1_publication_set_member', peerSourceIds: [...peerSourceIds], peerProfiles });
  });
  const blockingDiagnostics = receipts.flatMap((receipt, memberIndex) => receipt.allowed ? []
    : receipt.diagnostics.filter(item => item.severity === 'error').map(item => ({ ...item, memberIndex })));
  return { allowed: receipts.every(receipt => receipt.allowed), receipts, blockingDiagnostics };
}

import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { RestrictionEvidence } from './purpose-eligibility.js';

/** 发布限制核对的精确范围；没有范围就不能把“无治理回执”解释为无限制。 */
export interface PublishRestrictionTarget {
  purpose: 'current_publish' | 'historical_publish';
  snapshotId: string | null;
  productIds: string[];
  recordVersions: string[];
}

const USAGES = new Set(['business_read', 'compute', 'publish']);
const MAX_STATUS_BYTES = 4_000_000;

function fail(code: string, message: string): never { throw new TaskError(code, message); }
function record(value: unknown): WfdRecord | null { return isWfdRecord(value) ? value : null; }
function text(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }

/**
 * 把实际 usage_status 完整结果与本次精确目标范围匹配为限制证据。
 *
 * - issues/tickets 必须是完整数组，计数必须自洽；任何读取/部分返回异常都拒绝为 no_known_issue。
 * - 只有 product/snapshot/revision/usage 范围精确匹配的事项才生效。
 * - publishable 与 compute_eligible 分开按 scope.usages 映射，不把所有事项一律映射为两者同时禁止。
 * - no_known_issue 只代表该次权威读取的指定范围，附带 checkedAt/validUntil/scope，非永久授权。
 */
export function restrictionEvidenceFromUsageStatus(status: unknown, target: PublishRestrictionTarget, nowMs: number): RestrictionEvidence {
  const value = record(status);
  if (!value || value.format_version !== 'wfd.usage-suspension/1' || !Array.isArray(value.issues)
    || !Array.isArray(value.tickets)) {
    fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD usage_status 未返回完整 issues/tickets；不能解释为 no_known_issue。');
  }
  if (Buffer.byteLength(canonicalWfdJson(value)) > MAX_STATUS_BYTES) fail('R1_USAGE_STATUS_BUDGET', 'WFD usage_status 结果超过本入口核对预算。');
  const issues = value.issues.filter(isWfdRecord);
  const tickets = value.tickets.filter(isWfdRecord);
  if (issues.length !== value.issues.length || tickets.length !== value.tickets.length) {
    fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD usage_status 含非对象事项；不能确认完整性。');
  }
  const active = issues.filter(issue => issue.state === 'active').length;
  // WFD 的 suspended_record_versions 是全部事项 scope 内 record_versions 的总数，
  // 不是 scope 条数；多产品/多版本事项必须按版本数核对，否则会误报计数不自洽。
  const suspended = issues.reduce((sum, issue) => sum + (Array.isArray(issue.scopes)
    ? issue.scopes.reduce((count, scope) => count + (isWfdRecord(scope) && Array.isArray(scope.record_versions)
      ? scope.record_versions.length : 0), 0) : 0), 0);
  if (typeof value.active_issues !== 'number' || value.active_issues !== active
    || typeof value.suspended_record_versions !== 'number' || value.suspended_record_versions !== suspended) {
    fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD usage_status 的 active/suspended 计数不自洽；不能确认完整读取。');
  }
  const productIds = [...new Set(target.productIds.filter(item => typeof item === 'string' && item.length > 0))].sort();
  const recordVersions = [...new Set(target.recordVersions.filter(item => typeof item === 'string' && item.length > 0))].sort();
  if (!productIds.length) fail('R1_USAGE_SCOPE', '发布限制核对缺目标产品身份；不能证明任何范围无限制。');
  const matched: Array<{ issue: WfdRecord; usages: Set<string> }> = [];
  for (const issue of issues) {
    const scopes = Array.isArray(issue.scopes) ? issue.scopes.filter(isWfdRecord) : [];
    if (scopes.length !== (Array.isArray(issue.scopes) ? issue.scopes.length : 0)) {
      fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD 事项含不可读 scope；不能确认完整性。');
    }
    const matchedUsages = new Set<string>();
    for (const scope of scopes) {
      const productId = text(scope.product_id);
      if (!productId || !productIds.includes(productId)) continue;
      const scopeVersions = Array.isArray(scope.record_versions) ? scope.record_versions.filter(text) : [];
      if (scopeVersions.length !== (Array.isArray(scope.record_versions) ? scope.record_versions.length : 0)
        || !scopeVersions.length) {
        fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD 事项 scope.record_versions 为空或不可读；不能确认完整性。');
      }
      if (recordVersions.length && !scopeVersions.some(version => recordVersions.includes(version))) continue;
      const usages = Array.isArray(scope.usages) ? scope.usages.filter(text) : ['business_read', 'compute', 'publish'];
      if (usages.some(usage => !USAGES.has(usage))) fail('R1_USAGE_STATUS_INCOMPLETE', 'WFD 事项 scope.usages 含未知操作；不能降级解释。');
      for (const usage of usages) matchedUsages.add(usage);
    }
    if (matchedUsages.size) matched.push({ issue, usages: matchedUsages });
  }
  const checkedAtUtc = new Date(nowMs).toISOString().replace('.000Z', 'Z');
  const validUntilUtc = new Date(nowMs + 5 * 60_000).toISOString().replace('.000Z', 'Z');
  const scope = { purpose: target.purpose, snapshotId: target.snapshotId, productIds, recordVersions };
  if (matched.length) {
    const issueCodes = matched.map(item => text(item.issue.issue_id)).filter((item): item is string => !!item).sort();
    const publishable = !matched.some(item => item.usages.has('publish'));
    const computeEligible = !matched.some(item => item.usages.has('compute'));
    return { authority: 'wfd_usage_governance', publishable, computeEligible, auditReproduction: false,
      checkedAtUtc, validUntilUtc, issueCodes, scope,
      evidenceSha256: wfdSha256(canonicalWfdJson({ status: value, target: scope })) };
  }
  return { authority: 'wfd_usage_governance_check', result: 'no_known_issue', checkedAtUtc, validUntilUtc,
    scope, evidenceSha256: wfdSha256(canonicalWfdJson({ status: value, target: scope })) };
}

/** 从 R1 目标文档/计划输出推导精确发布范围；新产品按 WFD 同一定义身份规则计算产品身份。 */
export function publishRestrictionTarget(input: {
  purpose: 'current_publish' | 'historical_publish';
  expectedSnapshotId: string | null;
  productRef?: WfdRecord | null;
  logicalDomain: string;
  subject: WfdRecord;
  definition: WfdRecord;
  definitionMode: 'create' | 'reuse';
  definitionRef?: WfdRecord | null;
  recordVersions?: string[];
}): PublishRestrictionTarget {
  const productIds: string[] = [];
  const refId = text(input.productRef?.product_id);
  if (refId) productIds.push(refId);
  if (input.definitionMode === 'create') {
    productIds.push('p_' + wfdSha256(canonicalWfdJson([input.logicalDomain, input.subject, input.definition])).slice(0, 24));
  }
  const recordVersions = [...new Set((input.recordVersions ?? []).filter(text))];
  return { purpose: input.purpose, snapshotId: input.expectedSnapshotId, productIds: [...new Set(productIds)].sort(), recordVersions: recordVersions.sort() };
}

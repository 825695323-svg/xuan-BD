import { isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';

// 仅输出 WFD 历史资格分类。未知诊断的自由文本和记录身份只保存在原任务。
const historicalReasons = new Set(['time_interval_starts_after_cutoff', 'WITHDRAWN_AT_PERSPECTIVE',
  'HELD_STAGE_AFTER_CUTOFF', 'WITHDRAWN_AT_HELD_CUTOFF', 'NO_HOLDING_FACT_FOR_RECORD_VERSION',
  'INSTANCE_HOLDING_COVERAGE_GAP', 'REVISION_BRANCH_CONFLICT', 'PUBLICATION_OR_HELD_TIME_UNKNOWN',
  'TIME_PRECISION_INSUFFICIENT', 'RELATION_EFFECTIVE_PERIOD']);

export function historicalExclusionSummary(input: readonly unknown[] | { byReason: WfdRecord }) {
  const byReason: Record<string, number> = {};
  let excludedCount = 0;
  function add(reason: unknown, code: unknown, count: unknown) {
    const label = [reason, code].find((key): key is string => typeof key === 'string' && historicalReasons.has(key)) ?? 'other';
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return;
    byReason[label] = (byReason[label] ?? 0) + count;
    excludedCount += count;
  }
  if ('byReason' in input) {
    for (const [reason, count] of Object.entries(input.byReason)) add(reason, null, count);
  } else {
    for (const item of input) {
      const diagnostic = isWfdRecord(item) ? item : {};
      const aggregated = diagnostic.aggregation === 'record_versions_by_holding_state' && Number.isSafeInteger(diagnostic.count)
        && Number(diagnostic.count) > 0;
      add(diagnostic.reason, diagnostic.code, aggregated ? diagnostic.count : 1);
    }
  }
  return { source: 'WFD', scope: 'fixed_product_not_date_filtered', excludedCount, byReason };
}

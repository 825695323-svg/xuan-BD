import { isExplicitUtcInstant } from '../../../contracts/financial-value';
import type { R1ProductReadInput, R1SnapshotStatus } from '../../../contracts/r1-contracts';

export class R1HistoryError extends Error {
  constructor(readonly code: string, chinese: string, readonly english: string) { super(chinese); }
}

type History = Pick<R1ProductReadInput, 'historyMode' | 'at' | 'heldScope' | 'usableStage'>;
type Holding = NonNullable<R1SnapshotStatus['holdingInstance']>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const stages = ['acquired', 'custodied', 'published_readable'];

export function isR1HoldingInstance(value: unknown): value is Holding {
  return object(value) && Object.keys(value).sort().join(',') === 'bindingSource,instanceId'
    && identifier(value.instanceId) && ['volume_binding', 'target_instance'].includes(String(value.bindingSource));
}

/** No clock default, inferred instance, or implicit upgrade to a readable stage. */
export function buildR1ReadHistory(selection: { historyMode: R1ProductReadInput['historyMode']; at?: string; usableStage?: string },
  status?: Pick<R1SnapshotStatus, 'holdingInstance'> | null): History {
  const mode = selection.historyMode ?? 'snapshot_contents';
  const history: History = { historyMode: mode,
    ...(selection.at !== undefined ? { at: selection.at } : {}),
    ...(selection.usableStage !== undefined ? { usableStage: selection.usableStage as History['usableStage'] } : {}) };
  if (mode === 'system_held_at') {
    if (!isR1HoldingInstance(status?.holdingInstance)) throw new R1HistoryError('R1_HISTORY_INSTANCE_UNKNOWN', '系统持有实例未知；不能推断持有范围。', 'The holding instance is unknown; its scope cannot be inferred.');
    history.heldScope = status.holdingInstance.instanceId;
  }
  validateR1ReadHistoryInput(history);
  return history;
}

export function validateR1ReadHistoryInput(input: History): void {
  const mode = input.historyMode ?? 'snapshot_contents';
  if (!['snapshot_contents', 'market_known_at', 'system_held_at'].includes(mode)) throw new R1HistoryError('R1_HISTORY_MODE_UNKNOWN', '未知历史视角。', 'Unknown historical perspective.');
  if (mode === 'snapshot_contents') {
    if (input.at !== undefined || input.heldScope !== undefined || input.usableStage !== undefined)
      throw new R1HistoryError('R1_HISTORY_MIXED_PARAMETERS', '快照内容不能混入历史截止、范围或阶段。', 'Snapshot contents cannot include a historical cutoff, scope or stage.');
    return;
  }
  if (!isExplicitUtcInstant(input.at) || input.at.length !== 20
    || new Date(Date.parse(input.at) + 1000).toISOString().replace('.000Z', 'Z').length !== 20)
    throw new R1HistoryError('R1_HISTORY_CUTOFF_REQUIRED', '历史截止须为明确秒级 UTC 时刻，不自动补日期或当前时间。', 'Enter an explicit UTC cutoff to the second; no date or current time is inferred.');
  if (mode === 'system_held_at') {
    if (!identifier(input.heldScope) || !stages.includes(String(input.usableStage)))
      throw new R1HistoryError('R1_HISTORY_STAGE_REQUIRED', '系统持有须明确实际实例与用户选择的阶段。', 'System-held reads require an actual instance and an explicitly selected stage.');
  } else if (input.heldScope !== undefined || input.usableStage !== undefined) {
    throw new R1HistoryError('R1_HISTORY_MIXED_PARAMETERS', '市场公开视角不能混入系统持有范围或阶段。', 'Market-known reads cannot include a holding scope or stage.');
  }
}

export function assertR1ReadHistoryEcho(input: History, response: unknown): void {
  validateR1ReadHistoryInput(input);
  const mode = input.historyMode ?? 'snapshot_contents';
  const result = object(response) && object(response.result) ? response.result : null;
  if (!object(response) || response.historyMode !== mode || !result || result.history_mode !== mode)
    throw new R1HistoryError('R1_HISTORY_ECHO_MISMATCH', '历史视角回显与请求不符。', 'The returned history perspective does not match the request.');
  const cutoff = mode === 'snapshot_contents' ? null : { status: 'known', precision: 'second', earliest_utc: input.at,
    latest_exclusive_utc: new Date(Date.parse(input.at!) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' };
  const actual = result.knowledge_cutoff;
  const matches = cutoff === null ? actual === null : object(actual)
    && Object.keys(actual).length === Object.keys(cutoff).length
    && Object.entries(cutoff).every(([key, value]) => Object.hasOwn(actual, key) && actual[key] === value);
  if (!matches || result.held_scope !== (mode === 'system_held_at' ? input.heldScope : null)
    || result.usable_stage !== (mode === 'system_held_at' ? input.usableStage : null))
    throw new R1HistoryError('R1_HISTORY_ECHO_MISMATCH', '历史截止、实例或阶段回显无法完整核对。', 'The returned cutoff, instance or stage cannot be fully verified.');
}

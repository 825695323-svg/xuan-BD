import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../../contracts/financial-value.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

/** 现有 WFD read_product 受信只读连接；只接收明确产品与快照身份。 */
export interface WfdFixedHistorySelection {
  historyMode: 'market_known_at' | 'system_held_at'; at: string;
  heldScope?: string; usableStage?: 'acquired' | 'custodied' | 'published_readable';
}
export type WfdFixedRecordReader = (value: { snapshotId: string; productId: string; cursor?: string } & Partial<WfdFixedHistorySelection>, signal?: AbortSignal) =>
  Promise<{ result: WfdRecord; connection?: unknown }>;
export interface WfdFixedRecordSelection {
  snapshotId: string; productId: string; businessKeys: readonly string[];
  /** 调用方要求固定记录版本时须逐业务键明确给出。 */
  recordVersions?: Readonly<Record<string, string>>;
}
export interface WfdSelectedRecordSet {
  selection: WfdFixedRecordSelection;
  rows: WfdRecord[];
  selectedRowsSha256: string;
  recordVersions: WfdRecord[];
}
export interface WfdFixedSelectionResult {
  connection: unknown;
  selections: WfdSelectedRecordSet[];
  /** 只声明固定快照内容，不把公布时间或原行版本冒充历史时点可得资格。 */
  historyQualification: 'not_asserted' | WfdFixedHistorySelection['historyMode'];
  historySelection?: WfdFixedHistorySelection;
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value);
const fixedIdentity = (value: unknown): value is string =>
  identifier(value) && !/^(?:latest|current)$/iu.test(value);

export function readFixedHistorySelection(raw: unknown): WfdFixedHistorySelection {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['historyMode', 'at', 'heldScope', 'usableStage'].includes(key))
    || !['market_known_at', 'system_held_at'].includes(String(raw.historyMode))
    || typeof raw.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(raw.at)
    || !isExplicitUtcInstant(raw.at)) throw new TaskError('WFD_FIXED_HISTORY', '历史选集须明确视角和真实秒级UTC截止，不推定日期的具体时刻。');
  if (raw.historyMode === 'system_held_at') {
    if (!identifier(raw.heldScope) || !['acquired', 'custodied', 'published_readable'].includes(String(raw.usableStage)))
      throw new TaskError('WFD_FIXED_HISTORY', '系统历史必须明确持有实例和所需可用阶段。');
  } else if (raw.heldScope !== undefined || raw.usableStage !== undefined)
    throw new TaskError('WFD_FIXED_HISTORY', '市场历史不接受系统持有阶段替代公开时间。');
  return structuredClone(raw) as unknown as WfdFixedHistorySelection;
}

/**
 * 受信固定行选集。整套选集内连接不变、分页完整、所选业务键唯一；
 * 从真实 WFD 行重新计算摘要，不能把调用方填的摘要当固定读取证明。
 *
 * 这里只读/核对，不负责用户用途资格、公式、执行器和 WFD 发布权限。
 */
export async function selectWfdFixedRecords(
  refs: readonly WfdFixedRecordSelection[], reader: WfdFixedRecordReader, signal: AbortSignal,
  onError: (reason: string) => never = reason => { throw new TaskError('WFD_FIXED_SELECTION', reason); },
  historyInput?: WfdFixedHistorySelection,
): Promise<WfdFixedSelectionResult> {
  const history = historyInput ? readFixedHistorySelection(historyInput) : undefined;
  if (!Array.isArray(refs) || !refs.length || refs.length > 8) onError('固定行选择最多八项，不能隐式扫描全部快照。');
  let connection: unknown;
  const selections: WfdSelectedRecordSet[] = [];
  for (const ref of refs) {
    if (!fixedIdentity(ref.snapshotId) || !fixedIdentity(ref.productId)
      || !Array.isArray(ref.businessKeys) || ref.businessKeys.length < 1 || ref.businessKeys.length > 64
      || ref.businessKeys.some((key: string) => !identifier(key))
      || new Set(ref.businessKeys).size !== ref.businessKeys.length) onError('固定选择须为明确、唯一的产品、快照与业务键，不能使用 latest。');
    if (ref.recordVersions && (Object.keys(ref.recordVersions).sort().join('|') !== [...ref.businessKeys].sort().join('|')
      || Object.values(ref.recordVersions).some(version => !fixedIdentity(version)))) onError('记录版本须逐业务键固定，不能缺失或扩围。');

    const found = new Map<string, WfdRecord>(), wanted = new Set(ref.businessKeys);
    let cursor: string | undefined, count = 0;
    const seenCursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const received = await reader({
        snapshotId: ref.snapshotId, productId: ref.productId, ...(history ?? {}), ...(cursor ? { cursor } : {}),
      }, signal);
      if (connection !== undefined && canonicalWfdJson(received.connection ?? null) !== canonicalWfdJson(connection)) {
        onError('同一次固定选集读取期间 WFD 受信连接身份变化。');
      }
      connection = received.connection ?? null;
      const page = received.result;
      if (page.snapshot_id !== ref.snapshotId || page.product_id !== ref.productId
        || !Array.isArray(page.rows) || !isWfdRecord(page.page)
        || typeof page.page.has_more !== 'boolean'
        || page.rows.length > 100) onError('WFD 固定快照/产品或分页返回不完整。');
      if (!history && page.history_mode !== undefined && page.history_mode !== 'snapshot_contents') {
        onError('固定行选集只接收 snapshot_contents，不声明历史时点可得。');
      }
      if (history) {
        const cutoff = { status: 'known', earliest_utc: history.at,
          latest_exclusive_utc: new Date(Date.parse(history.at) + 1000).toISOString().replace('.000Z', 'Z'),
          precision: 'second', source_timezone: 'UTC' };
        if (page.history_mode !== history.historyMode || canonicalWfdJson(page.knowledge_cutoff) !== canonicalWfdJson(cutoff)
          || page.held_scope !== (history.heldScope ?? null) || page.usable_stage !== (history.usableStage ?? null)
          || !Array.isArray(page.diagnostics) || page.diagnostics.some(item => !isWfdRecord(item)
            || item.decision === 'indeterminate' || isWfdRecord(item.eligibility) && item.eligibility.decision === 'indeterminate')
          || !page.page.has_more && page.complete !== true) onError('历史固定选集的截止、阶段或完整性未满足；不回退最新值或使用部分输入。');
      }
      for (const row of page.rows) {
        if (++count > 5000) onError('固定产品扫描超过五千行预算，不截取结果冒充完整。');
        if (!isWfdRecord(row) || !isWfdRecord(row.record_ref) || !isWfdRecord(row.values)) {
          onError('WFD 固定行缺记录版本或原始字段。');
        }
        if (history && (!isWfdRecord(row.eligibility) || row.eligibility.decision !== 'eligible'))
          onError('历史固定输入未返回逐行可用资格。');
        if (history?.historyMode === 'system_held_at' && (row.held_scope !== history.heldScope
          || row.usable_stage !== history.usableStage || typeof row.held_at !== 'string'
          || !isExplicitUtcInstant(row.held_at) || Date.parse(row.held_at) > Date.parse(history.at)))
          onError('系统历史输入缺少所需阶段的真实持有时间，不能从公开或请求时间补填。');
        const record = row.record_ref;
        const key = record.logical_key ?? record.record_id;
        if (!identifier(key)) onError('来源行缺稳定业务键。');
        if (record.product_id !== undefined && record.product_id !== ref.productId
          || record.snapshot_id !== undefined && record.snapshot_id !== ref.snapshotId) {
          onError('来源行的记录身份与冻结产品/快照不一致。');
        }
        if (wanted.has(key)) {
          if (found.has(key)) onError('同一固定快照返回多个相同业务键，不能任取一条。');
          if (ref.recordVersions && record.revision_id !== ref.recordVersions[key]) onError('实际记录版本与冻结版本不同。');
          found.set(key, row);
        }
      }
      cursor = page.page.has_more ? page.page.next_cursor as string : undefined;
      if (cursor && (cursor === 'undefined' || cursor.length > 8192 || /[\u0000-\u001f]/u.test(cursor)
        || seenCursors.has(cursor))) onError('WFD 固定读取游标缺失、超界或循环。');
      if (page.page.has_more && !cursor || !page.page.has_more && page.page.next_cursor !== null) {
        onError('WFD 分页结束/下一页身份不一致。');
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (found.size !== wanted.size) onError('固定输入中缺所选业务键；不能改读 latest 或补值。');
    // 保留 WFD 读取顺序。
    const rows = [...found.values()];
    selections.push({ selection: ref, rows, selectedRowsSha256: wfdSha256(canonicalWfdJson(rows)),
      recordVersions: rows.map(row => row.record_ref as WfdRecord) });
  }
  return { connection: connection ?? null, selections, historyQualification: history?.historyMode ?? 'not_asserted',
    ...(history ? { historySelection: history } : {}) };
}

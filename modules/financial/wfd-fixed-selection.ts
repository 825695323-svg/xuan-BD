import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

/** 现有 WFD read_product 受信只读连接；不从算法请求接收路径、数值或 latest 指针。 */
export type WfdFixedRecordReader = (value: { snapshotId: string; productId: string; cursor?: string }, signal?: AbortSignal) =>
  Promise<{ result: WfdRecord; connection?: unknown }>;
export interface WfdFixedRecordSelection {
  snapshotId: string; productId: string; businessKeys: readonly string[];
  /** 财务可只选业务键；宏观要求版本绑定时必须逐业务键明确给出。 */
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
  historyQualification: 'not_asserted';
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value)
    && !/^(?:latest|current)$/iu.test(value);

/**
 * 财务与宏观的共同固定行选集。整套选集内连接不变、分页完整、所选业务键唯一；
 * 从真实 WFD 行重新计算摘要，不能把调用方填的摘要当固定读取证明。
 *
 * 这里只读/核对，不负责用户用途资格、公式、执行器和 WFD 发布权限。
 */
export async function selectWfdFixedRecords(
  refs: readonly WfdFixedRecordSelection[], reader: WfdFixedRecordReader, signal: AbortSignal,
  onError: (reason: string) => never = reason => { throw new TaskError('WFD_FIXED_SELECTION', reason); },
): Promise<WfdFixedSelectionResult> {
  if (!Array.isArray(refs) || !refs.length || refs.length > 8) onError('固定行选择最多八项，不能隐式扫描全部快照。');
  let connection: unknown;
  const selections: WfdSelectedRecordSet[] = [];
  for (const ref of refs) {
    if (!identifier(ref.snapshotId) || !identifier(ref.productId)
      || !Array.isArray(ref.businessKeys) || ref.businessKeys.length < 1 || ref.businessKeys.length > 64
      || ref.businessKeys.some((key: string) => !identifier(key))
      || new Set(ref.businessKeys).size !== ref.businessKeys.length) onError('固定选择须为明确、唯一的产品、快照与业务键，不能使用 latest。');
    if (ref.recordVersions && (Object.keys(ref.recordVersions).sort().join('|') !== [...ref.businessKeys].sort().join('|')
      || Object.values(ref.recordVersions).some(version => !identifier(version)))) onError('记录版本须逐业务键固定，不能缺失或扩围。');

    const found = new Map<string, WfdRecord>(), wanted = new Set(ref.businessKeys);
    let cursor: string | undefined, count = 0;
    const seenCursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const received = await reader({
        snapshotId: ref.snapshotId, productId: ref.productId, ...(cursor ? { cursor } : {}),
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
      if (page.history_mode !== undefined && page.history_mode !== 'snapshot_contents') {
        onError('固定行选集只接收 snapshot_contents，不声明历史时点可得。');
      }
      for (const row of page.rows) {
        if (++count > 5000) onError('固定产品扫描超过五千行预算，不截取结果冒充完整。');
        if (!isWfdRecord(row) || !isWfdRecord(row.record_ref) || !isWfdRecord(row.values)) {
          onError('WFD 固定行缺记录版本或原始字段。');
        }
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
    // 为兼容原财务计算的来源顺序，保持 WFD 读取顺序；宏观每个选集只有一行。
    const rows = [...found.values()];
    selections.push({ selection: ref, rows, selectedRowsSha256: wfdSha256(canonicalWfdJson(rows)),
      recordVersions: rows.map(row => row.record_ref as WfdRecord) });
  }
  return { connection: connection ?? null, selections, historyQualification: 'not_asserted' };
}

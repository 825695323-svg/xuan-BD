import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant, isNumericReportedZero } from '../../contracts/financial-value.js';
import type { R1ProductRead, R1ProductReadInput } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { AlgorithmSubmissionContext } from './algorithm-types.js';
import { readHistorySelection } from '../collection/r1-product-reader.js';
import { screenStrategy, STRATEGY_SCREEN_LIMITS, STRATEGY_SCREEN_VERSION, type StrategyScreenInput } from './strategy-screen.js';

export { historicalExclusionSummary } from './historical-exclusions.js';

export const STRATEGY_SCREEN_WFD_VERSION = 'bd.strategy-screen-wfd/2';
export const STRATEGY_SCREEN_READ_LIMITS = Object.freeze({ pages: 100, rows: 10_000, bytes: 16_777_216, resultBytes: 900_000, timeoutMs: 60_000 });
export type FixedProductReader = (input: unknown, signal?: AbortSignal) => Promise<R1ProductRead & { connectionSha256?: string }>;
interface Selection { dateField: string; date: string; dateFormat: 'YYYY-MM-DD' | 'YYYYMMDD'; keys?: string[] }
interface Request extends Omit<StrategyScreenInput, 'rows'> {
  snapshotId: string; productId: string; historyMode: 'snapshot_contents' | 'market_known_at' | 'system_held_at';
  at?: string; heldScope?: string; usableStage?: 'acquired' | 'custodied' | 'published_readable';
  selection: Selection; readMode: 'product' | 'indexed';
}
/** 宿主单独传入用途证据，不能从 screenJson 接收。 */
export type HistoricalPurposeContext = AlgorithmSubmissionContext & {
  purpose: 'historical_compute'; historyMode: string; cutoff: string;
};

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
export const fixedProductIdentifier = (value: unknown): value is string => id(value) && !/^(latest|current)$/iu.test(value);
const field = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);
const key = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim()
  && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
const recordKey = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
function fail(code: string, message: string): never { throw new TaskError(code, message); }
function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000-')) return false;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** 只识别 WFD 已作出的确定排除；不在工具侧重新选择历史版本或推断时间资格。 */
type ReadPerspective = Pick<Request, 'productId' | 'historyMode' | 'heldScope' | 'usableStage' | 'at'>;
function knownHistoricalExclusion(value: unknown, request: ReadPerspective): value is WfdRecord {
  if (!isWfdRecord(value) || value.product_id !== request.productId || value.decision !== 'ineligible'
    || value.diagnostic_source !== 'product_service_eligibility') return false;
  if (request.historyMode === 'market_known_at' && value.code === undefined && recordKey(value.business_key)) {
    if (value.reason === 'time_interval_starts_after_cutoff') return fixedProductIdentifier(value.revision_id);
    return value.reason === 'WITHDRAWN_AT_PERSPECTIVE' && isWfdRecord(value.withdrawal_public_time);
  }
  if (request.historyMode !== 'system_held_at') return false;
  if (value.reason === 'HELD_STAGE_AFTER_CUTOFF') return value.code === 'INSTANCE_HOLDING_COVERAGE_GAP'
    && value.scope === 'product' && value.aggregation === 'record_versions_by_holding_state'
    && value.holding_state === 'not_yet_held' && Number.isSafeInteger(value.count) && Number(value.count) > 0
    && value.count_basis === 'current_fixed_snapshot_not_subject_filtered_not_historical_known_total';
  return value.code === undefined && value.reason === 'WITHDRAWN_AT_HELD_CUTOFF' && recordKey(value.business_key)
    && value.held_scope === request.heldScope && value.usable_stage === request.usableStage
    && isWfdRecord(value.eligibility) && value.eligibility.decision === 'ineligible'
    && value.eligibility.reason === value.reason;
}

function checkHistoricalRow(row: WfdRecord, request: ReadPerspective) {
  if (request.historyMode === 'snapshot_contents') return;
  const eligibility = row.eligibility;
  if (!isWfdRecord(eligibility) || eligibility.decision !== 'eligible'
    || eligibility.mode !== undefined && eligibility.mode !== request.historyMode
    || eligibility.reason !== undefined && eligibility.reason !== (request.historyMode === 'market_known_at'
      ? 'evidence_interval_ended_before_cutoff' : 'held_at_usable_stage'))
    fail('STRATEGY_SCREEN_ROW_INELIGIBLE', '历史读取行缺少当前视角的 WFD 合格判决。');
  if (request.historyMode === 'market_known_at') {
    const time = isWfdRecord(row.times) ? row.times.public_time : null;
    if (!isWfdRecord(time) || time.status !== 'known'
      || !isExplicitUtcInstant(time.earliest_utc) || !isExplicitUtcInstant(time.latest_exclusive_utc)
      || Date.parse(time.earliest_utc) >= Date.parse(time.latest_exclusive_utc)
      || Date.parse(time.latest_exclusive_utc) > Date.parse(request.at!))
      fail('STRATEGY_SCREEN_ROW_INELIGIBLE', '历史读取行缺少完整且在所选截止前结束的已知公开时间区间。');
  }
  if (request.historyMode === 'system_held_at' && (
    row.held_scope !== request.heldScope || row.usable_stage !== request.usableStage
    || !isExplicitUtcInstant(row.held_at) || Date.parse(row.held_at) > Date.parse(request.at!)
    || eligibility.held_at !== undefined && eligibility.held_at !== row.held_at
    || eligibility.usable_stage !== undefined && eligibility.usable_stage !== row.usable_stage
    || eligibility.held_scope !== undefined && eligibility.held_scope !== row.held_scope))
    fail('STRATEGY_SCREEN_ROW_INELIGIBLE', '历史读取行未证明在所选截止前已由指定实例持有并达到所选阶段。');
}

const mixedDefinition = (): never => fail('STRATEGY_SCREEN_DEFINITION_MIXED', '固定截面中的定义或合同身份缺失、不一致或含有多个版本。');

/** read_product 使用 product 包络，部分读取端口直接返回同名列表。两处都有时必须一致。 */
function productVersions(result: WfdRecord) {
  const product = isWfdRecord(result.product) ? result.product : {};
  if (result.product != null && !isWfdRecord(result.product) || product.product_id !== undefined && product.product_id !== result.product_id
    || product.snapshot_id !== undefined && product.snapshot_id !== result.snapshot_id
    || product.dataset_id !== undefined && product.dataset_id !== result.dataset_id)
    fail('STRATEGY_SCREEN_WFD_RESPONSE', '产品合同包络与固定读取的产品身份不符。');
  const list = (name: string): WfdRecord[] | null => {
    const nested = product[name], flat = result[name];
    if (nested !== undefined && flat !== undefined && canonicalWfdJson(nested) !== canonicalWfdJson(flat)) mixedDefinition();
    const refs = nested ?? flat;
    if (refs == null) return null;
    if (!Array.isArray(refs) || refs.length > 1 || !refs.every(ref => isWfdRecord(ref) && Object.keys(ref).length > 0)) return mixedDefinition();
    return refs;
  };
  const definitionRefs = list('definition_refs'), contractVersions = list('contract_versions'), contractRefs = list('contract_refs');
  const version = contractVersions?.[0];
  const standaloneContract = version && version.contract_ref == null && versionIdentity(version)
    ? Object.fromEntries(Object.entries(version).filter(([key]) => key !== 'definition_ref' && key !== 'fields'))
    : undefined;
  const fixedRef = (ref: unknown, versionRef: unknown) => {
    if (versionRef != null && !versionIdentity(versionRef) || ref != null && !versionIdentity(ref)
      || ref != null && versionRef != null && canonicalWfdJson(ref) !== canonicalWfdJson(versionRef)) return mixedDefinition();
    return ref ?? versionRef ?? null;
  };
  const definitionRef = fixedRef(definitionRefs?.[0], version?.definition_ref);
  const contractRef = fixedRef(contractRefs?.[0], version?.contract_ref ?? standaloneContract);
  return { definitionRefs, contractVersions, contractRefs, definitionRef, contractRef,
    hasContract: !!contractRef };
}

function versionIdentity(ref: unknown): ref is WfdRecord {
  return isWfdRecord(ref) && [ref.digest, ref.version, ref.id].some(fixedProductIdentifier);
}

function checkRowVersion(ref: unknown, expected: unknown, previous: WfdRecord | null) {
  if (ref == null) return previous;
  if (!versionIdentity(ref) || expected != null && canonicalWfdJson(ref) !== canonicalWfdJson(expected)
    || previous !== null && canonicalWfdJson(ref) !== canonicalWfdJson(previous)) return mixedDefinition();
  return ref;
}

function normalize(value: unknown): Request {
  if (!isWfdRecord(value) || Object.keys(value).some(name => !['snapshotId', 'productId', 'historyMode', 'at', 'heldScope',
    'usableStage', 'selection', 'readMode', 'factorNames', 'keyField', 'filter', 'orderBy', 'topN'].includes(name))
    || !fixedProductIdentifier(value.snapshotId) || !fixedProductIdentifier(value.productId)
    || !['snapshot_contents', 'market_known_at', 'system_held_at'].includes(String(value.historyMode))
    || !isWfdRecord(value.selection) || Object.keys(value.selection).some(name => !['dateField', 'date', 'dateFormat', 'keys'].includes(name)))
    fail('STRATEGY_SCREEN_WFD_INPUT', '筛选须显式提供固定快照、产品、历史视角和单日截面；不接受自填数据行、路径或读取权限。');
  const s = value.selection;
  if (!field(s.dateField) || !day(s.date) || !['YYYY-MM-DD', 'YYYYMMDD'].includes(String(s.dateFormat))
    || s.dateField === value.keyField || !Array.isArray(value.factorNames) || value.factorNames.includes(s.dateField)
    || value.factorNames.length + 2 > 64
    || s.keys !== undefined && (!Array.isArray(s.keys) || !s.keys.length || s.keys.length > STRATEGY_SCREEN_LIMITS.rows
      || s.keys.some(item => !key(item)) || new Set(s.keys).size !== s.keys.length))
    fail('STRATEGY_SCREEN_WFD_INPUT', '截面日期、原日期格式、字段词表或明确标的集合无效。');
  const mode = value.historyMode as Request['historyMode'];
  if (mode === 'snapshot_contents') {
    if (value.at !== undefined || value.heldScope !== undefined || value.usableStage !== undefined)
      fail('STRATEGY_SCREEN_WFD_INPUT', '快照内容不得携带历史截止或持有声明。');
  } else {
    if (!isExplicitUtcInstant(value.at) || value.at.length !== 20)
      fail('STRATEGY_SCREEN_WFD_INPUT', '历史筛选须明确秒级 UTC 截止，不把日期补成午夜。');
    if (mode === 'system_held_at') {
      if (!id(value.heldScope) || !['acquired', 'custodied', 'published_readable'].includes(String(value.usableStage)))
        fail('STRATEGY_SCREEN_WFD_INPUT', '系统持有视角须明确实例范围和实际阶段。');
    } else if (value.heldScope !== undefined || value.usableStage !== undefined)
      fail('STRATEGY_SCREEN_WFD_INPUT', '市场可知视角不能混入系统持有声明。');
  }
  const readMode = value.readMode ?? 'product';
  if (!['product', 'indexed'].includes(String(readMode)) || readMode === 'indexed' && mode !== 'snapshot_contents')
    fail('STRATEGY_SCREEN_WFD_INPUT', '索引表格读取只支持明确固定快照；历史筛选须走已有产品历史读取。');
  const input = { factorNames: value.factorNames, keyField: value.keyField, filter: value.filter,
    orderBy: value.orderBy, topN: value.topN } as unknown as Omit<StrategyScreenInput, 'rows'>;
  // 先检查规则、词表与资源预算，非法表达式不触发 WFD 读取。
  screenStrategy({ ...input, rows: [] });
  return { ...input, snapshotId: value.snapshotId, productId: value.productId, historyMode: mode,
    ...(mode !== 'snapshot_contents' ? { at: value.at as string } : {}),
    ...(mode === 'system_held_at' ? { heldScope: value.heldScope as string, usableStage: value.usableStage as Request['usableStage'] } : {}),
    readMode: readMode as Request['readMode'], selection: { dateField: s.dateField, date: s.date,
      dateFormat: s.dateFormat as Selection['dateFormat'], ...(s.keys ? { keys: [...s.keys as string[]] } : {}) } };
}

export function strategyScreenContract() {
  return { action: 'algorithms.screen', methodId: 'strategy_screen', version: STRATEGY_SCREEN_VERSION,
    inputVersion: STRATEGY_SCREEN_WFD_VERSION, executor: 'typescript',
    input: { required: ['snapshotId', 'productId', 'historyMode', 'selection', 'factorNames', 'keyField', 'filter', 'orderBy', 'topN'],
      selection: { dateField: '实际声明的日期字段', date: 'YYYY-MM-DD', dateFormat: 'YYYY-MM-DD | YYYYMMDD', keys: '可选明确标的字符串数组' },
      history: 'market_known_at 还须 at；system_held_at 还须 at/heldScope/usableStage。由宿主核验真实用户的 historical_compute 用途，WFD 执行实际时间选择，返回候选标记为历史重算。',
      purposeEvidence: '用户可明确声明“请按市场可知视角，以 <秒级 UTC> 为截止筛选历史候选。”（或“系统持有”）。也可由用户原消息声明 JSON，包含 purpose=historical_compute、action、historyMode、cutoff 和可选固定产品、快照、持有范围与阶段。工具参数不能自授用途。',
      readMode: 'product（缺省，完整分页后选日）| indexed（仅固定快照文本批量表的日期索引）',
      fields: '由 keyField、selection.dateField 与 factorNames 组成；不接受调用者数据行。' },
    grammar: 'filter: 比较、and/or/not、括号；orderBy: 数值；两者支持 + - * / 与 rank(x)，只引用显式 factorNames。',
    rank: '在完整所选截面的有效操作数上先计算平均并列百分位，不按过滤后结果重新计算。',
    completeness: '完整读取所选产品范围，保留 WFD 已确定的历史排除；拒绝未知或不确定诊断、未完成页、循环游标、重复行和耗尽预算。排除诊断属固定产品范围，不能声称目标日期或整个市场覆盖完整。',
    limits: { compute: STRATEGY_SCREEN_LIMITS, read: STRATEGY_SCREEN_READ_LIMITS },
    publication: 'not_requested', execution: 'research_candidates_only', automaticTrading: false };
}

type FixedReadQuery = R1ProductReadInput & { historyMode: Request['historyMode']; fields: string[]; pageSize: number };
export type FixedProductRow = WfdRecord & { values: WfdRecord; record_ref: WfdRecord };

/** 固定产品读取共用同一套分页、历史排除、逐行资格及版本检查。只有完整读取后才能使用选中的行。 */
export async function readCompleteFixedProduct(query: FixedReadQuery, read: FixedProductReader, wait: AbortSignal,
  active: () => void, purposeContext: HistoricalPurposeContext | undefined,
  selectRow: (row: FixedProductRow) => boolean, expectedRevision?: string) {
  const history = readHistorySelection({ ...query }), fields = query.fields;
  const replay = query.historyMode !== 'snapshot_contents';
  if (replay && (!purposeContext || purposeContext.purpose !== 'historical_compute'
    || purposeContext.historyMode !== query.historyMode || purposeContext.cutoff !== query.at
    || !isExplicitUtcInstant(purposeContext.observedAtUtc) || Date.parse(purposeContext.observedAtUtc) > Date.now() + 300_000
    || !(purposeContext.authority === 'operator-http' && recordKey(purposeContext.requestId)
      || purposeContext.authority === 'user-message' && recordKey(purposeContext.messageId) && purposeContext.quote?.trim())))
    fail('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史读取须有本次历史视角和截止对应的受信操作者声明或真实用户消息。');
  const recordIds = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, identity: string | undefined, queryHash: string | undefined, partitionProof: string | undefined;
  let total: number | undefined, scannedRows = 0, pages = 0, bytes = 0, connection: R1ProductRead['connection'] | undefined;
  let datasetId: unknown, knowledgeCutoff: unknown, historicalExclusions: WfdRecord[] = [];
  let versions: ReturnType<typeof productVersions>, versionDigest: string | undefined;
  let connectionSha256: string | undefined;
  let rowContract: WfdRecord | null = null, rowDefinition: WfdRecord | null = null;
  do {
    active();
    const response = await read({ ...query, ...(cursor ? { cursor } : {}) }, wait);
    active();
    if (!isWfdRecord(response?.result) || !isWfdRecord(response.connection))
      fail('STRATEGY_SCREEN_WFD_RESPONSE', '受信读取缺少固定产品或连接身份。');
    const result = response.result, page = result.page;
    if (response.snapshotId !== query.snapshotId || response.productId !== query.productId || response.historyMode !== query.historyMode
      || result.snapshot_id !== query.snapshotId || result.product_id !== query.productId || result.history_mode !== query.historyMode
      || canonicalWfdJson(result.knowledge_cutoff ?? null) !== canonicalWfdJson(history.cutoff)
      || result.held_scope !== history.heldScope || result.usable_stage !== history.usableStage
      || canonicalWfdJson(result.fields) !== canonicalWfdJson(fields) || !isWfdRecord(page) || !Array.isArray(result.rows)
      || result.rows.length > query.pageSize! || page.returned_rows !== result.rows.length || !Number.isSafeInteger(page.total_rows)
      || Number(page.total_rows) < 0 || typeof page.has_more !== 'boolean' || typeof result.complete !== 'boolean'
      || page.has_more && result.complete || page.page_complete !== undefined && page.page_complete !== !page.has_more
      || page.page_size !== undefined && page.page_size !== query.pageSize
      || !Array.isArray(result.diagnostics) || typeof result.query_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.query_hash))
      fail('STRATEGY_SCREEN_WFD_RESPONSE', '固定读取的身份、字段、查询摘要或分页计数无法核对。');
    if (result.diagnostics.some(item => !knownHistoricalExclusion(item, query))
      || result.diagnostics_total !== undefined && result.diagnostics_total !== result.diagnostics.length
      || !page.has_more && !result.complete)
      fail('STRATEGY_SCREEN_WFD_INCOMPLETE', 'WFD 返回不确定诊断、未识别的排除或未完整读取；不能把局部截面当成完整样本排名。');
    versions = productVersions(result);
    if (expectedRevision !== undefined && versions.definitionRef != null
      && (!isWfdRecord(versions.definitionRef) || versions.definitionRef.version !== expectedRevision))
      fail('PURE_OPERATOR_DEFINITION_MISMATCH', '固定产品定义修订与请求不一致。');
    const currentVersionDigest = wfdSha256(canonicalWfdJson(versions));
    if (versionDigest !== undefined && currentVersionDigest !== versionDigest) mixedDefinition();
    versionDigest = currentVersionDigest;
    connectionSha256 = response.connectionSha256;
    const currentIdentity = canonicalWfdJson({ connection: response.connection, connectionSha256: connectionSha256 ?? null, datasetId: result.dataset_id,
      cutoff: result.knowledge_cutoff, heldScope: result.held_scope, usableStage: result.usable_stage,
      historicalExclusions: result.diagnostics, versionDigest });
    const indexed = isWfdRecord(result.indexed_tabular) ? result.indexed_tabular : null;
    const currentProof = indexed ? canonicalWfdJson(indexed) : null;
    if (query.selection !== undefined && (!indexed || !Array.isArray(indexed.missing_partitions) || indexed.missing_partitions.length))
      fail('STRATEGY_SCREEN_WFD_INCOMPLETE', '索引日期范围有缺失分区或没有固定表格证明。');
    if (identity !== undefined && identity !== currentIdentity || queryHash !== undefined && queryHash !== result.query_hash
      || total !== undefined && total !== page.total_rows || partitionProof !== undefined && partitionProof !== currentProof)
      fail('STRATEGY_SCREEN_WFD_CHANGED', '分页期间连接、历史视角、查询、计数或分区证明变化。');
    identity = currentIdentity; queryHash = result.query_hash; total = Number(page.total_rows); connection = response.connection;
    datasetId = result.dataset_id; knowledgeCutoff = result.knowledge_cutoff; historicalExclusions = result.diagnostics as WfdRecord[];
    if (currentProof !== null) partitionProof = currentProof;
    pages += 1; scannedRows += result.rows.length; bytes += Buffer.byteLength(canonicalWfdJson(result));
    if (total > STRATEGY_SCREEN_READ_LIMITS.rows || scannedRows > STRATEGY_SCREEN_READ_LIMITS.rows
      || bytes > STRATEGY_SCREEN_READ_LIMITS.bytes || scannedRows > total)
      fail('STRATEGY_SCREEN_WFD_BUDGET', '固定读取超过行数或字节预算；没有对已读第一页做部分排名。');
    // WFD 的 remaining_rows 是游标之后、取本页之前的精确余量。
    if (page.remaining_rows !== total - scannedRows + result.rows.length || page.has_more !== (scannedRows < total))
      fail('STRATEGY_SCREEN_WFD_RESPONSE', '固定产品分页余量与本页起点、总数或续页标记不一致。');
    const excludedVersions = expectedRevision && replay ? new Set(historicalExclusions.map(item => item.revision_id).filter(fixedProductIdentifier)) : null;
    for (const raw of result.rows) {
      if (!isWfdRecord(raw) || !isWfdRecord(raw.record_ref) || !isWfdRecord(raw.values))
        fail('STRATEGY_SCREEN_WFD_RESPONSE', '固定行缺少值对象或记录引用。');
      checkHistoricalRow(raw, query);
      const ref = raw.record_ref;
      // 普通产品的固定读取允许最小 logical_key/revision_id 引用，外层已绑定快照及产品。
      // 若行引用显式携带身份，仍必须与受信读取相符；不补造来源字段。
      if (raw.snapshot_id !== undefined && raw.snapshot_id !== query.snapshotId
        || raw.product_id !== undefined && raw.product_id !== query.productId
        || ref.product_id !== undefined && ref.product_id !== query.productId
        || ref.snapshot_id !== undefined && ref.snapshot_id !== query.snapshotId
        || !recordKey(ref.logical_key ?? ref.record_id) || !fixedProductIdentifier(ref.revision_id))
        fail('STRATEGY_SCREEN_WFD_RESPONSE', '记录引用与所选固定快照、产品或版本不符。');
      if (excludedVersions?.has(ref.revision_id))
        fail('PURE_OPERATOR_HISTORICAL_CONFLICT', '同一固定版本同时出现在合格行与排除证据中。');
      const recordIdentity = expectedRevision ? String(ref.logical_key ?? ref.record_id) : canonicalWfdJson(ref);
      if (recordIds.has(recordIdentity)) fail('STRATEGY_SCREEN_WFD_RESPONSE', '固定读取重复返回同一行，未静默去重。');
      recordIds.add(recordIdentity);
      if (!selectRow({ ...raw, values: raw.values, record_ref: ref })) continue;
      if (expectedRevision !== undefined) {
        const definition = raw.definition_ref ?? versions.definitionRef;
        if (!isWfdRecord(definition) || definition.version !== expectedRevision)
          fail('PURE_OPERATOR_DEFINITION_MISMATCH', '行的固定定义修订与请求不一致。');
      }
      if (!versions.hasContract && raw.contract_ref == null) mixedDefinition();
      rowContract = checkRowVersion(raw.contract_ref, versions.contractRef, rowContract);
      rowDefinition = checkRowVersion(raw.definition_ref, versions.definitionRef, rowDefinition);
    }
    if (!page.has_more) {
      if (page.next_cursor !== null || scannedRows !== total)
        fail('STRATEGY_SCREEN_WFD_RESPONSE', '分页终点与固定总行数不一致。');
      break;
    }
    if (!result.rows.length || typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 8192
      || /[\u0000-\u001f]/u.test(page.next_cursor) || cursors.has(page.next_cursor))
      fail('STRATEGY_SCREEN_WFD_RESPONSE', '读取游标重复、缺失或无进展。');
    if (pages >= STRATEGY_SCREEN_READ_LIMITS.pages || scannedRows >= STRATEGY_SCREEN_READ_LIMITS.rows)
      fail('STRATEGY_SCREEN_WFD_BUDGET', '分页预算已耗尽，未把部分截面作为完整输入。');
    cursor = page.next_cursor; cursors.add(cursor);
  } while (cursor);
  if (!versions.hasContract && !rowContract) mixedDefinition();
  const definitionRef = rowDefinition ?? versions.definitionRef;
  if (expectedRevision !== undefined && (!isWfdRecord(definitionRef) || definitionRef.version !== expectedRevision))
    fail('PURE_OPERATOR_DEFINITION_MISMATCH', '完整读取缺少预期的定义修订。');
  return { datasetId, knowledgeCutoff, connection, queryHash, pages, scannedRows, complete: true as const,
    historicalExclusions: { source: 'WFD', scope: 'fixed_product_not_date_filtered', diagnostics: historicalExclusions },
    ...(connectionSha256 ? { connectionSha256 } : {}),
    ...(versions.definitionRefs ? { definitionRefs: versions.definitionRefs } : {}),
    ...(versions.contractVersions ? { contractVersionsSha256: wfdSha256(canonicalWfdJson(versions.contractVersions)) } : {}),
    ...((rowContract ?? versions.contractRef) ? { contractRef: rowContract ?? versions.contractRef } : {}),
    ...((rowDefinition ?? versions.definitionRef) ? { definitionRef: rowDefinition ?? versions.definitionRef } : {}),
  };
}

/** 共用 R1 固定读取，不建立快照、数据库或第二个历史选择器。 */
export async function screenFixedWfdStrategy(value: unknown, read: FixedProductReader, signal?: AbortSignal,
  assertCurrent: () => void = () => {}, purposeContext?: HistoricalPurposeContext) {
  const started = performance.now();
  const request = normalize(value), fields = [...request.factorNames, request.keyField, request.selection.dateField].sort();
  const replay = request.historyMode !== 'snapshot_contents';
  const query: FixedReadQuery = { snapshotId: request.snapshotId, productId: request.productId,
    historyMode: request.historyMode, fields, pageSize: request.readMode === 'indexed' ? 500 : 100,
    ...(request.at ? { at: request.at } : {}), ...(request.heldScope ? { heldScope: request.heldScope, usableStage: request.usableStage } : {}),
    ...(request.readMode === 'indexed' ? { selection: {
      dateRange: { field: request.selection.dateField, format: request.selection.dateFormat, start: request.selection.date, end: request.selection.date },
      ...(request.selection.keys ? { match: { [request.keyField]: request.selection.keys } } : {}),
    } } : {}) };
  const wait = AbortSignal.any([AbortSignal.timeout(STRATEGY_SCREEN_READ_LIMITS.timeoutMs), ...(signal ? [signal] : [])]);
  const active = () => {
    wait.throwIfAborted(); assertCurrent();
    if (performance.now() - started >= STRATEGY_SCREEN_READ_LIMITS.timeoutMs)
      fail('STRATEGY_SCREEN_WFD_BUDGET', '固定读取及筛选超过 60 秒预算。');
  };
  const records: Record<string, unknown>[] = [], references: WfdRecord[] = [];
  const requestedKeys = request.selection.keys ? new Set(request.selection.keys) : null;
  const selectedKeys = new Set<string>();
  const fieldMetadata: Record<string, unknown> = {};
  const fixedRead = await readCompleteFixedProduct(query, read, wait, active, purposeContext, raw => {
    const ref = raw.record_ref;
    const values = raw.values, dateCell = values[request.selection.dateField];
    if (!isWfdRecord(dateCell) || dateCell.value_state !== 'valid_value' || typeof dateCell.value !== 'string')
      fail('STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN', '存在日期缺失或非有效日期状态，不能证明该行是否属于目标截面。');
    const dateValue = request.selection.dateFormat === 'YYYYMMDD' && /^\d{8}$/u.test(dateCell.value)
      ? `${dateCell.value.slice(0, 4)}-${dateCell.value.slice(4, 6)}-${dateCell.value.slice(6)}` : dateCell.value;
    if (!day(dateValue) || request.selection.dateFormat === 'YYYYMMDD' && !/^\d{8}$/u.test(dateCell.value))
      fail('STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN', 'WFD 日期原值与显式格式不符。');
    if (dateValue !== request.selection.date) {
      if (request.readMode === 'indexed') fail('STRATEGY_SCREEN_WFD_RESPONSE', '日期索引返回目标截面之外的行。');
      return false;
    }
    const keyCell = values[request.keyField];
    if (!isWfdRecord(keyCell) || keyCell.value_state !== 'valid_value' || !key(keyCell.value))
      fail('STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN', '截面行没有有效、明确的标的字段。');
    if (requestedKeys && !requestedKeys.has(keyCell.value)) {
      if (request.readMode === 'indexed') fail('STRATEGY_SCREEN_WFD_RESPONSE', '索引返回明确标的集合之外的行。');
      return false;
    }
    if (selectedKeys.has(keyCell.value)) fail('STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN', '同一截面标的有多行或多个版本，必须先明确数据口径。');
    selectedKeys.add(keyCell.value);
    const record: Record<string, unknown> = { [request.keyField]: keyCell.value };
    for (const name of request.factorNames) {
      const cell = values[name];
      const reportedZero = isWfdRecord(cell) && cell.value_state === 'reported_zero';
      if (reportedZero && !isNumericReportedZero(cell.data_type, cell.value))
        fail('STRATEGY_SCREEN_WFD_RESPONSE', '因子的 reported_zero 状态要求 decimal 或 integer 类型及明确的零值。');
      const usable = isWfdRecord(cell) && (cell.value_state === 'valid_value' || reportedZero);
      // reported_zero 是有来源声明的有效零；其余非值态即使携带数值仍保持缺项。
      record[name] = usable ? cell.value : null;
      if (usable) {
        const metadata = { dataType: cell.data_type ?? null, unit: cell.unit ?? null };
        if (Object.hasOwn(fieldMetadata, name) && canonicalWfdJson(fieldMetadata[name]) !== canonicalWfdJson(metadata))
          fail('STRATEGY_SCREEN_FIELD_CHANGED', '同一因子在截面中存在不同数据类型或单位口径。');
        fieldMetadata[name] = metadata;
      }
    }
    records.push(record); references.push(ref);
    return true;
  });
  if (request.selection.keys?.some(item => !selectedKeys.has(item)))
    fail('STRATEGY_SCREEN_WFD_INCOMPLETE', '固定数据没有覆盖明确要求的全部标的；未以缺项为零继续排名。');
  active();
  const result = screenStrategy({ rows: records, factorNames: request.factorNames, keyField: request.keyField,
    filter: request.filter, orderBy: request.orderBy, topN: request.topN });
  active();
  const output = { ...result, inputVersion: STRATEGY_SCREEN_WFD_VERSION, taskType: 'research_candidates' as const,
    evaluatedAtUtc: new Date().toISOString(), replay,
    fixedRead: { ...fixedRead, snapshotId: request.snapshotId, productId: request.productId, historyMode: request.historyMode,
      at: request.at ?? null, heldScope: request.heldScope ?? null, usableStage: request.usableStage ?? null,
      readMode: request.readMode, selection: request.selection, fields, crossSectionRows: records.length,
      coverageBasis: 'selected_fixed_product_only_not_all_market', fieldMetadata,
      projectionSha256: wfdSha256(canonicalWfdJson(records)), recordReferencesSha256: wfdSha256(canonicalWfdJson(references)),
      selectedReferences: result.selected.map(item => ({ key: item.key, recordRef: references[item.rowIndex] })) },
    publication: 'not_requested' as const, automaticTrading: false, returnTo: 'agents' as const };
  if (Buffer.byteLength(canonicalWfdJson(output)) > STRATEGY_SCREEN_READ_LIMITS.resultBytes)
    fail('STRATEGY_SCREEN_WFD_BUDGET', '完整候选与证据超过原任务结果预算；请明确减少 topN 或因子词表，不截断既有结果。');
  active();
  return output;
}

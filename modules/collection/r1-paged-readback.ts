import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdProductMachineReadPageOptions, WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { R1Receipt } from './r1-structured-handoff.js';
import { assertR1ContractBinding, frozenR1RowMatches, readR1ContractBinding } from './r1-tabular.js';

export const R1_READ_PAGE_FORMAT = 'wfd.fixed-read-page/1';
const LEGACY_PAGE_SIZE = 256, PAGE_BYTES = 1_048_576, MAX_STATE_BYTES = 8_388_608;
const sha = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const compare = (left: string, right: string) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
interface Ref { record_id: string; record_version: string }
export interface R1ReadbackInput { requestId: string; documentSha256: string; document: WfdRecord; receipt: R1Receipt }
export interface R1ReadbackClient {
  /** Absence is the explicit legacy contract-double boundary, not a page-error fallback. */
  pageReadSupport?(document: WfdRecord, signal?: AbortSignal): Promise<boolean>;
  /** Available only after the same capability negotiation; old clients retain 256. */
  pageReadSize?(): number;
  fixedReadPage(options: WfdProductMachineReadPageOptions, signal?: AbortSignal): Promise<WfdProductMachineReply>;
  fixedRead(snapshotId: string, productId?: string, signal?: AbortSignal): Promise<WfdProductMachineReply>;
}
interface SavedState { version: 1 | 2; pageSize?: number; binding: string; mode: 'page' | 'legacy'; manifest: string | null;
  selection: string; query: string | null; pageDigests: string[];
  cursor: string | null; complete: boolean; rows: WfdRecord[]; pages: number }
interface Loaded { state: SavedState; digest: string }

/** Existing BD database, bounded R1 selection only. No WFD catalog access or new submit. */
export class R1PagedReadback {
  constructor(private readonly database: CoreDatabase) {
    database.migrate('r1-readback-checkpoint', 1, `CREATE TABLE r1_readback_checkpoints (
      request_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, state_sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`);
    database.migrate('r1-readback-continuation', 1, `CREATE TABLE r1_readback_continuations (
      request_id TEXT PRIMARY KEY,source_state_sha256 TEXT NOT NULL,phase_request_id TEXT NOT NULL UNIQUE,
      failure_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  private get db() { return this.database.connection; }
  progress(requestId: string) {
    const continued = this.continuation(requestId), loaded = this.load(continued?.phaseRequestId ?? requestId); if (!loaded) return null;
    const { state } = loaded;
    return { mode: state.mode, verifiedRows: state.rows.length, pages: state.pages,
      complete: state.mode === 'page' ? state.complete : null, hasMore: state.cursor !== null,
      ...(continued ? { continuation: continued } : {}) };
  }
  /** Explicit recovery adds a page phase; the failed legacy checkpoint is immutable. */
  async beginPageContinuation(input: R1ReadbackInput, client: R1ReadbackClient, failure: WfdRecord, signal?: AbortSignal): Promise<void> {
    if (this.continuation(input.requestId)) return;
    const previous = this.load(input.requestId);
    if (!previous || previous.state.mode !== 'legacy') return;
    const outputs = input.document.outputs, output = Array.isArray(outputs) ? object(outputs[0]) : {};
    if (object(output.payload).kind !== 'tabular_rows' || failure.code !== 'RESPONSE_TOO_LARGE') return;
    if (previous.state.pages || previous.state.rows.length || previous.state.cursor !== null || previous.state.complete)
      fail('CONTINUATION_INVALID', '旧读取已经核过部分内容，不能将其覆盖为新分页阶段。');
    if (!await client.pageReadSupport?.(input.document, signal)) return;
    signal?.throwIfAborted();
    const pageSize=negotiatedPageSize(client), refs=normalizedRefs(input.receipt), selection=sha(refs), query=pageQueryDigest(input.receipt,selection,pageSize);
    if(previous.state.selection!==selection)fail('CONTINUATION_INVALID','分页续读的原回执行集合不同。');
    const state:SavedState={...previous.state,version:2,pageSize,mode:'page',query};
    const phaseRequestId=input.requestId+':fixed-page-continuation-1', body=canonicalWfdJson(state);
    this.database.transaction(()=>{
      const current=this.load(input.requestId);
      if(!current || current.digest!==previous.digest)fail('CONTINUATION_INVALID','原失败检查点已变化，未建立分页续读。');
      this.db.prepare('INSERT INTO r1_readback_checkpoints VALUES(?,?,?,?)').run(phaseRequestId,body,wfdSha256(body),Date.now());
      this.db.prepare('INSERT INTO r1_readback_continuations VALUES(?,?,?,?,?)').run(input.requestId,previous.digest,phaseRequestId,canonicalWfdJson(failure),Date.now());
    });
  }
  async read(input: R1ReadbackInput, client: R1ReadbackClient, signal?: AbortSignal): Promise<WfdRecord[]> {
    signal?.throwIfAborted();
    const refs = normalizedRefs(input.receipt);
    const selectionDigest = sha(refs);
    const binding = sha({ document_sha256: input.documentSha256, receipt: { ...input.receipt,
      rows: [...input.receipt.rows].sort((a, b) => compare(a.record_id, b.record_id) || compare(a.record_version, b.record_version)) } });
    const checkpointId=this.continuation(input.requestId)?.phaseRequestId ?? input.requestId;
    let loaded = this.load(checkpointId);
    if (loaded && loaded.state.binding !== binding) fail('BINDING_CHANGED', '原请求的文档或正式行回执与分页检查点不同。');
    if (wfdSha256(canonicalWfdJson(input.document)) !== input.documentSha256) fail('DOCUMENT_CHANGED', '固定文档摘要不符。');
    const expected = acceptedR1ReceiptRows(input.document, input.receipt);
    if (!loaded) {
      const supported = await client.pageReadSupport?.(input.document, signal) === true;
      signal?.throwIfAborted();
      const pageSize=negotiatedPageSize(client);
      const initial: SavedState = { version: 2, pageSize, binding, mode: supported ? 'page' : 'legacy', manifest: null,
        selection: selectionDigest, query: supported ? pageQueryDigest(input.receipt,selectionDigest,pageSize) : null, pageDigests: [],
        cursor: null, complete: false, rows: [], pages: 0 };
      const text = canonicalWfdJson(initial);
      this.db.prepare('INSERT INTO r1_readback_checkpoints VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING')
        .run(checkpointId, text, wfdSha256(text), Date.now());
      loaded = this.load(checkpointId)!;
      if (loaded.state.binding !== binding) fail('BINDING_CHANGED', '并行调用已冻结不同的原请求身份。');
    }
    if (loaded.state.mode === 'legacy') {
      // Mode is frozen before the first read. A later page failure never reaches this branch.
      const result = await client.fixedRead(input.receipt.snapshot_id, input.receipt.product_id, signal);
      verifyContracts(input, result.result);
      if (!Array.isArray(result.result.rows) || !result.result.rows.every(isWfdRecord)) fail('ROWS_INVALID', '旧固定读取没有完整行数组。');
      return result.result.rows;
    }
    const pageSize=loaded.state.version===1?LEGACY_PAGE_SIZE:loaded.state.pageSize!, queryDigest=pageQueryDigest(input.receipt,selectionDigest,pageSize);
    if (loaded.state.selection !== selectionDigest || loaded.state.query !== queryDigest) fail('BINDING_CHANGED', '持久选择或查询摘要与原读取协议/预算不同。');
    validateRows(input, expected, refs, loaded.state.rows);
    if (loaded.state.complete && loaded.state.rows.length !== refs.length) fail('CHECKPOINT_CHANGED', '完成检查点的行集合不完整。');
    while (!loaded.state.complete) {
      signal?.throwIfAborted();
      const reply = await client.fixedReadPage({ snapshotId: input.receipt.snapshot_id, productId: input.receipt.product_id,
        recordRefs: refs, pageSize, maxPageBytes: PAGE_BYTES, cursor: loaded.state.cursor }, signal);
      signal?.throwIfAborted();
      const result = reply.result, pagination = object(result.pagination), integrity = object(result.integrity);
      verifyContracts(input, result);
      if (result.profile !== 'data_only' || result.snapshot_id !== input.receipt.snapshot_id
        || result.product_id !== input.receipt.product_id || result.dataset_id !== input.receipt.dataset_id
        || result.perspective !== 'snapshot_contents' || result.include_history !== false
        || (result.at !== undefined && result.at !== null) || (result.held_scope !== undefined && result.held_scope !== null)) {
        fail('IDENTITY_MISMATCH', '固定页的实例数据范围、产品、快照或读取视角不同。');
      }
      if (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES) fail('BUDGET', '固定页超出已冻结的结果字节预算。');
      const rows = result.rows;
      if (!Array.isArray(rows) || !rows.every(isWfdRecord) || rows.length === 0 || rows.length > pageSize
        || pagination.format_version !== R1_READ_PAGE_FORMAT || pagination.page_size !== pageSize
        || pagination.max_page_bytes !== PAGE_BYTES || pagination.returned_rows !== rows.length
        || pagination.selection_count !== refs.length || typeof pagination.has_more !== 'boolean') fail('PAGE_INVALID', '固定页格式、行数或冻结预算不符。');
      for (const name of ['manifest_digest', 'selection_digest', 'query_digest', 'page_digest']) {
        if (typeof integrity[name] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(String(integrity[name]))) fail('INTEGRITY_INVALID', '固定页缺少限定格式摘要。');
      }
      if (integrity.selection_digest !== selectionDigest || integrity.query_digest !== queryDigest
        || integrity.page_digest !== sha(rows.map(value => ({ record_id: value.record_id, record_version: value.record_version })))) {
        fail('INTEGRITY_MISMATCH', '分页选择、查询或本页逐行身份摘要不符。');
      }
      if (loaded.state.manifest !== null && integrity.manifest_digest !== loaded.state.manifest) fail('MANIFEST_CHANGED', '续页的固定清单摘要变化，不能拼接两个快照视图。');
      // Verify the complete public page first; persist only what the fixed R1 verifier needs.
      // Repeated WFD source bindings/qualification metadata remain in the immutable WFD snapshot.
      validateRows(input, expected, refs, rows);
      const all = [...loaded.state.rows, ...rows.map(value => verificationProjection(value, expected.get(String(value.record_id))!))];
      validateRows(input, expected, refs, all);
      const hasMore = pagination.has_more, cursor = pagination.next_cursor;
      if (hasMore ? typeof cursor !== 'string' || !cursor || cursor.length > 16_384 || cursor === loaded.state.cursor : cursor !== null) {
        fail('CURSOR_INVALID', '续页游标缺失、重复或与终止状态冲突。');
      }
      if (hasMore !== (all.length < refs.length)) fail('ROW_COUNT', '页终止状态与原回执完整行集合不同。');
      const state: SavedState = { ...loaded.state, manifest: String(integrity.manifest_digest), cursor: cursor as string | null,
        complete: !hasMore, rows: all, pages: loaded.state.pages + 1,
        pageDigests: [...loaded.state.pageDigests, String(integrity.page_digest)] };
      loaded = this.save(checkpointId, state, loaded.digest);
    }
    return loaded.state.rows;
  }
  private continuation(requestId:string):{phaseRequestId:string;sourceStateSha256:string;failure:WfdRecord}|null {
    const row=this.db.prepare('SELECT * FROM r1_readback_continuations WHERE request_id=?').get(requestId);
    if(!row)return null;
    const previous=this.load(requestId);
    if(!previous||previous.digest!==row.source_state_sha256)fail('CONTINUATION_CHANGED','原失败检查点偏离分页续读绑定。');
    return {phaseRequestId:String(row.phase_request_id),sourceStateSha256:String(row.source_state_sha256),failure:JSON.parse(String(row.failure_json)) as WfdRecord};
  }
  private load(requestId: string): Loaded | null {
    const row = this.db.prepare('SELECT state_json,state_sha256 FROM r1_readback_checkpoints WHERE request_id=?').get(requestId);
    if (!row) return null;
    const text = String(row.state_json);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES || wfdSha256(text) !== row.state_sha256) fail('CHECKPOINT_CHANGED', '持久分页检查点字节或摘要不符。');
    let value: unknown; try { value = JSON.parse(text); } catch { return fail('CHECKPOINT_CHANGED', '持久分页检查点不是 JSON。'); }
    if (!isWfdRecord(value) || (value.version!==1 && value.version!==2)
      || (value.version===1 ? value.pageSize!==undefined : !Number.isSafeInteger(value.pageSize) || Number(value.pageSize)<1 || Number(value.pageSize)>1000)
      || !['page', 'legacy'].includes(String(value.mode))
      || typeof value.binding !== 'string' || !Array.isArray(value.rows) || value.rows.length > 5000 || !value.rows.every(isWfdRecord)
      || typeof value.complete !== 'boolean' || !Number.isSafeInteger(value.pages) || Number(value.pages) < 0
      || typeof value.selection !== 'string' || !(value.query === null || typeof value.query === 'string')
      || !Array.isArray(value.pageDigests) || value.pageDigests.length !== value.pages
      || value.pageDigests.some(digest => typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      || !(value.cursor === null || typeof value.cursor === 'string') || !(value.manifest === null || typeof value.manifest === 'string')) fail('CHECKPOINT_CHANGED', '持久分页检查点结构无效。');
    return { state: value as unknown as SavedState, digest: String(row.state_sha256) };
  }
  private save(requestId: string, state: SavedState, previousDigest: string): Loaded {
    const text = canonicalWfdJson(state), digest = wfdSha256(text);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) fail('BUDGET', '本次 R1 有限选择的持久核对结果超出本地 8 MiB 上限；没有截断或关联。');
    this.database.transaction(() => {
      const result = this.db.prepare('UPDATE r1_readback_checkpoints SET state_json=?,state_sha256=?,updated_at=? WHERE request_id=? AND state_sha256=?')
        .run(text, digest, Date.now(), requestId, previousDigest);
      if (Number(result.changes) !== 1) fail('CONCURRENT_CHANGE', '并行读取已推进检查点，本调用不能覆盖。');
    });
    return { state, digest };
  }
}
function object(value: unknown): WfdRecord { return isWfdRecord(value) ? value : {}; }
function negotiatedPageSize(client:R1ReadbackClient):number {
  const size=client.pageReadSize?.()??LEGACY_PAGE_SIZE;
  if(!Number.isSafeInteger(size)||size<1||size>1000)fail('PAGE_INVALID','协商分页行数超出原有1–1000行能力。');
  return size;
}
function pageQueryDigest(receipt:R1Receipt,selection:string,pageSize:number):string {
  return sha({format_version:R1_READ_PAGE_FORMAT,profile:'data_only',snapshot_id:receipt.snapshot_id,product_id:receipt.product_id,
    selection_digest:selection,page_size:pageSize,max_page_bytes:PAGE_BYTES,perspective:'snapshot_contents',include_history:false});
}
function normalizedRefs(receipt: R1Receipt): Ref[] {
  for (const key of ['dataset_id', 'output_key', 'product_id', 'definition_digest', 'snapshot_id'] as const) {
    if (typeof receipt[key] !== 'string' || !receipt[key]) fail('RECEIPT_INVALID', '原回执缺少准确数据集、输出、产品、定义或快照身份。');
  }
  if (!Array.isArray(receipt.rows) || receipt.rows.length < 1 || receipt.rows.length > 5000) fail('RECEIPT_INVALID', '需要当前 R1 1–5000 个实际行版本。');
  const refs = receipt.rows.map(value => {
    if (!value || typeof value.record_id !== 'string' || !value.record_id || value.record_id !== value.business_key
      || typeof value.record_version !== 'string' || !value.record_version) fail('RECEIPT_INVALID', '原回执需要准确业务键及实际行版本。');
    return { record_id: value.record_id, record_version: value.record_version };
  }).sort((a, b) => compare(a.record_id, b.record_id) || compare(a.record_version, b.record_version));
  if (new Set(refs.map(value => value.record_id)).size !== refs.length) fail('RECEIPT_INVALID', '原回执有重复行身份。');
  return refs;
}
/** Validate the complete original row classification before selecting accepted identities. */
export function acceptedR1ReceiptRows(document: WfdRecord, receipt: R1Receipt): Map<string, WfdRecord> {
  const first = Array.isArray(document.outputs) ? object(document.outputs[0]) : {}, rows = object(first.payload).rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000 || !rows.every(isWfdRecord)
    || first.output_key !== receipt.output_key || canonicalWfdJson(document.request_identity) !== canonicalWfdJson(receipt.request_identity))
    fail('RECEIPT_INVALID', '原回执输出、请求身份或冻结行集合不符。');
  if (document.duplicate_policy !== 'skip_identical_append') {
    const map = new Map(rows.map(value => [String(value.business_key), value]));
    if (rows.length !== receipt.rows.length || map.size !== receipt.rows.length
      || receipt.rows.some(ref => !map.has(ref.record_id))) fail('RECEIPT_INVALID', '原回执不是冻结文档的完整业务键集合。');
    return map;
  }
  const results = receipt.row_results, summary = receipt.row_summary;
  if (!Array.isArray(results) || results.length !== rows.length || !summary) fail('RECEIPT_INVALID', '去重回执必须逐原行列出完整结果与计数。');
  const seen = new Set<number>(), accepted = new Map<string, WfdRecord>(), versions = new Map<string, string>();
  const counts = { inserted: 0, duplicate_skipped: 0, conflict_pending: 0 };
  for (const result of results) {
    const index = result.row_index, incoming = rows[index];
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index) || !incoming || incoming.business_key !== result.business_key)
      fail('RECEIPT_INVALID', '逐行回执的原行索引或业务键不符、缺失或重复。');
    seen.add(index);
    if (!['inserted','duplicate_skipped','conflict_pending'].includes(result.state)) fail('RECEIPT_INVALID', '逐行状态不是明确新增、跳过或待确认冲突。');
    counts[result.state]++;
    if (result.state === 'conflict_pending') {
      if (Object.hasOwn(result, 'record_id') || Object.hasOwn(result, 'record_version') || !result.reason
        || !Array.isArray(result.difference_fields) || !result.difference_fields.every(path => typeof path === 'string')
        || !Array.isArray(result.existing_records) || result.existing_records.some(ref => !ref || !ref.record_id || !ref.record_version
          || !ref.snapshot_id || !ref.product_id || !isWfdRecord(ref.definition_ref) || !ref.definition_ref.digest))
        fail('RECEIPT_INVALID', '冲突项不得冒充已接收身份，必须保留差异和固定旧记录引用。');
      continue;
    }
    if (result.record_id !== result.business_key || typeof result.record_version !== 'string' || !result.record_version)
      fail('RECEIPT_INVALID', '已接收行缺实际记录身份。');
    const previous = accepted.get(result.record_id);
    if (previous && (canonicalWfdJson(previous) !== canonicalWfdJson(incoming) || versions.get(result.record_id) !== result.record_version))
      fail('RECEIPT_INVALID', '同业务键的已接收行内容或版本不一致。');
    accepted.set(result.record_id, incoming); versions.set(result.record_id, result.record_version);
  }
  if (Object.keys(counts).some(key => counts[key as keyof typeof counts] !== summary[key as keyof typeof counts]))
    fail('RECEIPT_INVALID', '去重计数与逐原行状态不一致。');
  if (receipt.rows.length !== accepted.size || new Set(receipt.rows.map(row => row.record_id)).size !== receipt.rows.length
    || receipt.rows.some(row => row.business_key !== row.record_id || versions.get(row.record_id) !== row.record_version))
    fail('RECEIPT_INVALID', '实际记录引用集合与逐原行已接收结果不同。');
  return accepted;
}
function validateRows(input: R1ReadbackInput, expected: Map<string, WfdRecord>, refs: Ref[], rows: WfdRecord[]): void {
  const versions = new Map(refs.map(ref => [ref.record_id, ref.record_version])); let previous = '';
  for (const [index, actual] of rows.entries()) {
    const id = actual.record_id, value = object(actual.row), recordRef = object(actual.record_ref);
    if (typeof id !== 'string' || !expected.has(id) || (index > 0 && compare(previous, id) >= 0)
      || actual.record_version !== versions.get(id) || value.business_key !== id || actual.product_id !== input.receipt.product_id
      || object(actual.definition_ref).digest !== input.receipt.definition_digest || recordRef.snapshot_id !== input.receipt.snapshot_id
      || recordRef.logical_key !== id || recordRef.revision_id !== actual.record_version) fail('ROW_IDENTITY', '页中记录不属于原回执的准确版本、顺序、定义或快照。');
    const wanted = expected.get(id)!;
    if (input.document.duplicate_policy === 'skip_identical_append' ? canonicalWfdJson(wanted) !== canonicalWfdJson(value) : !frozenR1RowMatches(wanted, value)) fail('ROW_CONTENT', '固定页全部冻结业务字段与原文档不符。');
    previous = id;
  }
}
function verificationProjection(actual: WfdRecord, expected: WfdRecord): WfdRecord {
  const observed = object(actual.row), recordRef = object(actual.record_ref), row: WfdRecord = { business_key: observed.business_key };
  for (const key of Object.keys(expected)) row[key] = observed[key];
  return { record_id: actual.record_id, record_version: actual.record_version, product_id: actual.product_id,
    definition_ref: { digest: object(actual.definition_ref).digest },
    record_ref: { snapshot_id: recordRef.snapshot_id, logical_key: recordRef.logical_key, revision_id: recordRef.revision_id }, row };
}
function verifyContracts(input: R1ReadbackInput, result: WfdRecord): void {
  const outputs = input.document.outputs, first = Array.isArray(outputs) ? object(outputs[0]) : {};
  const binding = readR1ContractBinding(input.receipt as unknown as WfdRecord, input.receipt.dataset_id,
    input.receipt.product_id, object(first.payload).kind === 'tabular_rows');
  if (!binding) return; // Original scalar contract doubles/tasks did not freeze four role refs.
  const products = Array.isArray(result.products) ? result.products.filter(isWfdRecord).filter(product => product.product_id === input.receipt.product_id
    && object(product.definition_ref).digest === input.receipt.definition_digest) : [];
  if (!products.length) fail('CONTRACTS', '固定读回缺少原产品定义对应的四合同元数据。');
  for (const product of products) assertR1ContractBinding(product, binding);
}
function fail(suffix: string, message: string): never { throw new TaskError('R1_READBACK_' + suffix, message); }

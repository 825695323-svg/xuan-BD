import type { R1ConnectionIdentity, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { R1_BATCH_MAX_FILES, R1_BATCH_MAX_BYTES, MATERIAL_UPLOAD_LIMIT } from '../../contracts/upload-limits.js';
export { R1_BATCH_MAX_FILES, R1_BATCH_MAX_BYTES } from '../../contracts/upload-limits.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { OperatorContext } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import { assertKnownR1Source, parseR1Utc } from './r1-structured-handoff.js';
import type { R1AutoService, R1AutoState, R1AutoView } from './r1-auto.js';
import { R1ChunkedCsvService } from './r1-chunked-csv.js';
import { readAdapterBindingRef, type AdapterBindingRef, type FrozenAdapterBinding } from './endpoint-adapter.js';
import type { EndpointAdapterRegistry } from './endpoint-adapter-registry.js';

export interface R1BatchFile { name: string; relativePath: string; sha256: string; byteLength: number }
export interface R1BatchStartInput {
  batchId: string; source: R1SourceDeclaration; datasetId: string; files: R1BatchFile[];
  datePolicy?: 'a_share_calendar_day_asia_shanghai';
  sourceValueColumns?: string[];
  /** 本批统一使用的已采用端点适配引用；逐件配置不在本批展开。 */
  sourceAdapter?: AdapterBindingRef;
  /** 本批逐件取得回执模板：地址含 {file} 占位，材料摘要逐件绑定。 */
  sourceContextTemplate?: { kind: 'receipt' | 'synthetic'; urlTemplate: string; observedAt: string; protocol?: string;
    fields?: string[]; fields2?: string[]; frequency?: 'day' | 'minute' | 'event' | 'other';
    adjustment?: 'none' | 'qfq' | 'hfq' | 'unknown'; market?: string; basis: string };
}
type ItemState = R1AutoState | 'awaiting_upload' | 'custody';
interface Duplicate { batchId: string; itemId: string }
interface BatchItem extends R1BatchFile {
  itemId: string; entrySha256: string; requestedUrl: string; uploadRequestId: string; autoRequestId: string;
  custodyTaskId: string | null; materialId: string | null; stage: 'awaiting_upload' | 'custody' | 'ready' | 'blocked';
  duplicateOf: Duplicate | null; error: R1AutoView['error'];
  policyAnswers: Record<string, string>;
}
interface BatchRecord {
  selectedKeyReplacement?: true;
  /** 本批冻结的已采用适配；逐件交接都按同一摘要核对。 */
  adapter?: FrozenAdapterBinding;
  input: R1BatchStartInput; inputSha256: string; connection: R1ConnectionIdentity; operator: OperatorContext;
  controlGeneration: number; stopped: boolean; error: R1AutoView['error']; items: BatchItem[];
  createdAt: number; updatedAt: number;
}
export interface R1BatchItemView extends R1BatchFile {
  itemId: string; requestedUrl: string; autoRequestId: string; custodyTaskId: string | null; materialId: string | null;
  state: ItemState; duplicateOf: Duplicate | null; error: R1AutoView['error']; auto: R1AutoView | null;
  policyAnswers: Record<string, string>;
}
export interface R1BatchView {
  batchId: string; source: R1SourceDeclaration; datasetId: string; datePolicy: R1BatchStartInput['datePolicy'] | null;
  sourceValueColumns: string[] | null;
  state: 'awaiting_upload' | 'running' | 'awaiting_answers' | 'recovering' | 'completed' | 'conflicts_pending' | 'stopped' | 'blocked';
  items: R1BatchItemView[]; nextUploadItemId: string | null; error: R1AutoView['error']; duplicateBatch: boolean;
  createdAt: number; updatedAt: number;
}
const yielded = new Set<ItemState>(['associated', 'conflicts_pending', 'awaiting_answers', 'blocked']);
const duplicateErrors = new Set(['R1_BATCH_CONTEXT_CONFLICT', 'R1_BATCH_DUPLICATE_INVALID']);
function fail(code: string, message: string): never { throw new TaskError(code, message); }

/** A manifest and scheduling journal. Original custody, processing and publication retain their existing owners. */
export class R1AutoBatchService {
  readonly chunked: R1ChunkedCsvService;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly uploads = new Map<string, Promise<R1BatchView>>();
  private readonly unsubscribe: (() => void)[] = [];
  private closed = false;
  constructor(private readonly options: {
    database: CoreDatabase; tasks(): TaskService; auto: R1AutoService; materials: MaterialService;
    connection(): R1ConnectionIdentity | null;
    custodyRoot?: string;
    bulk?: ConstructorParameters<typeof R1ChunkedCsvService>[0]['bulk'];
    accept(input: { bytes: Buffer; name: string; category: 'data'; requestId: string }): Promise<string>;
    adapters?: EndpointAdapterRegistry;
  }) {
    this.chunked = new R1ChunkedCsvService(options);
    options.database.migrate('r1-auto-batches', 1, `CREATE TABLE r1_auto_batches (
      batch_id TEXT PRIMARY KEY,input_sha256 TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL,updated_at INTEGER NOT NULL
    ); CREATE TABLE r1_auto_batch_aliases (batch_id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL REFERENCES r1_auto_batches(batch_id));`);
  }
  private get db() { return this.options.database.connection; }
  private needsProgress(record: BatchRecord): boolean {
    if (record.stopped || record.error) return false;
    // 已办结的批次依赖原交接事实；重开或迟到的任务事件不能按今天的连接重写其状态。
    return record.items.some(item => (!item.materialId && !item.duplicateOf) || !this.options.auto.isAssociated(item.autoRequestId));
  }
  attach(): void {
    if (this.closed || this.unsubscribe.length) return;
    this.chunked.attach();
    const resume = (record: BatchRecord) => { if (this.needsProgress(record)) void this.schedule(record.input.batchId); };
    this.unsubscribe.push(this.options.auto.subscribe(requestId => {
      for (const record of this.matching('autoRequestId', requestId)) resume(record);
    }), this.options.tasks().subscribe(({ task, event }) => {
      if (!['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_INTERRUPTED', 'TASK_RECONCILED', 'TASK_CANCELLED', 'TASK_PAUSED'].includes(event.type)) return;
      for (const record of this.matching('custodyTaskId', task.id)) resume(record);
    }));
    for (const record of this.records()) resume(record);
  }
  start(value: unknown, operator: OperatorContext): R1BatchView {
    const input = readStart(value), { batchId, ...scope } = input;
    const digest = wfdSha256(canonicalWfdJson(scope)), previous = this.find(batchId);
    if (previous) {
      if (previous.inputSha256 !== digest) fail('R1_BATCH_CONFLICT', '原批次已冻结清单、来源、用途、数据集及授权，不能覆盖。');
      this.assertReuseContext(previous);
      return { ...this.view(previous), duplicateBatch: true };
    }
    const same = this.db.prepare('SELECT record_json FROM r1_auto_batches WHERE input_sha256=?').get(digest);
    if (same) {
      const original = JSON.parse(String(same.record_json)) as BatchRecord;
      this.assertReuseContext(original);
      this.db.prepare('INSERT INTO r1_auto_batch_aliases VALUES(?,?)').run(batchId, original.input.batchId);
      return { ...this.view(original), duplicateBatch: true };
    }
    this.assertDispatch();
    const connection = this.connection(), now = Date.now();
    // 只接受已采用版本；本批逐件交接都使用同一冻结配置，后续登记变化不改写本批。
    const adapter = input.sourceAdapter
      ? (this.options.adapters ?? fail('R1_ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记，不能按声明式适配交接。')).resolve(input.sourceAdapter)
      : undefined;
    const items: BatchItem[] = [];
    for (const [index, file] of input.files.entries()) {
      const requestedUrl = fileUrl(input.source.requested_url, file.relativePath);
      // 相同原件可复用保管任务；交接还须绑定本批的来源证据。
      const custodySha256 = wfdSha256(canonicalWfdJson({ file, source: { ...input.source, requested_url: requestedUrl },
        datasetId: input.datasetId, datePolicy: input.datePolicy ?? null, sourceValueColumns: input.sourceValueColumns ?? null, connection,
        ...(adapter ? { adapter: { adapterId: adapter.adapterId, version: adapter.version, configDigest: adapter.configDigest } } : {}) }));
      // 旧条目用保管摘要做交接身份。仅当其所属批次的冻结模板与本次一致时沿用。
      const legacy = this.entry(custodySha256);
      const sourceContextTemplate = input.sourceContextTemplate ?? null;
      const reuseLegacy = canonicalWfdJson(legacy?.sourceContextTemplate ?? null) === canonicalWfdJson(sourceContextTemplate);
      const entrySha256 = reuseLegacy ? custodySha256 : wfdSha256(canonicalWfdJson({ custodySha256, sourceContextTemplate }));
      const local = items.find(item => item.entrySha256 === entrySha256), known = reuseLegacy ? legacy : this.entry(entrySha256);
      items.push({ ...file, entrySha256, requestedUrl, itemId: `item-${index + 1}`,
        uploadRequestId: `batch-upload:${custodySha256}`, autoRequestId: `batch-auto:${entrySha256}`,
        custodyTaskId: null, materialId: null, stage: 'awaiting_upload', error: null, policyAnswers: {},
        duplicateOf: local ? local.duplicateOf ?? { batchId, itemId: local.itemId } : known ? { batchId: known.batchId, itemId: known.item.itemId } : null });
    }
    const record: BatchRecord = { ...(adapter ? { adapter } : {}), input, inputSha256: digest, connection, operator,
      controlGeneration: this.options.tasks().getControl().generation, stopped: false, error: null, items, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO r1_auto_batches VALUES(?,?,?,?)').run(batchId, digest, canonicalWfdJson(record), now);
    void this.schedule(batchId);
    return this.view(record);
  }
  list(): R1BatchView[] { return this.records(20).map(record => this.view(record)); }
  get(batchId: string): R1BatchView { return this.view(this.require(batchId)); }
  async upload(batchId: string, itemId: string, bytes: Buffer): Promise<R1BatchView> {
    const record = this.require(batchId), item = record.items.find(entry => entry.itemId === itemId) ?? fail('R1_BATCH_ITEM_NOT_FOUND', '没有该批次清单项。');
    if (!Buffer.isBuffer(bytes) || bytes.length !== item.byteLength || wfdSha256(bytes) !== item.sha256) fail('R1_BATCH_FILE_CHANGED', '上传字节与本批次冻结的文件摘要或长度不符，原清单保留。');
    this.assertReuseContext(record);
    this.assertCurrent(record);
    if (item.duplicateOf) {
      const original = this.original(record, item);
      await this.upload(original.batchId, original.item.itemId, bytes);
      return this.get(batchId);
    }
    if (item.custodyTaskId) { void this.schedule(batchId); return this.get(batchId); }
    if (this.view(record).nextUploadItemId !== itemId) fail('R1_BATCH_ORDER', '本批次上一件尚在保管、交接或核对原结果，请按原清单依次继续。');
    const key = `${batchId}:${itemId}`, existing = this.uploads.get(key);
    if (existing) return existing;
    const work = (async () => {
      const taskId = await this.options.accept({ bytes, name: item.name, category: 'data', requestId: item.uploadRequestId });
      // Re-read after asynchronous custody: another item or a task event may have updated this journal.
      const latest = this.require(batchId), current = latest.items.find(entry => entry.itemId === itemId)!;
      current.custodyTaskId = taskId; current.stage = 'custody'; this.save(latest);
      const task = this.options.tasks().get(taskId);
      if (task.status === 'ready') this.options.tasks().start(task.id, task.version);
      await this.schedule(batchId);
      return this.get(batchId);
    })().finally(() => this.uploads.delete(key));
    this.uploads.set(key, work); return work;
  }
  async advance(batchId: string): Promise<R1BatchView> {
    const record = this.require(batchId); this.assertReuseContext(record); this.assertDispatch(); this.assertConnection(record);
    record.controlGeneration = this.options.tasks().getControl().generation; record.stopped = false; record.error = null; this.save(record);
    for (const item of this.view(record).items) {
      if (item.auto && ['recovering', 'stopped'].includes(item.auto.state)) await this.options.auto.advance(item.autoRequestId);
      else if (item.custodyTaskId && !item.materialId) {
        const task = this.options.tasks().get(item.custodyTaskId);
        if (task.status === 'ready') this.options.tasks().start(task.id, task.version);
        else if (['paused', 'interrupted'].includes(task.status)) {
          const latest = this.require(batchId), current = latest.items.find(entry => entry.itemId === item.itemId)!;
          current.stage = 'custody'; current.error = null; this.save(latest);
          this.options.tasks().resume(task.id, task.version);
        }
      }
    }
    await this.schedule(batchId); return this.get(batchId);
  }
  async dispose(): Promise<void> {
    this.closed = true; this.unsubscribe.splice(0).forEach(unsubscribe => unsubscribe()); this.dirty.clear();
    await Promise.allSettled([...this.pending.values(), ...this.uploads.values()]);
    await this.chunked.dispose();
  }
  private schedule(batchId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const previous = this.pending.get(batchId);
    if (previous) { this.dirty.add(batchId); return previous; }
    const work = Promise.resolve().then(async () => {
      do { this.dirty.delete(batchId); await this.progress(batchId); } while (!this.closed && this.dirty.has(batchId));
    }).catch(error => {
      if (this.closed) return;
      const record = this.require(batchId); record.error = errorView(error);
      if (/STOPPED|SERVICE_CLOSED/u.test(record.error.code)) record.stopped = true;
      this.save(record);
    }).finally(() => { this.pending.delete(batchId); if (!this.closed && this.dirty.has(batchId)) void this.schedule(batchId); });
    this.pending.set(batchId, work); return work;
  }
  /** 逐件回执上下文：只替换文件占位与材料摘要，其余声明原样进入核对。 */
  private sourceContextFor(record: BatchRecord, item: BatchItem) {
    const template = record.input.sourceContextTemplate!;
    if (!template.urlTemplate.includes('{file}')) fail('R1_BATCH_CONTEXT', '来源回执地址模板须包含 {file} 占位。');
    return { kind: template.kind, url: template.urlTemplate.replaceAll('{file}', encodeURIComponent(item.relativePath)),
      materialSha256: item.sha256, observedAt: template.observedAt, basis: template.basis,
      ...(template.protocol ? { protocol: template.protocol } : {}), ...(template.fields ? { fields: template.fields } : {}),
      ...(template.fields2 ? { fields2: template.fields2 } : {}), ...(template.frequency ? { frequency: template.frequency } : {}),
      ...(template.adjustment ? { adjustment: template.adjustment } : {}), ...(template.market ? { market: template.market } : {}) };
  }

  private async progress(batchId: string): Promise<void> {
    const record = this.require(batchId);
    if (!this.needsProgress(record)) return;
    try { this.assertReuseContext(record); }
    catch (error) {
      if (error instanceof TaskError && duplicateErrors.has(error.code)) return; // 历史坏链在读视图中报告。
      throw error;
    }
    this.assertCurrent(record);
    for (const item of record.items) {
      if (item.duplicateOf) continue;
      // Cover custody accepted before this journal could bind the task. The material
      // service owns the stable request lookup; no second file or request is created.
      if (item.stage === 'awaiting_upload') {
        const accepted = this.options.materials.requestTask(item.uploadRequestId);
        if (accepted) { item.custodyTaskId = accepted.id; item.stage = 'custody'; this.save(record); }
      }
      if (item.stage === 'custody' && item.custodyTaskId) {
        const task = this.options.tasks().get(item.custodyTaskId);
        if (task.status === 'succeeded') {
          const material = this.options.materials.getByTask(task.id) ?? fail('R1_BATCH_MATERIAL_MISSING', '原保管任务成功但没有对应材料，保留原任务核对。');
          if (material.envelope.sha256 !== item.sha256 || material.envelope.byteLength !== item.byteLength) fail('R1_BATCH_FILE_CHANGED', '原保管任务的材料与批清单不一致。');
          item.materialId = material.envelope.materialId; item.stage = 'ready'; this.save(record);
        } else if (['failed', 'cancelled', 'blocked', 'needs_review', 'interrupted', 'paused'].includes(task.status)) {
          item.stage = 'blocked'; item.error = { code: task.error?.code ?? 'R1_BATCH_CUSTODY_BLOCKED', message: task.error?.message ?? '原保管任务未完成，请按原任务核对。' }; this.save(record);
        } else return;
      }
      if (item.stage === 'ready' && item.materialId) {
        let auto: R1AutoView;
        try {
          const start = record.selectedKeyReplacement ? this.options.auto.startReplacing.bind(this.options.auto) : this.options.auto.start.bind(this.options.auto);
          auto = start({ requestId: item.autoRequestId, materialId: item.materialId,
            source: { ...record.input.source, requested_url: item.requestedUrl }, datasetId: record.input.datasetId,
            ...(record.input.sourceValueColumns ? { sourceValueColumns: record.input.sourceValueColumns } : {}),
            ...(record.input.sourceAdapter ? { sourceAdapter: record.input.sourceAdapter } : {}),
            ...(record.input.sourceContextTemplate ? { sourceContext: this.sourceContextFor(record, item) } : {}) }, record.operator);
          // This opt-in declares the scope of the selected batch. The recognizer must
          // independently identify a source trade-date question; generic dates are never answered here.
          if (record.input.datePolicy === 'a_share_calendar_day_asia_shanghai' && auto.state === 'awaiting_answers'
            && auto.questions.some(question => question.key === 'source_trade_date_timezone')) {
            auto = this.options.auto.answer(item.autoRequestId, { answers: { source_trade_date_timezone: 'Asia/Shanghai' } }, record.operator);
            item.policyAnswers.source_trade_date_timezone = 'Asia/Shanghai'; this.save(record);
          }
        } catch (error) {
          if (error instanceof TaskError && error.code === 'R1_AUTO_BUSY') return;
          item.stage = 'blocked'; item.error = errorView(error); this.save(record); continue;
        }
        if (!yielded.has(auto.state)) return;
      }
      if (item.stage === 'awaiting_upload') return;
    }
  }
  private itemView(item: BatchItem, record: BatchRecord): R1BatchItemView {
    let original = item, referenceError: R1AutoView['error'] = null;
    if (item.duplicateOf) {
      try { original = this.original(record, item).item; }
      catch (error) {
        if (!(error instanceof TaskError && duplicateErrors.has(error.code))) throw error;
        referenceError = errorView(error);
      }
    }
    let auto: R1AutoView | null = null;
    if (!referenceError && original.materialId) {
      try { auto = this.options.auto.get(original.autoRequestId); }
      catch (error) { if (!(error instanceof TaskError && error.code === 'R1_AUTO_NOT_FOUND')) throw error; }
    }
    return { name: item.name, relativePath: item.relativePath, sha256: item.sha256, byteLength: item.byteLength,
      itemId: item.itemId, requestedUrl: item.requestedUrl, autoRequestId: original.autoRequestId,
      custodyTaskId: original.custodyTaskId, materialId: original.materialId,
      state: referenceError ? 'blocked' : auto?.state ?? (original.stage === 'ready' ? 'inspecting' : original.stage), duplicateOf: item.duplicateOf,
      error: referenceError ?? auto?.error ?? original.error, auto, policyAnswers: original.policyAnswers };
  }
  private view(record: BatchRecord): R1BatchView {
    const items = record.items.map(item => this.itemView(item, record));
    const first = items.find(item => !yielded.has(item.state));
    const error = record.error ?? items.find(item => item.error && duplicateErrors.has(item.error.code))?.error ?? null;
    const nextUploadItemId = !record.stopped && !error && first?.state === 'awaiting_upload' ? first.itemId : null;
    const state: R1BatchView['state'] = record.stopped ? 'stopped' : error ? 'blocked'
      : items.some(item => item.state === 'recovering') ? 'recovering' : first?.state === 'stopped' ? 'stopped'
      : first?.state === 'awaiting_upload' ? 'awaiting_upload' : first ? 'running'
      : items.some(item => item.state === 'awaiting_answers') ? 'awaiting_answers'
      : items.some(item => item.state === 'conflicts_pending') ? 'conflicts_pending'
      : items.some(item => item.state === 'blocked') ? 'blocked'
      : 'completed';
    return { batchId: record.input.batchId, source: record.input.source, datasetId: record.input.datasetId,
      datePolicy: record.input.datePolicy ?? null, state, items, nextUploadItemId, error, duplicateBatch: false,
      sourceValueColumns: record.input.sourceValueColumns ?? null,
      createdAt: record.createdAt, updatedAt: Math.max(record.updatedAt, ...items.map(item => item.auto?.updatedAt ?? 0)) };
  }
  private assertDispatch(): void { if (this.closed || this.options.tasks().getControl().stopped) fail('BD_STOPPED', '服务已停止，请保留原批次并明确继续。'); }
  private connection(): R1ConnectionIdentity { return this.options.connection() ?? fail('R1_NOT_CONFIGURED', '批量交接需要已装配的 data_only 连接。'); }
  private assertConnection(record: BatchRecord): void { if (canonicalWfdJson(record.connection) !== canonicalWfdJson(this.connection())) fail('R1_BATCH_CONNECTION_CHANGED', '当前连接或实现与本批冻结身份不同，未换连接继续。'); }
  private assertCurrent(record: BatchRecord): void {
    this.assertDispatch(); this.assertConnection(record);
    if (record.controlGeneration !== this.options.tasks().getControl().generation) fail('BD_STOPPED', '批次接受后停止代次已变化，请明确继续原批次。');
    if (!record.adapter) return;
    const current = (this.options.adapters ?? fail('R1_ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记。'))
      .resolve({ adapterId: record.adapter.adapterId, version: record.adapter.version, configDigest: record.adapter.configDigest });
    if (canonicalWfdJson(current) !== canonicalWfdJson(record.adapter)) fail('R1_BATCH_ADAPTER_CHANGED', '本批冻结的适配配置已变化；未换配置继续原批次。');
  }
  private save(record: BatchRecord): void { record.updatedAt = Date.now(); this.db.prepare('UPDATE r1_auto_batches SET record_json=?,updated_at=? WHERE batch_id=?').run(canonicalWfdJson(record), record.updatedAt, record.input.batchId); }
  private records(limit?: number): BatchRecord[] { return this.db.prepare(`SELECT record_json FROM r1_auto_batches ORDER BY updated_at DESC,rowid DESC ${limit ? 'LIMIT ?' : ''}`).all(...(limit ? [limit] : [])).map(row => JSON.parse(String(row.record_json)) as BatchRecord); }
  private matching(key: 'autoRequestId' | 'custodyTaskId', value: string): BatchRecord[] {
    return this.db.prepare(`SELECT record_json FROM r1_auto_batches
      WHERE EXISTS (SELECT 1 FROM json_each(record_json,'$.items') WHERE json_extract(value,'$.${key}')=?)`)
      .all(value).map(row => JSON.parse(String(row.record_json)) as BatchRecord);
  }
  private entry(sha256: string): { batchId: string; item: BatchItem; sourceContextTemplate?: R1BatchStartInput['sourceContextTemplate'] } | null {
    const row = this.db.prepare(`SELECT record_json FROM r1_auto_batches WHERE EXISTS (SELECT 1 FROM json_each(record_json,'$.items')
      WHERE json_extract(value,'$.entrySha256')=? AND json_extract(value,'$.duplicateOf') IS NULL) ORDER BY rowid LIMIT 1`).get(sha256);
    if (!row) return null;
    const record = JSON.parse(String(row.record_json)) as BatchRecord;
    const item = record.items.find(entry => entry.entrySha256 === sha256 && !entry.duplicateOf)!;
    return { batchId: record.input.batchId, item, sourceContextTemplate: record.input.sourceContextTemplate };
  }
  private assertReuseContext(record: BatchRecord): void {
    for (const item of record.items) if (item.duplicateOf) this.original(record, item);
  }
  private original(record: BatchRecord, item: BatchItem): { batchId: string; item: BatchItem } {
    // 老批次可能保留多跳引用。每次跨批都核冻结的来源条件，只沿真实原项读取。
    const context = canonicalWfdJson(record.input.sourceContextTemplate ?? null);
    const visited = new Set<string>();
    while (item.duplicateOf) {
      const { batchId, itemId } = item.duplicateOf;
      const key = batchId + '/' + itemId;
      if (visited.has(key)) fail('R1_BATCH_DUPLICATE_INVALID', '重复项引用成环，无法核对原交接。');
      visited.add(key);
      if (batchId !== record.input.batchId) {
        record = this.find(batchId) ?? fail('R1_BATCH_DUPLICATE_INVALID', '重复项引用的原批次缺失。');
        if (canonicalWfdJson(record.input.sourceContextTemplate ?? null) !== context)
          fail('R1_BATCH_CONTEXT_CONFLICT', '已有批次的重复项来源模板不一致，请核对原交接；未复用旧结果。');
      }
      item = record.items.find(entry => entry.itemId === itemId) ?? fail('R1_BATCH_DUPLICATE_INVALID', '重复项引用的原条目缺失。');
    }
    return { batchId: record.input.batchId, item };
  }
  private find(batchId: string): BatchRecord | null { id(batchId); const row = this.db.prepare('SELECT record_json FROM r1_auto_batches WHERE batch_id=COALESCE((SELECT canonical_id FROM r1_auto_batch_aliases WHERE batch_id=?),?)').get(batchId, batchId); return row ? JSON.parse(String(row.record_json)) as BatchRecord : null; }
  private require(batchId: string): BatchRecord { return this.find(batchId) ?? fail('R1_BATCH_NOT_FOUND', '没有该批次的持久记录。'); }
}

function readContextTemplate(value: unknown): NonNullable<R1BatchStartInput['sourceContextTemplate']> {
  if (!isWfdRecord(value)) throw new TaskError('R1_BATCH_CONTEXT', '来源回执模板须为明确对象。');
  const allowed = ['kind', 'urlTemplate', 'observedAt', 'protocol', 'fields', 'fields2', 'frequency', 'adjustment', 'market', 'basis'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TaskError('R1_BATCH_CONTEXT', '来源回执模板含未声明字段。');
  if (value.kind !== 'receipt' && value.kind !== 'synthetic') throw new TaskError('R1_BATCH_CONTEXT', '来源回执模板须明确 receipt 或 synthetic。');
  if (typeof value.urlTemplate !== 'string' || !/^https?:\/\//u.test(value.urlTemplate) || !value.urlTemplate.includes('{file}'))
    throw new TaskError('R1_BATCH_CONTEXT', '来源回执地址模板须为 http(s) 且含 {file} 占位。');
  if (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)))
    throw new TaskError('R1_BATCH_CONTEXT', '来源回执模板须提供明确取得时间。');
  if (typeof value.basis !== 'string' || value.basis.trim().length < 8 || value.basis.length > 1000)
    throw new TaskError('R1_BATCH_CONTEXT', '来源回执模板须说明依据；合成样本必须如实标注。');
  return structuredClone(value) as NonNullable<R1BatchStartInput['sourceContextTemplate']>;
}
function readStart(value: unknown): R1BatchStartInput {
  const body = object(value, ['batchId', 'source', 'datasetId', 'files', 'datePolicy', 'sourceValueColumns', 'sourceAdapter', 'sourceContextTemplate']); id(body.batchId); id(body.datasetId);
  const source = object(body.source, ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope', 'authorization', 'license']);
  assertKnownR1Source(source as unknown as R1SourceDeclaration);
  const requested = parseR1Utc(String(source.requested_at_utc)), acquired = parseR1Utc(String(source.acquired_at_utc));
  if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested) fail('R1_SOURCE_TIME', '本批来源需要有效的 UTC 请求和取得时间。');
  if (body.datePolicy !== undefined && body.datePolicy !== 'a_share_calendar_day_asia_shanghai') fail('R1_BATCH_INPUT', '批次日期声明不在受支持范围。');
  const selected = body.sourceValueColumns;
  if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.length > 256
    || selected.some(name => typeof name !== 'string' || !name.trim() || name.length > 256 || /[\u0000-\u001f]/u.test(name))
    || new Set(selected).size !== selected.length)) fail('R1_BATCH_SOURCE_COLUMNS', '本批选列需要 1 至 256 个不重复的实际原列名，留空时交接全表。');
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > R1_BATCH_MAX_FILES) fail('R1_BATCH_FILE_BUDGET', `本批需要 1 至 ${R1_BATCH_MAX_FILES} 个明确选定的文件。`);
  const files = body.files.map(value => {
    const file = object(value, ['name', 'relativePath', 'sha256', 'byteLength']);
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512 || /[/\\\u0000-\u001f\u007f]/u.test(file.name)
      || ['.', '..'].includes(file.name) || typeof file.relativePath !== 'string' || !file.relativePath || file.relativePath.length > 2048
      || /[\\:\u0000-\u001f\u007f]/u.test(file.relativePath) || file.relativePath.split('/').some(part => !part || part === '.' || part === '..')
      || file.relativePath.split('/').at(-1) !== file.name || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.byteLength) || Number(file.byteLength) < 1 || Number(file.byteLength) > MATERIAL_UPLOAD_LIMIT) fail('R1_BATCH_FILE', `每项需要实际文件名、来源系列内相对位置、摘要和 ${MATERIAL_UPLOAD_LIMIT / 1024 / 1024} MiB 内非空字节长度。`);
    fileUrl(String(source.requested_url), file.relativePath);
    return file as unknown as R1BatchFile;
  });
  const positions = new Map<string, string>();
  for (const file of files) {
    const previous = positions.get(file.relativePath);
    if (previous && previous !== file.sha256) fail('R1_BATCH_SOURCE_PATH_CONFLICT', '不同字节不能共用本批同一来源位置。请保留实际子目录，或按不同来源系列分批选择。');
    positions.set(file.relativePath, file.sha256);
  }
  if (files.reduce((total, file) => total + file.byteLength, 0) > R1_BATCH_MAX_BYTES) fail('R1_BATCH_BYTE_BUDGET', `本批清单总量不能超过 ${R1_BATCH_MAX_BYTES / 1024 / 1024} MiB。`);
  return structuredClone({ batchId: body.batchId, source: source as unknown as R1SourceDeclaration, datasetId: body.datasetId,
    files, ...(body.datePolicy ? { datePolicy: body.datePolicy } : {}), ...(selected ? { sourceValueColumns: [...selected as string[]].sort() } : {}),
    ...(body.sourceAdapter === undefined ? {} : { sourceAdapter: readAdapterBindingRef(body.sourceAdapter) }),
    ...(body.sourceContextTemplate === undefined ? {} : { sourceContextTemplate: readContextTemplate(body.sourceContextTemplate) }) }) as R1BatchStartInput;
}
function fileUrl(series: string, path: string): string {
  let base: URL; try { base = new URL(series); } catch { return fail('R1_BATCH_SOURCE_SERIES', '请明确提供来源系列的绝对地址或 file URI（文件资源标识）。'); }
  if (base.search || base.hash || ['blob:', 'data:', 'javascript:'].includes(base.protocol)) fail('R1_BATCH_SOURCE_SERIES', '来源系列地址不能含查询、片段或临时内容地址。');
  return `${base.href.replace(/\/?$/u, '/')}${path.split('/').map(encodeURIComponent).join('/')}`;
}
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail('R1_BATCH_INPUT', '批次只接受明确清单和声明，不能覆盖连接、目标或权限。'); return value; }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(value)) fail('R1_BATCH_INPUT', '批次需要稳定编号。'); }
function errorView(error: unknown): { code: string; message: string } { return { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'R1_BATCH_FAILED', message: error instanceof Error ? error.message : String(error) }; }

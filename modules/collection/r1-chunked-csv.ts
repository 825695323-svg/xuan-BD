import { setImmediate as yieldNow } from 'node:timers/promises';
import { statfsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { R1ConnectionIdentity, R1SourceDeclaration, R1RowSummary } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TEMPORARY_RETENTION_DAYS } from '../../platform/resources/temporary-retention.js';
import type { OperatorContext } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import { candidateCsvRecords } from './candidate-csv-records.js';
import { assertKnownR1Source, parseR1Utc } from './r1-structured-handoff.js';
import type { R1AutoService, R1AutoView } from './r1-auto.js';
import { isR1BulkMode, type R1BulkMode, type R1TabularBulkService, type R1TabularBulkStatus } from './r1-source-minute-bulk-service.js';
import { sourceReportedCode } from './source-reported-table.js';

export const R1_CHUNKED_CSV_LIMITS = Object.freeze({ chunkBytes: 2 * 1024 * 1024, originalBytes: 256 * 1024 * 1024,
  pageBytes: 256 * 1024, pageRows: 200, maxPackedRows: 5000, documentBytes: 768 * 1024, documentReserveBytes: 32 * 1024,
  minFreeBytes: 4 * 1024 * 1024 * 1024, columns: 64, cellCharacters: 10000 });
export interface R1ChunkedCsvStart {
  intakeId: string; name: string; sha256: string; byteLength: number;
  source: R1SourceDeclaration; datasetId: string; datePolicy?: 'a_share_calendar_day_asia_shanghai'; sourceValueColumns?: string[];
}
interface IntakeRecord {
  input: R1ChunkedCsvStart; connection: R1ConnectionIdentity; operator: OperatorContext;
  generation: number; receivedBytes: number; custodyTaskId: string | null; materialId: string | null;
  parsed: boolean; totalRows: number; totalPages: number; activePage: number; publishedRows: number;
  state: 'receiving' | 'custody' | 'parsing' | 'publishing' | 'awaiting_answers' | 'recovering' | 'completed' | 'conflicts_pending' | 'blocked' | 'stopped';
  rowSummary?: R1RowSummary;
  error: { code: string; message: string } | null; createdAt: number; updatedAt: number;
}
export interface R1CsvRowLocation { byteStart: number; byteEnd: number; lineStart: number; lineEnd: number; sourceRow: number }
export interface R1ChunkedCsvPage {
  ordinal: number; rowStart: number; rowEnd: number; byteStart: number; byteEnd: number; sha256: string; byteLength: number;
  locations: R1CsvRowLocation[];
  documentBudget?: { maxBytes: number; conservativeRowBytes: number; reservedBytes: number };
  custodyTaskId: string | null; materialId: string | null; autoRequestId: string; auto: R1AutoView | null;
}
export interface R1ChunkedCsvView {
  intakeId: string; name: string; sha256: string; byteLength: number; source: R1SourceDeclaration; datasetId: string;
  state: IntakeRecord['state']; receivedBytes: number; chunkBytes: number; custodyTaskId: string | null; materialId: string | null;
  parsed: boolean; totalRows: number; totalPages: number; publishedPages: number; publishedRows: number;
  rowSummary: R1RowSummary | null; processedPages: number; processedRows: number;
  conflictPages: { ordinal: number; rowStart: number; rowEnd: number; autoRequestId: string; conflictCount: number }[];
  mode?: R1BulkMode; bulk?: R1TabularBulkStatus;
  activePage: R1ChunkedCsvPage | null; error: IntakeRecord['error']; createdAt: number; updatedAt: number;
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
const errorView = (error: unknown) => ({ code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'R1_CSV_FAILED',
  message: error instanceof Error ? error.message : String(error) });

/** The original remains a material; this journal owns only transport chunks, exact parse ranges and page continuations. */
export class R1ChunkedCsvService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly unsubscribe: (() => void)[] = [];
  private closed = false;
  private retentionTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; materials: MaterialService; auto: R1AutoService;
    connection(): R1ConnectionIdentity | null;
    custodyRoot?: string;
    bulk?: R1TabularBulkService;
    accept(input: { bytes: Buffer; name: string; category: 'data'; requestId: string }): Promise<string> }) {
    options.database.migrate('r1-chunked-csv', 1, `CREATE TABLE r1_csv_intakes (
      intake_id TEXT PRIMARY KEY,input_sha256 TEXT NOT NULL,record_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE r1_csv_upload_chunks (intake_id TEXT NOT NULL REFERENCES r1_csv_intakes(intake_id),
        byte_offset INTEGER NOT NULL,sha256 TEXT NOT NULL,chunk_bytes BLOB NOT NULL,PRIMARY KEY(intake_id,byte_offset));
      CREATE TABLE r1_csv_pages (intake_id TEXT NOT NULL REFERENCES r1_csv_intakes(intake_id),ordinal INTEGER NOT NULL,
        page_json TEXT NOT NULL,page_bytes BLOB NOT NULL,PRIMARY KEY(intake_id,ordinal));`);
    options.database.migrate('r1-csv-transport-retention', 1, `CREATE TABLE r1_csv_transport_retention (
      intake_id TEXT PRIMARY KEY REFERENCES r1_csv_intakes(intake_id), material_id TEXT NOT NULL, original_sha256 TEXT NOT NULL,
      released_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, removed_at INTEGER);`);
  }
  private get db() { return this.options.database.connection; }
  attach(): void {
    if (this.unsubscribe.length || this.closed) return;
    const notify = () => { for (const record of this.records()) if (!['receiving','completed','conflicts_pending','blocked','stopped'].includes(record.state)) void this.schedule(record.input.intakeId); };
    this.unsubscribe.push(this.options.auto.subscribe(notify), this.options.tasks().subscribe(({ event }) => {
      if (['TASK_SUCCEEDED','TASK_FAILED','TASK_INTERRUPTED','TASK_PAUSED','TASK_CANCELLED','TASK_RECONCILED'].includes(event.type)) notify();
    })); notify();
    this.sweepTemporaryChunks();
    this.retentionTimer = setInterval(() => this.sweepTemporaryChunks(), 60 * 60 * 1000); this.retentionTimer.unref();
  }
  private hasBulk(intakeId: string): boolean {
    if (this.options.bulk) return this.options.bulk.has(intakeId);
    const hasTable = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='r1_source_minute_bulk'").get();
    return !!(hasTable && this.db.prepare('SELECT 1 FROM r1_source_minute_bulk WHERE intake_id=?').get(intakeId));
  }
  private requireBulk() {
    return this.options.bulk ?? fail('R1_BULK_UNAVAILABLE', '批量接收需要已采用的 bulk_csv 受管目录、处理和 WFD 连接。');
  }
  async startAny(value: unknown, operator: OperatorContext): Promise<R1ChunkedCsvView> {
    if (isWfdRecord(value) && isR1BulkMode(value.mode)) return this.requireBulk().start(value, operator);
    return this.start(value, operator);
  }
  commit(intakeId: string, manifestDigest: unknown): Promise<R1ChunkedCsvView> {
    return this.requireBulk().commit(intakeId, manifestDigest);
  }
  readBulkPage(intakeId: string, input: unknown) { return this.requireBulk().readPage(intakeId, input); }
  reclaim(intakeId: string): Promise<R1ChunkedCsvView> { return this.requireBulk().reclaim(intakeId); }
  start(value: unknown, operator: OperatorContext): R1ChunkedCsvView {
    if (!isWfdRecord(value) || Object.keys(value).some(name => !['intakeId','name','sha256','byteLength','source','datasetId','datePolicy','sourceValueColumns'].includes(name))
      || !key(value.intakeId) || !key(value.datasetId) || typeof value.name !== 'string' || !/\.csv$/iu.test(value.name)
      || value.name.length > 512 || /[/\\\u0000-\u001f\u007f]/u.test(value.name) || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1
      || Number(value.byteLength) > R1_CHUNKED_CSV_LIMITS.originalBytes
      || value.datePolicy !== undefined && value.datePolicy !== 'a_share_calendar_day_asia_shanghai')
      fail('R1_CSV_MANIFEST', '分块接收需要原 CSV 名称、完整摘要、1–256 MiB 字节长度、来源及数据集。');
    assertKnownR1Source(value.source as unknown as R1SourceDeclaration);
    const source = value.source as unknown as R1SourceDeclaration;
    if (!Number.isFinite(parseR1Utc(source.requested_at_utc)) || !Number.isFinite(parseR1Utc(source.acquired_at_utc))
      || parseR1Utc(source.acquired_at_utc) < parseR1Utc(source.requested_at_utc))
      fail('R1_SOURCE_TIME', '来源请求和取得时间需要有效的 UTC（协调世界时）时间。');
    if (value.sourceValueColumns !== undefined && (!Array.isArray(value.sourceValueColumns) || !value.sourceValueColumns.length
      || value.sourceValueColumns.length > 64 || value.sourceValueColumns.some(column => typeof column !== 'string' || !column || column.length > 256)
      || new Set(value.sourceValueColumns).size !== value.sourceValueColumns.length)) fail('R1_CSV_COLUMNS', '选列必须是明确且不重复的原列名。');
    const input = structuredClone(value) as unknown as R1ChunkedCsvStart;
    if (this.hasBulk(input.intakeId) || this.options.bulk?.isStarting(input.intakeId)) fail('R1_CSV_CONFLICT', '该接收编号已用于原报分钟批量模式。');
    const digest = wfdSha256(canonicalWfdJson(input)), previous = this.db.prepare('SELECT input_sha256 FROM r1_csv_intakes WHERE intake_id=?').get(input.intakeId);
    if (previous) { if (previous.input_sha256 !== digest) fail('R1_CSV_CONFLICT', '原分块接收清单和来源已冻结，不能覆盖。'); return this.get(input.intakeId); }
    this.assertDispatch(); const connection = this.options.connection() ?? fail('R1_NOT_CONFIGURED', '分块交接需要已装配的数据库连接。');
    const now = Date.now(), record: IntakeRecord = { input, connection, operator, generation: this.options.tasks().getControl().generation,
      receivedBytes: 0, custodyTaskId: null, materialId: null, parsed: false, totalRows: 0, totalPages: 0, activePage: 0,
      publishedRows: 0, rowSummary: { inserted: 0, duplicate_skipped: 0, conflict_pending: 0 }, state: 'receiving', error: null, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO r1_csv_intakes VALUES(?,?,?,?)').run(input.intakeId, digest, canonicalWfdJson(record), now);
    return this.get(input.intakeId);
  }
  list(): R1ChunkedCsvView[] {
    const legacy = this.records().slice(0, 20).map(record => this.get(record.input.intakeId));
    if (!this.options.bulk) return legacy;
    return [...legacy, ...this.options.bulk.list()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  }
  get(intakeId: string): R1ChunkedCsvView {
    if (this.hasBulk(intakeId)) return this.requireBulk().get(intakeId);
    const record = this.require(intakeId);
    return { intakeId, name: record.input.name, sha256: record.input.sha256, byteLength: record.input.byteLength, source: record.input.source,
      datasetId: record.input.datasetId, state: record.state, receivedBytes: record.receivedBytes, chunkBytes: R1_CHUNKED_CSV_LIMITS.chunkBytes,
      custodyTaskId: record.custodyTaskId, materialId: record.materialId, parsed: record.parsed, totalRows: record.totalRows,
      totalPages: record.totalPages, publishedPages: record.activePage, publishedRows: record.publishedRows,
      rowSummary: record.rowSummary ?? null, processedPages: record.activePage,
      processedRows: record.rowSummary ? Object.values(record.rowSummary).reduce((total,n) => total+n,0) : record.publishedRows,
      conflictPages: this.db.prepare('SELECT ordinal,page_json FROM r1_csv_pages WHERE intake_id=? ORDER BY ordinal').all(intakeId).flatMap(row => {
        const page = JSON.parse(String(row.page_json)) as R1ChunkedCsvPage, auto = this.readAuto(page.autoRequestId);
        return auto?.state === 'conflicts_pending' ? [{ ordinal: page.ordinal, rowStart: page.rowStart, rowEnd: page.rowEnd, autoRequestId: page.autoRequestId, conflictCount: auto.currentRequest?.rowSummary?.conflict_pending ?? 0 }] : [];
      }),
      activePage: record.parsed && record.activePage < record.totalPages ? this.page(intakeId, record.activePage) : null,
      error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  upload(intakeId: string, offset: number, bytes: Buffer, digest?: string): R1ChunkedCsvView {
    if (this.hasBulk(intakeId)) return this.requireBulk().upload(intakeId, offset, bytes, digest);    const record = this.require(intakeId); this.assertCurrent(record);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(bytes) || !bytes.length
      || bytes.length > R1_CHUNKED_CSV_LIMITS.chunkBytes || offset + bytes.length > record.input.byteLength)
      fail('R1_CSV_CHUNK', '分块必须提供原字节偏移和不超过 2 MiB 的非空原字节。');
    const sha256 = wfdSha256(bytes), previous = this.db.prepare('SELECT sha256,length(chunk_bytes) AS n FROM r1_csv_upload_chunks WHERE intake_id=? AND byte_offset=?').get(intakeId, offset);
    if (previous) {
      if (previous.sha256 !== sha256 || previous.n !== bytes.length) fail('R1_CSV_CHUNK_CONFLICT', '原位置的已接收分块字节不同，不能覆盖。');
      return this.get(intakeId);
    }
    if (record.state !== 'receiving' || offset !== record.receivedBytes) fail('R1_CSV_CHUNK_ORDER', '请从已确认接收的原偏移继续；不接受缺口或交叠。');
    this.options.database.transaction(() => {
      this.db.prepare('INSERT INTO r1_csv_upload_chunks VALUES(?,?,?,?)').run(intakeId, offset, sha256, bytes);
      record.receivedBytes += bytes.length; this.save(record);
    }); return this.get(intakeId);
  }
  async advance(intakeId: string): Promise<R1ChunkedCsvView> {
    if (this.hasBulk(intakeId)) return this.requireBulk().advance(intakeId);    const record = this.require(intakeId); this.assertDispatch(); this.assertConnection(record);
    if (record.state === 'completed' || record.state === 'conflicts_pending') return this.get(intakeId);
    if (record.receivedBytes !== record.input.byteLength) fail('R1_CSV_INCOMPLETE', '完整原件尚有字节缺口，未保管、解析或发布。');
    record.generation = this.options.tasks().getControl().generation;
    record.error = null; record.state = record.parsed ? 'publishing' : 'custody'; this.save(record);
    if (record.custodyTaskId && !record.materialId) this.resumeCustody(record.custodyTaskId);
    if (record.parsed && record.activePage < record.totalPages) {
      const page = this.page(intakeId, record.activePage);
      if (page.auto && ['recovering','stopped'].includes(page.auto.state)) await this.options.auto.advance(page.autoRequestId);
      else if (page.custodyTaskId && !page.materialId) this.resumeCustody(page.custodyTaskId);
    }
    void this.schedule(intakeId); return this.get(intakeId);
  }
  resumeAccepted(intakeId:string,confirmationDigest:string):R1ChunkedCsvView {
    const record=this.require(intakeId);this.assertCurrent(record);
    if(!record.parsed||record.activePage>=record.totalPages)fail('R1_CSV_PAGE','当前没有待续办的原页。');
    const page=this.page(intakeId,record.activePage);
    if(!page.auto?.currentRequest||page.auto.currentRequest.documentSha256!==confirmationDigest)
      fail('R1_ORIGINAL_CONFIRMATION','续办摘要与当前原页文档不同。');
    this.options.auto.resumeAccepted(page.autoRequestId,'csv-original-'+wfdSha256(canonicalWfdJson([intakeId,page.ordinal,confirmationDigest])).slice(0,40),confirmationDigest);
    record.state='recovering';record.error=null;this.save(record);return this.get(intakeId);
  }
  page(intakeId: string, ordinal: number): R1ChunkedCsvPage {
    if (this.hasBulk(intakeId)) return fail('R1_BULK_FIXED_ASSOCIATION', '批量接收以整件固定关联根读取。');    this.require(intakeId);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('R1_CSV_PAGE', '需要已登记的原页号。');
    const row = this.db.prepare('SELECT page_json FROM r1_csv_pages WHERE intake_id=? AND ordinal=?').get(intakeId, ordinal);
    if (!row) fail('R1_CSV_PAGE', '没有该原件解析页。');
    const page = JSON.parse(String(row.page_json)) as R1ChunkedCsvPage;
    page.auto = page.materialId ? this.readAuto(page.autoRequestId) : null; return page;
  }
  readPage(intakeId: string, ordinal: number): { page: R1ChunkedCsvPage; bytes: Buffer } {
    const page = this.page(intakeId, ordinal), row = this.db.prepare('SELECT page_bytes FROM r1_csv_pages WHERE intake_id=? AND ordinal=?').get(intakeId, ordinal)!;
    const bytes = Buffer.from(row.page_bytes as Uint8Array);
    if (bytes.length !== page.byteLength || wfdSha256(bytes) !== page.sha256) fail('R1_CSV_PAGE_CHANGED', '解析页字节偏离冻结身份。');
    return { page, bytes };
  }
  /** Only released transport bytes expire. Original materials, page maps and publication ledgers remain authoritative. */
  sweepTemporaryChunks(now = Date.now()): { released: number; removed: number; retained: number } {
    let released = 0, removed = 0, retained = 0;
    for (const record of this.records()) {
      if (record.state !== 'completed' || this.pending.has(record.input.intakeId)) continue;
      try {
        let entry = this.db.prepare('SELECT * FROM r1_csv_transport_retention WHERE intake_id=?').get(record.input.intakeId);
        if (!entry) { this.releaseTransport(record, now); released++; entry = this.db.prepare('SELECT * FROM r1_csv_transport_retention WHERE intake_id=?').get(record.input.intakeId)!; }
        if (entry.removed_at !== null || Number(entry.expires_at) > now) continue;
        if (entry.material_id !== record.materialId || entry.original_sha256 !== record.input.sha256) throw Error('Original transport release binding changed');
        this.assertTransportRebuild(record);
        this.options.database.transaction(() => {
          this.db.prepare('DELETE FROM r1_csv_upload_chunks WHERE intake_id=?').run(record.input.intakeId);
          this.db.prepare('UPDATE r1_csv_transport_retention SET removed_at=? WHERE intake_id=? AND removed_at IS NULL').run(now, record.input.intakeId);
        }); removed++;
      } catch { retained++; }
    }
    return { released, removed, retained };
  }
  async dispose(): Promise<void> { this.closed = true; if (this.retentionTimer) clearInterval(this.retentionTimer); this.unsubscribe.splice(0).forEach(unsubscribe => unsubscribe()); await Promise.allSettled([...this.pending.values()]); }
  private assertTransportRebuild(record: IntakeRecord): void {
    if (record.state !== 'completed' || !record.parsed || !record.materialId || !record.custodyTaskId
      || record.activePage !== record.totalPages || (record.rowSummary ? record.rowSummary.inserted + record.rowSummary.duplicate_skipped !== record.totalRows || record.rowSummary.conflict_pending !== 0 : record.publishedRows !== record.totalRows)
      || this.options.tasks().get(record.custodyTaskId).status !== 'succeeded') throw Error('Original intake is not fully settled');
    const original = this.options.materials.readOriginal(record.materialId).bytes;
    if (original.length !== record.input.byteLength || wfdSha256(original) !== record.input.sha256) throw Error('Original custody cannot rebuild transport');
    let rows = 0, pages = 0, end = 0;
    for (const row of this.db.prepare('SELECT ordinal,page_json FROM r1_csv_pages WHERE intake_id=? ORDER BY ordinal').iterate(record.input.intakeId)) {
      const page = JSON.parse(String(row.page_json)) as R1ChunkedCsvPage, auto = this.readAuto(page.autoRequestId);
      if (Number(row.ordinal) !== pages || page.ordinal !== pages || page.rowStart !== rows + 1 || (pages > 0 && page.byteStart !== end)
        || auto?.state !== 'associated' || auto.currentRequest?.rowCount !== page.rowEnd - page.rowStart + 1) throw Error('Original page readback coverage changed');
      rows += auto.currentRequest.rowCount; end = page.byteEnd; pages++;
    }
    if (rows !== record.totalRows || pages !== record.totalPages || end !== record.input.byteLength) throw Error('Original full coverage is incomplete');
  }
  private releaseTransport(record: IntakeRecord, now: number): void {
    this.assertTransportRebuild(record);
    this.db.prepare('INSERT OR IGNORE INTO r1_csv_transport_retention VALUES(?,?,?,?,?,NULL)')
      .run(record.input.intakeId, record.materialId!, record.input.sha256, now, now + TEMPORARY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  }
  private resumeCustody(taskId: string): void {
    const task = this.options.tasks().get(taskId);
    if (task.status === 'ready') this.options.tasks().start(task.id, task.version);
    else if (['paused','interrupted'].includes(task.status)) this.options.tasks().resume(task.id, task.version);
  }
  private schedule(intakeId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const previous = this.pending.get(intakeId); if (previous) { this.dirty.add(intakeId); return previous; }
    const work = Promise.resolve().then(async () => {
      do { this.dirty.delete(intakeId); await this.progress(intakeId); } while (!this.closed && this.dirty.has(intakeId));
    }).catch(error => {
      if (error instanceof TaskError && error.code === 'R1_AUTO_BUSY') return;
      const record = this.require(intakeId); record.error = errorView(error);
      record.state = /STOPPED|STALE_CONTROL|DISK_BUDGET/u.test(record.error.code) ? 'stopped' : 'blocked'; this.save(record);
    }).finally(() => { this.pending.delete(intakeId); if (!this.closed && this.dirty.has(intakeId)) void this.schedule(intakeId); });
    this.pending.set(intakeId, work); return work;
  }
  private async progress(intakeId: string): Promise<void> {
    const record = this.require(intakeId); if (['receiving','completed','conflicts_pending','blocked','stopped'].includes(record.state)) return;
    this.assertCurrent(record);
    if (!record.custodyTaskId) {
      const original = this.original(record); this.assertCurrent(record);
      record.custodyTaskId = await this.options.accept({ bytes: original, name: record.input.name, category: 'data', requestId: `csv-original:${intakeId}` });
      this.assertCurrent(record); this.save(record); this.dirty.add(intakeId); return;
    }
    if (!record.materialId) {
      const task = this.options.tasks().get(record.custodyTaskId);
      if (task.status !== 'succeeded') { if (['failed','cancelled','blocked','needs_review','paused','interrupted'].includes(task.status)) fail(task.error?.code ?? 'R1_CSV_CUSTODY', task.error?.message ?? '原保管任务尚未完成。'); return; }
      const material = this.options.materials.getByTask(task.id) ?? fail('R1_CSV_CUSTODY', '原保管任务未能读回材料。');
      if (material.envelope.sha256 !== record.input.sha256 || material.envelope.byteLength !== record.input.byteLength) fail('R1_CSV_ORIGINAL_CHANGED', '完整保管材料与原清单不同。');
      record.materialId = material.envelope.materialId; record.state = 'parsing'; this.save(record);
    }
    if (!record.parsed) {
      await this.parse(record, this.original(record)); this.assertCurrent(record);
      record.parsed = true; record.state = 'publishing'; this.save(record);
    }
    if (record.activePage === record.totalPages) { record.state = record.rowSummary?.conflict_pending ? 'conflicts_pending' : 'completed'; this.save(record); try { this.releaseTransport(record, Date.now()); } catch { /* Retain all transport bytes until their rebuild is confirmed. */ } return; }
    const page = this.page(intakeId, record.activePage);
    if (!page.custodyTaskId) {
      page.custodyTaskId = await this.options.accept({ bytes: this.readPage(intakeId, page.ordinal).bytes,
        name: `page-${String(page.ordinal + 1).padStart(6,'0')}.csv`, category: 'data', requestId: `csv-page:${intakeId}:${page.ordinal}` });
      this.assertCurrent(record); this.savePage(intakeId, page); this.dirty.add(intakeId); return;
    }
    if (!page.materialId) {
      const task = this.options.tasks().get(page.custodyTaskId);
      if (task.status !== 'succeeded') { if (['failed','cancelled','blocked','needs_review','paused','interrupted'].includes(task.status)) fail(task.error?.code ?? 'R1_CSV_PAGE_CUSTODY', task.error?.message ?? '原页保管任务未完成。'); return; }
      const material = this.options.materials.getByTask(task.id) ?? fail('R1_CSV_PAGE_CUSTODY', '原页保管材料缺失。');
      if (material.envelope.sha256 !== page.sha256) fail('R1_CSV_PAGE_CHANGED', '原页保管摘要不符。');
      page.materialId = material.envelope.materialId; this.savePage(intakeId, page);
    }
    let auto = this.options.auto.start({ requestId: page.autoRequestId, materialId: page.materialId, source: record.input.source,
      datasetId: record.input.datasetId, ...(record.input.sourceValueColumns ? { sourceValueColumns: record.input.sourceValueColumns } : {}) }, record.operator);
    if (record.input.datePolicy && auto.state === 'awaiting_answers' && auto.questions.some(question => question.key === 'source_trade_date_timezone'))
      auto = this.options.auto.answer(page.autoRequestId, { answers: { source_trade_date_timezone: 'Asia/Shanghai' } }, record.operator);
    if (auto.state === 'associated' || auto.state === 'conflicts_pending') {
      if (auto.currentRequest?.rowCount !== page.rowEnd - page.rowStart + 1) fail('R1_CSV_PAGE_COVERAGE', '本页固定读回行数与完整解析行范围不同。');
      // Old intakes may reach their first new-policy page after restarting this version.
      // Their already settled legacy pages had inserted-only receipts; preserve that exact prefix.
      if (!record.rowSummary && auto.currentRequest.rowSummary) record.rowSummary = { inserted: record.publishedRows, duplicate_skipped: 0, conflict_pending: 0 };
      if (record.rowSummary) {
        const summary = auto.currentRequest.rowSummary;
        if (!summary || Object.values(summary).reduce((n,v) => n+v,0) !== auto.currentRequest.rowCount) fail('R1_CSV_PAGE_COVERAGE', '本页逐行处理计数不完整。');
        for (const key of ['inserted','duplicate_skipped','conflict_pending'] as const) record.rowSummary[key] += summary[key];
        record.publishedRows += summary.inserted;
      } else record.publishedRows += auto.currentRequest.rowCount;
      record.activePage++; record.state = record.activePage === record.totalPages ? record.rowSummary?.conflict_pending ? 'conflicts_pending' : 'completed' : 'publishing';
      this.save(record);
      if (record.state === 'completed') { try { this.releaseTransport(record, Date.now()); } catch { /* No release on an unverified custody or page ledger. */ } }
      this.dirty.add(intakeId);
    } else {
      record.state = auto.state === 'awaiting_answers' ? 'awaiting_answers' : auto.state === 'recovering' ? 'recovering'
        : auto.state === 'stopped' ? 'stopped' : auto.state === 'blocked' ? 'blocked' : 'publishing';
      record.error = auto.error; this.save(record);
    }
  }
  private original(record: IntakeRecord): Buffer {
    const result = Buffer.alloc(record.input.byteLength); let cursor = 0;
    for (const row of this.db.prepare('SELECT byte_offset,sha256,chunk_bytes FROM r1_csv_upload_chunks WHERE intake_id=? ORDER BY byte_offset').iterate(record.input.intakeId)) {
      const bytes = Buffer.from(row.chunk_bytes as Uint8Array);
      if (Number(row.byte_offset) !== cursor || wfdSha256(bytes) !== row.sha256 || cursor + bytes.length > result.length) fail('R1_CSV_CHUNK_CHANGED', '持久分块有缺口、交叠或字节改变。');
      result.set(bytes,cursor); cursor += bytes.length;
    }
    if (cursor !== result.length || wfdSha256(result) !== record.input.sha256) fail('R1_CSV_DIGEST', '完整原件摘要或字节数量与冻结清单不符，未解析或发布。');
    return result;
  }
  private async parse(record: IntakeRecord, original: Buffer): Promise<void> {
    let quoted = false, start = 0, line = 1, recordLine = 1, rowNumber = 0, header: Buffer | null = null, columns = 0;
    let ordinal = 0, pageParts: Buffer[] = [], locations: R1CsvRowLocation[] = [], pageLength = 0, packedRowBytes = 0;
    // 装页只由序列化字节预算和最大行数决定；原表头叫什么名字不参与分页决策。
    // 页面裁剪（把未声明的原列从页字节里去掉）是另一件事，仍按显式窄列规则处理。
    let selectedIndexes: number[] | null = null, selectedHeaders: string[] = [];
    let budgetIndexes: number[] | null = null, budgetHeaders: string[] = [];
    const flush = () => {
      if (!locations.length) return;
      const bytes = Buffer.concat([header!, ...pageParts]), first = locations[0]!, last = locations.at(-1)!;
      const page: R1ChunkedCsvPage = { ordinal, rowStart: first.sourceRow, rowEnd: last.sourceRow, byteStart: first.byteStart, byteEnd: last.byteEnd,
        sha256: wfdSha256(bytes), byteLength: bytes.length, locations,
        ...(budgetIndexes ? { documentBudget: { maxBytes: R1_CHUNKED_CSV_LIMITS.documentBytes,
          conservativeRowBytes: packedRowBytes, reservedBytes: R1_CHUNKED_CSV_LIMITS.documentReserveBytes } } : {}),
        custodyTaskId: null, materialId: null, autoRequestId: `csv-auto:${record.input.intakeId}:${ordinal}`, auto: null };
      this.assertCurrent(record);
      const previous = this.db.prepare('SELECT page_json FROM r1_csv_pages WHERE intake_id=? AND ordinal=?').get(record.input.intakeId,ordinal);
      if (previous) {
        const old = JSON.parse(String(previous.page_json)) as R1ChunkedCsvPage;
        if (old.sha256 !== page.sha256 || canonicalWfdJson(old.locations) !== canonicalWfdJson(page.locations)) fail('R1_CSV_PARSE_CHANGED','恢复解析与原冻结页范围不同。');
      } else this.db.prepare('INSERT INTO r1_csv_pages VALUES(?,?,?,?)').run(record.input.intakeId,ordinal,canonicalWfdJson(page),bytes);
      ordinal++; record.totalRows = last.sourceRow; record.totalPages = ordinal; this.save(record);
      pageParts = []; locations = []; pageLength = 0; packedRowBytes = 0;
    };
    const acceptRecord = (end: number, contentEnd: number, endLine: number) => {
      const bytes = original.subarray(start,end), text = new TextDecoder('utf-8',{fatal:true}).decode(original.subarray(start,contentEnd));
      const parsed = [...candidateCsvRecords(text,{maxColumns:R1_CHUNKED_CSV_LIMITS.columns,maxCellCharacters:R1_CHUNKED_CSV_LIMITS.cellCharacters})];
      if (parsed.length !== 1) fail('R1_CSV_RECORD','CSV 记录边界不能完整核对。');
      const fields = parsed[0]!;
      if (!header) {
        columns = fields.length;
        if (!columns || fields.some(field=>!field.value) || new Set(fields.map(field=>field.value)).size !== columns) fail('R1_CSV_HEADER','CSV 表头需要明确且不重复的原列名。');
        const selected = record.input.sourceValueColumns;
        if (selected) {
          if (selected.some(column=>!fields.some(field=>field.value===column))) fail('R1_CSV_COLUMNS','整份原件没有所选原列，未截取其他列代替。');
          // 文档字节预算按声明的原列计算，与这些列名是否属于任何清单无关。
          budgetHeaders = [...selected];
          budgetIndexes = selected.map(column=>fields.findIndex(field=>field.value===column));
          // 只有全部声明列都属于已知窄列集时，才把未声明列从页字节里裁掉；裁剪只影响页材料，不影响分页。
          if (selected.every(column => /^(?:交易日期|日期|(?:股票|证券)代码|(?:股票|证券)名称|分钟时间|收盘价?（元）)$/u.test(column))) {
            selectedHeaders = fields.map(field=>field.value).filter(column=>selected.includes(column)
              || /^(?:交易日期|日期|(?:股票|证券)代码|分钟时间)$/u.test(column));
            selectedIndexes = selectedHeaders.map(column=>fields.findIndex(field=>field.value===column));
          }
        }
        header = contentEnd === end ? Buffer.concat([bytes,Buffer.from('\n')]) : bytes; return;
      }
      rowNumber++;
      if (fields.length !== columns) fail('R1_CSV_COLUMNS',`原件第 ${rowNumber} 行列数与表头不同，未把已解析页当作完整表。`);
      if (bytes.length + header.length > R1_CHUNKED_CSV_LIMITS.pageBytes) fail('R1_CSV_RECORD_BUDGET','单条原记录超过独立页预算，未截断单元格。');
      let rowBytes = 0;
      if (budgetIndexes) {
        // This is a conservative byte bound, never a semantic or publication decision.
        // Decimal type names are at least as long as the supported source field types.
        const values = Object.fromEntries(budgetIndexes.map((index,selectedIndex)=>[sourceReportedCode('src_',budgetHeaders[selectedIndex]!),
          {data_type:'decimal',value_state:'valid_value',value:fields[index]!.value}]));
        rowBytes = Buffer.byteLength(canonicalWfdJson({business_key:'source_row_'+'0'.repeat(64),
          subject:{kind:'entity',namespace:record.connection.namespace,id:'source_table.'+'0'.repeat(32)},
          observation_time:{status:'known',earliest_utc:'2000-01-01T00:00:00Z',latest_exclusive_utc:'2000-01-01T00:00:00Z',precision:'minute',source_timezone:'Asia/Shanghai'},values}))+48;
      }
      // 行上限：声明了原列时按 WFD 文档最大行数；没有声明列时仍用保留页行数，因为没有逐行文档字节依据。
      const rowCap = budgetIndexes ? R1_CHUNKED_CSV_LIMITS.maxPackedRows : R1_CHUNKED_CSV_LIMITS.pageRows;
      if (locations.length && (locations.length >= rowCap
        || pageLength + bytes.length + header.length > R1_CHUNKED_CSV_LIMITS.pageBytes
        || budgetIndexes && packedRowBytes + rowBytes + R1_CHUNKED_CSV_LIMITS.documentReserveBytes > R1_CHUNKED_CSV_LIMITS.documentBytes)) flush();
      pageParts.push(bytes); pageLength += bytes.length;
      packedRowBytes += rowBytes;
      locations.push({byteStart:start,byteEnd:end,lineStart:recordLine,lineEnd:endLine,sourceRow:rowNumber});
    };
    let nextYield = R1_CHUNKED_CSV_LIMITS.chunkBytes;
    for (let index = 0; index < original.length; index++) {
      const byte = original[index]!;
      if (byte === 34) quoted = !quoted;
      if (byte === 13 || byte === 10) {
        const endLine = line; if (byte === 13 && original[index+1] === 10) index++;
        line++;
        if (!quoted) { const contentEnd = original[index] === 10 && index && original[index-1] === 13 ? index-1 : index;
          acceptRecord(index+1,contentEnd,endLine); start=index+1;recordLine=line; }
      }
      if (index - start > R1_CHUNKED_CSV_LIMITS.pageBytes) fail('R1_CSV_RECORD_BUDGET','CSV 记录超过有界扫描预算或引号未闭合。');
      if (index >= nextYield) { this.assertCurrent(record); await yieldNow(); nextYield=index+R1_CHUNKED_CSV_LIMITS.chunkBytes; }
    }
    if (quoted) fail('INVALID_CSV_QUOTES','CSV 末条记录引号未闭合，未发布已解析前缀。');
    if (start < original.length) acceptRecord(original.length,original.length,line);
    if (!header || !rowNumber) fail('R1_CSV_EMPTY','CSV 没有完整的数据记录。');
    flush();
  }
  private readAuto(id: string): R1AutoView | null { try { return this.options.auto.get(id); } catch (error) { if (error instanceof TaskError && error.code === 'R1_AUTO_NOT_FOUND') return null; throw error; } }
  private savePage(intakeId: string, page: R1ChunkedCsvPage) { const {auto: _auto,...value}=page; this.db.prepare('UPDATE r1_csv_pages SET page_json=? WHERE intake_id=? AND ordinal=?').run(canonicalWfdJson({...value,auto:null}),intakeId,page.ordinal); }
  private records(): IntakeRecord[] { return this.db.prepare('SELECT record_json FROM r1_csv_intakes ORDER BY updated_at DESC').all().map(row=>JSON.parse(String(row.record_json)) as IntakeRecord); }
  private require(id: string): IntakeRecord { if (!key(id)) fail('R1_CSV_ID','分块接收需要原稳定编号。');const row=this.db.prepare('SELECT record_json FROM r1_csv_intakes WHERE intake_id=?').get(id);return row?JSON.parse(String(row.record_json)) as IntakeRecord:fail('R1_CSV_NOT_FOUND','没有该分块接收记录。'); }
  private save(record: IntakeRecord) { record.updatedAt=Date.now();this.db.prepare('UPDATE r1_csv_intakes SET record_json=?,updated_at=? WHERE intake_id=?').run(canonicalWfdJson(record),record.updatedAt,record.input.intakeId); }
  private assertDispatch() { if(this.closed || this.options.tasks().getControl().stopped)fail('BD_STOPPED','服务已停止；请明确继续原分块接收编号。'); }
  private assertConnection(record: IntakeRecord) { if(canonicalWfdJson(record.connection)!==canonicalWfdJson(this.options.connection()))fail('R1_CSV_CONNECTION_CHANGED','分块接收的原连接身份不同，未换库继续。'); }
  private assertCurrent(record: IntakeRecord) {
    this.assertDispatch();this.assertConnection(record);
    if(record.generation!==this.options.tasks().getControl().generation)fail('BD_STOPPED','接收后停止代次已改变；请明确继续原编号。');
    for (const path of [this.options.database.path,this.options.custodyRoot].filter((path):path is string=>!!path&&isAbsolute(path))) {
      const disk=statfsSync(dirname(path));
      if(disk.bavail*disk.bsize<R1_CHUNKED_CSV_LIMITS.minFreeBytes)fail('R1_CSV_DISK_BUDGET','所在盘可用空间不足 4 GiB；保留原编号、完整原件与已完成页，未继续发布。');
    }
  }
}

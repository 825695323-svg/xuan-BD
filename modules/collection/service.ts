import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import { digestOperationArgs, PermissionError } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { createRawArtifact, digestArtifact, encodeArtifact, executeStep, getStructuredOutput, validateStepExecution,
  CollectionPipelineError, type CollectionArtifact, type CollectionPlan, type CollectionStepRegistry, type RawArtifact, type StepExecution } from './pipeline.js';
import { bytesDigest, sealedBytes, sourceId, validateFileInput, validateSource, type FileInputRegistration, type SourceAdapter, type SourcePage } from './sources.js';

export const COLLECTION_RUNTIME = 'bd.collection';
export const COLLECTION_VERSION = 'collection-orchestration/1';
export type CollectionCompletion = 'processed';
export interface CollectionServiceOptions {
  environment: 'synthetic-test';
  database: CoreDatabase;
  tasks(): TaskService;
  files: FileReferenceService;
  datasetId: string;
  fileInputs?: readonly FileInputRegistration[];
  sources?: readonly SourceAdapter[];
  plans: Readonly<Record<string, CollectionPlan>>;
  stepRegistry?: CollectionStepRegistry;
}
interface InputRow { task_id: string; kind: 'file' | 'source'; input_id: string; binding_digest: string; sealed_json: string | null; sealed_digest: string | null }
interface PageRow { ordinal: number; page_json: string; sha256: string; byte_length: number; received_at: number }
interface ProcessingRow { task_id: string; collection_task_id: string; plan_id: string; plan_json: string; plan_digest: string; input_digest: string; completion: CollectionCompletion }
const SCHEMA = `
CREATE TABLE collection_inputs (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), kind TEXT NOT NULL, input_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
 sealed_json TEXT, sealed_digest TEXT
);
CREATE TABLE collection_pages (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
 attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, accepted INTEGER NOT NULL,
 page_json TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX collection_pages_accepted ON collection_pages(task_id,ordinal) WHERE accepted=1;
CREATE TABLE collection_processing (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), collection_task_id TEXT NOT NULL REFERENCES tasks(id),
 plan_id TEXT NOT NULL, plan_json TEXT NOT NULL, plan_digest TEXT NOT NULL, input_digest TEXT NOT NULL, completion TEXT NOT NULL
);
CREATE TABLE collection_steps (
 task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL, step_id TEXT NOT NULL,
 execution_json TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
 PRIMARY KEY(task_id,ordinal), UNIQUE(task_id,step_id)
);
CREATE TABLE collection_observations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), origin TEXT NOT NULL,
 attempt_id TEXT, generation INTEGER, payload_json TEXT NOT NULL, observed_at INTEGER NOT NULL
);
`;

/** 阶段表仅保存封闭输入、步骤和本地加工观测；任务状态仍只由 TaskService 持有。 */
export class CollectionService {
  private readonly inputs = new Map<string, FileInputRegistration>();
  private readonly sources = new Map<string, SourceAdapter>();
  private readonly plans: Record<string, CollectionPlan>;
  readonly versionBinding: Record<string, string | null>;

  constructor(private readonly options: CollectionServiceOptions) {
    if (options.environment !== 'synthetic-test') throw new TaskError('COLLECTION_NOT_ENABLED', '本阶段仅允许受信宿主明确装配隔离合成输入。');
    sourceId(options.datasetId);
    for (const input of options.fileInputs ?? []) {
      validateFileInput(input);
      if (this.inputs.has(input.id)) throw new TaskError('DUPLICATE_COLLECTION_INPUT', '文件身份已经登记。');
      this.inputs.set(input.id, structuredClone(input));
    }
    for (const adapter of options.sources ?? []) {
      validateSource(adapter);
      if (this.sources.has(adapter.id)) throw new TaskError('DUPLICATE_COLLECTION_SOURCE', '来源身份已经登记。');
      this.sources.set(adapter.id, { ...adapter, definition: structuredClone(adapter.definition), fetchPage: adapter.fetchPage.bind(adapter) });
    }
    this.plans = structuredClone(options.plans);
    for (const [id, plan] of Object.entries(this.plans)) {
      sourceId(id);
      if (plan.environment !== 'synthetic-test') throw new TaskError('INVALID_COLLECTION_PLAN', '加工计划必须保持隔离合成身份。');
    }
    this.versionBinding = Object.freeze({ collection: COLLECTION_VERSION, environment: 'synthetic-test',
      configuration: digestArtifact({ datasetId: options.datasetId, fileInputs: [...this.inputs.values()],
        sources: [...this.sources.values()].map(sourceBinding), plans: this.plans }) });
    options.database.migrate('collection', 1, SCHEMA);
  }

  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  catalog(): JsonValue {
    return { environment: 'synthetic-test', fileInputs: [...this.inputs.keys()], sources: [...this.sources.keys()], plans: Object.keys(this.plans),
      completionConditions: ['processed'], versions: this.versionBinding };
  }

  validate(operation: string, args: unknown): Record<string, JsonValue> {
    const data = object(args);
    if (operation === 'collection.receive') { keys(data, ['fileInputId']); sourceId(data.fileInputId); this.file(data.fileInputId); }
    else if (operation === 'collection.collect') { keys(data, ['sourceId']); sourceId(data.sourceId); this.source(data.sourceId); }
    else if (operation === 'collection.process') {
      keys(data, ['collectionTaskId', 'planId', 'completionCondition', ...Object.hasOwn(data, 'expectedSnapshotId') ? ['expectedSnapshotId'] : []]); sourceId(data.collectionTaskId); sourceId(data.planId);
      this.plan(data.planId); this.input(data.collectionTaskId);
      if (data.completionCondition !== 'processed') throw new TaskError('INVALID_COLLECTION_COMPLETION', '合成材料入口的完成条件须为加工完成。');
      if (!Object.hasOwn(data, 'expectedSnapshotId')) data.expectedSnapshotId = null;
      if (data.expectedSnapshotId !== null) sourceId(data.expectedSnapshotId);
    } else throw new TaskError('COLLECTION_OPERATION_DISABLED', '此操作不属于已启用的数据收集入口。');
    return jsonValue(data) as Record<string, JsonValue>;
  }

  requestTask(operation: string, requestId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE runtime_id=? AND request_id=?').get(COLLECTION_RUNTIME, requestKey(operation, requestId));
    return row ? this.getTask(String(row.id)) : null;
  }

  submit(operation: string, args: unknown, requestId: string, parentTaskId?: string): TaskRecord {
    const data = this.validate(operation, args), request = requestKey(operation, requestId);
    const previous = this.requestTask(operation, requestId);
    if (previous) {
      this.assertDispatch();
      const parent = operation === 'collection.process' ? String(data.collectionTaskId) : parentTaskId;
      if (previous.ownerRole !== 'service' || previous.conversationId !== null || previous.title !== `数据收集：${operation}`
        || previous.action !== operation || digestOperationArgs(previous.args) !== digestOperationArgs(data)
        || previous.parentTaskId !== (parent ?? null) || digestArtifact(previous.versions) !== digestArtifact(this.versionBinding)) {
        throw new TaskError('REQUEST_CONFLICT', '同一收集请求不能更换输入、关联任务或固定版本。');
      }
      // 命名迁移不重算原受理摘要；重复受理只读原任务，不触发启动或恢复。
      return previous;
    }
    this.assertDispatch();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: `数据收集：${operation}`, ownerRole: 'service', runtimeId: COLLECTION_RUNTIME,
        action: operation, args: data, requestId: request, versions: this.versionBinding,
        parentTaskId: operation === 'collection.process' ? String(data.collectionTaskId) : parentTaskId });
      const task = accepted.task;
      if (operation === 'collection.process') {
        const input = this.input(String(data.collectionTaskId));
        if (!input.sealed_json || !input.sealed_digest || this.tasks.get(input.task_id).status !== 'succeeded') throw new TaskError('COLLECTION_NOT_SEALED', '原采集任务尚未形成已完成的封闭输入。');
        const plan = this.plan(String(data.planId));
        this.db.prepare('INSERT OR IGNORE INTO collection_processing VALUES(?,?,?,?,?,?,?)')
          .run(task.id, input.task_id, data.planId as string, encode(plan), digestArtifact(plan), input.sealed_digest, data.completionCondition as string);
      } else {
        const kind = operation === 'collection.receive' ? 'file' : 'source', id = String(kind === 'file' ? data.fileInputId : data.sourceId);
        this.db.prepare('INSERT OR IGNORE INTO collection_inputs(task_id,kind,input_id,binding_digest) VALUES(?,?,?,?)')
          .run(task.id, kind, id, digestArtifact(kind === 'file' ? this.file(id) : sourceBinding(this.source(id))));
      }
    });
    accepted.publish();
    if (accepted.task.status === 'ready') return this.tasks.start(accepted.task.id);
    return accepted.task;
  }

  status(taskId?: string): JsonValue {
    if (taskId === undefined) return this.catalog();
    const task = this.getTask(taskId);
    const input = this.db.prepare('SELECT * FROM collection_inputs WHERE task_id=?').get(taskId) as unknown as InputRow | undefined;
    const processing = this.processing(taskId, false);
    return jsonValue({ task, collectionTaskId: processing?.collection_task_id ?? input?.task_id ?? null,
      processingTaskId: processing?.task_id ?? null,
      input: input ? { kind: input.kind, inputId: input.input_id, sealed: !!input.sealed_json, digest: input.sealed_digest,
        pages: this.pages(taskId).map((page) => ({ ordinal: page.ordinal, sha256: page.sha256, byteLength: page.byte_length, receivedAt: page.received_at,
          cursor: decode<SourcePage>(page.page_json).cursor, nextCursor: decode<SourcePage>(page.page_json).nextCursor })) } : null,
      planDigest: processing?.plan_digest ?? null,
      steps: this.db.prepare('SELECT execution_json FROM collection_steps WHERE task_id=? ORDER BY ordinal').all(taskId).map(row => decode<StepExecution>(String(row.execution_json))),
    });
  }

  evidence(taskId: string): JsonValue {
    this.getTask(taskId);
    return jsonValue({ status: this.status(taskId),
      pages: this.db.prepare('SELECT * FROM collection_pages WHERE task_id=? ORDER BY received_at,rowid').all(taskId).map(row => ({ ...row, page: decode(String(row.page_json)) })),
      observations: this.db.prepare('SELECT * FROM collection_observations WHERE task_id=? ORDER BY sequence').all(taskId).map(row => ({ ...row, payload: decode(String(row.payload_json)) })),
    });
  }

  resume(taskId: string, expectedVersion: number): TaskRecord {
    const task = this.getTask(taskId); this.assertBinding(task); this.assertDispatch();
    if (task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请读取当前版本后明确继续。');
    if (task.status === 'needs_review' || task.requiresReview) throw new TaskError('UNKNOWN_RESULT', '先只读核对原交接身份，不能重新派发。');
    if (task.status === 'ready') return this.tasks.start(taskId, expectedVersion);
    if (task.status === 'paused' || task.status === 'interrupted') return this.tasks.resume(taskId, expectedVersion);
    if (task.status === 'failed' || task.status === 'cancelled') return this.tasks.retry(taskId, expectedVersion);
    if (task.status === 'succeeded') return task;
    throw new TaskError('TASK_BUSY', '当前任务尚未收束，不能开启另一尝试。');
  }

  readonly runtime: TaskRuntime = { id: COLLECTION_RUNTIME, execute: async context => {
    this.assertBinding(context.task); this.assertActive(context);
    try {
      return context.task.action === 'collection.process' ? await this.process(context) : await this.collect(context);
    } catch (error) {
      if (error instanceof CollectionPipelineError) throw new TaskError(error.code, `${error.stepId}：${error.message}`);
      throw error;
    }
  } };

  private async collect(context: TaskExecutionContext): Promise<TaskResult> {
    const input = this.input(context.task.id);
    const binding = input.kind === 'file' ? this.file(input.input_id) : sourceBinding(this.source(input.input_id));
    if (digestArtifact(binding) !== input.binding_digest) throw new TaskError('COLLECTION_VERSION_CONFLICT', '原来源或文件登记版本已变化，不能用新版本继续。');
    if (input.sealed_json) return this.collectionResult(input, this.raw(input));
    if (input.kind === 'file') {
      const registration = this.file(input.input_id), previous = this.pages(input.task_id);
      if (!previous.length) {
        const reference = this.options.files.verify(registration.fileRefId);
        const operation = { operationId: 'collection.receive', operationVersion: 1,
          argsDigest: digestOperationArgs({ fileInputId: registration.id, expectedSha256: registration.expectedSha256 }),
          targets: [{ kind: 'file' as const, path: reference.invocationPath }] };
        const capabilities = [{ action: 'read' as const, target: { kind: 'file' as const, path: reference.invocationPath } }];
        let approvalId: string | undefined;
        try { context.assertAuthorized(operation, capabilities); }
        catch (error) {
          if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
          approvalId = (await context.requestApproval(operation, capabilities)).approvalId ?? undefined;
        }
        this.assertActive(context);
        const bytes = await this.options.files.readBytes(registration.fileRefId, { operation: context.operationScope(operation), approvalId, maxBytes: registration.maxBytes });
        const page: SourcePage = { cursor: null, nextCursor: null, bytesBase64: bytes.toString('base64'), mediaType: registration.mediaType,
          metadata: { fileInputId: registration.id, version: registration.version } };
        const matchesExpected = bytesDigest(bytes) === registration.expectedSha256;
        this.savePage(context, 0, page, matchesExpected);
        if (!matchesExpected) throw new TaskError('COLLECTION_INPUT_CHANGED', '实际文件原字节与宿主冻结摘要不同，不继续加工。');
      }
    } else {
      const source = this.source(input.input_id);
      while (true) {
        const pages = this.pages(input.task_id);
        const previous = pages.at(-1), cursor = previous ? decode<SourcePage>(previous.page_json).nextCursor : null;
        if (previous && cursor === null) break;
        if (pages.length >= source.maxPages) throw new TaskError('SOURCE_PAGE_LIMIT', '来源仍有下一页，但已达到固定页数预算。');
        if (pages.some(page => decode<SourcePage>(page.page_json).cursor === cursor)) throw new TaskError('SOURCE_CURSOR_CYCLE', '来源游标重复，不能把不完整分页记成完成。');
        this.assertActive(context);
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(source.timeoutMs)]);
        let abandoned = false;
        const pending = source.fetchPage({ cursor, requestId: `page:${input.task_id}:${pages.length}`, signal });
        void pending.then(page => { if (abandoned) { try { this.savePage(context, pages.length, page, false); } catch { /* 迟到事实无法保存时不改变新运行。 */ } } }).catch(() => {});
        let page: SourcePage;
        try { page = await abortable(pending, signal); }
        catch (error) { abandoned = true; throw error; }
        if (page.cursor !== cursor) { this.savePage(context, pages.length, page, false); throw new TaskError('SOURCE_CURSOR_MISMATCH', '返回页不属于原请求游标。'); }
        this.savePage(context, pages.length, page, true);
        await context.emit({ type: 'checkpoint', checkpoint: { collectionTaskId: input.task_id, receivedPages: pages.length + 1, nextCursor: page.nextCursor } });
        this.assertActive(context);
      }
    }
    this.assertActive(context);
    const pages = this.pages(input.task_id), raw = createRawArtifact(pages.map(page => sealedBytes(decode<SourcePage>(page.page_json).bytesBase64, 2_000_000)));
    this.options.database.transaction(() => {
      this.assertOwner(context);
      this.db.prepare('UPDATE collection_inputs SET sealed_json=?,sealed_digest=? WHERE task_id=? AND sealed_json IS NULL')
        .run(encode(raw), digestArtifact(raw), input.task_id);
    });
    return this.collectionResult(this.input(input.task_id), raw);
  }

  private savePage(context: TaskExecutionContext, ordinal: number, page: SourcePage, accept: boolean): void {
    if (!page || page.mediaType !== 'text/csv' || (page.cursor !== null && typeof page.cursor !== 'string') || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new TaskError('INVALID_SOURCE_PAGE', '来源页缺少明确 CSV 字节或游标。');
    const input = this.input(context.task.id), maxBytes = input.kind === 'file' ? this.file(input.input_id).maxBytes : this.source(input.input_id).maxBytes;
    const bytes = sealedBytes(page.bytesBase64, maxBytes), encoded = encode(page);
    let stale = false;
    this.options.database.transaction(() => {
      const owned = this.owns(context), existing = this.db.prepare('SELECT sha256 FROM collection_pages WHERE task_id=? AND ordinal=? AND accepted=1').get(input.task_id, ordinal);
      const accepted = accept && owned && !existing;
      if (accepted && this.pages(input.task_id).reduce((sum, saved) => sum + saved.byte_length, 0) + bytes.length > maxBytes) throw new TaskError('SOURCE_BYTE_LIMIT', '已收页面总字节超过固定预算。');
      this.db.prepare('INSERT INTO collection_pages VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), input.task_id, ordinal, context.attemptId, context.generation, Number(accepted), encoded, bytesDigest(bytes), bytes.length, Date.now());
      stale = accept && !owned;
    });
    if (stale) throw new TaskError('STALE_COLLECTION_RESULT', '旧尝试的页仅作原始事实，不接入新尝试。');
  }

  private async process(context: TaskExecutionContext): Promise<TaskResult> {
    const processing = this.processing(context.task.id)!, input = this.input(processing.collection_task_id), raw = this.raw(input);
    const plan = decode<CollectionPlan>(processing.plan_json);
    if (digestArtifact(plan) !== processing.plan_digest || digestArtifact(this.plan(processing.plan_id)) !== processing.plan_digest
      || digestArtifact(raw) !== processing.input_digest) throw new TaskError('COLLECTION_VERSION_CONFLICT', '原固定计划或封闭输入摘要不再匹配。');
    let artifact: CollectionArtifact = raw;
    const traces: StepExecution[] = [];
    for (const [ordinal, binding] of plan.steps.entries()) {
      this.assertActive(context);
      const saved = this.db.prepare('SELECT execution_json FROM collection_steps WHERE task_id=? AND ordinal=?').get(context.task.id, ordinal);
      const execution: StepExecution = saved ? validateStepExecution(decode<StepExecution>(String(saved.execution_json)), artifact, plan, this.options.stepRegistry)
        : executeStep(binding.stepId, artifact, plan, this.options.stepRegistry);
      if (!saved) this.options.database.transaction(() => {
        this.assertOwner(context);
        this.db.prepare('INSERT INTO collection_steps VALUES(?,?,?,?,?,?)').run(context.task.id, ordinal, binding.stepId, encode(execution), context.attemptId, context.generation);
      });
      traces.push(execution); artifact = execution.output;
      await context.emit({ type: 'checkpoint', checkpoint: { collectionTaskId: input.task_id, processingTaskId: context.task.id,
        planDigest: processing.plan_digest, completedStep: binding.stepId, outputDigest: execution.outputSha256 } });
    }
    const output = getStructuredOutput(artifact);
    return this.processingResult(processing, output, traces);
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    this.getTask(taskId); return this.tasks.cancel(taskId);
  }

  private processingResult(processing: ProcessingRow, output: unknown, traces: StepExecution[]): TaskResult {
    return { summary: '受控五步加工完成，未交接正式库。',
      data: jsonValue({ environment: 'synthetic-test', collectionTaskId: processing.collection_task_id, processingTaskId: processing.task_id,
        completionCondition: processing.completion, inputDigest: processing.input_digest, planDigest: processing.plan_digest,
        output, steps: traces.map(trace => ({ stepId: trace.stepId, inputSha256: trace.inputSha256, outputSha256: trace.outputSha256 })),
        receipt: null, readback: null }) };
  }
  private collectionResult(input: InputRow, raw: RawArtifact): TaskResult {
    return { summary: '原件字节与分页范围已封闭，等待明确加工任务。', data: { environment: 'synthetic-test', collectionTaskId: input.task_id,
      inputRef: `collection-input:${input.task_id}`, inputDigest: digestArtifact(raw), pages: raw.parts.length, byteLength: raw.parts.reduce((sum, part) => sum + part.byteLength, 0) } };
  }
  private raw(input: InputRow): RawArtifact {
    if (!input.sealed_json || !input.sealed_digest) throw new TaskError('COLLECTION_NOT_SEALED', '采集原件尚未封闭。');
    const raw = decode<RawArtifact>(input.sealed_json);
    if (raw.kind !== 'raw' || digestArtifact(raw) !== input.sealed_digest) throw new TaskError('COLLECTION_INPUT_CHANGED', '封闭原件摘要不一致。');
    const verified = createRawArtifact(raw.parts.map(part => {
      const bytes = sealedBytes(part.bytesBase64, 2_000_000);
      if (bytesDigest(bytes) !== part.sha256 || bytes.length !== part.byteLength) throw new TaskError('COLLECTION_INPUT_CHANGED', '已保存原件字节与摘要不一致。');
      return bytes;
    }));
    if (digestArtifact(verified) !== input.sealed_digest) throw new TaskError('COLLECTION_INPUT_CHANGED', '封闭原件清单不一致。');
    return verified;
  }
  private pages(taskId: string): PageRow[] {
    const rows = this.db.prepare('SELECT * FROM collection_pages WHERE task_id=? AND accepted=1 ORDER BY ordinal').all(taskId) as unknown as PageRow[];
    let cursor: string | null = null;
    for (const [ordinal, row] of rows.entries()) {
      const page = decode<SourcePage>(row.page_json), bytes = sealedBytes(page.bytesBase64, 2_000_000);
      if (row.ordinal !== ordinal || page.mediaType !== 'text/csv' || page.cursor !== cursor || bytes.length !== row.byte_length || bytesDigest(bytes) !== row.sha256
        || (cursor === null && ordinal > 0)) throw new TaskError('SOURCE_CHECKPOINT_MISMATCH', '已收分页原件、摘要、次序或游标不匹配。');
      cursor = page.nextCursor;
    }
    return rows;
  }
  private input(taskId: string): InputRow {
    const row = this.db.prepare('SELECT * FROM collection_inputs WHERE task_id=?').get(taskId) as unknown as InputRow | undefined;
    if (!row) throw new TaskError('COLLECTION_INPUT_NOT_FOUND', '没有原采集任务的输入登记。');
    return row;
  }
  private processing(taskId: string, required = true): ProcessingRow | undefined {
    const row = this.db.prepare('SELECT * FROM collection_processing WHERE task_id=?').get(taskId) as unknown as ProcessingRow | undefined;
    if (!row && required) throw new TaskError('PROCESSING_NOT_FOUND', '没有此加工任务。');
    return row;
  }
  private getTask(id: string): TaskRecord {
    sourceId(id); const task = this.tasks.get(id);
    if (task.ownerRole !== 'service' || task.runtimeId !== COLLECTION_RUNTIME) throw new TaskError('COLLECTION_TASK_NOT_FOUND', '没有此数据收集任务。');
    return task;
  }
  private file(id: string): FileInputRegistration { const value = this.inputs.get(id); if (!value) throw new TaskError('FILE_INPUT_NOT_REGISTERED', '文件身份未由受信宿主登记。'); return value; }
  private source(id: string): SourceAdapter { const value = this.sources.get(id); if (!value) throw new TaskError('SOURCE_NOT_REGISTERED', '来源身份未由受信宿主登记。'); return value; }
  private plan(id: string): CollectionPlan { const value = this.plans[id]; if (!value || !Object.hasOwn(this.plans, id)) throw new TaskError('PLAN_NOT_REGISTERED', '加工计划未由受信宿主登记。'); return structuredClone(value); }
  private assertBinding(task: TaskRecord): void { if (digestArtifact(task.versions) !== digestArtifact(this.versionBinding)) throw new TaskError('COLLECTION_VERSION_CONFLICT', '原任务固定配置或合同版本不同，不能静默换版继续。'); }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '服务已停止新的采集、加工和交接派发。'); }
  private owns(context: TaskExecutionContext): boolean {
    const task = this.tasks.get(context.task.id);
    return task.currentRunId === context.runId && task.currentAttemptId === context.attemptId && task.generation === context.generation
      && ['running', 'waiting_approval', 'pausing', 'cancelling'].includes(task.status);
  }
  private assertOwner(context: TaskExecutionContext): void { if (!this.owns(context)) throw new TaskError('STALE_COLLECTION_RESULT', '原尝试已失去所有权，不能写入新运行。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted(); this.assertDispatch();
    if (!this.tasks.isRunActive(context.runId, context.generation)) throw new TaskError('STALE_COLLECTION_ATTEMPT', '采集尝试的控制代次或运行资格已失效。');
  }
  private observe(taskId: string, origin: string, payload: unknown, context?: TaskExecutionContext): void {
    this.options.database.transaction(() => this.db.prepare('INSERT INTO collection_observations(task_id,origin,attempt_id,generation,payload_json,observed_at) VALUES(?,?,?,?,?,?)')
      .run(taskId, origin, context?.attemptId ?? null, context?.generation ?? null, encode(payload), Date.now()));
  }
}

function sourceBinding(source: SourceAdapter): JsonValue { return jsonValue({ id: source.id, version: source.version, environment: source.environment,
  definition: source.definition, maxPages: source.maxPages, maxBytes: source.maxBytes, timeoutMs: source.timeoutMs }); }
function requestKey(operation: string, requestId: string): string { sourceId(operation); sourceId(requestId); return `collection:${operation}:${digestOperationArgs(requestId)}`; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError('INVALID_COLLECTION_ARGS', '收集参数必须是对象。'); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: string[]): void { if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new TaskError('INVALID_COLLECTION_ARGS', '参数字段必须符合登记的窄入口。'); }
function encode(value: unknown): string { digestArtifact(value); return JSON.stringify(value); }
function jsonValue(value: unknown): JsonValue { return JSON.parse(encode(value)) as JsonValue; }
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw new TaskError('COLLECTION_STORAGE_INVALID', '持久收集记录无法读取。'); } }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { stop = () => reject(new TaskError('COLLECTION_STOPPED', '当前等待已停止，已受理业务事实保留。')); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([pending, interrupted]); } finally { signal.removeEventListener('abort', stop); }
}

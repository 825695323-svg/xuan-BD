import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import { digestOperationArgs, PermissionError } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { createRawArtifact, dependencyManifestBytes, digestArtifact, encodeArtifact, executeStep, getStructuredOutput, implementationBytes, validateStepExecution,
  CollectionPipelineError, type CollectionArtifact, type CollectionPlan, type CollectionStepRegistry, type RawArtifact, type StepExecution } from './pipeline.js';
import type { CollectionDatabasePort, CollectionDatabaseReceipt, CollectionHandoffIntent, CollectionReadback, SealedCollectionObject } from './handoff.js';
import { bytesDigest, sealedBytes, sourceId, validateFileInput, validateSource, type FileInputRegistration, type SourceAdapter, type SourcePage } from './sources.js';

export const COLLECTION_RUNTIME = 'harness.collection';
export const COLLECTION_VERSION = 'collection-orchestration/1';
export type CollectionCompletion = 'processed' | 'received' | 'committed';
export interface CollectionServiceOptions {
  environment: 'synthetic-test';
  database: CoreDatabase;
  tasks(): TaskService;
  files: FileReferenceService;
  datasetId: string;
  fileInputs?: readonly FileInputRegistration[];
  sources?: readonly SourceAdapter[];
  plans: Readonly<Record<string, CollectionPlan>>;
  databasePort?: CollectionDatabasePort;
  stepRegistry?: CollectionStepRegistry;
}
interface InputRow { task_id: string; kind: 'file' | 'source'; input_id: string; binding_digest: string; sealed_json: string | null; sealed_digest: string | null }
interface PageRow { ordinal: number; page_json: string; sha256: string; byte_length: number; received_at: number }
interface ProcessingRow { task_id: string; collection_task_id: string; plan_id: string; plan_json: string; plan_digest: string; input_digest: string; completion: CollectionCompletion }
interface HandoffRow { task_id: string; handoff_id: string; request_id: string; intent_json: string; intent_digest: string; sent_at: number | null;
  effect_attempt_id: string | null; effect_id: string | null; receipt_json: string | null; readback_json: string | null; cancellation_id: string | null }
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
CREATE TABLE collection_handoffs (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), handoff_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,
 intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL, sent_at INTEGER,
 effect_attempt_id TEXT, effect_id TEXT, receipt_json TEXT, readback_json TEXT,
 cancellation_id TEXT, cancellation_requested_at INTEGER
);
CREATE TABLE collection_observations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), origin TEXT NOT NULL,
 attempt_id TEXT, generation INTEGER, payload_json TEXT NOT NULL, observed_at INTEGER NOT NULL
);
`;

/** 阶段表仅保存封闭输入、步骤和所属端口事实；任务状态仍只由 TaskService 持有。 */
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
        sources: [...this.sources.values()].map(sourceBinding), plans: this.plans }),
      databaseContract: options.databasePort?.contractVersion ?? null, databaseContractDigest: options.databasePort?.contractDigest ?? null });
    options.database.migrate('collection', 1, SCHEMA);
  }

  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  catalog(): JsonValue {
    return { environment: 'synthetic-test', fileInputs: [...this.inputs.keys()], sources: [...this.sources.keys()], plans: Object.keys(this.plans),
      databaseBinding: this.options.databasePort?.binding ?? 'unbound', versions: this.versionBinding };
  }

  validate(operation: string, args: unknown): Record<string, JsonValue> {
    const data = object(args);
    if (operation === 'collection.receive') { keys(data, ['fileInputId']); sourceId(data.fileInputId); this.file(data.fileInputId); }
    else if (operation === 'collection.collect') { keys(data, ['sourceId']); sourceId(data.sourceId); this.source(data.sourceId); }
    else if (operation === 'collection.process') {
      keys(data, ['collectionTaskId', 'planId', 'completionCondition', ...Object.hasOwn(data, 'expectedSnapshotId') ? ['expectedSnapshotId'] : []]); sourceId(data.collectionTaskId); sourceId(data.planId);
      this.plan(data.planId); this.input(data.collectionTaskId);
      if (!['processed', 'received', 'committed'].includes(String(data.completionCondition))) throw new TaskError('INVALID_COLLECTION_COMPLETION', '须明确加工完成、保管接收或正式提交完成条件。');
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
    if (!previous) this.assertDispatch();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      if (!previous && operation === 'collection.process') this.assertNoUnresolvedHandoff(this.input(String(data.collectionTaskId)).sealed_digest, digestArtifact(this.plan(String(data.planId))));
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
    const processing = this.processing(taskId, false), handoff = this.handoff(taskId);
    return jsonValue({ task, collectionTaskId: processing?.collection_task_id ?? input?.task_id ?? null,
      processingTaskId: processing?.task_id ?? null,
      input: input ? { kind: input.kind, inputId: input.input_id, sealed: !!input.sealed_json, digest: input.sealed_digest,
        pages: this.pages(taskId).map((page) => ({ ordinal: page.ordinal, sha256: page.sha256, byteLength: page.byte_length, receivedAt: page.received_at,
          cursor: decode<SourcePage>(page.page_json).cursor, nextCursor: decode<SourcePage>(page.page_json).nextCursor })) } : null,
      planDigest: processing?.plan_digest ?? null,
      steps: this.db.prepare('SELECT execution_json FROM collection_steps WHERE task_id=? ORDER BY ordinal').all(taskId).map(row => decode<StepExecution>(String(row.execution_json))),
      handoff: handoff ? { handoffId: handoff.handoff_id, requestId: handoff.request_id, inputDigest: decode<CollectionHandoffIntent>(handoff.intent_json).inputDigest,
        sentAt: handoff.sent_at, receipt: handoff.receipt_json ? decode(handoff.receipt_json) : null,
        readback: handoff.readback_json ? decode(handoff.readback_json) : null, cancellationId: handoff.cancellation_id } : null });
  }

  evidence(taskId: string): JsonValue {
    this.getTask(taskId);
    const handoff = this.handoff(taskId);
    return jsonValue({ status: this.status(taskId),
      pages: this.db.prepare('SELECT * FROM collection_pages WHERE task_id=? ORDER BY received_at,rowid').all(taskId).map(row => ({ ...row, page: decode(String(row.page_json)) })),
      observations: this.db.prepare('SELECT * FROM collection_observations WHERE task_id=? ORDER BY sequence').all(taskId).map(row => ({ ...row, payload: decode(String(row.payload_json)) })),
      handoff: handoff ? { intent: this.intent(handoff), receipt: handoff.receipt_json ? decode(handoff.receipt_json) : null,
        readback: handoff.readback_json ? decode(handoff.readback_json) : null } : null });
  }

  resume(taskId: string, expectedVersion: number): TaskRecord {
    const task = this.getTask(taskId); this.assertBinding(task); this.assertDispatch();
    if (task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请读取当前版本后明确继续。');
    if (task.status === 'needs_review' || task.requiresReview) throw new TaskError('UNKNOWN_RESULT', '先只读核对原交接身份，不能重新派发。');
    const handoff = this.handoff(taskId);
    if (handoff?.cancellation_id && task.status !== 'succeeded') throw new TaskError('CANCELLATION_PENDING', '原交接已明确请求取消，须核对原取消或提交事实。');
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
    if (processing.completion === 'processed') return this.processingResult(processing, output, traces);
    this.assertActive(context);
    const port = this.port();
    let handoff = this.handoff(context.task.id);
    if (!handoff) {
      const originals = this.pages(input.task_id).map((page, ordinal) => sealedObject(`original-${ordinal}.csv`, 'text/csv', sealedBytes(decode<SourcePage>(page.page_json).bytesBase64, 2_000_000)));
      const evidence = [sealedObject('input-manifest.json', 'application/json', encodeArtifact(raw)), sealedObject('plan.json', 'application/json', encodeArtifact(plan)),
        ...traces.map(trace => sealedObject(`${trace.stepId}.json`, 'application/json', encodeArtifact(trace.output))),
        ...traces.map(trace => sealedObject(`verification-${trace.stepId}.json`, 'application/json', encodeArtifact(trace))),
        sealedObject('implementation-bundle.json', 'application/json', implementationBytes()),
        sealedObject('dependencies.json', 'application/json', dependencyManifestBytes())];
      const intent: CollectionHandoffIntent = { environment: 'synthetic-test', requestId: `handoff-request:${context.task.id}`, handoffId: randomUUID(),
        collectionTaskId: input.task_id, processingTaskId: context.task.id, datasetId: this.options.datasetId,
        inputDigest: processing.input_digest, planDigest: processing.plan_digest,
        source: { id: input.input_id, version: input.kind === 'file' ? this.file(input.input_id).version : this.source(input.input_id).version,
          collectedAt: new Date(this.pages(input.task_id).at(-1)!.received_at).toISOString(), kind: input.kind, definitionDigest: input.binding_digest },
        expectedSnapshotId: object(context.task.args).expectedSnapshotId as string | null,
        completionCondition: processing.completion, output: jsonValue(output), originals, evidence, steps: traces.map(jsonValue) };
      this.options.database.transaction(() => {
        this.assertOwner(context);
        this.assertNoUnresolvedHandoff(processing.input_digest, processing.plan_digest, context.task.id);
        this.db.prepare('INSERT INTO collection_handoffs(task_id,handoff_id,request_id,intent_json,intent_digest) VALUES(?,?,?,?,?)')
          .run(context.task.id, intent.handoffId, intent.requestId, encode(intent), digestArtifact(intent));
      });
      handoff = this.handoff(context.task.id)!;
    }
    const intent = this.intent(handoff);
    let receipt: CollectionDatabaseReceipt;
    if (handoff.sent_at !== null) {
      const known = handoff.receipt_json ? decode<CollectionDatabaseReceipt>(handoff.receipt_json) : null;
      receipt = known?.state === 'committed' ? known : await port.lookup(intent.handoffId, { signal: context.signal, intent });
      this.saveReceipt(handoff, receipt, 'lookup', context);
      if (receipt.state === 'accepted' || (receipt.state === 'received' && processing.completion === 'committed')) {
        receipt = await this.dispatchHandoff(context, handoff, intent, 'resume');
      }
    } else {
      receipt = await this.dispatchHandoff(context, handoff, intent, 'ingest');
    }
    if (receipt.state === 'received' && processing.completion === 'received') return this.processingResult(processing, output, traces, receipt);
    if (receipt.state !== 'committed') throw new TaskError(receipt.state === 'received' || receipt.state === 'accepted' ? 'COMMIT_PENDING'
      : receipt.state === 'cancelled' ? 'HANDOFF_CANCELLED' : receipt.state === 'rejected' ? 'DATABASE_REJECTED' : receipt.state === 'failed' ? 'DATABASE_FAILED' : 'HANDOFF_UNKNOWN', '原数据库业务状态尚未满足固定完成条件，请查询原交接事实。');
    handoff = this.handoff(context.task.id)!;
    const readback = handoff.readback_json ? this.validateReadback(decode<CollectionReadback>(handoff.readback_json), receipt, intent)
      : await this.readback(handoff, receipt, context.signal, context);
    return this.processingResult(processing, output, traces, receipt, readback);
  }

  private async dispatchHandoff(context: TaskExecutionContext, handoff: HandoffRow, intent: CollectionHandoffIntent, mode: 'ingest' | 'resume'): Promise<CollectionDatabaseReceipt> {
    this.assertActive(context);
    this.assertNoUnresolvedHandoff(intent.inputDigest, intent.planDigest, context.task.id);
    const effectId = `${mode === 'ingest' ? 'handoff' : 'handoff-resume'}:${intent.handoffId}`;
    await context.emit({ type: 'side_effect_started', effectId, description: mode === 'ingest' ? '向独立数据库交接已封闭材料' : '明确继续数据库已接手的原待办',
      operation: { handoffId: intent.handoffId, requestId: intent.requestId, inputDigest: intent.inputDigest } });
    if (mode === 'ingest') this.options.database.transaction(() => {
      this.assertOwner(context);
      this.db.prepare('UPDATE collection_handoffs SET sent_at=?,effect_attempt_id=?,effect_id=? WHERE task_id=? AND sent_at IS NULL')
        .run(Date.now(), context.attemptId, effectId, context.task.id);
    });
    this.assertActive(context);
    const port = this.port();
    const pending = mode === 'ingest' ? port.ingest(structuredClone(intent), { signal: context.signal })
      : port.resume(intent.handoffId, { signal: context.signal, intent });
    let abandoned = false;
    const confirm = async (receipt: CollectionDatabaseReceipt) => {
      if (['accepted', 'received', 'committed', 'rejected', 'failed', 'cancelled'].includes(receipt.state)) await context.emit({ type: 'side_effect_result', effectId,
        outcome: ['accepted', 'received', 'committed'].includes(receipt.state) ? 'succeeded' : 'failed',
        evidence: `原交接 ${intent.handoffId} 的实际状态为 ${receipt.state}。`, data: jsonValue(receipt) });
    };
    void pending.then(async late => {
      if (!abandoned) return;
      try { this.saveReceipt(handoff, late, `late-${mode}`, context); await confirm(late); }
      catch { /* 迟到事实不能开启新动作，保存失败保留原未知状态。 */ }
    }).catch(() => {});
    let receipt: CollectionDatabaseReceipt;
    try { receipt = await abortable(pending, context.signal); }
    catch { abandoned = true; throw new TaskError('HANDOFF_UNKNOWN', '原交接结果尚未确认；仅可查询同一交接身份，不重新发送。'); }
    this.saveReceipt(handoff, receipt, mode, context);
    await confirm(receipt);
    return receipt;
  }

  async recover(taskId: string): Promise<TaskRecord> {
    const task = this.getTask(taskId); this.assertBinding(task);
    if (task.status === 'succeeded' || task.status === 'cancelled') return task;
    const processing = this.processing(taskId)!, handoff = this.handoff(taskId);
    if (!handoff) throw new TaskError('HANDOFF_NOT_FOUND', '原任务没有待核交接，使用明确继续即可。');
    const intent = this.intent(handoff), receipt = await this.port().lookup(intent.handoffId, { intent });
    this.saveReceipt(handoff, receipt, 'recovery');
    return this.reconcileReceipt(taskId, receipt);
  }

  private async reconcileReceipt(taskId: string, receipt: CollectionDatabaseReceipt): Promise<TaskRecord> {
    const task = this.getTask(taskId), processing = this.processing(taskId)!, handoff = this.handoff(taskId)!, intent = this.intent(handoff);
    if (!['needs_review', 'failed', 'paused', 'interrupted'].includes(task.status)) return task;
    if (receipt.state === 'cancelled' || receipt.state === 'rejected' || receipt.state === 'failed') {
      if (receipt.state === 'cancelled' || task.status === 'needs_review') return this.tasks.reconcile(taskId, { outcome: receipt.state === 'cancelled' ? 'cancelled' : 'failed',
        evidence: `原数据库回执确认 ${receipt.state}；handoff=${intent.handoffId}；receipt=${receipt.receiptId ?? 'none'}` }, task.version);
      return task;
    }
    if (receipt.state !== 'committed' && !(receipt.state === 'received' && processing.completion === 'received')) {
      if (task.status === 'needs_review' && ['accepted', 'received'].includes(receipt.state)) return this.tasks.reconcile(taskId, { outcome: 'pending',
        evidence: `原数据库已登记原交接并持久接手；handoff=${intent.handoffId}；job=${receipt.databaseTaskId}；state=${receipt.state}` }, task.version);
      return task;
    }
    const readback = receipt.state === 'committed' ? handoff.readback_json
      ? this.validateReadback(decode<CollectionReadback>(handoff.readback_json), receipt, intent) : await this.readback(handoff, receipt) : undefined;
    const traces = this.savedTraces(processing), output = getStructuredOutput(traces.at(-1)!.output);
    const result = this.processingResult(processing, output, traces, receipt, readback);
    return this.tasks.reconcile(taskId, { outcome: 'succeeded', result, evidence: `按原交接身份核得 ${receipt.state}，已验证固定结果；handoff=${intent.handoffId}；receipt=${receipt.receiptId}` }, task.version);
  }

  async cancel(taskId: string, cancellationId: string): Promise<TaskRecord> {
    sourceId(cancellationId);
    const task = this.getTask(taskId);
    if (task.status === 'succeeded') return task;
    const handoff = this.handoff(taskId);
    if (!handoff || handoff.sent_at === null) return this.tasks.cancel(taskId);
    this.assertBinding(task);
    this.options.database.transaction(() => {
      const current = this.handoff(taskId)!;
      if (current.cancellation_id && current.cancellation_id !== cancellationId) throw new TaskError('CANCELLATION_CONFLICT', '同一交接已记录另一取消身份，不能重复生成取消命令。');
      this.db.prepare('UPDATE collection_handoffs SET cancellation_id=?,cancellation_requested_at=COALESCE(cancellation_requested_at,?) WHERE task_id=?')
        .run(cancellationId, Date.now(), taskId);
    });
    await this.tasks.pause(taskId);
    const port = this.port(), intent = this.intent(handoff);
    let receipt = await port.lookup(intent.handoffId, { intent });
    this.saveReceipt(handoff, receipt, 'cancel-barrier');
    if (receipt.state === 'committed') return this.reconcileReceipt(taskId, receipt);
    if (!['received', 'accepted', 'cancelled'].includes(receipt.state)) return this.getTask(taskId);
    if (receipt.state !== 'cancelled') {
      if (this.db.prepare("SELECT 1 FROM collection_observations WHERE task_id=? AND origin='cancel-dispatched' LIMIT 1").get(taskId)) return this.getTask(taskId);
      this.observe(taskId, 'cancel-dispatched', { handoffId: intent.handoffId, cancellationId });
      receipt = await port.cancel(intent.handoffId, cancellationId, { intent });
      this.saveReceipt(handoff, receipt, 'cancel');
    }
    return this.reconcileReceipt(taskId, receipt);
  }

  private saveReceipt(handoff: HandoffRow, receipt: CollectionDatabaseReceipt, origin: string, context?: TaskExecutionContext): void {
    this.observe(handoff.task_id, origin, receipt, context);
    const intent = this.intent(handoff); this.validateReceipt(receipt, intent);
    this.options.database.transaction(() => {
      if (context && !this.owns(context)) return;
      const current = this.handoff(handoff.task_id)!, previous = current.receipt_json ? decode<CollectionDatabaseReceipt>(current.receipt_json) : null;
      if (previous?.state === 'committed' && receipt.state !== 'committed') return;
      this.db.prepare('UPDATE collection_handoffs SET receipt_json=? WHERE task_id=?').run(encode(receipt), handoff.task_id);
    });
  }

  private validateReceipt(receipt: CollectionDatabaseReceipt, intent: CollectionHandoffIntent): void {
    if (!receipt || receipt.environment !== 'synthetic-test' || receipt.ownerService !== 'wfd' || receipt.handoffId !== intent.handoffId || receipt.requestId !== intent.requestId
      || !['accepted', 'received', 'committed', 'rejected', 'failed', 'cancelled', 'unknown', 'not_found'].includes(receipt.state)) throw new TaskError('INVALID_DATABASE_RECEIPT', '数据库回执身份、环境或原始状态不匹配。');
    if (['accepted', 'received', 'committed'].includes(receipt.state)) sourceId(receipt.databaseTaskId);
    if (['received', 'committed'].includes(receipt.state)) {
      sourceId(receipt.receiptId);
      if (typeof receipt.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.contentDigest)) throw new TaskError('INVALID_DATABASE_RECEIPT', '保管接收缺少实际材料摘要。');
    }
    if (receipt.state === 'committed') {
      sourceId(receipt.commitId); sourceId(receipt.snapshotId);
      if (!receipt.outputIdentity) throw new TaskError('INVALID_DATABASE_RECEIPT', '正式提交回执缺少固定输出身份。');
      for (const value of Object.values(receipt.outputIdentity)) sourceId(value);
      if (Object.keys(receipt.outputIdentity).sort().join(',') !== 'definitionRevision,outputId,schemaRevision,unitId') throw new TaskError('INVALID_DATABASE_RECEIPT', '正式输出身份字段不完整。');
    }
    jsonValue(receipt.raw);
  }

  private async readback(handoff: HandoffRow, receipt: CollectionDatabaseReceipt, signal?: AbortSignal, context?: TaskExecutionContext): Promise<CollectionReadback> {
    let returned: CollectionReadback;
    try { returned = await this.port().readSnapshot(receipt, { signal, intent: this.intent(handoff) }); }
    catch { throw new TaskError('READBACK_PENDING', '正式提交事实已保存；固定快照读回尚未完成，仅可重读原快照。'); }
    this.observe(handoff.task_id, 'readback', returned, context);
    const readback = this.validateReadback(returned, receipt, this.intent(handoff));
    this.options.database.transaction(() => this.db.prepare('UPDATE collection_handoffs SET readback_json=? WHERE task_id=?').run(encode(readback), handoff.task_id));
    return readback;
  }

  private validateReadback(readback: CollectionReadback, receipt: CollectionDatabaseReceipt, intent: CollectionHandoffIntent): CollectionReadback {
    const output = object(intent.output);
    if (!readback || readback.environment !== 'synthetic-test' || readback.ownerService !== 'wfd' || readback.snapshotId !== receipt.snapshotId
      || digestArtifact(readback.outputIdentity) !== digestArtifact(receipt.outputIdentity) || !Array.isArray(readback.rows)
      || digestArtifact(readback.rows) !== digestArtifact(output.rows)) throw new TaskError('READBACK_MISMATCH', '实际固定读回的输出身份、范围或数值与交接结果不符。');
    return structuredClone(readback);
  }

  private savedTraces(processing: ProcessingRow): StepExecution[] {
    const input = this.raw(this.input(processing.collection_task_id)), plan = decode<CollectionPlan>(processing.plan_json);
    if (digestArtifact(plan) !== processing.plan_digest || digestArtifact(this.plan(processing.plan_id)) !== processing.plan_digest) throw new TaskError('COLLECTION_VERSION_CONFLICT', '原固定加工计划不可用。');
    let artifact: CollectionArtifact = input;
    return plan.steps.map((step, ordinal) => {
      const row = this.db.prepare('SELECT execution_json FROM collection_steps WHERE task_id=? AND ordinal=?').get(processing.task_id, ordinal);
      if (!row) throw new TaskError('PROCESSING_INCOMPLETE', '尚未保存完整五步产物，不能补写交接完成。');
      const trace = validateStepExecution(decode<StepExecution>(String(row.execution_json)), artifact, plan, this.options.stepRegistry);
      if (trace.stepId !== step.stepId) throw new TaskError('PROCESSING_INCOMPLETE', '步骤身份或顺序不匹配。');
      artifact = trace.output; return trace;
    });
  }

  private processingResult(processing: ProcessingRow, output: unknown, traces: StepExecution[], receipt?: CollectionDatabaseReceipt, readback?: CollectionReadback): TaskResult {
    return { summary: processing.completion === 'processed' ? '受控五步加工完成，未交接正式库。' : receipt?.state === 'committed' ? '原交接已正式提交且固定快照读回一致。' : '原件与结构化材料已获实际保管接收回执。',
      data: jsonValue({ environment: 'synthetic-test', collectionTaskId: processing.collection_task_id, processingTaskId: processing.task_id,
        completionCondition: processing.completion, inputDigest: processing.input_digest, planDigest: processing.plan_digest,
        output, steps: traces.map(trace => ({ stepId: trace.stepId, inputSha256: trace.inputSha256, outputSha256: trace.outputSha256 })),
        receipt: receipt ?? null, readback: readback ?? null }) };
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
  private handoff(taskId: string): HandoffRow | null { return this.db.prepare('SELECT * FROM collection_handoffs WHERE task_id=?').get(taskId) as unknown as HandoffRow ?? null; }
  private intent(row: HandoffRow): CollectionHandoffIntent {
    const intent = decode<CollectionHandoffIntent>(row.intent_json);
    if (digestArtifact(intent) !== row.intent_digest || intent.handoffId !== row.handoff_id || intent.processingTaskId !== row.task_id) throw new TaskError('HANDOFF_INTENT_CHANGED', '原交接意图或身份摘要不一致，禁止重新生成。');
    return intent;
  }
  private getTask(id: string): TaskRecord {
    sourceId(id); const task = this.tasks.get(id);
    if (task.ownerRole !== 'service' || task.runtimeId !== COLLECTION_RUNTIME) throw new TaskError('COLLECTION_TASK_NOT_FOUND', '没有此数据收集任务。');
    return task;
  }
  private file(id: string): FileInputRegistration { const value = this.inputs.get(id); if (!value) throw new TaskError('FILE_INPUT_NOT_REGISTERED', '文件身份未由受信宿主登记。'); return value; }
  private source(id: string): SourceAdapter { const value = this.sources.get(id); if (!value) throw new TaskError('SOURCE_NOT_REGISTERED', '来源身份未由受信宿主登记。'); return value; }
  private plan(id: string): CollectionPlan { const value = this.plans[id]; if (!value || !Object.hasOwn(this.plans, id)) throw new TaskError('PLAN_NOT_REGISTERED', '加工计划未由受信宿主登记。'); return structuredClone(value); }
  private port(): CollectionDatabasePort {
    const port = this.options.databasePort;
    if (!port || port.binding !== 'isolated-synthetic' || !port.contractVersion || !port.contractDigest) throw new TaskError('DATABASE_UNBOUND', '独立数据库窄端口未显式绑定隔离合成合同。');
    return port;
  }
  private assertBinding(task: TaskRecord): void { if (digestArtifact(task.versions) !== digestArtifact(this.versionBinding)) throw new TaskError('COLLECTION_VERSION_CONFLICT', '原任务固定配置或合同版本不同，不能静默换版继续。'); }
  private assertNoUnresolvedHandoff(inputDigest: string | null, planDigest: string, ownTaskId?: string): void {
    if (!inputDigest) return;
    const rows = this.db.prepare(`SELECT h.*,t.status FROM collection_handoffs h
      JOIN collection_processing p ON p.task_id=h.task_id JOIN tasks t ON t.id=h.task_id
      WHERE p.input_digest=? AND p.plan_digest=?`).all(inputDigest, planDigest);
    for (const row of rows) {
      if (row.task_id === ownTaskId) continue;
      const handoff = row as unknown as HandoffRow, intent = this.intent(handoff);
      if (intent.datasetId !== this.options.datasetId || row.status === 'succeeded') continue;
      const receipt = handoff.receipt_json ? decode<CollectionDatabaseReceipt>(handoff.receipt_json) : null;
      if (receipt && ['rejected', 'failed', 'cancelled'].includes(receipt.state)) continue;
      throw new TaskError('COLLECTION_HANDOFF_UNRESOLVED', `相同封闭输入与固定计划已有未完成交接，请核对原 processingTaskId=${handoff.task_id}；handoffId=${handoff.handoff_id}。`);
    }
  }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) throw new TaskError('HARNESS_STOPPED', '服务已停止新的采集、加工和交接派发。'); }
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
function sealedObject(name: string, mediaType: string, bytes: Uint8Array): SealedCollectionObject {
  return { name, mediaType, sha256: bytesDigest(bytes), byteLength: bytes.byteLength, bytesBase64: Buffer.from(bytes).toString('base64') };
}
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

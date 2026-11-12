import { realpathSync, statSync } from 'node:fs';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError, type TaskExecutionContext, type TaskRuntime, type TaskService, type TaskRecord } from '../../platform/jobs/tasks.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import type { R1WorkspaceService } from '../collection/r1-workspace.js';
import { FINANCIAL_LINEAR_ADMISSION_VERSION, readFinancialCalculation, assertFinancialLinearCandidate,
  type FinancialCalculation } from '../collection/data-processing/financial-fixed.js';
import { POLARS_FIXED_VERSION, POLARS_DEPENDENCY_VERSION, polarsFixedVersionBinding,
  projectFinancialPolars, projectMacroYoYPolars, projectWfdMA20Polars, assertMacroYoYCandidate, readMacroYoYCalculation,
  type MacroYoYCalculation } from '../collection/data-processing/polars-fixed.js';
import { verifyUnifiedPolarsForPublication } from './unified-polars-publication-proof.js';
import { verifyProductionDerived } from '../collection/production-verifier.js';
import { WFD_SOURCE_MA_VERSION, readWfdSourceMACalculation, readWfdMASource, evaluateWfdMA20,
  type WfdSourceMACalculation } from './wfd-source-ma.js';

export const UNIFIED_POLARS_RUNTIME = 'bd.algorithms.polars';
export const UNIFIED_POLARS_VERSION = 'bd.algorithms.polars/1';
type PolarsMethod = 'financial_linear' | 'macro_yoy' | 'source_observation_ma';
type Input = { methodId: PolarsMethod; source: { kind: 'fixed_snapshot' };
  calculation: FinancialCalculation | MacroYoYCalculation | WfdSourceMACalculation; usage: { purpose: 'current_compute' } };
type FrozenInput = { input: Input; connection: unknown; python: string };
export interface UnifiedPolarsResult {
  version: typeof UNIFIED_POLARS_VERSION;
  taskId: string; methodId: PolarsMethod; methodVersion: string; implementationVersion: string;
  source: Input['source']; calculation: Input['calculation']; inputDigest: string;
  candidateSha256: string; algorithmDefinition: WfdRecord; rows: WfdRecord[];
  evidence: WfdRecord; computedAt: string; publication: 'candidate_only';
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (v: unknown) => wfdSha256(canonicalWfdJson(v));
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/u.test(v);
const frozenKeys = (value: WfdRecord, allowed: string[]) =>
  Object.keys(value).sort().join(',') === [...allowed].sort().join(',');
export const isUnifiedPolarsMethod = (value: unknown): value is PolarsMethod =>
  value === 'financial_linear' || value === 'macro_yoy' || value === 'source_observation_ma';

/**
 * 内部方法执行器，不是第二个 AGENTS 入口或第二份业务账本。
 * 新 Polars 计算和原 Python 方法都由 algorithms.calculate 发起；
 * 实际任务/版本/结果存于同一 TaskService。旧 bd.polars-fixed 仅保留历史身份。
 */
export class UnifiedPolarsExecution {
  constructor(private readonly options: {
    database: CoreDatabase; tasks(): TaskService; workspace: R1WorkspaceService; processRuntime: ProcessRuntime;
    verifyFinancialReview?(review: NonNullable<FinancialCalculation['compatibilityReview']>): void;
  }) {}
  private get tasks() { return this.options.tasks(); }
  capabilities() {
    let reason: string | null = null;
    try {
      if (!this.options.workspace.capabilities().connection) throw Error('WFD data_only 固定读取连接未装配。');
      const path = this.options.processRuntime.path('polars-python');
      if (!statSync(realpathSync(path)).isFile()) throw Error('Polars 受信程序不是普通文件。');
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    return { status: reason ? 'blocked' as const : 'ready' as const, reason,
      methods: ['financial_linear', 'macro_yoy', 'source_observation_ma'] as const, version: UNIFIED_POLARS_VERSION };
  }
  private normalize(raw: unknown): Input {
    if (!isWfdRecord(raw) || !frozenKeys(raw, ['methodId', 'source', 'calculation', 'usage'])
      || !isUnifiedPolarsMethod(raw.methodId)
      || !isWfdRecord(raw.source) || !frozenKeys(raw.source, ['kind'])
      || raw.source.kind !== 'fixed_snapshot'
      || !isWfdRecord(raw.usage) || !frozenKeys(raw.usage, ['purpose'])
      || raw.usage.purpose !== 'current_compute') {
      return fail('UNIFIED_POLARS_INPUT', '统一 Polars 只接受登记方法、固定快照引用及当前内容计算；不接受自填数据、路径、引擎或历史资格。');
    }
    const calculation = raw.methodId === 'financial_linear' ? readFinancialCalculation(raw.calculation)
      : raw.methodId === 'macro_yoy' ? readMacroYoYCalculation(raw.calculation)
      : readWfdSourceMACalculation(raw.calculation);
    if (raw.methodId === 'financial_linear' && (calculation as FinancialCalculation).operation === 'standardize')
      return fail('UNIFIED_POLARS_METHOD', '统一 Polars 只允许已核验的财务期间算术；来源标准化属于原报生产管线。');
    return { methodId: raw.methodId, source: { kind: 'fixed_snapshot' },
      calculation, usage: { purpose: 'current_compute' } } as Input;
  }
  submit(requestId: string, raw: unknown) {
    if (!id(requestId)) return fail('UNIFIED_POLARS_REQUEST', '需要来自原会话的稳定计算请求编号。');
    const input = this.normalize(raw), originalId = 'unified-polars:' + requestId;
    const saved = this.options.database.connection.prepare('SELECT id FROM tasks WHERE request_id=?')
      .get(originalId) as { id: string } | undefined;
    if (saved) {
      const previous = this.task(saved.id);
      const frozen = previous.args as unknown as FrozenInput;
      if (digest(frozen.input) !== digest(input)) return fail('REQUEST_CONFLICT', '原统一算法任务不能更换方法、来源或参数。');
      return this.view(previous.id);
    }
    const capability = this.capabilities();
    if (capability.status !== 'ready') return fail('UNIFIED_POLARS_UNAVAILABLE', capability.reason ?? '本地执行器尚未准备好。');
    const connection = this.options.workspace.capabilities().connection;
    const python = realpathSync(this.options.processRuntime.path('polars-python'));
    const frozen: FrozenInput = { input, connection, python };
    const versions = { ...polarsFixedVersionBinding(), unifiedPolars: UNIFIED_POLARS_VERSION,
      unifiedConnection: digest(connection), unifiedInput: digest(frozen) };
    const task = this.tasks.create({ title: '统一基础算法：' + input.methodId,
      ownerRole: 'service', runtimeId: UNIFIED_POLARS_RUNTIME, action: 'algorithms.calculate',
      args: JSON.parse(canonicalWfdJson(frozen)) as JsonValue, requestId: originalId, versions });
    if (task.status === 'ready') this.tasks.start(task.id, task.version);
    return this.view(task.id);
  }
  view(taskId: string) {
    const task = this.task(taskId);
    const result = task.status === 'succeeded' ? this.result(task) : null;
    const frozen = task.args as unknown as FrozenInput;
    return { taskId: task.id, requestId: task.requestId, methodId: frozen.input.methodId,
      status: task.status, taskVersion: task.version, requiresReview: task.requiresReview,
      createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
      result, error: task.error ? { code: task.error.code, message: task.error.message } : null,
      publication: { state: 'not_requested' as const }, guidance: result
        ? '结构化计算已完成，尚需 WFD 再次固定来源核验及正式读回。' : null };
  }
  owns(taskId: string): boolean {
    try {
      const task = this.tasks.get(taskId);
      return task.runtimeId === UNIFIED_POLARS_RUNTIME && task.action === 'algorithms.calculate';
    } catch { return false; }
  }
  private task(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.runtimeId !== UNIFIED_POLARS_RUNTIME || task.action !== 'algorithms.calculate')
      return fail('UNIFIED_POLARS_TASK', '不是统一 Polars 计算的原任务身份。');
    return task;
  }
  result(task: TaskRecord): UnifiedPolarsResult {
    const frozen = task.args as unknown as FrozenInput;
    const result = task.result?.data;
    if (!isWfdRecord(result) || result.version !== UNIFIED_POLARS_VERSION || result.taskId !== task.id
      || result.methodId !== frozen.input.methodId || result.inputDigest !== digest(frozen)
      || !Array.isArray(result.rows) || !result.rows.every(isWfdRecord) || !isWfdRecord(result.evidence)
      || result.candidateSha256 !== digest(result.rows)
      || !isWfdRecord(result.algorithmDefinition) || result.publication !== 'candidate_only'
      || result.implementationVersion !== task.versions.polarsWorker)
      return fail('UNIFIED_POLARS_RESULT_CHANGED', '统一计算结果、冻结输入或工作器版本的真实摘要不一致。');
    const rows = result.rows as WfdRecord[], evidence = result.evidence as WfdRecord;
    if (frozen.input.methodId === 'macro_yoy')
      assertMacroYoYCandidate(frozen.input.calculation as MacroYoYCalculation, evidence, rows);
    else if (frozen.input.methodId === 'financial_linear')
      assertFinancialLinearCandidate(frozen.input.calculation as FinancialCalculation, evidence, rows,
        this.options.verifyFinancialReview ?? (() => fail('POLARS_FINANCIAL_REVIEW', '跨修订原文核验未装配。')));
    else {
      if (evidence.version !== WFD_SOURCE_MA_VERSION || !Array.isArray(evidence.frozenInput)
        || typeof evidence.unitCode !== 'string' || evidence.sourceRowsSha256 === undefined
        || evidence.recordVersionsSha256 === undefined
        || digest(rows) !== digest(evaluateWfdMA20(evidence.frozenInput as never, evidence.unitCode)))
        return fail('WFD_MA_RESULT_MISMATCH', '原固定均线任务的全量来源、方法窗口或精确结果证明不一致。');
    }
    return result as unknown as UnifiedPolarsResult;
  }
  async verifyForPublication(taskId: string, signal: AbortSignal) {
    const task = this.task(taskId);
    if (task.status !== 'succeeded' || task.requiresReview) return fail('UNIFIED_POLARS_NOT_READY', '计算任务尚未成功结束。');
    const result = this.result(task);
    // 与原报数据生产共用相同的结构、有限数值与结果摘要门禁。
    // 方法专属财务/宏观独立数值及真实 WFD 来源重读仍由原验证器完成。
    return verifyProductionDerived({
      rows: result.rows, expectedRowsSha256: result.candidateSha256,
      maxRows: 5000, maxBytes: 2_000_000,
    }, async checkedSignal => {
      const reader = this.options.workspace.readProduct.bind(this.options.workspace);
      if (result.methodId === 'source_observation_ma') {
        const refreshed = await readWfdMASource(result.calculation as WfdSourceMACalculation, reader, checkedSignal);
        if (digest(refreshed.connection) !== digest(result.evidence.connection)
          || refreshed.sourceRowsSha256 !== result.evidence.sourceRowsSha256
          || refreshed.recordVersionsSha256 !== result.evidence.recordVersionsSha256
          || digest(refreshed.subject) !== digest(result.evidence.subject)
          || refreshed.unitCode !== result.evidence.unitCode
          || digest(refreshed.rows) !== digest(result.rows))
          return fail('WFD_MA_SOURCE_CHANGED', '发布前重新读取的 WFD 全量来源、记录版本或独立均线结果与原计算不一致。');
        return { version: 'bd.wfd-ma20-publication-proof/1', methodId: result.methodId,
          sourceRowsSha256: refreshed.sourceRowsSha256, recordVersionsSha256: refreshed.recordVersionsSha256,
          resultSha256: digest(refreshed.rows), historyQualification: 'not_asserted' };
      }
      return verifyUnifiedPolarsForPublication(result.methodId === 'financial_linear'
        ? { methodId: 'financial_linear', calculation: result.calculation as FinancialCalculation,
          evidence: result.evidence, rows: result.rows,
          verifyFinancialReview: this.options.verifyFinancialReview ?? (() =>
            fail('POLARS_FINANCIAL_REVIEW', '跨修订原文核验未装配。')) }
        : { methodId: 'macro_yoy', calculation: result.calculation as MacroYoYCalculation,
          evidence: result.evidence, rows: result.rows }, reader, checkedSignal);
    }, signal);
  }
  readonly runtime: TaskRuntime = { id: UNIFIED_POLARS_RUNTIME, execute: async context => {
    const task = context.task;
    if (task.action !== 'algorithms.calculate' || task.runtimeId !== UNIFIED_POLARS_RUNTIME)
      return fail('UNIFIED_POLARS_TASK', '非统一 Polars 计算任务。');
    const frozen = task.args as unknown as FrozenInput, input = this.normalize(frozen.input);
    if (task.versions.unifiedPolars !== UNIFIED_POLARS_VERSION
      || task.versions.unifiedInput !== digest(frozen) || task.versions.unifiedConnection !== digest(frozen.connection)
      || task.versions.polars !== POLARS_FIXED_VERSION || task.versions.polarsDependency !== POLARS_DEPENDENCY_VERSION)
      return fail('UNIFIED_POLARS_FROZEN_CHANGED', '方法、输入或执行器冻结版本已经变化。');
    // The registered path is the permission/process identity; the realpath is the
    // frozen executable target. A stable symlink is valid, a retarget is not.
    const registeredPython = this.options.processRuntime.path('polars-python');
    if (digest(this.options.workspace.capabilities().connection) !== digest(frozen.connection)
      || realpathSync(registeredPython) !== frozen.python)
      return fail('UNIFIED_POLARS_BINDING_CHANGED', '受信 WFD 连接或 Polars 程序与原任务不同。');
    const assertAuthorized = () => {
      context.signal.throwIfAborted();
      if (!this.tasks.isRunActive(context.runId, context.generation)
        || this.tasks.get(task.id).currentAttemptId !== context.attemptId)
        return fail('UNIFIED_POLARS_TASK_STALE', '原任务尝试失效。');
      context.assertAuthorized({ operationId: 'algorithms.polars.execute', operationVersion: 1,
        approvalMode: 'automatic', argsDigest: digestOperationArgs(task.args),
        targets: [{ kind: 'file', path: registeredPython }] },
        [{ action: 'execute', target: { kind: 'file', path: registeredPython } }]);
    };
    assertAuthorized();
    const execution = { context, processRuntime: this.options.processRuntime,
      pythonExecutable: registeredPython, assertAuthorized };
    const output = input.methodId === 'financial_linear'
      ? await projectFinancialPolars(execution, input.calculation as FinancialCalculation,
        this.options.workspace.readProduct.bind(this.options.workspace),
        this.options.verifyFinancialReview ?? (() => fail('POLARS_FINANCIAL_REVIEW', '跨修订原文核验未装配。')))
      : input.methodId === 'macro_yoy'
        ? await projectMacroYoYPolars(execution, input.calculation as MacroYoYCalculation,
          this.options.workspace.readProduct.bind(this.options.workspace))
        : await projectWfdMA20Polars(execution, await readWfdMASource(
          input.calculation as WfdSourceMACalculation,
          this.options.workspace.readProduct.bind(this.options.workspace), context.signal));
    assertAuthorized();
    const rows = JSON.parse(output.jsonBytes.toString('utf8')) as WfdRecord[];
    const evidence = output.evidence as WfdRecord;
    const result: UnifiedPolarsResult = {
      version: UNIFIED_POLARS_VERSION, taskId: task.id, methodId: input.methodId,
      methodVersion: input.methodId === 'financial_linear' ? FINANCIAL_LINEAR_ADMISSION_VERSION
        : input.methodId === 'macro_yoy' ? 'bd.macro-yoy/1' : WFD_SOURCE_MA_VERSION,
      implementationVersion: String(task.versions.polarsWorker), source: input.source,
      calculation: input.calculation, inputDigest: digest(frozen),
      candidateSha256: digest(rows), algorithmDefinition: evidence.algorithmDefinition as WfdRecord,
      rows, evidence, computedAt: new Date().toISOString(), publication: 'candidate_only',
    };
    return { summary: '统一 Polars 算法已按 WFD 固定来源计算；结构化候选已核验，尚未发布。',
      data: JSON.parse(canonicalWfdJson(result)) as JsonValue };
  } };
}

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PermissionService } from '../../platform/security/permissions.js';
import { PermissionError, digestOperationArgs, type PermissionCapability } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import type { JsonValue, TaskEffectRecord, TaskRecoveryResult } from '../../contracts/task-contracts.js';
import { canonical, captureAssets, executeFinancialAssets, financialDigest, verifyAssets, type FinancialAssetBundle } from '../../plugins/financial/local-compute/assets.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import {
  ALGORITHM_CALL_ACTION, ALGORITHM_CONTRACT_VERSION, ALGORITHM_METHODS, ALGORITHM_METHOD_IDS, ALGORITHM_RUNTIME,
  ALGORITHM_TABLE_ADAPTER_VERSION, type AlgorithmBar, type AlgorithmCalendar, type AlgorithmCallRequest, type AlgorithmCatalogView,
  type AlgorithmComputedResult, type AlgorithmData, type AlgorithmDateFormats, type AlgorithmEnvironment, type AlgorithmFieldMapping,
  type AlgorithmFixedSnapshotSource, type AlgorithmGap, type AlgorithmInvalidInterval, type AlgorithmManagedTableSource, type AlgorithmMetadata, type AlgorithmMethodId,
  type AlgorithmResultRow, type AlgorithmSemantics, type AlgorithmSnapshotPort, type AlgorithmSnapshotReference, type AlgorithmSource,
  type AlgorithmAdoptionRecord, type AlgorithmAdoptionView,
  type AlgorithmSubmissionContext, type AlgorithmUsage, type AlgorithmTaskView, type ManagedTableData, type ManagedTableCell, type ManagedTableReader,
} from './algorithm-types.js';
import {
  ELIGIBILITY_HISTORY_MODES, PURPOSE_ELIGIBILITY_RULE_VERSION, combinePurposeEligibilityResults,
  evaluatePurposeEligibility, materialPublicationTimeEvidence,
  type DerivedInputEvidence, type PurposeEligibilityInput, type PurposeEligibilityResult, type PurposeEvidenceClaim,
} from '../collection/purpose-eligibility.js';

const PARAMETERS: Record<AlgorithmMethodId, JsonValue> = {
  ma: { type: 'object', required: ['period'], additionalProperties: false, properties: { period: { type: 'integer', minimum: 1, maximum: 10000 } } },
  macd: { type: 'object', required: ['short_period', 'long_period', 'signal_period', 'init'], additionalProperties: false,
    properties: { short_period: { type: 'integer', const: 12 }, long_period: { type: 'integer', const: 26 },
      signal_period: { type: 'integer', const: 9 }, init: { type: 'string', const: 'first_valid' } } },
  bullish_engulfing: { type: 'object', additionalProperties: false, properties: {} },
};
/**
 * 当前真实 `wfd.data-service/v1` `data.read` 固定快照合同。
 * 只固定实例、产品、具体快照、definition_rev、字段与分页摘要；没有旧 outputIdentity/unitId/schemaRevision。
 */
const SNAPSHOT_CONTRACT: JsonValue = {
  contract: 'wfd.data-service/v1', protocolVersion: 3, operation: 'data.read',
  request: { product_id: 'string', snapshot_id: 'string (latest/current forbidden)', fields: '1..256 unique string',
    limit: '1..1000', cursor: 'opaque string returned by previous page' },
  responseRequired: ['product_id', 'definition_rev', 'snapshot_id', 'commit_id', 'parent_snapshot_id', 'namespace', 'rows_sha256',
    'row_count', 'committed_at', 'definition_sha256', 'descriptor', 'provenance', 'custody', 'coverage', 'rows', 'fields',
    'returned_rows', 'next_cursor'],
  pageVerification: ['每页 product_id/snapshot_id/definition_rev/fields/commit_id/definition_sha256 不变',
    '每页 rows_sha256 与 row_count 不变；拼接后按 canonical rows 重算 sha256',
    'next_cursor 逐页消费；空页带游标、重复页、跨页身份变化均拒绝'],
  referenceShape: { kind: 'wfd_fixed_snapshot', instanceId: 'string', productId: 'string', snapshotId: 'string',
    definitionRevision: 'string', fields: ['timestamp', 'close'], fieldMapping: 'object', semantics: 'object',
    calendar: 'object', range: 'optional {start,end}' },
  port: 'AlgorithmSnapshotPort.read(reference) -> { reference, rows, resolution }',
  requirements: ['只读 data.read；不 data.submit、不写 WFD、不使用 latest、不按名称猜产品',
    'WFD 行值进入算法前仍按显式映射、时区、可得时刻、精度和日历规则校验'],
};
const ADOPTION_SCHEMA = `
CREATE TABLE algorithm_adoptions (
 id TEXT PRIMARY KEY,
 record_json TEXT NOT NULL,
 record_digest TEXT NOT NULL,
 adopted_at INTEGER NOT NULL
);
`;
const SCHEMA = `
CREATE TABLE algorithm_assets (version TEXT PRIMARY KEY, bundle_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE algorithm_calls (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 request_id TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 method_id TEXT NOT NULL,
 method_version TEXT NOT NULL,
 implementation_version TEXT NOT NULL,
 parameters_json TEXT NOT NULL,
 source_json TEXT NOT NULL,
 source_digest TEXT NOT NULL,
 sealed_json TEXT,
 sealed_digest TEXT,
 raw_result_json TEXT,
 raw_result_digest TEXT,
 result_json TEXT,
 result_digest TEXT,
 state TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX algorithm_calls_created ON algorithm_calls(created_at);
`;
interface CallRow {
  task_id: string; request_id: string; request_json: string; request_digest: string;
  method_id: AlgorithmMethodId; method_version: string; implementation_version: string;
  parameters_json: string; source_json: string; source_digest: string;
  sealed_json: string | null; sealed_digest: string | null;
  raw_result_json: string | null; raw_result_digest: string | null;
  result_json: string | null; result_digest: string | null;
  state: string; created_at: number; updated_at: number;
}
interface SealedInput {
  data: AlgorithmData;
  reference: JsonValue;
  raw: JsonValue | null;
  /** 共用用途资格：输入冻结后的判定、实际派生依赖可得时间。 */
  eligibility?: PurposeEligibilityResult | null;
  /** 冻结当时的完整判定输入；恢复执行时按当前规则/证据重判，不复用旧结论。 */
  eligibilityInputs?: PurposeEligibilityInput[];
  derivedInputs?: DerivedInputEvidence[];
  restriction?: PurposeEligibilityInput['restriction'];
}

export interface LocalAlgorithmServiceOptions {
  database: CoreDatabase;
  tasks(): TaskService;
  permissions: PermissionService;
  computeAssetsRoot: string;
  expectedAssetsVersion?: string;
  /** 受控采用时冻结的实际 TS 输入转换/时间/结果校验代码摘要；缺省只用于隔离测试。 */
  expectedCodeVersion?: string;
  pythonExecutable: string;
  processRuntime: ProcessRuntime;
  tables?: ManagedTableReader;
  snapshots?: AlgorithmSnapshotPort;
  environment?: AlgorithmEnvironment;
  /** 受控采用后由受信宿主设为 true；本类不会自行写权限或登记。 */
  enabled?: boolean;
  now?: () => number;
}

/**
 * 已有基础算法的本机受控入口。
 *
 * 只做三件事：从已受管表/固定快照形成显式输入，经 TaskService 与 ProcessRuntime 调用既有第一方
 * Python 实现，保管并读回结果。计算与数据库发布分离；本类没有发布写者。
 */
export class LocalAlgorithmService {
  readonly versionBinding: Record<string, string | null>;
  private readonly bundle: FinancialAssetBundle;
  private readonly codeBinding: { version: string; files: Record<string, string> };
  private readonly runtimeDigest: string;
  private readonly assetsRoot: string;
  private readonly pythonExecutable: string;
  private readonly environment: AlgorithmEnvironment;
  private readonly staticEnabled: boolean;
  private readonly tables: ManagedTableReader | undefined;
  private readonly snapshots: AlgorithmSnapshotPort | undefined;
  private readonly now: () => number;

  constructor(private readonly options: LocalAlgorithmServiceOptions) {
    this.environment = options.environment ?? 'local-review';
    if (!['local-review', 'synthetic-test'].includes(this.environment)) throw new TaskError('ALGORITHM_NOT_ENABLED', '算法入口只允许本机预览或隔离合成环境。');
    // 静态 enabled 只在隔离合成测试使用；本机预览必须由持久受控采用记录驱动。
    this.staticEnabled = options.enabled === true && this.environment === 'synthetic-test';
    this.assetsRoot = realpathSync(options.computeAssetsRoot);
    this.bundle = captureAssets(this.assetsRoot);
    if (options.expectedAssetsVersion !== undefined && this.bundle.version !== options.expectedAssetsVersion) {
      throw new TaskError('ALGORITHM_IMPLEMENTATION_CHANGED', '实际封闭算法实现与受控采用摘要不一致。');
    }
    if (!isAbsolute(options.pythonExecutable)) throw new TaskError('ALGORITHM_DEPENDENCY_UNAVAILABLE', 'Python 运行环境必须由受信宿主明确指定。');
    this.pythonExecutable = realpathSync(options.pythonExecutable);
    if (!statSync(this.pythonExecutable).isFile()) throw new TaskError('ALGORITHM_DEPENDENCY_UNAVAILABLE', '指定 Python 运行环境不是普通可执行文件。');
    this.runtimeDigest = binaryDigest(this.pythonExecutable);
    this.codeBinding = captureCodeBinding();
    if (options.expectedCodeVersion !== undefined && this.codeBinding.version !== options.expectedCodeVersion) {
      throw new TaskError('ALGORITHM_IMPLEMENTATION_CHANGED', '实际 TS 输入转换/时间/结果校验代码摘要与受控采用记录不一致。');
    }
    this.tables = options.tables;
    this.snapshots = options.snapshots;
    this.now = options.now ?? Date.now;
    this.versionBinding = Object.freeze({ algorithms: ALGORITHM_CONTRACT_VERSION, implementation: this.bundle.version,
      implementationCode: this.codeBinding.version, environment: this.environment, python: this.runtimeDigest,
      tableAdapter: ALGORITHM_TABLE_ADAPTER_VERSION, snapshot: this.snapshots ? 'bound' : 'unbound' });
    options.database.migrate('algorithms', 1, SCHEMA);
    options.database.migrate('algorithm_adoptions', 1, ADOPTION_SCHEMA);
    this.db.prepare('INSERT OR IGNORE INTO algorithm_assets VALUES(?,?,?)').run(this.bundle.version, canonical(this.bundle), Date.now());
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  /** 只读采用状态：记录存在且当前实现、代码与 Python 摘要一致才算已采用；不读取目录不代表采用。 */
  adoptionStatus(): AlgorithmAdoptionView {
    const current = { environment: this.environment, assetsVersion: this.bundle.version,
      codeVersion: this.codeBinding.version, pythonDigest: this.runtimeDigest };
    const required = { environment: 'local-review' as const, expectedAssetsVersion: this.bundle.version,
      expectedCodeVersion: this.codeBinding.version, confirmation: 'adopt-local-review' as const };
    const row = this.db.prepare("SELECT record_json,record_digest FROM algorithm_adoptions WHERE id='local-review'").get() as
      { record_json: string; record_digest: string } | undefined;
    if (!row) return { state: 'not_adopted', reason: '尚未记录受控采用；读取目录、调用目录接口或装配服务都不会自动采用。', current, record: null, required };
    try {
      const adoption = JSON.parse(row.record_json) as AlgorithmAdoptionRecord;
      if (financialDigest(adoption) !== row.record_digest || adoption.version !== 1
        || adoption.environment !== current.environment) throw new TaskError('ALGORITHM_ADOPTION_CHANGED', '采用记录摘要、版本或环境不符。');
      if (adoption.assetsVersion !== current.assetsVersion || adoption.codeVersion !== current.codeVersion
        || adoption.pythonDigest !== current.pythonDigest) {
        return { state: 'stale', reason: '当前算法源码、TS 输入转换/结果校验代码或 Python 运行身份与采用记录不同；需重新核对后采用。',
          current, record: adoption, required };
      }
      return { state: 'adopted', reason: null, current, record: adoption, required };
    } catch (error) {
      return { state: 'stale', reason: `采用记录无法核对：${describeError(error)}`, current, record: null, required };
    }
  }

  /**
   * 受控采用的最小写入口。只允许本机预览环境，且必须逐字提供当前两个摘要和确认短语；
   * 不授予权限、不写 machine.bindings、不触发计算，也不改变真实数据库绑定。
   */
  adopt(value: unknown): AlgorithmAdoptionView {
    const body = record(value, '采用请求');
    exact(body, ['expectedAssetsVersion', 'expectedCodeVersion', 'confirmation'], '采用请求');
    if (this.environment !== 'local-review') throw new TaskError('ALGORITHM_ADOPTION_SCOPE', '当前只允许在本机预览环境记录受控采用。');
    if (body.confirmation !== 'adopt-local-review') throw new TaskError('ALGORITHM_ADOPTION_CONFIRMATION', '采用请求缺少逐字确认短语。');
    if (body.expectedAssetsVersion !== this.bundle.version || body.expectedCodeVersion !== this.codeBinding.version) {
      throw new TaskError('ALGORITHM_ADOPTION_MISMATCH', '提供的资产或代码摘要与当前实际实现不同；拒绝采用。');
    }
    const adoptedAt = new Date(this.now()).toISOString();
    const adoption: AlgorithmAdoptionRecord = { version: 1, environment: 'local-review', assetsVersion: this.bundle.version,
      codeVersion: this.codeBinding.version, codeFiles: this.codeBinding.files, fileHashes: this.bundle.hashes,
      pythonDigest: this.runtimeDigest, assetsRoot: this.assetsRoot, adoptedAt };
    this.db.prepare(`INSERT INTO algorithm_adoptions(id,record_json,record_digest,adopted_at) VALUES('local-review',?,?,?)
      ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,record_digest=excluded.record_digest,adopted_at=excluded.adopted_at`)
      .run(canonical(adoption), financialDigest(adoption), this.now());
    return this.adoptionStatus();
  }
  private isEnabled(): boolean { return this.staticEnabled || this.adoptionStatus().state === 'adopted'; }

  catalog(): AlgorithmCatalogView {
    const tableState = this.tableCatalog(), snapshotState = this.snapshotCatalog(), permission = this.executionPermission();
    const enabled = this.isEnabled(), adoption = this.adoptionStatus();
    const hasInput = (tableState.status === 'available' && tableState.items.length > 0) || snapshotState.status === 'available';
    const reason = !enabled ? adoption.reason ?? '算法计算入口尚未启用；需在受控采用并由本机审核后开启。'
      : permission.permission === 'unavailable' ? '无法读取当前权限账本，不能确认执行资格。'
      : !hasInput ? '没有可用的已受管表或固定快照输入；请先在数据页完成材料接收或明确固定快照引用。' : null;
    const methods = ALGORITHM_METHOD_IDS.map((id): AlgorithmCatalogView['methods'][number] => {
      const method = ALGORITHM_METHODS[id], status = !enabled || permission.permission === 'unavailable' ? 'unavailable' as const : !hasInput ? 'blocked' as const : 'ready' as const;
      return { id, title: method.title, description: method.description, status,
        reason: status === 'ready' ? null : reason,
        methodVersion: method.version, implementationVersion: this.bundle.version, parameters: PARAMETERS[id],
        requiredFields: [...method.requiredFields], outputFields: [...method.outputFields], limitations: [...method.limitations],
        methodEvidence: json({ source: method.source, reference: method.reference, implementationVersion: this.bundle.version,
          fileHashes: this.bundle.hashes, tableAdapter: ALGORITHM_TABLE_ADAPTER_VERSION }) };
    });
    return { contractVersion: ALGORITHM_CONTRACT_VERSION, runtime: ALGORITHM_RUNTIME, environment: this.environment,
      status: enabled && hasInput && permission.permission !== 'unavailable' ? 'available' : 'unavailable', enabled, reason, adoption,
      implementation: { version: this.bundle.version, files: this.bundle.hashes, codeVersion: this.codeBinding.version,
        codeFiles: this.codeBinding.files, binding: 'source-code', bindingRequired: false },
      execution: { pythonDigest: this.runtimeDigest, permission: permission.permission, reason: permission.reason },
      methods, inputs: { managedTables: tableState, fixedSnapshots: snapshotState },
      limitations: ['本算法入口不提供复权工具或分钟/日线加工；缺少复权基准、时区或日历完整性时返回明确缺项。限定日线/分钟任务另由数据库固定计算入口提供。',
        '固定快照只按真实 wfd.data-service/v1 data.read 固定实例/产品/快照/定义/分页读取；不读 latest、不写 WFD。',
        '计算结果保留在原任务，本模块没有数据库写者。旧通用候选已停止新建和首次提交；新计算与发布须使用数据库固定计算及 R1 结构化交接入口，并符合其支持范围。'] };
  }

  submit(requestId: string, value: unknown, submission?: AlgorithmSubmissionContext): AlgorithmTaskView {
    identifier(requestId, '请求编号');
    const normalized = normalizeRequest(value);
    const existing = this.callByRequest(requestId);
    if (existing) {
      // 用途证据的受理时间不是请求身份的一部分；重复同一请求必须仍可复开，
      // 不能因本次受理时间不同而误报冲突。
      const stored = this.requestOf(existing);
      if (financialDigest(withoutPurposeEvidence(stored)) !== financialDigest(normalized)) {
        throw new TaskError('REQUEST_CONFLICT', '相同计算请求编号不能换方法、参数、输入表或语义。');
      }
      return this.reopenOrView(existing);
    }
    const request = attachPurposeEvidence(normalized, submission, this.now());
    const digest = financialDigest(request);
    this.assertEnabled(); this.assertDispatch();
    const method = ALGORITHM_METHODS[request.methodId];
    const versions = { ...this.versionBinding, method: method.version, implementation: this.bundle.version };
    const now = this.now();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: `基础算法计算：${method.title}`, ownerRole: 'service', runtimeId: ALGORITHM_RUNTIME,
        action: ALGORITHM_CALL_ACTION, args: json(request), requestId: requestKey(requestId), versions });
      this.db.prepare(`INSERT INTO algorithm_calls(task_id,request_id,request_json,request_digest,method_id,method_version,implementation_version,
        parameters_json,source_json,source_digest,sealed_json,sealed_digest,raw_result_json,raw_result_digest,result_json,result_digest,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,'accepted',?,?)`)
        .run(accepted.task.id, requestId, canonical(request), digest, request.methodId, method.version, this.bundle.version,
          canonical(request.parameters), canonical(request.source), financialDigest(request.source), now, now);
    });
    accepted.publish();
    this.tasks.start(accepted.task.id);
    return this.view(accepted.task.id);
  }

  view(taskId: string): AlgorithmTaskView {
    const task = this.getTask(taskId), row = this.callRow(task.id);
    // 只读历史结果只核原任务身份和持久摘要；当前源码/Python 变化不能使旧结果失去查询。
    this.assertTaskIdentity(task, row);
    const result = task.status === 'succeeded' ? this.loadResult(task, row) : null;
    return { taskId: task.id, requestId: row.request_id, methodId: row.method_id, status: task.status, taskVersion: task.version,
      requiresReview: task.requiresReview, createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
      result, error: task.error ? { code: task.error.code, message: task.error.message } : null,
      publication: { state: 'not_requested' }, guidance: guidanceFor(task) };
  }

  resume(taskId: string, expectedVersion: number): AlgorithmTaskView {
    const task = this.getTask(taskId);
    if (task.status === 'succeeded') return this.view(taskId);
    this.assertEnabled(); this.assertDispatch(); this.assertExecutionBinding(task, this.callRow(task.id));
    if (task.requiresReview || task.status === 'needs_review') throw new TaskError('UNKNOWN_RESULT', '原结果未知；先按原任务核对，不能借恢复重算。');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请按当前版本重新读取。');
    if (task.status === 'ready') this.tasks.start(taskId, expectedVersion);
    else if (task.status === 'paused') this.tasks.resume(taskId, expectedVersion);
    else if (task.status === 'interrupted') throw new TaskError('UNKNOWN_RESULT', '原尝试已中断，结果未知；先按原任务核对，不能自动重算。');
    else if (task.status === 'failed' || task.status === 'cancelled') throw new TaskError('ALGORITHM_NEW_REQUEST_REQUIRED', '原尝试已结束；如需改变输入或重新执行，请建立新请求编号。');
    else throw new TaskError('TASK_BUSY', '当前计算尚未收束，不能开启另一尝试。');
    return this.view(taskId);
  }

  readonly runtime: TaskRuntime = { id: ALGORITHM_RUNTIME, execute: context => this.execute(context),
    recover: context => this.recover(context) };

  private async execute(context: TaskExecutionContext): Promise<TaskResult> {
    let raw: JsonValue | undefined;
    try {
      this.assertActive(context); this.assertExecutionBinding(context.task, this.callRow(context.task.id));
      let row = this.callRow(context.task.id);
      const request = this.requestOf(row), sealed = await this.ensureSealed(context, request, row);
      row = this.callRow(context.task.id);
      if (!row.sealed_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '封闭输入摘要缺失。');
      const method = ALGORITHM_METHODS[request.methodId];
      const operation = { operationId: 'algorithms.calculate', operationVersion: 1, approvalMode: 'review' as const,
        argsDigest: digestOperationArgs({ methodId: request.methodId, methodVersion: method.version,
          implementationVersion: row.implementation_version, sealedDigest: row.sealed_digest, parameters: request.parameters }),
        targets: [{ kind: 'file' as const, path: this.pythonExecutable }] };
      const capabilities: PermissionCapability[] = [{ action: 'execute', target: { kind: 'file', path: this.pythonExecutable } }];
      const approvalId = await this.authorize(context, operation, capabilities);
      const assertAuthorized = () => { this.assertActive(context); this.assertExecutionBinding(context.task, this.callRow(context.task.id)); context.assertAuthorized(operation, capabilities, { approvalId }); };
      assertAuthorized();
      raw = await executeFinancialAssets({ bundle: this.loadBundle(row.implementation_version),
        request: json({ version: 1, kind: method.kind, operation: method.operation, params: request.parameters, data: sealed.data }),
        processRuntime: this.options.processRuntime, pythonExecutable: this.pythonExecutable, cwd: '/', context, assertAuthorized });
      assertAuthorized();
      const result = this.buildResult(context.task, row, request, sealed, raw);
      this.options.database.transaction(() => {
        this.assertActive(context); this.assertExecutionBinding(context.task, this.callRow(context.task.id));
        this.db.prepare(`UPDATE algorithm_calls SET raw_result_json=?,raw_result_digest=?,result_json=?,result_digest=?,state='computed',updated_at=? WHERE task_id=?`)
          .run(canonical(raw), financialDigest(raw), canonical(result), financialDigest(result), this.now(), context.task.id);
      });
      return { summary: `${method.title}计算完成；结果为本地候选，尚未发布。`, data: json(result) };
    } catch (error) {
      try {
        this.db.prepare(`UPDATE algorithm_calls SET raw_result_json=COALESCE(?,raw_result_json),raw_result_digest=COALESCE(?,raw_result_digest),state='failed',updated_at=? WHERE task_id=?`)
          .run(raw === undefined ? null : canonical(raw), raw === undefined ? null : financialDigest(raw), this.now(), context.task.id);
      } catch { /* 原错误优先；状态更新失败不能在主错误之外制造第二事实。 */ }
      throw error;
    }
  }

  private async ensureSealed(context: TaskExecutionContext, request: AlgorithmCallRequest, row: CallRow): Promise<SealedInput> {
    if (row.sealed_json) {
      const sealed = JSON.parse(row.sealed_json) as SealedInput;
      if (financialDigest(sealed) !== row.sealed_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '原任务封闭输入与摘要不符。');
      validateData(sealed.data);
      if (!Array.isArray(sealed.eligibilityInputs) || !sealed.eligibilityInputs.length) {
        throw new TaskError('ALGORITHM_ELIGIBILITY_EVIDENCE_MISSING', '原封闭输入没有可重判的共用用途资格证据；不能复用旧资格继续执行。');
      }
      const revalidated = assertEligibilityResult(combinePurposeEligibilityResults(
        sealed.eligibilityInputs.map(item => evaluatePurposeEligibility(item))));
      if (!sealed.eligibility || sealed.eligibility.evidenceSha256 !== revalidated.evidenceSha256) {
        throw new TaskError('ALGORITHM_ELIGIBILITY_CHANGED', '共用用途规则/证据重判结果与原冻结资格不同；保留原号查询，不沿旧资格执行。');
      }
      return sealed;
    }
    let data: AlgorithmData, reference: JsonValue;
    let eligibility: PurposeEligibilityResult, derivedInputs: DerivedInputEvidence[];
    let eligibilityInputs: PurposeEligibilityInput[] = [];
    let restriction: PurposeEligibilityInput['restriction'] = null;
    if (request.source.kind === 'managed_table') {
      const resolved = this.resolveManagedTable(request.source, request.usage);
      data = resolved.data;
      reference = json(this.managedReference(request.source, data, resolved.table, resolved.numeric));
      const managedSource = request.source;
      const input = managedTableEligibilityInput(request, managedSource, resolved.latestAvailableAtUtc);
      eligibility = assertEligibilityResult(evaluatePurposeEligibility(input));
      eligibilityInputs = [input];
      derivedInputs = data.rows.map((item, index) => ({ ref: item.timestamp,
        latestAvailableAtUtc: item.available_at,
        basis: `受管表逐行可得时间(${index}); 来源保留原值`,
        evidenceSha256: wfdSha256(canonicalWfdJson({ material: managedSource.materialSha256, timestamp: item.timestamp,
          available_at: item.available_at })) }));
    } else {
      const resolved = await this.snapshotRead(context, request.source, request);
      data = resolved.data;
      reference = resolved.reference;
      eligibility = resolved.eligibility;
      eligibilityInputs = resolved.eligibilityInputs;
      derivedInputs = resolved.derivedInputs;
      restriction = resolved.restriction;
    }
    const sealed: SealedInput = { data, reference, raw: null, eligibility, eligibilityInputs, derivedInputs,
      ...(restriction !== undefined ? { restriction } : {}) };
    validateData(sealed.data);
    const sealedJson = canonical(sealed);
    if (Buffer.byteLength(sealedJson) > 400_000) throw new TaskError('ALGORITHM_INPUT_BUDGET', '封闭输入超过本包保管预算。');
    const digest = financialDigest(sealed);
    this.options.database.transaction(() => {
      this.assertActive(context); this.assertExecutionBinding(context.task, this.callRow(context.task.id));
      this.db.prepare('UPDATE algorithm_calls SET sealed_json=?,sealed_digest=?,updated_at=? WHERE task_id=? AND sealed_json IS NULL')
        .run(sealedJson, digest, this.now(), context.task.id);
    });
    const updated = this.callRow(context.task.id);
    if (!updated.sealed_json || financialDigest(JSON.parse(updated.sealed_json)) !== updated.sealed_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '封闭输入未能按原任务摘要持久保存。');
    await context.emit({ type: 'checkpoint', checkpoint: { phase: 'input-sealed', inputDigest: updated.sealed_digest,
      implementationVersion: row.implementation_version, methodVersion: row.method_version } });
    return JSON.parse(updated.sealed_json) as SealedInput;
  }

  private async snapshotRead(context: TaskExecutionContext, source: AlgorithmFixedSnapshotSource, request: AlgorithmCallRequest):
    Promise<{ data: AlgorithmData; reference: JsonValue; eligibility: PurposeEligibilityResult;
      eligibilityInputs: PurposeEligibilityInput[]; derivedInputs: DerivedInputEvidence[];
      restriction: PurposeEligibilityInput['restriction'] }> {
    if (!this.snapshots) throw new TaskError('ALGORITHM_SNAPSHOT_UNBOUND', '固定快照端口尚未装配；当前只支持本地已受管表。');
    const reference = source.reference;
    // 历史用途与实际读取视角/截止必须逐项绑定；不能只改用途标签。
    const usage = request.usage;
    if (usage?.purpose === 'historical_compute') {
      if (!usage.historyMode || !usage.cutoff) throw new TaskError('ALGORITHM_HISTORY_BINDING_REQUIRED', '历史算法请求须显式选择历史模式并固定截止。');
      if (reference.perspective !== usage.historyMode || reference.at !== usage.cutoff) {
        throw new TaskError('ALGORITHM_HISTORY_BINDING_REQUIRED', '固定快照读取视角/截止与本次历史用途不一致；不接受只改用途或只改标签。');
      }
      if (reference.includeHistory === true) throw new TaskError('ALGORITHM_HISTORY_INCLUDE_UNSUPPORTED', '本算法入口只接受截止时唯一有效叶；不把全部历史修订混入同一序列。');
      if (usage.historyMode === 'system_held_at' && (!reference.heldScope || !reference.usableStage)) {
        throw new TaskError('ALGORITHM_HOLDING_BINDING_REQUIRED', 'system_held_at 须显式固定 held_scope 与 usable_stage，并由实际 WFD 持有台账返回。');
      }
    } else if (reference.perspective !== undefined && reference.perspective !== 'snapshot_contents') {
      throw new TaskError('ALGORITHM_HISTORY_PURPOSE_REQUIRED', '固定快照带了历史视角但请求用途不是历史计算；不静默升级资格。');
    } else if (reference.at !== undefined) {
      throw new TaskError('ALGORITHM_HISTORY_PURPOSE_REQUIRED', '固定快照带了历史截止但请求用途不是历史计算；不静默升级资格。');
    }
    const read = await this.snapshots.read(structuredClone(reference), { signal: context.signal, taskId: context.task.id });
    if (financialDigest(read.reference) !== financialDigest(reference)) throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '快照读取返回的固定身份、字段或范围与请求不同。');
    if (!Array.isArray(read.evidence) || read.evidence.length !== read.rows.length) {
      throw new TaskError('ALGORITHM_SNAPSHOT_ELIGIBILITY_EVIDENCE_MISSING', '固定快照端口未返回逐行实际资格/公开时间/修订/限制证据；不能调用共用规则前先假报通过。');
    }
    const numeric = newNumericEvidence();
    const asOf = usage?.purpose === 'historical_compute' && usage.cutoff ? new Date(usage.cutoff).toISOString() : new Date(this.now()).toISOString();
    const rows: AlgorithmBar[] = [];
    const rowAvailableAt = new Map<number, string>();
    const selected: Array<{ timestamp: string; row: Record<string, JsonValue>; evidenceIndex: number }> = [];
    for (const [evidenceIndex, row] of read.rows.entries()) {
      const timestamp = parseDay(jsonText(row, reference.fieldMapping.timestamp, 'timestamp'), reference.dateFormat);
      if (reference.range && (timestamp < reference.range.start || timestamp > reference.range.end)) continue;
      selected.push({ timestamp, row, evidenceIndex });
    }
    if (!selected.length) throw new TaskError('ALGORITHM_EMPTY_RANGE', '固定快照的明确范围没有可用数据行。');
    if (selected.length > 512) throw new TaskError('ALGORITHM_INPUT_BUDGET', `本次选定 ${selected.length} 条日线观测，超过当前算法入口 512 条上限；未截断采用，请缩小明确范围。`);
    const eligibilityInputs: PurposeEligibilityInput[] = [];
    for (const { timestamp, row, evidenceIndex } of selected) {
      const close = jsonNumber(row, reference.fieldMapping.close, 'close', timestamp, numeric);
      const open = optionalJsonNumber(row, reference.fieldMapping.open, 'open', timestamp, numeric);
      const high = optionalJsonNumber(row, reference.fieldMapping.high, 'high', timestamp, numeric);
      const low = optionalJsonNumber(row, reference.fieldMapping.low, 'low', timestamp, numeric);
      validateOhlc(timestamp, close, open, high, low);
      const available_at = reference.semantics.availability.kind === 'column'
        ? parseInstant(jsonText(row, required(reference.fieldMapping.available_at, 'available_at 映射'), 'available_at'), timestamp)
        : zonedInstant(timestamp, reference.semantics.availability.closeTime, reference.semantics.timezone);
      if (Date.parse(available_at) > Date.parse(asOf)) throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `第 ${timestamp} 条数据的可得时刻晚于本次计算声明时刻。`);
      if (zonedDay(Date.parse(available_at), reference.semantics.timezone) < timestamp) throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `第 ${timestamp} 条数据的可得时刻早于业务日期。`);
      rowAvailableAt.set(evidenceIndex, available_at);
      rows.push({ timestamp, close, ...(open === undefined ? {} : { open }), ...(high === undefined ? {} : { high }),
        ...(low === undefined ? {} : { low }), available_at, bar_closed: true as const });
      const evidence = read.evidence[evidenceIndex]!;
      eligibilityInputs.push({
        ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
        purpose: usage?.purpose ?? 'current_compute',
        purposeEvidence: usage?.purposeEvidence ?? null,
        history: { mode: usage?.historyMode ?? null, cutoff: usage?.cutoff ?? null, perspective: usage?.perspective ?? null },
        object: evidence.object,
        publicationTime: evidence.publicationTime,
        holdingTime: evidence.holdingTime,
        revisions: evidence.revision ? [evidence.revision] : null,
        wfdHistory: evidence.wfdHistory,
        restriction: evidence.restriction,
        derived: null,
        wfdDecision: evidence.wfdDecision,
      });
    }
    assertStrictDates(rows, reference.calendar);
    const metadata: AlgorithmMetadata = { series_id: ('wfd.' + reference.productId + '.' + reference.snapshotId).replace(/[^A-Za-z0-9_.:@+-]/gu, '_'),
      subject: reference.semantics.subject, frequency: '1d', timezone: reference.semantics.timezone,
      price_unit: 'currency_per_share', currency: reference.semantics.currency, adjustment: reference.semantics.adjustment,
      adjustment_basis: reference.semantics.adjustmentBasis, window_start: rows[0]!.timestamp, window_end: rows.at(-1)!.timestamp,
      as_of: asOf, availability_basis: reference.semantics.availability.kind === 'column' ? 'explicit_per_bar' : 'declared_bar_close',
      bar_closed: true, observations_are_consecutive: true,
      calendar_verification: reference.calendar.mode === 'dense' ? 'dense' : reference.calendar.mode === 'declared' ? 'declared' : 'not_verified',
      synthetic: reference.semantics.synthetic };
    const data: AlgorithmData = { metadata, rows };
    validateData(data);
    const eligibility = assertEligibilityResult(combinePurposeEligibilityResults(eligibilityInputs.map(item => evaluatePurposeEligibility(item))));
    const derivedInputs = selected.map(({ timestamp, evidenceIndex }) => {
      const bundle = read.evidence![evidenceIndex]!;
      const publication = bundle.publicationTime;
      const availableAt = rowAvailableAt.get(evidenceIndex) ?? null;
      const historyMode = request.usage?.historyMode ?? null;
      // 历史模式决定依赖可得证据：holding 用实际 held_at，market_known 用公开时间与逐行 available_at 较晚者。
      const latest = historyMode === 'system_held_at'
        ? bundle.holdingTime?.status === 'known' ? bundle.holdingTime.receivedAtUtc : null
        : [publication.latestExclusiveUtc ?? publication.earliestUtc, availableAt]
          .filter((item): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)))
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
      return { ref: timestamp, latestAvailableAtUtc: latest,
        basis: historyMode === 'system_held_at'
          ? `actual held_at=${bundle.holdingTime?.receivedAtUtc ?? 'unknown'}; mode=system_held_at`
          : `${publication.basis}; actual available_at=${availableAt ?? 'unknown'}; takes later of both`,
        evidenceSha256: wfdSha256(canonicalWfdJson({ publication: publication.evidenceSha256, availableAt,
          heldAt: bundle.holdingTime?.receivedAtUtc ?? null })) };
    });
    return { data, reference: json({ ...reference, range: { start: metadata.window_start, end: metadata.window_end },
      resolution: read.resolution, numeric: numericEvidence(numeric) }), eligibility,
      eligibilityInputs, derivedInputs, restriction: read.evidence[0]!.restriction };
  }

  private resolveManagedTable(source: AlgorithmManagedTableSource, usage?: AlgorithmCallRequest['usage']): { data: AlgorithmData; table: ManagedTableData; numeric: JsonValue; latestAvailableAtUtc: string } {
    if (!this.tables) throw new TaskError('ALGORITHM_TABLE_UNBOUND', '已受管表读取端口尚未装配。');
    const table = this.tables.read(source.materialId);
    if (table.sha256 !== source.materialSha256) throw new TaskError('ALGORITHM_TABLE_CHANGED', '受管材料摘要与本次明确选择不同，拒绝读取。');
    if (table.format !== source.format) throw new TaskError('ALGORITHM_TABLE_FORMAT_CHANGED', '受管材料格式与本次明确选择不同。');
    // 行切片前先证明拿到的是完整受管原件，而不是目录预览的前 50 行。
    if (!Number.isSafeInteger(table.rowCount) || table.rowCount !== table.rows.length) {
      throw new TaskError('ALGORITHM_TABLE_INCOMPLETE', '受管表读取结果与完整源行数不一致，不能把预览切片当作计算输入。');
    }
    for (const column of new Set(Object.values(source.fieldMapping))) if (!table.columns.includes(column)) throw new TaskError('ALGORITHM_MAPPING_COLUMN', `受管表没有映射字段 ${column}。`);
    const parsed: Array<{ timestamp: string; row: typeof table.rows[number] }> = [];
    for (const row of table.rows) {
      const timestamp = parseDay(cellText(table, row, source.fieldMapping.timestamp, 'timestamp'), source.dateFormat);
      if (source.range && (timestamp < source.range.start || timestamp > source.range.end)) continue;
      parsed.push({ timestamp, row });
    }
    if (!parsed.length) throw new TaskError('ALGORITHM_EMPTY_RANGE', '明确范围或受管表没有可用数据行。');
    if (parsed.length > 512) throw new TaskError('ALGORITHM_INPUT_BUDGET', `本次选定 ${parsed.length} 条日线观测，超过当前算法入口 512 条上限；未截断采用，请缩小明确范围。`);
    const numeric = newNumericEvidence();
    const asOf = usage?.purpose === 'historical_compute' && usage.cutoff ? new Date(usage.cutoff).toISOString() : new Date(this.now()).toISOString();
    const rows: AlgorithmBar[] = parsed.map(({ timestamp, row }) => {
      const close = cellNumber(table, row, source.fieldMapping.close, 'close', timestamp, numeric);
      const open = optionalNumber(table, row, source.fieldMapping.open, 'open', timestamp, numeric);
      const high = optionalNumber(table, row, source.fieldMapping.high, 'high', timestamp, numeric);
      const low = optionalNumber(table, row, source.fieldMapping.low, 'low', timestamp, numeric);
      validateOhlc(timestamp, close, open, high, low);
      const available_at = source.semantics.availability.kind === 'column'
        ? parseInstant(cellText(table, row, required(source.fieldMapping.available_at, 'available_at 映射'), 'available_at'), timestamp)
        : zonedInstant(timestamp, source.semantics.availability.closeTime, source.semantics.timezone);
      if (Date.parse(available_at) > Date.parse(asOf)) throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `第 ${timestamp} 条数据的可得时刻晚于本次计算声明时刻。`);
      if (zonedDay(Date.parse(available_at), source.semantics.timezone) < timestamp) throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `第 ${timestamp} 条数据的可得时刻早于业务日期。`);
      return { timestamp, close, ...(open === undefined ? {} : { open }), ...(high === undefined ? {} : { high }),
        ...(low === undefined ? {} : { low }), available_at, bar_closed: true as const };
    });
    assertStrictDates(rows, source.calendar);
    const metadata: AlgorithmMetadata = { series_id: source.materialId, subject: source.semantics.subject, frequency: '1d',
      timezone: source.semantics.timezone, price_unit: 'currency_per_share', currency: source.semantics.currency,
      adjustment: source.semantics.adjustment, adjustment_basis: source.semantics.adjustmentBasis,
      window_start: rows[0]!.timestamp, window_end: rows.at(-1)!.timestamp, as_of: asOf,
      availability_basis: source.semantics.availability.kind === 'column' ? 'explicit_per_bar' : 'declared_bar_close',
      bar_closed: true, observations_are_consecutive: true,
      calendar_verification: source.calendar.mode === 'dense' ? 'dense' : source.calendar.mode === 'declared' ? 'declared' : 'not_verified',
      synthetic: source.semantics.synthetic };
    const latestAvailable = Math.max(...rows.map(item => Date.parse(item.available_at)));
    return { data: { metadata, rows }, table, numeric: numericEvidence(numeric),
      latestAvailableAtUtc: new Date(latestAvailable).toISOString() };
  }

  private managedReference(source: AlgorithmManagedTableSource, data: AlgorithmData, table: ManagedTableData, numeric: JsonValue): Record<string, unknown> {
    return { kind: 'managed_table', materialId: source.materialId, displayName: table.displayName, materialSha256: source.materialSha256,
      format: source.format, fieldMapping: source.fieldMapping, ...(source.dateFormat ? { dateFormat: source.dateFormat } : {}),
      semantics: source.semantics, calendar: source.calendar, range: { start: data.metadata.window_start, end: data.metadata.window_end },
      totalRows: table.rowCount, selectedRows: data.rows.length, numeric };
  }

  private buildResult(task: TaskRecord, row: CallRow, request: AlgorithmCallRequest, sealed: SealedInput, raw: JsonValue): AlgorithmComputedResult {
    const normalized = validateRawOutput(request, sealed.data, raw);
    const method = ALGORITHM_METHODS[request.methodId];
    const leading = normalized.leading;
    const gaps: AlgorithmGap[] = [];
    if (sealed.data.metadata.calendar_verification === 'not_verified') gaps.push({ code: 'CALENDAR_NOT_VERIFIED',
      message: '未提供交易日历；只核所供行的顺序和日期，不声称没有缺行或停牌缺口。', scope: 'calendar' });
    if (request.methodId === 'macd') gaps.push({ code: 'PRIOR_HISTORY_NOT_FETCHED',
      message: 'MACD 以所供窗口第一条收盘价初始化；窗口之前的历史未读取，不能当作完整历史 MACD。', scope: 'warmup' });
    if (request.methodId === 'ma' && leading >= normalized.rows.length) gaps.push({ code: 'INSUFFICIENT_WARMUP',
      message: `MA 周期 ${(request.parameters as { period: number }).period} 超过所供 ${normalized.rows.length} 条观测，全部为预热空值。`, scope: 'warmup' });
    if (request.methodId === 'bullish_engulfing' && normalized.rows.length < 2) gaps.push({ code: 'INSUFFICIENT_HISTORY',
      message: '严格看涨吞没至少需要前一条和当前一条日线；当前只有一条。', scope: 'history' });
    if (sealed.data.metadata.adjustment === 'as_stored') gaps.push({ code: 'ADJUSTMENT_NOT_APPLIED',
      message: '按表内存储值计算；本方法不执行复权，复权基准和调整状态须由输入声明负责。', scope: 'adjustment' });
    const invalidIntervals: AlgorithmInvalidInterval[] = leading
      ? [{ start: normalized.rows[0]!.timestamp, end: normalized.rows[leading - 1]!.timestamp,
        reason: request.methodId === 'ma' ? 'insufficient_warmup' : 'insufficient_history', count: leading }] : [];
    const validInterval = leading < normalized.rows.length ? { start: normalized.rows[leading]!.timestamp, end: normalized.rows.at(-1)!.timestamp } : null;
    const rawResult = record(raw, '计算结果'), diagnostics = rawResult.diagnostics;
    if (!Array.isArray(diagnostics)) throw new TaskError('ALGORITHM_OUTPUT_INVALID', '原计算结果缺少诊断数组。');
    const computedAt = new Date(this.now()).toISOString();
    const resultObjectSha256 = wfdSha256(canonical({ methodId: request.methodId, methodVersion: method.version,
      parameters: request.parameters, rows: normalized.rows }));
    const derived: DerivedInputEvidence[] = sealed.derivedInputs ?? [];
    const resultEligibility = evaluatePurposeEligibility({
      ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
      purpose: request.usage?.purpose ?? 'current_compute',
      purposeEvidence: request.usage?.purposeEvidence ?? null,
      history: { mode: request.usage?.historyMode ?? null, cutoff: request.usage?.cutoff ?? null,
        perspective: request.usage?.perspective ?? null },
      object: { objectSha256: resultObjectSha256, origin: 'derived_candidate', productId: null, snapshotId: null,
        recordVersion: null, definitionRevision: method.version, contentVerified: true,
        contentBasis: '算法结果行按本次冻结输入、参数与实现实际计算并逐行核对；结果未发布' },
      publicationTime: null, holdingTime: null, revisions: null, wfdHistory: null,
      restriction: sealed.restriction ?? null, wfdDecision: null,
      derived: { methodVersion: method.version, businessTime: sealed.data.metadata.window_end, inputs: derived,
        computedAtUtc: computedAt, computedAtBasis: '实际算法任务完成时间', publishedAtUtc: null, usableAtUtc: null,
        resultObjectSha256 },
    });
    const result: AlgorithmComputedResult = { status: 'computed', persistence: 'not_requested',
      publication: { state: 'not_requested', performed: false },
      environment: task.versions.environment === 'synthetic-test' ? 'synthetic-test' : task.versions.environment === 'local-review' ? 'local-review' : this.environment,
      taskId: task.id, methodId: request.methodId, methodVersion: method.version,
      contractVersion: ALGORITHM_CONTRACT_VERSION, implementationVersion: row.implementation_version,
      parameters: json(request.parameters), metadata: sealed.data.metadata, source: sealed.reference, inputDigest: row.sealed_digest!,
      rows: normalized.rows, validInterval, invalidIntervals,
      coverage: { suppliedRows: normalized.rows.length, validRows: normalized.rows.length - leading, leadingInvalidRows: leading,
        windowStart: sealed.data.metadata.window_start, windowEnd: sealed.data.metadata.window_end },
      diagnostics: json(diagnostics) as JsonValue[], gaps,
      method: json(rawResult.method ?? {}),
      eligibility: sealed.eligibility ? { input: sealed.eligibility, result: resultEligibility } : null,
      computedAt,
      limitations: [...method.limitations, '仅按所供连续观测；未独立核对供应方日历、复权或历史可得性。',
        '结果为本地计算候选，未请求数据库发布；发布须另经既有通用候选服务。'],
      externalActionExecuted: false };
    return result;
  }

  private assertTaskIdentity(task: TaskRecord, row: CallRow): void {
    const request = this.requestOf(row);
    if (task.runtimeId !== ALGORITHM_RUNTIME || task.ownerRole !== 'service' || task.action !== ALGORITHM_CALL_ACTION
      || task.requestId !== requestKey(row.request_id)) throw new TaskError('ALGORITHM_TASK_NOT_FOUND', '此任务不属于算法计算入口。');
    if (row.request_digest !== financialDigest(task.args) || row.request_digest !== financialDigest(request)) throw new TaskError('ALGORITHM_INPUT_CHANGED', '任务参数与原请求摘要不一致。');
    if (row.source_digest !== financialDigest(request.source) || row.parameters_json !== canonical(request.parameters)) throw new TaskError('ALGORITHM_INPUT_CHANGED', '任务输入或参数与原持久记录不一致。');
    if (row.source_digest !== financialDigest(JSON.parse(row.source_json))) throw new TaskError('ALGORITHM_INPUT_CHANGED', '持久输入来源与摘要不一致。');
    if (row.sealed_json && financialDigest(JSON.parse(row.sealed_json)) !== row.sealed_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '封闭输入与摘要不一致。');
    if (row.raw_result_json && financialDigest(JSON.parse(row.raw_result_json)) !== row.raw_result_digest) throw new TaskError('ALGORITHM_RESULT_CHANGED', '原计算结果与摘要不一致。');
    if (row.result_json && financialDigest(JSON.parse(row.result_json)) !== row.result_digest) throw new TaskError('ALGORITHM_RESULT_CHANGED', '保管结果与摘要不一致。');
    if (row.method_id !== request.methodId || task.versions.method !== row.method_version
      || task.versions.implementation !== row.implementation_version) throw new TaskError('ALGORITHM_VERSION_CONFLICT', '任务、方法与持久版本记录不一致。');
  }
  /** 只有真正执行/恢复执行前才要求当前实现与冻结版本相同；历史结果读取不走此检查。 */
  private assertExecutionBinding(task: TaskRecord, row: CallRow): void {
    this.assertTaskIdentity(task, row);
    if (task.versions.algorithms !== ALGORITHM_CONTRACT_VERSION || task.versions.implementationCode !== this.codeBinding.version
      || task.versions.environment !== this.environment || task.versions.tableAdapter !== ALGORITHM_TABLE_ADAPTER_VERSION
      || task.versions.python !== this.runtimeDigest || binaryDigest(this.pythonExecutable) !== this.runtimeDigest) {
      throw new TaskError('ALGORITHM_VERSION_CONFLICT', '任务冻结的 TS 输入转换/结果校验代码、表适配器、环境或 Python 运行身份与当前受控入口不一致；拒绝沿旧任务重执行。');
    }
    this.loadBundle(row.implementation_version);
  }
  /**
   * 只核原任务的输入、固定实现、原进程结果和保管结果摘要；不启动 execute、不重新计算、不换请求编号。
   * 当前 TS/Python 代码变化不影响这里对旧持久结果的核对；核不清则保持待核。
   */
  private async recover(context: { readonly task: TaskRecord; readonly effects: readonly TaskEffectRecord[]; readonly signal: AbortSignal }): Promise<TaskRecoveryResult> {
    context.signal.throwIfAborted();
    const pending = (reason: string): TaskRecoveryResult => ({ outcome: 'pending', evidence: reason.slice(0, 30_000), effects: [] });
    let row: CallRow;
    try {
      row = this.callRow(context.task.id);
      this.assertTaskIdentity(context.task, row);
    } catch (error) { return pending(`原任务身份无法核对：${describeError(error)}`); }
    if (row.state !== 'computed' || !row.sealed_json || !row.sealed_digest || !row.raw_result_json || !row.raw_result_digest
      || !row.result_json || !row.result_digest) {
      return pending(`原结果未完整持久：state=${row.state}; sealed=${row.sealed_digest ? 'present' : 'missing'}; raw=${row.raw_result_digest ? 'present' : 'missing'}; result=${row.result_digest ? 'present' : 'missing'}。`);
    }
    try {
      context.signal.throwIfAborted();
      const sealed = JSON.parse(row.sealed_json) as SealedInput;
      if (financialDigest(sealed) !== row.sealed_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '封闭输入摘要与持久记录不符。');
      if (!sealed || !Array.isArray(sealed.data?.rows) || !sealed.data.rows.length) throw new TaskError('ALGORITHM_INPUT_CHANGED', '封闭输入缺少完整日线。');
      const raw = JSON.parse(row.raw_result_json) as JsonValue;
      if (financialDigest(raw) !== row.raw_result_digest) throw new TaskError('ALGORITHM_RESULT_CHANGED', '原进程结果摘要与持久记录不符。');
      this.loadBundle(row.implementation_version); // 只核冻结实现字节，不比较当前源码
      const result = JSON.parse(row.result_json) as AlgorithmComputedResult;
      if (financialDigest(result) !== row.result_digest || result.taskId !== context.task.id
        || result.methodId !== row.method_id || result.methodVersion !== row.method_version
        || result.implementationVersion !== row.implementation_version || result.contractVersion !== context.task.versions.algorithms
        || result.inputDigest !== row.sealed_digest || result.rows.length !== sealed.data.rows.length
        || result.rows[0]?.timestamp !== sealed.data.rows[0]!.timestamp
        || result.rows.at(-1)?.timestamp !== sealed.data.rows.at(-1)!.timestamp
        || result.coverage.suppliedRows !== sealed.data.rows.length) {
        throw new TaskError('ALGORITHM_RESULT_CHANGED', '保管结果与原任务输入、实现或身份不一致。');
      }
      const updates = context.effects.filter(effect => effect.status === 'started').map(effect => ({
        attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'succeeded' as const,
        evidence: `原结果已按 algorithm_calls 持久摘要核对（result=${row.result_digest}）；未重新执行。` }));
      context.signal.throwIfAborted();
      return { outcome: 'succeeded', result: { summary: '原算法结果已按持久输入、实现与结果摘要核对完成；未重新执行。', data: json(result) },
        evidence: `algorithm_calls.state=computed; implementation=${row.implementation_version}; sealed=${row.sealed_digest}; raw=${row.raw_result_digest}; result=${row.result_digest}; effects=${updates.length}`,
        effects: updates };
    } catch (error) {
      return pending(`原任务结果摘要无法核对：${describeError(error)}`);
    }
  }
  private requestOf(row: CallRow): AlgorithmCallRequest {
    if (financialDigest(JSON.parse(row.request_json)) !== row.request_digest) throw new TaskError('ALGORITHM_INPUT_CHANGED', '原请求与持久摘要不一致。');
    return JSON.parse(row.request_json) as AlgorithmCallRequest;
  }
  private callRow(taskId: string): CallRow {
    const row = this.db.prepare('SELECT * FROM algorithm_calls WHERE task_id=?').get(taskId) as CallRow | undefined;
    if (!row) throw new TaskError('ALGORITHM_TASK_NOT_FOUND', '没有找到此算法计算记录。');
    return row;
  }
  private callByRequest(requestId: string): CallRow | undefined {
    return this.db.prepare('SELECT * FROM algorithm_calls WHERE request_id=?').get(requestId) as CallRow | undefined;
  }
  private getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.runtimeId !== ALGORITHM_RUNTIME || task.ownerRole !== 'service' || task.action !== ALGORITHM_CALL_ACTION) throw new TaskError('ALGORITHM_TASK_NOT_FOUND', '此任务不属于算法计算入口。');
    return task;
  }
  private reopenOrView(row: CallRow): AlgorithmTaskView {
    const task = this.tasks.get(row.task_id);
    if (task.status === 'ready') {
      this.assertDispatch(); this.assertExecutionBinding(task, row); this.tasks.start(task.id);
    }
    return this.view(task.id);
  }
  private loadResult(task: TaskRecord, row: CallRow): AlgorithmComputedResult {
    if (!row.result_json || !row.result_digest || row.state !== 'computed') throw new TaskError('ALGORITHM_RESULT_MISSING', '任务显示成功但没有可读回的保管结果。');
    const result = JSON.parse(row.result_json) as AlgorithmComputedResult;
    if (financialDigest(result) !== row.result_digest || result.taskId !== task.id || result.methodId !== row.method_id
      || result.methodVersion !== row.method_version || result.implementationVersion !== row.implementation_version
      || result.contractVersion !== task.versions.algorithms || result.inputDigest !== row.sealed_digest
      || result.rows.length !== result.coverage.suppliedRows) {
      throw new TaskError('ALGORITHM_RESULT_CHANGED', '保管结果与任务身份、冻结版本或摘要不一致。');
    }
    return result;
  }
  private loadBundle(version: string): FinancialAssetBundle {
    const row = this.db.prepare('SELECT bundle_json FROM algorithm_assets WHERE version=?').get(version);
    if (!row) throw new TaskError('ALGORITHM_IMPLEMENTATION_UNAVAILABLE', '原任务固定实现不可取回，拒绝换版。');
    const bundle = JSON.parse(String(row.bundle_json)) as FinancialAssetBundle;
    verifyAssets(bundle);
    return bundle;
  }
  private tableCatalog(): AlgorithmCatalogView['inputs']['managedTables'] {
    if (!this.tables) return { status: 'unavailable', reason: '已受管表读取端口尚未装配。', items: [] };
    try { return { status: 'available', reason: null, items: this.tables.list(25) }; }
    catch (error) { return { status: 'unavailable', reason: error instanceof Error ? error.message : '受管表目录读取失败。', items: [] }; }
  }
  private snapshotCatalog(): AlgorithmCatalogView['inputs']['fixedSnapshots'] {
    if (!this.snapshots) return { status: 'unavailable', reason: '固定快照端口尚未装配；当前应用只提供本地已受管表输入。', contract: SNAPSHOT_CONTRACT };
    const state = this.snapshots.status();
    return { status: state.status, reason: state.reason, contract: SNAPSHOT_CONTRACT };
  }
  private executionPermission(): { permission: 'granted' | 'approval_required' | 'unavailable'; reason: string | null } {
    try {
      const granted = this.options.permissions.listGrants().some(grant => grant.effect === 'allow' && grant.scope.kind === 'persistent'
        && grant.capabilities.some(capability => capability.action === 'execute' && capability.target.kind === 'file'
          && (capability.target.path === this.pythonExecutable || capability.target.path === realpathSync(this.pythonExecutable))));
      return granted ? { permission: 'granted', reason: null }
        : { permission: 'approval_required', reason: '尚未授予固定 Python 执行文件的持续执行权限；提交后会先请求本机审批。' };
    } catch { return { permission: 'unavailable', reason: '无法读取当前权限账本。' }; }
  }
  private async authorize(context: TaskExecutionContext, operation: Parameters<TaskExecutionContext['assertAuthorized']>[0],
    capabilities: readonly PermissionCapability[]): Promise<string | undefined> {
    try { context.assertAuthorized(operation, capabilities); return undefined; }
    catch (error) {
      if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
      const receipt = await context.requestApproval(operation, capabilities);
      return receipt.approvalId ?? undefined;
    }
  }
  private assertEnabled(): void { if (!this.isEnabled()) throw new TaskError('ALGORITHM_NOT_ENABLED', '算法计算入口尚未经受控采用启用。'); }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '服务已停止新的算法计算派发。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted(); this.assertDispatch();
    if (!this.tasks.isRunActive(context.runId, context.generation)) throw new TaskError('STALE_ALGORITHM_ATTEMPT', '此计算尝试已失去当前运行所有权。');
  }
}

function withoutPurposeEvidence(request: AlgorithmCallRequest): AlgorithmCallRequest {
  if (!request.usage) return request;
  const { purposeEvidence, ...usage } = request.usage;
  return { ...request, usage };
}

/** 由真实提交来源写入用途证据；请求正文不能自报 authority，模型建议不能自授历史/发布用途。 */
function attachPurposeEvidence(request: AlgorithmCallRequest, submission: AlgorithmSubmissionContext | undefined, now: number): AlgorithmCallRequest {
  const usage = request.usage;
  if (!usage) return request;
  if (!submission) {
    if (usage.purpose === 'historical_compute') {
      throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史算法用途须由真实操作者请求或受信用户消息提交；模型自报不能成立。');
    }
    return request;
  }
  const observedAt = Date.parse(submission.observedAtUtc);
  if (!Number.isFinite(observedAt) || observedAt > now + 300_000) {
    throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '用途证据时间无效或明显晚于本次受理。');
  }
  if (submission.authority === 'operator-http') {
    if (!submission.requestId) throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', 'HTTP 用途证据缺少原请求编号。');
  } else if (!submission.messageId || !submission.quote.trim()) {
    throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '用户消息用途证据缺少消息编号或原话。');
  }
  const claim: PurposeEvidenceClaim = {
    purpose: usage.purpose,
    authority: submission.authority,
    quote: submission.authority === 'user-message' ? submission.quote : `本机操作者请求 ${usage.purpose}`,
    observedAtUtc: new Date(observedAt).toISOString().replace('.000Z', 'Z'),
    evidenceSha256: wfdSha256(canonical(submission)),
    ...(submission.authority === 'operator-http' ? { requestId: submission.requestId } : { messageId: submission.messageId }),
  };
  return { ...request, usage: { ...usage, purposeEvidence: [claim] } };
}

function normalizeUsage(value: unknown): AlgorithmUsage {
  const usage = record(value, 'usage');
  exact(usage, ['purpose', 'historyMode', 'cutoff', 'perspective'], 'usage');
  if (usage.purpose !== 'current_compute' && usage.purpose !== 'historical_compute') {
    throw new TaskError('INVALID_ALGORITHM_USAGE', '用途须为 current_compute 或 historical_compute；发布资格不属于本算法入口。');
  }
  if (usage.historyMode !== null && !(ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(usage.historyMode)) {
    throw new TaskError('INVALID_ALGORITHM_USAGE', '历史模式须使用现有 history_mode 稳定名称。');
  }
  if (usage.perspective !== null && (typeof usage.perspective !== 'string' || !usage.perspective.trim())) {
    throw new TaskError('INVALID_ALGORITHM_USAGE', 'perspective 须为明确文本或 null。');
  }
  if (usage.cutoff !== null && (typeof usage.cutoff !== 'string' || !Number.isFinite(Date.parse(usage.cutoff))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(usage.cutoff))) {
    throw new TaskError('INVALID_ALGORITHM_USAGE', '历史截止须为含明确时区的有效时刻或 null。');
  }
  if (usage.purpose === 'historical_compute') {
    if (usage.historyMode === null || usage.cutoff === null) {
      throw new TaskError('INVALID_ALGORITHM_USAGE', '历史计算须显式选择历史模式并固定截止；不能默认快照内容。');
    }
    if (usage.perspective !== null && usage.perspective !== usage.historyMode) {
      throw new TaskError('INVALID_ALGORITHM_USAGE', 'perspective 必须与历史模式一致。');
    }
  } else if (usage.historyMode !== null || usage.cutoff !== null || usage.perspective !== null) {
    throw new TaskError('INVALID_ALGORITHM_USAGE', '当前内容计算不能携带历史模式/截止/视角；不静默升级资格。');
  }
  return {
    purpose: usage.purpose,
    historyMode: usage.historyMode as AlgorithmUsage['historyMode'],
    cutoff: usage.cutoff as string | null,
    perspective: usage.perspective as string | null,
  };
}

function managedTableEligibilityInput(request: AlgorithmCallRequest, source: AlgorithmManagedTableSource, latestAvailableAtUtc: string): PurposeEligibilityInput {
  const usage = request.usage;
  const latestMs = Date.parse(latestAvailableAtUtc);
  const start = Number.isFinite(latestMs) ? new Date(latestMs).toISOString().replace('.000Z', 'Z') : null;
  return {
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
    purpose: usage?.purpose ?? 'current_compute',
    purposeEvidence: usage?.purposeEvidence ?? null,
    history: { mode: usage?.historyMode ?? null, cutoff: usage?.cutoff ?? null, perspective: usage?.perspective ?? null },
    object: { objectSha256: source.materialSha256, origin: 'managed_original', productId: null, snapshotId: null,
      recordVersion: source.materialSha256, definitionRevision: null, contentVerified: true,
      contentBasis: `受管表按材料摘要 ${source.materialSha256} 读取完整原件，非目录预览` },
    // 只有实际 available_at 列可以充当来源文件公开时间证据；bar_close 的收盘时间
    // 是请求声明，不是具体版本公开回执，历史用途必须由共用规则明确拒绝。
    publicationTime: source.semantics.availability.kind === 'column'
      ? materialPublicationTimeEvidence({
        objectSha256: source.materialSha256, recordVersion: source.materialSha256,
        earliestUtc: start,
        latestExclusiveUtc: start === null ? null : new Date(latestMs + 1000).toISOString().replace('.000Z', 'Z'),
        precision: 'second', sourceTimezone: source.semantics.timezone,
        basis: '受管表可用 available_at 列取最晚；来源字段，未独立核验',
        evidenceSha256: wfdSha256(canonicalWfdJson({ materialSha256: source.materialSha256, latestAvailableAtUtc, kind: 'column' })),
      })
      : { authority: 'declared_bar_close', status: 'known', objectSha256: source.materialSha256,
        recordVersion: source.materialSha256, earliestUtc: null, latestExclusiveUtc: null, precision: null,
        sourceTimezone: source.semantics.timezone,
        basis: 'bar_close 为输入可得性声明，不是该材料具体版本的实际公开字段或回执',
        evidenceSha256: wfdSha256(canonicalWfdJson({ materialSha256: source.materialSha256, latestAvailableAtUtc, kind: 'bar_close' })),
        independentlyVerified: false },
    holdingTime: null,
    revisions: null,
    wfdHistory: null,
    restriction: null,
    derived: null,
    wfdDecision: null,
  };
}

function assertEligibilityResult(result: PurposeEligibilityResult): PurposeEligibilityResult {
  if (result.status === 'eligible') return result;
  const payload = canonicalWfdJson({
    ruleVersion: result.ruleVersion, status: result.status, purpose: result.purpose,
    history: result.history, historyUse: result.historyUse, timings: result.timings,
    gaps: result.gaps.filter(item => item.blocking), checks: result.checks,
    evidenceSha256: result.evidenceSha256,
  });
  throw new TaskError(result.status === 'ineligible' ? 'PURPOSE_ELIGIBILITY_INELIGIBLE' : 'PURPOSE_ELIGIBILITY_INSUFFICIENT', payload);
}

function normalizeRequest(value: unknown): AlgorithmCallRequest {
  const request = record(value, '计算请求');
  exact(request, ['methodId', 'parameters', 'source'], '计算请求', ['usage']);
  const methodId = request.methodId;
  if (!(ALGORITHM_METHOD_IDS as readonly unknown[]).includes(methodId)) throw new TaskError('INVALID_ALGORITHM_METHOD', '未知方法；当前只支持 MA、固定 12/26/9 MACD 和严格看涨吞没。');
  assertEnabledParameters(methodId as AlgorithmMethodId, request.parameters);
  const source = normalizeSource(request.source, methodId as AlgorithmMethodId);
  const usage = request.usage === undefined ? undefined : normalizeUsage(request.usage);
  if (Buffer.byteLength(canonical({ methodId, parameters: request.parameters, source, ...(usage ? { usage } : {}) })) > 100_000) {
    throw new TaskError('ALGORITHM_INPUT_BUDGET', '计算请求超过本包预算。');
  }
  return JSON.parse(canonical({ methodId, parameters: request.parameters, source, ...(usage ? { usage } : {}) })) as AlgorithmCallRequest;
}
function assertEnabledParameters(methodId: AlgorithmMethodId, value: unknown): void {
  const params = record(value, 'parameters');
  if (methodId === 'ma') {
    exact(params, ['period'], 'MA parameters');
    if (!Number.isSafeInteger(params.period) || Number(params.period) < 1 || Number(params.period) > 10000) throw new TaskError('INVALID_ALGORITHM_PARAMETERS', 'MA period 须为 1 至 10000 的整数。');
  } else if (methodId === 'macd') {
    exact(params, ['short_period', 'long_period', 'signal_period', 'init'], 'MACD parameters');
    if (params.short_period !== 12 || params.long_period !== 26 || params.signal_period !== 9 || params.init !== 'first_valid') {
      throw new TaskError('INVALID_ALGORITHM_PARAMETERS', 'MACD 只支持固定 12/26/9 与显式 init:first_valid；不接受续算状态。');
    }
  } else exact(params, [], '形态 parameters');
}
function normalizeSource(value: unknown, methodId: AlgorithmMethodId): AlgorithmSource {
  const source = record(value, '输入来源');
  if (source.kind === 'managed_table') return normalizeManagedTable(source, methodId);
  if (source.kind === 'fixed_snapshot') return normalizeSnapshot(source, methodId);
  throw new TaskError('ALGORITHM_INPUT_SOURCE_UNSUPPORTED', '输入来源须为本地已受管表或固定快照。');
}
function normalizeManagedTable(source: Record<string, unknown>, methodId: AlgorithmMethodId): AlgorithmManagedTableSource {
  exact(source, ['kind', 'materialId', 'materialSha256', 'format', 'fieldMapping', 'semantics', 'calendar'], '受管表输入', ['dateFormat', 'range']);
  identifier(source.materialId, '受管材料编号');
  if (typeof source.materialSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.materialSha256)) throw new TaskError('INVALID_ALGORITHM_INPUT', '受管表 SHA-256 摘要无效。');
  if (!['csv', 'json'].includes(String(source.format))) throw new TaskError('INVALID_ALGORITHM_INPUT', '受管表格式须为 csv 或 json。');
  const mapping = record(source.fieldMapping, 'fieldMapping');
  exact(mapping, ['timestamp', 'close'], 'fieldMapping', ['open', 'high', 'low', 'available_at']);
  for (const [key, column] of Object.entries(mapping)) if (typeof column !== 'string' || !column.trim() || column.length > 256) throw new TaskError('INVALID_ALGORITHM_MAPPING', `字段映射 ${key} 须为非空列名。`);
  const targets = Object.values(mapping) as string[];
  if (new Set(targets).size !== targets.length) throw new TaskError('INVALID_ALGORITHM_MAPPING', '同一来源列不能同时映射到多个语义字段。');
  if (methodId === 'bullish_engulfing' && !mapping.open) throw new TaskError('INVALID_ALGORITHM_MAPPING', '严格看涨吞没需要映射开盘价 open。');
  const dateFormat = source.dateFormat ?? 'YYYY-MM-DD';
  if (!['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYYMMDD'].includes(String(dateFormat))) throw new TaskError('INVALID_ALGORITHM_INPUT', '日期格式须明确为 YYYY-MM-DD、YYYY/MM/DD 或 YYYYMMDD。');
  const semantics = normalizeSemantics(source.semantics, mapping);
  const calendar = normalizeCalendar(source.calendar);
  let range: { start: string; end: string } | undefined;
  if (source.range !== undefined) {
    const raw = record(source.range, 'range'); exact(raw, ['start', 'end'], 'range');
    range = { start: validDay(raw.start, 'range.start'), end: validDay(raw.end, 'range.end') };
    if (range.start > range.end) throw new TaskError('INVALID_ALGORITHM_INPUT', '范围开始不能晚于结束。');
  }
  return { kind: 'managed_table', materialId: String(source.materialId), materialSha256: String(source.materialSha256), format: source.format as 'csv' | 'json',
    fieldMapping: mapping as unknown as AlgorithmFieldMapping, dateFormat: dateFormat as AlgorithmDateFormats, semantics, calendar, ...(range ? { range } : {}) };
}
function normalizeSemantics(value: unknown, mapping: Record<string, unknown>): AlgorithmSemantics {
  const semantics = record(value, '输入语义');
  exact(semantics, ['subject', 'frequency', 'timezone', 'priceUnit', 'currency', 'adjustment', 'adjustmentBasis', 'barClosed', 'synthetic', 'availability'], '输入语义');
  text(semantics.subject, '标的/序列名称');
  if (semantics.frequency !== '1d') throw new TaskError('ALGORITHM_FREQUENCY_UNSUPPORTED', '当前只接受已明确为日线的输入；分钟/日线加工尚未装配。');
  text(semantics.timezone, '时区'); const timezone = String(semantics.timezone);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '时区声明无效。'); }
  if (semantics.priceUnit !== 'currency_per_share') throw new TaskError('ALGORITHM_UNIT_MISMATCH', '价格单位须明确为每股货币价格。');
  if (typeof semantics.currency !== 'string' || !/^[A-Z]{3}$/u.test(semantics.currency) || semantics.currency === 'XXX'
    || !Intl.supportedValuesOf('currency').includes(semantics.currency)) throw new TaskError('ALGORITHM_UNIT_MISMATCH', '须明确已识别三位币种码；不猜单位或缩放。');
  if (!['unadjusted', 'as_stored'].includes(String(semantics.adjustment))) {
    throw new TaskError('ALGORITHM_ADJUSTMENT_UNAVAILABLE', '复权入口缺少受控实现和基准核对；当前只接受 unadjusted 或 as_stored。');
  }
  text(semantics.adjustmentBasis, '复权依据');
  if (/^(unknown|undefined|n\/?a|未知|未确定|不明)$/iu.test(String(semantics.adjustmentBasis).trim())) throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '复权依据未确定，不能计算。');
  if (semantics.barClosed !== true || typeof semantics.synthetic !== 'boolean') throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '须声明均为已收盘日线，并明确是否为合成测试数据。');
  const availability = record(semantics.availability, 'availability');
  if (availability.kind === 'column') {
    exact(availability, ['kind'], 'availability');
    if (!mapping.available_at) throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '逐行可得时刻需要明确映射 available_at 列。');
    return { subject: String(semantics.subject), frequency: '1d', timezone, priceUnit: 'currency_per_share',
      currency: String(semantics.currency), adjustment: semantics.adjustment as AlgorithmSemantics['adjustment'],
      adjustmentBasis: String(semantics.adjustmentBasis), barClosed: true, synthetic: semantics.synthetic as boolean,
      availability: { kind: 'column' } };
  }
  if (availability.kind === 'bar_close') {
    exact(availability, ['kind', 'closeTime'], 'availability');
    const time = validClock(availability.closeTime);
    return { subject: String(semantics.subject), frequency: '1d', timezone, priceUnit: 'currency_per_share',
      currency: String(semantics.currency), adjustment: semantics.adjustment as AlgorithmSemantics['adjustment'],
      adjustmentBasis: String(semantics.adjustmentBasis), barClosed: true, synthetic: semantics.synthetic as boolean,
      availability: { kind: 'bar_close', closeTime: time } };
  }
  throw new TaskError('INVALID_ALGORITHM_SEMANTICS', 'availability 须为逐行列或明确收盘后时刻。');
}
function normalizeCalendar(value: unknown): AlgorithmCalendar {
  const calendar = record(value, 'calendar');
  if (calendar.mode === 'dense') { exact(calendar, ['mode'], 'calendar'); return { mode: 'dense' }; }
  if (calendar.mode === 'declared') {
    exact(calendar, ['mode', 'expectedDates'], 'calendar');
    if (!Array.isArray(calendar.expectedDates) || !calendar.expectedDates.length || calendar.expectedDates.length > 512) throw new TaskError('INVALID_ALGORITHM_CALENDAR', '声明日历须提供 1 至 512 个明确日期。');
    const dates = calendar.expectedDates.map(day => validDay(day, 'expectedDates'));
    if (new Set(dates).size !== dates.length || dates.some((day, index) => index > 0 && day <= dates[index - 1]!)) throw new TaskError('INVALID_ALGORITHM_CALENDAR', '声明日历须严格递增且不重复。');
    return { mode: 'declared', expectedDates: dates };
  }
  if (calendar.mode === 'not_verified') {
    exact(calendar, ['mode', 'note'], 'calendar'); text(calendar.note, '日历缺口说明');
    return { mode: 'not_verified', note: String(calendar.note) };
  }
  throw new TaskError('INVALID_ALGORITHM_CALENDAR', '日历声明须为 dense、declared 或 not_verified。');
}
function normalizeSnapshot(source: Record<string, unknown>, methodId: AlgorithmMethodId): AlgorithmSource {
  exact(source, ['kind', 'reference'], '固定快照输入');
  if (source.kind !== 'fixed_snapshot') throw new TaskError('ALGORITHM_INPUT_SOURCE_UNSUPPORTED', '固定快照来源类型无效。');
  const reference = record(source.reference, '固定快照引用');
  exact(reference, ['kind', 'instanceId', 'productId', 'snapshotId', 'definitionRevision', 'fieldMapping', 'semantics', 'calendar'],
    '固定快照引用', ['fields', 'dateFormat', 'range', 'perspective', 'at', 'includeHistory', 'heldScope', 'usableStage', 'expectedRowsSha256', 'expectedRowCount', 'expectedDefinitionSha256', 'contractDigest']);
  if (reference.kind !== 'wfd_fixed_snapshot') throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照须声明 kind:wfd_fixed_snapshot。');
  for (const [label, value] of [['实例', reference.instanceId], ['产品', reference.productId],
    ['快照', reference.snapshotId], ['定义修订', reference.definitionRevision]] as const) {
    wfdIdentifier(value, `固定快照${label}`);
    if (String(value).toLowerCase() === 'latest' || String(value).toLowerCase() === 'current') throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', `固定快照${label}不能使用 latest/current。`);
  }
  const mapping = record(reference.fieldMapping, 'fieldMapping');
  exact(mapping, ['timestamp', 'close'], 'fieldMapping', ['open', 'high', 'low', 'available_at']);
  for (const [key, column] of Object.entries(mapping)) if (typeof column !== 'string' || !column.trim() || column.length > 256) throw new TaskError('INVALID_ALGORITHM_MAPPING', `字段映射 ${key} 须为非空列名。`);
  const targets = Object.values(mapping) as string[];
  if (new Set(targets).size !== targets.length) throw new TaskError('INVALID_ALGORITHM_MAPPING', '同一来源列不能同时映射到多个语义字段。');
  if (methodId === 'bullish_engulfing' && !mapping.open) throw new TaskError('INVALID_ALGORITHM_MAPPING', '严格看涨吞没需要映射开盘价 open。');
  const dateFormat = reference.dateFormat ?? 'YYYY-MM-DD';
  if (!['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYYMMDD'].includes(String(dateFormat))) throw new TaskError('INVALID_ALGORITHM_INPUT', '日期格式须明确为 YYYY-MM-DD、YYYY/MM/DD 或 YYYYMMDD。');
  const semantics = normalizeSemantics(reference.semantics, mapping);
  const calendar = normalizeCalendar(reference.calendar);
  const derivedFields = [...new Set(targets)];
  let fields = derivedFields;
  if (reference.fields !== undefined) {
    if (!Array.isArray(reference.fields) || !reference.fields.length || reference.fields.length > 256
      || new Set(reference.fields).size !== reference.fields.length
      || reference.fields.some(field => typeof field !== 'string' || !field || field.length > 128)) {
      throw new TaskError('INVALID_ALGORITHM_SNAPSHOT', '快照读取字段须为 1 至 256 个不重复非空字段。');
    }
    if (derivedFields.some(field => !(reference.fields as unknown[]).includes(field))) {
      throw new TaskError('INVALID_ALGORITHM_SNAPSHOT', '快照读取字段未覆盖全部显式映射列。');
    }
    fields = reference.fields as string[];
  }
  let range: { start: string; end: string } | undefined;
  if (reference.range !== undefined) {
    const raw = record(reference.range, 'range'); exact(raw, ['start', 'end'], 'range');
    range = { start: validDay(raw.start, 'range.start'), end: validDay(raw.end, 'range.end') };
    if (range.start > range.end) throw new TaskError('INVALID_ALGORITHM_INPUT', '范围开始不能晚于结束。');
  }
  let perspective: AlgorithmSnapshotReference['perspective'];
  if (reference.perspective !== undefined) {
    if (!(ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(reference.perspective)) {
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照历史视角须使用现有 history_mode 稳定名称。');
    }
    perspective = reference.perspective as AlgorithmSnapshotReference['perspective'];
  }
  let at: string | undefined;
  if (reference.at !== undefined) {
    if (typeof reference.at !== 'string' || !Number.isFinite(Date.parse(reference.at))
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(reference.at)) {
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照历史截止须为含明确时区的有效时刻。');
    }
    at = reference.at;
  }
  if (perspective !== undefined && perspective !== 'snapshot_contents' && at === undefined) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '历史视角必须同时声明截止；不能只改视角标签。');
  }
  if (at !== undefined && (perspective === undefined || perspective === 'snapshot_contents')) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '历史截止必须搭配非快照内容的历史视角；不能只改截止。');
  }
  const includeHistory = reference.includeHistory === undefined ? undefined : reference.includeHistory;
  if (includeHistory !== undefined && typeof includeHistory !== 'boolean') throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'includeHistory 须为布尔值。');
  let heldScope: string | undefined;
  if (reference.heldScope !== undefined) {
    if (typeof reference.heldScope !== 'string' || !reference.heldScope.trim() || reference.heldScope.length > 256) {
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'heldScope 须为明确有界文本。');
    }
    heldScope = reference.heldScope;
  }
  let usableStage: AlgorithmSnapshotReference['usableStage'];
  if (reference.usableStage !== undefined) {
    if (!['acquired', 'custodied', 'published_readable'].includes(String(reference.usableStage))) {
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'usableStage 须为 acquired/custodied/published_readable。');
    }
    usableStage = reference.usableStage as AlgorithmSnapshotReference['usableStage'];
  }
  const sha = (value: unknown, label: string) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', `${label}须为小写 SHA-256。`);
    return value;
  };
  const expectedRowsSha256 = reference.expectedRowsSha256 === undefined ? undefined : sha(reference.expectedRowsSha256, 'expectedRowsSha256');
  const expectedDefinitionSha256 = reference.expectedDefinitionSha256 === undefined ? undefined : sha(reference.expectedDefinitionSha256, 'expectedDefinitionSha256');
  const contractDigest = reference.contractDigest === undefined ? undefined : sha(reference.contractDigest, 'contractDigest');
  const expectedRowCount = reference.expectedRowCount === undefined ? undefined : Number(reference.expectedRowCount);
  if (expectedRowCount !== undefined && (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0)) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'expectedRowCount 须为非负安全整数。');
  }
  const normalized: AlgorithmSnapshotReference = { kind: 'wfd_fixed_snapshot', instanceId: String(reference.instanceId),
    productId: String(reference.productId), snapshotId: String(reference.snapshotId),
    definitionRevision: String(reference.definitionRevision), fields, fieldMapping: mapping as unknown as AlgorithmFieldMapping,
    ...(reference.dateFormat === undefined ? {} : { dateFormat: dateFormat as AlgorithmDateFormats }), semantics, calendar,
    ...(range ? { range } : {}), ...(perspective ? { perspective } : {}), ...(at ? { at } : {}),
    ...(includeHistory === undefined ? {} : { includeHistory }), ...(heldScope ? { heldScope } : {}),
    ...(usableStage ? { usableStage } : {}), ...(expectedRowsSha256 ? { expectedRowsSha256 } : {}),
    ...(expectedRowCount === undefined ? {} : { expectedRowCount }), ...(expectedDefinitionSha256 ? { expectedDefinitionSha256 } : {}),
    ...(contractDigest ? { contractDigest } : {}) };
  return { kind: 'fixed_snapshot', reference: normalized };
}

function validateData(data: AlgorithmData): void {
  const value = record(data, '算法输入'); exact(value, ['metadata', 'rows'], '算法输入');
  const metadata = record(value.metadata, 'metadata');
  exact(metadata, ['series_id', 'subject', 'frequency', 'timezone', 'price_unit', 'currency', 'adjustment', 'adjustment_basis',
    'window_start', 'window_end', 'as_of', 'availability_basis', 'bar_closed', 'observations_are_consecutive', 'calendar_verification', 'synthetic'], 'metadata');
  identifier(metadata.series_id, 'series_id'); text(metadata.subject, 'subject');
  if (metadata.frequency !== '1d') throw new TaskError('ALGORITHM_FREQUENCY_UNSUPPORTED', '只接受日线输入。');
  text(metadata.timezone, 'timezone'); const timezone = String(metadata.timezone);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '时区声明无效。'); }
  if (metadata.price_unit !== 'currency_per_share' || typeof metadata.currency !== 'string' || !/^[A-Z]{3}$/u.test(metadata.currency)
    || metadata.currency === 'XXX' || !Intl.supportedValuesOf('currency').includes(metadata.currency)) {
    throw new TaskError('ALGORITHM_UNIT_MISMATCH', '价格单位或币种声明无效。');
  }
  if (!['unadjusted', 'as_stored'].includes(String(metadata.adjustment))) throw new TaskError('ALGORITHM_ADJUSTMENT_UNAVAILABLE', '当前只支持 unadjusted 或 as_stored 输入。');
  text(metadata.adjustment_basis, 'adjustment_basis');
  if (/^(unknown|undefined|n\/?a|未知|未确定|不明)$/iu.test(String(metadata.adjustment_basis).trim())) throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '复权依据未确定，不能计算。');
  if (metadata.bar_closed !== true || metadata.observations_are_consecutive !== true || typeof metadata.synthetic !== 'boolean'
    || !['explicit_per_bar', 'declared_bar_close'].includes(String(metadata.availability_basis))
    || !['dense', 'declared', 'not_verified'].includes(String(metadata.calendar_verification))) {
    throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '输入缺少已收盘、连续观测、可得时刻或日历声明。');
  }
  const start = validDay(metadata.window_start, 'window_start'), end = validDay(metadata.window_end, 'window_end');
  const asOf = instant(metadata.as_of, 'as_of');
  if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > 512) throw new TaskError('ALGORITHM_INPUT_BUDGET', '算法输入须为 1 至 512 条日线观测。');
  let previous = '';
  for (const [index, item] of value.rows.entries()) {
    const row = record(item, `rows[${index}]`);
    exact(row, ['timestamp', 'close', 'available_at', 'bar_closed'], `rows[${index}]`, ['open', 'high', 'low']);
    const timestamp = validDay(row.timestamp, `rows[${index}].timestamp`);
    if (timestamp <= previous) throw new TaskError('INVALID_ALGORITHM_INPUT', '时间须严格递增且不重复，不自动排序。');
    previous = timestamp;
    const close = price(row.close, 'close'), open = row.open === undefined ? undefined : price(row.open, 'open');
    const high = row.high === undefined ? undefined : price(row.high, 'high'), low = row.low === undefined ? undefined : price(row.low, 'low');
    validateOhlc(timestamp, close, open, high, low);
    const available = instant(row.available_at, `rows[${index}].available_at`);
    if (row.bar_closed !== true || available > asOf || zonedDay(available, String(metadata.timezone)) < timestamp) {
      throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', '未闭合、未可得或可得时刻早于业务日期的日线不能作为当时已知输入。');
    }
  }
  if (start !== record(value.rows[0], '首行').timestamp || end !== record(value.rows.at(-1), '末行').timestamp) throw new TaskError('INVALID_ALGORITHM_INPUT', '窗口声明须与所供首尾观测完全一致。');
}

function validateRawOutput(request: AlgorithmCallRequest, data: AlgorithmData, raw: JsonValue): { rows: AlgorithmResultRow[]; leading: number } {
  const result = record(raw, '计算结果');
  const method = ALGORITHM_METHODS[request.methodId];
  if (result.ok === false) throw new TaskError('ALGORITHM_CALCULATION_FAILED', typeof result.error === 'string' ? `原计算入口拒绝：${result.error.slice(0, 1000)}` : '原计算入口明确失败。');
  if (result.ok !== true || result.version !== 1 || result.kind !== method.kind || result.operation !== method.operation
    || result.execution_executed !== false || !Array.isArray(result.rows) || result.rows.length !== data.rows.length
    || !Array.isArray(result.diagnostics) || !result.method) throw new TaskError('ALGORITHM_OUTPUT_INVALID', '原计算结果身份、结构或行数不符。');
  const fields = request.methodId === 'macd' ? ['DIFF', 'DEA', 'MACD', 'ZERO'] : [method.field];
  const period = request.methodId === 'ma' ? (request.parameters as { period: number }).period : 0;
  const leading = request.methodId === 'macd' ? 0 : request.methodId === 'ma' ? Math.min(data.rows.length, period - 1) : Math.min(data.rows.length, 1);
  const rows: AlgorithmResultRow[] = result.rows.map((item, index) => {
    const row = record(item, `result.rows[${index}]`);
    exact(row, ['timestamp', ...fields], `result.rows[${index}]`);
    if (row.timestamp !== data.rows[index]!.timestamp) throw new TaskError('ALGORITHM_OUTPUT_INVALID', '原计算结果行与输入日线不对应。');
    if (request.methodId === 'macd') {
      const diff = finite(row.DIFF, 'DIFF'), dea = finite(row.DEA, 'DEA'), macd = finite(row.MACD, 'MACD');
      if (row.ZERO !== 0 || Math.abs(macd - 2 * (diff - dea)) > 1e-12 * Math.max(1, Math.abs(macd))) throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MACD 四列数值或公式证据不符。');
      if (index === 0 && (diff !== 0 || dea !== 0 || macd !== 0)) throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MACD 首条不是首值初始化零值。');
    } else if (request.methodId === 'ma') {
      if (index < leading) { if (row.MA !== null) throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MA 预热行应为空值。'); }
      else if (typeof row.MA !== 'number' || !Number.isFinite(row.MA) || row.MA <= 0) throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MA 有效行不是正有限数值。');
    } else if (index < leading) { if (row.bullish_engulfing !== null) throw new TaskError('ALGORITHM_OUTPUT_INVALID', '形态首行缺少前一条观测，应为空值。'); }
    else if (typeof row.bullish_engulfing !== 'boolean') throw new TaskError('ALGORITHM_OUTPUT_INVALID', '形态有效行不是布尔值。');
    return { timestamp: String(row.timestamp), available_at: data.rows[index]!.available_at,
      ...Object.fromEntries(fields.map(field => [field, row[field] as JsonValue])) };
  });
  if (request.methodId === 'macd') {
    const rawMethod = record(result.method, 'MACD method'), state = result.state === undefined ? undefined : record(result.state, 'MACD state');
    const parameters = record(rawMethod.parameters, 'MACD 参数');
    if (parameters.short_period !== 12 || parameters.long_period !== 26 || parameters.signal_period !== 9
      || rawMethod.initialization !== 'first_valid') throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MACD 固定参数或首值初始化证据不符。');
    if (state) {
      const values = record(state.values, 'MACD state.values'), last = rows.at(-1)!;
      if (state.previous_timestamp !== last.timestamp || typeof values.dea !== 'number' || !Number.isFinite(values.dea)
        || typeof values.ema_short !== 'number' || typeof values.ema_long !== 'number'
        || Math.abs(Number(values.dea) - Number(last.DEA)) > 1e-12 * Math.max(1, Math.abs(Number(last.DEA)))
        || Math.abs((Number(values.ema_short) - Number(values.ema_long)) - Number(last.DIFF)) > 1e-12 * Math.max(1, Math.abs(Number(last.DIFF)))) {
        throw new TaskError('ALGORITHM_OUTPUT_INVALID', 'MACD 原生递推状态与末行不一致。');
      }
    }
  }
  return { rows, leading };
}

function wfdIdentifier(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) {
    throw new TaskError('INVALID_ALGORITHM_INPUT', `${label} 须为 WFD 有界标识。`);
  }
}
function jsonText(row: Record<string, JsonValue>, column: string, field: string): string {
  if (!Object.hasOwn(row, column)) throw new TaskError('ALGORITHM_MAPPING_COLUMN', `固定快照没有映射字段 ${column}。`);
  const value = row[column];
  if (value === null || value === undefined) throw new TaskError('ALGORITHM_MISSING_VALUE', `${field} 在映射列 ${column} 中缺失；不补零、不前向填充。`);
  if (typeof value === 'boolean' || typeof value === 'object') throw new TaskError('ALGORITHM_INVALID_VALUE', `${field} 映射列 ${column} 不是文本或数值。`);
  return String(value);
}
function jsonNumber(row: Record<string, JsonValue>, column: string, field: string, timestamp: string,
  evidence?: NumericEvidenceState): number {
  return parsePrice(jsonText(row, column, field), field, timestamp, evidence);
}
function optionalJsonNumber(row: Record<string, JsonValue>, column: string | undefined, field: string, timestamp: string,
  evidence?: NumericEvidenceState): number | undefined {
  if (!column) return undefined;
  return jsonNumber(row, column, field, timestamp, evidence);
}
function assertStrictDates(rows: AlgorithmBar[], calendar: AlgorithmCalendar): void {
  if (calendar.mode === 'not_verified') return;
  if (calendar.mode === 'declared') {
    const actual = rows.map(row => row.timestamp);
    if (actual.length !== calendar.expectedDates.length || actual.some((date, index) => date !== calendar.expectedDates[index])) {
      throw new TaskError('ALGORITHM_CALENDAR_MISMATCH', '所选范围与声明日历不完全一致；不静默补齐或缩小范围。');
    }
    return;
  }
  for (let index = 1; index < rows.length; index++) {
    const previous = Date.parse(`${rows[index - 1]!.timestamp}T00:00:00Z`), current = Date.parse(`${rows[index]!.timestamp}T00:00:00Z`);
    if (current - previous !== 86_400_000) throw new TaskError('ALGORITHM_SEQUENCE_GAP', `所供行在 ${rows[index - 1]!.timestamp} 与 ${rows[index]!.timestamp} 之间缺日；逐日连续声明不成立。`);
  }
}
function validateOhlc(timestamp: string, close: number, open: number | undefined, high: number | undefined, low: number | undefined): void {
  if (low !== undefined && high !== undefined && low > high) throw new TaskError('ALGORITHM_INVALID_VALUE', `${timestamp} 最低价高于最高价。`);
  for (const [name, value] of [['open', open], ['close', close]] as const) {
    if (value === undefined) continue;
    if (low !== undefined && value < low) throw new TaskError('ALGORITHM_INVALID_VALUE', `${timestamp} ${name} 低于最低价。`);
    if (high !== undefined && value > high) throw new TaskError('ALGORITHM_INVALID_VALUE', `${timestamp} ${name} 高于最高价。`);
  }
}
function cellText(table: ManagedTableData, row: ManagedTableData['rows'][number], column: string, field: string): string {
  const index = table.columns.indexOf(column);
  if (index < 0) throw new TaskError('ALGORITHM_MAPPING_COLUMN', `受管表没有映射字段 ${column}。`);
  const cell = row.values[index];
  if (!cell || cell.type === 'missing' || cell.type === 'null' || cell.value === null) throw new TaskError('ALGORITHM_MISSING_VALUE', `${field} 在映射列 ${column} 中缺失；不补零、不前向填充。`);
  if (typeof cell.value === 'boolean') throw new TaskError('ALGORITHM_INVALID_VALUE', `${field} 映射列 ${column} 是布尔值，不是文本或数值。`);
  return String(cell.value);
}
interface NumericAdoption { field: string; original: string; normalized: string; adopted: number; occurrences: number }
interface NumericEvidenceState { checked: number; index: Map<string, NumericAdoption> }
function newNumericEvidence(): NumericEvidenceState { return { checked: 0, index: new Map() }; }
function recordNumeric(state: NumericEvidenceState, field: string, original: string, normalized: string, adopted: number): void {
  state.checked++;
  const key = `${field}\u0000${original}`;
  const existing = state.index.get(key);
  if (existing) { existing.occurrences++; return; }
  state.index.set(key, { field, original, normalized, adopted, occurrences: 1 });
}
function numericEvidence(state: NumericEvidenceState): JsonValue {
  const all = [...state.index.values()];
  return { policy: 'exact-decimal-roundtrip/1', representation: 'IEEE-754 binary64',
    checkedValues: state.checked, distinctValues: all.length, exactValues: state.checked,
    values: all.slice(0, 256).map(value => ({ field: value.field, original: value.original, normalized: value.normalized,
      adopted: value.adopted, occurrences: value.occurrences })), valuesOmitted: Math.max(0, all.length - 256) } as JsonValue;
}
function cellNumber(table: ManagedTableData, row: ManagedTableData['rows'][number], column: string, field: string, timestamp: string,
  evidence?: NumericEvidenceState): number {
  return parsePrice(cellText(table, row, column, field), field, timestamp, evidence);
}
function optionalNumber(table: ManagedTableData, row: ManagedTableData['rows'][number], column: string | undefined, field: string, timestamp: string,
  evidence?: NumericEvidenceState): number | undefined {
  if (!column) return undefined;
  return cellNumber(table, row, column, field, timestamp, evidence);
}
/**
 * 先证明十进制原值能无损落入当前 binary64 表示，再采用。整数必须是安全整数；其余值要求规范十进制
 * roundtrip 完全一致。任何精度缺口都明确拒绝，不静默舍入，也不把舍入值当成原值保存。
 */
function parsePrice(value: string, field: string, timestamp: string, evidence?: NumericEvidenceState): number {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(text)) throw new TaskError('ALGORITHM_INVALID_VALUE', `${timestamp} ${field} 不是明确十进制数；不接受千分位、百分号或空值。`);
  const normalized = normalizeDecimal(text);
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) throw new TaskError('ALGORITHM_INVALID_VALUE', `${timestamp} ${field} 须为正有限数值。`);
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
    throw new TaskError('ALGORITHM_NUMBER_PRECISION', `${timestamp} ${field} 原值 ${text} 是超过安全整数范围的整数；采用 binary64 会得到 ${String(number)}，拒绝不声明的精度损失。`);
  }
  const adopted = normalizeDecimal(String(number));
  if (adopted !== normalized) {
    throw new TaskError('ALGORITHM_NUMBER_PRECISION', `${timestamp} ${field} 原值 ${text}（规范十进制 ${normalized}）不能无损落入当前 binary64 表示；采用值 ${String(number)}（规范 ${adopted}）。请改用可精确表示的十进制或显式转换，未静默舍入。`);
  }
  if (evidence) recordNumeric(evidence, field, text, normalized, number);
  return number;
}
/** 规范十进制：去正号/前导零/小数尾零，展开明确指数；只用于精确比较，不用于业务舍入。 */
function normalizeDecimal(text: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match || (!match[2] && !match[3])) throw new TaskError('ALGORITHM_INVALID_VALUE', '数值须为明确十进制文本。');
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) throw new TaskError('ALGORITHM_NUMBER_PRECISION', '数值指数超出当前精确比较预算。');
  let digits = (match[2] ?? '') + (match[3] ?? ''), scale = (match[3] ?? '').length - exponent;
  digits = digits.replace(/^0+/u, '') || '0';
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1) || '0'; scale--; }
  if (digits === '0') return '0';
  let expanded: string;
  if (scale <= 0) expanded = digits + '0'.repeat(-scale);
  else if (scale >= digits.length) expanded = '0.' + '0'.repeat(scale - digits.length) + digits;
  else expanded = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  if (expanded.length > 2048) throw new TaskError('ALGORITHM_NUMBER_PRECISION', '十进制原值展开后超过当前精确比较预算，不能无损核对。');
  return (match[1] === '-' ? '-' : '') + expanded;
}
function parseDay(value: unknown, format: AlgorithmDateFormats = 'YYYY-MM-DD'): string {
  if (typeof value !== 'string') throw new TaskError('ALGORITHM_INVALID_DATE', '日期须为文本。');
  const text = value.trim();
  const match = format === 'YYYYMMDD' ? /^(\d{4})(\d{2})(\d{2})$/u.exec(text)
    : format === 'YYYY/MM/DD' ? /^(\d{4})\/(\d{2})\/(\d{2})$/u.exec(text) : /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) throw new TaskError('ALGORITHM_INVALID_DATE', `日期 ${text} 不符合声明格式 ${format}。`);
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return validDay(day, '日期');
}
function validDay(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new TaskError('ALGORITHM_INVALID_DATE', `${label} 须为有效 YYYY-MM-DD。`);
  return value;
}
function validClock(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value)) throw new TaskError('INVALID_ALGORITHM_SEMANTICS', '收盘后可得时刻须为 HH:MM:SS。');
  return value;
}
function instant(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `${label} 须为含明确时区的有效时刻。`);
  validDay(value.slice(0, 10), label);
  return Date.parse(value);
}
function parseInstant(value: string, timestamp: string): string {
  const parsed = instant(value, `第 ${timestamp} 条 available_at`);
  return new Date(parsed).toISOString();
}
function zonedInstant(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [wantedHour, wantedMinute, wantedSecond] = time.split(':').map(Number) as [number, number, number];
  const target = Date.UTC(year, month - 1, day, wantedHour, wantedMinute, wantedSecond);
  let guess = target;
  for (let index = 0; index < 4; index++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
    const localHour = part('hour') === 24 ? 0 : part('hour');
    const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), localHour, part('minute'), part('second'));
    const difference = target - asUtc;
    if (difference === 0) break;
    guess += difference;
  }
  const localParts = (timestamp: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(timestamp);
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
    return { day: `${part('year')}-${String(part('month')).padStart(2, '0')}-${String(part('day')).padStart(2, '0')}`,
      hour: part('hour') === 24 ? 0 : part('hour'), minute: part('minute'), second: part('second') };
  };
  const check = localParts(guess);
  if (check.day !== date || check.hour !== wantedHour || check.minute !== wantedMinute || check.second !== wantedSecond) {
    throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `无法把 ${date} ${time} 按 ${timezone} 解释为明确且唯一的时刻。`);
  }
  // 夏令时回拨会让同一本地时刻出现两次；固定收盘后时刻不能猜其中一个偏移。
  for (const delta of [-3_600_000, 3_600_000]) {
    const other = localParts(guess + delta);
    if (other.day === date && other.hour === wantedHour && other.minute === wantedMinute && other.second === wantedSecond) {
      throw new TaskError('ALGORITHM_TIME_UNAVAILABLE', `本地时刻 ${date} ${time} 在 ${timezone} 不唯一；请改用逐行 available_at 列。`);
    }
  }
  return new Date(guess).toISOString();
}
function zonedDay(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function price(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TaskError('ALGORITHM_INVALID_VALUE', `${label} 须为正有限数值。`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TaskError('ALGORITHM_OUTPUT_INVALID', `${label} 不是有限数值。`);
  return value;
}
function guidanceFor(task: TaskRecord): string | null {
  if (task.status === 'succeeded') return null;
  if (task.requiresReview || task.status === 'needs_review') return '原结果未知；先按原任务编号核对，不能重算或换新请求绕过。';
  if (task.status === 'failed' || task.status === 'cancelled') return '原尝试已结束；如需改变输入或重新执行，请建立新请求编号并保留原记录。';
  if (task.status === 'waiting_approval') return '等待本机授权；授权后原任务继续，不另建计算。';
  if (task.status === 'paused') return '原尝试已暂停；按原任务版本明确恢复，不自动重算。';
  if (task.status === 'interrupted') return '原尝试已中断，结果未知；先按原任务核对，不能自动重算。';
  return '计算进行中；请按原任务编号查询。';
}
function requestKey(requestId: string): string { identifier(requestId, '请求编号'); return `algorithm:calculate:${requestId}`; }
function identifier(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,255}$/u.test(value)) throw new TaskError('INVALID_ALGORITHM_INPUT', `${label} 须为明确有界标识，不接受路径或任意来源。`);
}
function text(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TaskError('INVALID_ALGORITHM_SEMANTICS', `${label} 须为明确非空有界文本。`);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TaskError('INVALID_ALGORITHM_INPUT', `${label} 须为 JSON 对象。`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], label: string, optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TaskError('INVALID_ALGORITHM_INPUT', `${label} 字段不符；必填：${required.join('、')}。`);
  }
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TaskError('INVALID_ALGORITHM_INPUT', `${label} 未明确提供。`);
  return value;
}
function describeError(error: unknown): string { return error instanceof Error && error.message ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
/** 冻结实际参与输入转换、时间解释和结果校验的 TS 模块字节；只用于执行绑定，历史结果读取不比较它。 */
export function captureCodeBinding(): { version: string; files: Record<string, string> } {
  const current = fileURLToPath(import.meta.url), extension = extname(current), directory = dirname(current);
  const files: Record<string, string> = {};
  const selected: Array<[string, string]> = [
    [`algorithm-service${extension}`, join(directory, `algorithm-service${extension}`)],
    [`algorithm-types${extension}`, join(directory, `algorithm-types${extension}`)],
    [`managed-table${extension}`, join(directory, `managed-table${extension}`)],
    [`product-machine-snapshot${extension}`, join(directory, `product-machine-snapshot${extension}`)],
    [`purpose-eligibility${extension}`, fileURLToPath(new URL(`../collection/purpose-eligibility${extension}`, import.meta.url))],
  ];
  for (const [name, path] of selected) files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { version: `sha256:${financialDigest(files)}`, files };
}
function binaryDigest(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function json(value: unknown): JsonValue { return JSON.parse(canonical(value)) as JsonValue; }

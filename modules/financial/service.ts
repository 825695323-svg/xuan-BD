import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { digestOperationArgs, PermissionError, type PermissionCapability } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { canonical, captureAssets, executeFinancialAssets, financialDigest, verifyAssets, type FinancialAssetBundle } from '../../plugins/financial/local-compute/assets.js';
import { assertMacdToolResult, describeFinancialPublicContract, financialPublicError, financialPublicResult, requireFinancialComputedResult, validateFinancialPublicCall, type FinancialPublicCall } from './contracts.js';
import { FINANCIAL_CAPABILITIES, FINANCIAL_CONTRACT_VERSION, FINANCIAL_MACD_FIELDS, FINANCIAL_MACD_LIMITATIONS, FINANCIAL_MACD_PARAMETERS, FINANCIAL_PLUGIN_ID, FINANCIAL_PLUGIN_VERSION, FINANCIAL_RUNTIME,
  type FinancialCallArgs, type FinancialCapabilityId, type FinancialComputedCandidate, type FinancialData, type FinancialEnvironment,
  type FinancialHostSubmission, type FinancialPluginStatus, type FinancialServiceOptions, type FinancialSnapshotInput, type FinancialToolDescription } from './types.js';

const METHODS = {
  'xuen.local-finance.ma': { operation: 'MA', kind: 'indicator', version: 'ma/full-window-v1', field: 'MA',
    title: '算术移动均线', description: '调用既有 MA 实现，使用完整已提供日线窗口；不补历史、不做复权或交易解释。',
    source: 'indicators.py:95-99', reference: 'verification/indicators_math.py:20-28,43,106-128', tolerance: { absolute: 1e-8, relative: 1e-9 } },
  'xuen.local-finance.bullish_engulfing': { operation: 'bullish_engulfing', kind: 'pattern', version: 'bullish-engulfing/strict-v1', field: 'bullish_engulfing',
    title: '看涨吞没形态', description: '调用既有严格实体吞没规则；首行缺少前一条观测时返回空值，形态真假不是交易建议。',
    source: 'patterns.py:151-156', reference: 'verification/patterns_levels_verify.py:18-22,101,238-240; examples/patterns/bullish_engulfing.expected.json',
    tolerance: { boolean: 'exact', missing: 'exact' } },
  'xuen.local-finance.macd': { operation: 'MACD', kind: 'indicator', version: 'macd/12-26-9-first-valid-v1', field: 'MACD',
    title: 'MACD（指数平滑异同移动平均）', description: '调用既有12/26/9实现，在本次十日以内观测窗口显式以首值初始化；完整返回DIFF、DEA、MACD和ZERO，不补历史、不续算或自动保存。',
    source: 'indicators.py:142-152; operators.py:smooth', reference: 'first-valid recurrence hand calculation; bounded offline verification',
    tolerance: { absolute: 1e-8, relative: 1e-9 } },
} as const;
const SCHEMA = `
CREATE TABLE financial_assets (version TEXT PRIMARY KEY, bundle_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE financial_plugins (plugin_id TEXT PRIMARY KEY, plugin_version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE financial_plugin_changes (request_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, status_json TEXT NOT NULL);
CREATE TABLE financial_calls (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), implementation_version TEXT NOT NULL REFERENCES financial_assets(version),
 plugin_state_version INTEGER NOT NULL, permission_version INTEGER NOT NULL, environment TEXT NOT NULL, runtime_digest TEXT NOT NULL,
 snapshot_binding_json TEXT, sealed_json TEXT, sealed_digest TEXT, raw_result_json TEXT
);
`;
interface CallRow {
  task_id: string; implementation_version: string; plugin_state_version: number; permission_version: number;
  environment: FinancialEnvironment; runtime_digest: string; snapshot_binding_json: string | null;
  sealed_json: string | null; sealed_digest: string | null; raw_result_json: string | null;
}
interface SealedInput { data: FinancialData; reference: JsonValue; raw: JsonValue | null }

/** 任务状态仍由 TaskService 唯一持有；此表只保管固定计算契约、实现和输入。 */
export class FinancialService {
  readonly versionBinding: Record<string, string | null>;
  private readonly bundle: FinancialAssetBundle;
  private readonly runtimeDigest: string;
  private readonly pythonExecutable: string;
  private readonly assetsRoot: string;
  private readonly snapshotCapabilities: readonly PermissionCapability[];
  private readonly snapshotBinding: { version: string; contractDigest: string } | null;
  private readonly readSnapshot: FinancialServiceOptions['readSnapshot'];
  private readonly activeControllers = new Set<AbortController>();

  constructor(private readonly options: FinancialServiceOptions) {
    if (!['local-review', 'synthetic-test'].includes(options.environment)) throw new TaskError('FINANCIAL_NOT_ENABLED', '金融工具只允许本机预览或隔离合成环境。');
    this.assetsRoot = realpathSync(options.computeAssetsRoot);
    this.bundle = captureAssets(this.assetsRoot);
    if (options.expectedAssetsVersion !== undefined && this.bundle.version !== options.expectedAssetsVersion) throw new TaskError('FINANCIAL_IMPLEMENTATION_CHANGED', '实际封闭计算实现与受控登记版本不一致，未迁移或写入金融状态。');
    if (!isAbsolute(options.pythonExecutable)) throw new TaskError('FINANCIAL_DEPENDENCY_UNAVAILABLE', 'Python 运行环境必须由受信宿主明确指定。');
    this.pythonExecutable = realpathSync(options.pythonExecutable);
    if (!statSync(this.pythonExecutable).isFile()) throw new TaskError('FINANCIAL_DEPENDENCY_UNAVAILABLE', '指定 Python 运行环境不是普通可执行文件。');
    this.runtimeDigest = binaryDigest(this.pythonExecutable);
    this.snapshotCapabilities = structuredClone(options.snapshotCapabilities ?? []);
    this.snapshotBinding = options.snapshotBinding ? structuredClone(options.snapshotBinding) : null;
    this.readSnapshot = options.readSnapshot;
    if (this.readSnapshot && (!this.snapshotBinding || options.snapshotCapabilities === undefined)) throw new TaskError('FINANCIAL_SNAPSHOT_UNBOUND', '固定快照读取必须同时装配合同版本和明确权限范围。');
    if (this.snapshotBinding) {
      text(this.snapshotBinding.version);
      if (!/^[a-f0-9]{64}$/u.test(this.snapshotBinding.contractDigest)) throw new TaskError('FINANCIAL_SNAPSHOT_UNBOUND', '固定快照合同摘要无效。');
    }
    this.versionBinding = Object.freeze({ financial: FINANCIAL_CONTRACT_VERSION, plugin: FINANCIAL_PLUGIN_VERSION,
      implementation: this.bundle.version, environment: options.environment, python: this.runtimeDigest,
      snapshotContract: this.snapshotBinding?.version ?? null, snapshotContractDigest: this.snapshotBinding?.contractDigest ?? null });
    options.database.migrate('financial', 1, SCHEMA);
    options.database.migrate('financial_public_calls', 1, `CREATE TABLE financial_public_calls (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id), request_json TEXT NOT NULL, request_digest TEXT NOT NULL);`);
    const hostSchemaVersion = Number(this.db.prepare('SELECT version FROM schema_versions WHERE module=?').get('financial_host_submissions')?.version ?? 0);
    if (hostSchemaVersion < 1) options.database.migrate('financial_host_submissions', 1, `CREATE TABLE financial_host_submissions (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id));`);
    options.database.migrate('financial_host_submissions', 2, 'ALTER TABLE financial_host_submissions ADD COLUMN bound_at INTEGER;');
    this.db.prepare('INSERT OR IGNORE INTO financial_assets VALUES(?,?,?)').run(this.bundle.version, canonical(this.bundle), Date.now());
    this.db.prepare('INSERT OR IGNORE INTO financial_plugins(plugin_id,plugin_version) VALUES(?,?)').run(FINANCIAL_PLUGIN_ID, FINANCIAL_PLUGIN_VERSION);
    if (this.pluginRow().plugin_version !== FINANCIAL_PLUGIN_VERSION) throw new TaskError('FINANCIAL_PLUGIN_VERSION_CONFLICT', '已保管插件版本不同，须明确升级。');
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  status(): FinancialPluginStatus {
    const plugin = this.pluginRow();
    return { pluginId: FINANCIAL_PLUGIN_ID, pluginVersion: FINANCIAL_PLUGIN_VERSION, contractVersion: FINANCIAL_CONTRACT_VERSION,
      implementationVersion: this.bundle.version, environment: this.options.environment, enabled: plugin.enabled === 1,
      version: plugin.version, capabilities: [...FINANCIAL_CAPABILITIES], permissionVersion: this.options.permissions.policyVersion };
  }
  list(): FinancialToolDescription[] { return this.status().enabled ? FINANCIAL_CAPABILITIES.map(id => this.describe(id)) : []; }
  describe(capabilityId: string): FinancialToolDescription {
    const id = capability(capabilityId), method = METHODS[id], macd = id === FINANCIAL_CAPABILITIES[2];
    const description: FinancialToolDescription = { capabilityId: id, pluginId: FINANCIAL_PLUGIN_ID, pluginVersion: FINANCIAL_PLUGIN_VERSION,
      methodVersion: method.version, contractVersion: FINANCIAL_CONTRACT_VERSION, implementationVersion: this.bundle.version,
      title: method.title, description: method.description, enabled: this.status().enabled,
      parameters: id === FINANCIAL_CAPABILITIES[0] ? { type: 'object', required: ['period'], additionalProperties: false,
        properties: { period: { type: 'integer', minimum: 1, maximum: 10000 } } } : macd
        ? { type: 'object', required: ['short_period', 'long_period', 'signal_period', 'init'], additionalProperties: false,
          properties: { short_period: { type: 'integer', const: 12, minimum: 12, maximum: 12 }, long_period: { type: 'integer', const: 26, minimum: 26, maximum: 26 },
            signal_period: { type: 'integer', const: 9, minimum: 9, maximum: 9 }, init: { type: 'string', const: 'first_valid' } } }
        : { type: 'object', additionalProperties: false, properties: {} },
      inputContract: { contractVersion: FINANCIAL_CONTRACT_VERSION, inputKinds: ['direct', 'snapshot'], frequency: '1d',
        directSchema: { type: 'object', required: ['kind', 'inputId', 'data'], additionalProperties: false,
          properties: { kind: { const: 'direct' }, inputId: { type: 'string', description: '1-256 character bounded ID; no path or URL' },
            data: { type: 'object', required: ['metadata', 'rows'], additionalProperties: false, properties: {
              metadata: { type: 'object', additionalProperties: false, required: ['series_id', 'frequency', 'timezone', 'price_unit', 'currency', 'adjustment', 'adjustment_basis',
                'window_start', 'window_end', 'observations_are_consecutive', 'as_of', 'availability_basis', 'synthetic'], properties: {
                  series_id: { type: 'string' }, frequency: { const: '1d' }, timezone: { type: 'string', description: 'explicit IANA timezone, e.g. Asia/Shanghai' },
                  price_unit: { const: 'currency_per_share' }, currency: { type: 'string', description: 'recognized uppercase three-letter currency code, e.g. CNY' },
                  adjustment: { enum: ['unadjusted', 'forward_adjusted', 'backward_adjusted', 'as_stored'] }, adjustment_basis: { type: 'string', description: 'explicit known basis; unknown is rejected' },
                  window_start: { type: 'string', format: 'date', description: 'YYYY-MM-DD, same as first row timestamp' },
                  window_end: { type: 'string', format: 'date', description: 'YYYY-MM-DD, same as last row timestamp' }, observations_are_consecutive: { const: true },
                  as_of: { type: 'string', format: 'date-time', description: 'instant including seconds and Z or timezone offset; e.g. 2026-01-05T16:00:00+08:00' },
                  availability_basis: { const: 'explicit_per_bar' }, synthetic: { type: 'boolean', description: this.options.environment === 'synthetic-test' ? 'must be true in synthetic-test environment' : 'declare actual input provenance; real user input is false' } } },
              rows: { type: 'array', minItems: 1, maxItems: macd ? 10 : 512, items: { type: 'object', additionalProperties: false, required: requiredFields(id), properties: {
                timestamp: { type: 'string', format: 'date', description: 'business date YYYY-MM-DD, strictly increasing; never a date-time' },
                close: { type: 'number', exclusiveMinimum: 0 }, open: { type: 'number', exclusiveMinimum: 0 }, high: { type: 'number', exclusiveMinimum: 0 }, low: { type: 'number', exclusiveMinimum: 0 },
                available_at: { type: 'string', format: 'date-time', description: 'closed bar available instant including timezone, no later than as_of' }, bar_closed: { const: true } } } } } } } },
        snapshotSchema: { type: 'object', additionalProperties: false, required: ['kind', 'productId', 'snapshotId', 'outputIdentity', 'referenceDependencies', 'fields', 'range', 'useMode'],
          properties: { kind: { const: 'snapshot' }, productId: { type: 'string' }, snapshotId: { type: 'string', description: 'fixed snapshot ID; latest is forbidden' },
            outputIdentity: { type: 'object', required: ['unitId', 'outputId', 'definitionRevision', 'schemaRevision'] },
            referenceDependencies: { type: 'array', maxItems: 32, items: { type: 'object', required: ['referenceId', 'snapshotId'] } },
            fields: { type: 'array', uniqueItems: true, items: { enum: ['timestamp', 'open', 'high', 'low', 'close', 'available_at', 'bar_closed'] }, requiredValues: requiredFields(id) },
            range: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } } }, useMode: { const: 'analysis' } } },
        priceUnit: 'currency_per_share', currency: 'explicit uppercase three-letter currency code',
        requiredMetadata: ['series_id', 'frequency', 'timezone', 'price_unit', 'currency', 'adjustment', 'adjustment_basis', 'window_start', 'window_end',
          'observations_are_consecutive', 'as_of', 'availability_basis', 'synthetic'],
        requiredFields: [...requiredFields(id)], adjustment: ['unadjusted', 'forward_adjusted', 'backward_adjusted', 'as_stored'],
        availability: 'each bar_closed=true; available_at includes timezone and is no later than as_of; no future observation dependency',
        missing: macd ? 'reject missing close; first_valid seeds the first supplied observation; no additional history is fetched'
          : 'reject required missing fields; insufficient history yields null and invalid interval', maxRows: macd ? 10 : 512, maxInputBytes: 100000,
        ...(macd ? { maxNaturalDays: 10, initialization: 'first_valid', continuation: 'not_supported', priorHistory: 'not_fetched' } : {}),
        snapshot: { fixedSnapshotRequired: true, referenceDependencies: 'explicit array', useMode: 'analysis', range: 'explicit start and end',
          readBinding: this.snapshotBinding, bindingAvailable: !!this.readSnapshot } },
      outputContract: { status: 'computed', persistence: 'not_requested', field: method.field,
        fieldType: method.kind === 'indicator' ? 'number|null' : 'boolean|null', allowedError: method.tolerance,
        validInterval: 'first and last valid supplied observation, or null', invalidIntervals: 'leading insufficient-history observations',
        unit: method.kind === 'indicator' ? 'same price unit and currency as input' : 'boolean', externalActionExecuted: false,
        ...(macd ? { fields: [...FINANCIAL_MACD_FIELDS], fieldType: 'number', initialization: 'first_valid', leadingInvalidRows: 0,
          zeroReferenceField: 'ZERO', continuation: 'not_supported', publication: 'unsupported_without_registered_target', limitations: [...FINANCIAL_MACD_LIMITATIONS] } : {}) },
      methodEvidence: { implementation: method.source, independentReference: method.reference, fileHashes: this.bundle.hashes },
      executionConstraints: { firstPartyOnly: true, network: 'disabled', userFileAccess: 'disabled', childExecution: 'disabled',
        input: 'stdin JSON; no data_file, csv_file, arbitrary module or source code', pythonFlags: ['-I', '-S', '-B'],
        timeoutMs: 15000, resultByteLimit: 400000, sandbox: 'audited first-party adapter; not a complete sandbox for untrusted packages' } };
    description.publicContract = describeFinancialPublicContract(description);
    return description;
  }

  validate(operation: string, args: unknown): Record<string, JsonValue> {
    const value = record(args);
    if (operation === 'tools.list' || operation === 'plugins.status') exact(value, []);
    else if (operation === 'tools.describe') { exact(value, ['capabilityId']); capability(value.capabilityId); }
    else if (operation === 'plugins.enable' || operation === 'plugins.disable') validateMutation(value);
    else if (operation === 'tools.call') this.normalizeCall(value);
    else throw new TaskError('FINANCIAL_OPERATION_DISABLED', '此操作不属于金融工具模块。');
    return json(value) as Record<string, JsonValue>;
  }

  normalizeCall(value: unknown): { args: FinancialCallArgs; publicRequest: FinancialPublicCall | null } {
    const data = record(value);
    if (Object.hasOwn(data, 'protocol_version')) {
      const parsed = validateFinancialPublicCall(data, { validate: (_operation, args) => {
        const candidate = record(args); validateCall(candidate, this.options.environment); return json(candidate) as Record<string, JsonValue>;
      } });
      return { args: parsed.args, publicRequest: parsed.request };
    }
    validateCall(data, this.options.environment);
    return { args: json(data) as unknown as FinancialCallArgs, publicRequest: null };
  }
  publicRequest(taskId: string): FinancialPublicCall | null {
    const row = this.db.prepare('SELECT request_json,request_digest FROM financial_public_calls WHERE task_id=?').get(taskId);
    if (!row) return null;
    const request = JSON.parse(String(row.request_json)) as FinancialPublicCall;
    if (financialDigest(request) !== row.request_digest) throw new TaskError('FINANCIAL_PUBLIC_REQUEST_CHANGED', '原公共请求与持久摘要不一致。');
    return request;
  }
  publicTaskView(task: TaskRecord): JsonValue | null {
    const request = this.publicRequest(task.id);
    if (!request) return null;
    return json({ protocol_version: request.protocol_version, request_id: request.request_id, job_id: task.id, status: task.status,
      result: task.status === 'succeeded' ? financialPublicResult(task, request.request_id) : null,
      error: task.error ? financialPublicError(new TaskError(task.error.code, task.error.message), { requestId: request.request_id, jobId: task.id, stage: 'execute' }) : null });
  }

  setEnabled(enabled: boolean, args: unknown, requestId?: string): FinancialPluginStatus {
    if (typeof enabled !== 'boolean') throw new TaskError('INVALID_FINANCIAL_ARGS', '插件状态须为布尔值。');
    const mutation = this.validate(enabled ? 'plugins.enable' : 'plugins.disable', args);
    if (requestId !== undefined) identifier(requestId);
    const inputDigest = financialDigest({ enabled, mutation });
    let changed = false;
    const result = this.options.database.transaction(() => {
      const previous = requestId === undefined ? undefined : this.db.prepare('SELECT * FROM financial_plugin_changes WHERE request_id=?').get(requestId);
      if (previous) {
        if (previous.input_digest !== inputDigest) throw new TaskError('REQUEST_CONFLICT', '相同插件请求身份不能用于不同变更。');
        return JSON.parse(String(previous.status_json)) as FinancialPluginStatus;
      }
      const current = this.pluginRow();
      if (mutation.expectedVersion !== current.version) throw new TaskError('FINANCIAL_PLUGIN_STATE_CONFLICT', '插件状态已变化，请先读取当前版本。');
      if (current.enabled !== Number(enabled)) {
        this.db.prepare('UPDATE financial_plugins SET enabled=?,version=version+1 WHERE plugin_id=?').run(Number(enabled), FINANCIAL_PLUGIN_ID);
        changed = true;
      }
      const result = this.status();
      if (requestId !== undefined) this.db.prepare('INSERT INTO financial_plugin_changes VALUES(?,?,?)').run(requestId, inputDigest, canonical(result));
      return result;
    });
    if (changed && !enabled) for (const controller of this.activeControllers) controller.abort(new TaskError('FINANCIAL_PLUGIN_DISABLED', '插件已停用，本次计算已请求停止。'));
    return result;
  }
  enable(args: unknown, requestId?: string): FinancialPluginStatus { return this.setEnabled(true, args, requestId); }
  disable(args: unknown, requestId?: string): FinancialPluginStatus { return this.setEnabled(false, args, requestId); }

  requestTask(operation: string, requestId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE runtime_id=? AND request_id=?').get(FINANCIAL_RUNTIME, requestKey(operation, requestId));
    return row ? this.getTask(String(row.id)) : null;
  }
  submit(operation: string, args: unknown, requestId: string, parentTaskId?: string, host?: FinancialHostSubmission): TaskRecord {
    if (operation !== 'tools.call') throw new TaskError('FINANCIAL_OPERATION_DISABLED', '只有计算调用创建金融任务。');
    const normalized = this.normalizeCall(args), data = normalized.args, publicRequest = normalized.publicRequest;
    if (publicRequest && publicRequest.request_id !== requestId) throw new TaskError('REQUEST_CONFLICT', '外层请求编号须与公共请求身份一致。');
    const previous = this.requestTask(operation, requestId);
    if (previous) {
      this.assertDispatch();
      const call = this.callRow(previous.id), versions = { ...this.versionBinding, method: data.methodVersion,
        permission: String(call.permission_version), pluginState: String(call.plugin_state_version) };
      if (previous.conversationId !== null || previous.title !== `金融计算：${METHODS[data.capabilityId].title}`
        || previous.action !== operation || financialDigest(previous.versions) !== financialDigest(versions)
        || financialDigest(previous.args) !== financialDigest(data) || (previous.parentTaskId ?? undefined) !== parentTaskId
        || financialDigest(this.publicRequest(previous.id)) !== financialDigest(publicRequest)) throw new TaskError('REQUEST_CONFLICT', '相同计算请求身份不能换输入、参数、版本或公共合同。');
      this.assertBinding(previous);
      this.bindBeforeStart(host, previous);
      return previous;
    }
    this.assertDispatch();
    if (data.implementationVersion !== this.bundle.version) throw new TaskError('FINANCIAL_IMPLEMENTATION_CONFLICT', '新调用须明确采用当前已说明的实现版本。');
    if (data.input.kind === 'snapshot' && !this.readSnapshot) throw new TaskError('FINANCIAL_SNAPSHOT_UNBOUND', '受信宿主尚未装配固定快照读取。');
    const plugin = this.pluginRow();
    if (!plugin.enabled) throw new TaskError('FINANCIAL_PLUGIN_DISABLED', '金融插件尚未启用。');
    const versions = { ...this.versionBinding, method: data.methodVersion, permission: String(this.options.permissions.policyVersion), pluginState: String(plugin.version) };
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: `金融计算：${METHODS[data.capabilityId].title}`, ownerRole: 'service', runtimeId: FINANCIAL_RUNTIME,
        action: operation, args: json(data), requestId: requestKey(operation, requestId), versions, parentTaskId });
      const sealed: SealedInput | null = data.input.kind === 'direct' ? { data: data.input.data, reference: json({ kind: 'direct', inputId: data.input.inputId }), raw: null } : null;
      this.db.prepare('INSERT INTO financial_calls(task_id,implementation_version,plugin_state_version,permission_version,environment,runtime_digest,snapshot_binding_json,sealed_json,sealed_digest) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(accepted.task.id, this.bundle.version, plugin.version, this.options.permissions.policyVersion, this.options.environment, this.runtimeDigest,
          data.input.kind === 'snapshot' ? canonical(this.snapshotBinding) : null, sealed ? canonical(sealed) : null, sealed ? financialDigest(sealed) : null);
      if (publicRequest) this.db.prepare('INSERT INTO financial_public_calls VALUES(?,?,?)').run(accepted.task.id, canonical(publicRequest), financialDigest(publicRequest));
      if (host?.beforeStart) this.db.prepare('INSERT INTO financial_host_submissions(task_id) VALUES(?)').run(accepted.task.id);
    });
    this.bindBeforeStart(host, accepted.task);
    accepted.publish();
    return this.tasks.start(accepted.task.id);
  }

  resume(taskId: string, expectedVersion: number): TaskRecord {
    const task = this.getTask(taskId);
    if (task.status === 'succeeded') return task;
    this.assertBinding(task); this.assertDispatch();
    this.assertHostBinding(task);
    if (task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请先读取当前版本。');
    if (task.status === 'ready') return this.tasks.start(taskId, expectedVersion);
    if (task.status === 'paused' || task.status === 'interrupted') return this.tasks.resume(taskId, expectedVersion);
    if (task.status === 'failed' || task.status === 'cancelled') return this.tasks.retry(taskId, expectedVersion);
    throw new TaskError('TASK_BUSY', '当前计算尚未收束，不能开启另一尝试。');
  }
  evidence(taskId: string): JsonValue {
    const task = this.getTask(taskId), call = this.callRow(taskId), bundle = this.loadBundle(call.implementation_version);
    const { sealed_json: _sealed, raw_result_json: _result, ...binding } = call;
    return json({ task, binding,
      sealedInput: call.sealed_json ? JSON.parse(call.sealed_json) : null, inputDigest: call.sealed_digest,
      rawToolResult: call.raw_result_json ? JSON.parse(call.raw_result_json) : null, implementation: { version: bundle.version, hashes: bundle.hashes },
      publicRequest: this.publicRequest(taskId) });
  }
  readonly runtime: TaskRuntime = { id: FINANCIAL_RUNTIME, execute: context => this.execute(context) };

  private async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const controller = new AbortController(); this.activeControllers.add(controller);
    try { return await this.compute({ ...context, signal: AbortSignal.any([context.signal, controller.signal]) }); }
    finally { this.activeControllers.delete(controller); }
  }
  private bindBeforeStart(host: FinancialHostSubmission | undefined, task: TaskRecord): void {
    if (!host?.beforeStart && this.db.prepare('SELECT task_id FROM financial_host_submissions WHERE task_id=?').get(task.id)) {
      throw new TaskError('FINANCIAL_HOST_BINDING_REQUIRED', '原金融请求需要受信宿主来源绑定，普通重试不能绕过启动前核对。');
    }
    if (host?.beforeStart) this.db.prepare('INSERT OR IGNORE INTO financial_host_submissions(task_id) VALUES(?)').run(task.id);
    const value: unknown = host?.beforeStart?.(task);
    if (value && typeof value === 'object' && 'then' in value) {
      if (value instanceof Promise) void value.catch(() => {});
      throw new TaskError('FINANCIAL_HOST_BINDING_ASYNC_UNSUPPORTED', '启动前来源绑定必须同步确认持久保存，不能把未等待的异步回调当完成。');
    }
    if (host?.beforeStart) this.db.prepare('UPDATE financial_host_submissions SET bound_at=? WHERE task_id=?').run(Date.now(), task.id);
  }
  private assertHostBinding(task: TaskRecord): void {
    const binding = this.db.prepare('SELECT bound_at FROM financial_host_submissions WHERE task_id=?').get(task.id);
    if (binding && binding.bound_at === null) throw new TaskError('FINANCIAL_HOST_BINDING_REQUIRED', '原金融请求尚未成功保存受信来源，不能借恢复绕过启动前绑定。');
  }
  private assertFinancialTaskReadable(context: TaskExecutionContext): void {
    this.assertHostBinding(context.task);
    const value: unknown = this.options.assertFinancialTaskReadable?.(context);
    if (value && typeof value === 'object' && 'then' in value) {
      if (value instanceof Promise) void value.catch(() => {});
      throw new TaskError('FINANCIAL_HOST_SOURCE_ASYNC_UNSUPPORTED', '金融来源资格须同步核对，不能把未等待的回调当作当前授权。');
    }
  }
  private async compute(context: TaskExecutionContext): Promise<TaskResult> {
    this.assertActive(context); this.assertBinding(context.task);
    this.assertFinancialTaskReadable(context);
    const args = context.task.args as unknown as FinancialCallArgs, call = this.callRow(context.task.id), method = METHODS[args.capabilityId];
    if (call.sealed_json === null) {
      if (args.input.kind !== 'snapshot' || !this.readSnapshot) throw new TaskError('FINANCIAL_SNAPSHOT_UNBOUND', '原快照读取入口不可取回。');
      const operation = { operationId: 'financial.snapshot.read', operationVersion: 1, approvalMode: 'automatic' as const, argsDigest: digestOperationArgs(args.input),
        targets: this.snapshotCapabilities.map(item => item.target) };
      await this.authorize(context, operation, this.snapshotCapabilities);
      this.assertActive(context); this.assertBinding(context.task);
      const response = await this.readSnapshot(structuredClone(args.input), context);
      this.assertActive(context); this.assertBinding(context.task);
      if (financialDigest(response.reference) !== financialDigest(args.input)) throw new TaskError('FINANCIAL_SNAPSHOT_MISMATCH', '数据库返回的固定快照、参考依赖或范围与请求不符。');
      const sealed: SealedInput = { data: validateData(response.data, args.capabilityId, this.options.environment), reference: json(response.reference), raw: json(response.raw) };
      if (sealed.data.metadata.window_start !== args.input.range.start || sealed.data.metadata.window_end !== args.input.range.end) throw new TaskError('FINANCIAL_SNAPSHOT_MISMATCH', '实际快照窗口与冻结读取范围不符。');
      if (Buffer.byteLength(canonical(sealed)) > 400_000) throw new TaskError('FINANCIAL_INPUT_BUDGET', '固定快照及原响应超过本包保管预算。');
      this.options.database.transaction(() => {
        this.assertActive(context); this.assertBinding(context.task);
        this.db.prepare('UPDATE financial_calls SET sealed_json=?,sealed_digest=? WHERE task_id=? AND sealed_json IS NULL').run(canonical(sealed), financialDigest(sealed), context.task.id);
      });
      await context.emit({ type: 'checkpoint', checkpoint: { phase: 'input-sealed', inputDigest: financialDigest(sealed), implementationVersion: call.implementation_version } });
    }
    const sealedCall = this.callRow(context.task.id), sealed = JSON.parse(sealedCall.sealed_json!) as SealedInput;
    if (financialDigest(sealed) !== sealedCall.sealed_digest) throw new TaskError('FINANCIAL_INPUT_CHANGED', '原任务封闭输入与摘要不符。');
    validateData(sealed.data, args.capabilityId, this.options.environment);
    const operation = { operationId: 'financial.compute', operationVersion: 1, approvalMode: 'automatic' as const,
      argsDigest: digestOperationArgs({ capabilityId: args.capabilityId, implementationVersion: call.implementation_version, inputDigest: sealedCall.sealed_digest, parameters: args.parameters }),
      targets: [{ kind: 'file' as const, path: this.pythonExecutable }] };
    const capabilities = [{ action: 'execute' as const, target: { kind: 'file' as const, path: this.pythonExecutable } }];
    const approvalId = await this.authorize(context, operation, capabilities);
    const assertAuthorized = () => { this.assertActive(context); this.assertBinding(context.task); this.assertFinancialTaskReadable(context); context.assertAuthorized(operation, capabilities, { approvalId }); };
    assertAuthorized();
    const raw = await executeFinancialAssets({ bundle: this.loadBundle(call.implementation_version),
      request: json({ version: 1, kind: method.kind, operation: method.operation, params: args.parameters, data: sealed.data }),
      processRuntime: this.options.processRuntime, pythonExecutable: this.pythonExecutable, cwd: '/', context, assertAuthorized });
    assertAuthorized();
    this.options.database.transaction(() => {
      this.assertActive(context); this.assertBinding(context.task);
      this.db.prepare('UPDATE financial_calls SET raw_result_json=? WHERE task_id=?').run(canonical(raw), context.task.id);
    });
    const candidate = computedCandidate(context.task, args, sealed, sealedCall.sealed_digest!, raw, this.options.environment);
    return { summary: `${method.title}计算完成；结果为临时候选，尚未正式保存。`, data: json(candidate) };
  }

  private async authorize(context: TaskExecutionContext, operation: Parameters<TaskExecutionContext['assertAuthorized']>[0], capabilities: readonly PermissionCapability[]): Promise<string | undefined> {
    // 显式空集合仅表示受信宿主回调不访问外部资源；不制造虚假的文件/网络授权目标。
    if (!capabilities.length) return undefined;
    try { context.assertAuthorized(operation, capabilities); return undefined; }
    catch (error) {
      if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
      return (await context.requestApproval(operation, capabilities)).approvalId ?? undefined;
    }
  }
  private loadBundle(version: string): FinancialAssetBundle {
    const row = this.db.prepare('SELECT bundle_json FROM financial_assets WHERE version=?').get(version);
    if (!row) throw new TaskError('FINANCIAL_IMPLEMENTATION_UNAVAILABLE', '原任务固定实现不可取回，拒绝换版。');
    const bundle = JSON.parse(String(row.bundle_json)) as FinancialAssetBundle; verifyAssets(bundle); return bundle;
  }
  private pluginRow(): { plugin_version: string; enabled: number; version: number } {
    return this.db.prepare('SELECT * FROM financial_plugins WHERE plugin_id=?').get(FINANCIAL_PLUGIN_ID) as unknown as { plugin_version: string; enabled: number; version: number };
  }
  private callRow(taskId: string): CallRow {
    const row = this.db.prepare('SELECT * FROM financial_calls WHERE task_id=?').get(taskId);
    if (!row) throw new TaskError('FINANCIAL_TASK_NOT_FOUND', '没有找到此金融计算绑定。');
    return row as unknown as CallRow;
  }
  private getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.runtimeId !== FINANCIAL_RUNTIME || task.ownerRole !== 'service') throw new TaskError('FINANCIAL_TASK_NOT_FOUND', '此任务不属于金融工具模块。');
    return task;
  }
  private assertBinding(task: TaskRecord): void {
    const call = this.callRow(task.id), plugin = this.pluginRow();
    if (!plugin.enabled || plugin.version !== call.plugin_state_version) throw new TaskError('FINANCIAL_PLUGIN_STATE_CHANGED', '原任务固定的插件启用代次已失效，不能悄悄重新启用旧调用。');
    if (call.permission_version !== this.options.permissions.policyVersion) throw new TaskError('FINANCIAL_PERMISSION_CHANGED', '原任务固定权限版本已变化，须明确新建计算请求。');
    if (call.environment !== this.options.environment || call.runtime_digest !== this.runtimeDigest || binaryDigest(this.pythonExecutable) !== call.runtime_digest) throw new TaskError('FINANCIAL_RUNTIME_CHANGED', '原任务运行环境已变化，拒绝静默换环境继续。');
    const args = task.args as unknown as FinancialCallArgs;
    validateCall(record(args), this.options.environment);
    if (args.implementationVersion !== call.implementation_version || task.versions.implementation !== call.implementation_version
      || task.versions.method !== args.methodVersion || task.versions.financial !== FINANCIAL_CONTRACT_VERSION
      || task.versions.plugin !== FINANCIAL_PLUGIN_VERSION || task.versions.permission !== String(call.permission_version)
      || task.versions.pluginState !== String(call.plugin_state_version)) throw new TaskError('FINANCIAL_VERSION_CONFLICT', '原任务方法或版本绑定不符，拒绝换版。');
    if (args.input.kind === 'snapshot' && canonical(this.snapshotBinding) !== call.snapshot_binding_json) throw new TaskError('FINANCIAL_SNAPSHOT_BINDING_CHANGED', '原任务固定快照端口合同已变化。');
    this.loadBundle(call.implementation_version);
  }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '服务已停止新的金融计算和读取派发。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted(); this.assertDispatch();
    if (!this.tasks.isRunActive(context.runId, context.generation)) throw new TaskError('STALE_FINANCIAL_ATTEMPT', '此计算尝试已失去当前运行所有权。');
  }
}

function validateCall(value: Record<string, unknown>, environment: FinancialEnvironment): void {
  exact(value, ['capabilityId', 'pluginVersion', 'methodVersion', 'implementationVersion', 'input', 'parameters']);
  const id = capability(value.capabilityId);
  if (value.pluginVersion !== FINANCIAL_PLUGIN_VERSION || value.methodVersion !== METHODS[id].version) throw new TaskError('FINANCIAL_VERSION_CONFLICT', '工具插件与方法版本须与完整说明一致。');
  if (typeof value.implementationVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.implementationVersion)) throw new TaskError('FINANCIAL_VERSION_CONFLICT', '须明确固定计算实现摘要。');
  const params = record(value.parameters);
  if (id === FINANCIAL_CAPABILITIES[0]) { exact(params, ['period']); if (!Number.isSafeInteger(params.period) || Number(params.period) < 1 || Number(params.period) > 10000) throw new TaskError('INVALID_FINANCIAL_PARAMETERS', 'period 须为 1 至 10000 的整数。'); }
  else if (id === FINANCIAL_CAPABILITIES[2]) {
    exact(params, ['short_period', 'long_period', 'signal_period', 'init']);
    if (financialDigest(params) !== financialDigest(FINANCIAL_MACD_PARAMETERS)) throw new TaskError('INVALID_FINANCIAL_PARAMETERS', '本轮MACD只支持12/26/9及显式init:first_valid（首值初始化），不接受续算状态。');
  } else exact(params, []);
  const input = record(value.input);
  if (input.kind === 'direct') { exact(input, ['kind', 'inputId', 'data']); identifier(input.inputId); validateData(input.data, id, environment); }
  else if (input.kind === 'snapshot') validateSnapshot(input, id);
  else throw new TaskError('INVALID_FINANCIAL_INPUT', '只接受直接输入或固定快照输入。');
  if (Buffer.byteLength(canonical(value)) > 100000) throw new TaskError('FINANCIAL_INPUT_BUDGET', '直接计算请求超过本包预算。');
}
function validateMutation(value: Record<string, unknown>): void {
  exact(value, ['pluginId', 'pluginVersion', 'expectedVersion']);
  if (value.pluginId !== FINANCIAL_PLUGIN_ID || value.pluginVersion !== FINANCIAL_PLUGIN_VERSION) throw new TaskError('FINANCIAL_PLUGIN_VERSION_CONFLICT', '插件身份或版本不符。');
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0) throw new TaskError('INVALID_FINANCIAL_ARGS', '插件状态版本须为非负整数。');
}
function validateSnapshot(value: Record<string, unknown>, id: FinancialCapabilityId): void {
  exact(value, ['kind', 'productId', 'snapshotId', 'outputIdentity', 'referenceDependencies', 'fields', 'range', 'useMode']);
  identifier(value.productId); identifier(value.snapshotId);
  if (String(value.snapshotId).toLowerCase() === 'latest') throw new TaskError('INVALID_FINANCIAL_SNAPSHOT', '不能使用可变的最新快照别名。');
  const output = record(value.outputIdentity); exact(output, ['unitId', 'outputId', 'definitionRevision', 'schemaRevision']); Object.values(output).forEach(identifier);
  if (!Array.isArray(value.referenceDependencies) || value.referenceDependencies.length > 32) throw new TaskError('INVALID_FINANCIAL_SNAPSHOT', '参考依赖须明确提供有界数组。');
  const referenceIds = new Set<string>();
  value.referenceDependencies.forEach(item => {
    const ref = record(item); exact(ref, ['referenceId', 'snapshotId']); Object.values(ref).forEach(identifier);
    if (String(ref.snapshotId).toLowerCase() === 'latest' || referenceIds.has(String(ref.referenceId))) throw new TaskError('INVALID_FINANCIAL_SNAPSHOT', '参考依赖必须唯一且固定快照，不能使用最新别名。');
    referenceIds.add(String(ref.referenceId));
  });
  if (!Array.isArray(value.fields) || new Set(value.fields).size !== value.fields.length
    || value.fields.some(field => !['timestamp', 'open', 'high', 'low', 'close', 'available_at', 'bar_closed'].includes(String(field)))
    || requiredFields(id).some(field => !(value.fields as unknown[]).includes(field))) throw new TaskError('INVALID_FINANCIAL_SNAPSHOT', '固定快照字段缺少所需价格或逐行可得时间声明。');
  const range = record(value.range); exact(range, ['start', 'end']); day(range.start); day(range.end);
  if (String(range.start) > String(range.end) || value.useMode !== 'analysis') throw new TaskError('INVALID_FINANCIAL_SNAPSHOT', '读取范围或分析使用模式无效。');
  if (id === FINANCIAL_CAPABILITIES[2] && Date.parse(String(range.end)) - Date.parse(String(range.start)) > 9 * 86_400_000) throw new TaskError('FINANCIAL_INPUT_BUDGET', '本轮MACD固定快照窗口不得超过十个自然日。');
}
export function validateFinancialData(value: unknown, id: FinancialCapabilityId, environment: FinancialEnvironment): FinancialData { return validateData(value, id, environment); }
function validateData(value: unknown, id: FinancialCapabilityId, environment: FinancialEnvironment): FinancialData {
  const data = record(value); exact(data, ['metadata', 'rows']); const metadata = record(data.metadata);
  exact(metadata, ['series_id', 'frequency', 'timezone', 'price_unit', 'currency', 'adjustment', 'adjustment_basis', 'window_start', 'window_end',
    'observations_are_consecutive', 'as_of', 'availability_basis', 'synthetic']);
  identifier(metadata.series_id);
  if (metadata.frequency !== '1d') throw new TaskError('FINANCIAL_FREQUENCY_UNSUPPORTED', '首包只接受已经明确为日线的数据，不转换周期。');
  if (metadata.price_unit !== 'currency_per_share' || typeof metadata.currency !== 'string' || !/^[A-Z]{3}$/u.test(metadata.currency)
    || !Intl.supportedValuesOf('currency').includes(metadata.currency) || metadata.currency === 'XXX') throw new TaskError('FINANCIAL_UNIT_MISMATCH', '须明确每股货币价格单位及已识别三位币种码；不猜单位或缩放。');
  text(metadata.timezone); try { new Intl.DateTimeFormat('en', { timeZone: metadata.timezone as string }); } catch { throw new TaskError('INVALID_FINANCIAL_INPUT', '时区声明无效。'); }
  if (!['unadjusted', 'forward_adjusted', 'backward_adjusted', 'as_stored'].includes(String(metadata.adjustment))) throw new TaskError('INVALID_FINANCIAL_INPUT', '复权类型须明确提供。');
  text(metadata.adjustment_basis);
  if (/^(unknown|undefined|n\/?a|未知|未确定|不明)$/iu.test(String(metadata.adjustment_basis).trim())) throw new TaskError('INVALID_FINANCIAL_INPUT', '复权依据未确定，不能计算。');
  day(metadata.window_start); day(metadata.window_end); const asOf = instant(metadata.as_of);
  if (id === FINANCIAL_CAPABILITIES[2] && Date.parse(String(metadata.window_end)) - Date.parse(String(metadata.window_start)) > 9 * 86_400_000) throw new TaskError('FINANCIAL_INPUT_BUDGET', '本轮MACD只计算本次十个自然日以内的已提供观测，不补窗口之前历史。');
  if (metadata.observations_are_consecutive !== true || metadata.availability_basis !== 'explicit_per_bar' || typeof metadata.synthetic !== 'boolean'
    || (environment === 'synthetic-test' && metadata.synthetic !== true)) throw new TaskError('INVALID_FINANCIAL_INPUT', '须声明连续所供观测、逐行可得时刻和真实的合成身份。');
  if (!Array.isArray(data.rows) || !data.rows.length || data.rows.length > 512) throw new TaskError('FINANCIAL_INPUT_BUDGET', '首包接受 1 至 512 条明确日线观测。');
  let previous = '';
  for (const item of data.rows) {
    const row = record(item); exact(row, ['timestamp', 'close', 'available_at', 'bar_closed', ...(id === FINANCIAL_CAPABILITIES[1] ? ['open'] : [])], ['open', 'high', 'low']);
    const date = day(row.timestamp);
    if (date <= previous) throw new TaskError('INVALID_FINANCIAL_INPUT', '日线日期须严格递增且不能重复，不自动排序。');
    previous = date;
    for (const field of ['open', 'high', 'low', 'close']) if (Object.hasOwn(row, field) && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || Number(row[field]) <= 0)) throw new TaskError('INVALID_FINANCIAL_INPUT', '价格须为正有限数值；缺列、空值、字符串不补造。');
    const available = instant(row.available_at);
    if (row.bar_closed !== true || available > asOf || zonedDay(available, String(metadata.timezone)) < date) throw new TaskError('FINANCIAL_TIME_UNAVAILABLE', '未闭合或尚未可得的日线不能当作当时已知输入。');
    const low = row.low as number | undefined, high = row.high as number | undefined;
    if (low !== undefined && high !== undefined && low > high) throw new TaskError('INVALID_FINANCIAL_INPUT', '最低价不能高于最高价。');
    for (const field of ['open', 'close']) if (row[field] !== undefined && ((low !== undefined && Number(row[field]) < low) || (high !== undefined && Number(row[field]) > high))) throw new TaskError('INVALID_FINANCIAL_INPUT', '已提供四价关系无效。');
  }
  if (metadata.window_start !== record(data.rows[0]).timestamp || metadata.window_end !== record(data.rows.at(-1)).timestamp) throw new TaskError('INVALID_FINANCIAL_INPUT', '窗口须与所供首尾观测完全一致。');
  return json(data) as unknown as FinancialData;
}
function computedCandidate(task: TaskRecord, args: FinancialCallArgs, sealed: SealedInput, inputDigest: string, raw: JsonValue, environment: FinancialEnvironment): FinancialComputedCandidate {
  const result = record(raw), method = METHODS[args.capabilityId], rows = result.rows, macd = args.capabilityId === FINANCIAL_CAPABILITIES[2];
  if (result.ok === false) throw new TaskError('FINANCIAL_CALCULATION_FAILED', typeof result.error === 'string' ? `原计算入口拒绝：${result.error.slice(0, 1000)}` : '原计算入口明确失败，已保留原响应。');
  if (result.ok !== true || result.version !== 1 || result.kind !== method.kind || result.operation !== method.operation || result.execution_executed !== false
    || !Array.isArray(rows) || rows.length !== sealed.data.rows.length || !Array.isArray(result.diagnostics) || !result.method) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '原计算结果身份、结构或行数不符，已隔离原输出。');
  if (macd) {
    assertMacdToolResult(raw, json(args.parameters));
    if (financialDigest(result.metadata) !== financialDigest(sealed.data.metadata)) throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD原结果元信息与封闭输入不一致。');
  }
  const fields = macd ? [...FINANCIAL_MACD_FIELDS] : [method.field];
  const expectedLeading = Math.min(sealed.data.rows.length, macd ? 0 : method.kind === 'indicator' ? Number(record(args.parameters).period) - 1 : 1);
  const output = rows.map((item, index) => {
    const row = record(item); exact(row, ['timestamp', ...fields]);
    if (row.timestamp !== sealed.data.rows[index]!.timestamp || fields.some(field => {
      const value = row[field];
      return index < expectedLeading ? value !== null : method.kind === 'indicator'
        ? typeof value !== 'number' || !Number.isFinite(value) || !macd && value <= 0 : typeof value !== 'boolean';
    })) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '原计算结果行对应、有效区间或数值类型不符，已隔离原输出。');
    return { timestamp: row.timestamp as string, available_at: sealed.data.rows[index]!.available_at,
      ...Object.fromEntries(fields.map(field => [field, row[field] as JsonValue])) };
  });
  return { status: 'computed', persistence: 'not_requested', environment, taskId: task.id, capabilityId: args.capabilityId,
    pluginVersion: args.pluginVersion, methodVersion: args.methodVersion, contractVersion: FINANCIAL_CONTRACT_VERSION,
    implementationVersion: args.implementationVersion, inputDigest, inputReference: sealed.reference, parameters: json(args.parameters), metadata: sealed.data.metadata,
    rows: output, validInterval: expectedLeading < output.length ? { start: output[expectedLeading]!.timestamp, end: output.at(-1)!.timestamp } : null,
    invalidIntervals: expectedLeading ? [{ start: output[0]!.timestamp, end: output[expectedLeading - 1]!.timestamp, reason: 'insufficient_history', count: expectedLeading }] : [],
    diagnostics: json(result.diagnostics) as JsonValue[], method: json(result.method), rawToolResult: raw,
    limitations: ['仅核所供连续观测，未核交易所日历完整性。', '逐行可得时间和复权依据来自明确输入声明，未独立核实供应方。', '结果是临时候选，正式保存须另经获准数据库服务。', '形态与数值不构成风险批准、委托或成交。',
      ...(macd ? FINANCIAL_MACD_LIMITATIONS : [])], externalActionExecuted: false };
}
function requiredFields(id: FinancialCapabilityId): string[] { return ['timestamp', 'close', ...id === FINANCIAL_CAPABILITIES[1] ? ['open'] : [], 'available_at', 'bar_closed']; }
function requestKey(operation: string, requestId: string): string { identifier(requestId); return `financial:${operation}:${requestId}`; }
function binaryDigest(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function capability(value: unknown): FinancialCapabilityId { if (!(FINANCIAL_CAPABILITIES as readonly unknown[]).includes(value)) throw new TaskError('FINANCIAL_TOOL_NOT_FOUND', '此计算能力未登记。'); return value as FinancialCapabilityId; }
function identifier(value: unknown): void { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,255}$/u.test(value)) throw new TaskError('INVALID_FINANCIAL_ARGS', '金融身份须为明确有界标识，不接受路径或任意来源。'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TaskError('INVALID_FINANCIAL_ARGS', '金融参数须为 JSON 对象。'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void { if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TaskError('INVALID_FINANCIAL_ARGS', `字段不符；必填：${required.join('、')}。`); }
function text(value: unknown): void { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TaskError('INVALID_FINANCIAL_INPUT', '金融语义须明确提供非空有界文本。'); }
function day(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new TaskError('INVALID_FINANCIAL_INPUT', '业务日期须为有效 YYYY-MM-DD。'); return value; }
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59 || !Number.isFinite(Date.parse(value))) throw new TaskError('FINANCIAL_TIME_UNAVAILABLE', '可得时间须为含明确时区的有效时刻。');
  day(value.slice(0, 10)); return Date.parse(value);
}
function zonedDay(timestamp: number, timezone: string): string { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp); return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-'); }
function json(value: unknown): JsonValue {
  // 此模块的记录对象是声明过的有限 JSON；去除仅用于内部证据投影的 undefined 字段。
  return JSON.parse(canonical(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) : value)) as JsonValue;
}

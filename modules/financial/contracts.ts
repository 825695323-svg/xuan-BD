import Schema from 'typebox/schema';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { TaskRecord, JsonValue } from '../../contracts/task-contracts.js';
import { canonical, financialDigest } from '../../plugins/financial/local-compute/assets.js';
import { FINANCIAL_CAPABILITIES, FINANCIAL_CONTRACT_VERSION, FINANCIAL_MACD_FIELDS, FINANCIAL_MACD_LIMITATIONS, FINANCIAL_MACD_PARAMETERS, FINANCIAL_PLUGIN_VERSION, FINANCIAL_RUNTIME,
  type FinancialCallArgs, type FinancialComputedCandidate, type FinancialData, type FinancialInput,
  type FinancialSnapshotInput, type FinancialToolDescription } from './types.js';

export const FINANCIAL_PUBLIC_PROTOCOL = '0.1';
export const FINANCIAL_PUBLIC_PROFILE = 'financial-first-cycle/1';
const id = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const version = { type: 'string', minLength: 1, maxLength: 256 };
const tool = object({ tool_id: { enum: [...FINANCIAL_CAPABILITIES] }, plugin_version: { const: FINANCIAL_PLUGIN_VERSION },
  contract_version: { const: FINANCIAL_CONTRACT_VERSION }, method_version: version,
  implementation_version: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } });

/** 本协议只声明已实现的首包；更广的草案字段不被静默忽略。 */
export const FINANCIAL_PUBLIC_CALL_SCHEMA = object({
  protocol_version: { const: FINANCIAL_PUBLIC_PROTOCOL }, request_id: id, idempotency_key: id, tool,
  inputs: object({ bars: { oneOf: [
    object({ kind: { const: 'inline' }, schema_ref: { const: FINANCIAL_CONTRACT_VERSION }, value: { type: 'object' } }),
    object({ kind: { const: 'dataset_ref' }, schema_ref: { const: FINANCIAL_CONTRACT_VERSION }, dataset_id: id, snapshot_id: id,
      selection: object({ outputIdentity: { type: 'object' }, referenceDependencies: { type: 'array', maxItems: 32 },
        fields: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'string' } },
        range: { type: 'object' }, useMode: { const: 'analysis' } }) }),
  ] } }),
  parameters: { type: 'object' }, temporal: object({ mode: { const: 'retrospective' } }),
  controls: object({ execution_mode: { const: 'async' }, allow_partial: { const: false },
    persistence: { const: 'result_only' }, budget_profile: { const: FINANCIAL_PUBLIC_PROFILE } }),
  required_extensions: { type: 'array', maxItems: 0 }, extensions: object({}),
});
const callValidator = Schema.Compile(FINANCIAL_PUBLIC_CALL_SCHEMA as never);

export type FinancialPublicInput =
  | { kind: 'inline'; schema_ref: typeof FINANCIAL_CONTRACT_VERSION; value: FinancialData }
  | { kind: 'dataset_ref'; schema_ref: typeof FINANCIAL_CONTRACT_VERSION; dataset_id: string; snapshot_id: string;
      selection: Omit<FinancialSnapshotInput, 'kind' | 'productId' | 'snapshotId'> };
export interface FinancialPublicCall {
  protocol_version: '0.1'; request_id: string; idempotency_key: string;
  tool: { tool_id: FinancialCallArgs['capabilityId']; plugin_version: string; contract_version: string; method_version: string; implementation_version: string };
  inputs: { bars: FinancialPublicInput }; parameters: FinancialCallArgs['parameters'];
  temporal: { mode: 'retrospective' };
  controls: { execution_mode: 'async'; allow_partial: false; persistence: 'result_only'; budget_profile: 'financial-first-cycle/1' };
  required_extensions: []; extensions: Record<string, never>;
}
type FinancialBoundary = { validate(operation: string, args: unknown): Record<string, JsonValue> };

export function validateFinancialPublicCall(value: unknown, financial: FinancialBoundary): {
  request: FinancialPublicCall; requestId: string; args: FinancialCallArgs;
} {
  if (!callValidator.Check(value)) throw new TaskError('FINANCIAL_PUBLIC_CONTRACT_MISMATCH', '请求不符合金融首包公共合同；不支持的模式或扩展须明确适配。');
  const request = JSON.parse(canonical(value)) as FinancialPublicCall;
  // 复用现有持久请求身份；首包不伪称另有跨请求别名账本。
  if (request.request_id !== request.idempotency_key) throw new TaskError('FINANCIAL_PUBLIC_IDEMPOTENCY_UNSUPPORTED', '首包的 request_id 与 idempotency_key 必须相同。');
  const bars = request.inputs.bars;
  const input: FinancialInput = bars.kind === 'inline'
    ? { kind: 'direct', inputId: request.request_id, data: bars.value }
    : { kind: 'snapshot', productId: bars.dataset_id, snapshotId: bars.snapshot_id, ...bars.selection };
  const args = financial.validate('tools.call', { capabilityId: request.tool.tool_id, pluginVersion: request.tool.plugin_version,
    methodVersion: request.tool.method_version, implementationVersion: request.tool.implementation_version, input, parameters: request.parameters }) as unknown as FinancialCallArgs;
  return { request, requestId: request.request_id, args };
}

export function describeFinancialPublicContract(description: FinancialToolDescription): JsonValue {
  if (!(FINANCIAL_CAPABILITIES as readonly string[]).includes(description.capabilityId)) throw new TaskError('FINANCIAL_TOOL_NOT_FOUND', '此金融能力未登记。');
  return JSON.parse(canonical({ protocol_version: FINANCIAL_PUBLIC_PROTOCOL, profile: FINANCIAL_PUBLIC_PROFILE,
    tool: { tool_id: description.capabilityId, plugin_version: description.pluginVersion, contract_version: description.contractVersion,
      method_version: description.methodVersion, implementation_version: description.implementationVersion },
    input_schema: FINANCIAL_PUBLIC_CALL_SCHEMA, result_schema: FINANCIAL_PUBLIC_RESULT_SCHEMA, error_schema: FINANCIAL_PUBLIC_ERROR_SCHEMA,
    parameters_schema: description.parameters,
    input_contract: description.inputContract, output_contract: description.outputContract, method_evidence: description.methodEvidence,
    execution_constraints: description.executionConstraints, enabled: description.enabled,
    supported: { inputs: ['inline', 'dataset_ref'], modes: ['async'], temporal: ['retrospective'], persistence: ['result_only'],
      idempotency: 'request_id_equals_idempotency_key', results: 'existing_task_result_reference',
      publication: description.capabilityId === FINANCIAL_CAPABILITIES[2] ? 'unsupported_without_registered_target' : 'separate_authorized_action', strict_historical_visibility: false },
  })) as JsonValue;
}

/** 只将核心中已成功封存并按各自数值合同核对的结果暴露给调用方。 */
export function requireFinancialComputedResult(task: TaskRecord): FinancialComputedCandidate {
  if (task.runtimeId !== FINANCIAL_RUNTIME || task.ownerRole !== 'service' || task.action !== 'tools.call'
    || task.status !== 'succeeded' || task.requiresReview || task.reviewRequired || !task.resultRef || !task.result?.data) {
    throw new TaskError('FINANCIAL_RESULT_UNAVAILABLE', '金融任务尚无可消费的已核结果。');
  }
  const candidate = task.result.data as unknown as FinancialComputedCandidate;
  const args = task.args as unknown as FinancialCallArgs;
  const ma = candidate.capabilityId === FINANCIAL_CAPABILITIES[0], macd = candidate.capabilityId === FINANCIAL_CAPABILITIES[2];
  const fields = macd ? [...FINANCIAL_MACD_FIELDS] : [ma ? 'MA' : 'bullish_engulfing'];
  if (candidate.status !== 'computed' || candidate.persistence !== 'not_requested' || candidate.taskId !== task.id
    || !(FINANCIAL_CAPABILITIES as readonly unknown[]).includes(candidate.capabilityId)
    || candidate.capabilityId !== args.capabilityId || candidate.pluginVersion !== FINANCIAL_PLUGIN_VERSION
    || candidate.pluginVersion !== args.pluginVersion || candidate.contractVersion !== FINANCIAL_CONTRACT_VERSION
    || candidate.methodVersion !== args.methodVersion || candidate.implementationVersion !== args.implementationVersion
    || !/^[0-9a-f]{64}$/.test(candidate.inputDigest) || candidate.externalActionExecuted !== false
    || !candidate.metadata || !Array.isArray(candidate.rows) || !candidate.rows.length || candidate.rows.length > 512
    || !Array.isArray(candidate.invalidIntervals) || !Array.isArray(candidate.limitations)
    || candidate.limitations.some(item => typeof item !== 'string') || !Array.isArray(candidate.diagnostics)
    || financialDigest(candidate.parameters) !== financialDigest(args.parameters)
    || financialDigest(candidate.inputReference) !== financialDigest(args.input.kind === 'direct'
      ? { kind: 'direct', inputId: args.input.inputId } : args.input)) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '已存金融结果与原任务、输入或版本不一致。');
  if (macd) {
    assertMacdToolResult(candidate.rawToolResult, candidate.parameters);
    const raw = financialRecord(candidate.rawToolResult);
    if (candidate.methodVersion !== 'macd/12-26-9-first-valid-v1' || financialDigest(candidate.method) !== financialDigest(raw.method)
      || financialDigest(candidate.diagnostics) !== financialDigest(raw.diagnostics) || financialDigest(candidate.metadata) !== financialDigest(raw.metadata)
      || financialDigest(candidate.rows.map(({ available_at: _available, ...row }) => row)) !== financialDigest(raw.rows)
      || FINANCIAL_MACD_LIMITATIONS.some(limitation => !candidate.limitations.includes(limitation))) {
      throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD结果与保管原结果、初始化限制或方法证据不一致。');
    }
    if (args.input.kind === 'direct') {
      const inputRows = args.input.data.rows;
      if (financialDigest(candidate.metadata) !== financialDigest(args.input.data.metadata) || inputRows.length !== candidate.rows.length
        || candidate.rows.some((row, index) => row.timestamp !== inputRows[index]?.timestamp
        || row.available_at !== inputRows[index]?.available_at)) throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD行身份与原直接输入不一致。');
    }
  }
  const leading = Math.min(candidate.rows.length, macd ? 0 : ma ? Number(financialRecord(args.parameters).period) - 1 : 1);
  if (!Number.isSafeInteger(leading) || leading < 0) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '已存金融结果缺少明确预热规则。');
  let previous = '';
  candidate.rows.forEach((row, index) => {
    if (!row || Object.keys(row).sort().join(',') !== ['timestamp', 'available_at', ...fields].sort().join(',')
      || !validDay(row.timestamp) || row.timestamp <= previous || !validInstant(row.available_at)
      || Date.parse(row.available_at) > Date.parse(candidate.metadata.as_of)
      || fields.some(field => index < leading ? row[field] !== null : ma || macd
        ? typeof row[field] !== 'number' || !Number.isFinite(row[field]) || ma && Number(row[field]) <= 0 : typeof row[field] !== 'boolean')) {
      throw new TaskError('FINANCIAL_OUTPUT_INVALID', '金融结果行、空值、布尔值或有效范围不符。');
    }
    previous = row.timestamp;
  });
  const valid = leading < candidate.rows.length ? { start: candidate.rows[leading]!.timestamp, end: candidate.rows.at(-1)!.timestamp } : null;
  const invalid = leading ? [{ start: candidate.rows[0]!.timestamp, end: candidate.rows[leading - 1]!.timestamp, reason: 'insufficient_history', count: leading }] : [];
  if (!validInstant(candidate.metadata.as_of) || candidate.metadata.window_start !== candidate.rows[0]!.timestamp
    || candidate.metadata.window_end !== candidate.rows.at(-1)!.timestamp
    || financialDigest(valid) !== financialDigest(candidate.validInterval) || financialDigest(invalid) !== financialDigest(candidate.invalidIntervals)) {
    throw new TaskError('FINANCIAL_OUTPUT_INVALID', '金融结果的元信息、预热和有效区间不一致。');
  }
  return JSON.parse(canonical(candidate)) as FinancialComputedCandidate;
}

/** 本轮MACD只核既有工具返回的完整四列及原生方法/递推证据，不另算一套指标。 */
export function assertMacdToolResult(value: JsonValue, parameters: JsonValue): void {
  const result = financialRecord(value), method = financialRecord(result.method), metadata = financialRecord(result.metadata);
  const expectedParameters = { short_period: 12, long_period: 26, signal_period: 9 };
  if (financialDigest(parameters) !== financialDigest(FINANCIAL_MACD_PARAMETERS) || result.ok !== true || result.version !== 1
    || result.kind !== 'indicator' || result.operation !== 'MACD' || result.execution_executed !== false
    || !Array.isArray(result.rows) || !result.rows.length || result.rows.length > 10 || !Array.isArray(result.diagnostics) || result.diagnostics.length
    || financialDigest(method.parameters) !== financialDigest(expectedParameters) || method.initialization !== 'first_valid'
    || method.window_policy !== 'complete supplied daily observations; no padding, sorting or adjustment'
    || method.recursive_missing_policy !== 'leading null delays seed; later null invalidates recurrence'
    || financialDigest(method.definitions) !== financialDigest({ DIFF: 'EMA(close,short)-EMA(close,long)', DEA: 'EMA(DIFF,signal)', MACD: '2*(DIFF-DEA)', ZERO: '0' })) {
    throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD原结果身份、固定参数、完整输出或首值初始化证据不符。');
  }
  let previous = '';
  for (const [index, item] of result.rows.entries()) {
    const row = financialRecord(item);
    if (Object.keys(row).sort().join(',') !== ['timestamp', ...FINANCIAL_MACD_FIELDS].sort().join(',')
      || !validDay(row.timestamp) || row.timestamp <= previous || FINANCIAL_MACD_FIELDS.some(field => typeof row[field] !== 'number' || !Number.isFinite(row[field]))
      || row.ZERO !== 0 || row.MACD !== 2 * (Number(row.DIFF) - Number(row.DEA))
      || index === 0 && FINANCIAL_MACD_FIELDS.some(field => row[field] !== 0)) throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD四列数值、首值或日期证据不符。');
    previous = row.timestamp;
  }
  const first = financialRecord(result.rows[0]), last = financialRecord(result.rows.at(-1)), state = financialRecord(result.state), stateValues = financialRecord(state.values);
  const stateMetadata = Object.fromEntries(['series_id', 'frequency', 'timezone', 'price_unit', 'adjustment', 'adjustment_basis'].map(key => [key, metadata[key]]));
  if (metadata.window_start !== first.timestamp || metadata.window_end !== last.timestamp
    || Date.parse(String(last.timestamp)) - Date.parse(String(first.timestamp)) > 9 * 86_400_000
    || state.operation !== 'MACD' || state.previous_timestamp !== last.timestamp || state.is_immediately_prior !== true
    || financialDigest(state.parameters) !== financialDigest(expectedParameters) || financialDigest(state.metadata) !== financialDigest(stateMetadata)
    || Object.keys(stateValues).sort().join(',') !== 'dea,ema_long,ema_short'
    || ['ema_short', 'ema_long'].some(field => typeof stateValues[field] !== 'number' || !Number.isFinite(stateValues[field]) || Number(stateValues[field]) <= 0)
    || typeof stateValues.dea !== 'number' || !Number.isFinite(stateValues.dea) || stateValues.dea !== last.DEA
    || Number(stateValues.ema_short) - Number(stateValues.ema_long) !== last.DIFF) {
    throw new TaskError('FINANCIAL_OUTPUT_INVALID', 'MACD窗口或原生递推结果证据不符；本适配不接受state续算。');
  }
}

function financialRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '金融结果证据必须是明确JSON对象。');
  return value as Record<string, unknown>;
}

export const FINANCIAL_PUBLIC_RESULT_SCHEMA = object({
  protocol_version: { const: FINANCIAL_PUBLIC_PROTOCOL }, request_id: id, job_id: id, result_id: id,
  status: { const: 'succeeded' }, tool, outputs: object({ values: object({ kind: { const: 'inline' },
    schema_ref: { const: FINANCIAL_CONTRACT_VERSION }, value: { type: 'array', minItems: 1, maxItems: 512 } }) }),
  input_manifest_ref: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, method_ref: version,
  temporal: object({ mode: { const: 'retrospective' }, historical_visibility: { const: 'unverified' } }),
  coverage: object({ supplied_rows: { type: 'integer', minimum: 1, maximum: 512 }, valid_rows: { type: 'integer', minimum: 0, maximum: 512 },
    valid_interval: { anyOf: [{ type: 'object' }, { type: 'null' }] }, invalid_intervals: { type: 'array' } }),
  quality: { type: 'array', items: { type: 'string' } }, evidence_ref: version,
  publication: object({ state: { const: 'not_requested' } }), external_action_executed: { const: false },
});
const resultValidator = Schema.Compile(FINANCIAL_PUBLIC_RESULT_SCHEMA as never);

export function financialPublicResult(task: TaskRecord, requestId: string): JsonValue {
  if (task.requestId !== `financial:tools.call:${requestId}`) throw new TaskError('FINANCIAL_PUBLIC_IDENTITY_MISMATCH', '公共结果必须归原持久请求，不能改写请求身份。');
  const candidate = requireFinancialComputedResult(task);
  const result = { protocol_version: FINANCIAL_PUBLIC_PROTOCOL, request_id: requestId, job_id: task.id, result_id: task.resultRef!,
    status: 'succeeded', tool: { tool_id: candidate.capabilityId, plugin_version: candidate.pluginVersion,
      contract_version: candidate.contractVersion, method_version: candidate.methodVersion, implementation_version: candidate.implementationVersion },
    outputs: { values: { kind: 'inline', schema_ref: FINANCIAL_CONTRACT_VERSION, value: candidate.rows } },
    input_manifest_ref: `sha256:${candidate.inputDigest}`, method_ref: candidate.methodVersion,
    temporal: { mode: 'retrospective', historical_visibility: 'unverified' },
    coverage: { supplied_rows: candidate.rows.length, valid_rows: candidate.rows.length - candidate.invalidIntervals.reduce((count, item) => count + item.count, 0),
      valid_interval: candidate.validInterval, invalid_intervals: candidate.invalidIntervals },
    quality: candidate.limitations, evidence_ref: `financial-evidence:${task.id}`,
    publication: { state: 'not_requested' }, external_action_executed: false };
  if (!resultValidator.Check(result)) throw new TaskError('FINANCIAL_OUTPUT_INVALID', '金融公共结果没有通过实际结构校验。');
  return JSON.parse(canonical(result)) as JsonValue;
}

export const FINANCIAL_PUBLIC_ERROR_SCHEMA = object({ code: version,
  category: { enum: ['protocol', 'input', 'authorization', 'dependency', 'resource', 'execution', 'output', 'state'] },
  stage: { enum: ['discover', 'plan', 'prepare', 'execute', 'validate', 'publish', 'read'] }, message: version,
  retryable: { type: 'boolean' }, affected_scope: object({ request_id: id, job_id: id }, ['request_id']), next_action: version });
const errorValidator = Schema.Compile(FINANCIAL_PUBLIC_ERROR_SCHEMA as never);
export function financialPublicError(error: unknown, context: { requestId: string; jobId?: string;
  stage: 'discover' | 'plan' | 'prepare' | 'execute' | 'validate' | 'publish' | 'read' }): JsonValue {
  const rawCode = error instanceof TaskError ? error.code : 'FINANCIAL_EXECUTION_FAILED';
  const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(rawCode) ? rawCode : 'FINANCIAL_EXECUTION_FAILED';
  const category = /PERMISSION|APPROVAL|AUTH/.test(code) ? 'authorization' : /BUDGET|RESOURCE|TOO_LARGE/.test(code) ? 'resource'
    : /OUTPUT|RESULT_INVALID/.test(code) ? 'output' : /PUBLIC|PROTOCOL|VERSION/.test(code) ? 'protocol'
    : /DEPENDENCY|UNBOUND|UNAVAILABLE/.test(code) ? 'dependency' : /INPUT|PARAMETER|UNIT|TIME|PRECISION|SEMANTIC/.test(code) ? 'input'
    : /STOP|CANCEL|CONFLICT|STATE|STALE/.test(code) ? 'state' : 'execution';
  // 公共错误不转发执行器原始诊断，避免其中的路径、秘密或私人正文外泄。
  const result = { code, category, stage: context.stage, message: '金融操作未满足当前合同或执行条件；请按原请求核对。', retryable: false,
    affected_scope: { request_id: context.requestId, ...(context.jobId ? { job_id: context.jobId } : {}) },
    next_action: category === 'input' || category === 'protocol' ? '修正明确的输入、模式或版本后建立新请求。' : '先查询原任务及本机证据，未核清前不重复派发。' };
  if (!errorValidator.Check(result)) throw new TaskError('FINANCIAL_PUBLIC_CONTRACT_MISMATCH', '公共错误关联身份无效。');
  return result as JsonValue;
}
function validDay(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function validInstant(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && validDay(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60
  && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value)); }

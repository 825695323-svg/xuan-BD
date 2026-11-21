import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant, isNumericReportedZero } from '../../contracts/financial-value.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { readHistorySelection } from '../collection/r1-product-reader.js';
import { readExactDecimal } from '../collection/numeric-precision.js';
import { actionRoles, pureMethodVersion, PURE_OPERATOR_VERSION, PURE_PUBLICATION, pureOperatorDefinition, type PureFieldRoles } from './algorithm-pure-operators.js';
import type { PureOperatorId } from './algorithm-types.js';
import { computeFinancialGrowth, computeFinancialRatios, computeFinancialSingleQuarter, computeFinancialTtm,
  financialBasisAxes, financialRatioFields, knownFinancialLabel, type FinancialGrowthOptions, type FinancialRatioSnapshot, type FinancialObservation } from './financial-l4-operators.js';
import { computeAdjustedMarketSeries, type MarketCorporateAction, type UnadjustedDailyBar } from './market-adjustment-contract.js';
import { fixedProductIdentifier, readCompleteFixedProduct, STRATEGY_SCREEN_READ_LIMITS,
  type FixedProductReader, type FixedProductRow, type HistoricalPurposeContext } from './strategy-screen-wfd.js';
import { historicalExclusionSummary } from './historical-exclusions.js';
import { verifyPureOperator, type PureOperatorInput } from './pure-operator-verification.js';

function fail(code: string, message: string): never { throw new TaskError(code, message); }
function object(value: unknown, allowed: readonly string[]): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(name => !allowed.includes(name)))
    fail('PURE_OPERATOR_INPUT', '纯算子请求含未登记字段，或缺少固定产品引用。');
  return value;
}
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const fieldName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(name);
const historyKeys = ['perspective', 'at', 'heldScope', 'usableStage'];
function reference(value: unknown, roles: PureFieldRoles, primary: boolean) {
  const ref = object(value, ['kind', 'instanceId', 'snapshotId', 'productId', 'definitionRevision', 'fieldMapping', 'fields',
    ...(primary ? historyKeys : [])]);
  if (!fixedProductIdentifier(ref.snapshotId) || !fixedProductIdentifier(ref.productId) || !fixedProductIdentifier(ref.definitionRevision)
    || ref.kind !== undefined && ref.kind !== 'wfd_fixed_snapshot' || ref.instanceId !== undefined && !fixedProductIdentifier(ref.instanceId))
    fail('PURE_OPERATOR_FIXED_REFERENCE', '需要明确的固定快照、产品和定义修订。');
  const names = [...roles.required, ...roles.optional];
  const mapping = object(ref.fieldMapping ?? {}, names);
  const projection = names.map(role => {
    const field = Object.hasOwn(mapping, role) ? mapping[role] : role;
    if (!fieldName(field)) fail('PURE_OPERATOR_FIELDS', '无效的 WFD 字段名。');
    return { role, field };
  });
  if (new Set(projection.map(item => item.field)).size !== projection.length)
    fail('PURE_OPERATOR_FIELDS', '字段角色与实际 WFD 字段须一一对应。');
  const fields = ref.fields === undefined ? projection.map(item => item.field) : ref.fields;
  if (!Array.isArray(fields) || !fields.length || !fields.every(fieldName) || new Set(fields).size !== fields.length
    || fields.some(field => !projection.some(p => p.field === field))
    || projection.some(p => (roles.required.includes(p.role) || Object.hasOwn(mapping, p.role)) && !fields.includes(p.field)))
    fail('PURE_OPERATOR_FIELDS', '固定投影须覆盖全部必需角色及显式映射。');
  return { snapshotId: ref.snapshotId, productId: ref.productId, definitionRevision: ref.definitionRevision, instanceId: ref.instanceId,
    projection: projection.filter(item => fields.includes(item.field)), fields: [...fields].sort() };
}

function requestFor(methodId: PureOperatorId, raw: WfdRecord) {
  object(raw, ['methodId', 'source', 'parameters', 'usage']);
  const spec = pureOperatorDefinition(methodId), price = methodId === 'price_adjustment';
  const source = object(raw.source, price ? ['kind', 'reference', 'actionReference'] : ['kind', 'reference']);
  if (source.kind !== 'fixed_snapshot') fail('ALGORITHM_WFD_ONLY', '只接受受信 WFD 固定产品。');
  const ref = reference(source.reference, spec.fields, true);
  const actions = price ? reference(source.actionReference, actionRoles, false) : null;
  if (actions && (ref.snapshotId !== actions.snapshotId || ref.productId === actions.productId))
    fail('PURE_OPERATOR_FIXED_REFERENCE', '价格与行动须为同一快照中的两个明确产品。');
  const primary = source.reference as WfdRecord;
  const history = readHistorySelection({ historyMode: primary.perspective, at: primary.at,
    heldScope: primary.heldScope, usableStage: primary.usableStage });
  const usage = raw.usage === undefined ? null : object(raw.usage, ['purpose', 'historyMode', 'cutoff']);
  if (history.mode === 'snapshot_contents' ? usage && (usage.purpose !== 'current_compute'
    || usage.cutoff != null || usage.historyMode != null && usage.historyMode !== history.mode)
    : usage?.purpose !== 'historical_compute' || usage.historyMode !== history.mode || usage.cutoff !== primary.at)
    fail('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '用户声明、固定读取视角与截止必须一致。');
  const schema = spec.parameterSchema, parameters = object(raw.parameters === undefined ? {} : raw.parameters, Object.keys(schema.properties));
  if (schema.required.some(key => !Object.hasOwn(parameters, key)) || Object.entries(parameters).some(([key, v]) => {
    const rule = schema.properties[key]!;
    return typeof v !== rule.type || rule.enum && !rule.enum.includes(String(v)) || rule.format === 'date'
      && (typeof v !== 'string' || v.length !== 10 || !isExplicitUtcInstant(v + 'T00:00:00Z'));
  })) fail('PURE_OPERATOR_PARAMETERS', '参数与已登记的算子规格不符。');
  return { ref, actions, parameters, history: { historyMode: history.mode,
    ...(history.cutoff ? { at: history.cutoff.earliest_utc } : {}),
    ...(history.heldScope && history.usableStage ? { heldScope: history.heldScope, usableStage: history.usableStage } : {}) } };
}

type ProductReference = ReturnType<typeof reference>;
type ProjectedRow = { values: WfdRecord; units: Record<string, string> };
const numericRoles = new Set<string>(['value', ...financialRatioFields, 'open', 'high', 'low', 'close', 'cashPerShare', 'sharesPerShare', 'splitRatio']);
const nullableRoles = new Set<string>(['value', ...financialRatioFields, 'cashPerShare', 'sharesPerShare', 'splitRatio']);
function project(row: FixedProductRow, ref: ProductReference, metadata: Map<string, string>): ProjectedRow {
  const values: WfdRecord = {}, units: Record<string, string> = {};
  for (const { role, field } of ref.projection) {
    const cell = row.values[field];
    if (!isWfdRecord(cell) || !isWfdRecord(cell.unit) || !knownFinancialLabel(cell.unit.unit_code) || cell.unit.resolved === false)
      fail('PURE_OPERATOR_CELL', '固定字段缺少明确的值态或单位 ' + role);
    const signature = canonicalWfdJson({ type: cell.data_type, unit: cell.unit });
    const unitKey = 'unit:' + cell.unit.unit_code, unitDefinition = canonicalWfdJson(cell.unit);
    if (metadata.has(role) && metadata.get(role) !== signature || metadata.has(unitKey) && metadata.get(unitKey) !== unitDefinition)
      fail('FINANCIAL_BASIS_MISMATCH', '字段类型或同名单位定义不一致 ' + role);
    metadata.set(role, signature); metadata.set(unitKey, unitDefinition);
    units[role] = cell.unit.unit_code;
    if (numericRoles.has(role) ? !['decimal', 'integer'].includes(String(cell.data_type))
      : cell.data_type !== (role === 'additive' ? 'boolean' : role === 'fiscalYear' ? 'integer' : 'text'))
      fail('PURE_OPERATOR_CELL', '固定字段的数据类型与角色不符 ' + role);
    if (cell.value_state !== 'valid_value' && !(cell.value_state === 'reported_zero' && isNumericReportedZero(cell.data_type, cell.value))) {
      if (nullableRoles.has(role) && ['unknown', 'not_reported', 'not_collected', 'out_of_coverage', 'not_applicable', 'missing_unknown'].includes(String(cell.value_state)) && cell.value === null) {
        values[role] = null; continue;
      }
      fail('PURE_OPERATOR_CELL', '输入缺失或值态与原值不符 ' + role);
    }
    if (numericRoles.has(role)) {
      const amount = readExactDecimal(cell.value, role);
      if (cell.data_type === 'integer' && amount.d !== 1n) fail('PURE_OPERATOR_CELL', '整数字段包含小数 ' + role);
      values[role] = cell.value;
    } else if (role === 'fiscalYear') {
      if ((typeof cell.value !== 'string' && typeof cell.value !== 'number') || !/^\d{1,4}$/u.test(String(cell.value))) fail('FINANCIAL_PERIOD', '财年须为明确整数。');
      values[role] = Number(cell.value);
    } else if (role === 'additive') {
      if (typeof cell.value !== 'boolean') fail('FINANCIAL_NON_ADDITIVE', '可加性须由固定字段明确声明。');
      values[role] = cell.value;
    } else {
      if (!knownFinancialLabel(cell.value)) fail('FINANCIAL_BASIS_REQUIRED', '缺少明确口径 ' + role);
      values[role] = cell.value;
    }
  }
  if (isWfdRecord(row.subject) && typeof row.subject.id === 'string' && row.subject.id !== values.subject)
    fail('FINANCIAL_BASIS_MISMATCH', '行主体与输入主体字段不符。');
  return { values, units };
}

async function readInput(ref: ProductReference, history: ReturnType<typeof requestFor>['history'], read: FixedProductReader,
  wait: AbortSignal, active: () => void, connectionId: string, purpose?: HistoricalPurposeContext) {
  const records: FixedProductRow[] = [], rows: ProjectedRow[] = [], metadata = new Map<string, string>();
  const readPage: FixedProductReader = async (query, signal) => {
    try { return await read(query, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (history.historyMode === 'snapshot_contents') throw error;
      // 端口异常可能包含原始行身份或历史诊断。历史错误只对模型暴露受控错误码及说明。
      fail('PURE_OPERATOR_HISTORICAL_READ_FAILED', '受信端口未完成所请求的历史读取。');
    }
  };
  const proof = await readCompleteFixedProduct({ snapshotId: ref.snapshotId, productId: ref.productId, fields: ref.fields, pageSize: 100, ...history },
    readPage, wait, active, purpose, row => {
      // 复制每页的受信行，调用方复用对象或翻页时不能改变已取得的证据。
      const fixed = structuredClone(row);
      rows.push(project(fixed, ref, metadata)); records.push(fixed); return true;
    }, ref.definitionRevision);
  if (proof.connection?.connectionId !== connectionId || ref.instanceId !== undefined && ref.instanceId !== proof.connection.connectionId)
    fail('PURE_OPERATOR_FIXED_REFERENCE', '指定实例与实际固定读取连接不符。');
  const { historicalExclusions, ...identity } = proof;
  return { records, rows, proof: { ...identity, snapshotId: ref.snapshotId, productId: ref.productId,
    definitionRevision: ref.definitionRevision, ...history, fields: ref.fields,
    historicalExclusionSummary: historicalExclusionSummary(historicalExclusions.diagnostics) } };
}

function inputFor(methodId: PureOperatorId, rows: ProjectedRow[], actions: ProjectedRow[], params: WfdRecord): PureOperatorInput {
  if (!rows.length) fail('PURE_OPERATOR_MISSING_INPUT', '固定产品在所选视角没有合格输入。');
  const first = rows[0].values;
  if (methodId === 'price_adjustment') {
    const unit = rows[0].units.close;
    for (const { values, units } of rows) {
      if (values.adjustment !== 'none' || values.frequency !== '1d')
        fail('MARKET_ADJUSTMENT_RAW_DAILY_REQUIRED', '固定产品须逐行声明未复权日线。');
      if (values.subject !== first.subject || values.currency !== first.currency
        || ['open', 'high', 'low', 'close'].some(key => units[key] !== unit))
        fail('MARKET_ADJUSTMENT_BASIS', '原价的主体、币种或 OHLC 单位不一致。');
    }
    for (const { values, units } of actions) {
      if (values.subject !== first.subject || values.currency !== first.currency
        || values.kind === 'cash_dividend' && units.cashPerShare !== unit
        || (values.kind === 'stock_dividend' || values.kind === 'capitalization') && !['ratio', 'shares_per_share'].includes(units.sharesPerShare)
        || values.kind === 'split' && !['ratio', 'shares_per_share'].includes(units.splitRatio))
        fail('MARKET_ADJUSTMENT_BASIS', '行动主体、币种或每股现金单位与原价不符。');
      if (values.claimStatus !== 'confirmed' || values.effectiveStatus !== 'effective')
        fail('MARKET_ADJUSTMENT_ACTION_NOT_EFFECTIVE', '公司行动须已确认且生效。');
    }
    const bars = rows.map(({ values: { date, open, high, low, close } }) => ({ date, open, high, low, close })) as UnadjustedDailyBar[];
    return { methodId, market: { adjustment: 'none', frequency: '1d', direction: params.direction as 'forward_qfq' | 'backward_hfq',
      anchorDate: params.anchorDate as string, bars, actions: actions.map(row => row.values) as MarketCorporateAction[] } };
  }
  for (const { values, units } of rows) {
    for (const axis of [...financialBasisAxes, 'fiscalCalendar'] as const)
      if (!knownFinancialLabel(values[axis]) || values[axis] !== first[axis]) fail('FINANCIAL_BASIS_MISMATCH', '固定财务口径不一致 ' + axis);
    for (const field of Object.keys(units).filter(key => numericRoles.has(key))) {
      if (field === 'periodDays' ? !['day', 'days'].includes(units[field]) : units[field] !== values.unit)
        fail('FINANCIAL_BASIS_MISMATCH', '金额或天数字段的 WFD 单位与口径不符 ' + field);
    }
  }
  if (methodId === 'financial_ratios') {
    if (rows.length !== 1 || !financialRatioFields.some(key => Object.hasOwn(first, key)))
      fail('PURE_OPERATOR_MISSING_INPUT', '比率需要一行同期间快照与明确的数值投影。');
    return { methodId, snapshot: first as unknown as FinancialRatioSnapshot };
  }
  const observations = rows.map(row => row.values as unknown as FinancialObservation);
  if (methodId === 'financial_growth') {
    if (observations.length !== 2) fail('FINANCIAL_PERIOD', '增长计算需要两个明确的可比期间。');
    const [current, prior] = observations.sort((a, b) => b.fiscalYear - a.fiscalYear || b.period.localeCompare(a.period));
    return { methodId, current, prior, options: params as unknown as FinancialGrowthOptions };
  }
  return { methodId, observations };
}

function compute(input: PureOperatorInput) {
  switch (input.methodId) {
    case 'financial_single_quarter': return computeFinancialSingleQuarter(input.observations);
    case 'financial_ttm': return computeFinancialTtm(input.observations);
    case 'financial_growth': return computeFinancialGrowth(input.current, input.prior, input.options);
    case 'financial_ratios': return computeFinancialRatios(input.snapshot);
    case 'price_adjustment': return computeAdjustedMarketSeries(input.market);
  }
}

// 模型只读合格数值、算子自己的空值诊断和固定读取摘要。逐行版本与 WFD 原始证据留在密封输入。
function publicValues(result: ReturnType<typeof compute>) {
  if (Array.isArray(result)) return { rows: result.map(({ fiscalYear, period, value }) => ({ fiscalYear, period, value })) };
  if ('rows' in result) return { rows: result.rows, direction: result.lineage.direction, anchorDate: result.lineage.anchorDate,
    steps: result.lineage.appliedActions.map(({ effectiveDate, stepFactor }) => ({ effectiveDate, stepFactor })) };
  return 'values' in result ? { values: result.values, diagnostics: result.diagnostics }
    : { value: result.value, diagnostics: result.diagnostics,
      ...('method' in result.lineage ? { method: result.lineage.method } : { comparison: result.lineage.comparison, mode: result.lineage.mode }) };
}

export class PureOperatorRunner {
  constructor(private readonly database: CoreDatabase) {
    database.migrate('pure_operator_runs', 1, `CREATE TABLE pure_operator_runs(task_id TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL, sealed_input TEXT NOT NULL, result_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL, receipt_sha256 TEXT NOT NULL);`);
  }
  status(taskId: string, requestDigest?: string): JsonValue | null {
    const row = this.database.connection.prepare('SELECT request_sha256,receipt_json,receipt_sha256 FROM pure_operator_runs WHERE task_id=?').get(taskId);
    if (!row) return null;
    if (requestDigest && row.request_sha256 !== requestDigest) fail('PURE_OPERATOR_TASK_CONFLICT', '原任务与本次固定请求或版本不符。');
    const stored = String(row.receipt_json);
    if (wfdSha256(stored) !== row.receipt_sha256) fail('PURE_OPERATOR_RECEIPT_INVALID', '本地回执摘要不符。');
    return JSON.parse(stored) as JsonValue;
  }
  async run(methodId: PureOperatorId, calculation: WfdRecord, host: {
    taskId: string; connectionId: string; versions: WfdRecord; rulesVersion: number; read: FixedProductReader; signal: AbortSignal; assertCurrent(): void;
    link(): void; purpose?: HistoricalPurposeContext;
  }) {
    const request = requestFor(methodId, calculation);
    const requestSha = digest({ calculation, taskId: host.taskId, rulesVersion: host.rulesVersion, versions: host.versions, purpose: host.purpose ?? null });
    const wait = AbortSignal.any([host.signal, AbortSignal.timeout(STRATEGY_SCREEN_READ_LIMITS.timeoutMs)]);
    const active = () => { wait.throwIfAborted(); host.assertCurrent(); };
    active();
    const existing = this.status(host.taskId, requestSha);
    if (existing) { host.link(); return existing; }
    const primary = await readInput(request.ref, request.history, host.read, wait, active, host.connectionId, host.purpose);
    const actions = request.actions ? await readInput(request.actions, request.history, host.read, wait, active, host.connectionId, host.purpose) : null;
    if (actions && (canonicalWfdJson(primary.proof.connection) !== canonicalWfdJson(actions.proof.connection)
      || primary.proof.connectionSha256 !== actions.proof.connectionSha256)) fail('PURE_OPERATOR_FIXED_REFERENCE', '两个固定产品的实际连接不一致。');
    active();
    const fixedReads = [primary.proof, ...(actions ? [actions.proof] : [])];
    const input = inputFor(methodId, primary.rows, actions?.rows ?? [], request.parameters);
    const sealed = canonicalWfdJson({ calculation, purpose: host.purpose ?? null, input, fixedReads,
      records: primary.records, ...(actions ? { actionRecords: actions.records } : {}) });
    // 主计算用独立副本，核验从密封 JSON 重新打开原输入。
    const result = compute(structuredClone(input));
    const verification = verifyPureOperator((JSON.parse(sealed) as { input: PureOperatorInput }).input, result);
    const receipt = { taskId: host.taskId, methodId, status: 'succeeded', readOnly: true, persistence: 'local_sqlite', executor: 'typescript', computedAt: new Date().toISOString(),
      versionBinding: { rulesVersion: host.rulesVersion, methodVersion: pureMethodVersion(methodId), implementationVersion: PURE_OPERATOR_VERSION,
        verificationVersion: verification.version, taskVersions: host.versions },
      parameters: request.parameters, inputDigest: wfdSha256(sealed), verification, result: publicValues(result), publication: PURE_PUBLICATION,
      fixedReads: fixedReads.map(proof => ({ snapshotId: proof.snapshotId, productId: proof.productId, definitionRevision: proof.definitionRevision,
        queryHash: proof.queryHash, historyMode: proof.historyMode, at: proof.at ?? null, heldScope: proof.heldScope ?? null,
        usableStage: proof.usableStage ?? null, pages: proof.pages, rows: proof.scannedRows, complete: proof.complete,
        historicalExclusionSummary: proof.historicalExclusionSummary })) };
    const receiptJson = canonicalWfdJson(receipt);
    if (Buffer.byteLength(receiptJson) > STRATEGY_SCREEN_READ_LIMITS.resultBytes)
      fail('PURE_OPERATOR_RESULT_BUDGET', '完整计算回执超过会话结果预算，请选择更小的固定产品。');
    return this.database.transaction(() => {
      active(); host.link();
      const inserted = this.database.connection.prepare('INSERT INTO pure_operator_runs VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING')
        .run(host.taskId, requestSha, sealed, canonicalWfdJson(result), receiptJson, wfdSha256(receiptJson));
      const saved = this.status(host.taskId, requestSha);
      if (!isWfdRecord(saved) || !inserted.changes && saved.inputDigest !== receipt.inputDigest)
        fail('PURE_OPERATOR_TASK_CONFLICT', '并发重试的密封输入与原任务不一致。');
      return saved;
    });
  }
}

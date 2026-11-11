import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import type { TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { runDirectProcess } from '../../../platform/runtime/process.js';
import type { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { buildSourceObservationMA, type CalculatedMAProof, type SourceObservationMAContext, type SourceObservationMAInput } from '../source-observation-ma.js';
import { FINANCIAL_LINEAR_ADMISSION_VERSION, projectFinancialFixed, type FinancialCalculation, type FinancialReader } from './financial-fixed.js';
import { FIXED_CALCULATION_METHODS } from '../../../contracts/fixed-calculation-contracts.js';

export const POLARS_FIXED_VERSION = 'bd.polars-fixed/1';
export const POLARS_DEPENDENCY_VERSION = '2.0.0';
export const POLARS_FIXED_METHODS = FIXED_CALCULATION_METHODS;
const workerPath = fileURLToPath(new URL('./polars-worker.py', import.meta.url));
const workerDigest = wfdSha256(readFileSync(workerPath));
export interface PolarsExecution {
  /** Explicitly registered program, never caller-provided or discovered from PATH. */
  pythonExecutable: string; processRuntime: ProcessRuntime; context: TaskExecutionContext;
  assertAuthorized(): void;
}
export function polarsFixedVersionBinding(): Record<string, string> {
  return { polars: POLARS_FIXED_VERSION, polarsDependency: POLARS_DEPENDENCY_VERSION, polarsWorker: workerDigest,
    polarsFinancial: FINANCIAL_LINEAR_ADMISSION_VERSION };
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }

/** 固定日线入口声明完整快照重算；不能仅验证所选行存在而遗漏系列中的其他观测。 */
export function assertCompletePolarsDailySeries(proof: Pick<CalculatedMAProof, 'lineage'>, context: SourceObservationMAContext): void {
  const selected = new Map(proof.lineage.map(row => [row.businessKey, row.recordVersion]));
  const expected = Object.keys(context.versions);
  if (selected.size !== proof.lineage.length || selected.size !== expected.length
    || expected.some(key => selected.get(key) !== context.versions[key])) {
    fail('POLARS_SERIES_INCOMPLETE', '固定日线计算须选齐本次冻结系列的全部原报和当前记录版本；未跳过中间观测或截取预热窗口。');
  }
}

async function execute(execution: PolarsExecution, method: keyof typeof POLARS_FIXED_METHODS, rows: WfdRecord[], parameters: WfdRecord) {
  const context = execution.context;
  if (context.task.versions.polars !== POLARS_FIXED_VERSION || context.task.versions.polarsWorker !== workerDigest || context.task.versions.polarsDependency !== POLARS_DEPENDENCY_VERSION
    || wfdSha256(readFileSync(workerPath)) !== workerDigest) fail('POLARS_IMPLEMENTATION_CHANGED', '当前任务没有冻结本次Polars实现和依赖版本。');
  execution.assertAuthorized(); context.signal.throwIfAborted();
  const request = { version: POLARS_FIXED_VERSION, method, rows, parameters };
  const raw = canonicalWfdJson(request);
  if (!rows.length || rows.length > 5000 || Buffer.byteLength(raw) > 2_000_000) fail('POLARS_INPUT_BUDGET', '固定计算输入超过5000行/2MB；未截取前置窗口或静默改值。');
  const result = await runDirectProcess({ binary: 'polars-python', binaryPath: execution.pythonExecutable,
    runtime: execution.processRuntime, args: ['-I', '-B', workerPath], stdin: raw, cwd: '/', signal: context.signal,
    timeoutMs: 15_000, maxOutputBytes: 2_000_000, assertAuthorized: execution.assertAuthorized,
    onProcessState: event => context.emit({ type: 'process_state', ...event }),
    onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }) });
  execution.assertAuthorized(); context.signal.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { fail('POLARS_RESPONSE_INVALID', '执行器没有返回完整结构化候选。'); }
  if (isWfdRecord(value) && value.ok === false) fail('POLARS_' + String(value.code), 'Polars固定计算拒绝：' + String(value.message));
  if (!isWfdRecord(value) || value.version !== POLARS_FIXED_VERSION || value.executor !== 'polars'
    || value.polars_version !== POLARS_DEPENDENCY_VERSION || value.input_sha256 !== wfdSha256(raw)
    || value.method !== method || !Array.isArray(value.rows) || !isWfdRecord(value.resources)
    || value.publication !== 'candidate_only' || wfdSha256(readFileSync(workerPath)) !== workerDigest) {
    fail('POLARS_RESPONSE_INVALID', '实际执行器、锁定依赖、输入摘要或候选回执无法核对。');
  }
  await context.emit({ type: 'checkpoint', checkpoint: { executor: 'polars', method, inputSha256: wfdSha256(raw),
    resultSha256: wfdSha256(canonicalWfdJson(value)), workerSha256: workerDigest, publication: 'candidate_only' } });
  return value;
}

/** Existing source binding, ordering and missing/window rules remain authoritative. */
export async function projectDailyPolars(execution: PolarsExecution, valueColumn: string, inputs: SourceObservationMAInput[], context?: SourceObservationMAContext) {
  if (inputs.some(input => !!input.projection.minute)) fail('POLARS_DAILY_ONLY', '本适配仅登记日线观测MA20；分钟保持原实现。');
  const checked = buildSourceObservationMA({ method: 'source_observation_ma', period: 20, valueColumn }, inputs, context);
  if (context) assertCompletePolarsDailySeries(checked.proof, context);
  const receipt = await execute(execution, 'observation_ma20', checked.proof.lineage.map(row => ({
    key: row.businessKey, group: canonicalWfdJson(row.groupValues), value: row.inputValue,
  })), { period: 20, scale: 8, rounding: 'half_even' });
  const computed = receipt.rows as WfdRecord[], rows = JSON.parse(checked.bytes.toString()) as WfdRecord[];
  if (computed.length !== rows.length) fail('POLARS_RESULT_MISMATCH', 'Polars候选行数与完整固定输入不一致。');
  for (const [index, row] of rows.entries()) {
    const actual = computed[index]!, expected = checked.proof.lineage[index]!;
    if (actual.key !== expected.businessKey || actual.status !== expected.status || actual.value !== expected.value) {
      fail('POLARS_RESULT_MISMATCH', 'Polars结果与已有精确十进制/窗口判据不一致，候选未采用。');
    }
    row.value = actual.value;
  }
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { version: POLARS_FIXED_VERSION,
    method: 'observation_ma20', checkedInput: checked.proof, workerSha256: workerDigest, execution: receipt,
    temporalPolicy: 'inherits existing source snapshot/current-only restrictions; no historical availability claim',
    publication: 'candidate_only' } };
}

/** Financial semantics/formula validation is reused, rather than reimplemented for Polars. */
export async function projectFinancialPolars(execution: PolarsExecution, calculation: FinancialCalculation, reader: FinancialReader,
  verifyReview: (review: NonNullable<FinancialCalculation['compatibilityReview']>) => void) {
  if (execution.context.task.versions.polarsFinancial !== FINANCIAL_LINEAR_ADMISSION_VERSION) {
    fail('POLARS_FINANCIAL_VERSION_CHANGED', '原财务任务未冻结当前准入版本；不会用新口径执行旧排队任务，请沿原固定输入另建计算任务。');
  }
  if (calculation.operation === 'standardize') fail('POLARS_FINANCIAL_OPERATION', '固定映射沿用既有实现；本执行器只登记可加流量单季/TTM算术。');
  const reads = new Map<string, WfdRecord[]>();
  const checked = await projectFinancialFixed(calculation, async (input, signal) => {
    const response = await reader(input, signal);
    const key = canonicalWfdJson([input.snapshotId, input.productId]);
    const accumulated = reads.get(key) ?? [];
    if (Array.isArray(response.result.rows)) for (const row of response.result.rows.filter(isWfdRecord)) {
      const existing = accumulated.find(existing => canonicalWfdJson(existing.record_ref) === canonicalWfdJson(row.record_ref));
      if (existing && canonicalWfdJson(existing) !== canonicalWfdJson(row)) fail('POLARS_INPUT_BINDING', '同一固定财务记录版本返回了不同内容。');
      if (!existing) accumulated.push(row);
    }
    reads.set(key, accumulated);
    return response;
  }, execution.context.signal, verifyReview);
  const operands = calculation.inputs.map(input => {
    const rows = reads.get(canonicalWfdJson([input.snapshotId, input.productId])) ?? [];
    const wanted = rows.filter(row => isWfdRecord(row.record_ref) && input.businessKeys.includes(String(row.record_ref.logical_key)));
    if (wanted.length !== 1 || !isWfdRecord(wanted[0]!.values) || !isWfdRecord(wanted[0]!.values.value)) {
      return fail('POLARS_INPUT_BINDING', '财务Polars输入没有绑定已校验的唯一实际行。');
    }
    return String(wanted[0]!.values.value.value);
  });
  const signs = calculation.operation === 'quarter_difference' ? [1, -1] : [1, 1, -1];
  const receipt = await execute(execution, 'financial_linear', [{ values: operands }], { signs });
  const actual = (receipt.rows as WfdRecord[])[0], rows = JSON.parse(checked.jsonBytes.toString()) as WfdRecord[];
  if (!actual || rows.length !== 1 || rows[0]!.value !== actual.value || rows[0]!.value_state !== actual.state) {
    fail('POLARS_RESULT_MISMATCH', 'Polars财务精确结果与既有已核定公式不同。');
  }
  rows[0]!.value = actual.value;
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { ...checked.evidence,
    executor: 'polars', workerSha256: workerDigest, execution: receipt, publication: 'candidate_only' } };
}

export interface MacroYoYCalculation { version: 'bd.macro-yoy/1'; historyMode: 'snapshot_contents';
  knowledgeCutoff: string; inputs: Array<{ snapshotId: string; productId: string; businessKey: string; recordVersion: string }> }
export function readMacroYoYCalculation(value: unknown): MacroYoYCalculation {
  const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(v);
  if (!isWfdRecord(value) || Object.keys(value).sort().join(',') !== 'historyMode,inputs,knowledgeCutoff,version'
    || value.version !== 'bd.macro-yoy/1' || value.historyMode !== 'snapshot_contents' || !utc(value.knowledgeCutoff)
    || !Array.isArray(value.inputs) || value.inputs.length !== 2 || value.inputs.some(input => !isWfdRecord(input)
      || Object.keys(input).sort().join(',') !== 'businessKey,productId,recordVersion,snapshotId'
      || !Object.values(input).every(identifier) || /^(latest|current)$/iu.test(String(input.snapshotId)))) fail('POLARS_MACRO_CONTRACT', '宏观同比只接收本期/去年同期两条明确固定版本，不接受数值、路径、latest或历史资格覆盖。');
  return structuredClone(value) as unknown as MacroYoYCalculation;
}
export function macroYoYAlgorithmDefinition(): WfdRecord {
  return { definition_version: '1.0.0', result_semantics: '明确系列、地区、单位、季调、基期和去年同期的两条固定来源版本；只签发快照内候选，不签发历史可知资格。',
    mathematical_definition: '(current - previous) / previous * 100. Strictly positive previous denominator; nonpositive denominator is unknown. Exact decimal difference; final 8 decimal places, half-even.',
    window: { type: 'macro_period', count: 2, interval: 'closed', unit: 'explicit_same_calendar_period_previous_year' },
    constants: { percentage_factor: 100, output_scale: 8 } };
}
const macroFields = ['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period', 'period_start', 'period_end', 'published_at', 'release_id', 'value'];
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/u.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const utc = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value;

/** A minimal, explicitly fixed macro task. Release facts do not grant WFD PIT qualification. */
export async function projectMacroYoYPolars(execution: PolarsExecution, calculation: MacroYoYCalculation, reader: FinancialReader) {
  calculation = readMacroYoYCalculation(calculation);
  if (calculation.version !== 'bd.macro-yoy/1' || calculation.historyMode !== 'snapshot_contents' || calculation.inputs.length !== 2
    || !utc(calculation.knowledgeCutoff)) {
    fail('POLARS_MACRO_CONTRACT', '宏观同比须固定本期/去年同期两条实际版本与校验截止；本切片不签发历史可知资格。');
  }
  const selected: WfdRecord[] = [], evidence: WfdRecord[] = []; let connection: unknown; let governance: WfdRecord | null = null;
  for (const input of calculation.inputs) {
    if (/^(latest|current)$/iu.test(input.snapshotId)) fail('POLARS_INPUT_BINDING', '宏观输入必须固定快照。');
    let cursor: string | undefined, count = 0, found: WfdRecord | null = null;
    const cursors = new Set<string>();
    do {
      const response = await reader({ snapshotId: input.snapshotId, productId: input.productId, ...(cursor ? { cursor } : {}) }, execution.context.signal);
      if (connection !== undefined && canonicalWfdJson(connection) !== canonicalWfdJson(response.connection ?? null)) {
        fail('POLARS_INPUT_BINDING', '宏观固定输入读取期间受信连接身份变化。');
      }
      connection = response.connection ?? null;
      const page = response.result;
      if (isWfdRecord(page.usage_governance)) governance = page.usage_governance;
      if (page.snapshot_id !== input.snapshotId || page.product_id !== input.productId || !Array.isArray(page.rows) || !isWfdRecord(page.page)) {
        fail('POLARS_INPUT_BINDING', '宏观固定读取身份或分页不符。');
      }
      for (const row of page.rows) {
        if (++count > 5000) fail('POLARS_INPUT_BUDGET', '宏观固定输入超过5000行扫描预算。');
        if (isWfdRecord(row) && isWfdRecord(row.record_ref) && row.record_ref.logical_key === input.businessKey) {
          if (found || row.record_ref.revision_id !== input.recordVersion) fail('POLARS_INPUT_BINDING', '宏观输入缺唯一匹配记录版本。');
          found = row;
        }
      }
      cursor = page.page.has_more ? String(page.page.next_cursor) : undefined;
      if (cursor && (cursors.has(cursor) || cursor === 'undefined')) fail('POLARS_INPUT_BINDING', '宏观固定读取游标循环或缺失。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!found || !isWfdRecord(found.values)) fail('POLARS_INPUT_BINDING', '宏观固定产品缺所选实际行。');
    const values: WfdRecord = {};
    for (const field of macroFields) {
      const cell = found.values[field];
      if (!isWfdRecord(cell) || !['valid_value', 'reported_zero'].includes(String(cell.value_state)) || typeof cell.value !== 'string') {
        fail('POLARS_MACRO_UNKNOWN', `宏观字段${field}缺确定值，未填零或补版本。`);
      }
      values[field] = cell.value;
    }
    selected.push(values);
    evidence.push({ ...input, record: found.record_ref, selectedSha256: wfdSha256(canonicalWfdJson(found)), values });
  }
  const [current, previous] = selected as [WfdRecord, WfdRecord];
  if (selected.some(row => !date(row.period_start) || !date(row.period_end) || row.period_start > row.period_end)) {
    fail('POLARS_MACRO_PERIOD', '宏观期间须为实际有效且有序的公历日期。');
  }
  if (['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period'].some(field => current[field] !== previous[field])) {
    fail('POLARS_MACRO_INCOMPATIBLE', '宏观系列、地区、单位、基期或季调口径不相容。');
  }
  const previousYear = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/u.test(value)
    ? String(Number(value.slice(0, 4)) - 1).padStart(4, '0') + value.slice(4) : '';
  if (previousYear(current.period_start) !== previous.period_start || previousYear(current.period_end) !== previous.period_end) {
    fail('POLARS_MACRO_PERIOD', '同比只接受明确的去年同起止期间，不按相邻行充作同比。');
  }
  for (const row of selected) if (!utc(row.published_at)
    || row.published_at > calculation.knowledgeCutoff) fail('POLARS_MACRO_RELEASE_UNAVAILABLE', '选中的来源公布时间未知或晚于校验截止。');
  const receipt = await execute(execution, 'macro_yoy', [{ current: current.value, previous: previous.value }], { scale: 8, rounding: 'half_even', output_unit: 'percent' });
  const actual = (receipt.rows as WfdRecord[])[0]!;
  const rows = [{ ...current, business_key: 'macro_yoy_' + wfdSha256(canonicalWfdJson(evidence)),
    value: actual.value, value_state: actual.value === null ? 'unknown' : actual.state,
    calculation_status: actual.state, unit: 'percent', method: 'exact_yoy_percentage',
    start_utc: current.period_start + 'T00:00:00Z', end_utc: new Date(Date.parse(String(current.period_end) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) + 'T00:00:00Z' }];
  const outputEvidence: WfdRecord = { version: POLARS_FIXED_VERSION,
    method: 'macro_yoy', inputs: evidence, connection, knowledgeCutoff: calculation.knowledgeCutoff, historicalQualification: 'not_asserted',
    releaseSelection: 'explicit business-key and record-version; never latest',
    arithmetic: '(current-previous)/previous*100; exact decimal, final8 half-even; nonpositive denominator indeterminate',
    algorithmDefinition: macroYoYAlgorithmDefinition(), workerSha256: workerDigest, execution: receipt, publication: 'candidate_only' };
  // 产生候选时即独立重核一次；随后原 R1 准备/首次发送还会按原冻结证据再核。
  assertMacroYoYCandidate(calculation, outputEvidence, rows);
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: outputEvidence };
}


/**
 * 独立宏观同比核验。复用原 WFD 固定读取证据和 Polars 结果回执，不重跑计算执行器、
 * 不取 latest，也不把来源发布日期当成 WFD 历史可知资格。
 *
 * 这一检查可由统一派生发布器重放；不能用通过检查代替 R1 正式提交和固定读回。
 */
export function assertMacroYoYCandidate(raw: MacroYoYCalculation, evidence: WfdRecord, rows: WfdRecord[]): void {
  const calc = readMacroYoYCalculation(raw);
  const reject = (reason: string): never => { throw new TaskError('POLARS_MACRO_CANDIDATE_CHANGED', reason); };
  if (!isWfdRecord(evidence) || evidence.version !== POLARS_FIXED_VERSION || evidence.method !== 'macro_yoy'
    || evidence.workerSha256 !== workerDigest || evidence.historicalQualification !== 'not_asserted'
    || evidence.knowledgeCutoff !== calc.knowledgeCutoff || evidence.releaseSelection !== 'explicit business-key and record-version; never latest'
    || canonicalWfdJson(evidence.algorithmDefinition ?? null) !== canonicalWfdJson(macroYoYAlgorithmDefinition())
    || !Array.isArray(evidence.inputs) || evidence.inputs.length !== 2
    || !isWfdRecord(evidence.execution)) reject('原宏观计算方法、版本、固定行或算法定义缺失。');

  const frozenInputs = evidence.inputs as WfdRecord[];
  const fixedInputs: WfdRecord[] = [];
  for (const [index, requested] of calc.inputs.entries()) {
    const source = frozenInputs[index];
    if (!isWfdRecord(source) || !isWfdRecord(source.record) || !isWfdRecord(source.values)
      || source.snapshotId !== requested.snapshotId || source.productId !== requested.productId
      || source.businessKey !== requested.businessKey || source.recordVersion !== requested.recordVersion
      || source.record.logical_key !== requested.businessKey || source.record.revision_id !== requested.recordVersion
      || typeof source.selectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.selectedSha256)
      || source.record.product_id !== undefined && source.record.product_id !== requested.productId
      || source.record.snapshot_id !== undefined && source.record.snapshot_id !== requested.snapshotId) {
      reject('冻结来源产品、快照、记录版本或原行摘要与请求不符。');
    }
    const selectedValues = source.values as WfdRecord;
    for (const field of macroFields) {
      const value = selectedValues[field];
      if (typeof value !== 'string' || !value || value.length > 256) reject('宏观原行缺失必要且有界的固定字段。');
    }
    if (!date(selectedValues.period_start) || !date(selectedValues.period_end)
      || String(selectedValues.period_start) > String(selectedValues.period_end)
      || !utc(selectedValues.published_at) || String(selectedValues.published_at) > calc.knowledgeCutoff) {
      reject('来源期间或实际公布时刻无法在本次校验截止内核实。');
    }
    fixedInputs.push(selectedValues);
  }
  const [current, previous] = fixedInputs as [WfdRecord, WfdRecord];
  if (['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period'].some(key => current[key] !== previous[key])) {
    reject('固定来源系列、地区、单位、基期或季调口径发生变化。');
  }
  const yearBefore = (value: string) => String(Number(value.slice(0, 4)) - 1).padStart(4, '0') + value.slice(4);
  if (yearBefore(String(current.period_start)) !== previous.period_start
    || yearBefore(String(current.period_end)) !== previous.period_end) {
    reject('宏观同比期间并非去年同一自然起止区间。');
  }

  // 与 Polars Decimal(38,18) 实现独立的 BigInt 有理数核对；最后一步八位 half-even。
  const decimalParts = (value: unknown): { coefficient: bigint; scale: number } => {
    if (typeof value !== 'string' || value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
      return reject('宏观同比输入不是精确十进制词面。');
    }
    const [whole, fractional = ''] = value.split('.');
    if (fractional.length > 18 || whole!.replace('-', '').length > 20
      || whole!.replace('-', '').length + fractional.length > 38) reject('宏观十进制超出 Polars 计算预算。');
    return { coefficient: BigInt(whole! + fractional), scale: fractional.length };
  };
  const a = decimalParts(current.value), b = decimalParts(previous.value), scale = Math.max(a.scale, b.scale);
  const currentInt = a.coefficient * 10n ** BigInt(scale - a.scale), previousInt = b.coefficient * 10n ** BigInt(scale - b.scale);
  const abs = (value: bigint) => value < 0n ? -value : value;
  if (abs(currentInt) + abs(previousInt) >= 10n ** BigInt(20 + scale)) reject('宏观求和超出既有精度预算。');
  let expectedValue: string | null, state: string;
  if (previousInt <= 0n) {
    expectedValue = null;
    state = previousInt === 0n ? 'undefined_zero_denominator' : 'unsupported_negative_base';
  } else {
    const numerator = (currentInt - previousInt) * 100n * 100_000_000n;
    const magnitude = abs(numerator), q = magnitude / previousInt, rem = magnitude % previousInt;
    const increment = rem * 2n > previousInt || rem * 2n === previousInt && q % 2n !== 0n ? 1n : 0n;
    const rounded = q + increment;
    const digits = rounded.toString().padStart(9, '0');
    expectedValue = (numerator < 0n && rounded !== 0n ? '-' : '')
      + digits.slice(0, -8) + '.' + digits.slice(-8);
    state = 'valid_value';
  }
  const expectedRow: WfdRecord = {
    ...current,
    business_key: 'macro_yoy_' + wfdSha256(canonicalWfdJson(frozenInputs)),
    value: expectedValue, value_state: expectedValue === null ? 'unknown' : state,
    calculation_status: state, unit: 'percent', method: 'exact_yoy_percentage',
    start_utc: String(current.period_start) + 'T00:00:00Z',
    end_utc: new Date(Date.parse(String(current.period_end) + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z',
  };
  if (rows.length !== 1 || canonicalWfdJson(rows[0]) !== canonicalWfdJson(expectedRow)) {
    reject('候选业务键、期间、单位或精确同比结果与冻结来源独立计算不一致。');
  }
  const execution = evidence.execution as WfdRecord;
  const request = { version: POLARS_FIXED_VERSION, method: 'macro_yoy',
    rows: [{ current: current.value, previous: previous.value }],
    parameters: { scale: 8, rounding: 'half_even', output_unit: 'percent' } };
  const values = Array.isArray(execution.rows) ? execution.rows : [];
  if (execution.version !== POLARS_FIXED_VERSION || execution.executor !== 'polars'
    || execution.polars_version !== POLARS_DEPENDENCY_VERSION || execution.method !== 'macro_yoy'
    || execution.publication !== 'candidate_only' || execution.input_sha256 !== wfdSha256(canonicalWfdJson(request))
    || values.length !== 1 || !isWfdRecord(values[0])
    || values[0].value !== expectedValue || values[0].state !== state) {
    reject('冻结 Polars 进程回执、输入摘要或返回值与独立计算不一致。');
  }
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { createWfdTablePackage } from '../../adapters/database/wfd-table.js';

export const STEP_NAMES = ['parse', 'clean', 'annotate', 'check', 'structure'] as const;
export type StepName = typeof STEP_NAMES[number];
export type CollectionScope = { symbols: string[]; tradeDates: string[] };
export type RuntimeEnvironment = { nodeVersion: string; platform: string; arch: string; dependenciesSha256: string };
export type StepBinding = {
  stepId: string; implementationVersion: string; implementationSha256: string; ruleVersion: string; methodVersion: string; parameters: JsonValue;
};
export type CollectionPlan = {
  environment: 'synthetic-test'; runtime: RuntimeEnvironment; scope: CollectionScope;
  units: { price: 'CNY'; volume: 'shares' };
  referenceVersions: { dictionary: string; dates: string }; referenceSha256: string; steps: StepBinding[];
};
export type SourceInput = { sha256: string; byteLength: number; mediaType: 'text/csv' };
export type RawArtifact = { kind: 'raw'; parts: (SourceInput & { bytesBase64: string })[] };
export type DailyTextRow = {
  symbol: string; date: string; open: string; high: string; low: string; close: string; volume: string;
  sourcePart: number; sourceLine: number;
};
type RowsArtifact<K extends string, R> = { kind: K; sourceInputs: SourceInput[]; rows: R[] };
export type ParsedArtifact = RowsArtifact<'parsed', DailyTextRow>;
export type CleanedArtifact = RowsArtifact<'cleaned', DailyTextRow>;
export type Annotation = {
  environment: 'synthetic-test'; historicalPublic: 'unknown'; referenceVersions: CollectionPlan['referenceVersions'];
  referenceSha256: string; dateRange: { start: string; end: string };
};
export type AnnotatedRow = DailyTextRow & { instrument_id: number; trade_date: number };
export type AnnotatedArtifact = RowsArtifact<'annotated', AnnotatedRow> & { annotation: Annotation };
export type NumericDailyRow = { instrument_id: number; trade_date: number; open: number; high: number; low: number; close: number; volume: number };
export type Coverage = { expectedRows: number; actualRows: number; complete: true; empty: boolean };
export type CheckedArtifact = RowsArtifact<'checked', NumericDailyRow> & { annotation: Annotation; coverage: Coverage };
export type StructuredOutput = {
  environment: 'synthetic-test'; rows: NumericDailyRow[];
  descriptor: { format: 'internal-synthetic-daily/1'; fields: string[]; primaryKey: string[];
    priceUnit: 'CNY'; priceScale: 10000; volumeUnit: 'shares'; volumeScale: 1; dateEncoding: 'YYYYMMDD';
    instrumentDictionary: Record<string, number> };
  evidence: { sourceInputs: SourceInput[]; annotation: Annotation; scope: CollectionScope; coverage: Coverage; planSha256: string };
  limitations: string[];
};
export type StructuredArtifact = { kind: 'structured'; output: StructuredOutput };
export type CollectionArtifact = RawArtifact | ParsedArtifact | CleanedArtifact | AnnotatedArtifact | CheckedArtifact | StructuredArtifact;
export type StepOutput<A extends CollectionArtifact = CollectionArtifact> = { output: A; diagnostics: string[] };
export type CollectionStep = StepBinding & {
  inputKind: CollectionArtifact['kind']; outputKind: CollectionArtifact['kind'];
  execute(input: CollectionArtifact, plan: CollectionPlan): StepOutput;
};
export type CollectionStepRegistry = Readonly<Record<string, CollectionStep>>;
export type StepExecution = StepBinding & {
  runtime: RuntimeEnvironment; planSha256: string; inputSha256: string; outputSha256: string;
  internalInputSha256: string; internalOutputSha256: string;
  output: CollectionArtifact; diagnostics: string[];
};

export class CollectionPipelineError extends Error {
  constructor(readonly stepId: string, readonly code: string, message: string) {
    super(message); this.name = 'CollectionPipelineError';
  }
}

const HEADER = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'] as const;
const NUMERIC_FIELDS = ['instrument_id', 'trade_date', 'open', 'high', 'low', 'close', 'volume'];
const MAX_BYTES = 65_536, MAX_ROWS = 1000, MAX_PARTS = 8;
const REFERENCES = {
  dictionary: { version: 'synth-instruments/1', entries: { 'SYNTH-A': 1 } },
  dates: { version: 'synth-dates/1', start: '2026-01-01', end: '2026-12-31', meaning: 'synthetic-calendar-dates' },
};
const runtime = (): RuntimeEnvironment => ({ nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, dependenciesSha256: DEPENDENCIES_SHA256 });
function fail(step: string, code: string, message: string): never { throw new CollectionPipelineError(step, code, message); }
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const DEPENDENCIES_BYTES = Buffer.from(canonical({ builtins: ['node:crypto/sha256', 'node:fs/readFileSync', 'TextDecoder/utf-8/fatal'],
  canonicalJson: 'recursive-key-sort/no-whitespace/no-ascii-escape/1', references: REFERENCES }));
const DEPENDENCIES_SHA256 = sha256(DEPENDENCIES_BYTES);
// 只在模块加载时捕获受控程序元数据；加工步骤不读写原件或其他业务文件。
const IMPLEMENTATION_BYTES = Buffer.from(canonical({ files: [
  { name: 'pipeline', bytesBase64: readFileSync(new URL(import.meta.url)).toString('base64') },
  { name: 'wfd-table', bytesBase64: readFileSync(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? '../../adapters/database/wfd-table.ts' : '../../adapters/database/wfd-table.js', import.meta.url)).toString('base64') },
] }));
const IMPLEMENTATION_SHA256 = sha256(IMPLEMENTATION_BYTES);
export function implementationBytes(): Uint8Array { return Buffer.from(IMPLEMENTATION_BYTES); }
export function dependencyManifestBytes(): Uint8Array { return Buffer.from(DEPENDENCIES_BYTES); }

/** 只产生可持久化的内部输入；原件和 UTF-8 文本由调用者保管，本模块不读写文件。 */
export function createRawArtifact(input: Uint8Array | readonly Uint8Array[]): RawArtifact {
  const parts = input instanceof Uint8Array ? [input] : input;
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS || parts.some(part => !(part instanceof Uint8Array) || !part.byteLength)
    || parts.reduce((sum, part) => sum + part.byteLength, 0) > MAX_BYTES) fail('parse', 'INPUT_BUDGET', '合成 CSV 原件须非空，最多 8 片且合计不超过 64 KiB。');
  return { kind: 'raw', parts: parts.map(part => ({ bytesBase64: Buffer.from(part).toString('base64'), sha256: sha256(part), byteLength: part.byteLength, mediaType: 'text/csv' })) };
}

export function createCollectionPlan(scope: CollectionScope): CollectionPlan {
  const plan: CollectionPlan = { environment: 'synthetic-test', runtime: runtime(), scope: structuredClone(scope),
    units: { price: 'CNY', volume: 'shares' }, referenceVersions: { dictionary: REFERENCES.dictionary.version, dates: REFERENCES.dates.version },
    referenceSha256: digestArtifact(REFERENCES), steps: STEP_NAMES.map(step => binding(DEFAULT_STEP_REGISTRY[step]!)) };
  validatePlan(plan, 'plan');
  return plan;
}

export function parse(input: CollectionArtifact, _plan: CollectionPlan): StepOutput<ParsedArtifact> {
  const raw = requireKind(input, 'raw', 'parse');
  if (!Array.isArray(raw.parts) || !raw.parts.length || raw.parts.length > MAX_PARTS) fail('parse', 'INPUT_BUDGET', '原始输入片数无效。');
  let bytesTotal = 0;
  const rows: DailyTextRow[] = [], sourceInputs: SourceInput[] = [];
  for (const [sourcePart, part] of raw.parts.entries()) {
    if (part?.mediaType !== 'text/csv') fail('parse', 'INVALID_RAW_MEDIA_TYPE', '简单 CSV 插件只接受明确声明的 text/csv 原件。');
    if (!part || typeof part.bytesBase64 !== 'string' || part.bytesBase64.length > 90_000
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.bytesBase64)) fail('parse', 'INVALID_RAW_BYTES', '原始输入不是规范 Base64 字节。');
    const bytes = Buffer.from(part.bytesBase64, 'base64');
    bytesTotal += bytes.byteLength;
    if (!bytes.byteLength || bytesTotal > MAX_BYTES) fail('parse', 'INPUT_BUDGET', '合成 CSV 原件为空或超过 64 KiB。');
    if (bytes.toString('base64') !== part.bytesBase64 || sha256(bytes) !== part.sha256 || bytes.byteLength !== part.byteLength) fail('parse', 'INPUT_DIGEST_MISMATCH', '原始字节与封闭输入摘要或大小不一致。');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('parse', 'INVALID_UTF8', 'CSV 不是有效 UTF-8 字节。'); }
    if (/["\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail('parse', 'UNSUPPORTED_CSV', '只接受无引号、无控制字符的简单逗号分隔 CSV。');
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.shift() !== HEADER.join(',')) fail('parse', 'INVALID_CSV_HEADER', 'CSV 表头须严格为 symbol,date,open,high,low,close,volume。');
    for (const [lineIndex, line] of lines.entries()) {
      const cells = line.split(',');
      if (cells.length !== HEADER.length || cells.some(cell => cell.length > 128 || cell.includes('\r'))) fail('parse', 'INVALID_CSV_ROW', 'CSV 行字段数、长度或换行格式不符合简单格式。');
      rows.push({ symbol: cells[0]!, date: cells[1]!, open: cells[2]!, high: cells[3]!, low: cells[4]!, close: cells[5]!, volume: cells[6]!, sourcePart, sourceLine: lineIndex + 2 });
      if (rows.length > MAX_ROWS) fail('parse', 'ROW_BUDGET', '合成 CSV 超过 1000 行预算。');
    }
    sourceInputs.push({ sha256: part.sha256, byteLength: part.byteLength, mediaType: part.mediaType });
  }
  return { output: { kind: 'parsed', sourceInputs, rows }, diagnostics: [`严格解析 ${sourceInputs.length} 片、${rows.length} 行；原始摘要逐片保留。`] };
}

export function clean(input: CollectionArtifact, _plan: CollectionPlan): StepOutput<CleanedArtifact> {
  const parsed = requireKind(input, 'parsed', 'clean');
  let trimmed = 0;
  const rows = parsed.rows.map(row => {
    const next = { ...row };
    for (const field of HEADER) {
      if (typeof row[field] !== 'string') fail('clean', 'INVALID_TEXT_FIELD', '待清洗字段必须保留源文本。');
      next[field] = row[field].trim();
      if (next[field] !== row[field]) trimmed++;
      if (!next[field]) fail('clean', 'MISSING_VALUE', '合成日线不允许空字段，也不猜测填充。');
    }
    return next;
  }).sort((a, b) => compare(a.symbol, b.symbol) || compare(a.date, b.date));
  return { output: { kind: 'cleaned', sourceInputs: structuredClone(parsed.sourceInputs), rows },
    diagnostics: [`只去除 ${trimmed} 个字段的首尾空白并按 symbol/date 排序；未去重、未舍入、未换算单位。`] };
}

export function annotate(input: CollectionArtifact, plan: CollectionPlan): StepOutput<AnnotatedArtifact> {
  const cleaned = requireKind(input, 'cleaned', 'annotate');
  const rows = cleaned.rows.map(row => {
    if (row.symbol !== 'SYNTH-A') fail('annotate', 'UNKNOWN_INSTRUMENT', '固定合成字典仅登记 SYNTH-A，不能猜测证券身份。');
    const trade_date = dateCode(row.date, 'annotate');
    if (row.date < REFERENCES.dates.start || row.date > REFERENCES.dates.end) fail('annotate', 'DATE_REFERENCE_RANGE', '日期超出固定合成参考范围。');
    return { ...row, instrument_id: 1, trade_date };
  });
  const annotation: Annotation = { environment: 'synthetic-test', historicalPublic: 'unknown',
    referenceVersions: structuredClone(plan.referenceVersions), referenceSha256: plan.referenceSha256,
    dateRange: { start: REFERENCES.dates.start, end: REFERENCES.dates.end } };
  return { output: { kind: 'annotated', sourceInputs: structuredClone(cleaned.sourceInputs), rows, annotation },
    diagnostics: ['引用固定合成身份字典与日期范围；历史公开可得资格保持 unknown（未知）。'] };
}

export function check(input: CollectionArtifact, plan: CollectionPlan): StepOutput<CheckedArtifact> {
  const annotated = requireKind(input, 'annotated', 'check');
  if (digestArtifact(annotated.annotation) !== digestArtifact({ environment: 'synthetic-test', historicalPublic: 'unknown',
    referenceVersions: plan.referenceVersions, referenceSha256: plan.referenceSha256,
    dateRange: { start: REFERENCES.dates.start, end: REFERENCES.dates.end } })) fail('check', 'ANNOTATION_MISMATCH', '标注引用或可得资格与固定合成声明不一致。');
  const keys = new Set<string>();
  const rows = annotated.rows.map(row => {
    if (row.instrument_id !== 1 || row.symbol !== 'SYNTH-A' || row.trade_date !== dateCode(row.date, 'check')) fail('check', 'IDENTITY_MISMATCH', '标注身份或日期编码与固定参考不一致。');
    const key = `${row.symbol}/${row.date}`;
    if (keys.has(key)) fail('check', 'DUPLICATE_KEY', '同一证券与日期出现重复行，不静默去重。');
    keys.add(key);
    const numeric = { instrument_id: row.instrument_id, trade_date: row.trade_date,
      open: price(row.open), high: price(row.high), low: price(row.low), close: price(row.close), volume: volume(row.volume) };
    if (numeric.low > numeric.high || numeric.open < numeric.low || numeric.open > numeric.high || numeric.close < numeric.low || numeric.close > numeric.high) fail('check', 'INVALID_OHLC', '开盘、收盘及高低价格关系不成立。');
    return numeric;
  });
  const expected = new Set(plan.scope.symbols.flatMap(symbol => plan.scope.tradeDates.map(date => `${symbol}/${date}`)));
  if (keys.size !== expected.size || [...keys].some(key => !expected.has(key))) fail('check', 'COVERAGE_MISMATCH', '实际证券与日期必须恰好覆盖明确请求，不接受缺项或范围外结果。');
  return { output: { kind: 'checked', sourceInputs: structuredClone(annotated.sourceInputs), rows, annotation: structuredClone(annotated.annotation),
    coverage: { expectedRows: expected.size, actualRows: rows.length, complete: true, empty: rows.length === 0 } },
    diagnostics: ['唯一键、OHLC、非负股份量、精确四位定点和完整请求覆盖均已核对。'] };
}

export function structure(input: CollectionArtifact, plan: CollectionPlan): StepOutput<StructuredArtifact> {
  const checked = requireKind(input, 'checked', 'structure');
  return { output: { kind: 'structured', output: { environment: 'synthetic-test', rows: structuredClone(checked.rows),
    descriptor: { format: 'internal-synthetic-daily/1', fields: [...NUMERIC_FIELDS], primaryKey: ['instrument_id', 'trade_date'],
      priceUnit: 'CNY', priceScale: 10000, volumeUnit: 'shares', volumeScale: 1, dateEncoding: 'YYYYMMDD', instrumentDictionary: { 'SYNTH-A': 1 } },
    evidence: { sourceInputs: structuredClone(checked.sourceInputs), annotation: structuredClone(checked.annotation), scope: structuredClone(plan.scope), coverage: structuredClone(checked.coverage), planSha256: digestArtifact(plan) },
    limitations: ['仅隔离合成 CNY 样本，不代表真实市场数据。', 'historical_public（历史公开可得资格）为 unknown（未知）。', '日期参考只是合成日期范围，不是交易所日历。', '内部结构化结果，不是正式数据库线协议；没有正式提交或快照。',
      ...(checked.coverage.empty ? ['显式请求日期集合为空，合法空结果不表示删除已有数据。'] : [])] } }, diagnostics: ['已输出纯数值行与明确单位、缩放、证据和限制；未写入数据库。'] };
}

const step = (stepId: StepName, inputKind: CollectionArtifact['kind'], outputKind: CollectionArtifact['kind'], ruleVersion: string,
  parameters: JsonValue, execute: CollectionStep['execute']): CollectionStep => ({ stepId, inputKind, outputKind,
  implementationVersion: stepId === 'structure' ? 'synthetic-daily-structure-wfd-v0.2/2' : `synthetic-daily-${stepId}/1`,
  implementationSha256: IMPLEMENTATION_SHA256, ruleVersion,
  methodVersion: stepId === 'structure' ? 'synthetic-daily-structure-wfd-v0.2-method/2' : `synthetic-daily-${stepId}-method/1`, parameters, execute });
export const DEFAULT_STEP_REGISTRY: CollectionStepRegistry = freeze({
  parse: step('parse', 'raw', 'parsed', 'strict-simple-csv/1', { encoding: 'utf8-fatal', delimiter: ',', quoted: false, maxBytes: MAX_BYTES, maxRows: MAX_ROWS, maxParts: MAX_PARTS, maxFieldLength: 128, inputDigest: 'original-manifest/wfd-0.1.1' }, parse),
  clean: step('clean', 'parsed', 'cleaned', 'trim-sort-only/1', { trim: true, sort: ['symbol', 'date'], deduplicate: false, rounding: false }, clean),
  annotate: step('annotate', 'cleaned', 'annotated', 'fixed-synthetic-references/1', { dictionary: REFERENCES.dictionary.version, dates: REFERENCES.dates.version, historicalPublic: 'unknown' }, annotate),
  check: step('check', 'annotated', 'checked', 'exact-daily-validation/1', { priceScale: 10000, priceUnit: 'CNY', volumeUnit: 'shares', coverage: 'exact-cartesian-scope', nonnegative: true }, check),
  structure: step('structure', 'checked', 'structured', 'wfd-table-projection/v0.2', { priceScale: 10000, volumeScale: 1,
    dateEncoding: 'YYYYMMDD', fields: NUMERIC_FIELDS, contractVersion: 'wfd-table/v0.2', numericSemantics: 'unit_value=stored_integer/scale' }, structure),
});

/** 可逐步持久化；注册替换必须满足原计划全部版本与参数，不能回退到别的实现。 */
export function executeStep(stepId: string, input: CollectionArtifact, plan: CollectionPlan, registry: CollectionStepRegistry = DEFAULT_STEP_REGISTRY): StepExecution {
  const plugin = resolveStep(stepId, plan, registry);
  requireKind(input, plugin.inputKind, stepId);
  const fixedInput = freeze(jsonClone(input)), fixedPlan = freeze(jsonClone(plan)), fixedBinding = binding(plugin);
  const planSha256 = digestArtifact(fixedPlan), inputSha256 = digestArtifact(fixedInput), internalInputSha256 = sha256(canonical(fixedInput));
  try {
    const result = plugin.execute(fixedInput, fixedPlan);
    requireKind(result.output, plugin.outputKind, stepId);
    if (!Array.isArray(result.diagnostics) || result.diagnostics.some(value => typeof value !== 'string')) fail(stepId, 'INVALID_STEP_RESULT', '步骤诊断必须是文本数组。');
    return { ...fixedBinding, runtime: runtime(), planSha256, inputSha256,
      outputSha256: digestArtifact(result.output), internalInputSha256, internalOutputSha256: sha256(canonical(result.output)),
      output: jsonClone(result.output), diagnostics: [...result.diagnostics] };
  } catch (error) {
    if (error instanceof CollectionPipelineError) throw error;
    fail(stepId, 'STEP_EXECUTION_FAILED', '受控加工步骤失败，未继续后续步骤。');
  }
}

/** 恢复只核已保存结果与原固定计划，不再次执行插件。 */
export function validateStepExecution(execution: StepExecution, input: CollectionArtifact, plan: CollectionPlan, registry: CollectionStepRegistry = DEFAULT_STEP_REGISTRY): StepExecution {
  const plugin = resolveStep(execution.stepId, plan, registry);
  requireKind(input, plugin.inputKind, execution.stepId); requireKind(execution.output, plugin.outputKind, execution.stepId);
  if (digestArtifact(binding(execution)) !== digestArtifact(binding(plugin)) || digestArtifact(execution.runtime) !== digestArtifact(plan.runtime)
    || execution.planSha256 !== digestArtifact(plan) || execution.inputSha256 !== digestArtifact(input) || execution.outputSha256 !== digestArtifact(execution.output)
    || execution.internalInputSha256 !== sha256(canonical(input)) || execution.internalOutputSha256 !== sha256(canonical(execution.output))) {
    fail(execution.stepId, 'CHECKPOINT_MISMATCH', '已保存步骤的输入、输出、版本或计划摘要不一致。');
  }
  return jsonClone(execution);
}

export function getStructuredOutput(artifact: CollectionArtifact): StructuredOutput {
  return jsonClone(requireKind(artifact, 'structured', 'structure').output);
}

export function runCollectionPipeline(input: RawArtifact, plan: CollectionPlan, registry: CollectionStepRegistry = DEFAULT_STEP_REGISTRY):
  { state: 'succeeded'; traces: StepExecution[]; output: StructuredOutput } | { state: 'failed'; traces: StepExecution[]; failure: { stepId: string; code: string; message: string } } {
  const traces: StepExecution[] = [];
  let artifact: CollectionArtifact = input;
  try {
    for (const entry of plan.steps) { const execution = executeStep(entry.stepId, artifact, plan, registry); traces.push(execution); artifact = execution.output; }
    return { state: 'succeeded', traces, output: getStructuredOutput(artifact) };
  } catch (error) {
    const failure = error instanceof CollectionPipelineError ? error : new CollectionPipelineError('plan', 'INVALID_PIPELINE', '内部加工计划或输入无效。');
    return { state: 'failed', traces, failure: { stepId: failure.stepId, code: failure.code, message: failure.message } };
  }
}

export function digestArtifact(value: unknown): string { return sha256(encodeArtifact(value)); }
/** 持久化与交接证据使用这些确切字节，使摘要不依赖调用者的对象键插入顺序。 */
export function encodeArtifact(value: unknown): Uint8Array {
  // 正式原件摘要按 0.1.1 合同的有序清单；字节正文仍由 parse 逐件核 SHA-256。
  const artifact = value as CollectionArtifact | null;
  const document = artifact && artifact.kind === 'raw' && Array.isArray(artifact.parts)
    ? { objects: artifact.parts.map(part => ({ byte_length: part.byteLength, media_type: part.mediaType, sha256: part.sha256 })) }
    : artifact && artifact.kind === 'structured' ? createWfdTablePackage(artifact.output) : value;
  return Buffer.from(canonical(document), 'utf8');
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) fail('plan', 'INVALID_JSON_ARTIFACT', '内部加工产物超过结构深度预算。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
  }
  fail('plan', 'INVALID_JSON_ARTIFACT', '内部加工产物必须是有限值组成的 JSON。');
}
function jsonClone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function binding(value: StepBinding): StepBinding {
  return { stepId: value.stepId, implementationVersion: value.implementationVersion, implementationSha256: value.implementationSha256,
    ruleVersion: value.ruleVersion, methodVersion: value.methodVersion, parameters: jsonClone(value.parameters) };
}
function resolveStep(stepId: string, plan: CollectionPlan, registry: CollectionStepRegistry): CollectionStep {
  validatePlan(plan, stepId);
  const expected = plan.steps.find(entry => entry.stepId === stepId);
  const plugin = Object.hasOwn(registry, stepId) ? registry[stepId] : undefined;
  if (!expected || !plugin || digestArtifact(binding(expected)) !== digestArtifact(binding(plugin))) fail(stepId, 'STEP_VERSION_UNAVAILABLE', '原计划绑定的加工、规则、方法版本或参数不可用，不能静默换版。');
  return plugin;
}
function validatePlan(plan: CollectionPlan, stepId: string): void {
  if (!plan || plan.environment !== 'synthetic-test' || plan.units?.price !== 'CNY' || plan.units?.volume !== 'shares'
    || digestArtifact(plan.runtime) !== digestArtifact(runtime()) || plan.referenceVersions?.dictionary !== REFERENCES.dictionary.version
    || plan.referenceVersions?.dates !== REFERENCES.dates.version || plan.referenceSha256 !== digestArtifact(REFERENCES)) fail(stepId, 'PLAN_BINDING_CONFLICT', '合成环境、运行环境、单位或参考版本与固定计划不一致。');
  const scope = plan.scope;
  if (!scope || !Array.isArray(scope.symbols) || scope.symbols.length !== 1 || scope.symbols[0] !== 'SYNTH-A'
    || !Array.isArray(scope.tradeDates) || scope.tradeDates.length > MAX_ROWS || new Set(scope.tradeDates).size !== scope.tradeDates.length) fail(stepId, 'INVALID_SCOPE', '请求须明确固定合成证券及不重复的日期集合。');
  for (const date of scope.tradeDates) {
    dateCode(date, stepId);
    if (date < REFERENCES.dates.start || date > REFERENCES.dates.end) fail(stepId, 'DATE_REFERENCE_RANGE', '请求日期超出固定合成参考范围。');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length < STEP_NAMES.length || new Set(plan.steps.map(entry => entry.stepId)).size !== plan.steps.length) fail(stepId, 'INVALID_STEP_PLAN', '步骤计划须包含唯一身份及默认五步。');
  const defaults = plan.steps.map(entry => entry.stepId).filter(id => (STEP_NAMES as readonly string[]).includes(id));
  if (defaults.join(',') !== STEP_NAMES.join(',')) fail(stepId, 'INVALID_STEP_PLAN', '默认五步不可省略或改序，可显式登记附加步骤。');
}
function requireKind<K extends CollectionArtifact['kind']>(input: CollectionArtifact, kind: K, stepId: string): Extract<CollectionArtifact, { kind: K }> {
  if (!input || input.kind !== kind) fail(stepId, 'INVALID_STEP_INPUT', '步骤输入类型或执行顺序不符合固定计划。');
  return input as Extract<CollectionArtifact, { kind: K }>;
}
function dateCode(value: string, stepId: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(stepId, 'INVALID_DATE', '日期须为真实 YYYY-MM-DD，不能猜测修正。');
  return Number(value.replaceAll('-', ''));
}
function price(value: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) fail('check', 'INVALID_PRICE', '价格须为非负十进制文本，不接受指数、非有限值或单位推测。');
  const fraction = match[2] ?? '';
  if (/[1-9]/.test(fraction.slice(4))) fail('check', 'SOURCE_PRECISION', '价格不能精确表示为四位定点值，禁止静默舍入。');
  const scaled = BigInt(match[1]!) * 10000n + BigInt(fraction.slice(0, 4).padEnd(4, '0'));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) fail('check', 'UNSAFE_PRICE', '定点价格超过安全整数范围。');
  return Number(scaled);
}
function volume(value: string): number {
  if (!/^\d+$/.test(value)) fail('check', 'INVALID_VOLUME', '股份量须为非负整数文本，不接受手数或小数换算。');
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('check', 'UNSAFE_VOLUME', '股份量超过安全整数范围。');
  return Number(amount);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MaterialLimits, MaterialRecord, MaterialScalar } from './materials/contracts.js';
import { materialLimits } from './data-processing/material-inspector/index.js';
import { applySemanticTableCleaning, parseSemanticMaterialTable } from './data-processing/table-cleaner/index.js';
import type { MaterialSemanticRecord, SemanticEvidence, SemanticJudgment } from './materials/semantic-contracts.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { SealedCollectionObject } from './handoff.js';
import { encodeWfdScaledInteger } from '../../adapters/database/wfd-table.js';
import { canonicalWfdJson as canonical, isWfdRecord } from '../../adapters/database/wfd-transport.js';

export const USER_TABLE_PIPELINE_VERSION = 'user-table-daily/1';
export const USER_TABLE_STEPS = ['parse', 'clean', 'annotate', 'check', 'structure'] as const;
export const USER_TABLE_LIMITS = Object.freeze({ maxRows: 512, maxObjectBytes: 1_048_576, maxBundleBytes: 8_388_608 });
type StepName = typeof USER_TABLE_STEPS[number];
type FieldRole = 'instrument' | 'trade_date' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'available_at' | 'bar_closed';
const REQUIRED_ROLES = ['trade_date', 'open', 'close'] as const;
const FIELD_ROLES: readonly FieldRole[] = ['instrument', ...REQUIRED_ROLES, 'high', 'low', 'volume', 'available_at', 'bar_closed'];
const OUTPUT_FIELDS = ['series_id', 'timestamp', 'open', 'close', 'available_at', 'bar_closed'] as const;
const SHA = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const WHOLE_TABLE = /(?:整表|全表|所有行|全部行|所有观测|全部观测|所有日线|全部日线|all rows|entire table)/iu;
const CLOSED = /(?:已收盘|收盘完成|已闭合|bar_closed\s*[:=]\s*true|closed)/iu;

/** 仅受信测试宿主能传自生成来源；真实附件默认 false，不读取模型的 synthetic 标签。 */
export type UserTableProvenance = { kind: 'self-generated-test'; fixtureId: string };
/** 目标由宿主从冻结的数据库合同取得；本程序没有数据集默认值或生产绑定。 */
export interface UserTableTarget {
  datasetId: string; mappingVersion: string; unitId: string; outputId: string;
  definitionRevision: string; schemaRevision: string; contractVersion: 'wfd-table/v0.2';
  schemaSha256: string; dataKind: string; purpose: 'analysis' | 'user_test';
  descriptorSemantics: JsonValue; semanticsSha256: string;
}
export interface UserDailyDeclaration {
  version: typeof USER_TABLE_PIPELINE_VERSION;
  materialId: string; originalSha256: string; proposalId: string; semanticRecordSha256: string;
  origin: { conversationId: string; branchId: string; parentRunId: string; messageId: string; serviceTaskId: string };
  instrument: { symbol: string; market: string }; seriesId: string;
  fieldMapping: Partial<Record<FieldRole, number>>;
  currency: 'CNY'; priceUnit: 'currency_per_share'; priceScale: '10000'; volumeUnit?: 'shares';
  frequency: '1d'; timezone: string; adjustment: 'none'; observationSequence: 'provided_observations';
  asOf: string; availabilityBasis: 'explicit_per_bar'; uniformAvailableAt?: string; uniformBarClosed?: true;
  synthetic: boolean; sourceKind: 'user-file' | 'self-generated-test'; testFixtureId?: string;
  useMode: 'analysis'; historicalPublic: 'unknown'; externallyAuthenticated: false;
  semanticEvidence: Array<{ dimension: string; judgment: SemanticJudgment }>;
  excludedSourceColumns: Array<{ column: number; name: string }>;
  limitations: string[];
}
export type UserDailyDeclarationResult = { status: 'ready'; declaration: UserDailyDeclaration }
  | { status: 'needs_confirmation'; missingDimensions: string[]; questions: string[] };
export interface UserTableStepExecution {
  stepId: StepName; implementationVersion: string; implementationSha256: string; ruleVersion: string; methodVersion: string;
  parameters: Record<string, JsonValue>;
  runtime: { nodeVersion: string; platform: string; arch: string; dependenciesSha256: string };
  planSha256: string; inputSha256: string; outputSha256: string; output: JsonValue; diagnostics: string[];
}
export interface UserTablePlan {
  version: typeof USER_TABLE_PIPELINE_VERSION; declaration: UserDailyDeclaration; target: UserTableTarget;
  originalManifestSha256: string; implementationSha256: string; dependenciesSha256: string;
  materialLimits: MaterialLimits;
}
export type UserTablePipelineResult = {
  state: 'succeeded'; plan: UserTablePlan; declaration: UserDailyDeclaration; traces: UserTableStepExecution[];
  tablePackage: JsonValue; original: SealedCollectionObject; evidence: SealedCollectionObject[];
} | { state: 'needs_confirmation'; missingDimensions: string[]; questions: string[] }
  | { state: 'failed'; traces: UserTableStepExecution[]; failure: { stepId: StepName | 'plan'; code: string; message: string } };

export class UserTablePipelineError extends Error {
  constructor(readonly code: string, message: string, readonly stepId: StepName | 'plan' = 'plan') { super(message); this.name = 'UserTablePipelineError'; }
}
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const userTableDigest = (value: unknown): string => sha(canonical(value));
function fail(code: string, message: string, stepId: StepName | 'plan' = 'plan'): never { throw new UserTablePipelineError(code, message, stepId); }
function json(value: unknown): JsonValue { return JSON.parse(canonical(value)) as JsonValue; }
const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
const sourceFile = (path: string): Uint8Array => readFileSync(new URL(path, import.meta.url));
const sourceExtension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js';
const IMPLEMENTATION_BYTES = Buffer.from(canonical({ files: [
  { name: 'user-table-pipeline', bytes_base64: Buffer.from(sourceFile(`./user-table-pipeline.${sourceExtension}`)).toString('base64') },
  ...['./materials/semantic', './data-processing/table-cleaner/index', './materials/contracts', './materials/semantic-contracts', './data-processing/material-inspector/index', '../../adapters/database/wfd-table', '../../adapters/database/wfd-transport'].map(path => ({
    name: path, bytes_base64: Buffer.from(sourceFile(`${path}.${sourceExtension}`)).toString('base64') })),
] }));
const IMPLEMENTATION_SHA256 = sha(IMPLEMENTATION_BYTES);
const DEPENDENCY_BYTES = Buffer.from(canonical({ version: 'user-table-dependencies/1', node: process.versions.node,
  platform: process.platform, arch: process.arch, package_lock_sha256: sha(sourceFile('../../package-lock.json')),
  json_serialization: 'recursive-key-sort/no-whitespace/no-ascii-escape/1', numeric_encoding: 'wfd-table/v0.2' }));
const DEPENDENCIES_SHA256 = sha(DEPENDENCY_BYTES);

/** 从已持久化采用记录投影；返回具体缺项，不接受第二份模型自报可信声明。 */
export function deriveUserDailyDeclaration(material: MaterialRecord, record: MaterialSemanticRecord,
  provenance?: UserTableProvenance): UserDailyDeclarationResult {
  assertRecord(material, record);
  const table = record.result.table!;
  if (table.totalRows < 1 || table.totalRows > USER_TABLE_LIMITS.maxRows || table.rows.length !== table.totalRows) fail('USER_TABLE_ROW_LIMIT', '首包须含 1 至 512 行；请缩小原件范围，不截断后冒充完整材料。');
  if (material.envelope.byteLength > USER_TABLE_LIMITS.maxObjectBytes) fail('USER_TABLE_OBJECT_LIMIT', '原件超过 WFD 单对象 1 MiB 交接上限；材料保管成功不代表可交接。');
  if (provenance && (provenance.kind !== 'self-generated-test' || !IDENTIFIER.test(provenance.fixtureId))) fail('USER_TABLE_PROVENANCE', '自生成测试身份必须由受信宿主明确登记。');
  const missing = new Set<string>(), semanticEvidence: UserDailyDeclaration['semanticEvidence'] = [];
  const select = (dimension: string, key: SemanticJudgment['key'], scope: string, expected?: string): SemanticJudgment | undefined => {
    const same = (j: SemanticJudgment) => j.key === key && (j.scope ?? 'material') === scope;
    const known = record.result.adoptedKnown.filter(same), all = record.proposal.judgments.filter(same);
    if (!known.length || all.some(j => j.status !== 'known') || new Set(known.map(j => j.value)).size !== 1
      || !known[0]!.value?.trim() || (expected !== undefined && known[0]!.value !== expected)) { missing.add(dimension); return undefined; }
    const judgment = known[0]!;
    semanticEvidence.push({ dimension, judgment: clone(judgment) });
    return judgment;
  };
  const mapping: UserDailyDeclaration['fieldMapping'] = {};
  for (const j of record.result.adoptedKnown.filter(j => j.key === 'field')) {
    if (!FIELD_ROLES.includes(j.value as FieldRole)) continue;
    const columnMatch = /^column:([1-9]\d*)$/u.exec(j.scope ?? ''), role = j.value as FieldRole;
    const column = columnMatch ? Number(columnMatch[1]) : 0, header = table.columns[column - 1];
    if (!header || mapping[role] !== undefined || record.proposal.judgments.some(other => other.key === 'field' && other.scope === j.scope
      && (other.status !== 'known' || other.value !== j.value))
      || !j.evidence.some(e => e.source === 'original' && e.start! <= header.location.start && e.end! >= header.location.end)) {
      missing.add(`field:${role}`); continue;
    }
    mapping[role] = column; semanticEvidence.push({ dimension: `field:${role}`, judgment: clone(j) });
  }
  for (const role of REQUIRED_ROLES) if (mapping[role] === undefined) missing.add(`field:${role}`);
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) missing.add('field:distinct_columns');
  const symbol = select('instrument', 'source', 'instrument')?.value;
  const market = select('market', 'source', 'market')?.value;
  select('currency', 'currency', 'material', 'CNY'); select('price_unit', 'unit', 'price', 'currency_per_share');
  if (mapping.volume !== undefined) select('volume_unit', 'unit', 'volume', 'shares');
  select('frequency', 'period', 'material', '1d');
  select('adjustment', 'adjustment', 'material', 'none');
  select('observation_sequence', 'parameters', 'observation_sequence', 'provided_observations');
  const timezone = select('timezone', 'timeAvailability', 'timezone')?.value;
  const asOf = select('as_of', 'timeAvailability', 'as_of')?.value;
  if (symbol && (symbol.length > 80 || /[\s\u0000-\u001f]/u.test(symbol))) missing.add('instrument');
  if (market && (market.length > 32 || !/^[A-Za-z0-9._-]+$/u.test(market))) missing.add('market');
  if (timezone) { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { missing.add('timezone'); } }
  if (asOf && !zonedInstant(asOf)) missing.add('as_of');
  let uniformAvailableAt: string | undefined, uniformBarClosed: true | undefined;
  if (mapping.available_at === undefined) {
    const j = select('available_at', 'timeAvailability', 'available_at');
    if (!j || !zonedInstant(j.value!) || !j.evidence.some(e => e.source === 'user-message' && WHOLE_TABLE.test(e.quote) && e.quote.includes(j.value!))) missing.add('available_at');
    else uniformAvailableAt = j.value;
  }
  if (mapping.bar_closed === undefined) {
    const j = select('bar_closed', 'parameters', 'bar_closed', 'true');
    if (!j || !j.evidence.some(e => e.source === 'user-message' && WHOLE_TABLE.test(e.quote) && CLOSED.test(e.quote))) missing.add('bar_closed');
    else uniformBarClosed = true;
  }
  if (missing.size) return { status: 'needs_confirmation', missingDimensions: [...missing], questions: questionsFor([...missing]) };
  const assigned = new Set(Object.entries(mapping).filter(([role]) => !['high', 'low', 'volume'].includes(role)).map(([, column]) => column));
  const declaration: UserDailyDeclaration = {
    version: USER_TABLE_PIPELINE_VERSION, materialId: material.envelope.materialId, originalSha256: material.envelope.sha256,
    proposalId: record.envelope.proposalId, semanticRecordSha256: userTableDigest(record),
    origin: { conversationId: record.origin.conversationId, branchId: record.origin.branchId, parentRunId: record.origin.parentRunId,
      messageId: record.origin.messageId, serviceTaskId: record.envelope.serviceTaskId },
    instrument: { symbol: symbol!, market: market! }, seriesId: `${market}:${symbol}`,
    fieldMapping: mapping, currency: 'CNY', priceUnit: 'currency_per_share', priceScale: '10000', ...(mapping.volume === undefined ? {} : { volumeUnit: 'shares' as const }),
    frequency: '1d', timezone: timezone!, adjustment: 'none', observationSequence: 'provided_observations',
    asOf: asOf!, availabilityBasis: 'explicit_per_bar',
    ...(uniformAvailableAt ? { uniformAvailableAt } : {}), ...(uniformBarClosed ? { uniformBarClosed } : {}),
    synthetic: provenance !== undefined, sourceKind: provenance ? 'self-generated-test' : 'user-file',
    ...(provenance ? { testFixtureId: provenance.fixtureId } : {}),
    useMode: 'analysis', historicalPublic: 'unknown', externallyAuthenticated: false, semanticEvidence,
    excludedSourceColumns: table.columns.flatMap((column, index) => assigned.has(index + 1) ? [] : [{ column: index + 1, name: column.applied }]),
    limitations: ['仅对用户当前提供的有序观测作回顾分析，不证明交易日连续或市场完整覆盖。',
      '证券、单位及时间声明来自已核对引用的原件与用户消息，未经外部认证；历史公开时间资格未知。',
      '仅允许冻结的六字段日线投影；高低价、成交量及其他未投影列仍在原件及完整清洗证据中保留。', '本地加工候选不是 WFD 正式提交或金融结果发布。'],
  };
  return { status: 'ready', declaration: deepFreeze(clone(declaration)) };
}

/** 五步均实际运行；结构化摘要来自最终包字节，数据库回执只能由外层真实调用产生。 */
export function runUserTablePipeline(input: { originalBytes: Uint8Array; material: MaterialRecord; semanticRecord: MaterialSemanticRecord;
  target: UserTableTarget; provenance?: UserTableProvenance }): UserTablePipelineResult {
  const traces: UserTableStepExecution[] = []; let currentStep: StepName | 'plan' = 'plan';
  try {
    const { material, semanticRecord: record } = input;
    const originalBytes = Buffer.from(input.originalBytes);
    if (!originalBytes.byteLength || originalBytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) fail('USER_TABLE_OBJECT_LIMIT', '交接原件须非空且不超过 1 MiB。');
    if (originalBytes.byteLength !== material.envelope.byteLength || sha(originalBytes) !== material.envelope.sha256) fail('USER_TABLE_ORIGINAL_MISMATCH', '原件字节、长度或摘要与材料记录不一致。');
    const derived = deriveUserDailyDeclaration(material, record, input.provenance);
    if (derived.status !== 'ready') return { state: 'needs_confirmation', missingDimensions: derived.missingDimensions, questions: derived.questions };
    const declaration = derived.declaration, target = clone(input.target);
    validateTarget(target, declaration.synthetic);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes); }
    catch { return fail('INVALID_UTF8', '用户表格必须是有效 UTF-8 原字节。', 'parse'); }
    assertEvidence(record, text);
    const original = seal('original', material.envelope.mediaType, originalBytes);
    const originalManifestSha256 = userTableDigest({ objects: [{ byte_length: original.byteLength, media_type: original.mediaType, sha256: original.sha256 }] });
    const limits = materialLimits({ maxBytes: USER_TABLE_LIMITS.maxObjectBytes, maxRows: USER_TABLE_LIMITS.maxRows });
    const plan: UserTablePlan = deepFreeze(clone({ version: USER_TABLE_PIPELINE_VERSION, declaration, target, originalManifestSha256,
      implementationSha256: IMPLEMENTATION_SHA256, dependenciesSha256: DEPENDENCIES_SHA256, materialLimits: limits }));
    const planSha256 = userTableDigest(plan);
    let previous = originalManifestSha256;
    const execute = <T>(name: StepName, parameters: Record<string, JsonValue>, operation: () => T, diagnostics: string[]): T => {
      currentStep = name;
      const output = operation();
      const trace: UserTableStepExecution = { stepId: name, implementationVersion: `user-table-${name}/1`,
        implementationSha256: IMPLEMENTATION_SHA256, ruleVersion: `user-table-${name}-rules/1`, methodVersion: `user-table-${name}-method/1`,
        parameters: clone(parameters), runtime: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
          dependenciesSha256: DEPENDENCIES_SHA256 }, planSha256, inputSha256: previous, outputSha256: userTableDigest(output), output: json(output), diagnostics };
      traces.push(trace); previous = trace.outputSha256;
      return output;
    };
    const parsed = execute('parse', { format: material.preview.format, encoding: 'utf8-fatal', maxRows: 512, maxBytes: 1_048_576,
      headerLine: record.proposal.table?.headerLine ?? 1 },
    () => parseSemanticMaterialTable(text, material.preview.format, record.proposal, limits), ['实际调用材料解析器；保留原表头、单元格及原文坐标。']);
    const cleaned = execute('clean', { rulesVersion: record.proposal.rulesVersion, proposalId: record.envelope.proposalId,
      semanticRecordSha256: declaration.semanticRecordSha256 }, () => {
      const result = applySemanticTableCleaning(parsed, record.proposal, limits);
      if (result.questions.length || !result.table) fail('USER_TABLE_CLEANING_NOT_READY', '同一清洗规则重放仍有未解决问题，未继续加工。', 'clean');
      if (userTableDigest(result.table) !== userTableDigest(record.result.table) || userTableDigest(result.changes) !== userTableDigest(record.result.changes)) {
        fail('USER_TABLE_CLEANING_MISMATCH', '实际共享清洗程序的完整表格或变化与已采用记录不同。', 'clean');
      }
      return result;
    }, ['实际执行同一材料清洗纯函数，并核对完整已采用表格与变化；未另写清洗规则。']);
    const annotated = execute('annotate', { declarationSha256: userTableDigest(declaration), identity: 'single-explicit-user-instrument',
      observationSequence: 'provided_observations', historicalPublic: 'unknown' }, () => ({
      declaration, rows: cleaned.table!.rows.map((row, index) => {
        const value = (role: FieldRole): MaterialScalar | undefined => declaration.fieldMapping[role] === undefined ? undefined : row[declaration.fieldMapping[role]! - 1]!.applied;
        return { sourceRow: index + 1, instrument: declaration.fieldMapping.instrument === undefined ? declaration.instrument.symbol : value('instrument'),
          trade_date: value('trade_date'), open: value('open'), close: value('close'),
          ...(declaration.fieldMapping.high === undefined ? {} : { high: value('high') }),
          ...(declaration.fieldMapping.low === undefined ? {} : { low: value('low') }),
          ...(declaration.fieldMapping.volume === undefined ? {} : { volume: value('volume') }),
          available_at: declaration.fieldMapping.available_at === undefined ? declaration.uniformAvailableAt : value('available_at'),
          bar_closed: declaration.fieldMapping.bar_closed === undefined ? declaration.uniformBarClosed : value('bar_closed') };
      }),
    }), ['以已采用语义与真实消息标注单证券、市场及逐行时间；未用上传时刻补可得时刻。']);
    const checked = execute('check', { priceScale: '10000', volumeScale: '1', rowLimit: 512, exact: true, deduplicate: false,
      coverage: 'provided_observations', priceUnit: 'CNY/share', volumeUnit: 'shares' }, () => {
      const seen = new Set<string>(); let previousDay = '';
      const rows = annotated.rows.map(row => {
        if (row.instrument !== declaration.instrument.symbol) fail('USER_TABLE_INSTRUMENT_MISMATCH', '原件证券列与明确单证券声明不一致。', 'check');
        if (typeof row.trade_date !== 'string' || !calendarDay(row.trade_date)) fail('USER_TABLE_DATE_INVALID', '日期列须经已采用规则规范为有效 YYYY-MM-DD；不猜日期格式。', 'check');
        const day = row.trade_date;
        if (seen.has(day)) fail('USER_TABLE_DUPLICATE_DATE', '同一证券出现重复日期；未静默去重。', 'check');
        if (day <= previousDay) fail('USER_TABLE_DATE_ORDER', '当前观测须按日期严格递增；未静默排序或声称交易日连续。', 'check');
        seen.add(day); previousDay = day;
        const price = (value: unknown): number => {
          if (typeof value !== 'string') fail('USER_TABLE_PRICE_INVALID', '价格需要原件的明确非空十进制字面量。', 'check');
          try { const number = encodeWfdScaledInteger(value, '10000'); if (number <= 0) throw new RangeError(); return number; }
          catch { return fail('USER_TABLE_PRICE_PRECISION', '价格须为正值且能精确表示为四位定点安全整数；超精度、溢出或非十进制值均拒绝，不舍入。', 'check'); }
        };
        if (declaration.fieldMapping.volume !== undefined) {
          const volume = row.volume;
          if (typeof volume !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(volume) || !Number.isSafeInteger(Number(volume))) fail('USER_TABLE_VOLUME_INVALID', '已提供的成交量须为非负安全整数股；不换手数、不舍入。', 'check');
        }
        const numeric = { series_id: declaration.seriesId, timestamp: day, open: price(row.open), close: price(row.close),
          available_at: row.available_at as string, bar_closed: true };
        const high = declaration.fieldMapping.high === undefined ? undefined : price(row.high), low = declaration.fieldMapping.low === undefined ? undefined : price(row.low);
        if ((low !== undefined && high !== undefined && low > high) || (low !== undefined && (numeric.open < low || numeric.close < low))
          || (high !== undefined && (numeric.open > high || numeric.close > high))) fail('USER_TABLE_OHLC_INVALID', '已提供的开收盘与高低价格关系不成立。', 'check');
        if (!zonedInstant(row.available_at) || Date.parse(row.available_at as string) > Date.parse(declaration.asOf)
          || localDay(row.available_at as string, declaration.timezone) < day) fail('USER_TABLE_TIME_UNAVAILABLE', '逐行可得时刻须带时区、不早于该业务日且不晚于明确分析截止时刻。', 'check');
        if (row.bar_closed !== true && row.bar_closed !== 'true') fail('USER_TABLE_BAR_NOT_CLOSED', '逐行收盘状态必须明确为 true，不能从日线名称推定。', 'check');
        return numeric;
      });
      return { rows, coverage: { complete: true, gaps: [] as string[], description: '完整覆盖本次提供的有序观测；不证明交易日连续。' } };
    }, ['实际核对唯一日期、顺序、单证券、精确四位定点及逐行可得性；高低价和成交量只在已明确提供时核对，没有填值或单位换算。']);
    const tablePackage = execute('structure', { target: json(target), fields: [...OUTPUT_FIELDS], numericContract: 'wfd-table/v0.2',
      excludedSourceColumns: json(declaration.excludedSourceColumns) }, () => ({ entrypoint: '库说明.json', descriptor: {
      ...(target.descriptorSemantics as Record<string, JsonValue>), snapshot_id: null, row_count: checked.rows.length,
      coverage: checked.coverage,
      dependencies: { read: [], compute: [], regenerate: [original.sha256], audit: [original.sha256, declaration.semanticRecordSha256] },
    }, rows: checked.rows }), ['实际生成六字段 WFD 候选字节；声明直接采用冻结模式的语义原对象，原件、完整清洗及用户声明均在封闭证据中。']);
    seal('structured-result', 'application/json', Buffer.from(canonical(tablePackage)));
    const evidence = [
      seal('implementation', 'application/json', IMPLEMENTATION_BYTES), seal('dependencies', 'application/json', DEPENDENCY_BYTES),
      seal('semantic-record', 'application/json', Buffer.from(canonical(record))),
      seal('daily-declaration', 'application/json', Buffer.from(canonical(declaration))),
      ...traces.map(trace => seal(`step-${trace.stepId}`, 'application/json', Buffer.from(canonical(trace)))),
    ];
    // 预留包络、五步线记录和请求身份空间；真正发送时传输层还须核最终8MiB包络。
    if (Buffer.byteLength(canonical({ original, evidence, tablePackage })) + 131_072 > USER_TABLE_LIMITS.maxBundleBytes) fail('USER_TABLE_HANDOFF_BUDGET', '封闭对象及请求元信息超过首包 8 MiB 上限，未交接。', 'structure');
    return { state: 'succeeded', plan, declaration, traces, tablePackage: json(tablePackage), original, evidence };
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown; stepId?: unknown };
    return { state: 'failed', traces, failure: { stepId: error instanceof UserTablePipelineError ? error.stepId : currentStep,
      code: typeof e.code === 'string' ? e.code : 'USER_TABLE_PROCESSING_FAILED',
      message: typeof e.message === 'string' ? e.message : '受控用户表格加工失败，未继续交接。' } };
  }
}

function assertRecord(material: MaterialRecord, record: MaterialSemanticRecord): void {
  if (!record || record.envelope.materialId !== material.envelope.materialId || record.proposal.materialId !== material.envelope.materialId
    || record.envelope.originalSha256 !== material.envelope.sha256 || record.proposal.originalSha256 !== material.envelope.sha256
    || !SHA.test(material.envelope.sha256) || !['csv', 'json-table'].includes(material.preview.format)
    || record.result.status !== 'processed' || record.result.applied !== true || record.result.classification.category !== 'data'
    || !record.result.table || record.result.questions.length || record.result.originalPreserved !== true
    || userTableDigest(record.result.adoptedKnown) !== userTableDigest(record.proposal.judgments.filter(j => j.status === 'known'))) {
    fail('USER_TABLE_SEMANTICS_NOT_READY', '需要同一原件已经持久化采用、无待确认问题的真实表格语义及清洗记录。');
  }
  if (!record.origin?.conversationId || !record.origin.branchId || !record.origin.parentRunId || !record.origin.messageId) fail('USER_TABLE_ORIGIN_MISSING', '缺少真实同会话、分支及运行来源。');
}
function assertEvidence(record: MaterialSemanticRecord, original: string): void {
  const messages = new Map(record.origin.userMessages.map(m => [m.id, m.text]));
  const verify = (e: SemanticEvidence): boolean => {
    const source = e.source === 'original' ? original : messages.get(e.messageId);
    return typeof source === 'string' && typeof e.start === 'number' && typeof e.end === 'number' && e.start >= 0
      && e.end > e.start && e.end <= source.length && source.slice(e.start, e.end) === e.quote;
  };
  for (const j of record.result.adoptedKnown) if (!j.evidence.length || j.evidence.some(e => !verify(e))) fail('USER_TABLE_EVIDENCE_MISMATCH', '已采用语义缺少真实且精确匹配的原文或用户消息证据。');
}
function validateTarget(target: UserTableTarget, synthetic: boolean): void {
  if (!target || (['datasetId', 'mappingVersion', 'unitId', 'outputId', 'definitionRevision', 'schemaRevision'] as const).some(key => !IDENTIFIER.test(target[key]))
    || target.contractVersion !== 'wfd-table/v0.2' || !SHA.test(target.schemaSha256) || !['analysis', 'user_test'].includes(target.purpose)
    || typeof target.dataKind !== 'string' || !target.dataKind.trim() || (!synthetic && target.dataKind === 'synthetic')) fail('USER_TABLE_TARGET_INVALID', '候选必须使用宿主冻结的明确目标、模式摘要及分析用途，真实用户原件不能标为合成。');
  const semantics = target.descriptorSemantics;
  if (!isWfdRecord(semantics) || !SHA.test(target.semanticsSha256) || userTableDigest(semantics) !== target.semanticsSha256
    || semantics.contract_version !== target.contractVersion || semantics.unit_id !== target.unitId || semantics.output_id !== target.outputId
    || semantics.definition_rev !== target.definitionRevision || semantics.schema_rev !== target.schemaRevision || semantics.data_kind !== target.dataKind
    || !Array.isArray(semantics.fields) || !isWfdRecord(semantics.codebooks) || Object.keys(semantics.codebooks).length
    || userTableDigest(semantics.fields.map(field => isWfdRecord(field) ? field.name : null)) !== userTableDigest(OUTPUT_FIELDS)
    || userTableDigest(semantics.primary_key) !== userTableDigest(['series_id', 'timestamp'])
    || userTableDigest(semantics.allowed_purposes) !== userTableDigest([target.purpose])) fail('USER_TABLE_TARGET_INVALID', '需要冻结的六字段声明语义及其原摘要，不能推造字段或词表。');
}
function seal(name: string, mediaType: string, bytes: Uint8Array): SealedCollectionObject {
  if (!bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) fail('USER_TABLE_OBJECT_LIMIT', `${name} 对象为空或超过 1 MiB；未截断证据。`);
  return { name, mediaType, sha256: sha(bytes), byteLength: bytes.byteLength, bytesBase64: Buffer.from(bytes).toString('base64') };
}
function calendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  return year! >= 1 && month! >= 1 && month! <= 12 && day! >= 1 && day! <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1]!;
}
function zonedInstant(value: unknown): value is string {
  return typeof value === 'string' && calendarDay(value.slice(0, 10))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
}
function localDay(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
function questionsFor(dimensions: string[]): string[] {
  const result: string[] = [];
  if (dimensions.some(d => d.startsWith('field:'))) result.push('请明确原表中日期、开盘、收盘及已有时间／收盘状态列分别是哪一列；有冲突的字段需先确定。');
  if (dimensions.some(d => ['instrument', 'market'].includes(d))) result.push('请明确这整份表唯一的证券代码及所属市场。');
  if (dimensions.some(d => ['currency', 'price_unit', 'frequency', 'adjustment', 'observation_sequence'].includes(d))) result.push('请确认这份表为人民币每股价格的未复权日线；仅按当前提供的有序观测回顾分析，不代表交易日连续。');
  if (dimensions.includes('volume_unit')) result.push('原件已明确映射成交量列，请确认其单位为股；成交量不作为这两个算法的必需输入。');
  if (dimensions.some(d => ['timezone', 'as_of', 'available_at', 'bar_closed'].includes(d))) result.push('请明确时区与带时区的分析截止时刻；若原件没有逐行可得时刻或收盘列，请明确整表所有行的可得时刻及是否均已收盘，不能用上传时刻代替。');
  return result;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}

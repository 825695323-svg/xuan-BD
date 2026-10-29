import { readFileSync } from 'node:fs';
import { decodePublicDailyBars } from '../../plugins/api-sources/public-kline.js';
import { encodeWfdScaledInteger } from '../../adapters/database/wfd-table.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { SealedCollectionObject } from './handoff.js';
import type { CompletedDailyPipeline } from './user-cycle-port.js';
import { USER_TABLE_LIMITS, userTableDigest, type UserTableStepExecution, type UserTableTarget } from './user-table-pipeline.js';

export const API_DAILY_PIPELINE_VERSION = 'api-daily-six-field/1';
export interface ApiDailySource {
  taskId: string; fileRefId: string; providerId: 'tencent' | 'eastmoney'; connectionId: string;
  configurationDigest: string; rawSha256: string; observedAt: string;
  request: { symbol: string; start: string; end: string; adjustment: 'none' };
  receipt: JsonValue;
}
export interface ApiDailyPipeline extends CompletedDailyPipeline {
  declaration: CompletedDailyPipeline['declaration'] & {
    version: string; acquisition: 'api_fetched'; source: ApiDailySource;
    admission: 'user_authorized_test_submission'; availabilityBasis: 'observed_at';
    historicalEligibility: 'not_established'; authenticity: 'not_verified';
    currency: 'CNY'; priceUnit: 'currency_per_share'; frequency: '1d'; adjustment: 'none';
    timezone: 'Asia/Shanghai'; requestedWindow: { start: string; end: string };
  };
}
const json = (value: unknown): JsonValue => JSON.parse(canonicalWfdJson(value)) as JsonValue;
const day = (value: string): string => /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
const calendarDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function fail(message: string): never { throw new Error(`API_DAILY_INVALID: ${message}`); }
function seal(name: string, bytes: Uint8Array, mediaType = 'application/json'): SealedCollectionObject {
  if (!bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) fail('交接对象为空或超过 1 MiB。');
  return { name, mediaType, sha256: wfdSha256(bytes), byteLength: bytes.byteLength, bytesBase64: Buffer.from(bytes).toString('base64') };
}

/** 只处理已保留的真实接口原件；不下载、不提交、不构造用户附件或模型语义记录。 */
export function runApiDailyPipeline(input: { originalBytes: Uint8Array; source: ApiDailySource; target: UserTableTarget }): ApiDailyPipeline {
  const source = structuredClone(input.source), target = structuredClone(input.target);
  const start = day(source.request.start), end = day(source.request.end);
  if (!calendarDay(start) || !calendarDay(end) || start > end || Date.parse(end) - Date.parse(start) > 9 * 86_400_000) fail('窗口须为明确且不超过十个自然日。');
  if (!/^(?:\d{6}\.(?:SZ|SH)|(?:sz|sh)\d{6})$/u.test(source.request.symbol) || source.request.adjustment !== 'none'
    || !['tencent', 'eastmoney'].includes(source.providerId) || !source.taskId || !source.fileRefId || !source.connectionId || !source.configurationDigest
    || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(source.observedAt) || !Number.isFinite(Date.parse(source.observedAt))) fail('来源身份、口径和实际观察时刻必须明确。');
  const original = seal('api-original-response', input.originalBytes);
  if (original.sha256 !== source.rawSha256) fail('原件与来源回执摘要不一致。');
  const semantics = target.descriptorSemantics;
  if (target.purpose !== 'user_test' || target.dataKind !== 'user_submitted' || target.contractVersion !== 'wfd-table/v0.2'
    || !isWfdRecord(semantics) || userTableDigest(semantics) !== target.semanticsSha256
    || semantics.unit_id !== target.unitId || semantics.output_id !== target.outputId || semantics.definition_rev !== target.definitionRevision
    || semantics.schema_rev !== target.schemaRevision || semantics.data_kind !== target.dataKind
    || canonicalWfdJson(semantics.allowed_purposes) !== '["user_test"]' || !Array.isArray(semantics.fields)
    || canonicalWfdJson(semantics.fields.map(field => isWfdRecord(field) ? field.name : null)) !== '["series_id","timestamp","open","close","available_at","bar_closed"]') fail('需要数据库实际登记的用户测试六列目标。');
  const declaration: ApiDailyPipeline['declaration'] = { version: API_DAILY_PIPELINE_VERSION, originalSha256: original.sha256,
    acquisition: 'api_fetched', admission: 'user_authorized_test_submission', source, useMode: 'analysis',
    availabilityBasis: 'observed_at', historicalEligibility: 'not_established', authenticity: 'not_verified',
    currency: 'CNY', priceUnit: 'currency_per_share', frequency: '1d', adjustment: 'none', timezone: 'Asia/Shanghai', requestedWindow: { start, end } };
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const implementation = Buffer.from(canonicalWfdJson({ version: API_DAILY_PIPELINE_VERSION, files: [
    `./api-daily-pipeline.${extension}`, `../../plugins/api-sources/public-kline.${extension}`, `../../adapters/database/wfd-table.${extension}`,
    `../../adapters/database/wfd-transport.${extension}`, `./user-table-pipeline.${extension}`,
  ].map(path => ({ path, bytes_base64: readFileSync(new URL(path, import.meta.url)).toString('base64') })) }));
  const dependencies = Buffer.from(canonicalWfdJson({ version: 'api-daily-dependencies/1', node: process.versions.node, platform: process.platform,
    arch: process.arch, packageLockSha256: wfdSha256(readFileSync(new URL('../../package-lock.json', import.meta.url))) }));
  const implementationSha256 = wfdSha256(implementation), dependenciesSha256 = wfdSha256(dependencies);
  const plan = { version: API_DAILY_PIPELINE_VERSION, target, declaration, implementationSha256, dependenciesSha256,
    originalManifestSha256: userTableDigest({ objects: [{ byte_length: original.byteLength, media_type: original.mediaType, sha256: original.sha256 }] }) };
  const traces: UserTableStepExecution[] = []; let previous = plan.originalManifestSha256;
  const execute = <T>(stepId: UserTableStepExecution['stepId'], parameters: Record<string, JsonValue>, operation: () => T, diagnostics: string[]): T => {
    const output = operation();
    const trace: UserTableStepExecution = { stepId, implementationVersion: `api-daily-${stepId}/1`, implementationSha256,
      ruleVersion: `api-daily-${stepId}-rules/1`, methodVersion: `api-daily-${stepId}-method/1`, parameters,
      runtime: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, dependenciesSha256 },
      planSha256: userTableDigest(plan), inputSha256: previous, outputSha256: userTableDigest(output), output: json(output), diagnostics };
    traces.push(trace); previous = trace.outputSha256; return output;
  };
  const parsed = execute('parse', { providerId: source.providerId, request: json(source.request), rawSha256: original.sha256 },
    () => decodePublicDailyBars(source.providerId, source.request, input.originalBytes), ['按供应商响应合同解码原件；证券、复权分支、日期和业务状态由程序核对。']);
  const cleaned = execute('clean', { policy: 'preserve-decimal-values/no-imputation/no-sort/no-deduplication/1' },
    () => structuredClone(parsed.rows), ['保留解码价格原值；不补值、不舍入、不重排、不静默去重。']);
  const annotated = execute('annotate', { declarationSha256: userTableDigest(declaration), observedAt: source.observedAt,
    availabilityBasis: 'observed_at', historicalEligibility: 'not_established' }, () => cleaned.map((row, index) => ({ ...row, sourceRow: index + 1,
    available_at: source.observedAt, availabilityBasis: 'observed_at', barClosedBasis: 'A-share-daily-market-close-before-observation',
    historicalEligibility: 'not_established' })), ['本次取得时刻只支持本次观察可得性；不追认历史公开时刻。']);
  const checked = execute('check', { maxNaturalDays: 10, priceScale: '10000', coverage: 'returned-observations-only' }, () => {
    if (!annotated.length || annotated.length > 10) fail('十日窗口必须含 1 至 10 条原始日线记录。');
    let previousDay = '';
    const price = (value: string) => { const number = encodeWfdScaledInteger(value, '10000'); if (number <= 0) fail('价格必须为正且精确到四位定点。'); return number; };
    const rows = annotated.map(row => {
      const date = row.trade_date;
      if (!calendarDay(date) || date < start || date > end || date <= previousDay) fail('日期越窗、重复或不递增。');
      previousDay = date;
      if (Date.parse(`${date}T15:00:00+08:00`) > Date.parse(source.observedAt)) fail('日线尚未到本市场收盘时刻。');
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) fail('A股日线返回周末业务日期，须核查原件。');
      const open = price(row.open), close = price(row.close), high = price(row.high), low = price(row.low);
      if (low > high || open < low || close < low || open > high || close > high) fail('开收盘与高低价格不一致。');
      const normalized = row.symbol.match(/^(sz|sh)(\d{6})$/u);
      const symbol = normalized ? `${normalized[2]}.${normalized[1]!.toUpperCase()}` : row.symbol;
      return { series_id: `CN_A_STOCK:${symbol}`, timestamp: date, open, close, available_at: source.observedAt, bar_closed: true };
    });
    return { rows, coverage: { complete: true, gaps: [], description: `完整保留本次接口返回观测，范围${start}至${end}；未认证交易日连续性、市场完整性或历史可得性。` } };
  }, ['检查十日边界、唯一顺序、精确价格、高低关系及观察时点已收盘；仅对实际返回观测负责。']);
  const tablePackage = execute('structure', { target: json(target), fields: ['series_id', 'timestamp', 'open', 'close', 'available_at', 'bar_closed'] }, () => ({
    entrypoint: '库说明.json', descriptor: { ...semantics, snapshot_id: null, row_count: checked.rows.length, coverage: checked.coverage,
      dependencies: { read: [], compute: [], regenerate: [original.sha256], audit: [original.sha256, userTableDigest(declaration)] } }, rows: checked.rows,
  }), ['输出采用数据库冻结的字段和单位合同；原始高低、量额和完整响应仍保管于原件及加工证据。']);
  const evidence = [seal('implementation', implementation), seal('dependencies', dependencies),
    seal('api-source-receipt', Buffer.from(canonicalWfdJson(source.receipt))), seal('api-declaration', Buffer.from(canonicalWfdJson(declaration))),
    ...traces.map(trace => seal(`step-${trace.stepId}`, Buffer.from(canonicalWfdJson(trace))))];
  return { state: 'succeeded', plan, declaration, traces, tablePackage: json(tablePackage), original, evidence };
}

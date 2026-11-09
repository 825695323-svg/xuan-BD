import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { parseTableSource } from './candidate-pipeline.js';
import type { FrozenAdapterBinding } from './endpoint-adapter.js';
import { sourceReportedDate, sourceReportedMinute } from './source-reported-table.js';

export const R1_ALGORITHM_ROUTING_VERSION = 'bd.r1-algorithm-routing/1';
export type R1BarKind = 'daily_bar' | 'minute_bar';
export type R1AlgorithmDataKind = R1BarKind | 'sentiment' | 'mixed' | 'other' | 'unknown';
export interface R1AlgorithmSettings { revision: number; dailyPeriod: number | null; minutePeriod: number | null }
export interface R1AlgorithmClassification {
  version: typeof R1_ALGORITHM_ROUTING_VERSION;
  sha256: string; byteLength: number; kind: R1AlgorithmDataKind; complete: boolean;
  format: 'csv' | 'json' | null; columns: string[]; rowCount: number;
  dateColumn: string | null; minuteColumn: string | null; valueColumn: string | null;
  /** 预检实际使用的已采用适配身份与其声明的语义；未使用适配时缺省或为 null。 */
  adapter?: { adapterId: string; version: string; configDigest: string; frequency: string; adjustment: string;
    market: string | null } | null;
  code: string; reason: string;
}
export interface R1BatchAlgorithmRouting {
  version: typeof R1_ALGORITHM_ROUTING_VERSION; settings: R1AlgorithmSettings;
  files: R1AlgorithmClassification[];
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const ownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const kinds = ['daily_bar', 'minute_bar', 'sentiment', 'mixed', 'other', 'unknown'];
const dateHeader = /^(?:交易日期|日期|trade_date|date)$/iu;
const minuteHeader = /^(?:分钟时间|分钟标签|minute_time|minute_timestamp)$/iu;
const identityHeader = /^(?:(?:股票|证券|标的|合约|对象)代码|stock_code|security_code|instrument_id|symbol|code)$/iu;
const closeHeader = /^(?:收盘价?|close)(?:[（(][^()（）]+[）)])?$/iu;
const reportHeader = /(?:榜单|板单|情绪|热度|恐慌|贪婪|封单|封板|连板|连扳|炸板|涨停时间|跌停时间|资金流|净流入|净流出|主力资金|舆情|sentiment|ranking|rank_type)/iu;
const barFieldHeader = /^(?:交易日期|日期|trade_date|date|分钟时间|分钟标签|minute_time|minute_timestamp|(?:股票|证券|标的|合约|对象)代码|stock_code|security_code|instrument_id|symbol|code|TS代码|(?:股票|证券|标的|合约|对象)?名称|name|序号|(?:开盘|最高|最低|收盘|昨收)(?:价)?|涨跌额|涨跌幅|成交量|成交额|复权因子|换手率|量比|市盈率|市净率|市销率|股息率|总股本|流通股本|自由流通股本|总市值|流通市值|open|high|low|close|pre_close|volume|amount|adj_factor)(?:[（(][^\r\n]*[）)])?$/iu;
const reportValue = /涨停池|跌停池|连板池|连扳池|炸板池|涨跌停榜|市场情绪|资金流向/iu;
const numeric = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
export function r1AlgorithmPeriod(settings: R1AlgorithmSettings, kind: R1AlgorithmDataKind): number | null {
  return kind === 'daily_bar' ? settings.dailyPeriod : kind === 'minute_bar' ? settings.minutePeriod : null;
}
export function readR1AlgorithmSettings(value: unknown): R1AlgorithmSettings {
  if (!isWfdRecord(value) || !ownKeys(value, ['revision', 'dailyPeriod', 'minutePeriod'])
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || [value.dailyPeriod, value.minutePeriod].some(period => period !== null && (!Number.isSafeInteger(period) || Number(period) < 2 || Number(period) > 1000)))
    return fail('R1_ALGORITHM_SETTINGS', '日K和分钟K分别设置 2 至 1000 的整数观测周期；未设置须明确为 null（空值）。');
  return { revision: Number(value.revision), dailyPeriod: value.dailyPeriod as number | null, minutePeriod: value.minutePeriod as number | null };
}

/** Complete original bytes are parsed; filenames, selected value columns and client hints cannot choose an algorithm. */
export function classifyR1AlgorithmInput(bytes: Buffer, options?: { sourceAdapter?: FrozenAdapterBinding }): R1AlgorithmClassification {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024)
    return fail('R1_ALGORITHM_ORIGINAL_BUDGET', '算法预检需要 25 MiB 内非空完整原件；超限文件未预检、保管或计算。');
  const adapter = options?.sourceAdapter ?? null;
  const result: R1AlgorithmClassification = { version: R1_ALGORITHM_ROUTING_VERSION, sha256: wfdSha256(bytes), byteLength: bytes.length,
    kind: 'unknown', complete: false, format: null, columns: [], rowCount: 0, dateColumn: null, minuteColumn: null,
    valueColumn: null, adapter: adapter ? { adapterId: adapter.adapterId, version: adapter.version, configDigest: adapter.configDigest,
      frequency: adapter.config.match.frequency, adjustment: adapter.config.match.adjustment,
      market: adapter.config.match.market ?? null } : null,
    code: 'R1_ALGORITHM_UNKNOWN', reason: '内容证据不足，未选择算法。' };
  const done = (kind: R1AlgorithmDataKind, code: string, reason: string): R1AlgorithmClassification => ({ ...result, kind, code, reason: reason.slice(0, 4096) });
  if (bytes.length > 8 * 1024 * 1024) return done('unknown', 'R1_AUTO_BYTE_BUDGET', '原件超过自动交接的 8 MiB 审查预算；未截取内容或选择算法。');
  try {
    if (adapter) result.format = 'json';
    else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      result.format = /^[\s]*[\[{]/u.test(text) ? 'json' : 'csv';
    }
    const parsed = parseTableSource(bytes, { materialId: 'algorithm-preflight', format: result.format!,
      ...(adapter ? { sourceAdapter: adapter } : {}) });
    result.columns = [...parsed.source_columns]; result.rowCount = parsed.total_rows;
    if (result.columns.some(column => column.length > 256)) {
      result.columns = [];
      return done('unknown', 'R1_ALGORITHM_FIELDS', '原列名超过自动路由的 256 字符范围，未选择算法；需要明确字段处理。');
    }
    if (parsed.total_rows > 5000) return done('unknown', 'R1_AUTO_ROW_BUDGET', '完整表超过单次自动交接的 5000 行预算；未截取成可计算数据。');
    // 适配声明的频率是语义声明，优先于"列看起来像日线"；event/other 不能取得日线或分钟算法用途。
    const declaredFrequency = adapter?.config.match.frequency;
    if (declaredFrequency === 'event' || declaredFrequency === 'other')
      return { ...done('other', 'R1_ALGORITHM_ADAPTER_FREQUENCY',
        `已采用适配声明该端点频率为 ${declaredFrequency}；即使含日期与收盘列，也不取得日线/分钟算法用途。`), complete: true };
    result.complete = true;
    const columns = parsed.columns, values = (column: string) => parsed.rows.map(row => row[columns.indexOf(column)]!.original);
    const closes = columns.filter(column => closeHeader.test(column));
    const reportColumns = columns.filter(column => reportHeader.test(column));
    const reportDeclarations = columns.filter(column => /(?:类型|类别|type|semantic_code|表题|表名)$/iu.test(column));
    const report = !!reportColumns.length || reportDeclarations.some(column => values(column).some(value => reportValue.test(String(value ?? ''))));
    if (report) return done(closes.length ? 'mixed' : 'sentiment', 'R1_ALGORITHM_REPORT_CONTEXT',
      `完整原表包含榜单、情绪或资金流等报告维度${reportColumns.length ? '「' + reportColumns.join('、') + '」' : ''}；附带价格列仍按报告性质保留，未选择均线。`);
    if (!closes.length) return done('other', 'R1_ALGORITHM_NO_BAR_EVIDENCE', '原表没有明确收盘数值列，保留原数据交接；当前没有匹配的算法。');
    if (closes.length !== 1) return done('mixed', 'R1_ALGORITHM_AMBIGUOUS_CLOSE', '原表有多个收盘口径，未选择其中一个或跨口径计算。');
    const unclassified = columns.filter(column => !barFieldHeader.test(column));
    if (unclassified.length) return done('mixed', 'R1_ALGORITHM_UNCLASSIFIED_DIMENSIONS',
      `原表除价格外还有尚未核定为普通行情字段的「${unclassified.join('、')}」；未把混合维度默认为日K或分钟K。`);
    const dates = columns.filter(column => dateHeader.test(column)), identities = columns.filter(column => identityHeader.test(column));
    const minutes = columns.filter(column => minuteHeader.test(column));
    if (declaredFrequency === 'minute' && !minutes.length)
      return done('unknown', 'R1_ALGORITHM_MINUTE', '适配声明频率为分钟，但原表没有明确分钟标签列；未降级成日线。');
    if (declaredFrequency === 'day' && minutes.length)
      return done('mixed', 'R1_ALGORITHM_FREQUENCY_CONFLICT', '适配声明为日线，原表却含分钟标签列；未把两种频率并入同一系列。');
    if (dates.length !== 1 || identities.length !== 1 || minutes.length > 1)
      return done('unknown', 'R1_ALGORITHM_IDENTITY', '行情算法需要单一明确原报日期、对象代码和至多一个分钟标签列；当前证据仍有歧义。');
    result.dateColumn = dates[0]!; result.valueColumn = closes[0]!; result.minuteColumn = minutes[0] ?? null;
    const dateValues = values(result.dateColumn);
    const encoding = dateValues.every(value => sourceReportedDate(value, 'yyyymmdd')) ? 'yyyymmdd'
      : dateValues.every(value => sourceReportedDate(value, 'iso-date')) ? 'iso-date' : null;
    if (!encoding) return done('unknown', 'R1_ALGORITHM_DATE', '完整原表含无效、缺失或混合编码日期；未从文件名或相邻行补日期。');
    const prices = values(result.valueColumn), nonemptyPrices = prices.filter(value => value !== null && value !== '');
    if (!nonemptyPrices.length || nonemptyPrices.some(value => !numeric.test(String(value))))
      return done('unknown', 'R1_ALGORITHM_VALUE', '原收盘列尚不能完整核为精确十进制观测或明确空值；未选择均线。');
    const symbols = values(identities[0]!);
    if (symbols.some(value => value === null || value === '')) return done('unknown', 'R1_ALGORITHM_IDENTITY', '原对象代码存在空值，不能按对象计算。');
    if (!result.minuteColumn && columns.some(column => /(?:时间|timestamp|datetime|(?:^|_)time)$/iu.test(column)))
      return done('unknown', 'R1_ALGORITHM_TIME_GRAIN', '原表还有未识别的时间维度，不能按日K合并。');
    const labels = result.minuteColumn ? values(result.minuteColumn).map(value => sourceReportedMinute(value)) : dateValues.map(value => sourceReportedDate(value, encoding));
    if (labels.some((label, index) => !label || result.minuteColumn && label.slice(0, 10) !== sourceReportedDate(dateValues[index], encoding)))
      return done('unknown', 'R1_ALGORITHM_MINUTE', '分钟标签须逐行有效、秒为 00 且与原交易日期一致；未推定时区或修订标签。');
    if (new Set(labels.map((label, index) => canonicalWfdJson([symbols[index], label]))).size !== parsed.total_rows)
      return done('unknown', 'R1_ALGORITHM_DUPLICATE', '原日期或分钟标签与对象代码不能唯一定位本表观测，未以行号或上传顺序代替身份。');
    return done(result.minuteColumn ? 'minute_bar' : 'daily_bar', 'R1_ALGORITHM_BAR_OBSERVATIONS',
      `已核完整原表 ${parsed.total_rows} 行的对象、${result.minuteColumn ? '日期及分钟' : '日期'}标签和收盘原值；只匹配原报${result.minuteColumn ? '分钟' : '日'}标签观察窗，交易时段完整性、复权与历史可得性仍未知。`
      + (adapter ? ` 适配声明频率 ${adapter.config.match.frequency}、复权 ${adapter.config.match.adjustment}；声明未经独立复核。` : ''));
  } catch (error) {
    return done('unknown', error instanceof TaskError ? error.code : 'R1_ALGORITHM_PARSE',
      `原件未完成受支持表格的完整预检：${error instanceof Error ? error.message : String(error)}。原件未被认定为可计算数据。`);
  }
}

export function readR1BatchAlgorithmRouting(value: unknown): R1BatchAlgorithmRouting {  if (!isWfdRecord(value) || !ownKeys(value, ['version', 'settings', 'files']) || value.version !== R1_ALGORITHM_ROUTING_VERSION
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 100) return fail('R1_ALGORITHM_ROUTING', '批次算法路由需要当前版本、已保存周期和逐件完整内容预检。');
  const settings = readR1AlgorithmSettings(value.settings);
  const files = value.files.map(raw => {
    if (!isWfdRecord(raw) || !ownKeys(raw, ['version', 'sha256', 'byteLength', 'kind', 'complete', 'format', 'columns', 'rowCount', 'dateColumn', 'minuteColumn', 'valueColumn', 'adapter', 'code', 'reason'])
      || raw.version !== R1_ALGORITHM_ROUTING_VERSION || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)
      || !Number.isSafeInteger(raw.byteLength) || Number(raw.byteLength) < 1 || Number(raw.byteLength) > 25 * 1024 * 1024
      || !kinds.includes(String(raw.kind)) || typeof raw.complete !== 'boolean' || ![null, 'csv', 'json'].includes(raw.format as string | null)
      || !Array.isArray(raw.columns) || raw.columns.length > 256 || raw.columns.some(column => typeof column !== 'string' || !column || column.length > 256)
      || !Number.isSafeInteger(raw.rowCount) || Number(raw.rowCount) < 0 || Number(raw.rowCount) > 100000
      || ['dateColumn', 'minuteColumn', 'valueColumn'].some(key => raw[key] !== null && (typeof raw[key] !== 'string' || !(raw.columns as unknown[]).includes(raw[key])))
      || !isAdapterIdentity(raw.adapter)
      || typeof raw.code !== 'string' || raw.code.length > 128 || typeof raw.reason !== 'string' || raw.reason.length > 4096)
      return fail('R1_ALGORITHM_ROUTING', '逐件算法预检形态无效，不能提供自定义算法或覆盖权限。');
    if (['daily_bar', 'minute_bar'].includes(String(raw.kind)) && (!raw.complete || !raw.dateColumn || !raw.valueColumn || raw.kind === 'minute_bar' && !raw.minuteColumn))
      return fail('R1_ALGORITHM_ROUTING', '行情算法须绑定已完成全表核对的日期、收盘列及相应分钟标签。');
    return structuredClone(raw) as unknown as R1AlgorithmClassification;
  });
  if (new Set(files.map(file => file.sha256)).size !== files.length) return fail('R1_ALGORITHM_ROUTING', '相同摘要只保留一份内容预检，不能提供冲突分类。');
  return { version: R1_ALGORITHM_ROUTING_VERSION, settings, files };
}

function isAdapterIdentity(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isWfdRecord(value) || !ownKeys(value, ['adapterId', 'version', 'configDigest', 'frequency', 'adjustment', 'market'])) return false;
  return typeof value.adapterId === 'string' && /^[a-z0-9][a-z0-9._-]{2,99}$/u.test(value.adapterId)
    && typeof value.version === 'string' && /^[0-9]{1,4}$/u.test(value.version)
    && typeof value.configDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.configDigest)
    && ['day', 'minute', 'event', 'other'].includes(String(value.frequency))
    && ['none', 'qfq', 'hfq', 'unknown'].includes(String(value.adjustment))
    && (value.market === null || typeof value.market === 'string');
}

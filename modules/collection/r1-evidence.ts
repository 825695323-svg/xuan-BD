import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1PrepareInput, R1SourceDeclaration, R1TabularMapping } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { parseTableSource, type ParsedCandidateTable } from './candidate-pipeline.js';
import { projectSourceReportedTable, sourceReportedCode, sourceReportedDate, sourceReportedMinute, SOURCE_REPORT_COLUMNS,
  SOURCE_REPORTED_MINUTE_HEADER, type CandidateSourceProjection } from './source-reported-table.js';
import type { MaterialRecord } from './materials/contracts.js';
import type { XlsxTableSelection } from './data-processing/xlsx-table.js';
import type { DimensionKey } from './processing-routing.js';
import { adapterColumnType, type FrozenAdapterBinding } from './endpoint-adapter.js';
import type { FrozenSourceFieldProfile } from './source-field-profile.js';

type ValueType = 'decimal' | 'integer' | 'boolean' | 'text';
export interface R1EvidenceQuestion { key: string; label: string; options?: string[] }
export interface R1EvidenceFact { key: string; value: string; origin: 'file' | 'operator' | 'contract'; column?: string; field?: string; quote?: string }
export interface R1EvidenceProposal {
  target: R1PrepareInput['target']; mapping: R1TabularMapping;
  types: Record<string, 'string' | 'decimal_string' | 'boolean'>;
  dimensions: Record<DimensionKey, string>; format: 'csv' | 'json' | 'xlsx';
  annotations?: Record<string, string>; emptyToNull?: string[]; xlsxSelection?: XlsxTableSelection;
  sourceProjection?: CandidateSourceProjection;
  /** 预检实际使用的已采用适配身份；计划须冻结同一配置。 */
  sourceAdapter?: FrozenAdapterBinding;
}
export interface R1EvidenceResult {
  questions: R1EvidenceQuestion[]; columns: string[]; evidence: R1EvidenceFact[]; proposal?: R1EvidenceProposal;
  sourceFamilyHint?: { semanticCode: string; subjectId: string };
}
const types: ValueType[] = ['text', 'decimal', 'integer', 'boolean'];
// Evidence for treating a source blank as null. The downstream R1 gate still validates every value/state pair.
const missingStates = new Set(['unknown', 'not_reported', 'not_collected', 'out_of_coverage', 'not_applicable',
  'not_yet_effective', 'not_matured', 'insufficient_warmup', 'source_conflict']);
const measurement = ['stock', 'flow', 'event', 'mixed_observation', 'relation'];
const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const unknown = /^(?:unknown|unspecified|待核|未知|不确定|待确认)$/iu;
const fail = (message: string): never => { throw new TaskError('R1_AUTO_EVIDENCE', message); };

/** A bd.* column is data from the source. It can describe values, never grant authority or choose a connection. */
export function resolveR1Evidence(input: {
  material: MaterialRecord; original: Uint8Array; answers: Record<string, string>;
  namespace: string; datasetId: string; parentSnapshotId: string | null; xlsxSelection?: XlsxTableSelection;
  source?: R1SourceDeclaration; sourceValueColumns?: string[];
  registeredKeyColumns?: string[]; registeredUnits?: Record<string,string>;
  registeredTypes?: Record<string,ValueType>;
  registeredSourceDefinition?: WfdRecord;
  /** 已采用端点适配的冻结配置；只由宿主按引用解析，请求正文不能自报。 */
  sourceAdapter?: FrozenAdapterBinding;
  /** BD 来源字段档案的冻结版本：原表头 → 标准字段/类型/单位，由宿主按来源系列选定。 */
  sourceFieldProfile?: FrozenSourceFieldProfile;
  /** Set only by the host after binding bytes to its own completed computation. */
  calculatedMaterial?: boolean;
}): R1EvidenceResult {
  const { envelope, preview } = input.material;
  if (envelope.category === 'tool') fail('工具原件已保管，不能作为数据自动交接。');
  const format = input.sourceAdapter ? 'json' : preview.format === 'csv' ? 'csv' : preview.format === 'json-table' ? 'json'
    : preview.format === 'excel' && input.xlsxSelection ? 'xlsx' : undefined;
  if (!format) return fail('原件已保管。自动交接需要 CSV、行对象 JSON 或已明确选区的 XLSX，当前缺少对应的结构化数据或选区。');
  if (input.original.length > 8 * 1024 * 1024 || !input.original.length) fail('自动审查每次接受不超过 8 MiB 的非空材料，请明确选件。');
  if (wfdSha256(input.original) !== envelope.sha256) fail('保管原件内容与登记摘要不同。');
  const parsed = parseTableSource(input.original, { materialId: envelope.materialId, format,
    ...(input.sourceAdapter ? { sourceAdapter: input.sourceAdapter } : {}), ...(input.xlsxSelection ? { xlsxSelection: input.xlsxSelection } : {}) });
  if (!parsed.total_rows || parsed.total_rows > 5000) fail('单次交接需要 1 至 5,000 条实际数据行。');
  // A source may already export a single metric with an inline data dictionary.
  // Identify the row layout independently of optional evidence, so a missing unit asks for just the unit.
  const dictionary = ['semantic_code', 'subject_id', 'subject_kind', 'frequency', 'precision', 'timezone',
    'period_type', 'field_code', 'data_type', 'unit_code', 'measurement_nature'];
  const dictionaryTable = ['semantic_code', 'field_code', 'subject_id', 'business_key', 'start_utc', 'end_utc', 'value']
    .every(name => parsed.columns.includes(name));
  if (!dictionaryTable && !parsed.columns.some(name => name.startsWith('bd.'))) return resolveSourceReport(input, parsed, format);
  if (input.sourceValueColumns !== undefined) fail('显式来源选列只适用于来源原报普通表；不能静默裁去已有字典声明。');
  const dictionaryKeys: Record<string, string> = { field_code: 'code.value', data_type: 'type.value',
    unit_code: 'unit.value', measurement_nature: 'measurement.value' };
  const columns = parsed.columns.filter(name => !name.startsWith('bd.') && !(dictionaryTable && dictionary.includes(name)));
  if (!columns.length) fail('表中只有声明，没有可交接的数据列。');
  const declarations = new Map<string, { value: string; column: string }>();
  for (const [i, name] of parsed.columns.entries()) {
    const key = name.startsWith('bd.') ? name.slice(3)
      : dictionaryTable && dictionary.includes(name) ? dictionaryKeys[name] ?? name : undefined;
    if (key === undefined) continue;
    if (declarations.has(key)) fail(`来源有两处声明同一语义「${key}」，请先核对原件。`);
    const values = parsed.rows.map(row => row[i]!.original);
    if (!values.every(value => typeof value === 'string' && value === values[0])) fail(`来源声明列「${name}」逐行不一致或缺值，请核对原材料，不能以首行代表全部行。`);
    declarations.set(key, { value: String(values[0]), column: name });
  }
  const questions: R1EvidenceQuestion[] = [], evidence: R1EvidenceFact[] = [], checked = new Set<string>();
  function fact(key: string, label: string, options?: string[], header?: string, valid?: (v: string) => boolean): string {
    checked.add(key);
    const declaration = declarations.get(key);
    const answer = Object.hasOwn(input.answers, key) ? input.answers[key] : undefined;
    const sourceValue = declaration?.value;
    if (sourceValue && !unknown.test(sourceValue) && answer !== undefined && sourceValue !== answer)
      fail(`补答与已冻结的来源声明 ${declaration!.column} 冲突。`);
    const fromSource = !!sourceValue && !unknown.test(sourceValue);
    const value = fromSource ? sourceValue : answer ?? header;
    if (!value || value.length > 128 || value !== value.trim() || unknown.test(value)
      || (options && !options.includes(value)) || (valid && !valid(value))) {
      if (fromSource) fail(`来源声明 ${declaration!.column} 的值不符合「${label}」，须核对原件，不能直接覆盖。`);
      questions.push({ key, label, ...(options ? { options } : {}) });
      return '';
    }
    evidence.push({ key, value, origin: fromSource || answer === undefined ? 'file' : 'operator',
      ...(fromSource ? { column: declaration!.column } : answer === undefined && header ? { column: header } : {}) });
    return value;
  }
  const stable = (v: string) => code.test(v) && !['__proto__','constructor','prototype'].includes(v);
  const semanticCode = fact('semantic_code', '这张表记录什么业务量？给出能跨文件复用的稳定语义编码', undefined, undefined, stable);
  const subjectId = fact('subject_id', '本次所有行共同描述的业务对象编号', undefined, undefined, stable);
  const subjectKind = fact('subject_kind', '这个对象属于哪一类？', ['entity','instrument','listing','market','region','physical_object']);
  const frequency = fact('frequency', '记录的业务频率（如 day、minute、event）', undefined, undefined, stable);
  const period = fact('period_type', '原始记录采用自然期间还是瞬时观察？交易或会计期间需要另外提供固定日历合同', ['natural','instant']);
  const precision = fact('precision', '业务时间精度', ['day','minute','second']) as R1TabularMapping['precision'];
  const timezone = fact('timezone', '业务时间所属时区（如 Asia/Shanghai）', undefined, undefined, v => {
    try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; }
  });
  const header = (name: string) => columns.includes(name) ? name : undefined;
  const key = fact('key_column', '哪一列保存唯一业务键？', columns, header('business_key'));
  const start = fact('start_column', '哪一列是 UTC 业务区间起点？', columns, header('start_utc'));
  const end = fact('end_column', '哪一列是 UTC 业务区间开区间终点？', columns, header('end_utc'));
  if (key && start && end && new Set([key,start,end]).size !== 3) fail('业务键与两个区间端点必须分别映射到不同的原列。');
  const valueFields: R1TabularMapping['fields'] = [];
  const definitions: { field_code: string; data_type: ValueType; unit_code: string; measurement_nature: string; time_role: string }[] = [];
  const conversions: R1EvidenceProposal['types'] = Object.create(null);
  const annotations: Record<string, string> = Object.create(null);
  const emptyToNull: string[] = [];
  const sharedState = columns.includes('value_state') ? 'value_state' : header('state');
  const stateColumns = new Set<string>(sharedState ? [sharedState] : []);
  for (const [k,decl] of declarations) if (k.startsWith('state.') && columns.includes(decl.value)) stateColumns.add(decl.value);
  for (const [k,value] of Object.entries(input.answers)) if (k.startsWith('state.') && columns.includes(value)) stateColumns.add(value);
  for (const col of columns) if (columns.includes(col+'_state')) stateColumns.add(col+'_state');
  for (const col of columns) {
    if (!key || !start || !end || [key,start,end].includes(col) || stateColumns.has(col)) continue;
    if (col.length > 96 || ['__proto__','constructor','prototype'].includes(col)) fail('列名超过自动映射范围或与保留键冲突，请在受控加工中显式重命名。');
    const field = fact('code.'+col, `「${col}」的稳定字段编码`, undefined, stable(col) ? col : undefined, stable);
    const type = fact('type.'+col, `「${col}」按什么类型保存？`, types) as ValueType;
    const unit = fact('unit.'+col, `「${col}」的单位编码（无单位文字可填 not_applicable）`, undefined, undefined, stable);
    const nature = fact('measurement.'+col, `「${col}」的计量性质`, input.calculatedMaterial ? ['derived'] : measurement);
    // For a header convention, the field's own state takes precedence over a shared state.
    const state = fact('state.'+col, `「${col}」用哪一列标记有效、报告零或未知？也可明确整列有效`,
      [...columns.filter(c => c !== col && ![key,start,end].includes(c)), '@all_valid'], header(col+'_state') ?? sharedState);
    if (!type || !field || !unit || !nature || !state) continue;
    let mappedState = state;
    if (state === '@all_valid') {
      const index = parsed.columns.indexOf(col);
      if (parsed.rows.some(row => row[index]!.original === null || row[index]!.original === '')) fail(`「${col}」存在空值，不能声明整列有效。`);
      mappedState = '__bd_auto_valid';
      if (parsed.columns.includes(mappedState)) fail('原始表与自动状态列重名。');
      annotations[mappedState] = 'valid_value';
    }
    const valueIndex = parsed.columns.indexOf(col), stateIndex = parsed.columns.indexOf(mappedState);
    if (stateIndex >= 0) {
      const blanks = parsed.rows.filter(row => row[valueIndex]!.original === '');
      const missing = blanks.filter(row => missingStates.has(String(row[stateIndex]!.original)));
      if (missing.length && missing.length !== blanks.length)
        fail(`「${col}」同时含有效空字符串和已声明的缺失空格，现有按列清洗不能区分，请提供显式 null 的行对象 JSON。`);
      if (missing.length) {
        emptyToNull.push(col);
        evidence.push({ key: 'empty_to_null.' + col, value: String(missing.length), origin: 'file', column: mappedState });
      }
    }
    conversions[col] = type === 'text' ? 'string' : type === 'boolean' ? 'boolean' : 'decimal_string';
    definitions.push({ field_code: field, data_type: type, unit_code: unit, measurement_nature: nature, time_role: 'observation' });
    valueFields.push({ fieldCode: field, value: col, state: mappedState });
  }
  // Only the small, declared observation-table vocabulary is adopted. Never silently drop a source claim.
  if (key && start && end) for (const k of declarations.keys()) if (!checked.has(k))
    fail(`尚不支持来源声明 bd.${k}，不能忽略其可能改变的语义。`);
  const result: R1EvidenceResult = { questions, columns, evidence };
  if (questions.length) return result;
  if (!valueFields.length || new Set(valueFields.map(f => f.fieldCode)).size !== valueFields.length) fail('至少需要一个数据字段，各字段编码须唯一。');
  for (const name of Object.keys(input.answers)) if (!checked.has(name)) fail(`原材料没有对应的语义问题：${name}`);
  // The generic contract stores source-reported observations only. It gives no market-rule,
  // derived-value or historical-publication qualification to values that happen to be present.
  evidence.push({ key:'content_nature', value:'source_claim', origin:'contract' },
    { key:'coverage', value:'partial_observation', origin:'contract' });
  result.proposal = { format, ...(input.xlsxSelection ? { xlsxSelection: input.xlsxSelection } : {}),
    ...(input.sourceAdapter ? { sourceAdapter: input.sourceAdapter } : {}),
    types: conversions, annotations, ...(emptyToNull.length ? { emptyToNull } : {}),
    mapping: { kind:'tabular_rows', businessKey:key, earliestUtc:start, latestExclusiveUtc:end, precision,
      sourceTimezone:timezone, fields:valueFields },
    target: { datasetId:input.datasetId, outputKey:semanticCode, expectedParentSnapshotId:input.parentSnapshotId,
      subject:{kind:subjectKind,namespace:input.namespace,id:subjectId}, inputMode:'partial_observation',
      definition:{semantic_code:semanticCode, definition_authority:input.namespace, measurement_nature:'mixed_observation',
        unit_code:'per_field',time_role:'observation',field_definitions:definitions,
        semantic_context:{version:'wfd.semantic-context/1.0',content_nature:'source_claim',
          time:{period_type:period,frequency,interval:'half_open',timezone}}},
      coverage:{scope:{subject_id:subjectId},basis:'observed_partial',completeness:'partial',absence_means:'unknown'} },
    dimensions:{role:'source_report',informationNature:'source_claim',businessObject:subjectId,
      objectTime:frequency+' / '+timezone,purpose:'declared_source_observations',structureGranularity:'one_record_per_business_key'} };
  return result;
}

type EvidenceInput = Parameters<typeof resolveR1Evidence>[0];
const numericLexeme = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const dateHeader = /^(?:交易日期|报告日期|公告日期|统计日期|日期|trade_date|report_date|event_date|date)$/iu;
const identityHeader = /(?:代码|编号|(?:^|_)id|(?:^|_)code)$/iu;
const countHeader = /(?:数量|次数|家数|个数)$/u;
const textHeader = /(?:名称|名字|类型|类别|标签|备注|说明|描述|原因|理由|内容)(?:[（(].*[）)])?$|^关联机构(?:[（(].*[）)])?$/u;
// 括号也可能是提供方、A 类或备注；只认明确的计量写法。
const unitSyntax = /^(?:[%％]|(?:人民币)?[万百亿千兆]*元|元\/股|倍|点|股|万股|人|手|个|次|家|年|月|日|天|小时|分钟|秒|千克|吨|米|公里|平方米|立方米|摄氏度)$/u;
// 原写法 → 规范单位编码：只映射计量含义明确的写法；无量纲比值用 ratio，百分比用 percent，二者可区分。
const CANONICAL_UNIT_CODES: Readonly<Record<string, string>> = Object.freeze({
  '%': 'percent', '％': 'percent', '倍': 'ratio',
  '元': 'cny', '人民币元': 'cny', '人民币': 'cny', '元/股': 'cny_per_share', '股': 'share',
});
/** 价格原表的「元」是每股价格口径，与金额列不能共用同一量纲。 */
const priceHeader = /(?:开盘价|最高价|最低价|收盘价|昨收价|最新价|成交价|均价|价格)/u;
const amountHeader = /(?:成交额|成交金额|金额|总额|市值|资金)/u;
const canonicalHeaderUnit = (column: string, label: string): string | null | undefined => {
  const canonical = CANONICAL_UNIT_CODES[label];
  return canonical === 'cny' && priceHeader.test(column) && !amountHeader.test(column) ? 'cny_per_share' : canonical;
};
function headerUnit(column: string): string | undefined {
  const label = /[（(]([^（）()]{1,64})[）)]\s*$/u.exec(column)?.[1]
    ?? (/[%％]\s*$/u.test(column) ? '%' : undefined);
  return label && unitSyntax.test(label) ? label : undefined;
}

const SOURCE_SEMANTICS_VERSION = 'bd.source-reported-semantics/1';
/** 只认原列直接写明的类别；类别不是其金融定义、市场资格或来源方法已被证实。 */
function sourceFieldQualification(column: string, dateColumn: string, identity: boolean, minuteColumn?: string) {
  let assertion = 'source_reported_observation';
  const matrix = ['SEM-04', 'SEM-08'], gaps = ['historical_public_time'];
  if (column === dateColumn) {
    assertion = 'source_reported_date_label'; matrix.push('SEM-02'); gaps.push('trading_session');
  } else if (column === minuteColumn) {
    assertion = 'source_reported_minute_label'; matrix.push('SEM-02'); gaps.push('bar_label_start_or_end', 'trading_session', 'minute_coverage');
  } else if (identity) {
    assertion = 'source_reported_identity_label'; matrix.push('SEM-01'); gaps.push('effective_business_identity');
  } else if (column === '序号') {
    assertion = 'source_row_label'; gaps.push('business_identity_not_established_by_row_order');
  } else if (/(?:流入资金|流出资金|净流入|净流出|净买卖|买入金额|卖出金额)/u.test(column)) {
    assertion = 'source_reported_fund_flow_label'; matrix.push('SUP-C01');
    gaps.push('fund_flow_method', 'participant_scope', 'actual_account_flow', 'observation_cutoff');
  } else if (/(?:封板|开板|回封|炸板|连板|涨停|跌停)|^榜单类型$/u.test(column)) {
    assertion = 'source_reported_limit_process_label'; matrix.push('MBS-02');
    gaps.push('historical_market_rules', 'trading_session', 'intraday_reconstruction');
  } else if (/(?:涨跌额|价格差)/u.test(column)) {
    assertion = 'source_reported_price_change_label'; matrix.push('MKT-04');
    gaps.push('price_comparison_basis', 'price_adjustment');
  } else if (/(?:涨跌幅|收益率)/u.test(column)) {
    assertion = 'source_reported_return_label'; matrix.push('MKT-04');
    gaps.push('return_definition', 'price_adjustment', 'comparison_window');
  } else if (/换手率/u.test(column)) {
    assertion = 'source_reported_turnover_label'; matrix.push('MKT-03');
    gaps.push('denominator_definition', 'denominator_effective_date', 'sample_scope');
  } else if (/(?:开盘价|最高价|最低价|收盘价|昨收价|最新价)/u.test(column)) {
    assertion = 'source_reported_price_label'; matrix.push('MKT-01', 'MKT-04');
    gaps.push('price_adjustment', 'price_basis', 'trading_session');
  } else if (/(?:标签|原因|理由|游资名称|关联机构)/u.test(column)) {
    assertion = 'source_reported_interpretation'; matrix.push('SUP-C06'); gaps.push('independent_corroboration');
  }
  // “元”只说明原单位字面量，不能凭所在地或中文替来源认领人民币。
  const unit = headerUnit(column);
  if (unit?.includes('元') && !unit.startsWith('人民币')) gaps.push('currency');
  return { rules_version: SOURCE_SEMANTICS_VERSION, matrix_ids: matrix, assertion_status: assertion,
    ...(unit?.startsWith('人民币') ? { currency: 'CNY' } : {}), unknown: gaps };
}

/** 目录仅作为操作者给出的来源系列声明，不从文件名推断业务类型、日期或币种。 */
export function declaredSourceSeries(source: R1SourceDeclaration | undefined): string | undefined {
  if (!source) return undefined;
  try {
    const url = new URL(source.requested_url);
    if (url.protocol !== 'file:' || url.search || url.hash) return undefined;
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (!/\.(?:csv|json|xlsx)$/iu.test(parts.pop() ?? '')) return undefined;
    while (/^\d{1,8}$/u.test(parts.at(-1) ?? '')) parts.pop();
    let series = parts.pop();
    // “按交易日”等只是通用分区标签，必须连同其具体父系列识别，不能在同一来源下并族。
    const partitions: string[] = [];
    while (series && /^(?:按交易日|按日期|按日|按月|按年|按年份|按季度|每日|每月|每年)$/u.test(series)) {
      partitions.unshift(series);
      while (/^\d{1,8}$/u.test(parts.at(-1) ?? '')) parts.pop();
      series = parts.pop();
    }
    if (!series || /^(?:原包|原件|材料|数据|静态数据库|raw|source|input|inputs|data|tmp|temp|uploads?)$/iu.test(series)
      || /(?:^|[_-])batch(?:[_-]|$)|批次|验收|测试产物|\d{8}/iu.test(series)) return undefined;
    return [series,...partitions].join(' / ');
  } catch { return undefined; }
}

function resolveSourceReport(input: EvidenceInput, parsed: ParsedCandidateTable, format: R1EvidenceProposal['format']): R1EvidenceResult {
  const questions: R1EvidenceQuestion[] = [], evidence: R1EvidenceFact[] = [], checked = new Set<string>();
  const columns = parsed.columns;
  function answer(key: string, label: string, fallback?: string, fileColumn?: string, valid: (value: string) => boolean = value => !!value.trim(), options?: string[]): string {
    checked.add(key);
    const supplied = Object.hasOwn(input.answers, key) ? input.answers[key] : undefined;
    if (fileColumn && fallback && supplied !== undefined && supplied !== fallback) fail(`补答与原列「${fileColumn}」的明确来源证据冲突。`);
    const value = supplied ?? fallback;
    if (!value || value.length > 1024 || value !== value.trim() || unknown.test(value) || !valid(value)) {
      questions.push({ key, label, ...(options ? { options } : {}) }); return '';
    }
    evidence.push({ key, value, origin: fileColumn ? 'file' : 'operator', ...(fileColumn ? { column: fileColumn } : { field: 'answers.'+key, quote: value }) });
    return value;
  }
  const validTimezone = (value: string) => { try { new Intl.DateTimeFormat('en',{ timeZone:value }); return true; } catch { return false; } };
  const dateCandidates = columns.filter(column => dateHeader.test(column));
  const dateColumn = answer('source_date_column', '哪一原列保存本表共同采用的原报公历日期标签？不从文件名补日期', dateCandidates.length === 1 ? dateCandidates[0] : undefined,
    dateCandidates.length === 1 ? dateCandidates[0] : undefined, value => columns.includes(value), columns);
  const dateValues = dateColumn ? parsed.rows.map(row => row[columns.indexOf(dateColumn)]!.original) : [];
  const encoding: CandidateSourceProjection['dateEncoding'] | undefined = dateValues.length && dateValues.every(value => sourceReportedDate(value,'yyyymmdd')) ? 'yyyymmdd'
    : dateValues.length && dateValues.every(value => sourceReportedDate(value,'iso-date')) ? 'iso-date' : undefined;
  if (dateColumn && !encoding) fail(`「${dateColumn}」含缺失、无效或混合编码日期；需要明确日期修订，未从相邻行或文件名补造。`);
  const minuteCandidates = columns.filter(column=>SOURCE_REPORTED_MINUTE_HEADER.test(column));
  const minuteColumn = minuteCandidates.length ? answer('source_minute_column','哪一原列保存完整原报分钟标签？须含日期和零秒，不能从文件名或行号补造',
    minuteCandidates.length===1 ? minuteCandidates[0] : undefined,minuteCandidates.length===1 ? minuteCandidates[0] : undefined,
    value=>minuteCandidates.includes(value),minuteCandidates) : '';
  if (minuteColumn && parsed.rows.some((row,index)=>{
    const minute=sourceReportedMinute(row[columns.indexOf(minuteColumn)]!.original);
    return !minute || !encoding || minute.slice(0,10)!==sourceReportedDate(dateValues[index],encoding);
  })) fail(`「${minuteColumn}」含无效、缺失或与日期不一致的原报分钟标签；未降级成日线。`);
  const tradeDate = /^(?:交易日期|trade_date)$/iu.test(dateColumn);
  const timezoneKey = tradeDate ? 'source_trade_date_timezone' : 'source_date_timezone';
  const timezone = dateColumn ? answer(timezoneKey, tradeDate
    ? '原报交易日期按哪个来源日历日时区保存？境内 A 股的北京时间政策只在本件来源范围已明确确认时适用，历史可得时间仍未知'
    : '原报日期标签按哪个来源日历日时区保存？须有本表的明确依据，历史可得时间仍未知', undefined, undefined, validTimezone) : '';
  const sourceId = input.source?.source_id, provider = input.source?.provider;
  if (!sourceId || !provider) return fail('来源原报表需要本次入口已明确的 source_id 与 provider；原表或文件名不能替操作者声明来源。');
  const seriesFromDirectory = declaredSourceSeries(input.source);
  const series = answer('source_series', '确认这张表所属的稳定来源系列/表题；同系列跨日期及新增度量列沿用该名称，不填批次号或文件名', seriesFromDirectory);
  if (series && !Object.hasOwn(input.answers,'source_series')) {
    const entry = evidence.at(-1)!; entry.field = 'source.requested_url'; entry.quote = input.source!.requested_url;
  }
  // 已知频率/复权/市场与单位换算属于系列语义：不同口径不能因 provider+series 相同而落成同一原报产品。
  const adapterSemantics = input.sourceAdapter ? { frequency: input.sourceAdapter.config.match.frequency,
    adjustment: input.sourceAdapter.config.match.adjustment, market: input.sourceAdapter.config.match.market ?? null,
    units: input.sourceAdapter.config.fields.filter(field => field.unit)
      .map(field => [field.name, field.unit!.source, field.unit!.target, field.unit!.factor]) } : undefined;
  const family = series && dateColumn ? wfdSha256(canonicalWfdJson({ ...(minuteColumn
    ? {version:'source-reported-table/2',provider,sourceId,series,dateColumn,minuteColumn}
    : { version:'source-reported-table/1',provider,sourceId,series,dateColumn }),
    ...(adapterSemantics ? { adapterSemantics } : {}) })) : null;
  const sourceFamilyHint = family ? {semanticCode:'source_report.'+family.slice(0,32),subjectId:'source_table.'+family.slice(0,32)} : undefined;
  // 先核原表的实际标识列；无法唯一定位时只提出一次真实复合维度问题。
  const identifiers = columns.filter(column => column !== dateColumn && identityHeader.test(column));
  const firstIdentifier = identifiers[0];
  const timeColumns = [dateColumn,...(minuteColumn ? [minuteColumn] : [])];
  let keyColumns = dateColumn ? [...timeColumns, ...(firstIdentifier ? [firstIdentifier] : [])] : [];
  const registered = input.registeredKeyColumns;
  let registeredGap = '';
  if (registered !== undefined) {
    if (!Array.isArray(registered) || !registered.length || registered.some(column => typeof column !== 'string') || new Set(registered).size !== registered.length
      || timeColumns.some(column=>!registered.includes(column))) registeredGap = '已有固定目录的键不包含本表原日期/分钟列或键候选结构不完整';
    else if (registered.includes('序号')) registeredGap = '已有固定目录的键包含来源行序号；它不是本表业务身份维度';
    else if (registered.some(column => !columns.includes(column))) registeredGap = `已有固定目录的键列 ${JSON.stringify(registered.filter(column=>!columns.includes(column)))} 在本件原表缺失`;
    else {
      keyColumns = [...timeColumns,...registered.filter(column=>!timeColumns.includes(column)).sort()];
      if (parsed.rows.some(row=>keyColumns.some(column=>row[columns.indexOf(column)]!.original === null || row[columns.indexOf(column)]!.original === '')))
        registeredGap = `已有固定目录的键 ${JSON.stringify(keyColumns)} 在本件含空值`;
      else if (new Set(parsed.rows.map(row=>canonicalWfdJson(keyColumns.map(column=>row[columns.indexOf(column)]!.original)))).size !== parsed.rows.length)
        registeredGap = `已有固定目录的键 ${JSON.stringify(keyColumns)} 在本件不唯一`;
    }
    evidence.push({key:'registered_source_key_columns',value:JSON.stringify(registered),origin:'contract'});
  }
  const proposedUnique = keyColumns.length && parsed.rows.every(row => keyColumns.every(column => {
    const value = row[columns.indexOf(column)]!.original; return value !== null && value !== '';
  })) && new Set(parsed.rows.map(row => canonicalWfdJson(keyColumns.map(column => row[columns.indexOf(column)]!.original)))).size === parsed.rows.length;
  const needsKey = registered !== undefined ? !!registeredGap : !proposedUnique || (!firstIdentifier && parsed.rows.length > 1);
  if (Object.hasOwn(input.answers,'source_key_columns') || needsKey) {
    const value = answer('source_key_columns', (registeredGap ? registeredGap+'，请核对真实来源和维度差异。' : '原日期和现有标识列不足以唯一定位每条来源陈述。')
      +'请用 JSON 字符串数组列出真实身份维度原列（日期会始终保留），不要填数值列或行号', undefined, undefined, value => {
      try { const keys: unknown = JSON.parse(value); return Array.isArray(keys) && keys.length > 0 && keys.every(key => typeof key === 'string' && key !== '序号' && columns.includes(key)
        && (timeColumns.includes(key) || identityHeader.test(key) || !parsed.rows.some(row => numericLexeme.test(String(row[columns.indexOf(key)]!.original)))))
        && new Set(keys).size === keys.length; } catch { return false; }
    });
    if (value) keyColumns = [...timeColumns, ...(JSON.parse(value) as string[]).filter(column => !timeColumns.includes(column)).sort()];
  } else if (dateColumn) evidence.push({ key:'source_key_columns', value:JSON.stringify(keyColumns), origin:registered ? 'contract' : 'file',
    ...(!registered ? {column:firstIdentifier ?? dateColumn} : {}) });
  const selected = input.sourceValueColumns;
  if (selected !== undefined) {
    if (!Array.isArray(selected) || !selected.length || selected.some(column=>typeof column !== 'string')) fail('来源原报选列须为非空的实际原列名称数组；未自动跳列。');
    if (new Set(selected).size !== selected.length) fail(`来源原报选列包含重复原列：${JSON.stringify(selected.filter((column,index)=>selected.indexOf(column)!==index))}`);
    const missing = selected.filter(column=>!columns.includes(column));
    if (missing.length) fail(`本件所选原列不存在：${JSON.stringify(missing)}；原件已保留，须核对本件来源选列，未静默跳列。`);
  }
  const valueColumns = selected ? columns.filter(column => keyColumns.includes(column) || selected.includes(column)) : columns;
  // 来源字段档案：已确认的映射直接给出标准字段/类型/单位，不再把原表头派生成正式字段身份。
  const profileMap = input.sourceFieldProfile
    ? new Map(input.sourceFieldProfile.profile.fields.map(field => [field.originalHeader, field])) : null;
  if (input.sourceFieldProfile) {
    const profile = input.sourceFieldProfile.profile;
    if (profile.sourceId !== String(sourceId)) fail(`来源字段档案 ${profile.profileId} 属于其他来源；未跨来源套用映射。`);
    if (profile.series && series && profile.series !== series) fail(`来源字段档案 ${profile.profileId} 的系列「${profile.series}」与本件系列「${series}」不同；未跨系列套用映射。`);
    const unmapped = valueColumns.filter(column => !profileMap!.has(column));
    if (unmapped.length) fail(`来源字段档案 ${profile.profileId} 未映射本件字段 ${JSON.stringify(unmapped)}；不据列名相似补映射。`);
    for (const field of profile.fields) {
      const present = columns.includes(field.originalHeader);
      if (field.role === 'date' && present && field.originalHeader !== dateColumn) fail(`来源字段档案 ${profile.profileId} 声明「${field.originalHeader}」为日期列，但本件日期列是「${dateColumn}」。`);
      if (field.role === 'minute' && present && field.originalHeader !== minuteColumn) fail(`来源字段档案 ${profile.profileId} 声明「${field.originalHeader}」为分钟列，但本件分钟列是「${minuteColumn}」。`);
      if (field.role === 'identity' && present && !keyColumns.includes(field.originalHeader)) fail(`来源字段档案 ${profile.profileId} 声明「${field.originalHeader}」为标识列，但本件键列是 ${JSON.stringify(keyColumns)}。`);
    }
    if (!profile.fields.some(field => field.role === 'date')) fail(`来源字段档案 ${profile.profileId} 没有登记日期列；分钟行情档案必须明确日期与分钟列。`);
    evidence.push({ key: 'source_field_profile', value: profile.profileId, origin: 'contract' },
      { key: 'source_field_profile_sha256', value: input.sourceFieldProfile.digest, origin: 'contract' });
  }
  const definitions: {field_code:string;data_type:ValueType;unit_code:string;measurement_nature:string;time_role:string}[] = [];
  const mappingFields: R1TabularMapping['fields'] = [], fields: CandidateSourceProjection['fields'] = [];
  const fieldContexts: Record<string, WfdRecord> = {};
  const conversions: R1EvidenceProposal['types'] = Object.create(null), emptyToNull: string[] = [];
  for (const [ordinal,column] of valueColumns.entries()) {
    const cells = parsed.rows.map(row => row[columns.indexOf(column)]!);
    const nonempty = cells.filter(cell => cell.value !== null && cell.value !== '');
    // 冻结适配已声明字段类型与目标单位：它是已知事实，不能再用列名或补答覆盖。
    const adapterField = input.sourceAdapter?.config.fields.find(field => field.name === column);
    // 有效值类型按冻结适配的实际表示：整数源值经小数系数换算后已是十进制。
    const adapterType: ValueType | undefined = adapterField
      ? ({ string: 'text', integer: 'integer', decimal: 'decimal' } as const)[adapterColumnType(adapterField) === 'string' ? 'string'
        : adapterColumnType(adapterField) === 'safe_integer' ? 'integer' : 'decimal'] : undefined;
    const identity = keyColumns.includes(column) || identityHeader.test(column), date = column === dateColumn;
    const rowLabel = column === '序号';
    const definiteUnit = headerUnit(column);
    const generatedCode = sourceReportedCode('src_',column);
    const mappedField = profileMap?.get(column);
    let fieldCode: string;
    if (mappedField) {
      checked.add('code.'+column);
      evidence.push({ key:'code.'+column, value:mappedField.fieldCode, origin:'contract', field:`sourceFieldProfile.fields.${column}.fieldCode` });
      fieldCode = mappedField.fieldCode;
    } else fieldCode = answer('code.'+column, `「${column}」完整原名超出可逆字段码预算，请给出保留映射的明确稳定字段别名`, generatedCode ?? undefined,
      generatedCode ? column : undefined, value => code.test(value) && !['__proto__','constructor','prototype'].includes(value));
    const numericCells = nonempty.filter(cell=>typeof cell.value === 'string' && numericLexeme.test(cell.value));
    const allNumeric = numericCells.length === nonempty.length, allInteger = nonempty.every(cell=>/^-?(?:0|[1-9][0-9]*)$/u.test(String(cell.value)));
    const allBoolean = nonempty.every(cell=>typeof cell.value === 'boolean' || cell.value === 'true' || cell.value === 'false');
    const sourceTypeFixed = !!adapterField || identity || rowLabel || textHeader.test(column) || !!definiteUnit || countHeader.test(column)
      || nonempty.length > 0 && nonempty.every(cell=>typeof cell.value === 'boolean');
    const fileType: ValueType | undefined = adapterType ?? (identity || rowLabel || textHeader.test(column) ? 'text'
      : definiteUnit ? 'decimal' : countHeader.test(column) ? 'integer'
      : nonempty.length && nonempty.every(cell=>typeof cell.value === 'boolean') ? 'boolean'
      : nonempty.length && allNumeric ? 'decimal' : nonempty.length && !numericCells.length ? 'text' : undefined);
    const registeredType = fieldCode ? input.registeredTypes?.[fieldCode] : undefined;
    const compatibleRegisteredType = registeredType && (registeredType === 'text' || registeredType === 'decimal' && allNumeric
      || registeredType === 'integer' && allInteger || registeredType === 'boolean' && allBoolean) ? registeredType : undefined;
    const proposedType = sourceTypeFixed ? fileType : registeredType ? compatibleRegisteredType : fileType;
    let type: ValueType | '';
    if (mappedField) {
      checked.add('type.'+column);
      evidence.push({ key:'type.'+column, value:mappedField.dataType, origin:'contract', field:`sourceFieldProfile.fields.${column}.dataType` });
      type = mappedField.dataType;
    } else type = answer('type.'+column, `「${column}」${!nonempty.length ? '整列为空且缺类型证据' : '原报数值与文字标记混合，或与已登记类型不符'}，请根据实际来源明确字段类型；不会自动把未知数值改为文字准入`,
      proposedType, sourceTypeFixed ? column : undefined, value => types.includes(value as ValueType), types) as ValueType | '';
    if (!type) continue;
    const typeEvidence = evidence.at(-1)!;
    if (mappedField) { /* 档案已给出类型与来源，不再改写证据归属 */ }
    else if (adapterField && !Object.hasOwn(input.answers,'type.'+column)) {
      typeEvidence.origin = 'contract'; typeEvidence.field = `sourceAdapter.fields.${column}.type`;
      delete typeEvidence.quote; delete typeEvidence.column;
    } else if (!Object.hasOwn(input.answers,'type.'+column) && !sourceTypeFixed) {
      typeEvidence.origin = registeredType ? 'contract' : 'file'; delete typeEvidence.field; delete typeEvidence.quote;
      if (!registeredType) typeEvidence.column = column;
    }
    const numeric = type === 'decimal' || type === 'integer';
    if (numeric && (!allNumeric || type === 'integer' && !allInteger)) fail(`「${column}」含非数值原报或不符合声明的整数；未把原标记改为零或猜测缺失原因。`);
    if (type === 'boolean' && !allBoolean) fail(`「${column}」含非布尔原报，未猜测真假含义。`);
    // 目标单位优先取冻结适配声明的换算目标；它描述的是已发布的有效值，不是原列名猜测。
    const adapterUnit = adapterField?.unit?.target;
    const automaticUnit = adapterUnit ?? (date ? 'date' : type === 'text' || type === 'boolean' ? 'not_applicable'
      : definiteUnit ? canonicalHeaderUnit(column, definiteUnit) ?? sourceReportedCode('srcunit_', definiteUnit) ?? undefined
      : countHeader.test(column) ? 'count' : undefined);
    const registeredUnit = fieldCode ? input.registeredUnits?.[fieldCode] : undefined;
    let unit: string;
    if (mappedField) {
      checked.add('unit.'+column);
      evidence.push({ key:'unit.'+column, value:mappedField.unitCode, origin:'contract', field:`sourceFieldProfile.fields.${column}.unitCode` });
      unit = mappedField.unitCode;
      if (numeric && unit === 'not_applicable') fail(`来源字段档案 ${profileMap && input.sourceFieldProfile!.profile.profileId} 把数值列「${column}」登记为无单位；无量纲数值应使用 ratio。`);
    } else unit = answer('unit.'+column, `「${column}」原数值的单位是什么？原表未写明时须有具体来源依据；不能按习惯补币种、百分号或指数点`, automaticUnit ?? registeredUnit,
      automaticUnit && !adapterUnit ? column : undefined, value => code.test(value) && !(numeric && value === 'not_applicable'));
    if (adapterUnit && !Object.hasOwn(input.answers,'unit.'+column)) {
      const unitEvidence = evidence.at(-1)!;
      unitEvidence.origin = 'contract'; unitEvidence.field = `sourceAdapter.fields.${column}.unit.target`;
      delete unitEvidence.quote; delete unitEvidence.column;
    }
    if (!mappedField && unit && !automaticUnit && registeredUnit && !Object.hasOwn(input.answers,'unit.'+column)) {
      const unitEvidence = evidence.at(-1)!; unitEvidence.origin = 'contract'; delete unitEvidence.field; delete unitEvidence.quote;
    }
    if (nonempty.length !== cells.length) emptyToNull.push(column);
    if (!unit || !fieldCode) continue;
    conversions[column] = type === 'boolean' ? 'boolean' : type === 'text' ? 'string' : 'decimal_string';
    const stateColumn = `__bd_source_state_${ordinal}`;
    fields.push({ column, fieldCode, stateColumn });
    mappingFields.push({ fieldCode, value:column, state:stateColumn });
    definitions.push({ field_code:fieldCode,data_type:type,unit_code:unit,measurement_nature:'mixed_observation',time_role:'observation' });
    evidence.push({ key:'state.'+column,value:'nonempty_valid_blank_unknown',origin:'file',column });
    const qualification = sourceFieldQualification(column, dateColumn, identity, minuteColumn);
    fieldContexts[fieldCode] = { content: { assertion_status: qualification.assertion_status } };
    evidence.push({ key:'source_semantics.'+column,value:canonicalWfdJson(qualification),origin:'file',column });
  }
  const result: R1EvidenceResult = {questions,columns,evidence,...(sourceFamilyHint ? {sourceFamilyHint} : {})};
  if (questions.length) return result;
  if (!dateColumn || !encoding || !timezone || !series || !fields.length) return fail('来源原报投影尚无完整证据。');
  for (const key of Object.keys(input.answers)) if (!checked.has(key)) fail(`原材料没有对应的语义问题：${key}`);
  const {semanticCode,subjectId} = sourceFamilyHint!;
  const sourceProjection: CandidateSourceProjection = { version:minuteColumn ? 'source-reported-table/2' : 'source-reported-table/1',
    dateColumn,dateEncoding:encoding,...(minuteColumn ? {minute:{column:minuteColumn,encoding:'iso-local-minute' as const}} : {}),
    timezone,keyColumns,sourceColumns:[...columns],fields };
  projectSourceReportedTable(parsed,sourceProjection); // 先用实际完整表核身份冲突与日期可表示性。
  const sourceFact = evidence.find(entry => entry.key === 'source_series')!;
  evidence.push({ ...sourceFact,key:'semantic_code',value:semanticCode }, { ...sourceFact,key:'subject_id',value:subjectId },
    { key:'frequency',value:minuteColumn ? 'source_reported_minute' : 'source_reported_day',origin:'file',column:minuteColumn || dateColumn },
    { key:'key_column',value:SOURCE_REPORT_COLUMNS.key,origin:'file',column:keyColumns[1] ?? dateColumn },
    { key:'source.provider',value:provider,origin:'operator',field:'source.provider',quote:provider },
    { key:'source.source_id',value:sourceId,origin:'operator',field:'source.source_id',quote:sourceId },
    { key:'content_nature',value:'source_claim',origin:'contract' }, { key:'historical_availability',value:'unknown',origin:'contract' });
  let context: WfdRecord = {version:'wfd.semantic-context/1.0',content_nature:'source_claim',
    identity:{subject_kind:'entity',identity_resolution_rule:'source_reported_date_and_identity_columns:'+JSON.stringify(keyColumns),alias_scope:`来源原报表系列「${series}」`},
    time:{period_type:'natural',frequency:minuteColumn ? 'source_reported_minute' : 'source_reported_day',interval:'half_open',timezone,
      roles:{business_date:tradeDate ? 'source_reported_trade_date_label' : 'source_reported_calendar_date_label',
        business_interval:minuteColumn ? 'minute_label_bucket_not_verified_bar_interval' : 'calendar_date_label_not_trading_session',
        ...(minuteColumn ? {minute_label_meaning:'unknown',trading_session:'unknown',minute_coverage:'unknown'} : {}),public_time:'unknown'}},
    content:{assertion_status:'source_reported_unverified'},measurement:{value_states:['valid_value','unknown']},
    coverage_quality:{completeness:'partial',absence_means:'unknown'}};
  // 旧族并不因新解释规则自动升版；新知识留本次BD证据，旧全局及旧字段合同沿用其固定范围。
  const registeredDefinition = input.registeredSourceDefinition;
  if (registeredDefinition && isWfdRecord(registeredDefinition.semantic_context)) {
    const oldFields = new Set((Array.isArray(registeredDefinition.field_definitions) ? registeredDefinition.field_definitions : [])
      .filter(isWfdRecord).map(field => String(field.field_code)));
    const oldContexts = isWfdRecord(registeredDefinition.field_semantic_context) ? registeredDefinition.field_semantic_context : {};
    for (const fieldCode of Object.keys(fieldContexts)) if (oldFields.has(fieldCode)) {
      if (isWfdRecord(oldContexts[fieldCode])) fieldContexts[fieldCode] = structuredClone(oldContexts[fieldCode]);
      else delete fieldContexts[fieldCode];
    }
    context = structuredClone(registeredDefinition.semantic_context);
    // 身份轴仍由实际原件核对；新复合维度不能被旧上下文掩盖。
    context.identity = { ...(isWfdRecord(context.identity) ? context.identity : {}),
      identity_resolution_rule:'source_reported_date_and_identity_columns:'+JSON.stringify(keyColumns) };
    evidence.push({key:'source_semantics_contract',value:canonicalWfdJson({rules_version:SOURCE_SEMANTICS_VERSION,
      disposition:'retain_registered_scope',definition_sha256:wfdSha256(canonicalWfdJson(registeredDefinition))}),origin:'contract'});
  } else evidence.push({key:'source_semantics_contract',value:canonicalWfdJson({rules_version:SOURCE_SEMANTICS_VERSION,
    disposition:'new_source_reported_qualifications'}),origin:'contract'});
  result.proposal = {format,...(input.xlsxSelection ? { xlsxSelection:input.xlsxSelection } : {}),
    ...(input.sourceAdapter ? { sourceAdapter:input.sourceAdapter } : {}),sourceProjection,types:conversions,
    ...(emptyToNull.length ? {emptyToNull} : {}),
    mapping:{kind:'tabular_rows',businessKey:SOURCE_REPORT_COLUMNS.key,earliestUtc:SOURCE_REPORT_COLUMNS.start,latestExclusiveUtc:SOURCE_REPORT_COLUMNS.end,
      precision:minuteColumn ? 'minute' : 'day',sourceTimezone:timezone,fields:mappingFields},
    target:{datasetId:input.datasetId,outputKey:semanticCode,expectedParentSnapshotId:input.parentSnapshotId,
      subject:{kind:'entity',namespace:input.namespace,id:subjectId},inputMode:'partial_observation',
      definition:{semantic_code:semanticCode,definition_authority:input.namespace,measurement_nature:'mixed_observation',unit_code:'per_field',time_role:'observation',field_definitions:definitions,
        semantic_context:context,...(Object.keys(fieldContexts).length ? {field_semantic_context:fieldContexts} : {})},
      coverage:{scope:{subject_id:subjectId},basis:'observed_partial',completeness:'partial',absence_means:'unknown'}},
    dimensions:{role:'source_report',informationNature:'source_claim',businessObject:subjectId,objectTime:(minuteColumn ? 'source_reported_minute' : 'source_reported_day')+' / '+timezone,
      purpose:'declared_source_observations',structureGranularity:minuteColumn ? 'one_record_per_source_minute_and_identity' : 'one_record_per_source_date_and_identity'} };
  return result;
}

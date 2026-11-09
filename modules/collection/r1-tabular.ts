import { readFileSync } from 'node:fs';
import type { R1PrepareInput, R1SourceDeclaration, R1TabularMapping, R1TimeMapping } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

export const R1_TABULAR_RULE_VERSION = 'bd.r1-tabular/3';
const IMPLEMENTATION_SHA256 = wfdSha256(readFileSync(new URL(import.meta.url)));
const PRICE_ROLES = ['open', 'high', 'low', 'close'] as const;
const QUANTITY_ROLES = ['volume', 'amount'] as const;
const MARKET_ROLES = [...PRICE_ROLES, ...QUANTITY_ROLES] as const;
const CONTENT_NATURES = new Set(['observed_fact', 'source_claim', 'plan', 'forecast', 'actual_outcome',
  'deterministic_derived', 'definition_rule']);
const PERIOD_TYPES = new Set(['natural', 'trading', 'accounting', 'observation_window', 'instant']);
const MEASUREMENT_NATURES = new Set(['stock', 'flow', 'event', 'derived', 'mixed_observation', 'relation']);
// Mirrors only WFD's already published intrinsic unit classes; custom units remain WFD-governed.
const KNOWN_UNIT_CLASS: Record<string, 'numeric' | 'text' | 'boolean' | 'text_or_boolean'> = {
  cny: 'numeric', usd: 'numeric', money: 'numeric', cny_100million: 'numeric',
  share: 'numeric', lot_100_shares: 'numeric', vehicle: 'numeric', count: 'numeric',
  cny_per_share: 'numeric', cny_per_10_shares: 'numeric', ratio: 'numeric', percent: 'numeric', day_of_week: 'numeric',
  date: 'text', text: 'text', identifier: 'text', currency_code: 'text', timezone: 'text',
  boolean: 'boolean', not_applicable: 'text_or_boolean',
};
const NULL_STATES = new Set(['unknown', 'not_reported', 'not_collected', 'out_of_coverage', 'not_applicable',
  'not_yet_effective', 'not_matured', 'insufficient_warmup', 'source_conflict']);
export const R1_CONTRACT_ROLES = ['semantic', 'read_layout', 'algorithm_dependency', 'update_release'] as const;
export interface R1ContractBinding { contract_refs: WfdRecord; contract_bundle_ref: WfdRecord }
export interface R1TabularCompilation { applicable: boolean; ruleVersion: string; ruleDigest: string; checkScope: string[]; gaps: string[] }
type Declaration = { protocol: string; target: R1PrepareInput['target']; mapping: R1TabularMapping; source?: R1SourceDeclaration };

/** Only the explicit new branch changes existing generic/scalar plan behavior. */
export function isR1TabularDeclaration(value: unknown): boolean {
  return isWfdRecord(value) && value.protocol === 'wfd.structured-ingest/1.0'
    && isWfdRecord(value.mapping) && value.mapping.kind === 'tabular_rows';
}
export function compileR1TabularDeclaration(value: unknown): R1TabularCompilation {
  const result: R1TabularCompilation = { applicable: isR1TabularDeclaration(value), ruleVersion: R1_TABULAR_RULE_VERSION,
    ruleDigest: wfdSha256(canonicalWfdJson({ version: R1_TABULAR_RULE_VERSION, implementation: IMPLEMENTATION_SHA256, declaration: value ?? null })),
    checkScope: [], gaps: [] };
  if (!result.applicable) return result;
  const { mapping, target, source } = readDeclaration(value), definition = object(target.definition), context = object(definition.semantic_context);
  const time = object(context.time), financial = object(context.financial), statistical = object(context.statistical);
  const gaps = result.gaps, bar = mapping.bar, market = bar !== undefined;
  if (!known(target.subject.kind) || !known(target.subject.namespace) || !known(target.subject.id)) gaps.push('表格需要明确且固定的业务主体身份。');
  if (context.version !== 'wfd.semantic-context/1.0' || !CONTENT_NATURES.has(String(context.content_nature))) gaps.push('表格需要 WFD 支持的明确语义版本和内容性质。');
  const requiredAxes = market ? ['identity', 'time', 'measurement', 'content', 'statistical', 'financial']
    : ['identity', 'time', 'measurement', 'content', 'coverage_quality'];
  if (Array.isArray(context.unknown_axes) && context.unknown_axes.some(axis => requiredAxes.includes(String(axis)))) gaps.push('本次表格依赖的语义轴仍明确为 unknown。');
  if (requiredAxes.some(axis => object(context[axis]).status === 'unknown')) gaps.push('本次表格依赖的语义上下文仍有显式 unknown 状态。');
  if (definition.unit_code !== 'per_field') gaps.push('表格必须使用逐字段单位合同。');
  if (!MEASUREMENT_NATURES.has(String(definition.measurement_nature))) gaps.push('目标计量性质须为 WFD 已支持的明确类别。');
  if (!known(time.frequency) || !PERIOD_TYPES.has(String(time.period_type)) || time.interval !== 'half_open'
    || time.timezone !== mapping.sourceTimezone) gaps.push('业务频率、周期、左闭右开区间和时区须与实际行时间明确相符。');
  try { new Intl.DateTimeFormat('en', { timeZone: mapping.sourceTimezone }); } catch { gaps.push('来源时区不是有效的明确时区。'); }
  if (time.period_type === 'trading' && !calendarReference(time.calendar_ref)) gaps.push('交易周期须引用真实固定日历，使用 WFD 日历的完整固定引用形状；本地不生成交易日历。');
  if (time.period_type === 'accounting' && !calendarReference(time.accounting_calendar_ref)) gaps.push('会计周期须有 WFD 日历的完整固定引用。');
  if (time.period_type === 'observation_window' && !isWfdRecord(time.window)) gaps.push('观察窗口须有显式窗口定义。');
  const definitions = fieldDefinitions(definition), byCode = new Map(definitions.map(field => [String(field.field_code), field]));
  if (new Set(mapping.fields.map(field => field.fieldCode)).size !== mapping.fields.length
    || mapping.fields.length !== definitions.length || mapping.fields.some(field => !byCode.has(field.fieldCode))) fail('FIELDS', '映射字段集合必须与逐字段合同完全相同，不能丢列、补列或重复。');
  const roleCodes = bar ? MARKET_ROLES.flatMap(role => bar[role] ? [bar[role]] : []) : [];
  if (new Set(roleCodes).size !== roleCodes.length || roleCodes.some(code => !byCode.has(code))) fail('FIELDS', '行情角色必须引用不同的实际合同字段。');
  const priceCodes = bar ? PRICE_ROLES.flatMap(role => bar[role] ? [bar[role]] : []) : [];
  const quantityCodes = bar ? QUANTITY_ROLES.flatMap(role => bar[role] ? [bar[role]] : []) : [];
  const overrides = object(definition.field_semantic_context);
  if (Object.keys(overrides).some(code => !byCode.has(code))) gaps.push('字段级语义引用了未声明的合同字段。');
  const adjustedFields = definitions.map(field => String(field.field_code)).filter(code =>
    Object.hasOwn(object(object(overrides[code]).financial), 'price_adjustment'));
  if (!market && (Object.hasOwn(financial, 'price_adjustment')
    || adjustedFields.length))
    gaps.push('目标合同已声明价格调整口径；须显式声明实际行情字段角色，不能省略 bar 跳过价格核对。');
  if (market) {
    if (!priceCodes.length && Object.hasOwn(financial, 'price_adjustment')) gaps.push('目标合同声明了价格调整口径，却没有声明任何价格角色。');
    if (adjustedFields.some(code => !priceCodes.includes(code))) gaps.push('字段已声明价格调整口径，却未绑定到实际价格角色。');
    if (!Number.isFinite(parseR1Utc(source?.acquired_at_utc))) gaps.push('来源实际取得时间未知或无效，不能证明行情区间已结束；不以请求时间或文件时间替代。');
    if (!['instrument', 'listing'].includes(String(target.subject.kind))) gaps.push('行情需要明确证券/挂牌业务身份；公司、名称或路径不能代替。');
    if (context.content_nature !== 'observed_fact') gaps.push('行情目标必须明确为已观测事实。');
    if (time.frequency !== bar.frequency || mapping.precision !== bar.frequency) gaps.push('行情频率、时间精度与目标合同必须明确一致。');
    if (!['natural', 'trading', 'observation_window'].includes(String(time.period_type))) gaps.push('行情业务时间类型未知或不支持。');
    if (priceCodes.length) {
      if (!['nominal', 'real'].includes(String(statistical.price_basis))) gaps.push('价格名义/实际口径未知；不能默认名义价格。');
      if (statistical.price_basis === 'real') gaps.push(semanticReference(statistical.base_period_ref)
        ? '当前 WFD 纯数据分支未实现基期引用解析；实际价格保留待适配，不能据引用形状签发通过。'
        : '实际价格缺完整固定基期定义；普通语义引用仅使用 kind/namespace/id/version/digest，不含 resolution。');
      const adjustment = object(financial.price_adjustment);
      if (adjustment.direction !== 'raw') gaps.push(adjustment.direction === 'adjusted'
        ? '当前行情分支仅承接明确原始价；复权方向和锚点须由受支持合同另行固定。' : '原始/复权价格口径未知。');
    }
  }
  if (object(context.version_axis).revision_mode === 'current_only_business'
    && (!['instrument', 'listing'].includes(String(target.subject.kind))
      || context.content_nature !== 'observed_fact' || !['day', 'minute'].includes(String(time.frequency))))
    gaps.push('当前 WFD 的 current_only_business 仅承接证券/挂牌主体的已观测日线或分钟表格；此目标须保留普通版本模式。');
  if (!market || target.coverage !== undefined) {
    const coverage = object(target.coverage);
    if (!isWfdRecord(coverage.scope) || !Object.keys(coverage.scope).length
      || !known(coverage.basis) || !known(coverage.completeness)
      || typeof coverage.absence_means !== 'string' || !coverage.absence_means.trim()) gaps.push('目标覆盖范围、依据、完整性与缺失含义须逐项明确。');
  }
  const measurements = new Map<string, WfdRecord>();
  for (const field of definitions) {
    const code = String(field.field_code), rule = mapping.fields.find(item => item.fieldCode === code)!;
    if (!fieldUnitKnown(field.unit_code, field.data_type) || !MEASUREMENT_NATURES.has(String(field.measurement_nature))
      || !known(field.time_role)) gaps.push(`${code}: 单位、计量性质或时间角色尚未明确。`);
    if (!knownUnitCompatible(field.unit_code, field.data_type)) gaps.push(`${code}: WFD 已知单位类别与字段类型不相容。`);
    if (!rule.state) gaps.push(`${code}: 缺明确值状态列，不默认 valid_value。`);
    const override = object(overrides[code]);
    if (['time', 'measurement', 'content', 'statistical', 'financial', 'coverage_quality'].some(axis => object(override[axis]).status === 'unknown')) gaps.push(`${code}: 字段语义仍有显式 unknown 状态。`);
    const measurement: WfdRecord = { ...object(context.measurement), unit_code: field.unit_code,
      measurement_nature: field.measurement_nature, ...object(override.measurement) };
    measurements.set(code, measurement);
    if (!fieldUnitKnown(measurement.unit_code, field.data_type) || measurement.unit_code !== field.unit_code) gaps.push(`${code}: 有效字段单位/币种与原字段合同冲突或未知，不能按旧单位比较。`);
    if (!known(measurement.measurement_nature) || measurement.measurement_nature !== field.measurement_nature) gaps.push(`${code}: 有效字段计量性质与原字段合同冲突或未知。`);
    if (['precision', 'sign', 'aggregation'].some(key => Object.hasOwn(measurement, key)
      && typeof measurement[key] !== 'number' && !known(measurement[key]))) gaps.push(`${code}: 有效字段计量精度、符号或聚合语义仍未知。`);
    const fieldTime = { ...time, ...object(override.time) }, fieldFinancial = { ...financial, ...object(override.financial) };
    const fieldStatistical = { ...statistical, ...object(override.statistical) };
    if (!PERIOD_TYPES.has(String(fieldTime.period_type)) || !known(fieldTime.frequency)
      || fieldTime.timezone !== mapping.sourceTimezone || fieldTime.interval !== 'half_open'
      || market && fieldTime.frequency !== bar!.frequency) gaps.push(`${code}: 字段级周期、频率、时区或区间与行时间映射冲突。`);
    if (fieldTime.period_type === 'trading' && !calendarReference(fieldTime.calendar_ref)) gaps.push(`${code}: 交易周期须有完整固定日历引用。`);
    if (fieldTime.period_type === 'accounting' && !calendarReference(fieldTime.accounting_calendar_ref)) gaps.push(`${code}: 会计周期须有完整固定日历引用。`);
    if (fieldTime.period_type === 'observation_window' && !isWfdRecord(fieldTime.window)) gaps.push(`${code}: 观察窗口须有显式定义。`);
    const fieldNature = object(override.content).content_nature;
    if (fieldNature !== undefined && fieldNature !== context.content_nature) gaps.push(`${code}: 字段性质与本次明确采用的信息性质冲突。`);
    if (priceCodes.includes(code) && object(fieldFinancial.price_adjustment).direction !== 'raw') gaps.push(`${code}: 字段级复权口径与原始行情冲突。`);
    if (priceCodes.includes(code) && fieldStatistical.price_basis !== statistical.price_basis) gaps.push(`${code}: 字段级价格基准与行情合同冲突。`);
    if (quantityCodes.includes(code)
      && object(override.measurement).aggregation !== 'period_total') gaps.push(`${code}: 字段合同须明确为本区间总量 period_total；不能把盘中累计量当单分钟量。`);
  }
  if (priceCodes.length > 1 && new Set(priceCodes.map(code => measurements.get(code)!.unit_code)).size !== 1) gaps.push('已声明价格角色的有效单位或币种不一致。');
  for (const code of roleCodes) {
    const field = byCode.get(code)!;
    if (!['decimal', 'integer'].includes(String(field.data_type))) gaps.push(`${String(code)}: 行情数值必须为明确十进制或整数字符串。`);
    if (measurements.get(code)!.measurement_nature !== (priceCodes.includes(code) ? 'stock' : 'flow')) gaps.push(`${code}: 价格与量额的有效存量/期间流量性质未明确。`);
  }
  result.checkScope = ['explicit_contract_fields', 'effective_field_measurement',
    market ? 'declared_market_bar_semantics' : 'general_tabular_semantics'];
  if (target.coverage !== undefined && !gaps.some(gap => gap.startsWith('目标覆盖范围'))) result.checkScope.push('explicit_coverage_declaration');
  result.gaps = [...new Set(gaps)];
  return result;
}

/** Reads only already processed rows. Missing semantics never becomes a passed quality claim. */
export function checkR1TabularRows(rows: readonly unknown[], declaration: unknown): R1TabularCompilation & { rows: WfdRecord[]; quality: 'pass' | 'indeterminate' } {
  const compiled = compileR1TabularDeclaration(declaration);
  if (!compiled.applicable) fail('DECLARATION', '未提供显式 R1 表格声明。');
  const { mapping, target, source } = readDeclaration(declaration), definitions = fieldDefinitions(object(target.definition));
  const bar = mapping.bar, acquired = parseR1Utc(source?.acquired_at_utc);
  const priceSignatures = bar ? marketPriceSignatures(object(target.definition), mapping) : new Map<string, string | null>();
  if (rows.length < 1 || rows.length > 5000) fail('BUDGET', '表格小切片需要 1–5000 行；没有截断输入或扩大预算。');
  const keys = new Set<string>(), allowDuplicateKeys = target.inputMode === 'partial_observation';
  let checkedOhlc = true, checkedPartialBounds = true, checkedQuantities = true, checkedPositivePrices = true;
  let anyPartialBound = false;
  const mapped = rows.map((raw, index) => {
    if (!isWfdRecord(raw)) fail('ROW', `第 ${index + 1} 行不是实际加工对象。`);
    const key = raw[mapping.businessKey]; text(key, 128);
    if (!allowDuplicateKeys && keys.has(String(key))) fail('KEY', `第 ${index + 1} 行业务键重复。`); keys.add(String(key));
    const values: WfdRecord = {};
    for (const field of definitions) {
      const rule = mapping.fields.find(item => item.fieldCode === field.field_code)!;
      if (!Object.hasOwn(raw, rule.value)) fail('VALUE', `${String(field.field_code)} 没有实际加工值列。`);
      const state = rule.state ? raw[rule.state] : undefined;
      if (state === undefined && !rule.state) continue;
      if (typeof state !== 'string') fail('STATE', `${String(field.field_code)} 没有明确状态值。`);
      const value = raw[rule.value]; checkCell(String(field.data_type), state, value, String(field.field_code));
      values[String(field.field_code)] = { data_type: field.data_type, value_state: state, value };
    }
    const row: WfdRecord = { business_key: key, subject: target.subject, observation_time: mappedTime(raw, mapping), values };
    if (bar && Number.isFinite(acquired) && parseR1Utc(object(row.observation_time).latest_exclusive_utc) > acquired) fail('BAR_NOT_CLOSED', '行情区间终点晚于冻结来源的实际取得时间；未结束的日线/分钟不能作为完整行情通过。');
    if (bar?.frequency === 'minute' && (parseR1Utc(object(row.observation_time).latest_exclusive_utc)
      - parseR1Utc(object(row.observation_time).earliest_utc) !== 60_000
      || parseR1Utc(object(row.observation_time).earliest_utc) % 60_000 !== 0)) fail('TIME', 'minute 频率必须是明确的一分钟完整边界区间；不把多分钟或累计窗口当单分钟。');
    if (mapping.publicTime) row.public_time = mappedTime(raw, mapping.publicTime);
    if (bar) {
      const checked = checkBar(values, bar, priceSignatures, compiled.gaps.length === 0);
      checkedOhlc &&= checked.ohlc; checkedPartialBounds &&= checked.partialBounds;
      checkedQuantities &&= checked.quantities; checkedPositivePrices &&= checked.positivePrices;
      anyPartialBound ||= checked.anyPartialBound;
    }
    return row;
  });
  const checkScope = [...compiled.checkScope, ...(allowDuplicateKeys ? ['business_keys_for_authoritative_duplicate_review'] : ['unique_business_keys']), 'explicit_utc_intervals'];
  if (mapping.fields.every(field => !!field.state)) checkScope.push('explicit_value_states');
  if (bar && PRICE_ROLES.every(role => !!bar[role]) && checkedOhlc) checkScope.push('exact_decimal_ohlc');
  else if (bar && anyPartialBound && checkedPartialBounds) checkScope.push('partial_decimal_price_bounds');
  if (bar && PRICE_ROLES.some(role => !!bar[role]) && checkedPositivePrices) checkScope.push('positive_declared_market_prices');
  if (bar && QUANTITY_ROLES.some(role => !!bar[role]) && checkedQuantities) checkScope.push('nonnegative_volume_amount');
  if (bar && Number.isFinite(acquired)) checkScope.push('bar_closed_by_acquisition');
  const priceCodes = bar ? PRICE_ROLES.flatMap(role => bar[role] ? [bar[role]] : []) : [];
  const priceComparable = priceCodes.length < 2 || (priceCodes.every(code => priceSignatures.get(code) !== null)
    && new Set(priceCodes.map(code => priceSignatures.get(code))).size === 1);
  const gaps = [...compiled.gaps, ...(priceComparable ? [] : ['已声明价格角色的有效单位或字段价格口径未知/冲突，未执行对应价格关系比较。'])];
  return { ...compiled, checkScope, gaps, rows: mapped, quality: gaps.length ? 'indeterminate' : 'pass' };
}

function readDeclaration(value: unknown): Declaration {
  if (!isWfdRecord(value) || !isWfdRecord(value.target) || !isWfdRecord(value.mapping)) fail('DECLARATION', '表格映射与目标声明必须完整冻结。');
  const mapping = value.mapping;
  exact(mapping, ['kind', 'businessKey', 'earliestUtc', 'latestExclusiveUtc', 'precision', 'sourceTimezone', 'fields', 'bar', 'publicTime']);
  if (mapping.kind !== 'tabular_rows' || !Array.isArray(mapping.fields) || mapping.fields.length < 1 || mapping.fields.length > 256) fail('MAPPING', '需要 1–256 个逐字段映射。');
  text(mapping.businessKey, 128); checkTimeMapping(mapping);
  if (mapping.bar !== undefined) {
    const bar = mapping.bar;
    if (!isWfdRecord(bar)) fail('MAPPING', '行情角色必须是明确对象。');
    exact(bar, ['frequency', ...MARKET_ROLES]);
    if (!['day', 'minute'].includes(String(bar.frequency))) fail('MAPPING', '本批只支持明确日线或分钟行情。');
    if (!MARKET_ROLES.some(role => bar[role] !== undefined)) fail('MAPPING', '部分行情至少须显式声明一个实际角色。');
    for (const role of MARKET_ROLES) if (bar[role] !== undefined) text(bar[role], 128);
  }
  for (const field of mapping.fields) {
    if (!isWfdRecord(field)) fail('MAPPING', '逐字段映射必须为对象。');
    exact(field, ['fieldCode', 'value', 'state']); text(field.fieldCode, 128); text(field.value, 128);
    if (field.state !== undefined) text(field.state, 128);
  }
  if (mapping.publicTime !== undefined) { if (!isWfdRecord(mapping.publicTime)) fail('MAPPING', '公开时间必须是显式列映射。'); exact(mapping.publicTime, ['earliestUtc', 'latestExclusiveUtc', 'precision', 'sourceTimezone']); checkTimeMapping(mapping.publicTime); }
  if (!isWfdRecord(value.target.subject) || !isWfdRecord(value.target.definition)) fail('DECLARATION', '缺对象或逐字段产品定义。');
  return value as unknown as Declaration;
}
function fieldDefinitions(definition: WfdRecord): WfdRecord[] {
  const fields = definition.field_definitions;
  if (!Array.isArray(fields) || !fields.length || fields.length > 256 || !fields.every(isWfdRecord)
    || fields.some(field => !known(field.field_code) || !['decimal', 'integer', 'text', 'boolean'].includes(String(field.data_type)))
    || new Set(fields.map(field => field.field_code)).size !== fields.length) fail('DEFINITION', '需要唯一且类型明确的逐字段定义。');
  return fields;
}
function checkTimeMapping(mapping: WfdRecord): void {
  for (const field of ['earliestUtc', 'latestExclusiveUtc', 'sourceTimezone']) text(mapping[field], 128);
  if (!['day', 'minute', 'second'].includes(String(mapping.precision))) fail('TIME', '必须明确时间精度。');
}
function mappedTime(raw: WfdRecord, mapping: R1TimeMapping): WfdRecord {
  const start = raw[mapping.earliestUtc], end = raw[mapping.latestExclusiveUtc], first = parseR1Utc(start), last = parseR1Utc(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) fail('TIME', '业务时间必须是有效且终点晚于起点的明确 UTC 区间；未补日历或猜测时区。');
  return { status: 'known', precision: mapping.precision, earliest_utc: start, latest_exclusive_utc: end, source_timezone: mapping.sourceTimezone };
}
function checkCell(type: string, state: string, value: unknown, code: string): void {
  if (NULL_STATES.has(state)) { if (value !== null) fail('VALUE_STATE', `${code}: 缺失状态必须保留 null，不能把缺失写成零。`); return; }
  if (!['valid_value', 'reported_zero'].includes(state)) fail('VALUE_STATE', `${code}: 不支持该值状态。`);
  if (type === 'decimal' || type === 'integer') {
    if (typeof value !== 'string' || value.length > 128 || !(type === 'decimal' ? /^-?(0|[1-9]\d*)(\.\d+)?$/u : /^-?(0|[1-9]\d*)$/u).test(value)) fail('VALUE', `${code}: 数值必须保留完整规范字符串，不能转成浮点数。`);
    const unsigned = value.replace(/^-/, ''), [whole, fraction = ''] = unsigned.split('.');
    if (whole!.length + fraction.length > 38 || fraction.length > 18) fail('PRECISION', `${code}: 数值超过 WFD 已发布精度能力。`);
    if (state === 'reported_zero' && /[1-9]/u.test(value)) fail('VALUE_STATE', `${code}: reported_zero 必须确为零。`);
  } else if (type === 'text' ? typeof value !== 'string' : typeof value !== 'boolean') fail('VALUE', `${code}: 值类型与合同不同。`);
  if (state === 'reported_zero' && value !== '0' && value !== false) fail('VALUE_STATE', `${code}: reported_zero 必须符合 WFD 的零值表达。`);
}
function marketPriceSignatures(definition: WfdRecord, mapping: R1TabularMapping): Map<string, string | null> {
  const context = object(definition.semantic_context), byCode = new Map(fieldDefinitions(definition).map(field => [String(field.field_code), field]));
  const signatures = new Map<string, string | null>(), bar = mapping.bar!;
  for (const code of PRICE_ROLES.flatMap(role => bar[role] ? [bar[role]] : [])) {
    const field = byCode.get(code)!, override = object(object(definition.field_semantic_context)[code]);
    const measurement = { ...object(context.measurement), unit_code: field.unit_code,
      measurement_nature: field.measurement_nature, ...object(override.measurement) };
    if (!known(measurement.unit_code) || measurement.unit_code !== field.unit_code
      || measurement.measurement_nature !== 'stock' || measurement.measurement_nature !== field.measurement_nature
      || ['measurement', 'financial', 'statistical'].some(axis => object(override[axis]).status === 'unknown')) {
      signatures.set(code, null); continue;
    }
    const time = { ...object(context.time), ...object(override.time) };
    if (time.frequency !== bar.frequency || time.timezone !== mapping.sourceTimezone || time.interval !== 'half_open') {
      signatures.set(code, null); continue;
    }
    const financial = { ...object(context.financial), ...object(override.financial) };
    const statistical = { ...object(context.statistical), ...object(override.statistical) };
    signatures.set(code, canonicalWfdJson({ unit: measurement.unit_code, adjustment: object(financial.price_adjustment),
      price_basis: statistical.price_basis ?? null, base_period_ref: statistical.base_period_ref ?? null,
      currency_conversion_ref: financial.currency_conversion_ref ?? null }));
  }
  return signatures;
}
function checkBar(values: WfdRecord, bar: NonNullable<R1TabularMapping['bar']>, signatures: Map<string, string | null>,
  requireComplete: boolean): { ohlc: boolean; partialBounds: boolean; anyPartialBound: boolean; positivePrices: boolean; quantities: boolean } {
  const numericCell = (code: string) => {
    const cell = object(values[code]);
    return ['decimal', 'integer'].includes(String(cell.data_type)) && ['valid_value', 'reported_zero'].includes(String(cell.value_state))
      && typeof cell.value === 'string' ? cell : null;
  };
  const full = ['open', 'high', 'low', 'close', 'volume'].every(role => !!bar[role as keyof typeof bar]);
  if (full && requireComplete && ['open', 'high', 'low', 'close', 'volume'].some(role => !numericCell(bar[role as keyof typeof bar]!)))
    fail('BAR_INCOMPLETE', '完整 OHLCV 行缺有效价格或成交量；不能把部分行情称完整行情。');
  const priceRoles = PRICE_ROLES.filter(role => !!bar[role]);
  let positivePrices = priceRoles.length > 0;
  for (const role of priceRoles) {
    const cell = numericCell(bar[role]!);
    if (!cell) { positivePrices = false; continue; }
    const value = String(cell.value);
    if (value.startsWith('-') || !/[1-9]/u.test(value)) fail('OHLC', `${role}: 已声明行情价格必须为正。`);
  }
  const pairs = [['high', 'low'], ['high', 'open'], ['high', 'close'], ['open', 'low'], ['close', 'low']] as const;
  let comparablePairs = 0, checkedPairs = 0;
  const fullPriceSet = PRICE_ROLES.every(role => !!bar[role]);
  const fullPriceComparable = fullPriceSet && PRICE_ROLES.every(role => !!numericCell(bar[role]!))
    && PRICE_ROLES.every(role => !!signatures.get(bar[role]!))
    && new Set(PRICE_ROLES.map(role => signatures.get(bar[role]!))).size === 1;
  for (const [upper, lower] of pairs) {
    const upperCode = bar[upper], lowerCode = bar[lower];
    if (!upperCode || !lowerCode) continue;
    comparablePairs++;
    // A fully declared price bar is one coupled OHLC claim. If any role's unit or
    // price basis is unresolved, retain the old all-or-none relation check.
    if (fullPriceSet && !fullPriceComparable) continue;
    const upperCell = numericCell(upperCode), lowerCell = numericCell(lowerCode);
    if (!upperCell || !lowerCell || !signatures.get(upperCode) || signatures.get(upperCode) !== signatures.get(lowerCode)) continue;
    checkedPairs++;
    if (compareDecimal(String(upperCell.value), String(lowerCell.value)) < 0) fail('OHLC', '已声明价格关系违反高价/低价边界。');
  }
  const ohlc = PRICE_ROLES.every(role => !!bar[role]) && checkedPairs === pairs.length;
  const partialBounds = comparablePairs > 0 && checkedPairs === comparablePairs;
  let quantities = true;
  for (const code of QUANTITY_ROLES.flatMap(role => bar[role] ? [bar[role]] : [])) {
    const cell = numericCell(code);
    if (!cell) { quantities = false; continue; }
    if (String(cell.value).startsWith('-') && /[1-9]/u.test(String(cell.value))) fail('QUANTITY', `${code}: 行情成交量/成交额不能为负。`);
  }
  return { ohlc, partialBounds, anyPartialBound: checkedPairs > 0, positivePrices, quantities };
}
function compareDecimal(left: string, right: string): number {
  const scale = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0);
  const integer = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole! + fraction.padEnd(scale, '0')); };
  const a = integer(left), b = integer(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Preserve old scalar contract doubles; every new tabular receipt requires all four roles. */
export function readR1ContractBinding(value: WfdRecord, datasetId: string, productId: string, required: boolean): R1ContractBinding | undefined {
  if (value.contract_refs === undefined && value.contract_bundle_ref === undefined && !required) return undefined;
  const refs = object(value.contract_refs), bundle = object(value.contract_bundle_ref);
  if (Object.keys(refs).length !== R1_CONTRACT_ROLES.length || R1_CONTRACT_ROLES.some(role => !isWfdRecord(refs[role]))) fail('CONTRACTS', '真实回执缺四份独立固定合同，不能关联。');
  for (const role of R1_CONTRACT_ROLES) {
    const ref = object(refs[role]);
    if (!pinned(ref) || ref.kind !== 'contract' || ref.role !== role || ref.dataset_id !== datasetId || !known(ref.version)) fail('CONTRACTS', `${role}: 实际合同身份/版本/摘要不完整。`);
  }
  const roles = [...R1_CONTRACT_ROLES].sort(), body = { format_version: 'wfd.contract-bundle/1.0', product_id: productId, dataset_id: datasetId,
    roles, contracts: Object.fromEntries(roles.map(role => [role, refs[role]])) };
  if (!pinned(bundle) || bundle.kind !== 'contract_bundle' || bundle.dataset_id !== datasetId
    || bundle.digest !== 'sha256:' + wfdSha256(canonicalWfdJson(body)) || canonicalWfdJson(bundle.roles) !== canonicalWfdJson(roles)) fail('CONTRACTS', '实际四合同包与逐角色引用不一致。');
  return { contract_refs: refs, contract_bundle_ref: bundle };
}
export function assertR1ContractBinding(actual: WfdRecord, expected: R1ContractBinding): void {
  if (canonicalWfdJson(actual.contract_refs ?? null) !== canonicalWfdJson(expected.contract_refs)
    || canonicalWfdJson(actual.contract_bundle_ref ?? null) !== canonicalWfdJson(expected.contract_bundle_ref)) fail('CONTRACTS', '固定读回四合同与原实际发布回执不同。');
}
export function frozenR1RowMatches(expected: WfdRecord, actual: WfdRecord): boolean {
  return Object.keys(expected).every(key => Object.hasOwn(actual, key) && canonicalWfdJson(expected[key]) === canonicalWfdJson(actual[key]));
}
/** Explicit UTC, at most millisecond precision; never roll dates or discard fractional digits. */
export function parseR1Utc(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u.test(value)) return NaN;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return NaN;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/u, (_match: string, fraction?: string) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  return new Date(millis).toISOString() === normalized ? millis : NaN;
}
function pinned(value: unknown): boolean { return isWfdRecord(value) && known(value.id) && known(value.version)
  && value.resolution === 'pinned' && typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.digest); }
function semanticReference(value: unknown): boolean { return isWfdRecord(value) && Object.keys(value).length === 5
  && ['kind', 'namespace', 'id', 'version'].every(key => identifier(value[key]))
  && typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.digest); }
function calendarReference(value: unknown): boolean { return isWfdRecord(value) && Object.keys(value).length === 9
  && ['kind', 'namespace', 'id', 'version', 'dataset_id', 'resolution', 'dependency_type'].every(key => identifier(value[key]))
  && value.kind === 'product_snapshot' && value.namespace === 'wfd.product' && value.resolution === 'pinned'
  && value.required === true && value.dependency_type === 'read' && typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.digest); }
function identifier(value: unknown): boolean { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value); }
function known(value: unknown): boolean { return typeof value === 'string' && !!value.trim() && !/^(unknown|unspecified|native_unverified|not_applicable)$/iu.test(value); }
function fieldUnitKnown(unit: unknown, dataType: unknown): boolean {
  return known(unit) || unit === 'not_applicable' && (dataType === 'text' || dataType === 'boolean');
}
function knownUnitCompatible(unit: unknown, dataType: unknown): boolean {
  const unitClass = KNOWN_UNIT_CLASS[String(unit).toLowerCase()];
  if (!unitClass) return true;
  return unitClass === 'numeric' ? dataType === 'decimal' || dataType === 'integer'
    : unitClass === 'text' ? dataType === 'text'
      : unitClass === 'boolean' ? dataType === 'boolean' : dataType === 'text' || dataType === 'boolean';
}
function object(value: unknown): WfdRecord { return isWfdRecord(value) ? value : {}; }
function text(value: unknown, max: number): void { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('MAPPING', '映射字段缺失、包含控制字符或超过预算。'); }
function exact(value: WfdRecord, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail('MAPPING', '不接受未声明的表格映射字段。'); }
function fail(code: string, message: string): never { throw new TaskError('R1_TABULAR_' + code, message); }

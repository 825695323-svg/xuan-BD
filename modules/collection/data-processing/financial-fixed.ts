import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { isExplicitUtcInstant } from '../../../contracts/financial-value.js';
import { readFixedHistorySelection, selectWfdFixedRecords, type WfdFixedRecordReader, type WfdFixedHistorySelection } from './wfd-fixed-selection.js';

export const FINANCIAL_FIXED_VERSION = 'bd-financial-fixed/1';
export const FINANCIAL_MAPPING_VERSION = 'cas-primary-statements/1';
export const FINANCIAL_MAPPING_V2_VERSION = 'cas-primary-statements/2';
export type FinancialMappingVersion = typeof FINANCIAL_MAPPING_VERSION | typeof FINANCIAL_MAPPING_V2_VERSION;
export type FinancialIndustryTemplate = 'general_industrial' | 'commercial_bank' | 'insurance' | 'securities';
export type FinancialColumnRole = 'current_period' | 'prior_period_comparative_unchanged' | 'prior_period_restated';
export interface FinancialCalculation {
  version: typeof FINANCIAL_FIXED_VERSION;
  operation: 'standardize';
  inputs: { snapshotId: string; productId: string; businessKeys: string[] }[];
  history?: WfdFixedHistorySelection;
  compatibleInputs?: { periodType: 'duration' | 'instant'; periods: { startDate: string; endDate: string }[] };
  mappingProfile?: FinancialMappingVersion;
  industryTemplate?: FinancialIndustryTemplate;
  allowUnitScale?: boolean;
  articulationCheck?: boolean;
}
export type FinancialReader = WfdFixedRecordReader;
function fail(message: string): never { throw new TaskError('FINANCIAL_FIXED', message); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) && !/^(latest|current)$/iu.test(value);
const codes: Record<string, { code: string; additive: boolean }> = {
  '其中：营业收入': { code: 'revenue', additive: true },
  '其中：营业成本': { code: 'cost_of_sales', additive: true },
  '五、净利润（净亏损以“－”号填列）': { code: 'net_profit_total', additive: true },
  '五、净利润（净亏损以“-”号填列）': { code: 'net_profit_total', additive: true },
  '资产总计': { code: 'total_assets', additive: false },
  '负债合计': { code: 'total_liabilities', additive: false },
  '所有者权益（或股东权益）合计': { code: 'total_equity', additive: false },
  '经营活动产生的现金流量净额': { code: 'net_cash_operating', additive: true },
  '投资活动产生的现金流量净额': { code: 'net_cash_investing', additive: true },
  '筹资活动产生的现金流量净额': { code: 'net_cash_financing', additive: true },
  '五、现金及现金等价物净增加额': { code: 'net_cash_increase', additive: true },
  '六、期末现金及现金等价物余额': { code: 'cash_and_equivalents_end', additive: false },
};

export interface FinancialConceptRule {
  code: string;
  statement: 'income_statement' | 'balance_sheet' | 'cash_flow' | 'note';
  periodType: 'duration' | 'instant';
  additive: boolean;
  unitDimension: 'money' | 'money_per_share' | 'ratio';
  templates: readonly FinancialIndustryTemplate[];
  aliases: readonly string[];
}

const ALL_TEMPLATES: readonly FinancialIndustryTemplate[] = ['general_industrial', 'commercial_bank', 'insurance', 'securities'];

export const CAS_CHART_OF_ACCOUNTS_V2: readonly FinancialConceptRule[] = Object.freeze([
  // 利润表通用与一般工商企业核心科目
  { code: 'total_operating_revenue', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['一、营业总收入', '营业总收入'] },
  { code: 'revenue', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['其中：营业收入', '一、营业收入', '营业收入'] },
  { code: 'total_operating_cost', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['二、营业总成本', '营业总成本'] },
  { code: 'cost_of_sales', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['其中：营业成本', '营业成本'] },
  { code: 'taxes_and_surcharges', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['税金及附加'] },
  { code: 'selling_expenses', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['销售费用'] },
  { code: 'general_and_admin_expenses', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['管理费用', '业务及管理费'] },
  { code: 'rd_expenses', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['研发费用'] },
  { code: 'financial_expenses', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial'], aliases: ['财务费用'] },
  { code: 'interest_expense', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial', 'commercial_bank', 'securities'], aliases: ['其中：利息费用', '利息支出'] },
  { code: 'interest_income', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['general_industrial', 'commercial_bank', 'securities'], aliases: ['利息收入'] },
  { code: 'asset_impairment_loss', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['资产减值损失', '资产减值损失（损失以“-”号填列）'] },
  { code: 'credit_impairment_loss', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['信用减值损失', '信用减值损失（损失以“-”号填列）'] },
  { code: 'operating_profit', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['三、营业利润', '营业利润', '三、营业利润（亏损以“－”号填列）', '三、营业利润（亏损以“-”号填列）'] },
  { code: 'profit_before_tax', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['四、利润总额', '利润总额', '四、利润总额（亏损总额以“－”号填列）', '四、利润总额（亏损总额以“-”号填列）'] },
  { code: 'income_tax_expense', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['减：所得税费用', '所得税费用'] },
  { code: 'net_profit_total', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['五、净利润（净亏损以“－”号填列）', '五、净利润（净亏损以“-”号填列）', '五、净利润', '净利润'] },
  { code: 'net_profit_parent', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['归属于母公司股东的净利润', '归属于母公司所有者的净利润', '（一）归属于母公司所有者的净利润'] },
  { code: 'net_profit_deducted_non_recurring', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['归属于上市公司股东的扣除非经常性损益的净利润', '扣除非经常性损益后的归属于母公司股东的净利润'] },
  { code: 'minority_interest_profit', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['少数股东损益', '（二）少数股东损益'] },
  // 非线性每股与收益率科目（严禁将半年报与一季报直接相减算单季）
  { code: 'basic_eps', statement: 'income_statement', periodType: 'duration', additive: false, unitDimension: 'money_per_share', templates: ALL_TEMPLATES, aliases: ['（一）基本每股收益', '基本每股收益（元/股）', '基本每股收益'] },
  { code: 'diluted_eps', statement: 'income_statement', periodType: 'duration', additive: false, unitDimension: 'money_per_share', templates: ALL_TEMPLATES, aliases: ['（二）稀释每股收益', '稀释每股收益（元/股）', '稀释每股收益'] },
  { code: 'weighted_roe', statement: 'income_statement', periodType: 'duration', additive: false, unitDimension: 'ratio', templates: ALL_TEMPLATES, aliases: ['加权平均净资产收益率'] },
  // 资产负债表核心科目
  { code: 'cash_and_bank', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['货币资金'] },
  { code: 'accounts_receivable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['应收账款'] },
  { code: 'notes_and_accounts_receivable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['应收票据及应收账款'] },
  { code: 'prepayments', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['预付款项'] },
  { code: 'inventories', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['存货'] },
  { code: 'total_current_assets', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['流动资产合计'] },
  { code: 'fixed_assets', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['固定资产'] },
  { code: 'construction_in_progress', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['在建工程'] },
  { code: 'intangible_assets', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['无形资产'] },
  { code: 'goodwill', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['商誉'] },
  { code: 'total_non_current_assets', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['非流动资产合计'] },
  { code: 'total_assets', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['资产总计', '资产总额'] },
  { code: 'short_term_borrowings', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['短期借款'] },
  { code: 'accounts_payable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['应付账款'] },
  { code: 'notes_and_accounts_payable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['应付票据及应付账款'] },
  { code: 'contract_liabilities', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['合同负债'] },
  { code: 'total_current_liabilities', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['流动负债合计'] },
  { code: 'long_term_borrowings', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['长期借款'] },
  { code: 'bonds_payable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['应付债券'] },
  { code: 'total_non_current_liabilities', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['general_industrial'], aliases: ['非流动负债合计'] },
  { code: 'total_liabilities', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['负债合计', '负债总额'] },
  { code: 'share_capital', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['实收资本（或股本）', '股本'] },
  { code: 'retained_earnings', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['未分配利润'] },
  { code: 'equity_parent', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['归属于母公司所有者权益合计', '归属于母公司股东权益合计'] },
  { code: 'minority_interest', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['少数股东权益'] },
  { code: 'total_equity', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['所有者权益（或股东权益）合计', '股东权益合计', '所有者权益合计'] },
  // 现金流量表核心科目
  { code: 'net_cash_operating', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['经营活动产生的现金流量净额'] },
  { code: 'capex_cash_paid', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['购建固定资产、无形资产和其他长期资产支付的现金'] },
  { code: 'net_cash_investing', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['投资活动产生的现金流量净额'] },
  { code: 'net_cash_financing', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['筹资活动产生的现金流量净额'] },
  { code: 'fx_effect_on_cash', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['四、汇率变动对现金及现金等价物的影响', '汇率变动对现金及现金等价物的影响'] },
  { code: 'net_cash_increase', statement: 'cash_flow', periodType: 'duration', additive: true, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['五、现金及现金等价物净增加额', '现金及现金等价物净增加额'] },
  { code: 'cash_and_equivalents_begin', statement: 'cash_flow', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['加：期初现金及现金等价物余额', '期初现金及现金等价物余额'] },
  { code: 'cash_and_equivalents_end', statement: 'cash_flow', periodType: 'instant', additive: false, unitDimension: 'money', templates: ALL_TEMPLATES, aliases: ['六、期末现金及现金等价物余额', '期末现金及现金等价物余额'] },
  // 商业银行专属科目
  { code: 'bank_net_interest_income', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['commercial_bank'], aliases: ['利息净收入', '一、利息净收入'] },
  { code: 'bank_net_fee_commission_income', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['commercial_bank'], aliases: ['手续费及佣金净收入'] },
  { code: 'bank_loans_and_advances', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['commercial_bank'], aliases: ['发放贷款和垫款'] },
  { code: 'bank_customer_deposits', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['commercial_bank'], aliases: ['吸收存款'] },
  // 保险公司专属科目（CAS 25 新保险合同准则）
  { code: 'ins_service_revenue', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['insurance'], aliases: ['保险服务收入'] },
  { code: 'ins_service_expenses', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['insurance'], aliases: ['保险服务费用'] },
  { code: 'ins_contract_liabilities', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['insurance'], aliases: ['保险合同负债'] },
  // 证券公司专属科目
  { code: 'sec_brokerage_fee_net', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['securities'], aliases: ['经纪业务手续费净收入'] },
  { code: 'sec_ib_fee_net', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['securities'], aliases: ['投资银行业务手续费净收入'] },
  { code: 'sec_am_fee_net', statement: 'income_statement', periodType: 'duration', additive: true, unitDimension: 'money', templates: ['securities'], aliases: ['资产管理业务手续费净收入'] },
  { code: 'sec_margin_accounts_receivable', statement: 'balance_sheet', periodType: 'instant', additive: false, unitDimension: 'money', templates: ['securities'], aliases: ['融出资金'] },
]);

export function resolveFinancialConceptRule(
  originalConcept: string,
  profile: FinancialMappingVersion = FINANCIAL_MAPPING_VERSION,
  template: FinancialIndustryTemplate = 'general_industrial',
): { code: string; additive: boolean; periodType?: 'duration' | 'instant'; unitDimension?: 'money' | 'money_per_share' | 'ratio' } | null {
  if (profile === FINANCIAL_MAPPING_VERSION) {
    return codes[originalConcept] ?? null;
  }
  const hit = CAS_CHART_OF_ACCOUNTS_V2.find(rule => rule.templates.includes(template)
    && (rule.code === originalConcept || rule.aliases.includes(originalConcept)));
  return hit ? { code: hit.code, additive: hit.additive, periodType: hit.periodType, unitDimension: hit.unitDimension } : null;
}

const UNIT_SCALE_POWERS: Record<string, { baseUnit: string; dimension: 'money' | 'money_per_share' | 'ratio'; power10: number; factor: string }> = {
  cny: { baseUnit: 'cny', dimension: 'money', power10: 0, factor: '1' },
  cny_thousand: { baseUnit: 'cny', dimension: 'money', power10: 3, factor: '1000' },
  cny_ten_thousand: { baseUnit: 'cny', dimension: 'money', power10: 4, factor: '10000' },
  cny_10000: { baseUnit: 'cny', dimension: 'money', power10: 4, factor: '10000' },
  cny_million: { baseUnit: 'cny', dimension: 'money', power10: 6, factor: '1000000' },
  cny_hundred_million: { baseUnit: 'cny', dimension: 'money', power10: 8, factor: '100000000' },
  cny_100million: { baseUnit: 'cny', dimension: 'money', power10: 8, factor: '100000000' },
  cny_per_share: { baseUnit: 'cny_per_share', dimension: 'money_per_share', power10: 0, factor: '1' },
  ratio: { baseUnit: 'ratio', dimension: 'ratio', power10: 0, factor: '1' },
  percent: { baseUnit: 'percent', dimension: 'ratio', power10: 0, factor: '1' },
};

/**
 * 显式单位倍率无损换算并保留原披露精度（最低有效位半径 half-ULP）：
 * 例如 "12.3"（单位 cny_million，power10=6，小数位 1）-> 换算后为 "12300000"，
 * 原最低有效位 ulp = 10^(6-1) = 100000 cny，误差半径 halfUlp = "50000" cny。
 */
export function scaleFinancialUnitValue(rawLexeme: string, sourceUnit: string): {
  scaledValue: string;
  baseUnit: string;
  sourceUnit: string;
  scaleFactor: string;
  sourceFractionDigits: number;
  declaredPrecisionHalfUlp: string;
} {
  const rule = UNIT_SCALE_POWERS[sourceUnit];
  if (!rule) fail(`未知或未授权换算的财务单位 ${sourceUnit}；未知倍率不得隐式换算。`);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(rawLexeme)) fail(`财务数值 ${rawLexeme} 不是规范十进制词面。`);
  const negative = rawLexeme.startsWith('-');
  const unsigned = negative ? rawLexeme.slice(1) : rawLexeme;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const sourceFractionDigits = fraction.length;
  const digits = whole + fraction;
  let scaledUnsigned: string;
  if (rule.power10 >= sourceFractionDigits) {
    const rawInt = (digits + '0'.repeat(rule.power10 - sourceFractionDigits)).replace(/^0+(?=\d)/u, '');
    scaledUnsigned = rawInt || '0';
  } else {
    const splitPos = digits.length - (sourceFractionDigits - rule.power10);
    const left = digits.slice(0, splitPos).replace(/^0+(?=\d)/u, '') || '0';
    const right = digits.slice(splitPos);
    scaledUnsigned = `${left}.${right}`;
  }
  const scaledValue = scaledUnsigned === '0' || /^0\.0+$/u.test(scaledUnsigned) ? scaledUnsigned : (negative ? '-' + scaledUnsigned : scaledUnsigned);
  // half-ULP in base unit = 0.5 * 10^(power10 - sourceFractionDigits) = 5 * 10^(power10 - sourceFractionDigits - 1)
  const exp = rule.power10 - sourceFractionDigits - 1;
  const declaredPrecisionHalfUlp = exp >= 0 ? '5' + '0'.repeat(exp) : '0.' + '0'.repeat(-exp - 1) + '5';
  return {
    scaledValue,
    baseUnit: rule.baseUnit,
    sourceUnit,
    scaleFactor: rule.factor,
    sourceFractionDigits,
    declaredPrecisionHalfUlp,
  };
}

export interface ArticulationTermInput {
  concept: string;
  scaledValue: string;
  declaredPrecisionHalfUlp: string;
  subjectKey?: string;
  periodKey?: string;
  startDate?: string;
  endDate?: string;
  scope?: string;
  dimension?: string;
  currency?: string;
  accountingStandard?: string;
  comparabilityBasis?: string;
  reportVersion?: string;
  columnRole?: string;
}
export interface ArticulationCheckResult {
  ruleId: 'BS-01' | 'BS-02-ASSETS' | 'BS-02-LIABILITIES' | 'BS-03' | 'IS-01' | 'IS-02' | 'CF-01' | 'CF-02';
  formula: string;
  status: 'exact_match' | 'within_declared_quantization_tolerance' | 'discrepancy' | 'indeterminate';
  residual: string | null;
  toleranceRadius: string | null;
  missingConcepts: string[];
  duplicateConcepts?: string[];
  groupKey?: string;
}

const ARTICULATION_RULES: readonly {
  ruleId: ArticulationCheckResult['ruleId'];
  formula: string;
  terms: readonly { concept: string; weight: 1 | -1; optional?: boolean }[];
}[] = Object.freeze([
  { ruleId: 'BS-01', formula: 'total_assets - total_liabilities - total_equity = 0',
    terms: [{ concept: 'total_assets', weight: 1 }, { concept: 'total_liabilities', weight: -1 }, { concept: 'total_equity', weight: -1 }] },
  { ruleId: 'BS-02-ASSETS', formula: 'total_current_assets + total_non_current_assets - total_assets = 0',
    terms: [{ concept: 'total_current_assets', weight: 1 }, { concept: 'total_non_current_assets', weight: 1 }, { concept: 'total_assets', weight: -1 }] },
  { ruleId: 'BS-02-LIABILITIES', formula: 'total_current_liabilities + total_non_current_liabilities - total_liabilities = 0',
    terms: [{ concept: 'total_current_liabilities', weight: 1 }, { concept: 'total_non_current_liabilities', weight: 1 }, { concept: 'total_liabilities', weight: -1 }] },
  { ruleId: 'BS-03', formula: 'equity_parent + minority_interest - total_equity = 0',
    terms: [{ concept: 'equity_parent', weight: 1 }, { concept: 'minority_interest', weight: 1 }, { concept: 'total_equity', weight: -1 }] },
  { ruleId: 'IS-01', formula: 'profit_before_tax - income_tax_expense - net_profit_total = 0',
    terms: [{ concept: 'profit_before_tax', weight: 1 }, { concept: 'income_tax_expense', weight: -1 }, { concept: 'net_profit_total', weight: -1 }] },
  { ruleId: 'IS-02', formula: 'net_profit_parent + minority_interest_profit - net_profit_total = 0',
    terms: [{ concept: 'net_profit_parent', weight: 1 }, { concept: 'minority_interest_profit', weight: 1 }, { concept: 'net_profit_total', weight: -1 }] },
  { ruleId: 'CF-01', formula: 'net_cash_operating + net_cash_investing + net_cash_financing + fx_effect_on_cash - net_cash_increase = 0',
    terms: [{ concept: 'net_cash_operating', weight: 1 }, { concept: 'net_cash_investing', weight: 1 },
      { concept: 'net_cash_financing', weight: 1 }, { concept: 'fx_effect_on_cash', weight: 1, optional: true },
      { concept: 'net_cash_increase', weight: -1 }] },
  { ruleId: 'CF-02', formula: 'cash_and_equivalents_begin + net_cash_increase - cash_and_equivalents_end = 0',
    terms: [{ concept: 'cash_and_equivalents_begin', weight: 1 }, { concept: 'net_cash_increase', weight: 1 }, { concept: 'cash_and_equivalents_end', weight: -1 }] },
]);

function parseFixedDecimal(lexeme: string, scale: number): bigint {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const raw = BigInt(whole + fraction.padEnd(scale, '0'));
  return negative ? -raw : raw;
}
function formatFixedDecimal(val: bigint, scale: number): string {
  const negative = val < 0n;
  const abs = (negative ? -val : val).toString().padStart(scale + 1, '0');
  if (scale === 0) return (negative ? '-' : '') + abs;
  const whole = abs.slice(0, abs.length - scale);
  const fraction = abs.slice(abs.length - scale).replace(/0+$/u, '');
  return (negative ? '-' : '') + (fraction ? `${whole}.${fraction}` : whole);
}

function articulationGroupKey(item: ArticulationTermInput): string {
  return canonicalWfdJson({
    subjectKey: item.subjectKey ?? '',
    periodKey: item.periodKey ?? '',
    scope: item.scope ?? '',
    dimension: item.dimension ?? '',
    currency: item.currency ?? '',
    accountingStandard: item.accountingStandard ?? '',
    comparabilityBasis: item.comparabilityBasis ?? '',
    reportVersion: item.reportVersion ?? '',
    columnRole: item.columnRole ?? '',
  });
}

/**
 * C09 财报三表表内与跨表线性勾稽区间容限校验：
 * 先按主体、期间、报表合并范围、维度、币种、准则、可比口径、报告版本与列角色严格分组隔离（严禁跨企业或跨期拼凑“平衡”），
 * 并检测同组重复科目；再按 Σ(c_i * v_i) 计算残差 Δ，按 Σ(|c_i| * r_i) 计算量化容限半径 T，
 * 区分 exact_match（Δ=0）、within_declared_quantization_tolerance（0 < |Δ| <= T）、discrepancy（|Δ| > T）和 indeterminate。
 */
export function verifyFinancialStatementArticulation(items: readonly ArticulationTermInput[]): ArticulationCheckResult[] {
  const groups = new Map<string, ArticulationTermInput[]>();
  for (const item of items) {
    const key = articulationGroupKey(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  if (!groups.size) {
    groups.set(articulationGroupKey({ concept: '', scaledValue: '0', declaredPrecisionHalfUlp: '0' }), []);
  }
  const multiGroup = groups.size > 1;
  const results: ArticulationCheckResult[] = [];
  for (const [groupKey, groupItems] of groups.entries()) {
    const byConcept = new Map<string, ArticulationTermInput>();
    const counts = new Map<string, number>();
    for (const item of groupItems) {
      counts.set(item.concept, (counts.get(item.concept) ?? 0) + 1);
      byConcept.set(item.concept, item);
    }
    for (const rule of ARTICULATION_RULES) {
      const missing = rule.terms.filter(t => !t.optional && !byConcept.has(t.concept)).map(t => t.concept);
      const duplicates = rule.terms.filter(t => (counts.get(t.concept) ?? 0) > 1).map(t => t.concept);
      if (missing.length || duplicates.length) {
        results.push({
          ruleId: rule.ruleId,
          formula: rule.formula,
          status: 'indeterminate',
          residual: null,
          toleranceRadius: null,
          missingConcepts: missing,
          ...(duplicates.length ? { duplicateConcepts: duplicates } : {}),
          ...(multiGroup ? { groupKey } : {}),
        });
        continue;
      }
      const activeTerms = rule.terms.filter(t => byConcept.has(t.concept));
      const maxScale = Math.max(0, ...activeTerms.flatMap(t => {
        const entry = byConcept.get(t.concept)!;
        return [entry.scaledValue.split('.')[1]?.length ?? 0, entry.declaredPrecisionHalfUlp.split('.')[1]?.length ?? 0];
      }));
      let residualInt = 0n, toleranceInt = 0n;
      for (const term of activeTerms) {
        const entry = byConcept.get(term.concept)!;
        const val = parseFixedDecimal(entry.scaledValue, maxScale);
        const rad = parseFixedDecimal(entry.declaredPrecisionHalfUlp, maxScale);
        residualInt += BigInt(term.weight) * val;
        toleranceInt += rad < 0n ? -rad : rad;
      }
      const absResidual = residualInt < 0n ? -residualInt : residualInt;
      const status: ArticulationCheckResult['status'] = absResidual === 0n
        ? 'exact_match'
        : absResidual <= toleranceInt ? 'within_declared_quantization_tolerance' : 'discrepancy';
      results.push({
        ruleId: rule.ruleId,
        formula: rule.formula,
        status,
        residual: formatFixedDecimal(residualInt, maxScale),
        toleranceRadius: formatFixedDecimal(toleranceInt, maxScale),
        missingConcepts: [],
        ...(multiGroup ? { groupKey } : {}),
      });
    }
  }
  return results;
}
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && isExplicitUtcInstant(value + 'T00:00:00Z');
const COLUMN_ROLES: readonly FinancialColumnRole[] = ['current_period', 'prior_period_comparative_unchanged', 'prior_period_restated'];
export function readFinancialCalculation(raw: unknown): FinancialCalculation {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['version', 'operation', 'inputs', 'history', 'compatibleInputs',
    'mappingProfile', 'industryTemplate', 'allowUnitScale', 'articulationCheck'].includes(key))
    || raw.version !== FINANCIAL_FIXED_VERSION || raw.operation !== 'standardize'
    || !Array.isArray(raw.inputs) || !raw.inputs.length || raw.inputs.length > 16) fail('财务固定变换需要明确已登记版本、操作和固定输入引用，不能提交客户端数值。');
  if (raw.mappingProfile !== undefined && ![FINANCIAL_MAPPING_VERSION, FINANCIAL_MAPPING_V2_VERSION].includes(String(raw.mappingProfile) as FinancialMappingVersion))
    fail('科目映射档案版本不受支持。');
  if (raw.industryTemplate !== undefined && !ALL_TEMPLATES.includes(String(raw.industryTemplate) as FinancialIndustryTemplate))
    fail('行业报表模板须为 general_industrial / commercial_bank / insurance / securities 之一。');
  if (raw.allowUnitScale !== undefined && typeof raw.allowUnitScale !== 'boolean') fail('allowUnitScale 须为布尔值。');
  if (raw.articulationCheck !== undefined && typeof raw.articulationCheck !== 'boolean') fail('articulationCheck 须为布尔值。');
  for (const input of raw.inputs as unknown[]) {
    if (!isWfdRecord(input) || Object.keys(input).sort().join(',') !== 'businessKeys,productId,snapshotId'
      || !id(input.snapshotId) || !id(input.productId) || !Array.isArray(input.businessKeys) || !input.businessKeys.length
      || input.businessKeys.length > 1000 || !input.businessKeys.every(id) || new Set(input.businessKeys).size !== input.businessKeys.length) fail('固定输入须逐项指定真实快照、产品及准确业务键；不读取最新值或目录通配。');
  }
  if (raw.history !== undefined) readFixedHistorySelection(raw.history);
  if (raw.compatibleInputs !== undefined) {
    const spec = raw.compatibleInputs;
    if (!isWfdRecord(spec) || Object.keys(spec).sort().join(',') !== 'periodType,periods'
      || !['duration', 'instant'].includes(String(spec.periodType)) || !Array.isArray(spec.periods)
      || !spec.periods.length || spec.periods.length > 8) fail('相容财报输入须明确期间性质和最多八个所需期间，不隐式生成单季或TTM。');
    const seen = new Set<string>();
    for (const period of spec.periods) {
      if (!isWfdRecord(period) || Object.keys(period).sort().join(',') !== 'endDate,startDate'
        || !validDate(period.startDate) || !validDate(period.endDate) || period.startDate > period.endDate
        || spec.periodType === 'instant' && period.startDate !== period.endDate) fail('所需财报期间必须是实际有效日期及对应的时点/区间，不猜财年。');
      const key = period.startDate + '/' + period.endDate;
      if (seen.has(key)) fail('相容输入的所需期间不能重复。');
      seen.add(key);
    }
  }
  return structuredClone(raw) as unknown as FinancialCalculation;
}
const field = (row: WfdRecord, key: string): string => {
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values[key]) ? row.values[key] as WfdRecord : null;
  if (!cell || !['valid_value', 'reported_zero'].includes(String(cell.value_state)) || typeof cell.value !== 'string' || !cell.value.trim()) return fail(`固定输入缺明确 ${key}；不按同名或最新值补齐。`);
  return cell.value;
};
const optionalField = (row: WfdRecord, key: string): string | null => {
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values[key]) ? row.values[key] as WfdRecord : null;
  if (!cell || !['valid_value', 'reported_zero'].includes(String(cell.value_state)) || typeof cell.value !== 'string' || !cell.value.trim()) return null;
  return cell.value;
};
function assertFinancialValueUnit(row: WfdRecord, allowScale = false, expectedDimension: 'money' | 'money_per_share' | 'ratio' = 'money'): void {
  const rowUnit = field(row, 'unit');
  const cell = isWfdRecord(row.values) && isWfdRecord(row.values.value) ? row.values.value : null;
  const unit = cell && isWfdRecord(cell.unit) ? cell.unit : null;
  const unitCode = unit ? String(unit.unit_code ?? '') : '';
  if (rowUnit !== unitCode) {
    fail(`财务行内声明单位（${rowUnit}）与数值单元已解析单位（${unitCode || 'missing'}）冲突；拒绝换算。`);
  }
  const scaleRule = UNIT_SCALE_POWERS[unitCode];
  const validCode = !!scaleRule && scaleRule.dimension === expectedDimension && (allowScale ? true : scaleRule.power10 === 0);
  const def = unit?.definition && isWfdRecord(unit.definition) ? unit.definition : null;
  const validDim = !!def && def.dimension === expectedDimension && (allowScale
    ? Object.keys(def).every(k => ['dimension', 'scale_factor', 'currency', 'base_unit'].includes(k))
      && (def.scale_factor === undefined || String(def.scale_factor) === scaleRule?.factor)
      && (def.currency === undefined || String(def.currency) === 'CNY')
      && (def.base_unit === undefined || String(def.base_unit) === scaleRule?.baseUnit)
    : Object.keys(def).length === 1);
  if (!cell || (cell.data_type !== 'decimal' && cell.data_type !== 'integer') || !unit || !validCode || unit.resolved !== true
    || !validDim
    || unit.digest !== 'sha256:' + wfdSha256(canonicalWfdJson({ code: unit.unit_code, definition: unit.definition }))) {
    fail('财务数值单元须为十进制或整数，并具有与科目量纲及行内单位一致的已解析单位定义及摘要；未知尺度或冲突单位不能按行内标签参与变换。');
  }
}
const nextDay = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
export async function projectFinancialFixed(raw: FinancialCalculation, reader: FinancialReader, signal: AbortSignal) {
  const calculation = readFinancialCalculation(raw);
  const mappingProfile = calculation.mappingProfile ?? FINANCIAL_MAPPING_VERSION;
  const industryTemplate = calculation.industryTemplate ?? 'general_industrial';
  const allowUnitScale = calculation.allowUnitScale === true && mappingProfile === FINANCIAL_MAPPING_V2_VERSION;
  const fixed = await selectWfdFixedRecords(calculation.inputs.map(item => ({
    snapshotId: item.snapshotId, productId: item.productId, businessKeys: item.businessKeys,
  })), reader, signal, reason => fail(reason), calculation.history);
  const inputs = fixed.selections.map((selection, index) => ({
    ref: calculation.inputs[index]!, rows: selection.rows,
  }));
  const inputEvidence: WfdRecord[] = fixed.selections.map((selection, index) => ({
    ...calculation.inputs[index]!, selectedRows: selection.rows.length,
    selectedRowsSha256: selection.selectedRowsSha256, recordVersions: selection.recordVersions,
  }));
  let compatibility: WfdRecord | null = null;
  if (calculation.compatibleInputs) {
    const spec = calculation.compatibleInputs;
    if (new Set(calculation.inputs.map(input => input.snapshotId)).size !== 1) fail('相容财报输入必须固定同一目录快照，不能分别取各产品不同发布集合。');
    const selected = inputs.flatMap(input => input.rows);
    const expected = new Set(spec.periods.map(period => period.startDate + '/' + period.endDate));
    const seen = new Set<string>();
    let basis: string | undefined;
    for (const row of selected) {
      const original = field(row, 'concept');
      const mapping = resolveFinancialConceptRule(original, mappingProfile, industryTemplate);
      if (!mapping) fail('相容输入含未登记科目，不能丢弃该行后冒充完整期间集合。');
      const rowPeriodType = field(row, 'period_type');
      const validPeriodCompatibility = mappingProfile === FINANCIAL_MAPPING_V2_VERSION
        ? (spec.periodType === 'duration' ? mapping.additive && rowPeriodType === 'duration' : !mapping.additive && rowPeriodType === 'instant')
        : (spec.periodType === 'duration') === mapping.additive && rowPeriodType === spec.periodType;
      if (!validPeriodCompatibility)
        fail('财报流量、非线性比率与时点余额不相容；余额或每股收益/收益率等非线性科目不能作为累计流量差分输入。');
      const reportNature = field(row, 'report_nature');
      if (!['formal', 'correction', ...(mappingProfile === FINANCIAL_MAPPING_V2_VERSION ? ['restatement_carrier'] : [])].includes(reportNature))
        fail('相容输入只接受明确正式报告、更正或重述比较列载体，不能把预告/快报混入。');
      const colRole = optionalField(row, 'column_role');
      if (colRole !== null && !COLUMN_ROLES.includes(colRole as FinancialColumnRole))
        fail(`未知财报列角色 ${colRole}；须明确区分当期初报列与上年同期重述比较列。`);
      if (reportNature === 'restatement_carrier' && (colRole === null || colRole === 'current_period'))
        fail('重述比较列载体（restatement_carrier）必须显式声明比较列角色（prior_period_restated 或 prior_period_comparative_unchanged），不得缺省列角色或冒充当期列。');
      const start = field(row, 'start_date'), end = field(row, 'end_date');
      const period = start + '/' + end;
      if (!validDate(start) || !validDate(end) || !expected.has(period) || seen.has(period)) fail('财报期间不符、重复或存在混合版本；不任取最新报告。');
      seen.add(period);
      const identity = Object.fromEntries(['subject_scheme', 'subject_code', 'accounting_standard', 'scope',
        'dimension', 'currency', 'unit', 'fiscal_calendar', 'comparability_basis'].map(key => [key, field(row, key)]));
      const formalSubject = row.subject;
      if (!isWfdRecord(formalSubject) || !['kind', 'namespace', 'id'].every(key => typeof formalSubject[key] === 'string' && formalSubject[key])
        || [...Object.values(identity), field(row, 'report_id'), field(row, 'report_version')].some(value => /^(unknown|unresolved|unspecified)$/iu.test(value.trim()))) fail('相容输入缺少正式主体、明确报告身份/版本或财年/范围等依据，未知标签不能当相同口径。');
      const key = canonicalWfdJson({ subject: row.subject, ...identity, concept: mapping.code, periodType: spec.periodType });
      if (basis !== undefined && basis !== key) fail('主体、科目、准则、范围、维度、币种、单位、财年或修订相容依据不一致。');
      basis = key;
      assertFinancialValueUnit(row, allowUnitScale, mapping.unitDimension ?? 'money');
    }
    if (seen.size !== expected.size) fail('所需财报期间缺失；不补零、不改读最新数据。');
    compatibility = { status: 'declared_basis_compatible', periodType: spec.periodType,
      periods: spec.periods, basis: JSON.parse(basis!), calculation: 'not_requested',
      assurance: 'fixed_record_declarations_checked_not_independent_report_verification' };
  }
  const connection = fixed.connection;
  const lineage: WfdRecord[] = [], unmapped: WfdRecord[] = [], articulationTerms: ArticulationTermInput[] = [];
  const rows = inputs.flatMap(input => input.rows.flatMap(row => {
    const original = field(row, 'concept');
    const mapping = resolveFinancialConceptRule(original, mappingProfile, industryTemplate);
    if (!mapping) { unmapped.push({ record: row.record_ref, concept: original }); return []; }
    const rowUnit = field(row, 'unit');
    const expectedDim = mapping.unitDimension ?? 'money';
    const scaleRule = UNIT_SCALE_POWERS[rowUnit];
    if (field(row, 'accounting_standard') !== 'CAS' || field(row, 'currency') !== 'CNY'
      || !scaleRule || scaleRule.dimension !== expectedDim
      || (!allowUnitScale && scaleRule.power10 !== 0)) {
      fail('当前映射只对明确CAS、人民币对应科目量纲基本单位（或显式启用 allowUnitScale 的受控倍率单位）原值开放；其他币种、未知单位或准则须另有映射。');
    }
    assertFinancialValueUnit(row, allowUnitScale, expectedDim);
    const colRole = optionalField(row, 'column_role');
    if (colRole !== null && !COLUMN_ROLES.includes(colRole as FinancialColumnRole))
      fail(`未知财报列角色 ${colRole}；须明确区分当期初报列与上年同期重述比较列。`);
    if (optionalField(row, 'report_nature') === 'restatement_carrier' && (colRole === null || colRole === 'current_period'))
      fail('重述比较列载体（restatement_carrier）必须显式声明比较列角色（prior_period_restated 或 prior_period_comparative_unchanged）。');
    const startDate = field(row, 'start_date'), endDate = field(row, 'end_date'), periodType = field(row, 'period_type');
    const expectedPeriodType = mapping.periodType ?? (mapping.additive ? 'duration' : 'instant');
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate
      || !['duration', 'instant'].includes(periodType) || periodType !== expectedPeriodType
      || periodType === 'instant' && startDate !== endDate) {
      fail('财务固定映射期间须为实际有效日期、正确次序及相符时点/区间性质；不归一化不存在的日期或猜测期间。');
    }
    const endExclusive = nextDay(endDate);
    if (!validDate(endExclusive)) fail('财务固定映射期间超出可表达的半开日期边界。');
    const values = Object.fromEntries(Object.entries(row.values as WfdRecord).map(([key, cell]) => [key, (cell as WfdRecord).value]));
    const valueCell = (row.values as WfdRecord).value as WfdRecord;
    const valueState = String(valueCell.value_state);
    const hasNumericValue = valueState === 'valid_value' || valueState === 'reported_zero';
    if (hasNumericValue && (typeof values.value !== 'string' || !values.value.trim())) {
      fail('有效财务数值状态缺少十进制字符串原值。');
    }
    if (!hasNumericValue && values.value !== null) {
      fail(`非数值状态 ${valueState} 的财务单元值须为 null，不得夹带数值。`);
    }
    const scaled = hasNumericValue ? scaleFinancialUnitValue(String(values.value), rowUnit) : null;
    const identity = { snapshot: input.ref.snapshotId, product: input.ref.productId, record: row.record_ref, mapping: mappingProfile };
    const key = 'standardized_' + wfdSha256(canonicalWfdJson(identity));
    const result: WfdRecord = {
      ...values,
      ...(allowUnitScale ? {
        value: scaled ? scaled.scaledValue : null,
        unit: scaleRule.baseUnit,
        source_unit: rowUnit,
        unit_scale_factor: scaleRule.factor,
        declared_precision_half_ulp: scaled ? scaled.declaredPrecisionHalfUlp : null,
      } : {}),
      concept: mapping.code,
      original_concept: original,
      value_state: valueState,
      business_key: key,
      start_utc: startDate + 'T00:00:00Z',
      end_utc: endExclusive + 'T00:00:00Z',
    };
    lineage.push({ businessKey: key, source: identity, additive: mapping.additive, unitFactor: allowUnitScale ? scaleRule.factor : '1',
      ...(allowUnitScale ? { sourceUnit: rowUnit, declaredPrecisionHalfUlp: scaled ? scaled.declaredPrecisionHalfUlp : null } : {}) });
    if (scaled && expectedDim === 'money') {
      const subjectKey = canonicalWfdJson({
        subject: row.subject ?? null,
        subject_scheme: optionalField(row, 'subject_scheme'),
        subject_code: optionalField(row, 'subject_code'),
      });
      articulationTerms.push({
        concept: mapping.code,
        scaledValue: scaled.scaledValue,
        declaredPrecisionHalfUlp: scaled.declaredPrecisionHalfUlp,
        subjectKey,
        periodKey: `${startDate}/${endDate}`,
        startDate,
        endDate,
        scope: optionalField(row, 'scope') ?? '',
        dimension: optionalField(row, 'dimension') ?? '',
        currency: optionalField(row, 'currency') ?? '',
        accountingStandard: optionalField(row, 'accounting_standard') ?? '',
        comparabilityBasis: optionalField(row, 'comparability_basis') ?? '',
        reportVersion: optionalField(row, 'report_version') ?? '',
        columnRole: colRole ?? '',
      });
    }
    return [result];
  }));
  if (!rows.length || rows.length > 1000) fail('本次固定映射没有合格输出或超过1000条输出预算；未补值或静默截断。');
  const articulation = calculation.articulationCheck === true ? verifyFinancialStatementArticulation(articulationTerms) : undefined;
  return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { version: FINANCIAL_FIXED_VERSION, mappingVersion: mappingProfile,
    ...(calculation.industryTemplate ? { industryTemplate } : {}),
    operation: calculation.operation, connection, inputs: inputEvidence, outputRows: rows.length, unmapped, lineage,
    historicalQualification: fixed.historyQualification,
    ...(fixed.historySelection ? { historySelection: fixed.historySelection } : {}), compatibility,
    ...(articulation ? { articulation } : {}) } };
}

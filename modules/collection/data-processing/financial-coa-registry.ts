import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { isExplicitUtcInstant } from '../../../contracts/financial-value.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

export const FINANCIAL_MAPPING_VERSION = 'cas-primary-statements/1';
export const FINANCIAL_MAPPING_V2_VERSION = 'cas-primary-statements/2';
export const IFRS_MAPPING_VERSION = 'ifrs-primary-statements/1';
export const US_GAAP_MAPPING_VERSION = 'us-gaap-primary-statements/1';
export const FINANCIAL_INDUSTRY_TEMPLATES = ['general_industrial', 'commercial_bank', 'insurance', 'securities'] as const;
export type FinancialIndustryTemplate = typeof FINANCIAL_INDUSTRY_TEMPLATES[number];
export type FinancialAccountingStandard = 'CAS' | 'IFRS' | 'US-GAAP';
export type FinancialCurrency = 'CNY' | 'HKD' | 'USD';
export type FinancialUnitDimension = 'money' | 'money_per_share' | 'ratio';
const primaryStatements = ['income_statement', 'balance_sheet', 'cash_flow'] as const;

export interface FinancialConceptRule {
  code: string;
  statement: typeof primaryStatements[number] | 'note';
  periodType: 'duration' | 'instant';
  additive: boolean;
  unitDimension: FinancialUnitDimension;
  templates: readonly FinancialIndustryTemplate[];
  aliases: readonly string[];
}
export interface FinancialCoaProfile {
  id: string;
  accountingStandard: FinancialAccountingStandard;
  currencies: readonly FinancialCurrency[];
  rules: readonly FinancialConceptRule[];
}

const standardCurrencies = { CAS: ['CNY'], IFRS: ['CNY', 'HKD', 'USD'], 'US-GAAP': ['USD'] } as const;
export type FinancialCoaProfileSelection = Pick<FinancialCoaProfile, 'id' | 'accountingStandard' | 'currencies'>
  & ({ kind: 'legacy' } | { kind: 'builtin'; rules: readonly FinancialConceptRule[] }
    | { kind: 'adopted'; rules: readonly FinancialConceptRule[]; digest: string });
const legacyProfiles = [FINANCIAL_MAPPING_VERSION, FINANCIAL_MAPPING_V2_VERSION].map(id => ({
  id, accountingStandard: 'CAS', currencies: standardCurrencies.CAS, kind: 'legacy',
} as const));

function coreRules(statement: typeof primaryStatements[number], entries: Record<string, string[]>): FinancialConceptRule[] {
  return Object.entries(entries).map(([code, aliases]) => {
    const periodType = statement === 'balance_sheet' || /^cash_and_equivalents_(?:begin|end)$/u.test(code) ? 'instant' : 'duration';
    const unitDimension = code.endsWith('_eps') ? 'money_per_share' : 'money';
    return { code, statement, aliases, periodType, unitDimension, additive: periodType === 'duration' && unitDimension === 'money',
      templates: FINANCIAL_INDUSTRY_TEMPLATES };
  });
}

const builtins: readonly FinancialCoaProfileSelection[] = [...legacyProfiles,
  { id: IFRS_MAPPING_VERSION, accountingStandard: 'IFRS', currencies: standardCurrencies.IFRS, kind: 'builtin', rules: [
    ...coreRules('income_statement', {
      revenue: ['Revenue'], cost_of_sales: ['Cost of sales', 'CostOfSales'], operating_profit: ['Operating profit', 'ProfitLossFromOperatingActivities'],
      profit_before_tax: ['Profit before tax', 'ProfitLossBeforeTax'], income_tax_expense: ['Income tax expense', 'IncomeTaxExpenseContinuingOperations'],
      net_profit_total: ['Profit for the period', 'ProfitLoss'], net_profit_parent: ['ProfitLossAttributableToOwnersOfParent'],
      minority_interest_profit: ['ProfitLossAttributableToNoncontrollingInterests'], basic_eps: ['Basic earnings per share', 'BasicEarningsLossPerShare'],
      diluted_eps: ['Diluted earnings per share', 'DilutedEarningsLossPerShare'],
    }),
    ...coreRules('balance_sheet', {
      total_assets: ['Total assets', 'Assets'], total_liabilities: ['Total liabilities', 'Liabilities'], total_equity: ['Total equity', 'Equity'],
      total_current_assets: ['Current assets', 'CurrentAssets'], total_non_current_assets: ['Non-current assets', 'NoncurrentAssets'],
      total_current_liabilities: ['Current liabilities', 'CurrentLiabilities'], total_non_current_liabilities: ['Non-current liabilities', 'NoncurrentLiabilities'],
      equity_parent: ['EquityAttributableToOwnersOfParent'], minority_interest: ['NoncontrollingInterests'],
    }),
    ...coreRules('cash_flow', {
      net_cash_operating: ['Net cash from operating activities', 'CashFlowsFromUsedInOperatingActivities'],
      net_cash_investing: ['Net cash from investing activities', 'CashFlowsFromUsedInInvestingActivities'],
      net_cash_financing: ['Net cash from financing activities', 'CashFlowsFromUsedInFinancingActivities'],
      fx_effect_on_cash: ['EffectOfExchangeRateChangesOnCashAndCashEquivalents'],
      net_cash_increase: ['IncreaseDecreaseInCashAndCashEquivalents'],
      cash_and_equivalents_begin: ['Cash and cash equivalents at beginning of period'],
      cash_and_equivalents_end: ['Cash and cash equivalents at end of period', 'CashAndCashEquivalents'],
    }),
  ] },
  { id: US_GAAP_MAPPING_VERSION, accountingStandard: 'US-GAAP', currencies: standardCurrencies['US-GAAP'], kind: 'builtin', rules: [
    ...coreRules('income_statement', {
      revenue: ['Revenue', 'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
      cost_of_sales: ['Cost of revenue', 'CostOfRevenue'], operating_profit: ['Operating income', 'OperatingIncomeLoss'],
      income_tax_expense: ['IncomeTaxExpenseBenefit'], net_profit_total: ['ProfitLoss'], net_profit_parent: ['NetIncomeLoss'],
      minority_interest_profit: ['NetIncomeLossAttributableToNoncontrollingInterest'],
      basic_eps: ['EarningsPerShareBasic'], diluted_eps: ['EarningsPerShareDiluted'],
    }),
    ...coreRules('balance_sheet', {
      total_assets: ['Total assets', 'Assets'], total_liabilities: ['Total liabilities', 'Liabilities'],
      total_equity: ['Total equity including noncontrolling interests', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
      total_current_assets: ['AssetsCurrent'], total_current_liabilities: ['LiabilitiesCurrent'],
      equity_parent: ['StockholdersEquity'], minority_interest: ['MinorityInterest'],
    }),
    ...coreRules('cash_flow', {
      net_cash_operating: ['NetCashProvidedByUsedInOperatingActivities'], net_cash_investing: ['NetCashProvidedByUsedInInvestingActivities'],
      net_cash_financing: ['NetCashProvidedByUsedInFinancingActivities'], net_cash_increase: ['CashAndCashEquivalentsPeriodIncreaseDecrease'],
      fx_effect_on_cash: ['EffectOfExchangeRateOnCashAndCashEquivalents'],
      cash_and_equivalents_begin: ['Cash and cash equivalents at beginning of period'],
      cash_and_equivalents_end: ['Cash and cash equivalents at end of period', 'CashAndCashEquivalentsAtCarryingValue'],
    }),
  ] },
];

interface UnitRule {
  baseUnit: string;
  dimension: FinancialUnitDimension;
  currency: FinancialCurrency | null;
  power10: number;
  factor: string;
}
const units = new Map<string, UnitRule>();
for (const currency of standardCurrencies.IFRS) {
  const baseUnit = currency.toLowerCase();
  for (const [suffix, power10] of [['', 0], ['_thousand', 3], ['_ten_thousand', 4], ['_million', 6], ['_hundred_million', 8]] as const) {
    units.set(baseUnit + suffix, { baseUnit, dimension: 'money', currency, power10, factor: '1' + '0'.repeat(power10) });
  }
  const perShare = `${baseUnit}_per_share`;
  units.set(perShare, { baseUnit: perShare, dimension: 'money_per_share', currency, power10: 0, factor: '1' });
}
units.set('cny_10000', units.get('cny_ten_thousand')!);
units.set('cny_100million', units.get('cny_hundred_million')!);
for (const baseUnit of ['ratio', 'percent']) units.set(baseUnit, { baseUnit, dimension: 'ratio', currency: null, power10: 0, factor: '1' });

export function financialUnitRule(unit: string): Readonly<UnitRule> | undefined {
  const rule = units.get(unit);
  return rule && { ...rule };
}

const profileId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,75}\/[1-9]\d{0,8}$/u.test(value);
const digest = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f]/u.test(value);
const fail = (code: string, message: string): never => { throw new TaskError(`FINANCIAL_COA_${code}`, message); };

export function matchingFinancialCoaRules(profile: Pick<FinancialCoaProfile, 'rules'>, concept: string,
  template: FinancialIndustryTemplate, statement?: string): FinancialConceptRule[] {
  return profile.rules.filter(rule => rule.templates.includes(template) && (statement === undefined || rule.statement === statement)
    && (rule.code === concept || rule.aliases.includes(concept)));
}

export interface FinancialCoaSampleRow {
  concept: string;
  statement: string;
  periodType: string;
  accountingStandard: string;
  currency: string;
  unit: string;
  industryTemplate?: FinancialIndustryTemplate;
  declaredScaleFactor?: string;
}

export function inspectFinancialCoaUnit(profile: Pick<FinancialCoaProfile, 'accountingStandard' | 'currencies'>,
  row: Pick<FinancialCoaSampleRow, 'accountingStandard' | 'currency' | 'unit' | 'declaredScaleFactor'>,
  allowScale: boolean, expectedDimension?: FinancialUnitDimension) {
  const unit = financialUnitRule(row.unit);
  const scaleIssue = !unit ? 'unknown_unit' : profile.accountingStandard !== row.accountingStandard ? 'accounting_standard_mismatch'
    : !profile.currencies.some(currency => currency === row.currency) || unit.currency !== null && unit.currency !== row.currency ? 'currency_mismatch'
    : row.declaredScaleFactor !== undefined && row.declaredScaleFactor !== unit.factor ? 'scale_factor_mismatch'
    : !allowScale && unit.power10 !== 0 ? 'scale_not_enabled'
    : expectedDimension !== undefined && expectedDimension !== unit.dimension ? 'unit_dimension_mismatch' : null;
  return { unit, scaleIssue };
}

export function inspectFinancialCoaRow(profile: FinancialCoaProfile, row: FinancialCoaSampleRow, allowScale: boolean) {
  const hits = matchingFinancialCoaRules(profile, row.concept, row.industryTemplate ?? 'general_industrial', row.statement);
  const rule = hits.length === 1 ? hits[0] : undefined;
  return { hits, ...inspectFinancialCoaUnit(profile, row, allowScale, rule?.unitDimension),
    periodConflict: rule !== undefined && rule.periodType !== row.periodType };
}

type CoaReplay = {
  profileId: string;
  candidateDigest: string;
  replayDigest: string;
  sampleDigest: string;
  passed: boolean;
  coverage: { sampleRows: number; mappedRows: number; ratio: number };
  unmappedConcepts: { rowIndex: number; statement: string; concept: string }[];
  conflicts: { statement: string; industryTemplate: FinancialIndustryTemplate; concept: string; codes: string[] }[];
  periodConflicts: { rowIndex: number; concept: string; expected: string; actual: string }[];
  scaleDiagnostics: { rowIndex: number; unit: string; baseUnit: string | null; factor: string | null; issue: string | null }[];
};
type RegisteredCandidate = { profile: FinancialCoaProfile; candidateDigest: string; replay?: CoaReplay;
  adoption?: CoaOperatorConfirmation & { status: 'adopted' } };
export interface CoaOperatorConfirmation {
  profileId: string;
  confirmationReceipt: CoaOperatorConfirmationReceipt;
}
export interface CoaOperatorConfirmationReceipt {
  authority: 'operator-http' | 'trusted-host';
  operatorId: string;
  candidateDigest: string;
  replayDigest: string;
  observedAtUtc: string;
  receiptDigest: string;
}
/** 确认回执摘要绑定内容，签发来源由受信宿主独立核验。 */
export function financialCoaConfirmationDigest(input: Omit<CoaOperatorConfirmationReceipt, 'receiptDigest'>): string {
  return digest({ action: 'adopt-financial-coa/1', authority: input.authority, operatorId: input.operatorId,
    candidateDigest: input.candidateDigest, replayDigest: input.replayDigest, observedAtUtc: input.observedAtUtc });
}

type TrustedReceiptVerifier = (receipt: Readonly<CoaOperatorConfirmationReceipt>) => boolean;

/** 候选、回放及采用记录归属同一宿主登记表，核验器仅在构造时装配。 */
export class ChartOfAccountsRegistry {
  readonly #candidates = new Map<string, RegisteredCandidate>();
  readonly #trustedReceiptVerifier: TrustedReceiptVerifier | undefined;

  constructor(trustedReceiptVerifier?: TrustedReceiptVerifier) {
    this.#trustedReceiptVerifier = trustedReceiptVerifier;
  }

  registerCandidateCoaProfile(raw: unknown) {
    if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'accountingStandard,currencies,id,rules'
      || !profileId(raw.id) || /^(cas|ifrs|us-gaap)-primary-statements\//u.test(raw.id)
      || typeof raw.accountingStandard !== 'string' || !Object.hasOwn(standardCurrencies, raw.accountingStandard)
      || !Array.isArray(raw.currencies) || !raw.currencies.length || new Set(raw.currencies).size !== raw.currencies.length
      || !Array.isArray(raw.rules) || !raw.rules.length || raw.rules.length > 256)
      return fail('PROFILE', '候选档案须有独立版本、准则、币种和明确科目规则。');
    const accountingStandard = raw.accountingStandard as FinancialAccountingStandard;
    const currencies: readonly string[] = standardCurrencies[accountingStandard];
    if (!raw.currencies.every(currency => currencies.includes(currency))) fail('PROFILE', '候选档案币种必须在所声明准则的显式支持范围内。');
    const rules = raw.rules.map((rule: unknown): FinancialConceptRule => {
      if (!isWfdRecord(rule) || Object.keys(rule).sort().join(',') !== 'additive,aliases,code,periodType,statement,templates,unitDimension'
        || typeof rule.code !== 'string' || !/^[a-z][a-z0-9_.]{0,127}$/u.test(rule.code)
        || !primaryStatements.some(value => value === rule.statement)
        || (rule.periodType !== 'instant' && rule.periodType !== 'duration')
        || !['money', 'money_per_share', 'ratio'].includes(String(rule.unitDimension))
        || typeof rule.additive !== 'boolean' || rule.additive && (rule.periodType !== 'duration' || rule.unitDimension !== 'money')
        || rule.statement === 'balance_sheet' && rule.periodType !== 'instant' || rule.statement === 'income_statement' && rule.periodType !== 'duration'
        || !Array.isArray(rule.templates) || !rule.templates.length || new Set(rule.templates).size !== rule.templates.length
        || !rule.templates.every(template => FINANCIAL_INDUSTRY_TEMPLATES.includes(template))
        || !Array.isArray(rule.aliases) || rule.aliases.length > 64 || !rule.aliases.every(text) || new Set(rule.aliases).size !== rule.aliases.length)
        return fail('RULE', '科目规则须显式声明三表归属、期间、量纲、行业与别名，时点或非线性量值不能设为可加。');
      return { ...(rule as unknown as FinancialConceptRule), aliases: [...rule.aliases].sort(), templates: [...rule.templates].sort() };
    }).sort((a, b) => a.code < b.code ? -1 : a.code === b.code ? 0 : 1);
    if (new Set(rules.map(rule => rule.code)).size !== rules.length) fail('RULE', '标准科目代码重复。');
    const profile = { id: raw.id, accountingStandard, currencies: [...raw.currencies].sort() as FinancialCurrency[], rules };
    const candidateDigest = digest(profile), previous = this.#candidates.get(profile.id);
    if (previous && previous.candidateDigest !== candidateDigest) fail('VERSION_CONFLICT', '同一档案版本已固定其他内容，修改须另开版本。');
    if (!previous) this.#candidates.set(profile.id, { profile, candidateDigest });
    return { profile: structuredClone(profile), candidateDigest, status: previous?.adoption ? 'adopted' : 'candidate' } as const;
  }

  replayCandidateCoaProfile(id: string, rows: readonly FinancialCoaSampleRow[]): CoaReplay {
    const candidate = this.#candidates.get(id);
    if (!candidate || !Array.isArray(rows) || !rows.length || rows.length > 5000) return fail('REPLAY', '回放须选择已登记候选和 1–5000 个明确样本行。');
    const profile = candidate.profile;
    const replay: Omit<CoaReplay, 'replayDigest'> = { profileId: id, candidateDigest: candidate.candidateDigest, sampleDigest: '',
      passed: false, coverage: { sampleRows: rows.length, mappedRows: 0, ratio: 0 }, unmappedConcepts: [],
      conflicts: [], periodConflicts: [], scaleDiagnostics: [] };
    const aliases = new Map<string, CoaReplay['conflicts'][number]>();
    for (const rule of profile.rules) for (const industryTemplate of rule.templates) for (const concept of new Set([rule.code, ...rule.aliases])) {
      const key = canonicalWfdJson([rule.statement, industryTemplate, concept]);
      const entry = aliases.get(key) ?? { statement: rule.statement, industryTemplate, concept, codes: [] };
      entry.codes.push(rule.code);
      aliases.set(key, entry);
    }
    replay.conflicts = [...aliases.values()].filter(entry => entry.codes.length > 1);
    const sample = rows.map((row: FinancialCoaSampleRow, rowIndex: number) => {
      if (!row || ![row.concept, row.statement, row.periodType, row.accountingStandard, row.currency, row.unit].every(text)
        || row.industryTemplate !== undefined && !FINANCIAL_INDUSTRY_TEMPLATES.includes(row.industryTemplate)
        || row.declaredScaleFactor !== undefined && !text(row.declaredScaleFactor)) return fail('REPLAY_ROW', '回放行缺少可核对的原科目、三表及期间、准则、币种或单位。');
      const { concept, statement, periodType, accountingStandard, currency, unit, industryTemplate = 'general_industrial' } = row;
      const fixed = { concept, statement, periodType, accountingStandard, currency, unit, industryTemplate };
      const checked = inspectFinancialCoaRow(profile, row, true);
      if (!checked.hits.length) replay.unmappedConcepts.push({ rowIndex, statement, concept });
      if (checked.periodConflict) replay.periodConflicts.push({ rowIndex, concept, actual: periodType, expected: checked.hits[0]!.periodType });
      if (checked.hits.length === 1 && !checked.scaleIssue && !checked.periodConflict) replay.coverage.mappedRows++;
      replay.scaleDiagnostics.push({ rowIndex, unit, baseUnit: checked.unit?.baseUnit ?? null, factor: checked.unit?.factor ?? null, issue: checked.scaleIssue });
      return { ...fixed, declaredScaleFactor: row.declaredScaleFactor ?? null };
    });
    replay.sampleDigest = digest(sample);
    replay.coverage.ratio = replay.coverage.mappedRows / rows.length;
    replay.passed = replay.coverage.mappedRows === rows.length && !replay.conflicts.length;
    const receipt = { ...replay, replayDigest: digest(replay) };
    if (!candidate.adoption) candidate.replay = receipt;
    return structuredClone(receipt);
  }

  adoptCandidateCoaProfile(input: CoaOperatorConfirmation) {
    const verifyReceipt = this.#trustedReceiptVerifier;
    if (!verifyReceipt) return fail('ADOPTION_CONFIRMATION', '登记表未装配受信宿主回执核验器。');
    const raw = input?.confirmationReceipt;
    if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'authority,candidateDigest,observedAtUtc,operatorId,receiptDigest,replayDigest'
      || (raw.authority !== 'operator-http' && raw.authority !== 'trusted-host') || !text(raw.operatorId)
      || !isDigest(raw.candidateDigest) || !isDigest(raw.replayDigest) || !isExplicitUtcInstant(raw.observedAtUtc)
      || !isDigest(raw.receiptDigest)) return fail('ADOPTION_CONFIRMATION', '采用须有受信宿主签发的完整操作员确认回执。');
    const receipt = Object.freeze({ ...raw });
    const candidate = this.#candidates.get(input.profileId), replay = candidate?.replay;
    if (!candidate || !replay?.passed || receipt.candidateDigest !== candidate.candidateDigest
      || receipt.replayDigest !== replay.replayDigest) return fail('ADOPTION_REPLAY', '采用须固定同一候选内容及已通过的回放摘要。');
    if (receipt.receiptDigest !== financialCoaConfirmationDigest(receipt)
      || verifyReceipt(receipt) !== true)
      return fail('ADOPTION_CONFIRMATION', '确认回执摘要或受信宿主签发记录未通过核验。');
    if (candidate.adoption && receipt.receiptDigest !== candidate.adoption.confirmationReceipt.receiptDigest)
      return fail('ADOPTION_EXISTS', '已采用档案的确认记录不能覆盖。');
    candidate.adoption ??= { profileId: input.profileId, confirmationReceipt: receipt, status: 'adopted' };
    return structuredClone(candidate.adoption);
  }

  getFinancialCoaProfile(id: unknown): FinancialCoaProfileSelection | null {
    const builtin = builtins.find(profile => profile.id === id);
    if (builtin) return structuredClone(builtin);
    const candidate = profileId(id) ? this.#candidates.get(id) : undefined;
    return candidate?.adoption ? { ...structuredClone(candidate.profile), kind: 'adopted', digest: candidate.candidateDigest } : null;
  }
}

// 默认宿主只提供内置档案；候选采用须装配受信核验器。
export const defaultFinancialCoaRegistry = new ChartOfAccountsRegistry();

/** 已持久化的依赖只核对固定版本与摘要，即使当前进程未装载候选档案。 */
export function isFinancialCoaProfilePin(id: unknown, contentDigest: unknown): boolean {
  return builtins.some(profile => profile.id === id) ? contentDigest === undefined
    : profileId(id) && isDigest(contentDigest) && !/^(cas|ifrs|us-gaap)-primary-statements\//u.test(id);
}

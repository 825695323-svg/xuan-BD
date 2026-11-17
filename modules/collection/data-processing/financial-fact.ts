import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

export const FINANCIAL_FACT_VERSION = 'bd-financial-fact/1';
export interface FinancialFactDeclaration {
  version: typeof FINANCIAL_FACT_VERSION;
  seriesId: string;
  periodBasis: string;
  basis: string;
  assertion: 'same_fact_across_report_editions';
}
const axes = ['subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'statement', 'scope', 'section',
  'concept', 'dimension', 'period_type', 'start_date', 'end_date', 'unit'] as const;
function fail(): never { throw new TaskError('FINANCIAL_FACT_IDENTITY', '财务事实须明确系列、报告期依据、同事实依据及完整身份轴；不得以自由键、同名报告或未知口径替代。'); };
const known = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 1000 && !/[\u0000-\u001f]/u.test(value) && !/^(unknown|unresolved|unspecified|not_asserted|未知|未明确)$/iu.test(value);
export function readFinancialFactDeclaration(raw: unknown): FinancialFactDeclaration {
  if (!isWfdRecord(raw) || Object.keys(raw).sort().join(',') !== 'assertion,basis,periodBasis,seriesId,version'
    || raw.version !== FINANCIAL_FACT_VERSION || raw.assertion !== 'same_fact_across_report_editions'
    || ![raw.seriesId, raw.periodBasis, raw.basis].every(known)) fail();
  return structuredClone(raw) as unknown as FinancialFactDeclaration;
}
/** Edition, audit status and value remain source evidence, never the stable fact identity. */
export function financialFactIdentity(row: WfdRecord, raw: unknown): { businessKey: string; identity: string } {
  const declaration = readFinancialFactDeclaration(raw);
  if (!axes.every(axis => known(row[axis])) || !known(row.report_id) || !known(row.report_version)
    || typeof row.audit_status !== 'string' || !row.audit_status.trim()) fail();
  const validDay = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDay(row.start_date) || !validDay(row.end_date) || String(row.start_date) > String(row.end_date)
    || !['instant', 'duration'].includes(String(row.period_type)) || row.period_type === 'instant' && row.start_date !== row.end_date) fail();
  const identity = canonicalWfdJson({ declaration, axes: Object.fromEntries(axes.map(axis => [axis, row[axis]])) });
  return { businessKey: 'financial_fact_' + wfdSha256(identity), identity };
}
/** Recompute from actual mapped cells; an arbitrary key/hash is not identity authority. */
export function verifyFinancialFactRow(row: WfdRecord): string {
  if (!isWfdRecord(row.values)) fail();
  const values = Object.fromEntries(Object.entries(row.values).map(([key, cell]) => {
    if (!isWfdRecord(cell) || cell.value_state !== 'valid_value' && cell.value_state !== 'reported_zero') fail();
    return [key, cell.value];
  }));
  if (typeof values.financial_fact_identity !== 'string') fail();
  let frozen: unknown; try { frozen = JSON.parse(values.financial_fact_identity); } catch { fail(); }
  if (!isWfdRecord(frozen)) fail();
  const actual = financialFactIdentity(values, frozen.declaration);
  if (actual.identity !== values.financial_fact_identity || actual.businessKey !== row.business_key) fail();
  return actual.identity;
}

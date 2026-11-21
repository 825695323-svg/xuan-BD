import assert from 'node:assert/strict';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import type { R1Runtime } from '../collection/r1-runtime.js';
import { actionRoles, pureOperatorDefinition } from './algorithm-pure-operators.js';
import { PURE_OPERATOR_IDS, type PureOperatorId } from './algorithm-types.js';
import type { FinancialObservation } from './financial-l4-operators.js';
import type { MarketAdjustmentInput } from './market-adjustment-contract.js';

// All financial amounts, OHLC and action terms below are synthetic test inputs.
export const basis = { subject: 'synthetic_issuer', accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated',
  comparability_basis: 'synthetic_reviewed_revision', unit: 'cny', fiscalCalendar: 'synthetic_calendar' };

export function observation(fiscalYear: number, period: FinancialObservation['period'], value: FinancialObservation['value']): FinancialObservation {
  return { ...basis, concept: 'revenue', fiscalYear, period, periodType: 'duration', additive: true, value,
    sourceRef: `synthetic/${fiscalYear}/${period}` };
}

export const bars = [
  { date: '2026-03-02', open: 100, high: 120, low: 80, close: '100.00' },
  { date: '2026-03-03', open: 40, high: 48, low: 32, close: 40 },
  { date: '2026-03-04', open: 20, high: 24, low: 16, close: 20 },
];
const confirmed = { claimStatus: 'confirmed', effectiveStatus: 'effective', effectiveDate: bars[1].date };
export const marketInput: MarketAdjustmentInput = {
  direction: 'forward_qfq', anchorDate: bars[2].date, adjustment: 'none', frequency: '1d', bars,
  actions: [
    { ...confirmed, id: 'cash', kind: 'cash_dividend', cashPerShare: 20 },
    { ...confirmed, id: 'stock', kind: 'stock_dividend', sharesPerShare: '0.25' },
    { ...confirmed, id: 'capital', kind: 'capitalization', sharesPerShare: '0.75' },
    { ...confirmed, effectiveDate: bars[2].date, id: 'split', kind: 'split', splitRatio: 2 },
  ],
};

export const fixedSnapshot = 's_synthetic_l4', revision = 'v1', cutoff = '2026-05-02T00:00:00Z';
export const ratioRow = { ...basis, periodRef: 'synthetic/2026/FY', revenue: '7', costOfRevenue: '2', netProfit: '5',
  averageAssets: '13', averageEquity: '3', currentAssets: '8', currentLiabilities: '3', averageReceivables: '2',
  averageInventory: '1', averagePayables: '1', periodDays: '365', cfo: '6', capex: '1' };
export const sourceRows: Record<string, WfdRecord[]> = {
  single: [observation(2025, 'H1', '9.900000000000000008'), observation(2025, 'Q1_YTD', '2.900000000000000001')].map(r => ({ ...r })),
  ttm: [observation(2025, 'FY', '8'), observation(2026, 'H1', '6'), observation(2025, 'H1', '5')].map(r => ({ ...r })),
  growth: [observation(2025, 'Q1', '2'), observation(2026, 'Q1', '3')].map(r => ({ ...r })),
  ratios: [ratioRow], bars: bars.map(r => ({ ...r, subject: basis.subject, currency: basis.currency, adjustment: 'none', frequency: '1d' })),
  actions: marketInput.actions.map(r => ({ ...r, subject: basis.subject, currency: basis.currency })),
};
export const products: Record<PureOperatorId, string> = { financial_single_quarter: 'single', financial_ttm: 'ttm',
  financial_growth: 'growth', financial_ratios: 'ratios', price_adjustment: 'bars' };
export function calculation(id: PureOperatorId, history: WfdRecord = {}) {
  const ref = (productId: string) => ({ snapshotId: fixedSnapshot, definitionRevision: revision, productId });
  return { methodId: id, parameters: id === 'financial_growth' ? { comparison: 'yoy' } : id === 'price_adjustment'
    ? { direction: 'forward_qfq', anchorDate: bars[2].date } : {},
    source: { kind: 'fixed_snapshot', reference: { ...ref(products[id]), ...history },
      ...(id === 'price_adjustment' ? { actionReference: ref('actions') } : {}) },
    ...(history.perspective ? { usage: { purpose: 'historical_compute', historyMode: history.perspective, cutoff: history.at } } : {}) };
}

export const fields = (product: string) => {
  const id = PURE_OPERATOR_IDS.find(method => products[method] === product);
  const roles = id ? pureOperatorDefinition(id).fields : actionRoles;
  return [...roles.required, ...roles.optional];
};
export function cell(row: WfdRecord, field: string) {
  const value = row[field] ?? null;
  const type = field === 'additive' ? 'boolean' : field === 'fiscalYear' ? 'integer'
    : ['value', 'open', 'high', 'low', 'close', 'cashPerShare', 'sharesPerShare', 'splitRatio',
      ...pureOperatorDefinition('financial_ratios').fields.optional].includes(field) ? 'decimal' : 'text';
  const price = ['open', 'high', 'low', 'close', 'cashPerShare'].includes(field);
  const unit = type !== 'decimal' ? type : price ? 'cny_per_share' : field === 'periodDays' ? 'day'
    : ['sharesPerShare', 'splitRatio'].includes(field) ? 'ratio' : row.unit as string;
  return { data_type: type, unit: { unit_code: unit, resolved: true, definition: { ...pureFixtureUnits[unit as keyof typeof pureFixtureUnits] } },
    value: value != null && ['decimal', 'integer'].includes(type) ? String(value) : value,
    value_state: value == null ? 'not_reported' : 'valid_value' };
}

const wfdField = (name: string) => 'l4_' + name.replace(/[A-Z]/gu, c => '_' + c.toLowerCase());

export const pureFixtureUnits = {
  text: { dimension: 'text' }, integer: { dimension: 'quantity' }, boolean: { dimension: 'boolean' }, cny: { dimension: 'money' },
  cny_per_share: { dimension: 'money_per_share', scale: 1 }, day: { dimension: 'quantity' }, ratio: { dimension: 'ratio', scale: 1 },
};

export async function seedPureOperatorProducts(runtime: R1Runtime) {
  const day = { status: 'known', precision: 'day', source_timezone: 'UTC', earliest_utc: '2026-05-01T00:00:00Z', latest_exclusive_utc: cutoff };
  const namespace = 'full.chain.test', subject = { kind: 'entity', namespace, id: basis.subject };
  let snapshotId: string | null = null;
  for (const [key, source] of Object.entries(sourceRows)) {
    const roles = fields(key);
    const rows = source.map((row, i) => ({ business_key: key + '-' + i, subject, observation_time: day, public_time: day,
      values: Object.fromEntries(roles.map(field => { const { unit: _u, ...wire } = cell(row, field); return [wfdField(field), wire]; })) }));
    const seed = buildStructuredIngestDocument({ requestId: 'synthetic-pure-' + key, datasetId: 'synthetic_pure_' + key, namespace,
      producerNamespace: namespace, submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson(rows)), expectedParentSnapshotId: snapshotId,
      outputKey: key, subject, inputMode: 'partial_observation', definitionPublicTime: day,
      definition: { semantic_code: 'synthetic.pure.' + key, measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: namespace, time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
          content_nature: 'observed_fact', time: { period_type: 'natural', interval: 'half_open', timezone: 'UTC' } },
        field_definitions: roles.map(field => { const c = cell(source[0], field);
          return { field_code: wfdField(field), data_type: c.data_type, unit_code: c.unit.unit_code,
            measurement_nature: c.data_type === 'decimal' ? 'stock' : 'relation', time_role: 'observation' }; }) },
      coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      payload: { kind: 'tabular_rows', rows } });
    const { result } = await runtime.client.submit(seed);
    assert.equal(result.state, 'published_formal', JSON.stringify({ key, outputs: result.output_results, errors: result.errors }));
    snapshotId = String(result.snapshot_id);
  }
  assert.ok(snapshotId);
  return snapshotId;
}

export function discoveredPureReference(directory: { products: { datasetId: string; productId: string; definitionRef: { version: string }; fields: { fieldCode: string }[] }[] }, snapshotId: string, key: string) {
  const entry = directory.products.find(product => product.datasetId === 'synthetic_pure_' + key);
  assert.ok(entry); assert.ok(entry.fields.some(field => field.fieldCode === 'l4_subject'));
  return { snapshotId, productId: entry.productId, definitionRevision: entry.definitionRef.version,
    fieldMapping: Object.fromEntries(fields(key).map(name => [name, wfdField(name)])) };
}

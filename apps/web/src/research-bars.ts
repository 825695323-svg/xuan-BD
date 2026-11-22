import type { R1ProductDiscovery, R1ProductSelection } from '../../../contracts/r1-contracts';
import { isExplicitUtcInstant } from '../../../contracts/financial-value';
export interface ChartBar { time: number; end: number; open: number; high: number; low: number; close: number }

export const RESEARCH_FIELDS = ['open', 'high', 'low', 'close'] as const;
const object = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
export interface ResearchProduct { selection: R1ProductSelection; unit: string; cadence: string; priceBasis: string; }

/** Only recognize fixed WFD tabular instrument contracts that actually declare a shared raw-price basis. */
export function researchProducts(discovery: Pick<R1ProductDiscovery, "selections" | "products">): ResearchProduct[] {
  return discovery.selections.flatMap(selection => {
    if (!selection.readable || selection.payloadKind !== 'tabular_rows' || selection.subject.kind !== 'instrument'
      || !RESEARCH_FIELDS.every(code => selection.fields.includes(code))) return [];
    const matches = discovery.products.filter(product => product.product_id === selection.productId);
    if (matches.length !== 1) return [];
    const product = matches[0]!;
    if (product.dataset_id !== selection.datasetId || product.logical_domain !== 'observations') return [];
    const declaration = object(product.declaration), context = object(declaration.semantic_context);
    const time = object(context.time), stats = object(context.statistical), finance = object(context.financial);
    if (declaration.time_role !== 'observation' || context.content_nature !== 'observed_fact'
      || time.interval !== 'half_open' || typeof time.timezone !== 'string' || !time.timezone
      || (time.frequency !== 'day' && time.frequency !== 'minute')
      || !['nominal', 'real'].includes(String(stats.price_basis)) || object(finance.price_adjustment).direction !== 'raw'
      || !Array.isArray(declaration.field_definitions)) return [];
    const fields = declaration.field_definitions.map(object), overrides = object(declaration.field_semantic_context);
    const priceFields = RESEARCH_FIELDS.map(code => {
      const found = fields.filter(field => field.field_code === code);
      return found.length === 1 ? found[0]! : {};
    });
    const unit = priceFields[0]?.unit_code;
    if (typeof unit !== 'string' || !unit || /^(unknown|unspecified|not_applicable|native_unverified|per_field)$/iu.test(unit)
      || priceFields.some((field, index) => {
        const override = object(overrides[RESEARCH_FIELDS[index]!]);
        const measurement = object(override.measurement);
        const fieldTime = object(override.time), fieldStats = object(override.statistical);
        const fieldAdjustment = object(object(override.financial).price_adjustment);
        return !['integer', 'decimal'].includes(String(field.data_type)) || field.unit_code !== unit
          || field.measurement_nature !== 'stock' || field.time_role !== 'observation'
          || Object.keys(fieldTime).length !== 0 || Object.keys(fieldStats).length !== 0 || Object.keys(fieldAdjustment).length !== 0
          || measurement.unit_code !== undefined && measurement.unit_code !== unit
          || measurement.measurement_nature !== undefined && measurement.measurement_nature !== 'stock';
      })) return [];
    return [{ selection, unit, cadence: time.frequency, priceBasis: String(stats.price_basis) }];
  });
}

/** The Canvas receives display numbers only. Never join, interpolate or zero-fill incomplete bars. */
export function chartBars(raw: readonly unknown[], product: ResearchProduct) {
  let skipped = 0;
  const rows: (ChartBar & { digest: string })[] = [];
  for (const row of raw.map(object)) {
    const time = object(row.business_time), values = object(row.values);
    const start = time.earliest_utc, end = time.latest_exclusive_utc;
    const seconds = typeof start === 'string' && isExplicitUtcInstant(start) ? Date.parse(start) / 1000 : NaN;
    const endSeconds = typeof end === 'string' && isExplicitUtcInstant(end) ? Date.parse(end) / 1000 : NaN;
    if (time.status !== 'known' || !Number.isSafeInteger(seconds) || !Number.isSafeInteger(endSeconds) || endSeconds <= seconds) { skipped++; continue; }
    const cells = RESEARCH_FIELDS.map(field => object(values[field]));
    const units = cells.map(cell => object(cell.unit));
    const digest = units[0]?.digest;
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)
      || units.some(unit => unit.resolved !== true || unit.unit_code !== product.unit || unit.digest !== digest)) { skipped++; continue; }
    const prices = cells.map(cell => typeof cell.value === 'string' && /^-?\d+(\.\d+)?$/u.test(cell.value)
      && ['decimal','integer'].includes(String(cell.data_type))
      && (cell.value_state === 'valid_value' || cell.value_state === 'reported_zero' && Number(cell.value) === 0) ? Number(cell.value) : NaN);
    const [open, high, low, close] = prices as [number, number, number, number];
    if (prices.some(price => !Number.isFinite(price)) || high < Math.max(open, close) || low > Math.min(open, close)) { skipped++; continue; }
    rows.push({ time: seconds, end: endSeconds, open, high, low, close, digest });
  }
  rows.sort((a, b) => a.time - b.time);
  const conflict = new Set(rows.map(row => row.digest)).size > 1
    || rows.some((row, index) => index > 0 && row.time < rows[index - 1]!.end);
  return { skipped, conflict, bars: conflict ? [] : rows.map(({ digest: _digest, ...bar }) => bar) };
}

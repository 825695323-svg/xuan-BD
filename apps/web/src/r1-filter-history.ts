import type { R1ProductDiscovery, R1SnapshotStatus } from '../../../contracts/r1-contracts';
import { buildR1ReadHistory, R1HistoryError, sameR1ReadConnection } from './r1-read-history';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = () => { throw new R1HistoryError('R1_FILTER_ECHO_MISMATCH', '筛选的固定身份、时间、条件或字段合同无法核对；未采用本页。', 'The fixed identity, time, predicate or field contracts cannot be verified; this page was not accepted.'); };

export function buildR1FilterHistory(selection: Parameters<typeof buildR1ReadHistory>[0], status?: R1SnapshotStatus | null): RecordValue {
  const history = buildR1ReadHistory(selection, status);
  return { history_mode: history.historyMode, knowledge_cutoff: history.at ? { status: 'known', precision: 'second', earliest_utc: history.at,
    latest_exclusive_utc: new Date(Date.parse(history.at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' } : null,
  held_scope: history.heldScope ?? null, usable_stage: history.usableStage ?? null };
}

/** Compare only the existing filter contract; no new permission or history engine. */
export function assertR1FilterEcho(input: RecordValue, result: RecordValue, discovery: R1ProductDiscovery, previousHash?: string): void {
  if (!sameR1ReadConnection(discovery.connection, object(result.connection) as unknown as R1ProductDiscovery['connection'])
    || result.snapshot_id !== discovery.snapshotId || result.format_version !== 'wfd.filter-objects-result/1'
    || result.operation !== 'filter_objects' || typeof result.query_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.query_hash)
    || previousHash !== undefined && result.query_hash !== previousHash) fail();
  for (const key of ['dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage', 'business_time_range', 'predicate', 'order_by']) {
    if (canonical(input[key]) !== canonical(result[key])) fail();
  }
  const requested: RecordValue[] = (Array.isArray(input.metrics) ? input.metrics : []).flatMap(raw => {
    const metric = object(raw);
    return (Array.isArray(metric.bindings) ? metric.bindings : []).map(binding => ({ ...object(binding), metric: metric.metric, field: metric.field }));
  });
  if (result.status === 'budget_exceeded' && Array.isArray(result.bindings) && result.bindings.length === 0
    && Array.isArray(result.objects) && result.objects.length === 0 && Array.isArray(result.indeterminate) && result.indeterminate.length === 0
    && object(result.scan_receipt).scan_complete === false && object(result.page).has_more === false && object(result.page).next_cursor === null
    && object(result.page).result_exhausted === false && Array.isArray(result.gaps) && result.gaps.length > 0) return;
  if (!requested.length || !Array.isArray(result.bindings) || result.bindings.length !== requested.length) fail();
  const verified: RecordValue[] = [];
  const remaining = [...result.bindings as unknown[]];
  for (const expected of requested) {
    const index = remaining.findIndex(raw => { const actual = object(raw); return ['metric', 'field', 'product_id', 'subject'].every(key => canonical(actual[key]) === canonical(expected[key as keyof typeof expected])); });
    if (index < 0) fail();
    const actual = object(remaining.splice(index, 1)[0]);
    const products = discovery.products.map(object).filter(product => product.product_id === expected.product_id && canonical(product.subject) === canonical(expected.subject));
    if (!products.length || new Set(products.map(product => canonical([product.definition_ref, product.contract_refs, product.contract_bundle_ref, product.contract_ref, product.declaration]))).size !== 1) fail();
    const declaration = object(products[0]!.declaration);
    const definitions = products[0]!.payload_kind === 'scalar_rows' ? [{ field_code: 'value_decimal', data_type: 'decimal', unit_code: declaration.unit_code, measurement_nature: declaration.measurement_nature, time_role: declaration.time_role }]
      : Array.isArray(declaration.field_definitions) ? declaration.field_definitions : [];
    const field = definitions.map(object).find(item => item.field_code === expected.field);
    if (!field || canonical(actual.field_definition) !== canonical(field)) fail();
    verified.push({ ...actual, contract_ref: products[0]!.contract_ref });
    for (const key of ['definition_ref', 'contract_refs', 'contract_bundle_ref']) if (canonical(actual[key]) !== canonical(products[0]![key])) fail();
  }
  const universe = object(input.universe).subjects;
  if (!Array.isArray(universe) || !Array.isArray(result.objects) || !Array.isArray(result.indeterminate)) fail();
  for (const raw of [...result.objects as unknown[], ...result.indeterminate as unknown[]]) {
    const item = object(raw);
    if (!(universe as unknown[]).some(subject => canonical(subject) === canonical(item.subject))) fail();
    for (const [name, rawRef] of Object.entries(object(item.record_refs))) {
      const ref = object(rawRef), binding = verified.find(value => value.metric === name && canonical(value.subject) === canonical(item.subject));
      const record = object(ref.record_ref);
      if (Object.keys(record).sort().join(',') !== 'logical_key,product_id,revision_id,snapshot_id'
        || record.snapshot_id !== input.snapshot_id || record.product_id !== binding?.product_id
        || !['logical_key', 'revision_id'].every(key => typeof record[key] === 'string' && (record[key] as string).length > 0)
        || canonical(ref.contract_ref) !== canonical(binding?.contract_ref)) fail();
      if (!binding || ['product_id', 'field', 'definition_ref'].some(key => canonical(ref[key]) !== canonical(binding[key]))) fail();
    }
  }
}

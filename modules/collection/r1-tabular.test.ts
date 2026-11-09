import assert from 'node:assert/strict';
import test from 'node:test';
import { checkR1TabularRows } from './r1-tabular.js';

const names = ['open', 'high', 'low', 'close', 'volume', 'amount'];
function fixture() {
  return {
    declaration: {
      protocol: 'wfd.structured-ingest/1.0',
      source: { source_id: 'fixture', provider: 'synthetic-test', requested_url: 'fixture:partial-semantics',
        requested_at_utc: 'unknown', acquired_at_utc: 'unknown', license: 'unknown', usage_scope: 'isolated-test' },
      mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
        precision: 'day', sourceTimezone: 'Asia/Shanghai',
        fields: names.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' as string | undefined })),
        bar: { frequency: 'day', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume', amount: 'amount' } },
      target: { subject: { kind: 'instrument', namespace: 'test', id: 'explicit-fixture' },
        definition: { unit_code: 'per_field', measurement_nature: 'mixed_observation',
          field_definitions: names.map((field_code, i) => ({ field_code, data_type: 'decimal',
            unit_code: i < 4 ? 'cny_per_share' : i === 4 ? 'shares' : 'cny',
            measurement_nature: i < 4 ? 'stock' : 'flow', time_role: 'observation' })),
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
            time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'Asia/Shanghai' },
            statistical: { price_basis: 'nominal' }, financial: { price_adjustment: { direction: 'unknown' } } },
          field_semantic_context: {
            volume: { measurement: { aggregation: 'period_total' } },
            amount: { measurement: { aggregation: 'period_total' } },
          } as Record<string, Record<string, Record<string, string>>> } },
    },
    row: { key: 'fixture:2026-01-05', start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z',
      open: '9007199254740993.01', high: '9007199254740993.03', low: '9007199254740993.00',
      close: '9007199254740993.02', volume: '123', amount: '456', state: 'valid_value' },
  };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

test('known price and quantity rules run despite unrelated unknown qualification axes', () => {
  const { declaration, row } = fixture(), result = checkR1TabularRows([row], declaration);
  assert.throws(() => checkR1TabularRows([{ ...row, high: row.low }], declaration), code('R1_TABULAR_OHLC'));
  assert.equal(result.quality, 'indeterminate');
  assert.ok(result.checkScope.includes('exact_decimal_ohlc'));
  assert.ok(result.checkScope.includes('nonnegative_volume_amount'));
  assert.equal(result.checkScope.includes('bar_closed_by_acquisition'), false);
  for (const field of ['volume', 'amount']) {
    const unknownUnit = structuredClone(declaration);
    unknownUnit.target.definition.field_semantic_context[field]!.measurement!.unit_code = 'unknown';
    assert.throws(() => checkR1TabularRows([{ ...row, [field]: '-1' }], unknownUnit), code('R1_TABULAR_QUANTITY'));
  }
  const complete = structuredClone(declaration);
  complete.source.acquired_at_utc = row.end;
  complete.target.definition.semantic_context.financial.price_adjustment.direction = 'raw';
  const qualified = checkR1TabularRows([row], complete);
  assert.equal(qualified.quality, 'pass');
  assert.ok(qualified.checkScope.includes('bar_closed_by_acquisition'));
});

test('incomparable price units and field bases are not compared or claimed as checked', () => {
  for (const override of [{ measurement: { unit_code: 'unknown' } },
    { measurement: { unit_code: 'usd_per_share' } },
    { measurement: { measurement_nature: 'flow' } },
    { measurement: { status: 'unknown' } },
    { financial: { price_adjustment: { direction: 'adjusted' } } },
    { financial: { currency_conversion_ref: { kind: 'definition', namespace: 'test', id: 'currency-conversion',
      version: 'v1', digest: 'sha256:' + '1'.repeat(64) } } }]) {
    const { declaration, row } = fixture();
    declaration.target.definition.field_semantic_context.open = override as unknown as Record<string, Record<string, string>>;
    const result = checkR1TabularRows([{ ...row, open: '9999999999999999' }], declaration);
    assert.equal(result.quality, 'indeterminate');
    assert.equal(result.checkScope.includes('exact_decimal_ohlc'), false);
    assert.ok(result.checkScope.includes('nonnegative_volume_amount'));
  }
  const { declaration, row } = fixture();
  declaration.target.definition.field_semantic_context.open = { measurement: { unit_code: 'unknown' } };
  const unresolvedFullBar = checkR1TabularRows([{ ...row, high: '1' }], declaration);
  assert.equal(unresolvedFullBar.quality, 'indeterminate');
  assert.equal(unresolvedFullBar.checkScope.includes('exact_decimal_ohlc'), false);
  assert.ok(unresolvedFullBar.checkScope.includes('nonnegative_volume_amount'));
});

test('missing states, null values and unsupported types are never numeric zero or covered numeric checks', () => {
  const { declaration, row } = fixture();
  declaration.mapping.fields.find(field => field.fieldCode === 'open')!.state = 'openState';
  declaration.mapping.fields.find(field => field.fieldCode === 'volume')!.state = 'volumeState';
  const result = checkR1TabularRows([{ ...row, openState: 'valid_value', volumeState: 'valid_value' },
    { ...row, key: 'fixture:second', open: null, openState: 'unknown', volume: null, volumeState: 'not_reported' }], declaration);
  assert.equal(result.quality, 'indeterminate');
  assert.equal(result.checkScope.includes('exact_decimal_ohlc'), false);
  assert.equal(result.checkScope.includes('nonnegative_volume_amount'), false);
  const values = result.rows[1]!.values as Record<string, { value: unknown }>;
  assert.equal(values.open!.value, null); assert.equal(values.volume!.value, null);
  assert.throws(() => checkR1TabularRows([{ ...row, openState: 'unknown', volumeState: 'valid_value' }], declaration), code('R1_TABULAR_VALUE_STATE'));
  const missing = fixture();
  delete (missing.declaration.mapping.fields.find(field => field.fieldCode === 'volume')! as { state?: string }).state;
  const withoutState = checkR1TabularRows([missing.row], missing.declaration);
  assert.equal(withoutState.quality, 'indeterminate');
  assert.equal(withoutState.checkScope.includes('explicit_value_states'), false);
  assert.equal(withoutState.checkScope.includes('nonnegative_volume_amount'), false);
  const unsupported = fixture();
  unsupported.declaration.target.definition.field_definitions.find(field => field.field_code === 'volume')!.data_type = 'text';
  const textVolume = checkR1TabularRows([{ ...unsupported.row, volume: '-1' }], unsupported.declaration);
  assert.equal(textVolume.quality, 'indeterminate');
  assert.equal(textVolume.checkScope.includes('nonnegative_volume_amount'), false);
  assert.ok(textVolume.checkScope.includes('exact_decimal_ohlc'));
  const complete = fixture();
  complete.declaration.source.acquired_at_utc = complete.row.end;
  complete.declaration.target.definition.semantic_context.financial.price_adjustment.direction = 'raw';
  complete.declaration.mapping.fields.find(field => field.fieldCode === 'open')!.state = 'openState';
  assert.throws(() => checkR1TabularRows([{ ...complete.row, open: null, openState: 'unknown' }], complete.declaration), code('R1_TABULAR_BAR_INCOMPLETE'));
});

test('general one-field table keeps explicit state, current-only axis and fixed subject without market claims', () => {
  const declaration = {
    protocol: 'wfd.structured-ingest/1.0',
    source: { source_id: 'generic', provider: 'synthetic-test', requested_at_utc: '2026-01-02T00:00:00Z',
      acquired_at_utc: '2026-01-02T00:00:02Z' },
    mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
      precision: 'second', sourceTimezone: 'UTC', fields: [{ fieldCode: 'value', value: 'raw', state: 'state' }] },
    target: { subject: { kind: 'entity', namespace: 'test', id: 'one' },
      coverage: { scope: { rows: ['one'] }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { unit_code: 'per_field', measurement_nature: 'mixed_observation', field_definitions: [{ field_code: 'value', data_type: 'text', unit_code: 'text',
        measurement_nature: 'mixed_observation', time_role: 'observation' }],
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'instant', frequency: 'second', interval: 'half_open', timezone: 'UTC' } } } },
  };
  const row = { key: 'one', start: '2026-01-02T00:00:00Z', end: '2026-01-02T00:00:01Z', raw: 'A', state: 'valid_value' };
  const checked = checkR1TabularRows([row], declaration);
  assert.equal(checked.quality, 'pass', checked.gaps.join('；'));
  assert.equal((checked.rows[0]!.values as Record<string, { value: string }>).value!.value, 'A');
  assert.deepEqual(checked.rows[0]!.subject, declaration.target.subject);
  assert.ok(checked.checkScope.includes('general_tabular_semantics'));
  assert.ok(checked.checkScope.includes('explicit_coverage_declaration'));
  assert.equal(checked.checkScope.includes('exact_decimal_ohlc'), false);
  assert.equal(checked.checkScope.includes('bar_closed_by_acquisition'), false);
  const nullRow = { ...row, raw: null, state: 'unknown' };
  assert.equal((checkR1TabularRows([nullRow], declaration).rows[0]!.values as Record<string, { value: null }>).value!.value, null);
  assert.throws(() => checkR1TabularRows([{ ...row, raw: null }], declaration), code('R1_TABULAR_VALUE'));
  assert.throws(() => checkR1TabularRows([row, row], declaration), code('R1_TABULAR_KEY'));
  const validTextUnit = structuredClone(declaration);
  validTextUnit.target.definition.field_definitions[0]!.unit_code = 'not_applicable';
  assert.equal(checkR1TabularRows([row], validTextUnit).quality, 'pass');
  const incompatibleTextUnit = structuredClone(declaration);
  incompatibleTextUnit.target.definition.field_definitions[0]!.unit_code = 'cny';
  assert.equal(checkR1TabularRows([row], incompatibleTextUnit).quality, 'indeterminate');
  const incompatibleNumberUnit = structuredClone(declaration);
  incompatibleNumberUnit.target.definition.field_definitions[0]!.data_type = 'decimal';
  assert.equal(checkR1TabularRows([{ ...row, raw: '1' }], incompatibleNumberUnit).quality, 'indeterminate');
  const unsupportedNature = structuredClone(declaration);
  unsupportedNature.target.definition.semantic_context.content_nature = 'future_idea';
  assert.equal(checkR1TabularRows([row], unsupportedNature).quality, 'indeterminate');
  const conflictingFieldNature = structuredClone(declaration) as unknown as Record<string, unknown>;
  ((conflictingFieldNature.target as Record<string, unknown>).definition as Record<string, unknown>).field_semantic_context = {
    value: { content: { content_nature: 'forecast' } } };
  assert.equal(checkR1TabularRows([row], conflictingFieldNature).quality, 'indeterminate');
  const unsupportedCurrent = structuredClone(declaration);
  Object.assign(unsupportedCurrent.target.definition.semantic_context, { version_axis: { revision_mode: 'current_only_business' } });
  assert.equal(checkR1TabularRows([row], unsupportedCurrent).quality, 'indeterminate');
});

test('partial market roles check only declared comparable constraints and preserve raw-price gate', () => {
  const partial = structuredClone(fixture().declaration) as unknown as Record<string, unknown>;
  const mapping = partial.mapping as Record<string, unknown>, target = partial.target as Record<string, unknown>;
  const definition = target.definition as Record<string, unknown>, context = definition.semantic_context as Record<string, unknown>;
  const financial = context.financial as Record<string, unknown>;
  financial.price_adjustment = { direction: 'raw' }; (partial.source as Record<string, unknown>).acquired_at_utc = '2026-01-07T00:00:00Z';
  mapping.bar = { frequency: 'day', close: 'close' };
  mapping.fields = [{ fieldCode: 'close', value: 'close', state: 'state' }];
  definition.field_definitions = (definition.field_definitions as Record<string, unknown>[]).filter(field => field.field_code === 'close');
  definition.field_semantic_context = {};
  const row = { key: 'one', start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', close: '11.50', state: 'valid_value' };
  const checked = checkR1TabularRows([row], partial);
  assert.equal(checked.quality, 'pass');
  assert.ok(checked.checkScope.includes('positive_declared_market_prices'));
  assert.equal(checked.checkScope.includes('exact_decimal_ohlc'), false);
  assert.equal(checked.checkScope.includes('nonnegative_volume_amount'), false);
  assert.throws(() => checkR1TabularRows([{ ...row, close: '0' }], partial), code('R1_TABULAR_OHLC'));
  financial.price_adjustment = { direction: 'adjusted' };
  assert.equal(checkR1TabularRows([row], partial).quality, 'indeterminate');
  delete mapping.bar;
  assert.equal(checkR1TabularRows([row], partial).quality, 'indeterminate');
  assert.match(checkR1TabularRows([row], partial).gaps.join(' '), /不能省略 bar/);
});

test('partial high/low and volume roles check bounds and sign without requiring absent roles', () => {
  const partial = structuredClone(fixture().declaration) as unknown as Record<string, unknown>;
  const mapping = partial.mapping as Record<string, unknown>, target = partial.target as Record<string, unknown>;
  const definition = target.definition as Record<string, unknown>;
  ((definition.semantic_context as Record<string, unknown>).financial as Record<string, unknown>).price_adjustment = { direction: 'raw' };
  (partial.source as Record<string, unknown>).acquired_at_utc = '2026-01-07T00:00:00Z';
  mapping.bar = { frequency: 'day', high: 'high', low: 'low', volume: 'volume' };
  mapping.fields = ['high', 'low', 'volume'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' }));
  definition.field_definitions = (definition.field_definitions as Record<string, unknown>[]).filter(field => ['high', 'low', 'volume'].includes(String(field.field_code)));
  definition.field_semantic_context = { volume: { measurement: { aggregation: 'period_total' } } };
  const row = { key: 'one', start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z',
    high: '11.51', low: '11.41', volume: '100', state: 'valid_value' };
  const checked = checkR1TabularRows([row], partial);
  assert.equal(checked.quality, 'pass');
  assert.ok(checked.checkScope.includes('partial_decimal_price_bounds'));
  assert.ok(checked.checkScope.includes('nonnegative_volume_amount'));
  assert.equal(checked.checkScope.includes('exact_decimal_ohlc'), false);
  assert.throws(() => checkR1TabularRows([{ ...row, high: '11.40' }], partial), code('R1_TABULAR_OHLC'));
  assert.throws(() => checkR1TabularRows([{ ...row, volume: '-1' }], partial), code('R1_TABULAR_QUANTITY'));
  mapping.bar = { frequency: 'day', high: 'high', low: 'high' };
  assert.throws(() => checkR1TabularRows([row], partial), code('R1_TABULAR_FIELDS'));
});

test('price-adjusted unassigned field cannot hide behind a volume-only market role', () => {
  const partial = structuredClone(fixture().declaration) as unknown as Record<string, unknown>;
  const mapping = partial.mapping as Record<string, unknown>, target = partial.target as Record<string, unknown>;
  const definition = target.definition as Record<string, unknown>;
  ((definition.semantic_context as Record<string, unknown>).financial as Record<string, unknown>).price_adjustment = {};
  (partial.source as Record<string, unknown>).acquired_at_utc = '2026-01-07T00:00:00Z';
  mapping.bar = { frequency: 'day', volume: 'volume' };
  mapping.fields = ['close', 'volume'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' }));
  definition.field_definitions = (definition.field_definitions as Record<string, unknown>[]).filter(field => ['close', 'volume'].includes(String(field.field_code)));
  definition.field_semantic_context = { close: { financial: { price_adjustment: { direction: 'unknown' } } },
    volume: { measurement: { aggregation: 'period_total' } } };
  const row = { key: 'one', start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z',
    close: '11.50', volume: '100', state: 'valid_value' };
  const checked = checkR1TabularRows([row], partial);
  assert.equal(checked.quality, 'indeterminate');
  assert.match(checked.gaps.join(' '), /未绑定到实际价格角色/);
});

test('append retains duplicate input rows for authoritative review while complete snapshots still require unique keys',()=>{
  const {declaration,row}=fixture();
  const target=declaration.target as typeof declaration.target & {inputMode:string};target.inputMode='partial_observation';
  const result=checkR1TabularRows([row,{...row},{...row,close:'9007199254740993.01'}],declaration);
  assert.equal(result.rows.length,3);assert.equal(result.rows[2]!.business_key,row.key);
  assert.equal(result.checkScope.includes('unique_business_keys'),false);
  assert.ok(result.checkScope.includes('business_keys_for_authoritative_duplicate_review'));
  target.inputMode='complete_snapshot';assert.throws(()=>checkR1TabularRows([row,{...row}],declaration),code('R1_TABULAR_KEY'));
});

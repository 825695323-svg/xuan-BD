import assert from 'node:assert/strict';
import test from 'node:test';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
const cell = (row: WfdRecord) => (row.values as Record<string, WfdRecord>).label!;
import { checkR1RelationRows, compileR1RelationDeclaration, isR1RelationDeclaration } from './r1-relation.js';
const declaration = (): any => ({ protocol: 'wfd.structured-ingest/1.0', mapping: {
  kind: 'relation_edges', businessKey: 'key', relationType: 'type', object: { kind: 'object_kind', namespace: 'object_ns', id: 'object_id' },
  effectivePeriod: { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: { status: 'unknown', sourceTimezone: 'UTC' },
  fields: [{ fieldCode: 'label', value: 'label', state: 'state' }],
}, target: { subject: { kind: 'entity', namespace: 'synthetic', id: 'subject' }, inputMode: 'partial_observation',
  definition: { semantic_code: 'synthetic.relation', definition_authority: 'synthetic', measurement_nature: 'relation', time_role: 'validity', unit_code: 'not_applicable',
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
    field_definitions: [{ field_code: 'label', data_type: 'text', measurement_nature: 'relation', time_role: 'validity', unit_code: 'text' }] },
  coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } } });
const row = () => ({ key: 'relation-1', type: 'declared_membership', object_kind: 'entity', object_ns: 'synthetic', object_id: 'declared_group', label: 'Unverified relation claim', state: 'valid_value' });
const known = (prefix: string) => ({ status: 'known', earliestUtc: prefix + '_start', latestExclusiveUtc: prefix + '_end', precision: 'second', sourceTimezone: 'UTC' });
test('relation preserves explicit object identity, typed fields, and independent unknown times', () => {
  const value = declaration(), raw = row();
  const checked = checkR1RelationRows([raw], value), mapped = checked.rows[0]!;
  assert.equal(checked.quality, 'pass'); assert.equal(isR1RelationDeclaration(value), true);
  assert.equal(compileR1RelationDeclaration(null).applicable, false);
  assert.deepEqual(mapped.object, { kind: 'entity', namespace: 'synthetic', id: 'declared_group' });
  assert.deepEqual(mapped.subject, value.target.subject);
  assert.equal(cell(mapped).value, raw.label);
  assert.equal((mapped.effective_period as WfdRecord).status, 'unknown'); assert.equal((mapped.effective_period as WfdRecord).earliest_utc, null);
  assert.equal((mapped.public_time as WfdRecord).status, 'unknown');
  assert.equal(Object.hasOwn(mapped, 'content_nature'), false, 'Relation nature belongs to existing definition, not a new row contract.');
  assert.deepEqual(checkR1RelationRows([raw, raw], value).rows, [mapped, mapped], 'Do not preempt authoritative duplicate/conflict decisions.');
});
test('relation public and effective intervals never substitute for one another', () => {
  const value = declaration(); value.mapping.effectivePeriod = known('effective');
  const raw = { ...row(), effective_start: '2025-03-01T00:00:00Z', effective_end: '2026-01-01T00:00:00Z', public_start: '2025-01-02T08:00:00Z', public_end: '2025-01-02T08:00:01Z' };
  let mapped = checkR1RelationRows([raw], value).rows[0]!;
  assert.equal((mapped.effective_period as WfdRecord).earliest_utc, raw.effective_start); assert.equal((mapped.public_time as WfdRecord).earliest_utc, null);
  value.mapping.publicTime = known('public'); mapped = checkR1RelationRows([raw], value).rows[0]!;
  assert.equal((mapped.public_time as WfdRecord).earliest_utc, raw.public_start);
  value.mapping.effectivePeriod = { status: 'unknown', sourceTimezone: 'UTC' };
  mapped = checkR1RelationRows([raw], value).rows[0]!;
  assert.equal((mapped.effective_period as WfdRecord).earliest_utc, null); assert.equal((mapped.public_time as WfdRecord).earliest_utc, raw.public_start);
  for (const patch of [{ public_start: '2025-02-30T08:00:00Z' }, { public_end: raw.public_start }, { public_start: '2025-01-02T08:00:00.123Z' }, { public_end: undefined }]) {
    assert.throws(() => checkR1RelationRows([{ ...raw, ...patch }], value), /UTC/);
  }
});
test('relation refuses invented identities, unsupported modes, semantic upgrades and incomplete contracts', () => {
  const mutations = [
    (v: any) => { v.target.subject.kind = 'theme'; }, (v: any) => { v.target.subject.extra = true; },
    (v: any) => { v.target.inputMode = 'source_correction'; }, (v: any) => { v.target.inputMode = 'complete_snapshot'; },
    (v: any) => { v.target.revisions = {}; }, (v: any) => { v.mapping.object.id = '../path'; },
    (v: any) => { delete v.mapping.object.namespace; }, (v: any) => { v.mapping.confirmed = true; },
    (v: any) => { v.target.definition.semantic_context.content_nature = 'observed_fact'; },
    (v: any) => { v.target.definition.semantic_context.unknown_axes = ['identity']; },
    (v: any) => { v.target.definition.time_role = 'observation'; },
    (v: any) => { v.target.definition.field_definitions[0].time_role = 'event'; },
    (v: any) => { v.target.definition.field_definitions[0].field_code = 'other'; },
    (v: any) => { v.mapping.fields.push(v.mapping.fields[0]); },
    (v: any) => { delete v.mapping.fields[0].state; },
    (v: any) => { v.mapping.publicTime = { status: 'known', sourceTimezone: 'UTC' }; },
    (v: any) => { v.mapping.publicTime.sourceTimezone = 'invented/timezone'; },
    (v: any) => { v.mapping.effectivePeriod.extra = true; },
    (v: any) => { v.target.coverage.absence_means = 'not_exists'; },
  ];
  for (const mutate of mutations) { const value = declaration(); mutate(value); assert.throws(() => compileR1RelationDeclaration(value), { code: 'R1_RELATION_MAPPING' }); }
  for (const patch of [{ object_kind: 'theme' }, { object_id: 'name with spaces' }, { object_ns: undefined }, { type: '../path' }, { state: undefined }, { label: undefined }]) {
    assert.throws(() => checkR1RelationRows([{ ...row(), ...patch }], declaration()));
  }
  assert.throws(() => checkR1RelationRows([{ ...row(), state: 'unknown' }], declaration()));
  assert.equal(cell(checkR1RelationRows([{ ...row(), state: 'unknown', label: null }], declaration()).rows[0]!).value, null);
  assert.throws(() => checkR1RelationRows([], declaration()));
  assert.throws(() => checkR1RelationRows(Array(5001).fill(row()), declaration()));
});
test('relation rules bind declarations and preserve exact decimals with explicit states', () => {
  const value = declaration(); value.target.definition.field_definitions[0].data_type = 'decimal';
  const before = compileR1RelationDeclaration(value).ruleDigest;
  assert.equal(cell(checkR1RelationRows([{ ...row(), label: '123.4500' }], value).rows[0]!).value, '123.4500');
  assert.throws(() => checkR1RelationRows([{ ...row(), label: 123.45 }], value));
  value.mapping.object.id = 'alternate_identity_column';
  assert.notEqual(compileR1RelationDeclaration(value).ruleDigest, before);
});

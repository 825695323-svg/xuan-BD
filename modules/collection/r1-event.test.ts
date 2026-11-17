import assert from 'node:assert/strict';
import test from 'node:test';
import { checkR1EventRows, compileR1EventDeclaration } from './r1-event.js';
const declaration = () => ({ protocol: 'wfd.structured-ingest/1.0', mapping: {
  kind: 'event_records', eventId: 'id', eventType: 'type', assertionKind: 'nature', contentNature: 'source_claim', status: 'unknown',
  eventTime: { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: { status: 'unknown', sourceTimezone: 'UTC' },
  fields: [{ fieldCode: 'text', value: 'text', state: 'state' }],
}, target: { subject: { kind: 'entity', namespace: 'synthetic', id: 'issuer' }, inputMode: 'partial_observation',
  definition: { semantic_code: 'synthetic.claim', time_role: 'event', measurement_nature: 'event', unit_code: 'not_applicable',
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
    field_definitions: [{ field_code: 'text', data_type: 'text', time_role: 'event', measurement_nature: 'event', unit_code: 'text' }] },
  coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } } });
const row = () => ({ id: 'claim-1', type: 'notice', nature: 'source_claim', text: 'Synthetic unverified claim.', state: 'valid_value' });
test('event source claim mapping preserves explicit unknowns and never copies receipt or acquisition time', () => {
  const checked = checkR1EventRows([row()], declaration());
  assert.equal(checked.quality, 'pass'); assert.equal(checked.rows[0]!.event_id, 'claim-1');
  assert.equal(checked.rows[0]!.event_time.earliest_utc, null); assert.equal(checked.rows[0]!.public_time.earliest_utc, null);
  assert.equal(Object.hasOwn(checked.rows[0]!, 'business_key'), false);
});
test('event admission rejects outcome laundering, missing states, target drift, and invented public time', () => {
  for (const mutation of [
    (value: any) => { value.mapping.contentNature = 'plan'; value.mapping.status = 'completed'; value.mapping.expectedTime = { status: 'unknown', sourceTimezone: 'UTC' }; },
    (value: any) => { value.mapping.contentNature = 'outcome'; },
    (value: any) => { value.mapping.publicTime = { status: 'known', earliestUtc: 'acquired' }; },
    (value: any) => { value.target.definition.semantic_context.content_nature = 'observed_fact'; },
    (value: any) => { value.mapping.fields[0].state = undefined; },
    (value: any) => { value.mapping.publisherAuthority = 'verified'; },
  ]) { const value = declaration(); mutation(value); assert.throws(() => compileR1EventDeclaration(value), /事件|未知|映射|计划|预计/); }
  assert.throws(() => checkR1EventRows([{ ...row(), nature: 'observed_fact' }], declaration()), /来源主张/);
  assert.throws(() => checkR1EventRows([{ ...row(), id: '../forged' }], declaration()), /身份/);
  assert.throws(() => checkR1EventRows([{ ...row(), state: 'unknown' }], declaration()), /null/);
  assert.throws(() => checkR1EventRows([{ ...row(), state: undefined }], declaration()), /状态/);
});

test('future plan uses expected time without substituting it into unknown occurrence or public time', () => {
  const value: any = declaration(); value.mapping.contentNature = 'plan'; value.mapping.status = 'planned';
  value.target.definition.semantic_context.content_nature = 'plan';
  assert.throws(() => compileR1EventDeclaration(value), /预计时间/);
  value.mapping.expectedTime = { status: 'known', earliestUtc: 'expected_start', latestExclusiveUtc: 'expected_end', precision: 'day', sourceTimezone: 'UTC' };
  const raw = { ...row(), nature: 'plan', expected_start: '2027-02-01T00:00:00Z', expected_end: '2027-02-02T00:00:00Z' };
  const output = checkR1EventRows([raw], value).rows[0]!;
  assert.equal(output.expected_time!.earliest_utc, raw.expected_start); assert.equal(output.event_time.status, 'unknown'); assert.equal(output.public_time.status, 'unknown');
  assert.throws(() => checkR1EventRows([{ ...raw, expected_start: '2027-02-30T00:00:00Z' }], value), /UTC/);
  assert.throws(() => checkR1EventRows([{ ...raw, expected_end: raw.expected_start }], value), /UTC/);
  value.mapping.status = 'realized'; assert.throws(() => compileR1EventDeclaration(value), /已完成事实/);
});

test('future elections, meetings, financial reporting, production and commitments use declared types rather than inferred occurrence', () => {
  const value: any = declaration(); value.mapping.contentNature = 'plan'; value.mapping.status = 'planned';
  value.target.definition.semantic_context.content_nature = 'plan';
  value.mapping.expectedTime = { status: 'unknown', sourceTimezone: 'UTC' };
  for (const type of ['election', 'meeting', 'financial_report', 'production_start', 'company_commitment']) {
    const output = checkR1EventRows([{ ...row(), nature: 'plan', type }], value).rows[0]!;
    assert.equal(output.event_type, type); assert.equal(output.content_nature, 'plan');
    assert.equal(output.expected_time!.status, 'unknown'); assert.equal(output.event_time.status, 'unknown');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ProductDiscovery, R1SnapshotStatus } from '../../../contracts/r1-contracts';
import { assertR1FilterEcho, buildR1FilterHistory } from './r1-filter-history';

const connection = { connectionId: 'c', profile: 'data_only', mode: 'user_test', runtimeIdentity: 'r', callerId: 'u', namespace: 'n' };
const subject = { kind: 'entity', id: 'e' }, field = { field_code: 'reading', data_type: 'decimal', unit_code: 'count' };
const product = { product_id: 'p', subject, declaration: { field_definitions: [field] }, payload_kind: 'tabular_rows', definition_ref: { id: 'd' }, contract_refs: { a: 'a' }, contract_bundle_ref: 'b', contract_ref: { digest: 'c' } };
const discovery = { connection, snapshotId: 's', products: [product] } as unknown as R1ProductDiscovery;
const input = { dataset_id: 'ds', snapshot_id: 's', ...buildR1FilterHistory({ historyMode: 'snapshot_contents' }), business_time_range: { role: 'observation', start: '2026-01-01', end: '2026-01-01', timezone: 'UTC' }, predicate: { compare: { metric: 'm', op: '>', value: { value: '0' } } }, order_by: [{ kind: 'subject', direction: 'asc' }], universe: { kind: 'explicit_subjects', subjects: [subject] }, metrics: [{ metric: 'm', field: 'reading', bindings: [{ subject, product_id: 'p' }] }] };
const result = { ...input, format_version: 'wfd.filter-objects-result/1', operation: 'filter_objects', connection, query_hash: 'sha256:' + 'a'.repeat(64), bindings: [{ metric: 'm', field: 'reading', subject, product_id: 'p', field_definition: field, definition_ref: product.definition_ref, contract_refs: product.contract_refs, contract_bundle_ref: 'b' }], objects: [{ subject, record_refs: { m: { product_id: 'p', field: 'reading', definition_ref: product.definition_ref, contract_ref: product.contract_ref, record_ref: { snapshot_id: 's', product_id: 'p', logical_key: 'key', revision_id: 'revision' } } } }], indeterminate: [] };

test('filter history requires explicit second UTC and actual holding instance/stage', () => {
  const status = { holdingInstance: { instanceId: 'instance-real-fixture', bindingSource: 'volume_binding' } } as R1SnapshotStatus;
  const selection = { historyMode: 'system_held_at' as const, at: '2026-01-01T00:00:00Z', usableStage: 'published_readable' };
  assert.equal(buildR1FilterHistory(selection, status).held_scope, 'instance-real-fixture');
  assert.throws(() => buildR1FilterHistory(selection), /实例/);
  assert.throws(() => buildR1FilterHistory({ ...selection, usableStage: '' }, status), /阶段/);
  for (const at of ['', '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00.123Z']) assert.throws(() => buildR1FilterHistory({ historyMode: 'market_known_at', at }));
  assert.throws(() => buildR1FilterHistory({ historyMode: 'snapshot_contents', at: selection.at }));
});

test('filter echo rejects changed times, predicate, fields, contracts, binding, scope and page hash', () => {
  assert.doesNotThrow(() => assertR1FilterEcho(input, result, discovery));
  for (const key of ['dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage', 'business_time_range', 'predicate', 'order_by']) {
    assert.throws(() => assertR1FilterEcho(input, { ...result, [key]: 'tampered' }, discovery), /核对/);
  }
  for (const key of ['metric', 'field', 'subject', 'product_id', 'field_definition', 'definition_ref', 'contract_refs', 'contract_bundle_ref']) {
    assert.throws(() => assertR1FilterEcho(input, { ...result, bindings: [{ ...result.bindings[0], [key]: 'tampered' }] }, discovery));
  }
  assert.throws(() => assertR1FilterEcho(input, { ...result, bindings: [...result.bindings, ...result.bindings] }, discovery));
  assert.throws(() => assertR1FilterEcho(input, { ...result, connection: { ...connection, callerId: 'other' } }, discovery));
  assert.throws(() => assertR1FilterEcho(input, result, discovery, 'sha256:' + 'b'.repeat(64)));
  assert.throws(() => assertR1FilterEcho(input, { ...result, objects: [{ subject: { kind: 'entity', id: 'other' } }] }, discovery));
  assert.throws(() => assertR1FilterEcho(input, { ...result, objects: [{ subject, record_refs: { m: { product_id: 'other' } } }] }, discovery));
});

test('filter permits only explicit empty budget gap and equivalent discovery duplicates', () => {
 assert.doesNotThrow(() => assertR1FilterEcho(input, result, { ...discovery, products: [product, structuredClone(product)] }));
 const budget = { ...result, status: 'budget_exceeded', bindings: [], objects: [], indeterminate: [], scan_receipt: { scan_complete: false }, page: { has_more: false, next_cursor: null, result_exhausted: false }, gaps: [{ code: 'DISCOVERY_BUDGET_EXCEEDED' }] };
 assert.doesNotThrow(() => assertR1FilterEcho(input, budget, discovery));
 assert.throws(() => assertR1FilterEcho(input, { ...budget, status: 'matched' }, discovery));
 assert.throws(() => assertR1FilterEcho(input, { ...budget, objects: result.objects }, discovery));
 for (const key of ['snapshot_id', 'product_id', 'logical_key', 'revision_id']) {
 const altered = structuredClone(result); altered.objects[0]!.record_refs.m.record_ref[key as keyof typeof altered.objects[0]['record_refs']['m']['record_ref']] = '';
 assert.throws(() => assertR1FilterEcho(input, altered, discovery));
 }
});

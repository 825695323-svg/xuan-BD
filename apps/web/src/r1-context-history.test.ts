import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ContextReadInput } from '../../../contracts/r1-contracts.js';
import { assertR1ContextHistoryEcho, buildR1ContextHistory, validateR1ContextHistoryInput } from './r1-context-history.js';
const at = '2025-02-01T00:00:00Z', start = '2025-05-01T00:00:00Z', end = '2025-05-01T00:00:01Z';
function input(): R1ContextReadInput {
  return { operation: 'read_relation_graph', snapshotId: 's_test', datasetId: 'synthetic',
    subject: { kind: 'entity', namespace: 'test', id: 'subject' }, ...buildR1ContextHistory({ historyMode: 'market_known_at', at, start, end }) };
}
function response(request = input()): Record<string, any> {
  const mode = request.historyMode ?? 'snapshot_contents';
  return { operation: request.operation, snapshotId: request.snapshotId, datasetId: request.datasetId, subject: { ...request.subject }, historyMode: mode,
    result: { operation: request.operation, snapshot_id: request.snapshotId, dataset_id: request.datasetId, subject: { ...request.subject }, history_mode: mode,
      held_scope: null, usable_stage: null, knowledge_cutoff: mode === 'snapshot_contents' ? null : { status: 'known', precision: 'second',
        earliest_utc: at, latest_exclusive_utc: '2025-02-01T00:00:01Z', source_timezone: 'UTC' },
      business_time_range: request.businessTimeRange ? { ...request.businessTimeRange } : null } };
}
test('explicit UTC axes become existing inclusive-second validity contract, including a one-second window', () => {
  const history = buildR1ContextHistory({ historyMode: 'market_known_at', at, start, end });
  assert.deepEqual(history, { historyMode: 'market_known_at', at, businessTimeRange: {
    role: 'validity', start: '2025-05-01T00:00:00', end: '2025-05-01T00:00:01', timezone: 'UTC' } });
  assert.equal(buildR1ContextHistory({ historyMode: 'market_known_at', at, start, end: start }).businessTimeRange?.end, start.slice(0, -1));
  assert.deepEqual(buildR1ContextHistory({}), { historyMode: 'snapshot_contents' });
  assertR1ContextHistoryEcho(input(), response());
});
test('missing, invalid, mixed or reversed axes fail without defaults', () => {
  for (const change of [{ at: '' }, { start: '' }, { end: '' }, { start: '2025-02-30T00:00:00Z' },
    { start: '2025-05-01' }, { end: '2025-05-01T00:00:00.000Z' }, { end: '2025-04-01T00:00:00Z' }]) {
    assert.throws(() => buildR1ContextHistory({ historyMode: 'market_known_at', at, start, end, ...change }));
  }
  assert.throws(() => buildR1ContextHistory({ historyMode: 'snapshot_contents', at }));
  assert.throws(() => buildR1ContextHistory({ historyMode: 'snapshot_contents', start, end }));
  for (const operation of ['read_company_context', 'read_applicable_rules'] as const) {
    assert.throws(() => validateR1ContextHistoryInput({ ...input(), operation }));
  }
  assert.throws(() => validateR1ContextHistoryInput({ ...input(), businessTimeRange: null }));
});
test('graph identity, complete subject, history envelope and validity echo cannot drift or add keys', () => {
  const request = input();
  for (const key of ['operation', 'snapshotId', 'datasetId', 'historyMode']) {
    const value = response(); value[key] = 'wrong'; assert.throws(() => assertR1ContextHistoryEcho(request, value));
  }
  for (const key of ['operation', 'snapshot_id', 'dataset_id', 'history_mode', 'held_scope', 'usable_stage']) {
    const value = response(); value.result[key] = 'wrong'; assert.throws(() => assertR1ContextHistoryEcho(request, value));
  }
  for (const parent of ['outer', 'inner']) for (const key of ['kind', 'namespace', 'id', 'extra']) {
    const value = response(); (parent === 'outer' ? value.subject : value.result.subject)[key] = 'wrong';
    assert.throws(() => assertR1ContextHistoryEcho(request, value));
  }
  for (const part of ['knowledge_cutoff', 'business_time_range']) {
    for (const key of [...Object.keys(response().result[part]), 'extra']) {
      const value = response(); value.result[part][key] = 'wrong'; assert.throws(() => assertR1ContextHistoryEcho(request, value));
      delete value.result[part][key];
      if (key !== 'extra') assert.throws(() => assertR1ContextHistoryEcho(request, value));
    }
  }
});
test('snapshot graph expects null history and range; other snapshot contexts retain legacy time-envelope compatibility', () => {
  const graph = { ...input(), historyMode: 'snapshot_contents' as const, at: undefined, businessTimeRange: undefined };
  assertR1ContextHistoryEcho(graph, response(graph));
  const bad = response(graph); delete bad.result.knowledge_cutoff;
  assert.throws(() => assertR1ContextHistoryEcho(graph, bad));
  for (const operation of ['read_company_context', 'read_applicable_rules'] as const) {
    const request = { ...graph, operation }, value = response(request);
    for (const key of ['knowledge_cutoff', 'held_scope', 'usable_stage', 'business_time_range']) delete value.result[key];
    assertR1ContextHistoryEcho(request, value);
  }
});

 test('event market UI keeps cutoff separate, accepts no validity range and strictly checks history echo', () => {
  const history = buildR1ContextHistory({ operation: 'read_event_timeline', historyMode: 'market_known_at', at });
  assert.deepEqual(history, { historyMode: 'market_known_at', at, businessTimeRange: null });
  const request = { ...input(), operation: 'read_event_timeline' as const, ...history };
  validateR1ContextHistoryInput(request); assertR1ContextHistoryEcho(request, response(request));
  for (const extra of [{ start, end }, { at: '2025-02-30T00:00:00Z' }]) assert.throws(() => buildR1ContextHistory({ operation: 'read_event_timeline', historyMode: 'market_known_at', at, ...extra }));
  assert.throws(() => validateR1ContextHistoryInput({ ...request, businessTimeRange: input().businessTimeRange }));
  for (const key of ['knowledge_cutoff', 'business_time_range', 'held_scope', 'usable_stage']) {
    const bad = response(request); bad.result[key] = { wrong: true }; assert.throws(() => assertR1ContextHistoryEcho(request, bad));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertR1ReadHistoryEcho, buildR1ReadHistory, isR1HoldingInstance, validateR1ReadHistoryInput, sameR1ReadConnection } from './r1-read-history.js';

const at = '2025-01-02T03:04:05Z';
const status = { holdingInstance: { instanceId: 'synthetic-instance', bindingSource: 'volume_binding' as const } };
function response(mode: 'snapshot_contents' | 'market_known_at' | 'system_held_at') {
  return { historyMode: mode, result: { history_mode: mode,
    knowledge_cutoff: mode === 'snapshot_contents' ? null : { status: 'known', precision: 'second', earliest_utc: at,
      latest_exclusive_utc: '2025-01-02T03:04:06Z', source_timezone: 'UTC' },
    held_scope: mode === 'system_held_at' ? status.holdingInstance.instanceId : null,
    usable_stage: mode === 'system_held_at' ? 'acquired' : null } };
}

test('three explicit perspectives preserve cutoff and independently selected holding stage', () => {
  assert.deepEqual(buildR1ReadHistory({ historyMode: undefined }), { historyMode: 'snapshot_contents' });
  assertR1ReadHistoryEcho({}, response('snapshot_contents'));
  const market = buildR1ReadHistory({ historyMode: 'market_known_at', at });
  assert.deepEqual(market, { historyMode: 'market_known_at', at });
  assertR1ReadHistoryEcho(market, response('market_known_at'));
  for (const usableStage of ['acquired', 'custodied', 'published_readable'] as const) {
    const input = buildR1ReadHistory({ historyMode: 'system_held_at', at, usableStage }, status);
    assert.equal(input.heldScope, status.holdingInstance.instanceId);
    assert.equal(input.usableStage, usableStage);
    const echo = response('system_held_at'); echo.result.usable_stage = usableStage;
    assertR1ReadHistoryEcho(input, echo);
  }
});

test('no inferred date, instance or stage; snapshot and market reject mixed history', () => {
  for (const invalid of ['', '2025-01-02', '2025-02-30T00:00:00Z', '2025-01-02T03:04:05.000Z',
    '2025-01-02T03:04:05+00:00', '9999-12-31T23:59:59Z']) {
    assert.throws(() => buildR1ReadHistory({ historyMode: 'market_known_at', at: invalid }));
  }
  for (const missing of [undefined, null, {}, { holdingInstance: null }]) {
    assert.throws(() => buildR1ReadHistory({ historyMode: 'system_held_at', at, usableStage: 'acquired' }, missing));
  }
  for (const usableStage of [undefined, '', 'unknown']) {
    assert.throws(() => buildR1ReadHistory({ historyMode: 'system_held_at', at, usableStage }, status));
  }
  for (const input of [{ at }, { heldScope: 'other' }, { usableStage: 'acquired' as const }]) {
    assert.throws(() => validateR1ReadHistoryInput(input));
  }
  assert.throws(() => validateR1ReadHistoryInput({ historyMode: 'market_known_at', at, heldScope: 'other' }));
  assert.throws(() => validateR1ReadHistoryInput({ historyMode: 'market_known_at', at, usableStage: 'acquired' }));
  assert.equal(isR1HoldingInstance(status.holdingInstance), true);
  for (const holding of [null, {}, { ...status.holdingInstance, instanceId: '' },
    { ...status.holdingInstance, bindingSource: 'guessed' }, { ...status.holdingInstance, extra: true }]) {
    assert.equal(isR1HoldingInstance(holding), false);
  }
});

test('every historical echo field must match; missing and extra cutoff fields fail closed', () => {
  for (const mode of ['market_known_at', 'system_held_at'] as const) {
    const input = buildR1ReadHistory({ historyMode: mode, at, ...(mode === 'system_held_at' ? { usableStage: 'acquired' } : {}) }, status);
    for (const key of Object.keys(response(mode).result.knowledge_cutoff!)) {
      for (const remove of [true, false]) {
        const echo = response(mode), cutoff = echo.result.knowledge_cutoff as Record<string, unknown>;
        if (remove) delete cutoff[key]; else cutoff[key] = 'wrong';
        assert.throws(() => assertR1ReadHistoryEcho(input, echo), key);
      }
    }
    const extra = response(mode);
    Object.assign(extra.result.knowledge_cutoff!, { extra: true });
    assert.throws(() => assertR1ReadHistoryEcho(input, extra));
    for (const key of ['history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage']) {
      const echo = response(mode); (echo.result as Record<string, unknown>)[key] = 'wrong';
      assert.throws(() => assertR1ReadHistoryEcho(input, echo), key);
      delete (echo.result as Record<string, unknown>)[key];
      assert.throws(() => assertR1ReadHistoryEcho(input, echo), key);
    }
    assert.throws(() => assertR1ReadHistoryEcho(input, { ...response(mode), historyMode: 'snapshot_contents' }));
  }
  for (const key of ['knowledge_cutoff', 'held_scope', 'usable_stage']) {
    const echo = response('snapshot_contents'); delete (echo.result as Record<string, unknown>)[key];
    assert.throws(() => assertR1ReadHistoryEcho({}, echo));
  }
});


test('shared read binding comparison checks all six identity fields, never just connection ID', () => {
  const binding = { connectionId: 'synthetic', profile: 'data_only' as const, mode: 'user_test' as const,
    runtimeIdentity: 'runtime', callerId: 'caller', namespace: 'synthetic' };
  assert.equal(sameR1ReadConnection(binding, { ...binding }), true);
  for (const field of Object.keys(binding)) {
    assert.equal(sameR1ReadConnection(binding, { ...binding, [field]: 'changed' }), false, field);
    assert.equal(sameR1ReadConnection({ ...binding, [field]: '' }, { ...binding, [field]: '' }), false, field);
  }
});

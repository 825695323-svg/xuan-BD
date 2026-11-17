import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ProductDiscovery } from '../../../contracts/r1-contracts';
import { assertR1JointEcho } from './r1-joint-history';

const noDiscovery = {} as R1ProductDiscovery;
test('joint UI refuses to equate document holding with a WFD instance/stage', async () => {
  await assert.rejects(assertR1JointEcho({ structured: { history_mode: 'system_held_at', held_scope: 'actual-instance', usable_stage: 'published_readable' },
    documents: { mode: 'system_held_at', asOf: '2026-01-01T00:00:00Z', indexVersion: 'fixed-index', method: 'keyword', query: 'evidence' } }, {}, noDiscovery), /文档持有/);
});
test('joint UI rejects mixed snapshot/public cutoffs and unspecified document index before inspecting results', async () => {
  const documents = { mode: null, asOf: null, indexVersion: 'fixed-index', method: 'keyword', query: 'evidence' };
  for (const docs of [{ ...documents, mode: 'market_known_at' }, { ...documents, asOf: '2026-01-01T00:00:00Z' }, { ...documents, indexVersion: '' }]) {
    await assert.rejects(assertR1JointEcho({ structured: { history_mode: 'snapshot_contents' }, documents: docs }, {}, noDiscovery), /无法核对/);
  }
  await assert.rejects(assertR1JointEcho({ structured: { history_mode: 'market_known_at', knowledge_cutoff: { earliest_utc: '2026-01-01T00:00:00Z' } },
    documents: { ...documents, mode: 'market_known_at', asOf: '2026-01-02T00:00:00Z' } }, {}, noDiscovery), /无法核对/);
});

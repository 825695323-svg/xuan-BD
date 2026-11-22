import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ProductDiscovery, R1ProductRead, R1SnapshotStatus } from '../../contracts/r1-contracts.js';
import { RESEARCH_FIELDS, chartBars, researchProducts } from '../web/src/research-bars.js';
import { sameR1ReadConnection } from '../web/src/r1-read-history.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { preparedSetPlan } from './r1-publication-set-test-support.js';

export async function publishResearchFixture(host: FullChainHost) {
  const { planId } = await preparedSetPlan(host, 'research-ohlc');
  const requestId = 'research-ohlc-set';
  const prepared = await host.call('/r1/prepare', { kind: 'publication_set', requestId, planId, setId: 'pair' }, 201);
  const sent = await host.call('/r1/requests/' + requestId + '/submit', { confirmationDigest: prepared.documentSha256 }, 202);
  const settled = await host.settled(sent.jobId);
  assert.equal(settled.status, 'succeeded', JSON.stringify(settled.error));
}

const enabled = !!process.env.XUAN_FULL_CHAIN_ROOT && !!process.env.WFD_PYTHON;
test('research workbench reads only the existing published R1/WFD fixed price contract', { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'research-workbench', machine: true,
    units: { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } } });
  const host = await openFullChainHost(fixture, fixture.root);
  try {
    const empty = await host.call('/r1/products/snapshot', {}) as R1SnapshotStatus;
    assert.equal(empty.snapshotId, null);
    await publishResearchFixture(host);
    const snapshot = await host.call('/r1/products/snapshot', {}) as R1SnapshotStatus;
    assert.ok(snapshot.snapshotId);
    const counts = () => ['tasks', 'processing_plans', 'r1_handoff_attempts'].map(table =>
      host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    const before = counts();
    const catalog = await host.call('/r1/products/discover', { snapshotId: snapshot.snapshotId }) as R1ProductDiscovery;
    assert.equal(sameR1ReadConnection(snapshot.connection, catalog.connection), true);
    const products = researchProducts(catalog);
    assert.equal(products.length, 2, JSON.stringify(catalog));
    const selected = products.find(product => product.selection.subject.id === 'left')!;
    const response = await host.call('/r1/products/read', { snapshotId: catalog.snapshotId, productId: selected.selection.productId,
      historyMode: 'snapshot_contents', pageSize: 100, fields: [...RESEARCH_FIELDS], cursor: null }) as R1ProductRead;
    assert.equal(sameR1ReadConnection(catalog.connection, response.connection), true);
    assert.equal(response.snapshotId, catalog.snapshotId);
    assert.equal(response.productId, selected.selection.productId);
    assert.deepEqual(chartBars(response.result.rows as unknown[], selected), {
      skipped: 0, conflict: false, bars: [{ time: Date.parse('2026-01-04T16:00:00Z') / 1000, end: Date.parse('2026-01-05T16:00:00Z') / 1000,
        open: 11.42, high: 11.51, low: 11.41, close: 11.5 }],
    });
    assert.deepEqual(counts(), before);
    assert.deepEqual(await host.call('/r1/products/snapshot', {}), snapshot);
  } finally { await host.close(); }
});

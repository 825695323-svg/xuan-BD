import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WfdProductMachineClient, WfdProductMachineError,
  type WfdProductMachineReadProductPageOptions, type WfdProductMachineReply,
} from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';

// Dispatch-only doubles. These tests do not spawn Python or prove a real read.
const snapshotId = 's_' + '1'.repeat(24), productId = 'p_' + '2'.repeat(24);
const identity = { snapshotId, productId };
function fixture() {
  const calls: Array<{ operation: string; args: WfdRecord; signal?: AbortSignal }> = [];
  const client = Object.create(WfdProductMachineClient.prototype) as WfdProductMachineClient;
  const reply: WfdProductMachineReply = { result: { dispatchOnlyDouble: true }, response: {}, transport: {
    operation: 'dispatch-only-double', requestId: 'dispatch-only-double', elapsedMs: null, responseBytes: 0,
    serviceVersion: null, contractVersion: null, schemaId: null, connectionId: null, callerId: null, trustedActorNamespace: null,
  } };
  client.request = async (operation, args, signal) => { calls.push({ operation, args, signal }); return reply; };
  return { client, calls, reply };
}
function read(client: WfdProductMachineClient, options: unknown) {
  return client.readProductPage(options as WfdProductMachineReadProductPageOptions);
}
const invalid = { code: 'WFD_PRODUCT_MACHINE_REQUEST', operation: 'fixed_read_product_page' };

test('F09-02 dispatch double: product page sends only explicit fixed identities and preserves service defaults', async () => {
  const { client, calls, reply } = fixture();
  assert.equal(await client.readProductPage(identity), reply);
  assert.deepEqual(calls, [{ operation: 'fixed_read_product_page', args: { snapshot_id: snapshotId, product_id: productId }, signal: undefined }]);
});

test('F09-02 dispatch double: optional budgets and exact cursor/signal translate without refs or projection', async () => {
  const { client, calls } = fixture(), signal = new AbortController().signal;
  await client.readProductPage({ ...identity, pageSize: 128, maxPageBytes: 700000, cursor: 'opaque-original-cursor' }, signal);
  assert.deepEqual(calls, [{ operation: 'fixed_read_product_page', args: {
    snapshot_id: snapshotId, product_id: productId, page_size: 128, max_page_bytes: 700000, cursor: 'opaque-original-cursor',
  }, signal }]);
});

test('F09-02 dispatch double: inclusive budget bounds and explicit null initial cursor remain exact', async () => {
  const { client, calls } = fixture();
  await client.readProductPage({ ...identity, pageSize: 1, maxPageBytes: 1, cursor: null });
  await client.readProductPage({ ...identity, pageSize: 1000, maxPageBytes: 4194304 });
  assert.deepEqual(calls.map(c => c.args), [
    { snapshot_id: snapshotId, product_id: productId, page_size: 1, max_page_bytes: 1, cursor: null },
    { snapshot_id: snapshotId, product_id: productId, page_size: 1000, max_page_bytes: 4194304 },
  ]);
});

test('F09-02 dispatch double: absent, moving, malformed or nonexact product/snapshot identities reject before request', async () => {
  const { client, calls } = fixture();
  for (const options of [undefined, null, [], '', {}, { productId }, { snapshotId },
    { ...identity, snapshotId: 'latest' }, { ...identity, snapshotId: 'CURRENT' }, { ...identity, snapshotId: snapshotId.toUpperCase() },
    { ...identity, snapshotId: 's_' + '1'.repeat(25) }, { ...identity, productId: 'p_unfixed' }, { ...identity, productId: null }]) {
    await assert.rejects(read(client, options), invalid);
  }
  assert.equal(calls.length, 0);
});

test('F09-02 dispatch double: invalid or coerced page row bounds reject before request', async () => {
  const { client, calls } = fixture();
  for (const pageSize of [0, -1, 1001, 1.5, NaN, Infinity, null, true, '256']) {
    await assert.rejects(read(client, { ...identity, pageSize }), invalid);
  }
  assert.equal(calls.length, 0);
});

test('F09-02 dispatch double: invalid or coerced complete-result byte bounds reject before request', async () => {
  const { client, calls } = fixture();
  for (const maxPageBytes of [0, -1, 4194305, 1.5, NaN, Infinity, null, true, '1048576']) {
    await assert.rejects(read(client, { ...identity, maxPageBytes }), invalid);
  }
  assert.equal(calls.length, 0);
});

test('F09-02 dispatch double: invalid cursor shapes never become a fresh read', async () => {
  const { client, calls } = fixture();
  for (const cursor of ['', 0, false, {}, []]) await assert.rejects(read(client, { ...identity, cursor }), invalid);
  assert.equal(calls.length, 0);
});

test('F09-02 dispatch double: selected refs, historical filters, projection or caller authority cannot enter full-product DTO', async () => {
  const { client, calls } = fixture();
  for (const extra of [{ recordRefs: [] }, { record_refs: [] }, { perspective: 'market_known_at' }, { includeHistory: true },
    { rowProjection: 'compact' }, { at: '2026-01-01T00:00:00Z' }, { subject: 'any' }, { roles: ['admin'] },
    { trustedActorNamespace: 'other' }, { maxResponseBytes: 67108864 }, { unknown: undefined }]) {
    await assert.rejects(read(client, { ...identity, ...extra }), invalid);
  }
  assert.equal(calls.length, 0);
});

test('F09-02 dispatch double: page error passes through once, without retry, full read or selected-page fallback', async () => {
  const { client, calls } = fixture();
  const remote = new WfdProductMachineError('PAGE_ITEM_TOO_LARGE', 'explicit double rejection', {
    operation: 'fixed_read_product_page', requestId: 'double-request', remoteCode: 'PAGE_ITEM_TOO_LARGE',
  });
  client.request = async (operation, args, signal) => { calls.push({ operation, args, signal }); throw remote; };
  await assert.rejects(client.readProductPage(identity), error => error === remote);
  assert.deepEqual(calls.map(c => c.operation), ['fixed_read_product_page']);
});

test('F09-02 dispatch double: existing selected-ref and legacy full-read DTOs keep their original domains', async () => {
  const { client, calls } = fixture(), refs = [{ record_id: 'selected-row', record_version: 'r-original' }];
  await client.readPage({ ...identity, recordRefs: refs, pageSize: 256, maxPageBytes: 1048576, cursor: null });
  await client.read({ ...identity, includeHistory: false, rowProjection: 'full' });
  assert.deepEqual(calls.map(c => ({ operation: c.operation, args: c.args })), [
    { operation: 'fixed_read_page', args: { snapshot_id: snapshotId, product_id: productId, record_refs: refs, page_size: 256, max_page_bytes: 1048576, cursor: null } },
    { operation: 'fixed_read', args: { snapshot_id: snapshotId, product_id: productId, include_history: false, row_projection: 'full' } },
  ]);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createWfdProductMachineSnapshotPort } from '../../modules/financial/product-machine-snapshot.js';
import type { AlgorithmSnapshotReference } from '../../modules/financial/algorithm-types.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import { createFullChainFixture, openFullChainHost, type FullChainFixture, type FullChainHost } from './full-chain-test-support.js';

const python = process.env.WFD_PYTHON;
const productRoot = fileURLToPath(new URL('../../wfd/product', import.meta.url));
const enabled = !!python && !!process.env.XUAN_FULL_CHAIN_ROOT;
const namespace = 'full.chain.test';
const subject = { kind: 'entity', namespace, id: 'synthetic_history_subject' };
const second = (at: string): WfdRecord => ({ status: 'known', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), precision: 'second', source_timezone: 'UTC' });
const period: WfdRecord = { status: 'known', earliest_utc: '2024-01-01T00:00:00Z',
  latest_exclusive_utc: '2025-01-01T00:00:00Z', precision: 'day', source_timezone: 'UTC' };
const definition = { semantic_code: 'synthetic.history.amount', measurement_nature: 'flow', unit_code: 'per_field',
  definition_authority: namespace, time_role: 'observation',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
    time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
  field_definitions: [{ field_code: 'amount', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }] };
function row(key: string, value: string, publicTime?: WfdRecord): WfdRecord {
  return { business_key: key, subject, observation_time: period,
    ...(publicTime ? { public_time: publicTime } : {}),
    values: { amount: { data_type: 'decimal', value_state: 'valid_value', value } } };
}
function document(requestId: string, rows: WfdRecord[], parent: string | null = null,
  revision?: { mode: 'source_correction' | 'withdrawal'; definitionRef: WfdRecord; previous: WfdRecord; withdrawalPublicTime?: WfdRecord }) {
  return buildStructuredIngestDocument({ requestId, datasetId: 'synthetic_history', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ requestId, rows, parent, revision: revision ?? null })),
    definitionPublicTime: second('2024-01-01T00:00:00Z'),
    expectedParentSnapshotId: parent, outputKey: 'history', subject, definition: structuredClone(definition),
    inputMode: revision?.mode ?? 'partial_observation',
    ...(revision ? { definitionMode: 'reuse' as const, definitionRef: revision.definitionRef,
      revisions: { [String(rows[0]!.business_key)]: { previous: revision.previous, reason: 'Explicit isolated history boundary fixture',
        ...(revision.withdrawalPublicTime ? { withdrawal_public_time: revision.withdrawalPublicTime } : {}) } } } : {}),
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
function values(response: { result: WfdRecord }): Record<string, string | null> {
  return Object.fromEntries((response.result.rows as WfdRecord[]).map(item => [
    (item.record_ref as WfdRecord).logical_key,
    ((item.values as WfdRecord).amount as WfdRecord).value as string | null,
  ]));
}
async function publish(host: FullChainHost, doc: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(doc)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  assert.equal(result.formal_publication_verified, true);
  const output = (result.output_results as WfdRecord[])[0]!;
  return { snapshotId: String(result.snapshot_id), productId: String(output.product_id), output };
}
/** Explicit test-only holding evidence, accepted by WFD only with its existing isolated test switch. */
function hold(fixture: FullChainFixture, published: Awaited<ReturnType<typeof publish>>, times: string[]) {
  const invocation = spawnSync(python!, isolatedPythonArgs(join(fixture.root, 'python-cache'), ['-c',
    'import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from wfd_sdk.product_holdings import HoldingLedger; p=json.loads(sys.argv[3]); HoldingLedger(Path(sys.argv[2]),"synthetic-history-instance").record_test_fixture(snapshot_id=p["snapshotId"],product_id=p["productId"],records=p["records"],acquired_at=p["times"][0],custodied_at=p["times"][1],readable_at=p["times"][2])',
    productRoot, fixture.store, JSON.stringify({ ...published, records: published.output.records, times })]),
    { cwd: fixture.root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, WFD_HOLDINGS_TEST_MODE: '1' } });
  assert.equal(invocation.status, 0, invocation.stderr);
}

// Data, publication times and instance holding facts below are synthetic, never provider or wall-clock claims.
test('actual HTTP/WFD historical reads separate public, acquired and published-readable revisions and keep unknown dates explicit',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'r1-history', machine: true });
    let host = await openFullChainHost(fixture);
    const originalTestMode = process.env.WFD_HOLDINGS_TEST_MODE;
    process.env.WFD_HOLDINGS_TEST_MODE = '1';
    try {
      const dayOnly = { status: 'known', earliest_utc: '2025-01-02T00:00:00Z', latest_exclusive_utc: '2025-01-03T00:00:00Z',
        precision: 'day', source_timezone: 'UTC' };
      const initial = await publish(host, document('history-original', [
        row('known', '10', second('2025-01-02T08:00:00Z')), row('day-only', '20', dayOnly), row('unknown', '30'),
      ]));
      hold(fixture, initial, ['2025-01-05T09:00:00Z', '2025-01-05T10:00:00Z', '2025-01-06T09:00:00Z']);
      const initialRead = await host.call('/r1/products/read', { snapshotId: initial.snapshotId, productId: initial.productId });
      assert.deepEqual(values(initialRead), { known: '10', 'day-only': '20', unknown: '30' });
      const original = (initialRead.result.rows as WfdRecord[]).find(item => (item.record_ref as WfdRecord).logical_key === 'known')!;
      const corrected = await publish(host, document('history-correction', [row('known', '11', second('2025-01-10T08:00:00Z'))], initial.snapshotId,
        { mode: 'source_correction', definitionRef: initial.output.definition_ref as WfdRecord, previous: original.record_ref as WfdRecord }));
      hold(fixture, corrected, ['2025-01-15T09:00:00Z', '2025-01-15T10:00:00Z', '2025-01-16T09:00:00Z']);
      const current = await host.call('/r1/products/read', { snapshotId: corrected.snapshotId, productId: initial.productId });
      assert.equal(values(current).known, '11');
      const correctedRow = (current.result.rows as WfdRecord[]).find(item => (item.record_ref as WfdRecord).logical_key === 'known')!;
      const withdrawn = await publish(host, document('history-withdrawal', [row('known', '11', second('2025-01-10T08:00:00Z'))], corrected.snapshotId,
        { mode: 'withdrawal', definitionRef: corrected.output.definition_ref as WfdRecord, previous: correctedRow.record_ref as WfdRecord }));
      hold(fixture, withdrawn, ['2025-01-25T09:00:00Z', '2025-01-25T10:00:00Z', '2025-01-26T09:00:00Z']);
      const selection = { snapshotId: corrected.snapshotId, productId: initial.productId };
      const read = (historyMode: string, at: string, extra = {}) => host.call('/r1/products/read', { ...selection, historyMode, at, ...extra });
      const before = await read('market_known_at', '2025-01-01T00:00:00Z');
      assert.deepEqual(values(before), {});
      const intraday = await read('market_known_at', '2025-01-02T12:00:00Z');
      assert.deepEqual(values(intraday), { known: '10' }, 'Date-only public time is not invented as midnight');
      assert.ok(intraday.result.diagnostics.length > 0, 'Unknown or coarse times remain visible as diagnostics');
      const oldMarket = await read('market_known_at', '2025-01-08T12:00:00Z');
      assert.deepEqual(values(oldMarket), { known: '10', 'day-only': '20' });
      const newMarket = await read('market_known_at', '2025-01-12T12:00:00Z');
      assert.deepEqual(values(newMarket), { known: '11', 'day-only': '20' });
      assert.ok(newMarket.result.diagnostics.some((item: WfdRecord) => item.decision === 'indeterminate'),
        'Unknown public time is not upgraded by obtaining the file');
      const held = { heldScope: 'synthetic-history-instance', usableStage: 'published_readable' };
      const oldSystem = await read('system_held_at', '2025-01-12T12:00:00Z', held);
      assert.equal(values(oldSystem).known, '10', 'A public correction not yet held cannot replace the system version');
      const acquired = await read('system_held_at', '2025-01-15T12:00:00Z', { ...held, usableStage: 'acquired' });
      assert.equal(values(acquired).known, '11');
      const notReadable = await read('system_held_at', '2025-01-15T12:00:00Z', held);
      assert.equal(values(notReadable).known, '10', 'Acquisition is not publication/readability');
      const readable = await read('system_held_at', '2025-01-16T12:00:00Z', held);
      assert.equal(values(readable).known, '11');
      const withdrawnSelection = { ...selection, snapshotId: withdrawn.snapshotId };
      const uncertainWithdrawal = await host.call('/r1/products/read', { ...withdrawnSelection,
        historyMode: 'market_known_at', at: '2025-01-21T12:00:00Z' }, 409);
      assert.equal(uncertainWithdrawal.code, 'R1_READ_REVISION_TIME_UNSUPPORTED',
        'Unchanged predecessor public time must not be used as a withdrawal announcement time');
      assert.equal(values(await read('system_held_at', '2025-01-21T12:00:00Z', { ...held, snapshotId: withdrawn.snapshotId })).known, '11');
      assert.equal(values(await read('system_held_at', '2025-01-26T12:00:00Z', { ...held, snapshotId: withdrawn.snapshotId })).known, undefined);
      const currentSnapshot = await host.call('/r1/products/read', withdrawnSelection);
      assert.equal(values(currentSnapshot).known, undefined);
      assert.equal(values(currentSnapshot).unknown, '30', 'Snapshot content and historical eligibility are different');
      assert.deepEqual(values(await host.call('/r1/products/read', { snapshotId: initial.snapshotId, productId: initial.productId })), values(initialRead));
      const tasks = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      const requests = host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
      const head = (await host.services.r1Runtime!.client.snapshotStatus()).result.snapshot_id;
      await host.close(); host = await openFullChainHost(fixture);
      const reopened = await read('market_known_at', '2025-01-08T12:00:00Z');
      assert.deepEqual(reopened.result.rows, oldMarket.result.rows);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), tasks);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(), requests);
      assert.equal((await host.services.r1Runtime!.client.snapshotStatus()).result.snapshot_id, head);
    } finally {
      await host.close();
      if (originalTestMode === undefined) delete process.env.WFD_HOLDINGS_TEST_MODE;
      else process.env.WFD_HOLDINGS_TEST_MODE = originalTestMode;
    }
  });


test('actual history cursors stay bound to cutoff and snapshot across restart and later publications',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'r1-history-pages', machine: true });
    let host = await openFullChainHost(fixture);
    try {
      const published = await publish(host, document('history-pages', Array.from({ length: 101 }, (_, i) =>
        row('item-' + String(i).padStart(3, '0'), String(i + 1), second('2025-01-02T08:00:00Z')))));
      const request = { snapshotId: published.snapshotId, productId: published.productId,
        historyMode: 'market_known_at', at: '2025-01-03T00:00:00Z' };
      const first = await host.call('/r1/products/read', request);
      assert.equal(first.result.rows.length, 100);
      assert.equal(first.result.page.total_rows, 101);
      assert.equal(first.result.complete, false);
      const cursor = first.result.page.next_cursor as string;
      assert.ok(cursor);
      const changedCutoff = await host.call('/r1/products/read', { ...request, at: '2025-01-04T00:00:00Z', cursor }, 409);
      assert.equal(changedCutoff.code, 'CURSOR_QUERY_MISMATCH');
      const changedView = await host.call('/r1/products/read', { ...request, cursor, historyMode: 'system_held_at',
        heldScope: 'different-instance', usableStage: 'acquired' }, 409);
      assert.equal(changedView.code, 'CURSOR_QUERY_MISMATCH');
      await publish(host, document('later-head', [row('later', '200', second('2025-01-04T08:00:00Z'))], published.snapshotId));
      await host.close(); host = await openFullChainHost(fixture);
      const resumed = await host.call('/r1/products/read', { ...request, cursor });
      assert.equal(resumed.snapshotId, published.snapshotId);
      assert.equal(resumed.result.query_hash, first.result.query_hash);
      assert.equal(resumed.result.rows.length, 1);
      assert.equal(resumed.result.page.has_more, false);
      assert.equal(resumed.result.complete, true);
      const allKeys = [...Object.keys(values(first)), ...Object.keys(values(resumed))];
      assert.equal(allKeys.length, 101); assert.equal(new Set(allKeys).size, 101);
      assert.equal(allKeys.includes('later'), false, 'A later HEAD must not expand an already pinned cursor');
      for (const at of ['2025-02-30T00:00:00Z', '2025-01-03', '2025-01-03T00:00:00']) {
        const rejected = await host.call('/r1/products/read', { ...request, at }, 409);
        assert.equal(rejected.code, 'R1_READ_INPUT');
      }
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()?.n, 0,
        'Reading does not prepare or send a new publication');
    } finally { await host.close(); }
  });


test('actual algorithm fixed-input port preserves stage-specific evidence instead of inventing holding timestamps',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'algorithm-history-input', machine: true,
      units: { cny_per_share: { dimension: 'money_per_share' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const host = await openFullChainHost(fixture);
    const originalTestMode = process.env.WFD_HOLDINGS_TEST_MODE;
    process.env.WFD_HOLDINGS_TEST_MODE = '1';
    try {
      const doc = document('algorithm-history-source', [row('placeholder', '1')]);
      const output = (doc.outputs as WfdRecord[])[0]!;
      output.definition = { semantic_code: 'synthetic.history.daily', measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: namespace, time_role: 'observation',
        field_definitions: [['trade_date', 'text', 'date'], ['close', 'decimal', 'cny_per_share'], ['available_at', 'text', 'text']]
          .map(([field_code, data_type, unit_code]) => ({ field_code, data_type, unit_code,
            measurement_nature: field_code === 'close' ? 'stock' : 'relation', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC',
            roles: { observation: 'trade_date', availability: 'available_at', bar_closed: 'true' } },
          financial: { price_adjustment: { direction: 'raw' } } } };
      const publishedAt = '2025-01-03T08:00:00Z';
      output.payload = { kind: 'tabular_rows', rows: [1, 2].map(i => ({ business_key: 'day-' + i, subject,
        observation_time: { status: 'known', precision: 'day', source_timezone: 'UTC',
          earliest_utc: `2025-01-0${i}T00:00:00Z`, latest_exclusive_utc: `2025-01-0${i + 1}T00:00:00Z` },
        public_time: second(publishedAt), values: {
          trade_date: { data_type: 'text', value_state: 'valid_value', value: `2025-01-0${i}` },
          close: { data_type: 'decimal', value_state: 'valid_value', value: String(40 + i) },
          available_at: { data_type: 'text', value_state: 'valid_value', value: publishedAt },
        } })) };
      const identity = doc.request_identity as WfdRecord;
      identity.submission_digest = 'sha256:' + wfdSha256(canonicalWfdJson(output));
      const published = await publish(host, doc);
      hold(fixture, published, ['2025-01-05T09:00:00Z', '2025-01-05T10:00:00Z', '2025-01-06T09:00:00Z']);
      const runtime = host.services.r1Runtime!;
      const port = createWfdProductMachineSnapshotPort({ client: runtime.connection.client, instanceId: runtime.connection.connectionId });
      const reference: AlgorithmSnapshotReference = { kind: 'wfd_fixed_snapshot', instanceId: runtime.connection.connectionId,
        snapshotId: published.snapshotId, productId: published.productId,
        definitionRevision: String((published.output.definition_ref as WfdRecord).version),
        fields: ['trade_date', 'close', 'available_at'], fieldMapping: { timestamp: 'trade_date', close: 'close', available_at: 'available_at' },
        dateFormat: 'YYYY-MM-DD', calendar: { mode: 'dense' },
        semantics: { subject: 'synthetic_history_subject', frequency: '1d', timezone: 'UTC', priceUnit: 'currency_per_share',
          currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'WFD financial.price_adjustment.direction=raw',
          barClosed: true, synthetic: true, availability: { kind: 'column' } },
        perspective: 'market_known_at', at: '2025-01-04T12:00:00Z' };
      const signal = new AbortController().signal;
      const market = await port.read(reference, { signal });
      assert.equal(market.rows.length, 2);
      assert.equal(market.evidence?.[0]?.publicationTime?.earliestUtc, publishedAt);
      const heldReference: AlgorithmSnapshotReference = { ...reference, perspective: 'system_held_at',
        at: '2025-01-05T12:00:00Z', heldScope: 'synthetic-history-instance', usableStage: 'acquired' };
      const acquired = await port.read(heldReference, { signal });
      assert.equal(acquired.evidence?.[0]?.holdingTime?.receivedAtUtc, '2025-01-05T09:00:00Z');
      assert.equal(acquired.evidence?.[0]?.holdingTime?.usableStage, 'acquired');
      await assert.rejects(port.read({ ...heldReference, usableStage: 'published_readable' }, { signal }));
      const readable = await port.read({ ...heldReference, at: '2025-01-06T12:00:00Z', usableStage: 'published_readable' }, { signal });
      assert.deepEqual(readable.rows, acquired.rows);
      assert.equal(readable.evidence?.[0]?.holdingTime?.receivedAtUtc, '2025-01-06T09:00:00Z');
      assert.equal(readable.evidence?.[0]?.holdingTime?.usableStage, 'published_readable');
      const resolution = readable.resolution as WfdRecord;
      const envelope = (resolution.envelope as WfdRecord).rows as WfdRecord[];
      assert.equal(envelope[0]!.held_at, '2025-01-06T09:00:00Z');
      assert.equal(envelope[0]!.usable_stage, 'published_readable');
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()?.n, 0,
        'Input inspection must not automatically start calculation or publication');
    } finally {
      await host.close();
      if (originalTestMode === undefined) delete process.env.WFD_HOLDINGS_TEST_MODE;
      else process.env.WFD_HOLDINGS_TEST_MODE = originalTestMode;
    }
  });


test('actual HTTP/WFD withdrawal uses independent announcement time without rewriting predecessor or old snapshots',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'r1-withdrawal-time', machine: true });
    let host = await openFullChainHost(fixture);
    try {
      const originalRow = row('known', '10', second('2025-01-02T08:00:00Z'));
      const original = await publish(host, document('withdrawal-original', [originalRow]));
      const fixed = { snapshotId: original.snapshotId, productId: original.productId };
      const current = await host.call('/r1/products/read', fixed);
      const previous = (current.result.rows as WfdRecord[])[0]!.record_ref as WfdRecord;
      const withdrawal = { mode: 'withdrawal' as const, definitionRef: original.output.definition_ref as WfdRecord,
        previous, withdrawalPublicTime: { status: 'known', earliest_utc: '2025-01-20T00:00:00Z',
          latest_exclusive_utc: '2025-01-21T00:00:00Z', precision: 'day', source_timezone: 'UTC' } };
      const bad = await host.services.r1Runtime!.client.submit(document('withdrawal-changed-row',
        [row('known', '10', second('2025-01-20T08:00:00Z'))], original.snapshotId, withdrawal));
      assert.notEqual(bad.result.state, 'published_formal', 'New announcement must not authorize predecessor mutation');
      for (const [requestId, time] of [
        ['withdrawal-invalid-date', { ...second('2025-01-20T08:00:00Z'), earliest_utc: '2025-02-30T08:00:00Z' }],
        ['withdrawal-reversed', { ...second('2025-01-20T08:00:00Z'), latest_exclusive_utc: '2025-01-19T08:00:00Z' }],
      ] as const) {
        const invalid = await host.services.r1Runtime!.client.submit(document(requestId, [originalRow], original.snapshotId,
          { ...withdrawal, withdrawalPublicTime: time }));
        assert.notEqual(invalid.result.state, 'published_formal', requestId);
      }
      const withdrawn = await publish(host, document('withdrawal-explicit', [originalRow], original.snapshotId, withdrawal));
      const selection = { ...fixed, snapshotId: withdrawn.snapshotId, historyMode: 'market_known_at' };
      assert.equal(values(await host.call('/r1/products/read', { ...selection, at: '2025-01-10T12:00:00Z' })).known, '10');
      const imprecise = await host.call('/r1/products/read', { ...selection, at: '2025-01-20T12:00:00Z' }, 409);
      assert.equal(imprecise.code, 'R1_READ_REVISION_TIME_UNSUPPORTED');
      const after = await host.call('/r1/products/read', { ...selection, at: '2025-01-21T12:00:00Z' });
      assert.deepEqual(values(after), {});
      assert.ok(after.result.diagnostics.some((item: WfdRecord) => item.reason === 'WITHDRAWN_AT_PERSPECTIVE'
        && canonicalWfdJson(item.withdrawal_public_time) === canonicalWfdJson(withdrawal.withdrawalPublicTime)));
      assert.equal(values(await host.call('/r1/products/read', fixed)).known, '10');
      await host.close(); host = await openFullChainHost(fixture);
      assert.equal(values(await host.call('/r1/products/read', { ...selection, at: '2025-01-10T12:00:00Z' })).known, '10');
      assert.deepEqual(values(await host.call('/r1/products/read', { ...selection, at: '2025-01-21T12:00:00Z' })), {});
    } finally { await host.close(); }
  });


test('actual historical projection rejects future-added fields while preserving explicitly compatible historical fields',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'r1-history-metadata', machine: true });
    const host = await openFullChainHost(fixture);
    try {
      const first = await publish(host, document('metadata-original', [row('old', '10', second('2025-01-02T08:00:00Z'))]));
      const laterRow = row('new', '20', second('2025-02-02T08:00:00Z'));
      (laterRow.values as WfdRecord).extra = { data_type: 'decimal', value_state: 'valid_value', value: '30' };
      const later = document('metadata-additive', [laterRow], first.snapshotId);
      ((later.outputs as WfdRecord[])[0]!.definition as WfdRecord).field_definitions = [
        ...definition.field_definitions, { field_code: 'extra', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }];
      const secondPublication = await publish(host, later);
      assert.equal(secondPublication.productId, first.productId, 'Compatible additive definition retains product identity');
      const selected = { snapshotId: secondPublication.snapshotId, productId: first.productId,
        historyMode: 'market_known_at', at: '2025-01-10T12:00:00Z' };
      const old = await host.call('/r1/products/read', { ...selected, fields: ['amount'] });
      assert.equal(values(old).old, '10');
      assert.equal(JSON.stringify(old.result.product).includes('extra'), false,
        'Historical product envelope must not expose the future row contract');
      const mixed = await host.call('/r1/products/read', selected, 409);
      assert.equal(mixed.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      const explicitFuture = await host.call('/r1/products/read', { ...selected, fields: ['extra'] }, 409);
      assert.equal(explicitFuture.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      assert.equal(values(await host.call('/r1/products/read', { ...selected, snapshotId: first.snapshotId })).old, '10');
      const future = document('metadata-future-definition', [laterRow], secondPublication.snapshotId);
      const futureOutput = (future.outputs as WfdRecord[])[0]!;
      futureOutput.definition = structuredClone((later.outputs as WfdRecord[])[0]!.definition);
      futureOutput.definition_public_time = second('2025-04-01T00:00:00Z');
      (futureOutput.payload as WfdRecord).rows = [{ ...laterRow, business_key: 'future' }];
      const futurePublished = await publish(host, future);
      const refused = await host.call('/r1/products/read', { ...selected, snapshotId: futurePublished.snapshotId, fields: ['amount'] }, 409);
      assert.equal(refused.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      assert.equal(refused.result, undefined);
      assert.equal(values(await host.call('/r1/products/read', { ...selected, snapshotId: first.snapshotId })).old, '10');
    } finally { await host.close(); }
  });

// Independent definition evidence is synthetic and explicit, never inferred from the row.
for (const [name, time] of [
  ['missing', undefined],
  ['unknown', { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'UTC' }],
  ['future', second('2025-02-01T00:00:00Z')],
  ['coarse', { status: 'known', earliest_utc: '2025-01-10T00:00:00Z',
    latest_exclusive_utc: '2025-01-11T00:00:00Z', precision: 'day', source_timezone: 'UTC' }],
] as const) {
  test(`actual HTTP/WFD refuses ${name} definition history without leaking metadata or falling back`,
    { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
      const fixture = createFullChainFixture({ name: `r1-definition-${name}`, machine: true });
      let host = await openFullChainHost(fixture);
      const oldTestMode = process.env.WFD_HOLDINGS_TEST_MODE;
      process.env.WFD_HOLDINGS_TEST_MODE = '1';
      try {
        const doc = document(`definition-${name}`, [row('known', '10', second('2025-01-02T08:00:00Z'))]);
        const output = (doc.outputs as WfdRecord[])[0]!;
        if (time) output.definition_public_time = time;
        else delete output.definition_public_time;
        const published = await publish(host, doc);
        const selected = { snapshotId: published.snapshotId, productId: published.productId };
        assert.equal(values(await host.call('/r1/products/read', selected)).known, '10');
        const denied = await host.call('/r1/products/read', { ...selected,
          historyMode: 'market_known_at', at: '2025-01-10T12:00:00Z' }, 409);
        assert.equal(denied.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
        assert.equal(denied.result, undefined, 'Refusal must not attach future definition metadata');
        await assert.rejects(() => host.services.r1Runtime!.client.readProduct({
          protocol_version: 'wfd.read/1.3-product1', operation: 'read_product',
          dataset_id: 'synthetic_history', snapshot_id: published.snapshotId, product_id: published.productId,
          fields: ['not_a_declared_field'], history_mode: 'market_known_at',
          knowledge_cutoff: second('2025-01-10T12:00:00Z'), held_scope: null, usable_stage: null,
          subject: null, business_time_range: null, page_size: 10, max_nodes: 1000,
          max_scan_bytes: 8_000_000, cursor: null,
        }), (error: any) => error.remoteCode === 'HISTORY_DEFINITION_TIME_UNSUPPORTED'
          && !JSON.stringify(error).includes('available_fields'));

        hold(fixture, published, ['2025-01-05T09:00:00Z', '2025-01-05T10:00:00Z', '2025-01-06T09:00:00Z']);
        assert.equal(values(await host.call('/r1/products/read', { ...selected,
          historyMode: 'system_held_at', at: '2025-01-10T12:00:00Z',
          heldScope: 'synthetic-history-instance', usableStage: 'published_readable' })).known, '10');
        await host.close(); host = await openFullChainHost(fixture);
        assert.equal((await host.call('/r1/products/read', { ...selected,
          historyMode: 'market_known_at', at: '2025-01-10T12:00:00Z' }, 409)).code,
        'R1_READ_HISTORY_METADATA_UNSUPPORTED');
        if (name === 'future' || name === 'coarse') {
          assert.equal(values(await host.call('/r1/products/read', { ...selected,
            historyMode: 'market_known_at', at: '2025-03-01T12:00:00Z' })).known, '10');
        }
      } finally { await host.close(); if (oldTestMode === undefined) delete process.env.WFD_HOLDINGS_TEST_MODE;
        else process.env.WFD_HOLDINGS_TEST_MODE = oldTestMode; }
    });
}

test('actual WFD rejects invalid definition times and same-value retries cannot silently change time evidence',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'r1-definition-evidence', machine: true });
    const host = await openFullChainHost(fixture);
    try {
      const rows = [row('known', '10', second('2025-01-02T08:00:00Z'))];
      const first = await publish(host, document('definition-base', rows));
      for (const [name, time] of [
        ['invalid-date', { ...second('2025-01-02T08:00:00Z'), earliest_utc: '2025-02-30T08:00:00Z' }],
        ['reversed', { ...second('2025-01-02T08:00:00Z'), latest_exclusive_utc: '2025-01-01T08:00:00Z' }],
      ] as const) {
        const doc = document(name, [row(name, '20', second('2025-01-02T08:00:00Z'))], first.snapshotId);
        (doc.outputs as WfdRecord[])[0]!.definition_public_time = time;
        const rejected = await host.services.r1Runtime!.client.submit(doc);
        assert.equal(rejected.result.state, 'rejected');
        assert.ok(JSON.stringify(rejected.result).includes('DEFINITION_PUBLIC_TIME_INVALID'));
      }
      const retry = document('definition-same-value', rows, first.snapshotId);
      retry.duplicate_policy = 'skip_identical_append';
      (retry.outputs as WfdRecord[])[0]!.definition_public_time = second('2024-02-01T00:00:00Z');
      const rejected = await host.services.r1Runtime!.client.submit(retry);
      assert.notEqual(rejected.result.state, 'published_formal');
      assert.ok(JSON.stringify(rejected.result).includes('TIME_EVIDENCE_CHANGE_REQUIRES_EXPLICIT_REVISION'));
      assert.equal(values(await host.call('/r1/products/read', { snapshotId: first.snapshotId,
        productId: first.productId, historyMode: 'market_known_at', at: '2025-01-10T12:00:00Z' })).known, '10');
    } finally { await host.close(); }
  });

// Legitimate additive evolution and actual host receipt times, not synthetic holding facts.
test('actual HTTP held projection excludes later additive fields and rejects unsupported range overrides',
  { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'held-metadata-diagnostics', machine: true, units: { text: { dimension: 'text' }, count: { dimension: 'quantity' } } });
    const host = await openFullChainHost(fixture);
    try {
      const first = await publish(host, document('held-meta-old', [row('old', '10')]));
      const holding = (await host.call('/r1/products/snapshot', {})).holdingInstance;
      const history = { historyMode: 'system_held_at', heldScope: holding.instanceId, usableStage: 'published_readable' };
      const initial = await host.call('/r1/products/read', { snapshotId: first.snapshotId, productId: first.productId,
        fields: ['amount'], ...history, at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') });
      const at = initial.result.rows[0].held_at;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const next = document('held-meta-new', [row('new', '20')], first.snapshotId);
      const output = (next.outputs as WfdRecord[])[0]!;
      ((output.definition as WfdRecord).field_definitions as WfdRecord[]).push({ field_code: 'future_note',
        data_type: 'text', unit_code: 'text', measurement_nature: 'flow', time_role: 'event' });
      (((output.payload as WfdRecord).rows as WfdRecord[])[0]!.values as WfdRecord).future_note = {
        data_type: 'text', value_state: 'valid_value', value: 'later-only-note' };
      const secondPublished = await publish(host, next);
      assert.equal(secondPublished.productId, first.productId, 'additive evolution keeps the real product');
      const selected = { snapshotId: secondPublished.snapshotId, productId: first.productId, fields: ['amount'] };
      const fixed = (await host.services.r1Runtime!.client.fixedRead(secondPublished.snapshotId, first.productId)).result;
      const laterContract = (fixed.products as WfdRecord[]).find(item => JSON.stringify(item.declaration).includes('future_note'))!.contract_ref as WfdRecord;
      const historical = await host.call('/r1/products/read', { ...selected, ...history, at });
      assert.deepEqual(values(historical), { old: '10' });
      assert.ok(!JSON.stringify(historical).includes('future_note'));
      assert.ok(!JSON.stringify(historical).includes('later-only-note'));
      assert.ok(!JSON.stringify(historical).includes(String(laterContract.digest)), JSON.stringify(historical));
      const excluded = historical.result.diagnostics.filter((item: WfdRecord) => item.holding_state === 'not_yet_held');
      assert.equal(excluded.length, 1, 'Unqualified coverage remains visible rather than disappearing');
      assert.equal(excluded[0].scope, 'product');
      assert.equal(excluded[0].count, 1);
      assert.equal(excluded[0].count_basis, 'current_fixed_snapshot_not_subject_filtered_not_historical_known_total');
      for (const field of ['business_key', 'record_id', 'record_version', 'subject', 'object', 'relation_type',
        'observed_stage_at', 'contract_ref', 'definition_ref']) assert.equal(field in excluded[0], false, field);
      const laterVersion = String(((secondPublished.output.records as WfdRecord[])[0]!).record_version);
      assert.ok(!JSON.stringify(historical).includes(laterVersion));

      const denied = await host.call('/r1/products/read', { ...selected, ...history, at,
        businessTimeRange: { role: 'event', start: '2024-01-01', end: '2025-01-01', timezone: 'UTC' } }, 409);
      assert.equal(denied.code, 'R1_READ_INPUT');
      assert.ok(!JSON.stringify(denied).includes('future_note'));
      assert.ok(!JSON.stringify(denied).includes('contract_ref'));
      const snapshot = await host.call('/r1/products/read', selected);
      assert.deepEqual(values(snapshot), { old: '10', new: '20' });
    } finally { await host.close(); }
  });

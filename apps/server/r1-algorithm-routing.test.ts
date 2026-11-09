import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import type { R1AlgorithmClassification, R1AlgorithmSettings } from '../../modules/collection/r1-algorithm-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1BatchStartInput['source'] = { source_id: 'algorithm-routing-fixture', provider: 'isolated fixture',
  requested_url: 'file:///explicit-selected-observations', requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-10T00:00:00Z',
  usage_scope: 'isolated algorithm routing verification', authorization: { status: 'authorized', basis: 'explicit isolated originals and configured algorithm verification' } };
const headers = { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' };
function manifest(path: string, bytes: Buffer) { return { name: path.split('/').at(-1)!, relativePath: path, sha256: wfdSha256(bytes), byteLength: bytes.length }; }
async function settings(host: FullChainHost, value: R1AlgorithmSettings, status = 200): Promise<R1AlgorithmSettings> {
  const response = await fetch(host.base + '/r1/batches/algorithm-settings', { method: 'PUT', headers, body: JSON.stringify(value) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result as R1AlgorithmSettings;
}
async function classify(host: FullChainHost, bytes: Buffer): Promise<R1AlgorithmClassification> {
  const response = await fetch(host.base + '/r1/batches/classify', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result as R1AlgorithmClassification;
}
async function upload(host: FullChainHost, batchId: string, itemId: string, bytes: Buffer) {
  const response = await fetch(`${host.base}/r1/batches/${batchId}/items/${itemId}/upload`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  const result = await response.json(); assert.equal(response.status, 202, JSON.stringify(result));
}
async function until(host: FullChainHost, batchId: string, accept: (view: R1BatchView) => boolean): Promise<R1BatchView> {
  for (let tries = 0; tries < 2400; tries++) {
    const view = await host.call('/r1/batches/' + batchId) as R1BatchView;
    assert.equal(view.error, null, JSON.stringify(view)); if (accept(view)) return view; await delay(25);
  }
  assert.fail(JSON.stringify(await host.call('/r1/batches/' + batchId)));
}

test('persisted per-kind settings freeze on acceptance and forged bar classification cannot calculate a non-bar original', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'algorithm-nonbar-guard', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const initial = await host.call('/r1/batches/algorithm-settings') as unknown as R1AlgorithmSettings;
    assert.deepEqual(initial, { revision: 0, dailyPeriod: null, minutePeriod: null });
    const saved = await settings(host, { ...initial, dailyPeriod: 3 });
    assert.equal(saved.minutePeriod, null); await settings(host, { ...initial, dailyPeriod: 4 }, 409);
    const unknownMethod = await fetch(host.base + '/r1/batches/start', { method: 'PUT', headers, body: '{}' });
    assert.equal(unknownMethod.status, 405, 'Only the settings path permits PUT');
    const bytes = Buffer.from('business_key,start_utc,end_utc,value_state,reading,bd.semantic_code,bd.subject_kind,bd.subject_id,bd.frequency,bd.precision,bd.timezone,bd.period_type,bd.type.reading,bd.unit.reading,bd.measurement.reading\n'
      + 'r1,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z,valid_value,12.30,source.fixture,physical_object,item_1,day,day,UTC,natural,decimal,count,stock\n');
    const inspected = await classify(host, bytes); assert.equal(inspected.kind, 'other');
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM material_inputs').get()!.n, 0, 'Preflight does not store an original');
    const forged: R1AlgorithmClassification = { ...inspected, kind: 'daily_bar', dateColumn: 'start_utc', valueColumn: 'reading' };
    const input: R1BatchStartInput = { batchId: 'forged-bar', source, datasetId: 'observations', files: [manifest('report.csv', bytes)],
      algorithmRouting: { version: 'bd.r1-algorithm-routing/1', settings: saved, files: [forged] } };
    const start = await host.call('/r1/batches/start', input, 202) as R1BatchView;
    assert.equal(start.calculations.length, 1);
    const changed = await settings(host, { ...saved, dailyPeriod: 7 });
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual(await host.call('/r1/batches/algorithm-settings'), changed);
    const repeated = await host.call('/r1/batches/start', input, 202) as R1BatchView;
    assert.equal(repeated.duplicateBatch, true); assert.equal(repeated.algorithmRouting!.settings.dailyPeriod, 3);
    assert.equal((await host.call('/r1/batches/start', { ...input, batchId: 'new-stale-settings', datasetId: 'new_scope' }, 409)).code, 'R1_ALGORITHM_SETTINGS_CONFLICT');
    let reads = 0;
    const options = (host.services.r1Batches as unknown as { options: { readCalculationInput: (...args: unknown[]) => Promise<never> } }).options;
    options.readCalculationInput = async () => { reads++; throw new Error('A non-bar must never reach fixed calculation input reads'); };
    await upload(host, input.batchId, 'item-1', bytes);
    const result = await until(host, input.batchId, view => view.items[0]!.state === 'associated' && view.calculations[0]!.state === 'blocked');
    assert.equal(result.calculations[0]!.error!.code, 'R1_ALGORITHM_CONTENT_MISMATCH');
    assert.equal(result.items[0]!.algorithmInspection!.kind, 'other'); assert.equal(reads, 0);
    assert.equal(result.calculations[0]!.materialId, null); assert.equal(result.calculations[0]!.proof, null);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM material_inputs').get()!.n, 1);
    const oldRaw = await host.call('/r1/batches/start', { ...input, batchId: 'legacy-raw-only', algorithmRouting: undefined }, 202) as R1BatchView;
    assert.deepEqual(oldRaw.calculations, [], 'Old originals-only callers never gain calculation authorization from saved settings');
    await host.call('/r1/batches/start', { ...input, batchId: 'legacy-explicit-nonbar', algorithmRouting: undefined,
      calculation: { method: 'source_observation_ma', period: 3, valueColumn: 'reading' } }, 202);
    const legacy = await until(host, 'legacy-explicit-nonbar', view => view.calculation?.state === 'blocked');
    assert.equal(legacy.calculation!.error!.code, 'R1_ALGORITHM_CONTENT_MISMATCH'); assert.equal(reads, 0);
    writeFileSync(join(fixture.root, 'routing-proof.json'), JSON.stringify({ initial, saved, changed, start, result, oldRaw, legacy, nonBarCalculationReads: reads }, null, 2));
  } finally { await host.close(); }
});

test('one authorized mixed batch auto-calculates configured daily kinds and partitions actual source products', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'algorithm-product-groups', machine: true,
    units: { date: { dimension: 'date' }, srcunit_5YWD: { dimension: 'number' } } });
  const host = await openFullChainHost(fixture);
  try {
    const saved = await settings(host, { revision: 0, dailyPeriod: 2, minutePeriod: null });
    const originals = [Buffer.from('交易日期,股票代码,收盘价（元）\n20260101,000001,1.20\n20260102,000001,1.40\n20260103,000001,1.60\n'),
      Buffer.from('交易日期,股票代码,收盘价（元）\n20260101,000001,10.20\n20260102,000001,10.40\n20260103,000001,10.60\n'),
      Buffer.from('交易日期,股票代码,榜单类型,收盘价（元）\n20260101,000001,涨停池,1.20\n')];
    const inspected = await Promise.all(originals.map(bytes => classify(host, bytes)));
    assert.deepEqual(inspected.map(file => file.kind), ['daily_bar', 'daily_bar', 'mixed']);
    const input: R1BatchStartInput = { batchId: 'mixed-products', source, datasetId: 'observations', datePolicy: 'a_share_calendar_day_asia_shanghai',
      files: originals.map((bytes, index) => manifest(`series-${index + 1}/input.csv`, bytes)),
      algorithmRouting: { version: 'bd.r1-algorithm-routing/1', settings: saved, files: inspected } };
    await host.call('/r1/batches/start', input, 202);
    for (const [index, bytes] of originals.entries()) {
      await until(host, input.batchId, view => view.nextUploadItemId === `item-${index + 1}`);
      await upload(host, input.batchId, `item-${index + 1}`, bytes);
    }
    const result = await until(host, input.batchId, view => view.calculations.length === 2 && view.calculations.every(calculation => ['associated', 'blocked'].includes(calculation.state)));
    assert.deepEqual(result.calculations.map(calculation => calculation.state), ['associated', 'associated'], JSON.stringify(result));
    assert.ok(result.calculations.every(calculation => calculation.itemIds.length === 1 && !calculation.itemIds.includes('item-3')));
    const proofs = result.calculations.map(calculation => host.services.r1Batches!.calculationEvidence(input.batchId, calculation.calculationId)!);
    assert.deepEqual(proofs.map(proof => proof.counts), [0, 1].map(() => ({ rows: 3, groups: 1, valid: 2, warmup: 1, windowMissing: 0 })));
    assert.notEqual(proofs[0]!.sourceProductId, proofs[1]!.sourceProductId);
    assert.deepEqual(proofs.map(proof => proof.lineage.filter(row => row.status === 'valid').map(row => row.value)), [['1.30000000', '1.50000000'], ['10.30000000', '10.50000000']]);
    writeFileSync(join(fixture.root, 'routing-proof.json'), JSON.stringify({ saved, inspected, result, proofs }, null, 2));
  } finally { await host.close(); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { acceptSourcePage, beginSourceAcquisition, reviewSourceAcquisition, sourceRequestKey } from './source-acquisition.js';
import { inspectOfficialJsonPage, officialHttpDisposition, officialPageRequest, treasuryAdapterConfig,
  type OfficialPageSelection } from './official-public.js';
import { parseEndpointSource } from '../../modules/collection/endpoint-adapter.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Exact small response captured from HKMA on 2026-11-16; altered copies below are synthetic failures.
const hk1 = Buffer.from('{"header":{"success":true,"err_code":"0000","err_msg":"No error found"},"result":{"datasize":2,"records":[{"end_of_day":"2024-01-02","usd":7.814,"cny":1.0954,"eur":8.619},{"end_of_day":"2024-01-03","usd":7.814,"cny":1.09365,"eur":8.5625}]}}');
const hk2 = Buffer.from('{"header":{"success":true,"err_code":"0000","err_msg":"No error found"},"result":{"datasize":2,"records":[{"end_of_day":"2024-01-04","usd":7.808999999999999,"cny":1.0906,"eur":8.537},{"end_of_day":"2024-01-05","usd":7.811,"cny":1.0887,"eur":8.5355}]}}');
const hk: OfficialPageSelection = { provider: 'hkma', start: '2024-01-02', end: '2024-01-05', pageSize: 2, page: 1 };
const us: OfficialPageSelection = { provider: 'treasury', start: '2024-03-31', end: '2024-03-31', pageSize: 2, page: 1 };
const receipt = (selection: OfficialPageSelection, bytes: Buffer) => ({ fileRefId: 'isolated-original',
  sha256: hash(bytes), requestedUrl: officialPageRequest(selection).url });
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;

// Test-only fixture follows documented Fiscal Data shape. Not a claim of a live response.
const usFixture = (page: number) => ({ data: [
  { record_date: '2024-03-31', country_currency_desc: 'Fixture-' + page + '-A', exchange_rate: '71.2000', effective_date: '2024-03-31' },
  { record_date: '2024-03-31', country_currency_desc: 'Fixture-' + page + '-B', exchange_rate: '94.92', effective_date: '2024-03-31' },
], meta: { count: 2, 'total-count': 171, 'total-pages': 86 }, links: {
  self: '&page%5Bnumber%5D=' + page + '&page%5Bsize%5D=2',
  next: '&page%5Bnumber%5D=' + (page + 1) + '&page%5Bsize%5D=2',
} });

test('official requests use fixed documented endpoints, bounded dates and distinct semantics', () => {
  const h = officialPageRequest(hk), t = officialPageRequest(us);
  assert.equal(new URL(h.url).hostname, 'api.hkma.gov.hk');
  assert.equal(new URL(t.url).hostname, 'api.fiscaldata.treasury.gov');
  assert.notEqual(sourceRequestKey(h.request), sourceRequestKey(t.request), 'Different reporting meanings must not become the same product');
  assert.equal(h.request.operationId, 'official_fx_observations', 'Acquisition must not pretend FX is stock daily bars');
  assert.throws(() => officialPageRequest({ ...hk, start: '2024-02-30' }), code('OFFICIAL_RESPONSE_INVALID'));
  assert.throws(() => officialPageRequest({ ...hk, pageSize: 101 }), code('OFFICIAL_RESPONSE_INVALID'));
  assert.throws(() => officialPageRequest({ ...hk, provider: 'arbitrary-host' as never }), code('OFFICIAL_RESPONSE_INVALID'));
});

test('HKMA datasize is page length, not total; original numeric lexeme remains unchanged', () => {
  assert.equal(hash(hk1), '40c2b2d3cea9ac88537b784bebd827eb23389a989e6575b8da62c3554501a068');
  const p1 = inspectOfficialJsonPage(hk, hk1, receipt(hk, hk1));
  const next = { ...hk, page: 2 };
  const p2 = inspectOfficialJsonPage(next, hk2, receipt(next, hk2));
  let checkpoint = beginSourceAcquisition(p1.request, p1.binding, { maxPages: 2, maxRows: 4 });
  checkpoint = acceptSourcePage(checkpoint, p1.request, p1.binding, p1.page);
  assert.equal(reviewSourceAcquisition(checkpoint).continuation.cursor, '2');
  assert.deepEqual(acceptSourcePage(checkpoint, p1.request, p1.binding, p1.page), checkpoint);
  checkpoint = acceptSourcePage(JSON.parse(JSON.stringify(checkpoint)), p2.request, p2.binding, p2.page);
  const result = reviewSourceAcquisition(checkpoint);
  assert.equal(result.rowCount, 4);
  assert.equal(result.coverage.state, 'not_established');
  assert.equal(result.continuation.state, 'budget_exhausted');
  assert.equal(result.publication, 'not_requested');
  assert.equal(p2.reportedTotal, null);
  assert.ok(hk2.toString().includes('7.808999999999999'), 'Do not round the captured original');
});

test('Treasury links give bounded next-page identity and partial metadata, not full coverage', () => {
  const bytes = Buffer.from(JSON.stringify(usFixture(1)));
  const parsed = inspectOfficialJsonPage(us, bytes, receipt(us, bytes));
  assert.equal(parsed.reportedTotal, 171);
  assert.equal(parsed.page.nextCursor, '2');
  assert.equal(parsed.page.rowCount, 2);
  assert.equal(parsed.page.keys[0], JSON.stringify(['2024-03-31', 'Fixture-1-A', '2024-03-31']));
  const table = parseEndpointSource(bytes, treasuryAdapterConfig());
  const value = table.rows[0]![table.columns.indexOf('exchange_rate')]!;
  assert.equal(value.original, '71.2000');
  assert.equal(value.value, '71.2000');
  assert.equal(table.seriesComplete, null, 'Current page is not all 86 upstream pages');
});

test('wrong raw digest, altered query, missing fields and untrusted links fail closed', () => {
  assert.throws(() => inspectOfficialJsonPage(hk, hk1, { ...receipt(hk, hk1), sha256: '0'.repeat(64) }), code('OFFICIAL_RESPONSE_INVALID'));
  assert.throws(() => inspectOfficialJsonPage(hk, hk1, { ...receipt(hk, hk1), requestedUrl: 'https://evil.example/data' }), code('OFFICIAL_RESPONSE_INVALID'));
  const malicious = usFixture(1); malicious.links.next = 'https://example.test/steal';
  const bad = Buffer.from(JSON.stringify(malicious));
  assert.throws(() => inspectOfficialJsonPage(us, bad, receipt(us, bad)), code('OFFICIAL_RESPONSE_INVALID'));
  const missing = usFixture(1); delete (missing.data[0] as Record<string, unknown>).effective_date;
  const noDate = Buffer.from(JSON.stringify(missing));
  assert.throws(() => inspectOfficialJsonPage(us, noDate, receipt(us, noDate)), code('ADAPTER_FIELD_MISSING'));
});

test('HKMA empty page remains unknown; only explicit Treasury terminal links end pagination', () => {
  const emptyHk = Buffer.from('{"header":{"success":true,"err_code":"0000"},"result":{"datasize":0,"records":[]}}');
  const inspected = inspectOfficialJsonPage(hk, emptyHk, receipt(hk, emptyHk));
  assert.equal(inspected.page.nextCursor, undefined);
  const saved = acceptSourcePage(beginSourceAcquisition(inspected.request, inspected.binding, { maxPages: 2, maxRows: 4 }),
    inspected.request, inspected.binding, inspected.page);
  assert.equal(reviewSourceAcquisition(saved).outcome, 'undetermined');
  const emptyUs = Buffer.from(JSON.stringify({ data: [], meta: { count: 0, 'total-count': 0, 'total-pages': 0 },
    links: { self: '&page%5Bnumber%5D=1&page%5Bsize%5D=2', next: null } }));
  const treasury = inspectOfficialJsonPage(us, emptyUs, receipt(us, emptyUs));
  assert.equal(treasury.page.nextCursor, null);
});

test('HTTP failure categories never turn 502 or permission failures into empty datasets', () => {
  assert.equal(officialHttpDisposition(502).outcome, 'failed');
  assert.equal(officialHttpDisposition(403).outcome, 'no_permission');
  assert.equal(officialHttpDisposition(429).outcome, 'not_ready');
  assert.equal(officialHttpDisposition(502).automaticRetry, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
const python = process.env.WFD_PYTHON;
const enabled = !!python && !!process.env.XUAN_FULL_CHAIN_ROOT;
const namespace = 'full.chain.test';
const subject = { kind: 'entity', namespace, id: 'synthetic_coverage_subject' };
const period: WfdRecord = { status: 'known', earliest_utc: '2024-01-01T00:00:00Z',
  latest_exclusive_utc: '2025-01-01T00:00:00Z', precision: 'day', source_timezone: 'UTC' };
const definition = { semantic_code: 'synthetic.coverage.amount', measurement_nature: 'flow', unit_code: 'per_field',
  definition_authority: namespace, time_role: 'observation',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
    time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
  field_definitions: [{ field_code: 'amount', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }] };
function row(key: string, value: string, publicTime?: WfdRecord): WfdRecord {
  return { business_key: key, subject, observation_time: period,
    ...(publicTime ? { public_time: publicTime } : {}),
    values: { amount: { data_type: 'decimal', value_state: 'valid_value', value } } };
}
function document(requestId: string, rows: WfdRecord[]) {
  return buildStructuredIngestDocument({ requestId, datasetId: 'synthetic_coverage', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ requestId, rows })),
    expectedParentSnapshotId: null, outputKey: 'coverage', subject, definition, inputMode: 'partial_observation',
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
async function publish(host: FullChainHost, doc: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(doc)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  assert.equal(result.formal_publication_verified, true);
  const output = (result.output_results as WfdRecord[])[0]!;
  return { snapshotId: String(result.snapshot_id), productId: String(output.product_id), output };
}

test('actual HTTP/WFD coverage reads all pages, reports requested missing keys only, and survives reopen',
 { skip: !enabled ? 'Requires isolated WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-coverage', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const published = await publish(host, document('coverage-original', Array.from({ length: 105 }, (_, i) => row('key-' + i, String(i)))));
    const selection = { snapshotId: published.snapshotId, productId: published.productId, businessKeys: ['key-0', 'key-104', 'not-collected'] };
    const result = await host.call('/r1/products/coverage', selection);
    assert.deepEqual(result.keys.map((item: WfdRecord) => item.status), ['observed', 'observed', 'not_observed']);
    assert.equal(result.scan.complete, true); assert.equal(result.scan.pages, 2); assert.equal(result.scan.scannedRows, 105);
    assert.equal(result.calendarQualification, 'not_asserted');
    assert.equal(result.basis, 'caller_explicit_business_keys');
    assert.ok(result.keys.every((item: WfdRecord) => item.recordRef === null ||
      JSON.stringify(Object.keys(item.recordRef as WfdRecord).sort()) === JSON.stringify(['logical_key', 'product_id', 'revision_id', 'snapshot_id'])));
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual(await host.call('/r1/products/coverage', selection), result);
  } finally { await host.close(); }
});

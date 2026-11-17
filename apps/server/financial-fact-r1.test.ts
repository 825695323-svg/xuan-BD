import assert from 'node:assert/strict';
import test from 'node:test';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { financialFactIdentity } from '../../modules/collection/data-processing/financial-fact.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_company' };
const source = { source_id: 'synthetic-financial-fact', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/facts.json',
  requested_at_utc: '2026-07-05T00:00:00Z', acquired_at_utc: '2026-07-05T00:01:00Z', usage_scope: 'Synthetic financial correction regression',
  authorization: { status: 'authorized', basis: 'Explicit synthetic isolated fixture' } };
function row(value: string, version: string): WfdRecord {
  const raw = { subject_scheme: 'test', subject_code: 'issuer', accounting_standard: 'CAS', currency: 'CNY', statement: 'income', scope: 'consolidated',
    section: 'revenue', concept: '营业收入', dimension: 'current', period_type: 'duration', start_date: '2024-01-01', end_date: '2024-03-31', unit: 'cny',
    report_id: 'synthetic-report', report_version: version, audit_status: 'unaudited', value };
  const fact = financialFactIdentity(raw, { version: 'bd-financial-fact/1', seriesId: 'synthetic-series', periodBasis: 'synthetic-exact-quarter',
    basis: 'Explicit synthetic same-fact edition relation', assertion: 'same_fact_across_report_editions' });
  return { ...raw, financial_fact_identity: fact.identity, business_key: fact.businessKey, state: 'valid_value', start: '2024-01-01T00:00:00Z', end: '2024-04-01T00:00:00Z' };
}
async function prepare(host: FullChainHost, requestId: string, raw: WfdRecord, parent: string | null, correction?: { previous: WfdRecord; definitionRef: WfdRecord; definition: WfdRecord }) {
  const fields = Object.keys(raw).filter(key => !['business_key', 'state', 'start', 'end'].includes(key));
  const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC',
    fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' })) };
  const definition = { semantic_code: 'synthetic.financial.fact', measurement_nature: 'mixed_observation', unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              identity: { identity_resolution_rule: 'explicit_selected_financial_fact_axes' },
              coverage_quality: { completeness: 'partial', absence_means: 'unknown' }, time: { period_type: 'natural', frequency: 'source_reported_calendar_period', interval: 'half_open', timezone: 'UTC' } },
    field_definitions: fields.map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text', unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'flow', time_role: 'observation' })) };
  const target = { datasetId: 'synthetic_financial_facts', outputKey: 'financial.fact', expectedParentSnapshotId: parent, subject,
    definition: correction?.definition ?? definition, inputMode: correction ? 'source_correction' : 'partial_observation',
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    ...(correction ? { definitionMode: 'reuse', definitionRef: correction.definitionRef,
      revisions: { [String(raw.business_key)]: { previous: correction.previous, reason: 'Synthetic explicit fact correction' } } } : {}) };
  const upload = await host.upload(requestId + '.json', 'data', Buffer.from(JSON.stringify([raw])), requestId + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic event ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Explicit synthetic declared event nature and dates, not inferred from the calendar.' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'fact', materialIds: [materialId], intendedAction: 'publish',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json' }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, true, JSON.stringify(host.services.processing!.get(planId).outputs[0]));
  return { requestId, planId, outputId: 'fact', source, target, mapping };
}
async function publish(host: FullChainHost, input: Awaited<ReturnType<typeof prepare>>) {
  const prepared = await host.call('/r1/prepare', input, 201);
  const accepted = await host.call(`/r1/requests/${input.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  const done = await host.settled(accepted.jobId, 180000);
  const view = await host.call(`/r1/requests/${input.requestId}`);
  assert.equal(done.status, 'succeeded', JSON.stringify({error:done.error,view})); assert.equal(view.state, 'associated', JSON.stringify(view));
  return view.local.associations[0];
}
test('financial source correction verifies full actual identity and exact predecessor with WFD CAS',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-fact-r1', machine: true, units: { text: { dimension: 'text' }, cny: { dimension: 'money' } } });
    let host = await openFullChainHost(fixture);
    try {
      const initial = await publish(host, await prepare(host, 'original', row('10', 'v1'), null));
      const holding = (await host.call('/r1/products/snapshot', {})).holdingInstance;
      assert.equal(holding.bindingSource, 'target_instance');
      const heldRequest = { historyMode: 'system_held_at', heldScope: holding.instanceId, usableStage: 'published_readable' };
      const heldOriginal = await host.call('/r1/products/read', { snapshotId: initial.snapshot_id, productId: initial.product_id,
        ...heldRequest, at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') });
      const originalHeldAt = heldOriginal.result.rows[0].held_at;
      assert.equal(heldOriginal.result.rows[0].values.value.value, '10');
      const fixed = (await host.services.r1Runtime!.client.fixedRead(initial.snapshot_id, initial.product_id)).result;
      const product = (fixed.products as WfdRecord[])[0]!, prior = (fixed.rows as WfdRecord[])[0]!;
      const correction = { previous: prior.record_ref as WfdRecord, definitionRef: product.definition_ref as WfdRecord, definition: product.declaration as WfdRecord };
      for (const [field, value] of [['unit', 'usd'], ['scope', 'parent_only'], ['end_date', '2024-06-30'], ['concept', 'different'], ['financial_fact_identity', '{}']]) {
        const wrong = { ...row('12', 'v2'), [field!]: value };
        const rejected = await host.call('/r1/prepare', await prepare(host, 'wrong-' + field, wrong, initial.snapshot_id, correction), 409);
        assert.equal(rejected.code, 'FINANCIAL_FACT_IDENTITY');
        assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, initial.snapshot_id);
      }
      for (const [name, change] of [['definition', 'semantic_code'], ['reference', 'digest']] as const) {
        const bad = structuredClone(correction);
        if (name === 'definition') bad.definition[change] = 'forged'; else bad.definitionRef[change] = 'sha256:' + '0'.repeat(64);
        const rejected = await host.call('/r1/prepare', await prepare(host, 'wrong-' + name, row('12', 'v2'), initial.snapshot_id, bad), 409);
        assert.equal(rejected.code, 'R1_CORRECTION_DEFINITION');
      }
      const forgedInput = await prepare(host, 'forged-record-ref-product', row('12', 'v2'), initial.snapshot_id, correction);
      const client = host.services.r1Runtime!.client, actualRead = client.fixedRead.bind(client);
      client.fixedRead = async (...args: Parameters<typeof client.fixedRead>) => {
        const reply = structuredClone(await actualRead(...args));
        const first = (reply.result.rows as WfdRecord[])[0]!;
        (first.record_ref as WfdRecord).product_id = 'forged-product-in-reference';
        return reply;
      };
      try { assert.equal((await host.call('/r1/prepare', forgedInput, 409)).code, 'R1_CORRECTION_PREDECESSOR'); }
      finally { client.fixedRead = actualRead; }
      const delayed = await host.call('/r1/prepare', await prepare(host, 'delayed', row('11', 'v2'), initial.snapshot_id, correction), 201);
      const revised = await publish(host, await prepare(host, 'revised', row('12', 'v2'), initial.snapshot_id, correction));
      const late = await host.call('/r1/requests/delayed/submit', { confirmationDigest: delayed.documentSha256 }, 202);
      assert.equal((await host.settled(late.jobId)).status, 'failed');
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, revised.snapshot_id);
      const stale = await host.call('/r1/prepare', await prepare(host, 'stale', row('13', 'v3'), revised.snapshot_id, correction), 409);
      assert.equal(stale.code, 'R1_CORRECTION_PREDECESSOR');
      const latest = await host.call('/r1/products/read', { snapshotId: revised.snapshot_id, productId: revised.product_id });
      assert.equal(latest.result.rows.length, 1); assert.equal(latest.result.rows[0].values.value.value, '12');
      const atOriginalHolding = await host.call('/r1/products/read', { snapshotId: revised.snapshot_id, productId: revised.product_id,
        ...heldRequest, at: originalHeldAt });
      assert.equal(atOriginalHolding.result.rows[0].values.value.value, '10', 'Later correction must not replace the earlier actual holding');
      assert.equal(atOriginalHolding.result.rows[0].held_at, originalHeldAt);
      const old = await host.call('/r1/products/read', { snapshotId: initial.snapshot_id, productId: initial.product_id });
      assert.equal(old.result.rows[0].values.value.value, '10');
      assert.equal(latest.result.rows[0].record_ref.logical_key, old.result.rows[0].record_ref.logical_key);
      assert.notEqual(latest.result.rows[0].record_ref.revision_id, old.result.rows[0].record_ref.revision_id);
      await host.close(); host = await openFullChainHost(fixture);
      assert.equal((await host.call('/r1/products/snapshot', {})).holdingInstance.instanceId, holding.instanceId);
      assert.deepEqual((await host.call('/r1/products/read', { snapshotId: revised.snapshot_id, productId: revised.product_id, ...heldRequest, at: originalHeldAt })).result.rows, atOriginalHolding.result.rows);
      assert.deepEqual((await host.call('/r1/products/read', { snapshotId: initial.snapshot_id, productId: initial.product_id })).result.rows, old.result.rows);
    } finally { await host.close(); }
  });

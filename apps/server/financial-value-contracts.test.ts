import assert from 'node:assert/strict';
import test from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import type { R1PrepareInput, R1RequestView, R1ScalarMapping } from '../../contracts/r1-contracts.js';

const isolated = !!process.env.XUAN_FULL_CHAIN_ROOT;
const numericFormat = { decimal: '.', grouping: ',', negative: 'minus_or_parentheses', plus: false,
  percent: 'reject', precision: { precision: 18, scale: 2, rounding: 'reject' } };

async function upload(host: FullChainHost, id: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const accepted = await host.upload(id + '.json', 'data', bytes, id + '-upload');
  const received = await host.settled(accepted.jobId);
  assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
  return { materialId: host.services.materials!.getByTask(received.id)!.envelope.materialId, bytes };
}
async function step(host: FullChainHost, planId: string, kind: string, id: string) {
  const selected = host.services.processing!.get(planId).steps.find(item => item.kind === kind)!;
  assert.ok(selected, kind);
  const accepted = await host.call(`/processing/plans/${planId}/steps/${selected.stepId}/execute`, { requestId: id }, 202);
  const result = await host.settled(accepted.jobId);
  return { result, saved: host.services.processing!.get(planId).steps.find(item => item.stepId === selected.stepId)! };
}

test('HTTP selected modules retain exact amount, zero and null; precision failures stop before check',
  { skip: !isolated ? 'Requires isolated XUAN_FULL_CHAIN_ROOT.' : false, timeout: 60000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-contract-http' });
    const host = await openFullChainHost(fixture);
    try {
      for (const invalid of [false, true]) {
        const id = invalid ? 'scale-error' : 'exact-money';
        const original = invalid ? '1.231' : '9,007,199,254,740,993.1500';
        const { materialId, bytes } = await upload(host, id, [
          { id: '001', amount: original }, { id: '002', amount: '0' }, { id: '003', amount: null }]);
        const accepted = await host.call('/processing/plans', { requestId: id + '-plan', input: {
          routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'amounts', materialIds: [materialId], intendedAction: 'inspect',
            stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json',
              types: { amount: 'decimal_string' }, numericFormats: { amount: numericFormat } }] }],
        } }, 202);
        const prepared = await host.settled(accepted.jobId);
        assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared.error));
        const planId = host.services.processing!.getByTask(prepared.id)!.plan!.planId;
        const parsed = await step(host, planId, 'parse', id + '-parse');
        assert.equal(parsed.result.status, 'succeeded');
        const structure = await step(host, planId, 'structure', id + '-structure');
        if (invalid) {
          assert.equal(structure.result.status, 'failed', JSON.stringify(structure.result));
          assert.equal(structure.result.error?.code, 'CANDIDATE_DECIMAL_SCALE');
          const stopped = host.services.processing!.get(planId);
          assert.notEqual(stopped.steps.find(item => item.kind === 'check')!.state, 'succeeded');
          assert.equal(stopped.outputs[0]!.publishEligible, false);
          assert.throws(() => host.services.processing!.outputArtifact(planId, 'amounts'));
        } else {
          assert.equal(structure.result.status, 'succeeded', JSON.stringify(structure.result.error));
          const checked = await step(host, planId, 'check', id + '-check');
          assert.equal(checked.result.status, 'succeeded', JSON.stringify(checked.result.error));
          const result = JSON.parse(host.services.processing!.outputArtifact(planId, 'amounts').bytes.toString());
          assert.deepEqual(result.rows, [{ id: '001', amount: '9007199254740993.15' }, { id: '002', amount: '0' }, { id: '003', amount: null }]);
          assert.deepEqual(host.services.processing!.get(planId).steps.map(item => item.kind), ['parse', 'structure', 'check']);
        }
        const raw = JSON.parse(host.services.processing!.artifact(planId, parsed.saved.stepId).bytes.toString());
        assert.equal(raw.rows[0][1].original, original);
        assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, bytes);
      }
      assert.equal(host.services.r1Workspace!.list().length, 0, 'Inspection or rejected data does not publish automatically');
    } finally { await host.close(); }
  });

test('declared precision crosses actual BD processing, R1 publication and fixed WFD readback',
  { skip: !isolated || !process.env.WFD_PYTHON ? 'Requires isolated root and explicit real WFD_PYTHON.' : false,
    timeout: 120000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-contract-wfd', machine: true,
      units: { CNY: { dimension: 'number' } } });
    const host = await openFullChainHost(fixture);
    try {
      const requestId = 'exact-decimal-publication';
      const { materialId } = await upload(host, requestId, [
        { business_key: 'amount-1', value_decimal: '9,007,199,254,740,993.1500', start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-02T00:00:00Z' },
        { business_key: 'amount-2', value_decimal: '0.00', start_utc: '2026-01-02T00:00:00Z', end_utc: '2026-01-03T00:00:00Z' },
      ]);
      const draft: R1PrepareInput & { mapping: R1ScalarMapping } = {
        requestId, planId: 'pending-plan', outputId: 'amounts',
        source: { source_id: 'synthetic-financial-contract', provider: 'explicit-isolated-fixture',
          requested_url: 'https://example.test/financial-contract.json', requested_at_utc: '2026-01-04T00:00:00Z',
          acquired_at_utc: '2026-01-04T00:01:00Z', license: 'synthetic-test', usage_scope: 'isolated-test',
          authorization: { status: 'authorized', basis: 'Synthetic data generated for isolated BD/WFD numeric regression only.' } },
        mapping: { businessKey: 'business_key', value: 'value_decimal', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC' },
        target: { datasetId: 'financial_contract_test', outputKey: 'synthetic.amount', expectedParentSnapshotId: null,
          subject: { kind: 'physical_object', namespace: 'full.chain.test', id: 'synthetic_amount_object' },
          definition: { semantic_code: 'synthetic.amount', measurement_nature: 'flow', unit_code: 'CNY',
            definition_authority: 'full.chain.test', time_role: 'observation',
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
              time: { period_type: 'natural', frequency: 'day', interval: 'closed' },
              statistical: { price_basis: 'nominal', period_aggregation: 'period' } } },
          inputMode: 'partial_observation', coverage: { scope: { sample_only: true }, basis: 'observed_partial',
            completeness: 'partial', absence_means: 'unknown' } },
      };
      const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: 'isolated ' + key,
        evidence: [{ source: 'operator', field: 'routing.materials.0.dimensions.' + key, quote: 'isolated ' + key }] }]));
      const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
        routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
        outputs: [{ outputId: 'amounts', materialIds: [materialId], intendedAction: 'publish',
          stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json',
            types: { value_decimal: 'decimal_string' }, numericFormats: { value_decimal: numericFormat } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping }, expectedSnapshotId: null } }],
      } }, 202);
      const preparedPlan = await host.settled(accepted.jobId);
      assert.equal(preparedPlan.status, 'succeeded', JSON.stringify(preparedPlan.error));
      const planId = host.services.processing!.getByTask(preparedPlan.id)!.plan!.planId;
      for (const kind of ['parse', 'structure', 'check']) {
        const executed = await step(host, planId, kind, requestId + '-' + kind);
        assert.equal(executed.result.status, 'succeeded', JSON.stringify(executed.result.error));
        assert.equal(executed.saved.state, 'succeeded');
      }
      assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, true);
      const prepared: R1RequestView = await host.call('/r1/prepare', { ...draft, planId }, 201);
      const submission = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      const submitted = await host.settled(submission.jobId);
      assert.equal(submitted.status, 'succeeded', JSON.stringify(submitted.error));
      const published: R1RequestView = await host.call('/r1/requests/' + requestId);
      assert.equal(published.state, 'associated', JSON.stringify(published.error));
      assert.equal(published.rowCount, 2);
      const association = (published.local.associations as { snapshot_id: string; product_id: string }[])[0]!;
      const read = await host.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id });
      assert.equal(read.snapshotId, association.snapshot_id);
      assert.equal(read.productId, association.product_id);
      const values = read.result.rows.flatMap((row: { values: Record<string, { value: unknown }> }) =>
        Object.values(row.values).map(cell => cell.value));
      assert.ok(values.includes('9007199254740993.15'), JSON.stringify(read.result.rows));
      assert.ok(values.includes('0'), JSON.stringify(read.result.rows));
      assert.equal(values.some((value: unknown) => typeof value === 'number'), false,
        'Published financial decimal values must not be silently converted to binary float');
    } finally { await host.close(); }
  });

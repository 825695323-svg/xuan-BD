import assert from 'node:assert/strict';
import test from 'node:test';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { R1_CONTRACT_ROLES } from '../../modules/collection/r1-tabular.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';

const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_set_subject' };
const source = { source_id: 'synthetic-mixed-set', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/mixed.json',
  requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:00Z', usage_scope: 'Synthetic relation/tabular mixed publication regression',
  authorization: { status: 'authorized', basis: 'Explicit synthetic isolated fixture, not production relationship authority' } };
const fields = [{ fieldCode: 'label', value: 'label', state: 'state' }];
async function build(host: FullChainHost) {
  const outputs = [];
  for (const outputId of ['a_table', 'z_relation']) {
    const relation = outputId === 'z_relation';
    const rows = [{ key: outputId, label: 'Synthetic ' + outputId, state: 'valid_value', start: '2026-06-01T00:00:00Z', end: '2026-06-02T00:00:00Z',
      relation: 'declared_membership', object_kind: 'entity', object_namespace: 'full.chain.test', object_id: 'synthetic_group' }];
    const upload = await host.upload(outputId + '.json', 'data', Buffer.from(JSON.stringify(rows)), 'mixed-upload-' + outputId);
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const mapping = relation ? { kind: 'relation_edges', businessKey: 'key', relationType: 'relation', object: { kind: 'object_kind', namespace: 'object_namespace', id: 'object_id' },
      effectivePeriod: { status: 'known', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC' }, publicTime: { status: 'unknown', sourceTimezone: 'UTC' }, fields }
      : { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC', fields };
    const target = { datasetId: 'synthetic_relation_set', outputKey: outputId, expectedParentSnapshotId: null, subject, inputMode: 'partial_observation',
      coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'synthetic.mixed.' + outputId, definition_authority: 'full.chain.test',
        measurement_nature: relation ? 'relation' : 'mixed_observation', unit_code: relation ? 'not_applicable' : 'per_field', time_role: relation ? 'validity' : 'observation',
        field_definitions: [{ field_code: 'label', data_type: 'text', unit_code: 'text', measurement_nature: relation ? 'relation' : 'event', time_role: relation ? 'validity' : 'observation' }],
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
          ...(relation ? {} : { time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } }) } } };
    outputs.push({ outputId, materialId, target, mapping });
  }
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic mixed set ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Synthetic explicit table and relationship claims, not inferred facts' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: 'mixed-plan', input: {
    consistencyGroups: { pair: outputs.map(output => output.outputId) },
    routing: { materials: outputs.map(output => ({ materialId: output.materialId, dimensions, intendedAction: 'publish' })) },
    outputs: outputs.map(output => ({ outputId: output.outputId, materialIds: [output.materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'check'],
      tables: [{ materialId: output.materialId, format: 'json' }], target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target: output.target, mapping: output.mapping }, expectedSnapshotId: null } })) } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const output of outputs) for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.outputId === output.outputId && step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: output.outputId + '-' + kind }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  return host.call('/r1/prepare', { kind: 'publication_set', requestId: 'mixed-publication', planId, setId: 'pair' }, 201);
}
for (const fault of ['missing', 'mismatched'] as const) test(`mixed set verifies second relation member contracts; ${fault} readback cannot partially associate`,
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-set-' + fault, machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const prepared = await build(host);
      assert.deepEqual(prepared.publicationSet.members.map((m: any) => m.outputId), ['a_table', 'z_relation']);
      const client = host.services.r1Runtime!.client, nativeRead = client.fixedRead.bind(client), nativeSubmit = client.submit.bind(client);
      let tampered = 0, submits = 0;
      client.submit = async (...args) => { submits++; return nativeSubmit(...args); };
      client.fixedRead = async (...args) => {
        const response = await nativeRead(...args), result = structuredClone(response.result);
        const products = result.products as WfdRecord[];
        for (const product of products ?? []) if (product.payload_kind === 'relation_edges') {
          tampered++;
          if (fault === 'missing') delete product.contract_refs;
          else (product.contract_refs as Record<string, WfdRecord>).semantic!.digest = 'sha256:' + '0'.repeat(64);
        }
        return { ...response, result };
      };
      const submit = await host.call('/r1/requests/mixed-publication/submit', { confirmationDigest: prepared.documentSha256 }, 202);
      const blocked = await host.settled(submit.jobId, 180000);
      assert.equal(blocked.status, 'needs_review', JSON.stringify(blocked.error)); assert.ok(tampered > 0);
      const pending = await host.call('/r1/requests/mixed-publication');
      assert.notEqual(pending.state, 'associated'); assert.equal(pending.local.associations.length, 0, 'No first-member association may escape a failed second-member readback.');
      client.fixedRead = nativeRead;
      client.submit = async () => { throw new Error('Recovery must not resubmit accepted mixed outputs'); };
      const recovery = await host.call('/r1/requests/mixed-publication/recover', { lookupId: 'mixed-recovery-' + fault }, 202);
      const recovered = await host.settled(recovery.jobId, 180000); assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error));
      const view = await host.call('/r1/requests/mixed-publication'); assert.equal(view.state, 'associated');
      assert.equal(view.local.associations.length, 2); assert.equal(submits, 1);
      const snapshots = new Set(view.local.associations.map((a: any) => a.snapshot_id)); assert.equal(snapshots.size, 1);
      const fixed: unknown[] = [];
      for (const association of view.local.associations) {
        const result = (await nativeRead(association.snapshot_id, association.product_id)).result as any;
        const product = result.products.find((p: any) => p.product_id === association.product_id);
        const receipt = view.local.receipt.members.find((member: any) => member.product_id === association.product_id);
        assert.ok(receipt);
        assert.deepEqual(product.contract_refs, receipt.contract_refs, 'Each member readback must match its own four-role receipt.');
        assert.deepEqual(product.contract_bundle_ref, receipt.contract_bundle_ref);
        assert.deepEqual(Object.keys(product.contract_refs).sort(), [...R1_CONTRACT_ROLES].sort());
        for (const role of R1_CONTRACT_ROLES) assert.match(product.contract_refs[role].digest, /^sha256:[a-f0-9]{64}$/u);
        assert.match(product.contract_bundle_ref.digest, /^sha256:[a-f0-9]{64}$/u);
        assert.equal(result.rows.length, 1);
        if (product.payload_kind === 'relation_edges') { assert.equal(product.logical_domain, 'foundation'); assert.equal(result.rows[0].row.object.id, 'synthetic_group'); }
        else assert.equal(product.payload_kind, 'tabular_rows');
        fixed.push(result.rows);
      }
      const count = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await host.call('/r1/requests/mixed-publication')).local.associations, view.local.associations);
      for (const [index, association] of view.local.associations.entries()) {
        assert.deepEqual((await host.services.r1Runtime!.client.fixedRead(association.snapshot_id, association.product_id)).result.rows, fixed[index]);
      }
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
    } finally { await host.close(); }
  });

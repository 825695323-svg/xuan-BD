import assert from 'node:assert/strict';
import test from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const isolated = { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires an explicitly selected isolated HTTP test root.' : false };
async function prepared(host: FullChainHost, suffix: string, selection = false) {
  const upload = await host.upload(`${suffix}.csv`, 'data', Buffer.from('name,amount\nsynthetic,1.2300\n'), `upload-${suffix}`);
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const accepted = await host.call('/processing/plans', { requestId: `plan-${suffix}`, input: {
    routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
    outputs: [{ outputId: 'result', materialIds: [materialId], intendedAction: 'inspect', stages: ['parse', 'structure', 'annotate', 'check'],
      tables: [{ materialId, format: 'csv', fieldMapping: { amount: 'value' }, types: { value: 'decimal_string' },
        annotations: { unit: 'synthetic-unit' }, ...(selection ? { selection: { predicate: { column: 'name', equals: 'synthetic' }, maxSelectedRows: 2, maxScannedRows: 10 } } : {}) }] }],
  } }, 202);
  assert.equal((await host.settled(accepted.jobId)).status, 'succeeded');
  const planId = host.services.processing!.getByTask(accepted.jobId)!.plan!.planId;
  return { planId, materialId };
}
async function complete(host: FullChainHost, planId: string) {
  for (const kind of ['parse', 'structure', 'annotate', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(item => item.kind === kind)!;
    const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `execute-${planId}-${kind}` }, 202);
    const done = await host.settled(accepted.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
}
function counts(host: FullChainHost) {
  return ['tasks', 'processing_plans', 'candidate_objects'].map(table =>
    Number(host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
}

test('HTTP field dependencies are a read-only projection of actual fixed processing and survive reopening', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'field-dependencies' });
  let host = await openFullChainHost(fixture);
  try {
    const { planId, materialId } = await prepared(host, 'mapping');
    assert.throws(() => host.services.processing!.fieldDependencies(planId, 'result'), /尚未完成核对/);
    await complete(host, planId);
    const before = counts(host);
    const result = await host.call(`/processing/plans/${planId}/outputs/result/dependencies`);
    assert.equal(result.complete, true);
    assert.equal(result.coverage, 'selected_processing_output_only');
    assert.deepEqual(result.dependencies.map((item: any) => [item.inputField, item.outputField, item.kind]),
      [['name', 'name', 'mapped_field'], ['amount', 'value', 'mapped_field'], [null, 'unit', 'constant']]);
    assert.ok(result.dependencies.every((item: any) => item.materialId === materialId && item.sourceSha256.length === 64));
    assert.equal(JSON.stringify(result).includes('1.2300'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-unit'), false);
    assert.ok(result.dependencies.every((item: any) => item.sourceArtifactSha256.length === 64));
    assert.deepEqual(counts(host), before);
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual(await host.call(`/processing/plans/${planId}/outputs/result/dependencies`), result);
  } finally { await host.close(); }
});

test('HTTP field dependencies expose selection scope and missing persisted steps instead of claiming complete lineage', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'field-dependencies-gaps' });
  const host = await openFullChainHost(fixture);
  try {
    const { planId } = await prepared(host, 'selection', true);
    await complete(host, planId);
    const selected = await host.call(`/processing/plans/${planId}/outputs/result/dependencies`);
    assert.equal(selected.complete, false);
    assert.ok(selected.gaps.some((gap: string) => gap.includes('row_selection_dependency')));
    host.database.connection.prepare("DELETE FROM processing_plan_steps WHERE plan_id=? AND kind='parse'").run(planId);
    const missing = await host.call(`/processing/plans/${planId}/outputs/result/dependencies`);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.dependencies, []);
    assert.ok(missing.gaps.some((gap: string) => gap.includes('persisted_step_missing')));
  } finally { await host.close(); }
});

test('HTTP dedicated text projection is explicitly unknown rather than fabricated one-to-one field lineage', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'field-dependencies-projection' });
  const host = await openFullChainHost(fixture);
  try {
    const quote = '公司预计明年投产，尚须审批。', bytes = Buffer.from(quote);
    const upload = await host.upload('synthetic-note.txt', 'data', bytes, 'note-upload');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const sourceSha256 = host.services.materials!.getByTask(upload.jobId)!.envelope.sha256;
    const accepted = await host.call('/processing/plans', { requestId: 'note-plan', input: {
      routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'result', materialIds: [materialId],
        intendedAction: 'inspect', stages: ['parse', 'structure', 'annotate', 'check'], tables: [{ materialId, format: 'text',
          necessaryTextSelection: { version: 'bd-necessary-business-paragraph/1', sourceSha256, documentVersion: 'synthetic-1',
            purpose: 'limiting_condition', reviewBasis: 'Synthetic full paragraph with explicit condition.',
            paragraphs: [{ start: 0, end: quote.length, quote }] } }] }],
    } }, 202);
    const done = await host.settled(accepted.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const planId = host.services.processing!.getByTask(done.id)!.plan!.planId;
    await complete(host, planId);
    const result = await host.call(`/processing/plans/${planId}/outputs/result/dependencies`);
    assert.equal(result.complete, false);
    assert.deepEqual(result.dependencies, []);
    assert.ok(result.gaps.some((gap: string) => gap.includes('unsupported_field_dependency_projection')));
    assert.equal(JSON.stringify(result).includes(quote), false);
  } finally { await host.close(); }
});

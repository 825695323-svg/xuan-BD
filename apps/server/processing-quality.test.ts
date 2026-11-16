import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcessingPlanInput, ProcessingPlanService } from '../../modules/collection/processing-plan.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

type PlanView = ReturnType<ProcessingPlanService['get']>;
const isolated = { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires an explicitly selected isolated HTTP test root.' : false };
// Synthetic format and type choices exercise the real BD services, not provider business rules.
const samples = {
  bad: Buffer.from('name,value\nsynthetic-bad,not-a-number\n'),
  good: Buffer.from('name,value\nsynthetic-good,1.2300\n'),
  evidenceGap: 'Synthetic source has no adopted unit, public availability time or formal target.',
  rejection: 'Synthetic operator declines this output pending independent source evidence.',
};

async function upload(host: FullChainHost, name: string, bytes: Buffer, requestId: string) {
  const accepted = await host.upload(name, 'data', bytes, requestId);
  const task = await host.settled(accepted.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const material = host.services.materials!.getByTask(task.id)!.envelope;
  assert.deepEqual(host.services.materials!.readOriginal(material.materialId).bytes, bytes);
  return material.materialId;
}

function planInput(materials: { outputId: string; materialId: string; type: 'string' | 'decimal_string' }[]): ProcessingPlanInput {
  return {
    routing: { materials: materials.map(({ materialId }) => ({ materialId, intendedAction: 'inspect' })) },
    outputs: materials.map(({ outputId, materialId, type }) => ({ outputId, materialIds: [materialId], intendedAction: 'inspect',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'csv', types: { value: type } }] })),
  };
}

async function query(host: FullChainHost, planId: string): Promise<PlanView> {
  return await host.call(`/processing/plans/${planId}`);
}

async function prepare(host: FullChainHost, input: ProcessingPlanInput, requestId: string, previousPlanId?: string) {
  const path = previousPlanId ? `/processing/plans/${previousPlanId}/revise` : '/processing/plans';
  const accepted = await host.call(path, { requestId, input }, 202);
  const done = await host.settled(accepted.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  return { taskId: done.id, plan: await query(host, host.services.processing!.getByTask(done.id)!.plan!.planId) };
}

async function execute(host: FullChainHost, planId: string, outputId: string, kind: string, requestId: string) {
  const step = (await query(host, planId)).steps.find(item => item.outputId === outputId && item.kind === kind);
  assert.ok(step, `Expected explicit ${outputId}/${kind} step`);
  const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId }, 202);
  return { stepId: step.stepId, task: await host.settled(accepted.jobId) };
}

async function complete(host: FullChainHost, planId: string, outputId: string, requestPrefix: string) {
  for (const kind of ['parse', 'structure', 'check']) {
    const result = await execute(host, planId, outputId, kind, `${requestPrefix}-${kind}`);
    assert.equal(result.task.status, 'succeeded', JSON.stringify(result.task.error));
    assert.equal((await query(host, planId)).steps.find(step => step.stepId === result.stepId)!.state, 'succeeded');
  }
}

function count(host: FullChainHost, table: 'tasks' | 'processing_plans' | 'candidate_objects' | 'r1_handoff_attempts') {
  return Number(host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}

test('HTTP quality survives reopening and directs revision without invalidating unrelated output', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'quality-http-revision' });
  let host = await openFullChainHost(fixture);
  try {
    const bad = await upload(host, 'synthetic-bad.csv', samples.bad, 'quality-bad-upload');
    const good = await upload(host, 'synthetic-good.csv', samples.good, 'quality-good-upload');
    const input = planInput([{ outputId: 'bad', materialId: bad, type: 'decimal_string' },
      { outputId: 'good', materialId: good, type: 'decimal_string' }]);
    const created = await prepare(host, input, 'quality-plan');
    const planId = created.plan.planId;
    const duplicate = await prepare(host, input, 'quality-plan');
    assert.equal(duplicate.taskId, created.taskId);
    assert.equal(duplicate.plan.planId, planId);
    assert.equal(count(host, 'processing_plans'), 1);
    assert.ok(created.plan.steps.every(step => step.state === 'pending'), 'Preparing a plan must not execute modules');

    await complete(host, planId, 'good', 'quality-good');
    assert.equal((await execute(host, planId, 'bad', 'parse', 'quality-bad-parse')).task.status, 'succeeded');
    const failure = await execute(host, planId, 'bad', 'structure', 'quality-bad-structure');
    assert.equal(failure.task.status, 'failed');
    assert.equal(failure.task.error?.code, 'CANDIDATE_NUMBER');
    const before = await query(host, planId);
    const issue = before.quality.issues.find(item => item.kind === 'execution_failure' && item.stepId === failure.stepId);
    assert.ok(issue, JSON.stringify(before.quality));
    assert.deepEqual(issue.location, { row: null, column: null });
    assert.equal(issue.next, 'revise_affected_steps');
    assert.ok(before.quality.issues.some(item => item.kind === 'dependency_blocked' && item.stepId === 'check:bad'));
    assert.deepEqual(before.quality.revision.affectedStepIds.slice().sort(), ['check:bad', 'structure:bad:0']);
    assert.deepEqual(before.quality.revision.affectedOutputIds, ['bad']);
    assert.equal(before.quality.revision.reuse, 'requires_revalidation');
    assert.ok(before.quality.revision.retainedArtifacts.some(item => item.stepId === 'parse:bad:0'));
    assert.ok(before.quality.revision.retainedArtifacts.some(item => item.stepId === 'check:good'));
    assert.equal(before.quality.scope, 'recorded_plan_evidence_only');
    assert.equal(before.quality.publication, 'not_granted');
    const goodBytes = host.services.processing!.outputArtifact(planId, 'good').bytes;
    const taskCount = count(host, 'tasks');
    assert.deepEqual((await query(host, planId)).quality, before.quality);
    assert.equal(count(host, 'tasks'), taskCount, 'A quality query must not schedule repair or publication');

    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual((await query(host, planId)).quality, before.quality);
    assert.deepEqual(host.services.processing!.outputArtifact(planId, 'good').bytes, goodBytes);

    const revisedInput = structuredClone(input);
    revisedInput.outputs[0]!.tables![0]!.types = { value: 'string' };
    const revised = (await prepare(host, revisedInput, 'quality-revise', planId)).plan;
    assert.equal(revised.parentPlanId, planId);
    const goodSteps = revised.steps.filter(step => step.outputId === 'good');
    assert.ok(goodSteps.every(step => step.state === 'succeeded' && step.reusedFrom?.planId === planId));
    assert.deepEqual(host.services.processing!.outputArtifact(revised.planId, 'good').bytes, goodBytes);
    const revisedParse = revised.steps.find(step => step.stepId === 'parse:bad:0')!;
    assert.equal(revisedParse.state, 'succeeded', 'A scalar type change belongs to structure; verified parsing can be reused');
    assert.equal(revisedParse.reusedFrom?.planId, planId);
    assert.equal(revisedParse.outputDigest, before.steps.find(step => step.stepId === revisedParse.stepId)!.outputDigest);
    for (const kind of ['structure', 'check']) {
      const result = await execute(host, revised.planId, 'bad', kind, `quality-repaired-${kind}`);
      assert.equal(result.task.status, 'succeeded', JSON.stringify(result.task.error));
    }
    const repaired = await query(host, revised.planId);
    assert.ok(repaired.outputs.every(output => output.state === 'structured' && !output.publishEligible));
    assert.ok(!repaired.quality.issues.some(item => item.kind === 'execution_failure' || item.kind === 'dependency_blocked'));
    assert.ok(repaired.quality.issues.some(item => item.kind === 'needs_evidence' && item.next === 'supply_evidence_or_target'));
    assert.equal(repaired.quality.publication, 'not_granted');
    assert.deepEqual((await host.call(`/processing/plans/${revised.planId}/outputs/bad/artifact`)).rows,
      [{ name: 'synthetic-bad', value: 'not-a-number' }]);
    assert.deepEqual((await query(host, planId)).quality, before.quality, 'A revision must preserve the failed original plan');

    const objectCount = count(host, 'candidate_objects');
    const unchanged = (await prepare(host, revisedInput, 'quality-unchanged', revised.planId)).plan;
    assert.ok(unchanged.steps.every(step => step.state === 'succeeded' && step.reusedFrom?.planId === revised.planId));
    assert.equal(count(host, 'candidate_objects'), objectCount, 'An unchanged plan must not duplicate existing processing artifacts');

    const remappedInput = structuredClone(revisedInput);
    remappedInput.outputs[0]!.tables![0]!.fieldMapping = { name: 'label' };
    const remapped = (await prepare(host, remappedInput, 'quality-remapped', unchanged.planId)).plan;
    const remappedParse = remapped.steps.find(step => step.stepId === 'parse:bad:0')!;
    assert.equal(remappedParse.state, 'pending', 'A changed parsing rule must invalidate the retained parse candidate');
    assert.equal(remappedParse.reusedFrom, null);
    assert.notEqual(remappedParse.specDigest, revisedParse.specDigest);
    assert.ok(remapped.steps.filter(step => step.outputId === 'good')
      .every(step => step.state === 'succeeded' && step.reusedFrom?.planId === unchanged.planId));
    await complete(host, remapped.planId, 'bad', 'quality-remapped');
    assert.deepEqual((await host.call(`/processing/plans/${remapped.planId}/outputs/bad/artifact`)).rows,
      [{ label: 'synthetic-bad', value: 'not-a-number' }]);
    assert.equal(count(host, 'r1_handoff_attempts'), 0);
    assert.deepEqual(host.services.materials!.readOriginal(bad).bytes, samples.bad);
  } finally { await host.close(); }
});

test('HTTP evidence gaps and operator rejection request a decision without scheduling repeated cleaning', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'quality-http-evidence' });
  const host = await openFullChainHost(fixture);
  try {
    const materialId = await upload(host, 'synthetic-evidence.csv', samples.good, 'quality-evidence-upload');
    const input = planInput([{ outputId: 'evidence', materialId, type: 'decimal_string' }]);
    input.outputs[0]!.coverage = { complete: false, gaps: [samples.evidenceGap], scope: 'synthetic_source_evidence' };
    input.outputs.push({ outputId: 'declined', materialIds: [materialId], intendedAction: 'inspect', stages: [],
      rejectReason: samples.rejection });
    const { plan } = await prepare(host, input, 'quality-evidence-plan');
    await complete(host, plan.planId, 'evidence', 'quality-evidence');
    const before = await query(host, plan.planId);
    const evidence = before.quality.issues.filter(issue => issue.outputId === 'evidence');
    assert.ok(evidence.some(issue => issue.kind === 'needs_evidence'));
    assert.ok(evidence.every(issue => issue.next === 'supply_evidence_or_target'));
    const rejection = before.quality.issues.find(issue => issue.kind === 'operator_rejected' && issue.outputId === 'declined');
    assert.ok(rejection);
    assert.equal(rejection.next, 'operator_decision');
    assert.equal(rejection.reason, samples.rejection);
    assert.deepEqual(before.quality.revision.affectedStepIds, []);
    const taskCount = count(host, 'tasks'), objectCount = count(host, 'candidate_objects');
    assert.deepEqual((await query(host, plan.planId)).quality, before.quality);
    assert.equal(count(host, 'tasks'), taskCount);
    assert.equal(count(host, 'candidate_objects'), objectCount);
    assert.equal(count(host, 'r1_handoff_attempts'), 0);
    assert.ok(before.outputs.every(output => !output.publishEligible));
  } finally { await host.close(); }
});

test('HTTP missing artifact and persisted rows remain visible after explicit integrity recovery', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'quality-http-missing' });
  let host = await openFullChainHost(fixture);
  try {
    const materialId = await upload(host, 'synthetic-missing.csv', samples.good, 'quality-missing-upload');
    const { plan } = await prepare(host, planInput([{ outputId: 'observed', materialId, type: 'decimal_string' }]), 'quality-missing-plan');
    await complete(host, plan.planId, 'observed', 'quality-missing');
    const before = await query(host, plan.planId), parse = before.steps.find(step => step.kind === 'parse')!;
    assert.ok(parse.output);
    // Deliberate fault injection in this newly created synthetic state only. Queries and recovery still use real HTTP routes.
    const storage = host.database.connection.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()!.type;
    const objectTable = storage === 'view' ? 'candidate_object_layouts' : 'candidate_objects';
    host.database.connection.prepare(`DELETE FROM ${objectTable} WHERE sha256=?`).run(parse.output.sha256);
    host.database.connection.prepare('DELETE FROM processing_plan_steps WHERE plan_id=? AND step_id=?')
      .run(plan.planId, 'structure:observed:0');
    host.database.connection.prepare('DELETE FROM processing_plan_outputs WHERE plan_id=? AND output_id=?')
      .run(plan.planId, 'observed');
    const broken = await query(host, plan.planId);
    const missing = broken.quality.issues.filter(issue => issue.kind === 'artifact_or_record_missing');
    assert.ok(missing.some(issue => issue.stepId === parse.stepId));
    assert.ok(missing.some(issue => issue.stepId === 'structure:observed:0'));
    assert.ok(missing.some(issue => issue.outputId === 'observed' && issue.stepId === null));
    assert.ok(!broken.quality.revision.retainedArtifacts.some(item => item.stepId === parse.stepId));
    assert.equal(broken.outputs[0]!.publishEligible, false);
    const objectCount = count(host, 'candidate_objects');
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual((await query(host, plan.planId)).quality, broken.quality);
    const recovery = await host.call(`/processing/plans/${plan.planId}/recover`, { requestId: 'quality-explicit-recovery' }, 202);
    const recovered = await host.settled(recovery.jobId);
    assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error));
    const result = recovered.result!.data as unknown as { integrity: { corrupt: string[] } };
    assert.ok(result.integrity.corrupt.length >= 2, 'Recovery must report missing state, not fabricate repaired artifacts');
    assert.ok((await query(host, plan.planId)).quality.issues.some(issue => issue.kind === 'artifact_or_record_missing'));
    assert.equal(count(host, 'candidate_objects'), objectCount);
    assert.equal(count(host, 'r1_handoff_attempts'), 0);
    assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, samples.good);
  } finally { await host.close(); }
});

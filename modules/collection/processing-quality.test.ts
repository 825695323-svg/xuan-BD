import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedProcessingSteps, processingQuality, processingQualitySummary, type ProcessingQualityInput } from './processing-quality.js';

// 只验证框架；身份、值和规则均为集中合成样本，不代表供应商业务参数。
const artifact = { kind: 'stored-object' as const, sha256: 'a'.repeat(64), byte_length: 20, media_type: 'application/json' };
const output = (outputId: string): ProcessingQualityInput['outputs'][number] => ({ outputId, materialIds: ['material-synthetic'],
  state: 'pending', routingState: 'ready_candidate', gaps: [], semanticGaps: [], rejectReason: null });
const step = (stepId: string, outputId: string, dependsOn: string[] = []): ProcessingQualityInput['steps'][number] => ({
  stepId, outputId, dependsOn, state: 'succeeded', applicability: 'applicable', gaps: [], output: { ...artifact },
  outputDigest: artifact.sha256, error: null, semantic: null });
const fixture = (): ProcessingQualityInput => ({ outputs: [output('a'), output('b')],
  steps: [step('parse:a', 'a'), step('structure:a', 'a', ['parse:a']), step('check:a', 'a', ['structure:a']),
    step('parse:b', 'b'), step('check:b', 'b', ['parse:b'])],
  integrity: [], missingSteps: [], missingOutputs: [] });
function failStructure(input: ProcessingQualityInput) {
  Object.assign(input.steps[1]!, { state: 'failed', output: null, outputDigest: null,
    error: { code: 'SYNTHETIC_TYPE', message: 'synthetic conversion failure at row 9 column 4' } });
  Object.assign(input.steps[2]!, { state: 'pending', output: null, outputDigest: null });
  return input;
}

test('no reported issue describes only recorded evidence and grants no publication', () => {
  const quality = processingQuality(fixture());
  assert.equal(quality.status, 'no_reported_issue');
  assert.equal(quality.scope, 'recorded_plan_evidence_only');
  assert.equal(quality.publication, 'not_granted');
  assert.deepEqual(quality.revision.affectedStepIds, []);
});
test('failure scope contains the failed module and declared downstream only', () => {
  const quality = processingQuality(failStructure(fixture()));
  assert.deepEqual(quality.revision.affectedStepIds, ['structure:a', 'check:a']);
  assert.deepEqual(quality.revision.affectedOutputIds, ['a']);
  assert.deepEqual(quality.revision.retainedArtifacts.map(item => item.stepId), ['parse:a', 'parse:b', 'check:b']);
  assert.equal(quality.revision.reuse, 'requires_revalidation');
});
test('error text never supplies invented row or column positions', () => {
  const issue = processingQuality(failStructure(fixture())).issues.find(item => item.kind === 'execution_failure')!;
  assert.deepEqual(issue.location, { row: null, column: null });
  assert.equal(issue.ruleCode, 'SYNTHETIC_TYPE');
});
test('explicit persisted error location remains available', () => {
  const input = failStructure(fixture());
  input.steps[1]!.error!.location = { row: 3, column: 'value' };
  assert.deepEqual(processingQuality(input).issues.find(item => item.kind === 'execution_failure')!.location, { row: 3, column: 'value' });
});
test('invalid supplied locations remain unknown', () => {
  const input = failStructure(fixture());
  input.steps[1]!.error!.location = { row: -1, column: 1.5 };
  assert.deepEqual(processingQuality(input).issues.find(item => item.kind === 'execution_failure')!.location, { row: null, column: null });
});
test('dependency failure is distinct from execution failure', () => {
  const quality = processingQuality(failStructure(fixture()));
  assert.ok(quality.issues.some(item => item.kind === 'dependency_blocked' && item.stepId === 'check:a'));
  assert.equal(quality.issues.filter(item => item.kind === 'execution_failure').length, 1);
});
test('ordinary prepared dependencies do not invent recorded failures', () => {
  const input = fixture();
  for (const item of input.steps) Object.assign(item, { state: 'pending', output: null, outputDigest: null });
  assert.equal(processingQuality(input).status, 'no_reported_issue');
});
test('a succeeded step with incomplete dependencies is inconsistent and not a reuse candidate', () => {
  for (const state of ['pending', 'blocked']) {
    const input = fixture(); Object.assign(input.steps[0]!, { state, output: null, outputDigest: null });
    const quality = processingQuality(input);
    assert.ok(quality.issues.some(item => item.stepId === 'structure:a' && item.kind === 'dependency_blocked'
      && item.next === 'repair_record'));
    assert.deepEqual(quality.revision.affectedStepIds, ['structure:a', 'check:a']);
    assert.ok(quality.revision.retainedArtifacts.every(item => item.outputId === 'b'));
  }
});
test('persisted dependency and artifact errors retain their distinct categories', () => {
  for (const [code, kind] of [['PROCESSING_DEPENDENCY', 'dependency_blocked'], ['PROCESSING_ARTIFACT_CHANGED', 'artifact_or_record_missing']]) {
    const input = failStructure(fixture()); input.steps[1]!.error!.code = code;
    assert.ok(processingQuality(input).issues.some(item => item.stepId === 'structure:a' && item.kind === kind));
    assert.ok(!processingQuality(input).issues.some(item => item.stepId === 'structure:a' && item.kind === 'execution_failure'));
  }
});
test('explicit cross-output dependency propagates impact', () => {
  const input = failStructure(fixture());
  input.steps[4]!.dependsOn.push('check:a');
  assert.deepEqual(processingQuality(input).revision.affectedStepIds, ['structure:a', 'check:a', 'check:b']);
  assert.deepEqual(processingQuality(input).revision.affectedOutputIds, ['a', 'b']);
});
test('shared material alone does not propagate impact across outputs', () => {
  const input = failStructure(fixture());
  assert.equal(input.outputs[0]!.materialIds[0], input.outputs[1]!.materialIds[0]);
  assert.deepEqual(processingQuality(input).revision.affectedOutputIds, ['a']);
});
test('missing step records use frozen specifications for dependency scope', () => {
  const input = fixture();
  input.expectedSteps = input.steps.map(({ stepId, outputId, dependsOn }) => ({ stepId, outputId, dependsOn }));
  input.steps.splice(1, 1);
  input.missingSteps.push('structure:a');
  const quality = processingQuality(input);
  assert.ok(quality.issues.some(item => item.kind === 'artifact_or_record_missing' && item.stepId === 'structure:a'));
  assert.deepEqual(quality.revision.affectedStepIds, ['structure:a', 'check:a']);
});
test('historical ID-only specifications do not invent dependencies or crash readback', () => {
  const input = fixture(); input.expectedSteps = input.steps.map(({ stepId }) => ({ stepId }));
  input.steps.splice(1, 1); input.missingSteps = ['structure:a'];
  const quality = processingQuality(input);
  assert.deepEqual(quality.revision.affectedStepIds, ['structure:a', 'check:a']);
  assert.ok(quality.issues.some(item => item.stepId === 'structure:a' && item.outputId === null));
});
test('a dependency absent from both records and specifications still blocks descendants', () => {
  const input = fixture();
  input.steps[1]!.dependsOn = ['absent'];
  const quality = processingQuality(input);
  assert.ok(quality.issues.some(item => item.stepId === 'absent' && item.kind === 'artifact_or_record_missing'));
  assert.deepEqual(quality.revision.affectedStepIds, ['structure:a', 'check:a']);
});
test('missing output record requires record repair rather than a blanket rerun', () => {
  const input = fixture(); input.missingOutputs.push('a'); input.outputs[0]!.state = 'missing';
  const quality = processingQuality(input);
  assert.equal(quality.issues[0]!.next, 'repair_record');
  assert.deepEqual(quality.revision.affectedStepIds, []);
});
test('missing object integrity invalidates its dependents and reuse candidacy', () => {
  const input = fixture(); input.integrity.push({ stepId: 'parse:a', present: false });
  const quality = processingQuality(input);
  assert.deepEqual(quality.revision.affectedStepIds, ['parse:a', 'structure:a', 'check:a']);
  assert.ok(quality.revision.retainedArtifacts.every(item => item.outputId === 'b'));
});
test('successful state without artifact cannot be treated as no issue', () => {
  const input = fixture(); input.steps[1]!.output = null;
  assert.ok(processingQuality(input).issues.some(item => item.stepId === 'structure:a' && item.kind === 'artifact_or_record_missing'));
});
test('digest disagreement invalidates an artifact without opening any object', () => {
  const input = fixture(); input.steps[1]!.outputDigest = 'b'.repeat(64);
  assert.deepEqual(processingQuality(input).revision.affectedStepIds, ['structure:a', 'check:a']);
});
test('semantic failure is explicit and includes its declared rule', () => {
  const input = fixture(); input.steps[2]!.semantic = { quality: 'fail', gaps: ['synthetic rule mismatch'], ruleVersion: 'synthetic/1' };
  const quality = processingQuality(input);
  assert.ok(quality.issues.some(item => item.kind === 'semantic_failure' && item.ruleCode === 'synthetic/1'));
  assert.deepEqual(quality.revision.affectedStepIds, ['check:a']);
});
test('missing semantic evidence asks for evidence and does not recommend repeated cleaning', () => {
  const input = fixture(); input.outputs[0]!.semanticGaps = ['unit has not been established'];
  input.steps[2]!.semantic = { quality: 'indeterminate', gaps: ['source evidence missing'] };
  const quality = processingQuality(input);
  assert.ok(quality.issues.every(item => item.next === 'supply_evidence_or_target'));
  assert.deepEqual(quality.revision.affectedStepIds, []);
});
test('operator rejection is preserved as a distinct unresolved decision', () => {
  const input = fixture(); input.outputs[0]!.rejectReason = 'synthetic operator rejection';
  const quality = processingQuality(input);
  assert.ok(quality.issues.some(item => item.kind === 'operator_rejected' && item.next === 'operator_decision' && item.disposition === 'unresolved'));
  assert.deepEqual(quality.revision.affectedStepIds, []);
});
test('dependency closure terminates even for a malformed cycle', () => {
  const graph = [step('a', 'x', ['c']), step('b', 'x', ['a']), step('c', 'x', ['b'])];
  assert.deepEqual(affectedProcessingSteps(graph, ['b']), ['a', 'b', 'c']);
});
test('view construction is deterministic and does not mutate persisted snapshots', () => {
  const input = failStructure(fixture()), before = JSON.stringify(input);
  assert.deepEqual(processingQuality(input), processingQuality(structuredClone(input)));
  assert.equal(JSON.stringify(input), before);
});
test('model summary is bounded and reports omissions without losing publication boundary', () => {
  const input = fixture();
  input.outputs = Array.from({ length: 16 }, (_, index) => ({ ...output(String(index)), semanticGaps: ['x'.repeat(10000)] }));
  const summary = processingQualitySummary(processingQuality(input))!;
  assert.equal(summary.issueCount, 16); assert.equal(summary.issues.length, 6); assert.equal(summary.issuesTruncated, true);
  assert.ok(summary.issues.every(item => item.reason.length <= 400));
  assert.equal(summary.publication, 'not_granted');
  assert.equal(processingQualitySummary(undefined), null);
});

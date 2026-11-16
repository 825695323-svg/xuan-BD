import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1PrepareInput, R1RequestView, R1SnapshotStatus } from '../../../../contracts/r1-contracts.js';
import { prepareReviewedR1Set, prepareReviewedR1Output, r1ConfirmationKey, reviewR1Plan, submitReviewedR1Request, type R1ReviewPort } from '../r1-plan-review.js';

// All values in this file are synthetic UI protocol fixtures, not provider or production settings.
const source = { source_id: 'fixture', provider: 'fixture', requested_url: 'test:fixture',
  requested_at_utc: '2026-01-02T00:00:00Z', acquired_at_utc: '2026-01-02T00:01:00Z', usage_scope: 'isolated-test',
  authorization: { status: 'authorized', basis: 'isolated synthetic test' } };
function plan() {
  const outputs = ['good', 'bad'].map(outputId => ({ outputId, state: outputId === 'good' ? 'structured' : 'failed',
    intendedAction: 'publish', publishEligible: outputId === 'good', routingState: outputId === 'good' ? 'ready_candidate' : 'needs_review',
    materialIds: ['fixture-original-' + outputId], gaps: outputId === 'good' ? [] : ['fixture failure'], semanticGaps: [],
    semantic: { quality: outputId === 'good' ? 'pass' : 'fail' },
    target: { expectedSnapshotId: null, declaration: { protocol: 'wfd.structured-ingest/1.0', source,
      mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
        sourceTimezone: 'UTC', precision: 'day', fields: [{ fieldCode: 'value', value: 'value', state: 'state' }] },
      target: { datasetId: 'fixture', outputKey: outputId, expectedParentSnapshotId: null, subject: { kind: 'fixture' },
        definition: { semantic_code: 'fixture.' + outputId }, inputMode: 'partial_observation', coverage: { completeness: 'partial' } } } } }));
  const steps = outputs.flatMap(output => ['parse','structure','check'].map((kind,index) => ({
    stepId: kind + ':' + output.outputId, outputId: output.outputId, kind,
    state: output.outputId === 'good' ? 'succeeded' : index === 0 ? 'succeeded' : 'failed',
    dependsOn: index ? [['parse','structure'][index - 1] + ':' + output.outputId] : [],
    outputDigest: 'a'.repeat(64), required: true,
  })));
  return { planId: 'fixture-plan', planDigest: 'b'.repeat(64), outputs, steps, missingSteps: [], missingOutputs: [],
    integrity: steps.map(step => ({ stepId: step.stepId, present: true })) };
}
function requestView(): R1RequestView {
  return { requestId: 'fixture-request', planId: 'fixture-plan', outputId: 'good', datasetId: 'fixture', outputKey: 'good',
    documentSha256: 'c'.repeat(64), state: 'prepared_profile_pending', requiresRecovery: false,
    submitTaskId: null, rowCount: 1, previewRows: [], local: {}, error: null,
    connection: { connectionId: 'fixture-connection', protocol: 'wfd.structured-ingest/1.0', profile: 'data_only',
      mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'fixture-runtime', store: '/test/store', runtime: '/test/runtime',
      callerId: 'fixture', namespace: 'fixture', configSha256: 'd'.repeat(64), schemaSha256: 'e'.repeat(64),
      entrySha256: 'f'.repeat(64), pythonPath: '/test/python', entryPath: '/test/entry.py' } };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
function fixture() {
  const state = { plan: plan(), view: requestView(), snapshotId: null as string | null, prepares: [] as R1PrepareInput[], submits: 0, reads: 0 };
  const port: R1ReviewPort = {
    plan: async () => { state.reads++; return structuredClone(state.plan); },
    snapshotStatus: async () => ({ snapshotId: state.snapshotId }) as R1SnapshotStatus,
    get: async () => structuredClone(state.view),
    prepare: async input => { state.prepares.push(input); state.view.requestId = input.requestId; return structuredClone(state.view); },
    submit: async () => { state.submits++; return { accepted: true }; },
  };
  return { state, port };
}

test('all outputs remain visible; failed independent peer does not qualify itself or block good output', () => {
  const input = plan(), before = JSON.stringify(input), reviewed = reviewR1Plan(input);
  assert.equal(reviewed.submissionMode, 'one_independent_output');
  assert.equal(reviewed.collectionSubmission, 'declared_sets');
  assert.deepEqual(reviewed.sets, []);
  assert.equal(reviewed.outputs.length, 2);
  assert.equal(reviewed.outputs[0]!.eligible, true);
  assert.equal(reviewed.outputs[1]!.eligible, false);
  assert.ok(reviewed.outputs[1]!.reasons.includes('R1_OUTPUT_NOT_READY'));
  assert.equal(JSON.stringify(input), before);
});

test('cross-output dependencies block every related member, not merely the selected child', () => {
  const input = plan(); input.steps[1]!.dependsOn.push('parse:bad');
  const reviewed = reviewR1Plan(input);
  for (const output of reviewed.outputs) assert.ok(output.reasons.includes('R1_COLLECTION_CONFIRMATION_REQUIRED'));
  assert.deepEqual(reviewed.outputs[0]!.relatedOutputIds, ['bad']);
  assert.deepEqual(reviewed.outputs[1]!.relatedOutputIds, ['good']);
});

test('declared publication groups cannot be silently dropped by the single-output path', () => {
  const input = plan();
  const grouped = { ...input, consistency_groups: { related: ['good', 'bad'] } };
  assert.ok(reviewR1Plan(grouped).outputs.every(output => !output.eligible));
  const targetGroup = structuredClone(input) as any;
  targetGroup.outputs[0].target.declaration.target.consistencyGroups = { together: ['good', 'bad'] };
  assert.ok(!reviewR1Plan(targetGroup).outputs[0]!.eligible);
});

test('unknown integrity, duplicate outputs, missing dependencies and cycles fail closed', () => {
  const malformed: any = plan(); delete malformed.integrity;
  assert.throws(() => reviewR1Plan(malformed), code('R1_REVIEW_SHAPE'));
  const duplicate = plan(); duplicate.outputs[1]!.outputId = 'good';
  assert.throws(() => reviewR1Plan(duplicate), code('R1_REVIEW_DEPENDENCY'));
  const missing = plan(); missing.steps[1]!.dependsOn = ['absent'];
  assert.throws(() => reviewR1Plan(missing), code('R1_REVIEW_DEPENDENCY'));
  const cycle = plan(); cycle.steps[0]!.dependsOn = ['check:good'];
  assert.throws(() => reviewR1Plan(cycle), code('R1_REVIEW_DEPENDENCY'));
});

test('a missing artifact and incomplete semantic proof are individually visible blockers', () => {
  const input = plan(); input.integrity[0]!.present = false;
  assert.ok(reviewR1Plan(input).outputs[0]!.reasons.includes('R1_OUTPUT_INTEGRITY'));
  const semantic = plan(); semantic.outputs[0]!.semantic.quality = 'indeterminate';
  assert.ok(reviewR1Plan(semantic).outputs[0]!.reasons.includes('R1_SEMANTIC_UNRESOLVED'));
});

test('source-less scalar plans and multiple originals are referred to the existing editor without guessing', () => {
  const input: any = plan(); delete input.outputs[0].target.declaration.source;
  delete input.outputs[0].target.declaration.mapping.kind;
  input.outputs[0].materialIds.push('other');
  const output = reviewR1Plan(input).outputs[0]!;
  assert.equal(output.recipe, null);
  assert.ok(output.reasons.includes('R1_SOURCE_UNCONFIRMED'));
  assert.ok(output.reasons.includes('R1_SOURCE_EDITOR_REQUIRED'));
  assert.ok(output.reasons.includes('R1_MULTI_SOURCE_UNSUPPORTED'));
});

test('target-parent mismatch is not normalized to an empty or current snapshot', () => {
  const input: any = plan(); input.outputs[0].target.expectedSnapshotId = 'different';
  assert.ok(reviewR1Plan(input).outputs[0]!.reasons.includes('R1_TARGET_UNCONFIRMED'));
});

test('only the selected fresh frozen recipe is prepared; no submit follows preparation', async () => {
  const { state, port } = fixture(), review = reviewR1Plan(state.plan).outputs[0]!;
  const result = await prepareReviewedR1Output(port, review, 'fixture-request');
  assert.equal(result.requestId, 'fixture-request');
  assert.equal(state.prepares.length, 1); assert.equal(state.prepares[0]!.outputId, 'good');
  assert.equal(state.submits, 0);
});

test('a changed selected artifact or quality invalidates review before any prepare', async () => {
  const { state, port } = fixture(), reviewed = reviewR1Plan(state.plan).outputs[0]!;
  state.plan.steps[0]!.outputDigest = 'f'.repeat(64);
  await assert.rejects(prepareReviewedR1Output(port, reviewed, 'fixture-request'), code('R1_REVIEW_CHANGED'));
  assert.equal(state.prepares.length, 0);
});

test('an unrelated output status refresh does not invalidate unchanged selection', async () => {
  const { state, port } = fixture(), reviewed = reviewR1Plan(state.plan).outputs[0]!;
  state.plan.outputs[1]!.gaps.push('another peer diagnostic');
  await prepareReviewedR1Output(port, reviewed, 'fixture-request');
  assert.equal(state.prepares.length, 1);
});

test('changed WFD baseline is not rebound automatically on prepare or submit', async () => {
  const { state, port } = fixture(), reviewed = reviewR1Plan(state.plan).outputs[0]!;
  state.snapshotId = 'new-head';
  await assert.rejects(prepareReviewedR1Output(port, reviewed, 'fixture-request'), code('R1_REVIEW_BASELINE_CHANGED'));
  await assert.rejects(submitReviewedR1Request(port, state.view), code('R1_REVIEW_BASELINE_CHANGED'));
  assert.equal(state.prepares.length + state.submits, 0);
});

test('retry after lost prepare response keeps original request identity', async () => {
  const { state, port } = fixture(), reviewed = reviewR1Plan(state.plan).outputs[0]!;
  const original = port.prepare;
  port.prepare = async input => { await original(input); throw new Error('synthetic response lost'); };
  await assert.rejects(prepareReviewedR1Output(port, reviewed, 'stable-request'), /response lost/u);
  port.prepare = original;
  await prepareReviewedR1Output(port, reviewed, 'stable-request');
  assert.deepEqual(state.prepares.map(input => input.requestId), ['stable-request','stable-request']);
  assert.equal(state.submits, 0);
});

test('confirmation binds exact request, document, output and connection', async () => {
  const { state, port } = fixture(), visible = structuredClone(state.view);
  state.view.connection.runtimeIdentity = 'new-runtime';
  assert.notEqual(r1ConfirmationKey(state.view), r1ConfirmationKey(visible));
  await assert.rejects(submitReviewedR1Request(port, visible), code('R1_CONFIRMATION_CHANGED'));
  assert.equal(state.submits, 0);
});

for (const stateName of ['associated', 'partially_associated', 'conflicts_pending', 'rejected', 'sending', 'pending_unknown', 'pending_receipt']) {
  test(`original ${stateName} remains a lookup, never a new submit`, async () => {
    const { state, port } = fixture(); state.view.state = stateName;
    await assert.rejects(submitReviewedR1Request(port, structuredClone(state.view)), code('R1_REVIEW_LOOKUP_REQUIRED'));
    assert.equal(state.submits, 0);
  });
}

test('one explicit confirmation creates at most one submission call', async () => {
  const { state, port } = fixture();
  await submitReviewedR1Request(port, structuredClone(state.view));
  assert.equal(state.submits, 1);
});

function setPlan() {
  const input = plan();
  for (const output of input.outputs) { output.state = 'structured'; output.publishEligible = true; output.routingState = 'ready_candidate'; output.semantic.quality = 'pass'; output.gaps = []; }
  for (const step of input.steps) step.state = 'succeeded';
  return { ...input, consistencyGroups: { pair: ['good','bad'] } };
}
function setFixture() {
  const f = fixture(); f.state.plan = setPlan();
  f.state.view.outputId = 'pair'; f.state.view.outputKey = 'pair'; f.state.view.rowCount = 2;
  f.state.view.publicationSet = { setId: 'pair', atomicity: 'declared_set', duplicatePolicy: 'reject_member_conflict',
    members: ['bad','good'].map(outputId => ({ outputId, outputKey: outputId, rowCount: 1, previewRows: [], state: 'not_submitted', snapshotId: null, productId: null, errorCodes: [] })) };
  let calls = 0;
  f.port.prepareSet = async input => { calls++; f.state.view.requestId = input.requestId; return structuredClone(f.state.view); };
  return { ...f, calls: () => calls };
}
test('declared set is eligible only as a whole; its members cannot use individual preparation', async () => {
  const f = setFixture(), reviewed = reviewR1Plan(f.state.plan);
  assert.equal(reviewed.sets[0]!.eligible, true);
  assert.ok(reviewed.outputs.every(output => !output.eligible));
  await assert.rejects(prepareReviewedR1Output(f.port, reviewed.outputs[0]!, 'not-a-set'), code('R1_REVIEW_BLOCKED'));
  const prepared = await prepareReviewedR1Set(f.port, reviewed.sets[0]!, 'whole-pair');
  assert.equal(prepared.publicationSet!.members.length, 2); assert.equal(f.calls(), 1); assert.equal(f.state.submits, 0);
});
test('failed, changed or missing set member blocks the whole set, not silently selecting its good peer', async () => {
  const f = setFixture(), before = reviewR1Plan(f.state.plan).sets[0]!;
  f.state.plan.outputs[0]!.publishEligible = false;
  assert.equal(reviewR1Plan(f.state.plan).sets[0]!.eligible, false);
  await assert.rejects(prepareReviewedR1Set(f.port, before, 'whole-pair'), code('R1_REVIEW_CHANGED'));
  assert.equal(f.calls(), 0);
  const malformed = setPlan(); malformed.consistencyGroups.pair = ['good','missing'];
  assert.throws(() => reviewR1Plan(malformed), code('R1_PUBLICATION_SET'));
});
test('set declaration cannot conceal unsupported nested groups or different frozen parents', () => {
  const input: any = setPlan(); input.outputs[0].target.publicationSet = 'another';
  assert.equal(reviewR1Plan(input).sets[0]!.eligible, false);
  const parent: any = setPlan(); parent.outputs[0].target.expectedSnapshotId = 'other';
  parent.outputs[0].target.declaration.target.expectedParentSnapshotId = 'other';
  assert.ok(reviewR1Plan(parent).sets[0]!.reasons.includes('R1_SET_TARGET'));
});
test('whole-set confirmation binds members and current parent without automatic rebinding or submission loop', async () => {
  const f = setFixture(), visible = structuredClone(f.state.view);
  const key = r1ConfirmationKey(visible); f.state.view.publicationSet!.members.pop();
  assert.notEqual(r1ConfirmationKey(f.state.view), key);
  await assert.rejects(submitReviewedR1Request(f.port, visible), code('R1_CONFIRMATION_CHANGED'));
  f.state.view = visible; f.state.snapshotId = 'new-head';
  await assert.rejects(submitReviewedR1Request(f.port, visible), code('R1_REVIEW_BASELINE_CHANGED'));
  assert.equal(f.state.submits, 0);
  f.state.snapshotId = null; await submitReviewedR1Request(f.port, visible); assert.equal(f.state.submits, 1);
});
test('reopened pending set remains an original lookup; it cannot resubmit individual members', async () => {
  const f = setFixture(); f.state.view.state = 'pending_receipt'; f.state.view.requiresRecovery = true;
  await assert.rejects(submitReviewedR1Request(f.port, structuredClone(f.state.view)), code('R1_REVIEW_LOOKUP_REQUIRED'));
  assert.equal(f.state.submits, 0); assert.equal(f.calls(), 0);
});

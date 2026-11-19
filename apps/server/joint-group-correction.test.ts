import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { preparedSetPlan } from './r1-publication-set-test-support.js';

/** Explicit synthetic isolated setup. The original helper's legacy store is preserved,
 * never converted; a different, empty target is initialized through the real SDK. */
function freshJointFixture(machineOptions: Record<string, unknown>) {
  const fixture = createFullChainFixture({ name: 'joint-group-correction', machine: true,
    units: { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } } });
  const config = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
  const legacyStore = fixture.store;
  const store = join(fixture.root, 'explicit-new-joint-store');
  mkdirSync(store);
  const initialized = spawnSync(process.env.WFD_PYTHON!, isolatedPythonArgs(join(fixture.root, 'joint-python-cache'), ['-c',
    'from pathlib import Path; import sys; sys.path.insert(0,sys.argv[3]); from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator; WFDDuckDBPrototype.initialize_new(Path(sys.argv[1]),load_protocol_validator(Path(sys.argv[3])/"protocol"),runtime_root=Path(sys.argv[2]),sandbox=False,writer_host="full-chain-test",storage_format="joint_experimental")',
    store, fixture.wfdRuntime, config.project_root]), { cwd: fixture.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(fixture.configPath, JSON.stringify({ ...config, ...machineOptions, store }));
  const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
  registry.connections[0].store = store;
  writeFileSync(fixture.registryPath, JSON.stringify(registry));
  return { fixture: { ...fixture, store }, legacyStore };
}

async function publishOriginalGroup(host: Awaited<ReturnType<typeof openFullChainHost>>,
  expectedCommitId: string) {
  const built = await preparedSetPlan(host, 'joint-original', { expectedCommitId });
  const requestId = 'joint-original-group';
  const prepared = await host.call('/r1/prepare', {
    kind: 'publication_set', requestId, planId: built.planId, setId: 'pair',
  }, 201);
  const sent = await host.call('/r1/requests/' + requestId + '/submit',
    { confirmationDigest: prepared.documentSha256 }, 202);
  const task = await host.settled(sent.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const evidence = await host.call('/r1/requests/' + requestId + '/publication-set-evidence',
    { planId: built.planId, setId: 'pair' });
  assert.equal(evidence.status, 'complete_fixed_set_verified');
  assert.equal(evidence.members.length, 2);
  return { ...built, requestId, evidence };
}

/** Same original bytes, explicit correction of the selected close source column.
 * Synthetic open/close semantics are test parameters, not supplier evidence. */
async function prepareMemberRepairs(host: Awaited<ReturnType<typeof openFullChainHost>>,
  original: Awaited<ReturnType<typeof preparedSetPlan>>) {
  const input = structuredClone(original.input);
  for (const output of input.outputs) {
    output.intendedAction = 'inspect';
    const mapping = output.target.declaration.mapping;
    assert.ok('kind' in mapping && mapping.kind === 'tabular_rows');
    if ('kind' in mapping && mapping.kind === 'tabular_rows') {
      const close = mapping.fields.find(field => field.fieldCode === 'close')!;
      close.value = 'open';
    }
  }
  const planned = await host.call('/processing/plans', { requestId: 'joint-repair-plan', input }, 202);
  const task = await host.settled(planned.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const planId = host.services.processing!.getByTask(task.id)!.plan!.planId;
  for (const { outputId } of original.materials) for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
    if (step.state === 'succeeded') {
      assert.ok(step.reusedFrom && step.outputDigest, 'Only explicit verified processing reuse may skip execution');
      continue;
    }
    const accepted = await host.call('/processing/plans/' + planId + '/steps/' + step.stepId + '/execute',
      { requestId: 'joint-repair-' + step.stepId }, 202);
    const done = await host.settled(accepted.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  return original.materials.map(({ outputId, materialId }) => ({
    outputKey: 'review.' + outputId, planId, outputId,
    originalSha256: host.services.materials!.readOriginal(materialId).sha256,
    reason: 'Explicit synthetic same-original mapping repair: close selects open column.',
  }));
}

const enabled = !!process.env.XUAN_FULL_CHAIN_ROOT && !!process.env.WFD_PYTHON;
for (const loseReply of [false, true]) test(`explicit new joint target completes real BD group correction (${loseReply ? 'lost reply and original identity recovery' : 'normal'})`,
  { skip: !enabled, timeout: 240_000 }, async () => {
  const { fixture, legacyStore } = freshJointFixture({ storage_format: 'joint_experimental' });
  const legacyState = readFileSync(join(legacyStore, 'catalog/state.json'));
  let host = await openFullChainHost(fixture, fixture.root);
  try {
    const current = () => host.services.r1Runtime!.connection.client.snapshotStatus().then(reply => reply.result);
    const initial = await current();
    assert.equal(initial.storage_format, 'wfd.joint-volume.experimental/1');
    const original = await publishOriginalGroup(host, String(initial.joint_commit_id));
    const members = await prepareMemberRepairs(host, original);
    const prior = await current();
    const capabilities = await host.call('/corrections/capabilities');
    const caseId = 'joint-group-case', base = '/corrections/cases/' + caseId;
    await host.call('/corrections/cases', { requestId: 'joint-register', input: {
      caseId, kind: 'processing_repair', errorType: 'mapping_error', discoveredAt: '2026-11-19T00:00:00Z',
      evidence: 'Explicit synthetic two-member same-original column mapping repair, not supplier evidence.',
      binding: { publicationSet: { requestId: original.requestId, planId: original.planId, setId: 'pair',
        expectedCommitId: prior.joint_commit_id } }, connectionSha256: capabilities.connectionSha256,
    } }, 201);
    const impact = await host.call(base + '/impact', { requestId: 'joint-impact' });
    assert.equal(impact.state, 'impact_frozen', JSON.stringify(impact));
    assert.equal(impact.coverage, 'proven_subset_only');
    assert.equal(impact.items.length, 2);
    const suspended = await host.call(base + '/suspend', { requestId: 'joint-suspend' });
    assert.equal(suspended.state, 'suspended', JSON.stringify(suspended));
    const paused = await current();
    assert.equal(paused.snapshot_id, prior.snapshot_id);
    assert.notEqual(paused.joint_commit_id, prior.joint_commit_id);
    const prepared = await host.call(base + '/prepare', { requestId: 'joint-prepare', input: {
      members, expectedParentSnapshotId: prior.snapshot_id, expectedCommitId: paused.joint_commit_id,
    } });
    const denied = await host.call(base + '/authorize', { requestId: 'joint-deny', input: {
      frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256,
    } }, 202);
    let denyTask = host.services.tasks.get(denied.id);
    for (let i = 0; i < 1200 && denyTask.status !== 'waiting_approval'; i++) {
      assert.ok(!['failed', 'cancelled', 'succeeded'].includes(denyTask.status), JSON.stringify(denyTask.error));
      await delay(50); denyTask = host.services.tasks.get(denied.id);
    }
    assert.equal(denyTask.status, 'waiting_approval');
    host.services.tasks.deny(denyTask.approvalId!);
    assert.equal((await host.settled(denied.id)).status, 'failed');
    assert.deepEqual(await current(), paused, 'Denied approval cannot change either joint snapshot or usage');
    const damaged = await host.call(base + '/authorize', { requestId: 'joint-damaged-member', input: {
      frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256,
    } }, 202);
    let damagedTask = host.services.tasks.get(damaged.id);
    for (let i = 0; i < 1200 && damagedTask.status !== 'waiting_approval'; i++) {
      assert.ok(!['failed', 'cancelled', 'succeeded'].includes(damagedTask.status), JSON.stringify(damagedTask.error));
      await delay(50); damagedTask = host.services.tasks.get(damaged.id);
    }
    assert.equal(damagedTask.status, 'waiting_approval');
    const lastArtifact = host.services.processing!.outputArtifact(members[1]!.planId, members[1]!.outputId);
    const artifact = host.database.connection.prepare('SELECT head FROM candidate_object_layouts WHERE sha256=?').get(lastArtifact.ref.sha256)!;
    const originalBytes = Buffer.from(artifact.head as Uint8Array);
    try {
      host.database.connection.prepare('UPDATE candidate_object_layouts SET head=? WHERE sha256=?').run(Buffer.from('broken'), lastArtifact.ref.sha256);
      host.services.tasks.approve(damagedTask.approvalId!);
      assert.equal((await host.settled(damaged.id)).status, 'failed');
      assert.deepEqual(await current(), paused, 'Last-member artifact loss after waiting approval cannot partially publish');
    } finally {
      host.database.connection.prepare('UPDATE candidate_object_layouts SET head=? WHERE sha256=?').run(originalBytes, lastArtifact.ref.sha256);
    }
    const authorized = await host.call(base + '/authorize', { requestId: 'joint-authorize', input: {
      frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256,
    } }, 202);
    let task = host.services.tasks.get(authorized.id);
    for (let i = 0; i < 1200 && task.status !== 'waiting_approval'; i++) {
      assert.ok(!['failed', 'cancelled', 'succeeded'].includes(task.status), JSON.stringify(task.error));
      await delay(50); task = host.services.tasks.get(authorized.id);
    }
    assert.equal(task.status, 'waiting_approval');
    assert.deepEqual(await current(), paused); // Merely preparing approval cannot publish.
    const client = host.services.r1Runtime!.connection.client;
    const submit = client.submit.bind(client), requestStatus = client.requestStatus.bind(client);
    let submits = 0;
    if (loseReply) {
      client.submit = async (...args) => { submits++; await submit(...args); throw new Error('Synthetic transport loses completed group reply'); };
      client.requestStatus = async () => { throw new Error('Synthetic transport status temporarily unavailable'); };
    }
    host.services.tasks.approve(task.approvalId!); // Explicit isolated test approval, not model self-authorization.
    const done = await host.settled(authorized.id);
    if (loseReply) {
      assert.equal(done.status, 'failed');
      assert.equal(done.error?.code, 'CORRECTION_OUTCOME_UNKNOWN');
      assert.equal(submits, 1);
      const committed = await current();
      assert.notEqual(committed.snapshot_id, paused.snapshot_id);
      // Formal publication is already durable: temporary candidate loss must not cause resubmission.
      host.database.connection.prepare('UPDATE candidate_object_layouts SET head=? WHERE sha256=?').run(Buffer.from('temporary artifact unavailable after formal'), lastArtifact.ref.sha256);
      client.submit = submit; client.requestStatus = requestStatus;
      const taskCountBeforeRecovery = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
      await host.close(); host = await openFullChainHost(fixture, fixture.root);
      const reopened = host.services.r1Runtime!.connection.client;
      const originalSubmit = reopened.submit.bind(reopened);
      reopened.submit = async () => { throw new Error('Recovery must not resend an already formal group'); };
      const recovered = await host.call(base + '/recover', { requestId: 'joint-lost-reply-recovery' });
      assert.equal(recovered.state, 'resolved');
      assert.deepEqual(await current(), committed);
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, taskCountBeforeRecovery);
      reopened.submit = originalSubmit;
      host.database.connection.prepare('UPDATE candidate_object_layouts SET head=? WHERE sha256=?').run(originalBytes, lastArtifact.ref.sha256);
    } else assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const view = await host.call(base);
    assert.equal(view.state, 'resolved', JSON.stringify(view));
    const final = await current();
    assert.notEqual(final.snapshot_id, prior.snapshot_id);
    assert.notEqual(final.joint_commit_id, paused.joint_commit_id);
    const links = host.database.connection.prepare('SELECT * FROM r1_record_associations WHERE snapshot_id=? ORDER BY product_id').all(String(final.snapshot_id));
    assert.equal(links.length, 2);
    for (const link of links) {
      const packet = await host.call('/r1/records/evidence', { datasetId: link.dataset_id, productId: link.product_id,
        recordId: link.record_id, recordVersion: link.record_version });
      const originalMember = original.evidence.members.find((member: { productId: string }) => member.productId === link.product_id);
      assert.ok(originalMember);
      const material = original.materials.find(item => item.outputId === originalMember.outputId)!;
      assert.equal(packet.materials.length, 1);
      assert.equal(packet.materials[0].materialId, material.materialId);
      assert.equal(packet.materials[0].sha256, host.services.materials!.readOriginal(material.materialId).sha256);
      assert.equal(packet.snapshotId, final.snapshot_id);
      const read = await host.services.r1Runtime!.client.fixedRead(String(final.snapshot_id), String(link.product_id));
      const rows = read.result.rows as { record_ref: { revision_id: string }; row: { values: Record<string, { value: string }> } }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.record_ref.revision_id, link.record_version);
      assert.equal(rows[0]!.row.values.close!.value, '11.42');
    }
    const originalLinks = host.database.connection.prepare('SELECT * FROM r1_record_associations WHERE snapshot_id=?').all(String(prior.snapshot_id));
    assert.equal(originalLinks.length, 2);
    for (const link of originalLinks) await assert.rejects(
      host.services.r1Workspace!.recordEvidence({ datasetId: link.dataset_id, productId: link.product_id,
        recordId: link.record_id, recordVersion: link.record_version }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'USAGE_KNOWN_ISSUE_LEGACY');
    const taskCount = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    await host.close(); host = await openFullChainHost(fixture, fixture.root);
    const replay = await host.call(base);
    const recoverDenied = await host.call(base + '/recover', { requestId: 'joint-recover' }, 409);
    assert.equal(recoverDenied.code, 'CORRECTION_STATE');
    assert.equal(replay.state, 'resolved', JSON.stringify(replay));
    assert.deepEqual(await current(), final);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, taskCount);
    assert.deepEqual(readFileSync(join(legacyStore, 'catalog/state.json')), legacyState);
  } finally { await host.close(); }
});

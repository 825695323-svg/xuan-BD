import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { Server } from 'node:http';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { R1PrepareInput, R1RequestView, R1TabularMapping, R1ScalarMapping } from '../../contracts/r1-contracts.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { readConnectionRegistry } from '../../platform/config/connections.js';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { WfdProductMachineClient, WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { parseProductMachineConnectionProfile, resolveProductMachineConnection } from '../../modules/financial/product-machine-connection.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createR1HandoffRuntime } from '../../modules/collection/r1-runtime.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createApplicationServices } from './services.js';
import { createApp } from './app.js';
import { contrastRatio, openIsolatedBrowser } from './r1-browser-test-support.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const productRoot = join(codeRoot, 'wfd/product');
const python = process.env.WFD_PYTHON;
const browserPath = process.env.XUAN_TEST_BROWSER;
const browserDigest = process.env.XUAN_TEST_BROWSER_SHA256;
const webRoot = process.env.XUAN_TEST_WEB_ROOT;
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'isolated test; model disabled' };
const backend: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('No model calls in R1 tests'); } };
const raw = Buffer.from('business_key,value_decimal,start_utc,end_utc\nrow-1,12.30,2026-01-02T00:00:00Z,2026-01-03T00:00:00Z\nrow-2,13.40,2026-01-03T00:00:00Z,2026-01-04T00:00:00Z\n');
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function fixture(machine = false, units: Record<string, { dimension: string }> = { count: { dimension: 'quantity' } }) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'xuan-r1-http-')));
  const runtime = join(root, 'bd'), identity = 'isolated-r1-web-test'; mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'file' | 'directory' }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path); resources[name] = { path, kind: 'directory' };
  }
  const configPath = join(runtime, 'config/r1-machine.json'), registryPath = join(runtime, 'config/connections.json');
  const store = join(root, 'wfd-store'), wfdRuntime = join(root, 'wfd-runtime');
  if (machine) {
    assert.ok(python, 'Explicit WFD_PYTHON required'); mkdirSync(store); mkdirSync(wfdRuntime);
    const initialization = spawnSync(python, isolatedPythonArgs(join(root, 'initialization-cache'), ['-c', 'from pathlib import Path; import sys; sys.path.insert(0, sys.argv[3]); from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator; WFDDuckDBPrototype.initialize_new(Path(sys.argv[1]),load_protocol_validator(Path(sys.argv[3])/"protocol"),runtime_root=Path(sys.argv[2]),sandbox=False,writer_host="r1-web-test"); import json; print(json.dumps({"isolated":sys.flags.isolated,"ignore_environment":sys.flags.ignore_environment,"no_user_site":sys.flags.no_user_site,"dont_write_bytecode":sys.flags.dont_write_bytecode,"pycache_prefix":sys.pycache_prefix,"source_root":str(Path(__import__("wfd_sdk").__file__).resolve().parent.parent)}))', store, wfdRuntime, productRoot]),
      { cwd: root, encoding: 'utf8', timeout: 30_000, env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: productRoot, PYTHONPYCACHEPREFIX: join(root, 'initialization-cache') } });
    json(join(root, 'python-initialization.json'), { status: initialization.status,
      stdout: initialization.stdout, stderr: initialization.stderr });
    assert.equal(initialization.status, 0, initialization.stderr);
    const flags = JSON.parse(initialization.stdout.trim());
    assert.equal(flags.isolated, 1, 'HTTP fixture initialization requires Python isolated mode.');
    assert.equal(flags.ignore_environment, 1); assert.equal(flags.no_user_site, 1);
    assert.equal(flags.dont_write_bytecode, 1);
    assert.equal(flags.pycache_prefix, join(root, 'initialization-cache'));
    assert.equal(flags.source_root, realpathSync(productRoot));
    json(configPath, { protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only', connection_id: 'r1-web-test',
      store, runtime: wfdRuntime, project_root: productRoot, protocol_root: join(productRoot, 'protocol'),
      caller: { caller_id: 'r1-web-test', trusted_actor_namespace: 'r1.web.test', roles: ['read', 'register', 'submit', 'publish'] },
      units, sources: {}, limits: {} });
    json(registryPath, { connections: [{ id: 'r1-web-test', kind: 'wfd-product-machine', mode: 'user_test', purpose: 'user_test',
      protocol: 'wfd.product-machine/0.1', config_path: configPath, store, runtime: wfdRuntime, python_path: python,
      entry_path: join(productRoot, 'wfd_sdk/product_machine.py'), harness_binding: { root: runtime, root_id: identity } }] });
    resources.connections_registry = { path: registryPath, kind: 'file' };
  }
  json(join(runtime, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity });
  json(join(runtime, 'config/machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity: identity, resources });
  return { root, runtime, configPath, registryPath, store, wfdRuntime };
}
async function host(f: ReturnType<typeof fixture>, webRoot?: string, materialEnvironment: 'synthetic-test' | 'local-review' = 'synthetic-test',
  r1ConnectionId: string | null = 'r1-web-test') {
  const database = new CoreDatabase(join(f.runtime, 'state/core.sqlite'));
  const core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'service', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/private'), resources: new ResourceBindings(f.runtime), r1ConnectionId: r1ConnectionId ?? undefined,
    materials: { environment: materialEnvironment } });
  let applicationCore = core, applicationServices = services;
  let personalDatabase: CoreDatabase | undefined, lifecycle: LocalDataLifecycle | undefined;
  if (webRoot) {
    personalDatabase = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
    applicationCore = new PersonalCore(backend, { database: personalDatabase });
    const dataId = 'isolated-r1-browser-data';
    lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(f.root, 'lifecycle.sqlite'), dataIdFromTask: () => dataId });
    lifecycle.register(dataId); lifecycle.bindIdentity(dataId, personalDatabase.path);
    assert.equal(lifecycle.assertPrivateAccess(1).dataId, dataId, 'Test host must wire its real lifecycle owner, not bypass the HTTP guard');
    applicationServices = createApplicationServices(applicationCore, personalDatabase, { health, projectRoot: f.runtime, codeRoot,
      privateRoot: join(f.runtime, 'state/personal-private'), resources: new ResourceBindings(f.runtime), workspaceServices: services,
      localData: { lifecycle, dataId, verify: async () => { throw new Error('No lifecycle changes in UI acceptance'); } } });
  }
  const server: Server = createApp(applicationCore, health, applicationServices, webRoot ? { webRoot } : { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/bd`;
  const call = async (path: string, body?: unknown, expected = 200) => {
    const response = await fetch(base + path, { headers: { ...(webRoot ? { 'x-local-data-generation': '1' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' } : {}) },
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  return { database, core, services, base, call, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await services.tasks.dispose();
    if (personalDatabase) { await applicationServices.tasks.dispose(); await applicationCore.dispose(); personalDatabase.close(); }
    await core.dispose(); database.close(); await lifecycle?.close();
  } };
}
async function settled(h: Awaited<ReturnType<typeof host>>, taskId: string): Promise<TaskRecord> {
  const terminal = (task: TaskRecord) => ['succeeded', 'failed', 'cancelled', 'needs_review', 'waiting_approval', 'blocked', 'interrupted'].includes(task.status);
  const current = h.services.tasks.get(taskId); if (terminal(current)) return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Task did not settle: ' + taskId)); }, 60_000);
    const unsubscribe = h.services.tasks.subscribe(({ task }) => { if (task.id === taskId && terminal(task)) { clearTimeout(timer); unsubscribe(); resolve(task); } });
  });
}
function input(requestId: string, planId: string, parent: string | null = null): R1PrepareInput & { mapping: R1ScalarMapping } {
  return { requestId, planId, outputId: 'scalar', source: { source_id: 'fixture-one', provider: 'synthetic-fixture',
    requested_url: 'https://source.example.test/input.csv', requested_at_utc: '2026-01-02T00:00:00Z', acquired_at_utc: '2026-01-02T00:01:00Z', license: 'synthetic-test', usage_scope: 'isolated-test',
    authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } },
    mapping: { businessKey: 'business_key', value: 'value_decimal', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC' },
    target: { datasetId: 'r1_web_test', outputKey: 'r1.web.metric', expectedParentSnapshotId: parent,
      subject: { kind: 'physical_object', namespace: 'r1.web.test', id: 'object_1' },
      definition: { semantic_code: 'r1.web.metric', measurement_nature: 'flow', unit_code: 'count', definition_authority: 'r1.web.test', time_role: 'observation',
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'closed' }, statistical: { price_basis: 'nominal', period_aggregation: 'period' } } },
      inputMode: 'partial_observation', coverage: { scope: { sample_only: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } } };
}
async function actualPlan(h: Awaited<ReturnType<typeof host>>, requestId: string, parent: string | null = null, purposeKnown = true, csv = raw) {
  const upload = await fetch(h.base + `/materials/upload?requestId=${requestId}-upload&name=fixture.csv&category=data`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' }, body: Buffer.from(csv.toString('utf8').replaceAll('row-', `${requestId}-row-`)) });
  assert.equal(upload.status, 202, await upload.clone().text());
  const uploaded = await upload.json(), materialTask = await settled(h, uploaded.jobId);
  assert.equal(materialTask.status, 'succeeded', JSON.stringify(materialTask.error));
  const material = h.services.materials!.getByTask(materialTask.id)!;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, key === 'purpose' && !purposeKnown
    ? { status: 'unknown', gap: 'Synthetic negative case: purpose has not been established' }
    : { status: 'known', value: `isolated ${key}`, evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: `isolated ${key}` }] }]));
  const draft = input(requestId, 'placeholder', parent);
  const planned = await h.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId: material.envelope.materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: 'scalar', materialIds: [material.envelope.materialId], intendedAction: 'publish',
      tables: [{ materialId: material.envelope.materialId, format: 'csv', types: { value_decimal: 'decimal_string' } }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping }, expectedSnapshotId: parent } }],
  } }, 202);
  const planTask = await settled(h, planned.jobId); assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
  const planId = h.services.processing!.getByTask(planTask.id)!.plan!.planId;
  const run = await h.call(`/processing/plans/${planId}/run`, { requestId: requestId + '-run' }, 202);
  const runTask = await settled(h, run.jobId); assert.equal(runTask.status, 'succeeded', JSON.stringify(runTask.error));
  const plan = h.services.processing!.get(planId);
  assert.equal(plan.version, 'bd-processing-plan/1', 'Processing version must come from the persisted frozen document');
  assert.equal(plan.outputs[0]!.publishEligible, purposeKnown, JSON.stringify(plan.outputs[0]));
  assert.ok(plan.steps.every(step => step.state === 'succeeded' || step.applicability === 'not_applicable'));
  return input(requestId, planId, parent);
}

test('BD naming replays keep original R1 digests and frozen identities without starting ready lookups',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON.' : false, timeout: 90000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      assert.equal((await h.call('/r1/check', {})).supported, true);
      const prepared: R1RequestView = await h.call('/r1/prepare', await actualPlan(h, 'bd-name-r1'), 201);
      const submitted = await h.call('/r1/requests/bd-name-r1/submit', { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'succeeded');
      const view: R1RequestView = await h.call('/r1/requests/bd-name-r1');
      assert.equal(view.state, 'associated'); assert.equal(view.rowCount, 2);
      const db = h.database.connection, row = db.prepare('SELECT binding_sha256 FROM r1_workspace_requests WHERE request_id=?').get(view.requestId)!;
      const versions = { r1Workspace: 'bd.r1-workspace/1', protocol: 'wfd.structured-ingest/1.0',
        connection: String(row.binding_sha256), document: view.documentSha256 };
      const records: Array<{ id: string; digest: unknown; events: ReturnType<typeof h.services.tasks.events> }> = [];
      for (const kind of ['recover', 'resume'] as const) {
        const lookupId = 'bd-name-' + kind;
        const args: Record<string, string> = kind === 'recover' ? { requestId: view.requestId } : { requestId: view.requestId, confirmationDigest: view.documentSha256 };
        const task = h.services.tasks.create({ title: kind === 'recover' ? 'R1：按原 identity 核对提交与固定读回' : 'R1：明确续办已受理的原文档',
          ownerRole: 'service', runtimeId: 'harness.r1-structured-ingest', action: 'data.r1.' + kind,
          args, requestId: `r1:${kind}:${lookupId}`, parentTaskId: submitted.jobId, versions });
        const digest = db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(task.id)!.input_digest;
        const events = h.services.tasks.events(task.id);
        db.prepare('UPDATE tasks SET runtime_id=? WHERE id=?').run('bd.r1-structured-ingest', task.id);
        const repeat = () => kind === 'recover' ? h.services.r1Workspace!.recover(view.requestId, lookupId)
          : h.services.r1Workspace!.resumeAccepted(view.requestId, lookupId, view.documentSha256);
        assert.equal((await repeat()).id, task.id); assert.equal(h.services.tasks.get(task.id).status, 'ready');
        assert.equal(h.services.tasks.getRuns(task.id).length, 0); assert.deepEqual(h.services.tasks.events(task.id), events);
        for (const [column, changed, original] of [
          ['args', JSON.stringify({ requestId: 'changed-original-request' }), JSON.stringify(args)],
          ['parent_task_id', task.id, submitted.jobId],
          ['versions', JSON.stringify({ ...versions, document: '0'.repeat(64) }), JSON.stringify(versions)],
        ]) {
          db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(changed, task.id);
          await assert.rejects(async () => repeat(), { code: 'REQUEST_CONFLICT' });
          db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(original, task.id);
        }
        db.prepare('UPDATE tasks SET status=? WHERE id=?').run('needs_review', task.id);
        assert.equal((await repeat()).status, 'needs_review'); assert.equal(h.services.tasks.getRuns(task.id).length, 0);
        assert.equal(db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(task.id)!.input_digest, digest);
        records.push({ id: task.id, digest, events });
      }
      await h.services.tasks.stopControl('isolated naming stop');
      await assert.rejects(h.services.r1Workspace!.recover(view.requestId, 'bd-name-recover'), { code: 'BD_STOPPED' });
      assert.throws(() => h.services.r1Workspace!.resumeAccepted(view.requestId, 'bd-name-resume', view.documentSha256), { code: 'BD_STOPPED' });
      for (const record of records) {
        assert.equal(h.services.tasks.getRuns(record.id).length, 0);
        assert.equal(db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(record.id)!.input_digest, record.digest);
      }
      json(join(f.root, 'bd-naming-r1-readback.json'), { originalR1RequestId: view.requestId, originalSubmitTaskId: submitted.jobId,
        documentSha256: view.documentSha256, state: view.state, rowCount: view.rowCount, replayTasks: records.map(({ id, digest }) => ({ id, digest })),
        readyReplayStarted: false, needsReviewReplayStarted: false, argsParentVersionConflictsRejected: true, stopCheckedBeforeReplay: true });
    } finally { await h.close(); }
  });

test('F01 actual service assembly injects processing; unconfigured Web cannot supply roots/permissions', async () => {
  const f = fixture(), h = await host(f);
  try {
    assert.ok(h.services.processing && h.services.r1Workspace);
    const caps = await h.call('/r1/capabilities'); assert.equal(caps.connection, null);
    const blocked = await h.call('/r1/prepare', { ...input('not-configured', 'missing'), runtime: '/tmp/override' }, 409);
    assert.equal(blocked.code, 'R1_WEB_INPUT');
    const missing = await h.call('/r1/prepare', input('not-configured', 'missing'), 409); assert.equal(missing.code, 'R1_NOT_CONFIGURED');
    const source = { ...input('assembly', 'missing').source, sha256: wfdSha256(raw), bytes: raw.byteLength };
    const original = h.services.r1!.registerOriginal({ bytes: raw, originalName: 'fixture.csv', source });
    const draft = { ...input('assembly', 'missing').target, namespace: 'r1.web.test', producerNamespace: 'r1.web.test', requestId: 'assembly', submissionDigest: 'sha256:' + '0'.repeat(64), payload: { kind: 'scalar_rows', rows: [] } };
    const digest = wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(draft)));
    assert.throws(() => h.services.r1!.prepare({ structured: draft, localRefs: { originalIds: [original.originalId], materialIds: [], sourceRefs: [source],
      processRefs: [{ process_id: 'invented', version: '1', plan_id: 'missing', output_id: 'scalar', input_sha256: source.sha256, output_sha256: digest, document_sha256: digest, evidence_sha256: digest }],
      evidenceRefs: [{ ref_id: 'fixture', kind: 'source', content_sha256: source.sha256 }] } }), (error: unknown) => (error as { code?: string }).code === 'R1_PROCESS_NOT_FOUND');
    assert.throws(() => h.services.r1!.prepare({ structured: draft, localRefs: { originalIds: [original.originalId], materialIds: [],
      sourceRefs: [{ ...source, usage_scope: 'unknown' }], processRefs: [], evidenceRefs: [] } }),
    (error: unknown) => (error as { code?: string }).code === 'R1_SOURCE_UNKNOWN');
    const cross = await fetch(h.base + '/r1/check', { method: 'POST', headers: { Origin: 'https://other.example.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(cross.status, 403);
  } finally { await h.close(); }
});

test('F05 real HTTP → processing → Python publish → fixed read → BD links; lost receipt recovers original task after restart',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON; no system interpreter or private config discovery.' : false, timeout: 180000 }, async t => {
    const f = fixture(true); let h = await host(f);
    try {
      const ready = await h.call('/r1/capabilities'); assert.equal(ready.connection.profile, 'data_only');
      const stopped = await h.services.tasks.stopControl('Synthetic HTTP profile STOP');
      const blockedCheck = await h.call('/r1/check', {}, 409);
      assert.equal(blockedCheck.code, 'BD_STOPPED');
      const stoppedCapabilities = await h.call('/r1/capabilities');
      assert.equal(stoppedCapabilities.connection.profile, 'data_only', 'Local capabilities remain readable while dispatch is stopped.');
      h.services.tasks.resumeControl(stopped.generation, 'Synthetic explicit HTTP profile resume');
      const profile = await h.call('/r1/check', {}); assert.equal(profile.supported, true);
      json(join(f.root, 'http-profile-stop-resume.json'), { actualHttp: true, actualPythonAfterResume: true,
        stoppedHttpStatus: 409, stoppedCode: blockedCheck.code, capabilitiesReadableWhileStopped: true,
        resumedProfileSupported: profile.supported });
      const unknownPurpose = await actualPlan(h, 'r1-purpose-unknown', null, false);
      const purposeBlocked = await h.call('/r1/prepare', unknownPurpose, 409); assert.equal(purposeBlocked.code, 'R1_PROCESS_NOT_READY');
      const firstInput = await actualPlan(h, 'r1-http-first');
      const changedTarget = await h.call('/r1/prepare', { ...firstInput, target: { ...firstInput.target, outputKey: 'silently-changed' } }, 409);
      assert.equal(changedTarget.code, 'R1_TARGET_CHANGED');
      h.database.connection.exec("CREATE TRIGGER test_r1_binding_failure BEFORE INSERT ON r1_workspace_requests BEGIN SELECT RAISE(ABORT,'INJECTED_WORKSPACE_BINDING_FAILURE'); END");
      await assert.rejects(() => h.services.r1Workspace!.prepareWithRestriction({ ...firstInput, requestId: 'r1-atomic-rollback' }), /INJECTED_WORKSPACE_BINDING_FAILURE/u);
      assert.equal(h.database.connection.prepare("SELECT count(*) n FROM r1_handoff_attempts WHERE request_id='r1-atomic-rollback'").get()!.n, 0);
      h.database.connection.exec('DROP TRIGGER test_r1_binding_failure');
      const first: R1RequestView = await h.call('/r1/prepare', firstInput, 201);
      assert.equal(first.rowCount, 2); assert.equal(first.previewRows[0]!.value_decimal, '12.3');
      assert.equal((await h.call('/r1/requests/r1-http-first')).state, 'prepared_profile_pending');
      const changed = await h.call('/r1/prepare', { ...firstInput, source: { ...firstInput.source, provider: 'changed' } }, 409); assert.equal(changed.code, 'R1_REQUEST_CONFLICT');
      const mismatch = await h.call('/r1/requests/r1-http-first/submit', { confirmationDigest: '0'.repeat(64) }, 409); assert.equal(mismatch.code, 'R1_CONFIRMATION_CHANGED');
      let unsubmittedStatusCalls = 0;
      const originalStatus = h.services.r1Runtime!.client.requestStatus.bind(h.services.r1Runtime!.client);
      h.services.r1Runtime!.client.requestStatus = async (...args) => { unsubmittedStatusCalls++; return originalStatus(...args); };
      try {
        const recoveryBlocked = await h.call('/r1/requests/r1-http-first/recover', { lookupId: 'http-before-first-submit' }, 409);
        assert.equal(recoveryBlocked.code, 'R1_NOT_SUBMITTED');
        assert.equal(unsubmittedStatusCalls, 0);
        const unchanged: R1RequestView = await h.call('/r1/requests/r1-http-first');
        assert.equal(unchanged.state, first.state); assert.equal(unchanged.submitTaskId, null);
        assert.equal(unchanged.documentSha256, first.documentSha256);
        json(join(f.root, 'http-unsubmitted-recovery.json'), { actualHttp: true, status: 409,
          code: recoveryBlocked.code, externalStatusCalls: unsubmittedStatusCalls,
          originalDocumentSha256: first.documentSha256, state: unchanged.state });
      } finally { h.services.r1Runtime!.client.requestStatus = originalStatus; }
      const beforeTaskCount = Number(h.database.connection.prepare('SELECT count(*) n FROM tasks').get()!.n);
      const beforeEventCount = Number(h.database.connection.prepare('SELECT count(*) n FROM task_events').get()!.n);
      h.database.connection.exec("CREATE TRIGGER test_r1_submit_binding_failure BEFORE UPDATE OF submit_task_id ON r1_workspace_requests BEGIN SELECT RAISE(ABORT,'INJECTED_SUBMIT_BINDING_FAILURE'); END");
      try {
        assert.throws(() => h.services.r1Workspace!.submit(first.requestId, first.documentSha256), /INJECTED_SUBMIT_BINDING_FAILURE/u);
        assert.equal(Number(h.database.connection.prepare('SELECT count(*) n FROM tasks').get()!.n), beforeTaskCount);
        assert.equal(Number(h.database.connection.prepare('SELECT count(*) n FROM task_events').get()!.n), beforeEventCount);
        assert.equal(h.services.r1Workspace!.get(first.requestId).submitTaskId, null);
        assert.equal(h.services.r1Workspace!.get(first.requestId).state, first.state);
        json(join(f.root, 'submit-task-binding-rollback.json'), { isolatedSqliteFault: true,
          taskCountUnchanged: true, eventCountUnchanged: true, submitTaskId: null, state: first.state });
      } finally { h.database.connection.exec('DROP TRIGGER test_r1_submit_binding_failure'); }
      let firstSubmitCalls = 0;
      const firstActualSubmit = h.services.r1Runtime!.client.submit.bind(h.services.r1Runtime!.client);
      h.services.r1Runtime!.client.submit = async (...args) => { firstSubmitCalls++; return firstActualSubmit(...args); };
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        h.call('/r1/requests/r1-http-first/submit', { confirmationDigest: first.documentSha256 }, 202)));
      const submitted = concurrent[0]!;
      assert.deepEqual([...new Set(concurrent.map(item => item.jobId))], [submitted.jobId]);
      const done = await settled(h, submitted.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      assert.equal(firstSubmitCalls, 1);
      const wrongReplay = await h.call('/r1/requests/r1-http-first/submit', { confirmationDigest: '0'.repeat(64) }, 409);
      assert.equal(wrongReplay.code, 'R1_CONFIRMATION_CHANGED');
      const afterWrongReplay: R1RequestView = await h.call('/r1/requests/r1-http-first');
      assert.equal(afterWrongReplay.submitTaskId, submitted.jobId);
      assert.equal(afterWrongReplay.documentSha256, first.documentSha256);
      assert.equal(afterWrongReplay.state, 'associated'); assert.equal(firstSubmitCalls, 1);
      h.services.r1Runtime!.client.submit = firstActualSubmit;
      json(join(f.root, 'http-concurrent-submit.json'), { actualHttp: true, actualPython: true,
        concurrentConfirmations: 4, uniqueTaskIds: [...new Set(concurrent.map(item => item.jobId))],
        actualClientSubmitCalls: firstSubmitCalls, taskStatus: done.status });
      const attemptReads = t.mock.method(h.services.r1!, 'attempt');
      const recent = await h.call('/r1/requests');
      assert.deepEqual(recent.items, [{ requestId: first.requestId, state: 'associated', rowCount: 2, errorCode: null }]);
      assert.equal(attemptReads.mock.callCount(), 0, 'Listing requests must not load full handoff evidence');
      const associated: R1RequestView = await h.call('/r1/requests/r1-http-first'); assert.equal(associated.state, 'associated');
      assert.equal(attemptReads.mock.callCount(), 1, 'A detail read must verify the frozen handoff only once');
      attemptReads.mock.restore();
      const associations = associated.local.associations as Record<string, unknown>[]; assert.equal(associations.length, 2);
      assert.ok(associations.every(row => row.record_id && row.record_version && row.snapshot_id));
      const snapshot = String(associations[0]!.snapshot_id);
      const secondInput = await actualPlan(h, 'r1-http-lost', snapshot);
      const second: R1RequestView = await h.call('/r1/prepare', secondInput, 201);
      const runtime = h.services.r1Runtime!, actualSubmit = runtime.client.submit.bind(runtime.client);
      runtime.client.submit = async (...args) => { const actual = await actualSubmit(...args); assert.equal(actual.result.state, 'published_formal', JSON.stringify(actual.result)); throw new WfdProductMachineError('TEST_LOST_RECEIPT', 'Injected disconnect after actual Python acceptance', { operation: 'submit', requestId: 'fault-injection', mayHaveBeenAccepted: true }); };
      const lost = await h.call('/r1/requests/r1-http-lost/submit', { confirmationDigest: second.documentSha256 }, 202);
      const unknown = await settled(h, lost.jobId); assert.equal(unknown.status, 'needs_review');
      assert.equal((await h.call('/r1/requests/r1-http-lost')).state, 'pending_unknown');
      runtime.client.submit = actualSubmit;
      const repeated = await h.call('/r1/requests/r1-http-lost/submit', { confirmationDigest: second.documentSha256 }, 202);
      assert.equal(repeated.jobId, lost.jobId); // no second external send.
      await h.close(); h = await host(f);
      h.services.r1Runtime!.client.submit = async () => { throw new Error('Recovery must not resubmit'); };
      const restored: R1RequestView = await h.call('/r1/requests/r1-http-lost');
      assert.equal(restored.state, 'pending_unknown'); assert.equal(restored.submitTaskId, lost.jobId);
      const recovered = await h.call('/r1/requests/r1-http-lost/recover', { lookupId: 'after-restart' }, 202);
      assert.equal(recovered.jobId, lost.jobId);
      assert.equal(h.services.tasks.get(lost.jobId).status, 'succeeded');
      const final: R1RequestView = await h.call('/r1/requests/r1-http-lost'); assert.equal(final.state, 'associated');
      assert.equal((final.local.associations as unknown[]).length, 2);
      assert.equal(final.documentSha256, second.documentSha256); assert.deepEqual(final.connection, second.connection);
      // Current profile/config changes never retarget even an existing successful request's recovery.
      const config = readFileSync(f.configPath, 'utf8'); writeFileSync(f.configPath, config + ' ');
      const drift = await h.call('/r1/requests/r1-http-lost/recover', { lookupId: 'changed-config' }, 409); assert.equal(drift.code, 'R1_CONNECTION_BINDING_CHANGED');
      assert.equal((await h.call('/r1/requests/r1-http-lost')).state, 'associated');
      writeFileSync(f.configPath, config);
      const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
      const replacementConfig = join(f.runtime, 'config/replaced-machine.json'); writeFileSync(replacementConfig, config, { flag: 'wx', mode: 0o600 });
      registry.connections[0].config_path = replacementConfig; writeFileSync(f.registryPath, JSON.stringify(registry));
      const staleClient = await h.call('/r1/capabilities'); assert.equal(staleClient.connection, null);
      const cannotRebind = await h.call('/r1/requests/r1-http-lost/recover', { lookupId: 'registry-rebound' }, 409);
      assert.equal(cannotRebind.code, 'R1_CONNECTION_RELOAD_REQUIRED');
      assert.equal((await h.call('/r1/requests/r1-http-lost')).state, 'associated');
    } finally { await h.close(); }
  });

test('F09 actual HTTP persists a verified Python page, restarts and resumes the original task without resubmission',
  { skip: !python ? 'Explicit WFD_PYTHON required; no personal connection discovery.' : false, timeout: 180000 }, async () => {
    assert.ok(process.env.PYTHONPYCACHEPREFIX, 'Source-proof HTTP tests require a fresh Python read-cache prefix (provided by test-local)');
    const f = fixture(true); let h = await host(f);
    try {
      const csv = Buffer.from('business_key,value_decimal,start_utc,end_utc\n' + Array.from({ length: 300 }, (_, i) =>
        `row-${String(i).padStart(4, '0')},12.30,2026-01-02T00:00:00Z,2026-01-03T00:00:00Z\n`).join(''));
      const draft = await actualPlan(h, 'r1-paged-http', null, true, csv);
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      assert.equal(prepared.rowCount, 300);
      const client = h.services.r1Runtime!.client, readPage = client.fixedReadPage.bind(client);
      let actualFirstPage: Record<string, unknown> | null = null;
      client.fixedReadPage = async (options, signal) => {
        if (options.cursor) throw new Error('TEST_AFTER_FIRST_REAL_FIXED_PAGE');
        const value = await readPage(options, signal); actualFirstPage = value.result;
        assert.equal((value.result.rows as unknown[]).length, 256); return value;
      };
      client.fixedRead = async () => { throw new Error('Paged mode cannot fall back to an unbounded product read'); };
      const submitted = await h.call('/r1/requests/r1-paged-http/submit', { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'needs_review');
      assert.ok(actualFirstPage, 'First page must come from actual Python, not a fabricated receipt');
      const pending: R1RequestView = await h.call('/r1/requests/r1-paged-http');
      assert.equal(pending.state, 'pending_receipt'); assert.equal((pending.local.associations as unknown[]).length, 0);
      assert.equal((pending.local.readback as Record<string, unknown>).verifiedRows, 256);
      const checkpoint = h.database.connection.prepare('SELECT state_json FROM r1_readback_checkpoints WHERE request_id=?').get(prepared.requestId)!;
      const expectedCursor = JSON.parse(String(checkpoint.state_json)).cursor; assert.equal(typeof expectedCursor, 'string');
      json(join(f.root, 'first-real-page.json'), actualFirstPage);
      await h.close(); h = await host(f);
      const resumed = h.services.r1Runtime!.client, actualRead = resumed.fixedReadPage.bind(resumed);
      const resumedCursors: Array<string | null> = [];
      resumed.submit = async () => { throw new Error('Recovery cannot submit again'); };
      resumed.fixedRead = async () => { throw new Error('Recovery cannot change the frozen read mode'); };
      resumed.fixedReadPage = async (options, signal) => { resumedCursors.push(options.cursor ?? null); return actualRead(options, signal); };
      h.database.connection.prepare('UPDATE r1_readback_checkpoints SET state_json=? WHERE request_id=?')
        .run(String(checkpoint.state_json) + ' ', prepared.requestId);
      await assert.rejects(h.services.r1Workspace!.recover(prepared.requestId, 'damaged-checkpoint'),
        (error: unknown) => (error as { code?: string }).code === 'R1_READBACK_CHECKPOINT_CHANGED');
      assert.equal(resumedCursors.length, 0);
      const damaged = await h.call('/r1/requests/r1-paged-http', undefined, 409);
      assert.equal(damaged.code, 'R1_READBACK_CHECKPOINT_CHANGED');
      const binding = h.database.connection.prepare('SELECT submit_task_id FROM r1_workspace_requests WHERE request_id=?').get(prepared.requestId)!;
      assert.equal(binding.submit_task_id, submitted.jobId);
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_record_associations WHERE request_id=?').get(prepared.requestId)!.n, 0);
      h.database.connection.prepare('UPDATE r1_readback_checkpoints SET state_json=? WHERE request_id=?')
        .run(String(checkpoint.state_json), prepared.requestId);
      json(join(f.root, 'checkpoint-corruption-rejection.json'), { isolatedCheckpointFault: true,
        changedBytesOnly: true, rejectedCode: 'R1_READBACK_CHECKPOINT_CHANGED',
        externalPageReadsBeforeRestore: resumedCursors.length, associationsBeforeRestore: 0,
        originalTaskId: submitted.jobId, originalCheckpointBytesRestored: true });
      const savedPageReader = resumed.fixedReadPage;
      resumed.fixedReadPage = async (options, signal) => {
        const response = await savedPageReader(options, signal);
        const integrity = response.result.integrity as Record<string, unknown>;
        integrity.manifest_digest = integrity.manifest_digest === 'sha256:' + '0'.repeat(64)
          ? 'sha256:' + '1'.repeat(64) : 'sha256:' + '0'.repeat(64);
        return response;
      };
      await assert.rejects(h.services.r1Workspace!.recover(prepared.requestId, 'changed-page-manifest'),
        (error: unknown) => (error as { code?: string }).code === 'R1_READBACK_MANIFEST_CHANGED');
      assert.deepEqual(resumedCursors, [expectedCursor]);
      assert.equal(h.database.connection.prepare('SELECT state_json FROM r1_readback_checkpoints WHERE request_id=?').get(prepared.requestId)!.state_json, checkpoint.state_json);
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_record_associations WHERE request_id=?').get(prepared.requestId)!.n, 0);
      resumed.fixedReadPage = savedPageReader; resumedCursors.length = 0;
      json(join(f.root, 'page-manifest-rejection.json'), { actualPythonPage: true,
        injectedManifestOnly: true, rejectedCode: 'R1_READBACK_MANIFEST_CHANGED',
        checkpointUnchanged: true, associations: 0, originalCursorPreserved: expectedCursor });
      const recovery = await h.call('/r1/requests/r1-paged-http/recover', { lookupId: 'resume-saved-page' }, 202);
      assert.equal(recovery.jobId, submitted.jobId); assert.equal(h.services.tasks.get(submitted.jobId).status, 'succeeded');
      assert.deepEqual(resumedCursors, [expectedCursor]);
      const complete: R1RequestView = await h.call('/r1/requests/r1-paged-http');
      assert.equal(complete.state, 'associated'); assert.equal(complete.documentSha256, prepared.documentSha256);
      assert.deepEqual(complete.connection, prepared.connection);
      assert.equal((complete.local.associations as unknown[]).length, 300);
      assert.deepEqual(complete.local.readback, { mode: 'page', verifiedRows: 300, pages: 2, complete: true, hasMore: false });
      json(join(f.root, 'paged-recovery-result.json'), { syntheticInput: true, mockedContracts: false, requestId: prepared.requestId,
        originalTaskId: submitted.jobId, resumedTaskId: recovery.jobId, firstPageRows: 256, resumedCursors,
        associations: complete.local.associations, readback: complete.local.readback, noResubmit: true,
        pythonReadCachePrefix: process.env.PYTHONPYCACHEPREFIX, verificationProjectionOnly: true, productionAcceptance: false });
    } finally { await h.close(); }
  });

test('F05 explicit UTC fraction forms remain exact; invalid calendar dates and non-UTC offsets are never guessed',
  { skip: !python ? 'Explicit WFD_PYTHON required for the actual processing/HTTP fixture.' : false, timeout: 60000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      for (const fraction of ['', '.0', '.00', '.000', '.1', '.12', '.123']) {
        const draft = await actualPlan(h, 'r1-utc-' + (fraction.replace('.', '') || 'plain'), null, true,
          Buffer.from(raw.toString('utf8').replaceAll('T00:00:00Z', `T00:00:00${fraction}Z`)));
        const view: R1RequestView = await h.call('/r1/prepare', draft, 201);
        assert.equal((view.previewRows[0]!.observation_time as Record<string, unknown>).earliest_utc, `2026-01-02T00:00:00${fraction}Z`);
      }
      for (const [name, csv] of [['calendar', raw.toString('utf8').replaceAll('2026-01-02', '2026-02-30')],
        ['offset', raw.toString('utf8').replaceAll('T00:00:00Z', 'T00:00:00+08:00')]] as const) {
        const draft = await actualPlan(h, `r1-utc-invalid-${name}`, null, true, Buffer.from(csv));
        const rejected = await h.call('/r1/prepare', draft, 409); assert.equal(rejected.code, 'R1_WEB_TIME');
      }
      const sourceDraft = await actualPlan(h, 'r1-source-utc-template');
      const originalsBefore = h.database.connection.prepare('SELECT count(*) n FROM r1_originals').get()!.n;
      for (const [name, value] of [['rollover', '2026-02-30T00:00:00Z'], ['submillisecond', '2026-01-02T00:00:00.0001Z']] as const) {
        const rejected = await h.call('/r1/prepare', { ...sourceDraft, requestId: `r1-source-utc-invalid-${name}`,
          source: { ...sourceDraft.source, requested_at_utc: value, acquired_at_utc: value } }, 409);
        assert.equal(rejected.code, 'R1_SOURCE_TIME');
      }
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_originals').get()!.n, originalsBefore);
    } finally { await h.close(); }
  });

test('F05 real isolated browser page creates plan, processes material, confirms exact R1 document and displays actual row links',
  { skip: !(python && browserPath && browserDigest && webRoot) ? 'Optional UI acceptance requires explicit Python, existing browser+SHA256 and built webRoot; no browser download or personal profile discovery.' : false, timeout: 180000 }, async () => {
    assert.equal(wfdSha256(readFileSync(browserPath!)), browserDigest, 'Selected browser must match its explicitly supplied binding digest');
    const f = fixture(true), h = await host(f, webRoot!); let browser: Awaited<ReturnType<typeof openIsolatedBrowser>> | undefined;
    try {
      browser = await openIsolatedBrowser(browserPath!, f.root);
      const b = browser, url = h.base.replace('/api/bd', '/');
      await b.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      await b.page('Page.bringToFront');
      await b.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await b.page('Page.navigate', { url });
      await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'Actual application did not expose a ready R1 page through its real lifecycle gate');
      assert.equal(await b.evaluate(`document.querySelector('.r1-panel .error-note')?.textContent??null`), null);
      const screenshot = async (name: string) => { const image = await b.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(f.root, name), Buffer.from(image.data, 'base64'), { flag: 'wx' }); };
      await screenshot('r1-ui-light-form.png');
      const materialPath = join(f.root, 'browser-source.csv'); writeFileSync(materialPath, raw, { flag: 'wx' });
      const document = await b.page('DOM.getDocument'); const node = await b.page('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.r1-panel input[type=file]' });
      await b.page('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [materialPath] });
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false' && !!document.querySelector('.r1-panel .database-receipt code')`, 'Real material upload did not return a task');
      await b.click('刷新状态');
      const materialId = await b.evaluate<string>(`document.querySelector('.r1-panel select option:nth-child(2)')?.value`); assert.ok(materialId);
      await b.fill('已有材料（仅最近 50 份）', materialId);
      for (const label of ['材料角色', '信息性质', '业务对象', '对象与时间', '使用目的', '结构与粒度']) await b.fill(label, `Isolated synthetic operator fact: ${label}`);
      const mapping = input('browser-template', 'placeholder').mapping;
      for (const [label, value] of Object.entries({ '业务键列': mapping.businessKey, '十进制值列': mapping.value,
        '时间起点列（UTC）': mapping.earliestUtc, '时间开区间终点列（UTC）': mapping.latestExclusiveUtc, '来源时区': mapping.sourceTimezone })) await b.fill(label, value);
      const target = input('browser-template', 'placeholder').target; await b.fill('目标产品合同（JSON，高级）', JSON.stringify(target, null, 2));
      const declaration = input('browser-template', 'placeholder').source;
      for (const [label, value] of Object.entries({ '来源身份': declaration.source_id, '提供者': declaration.provider, '原始地址或 URI': declaration.requested_url,
        '请求时间（UTC）': declaration.requested_at_utc, '取得时间（UTC）': declaration.acquired_at_utc, '获准用途': declaration.usage_scope })) await b.fill(label, value);
      await b.fill('本次 R1 正式交接授权', declaration.authorization!.status);
      await b.fill('本次授权依据（最多 4096 字）', declaration.authorization!.basis!);
      const requestId = await b.evaluate<string>(`[...document.querySelectorAll('.r1-panel label')].find(e=>e.firstChild?.textContent==='本次原请求编号').querySelector('input').value`);
      await b.click('仅建立新 R1 加工计划');
      const refreshUntil = (predicate: string, message: string) => b.until(`(()=>{if(${predicate})return true; const button=[...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='刷新状态'&&!e.disabled);button?.click();return false;})()`, message);
      await refreshUntil(`!![...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='明确运行五步加工'&&!e.disabled)`, 'Actual processing plan was not made available');
      await b.click('明确运行五步加工');
      await refreshUntil(`!![...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='仅准备并预览，不提交'&&!e.disabled)`, 'Actual processing did not produce a publish-eligible output');
      await b.click('仅准备并预览，不提交');
      const documentConsent = `[...document.querySelectorAll('label.r1-confirm')].find(label => label.textContent.startsWith('我确认上述准确摘要'))?.querySelector('input')`;
      await b.until(`!!${documentConsent}`, 'Frozen document confirmation did not appear');
      assert.equal((await h.call(`/r1/requests/${requestId}`)).state, 'prepared_profile_pending');
      assert.equal(await b.evaluate(`!![...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='明确提交这份固定文档'&&e.disabled)`), true);
      await b.evaluate(`${documentConsent}.click()`);
      assert.equal(await b.evaluate(`${documentConsent}.checked`), true);
      await b.fill('已保存的 R1 请求编号', requestId);
      await b.click('仅读取本地回链');
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false' && !!${documentConsent}`, 'Prepared request reread did not settle');
      assert.equal(await b.evaluate(`${documentConsent}.checked`), false,
        'Rereading even the same frozen request must invalidate the previous human confirmation');
      assert.equal(await b.evaluate(`!![...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='明确提交这份固定文档'&&e.disabled)`), true);
      const reread = await h.call(`/r1/requests/${requestId}`);
      assert.equal(reread.state, 'prepared_profile_pending');
      assert.equal(reread.submitTaskId, null, 'Local reread must not create a submit task');
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n, 1,
        'Local reread must preserve the sole prepared attempt, not create another');
      await b.evaluate(`${documentConsent}.click()`);
      await b.page('Page.reload', { ignoreCache: true });
      await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'Reloaded application did not expose R1');
      await b.fill('已保存的 R1 请求编号', requestId);
      const beforeReloadLookup = b.requests.length;
      await b.click('仅读取本地回链');
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false' && !!${documentConsent}`, 'Prepared request did not restore after page reload');
      assert.equal(await b.evaluate(`${documentConsent}.checked`), false);
      assert.equal((await h.call(`/r1/requests/${requestId}`)).submitTaskId, null);
      const restoredRequests = b.requests.slice(beforeReloadLookup).filter(request => new URL(request.url).pathname.startsWith('/api/bd/r1/'));
      assert.ok(restoredRequests.some(request => new URL(request.url).pathname.endsWith('/' + requestId)));
      assert.ok(restoredRequests.every(request => request.method === 'GET'), 'Restoring a prepared page must use local GET only');
      await b.evaluate(`${documentConsent}.click()`); await b.click('明确提交这份固定文档');
      await refreshUntil(`!!document.querySelector('.r1-success')`, 'Page did not display actual fixed readback and BD association');
      const final: R1RequestView = await h.call(`/r1/requests/${requestId}`); assert.equal(final.state, 'associated');
      const rows = final.local.associations as Record<string, unknown>[]; assert.equal(rows.length, 2); assert.ok(rows.every(row => row.snapshot_id && row.record_id && row.record_version));
      await b.until(`!![...document.querySelectorAll('.r1-panel .database-row--button')].find(e=>e.textContent.includes(${JSON.stringify(requestId)})&&e.textContent.includes('WFD 已正式发布且固定读回并回链'))`, 'Recent request row contradicted the completed detail state');
      await b.page('Page.reload', { ignoreCache: true });
      await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'Completed page did not reload');
      await b.fill('已保存的 R1 请求编号', requestId);
      const beforeCompletedLookup = b.requests.length;
      await b.click('仅读取本地回链');
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false'&&!!document.querySelector('.r1-success')`, 'Completed request was not restored');
      const completedReloadRequests = b.requests.slice(beforeCompletedLookup).filter(request => new URL(request.url).pathname.startsWith('/api/bd/r1/'));
      assert.ok(completedReloadRequests.some(request => new URL(request.url).pathname.endsWith('/' + requestId)));
      assert.ok(completedReloadRequests.every(request => request.method === 'GET'));
      assert.equal(await b.evaluate(`!!${documentConsent}`), false);
      assert.deepEqual((await h.call(`/r1/requests/${requestId}`)).local.associations, rows);
      const beforeHistory = b.requests.length;
      await b.evaluate(`document.querySelector('.r1-panel .database-row--button').click()`);
      await b.until(`document.querySelector('.r1-panel').getAttribute('aria-busy')==='false'&&!!document.querySelector('.r1-success')`, 'History selection did not read the current local receipt');
      const historyReadRequests = b.requests.slice(beforeHistory).filter(request => new URL(request.url).pathname.startsWith('/api/bd/r1/'));
      assert.ok(historyReadRequests.some(request => new URL(request.url).pathname.endsWith('/' + requestId)));
      assert.ok(historyReadRequests.every(request => request.method === 'GET'), 'History selection must not submit or recover externally');
      assert.ok(b.requests.length < 2048, 'Browser request evidence exceeded its explicit budget');
      const rowLinks = `[...document.querySelectorAll('.r1-panel details')].find(d => d.querySelector('summary')?.textContent.includes('证据与逐行关联'))`;
      const rowLinkPanel = await b.evaluate<{ open: boolean; visible: boolean; text: string }>(`(()=>{const d=${rowLinks};d.querySelector('summary').click();const pre=d.querySelector('pre');d.scrollIntoView({block:'center'});pre.scrollTop=pre.scrollHeight;return {open:d.open,visible:pre.getClientRects().length>0,text:pre.innerText}})()`);
      assert.equal(rowLinkPanel.open && rowLinkPanel.visible, true);
      const renderedRowIdentities = rows.flatMap(row => [row.snapshot_id, row.record_id, row.record_version]);
      assert.ok(renderedRowIdentities.every(identity => rowLinkPanel.text.includes(String(identity))), 'Actual fixed row identities were missing from the visible details panel');
      await screenshot('r1-ui-row-links.png');
      await b.evaluate(`${rowLinks}.querySelector('summary').click()`);
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n, 1);
      assert.equal(await b.evaluate(`document.querySelectorAll('.r1-panel input:not([aria-label]):not(label input),.r1-panel textarea:not(label textarea),.r1-panel select:not(label select)').length`), 0);
      const themeMetrics: Record<string, unknown> = {};
      for (const theme of ['light', 'dark']) {
        await b.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await b.until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'Actual theme provider did not adopt system color scheme');
        await b.evaluate(`document.querySelector('.r1-success').scrollIntoView({block:'center'})`);
        const colors = await b.evaluate<{ primary: string; muted: string; background: string }>(`(()=>{const root=getComputedStyle(document.querySelector('.r1-stage'));const muted=getComputedStyle(document.querySelector('.r1-help'));return {primary:root.color,muted:muted.color,background:root.backgroundColor}})()`);
        assert.ok(contrastRatio(colors.primary, colors.background) >= 4.5, JSON.stringify(colors)); assert.ok(contrastRatio(colors.muted, colors.background) >= 4.5, JSON.stringify(colors));
        themeMetrics[theme] = colors; await screenshot(`r1-ui-${theme}-receipt.png`);
      }
      await b.page('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
      await b.evaluate(`document.querySelector('.r1-success').scrollIntoView({block:'center'})`);
      const overflow = await b.evaluate<string[]>(`[...document.querySelectorAll('.r1-panel input,.r1-panel select,.r1-panel textarea')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>innerWidth+1).map(e=>e.closest('label')?.firstChild?.textContent??e.tagName)`);
      assert.deepEqual(overflow, [], 'R1 controls overflow the 375px viewport'); await screenshot('r1-ui-dark-375px.png');
      assert.deepEqual(b.exceptions, [], 'Actual browser runtime exceptions'); assert.deepEqual(b.blockedRequests, [], 'Application attempted non-loopback traffic');
      json(join(f.root, 'browser-result.json'), { browserSha256: browserDigest, serverUrl: url, syntheticInput: true, mockedContracts: false,
        requestId, state: final.state, documentSha256: final.documentSha256, associations: rows, renderedRowIdentities,
        confirmationResetOnSameRequestReread: true, preparedReloadGetOnly: true,
        completedReloadGetOnly: true, rowIdentitiesPreservedAfterReload: true,
        preparedReloadRequests: restoredRequests, completedReloadRequests,
        recentAndDetailConsistent: true, historyReadRequests, themeMetrics, viewport375Overflow: overflow,
        pageExceptions: b.exceptions, applicationExternalRequests: b.blockedRequests, productionAcceptance: false });
      console.log('R1_BROWSER_EVIDENCE_ROOT=' + f.root);
    } finally { await browser?.close(); await h.close(); }
  });


function barInput(requestId: string, frequency: 'day' | 'minute', parent: string | null = null): R1PrepareInput {
  const mapping: R1TabularMapping = { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
    precision: frequency, sourceTimezone: 'Asia/Shanghai', fields: ['open','high','low','close','volume','amount'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' })),
    bar: { frequency, open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume', amount: 'amount' } };
  return { requestId, planId: 'pending', outputId: 'bars', source: { source_id: 'controlled-bar-fixture', provider: 'synthetic-test',
    requested_url: 'test:controlled-bars', requested_at_utc: '2026-01-06T09:00:00Z', acquired_at_utc: '2026-01-06T09:00:01Z',
    license: 'synthetic-test', usage_scope: 'isolated-test',
    authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } }, mapping,
    target: { datasetId: 'r1_web_test', outputKey: 'test.bars.' + frequency, expectedParentSnapshotId: parent,
      subject: { kind: 'instrument', namespace: 'r1.web.test', id: 'security_000001' }, inputMode: 'partial_observation',
      coverage: { scope: { synthetic_sample: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'test.bars.' + frequency, measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: 'r1.web.test', time_role: 'observation',
        field_definitions: ['open','high','low','close','volume','amount'].map((field_code, index) => ({ field_code, data_type: 'decimal',
          unit_code: index < 4 ? 'cny_per_share' : index === 4 ? 'share' : 'cny', measurement_nature: index < 4 ? 'stock' : 'flow', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency, interval: 'half_open', timezone: 'Asia/Shanghai' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' }, financial: { price_adjustment: { direction: 'raw' } } },
        field_semantic_context: { volume: { measurement: { aggregation: 'period_total' } }, amount: { measurement: { aggregation: 'period_total' } } } } } };
}
function barCsv(frequency: 'day' | 'minute', badHigh = false): Buffer {
  const start = frequency === 'day' ? '2026-01-04T16:00:00Z' : '2026-01-05T01:30:00Z';
  const end = frequency === 'day' ? '2026-01-05T16:00:00Z' : '2026-01-05T01:31:00Z';
  return Buffer.from(`key,start,end,open,high,low,close,volume,amount,state\n000001-${frequency},${start},${end},11.42,${badHigh ? '10' : '11.51'},11.41,11.50,100,1145,valid_value\n`);
}
async function barPlan(h: Awaited<ReturnType<typeof host>>, draft: R1PrepareInput, csv: Buffer, nature = 'direct-observation') {
  const response = await fetch(h.base + `/materials/upload?requestId=${draft.requestId}-upload&name=bars.csv&category=data`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-local-data-generation': '1' }, body: new Uint8Array(csv) });
  assert.equal(response.status, 202, await response.clone().text());
  const upload = await response.json(), intake = await settled(h, upload.jobId);
  assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
  const material = h.services.materials!.getByTask(intake.id)!;
  const facts = { role: 'financial-record', informationNature: nature, businessObject: 'market_bars',
    objectTime: 'instrument security_000001; explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
    evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: facts[key] }] }]));
  const task = await h.call('/processing/plans', { requestId: draft.requestId + '-plan', input: {
    routing: { materials: [{ materialId: material.envelope.materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: draft.outputId, materialIds: [material.envelope.materialId], intendedAction: 'publish',
      tables: [{ materialId: material.envelope.materialId, format: 'csv', types: Object.fromEntries(['open','high','low','close','volume','amount'].map(key => [key, 'decimal_string'])) }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping, source: draft.source }, expectedSnapshotId: draft.target.expectedParentSnapshotId } }],
  } }, 202);
  const planned = await settled(h, task.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = h.services.processing!.getByTask(planned.id)!.plan!.planId;
  const run = await h.call(`/processing/plans/${planId}/run`, { requestId: draft.requestId + '-run' }, 202);
  const completed = await settled(h, run.jobId); assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  return { input: { ...draft, planId }, plan: h.services.processing!.get(planId) };
}

async function explicitTablePlan(h: Awaited<ReturnType<typeof host>>, draft: R1PrepareInput & { mapping: R1TabularMapping },
  csv: Buffer, role: string, nature = 'direct-observation') {
  const uploaded = await fetch(h.base + `/materials/upload?requestId=${draft.requestId}-upload&name=table.csv&category=data`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-local-data-generation': '1' },
    body: new Uint8Array(csv) });
  assert.equal(uploaded.status, 202, await uploaded.clone().text());
  const receipt = await uploaded.json(), intake = await settled(h, receipt.jobId);
  assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
  const material = h.services.materials!.getByTask(intake.id)!;
  const facts = { role, informationNature: nature, businessObject: 'explicit_table',
    objectTime: 'fixed subject and explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
    evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: facts[key] }] }]));
  const fields = draft.target.definition.field_definitions as { field_code: string; data_type: string }[];
  const types = Object.fromEntries(fields.map(field => [field.field_code,
    field.data_type === 'decimal' ? 'decimal_string' : field.data_type === 'integer' ? 'safe_integer' : field.data_type === 'boolean' ? 'boolean' : 'string']));
  const created = await h.call('/processing/plans', { requestId: draft.requestId + '-plan', input: {
    routing: { materials: [{ materialId: material.envelope.materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: draft.outputId, materialIds: [material.envelope.materialId], intendedAction: 'publish',
      tables: [{ materialId: material.envelope.materialId, format: 'csv', types }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping,
        source: draft.source }, expectedSnapshotId: draft.target.expectedParentSnapshotId } }],
  } }, 202);
  const planned = await settled(h, created.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = h.services.processing!.getByTask(planned.id)!.plan!.planId;
  const run = await h.call(`/processing/plans/${planId}/run`, { requestId: draft.requestId + '-run' }, 202);
  const completed = await settled(h, run.jobId); assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  return { input: { ...draft, planId }, plan: h.services.processing!.get(planId) };
}

test('data line keeps structure separate from financial quality and source qualification', async () => {
  const f = fixture(), h = await host(f); let closed = false;
  try {
    for (const variant of ['bad-ohlc', 'forecast', 'unfinished-minute', 'unknown-field-unit'] as const) {
      const frequency = variant === 'unfinished-minute' ? 'minute' : 'day';
      const draft = barInput('quality-' + variant, frequency);
      if (variant === 'unfinished-minute') {
        draft.source.requested_at_utc = '2026-01-05T01:30:00Z'; draft.source.acquired_at_utc = '2026-01-05T01:30:20Z';
      }
      if (variant === 'unknown-field-unit') {
        (draft.target.definition.field_semantic_context as Record<string, Record<string, Record<string, unknown>>>).volume!.measurement!.unit_code = 'unknown';
      }
      const result = await barPlan(h, draft, barCsv(frequency, variant === 'bad-ohlc'), variant === 'forecast' ? 'forecast' : 'direct-observation');
      const output = result.plan.outputs[0]!;
      assert.equal(output.state, 'structured', 'Row shape completion must remain separate from financial rules');
      assert.equal(output.publishEligible, false);
      assert.equal(output.routingState, 'needs_review');
      const semantic = output.semantic as { quality: string; gaps: string[] };
      assert.ok(['fail', 'indeterminate'].includes(semantic.quality)); assert.ok(semantic.gaps.length);
    }
    const result = await barPlan(h, barInput('quality-good', 'minute'), barCsv('minute'));
    assert.equal(result.plan.outputs[0]!.publishEligible, true);
    assert.equal((result.plan.outputs[0]!.semantic as { quality: string }).quality, 'pass');
    const before = result.plan.outputs[0]!.semantic;
    await h.close(); closed = true;
    const reopened = await host(f);
    try { assert.deepEqual(reopened.services.processing!.get(result.input.planId).outputs[0]!.semantic, before); }
    finally { await reopened.close(); }
  } finally { if (!closed) await h.close(); }
});

test('R1 scalar keeps legacy license text in BD without an admission gate; usage and handoff authorization still govern',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      const draft = await actualPlan(h, 'r1-source-gate');
      const client = h.services.r1Runtime!.client, realSubmit = client.submit.bind(client);
      let submitCalls = 0;
      client.submit = async (...args) => { submitCalls++; return realSubmit(...args); };
      const unknownUsage = await h.call('/r1/prepare', { ...draft, source: { ...draft.source, usage_scope: 'unknown' } }, 409);
      assert.equal(unknownUsage.code, 'R1_SOURCE_UNKNOWN');
      assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts WHERE request_id=?').get(draft.requestId)!.n, 0);
      for (const [suffix, license] of [['unknown', 'unknown'], ['denial-text', '明确无授权'], ['english-text', 'unlicensed'], ['absent', undefined]] as const) {
        const source = { ...draft.source };
        if (license === undefined) delete source.license;
        else source.license = license;
        const requestId = `${draft.requestId}-${suffix}`;
        const allowed: R1RequestView = await h.call('/r1/prepare', { ...draft, requestId, source }, 201);
        const frozen = JSON.parse(String(h.services.r1!.attempt(requestId).local_refs_json)).sourceRefs[0];
        assert.equal(frozen.license, license);
        assert.equal(allowed.state, 'prepared_profile_pending');
        assert.equal(submitCalls, 0);
      }
      for (const [suffix, source] of [
        ['legacy-word-in-usage', { ...draft.source, usage_scope: 'original package unlicensed; isolated-test' }],
        ['legacy-word-in-basis', { ...draft.source, authorization: { status: 'authorized' as const,
          basis: 'original package unlicensed; operator declared isolated test handoff' } }],
      ] as const) {
        const allowed: R1RequestView = await h.call('/r1/prepare', { ...draft, requestId: `${draft.requestId}-${suffix}`, source }, 201);
        assert.equal(allowed.state, 'prepared_profile_pending');
        assert.equal(submitCalls, 0);
      }
      for (const [authorization, expected] of [
        [{ status: 'unknown', basis: null }, 'R1_SOURCE_UNKNOWN'],
        [{ status: 'denied', basis: 'operator stated no formal import grant' }, 'R1_SOURCE_DENIED'],
        [{ status: ['authorized'], basis: 'operator stated isolated use' }, 'R1_SOURCE_UNKNOWN'],
        [{ status: 'authorized', basis: '无授权' }, 'R1_SOURCE_UNKNOWN'],
        [{ status: 'authorized', basis: 'none' }, 'R1_SOURCE_UNKNOWN'],
        [{ status: 'authorized', basis: 'n/a' }, 'R1_SOURCE_UNKNOWN'],
        [undefined, 'R1_SOURCE_UNKNOWN'],
      ] as const) {
        const source = { ...draft.source, authorization };
        const blocked = await h.call('/r1/prepare', { ...draft, source }, 409);
        assert.equal(blocked.code, expected);
        assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts WHERE request_id=?').get(draft.requestId)!.n, 0);
        assert.equal(submitCalls, 0);
      }
      for (const source of [
        { ...draft.source, usage_scope: '禁止正式入库' },
        { ...draft.source, authorization: { status: 'authorized', basis: '明确无授权' } },
        { ...draft.source, usage_scope: 'ingest prohibited' },
      ]) {
        const blocked = await h.call('/r1/prepare', { ...draft, source }, 409);
        assert.equal(blocked.code, 'R1_SOURCE_UNKNOWN');
        assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts WHERE request_id=?').get(draft.requestId)!.n, 0);
        assert.equal(submitCalls, 0);
      }
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      const submitted = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'succeeded');
      assert.equal(submitCalls, 1);
      const published: R1RequestView = await h.call(`/r1/requests/${draft.requestId}`);
      assert.equal(published.state, 'associated');
      assert.equal((published.local.associations as unknown[]).length, 2);
    } finally { await h.close(); }
  });

test('R1 old frozen source without authorization cannot first submit, while its pending identity can recover readback',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true); let h = await host(f);
    const oldShape = (requestId: string) => {
      const attempt = h.services.r1!.attempt(requestId);
      const refs = JSON.parse(String(attempt.local_refs_json));
      delete refs.sourceRefs[0].authorization;
      const refsJson = canonicalWfdJson(refs);
      h.database.connection.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?')
        .run(refsJson, wfdSha256(refsJson), requestId);
      const originalId = refs.originalIds[0];
      const original = h.database.connection.prepare('SELECT source_json FROM r1_originals WHERE original_id=?').get(originalId)!;
      const source = JSON.parse(String(original.source_json)); delete source.authorization;
      const sourceJson = canonicalWfdJson(source);
      h.database.connection.prepare('UPDATE r1_originals SET source_json=?,source_digest=? WHERE original_id=?')
        .run(sourceJson, wfdSha256(sourceJson), originalId);
      assert.equal(h.services.r1!.attempt(requestId).document_sha256, attempt.document_sha256);
    };
    try {
      const notSubmitted = await actualPlan(h, 'r1-old-source-prepared');
      const prepared: R1RequestView = await h.call('/r1/prepare', notSubmitted, 201);
      oldShape(prepared.requestId);
      let submitCalls = 0;
      const client = h.services.r1Runtime!.client, realSubmit = client.submit.bind(client);
      client.submit = async (...args) => { submitCalls++; return realSubmit(...args); };
      const blocked = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 409);
      assert.equal(blocked.code, 'R1_SOURCE_UNKNOWN'); assert.equal(submitCalls, 0);
      assert.equal((await h.call(`/r1/requests/${prepared.requestId}`)).submitTaskId, null);
      const submittedDraft = await actualPlan(h, 'r1-old-source-pending');
      const second: R1RequestView = await h.call('/r1/prepare', submittedDraft, 201);
      client.submit = async (...args) => { const reply = await realSubmit(...args);
        assert.equal(reply.result.state, 'published_formal');
        throw new WfdProductMachineError('TEST_OLD_SOURCE_LOST_RECEIPT', 'Injected lost receipt after real Python publication',
          { operation: 'submit', requestId: submittedDraft.requestId, mayHaveBeenAccepted: true }); };
      const submitted = await h.call(`/r1/requests/${second.requestId}/submit`, { confirmationDigest: second.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'needs_review');
      oldShape(second.requestId);
      await h.close(); h = await host(f);
      h.services.r1Runtime!.client.submit = async () => { throw new Error('Old pending recovery cannot resubmit'); };
      const resumed = await h.call(`/r1/requests/${second.requestId}/recover`, { lookupId: 'old-source-original-identity' }, 202);
      assert.equal(resumed.jobId, submitted.jobId);
      assert.equal(h.services.tasks.get(submitted.jobId).status, 'succeeded');
      const final: R1RequestView = await h.call(`/r1/requests/${second.requestId}`);
      assert.equal(final.state, 'associated'); assert.equal((final.local.associations as unknown[]).length, 2);
      assert.equal(final.documentSha256, second.documentSha256);
    } finally { await h.close(); }
  });

test('R1 actual Python parent rejection is terminal and survives restart without status lookup or resubmit',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true); let h = await host(f);
    try {
      const draft = await actualPlan(h, 'r1-parent-rejected', 'r1-parent-does-not-exist');
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      const submitted = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      const failed = await settled(h, submitted.jobId);
      assert.equal(failed.status, 'failed', JSON.stringify(failed.error));
      assert.equal(failed.error?.code, 'R1_WFD_REJECTED');
      const rejected: R1RequestView = await h.call(`/r1/requests/${draft.requestId}`);
      assert.equal(rejected.state, 'rejected'); assert.equal(rejected.requiresRecovery, false);
      assert.equal((rejected.local.associations as unknown[]).length, 0);
      assert.equal((rejected.local.receipt as Record<string, unknown>).state, 'rejected');
      assert.ok(JSON.stringify(rejected.local.receipt).includes('PARENT_CHANGED'));
      assert.ok(JSON.stringify(rejected.error).includes('PARENT_CHANGED'));
      const effect = h.database.connection.prepare('SELECT status FROM task_effects WHERE id=?').get(`r1:${draft.requestId}`)!;
      assert.equal(effect.status, 'not_applied');
      await h.close(); h = await host(f);
      let statusCalls = 0, submitCalls = 0;
      h.services.r1Runtime!.client.requestStatusPage = async () => { statusCalls++; throw new Error('Terminal rejection cannot query status again'); };
      h.services.r1Runtime!.client.submit = async () => { submitCalls++; throw new Error('Terminal rejection cannot resubmit'); };
      const repeated = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal(repeated.jobId, submitted.jobId);
      const recovered = await h.call(`/r1/requests/${draft.requestId}/recover`, { lookupId: 'terminal-rejection' }, 202);
      assert.equal(recovered.jobId, submitted.jobId);
      assert.equal(h.services.tasks.get(submitted.jobId).status, 'failed');
      assert.equal(statusCalls, 0); assert.equal(submitCalls, 0);
      assert.equal((await h.call(`/r1/requests/${draft.requestId}`)).state, 'rejected');
    } finally { await h.close(); }
  });

test('R1 incomplete or partially published WFD replies remain pending for original identity recovery',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      const draft = await actualPlan(h, 'r1-nonterminal-replies');
      await h.call('/r1/prepare', draft, 201);
      const attempt = h.services.r1!.attempt(draft.requestId);
      const identity = (JSON.parse(String(attempt.document_json)) as Record<string, unknown>).request_identity;
      for (const result of [
        { state: 'publication_unknown', request_identity: identity, output_results: [] },
        { state: 'partially_committed_pending_head', request_identity: identity,
          output_results: [{ publication_state: 'published_formal' }] },
        { state: 'rejected', request_identity: identity,
          output_results: [{ publication_state: 'published_formal' }] },
      ]) {
        const held = await h.services.r1!.consumeResult(draft.requestId, result, h.services.r1Runtime!.client);
        assert.equal(held.state, 'pending_receipt');
        const view: R1RequestView = await h.call(`/r1/requests/${draft.requestId}`);
        assert.equal(view.requiresRecovery, true);
        assert.equal((view.local.associations as unknown[]).length, 0);
      }
    } finally { await h.close(); }
  });

test('R1 lost rejected receipt resolves the original task as failed through actual status after restart',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true); let h = await host(f);
    try {
      const draft = await actualPlan(h, 'r1-lost-rejection', 'r1-parent-does-not-exist');
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      const actualSubmit = h.services.r1Runtime!.client.submit.bind(h.services.r1Runtime!.client);
      h.services.r1Runtime!.client.submit = async (...args) => {
        const reply = await actualSubmit(...args);
        assert.equal(reply.result.state, 'rejected');
        throw new WfdProductMachineError('TEST_LOST_REJECTION', 'Injected lost WFD rejection receipt',
          { operation: 'submit', requestId: draft.requestId, mayHaveBeenAccepted: true });
      };
      const submitted = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'needs_review');
      assert.equal((await h.call(`/r1/requests/${draft.requestId}`)).state, 'pending_unknown');
      await h.close(); h = await host(f);
      h.services.r1Runtime!.client.submit = async () => { throw new Error('Recovery must not submit'); };
      const resolved = await h.call(`/r1/requests/${draft.requestId}/recover`, { lookupId: 'lost-rejection-first' }, 202);
      assert.equal(resolved.jobId, submitted.jobId);
      assert.equal(h.services.tasks.get(submitted.jobId).status, 'failed');
      const view: R1RequestView = await h.call(`/r1/requests/${draft.requestId}`);
      assert.equal(view.state, 'rejected'); assert.equal(view.requiresRecovery, false);
      assert.ok(JSON.stringify(view.local.receipt).includes('PARENT_CHANGED'));
      assert.equal(h.database.connection.prepare('SELECT status FROM task_effects WHERE id=?').get(`r1:${draft.requestId}`)!.status, 'not_applied');
      let statusCalls = 0;
      h.services.r1Runtime!.client.requestStatusPage = async () => { statusCalls++; throw new Error('Resolved rejection cannot query again'); };
      const repeated = await h.call(`/r1/requests/${draft.requestId}/recover`, { lookupId: 'lost-rejection-again' }, 202);
      assert.equal(repeated.jobId, submitted.jobId);
      assert.equal(statusCalls, 0);
    } finally { await h.close(); }
  });

test('R1 explicitly selected production registration works only with matching mode and purpose',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true);
    const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
    registry.connections[0].mode = 'production'; registry.connections[0].purpose = 'production';
    writeFileSync(f.registryPath, JSON.stringify(registry));
    const rawProfile = registry.connections[0], resources = new ResourceBindings(f.runtime);
    assert.throws(() => parseProductMachineConnectionProfile(rawProfile), /当前入口允许/u);
    assert.throws(() => resolveProductMachineConnection(resources, 'r1-web-test'), /当前入口允许/u);
    assert.equal(parseProductMachineConnectionProfile(rawProfile, { allowProduction: true }).mode, 'production');
    for (const mixed of [{ mode: 'production', purpose: 'user_test' }, { mode: 'user_test', purpose: 'production' }]) {
      assert.throws(() => parseProductMachineConnectionProfile({ ...rawProfile, ...mixed }, { allowProduction: true }), /当前入口允许/u);
    }
    let h = await host(f);
    try {
      const identity = (await h.call('/r1/capabilities')).connection;
      assert.equal(identity.mode, 'production'); assert.equal(identity.purpose, 'production');
      assert.equal(identity.profile, 'data_only'); assert.equal(identity.store, f.store);
      const draft = await actualPlan(h, 'r1-isolated-production');
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      assert.equal(prepared.connection.mode, 'production');
      const submitted = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'succeeded');
      assert.equal((await h.call(`/r1/requests/${draft.requestId}`)).state, 'associated');
    } finally { await h.close(); }
    registry.connections[0].mode = 'user_test'; registry.connections[0].purpose = 'user_test';
    writeFileSync(f.registryPath, JSON.stringify(registry));
    h = await host(f);
    try {
      const changed = await h.call('/r1/requests/r1-isolated-production/recover', { lookupId: 'production-binding-changed' }, 409);
      assert.equal(changed.code, 'R1_CONNECTION_BINDING_CHANGED');
      assert.equal((await h.call('/r1/requests/r1-isolated-production')).connection.mode, 'production');
    } finally { await h.close(); }
    registry.connections[0].mode = 'production'; registry.connections[0].purpose = 'production';
    writeFileSync(f.registryPath, JSON.stringify(registry));
    const negativeDatabase = new CoreDatabase(join(f.root, 'negative.sqlite'));
    try {
      const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
      config.profile = 'legacy'; writeFileSync(f.configPath, JSON.stringify(config));
      assert.throws(() => createR1HandoffRuntime({ resources, database: negativeDatabase, connectionId: 'r1-web-test' }),
        (error: unknown) => (error as { code?: string }).code === 'R1_PROFILE_REQUIRED');
      config.profile = 'data_only'; config.connection_id = 'r1-explicit-user-test';
      writeFileSync(f.configPath, JSON.stringify(config));
      registry.connections[0].id = 'r1-explicit-user-test'; writeFileSync(f.registryPath, JSON.stringify(registry));
      assert.throws(() => createR1HandoffRuntime({ resources, database: negativeDatabase }),
        (error: unknown) => (error as { code?: string }).code === 'R1_CONNECTION_NOT_SELECTED');
    } finally { negativeDatabase.close(); }
  });

test('R1 actual Web selects production through the bound manual ingest registry field',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true), registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
    registry.connections[0].mode = 'production'; registry.connections[0].purpose = 'production';
    const selected = { ...registry, manual_ingest_connection_id: 'r1-web-test' };
    for (const invalid of [
      { ...selected, manual_ingest_connection_id: 'missing-connection' },
      { ...selected, manual_ingest_connection_id: '../bad-path' },
      { ...selected, connections: [...selected.connections, { ...selected.connections[0] }] },
    ]) {
      writeFileSync(f.registryPath, JSON.stringify(invalid));
      assert.throws(() => readConnectionRegistry(f.registryPath));
    }
    writeFileSync(f.registryPath, JSON.stringify(selected));
    assert.equal(readConnectionRegistry(f.registryPath)?.manualIngestConnectionId, 'r1-web-test');
    const overrideRegistry = { ...selected, manual_ingest_connection_id: 'another-registered-id',
      connections: [...selected.connections, { ...selected.connections[0], id: 'another-registered-id' }] };
    writeFileSync(f.registryPath, JSON.stringify(overrideRegistry));
    const priorityDatabase = new CoreDatabase(join(f.root, 'priority.sqlite'));
    try {
      const explicit = createR1HandoffRuntime({ resources: new ResourceBindings(f.runtime), database: priorityDatabase,
        connectionId: 'r1-web-test' });
      assert.equal(explicit.connection.connectionId, 'r1-web-test');
      assert.equal(explicit.currentIdentity().mode, 'production');
    } finally { priorityDatabase.close(); }
    writeFileSync(f.registryPath, JSON.stringify(selected));
    let h = await host(f, undefined, undefined, null);
    try {
      const current = await h.call('/r1/capabilities');
      assert.equal(current.connection.mode, 'production'); assert.equal(current.connection.purpose, 'production');
      const draft = await actualPlan(h, 'r1-registry-selected-production');
      const prepared: R1RequestView = await h.call('/r1/prepare', draft, 201);
      const submitted = await h.call(`/r1/requests/${draft.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal((await settled(h, submitted.jobId)).status, 'succeeded');
      assert.equal((await h.call(`/r1/requests/${draft.requestId}`)).state, 'associated');
      writeFileSync(f.registryPath, JSON.stringify(registry));
      const changed = await h.call(`/r1/requests/${draft.requestId}/recover`, { lookupId: 'manual-selection-changed' }, 409);
      assert.equal(changed.code, 'R1_CONNECTION_RELOAD_REQUIRED');
    } finally { await h.close(); }
    const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
    config.connection_id = 'r1-explicit-user-test'; writeFileSync(f.configPath, JSON.stringify(config));
    registry.connections[0].id = 'r1-explicit-user-test';
    registry.connections[0].mode = 'user_test'; registry.connections[0].purpose = 'user_test';
    writeFileSync(f.registryPath, JSON.stringify(registry));
    h = await host(f, undefined, undefined, null);
    try {
      const unselected = await h.call('/r1/capabilities');
      assert.equal(unselected.connection, null);
      assert.match(unselected.configuration.reason, /明确选择/u);
      const frozen: R1RequestView = await h.call('/r1/requests/r1-registry-selected-production');
      assert.equal(frozen.connection.mode, 'production');
      const blocked = await h.call('/r1/requests/r1-registry-selected-production/recover', { lookupId: 'old-production-binding' }, 409);
      assert.equal(blocked.code, 'R1_NOT_CONFIGURED');
    } finally { await h.close(); }
  });

test('R1 registry-selected production admits qualified daily and minute bars and keeps rejected bars out of WFD',
  { skip: !python ? 'Explicit WFD_PYTHON required.' : false, timeout: 180000 }, async () => {
    const f = fixture(true, { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } });
    const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
    registry.connections[0].mode = 'production'; registry.connections[0].purpose = 'production';
    registry.manual_ingest_connection_id = 'r1-web-test'; writeFileSync(f.registryPath, JSON.stringify(registry));
    const h = await host(f, undefined, undefined, null);
    try {
      const connection = (await h.call('/r1/capabilities')).connection;
      assert.equal(connection.mode, 'production'); assert.equal(connection.purpose, 'production');
      assert.equal(connection.store, f.store); assert.equal(connection.profile, 'data_only');
      assert.equal((await h.call('/r1/check', {})).supported, true);
      const client = h.services.r1Runtime!.client;
      const realSubmit = client.submit.bind(client), realFixedRead = client.fixedRead.bind(client);
      const submittedStates: string[] = [], actualReads: Record<string, unknown>[] = [];
      client.submit = async (...args) => { const reply = await realSubmit(...args);
        submittedStates.push(String(reply.result.state)); return reply; };
      client.fixedRead = async (...args) => { const reply = await realFixedRead(...args);
        actualReads.push(reply.result); return reply; };
      for (const variant of ['bad-ohlc', 'unknown-unit', 'forecast', 'denied-authorization', 'unknown-auth', 'missing-auth', 'status-word-basis',
        'denial-basis', 'denial-scope', 'english-denial'] as const) {
        const draft = barInput('prod-block-' + variant, 'day');
        if (variant === 'denied-authorization') {
          draft.source.authorization = { status: 'denied', basis: 'operator stated no formal import grant' };
        }
        if (variant === 'unknown-auth') draft.source.authorization = { status: 'unknown', basis: null };
        if (variant === 'missing-auth') delete draft.source.authorization;
        if (variant === 'status-word-basis') draft.source.authorization = { status: 'authorized', basis: '未授权' };
        if (variant === 'denial-basis') draft.source.authorization = { status: 'authorized', basis: '明确无授权' };
        if (variant === 'denial-scope') draft.source.usage_scope = '禁止正式入库';
        if (variant === 'english-denial') draft.source.usage_scope = 'not authorized; ingest prohibited';
        if (variant === 'unknown-unit') {
          (draft.target.definition.field_semantic_context as Record<string, Record<string, Record<string, unknown>>>).volume!.measurement!.unit_code = 'unknown';
        }
        const built = await barPlan(h, draft, barCsv('day', variant === 'bad-ohlc'), variant === 'forecast' ? 'forecast' : 'direct-observation');
        assert.equal(built.plan.outputs[0]!.state, 'structured');
        assert.equal(built.plan.outputs[0]!.publishEligible, false);
        const blocked = await h.call('/r1/prepare', built.input, 409);
        assert.equal(blocked.code, variant === 'denied-authorization' ? 'R1_SOURCE_DENIED'
          : ['unknown-auth', 'missing-auth', 'status-word-basis', 'denial-basis', 'denial-scope', 'english-denial'].includes(variant)
            ? 'R1_SOURCE_UNKNOWN' : 'R1_PROCESS_NOT_READY');
        assert.equal(h.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts WHERE request_id=?').get(draft.requestId)!.n, 0);
        assert.equal(submittedStates.length, 0); assert.equal(actualReads.length, 0);
      }
      for (const [suffix, license] of [['unknown', 'unknown'], ['denial-text', '明确无授权'], ['absent', undefined]] as const) {
        const draft = barInput('prod-license-' + suffix, 'day');
        if (license === undefined) delete draft.source.license;
        else draft.source.license = license;
        const built = await barPlan(h, draft, barCsv('day'));
        assert.equal(built.plan.outputs[0]!.publishEligible, true);
        const prepared: R1RequestView = await h.call('/r1/prepare', built.input, 201);
        assert.equal(prepared.state, 'prepared_profile_pending');
        const frozen = JSON.parse(String(h.services.r1!.attempt(prepared.requestId).local_refs_json)).sourceRefs[0];
        assert.equal(frozen.license, license);
        assert.equal(submittedStates.length, 0);
      }
      let parent: string | null = null;
      for (const frequency of ['day', 'minute'] as const) {
        const built = await barPlan(h, barInput('prod-financial-' + frequency, frequency, parent), barCsv(frequency));
        assert.equal(built.plan.outputs[0]!.publishEligible, true);
        assert.equal((built.plan.outputs[0]!.semantic as { quality: string }).quality, 'pass');
        const prepared: R1RequestView = await h.call('/r1/prepare', built.input, 201);
        assert.equal(Object.keys(prepared.previewRows[0]!.values as object).length, 6);
        const frozenAttempt = h.services.r1!.attempt(prepared.requestId);
        assert.equal(String(frozenAttempt.document_json).includes('authorization'), false, 'WFD data_only document must not carry BD authorization');
        assert.equal(String(frozenAttempt.local_refs_json).includes('authorization'), true, 'BD source archive keeps the operator declaration');
        const wrong = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: '0'.repeat(64) }, 409);
        assert.equal(wrong.code, 'R1_CONFIRMATION_CHANGED');
        assert.equal(submittedStates.length, frequency === 'day' ? 0 : 1);
        const submission = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        assert.equal((await settled(h, submission.jobId)).status, 'succeeded');
        assert.equal(submittedStates.at(-1), 'published_formal');
        const view: R1RequestView = await h.call(`/r1/requests/${prepared.requestId}`);
        assert.equal(view.state, 'associated');
        const links = view.local.associations as Record<string, unknown>[];
        assert.equal(links.length, 1);
        const link = links[0]!;
        assert.ok(link.record_id && link.record_version && link.snapshot_id && link.product_id);
        const receipt = view.local.receipt as Record<string, unknown>;
        assert.deepEqual(Object.keys(receipt.contract_refs as object).sort(), ['algorithm_dependency','read_layout','semantic','update_release']);
        assert.ok((receipt.contract_bundle_ref as Record<string, unknown>).digest);
        const fixed = actualReads.at(-1)!;
        const fixedRows = fixed.rows as Record<string, unknown>[];
        assert.equal(fixedRows.length, 1);
        assert.equal(fixedRows[0]!.record_id, link.record_id);
        assert.equal(fixedRows[0]!.record_version, link.record_version);
        const fixedRow = fixedRows[0]!.row as Record<string, unknown>;
        assert.deepEqual(fixedRow.subject, built.input.target.subject);
        assert.deepEqual(fixedRow.values, prepared.previewRows[0]!.values);
        assert.equal(actualReads.length, frequency === 'day' ? 1 : 2);
        parent = String(link.snapshot_id);
      }
      const conflicted = await barPlan(h, barInput('prod-parent-conflict', 'day', 'r1-parent-does-not-exist'), barCsv('day'));
      const prepared: R1RequestView = await h.call('/r1/prepare', conflicted.input, 201);
      const readCount = actualReads.length;
      const submission = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      const failed = await settled(h, submission.jobId);
      assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'R1_WFD_REJECTED');
      assert.equal(submittedStates.at(-1), 'rejected'); assert.equal(actualReads.length, readCount);
      const view: R1RequestView = await h.call(`/r1/requests/${prepared.requestId}`);
      assert.equal(view.state, 'rejected'); assert.equal(view.requiresRecovery, false);
      assert.equal((view.local.associations as unknown[]).length, 0);
      assert.ok(JSON.stringify(view.local.receipt).includes('PARENT_CHANGED'));
      let statusCalls = 0;
      const actualStatusPage = client.requestStatusPage.bind(client);
      client.requestStatusPage = async (...args) => { statusCalls++; return actualStatusPage(...args); };
      const recovered = await h.call(`/r1/requests/${prepared.requestId}/recover`, { lookupId: 'prod-parent-original' }, 202);
      assert.equal(recovered.jobId, submission.jobId);
      assert.equal(statusCalls, 0); assert.equal(submittedStates.length, 3);
      assert.equal((await h.call(`/r1/requests/${prepared.requestId}`)).state, 'rejected');
    } finally { await h.close(); }
  });

test('data line real HTTP daily/minute tabular publish fixes four contracts and all fields before evidence association',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON.' : false, timeout: 180000 }, async () => {
    const f = fixture(true, { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } });
    const h = await host(f);
    try {
      let parent: string | null = null;
      for (const frequency of ['day', 'minute'] as const) {
        const built = await barPlan(h, barInput('actual-' + frequency, frequency, parent), barCsv(frequency));
        assert.equal(built.plan.outputs[0]!.publishEligible, true);
        const frozen = await h.call('/r1/prepare', built.input, 201) as R1RequestView;
        assert.equal(Object.keys(frozen.previewRows[0]!.values as object).length, 6);
        const changed = await h.call('/r1/prepare', { ...built.input, source: { ...built.input.source, provider: 'changed-after-plan' } }, 409);
        assert.ok(['R1_SOURCE_CHANGED','R1_TARGET_CHANGED','R1_REQUEST_CONFLICT'].includes(changed.code));
        const client = h.services.r1Runtime!.client;
        const realRead = client.fixedRead.bind(client), realSubmit = client.submit.bind(client);
        const injectedReadbacks: string[] = [];
        let actualSubmissions = 0, corruption: 'contract' | 'subject' | null = frequency === 'minute' ? 'contract' : null;
        client.submit = async (...args) => { actualSubmissions++; return realSubmit(...args); };
        client.fixedRead = async (...args) => {
          const result = await realRead(...args);
          if (!corruption) return result;
          const altered = structuredClone(result);
          if (corruption === 'contract') {
            ((altered.result.products as Record<string, unknown>[])[0]!.contract_refs as Record<string, Record<string, unknown>>).semantic!.digest = 'sha256:' + '0'.repeat(64);
          } else {
            (((altered.result.rows as Record<string, unknown>[])[0]!.row as Record<string, unknown>).subject as Record<string, unknown>).id = 'wrong-security';
          }
          injectedReadbacks.push(corruption);
          return altered;
        };
        const submitted = await h.call(`/r1/requests/${frozen.requestId}/submit`, { confirmationDigest: frozen.documentSha256 }, 202);
        let done = await settled(h, submitted.jobId);
        if (frequency === 'minute') {
          assert.equal(done.status, 'needs_review'); assert.ok(injectedReadbacks.includes('contract'));
          let pending = await h.call(`/r1/requests/${frozen.requestId}`) as R1RequestView;
          assert.equal(pending.state, 'pending_receipt'); assert.equal((pending.local.associations as unknown[]).length, 0);
          corruption = 'subject';
          const badRowRecovery = await h.call(`/r1/requests/${frozen.requestId}/recover`, { lookupId: 'bar-subject-check' }, 202);
          done = await settled(h, badRowRecovery.jobId); assert.notEqual(done.status, 'succeeded'); assert.ok(injectedReadbacks.includes('subject'));
          pending = await h.call(`/r1/requests/${frozen.requestId}`) as R1RequestView;
          assert.equal((pending.local.associations as unknown[]).length, 0, 'A changed subject must not be linked even when values and row IDs match');
          corruption = null;
          const recovery = await h.call(`/r1/requests/${frozen.requestId}/recover`, { lookupId: 'bar-original-recovery' }, 202);
          done = await settled(h, recovery.jobId);
        }
        assert.equal(done.status, 'succeeded', JSON.stringify(done.error)); assert.equal(actualSubmissions, 1, 'Recovery must never resubmit');
        client.fixedRead = realRead; client.submit = realSubmit;
        const associated = await h.call(`/r1/requests/${frozen.requestId}`) as R1RequestView;
        assert.equal(associated.state, 'associated');
        const links = associated.local.associations as Record<string, unknown>[]; assert.equal(links.length, 1);
        parent = String(links[0]!.snapshot_id);
        const attempt = h.services.r1!.attempt(frozen.requestId);
        const receipt = JSON.parse(String(attempt.receipt_json));
        assert.deepEqual(Object.keys(receipt.contract_refs).sort(), ['algorithm_dependency','read_layout','semantic','update_release']);
        assert.ok(receipt.contract_bundle_ref.digest);
        json(join(f.root, `data-line-${frequency}-result.json`), { actualHttp: true, actualPython: true,
          source: 'synthetic-fixture', requestId: frozen.requestId, snapshotId: parent, rows: associated.previewRows,
          contracts: receipt.contract_refs, contractBundle: receipt.contract_bundle_ref,
          semantic: built.plan.outputs[0]!.semantic, local: associated.local, productionAccepted: false });
      }
      console.log('DATA_LINE_EVIDENCE_ROOT=' + f.root);
    } finally { await h.close(); }
  });

test('R1 general one-field and close-only tables publish through fixed plan, four contracts and readback',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON.' : false, timeout: 180000 }, async () => {
    const f = fixture(true, { cny_per_share: { dimension: 'money_per_share' } });
    let h = await host(f);
    try {
      const base = barInput('general-one', 'day');
      const generic: R1PrepareInput & { mapping: R1TabularMapping } = {
        ...base, outputId: 'general', mapping: { kind: 'tabular_rows', businessKey: 'key',
          earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC',
          fields: [{ fieldCode: 'label', value: 'label', state: 'state' }] },
        target: { ...base.target, outputKey: 'test.general.current_label',
          subject: { kind: 'entity', namespace: 'r1.web.test', id: 'issuer_1' },
          definition: { semantic_code: 'test.general.current_label', measurement_nature: 'mixed_observation',
            unit_code: 'per_field', definition_authority: 'r1.web.test', time_role: 'observation',
            field_definitions: [{ field_code: 'label', data_type: 'text', unit_code: 'not_applicable',
              measurement_nature: 'mixed_observation', time_role: 'observation' }],
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
              time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } } },
          coverage: { scope: { business_keys: ['issuer-one'] }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } },
      };
      const csv = (label: string) => Buffer.from(`key,start,end,label,state\nissuer-one,2026-01-05T00:00:00Z,2026-01-06T00:00:00Z,${label},valid_value\n`);
      const publish = async (draft: R1PrepareInput & { mapping: R1TabularMapping }, inputCsv: Buffer, role: string) => {
        const built = await explicitTablePlan(h, draft, inputCsv, role);
        const semantic = built.plan.outputs[0]!.semantic as { quality: string; checkScope: string[] };
        assert.equal(semantic.quality, 'pass', JSON.stringify(built.plan.outputs[0]));
        assert.equal(built.plan.outputs[0]!.publishEligible, true);
        const prepared = await h.call('/r1/prepare', built.input, 201) as R1RequestView;
        const submit = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        const submitTask = await settled(h, submit.jobId);
        assert.equal(submitTask.status, 'succeeded', JSON.stringify(submitTask.error));
        const final = await h.call(`/r1/requests/${prepared.requestId}`) as R1RequestView;
        assert.equal(final.state, 'associated');
        assert.equal((final.local.associations as unknown[]).length, 1);
        const receipt = JSON.parse(String(h.services.r1!.attempt(draft.requestId).receipt_json));
        assert.deepEqual(Object.keys(receipt.contract_refs).sort(), ['algorithm_dependency', 'read_layout', 'semantic', 'update_release']);
        assert.ok(receipt.contract_bundle_ref.digest);
        return { final, semantic };
      };
      const first = await publish(generic, csv('A'), 'structured-record');
      assert.ok(first.semantic.checkScope.includes('general_tabular_semantics'));
      assert.equal(first.semantic.checkScope.includes('exact_decimal_ohlc'), false);
      const unsupported: typeof generic = { ...generic, requestId: 'general-current-only-unsupported',
        target: { ...generic.target, definition: { ...generic.target.definition,
          semantic_context: { ...(generic.target.definition.semantic_context as Record<string, unknown>),
            version_axis: { revision_mode: 'current_only_business' } } } } };
      const blocked = await explicitTablePlan(h, unsupported, csv('A'), 'structured-record');
      assert.equal((blocked.plan.outputs[0]!.semantic as { quality: string }).quality, 'indeterminate');
      assert.equal(blocked.plan.outputs[0]!.publishEligible, false);
      const marketBase = barInput('close-only', 'day');
      const closeOnly: R1PrepareInput & { mapping: R1TabularMapping } = { ...marketBase,
        mapping: { ...marketBase.mapping as R1TabularMapping, fields: [{ fieldCode: 'close', value: 'close', state: 'state' }],
          bar: { frequency: 'day', close: 'close' } },
        target: { ...marketBase.target, expectedParentSnapshotId: String((first.final.local.associations as Record<string, unknown>[])[0]!.snapshot_id),
          outputKey: 'test.market.close_only',
          definition: { ...marketBase.target.definition,
            field_definitions: (marketBase.target.definition.field_definitions as Record<string, unknown>[]).filter(field => field.field_code === 'close'),
            field_semantic_context: {},
            semantic_context: { ...(marketBase.target.definition.semantic_context as Record<string, unknown>),
              version_axis: { revision_mode: 'current_only_business' } } } } };
      const close = await publish(closeOnly, Buffer.from('key,start,end,close,state\nsecurity-one,2026-01-05T00:00:00Z,2026-01-06T00:00:00Z,11.50,valid_value\n'), 'financial-record');
      assert.ok(close.semantic.checkScope.includes('positive_declared_market_prices'));
      assert.equal(close.semantic.checkScope.includes('exact_decimal_ohlc'), false);
      const closeAssociation = (close.final.local.associations as Record<string, unknown>[])[0]!;
      const closeCorrection: typeof closeOnly = { ...closeOnly, requestId: 'close-only-correction',
        target: { ...closeOnly.target, expectedParentSnapshotId: String(closeAssociation.snapshot_id),
          inputMode: 'complete_snapshot', coverage: { scope: { business_keys: ['security-one'] },
            basis: 'declared_full', completeness: 'complete', absence_means: 'explicitly_absent' } } };
      const updated = await publish(closeCorrection, Buffer.from('key,start,end,close,state\nsecurity-one,2026-01-05T00:00:00Z,2026-01-06T00:00:00Z,11.49,valid_value\n'), 'financial-record');
      const updatedAssociation = (updated.final.local.associations as Record<string, unknown>[])[0]!;
      assert.equal(closeAssociation.product_id, updatedAssociation.product_id);
      assert.notEqual(closeAssociation.snapshot_id, updatedAssociation.snapshot_id);
      await h.close();
      h = await host(f);
      for (const original of [first.final, close.final, updated.final]) {
        const reopened = await h.call(`/r1/requests/${original.requestId}`) as R1RequestView;
        assert.equal(reopened.state, 'associated');
        assert.deepEqual(reopened.local.associations, original.local.associations);
        assert.deepEqual(reopened.previewRows, original.previewRows);
      }
      json(join(f.root, 'general-and-partial-result.json'), { actualHttp: true, actualPython: true,
        source: 'synthetic-fixture', generic: first.final, unsupportedCurrentOnlyPlan: blocked.plan.outputs[0]!.semantic,
        closeOnlyCurrent: [close.final, updated.final], genericScope: first.semantic.checkScope,
        closeScope: close.semantic.checkScope, reopened: true, productionAccepted: false });
      console.log('R1_GENERAL_PARTIAL_EVIDENCE_ROOT=' + f.root);
    } finally { await h.close(); }
  });


test('data originals preserve full daily/minute custody and every selected raw field without inventing semantics',
  { skip: !process.env.XUAN_TEST_ORIGINAL_ROOT || !python ? 'Requires explicitly selected original package root and Python.' : false, timeout: 180000 }, async () => {
    const f = fixture(), h = await host(f, undefined, 'local-review');
    try {
      const originalRoot = realpathSync(process.env.XUAN_TEST_ORIGINAL_ROOT!);
      const cases = [
        { relative: '每日日线/按交易日/2026/20260105@余哈哈的数据仓库 原创整理.csv', column: '股票代码', equals: '000001', fields: 28, id: 'original-daily' },
        { relative: '1min/2026/20260105_A股1分钟K线@余哈哈的数据仓库 原创整理.csv', column: '证券代码', equals: '000001.SZ', fields: 11, id: 'original-minute' },
      ];
      for (const source of cases) {
        const path = realpathSync(join(originalRoot, source.relative));
        assert.ok(path.startsWith(originalRoot + '/'), 'Only the explicitly selected original package may be read');
        const originalHash = wfdSha256(readFileSync(path));
        const reference = h.services.files.register({ path, source: 'user-selected' });
        h.services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }],
          label: source.id + '-isolated-read-only', scope: { kind: 'persistent' } });
        const task = h.services.materials!.submit({ fileRefId: reference.id, category: 'data', mediaType: 'text/csv', expectedSha256: originalHash }, source.id);
        const received = await settled(h, task.id); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
        const material = h.services.materials!.getByTask(task.id)!;
        assert.equal(material.envelope.sha256, originalHash); assert.equal(material.envelope.byteLength, reference.size);
        assert.equal(material.envelope.environment, 'local-review');
        const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, key === 'objectTime'
          ? { status: 'unknown', gap: '原包缺已核证券身份/历史有效性、分钟标签及公开时间依据；不补猜。' }
          : { status: 'known', value: key === 'purpose' ? 'explicit-original-inspection' : 'source-original-' + key,
            evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: key === 'purpose' ? 'explicit-original-inspection' : 'source-original-' + key }] }]));
        const planned = await h.call('/processing/plans', { requestId: source.id + '-plan', input: {
          routing: { materials: [{ materialId: material.envelope.materialId, dimensions, intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'selected', materialIds: [material.envelope.materialId], intendedAction: 'inspect',
            tables: [{ materialId: material.envelope.materialId, format: 'csv', selection: {
              predicate: { column: source.column, equals: source.equals }, maxSelectedRows: 5000, maxScannedRows: 2_000_000 } }] }],
        } }, 202);
        const accepted = await settled(h, planned.jobId); assert.equal(accepted.status, 'succeeded', JSON.stringify(accepted.error));
        const planId = h.services.processing!.getByTask(accepted.id)!.plan!.planId;
        const run = await h.call(`/processing/plans/${planId}/run`, { requestId: source.id + '-run' }, 202);
        const finished = await settled(h, run.jobId); assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
        const plan = h.services.processing!.get(planId), output = plan.outputs[0]!;
        assert.equal(output.state, 'structured'); assert.equal(output.publishEligible, false); assert.equal(output.routingState, 'needs_review');
        const parseStep = plan.steps.find(step => step.kind === 'parse')!;
        const parsed = JSON.parse(h.services.processing!.artifact(planId, parseStep.stepId).bytes.toString('utf8'));
        assert.equal(parsed.source_columns.length, source.fields); assert.equal(parsed.selection.selectionComplete, true);
        assert.equal(parsed.selection.sourceSha256, originalHash); assert.equal(parsed.selection.sourceBytes, reference.size);
        assert.equal(parsed.selection.selectedRows + parsed.selection.excludedRows, parsed.selection.scannedRows);
        const oracle = spawnSync(python!, isolatedPythonArgs(join(f.root, source.id + '-oracle-cache'), ['-c',
          'import csv,json,sys; f=open(sys.argv[1],encoding="utf-8-sig",newline=""); r=csv.DictReader(f); n=0; selected=[]\nfor row in r:\n n+=1\n if row[sys.argv[2]]==sys.argv[3]: selected.append(row)\nprint(json.dumps({"fields":r.fieldnames,"scanned":n,"selected":selected},ensure_ascii=False))', path, source.column, source.equals]),
          { cwd: f.root, encoding: 'utf8', timeout: 60000, maxBuffer: 4_194_304, env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
        assert.equal(oracle.status, 0, oracle.stderr);
        const expected = JSON.parse(oracle.stdout);
        const actual = JSON.parse(h.services.processing!.outputArtifact(planId, 'selected').bytes.toString('utf8'));
        assert.equal(parsed.selection.scannedRows, expected.scanned);
        assert.deepEqual(parsed.source_columns, expected.fields); assert.deepEqual(actual.rows, expected.selected);
        assert.equal(wfdSha256(readFileSync(path)), originalHash, 'The source original must remain unchanged');
        json(join(f.root, source.id + '-readback.json'), { source: source.relative, originalSha256: originalHash,
          originalBytes: reference.size, material: material.envelope, planId, selection: parsed.selection,
          originalFields: parsed.source_columns, independentCsvOracle: { scannedRows: expected.scanned, selectedRows: expected.selected.length, allSelectedFieldsEqual: true },
          outputRows: actual.rows, outputState: output.state, routingState: output.routingState, publishEligible: output.publishEligible,
          gaps: output.gaps, financialQualification: 'not_established', wfdPublished: false, formalStoreTouched: false });
      }
      console.log('DATA_ORIGINALS_EVIDENCE_ROOT=' + f.root);
    } finally { await h.close(); }
  });


test('data browser creates minute field mappings and displays independent financial proof before confirmed Python handoff',
  { skip: !(python && browserPath && browserDigest && webRoot) ? 'Requires explicit isolated browser, built webRoot and Python.' : false, timeout: 180000 }, async () => {
    assert.equal(wfdSha256(readFileSync(browserPath!)), browserDigest);
    const f = fixture(true, { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } });
    const h = await host(f, webRoot!); let browser: Awaited<ReturnType<typeof openIsolatedBrowser>> | undefined;
    try {
      browser = await openIsolatedBrowser(browserPath!, f.root); const b = browser;
      await b.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      await b.page('Page.navigate', { url: h.base.replace('/api/bd', '/') });
      await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'R1 page did not become ready');
      const materialPath = join(f.root, 'minute-browser.csv'); writeFileSync(materialPath, barCsv('minute'), { flag: 'wx' });
      const doc = await b.page('DOM.getDocument'), file = await b.page('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.r1-panel input[type=file]' });
      await b.page('DOM.setFileInputFiles', { nodeId: file.nodeId, files: [materialPath] });
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false' && !!document.querySelector('.r1-panel .database-receipt code')`, 'Minute material upload did not finish');
      await b.click('刷新状态');
      const materialId = await b.evaluate<string>(`document.querySelector('.r1-panel select option:nth-child(2)')?.value`);
      await b.fill('已有材料（仅最近 50 份）', materialId);
      await b.fill('记录形态', 'minute');
      const facts = { 材料角色: 'financial-record', 信息性质: 'direct-observation', 业务对象: 'market_bars',
        对象与时间: 'instrument security_000001 explicit interval', 使用目的: 'isolated-test', 结构与粒度: 'table' };
      for (const [label, value] of Object.entries(facts)) await b.fill(label, value);
      const draft = barInput('browser-minute', 'minute'), mapping = draft.mapping as R1TabularMapping;
      for (const [label, value] of Object.entries({ 来源身份: draft.source.source_id, 提供者: draft.source.provider,
        '原始地址或 URI': draft.source.requested_url, '请求时间（UTC）': draft.source.requested_at_utc,
        '取得时间（UTC）': draft.source.acquired_at_utc, 获准用途: draft.source.usage_scope })) await b.fill(label, value);
      await b.fill('本次 R1 正式交接授权', draft.source.authorization!.status);
      await b.fill('本次授权依据（最多 4096 字）', draft.source.authorization!.basis!);
      await b.fill('目标产品合同（JSON，高级）', JSON.stringify(draft.target, null, 2)); await b.click('读取目标合同字段');
      for (const [label, value] of Object.entries({ 业务键列: mapping.businessKey, '时间起点列（UTC）': mapping.earliestUtc,
        '时间开区间终点列（UTC）': mapping.latestExclusiveUtc, 来源时区: mapping.sourceTimezone })) await b.fill(label, value);
      for (const [label, value] of Object.entries({ '开盘价（可选）': 'open', '最高价（可选）': 'high', '最低价（可选）': 'low', '收盘价（可选）': 'close', '成交量（可选）': 'volume', '成交额角色（可选）': 'amount' })) await b.fill(label, value);
      await b.evaluate(`(()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const row of document.querySelectorAll('.r1-field-row')){const inputs=row.querySelectorAll('input');set.call(inputs[1],inputs[0].value);inputs[1].dispatchEvent(new Event('input',{bubbles:true}));set.call(inputs[2],'state');inputs[2].dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
      const requestId = await b.evaluate<string>(`[...document.querySelectorAll('.r1-panel label')].find(e=>e.firstChild?.textContent==='本次原请求编号').querySelector('input').value`);
      await b.click('仅建立新 R1 加工计划');
      const refreshUntil = (predicate: string, message: string) => b.until(`(()=>{if(${predicate})return true;[...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='刷新状态'&&!e.disabled)?.click();return false;})()`, message);
      await refreshUntil(`!![...document.querySelectorAll('.r1-panel button')].find(e=>e.textContent.trim()==='明确运行五步加工'&&!e.disabled)`, 'Minute plan was not created');
      await b.click('明确运行五步加工');
      await refreshUntil(`!!document.querySelector('.r1-proof-state--pass')`, 'Independent minute financial proof did not pass');
      assert.equal(await b.evaluate(`document.querySelectorAll('.r1-field-row').length`), 6);
      assert.equal(await b.evaluate(`document.querySelector('.r1-proof')?.textContent.includes('结构')`), true);
      await b.click('仅准备并预览，不提交');
      const confirmationInput = `[...document.querySelectorAll('.r1-confirm')].find(e=>e.textContent.includes('我确认上述准确摘要'))?.querySelector('input')`;
      await b.until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false' && !!(${confirmationInput}) && !(${confirmationInput}).matches(':disabled')`, 'Minute document preparation did not settle');
      assert.equal((await h.call(`/r1/requests/${requestId}`)).submitTaskId, null);
      const confirmationPoint = await b.evaluate<{ x: number; y: number }>(`(()=>{const e=${confirmationInput};e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await b.page('Input.dispatchMouseEvent', { type: 'mousePressed', x: confirmationPoint.x, y: confirmationPoint.y, button: 'left', clickCount: 1 });
      await b.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: confirmationPoint.x, y: confirmationPoint.y, button: 'left', clickCount: 1 });
      await b.until(`(${confirmationInput})?.checked===true`, 'Explicit minute confirmation was not accepted');
      await b.click('明确提交这份固定文档');
      const associationNotice = `[...document.querySelectorAll('.r1-success')].find(e=>e.textContent.includes('真实 WFD 行身份已固定读回'))`;
      await refreshUntil(`!!(${associationNotice})`, 'Minute page did not show actual WFD row association');
      const view = await h.call(`/r1/requests/${requestId}`) as R1RequestView;
      assert.equal(view.state, 'associated'); assert.equal((view.local.associations as unknown[]).length, 1);
      assert.equal(Object.keys(view.previewRows[0]!.values as object).length, 6);
      assert.deepEqual(b.exceptions, []); assert.deepEqual(b.blockedRequests, []);
      await b.evaluate(`(${associationNotice}).scrollIntoView({block:'center',behavior:'instant'})`);
      const image = await b.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(f.root, 'minute-browser-result.png'), Buffer.from(image.data, 'base64'), { flag: 'wx' });
      await b.page('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await b.evaluate(`document.documentElement.scrollWidth>innerWidth+1`), false);
      await b.evaluate(`document.querySelector('.r1-proof').scrollIntoView({block:'center',behavior:'instant'})`);
      const narrowImage = await b.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(f.root, 'minute-browser-narrow.png'), Buffer.from(narrowImage.data, 'base64'), { flag: 'wx' });
      json(join(f.root, 'minute-browser-result.json'), { actualBrowser: true, actualPython: true, source: 'synthetic-fixture',
        requestId, selectedMode: 'minute', mappedFields: 6, financialProofPassed: true, explicitHumanConfirmation: true,
        pageExceptions: b.exceptions, applicationExternalRequests: b.blockedRequests, viewport375Overflow: false,
        view, productionAccepted: false });
      console.log('DATA_BROWSER_EVIDENCE_ROOT=' + f.root);
    } finally { await browser?.close(); await h.close(); }
  });

test('data partial semantics checks known constraints without granting publication across unknown axes', async () => {
  const f = fixture(), h = await host(f); let closed = false;
  try {
    const results: Record<string, unknown>[] = [];
    let retainedPlanId = '', retainedProof: unknown;
    for (const variant of ['unknown-acquisition', 'unknown-acquisition-bad-ohlc', 'unknown-quantity-unit-negative', 'unknown-price-unit'] as const) {
      const draft = barInput('partial-' + variant, 'minute');
      draft.source.acquired_at_utc = 'unknown'; draft.source.license = 'unknown';
      const definition = draft.target.definition as Record<string, unknown>;
      const fields = definition.field_definitions as Record<string, unknown>[];
      if (variant === 'unknown-quantity-unit-negative') fields.find(field => field.field_code === 'volume')!.unit_code = 'unknown';
      if (variant === 'unknown-price-unit') fields.find(field => field.field_code === 'open')!.unit_code = 'unknown';
      let csv = barCsv('minute', variant === 'unknown-acquisition-bad-ohlc' || variant === 'unknown-price-unit');
      if (variant === 'unknown-quantity-unit-negative') csv = Buffer.from(csv.toString().replace(',100,1145,', ',-1,1145,'));
      const built = await barPlan(h, draft, csv), output = built.plan.outputs[0]!;
      assert.equal(output.state, 'structured'); assert.equal(output.publishEligible, false); assert.equal(output.routingState, 'needs_review');
      const proof = output.semantic as { quality: string; checkScope: string[]; coverage: { complete: boolean }; error?: { code: string } };
      if (variant === 'unknown-acquisition-bad-ohlc') {
        assert.equal(proof.quality, 'fail'); assert.equal(proof.error?.code, 'R1_TABULAR_OHLC');
      } else if (variant === 'unknown-quantity-unit-negative') {
        assert.equal(proof.quality, 'fail'); assert.equal(proof.error?.code, 'R1_TABULAR_QUANTITY');
      } else {
        assert.equal(proof.quality, 'indeterminate'); assert.equal(proof.coverage.complete, false);
        assert.equal(proof.checkScope.includes('exact_decimal_ohlc'), variant !== 'unknown-price-unit');
        assert.equal(proof.checkScope.includes('nonnegative_volume_amount'), true);
        assert.equal(proof.checkScope.includes('bar_closed_by_acquisition'), false);
        retainedPlanId = built.input.planId; retainedProof = output.semantic;
      }
      results.push({ variant, planId: built.input.planId, state: output.state, publishEligible: output.publishEligible, proof });
    }
    await h.close(); closed = true;
    const reopened = await host(f);
    try { assert.deepEqual(reopened.services.processing!.get(retainedPlanId).outputs[0]!.semantic, retainedProof); }
    finally { await reopened.close(); }
    json(join(f.root, 'partial-semantics-result.json'), { source: 'synthetic-fixture', actualProcessing: true,
      realDatabaseReopened: true, results, wfdPublished: false, productionAccepted: false });
    console.log('PARTIAL_SEMANTICS_EVIDENCE_ROOT=' + f.root);
  } finally { if (!closed) await h.close(); }
});

test('data financial observed slots preserve original precision through isolated processing without adopting a field contract',
  { skip: !process.env.XUAN_TEST_FINANCIAL_CANDIDATE ? 'Requires explicitly selected financial observation fixture directory.' : false }, async () => {
    const selected = realpathSync(process.env.XUAN_TEST_FINANCIAL_CANDIDATE!);
    const csv = readFileSync(join(selected, 'financial-observed-slots.csv'));
    const expected = JSON.parse(readFileSync(join(selected, 'financial-candidate-rows.json'), 'utf8')) as Record<string, string>[];
    const source = JSON.parse(readFileSync(join(selected, 'financial-original-observations.json'), 'utf8'));
    assert.equal(source.formatStatus, 'observed_layout_not_vendor_binary_contract');
    assert.equal(source.archiveApplicationCustody, false); assert.equal(source.wfdPublished, false);
    assert.equal(expected.length, 1168);
    assert.equal(new Set(expected.map(row => row.member)).size, 2);
    assert.ok(expected.every(row => row.value_state === 'unresolved' && row.field_binding === 'unverified' && row.unit_status === 'unknown'));
    const f = fixture(), h = await host(f, undefined, 'local-review'); let closed = false;
    try {
      const uploaded = await fetch(h.base + '/materials/upload?requestId=financial-observations-upload&name=financial-observed-slots.csv&category=data', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-local-data-generation': '1' }, body: new Uint8Array(csv) });
      assert.equal(uploaded.status, 202, await uploaded.clone().text());
      const intake = await settled(h, (await uploaded.json()).jobId); assert.equal(intake.status, 'succeeded');
      const material = h.services.materials!.getByTask(intake.id)!;
      assert.equal(material.envelope.sha256, wfdSha256(csv)); assert.equal(material.envelope.environment, 'local-review');
      const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, key === 'objectTime'
        ? { status: 'unknown', gap: 'Observed binary layout only; slot contract, period basis, zero meaning and revision chain remain unverified.' }
        : { status: 'known', value: key === 'purpose' ? 'explicit-precision-inspection' : 'raw-financial-observation-' + key,
          evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: key === 'purpose' ? 'explicit-precision-inspection' : 'raw-financial-observation-' + key }] }]));
      const task = await h.call('/processing/plans', { requestId: 'financial-observations-plan', input: {
        routing: { materials: [{ materialId: material.envelope.materialId, dimensions, intendedAction: 'inspect' }] },
        outputs: [{ outputId: 'observed-slots', materialIds: [material.envelope.materialId], intendedAction: 'inspect',
          tables: [{ materialId: material.envelope.materialId, format: 'csv', types: { decoded_exact_decimal: 'decimal_string' } }] }],
      } }, 202);
      const created = await settled(h, task.jobId); assert.equal(created.status, 'succeeded');
      const planId = h.services.processing!.getByTask(created.id)!.plan!.planId;
      const run = await h.call(`/processing/plans/${planId}/run`, { requestId: 'financial-observations-run' }, 202);
      assert.equal((await settled(h, run.jobId)).status, 'succeeded');
      const plan = h.services.processing!.get(planId), output = plan.outputs[0]!;
      assert.equal(output.state, 'structured'); assert.equal(output.publishEligible, false); assert.equal(output.routingState, 'needs_review');
      const actual = JSON.parse(h.services.processing!.outputArtifact(planId, 'observed-slots').bytes.toString('utf8'));
      assert.deepEqual(actual.rows, expected);
      assert.equal(actual.rows.find((row: Record<string, string>) => row.member === 'gpcw20240331.dat' && row.slot_index_1 === '40').decoded_exact_decimal, '285524557824');
      assert.ok(actual.rows.some((row: Record<string, string>) => row.decoded_exact_decimal === '0' && row.value_state === 'unresolved'));
      const artifactHash = wfdSha256(h.services.processing!.outputArtifact(planId, 'observed-slots').bytes);
      await h.close(); closed = true;
      const reopened = await host(f, undefined, 'local-review');
      try {
        assert.deepEqual(JSON.parse(reopened.services.processing!.outputArtifact(planId, 'observed-slots').bytes.toString('utf8')).rows, expected);
        assert.equal(reopened.services.processing!.get(planId).outputs[0]!.publishEligible, false);
      } finally { await reopened.close(); }
      json(join(f.root, 'financial-observations-result.json'), { actualHttp: true, actualProcessing: true, realDatabaseReopened: true,
        originalArchiveSha256: source.archiveSha256, candidateCsvSha256: wfdSha256(csv), outputArtifactSha256: artifactHash,
        selectedPeriods: 2, selectedRows: expected.length, everyRawSlotAndDecimalMatched: true, noZeroPromotedToValid: true,
        archiveApplicationCustody: false, candidateApplicationCustody: true, financialFieldContractAdopted: false,
        planId, output, wfdPublished: false, productionAccepted: false });
      console.log('FINANCIAL_OBSERVATIONS_EVIDENCE_ROOT=' + f.root);
    } finally { if (!closed) await h.close(); }
  });

test('data current-only market replaces the business value and preserves technical fixed snapshots through real Python',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON.' : false, timeout: 180000 }, async () => {
    const f = fixture(true, { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } });
    let h = await host(f);
    try {
      const published: R1RequestView[] = [];
      for (const correction of [false, true]) {
        const parent = published.length ? String((published[0]!.local.associations as Record<string, unknown>[])[0]!.snapshot_id) : null;
        const draft = barInput(correction ? 'current-only-correction' : 'current-only-original', 'minute', parent);
        const context = (draft.target.definition as Record<string, unknown>).semantic_context as Record<string, unknown>;
        context.version_axis = { revision_mode: 'current_only_business' };
        if (correction) {
          draft.target.inputMode = 'complete_snapshot';
          draft.target.coverage = { scope: { business_keys: ['000001-minute'] }, basis: 'declared_full',
            completeness: 'complete', absence_means: 'explicitly_absent' };
        }
        const csv = correction ? Buffer.from(barCsv('minute').toString().replace(',11.50,100,', ',11.49,100,')) : barCsv('minute');
        const built = await barPlan(h, draft, csv);
        assert.equal(built.plan.outputs[0]!.publishEligible, true);
        const prepared = await h.call('/r1/prepare', built.input, 201) as R1RequestView;
        assert.equal(Object.hasOwn(prepared.previewRows[0]!, 'public_time'), false);
        const task = await h.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        assert.equal((await settled(h, task.jobId)).status, 'succeeded');
        const result = await h.call(`/r1/requests/${prepared.requestId}`) as R1RequestView;
        assert.equal(result.state, 'associated'); assert.equal((result.local.associations as unknown[]).length, 1);
        published.push(result);
      }
      const first = (published[0]!.local.associations as Record<string, unknown>[])[0]!;
      const latest = (published[1]!.local.associations as Record<string, unknown>[])[0]!;
      assert.equal(first.product_id, latest.product_id); assert.notEqual(first.snapshot_id, latest.snapshot_id);
      assert.notEqual(first.record_version, latest.record_version);
      const machine = new WfdProductMachineClient({ pythonPath: python!, entryPath: join(productRoot, 'wfd_sdk/product_machine.py'),
        configPath: f.configPath, projectRoot: productRoot });
      const query = { protocol_version: 'wfd.read/1.3-product1', operation: 'read_product', dataset_id: 'r1_web_test',
        snapshot_id: latest.snapshot_id, product_id: latest.product_id, history_mode: 'snapshot_contents', knowledge_cutoff: null,
        held_scope: null, usable_stage: null, subject: null, fields: ['open','high','low','close','volume','amount'],
        page_size: 100, max_nodes: 1000, max_scan_bytes: 50_000_000, cursor: null, business_time_range: null };
      const current = await machine.readProduct(query);
      const currentRows = current.result.rows as Record<string, unknown>[];
      assert.equal(currentRows.length, 1); assert.match(JSON.stringify(currentRows[0]), /11\.49/);
      const rejectsCode = (expected: string) => (error: unknown) => error instanceof WfdProductMachineError && error.code === expected;
      await assert.rejects(machine.readProduct({ ...query, snapshot_id: first.snapshot_id }), rejectsCode('CURRENT_ONLY_BUSINESS_HEAD_REQUIRED'));
      await assert.rejects(machine.readProduct({ ...query, history_mode: 'market_known_at', knowledge_cutoff: {
        status: 'known', precision: 'second', earliest_utc: '2026-01-06T00:00:00Z', latest_exclusive_utc: '2026-01-06T00:00:01Z', source_timezone: 'UTC',
      } }), rejectsCode('CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED'));
      await assert.rejects(machine.read({ snapshotId: String(latest.snapshot_id), productId: String(latest.product_id), includeHistory: true }), rejectsCode('CURRENT_ONLY_BUSINESS_HISTORY_UNSUPPORTED'));
      const technical = await machine.read({ snapshotId: String(first.snapshot_id), productId: String(first.product_id) });
      const oldRows = technical.result.rows as { row: { values: { close: { value: string } } } }[];
      assert.equal(oldRows.length, 1); assert.equal(oldRows[0]!.row.values.close.value, '11.5');
      await h.close(); h = await host(f);
      h.services.r1Runtime!.client.submit = async () => { throw new Error('A technical snapshot lookup must not submit again'); };
      const recovered = await h.call('/r1/requests/current-only-original/recover', { lookupId: 'old-current-only-snapshot' }, 202);
      await settled(h, recovered.jobId);
      const original = await h.call('/r1/requests/current-only-original') as R1RequestView;
      assert.equal(original.state, 'associated'); assert.deepEqual(original.local.associations, published[0]!.local.associations);
      json(join(f.root, 'current-only-market-result.json'), { actualHttp: true, actualPython: true, source: 'synthetic-fixture',
        published, currentBusinessRead: current.result, technicalOriginalRead: technical.result,
        businessOldSnapshotRejected: true, businessHistoricalTimeRejected: true, historyExpansionRejected: true,
        originalRequestReopenedWithoutResubmit: true, physicalHistoryDeleted: false, productionAccepted: false });
      console.log('CURRENT_ONLY_MARKET_EVIDENCE_ROOT=' + f.root);
    } finally { await h.close(); }
  });


test('retired handoff routes and schemas stay absent while material processing and content survive reopen', async () => {
  const f = fixture(); let h = await host(f);
  const forbidden = ['candidate_preparations', 'candidate_submissions', 'conversation_candidate_links',
    'conversation_data_cycles', 'conversation_cycle_confirmations', 'conversation_result_publications',
    'database_line_selection', 'database_line_identities', 'database_line_changes', 'database_task_lines',
    'database_request_lines', 'database_line_identity_history', 'database_line_relocations', 'database_line_business_ledgers',
    'financial_snapshot_declarations', 'financial_task_origins', 'collection_handoffs'];
  let digest = '', planId = '';
  try {
    const personalDatabase = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
    const personalCore = new PersonalCore(backend, { database: personalDatabase });
    const personal = createApplicationServices(personalCore, personalDatabase, { health, projectRoot: f.runtime, codeRoot,
      privateRoot: join(f.runtime, 'state/personal-private'), resources: new ResourceBindings(f.runtime), workspaceServices: h.services });
    try {
      const registered = personal.direct.registry.list().map(entry => entry.action);
      assert.ok(registered.includes('data.processing.capabilities')); assert.ok(registered.includes('data.r1.capabilities'));
      assert.ok(registered.every(action => !action.startsWith('data.candidates.') && !['data.prepare', 'data.submit', 'data.status', 'results.publish', 'algorithms.prepare_candidate'].includes(action)));
      for (const name of forbidden) assert.equal(personalDatabase.connection.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), undefined, name);
    } finally { await personal.tasks.dispose(); await personalCore.dispose(); personalDatabase.close(); }
    for (const [path, body] of [['/candidates/capabilities', undefined], ['/candidates/prepare', {}], ['/candidates/submit', {}],
      ['/candidates/retired/control', {}], ['/candidates/retired/reconcile', {}], ['/candidates/retired', undefined],
      ['/database-lines/status', undefined], ['/database-lines/recover', {}], ['/jobs/retired/recover', {}]] as const) {
      const missing = await h.call(path, body, 404); assert.equal(missing.code, 'SERVICE_ROUTE_UNAVAILABLE');
    }
    for (const path of ['/candidates', '/conversation-candidates?conversationId=retired&branchId=retired', '/official']) {
      const response = await fetch(h.base.replace('/api/bd', '/api/ui/data-browser') + path);
      assert.equal(response.status, 404, path);
    }
    const draft = await actualPlan(h, 'retirement-processing'); planId = draft.planId;
    const output = h.services.processing!.outputArtifact(planId, 'scalar'); digest = output.ref.sha256;
    assert.ok(h.services.candidates!.verifyObject(output.ref));
    assert.equal(wfdSha256(h.services.candidates!.objectBytes(output.ref)), digest);
    assert.equal(h.database.connection.prepare('SELECT count(*) AS count FROM material_objects').get()?.count, 1);
    for (const name of forbidden) assert.equal(h.database.connection.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), undefined, name);
  } finally { await h.close(); }
  h = await host(f);
  try {
    const output = h.services.processing!.outputArtifact(planId, 'scalar');
    assert.equal(output.ref.sha256, digest); assert.equal(wfdSha256(h.services.candidates!.objectBytes(output.ref)), digest);
    for (const name of forbidden) assert.equal(h.database.connection.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), undefined, name);
    assert.equal(h.database.connection.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(h.database.connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await h.close(); }
});


test('fixed calculation HTTP is read-only for new work and retains historical Polars lookup/recovery', async () => {
  const f = fixture(), h = await host(f);
  try {
    const countBefore = h.database.connection.prepare('SELECT count(*) AS count FROM tasks').get()?.count;
    const capabilities = await h.call('/computation/capabilities');
    assert.equal(capabilities.routing, 'fixed_by_method');
    assert.deepEqual(capabilities.methods.map((method: { id: string }) => method.id).sort(),
      ['financial_linear', 'macro_yoy', 'observation_ma20']);
    assert.deepEqual(await h.call('/computation/tasks'), { items: [] });
    const polars = await h.call('/processing/polars/capabilities');
    assert.equal(polars.runtime, 'bd.polars-fixed');
    assert.equal(typeof polars.configured, 'boolean');
    // New calculations belong only to BD AGENTS. Retired creation cannot allocate tasks,
    // even with a formerly valid payload; original task lookup and recovery stay available.
    const disabled = await h.call('/computation/tasks', {}, 404);
    assert.equal(disabled.code, 'SERVICE_ROUTE_UNAVAILABLE');
    for (const input of [{}, { requestId: 'retired-create', method: 'macro_yoy', calculation: {} }]) {
      const rejected = await h.call('/processing/polars/tasks', input, 410);
      assert.equal(rejected.code, 'ALGORITHM_AGENT_ENTRY_REQUIRED');
    }
    for (const prefix of ['/computation/tasks', '/processing/polars/tasks']) {
      const missing = await h.call(prefix + '/missing-calculation', undefined, 404);
      assert.equal(missing.code, 'TASK_NOT_FOUND');
    }
    for (const suffix of ['/stage', '/prepare']) {
      const disabledAction = await h.call('/computation/tasks/missing-calculation' + suffix, {}, 404);
      assert.equal(disabledAction.code, 'SERVICE_ROUTE_UNAVAILABLE');
    }
    const stage = await h.call('/processing/polars/tasks/missing-calculation/stage', {}, 404);
    assert.equal(stage.code, 'TASK_NOT_FOUND');
    const prepare = await h.call('/processing/polars/tasks/missing-calculation/prepare', {}, 409);
    assert.equal(prepare.code, 'POLARS_STAGE_PENDING');
    assert.equal(h.database.connection.prepare('SELECT count(*) AS count FROM tasks').get()?.count, countBefore);
  } finally { await h.close(); }
});

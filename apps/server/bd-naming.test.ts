import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { FrozenRunConfiguration } from '../../contracts/ui-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { assertInternalAgentRules, captureInternalAgentRules } from '../../modules/agent/instructions/rules.js';
import { createSyntheticPagedSource } from '../../modules/collection/sources.js';
import type { FinancialCallArgs } from '../../modules/financial/types.js';
import { ResourceBindings, launcherPath, locateRuntimeRoot } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { assertRuntimeStopped, readBdRuntime, readRuntimeLauncher } from '../../platform/runtime/runtime-profile.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApp } from './app.js';
import { ownStateRoot } from './boot.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'isolated model-disabled naming test' };
const backend: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('No model calls in naming checks'); } };
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-naming-')));
  const runtime = join(root, 'runtime'), identity = 'isolated-bd-stable-runtime'; mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'directory' }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path); resources[name] = { path, kind: 'directory' };
  }
  const marker = join(runtime, '.xuan-runtime.json'), launcher = join(root, 'launcher.json');
  const markerValue = { application: 'xuan-bd', version: 1, identity };
  writeFileSync(marker, JSON.stringify(markerValue));
  writeFileSync(join(runtime, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: identity, resources }));
  writeFileSync(launcher, JSON.stringify({ version: 1, runtimeRoot: runtime, runtimeIdentity: identity }));
  return { root, runtime, identity, marker, markerValue, launcher };
}
function servicesFixture(financial = false) {
  const f = fixture(), database = new CoreDatabase(join(f.runtime, 'state/core.sqlite'));
  const core = new PersonalCore(backend, { database });
  const sources = ['source-a', 'source-b'].map(id => createSyntheticPagedSource({ id, version: '1', pages: [Buffer.from('value\n1\n')] }));
  const resources = new ResourceBindings(f.runtime);
  const services = createApplicationServices(core, database, { role: 'service', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/private'), resources, materials: { environment: 'synthetic-test' },
    configureFinancial: financial ? () => ({ environment: 'synthetic-test', computeAssetsRoot: join(codeRoot, 'plugins/financial/local-compute/assets'),
      pythonExecutable: process.env.WFD_PYTHON!, processRuntime: new ProcessRuntime(resources) }) : undefined,
    configureCollection: () => ({ environment: 'synthetic-test', datasetId: 'bd-naming', sources, plans: {} }) });
  return { ...f, database, core, services, async close() { await services.tasks.dispose(); await core.dispose(); database.close(); } };
}

test('BD runtime marker, environment and launcher preserve the selected root and resource identity', () => {
  const f = fixture(), state = join(f.runtime, 'state'), before = lstatSync(state, { bigint: true });
  const bindings = readFileSync(join(f.runtime, 'config/machine.bindings.json'), 'utf8');
  assert.equal(locateRuntimeRoot(undefined, { XUAN_BD_HOME: f.runtime }, join(f.root, 'absent.json')), f.runtime);
  assert.equal(locateRuntimeRoot(undefined, { XUAN_HARNESS_HOME: join(f.root, 'old-home') }, f.launcher), f.runtime);
  assert.equal(readRuntimeLauncher(f.launcher).runtimeIdentity, f.identity);
  assert.equal(readBdRuntime(f.runtime).runtimeRoot, f.runtime);
  if (process.platform === 'darwin') assert.equal(launcherPath(), join(homedir(), 'Library/Application Support/Xuan BD/launcher.json'));
  if (process.platform === 'win32') assert.equal(launcherPath(), join(homedir(), 'AppData/Local/Xuan BD/launcher.json'));
  writeFileSync(f.marker, JSON.stringify({ ...f.markerValue, application: 'xuan-harness' }));
  assert.throws(() => new ResourceBindings(f.runtime), /运行根身份/u);
  writeFileSync(f.marker, JSON.stringify(f.markerValue));
  assert.equal(new ResourceBindings(f.runtime).document.runtimeIdentity, f.identity);
  assert.equal(readFileSync(join(f.runtime, 'config/machine.bindings.json'), 'utf8'), bindings);
  const after = lstatSync(state, { bigint: true }); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
});

test('BD state ownership uses the new lock and refuses any unresolved former owner', async () => {
  const f = fixture(), state = join(f.runtime, 'state/personal'), path = join(state, 'core.sqlite');
  const release = await ownStateRoot(path);
  assert.equal(existsSync(join(state, '.bd-owner.lock')), true);
  await assert.rejects(ownStateRoot(path), { code: 'STATE_IN_USE' });
  assert.throws(() => assertRuntimeStopped(f.runtime), { code: 'RUNTIME_IN_USE' });
  await release(); assertRuntimeStopped(f.runtime);
  const oldLock = join(state, '.harness-owner.lock'); writeFileSync(oldLock, 'unresolved old owner');
  await assert.rejects(ownStateRoot(path), { code: 'STATE_IN_USE' });
  assert.throws(() => assertRuntimeStopped(f.runtime), { code: 'RUNTIME_IN_USE' });
  assert.equal(readFileSync(oldLock, 'utf8'), 'unresolved old owner');
  assert.equal(existsSync(join(state, '.bd-owner.lock')), false);
  unlinkSync(oldLock);
});

test('BD HTTP entry reports current owner and workspace; the old entry is absent', async () => {
  const h = servicesFixture(), server = createApp(h.core, health, h.services, { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = await fetch(base + '/api/bd/runtime/status'); assert.equal(status.status, 200);
    assert.equal((await status.json()).ownerService, 'bd_agents');
    const workspace = await fetch(base + '/api/bd/workspace'); assert.equal(workspace.status, 200);
    assert.equal((await workspace.json()).mode, 'bd-workspace');
    for (const path of ['/api/harness/runtime/status', '/api/harness/workspace', '/api/harness/local-data/current']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal(h.services.bd!.versions.contract, 'bd-service/1');
    assert.equal(h.services.bd!.versions.module, 'bd_agent');
    assert.equal(Object.hasOwn(h.services.bd!.versions, 'harness'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await h.close();
  }
});

test('BD repeated intake preserves the former acceptance digest, rejects conflicts and never starts ready tasks', async () => {
  const h = servicesFixture();
  try {
    const db = h.database.connection, collection = h.services.collection!, tasks = h.services.tasks;
    const original = tasks.create({ title: '数据收集：collection.collect', ownerRole: 'service', runtimeId: 'harness.collection',
      action: 'collection.collect', args: { sourceId: 'source-a' }, requestId: 'collection:collection.collect:' + digestOperationArgs('same-intake'), versions: collection.versionBinding });
    const digest = db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(original.id)!.input_digest;
    const events = tasks.events(original.id); db.prepare('UPDATE tasks SET runtime_id=? WHERE id=?').run('bd.collection', original.id);
    assert.equal(collection.submit('collection.collect', { sourceId: 'source-a' }, 'same-intake').id, original.id);
    assert.equal(tasks.get(original.id).status, 'ready'); assert.equal(tasks.getRuns(original.id).length, 0);
    assert.deepEqual(tasks.events(original.id), events);
    assert.throws(() => collection.submit('collection.collect', { sourceId: 'source-b' }, 'same-intake'), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => collection.submit('collection.collect', { sourceId: 'source-a' }, 'same-intake', 'different-parent'), { code: 'REQUEST_CONFLICT' });
    db.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify({ ...collection.versionBinding, configuration: 'other-version' }), original.id);
    assert.throws(() => collection.submit('collection.collect', { sourceId: 'source-a' }, 'same-intake'), { code: 'REQUEST_CONFLICT' });
    db.prepare('UPDATE tasks SET versions=?,status=? WHERE id=?').run(JSON.stringify(collection.versionBinding), 'needs_review', original.id);
    assert.equal(collection.submit('collection.collect', { sourceId: 'source-a' }, 'same-intake').status, 'needs_review');
    assert.equal(tasks.getRuns(original.id).length, 0);
    const versions = h.services.bd!.versions, oldVersions: Record<string, string | null> = { ...versions, harness: versions.bd!, contract: 'harness-service/1', module: 'harness_agent' };
    delete oldVersions.bd;
    const serviceTask = tasks.create({ title: '框架服务：test.echo', ownerRole: 'service', runtimeId: 'harness.service', action: 'test.echo',
      args: { value: 'phase-one-synthetic' }, requestId: 'service:local-operator:test.echo:same-echo', versions: oldVersions });
    const serviceDigest = db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(serviceTask.id)!.input_digest;
    db.prepare('UPDATE tasks SET runtime_id=?,versions=? WHERE id=?').run('bd.service', JSON.stringify(versions), serviceTask.id);
    assert.equal(h.services.bd!.submit('test.echo', { value: 'phase-one-synthetic' }, 'same-echo').id, serviceTask.id);
    assert.equal(tasks.getRuns(serviceTask.id).length, 0); assert.equal(tasks.get(serviceTask.id).status, 'ready');
    assert.throws(() => h.services.bd!.submit('test.echo', { value: 'phase-one-synthetic' }, 'same-echo', original.id), { code: 'REQUEST_CONFLICT' });
    db.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify({ ...versions, module: 'other-module' }), serviceTask.id);
    assert.throws(() => h.services.bd!.submit('test.echo', { value: 'phase-one-synthetic' }, 'same-echo'), { code: 'REQUEST_CONFLICT' });
    db.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify(versions), serviceTask.id);
    assert.equal(db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(serviceTask.id)!.input_digest, serviceDigest);
    assert.equal(db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(original.id)!.input_digest, digest);
    tasks.stopControl('isolated naming stop');
    assert.throws(() => collection.submit('collection.collect', { sourceId: 'source-a' }, 'same-intake'), { code: 'BD_STOPPED' });
    assert.throws(() => h.services.bd!.submit('test.echo', { value: 'phase-one-synthetic' }, 'same-echo'), { code: 'SERVICE_STOPPED' });
    assert.equal(tasks.getRuns(original.id).length, 0);
  } finally { await h.close(); }
});

test('BD rule identity captures the unchanged body and rejects former frozen rule execution', () => {
  const current = captureInternalAgentRules();
  assert.equal(current.internalAgentRules!.id, 'xuan-bd-internal-agent');
  assert.equal(current.internalAgentRules!.version, 17);
  assertInternalAgentRules(current as FrozenRunConfiguration);
  const former = { ...current, internalAgentRules: { id: 'xuan-harness-internal-agent', version: 16,
    digest: 'f03b0fec5c2de43dfdb0920961b952de76d65f31019357d78ba5fefe9839a098' } };
  assert.throws(() => assertInternalAgentRules(former as FrozenRunConfiguration), { code: 'RUN_CONFIGURATION_UNAVAILABLE' });
});

test('BD financial replay keeps its original digest and source checks without dispatching a ready task',
  { skip: !process.env.WFD_PYTHON ? 'Requires explicitly selected WFD_PYTHON.' : false }, async () => {
    const h = servicesFixture(true);
    try {
      const financial = h.services.financial!, tasks = h.services.tasks, db = h.database.connection;
      const initial = financial.status();
      const status = financial.enable({ pluginId: initial.pluginId, pluginVersion: initial.pluginVersion, expectedVersion: initial.version });
      const method = financial.describe('xuen.local-finance.ma');
      const args: FinancialCallArgs = { capabilityId: 'xuen.local-finance.ma', pluginVersion: method.pluginVersion,
        methodVersion: method.methodVersion, implementationVersion: method.implementationVersion, parameters: { period: 2 },
        input: { kind: 'direct', inputId: 'isolated-bd-financial', data: { metadata: { series_id: 'isolated', frequency: '1d', timezone: 'UTC',
          price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustment_basis: 'synthetic fixture',
          window_start: '2026-01-01', window_end: '2026-01-02', observations_are_consecutive: true,
          as_of: '2026-01-03T00:00:00Z', availability_basis: 'explicit_per_bar', synthetic: true }, rows: [
          { timestamp: '2026-01-01', close: 1, available_at: '2026-01-01T01:00:00Z', bar_closed: true },
          { timestamp: '2026-01-02', close: 2, available_at: '2026-01-02T01:00:00Z', bar_closed: true },
        ] } } };
      const versions: Record<string, string | null> = { ...financial.versionBinding, method: method.methodVersion, permission: String(status.permissionVersion), pluginState: String(status.version) };
      const original = tasks.create({ title: '金融计算：算术移动均线', ownerRole: 'service', runtimeId: 'harness.financial',
        action: 'tools.call', args: JSON.parse(JSON.stringify(args)), requestId: 'financial:tools.call:same-finance', versions });
      db.prepare('INSERT INTO financial_calls VALUES(?,?,?,?,?,?,?,?,?,?)').run(original.id, method.implementationVersion, status.version,
        status.permissionVersion, 'synthetic-test', versions.python!, null, null, null, null);
      const digest = db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(original.id)!.input_digest;
      db.prepare('UPDATE tasks SET runtime_id=? WHERE id=?').run('bd.financial', original.id);
      assert.equal(financial.submit('tools.call', args, 'same-finance').id, original.id);
      assert.equal(tasks.get(original.id).status, 'ready'); assert.equal(tasks.getRuns(original.id).length, 0);
      assert.throws(() => financial.submit('tools.call', { ...args, parameters: { period: 3 } }, 'same-finance'), { code: 'REQUEST_CONFLICT' });
      assert.throws(() => financial.submit('tools.call', args, 'same-finance', original.id), { code: 'REQUEST_CONFLICT' });
      db.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify({ ...versions, method: 'other-method-version' }), original.id);
      assert.throws(() => financial.submit('tools.call', args, 'same-finance'), { code: 'REQUEST_CONFLICT' });
      db.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify(versions), original.id);
      db.prepare('INSERT INTO financial_host_submissions(task_id) VALUES(?)').run(original.id);
      assert.throws(() => financial.submit('tools.call', args, 'same-finance'), { code: 'FINANCIAL_HOST_BINDING_REQUIRED' });
      let sourceChecks = 0;
      assert.equal(financial.submit('tools.call', args, 'same-finance', undefined, { beforeStart: () => { sourceChecks++; } }).id, original.id);
      assert.equal(sourceChecks, 1); assert.equal(tasks.getRuns(original.id).length, 0);
      assert.equal(db.prepare('SELECT input_digest FROM tasks WHERE id=?').get(original.id)!.input_digest, digest);
      tasks.stopControl('isolated financial replay stop');
      assert.throws(() => financial.submit('tools.call', args, 'same-finance'), { code: 'BD_STOPPED' });
    } finally { await h.close(); }
  });

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { directImplementationVersion } from '../../platform/plugins/direct-versions.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { changedImplementation, createFullChainFixture } from './full-chain-test-support.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const backend: Backend = { id: 'synthetic-version-only', createSession: async () => { throw new Error('No model in version binding regression'); } };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, provider: null, model: null,
  notice: 'Isolated host version checks; no external WFD, model or algorithm execution.' };

test('real algorithm host freezes publication separately from fixed reads and binds WFD without a Python algorithm service', {
  skip: !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT（隔离宿主版本回归）；不读取真实 WFD。', timeout: 30_000,
}, async t => {
  const f = createFullChainFixture({ name: 'algorithm-versions', machine: !!process.env.WFD_PYTHON });
  const externalRoot = join(f.root, 'external-wfd');
  if (f.machine) {
    fs.mkdirSync(externalRoot);
    for (const name of ['protocol', 'wfd_sdk']) fs.cpSync(join(codeRoot, 'wfd/product', name), join(externalRoot, name), { recursive: true });
    const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    fs.writeFileSync(f.configPath, JSON.stringify({ ...config, project_root: externalRoot, protocol_root: join(externalRoot, 'protocol') }));
  }
  const resources = new ResourceBindings(f.runtime);
  const companionDb = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(backend, { database: companionDb });
  const companion = createApplicationServices(companionCore, companionDb, { role: 'service', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources,
    materials: { environment: 'synthetic-test' }, r1ConnectionId: 'full-chain-test' });
  const realWorkspace = companion.r1Workspace;
  let version = { r1Workspace: 'synthetic-read/1', protocol: 'wfd.structured-ingest/1.0', profile: 'data_only' };
  let connection = { connectionId: 'synthetic-fixed-read', profile: 'data_only', configSha256: 'a'.repeat(64) };
  const workspace = { get versionBinding() { return version; }, capabilities: () => ({ connection, readProductSupported: true }),
    readBinding: () => ({ readSchemaSha256: 'b'.repeat(64), queryImplSha256: 'c'.repeat(64) }),
    readProduct: async () => { throw new Error('Version checks must not read WFD'); } } as unknown as NonNullable<typeof companion.r1Workspace>;
  companion.r1Workspace = workspace;
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/personal-private'), resources, workspaceServices: companion });
  t.after(async () => {
    await services.tasks.dispose(); await core.dispose(); services.segments?.close(); services.files.closeTemporaryRetention(); database.close();
    await companion.tasks.dispose(); await companionCore.dispose(); companion.segments?.close(); companion.files.closeTemporaryRetention(); companionDb.close();
  });
  assert.equal(companion.algorithms, undefined, '仅装配只读 WFD 端口，未装配 Python 算法服务');
  const registry = services.direct.registry;
  const actions = ['algorithms.calculate', 'data.modules.calculate', 'algorithms.publish', 'algorithms.screen', 'algorithms.status'];
  const frozen = new Map(actions.map(action => [action, { runtimeId: 'direct', action, args: {},
    versions: registry.captureVersions(action, {}) } as TaskRecord]));
  const verify = (action: string) => registry.assertTaskVersions(frozen.get(action)!);
  const publication = actions.slice(0, 3);

  await t.test('pure calculations bind the exact request, TS implementation and fixed reader independently of publication and Python', () => {
    const capture = (action: string, args: TaskRecord['args']) =>
      ({ runtimeId: 'direct', action, args, versions: registry.captureVersions(action, args) } as TaskRecord);
    const methodId = 'financial_ttm', pure = ['algorithms.calculate', 'data.modules.calculate'].map(action => {
      const task = capture(action, { calculationJson: JSON.stringify({ methodId }) });
      assert.deepEqual(task.versions, registry.captureVersions(action, { methodId }));
      assert.equal(task.versions.directImplementation, directImplementationVersion(['algorithms', 'algorithmRead', 'algorithmPure']));
      return task;
    });
    changedImplementation('adapters/database/wfd-transport.ts', () => {
      assert.throws(() => verify('algorithms.status'), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
    });
    const discovery = capture('algorithms.capabilities', { snapshotId: 's_fixed' });
    const catalog = capture('algorithms.capabilities', {});
    assert.deepEqual(catalog.versions, registry.captureVersions('algorithms.capabilities', { snapshotId: '' }));
    assert.equal(discovery.versions.directImplementation, directImplementationVersion(['algorithms', 'algorithmRead']));
    for (const name of ['pure-operator-runner', 'pure-operator-verification']) {
      changedImplementation('modules/financial/' + name + '.ts', () => {
        for (const task of pure) assert.throws(() => registry.assertTaskVersions(task), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
        registry.assertTaskVersions(discovery); registry.assertTaskVersions(catalog);
        for (const action of actions) {
          if (action === 'algorithms.status' && name === 'pure-operator-runner')
            assert.throws(() => verify(action), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
          else verify(action);
        }
      });
    }
    changedImplementation('modules/financial/derived-wfd-publisher.ts', () => {
      assert.throws(() => verify('algorithms.publish'), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
      for (const task of [...pure, discovery]) registry.assertTaskVersions(task);
    });
    companion.algorithms = { versionBinding: { python: 'changed' } } as NonNullable<typeof companion.algorithms>;
    try { for (const task of [...pure, discovery, catalog]) registry.assertTaskVersions(task); }
    finally { companion.algorithms = undefined; }
    for (const changed of [{ ...workspace, readBinding: () => ({ readSchemaSha256: 'e'.repeat(64), queryImplSha256: 'c'.repeat(64) }) },
      { ...workspace, readBinding: () => null }, undefined]) {
      companion.r1Workspace = changed as typeof companion.r1Workspace;
      try {
        for (const task of [...pure, discovery]) assert.throws(() => registry.assertTaskVersions(task),
          { code: changed?.readBinding() ? 'DIRECT_VERSION_CONFLICT' : 'DIRECT_DEPENDENCY_UNAVAILABLE' });
        registry.assertTaskVersions(catalog); verify('algorithms.status');
      } finally { companion.r1Workspace = workspace; }
    }
    for (const task of [...pure, discovery]) registry.assertTaskVersions(task);
  });

  await t.test('publication and G5 changes reject the original versions; screen and status retain their read-only dependency scope', () => {
    const r1Baseline = directImplementationVersion(['r1']);
    for (const path of ['modules/financial/derived-wfd-publisher.ts', 'modules/financial/derived-wfd-check.ts',
      'modules/financial/algorithm-reference.ts', 'modules/collection/wfd-publish-restriction.ts',
      'plugins/financial/local-compute/assets.ts', 'platform/runtime/process.ts', 'modules/collection/source-field-profile.ts',
      'modules/collection/g5-admission-receipt.ts', 'modules/collection/r1-g5-admission.ts']) {
      changedImplementation(path, () => {
        for (const action of publication) assert.throws(() => verify(action), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' }, path);
        verify('algorithms.screen'); verify('algorithms.status');
        if (path.includes('g5-')) assert.throws(() => directImplementationVersion(['r1']), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
      });
      for (const action of actions) verify(action);
      assert.equal(directImplementationVersion(['r1']), r1Baseline);
    }
  });

  await t.test('fixed product reader, indexed query and protocol changes reject screen versions and recover after byte restoration', () => {
    for (const path of ['modules/collection/r1-product-reader.ts', 'modules/collection/r1-indexed-query.ts',
      'modules/collection/r1-workspace.ts', 'modules/collection/r1-runtime.ts', 'modules/collection/r1-structured-handoff.ts',
      'apps/server/services.ts', 'adapters/database/wfd-product-connection.ts',
      'contracts/r1-contracts.ts', 'contracts/financial-value.ts', 'adapters/database/wfd-product-machine.ts',
      'wfd/product/protocol/schemas/wfd-read-product.schema.json']) {
      changedImplementation(path, () => {
        assert.throws(() => verify('algorithms.screen'), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' }, path);
        verify('algorithms.status');
      });
      for (const action of actions) verify(action);
    }
  });

  await t.test('external protocol and Python query bytes invalidate the frozen connection independently of repository copies', {
    skip: !f.machine && '外置 WFD 连接回归需要显式 WFD_PYTHON',
  }, () => {
    assert.ok(realWorkspace && companion.r1Runtime, companion.r1Configuration?.reason ?? 'missing isolated R1');
    companion.r1Workspace = realWorkspace;
    try {
      assert.equal(realWorkspace.capabilities().configuration.state, 'configured');
      assert.equal(registry.get('algorithms.screen').availability.available, true);
      const connection = companion.r1Runtime.currentIdentity();
      const baseline = companion.r1Runtime.currentReadBinding();
      assert.deepEqual(realWorkspace.readBinding(), baseline);
      const task = { ...frozen.get('algorithms.screen')!, versions: registry.captureVersions('algorithms.screen', {}) };
      for (const [file, digest] of [['protocol/schemas/wfd-read-product.schema.json', 'readSchemaSha256'],
        ['protocol/schemas/wfd-common.schema.json', 'readSchemaSha256'], ['wfd_sdk/product_query.py', 'queryImplSha256'],
        ['wfd_sdk/indexed_tabular_query.py', 'queryImplSha256']] as const) {
        assert.match(baseline[digest], /^[0-9a-f]{64}$/u);
        const path = join(externalRoot, file), original = fs.readFileSync(path);
        try {
          fs.appendFileSync(path, '\n');
          const current = companion.r1Runtime.currentReadBinding();
          assert.deepEqual(companion.r1Runtime.currentIdentity(), connection);
          assert.notEqual(current[digest], baseline[digest]);
          assert.deepEqual({ ...current, [digest]: baseline[digest] }, baseline, '仅对应外置文件摘要改变');
          assert.throws(() => registry.assertTaskVersions(task), { code: 'DIRECT_VERSION_CONFLICT' });
        } finally { fs.writeFileSync(path, original); }
        registry.assertTaskVersions(task);
      }
      const readerPath = join(externalRoot, 'wfd_sdk/indexed_tabular_query.py');
      fs.renameSync(readerPath, readerPath + '.offline');
      try {
        assert.deepEqual(realWorkspace.capabilities().connection, connection);
        assert.throws(() => realWorkspace.readBinding(), /indexed_tabular_query.py/u);
        assert.throws(() => registry.assertTaskVersions(task));
      } finally { fs.renameSync(readerPath + '.offline', readerPath); }
      registry.assertTaskVersions(task);
    } finally { companion.r1Workspace = workspace; }
  });

  await t.test('joint_experimental storage disables the five fixed-product operators on the real host', {
    skip: !f.machine && '需要隔离连接配置',
  }, () => {
    const saved = fs.readFileSync(f.configPath);
    try {
      fs.writeFileSync(f.configPath, JSON.stringify({ ...JSON.parse(saved.toString()), storage_format: 'joint_experimental' }));
      assert.equal(realWorkspace!.capabilities().readProductSupported, false);
      const operators = companion.toolLibrary!.view().tools.slice(-5);
      assert.ok(operators.every(tool => tool.status === 'unavailable' && tool.reason?.includes('read_product')));
      verify('algorithms.status');
    } finally { fs.writeFileSync(f.configPath, saved); }
    assert.ok(companion.toolLibrary!.view().tools.slice(-5).every(tool => tool.status === 'ready'));
  });

  await t.test('Python algorithm service upgrades invalidate calculation and publication only', () => {
    let revision = 'one';
    companion.algorithms = { get versionBinding() { return { python: revision }; } } as NonNullable<typeof companion.algorithms>;
    try {
      const before = actions.map(action => ({ ...frozen.get(action)!, versions: registry.captureVersions(action, {}) }));
      revision = 'two';
      for (const task of before) {
        if (publication.includes(task.action)) assert.throws(() => registry.assertTaskVersions(task), { code: 'DIRECT_VERSION_CONFLICT' });
        else registry.assertTaskVersions(task);
      }
    } finally { companion.algorithms = undefined; }
  });

  await t.test('reader implementation binding and actual connection are frozen even without an algorithm service; missing ports stay null-safe', () => {
    const initialVersion = version, initialConnection = connection;
    const originalWorkspace = companion.r1Workspace!;
    for (const invalidWorkspace of [
      { ...originalWorkspace, readBinding: () => ({}) },
      { ...originalWorkspace, readBinding: () => ({ readSchemaSha256: '', queryImplSha256: '' }) },
      { ...originalWorkspace, readBinding: () => ({ readSchemaSha256: 'b'.repeat(64), queryImplSha256: 'not-hex' }) },
      { ...originalWorkspace, capabilities: undefined, readBinding: () => ({}) },
    ]) {
      companion.r1Workspace = invalidWorkspace as unknown as typeof originalWorkspace;
      try {
        for (const action of [...publication, 'algorithms.screen']) {
          assert.throws(() => registry.captureVersions(action, {}), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
        }
      } finally { companion.r1Workspace = originalWorkspace; }
    }
    for (const change of [() => { version = { ...version, r1Workspace: 'synthetic-read/2' }; },
      () => { connection = { ...connection, configSha256: 'b'.repeat(64) }; },
      () => { companion.r1Workspace = undefined; }]) {
      try {
        change();
        for (const action of [...publication, 'algorithms.screen']) {
          assert.doesNotThrow(() => registry.captureVersions(action, {}));
          assert.throws(() => verify(action), { code: 'DIRECT_VERSION_CONFLICT' });
        }
        verify('algorithms.status');
      } finally { version = initialVersion; connection = initialConnection; companion.r1Workspace = workspace; }
      for (const action of actions) verify(action);
    }
  });
});

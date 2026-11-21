import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
import { createFullChainFixture } from './full-chain-test-support.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const backend: Backend = { id: 'synthetic-version-only', createSession: async () => { throw new Error('No model in version binding regression'); } };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, provider: null, model: null,
  notice: 'Isolated host version checks; no external WFD, model or algorithm execution.' };

/** 对真实实现文件的读回字节做进程内故障注入；不改源码磁盘，finally 恢复原 fs 导出。 */
function changedImplementation(suffix: string, check: () => void): void {
  const read = fs.readFileSync;
  let matched = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const original = read(...args);
    if (!String(args[0]).replaceAll('\\', '/').endsWith(suffix)) return original;
    matched++;
    return typeof original === 'string' ? original + '\n' : Buffer.concat([original, Buffer.from('\n')]);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { check(); assert.ok(matched > 0, suffix); }
  finally { fs.readFileSync = read; syncBuiltinESMExports(); }
}

test('real algorithm host freezes publication separately from fixed reads and binds WFD without a Python algorithm service', {
  skip: !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT（隔离宿主版本回归）；不读取真实 WFD。', timeout: 30_000,
}, async t => {
  const f = createFullChainFixture({ name: 'algorithm-versions' }), resources = new ResourceBindings(f.runtime);
  const companionDb = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(backend, { database: companionDb });
  const companion = createApplicationServices(companionCore, companionDb, { role: 'service', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources });
  let version = { r1Workspace: 'synthetic-read/1', protocol: 'wfd.structured-ingest/1.0', profile: 'data_only' };
  let connection = { connectionId: 'synthetic-fixed-read', profile: 'data_only', configSha256: 'a'.repeat(64) };
  const workspace = { get versionBinding() { return version; }, capabilities: () => ({ connection }),
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

  await t.test('publication and G5 changes reject the original versions; screen and status retain their read-only dependency scope', () => {
    const r1Baseline = directImplementationVersion(['r1']);
    for (const path of ['modules/financial/derived-wfd-publisher.ts', 'modules/financial/derived-wfd-check.ts',
      'modules/financial/algorithm-reference.ts', 'modules/collection/wfd-publish-restriction.ts',
      'modules/collection/r1-structured-handoff.ts', 'modules/collection/source-field-profile.ts',
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
      'contracts/r1-contracts.ts', 'contracts/financial-value.ts', 'adapters/database/wfd-product-machine.ts',
      'wfd/product/protocol/schemas/wfd-read-product.schema.json']) {
      changedImplementation(path, () => {
        assert.throws(() => verify('algorithms.screen'), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' }, path);
        verify('algorithms.status');
      });
      for (const action of actions) verify(action);
    }
  });

  await t.test('reader implementation binding and actual connection are frozen even without an algorithm service; missing ports stay null-safe', () => {
    const initialVersion = version, initialConnection = connection;
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

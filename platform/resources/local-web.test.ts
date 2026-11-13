import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ResourceBindings } from './bindings.js';
import { applicationResources, NATIVE_WEB_IDENTITY } from './local-web.js';
import { checkNodeDependencies, isolatedPythonArgs, nativeEnvironment, readJson, sha256File } from './native-check.mjs';
import { prepareLocalWeb, readLocalWebConfiguration, type LocalWebConfiguration } from '../../scripts/bootstrap-local-web.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const testRoot = process.env.XUAN_TEST_ROOT ?? tmpdir();
const python = process.env.WFD_PYTHON;
const npmCli = process.env.XUAN_TEST_NPM_CLI;
const systemRoot = process.platform === 'win32' ? process.env.SystemRoot : undefined;
function fixture(name: string): string { return realpathSync(mkdtempSync(join(testRoot, `xuan-bootstrap-${name}-`))); }
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function basicBindings(root: string, resources: Record<string, unknown> = {}): ResourceBindings {
  mkdirSync(join(root, 'config'));
  json(join(root, '.xuan-runtime.json'), { application: 'xuan-bd', version: 1, identity: 'isolated-bootstrap-unit' });
  json(join(root, 'config/machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity: 'isolated-bootstrap-unit', resources });
  return new ResourceBindings(root);
}

test('Vite configuration imports without any locator or runtime bindings', () => {
  const root = fixture('vite');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'const {default:c}=await import("./vite.config.ts"); console.log(JSON.stringify({cacheDir:c.cacheDir}));'], {
    cwd: codeRoot, env: { ...nativeEnvironment(systemRoot), HOME: join(root, 'no-home'), XUAN_BD_HOME: join(root, 'no-runtime') }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cacheDir, join(codeRoot, 'node_modules/.vite'));
  assert.equal(existsSync(join(root, 'no-home')), false);
  assert.equal(existsSync(join(root, 'no-runtime')), false);
});

test('absent bundled resources never auto-select native or PATH programs', () => {
  const root = fixture('strict'), source = join(root, 'code'), runtime = join(root, 'runtime');
  mkdirSync(source); mkdirSync(runtime);
  assert.throws(() => applicationResources(source, basicBindings(runtime)), /ENOENT/u);
});

test('native policy needs explicit bound identity and matching content digest', () => {
  const root = fixture('policy');
  const resources = basicBindings(root, { local_web_policy: { kind: 'file', path: 'config/policy.json', identity: NATIVE_WEB_IDENTITY } });
  json(join(root, 'config/policy.json'), { version: 1, mode: 'native' });
  assert.throws(() => applicationResources(codeRoot, resources), { code: 'LOCAL_WEB_POLICY_UNVERIFIED' });
});

test('npm lock checks installed versions and cannot accept a stale dependency declaration', () => {
  const root = fixture('lock');
  mkdirSync(join(root, 'config')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'node_modules/tiny'));
  for (const part of ['local-web-toolchain.json', 'local-web-python-requirements.txt']) copyFileSync(join(codeRoot, 'config', part), join(root, 'config', part));
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: { tiny: '1.2.3' } };
  json(join(root, 'package.json'), pkg);
  json(join(root, 'package-lock.json'), { lockfileVersion: 3, packages: { '': pkg, 'node_modules/tiny': { version: '1.2.3' } } });
  json(join(root, 'node_modules/tiny/package.json'), { name: 'tiny', version: '1.2.3' });
  assert.equal(checkNodeDependencies(root).checked, 1);
  writeFileSync(join(root, 'node_modules/tiny/package.json'), JSON.stringify({ name: 'tiny', version: '1.2.4' }));
  assert.throws(() => checkNodeDependencies(root), { code: 'LOCAL_WEB_NODE_PACKAGES' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, dependencies: { tiny: '^1.2.3' } }));
  assert.throws(() => checkNodeDependencies(root), { code: 'LOCAL_WEB_NPM_LOCK' });
});

test('bootstrap rejects unknown or enabled-model configuration without creating a target', () => {
  const root = fixture('template'), path = join(root, 'configuration.json');
  json(path, { ...readJson(join(codeRoot, 'config/local-web.example.json')), model: 'enabled' });
  assert.throws(() => readLocalWebConfiguration(path), { code: 'LOCAL_WEB_CONFIG_INVALID' });
});

test('Python test runner requires an explicit interpreter and never falls back to python3', () => {
  const result = spawnSync(process.execPath, ['scripts/test-local.mjs', '--python-only'], {
    cwd: codeRoot, env: nativeEnvironment(systemRoot), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /显式 --python/u);
});

test('isolated Python source arguments ignore an existing valid-but-stale bytecode cache without deleting it',
  { skip: !python ? 'Requires an explicitly selected WFD_PYTHON; no interpreter discovery.' : false }, () => {
    const root = fixture('python-cache'), cacheRoot = join(root, 'fresh-pycache');
    const env = nativeEnvironment(systemRoot);
    const run = (args: string[]) => {
      const result = spawnSync(python!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const setup = `import sys, pathlib, importlib.util, importlib._bootstrap_external as be, json
root=pathlib.Path(sys.argv[1]); module=root/'source_cache_fixture.py'
module.write_text('def answer():\\n    return "SOURCE"\\n', encoding='utf-8')
cache=pathlib.Path(importlib.util.cache_from_source(str(module))); cache.parent.mkdir()
code=compile('def answer():\\n    return "STALE"\\n', str(root/'old-origin.py'), 'exec')
cache.write_bytes(be._code_to_timestamp_pyc(code, int(module.stat().st_mtime), len(module.read_bytes())))
print(json.dumps({'module':str(module), 'cache':str(cache)}))`;
    const paths = run(['-I', '-B', '-c', setup, root]);
    const oldDigest = sha256File(paths.cache);
    const probe = 'import sys,json;sys.path.insert(0,sys.argv[1]);import source_cache_fixture as m;print(json.dumps({"value":m.answer(),"filename":m.answer.__code__.co_filename,"prefix":sys.pycache_prefix}))';
    const before = run(['-I', '-B', '-c', probe, root]);
    assert.equal(before.value, 'STALE', '-B alone must demonstrate that existing bytecode is still read');
    const after = run(isolatedPythonArgs(cacheRoot, ['-c', probe, root]));
    assert.equal(after.value, 'SOURCE'); assert.equal(after.filename, paths.module); assert.equal(after.prefix, cacheRoot);
    assert.equal(sha256File(paths.cache), oldDigest, 'The guard must not delete or rewrite existing caches');
    assert.equal(existsSync(cacheRoot), false, '-B must also prevent writes to the newly selected cache prefix');
    json(join(root, 'cache-probe.json'), { before, after, oldCacheSha256: oldDigest });
  });

test('explicit native bootstrap starts basic data with no bundled/browser/transcription/model resources and preserves identity on restart',
  { skip: !python || !npmCli ? 'Requires explicitly selected WFD_PYTHON and XUAN_TEST_NPM_CLI; no host discovery.' : false }, async () => {
    const root = fixture('native'), runtimeRoot = join(root, 'runtime'), launcherFile = join(root, 'launcher.json');
    const configuration: LocalWebConfiguration = { version: 1, resourceMode: 'native', runtimeRoot, launcherFile,
      node: process.execPath, npmCli: npmCli!, python: python!, model: 'disabled', browser: 'disabled', transcription: 'disabled',
      ...(systemRoot ? { systemRoot } : {}) };
    const prepared = prepareLocalWeb(codeRoot, configuration), originalLocator = readFileSync(launcherFile, 'utf8');
    assert.equal(existsSync(join(runtimeRoot, 'config/model.json')), false);
    const bindings = new ResourceBindings(runtimeRoot), selected = applicationResources(codeRoot, bindings);
    assert.equal(selected.mode, 'native'); assert.equal(selected.modelDisabled, true);
    assert.match(selected.transcriptionUnavailableReason!, /明确禁用/u);
    assert.throws(() => selected.browser(), { code: 'LOCAL_WEB_BROWSER_DISABLED' });
    for (const id of ['bundle_manifest', 'browser_engine', 'ffmpeg', 'whisper_base', 'connections_registry']) assert.equal(bindings.document.resources[id], undefined);
    assert.throws(() => prepareLocalWeb(codeRoot, configuration), { code: 'LOCAL_WEB_TARGET_EXISTS' });
    assert.equal(readFileSync(launcherFile, 'utf8'), originalLocator);
    const { startConfiguredApplication } = await import('../../apps/server/configured-app.js');
    const webRoot = join(root, 'static-web'); mkdirSync(webRoot); json(join(webRoot, 'fixture.json'), { staticFixture: true });
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>isolated bootstrap fixture</title>');
    for (let attempt = 0; attempt < 2; attempt++) {
      const application = await startConfiguredApplication({ workspaceRoot: runtimeRoot, codeRoot, webRoot, launcherFile, port: 0, workspaceCompanion: true });
      try {
        assert.equal(application.health.configured, false);
        assert.equal(application.health.model, null);
        assert.match(application.health.notice!, /模型代理明确未启用/u);
        const address = application.running.server.address();
        assert.ok(address && typeof address === 'object' && address.address === '127.0.0.1');
        const base = `http://127.0.0.1:${address.port}`;
        const health = await fetch(base + '/api/health'); assert.equal(health.status, 200);
        assert.equal((await health.json()).configured, false);
        const page = await fetch(base + '/'); assert.equal(page.status, 200);
        const materials = await fetch(base + '/api/ui/data-browser/materials', { headers: { 'x-local-data-generation': '1' } });
        assert.equal(materials.status, 200, await materials.clone().text());
        assert.equal((await materials.json()).availability, 'available');
        assert.ok('services' in application.running);
        assert.match(application.running.services!.options.browserUnavailableReason!, /native 策略明确禁用/u);
        assert.match(application.running.services!.options.captureUnavailableReason!, /native 策略明确禁用/u);
      } finally { await application.running.shutdown(); }
      assert.equal(new ResourceBindings(runtimeRoot).document.runtimeIdentity, prepared.runtimeIdentity);
      assert.equal(readFileSync(launcherFile, 'utf8'), originalLocator);
    }
    const policyPath = bindings.path('local_web_policy'), before = sha256File(policyPath);
    writeFileSync(policyPath, readFileSync(policyPath, 'utf8') + ' ');
    assert.notEqual(sha256File(policyPath), before);
    assert.throws(() => applicationResources(codeRoot, new ResourceBindings(runtimeRoot)), { code: 'LOCAL_WEB_POLICY_UNVERIFIED' });
  });

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ownStateRoot } from '../apps/server/boot.js';
import { CoreDatabase } from '../platform/state/database.js';
import { ResourceBindings } from '../platform/resources/bindings.js';
import { acquireRuntimeStartupFence } from '../platform/runtime/runtime-profile.js';
import { capturePolarsEnvironment, planPolarsPythonAdoption, adoptPolarsPython } from './adopt-polars-python.js';

const pythonExecutable = process.env.POLARS_PYTHON;
const enabled = process.platform === 'darwin' && !!pythonExecutable;
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function fixture() {
  const base = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'polars-adoption-')));
  const runtimeRoot = join(base, 'runtime'), recordRoot = join(base, 'evidence'), state = join(runtimeRoot, 'state');
  for (const path of [runtimeRoot, recordRoot, join(runtimeRoot, 'config'), state, join(state, 'personal'), join(state, 'workspace')]) mkdirSync(path);
  for (const role of ['personal', 'workspace']) { const db = new CoreDatabase(join(state, role, 'core.sqlite')); db.close(); }
  const runtimeIdentity = 'isolated-polars-' + randomUUID(), launcherFile = join(base, 'launcher.json');
  const original = { version: 1, revision: 1, runtimeIdentity, resources: { state: { path: state, kind: 'directory' },
    config: { path: join(runtimeRoot, 'config'), kind: 'directory' }, python: { path: process.execPath, kind: 'program' },
    untouched: { path: join(base, 'unrelated'), kind: 'file' } } };
  const binding = join(runtimeRoot, 'config/machine.bindings.json'); write(binding, original);
  write(join(runtimeRoot, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity: runtimeIdentity });
  write(launcherFile, { version: 1, runtimeRoot, runtimeIdentity });
  return { base, state, original, binding, request: { pythonExecutable: pythonExecutable!, runtimeIdentity, expectedRevision: 1,
    runtimeRoot, launcherFile, recordRoot } };
}

test('Polars adoption plans the real locked environment and atomically changes only the optional binding', { skip: !enabled, timeout: 60_000 }, async () => {
  const f = fixture(), original = readFileSync(f.binding), mode = statSync(f.binding).mode;
  const plan = planPolarsPythonAdoption(f.request);
  assert.equal(readFileSync(f.binding).equals(original), true);
  assert.equal(plan.environment.polarsVersion, '2.0.0'); assert.equal(plan.environment.runtimeVersion, '2.0.0');
  assert.equal(plan.environment.nativeCalculation, '3.75'); assert.ok(plan.environment.packageFileCount > 0);
  assert.match(plan.environment.nativeFiles[0].sha256, /^[a-f0-9]{64}$/u);
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/u);
  const applied = await adoptPolarsPython({ ...f.request, expectedEnvironmentVersion: plan.expectedEnvironmentVersion, expectedPlanSha256: plan.planSha256 });
  assert.equal(applied.status, 'committed');
  const after = new ResourceBindings(f.request.runtimeRoot).document;
  assert.equal(after.revision, 2); assert.deepEqual(after.resources.python, f.original.resources.python);
  assert.deepEqual(Object.fromEntries(Object.entries(after.resources).filter(([key]) => key !== 'polars_python')), f.original.resources);
  assert.equal(after.resources.polars_python!.path, pythonExecutable);
  assert.equal(after.resources.polars_python!.sha256, plan.environment.programSha256);
  assert.equal(readFileSync(join(applied.record, 'bindings-before.json')).equals(original), true);
  assert.equal(readFileSync(join(applied.record, 'bindings-after.json')).equals(readFileSync(f.binding)), true);
  assert.equal(statSync(f.binding).mode, mode);
  assert.equal(JSON.parse(readFileSync(applied.journal, 'utf8')).phase, 'committed');
  assert.equal(existsSync(join(f.request.runtimeRoot, 'config/.bindings-maintenance.lock')), false);
  assert.equal(existsSync(f.request.launcherFile + '.runtime-maintenance.lock'), false);
  for (const role of ['personal', 'workspace']) assert.equal(existsSync(join(f.state, role, '.bd-owner.lock')), false);
  write(join(f.base, 'verification.json'), { passed: true, request: f.request, plan, applied, originalPythonPreserved: true });
});

test('Polars adoption refuses running owners, startup contention, identity/version drift and changed environment', { skip: !enabled, timeout: 60_000 }, async () => {
  const f = fixture(), original = readFileSync(f.binding), plan = planPolarsPythonAdoption(f.request);
  const apply = () => adoptPolarsPython({ ...f.request, expectedEnvironmentVersion: plan.expectedEnvironmentVersion, expectedPlanSha256: plan.planSha256 });
  await assert.rejects(adoptPolarsPython(f.request), /环境摘要和完整计划摘要/u);
  assert.throws(() => planPolarsPythonAdoption({ ...f.request, runtimeIdentity: 'different-identity' }), /身份/u);
  assert.throws(() => planPolarsPythonAdoption({ ...f.request, expectedRevision: 2 }), /修订/u);
  await assert.rejects(adoptPolarsPython({ ...f.request, expectedEnvironmentVersion: 'sha256:' + '0'.repeat(64), expectedPlanSha256: plan.planSha256 }), /环境摘要/u);
  await assert.rejects(adoptPolarsPython({ ...f.request, expectedEnvironmentVersion: plan.expectedEnvironmentVersion, expectedPlanSha256: 'sha256:' + '0'.repeat(64) }), /计划已变化/u);
  const release = await ownStateRoot(join(f.state, 'workspace/core.sqlite'));
  try { await assert.rejects(apply(), /状态所有者|遗留锁/u); } finally { await release(); }
  const startup = acquireRuntimeStartupFence(f.request.launcherFile, f.request.runtimeRoot);
  try { await assert.rejects(apply(), /EEXIST/u); } finally { startup.release(); }
  const configuration = join(dirname(dirname(pythonExecutable!)), 'pyvenv.cfg'), raw = readFileSync(configuration);
  try {
    writeFileSync(configuration, Buffer.concat([raw, Buffer.from('\n# isolated adoption change detection\n')]));
    await assert.rejects(apply(), /环境摘要/u);
  } finally { writeFileSync(configuration, raw); }
  assert.equal(readFileSync(f.binding).equals(original), true);
  assert.equal(capturePolarsEnvironment(pythonExecutable!).environmentVersion, plan.expectedEnvironmentVersion);
  assert.equal(existsSync(join(f.request.runtimeRoot, 'config/.bindings-maintenance.lock')), false);
  write(join(f.base, 'rejections.json'), { passed: true, changedEnvironmentRejected: true, allBindingsPreserved: true,
    refused: ['missing fixed hashes', 'runtime identity', 'revision', 'environment hash', 'plan hash', 'live state owner', 'startup fence', 'changed venv configuration'] });
});

test('real Polars adoption CLI accepts the numeric sha256 flag and applies its exact isolated plan', { skip: !enabled, timeout: 60_000 }, () => {
  const f = fixture(), before = readFileSync(f.binding);
  const script = fileURLToPath(new URL('./adopt-polars-python.ts', import.meta.url));
  const args = [`--python-executable=${pythonExecutable}`, `--runtime-root=${f.request.runtimeRoot}`,
    `--runtime-identity=${f.request.runtimeIdentity}`, '--expected-revision=1', `--record-root=${f.request.recordRoot}`, `--launcher=${f.request.launcherFile}`];
  const invoke = (mode: string, extra: string[] = []) => {
    const processResult = spawnSync(process.execPath, ['--import', 'tsx', script, mode, ...args, ...extra], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(processResult.status, 0, processResult.stderr || processResult.stdout);
    return JSON.parse(processResult.stdout);
  };
  const plan = invoke('plan');
  assert.equal(readFileSync(f.binding).equals(before), true);
  const applied = invoke('apply', [`--expected-environment-version=${plan.expectedEnvironmentVersion}`, `--expected-plan-sha256=${plan.planSha256}`]);
  assert.equal(applied.status, 'committed'); assert.equal(applied.planSha256, plan.planSha256);
  assert.equal(readFileSync(join(applied.record, 'bindings-before.json')).equals(before), true);
  const after = new ResourceBindings(f.request.runtimeRoot).document;
  assert.equal(after.revision, 2); assert.equal(after.resources.polars_python!.path, pythonExecutable);
  assert.deepEqual(after.resources.python, f.original.resources.python);
  write(join(f.base, 'cli-plan.json'), plan); write(join(f.base, 'cli-apply.json'), applied);
});

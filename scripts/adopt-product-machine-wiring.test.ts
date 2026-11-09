import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConnectionRegistry } from '../platform/config/connections.js';
import { adoptProductMachineWiring, writeAll } from './adopt-product-machine-wiring.js';

const TEST_ID = 'isolated-user-test';
const NEW_ID = 'r1-manual-production-isolated';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function fixture() {
  const base = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'r1-wiring-')));
  const root = join(base, 'bd'), configDir = join(root, 'config'), store = join(base, 'store'), runtime = join(base, 'wfd-runtime');
  for (const path of [root, configDir, store, runtime]) mkdirSync(path);
  const registryPath = join(configDir, 'connections.json'), entryPath = join(base, 'product-machine.py');
  writeFileSync(entryPath, '# isolated fixture; never executed\n');
  const configPath = join(configDir, 'production.json'), oldConfigPath = join(configDir, 'user-test.json');
  write(configPath, { protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only',
    connection_id: NEW_ID, store, runtime });
  write(oldConfigPath, { protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only',
    connection_id: TEST_ID, store, runtime });
  const profile = (id: string, mode: 'user_test' | 'production', path: string) => ({
    id, kind: 'wfd-product-machine', mode, purpose: mode, protocol: 'wfd.product-machine/0.1',
    config_path: path, store, runtime, python_path: process.execPath, entry_path: entryPath,
    harness_binding: { root, root_id: 'isolated-r1-wiring' },
  });
  const old = profile(TEST_ID, 'user_test', oldConfigPath), registry = { connections: [old] };
  write(registryPath, registry);
  write(join(root, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity: 'isolated-r1-wiring' });
  write(join(configDir, 'machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity: 'isolated-r1-wiring',
    resources: { config: { path: configDir, kind: 'directory' }, connections_registry: { path: registryPath, kind: 'file' } } });
  const contract = (id = NEW_ID, environment: 'user_test' | 'production' = 'production') => ({
    version: 1, connection_id: id, environment, harness_root: root, harness_root_id: 'isolated-r1-wiring',
    maintenance_intent: `register-${id}`, ...(environment === 'production'
      ? { profile: 'data_only', manual_ingest_connection_id: id } : {}),
    ...profile(id, environment, id === TEST_ID ? oldConfigPath : configPath),
  });
  const contractPath = join(base, 'contract.json');
  const adopt = (value: unknown, apply = false, recover = false) => { write(contractPath, value);
    return adoptProductMachineWiring({ contractPath, runtimeRoot: root, apply, recover }); };
  return { base, root, store, runtime, registryPath, configPath, contractPath, old, registry, profile, contract, adopt };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
function interrupted(f: ReturnType<typeof fixture>) {
  const contract = f.contract(); f.adopt(contract);
  const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(exited.status, 0); assert.ok(exited.pid && exited.pid !== process.pid);
  const beforeRaw = readFileSync(f.registryPath, 'utf8');
  const next = { ...JSON.parse(beforeRaw), connections: [...f.registry.connections, f.profile(NEW_ID, 'production', f.configPath)],
    manual_ingest_connection_id: NEW_ID };
  const afterRaw = JSON.stringify(next, null, 2) + '\n';
  const journalPath = f.registryPath + '.product-machine-wiring.json';
  const journal = { version: 2, kind: 'product-machine-wiring', id: 'isolated-interrupted-intent', phase: 'prepared', pid: exited.pid,
    contractSha256: sha(readFileSync(f.contractPath, 'utf8')), maintenanceIntent: contract.maintenance_intent,
    registryPath: f.registryPath, runtimeRoot: f.root, runtimeIdentity: 'isolated-r1-wiring', connectionId: NEW_ID,
    before: sha(beforeRaw), after: sha(afterRaw), at: '2026-10-31T00:00:00Z' };
  return { contract, beforeRaw, afterRaw, journalPath, journal };
}

test('bounded writes finish every short chunk and reject zero progress', () => {
  const f = fixture(), path = join(f.base, 'short-write.bin'), expected = '短写验证-' + 'abc123'.repeat(2048);
  const fd = openSync(path, 'wx'); let calls = 0;
  try { writeAll(fd, expected, (target, bytes, offset, length, position) => {
    calls += 1; return writeSync(target, bytes, offset, Math.min(length, 7), position);
  }); } finally { closeSync(fd); }
  assert.ok(calls > 1000); assert.equal(readFileSync(path, 'utf8'), expected);
  const zero = openSync(join(f.base, 'zero-progress.bin'), 'wx');
  try { assert.throws(() => writeAll(zero, 'not-written', () => 0), code('WIRING_SHORT_WRITE')); }
  finally { closeSync(zero); }
});

test('production plan is read-only; apply atomically registers and selects, reads back, then is idempotent', () => {
  const f = fixture(), before = readFileSync(f.registryPath, 'utf8');
  const plan = f.adopt(f.contract());
  assert.equal(plan.status, 'ready'); assert.equal(plan.applied, false);
  assert.equal('wouldAdd' in plan && plan.wouldAdd, true);
  assert.equal('wouldSelect' in plan && plan.wouldSelect, true);
  assert.equal(readFileSync(f.registryPath, 'utf8'), before);
  assert.equal(existsSync(f.registryPath + '.product-machine-wiring.json'), false);
  const applied = f.adopt(f.contract(), true);
  assert.equal(applied.status, 'committed'); assert.equal(applied.applied, true);
  const after = readFileSync(f.registryPath, 'utf8'), registry = JSON.parse(after);
  assert.deepEqual(registry.connections[0], f.old);
  assert.equal(registry.connections[1].id, NEW_ID);
  assert.equal(registry.connections[1].mode, 'production');
  assert.equal(registry.manual_ingest_connection_id, NEW_ID);
  assert.equal(readConnectionRegistry(f.registryPath)?.manualIngestConnectionId, NEW_ID);
  assert.equal(readdirSync(f.store).length, 0); assert.equal(readdirSync(f.runtime).length, 0);
  assert.equal(existsSync(f.registryPath + '.product-machine-wiring.json'), false);
  const repeated = f.adopt(f.contract(), true);
  assert.equal(repeated.status, 'unchanged'); assert.equal(repeated.applied, false);
  assert.equal(readFileSync(f.registryPath, 'utf8'), after);
});

test('production adoption refuses mixed contract identity, selection drift and replacement', () => {
  const f = fixture();
  assert.throws(() => f.adopt(f.contract(TEST_ID)), code('WIRING_ORIGINAL_IDENTITY_CHANGED'));
  assert.throws(() => f.adopt({ ...f.contract(), mode: 'user_test' }), code('WIRING_CONTRACT_MISMATCH'));
  assert.throws(() => f.adopt({ ...f.contract(), id: 'different-id' }), code('WIRING_CONTRACT_MISMATCH'));
  assert.throws(() => f.adopt({ ...f.contract(), harness_binding: { root: f.root, root_id: 'different-root' } }),
    code('WIRING_CONTRACT_MISMATCH'));
  write(f.registryPath, { ...f.registry, manual_ingest_connection_id: TEST_ID });
  assert.throws(() => f.adopt(f.contract(), true), code('WIRING_SELECTION_CHANGED'));
  write(f.registryPath, { connections: [...f.registry.connections, f.profile(NEW_ID, 'user_test', f.configPath)] });
  assert.throws(() => f.adopt(f.contract(), true), code('WIRING_ORIGINAL_IDENTITY_CHANGED'));
  write(f.registryPath, f.registry);
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  config.profile = 'legacy'; write(f.configPath, config);
  assert.throws(() => f.adopt(f.contract(), true), code('WIRING_CONFIG_MISMATCH'));
  assert.equal(existsSync(f.registryPath + '.product-machine-wiring.json'), false);
});

test('explicit user_test adoption preserves registration identity and does not select manual ingest', () => {
  const f = fixture();
  const old = f.adopt(f.contract(TEST_ID, 'user_test'), true);
  assert.equal(old.status, 'unchanged');
  const newTestId = 'separate-user-test';
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  config.connection_id = newTestId; write(f.configPath, config);
  const applied = f.adopt(f.contract(newTestId, 'user_test'), true);
  assert.equal(applied.status, 'committed');
  const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'));
  assert.equal(registry.connections.length, 2);
  assert.equal(registry.manual_ingest_connection_id, undefined);
});

test('exclusive journal blocks apply and live-owner recovery; exited owner before-state can be closed explicitly', () => {
  const f = fixture(), pending = interrupted(f);
  write(pending.journalPath, { ...pending.journal, pid: process.pid });
  const activeRaw = readFileSync(pending.journalPath, 'utf8');
  assert.throws(() => f.adopt(pending.contract, true), code('WIRING_PENDING'));
  assert.throws(() => f.adopt(pending.contract, false, true), code('WIRING_ACTIVE'));
  assert.equal(readFileSync(pending.journalPath, 'utf8'), activeRaw);
  assert.equal(readFileSync(f.registryPath, 'utf8'), pending.beforeRaw);
  write(pending.journalPath, pending.journal);
  const recovered = f.adopt(pending.contract, false, true);
  assert.equal(recovered.status, 'recovered_not_applied');
  assert.equal(existsSync(pending.journalPath), false);
  assert.equal(readFileSync(f.registryPath, 'utf8'), pending.beforeRaw);
});

test('exited-owner after-state recovery confirms registry only, even if WFD config disappeared', () => {
  const f = fixture(), pending = interrupted(f);
  write(pending.journalPath, pending.journal);
  writeFileSync(f.registryPath, pending.afterRaw);
  unlinkSync(f.configPath);
  const recovered = f.adopt(pending.contract, false, true);
  assert.equal(recovered.status, 'recovered_committed');
  assert.equal(existsSync(pending.journalPath), false);
  assert.equal(readFileSync(f.registryPath, 'utf8'), pending.afterRaw);
});

test('foreign or damaged journal and third registry digest remain untouched', () => {
  const f = fixture(), pending = interrupted(f);
  write(pending.journalPath, { ...pending.journal, contractSha256: '0'.repeat(64) });
  const foreignRaw = readFileSync(pending.journalPath, 'utf8');
  assert.throws(() => f.adopt(pending.contract, false, true), code('WIRING_JOURNAL_INVALID'));
  assert.equal(readFileSync(pending.journalPath, 'utf8'), foreignRaw);
  writeFileSync(pending.journalPath, '{not-json');
  assert.throws(() => f.adopt(pending.contract, false, true), code('WIRING_JOURNAL_INVALID'));
  assert.equal(readFileSync(pending.journalPath, 'utf8'), '{not-json');
  write(pending.journalPath, pending.journal);
  write(f.registryPath, { ...f.registry, unrelated_change: true });
  const thirdRaw = readFileSync(pending.journalPath, 'utf8');
  assert.throws(() => f.adopt(pending.contract, false, true), code('WIRING_RECOVERY_CONFLICT'));
  assert.equal(readFileSync(pending.journalPath, 'utf8'), thirdRaw);
});

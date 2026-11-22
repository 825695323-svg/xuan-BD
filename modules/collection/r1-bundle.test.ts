import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WFD_BUNDLE_OPERATIONS, WfdProductMachineClient, WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { R1_BUNDLE_VERSION, R1BundleService } from './r1-bundle.js';
import { createR1HandoffRuntime } from './r1-runtime.js';

const snapshotId = 's_' + '1'.repeat(24), descriptorSha256 = 'sha256:' + 'a'.repeat(64);
const selection = { requestId: 'stable', packageName: 'bundle', snapshotId, products: [{ product_id: 'p_synthetic' }] };

// Synthetic process exercises transport failures and scheduling races which a successful WFD run cannot inject.
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bd-bundle-dispatch-')));
  const packages = join(root, 'packages'), configPath = join(root, 'config.json'), log = join(root, 'calls');
  const entryPath = join(root, 'fixture.cjs');
  const sdk = join(root, 'external-wfd', 'wfd_sdk'), product = fileURLToPath(new URL('../../wfd/product/', import.meta.url));
  const store = join(root, 'store'), wfdRuntime = join(root, 'wfd-runtime');
  for (const dir of [packages, store, wfdRuntime, sdk, join(root, 'config')]) mkdirSync(dir, { recursive: true });
  for (const name of ['product_query.py', 'indexed_tabular_query.py', 'filter_plan.py', 'product_machine_bundle.py', 'product_bundle.py', 'transfer.py'])
    copyFileSync(join(product, 'wfd_sdk', name), join(sdk, name));
  const registry = join(root, 'config', 'connections.json');
  writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ application: 'xuan-bd', version: 1, identity: 'bundle-test' }));
  writeFileSync(join(root, 'config', 'machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'bundle-test',
    resources: { connections_registry: { kind: 'file', path: registry } } }));
  writeFileSync(registry, JSON.stringify({ connections: [{ id: 'isolated', kind: 'wfd-product-machine', mode: 'user_test',
    purpose: 'user_test', protocol: 'wfd.product-machine/0.1', config_path: configPath, store, runtime: wfdRuntime,
    python_path: process.execPath, entry_path: entryPath, harness_binding: { root, root_id: 'bundle-test' } }] }));
  writeFileSync(configPath, JSON.stringify({ protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only',
    connection_id: 'isolated', project_root: join(root, 'external-wfd'), protocol_root: join(product, 'protocol'),
    store, runtime: wfdRuntime, caller: { caller_id: 'operator', trusted_actor_namespace: 'synthetic' },
    bundle_access: { package_root: packages } }), { mode: 0o600 });
  writeFileSync(entryPath, `
const fs = require('node:fs');
let raw = '';
process.stdin.on('data', part => raw += part);
process.stdin.on('end', () => {
  const req = JSON.parse(raw), args = req.arguments;
  const packageName = require('node:path').basename(args.package_path);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + '\\n');
  const identity = { connection_id: 'isolated', caller_id: 'operator', trusted_actor_namespace: 'synthetic' };
  if (packageName === 'wrong-peer') identity.caller_id = 'another';
  const response = { protocol_version: req.protocol_version, request_id: req.request_id, operation: req.operation, identity, ok: true,
    result: { format_version: 'wfd.structured-bundle/1.0', status: 'exported', mode: 'full', read_self_contained: true, source_permission_required: false,
      source_dataset_id: 'synthetic', baseline_snapshot_id: null,
      write_authority_granted: false, bundle_id: 'sb_' + '2'.repeat(24), descriptor_sha256: ${JSON.stringify(descriptorSha256)},
      source_snapshot_id: ${JSON.stringify(snapshotId)}, target_snapshot_id: 's_' + '3'.repeat(24),
      products: [{ product_id: 'p_synthetic', source_product_id: 'p_synthetic', row_count: 1, rows_sha256: 'sha256:' + 'b'.repeat(64) }] } };
  if (packageName === 'lost') Object.assign(response, { ok: false, result: null,
    error: { code: 'PROCESS_OUTPUT_FAILED', message: 'synthetic output fault' } });
  if (packageName === 'bad-result') response.result.descriptor_sha256 = 'invalid';
  if (packageName === 'bad-utf8') {
    return process.stdout.write(Buffer.concat([Buffer.from(JSON.stringify(response).slice(0, -1) + ',"note":"'),
      Buffer.from([0xff]), Buffer.from('"}')]));
  }
  if (packageName === 'bad-denial') Object.assign(response, { ok: false, error: { code: 'REQUEST_INVALID', message: 'invalid' } });
  if (packageName.startsWith('error-')) {
    const unwritten = { operation: req.operation, may_have_written: false, descriptor_sha256: args.descriptor_sha256 };
    const details = {
      'error-missing': {}, 'error-type': { write_context: 'invalid' }, 'error-flag': { write_context: { operation: req.operation, may_have_written: 'false' } },
      'error-other': { write_context: { operation: 'other', may_have_written: false } },
      'error-positive': { write_context: unwritten, write_may_have_happened: true },
      'error-descriptor-missing': { write_context: { operation: req.operation, may_have_written: false } },
      'error-descriptor-mismatch': { write_context: { ...unwritten, descriptor_sha256: 'sha256:' + 'b'.repeat(64) } },
      'error-confirmed': { write_context: unwritten },
    }[packageName];
    Object.assign(response, { ok: false, result: null, error: { code: 'INTERNAL_ERROR', message: 'synthetic error receipt', details } });
  }
  if (packageName === 'delayed') return setTimeout(() => process.stdout.write(JSON.stringify(response)), 5000);
  process.stdout.write(JSON.stringify(response));
});`);
  const control = { stopped: false, generation: 1 };
  const dbPath = join(root, 'bd.sqlite');
  const database = new CoreDatabase(dbPath);
  const runtime = createR1HandoffRuntime({ database, resources: new ResourceBindings(root), connectionId: 'isolated' });
  const options = { database, runtime, control: () => control };
  return { service: new R1BundleService(options), database, options, control, configPath, sdk, log, packages, dbPath };
}

test('RequestId coalesces concurrent dispatch and survives reopening the BD database', async () => {
  const f = setup();
  try {
    const [a, b] = await Promise.all([f.service.dispatch('bundle_export_full', selection), f.service.dispatch('bundle_export_full', selection)]);
    assert.deepEqual(a, b);
    assert.equal(a.version, R1_BUNDLE_VERSION);
    const request = JSON.parse(readFileSync(f.log, 'utf8'));
    assert.equal(request.arguments.package_path, join(f.packages, 'bundle'));
    assert.equal(request.request_id, selection.requestId);
    assert.throws(() => f.service.dispatch('bundle_export_full', { ...selection, packageName: 'other' }), { code: 'R1_BUNDLE_REQUEST_CONFLICT' });
    f.database.close();
    const database = new CoreDatabase(f.dbPath);
    try {
      const reopened = new R1BundleService({ ...f.options, database });
      assert.deepEqual(await reopened.dispatch('bundle_export_full', selection), a);
      assert.equal(reopened.requestStatus(selection.requestId).state, 'succeeded');
      assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
    } finally { database.close(); }
  } finally { f.database.close(); }
});

test('logical package names, exact nested selections, stopped generation and connection identity are enforced', async () => {
  const f = setup();
  try {
    for (const body of [{ ...selection, packageName: '../escape' }, { ...selection, store: f.packages },
      { ...selection, products: [{ product_id: 'p_synthetic', roles: ['read'] }] }])
      assert.throws(() => f.service.dispatch('bundle_export_full', body), { code: 'R1_BUNDLE_INPUT' });
    symlinkSync(f.packages, join(f.packages, 'link'));
    await assert.rejects(f.service.dispatch('bundle_export_full', { ...selection, packageName: 'link' }), { code: 'BUNDLE_PATH_INVALID' });
    assert.equal(f.service.requestStatus(selection.requestId).state, 'failed');
    const dispatch = f.service.dispatch('bundle_export_full', { ...selection, requestId: 'stale' });
    f.control.generation++;
    await assert.rejects(dispatch, { code: 'BD_STOPPED' });
    assert.equal(f.service.requestStatus('stale').state, 'outcome_unknown');
    f.control.stopped = true;
    assert.throws(() => f.service.dispatch('bundle_export_full', selection), { code: 'BD_STOPPED' });
    f.control.stopped = false;
    await assert.rejects(f.service.dispatch('bundle_export_full', { ...selection, requestId: 'wrong', packageName: 'wrong-peer' }),
      { code: 'R1_CONNECTION_BINDING_CHANGED' });
    appendFileSync(f.configPath, '\n');
    assert.throws(() => f.service.requestStatus('stale'), { code: 'R1_CONNECTION_BINDING_CHANGED' });
  } finally { f.database.close(); }
});

test('all six dispatched bundle operations preserve uncertainty for lost or invalid receipts', async () => {
  const f = setup();
  try {
    for (const op of Object.keys(WFD_BUNDLE_OPERATIONS) as Array<keyof typeof WFD_BUNDLE_OPERATIONS>) {
      const args = WFD_BUNDLE_OPERATIONS[op].writesDatabase ? { descriptorSha256 } :
        { ...selection, ...(op === 'bundle_export_delta' ? { baselineSnapshotId: snapshotId } : {}) };
      for (const [packageName, code] of [['lost', 'PROCESS_OUTPUT_FAILED'], ['bad-result', 'WFD_PRODUCT_MACHINE_RESPONSE'],
        ['bad-utf8', 'WFD_PRODUCT_MACHINE_RESPONSE'], ['bad-denial', 'WFD_PRODUCT_MACHINE_RESPONSE']] as const) {
        const requestId = op + '-' + packageName;
        await assert.rejects(f.service.dispatch(op, { ...args, requestId, packageName }),
          (e: unknown) => e instanceof WfdProductMachineError && e.code === code && e.mayHaveBeenAccepted);
        assert.equal(f.service.requestStatus(requestId).state, 'outcome_unknown');
        assert.equal(f.service.requestStatus(requestId).receipt, null);
      }
    }
  } finally { f.database.close(); }
});

test('registered external WFD bytes bind fixed reads and bundle dispatch, status and same-ID recovery', async () => {
  const f = setup();
  try {
    const { runtime } = f.options;
    await f.service.dispatch('bundle_export_full', selection);
    const initial = runtime.currentBundleIdentity(), read = runtime.currentReadBinding();
    appendFileSync(join(f.sdk, 'filter_plan.py'), '\n');
    assert.notEqual(runtime.currentReadBinding().queryImplSha256, read.queryImplSha256);
    assert.deepEqual(runtime.currentBundleIdentity(), initial);
    for (const file of ['product_machine_bundle.py', 'product_bundle.py', 'transfer.py']) {
      const path = join(f.sdk, file), original = readFileSync(path);
      appendFileSync(path, '\n');
      assert.notEqual(runtime.currentBundleIdentity().bundleImplSha256, initial.bundleImplSha256);
      assert.throws(() => f.service.requestStatus(selection.requestId), { code: 'R1_CONNECTION_BINDING_CHANGED' });
      assert.throws(() => f.service.dispatch('bundle_export_full', selection), { code: 'R1_CONNECTION_BINDING_CHANGED' });
      const rebound = new R1BundleService(f.options);
      assert.throws(() => rebound.requestStatus(selection.requestId), { code: 'R1_BUNDLE_REQUEST_NOT_FOUND' });
      assert.throws(() => rebound.dispatch('bundle_export_full', selection), { code: 'R1_BUNDLE_REQUEST_CONFLICT' });
      writeFileSync(path, original);
      assert.equal(f.service.requestStatus(selection.requestId).state, 'succeeded');
    }
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
  } finally { f.database.close(); }
});

test('dispatched errors need affirmative matching no-write evidence to mark any bundle request failed', async () => {
  const f = setup();
  try {
    for (const op of Object.keys(WFD_BUNDLE_OPERATIONS) as Array<keyof typeof WFD_BUNDLE_OPERATIONS>) {
      const args = WFD_BUNDLE_OPERATIONS[op].writesDatabase ? { descriptorSha256 } :
        { ...selection, ...(op === 'bundle_export_delta' ? { baselineSnapshotId: snapshotId } : {}) };
      const kinds = ['missing', 'type', 'flag', 'other', 'positive', 'confirmed'];
      if (WFD_BUNDLE_OPERATIONS[op].writesDatabase) kinds.push('descriptor-missing', 'descriptor-mismatch');
      for (const kind of kinds) {
        const requestId = op + '-' + kind, unknown = kind !== 'confirmed';
        await assert.rejects(f.service.dispatch(op, { ...args, requestId, packageName: 'error-' + kind }),
          { code: 'INTERNAL_ERROR', mayHaveBeenAccepted: unknown });
        assert.equal(f.service.requestStatus(requestId).state, unknown ? 'outcome_unknown' : 'failed');
      }
    }
  } finally { f.database.close(); }
});

test('81734d0 and 9e40cf65 request bindings keep confirmed receipts and unconfirmed requests accessible across upgrade', async () => {
  const f = setup(), op = 'bundle_export_full';
  try {
    const confirmed = await f.service.dispatch(op, selection);
    const baseIdentity = f.options.runtime.currentIdentity();
    const twoFileSha = wfdSha256(canonicalWfdJson([
      ['product_machine_bundle.py', wfdSha256(readFileSync(join(f.sdk, 'product_machine_bundle.py')))],
      ['product_bundle.py', wfdSha256(readFileSync(join(f.sdk, 'product_bundle.py')))],
    ]));
    const legacyRows = [
      ['old', wfdSha256(canonicalWfdJson([f.service.versionBinding, baseIdentity]))],
      ['prev', wfdSha256(canonicalWfdJson([f.service.versionBinding, { ...baseIdentity, bundleImplSha256: twoFileSha }]))],
    ] as const;
    for (const [prefix, binding] of legacyRows) {
      for (const state of ['succeeded', 'outcome_unknown']) {
        const input = { ...selection, requestId: `${prefix}-${state}`, kind: 'export' };
        const fingerprint = wfdSha256(canonicalWfdJson([op, input]));
        f.database.connection.prepare('INSERT INTO r1_bundle_requests VALUES(?,?,?,?,?,?,?)')
          .run(input.requestId, op, binding, fingerprint, state, state === 'succeeded' ? JSON.stringify(confirmed.receipt) : null, null);
      }
    }
    f.database.close();
    const database = new CoreDatabase(f.dbPath);
    try {
      const service = new R1BundleService({ ...f.options, database });
      for (const [prefix] of legacyRows) {
        assert.equal(service.requestStatus(`${prefix}-succeeded`).state, 'succeeded');
        assert.deepEqual((await service.dispatch(op, { ...selection, requestId: `${prefix}-succeeded` })).receipt, confirmed.receipt);
        assert.equal(service.requestStatus(`${prefix}-outcome_unknown`).state, 'outcome_unknown');
        assert.throws(() => service.dispatch(op, { ...selection, requestId: `${prefix}-outcome_unknown` }),
          { code: 'R1_BUNDLE_LEGACY_OUTCOME_UNCONFIRMED', mayHaveBeenAccepted: true });
        assert.throws(() => service.dispatch(op, { ...selection, requestId: `${prefix}-succeeded`, packageName: 'changed' }),
          { code: 'R1_BUNDLE_REQUEST_CONFLICT' });
      }
      assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
      appendFileSync(join(f.sdk, 'product_bundle.py'), '\n');
      assert.throws(() => service.requestStatus(selection.requestId), { code: 'R1_CONNECTION_BINDING_CHANGED' });
      const mutated = new R1BundleService({ ...f.options, database });
      assert.throws(() => mutated.requestStatus('prev-succeeded'), { code: 'R1_BUNDLE_REQUEST_NOT_FOUND' });
      appendFileSync(f.configPath, '\n');
      const other = new R1BundleService({ ...f.options, database });
      assert.throws(() => other.requestStatus('old-succeeded'), { code: 'R1_BUNDLE_REQUEST_NOT_FOUND' });
    } finally { database.close(); }
  } finally { f.database.close(); }
});

test('a dispatched export timeout stays uncertain across reopening and an unsuccessful same-ID check', async () => {
  const f = setup(), input = { ...selection, packageName: 'delayed' };
  try {
    const { connection } = f.options.runtime;
    connection.client = new WfdProductMachineClient({ configPath: f.configPath, entryPath: connection.profile.entry_path,
      projectRoot: join(f.sdk, '..'), pythonPath: process.execPath, timeoutMs: 1000 });
    await assert.rejects(f.service.dispatch('bundle_export_full', input),
      { code: 'WFD_PRODUCT_MACHINE_TIMEOUT', requestId: input.requestId, mayHaveBeenAccepted: true });
    f.database.close();
    const database = new CoreDatabase(f.dbPath);
    try {
      const reopened = new R1BundleService({ ...f.options, database });
      assert.equal(reopened.requestStatus(input.requestId).state, 'outcome_unknown');
      symlinkSync(f.packages, join(f.packages, input.packageName));
      await assert.rejects(reopened.dispatch('bundle_export_full', input), { code: 'BUNDLE_PATH_INVALID', mayHaveBeenAccepted: true });
      assert.equal(reopened.requestStatus(input.requestId).state, 'outcome_unknown');
      assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
    } finally { database.close(); }
  } finally { f.database.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { WfdProductMachineClient, WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { R1_BUNDLE_VERSION, R1BundleService } from './r1-bundle.js';

const snapshotId = 's_' + '1'.repeat(24), descriptorSha256 = 'sha256:' + 'a'.repeat(64);
const selection = { requestId: 'stable', packageName: 'bundle', snapshotId, products: [{ product_id: 'p_synthetic' }] };

// Synthetic process exercises transport failures and scheduling races which a successful WFD run cannot inject.
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bd-bundle-dispatch-')));
  const packages = join(root, 'packages'), configPath = join(root, 'config.json'), log = join(root, 'calls');
  const entryPath = join(root, 'fixture.cjs');
  mkdirSync(packages);
  writeFileSync(configPath, JSON.stringify({ bundle_access: { package_root: packages } }), { mode: 0o600 });
  writeFileSync(entryPath, `
const fs = require('node:fs');
let raw = '';
process.stdin.on('data', part => raw += part);
process.stdin.on('end', () => {
  const req = JSON.parse(raw), args = req.arguments;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + '\\n');
  const identity = { connection_id: 'isolated', caller_id: 'operator', trusted_actor_namespace: 'synthetic' };
  if (args.package_path.endsWith('/wrong-peer')) identity.caller_id = 'another';
  const response = { protocol_version: req.protocol_version, request_id: req.request_id, operation: req.operation, identity, ok: true,
    result: { format_version: 'wfd.structured-bundle/1.0', status: 'exported', mode: 'full', read_self_contained: true, source_permission_required: false,
      source_dataset_id: 'synthetic', baseline_snapshot_id: null,
      write_authority_granted: false, bundle_id: 'sb_' + '2'.repeat(24), descriptor_sha256: ${JSON.stringify(descriptorSha256)},
      source_snapshot_id: ${JSON.stringify(snapshotId)}, target_snapshot_id: 's_' + '3'.repeat(24),
      products: [{ product_id: 'p_synthetic', source_product_id: 'p_synthetic', row_count: 1, rows_sha256: 'sha256:' + 'b'.repeat(64) }] } };
  if (args.package_path.endsWith('/lost')) Object.assign(response, { ok: false, result: null,
    error: { code: 'PROCESS_OUTPUT_FAILED', message: 'synthetic output fault' } });
  if (args.package_path.endsWith('/bad-result')) response.result.descriptor_sha256 = 'invalid';
  process.stdout.write(JSON.stringify(response));
});`);
  const client = new WfdProductMachineClient({ configPath, projectRoot: root, pythonPath: process.execPath, entryPath });
  const identity: R1ConnectionIdentity = { connectionId: 'isolated', callerId: 'operator', namespace: 'synthetic',
    profile: 'data_only', protocol: 'wfd.structured-ingest/1.0', mode: 'user_test', purpose: 'user_test',
    configSha256: wfdSha256(readFileSync(configPath)), entrySha256: wfdSha256(readFileSync(entryPath)), schemaSha256: 'c'.repeat(64),
    runtimeIdentity: 'bundle-test', store: join(root, 'store'), runtime: join(root, 'runtime'), pythonPath: process.execPath, entryPath };
  const runtime = { connection: { configPath, client, connectionId: identity.connectionId, callerId: identity.callerId,
    trustedActorNamespace: identity.namespace }, currentIdentity: () => ({ ...identity }) };
  const control = { stopped: false, generation: 1 };
  const dbPath = join(root, 'bd.sqlite');
  const database = new CoreDatabase(dbPath), options = { database, runtime, control: () => control };
  return { service: new R1BundleService(options), database, options, control, identity, log, packages, dbPath };
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
    const dispatch = f.service.dispatch('bundle_export_full', { ...selection, requestId: 'stale' });
    f.control.generation++;
    await assert.rejects(dispatch, { code: 'BD_STOPPED' });
    assert.equal(f.service.requestStatus('stale').state, 'outcome_unknown');
    f.control.stopped = true;
    assert.throws(() => f.service.dispatch('bundle_export_full', selection), { code: 'BD_STOPPED' });
    f.control.stopped = false;
    await assert.rejects(f.service.dispatch('bundle_export_full', { ...selection, requestId: 'wrong', packageName: 'wrong-peer' }),
      { code: 'R1_CONNECTION_BINDING_CHANGED' });
    f.identity.configSha256 = 'd'.repeat(64);
    assert.throws(() => f.service.requestStatus('stale'), { code: 'R1_CONNECTION_BINDING_CHANGED' });
  } finally { f.database.close(); }
});

test('lost output preserves write uncertainty and invalid success receipts are refused', async () => {
  const f = setup();
  try {
    for (const op of ['bundle_import_full', 'bundle_apply_delta', 'bundle_register_reference'] as const) {
      await assert.rejects(f.service.dispatch(op, { requestId: op, packageName: 'lost', descriptorSha256 }),
        (e: unknown) => e instanceof WfdProductMachineError && e.code === 'PROCESS_OUTPUT_FAILED' && e.mayHaveBeenAccepted);
      assert.equal(f.service.requestStatus(op).state, 'outcome_unknown');
    }
    await assert.rejects(f.service.dispatch('bundle_export_full', { ...selection, packageName: 'lost' }),
      (e: unknown) => e instanceof WfdProductMachineError && e.code === 'PROCESS_OUTPUT_FAILED' && !e.mayHaveBeenAccepted);
    await assert.rejects(f.service.dispatch('bundle_export_full', { ...selection, requestId: 'invalid', packageName: 'bad-result' }),
      { code: 'WFD_PRODUCT_MACHINE_RESPONSE' });
    assert.equal(f.service.requestStatus('invalid').receipt, null);
  } finally { f.database.close(); }
});

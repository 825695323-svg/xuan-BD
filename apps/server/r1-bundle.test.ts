import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { duplexPair } from 'node:stream';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express, { type ErrorRequestHandler } from 'express';
import { WFD_BUNDLE_OPERATIONS, WfdProductMachineClient, type WfdBundleReceipt } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { createWorkspaceRouter } from './workspace-routes.js';
import { openMediaReviewCompanion } from './media-review-test-support.js';

const python = process.env.WFD_PYTHON;
const dataset = 'bundle_synthetic', namespace = 'full.chain.test';
function sample(key: string, value: string, parent: string | null) {
  const row = { business_key: key, value_decimal: value, value_state: 'valid_value',
    observation_time: { status: 'known', precision: 'year', earliest_utc: '2025-01-01T00:00:00Z',
      latest_exclusive_utc: '2026-01-01T00:00:00Z', source_timezone: 'UTC' } };
  return { protocol_version: 'wfd.structured-ingest/1.0', intent: 'submit', producer_namespace: namespace,
    request_identity: { dataset_id: dataset, trusted_actor_namespace: namespace, request_id: key,
      submission_digest: 'sha256:' + wfdSha256(canonicalWfdJson(row)) }, expected_parent_snapshot_id: parent,
    outputs: [{ output_key: 'metric', logical_domain: 'observations', definition_mode: 'create', definition_ref: null,
      subject: { kind: 'physical_object', namespace, id: 'synthetic' }, input_mode: 'partial_observation',
      coverage: { scope: { sample_only: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'bundle.synthetic.count', measurement_nature: 'flow', unit_code: 'count',
        definition_authority: namespace, time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
          content_nature: 'observed_fact', time: { period_type: 'natural', frequency: 'year', interval: 'closed' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' } } },
      payload: { kind: 'scalar_rows', rows: [row] } }] };
}

// Node's HTTP client and server exchange real HTTP bytes over a private stream pair.
// This fixture does not require a listening port, a browser or a network permission.
function httpPort(app: express.Express) {
  const server = createServer(app);
  return (path: string, body?: object, authorized = true) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const [client, peer] = duplexPair();
    server.emit('connection', peer);
    const req = request({ createConnection: () => client, path: path.startsWith('/') ? path : '/r1/bundles/' + path,
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: authorized ? 'synthetic-operator' : '' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
        finally { client.destroy(); peer.destroy(); }
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('HTTP full, delta and reference bundles use a real isolated WFD process and pinned target reads',
  { skip: python ? false : 'Requires explicitly selected WFD_PYTHON.', timeout: 180_000 }, async t => {
    if (!process.env.XUAN_FULL_CHAIN_ROOT) {
      process.env.XUAN_FULL_CHAIN_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'bd-bundle-http-')));
      t.after(() => { delete process.env.XUAN_FULL_CHAIN_ROOT; });
    }
    const f = createFullChainFixture({ name: 'r1-bundle', machine: true });
    const packages = join(f.root, 'packages'), target = join(f.root, 'delivered');
    mkdirSync(packages, { mode: 0o700 });
    const plain = JSON.parse(readFileSync(f.configPath, 'utf8'));
    const config = { ...plain, caller: { ...plain.caller, roles: [...plain.caller.roles, 'export'] },
      bundle_access: { dataset_id: dataset, source_ids: ['synthetic'], operations: Object.keys(WFD_BUNDLE_OPERATIONS),
        package_root: packages, target_store: target },
      sources: { synthetic: { may_read: true, may_export: true, usage_scope: 'synthetic', export_scope: 'selected_dataset' } } };
    const save = (data: object) => writeFileSync(f.configPath, JSON.stringify(data), { mode: 0o600 });
    save({ ...plain, profile: 'legacy' });
    const legacy = openMediaReviewCompanion(f);
    try { assert.equal(legacy.companion.r1Bundles, undefined); assert.ok(legacy.companion.bd); }
    finally { await legacy.close(); }
    save(config);
    const host = openMediaReviewCompanion(f);
    t.after(() => host.close());
    const runtime = host.companion.r1Runtime;
    assert.ok(runtime && host.companion.r1Bundles);
    const app = express();
    app.use(express.json(), createWorkspaceRouter(host.companion, req => {
      if (req.get('authorization') !== 'synthetic-operator') throw new CoreError('ACCESS_DENIED', 'fixture admission', 403);
    }));
    const errors: ErrorRequestHandler = (error, _req, res, _next) =>
      res.status(error.status ?? 500).json({ code: error.code, error: error.message });
    app.use(errors);
    app.use((_req, res) => res.status(404).json({ code: 'UNREGISTERED_TEST_ROUTE' }));
    const call = httpPort(app);
    async function ok(path: string, body?: object) {
      const { status, data } = await call(path, body);
      assert.equal(status, 200, JSON.stringify(data));
      return data;
    }
    assert.equal((await call('capabilities?roles=publish')).data.code, 'R1_BUNDLE_INPUT');
    assert.equal((await call('capabilities', undefined, false)).status, 403);
    for (const name of ['packages', 'export', 'redistribute']) {
      assert.equal((await call('/r1/' + name, {})).status, 404);
      assert.equal((await call(name, {})).status, 404);
    }
    const caps = await ok('capabilities');
    assert.deepEqual(Object.keys(caps.operations).sort(), Object.keys(WFD_BUNDLE_OPERATIONS).sort());
    assert.ok(Object.values(caps.operations).every((v: any) => v.supported));
    assert.deepEqual(readdirSync(packages), []);
    const source = runtime.connection.client;
    const initial = sample('a', '3', null);
    const unchanged = structuredClone(initial.outputs[0]!);
    unchanged.output_key = 'unchanged';
    unchanged.definition.semantic_code = 'bundle.synthetic.unchanged';
    initial.outputs.push(unchanged);
    const first = (await source.submit(initial)).result;
    assert.equal(first.state, 'published_formal', JSON.stringify(first));
    const sid = String(first.snapshot_id);
    const outputs = first.output_results as Array<{ output_key: string; product_id: string }>;
    const pid = outputs.find(item => item.output_key === 'metric')!.product_id;
    const other = outputs.find(item => item.output_key === 'unchanged')!.product_id;
    const selection = { snapshotId: sid, products: outputs.map(({ product_id }) => ({ product_id })) };
    const fullInput = { requestId: 'full', packageName: 'base', ...selection };
    assert.equal((await call('full/export', fullInput, false)).status, 403);
    const full: WfdBundleReceipt = (await ok('full/export', fullInput)).receipt;
    assert.equal(full.products[0]!.row_count, 1);
    const descriptor = (name: string) => join(packages, name, 'financial_bundle.json');
    assert.equal(full.descriptor_sha256, 'sha256:' + wfdSha256(readFileSync(descriptor('base'))));
    assert.deepEqual((await ok('full/export', fullInput)).receipt, full);
    assert.equal((await call('full/export', { ...fullInput, snapshotId: 's_' + '2'.repeat(24) })).data.code, 'R1_BUNDLE_REQUEST_CONFLICT');
    const repeated = await ok('full/export', { ...fullInput, requestId: 'verify-existing-package' });
    assert.equal(repeated.receipt.status, 'already_exported');
    assert.equal(repeated.receipt.descriptor_sha256, full.descriptor_sha256);
    const inbound = { packageName: 'base', descriptorSha256: full.descriptor_sha256, requestId: 'import' };
    assert.equal((await call('full/import', { ...inbound, requestId: 'bad-digest', descriptorSha256: 'sha256:' + '0'.repeat(64) })).data.code,
      'BUNDLE_DESCRIPTOR_DIGEST_MISMATCH');
    const damaged = join(packages, 'damaged');
    cpSync(join(packages, 'base'), damaged, { recursive: true });
    const object = join(damaged, 'objects', readdirSync(join(damaged, 'objects'))[0]!);
    writeFileSync(object, 'synthetic damaged object');
    assert.equal((await call('full/import', { ...inbound, packageName: 'damaged', requestId: 'damaged' })).data.code,
      'BUNDLE_INTEGRITY_FAILED');
    symlinkSync(f.root, join(damaged, 'link'));
    assert.equal((await call('full/import', { ...inbound, packageName: 'damaged', requestId: 'linked' })).data.code, 'BUNDLE_PATH_INVALID');
    assert.equal(existsSync(target), false);
    const imported: WfdBundleReceipt = (await ok('full/import', inbound)).receipt;
    assert.equal(imported.status, 'imported_structured_readable');
    assert.equal(imported.write_authority_granted, false);
    assert.equal(imported.active_head, null);
    assert.equal((await ok('requests/import')).receipt.instance_id, imported.instance_id);
    const readerConfig = join(f.root, 'target-reader.json');
    writeFileSync(readerConfig, JSON.stringify({ ...plain, store: target, caller: { ...plain.caller, roles: ['read'] } }), { mode: 0o600 });
    const machine = (configPath: string) => new WfdProductMachineClient({ pythonPath: python!, configPath,
      entryPath: runtime.connection.profile.entry_path, projectRoot: plain.project_root });
    const reader = machine(readerConfig);
    async function fixed(client: WfdProductMachineClient, snapshotId: string, productId: string) {
      const { result } = await client.read({ snapshotId, productId });
      assert.equal(result.snapshot_id, snapshotId);
      const rows = result.rows as Array<{ record_id: string; record_version: string;
        record_ref: { snapshot_id: string }; row: Record<string, unknown> }>;
      for (const row of rows) assert.equal(row.record_ref.snapshot_id, snapshotId);
      return rows;
    }
    const baseRows = await fixed(reader, imported.target_snapshot_id!, pid);
    assert.deepEqual(baseRows.map(r => [r.record_id, r.row.value_decimal]), [['a', '3']]);
    assert.equal(baseRows[0]!.record_version, (await fixed(source, sid, pid))[0]!.record_version);
    const next = (await source.submit(sample('b', '7', sid))).result;
    assert.equal(next.state, 'published_formal', JSON.stringify(next));
    const nextId = String(next.snapshot_id);
    const delta: WfdBundleReceipt = (await ok('delta/export', { ...selection, snapshotId: nextId, packageName: 'delta',
      requestId: 'delta', baselineSnapshotId: imported.target_snapshot_id })).receipt;
    assert.ok(JSON.parse(readFileSync(descriptor('delta'), 'utf8')).baseline_reused_files.length > 0, 'Unchanged product comes from the fixed baseline');
    const applied: WfdBundleReceipt = (await ok('delta/apply', { requestId: 'apply', packageName: 'delta',
      descriptorSha256: delta.descriptor_sha256 })).receipt;
    assert.equal(applied.status, 'applied');
    assert.equal(applied.instance_id, imported.instance_id);
    assert.notEqual(applied.target_snapshot_id, imported.target_snapshot_id);
    const rows = await fixed(reader, applied.target_snapshot_id!, pid);
    const sourceRows = await fixed(source, nextId, pid);
    assert.deepEqual(rows.map(r => [r.record_id, r.record_version, r.row.value_decimal]),
      sourceRows.map(r => [r.record_id, r.record_version, r.row.value_decimal]));
    assert.deepEqual(rows.map(r => r.row.value_decimal), ['3', '7']);
    assert.deepEqual(await fixed(reader, imported.target_snapshot_id!, pid), baseRows);
    const originalOther = await fixed(reader, imported.target_snapshot_id!, other);
    assert.deepEqual(await fixed(reader, applied.target_snapshot_id!, other), originalOther.map(row => ({
      ...row, record_ref: { ...row.record_ref, snapshot_id: applied.target_snapshot_id } })));
    const ref: WfdBundleReceipt = (await ok('reference/export', { ...selection, snapshotId: nextId,
      requestId: 'ref', packageName: 'ref' })).receipt;
    assert.deepEqual(readdirSync(join(packages, 'ref')).sort(), ['CHECKSUMS.json', 'financial_bundle.json']);
    const refInput = { requestId: 'register', packageName: 'ref', descriptorSha256: ref.descriptor_sha256 };
    const registered: WfdBundleReceipt = (await ok('reference/register', refInput)).receipt;
    assert.equal(registered.status, 'registered_reference_readable');
    assert.equal(registered.readable, true);
    assert.equal(registered.read_self_contained, false);
    assert.equal(registered.target_snapshot_id, null);
    assert.equal(registered.products.find(p => p.product_id === pid)!.rows_sha256,
      'sha256:' + wfdSha256(canonicalWfdJson(sourceRows.map(r => 'sha256:' + wfdSha256(canonicalWfdJson(r.row))))));
    assert.equal((await ok('reference/register', { ...refInput, requestId: 'register-again' })).receipt.status, 'reference_already_registered');
    for (const [key, value] of Object.entries({ store: target, runtime: f.root, roles: ['export'], caller: { caller_id: 'other' } })) {
      assert.equal((await call('full/export', { ...fullInput, [key]: value })).data.code, 'R1_BUNDLE_INPUT');
      await assert.rejects(source.request('bundle_export_full', { snapshot_id: sid, products: selection.products,
        package_path: join(packages, 'injected'), [key]: value }), { code: 'REQUEST_INVALID' });
    }
    symlinkSync(packages, join(packages, 'alias'));
    for (const path of [join(f.root, 'escape'), packages + '/alias/new', packages + '/none/../escape', 'relative']) {
      await assert.rejects(source.bundleExportFull({ package_path: path, snapshot_id: sid, products: selection.products }), { code: 'BUNDLE_PATH_INVALID' });
    }
    assert.equal((await call('full/import', { ...inbound, packageName: '../base' })).data.code, 'R1_BUNDLE_INPUT');
    for (const generic of ['packages', 'export', 'redistribute']) await assert.rejects(source.request(generic, {}), { code: 'OPERATION_UNSUPPORTED' });
    const denied = async (change: object, operation: 'bundle_import_full' | 'bundle_export_full', code: string) => {
      const path = join(f.root, code + '.json');
      writeFileSync(path, JSON.stringify({ ...config, ...change }), { mode: 0o600 });
      const client = machine(path), caps = (await client.bundleCapabilities()).result;
      assert.equal(caps.operations[operation].supported, false);
      assert.equal(caps.operations[operation].reason, code);
      await assert.rejects(client.request(operation, {}), { code });
    };
    await denied({ sources: {} }, 'bundle_export_full', 'SOURCE_NOT_ADMITTED');
    await denied({ sources: { synthetic: { ...config.sources.synthetic, may_read: false } } }, 'bundle_export_full', 'SOURCE_READ_PERMISSION_MISSING');
    await denied({ sources: { synthetic: { ...config.sources.synthetic, may_export: false } } }, 'bundle_export_full', 'SOURCE_EXPORT_PERMISSION_MISSING');
    await denied({ caller: { ...plain.caller, roles: ['read'] } }, 'bundle_import_full', 'CALLER_PERMISSION_DENIED');
    await denied({ bundle_access: { ...config.bundle_access, operations: ['bundle_export_full'] } }, 'bundle_import_full', 'WRITE_AUTHORITY_REQUIRED');
    // Drop the acknowledgement after a real full import into a second detached target.
    const faultPath = join(f.root, 'output-fault.py'), faultConfig = join(f.root, 'output-fault.json');
    writeFileSync(faultPath, [
      'import sys', 'sys.path.insert(0, ' + JSON.stringify(plain.project_root) + ')',
      'from wfd_sdk import product_machine as machine', 'write = machine._write_response',
      'def output(response, limit):', '    if response.get("ok"): raise OverflowError("RESPONSE_TOO_LARGE")',
      '    write(response, limit)', 'machine._write_response = output', 'raise SystemExit(machine.main())', '',
    ].join('\n'));
    writeFileSync(faultConfig, JSON.stringify({ ...config, store: target, bundle_access: { ...config.bundle_access,
      target_store: join(f.root, 'recovery-target') } }), { mode: 0o600 });
    const fault = new WfdProductMachineClient({ pythonPath: python!, configPath: faultConfig, projectRoot: plain.project_root, entryPath: faultPath });
    const fixedImport = { package_path: join(packages, 'base'), descriptor_sha256: full.descriptor_sha256 };
    const offline = join(f.root, 'offline-donor');
    renameSync(f.store, offline);
    try {
      await assert.rejects(fault.bundleImportFull(fixedImport), { code: 'PROCESS_OUTPUT_FAILED', mayHaveBeenAccepted: true });
      const recipient = machine(faultConfig);
      const recovered = await recipient.bundleImportFull(fixedImport);
      assert.equal(recovered.result.status, 'already_imported');
      assert.equal(recovered.result.target_snapshot_id, imported.target_snapshot_id);
      assert.notEqual(recovered.result.instance_id, imported.instance_id);
      assert.deepEqual(await fixed(reader, imported.target_snapshot_id!, pid), baseRows);
      const unavailable = await recipient.bundleRegisterReference({ package_path: join(packages, 'ref'),
        descriptor_sha256: ref.descriptor_sha256 });
      assert.equal(unavailable.result.status, 'registered_reference_unavailable');
      assert.equal(unavailable.result.readable, false);
      assert.equal(unavailable.result.dependency_gaps!.length, ref.products.length);
    } finally { renameSync(offline, f.store); }
    save({ ...config, connection_id: 'changed' });
    await assert.rejects(source.bundleCapabilities(), { code: 'BUNDLE_CONFIG_CHANGED' });
  });

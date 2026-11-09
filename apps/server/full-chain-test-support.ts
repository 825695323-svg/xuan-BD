import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { BundledResources } from '../../platform/resources/bundled.js';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApp } from './app.js';
import type { CloudCustodyBackend } from '../../plugins/storage/baidu-drive.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const productRoot = join(codeRoot, 'wfd/product');
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null,
  notice: 'isolated full-chain test; model disabled' };
const backend: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('Model calls are disabled in full-chain tests'); } };

export interface FullChainFixture {
  root: string;
  runtime: string;
  store: string;
  wfdRuntime: string;
  configPath: string;
  registryPath: string;
  machine: boolean;
  bundledTranscription: boolean;
  modelPath?: string;
  privateRoot?: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** Caller selects a new, dedicated parent root after checking that it did not exist before this batch. */
export function createFullChainFixture(input: { name: string; machine?: boolean; bundledTranscription?: boolean;
  privateRoot?: string;
  units?: Record<string, { dimension: string }> }): FullChainFixture {
  const parent = process.env.XUAN_FULL_CHAIN_ROOT;
  assert.ok(parent && isAbsolute(parent) && existsSync(parent) && statSync(parent).isDirectory(),
    'XUAN_FULL_CHAIN_ROOT must name the dedicated, pre-created full-chain test root.');
  assert.match(input.name, /^[a-z0-9_-]{1,48}$/u);
  const root = realpathSync(mkdtempSync(join(parent, input.name + '-')));
  if (input.privateRoot) {
    assert.ok(isAbsolute(input.privateRoot) && !existsSync(input.privateRoot) && existsSync(join(input.privateRoot,'..')), 'Private fixture root must be explicitly new with an existing parent.');
    mkdirSync(input.privateRoot, {mode:0o700});
  }
  const runtime = join(root, 'bd'), identity = `isolated-full-chain-${randomUUID()}`;
  mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'directory' | 'file' | 'program'; sha256?: string;
    owned?: boolean; identity?: string; device?: string; inode?: string }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path);
    if (['cache', 'temp', 'downloads'].includes(name)) {
      const stat = statSync(path, { bigint: true });
      resources[name] = { path, kind: 'directory', owned: true, identity: `${identity}:${name}`,
        device: String(stat.dev), inode: String(stat.ino) };
    } else resources[name] = { path, kind: 'directory' };
  }
  const configPath = join(runtime, 'config/wfd-machine.json'), registryPath = join(runtime, 'config/connections.json');
  const store = join(root, 'wfd-store'), wfdRuntime = join(root, 'wfd-runtime');
  let modelPath: string | undefined;
  if (input.bundledTranscription) {
    const bundle = new BundledResources(codeRoot), local = join(root, 'bundled-transcription');
    mkdirSync(local);
    for (const [id, resourceKey] of [['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe'], ['whisper_cli', 'whisper_cli']] as const) {
      const source = bundle.executable(id), entry = bundle.manifest.platforms[bundle.platform]!.executables[id]!;
      const path = join(local, id); copyFileSync(source, path); chmodSync(path, 0o700);
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256);
      resources[resourceKey] = { path, kind: 'program', sha256: entry.sha256 };
    }
    const entry = bundle.manifest.models.whisper_base!;
    modelPath = join(local, 'ggml-base.bin'); copyFileSync(bundle.model('whisper_base'), modelPath); chmodSync(modelPath, 0o600);
    assert.equal(createHash('sha256').update(readFileSync(modelPath)).digest('hex'), entry.sha256);
    resources.bundle_manifest = { path: bundle.manifestPath, kind: 'file', sha256: bundle.manifestSha256 };
  }
  if (input.machine) {
    const python = process.env.WFD_PYTHON;
    assert.ok(python && isAbsolute(python) && statSync(python).isFile(), 'Full-chain WFD test requires explicitly selected WFD_PYTHON.');
    mkdirSync(store); mkdirSync(wfdRuntime);
    const initialized = spawnSync(python, isolatedPythonArgs(join(root, 'python-cache'), ['-c',
      'from pathlib import Path; import sys; sys.path.insert(0, sys.argv[3]); from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator; WFDDuckDBPrototype.initialize_new(Path(sys.argv[1]),load_protocol_validator(Path(sys.argv[3])/"protocol"),runtime_root=Path(sys.argv[2]),sandbox=False,writer_host="full-chain-test"); import json; print(json.dumps({"isolated":sys.flags.isolated,"ignore_environment":sys.flags.ignore_environment,"no_user_site":sys.flags.no_user_site,"dont_write_bytecode":sys.flags.dont_write_bytecode,"pycache_prefix":sys.pycache_prefix,"source_root":str(Path(__import__("wfd_sdk").__file__).resolve().parent.parent)}))',
      store, wfdRuntime, productRoot]), { cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: productRoot,
        PYTHONPYCACHEPREFIX: join(root, 'python-cache') } });
    writeJson(join(root, 'python-initialization.json'), { status: initialized.status, stdout: initialized.stdout, stderr: initialized.stderr });
    assert.equal(initialized.status, 0, initialized.stderr);
    const flags = JSON.parse(initialized.stdout.trim());
    assert.equal(flags.isolated, 1); assert.equal(flags.ignore_environment, 1); assert.equal(flags.no_user_site, 1);
    assert.equal(flags.dont_write_bytecode, 1); assert.equal(flags.pycache_prefix, join(root, 'python-cache'));
    assert.equal(flags.source_root, realpathSync(productRoot));
    writeJson(configPath, { protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only',
      connection_id: 'full-chain-test', store, runtime: wfdRuntime, project_root: productRoot,
      protocol_root: join(productRoot, 'protocol'), caller: { caller_id: 'full-chain-test',
        trusted_actor_namespace: 'full.chain.test', roles: ['read', 'register', 'submit', 'publish'] },
      units: input.units ?? { count: { dimension: 'quantity' } }, sources: {}, limits: {} });
    writeJson(registryPath, { connections: [{ id: 'full-chain-test', kind: 'wfd-product-machine', mode: 'user_test',
      purpose: 'user_test', protocol: 'wfd.product-machine/0.1', config_path: configPath, store, runtime: wfdRuntime,
      python_path: python, entry_path: join(productRoot, 'wfd_sdk/product_machine.py'),
      harness_binding: { root: runtime, root_id: identity } }] });
    resources.connections_registry = { path: registryPath, kind: 'file' };
  }
  writeJson(join(runtime, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity });
  writeJson(join(runtime, 'config/machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity: identity, resources });
  return { root, runtime, store, wfdRuntime, configPath, registryPath, machine: !!input.machine,
    ...(input.privateRoot ? {privateRoot:realpathSync(input.privateRoot)} : {}),
    bundledTranscription: !!input.bundledTranscription, ...(modelPath ? { modelPath } : {}) };
}

export async function openFullChainHost(fixture: FullChainFixture, webRoot?: string, cloudCustodyBackend?: CloudCustodyBackend) {
  const database = new CoreDatabase(join(fixture.runtime, 'state/core.sqlite'));
  const core = new PersonalCore(backend, { database });
  const resources = new ResourceBindings(fixture.runtime);
  const services = createApplicationServices(core, database, { role: 'service', health,
    projectRoot: fixture.runtime, codeRoot, privateRoot: fixture.privateRoot ?? join(fixture.runtime, 'state/private'),
    resources, processRuntime: fixture.bundledTranscription || resources.document.resources.polars_python?.kind === 'program' ? new ProcessRuntime(resources) : undefined,
    whisperModelPath: fixture.modelPath, r1ConnectionId: 'full-chain-test',
    materials: { environment: 'local-review' }, cloudCustodyBackend });
  services.permissions.grant({ capabilities: ['read', 'write', 'delete'].map(action => ({ action: action as 'read' | 'write' | 'delete',
    target: { kind: 'directory' as const, path: services.artifactRoot, recursive: true } })),
    label: 'isolated-full-chain-artifacts', scope: { kind: 'persistent' } });
  if (fixture.bundledTranscription) {
    assert.ok(fixture.modelPath);
    services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: fixture.modelPath } },
      ...(['ffmpeg', 'ffprobe', 'whisper_cli'] as const).map(name => ({ action: 'execute' as const,
        target: { kind: 'file' as const, path: resources.path(name) } }))],
      label: 'isolated-full-chain-local-transcription', scope: { kind: 'persistent' } });
  }
  let applicationCore = core, applicationServices = services;
  let personalDatabase: CoreDatabase | undefined, lifecycle: LocalDataLifecycle | undefined;
  if (webRoot) {
    personalDatabase = new CoreDatabase(join(fixture.runtime, 'state/personal.sqlite'));
    applicationCore = new PersonalCore(backend, { database: personalDatabase });
    const dataId = 'isolated-full-chain-browser-data';
    lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(fixture.root, 'lifecycle.sqlite'), dataIdFromTask: () => dataId });
    lifecycle.register(dataId); lifecycle.bindIdentity(dataId, personalDatabase.path);
    assert.equal(lifecycle.assertPrivateAccess(1).dataId, dataId);
    applicationServices = createApplicationServices(applicationCore, personalDatabase, { health,
      projectRoot: fixture.runtime, codeRoot, privateRoot: join(fixture.runtime, 'state/personal-private'), resources,
      workspaceServices: services, localData: { lifecycle, dataId,
        verify: async () => { throw new Error('Browser tests never change the local-data lifecycle'); } } });
  }
  const server: Server = createApp(applicationCore, health, applicationServices,
    webRoot ? { webRoot } : { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/bd`;
  const call = async (path: string, body?: unknown, expectedStatus = 200): Promise<any> => {
    const response = await fetch(base + path, { headers: { ...(webRoot ? { 'x-local-data-generation': '1' } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value;
  };
  const upload = async (name: string, category: 'unclassified' | 'data' | 'tool', bytes: Buffer, requestId: string): Promise<any> => {
    const query = new URLSearchParams({ name, category, requestId });
    const response = await fetch(base + '/materials/upload?' + query, { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web',
        ...(webRoot ? { 'x-local-data-generation': '1' } : {}) }, body: new Uint8Array(bytes) });
    const value = await response.json();
    assert.equal(response.status, 202, JSON.stringify(value));
    return value;
  };
  const settled = async (taskId: string, timeoutMs = 60_000): Promise<TaskRecord> => {
    const terminal = (task: TaskRecord) => ['succeeded', 'failed', 'cancelled', 'needs_review', 'waiting_approval', 'blocked', 'interrupted'].includes(task.status);
    const current = services.tasks.get(taskId); if (terminal(current)) return current;
    return await new Promise<TaskRecord>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Task did not settle: ' + taskId)); }, timeoutMs);
      const unsubscribe = services.tasks.subscribe(({ task }) => {
        if (task.id === taskId && terminal(task)) { clearTimeout(timer); unsubscribe(); resolve(task); }
      });
    });
  };
  let closed = false;
  return { fixture, database, core, services, base, call, upload, settled, async close() {
    // 测试内的 fetch keep-alive 连接会让 server.close 一直等待；显式关闭全部
    // 连接后再关服务，避免跨重开步骤挂起。
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    services.segments?.close();
    services.files.closeTemporaryRetention();
    services.options.processRuntime?.closeTemporaryRetention();
    await services.r1Batches?.dispose();
    await services.r1Auto?.dispose();
    await services.tasks.dispose(); await core.dispose(); database.close();
    if (personalDatabase) {
      applicationServices.segments?.close();
      applicationServices.files.closeTemporaryRetention();
      applicationServices.options.processRuntime?.closeTemporaryRetention();
      await applicationServices.r1Batches?.dispose();
      await applicationServices.r1Auto?.dispose();
      await applicationServices.tasks.dispose(); await applicationCore.dispose(); personalDatabase.close();
    }
    await lifecycle?.close();
  } };
}

export type FullChainHost = Awaited<ReturnType<typeof openFullChainHost>>;

/** The source path is a fixed test selection, never a request parameter. */
export function grantSelectedFile(host: FullChainHost, path: string, label: string) {
  const reference = host.services.files.register({ path, source: 'user-selected' });
  host.services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: reference.invocationPath } }],
    label, scope: { kind: 'persistent' } });
  return reference;
}

export function startDirect(host: FullChainHost, action: string, args: Record<string, JsonValue>, requestId: string): TaskRecord {
  const routed = host.services.direct.registry.route({ action, args });
  assert.equal(routed.runtimeId, 'direct');
  const task = host.services.tasks.create({ title: `full-chain ${action}`, ownerRole: 'service',
    runtimeId: routed.runtimeId, action: routed.action, args: routed.args, requestId,
    versions: host.services.direct.registry.captureVersions(routed.action, routed.args) });
  return task.status === 'ready' ? host.services.tasks.start(task.id, task.version) : task;
}

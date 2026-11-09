import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadAppConfiguration } from '../../platform/config/model.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { BundledResources } from '../../platform/resources/bundled.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { startBrowserHost, type BrowserHost } from '../../platform/capabilities/browser/host.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { createPiBackend } from '../../modules/agent/runtime/pi.js';
import { WORKSPACE_BD_VERSION, WORKSPACE_SYSTEM_PROMPT } from '../../modules/agent/service.js';
import { createMaterialTableReader } from '../../modules/financial/managed-table.js';
import { localAlgorithmConfiguration, localFinancialConfiguration } from './financial-configuration.js';
import { createApplicationServices, type ApplicationServices } from './services.js';
import { createFullChainFixture, type FullChainFixture } from './full-chain-test-support.js';
import { startLocalServer } from './boot.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const expectedRuntimeIdentity = '701e578c-4b16-412b-af20-a1685b5d9738';
const expectedRevision = 18;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(code) ? code : 'UNAVAILABLE';
}

function existingFile(path: string): void {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
}

function existingFixture(input: { evidenceRoot: string; resumeHostFile: string }, modelSha256: string):
  { fixture: FullChainFixture; expectedGeneration: number } {
  const hostFile = resolve(input.resumeHostFile), evidenceRoot = resolve(input.evidenceRoot);
  const part = relative(evidenceRoot, hostFile);
  assert.ok(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  assert.match(basename(hostFile), /^live-model-host-live-model-[A-Za-z0-9]+(?:-\d+)?\.json$/u);
  existingFile(hostFile);
  const previous = JSON.parse(readFileSync(hostFile, 'utf8')) as Record<string, any>;
  assert.equal(previous.realRuntimeIdentity, expectedRuntimeIdentity);
  assert.equal(previous.realBindingRevision, expectedRevision);
  assert.equal(previous.sourceModelSha256, modelSha256);
  const runtime = resolve(String(previous.isolatedRuntime)), root = dirname(runtime);
  assert.equal(basename(runtime), 'bd');
  assert.match(basename(root), /^live-model-[A-Za-z0-9]+$/u);
  assert.equal(dirname(root), evidenceRoot);
  assert.equal(previous.isolatedWfdStore, join(root, 'wfd-store'));
  assert.equal(previous.personalDatabase, join(runtime, 'state/personal/core.sqlite'));
  assert.equal(previous.serviceDatabase, join(runtime, 'state/workspace/core.sqlite'));
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  for (const name of ['.xuan-runtime.json', 'config/machine.bindings.json', 'config/wfd-machine.json',
    'config/connections.json', 'state/personal/core.sqlite', 'state/workspace/core.sqlite']) existingFile(join(runtime, name));
  assert.ok(lstatSync(join(root, 'wfd-store')).isDirectory() && lstatSync(join(root, 'wfd-runtime')).isDirectory());
  for (const name of ['state/personal/.bd-owner.lock', 'state/workspace/.bd-owner.lock']) {
    assert.ok(!existsSync(join(runtime, name)), 'The previous state owner has not released its lock.');
  }
  const marker = JSON.parse(readFileSync(join(runtime, '.xuan-runtime.json'), 'utf8')) as { identity: string };
  const controlPath = join(runtime, 'control/local-data-lifecycle.sqlite');
  existingFile(controlPath);
  const control = new DatabaseSync(controlPath, { readOnly: true });
  control.exec('PRAGMA query_only=ON');
  try {
    const rows = control.prepare('SELECT data_id,status,generation,adopted,last_operation_id FROM local_data_lifecycle').all();
    assert.equal(rows.length, 1);
    const current = rows[0]!;
    assert.equal(current.data_id, marker.identity);
    assert.equal(current.status, 'active');
    assert.equal(current.adopted, 1);
    assert.equal(current.last_operation_id, null);
    assert.equal(current.generation, previous.localData?.generation);
    const identity = control.prepare('SELECT state_path,device,inode FROM local_data_lifecycle_identity WHERE data_id=?').get(marker.identity);
    assert.equal(identity?.state_path, previous.personalDatabase);
    const stat = statSync(previous.personalDatabase, { bigint: true });
    assert.equal(identity?.device, String(stat.dev));
    assert.equal(identity?.inode, String(stat.ino));
  } finally { control.close(); }
  for (const databasePath of [previous.personalDatabase, previous.serviceDatabase]) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('running','waiting_approval','pausing','cancelling')").get()!.n, 0);
    } finally { db.close(); }
  }
  return { fixture: { root, runtime, store: join(root, 'wfd-store'), wfdRuntime: join(root, 'wfd-runtime'),
    configPath: join(runtime, 'config/wfd-machine.json'), registryPath: join(runtime, 'config/connections.json'),
    machine: true, bundledTranscription: false }, expectedGeneration: previous.localData.generation };
}

/** Only the real model file and its selected credential reference are read. All writable state belongs to a new fixture. */
export async function startLiveModelTestHost(input: { realRoot: string; evidenceRoot: string; webRoot: string; resumeHostFile?: string }) {
  for (const path of [input.realRoot, input.evidenceRoot, input.webRoot]) {
    assert.ok(isAbsolute(path) && resolve(path) === path && !path.includes('\0'));
  }
  assert.ok(existsSync(join(input.webRoot, 'index.html')));
  assert.ok(lstatSync(input.evidenceRoot).isDirectory());
  const real = new ResourceBindings(input.realRoot);
  assert.equal(real.document.runtimeIdentity, expectedRuntimeIdentity);
  assert.equal(real.document.revision, expectedRevision);
  const modelPath = join(real.path('config'), 'model.json');
  const modelStat = lstatSync(modelPath);
  assert.ok(modelStat.isFile() && !modelStat.isSymbolicLink() && modelStat.nlink === 1);
  const configuration = await loadAppConfiguration(input.realRoot,
    { MASHIRO_BACKEND: 'pi', MASHIRO_CONFIG: modelPath }, new ProcessRuntime(real));
  assert.ok(configuration.health.configured, 'Configured model credential is unavailable.');
  assert.equal(configuration.pi.provider, 'deepseek-official');
  assert.equal(configuration.pi.model, 'deepseek-flash');
  const modelSha256 = createHash('sha256').update(readFileSync(modelPath)).digest('hex');

  // Resume is explicit and read-only preflighted; it never invokes the fixture initializer.
  const resumed = input.resumeHostFile ? existingFixture({ evidenceRoot: input.evidenceRoot,
    resumeHostFile: input.resumeHostFile }, modelSha256) : undefined;
  if (!resumed) process.env.XUAN_FULL_CHAIN_ROOT = input.evidenceRoot;
  const fixture = resumed?.fixture ?? createFullChainFixture({ name: 'live-model', machine: true });
  const bundle = new BundledResources(codeRoot);
  const bindingsPath = join(fixture.runtime, 'config/machine.bindings.json');
  const taskFiles = join(fixture.runtime, 'task_files');
  const browserHome = join(fixture.runtime, 'browser_home');
  const python = process.env.WFD_PYTHON;
  assert.ok(python && isAbsolute(python) && statSync(python).isFile());
  if (!resumed) {
    const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8')) as { resources: Record<string, any> };
    mkdirSync(taskFiles);
    const taskFilesStat = statSync(taskFiles, { bigint: true });
    bindings.resources.task_files = { path: taskFiles, kind: 'directory', owned: true,
      identity: `live-model:${fixture.runtime}:task_files`, device: String(taskFilesStat.dev), inode: String(taskFilesStat.ino) };
    const browserStat = statSync(browserHome, { bigint: true });
    bindings.resources.browser_home = { path: browserHome, kind: 'directory', owned: true,
      identity: `live-model:${fixture.runtime}:browser_home`, device: String(browserStat.dev), inode: String(browserStat.ino) };
    Object.assign(bindings.resources, bundle.selectedBindings());
    bindings.resources.python = { path: python, kind: 'program' };
    writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
  }
  const resources = new ResourceBindings(fixture.runtime);
  assert.equal(resources.program('python'), python);
  bundle.assertBindings(resources);
  const processRuntime = new ProcessRuntime(resources);
  const whisperModelPath = bundle.model('whisper_base');
  const modelConfigurationVersion = digestOperationArgs({ provider: configuration.pi.provider, model: configuration.pi.model,
    customModel: configuration.pi.customModel, defaultThinkingLevel: configuration.pi.defaultThinkingLevel,
    credentialReference: configuration.credentialReference ?? null });
  const health = configuration.health;

  let browserHost: BrowserHost | undefined;
  let browserCleanup: (() => Promise<void>) | undefined;
  let browserUnavailableReason: string | undefined;
  try {
    browserHost = await startBrowserHost({ processRuntime, runtimeIdentity: resources.document.runtimeIdentity,
      homeRoot: browserHome, ...bundle.browser(), headless: true,
      onCleanupAvailable: shutdown => { browserCleanup = shutdown; } });
  } catch (error) {
    browserUnavailableReason = `隔离浏览器未就绪（${safeErrorCode(error)}）。`;
    if (browserCleanup) await browserCleanup();
  }

  let serviceServices!: ApplicationServices;
  let personalServices!: ApplicationServices;
  const serviceBackend = createPiBackend({ ...configuration.pi,
    systemPrompt: WORKSPACE_SYSTEM_PROMPT,
    customModel: configuration.pi.customModel ? { ...configuration.pi.customModel, maxTokens: 1024 } : undefined,
    maxModelRequests: 4,
    toolFactory: context => serviceServices.modelTools.toolFactory(context),
    beforeModelRequest: (...args) => serviceServices.modelTools.beforeModelRequest(...args),
    projectToolResult: (...args) => serviceServices.modelTools.projectToolResult(...args),
    contextIdentity: (...args) => serviceServices.modelTools.contextIdentity(...args),
    contextProvider: (value, signal) => serviceServices.modelContext(value, signal),
  });
  const personalBackend = createPiBackend({ ...configuration.pi, maxModelRequests: 8,
    toolFactory: context => personalServices.modelTools.toolFactory(context),
    beforeModelRequest: (...args) => personalServices.modelTools.beforeModelRequest(...args),
    projectToolResult: (...args) => personalServices.modelTools.projectToolResult(...args),
    contextIdentity: (...args) => personalServices.modelTools.contextIdentity(...args),
    contextProvider: (value, signal) => personalServices.modelContext(value, signal),
  });
  const serviceRoot = join(fixture.runtime, 'state/workspace');
  mkdirSync(serviceRoot, { recursive: true });
  const servicePrivateRoot = join(taskFiles, 'workspace');
  const personalPrivateRoot = join(taskFiles, 'personal');
  const controlDatabasePath = join(fixture.runtime, 'control/local-data-lifecycle.sqlite');
  const dataId = resources.document.runtimeIdentity;
  let localData!: LocalDataLifecycle;
  try {
    localData = new LocalDataLifecycle({ controlDatabasePath,
      cleanupRoots: [serviceRoot, join(fixture.runtime, 'state/personal'), servicePrivateRoot, personalPrivateRoot],
      dataIdFromTask: () => dataId });
    if (resumed) {
      assert.equal(localData.status(dataId).generation, resumed.expectedGeneration);
      assert.equal(localData.identityStatus(dataId, join(fixture.runtime, 'state/personal/core.sqlite')), 'matched');
    } else localData.register(dataId);
  } catch (error) {
    await localData?.close().catch(() => {});
    await browserHost?.shutdown().catch(() => {});
    throw error;
  }
  let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    service = await startLocalServer({ backend: serviceBackend, health, databasePath: join(serviceRoot, 'core.sqlite'), listen: false,
      initializeServices: (core, database) => (serviceServices = createApplicationServices(core, database, {
        role: 'service', health, projectRoot: fixture.runtime, codeRoot, privateRoot: servicePrivateRoot,
        resources, processRuntime, whisperModelPath, r1ConnectionId: 'full-chain-test',
        localData: { lifecycle: localData, dataId }, localDataControlPath: controlDatabasePath,
        controlStateRoot: serviceRoot,
        materials: { environment: 'local-review' },
        configureFinancial: localFinancialConfiguration(resources),
        configureAlgorithms: localAlgorithmConfiguration({ projectRoot: codeRoot, resources,
          tables: materials => createMaterialTableReader(materials) }),
        credentialReference: configuration.credentialReference, modelConfigurationVersion,
        modelConnection: { endpoint: configuration.pi.customModel!.baseUrl, protocol: configuration.pi.customModel!.api },
        modelInput: configuration.pi.customModel!.input,
        browser: browserHost?.configuration, browserUnavailableReason,
        serviceVersions: { bd: WORKSPACE_BD_VERSION, model: `${health.provider}/${health.model}`,
          modelConfiguration: modelConfigurationVersion, budget: 'requests=4;output=1024;timeout_ms=60000' },
      })) });
    const personal = await startLocalServer({ backend: personalBackend, health,
      databasePath: join(fixture.runtime, 'state/personal/core.sqlite'), port: 0, webRoot: input.webRoot,
      initializeServices: (core, database) => (personalServices = createApplicationServices(core, database, {
        role: 'personal', health, projectRoot: fixture.runtime, codeRoot, privateRoot: personalPrivateRoot,
        resources, processRuntime, whisperModelPath, workspaceServices: serviceServices,
        localData: { lifecycle: localData, dataId }, localDataControlPath: controlDatabasePath,
        credentialReference: configuration.credentialReference, modelConfigurationVersion,
        modelConnection: { endpoint: configuration.pi.customModel!.baseUrl, protocol: configuration.pi.customModel!.api },
        modelInput: configuration.pi.customModel!.input,
        browser: browserHost?.configuration, browserUnavailableReason,
      })) });
    if (!resumed) localData.bindIdentity(dataId, personal.database.path);
    assert.equal(localData.identityStatus(dataId, personal.database.path), 'matched');
    const address = personal.server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    writeJson(join(input.evidenceRoot, `live-model-host-${basename(fixture.root)}${resumed ? `-${process.pid}` : ''}.json`), {
      startedAt: new Date().toISOString(), reusedExistingState: !!resumed,
      resumedFromHost: input.resumeHostFile ?? null,
      url, pid: process.pid, isolatedRuntime: fixture.runtime, isolatedWfdStore: fixture.store,
      personalDatabase: personal.database.path, serviceDatabase: service!.database.path,
      model: health.model, provider: health.provider, configured: health.configured,
      defaultThinkingLevel: configuration.pi.defaultThinkingLevel,
      personalMaxModelRequests: 8, personalMaxTokens: configuration.pi.customModel?.maxTokens,
      serviceMaxModelRequests: 4, serviceMaxTokens: 1024,
      browserReady: !!browserHost, browserUnavailableReason: browserUnavailableReason ?? null,
      wfdConnectionId: 'full-chain-test', realRuntimeIdentity: real.document.runtimeIdentity,
      realBindingRevision: real.document.revision,
      sourceModelSha256: modelSha256, workspaceBdVersion: WORKSPACE_BD_VERSION,
      sourceHashes: Object.fromEntries(['modules/agent/model-tools.ts', 'modules/collection/conversation-materials.ts',
        'apps/server/configured-app.ts', 'apps/server/live-model-test-support.ts'].map(path => [path,
          createHash('sha256').update(readFileSync(join(codeRoot, path))).digest('hex')])),
      localData: { status: localData.status(dataId).status, adopted: localData.status(dataId).adopted,
        generation: localData.status(dataId).generation, identity: localData.identityStatus(dataId, personal.database.path) },
    });
    return { url, fixture, service, personal, browserHost,
      async shutdown() {
        await personal.shutdown();
        await service!.shutdown();
        await browserHost?.shutdown();
        await localData.close();
      } };
  } catch (error) {
    await service?.shutdown().catch(() => {});
    await browserHost?.shutdown().catch(() => {});
    await localData.close().catch(() => {});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [realRoot, evidenceRoot, webRoot, resumeArgument] = process.argv.slice(2);
  if (!realRoot || !evidenceRoot || !webRoot) throw new Error('Expected real runtime root, new evidence root, and independent web build root.');
  if (resumeArgument && !resumeArgument.startsWith('--resume-host=')) throw new Error('Expected --resume-host=existing-metadata.json.');
  const host = await startLiveModelTestHost({ realRoot, evidenceRoot, webRoot,
    ...(resumeArgument ? { resumeHostFile: resumeArgument.slice('--resume-host='.length) } : {}) });
  console.log(JSON.stringify({ url: host.url, isolatedRuntime: host.fixture.runtime, browserReady: !!host.browserHost }));
  let closing: Promise<void> | undefined;
  const stop = () => { closing ??= host.shutdown(); void closing.then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

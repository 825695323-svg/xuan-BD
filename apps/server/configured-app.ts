import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createPiBackend } from '../../modules/agent/runtime/pi.js';
import { BackendRegistry } from '../../platform/runtime/backends.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { loadAppConfiguration } from '../../platform/config/model.js';
import { readConnectionRegistry, registeredBaiduDriveConfiguration } from '../../platform/config/connections.js';
import { startLocalServer } from './boot.js';
import { createApplicationServices, type ApplicationServices, type ServiceOptions } from './services.js';
import { loadToolConfiguration } from '../../platform/config/tools.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { HARNESS_VERSION, COLLECTION_HARNESS_VERSION, WORKSPACE_HARNESS_VERSION, SERVICE_SYSTEM_PROMPT, COLLECTION_SYSTEM_PROMPT, WORKSPACE_SYSTEM_PROMPT } from '../../modules/agent/service.js';
import { localAlgorithmConfiguration, localFinancialConfiguration } from './financial-configuration.js';
import { createMaterialTableReader } from '../../modules/financial/managed-table.js';
import { ResourceBindings, launcherPath } from '../../platform/resources/bindings.js';
import { BundledResources } from '../../platform/resources/bundled.js';
import { startBrowserHost, type BrowserHost } from '../../platform/capabilities/browser/host.js';
import { createCaptureSessionService, type CaptureSessionService } from '../../plugins/capture-sources/session.js';
import { CustomSourceRegistry } from '../../plugins/capture-sources/custom-register.js';
import type { NativeUserCycleConfiguration } from '../../adapters/database/user-cycle-config.js';
import { startRegisteredDatabaseLineHosts, type NativeDatabaseLineConfiguration } from '../../adapters/database/native-lines.js';
import { acquireRuntimeStartupFence, readHarnessRuntime } from '../../platform/runtime/runtime-profile.js';
import { LocalDataLifecycle, type LocalDataSettlementContext, type LocalDataSettler, type LocalDataSettlementResult } from '../../platform/runtime/local-data-lifecycle.js';
import { startInactiveLocalHost } from './inactive-app.js';
import { LocalDataLifecycleError } from '../../platform/runtime/errors.js';

export interface ConfiguredApplicationOptions {
  /** 原项目中的显式配置、数据库与个人文件位置；启动不会复制或迁移它们。 */
  workspaceRoot: string;
  /** Trusted maintenance/testing locator; never supplied by a browser or a model. */
  launcherFile?: string;
  /** 可只读的已编译代码与依赖位置；不同于 workspaceRoot 时整体保护。 */
  codeRoot?: string;
  /** 同一进程内 personal/workspace 共享的唯一本地资料控制；不另建第二份控制库。 */
  sharedLocalData?: LocalDataLifecycle;
  /** 只由已核父 reload 装配传递；子服务不能用客户端字段声明。 */
  sharedLocalDataReloadGeneration?: number;
  /** 打包后的界面资源位置；缺省沿用 codeRoot/dist/web。 */
  webRoot?: string;
  port?: number;
  /** 仅受信宿主创建服务角色附属实例时使用；复用主应用入口，不另起监听。 */
  listen?: false;
  /** 缺省使用个人会话；服务模式拥有独立角色状态位置，不导入个人数据。 */
  role?: 'personal' | 'service';
  /** 仅服务验收或受信宿主明确指定；不用于覆盖个人数据库。 */
  serviceStateRoot?: string;
  serviceFilesRoot?: string;
  configureCollection?: ServiceOptions['configureCollection'];
  configureFinancial?: ServiceOptions['configureFinancial'];
  configureAlgorithms?: ServiceOptions['configureAlgorithms'];
  materials?: ServiceOptions['materials'];
  userTestDatabase?: NativeUserCycleConfiguration;
  databaseInitialConfiguration?: NativeDatabaseLineConfiguration;
  databaseLineConfigurations?: ServiceOptions['databaseLineConfigurations'];
  /** 同一应用个人宿主已拥有并核验的浏览器；独立服务不另起浏览器或采用全机守护进程。 */
  sharedBrowser?: ServiceOptions['browser'];
  sharedBrowserUnavailableReason?: string;
  /** 可信网页或桌面宿主装配；独立状态与任务，通过同源窄接口供主导航使用。 */
  workspaceCompanion?: { configureFinancial?: ServiceOptions['configureFinancial']; configureAlgorithms?: ServiceOptions['configureAlgorithms']; userTestDatabase?: NativeUserCycleConfiguration; databaseInitialConfiguration?: NativeDatabaseLineConfiguration; databaseLineConfigurations?: ServiceOptions['databaseLineConfigurations'] };
}

export interface ConfiguredApplication {
  running: Awaited<ReturnType<typeof startLocalServer>> | Awaited<ReturnType<typeof startInactiveLocalHost>>;
  mode: 'pi' | 'demo';
  /** 可向界面公开的状态，不包含密钥或完整模型配置。 */
  health: HealthResponse;
}

/** 网站与桌面子进程共用装配；先占用入口的边界由 startLocalServer 保持。 */
export async function startConfiguredApplication(options: ConfiguredApplicationOptions): Promise<ConfiguredApplication> {
  for (const path of [options.workspaceRoot, options.codeRoot, options.webRoot, options.serviceStateRoot, options.serviceFilesRoot]) {
    if (path !== undefined && (typeof path !== 'string' || !path.trim() || !isAbsolute(path) || path.includes('\0'))) {
      throw new Error('启动目录需要明确的绝对路径。');
    }
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const codeRoot = resolve(options.codeRoot ?? workspaceRoot);
  const resources = new ResourceBindings(workspaceRoot);
  const bundle = new BundledResources(codeRoot);
  bundle.assertBindings(resources);
  readHarnessRuntime(workspaceRoot);
  for (const database of [options.databaseInitialConfiguration, options.userTestDatabase, ...(options.databaseLineConfigurations ?? [])].filter(item => item !== undefined)) {
    if ('libraryRoot' in database && database.libraryRoot && database.harnessRootId !== resources.document.runtimeIdentity) throw new Error('数据库保管连接未绑定当前应用固定身份。');
  }
  const processRuntime = new ProcessRuntime(resources);
  if (options.role !== undefined && !['personal', 'service'].includes(options.role)) throw new Error('角色无效。');
  if (options.serviceStateRoot && options.role !== 'service') throw new Error('独立状态位置仅供服务角色使用。');
  if (options.configureCollection && (options.role !== 'service' || !options.serviceStateRoot)) throw new Error('数据收集验收需要显式服务角色和独立状态目录。');
  if ((options.configureFinancial || options.materials) && (options.role !== 'service' || !options.serviceStateRoot)) throw new Error('材料与金融工具需要显式服务角色和独立状态目录。');
  const service = options.role === 'service';
  if (options.listen === false && !service) throw new Error('不监听模式仅供受信宿主的服务角色附属实例使用。');
  if (service && options.workspaceCompanion) throw new Error('服务角色不能再派生另一个工作台。');
  const workspace = !!(options.configureFinancial || options.materials);
  const modelRequests = workspace ? 4 : 2;
  const serviceStateRoot = resolve(options.serviceStateRoot ?? resolve(resources.path('state'), 'service'));
  let workspaceExists = false;
  try { workspaceExists = (await stat(workspaceRoot)).isDirectory(); } catch { /* 不把无效位置当作新的数据根。 */ }
  if (!workspaceExists) throw new Error('指定的原工作目录不存在或无法访问。');
  if (service) {
    const servicePaths = ['', 'core.sqlite', 'core.sqlite-wal', 'core.sqlite-shm', 'core.sqlite-journal', 'resources', 'resources/artifacts', 'resources/attachments', 'resources/data'];
    const canonicalServicePaths: string[] = [];
    for (const path of servicePaths) {
      const target = resolve(serviceStateRoot, path);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('服务状态文件与资源目录不能使用符号链接或多链接文件。');
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      canonicalServicePaths.push(await canonicalFuturePath(target));
    }
    for (const path of [resolve(resources.path('state'), 'personal'), resolve(resources.path('task_files'), 'personal')]) {
      const personal = await canonicalFuturePath(path);
      if (canonicalServicePaths.some(statePath => contains(statePath, personal) || contains(personal, statePath))) {
        throw new Error('服务状态位置不能与个人状态目录重叠或指向其链接。');
      }
    }
  }
  const webRoot = resolve(options.webRoot ?? resolve(codeRoot, 'dist/web'));
  const localDataId = resources.document.runtimeIdentity;
  const controlDatabasePath = resolve(workspaceRoot, 'control', 'local-data-lifecycle.sqlite');
  const personalDatabasePath = service ? resolve(serviceStateRoot, 'core.sqlite')
    : resolve(resources.path('state'), 'personal', 'core.sqlite');
  let settleImpl: LocalDataSettler | undefined;
  let localDataLifecycle: LocalDataLifecycle | undefined = options.sharedLocalData;
  // 启动资格先读控制记录；停用/解绑/身份不匹配时在打开个人状态库之前转为最小宿主。
  if (service && !localDataLifecycle) {
    throw Object.assign(new Error('独立服务角色必须由主宿主共享同一本地资料控制；拒绝在无共享控制下启动。'), { code: 'SERVICE_REQUIRES_SHARED_LOCAL_DATA' });
  }
  if (!service) {
    localDataLifecycle ??= new LocalDataLifecycle({
      controlDatabasePath,
      cleanupRoots: [resolve(resources.path('state'), 'personal'), resolve(resources.path('state'), 'workspace'),
        resolve(resources.path('task_files'), 'personal'), resolve(resources.path('task_files'), 'workspace')],
      dataIdFromTask: () => localDataId,
      settle: async (context) => {
        if (!settleImpl) throw new LocalDataLifecycleError('LOCAL_DATA_SETTLE_NOT_READY', '停用收束组件尚未装配。');
        return settleImpl(context);
      },
    });
  }
  const lifecycle = localDataLifecycle!;
  let record: ReturnType<LocalDataLifecycle['status']> | null = null;
  try { record = lifecycle.status(localDataId); }
  catch (error) {
    if (!(error instanceof LocalDataLifecycleError) || error.code !== 'LOCAL_DATA_UNKNOWN') throw error;
    // 控制库已有其他身份时不能把当前身份当首次采用；原资料缺失不能重建。
    if (lifecycle.list().length) record = null;
  }
  if (!service && !record) {
    if (lifecycle.list().length) {
      return { running: await startInactiveLocalHost({ port: options.port, webRoot, lifecycle, dataId: localDataId,
        detail: '控制记录属于其他运行身份；当前身份没有采用记录，不能自动重建或替换原资料。' }), mode: 'pi', health: inactiveHealth() };
    }
    record = lifecycle.register(localDataId);
  }
  if (!record) throw new Error('本地资料控制记录不可用。');
  const parentReload = service && Number.isSafeInteger(options.sharedLocalDataReloadGeneration)
    && record.generation === options.sharedLocalDataReloadGeneration
    && (record.status === 'inactive' || record.status === 'unbound' || record.status === 'deactivating')
    && !!record.reloadPending;
  if (service && (record.status !== 'active' || !record.adopted) && !parentReload) {
    throw Object.assign(new Error('共享本地资料控制不是活动采用状态，独立服务拒绝打开个人内容。'), { code: 'LOCAL_DATA_DEACTIVATED' });
  }
  const identity = service ? 'matched' as const : lifecycle.identityStatus(localDataId, personalDatabasePath);
  const activeLoad = record.status === 'active' && record.adopted && !record.reloadPending;
  const reloadLoad = (record.status === 'inactive' || record.status === 'unbound' || record.status === 'deactivating')
    && !!record.reloadPending && identity === 'matched';
  const canLoad = service || (activeLoad && (identity === 'matched' || identity === 'unbound')) || reloadLoad;
  if (!canLoad) {
    const detail = identity === 'missing' ? '原个人资料位置缺失或与采用记录不一致；不会自动重建。'
      : identity === 'replaced' ? '原个人资料对象身份已被替换；不会自动加载或重建。'
      : record.status === 'deactivating' ? '停用尚未确认收束；当前仅提供安全控制入口。'
      : record.status === 'unbound' ? '此本地资料已解除采用关系；重新采用需明确受信入口。'
      : record.reloadPending ? '已保存重新加载；需重启后核对同一原身份再实际加载。'
      : '当前本地资料未启用；仅提供资格核对与重新加载保存入口。';
    return { running: await startInactiveLocalHost({ port: options.port, webRoot, lifecycle, dataId: localDataId, detail,
      health: inactiveHealth(),
      reloadBlocker: () => {
        const current = lifecycle.identityStatus(localDataId, personalDatabasePath);
        return current === 'matched' ? null : current === 'missing' ? '原个人资料缺失，不能保存重新加载。'
          : current === 'replaced' ? '原个人资料对象身份已变化，不能保存重新加载。' : '尚未核对原个人资料身份，不能保存重新加载。';
      } }), mode: 'pi', health: inactiveHealth() };
  }
  // 直接读取既有模型参数，不加载旧网页入口或演示环境配置。
  const env: NodeJS.ProcessEnv = { MASHIRO_BACKEND: 'pi', MASHIRO_CONFIG: resolve(resources.path('config'), 'model.json') };
  const configuration = await loadAppConfiguration(workspaceRoot, env, processRuntime);
  const modelConfigurationVersion = digestOperationArgs({ provider: configuration.pi.provider, model: configuration.pi.model,
    customModel: configuration.pi.customModel, defaultThinkingLevel: configuration.pi.defaultThinkingLevel,
    credentialReference: configuration.credentialReference ?? null });
  const tools = { ...(service ? {} : await loadToolConfiguration(workspaceRoot, resources.path('config'))), whisperModelPath: bundle.model('whisper_base') };
  const { mode, health } = configuration;
  const registry = new BackendRegistry();
  let services: ApplicationServices | undefined;
  const currentServices = () => {
    if (!services) throw new Error('个人核心服务尚未准备好。');
    return services;
  };
  registry.register(createPiBackend({
    ...configuration.pi,
    ...(service ? { systemPrompt: workspace ? WORKSPACE_SYSTEM_PROMPT : options.configureCollection ? COLLECTION_SYSTEM_PROMPT : SERVICE_SYSTEM_PROMPT,
      customModel: configuration.pi.customModel ? { ...configuration.pi.customModel, maxTokens: 1024 } : undefined } : {}),
    maxModelRequests: service ? modelRequests : 8,
    toolFactory: (context) => currentServices().modelTools.toolFactory(context),
    beforeModelRequest: (...args) => currentServices().modelTools.beforeModelRequest(...args),
    projectToolResult: (...args) => currentServices().modelTools.projectToolResult(...args),
    contextIdentity: (...args) => currentServices().modelTools.contextIdentity(...args),
    contextProvider: (input, signal) => currentServices().modelContext(input, signal),
  }));
  let companion: ConfiguredApplication | undefined;
  let databaseHost: Awaited<ReturnType<typeof startRegisteredDatabaseLineHosts>> | undefined;
  let captureSessions: CaptureSessionService | undefined;
  let captureUnavailableReason: string | undefined;
  let browserHost: BrowserHost | undefined;
  let browserCleanup: (() => Promise<void>) | undefined;
  let browserUnavailableReason = options.sharedBrowserUnavailableReason;
  let running: Awaited<ReturnType<typeof startLocalServer>>;
  let companionReloadGeneration: number | undefined;
  const customSources = new CustomSourceRegistry(join(resources.path('config'), 'custom-sources.json'));
  let baiduDrive: { binaryPath: string; configPath: string; tokenKeyPath?: string } | undefined;
  try {
    const binaryPath = processRuntime.path('bdpan');
    baiduDrive = registeredBaiduDriveConfiguration(readConnectionRegistry(resources.document.resources.connections_registry ? resources.path('connections_registry') : undefined), binaryPath);
  } catch { /* bdpan 未登记：网盘动作保持不可用，不影响其他能力。 */ }
  // 真实收束钩子在组件装配完成后注入；控制实例本身已按启动资格提前打开。
  settleImpl = context => settleOwnedLocalData(context, {
    services: () => services,
    closeCapture: async () => { await captureSessions?.close(); return !!captureSessions; },
    closeBrowser: async () => { if (!browserCleanup) return false; const close = browserCleanup; browserCleanup = undefined; await close(); return true; },
  });
  const openLocalDataControl = (): LocalDataLifecycle => lifecycle;
  const verifyLocalData = !service ? async (input: { dataId: string; operationId: string }) => {
    const controller = lifecycle;
    if (!controller) throw new LocalDataLifecycleError('LOCAL_DATA_LIFECYCLE_NOT_WIRED', '本地资料控制尚未打开。');
    const record = controller.status(input.dataId);
    const operation = record.lastOperation;
    if (!operation || operation.operationId !== input.operationId || operation.dataId !== input.dataId) {
      throw new LocalDataLifecycleError('OPERATION_NOT_FOUND', '没有找到该资料的停用操作。');
    }
    // 客户端只能请求核对；这里由宿主重新取消/查询任务并复查组件关闭证据。
    const result = await settleOwnedLocalData({ dataId: input.dataId, operationId: input.operationId, generation: operation.generation,
      reason: operation.reason, signal: AbortSignal.timeout(30_000) }, {
      services: () => services,
      closeCapture: async () => { await captureSessions?.close(); return !!captureSessions; },
      closeBrowser: async () => { if (!browserCleanup) return false; const close = browserCleanup; browserCleanup = undefined; await close(); return true; },
    });
    return controller.reconcile({ dataId: input.dataId, operationId: input.operationId, outcome: result.outcome,
      evidence: result.evidence, pendingTaskIds: result.pendingTaskIds, executionStopped: result.executionStopped === true });
  } : undefined;
  try { running = await startLocalServer({
    backend: registry.get(mode), registry, health, port: options.port, listen: options.listen, webRoot,
    databasePath: service ? resolve(serviceStateRoot, 'core.sqlite') : resolve(resources.path('state'), 'personal', mode === 'demo' ? 'demo.sqlite' : 'core.sqlite'),
    acquireStartupFence: () => acquireRuntimeStartupFence(options.launcherFile ?? launcherPath(), workspaceRoot),
    beforeInitialize: async () => {
      // 状态所有权与启动栅栏已取得；打开个人库前按控制记录再核一次，防止预检后资格变化。
      const controller = openLocalDataControl();
      const latest = controller.status(localDataId);
      const latestIdentity = service ? 'matched' as const : controller.identityStatus(localDataId, personalDatabasePath);
      const allowedActive = latest.status === 'active' && latest.adopted && !latest.reloadPending
        && (latestIdentity === 'matched' || latestIdentity === 'unbound');
      const allowedReload = (latest.status === 'inactive' || latest.status === 'unbound' || latest.status === 'deactivating')
        && !!latest.reloadPending && latestIdentity === 'matched';
      if (!(allowedActive || allowedReload)) {
        throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_CHANGED', '启动准备期间本地资料资格已变化，未打开个人内容。');
      }
      if (!service) companionReloadGeneration = allowedReload ? latest.generation : undefined;
      if (!service) {
        try {
          captureSessions = createCaptureSessionService({ processRuntime, runtimeIdentity: resources.document.runtimeIdentity,
            homeRoot: resources.path('browser_home'), logsRoot: join(resources.path('state'), 'capture-sources'), ...bundle.browser() });
        } catch {
          captureUnavailableReason = '采集源独立会话资源尚未就绪，请核对当前运行根绑定。';
        }
        try {
          browserHost = await startBrowserHost({ processRuntime, runtimeIdentity: resources.document.runtimeIdentity,
            homeRoot: resources.path('browser_home'), ...bundle.browser(), headless: true,
            onCleanupAvailable: cleanup => { browserCleanup = cleanup; } });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_HOST_UNAVAILABLE';
          browserUnavailableReason = `随包浏览器尚未就绪（${/^[A-Z_]+$/u.test(code) ? code : 'BROWSER_HOST_UNAVAILABLE'}）；请核对本运行根资源或原所有者记录。不会采用系统浏览器或旧守护进程。`;
        }
      }
      if (!options.workspaceCompanion) return;
      const supplied = options.workspaceCompanion.databaseInitialConfiguration ?? options.workspaceCompanion.userTestDatabase
        ?? options.workspaceCompanion.databaseLineConfigurations?.[0];
      if (!supplied) databaseHost = await startRegisteredDatabaseLineHosts(resources, processRuntime);
      const initialDatabase = supplied ?? databaseHost?.initialConfiguration;
      const additionalDatabases = [...(databaseHost?.configurations ?? []), ...(options.workspaceCompanion.databaseLineConfigurations ?? [])]
        .filter(configuration => configuration !== initialDatabase);
      companion = await startConfiguredApplication({ workspaceRoot, codeRoot, webRoot, role: 'service',
        launcherFile: options.launcherFile,
        ...(localDataLifecycle ? { sharedLocalData: localDataLifecycle } : {}),
        ...(companionReloadGeneration !== undefined ? { sharedLocalDataReloadGeneration: companionReloadGeneration } : {}),
        sharedBrowser: browserHost?.configuration, sharedBrowserUnavailableReason: browserUnavailableReason,
        listen: false, serviceStateRoot: resolve(resources.path('state'), 'workspace'), serviceFilesRoot: resolve(resources.path('task_files'), 'workspace'),
        materials: { environment: 'local-review' }, configureFinancial: options.workspaceCompanion.configureFinancial ?? localFinancialConfiguration(resources),
        configureAlgorithms: options.workspaceCompanion.configureAlgorithms ?? localAlgorithmConfiguration({ projectRoot: codeRoot, resources,
          tables: materialService => createMaterialTableReader(materialService), databaseSnapshots: true }),
        ...(initialDatabase?.mode === 'user_test' && initialDatabase.inputDatasetId ? { userTestDatabase: { ...initialDatabase, mode: 'user_test', inputDatasetId: initialDatabase.inputDatasetId } as NativeUserCycleConfiguration } : {}),
        ...(initialDatabase && 'connectionId' in initialDatabase ? { databaseInitialConfiguration: initialDatabase as NativeDatabaseLineConfiguration } : {}),
        databaseLineConfigurations: additionalDatabases });

    },
    beforeShutdown: async () => {
      // 先收束可能仍在交接的个人任务，随后关闭配套服务，最后关闭本宿主持有的数据库进程。
      await settleOwnedResources([
        () => databaseHost || browserCleanup || captureSessions ? services?.tasks.dispose() : undefined,
        () => databaseHost || browserCleanup || captureSessions ? running?.core.dispose() : undefined,
        () => companion?.running.shutdown(),
        () => captureSessions?.close(),
        () => !service ? browserCleanup?.() : undefined,
        () => !service ? localDataLifecycle?.close() : undefined,
        () => databaseHost?.shutdown(),
      ]);
    },
    initializeServices: (core, database) => (services = createApplicationServices(core, database, {
      projectRoot: workspaceRoot, codeRoot, resources, processRuntime,
      privateRoot: service ? options.serviceFilesRoot ?? resolve(resources.path('task_files'), 'service') : resolve(resources.path('task_files'), mode === 'demo' ? 'demo' : 'personal'),
      role: options.role,
      ...(lifecycle ? { localData: { lifecycle, dataId: localDataId,
        verify: verifyLocalData ?? (async () => { throw new LocalDataLifecycleError('LOCAL_DATA_VERIFY_NOT_WIRED', '当前宿主尚未装配本地资料核对入口。'); }) } } : {}),
      localDataControlPath: controlDatabasePath,
      ...(service ? { controlStateRoot: serviceStateRoot } : {}),
      ...(service ? { serviceVersions: { harness: workspace ? WORKSPACE_HARNESS_VERSION : options.configureCollection ? COLLECTION_HARNESS_VERSION : HARNESS_VERSION, model: `${health.provider}/${health.model}`,
        modelConfiguration: modelConfigurationVersion,
        budget: `requests=${modelRequests};output=1024;timeout_ms=60000` } } : {}),
      health, credentialReference: configuration.credentialReference,
      modelConfigurationVersion,
      ...(configuration.pi.customModel ? { modelConnection: { endpoint: configuration.pi.customModel.baseUrl, protocol: configuration.pi.customModel.api } } : {}),
      modelInput: configuration.pi.customModel?.input,
      configureCollection: options.configureCollection,
      configureFinancial: options.configureFinancial, configureAlgorithms: options.configureAlgorithms, materials: options.materials,
      userTestDatabase: options.userTestDatabase,
      databaseInitialConfiguration: options.databaseInitialConfiguration,
      databaseLineConfigurations: options.databaseLineConfigurations,
      workspaceServices: companion?.running && 'services' in companion.running ? companion.running.services : undefined,
      browser: browserHost?.configuration ?? options.sharedBrowser, browserUnavailableReason,
      captureSessions, captureUnavailableReason, customSources,
      ...(baiduDrive ? { baiduDrive } : {}),
      ...tools,
    })),
  }); } catch (error) {
    try { await settleOwnedResources([() => companion?.running.shutdown(), () => captureSessions?.close(), () => !service ? browserCleanup?.() : undefined, () => !service ? localDataLifecycle?.close() : undefined, () => databaseHost?.shutdown()]); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '启动失败且自有资源清理未全部确认。'); }
    throw error;
  }
  if (!service) {
    const owner = running as Awaited<ReturnType<typeof startLocalServer>>;
    try {
      if (owner.database?.path && owner.database.path !== ':memory:') lifecycle.bindIdentity(localDataId, owner.database.path);
      if (reloadLoad) lifecycle.markReloadLoaded(localDataId);
    } catch (error) {
      // 身份记录或实际加载确认失败时不能留下已打开的个人 Core/浏览器/任务。
      await owner.shutdown().catch(() => {});
      throw error;
    }
  }
  return { running, mode, health };
}

function inactiveHealth(): HealthResponse {
  return { name: 'xuan BD', backend: 'pi', configured: false, model: null, provider: null,
    notice: '当前本地资料未加载；仅提供资格核对与重新加载保存入口。' };
}


type HostSettlementDeps = {
  services: () => ApplicationServices | undefined;
  closeCapture: () => Promise<boolean>;
  closeBrowser: () => Promise<boolean>;
};

/**
 * 宿主真实收束：personal/workspace 任务统一取消并复查，采集会话与浏览器按原关闭接口退出。
 * 只返回已核实的证据；任何未退出、待核任务或收束异常都保持未决，不删文件/凭据/外部结果。
 */
async function settleOwnedLocalData(context: LocalDataSettlementContext, deps: HostSettlementDeps): Promise<LocalDataSettlementResult> {
  const current = deps.services();
  if (!current) return { outcome: 'unresolved', evidence: '宿主服务尚未装配，不能确认任务与组件收束。', pendingTaskIds: [] };
  const serviceOwners = [current, current.options.workspaceServices].filter((item): item is ApplicationServices => !!item);
  const owners = serviceOwners.map((owner) => owner.tasks);
  const pairs = owners.flatMap((tasks) => tasks.list({ limit: 1000 }).map((task) => ({ tasks, task })));
  if (owners.some((tasks) => tasks.list({ limit: 1000 }).length >= 1000)) {
    return { outcome: 'unresolved', evidence: '任务列表达到 1,000 条查询上限，不能确认全部收束。', pendingTaskIds: [] };
  }
  const active = pairs.filter(({ task }) => ['running', 'waiting_approval', 'pausing', 'cancelling'].includes(task.status));
  const stopped = await Promise.allSettled(active.map(({ tasks, task }) => tasks.cancel(task.id)));
  const stopFailed = stopped.some((result) => result.status === 'rejected');
  let executingNow = 0, unconfirmedWorkers = 0, executionFactsFailed = false;
  const executionTaskIds = new Set<string>();
  for (const owner of serviceOwners) {
    try {
      const facts = owner.tasks.executionFacts();
      executingNow += facts.executing;
      unconfirmedWorkers += facts.unconfirmedWorkers;
      for (const taskId of facts.unconfirmedTaskIds) executionTaskIds.add(taskId);
    } catch { executionFactsFailed = true; }
  }
  // 任务服务之外，个人/工作台 Core 自己的模型运行与待发队列也必须真实收束。
  const coreResults = await Promise.allSettled(serviceOwners.map((owner) => Promise.race([
    owner.core.quiesceForDeactivation('本地资料已停用；当前模型运行与待发队列不自动继续或重放。'),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CORE_SETTLE_TIMEOUT')), 15_000);
      timer.unref();
    }),
  ])));
  let remainingRuns = 0, heldQueued = 0;
  for (const result of coreResults) {
    if (result.status === 'rejected') { remainingRuns += 1; continue; }
    remainingRuns += result.value.remainingRuns;
    heldQueued += result.value.heldQueued;
  }
  const pending = new Set<string>(executionTaskIds);
  let activeNow = 0;
  for (const { tasks, task } of pairs) {
    let latest;
    try { latest = tasks.get(task.id); } catch { pending.add(task.id); activeNow += 1; continue; }
    if (['running', 'waiting_approval', 'pausing', 'cancelling'].includes(latest.status)) activeNow += 1;
    if (latest.requiresReview || latest.status === 'needs_review'
      || ['running', 'waiting_approval', 'pausing', 'cancelling'].includes(latest.status)) pending.add(latest.id);
  }
  for (let index = 0; index < stopped.length; index += 1) if (stopped[index]!.status === 'rejected') pending.add(active[index]!.task.id);
  let capture = false, browser = false;
  const notes: string[] = [];
  try { capture = await deps.closeCapture(); notes.push(capture ? '采集会话关闭已确认。' : '本次无独立采集会话。'); }
  catch (error) { notes.push(`采集会话关闭未确认：${describe(error)}`); }
  try { browser = await deps.closeBrowser(); notes.push(browser ? '浏览器宿主退出已确认。' : '本次无宿主浏览器进程。'); }
  catch (error) { notes.push(`浏览器宿主退出未确认：${describe(error)}`); }
  let approvals = 0;
  for (const owner of serviceOwners) {
    try { approvals += owner.permissions.listApprovals().filter((item) => item.status === 'pending').length; }
    catch (error) { notes.push(`审批资格核对失败：${describe(error)}`); approvals += 1; }
  }
  const executionStopped = remainingRuns === 0 && activeNow === 0 && approvals === 0
    && executingNow === 0 && unconfirmedWorkers === 0 && !stopFailed && !executionFactsFailed
    && !notes.some((note) => note.includes('未确认') || note.includes('失败'));
  const evidence = `任务：关联 ${pairs.length}，请求停止 ${active.length}，待核 ${pending.size}；` +
    `Core 模型运行未收束 ${remainingRuns}，保留待发队列 ${heldQueued}；实际 drive 未退出 ${executingNow}，tool worker 未确认退出 ${unconfirmedWorkers}，停止调用失败 ${stopFailed ? 1 : 0}；` +
    `执行器${executionStopped ? '已停' : '未确认停止'}；${notes.join('')}待批审批 ${approvals}；ProcessRuntime 无常驻子进程登记，执行由任务尝试收束；未删除文件、凭据或外部数据库。`;
  const unresolved = pending.size > 0 || !executionStopped;
  return { outcome: unresolved ? 'unresolved' : 'settled', evidence, pendingTaskIds: [...pending], executionStopped };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 创建前解析已存在祖先，防止状态目录别名绕过角色隔离。 */
async function canonicalFuturePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || dirname(path) === path) throw error;
    return resolve(await canonicalFuturePath(dirname(path)), basename(path));
  }
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 按依赖顺序尝试每个自有资源；保留所有失败，不因前项拒绝遗漏后项。 */
export async function settleOwnedResources(close: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of close) try { await dispose(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '自有资源未全部确认收束，原失败及未确认所有权仍保留。');
}

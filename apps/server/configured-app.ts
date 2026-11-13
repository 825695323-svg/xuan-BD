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
import { localAlgorithmConfiguration } from './financial-configuration.js';
import { loadToolConfiguration } from '../../platform/config/tools.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { BD_VERSION, COLLECTION_BD_VERSION, WORKSPACE_BD_VERSION, SERVICE_SYSTEM_PROMPT, COLLECTION_SYSTEM_PROMPT, WORKSPACE_SYSTEM_PROMPT } from '../../modules/agent/service.js';
import { ResourceBindings, launcherPath } from '../../platform/resources/bindings.js';
import { applicationResources } from '../../platform/resources/local-web.js';
import { startBrowserHost, type BrowserHost } from '../../platform/capabilities/browser/host.js';
import { createCaptureSessionService, type CaptureSessionService } from '../../plugins/capture-sources/session.js';
import { CustomSourceRegistry } from '../../plugins/capture-sources/custom-register.js';
import { acquireRuntimeStartupFence, readBdRuntime } from '../../platform/runtime/runtime-profile.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
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
  materials?: ServiceOptions['materials'];
  /** 同一应用个人宿主已拥有并核验的浏览器；独立服务不另起浏览器或采用全机守护进程。 */
  sharedBrowser?: ServiceOptions['browser'];
  sharedBrowserUnavailableReason?: string;
  /** 可信网页或桌面宿主装配；独立状态与任务，通过同源窄接口供主导航使用。 */
  workspaceCompanion?: boolean;
}

export interface ConfiguredApplication {
  running: Awaited<ReturnType<typeof startLocalServer>> | Awaited<ReturnType<typeof startInactiveLocalHost>>;
  mode: 'pi' | 'demo';
  /** 可向界面公开的状态，不包含密钥或完整模型配置。 */
  health: HealthResponse;
}

/** 启动身份准入判定；集中处理首次绑定、身份行缺失、状态库缺失/替换与独立服务角色例外。 */
export type StartupIdentity = 'matched' | 'missing' | 'replaced' | 'unbound';
export interface StartupIdentityInput {
  service: boolean;
  /** 独立服务角色必须共享主宿主已核验的控制实例，不能自行跳过身份核验。 */
  sharedControl: boolean;
  identity: StartupIdentity;
  /** 仅当本次确实新建了控制记录（register 让记录数 +1）时为 true。 */
  firstBinding: boolean;
  active: boolean;
  adopted: boolean;
}
export function startupIdentityDecision(input: StartupIdentityInput): { allowed: boolean; detail: string | null } {
  if (!input.active || !input.adopted) return { allowed: false, detail: '当前本地资料控制记录不是活动采用状态；未加载个人内容。' };
  if (input.service) {
    if (!input.sharedControl) return { allowed: false, detail: '独立服务角色没有共享已核验的本地资料控制实例；不能加载。' };
    return input.identity === 'matched' ? { allowed: true, detail: null }
      : { allowed: false, detail: '独立服务角色共享的控制实例身份未匹配；不能加载。' };
  }
  if (input.identity === 'matched') return { allowed: true, detail: null };
  if (input.identity === 'unbound') return input.firstBinding
    ? { allowed: true, detail: null }
    : { allowed: false, detail: '已有控制记录缺少状态库身份绑定；不能自动重新绑定或替换原资料。' };
  if (input.identity === 'missing') return { allowed: false, detail: '原个人资料位置缺失或与采用记录不一致；不会自动重建。' };
  return { allowed: false, detail: '原个人资料对象身份已被替换；不会自动加载或重建。' };
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
  const assets = applicationResources(codeRoot, resources);
  readBdRuntime(workspaceRoot);
  const processRuntime = new ProcessRuntime(resources);
  if (options.role !== undefined && !['personal', 'service'].includes(options.role)) throw new Error('角色无效。');
  if (options.serviceStateRoot && options.role !== 'service') throw new Error('独立状态位置仅供服务角色使用。');
  if (options.configureCollection && (options.role !== 'service' || !options.serviceStateRoot)) throw new Error('数据收集验收需要显式服务角色和独立状态目录。');
  if (options.materials && (options.role !== 'service' || !options.serviceStateRoot)) throw new Error('材料需要显式服务角色和独立状态目录。');
  const service = options.role === 'service';
  if (options.listen === false && !service) throw new Error('不监听模式仅供受信宿主的服务角色附属实例使用。');
  if (service && options.workspaceCompanion) throw new Error('服务角色不能再派生另一个工作台。');
  const workspace = !!options.materials;
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
    });
  }
  const lifecycle = localDataLifecycle!;
  let record: ReturnType<LocalDataLifecycle['status']> | null = null;
  let firstBinding = false;
  try { record = lifecycle.status(localDataId); }
  catch (error) {
    if (!(error instanceof LocalDataLifecycleError) || error.code !== 'LOCAL_DATA_UNKNOWN') throw error;
    // 控制库已有其他身份时不能把当前身份当首次采用；原资料缺失不能重建。
    if (lifecycle.list().length) record = null;
  }
  if (!service && !record) {
    const existing = lifecycle.list().length;
    if (existing) {
      return { running: await startInactiveLocalHost({ port: options.port, webRoot, lifecycle, dataId: localDataId,
        detail: '控制记录属于其他运行身份；当前身份没有采用记录，不能自动重建或替换原资料。' }), mode: 'pi', health: inactiveHealth() };
    }
    // 只有 register 确实让控制记录数 +1 才算本次新建；重复登记只读回，不获得首次绑定资格。
    record = lifecycle.register(localDataId);
    firstBinding = lifecycle.list().length === existing + 1;
  }
  if (!record) throw new Error('本地资料控制记录不可用。');
  // 启动门禁只核对本地状态库对象身份；不再判断停用/解绑/重新加载等人工流程状态。
  const identity = service ? 'matched' as const : lifecycle.identityStatus(localDataId, personalDatabasePath);
  const decision = startupIdentityDecision({ service: !!service, sharedControl: !!options.sharedLocalData,
    identity, firstBinding, active: record.status === 'active', adopted: record.adopted });
  if (!decision.allowed) {
    return { running: await startInactiveLocalHost({ port: options.port, webRoot, lifecycle, dataId: localDataId,
      detail: decision.detail ?? '本地资料身份未通过核对，已停止加载。', health: inactiveHealth() }), mode: 'pi', health: inactiveHealth() };
  }
  // 直接读取既有模型参数，不加载旧网页入口或演示环境配置。
  const env: NodeJS.ProcessEnv = { MASHIRO_BACKEND: 'pi',
    ...(!assets.modelDisabled ? { MASHIRO_CONFIG: resolve(resources.path('config'), 'model.json') } : {}) };
  const configuration = await loadAppConfiguration(workspaceRoot, env, processRuntime);
  // 显示名称直接取当前受信模型配置；模型编号和真实路由保持不变。
  configuration.health.displayName = assets.modelDisabled ? null
    : configuration.pi.customModel?.name ?? configuration.health.model;
  if (assets.modelDisabled) configuration.health.notice = '本地 Web 基础数据宿主；模型代理明确未启用，不读取模型配置或凭据。' + (assets.transcriptionUnavailableReason ?? '');
  const modelConfigurationVersion = assets.modelDisabled ? digestOperationArgs({ resourceMode: 'native', model: 'disabled' })
    : digestOperationArgs({ provider: configuration.pi.provider, model: configuration.pi.model,
      customModel: configuration.pi.customModel, defaultThinkingLevel: configuration.pi.defaultThinkingLevel,
      credentialReference: configuration.credentialReference ?? null });
  const tools = { ...(service ? {} : await loadToolConfiguration(workspaceRoot, resources.path('config'))), whisperModelPath: assets.whisperModelPath };
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
    maxModelRequests: service ? modelRequests : 32,
    toolFactory: (context) => currentServices().modelTools.toolFactory(context),
    beforeModelRequest: (...args) => currentServices().modelTools.beforeModelRequest(...args),
    projectToolResult: (...args) => currentServices().modelTools.projectToolResult(...args),
    contextIdentity: (...args) => currentServices().modelTools.contextIdentity(...args),
    contextProvider: (input, signal) => currentServices().modelContext(input, signal),
  }));
  let companion: ConfiguredApplication | undefined;
  let captureSessions: CaptureSessionService | undefined;
  let captureUnavailableReason: string | undefined = assets.browserUnavailableReason;
  let browserHost: BrowserHost | undefined;
  let browserCleanup: (() => Promise<void>) | undefined;
  let browserUnavailableReason = options.sharedBrowserUnavailableReason ?? assets.browserUnavailableReason;
  let running: Awaited<ReturnType<typeof startLocalServer>>;
  const customSources = new CustomSourceRegistry(join(resources.path('config'), 'custom-sources.json'));
  let baiduDrive: { binaryPath: string; configPath: string; tokenKeyPath?: string } | undefined;
  try {
    const binaryPath = processRuntime.path('bdpan');
    baiduDrive = registeredBaiduDriveConfiguration(readConnectionRegistry(resources.document.resources.connections_registry ? resources.path('connections_registry') : undefined), binaryPath);
  } catch { /* bdpan 未登记：网盘动作保持不可用，不影响其他能力。 */ }
  const openLocalDataControl = (): LocalDataLifecycle => lifecycle;
  try { running = await startLocalServer({
    backend: registry.get(mode), registry, health, port: options.port, listen: options.listen, webRoot,
    databasePath: service ? resolve(serviceStateRoot, 'core.sqlite') : resolve(resources.path('state'), 'personal', mode === 'demo' ? 'demo.sqlite' : 'core.sqlite'),
    acquireStartupFence: () => acquireRuntimeStartupFence(options.launcherFile ?? launcherPath(), workspaceRoot),
    beforeInitialize: async () => {
      // 状态所有权与启动栅栏已取得；打开个人库前按控制记录再核一次，防止预检后资格变化。
      const controller = openLocalDataControl();
      const latest = controller.status(localDataId);
      const latestIdentity = service ? 'matched' as const : controller.identityStatus(localDataId, personalDatabasePath);
      const latestDecision = startupIdentityDecision({ service: !!service, sharedControl: !!options.sharedLocalData,
        identity: latestIdentity, firstBinding, active: latest.status === 'active', adopted: latest.adopted });
      if (!latestDecision.allowed) {
        throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_CHANGED',
          `启动准备期间本地资料资格已变化，未打开个人内容。${latestDecision.detail ?? ''}`);
      }
      if (!service && !assets.browserUnavailableReason) {
        try {
          captureSessions = createCaptureSessionService({ processRuntime, runtimeIdentity: resources.document.runtimeIdentity,
            homeRoot: resources.path('browser_home'), logsRoot: join(resources.path('state'), 'capture-sources'), ...assets.browser() });
        } catch {
          captureUnavailableReason = '采集源独立会话资源尚未就绪，请核对当前运行根绑定。';
        }
        try {
          browserHost = await startBrowserHost({ processRuntime, runtimeIdentity: resources.document.runtimeIdentity,
            homeRoot: resources.path('browser_home'), ...assets.browser(), headless: true,
            onCleanupAvailable: cleanup => { browserCleanup = cleanup; } });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_HOST_UNAVAILABLE';
          browserUnavailableReason = `随包浏览器尚未就绪（${/^[A-Z_]+$/u.test(code) ? code : 'BROWSER_HOST_UNAVAILABLE'}）；请核对本运行根资源或原所有者记录。不会采用系统浏览器或旧守护进程。`;
        }
      }
      if (!options.workspaceCompanion) return;
      companion = await startConfiguredApplication({ workspaceRoot, codeRoot, webRoot, role: 'service',
        launcherFile: options.launcherFile,
        ...(localDataLifecycle ? { sharedLocalData: localDataLifecycle } : {}),
        sharedBrowser: browserHost?.configuration, sharedBrowserUnavailableReason: browserUnavailableReason,
        listen: false, serviceStateRoot: resolve(resources.path('state'), 'workspace'), serviceFilesRoot: resolve(resources.path('task_files'), 'workspace'),
        materials: { environment: 'local-review' },
      });

    },
    beforeShutdown: async () => {
      // 先收束个人任务，再关闭配套工作台、采集与浏览器资源。
      await settleOwnedResources([
        () => companion || browserCleanup || captureSessions ? services?.tasks.dispose() : undefined,
        () => companion || browserCleanup || captureSessions ? running?.core.dispose() : undefined,
        () => companion?.running.shutdown(),
        () => captureSessions?.close(),
        () => !service ? browserCleanup?.() : undefined,
        () => !service ? localDataLifecycle?.close() : undefined,
      ]);
    },
    initializeServices: (core, database) => (services = createApplicationServices(core, database, {
      projectRoot: workspaceRoot, codeRoot, resources, processRuntime,
      privateRoot: service ? options.serviceFilesRoot ?? resolve(resources.path('task_files'), 'service') : resolve(resources.path('task_files'), mode === 'demo' ? 'demo' : 'personal'),
      role: options.role,
      ...(lifecycle ? { localData: { lifecycle, dataId: localDataId } } : {}),
      localDataControlPath: controlDatabasePath,
      ...(service ? { controlStateRoot: serviceStateRoot } : {}),
      ...(service ? { serviceVersions: { bd: workspace ? WORKSPACE_BD_VERSION : options.configureCollection ? COLLECTION_BD_VERSION : BD_VERSION, model: `${health.provider}/${health.model}`,
        modelConfiguration: modelConfigurationVersion,
        budget: `requests=${modelRequests};output=1024;timeout_ms=60000` } } : {}),
      health, credentialReference: configuration.credentialReference,
      modelConfigurationVersion,
      ...(configuration.pi.customModel ? { modelConnection: { endpoint: configuration.pi.customModel.baseUrl, protocol: configuration.pi.customModel.api } } : {}),
      modelInput: configuration.pi.customModel?.input,
      configureCollection: options.configureCollection,
      materials: options.materials,
      ...(service && workspace ? { configureAlgorithms: localAlgorithmConfiguration(codeRoot, processRuntime) } : {}),
      workspaceServices: companion?.running && 'services' in companion.running ? companion.running.services : undefined,
      browser: browserHost?.configuration ?? options.sharedBrowser, browserUnavailableReason,
      captureSessions, captureUnavailableReason, customSources,
      ...(baiduDrive ? { baiduDrive } : {}),
      ...tools,
    })),
  }); } catch (error) {
    try { await settleOwnedResources([() => companion?.running.shutdown(), () => captureSessions?.close(), () => !service ? browserCleanup?.() : undefined, () => !service ? localDataLifecycle?.close() : undefined]); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '启动失败且自有资源清理未全部确认。'); }
    throw error;
  }
  if (!service) {
    const owner = running as Awaited<ReturnType<typeof startLocalServer>>;
    try {
      if (owner.database?.path && owner.database.path !== ':memory:') lifecycle.bindIdentity(localDataId, owner.database.path);
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

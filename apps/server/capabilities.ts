import { inspectPath, samePathIdentity } from '../../platform/security/permissions.js';
import { DirectPathProtection } from '../../platform/security/path-protection.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { DirectRuntimeOptions, DirectRuntimeBundle } from '../../contracts/direct-runtime.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { createLocalActions, trustedBundledDependencyRoot } from '../../platform/capabilities/local-actions.js';
import { createBaiduDriveActions } from '../../plugins/capture-sources/baidu-drive/index.js';
import { createCustomSourceActions, type CustomSourceRegistry } from '../../plugins/capture-sources/custom-register.js';
import { createBrowserActions } from '../../platform/capabilities/browser/index.js';
import { createConversionActions } from '../../platform/capabilities/conversion/index.js';
import { createCaptureSourcePlugin, isCapturePrivateProducerPath } from '../../plugins/capture-sources/index.js';
import { validateCaptureSourceArgs } from '../../plugins/capture-sources/index.js';
import { createSourceRuntime } from '../../plugins/api-sources/runtime.js';
import { directDependencyVersions, directFileVersion, directResourceVersions, directoryVersion, guardDirectContext, type DirectImplementation } from '../../platform/plugins/direct-versions.js';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

/** 应用装配各能力；注册、参数校验、权限与任务仍共用现有入口。 */
export function createDirectRuntime(options: DirectRuntimeOptions): DirectRuntimeBundle {
  const local = createLocalActions(options, ['assembly']), artifactIdentity = inspectPath(options.artifactRoot);
  const trustedRootFor = trustedBundledDependencyRoot(options, () => local.configuration().whisperModelPath ?? undefined);
  const protection = new DirectPathProtection(options.protectedPaths ?? [], artifactIdentity.canonicalPath, {
    isRegisteredExecutable: path => options.processRuntime?.isRegisteredExecutable(path) ?? false,
    credentialPaths: () => options.sourceSettings?.credentialPaths() ?? [],
  });
  const baidu = options.baiduDrive ? createBaiduDriveActions({ files: options.files, artifactRoot: artifactIdentity.canonicalPath,
    configuration: options.baiduDrive, processRuntime: options.processRuntime, assertPath: path => protection.assertPath(path) }) : undefined;
  const browser = createBrowserActions({ configuration: options.browser, unavailableReason: options.browserUnavailableReason, files: options.files, artifactRoot: artifactIdentity.canonicalPath });
  const conversion = createConversionActions({ files: options.files, artifactRoot: artifactIdentity.canonicalPath,
    processRuntime: options.processRuntime, assertPath: path => protection.assertPath(path),
    managedSource: (fileRefId, action) => ['conversion.document', 'pdf.extract'].includes(action)
      ? options.managedConversionSource?.(fileRefId) ?? null : null });
  const capture = options.capturePrivateArtifactRoot ? createCaptureSourcePlugin({ files: options.files,
    artifactRoot: artifactIdentity.canonicalPath, privateArtifactRoot: options.capturePrivateArtifactRoot,
    sessions: options.captureSessions ? {
      availability: sourceId => { try { options.sourceSettings?.assertCaptureEnabled(sourceId); return options.captureSessions!.availability?.(sourceId) ?? { available: true }; }
        catch { return { available: false, reason: '本站采集插件已在共享来源设置中停用。' }; } },
      dependencyVersion: sourceId => ({ session: options.captureSessions!.dependencyVersion?.(sourceId) ?? null, setting: options.sourceSettings?.captureVersion(sourceId) ?? null }),
      markExpired: sourceId => options.captureSessions!.markExpired?.(sourceId) ?? Promise.resolve(),
      withCaptureSession: (sourceId, context, operation) => { options.sourceSettings?.assertCaptureEnabled(sourceId);
        return options.captureSessions!.withCaptureSession(sourceId, context, (configuration, assertCurrent) => operation(configuration, () => { options.sourceSettings?.assertCaptureEnabled(sourceId); assertCurrent(); })); },
    } : undefined, unavailableReason: options.captureUnavailableReason }) : undefined;
  const sources = options.sourceSettings ? createSourceRuntime({ settings: options.sourceSettings, files: options.files, artifactRoot: artifactIdentity.canonicalPath, processRuntime: options.processRuntime, tdxaidataPackage: options.tdxaidataPackage }) : undefined;
  const custom = options.customSources ? createCustomSourceActions(options.customSources) : undefined;
  const captureRootIdentity = options.capturePrivateArtifactRoot ? inspectPath(options.capturePrivateArtifactRoot) : undefined;
  for (const registration of [...(sources?.registrations ?? []), ...(capture?.registrations ?? []), ...(baidu?.registrations ?? []), ...(custom?.registrations ?? []), ...browser.registrations, ...conversion.registrations,
    ...(options.conversationMaterials?.registrations ?? []), ...(options.artifactArchive ? [options.artifactArchive.registration] : []),
    ...(options.artifactRestore ? [options.artifactRestore.registration] : []),
    ...(options.artifactLifecycle?.registrations ?? []),
    ...(options.candidateReclaim?.registrations ?? []),
    ...(options.artifactManifest ? [options.artifactManifest.registration] : [])]) local.registry.register(registration);
  for (const registration of [...(sources?.registrations ?? []), ...(capture?.registrations ?? []), ...(baidu?.registrations ?? []), ...(custom?.registrations ?? []), ...browser.registrations, ...conversion.registrations,
    ...(options.conversationMaterials?.registrations ?? []), ...(options.artifactArchive ? [options.artifactArchive.registration] : []),
    ...(options.artifactRestore ? [options.artifactRestore.registration] : []),
    ...(options.artifactLifecycle?.registrations ?? []),
    ...(options.candidateReclaim?.registrations ?? []),
    ...(options.artifactManifest ? [options.artifactManifest.registration] : [])]) local.registry.bindVersions(registration.action, args => {
    const action = registration.action, implementation: DirectImplementation[] = ['assembly'];
    let configuration: unknown = {}, dependencies: unknown = directResourceVersions(options);
    if (options.artifactManifest && action === options.artifactManifest.registration.action) {
      configuration = options.artifactManifest.versionBinding();
      dependencies = directResourceVersions(options);
    } else if (options.candidateReclaim?.handles(action)) {
      implementation.push('process'); configuration = options.candidateReclaim.versionBinding();
      dependencies = directResourceVersions(options);
    } else if (options.artifactLifecycle?.handles(action)) {
      implementation.push('baidu', 'process'); configuration = options.artifactLifecycle.versionBinding();
      dependencies = directResourceVersions(options, options.baiduDrive ? ['bdpan'] : [], options.baiduDrive
        ? [options.baiduDrive.configPath, ...(options.baiduDrive.tokenKeyPath ? [options.baiduDrive.tokenKeyPath] : [])] : []);
    } else if (options.artifactRestore && action === options.artifactRestore.registration.action) {
      implementation.push('baidu', 'process'); configuration = options.artifactRestore.versionBinding();
      dependencies = directResourceVersions(options, options.baiduDrive ? ['bdpan'] : [], options.baiduDrive
        ? [options.baiduDrive.configPath, ...(options.baiduDrive.tokenKeyPath ? [options.baiduDrive.tokenKeyPath] : [])] : []);
    } else if (options.artifactArchive && action === options.artifactArchive.registration.action) {
      implementation.push('baidu', 'process'); configuration = options.artifactArchive.versionBinding();
      dependencies = directResourceVersions(options, options.baiduDrive ? ['bdpan'] : [], options.baiduDrive
        ? [options.baiduDrive.configPath, ...(options.baiduDrive.tokenKeyPath ? [options.baiduDrive.tokenKeyPath] : [])] : []);
    } else if (sources?.handles(action)) {
      implementation.push('source', 'web'); configuration = sources.configuration(action, args);
      if (action === 'source.wechat.extract') {
        implementation.push('process');
        const scriptPath = options.sourceSettings!.get().wechatExtract.scriptPath;
        dependencies = directResourceVersions(options, ['python3'], scriptPath ? [scriptPath] : []);
      }
      if (action === 'source.fetch' && args.sourceId === 'tdx') {
        implementation.push('tdx', 'process'); dependencies = directResourceVersions(options, ['python3', 'security'], options.tdxaidataPackage ? [options.tdxaidataPackage.path] : [], ['temp']);
      }
      if (action === 'source.api.read') { implementation.push('process'); dependencies = directResourceVersions(options, ['security']); }
    } else if (capture?.handles(action)) {
      const { rule } = validateCaptureSourceArgs(action, args), script = directFileVersion(fileURLToPath(new URL(`../../plugins/capture-sources/${rule.path}`, import.meta.url)));
      if (script.sha256 !== rule.sha256 || !options.captureSessions?.dependencyVersion) throw new DirectError('DIRECT_VERSION_UNAVAILABLE', '本站脚本或会话缺少可核对的受信依赖版本。');
      implementation.push('capture', 'browser', 'web', 'process');
      options.sourceSettings?.assertCaptureEnabled(rule.sourceId);
      configuration = { rule, session: options.captureSessions.dependencyVersion(rule.sourceId), setting: options.sourceSettings?.captureVersion(rule.sourceId) ?? null };
      dependencies = { runtime: directResourceVersions(options, ['node', 'browser_engine'], [], ['browser_home']),
        privateRoot: directoryVersion(options.capturePrivateArtifactRoot!), script };
    } else if (custom?.handles(action)) {
      implementation.push('local', 'assembly'); configuration = { path: options.customSources!.path };
    } else if (baidu?.handles(action)) {
      implementation.push('baidu', 'process'); configuration = options.baiduDrive!;
      dependencies = directResourceVersions(options, ['bdpan'], [options.baiduDrive!.configPath, ...(options.baiduDrive!.tokenKeyPath ? [options.baiduDrive!.tokenKeyPath] : [])], options.baiduDrive!.homePath ? ['baidu_home'] : []);
    } else if (browser.handles(action)) {
      implementation.push('browser', 'web'); configuration = { daemonConfigPath: options.browser?.daemonConfigPath ?? null, operation: args.operation };
      dependencies = directResourceVersions(options, [], options.browser ? [options.browser.daemonConfigPath] : []);
    } else if (conversion.handles(action)) {
      implementation.push('conversion');
      if (['conversion.document', 'pdf.extract'].includes(action)) configuration = { material: options.managedConversionSource?.(String(args.fileRefId)) ?? null };
      if (['conversion.document', 'conversion.structured', 'conversion.archive'].includes(action)) implementation.push('office');
      if (action === 'conversion.document') implementation.push('html');
      if (['conversion.document', 'conversion.archive', 'conversion.pdf_render', 'pdf.extract'].includes(action)) implementation.push('pdf');
      if (['conversion.image', 'conversion.media', 'conversion.subtitle', 'conversion.pdf_render'].includes(action)) implementation.push('media');
      if (action === 'conversion.media') { implementation.push('local', 'bundledTrust', 'process'); dependencies = directResourceVersions(options, ['ffmpeg', 'ffprobe']); }
    } else {
      implementation.push('material', 'materialRead'); configuration = options.conversationMaterialVersions?.(action) ?? null;
      if (['material.read', 'material.process'].includes(action)) implementation.push('materialProcess');
      if (action === 'material.transcribe') {
        implementation.push('materialTranscription'); configuration = { material: configuration, transcription: local.localTranscription.captureVersions(action) };
      }
    }
    return directDependencyVersions(action, implementation, configuration, dependencies);
  });
  return { ...local, sourceChecks: sources, runtime: { id: local.runtime.id, async execute(original) {
    original = guardDirectContext(local.registry, original);
    const routed = local.router.route({ action: original.task.action, args: original.task.args });
    if (original.task.runtimeId !== 'direct') throw new DirectError('RUNTIME_MISMATCH', '任务不属于确定性运行时。');
    original.signal.throwIfAborted();
    if (!samePathIdentity(artifactIdentity, inspectPath(options.artifactRoot))) throw new DirectError('ARTIFACT_ROOT_CHANGED', '产物目录身份已经变化。');
    // 只有受信站点插件能在本任务私有证据子目录生成原件；通用文件/转换仍受完整保护。
    const assertCapabilities = (operation: Parameters<TaskExecutionContext['assertAuthorized']>[0], capabilities: Parameters<TaskExecutionContext['assertAuthorized']>[1]) => {
      for (const capability of capabilities) {
        const tdxAction = routed.action === 'source.fetch' && (routed.args as Record<string, JsonValue>).sourceId === 'tdx'
          && operation.operationId === 'source.tdx.minutes' && options.processRuntime;
        const tdxFile = tdxAction && capability.target.kind === 'file' && (capability.action === 'read' && options.tdxaidataPackage?.path === capability.target.path
          || capability.action === 'execute' && options.processRuntime!.path('python3') === capability.target.path);
        const tdxTemporary = tdxAction && capability.target.kind === 'directory' && ['read', 'write', 'delete'].includes(capability.action)
          && options.resources?.document.resources.temp && relative(options.resources.path('temp'), capability.target.path).startsWith(`tdxaidata-${original.task.id}-`)
          && !relative(options.resources.path('temp'), capability.target.path).includes('/') && !relative(options.resources.path('temp'), capability.target.path).includes('\\')
          && !inspectPath(capability.target.path).links.length;
        const producer = capture?.handles(routed.action) && original.task.action === routed.action
          && ['capture.private-task-directory', 'capture.stage', `${routed.action}.publish`].includes(operation.operationId)
          && ['read', 'write', 'delete'].includes(capability.action)
          && (capability.target.kind === 'file' || capability.target.kind === 'directory')
          && options.capturePrivateArtifactRoot && captureRootIdentity
          && samePathIdentity(captureRootIdentity, inspectPath(options.capturePrivateArtifactRoot))
          && isCapturePrivateProducerPath(options.capturePrivateArtifactRoot, original.task.id, capability.target.path);
        const customSource = routed.action === 'source.register' && original.task.action === 'source.register'
          && operation.operationId === 'source.register.write' && options.customSources
          && capability.action === 'write' && capability.target.kind === 'file' && capability.target.path === options.customSources.path;
        const managed = ['conversion.document', 'pdf.extract'].includes(routed.action)
          ? options.managedConversionSource?.(String((routed.args as Record<string, JsonValue>).fileRefId)) : null;
        const managedRead = managed && capability.action === 'read' && capability.target.kind === 'file' && capability.target.path === managed.path;
        if (!producer && !tdxFile && !tdxTemporary && !customSource && !managedRead) {
          protection.assertCapabilities([capability], requested => trustedRootFor(original.task.action, requested));
        }
      }
    };
    const context: TaskExecutionContext = { ...original,
      assertAuthorized: (operation, capabilities, input) => { assertCapabilities(operation, capabilities); return original.assertAuthorized(operation, capabilities, input); },
      requestApproval: async (operation, capabilities, input) => { assertCapabilities(operation, capabilities); return await original.requestApproval(operation, capabilities, input); } };
    const args = routed.args as Record<string, JsonValue>;
    const execute = async (): Promise<TaskResult> => {
      if (options.artifactManifest && routed.action === options.artifactManifest.registration.action) return await options.artifactManifest.execute(context, args);
      if (options.candidateReclaim?.handles(routed.action)) return await options.candidateReclaim.execute(context, routed.action, args);
      if (options.artifactLifecycle?.handles(routed.action)) return await options.artifactLifecycle.execute(context, routed.action, args);
      if (options.artifactRestore && routed.action === options.artifactRestore.registration.action) return await options.artifactRestore.execute(context, args);
      if (options.artifactArchive && routed.action === options.artifactArchive.registration.action) return await options.artifactArchive.execute(context, args);
      if (sources?.handles(routed.action)) return await sources.execute(context, routed.action, args);
      if (options.conversationMaterials?.handles(routed.action)) return await options.conversationMaterials.execute(context, routed.action, args);
      if (capture?.handles(routed.action)) return await capture.execute(context, routed.action, args);
      if (custom?.handles(routed.action)) return await custom.execute(context, routed.action, args);
      if (baidu?.handles(routed.action)) return await baidu.execute(context, args);
      if (conversion.handles(routed.action)) return await conversion.execute(context, routed.action, args);
      if (browser.handles(routed.action)) return await browser.execute(context, args);
      return await local.runtime.execute(context);
    };
    const startedAt = Date.now();
    let result: TaskResult | undefined, actionError: unknown;
    try { result = await execute(); } catch (error) { actionError = error; }
    // A04 工具时间：按本次实际执行累计；超限错误优先于“成功但超限”的静默通过。
    const toolMs = Math.max(0, Date.now() - startedAt);
    try { if (toolMs > 0) original.consumeBudget({ toolMs }); } catch (error) { actionError ??= error; }
    if (actionError) throw actionError;
    return result!;
  }, async recover(context) {
    local.registry.assertTaskVersions(context.task);
    throw new DirectError('RECOVERY_NOT_SUPPORTED', '此直接动作没有原身份查询适配器；未知结果继续保留，不能换请求或重发副作用。');
  } } };
}

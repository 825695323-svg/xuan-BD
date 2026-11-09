import type { ProcessRuntime } from '../runtime/programs.js';
import type { DirectRuntimeOptions, DirectRuntimeBundle, ShortcutDefinition } from '../../contracts/direct-runtime.js';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { root } from '@openclaw/fs-safe';
import { extractArchive, resolveArchiveKind } from '@openclaw/fs-safe/archive';
import { SkillRegistry, type SkillRegistration } from '../plugins/registry.js';
import { FileReferenceError, type FileReference, type FileReferenceService } from '../resources/files.js';
import { inspectPath, normalizePermissionPath, samePathIdentity, type PermissionCapability } from '../security/permissions.js';
import type { TaskExecutionContext, TaskRuntime } from '../jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillAvailability, SkillField } from '../../contracts/skill-contracts.js';
import { acquireAuthority, assertDestinationCurrent, commonAncestor, DirectError, DirectWorkspace, directoryCapability, fileCapability, prepareDestination, type DirectAuthority } from '../runtime/file-workspace.js';
import { DirectRouter } from '../plugins/router.js';
import { DirectProcessError, runDirectProcess, type DirectBinary, type DirectProcessResult } from '../runtime/process.js';
import { DirectPathProtection } from '../security/path-protection.js';
import { readPublicWeb, validatePublicWebUrl, type PublicWebOptions } from './browser/public-web.js';
import { searchPublicWeb, validateSearchArgs } from './browser/search.js';
import { transcribeVideo, validateVideoUrl } from './transcription/video.js';
import { compareRegisteredFiles } from './files/compare.js';
import { createTextFile, editTextFile, readTextPage, searchTextFiles } from './files/text.js';
import { transcriptionSegmentPreview, transcribeLocalFile, type LocalTranscriptionInput, type LocalTranscriptionResult } from './transcription/local.js';
import { directDependencyVersions, directFileVersion, directResourceVersions, guardDirectContext, type DirectImplementation } from '../plugins/direct-versions.js';
import { BundledResources } from '../resources/bundled.js';

type Arguments = Record<string, JsonValue>;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const INPUT_DEMUXERS: Record<string, string> = { '.wav': 'wav', '.mp3': 'mp3', '.flac': 'flac', '.aac': 'aac', '.ogg': 'ogg', '.opus': 'ogg',
  '.m4a': 'mov', '.mp4': 'mov', '.mov': 'mov', '.mkv': 'matroska', '.webm': 'matroska', '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe' };
const CONVERT_FORMATS = [ { value: 'wav', label: 'WAV 音频（16kHz 单声道）' }, { value: 'mp3', label: 'MP3 音频' }, { value: 'mp4', label: 'MP4 视频' },
  { value: 'png', label: 'PNG 图片（媒体首帧）' }, { value: 'jpg', label: 'JPEG 图片（媒体首帧）' } ];

/** 只给受信视频、转录与媒体转换实现所需的固定随包依赖返回可豁免的包根；不授予任务权限。 */
export function trustedBundledDependencyRoot(options: Pick<DirectRuntimeOptions, 'resources' | 'processRuntime'>,
  modelPath: () => string | undefined): (taskAction: string, capability: PermissionCapability) => string | undefined {
  const resources = options.resources, runtime = options.processRuntime;
  const unavailable = () => undefined;
  if (!resources || !runtime || !resources.document.resources.bundle_manifest) return unavailable;
  let bundle: BundledResources, codeRoot: string, selected: ReturnType<BundledResources['selectedBindings']>;
  try {
    codeRoot = resolve(dirname(resources.path('bundle_manifest')), '../..');
    bundle = new BundledResources(codeRoot);
    selected = bundle.selectedBindings();
    if (resources.path('bundle_manifest') !== bundle.manifestPath
      || ['bundle_manifest', 'yt_dlp', 'ffmpeg', 'ffprobe', 'whisper_cli', 'whisper_base'].some(key => {
        const actual = resources.document.resources[key], expected = selected[key];
        return !actual || !expected || actual.kind !== expected.kind || resources.path(key) !== expected.path
          || actual.sha256 !== expected.sha256 || (key === 'bundle_manifest' && actual.identity !== expected.identity);
      })) return unavailable;
  } catch { return unavailable; }
  const programs = { yt_dlp: 'yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', whisper_cli: 'whisper-cli' } as const;
  return (taskAction, capability) => {
    const mediaConversion = taskAction === 'media.convert' || taskAction === 'conversion.media';
    if (!['video.transcribe_url', 'audio.transcribe', 'material.transcribe'].includes(taskAction) && !mediaConversion
      || capability.target.kind !== 'file') return undefined;
    try {
      const path = capability.target.path;
      const key = (Object.keys(programs) as (keyof typeof programs)[]).find(name => resources.path(name) === path);
      const approvedProgram = key && capability.action === 'execute'
        && (mediaConversion ? key === 'ffmpeg' || key === 'ffprobe' : taskAction === 'video.transcribe_url' || key !== 'yt_dlp');
      const approvedModel = !mediaConversion && capability.action === 'read' && path === modelPath()
        && path === resources.path('whisper_base');
      if (!approvedProgram && !approvedModel) return undefined;
      const bindingKey = approvedProgram ? key! : 'whisper_base';
      const binding = resources.document.resources[bindingKey]!, expected = selected[bindingKey]!;
      const manifestBinding = resources.document.resources.bundle_manifest!, expectedManifest = selected.bundle_manifest!;
      const info = lstatSync(path);
      if (binding.kind !== expected.kind || resources.path(bindingKey) !== expected.path || binding.sha256 !== expected.sha256
        || manifestBinding.kind !== expectedManifest.kind || resources.path('bundle_manifest') !== expectedManifest.path
        || manifestBinding.sha256 !== expectedManifest.sha256 || manifestBinding.identity !== expectedManifest.identity
        || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || directFileVersion(bundle.manifestPath).sha256 !== bundle.manifestSha256
        || directFileVersion(path).sha256 !== binding.sha256) return undefined;
      if (approvedProgram && (!runtime.isRegisteredExecutable(path) || runtime.path(programs[key!]) !== path)) return undefined;
      return codeRoot;
    } catch { return undefined; }
  };
}

/** 静态动作表、严格菜单路由与 TaskRuntime 共用同一描述；工厂不运行程序或创建目录。 */
export function createLocalActions(options: DirectRuntimeOptions, hostImplementation: readonly DirectImplementation[] = []): DirectRuntimeBundle {
  const requireBinary = (name: DirectBinary) => { try { return options.processRuntime!.path(name); } catch { throw new DirectError('TOOL_UNAVAILABLE', `登记程序 ${name} 缺失或身份已变化。`); } };
  const runStagedTool = stagedToolRunner(options.processRuntime);
  const binaryPaths = () => Object.fromEntries((['open','mdfind','shortcuts','ffmpeg','ffprobe','whisper-cli','yt-dlp'] as DirectBinary[]).flatMap(name => { try { return [[name, requireBinary(name)]]; } catch { return []; } })) as Partial<Record<DirectBinary, string>>;
  const assertBinaryCurrent = (name: DirectBinary, expected: string) => { if (requireBinary(name) !== expected) throw new DirectError('TOOL_CHANGED', '工具绑定已变化。'); };
  const artifactIdentity = inspectPath(options.artifactRoot);
  if (artifactIdentity.object?.kind !== 'directory') throw new DirectError('ARTIFACT_ROOT_MISSING', '应用产物目录尚未初始化。');
  const artifactRoot = artifactIdentity.canonicalPath;
  const protection = new DirectPathProtection(options.protectedPaths ?? [], artifactRoot, {
    isRegisteredExecutable: path => options.processRuntime?.isRegisteredExecutable(path) ?? false,
    credentialPaths: () => options.sourceSettings?.credentialPaths() ?? [],
  });
  let shortcuts = validateShortcuts(options.shortcuts ?? []);
  let configuredModelPath = options.whisperModelPath ? normalizePermissionPath(options.whisperModelPath) : undefined;
  const trustedRootFor = trustedBundledDependencyRoot(options, () => configuredModelPath);
  let videoMaxMinutes = options.videoMaxMinutes ?? 30, videoMaxBytes = options.videoMaxBytes ?? MAX_INPUT_BYTES;
  const toolFailures = new Map<DirectBinary, { identity: ReturnType<typeof inspectPath>; reason: string }>();
  const registry = new SkillRegistry([...registrations(() => ({ modelPath: configuredModelPath, shortcuts, transcriptionBinaryPaths: binaryPaths(), binaryPaths: binaryPaths(),
    imageOcr: options.agentImageOcrAvailability?.() ?? (options.agentImageOcr ? { available: true } : { available: false, reason: '图片识字需要当前内置代理绑定的图像模型；不会调用原生识字或其他模型。' }) }), toolFailures)]);
  const captureVersions = (action: string, args: Arguments = {}) => {
    const implementation: DirectImplementation[] = ['local', ...hostImplementation];
    const programs: DirectBinary[] = [];
    const files: string[] = [];
    let configuration: unknown = {};
    if (action === 'file.compare') implementation.push('compare');
    if (['file.read', 'file.glob', 'file.grep', 'file.write', 'file.edit'].includes(action)) implementation.push('fileTools');
    if (action === 'web.read_public' || action === 'web.search' || action === 'video.transcribe_url') implementation.push('web');
    if (action === 'web.search') implementation.push('search');
    if (['audio.transcribe', 'material.transcribe', 'video.transcribe_url'].includes(action)) {
      implementation.push('transcription'); programs.push('ffmpeg', 'ffprobe', 'whisper-cli');
      if (configuredModelPath) files.push(configuredModelPath);
      configuration = { whisperModelPath: configuredModelPath ?? null };
    }
    if (action === 'video.transcribe_url') {
      implementation.push('video'); programs.push('yt-dlp');
      configuration = { videoMaxMinutes, videoMaxBytes, whisperModelPath: configuredModelPath ?? null };
    }
    if (action === 'media.convert') { implementation.push('bundledTrust'); programs.push('ffmpeg', 'ffprobe'); }
    if (action === 'file.open') programs.push('open');
    if (action === 'spotlight.search') programs.push('mdfind');
    if (action === 'mac.shortcut') {
      programs.push('shortcuts'); configuration = shortcuts.find(shortcut => shortcut.id === args.shortcutId) ?? null;
    }
    if (action === 'image.ocr') {
      implementation.push('model', 'ocr');
      if (!options.agentImageOcrVersion) throw new DirectError('DIRECT_VERSION_UNAVAILABLE', '图片识字需要宿主提供当前实际模型与连接版本。');
      configuration = options.agentImageOcrVersion();
    }
    if (programs.length) implementation.push('process');
    return directDependencyVersions(action, implementation, configuration, directResourceVersions(options, programs, files));
  };
  for (const registration of registry.list()) registry.bindVersions(registration.action, args => captureVersions(registration.action, args));
  const router = new DirectRouter(registry);
  const protectedContext = (input: TaskExecutionContext): TaskExecutionContext => {
    const originalContext = guardDirectContext(registry, input);
    const taskAction = originalContext.task.action;
    return { ...originalContext,
    assertAuthorized: (operation, capabilities, authorizationOptions) => {
      protection.assertCapabilities(capabilities, capability => trustedRootFor(taskAction, capability));
      return originalContext.assertAuthorized(operation, capabilities, authorizationOptions);
    }, requestApproval: async (operation, capabilities, approvalOptions) => {
      protection.assertCapabilities(capabilities, capability => trustedRootFor(taskAction, capability));
      return await originalContext.requestApproval(operation, capabilities, approvalOptions);
    } };
  };
  const transcriptionBinary = requireBinary;
  const localTranscription: DirectRuntimeBundle['localTranscription'] = {
    availability: () => registry.get('audio.transcribe').availability,
    captureVersions: action => captureVersions(action),
    async execute(originalContext, input) {
      if (!['audio.transcribe', 'material.transcribe'].includes(originalContext.task.action)) throw new DirectError('RUNTIME_MISMATCH', '此受控适配器仅接受本任务的转录动作。');
      const available = localTranscription.availability(), modelPath = configuredModelPath;
      if (!available.available || !modelPath) throw new DirectError('WHISPER_MODEL_UNAVAILABLE', available.reason ?? '未配置有效的本机转录组件。');
      if (!samePathIdentity(inspectPath(artifactRoot), { ...artifactIdentity, invocationPath: artifactRoot, canonicalPath: artifactRoot, links: [] })) throw new DirectError('ARTIFACT_ROOT_CHANGED', '应用产物目录身份已经变化。');
      return await transcribeLocalFile(protectedContext(originalContext), input, { files: options.files, artifactRoot, modelPath,
        binary: transcriptionBinary, assertPath: path => protection.assertPath(path),
        assertModelPath: path => protection.assertPath(path, false,
          trustedRootFor(originalContext.task.action, fileCapability('read', path))), runTool: runStagedTool,
        convert: conversionArguments, validateModel: validateWhisperHeader, validateProbe: validateMediaProbe });
    },
  };
  const runtime: TaskRuntime = {
    id: 'direct',
    async execute(originalContext): Promise<TaskResult> {
      const modelPath = configuredModelPath, selectedShortcuts = shortcuts, maxMinutes = videoMaxMinutes, maxBytes = videoMaxBytes;
      const context = protectedContext(originalContext);
      const routed = router.route({ action: context.task.action, args: context.task.args });
      if (context.task.runtimeId !== 'direct') throw new DirectError('RUNTIME_MISMATCH', '任务不属于确定性运行时。');
      context.signal.throwIfAborted();
      if (!samePathIdentity(inspectPath(artifactRoot), { ...artifactIdentity, invocationPath: artifactRoot, canonicalPath: artifactRoot, links: [] })) {
        throw new DirectError('ARTIFACT_ROOT_CHANGED', '应用产物目录身份已经变化。');
      }
      const args = routed.args as Arguments;
      await context.emit({ type: 'progress', message: `开始${registry.get(routed.action).title}`, progress: 0 });
      if (routed.action === 'file.search') {
        const references = options.files.searchRefs(String(args.query), { limit: Number(args.limit ?? 100) }).filter((reference) => {
          try { protection.assertPath(reference.invocationPath); return true; } catch { return false; }
        });
        return result(`找到 ${references.length} 个已登记文件引用。`, { references: references.map(referenceData) });
      }
      if (routed.action === 'mac.shortcut') return await executeShortcut(context, args, selectedShortcuts, options.files, artifactRoot, protection, requireBinary, options.processRuntime);
      if (routed.action === 'web.read_public') return await readPublicWeb(context, { url: String(args.url) }, options.files, artifactRoot, options.publicWeb);
      if (routed.action === 'web.search') return await searchPublicWeb(context, { query: String(args.query), ...(args.limit === undefined ? {} : { limit: Number(args.limit) }) }, options.files, artifactRoot, options.publicWeb);
      if (routed.action === 'video.transcribe_url') return await transcribeVideo(context, String(args.url), { files: options.files, artifactRoot, modelPath, maxMinutes, maxBytes,
        runTool: runStagedTool, convert: conversionArguments, validateModel: validateWhisperHeader, validateProbe: validateMediaProbe,
        assertPath: path => protection.assertPath(path, false, trustedRootFor(context.task.action, fileCapability('read', path))),
        binary: transcriptionBinary });
      if (routed.action === 'audio.transcribe') {
        const extracted = await localTranscription.execute(context, { fileRefId: String(args.fileRefId), ...(args.destination === undefined ? {} : { destination: String(args.destination) }) });
        return result('本机音视频转录已完成；原件与时间段证据已保留。', {
          ...JSON.parse(JSON.stringify(extracted)), ...transcriptionSegmentPreview(extracted.segments), ...textPreview(extracted.text), fileRefId: extracted.textReference.fileRefId,
          sha256: extracted.textReference.sha256,
        }, [extracted.textReference.fileRefId, extracted.evidenceReference.fileRefId]);
      }
      if (routed.action === 'file.compare') return await compareRegisteredFiles(context, { leftFileRefId: String(args.leftFileRefId), rightFileRefId: String(args.rightFileRefId) }, options.files, artifactRoot);
      if (routed.action === 'file.glob' || routed.action === 'file.grep') return await searchTextFiles(context, routed.action, args, options.files, artifactRoot, path => protection.assertPath(path));
      if (routed.action === 'file.write') return await createTextFile(context, args, options.files, artifactRoot, path => protection.assertPath(path));
      const reference = options.files.getRef(String(args.fileRefId ?? args.directoryRefId));
      protection.assertPath(reference.invocationPath);
      if (args.destination !== undefined) protection.assertPath(String(args.destination));
      if (routed.action === 'file.edit') return await editTextFile(context, args, options.files);
      if (routed.action === 'file.read' && (args.offset !== undefined || args.limit !== undefined)) return await readTextPage(context, args, options.files);
      const readCapability = reference.kind === 'directory'
        ? { action: 'read' as const, target: { kind: 'directory' as const, path: reference.invocationPath, recursive: routed.action === 'spotlight.search' } }
        : fileCapability('read', reference.invocationPath);
      const binary = actionBinary(routed.action);
      const binaryPath = binary ? requireBinary(binary) : undefined;
      const capabilities: PermissionCapability[] = [readCapability, ...(binaryPath ? [fileCapability('execute', binaryPath)] : [])];
      if (routed.action === 'file.read') {
        const authority = await acquireAuthority(context, routed.action, routed.args, capabilities);
        authority.assert(); options.files.verify(reference.id);
        let text: string;
        try { text = await options.files.readText(reference.id, { operation: context.operationScope(authority.operation), approvalId: authority.approvalId,
          maxBytes: Number(args.maxBytes ?? 2_000_000) }); }
        catch (error) { if (error instanceof FileReferenceError) throw new DirectError(error.code, error.message); throw error; }
        authority.assert(); options.files.verify(reference.id);
        return result(`已读取“${reference.displayName}”。`, { ...textPreview(text), fileRefId: reference.id });
      }
      if (routed.action === 'file.open') {
        assertOpenable(reference);
        const authority = await acquireAuthority(context, routed.action, routed.args, capabilities);
        authority.assert(); options.files.verify(reference.id);
        const effectId = randomUUID();
        await context.emit({ type: 'side_effect_started', effectId, description: '向系统提交打开已选文件的请求', operation: { fileRefId: reference.id } });
        await runDirectProcess({ runtime: options.processRuntime!, binary: 'open', binaryPath, args: ['--', reference.canonicalPath], cwd: artifactRoot, signal: context.signal,
          onProcessState: (event) => context.emit({ type: 'process_state', ...event }), onHeartbeat: (event) => context.emit({ type: 'heartbeat', ...event }),
          assertAuthorized: () => { authority.assert(); options.files.verify(reference.id); assertOpenable(reference); assertBinaryCurrent('open', binaryPath!); }, timeoutMs: 30_000 });
        await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '系统打开工具已正常结束；这只确认打开请求已交付。' });
        return result(`已向系统提交打开“${reference.displayName}”的请求。`, { fileRefId: reference.id, verification: 'system-open-request-accepted' });
      }
      if (routed.action === 'spotlight.search') {
        if (reference.kind !== 'directory') throw new DirectError('NOT_A_DIRECTORY', '系统检索需要已选择的目录。');
        const authority = await acquireAuthority(context, routed.action, routed.args, capabilities);
        authority.assert(); options.files.verify(reference.id);
        const escaped = String(args.query).replace(/[\\"*?]/gu, (character) => `\\${character}`);
        const query = `kMDItemFSName == "*${escaped}*"cd`;
        const response = await runDirectProcess({ runtime: options.processRuntime!, binary: 'mdfind', binaryPath, args: ['-0', '-onlyin', reference.canonicalPath, query], cwd: artifactRoot,
          signal: context.signal, timeoutMs: 30_000,
          onProcessState: (event) => context.emit({ type: 'process_state', ...event }), onHeartbeat: (event) => context.emit({ type: 'heartbeat', ...event }), assertAuthorized: () => { authority.assert(); options.files.verify(reference.id); assertBinaryCurrent('mdfind', binaryPath!); } });
        authority.assert(); options.files.verify(reference.id);
        const limit = Number(args.limit ?? 100);
        const paths: string[] = [];
        for (const candidate of response.stdout.split('\0').filter(Boolean)) {
          if (paths.length >= limit) break;
          try {
            const observed = inspectPath(candidate);
            protection.assertPath(observed.invocationPath);
            const child = relative(reference.canonicalPath, observed.canonicalPath);
            if (child && child !== '..' && !child.startsWith('../') && !child.startsWith('/')) paths.push(observed.invocationPath);
          } catch { /* 索引可能滞后；缺失或越界路径不作为可用结果返回。 */ }
        }
        return result(`在“${reference.displayName}”内找到 ${paths.length} 个结果。`, { paths, directoryRefId: reference.id, indexedSearch: true });
      }
      if (routed.action === 'file.move') return await executeMove(context, args, reference, options.files);
      if (reference.kind !== 'file') throw new DirectError('NOT_A_FILE', '此动作需要普通文件。');
      const inputExtension = extname(reference.canonicalPath).toLowerCase();
      if (routed.action === 'media.convert' && !INPUT_DEMUXERS[inputExtension]) throw new DirectError('UNSUPPORTED_INPUT', '此媒体格式尚未支持；播放列表和外部引用格式不会被读取。');
      if (routed.action === 'image.ocr' && !['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(inputExtension)) throw new DirectError('UNSUPPORTED_INPUT', '当前模型图片识字接受 PNG、JPEG、GIF 和 WebP；其他格式需要另行明确转换。');
      const archiveKind = routed.action === 'archive.extract' ? resolveArchiveKind(reference.canonicalPath) : undefined;
      if (routed.action === 'archive.extract' && !archiveKind) throw new DirectError('UNSUPPORTED_ARCHIVE', '当前支持 ZIP、TAR、TAR.GZ、TAR.ZST 与 TAR.BZ2。');
      if (routed.action === 'media.convert') capabilities.push(fileCapability('execute', requireBinary('ffprobe')));
      capabilities.push(directoryCapability('read', artifactRoot), directoryCapability('write', artifactRoot), directoryCapability('delete', artifactRoot));
      const authority = await acquireAuthority(context, routed.action, routed.args, capabilities);
      authority.assert(); options.files.verify(reference.id);
      const workspace = new DirectWorkspace(context, options.files, artifactRoot, authority);
      let failure: unknown;
      try {
        await workspace.create();
        const suffix = routed.action === 'archive.extract' ? archiveSuffix(reference.canonicalPath) : inputExtension;
        const inputPath = await workspace.copyReference(reference, `input${suffix}`, MAX_INPUT_BYTES);
        if (routed.action === 'media.convert') {
          const demuxer = INPUT_DEMUXERS[inputExtension]!;
          const probe = await runStagedTool(context, workspace, authority, 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', demuxer, '-f', demuxer,
            ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', inputPath], requireBinary('ffprobe'), 30_000);
          validateMediaProbe(probe.stdout);
        }
        let outputPath: string;
        let outputExtension = '.txt';
        let details: Record<string, JsonValue> = {};
        if (routed.action === 'file.copy') {
          outputPath = inputPath;
          outputExtension = inputExtension;
        } else if (routed.action === 'image.ocr') {
          if (!options.agentImageOcr) throw new DirectError('OCR_AGENT_REQUIRED', '图片识字需要当前内置代理任务及其绑定模型。');
          const ocr = await options.agentImageOcr(context, { fileRefId: reference.id,
            operation: context.operationScope(authority.operation), approvalId: authority.approvalId,
            assertAuthorized: () => { authority.assert(); options.files.verify(reference.id); } });
          authority.assert(); options.files.verify(reference.id);
          if (!ocr.text.trim()) throw new DirectError('EMPTY_OCR_TEXT', '没有识别到文字。');
          outputPath = await workspace.createText('output.txt', ocr.text);
          details = { ...textPreview(ocr.text), backend: 'bound-agent-api', model: ocr.model, imageSha256: ocr.imageSha256,
            usage: ocr.usage, modelCalls: 1 };
        } else if (routed.action === 'media.convert') {
          const format = String(args.format);
          outputExtension = `.${format}`;
          outputPath = join(workspace.path, `output${outputExtension}`);
          await runStagedTool(context, workspace, authority, 'ffmpeg', conversionArguments(inputPath, inputExtension, outputPath, format), binaryPath!);
          details = { format, ...(format === 'png' || format === 'jpg' ? { firstFrameOnly: true } : {}) };
        } else if (routed.action === 'archive.extract') {
          outputPath = await workspace.createDirectory('extracted');
          const effectId = randomUUID();
          await context.emit({ type: 'side_effect_started', effectId, description: '在本次暂存目录内安全解压' });
          workspace.assertCurrent();
          try {
            // fs-safe 的公开接口没有外部 signal；等待预算内已启动解压收束后再处理取消。
            await extractArchive({ archivePath: inputPath, destDir: outputPath, kind: archiveKind!, tarGzip: /\.(tgz|tar\.gz)$/iu.test(inputPath), timeoutMs: 60_000,
              durable: true, entryModes: 'clamp', entryUmask: 0o077, limits: { maxArchiveBytes: MAX_INPUT_BYTES, maxEntries: 10_000,
                maxExtractedBytes: MAX_OUTPUT_BYTES, maxEntryBytes: MAX_INPUT_BYTES, maxMetaEntryBytes: 1_000_000, maxEntryPathComponents: 64 },
              entryFilter: () => { workspace.assertCurrent(); return 'extract'; } });
          } catch (error) {
            await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '解压调用已经收束；产物仍限于暂存目录，尚未发布用户目标。' });
            throw error;
          }
          await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '安全解压已收束，条目及字节预算已执行；用户目标尚未发布。' });
          workspace.assertCurrent();
          const outputOwner = await root(outputPath, { symlinks: 'reject', hardlinks: 'reject' });
          let fileCount = 0;
          let bytes = 0;
          for await (const entry of outputOwner.walk('.', { symlinkPolicy: 'include', maxEntries: 10_000, maxDepth: 64, limitBehavior: 'throw', signal: context.signal })) {
            workspace.assertCurrent();
            if (entry.kind === 'symlink' || entry.kind === 'other') throw new DirectError('ARCHIVE_UNSAFE_OUTPUT', '解压产物包含不允许的链接或特殊文件。');
            if (entry.kind === 'file') { fileCount += 1; bytes += entry.size; }
          }
          if (bytes > MAX_OUTPUT_BYTES) throw new DirectError('ARCHIVE_OUTPUT_LIMIT', '解压产物超过字节上限。');
          const destination = prepareDestination(String(args.destination ?? join(artifactRoot, `archive-${randomUUID()}`)));
          const published = await workspace.publishDirectory(outputPath, destination, routed.action, routed.args);
          await workspace.cleanup();
          return result(`已解压 ${fileCount} 个文件。`, { fileRefId: published.id, fileCount, bytes }, [published.id]);
        } else throw new DirectError('UNKNOWN_ACTION', '没有此确定性动作。');
        const fingerprint = await workspace.fingerprint(outputPath, MAX_OUTPUT_BYTES);
        if (!fingerprint.bytes && routed.action !== 'file.copy') throw new DirectError('EMPTY_OUTPUT', '本机工具没有生成有效产物。');
        if (routed.action === 'media.convert' && fingerprint.bytes >= MAX_OUTPUT_BYTES) throw new DirectError('MEDIA_OUTPUT_LIMIT', '媒体产物达到大小上限，可能被工具截断，本次不会发布。');
        const destination = prepareDestination(String(args.destination ?? join(artifactRoot, `artifact-${randomUUID()}${outputExtension}`)));
        const published = await workspace.publishFile(outputPath, destination, routed.action, routed.args, MAX_OUTPUT_BYTES);
        await workspace.cleanup();
        await context.emit({ type: 'progress', message: '产物已完成并核对', progress: 1 });
        return result(`${registry.get(routed.action).title}已完成。`, { ...details, fileRefId: published.id, ...fingerprint }, [published.id]);
      } catch (error) {
        failure = error;
        if (error instanceof DirectProcessError && error.terminationSignal && ['SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(error.terminationSignal)) {
          const failedBinary = error.binary ?? binary;
          if (failedBinary) try {
            toolFailures.set(failedBinary, { identity: inspectPath(requireBinary(failedBinary)), reason: `${failedBinary} 已安装，但实际启动被系统信号 ${error.terminationSignal} 终止；请先修复本机工具。` });
          } catch { /* 工具已消失时可用性探测本身会返回明确缺失；不替换原失败。 */ }
        }
        if (!(error instanceof DirectError && error.unknown) && !(error instanceof DirectProcessError && error.disposition === 'unknown')) {
          try { await workspace.cleanup(); } catch (cleanupError) { failure = cleanupError; }
        }
        await workspace.recordRetained();
        throw failure;
      }
    },
  };
  const reportedRuntime: TaskRuntime = { id: runtime.id, async execute(context) {
    try { return await runtime.execute(context); }
    catch (error) { if (error instanceof FileReferenceError) throw new DirectError(error.code, error.message); throw error; }
  } };
  const prepareConfiguration: DirectRuntimeBundle['prepareConfiguration'] = (input) => {
    const nextShortcuts = validateShortcuts(input.shortcuts ?? []);
    const nextModelPath = input.whisperModelPath ? normalizePermissionPath(input.whisperModelPath) : undefined;
    const nextVideoMaxMinutes = input.videoMaxMinutes ?? videoMaxMinutes, nextVideoMaxBytes = input.videoMaxBytes ?? videoMaxBytes;
    if (!Number.isSafeInteger(nextVideoMaxMinutes) || nextVideoMaxMinutes < 1 || nextVideoMaxMinutes > 180
      || !Number.isSafeInteger(nextVideoMaxBytes) || nextVideoMaxBytes < 1024 * 1024 || nextVideoMaxBytes > 512 * 1024 * 1024) {
      throw new DirectError('INVALID_SETTINGS', '视频上限需要在 1–180 分钟、1–512 MB 内。');
    }
    const installProtection = input.shortcutConfigPath ? protection.prepareAdd(input.shortcutConfigPath) : undefined;
    return () => {
      installProtection?.();
      shortcuts = nextShortcuts; configuredModelPath = nextModelPath;
      videoMaxMinutes = nextVideoMaxMinutes; videoMaxBytes = nextVideoMaxBytes;
    };
  };
  return { runtime: reportedRuntime, registry, router, localTranscription,
    prepareConfiguration,
    configuration: () => ({ whisperModelPath: configuredModelPath ?? null, shortcuts, videoMaxMinutes, videoMaxBytes }),
    configure(input) { prepareConfiguration(input)(); }, assertPublicPath(path, allowMissing = false) {
    inspectPath(path, { allowMissing });
    protection.assertPath(path);
  } };
}

function registrations(settings: () => { modelPath: string | undefined; shortcuts: readonly ShortcutDefinition[]; transcriptionBinaryPaths?: Partial<Record<DirectBinary, string>>; binaryPaths?: Partial<Record<DirectBinary, string>>; imageOcr: SkillAvailability }, toolFailures: Map<DirectBinary, { identity: ReturnType<typeof inspectPath>; reason: string }>): SkillRegistration[] {
  const file: SkillField = { key: 'fileRefId', label: '文件', type: 'file', required: true };
  const destination: SkillField = { key: 'destination', label: '新目标完整路径（可选）', type: 'text', maxLength: 4096 };
  const limit: SkillField = { key: 'limit', label: '结果上限', type: 'number', minimum: 1, maximum: 200 };
  const make = (action: string, title: string, description: string, fields: SkillField[], permissionSummary: string[], binary?: DirectBinary): SkillRegistration => ({
    action, runtimeId: 'direct', kind: 'direct', modelCalls: 0, title, description, fields, permissionSummary,
    available: () => binary ? toolAvailability(binary, toolFailures, settings().binaryPaths?.[binary]) : { available: true },
    validate: (args) => { if (args.destination !== undefined) normalizePermissionPath(String(args.destination)); },
  });
  return [
    { ...make('video.transcribe_url', '提取公开视频文字', '支持单个 YouTube 或哔哩哔哩公开视频。先取字幕，没有字幕时用本机语音模型；登录、直播、分段流暂不处理。',
      [{ key: 'url', label: '视频 HTTPS 链接', type: 'text', required: true, maxLength: 4096 }], ['逐站批准视频网络访问', '执行固定视频提取工具', '无字幕时另行批准音轨转录', '写入应用文本产物']),
      validate: (args) => { validateVideoUrl(String(args.url)); }, available: () => toolAvailability('yt-dlp', toolFailures, settings().transcriptionBinaryPaths?.['yt-dlp']) },
    { ...make('web.read_public', '读取公开网页或 PDF 原件', '读取公开 HTTPS 网页文字；对完整 application/pdf（PDF 响应类型）仅保管 PDF（便携文档）原件与来源定位，返回 fileRefId（文件引用编号），可再用 conversion.document（文档转换）或 pdf.extract（PDF 文字提取）处理原件。材料内容不执行，PDF 尚未提取文字、确认语义或入库；登录页面和特殊端口尚不支持。',
      [{ key: 'url', label: '公开 HTTPS 网址', type: 'text', required: true, maxLength: 4096 }], ['逐跳核对公开网址的网络权限', '写入应用新文本或 PDF 原件产物', '读写及清理应用暂存']),
      validate: (args) => { validatePublicWebUrl(String(args.url)); } },
    { ...make('web.search', '联网搜索', '用公开必应搜索查询互联网，返回标题、链接和搜索摘要及来源记录。需要最新信息或还没有网址时使用；核实事实再用web.read_public读取选中的原网页。查询会发送给搜索服务，只提交必要关键词，不上传文件、凭据或私有正文；搜索摘要不代表网页全文。',
      [{ key: 'query', label: '搜索关键词', type: 'text', required: true, maxLength: 500 },
        { key: 'limit', label: '最多结果数', type: 'number', minimum: 1, maximum: 10 }],
      ['发送查询关键词并逐跳核对公开搜索服务的网络权限', '写入应用搜索原件与来源记录', '读写及清理应用暂存']),
      validate: (args) => { validateSearchArgs({ query: args.query, limit: args.limit }); } },
    make('file.read', '读取文本', '读取已登记 UTF-8 文本。指定 offset 或 limit 时按行分页：offset 从1开始，limit默认200行，每页最多32,000字节；返回原始字节sha256、引用version及nextOffset，沿nextOffset续读。超长单行明确拒绝，不静默跳过。不传分页参数时保留原有预览模式。', [file,
      { key: 'maxBytes', label: '整份文本读取上限（字节）', type: 'number', minimum: 1, maximum: 20_000_000 },
      { key: 'offset', label: '首行编号（从1开始）', type: 'number', minimum: 1, maximum: 20_000_001 },
      { key: 'limit', label: '本页最多行数', type: 'number', minimum: 1, maximum: 1000 }], ['读取所选文件']),
    make('file.glob', '按路径模式查找文件', '仅在directoryRefId对应的已登记目录内递归查找普通文件；pattern使用相对路径、正斜线与*、**等路径模式，单独文件名模式匹配所有层级；点开头路径须在模式中明确写出。不跟随链接，不读受保护路径。返回文件引用及相对路径；limit只限制预览，完整受限列表较大时另存产物，partial说明未完整扫描。',
      [{ key: 'directoryRefId', label: '已登记目录', type: 'directory', required: true },
        { key: 'pattern', label: '相对路径模式', type: 'text', required: true, maxLength: 512 },
        { key: 'limit', label: '预览最多条数', type: 'number', minimum: 1, maximum: 200 }], ['递归读取所选目录', '必要时写入应用检索结果产物']),
    make('file.grep', '检索目录内文本', '仅检索已登记目录内有效UTF-8普通文本，query是单行文字而非正则表达式；pattern可缩小相对路径范围，点开头路径须在模式中明确写出。默认区分大小写，caseSensitive=false时忽略大小写。返回匹配行、行号、文件引用与原字节sha256；limit只限制预览，大结果另存完整受限产物。单文件20MB、累计32MB、最多10000目录项；partial与skipped明确说明遗漏。',
      [{ key: 'directoryRefId', label: '已登记目录', type: 'directory', required: true },
        { key: 'query', label: '要查找的单行文字', type: 'text', required: true, maxLength: 4096 },
        { key: 'pattern', label: '相对路径模式（可选）', type: 'text', maxLength: 512 },
        { key: 'caseSensitive', label: '区分大小写', type: 'select', options: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] },
        { key: 'limit', label: '预览最多条数', type: 'number', minimum: 1, maximum: 200 }], ['递归读取所选目录中的文本', '必要时写入应用检索结果产物']),
    make('file.write', '新建文本文件', '在directoryRefId对应的已登记真实目录内，以name单独文件名新建UTF-8文本；content允许空串，最多2,000,000字节。已有同名对象一律拒绝，不覆盖、不创建父目录。经本任务授权、原子不覆盖发布及引用登记后返回新fileRefId、version、bytes和sha256。',
      [{ key: 'directoryRefId', label: '已登记目标目录', type: 'directory', required: true },
        { key: 'name', label: '新文件名（不含路径）', type: 'text', required: true, maxLength: 255 },
        { key: 'content', label: '完整文本内容', type: 'text', required: true, allowEmpty: true, maxLength: 2_000_000 }],
      ['读取所选目录身份', '写入新目标文件', '读写及清理应用暂存']),
    make('file.edit', '精确编辑文本文件', '先按行读取目标，取得原字节expectedSha256，再提交oldText和newText。默认oldText必须精确匹配且只有一处；replaceAll=true才替换全部。newText允许空串以删除原文。核原摘要、引用及权限后原子替换，再读回核新摘要；任何核验异常不报告成功。最多2,000,000字节，返回同一fileRefId的新version、sourceVersion和新旧摘要。',
      [file, { key: 'expectedSha256', label: '读取所得原字节SHA-256', type: 'text', required: true, maxLength: 64 },
        { key: 'oldText', label: '要替换的精确原文', type: 'text', required: true, allowEmpty: true, maxLength: 2_000_000 },
        { key: 'newText', label: '替换文字（空串表示删除）', type: 'text', required: true, allowEmpty: true, maxLength: 2_000_000 },
        { key: 'replaceAll', label: '明确替换全部匹配', type: 'select', options: [{ value: 'false', label: '否，必须唯一' }, { value: 'true', label: '是' }] }], ['读取并改写所选文本文件']),
    make('file.compare', '比较两份文本', '比较两个已登记的文本文件，展开查看差异并下载结果。每份文本最多 512 KiB、10000 行。',
      [{ key: 'leftFileRefId', label: '原文件', type: 'file', required: true }, { key: 'rightFileRefId', label: '对照文件', type: 'file', required: true }],
      ['分别读取两个所选文件', '写入应用新差异产物', '读写及清理应用暂存']),
    make('file.open', '打开文件', '使用系统默认应用打开所选文档、图片、媒体或目录。', [file], ['读取所选对象', '执行系统打开工具'], 'open'),
    make('file.copy', '复制文件', '将所选文件复制到一个新位置。目标已存在时会提示重新选名。', [file, { ...destination, required: true, label: '新目标完整路径' }], ['读取源文件', '写入新目标', '读写及清理应用暂存']),
    make('file.move', '移动文件', '将普通文件移动到同一磁盘中的新位置。', [file, { ...destination, required: true, label: '新目标完整路径' }], ['读取与删除源文件', '写入新目标']),
    make('file.search', '查找已登记文件', '查询已登记的文件。', [{ key: 'query', label: '关键词', type: 'text', required: true, maxLength: 1024 }, limit], ['查询已登记文件的信息']),
    make('spotlight.search', '在目录内查找', '在所选目录内按文件名查找。', [{ key: 'directoryRefId', label: '搜索目录', type: 'directory', required: true }, { key: 'query', label: '文件名关键词', type: 'text', required: true, maxLength: 512 }, limit], ['读取所选目录及其中的文件', '执行系统检索工具'], 'mdfind'),
    { ...make('image.ocr', '图片识字', '使用当前内置代理已绑定的图像模型识别所选图片，沿用本次模型预算。', [file, destination],
      ['读取所选图片', '批准向当前绑定模型分享图片', '使用当前模型通道及累计预算', '写入新文本产物', '读写及清理应用暂存']),
      modelCalls: 1, available: () => settings().imageOcr },
    { ...make('media.convert', '转换媒体', '转换为所选音频、视频或图片格式。图片取首帧，超限时会提示重新处理。', [file, { key: 'format', label: '目标格式', type: 'select', required: true, options: CONVERT_FORMATS }, destination], ['读取媒体', '执行本机媒体检查与转换工具', '写入新产物', '读写及清理应用暂存']),
      available: () => { const ffmpeg = toolAvailability('ffmpeg', toolFailures, settings().binaryPaths?.ffmpeg); return ffmpeg.available ? toolAvailability('ffprobe', toolFailures, settings().binaryPaths?.ffprobe) : ffmpeg; } },
    make('archive.extract', '解压文件', '将压缩包中的内容提取到一个新目录。', [file, destination], ['读取压缩包', '写入新目录', '读写及清理应用暂存']),
    { ...make('audio.transcribe', '转录音频', '在本机把语音转成文字。', [file, destination], ['读取音频与已选择的语音模型', '执行本机语音识别工具', '写入新文本产物', '读写及清理应用暂存']),
      available: () => { for (const binary of ['whisper-cli', 'ffmpeg', 'ffprobe'] as const) { const available = toolAvailability(binary, toolFailures, settings().transcriptionBinaryPaths?.[binary]); if (!available.available) return available; } return whisperAvailability(settings().modelPath); } },
    { ...make('mac.shortcut', '运行快捷指令', '运行你已明确选择的快捷指令。', [{ key: 'shortcutId', label: '快捷指令', type: 'select', required: true, options: settings().shortcuts.map((shortcut) => ({ value: shortcut.id, label: shortcut.name })) }], ['执行已选择的快捷指令', '逐项申请已声明的文件或网络影响']),
      fieldsForRequest: () => [{ key: 'shortcutId', label: '快捷指令', type: 'select', required: true, options: settings().shortcuts.map((shortcut) => ({ value: shortcut.id, label: shortcut.name })) }],
      available: () => settings().shortcuts.length ? toolAvailability('shortcuts', toolFailures, settings().binaryPaths?.shortcuts) : { available: false, reason: '尚未配置用户明确选择的快捷指令名单。' } },
  ];
}

function toolAvailability(binary: DirectBinary, failures: Map<DirectBinary, { identity: ReturnType<typeof inspectPath>; reason: string }>, configuredPath?: string): SkillAvailability {
  if ((binary === 'open' || binary === 'mdfind' || binary === 'shortcuts') && process.platform !== 'darwin') return { available: false, reason: '此动作需要 macOS。' };
  const path = configuredPath;
  if (!path) return { available: false, reason: `当前没有已登记可执行的 ${binary}。请核对资源绑定。` };
  try { if (inspectPath(path).object?.kind !== 'file') throw new Error('not file'); accessSync(path, constants.X_OK); }
  catch { return { available: false, reason: `宿主配置的 ${binary} 不可执行；不会安装或切换其他组件。` }; }
  const failure = failures.get(binary);
  if (failure) {
    if (samePathIdentity(failure.identity, inspectPath(path), true)) return { available: false, reason: failure.reason };
    failures.delete(binary);
  }
  return { available: true };
}
function whisperAvailability(modelPath?: string): SkillAvailability {
  if (!modelPath) return { available: false, reason: '尚未明确配置有效 Whisper 模型；仅有测试模型不能转录。' };
  if (/for-tests|test[-_]/iu.test(basename(modelPath))) return { available: false, reason: '所配置文件是测试模型，不能作为有效转录模型。' };
  try {
    const stat = lstatSync(modelPath);
    if (!stat.isFile() || stat.size < 10 * 1024 * 1024 || stat.size > 4 * 1024 * 1024 * 1024) return { available: false, reason: '所配置模型不是允许大小的普通模型文件（10 MiB 到 4 GiB）。' };
    accessSync(modelPath, constants.R_OK);
    // 可用性只检查元数据，不在获得 read 权限之前读取模型内容。
    return { available: true, reason: '已明确配置模型文件；获得读取批准后校验格式与实际权重。' };
  } catch { return { available: false, reason: '明确配置的 Whisper 模型不存在或无法读取。' }; }
}
function actionBinary(action: string): DirectBinary | undefined {
  const binaries: Record<string, DirectBinary> = { 'file.open': 'open', 'spotlight.search': 'mdfind', 'media.convert': 'ffmpeg', 'audio.transcribe': 'whisper-cli' };
  return binaries[action];
}

function result(summary: string, data: Record<string, JsonValue>, artifactIds?: string[]): TaskResult {
  return { summary, data: { ...data, modelCalls: data.modelCalls ?? 0 }, ...(artifactIds ? { artifactIds } : {}) };
}
function referenceData(reference: FileReference): Record<string, JsonValue> { return { id: reference.id, displayName: reference.displayName, path: reference.invocationPath, kind: reference.kind, status: reference.status }; }
function textPreview(text: string): Record<string, JsonValue> {
  let preview = text.slice(0, 32_000);
  while (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 80_000) preview = preview.slice(0, Math.floor(preview.length / 2));
  return { text: preview, truncated: preview.length < text.length, characterCount: text.length, bytes: Buffer.byteLength(text, 'utf8') };
}
function assertOpenable(reference: FileReference): void {
  const extension = extname(reference.canonicalPath).toLowerCase();
  if (['.app', '.workflow', '.shortcut'].includes(extension)) throw new DirectError('EXECUTABLE_OPEN_REFUSED', '应用或快捷指令不能作为普通文件打开；请使用明确的执行动作。');
  if (reference.kind === 'directory') return;
  const allowed = ['.txt', '.md', '.rtf', '.pdf', '.csv', '.json', '.yaml', '.yml', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.heic', '.wav', '.mp3', '.flac', '.aac', '.ogg', '.opus', '.m4a', '.mp4', '.mov', '.mkv', '.webm'];
  if (!allowed.includes(extension) || (lstatSync(reference.canonicalPath).mode & 0o111)) throw new DirectError('EXECUTABLE_OPEN_REFUSED', '普通打开只支持非执行型文档、图片和媒体；脚本、程序、网页及网址入口需要独立执行权限。');
}

/** whisper.cpp v1.9.1 模型头；完整权重仍由成熟加载器验证，不能只把 .bin 扩展名当模型。 */
export function validateWhisperHeader(header: Buffer): void {
  if (header.length !== 48 || header.readUInt32LE(0) !== 0x67676d6c) throw new DirectError('INVALID_WHISPER_MODEL', '所选文件不是支持的 GGML Whisper 模型。');
  const dimensions = Array.from({ length: 11 }, (_, index) => header.readInt32LE(4 + index * 4));
  const [vocab, audioContext, audioState, audioHead, audioLayer, textContext, textState, textHead, textLayer, mels, ftype] = dimensions;
  if (vocab! < 50_000 || vocab! > 60_000 || audioContext! < 1 || audioContext! > 3000 || audioState! < 1 || audioState! > 2048
    || audioHead! < 1 || audioHead! > 32 || audioLayer! < 1 || audioLayer! > 64 || textContext! < 1 || textContext! > 1024
    || textState !== audioState || textHead! < 1 || textHead! > 32 || textLayer! < 1 || textLayer! > 64
    || ![80, 128].includes(mels!) || ftype! < 0 || ftype! > 10_000) throw new DirectError('INVALID_WHISPER_MODEL', 'Whisper 模型参数无效或超出支持范围。');
}

export function conversionArguments(input: string, inputExtension: string, output: string, format: string): string[] {
  const demuxer = INPUT_DEMUXERS[inputExtension];
  if (!demuxer) throw new DirectError('UNSUPPORTED_INPUT', '媒体输入格式尚未支持。');
  const inputArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-protocol_whitelist', 'file', '-format_whitelist', demuxer, '-f', demuxer];
  if (demuxer === 'mov') inputArgs.push('-enable_drefs', '0', '-use_absolute_path', '0');
  inputArgs.push('-i', input, '-map_metadata', '-1', '-threads', '2', '-fs', String(MAX_OUTPUT_BYTES));
  const outputs: Record<string, string[]> = {
    wav: ['-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav'],
    mp3: ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'],
    mp4: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4'],
    png: ['-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1'],
    jpg: ['-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2', '-update', '1'],
  };
  if (!outputs[format]) throw new DirectError('UNSUPPORTED_FORMAT', '没有此目标格式。');
  return [...inputArgs, ...outputs[format]!, output];
}

export function validateMediaProbe(stdout: string, maxSeconds = 3600): void {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new DirectError('INVALID_MEDIA_PROBE', '本机媒体检查没有返回有效结果。'); }
  if (!parsed || typeof parsed !== 'object') throw new DirectError('INVALID_MEDIA_PROBE', '本机媒体检查结构无效。');
  if ('format' in parsed && parsed.format && typeof parsed.format === 'object' && 'duration' in parsed.format) {
    const duration = Number(parsed.format.duration);
    if (!Number.isFinite(duration) || duration < 0) throw new DirectError('INVALID_MEDIA_DURATION', '无法核对媒体时长。');
    if (duration > maxSeconds) throw new DirectError('MEDIA_DURATION_LIMIT', `媒体超过本次 ${Math.floor(maxSeconds / 60)} 分钟上限；本次不会截断或发布。`);
  }
  if (!('streams' in parsed) || !Array.isArray(parsed.streams) || !parsed.streams.length) throw new DirectError('INVALID_MEDIA_PROBE', '媒体没有可处理的音视频流。');
  for (const stream of parsed.streams) if (stream && typeof stream === 'object' && stream.codec_type === 'video') {
    const width = Number(stream.width); const height = Number(stream.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000) throw new DirectError('MEDIA_DIMENSION_LIMIT', '媒体尺寸无效或超过本次四千万像素上限。');
  }
}

function stagedToolRunner(runtime?: ProcessRuntime) { return async function runStagedTool(context: TaskExecutionContext, workspace: DirectWorkspace, authority: DirectAuthority,
  binary: DirectBinary, args: string[], binaryPath: string, timeoutMs = 120_000): Promise<DirectProcessResult> {
  const effectId = randomUUID();
  const binaryIdentity = inspectPath(binaryPath);
  await context.emit({ type: 'side_effect_started', effectId, description: binary === 'yt-dlp' ? '使用固定工具读取公开视频信息' : '使用固定本机工具处理本次暂存文件', operation: { binary: binaryPath } });
  try {
    const response = await runDirectProcess({ runtime: runtime!, binary, binaryPath, args, cwd: workspace.path, signal: context.signal, timeoutMs, maxOutputBytes: binary === 'yt-dlp' ? 8_000_000 : 2_000_000,
      onProcessState: (event) => context.emit({ type: 'process_state', ...event }), onHeartbeat: (event) => context.emit({ type: 'heartbeat', ...event }),
      assertAuthorized: () => { authority.assert(); workspace.assertCurrent(); if (!samePathIdentity(binaryIdentity, inspectPath(binaryPath), true)) throw new DirectError('TOOL_CHANGED', '工具身份已变化，需要重新核对授权。'); } });
    await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: binary === 'yt-dlp' ? '视频提取进程与输出流已正常收束；网络入口随后单独关闭，产物另行核对。' : '本机工具进程与输出流已正常收束，影响限于本次暂存；产物另行核对。' });
    return response;
  } catch (error) {
    if (error instanceof DirectProcessError && error.disposition !== 'unknown') {
      await context.emit({ type: 'side_effect_result', effectId, outcome: error.disposition === 'not_started' ? 'not_applied' : 'failed', evidence: '本机工具已确认未启动或已关闭；用户产物尚未发布，保留暂存可供恢复。' });
    }
    throw error;
  }
}; }

function archiveSuffix(path: string): string { const match = path.match(/\.(tar\.(gz|zst|zstd|bz2)|tgz|tbz2|txz|zip|tar)$/iu); return match?.[0] ?? extname(path); }

async function executeMove(context: TaskExecutionContext, args: Arguments, reference: FileReference, files: FileReferenceService): Promise<TaskResult> {
  if (reference.kind !== 'file' || reference.identity.links.length || lstatSync(reference.canonicalPath, { bigint: true }).nlink !== 1n) throw new DirectError('UNSUPPORTED_MOVE', '移动只支持未经过符号链接的单链接普通文件。');
  const destination = prepareDestination(String(args.destination));
  if (reference.device !== destination.parent.object?.device) throw new DirectError('CROSS_VOLUME_MOVE', '当前只允许同一磁盘卷内移动普通文件。');
  const authority = await acquireAuthority(context, 'file.move', args, [fileCapability('read', reference.invocationPath), fileCapability('delete', reference.invocationPath), fileCapability('write', destination.path)]);
  authority.assert(); files.verify(reference.id);
  const owner = await root(commonAncestor(reference.canonicalPath, destination.path), { mutationSymlinks: 'reject', symlinks: 'reject' });
  const effectId = randomUUID();
  await context.emit({ type: 'side_effect_started', effectId, description: '移动所选普通文件到新位置', operation: { fileRefId: reference.id, destination: destination.path } });
  await owner.move(relative(owner.rootReal, reference.canonicalPath), relative(owner.rootReal, destination.path), { overwrite: false,
    assertBeforeMutation: () => { authority.assert(); files.verify(reference.id); assertDestinationCurrent(destination); } });
  const moved = files.updateAfterMove(reference.id, { newPath: destination.path, expectedVersion: reference.version });
  await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '同卷不覆盖移动已结束；同一 inode、内容版本、新旧位置和引用版本已核对。', data: { fileRefId: moved.id } });
  return result(`已将“${reference.displayName}”移动到新位置。`, { fileRefId: moved.id, path: moved.invocationPath });
}

function validateShortcuts(input: readonly ShortcutDefinition[]): ShortcutDefinition[] {
  const ids = new Set<string>();
  return input.map((entry) => {
    if (!entry || !entry.id || entry.id.length > 256 || ids.has(entry.id) || entry.userSelected !== true || !entry.name?.trim() || entry.name.startsWith('-') || /[\u0000-\u001f]/u.test(entry.name)
      || !entry.effectDescription?.trim() || !Array.isArray(entry.capabilities) || entry.capabilities.some((capability) => capability.action === 'secret')) {
      throw new DirectError('INVALID_SHORTCUT', '快捷指令必须由用户明确选择，并声明固定名称和精确影响；凭据调用不属于此动作。');
    }
    ids.add(entry.id);
    if (entry.verification) normalizePermissionPath(entry.verification.path);
    return structuredClone(entry);
  });
}

async function executeShortcut(context: TaskExecutionContext, args: Arguments, shortcuts: readonly ShortcutDefinition[], files: FileReferenceService, artifactRoot: string, protection: DirectPathProtection, requireBinary: (name: DirectBinary) => string, runtime?: ProcessRuntime): Promise<TaskResult> {
  const shortcut = shortcuts.find((entry) => entry.id === args.shortcutId);
  if (!shortcut) throw new DirectError('SHORTCUT_NOT_SELECTED', '此快捷指令尚未被用户明确选择。');
  const destination = shortcut.verification ? prepareDestination(shortcut.verification.path) : undefined;
  if (destination) protection.assertPath(destination.path);
  protection.assertCapabilities(shortcut.capabilities);
  if (destination && !shortcut.capabilities.some((capability) => capability.action === 'write' && capability.target.kind === 'file' && capability.target.path === destination.path)) throw new DirectError('SHORTCUT_CAPABILITY_MISSING', '快捷指令结果文件必须声明精确写入权限。');
  const binary = requireBinary('shortcuts');
  const authority = await acquireAuthority(context, 'mac.shortcut', { ...args, name: shortcut.name, effectDescription: shortcut.effectDescription }, [fileCapability('execute', binary), ...shortcut.capabilities]);
  const effectId = randomUUID();
  await context.emit({ type: 'side_effect_started', effectId, description: shortcut.effectDescription, operation: { shortcutId: shortcut.id, name: shortcut.name } });
  authority.assert(); if (destination) assertDestinationCurrent(destination);
  await runDirectProcess({ runtime: runtime!, binary: 'shortcuts', binaryPath: binary, args: ['run', shortcut.name], cwd: artifactRoot, signal: context.signal,
    onProcessState: (event) => context.emit({ type: 'process_state', ...event }), onHeartbeat: (event) => context.emit({ type: 'heartbeat', ...event }),
    assertAuthorized: () => { authority.assert(); if (requireBinary('shortcuts') !== binary) throw new DirectError('TOOL_CHANGED', '工具绑定已变化。'); if (destination) assertDestinationCurrent(destination); } });
  if (!destination) throw new DirectError('SHORTCUT_RESULT_UNKNOWN', '快捷指令进程已结束，但尚无真实影响的核对依据，请人工核对。', true);
  const observed = inspectPath(destination.path);
  protection.assertPath(destination.path);
  if (observed.object?.kind !== 'file' || observed.links.length || !lstatSync(destination.path).isFile() || (shortcut.verification?.nonempty && !observed.object.size)
    || !samePathIdentity(destination.parent, inspectPath(dirname(destination.path)))) throw new DirectError('SHORTCUT_RESULT_UNKNOWN', '快捷指令结果文件无法完整核对。', true);
  const reference = files.register({ path: destination.path, source: 'generated', taskId: context.task.id,
    ...(context.task.conversationId ? { conversationId: context.task.conversationId } : {}) });
  files.link(reference.id, { artifactId: reference.id });
  await context.emit({ type: 'checkpoint', checkpoint: { publishedArtifactIds: [reference.id], path: destination.path } });
  if (shortcut.capabilities.some((capability) => capability.action === 'delete' || capability.action === 'network' || capability.action === 'execute'
    || (capability.action === 'write' && (capability.target.kind !== 'file' || capability.target.path !== destination.path)))) {
    throw new DirectError('SHORTCUT_EXTRA_EFFECTS_UNKNOWN', '结果文件已核对，但快捷指令其他写入、删除、执行或网络影响尚无核对依据，请人工核对。', true);
  }
  await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '快捷指令进程已收束，并核对了明确声明的新结果文件；其他内部影响仍由配置者负责声明。', data: { fileRefId: reference.id } });
  return result(`快捷指令“${shortcut.name}”已生成并核对结果文件。`, { fileRefId: reference.id }, [reference.id]);
}

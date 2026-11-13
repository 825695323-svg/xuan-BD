import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOperationArgs, inspectPath } from '../security/permissions.js';
import { TaskError, type TaskExecutionContext } from '../jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { SkillRegistry } from './registry.js';
import type { DirectRuntimeOptions } from '../../contracts/direct-runtime.js';
import type { RegisteredProgramName } from '../runtime/programs.js';

const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const common = ['platform/plugins/direct-versions.ts', 'platform/plugins/registry.ts', 'platform/plugins/router.ts',
  'platform/resources/files.ts', 'platform/resources/pinned-read.ts', 'platform/security/permissions.ts',
  'platform/security/path-protection.ts', 'platform/config/source-settings.ts', 'platform/runtime/file-workspace.ts', 'platform/jobs/tasks.ts'];
/** 显式列出动作使用的实现；不从 local-actions 的全部静态 import 递归到其它能力。 */
const groups = {
  local: ['platform/capabilities/local-actions.ts'],
  fileTools: ['platform/capabilities/files/text.ts'],
  assembly: ['apps/server/capabilities.ts'],
  process: ['platform/runtime/programs.ts', 'platform/runtime/process.ts'],
  bundledTrust: ['platform/resources/bundled.ts'],
  compare: ['platform/capabilities/files/compare.ts'],
  web: ['platform/capabilities/browser/public-web.ts', 'platform/capabilities/browser/raw-page.ts', 'platform/capabilities/browser/html-extraction.ts'],
  search: ['platform/capabilities/browser/search.ts'],
  transcription: ['platform/capabilities/transcription/local.ts', 'platform/resources/bundled.ts'],
  video: ['platform/capabilities/transcription/video.ts', 'platform/capabilities/transcription/network.ts'],
  browser: ['platform/capabilities/browser/index.ts', 'platform/capabilities/browser/owned-page.ts', 'platform/capabilities/browser/sites.ts'],
  capture: ['plugins/capture-sources/index.ts', 'plugins/capture-sources/contracts.ts', 'plugins/capture-sources/sites.ts',
    'plugins/capture-sources/owned-capture.ts', 'plugins/capture-sources/session.ts', 'platform/capabilities/browser/host.ts'],
  source: ['plugins/api-sources/runtime.ts', 'plugins/api-sources/public-kline.ts', 'plugins/api-sources/providers/ths/api.ts', 'plugins/api-sources/providers/werss/cache.ts', 'plugins/api-sources/providers/wechat/script.ts', 'plugins/api-sources/manager.ts',
    'plugins/capture-sources/eastmoney/minute.ts', 'platform/config/source-settings.ts', 'platform/config/connections.ts', 'contracts/source-settings.ts', 'platform/config/model.ts'],
  tdx: ['plugins/api-sources/providers/tdx/api.ts', 'plugins/api-sources/providers/tdx/runtime.ts'],
  conversion: ['platform/capabilities/conversion/index.ts', 'platform/capabilities/conversion/formats.ts', 'platform/capabilities/conversion/worker.ts', 'platform/capabilities/conversion/storage.ts'],
  office: ['platform/capabilities/conversion/office.ts'], pdf: ['platform/capabilities/conversion/pdf.ts'], media: ['platform/capabilities/conversion/media.ts'],
  html: ['platform/capabilities/browser/html-extraction.ts'],
  baidu: ['plugins/capture-sources/baidu-drive/index.ts', 'plugins/storage/baidu-drive.ts', 'platform/config/connections.ts'],
  // 这些实现不在旧 baidu/process/assembly 组内，必须与当前宿主已加载字节一起冻结。
  artifactManifest: ['modules/collection/artifact-manifest.ts'],
  artifactArchive: ['modules/collection/artifact-archive.ts', 'plugins/storage/baidu-drive.ts'],
  artifactRestore: ['modules/collection/artifact-restore.ts', 'modules/collection/artifact-archive.ts', 'plugins/storage/baidu-drive.ts'],
  artifactLifecycle: ['modules/collection/artifact-lifecycle.ts', 'modules/collection/artifact-archive.ts', 'plugins/storage/baidu-drive.ts'],
  candidateReclaim: ['modules/collection/candidate-reclaim.ts', 'modules/collection/candidate-object-storage.ts',
    'modules/collection/r1-structured-handoff.ts'],
  model: ['modules/agent/model-tools.ts'], ocr: ['modules/agent/ocr.ts', 'adapters/llm/pi.ts'],
  algorithms: ['modules/financial/conversation-algorithms.ts', 'modules/financial/basic-algorithm-tool-contract.ts',
    'modules/financial/algorithm-registry.ts', 'modules/financial/algorithm-definitions.ts', 'modules/collection/production-module-ports.ts'],
  material: ['modules/collection/conversation-materials.ts', 'modules/collection/accept-material.ts', 'modules/collection/materials/plugins.ts',
    'plugins/api-sources/providers/werss/cache.ts', 'plugins/api-sources/providers/wechat/script.ts', 'platform/capabilities/browser/html-extraction.ts'],
  materialRead: ['modules/collection/materials/service.ts', 'modules/collection/data-processing/material-inspector/index.ts'],
  materialProcess: ['modules/collection/materials/semantic.ts', 'modules/collection/materials/semantic-contracts.ts', 'modules/collection/data-processing/table-cleaner/index.ts'],
  materialTranscription: ['modules/collection/materials/media-adapter.ts'],
  r1: ['modules/collection/conversation-r1.ts', 'modules/collection/r1-workspace.ts', 'modules/collection/r1-runtime.ts',
    'modules/collection/r1-structured-handoff.ts', 'modules/collection/conversation-processing.ts', 'modules/collection/processing-plan.ts',
    'contracts/workspace-services.ts', 'contracts/r1-contracts.ts', 'adapters/database/wfd-product-machine.ts', 'adapters/database/wfd-transport.ts',
    'adapters/database/wfd-product-connection.ts', 'platform/config/connections.ts', 'platform/resources/bindings.ts',
    'modules/collection/r1-paged-readback.ts', 'modules/collection/candidate-service.ts', 'modules/collection/candidate-object-storage.ts'],
} as const;
export type DirectImplementation = keyof typeof groups;
const packageGroups: Partial<Record<DirectImplementation | 'common', readonly string[]>> = {
  common: ['@openclaw/fs-safe'], compare: ['diff'], web: ['ipaddr.js', 'undici', 'linkedom', '@mozilla/readability'],
  material: ['linkedom'],
  conversion: ['linkedom', 'iconv-lite'], pdf: ['pdfjs-dist', '@napi-rs/canvas'], media: ['@napi-rs/canvas'],
  html: ['linkedom', '@mozilla/readability'],
};
const failure = (message: string): never => { throw new TaskError('DIRECT_DEPENDENCY_UNAVAILABLE', message); };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = new Map([...new Set([...common, ...Object.values(groups).flat()])].map(path => {
  try { return [path, hash(readFileSync(join(codeRoot, path)))] as const; }
  catch { return [path, null] as const; }
}));
type FileVersion = { path: string; device: string; inode: string; size: string; mtime: string; ctime: string; sha256: string };
const fileCache = new Map<string, FileVersion>();
const bundledRoot = join(codeRoot, 'resources/bundled');
const bundledManifest = (() => {
  try { return JSON.parse(readFileSync(join(bundledRoot, 'manifest.json'), 'utf8')) as { files: { path: string; sha256?: string; kind?: string; target?: string }[] }; }
  catch { return null; }
})();
/** 大型模型/浏览器只在对象元信息改变后重读字节；ctime 同时拒绝原位替换后伪造 mtime。 */
export function directFileVersion(path: string): FileVersion {
  const canonical = realpathSync(path), stat = lstatSync(canonical, { bigint: true });
  if (!stat.isFile()) return failure('依赖文件不是普通文件，未替换执行资源。');
  const identity = { path: canonical, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
  const known = fileCache.get(path);
  if (known && Object.entries(identity).every(([key, value]) => known[key as keyof FileVersion] === value)) return known;
  const fd = openSync(path, 'r'), digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  try {
    for (let bytes; (bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0;) digest.update(chunk.subarray(0, bytes));
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) return failure('依赖文件在核对中变化，未捕获不一致版本。');
    const result = { ...identity, sha256: digest.digest('hex') }; fileCache.set(path, result); return result;
  } finally { closeSync(fd); }
}
const packageFiles = new Map<string, { name: string; files: [string, string][]; dependencies: string[] }>();
const packageRoots = new Map<string, string>();
const hostLinuxLibc: 'gnu' | 'musl' | null = process.platform === 'linux'
  ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? 'gnu' : 'musl'
  : null;
/** 可选原生包按已运行宿主的 ABI（系统二进制接口）选择，不从进程 PATH 猜二进制程序。 */
export function nativeOptionalDependencyMatches(name: string,
  platform: string = process.platform, arch: string = process.arch,
  libc: 'gnu' | 'musl' | null = hostLinuxLibc): boolean {
  if (!name.includes(`${platform}-${arch}`)) return false;
  if (platform !== 'linux') return true;
  const match = name.match(/linux-[a-z0-9]+-(gnu|musl)(?:$|-)/u);
  return !match || match[1] === libc;
}
function snapshotPackage(name: string, from = require): string {
  let root: string, metadata: { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  try {
    root = dirname(realpathSync(from.resolve(name)));
    for (;;) {
      try { metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof metadata; if (metadata.name === name) break; } catch { /* 包入口可位于多层 dist/lib（发行目录）。 */ }
      const next = dirname(root); if (next === root) throw new Error(); root = next;
    }
  } catch { const key = `unavailable:${name}`; packageFiles.set(key, { name, files: [], dependencies: [] }); return key; }
  if (packageFiles.has(root)) return root;
  try {
  const files: [string, string][] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || /^(?:tests?|examples?|docs?|types|\.git)$/iu.test(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && !/\.(?:md|map|d\.[cm]?ts)$/iu.test(entry.name)
        && !/^(?:license|licence|notice|changelog|package-lock)/iu.test(entry.name)) files.push([child, directFileVersion(child).sha256]);
    }
  };
  visit(root);
  const dependencies = Object.keys(metadata.dependencies ?? {});
  // 仅绑定当前 OS/CPU/系统 C 库对应的原生依赖。Linux GNU 与 musl
  // 不能同时加入：缺少另一系统 C 库的可选包不代表当前宿主不可用。
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {}))
    if (nativeOptionalDependencyMatches(dependency)) dependencies.push(dependency);
  const snapshot = { name, files, dependencies: [] as string[] };
  packageFiles.set(root, snapshot);
  const localRequire = createRequire(join(root, 'package.json'));
  snapshot.dependencies = dependencies.map(dependency => snapshotPackage(dependency, localRequire));
  } catch { packageFiles.set(root, { name, files: [], dependencies: [] }); }
  return root;
}
// 模块装载时固定实现，之后磁盘新字节不能被当作已装入的旧闭包版本。
for (const name of new Set(Object.values(packageGroups).flat())) packageRoots.set(name, snapshotPackage(name));
function packageVersion(root: string, seen: Set<string>, output: Record<string, string>): void {
  if (seen.has(root)) return; seen.add(root);
  const snapshot = packageFiles.get(root);
  if (!snapshot?.files.length) return failure(`动作实际依赖 ${snapshot?.name ?? root} 尚无可核对的已装载版本。`);
  for (const [path, expected] of snapshot.files) if (directFileVersion(path).sha256 !== expected) return failure(`动作依赖 ${snapshot.name} 的实现已变化，请核对后重启。`);
  output[relative(codeRoot, root)] = digestOperationArgs(snapshot.files.map(([path, sha256]) => [relative(codeRoot, path), sha256]));
  snapshot.dependencies.forEach(dependency => packageVersion(dependency, seen, output));
}
export function directImplementationVersion(selected: readonly DirectImplementation[]): string {
  const files = [...new Set([...common, ...selected.flatMap(name => groups[name])])].sort();
  for (const path of files) {
    const expected = sourceFiles.get(path);
    let actual: string | undefined;
    try { actual = hash(readFileSync(join(codeRoot, path))); } catch { /* 仅本动作的实现缺失会拒绝本动作。 */ }
    if (!expected || actual !== expected) return failure('动作的已装载实现与磁盘字节不同，请核对后重启；未将新字节冒充为当前实现。');
  }
  const dependencies: Record<string, string> = {}, seen = new Set<string>();
  for (const name of new Set([...packageGroups.common!, ...selected.flatMap(name => packageGroups[name] ?? [])])) packageVersion(packageRoots.get(name)!, seen, dependencies);
  return digestOperationArgs({ files: files.map(path => [path, sourceFiles.get(path)]), dependencies,
    node: process.versions.node, platform: process.platform, arch: process.arch });
}
export function directDependencyVersions(action: string, implementation: readonly DirectImplementation[], configuration: unknown, resources: unknown): Record<string, string> {
  return { directContract: 'direct-dependencies/1', directAction: action, directImplementation: directImplementationVersion(implementation),
    directConfiguration: digestOperationArgs(configuration), directResources: digestOperationArgs(resources) };
}
export function directResourceVersions(options: DirectRuntimeOptions, programs: readonly RegisteredProgramName[] = [], files: readonly string[] = [], roots: readonly string[] = []): unknown {
  const resources: Record<string, unknown> = { artifact: directoryVersion(options.artifactRoot), runtimeIdentity: options.resources?.document.runtimeIdentity ?? null };
  for (const name of [...new Set([...roots, ...(programs.length ? ['cache', 'temp', 'downloads'] : []), ...(programs.length && process.platform === 'win32' ? ['system_root'] : [])])]) {
    if (options.resources?.document.resources[name]) resources[name] = { binding: options.resources.document.resources[name], actual: directoryVersion(options.resources.path(name)) };
  }
  for (const name of programs) {
    if (!options.processRuntime) return failure('动作执行程序尚未受信装配。');
    let path: string;
    try { path = options.processRuntime.path(name); }
    catch { resources[`program:${name}`] = null; continue; }
    resources[`program:${name}`] = directFileVersion(path);
  }
  const platform = `${process.platform}-${process.arch}`;
  const runtimeAsset = (path: string) => !/\.(?:md|map|d\.[cm]?ts)$/iu.test(path) && !/(?:^|\/)(?:license|licence|notice|changelog|readme|package-lock)(?:[.-]|$)/iu.test(path);
  const assets = (bundledManifest?.files ?? []).filter(entry => runtimeAsset(entry.path) && (
    programs.includes('browser_engine') && (entry.path.startsWith(`${platform}/browser/`) || entry.path.startsWith('browser/node_modules/'))
    || programs.includes('node') && entry.path.startsWith(`${platform}/node/`) && /\.(?:dll|dylib|so)$/iu.test(entry.path)
    || programs.some(name => name === 'ffmpeg' || name === 'ffprobe') && entry.path.startsWith(`${platform}/bin/`) && /(?:avcodec|avformat|avutil|avfilter|avdevice|swscale|swresample)[^/]*\.(?:dll|dylib|so)$/iu.test(entry.path)
    || programs.includes('whisper-cli') && entry.path.startsWith(`${platform}/bin/`) && /(?:whisper|ggml|openblas)[^/]*\.(?:dll|dylib|so)$/iu.test(entry.path)));
  if (assets.length) resources.bundled = assets.map(entry => {
    const path = join(bundledRoot, entry.path);
    if (entry.kind === 'symlink') {
      const target = readlinkSync(path), inside = relative(bundledRoot, realpathSync(path));
      if (!lstatSync(path).isSymbolicLink() || target !== entry.target || isAbsolute(target)
        || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
        || entry.sha256 && hash(target) !== entry.sha256) return failure('本动作使用的随包链接与原受审目标不同。');
      return { path: entry.path, kind: 'symlink', target };
    }
    const actual = directFileVersion(path);
    if (entry.sha256 && actual.sha256 !== entry.sha256) return failure('本动作使用的随包依赖字节已变化，须经现有采用入口核对。');
    return { path: entry.path, sha256: actual.sha256 };
  });
  for (const path of files) resources[`file:${path}`] = directFileVersion(path);
  return resources;
}
export function directoryVersion(path: string): unknown {
  const identity = inspectPath(path);
  if (identity.object?.kind !== 'directory') return failure('动作依赖目录缺失或身份不能核对。');
  return { invocationPath: identity.invocationPath, canonicalPath: identity.canonicalPath, links: identity.links,
    device: identity.object.device, inode: identity.object.inode };
}
/** 权限等待可能跨配置提交；派发和副作用前重核。原事实回执/检查点可记录，清理仍须原身份和授权。 */
export function guardDirectContext(registry: SkillRegistry, original: TaskExecutionContext): TaskExecutionContext {
  const assert = () => registry.assertTaskVersions(original.task);
  assert();
  return { ...original,
    assertAuthorized(operation, capabilities, options) { assert(); return original.assertAuthorized(operation, capabilities, options); },
    async requestApproval(operation, capabilities, options) { assert(); const receipt = await original.requestApproval(operation, capabilities, options); assert(); return receipt; },
    async emit(event) { if (event.type === 'side_effect_started') assert(); await original.emit(event); },
  };
}

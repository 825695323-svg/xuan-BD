import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResourceBinding, ResourceBindings } from './bindings.js';

export interface BundledFile { path: string; sha256: string; bytes: number }
interface BundledLink { path: string; kind: 'symlink'; target: string }
export type BundledCapability = 'application' | 'browser' | 'transcription' | 'conversion';
const CAPABILITIES: BundledCapability[] = ['application', 'browser', 'transcription', 'conversion'];
const RUNTIME_IDENTITY = 'xuan-runtime-resources/v1:';
const runtimeFile = (path: string) => !/(?:^|\/)(?:readme|license|licence|changelog|notice)(?:[.-]|$)/iu.test(path)
  && !/\.(?:md|d\.(?:ts|mts|cts)|map)$/iu.test(path) && !/(?:^|\/)(?:\.?package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/u.test(path);
export interface BundledManifest {
  schemaVersion: 1;
  platforms: Record<string, { executables: Record<string, BundledFile>; [key: string]: unknown }>;
  models: Record<string, BundledFile>;
  files: (BundledFile | BundledLink)[];
  applicationDependencies?: { pathBase: 'application'; packages: { path: string; files: BundledFile[]; platforms?: ('darwin-arm64' | 'win32-x64')[] }[] };
  [key: string]: unknown;
}

/** 只消费发行包唯一清单；不搜索系统程序、不下载、不修改既有机器绑定。 */
export class BundledResources {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: BundledManifest;
  readonly platform: 'darwin-arm64' | 'win32-x64';
  private readonly applicationRoot: string;
  constructor(codeRoot: string) {
    this.applicationRoot = realpathSync(codeRoot);
    this.root = realpathSync(join(codeRoot, 'resources', 'bundled'));
    this.manifestPath = join(this.root, 'manifest.json');
    const info = lstatSync(this.manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('随包资源清单缺失或格式不安全。');
    const raw = readFileSync(this.manifestPath);
    this.manifestSha256 = createHash('sha256').update(raw).digest('hex');
    this.manifest = JSON.parse(raw.toString('utf8')) as BundledManifest;
    const platform = `${process.platform}-${process.arch}`;
    if (!['darwin-arm64', 'win32-x64'].includes(platform)) throw new Error('当前平台架构尚无随包依赖，不能选择其他平台替代。');
    this.platform = platform as typeof this.platform;
    if (this.manifest.schemaVersion !== 1 || !this.manifest.platforms?.[this.platform]?.executables
      || !this.manifest.models || !Array.isArray(this.manifest.files)) throw new Error('随包资源清单结构或当前平台资源缺失。');
  }
  file(entry: BundledFile): string {
    if (!entry || typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path)
      || /[\\:\u0000-\u001f]/u.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('随包文件条目无效。');
    const path = resolve(this.root, ...entry.path.split('/'));
    const part = relative(this.root, path);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('随包文件越界。');
    // 发行包允许自身受控库的符号链接；最终对象必须仍在包根内，清单核实际字节。
    const actual = realpathSync(path), inside = relative(this.root, actual);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('随包文件链接离开包根。');
    const stat = lstatSync(actual);
    if (!stat.isFile() || stat.size !== entry.bytes || createHash('sha256').update(readFileSync(actual)).digest('hex') !== entry.sha256) throw new Error(`随包文件缺失或摘要不一致：${entry.path}`);
    return path;
  }
  executable(id: string): string {
    const entry = this.manifest.platforms[this.platform]!.executables[id];
    if (!entry) throw new Error(`当前平台缺少随包程序 ${id}；不会使用系统替代。`);
    return this.file(entry);
  }
  model(id: string): string {
    const entry = this.manifest.models[id];
    if (!entry) throw new Error(`缺少随包模型 ${id}。`);
    return this.file(entry);
  }
  browser(): { daemonScript: string; daemonSha256: string } {
    const entry = this.manifest.files.find(item => item.path === 'browser/node_modules/bb-browser/dist/daemon.js');
    if (!entry || 'kind' in entry) throw new Error('总清单缺少随包浏览器守护脚本。');
    if (this.manifest.files.some(item => item.path.startsWith('browser/sites/'))) throw new Error('门户专用脚本不能进入固定浏览器资源包。');
    return { daemonScript: this.file(entry), daemonSha256: entry.sha256 };
  }
  /** 默认核共同资源及当前平台；非目标系统的链接无需存在，整包制品核对须显式选择。 */
  verify(options: { allPlatforms?: boolean } = {}): void {
    const names = new Set<string>();
    for (const entry of this.manifest.files) {
      if (names.has(entry.path)) throw new Error('随包清单有重复文件。');
      names.add(entry.path);
      const first = entry.path.split('/')[0];
      if (!options.allPlatforms && ['darwin-arm64', 'win32-x64'].includes(first!) && first !== this.platform) continue;
      if ('kind' in entry && entry.kind === 'symlink') {
        if (typeof entry.path !== 'string' || isAbsolute(entry.path) || /[\\:\u0000-\u001f]/u.test(entry.path)
          || entry.path.split('/').some(part => !part || part === '.' || part === '..') || typeof entry.target !== 'string' || isAbsolute(entry.target)) throw new Error('随包链接条目无效。');
        const path = resolve(this.root, ...entry.path.split('/')), destination = resolve(dirname(path), entry.target);
        const inside = relative(this.root, destination);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== entry.target) throw new Error('随包链接已变化或越界。');
      } else this.file(entry as BundledFile);
    }
    this.verifyApplicationDependencies(options.allPlatforms === true);
  }
  private verifyApplicationDependencies(allPlatforms = false, runtimeOnly = false): void {
    const dependencies = this.manifest.applicationDependencies;
    if (dependencies?.pathBase !== 'application' || !Array.isArray(dependencies.packages)) throw new Error('总清单缺少跨平台转换依赖。');
    const targetPlatforms = allPlatforms ? ['darwin-arm64', 'win32-x64'] : [this.platform];
    const selected = dependencies.packages.filter(pkg => {
      const platforms = pkg.platforms ?? ['win32-x64'];
      if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some(name => !['darwin-arm64', 'win32-x64'].includes(name))) throw new Error('应用依赖的平台声明无效。');
      return platforms.some(name => targetPlatforms.includes(name));
    });
    const required = ['pdfjs-dist', '@napi-rs/canvas', 'iconv-lite', 'safer-buffer',
      ...(targetPlatforms.includes('darwin-arm64') ? ['@napi-rs/canvas-darwin-arm64'] : []),
      ...(targetPlatforms.includes('win32-x64') ? ['@esbuild/win32-x64', '@openclaw/fs-safe-win32-x64-msvc', '@rolldown/binding-win32-x64-msvc', '@typescript/typescript-win32-x64', 'lightningcss-win32-x64-msvc', '@napi-rs/canvas-win32-x64-msvc'] : [])];
    for (const name of required) if (!selected.some(item => item.path === `node_modules/${name}`)) throw new Error(`缺少当前平台应用依赖 ${name}。`);
    const entries: Record<string, string[]> = {
      'pdfjs-dist': ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'],
      '@napi-rs/canvas': ['index.js'], 'iconv-lite': ['lib/index.js'], 'safer-buffer': ['safer.js'],
      '@napi-rs/canvas-darwin-arm64': ['skia.darwin-arm64.node'], '@napi-rs/canvas-win32-x64-msvc': ['skia.win32-x64-msvc.node'],
    };
    const seenPackages = new Set<string>(), seen = new Set<string>();
    for (const pkg of selected) {
      if (seenPackages.has(pkg.path) || !Array.isArray(pkg.files) || !pkg.files.length
        || !['package.json', ...(entries[pkg.path.slice('node_modules/'.length)] ?? [])]
          .every(name => pkg.files.some(entry => entry.path === pkg.path + '/' + name))) throw new Error('应用依赖缺少唯一非空文件清单或必需入口。');
      seenPackages.add(pkg.path);
    }
    for (const pkg of selected) for (const entry of pkg.files) {
      if (!entry.path.startsWith(pkg.path + '/') || !entry.path.startsWith('node_modules/') || /[\\:\u0000-\u001f]/u.test(entry.path)
        || entry.path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || seen.has(entry.path)) throw new Error('应用依赖条目无效或重复。');
      seen.add(entry.path);
      if (runtimeOnly && !runtimeFile(entry.path)) continue;
      const path = join(this.applicationRoot, ...entry.path.split('/')), canonical = realpathSync(path), part = relative(this.applicationRoot, canonical), stat = lstatSync(path);
      if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || !stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes
        || createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) throw new Error(`应用依赖缺失或摘要不一致：${entry.path}`);
    }
  }

  /** 只投影实际运行资源；说明、许可证、类型与构建回执不决定已采用能力的版本。 */
  private runtimeFiles(): Record<BundledCapability, (BundledFile | BundledLink)[]> {
    const groups: Record<BundledCapability, (BundledFile | BundledLink)[]> = { application: [], browser: [], transcription: [], conversion: [] };
    const item = (entry: BundledFile | BundledLink): BundledFile | BundledLink => 'kind' in entry
      ? { path: entry.path, kind: 'symlink', target: entry.target } : { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
    const explicit = new Set<string>();
    for (const [id, entry] of Object.entries(this.manifest.platforms[this.platform]!.executables)) {
      const group = id === 'browser_engine' ? 'browser' : ['ffmpeg', 'ffprobe', 'whisper_cli', 'yt_dlp'].includes(id) ? 'transcription' : 'application';
      groups[group].push(item(entry)); explicit.add(entry.path);
    }
    for (const entry of Object.values(this.manifest.models)) { groups.transcription.push(item(entry)); explicit.add(entry.path); }
    const names = new Set<string>();
    for (const entry of this.manifest.files) {
      if (!entry || typeof entry.path !== 'string' || names.has(entry.path)) throw new Error('随包清单文件路径无效或重复。');
      names.add(entry.path);
      if (explicit.has(entry.path) || !runtimeFile(entry.path)) continue;
      if (entry.path.startsWith(`${this.platform}/browser/`) || entry.path.startsWith('browser/node_modules/')) groups.browser.push(item(entry));
      else if (entry.path.startsWith(`${this.platform}/bin/`)) groups.transcription.push(item(entry));
      else if (entry.path.startsWith(`${this.platform}/node/`) && /\.(?:dll|dylib|so)$/iu.test(entry.path)) groups.application.push(item(entry));
      else if (!entry.path.startsWith('darwin-arm64/') && !entry.path.startsWith('win32-x64/')
        && /\.(?:[cm]?js|[cm]?ts|json|wasm|node|dll|dylib|so|sh|exe)$/iu.test(entry.path)
        && !/^(?:licenses\/|[^/]*manifest\.json$|browser\/package-lock\.json$)/u.test(entry.path)) groups.application.push(item(entry));
    }
    // 固定守护入口必须存在；删除或新增其依赖同样改变浏览器投影。
    this.browser();
    const dependencies = this.manifest.applicationDependencies;
    if (dependencies?.pathBase !== 'application' || !Array.isArray(dependencies.packages)) throw new Error('总清单缺少跨平台转换依赖。');
    for (const pkg of dependencies.packages) if ((pkg.platforms ?? ['win32-x64']).includes(this.platform)) {
      if (!Array.isArray(pkg.files)) throw new Error('应用依赖缺少文件清单。');
      groups.conversion.push(...pkg.files.filter(entry => runtimeFile(entry.path)).map(item));
    }
    for (const entries of Object.values(groups)) entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return groups;
  }
  private runtimeIdentity(): string {
    return RUNTIME_IDENTITY + JSON.stringify(Object.fromEntries(Object.entries(this.runtimeFiles())
      .map(([name, entries]) => [name, createHash('sha256').update(JSON.stringify(entries)).digest('hex')])));
  }
  /** 原文摘要保留采用来源；非 owned 清单文件的 identity 另固定运行资源投影。 */
  private manifestBinding(): ResourceBinding {
    return { kind: 'file', path: this.manifestPath, sha256: this.manifestSha256, identity: this.runtimeIdentity() };
  }

  /** 未知旧清单不能重建其投影；只在原文仍一致时沿用旧登记。 */
  changedCapabilities(resources: ResourceBindings): BundledCapability[] {
    const bound = resources.document.resources.bundle_manifest, current = this.manifestBinding(), changed = new Set<BundledCapability>();
    if (bound?.identity?.startsWith(RUNTIME_IDENTITY)) {
      let previous: Record<string, unknown>;
      try { previous = JSON.parse(bound.identity.slice(RUNTIME_IDENTITY.length)); } catch { throw new Error('已采用的运行资源投影无效。'); }
      const next = JSON.parse(current.identity!.slice(RUNTIME_IDENTITY.length)) as Record<BundledCapability, string>;
      if (!previous || Object.keys(previous).sort().join(',') !== [...CAPABILITIES].sort().join(',')
        || Object.values(previous).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) throw new Error('已采用的运行资源投影无效。');
      for (const name of CAPABILITIES) if (previous[name] !== next[name]) changed.add(name);
    } else if (bound?.sha256 !== this.manifestSha256) for (const name of CAPABILITIES) changed.add(name);
    if (bound?.kind !== 'file' || resources.path('bundle_manifest') !== this.manifestPath) changed.add('application');
    for (const [id, expected] of Object.entries(this.selectedBindings())) {
      if (id === 'bundle_manifest') continue;
      if (resources.document.resources[id]?.kind === expected.kind && resources.document.resources[id]?.sha256 === expected.sha256 && resources.path(id) === expected.path) continue;
      changed.add(id === 'browser_engine' ? 'browser' : id === 'node' ? 'application' : 'transcription');
    }
    return CAPABILITIES.filter(name => changed.has(name));
  }

  selectedBindings(): Record<string, ResourceBinding> {
    const bindings: Record<string, ResourceBinding> = { bundle_manifest: this.manifestBinding() };
    for (const id of ['ffmpeg', 'ffprobe', 'whisper_cli', 'yt_dlp', 'node', 'browser_engine']) {
      bindings[id] = { kind: 'program', path: this.executable(id), sha256: this.manifest.platforms[this.platform]!.executables[id]!.sha256 };
    }
    bindings.whisper_base = { kind: 'file', path: this.model('whisper_base'), sha256: this.manifest.models.whisper_base!.sha256 };
    return bindings;
  }
  assertBindings(resources: ResourceBindings): void {
    this.verifyApplicationDependencies(false, true);
    for (const [name, entries] of Object.entries(this.runtimeFiles())) if (name !== 'conversion') for (const entry of entries) {
      if ('kind' in entry) {
        if (!entry.path || isAbsolute(entry.path) || /[\\:\u0000-\u001f]/u.test(entry.path)
          || entry.path.split('/').some(part => !part || part === '.' || part === '..') || typeof entry.target !== 'string' || isAbsolute(entry.target)) throw new Error('随包运行链接条目无效。');
        const path = resolve(this.root, entry.path), target = resolve(dirname(path), entry.target), part = relative(this.root, target);
        if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== entry.target) throw new Error('随包运行链接已变化或越界。');
      } else this.file(entry);
    }
    if (this.changedCapabilities(resources).length) throw new Error('实际随包运行资源尚未通过受控采用；旧清单摘要漂移且没有运行投影时须先核定一次采用。');
  }
}

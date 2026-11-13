import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ResourceReference { root: string; identity: string; relative: string }
export interface ResourceBinding {
  path: string;
  kind: 'directory' | 'file' | 'program';
  owned?: boolean;
  /** 独立受管能力可缺席；只有固定身份可用时才解析其文件。 */
  optional?: true;
  /** 受管理目录的稳定身份；非受管理清单文件可使用带版本前缀的执行资源投影身份。 */
  identity?: string;
  device?: string;
  inode?: string;
  /** 随包静态文件/程序采用时固定的内容摘要，不授予使用权限。 */
  sha256?: string;
}
export interface MachineBindingDocument {
  version: 1;
  revision: number;
  runtimeIdentity: string;
  /** 各位置独立配置；相对路径以运行根解析，绝对路径保留独立位置。 */
  resources: Record<string, ResourceBinding>;
}

/** 只由可信启动器读取；模型和插件不能改写位置或扩大授权。 */
export class ResourceBindings {
  readonly document: MachineBindingDocument;
  constructor(readonly runtimeRoot: string) {
    if (!isAbsolute(runtimeRoot) || runtimeRoot.includes('\0')) throw new Error('运行工作根必须是明确的绝对路径。');
    if (lstatSync(join(runtimeRoot, 'config/.bindings-maintenance.lock'), { throwIfNoEntry: false })) throw new Error('资源绑定正在受控维护；请等待维护完成后启动。');
    const marker = objectFile(join(runtimeRoot, '.xuan-runtime.json'));
    const value = objectFile(join(runtimeRoot, 'config/machine.bindings.json'));
    if (marker.application !== 'xuan-bd' || marker.version !== 1 || typeof marker.identity !== 'string'
      || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || value.runtimeIdentity !== marker.identity || !record(value.resources)) throw new Error('运行根身份或资源绑定版本无效。');
    this.document = value as unknown as MachineBindingDocument;
    const owned: string[] = [];
    for (const [name, binding] of Object.entries(this.document.resources)) {
      if (!/^[a-z][a-z0-9_]*$/u.test(name) || !record(binding) || typeof binding.path !== 'string'
        || !binding.path || binding.path.includes('\0') || !['directory', 'file', 'program'].includes(binding.kind)
        || (binding.optional !== undefined && (binding.optional !== true || binding.owned !== true))
        || (binding.sha256 !== undefined && (binding.kind === 'directory' || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.sha256)))) throw new Error('资源登记格式无效。');
      const path = this.path(name);
      if (binding.owned) {
        if (binding.kind !== 'directory' || typeof binding.identity !== 'string' || !binding.identity
          || typeof binding.device !== 'string' || typeof binding.inode !== 'string') throw new Error('受管理目录缺少固定身份。');
        if (owned.some(other => contains(other, path) || contains(path, other))) throw new Error('受管理存储根不能重叠。');
        owned.push(path);
        if (!binding.optional) this.assertOwnedRoot(name, path, binding);
      }
    }
  }

  path(name: string): string {
    const binding = this.document.resources[name];
    if (!binding) throw new Error(`资源 ${name} 尚未绑定。`);
    if (isAbsolute(binding.path)) return resolve(binding.path);
    validateRelative(binding.path);
    return resolve(this.runtimeRoot, ...binding.path.split('/'));
  }

  program(name: string): string {
    if (this.document.resources[name]?.kind !== 'program') throw new Error(`程序 ${name} 尚未登记。`);
    return this.path(name);
  }

  private assertOwnedRoot(name: string, path: string, binding: ResourceBinding) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode)
      throw new Error(`资源 ${name} 已替换或尚未经过身份核对。`);
  }

  ownedDirectoryAvailable(name: string): boolean {
    const binding = this.document.resources[name];
    if (!binding?.owned || binding.kind !== 'directory') return false;
    try { this.assertOwnedRoot(name, this.path(name), binding); return true; } catch { return false; }
  }

  /** 仅把已有受管理根下的文件登记为逻辑引用；外部用户文件仍由原授权记录管理。 */
  reference(path: string): ResourceReference | undefined {
    for (const [name, binding] of Object.entries(this.document.resources)) {
      if (!binding.owned) continue;
      const base = this.path(name);
      if (!contains(base, path)) continue;
      if (binding.optional && !this.ownedDirectoryAvailable(name)) return undefined;
      const part = relative(base, path).split(sep).join('/');
      if (!part) continue;
      validateRelative(part);
      return { root: name, identity: binding.identity!, relative: part };
    }
    return undefined;
  }

  resolve(reference: ResourceReference): string {
    if (!reference || typeof reference.root !== 'string') throw new Error('资源引用无效。');
    const binding = this.document.resources[reference.root];
    if (!binding?.owned || binding.identity !== reference.identity) throw new Error('资源引用与当前存储身份不一致。');
    validateRelative(reference.relative);
    const base = this.path(reference.root), path = resolve(base, ...reference.relative.split('/'));
    this.assertOwnedRoot(reference.root, base, binding);
    if (!contains(base, path) || path === base) throw new Error('资源引用越界。');
    // 核对已有祖先，拒绝通过链接离开已登记的根；最终文件身份仍由文件引用服务检查。
    let current = base;
    for (const component of reference.relative.split('/')) {
      current = join(current, component);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('资源引用不能穿过符号链接。'); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') break; throw error; }
    }
    return path;
  }
}

/** 固定发现规则定位配置；具体机器位置只保存在该记录或明确启动覆盖中。 */
export function launcherPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Xuan BD/launcher.json');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Local', 'Xuan BD', 'launcher.json');
  throw new Error('随包启动当前支持 macOS arm64 与 Windows x64；此平台尚未提供依赖。');
}
export function locateRuntimeRoot(explicit?: string, environment: NodeJS.ProcessEnv = process.env, locatorFile?: string): string {
  const override = explicit ?? environment.XUAN_BD_HOME;
  if (override !== undefined) {
    if (!isAbsolute(override) || override.includes('\0')) throw new Error('运行工作根覆盖需要绝对路径。');
    return resolve(override);
  }
  if (locatorFile !== undefined && (!isAbsolute(locatorFile) || locatorFile.includes('\0'))) throw new Error('启动定位文件需要明确的绝对路径。');
  const locator = objectFile(locatorFile ?? launcherPath());
  if (locator.version !== 1 || typeof locator.runtimeRoot !== 'string' || !isAbsolute(locator.runtimeRoot)
    || typeof locator.runtimeIdentity !== 'string') throw new Error('启动定位记录无效。');
  const marker = objectFile(join(locator.runtimeRoot, '.xuan-runtime.json'));
  if (marker.identity !== locator.runtimeIdentity) throw new Error('启动定位与运行根身份不一致。');
  return locator.runtimeRoot;
}
function objectFile(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000) throw new Error('配置必须是有界普通文件。');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(value)) throw new Error('配置必须是结构化对象。');
  return value;
}
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function contains(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function validateRelative(value: string): void {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\u0000-\u001f]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('资源相对位置无效或越界。');
}

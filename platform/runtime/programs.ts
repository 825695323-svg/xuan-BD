import { accessSync, constants, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import type { ResourceBindings, ResourceReference } from '../resources/bindings.js';
import { CAPTURE_SOURCE_IDS } from '../../plugins/capture-sources/contracts.js';

const PROGRAMS = { open: 'open', mdfind: 'mdfind', shortcuts: 'shortcuts',
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', 'whisper-cli': 'whisper_cli', 'yt-dlp': 'yt_dlp', python3: 'python', bdpan: 'bdpan', security: 'security',
  node: 'node', browser_engine: 'browser_engine', taskkill: 'taskkill' } as const;
export type RegisteredProgramName = keyof typeof PROGRAMS;
type Identity = { path: string; canonical: string; device: bigint; inode: bigint; size: bigint; mtime: bigint; ctime: bigint };
type DirectoryIdentity = Pick<Identity, 'path' | 'canonical' | 'device' | 'inode'>;

/** 仅受信宿主持有；位置登记不代替任务权限。无 PATH 搜索、安装或替代程序。 */
export class ProcessRuntime {
  readonly #identities = new Map<RegisteredProgramName, Identity>();
  readonly #directories = new Map<string, DirectoryIdentity>();
  readonly #captureHomes = new Map<string, DirectoryIdentity[]>();
  readonly #captureDirectories = new Map<string, DirectoryIdentity>();
  readonly #nativeCaptureHomes = new Set<string>();
  readonly #resources: ResourceBindings;
  constructor(resources: ResourceBindings) {
    this.#resources = resources;
    for (const name of Object.keys(PROGRAMS) as RegisteredProgramName[]) {
      try { this.#identities.set(name, this.inspect(name)); } catch { /* 未就绪能力单独不可用，不阻塞无关能力。 */ }
    }
    for (const name of ['system_root', 'browser_home']) {
      try { this.#directories.set(name, this.inspectDirectory(name)); } catch { /* 缺少专用资源时拒绝对应执行。 */ }
    }
  }
  path(name: RegisteredProgramName): string {
    const expected = this.#identities.get(name);
    if (!expected) throw new Error(`程序 ${name} 未登记或不可执行，请核对绑定后重启。`);
    const actual = this.inspect(name);
    if (Object.keys(expected).some(key => expected[key as keyof Identity] !== actual[key as keyof Identity])) throw new Error(`程序 ${name} 的对象身份已改变，请重新核对。`);
    return actual.path;
  }
  /** 只匹配已有程序登记，并复用执行前同一对象身份核验；不搜索目录或授予执行权限。 */
  isRegisteredExecutable(path: string): boolean {
    for (const [name, identity] of this.#identities) if (identity.path === path) return this.path(name) === path;
    return false;
  }
  private inspect(name: RegisteredProgramName): Identity {
    if (!Object.hasOwn(PROGRAMS, name)) throw new Error('程序名称未登记。');
    const path = this.#resources.program(PROGRAMS[name]), canonical = realpathSync(path), stat = statSync(canonical, { bigint: true });
    if (!stat.isFile()) throw new Error('登记程序不是普通文件。');
    accessSync(path, constants.X_OK);
    return { path, canonical, device: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
  }
  private inspectDirectory(name: string): DirectoryIdentity {
    const binding = this.#resources.document.resources[name];
    if (binding?.kind !== 'directory' || (name === 'browser_home' && !binding.owned)) throw new Error('专用运行目录尚未受信登记。');
    const path = this.#resources.path(name), canonical = realpathSync(path), stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path
      || (binding.owned && (String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode))) throw new Error('专用运行目录身份不符。');
    return { path, canonical, device: stat.dev, inode: stat.ino };
  }
  private fixedDirectory(name: string): string {
    const expected = this.#directories.get(name), actual = this.inspectDirectory(name);
    if (!expected || Object.keys(expected).some(key => expected[key as keyof DirectoryIdentity] !== actual[key as keyof DirectoryIdentity])) throw new Error('专用运行目录缺失或对象身份已变化。');
    return actual.path;
  }
  /** 受信浏览器宿主在首次写入账号根前核对，不创建进程或临时目录。 */
  assertBrowserHome(home: string): void {
    if (home === this.fixedDirectory('browser_home')) return;
    const expected = this.#captureHomes.get(home);
    if (!expected) throw new Error('浏览器 HOME 与宿主登记不一致。');
    for (const part of expected) {
      const stat = lstatSync(part.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(part.path) !== part.canonical
        || stat.dev !== part.device || stat.ino !== part.inode) throw new Error('采集源专用 HOME 对象身份已变化。');
    }
  }
  /** 只计算当前运行身份下的固定路径，不创建目录或开放子 HOME。 */
  captureBrowserHomePath(sourceId: string, runtimeIdentity: string): string {
    if (!(CAPTURE_SOURCE_IDS as readonly string[]).includes(sourceId)) throw new Error('采集源未登记。');
    if (runtimeIdentity !== this.#resources.document.runtimeIdentity) throw new Error('采集源运行身份不符。');
    const root = this.fixedDirectory('browser_home');
    const runtimeKey = createHash('sha256').update(runtimeIdentity).digest('hex');
    return join(root, 'capture-sources', runtimeKey, sourceId);
  }
  /** 仅供受信采集源宿主登记；来源由软件固定，不接收目录、profile 或账号参数。 */
  registerCaptureBrowserHome(sourceId: string, runtimeIdentity: string): string {
    const home = this.captureBrowserHomePath(sourceId, runtimeIdentity), root = this.fixedDirectory('browser_home');
    const parts = [join(root, 'capture-sources'), dirname(home), home];
    if (this.#captureHomes.has(home)) { this.assertBrowserHome(home); return home; }
    const identities: DirectoryIdentity[] = [];
    for (const path of parts) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
      const stat = lstatSync(path, { bigint: true }), canonical = realpathSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) throw new Error('采集源 HOME 不能穿过链接或其他对象。');
      const previous = this.#captureDirectories.get(path);
      if (previous && (previous.device !== stat.dev || previous.inode !== stat.ino || previous.canonical !== canonical)) throw new Error('采集源 HOME 对象身份已变化。');
      const identity = { path, canonical, device: stat.dev, inode: stat.ino };
      identities.push(identity); this.#captureDirectories.set(path, identity);
    }
    this.#captureHomes.set(home, identities); this.assertBrowserHome(home); return home;
  }
  /** 仅采集源原生会话启用；账号数据仍须显式写入此已登记 HOME 下的 profile。 */
  enableNativeCaptureCredentials(home: string): void {
    this.assertBrowserHome(home);
    if (!this.#captureHomes.has(home)) throw new Error('原生采集登录仅限独立站点 HOME。');
    this.#nativeCaptureHomes.add(home);
  }
  private reference(root: string, relative: string): ResourceReference {
    const binding = this.#resources.document.resources[root];
    if (!binding?.owned || !binding.identity) throw new Error(`运行目录 ${root} 尚未登记固定身份。`);
    return { root, identity: binding.identity, relative };
  }
  directory(root: 'cache' | 'temp' | 'downloads', relative: string): string {
    if (!['cache', 'temp', 'downloads'].includes(root)) throw new Error('进程只能准备已登记的缓存、临时或下载目录。');
    let path = '';
    const parts = relative.split('/');
    for (let index = 1; index <= parts.length; index++) {
      path = this.#resources.resolve(this.reference(root, parts.slice(0, index).join('/')));
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('运行目录不是受管理普通目录。');
    }
    return path;
  }
  prepare(name: RegisteredProgramName, nativeHome?: string) {
    const executable = this.path(name), id = randomUUID();
    const browserHome = nativeHome !== undefined && (name === 'node' || name === 'browser_engine');
    if (browserHome) this.assertBrowserHome(nativeHome!);
    else if (nativeHome !== undefined && (name !== 'bdpan' || realpathSync(nativeHome) !== realpathSync(this.#resources.path('baidu_home')))) throw new Error('原生账号 HOME 与宿主登记不一致。');
    let systemRoot: string | undefined;
    if (process.platform === 'win32') {
      try { systemRoot = this.fixedDirectory('system_root'); this.path('taskkill'); }
      catch { throw Object.assign(new Error('Windows 执行需要已核 system_root 和 taskkill 系统资源。'), { code: 'WINDOWS_PROCESS_CONTROL_UNBOUND' }); }
    }
    for (const root of ['cache', 'temp', 'downloads']) this.#resources.resolve(this.reference(root, id));
    const roots: { path: string; stat: import('node:fs').BigIntStats }[] = [];
    try {
    const temporary = this.directory('temp', id); roots.push({ path: temporary, stat: lstatSync(temporary, { bigint: true }) });
    const downloads = this.directory('downloads', id); roots.push({ path: downloads, stat: lstatSync(downloads, { bigint: true }) });
    const cache = this.directory('cache', name), home = this.directory('temp', `${id}/home`);
    const env: NodeJS.ProcessEnv = {
      // 只供明确登记程序的子依赖使用；从不继承宿主 PATH、代理或凭据环境。
      PATH: [...new Set([...this.#identities.keys()].flatMap(key => { try { return [dirname(this.path(key))]; } catch { return []; } }))].join(delimiter),
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME: nativeHome ?? home,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: this.directory('temp', `${id}/config`),
      XDG_DATA_HOME: this.directory('temp', `${id}/data`), XDG_STATE_HOME: this.directory('temp', `${id}/state`),
      XDG_DOWNLOAD_DIR: downloads, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: this.directory('cache', `${name}/python`),
    };
    // macOS 的默认钥匙串由真实 OS 用户 HOME 定位。只恢复此一系统上下文，
    // 不继承宿主环境；Chrome 的 --user-data-dir 仍由受信宿主固定到站点 profile。
    if (browserHome && name === 'browser_engine' && this.#nativeCaptureHomes.has(nativeHome!) && process.platform === 'darwin') env.HOME = userInfo().homedir;
    // 固定系统凭据入口同样需要真实用户钥匙串；普通工具继续使用独立临时 HOME。
    if (name === 'security' && process.platform === 'darwin') env.HOME = userInfo().homedir;
    if (systemRoot) Object.assign(env, { SystemRoot: systemRoot, WINDIR: systemRoot,
      USERPROFILE: nativeHome ?? home, APPDATA: env.XDG_CONFIG_HOME, LOCALAPPDATA: cache });
    if (browserHome) Object.assign(env, { USERPROFILE: nativeHome, BB_BROWSER_HOME: join(nativeHome!, '.bb-browser') });
    writeFileSync(join(temporary, 'process.json'), JSON.stringify({ version: 1, id, program: name, temporary, downloads, state: 'prepared' }) + '\n', { flag: 'wx', mode: 0o600 });
    const assertCurrent = () => {
      this.path(name);
      if (systemRoot) {
        if (this.fixedDirectory('system_root') !== systemRoot) throw new Error('Windows 系统资源身份已变化。');
        this.path('taskkill');
      }
      if (browserHome) this.assertBrowserHome(nativeHome!);
      for (const root of roots) {
        const reference = this.reference(root.path === temporary ? 'temp' : 'downloads', id);
        const path = this.#resources.resolve(reference), stat = lstatSync(path, { bigint: true });
        if (stat.dev !== root.stat.dev || stat.ino !== root.stat.ino || !stat.isDirectory()) throw new Error('本次临时目录身份已变化。');
      }
    };
    let processIdentity: { pid: number; startIdentity: string } | undefined;
    return { executable, env, temporary, downloads, assertCurrent,
      record: (state: string, process?: { pid: number; startIdentity: string }) => {
        assertCurrent();
        processIdentity = process ?? processIdentity;
        const marker = join(temporary, 'process.json'), stat = lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('进程记录已替换。');
        writeFileSync(marker, JSON.stringify({ version: 1, id, program: name, temporary, downloads, state, ...processIdentity }) + '\n');
      },
      cleanup: () => { assertCurrent(); for (const root of roots) rmSync(root.path, { recursive: true }); },
    };
    } catch (error) {
      for (const root of roots) {
        try {
          const stat = lstatSync(root.path, { bigint: true });
          const key = root.path === join(this.#resources.path('temp'), id) ? 'temp' : 'downloads';
          if (this.#resources.resolve(this.reference(key, id)) === root.path && stat.dev === root.stat.dev && stat.ino === root.stat.ino && stat.isDirectory()) rmSync(root.path, { recursive: true });
        } catch { /* 无法核对的临时目录保留，不沿陌生位置清理。 */ }
      }
      throw error;
    }
  }
}

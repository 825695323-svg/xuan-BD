import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import type { ResourceBindings, ResourceReference } from '../resources/bindings.js';
import { TEMPORARY_RETENTION_DAYS } from '../resources/temporary-retention.js';
import { CAPTURE_SOURCE_IDS } from '../../plugins/capture-sources/contracts.js';

const PROGRAMS = { open: 'open', mdfind: 'mdfind', shortcuts: 'shortcuts',
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', 'whisper-cli': 'whisper_cli', 'yt-dlp': 'yt_dlp', python3: 'python', bdpan: 'bdpan', security: 'security',
  node: 'node', 'polars-python': 'polars_python', browser_engine: 'browser_engine', taskkill: 'taskkill' } as const;
export type RegisteredProgramName = keyof typeof PROGRAMS;
type Identity = { path: string; canonical: string; device: bigint; inode: bigint; size: bigint; mtime: bigint; ctime: bigint };
type DirectoryIdentity = Pick<Identity, 'path' | 'canonical' | 'device' | 'inode'>;
// 个人与工作台共用进程暂存根；同进程内必须一起核对全部状态库引用。
const temporaryReferenceGuards = new Map<string, Map<string, (path: string) => boolean>>();

/** 仅受信宿主持有；位置登记不代替任务权限。无 PATH 搜索、安装或替代程序。 */
export class ProcessRuntime {
  readonly #identities = new Map<RegisteredProgramName, Identity>();
  readonly #directories = new Map<string, DirectoryIdentity>();
  readonly #captureHomes = new Map<string, DirectoryIdentity[]>();
  readonly #captureDirectories = new Map<string, DirectoryIdentity>();
  readonly #nativeCaptureHomes = new Set<string>();
  readonly #resources: ResourceBindings;
  #retentionTimer?: ReturnType<typeof setInterval>;

  constructor(resources: ResourceBindings) {
    this.#resources = resources;
    for (const name of Object.keys(PROGRAMS) as RegisteredProgramName[]) {
      try { this.#identities.set(name, this.inspect(name)); } catch { /* 未就绪能力单独不可用，不阻塞无关能力。 */ }
    }
    for (const name of ['system_root', 'browser_home']) {
      try { this.#directories.set(name, this.inspectDirectory(name)); } catch { /* 缺少专用资源时拒绝对应执行。 */ }
    }
  }
  /** 只清理已明确收束、记录到期时间且对象身份一致的进程暂存。 */
  registerTemporaryReferenceGuard(owner: string, guard: (path: string) => boolean) {
    const key = this.temporaryGuardKey();
    let guards = temporaryReferenceGuards.get(key);
    if (!guards) { guards = new Map(); temporaryReferenceGuards.set(key, guards); }
    guards.set(owner, guard);
    const path = this.temporaryOwnersPath();
    const existing = lstatSync(path, { throwIfNoEntry: false });
    const record = existing ? this.temporaryOwners() : { runtimeIdentity: this.#resources.document.runtimeIdentity,
      rootIdentity: this.#resources.document.resources.temp?.identity, rootObjects: this.temporaryRoots(), owners: [] as string[] };
    if (!record || existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) return;
    if (!record.owners.includes(owner)) {
      record.owners.push(owner); record.owners.sort();
      writeFileSync(path, JSON.stringify(record) + '\n', { flag: existing ? 'w' : 'wx', mode: 0o600 });
    }
  }
  hasTemporaryReference(path: string): boolean {
    try {
      const record = this.temporaryOwners(), guards = temporaryReferenceGuards.get(this.temporaryGuardKey());
      if (!record || !record.owners.length || !guards || record.owners.some(owner => !guards.has(owner))) return true;
      return record.owners.some(owner => guards.get(owner)!(path));
    } catch { return true; }
  }
  private temporaryRoots() {
    return Object.fromEntries((['temp', 'downloads'] as const).map(name => {
      const root = this.inspectDirectory(name);
      return [name, { path: root.path, identity: this.#resources.document.resources[name]?.identity,
        device: String(root.device), inode: String(root.inode) }];
    }));
  }
  private temporaryGuardKey(): string { return this.#resources.document.runtimeIdentity + ':' + JSON.stringify(this.temporaryRoots()); }
  private temporaryOwnersPath(): string {
    const digest = createHash('sha256').update(this.temporaryGuardKey()).digest('hex').slice(0, 24);
    return this.#resources.resolve(this.reference('temp', '.bd-temporary-owners-' + digest + '.json'));
  }
  private temporaryOwners(): { runtimeIdentity: string; rootIdentity: string; rootObjects: ReturnType<ProcessRuntime['temporaryRoots']>; owners: string[] } | null {
    try {
      const path = this.temporaryOwnersPath(), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) return null;
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return record.runtimeIdentity === this.#resources.document.runtimeIdentity && record.rootIdentity === this.#resources.document.resources.temp?.identity
        && JSON.stringify(record.rootObjects) === JSON.stringify(this.temporaryRoots())
        && Array.isArray(record.owners) && record.owners.every((owner: unknown) => typeof owner === 'string' && owner.length > 0) ? record : null;
    } catch { return null; }
  }
  startTemporaryRetention() {
    if (this.#retentionTimer) return;
    this.sweepTemporary();
    this.#retentionTimer = setInterval(() => { this.sweepTemporary(); }, 60 * 60 * 1000); this.#retentionTimer.unref();
  }
  closeTemporaryRetention() { if (this.#retentionTimer) clearInterval(this.#retentionTimer); this.#retentionTimer = undefined; }
  sweepTemporary(now = Date.now()): number {
    if (!this.temporaryOwners()) return 0;
    let names: string[];
    try { names = readdirSync(this.#resources.path('temp')).filter(name => /^[a-f0-9-]{36}$/u.test(name)).sort(); }
    catch { return 0; }
    let removed = 0;
    for (const id of names) {
      if (removed >= 200) break;
      try {
        const temporary = this.#resources.resolve(this.reference('temp', id)), downloads = this.#resources.resolve(this.reference('downloads', id));
        const marker = join(temporary, 'process.json'), markerStat = lstatSync(marker);
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 8192) continue;
        const record = JSON.parse(readFileSync(marker, 'utf8'));
        if (record.version !== 1 || record.runtimeIdentity !== this.#resources.document.runtimeIdentity
          || record.resourceIdentities?.temp !== this.#resources.document.resources.temp?.identity
          || record.resourceIdentities?.downloads !== this.#resources.document.resources.downloads?.identity
          || JSON.stringify(record.rootObjects) !== JSON.stringify(this.temporaryRoots())
          || record.id !== id || record.state !== 'released' || record.temporary !== temporary || record.downloads !== downloads
          || !Number.isSafeInteger(record.releasedAt) || record.expiresAt !== record.releasedAt + TEMPORARY_RETENTION_DAYS * 86400000 || record.expiresAt > now) continue;
        if (record.pid !== undefined) {
          if (!Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
          try { process.kill(record.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        }
        const roots = [['downloads', downloads], ['temp', temporary]] as const;
        if (roots.some(([, path]) => this.hasTemporaryReference(path))) continue;
        if (!roots.every(([key, path]) => { const stat = lstatSync(path, { bigint: true }); return stat.isDirectory() && !stat.isSymbolicLink()
          && realpathSync(path) === path && record.roots?.[key]?.device === String(stat.dev) && record.roots?.[key]?.inode === String(stat.ino); })) continue;
        for (const [key, path] of roots) {
          const stat = lstatSync(this.#resources.resolve(this.reference(key, id)), { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || record.roots[key].device !== String(stat.dev) || record.roots[key].inode !== String(stat.ino)) throw Error('暂存身份变化。');
          rmSync(path, { recursive: true });
        }
        removed++;
      } catch { /* 非本策略记录、占用、缺失或身份变化均保留，不按目录年龄猜测。 */ }
    }
    return removed;
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
    let currentState = 'prepared';
    return { executable, env, temporary, downloads, assertCurrent,
      record: (state: string, process?: { pid: number; startIdentity: string }) => {
        assertCurrent();
        processIdentity = process ?? processIdentity; currentState = state;
        const marker = join(temporary, 'process.json'), stat = lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('进程记录已替换。');
        writeFileSync(marker, JSON.stringify({ version: 1, id, program: name, temporary, downloads, state, ...processIdentity }) + '\n');
      },
      cleanup: () => {
        assertCurrent();
        if (currentState === 'unknown') throw Error('原进程收束未知，不能释放恢复现场。');
        const marker = join(temporary, 'process.json'), stat = lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('进程记录已替换。');
        const releasedAt = Date.now();
        writeFileSync(marker, JSON.stringify({ version: 1, id, program: name, temporary, downloads, state: 'released',
          runtimeIdentity: this.#resources.document.runtimeIdentity, rootObjects: this.temporaryRoots(), resourceIdentities: {
            temp: this.#resources.document.resources.temp?.identity, downloads: this.#resources.document.resources.downloads?.identity },
          ...processIdentity, releasedAt, expiresAt: releasedAt + TEMPORARY_RETENTION_DAYS * 86400000,
          roots: Object.fromEntries(roots.map(root => [root.path === temporary ? 'temp' : 'downloads',
            { device: String(root.stat.dev), inode: String(root.stat.ino) }])) }) + '\n');
      },
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

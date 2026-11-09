import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { startBrowserHost, type BrowserHost } from '../../platform/capabilities/browser/host.js';
import { readBrowserBoundFile } from '../../platform/capabilities/browser/sites.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';
import { inspectPath, samePathIdentity } from '../../platform/security/permissions.js';
import { CAPTURE_SOURCE_IDS, CAPTURE_SOURCES, type CaptureSessions, type CaptureSourceId, type CaptureBrowserConfiguration } from './contracts.js';
import { directFileVersion, directoryVersion } from '../../platform/plugins/direct-versions.js';

export type CaptureSessionState = 'first_use' | 'login_open' | 'saved' | 'public' | 'expired' | 'revoked' | 'unknown' | 'unavailable';
export type CaptureSessionMode = 'unselected' | 'authenticated' | 'public';
export interface CaptureSessionStatus {
  sourceId: CaptureSourceId; label: string; state: CaptureSessionState; mode: CaptureSessionMode;
  needsAttention: boolean; message: string; loginOpened: boolean; busy: boolean;
  savedAt?: string; lastCheckedAt?: string;
}
export interface CaptureSessionService extends CaptureSessions {
  list(): Promise<CaptureSessionStatus[]>;
  status(sourceId: string): Promise<CaptureSessionStatus>;
  markExpired(sourceId: CaptureSourceId): Promise<void>;
  openLogin(sourceId: string): Promise<CaptureSessionStatus>;
  saveLogin(sourceId: string): Promise<CaptureSessionStatus>;
  cancelLogin(sourceId: string): Promise<CaptureSessionStatus>;
  close(): Promise<void>;
}
export interface CaptureSessionOptions {
  processRuntime: ProcessRuntime; runtimeIdentity: string; homeRoot: string; daemonScript: string; daemonSha256: string;
  /** 各站点插件自己的日志目录根；写入 <logsRoot>/<sourceId>/logs/。 */
  logsRoot?: string;
}
interface RecordState {
  version: 1; runtimeIdentity: string; sourceId: CaptureSourceId; state: CaptureSessionState; mode: CaptureSessionMode;
  homeIdentity?: { device: string; inode: string }; savedAt?: string; lastCheckedAt?: string; expiresAt?: number;
}
interface LiveSession { host: BrowserHost; home: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
function fail(code: string, message: string, unknown = false): never { throw new DirectError(code, message, unknown); }
const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function withTimeout<T>(work: Promise<T>, ms: number, code = 'CAPTURE_LOGIN_TIMEOUT', message = '登录窗口无响应；请重新点加号打开登录页。'): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new DirectError(code, message)), ms))]);
}
function writeRunLog(root: string | undefined, id: CaptureSourceId, event: string, detail?: Record<string, unknown>): void {
  if (!root) return;
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({ at: new Date().toISOString(), sourceId: id, event, ...detail }) + '\n';
  const dir = join(root, id, 'logs');
  void mkdir(dir, { recursive: true }).then(() => appendFile(join(dir, `run-${day}.log`), line)).catch(() => {});
}
const SOURCES: Readonly<Record<CaptureSourceId, { domains: readonly string[]; names: readonly string[] }>> = {
  bilibili: { domains: ['bilibili.com'], names: ['SESSDATA'] },
  wechat: { domains: ['weixin.qq.com'], names: ['slave_sid', 'slave_user'] },
  xiaohongshu: { domains: ['xiaohongshu.com'], names: ['web_session'] },
  weibo: { domains: ['weibo.com', 'weibo.cn'], names: ['SUB'] },
  zhihu: { domains: ['zhihu.com'], names: ['z_c0'] },
  google: { domains: ['google.com'], names: ['SID', '__Secure-1PSID', '__Secure-3PSID'] },
  // 东方财富两项读取公开股吧文本；未登记可核对的登录凭据，不自动改变既有采集模式。
  eastmoney: { domains: ['eastmoney.com'], names: ['ut', 'ct'] },
  xueqiu: { domains: ['xueqiu.com'], names: ['xq_a_token'] },
  // 抖音、百度只读公开热榜，不登记登录凭据。
  douyin: { domains: ['douyin.com', 'iesdouyin.com'], names: [] },
  baidu: { domains: ['baidu.com'], names: [] },
  sogouwechat: { domains: ['weixin.sogou.com'], names: [] },
};
const PUBLIC_SOURCES: ReadonlySet<CaptureSourceId> = new Set(CAPTURE_SOURCE_IDS.filter(id => !CAPTURE_SOURCES[id].loginRequired));
/** 公开采集站没有登录态：首次使用与未确认都按公开模式呈现。 */
const publicize = (id: CaptureSourceId, value: RecordState): RecordState =>
  PUBLIC_SOURCES.has(id) && ['first_use', 'unknown', 'login_open'].includes(value.state) ? { ...value, state: 'public', mode: 'public' } : value;
const LOGIN_URLS: Readonly<Record<CaptureSourceId, string>> = {
  bilibili: 'https://www.bilibili.com/', wechat: 'https://mp.weixin.qq.com/', xiaohongshu: 'https://www.xiaohongshu.com/',
  weibo: 'https://weibo.com/login.php', zhihu: 'https://www.zhihu.com/signin', google: 'https://accounts.google.com/ServiceLogin',
  eastmoney: 'https://passport2.eastmoney.com/pub/login?backurl=https%3A%2F%2Fguba.eastmoney.com%2F', xueqiu: 'https://xueqiu.com/',
  douyin: 'https://www.douyin.com/', baidu: 'https://www.baidu.com/', sogouwechat: 'https://weixin.sogou.com/',
};
function sourceId(value: string): CaptureSourceId {
  if (!CAPTURE_SOURCE_IDS.includes(value as CaptureSourceId)) fail('CAPTURE_SOURCE_INVALID', '采集源未登记。');
  return value as CaptureSourceId;
}
function validTime(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function display(record: RecordState, busy: boolean): CaptureSessionStatus {
  const messages: Record<CaptureSessionState, string> = {
    first_use: '尚未保存本站登录态；点加号打开登录页，登录后点勾号保存。',
    login_open: '登录窗口已打开；完成登录后点勾号保存登录态。',
    saved: '已保存本站登录态；采集仍核对当前凭据、权限及站点实际响应。',
    public: '当前只按公开内容采集；需要登录的内容仍会阻断。',
    expired: '本站登录态已失效或无法读回；点加号重新登录并保存。',
    revoked: '本站登录态已撤销；点加号重新登录并保存。',
    unknown: '浏览器关闭、目录身份或保存状态未能确认；已停止复用并保留现场，刷新只重新读取状态。',
    unavailable: '本站专属浏览器资源当前不可用；未改用日常浏览器、其他账号目录或外部守护进程。',
  };
  return { sourceId: record.sourceId, label: CAPTURE_SOURCES[record.sourceId].label, state: record.state, mode: record.mode,
    needsAttention: !['saved', 'public'].includes(record.state), message: messages[record.state], loginOpened: false, busy,
    ...(record.savedAt ? { savedAt: record.savedAt } : {}), ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}) };
}

/** 构造、list/status（列表/状态）不建目录、不启动浏览器、不读取 Cookie（登录凭据）。
 * 登录态控制已撤除；仅按既有模式运行固定采集脚本并记录实际失效或未知状态。
 */
export function createCaptureSessionService(options: CaptureSessionOptions): CaptureSessionService {
  const runtime = options.processRuntime, live = new Map<CaptureSourceId, LiveSession>(), busy = new Set<CaptureSourceId>();
  const cached = new Map<CaptureSourceId, RecordState>(), cleanups = new Map<CaptureSourceId, () => Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined;
  const homeFor = (id: CaptureSourceId) => {
    runtime.assertBrowserHome(options.homeRoot);
    return runtime.captureBrowserHomePath(id, options.runtimeIdentity);
  };
  const metadataFor = (id: CaptureSourceId) => join(dirname(homeFor(id)), `.${id}.session.json`);
  const empty = (id: CaptureSourceId): RecordState => ({ version: 1, runtimeIdentity: options.runtimeIdentity, sourceId: id, state: 'first_use', mode: 'unselected' });
  const assertHome = (id: CaptureSourceId) => { const home = homeFor(id); runtime.assertBrowserHome(home); return home; };
  const readState = async (id: CaptureSourceId): Promise<RecordState> => {
    const asPublic = (value: RecordState): RecordState => PUBLIC_SOURCES.has(id) && ['first_use', 'unknown'].includes(value.state) ? { ...value, state: 'public', mode: 'public' } : value;
    if (cached.has(id)) {
      const current = cached.get(id)!;
      if (current.state === 'saved' && (!current.expiresAt || current.expiresAt <= Date.now() / 1000)) {
        const expired: RecordState = { ...current, state: 'expired' }; cached.set(id, expired); return expired;
      }
      return asPublic(current);
    }
    let record = empty(id);
    try {
      const observedHome = inspectPath(homeFor(id), { allowMissing: true });
      if (observedHome.links.length || (observedHome.object && observedHome.object.kind !== 'directory')) throw new Error('session home is not ordinary');
      const path = metadataFor(id);
      if (exists(path)) {
        const value: unknown = JSON.parse((await readBrowserBoundFile(path, 16_000)).toString('utf8'));
        if (!object(value) || value.version !== 1 || value.runtimeIdentity !== options.runtimeIdentity || value.sourceId !== id
          || !['first_use', 'login_open', 'saved', 'public', 'expired', 'revoked', 'unknown', 'unavailable'].includes(String(value.state))
          || !['unselected', 'authenticated', 'public'].includes(String(value.mode))
          || (value.state === 'saved' && value.mode !== 'authenticated') || (value.state === 'public' && value.mode !== 'public')
          || Object.keys(value).some(key => !['version', 'runtimeIdentity', 'sourceId', 'state', 'mode', 'homeIdentity', 'savedAt', 'lastCheckedAt', 'expiresAt'].includes(key))
          || (value.savedAt !== undefined && !validTime(value.savedAt)) || (value.lastCheckedAt !== undefined && !validTime(value.lastCheckedAt))
          || (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)))
          || !object(value.homeIdentity) || typeof value.homeIdentity.device !== 'string' || typeof value.homeIdentity.inode !== 'string') throw new Error('invalid session metadata');
        record = value as unknown as RecordState;
        const home = inspectPath(homeFor(id));
        if (home.links.length || home.object?.kind !== 'directory' || home.object.device !== record.homeIdentity!.device || home.object.inode !== record.homeIdentity!.inode) throw new Error('session home changed');
        if (record.state === 'login_open') record = { ...record, state: 'unknown' };
        if (record.state === 'saved' && (!record.expiresAt || record.expiresAt <= Date.now() / 1000)) record = { ...record, state: 'expired' };
      }
      if (['.harness-browser-owner.json', '.harness-browser.lock'].some(name => exists(join(homeFor(id), name)))) record = { ...record, state: 'unknown' };
      const ownerPath = join(homeFor(id), '.bd-browser-owner.json');
      if (exists(ownerPath) && !live.has(id)) {
        const owner: unknown = JSON.parse((await readBrowserBoundFile(ownerPath, 16_000)).toString('utf8'));
        if (!object(owner) || owner.application !== 'xuan-bd-browser' || owner.runtimeIdentity !== options.runtimeIdentity || owner.homeRoot !== homeFor(id) || owner.state !== 'stopped'
          || exists(join(homeFor(id), '.bd-browser.lock'))) record = { ...record, state: 'unknown' };
      }
    } catch { record = { ...empty(id), state: 'unknown' }; }
    const resolved = asPublic(record); cached.set(id, resolved); return resolved;
  };
  const save = async (id: CaptureSourceId, update: Partial<RecordState>): Promise<RecordState> => {
    const home = assertHome(id), identity = inspectPath(home).object;
    if (identity?.kind !== 'directory') fail('CAPTURE_SESSION_UNKNOWN', '本站专属目录身份未能确认。', true);
    const record: RecordState = { ...(await readState(id)), ...update, version: 1, runtimeIdentity: options.runtimeIdentity, sourceId: id,
      homeIdentity: { device: identity.device, inode: identity.inode } };
    const path = metadataFor(id), temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    runtime.assertBrowserHome(home); await rename(temporary, path); cached.set(id, record); return record;
  };
  const getStatus = async (id: CaptureSourceId) => ({ ...display(await readState(id), busy.has(id)), loginOpened: live.has(id) });
  const rememberIssue = async (id: CaptureSourceId, state: 'unknown' | 'unavailable') => {
    const update = { state, lastCheckedAt: new Date().toISOString() };
    cached.set(id, { ...(await readState(id)), ...update });
    try { await save(id, update); } catch { /* 目录身份变化时不沿未知位置写入；内存和原owner继续阻断复用。 */ }
  };
  const exclusive = <T>(id: CaptureSourceId, operation: () => Promise<T>): Promise<T> => {
    if (closed) fail('CAPTURE_SESSION_UNAVAILABLE', '采集源会话服务已关闭。');
    if (busy.has(id)) fail('CAPTURE_SESSION_BUSY', '本站正在采集，请等待本次操作结束。');
    busy.add(id);
    const work = Promise.resolve().then(operation).finally(() => { busy.delete(id); });
    inFlight.add(work); void work.then(() => inFlight.delete(work), () => inFlight.delete(work)); return work;
  };
  const start = async (id: CaptureSourceId): Promise<LiveSession> => {
    if (closed) fail('CAPTURE_SESSION_UNAVAILABLE', '采集源会话服务正在关闭，未再启动浏览器。');
    if ((await readState(id)).state === 'unknown') fail('CAPTURE_SESSION_UNKNOWN', '本站原目录或浏览器关闭状态未确认，未重开其他身份。', true);
    const current = live.get(id);
    if (current) return current;
    try {
      const home = runtime.registerCaptureBrowserHome(id, options.runtimeIdentity);
      const host = await startBrowserHost({ ...options, homeRoot: home, headless: true, nativeSession: true, interceptOnlyNetwork: true,
        onCleanupAvailable: shutdown => { cleanups.set(id, shutdown); } });
      const entry = { host, home }; live.set(id, entry); return entry;
    } catch (error) {
      const unknown = !(error instanceof DirectError) || error.unknown || ['BROWSER_OWNER_UNCONFIRMED', 'BROWSER_HOST_BINDING_CHANGED', 'BROWSER_HOST_BINDING_INVALID'].includes(error.code);
      await rememberIssue(id, unknown ? 'unknown' : 'unavailable');
      fail(unknown ? 'CAPTURE_SESSION_UNKNOWN' : 'CAPTURE_SESSION_UNAVAILABLE', unknown ? '本站原目录或浏览器关闭状态未确认，保留现场等待核对。' : '本站独立浏览器资源未就绪。', unknown);
    }
  };
  const stop = async (id: CaptureSourceId): Promise<void> => {
    const cleanup = cleanups.get(id);
    if (cleanup) {
      try { await cleanup(); }
      catch { await rememberIssue(id, 'unknown'); fail('CAPTURE_SESSION_UNKNOWN', '本站浏览器关闭未确认；保留原现场且不自动重开。', true); }
      live.delete(id); cleanups.delete(id);
    }
  };
  const protocol = async <T>(id: CaptureSourceId, entry: LiveSession, operation: (send: Send) => Promise<T>, assertAuthorized: () => void = () => {}): Promise<T> => {
    const configuration = entry.host.configuration, binding = inspectPath(configuration.daemonConfigPath);
    const assertCurrent = () => {
      assertAuthorized(); runtime.assertBrowserHome(entry.home);
      if (live.get(id) !== entry || !samePathIdentity(binding, inspectPath(configuration.daemonConfigPath), true)) fail('CAPTURE_SESSION_UNKNOWN', '本站浏览器原连接身份已变化。', true);
    };
    assertCurrent();
    const daemon: unknown = JSON.parse((await readBrowserBoundFile(configuration.daemonConfigPath, 32_000)).toString('utf8'));
    if (!object(daemon) || daemon.pid !== entry.host.daemonPid || daemon.cdpHost !== '127.0.0.1' || !Number.isSafeInteger(daemon.cdpPort)) fail('CAPTURE_SESSION_UNKNOWN', '本站原生浏览器连接无法核对。', true);
    const info = await loopbackVersion(Number(daemon.cdpPort)); assertCurrent();
    const prefix = `ws://127.0.0.1:${daemon.cdpPort}/devtools/browser/`;
    if (!object(info) || typeof info.webSocketDebuggerUrl !== 'string' || !info.webSocketDebuggerUrl.startsWith(prefix)
      || !/^[a-zA-Z0-9-]+$/u.test(info.webSocketDebuggerUrl.slice(prefix.length))) fail('CAPTURE_SESSION_UNKNOWN', '本站原生浏览器端点无法核对。', true);
    return useProtocol(info.webSocketDebuggerUrl, assertCurrent, operation);
  };
  const observe = (id: CaptureSourceId, entry: LiveSession) => protocol(id, entry, async send => {
    const result = await send('Storage.getCookies');
    if (!Array.isArray(result.cookies) || result.cookies.length > 4096) fail('CAPTURE_SESSION_UNKNOWN', '本站登录存储未返回可核对状态。', true);
    const now = Date.now() / 1000, scope = SOURCES[id];
    // Cookie 值仅停留此调用内存以核对既有凭据；不落 metadata、日志、任务或模型结果。
    const credentials = result.cookies.filter((cookie: unknown): cookie is { domain: string; name: string; value: string; path: string; expires: number } => {
      if (!object(cookie) || typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
        || cookie.value.length === 0 || typeof cookie.path !== 'string' || typeof cookie.expires !== 'number' || cookie.expires <= now
        || cookie.session === true || !scope.names.includes(cookie.name)) return false;
      const domain = cookie.domain;
      return scope.domains.some(base => domain === base || domain === '.' + base || domain.endsWith('.' + base));
    });
    return { present: credentials.length > 0, expiresAt: credentials.length ? Math.min(...credentials.map(cookie => cookie.expires)) : undefined };
  });
  return {
    list: () => Promise.all(CAPTURE_SOURCE_IDS.map(id => getStatus(id))),
    status: async value => getStatus(sourceId(value)),
    dependencyVersion(id) {
      sourceId(id);
      const path = metadataFor(id);
      let persisted = empty(id);
      if (exists(path)) {
        const identity = inspectPath(path);
        const before = lstatSync(path, { bigint: true });
        if (identity.links.length || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16_000n) fail('CAPTURE_SESSION_CHANGED', '本站会话元数据需要有界普通文件，未读取链接或异常对象。');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const current = fstatSync(fd, { bigint: true });
          if (current.dev !== before.dev || current.ino !== before.ino || current.ctimeNs !== before.ctimeNs || current.size !== before.size) fail('CAPTURE_SESSION_CHANGED', '本站会话元数据在读取前改变。');
          const buffer = Buffer.alloc(16_001); let length = 0;
          while (length < buffer.length) { const bytes = readSync(fd, buffer, length, buffer.length - length, null); if (!bytes) break; length += bytes; }
          if (length > 16_000) fail('CAPTURE_SESSION_CHANGED', '本站会话元数据读取中超过大小界限。');
          const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8')), after = lstatSync(path, { bigint: true });
          if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || after.size !== before.size
            || !object(value) || value.version !== 1 || value.runtimeIdentity !== options.runtimeIdentity || value.sourceId !== id
            || !['unselected', 'authenticated', 'public'].includes(String(value.mode))
            || !object(value.homeIdentity) || typeof value.homeIdentity.device !== 'string' || typeof value.homeIdentity.inode !== 'string'
            || value.savedAt !== undefined && !validTime(value.savedAt)) fail('CAPTURE_SESSION_CHANGED', '本站会话元数据身份、模式或读取版本无效。');
          persisted = value as unknown as RecordState;
        } finally { closeSync(fd); }
      }
      const home = inspectPath(homeFor(id), { allowMissing: true });
      if (home.links.length || home.object && home.object.kind !== 'directory'
        || persisted.homeIdentity && (home.object?.device !== persisted.homeIdentity.device || home.object.inode !== persisted.homeIdentity.inode)) fail('CAPTURE_SESSION_CHANGED', '本站原专属目录身份已变化，未绑定替代目录。');
      const project = (record: RecordState) => ({ runtimeIdentity: record.runtimeIdentity, sourceId: record.sourceId,
        mode: record.mode, savedAt: record.savedAt ?? null, homeIdentity: record.homeIdentity ?? null });
      if (cached.has(id) && JSON.stringify(project(cached.get(id)!)) !== JSON.stringify(project(publicize(id, persisted)))) fail('CAPTURE_SESSION_CHANGED', '本站持久模式与已装配会话不同，请核对后重启。');
      const daemon = directFileVersion(options.daemonScript);
      if (daemon.sha256 !== options.daemonSha256) fail('CAPTURE_SESSION_CHANGED', '本站守护程序与原登记摘要不同。');
      return { session: project(persisted), sourceHome: home.object ? { path: home.canonicalPath, device: home.object.device, inode: home.object.inode } : null,
        browserHome: directoryVersion(options.homeRoot), daemon };
    },
    availability(id) {
      try { sourceId(id); homeFor(id); runtime.path('node'); runtime.path('browser_engine'); if (closed) throw new Error('closed');
        return { available: true }; }
      catch { return { available: false, reason: '本站独立浏览器程序、运行身份或专用目录当前不可用。' }; }
    },
    openLogin: (value: string) => exclusive(sourceId(value), async () => {
      const id = sourceId(value);
      // 登录窗口是用户显式动作：已有 login_open/unknown 等未完成状态时允许重开同一独立目录。
      await stop(id);
      const home = runtime.registerCaptureBrowserHome(id, options.runtimeIdentity);
      const host = await startBrowserHost({ ...options, homeRoot: home, headless: false, nativeSession: true,
        onCleanupAvailable: shutdown => { cleanups.set(id, shutdown); } });
      const entry: LiveSession = { host, home };
      live.set(id, entry);
      try {
        await protocol(id, entry, send => send('Target.createTarget', { url: LOGIN_URLS[id] }));
        await save(id, { state: 'login_open' });
        writeRunLog(options.logsRoot, id, 'login_open', { url: LOGIN_URLS[id] });
      } catch (error) { await stop(id); throw error; }
      return getStatus(id);
    }),
    saveLogin: (value: string) => exclusive(sourceId(value), async () => {
      const id = sourceId(value);
      const entry = live.get(id);
      if (!entry) fail('CAPTURE_LOGIN_CLOSED', '登录窗口未打开；请先点加号打开登录页。');
      try {
        if (!alive(entry.host.enginePid)) fail('CAPTURE_LOGIN_CLOSED', '登录窗口已被关闭；请重新点加号打开登录页。');
        const observed = await withTimeout(observe(id, entry), 12_000);
        if (!observed.present) fail('CAPTURE_LOGIN_REQUIRED', '未检测到本站登录凭据；请在打开的窗口完成登录后再点勾号。');
        await save(id, { state: 'saved', mode: 'authenticated', savedAt: new Date().toISOString(), ...(observed.expiresAt ? { expiresAt: observed.expiresAt } : {}) });
        writeRunLog(options.logsRoot, id, 'login_saved', { expiresAt: observed.expiresAt ?? null });
      } catch (error) {
        writeRunLog(options.logsRoot, id, 'login_save_failed', { code: error instanceof DirectError ? error.code : 'unknown' });
        throw error instanceof DirectError && error.code === 'CAPTURE_SESSION_UNKNOWN'
          ? new DirectError('CAPTURE_LOGIN_CLOSED', '登录窗口已关闭或连接中断；请重新点加号打开登录页。') : error;
      } finally {
        try { await withTimeout(stop(id), 5_000, 'CAPTURE_LOGIN_STOPPED', '登录窗口关闭未能确认。'); }
        catch { live.delete(id); cleanups.delete(id); }
      }
      return getStatus(id);
    }),
    cancelLogin: (value: string) => exclusive(sourceId(value), async () => { const id = sourceId(value); await stop(id); writeRunLog(options.logsRoot, id, 'login_cancelled'); return getStatus(id); }),
    markExpired: async id => exclusive(sourceId(id), async () => {
      if ((await readState(id)).state === 'saved') await save(id, { state: 'expired', lastCheckedAt: new Date().toISOString() });
    }),
    async withCaptureSession<T>(id: CaptureSourceId, context: TaskExecutionContext, operation: (configuration: CaptureBrowserConfiguration, assertCurrent: () => void) => Promise<T>): Promise<T> {
      sourceId(id);
      return exclusive(id, async () => {
        context.signal.throwIfAborted();
        const record = await readState(id);
        if (!['saved', 'public'].includes(record.state)) fail(record.state === 'unknown' ? 'CAPTURE_SESSION_UNKNOWN' : 'CAPTURE_LOGIN_REQUIRED', `${CAPTURE_SOURCES[id].label}登录态未就绪或待核；请先保存登录态，未自动登录或重放任务。`, record.state === 'unknown');
        const entry = await start(id);
        const assertCurrent = () => { context.signal.throwIfAborted(); runtime.assertBrowserHome(entry.home);
          if (live.get(id) !== entry || closed) fail('CAPTURE_SESSION_UNKNOWN', '本站采集原浏览器身份已变化。', true); };
        try {
          if (record.state === 'saved' && !(await observe(id, entry)).present) {
            await save(id, { state: 'expired', lastCheckedAt: new Date().toISOString() }); fail('CAPTURE_LOGIN_REQUIRED', `${CAPTURE_SOURCES[id].label}保存的登录态已到期或无法读回；请重新登录并保存。`);
          }
          assertCurrent(); return await operation({ ...entry.host.configuration, networkIsolation: 'intercept-only-proxy' }, assertCurrent);
        } catch (error) {
          if (record.state === 'saved' && error instanceof DirectError && error.code === 'CAPTURE_LOGIN_EXPIRED') await save(id, { state: 'expired', lastCheckedAt: new Date().toISOString() });
          throw error;
        } finally { await stop(id); }
      });
    },
    close() { return closing ??= (async () => {
      closed = true; await Promise.allSettled([...inFlight]);
      const results = await Promise.allSettled([...cleanups.keys()].map(id => stop(id)));
      if (results.some(result => result.status === 'rejected')) fail('CAPTURE_SESSION_UNKNOWN', '部分采集源浏览器关闭未确认，原现场已保留。', true);
    })(); },
  };
}

type Send = (method: 'Storage.getCookies' | 'Target.createTarget', params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
function loopbackVersion(port: number): Promise<unknown> {
  return new Promise((done, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const req = request({ hostname: '127.0.0.1', port, path: '/json/version', method: 'GET' }, res => {
      res.on('data', chunk => { if ((bytes += chunk.length) > 32_000) req.destroy(); else chunks.push(Buffer.from(chunk)); });
      res.once('aborted', () => reject(new DirectError('CAPTURE_SESSION_UNKNOWN', '本站浏览器就绪响应中断。', true)));
      res.once('error', () => reject(new DirectError('CAPTURE_SESSION_UNKNOWN', '本站浏览器就绪响应失败。', true)));
      res.once('end', () => { try { if (res.statusCode !== 200) throw new Error('status'); done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new DirectError('CAPTURE_SESSION_UNKNOWN', '本站浏览器就绪响应无法核对。', true)); } });
    });
    req.setTimeout(2000, () => req.destroy()); req.once('error', () => reject(new DirectError('CAPTURE_SESSION_UNKNOWN', '本站浏览器原连接未响应。', true))); req.end();
  });
}
async function useProtocol<T>(url: string, assertCurrent: () => void, operation: (send: Send) => Promise<T>): Promise<T> {
  const socket = new WebSocket(url); let sequence = 0;
  const pending = new Map<number, { done(value: Record<string, unknown>): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const error = () => new DirectError('CAPTURE_SESSION_UNKNOWN', '本站浏览器原命令未能确认；不切换账号或其他连接。', true);
  const rejectPending = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error()); } pending.clear(); };
  try {
    await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(error()), 2500);
      socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(error()); }, { once: true }); });
    socket.addEventListener('message', event => {
      if (String(event.data).length > 2 * 1024 * 1024) { rejectPending(); socket.close(); return; }
      try { const value: unknown = JSON.parse(String(event.data)); if (!object(value) || typeof value.id !== 'number') return;
        const call = pending.get(value.id); if (!call) return; clearTimeout(call.timer); pending.delete(value.id);
        try { assertCurrent(); if (value.error || !object(value.result)) throw error(); call.done(value.result); } catch { call.reject(error()); }
      } catch { rejectPending(); }
    });
    socket.addEventListener('error', rejectPending); socket.addEventListener('close', rejectPending);
    const send: Send = (method, params = {}) => new Promise((done, reject) => {
      try { assertCurrent(); if (socket.readyState !== WebSocket.OPEN) throw error(); }
      catch { reject(error()); return; }
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(error()); }, 5000);
      pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    return await operation(send);
  } finally { rejectPending(); socket.close(); }
}

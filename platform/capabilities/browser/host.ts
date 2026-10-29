import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProcessRuntime } from '../../runtime/programs.js';
import { startRegisteredService } from '../../runtime/process.js';
import { DirectError } from '../../runtime/file-workspace.js';
import { inspectPath, samePathIdentity } from '../../security/permissions.js';
import { readBrowserBoundFile } from './sites.js';
import type { BrowserConfiguration } from './index.js';

export interface BrowserHostOptions {
  processRuntime: ProcessRuntime;
  runtimeIdentity: string;
  /** 必须是宿主已登记的独立 owned browser_home；不能是全局浏览器目录。 */
  homeRoot: string;
  daemonScript: string;
  daemonSha256: string;
  /** 兼容旧宿主参数，不读取、不复制、不启用站点脚本。 */
  adapterSourceRoot?: string;
  headless?: boolean;
  /** 仅采集源独立 HOME：使用浏览器原生凭据保护，并经协议关闭后核对退出。 */
  nativeSession?: boolean;
  /** 仅固定脚本采集宿主：浏览器直连统一拒绝，内容仅由受控拦截回填。 */
  interceptOnlyNetwork?: boolean;
  startupTimeoutMs?: number;
  /** 起任何子进程前交给可信宿主保管；就绪失败也不能丢失未确认关闭的所有权。 */
  onCleanupAvailable?(shutdown: () => Promise<void>): void;
}
export interface BrowserHost {
  configuration: BrowserConfiguration;
  enginePid: number;
  daemonPid: number;
  shutdown(): Promise<void>;
}
interface Owner {
  version: 1; application: 'xuan-harness-browser'; runtimeIdentity: string; homeRoot: string; profileRoot: string;
  nonce: string; state: 'starting' | 'ready' | 'stopped' | 'unknown';
  enginePid?: number; daemonPid?: number; portFileSha256?: string; daemonFileSha256?: string;
}
type Service = ReturnType<typeof startRegisteredService>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });

/** 固定随包程序与独立状态；不调用 bb-browser 的自动启动、下载或遗留进程接管入口。 */
export async function startBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const { processRuntime: runtime, homeRoot, daemonScript, runtimeIdentity } = options;
  if (![homeRoot, daemonScript].every(path => isAbsolute(path) && resolve(path) === path && !/[\u0000-\u001f]/u.test(path))
    || !runtimeIdentity || !/^[a-f0-9]{64}$/u.test(options.daemonSha256)
    || (options.interceptOnlyNetwork && (!options.nativeSession || !options.headless))) throw new DirectError('BROWSER_HOST_BINDING_INVALID', '内置浏览器需要明确的程序、源码摘要、独立状态身份和匹配的采集网络模式。');
  const timeout = options.startupTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 60_000) throw new DirectError('BROWSER_HOST_BINDING_INVALID', '浏览器启动核验预算无效。');
  const homeIdentity = inspectPath(homeRoot), scriptIdentity = inspectPath(daemonScript);
  if (homeIdentity.links.length || homeIdentity.object?.kind !== 'directory' || scriptIdentity.links.length || scriptIdentity.object?.kind !== 'file'
    || digest(await readBrowserBoundFile(daemonScript, 4 * 1024 * 1024)) !== options.daemonSha256) throw new DirectError('BROWSER_HOST_BINDING_INVALID', '内置浏览器程序或专用状态根无法核对。');
  const assertCurrent = () => {
    if (!samePathIdentity(homeIdentity, inspectPath(homeRoot)) || !samePathIdentity(scriptIdentity, inspectPath(daemonScript), true)) {
      throw new DirectError('BROWSER_HOST_BINDING_CHANGED', '本次浏览器程序或独立状态根已变化。');
    }
    try { runtime.path('node'); runtime.path('browser_engine'); runtime.assertBrowserHome(homeRoot); }
    catch { throw new DirectError('BROWSER_PROGRAM_UNAVAILABLE', '随包浏览器引擎或 Node 程序缺失、被替换或尚未登记。'); }
  };
  assertCurrent();
  if (options.nativeSession) {
    try { runtime.enableNativeCaptureCredentials(homeRoot); }
    catch { throw new DirectError('BROWSER_HOST_BINDING_INVALID', '登录态仅供本运行身份下已登记的独立采集源目录使用。'); }
  }
  const profileRoot = join(homeRoot, 'profile'), bbRoot = join(homeRoot, '.bb-browser');
  const configuration: BrowserConfiguration = { daemonConfigPath: join(bbRoot, 'daemon.json'), adapterRoot: join(bbRoot, 'bb-sites'), privateRoot: join(bbRoot, 'sites') };
  const portFile = join(profileRoot, 'DevToolsActivePort'), ownerPath = join(homeRoot, '.harness-browser-owner.json'), lockPath = join(homeRoot, '.harness-browser.lock');
  let previous: Owner | undefined;
  if (exists(ownerPath)) {
    let value: unknown;
    try { value = JSON.parse((await readBrowserBoundFile(ownerPath, 16_000)).toString('utf8')); }
    catch { throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器原所有者记录无法核对；未读取其他配置或接管进程。'); }
    if (!object(value) || value.version !== 1 || value.application !== 'xuan-harness-browser' || value.runtimeIdentity !== runtimeIdentity
      || value.homeRoot !== homeRoot || value.profileRoot !== profileRoot || value.state !== 'stopped' || typeof value.nonce !== 'string') {
      throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '独立浏览器原所有者或停止状态未确认；未接管、停止或删除遗留现场。');
    }
    previous = value as unknown as Owner;
  } else if ((await readdir(homeRoot)).length) throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器专用根已有未知内容，未复制或接管既有账号与配置。');
  // 旧 daemon.json 会令上游主动 shutdown/SIGKILL 指向的 PID；只移除原自有且已确认停止的同摘要残留。
  for (const [path, expected] of [[configuration.daemonConfigPath, previous?.daemonFileSha256], [portFile, previous?.portFileSha256]] as const) {
    if (exists(path) && (!previous || !expected || digest(await readBrowserBoundFile(path, 32_000)) !== expected)) {
      throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器发现记录无法归属于已确认停止的原宿主；未让上游处理遗留进程。');
    }
  }
  if (exists(join(bbRoot, 'browser'))) throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '检测到非本宿主管理的浏览器发现目录，未启用端口回退或接管。');
  const nonce = randomUUID(), lockBody = JSON.stringify({ version: 1, runtimeIdentity, nonce, pid: process.pid });
  try { await writeFile(lockPath, lockBody, { flag: 'wx', mode: 0o600 }); }
  catch { throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器专用根仍有所有者锁；不按进程编号或时间自动抢占。'); }
  const lockIdentity = inspectPath(lockPath);
  let owner: Owner = { version: 1, application: 'xuan-harness-browser', runtimeIdentity, homeRoot, profileRoot, nonce, state: 'starting' };
  let engine: Service | undefined, daemon: Service | undefined, shutdownDone: Promise<void> | undefined, ownedBrowserSocket: string | undefined;
  const saveOwner = async () => {
    assertCurrent();
    const temporary = join(homeRoot, '.harness-browser-owner-' + nonce + '.tmp');
    await writeFile(temporary, JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, ownerPath);
  };
  const snapshotDiscovery = async () => {
    if (exists(portFile)) owner.portFileSha256 = digest(await readBrowserBoundFile(portFile, 32_000));
    if (exists(configuration.daemonConfigPath)) {
      const bytes = await readBrowserBoundFile(configuration.daemonConfigPath, 32_000), info: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(info) || info.pid !== daemon?.pid) throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器守护记录不属于本次子进程，现场需要核对。', true);
      owner.daemonFileSha256 = digest(bytes);
    }
  };
  const shutdown = () => shutdownDone ??= (async () => {
    const errors: unknown[] = [];
    if (daemon) try { await daemon.shutdown(); } catch (error) { errors.push(error); }
    if (options.nativeSession && engine && !engine.exited && ownedBrowserSocket) {
      try {
        assertCurrent(); await closeOwnedBrowser(ownedBrowserSocket);
        const deadline = Date.now() + 5000;
        while (!engine.exited && Date.now() < deadline) await new Promise(done => setTimeout(done, 40));
        if (!engine.exited) throw new Error('native browser exit unconfirmed');
      } catch (error) { errors.push(error); }
    }
    if (engine) try { await engine.shutdown(); } catch (error) { errors.push(error); }
    try { await snapshotDiscovery(); } catch (error) { errors.push(error); }
    owner.state = errors.length ? 'unknown' : 'stopped';
    try { await saveOwner(); } catch (error) { errors.push(error); }
    if (!errors.length) {
      if (!samePathIdentity(lockIdentity, inspectPath(lockPath), true) || (await readBrowserBoundFile(lockPath, 4096)).toString('utf8') !== lockBody) errors.push(new Error('owner lock changed'));
      else await unlink(lockPath);
    }
    if (errors.length) throw new DirectError('BROWSER_SHUTDOWN_UNKNOWN', '内置浏览器自有进程或状态收束未确认；保留所有者记录等待核对。', true);
  })();
  try {
    options.onCleanupAvailable?.(shutdown);
    await saveOwner();
    for (const [path, expected] of [[configuration.daemonConfigPath, previous?.daemonFileSha256], [portFile, previous?.portFileSha256]] as const) if (exists(path)) {
      if (!expected || digest(await readBrowserBoundFile(path, 32_000)) !== expected) throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '原发现记录在本次启动前已变化，未删除或交给上游处理。');
      await unlink(path);
    }
    await ordinaryDirectory(profileRoot); await ordinaryDirectory(bbRoot);
    assertCurrent();
    // 上游可能查看此目录以回退其他 CDP 端口；本宿主从不生成或接受该目录。
    if (exists(configuration.daemonConfigPath) || exists(join(bbRoot, 'browser'))) throw new DirectError('BROWSER_OWNER_UNCONFIRMED', '浏览器启动前发现了其他守护记录。');
    const engineArgs = ['--user-data-dir=' + profileRoot, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-component-update',
      '--disable-background-networking', ...(!options.nativeSession ? ['--password-store=basic'] : []),
      // 隔离 HOME 的工具浏览器使用模拟的本地数据加密密钥；采集登录态仍使用原生保护。
      // 模拟钥匙串使用公开测试密钥，不能用于保管账号凭据。
      ...(process.platform === 'darwin' && !options.nativeSession ? ['--use-mock-keychain'] : []),
      ...(options.interceptOnlyNetwork ? ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
      ...(options.headless ? ['--headless=new'] : []), 'about:blank'];
    engine = startRegisteredService({ runtime, binary: 'browser_engine', args: engineArgs, cwd: homeRoot, serviceHome: homeRoot,
      assertAuthorized: assertCurrent, maxOutputBytes: 2_000_000 });
    const deadline = Date.now() + timeout; let cdpPort: number | undefined;
    while (!engine.exited && Date.now() < deadline) {
      if (engine.pid && exists(portFile)) {
        try {
          const bytes = await readBrowserBoundFile(portFile, 32_000), lines = bytes.toString('utf8').trim().split(/\r?\n/u);
          const port = Number(lines[0]), path = lines[1];
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !path || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/u.test(path)) throw new Error('invalid owned CDP discovery');
          const info = await readLoopbackJson(port, '/json/version');
          if (!object(info) || typeof info.Browser !== 'string' || !/^(?:Headless)?Chrome\/\d/u.test(info.Browser)
            || info.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}${path}`) throw new Error('CDP version identity mismatch');
          await verifyEngineProcess(port, path, engine.pid);
          assertCurrent(); owner.portFileSha256 = digest(bytes); cdpPort = port; ownedBrowserSocket = `ws://127.0.0.1:${port}${path}`; break;
        } catch { /* 只等待本次独立 profile；不尝试其他端点或已发现的旧服务。 */ }
      }
      await new Promise(done => setTimeout(done, 40));
    }
    if (!cdpPort || !engine.pid || engine.exited) throw new DirectError('BROWSER_ENGINE_UNAVAILABLE', '随包浏览器未成为本次已核进程与回环连接，未查找或接管系统浏览器。');
    owner.enginePid = engine.pid; await saveOwner();
    const daemonPort = await freeLoopbackPort();
    daemon = startRegisteredService({ runtime, binary: 'node', args: [daemonScript, '--host', '127.0.0.1', '--port', String(daemonPort),
      '--cdp-host', '127.0.0.1', '--cdp-port', String(cdpPort), '--no-chrome'], cwd: dirname(daemonScript), serviceHome: homeRoot,
      sensitiveOutput: true, assertAuthorized: assertCurrent, maxOutputBytes: 2_000_000 });
    const daemonDeadline = Date.now() + timeout;
    while (!daemon.exited && !engine.exited && Date.now() < daemonDeadline) {
      if (daemon.pid && exists(configuration.daemonConfigPath)) {
        try {
          const bytes = await readBrowserBoundFile(configuration.daemonConfigPath, 32_000), info: unknown = JSON.parse(bytes.toString('utf8'));
          if (!object(info) || info.pid !== daemon.pid || info.host !== '127.0.0.1' || info.port !== daemonPort || info.cdpHost !== '127.0.0.1'
            || info.cdpPort !== cdpPort || typeof info.token !== 'string' || !/^[^\s\u0000-\u001f]{16,2048}$/u.test(info.token)) throw new Error('daemon identity mismatch');
          const status = await readLoopbackJson(daemonPort, '/status', info.token);
          if (!object(status) || status.running !== true || status.cdpConnected !== true || status.cdpHost !== '127.0.0.1'
            || status.cdpPort !== cdpPort || !Array.isArray(status.tabs)) throw new Error('daemon not ready');
          await verifyEngineProcess(cdpPort, (await readBrowserBoundFile(portFile, 32_000)).toString('utf8').trim().split(/\r?\n/u)[1]!, engine.pid);
          assertCurrent(); owner.daemonPid = daemon.pid; owner.daemonFileSha256 = digest(bytes); owner.state = 'ready'; await saveOwner();
          return { configuration, enginePid: engine.pid, daemonPid: daemon.pid, shutdown };
        } catch { /* Token 仅留内存；失败不输出受保护正文，不尝试全局 daemon。 */ }
      }
      await new Promise(done => setTimeout(done, 40));
    }
    throw new DirectError('BROWSER_DAEMON_UNAVAILABLE', '随包浏览器守护进程未完成本次连接核验，未调用自动安装或旧守护进程。');
  } catch (error) {
    await shutdown();
    if (error instanceof DirectError) throw error;
    throw new DirectError('BROWSER_HOST_UNAVAILABLE', '内置浏览器资源或独立运行状态无法核对，未查找其他程序或账号。');
  }
}

/** URL 仅来自本次已核引擎；不接受客户端目标或其他 Chrome 端点。 */
function closeOwnedBrowser(url: string): Promise<void> {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url); let settled = false, sent = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? fail(error) : done(); };
    const timer = setTimeout(() => finish(new Error('native browser close timeout')), 2500);
    socket.addEventListener('open', () => { sent = true; socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); });
    socket.addEventListener('message', event => { try {
      const value: unknown = JSON.parse(String(event.data));
      if (object(value) && value.id === 1) finish(value.error ? new Error('native browser close rejected') : undefined);
    } catch { finish(new Error('native browser close invalid')); } });
    socket.addEventListener('error', () => finish(new Error('native browser close unavailable')));
    // 某些 Chrome 会先断开套接字；调用方仍须核对原进程真实退出。
    socket.addEventListener('close', () => { if (!settled) finish(sent ? undefined : new Error('native browser close unsent')); });
  });
}

async function ordinaryDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error; }
  const binding = inspectPath(path);
  if (binding.links.length || binding.object?.kind !== 'directory') throw new DirectError('BROWSER_HOST_BINDING_INVALID', '浏览器专用子目录不是普通目录。');
}
async function freeLoopbackPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no loopback port');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); return address.port;
}
function readLoopbackJson(port: number, path: '/json/version' | '/status', token?: string): Promise<unknown> {
  return new Promise((done, fail) => {
    let bytes = 0, settled = false; const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); error ? fail(error) : done(value); };
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {} }, res => {
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 64_000) { req.destroy(); finish(new Error('bounded readiness response exceeded')); } else chunks.push(Buffer.from(chunk)); });
      res.once('error', () => finish(new Error('readiness response failed'))); res.once('aborted', () => finish(new Error('readiness response incomplete')));
      res.once('end', () => { try { if (res.statusCode !== 200) throw new Error('readiness status'); finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('readiness shape')); } });
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('readiness timeout')); }, 1000);
    req.once('error', () => finish(new Error('readiness unavailable'))); req.end();
  });
}
function verifyEngineProcess(port: number, path: string, pid: number): Promise<void> {
  return new Promise((done, fail) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`); let matched = false, version = false, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? fail(error) : done(); };
    const timer = setTimeout(() => finish(new Error('owned CDP process verification timeout')), 1000);
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); socket.send(JSON.stringify({ id: 2, method: 'SystemInfo.getProcessInfo' })); });
    socket.addEventListener('message', event => { try {
      const value: unknown = JSON.parse(String(event.data)); if (!object(value) || !object(value.result) || value.error) throw new Error('CDP result invalid');
      if (value.id === 1) version = typeof value.result.product === 'string' && /^(?:Headless)?Chrome\/\d/u.test(value.result.product);
      if (value.id === 2) matched = Array.isArray(value.result.processInfo) && value.result.processInfo.some(item => object(item) && item.type === 'browser' && item.id === pid);
      if (version && matched) finish();
    } catch { finish(new Error('CDP process identity mismatch')); } });
    socket.addEventListener('error', () => finish(new Error('owned CDP unavailable'))); socket.addEventListener('close', () => { if (!settled) finish(new Error('owned CDP closed')); });
  });
}

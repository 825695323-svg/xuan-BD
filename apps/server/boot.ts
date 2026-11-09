import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Backend } from '../../contracts/backend.js';
import type { BackendRegistry } from '../../platform/runtime/backends.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { createApp } from './app.js';
import type { ApplicationServices } from './services.js';

/** 主宿主先独占入口；同进程附属服务不监听，但仍须独占自己的状态后才恢复运行。 */
export async function startLocalServer(options: {
  backend: Backend; registry?: BackendRegistry; health: HealthResponse; databasePath: string; port?: number;
  /** 仅受信宿主装配同进程附属服务；不绑定临时或固定端口，状态所有权规则不变。 */
  listen?: false;
  initializeServices?: (core: PersonalCore, database: CoreDatabase) => ApplicationServices;
  /** 入口与状态所有权均取得后、任何状态恢复前装配同实例的附属服务。 */
  beforeInitialize?: () => void | Promise<void>;
  acquireStartupFence?: () => { verify(): void; release(): void };
  /** 先拒收主入口新请求，再收束同实例附属服务；失败仍继续关闭个人状态。 */
  beforeShutdown?: () => void | Promise<void>;
  webRoot?: string;
}) {
  let app: ReturnType<typeof createApp> | undefined;
  let stopping = false;
  const server = createServer((req, res) => {
    if (stopping) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); res.end('本机服务正在停止，请稍候。'); }
    else if (app) app(req, res);
    else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('正在恢复本机状态，请稍候。'); }
  });
  if (options.listen !== false) await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let database: CoreDatabase | undefined, core: PersonalCore | undefined, services: ApplicationServices | undefined;
  let releaseOwnership: (() => Promise<void>) | undefined;
  let startupFence: { verify(): void; release(): void } | undefined;
  try {
    startupFence = options.acquireStartupFence?.();
    releaseOwnership = await ownStateRoot(options.databasePath);
    startupFence?.verify();
    startupFence?.release();
    startupFence = undefined;
    await options.beforeInitialize?.();
    database = new CoreDatabase(options.databasePath);
    core = new PersonalCore(options.backend, { database, registry: options.registry });
    services = options.initializeServices?.(core, database);
    app = createApp(core, options.health, services, { webRoot: options.webRoot });
  } catch (error) {
    startupFence?.release();
    services?.taskCompletions?.dispose();
    services?.segments?.close();
    services?.files.closeTemporaryRetention();
    services?.options.processRuntime?.closeTemporaryRetention();
    await services?.r1Batches?.dispose();
    await services?.r1Auto?.dispose();
    const disposed = await Promise.allSettled([services?.tasks.dispose(), core?.dispose()]);
    let databaseClosed = true;
    try { database?.close(); } catch { databaseClosed = false; }
    if (databaseClosed && disposed.every(result => result.status === 'fulfilled')) await releaseOwnership?.().catch(() => {});
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    throw error;
  }
  const runningCore = core, runningDatabase = database;
  let stop: Promise<void> | undefined;
  return { server, core: runningCore, database: runningDatabase, services, shutdown() {
    stop ??= (async () => {
      stopping = true;
      services?.taskCompletions?.dispose();
      services?.segments?.close();
      services?.files.closeTemporaryRetention();
      services?.options.processRuntime?.closeTemporaryRetention();
      await services?.r1Batches?.dispose();
      await services?.r1Auto?.dispose();
      // 仍持有入口，直到所有使用者收束并关闭数据库；另一个进程此时不能恢复它。
      let companionFailure: unknown;
      try { await options.beforeShutdown?.(); } catch (error) { companionFailure = error; }
      const settled = await Promise.allSettled([services?.tasks.dispose(), runningCore.dispose()]);
      let databaseFailure: unknown, ownershipFailure: unknown, serverFailure: unknown;
      try { runningDatabase.close(); } catch (error) { databaseFailure = error; }
      // 只有本状态的消费者与数据库均确认关闭，才能释放所有权；附属状态自行守同一规则。
      if (!databaseFailure && settled.every(result => result.status === 'fulfilled')) {
        try { await releaseOwnership?.(); } catch (error) { ownershipFailure = error; }
      }
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        }
      } catch (error) { serverFailure = error; }
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (companionFailure) throw companionFailure;
      if (databaseFailure) throw databaseFailure;
      if (ownershipFailure) throw ownershipFailure;
      if (serverFailure) throw serverFailure;
    })();
    return stop;
  } };
}

/** 状态根独占不依赖端口。已有或身份不明的锁均保留，绝不按时间或 PID 自动抢占。 */
export async function ownStateRoot(databasePath: string): Promise<() => Promise<void>> {
  if (databasePath === ':memory:') return async () => {};
  await mkdir(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(dirname(resolve(databasePath)));
  try {
    const database = await lstat(databasePath);
    if (!database.isFile() || database.nlink !== 1) throw new Error('状态数据库需要独立普通文件，不能使用符号链接或多链接文件。');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  // 目录别名归到同一实际状态根；数据库链接则在上方直接拒绝。
  const legacyOwner = await lstat(resolve(stateRoot, '.harness-owner.lock')).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (legacyOwner) throw Object.assign(new Error('原应用仍有状态所有者或遗留锁；请先按原身份核对并完成命名迁移。'), { code: 'STATE_IN_USE' });
  const path = resolve(stateRoot, '.bd-owner.lock'), token = randomUUID();
  let file;
  try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw Object.assign(new Error('状态目录已有所有者或遗留锁；请先核对原实例与锁文件，不能自动接管。'), { code: 'STATE_IN_USE' });
    }
    throw error;
  }
  const identity = await file.stat();
  const sameFile = async () => {
    const current = await lstat(path);
    return current.isFile() && current.nlink === 1 && current.dev === identity.dev && current.ino === identity.ino;
  };
  try {
    await file.writeFile(JSON.stringify({ version: 1, pid: process.pid, token }));
    await file.sync();
  } catch (error) {
    if (await sameFile()) await unlink(path);
    throw error;
  } finally { await file.close(); }
  return async () => {
    const lost = () => Object.assign(new Error('状态所有者身份未能确认，已保留锁文件供核对。'), { code: 'STATE_OWNERSHIP_UNCONFIRMED' });
    if (!await sameFile()) throw lost();
    const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await current.stat();
      if (info.dev !== identity.dev || info.ino !== identity.ino || info.size > 1024) throw lost();
      const owner: unknown = JSON.parse(await current.readFile('utf8'));
      if (!owner || typeof owner !== 'object' || !('token' in owner) || owner.token !== token || !await sameFile()) throw lost();
      await unlink(path);
    } finally { await current.close(); }
  };
}

export interface StateOwnershipProof { pid: number; token: string; device: string; inode: string; sha256: string }
/** 仅为显式维护恢复准备释放函数；先核原进程已不存在，调用方须保持原启动围栏。 */
export async function prepareStateRootRecovery(databasePath: string, expected: StateOwnershipProof): Promise<() => Promise<void>> {
  const lost = () => Object.assign(new Error('原状态所有者的进程、令牌或文件节点未能核同，保留锁文件。'), { code: 'STATE_OWNERSHIP_UNCONFIRMED' });
  const parent = dirname(resolve(databasePath));
  if (databasePath !== resolve(databasePath) || await realpath(parent) !== parent
    || !Number.isSafeInteger(expected.pid) || expected.pid < 1 || !expected.token
    || !/^[0-9]+$/u.test(expected.device) || !/^[0-9]+$/u.test(expected.inode) || !/^[a-f0-9]{64}$/u.test(expected.sha256)) throw lost();
  const database = await lstat(databasePath);
  if (!database.isFile() || database.nlink !== 1) throw lost();
  const path = resolve(parent, '.bd-owner.lock');
  const verify = async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 1024n
        || String(before.dev) !== expected.device || String(before.ino) !== expected.inode) throw lost();
      const raw = await file.readFile('utf8'), after = await file.stat({ bigint: true }), owner: unknown = JSON.parse(raw);
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || createHash('sha256').update(raw).digest('hex') !== expected.sha256 || !owner || typeof owner !== 'object'
        || !('version' in owner) || owner.version !== 1 || !('pid' in owner) || owner.pid !== expected.pid
        || !('token' in owner) || owner.token !== expected.token) throw lost();
      try { process.kill(expected.pid, 0); throw Object.assign(new Error('原状态所有者进程仍在，拒绝接管。'), { code: 'STATE_OWNER_ACTIVE' }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error; }
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw lost();
    } finally { await file.close(); }
  };
  await verify();
  return async () => {
    await verify(); await unlink(path);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  };
}

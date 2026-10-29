import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProcessRuntime, type RegisteredProgramName } from './programs.js';
import { TaskError } from '../jobs/tasks.js';

export type DirectBinary = RegisteredProgramName;
export class DirectProcessError extends TaskError {
  constructor(code: string, message: string, readonly disposition: 'not_started' | 'settled' | 'unknown', readonly exitCode: number | null = null, readonly terminationSignal?: NodeJS.Signals,
    /** 有界诊断只留在异常对象，不进入任务结果或默认日志。 */ readonly diagnostic?: string, readonly binary?: DirectBinary) {
    super(code, message); this.name = 'DirectProcessError';
  }
}

export interface DirectProcessOptions {
  binary: DirectBinary;
  runtime: ProcessRuntime;
  /** 仅限受信宿主装配，不能来自客户端参数或模型工具参数。 */
  binaryPath?: string;
  /** 仅原生 bdpan（网盘程序）账号存储兼容；不继承任何其他宿主环境变量。 */
  bdpanHome?: string;
  /** 仅受信浏览器宿主可选用已登记 browser_home，不能传任意账号目录。 */
  serviceHome?: string;
  /** 仅随包 Node 长驻服务；认证秘密输出只计预算，不保管或返回。 */
  sensitiveOutput?: true;
  args: readonly string[];
  stdin?: Uint8Array | string;
  cwd: string;
  signal: AbortSignal;
  assertAuthorized(): void;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onProcessState?(event: DirectProcessState): void | Promise<void>;
  onHeartbeat?(event: DirectProcessHeartbeat): void | Promise<void>;
}
export interface DirectProcessState {
  pid: number; startIdentity: string; state: 'started' | 'exited'; timestamp: number;
  exitCode?: number | null; signal?: NodeJS.Signals | null; settlement?: 'settled' | 'unknown';
}
export interface DirectProcessHeartbeat { pid: number; startIdentity: string; timestamp: number; activity: boolean }
export interface DirectProcessResult { stdout: string; stderr: string; exitCode: 0; binaryPath: string }

/** argv 由各动作构造；取消和超时等到子进程及输出流关闭后才返回。 */
export async function runDirectProcess(options: DirectProcessOptions): Promise<DirectProcessResult> {
  return executeProcess(options, false);
}

async function executeProcess(options: DirectProcessOptions, service: boolean): Promise<DirectProcessResult> {
  if (!(options.runtime instanceof ProcessRuntime)) throw new DirectProcessError('TOOL_UNBOUND', '工具没有受信宿主运行绑定。', 'not_started');
  if (options.sensitiveOutput && (!service || options.binary !== 'node')) throw new DirectProcessError('INVALID_PROCESS_OPTIONS', '敏感输出模式只供受信 Node 长驻服务使用。', 'not_started');
  if (options.serviceHome !== undefined && (options.bdpanHome !== undefined || !['node', 'browser_engine'].includes(options.binary))) throw new DirectProcessError('INVALID_PROCESS_OPTIONS', '专用 HOME 只供已登记的浏览器程序使用。', 'not_started');
  const windows = process.platform === 'win32';
  let binaryPath: string;
  try { binaryPath = options.runtime.path(options.binary); }
  catch { throw new DirectProcessError('TOOL_UNAVAILABLE', `登记程序 ${options.binary} 缺失或身份已变化。`, 'not_started'); }
  if (options.binaryPath !== undefined && options.binaryPath !== binaryPath) throw new DirectProcessError('TOOL_CHANGED', '授权程序与当前登记程序不一致。', 'not_started');
  const stdin = options.stdin === undefined ? undefined : typeof options.stdin === 'string' ? Buffer.from(options.stdin) : Buffer.from(options.stdin);
  if (stdin && stdin.length > 2_000_000) throw new DirectProcessError('PROCESS_INPUT_LIMIT', '本机工具输入超过本次上限。', 'not_started');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 8_000_000) {
    throw new DirectProcessError('INVALID_PROCESS_LIMIT', '进程预算无效。', 'not_started');
  }
  if (options.args.some((value) => typeof value !== 'string' || value.includes('\0'))) throw new DirectProcessError('INVALID_ARGV', '工具参数无效。', 'not_started');
  try { options.signal.throwIfAborted(); options.assertAuthorized(); }
  catch (error) { throw new DirectProcessError('PROCESS_NOT_STARTED', '工具开始前已停止或授权已失效。', 'not_started'); }
  let lease: ReturnType<ProcessRuntime['prepare']>;
  try { lease = options.runtime.prepare(options.binary, options.serviceHome ?? options.bdpanHome); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'WINDOWS_PROCESS_CONTROL_UNBOUND') throw new DirectProcessError('PROCESS_ENVIRONMENT_UNSUPPORTED', 'Windows 执行需要已核 system_root 和 taskkill 系统资源。', 'not_started');
    throw new DirectProcessError('PROCESS_ENVIRONMENT_INVALID', '本次受管理运行目录无法准备或授权已失效。', 'not_started');
  }
  let preserve = false;
  try {
    lease.assertCurrent(); options.signal.throwIfAborted(); options.assertAuthorized();
    return await new Promise<DirectProcessResult>((resolve, reject) => {
    // 不继承密钥、代理、DYLD 或用户 PATH；浏览器专用 HOME 必须匹配宿主登记。
    const child = spawn(binaryPath, [...options.args], {
      cwd: options.cwd, shell: false, detached: !windows, windowsHide: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: lease.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: { code: string; message: string } | undefined;
    let spawnError: Error | undefined;
    let closed = false;
    let finished = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const startIdentity = randomUUID();
    let notifications: Promise<void> = Promise.resolve();
    let observationFailed = false;
    let heartbeatPending = false;
    let outputActivity = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let groupTimer: ReturnType<typeof setInterval> | undefined;
    let windowsStopStarted = false, windowsStopSucceeded = false;
    const kill = (signal: NodeJS.Signals) => {
      if (finished || child.pid === undefined) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
          // 宿主可能拒绝进程组信号；先停止直接子进程，最终仍必须核对整个组已消失。
          try { child.kill(signal); } catch { /* 未收束会由清理预算和组核对报告 unknown。 */ }
        }
      }
    };
    const stop = (code: string, message: string) => {
      failure ??= { code, message };
      if (finished) return;
      cleanupTimer ??= setTimeout(() => {
        finish(new DirectProcessError('PROCESS_CLEANUP_UNKNOWN', '工具进程尚未确认收束；保留暂存并等待人工核对。', 'unknown', exitCode));
      }, 5000);
      if (windows) {
        if (windowsStopStarted || child.pid === undefined) return;
        windowsStopStarted = true;
        void terminateWindowsTree(options.runtime, child.pid, () => !closed && child.exitCode === null && child.signalCode === null).then(success => {
          windowsStopSucceeded = success;
          if (!success) finish(new DirectProcessError('PROCESS_CLEANUP_UNKNOWN', 'Windows 终止辅助程序或原进程树收束未能核对，保留现场。', 'unknown', exitCode));
          else if (closed) finish();
        });
      } else {
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 500);
      }
    };
    const onAbort = () => stop('DIRECT_CANCELLED', '已停止本次工具执行。');
    const timer = service ? undefined : setTimeout(() => stop('DIRECT_TIMEOUT', '本机工具超过本次时间上限。'), timeoutMs);
    const notify = (callback: () => void | Promise<void>) => {
      notifications = notifications.then(async () => {
        if (observationFailed) return;
        try { await callback(); }
        catch {
          observationFailed = true;
          stop('PROCESS_OBSERVATION_FAILED', '工具运行回执未能保存，已请求停止并保留未知结果。');
        }
      });
    };
    const heartbeat = (activity: boolean) => {
      if (!options.onHeartbeat || child.pid === undefined || closed || observationFailed) return;
      outputActivity ||= activity;
      if (heartbeatPending) return;
      heartbeatPending = true;
      const pid = child.pid;
      notify(async () => {
        const observedActivity = outputActivity; outputActivity = false;
        try { await options.onHeartbeat!({ pid, startIdentity, timestamp: Date.now(), activity: observedActivity }); }
        finally { heartbeatPending = false; }
      });
    };
    child.once('spawn', () => {
      if (child.pid === undefined) return;
      const pid = child.pid;
      notify(() => lease.record('started', { pid, startIdentity }));
      if (options.onProcessState) notify(() => options.onProcessState!({ pid, startIdentity, state: 'started', timestamp: Date.now() }));
      if (options.onHeartbeat) { heartbeatTimer = setInterval(() => heartbeat(false), 5000); heartbeatTimer.unref(); }
      if (windows && failure) stop(failure.code, failure.message);
    });
    const consume = (destination: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { stop('PROCESS_OUTPUT_LIMIT', '本机工具输出超过本次上限。'); return; }
      if (!options.sensitiveOutput) destination.push(Buffer.from(chunk));
      heartbeat(true);
    };
    child.stdout!.on('data', consume(stdout));
    child.stderr!.on('data', consume(stderr));
    child.once('error', (error) => { spawnError = error; });
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => stop('PROCESS_INPUT_FAILED', '本机工具未完整接收固定输入。'));
      child.stdin.end(stdin);
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    const finish = (cleanupUnknown?: DirectProcessError) => {
      if (finished) return;
      finished = true;
      const code = exitCode, terminationSignal = exitSignal;
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (killTimer) clearTimeout(killTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (groupTimer) clearInterval(groupTimer);
      options.signal.removeEventListener('abort', onAbort);
      if (closed && child.pid !== undefined && options.onProcessState) {
        const pid = child.pid;
        notify(() => options.onProcessState!({ pid, startIdentity, state: 'exited', timestamp: Date.now(), exitCode: code,
          signal: terminationSignal, settlement: cleanupUnknown || observationFailed ? 'unknown' : 'settled' }));
      }
      void notifications.then(() => {
        if (observationFailed) return reject(new DirectProcessError('PROCESS_OBSERVATION_FAILED', '工具运行回执未能保存，保留未知结果等待核对。', 'unknown', code));
        if (cleanupUnknown) return reject(cleanupUnknown);
        if (failure) return reject(new DirectProcessError(failure.code, failure.message, failure.code === 'PROCESS_CLEANUP_UNKNOWN' ? 'unknown' : 'settled', code));
        if (spawnError) return reject(new DirectProcessError('PROCESS_START_FAILED', `无法启动本机工具 ${options.binary}。`, child.pid === undefined ? 'not_started' : 'unknown', code));
        if (code !== 0) return reject(new DirectProcessError('PROCESS_FAILED', `本机工具 ${options.binary} 执行失败（${terminationSignal ? `系统信号 ${terminationSignal}` : `退出码 ${code ?? '未知'}`}）。`, 'settled', code, terminationSignal ?? undefined, options.sensitiveOutput ? undefined : Buffer.concat(stderr).toString('utf8').slice(0, 4096), options.binary));
        return resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: 0, binaryPath });
      }).catch(() => reject(new DirectProcessError('PROCESS_OBSERVATION_FAILED', '工具运行回执未能保存，保留未知结果等待核对。', 'unknown', code)));
    };
    const groupGone = () => {
      if (child.pid === undefined) return true;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
    };
    child.once('close', (code, terminationSignal) => {
      closed = true; exitCode = code; exitSignal = terminationSignal;
      if (finished) return;
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (windows) {
        // 自然关闭只核本次子进程；取消必须同时核受控 /T /F helper 完成，不冒充 Job Object 隔离。
        if (!failure || child.pid === undefined || windowsStopSucceeded) return finish();
        if (!windowsStopStarted) return finish(new DirectProcessError('PROCESS_CLEANUP_UNKNOWN', '原 Windows 父进程已消失，不能据此证明后代已退出。', 'unknown', exitCode));
        return;
      }
      if (groupGone()) return finish();
      // 主进程关闭输出流并不证明其后代退出；继续终止并核对原进程组。
      stop('PROCESS_DESCENDANTS_ACTIVE', '工具主进程已结束，遗留子进程已请求收束。');
      groupTimer = setInterval(() => { if (groupGone()) finish(); }, 25);
    });
  }); } catch (error) {
    preserve = error instanceof DirectProcessError && error.disposition === 'unknown';
    if (preserve) { try { lease.record('unknown'); } catch { /* 保留原目录供恢复。 */ } }
    throw error;
  } finally {
    if (!preserve) { try { lease.cleanup(); } catch { throw new DirectProcessError('PROCESS_DIRECTORY_UNKNOWN', '进程已收束，但运行临时目录清理未确认。', 'unknown'); } }
  }
}

/** 只终止本次仍持有的子进程；系统工具须已登记，helper 失败不尝试其他路径。 */
async function terminateWindowsTree(runtime: ProcessRuntime, pid: number, parentOpen: () => boolean): Promise<boolean> {
  let lease: ReturnType<ProcessRuntime['prepare']>;
  try { lease = runtime.prepare('taskkill'); }
  catch { return false; }
  if (!parentOpen()) { try { lease.cleanup(); } catch { /* 保留无法核对的 helper 目录。 */ } return false; }
  return new Promise<boolean>(resolve => {
    let finished = false, closed = false, failed = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const startIdentity = randomUUID();
    let child: ReturnType<typeof spawn>;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer); if (fallback) clearTimeout(fallback);
      try {
        lease.assertCurrent(); lease.record(closed ? 'exited' : 'unknown');
        if (closed) lease.cleanup();
      } catch { success = false; }
      resolve(success);
    };
    const timer = setTimeout(() => {
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* 未收到 close 时保留原目录和未知事实。 */ }
      fallback = setTimeout(() => finish(false), 500);
    }, 1500);
    try {
      lease.assertCurrent();
      if (!parentOpen()) { closed = true; finish(false); return; }
      child = spawn(lease.executable, ['/PID', String(pid), '/T', '/F'], {
        env: lease.env, cwd: lease.temporary, shell: false, detached: false, windowsHide: true, stdio: 'ignore',
      });
      child.once('spawn', () => {
        try { lease.record('started', { pid: child.pid!, startIdentity }); }
        catch { failed = true; try { child.kill('SIGKILL'); } catch { /* 超时后保留未知。 */ } }
      });
      child.once('error', () => { failed = true; });
      child.once('close', code => { closed = true; finish(code === 0 && !failed); });
    } catch { closed = true; finish(false); }
  });
}

/** 长驻服务复用同一程序定位、环境与组清理；业务适配器仍负责实例就绪核验。 */
export function startRegisteredService(options: Omit<DirectProcessOptions, 'signal' | 'timeoutMs'>) {
  const controller = new AbortController();
  let pid: number | undefined, exited = false, failed = false;
  const completion = executeProcess({ ...options, signal: controller.signal,
    onProcessState: async event => { if (event.state === 'started') pid = event.pid; await options.onProcessState?.(event); } }, true)
    .then(() => { exited = true; }, error => { exited = true; failed = true; throw error; });
  // 启动期间的失败由适配器状态及 shutdown 读回；避免未处理拒绝。
  void completion.catch(() => {});
  return { get pid() { return pid; }, get exited() { return exited; }, get failed() { return failed; },
    async shutdown() { controller.abort(); try { await completion; } catch (error) {
      if (!(error instanceof DirectProcessError && error.disposition !== 'unknown')) throw error;
    } },
  };
}

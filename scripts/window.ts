import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launcherPath, locateRuntimeRoot, ResourceBindings } from '../platform/resources/bindings.js';
import { ProcessRuntime } from '../platform/runtime/programs.js';
import { ChromiumPipe, NativeFilesAdapter } from '../platform/runtime/native-files.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const url = 'http://127.0.0.1:4317/';

function windowContext(args: readonly string[], environment: NodeJS.ProcessEnv) {
  const selected = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(runtime-root|launcher)=(.+)$/u.exec(arg);
    if (!match || selected.has(match[1]!)) throw new Error('用法：启动窗口 [--runtime-root=绝对工作目录] [--launcher=绝对定位文件]。');
    selected.set(match[1]!, match[2]!);
  }
  const launcherFile = selected.get('launcher') ?? launcherPath();
  if (!isAbsolute(launcherFile) || launcherFile.includes('\0')) throw new Error('启动定位文件需要明确的绝对路径。');
  const runtimeRoot = locateRuntimeRoot(selected.get('runtime-root'), environment, launcherFile);
  const resources = new ResourceBindings(runtimeRoot), runtime = new ProcessRuntime(resources);
  const reference = (root: string, relative: string) => {
    const binding = resources.document.resources[root];
    if (!binding?.owned || !binding.identity) throw new Error(`窗口资源 ${root} 尚未受信登记。`);
    return { root, identity: binding.identity, relative };
  };
  const profileReference = reference('browser_home', 'app-window'), logReference = reference('cache', 'app-window.log');
  const profilePath = resources.resolve(profileReference), logPath = resources.resolve(logReference);
  return { resources, runtime, plan: {
    url, runtimeRoot, launcherFile, runtimeIdentity: resources.document.runtimeIdentity, bindingRevision: resources.document.revision,
    nodeProgram: runtime.path('node'), browserProgram: runtime.path('browser_engine'), profilePath, logPath, profileReference, logReference,
    serviceArgs: ['--import', 'tsx', resolve(projectRoot, 'scripts/web.ts'), `--runtime-root=${runtimeRoot}`, `--launcher=${launcherFile}`],
    browserArgs: [`--app=${url}`, `--user-data-dir=${profilePath}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  } };
}

/** 只解析既有本机配置，不启动进程或创建目录。 */
export function readWindowPlan(args: readonly string[] = [], environment: NodeJS.ProcessEnv = process.env) {
  return windowContext(args, environment).plan;
}

async function serviceReady(): Promise<boolean> {
  let response: Response;
  try { response = await fetch(new URL('api/health', url), { signal: AbortSignal.timeout(2_000), redirect: 'error' }); }
  catch { return false; }
  let health: unknown;
  try { health = await response.json(); } catch { /* 下面统一拒绝非本应用的响应。 */ }
  if (!response.ok || !health || typeof health !== 'object' || !('name' in health) || health.name !== 'xuan BD'
    || !('configured' in health) || typeof health.configured !== 'boolean') {
    throw new Error('4317 入口未返回本应用健康信息，请核对当前占用者。');
  }
  // 健康信息仅确认应用响应，不提供运行身份认证；新服务仍由原启动围栏核对身份。
  return true;
}

async function detached(executable: string, args: string[], log?: number): Promise<ChildProcess> {
  const child = spawn(executable, args, { cwd: projectRoot, detached: true, stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'] });
  await new Promise<void>((accept, reject) => { child.once('error', reject); child.once('spawn', accept); });
  child.unref();
  return child;
}

export async function runWindow(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { resources, runtime, plan } = windowContext(args, process.env);
  if (!await serviceReady()) {
    const log = openSync(resources.resolve(plan.logReference), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let child: ChildProcess;
    try {
      const stat = fstatSync(log);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('窗口日志必须是无多重链接的普通文件。');
      resources.resolve(plan.logReference);
      child = await detached(runtime.path('node'), plan.serviceArgs, log);
    } finally { closeSync(log); }
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (await serviceReady()) { ready = true; break; }
      await setTimeout(1_000);
    }
    if (!ready) throw new Error(`后台服务尚未就绪，请查看 ${plan.logPath}。`);
  }
  // 首次服务装配完成后才创建窗口资料，避免抢占浏览器宿主的初始目录检查。
  const profile = resources.resolve(plan.profileReference);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (!lstatSync(profile).isDirectory()) throw new Error('窗口浏览器资料必须是普通目录。');
  resources.resolve(plan.profileReference);
  // 独立受信子进程持有私有管道，系统启动器仍在窗口创建后返回。
  const log = openSync(resources.resolve(plan.logReference), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(log);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('窗口日志必须是无多重链接的普通文件。');
    resources.resolve(plan.logReference);
    await detached(runtime.path('node'), ['--import', 'tsx', fileURLToPath(import.meta.url), '--native-file-window',
      `--runtime-root=${plan.runtimeRoot}`, `--launcher=${plan.launcherFile}`], log);
  } finally { closeSync(log); }
}

async function runNativeFileWindow(args: readonly string[]): Promise<void> {
  const { resources, runtime, plan } = windowContext(args, process.env);
  resources.resolve(plan.profileReference);
  const child = spawn(runtime.path('browser_engine'), plan.browserArgs, {
    cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'],
  });
  await new Promise<void>((accept, reject) => { child.once('error', reject); child.once('spawn', accept); });
  const input = child.stdio[4], output = child.stdio[3];
  if (!input || !('read' in input) || !output || !('write' in output)) throw new Error('应用窗口私有管道未能创建。');
  const pipe = new ChromiumPipe(output, input), adapter = new NativeFilesAdapter(pipe, plan.url);
  child.once('exit', pipe.close);
  child.once('error', pipe.close);
  child.unref();
  try {
    await adapter.ready;
    console.info(`本机文件原路径桥已就绪 pid=${process.pid}`);
    await pipe.closed;
  }
  finally { await adapter.dispose(); pipe.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--native-file-window') await runNativeFileWindow(args.slice(1));
    else await runWindow(args);
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'xuan BD 窗口启动失败，请核对本机配置。');
    process.exitCode = 1;
  }
}

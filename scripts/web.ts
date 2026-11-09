import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRuntimeRoot } from '../platform/resources/bindings.js';
import { startConfiguredApplication } from '../apps/server/configured-app.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function runWeb(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  let boot: ReturnType<typeof startConfiguredApplication> | undefined;
  let stopping: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    return stopping ??= (async () => {
      try {
        const application = await boot;
        await application?.running.shutdown();
        console.log('xuan BD 已关闭，本机状态与端口已释放。');
      } catch {
        console.error('关闭未能全部确认；请核对原实例和状态所有者锁。');
        process.exitCode = 1;
      }
    })();
  }

  try {
    const selected = new Map<string, string>();
    for (const arg of args) {
      const match = /^--(runtime-root|launcher)=(.+)$/u.exec(arg);
      if (!match || selected.has(match[1]!)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENTS' });
      selected.set(match[1]!, match[2]!);
    }
    const launcherFile = selected.get('launcher');
    if (launcherFile !== undefined && !isAbsolute(launcherFile)) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENTS' });
    const workspaceRoot = locateRuntimeRoot(selected.get('runtime-root'), process.env, launcherFile);
    if (!isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENTS' });
    try { await access(resolve(projectRoot, 'dist/web/index.html'), constants.R_OK); }
    catch { throw Object.assign(new Error(), { code: 'WEB_BUILD_MISSING' }); }
    boot = startConfiguredApplication({ workspaceRoot, codeRoot: projectRoot, launcherFile, workspaceCompanion: {} });
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    await boot;
    if (!stopping) {
      console.log('xuan BD：http://127.0.0.1:4317');
      console.log(`既有状态工作根：${resolve(workspaceRoot)}`);
      console.log('保持此终端运行；按 Ctrl-C 优雅关闭。关闭浏览器页面不停止后台。');
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const message = code === 'EADDRINUSE' ? '本机 4317 端口已有实例；请先关闭原实例，未接管其状态。'
      : code === 'STATE_IN_USE' ? '状态目录已有所有者或遗留锁；请先核对原实例与 .bd-owner.lock，不能自动接管。'
      : code === 'WEB_BUILD_MISSING' ? '网页资源尚未构建；请先运行 npm run build。'
      : code === 'INVALID_ARGUMENTS' ? '用法：启动入口 [--runtime-root=绝对工作目录] [--launcher=绝对定位文件]。端口与本机绑定不可覆盖。'
      : 'xuan BD 启动失败；请核对既有工作目录、配置和状态访问权限。';
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWeb();

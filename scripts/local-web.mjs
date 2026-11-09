import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, checkNodeDependencies } from '../platform/resources/native-check.mjs';

// 标准库入口可在 npm ci 前给出 Node/锁定依赖缺口；不加载私人运行配置。
const codeRoot = fileURLToPath(new URL('..', import.meta.url));
try {
  assertNodeVersion(codeRoot);
  checkNodeDependencies(codeRoot);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./bootstrap-local-web.ts', import.meta.url)), ...process.argv.slice(2)],
    { cwd: codeRoot, stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { console.error('LOCAL_WEB_CHILD_FAILED: 无法启动已选 Node；未尝试其他程序。'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
} catch (error) {
  console.error(`${error.code ?? 'LOCAL_WEB_FAILED'}: ${error.message}`);
  process.exitCode = 1;
}

import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineBindingDocument } from '../platform/resources/bindings.js';
import { ResourceBindings } from '../platform/resources/bindings.js';
import { NATIVE_WEB_IDENTITY, assertNativeWebResources, type NativeWebPolicy } from '../platform/resources/local-web.js';
import { absolute, assertNodeVersion, checkNodeDependencies, checkNpm, checkPython, contains, fail, inspectProgram, nativeEnvironment, readJson, sha256File } from '../platform/resources/native-check.mjs';
import { readRuntimeLauncher, type RuntimeLauncher } from '../platform/runtime/runtime-profile.js';
import { createServer } from 'node:net';

export interface LocalWebConfiguration {
  version: 1; resourceMode: 'native'; runtimeRoot: string; launcherFile: string;
  node: string; npmCli: string; python: string;
  model: 'disabled'; browser: 'disabled'; transcription: 'disabled'; systemRoot?: string;
}
export function readLocalWebConfiguration(file: string): LocalWebConfiguration {
  const value = readJson(absolute(file));
  const keys = ['version', 'resourceMode', 'runtimeRoot', 'launcherFile', 'node', 'npmCli', 'python', 'model', 'browser', 'transcription', ...(value.systemRoot !== undefined ? ['systemRoot'] : [])];
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.version !== 1 || value.resourceMode !== 'native'
    || value.model !== 'disabled' || value.browser !== 'disabled' || value.transcription !== 'disabled') {
    fail('LOCAL_WEB_CONFIG_INVALID', '请使用脱敏模板，明确选择 native 与禁用的可选能力；首版不配置完整模型代理。');
  }
  for (const key of ['runtimeRoot', 'launcherFile', 'node', 'npmCli', 'python'] as const) absolute(value[key]);
  if (value.systemRoot !== undefined) absolute(value.systemRoot);
  return value as LocalWebConfiguration;
}
export function checkLocalWeb(codeRoot: string, configuration: Pick<LocalWebConfiguration, 'node' | 'npmCli' | 'python' | 'systemRoot'>) {
  const toolchain = assertNodeVersion(codeRoot), node = inspectProgram(configuration.node);
  if (node.canonical !== realpathSync(process.execPath)) fail('LOCAL_WEB_NODE_MISMATCH', '当前进程不是配置明确选择的 Node；请使用该绝对路径重新运行。');
  const npm = checkNpm(codeRoot, configuration.npmCli, configuration.systemRoot);
  const python = checkPython(codeRoot, configuration.python, configuration.systemRoot);
  const dependencies = checkNodeDependencies(codeRoot);
  return { toolchain, node: { path: node.path, sha256: node.sha256, version: process.versions.node }, npm,
    python: { path: python.path, sha256: python.sha256, version: python.version }, dependencies };
}
function newPath(path: string, codeRoot: string): void {
  absolute(path);
  if (lstatSync(path, { throwIfNoEntry: false }) || realpathSync(dirname(path)) !== dirname(path)) fail('LOCAL_WEB_TARGET_EXISTS', '准备目标须位于真实父目录，且目标对象尚不存在；不会覆盖、重置或接管旧身份。');
  if (contains(realpathSync(codeRoot), path) || contains(path, realpathSync(codeRoot))) fail('LOCAL_WEB_TARGET_IN_SOURCE', '运行根和定位文件必须在源码目录外，不能包含源码。');
  accessSync(dirname(path), constants.W_OK);
}
function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
/** 显式新设备/隔离根准备；仅写新对象，不发现旧 locator、不复制模型配置/凭据或登记任何数据库。 */
export function prepareLocalWeb(codeRoot: string, configuration: LocalWebConfiguration): RuntimeLauncher {
  if (configuration.version !== 1 || configuration.resourceMode !== 'native' || configuration.model !== 'disabled'
    || configuration.browser !== 'disabled' || configuration.transcription !== 'disabled') fail('LOCAL_WEB_CONFIG_INVALID', '新根准备必须显式选择 native 与禁用的可选能力。');
  const { runtimeRoot, launcherFile } = configuration;
  newPath(runtimeRoot, codeRoot); newPath(launcherFile, codeRoot);
  if (contains(runtimeRoot, launcherFile) || contains(launcherFile, runtimeRoot)) fail('LOCAL_WEB_TARGET_OVERLAP', '新运行根与新定位文件不能重叠。');
  const checked = checkLocalWeb(codeRoot, configuration);
  const disk = statfsSync(dirname(runtimeRoot));
  if (disk.bavail * disk.bsize < checked.toolchain.minimumFreeBytes) fail('LOCAL_WEB_DISK_SPACE', '运行根父卷的可用磁盘空间不足工具链最低要求。');
  const resources: MachineBindingDocument['resources'] = {
    node: { kind: 'program', path: checked.node.path, sha256: checked.node.sha256 },
    python: { kind: 'program', path: checked.python.path, sha256: checked.python.sha256 },
  };
  nativeEnvironment(configuration.systemRoot);
  if (process.platform === 'win32') {
    const taskkill = inspectProgram(join(configuration.systemRoot!, 'System32', 'taskkill.exe'));
    resources.system_root = { kind: 'directory', path: configuration.systemRoot! };
    resources.taskkill = { kind: 'program', path: taskkill.path, sha256: taskkill.sha256 };
  }
  // 所有可失败的只读预检完成后才建根；后续失败原样保留现场，不清空、不自动重试。
  newPath(runtimeRoot, codeRoot); newPath(launcherFile, codeRoot);
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const runtimeIdentity = randomUUID();
  for (const [name, part] of Object.entries({ config: 'config', state: 'state', task_files: 'task-files', model_resources: 'model-resources',
    cache: 'cache', temp: 'temp', downloads: 'downloads', browser_home: 'browser-home' })) {
    const path = join(runtimeRoot, part); mkdirSync(path, { mode: 0o700 });
    const stat = lstatSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path: part, owned: true, identity: randomUUID(), device: String(stat.dev), inode: String(stat.ino) };
  }
  const policy: NativeWebPolicy = { version: 1, mode: 'native', runtimeIdentity, node: checked.node, npm: checked.npm, python: checked.python,
    npmLockSha256: checked.dependencies.lockSha256, toolchainSha256: checked.toolchain.sha256, pythonRequirementsSha256: checked.toolchain.requirementsSha256,
    model: 'disabled', browser: 'disabled', transcription: 'disabled', ...(configuration.systemRoot ? { systemRoot: configuration.systemRoot } : {}) };
  const policyPath = join(runtimeRoot, 'config/local-web.policy.json');
  json(policyPath, policy);
  resources.local_web_policy = { kind: 'file', path: 'config/local-web.policy.json', identity: NATIVE_WEB_IDENTITY, sha256: sha256File(policyPath) };
  json(join(runtimeRoot, '.xuan-runtime.json'), { application: 'xuan-bd', version: 1, identity: runtimeIdentity });
  json(join(runtimeRoot, 'config/machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity, resources } satisfies MachineBindingDocument);
  json(join(runtimeRoot, 'config/tools.json'), {});
  const launcher: RuntimeLauncher = { version: 1, runtimeRoot, runtimeIdentity };
  // 必须先核同一个新根的资源身份，再写独立新 locator；不触碰系统用户目录中的原 locator。
  assertNativeWebResources(codeRoot, new ResourceBindings(runtimeRoot));
  json(launcherFile, launcher);
  json(join(runtimeRoot, 'preparation.json'), { version: 1, status: 'prepared', resourceMode: 'native', runtimeIdentity,
    model: 'disabled', browser: 'disabled', transcription: 'disabled', databaseBound: false, copiedCredentials: false });
  return readRuntimeLauncher(launcherFile);
}
export async function assertLocalPortAvailable(): Promise<void> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', () => reject(Object.assign(new Error('本机 4317 端口已占用或不可访问；未停止、连接或接管原实例。'), { code: 'EADDRINUSE' })));
    server.listen(4317, '127.0.0.1', () => server.close(error => error ? reject(error) : done()));
  });
}

async function main(): Promise<void> {
  const codeRoot = fileURLToPath(new URL('..', import.meta.url)), action = process.argv[2];
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(3)) {
    const match = /^--(config|node|npm-cli|python|system-root|launcher)=(.+)$/u.exec(arg);
    if (!match || args.has(match[1]!)) fail('LOCAL_WEB_ARGUMENTS', '参数无效或重复；所有程序与配置位置须显式给出。');
    args.set(match[1]!, match[2]!);
  }
  if (action === 'prepare') {
    if (args.size !== 1 || !args.has('config')) fail('LOCAL_WEB_ARGUMENTS', '用法：local-web.mjs prepare --config=绝对脱敏配置路径');
    console.log(JSON.stringify({ status: 'prepared', ...prepareLocalWeb(codeRoot, readLocalWebConfiguration(args.get('config')!)), model: 'disabled', databaseBound: false }));
  } else if (action === 'check') {
    if (args.has('launcher')) fail('LOCAL_WEB_ARGUMENTS', 'check 不读取旧定位记录；使用 --config 或显式 --node/--npm-cli/--python。');
    const configuration = args.has('config')
      ? (args.size === 1 ? readLocalWebConfiguration(args.get('config')!) : fail('LOCAL_WEB_ARGUMENTS', '--config 不能混合其他覆盖。'))
      : { node: args.get('node') ?? '', npmCli: args.get('npm-cli') ?? '', python: args.get('python') ?? '', systemRoot: args.get('system-root') };
    const checked = checkLocalWeb(codeRoot, configuration);
    console.log(JSON.stringify({ status: 'ready', node: checked.node.version, npm: checked.npm.version, python: checked.python.version,
      nodePackages: checked.dependencies.checked, optionalNodePackagesMissing: checked.dependencies.optionalMissing, model: 'disabled', databaseBound: false }));
  } else if (action === 'start') {
    if (args.size !== 1 || !args.has('launcher')) fail('LOCAL_WEB_ARGUMENTS', 'native 启动必须仅显式指定 --launcher=绝对定位文件；不发现私人 locator。');
    const launcherFile = absolute(args.get('launcher')), launcher = readRuntimeLauncher(launcherFile);
    assertNativeWebResources(codeRoot, new ResourceBindings(launcher.runtimeRoot));
    await assertLocalPortAvailable();
    const { runWeb } = await import('./web.js');
    await runWeb([`--launcher=${launcherFile}`]);
  } else fail('LOCAL_WEB_ARGUMENTS', '用法：local-web.mjs check|prepare|start；无自动安装、旧环境发现或状态接管。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LOCAL_WEB_FAILED';
    console.error(`${code}: ${error instanceof Error ? error.message : '本地 Web 准备未完成；已保留现场。'}`);
    process.exitCode = 1;
  }
}

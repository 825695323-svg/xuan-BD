import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseModelConfiguration } from '../platform/config/model.js';
import { BundledResources } from '../platform/resources/bundled.js';
import { launcherPath, type MachineBindingDocument } from '../platform/resources/bindings.js';
import { readRuntimeLauncher, type RuntimeLauncher } from '../platform/runtime/runtime-profile.js';
import { apiSourceSetupReminders } from '../plugins/api-sources/index.js';

export interface PrepareRuntimeOptions {
  codeRoot: string;
  /** 唯一空运行根本身；必须是不存在的规范绝对路径。 */
  runtimeBase: string;
  modelConfigurationFile: string;
  launcherFile: string;
  /** Windows 用户明确选定的系统根；不从环境或系统目录猜测。 */
  systemRoot?: string;
}
function newPath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path
    || realpathSync(dirname(path)) !== dirname(path) || lstatSync(path, { throwIfNoEntry: false })) throw new Error('准备位置须为真实父目录下尚不存在的规范绝对路径；不会覆盖既有状态。');
  return path;
}
function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** 目标机显式准备单个空运行根；复用既有资源绑定，不复制状态或密钥。 */
export function prepareRuntime(options: PrepareRuntimeOptions): RuntimeLauncher {
  const bundle = new BundledResources(options.codeRoot);
  const runtimeRoot = newPath(options.runtimeBase), launcher = newPath(options.launcherFile);
  const modelStat = lstatSync(options.modelConfigurationFile);
  if (!isAbsolute(options.modelConfigurationFile) || !modelStat.isFile() || modelStat.isSymbolicLink() || modelStat.nlink !== 1 || modelStat.size > 128_000) throw new Error('需要目标机上明确提供的模型配置文件。');
  const model = parseModelConfiguration(JSON.parse(readFileSync(options.modelConfigurationFile, 'utf8')));
  if (process.platform === 'win32' && model.credential.kind === 'keychain') throw new Error('Windows 须重新提供目标机凭据引用，不能采用 macOS 钥匙串。');
  if (model.credential.kind === 'dsh-ref') {
    model.credential.path = model.credential.path.startsWith('~/') ? resolve(homedir(), model.credential.path.slice(2))
      : resolve(dirname(options.modelConfigurationFile), model.credential.path);
  }
  const selected = bundle.selectedBindings();
  if (process.platform === 'win32') {
    if (!options.systemRoot || !isAbsolute(options.systemRoot) || realpathSync(options.systemRoot) !== options.systemRoot
      || !lstatSync(options.systemRoot).isDirectory()) throw new Error('Windows 需要明确选择真实系统根以登记必要环境与终止程序。');
    const taskkill = join(options.systemRoot, 'System32', 'taskkill.exe');
    if (!lstatSync(taskkill).isFile()) throw new Error('所选系统根缺少 taskkill.exe，不能可靠取消受控子进程。');
    selected.system_root = { kind: 'directory', path: options.systemRoot };
    selected.taskkill = { kind: 'program', path: taskkill };
  } else if (options.systemRoot !== undefined) throw new Error('此平台不接受 Windows 系统根参数。');
  bundle.verify();
  // 所有只读校验完成后才创建；失败保留原现场，绝不重置已有根。
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const runtimeIdentity = randomUUID();
  const resources: MachineBindingDocument['resources'] = { ...selected };
  for (const [id, part] of Object.entries({ config: 'config', state: 'state', task_files: 'task-files', model_resources: 'model-resources', cache: 'cache', temp: 'temp', downloads: 'downloads', browser_home: 'browser-home' })) {
    const path = join(runtimeRoot, part); mkdirSync(path, { mode: 0o700 });
    const stat = lstatSync(path, { bigint: true });
    resources[id] = { kind: 'directory', path: part, owned: true, identity: randomUUID(), device: String(stat.dev), inode: String(stat.ino) };
  }
  json(join(runtimeRoot, '.xuan-runtime.json'), { application: 'xuan-bd', version: 1, identity: runtimeIdentity });
  json(join(runtimeRoot, 'config', 'machine.bindings.json'), { version: 1, revision: 1, runtimeIdentity, resources } satisfies MachineBindingDocument);
  json(join(runtimeRoot, 'config', 'model.json'), model);
  json(join(runtimeRoot, 'config', 'tools.json'), { whisperModelPath: selected.whisper_base!.path });
  const value: RuntimeLauncher = { version: 1, runtimeRoot, runtimeIdentity };
  json(launcher, value);
  json(join(runtimeRoot, 'preparation.json'), { version: 1, status: 'prepared', runtimeRoot, runtimeIdentity, platform: bundle.platform,
    manifestSha256: bundle.manifestSha256, launcherFile: launcher, modelConfigurationSource: options.modelConfigurationFile,
    copiedCredentials: false, databaseBound: false });
  return readRuntimeLauncher(launcher);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = new Map<string, string>();
    for (const value of process.argv.slice(2)) {
      const match = /^--(runtime-base|model-config|launcher|system-root)=(.+)$/u.exec(value);
      if (!match || args.has(match[1]!)) throw new Error('准备参数无效或重复。');
      args.set(match[1]!, match[2]!);
    }
    const targetLauncher = args.get('launcher') ?? launcherPath();
    if (!lstatSync(dirname(targetLauncher), { throwIfNoEntry: false })) mkdirSync(dirname(targetLauncher), { recursive: true, mode: 0o700 });
    const result = prepareRuntime({ codeRoot: fileURLToPath(new URL('..', import.meta.url)), runtimeBase: args.get('runtime-base') ?? '',
      modelConfigurationFile: args.get('model-config') ?? '', launcherFile: targetLauncher, systemRoot: args.get('system-root') });
    const apiSources = await apiSourceSetupReminders(result.runtimeIdentity);
    console.log(JSON.stringify({ status: 'prepared', runtimeRoot: result.runtimeRoot, runtimeIdentity: result.runtimeIdentity, databaseBound: false, apiSources }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '目标机准备未完成，已保留现场。'); process.exitCode = 1;
  }
}

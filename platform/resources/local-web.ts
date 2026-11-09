import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BundledResources } from './bundled.js';
import type { ResourceBindings } from './bindings.js';
import { assertNodeVersion, checkNodeDependencies, checkNpm, checkPython, fail, inspectProgram, readJson, sha256File, type ProgramPin } from './native-check.mjs';

export const NATIVE_WEB_IDENTITY = 'xuan-local-web-native/v1';
export const NATIVE_BROWSER_UNAVAILABLE = '本地 Web native 策略明确禁用浏览器与站点采集；未登记浏览器资源，不会搜索系统浏览器或旧守护进程。';
export const NATIVE_TRANSCRIPTION_UNAVAILABLE = '本地 Web native 策略明确禁用音视频转录；未登记转录程序或模型，不影响材料表格处理。';
export interface NativeWebPolicy {
  version: 1;
  mode: 'native';
  runtimeIdentity: string;
  node: ProgramPin;
  npm: ProgramPin;
  python: ProgramPin;
  npmLockSha256: string;
  toolchainSha256: string;
  pythonRequirementsSha256: string;
  model: 'disabled';
  browser: 'disabled';
  transcription: 'disabled';
  systemRoot?: string;
}
export interface ApplicationResources {
  mode: 'bundled' | 'native';
  modelDisabled: boolean;
  whisperModelPath?: string;
  browserUnavailableReason?: string;
  transcriptionUnavailableReason?: string;
  browser(): { daemonScript: string; daemonSha256: string };
}
function equalPin(expected: ProgramPin, actual: ProgramPin): boolean {
  return !!expected && Object.keys(expected).sort().join(',') === 'path,sha256,version'
    && expected.path === actual.path && expected.sha256 === actual.sha256 && expected.version === actual.version;
}
/** 只有显式绑定并固定摘要的 native 策略可以选择原生依赖；缺包永不触发自动降级。 */
export function assertNativeWebResources(codeRoot: string, resources: ResourceBindings): NativeWebPolicy {
  const binding = resources.document.resources.local_web_policy;
  if (!binding || binding.kind !== 'file' || binding.owned || binding.identity !== NATIVE_WEB_IDENTITY || !binding.sha256) {
    fail('LOCAL_WEB_POLICY_UNVERIFIED', '原生本地 Web 策略必须经显式准备绑定并通过原摘要核对。');
  }
  // 先拒绝链接、超限或非普通文件，不能为计算摘要先读取未核定对象。
  const value = readJson(resources.path('local_web_policy')) as NativeWebPolicy;
  if (sha256File(resources.path('local_web_policy')) !== binding.sha256) fail('LOCAL_WEB_POLICY_UNVERIFIED', '原生本地 Web 策略摘要已变化。');
  const keys = ['version', 'mode', 'runtimeIdentity', 'node', 'npm', 'python', 'npmLockSha256', 'toolchainSha256', 'pythonRequirementsSha256', 'model', 'browser', 'transcription', ...(value.systemRoot !== undefined ? ['systemRoot'] : [])];
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.version !== 1 || value.mode !== 'native'
    || value.runtimeIdentity !== resources.document.runtimeIdentity || value.model !== 'disabled' || value.browser !== 'disabled' || value.transcription !== 'disabled') {
    fail('LOCAL_WEB_POLICY_INVALID', '本地 Web native 首版只支持显式禁用模型、浏览器和转录的基础数据宿主。');
  }
  if (resources.document.resources.bundle_manifest || ['browser_engine', 'ffmpeg', 'ffprobe', 'whisper_cli', 'whisper_base', 'yt_dlp'].some(name => resources.document.resources[name])) {
    fail('LOCAL_WEB_POLICY_MIXED', '不能把 native 策略混入原随包身份或启用未验证的可选资源；现有身份须走原维护入口。');
  }
  const toolchain = assertNodeVersion(codeRoot), node = inspectProgram(resources.program('node'));
  if (realpathSync(process.execPath) !== node.canonical || !equalPin(value.node, { path: node.path, sha256: node.sha256, version: process.versions.node })
    || resources.document.resources.node?.sha256 !== node.sha256 || resources.document.resources.python?.sha256 !== value.python?.sha256) {
    fail('LOCAL_WEB_PROGRAM_CHANGED', '当前 Node/Python 不再是显式采用的原程序与摘要；不会换用其他安装。');
  }
  if (process.platform === 'win32') {
    if (!value.systemRoot || resources.path('system_root') !== value.systemRoot
      || resources.program('taskkill') !== join(value.systemRoot, 'System32', 'taskkill.exe')) fail('LOCAL_WEB_WINDOWS_SYSTEM_ROOT', 'Windows 系统控制资源未明确绑定。');
    const taskkill = inspectProgram(resources.program('taskkill'));
    if (resources.document.resources.taskkill?.sha256 !== taskkill.sha256) fail('LOCAL_WEB_PROGRAM_CHANGED', 'Windows 终止程序摘要变化。');
  }
  const dependencies = checkNodeDependencies(codeRoot);
  if (value.npmLockSha256 !== dependencies.lockSha256 || value.toolchainSha256 !== toolchain.sha256 || value.pythonRequirementsSha256 !== toolchain.requirementsSha256) {
    fail('LOCAL_WEB_LOCK_CHANGED', '运行身份固定的源码依赖锁已变化；请明确核对新版本，不改写旧任务或自动重新绑定。');
  }
  const npm = checkNpm(codeRoot, value.npm?.path, value.systemRoot);
  const python = checkPython(codeRoot, resources.program('python'), value.systemRoot);
  if (!equalPin(value.npm, npm) || !equalPin(value.python, { path: python.path, sha256: python.sha256, version: python.version })) {
    fail('LOCAL_WEB_PROGRAM_CHANGED', 'npm/Python 原生依赖不再匹配已采用程序。');
  }
  return value;
}
/** 原 bundled 模式核验保持原样；native 是明确的新根策略，不是旧包缺失时的 fallback。 */
export function applicationResources(codeRoot: string, resources: ResourceBindings): ApplicationResources {
  if (resources.document.resources.local_web_policy) {
    assertNativeWebResources(codeRoot, resources);
    return { mode: 'native', modelDisabled: true, browserUnavailableReason: NATIVE_BROWSER_UNAVAILABLE,
      transcriptionUnavailableReason: NATIVE_TRANSCRIPTION_UNAVAILABLE,
      browser: () => fail('LOCAL_WEB_BROWSER_DISABLED', NATIVE_BROWSER_UNAVAILABLE) };
  }
  const bundle = new BundledResources(codeRoot);
  bundle.assertBindings(resources);
  return { mode: 'bundled', modelDisabled: false, whisperModelPath: bundle.model('whisper_base'), browser: () => bundle.browser() };
}

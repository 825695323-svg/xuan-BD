import { readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只写新配置模板；不安装依赖、不创建运行根、不采用 WFD/模型/浏览器连接。
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
try {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(toolchain|python|runtime-root|launcher|output)=(.+)$/u.exec(arg);
    if (!match || args[match[1]]) throw new Error('参数无效或重复。');
    args[match[1]] = match[2];
  }
  for (const key of ['toolchain','python','runtime-root','launcher','output']) {
    if (!args[key] || !isAbsolute(args[key]) || resolve(args[key]) !== args[key])
      throw new Error(`需要规范绝对路径：--${key}=...`);
  }
  const receipt = JSON.parse(readFileSync(resolve(args.toolchain, 'recipe-receipt.json'), 'utf8'));
  const pin = JSON.parse(readFileSync(resolve(root, 'config/local-web-toolchain.json'), 'utf8'));
  if (receipt.profile !== 'toolchain' || ['node','npm','python'].some(key => receipt.toolchain?.[key] !== pin[key]))
    throw new Error('工具链回执与仓库版本不符。');
  for (const key of ['node','npmCli']) {
    if (typeof receipt[key] !== 'string' || !isAbsolute(receipt[key]) || !existsSync(receipt[key]))
      throw new Error('工具链程序路径缺失。');
    const inside = relative(realpathSync(args.toolchain), realpathSync(receipt[key]));
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('工具链程序路径越出所选目录。');
  }
  if (!existsSync(args.python)) throw new Error('先创建并安装明确的 Python 虚拟环境。');
  for (const key of ['runtime-root','launcher','output']) {
    const path = args[key], parent = dirname(path), inside = relative(root, path);
    if (!inside || !inside.startsWith('..') && !isAbsolute(inside) || existsSync(path)
      || realpathSync(parent) !== parent) throw new Error('配置、运行根和定位文件须是仓库外、真实父目录中的全新路径。');
  }
  if (new Set([args['runtime-root'], args.launcher, args.output]).size !== 3) throw new Error('输出路径不能重合。');
  const config = { version: 1, resourceMode: 'native', runtimeRoot: args['runtime-root'],
    launcherFile: args.launcher, node: receipt.node, npmCli: receipt.npmCli, python: args.python,
    model: 'disabled', browser: 'disabled', transcription: 'disabled',
    ...(process.platform === 'win32' ? { systemRoot: realpathSync(process.env.SystemRoot ?? 'C:\\Windows') } : {}) };
  writeFileSync(args.output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('LOCAL_CONFIG_CREATED: 已生成隔离原生配置；须继续执行 local:check 与 local:prepare。');
} catch (error) {
  console.error('LOCAL_CONFIG_FAILED: ' + error.message);
  process.exitCode = 1;
}

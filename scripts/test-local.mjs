import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { absolute, assertNodeVersion, checkNodeDependencies, checkPython, isolatedPythonArgs, nativeEnvironment } from '../platform/resources/native-check.mjs';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
try {
  let python, systemRoot, all = false, pythonOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--all' && !all) all = true;
    else if (arg === '--python-only' && !pythonOnly) pythonOnly = true;
    else if (arg.startsWith('--python=') && python === undefined) python = absolute(arg.slice('--python='.length));
    else if (arg.startsWith('--system-root=') && systemRoot === undefined) systemRoot = absolute(arg.slice('--system-root='.length));
    else throw new Error('用法：npm test [-- --all --python=绝对解释器]；或 npm run test:python -- --python=绝对解释器。');
  }
  if (all && pythonOnly) throw new Error('--all 与 --python-only 不能混用。');
  if (!all && !pythonOnly && python) throw new Error('Python 参数须搭配 --all 或使用 test:python；TS 实证可显式设置 WFD_PYTHON。');
  assertNodeVersion(codeRoot);
  checkNodeDependencies(codeRoot);
  python ??= process.env.WFD_PYTHON ? absolute(process.env.WFD_PYTHON) : undefined;
  if (all || pythonOnly) {
    if (!python) throw new Error('Python 测试需要显式 --python=绝对解释器 或 WFD_PYTHON；不会使用系统 python3 或私人 locator。');
    checkPython(codeRoot, python, systemRoot);
  }
  const testRoot = process.env.XUAN_TEST_ROOT ? absolute(process.env.XUAN_TEST_ROOT) : undefined;
  const env = { ...nativeEnvironment(systemRoot), ...(testRoot ? { XUAN_TEST_ROOT: testRoot, TMPDIR: testRoot, TEMP: testRoot, TMP: testRoot } : {}),
    ...(python ? { WFD_PYTHON: python } : {}), ...(process.env.XUAN_TEST_NPM_CLI ? { XUAN_TEST_NPM_CLI: absolute(process.env.XUAN_TEST_NPM_CLI) } : {}),
    ...(process.env.POLARS_PYTHON ? { POLARS_PYTHON: absolute(process.env.POLARS_PYTHON) } : {}),
    ...(process.env.XUAN_FULL_CHAIN_ROOT ? { XUAN_FULL_CHAIN_ROOT: absolute(process.env.XUAN_FULL_CHAIN_ROOT) } : {}),
    ...(process.env.POLARS_FINANCIAL_FIXTURE ? { POLARS_FINANCIAL_FIXTURE: absolute(process.env.POLARS_FINANCIAL_FIXTURE) } : {}),
    PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1' };
  function run(executable, args) {
    const result = spawnSync(executable, args, { cwd: codeRoot, env, stdio: 'inherit', windowsHide: true });
    if (result.error || result.signal || result.status !== 0) throw new Error(`测试命令未通过（exit=${result.status ?? 'unknown'}）；未重试或换用其他程序。`);
  }
  if (!pythonOnly) {
    // Node HTTP tests also spawn Python; nativeEnvironment intentionally drops ambient
    // variables, so create a fresh read-cache prefix here instead of relying on the shell.
    const nodeCacheRoot = mkdtempSync(join(testRoot ?? absolute(tmpdir()), 'node-unit-cache-'));
    env.PYTHONPYCACHEPREFIX = join(nodeCacheRoot, 'isolated-pycache');
    env.PYTHONNOUSERSITE = '1';
    // 在 JS 中枚举，避免 Windows shell 不展开通配符或空匹配导致 Node 自动发现其他测试。
    const files = [...['modules/collection', 'modules/collection/data-processing', 'apps/server', 'platform/resources',
      'platform/capabilities/conversion', 'plugins/api-sources', 'plugins/api-sources/providers/werss', 'plugins/api-sources/providers/wechat'].flatMap(directory =>
      readdirSync(join(codeRoot, directory), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
        .map(entry => join(directory, entry.name))),
      'scripts/adopt-product-machine-wiring.test.ts', 'scripts/adopt-polars-python.test.ts'].sort();
    if (!files.length) throw new Error('没有发现明确的 TypeScript 单元测试入口。');
    run(process.execPath, ['--import', 'tsx', '--test', ...files]);
  }
  if (all || pythonOnly) {
    // pytest 会清空 basetemp；只给本轮刚创建的唯一空目录，绝不复用或清空旧证据目录。
    const baseTemp = mkdtempSync(join(testRoot ?? absolute(tmpdir()), 'pytest-unit-'));
    const cacheRoot = join(baseTemp, 'isolated-pycache');
    // Non-isolated child test processes inherit the same fresh read-cache prefix.
    env.PYTHONPYCACHEPREFIX = cacheRoot;
    // -I removes ambient imports; -B alone would still read old compiled tests.
    // Keep pythonpath relative to the pinned root so spaces are not split by ini parsing.
    run(python, isolatedPythonArgs(cacheRoot, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', codeRoot,
      '-o', 'pythonpath=wfd/product', 'wfd/product/tests', '-m', 'not integration', '--basetemp', baseTemp]));
  }
} catch (error) {
  console.error(`${error.code ?? 'LOCAL_TEST_FAILED'}: ${error.message}`);
  process.exitCode = 1;
}

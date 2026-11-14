import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { absolute, assertNodeVersion, checkNodeDependencies, checkPython, isolatedPythonArgs, nativeEnvironment } from '../platform/resources/native-check.mjs';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const ownedTestRoots = [];
let success = false, keepFixtures = false;
try {
  let python, systemRoot, all = false, pythonOnly = false, pipelineOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--all' && !all) all = true;
    else if (arg === '--keep-fixtures' && !keepFixtures) keepFixtures = true;
    else if (arg === '--python-only' && !pythonOnly) pythonOnly = true;
    else if (arg === '--pipeline' && !pipelineOnly) pipelineOnly = true;
    else if (arg.startsWith('--python=') && python === undefined) python = absolute(arg.slice('--python='.length));
    else if (arg.startsWith('--system-root=') && systemRoot === undefined) systemRoot = absolute(arg.slice('--system-root='.length));
    else throw new Error('用法：npm test [-- --all --python=绝对解释器]；或 npm run test:python -- --python=绝对解释器。');
  }
  if (all && pythonOnly || pipelineOnly && (all || pythonOnly))
    throw new Error('--pipeline、--all 与 --python-only 是互斥的验收模式。');
  if (!all && !pythonOnly && !pipelineOnly && python)
    throw new Error('Python 参数须搭配 --all、--pipeline 或使用 test:python；普通测试可显式设置 WFD_PYTHON。');
  assertNodeVersion(codeRoot);
  checkNodeDependencies(codeRoot);
  python ??= process.env.WFD_PYTHON ? absolute(process.env.WFD_PYTHON) : undefined;
  if (all || pythonOnly || pipelineOnly) {
    if (!python) throw new Error('正式管路与 Python 验收需要显式 --python=绝对解释器 或 WFD_PYTHON；不会发现或猜测系统解释器。');
    checkPython(codeRoot, python, systemRoot);
  }
  // 每次测试只在用户选定的父目录下创建全新一次性实例。
  // 绝不复用旧实例的 SQLite、来源绑定、WFD 测试数据或全链回执。
  if (pipelineOnly && !process.env.XUAN_FULL_CHAIN_ROOT)
    throw new Error('正式 BD 管路验收需要明确 XUAN_FULL_CHAIN_ROOT（全链测试父目录），不能跳过实际 WFD 管路后报告通过。');
  const testRootParent = process.env.XUAN_TEST_ROOT ? absolute(process.env.XUAN_TEST_ROOT) : absolute(tmpdir());
  const testRoot = mkdtempSync(join(testRootParent, 'bd-pipeline-test-'));
  ownedTestRoots.push(testRoot);
  const fullChainRoot = process.env.XUAN_FULL_CHAIN_ROOT
    ? mkdtempSync(join(absolute(process.env.XUAN_FULL_CHAIN_ROOT), 'bd-full-chain-test-')) : undefined;
  if (fullChainRoot) ownedTestRoots.push(fullChainRoot);
  const env = { ...nativeEnvironment(systemRoot), XUAN_TEST_ROOT: testRoot, TMPDIR: testRoot, TEMP: testRoot, TMP: testRoot,
    ...(python ? { WFD_PYTHON: python } : {}), ...(process.env.XUAN_TEST_NPM_CLI ? { XUAN_TEST_NPM_CLI: absolute(process.env.XUAN_TEST_NPM_CLI) } : {}),
    ...(process.env.POLARS_PYTHON ? { POLARS_PYTHON: absolute(process.env.POLARS_PYTHON) } : {}),
    ...(fullChainRoot ? { XUAN_FULL_CHAIN_ROOT: fullChainRoot } : {}),
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
    const files = pipelineOnly
      ? ['modules/collection/source-field-profile.test.ts',
        'modules/collection/source-reported-table.test.ts',
        'modules/collection/financial-value-contracts.test.ts',
        'apps/server/financial-value-contracts.test.ts',
        'apps/server/endpoint-adapter-chain.test.ts',
        'apps/server/endpoint-adapter-r1.test.ts']
      : [...['modules/collection', 'modules/collection/data-processing', 'apps/server', 'platform/config', 'platform/resources',
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
    env.PYTHONPYCACHEPREFIX = cacheRoot;
    // -I removes ambient imports; -B alone would still read old compiled tests.
    run(python, isolatedPythonArgs(cacheRoot, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', codeRoot,
      '-o', 'pythonpath=wfd/product', 'wfd/product/tests', '-m', 'not integration', '--basetemp', baseTemp]));
  }
  success = true;
} catch (error) {
  console.error(`${error.code ?? 'LOCAL_TEST_FAILED'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  // 只删除本调用使用 mkdtemp 创建的目录；用户运行根、旧测试记录及正式 WFD 永不清理。
  if (success && !keepFixtures) {
    for (const path of ownedTestRoots.reverse()) rmSync(path, { recursive: true, force: true });
  } else {
    for (const path of ownedTestRoots) console.error('本轮隔离测试证据保留：' + path);
  }
}

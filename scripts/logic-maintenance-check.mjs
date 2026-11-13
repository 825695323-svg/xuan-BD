import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** 已清理模块的未使用声明门禁；其他模块的历史告警明确报告，不静默宣称全仓清零。 */
export const CLEANED_LOGIC_FILES = new Set([
  'apps/server/workspace-routes.ts', 'apps/server/source-settings-routes.ts',
  'apps/server/logic-cleanup.test.ts',
  'apps/web/src/App.tsx',
  'apps/web/src/ui/ToolsPage.tsx', 'apps/web/src/ui/SettingsPage.tsx',
  'apps/web/src/ui/useStoredSelection.ts', 'apps/web/src/ui/logic-cleanup.test.tsx',
  'modules/financial/algorithm-definitions.ts', 'modules/financial/algorithm-registry.ts',
  'modules/financial/conversation-algorithms.ts', 'modules/financial/tool-library.ts',
  'modules/financial/basic-algorithm-tool-contract.ts',
  'plugins/api-sources/operations.ts',
]);
const unusedCodes = new Set(['6133', '6138', '6192', '6196', '6198', '6199']);
export function classifyDiagnostics(output, checked = CLEANED_LOGIC_FILES) {
  const failures = [], deferred = [];
  for (const line of output.split(/\r?\n/u).filter(line => line.trim())) {
    const match = /^(.*?)\(\d+,\d+\): error TS(\d+): /u.exec(line);
    const file = match?.[1].replaceAll('\\', '/').replace(/^\.\//u, '');
    // 非未使用声明错误、未知输出和本轮清理模块的告警都必须失败。
    if (!match || !unusedCodes.has(match[2]) || checked.has(file)) failures.push(line);
    else deferred.push(line);
  }
  return { failures, deferred };
}
export function runMaintenanceCheck() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false',
    '--noUnusedLocals', '--noUnusedParameters'], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error(`LOGIC_CHECK_TOOL_FAILED: 未完成类型检查：${result.error?.message ?? result.signal}`);
  const { failures, deferred } = classifyDiagnostics(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (failures.length || result.status !== 0 && !deferred.length) {
    throw new Error(`LOGIC_CHECK_FAILED: 清理范围内存在未使用声明，或类型检查失败。\n${failures.join('\n')}`);
  }
  console.log(`LOGIC_MAINTENANCE_OK: ${CLEANED_LOGIC_FILES.size} 个已清理文件没有未使用声明。`);
  console.log(`DEFERRED_UNUSED_DIAGNOSTICS: 其他模块仍有 ${deferred.length} 条历史告警；未作为本轮已清理内容。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runMaintenanceCheck(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

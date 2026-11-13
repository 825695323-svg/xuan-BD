import type { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { TaskError, type TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import { runDirectProcess } from '../../../platform/runtime/process.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';

/** 只封闭正式入口的实际依赖；不把其余算法或取数函数暴露为插件。 */
export const ASSET_FILES = ['_common.py', 'calculate.py', 'indicators.py', 'operators.py'] as const;
export const MAX_ASSET_BYTES = 512_000;
export interface FinancialAssetBundle {
  version: string;
  files: Record<string, string>;
  hashes: Record<string, string>;
}
export function financialDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function captureAssets(root: string): FinancialAssetBundle {
  if (!isAbsolute(root)) throw new TaskError('FINANCIAL_ASSETS_UNAVAILABLE', '计算资产必须由受信宿主提供绝对目录。');
  const canonicalRoot = realpathSync(root), files: Record<string, string> = {}, hashes: Record<string, string> = {};
  let total = 0;
  for (const name of ASSET_FILES) {
    const path = join(canonicalRoot, name), stat = lstatSync(path);
    if (!stat.isFile() || relative(canonicalRoot, realpathSync(path)) !== name) throw new TaskError('FINANCIAL_ASSETS_UNAVAILABLE', '计算实现必须是所核目录内的普通文件。');
    const bytes = readFileSync(path); total += bytes.length;
    if (total > MAX_ASSET_BYTES) throw new TaskError('FINANCIAL_ASSET_BUDGET', '封闭计算实现超过本包保管预算。');
    files[name] = bytes.toString('base64'); hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return { version: `sha256:${financialDigest(hashes)}`, files, hashes };
}
export function verifyAssets(bundle: FinancialAssetBundle): void {
  if (!bundle || typeof bundle !== 'object' || !bundle.files || !bundle.hashes
    || canonical(Object.keys(bundle.files).sort()) !== canonical([...ASSET_FILES].sort())
    || canonical(Object.keys(bundle.hashes).sort()) !== canonical([...ASSET_FILES].sort())) {
    throw new TaskError('FINANCIAL_IMPLEMENTATION_UNAVAILABLE', '原任务计算实现的依赖闭包不完整。');
  }
  let total = 0;
  for (const name of ASSET_FILES) {
    const encoded = bundle.files[name];
    if (typeof encoded !== 'string') throw new TaskError('FINANCIAL_IMPLEMENTATION_UNAVAILABLE', '原计算实现字节缺失。');
    const bytes = Buffer.from(encoded, 'base64'); total += bytes.length;
    if (bytes.toString('base64') !== encoded || createHash('sha256').update(bytes).digest('hex') !== bundle.hashes[name]) {
      throw new TaskError('FINANCIAL_IMPLEMENTATION_CHANGED', '原计算实现字节与固定摘要不符。');
    }
  }
  if (total > MAX_ASSET_BYTES || bundle.version !== `sha256:${financialDigest(bundle.hashes)}`) throw new TaskError('FINANCIAL_IMPLEMENTATION_CHANGED', '原计算实现版本摘要不符。');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TaskError('INVALID_FINANCIAL_ARGS', '金融契约只接受有限 JSON 值。');
}

export async function executeFinancialAssets(options: {
  bundle: FinancialAssetBundle;
  request: JsonValue;
  pythonExecutable: string;
  processRuntime: ProcessRuntime;
  cwd: string;
  context: TaskExecutionContext;
  assertAuthorized(): void;
}): Promise<JsonValue> {
  verifyAssets(options.bundle);
  const result = await runDirectProcess({ runtime: options.processRuntime, binary: 'python3', binaryPath: options.pythonExecutable,
    args: ['-I', '-S', '-B', '-c', PYTHON_BRIDGE], stdin: JSON.stringify({ files: options.bundle.files, request: options.request }),
    cwd: options.cwd, signal: options.context.signal, assertAuthorized: options.assertAuthorized,
    timeoutMs: 15_000, maxOutputBytes: 400_000,
    onProcessState: event => options.context.emit({ type: 'process_state', ...event }),
    onHeartbeat: event => options.context.emit({ type: 'heartbeat', ...event }) });
  try {
    const value = JSON.parse(result.stdout) as unknown;
    canonical(value);
    return value as JsonValue;
  } catch { throw new TaskError('FINANCIAL_OUTPUT_INVALID', '原计算入口没有返回有效有限 JSON，结果已拒绝。'); }
}

/** 首包仅执行已核本地第一方代码；审计钩子是执行约束，并非不可信包完整沙箱。 */
export const PYTHON_BRIDGE = String.raw`
import base64, importlib.abc, importlib.util, json, math, os, sys, sysconfig
payload = json.load(sys.stdin)
files = payload['files']
request = payload['request']
if set(files) != {'_common.py', 'calculate.py', 'indicators.py', 'operators.py'}:
    raise ValueError('implementation closure mismatch')
if set(request) != {'version', 'kind', 'operation', 'params', 'data'}:
    raise ValueError('only explicit in-memory calculation input is permitted')
if (request['kind'], request['operation']) != ('indicator', 'MACD'):
    raise ValueError('operation is not registered')
parameters = request['params']
if (not isinstance(parameters, dict) or set(parameters) != {'short_period', 'long_period', 'signal_period', 'init'}
    or any(type(parameters[name]) is not int or parameters[name] != expected for name, expected in [('short_period', 12), ('long_period', 26), ('signal_period', 9)])
    or parameters['init'] != 'first_valid'):
    raise ValueError('MACD requires fixed 12/26/9 and explicit first_valid initialization; continuation is not supported')
stdlib = os.path.realpath(sysconfig.get_path('stdlib'))
def allowed_path(path):
    if isinstance(path, int):
        return False
    try:
        return os.path.commonpath([stdlib, os.path.realpath(os.fsdecode(path))]) == stdlib
    except (TypeError, ValueError):
        return False
def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'ctypes.')) or event in {'os.system', 'os.fork', 'os.forkpty', 'os.posix_spawn', 'os.exec', 'pty.spawn'}:
        raise PermissionError('network and child execution are disabled')
    if event == 'open':
        path, mode, flags = args
        if (isinstance(mode, str) and any(flag in mode for flag in 'wax+')) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)) or not allowed_path(path):
            raise PermissionError('calculation cannot open user data or write files')
    if event in {'os.listdir', 'os.scandir'} and not allowed_path(args[0]):
        raise PermissionError('calculation cannot inspect user directories')
sys.addaudithook(audit)
class FrozenLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        return importlib.util.spec_from_loader(fullname, self) if fullname + '.py' in files else None
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        name = module.__name__ + '.py'
        module.__file__ = '<frozen-financial-implementation>/' + name
        exec(compile(base64.b64decode(files[name], validate=True), module.__file__, 'exec'), module.__dict__)
sys.meta_path.insert(0, FrozenLoader())
try:
    import calculate
    result = calculate.execute(request)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
except (OSError, ValueError, TypeError, KeyError, OverflowError, ImportError) as exc:
    print(json.dumps({'ok': False, 'error': str(exc), 'execution_executed': False}, ensure_ascii=False, allow_nan=False))
    # 包装进程成功交回明确失败结果；计算是否完成由宿主核原响应，不靠进程退出码冒充。
    sys.exit(0)
`;

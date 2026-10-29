import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import type { SourceConnection } from '../../../../contracts/source-settings.js';
import type { TaskExecutionContext } from '../../../../platform/jobs/tasks.js';
import { readDshCredential, readKeychainCredential } from '../../../../platform/config/model.js';
import { acquireAuthority, DirectError, directoryCapability, fileCapability } from '../../../../platform/runtime/file-workspace.js';
import type { ProcessRuntime } from '../../../../platform/runtime/programs.js';
import { DirectProcessError, runDirectProcess } from '../../../../platform/runtime/process.js';
import { tdxSource } from './api.js';

export interface TdxPackageBinding { path: string; sha256: string }
const PACKAGE_SHA256 = 'ceaf0be18cb54cd197e79cca5590d4ba7d7c3620b899e818d472d032f2c33849';
const UPSTREAMS = ['tcp://aihs.tdx.com.cn:7709', 'tcp://aihs2.tdx.com.cn:7709', 'tcp://aids.tdx.com.cn:7727'] as const;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

// 子进程只使用固定分钟读取；密钥仅经标准输入进入0600临时INI，原生诊断不返回宿主。
const WORKER = String.raw`
import sys, os, json, zipfile, configparser, importlib
from pathlib import Path
request = json.load(sys.stdin)
root = Path.cwd()
lib = root / 'tdxaidata' / 'lib'
lib.mkdir(parents=True, exist_ok=True)
ini = lib / 'TdxAiData.ini'
raw = []
result = {'ok': False, 'code': 'TDX_SDK_UNAVAILABLE'}
output = os.dup(1)
null = os.open(os.devnull, os.O_WRONLY)
os.dup2(null, 1)
os.dup2(null, 2)
try:
    native = 'TdxAiData.dll' if sys.platform == 'win32' else 'libTdxAiData.dylib'
    members = ['tdxaidata/__init__.py', 'tdxaidata/tdxaidata.py', 'tdxaidata/lib/' + native]
    if sys.platform == 'win32':
        members += ['tdxaidata/lib/mfc100.dll', 'tdxaidata/lib/msvcp100.dll', 'tdxaidata/lib/msvcr100.dll']
    with zipfile.ZipFile(request['package']) as package:
        for name in members:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, 'xb') as stream:
                stream.write(package.read(name))
        template = package.read('tdxaidata/lib/TdxAiData.ini').decode('utf-8-sig')
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config.read_string(template)
    token = request['credential']
    if not isinstance(token, str) or not token or any(c in token for c in '\r\n\x00'):
        raise ValueError('credential')
    if not config.has_section('Token'):
        config.add_section('Token')
    for key in list(config['Token']):
        config.remove_option('Token', key)
    config.set('Token', 'token', token)
    descriptor = os.open(ini, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        config.write(stream)
    sys.path.insert(0, str(root))
    module = importlib.import_module('tdxaidata.tdxaidata')
    original = module._NativeTdxAiData.get_his_dats
    def capture(self, *args):
        response = original(self, *args)
        raw.append(response)
        return response
    module._NativeTdxAiData.get_his_dats = capture
    module.tqs.get_market_data(field_list=['Open', 'High', 'Low', 'Close', 'Volume', 'Amount'],
        stock_list=[request['symbol']], period='1m', end_time=request['end'],
        count=request['count'], dividend_type='none', fill_data=False)
    if len(raw) != 1 or not isinstance(raw[0], str) or len(raw[0].encode('utf-8')) > 1800000:
        result = {'ok': False, 'code': 'TDX_RESPONSE_INVALID'}
    elif token in raw[0]:
        result = {'ok': False, 'code': 'TDX_RESPONSE_SENSITIVE'}
    else:
        value = json.loads(raw[0])
        if not isinstance(value, dict):
            result = {'ok': False, 'code': 'TDX_RESPONSE_INVALID'}
        elif str(value.get('ErrorId', 0)) != '0' or 'error' in value:
            # 错误原文可能回显认证信息，只返回封闭错误码。
            result = {'ok': False, 'code': 'TDX_SERVICE_REJECTED'}
        else:
            result = {'ok': True, 'raw': raw[0]}
except BaseException:
    result = {'ok': False, 'code': 'TDX_SDK_FAILED'}
finally:
    try:
        ini.unlink(missing_ok=True)
    except BaseException:
        result = {'ok': False, 'code': 'TDX_CREDENTIAL_CLEANUP_FAILED'}
    with os.fdopen(output, 'wb') as stream:
        stream.write(json.dumps(result, ensure_ascii=True, allow_nan=False).encode('utf-8'))
`;

export function tdxAvailability(connection: SourceConnection, tdxaidataPackage?: TdxPackageBinding, processRuntime?: ProcessRuntime): { available: boolean; reason?: string } {
  if (connection.tdxMode === 'client_http') return { available: false, reason: '当前适配仅支持官方后台开发包；本机客户端HTTP服务未核验，不作为可用来源。' };
  if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) return { available: false, reason: '当前执行平台尚未验入此适配。' };
  if (!connection.credential) return { available: false, reason: '尚未配置数据服务类型密钥的安全引用。' };
  if (!tdxaidataPackage || tdxaidataPackage.sha256 !== PACKAGE_SHA256) return { available: false, reason: '通达信1.2.2开发包尚未受控绑定。' };
  try {
    const stat = lstatSync(tdxaidataPackage.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('package');
    if (!processRuntime) throw new Error('runtime');
    processRuntime.path('python3');
  } catch { return { available: false, reason: '已登记开发包或Python（解释器）执行资源不可用。' }; }
  return { available: true };
}

export function tdxVersions(connection: SourceConnection, tdxaidataPackage?: TdxPackageBinding): unknown {
  return { adapter: 'tdx-minute/1', sdk: 'tdxaidata/1.2.2', packageSha256: tdxaidataPackage?.sha256 ?? null,
    packagePath: tdxaidataPackage?.path ?? null, workerSha256: digest(WORKER), mode: connection.tdxMode ?? 'data_service',
    transport: 'native-tcp', upstreams: UPSTREAMS, period: '1m', adjustment: 'none', fillData: false };
}

/** 受信装配只传已登记的开发包文件；不安装、搜索开发包或执行任意供应商函数。 */
export async function readTdxMinutes(context: TaskExecutionContext, connection: SourceConnection,
  parameters: Record<string, JsonValue>, processRuntime?: ProcessRuntime, tdxaidataPackage?: TdxPackageBinding): Promise<{
    url: string; status: null; bytes: Buffer; contentType: string; observedAt: string;
  }> {
  if (connection.pluginId !== 'tdx' || !connection.enabled || connection.baseUrl !== 'tdxaidata://data-service') throw new DirectError('SOURCE_TDX_CONNECTION_INVALID', '通达信读取需要当前启用的官方后台逻辑连接。');
  const available = tdxAvailability(connection, tdxaidataPackage, processRuntime);
  if (!available.available || !processRuntime || !tdxaidataPackage || !connection.credential) throw new DirectError('SOURCE_TDX_NOT_CONFIGURED', available.reason ?? '通达信后台开发包尚未配置。');
  const symbol = parameters.symbol, count = parameters.count ?? 5, end = parameters.end ?? '';
  if ((parameters.sourceId !== undefined && parameters.sourceId !== 'tdx') || Object.keys(parameters).some(key => !['sourceId', 'symbol', 'count', 'end'].includes(key))
    || typeof symbol !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/u.test(symbol)
    || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 500
    || typeof end !== 'string' || (end !== '' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(end))) {
    throw new DirectError('SOURCE_TDX_PARAMETERS_INVALID', '分钟读取限一个带市场后缀的A股代码、1至500条和可选结束时间；当前数量模式不接受起始时间或任意函数。');
  }
  const directory = processRuntime.directory('temp', `tdxaidata-${context.task.id}-${randomUUID()}`);
  let unknown = false;
  try {
    const authority = await acquireAuthority(context, 'source.tdx.minutes', { connectionId: connection.id, symbol, count, end, transport: 'native-tcp' }, [
      fileCapability('execute', processRuntime.path('python3')), fileCapability('read', tdxaidataPackage.path),
      ...['read', 'write', 'delete'].map(action => directoryCapability(action as 'read' | 'write' | 'delete', directory)),
      { action: 'secret', target: { kind: 'secret', name: `api-source.${connection.id}` } },
      ...UPSTREAMS.map(origin => ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
    ]);
    authority.assert();
    const packageBytes = readFileSync(tdxaidataPackage.path);
    if (digest(packageBytes) !== PACKAGE_SHA256) throw new DirectError('SOURCE_TDX_PACKAGE_CHANGED', '通达信开发包字节与固定版本不符，未执行。');
    const privatePackage = join(directory, 'tdxaidata.whl');
    writeFileSync(privatePackage, packageBytes, { flag: 'wx', mode: 0o600 });
    let key: string;
    try {
      const reference = connection.credential;
      key = reference.kind === 'keychain' ? await readKeychainCredential(reference.service, reference.account, processRuntime)
        : await readDshCredential(reference.path, reference.ref);
    } catch { throw new DirectError('SOURCE_CREDENTIAL_UNAVAILABLE', '未能读取所选安全凭据引用，未尝试其他密钥。'); }
    authority.assert();
    const effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '使用固定通达信官方开发包读取一份分钟行情',
      operation: { connectionId: connection.id, symbol, count, end, period: '1m', readOnly: true, packageSha256: PACKAGE_SHA256 } });
    let response;
    try {
      response = await runDirectProcess({ runtime: processRuntime, binary: 'python3',
        args: ['-I', '-S', '-c', WORKER], stdin: JSON.stringify({ package: privatePackage, credential: key, symbol, count, end }),
        cwd: directory, signal: context.signal, assertAuthorized: authority.assert, timeoutMs: 45_000, maxOutputBytes: 2_000_000,
        onProcessState: event => context.emit({ type: 'process_state', ...event }), onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }) });
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '本次读取进程及输出流已收束；行情业务状态和字段完整性随后核对，不代表正式数据提交。' });
    } catch (error) {
      if (!(error instanceof DirectProcessError && error.disposition === 'unknown')) await context.emit({ type: 'side_effect_result', effectId,
        outcome: error instanceof DirectProcessError && error.disposition === 'not_started' ? 'not_applied' : 'failed', evidence: '本次进程已确认未启动或已关闭，未宣称取得完整行情；不证明远端未收到读取请求。' });
      throw error;
    }
    authority.assert();
    let output: { ok?: boolean; raw?: string; code?: string };
    try { output = JSON.parse(response.stdout) as typeof output; } catch { throw new DirectError('SOURCE_TDX_RESPONSE_INVALID', '通达信进程未返回完整、可核对的封闭结果。'); }
    if (output.ok !== true || typeof output.raw !== 'string') throw new DirectError('SOURCE_TDX_READ_FAILED', '通达信分钟读取未通过；请核数据服务类型密钥、账号权限和依赖，未保存原生诊断或尝试其他密钥。');
    return { url: tdxSource.documentationUrl!, status: null, bytes: Buffer.from(output.raw, 'utf8'),
      contentType: 'application/json; charset=utf-8', observedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof DirectProcessError) {
      unknown = error.disposition === 'unknown';
      throw new DirectError(unknown ? 'SOURCE_TDX_PROCESS_UNKNOWN' : 'SOURCE_TDX_PROCESS_FAILED', unknown
        ? '通达信原进程尚未核定收束；保留原任务，禁止自动重发。' : '通达信读取进程未完成；未返回可能包含敏感内容的底层诊断。', unknown);
    }
    throw error;
  } finally {
    // 无论进程是否已核定，临时密钥都不能作为恢复材料保留。
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { throw new DirectError('SOURCE_TDX_PRIVATE_CLEANUP_FAILED', '本次通达信私有工作目录未完成清理；禁止将其中认证材料作为恢复证据，需沿原任务处理。', unknown); }
  }
}


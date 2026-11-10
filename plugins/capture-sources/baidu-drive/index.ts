import type { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import type { FileReferenceService } from '../../../platform/resources/files.js';
import { inspectPath, samePathIdentity, type PermissionCapability } from '../../../platform/security/permissions.js';
import type { SkillRegistration } from '../../../platform/plugins/registry.js';
import type { TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, fileCapability, prepareDestination } from '../../../platform/runtime/file-workspace.js';
import { DirectProcessError, runDirectProcess } from '../../../platform/runtime/process.js';

/** 受信宿主绑定；参数不能选择程序、账号、脚本或任意命令。 */
export interface BaiduDriveConfiguration { binaryPath: string; configPath: string; homePath?: string; tokenKeyPath?: string }
const OPERATIONS = ['whoami', 'ls', 'search', 'download', 'upload', 'transfer-list', 'transfer-select'] as const;
type Operation = typeof OPERATIONS[number];
type Args = Record<string, JsonValue>;
const LIMIT = 256 * 1024 * 1024;
const KEYS: Record<Operation, readonly string[]> = {
  whoami: [], ls: ['path', 'offset', 'limit'], search: ['query', 'page', 'limit'],
  download: ['path'], upload: ['path', 'fileRefId'],
  'transfer-list': ['shareUrl', 'path', 'page', 'limit'], 'transfer-select': ['shareUrl', 'path', 'fileIds'],
};
const NETWORK_ORIGINS = ['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'];

/** 行为借鉴已安装 DSH dsh-tool-baidu-drive 0.1.1；宿主权限和收束沿用当前核心。 */
export function validateBaiduArgs(args: Args): Operation {
  const operation = args.operation as Operation;
  if (!OPERATIONS.includes(operation) || Object.keys(args).some(key => key !== 'operation' && !KEYS[operation].includes(key))) invalid();
  if (['ls', 'download', 'upload', 'transfer-select'].includes(operation)) remotePath(args.path);
  if (operation === 'transfer-list' && args.path !== undefined) remotePath(args.path, false);
  if (operation === 'upload' && (typeof args.fileRefId !== 'string' || !args.fileRefId || /[\s/\\]/u.test(args.fileRefId))) invalid();
  if (operation === 'search' && (typeof args.query !== 'string' || !args.query.trim() || args.query.startsWith('-') || args.query.length > 1000)) invalid();
  if (operation.startsWith('transfer-')) shareUrl(args.shareUrl);
  if (operation === 'transfer-select') fileIds(args.fileIds);
  for (const key of ['page', 'limit', 'offset']) if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < (key === 'offset' ? 0 : 1)
    || Number(args[key]) > (key === 'limit' ? 100 : 1_000_000))) invalid();
  if (['download', 'upload'].includes(operation) && (String(args.path).endsWith('/') || String(args.path) === '/apps/bdpan')) invalid();
  return operation;
}
function remotePath(value: JsonValue | undefined, own = true): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 || /[\u0000-\u001f\\]/u.test(value)
    || value.split('/').some(part => part === '..' || part === '.' || part === '~')) invalid('自有网盘路径须以 / 开头，不能包含 . .. ~ 或反斜杠。');
  if (own && value !== '/apps/bdpan' && !value.startsWith('/apps/bdpan/')) invalid('自有网盘路径只接受 /apps/bdpan 或 /apps/bdpan/ 下的路径；列根目录写 /apps/bdpan，不是 /。');
  return value as string;
}
function shareUrl(value: JsonValue | undefined): string {
  let url: URL; try { url = new URL(String(value)); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'pan.baidu.com' || url.port || url.username || url.password
    || !/^\/s\/[a-z0-9_-]+$/iu.test(url.pathname) || url.search || url.hash) {
    throw new DirectError('BAIDU_SHARE_CREDENTIAL_REQUIRED', '目前仅接收不含提取码的公开分享链接；私密分享需要受控凭据引用，不能把提取码写入工具参数或日志。');
  }
  return url.href;
}
function fileIds(value: JsonValue | undefined): string[] {
  if (typeof value !== 'string') return invalid();
  const ids = value.split(',');
  if (!ids.length || ids.length > 100 || ids.some(id => !/^[0-9]{1,25}$/u.test(id)) || new Set(ids).size !== ids.length) invalid();
  return ids;
}
function invalid(reason?: string): never {
  throw new DirectError('BAIDU_ARGS_INVALID', reason ? `百度网盘参数无效：${reason}` : '百度网盘参数无效或超出该动作范围。');
}

/**
 * 百度网盘 Skill 与 BD 归档共用的单一命令能力：查询/上传/复制只解析官方 bdpan JSON。
 * 普通归档核对使用 ls 的文件名、大小与 fs_id，绝不因此触发 download。
 * 只有明确恢复原件时，调用者才可以请求 download。
 */
export async function runBaiduSkillCommand(options: {
  configuration: BaiduDriveConfiguration;
  processRuntime: ProcessRuntime;
  context: TaskExecutionContext;
  workspacePath: string;
  assertCurrent(): void;
  args: string[];
  runTool?: typeof runDirectProcess;
  exactMissing?: boolean;
}): Promise<JsonValue | null> {
  options.assertCurrent();
  const result = await (options.runTool ?? runDirectProcess)({
    runtime: options.processRuntime, binary: 'bdpan', binaryPath: options.configuration.binaryPath,
    bdpanHome: options.configuration.homePath,
    args: ['--no-check-update', '--json', '--config-path', options.configuration.configPath, ...options.args],
    cwd: options.workspacePath, signal: options.context.signal, assertAuthorized: options.assertCurrent,
    timeoutMs: 10 * 60_000, maxOutputBytes: 2_000_000,
    onProcessState: event => options.context.emit({ type: 'process_state', ...event }),
    onHeartbeat: event => options.context.emit({ type: 'heartbeat', ...event }),
  });
  if (options.exactMissing) {
    let reply: unknown;
    try { reply = JSON.parse(result.stdout); } catch { /* invalid JSON is handled by the parser */ }
    if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
      const missing = reply as Record<string, unknown>;
      if (Object.keys(missing).sort().join(',') === 'code,data,error' && missing.code === 1 && missing.data === null
        && missing.error === '找不到指定的文件或目录（错误码 -9），请检查路径是否正确。') return null;
    }
  }
  return parseBaiduOutput(result.stdout);
}

export function createBaiduDriveActions(options: { files: FileReferenceService; artifactRoot: string; configuration?: BaiduDriveConfiguration;
  processRuntime?: ProcessRuntime; assertPath(path: string): void; runTool?: typeof runDirectProcess }) {
  const configuration = options.configuration;
  const available = () => {
    if (!configuration) return { available: false, reason: '百度网盘 bdpan 未绑定；官方下载 Skill: https://github.com/baidu-netdisk/bdpan-storage 。不自动安装或登录。' };
    try {
      if (options.processRuntime?.path('bdpan') !== configuration.binaryPath) throw new Error('unbound program');
      const binary = inspectPath(configuration.binaryPath), config = inspectPath(configuration.configPath);
      accessSync(configuration.binaryPath, constants.X_OK);
      if (binary.object?.kind !== 'file' || config.object?.kind !== 'file' || config.links.length) throw new Error();
      if (configuration.tokenKeyPath) {
        const key = inspectPath(configuration.tokenKeyPath);
        if (key.object?.kind !== 'file' || key.links.length) throw new Error();
      }
      return { available: true };
    } catch { return { available: false, reason: 'bdpan 程序或账号配置不可用；官方 Skill: https://github.com/baidu-netdisk/bdpan-storage 。需先完成宿主安装与账号绑定。' }; }
  };
  const registration: SkillRegistration = {
    action: 'baidu.drive', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '百度网盘',
    description: '查询账号、目录或公开分享，搜索文件，上传当前会话选定单文件，下载网盘单文件，选择性转存公开分享。每次只做一个动作；不运行每日同步、不删文件、不自动登录。下载保存为新的本机成果。异步受理必须另行核对，不能当作完成。',
    fields: [
      { key: 'operation', label: '动作', type: 'select', required: true, options: OPERATIONS.map(value => ({ value, label: value })) },
      { key: 'path', label: '网盘完整路径', type: 'text', maxLength: 2048 },
      { key: 'query', label: '搜索关键词', type: 'text', maxLength: 1000 },
      { key: 'fileRefId', label: '当前会话上传原件', type: 'file' },
      { key: 'shareUrl', label: '公开分享链接', type: 'text', maxLength: 2048 },
      { key: 'fileIds', label: '字符串文件编号，以逗号分隔', type: 'text', maxLength: 2600 },
      { key: 'page', label: '页码', type: 'number', minimum: 1, maximum: 1_000_000 },
      { key: 'offset', label: '目录起始位置', type: 'number', minimum: 0, maximum: 1_000_000 },
      { key: 'limit', label: '每页数量', type: 'number', minimum: 1, maximum: 100 },
    ],
    permissionSummary: ['执行固定百度网盘程序并使用其本机账号', '按动作核对网盘网络访问及当前会话文件读取', '新文件发布与网盘写入留任务回执；结果未知不自动重放'],
    available, validate: validateBaiduArgs,
  };
  return { registrations: [registration], handles: (action: string) => action === registration.action,
    async execute(context: TaskExecutionContext, args: Args): Promise<TaskResult> {
      const operation = validateBaiduArgs(args);
      if (!configuration || !available().available) throw new DirectError('BAIDU_UNAVAILABLE', available().reason!);
      const binaryIdentity = inspectPath(configuration.binaryPath), configIdentity = inspectPath(configuration.configPath);
      const keyIdentity = configuration.tokenKeyPath ? inspectPath(configuration.tokenKeyPath) : null;
      const reference = operation === 'upload' ? options.files.getRef(String(args.fileRefId)) : null;
      if (reference) {
        options.assertPath(reference.invocationPath);
        if (reference.kind !== 'file' || reference.size > LIMIT) throw new DirectError('BAIDU_FILE_LIMIT', '仅支持不超过 256 MiB（兆字节）的已选单文件；目录和批量同步未接入。');
      }
      const capabilities: PermissionCapability[] = [fileCapability('execute', configuration.binaryPath),
        { action: 'secret', target: { kind: 'secret', name: 'baidu-drive.native-login' } },
        ...NETWORK_ORIGINS.map(origin => ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
        ...(['read', 'write', 'delete'] as const).map(action => directoryCapability(action, options.artifactRoot)),
        ...(reference ? [fileCapability('read', reference.invocationPath)] : [])];
      const authority = await acquireAuthority(context, `baidu.drive.${operation}`, args, capabilities);
      const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
      const assertCurrent = () => {
        authority.assert(); workspace.assertCurrent();
        if (!samePathIdentity(binaryIdentity, inspectPath(configuration.binaryPath), true)
          || !samePathIdentity(configIdentity, inspectPath(configuration.configPath), true)) throw new DirectError('BAIDU_BINDING_CHANGED', '百度网盘程序或账号配置已变化，请重新核对。');
        if (keyIdentity && !samePathIdentity(keyIdentity, inspectPath(configuration.tokenKeyPath!), true)) throw new DirectError('BAIDU_BINDING_CHANGED', '百度网盘原生凭据引用已变化，请重新核对。');
        if (reference) options.files.verify(reference.id);
      };
      let retain = false;
      const invoke = async (argv: string[]) => (await runBaiduSkillCommand({
        configuration, processRuntime: options.processRuntime!, context, workspacePath: workspace.path,
        assertCurrent, args: argv, runTool: options.runTool,
      }))!;
      await workspace.create();
      try {
        let data: JsonValue, artifactIds: string[] = [];
        if (operation === 'whoami') {
          const raw = await invoke(['whoami']);
          data = { authenticated: isObject(raw) && raw.authenticated === true };
        } else if (operation === 'ls') data = await invoke(['ls', String(args.path), '--start', String(args.offset ?? 0), '--limit', String(args.limit ?? 50)]);
        else if (operation === 'search') data = await invoke(['search', String(args.query), '--page', String(args.page ?? 1), '--page-size', String(args.limit ?? 50)]);
        else if (operation === 'transfer-list') data = await invoke(['transfer', 'list', shareUrl(args.shareUrl), '--page', String(args.page ?? 1), '--page-size', String(args.limit ?? 50),
          ...(args.path ? ['--source-dir', String(args.path)] : [])]);
        else {
          const cloudWrite = operation !== 'download';
          let staged: string | undefined;
          let remoteSource: Record<string, JsonValue> | null = null;
          if (reference) staged = await workspace.copyReference(reference, 'upload-source' + safeExtension(reference.displayName), LIMIT);
          if (operation === 'upload') {
            const existing = await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']);
            const listing = findListing(existing);
            if (!listing || listing.hasMore || listing.items.some(item => item.path === args.path || item.server_filename === basename(String(args.path)) || item.name === basename(String(args.path)))) {
              throw new DirectError('BAIDU_TARGET_NOT_PROVEN_NEW', '目标已存在或列表不完整，本次不发起上传；请选择一个已核对的新位置。');
            }
          }
          if (operation === 'download') {
            remoteSource = exactRemoteFile(await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']), String(args.path));
            if (!remoteSource || !remoteId(remoteSource) || Number(remoteSource.isdir) !== 0 || !Number.isSafeInteger(remoteSource.size)
              || Number(remoteSource.size) < 1 || Number(remoteSource.size) > LIMIT) {
              throw new DirectError('BAIDU_SOURCE_UNVERIFIED', '下载前未能核实远端单文件身份和大小，或超过 256 MiB（兆字节）；没有启动下载。');
            }
          }
          const effectId = randomUUID();
          await context.emit({ type: 'side_effect_started', effectId, description: cloudWrite ? '提交明确范围的百度网盘写入' : '下载指定网盘单文件到本次暂存', operation: args });
          retain = true;
          if (operation === 'download') {
            staged = join(workspace.path, 'downloaded' + safeExtension(String(args.path)));
            data = await invoke(['download', String(args.path), staged]);
            if (hasSubmitted(data)) throw new DirectError('BAIDU_RESULT_PENDING', '下载仍在受理中，不能发布成果或自动重放。', true);
            const fingerprint = await workspace.fingerprint(staged, LIMIT);
            if (fingerprint.bytes !== Number(remoteSource!.size)) throw new DirectError('BAIDU_INCOMPLETE_DOWNLOAD', '下载内容大小与远端期望不符，不能发布成果。', true);
            // 远端提供摘要时同时核对内容；整个文件受256MiB上限约束，读取沿已核对的暂存根。
            if (typeof remoteSource!.md5 === 'string' && /^[a-f0-9]{32}$/iu.test(remoteSource!.md5)) {
              const md5 = createHash('md5').update(await workspace.readPrefix(staged, fingerprint.bytes)).digest('hex');
              if (md5 !== remoteSource!.md5.toLowerCase()) throw new DirectError('BAIDU_INCOMPLETE_DOWNLOAD', '下载内容摘要与远端期望不符，不能发布成果。', true);
            }
            const currentRemote = exactRemoteFile(await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']), String(args.path));
            if (!currentRemote || remoteId(currentRemote) !== remoteId(remoteSource!) || currentRemote.size !== remoteSource!.size
              || (remoteSource!.md5 !== undefined && currentRemote.md5 !== remoteSource!.md5)) throw new DirectError('BAIDU_SOURCE_CHANGED', '下载期间远端原件发生变化，不能把结果归于先前文件。', true);
            const generated = await workspace.publishFile(staged, prepareDestination(join(options.artifactRoot, `baidu-${randomUUID()}-${basename(String(args.path))}`)), 'baidu.drive', args, LIMIT);
            artifactIds = [generated.id];
            data = { ...projectBaiduOutput(data), fileRefId: generated.id, ...fingerprint };
          } else if (operation === 'upload') {
            data = await invoke(['upload', staged!, String(args.path)]);
          } else data = await invoke(['transfer', 'select', shareUrl(args.shareUrl), '--fsid', fileIds(args.fileIds).join(','), '--dir', String(args.path)]);
          if (hasSubmitted(data)) {
            await context.emit({ type: 'checkpoint', checkpoint: { externalStatus: 'submitted', complete: false, operation, remotePath: String(args.path), receipt: projectBaiduOutput(data) } });
            throw new DirectError('BAIDU_RESULT_PENDING', '网盘仅确认已受理，完成结果待核对；本地取消不撤销远端任务，不能自动重放。', true);
          }
          if (operation === 'upload') {
            const receipt = uploadReceipt(data);
            const created = exactRemoteFile(await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']), String(args.path));
            if (!receipt || receipt.path !== args.path || !remoteId(receipt) || !created || remoteId(created) !== remoteId(receipt)
              || Number(created.size) !== reference!.size || Number(receipt.size) !== reference!.size) {
              throw new DirectError('BAIDU_UPLOAD_UNVERIFIED', '上传后 Skill 查询的文件名、大小或远端编号不一致；保留原请求核对，不下载读回或自动重传。', true);
            }
          }
          if (operation === 'transfer-select') {
            await context.emit({ type: 'checkpoint', checkpoint: { externalStatus: 'accepted', complete: false, operation, remotePath: String(args.path), receipt: projectBaiduOutput(data) } });
            throw new DirectError('BAIDU_TRANSFER_UNVERIFIED', '已提交选择性转存；需要核对本次目标与返回条目，当前不能证明全部完成，也不会自动重放。', true);
          }
          await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: operation === 'download' ? '下载单文件已核对大小与内容摘要，并以不覆盖方式发布。' : '程序成功回执及网盘目标名称、大小已核对。', data: { operation, artifactIds } });
          retain = false;
        }
        authority.assert();
        const projection = projectBaiduOutput(data);
        return { summary: `百度网盘${operation}已完成。`, data: { operation, complete: true, modelCalls: 0,
          modelPreview: { operation, complete: true, result: projection }, ...projection }, artifactIds };
      } catch (error) {
        if (error instanceof DirectProcessError && error.disposition === 'unknown') retain = true;
        throw error;
      } finally { if (!retain) await workspace.cleanup(); }
    },
  };
}
function safeExtension(name: string): string { return /\.[a-z0-9]{1,12}$/iu.exec(name)?.[0] ?? ''; }
function remoteParent(path: string): string { return path.slice(0, path.lastIndexOf('/')) || '/apps/bdpan'; }
function isObject(value: unknown): value is Record<string, JsonValue> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hasSubmitted(value: JsonValue): boolean {
  return Array.isArray(value) ? value.some(hasSubmitted) : isObject(value) && (['submitted', 'pending', 'running'].includes(String(value.status)) || Object.values(value).some(hasSubmitted));
}
function findListing(value: JsonValue): { items: Record<string, JsonValue>[]; hasMore: boolean } | null {
  if (!isObject(value)) return null;
  for (const key of ['items', 'list', 'files']) if (Array.isArray(value[key])) return { items: value[key].filter(isObject), hasMore: value.has_more === true || value.has_more === 1 || value[key].length >= 1000 };
  return isObject(value.data) ? findListing(value.data) : null;
}
function remoteId(value: Record<string, JsonValue>): string | null {
  const id = value.fs_id ?? value.fsid;
  return typeof id === 'string' && /^[0-9]{1,25}$/u.test(id) ? id : typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? String(id) : null;
}
function exactRemoteFile(value: JsonValue, path: string): Record<string, JsonValue> | null {
  const listing = findListing(value);
  if (!listing) return null;
  const found = listing.items.filter(item => item.path === path);
  return found.length === 1 ? found[0]! : null;
}
function uploadReceipt(value: JsonValue): Record<string, JsonValue> | null {
  if (!isObject(value)) return null;
  if (typeof value.path === 'string' && remoteId(value)) return value;
  return isObject(value.data) ? uploadReceipt(value.data) : null;
}
export function parseBaiduOutput(stdout: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(stdout, (key: string, item: unknown, context?: { source: string }) =>
      /^(fs_?id|task_id)$/u.test(key) && typeof item === 'number' && context?.source ? context.source : item) as JsonValue;
  } catch { throw new DirectError('BAIDU_OUTPUT_INVALID', '网盘未返回可核对的结构化结果。'); }
  const failure = (item: JsonValue, depth = 0): boolean => {
    if (depth > 20) return true;
    if (Array.isArray(item)) return item.some(child => failure(child, depth + 1));
    if (!isObject(item)) return false;
    if (item.ok === false || item.success === false || !!item.error || ['failed', 'error', 'auth_required'].includes(String(item.status))) return true;
    for (const key of ['code', 'errno']) if (item[key] !== undefined && /^[+-]?[0-9]+$/u.test(String(item[key])) && Number(item[key]) !== 0) return true;
    return Object.values(item).some(child => failure(child, depth + 1));
  };
  if ((!isObject(value) && !Array.isArray(value)) || failure(value)) throw new DirectError('BAIDU_REJECTED', '网盘返回失败或无法核对的结果，不能按退出码称为成功。');
  return value;
}
const PUBLIC_KEYS = new Set(['status', 'code', 'errno', 'authenticated', 'data', 'items', 'list', 'files', 'name', 'server_filename', 'path', 'dir', 'size', 'bytes',
  'fs_id', 'fsid', 'task_id', 'isdir', 'ctime', 'mtime', 'server_mtime', 'has_more', 'page', 'page_size', 'count', 'total', 'return_url', 'return_markdown', 'fileRefId', 'sha256']);
/** 白名单投影，不保存 account、token、预制 agent_reply 或任意程序诊断。 */
export function projectBaiduOutput(value: JsonValue): Record<string, JsonValue> {
  const safe = (item: JsonValue, depth = 0): JsonValue => {
    if (depth > 12) return null;
    if (Array.isArray(item)) return item.slice(0, 100).map(child => safe(child, depth + 1));
    if (isObject(item)) return Object.fromEntries(Object.entries(item).filter(([key]) => PUBLIC_KEYS.has(key)).map(([key, child]) => [key, safe(child, depth + 1)]));
    if (typeof item === 'string') return redactBaiduText(item).slice(0, 4096);
    return item;
  };
  const result = safe(value);
  const output = isObject(result) ? result : { items: result };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 48000) throw new DirectError('BAIDU_PREVIEW_LIMIT', '网盘结果超过本轮分享上限，请缩小页大小。');
  return output;
}
/** 移植自 DSH runtime.js 的文本防泄漏语义；白名单字段仍须处理嵌入凭据。 */
export function redactBaiduText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>\])]+/giu, raw => {
    try {
      const url = new URL(raw); url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (/token|password|passcode|secret|api.?key|authorization|cookie|^(pwd|p)$/iu.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return '[已隐藏链接]'; }
  }).replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|xsec[_-]?token|pwd)\s*[:=]\s*)[^\s"'&,;]+/giu, '$1[已隐藏]');
}

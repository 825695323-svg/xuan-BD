import type { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { FileReferenceService } from '../../../platform/resources/files.js';
import { inspectPath, samePathIdentity, type PermissionCapability } from '../../../platform/security/permissions.js';
import type { SkillRegistration } from '../../../platform/plugins/registry.js';
import type { TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, fileCapability, prepareDestination } from '../../../platform/runtime/file-workspace.js';
import { DirectProcessError, runDirectProcess } from '../../../platform/runtime/process.js';
import { readDshCredential, readKeychainCredential, type CredentialReference } from '../../../platform/config/model.js';
import { baiduReturnMarkdown, baiduReturnUrl, CLOUD_ROOT, isBaiduPasscodeRefName, isBaiduPath, redactBaiduText } from './contract.js';
export { redactBaiduText } from './contract.js';

/** 受信宿主绑定；参数不能选择程序、账号、脚本或任意命令。 */
export interface BaiduDriveConfiguration {
  binaryPath: string; configPath: string; homePath?: string; tokenKeyPath?: string;
  /** 只登记宿主凭据定位，任务及配置版本中均不包含提取码。 */
  readonly sharePasscodeRefs?: Readonly<Record<string, CredentialReference>>;
}
const OPERATIONS = ['whoami', 'ls', 'search', 'download', 'upload', 'transfer-list', 'transfer-select'] as const;
type Operation = typeof OPERATIONS[number];
type Args = Record<string, JsonValue>;
const LIMIT = 256 * 1024 * 1024;
const KEYS: Record<Operation, readonly string[]> = {
  whoami: [], ls: ['path', 'offset', 'limit'], search: ['query', 'page', 'limit'],
  download: ['path'], upload: ['path', 'fileRefId'],
  'transfer-list': ['shareUrl', 'sourceDir', 'passcodeRef', 'page', 'limit'],
  'transfer-select': ['shareUrl', 'passcodeRef', 'path', 'fileIds'],
};
const NETWORK_ORIGINS = ['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'];

/** 行为借鉴已安装 DSH dsh-tool-baidu-drive 0.1.1；宿主权限和收束沿用当前核心。 */
export function validateBaiduArgs(args: Args): Operation {
  const operation = args.operation as Operation;
  if (Object.hasOwn(args, 'passcode')) invalid('提取码仅接受已登记的 passcodeRef 引用。');
  if (operation === 'transfer-list' && args.path !== undefined) invalid('分享子目录请使用 sourceDir。');
  if (!OPERATIONS.includes(operation) || Object.keys(args).some(key => key !== 'operation' && !KEYS[operation].includes(key))) invalid();
  if (['ls', 'download', 'upload', 'transfer-select'].includes(operation)) remotePath(args.path);
  if (args.sourceDir !== undefined) remotePath(args.sourceDir, false);
  if (args.passcodeRef !== undefined && !isBaiduPasscodeRefName(args.passcodeRef)) invalid();
  if (operation === 'upload' && (typeof args.fileRefId !== 'string' || !args.fileRefId || /[\s/\\]/u.test(args.fileRefId))) invalid();
  if (operation === 'search' && (typeof args.query !== 'string' || !args.query.trim() || args.query.startsWith('-') || args.query.length > 1000)) invalid();
  if (operation.startsWith('transfer-')) shareUrl(args.shareUrl);
  if (operation === 'transfer-select') fileIds(args.fileIds);
  for (const key of ['page', 'limit', 'offset']) if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < (key === 'offset' ? 0 : 1)
    || Number(args[key]) > (key === 'limit' ? 100 : 1_000_000))) invalid();
  if (['download', 'upload'].includes(operation) && (String(args.path).endsWith('/') || args.path === CLOUD_ROOT)) invalid();
  return operation;
}
function remotePath(value: JsonValue | undefined, own = true): string {
  if (!isBaiduPath(value)) invalid('网盘路径须以 / 开头，不能包含 . .. ~ 或反斜杠。');
  if (own && value !== CLOUD_ROOT && !value.startsWith(CLOUD_ROOT + '/')) invalid('自有网盘路径只接受 /apps/bdpan 或 /apps/bdpan/ 下的路径。');
  return value;
}
function shareUrl(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/pan\.baidu\.com\/s\/[a-z0-9_-]+$/i.test(value)) {
    throw new DirectError('BAIDU_SHARE_CREDENTIAL_REQUIRED', '分享链接须为不含凭据、查询参数和片段的官方链接。提取码使用已登记的 passcodeRef。');
  }
  return value;
}
async function resolvePasscode(configuration: BaiduDriveConfiguration, ref: string, runtime: ProcessRuntime): Promise<string> {
  const refs = configuration.sharePasscodeRefs;
  if (refs && Object.hasOwn(refs, ref)) {
    try {
      const source = refs[ref]!;
      const value = source.kind === 'keychain' ? await readKeychainCredential(source.service, source.account, runtime, 'exact')
        : source.kind === 'dsh-ref' ? await readDshCredential(source.path, source.ref, 'exact') : undefined;
      if (typeof value === 'string' && /^[a-zA-Z0-9]{4,16}$/u.test(value)) return value;
    } catch { /* 底层凭据异常可能带有原文，不能传播。 */ }
  }
  throw new DirectError('BAIDU_PASSCODE_UNAVAILABLE', '分享提取码引用未登记、无法读取或格式无效。');
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
  sharePasscode?: string;
}): Promise<JsonValue | null> {
  options.assertCurrent();
  const secret = options.sharePasscode;
  if (secret !== undefined && (options.args[0] !== 'transfer' || !['list', 'select'].includes(options.args[1]!) || !/^[a-zA-Z0-9]{4,16}$/u.test(secret))) invalid();
  let result;
  try {
    result = await (options.runTool ?? runDirectProcess)({
      runtime: options.processRuntime, binary: 'bdpan', binaryPath: options.configuration.binaryPath,
      bdpanHome: options.configuration.homePath,
      args: ['--no-check-update', '--json', '--config-path', options.configuration.configPath, ...options.args, ...(secret ? ['-p', secret] : [])],
      cwd: options.workspacePath, signal: options.context.signal, assertAuthorized: options.assertCurrent,
      timeoutMs: 10 * 60_000, maxOutputBytes: 2_000_000,
      onProcessState: event => options.context.emit({ type: 'process_state', ...event }),
      onHeartbeat: event => options.context.emit({ type: 'heartbeat', ...event }),
    });
  } catch (error) {
    if (error instanceof DirectProcessError) {
      throw new DirectProcessError(secret ? 'BAIDU_COMMAND_FAILED' : error.code, secret ? '网盘命令失败，诊断已隐藏 [REDACTED]。' : redactBaiduText(error.message),
        error.disposition, error.exitCode, error.terminationSignal, error.diagnostic ? '[REDACTED]' : undefined, 'bdpan');
    }
    if (secret) throw new DirectError('BAIDU_COMMAND_UNCONFIRMED', '网盘命令结果无法确认 [REDACTED]。', true);
    throw error;
  }
  if (options.exactMissing) {
    let reply: unknown;
    try { reply = JSON.parse(result.stdout); } catch { /* invalid JSON is handled by the parser */ }
    if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
      const missing = reply as Record<string, unknown>;
      if (Object.keys(missing).sort().join(',') === 'code,data,error' && missing.code === 1 && missing.data === null
        && missing.error === '找不到指定的文件或目录（错误码 -9），请检查路径是否正确。') return null;
    }
  }
  return parseBaiduOutput(result.stdout, secret);
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
    description: '查询账号、目录与分享，搜索文件，上传当前会话选定单文件，下载网盘单文件，选择性转存分享。私密分享按授权引用取码。下载签发本机成果，转存核对目标元数据。',
    fields: [
      { key: 'operation', label: '动作', type: 'select', required: true, options: OPERATIONS.map(value => ({ value, label: value })) },
      { key: 'path', label: '网盘完整路径', type: 'text', maxLength: 2048 },
      { key: 'query', label: '搜索关键词', type: 'text', maxLength: 1000 },
      { key: 'fileRefId', label: '当前会话上传原件', type: 'file' },
      { key: 'shareUrl', label: '无凭据的分享链接', type: 'text', maxLength: 2048 },
      { key: 'sourceDir', label: '分享内子目录', type: 'text', maxLength: 2048 },
      { key: 'passcodeRef', label: '受控提取码引用名', type: 'text', maxLength: 64 },
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
      const passcodeRef = args.passcodeRef as string | undefined;
      if (passcodeRef) capabilities.push({ action: 'secret', target: { kind: 'secret', name: 'baidu-drive.share-passcode.' + passcodeRef } });
      const authority = await acquireAuthority(context, `baidu.drive.${operation}`, args, capabilities);
      const passcode = passcodeRef ? await resolvePasscode(configuration, passcodeRef, options.processRuntime!) : undefined;
      authority.assert();
      const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
      const assertCurrent = () => {
        authority.assert(); workspace.assertCurrent();
        if (!samePathIdentity(binaryIdentity, inspectPath(configuration.binaryPath), true)
          || !samePathIdentity(configIdentity, inspectPath(configuration.configPath), true)) throw new DirectError('BAIDU_BINDING_CHANGED', '百度网盘程序或账号配置已变化，请重新核对。');
        if (keyIdentity && !samePathIdentity(keyIdentity, inspectPath(configuration.tokenKeyPath!), true)) throw new DirectError('BAIDU_BINDING_CHANGED', '百度网盘原生凭据引用已变化，请重新核对。');
        if (reference) options.files.verify(reference.id);
      };
      let retain = false;
      let transferCheckpoint: JsonValue | undefined;
      const invoke = async (argv: string[]) => (await runBaiduSkillCommand({
        configuration, processRuntime: options.processRuntime!, context, workspacePath: workspace.path,
        assertCurrent, args: argv, runTool: options.runTool, sharePasscode: argv[0] === 'transfer' ? passcode : undefined,
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
          ...(args.sourceDir ? ['--source-dir', String(args.sourceDir)] : [])]);
        else if (operation === 'transfer-select') {
          const ids = fileIds(args.fileIds), directory = String(args.path), effectId = randomUUID();
          await context.emit({ type: 'side_effect_started', effectId, description: '提交所选分享条目转存', operation: { operation, remotePath: directory, fileIds: ids } });
          retain = true;
          let reply: JsonValue;
          try {
            reply = await invoke(['transfer', 'select', shareUrl(args.shareUrl), '--fsid', ids.join(','), '--dir', directory]);
          } catch (error) {
            const rejected = error instanceof BaiduRejected;
            const checkpoint = { operation, remotePath: directory, transferStatus: rejected ? 'failed' : 'pending_verification',
              targetVerification: 'not_checked', complete: false, ...(rejected ? error.links : {}) };
            // 多条选择可能只失败了一部分，保留未决写入以阻止重放整批。
            if (rejected && ids.length === 1) {
              await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '网盘结构化回执明确报告此项转存失败。', data: checkpoint });
              retain = false;
            }
            transferCheckpoint = checkpoint;
            throw error;
          }
          const submitted = hasSubmitted(reply);
          const targetVerification = submitted ? 'not_checked' : await verifyTransferTargets(reply, ids, directory, invoke, assertCurrent);
          const complete = targetVerification === 'matched';
          const transferStatus = complete ? 'verified' : submitted ? 'submitted' : 'pending_verification';
          const links = transferReturnLinks(reply, passcode);
          let receipt: Record<string, JsonValue>;
          try { receipt = projectBaiduOutput(reply, passcode); }
          catch (error) {
            if (!(error instanceof DirectError) || error.code !== 'BAIDU_PREVIEW_LIMIT') throw error;
            receipt = { previewTruncated: true, ...links };
          }
          const facts = { operation, transferStatus, complete, targetVerification, remotePath: directory, receipt, ...links };
          if (complete) {
            await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '已按所选来源编号、目标路径及目标编号逐项核对目录元数据。', data: { transferStatus } });
            retain = false;
          }
          transferCheckpoint = facts;
          assertCurrent();
          return { summary: complete ? '转存目标已逐项核验。' : submitted ? '网盘已受理转存，等待核对目标。' : '转存回执已保存，目标仍待核验。',
            data: { ...facts, modelCalls: 0, modelPreview: facts }, artifactIds: [] };
        } else {
          const cloudWrite = operation !== 'download';
          let staged: string | undefined;
          let remoteSource: Record<string, JsonValue> | null = null;
          if (reference) staged = await workspace.copyReference(reference, 'upload-source' + safeExtension(reference.displayName), LIMIT);
          if (operation === 'upload') {
            const existing = await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']);
            const listing = findListing(existing);
            if (!listing || listing.hasMore || listing.items.some(item => typeof item.path !== 'string' || posix.dirname(item.path) !== remoteParent(String(args.path))
              || item.path === args.path || item.server_filename === basename(String(args.path)) || item.name === basename(String(args.path)))) {
              throw new DirectError('BAIDU_TARGET_NOT_PROVEN_NEW', '目标已存在或列表不完整，本次不发起上传；请选择一个已核对的新位置。');
            }
          }
          if (operation === 'download') {
            remoteSource = exactRemoteFile(await invoke(['ls', remoteParent(String(args.path)), '--start', '0', '--limit', '1000']), String(args.path));
            if (!remoteSource || !remoteId(remoteSource) || ![false, 0].includes(remoteSource.isdir as boolean | number) || !Number.isSafeInteger(remoteSource.size)
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
            if (!currentRemote || ![false, 0].includes(currentRemote.isdir as boolean | number)
              || remoteId(currentRemote) !== remoteId(remoteSource!) || currentRemote.size !== remoteSource!.size
              || (remoteSource!.md5 !== undefined && currentRemote.md5 !== remoteSource!.md5)) throw new DirectError('BAIDU_SOURCE_CHANGED', '下载期间远端原件发生变化，不能把结果归于先前文件。', true);
            const generated = await workspace.publishFile(staged, prepareDestination(join(options.artifactRoot, `baidu-${randomUUID()}-${basename(String(args.path))}`)), 'baidu.drive', args, LIMIT);
            artifactIds = [generated.id];
            data = { ...projectBaiduOutput(data), fileRefId: generated.id, fileRefVersion: generated.version, remotePath: String(args.path), ...fingerprint };
          } else {
            data = await invoke(['upload', staged!, String(args.path)]);
          }
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
          await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: operation === 'download' ? '下载单文件已核对大小与内容摘要，并以不覆盖方式发布。' : '程序成功回执及网盘目标名称、大小已核对。', data: { operation, artifactIds } });
          retain = false;
        }
        authority.assert();
        const projection = projectBaiduOutput(data, passcode);
        return { summary: `百度网盘${operation}已完成。`, data: { operation, complete: true, modelCalls: 0,
          modelPreview: { operation, complete: true, result: projection }, ...projection }, artifactIds };
      } catch (error) {
        if (error instanceof DirectProcessError && error.disposition === 'unknown') retain = true;
        throw error;
      } finally {
        if (!retain) await workspace.cleanup();
        if (transferCheckpoint) await context.emit({ type: 'checkpoint', checkpoint: transferCheckpoint });
      }
    },
  };
}
function safeExtension(name: string): string { return /\.[a-z0-9]{1,12}$/iu.exec(name)?.[0] ?? ''; }
function remoteParent(path: string): string { return path.slice(0, path.lastIndexOf('/')) || CLOUD_ROOT; }
function isObject(value: unknown): value is Record<string, JsonValue> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hasSubmitted(value: JsonValue): boolean {
  return Array.isArray(value) ? value.some(hasSubmitted) : isObject(value) && (value.submitted === true
    || ['submitted', 'pending', 'running', 'queued', 'accepted'].includes(String(value.status).toLowerCase()) || Object.values(value).some(hasSubmitted));
}
function findListing(value: JsonValue): { items: Record<string, JsonValue>[]; hasMore: boolean } | null {
  const raw = Array.isArray(value) ? value : isObject(value) && (value.items ?? value.list ?? value.files ?? value.data);
  const marker = isObject(value) ? value.has_more : undefined;
  if (marker !== undefined && ![true, false, 0, 1].includes(marker as boolean | number)) return null;
  if (isObject(raw)) {
    const nested = findListing(raw);
    return nested && { items: nested.items, hasMore: nested.hasMore || marker === true || marker === 1 };
  }
  if (!Array.isArray(raw) || raw.length > 1000 || !raw.every(isObject)) return null;
  return { items: raw, hasMore: marker === true || marker === 1 || marker === undefined && raw.length >= 1000 };
}
function remoteId(value: Record<string, JsonValue>): string | null {
  if (value.fs_id !== undefined && value.fsid !== undefined && String(value.fs_id) !== String(value.fsid)) return null;
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
  if (Array.isArray(value)) return value.length === 1 ? uploadReceipt(value[0]!) : null;
  if (!isObject(value)) return null;
  if (typeof value.path === 'string' && remoteId(value)) return value;
  return value.data ? uploadReceipt(value.data) : null;
}
function transferReturnLinks(reply: JsonValue, passcode?: string): Record<string, JsonValue> {
  if (!isObject(reply)) return {};
  const payload = isObject(reply.data) ? reply.data : {};
  const returnUrl = baiduReturnUrl(reply.return_url, passcode) ?? baiduReturnUrl(payload.return_url, passcode);
  const markdown = baiduReturnMarkdown(reply.return_markdown, passcode) ?? baiduReturnMarkdown(payload.return_markdown, passcode);
  return { ...(returnUrl ? { return_url: returnUrl } : {}), ...(markdown ? { return_markdown: markdown } : {}) };
}
/** 转存回执必须把每个选定来源编号映射到唯一目标编号和路径。单凭同名文件、任务号或成功标志无法核验。 */
async function verifyTransferTargets(reply: JsonValue, ids: string[], directory: string, invoke: (args: string[]) => Promise<JsonValue>,
  assertCurrent: () => void): Promise<'matched' | 'not_checked' | 'inconclusive'> {
  const payload = isObject(reply) ? reply.data ?? reply : reply;
  const entries = isObject(payload) ? (isObject(payload.extra) ? payload.extra.list : payload.list ?? payload.items) : payload;
  if (!Array.isArray(entries) || entries.length !== ids.length) return 'not_checked';
  const remaining = new Set(ids), targets = new Map<string, string>();
  for (const item of entries) {
    if (!isObject(item)) return 'not_checked';
    const source = item.from_fs_id, id = item.to_fs_id, path = item.to ?? item.to_path;
    if (typeof source !== 'string' || !remaining.delete(source) || typeof id !== 'string' || !/^[0-9]{1,25}$/u.test(id)
      || !isBaiduPath(path) || posix.dirname(path) !== directory || posix.normalize(path) !== path || path.endsWith('/')
      || item.to_path !== undefined && item.to_path !== path || targets.has(path)) return 'not_checked';
    targets.set(path, id);
  }
  if (new Set(targets.values()).size !== ids.length) return 'not_checked';
  let listing;
  try { listing = findListing(await invoke(['ls', directory, '--start', '0', '--limit', '1000'])); }
  catch { assertCurrent(); return 'inconclusive'; }
  if (!listing || listing.hasMore || listing.items.some(item => !isBaiduPath(item.path) || posix.dirname(item.path) !== directory)) return 'inconclusive';
  for (const [path, id] of targets) {
    const matches = listing.items.filter(item => item.path === path);
    if (matches.length !== 1 || remoteId(matches[0]!) !== id || ![false, true, 0, 1].includes(matches[0]!.isdir as boolean | number)) return 'inconclusive';
  }
  return 'matched';
}
class BaiduRejected extends DirectError {
  constructor(readonly links: Record<string, JsonValue>) { super('BAIDU_REJECTED', '网盘结构化回执明确报告失败。'); }
}
export function parseBaiduOutput(stdout: string, passcode?: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(stdout, (key: string, item: unknown, context?: { source: string }) =>
      /^(?:(?:from_|to_)?fs_?id|task_id)$/u.test(key) && typeof item === 'number' && context?.source ? context.source : item) as JsonValue;
  } catch { throw new DirectError('BAIDU_OUTPUT_INVALID', '网盘未返回可核对的结构化结果。'); }
  const failure = (item: JsonValue, depth = 0): boolean => {
    if (depth > 20) throw new DirectError('BAIDU_OUTPUT_INVALID', '网盘回执的嵌套结构超出核对范围。');
    if (Array.isArray(item)) return item.some(child => failure(child, depth + 1));
    if (!isObject(item)) return false;
    if (item.ok === false || item.success === false || !!item.error || ['failed', 'error', 'auth_required'].includes(String(item.status).toLowerCase())) return true;
    for (const key of ['code', 'errno']) if (item[key] !== undefined) {
      const code = item[key];
      if (typeof code !== 'number' && typeof code !== 'string' || !/^[+-]?[0-9]+$/u.test(String(code)))
        throw new DirectError('BAIDU_OUTPUT_INVALID', '网盘回执的业务状态码格式无法核对。');
      if (Number(code) !== 0) return true;
    }
    return Object.values(item).some(child => failure(child, depth + 1));
  };
  if (!isObject(value) && !Array.isArray(value)) throw new DirectError('BAIDU_OUTPUT_INVALID', '网盘没有返回结构化对象或列表。');
  if (failure(value)) throw new BaiduRejected(transferReturnLinks(value, passcode));
  return passcode ? publicBaiduValue(value, passcode, false) : value;
}
const PUBLIC_KEYS = new Set(['status', 'submitted', 'code', 'errno', 'authenticated', 'data', 'extra', 'items', 'list', 'files', 'from_fs_id', 'to_fs_id', 'to', 'to_path', 'name', 'server_filename', 'path', 'dir', 'size', 'bytes',
  'fs_id', 'fsid', 'task_id', 'isdir', 'ctime', 'mtime', 'server_mtime', 'has_more', 'page', 'page_size', 'count', 'total', 'return_url', 'return_markdown', 'fileRefId', 'fileRefVersion', 'remotePath', 'sha256']);
/** 白名单投影，不保存 account、token、预制 agent_reply 或任意程序诊断。 */
export function projectBaiduOutput(value: JsonValue, passcode?: string): Record<string, JsonValue> {
  const result = publicBaiduValue(value, passcode, true);
  const output = isObject(result) ? result : { items: result };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 48000) throw new DirectError('BAIDU_PREVIEW_LIMIT', '网盘结果超过本轮分享上限，请缩小页大小。');
  return output;
}
function publicBaiduValue(item: JsonValue, passcode: string | undefined, preview: boolean, depth = 0): JsonValue {
  if (preview && depth > 12) return null;
  if (Array.isArray(item)) {
    const items = preview ? item.slice(0, 100) : item;
    return items.map((child, index) => items[index - 1] === '-p' ? '[REDACTED]' : publicBaiduValue(child, passcode, preview, depth + 1));
  }
  if (isObject(item)) return Object.fromEntries(Object.entries(item).filter(([key]) => PUBLIC_KEYS.has(key)).map(([key, child]) => {
    if (key === 'return_url') return [key, baiduReturnUrl(child, passcode)];
    if (key === 'return_markdown') return [key, baiduReturnMarkdown(child, passcode)];
    return [key, publicBaiduValue(child, passcode, preview, depth + 1)];
  }));
  if (typeof item === 'string') {
    const safe = redactBaiduText(item, passcode);
    return preview ? safe.slice(0, 4096) : safe;
  }
  return passcode && String(item).includes(passcode) ? '[REDACTED]' : item;
}

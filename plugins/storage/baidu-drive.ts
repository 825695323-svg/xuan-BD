import { createHash, randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import { acquireAuthority, directoryCapability, DirectError, DirectWorkspace, fileCapability } from '../../platform/runtime/file-workspace.js';
import { DirectProcessError, runDirectProcess } from '../../platform/runtime/process.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import { inspectPath, samePathIdentity } from '../../platform/security/permissions.js';
import { runBaiduSkillCommand, type BaiduDriveConfiguration } from '../capture-sources/baidu-drive/index.js';

export const CLOUD_ROOT = '/apps/bdpan';
export const CLOUD_EVIDENCE_ROOT = posix.join(CLOUD_ROOT, '证据盘');
export const CLOUD_EVIDENCE_TOPICS = ['行情', '财报', '资讯', '资金流向', '市场情绪', '榜单', '待分类'] as const;
export const CLOUD_EVIDENCE_PURPOSES = ['来源原件', '加工证据', '交接回执'] as const;
export type CloudEvidenceTopic = typeof CLOUD_EVIDENCE_TOPICS[number];
export type CloudEvidencePurpose = typeof CLOUD_EVIDENCE_PURPOSES[number];
export function cloudEvidenceDirectory(topic: CloudEvidenceTopic, purpose: CloudEvidencePurpose): string {
  if (!(CLOUD_EVIDENCE_TOPICS as readonly string[]).includes(topic) || !(CLOUD_EVIDENCE_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DirectError('INVALID_CLOUD_EVIDENCE_CLASSIFICATION', '证据盘主题和证据用途必须从已登记分类中明确选择。');
  }
  return posix.join(CLOUD_EVIDENCE_ROOT, topic, purpose);
}
function evidenceDirectory(path: string): boolean {
  const prefix = CLOUD_EVIDENCE_ROOT + '/', parts = path.slice(prefix.length).split('/');
  return path.startsWith(prefix) && parts.length === 2 && (CLOUD_EVIDENCE_TOPICS as readonly string[]).includes(parts[0]!)
    && (CLOUD_EVIDENCE_PURPOSES as readonly string[]).includes(parts[1]!);
}
export const CLOUD_MAX_BYTES = 256 * 1024 * 1024;
export interface CloudObject { id: string; path: string; kind: 'file' | 'directory'; size: number; md5: string | null }
export interface CloudPage { items: CloudObject[]; hasMore: boolean; nextOffset: number | null }
export interface CloudSession {
  list(path: string, offset: number, limit: number): Promise<CloudPage>;
  lookup?(path: string): Promise<CloudObject | null>;
  read(object: CloudObject, maxBytes: number): Promise<Buffer>;
  prepareDirectory(path: string, create: boolean): Promise<boolean>;
  put(bytes: Buffer, path: string): Promise<CloudObject>;
  copy(source: CloudObject, targetDirectory: string): Promise<CloudObject>;
  close(): Promise<void>;
}
/** 字节插件只拥有远端对象；材料来源、谱系和正式数据库资格由原服务保留。 */
export interface CloudCustodyBackend {
  readonly versionBinding: Record<string, string | null>;
  availability(): { available: boolean; reason?: string };
  open(context: TaskExecutionContext, input: { scopePath: string; sourceRemotePath?: string; allowUpload: boolean; verifyBytes: boolean; targetDirectory?: string }): Promise<CloudSession>;
}

export function cloudPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f\\]/u.test(value)
    || value !== CLOUD_ROOT && !value.startsWith(CLOUD_ROOT + '/')
    || value.split('/').slice(1).some(part => !part || ['.', '..', '~'].includes(part))) {
    throw new DirectError('INVALID_CLOUD_PATH', '需要已登记网盘根内的明确路径，不接受相对路径或目录穿越。');
  }
  return value;
}
export function inCloudScope(scope: string, path: string): boolean { return path === scope || path.startsWith(scope + '/'); }

/** 只取实际 CLI 的对象身份、类型、长度和摘要；丢弃账号 URL、富文本和诊断。 */
export function parseCloudPage(value: JsonValue, directory: string, offset: number, limit: number): CloudPage {
  let container: Record<string, JsonValue> | null = object(value) ? value : null;
  if (container && object(container.data)) container = container.data;
  const raw = Array.isArray(value) ? value : container && ['items', 'list', 'files'].map(key => container![key]).find(Array.isArray);
  if (!Array.isArray(raw) || raw.length > limit) throw new DirectError('CLOUD_LIST_UNVERIFIED', '网盘没有返回本页可核对的有界目录清单。');
  const items = raw.map(item => cloudObject(item));
  if (items.some(item => posix.dirname(item.path) !== directory)) throw new DirectError('CLOUD_DIRECTORY_AMBIGUOUS', '网盘返回了目录自身或范围外对象，不能将目录当作文件或空目录。');
  const marker = container?.has_more;
  if (marker !== undefined && ![true, false, 0, 1].includes(marker as boolean | number)) throw new DirectError('CLOUD_LIST_UNVERIFIED', '网盘分页结束标记不能核对。');
  const hasMore = marker === undefined ? raw.length === limit : marker === true || marker === 1;
  if (hasMore && !raw.length) throw new DirectError('CLOUD_LIST_UNVERIFIED', '网盘分页未结束但没有进度，不能判定缺失。');
  return { items, hasMore, nextOffset: hasMore ? offset + raw.length : null };
}
function cloudObject(value: JsonValue): CloudObject {
  if (!object(value)) throw new DirectError('CLOUD_OBJECT_UNVERIFIED', '网盘对象元数据无法核对。');
  // 原生 3.8.7 同时返回字符串 fsid；优先该字段，避免大编号经过浮点数失真。
  const rawId = typeof value.fsid === 'string' ? value.fsid : value.fs_id ?? value.fsid;
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : '';
  if (!/^[0-9]{1,30}$/u.test(id) || ![true, false, 0, 1].includes(value.isdir as boolean | number)
    || !Number.isSafeInteger(value.size) || Number(value.size) < 0) throw new DirectError('CLOUD_OBJECT_UNVERIFIED', '网盘对象缺少精确编号、文件类型或长度，不能据此判断缺失。');
  const md5 = typeof value.md5 === 'string' && /^[a-f0-9]{32}$/iu.test(value.md5) ? value.md5.toLowerCase() : null;
  return { id, path: cloudPath(value.path), kind: value.isdir === true || value.isdir === 1 ? 'directory' : 'file', size: Number(value.size), md5 };
}
function object(value: JsonValue): value is Record<string, JsonValue> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function sameObject(left: CloudObject, right: CloudObject): boolean {
  return left.id === right.id && left.path === right.path && left.kind === right.kind && left.size === right.size && left.md5 === right.md5;
}
function pending(value: JsonValue): boolean {
  return Array.isArray(value) ? value.some(pending) : object(value)
    && (['submitted', 'pending', 'running', 'accepted'].includes(String(value.status)) || Object.values(value).some(pending));
}
type ReceiptMetadata = Partial<CloudObject>;
function receipt(value: JsonValue): ReceiptMetadata | null {
  if (Array.isArray(value)) return value.length === 1 ? receipt(value[0]!) : null;
  if (!object(value)) return null;
  const path = value.path ?? value.remote_path, id = value.fsid ?? value.fs_id;
  if (path !== undefined || id !== undefined) {
    const result: ReceiptMetadata = {};
    for (const supplied of [value.path, value.remote_path].filter(item => item !== undefined)) {
      if (typeof supplied !== 'string' || !supplied) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的目标路径无法核对。');
      const normalized = cloudPath(supplied.startsWith('/') ? supplied : CLOUD_ROOT + '/' + supplied);
      if (result.path !== undefined && result.path !== normalized) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的目标路径字段相互矛盾。');
      result.path = normalized;
    }
    for (const supplied of [value.fsid, value.fs_id].filter(item => item !== undefined)) {
      const exactId = typeof supplied === 'string' ? supplied : typeof supplied === 'number' && Number.isSafeInteger(supplied) ? String(supplied) : '';
      if (!/^[0-9]{1,30}$/u.test(exactId) || result.id !== undefined && result.id !== exactId) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的精确对象编号无法核对或相互矛盾。');
      result.id = exactId;
    }
    for (const supplied of [value.isdir, value.is_dir].filter(item => item !== undefined)) {
      if (![true, false, 0, 1].includes(supplied as boolean | number)) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的对象类型无法核对。');
      const kind = supplied === true || supplied === 1 ? 'directory' : 'file';
      if (result.kind !== undefined && result.kind !== kind) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的对象类型字段相互矛盾。');
      result.kind = kind;
    }
    if (value.size !== undefined) {
      if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) throw new DirectError('CLOUD_RECEIPT_UNVERIFIED', '原生回执的字节长度无法核对。');
      result.size = Number(value.size);
    }
    if (typeof value.md5 === 'string' && /^[a-f0-9]{32}$/iu.test(value.md5)) result.md5 = value.md5.toLowerCase();
    return result;
  }
  for (const key of ['data', 'file', 'files', 'result']) if (value[key]) { const result = receipt(value[key]); if (result) return result; }
  return null;
}
function receiptMatches(reported: ReceiptMetadata, actual: CloudObject): boolean {
  return Object.entries(reported).every(([key, value]) => actual[key as keyof CloudObject] === value);
}

/** 使用原有登记程序、账号安全引用和进程授权；不安装、登录、搜索个人根或删除远端。 */
export function createBaiduCustodyBackend(options: { configuration?: BaiduDriveConfiguration; processRuntime?: ProcessRuntime;
  files: FileReferenceService; artifactRoot: string; runTool?: typeof runDirectProcess }): CloudCustodyBackend {
  const configuration = options.configuration;
  // 只核对象身份，不读取账号/密钥正文；重启后也不能用变更过的原生账号引用续旧意图。
  const registeredIdentities = configuration ? [configuration.binaryPath, configuration.configPath,
    ...(configuration.tokenKeyPath ? [configuration.tokenKeyPath] : [])].map(path => {
    try { return { path, identity: inspectPath(path) }; } catch { return { path, identity: null }; }
  }) : [];
  const availability = () => {
    if (!configuration || !options.processRuntime) return { available: false, reason: '已登记的百度网盘程序或原生账号引用尚未装配。' };
    try {
      if (options.processRuntime.path('bdpan') !== configuration.binaryPath) throw new Error();
      if (registeredIdentities.some(item => !item.identity || !samePathIdentity(item.identity, inspectPath(item.path), true))) throw new Error();
      for (const path of [configuration.configPath, ...(configuration.tokenKeyPath ? [configuration.tokenKeyPath] : [])]) {
        const identity = inspectPath(path);
        if (identity.object?.kind !== 'file' || identity.links.length) throw new Error();
      }
      return { available: true };
    } catch { return { available: false, reason: '网盘程序或原生账号引用的对象身份不可用；需要恢复原登记，不自动登录。' }; }
  };
  const versionBinding = { cloudBackend: 'baidu-drive-custody/3', cloudConnection: configuration
    ? createHash('sha256').update(JSON.stringify(configuration)).digest('hex') : null, cloudBinding: configuration
    ? createHash('sha256').update(JSON.stringify({ configuration, identities: registeredIdentities })).digest('hex') : null };
  return { versionBinding, availability,
    async open(context, input) {
      if (!configuration || !availability().available) throw new DirectError('CLOUD_UNAVAILABLE', availability().reason!);
      const scope = cloudPath(input.scopePath);
      const directories = new Set([scope, ...(input.sourceRemotePath ? [posix.dirname(cloudPath(input.sourceRemotePath))] : []),
        ...(input.targetDirectory ? [cloudPath(input.targetDirectory)] : [])]);
      const identities = registeredIdentities;
      const authority = await acquireAuthority(context, input.allowUpload ? 'cloud.custody.upload' : 'cloud.custody.verify', input as unknown as JsonValue,
        [fileCapability('execute', configuration.binaryPath), { action: 'secret', target: { kind: 'secret', name: 'baidu-drive.native-login' } },
          ...['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'].map(origin => ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
          ...(['read', 'write', 'delete'] as const).map(action => directoryCapability(action, options.artifactRoot))]);
      const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority);
      await workspace.create();
      let retained = false;
      const writeAttempts = new Set<string>();
      const claimWrite = (path: string) => {
        if (retained || writeAttempts.has(path)) throw new DirectError('CLOUD_WRITE_ALREADY_ATTEMPTED', '本次会话已有待核对写入或原目标已经开始核对，不能重发、自动改名或改成本地上传；请沿原目标读回。', true);
        writeAttempts.add(path);
      };
      const assertCurrent = () => {
        authority.assert(); workspace.assertCurrent();
        if (identities.some(item => !item.identity || !samePathIdentity(item.identity, inspectPath(item.path), true))) throw new DirectError('CLOUD_VERSION_CONFLICT', '网盘程序或原生账号引用已经变化，不能替换原绑定继续。');
      };
      // 归档不再直接调用 CLI 解析器，而是统一使用 baidu.drive Skill 的固定命令能力。
      const invoke = async (args: string[], exactMissing = false) => {
        try {
          return await runBaiduSkillCommand({
            configuration, processRuntime: options.processRuntime!, context, workspacePath: workspace.path,
            assertCurrent, args, runTool: options.runTool, exactMissing,
          });
        } catch (error) {
          if (error instanceof DirectProcessError && error.disposition === 'unknown') retained = true;
          throw error;
        }
      };
      const listOutput = async (path: string, offset: number, limit: number) => {
        cloudPath(path);
        if (!directories.has(path) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DirectError('INVALID_CLOUD_RANGE', '目录查询超出本次明确目录或分页预算。');
        return invoke(['ls', path, '--start', String(offset), '--limit', String(limit)]);
      };
      const list = async (path: string, offset: number, limit: number) =>
        parseCloudPage(await listOutput(path, offset, limit), path, offset, limit);
      const exact = async (path: string): Promise<CloudObject | null> => {
        let offset = 0;
        for (let page = 0; page < 20; page++) {
          const parent = posix.dirname(path), value = await listOutput(parent, offset, 100);
          // A directory returned as its own only entry proves its identity, not empty contents.
          // For one exact child, ask the native CLI for that same path and require explicit -9 or exact metadata.
          if (offset === 0 && Array.isArray(value) && value.length === 1) {
            const parentObject = cloudObject(value[0]!);
            if (parentObject.path === parent && parentObject.kind === 'directory') {
              const probe = await invoke(['ls', cloudPath(path), '--start', '0', '--limit', '1'], true);
              if (probe === null) return null;
              if (!Array.isArray(probe) || probe.length !== 1) throw new DirectError('CLOUD_OBJECT_UNVERIFIED', '原生目录仅返回自身，指定子对象没有可核对的精确元数据。');
              const actual = cloudObject(probe[0]!);
              if (actual.path !== path) throw new DirectError('CLOUD_OBJECT_UNVERIFIED', '精确子对象查询返回其他路径，不能据此认定存在或缺失。');
              return actual;
            }
          }
          const result = parseCloudPage(value, parent, offset, 100), matches = result.items.filter(item => item.path === path);
          if (matches.length > 1) throw new DirectError('CLOUD_OBJECT_UNVERIFIED', '远端单对象身份有冲突。');
          if (matches[0]) return matches[0];
          if (!result.hasMore) return null;
          offset = result.nextOffset!;
        }
        throw new DirectError('CLOUD_SCAN_BUDGET', '目标父目录超出本次分页预算，当前不能核对目标缺失。');
      };
      const directoryIdentities = new Map<string, CloudObject>();
      const prepareDirectory = async (path: string, create: boolean): Promise<boolean> => {
        cloudPath(path);
        if (path !== input.targetDirectory || !evidenceDirectory(path) || typeof create !== 'boolean') throw new DirectError('CLOUD_EVIDENCE_DIRECTORY_REQUIRED', '需要本次绑定的证据盘主题及用途二级目录，不能写入根、一级或任意目录。');
        if (create && !input.allowUpload) throw new DirectError('CLOUD_DIRECTORY_AUTHORIZATION_REQUIRED', '创建归档目录需要本次归档写入授权。');
        const hierarchy = [CLOUD_EVIDENCE_ROOT, posix.dirname(path), path];
        for (const directory of hierarchy) directories.add(posix.dirname(directory));
        for (const directory of hierarchy) {
          let current = await exact(directory);
          const known = directoryIdentities.get(directory);
          if (current && current.kind !== 'directory') throw new DirectError('CLOUD_DIRECTORY_CONFLICT', '归档目录名已被文件占用，不能覆盖、改名或创建平行目录。');
          if (known && (!current || !sameObject(known, current))) throw new DirectError('CLOUD_DIRECTORY_CHANGED', '本次已经核对的证据目录身份已变化，不能替换原目录继续写入。');
          if (!current) {
            if (!create) return false;
            if (directory === CLOUD_EVIDENCE_ROOT) throw new DirectError('CLOUD_EVIDENCE_ROOT_MISSING', '专用证据盘根尚未核实存在；本次不会创建根目录。');
            const parent = directoryIdentities.get(posix.dirname(directory))!;
            claimWrite(directory);
            const effectId = randomUUID();
            await context.emit({ type: 'side_effect_started', effectId, description: '首次归档创建所选证据分类目录', operation: { path: directory, parentId: parent.id } });
            retained = true;
            try {
              // 原生写命令按应用根接收相对参数；登记、占位和读回始终使用完整路径。
              const value = await invoke(['mkdir', posix.relative(CLOUD_ROOT, directory)]);
              if (pending(value)) throw new DirectError('CLOUD_DIRECTORY_PENDING', '网盘仅确认目录创建已受理，必须核对原目录，不能重发或换名创建。', true);
              const actual = await exact(directory), currentParent = await exact(parent.path), reported = receipt(value);
              if (!actual || actual.kind !== 'directory' || !currentParent || !sameObject(parent, currentParent) || reported && !receiptMatches(reported, actual)) {
                throw new DirectError('CLOUD_DIRECTORY_UNKNOWN_RESULT', '目录创建后的精确对象或原父目录身份不能核对，不能继续创建或归档。', true);
              }
              await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '已按原路径读回新目录，并核对目录编号、类型及原父目录身份。', data: { directory: actual as unknown as JsonValue } });
              retained = false; current = actual;
            } catch (error) {
              if (error instanceof DirectError && error.unknown) throw error;
              throw new DirectError('CLOUD_DIRECTORY_UNKNOWN_RESULT', '目录创建已经发出，但回执或原目录不能核对；不能重发、改名或继续写入。', true);
            }
          }
          directoryIdentities.set(directory, current);
        }
        return true;
      };
      return { list, prepareDirectory, lookup: exact,
        async read(remote, maxBytes) {
          if (!input.verifyBytes) throw new DirectError('CLOUD_READ_AUTHORIZATION_REQUIRED', '本次仅核对目录与文件名，尚未明确授权下载原件核证。');
          if (remote.kind !== 'file' || remote.size < 1 || remote.size > maxBytes || maxBytes > CLOUD_MAX_BYTES) throw new DirectError('CLOUD_READ_BUDGET', '原件读回超出本次单件字节预算，目录不能当作文件。');
          const before = await exact(remote.path);
          if (!before || JSON.stringify(before) !== JSON.stringify(remote)) throw new DirectError('CLOUD_OBJECT_CHANGED', '读回前远端对象的编号、类型、长度或摘要已变化。');
          const destination = join(workspace.path, 'cloud-read-' + randomUUID());
          const effectId = randomUUID();
          await context.emit({ type: 'side_effect_started', effectId, description: '读回所选网盘原件到独立受控暂存', operation: { remoteId: remote.id, path: remote.path } });
          try {
            if (pending(await invoke(['download', remote.path, destination]))) throw new DirectError('CLOUD_READ_PENDING', '网盘只确认下载已受理，尚无完整原件读回。', true);
            const fingerprint = await workspace.fingerprint(destination, maxBytes), bytes = await workspace.readPrefix(destination, remote.size);
            const after = await exact(remote.path);
            if (fingerprint.bytes !== remote.size || bytes.length !== remote.size || !after || JSON.stringify(before) !== JSON.stringify(after)
              || remote.md5 && createHash('md5').update(bytes).digest('hex') !== remote.md5) throw new DirectError('CLOUD_READBACK_MISMATCH', '原件读回长度、远端版本或内容摘要不一致。');
            await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '远端单文件前后身份、完整字节长度及所提供的摘要已核对。' });
            return bytes;
          } catch (error) {
            if (!retained) await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '本次下载未通过完整读回核对；不认定已存在或缺失。' });
            throw error;
          }
        },
        async put(bytes, path) {
          cloudPath(path);
          const directory = posix.dirname(path);
          if (!input.allowUpload || !evidenceDirectory(directory) || directory !== input.targetDirectory || !bytes.length || bytes.length > CLOUD_MAX_BYTES) throw new DirectError('CLOUD_UPLOAD_AUTHORIZATION_REQUIRED', '尚未授权本次证据盘二级目录目标或超出单文件预算。');
          claimWrite(path);
          if (!await prepareDirectory(directory, false)) throw new DirectError('CLOUD_DIRECTORY_MISSING', '本次证据分类目录尚不存在，未发起上传。');
          if (await exact(path)) throw new DirectError('CLOUD_TARGET_EXISTS', '本次独立归档对象名已被占用，不能覆盖或自动改名。');
          const staged = await workspace.createBytes('cloud-upload-source', bytes);
          retained = true;
          try {
            const value = await invoke(['upload', staged, posix.relative(CLOUD_ROOT, path)]);
            if (pending(value)) throw new DirectError('CLOUD_UPLOAD_PENDING', '网盘只确认上传已受理，必须沿原对象核对，不重传。', true);
            const reported = receipt(value), actual = await exact(path);
            if (!reported || !actual || reported.path !== path || reported.id !== actual.id || !receiptMatches(reported, actual)
              || actual.kind !== 'file' || actual.size !== bytes.length) throw new DirectError('CLOUD_UPLOAD_UNKNOWN_RESULT', '上传回执与原目标的编号、类型或长度不符，不能认定完成或重传。', true);
            retained = false; return actual;
          } catch (error) {
            if (error instanceof DirectError && error.unknown) throw error;
            throw new DirectError('CLOUD_UPLOAD_UNKNOWN_RESULT', '上传已经发出，但原生回执或精确目标未能核对；保留本次暂存并只核对原目标，不重新上传。', true);
          }
        },
        async copy(source, targetDirectory) {
          const expected = { ...source, path: cloudPath(source.path) };
          cloudPath(targetDirectory);
          if (!input.allowUpload || !evidenceDirectory(targetDirectory) || input.targetDirectory !== targetDirectory
            || expected.kind !== 'file' || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > CLOUD_MAX_BYTES) {
            throw new DirectError('CLOUD_COPY_AUTHORIZATION_REQUIRED', '盘内复制需要明确归档写入授权，且只接受预算内的单文件。');
          }
          // 原生 cp（复制）只接收目标目录；保留原文件名，禁止改名绕过占用。
          const path = cloudPath(posix.join(targetDirectory, posix.basename(expected.path)));
          claimWrite(path);
          if (!await prepareDirectory(targetDirectory, false)) throw new DirectError('CLOUD_DIRECTORY_MISSING', '本次证据分类目录尚不存在，未发起盘内复制。');
          const before = await exact(expected.path);
          if (!before || !sameObject(before, expected)) throw new DirectError('CLOUD_OBJECT_CHANGED', '复制前原位置的对象编号、类型、长度或摘要已变化，未发起复制。');
          if (await exact(path)) throw new DirectError('CLOUD_TARGET_EXISTS', '证据盘内同名对象已被占用，不能覆盖或自动改名。');
          const effectId = randomUUID();
          await context.emit({ type: 'side_effect_started', effectId, description: '将已核证原件在网盘内复制到专用证据盘', operation: { source: before as unknown as JsonValue, targetPath: path } });
          retained = true;
          try {
            const sourceArgument = posix.relative(CLOUD_ROOT, before.path);
            const value = await invoke(['cp', ...(sourceArgument.startsWith('-') ? ['--'] : []), sourceArgument, posix.relative(CLOUD_ROOT, targetDirectory)]);
            if (pending(value)) throw new DirectError('CLOUD_COPY_PENDING', '网盘仅确认复制已受理，必须沿原目标读回核对，不能重发或改成本地上传。', true);
            const after = await exact(before.path), actual = await exact(path), reported = receipt(value);
            if (!after || !sameObject(before, after) || !actual || actual.kind !== 'file' || actual.size !== before.size || actual.id === before.id
              || (before.md5 !== null && actual.md5 !== null && before.md5 !== actual.md5)
              || reported && !receiptMatches(reported, actual)) {
              throw new DirectError('CLOUD_COPY_UNKNOWN_RESULT', '盘内复制后的原位置版本或精确目标元数据不一致，请沿原目标核对，不能重发或上传。', true);
            }
            await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '网盘复制回执、文件名、大小、编号及原位置/目标元数据已核对；未下载读回。', data: { target: actual as unknown as JsonValue } });
            retained = false;
            return actual;
          } catch (error) {
            if (error instanceof DirectError && error.unknown) throw error;
            throw new DirectError('CLOUD_COPY_UNKNOWN_RESULT', '盘内复制已经发出，但执行回执或原目标未能核对；请沿原目标读回，不能重发、改名或改成本地上传。', true);
          }
        },
        async close() { if (!retained) await workspace.cleanup(); },
      };
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import { basename, dirname, join, parse, relative } from 'node:path';
import { root, type Root } from '@openclaw/fs-safe';
import { retainEntryForPublication } from '@openclaw/fs-safe/advanced';
import type { RootCopyPublicationReceipt } from '@openclaw/fs-safe/root';
import type { FileReference, FileReferenceService } from '../resources/files.js';
import { digestOperationArgs, inspectPath, normalizePermissionPath, PermissionError, samePathIdentity, type PermissionCapability } from '../security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskOperation } from '../jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';

export class DirectError extends TaskError {
  constructor(code: string, message: string, readonly unknown = false) { super(code, message); this.name = 'DirectError'; }
}

export interface DirectAuthority {
  operation: TaskOperation;
  approvalId?: string;
  assert(): void;
}

export async function acquireAuthority(context: TaskExecutionContext, operationId: string, args: JsonValue,
  capabilities: readonly PermissionCapability[], options: { approvalMode?: 'automatic' | 'review' } = {}): Promise<DirectAuthority> {
  const targets = [...new Map(capabilities.map((capability) => [JSON.stringify(capability.target), capability.target])).values()];
  const operation: TaskOperation = { operationId, operationVersion: 1, argsDigest: digestOperationArgs(args), targets,
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}) };
  context.signal.throwIfAborted();
  let approvalId: string | undefined;
  try { context.assertAuthorized(operation, capabilities); }
  catch (error) {
    if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error;
    const receipt = await context.requestApproval(operation, capabilities, { signal: context.signal });
    approvalId = receipt.approvalId ?? undefined;
    context.signal.throwIfAborted();
    context.assertAuthorized(operation, capabilities, { approvalId });
  }
  return { operation, approvalId, assert() {
    context.signal.throwIfAborted();
    context.assertAuthorized(operation, capabilities, { approvalId });
  } };
}

export function fileCapability(action: PermissionCapability['action'], path: string): PermissionCapability { return { action, target: { kind: 'file', path } }; }
export function directoryCapability(action: PermissionCapability['action'], path: string): PermissionCapability { return { action, target: { kind: 'directory', path, recursive: true } }; }

export function verifyFileHandle(stat: BigIntStats, reference: FileReference): void {
  if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== reference.device || String(stat.ino) !== reference.inode
    || Number(stat.size) !== reference.size || String(stat.mtimeNs) !== reference.mtimeNs) {
    throw new DirectError('FILE_CHANGED', '打开的文件与登记对象不一致，请重新选择。');
  }
}

export interface OutputDestination { path: string; parent: ReturnType<typeof inspectPath> }
export function prepareDestination(path: string): OutputDestination {
  const normalized = normalizePermissionPath(path);
  const identity = inspectPath(normalized, { allowMissing: true });
  if (identity.exists) throw new DirectError('DESTINATION_EXISTS', '目标已经存在，请选择一个新名称。');
  const parent = inspectPath(dirname(normalized));
  if (parent.object?.kind !== 'directory') throw new DirectError('DESTINATION_PARENT_MISSING', '请先选择一个已经存在的目标目录。');
  if (parent.canonicalPath !== parent.invocationPath || parent.links.length) throw new DirectError('DESTINATION_ALIAS', '目标父目录需要使用真实目录路径。');
  const name = basename(normalized);
  if (!name || name === '.' || name === '..' || /[\u0000-\u001f:]/u.test(name)) throw new DirectError('INVALID_DESTINATION', '目标文件名无效。');
  return { path: normalized, parent };
}

export function assertDestinationCurrent(destination: OutputDestination): void {
  if (!samePathIdentity(destination.parent, inspectPath(dirname(destination.path)))) throw new DirectError('DESTINATION_CHANGED', '目标父目录已经变化。');
  if (inspectPath(destination.path, { allowMissing: true }).exists) throw new DirectError('DESTINATION_EXISTS', '目标已被其他操作创建，本次不会覆盖。');
}

/** 仅创建本次自有暂存。源文件通过已核对的句柄复制，外部工具只收到暂存路径。 */
export class DirectWorkspace {
  readonly path: string;
  private stageRoot?: Root;
  private stageIdentity?: ReturnType<typeof inspectPath>;
  private removed = false;
  private readonly publishedIds: string[] = [];

  constructor(private readonly context: TaskExecutionContext, private readonly files: FileReferenceService,
    readonly artifactRoot: string, private readonly authority: DirectAuthority) {
    this.path = join(artifactRoot, `.direct-${randomUUID()}`);
  }

  async create(): Promise<void> {
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '创建本次文件暂存目录', operation: { path: this.path } });
    try {
      this.authority.assert();
      const owner = await root(this.artifactRoot, { symlinks: 'reject', mutationSymlinks: 'reject', assertBeforeMutation: () => this.authority.assert() });
      await owner.mkdir(basename(this.path), { private: true });
      this.stageIdentity = inspectPath(this.path);
      this.stageRoot = await root(this.path, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject',
        assertBeforeMutation: () => this.assertCurrent(), mkdir: false, mode: 0o600 });
    } catch (error) { await this.recordStageFailure(effectId, this.path); throw error; }
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '新目录身份已核对，只用于本次暂存。', data: { path: this.path } });
    await this.recordRetained();
  }

  assertCurrent(): void {
    this.authority.assert();
    if (!this.stageIdentity || !samePathIdentity(this.stageIdentity, inspectPath(this.path))) throw new DirectError('STAGE_CHANGED', '本次暂存目录身份已变化。');
  }

  async copyReference(reference: FileReference, name: string, maxBytes: number, readAuthority: DirectAuthority = this.authority): Promise<string> {
    if (reference.kind !== 'file') throw new DirectError('NOT_A_FILE', '此动作需要普通文件。');
    if (reference.size > maxBytes) throw new DirectError('INPUT_TOO_LARGE', '文件超过本次处理上限。');
    const sourceOwner = await root(dirname(reference.canonicalPath), { symlinks: 'reject', hardlinks: 'reject' });
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '制作已核对源文件的暂存副本', operation: { fileRefId: reference.id, path: join(this.path, name) } });
    try {
      this.assertCurrent(); readAuthority.assert();
      await this.owner().copyIn(name, { root: {
      open: async (sourceName, options) => {
        this.assertCurrent(); readAuthority.assert(); this.files.verify(reference.id);
        const opened = await sourceOwner.open(sourceName, options);
        try { this.files.verify(reference.id); verifyFileHandle(await opened.handle.stat({ bigint: true }), reference); this.assertCurrent(); readAuthority.assert(); }
        catch (error) { await opened.handle.close(); throw error; }
        return opened;
      },
      stat: (sourceName) => sourceOwner.stat(sourceName),
    }, relativePath: basename(reference.canonicalPath) }, { overwrite: false, clone: 'never', maxBytes, signal: this.context.signal,
      assertBeforeMutation: () => { this.assertCurrent(); readAuthority.assert(); this.files.verify(reference.id); } });
      this.files.verify(reference.id);
      const observed = inspectPath(join(this.path, name));
      if (observed.object?.kind !== 'file' || observed.object.size !== reference.size) throw new DirectError('COPY_UNVERIFIED', '暂存副本的大小无法核对。', true);
    } catch (error) {
      if (!(error instanceof DirectError && error.unknown)) await this.recordStageFailure(effectId, join(this.path, name));
      throw error;
    }
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '源句柄、内容版本和暂存副本大小已核对。' });
    return join(this.path, name);
  }

  async createText(name: string, text: string): Promise<string> {
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '写入本次暂存文本', operation: { path: join(this.path, name) } });
    try {
      this.assertCurrent();
      await this.owner().create(name, text, { atomic: true, private: true, durable: 'file' });
    } catch (error) { await this.recordStageFailure(effectId, join(this.path, name)); throw error; }
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '文本以新建、不覆盖方式完成。' });
    return join(this.path, name);
  }

  async createBytes(name: string, bytes: Uint8Array): Promise<string> {
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '保存本次已下载的暂存内容' });
    try { this.assertCurrent(); await this.owner().create(name, Buffer.from(bytes), { atomic: true, private: true, durable: 'file' }); }
    catch (error) { await this.recordStageFailure(effectId, join(this.path, name)); throw error; }
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '暂存内容已完整新建。' });
    return join(this.path, name);
  }

  async createDirectory(name: string): Promise<string> {
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '创建本次暂存产物目录' });
    try {
      this.assertCurrent();
      await this.owner().mkdir(name, { private: true });
    } catch (error) { await this.recordStageFailure(effectId, join(this.path, name)); throw error; }
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '新建的暂存产物目录已核对。' });
    return join(this.path, name);
  }

  async fingerprint(path: string, maxBytes: number): Promise<{ bytes: number; sha256: string }> {
    this.assertCurrent();
    const opened = await this.owner().open(relative(this.path, path));
    try {
      const before = await opened.handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new DirectError('OUTPUT_TOO_LARGE', '工具产物不是允许的普通文件或超过上限。');
      const hash = createHash('sha256');
      let offset = 0;
      while (true) {
        this.assertCurrent();
        const buffer = Buffer.alloc(128_000);
        const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > maxBytes) throw new DirectError('OUTPUT_TOO_LARGE', '工具产物超过上限。');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await opened.handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(offset) !== before.size) {
        throw new DirectError('OUTPUT_CHANGED', '核对期间工具产物已变化。', true);
      }
      return { bytes: offset, sha256: hash.digest('hex') };
    } finally { await opened.handle.close(); }
  }

  async readText(path: string, maxBytes = 2_000_000): Promise<string> {
    this.assertCurrent();
    const bytes = await this.owner().readBytes(relative(this.path, path), { maxBytes });
    this.assertCurrent();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DirectError('INVALID_TEXT_OUTPUT', '工具没有生成有效 UTF-8 文本。'); }
  }

  async readPrefix(path: string, bytes: number): Promise<Buffer> {
    this.assertCurrent();
    const opened = await this.owner().open(relative(this.path, path));
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await opened.handle.read(buffer, 0, bytes, 0);
      this.assertCurrent();
      return buffer.subarray(0, bytesRead);
    } finally { await opened.handle.close(); }
  }

  async publishFile(path: string, destination: OutputDestination, action: string, args: JsonValue, maxBytes: number): Promise<FileReference> {
    const fingerprint = await this.fingerprint(path, maxBytes);
    const staged = inspectPath(path);
    const authorization = await acquireAuthority(this.context, `${action}.publish`, args, [directoryCapability('read', this.artifactRoot), fileCapability('write', destination.path)]);
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '发布已核对的新文件', operation: { destination: destination.path, sha256: fingerprint.sha256, bytes: fingerprint.bytes } });
    let receipt: RootCopyPublicationReceipt | undefined;
    const destinationOwner = await root(dirname(destination.path), { mutationSymlinks: 'reject', symlinks: 'reject', mkdir: false });
    await destinationOwner.copyIn(basename(destination.path), path, { overwrite: false, clone: 'never', maxBytes, signal: this.context.signal, mode: 0o600,
      assertBeforeMutation: () => {
        authorization.assert(); assertDestinationCurrent(destination); this.assertCurrent();
        if (!samePathIdentity(staged, inspectPath(path), true)) throw new DirectError('OUTPUT_CHANGED', '发布前工具产物已变化。');
      }, onDestinationPublished: (published) => { receipt = published; } });
    // 发布后原 missing-target 批准已失效；回执及元数据核对不重新读取新对象内容。
    const published = inspectPath(destination.path);
    if (!receipt || published.object?.kind !== 'file' || published.object.device !== String(receipt.dev) || published.object.inode !== String(receipt.ino)
      || published.object.size !== fingerprint.bytes || !samePathIdentity(destination.parent, inspectPath(dirname(destination.path)))) {
      throw new DirectError('PUBLICATION_UNKNOWN', '文件可能已发布，但结果身份无法完整核对。', true);
    }
    const reference = this.register(destination.path);
    this.publishedIds.push(reference.id);
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '不覆盖发布回执、文件身份与大小已核对。', data: { fileRefId: reference.id, ...fingerprint } });
    await this.context.emit({ type: 'checkpoint', checkpoint: { publishedArtifactIds: [...this.publishedIds], retainedScratch: this.path, path: destination.path, ...fingerprint } });
    return reference;
  }

  async publishDirectory(path: string, destination: OutputDestination, action: string, args: JsonValue): Promise<FileReference> {
    this.assertCurrent();
    const source = inspectPath(path);
    if (source.object?.kind !== 'directory' || source.object.device !== destination.parent.object?.device) throw new DirectError('CROSS_VOLUME_DIRECTORY', '解压目录当前只能发布到同一磁盘卷，请选择应用产物目录或同卷新目录。');
    const authorization = await acquireAuthority(this.context, `${action}.publish`, args, [directoryCapability('write', this.artifactRoot), directoryCapability('delete', this.artifactRoot), { action: 'write', target: { kind: 'directory', path: destination.path, recursive: true } }]);
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '以新目录发布解压产物', operation: { destination: destination.path } });
    const sourceParent = inspectPath(dirname(path));
    if (!sourceParent.object || !destination.parent.object) throw new DirectError('PUBLICATION_UNKNOWN', '目录发布的父对象无法核对。', true);
    const publication = retainEntryForPublication({
      source: { parent: { path: sourceParent.canonicalPath, identity: { dev: BigInt(sourceParent.object.device), ino: BigInt(sourceParent.object.inode) } },
        basename: basename(path), expected: { dev: BigInt(source.object.device), ino: BigInt(source.object.inode), kind: 'directory' } },
      destination: { parent: { path: destination.parent.canonicalPath, identity: { dev: BigInt(destination.parent.object.device), ino: BigInt(destination.parent.object.inode) } }, basename: basename(destination.path) },
      assertBeforeMutation: () => {
        authorization.assert(); this.assertCurrent(); assertDestinationCurrent(destination);
        if (!samePathIdentity(source, inspectPath(path))) throw new DirectError('OUTPUT_CHANGED', '解压暂存目录已经变化。');
      },
    });
    const publicationResult = publication.publish();
    if (publicationResult.transition === 'not-published' && publicationResult.resources === 'closed') {
      await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'not_applied', evidence: '原生不覆盖发布已明确拒绝，资源已关闭，源目录与目标均未由本次动作改变。' });
      throw new DirectError('DIRECTORY_NOT_PUBLISHED', '新目录未发布，请核对目标、权限或本机安全文件工具。');
    }
    if (publicationResult.transition !== 'committed' || publicationResult.verification !== 'verified' || publicationResult.resources !== 'closed') {
      throw new DirectError('PUBLICATION_UNKNOWN', '原生目录发布的提交、核对或资源关闭未完整确认。', true);
    }
    const result = inspectPath(destination.path);
    if (result.object?.device !== source.object.device || result.object?.inode !== source.object.inode || inspectPath(path, { allowMissing: true }).exists) {
      throw new DirectError('PUBLICATION_UNKNOWN', '目录发布后身份无法完整核对。', true);
    }
    const reference = this.register(destination.path);
    this.publishedIds.push(reference.id);
    await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '同卷不覆盖重命名与目录身份已核对。', data: { fileRefId: reference.id } });
    await this.context.emit({ type: 'checkpoint', checkpoint: { publishedArtifactIds: [...this.publishedIds], retainedScratch: this.path, path: destination.path } });
    return reference;
  }

  async cleanup(): Promise<void> {
    if (this.removed || !this.stageIdentity) return;
    // 停止会撤销新动作资格。已知残留留给恢复流程，不借旧授权删除。
    if (this.context.signal.aborted) { await this.recordRetained(); return; }
    this.assertCurrent();
    const retained = this.files.retireTemporaryDirectory(this.path, this.context.task.id, this.stageIdentity);
    if (retained) {
      this.removed = true; // 已解除本工作区所有权，后续由持久保留策略核对回收。
      await this.context.emit({ type: 'checkpoint', checkpoint: { publishedArtifactIds: [...this.publishedIds],
        retainedScratch: this.path, scratchReleased: true, temporaryExpiresAt: retained.expiresAt } });
      return;
    }
    const effectId = randomUUID();
    await this.context.emit({ type: 'side_effect_started', effectId, description: '清理本次已拥有的暂存目录', operation: { path: this.path } });
    const owner = await root(this.artifactRoot, { mutationSymlinks: 'reject', symlinks: 'reject', assertBeforeMutation: () => this.assertCurrent() });
    try {
      await owner.remove(basename(this.path), { recursive: true, maxEntries: 12_000, maxDepth: 64, signal: this.context.signal });
      if (inspectPath(this.path, { allowMissing: true }).exists) throw new DirectError('CLEANUP_UNKNOWN', '暂存清理结果无法核对。', true);
      this.removed = true;
      await this.context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '本次暂存目录已删除并核对不存在。' });
      await this.context.emit({ type: 'checkpoint', checkpoint: { publishedArtifactIds: [...this.publishedIds], scratchRemoved: true } });
    } catch (error) { await this.recordRetained(); throw new DirectError('CLEANUP_UNKNOWN', '本次暂存清理没有完整收束，需要核对。', true); }
  }

  async recordRetained(): Promise<void> {
    if (this.removed) return;
    const current = this.stageIdentity;
    await this.context.emit({ type: 'checkpoint', checkpoint: { retainedScratch: this.path, publishedArtifactIds: [...this.publishedIds],
      ...(current?.object ? { device: current.object.device, inode: current.object.inode } : {}) } });
  }

  private owner(): Root { if (!this.stageRoot) throw new DirectError('STAGE_NOT_CREATED', '暂存目录尚未创建。'); return this.stageRoot; }
  private async recordStageFailure(effectId: string, path: string): Promise<void> {
    try {
      if (this.stageIdentity && !samePathIdentity(this.stageIdentity, inspectPath(this.path))) return;
      const observation = inspectPath(path, { allowMissing: true });
      await this.context.emit({ type: 'side_effect_result', effectId, outcome: observation.exists ? 'failed' : 'not_applied',
        evidence: '已启动的暂存文件操作已经收束；用户目标尚未发布，观察到的暂存残留已记录。',
        data: { retainedScratch: this.path, outputPath: path, exists: observation.exists } });
    } catch { /* 无法核对或记录时保留未确认副作用，交给 Task 判定 needs_review。 */ }
  }
  private register(path: string): FileReference {
    const reference = this.files.register({ path, source: 'generated', taskId: this.context.task.id,
      ...(this.context.task.conversationId ? { conversationId: this.context.task.conversationId } : {}) });
    return this.files.link(reference.id, { artifactId: reference.id });
  }
}

export function commonAncestor(left: string, right: string): string {
  let candidate = dirname(left);
  while (relative(candidate, right).startsWith('..') || parse(candidate).root !== parse(right).root) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { root } from '@openclaw/fs-safe';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import type { FileReference, FileReferenceService } from '../../resources/files.js';
import { readPinnedFile } from '../../resources/pinned-read.js';
import { inspectPath, samePathIdentity } from '../../security/permissions.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, fileCapability, prepareDestination, verifyFileHandle, type DirectAuthority } from '../../runtime/file-workspace.js';

const TEXT_LIMITS = { inputBytes: 20_000_000, writeBytes: 2_000_000, pageBytes: 32_000, entries: 10_000,
  matches: 2000, searchBytes: 32_000_000, outputBytes: 2_000_000, depth: 32 } as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Args = Record<string, JsonValue>;

function assertReference(files: FileReferenceService, expected: FileReference): void {
  const current = files.verify(expected.id);
  if (current.version !== expected.version || !samePathIdentity(expected.identity, current.identity, true)) {
    throw new DirectError('FILE_CHANGED', '文件引用或内容版本已变化，请读取当前版本后重试。');
  }
}
function decode(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new DirectError('NOT_UTF8_TEXT', '此动作只处理有效 UTF-8 文本。'); }
  if (text.includes('\0')) throw new DirectError('NOT_TEXT_FILE', '所选文件含二进制零字节，不能按普通文本处理。');
  return text;
}
async function readSelected(files: FileReferenceService, reference: FileReference, authority: DirectAuthority, maxBytes: number): Promise<Buffer> {
  if (reference.kind !== 'file') throw new DirectError('NOT_A_FILE', '文本动作需要已登记的普通文件。');
  if (reference.size > maxBytes) throw new DirectError('FILE_TOO_LARGE', '文件超过本次文本处理上限。');
  const owner = await root(dirname(reference.canonicalPath), { symlinks: 'reject', hardlinks: 'reject' });
  return await readPinnedFile(owner, basename(reference.canonicalPath), reference, () => { authority.assert(); assertReference(files, reference); });
}

/** offset 从 1 开始按行定位；每页同时受行数与 UTF-8 字节限制，不静默跳过超长行。 */
export async function readTextPage(context: TaskExecutionContext, args: Args, files: FileReferenceService): Promise<TaskResult> {
  const reference = files.getRef(String(args.fileRefId));
  const authority = await acquireAuthority(context, 'file.read', args, [fileCapability('read', reference.invocationPath)]);
  const bytes = await readSelected(files, reference, authority, Number(args.maxBytes ?? TEXT_LIMITS.inputBytes));
  const text = decode(bytes);
  const offset = Number(args.offset ?? 1), limit = Number(args.limit ?? 200);
  const selected: { line: number; text: string }[] = []; let size = 0, totalLines = 0, full = false, nextCheck = 64_000;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start), finish = end < 0 ? text.length : end;
    totalLines++;
    if (totalLines >= offset && !full && selected.length < limit) {
      const line = text.slice(start, finish), count = Buffer.byteLength(JSON.stringify({ line: totalLines, text: line }));
      if (size + count > TEXT_LIMITS.pageBytes) {
        if (!selected.length) throw new DirectError('TEXT_LINE_TOO_LONG', '这一行超过 32,000 字节的单页上限，未截断或跳过该行。');
        full = true;
      } else { size += count; selected.push({ line: totalLines, text: line }); }
    }
    start = end < 0 ? text.length : end + 1;
    if (start >= nextCheck) { await setImmediate(); authority.assert(); nextCheck = start + 64_000; }
  }
  authority.assert(); assertReference(files, reference);
  const nextOffset = offset - 1 + selected.length < totalLines ? offset + selected.length : null;
  return { summary: `已读取“${reference.displayName}”的 ${selected.length} 行。`, data: { modelCalls: 0, fileRefId: reference.id,
    version: reference.version, sha256: sha256(bytes), bytes: bytes.length, offset, lineCount: selected.length, totalLines,
    nextOffset, done: nextOffset === null, text: selected.map(line => `${line.line}\t${line.text}`).join('\n') } };
}

function selectedDirectory(files: FileReferenceService, id: string): FileReference {
  const directory = files.verify(id);
  if (directory.kind !== 'directory' || directory.identity.links.length || directory.canonicalPath !== directory.invocationPath) {
    throw new DirectError('NOT_A_DIRECTORY', '请选择未经过符号链接的真实目录引用。');
  }
  return directory;
}
function checkedPattern(value: string): string {
  if (!value || value.length > 512 || isAbsolute(value) || /^[a-z]:/iu.test(value) || value.includes('\\') || value.split('/').includes('..')) {
    throw new DirectError('INVALID_PATTERN', '路径模式必须使用目录内相对路径和正斜线，不允许 ..、盘符或绝对路径。');
  }
  return value.includes('/') ? value : '**/' + value;
}

/** 只遍历所选目录，不跟随链接；正文按文字匹配，完整受限结果另存为登记产物。 */
export async function searchTextFiles(context: TaskExecutionContext, action: 'file.glob' | 'file.grep', args: Args,
  files: FileReferenceService, artifactRoot: string, assertPath: (path: string) => void): Promise<TaskResult> {
  const directory = selectedDirectory(files, String(args.directoryRefId)), pattern = checkedPattern(String(args.pattern ?? '**/*'));
  const query = action === 'file.grep' ? String(args.query) : null;
  if (query !== null && (!query.length || /[\r\n]/u.test(query))) throw new DirectError('INVALID_QUERY', '正文检索需要单行、非空的文字，不执行正则表达式。');
  const insensitive = args.caseSensitive === 'false', needle = insensitive ? query?.toLowerCase() : query;
  const authority = await acquireAuthority(context, action, args, [directoryCapability('read', directory.invocationPath)]);
  const verify = () => { authority.assert(); assertReference(files, directory); };
  verify();
  const owner = await root(directory.canonicalPath, { symlinks: 'reject', hardlinks: 'reject' });
  const pending = [{ path: '.', depth: 0, identity: directory.identity }], matches: JsonValue[] = [];
  const skipped = { links: 0, protected: 0, binary: 0, tooLarge: 0, depth: 0 };
  let examined = 0, readBytes = 0, outputBytes = 0, capped = false;
  while (pending.length && !capped) {
    const current = pending.pop()!;
    verify();
    if (!samePathIdentity(current.identity, inspectPath(join(directory.canonicalPath, current.path)))) throw new DirectError('SEARCH_PATH_CHANGED', '检索期间子目录身份已变化。');
    for await (const entry of owner.entries(current.path, { signal: context.signal, symlinks: 'reject' })) {
      verify();
      if (++examined > TEXT_LIMITS.entries) { capped = true; break; }
      const child = join(current.path, entry.name), path = join(directory.canonicalPath, child);
      if (entry.isSymbolicLink || !entry.isDirectory && !entry.isFile) { skipped.links++; continue; }
      try { assertPath(path); }
      catch (error) {
        if (error instanceof DirectError && ['PROTECTED_RESOURCE', 'HARDLINK_REFUSED'].includes(error.code)) { skipped.protected++; continue; }
        throw error;
      }
      const identity = inspectPath(path), rel = relative(directory.canonicalPath, identity.canonicalPath);
      if (identity.links.length || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new DirectError('SEARCH_PATH_CHANGED', '检索期间目录路径已变化，未返回越界对象。');
      if (entry.isDirectory) {
        if (current.depth >= TEXT_LIMITS.depth) skipped.depth++;
        else pending.push({ path: child, depth: current.depth + 1, identity });
        continue;
      }
      const relativePath = child.split(sep).join('/');
      if (!matchesGlob(relativePath, pattern)) continue;
      const reference = files.register({ path, source: 'user-selected', taskId: context.task.id,
        ...(context.task.conversationId ? { conversationId: context.task.conversationId } : {}) });
      if (reference.identity.links.length || !samePathIdentity(identity, reference.identity, true)) throw new DirectError('SEARCH_PATH_CHANGED', '检索对象在登记时发生变化，未读取替换后的对象。');
      const add = (value: JsonValue) => {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (matches.length >= TEXT_LIMITS.matches || outputBytes + size > TEXT_LIMITS.outputBytes) { capped = true; return; }
        matches.push(value); outputBytes += size;
      };
      if (query === null) add({ fileRefId: reference.id, version: reference.version, path: relativePath, bytes: reference.size });
      else {
        if (reference.size > TEXT_LIMITS.inputBytes) { skipped.tooLarge++; continue; }
        if (readBytes + reference.size > TEXT_LIMITS.searchBytes) { capped = true; break; }
        let text: string; const bytes = await readSelected(files, reference, authority, TEXT_LIMITS.inputBytes);
        readBytes += bytes.length;
        try { text = decode(bytes); }
        catch (error) { if (error instanceof DirectError && ['NOT_TEXT_FILE', 'NOT_UTF8_TEXT'].includes(error.code)) { skipped.binary++; continue; } throw error; }
        const digest = sha256(bytes); let nextCheck = 0;
        for (let start = 0, lineNumber = 1; start <= text.length; lineNumber++) {
          if (start >= nextCheck) { await setImmediate(); verify(); nextCheck = start + 64_000; }
          const end = text.indexOf('\n', start), line = text.slice(start, end < 0 ? text.length : end), haystack = insensitive ? line.toLowerCase() : line;
          if (haystack.includes(needle!)) add({ fileRefId: reference.id, version: reference.version, sha256: digest, path: relativePath, line: lineNumber, text: line });
          if (capped) break;
          if (end < 0) break;
          start = end + 1;
        }
        assertReference(files, reference);
      }
      if (capped) break;
    }
  }
  verify();
  const preview: JsonValue[] = []; let previewBytes = 0;
  for (const match of matches) {
    const size = Buffer.byteLength(JSON.stringify(match));
    if (preview.length >= Number(args.limit ?? 40) || previewBytes + size > TEXT_LIMITS.pageBytes) break;
    preview.push(match); previewBytes += size;
  }
  const partial = capped || skipped.depth > 0 || skipped.tooLarge > 0 || skipped.protected > 0;
  const data = { modelCalls: 0, directoryRefId: directory.id, pattern: String(args.pattern ?? '**/*'), query, matching: query === null ? 'glob' : 'literal',
    matches: preview, totalMatches: matches.length, examined, readBytes, skipped, partial, truncated: preview.length < matches.length };
  let artifactId: string | undefined;
  if (preview.length < matches.length) {
    const saved = await saveSearchResult(context, action, args, files, artifactRoot, JSON.stringify({ ...data, matches }));
    artifactId = saved.id;
  }
  return { summary: `在“${directory.displayName}”允许检索的范围内找到 ${matches.length} 条结果${partial ? '；部分对象未检索，详情见限制计数' : ''}。`,
    data: { ...data, ...(artifactId ? { fileRefId: artifactId } : {}) }, ...(artifactId ? { artifactIds: [artifactId] } : {}) };
}

async function saveSearchResult(context: TaskExecutionContext, action: string, args: Args, files: FileReferenceService, artifactRoot: string, text: string): Promise<FileReference> {
  const authority = await acquireAuthority(context, action + '.output', args, ['read', 'write', 'delete'].map(value => directoryCapability(value as 'read' | 'write' | 'delete', artifactRoot)));
  const workspace = new DirectWorkspace(context, files, artifactRoot, authority);
  try {
    await workspace.create();
    const path = await workspace.createText('matches.json', text);
    const result = await workspace.publishFile(path, prepareDestination(join(artifactRoot, 'matches-' + randomUUID() + '.json')), action, args, TEXT_LIMITS.outputBytes + 128_000);
    await workspace.cleanup(); return result;
  } catch (error) {
    let failure = error;
    if (!(error instanceof DirectError && error.unknown)) try { await workspace.cleanup(); } catch (cleanupError) { failure = cleanupError; }
    await workspace.recordRetained(); throw failure;
  }
}

/** 只在明确登记目录内新建一个文本；暂存、发布、引用登记均沿用现有流程。 */
export async function createTextFile(context: TaskExecutionContext, args: Args, files: FileReferenceService,
  artifactRoot: string, assertPath: (path: string) => void): Promise<TaskResult> {
  const directory = selectedDirectory(files, String(args.directoryRefId)), name = String(args.name), content = String(args.content);
  if (!name || name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f]/u.test(name)) throw new DirectError('INVALID_FILENAME', '新文本需要单独文件名，不能包含目录或控制字符。');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > TEXT_LIMITS.writeBytes || decode(bytes) !== content) throw new DirectError('TEXT_WRITE_LIMIT', '新文本必须是有效 UTF-8 字符串且不超过 2,000,000 字节。');
  const destination = prepareDestination(join(directory.canonicalPath, name)); assertPath(destination.path);
  const permission = await acquireAuthority(context, 'file.write', args, [directoryCapability('read', directory.invocationPath),
    ...['read', 'write', 'delete'].map(value => directoryCapability(value as 'read' | 'write' | 'delete', artifactRoot))]);
  const authority = { ...permission, assert() { permission.assert(); assertReference(files, directory); } };
  const workspace = new DirectWorkspace(context, files, artifactRoot, authority);
  try {
    authority.assert(); await workspace.create();
    const path = await workspace.createText('new-text.txt', content);
    authority.assert();
    const output = await workspace.publishFile(path, destination, 'file.write', args, TEXT_LIMITS.writeBytes);
    await workspace.cleanup();
    return { summary: `已新建文本“${name}”。`, artifactIds: [output.id], data: { modelCalls: 0, fileRefId: output.id,
      version: output.version, directoryRefId: directory.id, bytes: bytes.length, sha256: sha256(bytes) } };
  } catch (error) {
    let failure = error;
    if (!(error instanceof DirectError && error.unknown)) try { await workspace.cleanup(); } catch (cleanupError) { failure = cleanupError; }
    await workspace.recordRetained(); throw failure;
  }
}

/** 原摘要和唯一匹配均核对后，原子替换；发布后任何核验失败都保留未知副作用。 */
export async function editTextFile(context: TaskExecutionContext, args: Args, files: FileReferenceService): Promise<TaskResult> {
  const reference = files.verify(String(args.fileRefId));
  if (reference.kind !== 'file' || reference.identity.links.length) throw new DirectError('NOT_A_FILE', '编辑需要未经过符号链接的普通文件引用。');
  const expected = String(args.expectedSha256), oldText = String(args.oldText), newText = String(args.newText);
  if (!/^[a-f0-9]{64}$/u.test(expected) || !oldText.length) throw new DirectError('INVALID_EDIT', '编辑需要读取返回的原始 SHA-256 摘要和非空的精确原文。');
  const authority = await acquireAuthority(context, 'file.edit', args, [fileCapability('read', reference.invocationPath), fileCapability('write', reference.invocationPath)]);
  const bytes = await readSelected(files, reference, authority, TEXT_LIMITS.writeBytes), text = decode(bytes);
  if (sha256(bytes) !== expected) throw new DirectError('EDIT_HASH_MISMATCH', '原内容摘要不符，未修改文件；请重新读取后构造编辑。');
  if (decode(Buffer.from(oldText, 'utf8')) !== oldText || decode(Buffer.from(newText, 'utf8')) !== newText) throw new DirectError('INVALID_EDIT', '原文与替换文字必须是有效 UTF-8 字符串。');
  const first = text.indexOf(oldText);
  if (first < 0 || args.replaceAll !== 'true' && text.indexOf(oldText, first + 1) >= 0) throw new DirectError('EDIT_MATCH_COUNT', '原文未找到或匹配不唯一；默认需要恰好一处精确匹配。');
  let replacements = 0;
  for (let start = first; start >= 0; start = text.indexOf(oldText, start + oldText.length)) replacements++;
  const expectedBytes = bytes.length + replacements * (Buffer.byteLength(newText, 'utf8') - Buffer.byteLength(oldText, 'utf8'));
  if (expectedBytes > TEXT_LIMITS.writeBytes) throw new DirectError('TEXT_WRITE_LIMIT', '替换后的文本超过 2,000,000 字节，未构造或写入超限结果。');
  const updated = text.split(oldText).join(newText), output = Buffer.from(updated, 'utf8');
  if (output.length > TEXT_LIMITS.writeBytes || decode(output) !== updated) throw new DirectError('TEXT_WRITE_LIMIT', '编辑结果必须是有效 UTF-8 文本且不超过 2,000,000 字节。');
  const digest = sha256(output);
  if (updated === text) return { summary: '匹配原文与替换内容相同，文件无需修改。', data: { modelCalls: 0, fileRefId: reference.id,
    sourceVersion: reference.version, version: reference.version, beforeSha256: expected, sha256: digest, bytes: output.length, changed: false, replacements } };
  const parent = inspectPath(dirname(reference.canonicalPath)), owner = await root(parent.canonicalPath, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject', mkdir: false });
  const opened = await owner.open(basename(reference.canonicalPath));
  const original = fstatSync(opened.handle.fd, { bigint: true });
  const verifyOriginal = () => {
    authority.assert(); assertReference(files, reference);
    if (!samePathIdentity(parent, inspectPath(parent.invocationPath))) throw new DirectError('FILE_CHANGED', '编辑父目录身份已变化。');
    verifyFileHandle(fstatSync(opened.handle.fd, { bigint: true }), reference);
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.handle.fd, chunk, 0, Math.min(chunk.length, bytes.length - offset), offset);
      if (!count) throw new DirectError('FILE_CHANGED', '编辑前原文件长度已变化。');
      offset += count; hash.update(chunk.subarray(0, count));
    }
    const after = fstatSync(opened.handle.fd, { bigint: true }); verifyFileHandle(after, reference);
    if (after.ctimeNs !== original.ctimeNs || hash.digest('hex') !== expected) throw new DirectError('EDIT_HASH_MISMATCH', '编辑前原文件内容已变化，未采用旧摘要。');
  };
  const effectId = randomUUID(); let started = false;
  try {
    verifyOriginal();
    await context.emit({ type: 'side_effect_started', effectId, description: '按原摘要和精确文字原子编辑文件',
      operation: { fileRefId: reference.id, sourceVersion: reference.version, beforeSha256: expected, sha256: digest } }); started = true;
    await owner.write(basename(reference.canonicalPath), output, { overwrite: true, mkdir: false, durable: true, assertBeforeMutation: verifyOriginal });
    const identity = inspectPath(reference.invocationPath);
    if (identity.links.length || identity.object?.kind !== 'file' || identity.object.size !== output.length
      || !samePathIdentity(parent, inspectPath(parent.invocationPath))) throw new DirectError('EDIT_RESULT_UNKNOWN', '编辑可能已发布，但结果对象无法核对。', true);
    const edited: FileReference = { ...reference, identity, device: identity.object.device, inode: identity.object.inode,
      size: identity.object.size, mtimeNs: identity.object.mtimeNs, mtimeMs: identity.object.mtimeMs };
    const saved = await readPinnedFile(owner, basename(reference.canonicalPath), edited, () => {
      if (!samePathIdentity(identity, inspectPath(reference.invocationPath), true) || !samePathIdentity(parent, inspectPath(parent.invocationPath))) throw new DirectError('EDIT_RESULT_UNKNOWN', '核验期间编辑结果或父目录已变化。', true);
    });
    if (sha256(saved) !== digest) throw new DirectError('EDIT_RESULT_UNKNOWN', '编辑结果字节摘要与预期不同。', true);
    const current = files.updateAfterEdit(reference.id, { expectedVersion: reference.version, identity });
    files.link(current.id, { taskId: context.task.id, artifactId: current.id, ...(context.task.conversationId ? { conversationId: context.task.conversationId } : {}) });
    await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '原摘要、精确匹配、原子替换后的字节摘要与文件引用新版本已核对。',
      data: { fileRefId: current.id, sourceVersion: reference.version, version: current.version, beforeSha256: expected, sha256: digest } });
    return { summary: `已精确编辑“${reference.displayName}”的 ${replacements} 处原文。`, artifactIds: [current.id],
      data: { modelCalls: 0, fileRefId: current.id, sourceVersion: reference.version, version: current.version,
        beforeSha256: expected, sha256: digest, bytes: output.length, changed: true, replacements } };
  } catch (error) {
    if (started) {
      try {
        verifyOriginal();
        await context.emit({ type: 'side_effect_result', effectId, outcome: 'not_applied', evidence: '原文件对象、字节摘要和路径仍与编辑前一致，目标未应用此次编辑。' });
      } catch {
        throw new DirectError('EDIT_RESULT_UNKNOWN', '编辑可能已经产生影响，未报告成功；需沿原任务核对文件与结果摘要。', true);
      }
    }
    throw error;
  } finally { await opened.handle.close(); }
}

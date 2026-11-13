import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ResourceBindings, ResourceReference } from '../../platform/resources/bindings.js';
import { MaterialError } from './data-processing/material-inspector/index.js';

export const MANAGED_ORIGINAL_MAX_BYTES = 256 * 1024 * 1024;
const STREAM_BLOCK_BYTES = 256 * 1024;
export const MANAGED_ORIGINAL_BLOCK_BYTES = 2 * 1024 * 1024;

export interface ManagedOriginalIdentity {
  version: 1;
  resource: ResourceReference;
  device: string;
  inode: string;
  mtimeNs: string;
  ctimeNs: string;
  byteLength: number;
  sha256: string;
}
export interface ManagedOriginalFile extends ManagedOriginalIdentity {
  blockSha256: string[];
}
export function managedOriginalError(code: string, message: string): never { throw new MaterialError(code, message); }
export function statIdentity(stat: BigIntStats) {
  if (!stat.isFile() || stat.nlink !== 1n) managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件须为无额外硬链接的普通文件。');
  return { device: String(stat.dev), inode: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), byteLength: Number(stat.size) };
}
export function managedPath(bindings: ResourceBindings | undefined, resource: ResourceReference): string {
  try { return bindings!.resolve(resource); }
  catch { return managedOriginalError('MANAGED_ORIGINAL_UNAVAILABLE', '受管原件目录缺失、身份改变或包含符号链接。'); }
}
export function managedPathStat(path: string): BigIntStats {
  try { return lstatSync(path, { bigint: true }); }
  catch { return managedOriginalError('MANAGED_ORIGINAL_UNAVAILABLE', '受管原件文件不可访问。'); }
}
export function assertManagedIdentity(stat: BigIntStats, expected: ManagedOriginalIdentity): void {
  const actual = statIdentity(stat);
  if (expected.version !== 1 || !/^[a-f0-9]{64}$/u.test(expected.sha256)
    || !Number.isSafeInteger(expected.byteLength) || expected.byteLength < 1 || expected.byteLength > MANAGED_ORIGINAL_MAX_BYTES
    || actual.device !== expected.device || actual.inode !== expected.inode || actual.byteLength !== expected.byteLength
    || actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) {
    managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件文件身份、大小或写入版本已改变。');
  }
}
export function verifyManagedPath(bindings: ResourceBindings | undefined, expected: ManagedOriginalIdentity): string {
  const path = managedPath(bindings, expected.resource);
  assertManagedIdentity(managedPathStat(path), expected);
  return path;
}

function syncRead(bindings: ResourceBindings | undefined, file: ManagedOriginalIdentity, offset: number, length: number): Buffer {
  const path = verifyManagedPath(bindings, file);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assertManagedIdentity(fstatSync(fd, { bigint: true }), file);
    const bytes = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
      const n = readSync(fd, bytes, consumed, length - consumed, offset + consumed);
      if (!n) managedOriginalError('MANAGED_ORIGINAL_CHANGED', '读取受管原件时遇到提前结束。');
      consumed += n;
    }
    assertManagedIdentity(fstatSync(fd, { bigint: true }), file);
    verifyManagedPath(bindings, file);
    return bytes;
  } finally { closeSync(fd); }
}
export function readManagedRange(bindings: ResourceBindings | undefined, file: ManagedOriginalFile, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
    || length > MANAGED_ORIGINAL_BLOCK_BYTES || offset + length > file.byteLength) {
    managedOriginalError('MANAGED_ORIGINAL_RANGE', '原件范围须位于冻结整件内，单次最多 2 MiB。');
  }
  if (!length) return syncRead(bindings, file, offset, length);
  const first = Math.floor(offset / MANAGED_ORIGINAL_BLOCK_BYTES);
  const last = Math.floor((offset + length - 1) / MANAGED_ORIGINAL_BLOCK_BYTES);
  const start = first * MANAGED_ORIGINAL_BLOCK_BYTES;
  const end = Math.min(file.byteLength, (last + 1) * MANAGED_ORIGINAL_BLOCK_BYTES);
  if (file.blockSha256.length !== Math.ceil(file.byteLength / MANAGED_ORIGINAL_BLOCK_BYTES)) {
    managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件缺少完整固化块摘要。');
  }
  const bytes = syncRead(bindings, file, start, end - start);
  for (let index = first; index <= last; index++) {
    const blockOffset = (index - first) * MANAGED_ORIGINAL_BLOCK_BYTES;
    const block = bytes.subarray(blockOffset, blockOffset + MANAGED_ORIGINAL_BLOCK_BYTES);
    if (createHash('sha256').update(block).digest('hex') !== file.blockSha256[index]) {
      managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件的实际范围块摘要已改变。');
    }
  }
  return bytes.subarray(offset - start, offset - start + length);
}
export function readManagedBytes(bindings: ResourceBindings | undefined, file: ManagedOriginalFile): Buffer {
  const bytes = syncRead(bindings, file, 0, file.byteLength);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件 SHA-256 摘要已改变。');
  return bytes;
}

/** Consumers may stage the yielded bytes; only normal generator exhaustion confirms the full digest. */
export async function* streamManagedOriginal(bindings: ResourceBindings | undefined, file: ManagedOriginalIdentity): AsyncGenerator<Buffer> {
  const path = verifyManagedPath(bindings, file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assertManagedIdentity(await handle.stat({ bigint: true }), file);
    const hash = createHash('sha256');
    for (let offset = 0; offset < file.byteLength;) {
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_BLOCK_BYTES, file.byteLength - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) managedOriginalError('MANAGED_ORIGINAL_CHANGED', '读取受管原件时遇到提前结束。');
      offset += bytesRead;
      const block = buffer.subarray(0, bytesRead);
      hash.update(block);
      yield block;
    }
    assertManagedIdentity(await handle.stat({ bigint: true }), file);
    verifyManagedPath(bindings, file);
    if (hash.digest('hex') !== file.sha256) managedOriginalError('MANAGED_ORIGINAL_CHANGED', '受管原件 SHA-256 摘要已改变。');
  } finally { await handle.close(); }
}

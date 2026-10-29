import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { root } from '@openclaw/fs-safe';
import type { FileReference } from './files.js';
import { CoreError } from '../runtime/errors.js';

export const FILE_TRANSFER_LIMIT = 25 * 1024 * 1024;

export async function readPinnedFile(owner: Awaited<ReturnType<typeof root>>, path: string, reference: FileReference, verify: () => void, maxBytes = FILE_TRANSFER_LIMIT): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 268_435_456) throw new CoreError('INVALID_LIMIT', '固定原件读取预算无效。', 400);
  if (reference.size > maxBytes) throw new CoreError('FILE_TOO_LARGE', '对象超过本次明确的固定读取预算；普通在线下载默认25MiB。', 413);
  const opened = await owner.open(path, { hardlinks: 'reject', symlinks: 'reject' });
  let contentVersion: string | undefined;
  const check = async () => {
    verify(); const stat = await opened.handle.stat({ bigint: true }); assertTransferIdentity(stat, reference);
    contentVersion ??= String(stat.ctimeNs);
    if (String(stat.ctimeNs) !== contentVersion) throw new CoreError('FILE_CHANGED', '读取期间文件内容版本已变化，未发送下载字节。');
  };
  try {
    await check();
    const output = Buffer.alloc(reference.size);
    let offset = 0;
    while (offset < output.length) {
      await check();
      const { bytesRead } = await opened.handle.read(output, offset, Math.min(64 * 1024, output.length - offset), offset);
      if (!bytesRead) throw new CoreError('FILE_CHANGED', '读取期间文件的字节长度发生变化。');
      offset += bytesRead;
    }
    const end = Buffer.alloc(1);
    if ((await opened.handle.read(end, 0, 1, offset)).bytesRead) throw new CoreError('FILE_CHANGED', '读取期间文件的字节长度发生变化。');
    await check();
    const expected = createHash('sha256').update(output).digest('hex'), digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
    offset = 0;
    while (offset < output.length) {
      await check();
      const { bytesRead } = await opened.handle.read(chunk, 0, Math.min(chunk.length, output.length - offset), offset);
      if (!bytesRead) throw new CoreError('FILE_CHANGED', '读取期间文件的字节长度发生变化。');
      digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    await check();
    if (digest.digest('hex') !== expected) throw new CoreError('FILE_CHANGED', '读取期间文件内容发生变化，未发送下载字节。');
    return output;
  } finally { await opened.handle.close(); }
}
function assertTransferIdentity(stat: BigIntStats, reference: FileReference): void {
  if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== reference.device || String(stat.ino) !== reference.inode
    || Number(stat.size) !== reference.size || String(stat.mtimeNs) !== reference.mtimeNs) throw new CoreError('FILE_CHANGED', '打开的文件对象或内容版本已变化，未发送下载字节。');
}


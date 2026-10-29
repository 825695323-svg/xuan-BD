import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { inspectPath, samePathIdentity } from '../../security/permissions.js';
import { DirectError } from '../../runtime/file-workspace.js';

/** 原生连接文件的有界身份核验；站点规则由采集源插件独立持有。 */
export async function readBrowserBoundFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = inspectPath(path);
  if (before.links.length || before.object?.kind !== 'file' || before.object.size > maxBytes) {
    throw new DirectError('BROWSER_FILE_UNVERIFIABLE', '浏览器绑定文件需要有界、无链接的普通文件。');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.nlink !== 1n || String(stat.dev) !== before.object.device || String(stat.ino) !== before.object.inode) {
      throw new DirectError('BROWSER_FILE_UNVERIFIABLE', '浏览器绑定文件身份无法核对。');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > maxBytes || !samePathIdentity(before, inspectPath(path), true)) {
      throw new DirectError('BROWSER_FILE_CHANGED', '浏览器绑定文件读取期间变化或超出预算。');
    }
    return bytes;
  } finally { await handle.close(); }
}

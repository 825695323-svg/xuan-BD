import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { root } from '@openclaw/fs-safe';
import { CoreError } from '../../platform/runtime/errors.js';
import { inspectPath, samePathIdentity } from '../../platform/security/permissions.js';
import type { ApplicationServices } from './services.js';
import { ATTACHMENT_UPLOAD_LIMIT } from '../../contracts/upload-limits.js';
export { ATTACHMENT_UPLOAD_LIMIT } from '../../contracts/upload-limits.js';

// 仅约束没有原路径时的上传回退；原路径引用和固定读取各自保留原有边界。
const uploadTooLarge = () => new CoreError('UPLOAD_TOO_LARGE', '原路径解析不可用时，上传最多 25 MiB（兆字节）；请通过本机选件重新接入或选择较小文件。', 413);
const uploadChanged = () => new CoreError('UPLOAD_CHANGED', '附件落盘后的大小、身份或字节摘要未能核对，请重新选择文件。');

/** 受管临时文件完整接收后原子发布，核对持久字节，再登记原有文件引用。 */
export async function registerUploadedAttachment(services: ApplicationServices, req: Request, res: Response) {
  try {
    if (!req.is('application/octet-stream')) throw new CoreError('INVALID_UPLOAD', '附件上传需要原始文件字节。', 400);
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CoreError('INVALID_UPLOAD', '附件不接受压缩的请求正文。', 400);
    const expectedLength = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
    if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0)) throw new CoreError('INVALID_UPLOAD', '附件传输长度无效。', 400);
    if (expectedLength !== undefined && expectedLength > ATTACHMENT_UPLOAD_LIMIT) throw uploadTooLarge();
    const { conversationId, name } = req.query;
    if (typeof conversationId !== 'string' || !conversationId || typeof name !== 'string' || !name.trim()) throw new CoreError('INVALID_UPLOAD', '请选择文件及其所属会话。', 400);
    services.core.getState(conversationId);
    if (name === '.' || name === '..' || name.length > 512 || name !== basename(name) || /[\\\u0000-\u001f\u007f]/u.test(name)) throw new CoreError('INVALID_FILE_NAME', '文件名无效。', 400);
    const suffix = extname(name).slice(0, 20).replace(/[^.a-zA-Z0-9_-]/g, '');
    const localName = `${randomUUID()}${suffix}`, path = join(services.attachmentRoot, localName);
    const controller = new AbortController(), stop = () => controller.abort();
    const assertCurrent = () => {
      if (controller.signal.aborted || req.aborted || res.destroyed) throw new CoreError('UPLOAD_ABORTED', '附件上传已取消，未确认加入文件引用。', 400);
      if (!services.core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '存储暂时不可用，附件未确认保存。', 503);
      // 此方法沿用宿主请求上下文，复核同一本地资料代次及受保护路径。
      services.direct.assertPublicPath(path, true);
    };
    req.once('aborted', stop); res.once('close', stop);
    try {
      assertCurrent();
      const owner = await root(services.attachmentRoot, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject' });
      const received = createHash('sha256');
      let size = 0;
      async function* chunks(): AsyncGenerator<Buffer> {
        // 生产者提前拒绝时保留响应连接，才能返回明确的超限错误。
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          assertCurrent();
          if (!Buffer.isBuffer(chunk)) throw new CoreError('INVALID_UPLOAD', '附件传输字节无效。', 400);
          size += chunk.length;
          if (size > ATTACHMENT_UPLOAD_LIMIT) throw uploadTooLarge();
          received.update(chunk);
          yield chunk;
        }
        assertCurrent();
        if (!req.complete || (expectedLength !== undefined && size !== expectedLength)) throw new CoreError('UPLOAD_INCOMPLETE', '附件传输未完成，未登记文件引用。', 400);
        if (!size) throw new CoreError('INVALID_UPLOAD', '请选择一个非空文件。', 400);
      }
      await owner.create(localName, chunks(), { private: true, mkdir: false, durable: 'file',
        maxBytes: ATTACHMENT_UPLOAD_LIMIT, signal: controller.signal, assertBeforeMutation: assertCurrent });
      assertCurrent();
      const published = inspectPath(path), object = published.object;
      if (object?.kind !== 'file' || object.size !== size) throw uploadChanged();
      const opened = await owner.open(localName, { hardlinks: 'reject', symlinks: 'reject' });
      try {
        let contentVersion: string | undefined;
        const check = async () => {
          assertCurrent();
          const stat = await opened.handle.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== object.device || String(stat.ino) !== object.inode
            || stat.size !== BigInt(size) || String(stat.mtimeNs) !== object.mtimeNs) throw uploadChanged();
          contentVersion ??= String(stat.ctimeNs);
          if (String(stat.ctimeNs) !== contentVersion) throw uploadChanged();
        };
        const stored = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < size) {
          await check();
          const { bytesRead } = await opened.handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (!bytesRead) throw uploadChanged();
          stored.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        await check();
        if (stored.digest('hex') !== received.digest('hex') || !samePathIdentity(published, inspectPath(path), true)) throw uploadChanged();
        assertCurrent();
        return services.files.register({ path, source: 'user-attached', displayName: name, conversationId });
      } finally { await opened.handle.close(); }
    } finally { req.off('aborted', stop); res.off('close', stop); }
  } catch (error) {
    if (!req.complete && !req.destroyed) { res.setHeader('Connection', 'close'); req.resume(); }
    // 已发布后的失败保留完成文件，不按路径盲删；未发布临时文件由安全写入器核身份清理。
    throw error;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { root } from '@openclaw/fs-safe';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { readPinnedFile } from '../../platform/resources/pinned-read.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';

export const MATERIAL_UPLOAD_LIMIT = 25 * 1024 * 1024;
export const MATERIAL_CUSTODY_LIMIT = 256 * 1024 * 1024;
type UploadRow = { request_id: string; args_digest: string; local_name: string; file_ref_id: string | null; task_id: string | null };
const pendingUploads = new WeakMap<WorkspaceServices, Map<string, Promise<string>>>();
/** Same durable intake for the manual HTTP entry and the trusted conversation bridge. */
export async function acceptWorkspaceMaterial(services: WorkspaceServices,
  input: { bytes: Buffer; name: string; category: 'unclassified' | 'data' | 'tool'; requestId: string }): Promise<string> {
  const { bd, materials, database, tasks, files, permissions } = services;
  if (!bd || !materials) throw new TaskError('SERVICE_ROLE_REQUIRED', '材料服务尚未装配。');
  const { bytes, name, category, requestId } = input;
  id(requestId);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MATERIAL_CUSTODY_LIMIT) throw new TaskError('MATERIAL_BYTE_BUDGET', '材料超过字节预算或为空。');
  if (!name.trim() || name.length > 512 || name !== basename(name) || ['.', '..'].includes(name) || /[\\\u0000-\u001f\u007f]/u.test(name)) throw new TaskError('INVALID_FILE_NAME', '文件名无效。');
  if (category !== 'unclassified' && category !== 'data' && category !== 'tool') throw new TaskError('INVALID_CATEGORY', '材料接收类别无效。');
  const db = database.connection;
  database.migrate('harness_material_uploads', 1, `CREATE TABLE harness_material_uploads (
    request_id TEXT PRIMARY KEY, args_digest TEXT NOT NULL, local_name TEXT NOT NULL UNIQUE,
    file_ref_id TEXT, task_id TEXT, created_at INTEGER NOT NULL);`);
  let pending = pendingUploads.get(services);
  if (!pending) { pending = new Map(); pendingUploads.set(services, pending); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const digest = digestOperationArgs({ category, name, sha256 });
    let row = db.prepare('SELECT * FROM harness_material_uploads WHERE request_id=?').get(requestId) as UploadRow | undefined;
    if (row && row.args_digest !== digest) throw new TaskError('REQUEST_CONFLICT', '原请求已绑定另一份原件或类别；请核对原请求。');
    if (row?.task_id) return row.task_id;
    bd.assertDispatch();
    if (!row) {
      const suffix = extname(name).slice(0, 20).replace(/[^.a-zA-Z0-9_-]/g, '');
      db.prepare('INSERT INTO harness_material_uploads VALUES(?,?,?,?,?,?)').run(requestId, digest, `${randomUUID()}${suffix}`, null, null, Date.now());
      row = db.prepare('SELECT * FROM harness_material_uploads WHERE request_id=?').get(requestId) as UploadRow;
    }
    const upload = row;
    const accept = async (): Promise<string> => {
      const generation = tasks.getControl().generation;
      const check = () => {
        if (!services.core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '存储暂时不可用，原件尚未确认接收。', 503);
        bd.assertDispatch();
        if (tasks.getControl().generation !== generation) throw new TaskError('STALE_CONTROL', '上传期间停止控制已变化；请按原请求核对。');
      };
      check();
      const owner = await root(services.attachmentRoot, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject' });
      const path = join(services.attachmentRoot, upload.local_name);
      let exists = false;
      try { await lstat(path); exists = true; } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      // 崩溃后保留同一原件路径；恢复只核对已发布字节，不覆盖未知文件。
      if (!exists) await owner.create(upload.local_name, bytes, { atomic: true, private: true, durable: 'file', assertBeforeMutation: check });
      check();
      const reference = upload.file_ref_id ? files.getRef(upload.file_ref_id) : files.register({ path, source: 'user-attached', displayName: name });
      if (!upload.file_ref_id) db.prepare('UPDATE harness_material_uploads SET file_ref_id=? WHERE request_id=?').run(reference.id, requestId);
      const stored = await readPinnedFile(owner, upload.local_name, reference, () => { check(); files.verify(reference.id); }, MATERIAL_CUSTODY_LIMIT);
      if (!stored.equals(bytes)) throw new TaskError('UPLOAD_CHANGED', '已保存原件与此请求字节不符，须核对原请求。');
      check();
      const label = `手工原件:${requestId}`;
      if (!permissions.listGrants({ includeRevoked: true }).some(g => g.label === label)) permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }], label, scope: { kind: 'persistent' } });
      const task = materials.submit({ fileRefId: reference.id, category, expectedSha256: sha256 }, requestId);
      db.prepare('UPDATE harness_material_uploads SET task_id=? WHERE request_id=?').run(task.id, requestId);
      return task.id;
    };
    let promise = pending.get(requestId);
    if (!promise) { promise = accept(); pending.set(requestId, promise); void promise.finally(() => pending.delete(requestId)).catch(() => {}); }
    return await promise;

}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TaskError('INVALID_REQUEST_ID', '需要稳定的原请求编号。');
  return value;
}

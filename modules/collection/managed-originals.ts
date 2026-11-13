import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, statfsSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResourceBindings, ResourceReference } from '../../platform/resources/bindings.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { MaterialCategory, MaterialDeclaration } from './materials/contracts.js';
import type { MaterialService } from './materials/service.js';
import { assertManagedIdentity, MANAGED_ORIGINAL_BLOCK_BYTES, MANAGED_ORIGINAL_MAX_BYTES, managedOriginalError as fail, managedPath, managedPathStat,
  readManagedRange, statIdentity, streamManagedOriginal, verifyManagedPath, type ManagedOriginalFile, type ManagedOriginalIdentity } from './managed-original-file.js';

const CHUNK_BYTES = MANAGED_ORIGINAL_BLOCK_BYTES;
const MAX_CHUNKS = 4096;
const WITNESS_BYTES = 16;
const SCHEMA = `
CREATE TABLE managed_original_receipts (
 intake_id TEXT PRIMARY KEY, material_id TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, byte_length INTEGER NOT NULL,
 sha256 TEXT NOT NULL, root TEXT NOT NULL, root_identity TEXT NOT NULL, witness BLOB NOT NULL,
 device TEXT, inode TEXT, committed_offset INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, sealed_json TEXT
);
CREATE TABLE managed_original_chunks (
 intake_id TEXT NOT NULL REFERENCES managed_original_receipts(intake_id), byte_offset INTEGER NOT NULL,
 byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(intake_id,byte_offset)
);`;
interface Receipt {
  intake_id: string; material_id: string; filename: string; byte_length: number; sha256: string;
  root: string; root_identity: string; witness: Uint8Array; device: string | null; inode: string | null;
  committed_offset: number; chunk_count: number; sealed_json: string | null;
}
export interface ManagedOriginalStatus {
  intakeId: string; materialId: string; filename: string; byteLength: number; sha256: string;
  committedOffset: number; state: 'receiving' | 'sealed';
}
export interface ManagedOriginalStoreOptions {
  database: CoreDatabase;
  bindings: ResourceBindings;
  ownedRoot: string;
  materials: MaterialService;
  assertGrowth?: (externalPath: string, additionalBytes: number) => void;
}
export class ManagedOriginalStore {
  constructor(private readonly options: ManagedOriginalStoreOptions) {
    this.root();
    options.database.migrate('managed-original-receipts', 1, SCHEMA);
  }
  private get db() { return this.options.database.connection; }
  private root() {
    const { bindings, ownedRoot } = this.options;
    const binding = bindings.document.resources[ownedRoot];
    if (!binding?.owned || binding.kind !== 'directory' || !binding.identity) {
      return fail('MANAGED_ORIGINAL_UNAVAILABLE', '批量原件需要明确绑定的独立受管目录。');
    }
    return binding.identity;
  }
  private receipt(intakeId: string) {
    const record = this.db.prepare('SELECT * FROM managed_original_receipts WHERE intake_id=?').get(intakeId) as unknown as Receipt | undefined;
    if (!record) return fail('MANAGED_ORIGINAL_NOT_FOUND', '没有找到此批量原件接收身份。');
    if (record.root !== this.options.ownedRoot || record.root_identity !== this.root()) {
      return fail('MANAGED_ORIGINAL_UNAVAILABLE', '批量原件固定的接收目录绑定已变化。');
    }
    return record;
  }
  private reference(record: Receipt): ResourceReference {
    return { root: record.root, identity: record.root_identity, relative: `bd-bulk-${record.material_id}.original` };
  }
  private path(record: Receipt) { return managedPath(this.options.bindings, this.reference(record)); }
  private growth(path: string, bytes: number) {
    const disk = statfsSync(dirname(path), { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(bytes)) fail('MANAGED_ORIGINAL_DISK_BUDGET', '受管盘空间不足；保留原编号和已提交接收边界。');
    this.options.assertGrowth?.(path, bytes);
  }
  private verifyPendingIdentity(record: Receipt, path: string, fd?: number) {
    const verify = (stat: ReturnType<typeof managedPathStat>) => {
      const identity = statIdentity(stat);
      if (identity.device !== record.device || identity.inode !== record.inode || identity.byteLength < record.committed_offset) {
        fail('MANAGED_ORIGINAL_CHANGED', '接收文件身份已改变，或原件短于持久确认边界。');
      }
      return identity;
    };
    const actual = verify(managedPathStat(path));
    if (fd !== undefined) verify(fstatSync(fd, { bigint: true }));
    return actual;
  }
  private assertBindingAt(record: Receipt, path: string) {
    if (this.path(record) !== path) fail('MANAGED_ORIGINAL_UNAVAILABLE', '受管目录位置在操作中改变。');
  }
  private view(record: Receipt): ManagedOriginalStatus {
    return { intakeId: record.intake_id, materialId: record.material_id, filename: record.filename, byteLength: record.byte_length,
      sha256: record.sha256, committedOffset: record.committed_offset, state: record.sealed_json ? 'sealed' : 'receiving' };
  }
  private sealed(record: Receipt): ManagedOriginalFile {
    if (!record.sealed_json) return fail('MANAGED_ORIGINAL_NOT_SEALED', '批量原件尚未完成整件摘要验证。');
    const value = JSON.parse(record.sealed_json) as ManagedOriginalFile;
    const reference = this.reference(record);
    if (value.sha256 !== record.sha256 || value.byteLength !== record.byte_length || record.committed_offset !== record.byte_length
      || value.device !== record.device || value.inode !== record.inode || value.resource.root !== reference.root
      || value.resource.identity !== reference.identity || value.resource.relative !== reference.relative
      || !Array.isArray(value.blockSha256) || value.blockSha256.length !== Math.ceil(value.byteLength / MANAGED_ORIGINAL_BLOCK_BYTES)
      || value.blockSha256.some(hash => !/^[a-f0-9]{64}$/u.test(hash))) {
      fail('MANAGED_ORIGINAL_CHANGED', '受管整件与冻结接收记录不符。');
    }
    return value;
  }

  start(input: { intakeId: string; filename: string; byteLength: number; sha256: string }): ManagedOriginalStatus {
    if (typeof input.intakeId !== 'string' || typeof input.sha256 !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/u.test(input.intakeId) || typeof input.filename !== 'string' || !input.filename.trim()
      || input.filename.length > 512 || /[\u0000-\u001f\u007f]/u.test(input.filename) || !/^[a-f0-9]{64}$/u.test(input.sha256)
      || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MANAGED_ORIGINAL_MAX_BYTES) {
      fail('MANAGED_ORIGINAL_INPUT', '批量原件需冻结接收号、名称、小写 SHA-256 与不超过 256 MiB 的非空长度。');
    }
    const { database, ownedRoot } = this.options;
    database.transaction(() => {
      this.db.prepare(`INSERT INTO managed_original_receipts (intake_id,material_id,filename,byte_length,sha256,root,root_identity,witness)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(intake_id) DO NOTHING`)
        .run(input.intakeId, randomUUID(), input.filename, input.byteLength, input.sha256, ownedRoot, this.root(), randomBytes(WITNESS_BYTES));
      const record = this.receipt(input.intakeId);
      if (record.filename !== input.filename || record.byte_length !== input.byteLength || record.sha256 !== input.sha256) {
        fail('MANAGED_ORIGINAL_CONFLICT', '同一批量接收号不能绑定不同原件。');
      }
    });
    return database.transaction(() => {
      const record = this.receipt(input.intakeId);
      if (record.inode !== null) return this.status(input.intakeId);
      const path = this.path(record);
      this.growth(path, Math.max(WITNESS_BYTES, record.byte_length));
      this.assertBindingAt(record, path);
      let fd: number;
      let created = true;
      try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600); }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        created = false;
        fd = openSync(path, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDWR);
      }
      try {
        const stat = fstatSync(fd, { bigint: true }), identity = statIdentity(stat);
        const observed = statIdentity(managedPathStat(path));
        this.assertBindingAt(record, path);
        if ((stat.mode & 0o077n) !== 0n || observed.device !== identity.device || observed.inode !== identity.inode
          || identity.byteLength !== (created ? 0 : WITNESS_BYTES)) {
          fail('MANAGED_ORIGINAL_CHANGED', '尚未登记接收文件与预期的私有初始文件不符。');
        }
        // ExFAT assigns a stable inode only after syncing its first data cluster.
        // The private receipt witness also proves ownership if the inode checkpoint was interrupted.
        const witness = Buffer.alloc(WITNESS_BYTES);
        if (created ? writeSync(fd, record.witness, 0, WITNESS_BYTES, 0) !== WITNESS_BYTES
          : readSync(fd, witness, 0, WITNESS_BYTES, 0) !== WITNESS_BYTES || !witness.equals(record.witness)) {
          fail('MANAGED_ORIGINAL_CHANGED', '接收文件的持久身份凭据不符。');
        }
        fsyncSync(fd);
        this.syncDirectory(record, path);
        const stable = statIdentity(fstatSync(fd, { bigint: true }));
        const current = statIdentity(managedPathStat(path));
        if (stable.byteLength !== WITNESS_BYTES || current.device !== stable.device || current.inode !== stable.inode) {
          fail('MANAGED_ORIGINAL_CHANGED', '初始受管接收文件身份未稳定。');
        }
        this.db.prepare('UPDATE managed_original_receipts SET device=?,inode=? WHERE intake_id=?')
          .run(stable.device, stable.inode, input.intakeId);
      } finally { closeSync(fd); }
      return this.view(record);
    });
  }

  status(intakeId: string): ManagedOriginalStatus {
    const record = this.receipt(intakeId);
    if (record.sealed_json) verifyManagedPath(this.options.bindings, this.sealed(record));
    else if (record.inode !== null) {
      this.verifyPendingIdentity(record, this.path(record));
    }
    return this.view(record);
  }

  upload(intakeId: string, input: { offset: number; bytes: Uint8Array; sha256: string }): ManagedOriginalStatus {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length < 1 || input.bytes.length > CHUNK_BYTES
      || !Number.isSafeInteger(input.offset) || input.offset < 0 || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256) {
      fail('MANAGED_ORIGINAL_CHUNK', '接收分块须提供连续偏移、匹配摘要及不超过 2 MiB 的非空字节。');
    }
    return this.options.database.transaction(() => {
      const record = this.receipt(intakeId);
      if (record.inode === null) fail('MANAGED_ORIGINAL_NOT_STARTED', '请按同一编号完成接收初始化。');
      const { offset, bytes, sha256 } = input;
      if (offset + bytes.length > record.byte_length) fail('MANAGED_ORIGINAL_CHUNK', '分块越过冻结原件长度。');
      const previous = this.db.prepare('SELECT byte_length,sha256 FROM managed_original_chunks WHERE intake_id=? AND byte_offset=?').get(intakeId, offset);
      if (previous && (previous.sha256 !== sha256 || previous.byte_length !== bytes.length)) {
        fail('MANAGED_ORIGINAL_CHUNK_CONFLICT', '同一已确认偏移不能接收不同的字节。');
      }
      if (!previous && (record.sealed_json || offset !== record.committed_offset)) {
        fail('MANAGED_ORIGINAL_CHUNK_ORDER', '请从已确认边界继续，不接受缺口或交叠。');
      }
      if (record.sealed_json) {
        if (!readManagedRange(this.options.bindings, this.sealed(record), offset, bytes.length).equals(bytes)) {
          fail('MANAGED_ORIGINAL_CHANGED', '已固化分块字节与冻结接收记录不符。');
        }
        return this.view(record);
      }
      const path = this.path(record);
      this.verifyPendingIdentity(record, path);
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        this.assertBindingAt(record, path);
        const actual = this.verifyPendingIdentity(record, path, fd);
        const retainedLength = Math.max(1, record.committed_offset);
        if (actual.byteLength > retainedLength) {
          ftruncateSync(fd, retainedLength);
          fsyncSync(fd);
        }
        if (previous) {
          const saved = Buffer.alloc(bytes.length);
          let n = 0;
          while (n < saved.length) {
            const read = readSync(fd, saved, n, saved.length - n, offset + n);
            if (!read) fail('MANAGED_ORIGINAL_CHANGED', '已确认分块实际字节不足。');
            n += read;
          }
          if (!saved.equals(bytes)) fail('MANAGED_ORIGINAL_CHANGED', '已确认分块实际字节已改变。');
        } else {
          if (record.chunk_count + 1 + Math.ceil((record.byte_length - offset - bytes.length) / CHUNK_BYTES) > MAX_CHUNKS) {
            fail('MANAGED_ORIGINAL_CHUNK_BUDGET', '单件最多接收 4096 个分块，请使用较大的分块继续。');
          }
          this.growth(path, bytes.length);
          this.assertBindingAt(record, path);
          this.verifyPendingIdentity(record, path, fd);
          let n = 0;
          while (n < bytes.length) {
            const written = writeSync(fd, bytes, n, bytes.length - n, offset + n);
            if (!written) fail('MANAGED_ORIGINAL_UNAVAILABLE', '受管原件分块写入未完成。');
            n += written;
          }
          fsyncSync(fd);
          this.assertBindingAt(record, path);
          const committedOffset = offset + bytes.length;
          const written = this.verifyPendingIdentity(record, path, fd);
          if (written.byteLength !== committedOffset) fail('MANAGED_ORIGINAL_CHANGED', '分块写入长度与预期边界不符。');
          this.db.prepare('INSERT INTO managed_original_chunks VALUES(?,?,?,?)').run(intakeId, offset, bytes.length, sha256);
          this.db.prepare('UPDATE managed_original_receipts SET committed_offset=?,chunk_count=chunk_count+1 WHERE intake_id=?').run(committedOffset, intakeId);
          return this.view({ ...record, committed_offset: committedOffset });
        }
        this.assertBindingAt(record, path);
        this.verifyPendingIdentity(record, path, fd);
        return this.view(record);
      } finally { closeSync(fd); }
    });
  }

  async seal(intakeId: string, assertCurrent: () => void = () => {}): Promise<ManagedOriginalStatus> {
    assertCurrent();
    const initial = this.receipt(intakeId);
    if (initial.sealed_json) return this.status(intakeId);
    if (initial.committed_offset !== initial.byte_length) fail('MANAGED_ORIGINAL_INCOMPLETE', '原件仍有分块未确认，不能固化。');
    const path = this.path(initial);
    let observed = this.verifyPendingIdentity(initial, path);
    if (observed.byteLength > initial.byte_length) {
      this.options.database.transaction(() => {
        const record = this.receipt(intakeId);
        if (record.sealed_json) return;
        const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          this.verifyPendingIdentity(record, path, fd);
          this.assertBindingAt(record, path);
          ftruncateSync(fd, record.byte_length);
          fsyncSync(fd);
          observed = this.verifyPendingIdentity(record, path, fd);
        } finally { closeSync(fd); }
      });
    }
    if (observed.byteLength !== initial.byte_length) fail('MANAGED_ORIGINAL_CHANGED', '受管原件实际长度不符。');
    const candidate: ManagedOriginalIdentity = { ...observed, version: 1, resource: this.reference(initial), sha256: initial.sha256 };
    const blockSha256: string[] = [];
    let blockHash = createHash('sha256'), blockBytes = 0;
    for await (const chunk of streamManagedOriginal(this.options.bindings, candidate)) {
      assertCurrent();
      for (let offset = 0; offset < chunk.length;) {
        const length = Math.min(chunk.length - offset, MANAGED_ORIGINAL_BLOCK_BYTES - blockBytes);
        blockHash.update(chunk.subarray(offset, offset + length));
        offset += length;
        blockBytes += length;
        if (blockBytes === MANAGED_ORIGINAL_BLOCK_BYTES) {
          blockSha256.push(blockHash.digest('hex'));
          blockHash = createHash('sha256');
          blockBytes = 0;
        }
      }
    }
    if (blockBytes) blockSha256.push(blockHash.digest('hex'));
    const sealed: ManagedOriginalFile = { ...candidate, blockSha256 };
    assertCurrent();
    return this.options.database.transaction(() => {
      const record = this.receipt(intakeId);
      if (record.sealed_json) return this.status(intakeId);
      const fd = openSync(verifyManagedPath(this.options.bindings, sealed), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        assertManagedIdentity(fstatSync(fd, { bigint: true }), sealed);
        fsyncSync(fd);
        this.syncDirectory(record, path);
        assertManagedIdentity(fstatSync(fd, { bigint: true }), sealed);
        verifyManagedPath(this.options.bindings, sealed);
        const sealedJson = JSON.stringify(sealed);
        const changed = this.db.prepare(`UPDATE managed_original_receipts SET sealed_json=?
          WHERE intake_id=? AND sealed_json IS NULL AND committed_offset=byte_length AND device=? AND inode=?`)
          .run(sealedJson, intakeId, sealed.device, sealed.inode);
        if (changed.changes !== 1) fail('MANAGED_ORIGINAL_CHANGED', '固化前接收记录已变化。');
        return this.view({ ...record, sealed_json: sealedJson });
      } finally { closeSync(fd); }
    });
  }

  private syncDirectory(record: Receipt, path: string): void {
    this.assertBindingAt(record, path);
    const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const binding = this.options.bindings.document.resources[record.root];
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isDirectory() || String(stat.dev) !== binding?.device || String(stat.ino) !== binding.inode) {
        fail('MANAGED_ORIGINAL_UNAVAILABLE', '无法同步原件所在的已登记受管目录。');
      }
      fsyncSync(fd);
      this.assertBindingAt(record, path);
    } finally { closeSync(fd); }
  }

  adoptMaterial(intakeId: string, input: { requestId: string; parentTaskId?: string; category?: MaterialCategory; mediaType?: string; declaredMetadata?: MaterialDeclaration[] }) {
    const record = this.receipt(intakeId);
    return this.options.materials.submitManaged({ ...input, materialId: record.material_id, filename: record.filename, file: this.sealed(record) });
  }

  readStream(intakeId: string): AsyncGenerator<Buffer> {
    return streamManagedOriginal(this.options.bindings, this.sealed(this.receipt(intakeId)));
  }
  readRange(intakeId: string, offset: number, length: number): Buffer {
    return readManagedRange(this.options.bindings, this.sealed(this.receipt(intakeId)), offset, length);
  }
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { MaterialService } from './materials/service.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';

export interface ObjectRef { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };

/** 现行加工与 R1 共用的内容仓储；对象身份、原字节与现有布局保持一致。 */
export class CandidateService {
  constructor(private readonly options: { database: CoreDatabase; materials: MaterialService }) {
    options.database.migrate('generic_candidates', 1,
      'CREATE TABLE candidate_objects(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,bytes BLOB NOT NULL);');
  }
  private get db() { return this.options.database.connection; }
  private reference(bytes: Uint8Array, mediaType: string): ObjectRef { return { kind: 'stored-object', sha256: wfdSha256(bytes), byte_length: bytes.byteLength, media_type: mediaType }; }
  saveObject(bytes: Buffer, mediaType: string) {
    const ref = this.reference(bytes, mediaType);
    this.db.prepare('INSERT OR IGNORE INTO candidate_objects VALUES(?,?,?)').run(ref.sha256, ref.byte_length, bytes); return ref;
  }
  objectBytes(ref: ObjectRef): Buffer {
    const row = this.db.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?').get(ref.sha256);
    let bytes: Buffer | undefined = row?.bytes instanceof Uint8Array ? Buffer.from(row.bytes) : undefined;
    if (!bytes) {
      const record = this.db.prepare("SELECT material_id FROM material_objects WHERE json_extract(envelope_json,'$.sha256')=? LIMIT 1").get(ref.sha256);
      if (record) bytes = this.options.materials.readOriginal(String(record.material_id)).bytes;
    }
    if (!bytes || bytes.byteLength !== ref.byte_length || wfdSha256(bytes) !== ref.sha256) return fail('CANDIDATE_OBJECT_CHANGED', '冻结对象字节、大小或摘要不符。');
    return bytes;
  }
  verifyObject(ref: ObjectRef): boolean { const row = this.db.prepare('SELECT byte_length FROM candidate_objects WHERE sha256=?').get(ref.sha256); return !!row && Number(row.byte_length) === ref.byte_length; }
}

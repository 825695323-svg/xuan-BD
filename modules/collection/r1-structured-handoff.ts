import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CoreDatabase } from '../../platform/state/database.js';
import { WfdProductMachineClient, WfdProductMachineError, type WfdProductMachineReply, type WfdProductMachineReadPageOptions } from '../../adapters/database/wfd-product-machine.js';
import { R1PagedReadback, R1_READ_PAGE_FORMAT, acceptedR1ReceiptRows } from './r1-paged-readback.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1RowResult, R1RowSummary } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import Schema from 'typebox/schema';
import { frozenR1RowMatches, parseR1Utc, readR1ContractBinding, type R1ContractBinding } from './r1-tabular.js';
import { r1SourceDenied, r1SourceGaps, validR1Authorization, type R1SourceAuthorization } from './r1-source.js';
import { PURPOSE_ELIGIBILITY_RULE_VERSION, evaluatePurposeEligibility, type PurposeEligibilityInput, type EligibilityHistoryMode, type EligibilityPurpose, type RestrictionEvidence } from './purpose-eligibility.js';
export { parseR1Utc } from './r1-tabular.js';

/**
 * R1 BD 外部信息 ↔ WFD 稳定结构化记录关联。
 *
 * BD 保存原件、来源、证据和加工记录；WFD 只接收 data-only 结构化文档并返回
 * 每行 record_id/record_version。本模块不接受 caller 自造 WFD ID，不用 snapshot_id
 * 代替记录身份；没有实际逐行身份时只保存 pending attempt，不插 association。
 */
export const R1_PROTOCOL = 'wfd.structured-ingest/1.0';
export const R1_ASSOCIATION_VERSION = 'bd.r1-association/1';

export interface R1SourceRef {
  source_id: string;
  provider: string;
  requested_url: string;
  requested_at_utc: string;
  acquired_at_utc: string;
  sha256: string;
  bytes: number;
  /** Legacy BD source text only; it does not determine R1 admission. */
  license?: string;
  usage_scope: string;
  authorization?: R1SourceAuthorization;
}
export interface R1ProcessRef {
  process_id: string;
  plan_id?: string;
  output_id?: string;
  version: string;
  input_sha256: string;
  output_sha256: string;
  evidence_sha256: string;
  document_sha256?: string;
}
export interface R1EvidenceRef { ref_id: string; content_sha256: string; kind: string }
export interface R1LocalReferences {
  originalIds: string[];
  materialIds: string[];
  sourceRefs: R1SourceRef[];
  processRefs: R1ProcessRef[];
  evidenceRefs: R1EvidenceRef[];
  /** New workspace preparations pin four role refs; old scalar task JSON stays unchanged. */
  contractBindingRequired?: true;
  /** 固定算法独立核验引用：没有五步加工计划；由服务端按原任务计算结果反向核验。 */
  fixedAlgorithm?: { kind?: 'structured_polars'; taskId: string; requestId: string; resultSha256: string;
    namespace: string; mode: 'production' | 'user_test'; expectedParentSnapshotId: string | null };
}
export interface R1StructuredRequest {
  datasetId: string;
  namespace: string;
  producerNamespace: string;
  requestId: string;
  submissionDigest: string;
  expectedParentSnapshotId: string | null;
  outputKey: string;
  subject: WfdRecord;
  definition: WfdRecord;
  inputMode: string;
  coverage: WfdRecord;
  payload: WfdRecord;
  /** 原因化精确前驱修订：键必须与本输出全部业务键一致，四元组来自真实固定读回。 */
  revisions?: WfdRecord;
  /** 修订须复用原定义身份；不换语义码、单位或频率身份。 */
  definitionMode?: 'create' | 'reuse';
  definitionRef?: WfdRecord | null;
  consistencyGroups?: WfdRecord;
  duplicatePolicy?: 'skip_identical_append';
}
export interface R1CalculationCandidateVerification {
  taskId: string; materialId: string; planId: string; outputId: string;
  definition: WfdRecord; payload: WfdRecord;
}
export interface R1ReceiptRow {
  business_key: string;
  record_id: string;
  record_version: string;
}
export interface R1Receipt extends Partial<R1ContractBinding> {
  dataset_id: string;
  output_key: string;
  product_id: string;
  definition_digest: string;
  snapshot_id: string;
  request_identity: WfdRecord;
  rows: R1ReceiptRow[];
  row_results?: R1RowResult[];
  row_summary?: R1RowSummary;
  wfd_state?: string;
  new_snapshot_created?: boolean;
  conflicts?: WfdRecord[];

}
export interface R1PrepareResult {
  requestId: string;
  state: string;
  document: WfdRecord;
  documentSha256: string;
  localRefsSha256: string;
}
export interface R1ProfileProbe {
  supported: boolean;
  reason: string | null;
  serviceVersion: string | null;
  advertised: WfdRecord;
}

const SCHEMA = `
CREATE TABLE r1_originals (
 original_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
 media_type TEXT NOT NULL, source_json TEXT NOT NULL, source_digest TEXT NOT NULL,
 original_bytes BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE r1_handoff_attempts (
 request_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, actor_namespace TEXT NOT NULL,
 document_json TEXT NOT NULL, document_sha256 TEXT NOT NULL,
 local_refs_json TEXT NOT NULL, local_refs_sha256 TEXT NOT NULL,
 state TEXT NOT NULL, receipt_json TEXT, pending_count INTEGER NOT NULL DEFAULT 0,
 error_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE r1_record_associations (
 dataset_id TEXT NOT NULL, product_id TEXT NOT NULL, definition_digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL,
 request_id TEXT NOT NULL, original_id TEXT NOT NULL, source_id TEXT NOT NULL,
 process_refs_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(dataset_id, product_id, record_id, record_version)
);
CREATE INDEX r1_assoc_request ON r1_record_associations(request_id);
`;

// v2 keeps every historical original_id/source/timestamp while sharing only the content object.
// Runs in CoreDatabase.migrate's single transaction; no existing runtime is migrated by the build.
const ORIGINAL_ACQUISITIONS_V2 = `
CREATE TABLE IF NOT EXISTS r1_original_contents (
 sha256 TEXT PRIMARY KEY, original_bytes BLOB NOT NULL
);
INSERT INTO r1_original_contents SELECT sha256,original_bytes FROM r1_originals WHERE true
 ON CONFLICT(sha256) DO UPDATE SET original_bytes=CASE
 WHEN r1_original_contents.original_bytes=excluded.original_bytes THEN r1_original_contents.original_bytes ELSE NULL END;
ALTER TABLE r1_originals RENAME TO r1_originals_v1;
CREATE TABLE r1_originals (
 original_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL REFERENCES r1_original_contents(sha256),
 original_name TEXT NOT NULL, media_type TEXT NOT NULL, source_json TEXT NOT NULL,
 source_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(sha256,source_digest,original_name,media_type)
);
INSERT INTO r1_originals SELECT original_id,sha256,original_name,media_type,source_json,source_digest,created_at FROM r1_originals_v1;
DROP TABLE r1_originals_v1;
`;

const ASSOCIATIONS_V3 = `CREATE TABLE r1_record_associations_v3 (
 dataset_id TEXT NOT NULL, product_id TEXT NOT NULL, definition_digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL,
 request_id TEXT NOT NULL, original_id TEXT NOT NULL, source_id TEXT NOT NULL,
 process_refs_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(dataset_id,product_id,record_id,record_version,request_id,original_id)
);`;
export const R1_SETTLED_STATES = new Set(['associated', 'partially_associated', 'conflicts_pending']);

export class R1HandoffService {
  private readonly readback: R1PagedReadback;
  constructor(private readonly options: { database: CoreDatabase; materials?: {
    get(id: string): { envelope: { sha256: string; filename: string; mediaType: string } };
    readOriginal(id: string): { bytes: Buffer; sha256: string };
  }; processing?: { get(planId: string): unknown; outputArtifact(planId: string, outputId: string): { bytes: Buffer } };
    candidates?: { verifyObject(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): boolean;
      objectBytes(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): Buffer };
    verifyCalculationCandidate?(input: R1CalculationCandidateVerification): void;
    /** 外部副作用前重新读取 WFD 固定记录；仅宿主已装配的 Polars 来源核验器可执行。 */
    verifyCalculationCandidateRemote?(taskId: string, signal: AbortSignal): Promise<void>;
    verifyFixedDerivedRemote?(taskId: string, signal: AbortSignal): Promise<void>;
    verifyAlgorithmCandidate?(input: R1CalculationCandidateVerification): void;
    verifyFixedDerived?(refs: R1LocalReferences, documentSha256: string): void }) {
    const version = this.db.prepare('SELECT version FROM schema_versions WHERE module=?').get('r1-structured-handoff');
    if (version && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='r1_record_associations'").get())
      fail('R1_ASSOCIATIONS_MISSING', '已有 R1 格式缺少原关联表，未迁移原件或重建空关联表。');
    if (!version) options.database.migrate('r1-structured-handoff', 1, SCHEMA);
    if (!version || Number(version.version) < 2) options.database.migrate('r1-structured-handoff', 2, ORIGINAL_ACQUISITIONS_V2);
    options.database.migrate('r1-structured-handoff', 3, ASSOCIATIONS_V3 +
      `INSERT INTO r1_record_associations_v3 SELECT * FROM r1_record_associations; DROP TABLE r1_record_associations;` + `ALTER TABLE r1_record_associations_v3 RENAME TO r1_record_associations;
      CREATE INDEX r1_assoc_request ON r1_record_associations(request_id);`);
    this.readback = new R1PagedReadback(options.database);
  }
  private get db() { return this.options.database.connection; }

  registerOriginal(input: { bytes: Uint8Array; originalName: string; mediaType?: string; source: R1SourceRef }): { originalId: string; sha256: string } {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) fail('R1_ORIGINAL_EMPTY', 'BD 原件必须是非空字节。');
    const digest = wfdSha256(input.bytes);
    validateSourceRef(input.source);
    if (digest !== input.source.sha256) fail('R1_SOURCE_SHA_MISMATCH', 'BD 原件摘要与来源声明不同，禁止写入关联。');
    if (input.bytes.byteLength !== input.source.bytes) fail('R1_SOURCE_BYTES_MISMATCH', '原件字节数与来源声明不同。');
    if (typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.length > 512) fail('R1_ORIGINAL_NAME', '原件需要有界的原始名称。');
    const mediaType = input.mediaType ?? 'application/octet-stream';
    if (typeof mediaType !== 'string' || !mediaType.trim() || mediaType.length > 256) fail('R1_ORIGINAL_MEDIA_TYPE', '原件媒体类型无效。');
    const sourceJson = canonicalWfdJson(input.source), sourceDigest = wfdSha256(sourceJson);
    return this.options.database.transaction(() => {
      const existing = this.db.prepare(`SELECT original_id FROM r1_originals
        WHERE sha256=? AND source_digest=? AND original_name=? AND media_type=?`).get(digest, sourceDigest, input.originalName, mediaType) as { original_id: string } | undefined;
      this.db.prepare('INSERT INTO r1_original_contents(sha256,original_bytes) VALUES(?,?) ON CONFLICT(sha256) DO NOTHING').run(digest, input.bytes);
      const content = this.db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(digest);
      if (!(content?.original_bytes instanceof Uint8Array) || !Buffer.from(content.original_bytes).equals(input.bytes)
        || wfdSha256(content.original_bytes) !== digest) fail('R1_ORIGINAL_CHANGED', '已保存的内容对象字节或摘要不符。');
      if (existing) return { originalId: String(existing.original_id), sha256: digest };
      const originalId = 'bd-original:' + randomUUID();
      this.db.prepare('INSERT INTO r1_originals VALUES(?,?,?,?,?,?,?)').run(
        originalId, digest, input.originalName, mediaType, sourceJson, sourceDigest, Date.now());
      return { originalId, sha256: digest };
    });
  }

  prepare(input: { structured: R1StructuredRequest; localRefs: R1LocalReferences }, restriction?: RestrictionEvidence | null): R1PrepareResult {
    const document = buildStructuredIngestDocument(input.structured);
    assertDataOnly(document);
    const documentSha256 = wfdSha256(canonicalWfdJson(document));
    this.assertLocalRefs(input.localRefs, documentSha256);
    this.assertCalculationCandidates(input.structured, input.localRefs, 'prepare', restriction);
    const localRefsSha256 = wfdSha256(canonicalWfdJson(input.localRefs));
    const now = Date.now();
    const existing = this.db.prepare('SELECT document_sha256,local_refs_sha256,state FROM r1_handoff_attempts WHERE request_id=?').get(input.structured.requestId) as
      { document_sha256: string; local_refs_sha256: string; state: string } | undefined;
    if (existing) {
      if (existing.document_sha256 !== documentSha256 || existing.local_refs_sha256 !== localRefsSha256) {
        fail('R1_REQUEST_CONFLICT', '同一 request_id 的文档或本地引用不同；不覆盖原 attempt。');
      }
      return { requestId: input.structured.requestId, state: String(existing.state), document, documentSha256, localRefsSha256 };
    }
    this.db.prepare('INSERT INTO r1_handoff_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      input.structured.requestId, input.structured.datasetId, input.structured.namespace,
      canonicalWfdJson(document), documentSha256, canonicalWfdJson(input.localRefs), localRefsSha256,
      'prepared_profile_pending', null, 0, null, now, now);
    return { requestId: input.structured.requestId, state: 'prepared_profile_pending', document, documentSha256, localRefsSha256 };
  }

  markProfileUnavailable(requestId: string, code: string, message: string): void {
    // 只有尚未发送的准备态可以改写成「描述档待核」；已发送、待核对或已结算的事实不能被覆盖。
    const updated = this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_wfd_profile',error_json=?,updated_at=? "
      + "WHERE request_id=? AND state IN ('prepared','prepared_profile_pending','pending_wfd_profile')")
      .run(canonicalWfdJson({ code, message }), Date.now(), requestId);
    if (Number(updated.changes) === 0) {
      throw new TaskError('R1_PROFILE_STATE_LOCKED',
        '该交接已进入发送、待核对或已结算状态，不能改写成描述档待核；请沿原请求核对实际状态。');
    }
  }

  /** 受控地重新取实际 fixed_read；不接受调用者拼接的 verified rows。 */
  async recordReceipt(requestId: string, receipt: R1Receipt,
    client: WfdStructuredIngestClient): Promise<{ state: string; associated: number; pending: number; errors: string[] }> {
    let rows: WfdRecord[];
    try {
      const attempt = this.attempt(requestId);
      rows = await this.readback.read({ requestId, documentSha256: String(attempt.document_sha256),
        document: JSON.parse(String(attempt.document_json)) as WfdRecord, receipt }, client);
    } catch (error) {
      const errors = ['fixed_read_failed:' + (typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code) : 'WFD_PRODUCT_MACHINE_ERROR')];
      // 读回失败同样要留下提交方的逐行回执，否则「已提交但未核对」这一段没有对账依据。
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(receipt), receipt.rows?.length ?? 1,
          canonicalWfdJson({ code: 'R1_FIXED_READ_FAILED', errors }), Date.now(), requestId);
      return { state: 'pending_receipt', associated: 0, pending: receipt.rows?.length ?? 1, errors };
    }
    return this.associateVerifiedReceipt(requestId, receipt, rows);
  }

  /** 只接受经实际 fixed_read 核对的逐行身份；缺一/错一即 pending，不插 association。 */
  private associateVerifiedReceipt(requestId: string, receipt: R1Receipt, verifiedFixedRows: WfdRecord[]): {
    state: string; associated: number; pending: number; errors: string[]
  } {
    const attempt = this.attempt(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const output = ((document.outputs as unknown[])[0] ?? {}) as WfdRecord;
    const errors: string[] = [];
    let expectedRows = new Map<string, WfdRecord>();
    try { expectedRows = acceptedR1ReceiptRows(document, receipt); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    const expectedKeys = new Set(expectedRows.keys());
    if (!isWfdRecord(receipt)) fail('R1_RECEIPT_INVALID', 'WFD 回执必须是对象。');
    for (const key of ['dataset_id', 'output_key', 'product_id', 'definition_digest', 'snapshot_id'] as const) {
      if ((key !== 'snapshot_id' || expectedKeys.size > 0) && (typeof receipt[key] !== 'string' || !receipt[key])) errors.push(`missing:${key}`);
    }
    if (receipt.dataset_id !== attempt.dataset_id) errors.push('dataset_id:mismatch');
    const attemptIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    if (!isWfdRecord(receipt.request_identity)
      || canonicalWfdJson(receipt.request_identity) !== canonicalWfdJson(attemptIdentity)) {
      errors.push('request_identity:mismatch');
    }
    if (receipt.output_key !== output.output_key) errors.push('output_key:mismatch');
    if (!Array.isArray(verifiedFixedRows) || expectedKeys.size > 0 && verifiedFixedRows.length === 0) errors.push('missing:verified_fixed_read');
    if (!Array.isArray(receipt.rows) || expectedKeys.size > 0 && receipt.rows.length === 0) errors.push('missing:rows');
    const fixed = (Array.isArray(verifiedFixedRows) ? verifiedFixedRows : []).map(row => ({
      row,
      businessKey: isWfdRecord(row.row) && typeof row.row.business_key === 'string' ? row.row.business_key : '',
      recordId: typeof row.record_id === 'string' ? row.record_id : '',
      recordVersion: typeof row.record_version === 'string' ? row.record_version : '',
      productId: typeof row.product_id === 'string' ? row.product_id : '',
      definitionDigest: isWfdRecord(row.definition_ref) && typeof row.definition_ref.digest === 'string' ? row.definition_ref.digest : '',
      snapshotId: isWfdRecord(row.record_ref) && typeof row.record_ref.snapshot_id === 'string' ? row.record_ref.snapshot_id : '',
    }));
    if (new Set(fixed.map(item => item.businessKey)).size !== fixed.length) errors.push('fixed:duplicate_business_key');
    if (new Set(fixed.map(item => item.recordId + '\u0000' + item.recordVersion)).size !== fixed.length) errors.push('fixed:duplicate_record_identity');
    const seen = new Set<string>();
    const byKey = new Map(fixed.map(item => [item.businessKey, item]));
    const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (const [index, value] of rows.entries()) {
      const row = asRecord(value);
      const expected = expectedRows.get(String(row.business_key ?? ''));
      const actual = fixed.find(item => item.businessKey === row.business_key);
      if (!expected || !actual) continue;
      const actualRow = asRecord(asRecord(actual.row).row);
      if (document.duplicate_policy === 'skip_identical_append' ? canonicalWfdJson(expected) !== canonicalWfdJson(actualRow) : !frozenR1RowMatches(expected, actualRow)) {
        if (document.duplicate_policy === 'skip_identical_append') errors.push(`row:${index}:business_content`);
        for (const key of Object.keys(expected)) if (!Object.hasOwn(actualRow, key)
          || canonicalWfdJson(expected[key]) !== canonicalWfdJson(actualRow[key])) errors.push(`row:${index}:business_content:${key}`);
      }
    }
    for (const [index, value] of rows.entries()) {
      const row = asRecord(value);
      const businessKey = typeof row.business_key === 'string' ? row.business_key : '';
      const recordId = typeof row.record_id === 'string' ? row.record_id : '';
      const recordVersion = typeof row.record_version === 'string' ? row.record_version : '';
      if (!businessKey) errors.push(`row:${index}:business_key`);
      if (!recordId) errors.push(`row:${index}:record_id`);
      if (!recordVersion) errors.push(`row:${index}:record_version`);
      if (businessKey && recordId && businessKey !== recordId) errors.push(`row:${index}:business_key_record_id`);
      if (!expectedKeys.has(businessKey)) errors.push(`row:${index}:unknown_business_key`);
      const match = byKey.get(businessKey);
      if (!match) errors.push(`row:${index}:not_in_fixed_read`);
      else {
        if (match.recordId !== recordId) errors.push(`row:${index}:record_id_mismatch`);
        if (match.recordVersion !== recordVersion) errors.push(`row:${index}:record_version_mismatch`);
        if (match.productId !== receipt.product_id) errors.push(`row:${index}:product_mismatch`);
        if (match.definitionDigest !== receipt.definition_digest) errors.push(`row:${index}:definition_mismatch`);
        if (match.snapshotId !== receipt.snapshot_id) errors.push(`row:${index}:snapshot_mismatch`);
      }
      const key = businessKey + '\u0000' + recordId + '\u0000' + recordVersion;
      if (seen.has(key)) errors.push(`row:${index}:duplicate_identity`);
      seen.add(key);
    }
    if (rows.length !== expectedKeys.size) errors.push(`row_count:${rows.length}/${expectedKeys.size}`);
    for (const key of expectedKeys) if (!rows.some(row => asRecord(row).business_key === key)) errors.push(`missing_business_key:${key}`);
    if (errors.length) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(receipt), Math.max(rows.length, 1), canonicalWfdJson({ code: 'R1_RECEIPT_MISMATCH', errors }), Date.now(), requestId);
      return { state: 'pending_receipt', associated: 0, pending: Math.max(rows.length, 1), errors };
    }
    if (R1_SETTLED_STATES.has(String(attempt.state)) && attempt.receipt_json && attempt.receipt_json !== canonicalWfdJson(receipt)) {
      fail('R1_RECEIPT_CONFLICT', '同一 request 已关联不同 WFD 回执；拒绝改写。');
    }
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    const originalId = refs.originalIds[0] ?? refs.materialIds[0];
    const sourceId = refs.sourceRefs[0]?.source_id;
    if (!originalId || !sourceId) fail('R1_LOCAL_REFERENCE', '关联需要 BD 原件与来源引用。');
    let associated = 0;
    const settledState = receipt.row_summary?.conflict_pending ? receipt.rows.length ? 'partially_associated' : 'conflicts_pending' : 'associated';
    this.options.database.transaction(() => {
      for (const row of rows) {
        const result = this.db.prepare(`INSERT INTO r1_record_associations
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,product_id,record_id,record_version,request_id,original_id) DO NOTHING`).run(
          receipt.dataset_id, receipt.product_id, receipt.definition_digest, receipt.snapshot_id,
          row.record_id, row.record_version, requestId, originalId, sourceId,
          canonicalWfdJson(refs.processRefs), canonicalWfdJson(refs.evidenceRefs), Date.now());
        associated += Number(result.changes ?? 0);
      }
      this.db.prepare("UPDATE r1_handoff_attempts SET state=?,receipt_json=?,pending_count=0,error_json=NULL,updated_at=? WHERE request_id=?")
        .run(settledState, canonicalWfdJson(receipt), Date.now(), requestId);
    });
    return { state: settledState, associated, pending: 0, errors: [] };
  }

  markSending(requestId: string): void {
    this.db.prepare("UPDATE r1_handoff_attempts SET state='sending',error_json=NULL,updated_at=? WHERE request_id=?")
      .run(Date.now(), requestId);
  }

  /** New first sends recheck known calculation provenance; accepted/unknown external identities keep their recovery path. */
  assertCalculationReadyToSend(requestId: string, restriction?: RestrictionEvidence | null): void {
    const attempt = this.attempt(requestId);
    if (R1_SETTLED_STATES.has(String(attempt.state)) || ['rejected', 'sending', 'pending_unknown', 'pending_receipt'].includes(String(attempt.state))) return;
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const output = (document.outputs as WfdRecord[])[0]!;
    this.assertCalculationCandidates({ definition: output.definition as WfdRecord, payload: output.payload as WfdRecord },
      JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences, 'first_send', restriction);
  }

  /**
   * 原 R1 首次发送前的异步来源再核：对已识别的 Polars 计算候选从 WFD
   * 冻结快照复读。没有配置的新方法不能由此绕过现有同步候选/用途审核。
   * 本函数不设置 sending，不调用外部 submit，不更改任何已保存回执。
   */
  async assertRemoteCalculationReadyToSend(requestId: string, signal: AbortSignal): Promise<void> {
    const attempt = this.attempt(requestId);
    if (R1_SETTLED_STATES.has(String(attempt.state))
      || ['rejected', 'sending', 'pending_unknown', 'pending_receipt'].includes(String(attempt.state))) return;
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    if (refs.fixedAlgorithm?.kind === 'structured_polars') {
      if (!this.options.verifyFixedDerivedRemote)
        throw new TaskError('DERIVED_REMOTE_UNBOUND', '结构化固定算法发布前 WFD 原始来源复核器未装配。');
      await this.options.verifyFixedDerivedRemote(refs.fixedAlgorithm.taskId, signal);
      return;
    }
    const callback = this.options.verifyCalculationCandidateRemote;
    if (!callback) return; // 独立原报测试保留原同步验证；正式宿主装配远端核验。
    if (refs.fixedAlgorithm || !Array.isArray(refs.materialIds) || !refs.processRefs?.length) return;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_material_uploads'").get()) {
      // 还没有任何经受管上传形成的计算候选；同步原件核对仍独立执行。
      return;
    }
    const seen = new Set<string>();
    for (const materialId of refs.materialIds) {
      signal.throwIfAborted();
      const staged = this.db.prepare(`SELECT u.request_id FROM material_objects m JOIN harness_material_uploads u
        ON u.task_id=json_extract(m.envelope_json,'$.taskId')
        WHERE m.material_id=? AND u.request_id LIKE 'polars-stage:%'`).get(materialId) as { request_id: string } | undefined;
      if (!staged) continue; // 非 Polars 计算的原报材料由既有 R1 校验。
      const taskId = staged.request_id.slice('polars-stage:'.length);
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      await callback(taskId, signal);
    }
  }

  /** 实际 submit 结果 → 逐输出 records → 实际 fixed_read → 逐行关联。 */
  async submitAndAssociate(requestId: string, client: WfdStructuredIngestClient, signal?: AbortSignal, restriction?: RestrictionEvidence | null): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    if (R1_SETTLED_STATES.has(String(attempt.state))) return this.localExplanation(requestId);
    if (attempt.state === 'rejected') fail('R1_WFD_REJECTED', '原请求已由 WFD 明确拒绝；不重发原身份。');
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    this.assertLocalRefs(JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences, String(attempt.document_sha256));
    if (['sending', 'pending_unknown', 'pending_receipt'].includes(String(attempt.state))) {
      fail('R1_RECOVERY_REQUIRED', '该原请求结果尚未核清；必须沿原 identity 查询状态，不能重新提交。');
    }
    this.assertCalculationReadyToSend(requestId, restriction);
    await this.assertRemoteCalculationReadyToSend(requestId, signal ?? new AbortController().signal);
    this.markSending(requestId);
    let reply: WfdProductMachineReply;
    try {
      reply = await client.submit(document, signal);
    } catch (error) {
      const accepted = (error as { mayHaveBeenAccepted?: boolean }).mayHaveBeenAccepted === true;
      const state = accepted ? 'pending_unknown' : 'send_failed';
      const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'R1_SUBMIT_FAILED';
      this.db.prepare('UPDATE r1_handoff_attempts SET state=?,error_json=?,updated_at=? WHERE request_id=?')
        .run(state, canonicalWfdJson({ code, may_have_been_accepted: accepted,
          request_identity: document.request_identity ?? null,
          message: error instanceof Error ? error.message : String(error) }), Date.now(), requestId);
      return { state, code, may_have_been_accepted: accepted,
        recovery: accepted ? 'query_same_request_status_do_not_resubmit_new_identity' : 'deterministic_before_write' };
    }
    try {
      return await this.consumeResult(requestId, reply.result, client, signal);
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'R1_CONSUME_FAILED';
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(reply.result), canonicalWfdJson({ code,
          request_identity: document.request_identity ?? null,
          message: error instanceof Error ? error.message : String(error) }), Date.now(), requestId);
      return { state: 'pending_receipt', code, recovery: 'query_same_request_status_then_consume' };
    }
  }

  async consumeResult(requestId: string, result: WfdRecord, client: WfdStructuredIngestClient, signal?: AbortSignal, continueLegacy = false): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    if (R1_SETTLED_STATES.has(String(attempt.state))) return this.localExplanation(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const expectedIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    if (!isWfdRecord(result.request_identity)
      || canonicalWfdJson(result.request_identity) !== canonicalWfdJson(expectedIdentity)) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), canonicalWfdJson({ code: 'R1_RESULT_IDENTITY_MISMATCH' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_RESULT_IDENTITY_MISMATCH'] };
    }
    const state = typeof result.state === 'string' ? result.state : 'unknown';
    if (document.duplicate_policy === 'skip_identical_append' && ['published_formal','published_sandbox','partially_published_formal','partially_published_sandbox','unchanged','conflicts_pending'].includes(state))
      result = await this.completeDuplicateStatus(document, result, client, signal);
    if (isTerminalWfdRejection(result, document)) {
      const outputErrors = (Array.isArray(result.output_results) ? result.output_results : []).flatMap(value => {
        const output = asRecord(value);
        return (Array.isArray(output.errors) ? output.errors : []).map(value => ({ ...asRecord(value), output_key: output.output_key ?? null }));
      });
      const errors = [...(Array.isArray(result.errors) ? result.errors : []), ...outputErrors];
      const registration = result.state === 'registered_not_published' ? { registration_preserved: true,
        message: 'WFD 已登记产品定义，但已明确拒绝全部输出且未发布任何记录；原登记事实、回执和错误保留，不重投原身份。' } : {};
      this.db.prepare("UPDATE r1_handoff_attempts SET state='rejected',receipt_json=?,pending_count=0,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), canonicalWfdJson({ code: 'R1_WFD_REJECTED', wfd_state: state, ...registration, errors }), Date.now(), requestId);
      return { state: 'rejected', code: 'R1_WFD_REJECTED', wfd_state: state, ...registration, errors };
    }
    if (!(state === 'published_formal' || document.duplicate_policy === 'skip_identical_append' && ['published_sandbox','partially_published_formal','partially_published_sandbox','unchanged','conflicts_pending'].includes(state)) || !Array.isArray(result.output_results) || result.output_results.length !== 1) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), 1, canonicalWfdJson({ code: 'R1_RESULT_NOT_COMPLETE', state }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_RESULT_NOT_COMPLETE'], wfd_state: state };
    }
    const output = asRecord(result.output_results[0]);
    const records = Array.isArray(output.records) ? output.records.map(asRecord) : [];
    const snapshotId = typeof output.snapshot_id === 'string' ? output.snapshot_id : '';
    const productId = typeof output.product_id === 'string' ? output.product_id : '';
    const definitionDigest = isWfdRecord(output.definition_ref) && typeof output.definition_ref.digest === 'string'
      ? output.definition_ref.digest : '';
    if ((!records.length || !snapshotId) && !(document.duplicate_policy === 'skip_identical_append' && state === 'conflicts_pending') || !productId || !definitionDigest) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), 1, canonicalWfdJson({ code: 'R1_RECORDS_INCOMPLETE' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_RECORDS_INCOMPLETE'] };
    }
    if (!isWfdRecord(result.request_identity)) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), 1, canonicalWfdJson({ code: 'R1_REQUEST_IDENTITY_MISSING' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_REQUEST_IDENTITY_MISSING'] };
    }
    const requireContracts = asRecord((Array.isArray(document.outputs) ? asRecord(document.outputs[0]) : {}).payload).kind === 'tabular_rows'
      || (JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences).contractBindingRequired === true;
    const contractBinding = requireContracts ? readR1ContractBinding(output, String(attempt.dataset_id), productId, true) : undefined;
    const receipt: R1Receipt = {
      dataset_id: String(attempt.dataset_id),
      output_key: typeof output.output_key === 'string' ? output.output_key : '',
      product_id: productId,
      definition_digest: definitionDigest,
      snapshot_id: snapshotId,
      request_identity: result.request_identity,
      ...contractBinding,
      ...(document.duplicate_policy === 'skip_identical_append' ? {
        row_results: output.row_results as R1RowResult[], row_summary: { inserted: asRecord(output.row_summary).inserted as number, duplicate_skipped: asRecord(output.row_summary).duplicate_skipped as number, conflict_pending: asRecord(output.row_summary).conflict_pending as number },
        wfd_state: state, new_snapshot_created: result.new_snapshot_created === true,
      } : {}),
      rows: records.map(record => ({
        business_key: typeof record.record_id === 'string' ? record.record_id : '',
        record_id: typeof record.record_id === 'string' ? record.record_id : '',
        record_version: typeof record.record_version === 'string' ? record.record_version : '',
      })),
    };
    acceptedR1ReceiptRows(document, receipt);
    if (document.duplicate_policy === 'skip_identical_append') {
      const summary = receipt.row_summary!;
      if (asRecord(output.row_summary).pending_publication !== undefined && asRecord(output.row_summary).pending_publication !== 0) fail('R1_ROW_RESULT_STATE', '仍有待发布行，未将其计为已接收。');
      if (typeof result.new_snapshot_created !== 'boolean' || result.new_snapshot_created !== (summary.inserted > 0)) fail('R1_ROW_RESULT_STATE', '新快照标记与实际新增计数不符。');
      if (['published_formal','published_sandbox'].includes(state) && summary.inserted === 0) fail('R1_ROW_RESULT_STATE', '没有实际新增行，不能冒称本次新发布。');
      if ((state === 'conflicts_pending') !== (summary.conflict_pending > 0 && summary.inserted === 0)
        || (['partially_published_formal','partially_published_sandbox'].includes(state)) !== (summary.conflict_pending > 0 && summary.inserted > 0)
        || state === 'unchanged' && summary.inserted !== 0) fail('R1_ROW_RESULT_STATE', '顶层状态与逐行处理计数不同。');
      receipt.conflicts = await this.readConflictRows(document, receipt, client, signal);
    }
    const readInput = { requestId, documentSha256: String(attempt.document_sha256), document, receipt };
    if (continueLegacy && attempt.error_json) await this.readback.beginPageContinuation(readInput,client,
      asRecord(JSON.parse(String(attempt.error_json))),signal);
    const fixedRows = receipt.rows.length ? await this.readback.read(readInput, client, signal) : [];
    return this.associateVerifiedReceipt(requestId, receipt, fixedRows);
  }

  private async completeDuplicateStatus(document: WfdRecord, initial: WfdRecord, client: WfdStructuredIngestClient, signal?: AbortSignal): Promise<WfdRecord> {
    const initialOutputs = Array.isArray(initial.output_results) ? initial.output_results : [];
    const first = asRecord(initialOutputs[0]);
    const expected = (asRecord(asRecord((document.outputs as unknown[])[0]).payload).rows as unknown[]).length;
    if (initialOutputs.length === 1 && first.row_results_complete === true && first.row_results_offset === 0
      && first.row_results_total === expected && first.row_results_included === expected
      && first.next_row_offset === null && Array.isArray(first.row_results) && first.row_results.length === expected) return initial;
    const rows: WfdRecord[] = [], records = new Map<string,WfdRecord>(), inserted = new Map<string,WfdRecord>();
    let offset = 0, frozen: string | null = null, full: WfdRecord = {}, last: WfdRecord = initial;
    while (offset < expected) {
      signal?.throwIfAborted();
      const reply = await client.requestStatusPage(asRecord(document.request_identity),
        { outputOffset: 0, outputLimit: 1, outputDetail: 'full', rowOffset: offset, rowLimit: 256 }, signal);
      const result = reply.result, outputs = Array.isArray(result.output_results) ? result.output_results : [];
      if (canonicalWfdJson(result.request_identity) !== canonicalWfdJson(document.request_identity) || result.state !== initial.state
        || outputs.length !== 1 || result.outputs_complete !== true || result.outputs_total !== 1
        || asRecord(result.pagination).detail !== 'full') fail('R1_ROW_STATUS_PAGE', '原请求状态、输出范围或完整明细投影不同。');
      const output = asRecord(outputs[0]), part = output.row_results;
      if (!Array.isArray(part) || !part.length || part.length > 256 || output.row_results_total !== expected
        || output.row_results_offset !== offset || output.row_results_included !== part.length
        || output.row_results_complete !== (offset === 0 && part.length === expected)
        || part.some((row,index) => !isWfdRecord(row) || row.row_index !== offset+index)
        || output.next_row_offset !== (offset+part.length < expected ? offset+part.length : null))
        fail('R1_ROW_STATUS_PAGE', '逐原行状态页缺失、重复、跳号或终止标记不完整。');
      const binding = canonicalWfdJson({ state: result.state, output_key: output.output_key, product_id: output.product_id,
        definition_ref: output.definition_ref, snapshot_id: output.snapshot_id, row_summary: output.row_summary,
        contract_refs: output.contract_refs ?? null, contract_bundle_ref: output.contract_bundle_ref ?? null,
        publication_state: output.publication_state ?? null, new_snapshot_created: result.new_snapshot_created ?? null });
      if (frozen !== null && frozen !== binding) fail('R1_ROW_STATUS_PAGE', '原请求分页的产品、定义、计数或快照发生变化。');
      frozen = binding; full = output; last = result;
      const accepted = new Set(part.filter(row => asRecord(row).state !== 'conflict_pending').map(row => canonicalWfdJson([asRecord(row).record_id,asRecord(row).record_version])));
      const pageRecords = Array.isArray(output.records) ? output.records.map(asRecord) : [];
      if (pageRecords.length !== accepted.size || new Set(pageRecords.map(ref => canonicalWfdJson([ref.record_id,ref.record_version]))).size !== accepted.size
        || pageRecords.some(ref => !accepted.has(canonicalWfdJson([ref.record_id,ref.record_version])))) fail('R1_ROW_STATUS_PAGE', '状态页实际记录引用与该页已接收行不同。');
      for (const ref of pageRecords) records.set(canonicalWfdJson([ref.record_id,ref.record_version]), ref);
      for (const ref of Array.isArray(output.inserted_records) ? output.inserted_records.map(asRecord) : []) inserted.set(canonicalWfdJson([ref.record_id,ref.record_version]),ref);
      rows.push(...part.map(asRecord)); offset += part.length;
    }
    return { ...last, output_results: [{ ...full, row_results: rows, records: [...records.values()], inserted_records: [...inserted.values()],
      row_results_offset: 0, row_results_total: expected, row_results_included: expected, row_results_complete: true, next_row_offset: null }] };
  }

  private async readConflictRows(document: WfdRecord, receipt: R1Receipt, client: WfdStructuredIngestClient, signal?: AbortSignal): Promise<WfdRecord[]> {
    const conflicts = (receipt.row_results ?? []).filter(row => row.state === 'conflict_pending');
    const payloadRows = asRecord(asRecord((document.outputs as unknown[])[0]).payload).rows as WfdRecord[];
    const groups = new Map<string, { snapshot: string; product: string; refs: Map<string, WfdRecord>; history: boolean }>();
    for (const conflict of conflicts) for (const ref of conflict.existing_records) {
      const key = canonicalWfdJson([ref.snapshot_id, ref.product_id]);
      const group = groups.get(key) ?? { snapshot: ref.snapshot_id, product: ref.product_id, refs: new Map(), history: false };
      group.history ||= ref.withdrawn === true;
      group.refs.set(canonicalWfdJson([ref.record_id,ref.record_version]), ref as unknown as WfdRecord); groups.set(key, group);
    }
    const verified = new Map<string, WfdRecord>();
    const paged = groups.size > 0 && await client.pageReadSupport?.(document, signal) === true;
    for (const group of groups.values()) {
      const refs = [...group.refs.values()].map(ref => ({ record_id: String(ref.record_id), record_version: String(ref.record_version) }))
        .sort((a,b) => Buffer.compare(Buffer.from(a.record_id),Buffer.from(b.record_id)));
      const groupPaged = paged && !group.history;
      let cursor: string | null = null, count = 0;
      const cursors = new Set<string>();
      do {
        signal?.throwIfAborted();
        const previousCount = count;
        const reply = groupPaged
          ? await client.fixedReadPage({ snapshotId: group.snapshot, productId: group.product, recordRefs: refs,
            pageSize: 256, maxPageBytes: 1_048_576, cursor }, signal)
          : group.history ? await client.fixedReadHistory(group.snapshot, group.product, signal)
          : await client.fixedRead(group.snapshot, group.product, signal);
        if (!Array.isArray(reply.result.rows)) fail('R1_CONFLICT_READBACK', '冲突旧值缺少固定读取行。');
        for (const value of reply.result.rows) {
          const row = asRecord(value), ref = group.refs.get(canonicalWfdJson([row.record_id,row.record_version]));
          if (!ref) { if (groupPaged) fail('R1_CONFLICT_READBACK', '冲突固定页包含选择外的行。'); continue; }
          const key = canonicalWfdJson([group.snapshot,group.product,row.record_id,row.record_version]);
          if (verified.has(key) || row.product_id !== group.product || asRecord(row.record_ref).snapshot_id !== group.snapshot
            || asRecord(row.record_ref).logical_key !== row.record_id || asRecord(row.record_ref).revision_id !== row.record_version
            || asRecord(row.row).business_key !== row.record_id
            || ref.withdrawn === true && asRecord(row.revision).withdrawn !== true
            || asRecord(row.definition_ref).digest !== asRecord(ref.definition_ref).digest) fail('R1_CONFLICT_READBACK', '冲突旧值的固定身份、定义或唯一性不同。');
          verified.set(key, { ...ref, row: asRecord(row.row), ...(ref.withdrawn === true ? { revision: row.revision, revision_state: row.revision_state } : {}) }); count++;
        }
        const page = asRecord(reply.result.pagination);
        if (!groupPaged || page.has_more !== true) break;
        if (typeof page.next_cursor !== 'string' || !page.next_cursor || cursors.has(page.next_cursor) || count >= refs.length || count === previousCount)
          fail('R1_CONFLICT_READBACK', '冲突旧值的固定分页未推进。');
        cursor = page.next_cursor; cursors.add(cursor);
      } while (true);
      if (count !== refs.length) fail('R1_CONFLICT_READBACK', '冲突旧值没有完整固定读回。');
    }
    const incomingGroups = new Map<string, { count: number; samples: { row_index: number; row: WfdRecord; digest: string }[] }>();
    for (const conflict of conflicts) {
      const group = incomingGroups.get(conflict.business_key) ?? { count: 0, samples: [] };
      group.count++;
      const row = payloadRows[conflict.row_index]!, digest = wfdSha256(canonicalWfdJson(row));
      if (group.samples.length < 5 && !group.samples.some(sample => sample.digest === digest))
        group.samples.push({ row_index: conflict.row_index, row, digest });
      incomingGroups.set(conflict.business_key, group);
    }
    return conflicts.map(conflict => {
      const group = incomingGroups.get(conflict.business_key)!;
      return { ...conflict, incoming_row: payloadRows[conflict.row_index],
        existing_rows: conflict.existing_records.map(ref => verified.get(canonicalWfdJson([ref.snapshot_id,ref.product_id,ref.record_id,ref.record_version]))!),
        incoming_conflict_rows: group.samples.filter(sample => sample.row_index !== conflict.row_index).slice(0,4).map(({ row_index, row }) => ({ row_index, row })),
        incoming_conflict_rows_total: group.count - 1,
        confirmation_state: 'pending_user_confirmation' };
    });
  }

  /** Explicit write continuation; ordinary recoverStatus remains a status/readback action. */
  async resumeAcceptedAndAssociate(requestId:string,client:WfdStructuredIngestClient,signal?:AbortSignal):Promise<WfdRecord> {
    const attempt=this.attempt(requestId);
    if(R1_SETTLED_STATES.has(String(attempt.state)))return this.localExplanation(requestId);
    this.assertSourceAuthorized(requestId);
    const document=JSON.parse(String(attempt.document_json)) as WfdRecord;
    const reply=await client.resumeAccepted(document,signal);
    try{return await this.consumeResult(requestId,reply.result,client,signal);}
    catch(error){
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(reply.result),canonicalWfdJson({code:'R1_RESUME_READBACK_PENDING',message:error instanceof Error?error.message:String(error)}),Date.now(),requestId);
      throw error;
    }
  }

  attempt(requestId: string): WfdRecord {
    const row = this.db.prepare('SELECT * FROM r1_handoff_attempts WHERE request_id=?').get(requestId) as WfdRecord | undefined;
    if (!row) throw new TaskError('R1_ATTEMPT_NOT_FOUND', '没有该 R1 交接 attempt；不能用快照号或新请求代替。');
    verifyCanonicalDigest(String(row.document_json), String(row.document_sha256), 'R1_DOCUMENT_CHANGED');
    verifyCanonicalDigest(String(row.local_refs_json), String(row.local_refs_sha256), 'R1_LOCAL_REFS_CHANGED');
    return structuredClone(row);
  }

  /** 新提交前只核原冻结 BD 来源；旧 pending 的原身份恢复不经过此闸。 */
  assertSourceAuthorized(requestId: string): void {
    const attempt = this.attempt(requestId);
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    if (refs.sourceRefs.length !== 1) fail('R1_LOCAL_REFERENCE', '原请求缺唯一来源声明。');
    assertKnownR1Source(refs.sourceRefs[0]);
  }

  localExplanation(requestId: string): WfdRecord {
    return this.attemptWithExplanation(requestId).local;
  }

  attemptWithExplanation(requestId: string): { attempt: WfdRecord; local: WfdRecord } {
    const attempt = this.attempt(requestId);
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    const originals = refs.originalIds.map(originalId => {
      const row = this.db.prepare('SELECT original_id,sha256,original_name,source_json,source_digest FROM r1_originals WHERE original_id=?').get(originalId) as WfdRecord | undefined;
      if (!row) fail('R1_ORIGINAL_NOT_FOUND', 'BD 原件关联丢失。');
      verifyCanonicalDigest(String(row.source_json), String(row.source_digest), 'R1_SOURCE_CHANGED');
      return row;
    });
    const associations = this.db.prepare('SELECT * FROM r1_record_associations WHERE request_id=? ORDER BY product_id,record_id,record_version').all(requestId);
    const local = { state: attempt.state, request_id: requestId, local_refs: refs, originals, associations,
      ...(attempt.receipt_json ? { receipt: JSON.parse(String(attempt.receipt_json)) as WfdRecord } : {}),
      readback: this.readback.progress(requestId),
      note: 'BD 可在 WFD 不可用时独立解释该 request 的原件/来源/加工/证据；association 为空时未拿到实际 WFD 行身份。' };
    return { attempt, local };
  }

  /** Exact, already verified row/version association; never caller-supplied evidence mapping. */
  recordMaterials(input: { datasetId: string; productId: string; recordId: string; recordVersion: string }): {
    requestId: string; snapshotId: string; materialIds: string[]; originalIds: string[];
  } | null {
    const row = this.db.prepare(`SELECT a.request_id,a.snapshot_id FROM r1_record_associations a JOIN r1_handoff_attempts h ON h.request_id=a.request_id
      WHERE a.dataset_id=? AND a.product_id=? AND a.record_id=? AND a.record_version=?
      AND (json_extract(h.document_json,'$.duplicate_policy') IS NULL OR EXISTS (
        SELECT 1 FROM json_each(h.receipt_json,'$.row_results') r WHERE json_extract(r.value,'$.record_id')=a.record_id
        AND json_extract(r.value,'$.record_version')=a.record_version AND json_extract(r.value,'$.state')='inserted'))
      ORDER BY a.created_at,a.rowid LIMIT 1`)
      .get(input.datasetId, input.productId, input.recordId, input.recordVersion);
    if (!row) return null;
    const attempt = this.attempt(String(row.request_id));
    if (!R1_SETTLED_STATES.has(String(attempt.state))) fail('R1_ASSOCIATION_UNVERIFIED', '原请求未完成固定读回核对。');
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    const materialIds = new Set(refs.materialIds);
    // The normal workspace preserves an R1 original acquisition, while its
    // exact material identity lives in the already verified processing plan.
    // Follow that explicit plan/output link; never merge materials by hash.
    if (!materialIds.size && this.options.processing) {
      this.assertLocalRefs(refs, String(attempt.document_sha256));
      for (const process of refs.processRefs) {
        const plan = asRecord(this.options.processing.get(process.plan_id!));
        const output = (Array.isArray(plan.outputs) ? plan.outputs : []).map(asRecord).find(item => item.outputId === process.output_id);
        for (const material of (Array.isArray(plan.materials) ? plan.materials : []).map(asRecord)) {
          if (material.sha256 === stripSha(process.input_sha256) && Array.isArray(output?.materialIds)
            && output.materialIds.includes(material.materialId) && typeof material.materialId === 'string') materialIds.add(material.materialId);
        }
      }
    }
    return { requestId: String(row.request_id), snapshotId: String(row.snapshot_id),
      materialIds: [...materialIds], originalIds: [...refs.originalIds] };
  }

  /** 同 request_identity 分页读取状态；完整核对已接收行，冲突终态独立保留。 */
  async recoverStatus(requestId: string, client: WfdStructuredIngestClient, signal?: AbortSignal): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    if (attempt.state === 'rejected') {
      const error = attempt.error_json ? asRecord(JSON.parse(String(attempt.error_json))) : {};
      return { state: 'rejected', code: 'R1_WFD_REJECTED', ...(error.registration_preserved === true
        ? { registration_preserved: true, wfd_state: error.wfd_state } : {}) };
    }
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    if (R1_SETTLED_STATES.has(String(attempt.state)) && document.duplicate_policy === 'skip_identical_append') return this.localExplanation(requestId);
    const expectedIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    const collected: WfdRecord[] = [];
    let offset = 0, pages = 0, lastState = 'unknown', outputsTotal = 0, outputsComplete = false;
    let lastResult: WfdRecord = {};
    for (; pages < 100; pages += 1) {
      const reply = await client.requestStatusPage(expectedIdentity,
        { outputOffset: offset, outputLimit: 50, outputDetail: 'full' }, signal);
      const result = reply.result;
      lastResult = result;
      const pageState = typeof result.state === 'string' ? result.state : 'unknown';
      lastState = pageState;
      const actualIdentity = isWfdRecord(result.request_identity) ? result.request_identity : {};
      if (canonicalWfdJson(actualIdentity) !== canonicalWfdJson(expectedIdentity)) {
        this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,error_json=?,updated_at=? WHERE request_id=?")
          .run(canonicalWfdJson(result), canonicalWfdJson({ code: 'R1_RECOVERY_IDENTITY_MISMATCH',
            expected_identity: expectedIdentity, actual_identity: actualIdentity }), Date.now(), requestId);
        return { state: 'pending_receipt', wfd_state: pageState, error: 'R1_RECOVERY_IDENTITY_MISMATCH' };
      }
      const outputs = Array.isArray(result.output_results) ? result.output_results : [];
      collected.push(...outputs.map(asRecord));
      outputsTotal = typeof result.outputs_total === 'number' ? result.outputs_total : collected.length;
      outputsComplete = result.outputs_complete === true || (result.pagination as WfdRecord | undefined)?.has_more !== true;
      if ((result.pagination as WfdRecord | undefined)?.has_more !== true) break;
      offset = Number((result.pagination as WfdRecord).next_offset ?? offset + outputs.length);
      if (!Number.isSafeInteger(offset) || offset <= 0) fail('R1_RECOVERY_PAGING', '状态分页游标无效。');
    }
    const outputStates = collected.map(item => typeof item.publication_state === 'string' ? item.publication_state : 'unknown');
    const allFormal = outputStates.length > 0 && outputStates.every(state => state === 'published_formal');
    if (R1_SETTLED_STATES.has(String(attempt.state))) {
      const conflicts: string[] = [];
      if (lastState !== 'published_formal') conflicts.push('associated_but_status_not_formal:' + lastState);
      if (!allFormal) conflicts.push('associated_but_outputs_not_formal');
      if (outputsTotal !== collected.length) conflicts.push(`associated_outputs_partial:${collected.length}/${outputsTotal}`);
      return { state: 'associated', wfd_state: lastState,
        reconciliation: conflicts.length ? 'conflict_preserved_original_association' : 'consistent',
        conflicts, associations: (Array.isArray(this.localExplanation(requestId).associations) ? this.localExplanation(requestId).associations as unknown[] : []).length };
    }
    if ((['rejected', 'registered_not_published'].includes(lastState) || document.duplicate_policy === 'skip_identical_append' && ['published_formal','published_sandbox','partially_published_formal','partially_published_sandbox','unchanged','conflicts_pending'].includes(lastState)) && outputsComplete && collected.length === outputsTotal) {
      return this.consumeResult(requestId, { ...lastResult, output_results: collected,
        request_identity: expectedIdentity, outputs_total: outputsTotal, outputs_complete: true }, client, signal);
    }
    if (lastState !== 'published_formal' || !allFormal || !outputsComplete || collected.length !== outputsTotal) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson({ ...lastResult, output_results: collected }), Math.max(outputsTotal - collected.length, 1), canonicalWfdJson({
          code: 'R1_RECOVERY_NOT_FORMAL_COMPLETE', wfd_state: lastState,
          output_states: outputStates, collected: collected.length, total: outputsTotal,
          outputs_complete: outputsComplete }), Date.now(), requestId);
      return { state: 'pending_receipt', wfd_state: lastState, outputs: collected.length,
        total: outputsTotal, output_states: outputStates };
    }
    const result = { ...lastResult, state: lastState, output_results: collected,
      request_identity: expectedIdentity } as WfdRecord;
    return this.consumeResult(requestId, result, client, signal, true);
  }

  private assertCalculationCandidates(structured: Pick<R1StructuredRequest, 'definition' | 'payload'>, refs: R1LocalReferences,
    boundary: 'prepare' | 'first_send', restrictionOverride?: RestrictionEvidence | null): void {
    if (refs.fixedAlgorithm) return; // 全部数据由独立固定算法核验器在 assertLocalRefs 中核对。
    const hasUploads = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_material_uploads'").get();
    for (const process of refs.processRefs) {
      const plan = asRecord(this.options.processing!.get(process.plan_id!));
      const output = (Array.isArray(plan.outputs) ? plan.outputs : []).map(asRecord).find(item => item.outputId === process.output_id);
      if (!output) fail('R1_PROCESS_NOT_FOUND', '实际加工服务中没有该固定计划/输出。');
      const usage = asRecord(output.usage);
      if (!usage || !Array.isArray(usage.purposeEvidence) || usage.purposeEvidence.length === 0
        || typeof usage.purpose !== 'string') {
        fail('R1_USAGE_DECLARATION_MISSING', '加工输出没有真实受信结构化用途与证据；不能按普通原件准备或首次发送。');
      }
      if (usage.purpose !== 'current_publish' && usage.purpose !== 'historical_publish') {
        fail('R1_PUBLISH_PURPOSE_REQUIRED', 'R1准备/首次发送只接受 current_publish 或 historical_publish；当前计算用途不能进入发布边界。');
      }
      const objectSha256 = stripSha(process.output_sha256);
      const definition = isWfdRecord(structured.definition) ? structured.definition : {};
      const context = isWfdRecord(definition.semantic_context) ? definition.semantic_context : {};
      const derived = isWfdRecord(usage.derived) ? usage.derived as unknown as PurposeEligibilityInput['derived'] : null;
      const result = evaluatePurposeEligibility({
        ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
        purpose: usage.purpose as EligibilityPurpose,
        purposeEvidence: usage.purposeEvidence as unknown as PurposeEligibilityInput['purposeEvidence'],
        history: { mode: (usage.historyMode ?? null) as EligibilityHistoryMode | null,
          cutoff: typeof usage.cutoff === 'string' ? usage.cutoff : null,
          perspective: typeof usage.perspective === 'string' ? usage.perspective : null },
        object: { objectSha256, origin: context.content_nature === 'deterministic_derived' ? 'derived_candidate' : 'managed_original',
          productId: typeof usage.productId === 'string' ? usage.productId : null,
          snapshotId: typeof usage.snapshotId === 'string' ? usage.snapshotId : null,
          recordVersion: typeof usage.recordVersion === 'string' ? usage.recordVersion : objectSha256,
          definitionRevision: typeof usage.definitionRevision === 'string' ? usage.definitionRevision : null,
          contentVerified: true, contentBasis: 'R1 实际加工产物字节摘要与固定计划/输出核对' },
        publicationTime: isWfdRecord(usage.publicationTime) ? usage.publicationTime as unknown as PurposeEligibilityInput['publicationTime'] : null,
        holdingTime: isWfdRecord(usage.holdingTime) ? usage.holdingTime as unknown as PurposeEligibilityInput['holdingTime'] : null,
        revisions: Array.isArray(usage.revisions) ? usage.revisions as unknown as PurposeEligibilityInput['revisions'] : null,
        wfdHistory: isWfdRecord(usage.wfdHistory) ? usage.wfdHistory as unknown as PurposeEligibilityInput['wfdHistory'] : null,
        restriction: restrictionOverride ?? (isWfdRecord(usage.restriction) ? usage.restriction as unknown as PurposeEligibilityInput['restriction'] : null),
        derived, wfdDecision: null, boundary, nowUtc: new Date().toISOString(),
      });
      if (result.status !== 'eligible') {
        fail(result.status === 'ineligible' ? 'PURPOSE_ELIGIBILITY_INELIGIBLE' : 'PURPOSE_ELIGIBILITY_INSUFFICIENT',
          canonicalWfdJson({ ruleVersion: result.ruleVersion, status: result.status, purpose: result.purpose,
            history: result.history, historyUse: result.historyUse, timings: result.timings,
            gaps: result.gaps.filter(item => item.blocking), checks: result.checks,
            evidenceSha256: result.evidenceSha256 }));
      }
      if (!hasUploads) continue;
      for (const materialId of Array.isArray(output.materialIds) ? output.materialIds : []) {
        // The durable intake task and original completed calculation are checked again by the verifier.
        // Filename, content hash alone, and caller-supplied lineage are never provenance authority.
        const staged = this.db.prepare(`SELECT u.request_id FROM material_objects m JOIN harness_material_uploads u
          ON u.task_id=json_extract(m.envelope_json,'$.taskId') WHERE m.material_id=?
            AND (u.request_id LIKE 'polars-stage:%' OR u.request_id LIKE 'alg-stage:%')`).get(String(materialId)) as { request_id: string } | undefined;
        if (!staged) continue;
        const derived = staged.request_id.startsWith('alg-stage:');
        const verify = derived ? this.options.verifyAlgorithmCandidate : this.options.verifyCalculationCandidate;
        if (!verify) fail('R1_CALCULATION_VERIFIER_UNBOUND', '派生材料缺少受信原计算验证器，不能按普通原件提交。');
        verify({ taskId: staged.request_id.slice(derived ? 'alg-stage:'.length : 'polars-stage:'.length),
          materialId: String(materialId), planId: process.plan_id!, outputId: process.output_id!,
          definition: structured.definition, payload: structured.payload });
      }
    }
  }

  private assertLocalRefs(refs: R1LocalReferences, documentSha256: string): void {
    if (!refs || !['originalIds', 'materialIds', 'sourceRefs', 'processRefs', 'evidenceRefs']
      .every(key => Array.isArray(refs[key as keyof R1LocalReferences]))) {
      fail('R1_LOCAL_REFERENCE', 'R1 需要完整的原件、材料、来源、加工及证据引用数组。');
    }
    if (!refs.fixedAlgorithm && !this.options.processing)
      fail('R1_PROCESSING_UNBOUND', '未装配实际加工服务；只允许本地解释，禁止准备或提交新交接。');
    if (refs.sourceRefs.length !== 1 || refs.originalIds.length + refs.materialIds.length !== 1
      || refs.originalIds.length > 1 || refs.materialIds.length > 1) {
      fail('R1_MULTI_SOURCE_UNSUPPORTED', '本批只支持单材料/单来源小切片；不把多来源压成 first。');
    }
    const source = refs.sourceRefs[0];
    validateSourceRef(source);
    assertKnownR1Source(source);
    if (refs.materialIds.length === 1) {
      const material = this.db.prepare("SELECT envelope_json FROM material_objects WHERE material_id=?").get(refs.materialIds[0]) as WfdRecord | undefined;
      if (!material) fail('R1_MATERIAL_NOT_FOUND', 'BD 材料不存在：' + refs.materialIds[0]);
      const envelope = JSON.parse(String(material.envelope_json)) as WfdRecord;
      if (String(envelope.sha256 ?? '') !== source.sha256) fail('R1_SOURCE_MISMATCH', '材料摘要与来源引用不同。');
      if (Number(envelope.byteLength) !== source.bytes) fail('R1_SOURCE_BYTES_MISMATCH', '材料字节数与来源引用不同。');
      if (!this.options.materials) fail('R1_MATERIAL_READER_UNBOUND', '没有材料读取器，不能用 materialId 冒充已核对。');
      const original = this.options.materials.readOriginal(refs.materialIds[0]);
      if (original.sha256 !== source.sha256) fail('R1_MATERIAL_CHANGED', '材料原件摘要与来源引用不同。');
    } else {
      const originalId = refs.originalIds[0];
      const original = this.db.prepare(`SELECT o.sha256,c.original_bytes,length(c.original_bytes) bytes,o.source_json,o.source_digest
        FROM r1_originals o JOIN r1_original_contents c ON c.sha256=o.sha256 WHERE o.original_id=?`)
        .get(originalId) as WfdRecord | undefined;
      if (!original) fail('R1_ORIGINAL_NOT_FOUND', 'BD 原件未登记或已丢失。');
      if (String(original.sha256) !== source.sha256 || wfdSha256(original.original_bytes as Uint8Array) !== source.sha256) fail('R1_SOURCE_MISMATCH', 'BD 原件实际摘要与来源引用不同。');
      if (Number(original.bytes) !== source.bytes) fail('R1_SOURCE_BYTES_MISMATCH', 'BD 原件字节数与来源引用不同。');
      verifyCanonicalDigest(String(original.source_json), String(original.source_digest), 'R1_SOURCE_CHANGED');
      const storedSource = JSON.parse(String(original.source_json)) as R1SourceRef;
      if (canonicalWfdJson(storedSource) !== canonicalWfdJson(source)) fail('R1_SOURCE_CHANGED', '来源引用与 BD 保存来源不同。');
    }
    if (refs.fixedAlgorithm) {
      if (!this.options.verifyFixedDerived || refs.processRefs.length !== 0
        || refs.originalIds.length !== 1 || refs.materialIds.length !== 0
        || refs.evidenceRefs.length !== 1 || refs.evidenceRefs[0]?.content_sha256 !== source.sha256
        || refs.evidenceRefs[0]?.kind !== 'fixed-algorithm-output')
        fail('R1_DERIVED_PROOF_INVALID', '固定算法派生交接必须只有原任务的独立核验证明，不接受外加加工引用。');
      this.options.verifyFixedDerived(refs, documentSha256);
      return;
    }
    const allowedEvidence = new Set([source.sha256, documentSha256]);
    if (!refs.processRefs.length) fail('R1_PROCESS_REQUIRED', '至少需要一个真实加工引用。');
    for (const process of refs.processRefs) {
      if (!process || !process.process_id || !process.version || !process.plan_id || !process.output_id) {
        fail('R1_PROCESS_REFERENCE_REQUIRED', '实际加工必须引用既有 process_id/version/plan_id/output_id。');
      }
      if (stripSha(process.input_sha256) !== source.sha256) fail('R1_PROCESS_INPUT_MISMATCH', '加工输入摘要不是该原件。');
      const processing = this.options.processing;
      if (!processing) fail('R1_PROCESS_NOT_FOUND', '实际加工服务没有装配，无法核验原计划与输出。');
      let actual: { bytes: Buffer }, plan: WfdRecord;
      try {
        plan = asRecord(processing.get(process.plan_id));
        actual = processing.outputArtifact(process.plan_id, process.output_id);
      } catch (error) { fail('R1_PROCESS_NOT_FOUND', '实际加工服务中没有该固定计划/输出：' + (error instanceof Error ? error.message : String(error))); }
      if (typeof plan.version !== 'string' || process.version !== plan.version) fail('R1_PROCESS_VERSION_MISMATCH', '加工引用版本与实际冻结计划不同；不接受任意非空版本标签。');
      const output = (Array.isArray(plan.outputs) ? plan.outputs : []).map(asRecord).find(item => item.outputId === process.output_id);
      const materials = (Array.isArray(plan.materials) ? plan.materials : []).map(asRecord);
      if (plan.planId !== process.plan_id || !output || output.state !== 'structured'
        || !materials.some(item => item.sha256 === source.sha256 && Array.isArray(output.materialIds) && output.materialIds.includes(item.materialId))) {
        fail('R1_PROCESS_INPUT_MISMATCH', '固定计划输出没有绑定该真实原件，或尚未完成结构化。');
      }
      if (output.publishEligible !== true || output.routingState !== 'ready_candidate') fail('R1_PROCESS_NOT_READY', '该加工输出未通过用途、语义维度及目标门槛；结构检查成功不等于可提交。');
      const actualDigest = wfdSha256(actual.bytes);
      if (actualDigest !== stripSha(process.output_sha256)) fail('R1_PROCESS_OUTPUT_MISMATCH', '实际加工输出字节摘要与引用不同。');
      if (!process.document_sha256 || stripSha(process.document_sha256) !== documentSha256) fail('R1_PROCESS_DOCUMENT_MISMATCH', '加工引用未绑定本 R1 文档摘要。');
      if (![actualDigest, source.sha256, documentSha256].includes(stripSha(process.evidence_sha256))) fail('R1_PROCESS_EVIDENCE_MISMATCH', '加工证据必须对应已核对的原件、产物或交接文档。');
      allowedEvidence.add(actualDigest);
    }
    if (!refs.evidenceRefs.length) fail('R1_EVIDENCE_REQUIRED', '至少需要一个真实证据引用。');
    for (const evidence of refs.evidenceRefs) {
      const digest = stripSha(evidence?.content_sha256);
      if (!evidence?.ref_id || !evidence.kind || !allowedEvidence.has(digest)) fail('R1_EVIDENCE_MISMATCH', '证据摘要没有对应已核对的原件或实际加工产物。');
      if (this.options.candidates && digest !== source.sha256 && digest !== documentSha256) {
        const row = this.db.prepare('SELECT byte_length FROM candidate_objects WHERE sha256=?').get(digest) as { byte_length?: number } | undefined;
        if (!row || !Number.isSafeInteger(Number(row.byte_length))) fail('R1_EVIDENCE_NOT_FOUND', '候选对象中没有该证据摘要：' + digest);
        const ref = { kind: 'stored-object' as const, sha256: digest, byte_length: Number(row.byte_length), media_type: 'application/octet-stream' };
        if (!this.options.candidates.verifyObject(ref) || wfdSha256(this.options.candidates.objectBytes(ref)) !== digest) fail('R1_EVIDENCE_CHANGED', '候选证据对象字节或摘要不符。');
      }
    }
  }

}

/** 构造 data-only 文档；不接收 source_bundle/证据/路径/执行 lineage。 */
export function buildStructuredIngestDocument(input: R1StructuredRequest): WfdRecord {
  const document: WfdRecord = {
    protocol_version: R1_PROTOCOL,
    request_identity: {
      dataset_id: input.datasetId,
      trusted_actor_namespace: input.namespace,
      request_id: input.requestId,
      submission_digest: input.submissionDigest,
    },
    intent: 'submit',
    producer_namespace: input.producerNamespace,
    expected_parent_snapshot_id: input.expectedParentSnapshotId,
    outputs: [{
      output_key: input.outputKey,
      logical_domain: 'observations',
      subject: input.subject,
      definition_mode: input.definitionMode ?? 'create',
      definition_ref: input.definitionMode === 'reuse' ? input.definitionRef ?? null : null,
      definition: input.definitionMode === 'reuse' ? null : input.definition,
      input_mode: input.inputMode,
      coverage: input.coverage,
      payload: input.payload,
      ...(input.revisions ? { revisions: input.revisions } : {}),
    }],
    ...(input.consistencyGroups ? { consistency_groups: input.consistencyGroups } : {}),
    ...(input.duplicatePolicy ? { duplicate_policy: input.duplicatePolicy } : {}),
  };
  assertDataOnly(document);
  return document;
}

const FORBIDDEN_KEYS = new Set(['source_bundle', 'source_ids', 'source_id', 'source_roles', 'evidence_refs', 'evidence',
  'trace', 'lineage', 'material_id', 'material_ids', 'original_path', 'path', 'local_path', 'process_refs',
  'execution', 'code', 'method', 'method_id', 'parameters', 'parameter_digest', 'bd_ref', 'bd_locator',
  'record_locator', 'locator', 'url', 'provider', 'license']);
function assertDataOnly(value: unknown, path = '$'): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertDataOnly(item, `${path}[${index}]`)); return; }
  if (!isWfdRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    // payload.rows[*].values 是业务值字段，codes/path 等是数据，不是执行 lineage；
    // 仅 top-level/metadata sections 拒绝外部元数据。
    if (key === 'values' && path.includes('.payload.rows[')) continue;
    if (FORBIDDEN_KEYS.has(key)) fail('R1_DATA_ONLY_VIOLATION', `data-only 文档不允许 ${path}.${key}；BD 外部信息必须留在 BD。`);
    assertDataOnly(item, `${path}.${key}`);
  }
}

/** 新 data-only 客户端：只暴露 submit/fixed_read/request_status/read_product；不暴露 evidence/trace。 */
export class WfdStructuredIngestClient {
  private readonly checker: { Check(value: unknown): boolean } | null;
  private readonly schemaSha256: string | null;
  private negotiatedReadPageSize = 256;
  constructor(private readonly client: WfdProductMachineClient, schemaPath?: string) {
    if (schemaPath) {
      const compiled = compilePublicSchema(schemaPath);
      this.checker = compiled.checker;
      this.schemaSha256 = compiled.schemaSha256;
    } else {
      this.checker = null;
      this.schemaSha256 = null;
    }
  }
  async probeProfile(signal?: AbortSignal): Promise<R1ProfileProbe> {
    const caps = await this.client.capabilities(signal);
    const result = caps.result;
    const serviceCaps = isWfdRecord(result.service_capabilities) ? result.service_capabilities : {};
    const submit = isWfdRecord(serviceCaps.operations) && isWfdRecord(serviceCaps.operations.submit)
      ? serviceCaps.operations.submit : {};
    const structured = typeof serviceCaps.structured_ingest === 'string' ? serviceCaps.structured_ingest : null;
    const submitProtocol = typeof submit.protocol === 'string' ? submit.protocol : null;
    const supported = result.profile === 'data_only' && structured === R1_PROTOCOL && submitProtocol === R1_PROTOCOL;
    return { supported, reason: supported ? null : 'WFD capabilities do not advertise profile=data_only with structured-ingest/1.0 submit',
      serviceVersion: isWfdRecord(caps.response.service) && typeof caps.response.service.service_version === 'string'
        ? caps.response.service.service_version : null,
      advertised: { profile: result.profile ?? null, structured_ingest: structured, submit_protocol: submitProtocol,
        fixed_read_page: isWfdRecord(serviceCaps.operations) && isWfdRecord(serviceCaps.operations.fixed_read_page)
          ? serviceCaps.operations.fixed_read_page : null } };
  }
  async submit(document: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    assertDataOnly(document);
    if (document.protocol_version !== R1_PROTOCOL) fail('R1_PROTOCOL', '新 data-only 流程只接受 wfd.structured-ingest/1.0。');
    if (!this.checker || !this.schemaSha256) fail('R1_SCHEMA_REQUIRED', 'data-only 客户端必须绑定公开 structured-ingest schema。');
    if (!this.checker.Check(document)) fail('R1_SCHEMA_INVALID', 'data-only 文档不符合已绑定的公开 structured-ingest schema。');
    const probe = await this.probeProfile(signal);
    if (!probe.supported) throw new WfdProductMachineError('WFD_STRUCTURED_PROFILE_UNAVAILABLE',
      'WFD 尚未公开 data_only/structured-ingest profile；未发送提交，不假称成功。', {
        operation: 'submit', requestId: 'r1-profile', remoteCode: 'WFD_STRUCTURED_PROFILE_UNAVAILABLE',
      });
    return this.client.submit(document, signal);
  }
  async pageReadSupport(document: WfdRecord, signal?: AbortSignal): Promise<boolean> {
    const probe = await this.probeProfile(signal), page = asRecord(probe.advertised.fixed_read_page);
    const maxSize=asRecord(page.page_size).max;
    this.negotiatedReadPageSize = typeof maxSize==='number' && Number.isSafeInteger(maxSize) && maxSize>=1000 ? 1000 : 256;
    if (!probe.supported || page.supported !== true || page.format_version !== R1_READ_PAGE_FORMAT) return false;
    const output = Array.isArray(document.outputs) ? asRecord(document.outputs[0]) : {};
    const kind = asRecord(output.payload).kind;
    if (!['scalar_rows','tabular_rows'].includes(String(kind)) || kind === 'tabular_rows'
      && (!Array.isArray(page.payload_kinds) || !page.payload_kinds.includes('tabular_rows'))
      || !isWfdRecord(output.definition) || output.definition_mode === 'reuse') return false;
    const definition = output.definition, base = asRecord(asRecord(definition.semantic_context).time);
    if (String(definition.semantic_code ?? '').startsWith('wfd.foundation.calendar.')) return false;
    const times = [base, ...Object.values(asRecord(definition.field_semantic_context)).map(value => ({ ...base, ...asRecord(asRecord(value).time) }))];
    // Negotiate an unsupported scope before the first read, never as a page-error fallback.
    return !times.some(time => (time.calendar_ref !== undefined && time.calendar_ref !== null)
      || (time.accounting_calendar_ref !== undefined && time.accounting_calendar_ref !== null)
      || ['trading', 'accounting'].includes(String(time.period_type)));
  }
  pageReadSize():number { return this.negotiatedReadPageSize; }
  async resumeAccepted(document:WfdRecord,signal?:AbortSignal):Promise<WfdProductMachineReply> {
    assertDataOnly(document);
    const identity=asRecord(document.request_identity),status=(await this.client.requestStatusPage(identity,
      {outputOffset:0,outputLimit:50,outputDetail:'full'},signal)).result;
    if(status.state!=='accepted_not_published'||canonicalWfdJson(status.request_identity)!==canonicalWfdJson(identity)
      ||status.input_fingerprint!==wfdSha256(canonicalWfdJson(document)))
      fail('R1_ORIGINAL_NOT_ACCEPTED','只有受信原intent已持久受理且文档摘要完全一致，才可明确续办；未知不重投。');
    const head=(await this.client.snapshotStatus(signal)).result;
    if(head.snapshot_id!==document.expected_parent_snapshot_id)fail('R1_RESUME_PARENT_CHANGED','当前HEAD与原文档冻结的父快照不同，未改父版本续办。');
    return this.client.recovery(document,signal);
  }
  fixedReadPage(options: WfdProductMachineReadPageOptions, signal?: AbortSignal) { return this.client.readPage(options, signal); }
  fixedReadHistory(snapshotId: string, productId: string, signal?: AbortSignal) {
    return this.client.read({ snapshotId, productId, perspective: 'snapshot_contents', includeHistory: true, rowProjection: 'full' }, signal);
  }
  fixedRead(snapshotId: string, productId?: string, signal?: AbortSignal) {
    return this.client.read({ snapshotId, productId, rowProjection: 'full' }, signal);
  }
  requestStatus(identity: WfdRecord, signal?: AbortSignal) { return this.client.requestStatus(identity, signal); }
  usageStatus(signal?: AbortSignal) { return this.client.usageStatus(signal); }
  requestStatusPage(identity: WfdRecord, options: { outputOffset?: number; outputLimit?: number;
    outputDetail?: 'summary' | 'full'; rowOffset?: number; rowLimit?: number } = {}, signal?: AbortSignal) {
    return this.client.requestStatusPage(identity, options, signal);
  }
  readContext(operation: import('../../contracts/r1-contracts.js').R1ContextOperation, request: WfdRecord, signal?: AbortSignal) { return this.client.readContext(operation, request, signal); }
  readProduct(request: WfdRecord, signal?: AbortSignal) { return this.client.readProduct(request, signal); }
  filterObjects(request: import('../../adapters/database/wfd-product-machine.js').WfdFilterPlan, signal?: AbortSignal) {
    return this.client.filterObjects(request, signal);
  }
  reviewDefinition(intent: import('../../contracts/r1-contracts.js').R1DefinitionIntent, signal?: AbortSignal) {
    return this.client.reviewDefinition(intent, signal);
  }
  snapshotStatus(signal?: AbortSignal) { return this.client.snapshotStatus(signal); }
  contractDiscovery(snapshotId: string, signal?: AbortSignal) { return this.client.discover(snapshotId, undefined, signal); }
}

/** 公开 schema 校验；不读取 WFD 私有 catalog。 */
export function validateStructuredDocument(document: WfdRecord, schemaPath: string): { valid: boolean; schemaSha256: string } {
  const compiled = compilePublicSchema(schemaPath);
  if (!compiled.checker.Check(document)) fail('R1_SCHEMA_INVALID', 'data-only 文档不符合公开 structured-ingest schema。');
  return { valid: true, schemaSha256: compiled.schemaSha256 };
}
function compilePublicSchema(schemaPath: string): { checker: { Check(value: unknown): boolean }; schemaSha256: string } {
  if (!isAbsolute(schemaPath)) fail('R1_SCHEMA_PATH', 'schemaPath 必须是绝对路径。');
  const raw = readFileSync(schemaPath);
  const schema = JSON.parse(raw.toString('utf8')) as WfdRecord;
  if (schema.$id !== 'https://wfd.example/spec/1.0/wfd-structured-ingest.schema.json') fail('R1_SCHEMA_ID', '不是公开 structured-ingest schema。');
  return { checker: Schema.Compile(schema as never) as { Check(value: unknown): boolean },
    schemaSha256: 'sha256:' + wfdSha256(raw) };
}

function verifyCanonicalDigest(value: string, expected: string, code: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TaskError(code, '持久内容不是有效 JSON。'); }
  if (wfdSha256(canonicalWfdJson(parsed)) !== expected) throw new TaskError(code, '持久内容摘要与保存时不同。');
}
export function validateSourceRef(source: R1SourceRef): void {
  if (!source || typeof source !== 'object') fail('R1_SOURCE_INVALID', '来源声明必须是对象。');
  for (const key of ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope'] as const) {
    if (typeof source[key] !== 'string' || !source[key].trim() || source[key].length > 4096 || /[\u0000-\u001f]/u.test(source[key])) fail('R1_SOURCE_INVALID', '来源字段缺失或越界：' + key);
  }
  if (source.license !== undefined && (typeof source.license !== 'string' || source.license.length > 4096
    || /[\u0000-\u001f]/u.test(source.license))) fail('R1_SOURCE_INVALID', '旧来源许可文字格式无效。');
  if (!/^[a-f0-9]{64}$/u.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes < 1) fail('R1_SOURCE_INVALID', '来源摘要或字节数无效。');
  if (source.authorization !== undefined && !validR1Authorization(source.authorization)) fail('R1_SOURCE_INVALID', '来源授权声明格式无效。');
  const requested = parseR1Utc(source.requested_at_utc), acquired = parseR1Utc(source.acquired_at_utc);
  if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested) fail('R1_SOURCE_TIME', '来源需要实际有效的 UTC 请求/取得时间（最多三位小数），取得时间不能早于请求。');
}

/** 操作者明确采用的来源事实门禁；不签发独立许可真实性结论。 */
export function assertKnownR1Source(source: Pick<R1SourceRef, 'source_id' | 'provider' | 'requested_url' | 'usage_scope' | 'authorization'>): void {
  const gaps = r1SourceGaps(source);
  if (gaps.length) fail(r1SourceDenied(source) ? 'R1_SOURCE_DENIED' : 'R1_SOURCE_UNKNOWN', gaps.join('；'));
}

/** An explicit registration result is not a publication. Compact summaries cannot prove zero records. */
function isExplicitRegisteredNotPublished(result: WfdRecord, document: WfdRecord): boolean {
  if (result.state !== 'registered_not_published' || result.snapshot_id !== null || result.formal_publication_verified !== false
    || result.formal_publication_ref || result.formal_publication_receipt || result.formal_publication
    || (isWfdRecord(result.persistent_receipt) && result.persistent_receipt.formal_publication_ref)
    || !Array.isArray(result.output_results) || !Array.isArray(document.outputs)) return false;
  const expected = document.outputs.map(output => asRecord(output).output_key), outputs = result.output_results;
  if (!expected.length || new Set(expected).size !== expected.length || outputs.length !== expected.length
    || (result.outputs_total !== undefined && result.outputs_total !== expected.length)
    || (result.outputs_included !== undefined && result.outputs_included !== outputs.length)
    || result.outputs_complete === false || (result.outputs_offset !== undefined && result.outputs_offset !== 0)
    || (result.outputs_remaining !== undefined && result.outputs_remaining !== 0) || result.has_more === true || result.continuation
    || (isWfdRecord(result.pagination) && (result.pagination.has_more === true
      || (result.pagination.offset !== undefined && result.pagination.offset !== 0)))) return false;
  // The machine's summary projection intentionally drops records and full errors.
  if ((result.bounded === true || result.view === 'bounded_page' || result.receipts_compacted === true)
    && (!isWfdRecord(result.pagination) || result.pagination.detail !== 'full' || result.outputs_complete !== true)) return false;
  if (isWfdRecord(result.publication_summary) && Object.entries(result.publication_summary)
    .some(([key, value]) => key !== 'not_published' && value !== 0)) return false;
  const actual = outputs.map(output => asRecord(output).output_key);
  if (new Set(actual).size !== expected.length || actual.some(key => !expected.includes(key))) return false;
  let registered = false;
  for (const value of outputs) {
    if (!isWfdRecord(value) || value.publication_state !== 'not_published'
      || !['registered', 'reused', 'not_registered'].includes(String(value.registration_state))
      || (value.snapshot_id !== undefined && value.snapshot_id !== null)
      || (value.engine_publication_state !== undefined && value.engine_publication_state !== null
        && !['not_published', 'not_reached'].includes(String(value.engine_publication_state)))
      || (value.records !== undefined && (!Array.isArray(value.records) || value.records.length !== 0))
      || !Array.isArray(value.errors) || !value.errors.length || value.errors.some(error => !isWfdRecord(error)
        || typeof error.code !== 'string' || !error.code.trim() || typeof error.message !== 'string' || !error.message.trim())) return false;
    if (['registered', 'reused'].includes(String(value.registration_state))) {
      if (typeof value.product_id !== 'string' || !value.product_id || !isWfdRecord(value.definition_ref)
        || typeof value.definition_ref.id !== 'string' || !value.definition_ref.id
        || typeof value.definition_ref.digest !== 'string' || !value.definition_ref.digest) return false;
      registered = true;
    }
  }
  return registered;
}

function isTerminalWfdRejection(result: WfdRecord, document: WfdRecord): boolean {
  if (isExplicitRegisteredNotPublished(result, document)) return true;
  if (result.state !== 'rejected') return false;
  const outputs = Array.isArray(result.output_results) ? result.output_results : [];
  if (typeof result.outputs_total === 'number' && result.outputs_total > outputs.length) return false;
  if (result.outputs_complete === false || (isWfdRecord(result.pagination) && result.pagination.has_more === true)) return false;
  if (outputs.some(output => {
    const row = asRecord(output);
    return row.publication_state === 'published_formal' || row.publication_state === 'published_sandbox'
      || (Array.isArray(row.records) && row.records.length > 0);
  })) return false;
  return true;
}

function asRecord(value: unknown): WfdRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WfdRecord : {};
}
function stripSha(value: string): string { return String(value ?? '').replace(/^sha256:/u, ''); }
function fail(code: string, message: string): never { throw new TaskError(code, message); }

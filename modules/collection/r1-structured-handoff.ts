import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CoreDatabase } from '../../platform/state/database.js';
import { WfdProductMachineClient, WfdProductMachineError, type WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import Schema from 'typebox/schema';

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
  license: string;
  usage_scope: string;
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
  consistencyGroups?: WfdRecord;
}
export interface R1ReceiptRow {
  business_key: string;
  record_id: string;
  record_version: string;
}
export interface R1Receipt {
  dataset_id: string;
  output_key: string;
  product_id: string;
  definition_digest: string;
  snapshot_id: string;
  request_identity: WfdRecord;
  rows: R1ReceiptRow[];
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

export class R1HandoffService {
  constructor(private readonly options: { database: CoreDatabase; materials?: {
    get(id: string): { envelope: { sha256: string; filename: string; mediaType: string } };
    readOriginal(id: string): { bytes: Buffer; sha256: string };
  }; processing?: { get(planId: string): unknown; outputArtifact(planId: string, outputId: string): { bytes: Buffer } };
    candidates?: { verifyObject(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): boolean;
      objectBytes(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): Buffer } }) {
    options.database.migrate('r1-structured-handoff', 1, SCHEMA);
  }
  private get db() { return this.options.database.connection; }

  registerOriginal(input: { bytes: Uint8Array; originalName: string; mediaType?: string; source: R1SourceRef }): { originalId: string; sha256: string } {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) fail('R1_ORIGINAL_EMPTY', 'BD 原件必须是非空字节。');
    const digest = wfdSha256(input.bytes);
    if (digest !== input.source.sha256) fail('R1_SOURCE_SHA_MISMATCH', 'BD 原件摘要与来源声明不同，禁止写入关联。');
    const existing = this.db.prepare('SELECT original_id FROM r1_originals WHERE sha256=?').get(digest) as { original_id: string } | undefined;
    if (existing) return { originalId: String(existing.original_id), sha256: digest };
    const originalId = 'bd-original:' + randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO r1_originals VALUES(?,?,?,?,?,?,?,?)').run(
      originalId, digest, input.originalName, input.mediaType ?? 'application/octet-stream',
      JSON.stringify(input.source), wfdSha256(canonicalWfdJson(input.source)), input.bytes, now);
    return { originalId, sha256: digest };
  }

  prepare(input: { structured: R1StructuredRequest; localRefs: R1LocalReferences }): R1PrepareResult {
    const document = buildStructuredIngestDocument(input.structured);
    assertDataOnly(document);
    const documentSha256 = wfdSha256(canonicalWfdJson(document));
    this.assertLocalRefs(input.localRefs, documentSha256);
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
    this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_wfd_profile',error_json=?,updated_at=? WHERE request_id=?")
      .run(canonicalWfdJson({ code, message }), Date.now(), requestId);
  }

  /** 受控地重新取实际 fixed_read；不接受调用者拼接的 verified rows。 */
  async recordReceipt(requestId: string, receipt: R1Receipt,
    client: WfdStructuredIngestClient): Promise<{ state: string; associated: number; pending: number; errors: string[] }> {
    let fixed: WfdProductMachineReply;
    try {
      fixed = await client.fixedRead(receipt.snapshot_id, receipt.product_id);
    } catch (error) {
      const errors = ['fixed_read_failed:' + (typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code) : 'WFD_PRODUCT_MACHINE_ERROR')];
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(receipt.rows?.length ?? 1, canonicalWfdJson({ code: 'R1_FIXED_READ_FAILED', errors }), Date.now(), requestId);
      return { state: 'pending_receipt', associated: 0, pending: receipt.rows?.length ?? 1, errors };
    }
    return this.associateVerifiedReceipt(requestId, receipt, (Array.isArray(fixed.result.rows) ? fixed.result.rows : []).map(asRecord));
  }

  /** 只接受经实际 fixed_read 核对的逐行身份；缺一/错一即 pending，不插 association。 */
  private associateVerifiedReceipt(requestId: string, receipt: R1Receipt, verifiedFixedRows: WfdRecord[]): {
    state: string; associated: number; pending: number; errors: string[]
  } {
    const attempt = this.attempt(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const output = ((document.outputs as unknown[])[0] ?? {}) as WfdRecord;
    const payload = isWfdRecord(output.payload) ? output.payload : {};
    const expectedKeys = new Set((Array.isArray(payload.rows) ? payload.rows : [])
      .map(value => isWfdRecord(value) && typeof value.business_key === 'string' ? value.business_key : '')
      .filter(Boolean));
    const errors: string[] = [];
    if (!isWfdRecord(receipt)) fail('R1_RECEIPT_INVALID', 'WFD 回执必须是对象。');
    for (const key of ['dataset_id', 'output_key', 'product_id', 'definition_digest', 'snapshot_id'] as const) {
      if (typeof receipt[key] !== 'string' || !receipt[key]) errors.push(`missing:${key}`);
    }
    if (receipt.dataset_id !== attempt.dataset_id) errors.push('dataset_id:mismatch');
    const attemptIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    if (!isWfdRecord(receipt.request_identity)
      || canonicalWfdJson(receipt.request_identity) !== canonicalWfdJson(attemptIdentity)) {
      errors.push('request_identity:mismatch');
    }
    if (receipt.output_key !== output.output_key) errors.push('output_key:mismatch');
    if (!Array.isArray(verifiedFixedRows) || verifiedFixedRows.length === 0) errors.push('missing:verified_fixed_read');
    if (!Array.isArray(receipt.rows) || receipt.rows.length === 0) errors.push('missing:rows');
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
    const expectedRows = new Map<string, WfdRecord>();
    for (const value of (Array.isArray(payload.rows) ? payload.rows : [])) {
      if (isWfdRecord(value) && typeof value.business_key === 'string') expectedRows.set(value.business_key, value);
    }
    const seen = new Set<string>();
    const byKey = new Map(fixed.map(item => [item.businessKey, item]));
    const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (const [index, value] of rows.entries()) {
      const row = asRecord(value);
      const expected = expectedRows.get(String(row.business_key ?? ''));
      const actual = fixed.find(item => item.businessKey === row.business_key);
      if (!expected || !actual) continue;
      for (const key of ['value_decimal', 'value_state', 'observation_time', 'values']) {
        if (!Object.hasOwn(expected, key)) continue;
        const expectedValue = expected[key];
        const actualValue = asRecord(asRecord(actual.row).row)[key];
        if (expectedValue === undefined || actualValue === undefined
          || canonicalWfdJson(expectedValue) !== canonicalWfdJson(actualValue)) {
          errors.push(`row:${index}:business_content:${key}`);
        }
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
    if (attempt.state === 'associated' && attempt.receipt_json && attempt.receipt_json !== canonicalWfdJson(receipt)) {
      fail('R1_RECEIPT_CONFLICT', '同一 request 已关联不同 WFD 回执；拒绝改写。');
    }
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    const originalId = refs.originalIds[0] ?? refs.materialIds[0];
    const sourceId = refs.sourceRefs[0]?.source_id;
    if (!originalId || !sourceId) fail('R1_LOCAL_REFERENCE', '关联需要 BD 原件与来源引用。');
    let associated = 0;
    this.options.database.transaction(() => {
      for (const row of rows) {
        const result = this.db.prepare(`INSERT INTO r1_record_associations
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,product_id,record_id,record_version) DO NOTHING`).run(
          receipt.dataset_id, receipt.product_id, receipt.definition_digest, receipt.snapshot_id,
          row.record_id, row.record_version, requestId, originalId, sourceId,
          canonicalWfdJson(refs.processRefs), canonicalWfdJson(refs.evidenceRefs), Date.now());
        associated += Number(result.changes ?? 0);
      }
      this.db.prepare("UPDATE r1_handoff_attempts SET state='associated',receipt_json=?,pending_count=0,error_json=NULL,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(receipt), Date.now(), requestId);
    });
    return { state: 'associated', associated, pending: 0, errors: [] };
  }

  markSending(requestId: string): void {
    this.db.prepare("UPDATE r1_handoff_attempts SET state='sending',error_json=NULL,updated_at=? WHERE request_id=?")
      .run(Date.now(), requestId);
  }

  /** 实际 submit 结果 → 逐输出 records → 实际 fixed_read → 逐行关联。 */
  async submitAndAssociate(requestId: string, client: WfdStructuredIngestClient): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    if (attempt.state === 'associated') return this.localExplanation(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    this.markSending(requestId);
    let reply: WfdProductMachineReply;
    try {
      reply = await client.submit(document);
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
      return await this.consumeResult(requestId, reply.result, client);
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'R1_CONSUME_FAILED';
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(reply.result), canonicalWfdJson({ code,
          request_identity: document.request_identity ?? null,
          message: error instanceof Error ? error.message : String(error) }), Date.now(), requestId);
      return { state: 'pending_receipt', code, recovery: 'query_same_request_status_then_consume' };
    }
  }

  async consumeResult(requestId: string, result: WfdRecord, client: WfdStructuredIngestClient): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    if (attempt.state === 'associated') return this.localExplanation(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const expectedIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    if (!isWfdRecord(result.request_identity)
      || canonicalWfdJson(result.request_identity) !== canonicalWfdJson(expectedIdentity)) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson({ code: 'R1_RESULT_IDENTITY_MISMATCH' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_RESULT_IDENTITY_MISMATCH'] };
    }
    const state = typeof result.state === 'string' ? result.state : 'unknown';
    if (state !== 'published_formal' || !Array.isArray(result.output_results) || result.output_results.length !== 1) {
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
    if (!records.length || !snapshotId || !productId || !definitionDigest) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), 1, canonicalWfdJson({ code: 'R1_RECORDS_INCOMPLETE' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_RECORDS_INCOMPLETE'] };
    }
    const fixed = await client.fixedRead(snapshotId, productId);
    const fixedRows = Array.isArray(fixed.result.rows) ? fixed.result.rows.map(asRecord) : [];
    if (!isWfdRecord(result.request_identity)) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',receipt_json=?,pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(canonicalWfdJson(result), 1, canonicalWfdJson({ code: 'R1_REQUEST_IDENTITY_MISSING' }), Date.now(), requestId);
      return { state: 'pending_receipt', errors: ['R1_REQUEST_IDENTITY_MISSING'] };
    }
    const receipt: R1Receipt = {
      dataset_id: String(attempt.dataset_id),
      output_key: typeof output.output_key === 'string' ? output.output_key : '',
      product_id: productId,
      definition_digest: definitionDigest,
      snapshot_id: snapshotId,
      request_identity: result.request_identity,
      rows: records.map(record => ({
        business_key: typeof record.record_id === 'string' ? record.record_id : '',
        record_id: typeof record.record_id === 'string' ? record.record_id : '',
        record_version: typeof record.record_version === 'string' ? record.record_version : '',
      })),
    };
    return this.associateVerifiedReceipt(requestId, receipt, fixedRows);
  }

  attempt(requestId: string): WfdRecord {
    const row = this.db.prepare('SELECT * FROM r1_handoff_attempts WHERE request_id=?').get(requestId) as WfdRecord | undefined;
    if (!row) throw new TaskError('R1_ATTEMPT_NOT_FOUND', '没有该 R1 交接 attempt；不能用快照号或新请求代替。');
    verifyCanonicalDigest(String(row.document_json), String(row.document_sha256), 'R1_DOCUMENT_CHANGED');
    verifyCanonicalDigest(String(row.local_refs_json), String(row.local_refs_sha256), 'R1_LOCAL_REFS_CHANGED');
    return structuredClone(row);
  }

  localExplanation(requestId: string): WfdRecord {
    const attempt = this.attempt(requestId);
    const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
    const originals = refs.originalIds.map(originalId => {
      const row = this.db.prepare('SELECT original_id,sha256,original_name,source_json,source_digest FROM r1_originals WHERE original_id=?').get(originalId) as WfdRecord | undefined;
      if (!row) fail('R1_ORIGINAL_NOT_FOUND', 'BD 原件关联丢失。');
      verifyCanonicalDigest(String(row.source_json), String(row.source_digest), 'R1_SOURCE_CHANGED');
      return row;
    });
    const associations = this.db.prepare('SELECT * FROM r1_record_associations WHERE request_id=? ORDER BY product_id,record_id,record_version').all(requestId);
    return { state: attempt.state, request_id: requestId, local_refs: refs, originals, associations,
      note: 'BD 可在 WFD 不可用时独立解释该 request 的原件/来源/加工/证据；association 为空时未拿到实际 WFD 行身份。' };
  }

  /** 同 request_identity 分页读取状态；保留真实状态/identity，只完整 formal 才关联。 */
  async recoverStatus(requestId: string, client: WfdStructuredIngestClient): Promise<WfdRecord> {
    const attempt = this.attempt(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const expectedIdentity = isWfdRecord(document.request_identity) ? document.request_identity : {};
    const collected: WfdRecord[] = [];
    let offset = 0, pages = 0, lastState = 'unknown', outputsTotal = 0, outputsComplete = false;
    for (; pages < 100; pages += 1) {
      const reply = await client.requestStatusPage(expectedIdentity,
        { outputOffset: offset, outputLimit: 50, outputDetail: 'full' });
      const result = reply.result;
      const pageState = typeof result.state === 'string' ? result.state : 'unknown';
      lastState = pageState;
      const actualIdentity = isWfdRecord(result.request_identity) ? result.request_identity : {};
      if (canonicalWfdJson(actualIdentity) !== canonicalWfdJson(expectedIdentity)) {
        this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',error_json=?,updated_at=? WHERE request_id=?")
          .run(canonicalWfdJson({ code: 'R1_RECOVERY_IDENTITY_MISMATCH',
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
    if (attempt.state === 'associated') {
      const conflicts: string[] = [];
      if (lastState !== 'published_formal') conflicts.push('associated_but_status_not_formal:' + lastState);
      if (!allFormal) conflicts.push('associated_but_outputs_not_formal');
      if (outputsTotal !== collected.length) conflicts.push(`associated_outputs_partial:${collected.length}/${outputsTotal}`);
      return { state: 'associated', wfd_state: lastState,
        reconciliation: conflicts.length ? 'conflict_preserved_original_association' : 'consistent',
        conflicts, associations: (Array.isArray(this.localExplanation(requestId).associations) ? this.localExplanation(requestId).associations as unknown[] : []).length };
    }
    if (lastState !== 'published_formal' || !allFormal || !outputsComplete || collected.length !== outputsTotal) {
      this.db.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt',pending_count=?,error_json=?,updated_at=? WHERE request_id=?")
        .run(Math.max(outputsTotal - collected.length, 1), canonicalWfdJson({
          code: 'R1_RECOVERY_NOT_FORMAL_COMPLETE', wfd_state: lastState,
          output_states: outputStates, collected: collected.length, total: outputsTotal,
          outputs_complete: outputsComplete }), Date.now(), requestId);
      return { state: 'pending_receipt', wfd_state: lastState, outputs: collected.length,
        total: outputsTotal, output_states: outputStates };
    }
    const result = { state: lastState, output_results: collected,
      request_identity: expectedIdentity } as WfdRecord;
    return this.consumeResult(requestId, result, client);
  }

  private assertLocalRefs(refs: R1LocalReferences, documentSha256: string): void {
    if (!refs || !Array.isArray(refs.originalIds) || !Array.isArray(refs.sourceRefs)) {
      fail('R1_LOCAL_REFERENCE', 'R1 需要 BD 原件与来源引用。');
    }
    if (refs.sourceRefs.length !== 1 || refs.originalIds.length + refs.materialIds.length !== 1
      || refs.originalIds.length > 1 || refs.materialIds.length > 1) {
      fail('R1_MULTI_SOURCE_UNSUPPORTED', '本批只支持单材料/单来源小切片；不把多来源压成 first。');
    }
    const source = refs.sourceRefs[0];
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
      const original = this.db.prepare('SELECT sha256,length(original_bytes) bytes,source_json,source_digest FROM r1_originals WHERE original_id=?')
        .get(originalId) as WfdRecord | undefined;
      if (!original) fail('R1_ORIGINAL_NOT_FOUND', 'BD 原件未登记或已丢失。');
      if (String(original.sha256) !== source.sha256) fail('R1_SOURCE_MISMATCH', 'BD 原件摘要与来源引用不同。');
      if (Number(original.bytes) !== source.bytes) fail('R1_SOURCE_BYTES_MISMATCH', 'BD 原件字节数与来源引用不同。');
      verifyCanonicalDigest(String(original.source_json), String(original.source_digest), 'R1_SOURCE_CHANGED');
      const storedSource = JSON.parse(String(original.source_json)) as R1SourceRef;
      if (canonicalWfdJson(storedSource) !== canonicalWfdJson(source)) fail('R1_SOURCE_CHANGED', '来源引用与 BD 保存来源不同。');
    }
    const allowedEvidence = new Set([source.sha256, documentSha256, ...refs.processRefs.map(item => stripSha(item.evidence_sha256)),
      ...refs.processRefs.map(item => stripSha(item.output_sha256))]);
    if (!refs.evidenceRefs.length) fail('R1_EVIDENCE_REQUIRED', '至少需要一个真实证据引用。');
    for (const evidence of refs.evidenceRefs) {
      const digest = stripSha(evidence.content_sha256);
      if (!digest || !allowedEvidence.has(digest)) fail('R1_EVIDENCE_MISMATCH', '证据摘要没有对应原件/加工摘要。');
    }
    if (!refs.processRefs.length) fail('R1_PROCESS_REQUIRED', '至少需要一个真实加工引用。');
    for (const process of refs.processRefs) {
      if (stripSha(process.input_sha256) !== source.sha256) fail('R1_PROCESS_INPUT_MISMATCH', '加工输入摘要不是该原件。');
      if (!this.options.processing && stripSha(process.output_sha256) !== documentSha256) fail('R1_PROCESS_OUTPUT_MISMATCH', '加工输出摘要不是本请求文档。');
      if (!stripSha(process.evidence_sha256)) fail('R1_PROCESS_EVIDENCE_MISSING', '加工证据摘要为空。');
      if (this.options.processing) {
        if (!process.plan_id || !process.output_id) fail('R1_PROCESS_REFERENCE_REQUIRED', '实际加工必须引用既有 plan_id/output_id。');
        let actual: { bytes: Buffer };
        try { actual = this.options.processing.outputArtifact(process.plan_id, process.output_id); }
        catch (error) { fail('R1_PROCESS_NOT_FOUND', 'ProcessingPlanService 中没有该固定计划/输出：' + (error instanceof Error ? error.message : String(error))); }
        if (wfdSha256(actual.bytes) !== stripSha(process.output_sha256)) fail('R1_PROCESS_OUTPUT_MISMATCH', 'ProcessingPlanService 输出字节摘要与引用不同。');
        if (!process.document_sha256 || stripSha(process.document_sha256) !== documentSha256) fail('R1_PROCESS_DOCUMENT_MISMATCH', '加工引用未绑定本 R1 文档摘要。');
      }
    }
    for (const evidence of refs.evidenceRefs) {
      const digest = stripSha(evidence.content_sha256);
      if (this.options.candidates) {
        const row = this.db.prepare('SELECT byte_length FROM candidate_objects WHERE sha256=?').get(digest) as { byte_length?: number } | undefined;
        if (!row || !Number.isSafeInteger(Number(row.byte_length))) fail('R1_EVIDENCE_NOT_FOUND', '候选对象中没有该证据摘要：' + digest);
        const ref = { kind: 'stored-object' as const, sha256: digest, byte_length: Number(row.byte_length), media_type: 'application/octet-stream' };
        if (!this.options.candidates.verifyObject(ref) || wfdSha256(this.options.candidates.objectBytes(ref)) !== digest) {
          fail('R1_EVIDENCE_CHANGED', '候选证据对象字节或摘要不符。');
        }
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
      definition_mode: 'create',
      definition_ref: null,
      definition: input.definition,
      input_mode: input.inputMode,
      coverage: input.coverage,
      payload: input.payload,
    }],
    ...(input.consistencyGroups ? { consistency_groups: input.consistencyGroups } : {}),
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
  async probeProfile(): Promise<R1ProfileProbe> {
    const caps = await this.client.capabilities();
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
      advertised: { profile: result.profile ?? null, structured_ingest: structured, submit_protocol: submitProtocol } };
  }
  async submit(document: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    assertDataOnly(document);
    if (document.protocol_version !== R1_PROTOCOL) fail('R1_PROTOCOL', '新 data-only 流程只接受 wfd.structured-ingest/1.0。');
    if (!this.checker || !this.schemaSha256) fail('R1_SCHEMA_REQUIRED', 'data-only 客户端必须绑定公开 structured-ingest schema。');
    if (!this.checker.Check(document)) fail('R1_SCHEMA_INVALID', 'data-only 文档不符合已绑定的公开 structured-ingest schema。');
    const probe = await this.probeProfile();
    if (!probe.supported) throw new WfdProductMachineError('WFD_STRUCTURED_PROFILE_UNAVAILABLE',
      'WFD 尚未公开 data_only/structured-ingest profile；未发送提交，不假称成功。', {
        operation: 'submit', requestId: 'r1-profile', remoteCode: 'WFD_STRUCTURED_PROFILE_UNAVAILABLE',
      });
    return this.client.submit(document, signal);
  }
  fixedRead(snapshotId: string, productId?: string, signal?: AbortSignal) {
    return this.client.read({ snapshotId, productId, rowProjection: 'full' }, signal);
  }
  requestStatus(identity: WfdRecord, signal?: AbortSignal) { return this.client.requestStatus(identity, signal); }
  requestStatusPage(identity: WfdRecord, options: { outputOffset?: number; outputLimit?: number;
    outputDetail?: 'summary' | 'full' } = {}, signal?: AbortSignal) {
    return this.client.requestStatusPage(identity, options, signal);
  }
  readProduct(request: WfdRecord, signal?: AbortSignal) { return this.client.readProduct(request, signal); }
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
function asRecord(value: unknown): WfdRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WfdRecord : {};
}
function stripSha(value: string): string { return String(value ?? '').replace(/^sha256:/u, ''); }
function fail(code: string, message: string): never { throw new TaskError(code, message); }

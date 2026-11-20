import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { assertBoundG5AdmissionReceipt, G5_ADMISSION_RECEIPT_VERSION, verifyG5AdmissionReceiptDigest,
  type G5AdmissionBinding, type G5AdmissionReceipt } from './g5-admission-receipt.js';
import { declaredSourceSeries } from './r1-evidence.js';
import { R1_READ_LIMITS } from './r1-product-reader.js';
import { knownR1SourceText } from './r1-source.js';
import { profileFingerprint, readSourceFieldProfile, sourceFieldProfileDigest, type SemanticProductRegistryStore,
  type SourceFieldProfile, type SourceFieldProfileStore } from './source-field-profile.js';

export type R1G5History = Map<string, Set<string | undefined>>;

export function addR1G5Source(history: R1G5History, sourceId: string, series?: string): void {
  const scopes = history.get(sourceId) ?? new Set();
  scopes.add(series);
  history.set(sourceId, scopes);
}

/** 与 WFD write_targets.py 的稳定产品身份一致。已核实的修订前驱直接使用正式产品 ID。 */
export function r1G5ProductId(datasetId: string, kind: string, subject: WfdRecord, definition: WfdRecord): string {
  const domain = kind === 'event_records' ? 'events' : kind === 'relation_edges' ? 'foundation' : 'observations';
  const family = 'pf_' + wfdSha256(canonicalWfdJson([datasetId, domain, subject,
    definition.semantic_code ?? null, definition.definition_authority ?? null])).slice(0, 24);
  return 'p_' + wfdSha256(canonicalWfdJson([family, 'stable_product'])).slice(0, 24);
}

type R1G5Target = { kind: string; subject: WfdRecord; definition: WfdRecord };
export type R1G5HistoryTarget = { datasetId: string; target?: R1G5Target; productId?: string };
export type R1G5SnapshotHistory = { snapshotId: string; products: readonly WfdRecord[];
  recordsByProduct: ReadonlyMap<string, ReadonlySet<string>> };
type HistoryTarget = R1G5HistoryTarget & { snapshotId?: string | null; snapshot?: R1G5SnapshotHistory | null; requestId?: string };

function text(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }
function records(value: unknown): WfdRecord[] { return Array.isArray(value) ? value.filter(isWfdRecord) : []; }
function hasTable(db: CoreDatabase['connection'], name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
}
function incomplete(id: string): never {
  throw new TaskError('G5_CROSS_SOURCE_EVIDENCE_REQUIRED', 'G5 无法核全目标的历史来源：' + id);
}
function incompleteCoverage(id: string, reason: string): never {
  throw new TaskError('G5_PEER_HISTORY_INCOMPLETE', `G5 无法核全固定快照中的已发布记录 ${id}（${reason}）。`);
}

function matchesR1G5Family(datasetId: string, stable: string | undefined, domain: unknown, subject: unknown, definition: unknown) {
  if (!stable || !isWfdRecord(subject) || !isWfdRecord(definition)) return false;
  const kind = domain === 'events' ? 'event_records' : domain === 'foundation' ? 'relation_edges' : 'tabular';
  return stable === r1G5ProductId(datasetId, kind, subject, definition);
}

/** 用固定历史读取得到普通产品的全部已发布版本，含被替代及撤销的版本。 */
export async function readR1G5SnapshotHistory(snapshotId: string, targets: readonly R1G5HistoryTarget[],
  discover: (signal: AbortSignal) => Promise<{ snapshotId: string; products: readonly WfdRecord[] }>,
  readHistory: (productId: string, signal: AbortSignal) => Promise<WfdRecord>, signal?: AbortSignal): Promise<R1G5SnapshotHistory> {
  const timeout = AbortSignal.timeout(R1_READ_LIMITS.timeoutMs);
  const wait = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let scope = snapshotId;
  try {
    const discovery = await discover(wait);
    wait.throwIfAborted();
    if (discovery.snapshotId !== snapshotId || !Array.isArray(discovery.products)) incompleteCoverage(scope, '目录身份不符');
    const products = discovery.products;
    const selected = targets.map(({ datasetId, target, productId }) => ({
      datasetId, productId, stable: target && r1G5ProductId(datasetId, target.kind, target.subject, target.definition),
    }));
    const counts = new Map<string, number>();
    for (const product of products) {
      if (!selected.some(({ datasetId, productId, stable }) => product.dataset_id === datasetId
        && (product.product_id === productId || product.product_id === stable
          || matchesR1G5Family(datasetId, stable, product.logical_domain, product.subject, product.declaration)))) continue;
      const id = String(product.product_id), count = product.published_record_count;
      const previous = counts.get(id);
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || previous !== undefined && previous !== count)
        incompleteCoverage(id, '目录无法确认已发布记录数');
      counts.set(id, count);
    }
    let remainingRows = R1_READ_LIMITS.maxScanRows;
    let remainingBytes = R1_READ_LIMITS.maxResultBytes;
    const recordsByProduct = new Map<string, Set<string>>();
    for (const [id, count] of counts) {
      scope = id;
      if (count > remainingRows) incompleteCoverage(id, '超出记录核验预算');
      const identities = new Set<string>();
      if (count > 0) {
        const result = await readHistory(id, wait);
        wait.throwIfAborted();
        remainingBytes -= Buffer.byteLength(JSON.stringify(result));
        if (remainingBytes < 0) incompleteCoverage(id, '超出固定读取字节预算');
        const datasetId = products.find(product => product.product_id === id)?.dataset_id;
        if (result.snapshot_id !== snapshotId || result.perspective !== 'snapshot_contents' || result.include_history !== true
          || !Array.isArray(result.products) || !result.products.length
          || !result.products.every(product => isWfdRecord(product) && product.product_id === id && product.dataset_id === datasetId)
          || !Array.isArray(result.rows) || result.rows.length !== count)
          incompleteCoverage(id, '固定读取身份或记录范围不符');
        for (const row of result.rows) {
          const ref = isWfdRecord(row) ? row.record_ref : null;
          if (!isWfdRecord(ref) || ref.product_id !== id || ref.snapshot_id !== snapshotId
            || !text(ref.logical_key) || !text(ref.revision_id)
            || row.record_id !== ref.logical_key || row.record_version !== ref.revision_id)
            incompleteCoverage(id, '固定读取缺少可核对的记录身份');
          identities.add(canonicalWfdJson([ref.logical_key, ref.revision_id]));
        }
        if (identities.size !== count) incompleteCoverage(id, '固定读取包含重复记录身份');
      }
      remainingRows -= count;
      recordsByProduct.set(id, identities);
    }
    return { snapshotId, products, recordsByProduct };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TaskError && error.code === 'G5_PEER_HISTORY_INCOMPLETE') throw error;
    const code = error instanceof Error && 'code' in error && text(error.code) ? error.code : 'READ_FAILED';
    incompleteCoverage(scope, timeout.aborted ? '超出固定读取时间预算' : code);
  }
}
function historyRecord(value: unknown, id: string): WfdRecord {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : null; } catch { return incomplete(id); }
  return isWfdRecord(parsed) ? parsed : incomplete(id);
}
export function r1G5PredecessorProducts(output: WfdRecord): string[] {
  return [...new Set(Object.values(isWfdRecord(output.revisions) ? output.revisions : {})
    .flatMap(revision => isWfdRecord(revision) && isWfdRecord(revision.previous) && text(revision.previous.product_id)
      ? [revision.previous.product_id] : []))];
}

export function readR1G5PredecessorAssociations(db: CoreDatabase['connection'], input: {
  datasetId: string; productId: string; recordId: string; recordVersion: string; requestId?: string;
}) {
  const { datasetId, productId, recordId, recordVersion, requestId } = input;
  const rows = db.prepare(`SELECT a.source_id, a.original_id, o.sha256, o.source_json FROM r1_record_associations a
    LEFT JOIN r1_originals o ON o.original_id=a.original_id
    WHERE a.dataset_id=? AND a.product_id=? AND a.record_id=? AND a.record_version=?
    ${requestId === undefined ? '' : 'AND a.request_id=?'}`)
    .all(datasetId, productId, recordId, recordVersion, ...(requestId === undefined ? [] : [requestId]));
  const identity = `${productId}/${recordId}/${recordVersion}`;
  if (!rows.length) incomplete(identity);
  return rows.map(row => {
    if (!knownR1SourceText(row.source_id) || !text(row.original_id)
      || (row.source_json !== null && historyRecord(row.source_json, identity).source_id !== row.source_id)) incomplete(identity);
    return { sourceId: row.source_id, originalId: row.original_id, sha256: row.sha256 };
  });
}

/** 按固定目录、前驱及已落盘的输出回执解析真实产品，并汇总各入口的来源。 */
export function readR1G5TargetHistory(db: CoreDatabase['connection'], input: HistoryTarget) {
  const { datasetId, target, productId, snapshotId, snapshot, requestId } = input;
  if (snapshotId && snapshot?.snapshotId !== snapshotId) incompleteCoverage(snapshotId, '缺少固定目录或记录身份');
  const products = snapshot?.products ?? [];
  const stable = target && r1G5ProductId(datasetId, target.kind, target.subject, target.definition);
  const aliases = new Set<string>([stable, productId].filter(text));
  const history: R1G5History = new Map();
  const addSource = (source: WfdRecord, id: string) => {
    if (!text(source.source_id)) return incomplete(id);
    addR1G5Source(history, source.source_id, declaredSourceSeries(source as unknown as R1SourceDeclaration));
  };
  const matchesFamily = (domain: unknown, subject: unknown, declaration: unknown) =>
    matchesR1G5Family(datasetId, stable, domain, subject, declaration);
  const catalog = products.filter(product => product.dataset_id === datasetId && text(product.product_id)
    && (aliases.has(product.product_id) || matchesFamily(product.logical_domain, product.subject, product.declaration)))
    .sort((a, b) => Number(b.definition_sequence ?? 0) - Number(a.definition_sequence ?? 0));
  for (const product of catalog) {
    const id = String(product.product_id);
    aliases.add(id);
    const admission = isWfdRecord(product.source_admission) ? product.source_admission : {};
    for (const sources of [product.published_source_ids, admission.source_ids]) {
      if (sources === undefined) continue;
      if (!Array.isArray(sources) || !sources.every(text)) incomplete(id);
      for (const sourceId of sources) if (!history.has(sourceId)) addR1G5Source(history, sourceId);
    }
  }
  const candidates: { requestId: string; ids: string[]; family: boolean; sources: unknown;
    publishedOutputs?: WfdRecord[] }[] = [];
  if (hasTable(db, 'r1_handoff_attempts')) {
    const rows = db.prepare(`SELECT request_id,document_json,document_sha256,local_refs_json,local_refs_sha256,receipt_json
      FROM r1_handoff_attempts WHERE dataset_id=? AND request_id<>? AND state<>'rejected'`).all(datasetId, requestId ?? '');
    for (const row of rows) {
      const id = String(row.request_id), document = historyRecord(row.document_json, id);
      const identity = isWfdRecord(document.request_identity) ? document.request_identity : {};
      if (identity.dataset_id !== datasetId || identity.request_id !== id || !Array.isArray(document.outputs)
        || !document.outputs.length || !document.outputs.every(isWfdRecord)
        || wfdSha256(String(row.document_json)) !== row.document_sha256) incomplete(id);
      const refs = historyRecord(row.local_refs_json, id);
      if (wfdSha256(String(row.local_refs_json)) !== row.local_refs_sha256) incomplete(id);
      const receipt = row.receipt_json === null ? {} : historyRecord(row.receipt_json, id);
      for (const output of document.outputs) {
        const member = isWfdRecord(refs.outputs) ? refs.outputs[String(output.output_key)] : refs;
        const memberRefs = isWfdRecord(member) ? member : {};
        const results = [receipt, ...records(receipt.members), ...records(receipt.output_results)]
          .filter(result => result.output_key === output.output_key && text(result.product_id));
        const actual = results.map(result => String(result.product_id));
        const ids = [...new Set([...actual, ...r1G5PredecessorProducts(output)])];
        const definition = output.definition ?? (isWfdRecord(memberRefs.reusedDefinition) ? memberRefs.reusedDefinition.declaration : null);
        const family = matchesFamily(output.logical_domain, output.subject, definition);
        const publishedOutputs = results.filter(result => text(result.snapshot_id) && (
          ['published_formal', 'published_sandbox'].includes(String(result.publication_state))
          || Array.isArray(result.rows) && result.rows.length > 0));
        candidates.push({ requestId: id, ids, family, sources: memberRefs.sourceRefs, publishedOutputs });
      }
    }
  }
  if (hasTable(db, 'r1_auto_requests')) {
    const rows = db.prepare(`SELECT request_id,record_json FROM r1_auto_requests WHERE request_id<>?
      AND CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.input.datasetId')=? ELSE 1 END`).all(requestId ?? '', datasetId);
    for (const row of rows) {
      const id = String(row.request_id), saved = historyRecord(row.record_json, id);
      const autoInput = isWfdRecord(saved.input) ? saved.input : {};
      if (autoInput.requestId !== id) incomplete(id);
      const revisions = records(saved.revisions);
      if (!revisions.length) continue;
      const catalog = isWfdRecord(saved.catalog) ? saved.catalog : {};
      const latest = isWfdRecord(catalog.latest) ? catalog.latest : {};
      for (const revision of revisions) {
        if (requestId && revision.handoffRequestId === requestId) continue;
        const proposal = isWfdRecord(revision.proposal) ? revision.proposal : {};
        const declared = isWfdRecord(proposal.target) ? proposal.target : {};
        if (declared.datasetId !== datasetId || !isWfdRecord(declared.subject) || !isWfdRecord(declared.definition)) incomplete(id);
        const family = matchesFamily('observations', declared.subject, declared.definition);
        const ids = text(latest.product_id) ? [latest.product_id] : [];
        candidates.push({ requestId: id, ids, family, sources: [autoInput.source] });
      }
    }
  }
  if (hasTable(db, 'r1_source_minute_bulk')) {
    const rows = db.prepare(`SELECT intake_id,record_json FROM r1_source_minute_bulk WHERE intake_id<>?
      AND CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.input.datasetId')=? ELSE 1 END`).all(requestId ?? '', datasetId);
    for (const row of rows) {
      const id = String(row.intake_id), saved = historyRecord(row.record_json, id);
      const bulkInput = isWfdRecord(saved.input) ? saved.input : {};
      if (bulkInput.intakeId !== id) incomplete(id);
      const actual = isWfdRecord(saved.receipt) && text(saved.receipt.product_id) ? [saved.receipt.product_id] : [];
      if (!actual.length && !['ready_to_commit', 'committing', 'published_readback', 'completed'].includes(String(saved.phase))) continue;
      const declared = isWfdRecord(saved.manifest) && isWfdRecord(saved.manifest.target) ? saved.manifest.target : {};
      const family = matchesFamily('observations', declared.subject, declared.definition);
      candidates.push({ requestId: id, ids: actual, family, sources: [bulkInput.source] });
    }
  }
  const datasetOnly = !productId && !stable;
  // 同一份冻结输出的正式回执与前驱可以把本地的多种产品编号连到一个目标。
  let previousSize: number;
  do {
    previousSize = aliases.size;
    for (const candidate of candidates) {
      if (candidate.family || candidate.ids.some(id => aliases.has(id))) for (const id of candidate.ids) aliases.add(id);
    }
  } while (previousSize !== aliases.size);
  const linkedByProduct = new Map<string, Set<string>>();
  const linkedByRequest = new Set<string>();
  if (hasTable(db, 'r1_record_associations')) {
    const products = [...aliases];
    const rows = db.prepare(`SELECT DISTINCT a.product_id,a.record_id,a.record_version,a.request_id,a.source_id,o.source_json FROM r1_record_associations a
      LEFT JOIN r1_originals o ON o.original_id=a.original_id WHERE a.dataset_id=?
      ${datasetOnly ? '' : 'AND a.product_id IN (SELECT value FROM json_each(?))'}`)
      .all(datasetId, ...(datasetOnly ? [] : [canonicalWfdJson(products)]));
    for (const row of rows) {
      const id = String(row.product_id);
      if (!text(row.source_id)) incomplete(id);
      const source = row.source_json === null ? { source_id: row.source_id } : historyRecord(row.source_json, id);
      if (source.source_id !== row.source_id) incomplete(id);
      addSource(source, id);
      if (!text(row.record_id) || !text(row.record_version) || !text(row.request_id)) incomplete(id);
      const linked = linkedByProduct.get(id) ?? new Set<string>();
      linked.add(canonicalWfdJson([row.record_id, row.record_version]));
      linkedByProduct.set(id, linked);
      linkedByRequest.add(canonicalWfdJson([id, row.request_id, row.record_id, row.record_version]));
    }
  }
  for (const candidate of candidates) {
    if (!datasetOnly && !candidate.family && !candidate.ids.some(id => aliases.has(id))) continue;
    if (!Array.isArray(candidate.sources) || !candidate.sources.length || !candidate.sources.every(isWfdRecord)) incomplete(candidate.requestId);
    for (const source of candidate.sources) addSource(source, candidate.requestId);
    for (const output of candidate.publishedOutputs ?? []) {
      const expected = Array.isArray(output.inserted_records) ? output.inserted_records
        : Array.isArray(output.records) ? output.records : [...records(output.rows), ...records(output.withdrawn_rows)];
      if (!expected.length || expected.some(row => !isWfdRecord(row) || !text(row.record_id) || !text(row.record_version)
        || !linkedByRequest.has(canonicalWfdJson([output.product_id, candidate.requestId, row.record_id, row.record_version]))))
        incomplete(candidate.requestId);
    }
  }
  // 没有系列的目录项只补来源身份，已核明系列的本地记录优先。
  for (const scopes of history.values()) if (scopes.size > 1) scopes.delete(undefined);
  for (const product of products) {
    const id = String(product.product_id);
    if (product.dataset_id !== datasetId || !aliases.has(id)) continue;
    const published = snapshot?.recordsByProduct.get(id), linked = linkedByProduct.get(id);
    if (!published || published.size !== (linked?.size ?? 0) || [...published].some(identity => !linked?.has(identity)))
      incompleteCoverage(id, 'WFD 记录及版本与本地关联集合不一致');
  }
  const mapped = [...aliases].filter(id => id !== stable);
  const resolved = productId ?? catalog[0]?.product_id ?? (mapped.length === 1 ? mapped[0] : stable);
  if (!productId && !catalog.length && mapped.length > 1) incomplete(datasetId);
  return { productId: text(resolved) ? resolved : undefined, history };
}

export function migrateR1G5Receipts(database: CoreDatabase): void {
  database.migrate('r1-g5-admission', 1, `CREATE TABLE r1_g5_admission_receipts (
    request_id TEXT NOT NULL, output_key TEXT NOT NULL, context_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(request_id,output_key));`);
}

export function persistR1G5Receipt(db: CoreDatabase['connection'], receipt: G5AdmissionReceipt, contextSha256: string): void {
  const { binding } = receipt;
  assertBoundG5AdmissionReceipt(receipt, binding);
  const value = canonicalWfdJson(receipt);
  db.prepare('INSERT INTO r1_g5_admission_receipts VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
    .run(binding.requestId, binding.target.outputKey, contextSha256, value);
  assertIssuedR1G5Receipt(db, receipt, binding, contextSha256);
}

export function readIssuedR1G5Receipts(db: CoreDatabase['connection'], requestId: string) {
  return db.prepare('SELECT output_key,context_sha256,receipt_json FROM r1_g5_admission_receipts WHERE request_id=?').all(requestId);
}

export function assertIssuedR1G5Receipt(db: CoreDatabase['connection'], receipt: unknown, binding: G5AdmissionBinding,
  contextSha256: string): asserts receipt is G5AdmissionReceipt {
  assertBoundG5AdmissionReceipt(receipt, binding);
  const issued = db.prepare('SELECT context_sha256,receipt_json FROM r1_g5_admission_receipts WHERE request_id=? AND output_key=?')
    .get(binding.requestId, binding.target.outputKey);
  if (issued?.context_sha256 !== contextSha256 || issued.receipt_json !== canonicalWfdJson(receipt))
    throw new TaskError('R1_G5_EVIDENCE_MISMATCH', 'G5 回执与宿主持久签发记录不符。');
}

export function readIssuedR1G5Binding(value: unknown): G5AdmissionBinding {
  let receipt: unknown;
  try { receipt = typeof value === 'string' ? JSON.parse(value) : null; } catch { receipt = null; }
  if (!verifyG5AdmissionReceiptDigest(receipt))
    throw new TaskError('R1_G5_EVIDENCE_MISMATCH', '宿主持久签发记录无法核验。');
  return receipt.binding;
}

export function r1G5PeerProfiles(history: R1G5History, sourceId: string, datasetId: string,
  store?: SourceFieldProfileStore, profile?: SourceFieldProfile | null, registry?: SemanticProductRegistryStore): SourceFieldProfile[] {
  if (!store) return [];
  const peers: SourceFieldProfile[] = [];
  for (const [id, seriesNames] of history) {
    if (id === sourceId) continue;
    try {
      const resolved = [...seriesNames].map(series => {
        const matched = store.match({ sourceId: id, series });
        if (matched || series !== undefined) return matched;
        const candidates = store.list().filter(peer => peer.sourceId === id);
        const scoped = candidates.filter(peer => (peer.series !== '' && peer.series === profile?.series)
          || registry?.datasetFor(profileFingerprint(peer)) === datasetId);
        return scoped.length === 1 ? scoped[0]! : null;
      });
      const first = resolved[0];
      if (first && resolved.every(peer => peer && sourceFieldProfileDigest(peer) === sourceFieldProfileDigest(first))) peers.push(first);
    } catch { /* 不可读或歧义档案保留在历史 ID 清单，由 G5 拒绝。 */ }
  }
  return peers;
}

export function readR1G5Profile(value: unknown, sourceId: string): SourceFieldProfile {
  const wrapped = isWfdRecord(value) && Object.hasOwn(value, 'profile') ? value : null;
  const profile = readSourceFieldProfile(wrapped ? wrapped.profile : value, sourceId);
  if (wrapped && (wrapped.digest !== sourceFieldProfileDigest(profile) || wrapped.fingerprint !== profileFingerprint(profile)))
    throw new TaskError('SOURCE_FIELD_PROFILE', '加工携带的冻结来源字段档案摘要不符。');
  return profile;
}

export function assertR1G5Admission(receipt: G5AdmissionReceipt): void {
  if (receipt.allowed) return;
  const code = receipt.decision === 'block_semantic_conflict' ? 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT' : 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED';
  throw new TaskError(code, [receipt.decision, receipt.targetProductId,
    ...receipt.diagnostics.map(item => `${item.sourceId}: ${item.message}`)].join('；'));
}

export function r1G5EvidenceRef(receipt: G5AdmissionReceipt) {
  return { ref_id: `g5:${receipt.receiptDigest}`, content_sha256: receipt.receiptDigest,
    kind: G5_ADMISSION_RECEIPT_VERSION, g5AdmissionReceipt: receipt };
}

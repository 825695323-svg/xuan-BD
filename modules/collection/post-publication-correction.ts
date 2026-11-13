import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument, type R1StructuredRequest } from './r1-structured-handoff.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import type { R1Runtime } from './r1-runtime.js';
import type { OperatorContext } from './processing-plan.js';

/**
 * 已发布成功、固定读回一致后才发现映射/语义错误的更正闭环的 BD 编排。
 *
 * 用途暂停的权威在 WFD catalog（wfd_sdk/usage_suspension.py），经正式机器入口
 * 落盘、共用读取闸口与 submit 边界校验；本服务只保存错误证据、冻结影响圈定、
 * 编排宿主提交确认与逐项验收状态，不自行宣布"已修复"、不原地覆盖旧数据，
 * 不在 WFD 之外另建正式发布账本。
 */
export const POST_PUBLICATION_CORRECTION_RUNTIME = 'bd.post-publication-correction';
export const POST_PUBLICATION_CORRECTION_VERSION = 'bd.post-publication-correction/1';

export type CorrectionKind = 'processing_repair' | 'source_correction';
export type CorrectionState = 'registered' | 'impact_incomplete' | 'impact_frozen' | 'suspend_failed' |
  'suspended' | 'prepared' | 'authorization_pending' | 'authorization_rejected' | 'repairing' |
  'verified' | 'resolved' | 'blocked';
export interface CorrectionBinding {
  /** 错误适配三元组（精确版本）或精确加工计划/输出；两者只能选一。 */
  adapter?: { adapterId: string; version: string; configDigest: string };
  planOutput?: { planId: string; outputId: string };
}
export interface CorrectionInput {
  caseId: string; kind: CorrectionKind; errorType: string; discoveredAt: string;
  evidence: string; binding: CorrectionBinding; connectionSha256: string;
}

const SCHEMA = `CREATE TABLE correction_cases (
  case_id TEXT PRIMARY KEY, kind TEXT NOT NULL, error_type TEXT NOT NULL, discovered_at TEXT NOT NULL,
  evidence TEXT NOT NULL, binding_json TEXT NOT NULL, connection_sha256 TEXT NOT NULL,
  state TEXT NOT NULL, impact_json TEXT, impact_sha256 TEXT, suspension_json TEXT,
  frozen_json TEXT, frozen_sha256 TEXT, confirmation_digest TEXT,
  authorization_task_id TEXT, repair_task_id TEXT, result_json TEXT, gaps_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE correction_items (
  case_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
  product_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, definition_digest TEXT NOT NULL,
  business_key TEXT NOT NULL, record_version TEXT NOT NULL,
  state TEXT NOT NULL, gaps_json TEXT NOT NULL, verification_json TEXT,
  PRIMARY KEY(case_id,item_id)
);`;

interface CaseRow {
  case_id: string; kind: CorrectionKind; error_type: string; discovered_at: string; evidence: string;
  binding_json: string; connection_sha256: string; state: CorrectionState; impact_json: string | null;
  impact_sha256: string | null; suspension_json: string | null; frozen_json: string | null;
  frozen_sha256: string | null; confirmation_digest: string | null;
  authorization_task_id: string | null; repair_task_id: string | null;
  result_json: string | null; gaps_json: string; created_at: number; updated_at: number;
}
interface ImpactItem {
  itemId: string; kind: 'original' | 'derived'; productId: string; snapshotId: string;
  definitionDigest: string; businessKey: string; recordVersion: string;
  requestId?: string;
  gaps: string[];
}
export interface CorrectionView {
  caseId: string; kind: CorrectionKind; errorType: string; discoveredAt: string; evidence: string;
  binding: CorrectionBinding; state: CorrectionState; gaps: string[];
  impactSha256: string | null; itemCount: number; items: WfdRecord[];
  suspension: WfdRecord | null; frozenSha256: string | null; confirmationDigest: string | null;
  authorizationTaskId: string | null; repairTaskId: string | null; result: WfdRecord | null;
  /** 登记的是已证明的影响范围，不是全库全集。 */
  coverage: 'proven_subset_only';
}

const UNKNOWN_SEND_STATES = new Set(['sending', 'pending_unknown', 'pending_receipt', 'prepared_profile_pending']);
const MAX_SCAN_ROWS = 20_000;

export class PostPublicationCorrectionService {
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService;
    runtime: R1Runtime; processing: ProcessingPlanService; materials: MaterialService;
    adapters: { resolve(ref: unknown): { configDigest: string } } }) {
    options.database.migrate('post-publication-correction', 1, SCHEMA);
  }
  private row(caseId: string): CaseRow | undefined {
    return this.db.prepare('SELECT * FROM correction_cases WHERE case_id=?').get(caseId) as unknown as CaseRow | undefined;
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }
  private get client() { return this.options.runtime.client; }
  private get machine() { return this.options.runtime.connection.client; }
  private connectionDigest(): string {
    return 'sha256:' + wfdSha256(canonicalWfdJson(this.options.runtime.currentIdentity()));
  }

  capabilities() {
    let connectionSha256: string | null = null;
    try { connectionSha256 = this.connectionDigest(); } catch { /* 连接不可用时明确留空 */ }
    return { version: POST_PUBLICATION_CORRECTION_VERSION, runtime: POST_PUBLICATION_CORRECTION_RUNTIME,
      connectionSha256,
      kinds: ['processing_repair', 'source_correction'] as CorrectionKind[],
      authority: 'WFD catalog/usage_suspensions.json (shared writer_lock with submit)',
      gates: ['real persisted association scan', 'WFD default read/compute denial', 'explicit audit reproduction',
        'real TaskService/PermissionService approval', 'frozen confirmation digest',
        'reasoned precise-predecessor revisions', 'fixed readback and old/new substitution'],
      coverage: 'proven_subset_only', automaticRepair: false, automaticResolve: false,
      maxScanRows: MAX_SCAN_ROWS, maxDocumentBytes: 786432 };
  }

  /** 真实受控入口：只登记错误，不暂停、不修复、不宣布完成。 */
  register(value: unknown, operator: OperatorContext): CorrectionView {
    assertOperator(operator);
    const input = readCorrectionInput(value);
    if (this.connectionDigest() !== input.connectionSha256)
      fail('CORRECTION_CONNECTION_CHANGED', '登记时当前连接与冻结身份不同；未跨连接登记。');
    if (this.row(input.caseId)) fail('CORRECTION_CASE_DUPLICATE', '该更正事项编号已存在，不覆盖原登记。');
    const now = Date.now();
    this.db.prepare(`INSERT INTO correction_cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.caseId, input.kind, input.errorType, input.discoveredAt, input.evidence,
      canonicalWfdJson(input.binding as unknown as WfdRecord), input.connectionSha256, 'registered',
      null, null, null, null, null, null, null, null, null, canonicalWfdJson([]), now, now);
    return this.view(input.caseId);
  }

  /**
   * 影响圈定沿持久计划、R1 请求和逐行关联核对。证据不足、未知发送状态与超预算均记录为缺口。
   */
  freezeImpact(caseId: string, operator: OperatorContext): CorrectionView {
    assertOperator(operator);
    const row = this.require(caseId);
    if (!['registered', 'impact_incomplete'].includes(row.state))
      fail('CORRECTION_STATE', '影响清单只能在登记后冻结；已冻结或已暂停的事项不重扫。');
    this.assertConnection(row);
    const binding = JSON.parse(row.binding_json) as CorrectionBinding;
    const gaps: string[] = [];
    const items: ImpactItem[] = [];
    const scanned = this.scanPlans(binding, gaps);
    if (scanned === null) return this.storeImpact(row, [], gaps);
    for (const plan of scanned) {
      const requests = this.db.prepare(`SELECT request_id,state,document_json,receipt_json,local_refs_json
        FROM r1_handoff_attempts WHERE request_id IN (SELECT request_id FROM r1_workspace_requests WHERE plan_id=? AND output_id=?)
        ORDER BY created_at,rowid`).all(plan.planId, plan.outputId) as unknown as {
          request_id: string; state: string; document_json: string; receipt_json: string | null; local_refs_json: string }[];
      if (!requests.length) { gaps.push(`plan:${plan.planId}:${plan.outputId}:no_persisted_request`); continue; }
      for (const attempt of requests) {
        if (UNKNOWN_SEND_STATES.has(attempt.state)) {
          gaps.push(`request:${attempt.request_id}:unknown_send_state:${attempt.state}`);
          continue; // 未知结果必须原号核状态，不能当无影响
        }
        let document: WfdRecord;
        try { document = JSON.parse(attempt.document_json) as WfdRecord; } catch { gaps.push(`request:${attempt.request_id}:document_unreadable`); continue; }
        const output = (Array.isArray(document.outputs) ? document.outputs[0] : null) as WfdRecord | null;
        if (!output || !isWfdRecord(output.payload) || !Array.isArray(output.payload.rows)) {
          gaps.push(`request:${attempt.request_id}:payload_missing`); continue;
        }
        const associations = this.db.prepare(`SELECT dataset_id,product_id,definition_digest,snapshot_id,
          record_id,record_version,request_id,original_id FROM r1_record_associations WHERE request_id=?
          ORDER BY product_id,record_id,record_version`).all(attempt.request_id) as unknown as {
            dataset_id: string; product_id: string; definition_digest: string; snapshot_id: string;
            record_id: string; record_version: string; request_id: string; original_id: string }[];
        if (!associations.length) { gaps.push(`request:${attempt.request_id}:no_fixed_row_association`); continue; }
        // 一个请求可以发布多个产品；逐条按真实 (产品,快照,记录版本) 关联圈定，
        // 不因多产品而把谱系误判为缺口、也不把未受影响产品并入同一系列。
        for (const assoc of associations) items.push({
          itemId: `original:${assoc.request_id}:${assoc.record_id}:${assoc.record_version}`,
          kind: 'original', productId: assoc.product_id, snapshotId: assoc.snapshot_id,
          definitionDigest: assoc.definition_digest, businessKey: assoc.record_id,
          recordVersion: assoc.record_version, requestId: assoc.request_id, gaps: [] });
      }
    }
    if (!items.length) gaps.push('no_proven_impact');
    if (items.length > MAX_SCAN_ROWS) {
      return this.storeImpact(row, [], gaps.concat('scan_budget_exceeded:not_truncated_but_unfinished'));
    }
    // 已有关联也不能证明"本应存在但漏发"的全集；第三项批次应到对账不在本轮。
    gaps.push('coverage:proven_associations_only;missing_or_unsent_products_not_provable_in_this_scope');
    return this.storeImpact(row, items, gaps);
  }

  private scanPlans(binding: CorrectionBinding, gaps: string[]): { planId: string; outputId: string }[] | null {
    // 直接扫描真实持久步骤表，不走加工计划视图或前 20 条摘要。
    const exact = binding.planOutput;
    const rows = this.db.prepare(`SELECT s.plan_id,s.output_id,s.parameters_json
      FROM processing_plan_steps s JOIN processing_plans p ON p.plan_id=s.plan_id
      WHERE s.kind='parse' ${exact ? 'AND s.plan_id=? AND s.output_id=?' : ''}
      ORDER BY p.created_at,s.ordinal,s.rowid LIMIT ?`)
      .iterate(...(exact ? [exact.planId, exact.outputId] : []), MAX_SCAN_ROWS + 1);
    let scanned = 0;
    const matched: { planId: string; outputId: string }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (++scanned > MAX_SCAN_ROWS) {
        gaps.push('plan_scan_over_budget');
        return null;
      }
      const entry = row as unknown as { plan_id: string; output_id: string; parameters_json: string };
      const key = entry.plan_id + '\u0000' + entry.output_id;
      if (seen.has(key)) continue;
      seen.add(key);
      let parameters: WfdRecord;
      try { parameters = JSON.parse(entry.parameters_json) as WfdRecord; }
      catch { gaps.push(`plan:${entry.plan_id}:parse_parameters_unreadable`); continue; }
      const adapter = parameters.sourceAdapter;
      if (exact || (binding.adapter && isWfdRecord(adapter)
        && adapter.adapterId === binding.adapter.adapterId && adapter.version === binding.adapter.version
        && sameAdapterDigest(adapter.configDigest, binding.adapter.configDigest)))
        matched.push({ planId: entry.plan_id, outputId: entry.output_id });
    }
    if (!matched.length) gaps.push('no_plan_matches_error_binding');
    return matched;
  }

  private storeImpact(row: CaseRow, items: ImpactItem[], gaps: string[]): CorrectionView {
    const impact = { version: POST_PUBLICATION_CORRECTION_VERSION, caseId: row.case_id,
      frozenAt: new Date().toISOString(), coverage: 'proven_subset_only', items, gaps };
    const digest = wfdSha256(canonicalWfdJson(impact as unknown as WfdRecord));
    const state: CorrectionState = items.length && !gaps.some(gap =>
      gap.startsWith('scan_budget_exceeded') || gap.startsWith('no_plan_matches')
      || gap === 'no_proven_impact')
      ? 'impact_frozen' : 'impact_incomplete';
    this.options.database.transaction(() => {
      this.db.prepare('DELETE FROM correction_items WHERE case_id=?').run(row.case_id);
      for (const item of items) this.db.prepare('INSERT INTO correction_items VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        row.case_id, item.itemId, item.kind, item.productId, item.snapshotId, item.definitionDigest,
        item.businessKey, item.recordVersion, 'suspended',
        canonicalWfdJson(item.gaps), null);
      this.db.prepare(`UPDATE correction_cases SET state=?,impact_json=?,impact_sha256=?,gaps_json=?,updated_at=? WHERE case_id=?`)
        .run(state, canonicalWfdJson(impact as unknown as WfdRecord), digest, canonicalWfdJson(gaps), Date.now(), row.case_id);
    });
    return this.view(row.case_id);
  }

  /** 暂停声明由已冻结影响清单确定性重建；恢复只重用同一声明，不新增范围。 */
  private suspensionDeclaration(row: CaseRow, impact: { items: ImpactItem[]; gaps: string[] }): WfdRecord {
    if (impact.gaps.includes('plan_scan_over_budget')) {
      // Older versions could freeze a partial scan. An unsent case may be scanned again.
      if (row.state === 'impact_frozen')
        this.db.prepare("UPDATE correction_cases SET state='impact_incomplete',updated_at=? WHERE case_id=?")
          .run(Date.now(), row.case_id);
      fail('CORRECTION_SUSPEND_SCOPE', '计划扫描超出预算，影响范围未完整核对，不能据此暂停。');
    }
    const scopes = new Map<string, { product_id: string; snapshot_id: string; record_versions: string[] }>();
    for (const item of impact.items) {
      if (!item.productId || !item.snapshotId || !item.recordVersion) {
        impact.gaps.push(`suspend_scope_incomplete:${item.itemId}`);
        this.db.prepare(`UPDATE correction_cases SET gaps_json=?,updated_at=? WHERE case_id=?`)
          .run(canonicalWfdJson(impact.gaps), Date.now(), row.case_id);
        fail('CORRECTION_SUSPEND_SCOPE', '存在未证明版本的受影响项；未登记不完整暂停。');
      }
      const key = item.productId + '/' + item.snapshotId;
      const scope = scopes.get(key) ?? { product_id: item.productId, snapshot_id: item.snapshotId, record_versions: [] };
      if (!scope.record_versions.includes(item.recordVersion)) scope.record_versions.push(item.recordVersion);
      scopes.set(key, scope);
    }
    if (!scopes.size) fail('CORRECTION_SUSPEND_SCOPE', '没有精确的记录版本，未登记空范围暂停。');
    return { issue_id: row.case_id, error_type: row.error_type, reason: row.evidence,
      evidence_digest: wfdSha256(canonicalWfdJson({ caseId: row.case_id, evidence: row.evidence,
        discoveredAt: row.discovered_at })),
      error_binding_digest: wfdSha256(canonicalWfdJson(JSON.parse(row.binding_json) as WfdRecord)),
      impact_digest: row.impact_sha256, declared_at_utc: row.discovered_at, scopes: [...scopes.values()] };
  }

  /** 正式暂停：失败保持未完成并阻止继续发布，不返回成功。 */
  async suspend(caseId: string, operator: OperatorContext): Promise<CorrectionView> {
    assertOperator(operator);
    const row = this.require(caseId);
    if (row.state !== 'impact_frozen') fail('CORRECTION_STATE', '影响清单未完成冻结，不能登记用途暂停。');
    this.assertConnection(row);
    const impact = JSON.parse(row.impact_json!) as { items: ImpactItem[]; gaps: string[] };
    const declaration: WfdRecord = this.suspensionDeclaration(row, impact);
    let receipt: WfdRecord | null = null;
    try {
      receipt = (await this.machine.usageSuspend(declaration)).result as WfdRecord;
      if (!isWfdRecord(receipt) || receipt.state !== 'active' || typeof receipt.issue_digest !== 'string')
        fail('CORRECTION_WFD_SUSPEND_RECEIPT', 'WFD 暂停回执不完整；未声称暂停成功。');
      const status = (await this.machine.usageStatus()).result as WfdRecord;
      const active = (Array.isArray(status.issues) ? status.issues.filter(isWfdRecord) : [])
        .filter(issue => issue.issue_id === caseId && issue.state === 'active');
      if (active.length !== 1) fail('CORRECTION_WFD_SUSPEND_VERIFY', '暂停未在当前持久事项中核到，保持未完成。');
    } catch (error) {
      // 响应已收到但随后状态核验失败：以正式回执为准，不用通用失败覆盖。
      if (receipt && isWfdRecord(receipt) && receipt.state === 'active'
        && typeof receipt.issue_digest === 'string') {
        // 保持已获得的正式暂停回执，继续落盘。
      } else {
      // 暂停已落盘但响应丢失：按同一声明核对持久事项，存在即继续；不同内容不冒充成功。
      try {
        const status = (await this.machine.usageStatus()).result as WfdRecord;
        const existing = (Array.isArray(status.issues) ? status.issues.filter(isWfdRecord) : [])
          .find(issue => issue.issue_id === caseId && issue.state === 'active');
        const expectedScopes = (declaration.scopes as WfdRecord[]).map(scope => canonicalWfdJson({
          product_id: scope.product_id, snapshot_id: scope.snapshot_id,
          record_versions: [...(scope.record_versions as string[])].sort() })).sort();
        const actualScopes = Array.isArray(existing?.scopes) ? (existing!.scopes as WfdRecord[]).map(scope => canonicalWfdJson({
          product_id: scope.product_id, snapshot_id: scope.snapshot_id,
          record_versions: Array.isArray(scope.record_versions) ? [...scope.record_versions].map(String).sort() : [] })).sort() : [];
        if (existing && existing.error_type === row.error_type && existing.reason === row.evidence
          && existing.evidence_digest === declaration.evidence_digest
          && existing.error_binding_digest === declaration.error_binding_digest
          && existing.impact_digest === row.impact_sha256
          && canonicalWfdJson(expectedScopes as never) === canonicalWfdJson(actualScopes as never)) {
          receipt = { issue_id: caseId, issue_digest: existing.issue_digest, state: 'active' } as WfdRecord;
        } else {
          throw error;
        }
      } catch (recoveryError) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.prepare(`UPDATE correction_cases SET state='suspend_failed',gaps_json=?,updated_at=? WHERE case_id=?`)
          .run(canonicalWfdJson([...impact.gaps, 'wfd_suspend_failed:' + message]), Date.now(), caseId);
        throw error instanceof TaskError ? error : new TaskError('CORRECTION_WFD_SUSPEND_FAILED', message);
      }
      }
    }
    this.db.prepare(`UPDATE correction_cases SET state='suspended',suspension_json=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(receipt), Date.now(), caseId);
    return this.view(caseId);
  }

  /** 显式审计/技术固定复现：旧固定内容 + 已知问题说明，明确不可发布。 */
  async audit(caseId: string, snapshotId: string, productId?: string): Promise<WfdRecord> {
    const row = this.require(caseId);
    if (!['suspended', 'prepared', 'authorization_pending', 'repairing', 'verified', 'resolved'].includes(row.state))
      fail('CORRECTION_STATE', '暂停未生效，不提供审计复现。');
    const reply = await this.machine.usageAuditRead(snapshotId, caseId, productId);
    const result = reply.result as WfdRecord;
    const governance = result.usage_governance as WfdRecord | undefined;
    if (!isWfdRecord(result) || result.publishable !== false || result.compute_eligible !== false
      || !isWfdRecord(governance) || governance.audit_reproduction !== true
      || !Array.isArray(governance.known_issues) || !governance.known_issues.some(
        (issue: unknown) => isWfdRecord(issue) && issue.issue_id === caseId))
      fail('CORRECTION_AUDIT_INVALID', '审计复现没有携带当前事项的已知问题说明或不可发布标记。');
    return result;
  }

  /**
   * 冻结修复清单并构造不可变原因化修订文档；只准备、不发送、不解除限制。
   * processing_repair 复用原字节并以新适配/新计划生成候选；source_correction
   * 必须提供新取得原件和来源修订依据，取得/计算时间不倒填。
   */
  prepareRepair(caseId: string, value: unknown, operator: OperatorContext): { view: CorrectionView; documentSha256: string; frozenSha256: string } {
    assertOperator(operator);
    const row = this.require(caseId);
    // 允许在暂停生效后重新冻结（范围/摘要变化须重新确认），但授权后不得改写。
    if (!['suspended', 'prepared'].includes(row.state))
      fail('CORRECTION_STATE', '只有暂停生效且尚未授权时才可准备/重新冻结修复。');
    this.assertConnection(row);
    const input = readRepairInput(value, row.kind);
    const impact = JSON.parse(row.impact_json!) as { items: ImpactItem[]; gaps: string[] };
    const originals = impact.items.filter(item => item.kind === 'original');
    if (!originals.length) fail('CORRECTION_IMPACT_EMPTY', '没有已证明的原报记录版本。');
    const originalDocument = this.originalDocument(originals[0]!.requestId!);
    const output = this.originalOutputForItem(originalDocument, originals[0]!);
    if (originals.some(item => item.requestId !== originals[0]!.requestId
      || String(this.originalOutputForItem(this.originalDocument(item.requestId!), item).output_key)
        !== String(output.output_key)))
      fail('CORRECTION_MULTI_OUTPUT_UNSUPPORTED', '本批只支持同一原发布输出的精确前驱更正；多输出未冒充完成。');
    const rows = output.payload as WfdRecord;
    const previousRows = rows.rows as WfdRecord[];
    const keys = new Set(previousRows.map(item => String(item.business_key)));
    if (originals.some(item => item.productId && !keys.has(item.businessKey)))
      fail('CORRECTION_ORIGINAL_ROW_MISSING', '冻结影响项没有落在原发布文档的实际行中。');
    // 更正值只来自新计划已完成的结构产物；正文 correctedRows 最多用于逐字核对。
    const produced = this.repairOutputRows(input.planId, input.outputId);
    const tabular = String(rows.kind) === 'tabular_rows' && isWfdRecord(previousRows[0]?.values);
    let tabularMapping: { fields: Map<string, { value: string; state?: string }>; businessKey?: string } | undefined;
    if (tabular) {
      let candidate: { target?: unknown };
      try { candidate = this.options.processing.candidateOutput(input.planId, input.outputId); }
      catch { return fail('CORRECTION_TABULAR_MAPPING', '修复计划输出尚未完成结构核对，缺表格字段映射。'); }
      const target = candidate.target;
      const declaration = isWfdRecord(target) && isWfdRecord(target.declaration) ? target.declaration : null;
      const mapping = declaration && isWfdRecord(declaration.mapping) ? declaration.mapping : null;
      const fields = mapping && Array.isArray(mapping.fields) ? mapping.fields.filter(isWfdRecord) : [];
      const mapped = new Map<string, { value: string; state?: string }>(fields.flatMap(field => {
        const fieldCode = String(field.fieldCode ?? ''), value = String(field.value ?? '');
        if (!fieldCode || !value) return [];
        return [[fieldCode, { value, ...(typeof field.state === 'string' && field.state ? { state: field.state } : {}) }] as const];
      }));
      if (!mapped.size) return fail('CORRECTION_TABULAR_MAPPING', '合法表格更正需要修复计划冻结的逐字段映射。');
      // 真实原报加工产物的业务键字段由冻结声明给出（如 __bd_source_key），
      // 发布行才叫 business_key；只认 business_key 会误判为身份改变。
      const businessKey = typeof mapping!.businessKey === 'string' && mapping!.businessKey
        ? mapping!.businessKey : undefined;
      tabularMapping = { fields: mapped, ...(businessKey ? { businessKey } : {}) };
    }
    const corrected = this.mergeCorrectedRows(previousRows, produced, row.kind, tabularMapping);
    const valueFields = this.correctedValueFields(previousRows, corrected);
    if (input.correctedRows) {
      if (canonicalWfdJson(input.correctedRows as never) !== canonicalWfdJson(corrected as never))
        fail('CORRECTION_ROWS_NOT_FROM_OUTPUT', '正文更正值与新计划实际加工产物不同；未采用正文冒充。');
    }
    for (const item of corrected) {
      if (Object.keys(item).some(key => !Object.hasOwn(previousRows[0] ?? {}, key))
        || Object.keys(previousRows[0] ?? {}).some(key => !Object.hasOwn(item, key)))
        fail('CORRECTION_IDENTITY_CHANGED', '字段结构改变；产品/单位/频率身份须保持不变。');
    }
    const derivedItems = impact.items.filter(item => item.kind === 'derived');
    if (derivedItems.length)
      fail('CORRECTION_MANUAL_DERIVED_REQUIRED',
        '原冻结影响范围含已发布的旧派生数据，保留用途暂停和原更正记录。');
    const correctedValueField = previousRows[0] && Object.hasOwn(previousRows[0], 'value_decimal') ? 'value_decimal'
      : previousRows[0] && Object.hasOwn(previousRows[0], 'value') ? 'value' : null;
    if (!tabular && !correctedValueField) fail('CORRECTION_VALUE_FIELD', '原发布行没有可核数值字段。');
    // 新计划/新适配证据：不改旧计划/旧产物，按原件字节与适配三元组核对。
    const newStep = this.db.prepare(`SELECT parameters_json FROM processing_plan_steps
      WHERE plan_id=? AND output_id=? AND kind='parse' ORDER BY ordinal LIMIT 1`).get(input.planId, input.outputId) as
      { parameters_json: string } | undefined;
    if (!newStep) fail('CORRECTION_REPAIR_PLAN_NOT_FOUND', '修复计划没有持久的解析步骤。');
    let newParameters: WfdRecord;
    try { newParameters = JSON.parse(newStep.parameters_json) as WfdRecord; }
    catch { return fail('CORRECTION_REPAIR_PLAN_NOT_FOUND', '修复计划解析参数不可读。'); }
    const newAdapter = newParameters.sourceAdapter;
    const materialId = String(newParameters.materialId ?? '');
    const binding = JSON.parse(row.binding_json) as CorrectionBinding;
    const originalPlan = this.db.prepare('SELECT plan_id FROM r1_workspace_requests WHERE request_id=?')
      .get(String(originals[0]!.requestId)) as { plan_id: string } | undefined;
    if (originalPlan && input.planId === originalPlan.plan_id)
      fail('CORRECTION_REPAIR_PLAN_REUSED', '修复须使用新加工计划；不能复用原发布计划。');
    if (binding.adapter) {
      if (!isWfdRecord(newAdapter) || !newAdapter.configDigest
        || !newAdapter.adapterId || !newAdapter.version
        || sameAdapterDigest(newAdapter.configDigest, binding.adapter.configDigest))
        fail('CORRECTION_ADAPTER_NOT_CHANGED', '修复须使用与错误版本不同的已采用适配配置。');
      let resolved: { configDigest: string };
      try {
        resolved = this.options.adapters.resolve({ adapterId: String(newAdapter.adapterId),
          version: String(newAdapter.version), configDigest: adapterDigestHex(newAdapter.configDigest) });
      } catch (error) {
        fail('CORRECTION_ADAPTER_NOT_ADOPTED', '修复适配不是当前已采用版本：'
          + (error instanceof Error ? error.message : String(error)));
      }
      if (!sameAdapterDigest(resolved.configDigest, newAdapter.configDigest))
        fail('CORRECTION_ADAPTER_CHANGED', '修复适配配置摘要与已采用版本不一致。');
    } else if (newAdapter !== undefined) {
      if (!isWfdRecord(newAdapter) || !newAdapter.configDigest)
        fail('CORRECTION_ADAPTER_CHANGED', '修复适配身份不完整。');
    }
    const original = this.options.materials.readOriginal(materialId);
    const expectedSha = input.originalSha256.replace(/^sha256:/u, '');
    const actualSha = original.sha256.replace(/^sha256:/u, '');
    const originalAttempt = this.db.prepare('SELECT local_refs_json,created_at FROM r1_handoff_attempts WHERE request_id=?')
      .get(String(originals[0]!.requestId)) as { local_refs_json: string; created_at: number } | undefined;
    let originalRefs: WfdRecord = {};
    try { originalRefs = originalAttempt ? JSON.parse(originalAttempt.local_refs_json) as WfdRecord : {}; }
    catch { originalRefs = {}; }
    const refMaterialIds = Array.isArray(originalRefs.materialIds) ? originalRefs.materialIds.map(String) : [];
    const refOriginalIds = Array.isArray(originalRefs.originalIds) ? originalRefs.originalIds.map(String) : [];
    const refShaMatches = (sha: string) => {
      if (refMaterialIds.includes(materialId)) return true;
      for (const originalId of refOriginalIds) {
        const stored = this.db.prepare(`SELECT o.sha256 FROM r1_originals o WHERE o.original_id=?`).get(originalId) as
          { sha256: string } | undefined;
        if (stored && String(stored.sha256).replace(/^sha256:/u, '') === sha) return true;
      }
      return false;
    };
    if (row.kind === 'processing_repair') {
      if (actualSha !== expectedSha) fail('CORRECTION_ORIGINAL_CHANGED', 'processing_repair 必须保留原字节；原件摘要不同。');
      if (!refShaMatches(actualSha)) fail('CORRECTION_ORIGINAL_LINK', '修复原件没有关联到原发布请求的实际材料。');
    }
    if (row.kind === 'source_correction') {
      const sourceRevision = input.sourceRevision!;
      const previousSha = String(sourceRevision.previousOriginalSha256).replace(/^sha256:/u, '');
      if (actualSha === previousSha || actualSha !== expectedSha || !refShaMatches(previousSha))
        fail('CORRECTION_SOURCE_REVISION_REQUIRED', '供应商更正须有新取得原件，并关联原发布原件与来源修订依据。');
      if (String(sourceRevision.originalSha256).replace(/^sha256:/u, '') !== actualSha)
        fail('CORRECTION_SOURCE_REVISION_REQUIRED', '来源修订依据的新原件摘要与当前材料不符。');
      const acquired = Date.parse(String(sourceRevision.acquiredAtUtc));
      if (originalAttempt && acquired < originalAttempt.created_at)
        fail('CORRECTION_SOURCE_TIME', '供应商更正取得时间早于原发布，不能倒填。');
    }
    const revisions: WfdRecord = {};
    for (const item of originals) {
      revisions[item.businessKey] = { previous: { product_id: item.productId, snapshot_id: item.snapshotId,
        logical_key: item.businessKey, revision_id: item.recordVersion }, reason: input.reason };
    }
    const identity = { dataset_id: String((originalDocument.request_identity as WfdRecord).dataset_id),
      trusted_actor_namespace: String((originalDocument.request_identity as WfdRecord).trusted_actor_namespace),
      request_id: `correction:${caseId}`, submission_digest: 'sha256:' + '0'.repeat(64) };
    const structured: R1StructuredRequest = {
      datasetId: identity.dataset_id, namespace: identity.trusted_actor_namespace,
      producerNamespace: identity.trusted_actor_namespace, requestId: identity.request_id,
      submissionDigest: identity.submission_digest,
      expectedParentSnapshotId: input.expectedParentSnapshotId,
      outputKey: String(output.output_key), subject: output.subject as WfdRecord,
      definition: (output.definition ?? {}) as WfdRecord, inputMode: row.kind,
      coverage: output.coverage as WfdRecord,
      definitionMode: 'reuse', definitionRef: this.originalDefinitionRef(
        String(originals[0]!.requestId), String(originals[0]!.productId), originals[0]!.definitionDigest),
      payload: { kind: String(rows.kind), rows: corrected }, revisions };
    let document = buildStructuredIngestDocument(structured) as WfdRecord;
    const unsigned = structuredClone(document);
    delete (unsigned.request_identity as WfdRecord).submission_digest;
    const submissionDigest = 'sha256:' + wfdSha256(canonicalWfdJson(unsigned));
    document = { ...document, request_identity: { ...identity, submission_digest: submissionDigest } };
    if (Buffer.byteLength(canonicalWfdJson(document)) > this.capabilities().maxDocumentBytes)
      fail('CORRECTION_DOCUMENT_BUDGET', '修复文档超过预算；未截断提交。');
    const documentSha256 = wfdSha256(canonicalWfdJson(document));
    const frozen = { version: POST_PUBLICATION_CORRECTION_VERSION, caseId, kind: row.kind,
      impactSha256: row.impact_sha256, errorBindingDigest: wfdSha256(canonicalWfdJson(
        JSON.parse(row.binding_json) as WfdRecord)),
      connectionSha256: row.connection_sha256, adapterConfigDigest: isWfdRecord(newAdapter) ? String(newAdapter.configDigest ?? '') : '',
      planId: input.planId, outputId: input.outputId, originalSha256: input.originalSha256,
      materialId, originalRequestId: String(originals[0]!.requestId),
      sourceRevision: input.sourceRevision ?? null, expectedParentSnapshotId: input.expectedParentSnapshotId,
      document, documentSha256, requestIdentity: document.request_identity, valueFields,
      revisionCount: (document.outputs as WfdRecord[]).reduce((count, item) =>
        count + Object.keys((item.revisions as WfdRecord) ?? {}).length, 0),
      budget: { max_rows: Math.max(1, originals.length),
        max_document_bytes: this.capabilities().maxDocumentBytes,
        series_count: (document.outputs as WfdRecord[]).length } };
    const frozenSha256 = wfdSha256(canonicalWfdJson(frozen as unknown as WfdRecord));
    this.db.prepare(`UPDATE correction_cases SET state='prepared',frozen_json=?,frozen_sha256=?,confirmation_digest=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(frozen as unknown as WfdRecord), frozenSha256, documentSha256, Date.now(), caseId);
    return { view: this.view(caseId), documentSha256, frozenSha256 };
  }

  /** 真实审批：冻结摘要改变需重新确认；拒绝/取消不写正式库、不解除限制。 */
  authorize(caseId: string, frozenSha256: string, confirmationDigest: string, operator: OperatorContext): TaskRecord {
    assertOperator(operator);
    const row = this.require(caseId);
    if (!['prepared', 'authorization_pending', 'authorization_rejected'].includes(row.state))
      fail('CORRECTION_STATE', '只有已冻结的修复清单可提交审批。');
    this.assertConnection(row);
    if (row.frozen_sha256 !== frozenSha256 || row.confirmation_digest !== confirmationDigest)
      fail('CORRECTION_CONFIRMATION_CHANGED', '冻结摘要或确认摘要变化；须重新核对并重新确认。');
    let attempt = 1;
    const previous = row.authorization_task_id ? this.tasks.get(row.authorization_task_id) : undefined;
    if (previous && ['waiting_approval', 'running', 'ready', 'blocked'].includes(previous.status)) return previous;
    if (previous) {
      // 拒绝/取消后可以凭显式的新授权请求重新办理；自动重试、查询状态、恢复都不能新增授权。
      if (!['failed', 'cancelled'].includes(previous.status))
        fail('CORRECTION_AUTHORIZATION_SETTLED', '原审批任务已成功收束；不自动重试或新建授权。');
      const counted = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE action='data.correction.repair'
        AND json_extract(args,'$.caseId')=?`).get(caseId) as { n: number } | undefined;
      attempt = Number(counted?.n ?? 0) + 1;
    } else if (row.state !== 'prepared') {
      fail('CORRECTION_STATE', '原审批任务身份缺失；不能凭旧状态自动重办。');
    }
    if (previous || row.state !== 'prepared') {
      this.db.prepare(`UPDATE correction_cases SET state='prepared',authorization_task_id=NULL,repair_task_id=NULL,updated_at=? WHERE case_id=?`)
        .run(Date.now(), caseId);
    }
    let created!: { task: TaskRecord; publish(): void };
    this.options.database.transaction(() => {
      created = this.tasks.createInTransaction({ title: '已发布错误更正：按冻结清单办理原因化精确前驱修订',
        ownerRole: 'service', runtimeId: POST_PUBLICATION_CORRECTION_RUNTIME, action: 'data.correction.repair',
        args: { caseId, frozenSha256, confirmationDigest },
        requestId: `correction:${caseId}:attempt-${attempt}`,
        versions: { correction: POST_PUBLICATION_CORRECTION_VERSION, connection: row.connection_sha256,
          frozen: frozenSha256, document: confirmationDigest } });
      this.db.prepare(`UPDATE correction_cases SET state='authorization_pending',authorization_task_id=?,repair_task_id=?,updated_at=? WHERE case_id=?`)
        .run(created.task.id, created.task.id, Date.now(), caseId);
    });
    created.publish();
    return this.tasks.start(created.task.id, created.task.version);
  }

  /**
   * 重开恢复：只沿原冻结文档的 request_identity 查询/消费 WFD 已落盘结果，
   * 不新建请求号、不新增授权、不因恢复产生第二次正式替代。
   */
  /** 暂停写成功但响应与状态都失联：按原冻结声明幂等重取暂停，不新建事项。 */
  private async recoverSuspension(caseId: string, row: CaseRow): Promise<WfdRecord> {
    if (row.state !== 'suspend_failed') fail('CORRECTION_STATE', '该事项不在暂停失败状态。');
    this.assertConnection(row);
    if (!row.impact_json) fail('CORRECTION_STATE', '缺少冻结影响清单，不能恢复暂停。');
    const impact = JSON.parse(row.impact_json) as { items: ImpactItem[]; gaps: string[] };
    const declaration = this.suspensionDeclaration(row, impact);
    let receipt: WfdRecord;
    try {
      receipt = (await this.machine.usageSuspend(declaration)).result as WfdRecord;
      if (!isWfdRecord(receipt) || receipt.state !== 'active' || typeof receipt.issue_digest !== 'string')
        fail('CORRECTION_WFD_SUSPEND_RECEIPT', 'WFD 暂停恢复回执不完整；保持未完成。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError('CORRECTION_SUSPEND_RECOVERY_FAILED',
        '原暂停声明仍不可用；保留 suspend_failed，不换事项/不换号。' + message);
    }
    const gaps = (JSON.parse(row.gaps_json) as string[]).filter(gap =>
      !gap.startsWith('wfd_suspend_failed:') && !gap.startsWith('suspend_scope_incomplete:'));
    this.db.prepare(`UPDATE correction_cases SET state='suspended',suspension_json=?,gaps_json=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(receipt), canonicalWfdJson(gaps), Date.now(), caseId);
    return this.view(caseId) as unknown as WfdRecord;
  }

  async recoverRepair(caseId: string, operator: OperatorContext): Promise<WfdRecord> {
    assertOperator(operator);
    const row = this.require(caseId);
    if (row.state === 'suspend_failed') return this.recoverSuspension(caseId, row);
    this.assertConnection(row);
    if (!['repairing', 'blocked', 'verified', 'authorization_pending'].includes(row.state))
      fail('CORRECTION_STATE', '只有发送后未收束的更正事项可沿原号恢复。');
    if (!row.frozen_json) fail('CORRECTION_STATE', '缺少冻结文档，不能恢复发送。');
    const frozen = JSON.parse(row.frozen_json) as FrozenRepair;
    if (wfdSha256(canonicalWfdJson(frozen as unknown as WfdRecord)) !== row.frozen_sha256)
      fail('CORRECTION_FROZEN_CHANGED', '持久冻结清单摘要不符。');
    const document = frozen.document;
    if (wfdSha256(canonicalWfdJson(document)) !== frozen.documentSha256
      || frozen.documentSha256 !== row.confirmation_digest)
      fail('CORRECTION_DOCUMENT_CHANGED', '文档与冻结确认摘要不一致；未恢复。');
    let persisted: WfdRecord | null = null;
    try { persisted = row.result_json ? JSON.parse(row.result_json) as WfdRecord : null; } catch { persisted = null; }
    const persistedResult = persisted && isWfdRecord(persisted.wfd_result) ? persisted.wfd_result : null;
    if (persisted && String(persisted.state) === 'resolved' && !persistedResult) {
      const items = this.db.prepare(`SELECT state FROM correction_items WHERE case_id=?`).all(caseId) as unknown as { state: string }[];
      if (items.length && items.every(item => item.state === 'corrected')) return persisted;
    }
    // 签票写入成功但响应丢失：审批已批准后沿同一 ticket_id/文档重取幂等票据，
    // 不重启审批、不换号；只有未批准/拒绝/取消才不允许恢复。
    if (!persistedResult && ['blocked', 'authorization_pending'].includes(row.state)) {
      const task = row.authorization_task_id ? this.tasks.get(row.authorization_task_id) : undefined;
      if (task && ['waiting_approval', 'running', 'ready', 'blocked'].includes(task.status))
        fail('CORRECTION_APPROVAL_PENDING', '审批仍在进行；不能绕过审批恢复签票。');
      const approved = task?.status === 'succeeded' || (row.authorization_task_id
        && this.approvalWasApproved(row.authorization_task_id));
      if (!approved) fail('CORRECTION_AUTHORIZATION_NOT_APPROVED', '原审批没有批准记录；不能恢复签票。');
      let ticket: WfdRecord;
      try { ticket = await this.authorizeFrozenTicket(caseId, row, frozen, document); }
      catch (error) {
        this.markUnknown(caseId, 'ticket_unknown', error);
        throw new TaskError('CORRECTION_TICKET_UNKNOWN',
          '签票结果未知；已保留原票据编号与冻结文档，重开只按同一声明恢复。');
      }
      if (String(ticket.state) !== 'authorized')
        fail('CORRECTION_TICKET_REJECTED', 'WFD 未签发精确修复票据；未提交修订。');
      this.db.prepare(`UPDATE correction_cases SET state='repairing',updated_at=? WHERE case_id=?`).run(Date.now(), caseId);
      return this.commitRepair(caseId, row, frozen, document);
    }
    const status = (await this.machine.usageStatus()).result as WfdRecord;
    const issue = (Array.isArray(status.issues) ? status.issues.filter(isWfdRecord) : [])
      .find(item => item.issue_id === caseId);
    let wfd: WfdRecord;
    if (persistedResult) {
      wfd = persistedResult;
    } else {
      try {
        wfd = (await this.client.requestStatus(document.request_identity as WfdRecord)).result as WfdRecord;
      } catch (error) {
        this.markUnknown(caseId, 'status_unavailable', error);
        throw new TaskError('CORRECTION_OUTCOME_UNKNOWN',
          '重开后原号状态不可查；保留原请求身份，不换号重发。');
      }
    }
    const payloadComplete = wfd && String(wfd.state) === 'published_formal'
      && Array.isArray(wfd.output_results) && wfd.output_results.length > 0;
    if (!payloadComplete) {
      if (issue && String(issue.state) === 'resolved' && persisted)
        fail('CORRECTION_RECOVERY_RESULT_MISSING', '事项已解决但本地缺已发布回执/输出；未假装收口，保持待补证。');
      this.markUnknown(caseId, String(wfd?.state ?? 'unknown'));
      fail('CORRECTION_OUTCOME_UNKNOWN', '原号仍未收束为可核的正式发布；保持 blocked，不重发、不解决。');
    }
    this.db.prepare(`UPDATE correction_cases SET state='repairing',updated_at=? WHERE case_id=?`).run(Date.now(), caseId);
    return this.commitRepair(caseId, row, frozen, document, undefined, wfd);
  }

  /** 只从当前计划已完成的固定结构产物取值；正文/摘要不能冒充实际加工。 */
  private repairOutputRows(planId: string, outputId: string): WfdRecord[] {
    let artifact: { bytes: Buffer; ref?: { sha256?: string } };
    try { artifact = this.options.processing.outputArtifact(planId, outputId); }
    catch { return fail('CORRECTION_REPAIR_OUTPUT_NOT_READY', '修复计划输出尚未完成结构化核对，不能准备更正。'); }
    let parsed: WfdRecord;
    try { parsed = JSON.parse(artifact.bytes.toString('utf8')) as WfdRecord; }
    catch { return fail('CORRECTION_REPAIR_OUTPUT_UNREADABLE', '修复计划结构产物不可读。'); }
    if (!isWfdRecord(parsed) || !Array.isArray(parsed.rows) || !parsed.rows.length)
      fail('CORRECTION_REPAIR_OUTPUT_EMPTY', '修复计划结构产物没有数据行。');
    return (parsed.rows as unknown[]).map((row, index) => {
      if (!isWfdRecord(row)) return fail('CORRECTION_REPAIR_OUTPUT_ROW', `修复输出第 ${index + 1} 行不是对象。`);
      return row;
    });
  }

  /**
   * 以原发布行身份/单位/期间/主体为模板，只覆盖实际新加工产物给出的值。
   * 业务键集合必须完全一致；实际产物若显式改写身份字段则拒绝。
   */
  private mergeCorrectedRows(previousRows: WfdRecord[], actualRows: WfdRecord[], kind: CorrectionKind,
    tabularMapping?: { fields: Map<string, { value: string; state?: string }>; businessKey?: string }): WfdRecord[] {
    const keyOf = (row: WfdRecord) => String(row.business_key ?? (tabularMapping?.businessKey ? row[tabularMapping.businessKey] : '') ?? '');
    const previous = new Map(previousRows.map(row => [keyOf(row), row]));
    const actual = new Map(actualRows.map(row => [keyOf(row), row]));
    if (previous.size !== previousRows.length || actual.size !== actualRows.length
      || [...previous.keys()].some(key => !key))
      fail('CORRECTION_IDENTITY_CHANGED', '原发布行或新加工产物的业务键不唯一；不得改变身份。');
    if ([...actual.keys()].some(key => !previous.has(key)))
      fail('CORRECTION_IDENTITY_CHANGED', '新加工产物包含原发布输出之外的业务键；未按其他输出冒充本项更正。');
    if (tabularMapping) {
      const merged: WfdRecord[] = [];
      let changed = 0;
      for (const [key, original] of previous) {
        const values = original.values;
        if (!isWfdRecord(values)) fail('CORRECTION_TABULAR_VALUES', `原表格行 ${key} 缺少 values 合同。`);
        const producedRow = actual.get(key);
        // 更正原件可以只包含实际更正的业务键；未出现的原行按原值原样保留，
        // 不凭缺失行推断删除或新值。
        if (!producedRow) { merged.push(structuredClone(original)); continue; }
        const next = structuredClone(original), nextValues = structuredClone(values);
        for (const [fieldCode, rule] of tabularMapping.fields) {
          const cell = nextValues[fieldCode];
          if (!isWfdRecord(cell)) fail('CORRECTION_TABULAR_FIELD', `原表格行 ${key} 缺少字段 ${fieldCode}。`);
          const raw = producedRow[rule.value];
          if (raw === undefined || raw === null || isWfdRecord(raw))
            fail('CORRECTION_TABULAR_VALUE', `修复产物第 ${key} 行缺少字段 ${rule.value}。`);
          const text = String(raw);
          if (['decimal', 'integer'].includes(String(cell.data_type))
            && !/^-?(0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(text))
            fail('CORRECTION_DECIMAL_REQUIRED', `修复产物第 ${key} 行 ${rule.value} 不是精确十进制。`);
          const state = rule.state ? producedRow[rule.state] : cell.value_state;
          if (typeof state !== 'string' || !state.trim())
            fail('CORRECTION_TABULAR_STATE', `修复产物第 ${key} 行 ${rule.value} 缺明确值状态。`);
          nextValues[fieldCode] = { ...cell, value: text, value_state: state };
        }
        next.values = nextValues;
        if (canonicalWfdJson(next as never) !== canonicalWfdJson(original as never)) changed++;
        merged.push(next);
      }
      if (!changed) fail('CORRECTION_NOT_CHANGED', '新加工产物与原发布表格值相同，不登记无实际更正。');
      return merged;
    }
    const valueField = previousRows[0] && Object.hasOwn(previousRows[0], 'value_decimal') ? 'value_decimal'
      : previousRows[0] && Object.hasOwn(previousRows[0], 'value') ? 'value' : null;
    if (!valueField) fail('CORRECTION_VALUE_FIELD', '原发布行没有可核的数值字段，不能按本接口更正。');
    const identityFields = ['unit_code', 'unit', 'subject', 'frequency', 'period', 'definition', 'product_id'];
    const merged: WfdRecord[] = [];
    let changed = 0;
    for (const [key, original] of previous) {
      const produced = actual.get(key);
      if (!produced) { merged.push(structuredClone(original)); continue; }
      const value = produced[valueField];
      if (typeof value !== 'string' && typeof value !== 'number')
        fail('CORRECTION_VALUE_FIELD', `新加工产物第 ${key} 行缺少可核数值。`);
      const text = String(value);
      if (!/^-?(0|[1-9]\d*)(\.\d+)?(?:[eE][+-]?\d+)?$/u.test(text))
        fail('CORRECTION_DECIMAL_REQUIRED', `新加工产物第 ${key} 行不是精确十进制数值。`);
      for (const field of identityFields) {
        if (produced[field] !== undefined && canonicalWfdJson(produced[field] as never) !== canonicalWfdJson(original[field] as never))
          fail('CORRECTION_IDENTITY_CHANGED', `新加工产物改写了第 ${key} 行的 ${field}；须转契约处理。`);
      }
      const next = structuredClone(original);
      next[valueField] = text;
      if (produced.value_state !== undefined) next.value_state = produced.value_state;
      if (canonicalWfdJson(next as never) !== canonicalWfdJson(original as never)) changed++;
      merged.push(next);
    }
    if (!changed) fail('CORRECTION_NOT_CHANGED', '新加工产物与原发布值相同，不登记无实际更正的修复。');
    return merged;
  }

  /** 记录每个业务键实际更正的字段；表格行按 values 内逐字段比较，标量按顶层值。 */
  private correctedValueFields(previousRows: WfdRecord[], correctedRows: WfdRecord[]): WfdRecord {
    const previous = new Map(previousRows.map(row => [String(row.business_key), row]));
    const fields: WfdRecord = {};
    for (const row of correctedRows) {
      const key = String(row.business_key), before = previous.get(key);
      if (!before) continue;
      const rowValues = row.values, beforeValues = before.values;
      if (isWfdRecord(rowValues) && isWfdRecord(beforeValues)) {
        fields[key] = Object.keys(rowValues).filter(field => canonicalWfdJson(rowValues[field] as never)
          !== canonicalWfdJson(beforeValues[field] as never));
      } else {
        const field = Object.hasOwn(row, 'value_decimal') ? 'value_decimal' : 'value';
        fields[key] = [field];
      }
    }
    return fields;
  }

  /**
   * 为已证明受影响的派生输出构造原因化修订：按原固定 proof 的完整窗口与
   * 原方法版本，用更正后真实输入值精确重算；只替换受影响行的输出窗口。
   * 缺 proof/未知算法/窗口仍未知时整项保持未完成，不生成假替代。
   */
  private originalDefinitionRef(requestId: string, productId: string, digest: string): WfdRecord {
    const attempt = this.db.prepare('SELECT receipt_json,document_json FROM r1_handoff_attempts WHERE request_id=?')
      .get(requestId) as { receipt_json: string | null; document_json: string } | undefined;
    const candidates: unknown[] = [];
    if (attempt?.receipt_json) {
      try {
        const receipt = JSON.parse(attempt.receipt_json) as WfdRecord;
        candidates.push(...(Array.isArray(receipt.output_results) ? receipt.output_results : []));
      } catch { /* 下面继续用不可变文档核对 */ }
    }
    if (attempt?.document_json) {
      try {
        const document = JSON.parse(attempt.document_json) as WfdRecord;
        candidates.push(...(Array.isArray(document.outputs) ? document.outputs : []));
      } catch { /* 无完整回执则明确失败 */ }
    }
    for (const candidate of candidates) {
      if (!isWfdRecord(candidate)) continue;
      if (candidate.product_id !== undefined && String(candidate.product_id) !== productId) continue;
      const ref = candidate.definition_ref;
      if (isWfdRecord(ref) && String(ref.digest ?? '').replace(/^sha256:/u, '')
        === digest.replace(/^sha256:/u, '') && typeof ref.kind === 'string'
        && typeof ref.namespace === 'string' && typeof ref.id === 'string')
        return ref;
    }
    // R1 receipt 只保留 definition_digest；完整 ref 仍在 WFD 已登记产品文件中。
    try {
      const store = this.options.runtime.currentIdentity().store;
      const product = JSON.parse(readFileSync(join(store, 'catalog/product_service/products', productId + '.json'),
        'utf8')) as WfdRecord;
      const ref = product.definition_ref;
      if (isWfdRecord(ref) && String(ref.digest ?? '').replace(/^sha256:/u, '') === digest.replace(/^sha256:/u, '')
        && typeof ref.kind === 'string' && typeof ref.namespace === 'string' && typeof ref.id === 'string')
        return ref;
    } catch { /* 下面明确失败，不构造假引用 */ }
    return fail('CORRECTION_DEFINITION_REF', '找不到原发布回执/已登记产品中的完整定义引用；不能以裸摘要冒充已采用定义。');
  }

  /** 原发布文档可能含多个输出；按实际 payload 业务键定位，不按数组下标猜。 */
  private originalOutputForItem(document: WfdRecord, item: ImpactItem): WfdRecord {
    const outputs = Array.isArray(document.outputs) ? document.outputs.filter(isWfdRecord) : [];
    const matches = outputs.filter(output => {
      const payload = output.payload;
      if (!isWfdRecord(payload) || !Array.isArray(payload.rows)) return false;
      return payload.rows.some(row => isWfdRecord(row) && String(row.business_key) === item.businessKey);
    });
    if (matches.length !== 1)
      fail('CORRECTION_ORIGINAL_OUTPUT', `原发布文档中业务键 ${item.businessKey} 对应 ${matches.length} 个输出；不能确定唯一前驱。`);
    return matches[0]!;
  }

  private originalDocument(requestId: string): WfdRecord {
    const attempt = this.db.prepare('SELECT document_json FROM r1_handoff_attempts WHERE request_id=?').get(requestId) as
      { document_json: string } | undefined;
    if (!attempt) fail('CORRECTION_ORIGINAL_DOCUMENT', '找不到原发布不可变文档，不能重标后提交。');
    try { return JSON.parse(attempt.document_json) as WfdRecord; }
    catch { return fail('CORRECTION_ORIGINAL_DOCUMENT', '原发布文档不可读。'); }
  }

  private assertConnection(row: CaseRow): void {
    if (this.connectionDigest() !== row.connection_sha256)
      fail('CORRECTION_CONNECTION_CHANGED', '当前连接、配置或入口与事项冻结身份不同；未换连接重放。');
  }

  list(): CorrectionView[] {
    return (this.db.prepare('SELECT case_id FROM correction_cases ORDER BY created_at DESC,rowid DESC').all() as { case_id: string }[])
      .map(entry => this.view(entry.case_id));
  }
  view(caseId: string): CorrectionView {
    const row = this.require(caseId);
    const items = (this.db.prepare('SELECT * FROM correction_items WHERE case_id=? ORDER BY item_id').all(caseId) as unknown as {
      item_id: string; kind: string; product_id: string; snapshot_id: string; definition_digest: string;
      business_key: string; record_version: string; state: string; gaps_json: string; verification_json: string | null }[])
      .map(item => ({ itemId: item.item_id, kind: item.kind, productId: item.product_id,
        snapshotId: item.snapshot_id, definitionDigest: item.definition_digest, businessKey: item.business_key,
        recordVersion: item.record_version, state: item.state, gaps: JSON.parse(item.gaps_json),
        verification: item.verification_json ? JSON.parse(item.verification_json) : null }));
    return { caseId: row.case_id, kind: row.kind, errorType: row.error_type, discoveredAt: row.discovered_at,
      evidence: row.evidence, binding: JSON.parse(row.binding_json) as CorrectionBinding, state: row.state,
      gaps: JSON.parse(row.gaps_json), impactSha256: row.impact_sha256, itemCount: items.length,
      items: items as unknown as WfdRecord[], suspension: row.suspension_json ? JSON.parse(row.suspension_json) as WfdRecord : null,
      frozenSha256: row.frozen_sha256, confirmationDigest: row.confirmation_digest,
      authorizationTaskId: row.authorization_task_id, repairTaskId: row.repair_task_id,
      result: row.result_json ? JSON.parse(row.result_json) as WfdRecord : null,
      coverage: 'proven_subset_only' };
  }
  private require(caseId: string): CaseRow {
    id(caseId);
    return this.row(caseId) ?? fail('CORRECTION_CASE_NOT_FOUND', '没有该更正事项。');
  }

  /** 真实 TaskService 运行时：审批通过后一次性完成正式替代，逐项验收后才解禁对应新版本。 */
  readonly runtime: TaskRuntime = { id: POST_PUBLICATION_CORRECTION_RUNTIME, execute: async context => {
    const args = context.task.args as { caseId?: unknown; frozenSha256?: unknown; confirmationDigest?: unknown };
    const caseId = String(args.caseId ?? '');
    const row = this.require(caseId);
    // 真实审批必须声明明确权限目标：本次正式替代写入的 WFD store 目录。
    const store = this.options.runtime.currentIdentity().store;
    const capability = { action: 'write' as const,
      target: { kind: 'directory' as const, path: store, recursive: true } };
    const authority = await acquireAuthority(context, context.task.action, context.task.args as never,
      [capability], { approvalMode: 'review' });
    authority.assert();
    if (!authority.approvalId) fail('CORRECTION_AUTHORITY_REQUIRED', '更正发布须有本机真实审批回执；模型不能自批准。');
    if (row.state !== 'authorization_pending' || row.frozen_sha256 !== args.frozenSha256
      || row.confirmation_digest !== args.confirmationDigest)
      fail('CORRECTION_FROZEN_CHANGED', '冻结清单或确认摘要在审批期间变化；未继续发布。');
    this.assertConnection(row);
    const frozen = JSON.parse(row.frozen_json!) as FrozenRepair;
    if (wfdSha256(canonicalWfdJson(frozen as unknown as WfdRecord)) !== row.frozen_sha256)
      fail('CORRECTION_FROZEN_CHANGED', '持久冻结清单摘要不符。');
    const document = frozen.document;
    if (wfdSha256(canonicalWfdJson(document)) !== frozen.documentSha256
      || frozen.documentSha256 !== row.confirmation_digest)
      fail('CORRECTION_DOCUMENT_CHANGED', '文档与冻结确认摘要不一致；未发送。');
    const status = (await this.machine.usageStatus()).result as WfdRecord;
    const activeIds = new Set((Array.isArray(status.issues) ? status.issues.filter(isWfdRecord) : [])
      .filter(issue => issue.state === 'active').map(issue => String(issue.issue_id)));
    if (!activeIds.has(caseId))
      fail('CORRECTION_SUSPENSION_MISSING', 'WFD 当前持久事项中没有生效的原报/派生暂停；未发布。');
    let ticket: WfdRecord;
    try { ticket = await this.authorizeFrozenTicket(caseId, row, frozen, document); }
    catch (error) {
      this.markUnknown(caseId, 'ticket_unknown', error);
      throw error;
    }
    if (ticket.state !== 'authorized')
      fail('CORRECTION_TICKET_REJECTED', 'WFD 未签发精确修复票据；未提交修订。');
    this.db.prepare(`UPDATE correction_cases SET state='repairing',updated_at=? WHERE case_id=?`).run(Date.now(), caseId);
    let result: WfdRecord;
    try { result = await this.commitRepair(caseId, row, frozen, document, context.signal); }
    catch (error) {
      this.markRepairFailure(caseId, error);
      throw error;
    }
    authority.assert();
    return { summary: `更正事项 ${caseId}：${result.state}`, data: result as unknown as import('../../contracts/task-contracts.js').JsonValue };
  } };

  /** 只读 task_events 的最终审批决定；恢复签票不得把拒绝/取消当成批准。 */
  private approvalWasApproved(taskId: string): boolean {
    const row = this.db.prepare(`SELECT data FROM task_events WHERE task_id=? AND type='APPROVAL_RESOLVED'
      ORDER BY sequence DESC LIMIT 1`).get(taskId) as { data: string } | undefined;
    if (!row) return false;
    try { return String((JSON.parse(row.data) as WfdRecord).decision) === 'approved'; }
    catch { return false; }
  }

  /** 同一冻结文档/票据编号的签票；WFD 同声明幂等，供首次与丢响应恢复共用。 */
  private async authorizeFrozenTicket(caseId: string, row: CaseRow, frozen: FrozenRepair,
    document: WfdRecord): Promise<WfdRecord> {
    assertRepairScope(frozen, document);
    const predecessorRefs = (document.outputs as WfdRecord[]).flatMap(output =>
      Object.values(output.revisions as WfdRecord)).map(entry => {
      const previous = (entry as WfdRecord).previous as WfdRecord;
      return { product_id: String(previous.product_id), snapshot_id: String(previous.snapshot_id),
        logical_key: String(previous.logical_key), revision_id: String(previous.revision_id) };
    });
    return (await this.machine.usageAuthorizeRepair({ ticket_id: `ticket:${caseId}`, issue_id: caseId,
      document_digest: frozen.documentSha256, request_identity: document.request_identity,
      revisions: predecessorRefs, confirmation_digest: frozen.documentSha256, repair_mode: row.kind,
      error_binding_digest: frozen.errorBindingDigest, impact_digest: frozen.impactSha256,
      budget: frozen.budget })).result as WfdRecord;
  }

  private async commitRepair(caseId: string, row: CaseRow, frozen: FrozenRepair,
    document: WfdRecord, signal?: AbortSignal, preloaded?: WfdRecord): Promise<WfdRecord> {
    signal?.throwIfAborted();
    assertRepairScope(frozen, document);
    let result: WfdRecord;
    if (preloaded) {
      result = preloaded;
    } else {
      // 原号提交；发送后结果未知沿同一 request_identity 查询，不换号、不重发。
      try { result = (await this.client.submit(document, signal)).result as WfdRecord; }
      catch (error) {
        let state: WfdRecord | undefined;
        try {
          state = (await this.client.requestStatus(document.request_identity as WfdRecord, signal)).result as WfdRecord;
        } catch (statusError) {
          this.markUnknown(caseId, 'publication_unknown', error, statusError);
          throw new TaskError('CORRECTION_OUTCOME_UNKNOWN',
            '发送后结果未知且原号状态不可查；保留原请求身份，重开恢复，不换号重发。');
        }
        if (!state || String(state.state) !== 'published_formal') {
          this.markUnknown(caseId, String(state?.state ?? 'unknown'), error);
          fail('CORRECTION_RECEIPT_PENDING', '未获得正式发布回执；保留原请求待原号核对，不重发、不宣布完成。');
        }
        result = state;
      }
    }
    const settled = String(result.state ?? '');
    if (settled !== 'published_formal') {
      this.markUnknown(caseId, settled);
      fail('CORRECTION_RECEIPT_PENDING', '未获得正式发布回执；保留原请求待原号核对，不重发、不宣布完成。');
    }
    const newSnapshotId = String((result.output_results as WfdRecord[])[0]?.snapshot_id ?? '');
    if (!newSnapshotId) fail('CORRECTION_RECEIPT_INCOMPLETE', '回执缺少新快照。');
    const docOutputs = document.outputs as WfdRecord[];
    const resultOutputs = result.output_results as WfdRecord[];
    const verifiedOutputs: WfdRecord[] = [];
    const readbackByRow = new Map<string, { output: WfdRecord; row: WfdRecord }>();
    const allRecords: WfdRecord[] = [];
    let oldSnapshotId = '';
    for (const docOutput of docOutputs) {
      const output = resultOutputs.find(item => String(item.output_key) === String(docOutput.output_key));
      if (!output) fail('CORRECTION_RECEIPT_INCOMPLETE', `回执缺少输出 ${String(docOutput.output_key)}。`);
      if (String(output.snapshot_id) !== newSnapshotId)
        fail('CORRECTION_RECEIPT_INCONSISTENT', '同一文档的输出落在不同快照；未建立替代。');
      const records = (output.records ?? []) as WfdRecord[];
      const productId = String(output.product_id ?? '');
      if (!records.length || !productId) fail('CORRECTION_RECEIPT_INCOMPLETE', '回执缺少逐行新版本或产品身份。');
      const fixed = (await this.client.fixedRead(newSnapshotId, productId, signal)).result as WfdRecord;
      const fixedRows = (fixed.rows ?? []) as WfdRecord[];
      const docRevisions = docOutput.revisions as WfdRecord;
      const docRows = (docOutput.payload as WfdRecord).rows as WfdRecord[];
      const expected = new Map<string, WfdRecord>(docRows.map(item => [String(item.business_key), item]));
      const fixedByKey = new Map<string, WfdRecord>(fixedRows.map(item =>
        [String((item.record_ref as WfdRecord).logical_key), item]));
      if (fixedByKey.size !== fixedRows.length)
        fail('CORRECTION_READBACK_COUNT', '固定读回存在重复业务键；不能确定唯一当前行。');
      // 产品可能同时包含本批未更正的其他记录；
      // 只要求冻结文档中的每个业务键都有当前叶子，不把无关行当成本次更正遗漏。
      for (const key of expected.keys())
        if (!fixedByKey.has(key)) fail('CORRECTION_READBACK_COUNT', `第 ${key} 行没有固定读回当前叶子。`);
      const hasTabular = isWfdRecord(docRows[0]?.values);
      const valueField = docRows[0] && Object.hasOwn(docRows[0], 'value_decimal') ? 'value_decimal'
        : docRows[0] && Object.hasOwn(docRows[0], 'value') ? 'value' : null;
      if (!hasTabular && !valueField) fail('CORRECTION_VALUE_FIELD', '冻结文档没有可核数值字段。');
      for (const actual of fixedRows) {
        const ref = actual.record_ref as WfdRecord;
        const key = String(ref.logical_key);
        const wanted = expected.get(key);
        if (!wanted) continue;
        const actualRow = actual.row as WfdRecord;
        if (isWfdRecord(wanted.values)) {
          const actualValues = actualRow.values;
          if (!isWfdRecord(actualValues)) fail('CORRECTION_READBACK_VALUE', `第 ${key} 行固定读回缺表格 values。`);
          const fields = (frozen.valueFields?.[key] as unknown) ?? Object.keys(wanted.values);
          if (!Array.isArray(fields)) fail('CORRECTION_READBACK_VALUE', `第 ${key} 行更正字段记录不可读。`);
          for (const field of fields.map(String)) {
            const expectedCell = wanted.values[field], actualCell = actualValues[field];
            if (!isWfdRecord(expectedCell) || !isWfdRecord(actualCell)
              || String(actualCell.value) !== String(expectedCell.value)
              || String(actualCell.value_state) !== String(expectedCell.value_state))
              fail('CORRECTION_READBACK_VALUE', `第 ${key} 行字段 ${field} 固定读回值或状态不符。`);
          }
        } else if (String(actualRow[valueField!]) !== String(wanted[valueField!])) {
          fail('CORRECTION_READBACK_VALUE', `第 ${key} 行固定读回值或身份不符。`);
        }
        const revision = actual.revision as WfdRecord | undefined;
        const previous = docRevisions[key] as WfdRecord;
        if (!revision || !(previous.previous as WfdRecord)
          || String(revision.supersedes) !== String((previous.previous as WfdRecord).revision_id))
          fail('CORRECTION_PREDECESSOR_MISMATCH', `第 ${key} 行没有精确替代原记录版本。`);
      }
      if (!oldSnapshotId) oldSnapshotId = String((((docRevisions[Object.keys(docRevisions)[0]!] as WfdRecord)
        .previous) as WfdRecord).snapshot_id);
      const verifiedOutput = { outputKey: String(docOutput.output_key), productId, records,
        fixedRows, snapshotId: newSnapshotId, valueField: valueField ?? '', tabular: hasTabular,
        definitionDigest: String((output.definition_ref as WfdRecord)?.digest ?? '') };
      verifiedOutputs.push(verifiedOutput);
      for (const key of expected.keys()) readbackByRow.set(canonicalWfdJson([productId, key]),
        { output: verifiedOutput, row: fixedByKey.get(key)! });
      allRecords.push(...records);
    }
    // 旧固定快照显式审计复现：原值不变，带当前已知问题说明且不可发布。
    const firstProduct = String(verifiedOutputs[0]!.productId);
    const audit = await this.audit(caseId, oldSnapshotId, firstProduct);
    if ((audit.usage_governance as WfdRecord).publishable !== undefined) {
      const gov = audit.usage_governance as WfdRecord;
      if (gov.publishable !== false || gov.compute_eligible !== false)
        fail('CORRECTION_AUDIT_ELIGIBLE', '旧快照审计复现被标记为可发布或可计算。');
    }
    const verification = { caseId, state: 'fix_readback_verified', newSnapshotId,
      products: verifiedOutputs.map(item => item.productId), recordCount: allRecords.length,
      oldSnapshotId, oldSnapshotRetained: true, oldIssueRetained: true,
      ...(frozen.recompute ? { recomputed: [], methodVersionsPreserved: true } : {}),
      substitution: allRecords.map(item => ({ recordId: item.record_id, recordVersion: item.record_version })) };
    const verificationDigest = wfdSha256(canonicalWfdJson(verification as unknown as WfdRecord));
    const items = this.db.prepare(`SELECT item_id,kind,business_key,product_id,record_version FROM correction_items WHERE case_id=?
      ORDER BY item_id`).all(caseId) as unknown as { item_id: string; kind: string;
        business_key: string; product_id: string; record_version: string }[];
    // Freeze the per-row readback evidence before asking WFD to resolve the issue.
    const verifiedItems = items.map(item => {
      const verified = readbackByRow.get(canonicalWfdJson([item.product_id, item.business_key]));
      if (!verified) return fail('CORRECTION_ITEM_UNVERIFIED', `事项 ${item.item_id} 没有固定读回身份；未解决。`);
      const { output, row: fixedRow } = verified;
      return { itemId: item.item_id, verificationDigest, caseId, outputKey: output.outputKey,
        productId: item.product_id, definitionDigest: output.definitionDigest, businessKey: item.business_key,
        previousRecordVersion: item.record_version, recordVersion: (fixedRow.record_ref as WfdRecord).revision_id,
        newSnapshotId, state: 'fix_readback_verified' };
    });
    // 先持久已发布但尚未本地收口的结果；解决响应丢失时重开可复用同一 WFD 回执。
    const pendingResult = { state: 'published_pending_local', wfd_result: result, verification };
    this.db.prepare(`UPDATE correction_cases SET result_json=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(pendingResult as unknown as WfdRecord), Date.now(), caseId);
    // 原报通过固定读回后正式解决；旧错误版本限制永久保留。
    let resolvedReceipt: WfdRecord | null = null;
    try {
      resolvedReceipt = (await this.machine.usageResolve({ issue_id: caseId, ticket_id: `ticket:${caseId}`,
        document_digest: frozen.documentSha256, replacement_snapshot_id: newSnapshotId,
        replacement_record_versions: allRecords.map(item => String(item.record_version)),
        verification_digest: verificationDigest, verified_at_utc: new Date().toISOString() })).result as WfdRecord;
    } catch (error) {
      const status = (await this.machine.usageStatus()).result as WfdRecord;
      const issue = (Array.isArray(status.issues) ? status.issues.filter(isWfdRecord) : [])
        .find(entry => entry.issue_id === caseId);
      if (!issue || String(issue.state) !== 'resolved') {
        this.markUnknown(caseId, 'resolve_unknown', error);
        throw new TaskError('CORRECTION_RESOLVE_UNKNOWN',
          '解决响应未知且当前持久事项未核到已解决；保留原请求与已发布回执，不重发。');
      }
    }
    if (resolvedReceipt && String(resolvedReceipt.state) !== 'resolved')
      fail('CORRECTION_RESOLVE_FAILED', 'WFD 未登记已核验的新版本；保持暂停。');
    this.recordCorrectionAssociations(caseId, document, verifiedOutputs, frozen, result);
    const resolved = { ...verification, state: 'resolved', verificationDigest, unfinished: [] };
    this.options.database.transaction(() => {
      const update = this.db.prepare(`UPDATE correction_items SET state='corrected',gaps_json=?,verification_json=?
        WHERE case_id=? AND item_id=?`);
      for (const item of verifiedItems) update.run('[]', canonicalWfdJson(item), caseId, item.itemId);
      this.db.prepare(`UPDATE correction_cases SET state='resolved',gaps_json=?,result_json=?,updated_at=? WHERE case_id=?`)
        .run('[]', canonicalWfdJson(resolved as unknown as WfdRecord), Date.now(), caseId);
    });
    return resolved;
  }

  /**
   * 更正发布成功后写新的 R1 逐行关联（同一 request_identity/不可变文档），
   * 使后续扫描、谱系和固定读回沿正式关联找到新版本，而不是只留客户端回执。
   */
  private recordCorrectionAssociations(caseId: string, document: WfdRecord, verifiedOutputs: WfdRecord[],
    frozen: FrozenRepair, result: WfdRecord): void {
    const identity = document.request_identity as WfdRecord;
    const requestId = String(identity.request_id ?? '');
    const datasetId = String(identity.dataset_id ?? '');
    const namespace = String(identity.trusted_actor_namespace ?? '');
    if (!requestId || !datasetId || !namespace) fail('CORRECTION_ASSOCIATION', '冻结文档缺少 R1 身份。');
    const documentSha256 = wfdSha256(canonicalWfdJson(document));
    const originalRequestId = String(frozen.originalRequestId ?? '');
    const originalAttempt = this.db.prepare('SELECT local_refs_json FROM r1_handoff_attempts WHERE request_id=?')
      .get(originalRequestId) as { local_refs_json: string } | undefined;
    let originalRefs: WfdRecord = {};
    try { originalRefs = originalAttempt ? JSON.parse(originalAttempt.local_refs_json) as WfdRecord : {}; }
    catch { originalRefs = {}; }
    const sourceCorrection = isWfdRecord(frozen.sourceRevision);
    let originalIds = Array.isArray(originalRefs.originalIds) ? originalRefs.originalIds.map(String) : [];
    let materialIds = Array.isArray(originalRefs.materialIds) ? originalRefs.materialIds.map(String) : [];
    let sourceRefs = Array.isArray(originalRefs.sourceRefs) ? originalRefs.sourceRefs.filter(isWfdRecord) : [];
    const newMaterialId = String(frozen.materialId ?? '');
    if (sourceCorrection) {
      const revision = frozen.sourceRevision as WfdRecord;
      const material = this.options.materials.readOriginal(newMaterialId);
      originalIds = [];
      materialIds = [newMaterialId];
      sourceRefs = [{ source_id: String(revision.sourceId), provider: String(revision.provider),
        requested_url: String(revision.requestedUrl), requested_at_utc: String(revision.requestedAtUtc),
        acquired_at_utc: String(revision.acquiredAtUtc), sha256: String(frozen.originalSha256).replace(/^sha256:/u, ''),
        bytes: material.bytes.length, usage_scope: String(revision.usageScope),
        ...(revision.license !== undefined ? { license: String(revision.license) } : {}),
        ...(isWfdRecord(revision.authorization) ? { authorization: revision.authorization } : {}) }];
    }
    if (!sourceRefs.length) fail('CORRECTION_ASSOCIATION_SOURCE', '原发布请求没有真实来源引用；未写空来源关联。');
    const originalId = sourceCorrection ? newMaterialId
      : originalIds[0] ?? materialIds[0] ?? newMaterialId;
    if (!originalId) fail('CORRECTION_ASSOCIATION_ORIGINAL', '原发布请求没有原件/材料身份；未写虚构 original_id。');
    let plan: WfdRecord;
    try { plan = this.options.processing.get(String(frozen.planId)) as WfdRecord; }
    catch { return fail('CORRECTION_ASSOCIATION_PLAN', '新加工计划不可读，不能建立 R1 来源关联。'); }
    const output = (Array.isArray(plan.outputs) ? plan.outputs.filter(isWfdRecord) : [])
      .find(item => String(item.outputId) === String(frozen.outputId));
    if (!output) fail('CORRECTION_ASSOCIATION_PLAN', '新加工计划没有冻结输出。');
    const artifact = this.options.processing.outputArtifact(String(frozen.planId), String(frozen.outputId));
    const artifactSha256 = wfdSha256(artifact.bytes);
    const source = sourceRefs[0]!;
    const processRef = { process_id: `correction:${caseId}`,
      plan_id: String(frozen.planId), output_id: String(frozen.outputId),
      version: String(plan.version ?? ''), input_sha256: 'sha256:' + String(frozen.originalSha256).replace(/^sha256:/u, ''),
      output_sha256: 'sha256:' + artifactSha256,
      evidence_sha256: 'sha256:' + artifactSha256, document_sha256: 'sha256:' + documentSha256 };
    if (!processRef.version) fail('CORRECTION_ASSOCIATION_PLAN', '新加工计划缺少冻结版本。');
    const evidenceRefs = [
      { ref_id: `correction-output:${caseId}`, content_sha256: artifactSha256, kind: 'processing_output' },
      { ref_id: `correction-document:${caseId}`, content_sha256: documentSha256, kind: 'r1_document' },
      ...(sourceCorrection ? [{ ref_id: `predecessor-original:${caseId}`,
        content_sha256: String((frozen.sourceRevision as WfdRecord).previousOriginalSha256).replace(/^sha256:/u, ''),
        kind: 'predecessor_original' }] : []),
    ];
    const refs = { originalIds, materialIds: materialIds.length ? materialIds : [originalId],
      sourceRefs: [source], processRefs: [processRef], evidenceRefs };
    const now = Date.now();
    this.options.database.transaction(() => {
      this.db.prepare(`INSERT INTO r1_handoff_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(request_id) DO UPDATE SET document_json=excluded.document_json,
        document_sha256=excluded.document_sha256,local_refs_json=excluded.local_refs_json,
        local_refs_sha256=excluded.local_refs_sha256,state='associated',receipt_json=excluded.receipt_json,
        pending_count=0,error_json=NULL,updated_at=excluded.updated_at`).run(
        requestId, datasetId, namespace, canonicalWfdJson(document), documentSha256,
        canonicalWfdJson(refs as unknown as WfdRecord), wfdSha256(canonicalWfdJson(refs as unknown as WfdRecord)),
        'associated', canonicalWfdJson(result), 0, null, now, now);
      // binding_json 必须是当前 R1 连接身份；更正 provenance 只放在 refs/association。
      const connection = this.options.runtime.currentIdentity();
      const recipe = { reason: 'post-publication-correction', caseId,
        planId: frozen.planId, outputId: frozen.outputId, originalSha256: frozen.originalSha256,
        documentSha256, sourceRevision: frozen.sourceRevision ?? null };
      this.db.prepare(`INSERT INTO r1_workspace_requests VALUES(?,?,?,?,?,?,NULL,?)
        ON CONFLICT(request_id) DO NOTHING`).run(requestId, canonicalWfdJson(connection),
        wfdSha256(canonicalWfdJson(connection)),
        wfdSha256(canonicalWfdJson(recipe as unknown as WfdRecord)),
        String(frozen.planId), String(frozen.outputId), now);
      const documentOutputs = Array.isArray(document.outputs) ? document.outputs.filter(isWfdRecord) : [];
      for (const verified of verifiedOutputs) {
        const documentOutput = documentOutputs.find(item =>
          String(item.output_key) === String(verified.outputKey));
        const correctedKeys = new Set((Array.isArray((documentOutput?.payload as WfdRecord)?.rows)
          ? ((documentOutput!.payload as WfdRecord).rows as WfdRecord[]) : [])
          .map(item => String(item.business_key)));
        for (const row of verified.fixedRows as WfdRecord[]) {
          const ref = row.record_ref as WfdRecord;
          const logicalKey = String(ref.logical_key ?? ''), revisionId = String(ref.revision_id ?? '');
          if (!logicalKey || !revisionId || !correctedKeys.has(logicalKey)) continue;
          this.db.prepare(`INSERT INTO r1_record_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(dataset_id,product_id,record_id,record_version,request_id,original_id) DO NOTHING`).run(
            datasetId, String(verified.productId), String(verified.definitionDigest), String(verified.snapshotId ?? ''),
            logicalKey, revisionId, requestId, originalId, String(source.source_id ?? ''),
            canonicalWfdJson([processRef] as unknown as WfdRecord), canonicalWfdJson(evidenceRefs as unknown as WfdRecord), now);
        }
      }
    });
  }

  /** 审批通过后失败必须留下具体原因，不能只显示通用 RUNTIME_FAILED。 */
  private markRepairFailure(caseId: string, error: unknown): void {
    const row = this.row(caseId);
    let gaps: string[] = [];
    try { gaps = row ? JSON.parse(row.gaps_json) as string[] : []; } catch { gaps = []; }
    const code = error instanceof TaskError ? error.code : 'RUNTIME_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    const gap = `correction_repair_failed:${code}:${message}`.slice(0, 2000);
    if (!gaps.includes(gap)) gaps.push(gap);
    this.db.prepare(`UPDATE correction_cases SET state='blocked',gaps_json=?,result_json=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(gaps), canonicalWfdJson({ state: 'repair_failed', code, message } as unknown as WfdRecord),
      Date.now(), caseId);
  }

  /** 未知结果/响应丢失必须持久为 blocked；查询与恢复只沿原 request_identity。 */
  private markUnknown(caseId: string, wfdState: string, error?: unknown, statusError?: unknown): void {
    const row = this.row(caseId);
    let gaps: string[] = [];
    try { gaps = row ? JSON.parse(row.gaps_json) as string[] : []; } catch { gaps = []; }
    const gap = `wfd_unknown_outcome:${wfdState}`;
    if (!gaps.includes(gap)) gaps.push(gap);
    const message = error instanceof Error ? error.message : error === undefined ? null : String(error);
    const statusMessage = statusError instanceof Error ? statusError.message
      : statusError === undefined ? null : String(statusError);
    this.db.prepare(`UPDATE correction_cases SET state='blocked',gaps_json=?,result_json=?,updated_at=? WHERE case_id=?`)
      .run(canonicalWfdJson(gaps), canonicalWfdJson({ state: 'pending_receipt', wfd_state: wfdState,
        recovery: 'same_request_identity_no_resubmit', message, status_message: statusMessage } as unknown as WfdRecord),
      Date.now(), caseId);
  }

}

interface FrozenRepair {
  caseId: string; impactSha256: string; errorBindingDigest: string; document: WfdRecord;
  documentSha256: string; planId: string; outputId: string; originalSha256: string;
  valueFields?: WfdRecord; materialId?: string; originalRequestId?: string; sourceRevision?: WfdRecord | null;
  budget: { max_rows: number; max_document_bytes: number; series_count: number };
  /** 旧冻结文档的复算字段仅用于判断退役范围及保留原报核验摘要。 */
  recompute?: unknown[];
}

function assertRepairScope(frozen: FrozenRepair, document: WfdRecord): void {
  if (frozen.recompute?.length || Array.isArray(document.outputs) && document.outputs.length > 1)
    fail('CORRECTION_MANUAL_DERIVED_REQUIRED', '旧更正文档包含已退出的派生复算；原请求和用途暂停记录可继续查阅。');
}

function readCorrectionInput(value: unknown): CorrectionInput {
  const body = object(value, ['caseId', 'kind', 'errorType', 'discoveredAt', 'evidence', 'binding', 'connectionSha256']);
  const caseId = id(body.caseId), errorType = bounded(body.errorType, 128), evidence = bounded(body.evidence, 4096);
  const discoveredAt = bounded(body.discoveredAt, 64);
  if (!Number.isFinite(Date.parse(discoveredAt))) fail('CORRECTION_INPUT', '发现时间不是明确 UTC 时间。');
  if (!['processing_repair', 'source_correction'].includes(String(body.kind))) fail('CORRECTION_INPUT', '更正类型无效。');
  const raw = object(body.binding, ['adapter', 'planOutput']);
  const keys = Object.keys(raw).length;
  if (keys !== 1) fail('CORRECTION_INPUT', '错误绑定必须且只能指定适配三元组或精确计划/输出。');
  let binding: CorrectionBinding;
  if (raw.adapter !== undefined) {
    const adapter = object(raw.adapter, ['adapterId', 'version', 'configDigest']);
    binding = { adapter: { adapterId: id(adapter.adapterId), version: id(adapter.version),
      configDigest: adapterDigestHex(adapter.configDigest) } };
  } else {
    const plan = object(raw.planOutput, ['planId', 'outputId']);
    binding = { planOutput: { planId: id(plan.planId), outputId: id(plan.outputId) } };
  }
  return { caseId, kind: body.kind as CorrectionKind, errorType, discoveredAt, evidence, binding,
    connectionSha256: digestHex(body.connectionSha256) };
}
function readRepairInput(value: unknown, kind: CorrectionKind): {
  planId: string; outputId: string; originalSha256: string; expectedParentSnapshotId: string;
  reason: string; correctedRows?: WfdRecord[]; sourceRevision?: WfdRecord;
} {
  const body = object(value, ['planId', 'outputId', 'originalSha256', 'expectedParentSnapshotId', 'reason',
    'correctedRows', 'sourceRevision']);
  const reason = bounded(body.reason, 4096);
  if (reason.trim().length < 8 || /^(yes|同意|确认|允许|ok)$/iu.test(reason.trim()))
    fail('CORRECTION_REASON_REQUIRED', '原因必须是具体来源与更正依据，确认词不能替代证据。');
  // 更正值权威来自实际加工输出；正文 correctedRows 只在兼容旧调用时用于
  // 逐字核对，不能作为加工产物本身。缺省时完全从真实输出读取。
  if (body.correctedRows !== undefined && (!Array.isArray(body.correctedRows) || !body.correctedRows.length
    || body.correctedRows.length > 5000 || body.correctedRows.some(item => !isWfdRecord(item))))
    fail('CORRECTION_ROWS', '更正行须为明确的 1–5000 行对象。');
  const sourceRevision = body.sourceRevision === undefined ? undefined : object(body.sourceRevision,
    ['sourceId', 'provider', 'requestedUrl', 'requestedAtUtc', 'acquiredAtUtc', 'revisionBasis',
     'originalSha256', 'previousOriginalSha256', 'usageScope', 'license', 'authorization']);
  if (kind === 'source_correction' && !sourceRevision) fail('CORRECTION_SOURCE_REVISION_REQUIRED', '供应商更正缺少新取得原件与来源修订依据。');
  if (kind === 'source_correction') {
    const revision = sourceRevision as WfdRecord;
    for (const key of ['sourceId', 'provider', 'requestedUrl', 'requestedAtUtc', 'acquiredAtUtc',
      'revisionBasis', 'usageScope'] as const) bounded(revision[key], 4096);
    const requested = Date.parse(String(revision.requestedAtUtc)), acquired = Date.parse(String(revision.acquiredAtUtc));
    if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested)
      fail('CORRECTION_SOURCE_REVISION_REQUIRED', '供应商更正须有明确请求/取得时间，且取得不早于请求。');
    if (revision.license !== undefined) bounded(revision.license, 4096);
    if (revision.authorization !== undefined && !isWfdRecord(revision.authorization))
      fail('CORRECTION_SOURCE_REVISION_REQUIRED', '来源授权声明须为明确对象。');
    digestHex(revision.originalSha256);
    digestHex(revision.previousOriginalSha256);
  }
  if (kind === 'processing_repair' && sourceRevision) fail('CORRECTION_INPUT', 'processing_repair 不得倒填来源取得时间或替换原件。');
  return { planId: id(body.planId), outputId: id(body.outputId), originalSha256: digestHex(body.originalSha256),
    expectedParentSnapshotId: id(body.expectedParentSnapshotId), reason,
    ...(body.correctedRows ? { correctedRows: body.correctedRows as WfdRecord[] } : {}),
    ...(sourceRevision ? { sourceRevision } : {}) };
}
function assertOperator(operator: OperatorContext): void {
  if (!operator || operator.source === 'conversation')
    fail('CORRECTION_AUTHORITY_REQUIRED', '更正登记与修复只能由本机受信入口办理；模型不能自批准。');
}
function object(value: unknown, keys: string[]): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key)))
    fail('CORRECTION_INPUT', '需要明确对象且只接受已声明字段。');
  return value;
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value))
    fail('CORRECTION_INPUT', '文本缺失、越界或含控制字符。');
  return value;
}
function digestHex(value: unknown): string {
  if (typeof value !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/u.test(value))
    fail('CORRECTION_INPUT', '需要明确的 sha256 摘要。');
  return value.startsWith('sha256:') ? value : 'sha256:' + value;
}
/** FrozenAdapterBinding.configDigest 的真实格式是裸 64 位 hex；只在这一处归一化比较。 */
function adapterDigestHex(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value))
    fail('CORRECTION_INPUT', '适配配置摘要须为 64 位十六进制。');
  return value.replace(/^sha256:/u, '');
}
function sameAdapterDigest(left: unknown, right: unknown): boolean {
  try { return adapterDigestHex(left) === adapterDigestHex(right); } catch { return false; }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value))
    fail('CORRECTION_INPUT', '需要稳定的有界身份，不接受路径。');
  return value;
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }

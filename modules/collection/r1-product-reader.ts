import { R1_CONTEXT_OPERATIONS, type R1ContextOperation, type R1ContextRead } from '../../contracts/r1-contracts.js';
import type { R1ConnectionIdentity, R1DefinitionIntent, R1DefinitionReview, R1ProductDiscovery, R1ProductRead, R1ProductSelection, R1ReadConnection, R1SnapshotStatus } from '../../contracts/r1-contracts.js';
import { WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import type { WfdFilterPlan } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { R1Runtime } from './r1-runtime.js';

export const R1_READ_LIMITS = Object.freeze({ pageSize: 100, maxScanRows: 5000, maxScanBytes: 16_777_216,
  maxResultBytes: 2_097_152, maxDiscoveryProducts: 1000, maxFields: 64, timeoutMs: 30_000 });
type ReadRuntime = Pick<R1Runtime, 'client' | 'currentIdentity'>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const fixed = (value: unknown): value is string => identifier(value) && !/^(latest|current)$/iu.test(value);
function fail(code: string, message: string): never { throw new TaskError(code, message); }
const connection = (identity: R1ConnectionIdentity): R1ReadConnection => ({ connectionId: identity.connectionId,
  profile: identity.profile, mode: identity.mode, runtimeIdentity: identity.runtimeIdentity, callerId: identity.callerId, namespace: identity.namespace });

/** Only the bound R1 client is used. Projection is restricted to discovered fields; dataset, time and budgets are host-owned. */
export class R1ProductReader {
  constructor(private readonly options: { runtime(): ReadRuntime; control(): { stopped: boolean; generation: number } }) {}

  filterObjects(value: unknown, signal?: AbortSignal, contextDigest?: string): Promise<WfdRecord> {
    const input = body(value, ['dataset_id', 'snapshot_id', 'history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage',
      'universe', 'metrics', 'business_time_range', 'predicate', 'order_by', 'page_size', 'cursor']);
    if (!fixed(input.snapshot_id) || !identifier(input.dataset_id)) fail('R1_FILTER_INPUT', '筛选需要实际数据集和固定快照。');
    if (input.page_size !== undefined && (!Number.isSafeInteger(input.page_size) || Number(input.page_size) < 1
      || Number(input.page_size) > R1_READ_LIMITS.pageSize)) fail('R1_FILTER_INPUT', '本地筛选每页最多100个对象。');
    const plan = { ...input, protocol_version: 'wfd.filter-objects/1.4-product1', operation: 'filter_objects',
      history_mode: input.history_mode ?? 'snapshot_contents', knowledge_cutoff: input.knowledge_cutoff ?? null,
      held_scope: input.held_scope ?? null, usable_stage: input.usable_stage ?? null,
      page_size: input.page_size ?? R1_READ_LIMITS.pageSize,
      max_nodes: R1_READ_LIMITS.maxScanRows, max_scan_bytes: R1_READ_LIMITS.maxScanBytes,
      ...(contextDigest ? { context_digest: contextDigest } : {}) } as unknown as WfdFilterPlan;
    return this.run(async (runtime, identity, active, wait) => {
      const { result } = await runtime.client.filterObjects(plan, wait); active(); boundedResult(result);
      const page = isWfdRecord(result.page) ? result.page : {};
      if (result.protocol_version !== plan.protocol_version || result.format_version !== 'wfd.filter-objects-result/1'
        || result.operation !== plan.operation || result.dataset_id !== plan.dataset_id || result.snapshot_id !== plan.snapshot_id
        || result.history_mode !== plan.history_mode || canonicalWfdJson(result.knowledge_cutoff) !== canonicalWfdJson(plan.knowledge_cutoff)
        || result.held_scope !== plan.held_scope || result.usable_stage !== plan.usable_stage
        || canonicalWfdJson(result.business_time_range) !== canonicalWfdJson(plan.business_time_range)
        || canonicalWfdJson(result.predicate) !== canonicalWfdJson(plan.predicate)
        || canonicalWfdJson(result.order_by) !== canonicalWfdJson(plan.order_by)
        || typeof result.query_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.query_hash)
        || !Array.isArray(result.objects) || result.objects.length > plan.page_size || result.object_count !== result.objects.length
        || !Array.isArray(result.indeterminate) || !Array.isArray(result.bindings) || !isWfdRecord(result.coverage)
        || !isWfdRecord(result.scan_receipt) || typeof result.scan_receipt.scan_complete !== 'boolean'
        || !['matched', 'empty', 'ambiguous', 'coverage_insufficient', 'budget_exceeded'].includes(String(result.status))
        || typeof page.has_more !== 'boolean' || typeof page.result_exhausted !== 'boolean'
        || (page.has_more ? typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 8192 : page.next_cursor !== null)
        || (page.result_exhausted && (page.has_more || result.scan_receipt.scan_complete !== true))) {
        fail('R1_FILTER_RESPONSE_INVALID', '筛选结果的固定身份、条件、时态、覆盖或分页无法核对；本页未采用。');
      }
      return { ...result, connection: connection(identity), limits: R1_READ_LIMITS };
    }, signal);
  }

  reviewDefinition(intent: R1DefinitionIntent, signal?: AbortSignal): Promise<R1DefinitionReview> {
    return this.run(async (runtime, _identity, active, wait) => {
      const reply = await runtime.client.reviewDefinition(intent, wait);
      active();
      const r = reply.result;
      boundedResult(r);
      const missing = r.missing_fields, ids = r.product_ids;
      if (r.protocol !== 'wfd.definition-review/1' || r.snapshot_id !== intent.snapshotId || r.dataset_id !== intent.datasetId
        || r.semantic_code !== intent.semanticCode || canonicalWfdJson(r.subject) !== canonicalWfdJson(intent.subject)
        || canonicalWfdJson(r.field_codes) !== canonicalWfdJson(intent.fieldCodes)
        || !Array.isArray(ids) || !ids.every(identifier) || !Array.isArray(missing)
        || !missing.every(field => typeof field === 'string' && intent.fieldCodes.includes(field))
        || !identifier(reply.response.request_id)
        || (!ids.length && canonicalWfdJson(missing) !== canonicalWfdJson(intent.fieldCodes))) {
        fail('R1_REVIEW_RESPONSE_INVALID', 'WFD 契约受理回执与本次文件意向不符。');
      }
      const disposition = missing.length ? 'return_to_bd' : 'candidate_found';
      const code = !ids.length ? 'FAMILY_DEFINITION_REQUIRED' : missing.length ? 'FIELD_DEFINITION_REQUIRED' : 'CANDIDATE_FIELDS_PRESENT';
      if (r.disposition !== disposition || r.code !== code) fail('R1_REVIEW_RESPONSE_INVALID', 'WFD 受理状态与字段覆盖不一致。');
      return { ...intent, protocol: 'wfd.definition-review/1', disposition, code,
        productIds: ids, missingFields: missing as string[], machineRequestId: reply.response.request_id };
    }, signal);
  }

  snapshotStatus(signal?: AbortSignal): Promise<R1SnapshotStatus> {
    return this.run(async (runtime, identity, active, wait) => {
      const { result } = await runtime.client.snapshotStatus(wait); active(); boundedResult(result);
      if (result.format_version !== 'wfd.snapshot-status/1' || result.profile !== 'data_only' || result.authority !== 'active_head'
        || !(result.snapshot_id === null || fixed(result.snapshot_id)) || result.empty !== (result.snapshot_id === null)
        || result.connection_id !== identity.connectionId || result.caller_id !== identity.callerId
        || result.trusted_actor_namespace !== identity.namespace || !Array.isArray(result.caller_roles)
        || result.caller_roles.some(role => !identifier(role)) || !result.caller_roles.includes('read')
        || !isWfdRecord(result.unit_definitions) || Object.entries(result.unit_definitions).some(([code, value]) => !identifier(code)
          || !isWfdRecord(value) || !isWfdRecord(value.definition) || typeof value.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.digest))) {
        fail('R1_READ_RESPONSE_INVALID', '当前快照或空库状态无法按绑定身份核对；不能将错误当作空库。');
      }
      return { snapshotId: result.snapshot_id as string | null, empty: result.empty as boolean, authority: 'active_head',
        connection: { ...connection(identity), roles: result.caller_roles as string[] },
        units: result.unit_definitions as R1SnapshotStatus['units'] };
    }, signal);
  }

  async discoverProducts(value: unknown, signal?: AbortSignal): Promise<R1ProductDiscovery> {
    const input = body(value, ['snapshotId']);
    if (!fixed(input.snapshotId)) fail('R1_READ_INPUT', '请提供固定快照编号；不能使用 latest/current 或路径。');
    const snapshotId = input.snapshotId as string;
    return this.run(async (runtime, identity, active, wait) => {
      const found = await this.discover(runtime, snapshotId, active, wait);
      return { ...found, snapshotId, historyMode: 'snapshot_contents', connection: connection(identity), limits: R1_READ_LIMITS };
    }, signal);
  }

  async readProduct(value: unknown, signal?: AbortSignal): Promise<R1ProductRead> {
    const input = body(value, ['snapshotId', 'productId', 'fields', 'cursor']);
    if (!fixed(input.snapshotId) || !identifier(input.productId) || input.cursor !== undefined && input.cursor !== null
      && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 8192 || /[\u0000-\u001f]/u.test(input.cursor))) {
      fail('R1_READ_INPUT', '读取需要固定快照、实际产品及有界原游标；不接受路径或查询覆盖。');
    }
    if (input.fields !== undefined && (!Array.isArray(input.fields) || input.fields.length < 1
      || input.fields.length > R1_READ_LIMITS.maxFields || input.fields.some(field => !identifier(field))
      || new Set(input.fields).size !== input.fields.length)) {
      fail('R1_READ_FIELDS', '请选择 1–64 个已发现的声明字段；不接受空投影、重复字段或路径。');
    }
    const snapshotId = input.snapshotId as string, productId = input.productId as string;
    return this.run(async (runtime, identity, active, wait) => {
      // Rediscover on every page, validating projection against the same fixed product contracts.
      const discovered = await this.discover(runtime, snapshotId, active, wait);
      const product = discovered.selections.find(item => item.productId === productId);
      if (!product) fail('R1_READ_PRODUCT_NOT_FOUND', '该产品不在所选固定快照中；请重新发现实际产品。');
      if (!product.readable) fail('R1_READ_PROJECTION_UNSUPPORTED', product.reason!);
      const fields = input.fields === undefined ? product.fields : [...input.fields as string[]].sort();
      if (fields.length > R1_READ_LIMITS.maxFields || fields.some(field => !product.fields.includes(field))) {
        fail('R1_READ_FIELDS', '所选字段未在该固定快照产品中声明，或超过 64 字段预算；请按实际发现结果重新选择。');
      }
      active();
      const reply = await runtime.client.readProduct({ protocol_version: 'wfd.read/1.3-product1', operation: 'read_product',
        dataset_id: product.datasetId, snapshot_id: snapshotId, product_id: productId, fields,
        history_mode: 'snapshot_contents', knowledge_cutoff: null, held_scope: null, usable_stage: null, subject: null,
        business_time_range: null, page_size: R1_READ_LIMITS.pageSize, max_nodes: R1_READ_LIMITS.maxScanRows,
        max_scan_bytes: R1_READ_LIMITS.maxScanBytes, cursor: input.cursor ?? null }, wait);
      active(); const result = reply.result; boundedResult(result);
      const page = isWfdRecord(result.page) ? result.page : {};
      if (result.format_version !== 'wfd.read-product-result/0.1' || result.operation !== 'read_product'
        || result.snapshot_id !== snapshotId || result.product_id !== productId || result.dataset_id !== product.datasetId
        || result.history_mode !== 'snapshot_contents' || result.knowledge_cutoff !== null || result.held_scope !== null
        || result.usable_stage !== null || result.subject !== null || result.business_time_range !== null
        || canonicalWfdJson(result.fields) !== canonicalWfdJson(fields)
        || !Array.isArray(result.rows) || result.rows.length > R1_READ_LIMITS.pageSize
        || result.rows.some(row => !isWfdRecord(row) || !isWfdRecord(row.values) || !isWfdRecord(row.record_ref))
        || !Array.isArray(result.diagnostics) || typeof result.complete !== 'boolean' || !isWfdRecord(result.budget)
        || typeof result.query_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.query_hash)
        || page.page_size !== R1_READ_LIMITS.pageSize || page.returned_rows !== result.rows.length
        || !Number.isSafeInteger(page.total_rows) || Number(page.total_rows) < result.rows.length
        || !Number.isSafeInteger(page.remaining_rows) || Number(page.remaining_rows) < 0
        || typeof page.has_more !== 'boolean' || page.page_complete !== !page.has_more
        || (page.has_more ? typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 8192 : page.next_cursor !== null)) {
        fail('R1_READ_RESPONSE_INVALID', 'WFD 返回的固定身份、时间视角、投影或分页无法核对；本页未采用。');
      }
      return { snapshotId, productId, historyMode: 'snapshot_contents', connection: connection(identity), result, limits: R1_READ_LIMITS };
    }, signal);
  }

  async readContext(value: unknown, signal?: AbortSignal): Promise<R1ContextRead> {
    const input = body(value, ['operation', 'snapshotId', 'datasetId', 'subject', 'fields', 'pageSize', 'cursor',
      'maxDepth', 'relationTypes', 'eventTypes', 'ruleCodes', 'businessTimeRange']);
    if (!R1_CONTEXT_OPERATIONS.includes(input.operation as R1ContextOperation) || !fixed(input.snapshotId)
      || !identifier(input.datasetId) || !isWfdRecord(input.subject)
      || Object.keys(input.subject).length !== 3 || Object.keys(input.subject).some(key => !['kind', 'namespace', 'id'].includes(key))
      || !['kind', 'namespace', 'id'].every(key => identifier((input.subject as WfdRecord)[key]))) {
      fail('R1_CONTEXT_INPUT', '请选择四类固定快照查询之一、实际数据集及完整主体身份；不接受任意操作或历史视角。');
    }
    const operation = input.operation as R1ContextOperation, snapshotId = input.snapshotId as string, datasetId = input.datasetId as string;
    const subject = input.subject as WfdRecord, pageSize = input.pageSize ?? R1_READ_LIMITS.pageSize;
    if (!Number.isSafeInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > R1_READ_LIMITS.pageSize
      || input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 8192 || /[\u0000-\u001f]/u.test(input.cursor))) {
      fail('R1_CONTEXT_INPUT', '每页须为1–100条，并使用该固定查询的原游标。');
    }
    const graph = operation === 'read_relation_graph', company = operation === 'read_company_context';
    if (input.maxDepth !== undefined && (!graph && !company || !Number.isSafeInteger(input.maxDepth)
      || Number(input.maxDepth) < 0 || Number(input.maxDepth) > 3)) fail('R1_CONTEXT_INPUT', '只有公司上下文和关系图可选择0–3层深度。');
    const filterFor = { relationTypes: 'read_relation_graph', eventTypes: 'read_event_timeline', ruleCodes: 'read_applicable_rules' } as const;
    for (const [key, owner] of Object.entries(filterFor)) {
      const values = input[key];
      if (values !== undefined && (operation !== owner || !Array.isArray(values) || values.length > 64
        || values.some(item => typeof item !== 'string' || !item.trim() || item.length > 128 || /[\u0000-\u001f]/u.test(item))
        || new Set(values).size !== values.length)) fail('R1_CONTEXT_INPUT', '类型/规则筛选须属于当前查询，最多64个明确且不重复的名称。');
    }
    if (input.fields !== undefined && (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > R1_READ_LIMITS.maxFields
      || input.fields.some(field => !identifier(field)) || new Set(input.fields).size !== input.fields.length)) fail('R1_CONTEXT_INPUT', '投影须为1–64个已声明且不重复的字段。');
    const range = input.businessTimeRange ?? null;
    if (range !== null && (!isWfdRecord(range) || Object.keys(range).length !== 4
      || Object.keys(range).some(key => !['role', 'start', 'end', 'timezone'].includes(key))
      || !['role', 'start', 'end', 'timezone'].every(key => typeof range[key] === 'string' && String(range[key]).length > 0 && String(range[key]).length <= 128))) {
      fail('R1_CONTEXT_INPUT', '业务时间区间须明确角色、起止和时区；它不能覆盖固定快照时间视角。');
    }
    return this.run(async (runtime, identity, active, wait) => {
      const discovered = await this.discover(runtime, snapshotId, active, wait);
      if (!discovered.selections.some(item => item.datasetId === datasetId)) fail('R1_CONTEXT_DATASET_NOT_FOUND', '该数据集不在所选固定快照中。');
      const declared = new Set(discovered.selections.filter(item => item.datasetId === datasetId).flatMap(item => item.fields));
      if (Array.isArray(input.fields) && input.fields.some(field => !declared.has(String(field)))) fail('R1_CONTEXT_INPUT', '投影字段未在所选固定数据集中声明。');
      const request: WfdRecord = { protocol_version: 'wfd.read/1.3-product1b', operation,
        dataset_id: datasetId, snapshot_id: snapshotId, subject,
        history_mode: 'snapshot_contents', knowledge_cutoff: null, held_scope: null, usable_stage: null,
        page_size: pageSize, max_nodes: R1_READ_LIMITS.maxScanRows, max_scan_bytes: R1_READ_LIMITS.maxScanBytes,
        cursor: input.cursor ?? null, business_time_range: range,
        ...(input.fields ? { fields: input.fields } : {}),
        ...(graph || company ? { max_depth: input.maxDepth ?? 1, max_edges: 1000 } : {}),
        ...(input.relationTypes ? { relation_types: input.relationTypes } : {}),
        ...(input.eventTypes ? { event_types: input.eventTypes } : {}),
        ...(input.ruleCodes ? { rule_codes: input.ruleCodes } : {}) };
      const { result } = await runtime.client.readContext(operation, request, wait); active(); boundedResult(result);
      const formats: Record<R1ContextOperation, string> = { read_company_context: 'wfd.p4b-context-result/0.1',
        read_relation_graph: 'wfd.p4b-graph-result/0.1', read_applicable_rules: 'wfd.p4b-rule-result/0.1', read_event_timeline: 'wfd.p4b-event-timeline/0.1' };
      const rows = graph ? result.edges : result.rows, page = isWfdRecord(result.page) ? result.page : {};
      if (result.protocol_version !== request.protocol_version || result.format_version !== formats[operation] || result.operation !== operation
        || result.snapshot_id !== snapshotId || result.dataset_id !== datasetId || result.history_mode !== 'snapshot_contents'
        || canonicalWfdJson(result.subject) !== canonicalWfdJson(subject)
        || typeof result.query_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.query_hash)
        || !Array.isArray(result.gaps) || !isWfdRecord(result.coverage) || !isWfdRecord(result.budget)
        || !Array.isArray(rows) || rows.length > Number(pageSize) || rows.some(row => !isWfdRecord(row) || !isWfdRecord(row.record_ref))
        || graph && result.max_depth !== request.max_depth || page.page_size !== pageSize || page.returned_rows !== rows.length
        || !Number.isSafeInteger(page.total_rows) || Number(page.total_rows) < rows.length || !Number.isSafeInteger(page.offset) || Number(page.offset) < 0
        || typeof page.has_more !== 'boolean' || page.has_more !== (Number(page.offset) + rows.length < Number(page.total_rows))
        || (page.has_more ? typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 8192 : page.next_cursor !== null)) {
        fail('R1_CONTEXT_RESPONSE_INVALID', '上下文结果的操作、固定身份、范围或分页无法核对；本页未采用。');
      }
      return { operation, snapshotId, datasetId, subject, historyMode: 'snapshot_contents', connection: connection(identity), result, limits: R1_READ_LIMITS };
    }, signal);
  }

  private async discover(runtime: ReadRuntime, snapshotId: string, active: () => void, signal: AbortSignal) {
    active(); const { result } = await runtime.client.contractDiscovery(snapshotId, signal); active(); boundedResult(result);
    if (result.snapshot_id !== snapshotId || !Array.isArray(result.products) || result.product_count !== result.products.length) {
      fail('R1_READ_RESPONSE_INVALID', '快照产品发现的固定身份或完整数量无法核对。');
    }
    if (result.products.length > R1_READ_LIMITS.maxDiscoveryProducts) fail('R1_READ_BUDGET', '快照产品合同数量超过此入口预算；未截断为完整目录。');
    const selections = new Map<string, R1ProductSelection>();
    for (const value of result.products) {
      if (!isWfdRecord(value) || !identifier(value.product_id) || !identifier(value.dataset_id)
        || typeof value.payload_kind !== 'string' || !isWfdRecord(value.subject) || !isWfdRecord(value.declaration)) {
        fail('R1_READ_RESPONSE_INVALID', '真实产品缺少可核对的数据集、主体或声明；未猜测查询身份。');
      }
      const fields = value.payload_kind === 'scalar_rows' ? ['value_decimal'] : Array.isArray(value.declaration.field_definitions)
        ? value.declaration.field_definitions.map(field => isWfdRecord(field) ? field.field_code : null) : [];
      if (fields.some(field => !identifier(field))) fail('R1_READ_RESPONSE_INVALID', '产品声明字段无法核对。');
      const old = selections.get(value.product_id);
      if (old && (old.datasetId !== value.dataset_id || old.payloadKind !== value.payload_kind
        || canonicalWfdJson(old.subject) !== canonicalWfdJson(value.subject))) fail('R1_READ_RESPONSE_INVALID', '同一产品的固定合同身份不一致。');
      const declared = [...new Set([...(old?.fields ?? []), ...fields as string[]])].sort();
      const reason = !declared.length ? '此产品没有 read_product 可投影的声明值字段。' : null;
      selections.set(value.product_id, { productId: value.product_id, datasetId: value.dataset_id, payloadKind: value.payload_kind,
        subject: value.subject, fields: declared, readable: reason === null, reason });
    }
    return { products: result.products as WfdRecord[], selections: [...selections.values()] };
  }

  private async run<T>(work: (runtime: ReadRuntime, identity: R1ConnectionIdentity, active: () => void, wait: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const initial = this.options.control();
    if (initial.stopped) fail('BD_STOPPED', '服务已停止，不受理新的 WFD 查询。');
    const runtime = this.options.runtime(), identity = runtime.currentIdentity(), fingerprint = canonicalWfdJson(identity);
    if (identity.profile !== 'data_only') fail('R1_PROFILE_REQUIRED', '此读取入口只允许绑定的 data_only 连接。');
    const wait = AbortSignal.any([AbortSignal.timeout(R1_READ_LIMITS.timeoutMs), ...(signal ? [signal] : [])]);
    const active = () => {
      if (wait.aborted) fail('R1_READ_ABORTED', '本次只读等待已中止或超过 30 秒；没有自动重试。');
      const now = this.options.control();
      if (now.stopped || now.generation !== initial.generation) fail('BD_STOPPED', '查询等待期间停止代次已变化；本次旧结果未采用。');
      if (canonicalWfdJson(runtime.currentIdentity()) !== fingerprint) fail('R1_CONNECTION_BINDING_CHANGED', '查询期间绑定连接身份已变化；请核对后重新装配。');
    };
    try { active(); const result = await work(runtime, identity, active, wait); active(); return result; }
    catch (error) {
      if (error instanceof TaskError) throw error;
      if (wait.aborted) fail('R1_READ_ABORTED', '本次只读等待已中止或超过 30 秒；没有自动重试。');
      if (error instanceof WfdProductMachineError) {
        const code = error.remoteCode ?? error.code;
        fail(/^[A-Z][A-Z0-9_]{1,95}$/u.test(code) ? code : 'R1_READ_FAILED', 'WFD 读取未完成；请按错误编号核对权限、预算、绑定实例与固定快照。');
      }
      fail('R1_READ_FAILED', 'WFD 读取未完成；请核对绑定实例与固定快照。');
    }
  }
}

function body(value: unknown, keys: string[]): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail('R1_READ_INPUT', '此入口只接受固定快照、发现的产品、已声明投影字段和原游标；不接受路径、数据库、权限或时间覆盖。');
  return value;
}
function boundedResult(value: WfdRecord): void {
  if (Buffer.byteLength(canonicalWfdJson(value)) > R1_READ_LIMITS.maxResultBytes) fail('R1_READ_BUDGET', '完整查询结果超过本入口 2 MiB 预算；未截断或伪称完成。');
}

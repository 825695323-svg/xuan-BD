import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { BackendInput } from '../../contracts/backend.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext, type TaskService } from '../../platform/jobs/tasks.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { MAX_RETAINED_EVIDENCE_BYTES } from '../agent/evidence.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import { SEGMENTER_VERSION, SEGMENT_RETRIEVAL_SCHEMA, SEGMENT_TOKENIZER, type SegmentRetrievalResult, type RetrievalEvidenceResult } from './segments/contracts.js';
import type { SegmentService } from './segments/service.js';
import { JOINT_RETRIEVAL_SCHEMA, type StructuredRetrievalService } from './structured-retrieval.js';

export const CONVERSATION_RETRIEVAL_VERSION = 'bd.conversation-retrieval/2';
const PREFIX = 'data.retrieval.';
const PAGE_LIMIT = 20;
const text = (key: string, label: string, maxLength = 200): SkillField => ({ key, label, type: 'text', required: true, maxLength });
const limit: SkillField = { key: 'limit', label: '条数', type: 'number', minimum: 1, maximum: PAGE_LIMIT };
const offset: SkillField = { key: 'offset', label: '起始位置', type: 'number', minimum: 0, maximum: 1_000_000 };
const select = (key: string, label: string, values: string[]): SkillField => ({ key, label, type: 'select', required: true,
  options: values.map(value => ({ value, label: value })) });
const index = text('indexVersion', '固定文档索引版本');
const specifications: { name: string; title: string; description: string; fields: SkillField[] }[] = [
  { name: 'capabilities', title: '读取检索能力', description: '读取文档与联合检索能力，分页列出固定索引版本。', fields: [offset, limit] },
  { name: 'documents', title: '列出受控文档', description: '分页读取本机已登记的文档版本、时间资质、摘要和缺口。', fields: [offset, limit] },
  { name: 'search', title: '按历史时点检索片段', description: '指定索引、匹配方式、历史模式和截止时间；返回引用、排除原因及缺口。', fields: [
    index, select('method', '匹配方式', ['keyword', 'exact']), text('query', '检索文字', 2048),
    select('mode', '历史资格', ['market_known_at', 'system_held_at']), text('asOf', 'ISO 截止时间', 64), limit,
    { ...offset, key: 'excludedOffset', label: '排除清单起始位置' }] },
  { name: 'joint', title: '联合检索指标与文档', description: 'jointJson 含 structured 固定结构化查询与 documents 文档条件，按精确记录版本关联。', fields: [text('jointJson', '联合检索 JSON', 32_768)] },
  { name: 'evidence', title: '核验固定片段证据', description: '读取指定片段的缓存、产物、原件核对状态及有界引用。', fields: [index, text('segmentId', '片段身份')] },
];
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
function invalid(): never { return fail('RETRIEVAL_CONVERSATION_INPUT', '检索动作需要符合契约的固定参数。'); }
function fixedId(v: unknown): string {
  if (typeof v !== 'string' || !/^[\w.:-]{1,200}$/u.test(v) || /^(?:latest|current)$/iu.test(v)) return invalid();
  return v;
}
function integer(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  return Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max ? Number(v) : invalid();
}
function isoCutoff(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d))?$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) return invalid();
  return value;
}

function page<T>(items: T[], start: number, count: number) {
  return { offset: start, total: items.length, nextOffset: start + count < items.length ? start + count : null,
    items: items.slice(start, start + count) };
}
function searchPreview(result: SegmentRetrievalResult, start: number) {
  const { excluded, ...coverage } = result.coverage, exclusions = page(excluded, start, PAGE_LIMIT);
  return { schema: result.schema, status: result.status, qualification: result.qualification, gaps: result.gaps,
    coverage: { ...coverage, excludedTotal: exclusions.total, excludedOffset: start, nextExcludedOffset: exclusions.nextOffset,
      excluded: exclusions.items }, query: result.query, citationCount: result.citations.length, citations: result.citations };
}

const safeEndpoints = new Set(['/api/bd/retrieval/index/rebuild-fts', '/api/bd/retrieval/joint']);
const privatePath = /(?:^|[^a-zA-Z0-9_./-])\/(?!\/)|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|private|Volumes|home|tmp|etc|var|mnt)\//iu;
function containsPath(text: string): boolean { return !safeEndpoints.has(text) && privatePath.test(text); }

/** Share a bounded projection even for long excerpts, arbitrary metric keys and deeply nested WFD values. */
function modelProjection(value: WfdRecord, bounded: boolean) {
  let remaining = 56_000, truncated = false, pathsWithheld = false;
  function project(item: unknown, depth: number): JsonValue {
    if (typeof item === 'string') {
      if (containsPath(item)) { pathsWithheld = true; return '[本机路径已隐藏]'; }
      if (!bounded || item.length <= 2048) return item;
      truncated = true; return item.slice(0, 2048);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (bounded && depth >= 12 || (!Array.isArray(item) && !isWfdRecord(item))) { truncated = true; return null; }
    const array = Array.isArray(item);
    const out: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
    const entries = array ? Object.entries(bounded ? item.slice(0, PAGE_LIMIT) : item) : Object.entries(item).filter(([, v]) => v !== undefined);
    const count = array ? item.length : entries.length;
    for (const [key, child] of bounded ? entries.slice(0, 64) : entries) {
      if (containsPath(key)) { pathsWithheld = true; continue; }
      if (bounded && key.length > 200) { truncated = true; continue; }
      // Charge for the JSON representation of each leaf and each containing key/delimiter.
      const cost = Buffer.byteLength(JSON.stringify(key)) + 4 + (typeof child === 'string'
        ? Buffer.byteLength(JSON.stringify(child.slice(0, 2048))) + 32 : 16);
      if (bounded && cost > remaining) { truncated = true; break; }
      remaining -= cost;
      const result = project(child, depth + 1);
      if (Array.isArray(out)) out.push(result); else out[key] = result;
    }
    if (Object.keys(out).length < count) truncated = true;
    if (!Array.isArray(out) && isWfdRecord(item) && typeof item.excerpt === 'string' && out.excerpt !== item.excerpt) {
      out.excerpt_truncated = true;
      if (containsPath(item.excerpt)) { out.excerpt = ''; out.excerpt_withheld = 'local_path'; }
    }
    return Array.isArray(out) ? out : { ...out };
  }
  const projected = project(value, 0) as Record<string, JsonValue>;
  if (bounded && truncated && isWfdRecord(value.page)) {
    const page = isWfdRecord(projected.page) ? projected.page : {};
    projected.page = { ...page, has_more: true, next_cursor: null, result_exhausted: false, continuation: 'core_evidence_read' };
  }
  return { ...projected, previewTruncated: truncated, pathsWithheld };
}

type SegmentPort = Pick<SegmentService, 'capabilities' | 'readState' | 'indexVersions' | 'documents' | 'search'>;
type JointPort = Pick<StructuredRetrievalService, 'capabilities' | 'search'>;
type CoreScope = Pick<PersonalCore, 'isRunActive' | 'selectedAttachmentsForInput'> & { store: Pick<PersonalCore['store'], 'command'> };

type RetrievalInput = Pick<BackendInput, 'conversationId' | 'branchId' | 'messageId' | 'inputId' | 'runId' | 'generation'>;

export class ConversationRetrievalBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: {
    core: CoreScope;
    companion: { tasks: Pick<TaskService, 'getControl'>; segments?: SegmentPort; structuredRetrieval?: JointPort; localData?: LocalDataLifecycle };
    origin(taskId: string): ModelTaskOrigin | null;
    allowedMaterialIds(input: RetrievalInput, attachments: ReturnType<CoreScope['selectedAttachmentsForInput']>): string[];
    /** Host binds readRetrievalEvidence to the same companion and its private access gate. */
    readEvidence(input: { indexVersion: string; segmentId: string }, assertCurrent: () => void, allowedDocumentIds: readonly string[]): Promise<RetrievalEvidenceResult>;
  }) {
    this.registrations = specifications.map(({ name, title, description, fields }) => ({
      action: PREFIX + name, title, description, fields, kind: 'direct', runtimeId: 'direct', modelCalls: 0,
      permissionSummary: ['当前活动分支授权分享的有界只读检索结果；固定索引和原有历史资格门'],
      available: () => !options.companion.segments ? { available: false, reason: '文档片段服务未装配。' }
        : name === 'joint' && !options.companion.structuredRetrieval ? { available: false, reason: '结构化联合检索未装配。' } : { available: true },
    }));
  }
  get versionBinding() {
    return { bridge: CONVERSATION_RETRIEVAL_VERSION, segments: this.options.companion.segments ? SEGMENT_RETRIEVAL_SCHEMA : null,
      segmenter: SEGMENTER_VERSION, tokenizer: SEGMENT_TOKENIZER,
      structured: this.options.companion.structuredRetrieval ? JOINT_RETRIEVAL_SCHEMA : null };
  }
  handles(action: string): boolean { return this.registrations.some(item => item.action === action); }

  private allowedDocuments(input: RetrievalInput): string[] {
    const { core } = this.options;
    const attachments = core.selectedAttachmentsForInput({ ...input, text: core.store.command(input.inputId).text });
    return this.options.allowedMaterialIds(input, attachments);
  }

  /** 缓存预览与保管证据复用原任务的资料代次，撤权后不能通过续页取回旧内容。 */
  assertResultAccess(data: unknown, input: RetrievalInput): void {
    const lifecycle = this.options.companion.localData;
    if (!isWfdRecord(data) || data.kind !== 'conversation-retrieval'
      || (lifecycle ? typeof data.accessGeneration !== 'number' : data.accessGeneration !== null)) {
      return fail('MODEL_SHARE_REVOKED', '原检索结果的本地资料资格已变化。');
    }
    if (lifecycle) lifecycle.assertPrivateAccess(Number(data.accessGeneration));
    const allowed = new Set(this.allowedDocuments(input));
    if (data.branchId !== input.branchId || !Array.isArray(data.documentScope)
      || !data.documentScope.every(id => typeof id === 'string' && allowed.has(id)))
      return fail('MODEL_SHARE_REVOKED', '原检索任务的材料范围无法由当前分支核对。');
  }

  async execute(context: TaskExecutionContext, action = context.task.action, args = context.task.args): Promise<TaskResult> {
    try { return await this.read(context, action, args); }
    catch (error) {
      if (error instanceof Error && containsPath(error.message)) {
        const code = 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'RETRIEVAL_READ_FAILED';
        throw new TaskError(code, '检索读端无法完成本次核验。');
      }
      throw error;
    }
  }

  private async read(context: TaskExecutionContext, action: string, args: JsonValue): Promise<TaskResult> {
    const registration = this.registrations.find(item => item.action === action);
    if (!registration || context.task.runtimeId !== 'direct' || context.task.action !== action || !isWfdRecord(args)
      || canonicalWfdJson(context.task.args) !== canonicalWfdJson(args)
      || Object.keys(args).some(key => !registration.fields.some(field => field.key === key))) return invalid();
    const { companion, core } = this.options, origin = this.options.origin(context.task.id);
    if (!origin || origin.conversationId !== context.task.conversationId || origin.toolName !== 'perform_action')
      return fail('RETRIEVAL_CONVERSATION_SCOPE', '需要本分支的活动会话来源。');
    const frozenOrigin = canonicalWfdJson(origin), controlGeneration = companion.tasks.getControl().generation;
    const generation = companion.localData?.assertActive().generation;
    const inputScope = { conversationId: origin.conversationId, branchId: origin.branchId, messageId: origin.messageId,
      inputId: origin.inputId, runId: origin.parentRunId, generation: origin.parentGeneration };
    const assertScope = () => {
      context.signal.throwIfAborted();
      const control = companion.tasks.getControl();
      if (control.stopped || control.generation !== controlGeneration) return fail('SERVICE_STOPPED', '伴随服务已停止派发。');
      if (canonicalWfdJson(this.options.origin(context.task.id)) !== frozenOrigin || !core.isRunActive(origin.parentRunId, origin.parentGeneration))
        return fail('RETRIEVAL_CONVERSATION_SCOPE', '原会话来源或运行代次已变化。');
      if (generation !== undefined) companion.localData!.assertPrivateAccess(generation);
      return this.allowedDocuments(inputScope);
    };
    const documentIds = assertScope();
    const authority = await acquireAuthority(context, action, args, []);
    const assert = () => {
      authority.assert();
      const current = new Set(assertScope());
      if (documentIds.some(id => !current.has(id))) return fail('MODEL_SHARE_REVOKED', '检索期间分支材料授权已变化。');
    };
    assert();
    const segments = companion.segments;
    if (!segments) return fail('RETRIEVAL_CONVERSATION_UNAVAILABLE', '文档片段服务未装配。');
    let result: WfdRecord;
    switch (action.slice(PREFIX.length)) {
      case 'capabilities': case 'documents': {
        const start = integer(args.offset, 0, 0, 1_000_000), count = integer(args.limit, 10, 1, PAGE_LIMIT);
        result = action.endsWith('.documents') ? { storageState: segments.readState(), ...page(segments.documents(documentIds), start, count) }
          : { segments: segments.capabilities(documentIds), structured: companion.structuredRetrieval?.capabilities() ?? null,
            indexVersions: page(segments.indexVersions(documentIds), start, count) };
        break;
      }
      case 'search': {
        const { query, method, mode } = args;
        if (typeof query !== 'string' || !query.trim() || query.length > 2048 || method !== 'keyword' && method !== 'exact'
          || mode !== 'market_known_at' && mode !== 'system_held_at') return invalid();
        const excludedOffset = integer(args.excludedOffset, 0, 0, 1_000_000);
        result = searchPreview(segments.search({ method, mode, query, indexVersion: fixedId(args.indexVersion),
          asOf: isoCutoff(args.asOf), limit: integer(args.limit, 10, 1, PAGE_LIMIT) }, documentIds), excludedOffset);
        break;
      }
      case 'joint': {
        if (!companion.structuredRetrieval) { result = { status: 'unavailable', gaps: ['structured_retrieval_not_wired'] }; break; }
        if (typeof args.jointJson !== 'string' || args.jointJson.length > 32_768) return invalid();
        let input: unknown;
        try { input = JSON.parse(args.jointJson); } catch { return invalid(); }
        if (!isWfdRecord(input) || !isWfdRecord(input.structured) || !isWfdRecord(input.documents)) return invalid();
        fixedId(input.documents.indexVersion);
        const cap = (value: unknown) => Math.min(PAGE_LIMIT, integer(value, PAGE_LIMIT, 1, Number.MAX_SAFE_INTEGER));
        const boundedQuery = { ...input, structured: { ...input.structured, page_size: cap(input.structured.page_size) },
          documents: { ...input.documents, limit: cap(input.documents.limit) } };
        const joined = await companion.structuredRetrieval.search(boundedQuery, context.signal, { allowedDocumentIds: documentIds, assertCurrent: assert });
        assert();
        const structured = isWfdRecord(joined.structured) ? joined.structured : {};
        result = { schema: joined.schema, status: joined.status, qualification: joined.qualification, gaps: joined.gaps,
          page: joined.page, context_digest: joined.context_digest,
          structured: { dataset_id: structured.dataset_id, snapshot_id: structured.snapshot_id, coverage: structured.coverage, gaps: structured.gaps },
          objects: joined.objects };
        break;
      }
      case 'evidence': {
        const evidence = await this.options.readEvidence({ indexVersion: fixedId(args.indexVersion), segmentId: fixedId(args.segmentId) }, assert, documentIds);
        result = { schema: evidence.schema, cache: evidence.cache, artifact: evidence.artifact, original: evidence.original,
          factVerification: evidence.factVerification, historicalQualification: evidence.historicalQualification,
          limitations: evidence.limitations, citation: evidence.citation };
        break;
      }
      default: return invalid();
    }
    assert();
    const view = { versionBinding: this.versionBinding, ...result };
    const modelPreview = modelProjection(view, true);
    const modelEvidence = modelPreview.previewTruncated ? modelProjection(view, false) : null;
    // Reserve room for the existing task/evidence envelope (summary, IDs and persistence facts).
    if (modelEvidence && Buffer.byteLength(JSON.stringify(modelEvidence)) > MAX_RETAINED_EVIDENCE_BYTES - 56_000)
      return fail('RETRIEVAL_EVIDENCE_BUDGET', '单页完整证据超出保管预算，请缩小查询或页长。');
    return { summary: registration.title, data: { kind: 'conversation-retrieval', accessGeneration: generation ?? null,
      branchId: origin.branchId, documentScope: documentIds, modelPreview,
      ...(modelEvidence ? { modelEvidence } : {}) } };
  }
}

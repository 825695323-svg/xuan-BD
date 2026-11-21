import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { ConversationRetrievalBridge } from './conversation-retrieval.js';
import { StructuredRetrievalService } from './structured-retrieval.js';
import { NOT_APPLICABLE_TIME, type DocumentTimeRecord, type RetrievalCitation, type SegmentRetrievalResult } from './segments/contracts.js';
import type { SearchRequestInput, SegmentService } from './segments/service.js';

const asOf = '2024-06-01T00:00:00Z', indexVersion = 'idx_fixed', query = { indexVersion, asOf, mode: 'market_known_at', method: 'exact', query: '指标' };
const doc: DocumentTimeRecord = { document_id: 'material-1', document_version: '1', parser_version: 'bd.segmenter/1', artifact_ref: 'artifact-1',
  artifact_sha256: 'a'.repeat(64), origin_sha256: 'b'.repeat(64), acquired_at: 10, event_time: NOT_APPLICABLE_TIME, disclosed_at: NOT_APPLICABLE_TIME,
  parsed_at: 20, page_count: 1, segment_count: 1, issues: ['ocr_unverified_recognition'] };
const citation: RetrievalCitation = { segment_id: 'segment-1', document_id: doc.document_id, document_version: '1', parser_version: doc.parser_version,
  ordinal: 1, kind: 'paragraph', page_number: 1, page_label: null, section_path: [], bbox: null, table: null, excerpt: '指标',
  excerpt_truncated: false, text_digest: 'c'.repeat(64), char_start: 0, char_end: 2, artifact_ref: doc.artifact_ref, index_version: indexVersion,
  document_issues: doc.issues, issues: doc.issues };
const origin: ModelTaskOrigin = { callId: 'call', conversationId: 'conversation', parentRunId: 'run', parentGeneration: 7, inputId: 'input',
  branchId: 'selected', messageId: 'message', modelDigest: 'model', endpointDigest: 'endpoint', toolCallId: 'tool', toolName: 'perform_action',
  notice: '', receiver: { provider: 'test', model: 'test', origin: 'local' } };

function fixture(joint = true) {
  const state = { origin: structuredClone(origin) as ModelTaskOrigin | null, stopped: false, generation: 3, active: true, branch: 'selected',
    authorized: true, authorityCalls: 0, evidenceCalls: 0, jointCalls: 0, changedDuringRead: false };
  const queries: SearchRequestInput[] = [], docs = [structuredClone(doc)], citations = [structuredClone(citation)];
  const exclusions = Array.from({ length: 23 }, (_, n) => ({ document_id: 'excluded-' + n, document_version: '1', reason: 'disclosure_time_unknown' as const }));
  const port = { capabilities: () => ({ schema: 'bd.doc-retrieval/2', ocr: { wired: true, runnerAvailable: null } }),
    documents: () => docs, indexVersions: () => [{ index_version: indexVersion, tokenizer: 'test', built_at: 200, segment_count: 1, document_count: 1 }],
    attachJointRetrieval() {},
    search(input: SearchRequestInput): SegmentRetrievalResult {
      queries.push(input);
      const missing = input.indexVersion !== indexVersion;
      return { schema: 'bd.doc-retrieval/2', status: missing ? 'index_missing' : 'matched', structured: null,
        query: { as_of: input.asOf!, method: input.method, text: input.query }, qualification: { applied: true,
          mode: input.mode!, reconstruction: 'post_hoc', index_built_at: 200 }, citations: missing ? [] : citations,
        coverage: { index_version: missing ? null : indexVersion, index_built_at: missing ? null : 200,
          indexed_segments: 1, indexed_documents: 1, documents_without_text_layer: 1, as_of: Date.parse(asOf), excluded: exclusions },
        gaps: missing ? ['index_version_not_found'] : ['documents_without_text_layer'] };
    } };
  const structured = new StructuredRetrievalService({ segments: port as unknown as SegmentService, structured: {
    beginJointEvidenceRead: () => ({ assertCurrent() {}, recordMaterials(identity) {
      assert.deepEqual(identity, { datasetId: 'd1', productId: 'p1', recordId: 'r1', recordVersion: 'v2' });
      return { requestId: 'q1', materialIds: [doc.document_id] } as any;
    } }),
    async filterObjects() {
      state.jointCalls++;
      if (state.changedDuringRead) state.branch = 'another';
      return { status: 'matched', dataset_id: 'd1', snapshot_id: 'fixed-snapshot', page: { done: true }, coverage: { data_complete: true },
        objects: [{ subject: { id: 's1' }, values: { metric: 42 }, record_refs: { metric: { product_id: 'p1', record_ref: { logical_key: 'r1', revision_id: 'v2' } } } }] };
    } } });
  const bridge = new ConversationRetrievalBridge({ origin: () => state.origin,
    core: { isRunActive: (id, gen) => state.active && id === 'run' && gen === 7,
      store: { command: () => ({ text: 'test input' }) } as unknown as PersonalCore['store'],
      selectedAttachmentsForInput(input) {
        assert.equal(input.branchId, state.branch, 'stale branch'); assert.equal(input.inputId, 'input');
        assert.equal(input.messageId, 'message'); assert.equal(input.text, 'test input'); return [];
      } },
    companion: { segments: port, structuredRetrieval: joint ? structured : undefined,
      tasks: { getControl: () => ({ scope: 'service', generation: state.generation, stopped: state.stopped,
        persisted: true, activeTaskIds: [], reason: null, updatedAt: 1 }) } },
    async readEvidence(input, assertCurrent) {
      state.evidenceCalls++; assert.deepEqual(input, { indexVersion, segmentId: citation.segment_id }); assertCurrent();
      await Promise.resolve();
      if (state.changedDuringRead) state.stopped = true;
      assertCurrent();
      return { schema: 'bd.retrieval-evidence/1', citation: citations[0]!, cache: { status: 'verified', reason: 'text_digest' },
        artifact: { status: 'mismatch', reason: 'artifact_bytes_mismatch' }, original: { status: 'unknown', reason: 'source_unavailable' },
        factVerification: 'not_established', historicalQualification: 'not_evaluated', limitations: ['byte integrity only'],
        limits: { maxArtifactBytes: 100, maxOriginalBytes: 100 } };
    } });
  const context = (action: string, args: JsonValue) => ({ signal: new AbortController().signal, task: { id: 'task', action, args, runtimeId: 'direct', conversationId: 'conversation' },
    assertAuthorized(op: { operationId: string }, capabilities: unknown[]) {
      assert.equal(op.operationId, action); assert.deepEqual(capabilities, []); state.authorityCalls++;
      if (!state.authorized) throw new Error('model sharing revoked');
    } }) as unknown as TaskExecutionContext;
  async function call(name: string, args: Record<string, JsonValue> = {}) {
    const result = await bridge.execute(context('data.retrieval.' + name, args));
    assert.equal((result.data as any).kind, 'conversation-retrieval'); return (result.data as any).modelPreview;
  }
  return { bridge, state, queries, docs, citations, call, context };
}

test('five read-only direct registrations, host version binding, paginated capabilities and documents', async () => {
  const h = fixture();
  assert.deepEqual(h.bridge.registrations.map(s => s.action), ['capabilities', 'documents', 'search', 'joint', 'evidence'].map(s => 'data.retrieval.' + s));
  assert.ok(h.bridge.registrations.every(s => s.kind === 'direct' && s.runtimeId === 'direct' && s.modelCalls === 0 && h.bridge.handles(s.action)));
  const caps = await h.call('capabilities'); assert.deepEqual(caps.versionBinding, h.bridge.versionBinding);
  assert.equal(caps.indexVersions.items[0].index_version, indexVersion); assert.equal(caps.structured.schema, caps.versionBinding.structured);
  h.docs.unshift({ ...doc, document_version: '/Users/test/private-folder/doc' });
  const first = await h.call('documents', { limit: 1 }); assert.equal(first.pathsWithheld, true);
  assert.equal(first.nextOffset, 1); assert.doesNotMatch(JSON.stringify(first), /private-folder/u);
  assert.deepEqual((await h.call('documents', { offset: 1, limit: 1 })).items, [doc]);
  assert.ok(h.state.authorityCalls >= 6);
});

test('search passes the pinned index and both time gates, paginates exclusions, retains explicit missing index and gaps', async () => {
  const h = fixture();
  for (const method of ['keyword', 'exact']) for (const mode of ['market_known_at', 'system_held_at']) {
    const value = await h.call('search', { ...query, method, mode, excludedOffset: 20, limit: 2 });
    assert.deepEqual(h.queries.at(-1), { indexVersion, method, mode, asOf, query: query.query, limit: 2 });
    assert.equal(value.qualification.mode, mode); assert.equal(value.qualification.reconstruction, 'post_hoc');
    assert.equal(value.coverage.excludedTotal, 23); assert.equal(value.coverage.excluded[0].document_id, 'excluded-20');
    assert.equal(value.coverage.excluded[2].reason, 'disclosure_time_unknown');
    assert.deepEqual(value.gaps, ['documents_without_text_layer']); assert.deepEqual(value.citations[0].issues, doc.issues);
  }
  const missing = await h.call('search', { ...query, indexVersion: 'missing' }); assert.equal(missing.status, 'index_missing');
  assert.deepEqual(missing.gaps, ['index_version_not_found']); assert.equal(h.queries.at(-1)!.indexVersion, 'missing');
  const n = h.queries.length;
  const invalidInputs: Record<string, JsonValue>[] = [{ indexVersion: '' }, { indexVersion: 'latest' }, { asOf: null }, { asOf: 'today' }, { asOf: '2024-02-31' },
    { method: 'semantic' }, { mode: null }, { query: ' ' }, { limit: 21 }, { sourcePath: '/tmp' }];
  for (const invalid of invalidInputs) await assert.rejects(h.call('search', { ...query, ...invalid }));
  assert.equal(h.queries.length, n);
});

test('joint calls exact verified record-version association, preserves qualifications and does not fall back', async () => {
  const h = fixture();
  const plan = { structured: { history_mode: query.mode, knowledge_cutoff: { status: 'known', earliest_utc: asOf } }, documents: query };
  const args = { jointJson: JSON.stringify(plan) };
  const result = await h.call('joint', args); assert.equal(result.status, 'matched');
  assert.equal(result.objects[0].values.metric, 42); assert.equal(result.qualification.same_historical_cutoff, true);
  assert.deepEqual(h.queries[0]!.documentIds, [doc.document_id]); assert.equal(h.queries[0]!.indexVersion, indexVersion);
  await assert.rejects(h.call('joint', { jointJson: JSON.stringify({ ...plan, documents: { ...query, mode: 'system_held_at' } }) }));
  assert.equal(h.state.jointCalls, 1);
  const absent = fixture(false), unavailable = await absent.call('joint', args);
  assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.gaps, ['structured_retrieval_not_wired']);
  assert.equal(absent.queries.length, 0); assert.equal(absent.bridge.versionBinding.structured, null);
  h.state.changedDuringRead = true; await assert.rejects(h.call('joint', args), /stale branch/u);
});

test('fixed evidence retains three independent checks and limits model excerpts, paths and total bytes', async () => {
  const h = fixture(), input = { indexVersion, segmentId: citation.segment_id };
  Object.assign(h.citations[0]!, { section_path: ['C:\\Users\\owner\\report'], excerpt: '摘录'.repeat(3000) });
  const evidence = await h.call('evidence', input);
  assert.equal(evidence.cache.status, 'verified'); assert.equal(evidence.artifact.status, 'mismatch'); assert.equal(evidence.original.status, 'unknown');
  assert.equal(evidence.factVerification, 'not_established'); assert.equal(evidence.citation.excerpt_truncated, true);
  assert.equal(evidence.previewTruncated, true); assert.equal(evidence.pathsWithheld, true); assert.doesNotMatch(JSON.stringify(evidence), /owner/u);
  h.citations.push(...Array.from({ length: 1000 }, () => structuredClone(h.citations[0]!)));
  const long = await h.call('search', query); assert.equal(long.previewTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 60_000);
  await assert.rejects(h.call('evidence', { ...input, path: '/tmp/injected' }));
  await assert.rejects(h.call('evidence', { ...input, segmentId: '../id' })); assert.equal(h.state.evidenceCalls, 1);
});

test('origin, selected branch, stop, authority and late revocation are checked before sharing', async () => {
  for (const fault of ['origin', 'inactive', 'branch', 'stop', 'authority', 'late']) {
    const h = fixture();
    if (fault === 'origin') h.state.origin = null;
    if (fault === 'inactive') h.state.active = false;
    if (fault === 'branch') h.state.branch = 'sibling';
    if (fault === 'stop') h.state.stopped = true;
    if (fault === 'authority') h.state.authorized = false;
    if (fault === 'late') h.state.changedDuringRead = true;
    await assert.rejects(h.call('evidence', { indexVersion, segmentId: citation.segment_id }));
    assert.equal(h.state.evidenceCalls, fault === 'late' ? 1 : 0);
  }
  const h = fixture(), context = h.context('data.retrieval.documents', {});
  await assert.rejects(h.bridge.execute(context, 'data.retrieval.capabilities', {}));
  await assert.rejects(h.bridge.execute(context, context.task.action, { limit: 1 }));
});

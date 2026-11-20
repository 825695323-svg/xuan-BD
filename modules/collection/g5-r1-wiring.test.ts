import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity, R1PrepareInput, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import {
  TABULAR_BATCH_PROTOCOL, TABULAR_CONTRACT_VERSION, tabularDigest, tabularIdentityRule,
  type TabularBatchChunk, type TabularTableContract,
} from '../../contracts/tabular-batch.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { digestOperationArgs, PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { ALGORITHM_METHODS, type AlgorithmComputedResult, type AlgorithmData, type AlgorithmTaskView } from '../financial/algorithm-types.js';
import { DerivedWfdPublisher } from '../financial/derived-wfd-publisher.js';
import { G5_ADMISSION_RECEIPT_VERSION, verifyG5AdmissionReceiptDigest, type G5AdmissionReceipt } from './g5-admission-receipt.js';
import { ManagedOriginalStore } from './managed-originals.js';
import { MaterialService } from './materials/service.js';
import { PostPublicationCorrectionService, type CorrectionKind } from './post-publication-correction.js';
import { PROCESSING_PLAN_VERSION, type OperatorContext, type ProcessingPlanService } from './processing-plan.js';
import { R1AutoService } from './r1-auto.js';
import { resolveR1Evidence } from './r1-evidence.js';
import { checkR1MappedRows } from './r1-event.js';
import { readR1G5SnapshotHistory, r1G5ProductId, type R1G5HistoryTarget } from './r1-g5-admission.js';
import type { R1Runtime } from './r1-runtime.js';
import {
  R1_SOURCE_MINUTE_ACTIONS, R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS, R1_TABULAR_BULK_MODE, R1SourceMinuteBulkService,
} from './r1-source-minute-bulk-service.js';
import { buildSourceMinuteBatchHeader } from './r1-source-minute-transport.js';
import { R1HandoffService, type R1LocalReferences } from './r1-structured-handoff.js';
import { buildTabularBatchHeader, verifyTabularBatchReadback, verifyTabularBatchReceipt } from './r1-tabular-bulk-transport.js';
import { R1_WORKSPACE_RUNTIME, R1WorkspaceService } from './r1-workspace.js';
import { profileFingerprint, readSourceFieldProfile, SourceFieldProfileStore, sourceFieldProfileDigest, type SourceDomainScope } from './source-field-profile.js';
import { TabularBulkProfileStore } from './tabular-bulk-profile.js';

const series = 'synthetic-series';
const datasetId = 'synthetic-g5';
const namespace = 'synthetic.g5';
const snapshotId = 's_' + '1'.repeat(24);
const definitionDigest = 'sha256:' + '2'.repeat(64);
const start = '2026-01-02T00:00:00Z';
const end = '2026-01-03T00:00:00Z';
const schemaPath = fileURLToPath(new URL('../../wfd/product/protocol/schemas/wfd-structured-ingest.schema.json', import.meta.url));
const coverage = { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' };
const subject = { kind: 'entity', namespace, id: 'synthetic-object' };
const usageStatus = async () => ({ result: { format_version: 'wfd.usage-suspension/1', issues: [], tickets: [],
  active_issues: 0, suspended_record_versions: 0 } });

const source = (sourceId: string): R1SourceDeclaration => ({ source_id: sourceId, provider: 'synthetic-provider',
  requested_url: 'file:///synthetic/' + series + '/input.csv', requested_at_utc: start, acquired_at_utc: end,
  usage_scope: 'isolated synthetic test', authorization: { status: 'authorized', basis: 'synthetic fixture' } });
const operator = (requestId: string): OperatorContext => ({ operatorId: 'synthetic.operator', requestId, method: 'POST',
  path: '/synthetic/r1', remoteAddress: null, observedAt: Date.now() });

const eventScope: SourceDomainScope = { domain: 'event_claim', eventSemantics: {
  contentNature: 'source_claim', occurrencePolicy: 'preserve_distinct_propagation',
  timePrecisionPolicy: 'preserve_unknown_no_midnight_fill',
} };
const relationScope = (taxonomyAuthority: string): SourceDomainScope => ({
  domain: 'relation_claim', taxonomyAuthority, effectivePeriodPolicy: 'explicit_range',
});

function profile(sourceId: string, domainScope: SourceDomainScope = { domain: 'market_series' }, timezone = 'UTC') {
  const market = domainScope.domain === 'market_series';
  return readSourceFieldProfile({
    version: 'bd.source-field-profile/1', profileId: sourceId + '-profile', sourceId, series, domainScope,
    fields: [{ originalHeader: 'key', fieldCode: 'object_id', dataType: 'text', unitCode: 'not_applicable', role: 'identity' }],
    frequency: market ? 'day' : 'other', adjustment: { status: market ? 'raw' : 'not_applicable' },
    timeBucket: market ? { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 1440, timezone }
      : { kind: 'not_applicable', timezone },
    confirmation: { status: 'operator_confirmed', basis: 'Synthetic test semantics', confirmedAtUtc: start },
  }, 'synthetic.json');
}

function isolated(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bd-g5-wiring-')));
  const archive = join(root, 'archive'), profiles = join(root, 'profiles');
  mkdirSync(archive);
  mkdirSync(profiles);
  const database = new CoreDatabase();
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  const identity: R1ConnectionIdentity = { connectionId: 'synthetic', protocol: 'wfd.structured-ingest/1.0',
    profile: 'data_only', mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'synthetic',
    store: archive, runtime: root, callerId: 'synthetic', namespace,
    configSha256: 'synthetic', schemaSha256: 'synthetic', entrySha256: 'synthetic', pythonPath: root, entryPath: root };
  const machine = {
    usageStatus,
    contractDiscovery: async (id: string) => ({ result: { snapshot_id: id, product_count: 0, products: [] } }),
    snapshotStatus: async () => ({ result: { format_version: 'wfd.snapshot-status/1', profile: 'data_only', authority: 'active_head',
      snapshot_id: snapshotId, empty: false, connection_id: identity.connectionId, caller_id: identity.callerId,
      trusted_actor_namespace: identity.namespace, caller_roles: ['read', 'submit', 'publish'], unit_definitions: {} } }),
  };
  const runtime = { currentIdentity: () => identity, connection: { schemaPath, store: archive, runtime: root }, client: machine } as unknown as R1Runtime;
  const control = () => ({ stopped: false, generation: 0 });
  return { root, archive, database, identity, runtime, machine, control, profiles: new SourceFieldProfileStore(profiles),
    adopt: (value: ReturnType<typeof profile>) => writeFileSync(join(profiles, value.profileId + '.json'), canonicalWfdJson(value)) };
}

function receiptFromRefs(raw: unknown, expected: Partial<G5AdmissionReceipt>) {
  const refs = JSON.parse(String(raw)) as R1LocalReferences;
  const evidence = refs.evidenceRefs.filter(item => item.kind === G5_ADMISSION_RECEIPT_VERSION);
  assert.equal(evidence.length, 1);
  const receipt = assertReceipt(evidence[0]!.g5AdmissionReceipt, expected);
  assert.equal(evidence[0]!.ref_id, 'g5:' + receipt.receiptDigest);
  assert.equal(evidence[0]!.content_sha256, receipt.receiptDigest);
  assert.equal(receipt.sourceId, refs.sourceRefs[0]!.source_id);
  return receipt;
}

function assertReceipt(receipt: G5AdmissionReceipt | undefined, expected: Partial<G5AdmissionReceipt>) {
  assert.ok(receipt);
  assert.ok(verifyG5AdmissionReceiptDigest(receipt));
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(receipt[key as keyof G5AdmissionReceipt], value, key);
  }
  return receipt;
}

function seedHistory(database: CoreDatabase, handoff: R1HandoffService, productId: string, sourceId: string, recordId = 'history-' + sourceId) {
  const bytes = Buffer.from('synthetic published original ' + sourceId);
  const { originalId } = handoff.registerOriginal({ bytes, originalName: 'history.csv',
    source: { ...source(sourceId), sha256: wfdSha256(bytes), bytes: bytes.length } });
  database.connection.prepare('INSERT INTO r1_record_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(datasetId, productId, definitionDigest, snapshotId, recordId, 'revision-1',
      'historical-' + sourceId, originalId, sourceId, '[]', '[]', 0);
}

type TargetKind = 'tabular' | 'event_records' | 'relation_edges';

function workspaceFixture(t: TestContext, withProfiles = true) {
  const f = isolated(t);
  const originals = new Map<string, Buffer>();
  const artifacts = new Map<string, Buffer>();
  const plans = new Map<string, WfdRecord>();
  const get = (planId: string) => {
    const plan = plans.get(planId);
    assert.ok(plan, planId);
    return plan;
  };
  const outputArtifact = (planId: string, outputId: string) => {
    const bytes = artifacts.get(planId + ':' + outputId);
    assert.ok(bytes);
    return { bytes, ref: { sha256: wfdSha256(bytes) } };
  };
  const handoff = new R1HandoffService({ database: f.database, processing: { get, outputArtifact }, requireG5Admission: withProfiles });
  const processing = { get, outputArtifact, hasMediaClaims: () => false, verifyMediaClaims: async () => {},
    candidateOutput: (planId: string, outputId: string) => {
      const output = (get(planId).outputs as WfdRecord[]).find(item => item.outputId === outputId);
      assert.ok(output);
      return { ...output, ref: outputArtifact(planId, outputId).ref };
    },
  } as unknown as ProcessingPlanService;
  const materials = { get: () => ({ envelope: { filename: 'synthetic.csv', mediaType: 'text/csv' } }),
    readOriginal: (materialId: string) => {
      const bytes = originals.get(materialId);
      assert.ok(bytes);
      return { bytes, sha256: wfdSha256(bytes) };
    },
  } as unknown as MaterialService;
  const workspace = new R1WorkspaceService({ database: f.database, tasks: () => ({ getControl: f.control }) as TaskService,
    handoff, processing, materials, runtime: f.runtime, configuration: { state: 'ready', reason: null },
    ...(withProfiles ? { fieldProfiles: f.profiles } : {}) });

  function plan(requestId: string, members: { sourceId: string; kind?: TargetKind; outputId?: string; recordId?: string;
    semanticCode?: string; unknownEffectivePeriod?: boolean }[]) {
    const planId = requestId + '-plan';
    const set = members.length > 1;
    const steps: WfdRecord[] = [], integrity: WfdRecord[] = [], inputs: R1PrepareInput[] = [];
    const planMaterials: WfdRecord[] = [];
    const outputs = members.map(({ sourceId, kind = 'tabular', outputId = 'output', recordId = requestId + '-' + outputId,
      semanticCode = 'synthetic.' + outputId, unknownEffectivePeriod = false }) => {
      const time = { status: 'unknown', sourceTimezone: 'UTC' } as const;
      const fields = [{ fieldCode: 'reading', value: 'value', state: 'state' }];
      const mapping: R1PrepareInput['mapping'] = kind === 'tabular'
        ? { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
          precision: 'day', sourceTimezone: 'UTC', fields }
        : kind === 'event_records'
          ? { kind, eventId: 'key', eventType: 'type', assertionKind: 'nature', contentNature: 'source_claim',
            status: 'unknown', eventTime: time, publicTime: time, fields }
          : { kind, businessKey: 'key', relationType: 'type', object: { kind: 'object_kind', namespace: 'object_ns', id: 'object_id' },
            effectivePeriod: unknownEffectivePeriod ? time
              : { status: 'known', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC' },
            publicTime: time, fields };
      const measurement_nature = kind === 'tabular' ? 'stock' : kind === 'event_records' ? 'event' : 'relation';
      const time_role = kind === 'tabular' ? 'observation' : kind === 'event_records' ? 'event' : 'validity';
      const definition = { semantic_code: semanticCode, definition_authority: namespace,
        measurement_nature: kind === 'tabular' ? 'mixed_observation' : measurement_nature, time_role,
        unit_code: kind === 'tabular' ? 'per_field' : 'not_applicable',
        field_definitions: [{ field_code: 'reading', data_type: kind === 'tabular' ? 'decimal' : 'text',
          unit_code: kind === 'tabular' ? 'count' : 'text', measurement_nature, time_role }],
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: kind === 'tabular' ? 'observed_fact' : 'source_claim',
          ...(kind === 'tabular' ? { time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } } : {}) } };
      const target: R1PrepareInput['target'] = { datasetId, outputKey: outputId, expectedParentSnapshotId: snapshotId,
        subject, inputMode: 'partial_observation', definition, coverage };
      const declaredSource = source(sourceId);
      inputs.push({ requestId, planId, outputId, target, source: declaredSource, mapping });
      const row = { key: recordId, start, end, value: kind === 'tabular' ? '12.30' : 'Synthetic source claim',
        state: 'valid_value', type: 'synthetic_notice', nature: 'source_claim', object_kind: 'entity', object_ns: namespace,
        object_id: 'synthetic-related-object' };
      const materialId = planId + ':' + outputId;
      const original = Buffer.from(canonicalWfdJson(row));
      originals.set(materialId, original);
      artifacts.set(materialId, Buffer.from(canonicalWfdJson({ rows: [row] })));
      planMaterials.push({ materialId, sha256: wfdSha256(original) });
      steps.push({ stepId: materialId, outputId, dependsOn: [], state: 'succeeded' });
      integrity.push({ stepId: materialId, present: true });
      return { outputId, state: 'structured', materialIds: [materialId], publishEligible: true, routingState: 'ready_candidate',
        target: { expectedSnapshotId: snapshotId, declaration: { protocol: 'wfd.structured-ingest/1.0', target, source: declaredSource, mapping } },
        usage: { purpose: 'current_publish', purposeEvidence: [{ purpose: 'current_publish', authority: 'operator-http',
          quote: 'structured action: intendedAction=publish', observedAtUtc: start, evidenceSha256: '3'.repeat(64), requestId }] } };
    });
    plans.set(planId, { planId, version: PROCESSING_PLAN_VERSION, steps, integrity, missingSteps: [], missingOutputs: [],
      outputs, materials: planMaterials, consistencyGroups: set ? { group: members.map(member => member.outputId) } : {} });
    return { planId, inputs };
  }
  function declaration(input: R1PrepareInput): WfdRecord {
    const output = (get(input.planId).outputs as WfdRecord[]).find(item => item.outputId === input.outputId)!;
    return (output.target as { declaration: WfdRecord }).declaration;
  }
  return { ...f, handoff, workspace, plan, declaration, outputArtifact,
    history: (productId: string, sourceId: string, recordId?: string) => seedHistory(f.database, handoff, productId, sourceId, recordId) };
}

function productOf(input: R1PrepareInput, kind: TargetKind = 'tabular') {
  return r1G5ProductId(input.target.datasetId, kind, input.target.subject, input.target.definition);
}

test('workspace tabular preparation freezes same-source and equivalent cross-source decisions', async t => {
  const f = workspaceFixture(t);
  const peer = profile('peer');
  f.adopt(peer);
  f.adopt(profile('incoming'));
  const repeat = f.plan('same-source', [{ sourceId: 'peer' }]).inputs[0]!;
  const productId = productOf(repeat);
  f.history(productId, 'peer');

  await f.workspace.prepareWithRestriction(repeat);
  const saved = f.handoff.attempt(repeat.requestId).local_refs_json;
  receiptFromRefs(saved, { entryPoint: 'r1_workspace_tabular', decision: 'allow_same_source_repeat', targetProductId: productId });
  await f.workspace.prepareWithRestriction(repeat);
  assert.equal(f.handoff.attempt(repeat.requestId).local_refs_json, saved);

  const equivalent = f.plan('equivalent', [{ sourceId: 'incoming' }]).inputs[0]!;
  await f.workspace.prepareWithRestriction(equivalent);
  const receipt = receiptFromRefs(f.handoff.attempt(equivalent.requestId).local_refs_json,
    { entryPoint: 'r1_workspace_tabular', decision: 'allow_reuse_product', targetProductId: productId });
  assert.equal(receipt.peerComparisons[0]?.profileDigest, sourceFieldProfileDigest(peer));
});

test('workspace tabular preparation fails closed for conflicting and unprofiled historical sources', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('incoming'));
  f.adopt(profile('conflicting', undefined, 'Asia/Shanghai'));
  for (const [peer, code, decision] of [
    ['conflicting', 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT', 'block_semantic_conflict'],
    ['unprofiled', 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', 'block_peer_profile_unavailable'],
  ] as const) {
    const input = f.plan(peer + '-blocked', [{ sourceId: 'incoming', outputId: peer }]).inputs[0]!;
    f.history(productOf(input), peer);
    await assert.rejects(f.workspace.prepareWithRestriction(input), { code, message: new RegExp(decision) });
    assert.throws(() => f.handoff.attempt(input.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
  }
  assert.deepEqual(f.workspace.list(), []);
});

test('workspace event sources keep distinct propagation on the same product', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('first', eventScope));
  f.adopt(profile('second', eventScope, 'Asia/Shanghai'));
  const first = f.plan('event-first', [{ kind: 'event_records', sourceId: 'first' }]).inputs[0]!;
  const second = f.plan('event-second', [{ kind: 'event_records', sourceId: 'second' }]).inputs[0]!;
  const productId = productOf(first, 'event_records');
  const eventIds = [];
  for (const input of [first, second]) {
    const view = await f.workspace.prepareWithRestriction(input);
    eventIds.push(view.previewRows[0]?.event_id);
    assert.equal(JSON.parse(String(f.handoff.attempt(input.requestId).document_json)).duplicate_policy, undefined);
    receiptFromRefs(f.handoff.attempt(input.requestId).local_refs_json, { entryPoint: 'r1_workspace_event',
      targetProductId: productId, policy: 'domain_profile_only_no_cross_merge', decision: 'allow_domain_profile_only',
      exemptionCode: 'event_distinct_propagation_preserved', peerSourceIds: input === first ? [] : ['first'], peerComparisons: [] });
    if (input === first) f.history(productId, input.source.source_id, String(view.previewRows[0]?.event_id));
  }
  assert.deepEqual(eventIds, ['event-first-output', 'event-second-output']);
  const collision = f.plan('event-collision', [{ kind: 'event_records', sourceId: 'second', recordId: 'event-first-output' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction(collision), { code: 'R1_EVENT_PROPAGATION_COLLISION' });
  assert.throws(() => f.handoff.attempt(collision.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
});

function fixedHistory(product: WfdRecord, identities: readonly [string, string][]) {
  return { snapshot_id: snapshotId, perspective: 'snapshot_contents', include_history: true, products: [product],
    rows: identities.map(([recordId, version]) => ({ record_id: recordId, record_version: version,
      record_ref: { snapshot_id: snapshotId, product_id: product.product_id, logical_key: recordId, revision_id: version } })) };
}

test('published product needs complete fixed-snapshot record coverage', async t => {
  const f = workspaceFixture(t);
  const input = f.plan('partial-published-history', [{ sourceId: 'incoming' }]).inputs[0]!;
  const productId = productOf(input);
  f.adopt(profile('incoming'));
  f.adopt(profile('peer'));
  f.history(productId, 'peer');
  const product = { product_id: productId, dataset_id: datasetId, subject, declaration: input.target.definition,
    logical_domain: 'observations', payload_kind: 'tabular_rows', published_record_count: 2, published_source_ids: ['peer'] };
  Object.assign(f.machine, {
    contractDiscovery: async () => ({ result: { snapshot_id: snapshotId, product_count: 1, products: [product] } }),
    fixedReadHistory: async () => ({ result: fixedHistory(product, [['history-peer', 'revision-1'], ['second-published-row', 'revision-1']]) }),
  });
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_PEER_HISTORY_INCOMPLETE', message: /无法核全/u });
  assert.throws(() => f.handoff.attempt(input.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
  f.history(productId, 'peer', 'second-published-row');
  await f.workspace.prepareWithRestriction(input);
  receiptFromRefs(f.handoff.attempt(input.requestId).local_refs_json, { peerSourceIds: ['peer'], decision: 'allow_reuse_product' });
});

test('equal counts cannot substitute a different fixed-snapshot record ID or version', async t => {
  const f = workspaceFixture(t);
  const input = f.plan('mismatched-published-history', [{ sourceId: 'incoming' }]).inputs[0]!;
  const productId = productOf(input);
  f.adopt(profile('incoming'));
  f.adopt(profile('peer'));
  f.history(productId, 'peer');
  f.history(productId, 'peer', 'unrelated-row');
  const product = { product_id: productId, dataset_id: datasetId, subject, declaration: input.target.definition,
    logical_domain: 'observations', payload_kind: 'tabular_rows', published_record_count: 2 };
  Object.assign(f.machine, {
    contractDiscovery: async () => ({ result: { snapshot_id: snapshotId, product_count: 1, products: [product] } }),
    fixedReadHistory: async (snapshot: string, id: string) => {
      assert.equal(snapshot, snapshotId);
      assert.equal(id, productId);
      return { result: fixedHistory(product, [['history-peer', 'revision-1'], ['second-published-row', 'revision-2']]) };
    },
  });
  const mismatch = { code: 'G5_PEER_HISTORY_INCOMPLETE', message: /关联集合不一致/u };
  await assert.rejects(f.workspace.prepareWithRestriction(input), mismatch);
  f.database.connection.prepare("UPDATE r1_record_associations SET record_id='second-published-row' WHERE record_id='unrelated-row'").run();
  await assert.rejects(f.workspace.prepareWithRestriction(input), mismatch);
  assert.throws(() => f.handoff.attempt(input.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
  f.database.connection.prepare("UPDATE r1_record_associations SET record_version='revision-2' WHERE record_id='second-published-row'").run();
  await f.workspace.prepareWithRestriction(input);
});

test('workspace exact event IDs require cross-source profiles and strict append', async t => {
  const f = workspaceFixture(t);
  const exact: SourceDomainScope = { ...eventScope,
    eventSemantics: { ...eventScope.eventSemantics!, occurrencePolicy: 'exact_event_id_only' } };
  f.adopt(profile('incoming', exact));
  const input = f.plan('exact-event', [{ sourceId: 'incoming', kind: 'event_records' }]).inputs[0]!;
  f.history(productOf(input, 'event_records'), 'peer');
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /block_peer_profile_unavailable/u });
  f.adopt(profile('peer', exact));
  await f.workspace.prepareWithRestriction(input);
  const attempt = f.handoff.attempt(input.requestId);
  assert.equal(JSON.parse(String(attempt.document_json)).duplicate_policy, undefined);
  receiptFromRefs(attempt.local_refs_json, { policy: 'cross_source_required', exemptionCode: null, decision: 'allow_reuse_product' });
});

test('workspace rejects an untrusted request-only profile without a store or frozen evidence', async t => {
  const f = workspaceFixture(t, false);
  const input = f.plan('untrusted-profile', [{ sourceId: 'incoming' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction({ ...input, sourceFieldProfile: profile('incoming') }),
    { code: 'R1_G5_PROFILE_CHANGED' });
  assert.throws(() => f.handoff.attempt(input.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
});

test('workspace rejects unknown frozen relation periods for explicit_range profiles', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('incoming', relationScope('synthetic-taxonomy/v1')));
  const input = f.plan('unknown-relation-period', [{ sourceId: 'incoming', kind: 'relation_edges', unknownEffectivePeriod: true }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction(input),
    { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /explicit_range/u });
  assert.throws(() => f.handoff.attempt(input.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
});

test('workspace binds request profiles to adopted or frozen evidence', async t => {
  const f = workspaceFixture(t);
  const adopted = profile('incoming');
  const frozen = profile('incoming', undefined, 'Asia/Shanghai');
  f.adopt(adopted);
  const input = f.plan('explicit-profile', [{ sourceId: 'incoming' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction({ ...input, sourceFieldProfile: frozen }), { code: 'R1_G5_PROFILE_CHANGED' });
  const unknown = f.plan('no-adopted-profile', [{ sourceId: 'unadopted' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction({ ...unknown, sourceFieldProfile: profile('unadopted') }),
    { code: 'R1_G5_PROFILE_CHANGED' });
  await f.workspace.prepareWithRestriction({ ...input, sourceFieldProfile: adopted });
  assert.equal(receiptFromRefs(f.handoff.attempt(input.requestId).local_refs_json, {}).sourceProfile?.profileDigest, sourceFieldProfileDigest(adopted));

  const frozenInput = f.plan('frozen-profile', [{ sourceId: 'incoming' }]).inputs[0]!;
  f.declaration(frozenInput).sourceFieldProfile = { profile: frozen, digest: sourceFieldProfileDigest(frozen), fingerprint: profileFingerprint(frozen) };
  await assert.rejects(f.workspace.prepareWithRestriction({ ...frozenInput, sourceFieldProfile: adopted }), { code: 'R1_G5_PROFILE_CHANGED' });
  await f.workspace.prepareWithRestriction({ ...frozenInput, sourceFieldProfile: frozen });
  assert.equal(receiptFromRefs(f.handoff.attempt(frozenInput.requestId).local_refs_json, {}).sourceProfile?.profileDigest, sourceFieldProfileDigest(frozen));
});

test('workspace checks frozen event nature and requires complete relation semantics', async t => {
  const f = workspaceFixture(t);
  const event = f.plan('event-nature', [{ kind: 'event_records', sourceId: 'incoming' }]).inputs[0]!;
  f.adopt(profile('incoming', { ...eventScope, eventSemantics: { ...eventScope.eventSemantics!, contentNature: 'forecast' } }));
  await assert.rejects(f.workspace.prepareWithRestriction(event), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /contentNature/u });
  const relation = f.plan('relation-profile', [{ kind: 'relation_edges', sourceId: 'incoming' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction(relation), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /relation_claim/u });
  f.adopt(profile('incoming', { domain: 'relation_claim', effectivePeriodPolicy: 'unknown' }));
  await assert.rejects(f.workspace.prepareWithRestriction(relation),
    { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /taxonomyAuthority.*effectivePeriodPolicy/u });
});

test('workspace resolves each fixed predecessor and keeps other historical sources', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('incoming', relationScope('synthetic-taxonomy/v1')));
  f.adopt(profile('peer', relationScope('different-taxonomy/v1')));
  const input = f.plan('verify-predecessor', [{ kind: 'relation_edges', sourceId: 'incoming' }]).inputs[0]!;
  const productId = productOf(input, 'relation_edges'), recordId = 'verify-predecessor-output';
  const definitionRef = { kind: 'definition', namespace, id: 'synthetic-definition', digest: definitionDigest };
  const previous = { product_id: productId, snapshot_id: snapshotId, logical_key: recordId, revision_id: 'revision-1' };
  Object.assign(input.target, { inputMode: 'source_correction', definitionMode: 'reuse', definitionRef,
    revisions: { [recordId]: { previous, reason: 'Synthetic supplier revision' } } });
  const parsed = JSON.parse(f.outputArtifact(input.planId, input.outputId).bytes.toString());
  const row = checkR1MappedRows(parsed.rows, f.declaration(input)).rows[0];
  Object.assign(f.machine, { fixedRead: async () => ({ result: { snapshot_id: snapshotId,
    products: [{ product_id: productId, dataset_id: datasetId, logical_domain: 'foundation', payload_kind: 'relation_edges',
      definition_ref: definitionRef, subject, declaration: input.target.definition }],
    rows: [{ product_id: productId, record_id: recordId, record_version: 'revision-1', row, record_ref: previous }],
  } }) });
  f.history(productId, 'incoming');
  f.history(productId, 'peer');
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /revision-1/u });
  f.history(productId, 'unknown', recordId);
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /revision-1/u });
  f.database.connection.prepare('DELETE FROM r1_record_associations WHERE record_id=?').run(recordId);
  f.history(productId, 'incoming', recordId);
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT' });
  f.adopt(profile('peer', relationScope('synthetic-taxonomy/v1')));
  await f.workspace.prepareWithRestriction(input);
  receiptFromRefs(f.handoff.attempt(input.requestId).local_refs_json, { peerSourceIds: ['incoming', 'peer'],
    decision: 'allow_reuse_product', exemptionCode: null });
});

test('workspace relation sources require compatible taxonomy authorities for cross-source reuse', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('first', relationScope('synthetic-taxonomy/v1')));
  f.adopt(profile('second', relationScope('different-taxonomy/v1')));
  const first = f.plan('relation-first', [{ kind: 'relation_edges', sourceId: 'first' }]).inputs[0]!;
  const productId = productOf(first, 'relation_edges');
  await f.workspace.prepareWithRestriction(first);
  receiptFromRefs(f.handoff.attempt(first.requestId).local_refs_json, { entryPoint: 'r1_workspace_relation',
    targetProductId: productId, policy: 'domain_profile_only_no_cross_merge', decision: 'allow_domain_profile_only' });

  f.history(productId, 'first');
  const second = f.plan('relation-second', [{ kind: 'relation_edges', sourceId: 'second' }]).inputs[0]!;
  await assert.rejects(f.workspace.prepareWithRestriction(second), { code: 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT',
    message: /block_semantic_conflict/u });
  assert.throws(() => f.handoff.attempt(second.requestId), { code: 'R1_ATTEMPT_NOT_FOUND' });
});

test('workspace publication set rejects both members atomically when the second conflicts', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('incoming'));
  f.adopt(profile('peer', undefined, 'Asia/Shanghai'));
  const { planId, inputs } = f.plan('set', [{ sourceId: 'incoming', outputId: 'clean' }, { sourceId: 'incoming', outputId: 'conflict' }]);
  const productId = productOf(inputs[1]!);
  f.history(productId, 'peer');
  const input = { kind: 'publication_set', requestId: 'set', planId, setId: 'group' };
  const originals = () => f.database.connection.prepare('SELECT COUNT(*) AS count FROM r1_originals').get()?.count;

  const before = originals();
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT',
    message: new RegExp('block_semantic_conflict；' + productId) });
  assert.equal(originals(), before);
  assert.deepEqual(f.workspace.list(), []);
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM r1_handoff_attempts').get()?.count, 0);

  f.adopt(profile('peer'));
  const accepted = await f.workspace.prepareWithRestriction(input);
  assert.equal(accepted.publicationSet?.members.length, 2);
  const { outputs } = JSON.parse(String(f.handoff.attempt(input.requestId).local_refs_json)) as R1LocalReferences;
  receiptFromRefs(canonicalWfdJson(outputs!.clean!), { entryPoint: 'r1_publication_set_member', decision: 'allow_first_source_for_target' });
  receiptFromRefs(canonicalWfdJson(outputs!.conflict!), { entryPoint: 'r1_publication_set_member', decision: 'allow_reuse_product' });
});

test('workspace checks sources sharing a new set product and rejects altered receipts before send', async t => {
  const f = workspaceFixture(t);
  f.adopt(profile('first'));
  f.adopt(profile('second', undefined, 'Asia/Shanghai'));
  const semanticCode = 'synthetic.shared';
  const { planId, inputs } = f.plan('same-product-set', [
    { sourceId: 'first', outputId: 'left', semanticCode }, { sourceId: 'second', outputId: 'right', semanticCode },
  ]);
  const requestId = 'same-product-set';
  const input = { kind: 'publication_set', requestId, planId, setId: 'group' };
  const productId = productOf(inputs[0]!);
  await assert.rejects(f.workspace.prepareWithRestriction(input), { code: 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT' });
  const db = f.database.connection;
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM r1_g5_admission_receipts').get()?.count, 0);
  assert.deepEqual(f.workspace.list(), []);
  f.adopt(profile('second'));
  await f.workspace.prepareWithRestriction(input);
  const attempt = f.handoff.attempt(requestId);
  const refs = JSON.parse(String(attempt.local_refs_json)) as R1LocalReferences;
  const left = receiptFromRefs(canonicalWfdJson(refs.outputs!.left), { decision: 'allow_reuse_product', peerSourceIds: ['second'] });
  const right = receiptFromRefs(canonicalWfdJson(refs.outputs!.right), { decision: 'allow_reuse_product', peerSourceIds: ['first'] });
  assert.deepEqual(right.binding, { requestId, entryPoint: 'r1_publication_set_member',
    target: { datasetId, productId, outputKey: 'right' }, candidateSource: { sourceId: 'second' } });
  const evidence = refs.outputs!.right!.evidenceRefs.find(item => item.kind === G5_ADMISSION_RECEIPT_VERSION)!;
  const { receiptDigest: _, ...body } = right;
  const forged = { ...body, evaluatedAtUtc: start };
  const rehashed = { ...forged, receiptDigest: wfdSha256(canonicalWfdJson(forged)) };
  assert.ok(verifyG5AdmissionReceiptDigest(rehashed, right.binding));
  for (const receipt of [left, rehashed]) {
    Object.assign(evidence, { g5AdmissionReceipt: receipt, ref_id: 'g5:' + receipt.receiptDigest, content_sha256: receipt.receiptDigest });
    const tampered = canonicalWfdJson(refs);
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?, local_refs_sha256=? WHERE request_id=?')
      .run(tampered, wfdSha256(tampered), requestId);
    assert.throws(() => f.handoff.assertPublicationReadyToSend(requestId), { code: 'R1_G5_EVIDENCE_MISMATCH' });
  }
});

test('workspace without a profile store or explicit profile preserves legacy preparation', async t => {
  const f = workspaceFixture(t, false);
  const input = f.plan('legacy', [{ sourceId: 'legacy-source' }]).inputs[0]!;
  assert.equal((await f.workspace.prepareWithRestriction(input)).state, 'prepared_profile_pending');
  const refs = JSON.parse(String(f.handoff.attempt(input.requestId).local_refs_json)) as R1LocalReferences;
  assert.deepEqual(refs.evidenceRefs.map(ref => ref.kind), ['processing-output']);
});

test('auto freezes verified cross-source admission and blocks an unprofiled historical source', async t => {
  const f = isolated(t);
  const handoff = new R1HandoffService({ database: f.database });
  const incomingProfile = profile('incoming');
  f.adopt(incomingProfile);
  const peer = profile('peer');
  f.adopt(peer);
  const bytes = Buffer.from([
    'business_key,start_utc,end_utc,value_state,reading,bd.semantic_code,bd.subject_kind,bd.subject_id,bd.frequency,bd.precision,bd.timezone,bd.period_type,bd.type.reading,bd.unit.reading,bd.measurement.reading',
    'row,' + start + ',' + end + ',valid_value,12.30,synthetic.auto,physical_object,synthetic-object,day,day,UTC,natural,decimal,count,stock',
    '',
  ].join('\n'));
  const sha256 = wfdSha256(bytes), incoming = source('incoming');
  const material = { envelope: { materialId: 'synthetic-material', sha256 }, preview: { format: 'csv' } };
  const { proposal } = resolveR1Evidence({ material: material as never, original: bytes, answers: {}, namespace,
    datasetId, parentSnapshotId: snapshotId, source: incoming, sourceFieldProfile: {
      profile: incomingProfile, digest: sourceFieldProfileDigest(incomingProfile), fingerprint: profileFingerprint(incomingProfile),
    } });
  assert.ok(proposal);
  const productId = 'synthetic-auto-product';
  seedHistory(f.database, handoff, productId, 'peer');
  const product = { product_id: productId, definition_ref: { digest: definitionDigest }, dataset_id: datasetId,
    subject: proposal.target.subject, payload_kind: 'tabular_rows', logical_domain: 'observations',
    declaration: proposal.target.definition, published_record_count: 1 };
  const identities: [string, string][] = [['history-peer', 'revision-1']];
  const unit = { dimension: 'quantity' };
  let processingCalls = 0;
  const auto = new R1AutoService({ database: f.database, fieldProfiles: f.profiles,
    tasks: () => ({ getControl: f.control }) as TaskService,
    materials: { get: () => material, readOriginal: () => ({ bytes, sha256 }) } as unknown as MaterialService,
    processing: { preparePlan: () => { processingCalls++; throw new Error('Synthetic processing boundary'); } } as unknown as ProcessingPlanService,
    workspace: { capabilities: () => ({ connection: f.identity }),
      snapshotStatus: async () => ({ snapshotId, units: { count: { definition: unit, digest: 'sha256:' + wfdSha256(canonicalWfdJson(unit)) } } }),
      discoverProducts: async () => ({ products: [product] }),
      discoverG5History: (id: string, targets: readonly R1G5HistoryTarget[]) => readR1G5SnapshotHistory(id, targets,
        async () => ({ snapshotId, products: [product] }), async () => fixedHistory(product, identities)),
      reviewDefinition: async () => ({ code: 'DEFINITION_COMPATIBLE', productIds: [productId], missingFields: [] }),
    } as unknown as R1WorkspaceService });
  try {
    const run = async (requestId: string) => {
      auto.start({ requestId, materialId: material.envelope.materialId, source: incoming, datasetId }, operator(requestId));
      const view = await auto.advance(requestId);
      const row = f.database.connection.prepare('SELECT record_json FROM r1_auto_requests WHERE request_id=?').get(requestId);
      const frozen = JSON.parse(String(row?.record_json)) as { g5AdmissionReceipt?: G5AdmissionReceipt };
      return { view, receipt: frozen.g5AdmissionReceipt };
    };
    const equivalent = await run('auto-equivalent');
    assert.equal(processingCalls, 1, JSON.stringify(equivalent.view.error));
    const allowed = assertReceipt(equivalent.receipt, { entryPoint: 'r1_auto', decision: 'allow_reuse_product', targetProductId: productId });
    assert.equal(allowed.peerComparisons[0]?.profileDigest, sourceFieldProfileDigest(peer));

    seedHistory(f.database, handoff, productId, 'unprofiled');
    product.published_record_count = 2;
    identities.push(['history-unprofiled', 'revision-1']);
    const blocked = await run('auto-unprofiled');
    assert.equal(blocked.view.state, 'blocked');
    assert.equal(blocked.view.error?.code, 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED');
    assertReceipt(blocked.receipt, { entryPoint: 'r1_auto', decision: 'block_peer_profile_unavailable',
      targetProductId: productId, missingPeerSourceIds: ['unprofiled'] });
    assert.equal(processingCalls, 1);
  } finally { await auto.dispose(); }
});

test('bulk freezes admission before staging and rechecks missing peer evidence after intake', async t => {
  const f = isolated(t);
  const handoff = new R1HandoffService({ database: f.database });
  const taxonomy = relationScope('synthetic-taxonomy/v1');
  const peer = profile('peer', taxonomy);
  f.adopt(peer);
  f.adopt(profile('incoming', taxonomy));
  const config = join(f.root, 'config');
  const tabularDirectory = join(config, 'tabular');
  mkdirSync(tabularDirectory, { recursive: true });
  const stat = statSync(f.archive, { bigint: true });
  writeFileSync(join(f.root, '.xuan-runtime.json'), JSON.stringify({ application: 'xuan-bd', version: 1, identity: 'synthetic' }));
  writeFileSync(join(config, 'machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'synthetic',
    resources: { bulk_csv: { path: f.archive, kind: 'directory', owned: true, identity: 'synthetic:bulk',
      device: String(stat.dev), inode: String(stat.ino) } } }));
  const contract: Omit<TabularTableContract, 'digest'> = { version: TABULAR_CONTRACT_VERSION, fields: ['object_id'],
    key_fields: ['object_id'], partition_field: null, time: { kind: 'unknown' } };
  const targetTemplate = { outputKey: 'synthetic.bulk', subject: { kind: 'entity', id: 'synthetic-bulk' },
    inputMode: 'partial_observation', coverage: { ...coverage, scope: { subject_id: 'synthetic-bulk' } },
    definition: { semantic_code: 'synthetic.bulk', measurement_nature: 'mixed_observation', time_role: 'observation', unit_code: 'per_field',
      field_definitions: [{ field_code: 'object_id', data_type: 'text', unit_code: 'not_applicable',
        measurement_nature: 'mixed_observation', time_role: 'observation' }],
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
        identity: { subject_kind: 'entity', identity_resolution_rule: tabularIdentityRule(contract) } } } };
  writeFileSync(join(tabularDirectory, 'synthetic.json'), JSON.stringify({
    version: 'bd.tabular-bulk-profile/1', profileId: 'synthetic-bulk', sourceId: 'incoming', series,
    confirmation: { basis: 'Synthetic input columns and identity', confirmedBy: 'synthetic-review', confirmedAtUtc: start },
    columns: [{ fieldCode: 'object_id', originalHeader: 'key' }],
    tableContract: { ...contract, digest: tabularDigest(contract) }, targetTemplate,
  }));
  const productId = r1G5ProductId(datasetId, 'tabular', { ...targetTemplate.subject, namespace },
    { ...targetTemplate.definition, definition_authority: namespace });
  seedHistory(f.database, handoff, productId, 'peer');

  const resources = new ResourceBindings(f.root), runtimes = new TaskRuntimeRegistry();
  const commitBudgetPolicy = { runtimeId: R1_WORKSPACE_RUNTIME, action: R1_SOURCE_MINUTE_ACTIONS[1],
    maxNoProgressMs: R1_SOURCE_MINUTE_COMMIT_NO_PROGRESS_MS };
  const permissions = new PermissionService({ database: f.database, isRunActive: (id, generation) => tasks.isRunActive(id, generation) });
  const tasks = new TaskService({ database: f.database, runtimes, permissions, initialBudgetPolicy: commitBudgetPolicy });
  const files = new FileReferenceService({ database: f.database, permissions, resources });
  const materials = new MaterialService({ database: f.database, tasks: () => tasks, files, resources, environment: 'synthetic-test' });
  const store = new ManagedOriginalStore({ database: f.database, materials, bindings: resources, ownedRoot: 'bulk_csv' });
  runtimes.register(materials.runtime);
  const processing = { moduleCapability: () => ({ status: 'ready' }) } as unknown as ProcessingPlanService;
  const frozenRecord = (id: string) => {
    const row = f.database.connection.prepare('SELECT record_json FROM r1_source_minute_bulk WHERE intake_id=?').get(id);
    assert.ok(row, id);
    return JSON.parse(String(row.record_json)) as { g5AdmissionReceipt?: G5AdmissionReceipt };
  };
  const staged: string[] = [];
  const client = {
    batchStatus: async (id: string) => ({ result: { phase: 'not_found', status: 'not_found', batch_id: id } }),
    tabularBatchBegin: async (id: string, _header: unknown, chunks: TabularBatchChunk[]) => {
      assertReceipt(frozenRecord(id).g5AdmissionReceipt, { decision: 'allow_reuse_product', targetProductId: productId });
      staged.push(id);
      return { result: { protocol_version: TABULAR_BATCH_PROTOCOL, batch_id: id, phase: 'ready',
        expected_chunks: chunks.length, received_chunks: chunks.length, chunk_offset: 0, next_chunk_offset: null,
        chunks: chunks.map(chunk => ({ ...chunk, received: true })) } };
    },
  };
  const runtime = { ...f.runtime, connection: { ...f.runtime.connection, client } } as unknown as R1Runtime;
  const workspace = new R1WorkspaceService({ database: f.database, tasks: () => tasks, handoff, processing, materials, runtime,
    configuration: { state: 'ready', reason: null } });
  const bulk = new R1SourceMinuteBulkService({ database: f.database, tasks: () => tasks, materials, store, resources, profileStore: f.profiles,
    runtime, processing, workspace, commitBudgetPolicy, transport: {
      buildHeader: buildSourceMinuteBatchHeader,
      verifyReceipt: () => assert.fail('Unexpected source-minute finalization'),
      verifyReadback: async () => assert.fail('Unexpected source-minute readback'),
    }, tabular: { profiles: new TabularBulkProfileStore(tabularDirectory),
      transport: { buildHeader: buildTabularBatchHeader, verifyReceipt: verifyTabularBatchReceipt, verifyReadback: verifyTabularBatchReadback } } });
  workspace.setSourceMinuteBulkHandler(bulk);
  runtimes.register(workspace.runtime);

  const bytes = Buffer.from('key\nsynthetic-object\n');
  const sha256 = wfdSha256(bytes);
  const input = (intakeId: string) => ({ mode: R1_TABULAR_BULK_MODE, intakeId, datasetId,
    name: 'synthetic.csv', sha256, byteLength: bytes.length, source: source('incoming'), partitionValue: 'synthetic-partition' });
  const stage = async (id: string) => {
    const view = await bulk.advance(id);
    assert.ok(view.bulk.stageTaskId);
    return tasks.wait(view.bulk.stageTaskId);
  };
  try {
    await bulk.start(input('bulk-equivalent'), operator('bulk-equivalent'));
    bulk.upload('bulk-equivalent', 0, bytes, sha256);
    const allowed = await stage('bulk-equivalent');
    assert.equal(allowed.status, 'succeeded', JSON.stringify(allowed.error));
    assert.equal(bulk.get('bulk-equivalent').bulk.phase, 'ready_to_commit');
    const receipt = assertReceipt(frozenRecord('bulk-equivalent').g5AdmissionReceipt,
      { entryPoint: 'r1_minute_bulk', decision: 'allow_reuse_product', targetProductId: productId });
    assert.equal(receipt.peerComparisons[0]?.profileDigest, sourceFieldProfileDigest(peer));

    await bulk.start(input('bulk-unprofiled'), operator('bulk-unprofiled'));
    bulk.upload('bulk-unprofiled', 0, bytes, sha256);
    f.database.connection.prepare("UPDATE r1_source_minute_bulk SET record_json=json_remove(record_json,'$.g5AdmissionPending','$.g5AdmissionReceipt') WHERE intake_id=?")
      .run('bulk-unprofiled');
    seedHistory(f.database, handoff, productId, 'unprofiled');
    const blocked = await stage('bulk-unprofiled');
    assert.equal(blocked.status, 'failed', JSON.stringify(blocked.error));
    assert.equal(blocked.error?.code, 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED');
    assertReceipt(frozenRecord('bulk-unprofiled').g5AdmissionReceipt, { entryPoint: 'r1_minute_bulk',
      decision: 'block_peer_profile_unavailable', targetProductId: productId, missingPeerSourceIds: ['unprofiled'] });
    assert.deepEqual(staged, ['bulk-equivalent']);

    await assert.rejects(bulk.start(input('bulk-blocked-intake'), operator('bulk-blocked-intake')),
      { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /block_peer_profile_unavailable/u });
    assert.equal(bulk.has('bulk-blocked-intake'), false);
  } finally { await tasks.dispose(); }
});

test('derived publisher persists a verified fixed-WFD-snapshot exemption', async t => {
  const f = isolated(t);
  const inputDate = '2026-11-01';
  const availableAt = inputDate + 'T23:59:59Z';
  const computedAt = '2026-11-10T09:00:00Z';
  const input: AlgorithmData = { metadata: { series_id: 'synthetic-series', subject: 'synthetic-stock', frequency: '1d',
    timezone: 'UTC', price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustment_basis: 'original',
    window_start: inputDate, window_end: inputDate, as_of: computedAt, availability_basis: 'explicit_per_bar',
    bar_closed: true, observations_are_consecutive: true, calendar_verification: 'dense', synthetic: true },
  rows: [{ timestamp: inputDate, close: 12.50, available_at: availableAt, bar_closed: true }] };
  const taskId = 'synthetic-derivation';
  const result = { status: 'computed', taskId, methodId: 'macd', methodVersion: ALGORITHM_METHODS.macd.version,
    implementationVersion: 'sha256:' + '1'.repeat(64), inputDigest: 'sha256:' + '2'.repeat(64), environment: 'synthetic-test',
    parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' }, computedAt,
    metadata: input.metadata, coverage: { suppliedRows: 1 }, eligibility: { input: { status: 'eligible' } },
    rows: [{ timestamp: inputDate, available_at: availableAt, DIFF: 0, DEA: 0, MACD: 0, ZERO: 0 }],
    source: { kind: 'wfd_fixed_snapshot', instanceId: f.identity.connectionId, connectionIdentityDigest: digestOperationArgs(f.identity),
      productId: 'synthetic-input-product', snapshotId, definitionRevision: 'synthetic-definition', fieldMapping: { close: 'close' },
      resolution: { instanceId: f.identity.connectionId, productId: 'synthetic-input-product', snapshotId, rowCount: 1,
        fields: { definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' }] },
        envelope: { rows: [{ business_key: 'synthetic-row', subject: { kind: 'instrument', namespace, id: 'synthetic-stock' },
          observation_time: { status: 'known', precision: 'day', earliest_utc: inputDate + 'T00:00:00Z',
            latest_exclusive_utc: '2026-11-02T00:00:00Z', source_timezone: 'UTC' } }] } } },
  } as unknown as AlgorithmComputedResult;
  const handoff = new R1HandoffService({ database: f.database, verifyFixedDerived: (refs, digest) => publisher.verify(refs, digest) });
  const sent: WfdRecord[] = [];
  const runtime = { ...f.runtime, client: { ...f.runtime.client, submit: async (document: WfdRecord) => {
    sent.push(document);
    throw Object.assign(new Error('Synthetic transport stopped before writing'), { code: 'SYNTHETIC_NOT_SENT' });
  } } } as unknown as R1Runtime;
  const publisher = new DerivedWfdPublisher({ runtime: () => runtime,
    workspace: () => ({ snapshotStatus: async () => ({ snapshotId }) }) as R1WorkspaceService,
    handoff, viewAlgorithm: () => ({ status: 'succeeded', requiresReview: false, result }) as AlgorithmTaskView,
    readAlgorithmInput: () => input });
  const publication = await publisher.publish(taskId);
  assert.equal(publication.state, 'send_failed');
  assert.equal(sent.length, 1);
  const attempt = handoff.attempt(publication.requestId);
  assert.deepEqual(JSON.parse(String(attempt.document_json)), sent[0]);
  const output = (sent[0]!.outputs as WfdRecord[])[0]!;
  const identity = sent[0]!.request_identity as WfdRecord;
  receiptFromRefs(attempt.local_refs_json, { entryPoint: 'derived_wfd_publisher', decision: 'allow_exempt_entry',
    policy: 'explicitly_exempt', targetProductId: r1G5ProductId(String(identity.dataset_id), 'tabular',
      output.subject as WfdRecord, output.definition as WfdRecord),
    exemptionCode: 'deterministic_derived_from_fixed_wfd_snapshot' });
});

function correctionFixture(t: TestContext) {
  const f = isolated(t);
  const database = f.database.connection;
  const handoff = new R1HandoffService({ database: f.database });
  const originalRequestId = 'synthetic-published';
  const productId = 'synthetic-correction-product';
  const originalSource = source('original-source');
  const original = Buffer.from('synthetic original supplier bytes');
  const replacement = Buffer.from('synthetic revised supplier bytes');
  const sha256 = wfdSha256(original), replacementSha256 = wfdSha256(replacement);
  const originalRef = { ...originalSource, sha256, bytes: original.length };
  const { originalId } = handoff.registerOriginal({ bytes: original, originalName: 'published.csv', source: originalRef });
  const local = canonicalWfdJson({ originalIds: [originalId], materialIds: [], sourceRefs: [originalRef] });
  const document = canonicalWfdJson({ request_identity: { dataset_id: datasetId, trusted_actor_namespace: namespace, request_id: originalRequestId },
    outputs: [{ output_key: 'synthetic.observation', subject, definition: { semantic_code: 'synthetic.observation' },
      definition_ref: { kind: 'definition', namespace, id: 'synthetic-definition', digest: definitionDigest }, coverage,
      payload: { kind: 'scalar_rows', rows: [{ business_key: 'published-row', value_decimal: '1.00', value_state: 'valid_value' }] } }] });
  // Seed the original published request and downstream impact so the test starts at repair preparation.
  database.prepare('INSERT INTO r1_handoff_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(originalRequestId, datasetId, namespace, document, wfdSha256(document), local, wfdSha256(local), 'associated',
      null, 0, null, Date.parse(end), Date.parse(end));
  database.prepare('INSERT INTO r1_record_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(datasetId, productId, definitionDigest, snapshotId, 'published-row', 'revision-1',
      originalRequestId, originalId, originalRef.source_id, '[]', '[]', Date.parse(end));
  database.exec(`
    CREATE TABLE r1_workspace_requests (request_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
    CREATE TABLE processing_plan_steps (plan_id TEXT, output_id TEXT, kind TEXT, ordinal INTEGER, parameters_json TEXT);
  `);
  database.prepare('INSERT INTO r1_workspace_requests VALUES (?,?)').run(originalRequestId, 'original-plan');
  const outputId = 'synthetic-output';
  const artifact = Buffer.from(canonicalWfdJson({ rows: [{ business_key: 'published-row', value_decimal: '2.00' }] }));
  const processing = { get: () => ({ version: PROCESSING_PLAN_VERSION, quality: { revision: { affectedOutputIds: [] } }, outputs: [] }),
    outputArtifact: () => ({ bytes: artifact, ref: { sha256: wfdSha256(artifact) } }) } as unknown as ProcessingPlanService;
  const materials = { readOriginal: (id: string) => {
    assert.ok(id === 'same-material' || id === 'corrected-material');
    return id === 'same-material' ? { bytes: original, sha256 } : { bytes: replacement, sha256: replacementSha256 };
  } } as unknown as MaterialService;
  const corrections = new PostPublicationCorrectionService({ database: f.database, tasks: () => ({ getControl: f.control }) as TaskService,
    runtime: f.runtime, processing, materials, fieldProfiles: f.profiles,
    adapters: { resolve: () => assert.fail('Unexpected adapter lookup') } });

  function prepare(caseId: string, kind: CorrectionKind, revisionSourceId = 'revision-source', differentRepairBytes = false) {
    const context = operator(caseId);
    corrections.register({ caseId, kind, errorType: 'synthetic-value', discoveredAt: end, evidence: 'Synthetic correction evidence',
      binding: { planOutput: { planId: 'original-plan', outputId } },
      connectionSha256: 'sha256:' + wfdSha256(canonicalWfdJson(f.identity)) }, context);
    const impact = canonicalWfdJson({ items: [{ itemId: 'affected-row', kind: 'original', productId, snapshotId,
      businessKey: 'published-row', recordVersion: 'revision-1', definitionDigest, requestId: originalRequestId, gaps: [] }], gaps: [] });
    database.prepare("UPDATE correction_cases SET state='suspended', impact_json=?, impact_sha256=? WHERE case_id=?")
      .run(impact, wfdSha256(impact), caseId);
    const planId = caseId + '-plan';
    const sourceCorrection = kind === 'source_correction';
    const newBytes = sourceCorrection || differentRepairBytes;
    database.prepare('INSERT INTO processing_plan_steps VALUES (?,?,?,?,?)')
      .run(planId, outputId, 'parse', 0, canonicalWfdJson({ materialId: newBytes ? 'corrected-material' : 'same-material' }));
    const input = { planId, outputId, originalSha256: newBytes ? replacementSha256 : sha256,
      expectedParentSnapshotId: snapshotId, reason: 'Synthetic measured value corrected',
      ...(sourceCorrection ? { sourceRevision: { sourceId: revisionSourceId, provider: originalSource.provider,
        requestedUrl: originalSource.requested_url, requestedAtUtc: end, acquiredAtUtc: '2026-01-03T00:01:00Z',
        revisionBasis: 'Synthetic supplier revision', originalSha256: replacementSha256, previousOriginalSha256: sha256,
        usageScope: originalSource.usage_scope, authorization: originalSource.authorization } } : {}) };
    return () => corrections.prepareRepair(caseId, input, context);
  }
  const frozen = (caseId: string) => {
    const row = database.prepare('SELECT state,frozen_json,frozen_sha256 FROM correction_cases WHERE case_id=?').get(caseId);
    assert.ok(row);
    return row;
  };
  return { ...f, prepare, productId, frozen,
    history: (sourceId: string) => seedHistory(f.database, handoff, productId, sourceId) };
}

test('post-publication processing repair freezes a same-original exemption', t => {
  const f = correctionFixture(t);
  const prepared = f.prepare('same-original', 'processing_repair')();
  const row = f.frozen('same-original');
  assert.equal(prepared.view.state, 'prepared');
  assert.equal(wfdSha256(String(row.frozen_json)), prepared.frozenSha256);
  const { g5AdmissionReceipt } = JSON.parse(String(row.frozen_json)) as { g5AdmissionReceipt: G5AdmissionReceipt };
  assertReceipt(g5AdmissionReceipt, { entryPoint: 'post_publication_correction', correctionKind: 'processing_repair',
    sourceId: 'original-source', targetProductId: f.productId, decision: 'allow_exempt_entry',
    policy: 'explicitly_exempt', exemptionCode: 'same_original_processing_repair' });
  assert.deepEqual(g5AdmissionReceipt.binding.target, { datasetId, productId: f.productId, outputKey: 'synthetic.observation' });
});

test('post-publication processing repair rejects new bytes and an unknown exact predecessor', t => {
  const f = correctionFixture(t);
  assert.throws(f.prepare('different-bytes', 'processing_repair', undefined, true), { code: 'CORRECTION_ORIGINAL_LINK' });
  f.history('unrelated-source');
  f.database.connection.prepare("UPDATE r1_record_associations SET source_id='unknown' WHERE record_id='published-row'").run();
  assert.throws(f.prepare('unknown-predecessor', 'processing_repair'), { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED' });
  assert.equal(f.frozen('unknown-predecessor').frozen_json, null);
});

test('same-source supplier revision still compares the product’s other historical source', t => {
  const f = correctionFixture(t);
  f.adopt(profile('original-source'));
  f.adopt(profile('peer', undefined, 'Asia/Shanghai'));
  f.history('peer');
  const prepare = f.prepare('same-source-revision', 'source_correction', 'original-source');
  assert.throws(prepare, { code: 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT' });
  assert.equal(f.frozen('same-source-revision').frozen_json, null);
  f.adopt(profile('peer'));
  prepare();
  const { g5AdmissionReceipt } = JSON.parse(String(f.frozen('same-source-revision').frozen_json));
  assertReceipt(g5AdmissionReceipt, { correctionKind: 'source_correction', sourceId: 'original-source',
    peerSourceIds: ['original-source', 'peer'], decision: 'allow_reuse_product', exemptionCode: null });
});

test('post-publication source correction enforces historical cross-source admission', t => {
  const f = correctionFixture(t);
  f.adopt(profile('revision-source'));
  const prepare = f.prepare('source-revision', 'source_correction');
  assert.throws(prepare, { code: 'G5_CROSS_SOURCE_EVIDENCE_REQUIRED', message: /block_peer_profile_unavailable/u });
  assert.equal(f.frozen('source-revision').state, 'suspended');
  assert.equal(f.frozen('source-revision').frozen_json, null);

  const peer = profile('original-source');
  f.adopt(peer);
  const prepared = prepare();
  const row = f.frozen('source-revision');
  assert.equal(prepared.view.state, 'prepared');
  assert.equal(wfdSha256(String(row.frozen_json)), prepared.frozenSha256);
  const { g5AdmissionReceipt } = JSON.parse(String(row.frozen_json)) as { g5AdmissionReceipt: G5AdmissionReceipt };
  const receipt = assertReceipt(g5AdmissionReceipt, { entryPoint: 'post_publication_correction', correctionKind: 'source_correction',
    sourceId: 'revision-source', targetProductId: f.productId, policy: 'cross_source_required', decision: 'allow_reuse_product',
    exemptionCode: null, peerSourceIds: ['original-source'] });
  assert.equal(receipt.peerComparisons[0]?.profileDigest, sourceFieldProfileDigest(peer));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BackendInput } from '../../contracts/backend.js';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { assertInternalAgentRules } from '../../modules/agent/instructions/rules.js';
import { acceptWorkspaceMaterial } from '../../modules/collection/accept-material.js';
import { PURE_OPERATOR_IDS } from '../../modules/financial/algorithm-types.js';
import { basis, calculation, discoveredPureReference, products, pureFixtureUnits, seedPureOperatorProducts } from '../../modules/financial/pure-operator-test-support.js';
import { zipOfficeParts } from '../../platform/capabilities/conversion/office-test-support.js';
import { readConnectionRegistry, registeredBaiduDriveConfiguration } from '../../platform/config/connections.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { changedImplementation, createFullChainFixture, readModelEvidencePreview, settleFixtureTask } from './full-chain-test-support.js';
import { invokeMediaAction, model, openMediaReviewCompanion, openMediaReviewHost, prepareTranscriptionParse, unusedPiContext } from './media-review-test-support.js';

type Host = Awaited<ReturnType<typeof openMediaReviewHost>>;
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
const preview = (result: Pick<ToolResult, 'content'>) => JSON.parse(result.content.map(part => part.type === 'text' ? part.text : '').join(''));

function toolsFor(host: Host, input: BackendInput) {
  const tools = host.services.modelTools.toolFactory({ model, getCurrentInput: () => input });
  const invoke = (name: string, id: string, args: Record<string, unknown>) => {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    return tool.execute(id, args, undefined, undefined, unusedPiContext);
  };
  const perform = (id: string, action: string, args: Record<string, unknown> = {}) => invoke('perform_action', id, { action, args });
  const history = (id: string, result: ToolResult) => preview(host.services.modelTools.projectToolResult({
    role: 'toolResult', toolCallId: id, toolName: 'perform_action', details: result.details as JsonValue, timestamp: Date.now(), isError: false,
    content: [{ type: 'text', text: 'untrusted-history-replacement' }],
  }, input, undefined, model));
  const evidence = tools.find(tool => tool.name === 'core_evidence_read');
  assert.ok(evidence);
  const readAll = (id: string, result: ToolResult) => readModelEvidencePreview(preview(result), evidence, id);
  return { invoke, perform, history, readAll };
}

async function startFrozenV21(host: Host) {
  const { core, backend, database } = host, conversation = core.createConversation().conversationId;
  const active = core.sendMessage(conversation, '隔离测试：准备历史队列。', 'v21-setup');
  const parent = await backend.waitForInput(active.commandId);
  const queued = core.sendMessage(conversation, '读取已有算法契约并核对合成数据。', 'v21-queued', { mode: 'queue' });
  // 重建升级前已持久化的排队输入；由真实队列恢复路径验签、建立新运行。
  const legacy = { ...core.runConfiguration(parent.runId)!, internalAgentRules: { id: 'xuan-bd-internal-agent', version: 21,
    digest: 'c6dc990bfd99628b50ef08a3bc37bb9869cbaf36c3cd34c88160f886e4c48cb7' },
    internalAgentRulesText: readFileSync(new URL('./fixtures/internal-agent-v21.md', import.meta.url), 'utf8') };
  assertInternalAgentRules(legacy);
  assert.equal(database.connection.prepare("UPDATE commands SET configuration_json=? WHERE id=? AND state='queued'")
    .run(JSON.stringify(legacy), queued.commandId).changes, 1);
  await core.abort(parent.runId, conversation); core.resumeQueue(conversation);
  const input = await backend.waitForInput(queued.commandId);
  assert.equal(core.runConfiguration(input.runId)?.internalAgentRules?.version, 21);
  return input;
}

async function indexDocument(host: Host, root: string) {
  const service = host.companion, segments = service.segments!;
  const paragraphs = Array.from({ length: 20 }, (_, i) =>
    '<w:p><w:r><w:t>受控检索 ' + i + ' ' + '合成段落'.repeat(110) + '</w:t></w:r></w:p>');
  const bytes = zipOfficeParts({
    '[Content_Types].xml': '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<w:document xmlns:w="urn:word"><w:body>' + paragraphs.join('') + '</w:body></w:document>',
  });
  const path = join(root, 'synthetic.docx'), conversationId = host.core.defaultConversationId;
  writeFileSync(path, bytes);
  const ref = host.services.files.register({ path, source: 'user-attached', conversationId });
  const sent = host.core.sendMessage(conversationId, '核对固定快照的财务派生、复权和附件的文档证据。', 'stage2-current',
    { attachmentRefs: [{ fileRefId: ref.id, version: ref.version, category: 'data' }] });
  const input = await host.backend.waitForInput(sent.commandId);
  const custody = await invokeMediaAction(host, input, 'material.read', { fileRefId: ref.id }, 'stage2-material-read');
  const material = service.materials!.get(String((custody.result!.data as any).materialId)).envelope;
  service.permissions.grant({ label: 'synthetic conversion artifacts', scope: { kind: 'persistent' },
    capabilities: (['read', 'write', 'delete'] as const).map(action => ({ action, target: { kind: 'directory', path: service.artifactRoot, recursive: true } })) });
  const action = 'conversion.document', args = { fileRefId: material.fileRefId };
  segments.updateSettings({ autoRegister: 'disabled' }, 'stage2-explicit-document-times');
  const task = service.tasks.create({ title: 'Index synthetic document', requestId: 'stage2-convert', ownerRole: 'service', runtimeId: 'direct',
    action, args, versions: service.direct.registry.captureVersions(action, args) });
  service.tasks.start(task.id);
  const converted = await settleFixtureTask(service.tasks, task.id);
  assert.equal(converted.status, 'succeeded');
  const artifact = (converted.result!.data as { structuredReference: { fileRefId: string } }).structuredReference;
  const registration = segments.requestArtifact({ materialId: material.materialId, artifactRef: artifact.fileRefId, conversionTaskId: task.id,
    disclosedAt: { state: 'known', value: '2026-01-01T00:00:00Z' }, eventTime: { state: 'not_applicable' } }, 'stage2-index');
  const indexed = await settleFixtureTask(service.tasks, registration.id);
  assert.equal(indexed.status, 'succeeded', JSON.stringify(indexed.error));
  return { input, materialId: material.materialId, indexVersion: (indexed.result!.data as { indexVersion: string }).indexVersion };
}

test('same host restores v21 and executes v22 calculations and all five fixed retrieval actions through the model gateway', {
  skip: !(process.env.WFD_PYTHON && process.env.XUAN_FULL_CHAIN_ROOT) && '需要隔离根与 WFD 解释器', timeout: 180_000,
}, async t => {
  const f = createFullChainFixture({ name: 'wave1-model', machine: true, units: pureFixtureUnits });
  const dataId = 'isolated-stage2';
  const controlDatabasePath = join(f.root, 'data-control.sqlite');
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath, dataIdFromTask: () => dataId });
  lifecycle.register(dataId);
  const h = await openMediaReviewHost(f, false, { lifecycle, dataId });
  t.after(async () => { await h.close(); await lifecycle.close(); });
  const { companion, core } = h;
  assert.ok(companion.r1Runtime); assert.equal(companion.algorithms, undefined); assert.equal(companion.derivedPublisher, undefined);
  assert.partialDeepStrictEqual(companion.segments!.capabilities(), { ocrReviewReaderWired: true,
    ocr: { reviewReaderWired: true, runnerAvailable: h.services.direct.localOcr.availability().available } });
  assert.deepEqual(companion.toolLibrary!.view().tools.filter(item => item.status === 'ready').map(item => item.id).sort(), [...PURE_OPERATOR_IDS].sort());
  const snapshotId = await seedPureOperatorProducts(companion.r1Runtime);
  const { indexVersion, materialId, input } = await indexDocument(h, f.root);
  const oldInput = await startFrozenV21(h), old = toolsFor(h, oldInput);
  const current = toolsFor(h, input);
  assert.equal(core.runConfiguration(input.runId)?.internalAgentRules?.version, 22);
  const list = (tool: typeof current, id: string, query: string) => tool.invoke('list_actions', id, { query, limit: 20 }).then(preview);
  assert.equal((await list(old, 'old-calc', 'algorithms.calculate')).actions[0].available, false);
  assert.equal((await list(current, 'new-calc', 'algorithms.calculate')).actions[0].available, true);
  assert.equal((await list(old, 'old-retrieval', 'data.retrieval.')).total, 0);
  const actions = await list(current, 'new-retrieval', 'data.retrieval.');
  assert.deepEqual(actions.actions.filter((a: any) => a.available && a.modelCalls === 0).map((a: any) => a.action).sort(),
    ['capabilities', 'documents', 'evidence', 'joint', 'search'].map(name => 'data.retrieval.' + name));
  const directory = await current.readAll('directory', await current.perform('directory', 'algorithms.capabilities', { snapshotId }));
  assert.equal(directory.data.snapshotDiscovery.snapshotId, snapshotId);
  let savedTask = '', savedResult: Record<string, unknown> = {};
  for (const id of PURE_OPERATOR_IDS) {
    const contract = await current.readAll('contract-' + id, await current.perform('contract-' + id, 'algorithms.contract', { methodId: id }));
    assert.equal(contract.data.methods[0].executable, true);
    const ref = (key: string) => discoveredPureReference(directory.data.snapshotDiscovery, snapshotId, key);
    const args = { calculationJson: JSON.stringify({ ...calculation(id), source: { kind: 'fixed_snapshot', reference: ref(products[id]),
      ...(id === 'price_adjustment' ? { actionReference: ref('actions') } : {}) } }) };
    const action = id === 'price_adjustment' ? 'data.modules.calculate' : 'algorithms.calculate';
    const call = await current.perform(id, action, args), result = await current.readAll(id, call);
    assert.equal(result.data.methodId, id); assert.equal(result.data.verification.status, 'verified');
    assert.deepEqual(result.data.publication, { state: 'not_requested', mode: 'explicit_r1_handoff_required' });
    assert.equal(current.history(id, call).taskId, result.taskId);
    assert.deepEqual(preview(await current.perform(id, action, args)), preview(call));
    assert.equal(old.history(id, call).ok, false);
    await assert.rejects(old.perform('denied-' + id, action, args));
    const rejected = h.services.tasks.list().find(task => task.conversationId === oldInput.conversationId && task.action === action);
    assert.equal(rejected?.error?.code, 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES');
    savedTask = result.data.taskId; savedResult = result.data;
  }

  const beforeRetrieval = h.services.tasks.getBudget(savedTask);
  const caps = preview(await current.perform('capabilities', 'data.retrieval.capabilities'));
  assert.ok(caps.data.indexVersions.items.some((item: any) => item.index_version === indexVersion));
  const documents = preview(await current.perform('documents', 'data.retrieval.documents'));
  assert.ok(documents.data.items.some((item: any) => item.document_id === materialId));
  const query = { indexVersion, query: '受控检索', method: 'exact', mode: 'system_held_at', asOf: new Date().toISOString(), limit: 20 };
  const search = await current.perform('search', 'data.retrieval.search', query);
  const first = preview(search);
  assert.equal(first.complete, false); assert.ok(first.evidence.nextCursor);
  const found = await current.readAll('search', search);
  assert.equal(found.data.citationCount, 20); assert.equal(found.data.citations[0].document_id, materialId);
  assert.equal(found.data.accessGeneration, undefined); assert.equal(found.data.kind, undefined);
  assert.deepEqual(current.history('search', search).evidence, first.evidence);
  const early = preview(await current.perform('before-acquisition', 'data.retrieval.search', { ...query, asOf: '2000-01-01' }));
  assert.equal(early.data.citationCount, 0); assert.equal(early.data.status, 'index_missing'); assert.ok(early.data.gaps.includes('index_built_after_as_of'));
  const evidence = preview(await current.perform('evidence', 'data.retrieval.evidence', { indexVersion, segmentId: found.data.citations[0].segment_id }));
  for (const key of ['cache', 'artifact', 'original']) assert.equal(evidence.data[key].status, 'verified');
  const subject = { kind: 'entity', namespace: 'full.chain.test', id: basis.subject };
  const ratios = discoveredPureReference(directory.data.snapshotDiscovery, snapshotId, 'ratios');
  const structured = { dataset_id: 'synthetic_pure_ratios', snapshot_id: snapshotId, history_mode: 'snapshot_contents',
    universe: { kind: 'explicit_subjects', subjects: [subject] }, metrics: [{ metric: 'revenue', field: 'l4_revenue', bindings: [{ subject, product_id: ratios.productId }] }],
    business_time_range: { role: 'observation', start: '2026-05-01', end: '2026-05-01', timezone: 'UTC' },
    predicate: { compare: { metric: 'revenue', op: '>=', value: { data_type: 'decimal', value: '0', unit_code: 'cny' } } },
    order_by: [{ kind: 'subject', direction: 'asc' }], page_size: 1 };
  const joint = preview(await current.perform('joint', 'data.retrieval.joint', { jointJson: JSON.stringify({ structured,
    documents: { indexVersion, query: query.query, method: 'exact', mode: null, asOf: null } }) }));
  assert.equal(joint.data.qualification.document_index_version, indexVersion);
  assert.equal(joint.data.structured.snapshot_id, snapshotId);
  assert.equal(joint.data.objects[0].gaps[0].code, 'BD_RECORD_ASSOCIATION_MISSING');
  const tasks = h.services.tasks.list().filter(task => task.conversationId === input.conversationId && task.action.startsWith('data.retrieval.'));
  assert.equal(tasks.length, 6); assert.ok(tasks.every(task => task.status === 'succeeded' && task.budgetScope === input.inputId));
  const budget = h.services.tasks.getBudget(tasks[0]!.id);
  assert.equal(budget.attempts - beforeRetrieval.attempts, tasks.length);
  assert.ok(budget.toolMs > beforeRetrieval.toolMs, 'Direct 运行时累计检索耗时到原目标预算');
  const workspace = companion.r1Workspace;
  companion.r1Workspace = undefined;
  try {
    for (const task of tasks) {
      if (task.action === 'data.retrieval.joint') assert.throws(() => h.services.direct.registry.assertTaskVersions(task), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
      else h.services.direct.registry.assertTaskVersions(task);
    }
    const status = await current.readAll('status', await current.perform('status', 'algorithms.status', { taskId: savedTask }));
    assert.deepEqual(status.data, savedResult);
  } finally { companion.r1Workspace = workspace; }

  // Exercise a nonconforming upstream last page too. Even if it ignores the cap, the retained evidence is complete.
  const fixed = companion.r1Workspace!;
  const large = t.mock.method(fixed, 'filterObjects', async (plan: any) => {
    assert.equal(plan.page_size, 20);
    return { status: 'matched', dataset_id: 'synthetic', snapshot_id: snapshotId, coverage: { data_complete: true },
      page: { total_objects: 25, next_cursor: null, has_more: false, result_exhausted: true },
      objects: Array.from({ length: 25 }, (_, i) => ({ subject: { ...subject, id: 'synthetic-' + i },
        values: { text: '完整证据'.repeat(550), hidden: '/private/synthetic-location' }, record_refs: {} })) };
  });
  try {
    const args = { jointJson: JSON.stringify({ structured: { ...structured, page_size: 25 },
      documents: { indexVersion, method: 'exact', query: '指标', asOf: null, mode: null } }) };
    const oversized = await current.perform('oversized-page', 'data.retrieval.joint', args);
    assert.equal(preview(oversized).complete, false); assert.ok(preview(oversized).evidence.nextCursor);
    const assembled = await current.readAll('oversized-page', oversized);
    assert.equal(assembled.data.objects.length, 25); assert.equal(assembled.data.objects[24].subject.id, 'synthetic-24');
    assert.equal(assembled.data.objects[24].values.text, '完整证据'.repeat(550));
    assert.ok(!JSON.stringify(assembled).includes('synthetic-location'));
    const stored = h.services.tasks.get(assembled.taskId).result!.data as any;
    assert.equal(stored.modelPreview.page.has_more, true); assert.equal(stored.modelPreview.page.result_exhausted, false);
    assert.deepEqual(stored.modelEvidence.objects, assembled.data.objects);
  } finally { large.mock.restore(); }

  // 已返回的内容、模型历史和证据续页均须重新核对原资料代次。
  const controlDb = new CoreDatabase(controlDatabasePath);
  try { controlDb.connection.prepare('UPDATE local_data_lifecycle SET generation=generation+1 WHERE data_id=?').run(dataId); }
  finally { controlDb.close(); }
  assert.equal(current.history('search', search).ok, false);
  await assert.rejects(current.perform('search', 'data.retrieval.search', query));
  await assert.rejects(current.invoke('core_evidence_read', 'revoked-page', { evidenceId: first.evidence.evidenceId,
    sha256: first.evidence.sha256, cursor: first.evidence.nextCursor }));

  // The same verified structured row may have local evidence from a private branch.
  const rowRead = companion.r1Workspace!.beginJointEvidenceRead.bind(companion.r1Workspace);
  t.mock.method(companion.r1Workspace!, 'beginJointEvidenceRead', (...args: Parameters<typeof rowRead>) => ({
    ...rowRead(...args), recordMaterials: () => ({ requestId: 'private-request', snapshotId,
      materialIds: [materialId], originalIds: ['private-original'] }) }));
  const jointArgs = { jointJson: JSON.stringify({ structured, documents: { indexVersion, query: query.query, method: 'exact', mode: null, asOf: null } }) };
  const ownJoint = await current.readAll('own-joint', await current.perform('own-joint', 'data.retrieval.joint', jointArgs));
  assert.equal(ownJoint.data.objects[0].documents.citations[0].document_id, materialId);
  await core.abort(input.runId, input.conversationId);
  const alternate = core.editMessage(input.conversationId, input.messageId, '读取本分支的材料。', 'without-private-attachment',
    core.getState(input.conversationId).treeRevision, undefined, []);
  const sibling = await h.backend.waitForInput(alternate.commandId), other = toolsFor(h, sibling);
  assert.notEqual(input.branchId, sibling.branchId);
  const docList = preview(await other.perform('other-docs', 'data.retrieval.documents')).data;
  assert.deepEqual(docList.items, []); assert.equal(docList.total, 0);
  const otherSearch = preview(await other.perform('other-search', 'data.retrieval.search', query)).data;
  assert.deepEqual(otherSearch.citations, []); assert.deepEqual(otherSearch.coverage.excluded, []);
  await assert.rejects(other.perform('other-proof', 'data.retrieval.evidence', { indexVersion, segmentId: found.data.citations[0].segment_id }));
  const otherJoint = preview(await other.perform('other-joint', 'data.retrieval.joint', jointArgs)).data;
  assert.equal(otherJoint.objects[0].documents, null); assert.deepEqual(otherJoint.objects[0].associations, []);
  for (const key of [materialId, found.data.citations[0].segment_id, '合成段落', 'private-original', 'private-request'])
    assert.ok(!JSON.stringify([docList, otherSearch, otherJoint]).includes(key));

});

test('evidence binding detects changes to OCR, Office and linkedom bytes independently of document listing', async t => {
  const f = createFullChainFixture({ name: 'evidence-versions', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const host = await openMediaReviewHost(f, false); t.after(() => host.close());
  const registry = host.services.direct.registry;
  const capture = (action: string) => ({ runtimeId: 'direct', action, args: {}, versions: registry.captureVersions(action, {}) } as TaskRecord);
  const evidence = capture('data.retrieval.evidence'), listing = capture('data.retrieval.documents');
  const verifyChanged = () => {
    assert.throws(() => registry.assertTaskVersions(evidence), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
    registry.assertTaskVersions(listing);
  };
  for (const path of ['apps/server/ocr-review.ts', 'apps/server/media-review-source.ts',
    'platform/capabilities/conversion/office.ts', 'platform/capabilities/conversion/formats.ts'])
    changedImplementation(path, verifyChanged);

  // Redirect only the bound package file's stat and descriptor to a changed private fixture.
  const entry = createRequire(import.meta.url).resolve('linkedom'), replacement = join(f.root, 'changed-package.js');
  writeFileSync(replacement, Buffer.concat([readFileSync(entry), Buffer.from('\n')]));
  const stat = fs.lstatSync, open = fs.openSync;
  const changedStat = t.mock.method(fs, 'lstatSync', (path: fs.PathLike, options: fs.StatOptions) =>
    stat(String(path) === entry ? replacement : path, options));
  const changedOpen = t.mock.method(fs, 'openSync', (path: fs.PathLike, ...args: [string | number, fs.Mode?]) =>
    open(String(path) === entry ? replacement : path, ...args));
  syncBuiltinESMExports();
  try { verifyChanged(); }
  finally { changedOpen.mock.restore(); changedStat.mock.restore(); syncBuiltinESMExports(); }
  registry.assertTaskVersions(evidence);
});

test('frozen Baidu fields, per-reference approval and branch-local redaction through real model tools', async t => {
  const f = createFullChainFixture({ name: 'wave1-baidu-model', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const binaryPath = join(f.root, 'offline-bdpan'), configPath = join(f.root, 'client.json'), refPath = join(f.root, 'fixture-refs');
  const bindingsFile = join(f.runtime, 'config/machine.bindings.json'), dispatched = join(f.root, 'dispatch-count');
  const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8'));
  writeFileSync(binaryPath, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args[args.indexOf('--source-dir') + 1] !== '/synthetic') process.exit(2);
fs.appendFileSync(${JSON.stringify(dispatched)}, '1');
console.log(JSON.stringify({ items: [] }));`, { mode: 0o700 });
  bindings.resources.bdpan = { kind: 'program', path: binaryPath, sha256: wfdSha256(readFileSync(binaryPath)) };
  writeFileSync(bindingsFile, JSON.stringify(bindings)); writeFileSync(configPath, '{}');
  const secret = randomUUID().slice(0, 8), ref = 'synthetic';
  writeFileSync(refPath, JSON.stringify({ refs: { FIXTURE_SHARE: secret } }), { mode: 0o600 });
  const host = await openMediaReviewHost(f, false, undefined, { binaryPath, configPath,
    sharePasscodeRefs: { [ref]: { kind: 'dsh-ref', path: refPath, ref: 'FIXTURE_SHARE' } } });
  t.after(() => host.close());
  const old = toolsFor(host, await startFrozenV21(host));
  const { core, services, database } = host, conversation = core.defaultConversationId;
  const sent = core.sendMessage(conversation, '核对合成网盘清单。', 'offline-baidu-query');
  const input = await host.backend.waitForInput(sent.commandId), current = toolsFor(host, input);
  const fields = async (tool: typeof current) => preview(await tool.invoke('list_actions', 'list-baidu', { query: 'baidu.drive' }))
    .actions[0].fields.map((field: any) => field.key);
  const legacy = await fields(old), latest = await fields(current);
  for (const key of ['passcodeRef', 'sourceDir']) {
    assert.ok(!legacy.includes(key)); assert.ok(latest.includes(key));
  }
  const share = { operation: 'transfer-list', shareUrl: 'https://pan.baidu.com/s/synthetic' };
  for (const [key, value] of [['sourceDir', '/synthetic'], ['passcodeRef', ref]]) {
    await assert.rejects(old.perform('old-deny-' + key, 'baidu.drive', { ...share, [key]: value }), { code: 'MODEL_ACTION_NOT_ALLOWED' });
  }
  assert.equal(preview(await old.perform('old-path', 'baidu.drive', { ...share, path: '/synthetic' })).data.complete, true);
  const privateList = current.perform('private-list', 'baidu.drive', { ...share, sourceDir: '/synthetic', passcodeRef: ref });
  const task = services.tasks.list().find(item => item.conversationId === conversation && item.action === 'baidu.drive');
  assert.ok(task);
  const waiting = await settleFixtureTask(services.tasks, task.id);
  assert.equal(waiting.status, 'waiting_approval'); assert.equal(readFileSync(dispatched, 'utf8'), '1');
  const approval = services.permissions.getRecordedApproval(waiting.approvalId!);
  assert.ok(approval.operation.targets.some(target => target.kind === 'secret' && target.name === 'baidu-drive.share-passcode.' + ref));
  services.tasks.approve(waiting.approvalId!);
  assert.equal(preview(await privateList).data.complete, true); assert.equal(readFileSync(dispatched, 'utf8'), '11');

  const invalid = [{ ...share, passcode: secret }, { ...share, shareUrl: share.shareUrl + '?pwd=' + secret },
    { ...share, shareUrl: share.shareUrl + '#code=' + secret }];
  for (const [i, args] of invalid.entries()) await assert.rejects(current.perform('bad-' + i, 'baidu.drive', args));
  const rejected = () => database.connection.prepare("SELECT * FROM model_tool_calls WHERE conversation_id=? AND state='rejected'").all(conversation);
  assert.equal(rejected().length, 3);
  assert.ok(!JSON.stringify(rejected()).includes(secret));
  // Exercise both read paths against a row and a cached list from before write-side redaction.
  database.connection.prepare("UPDATE model_tool_calls SET args_json=?,preview_json=? WHERE tool_call_id='bad-0'")
    .run(JSON.stringify({ args: { apiKey: secret, shareUrl: invalid[1].shareUrl } }), JSON.stringify({ message: secret }));
  const own = preview(await current.invoke('core_tasks_list', 'own-rejections', {}));
  assert.equal(own.rejectedCalls.length, 3); assert.ok(!JSON.stringify(own).includes(secret));
  database.connection.prepare("UPDATE model_tool_calls SET preview_json=? WHERE tool_call_id='own-rejections'")
    .run(JSON.stringify({ ...own, rejectedCalls: invalid }));
  assert.ok(!JSON.stringify(preview(await current.invoke('core_tasks_list', 'own-rejections', {}))).includes(secret));
  await core.abort(input.runId, conversation);
  core.createBranch(conversation, core.getState(conversation).treeRevision);
  const next = core.sendMessage(conversation, '核对本分支任务。', 'offline-other-branch');
  const other = toolsFor(host, await host.backend.waitForInput(next.commandId));
  const otherView = preview(await other.invoke('core_tasks_list', 'other-rejections', {}));
  assert.deepEqual(otherView.rejectedCalls, []); assert.ok(!JSON.stringify(otherView).includes(secret));
});

test('registered Baidu locators protect files and freeze only the selected credential dependency', async t => {
  const f = createFullChainFixture({ name: 'wave1-baidu', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const configPath = join(f.root, 'client-config'), path = join(f.root, 'refs.yaml'), binaryPath = join(f.root, 'bdpan');
  const security = join(f.root, 'security'), bindingsFile = join(f.runtime, 'config/machine.bindings.json');
  const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8'));
  for (const [name, program] of [['bdpan', binaryPath], ['security', security]]) {
    writeFileSync(program, 'fixture program identity only', { mode: 0o700 });
    bindings.resources[name] = { path: program, kind: 'program', sha256: wfdSha256(readFileSync(program)) };
  }
  writeFileSync(bindingsFile, JSON.stringify(bindings)); writeFileSync(configPath, '{}');
  const dsh = { kind: 'dsh-ref', path, ref: 'SYNTHETIC_SLOT' }, keychain = { kind: 'keychain', service: 'synthetic-client', account: 'synthetic-slot' };
  const base = { id: 'bdpan-native', kind: 'native-cli', executable: binaryPath, credential_ref: { kind: 'native-client-managed', config_path: configPath } };
  const read = (refs?: unknown) => {
    writeFileSync(f.registryPath, JSON.stringify({ connections: [{ ...base, share_passcode_refs: refs }] }));
    return registeredBaiduDriveConfiguration(readConnectionRegistry(f.registryPath), binaryPath);
  };
  assert.equal(read()?.sharePasscodeRefs, undefined);
  for (const invalid of [null, [], { slot: randomUUID() }, { 'bad/name': dsh }, { constructor: dsh }, { slot: { ...dsh, path: 'relative' } },
    { slot: { ...dsh, ref: '' } }, { slot: { ...keychain, account: '' } }, { slot: { ...keychain, extra: true } }]) {
    assert.throws(() => read(invalid));
  }
  const drive = read({ slot: dsh, system: keychain });
  assert.deepEqual(drive?.sharePasscodeRefs, { slot: dsh, system: keychain }, '登记时引用文件仍不存在');
  writeFileSync(path, 'refs: {}');
  const host = openMediaReviewCompanion(f, { baiduDrive: drive }); t.after(() => host.close());
  const { direct, files, tasks } = host.companion;
  assert.throws(() => direct.assertPublicPath(path), { code: 'PROTECTED_RESOURCE' });
  const file = files.register({ path, source: 'user-attached', conversationId: host.companion.core.defaultConversationId });
  const readArgs = { fileRefId: file.id };
  const ordinary = tasks.create({ runtimeId: 'direct', action: 'file.read', args: readArgs, title: 'Check protected reference',
    ownerRole: 'service', requestId: 'stage2-protected-read', versions: direct.registry.captureVersions('file.read', readArgs) });
  tasks.start(ordinary.id);
  assert.equal((await settleFixtureTask(tasks, ordinary.id)).error?.code, 'PROTECTED_RESOURCE');
  const freeze = (passcodeRef?: string) => {
    const args: Record<string, string> = passcodeRef ? { passcodeRef } : {};
    return { runtimeId: 'direct', action: 'baidu.drive', args, versions: direct.registry.captureVersions('baidu.drive', args) } as TaskRecord;
  };
  const fileTask = freeze('slot'), keyTask = freeze('system'), plain = freeze();
  writeFileSync(path, '# synthetic rotation\nrefs: {}');
  assert.throws(() => direct.registry.assertTaskVersions(fileTask), { code: 'DIRECT_VERSION_CONFLICT' });
  direct.registry.assertTaskVersions(keyTask); direct.registry.assertTaskVersions(plain);
  writeFileSync(security, 'changed synthetic executable identity');
  assert.throws(() => direct.registry.assertTaskVersions(keyTask), { code: 'DIRECT_VERSION_CONFLICT' });
  direct.registry.assertTaskVersions(plain);
});

test('ordinary file.read protects registered DSH files even without bdpan or native account files', async t => {
  const f = createFullChainFixture({ name: 'wave1-offline-registry', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const bindingsFile = join(f.runtime, 'config/machine.bindings.json');
  const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8'));
  bindings.resources.connections_registry = { path: f.registryPath, kind: 'file' };
  writeFileSync(bindingsFile, JSON.stringify(bindings));
  const path = join(f.root, 'offline-refs.yaml');
  writeFileSync(path, 'refs: {}');
  writeFileSync(f.registryPath, JSON.stringify({ connections: [{ id: 'bdpan-native', kind: 'native-cli',
    executable: join(f.root, 'missing-bdpan'), credential_ref: { kind: 'native-client-managed', config_path: join(f.root, 'missing-config') },
    share_passcode_refs: { slot: { kind: 'dsh-ref', path, ref: 'FIXTURE_SLOT' } } }] }));
  assert.equal(registeredBaiduDriveConfiguration(readConnectionRegistry(f.registryPath), join(f.root, 'missing-bdpan')), undefined);
  const host = openMediaReviewCompanion(f); t.after(() => host.close());
  const { direct, files, tasks, core } = host.companion;
  const args = { fileRefId: files.register({ path, source: 'user-attached', conversationId: core.defaultConversationId }).id };
  const task = tasks.create({ runtimeId: 'direct', action: 'file.read', args, ownerRole: 'service',
    requestId: 'registered-offline', title: '读取合成引用', versions: direct.registry.captureVersions('file.read', args) });
  tasks.start(task.id);
  assert.equal((await settleFixtureTask(tasks, task.id)).error?.code, 'PROTECTED_RESOURCE');
});

test('processing plans admit four controlled video formats for transcription and block non-media originals', async t => {
  const f = createFullChainFixture({ name: 'wave1-video', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const host = openMediaReviewCompanion(f), service = host.companion;
  t.after(() => host.close());
  for (const ext of ['mp4', 'mov', 'mkv', 'webm', 'txt']) {
    const taskId = await acceptWorkspaceMaterial(service, { bytes: Buffer.from('format gate fixture ' + ext), name: 'stage2.' + ext, category: 'data', requestId: 'media-' + ext });
    assert.equal((await settleFixtureTask(service.tasks, taskId)).status, 'succeeded');
    const { materialId, sha256 } = service.materials!.getByTask(taskId)!.envelope;
    const { step } = await prepareTranscriptionParse(service, materialId, { taskId: 'synthetic-media', packetSha256: 'a'.repeat(64),
      sourceSha256: sha256, segmentIndex: 0, eventId: 'synthetic', eventType: 'statement' });
    assert.equal(step.applicability, ext === 'txt' ? 'unknown' : 'applicable', JSON.stringify(step));
    if (ext === 'txt') assert.match(JSON.stringify(step), /材料实际格式=text/u);
  }
});

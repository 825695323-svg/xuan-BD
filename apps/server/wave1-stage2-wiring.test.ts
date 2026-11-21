import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { createFullChainFixture, readModelEvidencePreview, settleFixtureTask } from './full-chain-test-support.js';
import { model, openMediaReviewCompanion, openMediaReviewHost, prepareTranscriptionParse, unusedPiContext } from './media-review-test-support.js';

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

async function indexDocument(host: Host) {
  const service = host.companion, segments = service.segments!;
  const paragraphs = Array.from({ length: 20 }, (_, i) =>
    '<w:p><w:r><w:t>受控检索 ' + i + ' ' + '合成段落'.repeat(110) + '</w:t></w:r></w:p>');
  const bytes = zipOfficeParts({
    '[Content_Types].xml': '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<w:document xmlns:w="urn:word"><w:body>' + paragraphs.join('') + '</w:body></w:document>',
  });
  const id = await acceptWorkspaceMaterial(service, { name: 'synthetic.docx', bytes, category: 'data', requestId: 'stage2-doc' });
  assert.equal((await settleFixtureTask(service.tasks, id)).status, 'succeeded');
  const material = service.materials!.getByTask(id)!.envelope;
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
  return { materialId: material.materialId, indexVersion: (indexed.result!.data as { indexVersion: string }).indexVersion };
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
  const { indexVersion, materialId } = await indexDocument(h);
  const oldInput = await startFrozenV21(h), old = toolsFor(h, oldInput);
  const sent = core.sendMessage(core.defaultConversationId, '核对固定快照的财务派生、复权和文档证据。', 'stage2-current');
  const input = await h.backend.waitForInput(sent.commandId), current = toolsFor(h, input);
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
  assert.equal(early.data.citationCount, 0); assert.ok(early.data.coverage.excluded[0].reason);
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

  // 已返回的内容、模型历史和证据续页均须重新核对原资料代次。
  const controlDb = new CoreDatabase(controlDatabasePath);
  try { controlDb.connection.prepare('UPDATE local_data_lifecycle SET generation=generation+1 WHERE data_id=?').run(dataId); }
  finally { controlDb.close(); }
  assert.equal(current.history('search', search).ok, false);
  await assert.rejects(current.perform('search', 'data.retrieval.search', query));
  await assert.rejects(current.invoke('core_evidence_read', 'revoked-page', { evidenceId: first.evidence.evidenceId,
    sha256: first.evidence.sha256, cursor: first.evidence.nextCursor }));
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

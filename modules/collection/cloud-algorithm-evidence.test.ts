import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localAlgorithmConfiguration } from '../../apps/server/financial-configuration.js';
import type { TaskProcessState, TaskRecord } from '../../contracts/task-contracts.js';
import { financialDigest } from '../../plugins/financial/local-compute/assets.js';
import { CLOUD_EVIDENCE_ROOT, cloudEvidenceDirectory, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { AlgorithmCallRequest, AlgorithmComputedResult } from '../financial/algorithm-types.js';
import { CloudCustodyService } from './cloud-custody.js';
import { MaterialService } from './materials/service.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const evidenceDirectory = cloudEvidenceDirectory('行情', '加工证据');
const original = Buffer.from('date,close\n2025-01-01,1.25\n2025-01-02,2.50\n2025-01-03,3.75\n2025-01-04,5.00\n2025-01-05,6.25\n');

/** Only the cloud is simulated: actual archived bytes and metadata persist in a new local directory. */
function isolatedDrive(root: string): CloudCustodyBackend {
  const indexPath = join(root, 'index.json'), callsPath = join(root, 'calls.json');
  if (!existsSync(indexPath)) { writeFileSync(indexPath, '{}'); writeFileSync(callsPath, '[]'); }
  const index = (): Record<string, CloudObject> => JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, CloudObject>;
  const lookup = (path: string): CloudObject | null => index()[path] ?? null;
  return { versionBinding: { cloudBackend: 'isolated-algorithm-evidence/1', cloudBinding: sha(root) },
    availability: () => ({ available: true }),
    open: async (_context, input) => ({
      lookup: async path => lookup(path),
      list: async (path, offset, limit) => {
        const all = Object.values(index()).filter(object => posix.dirname(object.path) === path);
        const items = all.slice(offset, offset + limit), hasMore = offset + items.length < all.length;
        return { items, hasMore, nextOffset: hasMore ? offset + items.length : null };
      },
      prepareDirectory: async path => { assert.equal(path, evidenceDirectory); return true; },
      read: async (object, maxBytes) => {
        assert.equal(input.verifyBytes, true); assert.deepEqual(lookup(object.path), object);
        const bytes = readFileSync(join(root, object.id));
        assert.ok(bytes.length <= maxBytes); assert.equal(bytes.length, object.size);
        assert.equal(createHash('md5').update(bytes).digest('hex'), object.md5);
        return bytes;
      },
      put: async (bytes, path) => {
        assert.equal(input.allowUpload, true); assert.equal(posix.dirname(path), evidenceDirectory);
        const saved = index(); assert.equal(saved[path], undefined, 'isolated drive never overwrites');
        const object: CloudObject = { id: String(1000 + Object.keys(saved).length), path, kind: 'file', size: bytes.length,
          md5: createHash('md5').update(bytes).digest('hex') };
        writeFileSync(join(root, object.id), bytes, { flag: 'wx' }); saved[path] = object;
        writeFileSync(indexPath, JSON.stringify(saved));
        const calls = JSON.parse(readFileSync(callsPath, 'utf8')) as string[]; calls.push(path); writeFileSync(callsPath, JSON.stringify(calls));
        return object;
      },
      copy: async () => { throw new Error('this isolated byte backend has no source copy'); },
      close: async () => {},
    }) };
}

function configure(root: string, python: string) {
  const runtime = join(root, 'runtime'); mkdirSync(runtime);
  const resources: Record<string, unknown> = { python: { kind: 'program', path: realpathSync(python) } };
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads']) {
    const path = join(runtime, name); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path, owned: true, identity: 'algorithm-evidence-' + name, device: String(stat.dev), inode: String(stat.ino) };
  }
  writeFileSync(join(runtime, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'isolated-algorithm-evidence' }));
  writeFileSync(join(runtime, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'isolated-algorithm-evidence', resources }));
  mkdirSync(join(root, 'isolated-cloud'));
}

function open(root: string) {
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions }), runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, permissions, runtimes });
  const materials = new MaterialService({ database, tasks: () => tasks, files, environment: 'synthetic-test' });
  const resources = new ResourceBindings(join(root, 'runtime'));
  const algorithms = localAlgorithmConfiguration({ projectRoot: codeRoot, resources, environment: 'local-review' })(
    { database, tasks: () => tasks, permissions, materials });
  const custody = new CloudCustodyService({ database, tasks: () => tasks, materials, files,
    backend: isolatedDrive(join(root, 'isolated-cloud')), algorithms: () => algorithms });
  runtimes.register(materials.runtime); runtimes.register(algorithms.runtime); runtimes.register(custody.runtime);
  return { database, tasks, materials, algorithms, custody,
    async material(name: string, bytes: Buffer) {
      const path = join(root, name); writeFileSync(path, bytes, { flag: 'wx' });
      const reference = files.register({ path, displayName: name, source: 'user-attached' });
      permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
      const accepted = materials.submit({ fileRefId: reference.id, category: 'data', expectedSha256: sha(bytes) }, 'intake-' + name);
      const done = await tasks.wait(accepted.id); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      return materials.getByTask(done.id)!.envelope;
    },
    async close() { await tasks.dispose(); files.closeTemporaryRetention(); database.close(); },
  };
}

async function settledOrReview(tasks: TaskService, id: string): Promise<TaskRecord> {
  const settled = (task: TaskRecord) => ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'needs_review'].includes(task.status);
  const current = tasks.get(id); if (settled(current)) return current;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('algorithm task did not settle: ' + id)); }, 20_000);
    const unsubscribe = tasks.subscribe(({ task }) => { if (task.id === id && settled(task)) { clearTimeout(timer); unsubscribe(); resolve(task); } });
  });
}

test('real managed-table algorithm evidence archives and restores full persistent result with exact source binding',
  { skip: !process.env.WFD_PYTHON, timeout: 60_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_EVIDENCE_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-cloud-')));
    configure(root, process.env.WFD_PYTHON!);
    let host = open(root);
    try {
      const material = await host.material('source.csv', original);
      const sameBytes = await host.material('same-bytes.csv', original);
      const other = await host.material('other.csv', Buffer.from(original.toString().replace('6.25', '9.25')));
      assert.notEqual(sameBytes.materialId, material.materialId); assert.equal(sameBytes.sha256, material.sha256);
      assert.notEqual(other.sha256, material.sha256);
      const beforeAdoption = host.algorithms.adoptionStatus(); assert.equal(beforeAdoption.state, 'not_adopted');
      const adopted = host.algorithms.adopt({ expectedAssetsVersion: beforeAdoption.current.assetsVersion,
        expectedCodeVersion: beforeAdoption.current.codeVersion, confirmation: 'adopt-local-review' });
      assert.equal(adopted.state, 'adopted');
      const call: AlgorithmCallRequest = { methodId: 'ma', parameters: { period: 3 }, source: {
        kind: 'managed_table', materialId: material.materialId, materialSha256: material.sha256, format: 'csv',
        fieldMapping: { timestamp: 'date', close: 'close' }, dateFormat: 'YYYY-MM-DD',
        semantics: { subject: 'explicit-synthetic-evidence-series', frequency: '1d', timezone: 'Asia/Shanghai',
          priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'generated unadjusted fixture prices',
          barClosed: true, synthetic: true, availability: { kind: 'bar_close', closeTime: '15:00:00' } }, calendar: { mode: 'dense' },
      } };
      const started = host.algorithms.submit('algorithm-evidence-ma-3', call);
      const review = await settledOrReview(host.tasks, started.taskId);
      assert.equal(review.status, 'waiting_approval', JSON.stringify(review.error)); assert.ok(review.approvalId);
      const approval = host.tasks.approve(review.approvalId);
      assert.equal(approval.operation.operationId, 'algorithms.calculate');
      const computed = await host.tasks.wait(started.taskId); assert.equal(computed.status, 'succeeded', JSON.stringify(computed.error));
      const result = host.algorithms.view(started.taskId).result!;
      assert.deepEqual(result.rows.map(row => row.MA), [null, null, 2.5, 3.75, 5]);
      assert.equal(result.methodId, 'ma'); assert.equal(result.methodVersion, 'ma/full-window-v1');
      assert.deepEqual(result.parameters, { period: 3 });
      assert.equal((result.source as Record<string, unknown>).kind, 'managed_table');
      assert.equal((result.source as Record<string, unknown>).materialId, material.materialId);
      assert.equal((result.source as Record<string, unknown>).materialSha256, material.sha256);
      const row = host.database.connection.prepare('SELECT sealed_json,sealed_digest,raw_result_json,raw_result_digest,result_json,result_digest FROM algorithm_calls WHERE task_id=?').get(started.taskId)!;
      assert.equal(financialDigest(JSON.parse(String(row.sealed_json))), result.inputDigest);
      assert.equal(row.sealed_digest, result.inputDigest);
      assert.equal(financialDigest(JSON.parse(String(row.raw_result_json))), row.raw_result_digest);
      assert.equal(financialDigest(result), row.result_digest);
      const processEvents = host.tasks.events(started.taskId).filter(event => event.type === 'WORKER_STATE')
        .map(event => event.data as unknown as TaskProcessState);
      assert.equal(processEvents.filter(event => event.state === 'started').length, 1);
      assert.equal(processEvents.filter(event => event.state === 'exited').length, 1);
      const available = host.custody.listForMaterial(material.materialId).evidenceSources.find(item => item.source.kind === 'algorithm');
      assert.ok(available?.available, JSON.stringify(available));
      const input = { materialId: material.materialId, evidenceSource: { kind: 'algorithm', taskId: started.taskId },
        scopePath: CLOUD_EVIDENCE_ROOT, evidenceTopic: '行情', verifyBytes: true, allowUpload: true,
        purpose: '算法持久结果完整加工证据归档', authorization: { status: 'authorized', basis: '本测试只归档真实算法生成的持久证据到新建隔离字节后端' } };
      for (const unrelated of [sameBytes, other]) {
        assert.throws(() => host.custody.submit({ ...input, materialId: unrelated.materialId }, 'reject-' + unrelated.materialId), { code: 'CLOUD_EVIDENCE_SOURCE_MISMATCH' });
      }
      const archive = host.custody.submit(input, 'algorithm-evidence-archive'); await host.tasks.wait(archive.id);
      const archived = host.custody.view(archive.id); assert.equal(archived.record.state, 'uploaded_verified', JSON.stringify(archived));
      assert.equal(archived.record.evidenceClassification?.purpose, '加工证据');
      assert.equal(archived.record.evidence!.original.materialId, material.materialId);
      assert.equal(archived.record.evidence!.original.sha256, material.sha256);
      assert.equal(posix.dirname(archived.record.remoteObject!.path), evidenceDirectory);
      const remoteBytes = readFileSync(join(root, 'isolated-cloud', archived.record.remoteObject!.id));
      const document = JSON.parse(remoteBytes.toString()) as { schema: string; result: AlgorithmComputedResult };
      assert.equal(document.schema, 'bd.calculation-evidence/1'); assert.deepEqual(document.result, result);
      assert.equal(sha(remoteBytes), archived.record.verifiedSha256);
      await host.close(); host = open(root);
      assert.equal(host.algorithms.adoptionStatus().state, 'adopted');
      assert.deepEqual(host.algorithms.view(started.taskId).result, result);
      assert.equal(host.algorithms.submit('algorithm-evidence-ma-3', call).taskId, started.taskId);
      const reopened = host.custody.view(archive.id);
      const restore = host.custody.recover(archive.id, reopened.task.version, 'algorithm-evidence-restore'); await host.tasks.wait(restore.id);
      const restored = host.custody.view(restore.id); assert.equal(restored.record.state, 'restored_verified', JSON.stringify(restored));
      const recovered = host.custody.readRestored(restore.id);
      assert.deepEqual(recovered.bytes, remoteBytes); assert.deepEqual(JSON.parse(recovered.bytes.toString()).result, result);
      assert.equal(restored.record.remoteObject!.id, archived.record.remoteObject!.id);
      assert.equal(restored.record.coverage.scopeComplete, false);
      await host.close(); host = open(root);
      assert.deepEqual(host.custody.readRestored(restore.id).bytes, remoteBytes);
      assert.deepEqual(host.algorithms.view(started.taskId).result, result);
      assert.deepEqual(host.materials.readOriginal(material.materialId).bytes, original);
      assert.equal(host.tasks.events(started.taskId).filter(event => event.type === 'WORKER_STATE'
        && (event.data as unknown as TaskProcessState).state === 'started').length, 1);
      const writes = JSON.parse(readFileSync(join(root, 'isolated-cloud/calls.json'), 'utf8')) as string[];
      assert.equal(writes.length, 1);
      const proof = { fixture: root, currentSourceCodeOnly: true, deprecatedComputeAssetsEnabled: false,
        original: material, sameBytesDifferentMaterial: sameBytes, otherMaterial: other, adoption: adopted, approval,
        actualPythonProcessEvents: processEvents, actualPersistentResult: result, sealedInputDigest: row.sealed_digest,
        rawResultDigest: row.raw_result_digest, archive: archived, restore: restored,
        remoteBytesSha256: sha(remoteBytes), restoredBytesSha256: recovered.sha256,
        rejectedSourceIdentities: [sameBytes.materialId, other.materialId], remoteWrites: writes,
        reopenedTwice: true, algorithmProcessStarts: 1, restoredCompleteMethodParametersInputDigestSource: true };
      writeFileSync(join(root, 'verification.json'), JSON.stringify(proof, null, 2));
      if (process.env.XUAN_ALGORITHM_EVIDENCE_ROOT) writeFileSync(join(parent, '算法加工证据.json'), JSON.stringify(proof, null, 2));
    } finally { await host.close(); }
  });

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { digestOperationArgs, PermissionService } from '../../platform/security/permissions.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { TaskError, TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { cloudPath, createBaiduCustodyBackend, parseCloudPage, type CloudCustodyBackend, type CloudObject, type CloudSession } from '../../plugins/storage/baidu-drive.js';
import { parseBaiduOutput } from '../../plugins/capture-sources/baidu-drive/index.js';
import { CLOUD_CUSTODY_RUNTIME, CloudCustodyService, type CloudCustodyInput } from './cloud-custody.js';
import { MaterialService } from './materials/service.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const original = Buffer.from('item,value\nfixture,12\n');
const sameLengthOther = Buffer.from('item,value\nfixture,99\n');
const rootPath = '/apps/bdpan';
const folder = rootPath + '/selected';
const evidenceRoot = rootPath + '/证据盘';
const archiveDirectory = evidenceRoot + '/待分类/来源原件';
const request = (materialId: string, extra: Partial<CloudCustodyInput> = {}): CloudCustodyInput => ({ materialId,
  scopePath: folder, purpose: '独立隔离盘原件保管验收', authorization: { status: 'authorized', basis: '操作者仅选择此隔离夹具目录与原件进行本次核证' }, ...extra });
class FixtureDrive implements CloudCustodyBackend {
  readonly versionBinding = { cloudBackend: 'isolated-fixture/1', cloudBinding: 'isolated-fixture-binding' };
  readonly objects = new Map<string, { object: CloudObject; bytes: Buffer }>();
  readonly listings: string[] = [];
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly copies: string[] = [];
  readonly directories = new Set<string>([rootPath, evidenceRoot]);
  readonly preparations: { path: string; create: boolean }[] = [];
  readonly modes: boolean[] = [];
  failList = false;
  exactLookup = false;
  throwAfterPut = false;
  throwAfterCopy = false;
  corruptCopy = false;
  misreportCopyPath?: string;
  throwAfterPrepare = false;
  onPut?: () => void;
  onCopy?: () => void | Promise<void>;
  onPrepare?: (path: string) => void | Promise<void>;
  availability() { return { available: true }; }
  add(path: string, bytes: Buffer, kind: CloudObject['kind'] = 'file') {
    const object: CloudObject = { id: String(90071992547409930000n + BigInt(this.objects.size)), path, kind, size: bytes.length,
      md5: kind === 'file' ? createHash('md5').update(bytes).digest('hex') : null };
    this.objects.set(path, { object, bytes });
    for (let directory = kind === 'directory' ? path : posix.dirname(path); directory.startsWith(rootPath); directory = posix.dirname(directory)) this.directories.add(directory);
    return object;
  }
  async open(_context: unknown, input: Parameters<CloudCustodyBackend['open']>[1]): Promise<CloudSession> {
    this.modes.push(input.allowUpload);
    return {
      ...(this.exactLookup ? { lookup: async (path: string) => this.objects.get(path)?.object ?? null } : {}),
      list: async (path, offset, limit) => {
        this.listings.push(path);
        if (this.failList) throw new TaskError('CLOUD_LIST_UNAVAILABLE', '隔离网络故障注入，不能当作目录为空。');
        const all = [...this.objects.values()].map(item => item.object).filter(item => posix.dirname(item.path) === path);
        const items = all.slice(offset, offset + limit);
        return { items, hasMore: offset + items.length < all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null };
      },
      read: async remote => {
        assert.equal(input.verifyBytes, true); this.reads.push(remote.path);
        const actual = this.objects.get(remote.path);
        if (!actual || actual.object.id !== remote.id || actual.object.kind !== remote.kind || actual.object.size !== remote.size || actual.object.md5 !== remote.md5)
          throw new TaskError('CLOUD_OBJECT_CHANGED', '夹具远端对象编号或版本已变化。');
        return Buffer.from(actual.bytes);
      },
      prepareDirectory: async (path, create) => {
        assert.equal(path, input.targetDirectory); this.preparations.push({ path, create });
        if (this.objects.get(path)?.object.kind === 'file') throw new TaskError('CLOUD_DIRECTORY_CONFLICT', '隔离夹具同名文件阻断目录准备。');
        if (this.directories.has(path)) return true;
        if (!create) return false;
        assert.equal(input.allowUpload, true); await this.onPrepare?.(path);
        this.directories.add(posix.dirname(path)); this.directories.add(path);
        if (this.throwAfterPrepare) throw new TaskError('CLOUD_DIRECTORY_UNKNOWN', '隔离注入：目录已创建但回执未知。');
        return true;
      },
      put: async (bytes, path) => {
        assert.equal(input.allowUpload, true); this.onPut?.(); this.writes.push(path);
        const object = this.add(path, bytes);
        if (this.throwAfterPut) throw new TaskError('CLOUD_UPLOAD_PENDING', '隔离注入：上传已生效但响应丢失。');
        return object;
      },
      copy: async (source, targetDirectory) => {
        assert.equal(input.allowUpload, true);
        assert.equal(targetDirectory, input.targetDirectory); assert.notEqual(targetDirectory, evidenceRoot);
        const path = posix.join(targetDirectory, posix.basename(source.path));
        assert.equal(this.objects.has(path), false, '夹具不允许覆盖既有同名对象');
        this.copies.push(path); await this.onCopy?.();
        const object = this.add(path, this.corruptCopy ? sameLengthOther : this.objects.get(source.path)!.bytes);
        if (this.throwAfterCopy) throw new TaskError('CLOUD_COPY_UNKNOWN_RESULT', '隔离注入：网盘复制已生效但响应丢失。');
        return this.misreportCopyPath ? { ...object, path: this.misreportCopyPath } : object;
      }, close: async () => {},
    };
  }
}
function newRoot() { return realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'cloud-custody-'))); }
function open(root: string, backendFactory: CloudCustodyBackend | ((context: { files: FileReferenceService; artifacts: string; permissions: PermissionService }) => CloudCustodyBackend)) {
  const db = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database: db, permissions });
  const runtimes = new TaskRuntimeRegistry(); tasks = new TaskService({ database: db, runtimes, permissions });
  const materials = new MaterialService({ database: db, tasks: () => tasks, files, environment: 'synthetic-test' });
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { recursive: true });
  const backend = typeof backendFactory === 'function' ? backendFactory({ files, artifacts, permissions }) : backendFactory;
  const custody = new CloudCustodyService({ database: db, tasks: () => tasks, materials, files, backend });
  runtimes.register(materials.runtime); runtimes.register(custody.runtime);
  return { db, tasks, permissions, files, materials, custody,
    async material(bytes = original, filename = 'local-original.csv') {
      const path = join(root, `${randomUUID()}-${filename}`); writeFileSync(path, bytes, { flag: 'wx' });
      const reference = files.register({ path, displayName: filename, source: 'user-attached' });
      permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
      const accepted = materials.submit({ fileRefId: reference.id, category: 'unclassified', expectedSha256: sha(bytes) }, 'material-' + randomUUID());
      const task = await tasks.wait(accepted.id); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
      return materials.getByTask(task.id)!.envelope.materialId;
    },
    async run(input: CloudCustodyInput, requestId = 'cloud-' + randomUUID()) {
      const accepted = custody.submit(input, requestId); await tasks.wait(accepted.id); return custody.view(accepted.id);
    },
    async close() { await tasks.dispose(); db.close(); },
  };
}

test('cloud custody validates its existing registered scope without granting unrelated roots', () => {
  assert.equal(cloudPath('/apps/bdpan'), '/apps/bdpan');
  assert.throws(() => cloudPath('/personal-root'));
  assert.throws(() => cloudPath('/apps/bdpan/../private'));
});

test('new archive requests expose and default to the dedicated evidence root, rejecting other write destinations', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    assert.equal(f.custody.capabilities().evidenceRoot, evidenceRoot);
    assert.equal(f.custody.capabilities().version, 'bd-cloud-custody/6');
    assert.throws(() => f.custody.submit(request(materialId, { verifyBytes: true, allowUpload: true, targetDirectory: folder }), 'outside-evidence'), { code: 'CLOUD_EVIDENCE_ROOT_REQUIRED' });
    assert.throws(() => f.custody.submit(request(materialId, { verifyBytes: true, allowUpload: true, targetDirectory: evidenceRoot }), 'no-direct-root-write'), { code: 'CLOUD_EVIDENCE_ROOT_REQUIRED' });
    const result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.state, 'uploaded_metadata_checked');
    assert.equal(result.record.input.targetDirectory, archiveDirectory);
    assert.equal(posix.dirname(drive.writes[0]!), archiveDirectory);
  } finally { await f.close(); }
});

test('classification preview and a controlled manual topic freeze the exact source-original directory with the automatic basis', async () => {
  const root = newRoot(), drive = new FixtureDrive(); let f = open(root, drive);
  try {
    const materialId = await f.material(original, '行情_财报_标题不能分类.csv');
    const preview = f.custody.listForMaterial(materialId).evidenceClassification!;
    assert.equal(preview.topic, '待分类'); assert.equal(preview.directory, archiveDirectory); assert.equal(preview.purpose, '来源原件');
    assert.ok(preview.basis.length > 3); assert.deepEqual(drive.modes, []);
    assert.throws(() => f.custody.submit({ ...request(materialId), evidenceTopic: '../自由目录' }, 'free-topic'), { code: 'INVALID_CLOUD_INPUT' });
    const input = request(materialId, { scopePath: evidenceRoot, evidenceTopic: '财报', verifyBytes: true, allowUpload: true });
    const result = await f.run(input, 'manual-topic');
    const classification = result.record.evidenceClassification!;
    assert.equal(classification.topic, '财报'); assert.equal(classification.purpose, '来源原件');
    assert.equal(classification.directory, evidenceRoot + '/财报/来源原件'); assert.match(classification.basis, /操作者.*财报.*自动判定为“待分类”/u);
    const frozen = JSON.parse(String(f.db.connection.prepare('SELECT binding_json FROM cloud_custody_requests WHERE task_id=?').get(result.task.id)!.binding_json));
    assert.deepEqual(frozen.automaticEvidenceClassification, { topic: preview.topic, basis: preview.basis });
    assert.equal(frozen.requestedInput.evidenceTopic, '财报'); assert.deepEqual(frozen.input.authorization, input.authorization);
    assert.equal(posix.dirname(drive.writes[0]!), classification.directory); assert.deepEqual(drive.listings, []);
    assert.throws(() => f.custody.submit({ ...input, evidenceTopic: '资讯' }, 'manual-topic'), { code: 'REQUEST_CONFLICT' });
    await f.close(); f = open(root, drive);
    f.db.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('broken'), materialId);
    assert.equal(f.custody.submit(input, 'manual-topic').id, result.task.id, '已受理任务按冻结主题幂等查回，不重新读材料改分类');
    assert.deepEqual(f.custody.view(result.task.id).record.evidenceClassification, classification);
    assert.equal(f.custody.listForMaterial(materialId).evidenceClassification, null, '本地原件损坏只令新预览缺失，旧任务仍可列出');
  } finally { await f.close(); }
});

test('automatic classification uses the held original bytes to choose the market source-original leaf', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const daily = Buffer.from('交易日期,股票代码,收盘价（元）\n20260407,000001,1.20\n20260408,000001,1.40\n');
    const materialId = await f.material(daily, '任意原件名.bin');
    const preview = f.custody.listForMaterial(materialId).evidenceClassification!;
    assert.equal(preview.topic, '行情'); assert.equal(preview.directory, evidenceRoot + '/行情/来源原件');
    const result = await f.run(request(materialId, { scopePath: evidenceRoot, verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.state, 'uploaded_metadata_checked'); assert.deepEqual(result.record.evidenceClassification, preview);
    assert.equal(result.record.input.evidenceTopic, undefined); assert.equal(posix.dirname(drive.writes[0]!), preview.directory);
    assert.deepEqual(drive.listings, []); assert.deepEqual(f.materials.readOriginal(materialId).bytes, daily);
  } finally { await f.close(); }
});

test('a missing leaf is only inspected in read-only mode and the evidence root is never scanned as a source directory', async () => {
  const drive = new FixtureDrive(); drive.add(evidenceRoot + '/other-topic', Buffer.alloc(0), 'directory');
  const f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { scopePath: evidenceRoot, verifyBytes: true }));
    assert.equal(result.record.state, 'missing'); assert.equal(result.record.coverage.pages, 0);
    assert.equal(result.record.coverage.scopeComplete, false); assert.equal(result.record.coverage.globalExistence, 'unknown');
    assert.deepEqual(drive.preparations, [{ path: archiveDirectory, create: false }]); assert.deepEqual(drive.listings, []);
    assert.equal(drive.directories.has(archiveDirectory), false); assert.equal(drive.writes.length, 0); assert.equal(drive.copies.length, 0);
    assert.throws(() => f.custody.submit({ ...request(materialId, { allowUpload: true, verifyBytes: true }), authorization: { status: 'authorized', basis: '已授权' } }, 'unauthorized-create'), { code: 'CLOUD_AUTHORIZATION_REQUIRED' });
    assert.equal(drive.preparations.length, 1);
  } finally { await f.close(); }
});

test('the default source-original leaf is created only when an authorized file write will actually be attempted', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    drive.onPrepare = () => {
      const row = f.db.connection.prepare('SELECT record_json FROM cloud_custody_requests WHERE upload_started=1').get()!;
      const record = JSON.parse(String(row.record_json));
      assert.equal(record.directoryPreparation, 'pending'); assert.equal(record.uploadAttempted, false); assert.equal(record.copyAttempted, false);
      assert.equal(record.writeIntent.targetPath.startsWith(archiveDirectory + '/'), true);
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_upload_claims').get()!.n), 0);
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_target_claims').get()!.n), 0);
    };
    const result = await f.run(request(materialId, { scopePath: archiveDirectory, verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.state, 'uploaded_metadata_checked'); assert.equal(result.record.directoryPreparation, 'ready');
    assert.deepEqual(drive.preparations, [{ path: archiveDirectory, create: false }, { path: archiveDirectory, create: true }]);
    assert.deepEqual(drive.listings, []); assert.equal(drive.writes.length, 1);
  } finally { await f.close(); }
});

test('a directory-only unknown result preserves its intent without file claims and permits a newly authorized request after read-only readiness', async () => {
  for (const operation of ['copy', 'upload'] as const) {
    const drive = new FixtureDrive(); drive.throwAfterPrepare = true;
    const source = operation === 'copy' ? drive.add(folder + '/source.csv', original) : null, f = open(newRoot(), drive);
    try {
      const materialId = await f.material(), input = request(materialId, { scopePath: evidenceRoot, verifyBytes: true, allowUpload: true,
        ...(source ? { sourceRemotePath: source.path } : {}) });
      const first = await f.run(input, 'directory-unknown');
      assert.equal(first.task.status, 'needs_review', operation); assert.equal(first.record.directoryPreparation, 'pending');
      assert.equal(first.record.uploadAttempted, false); assert.equal(first.record.copyAttempted, false);
      assert.equal(first.record.writeIntent!.operation, operation); assert.equal(first.record.gaps[0]!.code, 'CLOUD_DIRECTORY_UNKNOWN');
      assert.equal(drive.writes.length, 0); assert.equal(drive.copies.length, 0);
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_upload_claims').get()!.n), 0);
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_target_claims').get()!.n), 0);
      const preparations = drive.preparations.length;
      const recovery = f.custody.recover(first.task.id, first.task.version, 'directory-unknown-read-only'); await f.tasks.wait(recovery.id);
      assert.equal(f.custody.view(recovery.id).record.state, 'needs_review'); assert.equal(drive.preparations.length, preparations, '旧未决目录恢复不重建目录');
      drive.throwAfterPrepare = false;
      const next = await f.run(input, 'directory-ready-new-authorization');
      assert.equal(next.record.state, operation === 'copy' ? 'copied_metadata_checked' : 'uploaded_metadata_checked', JSON.stringify(next.record.gaps));
      assert.equal(drive.writes.length, operation === 'upload' ? 1 : 0); assert.equal(drive.copies.length, operation === 'copy' ? 1 : 0);
      assert.equal(drive.preparations.filter(item => item.create).length, 1, '后续明确请求只读核实已就绪，不重复mkdir');
      assert.equal(f.custody.view(first.task.id).record.copyAttempted, false); assert.equal(f.custody.view(first.task.id).record.uploadAttempted, false);
    } finally { await f.close(); }
  }
});

test('same-content archive requests share the first verified evidence object across materials and logical topics', async () => {
  const root = newRoot(), drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original); let f = open(root, drive);
  try {
    const materialId = await f.material(), otherMaterialId = await f.material(original, 'another-name.csv');
    const first = await f.run(request(materialId, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
    assert.equal(first.record.state, 'copied_metadata_checked'); drive.listings.length = 0; drive.reads.length = 0; drive.preparations.length = 0;
    const oldRecord = String(f.db.connection.prepare('SELECT record_json FROM cloud_custody_requests WHERE task_id=?').get(first.task.id)!.record_json);
    f.db.connection.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify({ ...first.task.versions, cloudCustody: 'bd-cloud-custody/3' }), first.task.id);
    await f.close(); f = open(root, drive);
    const second = await f.run(request(otherMaterialId, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(second.record.state, 'reused_metadata_checked');
    assert.equal(first.record.remoteObject!.path, evidenceRoot + '/财报/来源原件/source.csv');
    assert.equal(second.record.remoteObject!.id, first.record.remoteObject!.id);
    assert.equal(second.record.remoteObject!.path, first.record.remoteObject!.path);
    assert.equal(second.record.evidenceClassification!.directory, evidenceRoot + '/资讯/来源原件');
    assert.equal(second.record.archiveReference!.taskId, first.task.id);
    assert.deepEqual(drive.listings, []); assert.deepEqual(drive.reads, [first.record.remoteObject!.path]);
    assert.deepEqual(drive.preparations, []); assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
    assert.deepEqual(f.db.connection.prepare('SELECT scope_path FROM cloud_custody_upload_claims ORDER BY scope_path').all().map(row => row.scope_path),
      [evidenceRoot]);
    assert.equal(String(f.db.connection.prepare('SELECT record_json FROM cloud_custody_requests WHERE task_id=?').get(first.task.id)!.record_json), oldRecord, '旧回执不被新主题改写');
    const restored = f.custody.recover(second.task.id, second.task.version, 'shared-object-restore'); await f.tasks.wait(restored.id);
    assert.equal(f.custody.view(restored.id).record.remoteObject!.id, first.record.remoteObject!.id);
    assert.equal(f.custody.view(restored.id).record.archiveReference!.taskId, first.task.id);
    assert.deepEqual(f.custody.readRestored(restored.id).bytes, original);
    assert.deepEqual(drive.preparations, []); assert.equal(drive.copies.length, 1);
    assert.equal(f.custody.audit(second.task.id).some(item => item.event === 'archive_reference_verified'), true);
  } finally { await f.close(); }
});

test('a registered evidence object is rechecked by its frozen identity and bytes without fallback on change or loss', async () => {
  for (const fault of ['id', 'bytes', 'missing'] as const) {
    const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
    try {
      const firstMaterial = await f.material(), otherMaterial = await f.material();
      const first = await f.run(request(firstMaterial, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
      const remote = first.record.remoteObject!, object = drive.objects.get(remote.path)!;
      if (fault === 'id') object.object = { ...object.object, id: '987654321' };
      else if (fault === 'bytes') object.bytes = sameLengthOther;
      else drive.objects.delete(remote.path);
      drive.listings.length = 0; drive.preparations.length = 0; drive.reads.length = 0;
      const result = await f.run(request(otherMaterial, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
      assert.equal(result.record.state, 'needs_review', fault);
      assert.equal(result.record.archiveReference!.taskId, first.task.id);
      assert.equal(result.record.remoteObject!.id, remote.id);
      assert.equal(result.record.verifiedSha256, null);
      assert.equal(result.record.gaps[0]!.code, fault === 'bytes' ? 'CLOUD_ARCHIVE_REFERENCE_UNVERIFIED' : 'CLOUD_OBJECT_CHANGED');
      assert.deepEqual(drive.listings, []); assert.deepEqual(drive.preparations, []);
      assert.deepEqual(drive.reads, [remote.path]); assert.equal(drive.modes.at(-1), false);
      assert.equal(drive.writes.length, 0); assert.equal(drive.copies.length, 1);
    } finally { await f.close(); }
  }
});

test('name-only and selected read-only checks do not use another topic registered in the archive ledger', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    await f.run(request(materialId, { scopePath: evidenceRoot, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
    drive.reads.length = 0; drive.listings.length = 0;
    for (const verifyBytes of [false, true]) {
      const result = await f.run(request(materialId, { scopePath: folder, evidenceTopic: '资讯', verifyBytes }));
      assert.equal(result.record.archiveReference, undefined); assert.equal(result.record.remoteObject, null);
      assert.equal(result.record.state, 'missing');
    }
    assert.deepEqual(drive.reads, []); assert.deepEqual(drive.listings, [folder, folder]);
    assert.equal(drive.writes.length, 1); assert.equal(drive.copies.length, 0);
  } finally { await f.close(); }
});

test('a source_verified receipt in the source area is not an evidence object and still needs its first in-drive copy', async () => {
  const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const firstMaterial = await f.material(), otherMaterial = await f.material();
    const readOnly = await f.run(request(firstMaterial, { sourceRemotePath: source.path, verifyBytes: true }));
    assert.equal(readOnly.record.state, 'source_metadata_checked');
    const archived = await f.run(request(otherMaterial, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(archived.record.state, 'copied_metadata_checked'); assert.equal(archived.record.archiveReference, undefined);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
    assert.notEqual(archived.record.remoteObject!.id, source.id);
  } finally { await f.close(); }
});

test('restoring a source_verified object in another evidence topic does not turn it into a managed archive receipt', async () => {
  const drive = new FixtureDrive(), source = drive.add(evidenceRoot + '/财报/来源原件/source.csv', original), f = open(newRoot(), drive);
  try {
    const firstMaterial = await f.material(), otherMaterial = await f.material();
    const readOnly = await f.run(request(firstMaterial, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true }));
    assert.equal(readOnly.record.state, 'source_metadata_checked');
    const recovery = f.custody.recover(readOnly.task.id, readOnly.task.version, 'source-read-only-restore'); await f.tasks.wait(recovery.id);
    assert.equal(f.custody.view(recovery.id).record.state, 'restored_verified');
    drive.reads.length = 0;
    const archived = await f.run(request(otherMaterial, { scopePath: evidenceRoot, evidenceTopic: '行情', verifyBytes: true, allowUpload: true }));
    assert.equal(archived.record.state, 'uploaded_metadata_checked', JSON.stringify(archived.record.gaps));
    assert.equal(archived.record.archiveReference, undefined);
    assert.deepEqual(drive.reads, [archived.record.remoteObject!.path]);
    assert.equal(drive.writes.length, 1); assert.equal(drive.copies.length, 0);
  } finally { await f.close(); }
});

test('restoring an unresolved evidence archive target provides a verified receipt for later content sharing', async () => {
  const drive = new FixtureDrive(); drive.throwAfterCopy = true;
  const source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const firstMaterial = await f.material(), otherMaterial = await f.material();
    const pending = await f.run(request(firstMaterial, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
    assert.equal(pending.record.state, 'needs_review');
    const recovery = f.custody.recover(pending.task.id, pending.task.version, 'pending-archive-readback'); await f.tasks.wait(recovery.id);
    const restored = f.custody.view(recovery.id); assert.equal(restored.record.state, 'restored_verified');
    drive.reads.length = 0; drive.listings.length = 0; drive.preparations.length = 0;
    const shared = await f.run(request(otherMaterial, { scopePath: evidenceRoot, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(shared.record.state, 'reused_metadata_checked');
    assert.equal(shared.record.archiveReference!.taskId, recovery.id);
    assert.equal(shared.record.remoteObject!.id, restored.record.remoteObject!.id);
    assert.deepEqual(drive.reads, [restored.record.remoteObject!.path]);
    assert.deepEqual(drive.listings, []); assert.deepEqual(drive.preparations, []);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('archive reuse and content claims remain separate when either account binding or connection changes', async () => {
  for (const changed of ['cloudBinding', 'cloudConnection'] as const) {
    const root = newRoot(), firstDrive = new FixtureDrive(); Object.assign(firstDrive.versionBinding, { cloudConnection: 'connection-one' });
    let f = open(root, firstDrive);
    try {
      const materialId = await f.material();
      const first = await f.run(request(materialId, { scopePath: evidenceRoot, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
      assert.equal(first.record.state, 'uploaded_metadata_checked'); await f.close();
      const secondDrive = new FixtureDrive(); Object.assign(secondDrive.versionBinding, { cloudConnection: 'connection-one', [changed]: 'changed-binding' });
      f = open(root, secondDrive);
      const second = await f.run(request(materialId, { scopePath: evidenceRoot, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
      assert.equal(second.record.state, 'uploaded_metadata_checked', JSON.stringify(second.record.gaps));
      assert.equal(second.record.archiveReference, undefined);
      assert.equal(posix.dirname(second.record.remoteObject!.path), evidenceRoot + '/资讯/来源原件');
      assert.equal(secondDrive.writes.length, 1); assert.equal(secondDrive.copies.length, 0);
      assert.deepEqual(secondDrive.reads, [second.record.remoteObject!.path]);
      assert.equal(f.custody.view(first.task.id).record.remoteObject!.path, first.record.remoteObject!.path);
    } finally { await f.close(); }
  }
});

test('same-content concurrent topics are blocked by the first file claim and later share the verified object', { timeout: 5000 }, async () => {
  const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  let entered!: () => void, release!: () => void;
  const copying = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  drive.onCopy = async () => { entered(); await gate; };
  try {
    const firstMaterial = await f.material(), otherMaterial = await f.material();
    const first = f.custody.submit(request(firstMaterial, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }), 'concurrent-content-first');
    await copying; const preparations = drive.preparations.length;
    const secondInput = request(otherMaterial, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true });
    const second = await f.run(secondInput);
    assert.equal(second.record.gaps[0]!.code, 'CLOUD_PREVIOUS_UPLOAD_PENDING');
    assert.equal(drive.preparations.length, preparations); assert.equal(drive.copies.length, 1);
    release(); await f.tasks.wait(first.id);
    const later = await f.run(secondInput);
    assert.equal(later.record.state, 'reused_metadata_checked'); assert.equal(later.record.archiveReference!.taskId, first.id);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
    assert.equal(drive.directories.has(evidenceRoot + '/资讯/来源原件'), false);
  } finally { release(); await f.close(); }
});

test('a late race rechecks verified receipts after directory readiness and restores the shared physical target', { timeout: 5000 }, async () => {
  const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  drive.onPrepare = async path => { if (path === evidenceRoot + '/财报/来源原件') { entered(); await gate; } };
  try {
    const materialId = await f.material();
    const first = f.custody.submit(request(materialId, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }), 'late-race-first');
    await preparing;
    const winner = await f.run(request(materialId, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(winner.record.state, 'copied_metadata_checked'); release(); await f.tasks.wait(first.id);
    const reused = f.custody.view(first.id);
    assert.equal(reused.record.state, 'reused_metadata_checked'); assert.equal(reused.record.copyAttempted, false);
    assert.equal(reused.record.archiveReference!.taskId, winner.task.id);
    assert.equal(reused.record.evidenceClassification!.topic, '财报');
    assert.equal(reused.record.remoteObject!.path, winner.record.remoteObject!.path);
    assert.notEqual(reused.record.writeIntent!.targetPath, reused.record.remoteObject!.path);
    const recovery = f.custody.recover(first.id, reused.task.version, 'late-race-recovery'); await f.tasks.wait(recovery.id);
    assert.equal(f.custody.view(recovery.id).record.remoteObject!.id, winner.record.remoteObject!.id);
    assert.deepEqual(f.custody.readRestored(recovery.id).bytes, original);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { release(); await f.close(); }
});

test('an unresolved legacy leaf claim blocks a new topic before directory preparation across reopen', async () => {
  const root = newRoot(), drive = new FixtureDrive(); drive.throwAfterCopy = true;
  const source = drive.add(folder + '/source.csv', original); let f = open(root, drive);
  try {
    const materialId = await f.material();
    const first = await f.run(request(materialId, { sourceRemotePath: source.path, evidenceTopic: '财报', verifyBytes: true, allowUpload: true }));
    const versions = { ...first.task.versions, cloudCustody: 'bd-cloud-custody/3' };
    f.db.connection.prepare('UPDATE tasks SET versions=? WHERE id=?').run(JSON.stringify(versions), first.task.id);
    f.db.connection.prepare('UPDATE cloud_custody_upload_claims SET binding=?,scope_path=? WHERE task_id=?')
      .run(drive.versionBinding.cloudBinding, evidenceRoot + '/财报/来源原件', first.task.id);
    drive.objects.delete(first.record.writeIntent!.targetPath);
    await f.close(); f = open(root, drive); drive.preparations.length = 0; drive.listings.length = 0;
    const second = await f.run(request(materialId, { sourceRemotePath: source.path, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(second.record.gaps[0]!.code, 'CLOUD_PREVIOUS_UPLOAD_PENDING');
    assert.deepEqual(drive.preparations, []); assert.deepEqual(drive.listings, []);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('actual CLI array metadata keeps large fsid strings and boolean file types, discarding account URLs and rich text', () => {
  const value = parseBaiduOutput('[{"fs_id":90071992547409930001,"fsid":"90071992547409930001","path":"/apps/bdpan/selected/alias.zip","isdir":false,"size":21,"md5":"' + 'a'.repeat(32) + '","download_url":"https://example.test/?token=synthetic-secret","return_markdown":"private account text"}]');
  const page = parseCloudPage(value, folder, 0, 100);
  assert.equal(page.items[0]!.id, '90071992547409930001'); assert.equal(page.items[0]!.kind, 'file');
  assert.equal(page.hasMore, false); assert.doesNotMatch(JSON.stringify(page), /synthetic-secret|private account|download_url|return_markdown/u);
  assert.throws(() => parseCloudPage([{ fsid: '1', path: folder, isdir: true, size: 0 }], folder, 0, 100), { code: 'CLOUD_DIRECTORY_AMBIGUOUS' });
  assert.throws(() => parseCloudPage([{ fsid: '1', path: folder + '/untyped', size: 0 }], folder, 0, 100), { code: 'CLOUD_OBJECT_UNVERIFIED' });
});

test('default name-only check never downloads or recursively scans subdirectories and cannot authorize upload', async () => {
  const drive = new FixtureDrive(); drive.add(folder + '/local-original.csv', original); drive.add(folder + '/nested', Buffer.alloc(0), 'directory');
  const f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId));
    assert.equal(result.record.state, 'source_metadata_checked'); assert.equal(result.record.verifiedSha256, null);
    assert.equal(result.record.coverage.globalExistence, 'unknown'); assert.equal(result.record.coverage.skippedDirectories, 1);
    assert.deepEqual(drive.listings, [folder]); assert.equal(drive.reads.length, 0); assert.equal(drive.writes.length, 0);
    assert.equal(result.record.metadataConfirmed, true, '只读查询按文件名、大小和远端编号确认来源，不上传');
    assert.throws(() => f.custody.submit({ ...request(materialId), authorization: { status: 'authorized', basis: '已授权' } }, 'stateword'), { code: 'CLOUD_AUTHORIZATION_REQUIRED' });
  } finally { await f.close(); }
});

test('read-only original cloud source is fully verified without claiming dedicated evidence custody', async () => {
  const drive = new FixtureDrive();
  for (let i = 0; i < 50; i++) drive.add(rootPath + '/unrelated-' + i, Buffer.alloc(0), 'directory');
  const source = drive.add(rootPath + '/source/renamed-original.bin', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { scopePath: rootPath,
      sourceRemotePath: source.path, verifyBytes: true }));
    assert.equal(result.record.state, 'source_metadata_checked'); assert.equal(result.record.remoteObject!.id, source.id);
    assert.deepEqual(result.record.gaps, []);
    assert.equal(result.record.coverage.scopeComplete, false); assert.equal(result.record.verifiedSha256, null);
    assert.deepEqual(drive.reads, []); assert.equal(drive.writes.length, 0); assert.equal(drive.copies.length, 0);
    assert.equal(f.custody.listForMaterial(materialId).knownSourceRemotePath, source.path);
    assert.deepEqual(f.materials.readOriginal(materialId).bytes, original);
  } finally { await f.close(); }
});

test('metadata-only archive uses matching remote filename and size without downloading original bytes', async () => {
  const drive = new FixtureDrive(); drive.add(archiveDirectory + '/local-original.csv', sameLengthOther); const alias = drive.add(archiveDirectory + '/other-name.zip', original);
  const f = open(newRoot(), drive);
  try {
    const first = await f.material(), second = await f.material();
    for (const materialId of [first, second]) {
      const result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true }));
      assert.equal(result.record.state, 'reused_metadata_checked'); assert.equal(result.record.remoteObject!.id, drive.objects.get(archiveDirectory + '/local-original.csv')!.object.id);
      assert.equal(result.record.material.materialId, materialId); assert.equal(f.materials.get(materialId).envelope.materialId, materialId);
    }
    assert.notEqual(first, second); assert.equal(drive.writes.length, 0);
    assert.deepEqual(drive.reads, [], '元数据归档不进行全文下载');
  } finally { await f.close(); }
});

test('a verified source outside the evidence root is copied within the drive and its distinct archive is fully read back', async () => {
  const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    drive.onCopy = () => {
      const row = f.db.connection.prepare('SELECT upload_started,record_json FROM cloud_custody_requests WHERE upload_started=1').get()!;
      const record = JSON.parse(String(row.record_json));
      assert.equal(row.upload_started, 1); assert.equal(record.state, 'copying'); assert.equal(record.copyAttempted, true);
      assert.deepEqual(record.writeIntent, { operation: 'copy', targetPath: archiveDirectory + '/source.csv', source });
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_target_claims').get()!.n), 1);
    };
    const result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true, sourceRemotePath: source.path }));
    assert.equal(result.record.state, 'copied_metadata_checked', JSON.stringify(result.record.gaps));
    assert.equal(result.record.remoteObject!.path, archiveDirectory + '/source.csv'); assert.notEqual(result.record.remoteObject!.id, source.id);
    assert.equal(result.record.verifiedSha256, null); assert.equal(result.record.metadataConfirmed, true);
    assert.equal(result.record.copyAttempted, true); assert.equal(result.record.uploadAttempted, false);
    assert.deepEqual(drive.copies, [archiveDirectory + '/source.csv']); assert.equal(drive.writes.length, 0);
    assert.deepEqual(drive.reads, []);
    assert.deepEqual(drive.objects.get(source.path)!.bytes, original); assert.deepEqual(f.materials.readOriginal(materialId).bytes, original);
    assert.equal(f.custody.audit(result.task.id).filter(item => item.event === 'candidate_readback').length, 0);
  } finally { await f.close(); }
});

test('unmatched archive filename is not reused solely because full content would match', async () => {
  const drive = new FixtureDrive(), archive = drive.add(archiveDirectory + '/archive-with-another-name', original);
  const source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true, sourceRemotePath: source.path }));
    assert.equal(result.record.state, 'copied_metadata_checked');
    assert.notEqual(result.record.remoteObject!.id, archive.id);
    assert.deepEqual(drive.reads, []);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('an existing different-content archive name blocks copying without overwrite, rename or local upload', async () => {
  const drive = new FixtureDrive(), conflict = drive.add(archiveDirectory + '/source.csv', sameLengthOther);
  const source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true, sourceRemotePath: source.path }));
    assert.equal(result.record.state, 'needs_review'); assert.equal(result.record.gaps[0]!.code, 'CLOUD_TARGET_CONFLICT');
    assert.equal(result.record.copyAttempted, false); assert.equal(drive.copies.length, 0); assert.equal(drive.writes.length, 0);
    assert.equal(drive.objects.get(conflict.path)!.object.id, conflict.id); assert.deepEqual(drive.objects.get(conflict.path)!.bytes, sameLengthOther);
    assert.equal(drive.objects.get(source.path)!.object.id, source.id); assert.deepEqual(drive.objects.get(source.path)!.bytes, original);
  } finally { await f.close(); }
});

test('different-content concurrent sources sharing a basename cannot both claim the evidence target', { timeout: 5000 }, async () => {
  const drive = new FixtureDrive(), sourceA = drive.add(rootPath + '/source-a/shared.csv', original);
  const sourceB = drive.add(rootPath + '/source-b/shared.csv', sameLengthOther), f = open(newRoot(), drive);
  let entered!: () => void, release!: () => void;
  const copying = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  drive.onCopy = async () => { entered(); await gate; };
  try {
    const materialA = await f.material(), materialB = await f.material(sameLengthOther);
    const first = f.custody.submit(request(materialA, { scopePath: posix.dirname(sourceA.path), sourceRemotePath: sourceA.path, verifyBytes: true, allowUpload: true }), 'copy-a');
    await copying;
    const second = await f.run(request(materialB, { scopePath: posix.dirname(sourceB.path), sourceRemotePath: sourceB.path, verifyBytes: true, allowUpload: true }), 'copy-b');
    assert.equal(second.record.state, 'needs_review'); assert.equal(second.record.gaps[0]!.code, 'CLOUD_TARGET_CLAIMED');
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
    release(); await f.tasks.wait(first.id);
    assert.equal(f.custody.view(first.id).record.state, 'copied_metadata_checked');
    assert.deepEqual(drive.objects.get(archiveDirectory + '/shared.csv')!.bytes, original);
  } finally { release(); await f.close(); }
});

test('a copy with same-name same-size target succeeds on metadata without remote byte download', async () => {
  const drive = new FixtureDrive(); drive.corruptCopy = true;
  const source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { sourceRemotePath: source.path, verifyBytes: true, allowUpload: true }));
    assert.equal(result.task.status, 'succeeded'); assert.equal(result.record.state, 'copied_metadata_checked');
    assert.equal(result.record.copyAttempted, true); assert.equal(result.record.verifiedSha256, null);
    assert.equal(result.record.metadataConfirmed, true); assert.equal(drive.reads.length, 0);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('an invalid copy receipt cannot replace the frozen target for read-only recovery', async () => {
  const drive = new FixtureDrive(), source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  drive.misreportCopyPath = source.path;
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { sourceRemotePath: source.path, verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.state, 'needs_review'); assert.equal(result.record.remoteObject, null);
    assert.equal(result.record.writeIntent!.targetPath, archiveDirectory + '/source.csv');
    drive.reads.length = 0; drive.listings.length = 0;
    const restored = f.custody.recover(result.task.id, result.task.version, 'invalid-receipt-restore'); await f.tasks.wait(restored.id);
    assert.equal(f.custody.view(restored.id).record.state, 'restored_verified');
    assert.deepEqual(drive.listings, [archiveDirectory]); assert.deepEqual(drive.reads, [archiveDirectory + '/source.csv']);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('an unresolved copy prevents a fresh local upload when its frozen target is not readable', async () => {
  const drive = new FixtureDrive(); drive.throwAfterCopy = true;
  const source = drive.add(folder + '/source.csv', original), f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { sourceRemotePath: source.path, verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.copyAttempted, true); drive.objects.delete(archiveDirectory + '/source.csv');
    const fresh = await f.run(request(materialId, { scopePath: rootPath + '/another-empty-scope', verifyBytes: true, allowUpload: true }));
    assert.equal(fresh.record.state, 'needs_review'); assert.equal(fresh.record.gaps[0]!.code, 'CLOUD_PREVIOUS_UPLOAD_PENDING');
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('a lost copy receipt persists its exact target across reopen and restores only that object without recopy or upload', async () => {
  const root = newRoot(), drive = new FixtureDrive(); drive.throwAfterCopy = true;
  const source = drive.add(folder + '/source.csv', original); let f = open(root, drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { sourceRemotePath: source.path, verifyBytes: true, allowUpload: true }), 'copy-response-loss');
    assert.equal(result.task.status, 'needs_review'); assert.equal(result.record.copyAttempted, true); assert.equal(result.record.remoteObject, null);
    assert.equal(result.record.writeIntent!.targetPath, archiveDirectory + '/source.csv');
    await f.close(); f = open(root, drive);
    drive.objects.delete(source.path); drive.add(archiveDirectory + '/unrelated-identical.csv', original);
    drive.listings.length = 0; drive.reads.length = 0;
    const restored = f.custody.recover(result.task.id, f.tasks.get(result.task.id).version, 'copy-restore'); await f.tasks.wait(restored.id);
    const view = f.custody.view(restored.id);
    assert.equal(view.record.state, 'restored_verified'); assert.equal(view.record.remoteObject!.path, archiveDirectory + '/source.csv');
    assert.deepEqual(drive.listings, [archiveDirectory]); assert.deepEqual(drive.reads, [archiveDirectory + '/source.csv']);
    assert.equal(drive.modes.at(-1), false); assert.deepEqual(f.custody.readRestored(restored.id).bytes, original);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
    drive.objects.delete(archiveDirectory + '/source.csv'); drive.reads.length = 0;
    const missing = f.custody.recover(result.task.id, f.tasks.get(result.task.id).version, 'copy-target-lost'); await f.tasks.wait(missing.id);
    assert.equal(f.custody.view(missing.id).record.state, 'needs_review'); assert.deepEqual(drive.reads, []);
    assert.equal(drive.copies.length, 1); assert.equal(drive.writes.length, 0);
  } finally { await f.close(); }
});

test('legacy frozen writes cannot run at their old destination and recovery reads only the original outside object', async () => {
  for (const version of [1, 2]) {
  const oldDirectory = version === 1 ? folder : evidenceRoot;
  const root = newRoot(), drive = new FixtureDrive(), oldObject = drive.add(oldDirectory + '/legacy.bd-original', original);
  drive.add(archiveDirectory + '/same-bytes.csv', original);
  let f = open(root, drive);
  try {
    const materialId = await f.material(), envelope = f.materials.get(materialId).envelope;
    const input = request(materialId, { verifyBytes: true, allowUpload: true, targetDirectory: oldDirectory });
    const binding = { requestedInput: input, input, ...(version === 2 ? { evidenceRoot } : {}), material: { materialId, version: envelope.version, filename: envelope.filename,
      sha256: sha(original), byteLength: original.length }, targetPath: oldObject.path, mode: 'check', originalTaskId: null, actor: 'legacy-isolated-fixture' };
    let legacy!: ReturnType<TaskService['createInTransaction']>;
    f.db.transaction(() => {
      legacy = f.tasks.createInTransaction({ title: '冻结旧版网盘归档夹具', ownerRole: 'service', runtimeId: CLOUD_CUSTODY_RUNTIME,
        action: 'cloud.custody.check', args: JSON.parse(JSON.stringify(binding)), requestId: 'cloud.custody:legacy-frozen',
        versions: { ...f.custody.versionBinding, cloudCustody: `bd-cloud-custody/${version}` } });
      const record = { taskId: legacy.task.id, requestId: 'legacy-frozen', mode: 'check', originalTaskId: null,
        material: binding.material, input, state: 'needs_review', remoteObject: oldObject, verifiedSha256: null, uploadAttempted: true,
        restoredBytesAvailable: false, candidates: [], gaps: [], updatedAt: Date.now(),
        coverage: { recursive: false, globalExistence: 'unknown', scopeComplete: false, directories: [], pages: 0, entries: 0, skippedDirectories: 0, readCandidates: 0, readBytes: 0 } };
      const encoded = JSON.stringify(record);
      f.db.connection.prepare('INSERT INTO cloud_custody_requests(task_id,request_id,material_id,binding_json,binding_digest,record_json,record_digest,upload_started,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(legacy.task.id, 'legacy-frozen', materialId, JSON.stringify(binding), digestOperationArgs(binding), encoded, sha(encoded), 1, Date.now());
    });
    legacy.publish(); f.tasks.start(legacy.task.id, legacy.task.version); await f.tasks.wait(legacy.task.id);
    assert.equal(f.tasks.get(legacy.task.id).error!.code, 'CLOUD_VERSION_CONFLICT'); assert.deepEqual(drive.modes, []);
    assert.equal(f.custody.submit(input, 'legacy-frozen').id, legacy.task.id, '旧请求幂等查回沿原冻结输入，不强制改绑新根');
    await f.close(); f = open(root, drive);
    const restored = f.custody.recover(legacy.task.id, f.tasks.get(legacy.task.id).version, 'legacy-restore'); await f.tasks.wait(restored.id);
    assert.equal(f.custody.view(restored.id).record.remoteObject!.id, oldObject.id);
    assert.equal(f.custody.view(restored.id).record.state, 'restored_verified');
    assert.deepEqual(drive.listings, [oldDirectory]); assert.deepEqual(drive.reads, [oldObject.path]); assert.deepEqual(drive.modes, [false]);
    assert.deepEqual(drive.preparations, [], '旧冻结对象只读恢复不采用新目录准备入口');
    assert.equal(drive.writes.length, 0); assert.equal(drive.copies.length, 0); assert.deepEqual(f.custody.readRestored(restored.id).bytes, original);
  } finally { await f.close(); }
  }
});

test('restoration refuses a changed frozen cloud connection rather than binding an old path to the new account', async () => {
  const root = newRoot(), drive = new FixtureDrive(); drive.add(folder + '/source.csv', original);
  let f = open(root, drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { verifyBytes: true }));
    await f.close();
    const other = new FixtureDrive(); Object.assign(other.versionBinding, { cloudBinding: 'different-isolated-account' });
    other.add(folder + '/source.csv', original); f = open(root, other);
    assert.throws(() => f.custody.recover(result.task.id, f.tasks.get(result.task.id).version, 'changed-account'), { code: 'CLOUD_VERSION_CONFLICT' });
    assert.deepEqual(other.listings, []); assert.deepEqual(other.modes, []); assert.equal(other.writes.length, 0); assert.equal(other.copies.length, 0);
  } finally { await f.close(); }
});

test('explicit write authorization uploads once, confirms Skill filename/size/id without remote download', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    const missing = await f.run(request(materialId, { verifyBytes: true }));
    assert.equal(missing.record.state, 'missing'); assert.equal(missing.record.coverage.scopeComplete, true); assert.equal(drive.writes.length, 0);
    drive.onPut = () => {
      const row = f.db.connection.prepare("SELECT upload_started,record_json FROM cloud_custody_requests WHERE upload_started=1").get();
      assert.equal(row!.upload_started, 1); assert.equal(JSON.parse(String(row!.record_json)).state, 'uploading');
      assert.equal(Number(f.db.connection.prepare('SELECT count(*) n FROM cloud_custody_upload_claims').get()!.n), 1);
    };
    const uploaded = await f.run(request(materialId, { verifyBytes: true, allowUpload: true }), 'explicit-upload');
    assert.equal(uploaded.task.status, 'succeeded'); assert.equal(uploaded.record.state, 'uploaded_metadata_checked');
    assert.equal(uploaded.record.verifiedSha256, null);
    assert.equal(uploaded.record.metadataConfirmed, true);
    assert.equal(drive.writes.length, 1); assert.equal(drive.reads.length, 0);
    assert.equal(posix.dirname(drive.writes[0]!), archiveDirectory); assert.match(posix.basename(drive.writes[0]!), /^[a-f0-9]{64}-[a-f0-9-]{36}\.bd-original$/u);
    const again = f.custody.submit(request(materialId, { verifyBytes: true, allowUpload: true, targetDirectory: archiveDirectory }), 'explicit-upload');
    assert.equal(again.id, uploaded.task.id); assert.equal(drive.writes.length, 1);
    assert.throws(() => f.custody.submit(request(materialId, { verifyBytes: true, purpose: '另一个用途' }), 'explicit-upload'), { code: 'REQUEST_CONFLICT' });
  } finally { await f.close(); }
});

test('directory source, missing type, network failure and unvisited child directories remain unknown and never trigger upload', async () => {
  for (const fault of ['source-is-directory', 'network', 'child-directories'] as const) {
    const drive = new FixtureDrive(), f = open(newRoot(), drive);
    try {
      if (fault === 'network') drive.failList = true;
      else drive.add(folder + '/entry', Buffer.alloc(0), 'directory');
      const materialId = await f.material(), result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true,
        ...(fault === 'source-is-directory' ? { sourceRemotePath: folder + '/entry' } : {}) }));
      assert.equal(result.record.state, 'needs_review', fault); assert.equal(drive.writes.length, 0, fault); assert.equal(drive.reads.length, 0, fault);
      assert.notEqual(result.record.gaps[0]!.code, 'CLOUD_CONTENT_NOT_CHECKED');
    } finally { await f.close(); }
  }
});

test('partial directory scan stops at its explicit budget without recursion or treating unlisted files as missing', async () => {
  const drive = new FixtureDrive(); for (let i = 0; i < 1001; i++) drive.add(folder + '/entry-' + i, Buffer.from('a'));
  const f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true }));
    assert.equal(result.record.state, 'needs_review'); assert.equal(result.record.gaps[0]!.code, 'CLOUD_SCAN_BUDGET');
    assert.equal(result.record.coverage.scopeComplete, false); assert.equal(drive.writes.length, 0); assert.equal(drive.listings.length, 10);
    assert.ok(drive.listings.every(path => path === folder));
  } finally { await f.close(); }
});

test('upload response loss preserves its original intent, recovers by readback with no second upload, and survives reopen and local-original loss', async () => {
  const root = newRoot(), drive = new FixtureDrive(); drive.throwAfterPut = true;
  let f = open(root, drive);
  let materialId = '', originalTaskId = '', restoreTaskId = '';
  try {
    materialId = await f.material();
    const result = await f.run(request(materialId, { verifyBytes: true, allowUpload: true }), 'response-loss');
    originalTaskId = result.task.id;
    assert.equal(result.task.status, 'needs_review'); assert.equal(result.record.state, 'needs_review'); assert.equal(result.record.uploadAttempted, true);
    assert.equal(drive.writes.length, 1);
    assert.equal(f.custody.submit(request(materialId, { verifyBytes: true, allowUpload: true }), 'response-loss').id, originalTaskId);
    assert.throws(() => f.tasks.retry(originalTaskId, result.task.version));
    await f.close(); f = open(root, drive);
    assert.equal(f.custody.view(originalTaskId).record.state, 'needs_review');
    // 原材料 BLOB 损坏与远端恢复分属不同事实；恢复不覆盖材料原表。
    f.db.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('broken'), materialId);
    const restored = f.custody.recover(originalTaskId, f.tasks.get(originalTaskId).version, 'restore-original');
    restoreTaskId = restored.id; await f.tasks.wait(restored.id);
    assert.equal(f.custody.view(restored.id).record.state, 'restored_verified'); assert.deepEqual(f.custody.readRestored(restored.id).bytes, original);
    assert.equal(drive.writes.length, 1); assert.equal(drive.modes.at(-1), false);
    assert.throws(() => f.materials.readOriginal(materialId), { code: 'MATERIAL_ORIGINAL_CHANGED' });
    assert.equal(f.tasks.get(originalTaskId).status, 'needs_review', '独立恢复事实不改写旧尝试历史');
    await f.close(); f = open(root, drive);
    assert.deepEqual(f.custody.readRestored(restoreTaskId).bytes, original);
    assert.equal(f.custody.listForMaterial(materialId).items.length, 2);
    f.db.connection.prepare('UPDATE cloud_custody_requests SET restored_bytes=? WHERE task_id=?').run(Buffer.from('altered'), restoreTaskId);
    assert.throws(() => f.custody.readRestored(restoreTaskId), { code: 'CLOUD_RESTORE_STORAGE_CHANGED' });
  } finally { await f.close(); }
});

test('uncertain upload with no readable original cannot be retried under either the old or a fresh request', async () => {
  const drive = new FixtureDrive(); drive.throwAfterPut = true; const f = open(newRoot(), drive);
  try {
    const materialId = await f.material(), input = request(materialId, { verifyBytes: true, allowUpload: true });
    const first = await f.run(input, 'uncertain-upload'); drive.objects.clear();
    const recovery = f.custody.recover(first.task.id, first.task.version, 'uncertain-recovery'); await f.tasks.wait(recovery.id);
    assert.equal(f.custody.view(recovery.id).record.state, 'needs_review'); assert.equal(drive.writes.length, 1);
    const fresh = await f.run(input, 'fresh-request-cannot-replay');
    assert.equal(fresh.record.state, 'needs_review'); assert.equal(fresh.record.gaps[0]!.code, 'CLOUD_PREVIOUS_UPLOAD_PENDING'); assert.equal(drive.writes.length, 1);
  } finally { await f.close(); }
});

/** 实际启动一个仅操作本测试目录的离线程序，验证受控参数、暂存、权限和当前 CLI 数组协议。 */
test('registered offline CLI exercises real controlled processes, alias reuse, upload readback and output redaction', async () => {
  const root = newRoot(), runtime = join(root, 'runtime'), driveRoot = join(root, 'offline-drive'); mkdirSync(runtime); mkdirSync(driveRoot);
  const resources: Record<string, unknown> = {};
  for (const name of ['config', 'cache', 'temp', 'downloads']) {
    const path = join(runtime, name); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path, owned: true, identity: 'fixture-' + name, device: String(stat.dev), inode: String(stat.ino) };
  }
  const binaryPath = join(root, 'offline-bdpan'), configPath = join(runtime, 'config/offline-account.json');
  writeFileSync(configPath, JSON.stringify({ root: driveRoot }), { mode: 0o600 });
  const first: CloudObject = { id: '90071992547409930001', path: folder + '/renamed.csv', kind: 'file', size: original.length,
    md5: createHash('md5').update(original).digest('hex') };
  const evidence: CloudObject = { id: '90071992547409930000', path: evidenceRoot, kind: 'directory', size: 0, md5: null };
  writeFileSync(join(driveRoot, first.id), original); writeFileSync(join(driveRoot, 'index.json'), JSON.stringify([first, evidence]));
  writeFileSync(binaryPath, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2),config=JSON.parse(fs.readFileSync(args[3],'utf8')),root=config.root;
const command=args[4],indexPath=path.join(root,'index.json'),index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
const full=p=>p.startsWith('/apps/bdpan')?p:'/apps/bdpan/'+p;
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({command,args:args.slice(5)})+'\\n');
const publicObject=o=>({fsid:o.id,fs_id:o.id,path:o.path,isdir:o.kind==='directory',size:o.size,md5:o.md5||'',download_url:'https://example.test/?token=synthetic-private-token',return_markdown:'synthetic private account text'});
if(command==='ls'){const start=Number(args[7]),limit=Number(args[9]);console.log(JSON.stringify(index.filter(o=>path.posix.dirname(o.path)===args[5]).slice(start,start+limit).map(publicObject)));}
else if(command==='download'){const o=index.find(o=>o.path===args[5]);fs.writeFileSync(args[6],fs.readFileSync(path.join(root,o.id)),{flag:'wx'});console.log(JSON.stringify({success:true,status:'completed'}));}
else if(command==='mkdir'){const remote=full(args[5]);if(remote==='/apps/bdpan/证据盘'||index.some(o=>o.path===remote)||!index.some(o=>o.path===path.posix.dirname(remote)&&o.kind==='directory'))throw Error('fixture refuses invalid directory creation');const o={id:String(BigInt('90071992547409930002')+BigInt(index.length)),path:remote,kind:'directory',size:0,md5:null};index.push(o);fs.writeFileSync(indexPath,JSON.stringify(index));console.log(JSON.stringify(publicObject(o)));}
else if(command==='cp'){const source=index.find(o=>o.path===full(args[5])),remote=path.posix.join(full(args[6]),path.posix.basename(source.path));if(source.kind!=='file'||index.some(o=>o.path===remote))throw Error('fixture refuses overwrite');const o={...source,id:String(BigInt('90071992547409930002')+BigInt(index.length)),path:remote};fs.writeFileSync(path.join(root,o.id),fs.readFileSync(path.join(root,source.id)),{flag:'wx'});index.push(o);fs.writeFileSync(indexPath,JSON.stringify(index));console.log(JSON.stringify(publicObject(o)));}
else if(command==='upload'){const remote=full(args[6]);if(index.some(o=>o.path===remote))throw Error('fixture refuses overwrite');const bytes=fs.readFileSync(args[5]),o={id:String(BigInt('90071992547409930002')+BigInt(index.length)),path:remote,kind:'file',size:bytes.length,md5:crypto.createHash('md5').update(bytes).digest('hex')};fs.writeFileSync(path.join(root,o.id),bytes,{flag:'wx'});index.push(o);fs.writeFileSync(indexPath,JSON.stringify(index));console.log(JSON.stringify([publicObject(o)]));}
else throw Error('fixture forbids other commands');
`, { mode: 0o700 }); chmodSync(binaryPath, 0o700);
  resources.bdpan = { kind: 'program', path: binaryPath };
  writeFileSync(join(runtime, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'offline-fixture' }));
  writeFileSync(join(runtime, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'offline-fixture', resources }));
  const bindings = new ResourceBindings(runtime), processRuntime = new ProcessRuntime(bindings);
  const f = open(root, ({ files, artifacts, permissions }) => {
    permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: binaryPath } },
      { action: 'secret', target: { kind: 'secret', name: 'baidu-drive.native-login' } },
      ...['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'].map(origin => ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
      ...(['read', 'write', 'delete'] as const).map(action => ({ action, target: { kind: 'directory' as const, path: artifacts, recursive: true } }))] });
    return createBaiduCustodyBackend({ configuration: { binaryPath, configPath }, processRuntime, files, artifactRoot: artifacts });
  });
  try {
    const materialId = await f.material(), reused = await f.run(request(materialId, { verifyBytes: true, sourceRemotePath: first.path }));
    assert.equal(reused.task.status, 'succeeded', JSON.stringify(reused.task.error)); assert.equal(reused.record.state, 'source_metadata_checked', JSON.stringify(reused.record.gaps));
    assert.equal(reused.record.remoteObject!.id, first.id);
    const copied = await f.run(request(materialId, { verifyBytes: true, allowUpload: true, sourceRemotePath: first.path }));
    assert.equal(copied.record.state, 'copied_metadata_checked', JSON.stringify(copied.record.gaps));
    assert.equal(copied.record.remoteObject!.path, archiveDirectory + '/renamed.csv');
    const sharedMaterial = await f.material(original, 'same-content-new-topic.csv');
    const shared = await f.run(request(sharedMaterial, { scopePath: evidenceRoot, evidenceTopic: '资讯', verifyBytes: true, allowUpload: true }));
    assert.equal(shared.record.state, 'reused_metadata_checked', JSON.stringify(shared.record.gaps));
    assert.equal(shared.record.archiveReference!.taskId, copied.task.id);
    assert.equal(shared.record.remoteObject!.id, copied.record.remoteObject!.id);
    assert.equal(shared.record.evidenceClassification!.topic, '资讯');
    const otherBytes = Buffer.from('second original with its own exact bytes\n'), otherId = await f.material(otherBytes, 'second.txt');
    const uploaded = await f.run(request(otherId, { verifyBytes: true, allowUpload: true }));
    assert.equal(uploaded.task.status, 'succeeded', JSON.stringify(uploaded.task.error)); assert.equal(uploaded.record.state, 'uploaded_metadata_checked', JSON.stringify(uploaded.record.gaps));
    assert.equal(sha(readFileSync(join(driveRoot, uploaded.record.remoteObject!.id))), sha(otherBytes));
    const calls = readFileSync(join(driveRoot, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(item => item.command === 'upload').length, 1); assert.equal(calls.filter(item => item.command === 'download').length, 5);
    assert.equal(calls.filter(item => item.command === 'cp').length, 1); assert.equal(calls.filter(item => item.command === 'mkdir').length, 2);
    assert.deepEqual(calls.find(item => item.command === 'cp').args, ['selected/renamed.csv', '证据盘/待分类/来源原件']);
    assert.ok(calls.filter(item => item.command === 'mkdir').every(item => !item.args[0].startsWith('/')));
    assert.ok(calls.find(item => item.command === 'upload').args[1].startsWith('证据盘/待分类/来源原件/'));
    const stored = JSON.stringify({ reused: f.custody.view(reused.task.id), shared: f.custody.view(shared.task.id), uploaded: f.custody.view(uploaded.task.id),
      audit: f.custody.audit(uploaded.task.id), events: f.tasks.events(uploaded.task.id) });
    assert.doesNotMatch(stored, /synthetic-private-token|synthetic private account text|download_url|return_markdown/u);
  } finally { await f.close(); }
});

test('registered conversion evidence archives separately and recovers the derived bytes with original lineage', async () => {
  const drive = new FixtureDrive(), root = newRoot(), f = open(root, drive);
  try {
    const materialId = await f.material(), envelope = f.materials.get(materialId).envelope;
    const bytes = Buffer.from('{"pages":[{"text":"verified processing evidence"}]}');
    const path = join(root, 'conversion.json'); writeFileSync(path, bytes);
    const reference = f.files.register({ path, source: 'generated' });
    f.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
    const { recordArtifact } = await import('./segments/artifacts.js');
    const artifact = recordArtifact(f.db, { material_id: materialId, material_version: String(envelope.version), material_sha256: envelope.sha256,
      conversion_run_id: 'fixture-conversion', artifact_ref: reference.id, artifact_type: 'document-json', artifact_sha256: sha(bytes), artifact_bytes: bytes.length,
      parser_version: 'fixture-parser/1', declared_source_sha256: envelope.sha256 });
    const source = { kind: 'conversion' as const, artifactRecordId: artifact.artifact_record_id };
    const result = await f.run({ ...request(materialId, { verifyBytes: true, allowUpload: true }), evidenceSource: source } as CloudCustodyInput);
    assert.equal(result.record.state, 'uploaded_metadata_checked', JSON.stringify(result));
    assert.equal(result.record.evidenceClassification?.purpose, '加工证据');
    assert.equal(result.record.material.sha256, sha(bytes));
    assert.equal(result.record.evidence?.original.sha256, envelope.sha256);
    assert.equal(posix.dirname(drive.writes[0]!), evidenceRoot + '/待分类/加工证据');
    const recovery = f.custody.recover(result.task.id, result.task.version, 'recover-derived'); await f.tasks.wait(recovery.id);
    assert.deepEqual(f.custody.readRestored(recovery.id).bytes, bytes);
    assert.deepEqual(f.materials.readOriginal(materialId).bytes, original);
    const other = await f.material(Buffer.from('unrelated'));
    assert.throws(() => f.custody.submit({ ...request(other), evidenceSource: source }, 'wrong-source'), { code: 'CLOUD_EVIDENCE_SOURCE_MISMATCH' });
  } finally { await f.close(); }
});


test('restoration uses exact object lookup when directory enumeration is unavailable and does not assert full coverage', async () => {
  const drive = new FixtureDrive(), h = open(newRoot(), drive);
  try {
    const material = await h.material(Buffer.from('value\n12\n'), 'exact-restore.csv');
    const first = h.custody.submit(request(material, { allowUpload: true, verifyBytes: true }), 'exact-restore-upload');
    await h.tasks.wait(first.id);
    const original = h.custody.view(first.id);
    assert.equal(original.record.state, 'uploaded_metadata_checked');
    drive.exactLookup = true; drive.failList = true;
    const restored = h.custody.recover(first.id, original.task.version, 'exact-restore-original');
    await h.tasks.wait(restored.id);
    const result = h.custody.view(restored.id);
    assert.equal(result.record.state, 'restored_verified');
    assert.equal(result.record.coverage.scopeComplete, false);
    assert.ok(result.record.coverage.directories.every(item => item.complete === false));
    assert.equal(drive.writes.length, 1);
    assert.deepEqual(h.custody.readRestored(restored.id).bytes, Buffer.from('value\n12\n'));
  } finally { await h.close(); }
});

test('metadata-only Skill archive does not download after upload, and recovery downloads only on demand', async () => {
  const drive = new FixtureDrive(), f = open(newRoot(), drive);
  try {
    const materialId = await f.material();
    const archived = await f.run(request(materialId, { allowUpload: true, verifyBytes: false }), 'metadata-only');
    assert.equal(archived.task.status, 'succeeded');
    assert.equal(archived.record.state, 'uploaded_metadata_checked');
    assert.equal(archived.record.metadataConfirmed, true);
    assert.equal(archived.record.verifiedSha256, null);
    assert.equal(drive.reads.length, 0);
    assert.equal(drive.writes.length, 1);
    const restored = f.custody.recover(archived.task.id, archived.task.version, 'metadata-restore');
    await f.tasks.wait(restored.id);
    assert.equal(f.custody.view(restored.id).record.state, 'restored_verified');
    assert.deepEqual(f.custody.readRestored(restored.id).bytes, original);
    assert.deepEqual(drive.reads, [archived.record.remoteObject!.path]);
  } finally { await f.close(); }
});

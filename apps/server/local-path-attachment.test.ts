import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApp } from './app.js';
import { ATTACHMENT_UPLOAD_LIMIT } from './attachment-upload.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'isolated attachment test' };
const backend: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('Attachment test must not invoke a model.'); } };
type Reply = { status: number; body: any };

async function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'xuan-attachments-'))), runtime = join(root, 'bd');
  mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'directory' }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path); resources[name] = { path, kind: 'directory' };
  }
  const protectedFile = join(runtime, 'config/machine.bindings.json'), dataId = 'isolated-attachments';
  writeFileSync(join(runtime, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: dataId }));
  writeFileSync(protectedFile, JSON.stringify({ version: 1, revision: 1, runtimeIdentity: dataId, resources }));
  const database = new CoreDatabase(join(runtime, 'state/core.sqlite')), core = new PersonalCore(backend, { database });
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(root, 'control/local-data.sqlite'), dataIdFromTask: () => dataId });
  lifecycle.register(dataId); lifecycle.bindIdentity(dataId, database.path);
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: runtime, codeRoot,
    privateRoot: join(runtime, 'workspace'), resources: new ResourceBindings(runtime),
    localData: { lifecycle, dataId },
    localDataControlPath: join(root, 'control/local-data.sqlite') });
  const server: Server = createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown, generation = '1'): Promise<Reply> => {
    const response = await fetch(base + path, { method, headers: { 'x-mashiro-client': 'web',
      'x-local-data-generation': generation, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const created = await call('POST', '/api/conversations', { pluginId: 'pi', title: 'isolated attachment draft' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id: string = created.body.conversationId, branchId: string = created.body.branchId;
  const upload = (name: string, headers: Record<string, string> = {}) => {
    let outgoing!: ClientRequest;
    const response = new Promise<Reply>((resolve, reject) => {
      outgoing = request(`${base}/api/files/upload?conversationId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, {
        method: 'POST', agent: false, headers: { 'x-mashiro-client': 'web', 'x-local-data-generation': '1', 'content-type': 'application/octet-stream', ...headers },
      }, incoming => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        })().catch(reject);
      });
      outgoing.on('error', reject);
    });
    void response.catch(() => {});
    return { outgoing, response };
  };
  const refs = () => services.files.getRefs({ conversationId: id });
  const bind = (file: { id: string; version: number }, branch = branchId) => call('POST', '/api/ui/draft-references', {
    conversationId: id, branchId: branch, refs: [{ fileRefId: file.id, version: file.version, category: 'unclassified' }],
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await services.tasks.dispose(); await core.dispose(); database.close(); await lifecycle.close();
  };
  return { root, protectedFile, dataId, services, core, lifecycle, id, branchId, created, call, upload, refs, bind, close };
}

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
function stagedBytes(root: string): number {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0);
}
async function writeChunk(outgoing: ClientRequest, chunk: Buffer) { if (!outgoing.write(chunk)) await once(outgoing, 'drain'); }

test('large original path and streamed upload use the same draft binding and persist on readback', async t => {
  const f = await fixture();
  try {
    const selected = join(f.root, 'large-original.mp4');
    writeFileSync(selected, 'synthetic isolated video bytes'); truncateSync(selected, ATTACHMENT_UPLOAD_LIMIT + 1);
    const initial = statSync(selected);
    const original = await f.call('POST', '/api/files', { conversationId: f.id, path: selected });
    assert.equal(original.status, 201, JSON.stringify(original.body));
    assert.equal(original.body.source, 'user-selected'); assert.equal(original.body.size, ATTACHMENT_UPLOAD_LIMIT + 1);
    assert.equal(original.body.invocationPath, selected); assert.equal(original.body.inode, String(initial.ino));
    assert.deepEqual(readdirSync(f.services.attachmentRoot), [], 'Original path registration must not copy the selected file.');
    const originalRefs = await f.bind(original.body); assert.equal(originalRefs.status, 200, JSON.stringify(originalRefs.body));

    const first = Buffer.alloc(128 * 1024, 0x31), second = Buffer.from('第二块合成附件\n');
    const upload = f.upload('synthetic 资料.txt');
    await writeChunk(upload.outgoing, first);
    await waitFor(() => stagedBytes(f.services.attachmentRoot) === first.length, 'First HTTP chunk must reach the private stage before the request ends.');
    assert.equal(f.refs().length, 1, 'An unfinished upload must not register a reference.');
    upload.outgoing.end(second);
    const stored = await upload.response; assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.equal(stored.body.source, 'user-attached'); assert.equal(stored.body.size, first.length + second.length);
    assert.equal(stored.body.displayName, 'synthetic 资料.txt');
    const expected = createHash('sha256').update(first).update(second).digest('hex');
    assert.equal(createHash('sha256').update(readFileSync(stored.body.invocationPath)).digest('hex'), expected);
    assert.equal(statSync(stored.body.invocationPath).mode & 0o777, 0o600);
    assert.equal(readdirSync(f.services.attachmentRoot).length, 1, 'The stage must be settled after atomic publication.');
    const uploadedRefs = await f.bind(stored.body); assert.equal(uploadedRefs.status, 200, JSON.stringify(uploadedRefs.body));
    const draft = (await f.call('GET', `/api/conversations/${f.id}/draft?kind=main`)).body;
    const saved = await f.call('PUT', `/api/conversations/${f.id}/draft`, { key: draft.key, revision: draft.revision,
      text: 'Synthetic draft only.', attachmentRefs: [...originalRefs.body, ...uploadedRefs.body] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await f.call('GET', `/api/conversations/${f.id}/draft?kind=main`)).body.attachmentRefs, saved.body.attachmentRefs);
    assert.deepEqual(saved.body.attachmentRefs.map((ref: { fileRefId: string }) => ref.fileRefId), [original.body.id, stored.body.id]);
    assert.equal(statSync(selected).ino, initial.ino); assert.equal(statSync(selected).size, initial.size);
    assert.equal(f.core.getState(f.id).messages.length, 0);
    t.diagnostic(`original=${initial.size} bytes, streamed=${stored.body.size} bytes, verified sha256=${expected}, saved refs=2; root=${f.root}`);
  } finally { await f.close(); }
});

test('unified draft references retain path, source, version, branch and generation checks', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('POST', '/api/files', { conversationId: f.id })).status, 400);
    assert.equal((await f.call('POST', '/api/files', { conversationId: f.id, path: f.protectedFile })).status, 409);
    const alias = join(f.root, 'protected-alias.json'); symlinkSync(f.protectedFile, alias);
    assert.equal((await f.call('POST', '/api/files', { conversationId: f.id, path: alias })).status, 409);
    const selected = join(f.root, 'selected.txt'); writeFileSync(selected, 'isolated original');
    const hardlink = join(f.root, 'selected-hardlink.txt'); linkSync(selected, hardlink);
    assert.equal((await f.call('POST', '/api/files', { conversationId: f.id, path: hardlink })).status, 409);
    assert.equal((await f.call('POST', '/api/files', { conversationId: f.id, path: selected }, '0')).status, 409);
    assert.equal(f.refs().length, 0);
    const directory = await f.call('POST', '/api/files', { conversationId: f.id, path: f.root });
    assert.equal(directory.status, 201); assert.equal((await f.bind(directory.body)).status, 400);
    const safe = join(f.root, 'safe.txt'); writeFileSync(safe, 'isolated draft file');
    const original = await f.call('POST', '/api/files', { conversationId: f.id, path: safe }); assert.equal(original.status, 201);
    assert.equal((await f.bind({ ...original.body, version: original.body.version + 1 })).body.code, 'STALE_ATTACHMENT');
    const generated = f.services.files.register({ path: safe, source: 'generated', conversationId: f.id });
    assert.equal((await f.bind(generated)).body.code, 'INVALID_ATTACHMENT_SOURCE');
    writeFileSync(safe, 'changed isolated draft file');
    assert.equal((await f.bind(original.body)).body.code, 'FILE_CHANGED');
    const current = await f.call('POST', '/api/files', { conversationId: f.id, path: safe }); assert.equal(current.status, 201);
    assert.equal((await f.bind(current.body, `${f.branchId}-stale`)).body.code, 'STALE_BRANCH');
    assert.deepEqual((await f.call('GET', `/api/conversations/${f.id}/draft?kind=main`)).body.attachmentRefs, []);
    assert.equal(f.core.getState(f.id).messages.length, 0);
  } finally { await f.close(); }
});

test('upload rejects metadata, compression, empty files and declared oversize without references or stages', async () => {
  const f = await fixture();
  try {
    for (const [name, headers, body, status, code] of [
      ['../invalid.txt', {}, 'bytes', 400, 'INVALID_FILE_NAME'],
      ['compressed.bin', { 'content-encoding': 'gzip' }, 'bytes', 400, 'INVALID_UPLOAD'],
      ['empty.bin', {}, '', 400, 'INVALID_UPLOAD'],
      ['oversize.bin', { 'content-length': String(ATTACHMENT_UPLOAD_LIMIT + 1) }, '', 413, 'UPLOAD_TOO_LARGE'],
    ] as const) {
      const upload = f.upload(name, headers); upload.outgoing.end(body);
      const reply = await upload.response; assert.equal(reply.status, status, JSON.stringify(reply.body)); assert.equal(reply.body.code, code);
      if (code === 'UPLOAD_TOO_LARGE') assert.match(reply.body.error, /原路径解析不可用时，上传最多 25 MiB/u);
    }
    assert.deepEqual(f.refs(), []); assert.deepEqual(readdirSync(f.services.attachmentRoot), []);
  } finally { await f.close(); }
});

test('chunked upload enforces the cumulative 25 MiB boundary and cleans rejected private stages', async t => {
  const f = await fixture();
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x5a), upload = f.upload('over-limit.bin');
    for (let index = 0; index < 25; index++) await writeChunk(upload.outgoing, chunk);
    await waitFor(() => stagedBytes(f.services.attachmentRoot) === ATTACHMENT_UPLOAD_LIMIT, 'The complete boundary must remain private until the request ends.');
    assert.deepEqual(f.refs(), []);
    upload.outgoing.end(Buffer.from([1]));
    const refused = await upload.response; assert.equal(refused.status, 413, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'UPLOAD_TOO_LARGE');
    await waitFor(() => readdirSync(f.services.attachmentRoot).length === 0, 'Rejected stage must be removed.');
    assert.deepEqual(f.refs(), []);
    const allowed = f.upload('exact-limit.bin');
    for (let index = 0; index < 25; index++) await writeChunk(allowed.outgoing, chunk);
    allowed.outgoing.end();
    const accepted = await allowed.response; assert.equal(accepted.status, 201, JSON.stringify(accepted.body)); assert.equal(accepted.body.size, ATTACHMENT_UPLOAD_LIMIT);
    assert.equal(f.refs().length, 1); assert.equal(readdirSync(f.services.attachmentRoot).length, 1);
    t.diagnostic(`chunked reject=${ATTACHMENT_UPLOAD_LIMIT + 1} bytes with no reference; accept=${ATTACHMENT_UPLOAD_LIMIT} bytes; root=${f.root}`);
  } finally { await f.close(); }
});

test('truncated HTTP upload cancels the private stage without registering a partial file', async () => {
  const f = await fixture();
  try {
    const upload = f.upload('truncated.bin', { 'content-length': String(128 * 1024) });
    await writeChunk(upload.outgoing, Buffer.alloc(64 * 1024, 0x61));
    await waitFor(() => stagedBytes(f.services.attachmentRoot) === 64 * 1024, 'Partial data must reach the stage before disconnect.');
    upload.outgoing.destroy(new Error('Intentional isolated client disconnect.'));
    await assert.rejects(upload.response);
    await waitFor(() => readdirSync(f.services.attachmentRoot).length === 0, 'Disconnected stage must be cleaned.');
    assert.deepEqual(f.refs(), []);
  } finally { await f.close(); }
});


test('binding generation switch during a streamed upload rejects the old generation and cleans the unpublished stage', async () => {
  const f = await fixture();
  try {
    const upload = f.upload('late-upload.bin');
    await writeChunk(upload.outgoing, Buffer.alloc(64 * 1024, 0x62));
    await waitFor(() => stagedBytes(f.services.attachmentRoot) === 64 * 1024, 'A real streamed write must precede the binding switch.');
    // 模拟受控数据库绑定切换：只推进隔离控制记录的代次，不改动任何业务数据或原状态库。
    const control = new CoreDatabase(join(f.root, 'control/local-data.sqlite'));
    control.connection.prepare('UPDATE local_data_lifecycle SET generation=2, revision=revision+1 WHERE data_id=?').run(f.dataId);
    control.close();
    assert.throws(() => f.lifecycle.assertPrivateAccess(1), /代次/u);
    upload.outgoing.end(Buffer.from('late bytes'));
    const refused = await upload.response;
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    await waitFor(() => readdirSync(f.services.attachmentRoot).length === 0, 'The unpublished stage must be cleaned after the old generation is refused.');
    assert.deepEqual(f.refs(), []);
    assert.equal(f.core.getState(f.id).messages.length, 0);
  } finally { await f.close(); }
});

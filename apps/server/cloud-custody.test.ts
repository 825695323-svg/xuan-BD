import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import type { CloudCustodyInput, CloudCustodyView } from '../../modules/collection/cloud-custody.js';
import { CLOUD_EVIDENCE_ROOT, type CloudCustodyBackend, type CloudObject } from '../../plugins/storage/baidu-drive.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createApp } from './app.js';
import { createApplicationServices } from './services.js';

const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'isolated cloud custody HTTP test' };
const model: Backend = { id: 'isolated-no-model', createSession: async () => { throw new Error('Model calls are not authorized by this fixture'); } };
const bytes = Buffer.from('isolated original bytes\n');
const remote: CloudObject = { id: '90071992547409930009', path: '/apps/bdpan/selected/original.txt', kind: 'file', size: bytes.length,
  md5: createHash('md5').update(bytes).digest('hex') };

test('HTTP custody branches from held originals, persists source association across reopen, restores by a separate read-only task and obeys stop', async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'cloud-http-'))), config = join(root, 'config'); mkdirSync(config);
  let reads = 0, writes = 0;
  const backend: CloudCustodyBackend = { versionBinding: { cloudBackend: 'isolated-http/1', cloudBinding: 'isolated-http' }, availability: () => ({ available: true }),
    open: async (_context, input) => ({ list: async path => ({ items: path === '/apps/bdpan/selected' ? [remote] : [], hasMore: false, nextOffset: null }),
      prepareDirectory: async (path, create) => { assert.equal(create, false); assert.equal(path, CLOUD_EVIDENCE_ROOT + '/待分类/来源原件'); return false; },
      read: async () => { assert.equal(input.verifyBytes, true); reads++; return Buffer.from(bytes); },
      put: async () => { writes++; assert.fail('HTTP association fixture must remain read-only'); },
      copy: async () => { writes++; assert.fail('HTTP association fixture must remain read-only'); }, close: async () => {} }) };
  const open = async () => {
    const database = new CoreDatabase(join(root, 'core.sqlite')), core = new PersonalCore(model, { database });
    const services = createApplicationServices(core, database, { role: 'service', health, projectRoot: root, privateRoot: join(root, 'private'),
      materials: { environment: 'synthetic-test' }, cloudCustodyBackend: backend });
    const server = createApp(core, health, services, { serveWeb: false }).listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/api/bd`;
    const call = async (path: string, body?: unknown, expected = 200) => {
      const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { 'x-mashiro-client': 'web', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
    };
    return { database, core, services, base, call,
      async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await services.r1Batches?.dispose(); await services.r1Auto?.dispose(); services.segments?.close();
        await services.tasks.dispose(); await core.dispose(); database.close(); } };
  };
  let host = await open();
  try {
    const path = join(root, 'original.txt'); writeFileSync(path, bytes, { flag: 'wx' });
    const file = host.services.files.register({ path, source: 'user-attached' });
    host.services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
    const accepted = host.services.materials!.submit({ fileRefId: file.id, category: 'unclassified' }, 'http-material'); await host.services.tasks.wait(accepted.id);
    const materialId = host.services.materials!.getByTask(accepted.id)!.envelope.materialId;
    const capability = await host.call('/cloud-custody/capabilities'); assert.equal(capability.available, true); assert.equal(capability.defaultVerifyBytes, false); assert.equal(capability.recursive, false);
    assert.equal(capability.evidenceRoot, CLOUD_EVIDENCE_ROOT);
    assert.ok(capability.evidenceTopics.includes('待分类'));
    const input: CloudCustodyInput = { materialId, scopePath: '/apps/bdpan/selected', purpose: '隔离 HTTP 原件保管验证',
      authorization: { status: 'authorized', basis: '操作者仅授权此隔离盘文件的完整核证' }, verifyBytes: true };
    const started = await host.call('/cloud-custody/runs', { requestId: 'http-custody', input }, 202) as CloudCustodyView;
    await host.services.tasks.wait(started.task.id);
    const checked = await host.call('/cloud-custody/tasks/' + started.task.id) as CloudCustodyView;
    assert.equal(checked.record.state, 'source_metadata_checked'); assert.equal(writes, 0); assert.equal(reads, 0);
    const audit = await host.call('/cloud-custody/tasks/' + started.task.id + '/audit'); assert.ok(audit.items.some((item: { event: string }) => item.event === 'source_metadata_checked'));
    const r1Requests = Number(host.database.connection.prepare('SELECT count(*) n FROM r1_workspace_requests').get()!.n); assert.equal(r1Requests, 0);
    await host.close(); host = await open();
    const listed = await host.call('/cloud-custody/materials/' + materialId);
    assert.deepEqual({ topic: listed.evidenceClassification.topic, directory: listed.evidenceClassification.directory, purpose: listed.evidenceClassification.purpose },
      { topic: '待分类', directory: CLOUD_EVIDENCE_ROOT + '/待分类/来源原件', purpose: '来源原件' });
    assert.equal(listed.items.length, 1); assert.equal(listed.items[0].task.id, started.task.id); assert.equal(listed.knownSourceRemotePath, remote.path);
    const current = await host.call('/cloud-custody/tasks/' + started.task.id) as CloudCustodyView;
    const recovering = await host.call(`/cloud-custody/tasks/${started.task.id}/recover`, { requestId: 'http-restore', expectedVersion: current.task.version }, 202) as CloudCustodyView;
    await host.services.tasks.wait(recovering.task.id);
    const restored = await host.call('/cloud-custody/tasks/' + recovering.task.id) as CloudCustodyView; assert.equal(restored.record.state, 'restored_verified');
    const response = await fetch(host.base + '/cloud-custody/tasks/' + recovering.task.id + '/original'); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.match(response.headers.get('content-disposition')!, /original\.txt/u);
    assert.equal(reads, 1); assert.equal(writes, 0);
    await host.services.tasks.stopControl('isolated HTTP stop acceptance');
    const stopped = await host.call('/cloud-custody/runs', { requestId: 'http-stopped', input }, 409); assert.equal(stopped.code, 'BD_STOPPED');
    assert.equal(reads, 1); assert.equal(writes, 0);
  } finally { await host.close(); }
});

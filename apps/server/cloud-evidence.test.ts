import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import test from 'node:test';
import type { CloudCustodyBackend, CloudObject } from '../../plugins/storage/baidu-drive.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

function memoryDrive() {
  const data = new Map<string, { object: CloudObject; bytes: Buffer }>(), writes: string[] = [];
  const backend: CloudCustodyBackend = { versionBinding: { cloudBackend: 'isolated-derived-evidence/1', cloudBinding: 'fixture' },
    availability: () => ({ available: true }), open: async (_context, input) => ({
      list: async (path, offset, limit) => { const all = [...data.values()].map(x => x.object).filter(x => dirname(x.path) === path);
        return { items: all.slice(offset, offset + limit), hasMore: offset + limit < all.length, nextOffset: offset + limit < all.length ? offset + limit : null }; },
      read: async object => { const row = data.get(object.path)!; assert.equal(row.object.id, object.id); return Buffer.from(row.bytes); },
      prepareDirectory: async () => true,
      put: async (bytes, path) => { assert.equal(input.allowUpload, true); assert.equal(data.has(path), false); writes.push(path);
        const object: CloudObject = { id: basename(path), path, kind: 'file', size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') };
        data.set(path, { object, bytes: Buffer.from(bytes) }); return object; },
      copy: async () => { throw Error('fixture has no source copy'); }, close: async () => {},
    }) };
  return { backend, writes };
}

test('HTTP processing evidence freezes full lineage, reuses content and restores after host reopen', async () => {
  const fixture = createFullChainFixture({ name: 'processing-cloud-evidence' }), drive = memoryDrive();
  let host = await openFullChainHost(fixture, undefined, drive.backend);
  try {
    const bytes = Buffer.from('name,value\nsource,1.2300\n'), upload = await host.upload('table.csv', 'data', bytes, 'evidence-upload');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const prepared = await host.call('/processing/plans', { requestId: 'evidence-plan', input: {
      routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'evidence', materialIds: [materialId],
        intendedAction: 'inspect', tables: [{ materialId, format: 'csv', types: { value: 'decimal_string' } }] }],
    } }, 202);
    assert.equal((await host.settled(prepared.jobId)).status, 'succeeded');
    const planId = host.services.processing!.getByTask(prepared.jobId)!.plan!.planId;
    const run = await host.call(`/processing/plans/${planId}/run`, { requestId: 'evidence-run' }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const available = await host.call('/cloud-custody/materials/' + materialId);
    const evidence = available.evidenceSources.find((x: any) => x.source.kind === 'processing');
    assert.equal(evidence.available, true, JSON.stringify(available));
    const input = { materialId, evidenceSource: evidence.source, scopePath: '/apps/bdpan/证据盘', verifyBytes: true, allowUpload: true,
      purpose: '隔离加工证据归档与恢复验证', authorization: { status: 'authorized', basis: '此测试明确选择本件加工产物与隔离网盘进行完整字节保管和恢复' } };
    const started = await host.call('/cloud-custody/runs', { requestId: 'evidence-archive', input }, 202);
    await host.settled(started.task.id);
    const view = await host.call('/cloud-custody/tasks/' + started.task.id);
    assert.equal(view.record.state, 'uploaded_metadata_checked', JSON.stringify(view));
    assert.equal(view.record.evidence.lineage.planDigest, host.services.processing!.get(planId).planDigest);
    assert.equal(view.record.evidenceClassification.purpose, '加工证据');
    const restored = await host.call(`/cloud-custody/tasks/${started.task.id}/recover`, { requestId: 'evidence-restore', expectedVersion: view.task.version }, 202);
    await host.settled(restored.task.id);
    const content = host.services.cloudCustody!.readRestored(restored.task.id), json = JSON.parse(content.bytes.toString());
    assert.equal(json.schema, 'bd.processing-evidence/1');
    assert.equal(json.lineage.materials[0].materialId, materialId);
    assert.deepEqual(Buffer.from(json.artifact.bytes, 'base64'), host.services.processing!.outputArtifact(planId, 'evidence').bytes);
    await host.close(); host = await openFullChainHost(fixture, undefined, drive.backend);
    assert.deepEqual(host.services.cloudCustody!.readRestored(restored.task.id).bytes, content.bytes);
    const repeated = await host.call('/cloud-custody/runs', { requestId: 'evidence-second-topic', input: { ...input, evidenceTopic: '财报' } }, 202);
    await host.settled(repeated.task.id);
    assert.equal((await host.call('/cloud-custody/tasks/' + repeated.task.id)).record.state, 'reused_metadata_checked');
    assert.equal(drive.writes.length, 1);
    assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, bytes);
  } finally { await host.close(); }
});

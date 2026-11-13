import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainFixture, type FullChainHost } from './full-chain-test-support.js';
import type { R1SourceMinuteBulkView } from '../../modules/collection/r1-source-minute-bulk-service.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const columns = ['证券代码', '证券名称', '交易日期', '分钟时间', '开盘价（元）', '最高价（元）', '最低价（元）', '收盘价（元）', '成交量', '成交额', '复权因子'];
const raw = Buffer.from('\ufeff' + columns.join(',') + '\r\n'
  + '000002,乙,20260407,2026-04-07 09:30:00,0,1.0,0,0.0,3.0,4.0,1.0\r\n'
  + '000001,"甲""名\r\n续",20260407,2026-04-07 09:30:00,0.0,2.0,0,0.0,0.0,,1.0');
const source = { source_id: 'test-source', provider: 'fixture-provider', requested_url: 'file:///synthetic/source-series/original.csv',
  requested_at_utc: '2026-04-07T00:00:00Z', acquired_at_utc: '2026-04-07T00:01:00Z',
  usage_scope: 'isolated synthetic publication verification', authorization: { status: 'authorized', basis: 'operator synthetic fixture approval' } };
const profile = { version: 'bd.source-field-profile/1', mappingVersion: 1, profileId: 'fixture-source-minute',
  sourceId: source.source_id, series: 'source-series', frequency: 'minute',
  timeBucket: { labelSemantics: 'unknown', interval: 'unknown', lengthMinutes: 1, timezone: 'Asia/Shanghai' },
  adjustment: { status: 'unknown' }, confirmation: { status: 'operator_confirmed', basis: 'isolated synthetic source text fixture', confirmedAtUtc: '2026-04-07T00:00:00Z' },
  fields: columns.map((originalHeader, i) => ({ originalHeader, fieldCode: 'src_' + i, dataType: 'text', unitCode: i === 2 ? 'date' : 'not_applicable',
    role: ['identity', 'value', 'date', 'minute'][i] ?? 'value', ...(i >= 4 ? { measurementStatus: 'unknown' } : {}) })) };

function withBoundVolume(fixture: FullChainFixture) {
  const bindingPath = join(fixture.runtime, 'config/machine.bindings.json');
  const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
  const external = join(fixture.root, 'owned-bulk');
  mkdirSync(external);
  const root = statSync(external, { bigint: true });
  bindings.resources.bulk_csv = { path: external, kind: 'directory', owned: true, optional: true, identity: 'fixture-bulk-csv', device: String(root.dev), inode: String(root.ino) };
  writeFileSync(bindingPath, JSON.stringify(bindings));
  const profiles = join(fixture.runtime, 'config/source-fields');
  mkdirSync(profiles);
  writeFileSync(join(profiles, 'synthetic.json'), JSON.stringify(profile));

  const config = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
  // Keep the real CLI, persistence and protocol. Substitute only volume detection for this isolated local directory.
  const store = fixture.store, runtime = fixture.wfdRuntime;
  config.store = store;
  config.runtime = runtime;
  config.volume = { mount_point: store, volume_uuid: '228F8340-D41F-35DF-B07D-2D723F736836', filesystem: 'exfat', writer_host: 'full-chain-test', writer_epoch: 0 };
  writeFileSync(fixture.configPath, JSON.stringify(config));
  const entry = join(fixture.root, 'isolated-volume-machine.py');
  writeFileSync(entry, [
    'import sys', 'from pathlib import Path', `root = ${JSON.stringify(config.project_root)}`,
    "sys.path[:0] = [root, str(Path(root) / 'tests')]",
    'from test_r2a_volume_publication import FakeDetector',
    'from wfd_sdk import product_volume_service',
    'class IsolatedVolume(product_volume_service.WFDVolumeService):',
    ' def __init__(self, *args, **kwargs):',
    "  kwargs['detector'] = FakeDetector()",
    '  super().__init__(*args, **kwargs)',
    'product_volume_service.WFDVolumeService = IsolatedVolume',
    'from wfd_sdk.product_machine import main', 'raise SystemExit(main())', '',
  ].join('\n'), { mode: 0o600 });
  const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
  Object.assign(registry.connections[0], { store, runtime, entry_path: entry });
  writeFileSync(fixture.registryPath, JSON.stringify(registry));
  chmodSync(fixture.configPath, 0o600);
}

test('assembled R1 HTTP accepts managed whole-date CSV, then publishes and reads a fixed root', { skip: !enabled, timeout: 120_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'source-minute-bulk-http', machine: true, units: { date: { dimension: 'date' } } });
  let host: FullChainHost | undefined;
  try {
    const base = '/r1/batches/chunked', id = 'synthetic-http-intake';
    const body = { mode: 'source_minute_bulk_v1', intakeId: id, name: 'original.csv', sha256: wfdSha256(raw), byteLength: raw.length,
      source, datasetId: 'test_dataset', sourceValueColumns: columns, partitionDate: '20260407' };
    host = await openFullChainHost(fixture);
    assert.equal((await host.call(base + '/start', body, 409)).code, 'R1_BULK_UNAVAILABLE');
    const { mode: _mode, partitionDate: _date, ...legacy } = body;
    const legacyId = 'synthetic-legacy';
    assert.equal((await host.call(base + '/start', { ...legacy, intakeId: legacyId }, 202)).mode, undefined);
    await host.close(); host = undefined;
    withBoundVolume(fixture);
    host = await openFullChainHost(fixture);
    assert.equal((await host.call(base + '/' + legacyId)).state, 'receiving');
    assert.equal((await host.call(base + '/start', body, 202)).bulk.phase, 'receiving');
    async function upload(offset: number, bytes: Buffer) {
      const response = await fetch(host!.base + base + '/' + id + '/chunks/' + offset, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-bd-chunk-sha256': wfdSha256(bytes) },
        body: new Uint8Array(bytes) });
      const result = await response.json();
      assert.equal(response.status, 202, JSON.stringify(result));
      return result as R1SourceMinuteBulkView;
    }
    assert.equal((await upload(0, raw.subarray(0, 43))).receivedBytes, 43);
    await host.close(); host = await openFullChainHost(fixture);
    assert.equal((await host.call(base + '/' + id)).receivedBytes, 43);
    assert.equal((await upload(43, raw.subarray(43))).receivedBytes, raw.length);
    const staging = await host.call(base + '/' + id + '/advance', {}, 202) as R1SourceMinuteBulkView;
    const stage = await host.settled(staging.bulk.stageTaskId!);
    assert.equal(stage.status, 'succeeded', JSON.stringify(stage.error));
    const staged = await host.call(base + '/' + id) as R1SourceMinuteBulkView;
    assert.equal(staged.bulk.phase, 'ready_to_commit');
    assert.equal((await host.services.r1Workspace!.snapshotStatus()).snapshotId, null);
    assert.equal((await host.call(base + '/' + id + '/commit', { manifestDigest: 'sha256:' + '0'.repeat(64) }, 409)).code, 'R1_BULK_CONFIRMATION');
    const committing = await host.call(base + '/' + id + '/commit', { manifestDigest: staged.bulk.manifestDigest }, 202) as R1SourceMinuteBulkView;
    const committed = await host.settled(committing.bulk.commitTaskId!);
    assert.equal(committed.status, 'succeeded', JSON.stringify(committed.status === 'succeeded'
      ? null : (await host.services.r1Runtime!.connection.client.batchStatus(id)).result));
    const complete = await host.call(base + '/' + id) as R1SourceMinuteBulkView;
    assert.equal(complete.state, 'completed'); assert.equal(complete.totalRows, 2);
    assert.equal(complete.bulk.readbackVerified, true);
    assert.equal(complete.bulk.association?.materialId, complete.materialId);
    const first = await host.call(base + '/' + id + '/fixed-read', { pageSize: 1, cursor: null });
    const second = await host.call(base + '/' + id + '/fixed-read', { pageSize: 1, cursor: first.next_cursor });
    assert.deepEqual(first.rows[0].cells.slice(0, 5), ['000001', '甲"名\r\n续', '20260407', '2026-04-07 09:30:00', '0.0']);
    assert.equal(first.rows[0].cells[9], null);
    assert.equal(second.rows[0].cells[0], '000002');
    assert.equal(second.next_cursor, null);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_csv_pages').get()?.n, 0);
    await host.call(base + '/' + id + '/reclaim', {});
    assert.deepEqual(host.services.materials!.readOriginal(complete.materialId!).bytes, raw);
    await host.close(); host = undefined;
    const external = join(fixture.root, 'owned-bulk'), disconnected = join(fixture.root, 'disconnected-bulk');
    renameSync(external, disconnected);
    host = await openFullChainHost(fixture);
    assert.equal((await host.call(base + '/' + legacyId)).state, 'receiving');
    assert.equal((await host.call(base + '/start', { ...body, intakeId: 'disconnected' }, 409)).code, 'R1_BULK_UNAVAILABLE');
    assert.equal((await host.call(base + '/' + id, undefined, 409)).code, 'R1_BULK_UNAVAILABLE');
  } finally {
    await host?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

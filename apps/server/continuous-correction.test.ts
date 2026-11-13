import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1BatchStartInput['source'] = { source_id: 'continuous-correction-fixture', provider: 'isolated fixture',
  requested_url: 'file:///explicit-selected-observations', requested_at_utc: '2026-01-01T00:00:00Z',
  acquired_at_utc: '2026-01-10T00:00:00Z', usage_scope: 'isolated continuous correction verification',
  authorization: { status: 'authorized', basis: 'explicit isolated consecutive batch and correction verification' } };
const binaryHeaders = { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' };

async function wait<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 6000; tries++) {
    const value = await read(); if (done(value)) return value; await delay(50);
  }
  assert.fail('batch did not settle: ' + JSON.stringify(await read()));
}

async function waitTask(host: FullChainHost, taskId: string, states: string[], label: string) {
  for (let tries = 0; tries < 1200; tries++) {
    const task = host.services.tasks.get(taskId);
    if (states.includes(task.status)) return task;
    await delay(50);
  }
  assert.fail('task did not settle: ' + label + ' ' + JSON.stringify(host.services.tasks.get(taskId)));
}

async function binary(host: FullChainHost, path: string, bytes: Buffer, status = 202) {
  const response = await fetch(host.base + path, { method: 'POST', headers: binaryHeaders, body: new Uint8Array(bytes) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}

function csv(rows: string[][]): Buffer {
  return Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\n'
    + rows.map(row => row.join(',')).join('\n') + '\n');
}

test('continuous correction: a real source correction supersedes the published row and reopens',
  { skip: !enabled, timeout: 240_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'continuous-correction', machine: true,
      units: { date: { dimension: 'date' }, cny_per_share: { dimension: 'money_per_share' } } });
    let host = await openFullChainHost(fixture);
    try {
      const runBatch = async (index: number, rows: string[][]) => {
        const bytes = csv(rows);
        const batchId = 'continuous-' + index;
        const input: R1BatchStartInput = { batchId, source, datasetId: 'series',
          datePolicy: 'a_share_calendar_day_asia_shanghai',
          files: [{ name: `part-${index}.csv`, relativePath: `part-${index}.csv`,
            byteLength: bytes.length, sha256: wfdSha256(bytes) }] };
        await host.call('/r1/batches/start', input, 202);
        await binary(host, `/r1/batches/${batchId}/items/item-1/upload`, bytes);
        const view = await wait(() => host.call('/r1/batches/' + batchId) as unknown as Promise<R1BatchView>, value => {
          assert.equal(value.error, null, JSON.stringify(value));
          assert.ok(value.items.every(item => item.state !== 'blocked'), JSON.stringify(value));
          return value.state === 'completed';
        });
        return { bytes, view };
      };
      const first = await runBatch(0, [['20260101', '000001', '原报证券', '1'], ['20260102', '000001', '原报证券', '2']]);
      const second = await runBatch(1, [['20260103', '000001', '原报证券', '3'], ['20260104', '000001', '原报证券', '4']]);
      const firstItem = first.view.items[0]!;
      assert.ok(firstItem.auto?.planIds?.length);
      const latestRows = second.view.items[0]!.auto!.currentRequest!.local.associations as WfdRecord[];
      const latestSnapshotId = String(latestRows[0]!.snapshot_id);
      const originalPlanId = String(firstItem.auto!.planIds![0]);
      const originalOutputId = String(firstItem.auto!.currentRequest!.outputId);
      const originalPlanRow = host.database.connection.prepare(
        'SELECT plan_json FROM processing_plans WHERE plan_id=?').get(originalPlanId) as { plan_json: string };
      const originalOutput = (JSON.parse(originalPlanRow.plan_json) as WfdRecord).outputs as WfdRecord[];
      const originalTarget = (originalOutput.find(item => item.outputId === originalOutputId)!.target) as WfdRecord;
      const originalTables = (originalOutput.find(item => item.outputId === originalOutputId)!.tables) as WfdRecord[];
      const corrected = csv([['20260102', '000001', '原报证券', '20']]);
      const upload = await host.upload('part-2.csv', 'data', corrected, 'correction-material');
      const intake = await host.settled(upload.jobId);
      assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
      const repairMaterialId = host.services.materials!.getByTask(intake.id)!.envelope.materialId;
      const quote = '交易日期,股票代码,股票名称,收盘价（元）';
      const known = { status: 'known', value: '原件表头可核的 CSV 表格；本次仅检查结构',
        evidence: [{ source: 'material', materialId: repairMaterialId, quote, start: 0, end: quote.length }] };
      const unknown = { status: 'unknown', gap: '来源真实性、数据生成口径和业务含义尚未验证。' };
      const purpose = { status: 'known', value: '隔离环境内生成合成更正候选，不授权发布',
        evidence: [{ source: 'operator', field: 'routing.materials.0.dimensions.purpose',
          quote: '隔离环境内生成合成更正候选，不授权发布' }] };
      const repairInput = { routing: { materials: [{ materialId: repairMaterialId,
          dimensions: { role: known, informationNature: unknown, businessObject: known,
            objectTime: unknown, purpose, structureGranularity: known }, intendedAction: 'inspect' }] },
        outputs: [{ outputId: 'observations', materialIds: [repairMaterialId], intendedAction: 'inspect',
          tables: [{ ...(originalTables[0] as WfdRecord), materialId: repairMaterialId }], target: originalTarget }] };
      const planned = await host.call('/processing/plans', { requestId: 'correction-repair-plan', input: repairInput }, 202);
      const planTask = await host.settled(planned.jobId, 120_000);
      assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
      const repairPlanId = host.services.processing!.getByTask(planTask.id)!.plan!.planId;
      const run = await host.call(`/processing/plans/${repairPlanId}/run`, { requestId: 'correction-repair-run' }, 202);
      const runTask = await host.settled(run.jobId, 120_000);
      assert.equal(runTask.status, 'succeeded', JSON.stringify(runTask.error));
      const capabilities = await host.call('/corrections/capabilities');
      const registered = await host.call('/corrections/cases', { requestId: 'continuous-register', input: {
        caseId: 'case-continuous', kind: 'source_correction', errorType: 'source_content_correction',
        discoveredAt: '2026-11-08T08:00:00Z',
        evidence: '供应商后续发布更正原件，20260102 收盘价由 2 更正为 20；通过正式更正入口处理。',
        binding: { planOutput: { planId: originalPlanId, outputId: originalOutputId } },
        connectionSha256: capabilities.connectionSha256 } }, 201);
      const impact = await host.call('/corrections/cases/case-continuous/impact', { requestId: 'continuous-impact' });
      assert.equal(impact.state, 'impact_frozen', JSON.stringify(impact.gaps));
      const impactItems = impact.items as WfdRecord[];
      assert.equal(impactItems.length, 2, JSON.stringify(impactItems));
      assert.ok(impactItems.every(item => item.kind === 'original'));
      const originalAssociations = firstItem.auto!.currentRequest!.local.associations as WfdRecord[];
      const originalProduct = String(originalAssociations[0]!.product_id);
      const suspended = await host.call('/corrections/cases/case-continuous/suspend', { requestId: 'continuous-suspend' });
      assert.equal(suspended.state, 'suspended');
      const previousSha = host.services.materials!.readOriginal(String(firstItem.materialId)).sha256;
      const newSha = host.services.materials!.readOriginal(repairMaterialId).sha256;
      const prepared = await host.call('/corrections/cases/case-continuous/prepare', { requestId: 'continuous-prepare',
        input: { planId: repairPlanId, outputId: 'observations', originalSha256: newSha,
          expectedParentSnapshotId: latestSnapshotId,
          reason: '供应商更正原件将 20260102 收盘价由 2 更正为 20，按原定义与字段映射重新交接。',
          sourceRevision: { sourceId: 'continuous-correction-fixture', provider: 'isolated fixture',
            requestedUrl: 'file:///explicit-selected-observations/part-2.csv',
            requestedAtUtc: new Date(Date.now() + 30 * 60_000).toISOString(),
            acquiredAtUtc: new Date(Date.now() + 60 * 60_000).toISOString(),
            revisionBasis: '供应商后续版本更正同一交易日收盘价', usageScope: 'isolated continuous correction verification',
            originalSha256: newSha, previousOriginalSha256: previousSha } } }).catch((error: unknown) => error);
      assert.ok(!(prepared instanceof Error), prepared instanceof Error ? prepared.message : '');
      const authorized = await host.call('/corrections/cases/case-continuous/authorize', { requestId: 'continuous-authorize',
        input: { frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256 } }, 202);
      const waiting = await waitTask(host, authorized.id, ['waiting_approval'], 'continuous approval');
      host.services.tasks.approve(waiting.approvalId!);
      const done = await waitTask(host, authorized.id, ['succeeded', 'failed', 'cancelled', 'needs_review', 'blocked'], 'continuous repair');
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const view = await host.call('/corrections/cases/case-continuous');
      assert.equal(view.state, 'resolved', JSON.stringify(view));
      assert.ok(view.items.every((item: WfdRecord) => item.state === 'corrected'), JSON.stringify(view.items));
      for (const item of view.items) {
        assert.equal(item.verification.verificationDigest, view.result.verificationDigest);
        assert.equal(item.verification.previousRecordVersion, item.recordVersion);
        assert.ok(item.verification.recordVersion);
        assert.notEqual(item.verification.recordVersion, item.recordVersion);
      }
      const newSnapshot = String((view.result as WfdRecord).newSnapshotId);
      const cellValue = (row: WfdRecord) => {
        const values = isWfdRecord(row.values) ? row.values : null;
        const code = values ? Object.keys(values).find(key => isWfdRecord(values[key])
          && ['decimal', 'integer'].includes(String((values[key] as WfdRecord).data_type))) : undefined;
        const cell = code && values ? values[code] as WfdRecord : null;
        return cell ? String(cell.value) : String(row[`value_decimal`] ?? row.value ?? '');
      };
      const readRows = async (productId: string) => ((await host.services.r1Runtime!.client.fixedRead(
        newSnapshot, productId)).result as WfdRecord).rows as WfdRecord[];
      const sourceRows = await readRows(originalProduct);
      const sourceByKey = new Map(sourceRows.map(row =>
        [String((row.record_ref as WfdRecord).logical_key), row]));
      const correctedKey = 'source_row_8a141c63f6ebfc53c77198a6b7540f7c32f278cb681f710017ff7a01ceaadb35';
      const untouchedKey = 'source_row_b68762ed9da329fdc994eb479390f2fba0e48cd776199ab62e50fc5dfa3a51b3';
      assert.equal(cellValue(sourceByKey.get(correctedKey)!.row as WfdRecord), '20');
      assert.equal(cellValue(sourceByKey.get(untouchedKey)!.row as WfdRecord), '1');
      // 旧快照仅在显式审计下复现原值，并明确不可发布。
      const oldSnapshotId = String(originalAssociations[0]!.snapshot_id);
      const oldAudit = await host.call(`/corrections/cases/case-continuous/audit?snapshotId=${oldSnapshotId}&productId=${originalProduct}`);
      assert.equal(oldAudit.publishable, false);
      assert.equal(cellValue((oldAudit.rows as WfdRecord[]).find(row =>
        String((row.record_ref as WfdRecord).logical_key) === correctedKey)!.row as WfdRecord), '2');
      // 新 R1 关联与公开请求读回。
      const associations = host.database.connection.prepare(
        `SELECT * FROM r1_record_associations WHERE request_id='correction:case-continuous'`).all() as unknown as WfdRecord[];
      assert.equal(associations.length, 2, JSON.stringify(associations));
      const publicRead = await host.call('/r1/requests/correction:case-continuous');
      assert.equal(publicRead.state, 'associated', JSON.stringify(publicRead));
      // 磁盘重开：已解决状态与固定读回均持久，不重复正式替代。
      await host.close();
      host = await openFullChainHost(fixture);
      const reopenedView = await host.call('/corrections/cases/case-continuous');
      assert.equal(reopenedView.state, 'resolved', JSON.stringify(reopenedView));
      const reopenedRead = (await host.services.r1Runtime!.client.fixedRead(newSnapshot, originalProduct)).result as WfdRecord;
      assert.equal(cellValue(((reopenedRead.rows as WfdRecord[]).find(row =>
        String((row.record_ref as WfdRecord).logical_key) === correctedKey)!).row as WfdRecord), '20');
      console.log('view', JSON.stringify({ state: view.state, newSnapshot, associations: associations.length }));
    } finally {
      await host.close().catch(() => {});
    }
  });

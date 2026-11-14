import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import type { EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';

/**
 * 适配原件的普通 R1 链：JSONP（无表头，字段别名）→ 批次 → associated → 固定行版本读回。
 * 样本为合成等价响应，明确标注，不冒充供应商实际下载。
 */
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1BatchStartInput['source'] = { source_id: 'adapter-r1-fixture', provider: 'isolated synthetic adapter',
  requested_url: 'file:///explicit-selected-adapter-observations', requested_at_utc: '2026-04-13T00:00:00Z',
  acquired_at_utc: '2026-04-16T00:00:00Z', usage_scope: 'isolated adapter R1 verification',
  authorization: { status: 'authorized', basis: 'operator selected isolated synthetic adapter samples for this verification' } };
const binaryHeaders = { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' };
const evidence = { sourceId: 'synthetic', provider: '合成等价样本', coverage: '单标的三个交易日',
  basis: '按 20261106 格式对照矩阵的 JSONP 与分号分行结构构造的合成响应；不是供应商真实重放。' };

function payload(rows: string[]): Buffer {
  return Buffer.from('quotebridge_v6_line_hs_600519_01_last(' + JSON.stringify({ data: rows.join(';') }) + ')', 'utf8');
}
// 收盘价按分报送（整数），适配声明 ×0.01 换算为元，正式读回复核换算后的有效值。
const ROWS = ['20260413,600519.SH,贵州茅台,141529,25214', '20260414,600519.SH,贵州茅台,141900,20000',
  '20260415,600519.SH,贵州茅台,142550,30000'];
const BYTES = payload(ROWS);

const config: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'ths.kline.daily.adapter', version: '1',
  match: { endpoint: 'https://d.10jqka.example.test/v6/line/hs_{code}/01/last.js', protocol: 'jsonp/v1', frequency: 'day',
    adjustment: 'qfq', market: 'cn-a-share' },
  carrier: { kind: 'jsonp', charset: 'utf-8', callbackPrefix: 'quotebridge_v6_line_hs_', delimiter: ',', recordSeparator: ';' },
  response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
  fields: [
    { name: 'date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'yyyymmdd' },
    { name: 'code', source: { kind: 'position', index: 1 }, type: 'text' },
    { name: 'name', source: { kind: 'position', index: 2 }, type: 'text' },
    { name: 'close', source: { kind: 'position', index: 3 }, type: 'integer',
      unit: { source: 'cent', target: 'CNY', factor: '0.01', basis: '来源按分报送整数价格；×0.01 为本批声明的价格单位换算，未与第二来源对齐。' } },
    { name: 'volume', source: { kind: 'position', index: 4 }, type: 'integer' },
  ], evidence };

async function wait<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (let tries = 0; tries < 6000; tries++) {
    const value = await read();
    if (done(value)) return value;
    await delay(50);
  }
  assert.fail('未达到预期状态：' + label + ' ' + JSON.stringify(await read()));
}

/** 由真实问题生成补答：只回答真实问题，类型/单位优先取冻结适配声明。 */
function answersFor(questions: { key: string }[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const { key } of questions) {
    if (key === 'source_trade_date_timezone' || key === 'source_date_timezone') answers[key] = 'Asia/Shanghai';
    else if (key === 'source_series') answers[key] = 'synthetic adapter daily kline';
    else if (key === 'source_date_column') answers[key] = 'date';
    else if (key === 'source_key_columns') answers[key] = JSON.stringify(['date', 'code']);
    else if (key.startsWith('code.')) answers[key] = key.slice(5);
    else if (key.startsWith('type.')) answers[key] = key.endsWith('volume') ? 'integer' : key.endsWith('close') ? 'decimal' : 'text';
    else if (key.startsWith('unit.')) answers[key] = key.endsWith('close') ? 'CNY' : key.endsWith('volume') ? 'share' : 'not_applicable';
    else if (key.startsWith('measurement.')) answers[key] = 'stock';
    else if (key.startsWith('state.')) answers[key] = '@all_valid';
    else assert.fail('未预期的问题：' + key);
  }
  return answers;
}

test('适配原件经普通 R1 发布及固定读回', { skip: !enabled, timeout: 900_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'adapter-r1', machine: true,
    units: { date: { dimension: 'date' }, share: { dimension: 'quantity' }, CNY: { dimension: 'number' } } });
  let host = await openFullChainHost(fixture);
  try {
    // 1) 适配候选、重放与采用（普通 HTTP 入口）。
    await host.call('/processing/adapters/candidates', { requestId: 'r1-candidate', input: { config } }, 201);
    const upload = await host.upload('ths-adapter.js', 'data', BYTES, 'r1-adapter-upload');
    const intake = await host.settled(upload.jobId);
    assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
    const materialId = host.services.materials!.getByTask(intake.id)!.envelope.materialId;
    // 反样本：缺列由真实来源解析器拒绝；后续金融数据由独立模块与 WFD 读回核对。
    const badUpload = await host.upload('ths-adapter-bad.js', 'data',
      Buffer.from('quotebridge_v6_line_hs_600519_01_last({"data":"20260413,600519.SH"})', 'utf8'), 'r1-adapter-bad-upload');
    const badIntake = await host.settled(badUpload.jobId);
    assert.equal(badIntake.status, 'succeeded', JSON.stringify(badIntake.error));
    const badMaterialId = host.services.materials!.getByTask(badIntake.id)!.envelope.materialId;
    const replay = await host.call('/processing/adapters/ths.kline.daily.adapter/1/replay', { requestId: 'r1-replay',
      input: { adapterId: config.adapterId, version: '1', samples: [
        { materialId, expectation: 'accept', expect: { rowCount: 3, values: { close: '1415.29', volume: '25214' } } },
        { materialId: badMaterialId, expectation: 'reject' }] } });
    assert.equal(replay.passed, true, JSON.stringify(replay.results));
    const adopted = await host.call('/processing/adapters/ths.kline.daily.adapter/1/adopt', { requestId: 'r1-adopt',
      input: { adapterId: config.adapterId, version: '1', evidenceDigest: replay.evidenceDigest,
        confirmationDigest: replay.evidenceDigest } });
    assert.equal(adopted.status, 'adopted');
    const binding = { adapterId: config.adapterId, version: '1', configDigest: adopted.configDigest };

    // 2) 批次：来源声明、逐件回执模板与已采用适配。
    const batchId = 'adapter-series';
    const input: R1BatchStartInput = { batchId, source, datasetId: 'adapter_series', datePolicy: 'a_share_calendar_day_asia_shanghai',
      files: [{ name: 'part-0.js', relativePath: 'part-0.js', byteLength: BYTES.length, sha256: wfdSha256(BYTES) }],
      sourceAdapter: binding,
      sourceContextTemplate: { kind: 'synthetic', urlTemplate: 'https://d.10jqka.example.test/v6/line/hs_600519/01/last.js?file={file}',
        observedAt: '2026-04-16T00:00:00Z', protocol: 'jsonp/v1', frequency: 'day', adjustment: 'qfq', market: 'cn-a-share',
        basis: '合成等价样本，不是供应商实际下载回执；仅用于适配链验证。' } };
    await host.call('/r1/batches/start', input, 202);
    const uploaded = await fetch(`${host.base}/r1/batches/${batchId}/items/item-1/upload`, { method: 'POST', headers: binaryHeaders, body: new Uint8Array(BYTES) });
    assert.equal(uploaded.status, 202, await uploaded.text());

    // 3) 真实问题补答后收束到 associated。
    for (let round = 0; round < 40; round++) {
      const view = await host.call('/r1/batches/' + batchId) as R1BatchView;
      assert.equal(view.error, null, JSON.stringify(view.error));
      const blocked = view.items.find(item => item.state === 'blocked');
      assert.ok(!blocked, JSON.stringify(blocked?.error));
      if (view.state === 'completed') break;
      let answered = false;
      for (const item of view.items) {
        const auto = item.auto as R1AutoView | null;
        if (auto?.state === 'awaiting_answers') {
          await host.call(`/r1/auto/${item.autoRequestId}/answers`, { answers: answersFor(auto.questions) }, 202);
          answered = true;
        }
      }
      await host.call(`/r1/batches/${batchId}/advance`, {});
      if (!answered) await delay(100);
    }
    const view = await wait(() => host.call('/r1/batches/' + batchId) as unknown as Promise<R1BatchView>,
      value => value.state === 'completed', 'batch completed');
    const item = view.items[0]!;
    assert.equal(item.state, 'associated', JSON.stringify(item));
    const auto = item.auto as R1AutoView;
    const selectedPlan = host.services.processing!.get(auto.planIds.at(-1)!);
    assert.deepEqual(selectedPlan.steps.map(step => step.kind),
      selectedPlan.outputs[0]!.stages, 'R1 only creates modules explicitly required by its publication contract');
    assert.ok(['parse', 'structure', 'check'].every(kind => selectedPlan.steps.some(step => step.kind === kind)));
    assert.equal(auto.taskIds.some(taskId => host.services.tasks.get(taskId).action === 'data.processing.run'), false,
      'new R1 auto handoff must never use the legacy bulk entry');
    assert.ok(auto.taskIds.some(taskId => host.services.tasks.get(taskId).action === 'data.processing.execute'),
      'new R1 auto handoff must use individual persisted module tasks');
    const associations = auto.currentRequest!.local.associations as WfdRecord[];
    assert.equal(associations.length, 3);

    // 4) 原始产品固定读回：有效换算值（元）已发布，来源原值仍在解析产物中。
    const originalRead = await host.call('/r1/products/read', { snapshotId: associations[0]!.snapshot_id, productId: associations[0]!.product_id });
    const valuesOf = (row: WfdRecord) => row.values as WfdRecord;
    const closeField = Object.keys(valuesOf(originalRead.result.rows[0] as WfdRecord))
      .find(field => (valuesOf(originalRead.result.rows[0] as WfdRecord)[field] as WfdRecord)?.unit
        && ((valuesOf(originalRead.result.rows[0] as WfdRecord)[field] as WfdRecord).unit as WfdRecord).unit_code === 'CNY');
    assert.ok(closeField, JSON.stringify(valuesOf(originalRead.result.rows[0] as WfdRecord)));
    const closes = (originalRead.result.rows as WfdRecord[]).map(row => (valuesOf(row)[closeField!] as WfdRecord).value);
    assert.deepEqual(closes.sort(), ['1415.29', '1419', '1425.5']);

    const revisions = (originalRead.result.rows as WfdRecord[]).map(row => (row.record_ref as WfdRecord).revision_id);
    assert.equal(new Set(revisions).size, 3);
    assert.ok(revisions.every(revision => typeof revision === 'string' && revision.length > 0));
    writeFileSync(join(fixture.root, 'adapter-r1-proof.json'), JSON.stringify({ batchId, binding,
      associations, originalRead: originalRead.result,
      sample: { source: '合成等价 JSONP 响应', realVendorReplay: false } }, null, 2));

    // 与前批交叠、且批内出现两次的同一原件，两条都直接指向最早的实际交接。
    const overlapId = 'adapter-series-reuse';
    const overlapping = await host.call('/r1/batches/start', { ...input, batchId: overlapId,
      files: [input.files[0], input.files[0]] }, 202) as R1BatchView;
    const sourceRef = { batchId, itemId: item.itemId };
    assert.equal(overlapping.state, 'completed');
    for (const duplicate of overlapping.items) {
      assert.deepEqual(duplicate.duplicateOf, sourceRef);
      assert.equal(duplicate.autoRequestId, item.autoRequestId);
    }
    const setDuplicate = (id: string, index: number, ref: typeof sourceRef) =>
      host.database.connection.prepare('UPDATE r1_auto_batches SET record_json=json_set(record_json,?,json(?)) WHERE batch_id=?')
        .run(`$.items[${index}].duplicateOf`, JSON.stringify(ref), id);
    const readOverlap = () => host.call('/r1/batches/' + overlapId) as Promise<R1BatchView>;
    // 模拟旧版多跳记录。正确链能读回，坏链仅在读视图中标明受阻。
    setDuplicate(overlapId, 1, { batchId: overlapId, itemId: 'item-1' });
    assert.equal((await readOverlap()).state, 'completed');
    for (const target of ['item-2', 'missing']) {
      setDuplicate(overlapId, 1, { batchId: overlapId, itemId: target });
      const blocked = await readOverlap();
      assert.equal(blocked.items[0]!.state, 'associated');
      assert.equal(blocked.items[1]!.error?.code, 'R1_BATCH_DUPLICATE_INVALID');
      assert.equal(blocked.state, 'blocked');
    }
    setDuplicate(overlapId, 1, { batchId: overlapId, itemId: 'item-1' });

    // 相同原件的复权声明改变：复用已经保管的字节，但须以新交接身份重新核本次适配。
    const changed: R1BatchStartInput = { ...input, batchId: 'adapter-series-hfq',
      sourceContextTemplate: { ...input.sourceContextTemplate!, adjustment: 'hfq' } };
    const started = await host.call('/r1/batches/start', changed, 202) as R1BatchView;
    assert.equal(started.items[0]!.duplicateOf, null);
    assert.notEqual(started.items[0]!.autoRequestId, item.autoRequestId);
    const rejected = await wait(() => host.call('/r1/batches/' + changed.batchId) as Promise<R1BatchView>,
      result => result.items[0]!.state === 'blocked', 'changed source context must be rechecked');
    assert.equal(rejected.items[0]!.materialId, item.materialId);
    assert.equal(rejected.items[0]!.error?.code, 'ADAPTER_CONTEXT_MISMATCH');

    // 旧版可能已经留下跨模板的重复指针。重试或新批次名均不能把它当成本次核验。
    setDuplicate(changed.batchId, 0, { batchId: overlapId, itemId: 'item-2' });
    const legacyView = await host.call('/r1/batches/' + changed.batchId) as R1BatchView;
    assert.equal(legacyView.state, 'blocked');
    assert.equal(legacyView.items[0]!.error?.code, 'R1_BATCH_CONTEXT_CONFLICT');
    assert.equal(legacyView.items[0]!.auto, null);
    for (const retryId of [changed.batchId, 'adapter-series-legacy-alias']) {
      assert.equal((await host.call('/r1/batches/start', { ...changed, batchId: retryId }, 409)).code, 'R1_BATCH_CONTEXT_CONFLICT');
    }

    // 重开时连接身份已变。已关联的原报仍属原批次，调度器不得写坏历史状态。
    const batchRecord = (id: string) => host.database.connection.prepare('SELECT record_json FROM r1_auto_batches WHERE batch_id=?').get(id)!.record_json;
    const saved = batchRecord(batchId), savedConflict = batchRecord(changed.batchId);
    const oldConnection = host.services.r1Runtime!.currentIdentity();
    await host.close();
    appendFileSync(fixture.configPath, '\n');
    host = await openFullChainHost(fixture);
    assert.notEqual(host.services.r1Runtime!.currentIdentity().configSha256, oldConnection.configSha256);
    assert.equal((await host.call('/r1/batches/' + batchId)).state, 'completed');
    assert.equal(batchRecord(batchId), saved);
    assert.equal(batchRecord(changed.batchId), savedConflict);
    // 正式数据按记录/定义/快照独立存在：已完成原报所属适配器退役后，
    // 不需要加载旧来源插件或旧解析实现才能正确读取 WFD 数据。
    await host.call('/processing/adapters/ths.kline.daily.adapter/1/retire',
      { requestId: 'retire-after-wfd-publication' });
    const afterRetirement = await host.call('/r1/products/read',
      { snapshotId: associations[0]!.snapshot_id, productId: associations[0]!.product_id });
    assert.deepEqual(afterRetirement.result.rows, originalRead.result.rows,
      'WFD 正式旧数据的值和记录版本不应依赖仍保留旧适配器活跃配置');
  } finally { await host.close(); }
});

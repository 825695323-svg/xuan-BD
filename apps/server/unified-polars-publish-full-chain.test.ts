import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost } from '../../apps/server/full-chain-test-support.js';

const python = process.env.POLARS_PYTHON;
const wfdPython = process.env.WFD_PYTHON;
const enabled = !!python && !!wfdPython && !!process.env.XUAN_FULL_CHAIN_ROOT;

function dailyMaCsv() {
  const cols = ['business_key', 'start_utc', 'end_utc', 'value_state', 'close',
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency',
    'bd.precision', 'bd.timezone', 'bd.period_type',
    'bd.type.close', 'bd.unit.close', 'bd.measurement.close'];
  const lines = Array.from({ length: 21 }, (_, index) => {
    const start = new Date(Date.UTC(2026, 0, index + 1));
    const end = new Date(start.getTime() + 86400000);
    return ['daily-' + (index + 1), start.toISOString().replace('.000Z', 'Z'),
      end.toISOString().replace('.000Z', 'Z'), 'valid_value', String(index + 1),
      'daily.synthetic.close', 'entity', 'stock_1', 'day', 'day', 'UTC',
      'natural', 'decimal', 'count', 'stock'];
  });
  return Buffer.from([cols, ...lines].map(x => x.join(',')).join('\n') + '\n');
}

async function publishedDailyMaSource(host: Awaited<ReturnType<typeof openFullChainHost>>) {
  const uploaded = await host.upload('daily-ma.csv', 'data', dailyMaCsv(), 'ma20-source-upload');
  const acquired = await host.settled(uploaded.jobId);
  assert.equal(acquired.status, 'succeeded', JSON.stringify(acquired.error));
  const material = host.services.materials!.getByTask(acquired.id);
  assert.ok(material);
  await host.call('/r1/auto/start', { requestId: 'ma20-source-request',
    materialId: material.envelope.materialId, datasetId: 'daily_ma20_source',
    source: { ...source, source_id: 'bd-ma20-synthetic',
      requested_url: 'https://fixture.example.test/ma20.csv',
      usage_scope: 'isolated 21 daily WFD-source rows' } }, 202);
  let answered = false;
  for (let i=0;i<1600;i++) {
    const view = await host.call('/r1/auto/ma20-source-request');
    if (view.state === 'associated') return view;
    if (view.state === 'awaiting_answers' && !answered) {
      const responses: Record<string,string> = {
        source_trade_date_timezone: 'UTC', source_series: 'synthetic same-entity daily close observations',
      };
      assert.ok(view.questions.every((item: any) => Object.hasOwn(responses, item.key)),
        JSON.stringify(view.questions));
      await host.call('/r1/auto/ma20-source-request/answers',
        { answers: Object.fromEntries(view.questions.map((item: any) => [item.key, responses[item.key]])) }, 202);
      answered = true; continue;
    }
    if (['blocked', 'stopped'].includes(view.state)) assert.fail(JSON.stringify(view));
    await delay(25);
  }
  assert.fail('Daily 21-row synthetic WFD source did not associate');
}

function macroCsv() {
  const fields = ['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period',
    'period_start', 'period_end', 'published_at', 'release_id', 'value'];
  const columns = ['business_key', 'start_utc', 'end_utc', 'value_state', ...fields,
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency',
    'bd.precision', 'bd.timezone', 'bd.period_type',
    ...fields.flatMap(field => ['bd.type.' + field, 'bd.unit.' + field, 'bd.measurement.' + field])];
  const data = [
    ['previous-release', '2025', '100', '2025-02-14T00:00:00Z'],
    ['current-release', '2026', '120', '2026-02-14T00:00:00Z'],
  ];
  const rows = data.map(([key, year, value, published]) => [
    key, year + '-01-01T00:00:00Z', year + '-02-01T00:00:00Z', 'valid_value',
    'synthetic-index', 'region_1', 'count', 'not_adjusted', '2020',
    year + '-01-01', year + '-01-31', published, key, value,
    'macro.synthetic.index', 'region', 'region_1', 'month', 'day', 'UTC', 'natural',
    ...fields.flatMap(field => [field === 'value' ? 'decimal' : 'text',
      field === 'value' ? 'count' : 'text', 'stock']),
  ]);
  return Buffer.from([columns, ...rows].map(row => row.join(',')).join('\n') + '\n');
}
const source = {
  source_id: 'bd-unified-e2e', provider: 'isolated synthetic WFD fixture',
  requested_url: 'https://fixture.example.test/macro.csv',
  requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-02-16T00:00:00Z',
  usage_scope: 'isolated macro unified-algorithm end-to-end acceptance',
  authorization: { status: 'authorized' as const, basis: 'generated current and prior fixed synthetic macro releases' },
};
async function publishedSource(host: Awaited<ReturnType<typeof openFullChainHost>>) {
  const uploaded = await host.upload('macro.csv', 'data', macroCsv(), 'unified-macro-upload');
  const acquired = await host.settled(uploaded.jobId);
  assert.equal(acquired.status, 'succeeded', JSON.stringify(acquired.error));
  const material = host.services.materials!.getByTask(acquired.id);
  assert.ok(material);
  await host.call('/r1/auto/start', {
    requestId: 'unified-macro-source', materialId: material.envelope.materialId,
    datasetId: 'macro_unified_source', source,
  }, 202);
  let answered = false;
  for (let i = 0; i < 1600; i++) {
    const view = await host.call('/r1/auto/unified-macro-source');
    if (view.state === 'associated') return view;
    if (view.state === 'awaiting_answers' && !answered) {
      const response: Record<string, string> = {
        source_trade_date_timezone: 'Asia/Shanghai',
        source_series: 'explicit isolated synthetic macro index',
      };
      assert.ok(view.questions.every((item: any) => Object.hasOwn(response, item.key)), JSON.stringify(view.questions));
      await host.call('/r1/auto/unified-macro-source/answers',
        { answers: Object.fromEntries(view.questions.map((item: any) => [item.key, response[item.key]])) }, 202);
      answered = true; continue;
    }
    if (['blocked', 'stopped'].includes(view.state)) assert.fail(JSON.stringify(view));
    await delay(25);
  }
  assert.fail('Synthetic source did not publish to isolated WFD');
}

test('real isolated WFD publishes source, unified Polars computes and R1 publishes/readbacks its derived macro result',
  { skip: !enabled ? 'Requires explicitly selected WFD_PYTHON, POLARS_PYTHON, XUAN_FULL_CHAIN_ROOT.' : false,
    timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'unified-algorithm-e2e', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' },
        date: { dimension: 'date' }, percent: { dimension: 'ratio' } } });
    const binding = join(fixture.runtime, 'config/machine.bindings.json');
    const config = JSON.parse(readFileSync(binding, 'utf8'));
    config.resources.polars_python = { kind: 'program', path: python };
    config.revision++;
    writeFileSync(binding, JSON.stringify(config, null, 2));
    const host = await openFullChainHost(fixture);
    try {
      assert.ok(host.services.unifiedPolars, '原 Polars 任务运行时仍由宿主登记，旧任务身份不变');
      assert.ok(host.services.processing, '原报清洗与结构化仍归生产加工计划服务');
      assert.ok(host.services.productionCalculation, '计算模块与清洗模块在 BD 生产体系内并列装配');
      assert.equal(typeof (host.services.processing as unknown as { calculate?: unknown }).calculate, 'undefined',
        '清洗服务不得暴露固定公式执行接口');
      assert.equal(Object.hasOwn(host.services.processing!.catalog() as object, 'calculationModule'), false,
        '清洗能力目录不得混入因子计算方法');
      const methods = host.services.productionCalculation!.capabilities();
      assert.equal(methods.owner, 'data_production');
      assert.equal(methods.methods.find(item => item.methodId === 'macro_yoy')?.status, 'ready');
      assert.equal(methods.methods.find(item => item.methodId === 'source_observation_ma')?.status, 'ready');
      assert.ok(host.services.derivedPublisher, '发布适配器仍复用原 R1，而不新建第二份账本');
      const sourceView = await publishedSource(host);
      const associated = sourceView.currentRequest.local.associations;
      const snapshotId = associated[0].snapshot_id, productId = associated[0].product_id;
      assert.ok(snapshotId); assert.ok(productId);
      const page = await host.call('/r1/products/read', { snapshotId, productId });
      const ref = (key: string) => {
        const actual = page.result.rows.find((item: any) => item.record_ref.logical_key === key);
        assert.ok(actual, key);
        return { snapshotId, productId, businessKey: key, recordVersion: actual.record_ref.revision_id };
      };
      host.services.permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: python! } }],
        label: 'isolated exact Polars execution', scope: { kind: 'persistent' } });
      const submitted = host.services.productionCalculation!.submit('unified-e2e-macro', {
        methodId: 'macro_yoy', source: { kind: 'fixed_snapshot' },
        calculation: { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
          knowledgeCutoff: '2026-02-15T00:00:00Z',
          inputs: [ref('current-release'), ref('previous-release')] },
        usage: { purpose: 'current_compute' },
      });
      const computed = await host.settled(submitted.taskId);
      assert.equal(computed.status, 'succeeded', JSON.stringify(computed.error));
      assert.equal((computed.result?.data as any).rows[0].value, '20.00000000');
      const before = (await host.services.r1Workspace!.snapshotStatus()).snapshotId;
      const outcome = await host.services.productionCalculation!.publish(computed.id);
      assert.equal(outcome.published, true, JSON.stringify({
        outcome, isolatedReceipt: host.services.r1!.attempt(outcome.requestId).receipt_json,
      }));
      assert.equal(outcome.fixedReadback, true);
      const after = (await host.services.r1Workspace!.snapshotStatus()).snapshotId;
      assert.notEqual(after, before);
      assert.equal(host.services.r1!.attempt(outcome.requestId).state, 'associated');
      const original = host.services.r1!.attempt(outcome.requestId);
      assert.equal((JSON.parse(String(original.local_refs_json))).fixedAlgorithm.kind, 'structured_polars');
      const again = await host.services.productionCalculation!.publish(computed.id);
      assert.equal(again.requestId, outcome.requestId);
      assert.equal(again.published, true);
      assert.equal(Number(host.database.connection.prepare(
        'SELECT count(*) AS n FROM tasks WHERE runtime_id=?').get('bd.algorithms.polars')?.n), 1);
      assert.equal((host.services.unifiedPolars!.view(computed.id).result?.rows[0] as any).value, '20.00000000');
      assert.ok(canonicalWfdJson(original.document_json).length > 0);
    } finally { await host.close(); }
  });

test('real WFD frozen complete daily source -> Polars MA20 -> R1 full warmup/valid rows and fixed readback',
  { skip: !enabled ? 'Requires WFD_PYTHON, POLARS_PYTHON and isolated XUAN_FULL_CHAIN_ROOT.' : false,
    timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'wfd-ma20-real-e2e', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' },
        date: { dimension: 'date' }, percent: { dimension: 'ratio' } } });
    const binding = join(fixture.runtime, 'config/machine.bindings.json');
    const config = JSON.parse(readFileSync(binding, 'utf8'));
    config.resources.polars_python = { kind: 'program', path: python };
    config.revision++;
    writeFileSync(binding, JSON.stringify(config, null, 2));
    const host = await openFullChainHost(fixture);
    try {
      assert.equal(host.services.productionCalculation!.capabilities().methods.find(
        item => item.methodId === 'source_observation_ma')?.status, 'ready');
      const original = await publishedDailyMaSource(host);
      const association = original.currentRequest.local.associations[0];
      const snapshotId = association.snapshot_id, productId = association.product_id;
      const page = await host.call('/r1/products/read', { snapshotId, productId });
      assert.equal(page.result.rows.length, 21,
        JSON.stringify({ sourceAssociations: original.currentRequest.local.associations?.length,
          sourceCurrentRequest: original.currentRequest?.state,
          returned: page.result, snapshotId, productId }).slice(0, 7000));
      const values = page.result.rows[0].values;
      const valueField = Object.keys(values).find(key => values[key].data_type === 'decimal'
        && values[key].unit?.unit_code === 'count');
      assert.ok(valueField, 'Actual registered WFD numeric field must be available from read_product');
      host.services.permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: python! } }],
        label: 'isolated WFD MA20 Polars execution', scope: { kind: 'persistent' } });
      const submitted = host.services.productionCalculation!.submit('wfd-ma20-e2e', {
        methodId: 'source_observation_ma', source: { kind: 'fixed_snapshot' },
        calculation: { version: 'bd.wfd-source-ma20/1', snapshotId, productId, valueField },
        usage: { purpose: 'current_compute' },
      });
      const computed = await host.settled(submitted.taskId);
      assert.equal(computed.status, 'succeeded', JSON.stringify(computed.error));
      const candidate = computed.result?.data as any;
      assert.equal(candidate.rows.length, 21);
      assert.equal(candidate.rows[0].calculation_status, 'warmup');
      assert.equal(candidate.rows[19].value, '10.50000000');
      assert.equal(candidate.rows[20].value, '11.50000000');
      const outcome = await host.services.productionCalculation!.publish(computed.id);
      assert.equal(outcome.published, true, JSON.stringify({
        outcome, receipt: host.services.r1!.attempt(outcome.requestId).receipt_json,
      }));
      assert.equal(outcome.fixedReadback, true);
      const state = host.services.r1!.attempt(outcome.requestId);
      assert.equal(state.state, 'associated');
      const refs = JSON.parse(String(state.local_refs_json));
      assert.equal(refs.fixedAlgorithm.kind, 'structured_polars');
      // The authoritative per-row association is stored in r1_record_associations, not
      // in a synthetic associations_json column on r1_handoff_attempts.
      const derivedAssociations = host.services.r1!.localExplanation(outcome.requestId).associations as any[];
      assert.equal(derivedAssociations.length, 21, 'R1 must associate every WFD MA20 row to its actual record version');
      const first = derivedAssociations[0];
      assert.ok(first?.snapshot_id && first?.product_id);
      assert.ok(derivedAssociations.every(row => row.snapshot_id === first.snapshot_id
        && row.product_id === first.product_id), 'One derived source series must remain one WFD product');
      const derivedReadback = await host.call('/r1/products/read', {
        snapshotId: first.snapshot_id, productId: first.product_id,
      });
      assert.equal(derivedReadback.result.rows.length, 21,
        'All 21 warmup and value rows must be queryable from the published WFD snapshot');
      assert.equal(derivedReadback.result.rows.filter((row: any) =>
        row.values.value?.value_state === 'insufficient_warmup').length, 19);
      assert.equal((await host.services.productionCalculation!.publish(computed.id)).requestId,
        outcome.requestId, 'Retry must reuse the frozen original WFD publication request');
    } finally { await host.close(); }
  });

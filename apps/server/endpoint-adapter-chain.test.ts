import assert from 'node:assert/strict';
import test from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import type { EndpointAdapterConfig } from '../../modules/collection/endpoint-adapter.js';

/**
 * 端点适配首批闭环的普通 HTTP 入口验证：上传 → 自动发现 → 候选 → 实际重放 → 受控采用
 * → 处理计划（冻结配置）→ 原五步运行 → 产物读回；并验证未采用/伪造确认/漂移隔离/重开恢复。
 * 样本为按格式对照矩阵结构构造、明确标注的合成等价响应，不是供应商真实重放。
 */
const SINA_LIKE = Buffer.from(JSON.stringify([
  { day: '2026-04-13', open: '1444.000', high: '1446.500', low: '1433.000', close: '1443.310', volume: '2521364' },
  { day: '2026-04-14', open: '1443.310', high: '1450.000', low: '1440.000', close: '1448.000', volume: '2000000' },
]), 'utf8');

const EASTMONEY_LIKE = Buffer.from(JSON.stringify({ rc: 0, rt: 4, data: {
  klines: ['2026-04-13,1444.00,1443.31,1446.50,1433.00,25214,3629675490.00',
    '2026-04-14,1443.31,1448.00,1450.00,1440.00,20000,2896000000.00'],
} }), 'utf8');

const THS_LIKE = Buffer.from('quotebridge_v6_line_hs_600519_01_last(' + JSON.stringify({
  data: '20260413,1415.98,1418.48,1404.98,1415.29,2521364,3629675500.00;20260414,1415.29,1420.00,1412.00,1419.00,2000000,2838000000.00',
}) + ')', 'utf8');

const BAD_EASTMONEY = Buffer.from(JSON.stringify({ rc: 1, data: { klines: ['2026-04-13,1,1,1,1,1,1'] } }), 'utf8');
const EXTRA_POSITION = Buffer.from(JSON.stringify({ rc: 0, data: { klines: ['2026-04-13,1444.00,1443.31,1446.50,1433.00,25214,3629675490.00,rank=1'] } }), 'utf8');
const BAD_DECIMAL = Buffer.from(JSON.stringify({ rc: 0, data: { klines: ['2026-04-13,1444.00,abc,1446.50,1433.00,25214,3629675490.00'] } }), 'utf8');
const NEWS_PAGE = Buffer.from(JSON.stringify({ code: '1', data: [{ title: 'a' }], total: 1, next_cursor: '' }), 'utf8');
const NEWS_TRUNCATED = Buffer.from(JSON.stringify({ code: '1', data: [{ title: 'a' }], total: 2, next_cursor: 'more' }), 'utf8');

const evidence = { sourceId: 'synthetic', provider: '合成等价样本', coverage: '单标的两个交易日',
  basis: '按 20261106 格式对照矩阵的载体、列序与单位结构构造的合成响应；不是供应商真实重放。' };

const sinaConfig: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'sina.kline.daily', version: '1',
  match: { endpoint: 'https://quotes.sina.example.test/CN_MarketDataService.getKLineData', protocol: 'json-array/v1', frequency: 'day', adjustment: 'none' },
  carrier: { kind: 'json', charset: 'utf-8' },
  response: { success: null, container: { path: '$', kind: 'array' } },
  fields: [
    { name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'open', source: { kind: 'key', key: 'open' }, type: 'decimal' },
    { name: 'high', source: { kind: 'key', key: 'high' }, type: 'decimal' },
    { name: 'low', source: { kind: 'key', key: 'low' }, type: 'decimal' },
    { name: 'close', source: { kind: 'key', key: 'close' }, type: 'decimal' },
    { name: 'volume', source: { kind: 'key', key: 'volume' }, type: 'integer' },
  ], evidence };

function eastmoneyConfig(version = '1', fields?: string[]): EndpointAdapterConfig {
  return { contract: 'bd.endpoint-adapter/1', adapterId: 'eastmoney.kline.daily', version,
    match: { endpoint: 'https://push2his.eastmoney.example.test/api/qt/stock/kline/get', protocol: 'json-embedded-csv/v1',
      frequency: 'day', adjustment: 'none', ...(fields ? { fields } : {}) },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: { path: 'rc', equals: '0' }, container: { path: 'data.klines', kind: 'delimited-array' },
      ignore: ['rt'] },
    fields: [
      { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' },
      { name: 'open', source: { kind: 'position', index: 1 }, type: 'decimal' },
      { name: 'close', source: { kind: 'position', index: 2 }, type: 'decimal' },
      { name: 'high', source: { kind: 'position', index: 3 }, type: 'decimal' },
      { name: 'low', source: { kind: 'position', index: 4 }, type: 'decimal' },
      { name: 'volume', source: { kind: 'position', index: 5 }, type: 'integer',
        unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送；1 手 = 100 股为本批声明的交易单位规则，未与第二来源对齐。' } },
      { name: 'amount', source: { kind: 'position', index: 6 }, type: 'decimal' },
    ], evidence };
}

const thsConfig: EndpointAdapterConfig = { contract: 'bd.endpoint-adapter/1', adapterId: 'ths.kline.daily', version: '1',
  match: { endpoint: 'https://d.10jqka.example.test/v6/line/hs_{code}/01/last.js', protocol: 'jsonp/v1', frequency: 'day', adjustment: 'qfq' },
  carrier: { kind: 'jsonp', charset: 'utf-8', callbackPrefix: 'quotebridge_v6_line_hs_', delimiter: ',', recordSeparator: ';' },
  response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
  fields: [
    { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'yyyymmdd' },
    { name: 'open', source: { kind: 'position', index: 1 }, type: 'decimal' },
    { name: 'high', source: { kind: 'position', index: 2 }, type: 'decimal' },
    { name: 'low', source: { kind: 'position', index: 3 }, type: 'decimal' },
    { name: 'close', source: { kind: 'position', index: 4 }, type: 'decimal' },
    { name: 'volume', source: { kind: 'position', index: 5 }, type: 'integer' },
    { name: 'amount', source: { kind: 'position', index: 6 }, type: 'decimal' },
  ], evidence };

async function materialFor(host: FullChainHost, name: string, bytes: Buffer, requestId: string): Promise<string> {
  const uploaded = await host.upload(name, 'data', bytes, requestId);
  const intake = await host.settled(uploaded.jobId);
  assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
  return host.services.materials!.getByTask(intake.id)!.envelope.materialId;
}

/** TaskError 在普通入口映射为 409；这里同时核对失败码，避免只凭状态断言。 */
async function rejected(host: FullChainHost, path: string, body: unknown, code: string) {
  const value = await host.call(path, body, 409);
  assert.equal(value.code, code, JSON.stringify(value));
  return value;
}

async function adopt(host: FullChainHost, adapterId: string, version: string, positive: string[], negative: string[], label: string) {
  const replay = await host.call(`/processing/adapters/${adapterId}/${version}/replay`, { requestId: `${label}-replay`,
    input: { adapterId, version, samples: [...positive.map(materialId => ({ materialId, expectation: 'accept' })),
      ...negative.map(materialId => ({ materialId, expectation: 'reject' }))] } });
  assert.equal(replay.passed, true, JSON.stringify(replay.results));
  const adopted = await host.call(`/processing/adapters/${adapterId}/${version}/adopt`, { requestId: `${label}-adopt`,
    input: { adapterId, version, evidenceDigest: replay.evidenceDigest, confirmationDigest: replay.evidenceDigest } });
  assert.equal(adopted.status, 'adopted');
  return { replay, adopted };
}

test('端点适配首批闭环：三载体经普通 HTTP 入口进入原五步，并验证采用门禁、漂移隔离与重开恢复', { skip:
  !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT 指向本轮新建的隔离根' }, async () => {
  const fixture = createFullChainFixture({ name: 'adapter-chain' });
  const host = await openFullChainHost(fixture);
  let closed = false;
  try {
    const sinaId = await materialFor(host, 'sina-kline.json', SINA_LIKE, 'sina-upload');
    const eastmoneyId = await materialFor(host, 'eastmoney-kline.json', EASTMONEY_LIKE, 'eastmoney-upload');
    const thsId = await materialFor(host, 'ths-kline.js', THS_LIKE, 'ths-upload');
    const badId = await materialFor(host, 'eastmoney-failed.json', BAD_EASTMONEY, 'bad-upload');
    const extraPositionId = await materialFor(host, 'eastmoney-extra.json', EXTRA_POSITION, 'extra-upload');
    const badDecimalId = await materialFor(host, 'eastmoney-bad-decimal.json', BAD_DECIMAL, 'bad-decimal-upload');
    const newsPageId = await materialFor(host, 'news-page.json', NEWS_PAGE, 'news-page-upload');
    const newsTruncatedId = await materialFor(host, 'news-truncated.json', NEWS_TRUNCATED, 'news-truncated-upload');

    // 自动发现只返回候选，不落库、不采用。
    const discovery = await host.call('/processing/adapters/discover', { requestId: 'discover-eastmoney',
      input: { materialId: eastmoneyId, adapterId: 'eastmoney.kline.daily', version: '1',
        endpoint: 'https://push2his.eastmoney.example.test/api/qt/stock/kline/get', sourceId: 'eastmoney',
        provider: '合成等价样本', coverage: '单标的两个交易日' } });
    assert.equal(discovery.status, 'candidate');
    assert.equal(discovery.persisted, false);
    assert.equal((await host.call('/processing/adapters/versions')).items.length, 0);

    for (const [value, requestId] of [[sinaConfig, 'candidate-sina'], [eastmoneyConfig(), 'candidate-eastmoney'],
      [thsConfig, 'candidate-ths']] as const) {
      const created = await host.call('/processing/adapters/candidates', { requestId, input: { config: value } }, 201);
      assert.equal(created.status, 'candidate');
    }
    const catalog = await host.call('/processing/adapters/versions');
    assert.equal(catalog.items.length, 3);

    // 未重放即采用、只重放正样本即采用、摘要不符、正文自报授权：全部拒绝。
    await rejected(host, '/processing/adapters/eastmoney.kline.daily/1/adopt', { requestId: 'adopt-too-early',
      input: { adapterId: 'eastmoney.kline.daily', version: '1', evidenceDigest: 'a'.repeat(64), confirmationDigest: 'a'.repeat(64) } },
      'ADAPTER_REPLAY_REQUIRED');
    await rejected(host, '/processing/adapters/candidates', { requestId: 'forged-authority',
      input: { config: sinaConfig, authorized: true } }, 'ADAPTER_INPUT');
    const partial = await host.call('/processing/adapters/eastmoney.kline.daily/1/replay', { requestId: 'replay-partial',
      input: { adapterId: 'eastmoney.kline.daily', version: '1', samples: [{ materialId: eastmoneyId, expectation: 'accept' }] } });
    assert.equal(partial.passed, true);
    await rejected(host, '/processing/adapters/eastmoney.kline.daily/1/adopt', { requestId: 'adopt-partial',
      input: { adapterId: 'eastmoney.kline.daily', version: '1', evidenceDigest: partial.evidenceDigest,
        confirmationDigest: partial.evidenceDigest } }, 'ADAPTER_REPLAY_INCOMPLETE');
    await rejected(host, '/processing/adapters/eastmoney.kline.daily/1/adopt', { requestId: 'adopt-wrong-digest',
      input: { adapterId: 'eastmoney.kline.daily', version: '1', evidenceDigest: partial.evidenceDigest, confirmationDigest: 'b'.repeat(64) } },
      'ADAPTER_CONFIRMATION_REQUIRED');

    const eastmoney = await adopt(host, 'eastmoney.kline.daily', '1', [eastmoneyId], [badId], 'eastmoney');
    const sina = await adopt(host, 'sina.kline.daily', '1', [sinaId], [badId], 'sina');
    const ths = await adopt(host, 'ths.kline.daily', '1', [thsId], [badId], 'ths');

    const planInput = (outputId: string, materialId: string, binding: { adapterId: string; version?: string; configDigest?: string },
      fieldMapping?: Record<string, string>, sourceContext?: Record<string, unknown>) => ({
      routing: { materials: [{ materialId }] },
      outputs: [{ outputId, materialIds: [materialId], intendedAction: 'inspect',
        tables: [{ materialId, format: 'json', sourceAdapter: binding, ...(fieldMapping ? { fieldMapping } : {}),
          ...(sourceContext ? { sourceContext } : {}) }] }],
    });
    const bind = (configDigest: string, adapterId: string, version = '1') => ({ adapterId, version, configDigest });

    // 未采用版本不能进入计划。
    await rejected(host, '/processing/plans', { requestId: 'plan-unadopted',
      input: planInput('observations', eastmoneyId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily', '2')) },
      'ADAPTER_NOT_ADOPTED');

    const run = async (requestId: string, materialId: string,
      binding: { adapterId: string; version?: string; configDigest?: string }, fieldMapping?: Record<string, string>,
      sourceContext?: Record<string, unknown>) => {
      const prepared = await host.call('/processing/plans', { requestId: `${requestId}-plan`,
        input: planInput('observations', materialId, binding, fieldMapping, sourceContext) }, 202);
      const planned = await host.settled(prepared.jobId);
      assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
      const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
      const started = await host.call(`/processing/plans/${planId}/run`, { requestId: `${requestId}-run` }, 202);
      const done = await host.settled(started.jobId);
      return { planId, done, plan: host.services.processing!.get(planId) };
    };

    const eastmoneyRun = await run('eastmoney', eastmoneyId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'));
    assert.equal(eastmoneyRun.done.status, 'succeeded', JSON.stringify(eastmoneyRun.done.error));
    assert.equal(eastmoneyRun.plan.status, 'completed');
    assert.equal(eastmoneyRun.plan.outputs[0]!.state, 'structured');
    const parseStep = eastmoneyRun.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!;
    assert.match(parseStep.implementation, /^bd-source-parsers\/3:endpoint:eastmoney\.kline\.daily:1:[a-f0-9]{12}$/u);
    assert.equal((parseStep.parameters as any).sourceAdapter.configDigest, eastmoney.adopted.configDigest);
    const parseArtifact = await host.call(`/processing/plans/${eastmoneyRun.planId}/steps/${parseStep.stepId}/artifact`);
    assert.equal(parseArtifact.adapter_evidence.adapter_id, 'eastmoney.kline.daily');
    assert.equal(parseArtifact.adapter_evidence.config_digest, eastmoney.adopted.configDigest);
    assert.deepEqual(parseArtifact.adapter_evidence.conversions, [{ field: 'volume', source: 'lot', target: 'share', factor: '100',
      basis: '来源按手报送；1 手 = 100 股为本批声明的交易单位规则，未与第二来源对齐。', applied: 2 }]);
    const volumeCell = parseArtifact.rows[0]![parseArtifact.columns.indexOf('volume')]!;
    // 原值仍是来源词面 25214（手），换算值单独保存为 2521400（股），依据逐格保留。
    assert.equal(volumeCell.original, '25214');
    assert.equal(volumeCell.value, '2521400');
    assert.equal(volumeCell.quote, '25214');
    assert.deepEqual(volumeCell.conversion, { source: 'lot', target: 'share', factor: '100',
      basis: '来源按手报送；1 手 = 100 股为本批声明的交易单位规则，未与第二来源对齐。' });
    assert.ok(volumeCell.location.start > 0);
    // 原词面在解析产物中保留；结构步骤只做显式十进制规范化（去尾零），并逐项记录为 decimal_lexeme 变更。
    const openCell = parseArtifact.rows[0]![parseArtifact.columns.indexOf('open')]!;
    assert.equal(openCell.original, '1444.00');
    const structureStep = eastmoneyRun.plan.steps.find((step: { kind: string }) => step.kind === 'structure')!;
    assert.ok((structureStep.normalization as any).decimal_lexeme_changes_total > 0);
    const rows = await host.call(`/processing/plans/${eastmoneyRun.planId}/outputs/observations/artifact`);
    assert.deepEqual(rows.rows[0], { trade_date: '2026-04-13', open: '1444', close: '1443.31', high: '1446.5',
      low: '1433', volume: 2521400, amount: '3629675490' });

    // R2b：仅用合法 sourceAdapter + fieldMapping 时，类型与换算按映射后的名称贯通五步。
    const mappedRun = await run('mapped', eastmoneyId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'), { volume: 'quantity' });
    assert.equal(mappedRun.plan.status, 'completed', JSON.stringify(mappedRun.plan.outputs[0]?.gaps));
    const mappedRows = await host.call(`/processing/plans/${mappedRun.planId}/outputs/observations/artifact`);
    assert.equal(mappedRows.rows[0].quantity, 2521400);
    assert.equal(Object.hasOwn(mappedRows.rows[0], 'volume'), false);
    const mappedParse = await host.call(`/processing/plans/${mappedRun.planId}/steps/${
      mappedRun.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!.stepId}/artifact`);
    // 证据按配置字段身份记录换算；单元格按映射后名称保留原值与逐格依据。
    assert.deepEqual(mappedParse.adapter_evidence.conversions.map((conversion: { field: string }) => conversion.field), ['volume']);
    const mappedVolume = mappedParse.rows[0][mappedParse.columns.indexOf('quantity')];
    assert.equal(mappedVolume.original, '25214');
    assert.equal(mappedVolume.value, '2521400');
    assert.equal(mappedVolume.conversion.factor, '100');

    // R7c：没有本材料取得回执时结构解析照常，但适配匹配未核，输出不进入 ready_candidate。
    assert.equal(eastmoneyRun.plan.outputs[0]!.routingState, 'needs_adapter', JSON.stringify(eastmoneyRun.plan.outputs[0]!.gaps));
    assert.equal(eastmoneyRun.plan.outputs[0]!.publishEligible, false);
    const eastmoneySha = host.services.materials!.get(eastmoneyId).envelope.sha256;
    const receiptContext = { kind: 'synthetic', url: 'https://push2his.eastmoney.example.test/api/qt/stock/kline/get',
      materialSha256: eastmoneySha, observedAt: '2026-11-06T00:00:00Z', protocol: 'json-embedded-csv/v1',
      frequency: 'day', adjustment: 'none', basis: '合成等价样本，不是供应商实际下载回执；仅用于匹配门验证。' };
    const verifiedRun = await run('verified-context', eastmoneyId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'),
      undefined, receiptContext);
    assert.equal(verifiedRun.plan.outputs[0]!.routingState !== 'needs_adapter', true,
      JSON.stringify(verifiedRun.plan.outputs[0]!.gaps));
    // 回执绑定的材料摘要不符：整份计划拒绝，不按其他材料回执匹配。
    await rejected(host, '/processing/plans', { requestId: 'forged-context',
      input: planInput('observations', eastmoneyId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'), undefined,
        { ...receiptContext, materialSha256: host.services.materials!.get(thsId).envelope.sha256 }) }, 'ADAPTER_CONTEXT_MATERIAL');

    const sinaRun = await run('sina', sinaId, bind(sina.adopted.configDigest, 'sina.kline.daily'));
    const thsRun = await run('ths', thsId, bind(ths.adopted.configDigest, 'ths.kline.daily'));
    assert.equal(sinaRun.plan.status, 'completed');
    assert.equal(thsRun.plan.status, 'completed');
    const thsRows = await host.call(`/processing/plans/${thsRun.planId}/outputs/observations/artifact`);
    // 前复权口径与不复权来源不同；成交量按来源原值保留，36 股差额不被抹平。
    assert.equal(thsRows.rows[0].close, '1415.29');
    assert.equal(thsRows.rows[0].volume, 2521364);
    const sinaRows = await host.call(`/processing/plans/${sinaRun.planId}/outputs/observations/artifact`);
    assert.equal(sinaRows.rows[0].close, '1443.31');

    // R3/R5：整组证据中任一样本不符期望（含坏数值被期望为接受）即不可采用，状态保持 candidate。
    await host.call('/processing/adapters/candidates', { requestId: 'candidate-eastmoney-v3', input: { config: eastmoneyConfig('3') } }, 201);
    const badGroup = await host.call('/processing/adapters/eastmoney.kline.daily/3/replay', { requestId: 'replay-bad-group',
      input: { adapterId: 'eastmoney.kline.daily', version: '3', samples: [
        { materialId: eastmoneyId, expectation: 'accept', expect: { rowCount: 2, values: { close: '1443.31', volume: '2521400' } } },
        { materialId: badId, expectation: 'reject' },
        { materialId: badId, expectation: 'accept' },
        { materialId: badDecimalId, expectation: 'accept' },
      ] } });
    assert.equal(badGroup.passed, false);
    assert.deepEqual(badGroup.results.map((result: { passed: boolean }) => result.passed), [true, true, false, false]);
    assert.equal(badGroup.results[3].code, 'ADAPTER_TYPE');
    await rejected(host, '/processing/adapters/eastmoney.kline.daily/3/adopt', { requestId: 'adopt-bad-group',
      input: { adapterId: 'eastmoney.kline.daily', version: '3', evidenceDigest: badGroup.evidenceDigest,
        confirmationDigest: badGroup.evidenceDigest } }, 'ADAPTER_REPLAY_FAILED');
    assert.equal((await host.call('/processing/adapters/versions')).items
      .find((item: { adapterId: string; version: string }) => item.adapterId === 'eastmoney.kline.daily' && item.version === '3').status, 'candidate');

    // R5b：期望核对与执行结论分离；反样本不能携带期望值冒充真实拒绝，越界期望只影响 passed。
    await rejected(host, '/processing/adapters/eastmoney.kline.daily/3/replay', { requestId: 'replay-forged-reject',
      input: { adapterId: 'eastmoney.kline.daily', version: '3', samples: [
        { materialId: eastmoneyId, expectation: 'reject', expect: { values: { close: '1443.31' } } }] } }, 'ADAPTER_REPLAY');
    const outOfRange = await host.call('/processing/adapters/eastmoney.kline.daily/3/replay', { requestId: 'replay-out-of-range',
      input: { adapterId: 'eastmoney.kline.daily', version: '3', samples: [
        { materialId: eastmoneyId, expectation: 'accept', expect: { row: 5, values: { close: '1443.31' } } }] } });
    assert.equal(outOfRange.results[0].outcome, 'accept');
    assert.equal(outOfRange.results[0].passed, false);
    assert.ok(outOfRange.results[0].mismatch[0].includes('不存在'));

    // R6：分隔记录多出未声明位置时，加工步骤定向失败并记录漂移，不静默丢弃。
    const extraRun = await run('extra-position', extraPositionId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'));
    assert.equal(extraRun.plan.status, 'failed');
    assert.match(JSON.stringify(extraRun.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!.gaps), /ADAPTER_EXTRA_POSITIONS/u);

    // R9：分页未闭合的样本必须经实际适配解析明确拒绝。
    const newsConfig = { contract: 'bd.endpoint-adapter/1' as const, adapterId: 'eastmoney.news.list', version: '1',
      match: { endpoint: 'https://np-listapi.eastmoney.example.test/comm/web/getNewsByColumns', protocol: 'json/v1',
        frequency: 'event' as const, adjustment: 'none' as const },
      carrier: { kind: 'json' as const, charset: 'utf-8' as const },
      response: { success: { path: 'code', equals: '1' }, container: { path: 'data', kind: 'array' as const },
        pagination: { totalPath: 'total', cursorPath: 'next_cursor' } },
      fields: [{ name: 'title', source: { kind: 'key' as const, key: 'title' }, type: 'text' as const }],
      evidence };
    await host.call('/processing/adapters/candidates', { requestId: 'candidate-news', input: { config: newsConfig } }, 201);
    const news = await adopt(host, 'eastmoney.news.list', '1', [newsPageId], [newsTruncatedId], 'news');
    const newsRun = await run('news-complete', newsPageId, bind(news.adopted.configDigest, 'eastmoney.news.list'));
    assert.equal(newsRun.plan.status, 'completed');
    const newsRows = await host.call(`/processing/plans/${newsRun.planId}/outputs/observations/artifact`);
    assert.equal(newsRows.rows.length, 1);
    assert.equal(newsRows.rows[0].title, 'a');
    const truncated = await run('news-truncated', newsTruncatedId, bind(news.adopted.configDigest, 'eastmoney.news.list'));
    assert.equal(truncated.plan.status, 'failed');
    const truncatedParse = truncated.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!;
    assert.match(JSON.stringify(truncatedParse.gaps), /ADAPTER_PAGINATION_INCOMPLETE/u);

    // 漂移：已采用配置遇到不同载体，步骤定向失败并记录原因；不回退其他版本。
    const drifted = await run('drift', thsId, bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily'));
    // 步骤失败按原计划记录：任务收束，计划与解析步骤为 failed，不回退其他版本。
    assert.equal(drifted.plan.status, 'failed');
    assert.equal(drifted.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!.state, 'failed');
    const exceptions = await host.call('/processing/adapters/exceptions');
    assert.ok(exceptions.items.some((item: { adapterId: string; code: string; materialId: string }) =>
      item.adapterId === 'eastmoney.kline.daily' && item.materialId === thsId
      && ['ADAPTER_SUCCESS_MISSING', 'ADAPTER_CONTAINER', 'ADAPTER_CARRIER', 'ADAPTER_JSON'].includes(item.code)),
    JSON.stringify(exceptions.items));

    // 新版本只影响新计划：v2 采用后，v1 计划仍按冻结配置与摘要读回。
    await host.call('/processing/adapters/candidates', { requestId: 'candidate-eastmoney-v2',
      input: { config: eastmoneyConfig('2', ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57', 'f58']) } }, 201);
    const v2 = await adopt(host, 'eastmoney.kline.daily', '2', [eastmoneyId], [badId], 'eastmoney-v2');
    const reloaded = host.services.processing!.get(eastmoneyRun.planId);
    assert.equal(reloaded.planDigest, eastmoneyRun.plan.planDigest);
    assert.equal((reloaded.steps.find((step: { kind: string }) => step.kind === 'parse')!.parameters as any).sourceAdapter.configDigest,
      eastmoney.adopted.configDigest);
    const v2Run = await run('eastmoney-v2', eastmoneyId, { adapterId: 'eastmoney.kline.daily' });
    assert.equal(v2Run.plan.status, 'completed');
    const currentParse = v2Run.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!;
    assert.equal((currentParse.parameters as any).sourceAdapter.version, '2',
      '稳定接口只指定适配器编号，使用当前生效配置');
    assert.equal((currentParse.parameters as any).sourceAdapter.configDigest, v2.adopted.configDigest);
    const currentRows = host.services.endpointAdapters!.list('eastmoney.kline.daily') as any[];
    assert.equal(currentRows.filter(row => row.status === 'adopted').length, 1,
      '同一适配器只有当前实现可供新任务使用');
    assert.equal(currentRows.find(row => row.version === '1')?.status, 'retired');
    await rejected(host, '/processing/plans', { requestId: 'reject-retired-adapter',
      input: planInput('observations', eastmoneyId,
        bind(eastmoney.adopted.configDigest, 'eastmoney.kline.daily', '1')) }, 'ADAPTER_NOT_ADOPTED');
    assert.notEqual(v2Run.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!.specDigest,
      eastmoneyRun.plan.steps.find((step: { kind: string }) => step.kind === 'parse')!.specDigest);

    // 重开恢复：同一运行根重开服务后，原计划与产物仍按原身份读回。
    const planId = eastmoneyRun.planId, digest = eastmoneyRun.plan.planDigest;
    await host.close(); closed = true;
    const reopened = await openFullChainHost(fixture);
    try {
      const plan = reopened.services.processing!.get(planId);
      assert.equal(plan.planDigest, digest);
      assert.equal(plan.status, 'completed');
      assert.deepEqual(plan.steps.filter((step: { kind: string }) => step.kind === 'parse').map((step: { state: string }) => step.state), ['succeeded']);
      const artifact = await reopened.call(`/processing/plans/${planId}/outputs/observations/artifact`);
      assert.equal(artifact.rows[0].close, '1443.31');
    } finally { await reopened.close(); }
  } catch (error) {
    if (!closed) await host.close().catch(() => {});
    throw error;
  }
});

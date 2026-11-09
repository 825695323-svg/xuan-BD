import assert from 'node:assert/strict';
import test from 'node:test';
import iconv from 'iconv-lite';
import { TaskError } from '../../platform/jobs/tasks.js';
import { adapterConfigDigest, discoverEndpointAdapter, matchAdapterContext, parseEndpointSource,
  readAdapterSourceContext, readEndpointAdapterConfig, scaleDecimalExact, type EndpointAdapterConfig } from './endpoint-adapter.js';
import { parseTableSource } from './candidate-pipeline.js';
import { EndpointAdapterRegistry, readSourceReceiptFromTask } from './endpoint-adapter-registry.js';
import { CoreDatabase } from '../../platform/state/database.js';

const failCode = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) =>
  error instanceof TaskError && error.code === code, `期望失败码 ${code}`);

function base(overrides: Partial<EndpointAdapterConfig> = {}): EndpointAdapterConfig {
  return readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.daily', version: '1',
    match: { endpoint: 'https://example.test/kline', protocol: 'json/v1', frequency: 'day', adjustment: 'none' },
    carrier: { kind: 'json', charset: 'utf-8' },
    response: { success: null, container: { path: '$', kind: 'array' } },
    fields: [
      { name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
      { name: 'open', source: { kind: 'key', key: 'open' }, type: 'decimal' },
      { name: 'high', source: { kind: 'key', key: 'high' }, type: 'decimal' },
      { name: 'low', source: { kind: 'key', key: 'low' }, type: 'decimal' },
      { name: 'close', source: { kind: 'key', key: 'close' }, type: 'decimal' },
      { name: 'volume', source: { kind: 'key', key: 'volume' }, type: 'integer' },
    ],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于算子等价性测试的合成响应。' },
    ...overrides,
  });
}

const SINA_LIKE = Buffer.from(JSON.stringify([
  { day: '2026-04-13', open: '1444.000', high: '1446.500', low: '1433.000', close: '1443.310', volume: '2521364' },
]), 'utf8');

const EASTMONEY_LIKE = Buffer.from(JSON.stringify({ rc: 0, rt: 4, data: {
  klines: ['2026-04-13,1444.00,1443.31,1446.50,1433.00,25214,3629675490.00'],
} }), 'utf8');

const THS_LIKE = Buffer.from('quotebridge_v6_line_hs_600519_01_last(' + JSON.stringify({
  data: '20260413,1415.98,1418.48,1404.98,1415.29,2521364,3629675500.00',
}) + ')', 'utf8');

function eastmoneyConfig(): EndpointAdapterConfig {
  return readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'eastmoney.kline.daily', version: '1',
    match: { endpoint: 'https://push2his.example.test/api/qt/stock/kline/get', protocol: 'json-embedded-csv/v1',
      frequency: 'day', adjustment: 'none', fields: ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57'] },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: { path: 'rc', equals: '0' }, container: { path: 'data.klines', kind: 'delimited-array' }, ignore: ['rt'] },
    fields: [
      { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' },
      { name: 'open', source: { kind: 'position', index: 1 }, type: 'decimal' },
      { name: 'close', source: { kind: 'position', index: 2 }, type: 'decimal' },
      { name: 'high', source: { kind: 'position', index: 3 }, type: 'decimal' },
      { name: 'low', source: { kind: 'position', index: 4 }, type: 'decimal' },
      { name: 'volume', source: { kind: 'position', index: 5 }, type: 'integer',
        unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送，交易单位规则 1 手 = 100 股（本次仅按该声明换算，未与第二来源对齐）。' } },
      { name: 'amount', source: { kind: 'position', index: 6 }, type: 'decimal' },
    ],
    evidence: { sourceId: 'eastmoney', provider: '合成样本', coverage: '单日单标的', basis: '按格式对照矩阵的载体与列序构造的合成等价样本。' },
  });
}

function thsConfig(): EndpointAdapterConfig {
  return readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'ths.kline.daily', version: '1',
    match: { endpoint: 'https://d.10jqka.example.test/v6/line/hs_{code}/01/last.js', protocol: 'jsonp/v1',
      frequency: 'day', adjustment: 'qfq' },
    carrier: { kind: 'jsonp', charset: 'utf-8', callbackPrefix: 'quotebridge_v6_line_hs_', recordSeparator: ';', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [
      { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'yyyymmdd' },
      { name: 'open', source: { kind: 'position', index: 1 }, type: 'decimal' },
      { name: 'high', source: { kind: 'position', index: 2 }, type: 'decimal' },
      { name: 'low', source: { kind: 'position', index: 3 }, type: 'decimal' },
      { name: 'close', source: { kind: 'position', index: 4 }, type: 'decimal' },
      { name: 'volume', source: { kind: 'position', index: 5 }, type: 'integer' },
      { name: 'amount', source: { kind: 'position', index: 6 }, type: 'decimal' },
    ],
    evidence: { sourceId: 'ths', provider: '合成样本', coverage: '单日单标的', basis: '按格式对照矩阵的 JSONP 与分号分行结构构造的合成等价样本。' },
  });
}

test('同一算子按三份声明式配置解析三种载体，产出同一标准列与各自原值', () => {
  const sina = parseEndpointSource(SINA_LIKE, base());
  const eastmoney = parseEndpointSource(EASTMONEY_LIKE, eastmoneyConfig());
  const ths = parseEndpointSource(THS_LIKE, thsConfig());
  assert.deepEqual(sina.columns, ['trade_date', 'open', 'high', 'low', 'close', 'volume']);
  assert.deepEqual(eastmoney.columns, ['trade_date', 'open', 'close', 'high', 'low', 'volume', 'amount']);
  assert.deepEqual(ths.columns, ['trade_date', 'open', 'high', 'low', 'close', 'volume', 'amount']);
  const cell = (result: ReturnType<typeof parseEndpointSource>, column: string) =>
    result.rows[0]![result.columns.indexOf(column)]!.value;
  assert.equal(cell(sina, 'close'), '1443.310');
  assert.equal(cell(eastmoney, 'close'), '1443.31');
  assert.equal(cell(ths, 'close'), '1415.29');
  // 量：东财按手×100 精确换算为股；原值仍是 25214 手，与同花顺股数相差 36 股，按材料校正不得抹平。
  assert.equal(cell(eastmoney, 'volume'), '2521400');
  assert.equal(eastmoney.rows[0]![eastmoney.columns.indexOf('volume')]!.original, '25214');
  assert.equal(cell(ths, 'volume'), '2521364');
  assert.equal(Number(cell(eastmoney, 'volume')) - Number(cell(ths, 'volume')), 36);
  assert.equal(cell(eastmoney, 'amount'), '3629675490.00');
  assert.equal(eastmoney.carrier.kind, 'json-embedded-delimited');
  assert.equal(ths.carrier.kind, 'jsonp');
  assert.equal(ths.success, null);
  assert.deepEqual(eastmoney.success, { path: 'rc', expected: '0', actual: '0' });
  assert.equal(ths.decoded.losslessRoundTrip, true);
});

test('单位换算证据逐字段保存系数与依据，未声明换算的字段保持原词面', () => {
  const result = parseEndpointSource(EASTMONEY_LIKE, eastmoneyConfig());
  assert.deepEqual(result.conversions, [{ field: 'volume', source: 'lot', target: 'share', factor: '100',
    basis: '来源按手报送，交易单位规则 1 手 = 100 股（本次仅按该声明换算，未与第二来源对齐）。', applied: 1 }]);
  const close = result.rows[0]![result.columns.indexOf('close')]!;
  assert.equal(close.original, '1443.31');
  assert.equal(close.value, '1443.31');
  assert.equal(close.quote, '1443.31');
  const volume = result.rows[0]![result.columns.indexOf('volume')]!;
  assert.equal(volume.original, '25214');
  assert.equal(volume.value, '2521400');
  assert.equal(volume.quote, '25214');
  assert.ok(volume.location.start > 0);
  assert.ok(result.gaps.some(gap => gap.includes('位置映射')));
  assert.ok(result.gaps.some(gap => gap.includes('复权口径')));
});

test('十进制换算是精确串运算，不经过二进制浮点', () => {
  assert.equal(scaleDecimalExact('25214', '100'), '2521400');
  assert.equal(scaleDecimalExact('0.1', '3'), '0.3');
  assert.equal(scaleDecimalExact('1.005', '100'), '100.5');
  assert.equal(scaleDecimalExact('-2.50', '100'), '-250');
  assert.notEqual(0.1 * 3, 0.3); // 对照：浮点路径会产生 0.30000000000000004
  failCode(() => scaleDecimalExact('abc', '100'), 'ADAPTER_NUMBER');
});

test('坏编码、畸形封装、成功判定不符、额外维度都定向失败，不补值不猜测', () => {
  const gbkBytes = iconv.encode('var hq_str_sh600519="贵州茅台,1450.000";', 'gbk');
  const gbkConfig = base({ carrier: { kind: 'js-variable-assignment', charset: 'gbk', variablePrefix: 'hq_str_', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [{ name: 'name', source: { kind: 'position', index: 0 }, type: 'text' }] });
  // 以 UTF-8 声明读取 GBK 原件：严格解码失败，不替换非法字节。
  failCode(() => parseEndpointSource(gbkBytes, { ...gbkConfig, carrier: { ...gbkConfig.carrier, charset: 'utf-8' } }), 'ADAPTER_CHARSET');
  // 变量赋值的字符串不是 JSON 对象：按受控 JSON 读取失败，不执行脚本。
  failCode(() => parseEndpointSource(gbkBytes, gbkConfig), 'ADAPTER_JSON');
  const escaped = Buffer.from('var hq_str_sh600519="{\\"data\\":\\"1\\"}";', 'utf8');
  const jsConfig = base({ carrier: { kind: 'js-variable-assignment', charset: 'utf-8', variablePrefix: 'hq_str_', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [{ name: 'value', source: { kind: 'position', index: 0 }, type: 'text' }] });
  const jsResult = parseEndpointSource(escaped, jsConfig);
  assert.equal(jsResult.carrier.scope, 'decoded-string');
  assert.equal(jsResult.rows[0]![0]!.original, '1');
  // JSONP 函数名不在声明前缀内：拒绝执行或猜测。
  failCode(() => parseEndpointSource(THS_LIKE, readEndpointAdapterConfig({ ...thsConfig(), carrier: {
    kind: 'jsonp', charset: 'utf-8', callbackPrefix: 'other_callback_', delimiter: ',', recordSeparator: ';' } })), 'ADAPTER_CARRIER');
  // 成功判定不符：隔离该响应，不当成功解析。
  const failed = Buffer.from(JSON.stringify({ rc: 1, data: { klines: ['2026-04-13,1,1,1,1,1,1'] } }), 'utf8');
  failCode(() => parseEndpointSource(failed, eastmoneyConfig()), 'ADAPTER_SUCCESS_MISMATCH');
  // 缺少记录容器：配置漂移，不回退其他结构。
  failCode(() => parseEndpointSource(Buffer.from(JSON.stringify({ rc: 0, data: {} }), 'utf8'), eastmoneyConfig()), 'ADAPTER_CONTAINER');
  // 额外业务维度：不得静默丢弃。
  const extra = Buffer.from(JSON.stringify([{ day: '2026-04-13', open: '1', close: '2', volume: '3', 榜单类型: '涨停池' }]), 'utf8');
  failCode(() => parseEndpointSource(extra, base()), 'ADAPTER_EXTRA_FIELDS');
});

test('缺字段进入五步时保留缺键事实并阻断，不自动补 null', () => {
  const bytes = Buffer.from(JSON.stringify([
    { day: '2026-04-13', open: '1444.000', close: '1443.310', volume: '2521364' },
    { day: '2026-04-14', open: '1444.000', volume: '2521364' },
  ]), 'utf8');
  const config = base();
  assert.throws(() => parseTableSource(bytes, { materialId: 'm1', format: 'json',
    sourceAdapter: { adapterId: config.adapterId, version: config.version, configDigest: adapterConfigDigest(config), config } }),
  (error: unknown) => error instanceof TaskError && error.code === 'CANDIDATE_MISSING_KEY');
});

test('配置拒绝无依据的单位换算、未知键、重复位置', () => {
  const withoutBasis = { ...base(), fields: [{ name: 'close', source: { kind: 'key', key: 'close' }, type: 'decimal',
    unit: { source: 'lot', target: 'share', factor: '100', basis: '短' } }] };
  failCode(() => readEndpointAdapterConfig(withoutBasis), 'ADAPTER_CONFIG');
  failCode(() => readEndpointAdapterConfig({ ...base(), extra: true }), 'ADAPTER_CONFIG');
  failCode(() => readEndpointAdapterConfig({ ...base(), fields: [
    { name: 'a', source: { kind: 'position', index: 0 }, type: 'text' },
    { name: 'b', source: { kind: 'position', index: 0 }, type: 'text' }] }), 'ADAPTER_CONFIG');
  failCode(() => readEndpointAdapterConfig({ ...base(), carrier: { kind: 'jsonp', charset: 'utf-8' } }), 'ADAPTER_CONFIG');
});

test('自动发现只生成候选，不产生已采用版本', () => {
  const proposal = discoverEndpointAdapter(EASTMONEY_LIKE, { adapterId: 'discovered.kline', version: '1',
    endpoint: 'https://push2his.example.test/api/qt/stock/kline/get', sourceId: 'eastmoney', provider: '合成样本', coverage: '单日单标的' });
  assert.equal(proposal.status, 'candidate');
  assert.equal(proposal.config.carrier.kind, 'json-embedded-delimited');
  assert.equal(proposal.config.response.container.path, 'data.klines');
  assert.equal(proposal.config.match.adjustment, 'unknown');
  assert.ok(proposal.gaps.some(gap => gap.includes('字段名与类型须按来源文档逐项命名')));
  // 候选配置本身仍须通过严格读取，且没有采用状态可被解析路径接受。
  assert.equal(readEndpointAdapterConfig(proposal.config).adapterId, 'discovered.kline');
});

test('单位换算保留载体原值，换算值单独成为 value，并逐格记录依据', () => {
  const config = base({ fields: [
    { name: 'trade_date', source: { kind: 'key', key: 'day' }, type: 'text', timeFormat: 'iso-date' },
    { name: 'qty', source: { kind: 'key', key: 'qty' }, type: 'decimal',
      unit: { source: 'lot', target: 'share', factor: '100', basis: '来源按手报送；1 手 = 100 股为本次声明规则，未与第二来源对齐。' } },
  ] });
  const bytes = Buffer.from(JSON.stringify([{ day: '2026-04-13', qty: '1.25' }]), 'utf8');
  const parsed = parseTableSource(bytes, { materialId: 'm-qty', format: 'json',
    sourceAdapter: { adapterId: config.adapterId, version: config.version, configDigest: adapterConfigDigest(config), config } });
  const cell = parsed.rows[0]![parsed.columns.indexOf('qty')]!;
  assert.equal(cell.original, '1.25');
  assert.equal(cell.value, '125');
  assert.equal(cell.quote, '"1.25"');
  assert.deepEqual(cell.conversion, { source: 'lot', target: 'share', factor: '100',
    basis: '来源按手报送；1 手 = 100 股为本次声明规则，未与第二来源对齐。' });
});

test('重放同源校验：缺字段、坏 decimal、无效时间写法都不能成为通过样本', () => {
  const config = base();
  const plan = (bytes: Uint8Array) => ({ materialId: 'm-check', format: 'json' as const,
    sourceAdapter: { adapterId: config.adapterId, version: config.version, configDigest: adapterConfigDigest(config), config } });
  failCode(() => parseTableSource(Buffer.from(JSON.stringify([{ day: '2026-04-13', open: '1', close: '2' }]), 'utf8'), plan(new Uint8Array())), 'CANDIDATE_MISSING_KEY');
  // 坏数值在解析阶段就按配置声明的十进制类型拒绝，重放与生产五步使用同一门。
  const badDecimal = Buffer.from(JSON.stringify([{ day: '2026-04-13', open: '1', high: '1', low: '1', close: 'abc', volume: '1' }]), 'utf8');
  failCode(() => parseTableSource(badDecimal, plan(badDecimal)), 'ADAPTER_TYPE');
  const badTime = Buffer.from(JSON.stringify([{ day: '2026-13-40', open: '1', high: '1', low: '1', close: '2', volume: '1' }]), 'utf8');
  failCode(() => parseTableSource(badTime, plan(badTime)), 'ADAPTER_TIME');
});

test('分隔记录中间未声明位置同样阻断，不按末尾宽度放过', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.gap', version: '1',
    match: { endpoint: 'https://example.test/kline', protocol: 'json-embedded-csv/v1', frequency: 'day', adjustment: 'none' },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [
      { name: 'symbol', source: { kind: 'position', index: 0 }, type: 'text' },
      { name: 'trade_date', source: { kind: 'position', index: 2 }, type: 'text', timeFormat: 'iso-date' },
      { name: 'close', source: { kind: 'position', index: 3 }, type: 'decimal' },
    ],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于中间位置未声明的合成响应。' },
  });
  const bytes = Buffer.from(JSON.stringify({ data: 'X,1,2026-11-06,10' }), 'utf8');
  failCode(() => parseEndpointSource(bytes, config), 'ADAPTER_UNDECLARED_POSITION');
});

test('容器祖先层的并列业务结构同样阻断', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.nested', version: '1',
    match: { endpoint: 'https://example.test/kline', protocol: 'json/v1', frequency: 'day', adjustment: 'none' },
    carrier: { kind: 'json', charset: 'utf-8' },
    response: { success: null, container: { path: 'data.bars', kind: 'array' } },
    fields: [
      { name: 'symbol', source: { kind: 'key', key: 'symbol' }, type: 'text' },
      { name: 'trade_date', source: { kind: 'key', key: 'date' }, type: 'text', timeFormat: 'iso-date' },
      { name: 'close', source: { kind: 'key', key: 'close' }, type: 'decimal' },
    ],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于嵌套祖先并列结构的合成响应。' },
  });
  const nested = Buffer.from(JSON.stringify({ data: { bars: [{ symbol: 'X', date: '2026-11-06', close: '10' }],
    reports: [{ rank: 1, close: '99' }] } }), 'utf8');
  failCode(() => parseEndpointSource(nested, config), 'ADAPTER_EXTRA_STRUCTURE');
});

test('容器外并列业务结构阻断，元信息须显式声明', () => {
  const config = eastmoneyConfig();
  const sibling = Buffer.from(JSON.stringify({ rc: 0, rt: 4, data: { klines: ['2026-04-13,1,1,1,1,1,1'] }, reports: [{ title: '榜单' }] }), 'utf8');
  failCode(() => parseEndpointSource(sibling, config), 'ADAPTER_EXTRA_STRUCTURE');
  // 已声明的元信息键 rt 可并列；未声明时同样阻断。
  failCode(() => parseEndpointSource(Buffer.from(JSON.stringify({ rc: 0, rt: 4, data: { klines: ['2026-04-13,1,1,1,1,1,1'] } }), 'utf8'),
    readEndpointAdapterConfig({ ...config, response: { ...config.response, ignore: undefined } })), 'ADAPTER_EXTRA_STRUCTURE');
});

test('分隔记录额外位置与混合容器都明确阻断，不静默丢弃', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.positions', version: '1',
    match: { endpoint: 'https://example.test/kline', protocol: 'json-embedded-csv/v1', frequency: 'day', adjustment: 'none' },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [
      { name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' },
      { name: 'close', source: { kind: 'position', index: 1 }, type: 'decimal' },
      { name: 'volume', source: { kind: 'position', index: 2 }, type: 'integer' },
    ],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于位置宽度反例的合成响应。' },
  });
  const extra = Buffer.from(JSON.stringify({ data: '2026-04-13,10.00,100,rank=1' }), 'utf8');
  failCode(() => parseEndpointSource(extra, config), 'ADAPTER_EXTRA_POSITIONS');
  const mixed = Buffer.from(JSON.stringify({ data: [{ trade_date: '2026-04-13' }] }), 'utf8');
  failCode(() => parseEndpointSource(mixed, config), 'ADAPTER_CONTAINER');
});

test('分页未闭合不声明完整系列，声明闭合才为 true', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.paged', version: '1',
    match: { endpoint: 'https://example.test/news', protocol: 'json/v1', frequency: 'event', adjustment: 'none' },
    carrier: { kind: 'json', charset: 'utf-8' },
    response: { success: null, container: { path: 'data', kind: 'array' },
      pagination: { totalPath: 'total', cursorPath: 'next_cursor' } },
    fields: [{ name: 'title', source: { kind: 'key', key: 'title' }, type: 'text' }],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单页', basis: '仅用于分页完整性反例的合成响应。' },
  });
  failCode(() => parseEndpointSource(Buffer.from(JSON.stringify({ data: [{ title: 'a' }], total: 2, next_cursor: 'more' }), 'utf8'), config),
    'ADAPTER_PAGINATION_INCOMPLETE');
  // 游标缺失或类型漂移不能被当作"已到末页"。
  failCode(() => parseEndpointSource(Buffer.from(JSON.stringify({ data: [{ title: 'a' }], total: 1 }), 'utf8'), config),
    'ADAPTER_PAGINATION_INCOMPLETE');
  failCode(() => parseEndpointSource(Buffer.from(JSON.stringify({ data: [{ title: 'a' }], total: 1, next_cursor: { next: 'more' } }), 'utf8'), config),
    'ADAPTER_PAGINATION_INCOMPLETE');
  const closed = parseEndpointSource(Buffer.from(JSON.stringify({ data: [{ title: 'a' }], total: 1, next_cursor: '' }), 'utf8'), config);
  assert.equal(closed.seriesComplete, true);
  const undeclared = parseEndpointSource(SINA_LIKE, base());
  assert.equal(undeclared.seriesComplete, null);
  assert.ok(undeclared.gaps.some(gap => gap.includes('本页完整解析不等于来源系列完整')));
});

test('影响语义的字段声明保留顺序，并区分 fields2 与市场', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.order', version: '1',
    match: { endpoint: 'https://example.test/kline', protocol: 'json-embedded-csv/v1', frequency: 'day', adjustment: 'qfq',
      fields: ['f51', 'f52', 'f53'], fields2: ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57'], market: 'cn-a-share' },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [{ name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' }],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于字段顺序语义的合成响应。' },
  });
  assert.deepEqual(config.match.fields, ['f51', 'f52', 'f53']);
  assert.deepEqual(config.match.fields2, ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57']);
  assert.equal(config.match.market, 'cn-a-share');
  assert.notEqual(adapterConfigDigest(config), adapterConfigDigest(readEndpointAdapterConfig({
    ...config, match: { ...config.match, fields2: ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f58'] } })));
});

test('来源回执匹配核对地址、协议、字段顺序、fields2、频率、复权与市场', () => {
  const config = readEndpointAdapterConfig({
    contract: 'bd.endpoint-adapter/1', adapterId: 'test.match', version: '1',
    match: { endpoint: 'https://example.test/kline/{code}', protocol: 'json-embedded-csv/v1', frequency: 'day',
      adjustment: 'none', fields: ['f51', 'f52'], fields2: ['f51', 'f52', 'f53'], market: 'cn-a-share' },
    carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
    response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
    fields: [{ name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' }],
    evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于匹配门的合成响应。' },
  });
  const sha = 'a'.repeat(64);
  const base = { kind: 'synthetic' as const, url: 'https://example.test/kline/600519', materialSha256: sha,
    observedAt: '2026-11-06T00:00:00Z', protocol: 'json-embedded-csv/v1', fields: ['f51', 'f52'],
    fields2: ['f51', 'f52', 'f53'], frequency: 'day' as const, adjustment: 'none' as const, market: 'cn-a-share',
    basis: '合成等价样本，不是供应商实际下载回执。' };
  const matched = matchAdapterContext(config, readAdapterSourceContext(base), sha);
  // 合成上下文只能核到内部一致，不能取得真实取得回执资格。
  assert.equal(matched.verified, false);
  assert.equal(matched.consistent, true);
  assert.equal(matched.kind, 'synthetic');
  assert.ok(matched.gaps.some(gap => gap.includes('合成等价样本')));
  // 正文自报 receipt 一律拒绝；固定端点不接受父路径或同前缀。
  failCode(() => readAdapterSourceContext({ ...base, kind: 'receipt' }), 'ADAPTER_CONTEXT_UNTRUSTED');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, url: 'https://example.test/kline/600519/extra' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, url: 'https://example.test/kline' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, materialSha256: 'b'.repeat(64) }), sha), 'ADAPTER_CONTEXT_MATERIAL');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, url: 'https://other.test/kline/600519' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, fields: ['f52', 'f51'] }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, fields2: ['f51', 'f52', 'f54'] }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, adjustment: 'qfq' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, frequency: 'minute' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  failCode(() => matchAdapterContext(config, readAdapterSourceContext({ ...base, market: 'cn-b-share' }), sha), 'ADAPTER_CONTEXT_MISMATCH');
  // 缺项保留未知：不核过，也不冒充已核。
  const partial = matchAdapterContext(config, readAdapterSourceContext({ kind: 'synthetic', url: base.url,
    materialSha256: sha, observedAt: base.observedAt, basis: base.basis }), sha);
  assert.ok(partial.gaps.length >= 6);
});

test('真实取得回执：生产 issuer 核成功状态/受信 producer/动作，按文件关联与请求字段匹配', () => {
  const database = new CoreDatabase(':memory:');
  try {
    const materialSha = 'c'.repeat(64);
    const sourceTask = { action: 'source.kline.read', runtimeId: 'direct', status: 'succeeded', requiresReview: false,
      versions: { directConfiguration: 'cfg-1' },
      result: { data: { operation: 'daily_bars', scopeId: 'CN/A_STOCK', observedAt: '2026-11-06T01:00:00Z',
        requested: { adjustment: 'none', fields2: ['f51', 'f52', 'f53'] }, dailyValidation: { adjustment: 'none' },
        sourceReceipts: [{ url: 'https://push2his.example.test/api/qt/stock/kline/get?fields2=f51,f52,f53&secid=1.600519',
          sha256: materialSha, fileRefId: 'file-1', contentType: 'application/json', status: 200 }] } } };
    const receipt = readSourceReceiptFromTask(sourceTask, ['direct'])!;
    assert.deepEqual(receipt.requestedFields2, ['f51', 'f52', 'f53']);
    assert.equal(receipt.market, 'cn-a-share');
    // 未成功、需复核、非受信 producer、非来源动作都不构成取得回执。
    assert.equal(readSourceReceiptFromTask({ ...sourceTask, status: 'failed' }, ['direct']), null);
    assert.equal(readSourceReceiptFromTask({ ...sourceTask, requiresReview: true }, ['direct']), null);
    assert.equal(readSourceReceiptFromTask({ ...sourceTask, runtimeId: 'other-runtime' }, ['direct']), null);
    assert.equal(readSourceReceiptFromTask({ ...sourceTask, action: 'data.processing.plan' }, ['direct']), null);

    const registry = new EndpointAdapterRegistry({ database,
      materials: { get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-1' } }),
        readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never,
      sourceReceipt: (taskId: string) => taskId === 'source-task-1' ? receipt : null });
    const config = readEndpointAdapterConfig({
      contract: 'bd.endpoint-adapter/1', adapterId: 'test.receipt', version: '1',
      match: { endpoint: 'https://push2his.example.test/api/qt/stock/kline/get', protocol: 'daily_bars|application/json',
        frequency: 'day', adjustment: 'none', market: 'cn-a-share', fields2: ['f51', 'f52', 'f53'] },
      carrier: { kind: 'json-embedded-delimited', charset: 'utf-8', delimiter: ',' },
      response: { success: null, container: { path: 'data', kind: 'delimited-array' } },
      fields: [{ name: 'trade_date', source: { kind: 'position', index: 0 }, type: 'text', timeFormat: 'iso-date' }],
      evidence: { sourceId: 'test', provider: '合成样本', coverage: '单日单标的', basis: '仅用于回执关联的合成响应。' } });
    registry.propose({ config }, { operatorId: 'host.t', requestId: 'r1', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    database.connection.prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    const binding = { adapterId: config.adapterId, version: '1', configDigest: adapterConfigDigest(config) };
    const resolved = registry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' });
    assert.equal(resolved.match?.verified, true);
    assert.equal(resolved.match?.kind, 'receipt');
    failCode(() => registry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'other-task' }), 'ADAPTER_RECEIPT_MISSING');

    // 错误文件关联：回执 sha/文件引用与本材料不符。
    const wrongMaterial = new EndpointAdapterRegistry({ database: new CoreDatabase(':memory:'), materials: {
      get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-2' } }),
      readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never, sourceReceipt: () => receipt });
    wrongMaterial.propose({ config }, { operatorId: 'host.t', requestId: 'r2', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    (wrongMaterial as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    failCode(() => wrongMaterial.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' }), 'ADAPTER_CONTEXT_MATERIAL');

    // 必要维度缺失：不能升级为已核（不是抛错，而是 verified=false）。
    const missingFields2 = readSourceReceiptFromTask({ ...sourceTask, result: { data: { ...(sourceTask.result.data as Record<string, unknown>),
      sourceReceipts: [{ ...(sourceTask.result.data as { sourceReceipts: Record<string, unknown>[] }).sourceReceipts[0]!,
        url: 'https://push2his.example.test/api/qt/stock/kline/get' }] } } }, ['direct'])!;
    const missingRegistry = new EndpointAdapterRegistry({ database: new CoreDatabase(':memory:'), materials: {
      get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-1' } }),
      readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never, sourceReceipt: () => missingFields2 });
    missingRegistry.propose({ config }, { operatorId: 'host.t', requestId: 'r4', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    (missingRegistry as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    // 声明了 fields2 但实际 URL 未体现：不能按声明代替实际，直接拒绝。
    failCode(() => missingRegistry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' }), 'ADAPTER_CONTEXT_CONFLICT');

    // 多回执：按本材料 sha+fileRef 选中的那一条 URL 取字段，而不是第一条。
    const multi = { ...receipt, receipts: [
      { url: 'https://push2his.example.test/api/qt/stock/kline/get?fields2=f51,f99', sha256: 'd'.repeat(64), fileRefId: 'file-x', contentType: 'application/json' },
      { url: 'https://push2his.example.test/api/qt/stock/kline/get?fields2=f51,f52,f53', sha256: materialSha, fileRefId: 'file-1', contentType: 'application/json' }] };
    const multiRegistry = new EndpointAdapterRegistry({ database: new CoreDatabase(':memory:'), materials: {
      get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-1' } }),
      readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never, sourceReceipt: () => multi });
    multiRegistry.propose({ config }, { operatorId: 'host.t', requestId: 'r5', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    (multiRegistry as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    assert.equal(multiRegistry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' }).match?.verified, true);

    // 声明与所选回执实际 URL 冲突：拒绝，不用声明覆盖实际。
    const conflict = { ...receipt, requestedFields2: ['f51', 'f52', 'f99'] };
    const conflictRegistry = new EndpointAdapterRegistry({ database: new CoreDatabase(':memory:'), materials: {
      get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-1' } }),
      readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never, sourceReceipt: () => conflict });
    conflictRegistry.propose({ config }, { operatorId: 'host.t', requestId: 'r6', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    (conflictRegistry as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    failCode(() => conflictRegistry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' }), 'ADAPTER_CONTEXT_CONFLICT');

    // http 与 https 不抹平。
    const httpReceipt = { ...receipt, receipts: [{ ...receipt.receipts[0]!, url: 'http://push2his.example.test/api/qt/stock/kline/get?fields2=f51,f52,f53' }] };
    const httpRegistry = new EndpointAdapterRegistry({ database: new CoreDatabase(':memory:'), materials: {
      get: () => ({ envelope: { materialId: 'm1', sha256: materialSha, fileRefId: 'file-1' } }),
      readOriginal: () => ({ bytes: Buffer.alloc(1), sha256: materialSha }) } as never, sourceReceipt: () => httpReceipt });
    httpRegistry.propose({ config }, { operatorId: 'host.t', requestId: 'r3', method: 'POST', path: '/x', remoteAddress: null, observedAt: Date.now() });
    (httpRegistry as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE source_adapters SET status='adopted' WHERE adapter_id=?").run(config.adapterId);
    failCode(() => httpRegistry.resolve(binding, { materialId: 'm1', sourceReceiptTaskId: 'source-task-1' }), 'ADAPTER_CONTEXT_MISMATCH');
  } finally { database.close(); }
});

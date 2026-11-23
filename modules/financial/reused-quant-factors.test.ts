import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { captureAssets, financialDigest, PYTHON_BRIDGE, verifyAssets } from '../../plugins/financial/local-compute/assets.js';
import { buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import { checkR1Cell } from '../collection/r1-tabular.js';
import { verifyAlgorithmNumbers } from './algorithm-reference.js';
import { captureCodeBinding, LocalAlgorithmService, normalizeDecimal } from './algorithm-service.js';
import { ALGORITHM_METHODS, invalidAlgorithmParameter, type AlgorithmData, type AlgorithmMethodId,
  type AlgorithmSnapshotReference } from './algorithm-types.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';
import { createWfdProductMachineSnapshotPort, MACD_SNAPSHOT_SEMANTIC_CONTRACT } from './product-machine-snapshot.js';

const factorIds = ['alpha191_014', 'alpha191_031', 'alpha191_116', 'alpha191_168', 'alpha191_189'] as const;
type FactorId = typeof factorIds[number];
type Execution = { ok: boolean; rows: Record<string, number | string | null>[];
  diagnostics: { timestamp: string; output: string; reason: string }[]; error?: string };
const configuredPython = process.env.WFD_PYTHON;
const assetsRoot = fileURLToPath(new URL('../../plugins/financial/local-compute/assets', import.meta.url));
const bundle = captureAssets(assetsRoot);

function syntheticInput(prices: readonly number[], volumes?: readonly number[]): AlgorithmData {
  const rows = prices.map((close, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return { timestamp, close, available_at: `${timestamp}T18:00:00.000Z`, bar_closed: true as const,
      ...(volumes ? { volume: volumes[index]! } : {}) };
  });
  return { rows, metadata: { series_id: 'reused-factors-synthetic', subject: '公式合成测试样本', frequency: '1d', timezone: 'UTC',
    price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustment_basis: 'synthetic fixture',
    window_start: rows[0]!.timestamp, window_end: rows.at(-1)!.timestamp, as_of: '2026-04-01T00:00:00.000Z',
    availability_basis: 'explicit_per_bar', bar_closed: true, observations_are_consecutive: true,
    calendar_verification: 'dense', synthetic: true, ...(volumes ? { volume_unit: 'share' } : {}) } };
}

function execute(methodId: AlgorithmMethodId, data: AlgorithmData, params = {}): Execution {
  assert.ok(configuredPython);
  const method = ALGORITHM_METHODS[methodId];
  const completed = spawnSync(configuredPython, ['-I', '-S', '-B', '-c', PYTHON_BRIDGE], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 5_000,
    input: JSON.stringify({ files: bundle.files, request: { version: 1, kind: method.kind, operation: method.operation, params, data } }),
  });
  assert.equal(completed.status, 0, completed.error?.message ?? completed.stderr);
  return JSON.parse(completed.stdout) as Execution;
}

function column(id: FactorId, prices: number[], volumes?: number[]): (number | null)[] {
  const result = execute(id, syntheticInput(prices, volumes));
  assert.equal(result.ok, true, result.error ?? 'Python 计算未成功');
  return result.rows.map(row => row[ALGORITHM_METHODS[id].outputFields[0]!] as number | null);
}

function near(actual: number | null | undefined, expected: number): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual! - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

test('五个复用公式登记固定身份、来源提交及封闭参数', () => {
  for (const id of factorIds) {
    const method = ALGORITHM_METHODS[id];
    assert.match(method.reference, /2edbc3eaf799f4d8f42c99fccba3b8fc08554f10/u);
    assert.match(method.reference, /app\/services\/alpha191_formulas\.py:alpha_/u);
    assert.equal(invalidAlgorithmParameter(id, {}), null);
    assert.equal(invalidAlgorithmParameter(id, { period: 3 }), 'period');
    assert.equal(invalidAlgorithmParameter(id, { source: 'latest' }), 'source');
  }
});

describe('复用因子的真实封闭 Python 资产', { skip: configuredPython ? false : '未显式设置 WFD_PYTHON' }, () => {
  test('镜像价格斜率精确为零，次正规数均值偏离为 1100/13，TS 独立核对排除旧误差', () => {
    const half = Array.from({ length: 10 }, (_, i) => 1 + i * 1e8);
    for (const [methodId, prices, expected, wrong] of [
      ['alpha191_116', [...half, ...half.toReversed()], 0, -1.437e-9],
      ['alpha191_031', [...Array<number>(11).fill(Number.MIN_VALUE), 2 * Number.MIN_VALUE], 1100 / 13, 100],
    ] as const) {
      const input = syntheticInput(prices), raw = execute(methodId, input), field = ALGORITHM_METHODS[methodId].outputFields[0];
      assert.equal(raw.ok, true, raw.error ?? 'Python 计算未成功');
      const result = { methodId, parameters: {}, diagnostics: raw.diagnostics, metadata: input.metadata, rows: raw.rows.map((row, index) => ({
        ...row, timestamp: input.rows[index].timestamp, available_at: input.rows[index].available_at,
      })) };
      const actual = raw.rows.at(-1)![field];
      assert.ok(typeof actual === 'number');
      assert.equal(actual, expected);
      verifyAlgorithmNumbers(result, input);
      Object.assign(result.rows.at(-1)!, { [field]: wrong });
      assert.throws(() => verifyAlgorithmNumbers(result, input), { code: 'DERIVED_NUMERIC_MISMATCH' });
    }
  });
  test('固定预热后得到可手算的线性序列值，包含嵌套窗口', () => {
    const prices = Array.from({ length: 30 }, (_, index) => 10 + index * 2);
    const volumes = prices.map(() => 100);
    const cases: [FactorId, number, number][] = [
      ['alpha191_014', 5, 10],
      ['alpha191_031', 11, 100 * (32 - 21) / 21],
      ['alpha191_116', 19, 2],
      ['alpha191_168', 19, -1],
      ['alpha191_189', 10, 5],
    ];
    for (const [id, warmup, first] of cases) {
      const values = column(id, prices, id === 'alpha191_168' ? volumes : undefined);
      assert.equal(values.length, prices.length);
      assert.deepEqual(values.slice(0, warmup), Array(warmup).fill(null));
      near(values[warmup], first);
      assert.ok(values.slice(warmup).every(value => typeof value === 'number' && Number.isFinite(value)));
    }
  });

  test('斜率的分子可溢出时仍保留有限的回归斜率', () => {
    const prices = [...Array<number>(19).fill(1), 1e308];
    near(column('alpha191_116', prices)[19], 1e308 / 70);
  });
  test('不足预热只产生空值和诊断，不补零或补历史', () => {
    for (const id of factorIds) {
      const result = execute(id, syntheticInput([10, 12, 11], id === 'alpha191_168' ? [1, 2, 3] : undefined));
      assert.equal(result.ok, true);
      assert.ok(result.rows.every(row => row[ALGORITHM_METHODS[id].outputFields[0]!] === null));
      assert.equal(result.diagnostics.length, 3);
      assert.ok(result.diagnostics.every(row => row.reason === 'insufficient_warmup'));
    }
  });

  test('增加未来行不会改变已给历史前缀', () => {
    const prices = Array.from({ length: 36 }, (_, index) => 20 + index / 4 + (index % 5));
    const volumes = prices.map((_, index) => 10 + (index * 13) % 80);
    for (const id of factorIds) {
      const volume = id === 'alpha191_168' ? volumes : undefined;
      const full = column(id, prices, volume);
      const prefix = column(id, prices.slice(0, 26), volume?.slice(0, 26));
      assert.deepEqual(full.slice(0, 26), prefix);
    }
  });

  test('双层偏离使用各时点均值，趋势斜率对平移不变', () => {
    const prices = Array.from({ length: 24 }, (_, index) => 100 + (index % 7) ** 2);
    const nested = column('alpha191_189', prices);
    for (let index = 10; index < prices.length; index++) {
      let total = 0;
      for (let end = index - 5; end <= index; end++) {
        const average = prices.slice(end - 5, end + 1).reduce((sum, value) => sum + value, 0) / 6;
        total += Math.abs(prices[end]! - average);
      }
      near(nested[index], total / 6);
    }
    const original = column('alpha191_116', prices), shifted = column('alpha191_116', prices.map(value => value + 1_000_000));
    for (let index = 19; index < prices.length; index++) near(shifted[index], original[index]!);
  });

  test('相对量保持缩放不变，全零窗口未定义且下一个有效窗口恢复', () => {
    const prices = Array(25).fill(10) as number[];
    const volumes = prices.map((_, index) => index < 20 ? 0 : 100);
    const result = execute('alpha191_168', syntheticInput(prices, volumes));
    assert.equal(result.rows[19]!.ALPHA191_168, null);
    assert.deepEqual(result.diagnostics.at(-1), { timestamp: '2026-01-20', output: 'ALPHA191_168', reason: 'undefined_zero_denominator' });
    near(result.rows[20]!.ALPHA191_168 as number, -20);
    const nonzero = prices.map((_, index) => 20 + index);
    const base = column('alpha191_168', prices, nonzero);
    const scaled = column('alpha191_168', prices, nonzero.map(value => value * 100));
    for (let index = 19; index < prices.length; index++) near(scaled[index], base[index]!);
    assert.deepEqual(column('alpha191_168', prices, prices.map(() => Number.MIN_VALUE)).slice(19), Array(6).fill(-1));
  });

  test('缺失或负成交量在执行层拒绝，不作为零量填补', () => {
    const input = syntheticInput(Array(22).fill(10), Array(22).fill(100));
    delete input.rows[5]!.volume;
    assert.equal(execute('alpha191_168', input).ok, false);
    input.rows[5]!.volume = -1;
    assert.equal(execute('alpha191_168', input).ok, false);
  });
});

type VolumeField = { field_code: string; data_type: string; unit_code: string };
const shares: VolumeField = { field_code: 'volume', data_type: 'integer', unit_code: 'share' };

function fixedSeries(id: string, data: AlgorithmData, volume?: VolumeField) {
  const fieldMapping = { timestamp: 'date', close: 'close', available_at: 'available_at',
    ...(volume && { volume: volume.field_code }) };
  const reference: AlgorithmSnapshotReference = {
    kind: 'wfd_fixed_snapshot', instanceId: 'synthetic-factors', productId: 'synthetic-daily', snapshotId: id,
    definitionRevision: 'fixture-v1', fieldMapping, fields: Object.values(fieldMapping), calendar: { mode: 'dense' },
    semantics: { ...MACD_SNAPSHOT_SEMANTIC_CONTRACT.semantics, subject: data.metadata.subject, timezone: 'UTC',
      synthetic: true, ...(volume && { volumeUnit: volume.unit_code }) },
  };
  const identity = { product_id: reference.productId, definition_ref: { version: reference.definitionRevision,
    digest: 'sha256:' + 'd'.repeat(64) }, contract_ref: { digest: 'sha256:' + 'c'.repeat(64) } };
  const product = { ...identity, payload_kind: 'tabular_rows', declaration: {
    field_definitions: [{ field_code: 'date', data_type: 'text', unit_code: 'date' },
      { field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' },
      { field_code: 'available_at', data_type: 'text', unit_code: 'text' }, ...(volume ? [volume] : [])],
    semantic_context: { version: 'wfd.semantic-context/1.0', time: { frequency: 'day', timezone: 'UTC',
      roles: { observation: 'date', availability: 'available_at', bar_closed: 'true' } },
    financial: { price_adjustment: { direction: 'raw' } } },
  } };
  const rows = data.rows.map(({ timestamp, close, available_at, volume: quantity }, i) => ({
    ...identity, record_ref: { product_id: reference.productId, snapshot_id: id, revision_id: 'r' + i }, revision_state: 'current',
    row: { business_key: timestamp, subject: { kind: 'instrument', namespace: 'fixture', id: 'synthetic' },
      observation_time: { status: 'known', precision: 'day', source_timezone: 'UTC', earliest_utc: timestamp + 'T00:00:00Z',
        latest_exclusive_utc: new Date(Date.parse(timestamp) + 86_400_000).toISOString().replace('.000Z', 'Z') },
      values: { date: { value_state: 'valid_value', value: timestamp }, close: { value_state: 'valid_value', value: normalizeDecimal(String(close)) },
        available_at: { value_state: 'valid_value', value: available_at }, ...(volume && { [volume.field_code]: {
          data_type: volume.data_type, value_state: quantity === 0 ? 'reported_zero' : 'valid_value', value: String(quantity) } }) } },
  }));
  const client = {
    discover: async () => ({ result: { products: [product] }, transport: 'synthetic' }),
    read: async () => ({ result: { snapshot_id: id, row_count: rows.length, perspective: 'snapshot_contents', rows }, transport: 'synthetic' }),
  } as unknown as WfdProductMachineClient;
  return { reference, port: createWfdProductMachineSnapshotPort({ client, instanceId: reference.instanceId }) };
}

// 只加载仓库内的协议与治理函数，所有待验证的文档经 stdin 传入。
function validateWfdDocuments(examples: { document: WfdRecord; originals: (string | null)[] }[]) {
  assert.ok(configuredPython);
  const productRoot = fileURLToPath(new URL('../../wfd/product', import.meta.url));
  const run = spawnSync(configuredPython, ['-I', '-B', '-c', `
import json, sys
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from wfd_sdk import product_governance as governance
from wfd_sdk.duckdb_sdk import load_protocol_validator
validator = load_protocol_validator(Path(sys.argv[1]) / "protocol", "wfd-structured-ingest.schema.json")
quantum = Decimal(1).scaleb(-governance.MAX_SCALE)
for case in json.load(sys.stdin):
    document = case["document"]
    validator.validate(document)
    output, = document["outputs"]
    definition = output["definition"]
    kind = output["payload"]["kind"]
    issues = (governance.validate_definition(definition, kind)
              + governance.normalize_semantic_context(definition, kind)[1]
              + governance.normalize_algorithm_definition(definition)[1]
              + governance.validate_payload(output, definition))
    assert not issues, issues
    for row, original in zip(output["payload"]["rows"], case["originals"], strict=True):
        cell, = row["values"].values()
        if original is None:
            assert cell["value"] is None and cell["value_state"] in governance.NULL_STATES
        else:
            published, source = Decimal(cell["value"]), Decimal(original)
            assert published == source.quantize(quantum, rounding=ROUND_HALF_EVEN)
            assert abs(published - source) <= quantum / 2
`, productRoot], { cwd: tmpdir(), encoding: 'utf8', timeout: 15_000, input: JSON.stringify(examples) });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
}

describe('合成固定快照经原任务、派生核验与 WFD 协议', { skip: configuredPython ? false : '未显式设置 WFD_PYTHON' }, () => {
  let root: string, database: CoreDatabase, tasks: TaskService, algorithms: LocalAlgorithmService;
  const snapshots = new Map<string, ReturnType<typeof fixedSeries>>();
  const prices = [...Array<number>(19).fill(10), 10.01, 10, 10];
  const volumes = [...Array<number>(20).fill(0), 8, 0];
  const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: null };
  before(() => {
    const python = realpathSync(configuredPython!);
    root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'factor-publication-')));
    mkdirSync(join(root, 'config'));
    const resources: WfdRecord = { python: { kind: 'program', path: python } };
    for (const name of ['temp', 'cache', 'downloads']) {
      const path = join(root, name);
      mkdirSync(path);
      const stat = statSync(path, { bigint: true });
      resources[name] = { kind: 'directory', path, owned: true, identity: name, device: String(stat.dev), inode: String(stat.ino) };
    }
    const identity = 'synthetic-factor-publication';
    writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity }));
    writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: identity, resources }));
    database = new CoreDatabase();
    const runtimes = new TaskRuntimeRegistry();
    const permissions = new PermissionService({ database, isRunActive: (id, gen) => tasks.isRunActive(id, gen) });
    tasks = new TaskService({ database, permissions, runtimes });
    permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: python } }] });
    algorithms = new LocalAlgorithmService({ database, tasks: () => tasks, permissions, pythonExecutable: python,
      processRuntime: new ProcessRuntime(new ResourceBindings(root)), computeAssetsRoot: assetsRoot,
      expectedAssetsVersion: bundle.version, environment: 'synthetic-test', enabled: true,
      now: () => Date.parse('2026-04-01T00:00:00Z'), snapshots: { status: () => ({ status: 'available', reason: null }),
        read: (reference, context) => snapshots.get(reference.snapshotId)!.port.read(reference, context) } });
    runtimes.register(algorithms.runtime);
  });
  after(async () => {
    try { await tasks?.dispose(); } finally { database?.close(); if (root) rmSync(root, { recursive: true, force: true }); }
  });
  async function submit(id: string, methodId: AlgorithmMethodId, data: AlgorithmData, volume?: VolumeField, parameters = {}) {
    const snapshot = fixedSeries(id, data, volume);
    snapshots.set(id, snapshot);
    const task = algorithms.submit(id, { methodId, parameters, source: { kind: 'fixed_snapshot', reference: snapshot.reference } });
    return tasks.wait(task.taskId);
  }

  test('五个 Alpha191 因子逐格通过 checkR1Cell 和真实 WFD 治理，19 位小数按合同发布', async () => {
    const examples: Parameters<typeof validateWfdDocuments>[0] = [];
    const warmups = [5, 11, 19, 19, 10];
    for (const [index, id] of factorIds.entries()) {
      const volume = id === 'alpha191_168';
      const done = await submit(id, id, syntheticInput(prices, volume ? volumes : undefined), volume ? shares : undefined);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const result = algorithms.view(done.id).result!, input = algorithms.verifiedInput(done.id);
      const checked = checkDerivedForWfd(result, binding, id, input), field = ALGORITHM_METHODS[id].outputFields[0];
      const cells = (checked.structured.payload.rows as { values: Record<string, { value: string | null; value_state: string }> }[])
        .map(row => row.values[field]);
      for (const cell of cells) checkR1Cell('decimal', cell.value_state, cell.value, field);
      assert.ok(cells.slice(0, warmups[index]).every(c => c.value_state === 'insufficient_warmup' && c.value === null));
      assert.equal(cells[warmups[index]].value_state, volume ? 'not_applicable' : 'valid_value');
      if (volume) {
        assert.deepEqual(input.rows.map(row => row.volume), volumes);
        assert.deepEqual(cells.slice(19).map(c => [c.value_state, c.value]), [
          ['not_applicable', null], ['valid_value', '-20'], ['valid_value', '0'],
        ]);
      }
      if (id === 'alpha191_116' || id === 'alpha191_189') {
        const expected = id === 'alpha191_116' ? ['0.0001428571428571398', '0.00014285714285714']
          : ['0.0013888888888888098', '0.00138888888888881'];
        assert.deepEqual([String(result.rows[19][field]), cells[19].value], expected);
      }
      assert.equal(checked.originalBytes.toString(), canonicalWfdJson(result.rows));
      assert.match(String((checked.structured.definition.algorithm_definition as WfdRecord).result_semantics), /18.*round-half-even.*原算法任务/u);
      examples.push({ document: buildStructuredIngestDocument(checked.structured),
        originals: result.rows.map(row => row[field] === null ? null : String(row[field])) });
    }
    validateWfdDocuments(examples);
  });

  test('大数镜像端点不掩盖 1.01 的斜率，原任务和派生文档均保留负值', async () => {
    const id = 'slope-symmetric-extremes', prices = [1e15, 1.01, ...Array<number>(17).fill(1), 1e15];
    const done = await submit(id, 'alpha191_116', syntheticInput(prices));
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const result = algorithms.view(done.id).result!, input = algorithms.verifiedInput(done.id);
    const expected = -17 / 133000, actual = result.rows[19].ALPHA191_116;
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 2e-19);
    verifyAlgorithmNumbers(result, input);
    const checked = checkDerivedForWfd(result, binding, id, input);
    const rows = checked.structured.payload.rows as { values: WfdRecord }[];
    assert.deepEqual(rows[19].values.ALPHA191_116, { data_type: 'decimal', value_state: 'valid_value', value: '-0.000127819548872181' });
    result.rows[19].ALPHA191_116 = 0;
    assert.throws(() => verifyAlgorithmNumbers(result, input), { code: 'DERIVED_NUMERIC_MISMATCH' });
    assert.throws(() => checkDerivedForWfd(result, binding, id, input), { code: 'DERIVED_NUMERIC_MISMATCH' });

    const cancelPrices = [1.000000001, 190000001, ...Array<number>(17).fill(1), 170000001];
    const cancelDone = await submit('slope-tiny-offset-diff', 'alpha191_116', syntheticInput(cancelPrices));
    assert.equal(cancelDone.status, 'succeeded', JSON.stringify(cancelDone.error));
    const cancelResult = algorithms.view(cancelDone.id).result!, cancelInput = algorithms.verifiedInput(cancelDone.id);
    const cancelActual = cancelResult.rows[19].ALPHA191_116;
    assert.ok(typeof cancelActual === 'number' && Math.abs(cancelActual - -1.4285715467719585e-11) < 1e-24, String(cancelActual));
    verifyAlgorithmNumbers(cancelResult, cancelInput);
    const cancelChecked = checkDerivedForWfd(cancelResult, binding, 'slope-tiny-offset-diff', cancelInput);
    assert.notEqual(((cancelChecked.structured.payload.rows as { values: WfdRecord }[])[19].values.ALPHA191_116 as WfdRecord).value, '0');
    cancelResult.rows[19].ALPHA191_116 = 0;
    assert.throws(() => verifyAlgorithmNumbers(cancelResult, cancelInput), { code: 'DERIVED_NUMERIC_MISMATCH' });
    assert.throws(() => checkDerivedForWfd(cancelResult, binding, 'slope-tiny-offset-diff', cancelInput), { code: 'DERIVED_NUMERIC_MISMATCH' });
  });

  test('零分母、非正对数和全平 RSI 的真实诊断都生成 not_applicable', async () => {
    for (const [id, values, params, field, index, reason] of [
      ['roc', [0, 10], { period: 1 }, 'ROC', 1, 'undefined_zero_denominator'],
      ['returns', [10, 0], { period: 1, mode: 'log' }, 'RETURN', 1, 'undefined_nonpositive_log_price'],
      ['rsi', [10, 10, 10], { period: 2 }, 'RSI', 2, 'undefined_flat_rsi'],
    ] as const) {
      const done = await submit(id, id, syntheticInput([...values]), undefined, params);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const result = algorithms.view(done.id).result!, input = algorithms.verifiedInput(done.id);
      assert.deepEqual(result.diagnostics.at(-1), { timestamp: input.rows[index].timestamp, output: field, reason });
      const rows = checkDerivedForWfd(result, binding, id, input).structured.payload.rows as { values: WfdRecord }[];
      assert.deepEqual(rows[index].values[field], { data_type: 'decimal', value_state: 'not_applicable', value: null });
      result.diagnostics[result.diagnostics.length - 1] = { timestamp: input.rows[index].timestamp, output: field, reason: 'insufficient_warmup' };
      assert.throws(() => checkDerivedForWfd(result, binding, id, input), { code: 'DERIVED_NULL_REASON_MISSING' });
    }
  });

  test('MACD 原任务保留 19 位 DEA，逐格门禁拒绝超标原串', async () => {
    const done = await submit('macd-precision', 'macd', syntheticInput([100, 120, 90, 90, 110, 85]), undefined,
      { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const result = algorithms.view(done.id).result!, input = algorithms.verifiedInput(done.id);
    assert.equal(String(result.rows[5].DEA), '-0.0023938879953495917');
    verifyAlgorithmNumbers(result, input);
    assert.throws(() => checkDerivedForWfd(result, binding, 'macd-precision', input), { code: 'R1_TABULAR_PRECISION' });
  });

  test('实际任务在计算前拒绝 turnover/cny 及文本成交量', async () => {
    for (const id of ['alpha191_168', 'obv'] as const) for (const field of [
      { field_code: 'turnover', unit_code: 'cny', data_type: 'decimal' }, { ...shares, data_type: 'text' },
    ]) {
      const done = await submit(`invalid-${id}-${field.unit_code}`, id, syntheticInput(prices, prices), field);
      assert.equal(done.status, 'failed');
      assert.equal(done.error?.code, 'ALGORITHM_UNIT_MISMATCH', JSON.stringify(done.error));
      assert.equal(algorithms.view(done.id).result, null);
    }
  });

  test('逐格可表示但整列无法使用同一 DECIMAL 的收益序列在发布前拒绝', async () => {
    const done = await submit('column-precision', 'returns', syntheticInput([1e-18, 1e12, 1]), undefined, { period: 1, mode: 'simple' });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const result = algorithms.view(done.id).result!, input = algorithms.verifiedInput(done.id);
    for (const row of result.rows.slice(1)) checkR1Cell('decimal', 'valid_value', normalizeDecimal(String(row.RETURN)), 'RETURN');
    assert.throws(() => checkDerivedForWfd(result, binding, 'column-precision', input), { code: 'DERIVED_COLUMN_PRECISION' });
  });

  test('自洽的替换包不能冒充任务冻结版本，代码绑定含加载器和进程启动模块', async () => {
    const replacement = structuredClone(bundle);
    const name = 'indicators.py', bytes = Buffer.concat([Buffer.from(bundle.files[name], 'base64'), Buffer.from('\n# synthetic fixture\n')]);
    replacement.files[name] = bytes.toString('base64');
    replacement.hashes[name] = createHash('sha256').update(bytes).digest('hex');
    replacement.version = 'sha256:' + financialDigest(replacement.hashes);
    verifyAssets(replacement, replacement.version);
    assert.throws(() => verifyAssets(replacement, bundle.version), { code: 'FINANCIAL_IMPLEMENTATION_CHANGED' });
    const update = database.connection.prepare('UPDATE algorithm_assets SET bundle_json=? WHERE version=?');
    update.run(JSON.stringify(replacement), bundle.version);
    try {
      const done = await submit('asset-substitution', 'alpha191_014', syntheticInput(prices));
      assert.equal(done.status, 'failed');
      assert.equal(done.error?.code, 'FINANCIAL_IMPLEMENTATION_CHANGED', JSON.stringify(done.error));
    } finally { update.run(JSON.stringify(bundle), bundle.version); }
    const code = captureCodeBinding();
    for (const path of ['plugins/financial/local-compute/assets.ts', 'platform/runtime/process.ts']) {
      const bytes = readFileSync(new URL('../../' + path, import.meta.url));
      assert.equal(code.files[path], createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(code.version, 'sha256:' + financialDigest(code.files));
  });
});

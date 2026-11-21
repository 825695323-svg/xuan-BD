import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { FrozenRunConfiguration } from '../../contracts/ui-contracts.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { TaskRuntimeRegistry, TaskService, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { captureAssets, executeFinancialAssets, financialDigest, PYTHON_BRIDGE } from '../../plugins/financial/local-compute/assets.js';
import { assertInternalAgentRules, captureInternalAgentRules } from '../agent/instructions/rules.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { factorLibraryView } from '../collection/production-module-ports.js';
import { wfdFixedReadEvidence } from '../collection/purpose-eligibility.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';
import { LocalAlgorithmService, normalizeDecimal } from './algorithm-service.js';
import { ALGORITHM_METHOD_IDS, ALGORITHM_METHODS, type AlgorithmBar, type AlgorithmData, type AlgorithmMethodId,
  type AlgorithmSnapshotRead, type AlgorithmSnapshotReference } from './algorithm-types.js';
import { ConversationAlgorithmBridge } from './conversation-algorithms.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';

const assetsRoot = fileURLToPath(new URL('../../plugins/financial/local-compute/assets', import.meta.url));
const configuredPython = process.env.WFD_PYTHON;
const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: null };
const asOf = '2026-01-31T00:00:00.000Z';
const macdParameters = { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' };

function syntheticSeries(closes: number[], volumes?: number[]): AlgorithmData {
  const rows = closes.map((close, index): AlgorithmBar => {
    const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return { timestamp, close, available_at: `${timestamp}T18:00:00.000Z`, bar_closed: true,
      ...(volumes ? { volume: volumes[index]! } : {}) };
  });
  return { rows, metadata: {
    series_id: 'unified-indicators-synthetic', subject: '合成日线', frequency: '1d', timezone: 'UTC',
    price_unit: 'currency_per_share', currency: 'CNY', ...(volumes ? { volume_unit: 'share' } : {}),
    adjustment: 'unadjusted', adjustment_basis: 'synthetic fixture',
    window_start: rows[0]!.timestamp, window_end: rows.at(-1)!.timestamp, as_of: asOf,
    availability_basis: 'explicit_per_bar', bar_closed: true, observations_are_consecutive: true,
    calendar_verification: 'dense', synthetic: true,
  } };
}

const closes = [100, 120, 90, 90, 110, 85, 125, 100, 130, 120];
const prices = syntheticSeries(closes);
const withVolume = syntheticSeries(closes, [1200, 800, 1700, 900, 0, 600, 2000, 300, 1500, 750]);
const factorCloses = Array.from({ length: 28 }, (_, index) => 30 + index / 2 + (index % 4) * 1.25);
const factorPrices = syntheticSeries(factorCloses);
const factorVolume = syntheticSeries(factorCloses, factorCloses.map((_, index) => 20 + (index * 17) % 71));

function syntheticSnapshot(id: string, data: AlgorithmData, needsVolume: boolean): AlgorithmSnapshotRead {
  const fieldMapping = { timestamp: 'timestamp', close: 'close', available_at: 'available_at',
    ...(needsVolume ? { volume: 'volume' } : {}) };
  const { metadata } = data;
  const reference: AlgorithmSnapshotReference = {
    kind: 'wfd_fixed_snapshot', instanceId: 'synthetic-indicators', productId: 'synthetic-daily',
    snapshotId: `synthetic-${id}`, definitionRevision: 'fixture-v1', fields: Object.values(fieldMapping), fieldMapping,
    semantics: { subject: metadata.subject, frequency: '1d', timezone: 'UTC', priceUnit: metadata.price_unit,
      currency: metadata.currency, adjustment: metadata.adjustment, adjustmentBasis: metadata.adjustment_basis,
      ...(metadata.volume_unit ? { volumeUnit: metadata.volume_unit } : {}),
      barClosed: true, synthetic: true, availability: { kind: 'column' } },
    calendar: { mode: 'dense' },
  };
  const rows = data.rows.map(({ timestamp, close, volume, available_at }) => ({
    timestamp, close: normalizeDecimal(String(close)), available_at, ...(volume === undefined ? {} : { volume: String(volume) }),
  }));
  const subject = { kind: 'instrument', namespace: 'test', id: 'synthetic-series' };
  const observations = rows.map(({ timestamp }, index) => ({
    business_key: timestamp, subject,
    observation_time: { status: 'known', precision: 'day', source_timezone: 'UTC',
      earliest_utc: `${timestamp}T00:00:00Z`,
      latest_exclusive_utc: new Date(Date.parse(`${timestamp}T00:00:00Z`) + 86_400_000).toISOString() },
    record_ref: { product_id: reference.productId, snapshot_id: reference.snapshotId, revision_id: `fixture-${index}` },
    revision_state: 'current',
  }));
  const objectSha256 = financialDigest(rows);
  const evidence = observations.map(row => wfdFixedReadEvidence({ row, product: null,
    result: { snapshot_id: reference.snapshotId, perspective: 'snapshot_contents' },
    objectSha256, checkedAtUtc: asOf, contentBasis: '内存合成快照测试样本',
  }));
  return { reference, rows, evidence, verifiedScope: 'server_identity_descriptor_and_projection',
    resolution: { instanceId: reference.instanceId, productId: reference.productId, snapshotId: reference.snapshotId,
      rowCount: rows.length, envelope: { rows: observations }, fields: { definitions: [
        { field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' },
        ...(needsVolume ? [{ field_code: 'volume', data_type: 'decimal', unit_code: 'share' }] : []),
      ] } },
  };
}

describe('统一指标真实 Python 执行与独立复核',
  { skip: configuredPython ? false : '未显式设置 WFD_PYTHON', timeout: 90_000 }, () => {
    const snapshots = new Map<string, AlgorithmSnapshotRead>();
    let root: string;
    let database: CoreDatabase;
    let tasks: TaskService;
    let runtime: ProcessRuntime;
    let algorithms: LocalAlgorithmService;
    let bundle: ReturnType<typeof captureAssets>;
    let python: string;

    before(() => {
      assert.ok(configuredPython);
      python = realpathSync(configuredPython);
      bundle = captureAssets(assetsRoot);
      root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'unified-indicators-')));
      mkdirSync(join(root, 'config'));
      const resources: Record<string, unknown> = { python: { kind: 'program', path: python } };
      for (const name of ['cache', 'temp', 'downloads']) {
        const path = join(root, name);
        mkdirSync(path);
        const stat = statSync(path, { bigint: true });
        resources[name] = { kind: 'directory', path, owned: true, identity: name,
          device: String(stat.dev), inode: String(stat.ino) };
      }
      const identity = 'unified-indicators-test';
      writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity }));
      writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({
        version: 1, revision: 1, runtimeIdentity: identity, resources,
      }));
      runtime = new ProcessRuntime(new ResourceBindings(root));
      database = new CoreDatabase();
      const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks.isRunActive(id, generation) });
      const runtimes = new TaskRuntimeRegistry();
      tasks = new TaskService({ database, permissions, runtimes });
      permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: python } }] });
      algorithms = new LocalAlgorithmService({ database, permissions, tasks: () => tasks, processRuntime: runtime,
        pythonExecutable: python, computeAssetsRoot: assetsRoot, expectedAssetsVersion: bundle.version,
        environment: 'synthetic-test', enabled: true, now: () => Date.parse(asOf),
        snapshots: { status: () => ({ status: 'available', reason: null }), async read(reference) {
          const snapshot = snapshots.get(reference.snapshotId);
          assert.ok(snapshot, `缺少合成快照 ${reference.snapshotId}`);
          return { ...snapshot, reference };
        } },
      });
      runtimes.register(algorithms.runtime);
    });

    after(async () => {
      try { await tasks?.dispose(); }
      finally {
        database?.close();
        if (root) rmSync(root, { recursive: true, force: true });
      }
    });

    function execute(methodId: AlgorithmMethodId, params: JsonValue, data: AlgorithmData) {
      const { kind, operation } = ALGORITHM_METHODS[methodId];
      const context: Pick<TaskExecutionContext, 'signal' | 'emit'> = { signal: new AbortController().signal, async emit() {} };
      return executeFinancialAssets({ bundle, pythonExecutable: python, processRuntime: runtime, cwd: root,
        context: context as TaskExecutionContext,
        assertAuthorized: () => assert.equal(runtime.path('python3'), python),
        request: { version: 1, kind, operation, params, data: { metadata: { ...data.metadata }, rows: data.rows.map(row => ({ ...row })) } },
      });
    }

    function submit(id: string, methodId: AlgorithmMethodId, parameters: JsonValue, data: AlgorithmData) {
      const snapshot = syntheticSnapshot(id, data, ALGORITHM_METHODS[methodId].requiredFields.includes('volume'));
      snapshots.set(snapshot.reference.snapshotId, snapshot);
      return algorithms.submit(id, { methodId, parameters, source: { kind: 'fixed_snapshot', reference: snapshot.reference } });
    }

    async function computeAndCheck(id: string, methodId: AlgorithmMethodId, params: JsonValue, data = prices) {
      const { taskId } = submit(id, methodId, params, data);
      const task = await tasks.wait(taskId);
      assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
      const { result } = algorithms.view(taskId);
      assert.ok(result);
      assert.equal(result.implementationVersion, bundle.version);
      assert.deepEqual(result.parameters, params);
      const input = algorithms.verifiedInput(taskId);
      assert.deepEqual(input.rows, data.rows);
      const { structured } = checkDerivedForWfd(result, binding, id, input);
      assert.equal(structured.payload.kind, 'tabular_rows');
      assert.ok(Array.isArray(structured.payload.rows));
      assert.equal(structured.payload.rows.length, data.rows.length);
      return { result, input };
    }

    const cases = [
      ['macd', 'macd', macdParameters],
      ['ma', 'ma', { period: 3 }],
      ['ema', 'ema', { period: 4, init: 'first_valid' }],
      ['rsi', 'rsi', { period: 3 }],
      ['boll', 'boll', { period: 4, std_dev: 2.5 }],
      ['roc', 'roc', { period: 2 }],
      ['obv', 'obv', {}, withVolume],
      ['returns-simple', 'returns', { period: 2, mode: 'simple' }],
      ['returns-log', 'returns', { period: 2, mode: 'log' }],
      ['drawdown-expanding', 'max_drawdown', {}],
      ['drawdown-rolling', 'max_drawdown', { period: 3 }],
      ['alpha191-014', 'alpha191_014', {}, factorPrices],
      ['alpha191-031', 'alpha191_031', {}, factorPrices],
      ['alpha191-116', 'alpha191_116', {}, factorPrices],
      ['alpha191-168', 'alpha191_168', {}, factorVolume],
      ['alpha191-189', 'alpha191_189', {}, factorPrices],
    ] as const satisfies readonly (readonly [string, AlgorithmMethodId, JsonValue, AlgorithmData?])[];

    for (const [id, methodId, params, data] of cases) {
      test(`${id} 的全部输出行通过独立 TypeScript 数值复核`, async () => {
        await computeAndCheck(id, methodId, params, data);
      });
    }

    test('波动率只按显式因子年化，缺省保留样本日标准差', async () => {
      const { result: daily } = await computeAndCheck('volatility-daily', 'volatility', { period: 3 });
      const { result: annual } = await computeAndCheck('volatility-annual', 'volatility', { period: 3, annualization_factor: 9 });
      // 首个完整窗口日收益为 0.2、-0.25、0，样本方差分母为 2。
      const first = daily.rows[3]!.VOLATILITY;
      assert.ok(typeof first === 'number' && Math.abs(first - Math.sqrt(0.05083333333333333)) < 1e-12);
      for (const [index, { VOLATILITY: value }] of daily.rows.entries()) {
        const annualized = annual.rows[index]!.VOLATILITY;
        if (value === null) assert.equal(annualized, null);
        else assert.ok(typeof value === 'number' && typeof annualized === 'number'
          && Math.abs(annualized - 3 * value) < 1e-12, `第 ${index + 1} 行显式年化`);
      }
    });

    test('TypeScript 服务和 Python 桥接均拒绝越界参数', async () => {
      const invalid = [
        ['ma', { period: 1 }, 'period'],
        ['rsi', { period: 101 }, 'period'],
        ['boll', { period: 4, std_dev: 5.1 }, 'std_dev'],
        ['volatility', { period: 3, annualization_factor: 367 }, 'annualization_factor'],
      ] as const;
      for (const [methodId, params, field] of invalid) {
        assert.throws(() => submit(`invalid-${methodId}`, methodId, params, prices), { code: 'INVALID_ALGORITHM_PARAMETERS' });
        await assert.rejects(execute(methodId, params, prices), {
          code: 'PROCESS_FAILED', exitCode: 1, diagnostic: new RegExp(`invalid parameter: ${field}`),
        });
      }
    });

    test('Python 桥接阻断文件系统及环境变更事件', () => {
      const events = ['os.remove', 'os.unlink', 'os.rename', 'os.replace', 'os.mkdir', 'os.rmdir',
        'os.chmod', 'os.chown', 'os.link', 'os.symlink', 'os.truncate', 'os.utime',
        'os.chflags', 'os.setxattr', 'os.removexattr',
        'os.chdir', 'os.putenv', 'os.unsetenv', 'shutil.rmtree', 'shutil.move',
        'shutil.copyfile', 'pathlib.Path.chmod'];
      const probe = `
import os, sys
def execute(request):
    blocked = []
    for event in ${JSON.stringify(events)}:
        try:
            sys.audit(event)
        except PermissionError:
            blocked.append(event)
    try:
        os.mkdir('audit-marker')
    except PermissionError:
        return blocked
    raise ValueError('os.mkdir was allowed')
`;
      const execution = spawnSync(python, ['-I', '-S', '-B', '-c', PYTHON_BRIDGE], {
        cwd: root, encoding: 'utf8', timeout: 5_000,
        input: JSON.stringify({ files: { ...bundle.files, 'calculate.py': Buffer.from(probe).toString('base64') },
          request: { version: 1, kind: 'indicator', operation: 'MACD', params: macdParameters, data: {} } }),
      });
      assert.equal(execution.status, 0, execution.error?.message ?? execution.stderr);
      assert.deepEqual(JSON.parse(execution.stdout), events);
      assert.equal(existsSync(join(root, 'audit-marker')), false);
    });

    test('OBV 必须有逐行成交量及显式 volumeUnit', async () => {
      const missingVolume = structuredClone(withVolume);
      delete missingVolume.rows[1]!.volume;
      const missingUnit = structuredClone(withVolume);
      delete missingUnit.metadata.volume_unit;
      const { taskId } = submit('obv-missing-volume', 'obv', {}, missingVolume);
      const task = await tasks.wait(taskId);
      assert.equal(task.status, 'failed');
      assert.match(task.error?.message ?? '', /volume/u);
      assert.throws(() => submit('obv-missing-unit', 'obv', {}, missingUnit), { code: 'ALGORITHM_UNIT_MISMATCH' });
      for (const [input, error] of [[missingVolume, '第2条缺少所需字段volume'], [missingUnit, '必须声明volume_unit']] as const) {
        assert.deepEqual(await execute('obv', {}, input), { ok: false, error, execution_executed: false });
      }
    });

    test('复用相对量因子沿同一入口核验 WFD 成交量定义及零量窗口', async () => {
      const noUnit = syntheticSeries(factorCloses, factorCloses.map(() => 1));
      delete noUnit.metadata.volume_unit;
      assert.throws(() => submit('alpha168-no-unit', 'alpha191_168', {}, noUnit), { code: 'ALGORITHM_UNIT_MISMATCH' });
      const zeroVolume = syntheticSeries(factorCloses, factorCloses.map((_, index) => index < 20 ? 0 : 40));
      const { result, input } = await computeAndCheck('alpha168-zero-window', 'alpha191_168', {}, zeroVolume);
      assert.equal(result.rows[19]!.ALPHA191_168, null);
      assert.equal(result.rows[20]!.ALPHA191_168, -20);
      assert.ok(result.diagnostics.some(item => isWfdRecord(item) && item.reason === 'undefined_zero_denominator'));
      result.rows[20]!.ALPHA191_168 = -19;
      assert.throws(() => checkDerivedForWfd(result, binding, 'alpha168-tampered', input), { code: 'DERIVED_NUMERIC_MISMATCH' });
    });

    test('ROC 和收益遇到零分母保留 null 与对应诊断', async () => {
      const data = syntheticSeries([5, 0, 10, 12]);
      for (const [id, methodId, params, field, reason] of [
        ['roc-zero', 'roc', { period: 1 }, 'ROC', 'undefined_zero_denominator'],
        ['simple-zero', 'returns', { period: 1, mode: 'simple' }, 'RETURN', 'undefined_zero_denominator'],
        ['log-zero', 'returns', { period: 1, mode: 'log' }, 'RETURN', 'undefined_nonpositive_log_price'],
      ] as const) {
        const { result } = await computeAndCheck(id, methodId, params, data);
        assert.equal(result.rows[2]![field], null);
        assert.deepEqual(result.diagnostics.filter(diagnostic => typeof diagnostic === 'object' && diagnostic !== null
          && !Array.isArray(diagnostic) && diagnostic.timestamp === data.rows[2]!.timestamp),
        [{ timestamp: data.rows[2]!.timestamp, output: field, reason }]);
        assert.equal(typeof result.rows[3]![field], 'number');
      }
    });

    test('RSI 全平输出 null，只有上涨或下跌时分别为 100 或 0', async () => {
      const { result: rising } = await computeAndCheck('rsi-flat-rise', 'rsi', { period: 2 }, syntheticSeries([10, 10, 10, 11, 12]));
      assert.equal(rising.rows[2]!.RSI, null);
      assert.ok(rising.diagnostics.some(diagnostic => typeof diagnostic === 'object' && diagnostic !== null
        && !Array.isArray(diagnostic) && diagnostic.timestamp === rising.rows[2]!.timestamp
        && diagnostic.output === 'RSI' && diagnostic.reason === 'undefined_flat_rsi'));
      assert.equal(rising.rows[3]!.RSI, 100);
      const { result: falling } = await computeAndCheck('rsi-fall', 'rsi', { period: 2 }, syntheticSeries([12, 11, 10, 10]));
      assert.equal(falling.rows[2]!.RSI, 0);
    });

    test('RSI 保留最小正浮点涨幅，递推在两端同一步舍入为零', async () => {
      const tiny = Number.MIN_VALUE;
      const data = syntheticSeries([tiny, tiny, 2 * tiny, 2 * tiny, 3 * tiny]);
      const { result } = await computeAndCheck('rsi-subnormal', 'rsi', { period: 2 }, data);
      assert.deepEqual(result.rows.map(row => row.RSI), [null, null, 100, null, 100]);
    });

    test('冻结 v18/v19 的会话只发现和派发 MACD，v20 或缺省版本保留全部方法', async () => {
      const frozenVersions = new Map([['run-v18', 18], ['run-v19', 19], ['run-v20', 20]]);
      const origin: ModelTaskOrigin = { callId: 'frozen-rules', conversationId: 'conversation', parentRunId: 'run-v19',
        parentGeneration: 1, inputId: 'input', branchId: 'branch', messageId: 'message', modelDigest: 'model',
        endpointDigest: 'endpoint', toolCallId: 'tool', toolName: 'perform_action', notice: '',
        receiver: { provider: 'fixture', model: 'fixture', origin: 'fixture' } };
      const companion = { algorithms, tasks, derivedPublisher: { async publish() {
        return { requestId: 'fixture', state: 'not_requested', published: false, requiresRecovery: false,
          fixedReadback: false, error: null };
      } } } as unknown as WorkspaceServices;
      const bridge = new ConversationAlgorithmBridge({ database, companion, origin: () => origin,
        rulesVersion: runId => frozenVersions.get(runId) });
      async function invoke(action: string, args: Record<string, JsonValue> = {}) {
        const context = { task: { id: `${origin.parentRunId}:${action}`, action, args },
          signal: new AbortController().signal, assertAuthorized() {} } as unknown as TaskExecutionContext;
        const { data } = await bridge.execute(context);
        assert.ok(isWfdRecord(data));
        return data.modelPreview as { methods?: { methodId: string }[]; methodDirectory?: { methodId: string }[];
          algorithms?: { methods: { id: string }[] }; status?: string; methodId?: string };
      }
      for (const [runId, methods] of [
        ['run-v18', ['macd']], ['run-v19', ['macd']],
        ['run-v20', ALGORITHM_METHOD_IDS], ['run-without-rules', ALGORITHM_METHOD_IDS],
      ] as const) {
        origin.parentRunId = runId;
        const contract = await invoke('algorithms.contract');
        assert.deepEqual(contract.methods?.map(method => method.methodId), methods);
        const capabilities = await invoke('algorithms.capabilities');
        assert.deepEqual(capabilities.algorithms?.methods.map(method => method.id), methods);
        assert.deepEqual(capabilities.methodDirectory?.map(method => method.methodId), methods);
      }
      origin.parentRunId = 'run-v19';
      const rejected = { code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', message: /v19.*macd/u };
      await assert.rejects(invoke('algorithms.contract', { methodId: 'ma' }), rejected);
      assert.equal((await invoke('algorithms.contract', { methodId: 'macd' })).methods?.[0]?.methodId, 'macd');
      const snapshot = syntheticSnapshot('frozen-v19', prices, false);
      snapshots.set(snapshot.reference.snapshotId, snapshot);
      const source = { kind: 'fixed_snapshot', reference: snapshot.reference };
      const ma = { calculationJson: JSON.stringify({ methodId: 'ma', parameters: { period: 3 }, source }) };
      await assert.rejects(invoke('algorithms.calculate', ma), rejected);
      await assert.rejects(invoke('data.modules.calculate', ma), rejected);
      const macd = await invoke('algorithms.calculate', {
        calculationJson: JSON.stringify({ methodId: 'macd', parameters: macdParameters, source }),
      });
      assert.equal(macd.methodId, 'macd');
      assert.equal(macd.status, 'succeeded');
      for (const runId of ['run-v20', 'run-without-rules']) {
        origin.parentRunId = runId;
        const result = await invoke('algorithms.calculate', ma);
        assert.equal(result.methodId, 'ma');
        assert.equal(result.status, 'succeeded');
      }
    });

    test('WFD 独立复核拒绝算法服务结果中的单行数值篡改', async () => {
      const { result, input } = await computeAndCheck('tampered-ma', 'ma', { period: 3 });
      const original = result.rows[2]!.MA;
      assert.ok(typeof original === 'number');
      result.rows[2]!.MA = original + 1;
      assert.throws(() => checkDerivedForWfd(result, binding, 'tampered-ma', input), {
        code: 'DERIVED_NUMERIC_MISMATCH', message: /第 3 行 MA/u,
      });
    });
  });

test('内置代理规则捕获 v20 并验证旧任务冻结的 v18 和 v19', () => {
  const current: FrozenRunConfiguration = { modelId: null, provider: null, thinkingLevel: 'off', preferenceRevision: null,
    modelConfigurationVersion: null, personaSelectionRevision: 0, agentDisplayName: null, personaRecords: [], personaText: '',
    ...captureInternalAgentRules() };
  assert.equal(current.internalAgentRules?.version, 20);
  assertInternalAgentRules(current);
  assert.ok(current.internalAgentRulesText);

  // v18 到 v20 的前十二条相同，完整历史正文由下列固定摘要约束。
  const boundary = current.internalAgentRulesText.indexOf('\n\n13. **算法边界**');
  assert.ok(boundary > 0);
  const v18 = current.internalAgentRulesText.slice(0, boundary) + '\n';
  const v19 = v18 + '\n13. **算法边界**：当前仅保留固定 12/26/9 MACD，首值初始化且柱值系数为 2。先核 `algorithms.contract`（算法契约）与 `algorithms.capabilities`（当前可用性），输入只能引用已发布 WFD 固定快照。不得调用已移出的均线、财务期间运算、宏观同比或未实现的复权算法，不自行执行外部算法包。计算后须独立核对原输入与结果，经当前用途限制核验后沿同一 R1 请求发布并固定读回；连接变化或结果未知时不得换库、换号或重算绕过。\n';
  for (const [version, digest, text] of [
    [18, 'fb576a22f1942ea217a66180149c737f5388392e32112ec28589a592140d124c', v18],
    [19, '38342f494b3a83fc5f0512c1fd42515a49877ea61f70e62c6ce3089b257ff45c', v19],
  ] as const) {
    assertInternalAgentRules({ ...current, internalAgentRulesText: text,
      internalAgentRules: { id: 'xuan-bd-internal-agent', version, digest } });
  }
});

test('因子库包含 bd.algorithms 的全部可执行日线方法', () => {
  const library = factorLibraryView();
  const methods = ['macd', 'ma', 'ema', 'rsi', 'boll', 'roc', 'obv', 'returns', 'volatility', 'max_drawdown',
    'alpha191_014', 'alpha191_031', 'alpha191_116', 'alpha191_168', 'alpha191_189'];
  assert.deepEqual(ALGORITHM_REGISTRY.filter(item => item.category === 'market').map(({ id }) => id), methods);
  assert.deepEqual(library.items.filter(item => item.category === 'market').map(({ id }) => id), methods);
  assert.equal(library.sharedRegistryWith, 'bd.algorithms');
  assert.partialDeepStrictEqual(library.items, ALGORITHM_REGISTRY);
});

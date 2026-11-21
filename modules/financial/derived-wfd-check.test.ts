import assert from 'node:assert/strict';
import test from 'node:test';
import { ALGORITHM_METHODS, MACD_SEMANTICS, type AlgorithmComputedResult, type AlgorithmData } from './algorithm-types.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';
import { checkR1Cell } from '../collection/r1-tabular.js';
import { buildStructuredIngestDocument, type R1HandoffService } from '../collection/r1-structured-handoff.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import type { R1Runtime } from '../collection/r1-runtime.js';
import type { R1WorkspaceService } from '../collection/r1-workspace.js';
import { DerivedWfdPublisher } from './derived-wfd-publisher.js';
import type { AlgorithmTaskView } from './algorithm-types.js';

const sample = (): AlgorithmComputedResult => ({
  status: 'computed', taskId: 'test-derivation-1', methodId: 'macd',
  methodVersion: ALGORITHM_METHODS.macd.version,
  implementationVersion: 'sha256:' + '1'.repeat(64), inputDigest: 'sha256:' + '2'.repeat(64),
  environment: 'synthetic-test', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' }, computedAt: '2026-11-10T09:00:00Z',
  metadata: { ...frozenInput().metadata },
  coverage: { suppliedRows: 1 },
  eligibility: { input: { status: 'eligible' } },
  rows: [{ timestamp: '2026-11-01', available_at: '2026-11-01T23:59:59Z', DIFF: 0, DEA: 0, MACD: 0, ZERO: 0 }],
  source: { kind: 'wfd_fixed_snapshot', instanceId: 'instance_test',
    productId: 'p_test', snapshotId: 'snap_test',
    definitionRevision: 'def1', fieldMapping: { close: 'close' },
    resolution: { instanceId: 'instance_test', productId: 'p_test', snapshotId: 'snap_test', rowCount: 1,
      fields: { definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' }] },
      envelope: { rows: [{ business_key: 'b_1', subject: { kind: 'instrument', namespace: 'test', id: 's1' },
        observation_time: { status: 'known', precision: 'day', earliest_utc: '2026-11-01T00:00:00Z',
          latest_exclusive_utc: '2026-11-02T00:00:00Z', source_timezone: 'UTC' } }] } } },
}) as unknown as AlgorithmComputedResult;
const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: 'snap_head' };
const frozenInput = (): AlgorithmData => ({ metadata: {
  series_id: 'series-1', subject: 'stock-1', frequency: '1d', timezone: 'UTC',
  price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted',
  adjustment_basis: 'original', window_start: '2026-11-01', window_end: '2026-11-01',
  as_of: '2026-11-10T09:00:00Z', availability_basis: 'explicit_per_bar',
  bar_closed: true, observations_are_consecutive: true, calendar_verification: 'dense', synthetic: true },
  rows: [{ timestamp: '2026-11-01', close: 12.5, available_at: '2026-11-01T23:59:59Z', bar_closed: true }],
});


test('固定算法只做一次独立核对即可生成完整的结构化 WFD 提交记录', () => {
  const valid = checkDerivedForWfd(sample(), binding, 'derived-1', frozenInput());
  const doc = buildStructuredIngestDocument(valid.structured);
  assert.equal(doc.protocol_version, 'wfd.structured-ingest/1.0');
  assert.equal(valid.structured.expectedParentSnapshotId, 'snap_head');
  assert.equal(valid.structured.payload.kind, 'tabular_rows');
  assert.deepEqual(valid.structured.coverage, {
    scope: { input_product: 'p_test', input_snapshot: 'snap_test', range_start: '2026-11-01', range_end: '2026-11-01' },
    basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown',
  });
  const row = (valid.structured.payload.rows as Array<Record<string, unknown>>)[0]!;
  const cells = row.values as Record<string, { data_type: string; value_state: string; value: unknown }>;
  assert.deepEqual(Object.keys(cells), ['DIFF', 'DEA', 'MACD', 'ZERO']);
  assert.deepEqual(cells.MACD, { data_type: 'decimal', value_state: 'valid_value', value: '0' });
  assert.ok(row.business_key);
  assert.equal(valid.source.sha256, wfdSha256(valid.originalBytes));
  assert.equal(valid.structured.definition.measurement_nature, 'derived');
  assert.equal((valid.structured.definition.semantic_context as Record<string, unknown>).content_nature, 'deterministic_derived');
});

test('业务日期与真实固定快照不一致时拒绝入库', () => {
  const invalid = sample();
  invalid.rows[0]!.timestamp = '2026-11-02';
  assert.throws(() => checkDerivedForWfd(invalid, binding, 'derived-1', frozenInput()), (error: unknown) =>
    (error as { code?: string }).code === 'DERIVED_NUMERIC_MISMATCH'
      && /时间/.test(String((error as { message?: string }).message)),
    '独立核验应在原 WFD 时间映射前阻断被篡改的日期');
});

test('合成算法结果不能作为生产数据入 WFD', () => {
  for (const environment of ['synthetic-test', 'local-review'] as const) for (const synthetic of [true, false]) {
    const result = sample(), input = frozenInput();
    result.environment = environment;
    result.metadata.synthetic = input.metadata.synthetic = synthetic;
    const check = () => checkDerivedForWfd(result, { ...binding, mode: 'production' }, 'derived-1', input);
    if (synthetic || environment === 'synthetic-test') assert.throws(check, { code: 'DERIVED_SYNTHETIC_FORBIDDEN' });
    else assert.doesNotThrow(check);
  }
});

function oneRowIndicator(methodId: 'ema' | 'boll' | 'alpha191_168', parameters: AlgorithmComputedResult['parameters'],
  outputs: Record<string, number | null>, close = 12.5) {
  const input = frozenInput(), result = sample();
  input.rows[0]!.close = close;
  const { timestamp, available_at } = input.rows[0]!;
  Object.assign(result, { methodId, methodVersion: ALGORITHM_METHODS[methodId].version, parameters,
    rows: [{ timestamp, available_at, ...outputs }], diagnostics: [] });
  return { result, input, check: () => checkDerivedForWfd(result, binding, 'synthetic-indicator', input) };
}

test('同一天的 BOLL 多列空值须分别有唯一的已知诊断', () => {
  const fields = ALGORITHM_METHODS.boll.outputFields;
  const { result, check } = oneRowIndicator('boll', { period: 2, std_dev: 2 }, Object.fromEntries(fields.map(key => [key, null])));
  const diagnostics = fields.map(output => ({ timestamp: result.rows[0]!.timestamp, output, reason: 'insufficient_warmup' }));
  result.diagnostics = diagnostics;
  const [row] = check().structured.payload.rows as { values: Record<string, { value_state: string; value: null }> }[];
  for (const code of fields) {
    assert.deepEqual(row.values[code], { data_type: 'decimal', value_state: 'insufficient_warmup', value: null });
    checkR1Cell('decimal', row.values[code].value_state, row.values[code].value, code);
  }
  for (const invalid of [[], diagnostics.slice(1), [...diagnostics, diagnostics[0]],
    ...[{ timestamp: '2026-11-02' }, { output: 'OTHER' }, { reason: 'missing_unknown' }].map(change =>
      [{ ...diagnostics[0], ...change }, ...diagnostics.slice(1)])]) {
    result.diagnostics = invalid;
    assert.throws(check, { code: 'DERIVED_NULL_REASON_MISSING' });
  }
});

test('发布半偶舍入处理偶数与奇数中点、进位和次正规数，原算法行逐字保留', () => {
  for (const [close, expected] of [[0.5e-18, '0'], [1.5e-18, '0.000000000000000002'],
    [2.5e-18, '0.000000000000000002'], [9.5e-18, '0.00000000000000001'],
    [Number.MIN_VALUE, '0'], [1e-18, '0.000000000000000001'], [1e37, '1' + '0'.repeat(37)]] as const) {
    const { result, check } = oneRowIndicator('ema', { period: 2, init: 'first_valid' }, { EMA: close }, close);
    const checked = check();
    const [row] = checked.structured.payload.rows as { values: { EMA: { value: string } } }[];
    assert.equal(row.values.EMA.value, expected);
    assert.equal(checked.originalBytes.toString(), canonicalWfdJson(result.rows));
    assert.equal(result.rows[0].EMA, close);
  }
  const tooLarge = oneRowIndicator('ema', { period: 2, init: 'first_valid' }, { EMA: 1e38 }, 1e38);
  assert.throws(tooLarge.check, { code: 'R1_TABULAR_PRECISION' });
  const nonfinite = oneRowIndicator('ema', { period: 2, init: 'first_valid' }, { EMA: Infinity });
  assert.throws(nonfinite.check, { code: 'DERIVED_NUMERIC_MISMATCH' });
});

test('派生端独立拒绝将 turnover/cny 或非数值列映射成成交量', () => {
  const { result, input, check } = oneRowIndicator('alpha191_168', {}, { ALPHA191_168: null });
  result.diagnostics = [{ timestamp: input.rows[0].timestamp, output: 'ALPHA191_168', reason: 'insufficient_warmup' }];
  input.rows[0].volume = 0;
  const source = result.source as { fieldMapping: Record<string, string>; semantics?: { volumeUnit: string };
    resolution: { fields: { definitions: { field_code: string; data_type: string; unit_code: string }[] } } };
  source.fieldMapping.volume = 'turnover';
  const volume = { field_code: 'turnover', data_type: 'decimal', unit_code: 'cny' };
  source.resolution.fields.definitions.push(volume);
  for (const [unit, dataType] of [['cny', 'decimal'], ['volume_cny', 'integer'], ['share', 'text']]) {
    volume.unit_code = result.metadata.volume_unit = input.metadata.volume_unit = unit;
    volume.data_type = dataType;
    source.semantics = { volumeUnit: unit };
    assert.throws(check, { code: 'DERIVED_UNIT_UNKNOWN' });
  }
});

test('缺真实 WFD 行身份及单位时拒绝发布', () => {
  const missing = sample();
  const resolution = (missing.source as Record<string, unknown>).resolution as Record<string, unknown>;
  resolution.envelope = { rows: [] };
  assert.throws(() => checkDerivedForWfd(missing, binding, 'derived-1', frozenInput()), {
    code: 'DERIVED_SOURCE_INVALID',
  });
});

test('独立数值核对拒绝非固定周期', () => {
  const other = sample();
  other.parameters = { ...other.parameters as Record<string, unknown>, signal_period: 10 } as AlgorithmComputedResult['parameters'];
  assert.throws(() => checkDerivedForWfd(other, binding, 'derived-2', frozenInput()), { code: 'DERIVED_NUMERIC_MISMATCH' });
});

test('独立数值核对拒绝计算正确性被篡改的 MACD 输出', () => {
  const altered = sample();
  altered.rows[0]!.MACD = 99;
  assert.throws(() => checkDerivedForWfd(altered, binding, 'derived-bad', frozenInput()), {
    code: 'DERIVED_NUMERIC_MISMATCH',
  });
});

test('派生发布拒绝同编号但实际配置已变化的 WFD 连接', async () => {
  const result = sample();
  const identity = { connectionId: 'instance_test', namespace: binding.namespace, mode: binding.mode,
    configSha256: 'original' } as R1ConnectionIdentity;
  result.source = { ...result.source as Record<string, never>, connectionIdentityDigest: digestOperationArgs(identity) };
  const publisher = new DerivedWfdPublisher({
    viewAlgorithm: () => ({ status: 'succeeded', requiresReview: false, result } as AlgorithmTaskView),
    readAlgorithmInput: frozenInput,
    runtime: () => ({ currentIdentity: () => ({ ...identity, configSha256: 'changed' }) } as R1Runtime),
    workspace: () => ({} as R1WorkspaceService),
    handoff: { attempt() { assert.fail('连接不符时不能查询或创建发布尝试'); } } as unknown as R1HandoffService,
  });
  await assert.rejects(publisher.publish(result.taskId), { code: 'DERIVED_WFD_BINDING_CHANGED' });
});

test('固定派生未送达时沿原号重试并重新核用途，结果未知时仅恢复原号', async () => {
  const result = sample();
  const identity = { connectionId: 'instance_test', namespace: binding.namespace, mode: binding.mode,
    configSha256: 'original' } as R1ConnectionIdentity;
  result.source = { ...result.source as Record<string, never>, connectionIdentityDigest: digestOperationArgs(identity) };
  let attempt: { state: string; requestId: string; local_refs_json: string; document_sha256: string; document_json: string; productId: string } | undefined;
  let suspend = false, sends = 0, recoveries = 0, usageReads = 0;
  const handoff = {
    attempt(requestId: string) {
      if (!attempt) throw new TaskError('R1_ATTEMPT_NOT_FOUND', 'isolated test');
      assert.equal(requestId, attempt.requestId);
      return attempt;
    },
    registerOriginal() { return { originalId: 'synthetic-original' }; },
    prepare({ structured, localRefs }: Parameters<R1HandoffService['prepare']>[0], restriction: unknown) {
      assert.ok(restriction);
      assert.ok(localRefs.fixedAlgorithm);
      attempt = {
        requestId: localRefs.fixedAlgorithm.requestId, state: 'prepared',
        local_refs_json: JSON.stringify(localRefs),
        document_sha256: wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(structured))),
        document_json: canonicalWfdJson(buildStructuredIngestDocument(structured)),
        productId: 'p_' + wfdSha256(canonicalWfdJson(['observations', structured.subject, structured.definition])).slice(0, 24),
      };
    },
    async submitAndAssociate(requestId: string, _client: unknown, _signal: unknown, restriction: unknown) {
      assert.equal(requestId, attempt?.requestId);
      assert.ok(restriction);
      sends++;
      attempt!.state = 'send_failed';
    },
    async recoverStatus(requestId: string) {
      assert.equal(requestId, attempt?.requestId);
      recoveries++;
    },
  } as unknown as R1HandoffService;
  const runtime = { currentIdentity: () => identity, client: {
    async usageStatus() {
      usageReads++;
      return { result: { format_version: 'wfd.usage-suspension/1', tickets: [], active_issues: Number(suspend),
        suspended_record_versions: Number(suspend), issues: suspend ? [{
          issue_id: 'pause', state: 'active', scopes: [{ product_id: attempt!.productId, record_versions: ['rev'], usages: ['publish'] }],
        }] : [] } };
    },
  } } as unknown as R1Runtime;
  const publisher = new DerivedWfdPublisher({
    viewAlgorithm: () => ({ status: 'succeeded', requiresReview: false, result } as AlgorithmTaskView),
    readAlgorithmInput: frozenInput,
    runtime: () => runtime,
    workspace: () => ({ snapshotStatus: async () => ({ snapshotId: binding.expectedParentSnapshotId }) } as R1WorkspaceService),
    handoff,
  });
  assert.equal((await publisher.publish(result.taskId)).state, 'send_failed');
  assert.equal(sends, 1);
  suspend = true;
  await assert.rejects(publisher.publish(result.taskId), { code: 'DERIVED_WFD_USAGE_SUSPENDED' });
  assert.equal(usageReads, 3);
  assert.equal(sends, 1);
  attempt!.state = 'pending_unknown';
  assert.equal((await publisher.publish(result.taskId)).requiresRecovery, true);
  assert.equal(recoveries, 1);
  assert.equal(usageReads, 3);
  assert.equal(sends, 1);
});


/** 按旧版的定义身份构造冻结请求样本。 */
function legacyDocument(result: AlgorithmComputedResult, requestId: string, input = frozenInput()) {
  const document = buildStructuredIngestDocument(checkDerivedForWfd(result, binding, requestId, input).structured);
  const output = (document.outputs as Array<Record<string, unknown>>)[0]!;
  const algorithm = (output.definition as Record<string, unknown>).algorithm_definition as Record<string, unknown>;
  const method = ALGORITHM_METHODS[result.methodId];
  algorithm.result_semantics = result.methodId === 'macd'
    ? '调用既有 12/26/9 MACD 实现，以所供窗口首条收盘价初始化短、长 EMA 与 DEA；返回 DIFF、DEA、MACD 和 ZERO。'
    : `${method.resultSemantics} 本次参数为 ${canonicalWfdJson(result.parameters)}。`;
  algorithm.definition_version = 'v' + wfdSha256(canonicalWfdJson(result.methodId === 'macd' ? { method: result.methodId,
    version: result.methodVersion, implementation: result.implementationVersion } : {
    version: result.methodVersion, semantics: { outputs: method.outputs, resultSemantics: method.resultSemantics },
    parameters: result.parameters,
  })).slice(0, 20);
  return signFrozenDocument(document);
}

function signFrozenDocument(document: ReturnType<typeof buildStructuredIngestDocument>) {
  const unsigned = structuredClone(document);
  delete (unsigned.request_identity as Record<string, unknown>).submission_digest;
  (document.request_identity as Record<string, unknown>).submission_digest = 'sha256:' + wfdSha256(canonicalWfdJson(unsigned));
  return document;
}

test('已有合规 EMA 请求可原样核验，旧请求中的超标十进制不能沿原号重写', () => {
  const params = { period: 2, init: 'first_valid' };
  const { result, input } = oneRowIndicator('ema', params, { EMA: 12.5 });
  const prior = legacyDocument(result, 'frozen-ema', input);
  const recovered = checkDerivedForWfd(result, binding, 'frozen-ema', input, prior);
  assert.deepEqual(buildStructuredIngestDocument(recovered.structured), prior);
  const tiny = oneRowIndicator('ema', params, { EMA: 2.5e-18 }, 2.5e-18);
  const invalid = legacyDocument(tiny.result, 'invalid-ema', tiny.input);
  assert.throws(() => checkDerivedForWfd(tiny.result, binding, 'invalid-ema', tiny.input, invalid),
    { code: 'DERIVED_FROZEN_DOCUMENT_CHANGED' }, '旧版本也不能接受被事后舍入的值');
  const [output] = invalid.outputs as { payload: { rows: { values: { EMA: { value: string } } }[] } }[];
  output.payload.rows[0].values.EMA.value = '0.0000000000000000025';
  signFrozenDocument(invalid);
  assert.throws(() => checkDerivedForWfd(tiny.result, binding, 'invalid-ema', tiny.input, invalid), { code: 'DERIVED_FROZEN_DOCUMENT_CHANGED' });
});

test('implementation changes preserve formal semantics and rows but keep distinct execution evidence', () => {
  const first = sample(), second = structuredClone(first);
  second.implementationVersion = 'sha256:' + 'a'.repeat(64);
  second.taskId = 'different-implementation-task';
  second.computedAt = '2026-11-10T09:01:00Z';
  const left = checkDerivedForWfd(first, binding, 'implementation-first', frozenInput());
  const right = checkDerivedForWfd(second, binding, 'implementation-second', frozenInput());
  assert.deepEqual(left.structured.definition, right.structured.definition);
  assert.equal(left.structured.outputKey, right.structured.outputKey);
  assert.deepEqual(left.structured.payload, right.structured.payload);
  assert.equal(left.sourceSha256, right.sourceSha256);
  assert.notEqual(left.resultSha256, right.resultSha256, 'Execution evidence must remain distinguishable');
  assert.notEqual(left.source.requested_url, right.source.requested_url);
  assert.equal(JSON.stringify(left.structured.definition).includes(first.implementationVersion), false);
  const expected = 'v' + wfdSha256(canonicalWfdJson({ method: first.methodId,
    version: first.methodVersion, semantics: MACD_SEMANTICS })).slice(0, 20);
  assert.equal((left.structured.definition.algorithm_definition as Record<string, unknown>).definition_version, expected);
});

test('changed mathematical version, initialization, result values and input semantics are not implementation-only updates', () => {
  const version = sample(); version.methodVersion = 'unregistered-math-version';
  assert.throws(() => checkDerivedForWfd(version, binding, 'changed-version', frozenInput()), { code: 'DERIVED_METHOD_CHANGED' });
  const seed = sample(); (seed.parameters as Record<string, unknown>).init = 'mean_of_history';
  assert.throws(() => checkDerivedForWfd(seed, binding, 'changed-seed', frozenInput()), { code: 'DERIVED_NUMERIC_MISMATCH' });
  const altered = sample(); altered.implementationVersion = 'sha256:' + 'a'.repeat(64); altered.rows[0]!.DIFF = 1;
  assert.throws(() => checkDerivedForWfd(altered, binding, 'changed-value', frozenInput()), { code: 'DERIVED_NUMERIC_MISMATCH' });
  for (const [key, value] of [['currency', 'USD'], ['timezone', 'Asia/Shanghai'], ['adjustment_basis', 'another-basis']]) {
    const changed = sample(); (changed.metadata as unknown as Record<string, unknown>)[key!] = value;
    assert.throws(() => checkDerivedForWfd(changed, binding, 'changed-input', frozenInput()), { code: 'DERIVED_NUMERIC_MISMATCH' });
  }
});

test('already frozen legacy and semantic-only requests reconstruct their exact document without migration', () => {
  const result = sample();
  const current = buildStructuredIngestDocument(checkDerivedForWfd(result, binding, 'frozen-current', frozenInput()).structured);
  const legacy = legacyDocument(result, 'frozen-legacy'), original = canonicalWfdJson(legacy);
  const checked = checkDerivedForWfd(result, binding, 'frozen-legacy', frozenInput(), legacy);
  assert.deepEqual(buildStructuredIngestDocument(checked.structured), legacy);
  assert.equal(canonicalWfdJson(legacy), original, 'Read conversion never mutates saved declarations');
  assert.deepEqual(buildStructuredIngestDocument(checkDerivedForWfd(result, binding, 'frozen-current', frozenInput(), current).structured), current);
  assert.notEqual((checked.structured.definition.algorithm_definition as Record<string, unknown>).definition_version,
    (checkDerivedForWfd(result, binding, 'new-request', frozenInput()).structured.definition.algorithm_definition as Record<string, unknown>).definition_version,
    'New preparations must not emit the legacy implementation-derived definition identity');
});

test('legacy compatibility rejects changed document, membership, version, values or frozen parent', () => {
  const result = sample(), frozen = legacyDocument(result, 'legacy-bound');
  const altered = structuredClone(frozen);
  altered.expected_parent_snapshot_id = 'another-parent';
  assert.throws(() => checkDerivedForWfd(result, binding, 'legacy-bound', frozenInput(), altered), { code: 'DERIVED_FROZEN_DOCUMENT_CHANGED' });
  const another = sample(); another.implementationVersion = 'sha256:' + 'b'.repeat(64);
  assert.throws(() => checkDerivedForWfd(another, binding, 'legacy-bound', frozenInput(), frozen), { code: 'DERIVED_FROZEN_DEFINITION_CHANGED' });
  const duplicate = structuredClone(frozen); (duplicate.outputs as unknown[]).push((duplicate.outputs as unknown[])[0]);
  assert.throws(() => checkDerivedForWfd(result, binding, 'legacy-bound', frozenInput(), duplicate), { code: 'DERIVED_FROZEN_DEFINITION_CHANGED' });
  const forged = structuredClone(frozen);
  const output = (forged.outputs as Array<Record<string, unknown>>)[0]!;
  const rows = (output.payload as Record<string, unknown>).rows as Array<Record<string, unknown>>;
  (rows[0]!.values as Record<string, unknown>).MACD = { data_type: 'decimal', value_state: 'valid_value', value: '2' };
  assert.throws(() => checkDerivedForWfd(result, binding, 'legacy-bound', frozenInput(), forged), { code: 'DERIVED_FROZEN_DOCUMENT_CHANGED' });
});

test('legacy lost-response recovery reads saved identity, never creates a new attempt or resubmits', async () => {
  const result = sample(), requestId = 'bd-derived:' + wfdSha256(canonicalWfdJson({
    taskId: result.taskId, inputDigest: result.inputDigest, source: result.source,
    method: result.methodId, methodVersion: result.methodVersion, producer: binding.namespace, connection: 'instance_test',
  })).slice(0,48);
  const identity = { connectionId: 'instance_test', namespace: binding.namespace, mode: binding.mode,
    configSha256: 'original' } as R1ConnectionIdentity;
  result.source = { ...result.source as Record<string, never>, connectionIdentityDigest: digestOperationArgs(identity) };
  // The actual request key includes the verified connection digest.
  const actualId = 'bd-derived:' + wfdSha256(canonicalWfdJson({ taskId: result.taskId, inputDigest: result.inputDigest,
    source: result.source, method: result.methodId, methodVersion: result.methodVersion,
    producer: identity.namespace, connection: identity.connectionId })).slice(0,48);
  assert.notEqual(actualId, requestId);
  const document = legacyDocument(result, actualId);
  const checked = checkDerivedForWfd(result, binding, actualId, frozenInput(), document);
  const refs = { originalIds: ['legacy-original'], materialIds: [], sourceRefs: [checked.source], processRefs: [],
    evidenceRefs: [{ ref_id: 'legacy-result', content_sha256: checked.sourceSha256, kind: 'fixed-algorithm-output' }],
    fixedAlgorithm: { taskId: result.taskId, requestId: actualId, resultSha256: checked.resultSha256,
      namespace: binding.namespace, mode: binding.mode, expectedParentSnapshotId: binding.expectedParentSnapshotId } };
  const saved = { state: 'pending_unknown', local_refs_json: JSON.stringify(refs),
    document_json: canonicalWfdJson(document), document_sha256: wfdSha256(canonicalWfdJson(document)) };
  let recovered = 0;
  const publisher = new DerivedWfdPublisher({
    viewAlgorithm: () => ({ status: 'succeeded', requiresReview: false, result } as AlgorithmTaskView),
    readAlgorithmInput: frozenInput,
    runtime: () => ({ currentIdentity: () => identity, client: {} } as R1Runtime),
    workspace: () => ({ snapshotStatus() { assert.fail('Recovery must not select current HEAD'); } } as unknown as R1WorkspaceService),
    handoff: { attempt(id: string) { assert.equal(id, actualId); return saved; },
      async recoverStatus(id: string) { assert.equal(id, actualId); recovered++; },
      prepare() { assert.fail('No new attempt'); }, submitAndAssociate() { assert.fail('Unknown result cannot be resent'); },
    } as unknown as R1HandoffService,
  });
  assert.equal((await publisher.publish(result.taskId)).requiresRecovery, true);
  assert.equal(recovered, 1);
  assert.equal(saved.document_json, canonicalWfdJson(document));
  saved.document_json = '{bad';
  await assert.rejects(publisher.publish(result.taskId));
  assert.equal(recovered, 1, 'Corrupt saved document must not be reinterpreted as a missing request');
});

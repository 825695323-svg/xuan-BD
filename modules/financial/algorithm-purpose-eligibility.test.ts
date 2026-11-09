import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { localAlgorithmConfiguration } from '../../apps/server/financial-configuration.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmCallRequest, AlgorithmSnapshotPort, AlgorithmSnapshotRead, AlgorithmSnapshotReference } from './algorithm-types.js';
import { wfdFixedReadEvidence } from '../collection/purpose-eligibility.js';
import { captureCodeBinding } from './algorithm-service.js';
import { MaterialService } from '../collection/materials/service.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const python = process.env.WFD_PYTHON;
const missing = ['WFD_PYTHON'].filter(key => !process.env[key]);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const product = {
  product_id: 'p_0123456789abcdef01234567',
  contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at', 'system_held_at'] } },
  declaration: { semantic_context: { version_axis: { revision_mode: 'source_correction' } } },
  definition_ref: { version: 'definition-1', digest: 'sha256:' + 'b'.repeat(64) },
  contract_ref: { digest: 'sha256:' + 'c'.repeat(64) },
};
const snapshot = 's_0123456789abcdef01234567';
const reference: AlgorithmSnapshotReference = {
  kind: 'wfd_fixed_snapshot', instanceId: 'isolated-algorithm-eligibility', productId: product.product_id,
  snapshotId: snapshot, definitionRevision: 'definition-1', fields: ['trade_date', 'close', 'available_at'],
  fieldMapping: { timestamp: 'trade_date', close: 'close', available_at: 'available_at' },
  semantics: { subject: 'explicit synthetic fixed series', frequency: '1d', timezone: 'Asia/Shanghai',
    priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'synthetic unadjusted fixture',
    barClosed: true, synthetic: true, availability: { kind: 'column' } },
  calendar: { mode: 'not_verified', note: 'isolated synthetic series' },
  perspective: 'market_known_at', at: '2026-04-30T00:00:00Z',
};
const marchRow = {
  product_id: product.product_id,
  record_ref: { product_id: product.product_id, snapshot_id: snapshot, logical_key: '2025-annual-report', revision_id: 'r_0123456789abcdef01234567' },
  revision: { logical_key: '2025-annual-report', revision_id: 'r_0123456789abcdef01234567', supersedes: null, withdrawn: false, reason: null },
  revision_state: 'current',
  definition_ref: { version: 'definition-1', digest: 'sha256:' + 'b'.repeat(64) },
  contract_ref: { digest: 'sha256:' + 'c'.repeat(64) },
  row: { business_key: '2025-annual-report', trade_date: '2026-03-01',
    close: { value: '10', value_state: 'valid_value', data_type: 'decimal', unit_code: 'cny_per_share' },
    available_at: { value: '2026-03-16T07:00:00Z', value_state: 'valid_value', data_type: 'text', unit_code: 'date' },
    public_time: { status: 'known', precision: 'day', earliest_utc: '2026-03-15T00:00:00Z',
      latest_exclusive_utc: '2026-03-16T00:00:00Z', source_timezone: 'Asia/Shanghai' } },
  eligibility: { decision: 'eligible', reason: 'evidence_interval_ended_before_cutoff' },
};
const mayRow = {
  ...structuredClone(marchRow),
  record_ref: { ...marchRow.record_ref, revision_id: 'r_fedcba9876543210fedcba98' },
  revision: { ...marchRow.revision, revision_id: 'r_fedcba9876543210fedcba98', supersedes: marchRow.record_ref.revision_id },
  revision_state: 'superseded',
  row: { ...marchRow.row, public_time: { status: 'known', precision: 'day', earliest_utc: '2026-05-20T00:00:00Z',
    latest_exclusive_utc: '2026-05-21T00:00:00Z', source_timezone: 'Asia/Shanghai' } },
  eligibility: { decision: 'ineligible', reason: 'time_interval_starts_after_cutoff' },
};

function fakePort(rows: WfdRecord[], governance?: WfdRecord, includeHeld = true): AlgorithmSnapshotPort {
  return {
    status: () => ({ status: 'available', reason: null }),
    async read(input): Promise<AlgorithmSnapshotRead> {
      assert.equal(input.snapshotId, snapshot);
      const result: WfdRecord = { snapshot_id: snapshot, perspective: input.perspective ?? 'snapshot_contents',
        at: input.at ?? null, rows, row_count: rows.length, usage_governance: governance ?? null,
        ...(input.perspective === 'system_held_at' && includeHeld ? { held_scope: input.heldScope ?? null } : {}),
        diagnostics: rows.filter(row => (row.eligibility as WfdRecord | undefined)?.decision !== 'eligible')
          .map(row => ({ ...(row.eligibility as WfdRecord), record_ref: row.record_ref })) };
      const projection = rows.map(row => { const inner = row.row as WfdRecord;
        return { trade_date: String(inner.trade_date), close: String((inner.close as WfdRecord).value),
          available_at: String((inner.available_at as WfdRecord).value) }; });
      const projectionSha = wfdSha256(canonicalWfdJson(projection));
      const evidence = rows.map(row => {
        const bundle = wfdFixedReadEvidence({ objectSha256: projectionSha, product, result,
          row, contentBasis: '隔离测试：实际 fixed_read 读取返回重新核对', checkedAtUtc: new Date().toISOString(),
          usableStage: input.usableStage ?? null });
        return { object: bundle.object, publicationTime: bundle.publicationTime, holdingTime: bundle.holdingTime,
          revision: bundle.revision, wfdHistory: bundle.wfdHistory, restriction: bundle.restriction,
          wfdDecision: bundle.wfdDecision };
      });
      return { reference: input, rows: projection as unknown as Record<string, import('../../contracts/task-contracts.js').JsonValue>[],
        resolution: { snapshot_id: snapshot, perspective: result.perspective ?? null, at: result.at ?? null, rows: rows.length } as unknown as import('../../contracts/task-contracts.js').JsonValue,
        verifiedScope: 'server_identity_descriptor_and_projection', evidence };
    },
  };
}

function configure(root: string) {
  const runtime = join(root, 'runtime'); mkdirSync(runtime);
  const resources: Record<string, unknown> = { python: { kind: 'program', path: realpathSync(python!) } };
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads']) {
    const path = join(runtime, name); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path, owned: true, identity: 'algorithm-eligibility-' + name,
      device: String(stat.dev), inode: String(stat.ino) };
  }
  writeFileSync(join(runtime, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'isolated-algorithm-eligibility' }));
  writeFileSync(join(runtime, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1,
    runtimeIdentity: 'isolated-algorithm-eligibility', resources }));
}

function open(root: string, snapshots?: AlgorithmSnapshotPort) {
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions }), runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, permissions, runtimes });
  const materials = new MaterialService({ database, tasks: () => tasks, files, environment: 'synthetic-test' });
  const resources = new ResourceBindings(join(root, 'runtime'));
  const algorithms = localAlgorithmConfiguration({ projectRoot: codeRoot, resources, environment: 'synthetic-test', enabled: true, snapshots })({
    database, tasks: () => tasks, permissions, materials });
  runtimes.register(materials.runtime); runtimes.register(algorithms.runtime);
  return { database, tasks, materials, algorithms, files, permissions,
    async material(name: string, bytes: Buffer) {
      const path = join(root, name); writeFileSync(path, bytes, { flag: 'wx' });
      const ref = files.register({ path, displayName: name, source: 'user-attached' });
      permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
      const accepted = materials.submit({ fileRefId: ref.id, category: 'data', expectedSha256: sha(bytes) }, 'intake-' + name);
      const done = await tasks.wait(accepted.id); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      return materials.getByTask(done.id)!.envelope;
    },
    async close() { await tasks.dispose(); files.closeTemporaryRetention(); database.close(); } };
}

const csv = Buffer.from('date,close,available_at\n2025-01-01,1.0,2025-01-01T07:00:00Z\n2025-01-02,2.0,2025-01-02T07:00:00Z\n2025-01-03,3.0,2025-01-03T07:00:00Z\n');
const managed = (materialId: string): AlgorithmCallRequest => ({ methodId: 'ma', parameters: { period: 2 },
  source: { kind: 'managed_table', materialId, materialSha256: sha(csv), format: 'csv',
    fieldMapping: { timestamp: 'date', close: 'close', available_at: 'available_at' }, dateFormat: 'YYYY-MM-DD',
    semantics: { subject: 'explicit synthetic series', frequency: '1d', timezone: 'Asia/Shanghai',
      priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'synthetic',
      barClosed: true, synthetic: true, availability: { kind: 'column' } }, calendar: { mode: 'dense' } },
  usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff: '2025-02-01T00:00:00Z', perspective: 'market_known_at' } });

test('本机算法受管表：历史用途必须带真实提交证据；结果保留实际计算时间与回放标记',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-eligibility-')));
    configure(root);
    let host = open(root);
    let persistedTaskId = '';
    try {
      const material = await host.material('source.csv', csv);
      assert.throws(() => host.algorithms.submit('historical-no-evidence', managed(material.materialId)),
        { code: 'ALGORITHM_PURPOSE_EVIDENCE_REQUIRED' });
      const started = host.algorithms.submit('historical-with-operator', managed(material.materialId),
        { authority: 'operator-http', requestId: 'historical-with-operator', observedAtUtc: '2026-04-30T00:00:00Z' });
      persistedTaskId = started.taskId;
      const repeated = host.algorithms.submit('historical-with-operator', managed(material.materialId),
        { authority: 'operator-http', requestId: 'historical-with-operator', observedAtUtc: '2026-04-30T00:00:01Z' });
      assert.equal(repeated.taskId, started.taskId, '用途证据受理时间不同不应造成同一请求冲突');
      const review = await settle(host.tasks, started.taskId);
      if (review.status === 'waiting_approval' && review.approvalId) host.tasks.approve(review.approvalId);
      const done = review.status === 'waiting_approval' ? await host.tasks.wait(started.taskId) : review;
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const view = host.algorithms.view(started.taskId);
      const result = view.result!;
      assert.equal(result.eligibility?.input.status, 'eligible', JSON.stringify(result.eligibility?.input.gaps));
      assert.equal(result.eligibility?.input.history.mode, 'market_known_at');
      assert.equal(result.eligibility?.result.historyUse, 'replay');
      assert.ok(result.eligibility?.result.gaps.some(gap => gap.code === 'REPLAY_COMPUTED_AFTER_CUTOFF'));
      assert.equal(result.eligibility?.result.timings?.latestInputAvailableAtUtc, '2025-01-03T07:00:00Z');
      assert.ok(result.computedAt >= '2026-11-07T00:00:00Z');
      assert.deepEqual(result.rows.map(row => row.MA), [null, 1.5, 2.5]);
    } finally { await host.close(); }
    host = open(root);
    try {
      const reopened = host.algorithms.view(persistedTaskId).result!;
      assert.equal(reopened.eligibility?.result.historyUse, 'replay');
      assert.equal(reopened.computedAt, JSON.parse(host.database.connection.prepare('SELECT result_json FROM algorithm_calls WHERE task_id=?').get(persistedTaskId)!.result_json as string).computedAt);
    } finally { await host.close(); }
  });

test('本机算法固定快照：4月历史只接受3月版本，5月修订与暂停证据不得放行',
  { timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-snapshot-eligibility-')));
    configure(root);
    const request = (cutoff: string): AlgorithmCallRequest => ({ methodId: 'ma', parameters: { period: 1 },
      source: { kind: 'fixed_snapshot', reference: { ...reference, at: cutoff } },
      usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff, perspective: 'market_known_at' } });
    let host = open(root, fakePort([marchRow]));
    try {
      const submitted = host.algorithms.submit('snapshot-march-april', request('2026-04-30T00:00:00Z'),
        { authority: 'operator-http', requestId: 'snapshot-march-april', observedAtUtc: '2026-04-30T00:00:00Z' });
      const review = await settle(host.tasks, submitted.taskId);
      if (review.status === 'waiting_approval' && review.approvalId) host.tasks.approve(review.approvalId);
      const done = review.status === 'waiting_approval' ? await host.tasks.wait(submitted.taskId) : review;
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const result = host.algorithms.view(submitted.taskId).result!;
      assert.equal(result.eligibility?.input.status, 'eligible', JSON.stringify(result.eligibility?.input.gaps));
      assert.equal(result.eligibility?.input.checks.find(check => check.id === 'wfd_row_eligibility')?.status, 'pass');
      assert.equal(result.eligibility?.result.historyUse, 'replay');
      assert.equal(result.eligibility?.result.timings?.latestInputAvailableAtUtc, '2026-03-16T07:00:00Z');
    } finally { await host.close(); }

    host = open(root, fakePort([mayRow]));
    try {
      const submitted = host.algorithms.submit('snapshot-may-april', request('2026-04-30T00:00:00Z'),
        { authority: 'operator-http', requestId: 'snapshot-may-april', observedAtUtc: '2026-04-30T00:00:00Z' });
      const done = await settle(host.tasks, submitted.taskId);
      assert.ok(['PURPOSE_ELIGIBILITY_INELIGIBLE', 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION'].includes(String(done.error?.code)), JSON.stringify(done.error));
    } finally { await host.close(); }

    host = open(root, fakePort([marchRow], { publishable: false, compute_eligible: false, audit_reproduction: false,
      known_issues: [{ issue_id: 'CASE-1', reason: 'synthetic suspension' }] }));
    try {
      const current: AlgorithmCallRequest = { methodId: 'ma', parameters: { period: 1 },
        source: { kind: 'fixed_snapshot', reference: { ...reference, perspective: 'snapshot_contents', at: undefined } } };
      const submitted = host.algorithms.submit('snapshot-restricted', current);
      const done = await settle(host.tasks, submitted.taskId);
      assert.equal(done.error?.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE', JSON.stringify(done.error));
      assert.match(String(done.error?.message), /USAGE_RESTRICTED/);
    } finally { await host.close(); }
  });


test('受管表只有 bar_close 声明、缺公开字段或回执时不得取得历史资格',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-bar-close-')));
    configure(root);
    const host = open(root);
    try {
      const closeOnly = Buffer.from('date,close\n2025-01-01,1.0\n2025-01-02,2.0\n2025-01-03,3.0\n');
      const material = await host.material('close-only.csv', closeOnly);
      const call: AlgorithmCallRequest = { methodId: 'ma', parameters: { period: 2 },
        source: { kind: 'managed_table', materialId: material.materialId, materialSha256: sha(closeOnly), format: 'csv',
          fieldMapping: { timestamp: 'date', close: 'close' }, dateFormat: 'YYYY-MM-DD',
          semantics: { subject: 'synthetic close-only series', frequency: '1d', timezone: 'Asia/Shanghai',
            priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'synthetic',
            barClosed: true, synthetic: true, availability: { kind: 'bar_close', closeTime: '15:00:00' } },
          calendar: { mode: 'dense' } },
        usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff: '2025-02-01T00:00:00Z', perspective: 'market_known_at' } };
      const submitted = host.algorithms.submit('bar-close-no-public-evidence', call,
        { authority: 'operator-http', requestId: 'bar-close-no-public-evidence', observedAtUtc: '2026-04-30T00:00:00Z' });
      const done = await settle(host.tasks, submitted.taskId);
      assert.equal(done.error?.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE', JSON.stringify(done.error));
      assert.match(String(done.error?.message), /DECLARED_BAR_CLOSE_NOT_PUBLIC_EVIDENCE/);
    } finally { await host.close(); }
  });

test('system_held_at 实际参数与持有证据贯通后可由共用规则判定',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-held-')));
    configure(root);
    const heldRow = { ...structuredClone(marchRow), held_at: '2026-03-20T00:00:00Z',
      held_scope: 'received_structured', usable_stage: 'published_readable' };
    const host = open(root, fakePort([heldRow]));
    try {
      const heldReference = { ...reference, perspective: 'system_held_at' as const, at: '2026-04-30T00:00:00Z',
        heldScope: 'received_structured', usableStage: 'published_readable' as const };
      const call: AlgorithmCallRequest = { methodId: 'ma', parameters: { period: 1 },
        source: { kind: 'fixed_snapshot', reference: heldReference },
        usage: { purpose: 'historical_compute', historyMode: 'system_held_at', cutoff: '2026-04-30T00:00:00Z', perspective: 'system_held_at' } };
      const submitted = host.algorithms.submit('system-held-wired', call,
        { authority: 'operator-http', requestId: 'system-held-wired', observedAtUtc: '2026-04-30T00:00:00Z' });
      const review = await settle(host.tasks, submitted.taskId);
      if (review.status === 'waiting_approval' && review.approvalId) host.tasks.approve(review.approvalId);
      const done = review.status === 'waiting_approval' ? await host.tasks.wait(submitted.taskId) : review;
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      const input = host.algorithms.view(submitted.taskId).result!.eligibility!.input;
      assert.equal(input.status, 'eligible', JSON.stringify(input.gaps));
      assert.equal(input.checks.find(check => check.id === 'holding_time')?.status, 'pass');
      assert.match(String(input.checks.find(check => check.id === 'holding_time')?.detail), /2026-03-20T00:00:00Z|持有时间/u);
      assert.equal(input.checks.find(check => check.id === 'wfd_history_support')?.status, 'pass');
      assert.equal(host.algorithms.view(submitted.taskId).result!.eligibility!.result.timings?.latestInputAvailableAtUtc, '2026-03-20T00:00:00Z');
    } finally { await host.close(); }
  });

async function settle(tasks: TaskService, id: string) {
  const terminal = (task: { status: string }) => ['succeeded', 'failed', 'cancelled', 'needs_review', 'waiting_approval'].includes(task.status);
  const current = tasks.get(id); if (terminal(current)) return current;
  return await new Promise<Awaited<ReturnType<TaskService['get']>>>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('task did not settle: ' + id)); }, 60_000);
    const unsubscribe = tasks.subscribe(({ task }) => { if (task.id === id && terminal(task)) { clearTimeout(timer); unsubscribe(); resolve(task); } });
  });
}


test('system_held_at 缺逐行 held_at 时保持未知，不用查询 cutoff 或请求 stage 补事实',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-held-missing-')));
    configure(root);
    const host = open(root, fakePort([marchRow], undefined, false));
    try {
      const referenceWithoutProof = { ...reference, perspective: 'system_held_at' as const, at: '2026-04-30T00:00:00Z',
        heldScope: 'received_structured', usableStage: 'published_readable' as const };
      const call: AlgorithmCallRequest = { methodId: 'ma', parameters: { period: 1 },
        source: { kind: 'fixed_snapshot', reference: referenceWithoutProof },
        usage: { purpose: 'historical_compute', historyMode: 'system_held_at', cutoff: '2026-04-30T00:00:00Z', perspective: 'system_held_at' } };
      const submitted = host.algorithms.submit('system-held-missing-fact', call,
        { authority: 'operator-http', requestId: 'system-held-missing-fact', observedAtUtc: '2026-04-30T00:00:00Z' });
      const done = await settle(host.tasks, submitted.taskId);
      assert.equal(done.status, 'failed', JSON.stringify(done.error));
      assert.equal(done.error?.code, 'PURPOSE_ELIGIBILITY_INSUFFICIENT', JSON.stringify(done.error));
      assert.match(String(done.error?.message), /HOLDING_TIME_UNKNOWN|HOLDING_SCOPE_UNKNOWN/);
    } finally { await host.close(); }
  });

test('U05：算法执行源码摘要包含共用规则与快照适配器', () => {
  const binding = captureCodeBinding();
  assert.match(binding.version, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Object.hasOwn(binding.files, 'purpose-eligibility.ts'));
  assert.ok(Object.hasOwn(binding.files, 'product-machine-snapshot.ts'));
  assert.ok(Object.hasOwn(binding.files, 'algorithm-service.ts'));
});

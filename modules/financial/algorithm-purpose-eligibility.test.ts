import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmCallRequest, AlgorithmSnapshotPort, AlgorithmSnapshotRead, AlgorithmSnapshotReference } from './algorithm-types.js';
import { wfdFixedReadEvidence } from '../collection/purpose-eligibility.js';
import { LocalAlgorithmService, captureCodeBinding } from './algorithm-service.js';
import { MaterialService } from '../collection/materials/service.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { TaskRuntimeRegistry, TaskService, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { ConversationAlgorithmBridge } from './conversation-algorithms.js';
import { createWfdProductMachineSnapshotPort } from './product-machine-snapshot.js';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
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
  const pythonExecutable = realpathSync(python!);
  permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: pythonExecutable } }] });
  const algorithms = new LocalAlgorithmService({
    database, tasks: () => tasks, permissions, snapshots, processRuntime: new ProcessRuntime(resources),
    pythonExecutable, computeAssetsRoot: join(codeRoot, 'plugins/financial/local-compute/assets'),
    environment: 'synthetic-test', enabled: true,
  });
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
const managed = (materialId: string): AlgorithmCallRequest => ({ methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
  source: { kind: 'managed_table', materialId, materialSha256: sha(csv), format: 'csv',
    fieldMapping: { timestamp: 'date', close: 'close', available_at: 'available_at' }, dateFormat: 'YYYY-MM-DD',
    semantics: { subject: 'explicit synthetic series', frequency: '1d', timezone: 'Asia/Shanghai',
      priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'synthetic',
      barClosed: true, synthetic: true, availability: { kind: 'column' } }, calendar: { mode: 'dense' } },
  usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff: '2025-02-01T00:00:00Z', perspective: 'market_known_at' } });

test('WFD-only 计算入口拒绝受管表，即使有真实用户用途授权也不创建历史任务',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-eligibility-')));
    configure(root);
    const host = open(root);
    try {
      const material = await host.material('source.csv', csv);
      const call = managed(material.materialId);
      const before = host.database.connection.prepare('SELECT count(*) AS n FROM tasks WHERE runtime_id=?')
        .get('bd.algorithms')?.n;
      assert.throws(() => host.algorithms.submit('retired-method', { ...call, methodId: 'retired' }), { code: 'INVALID_ALGORITHM_METHOD' });
      assert.throws(() => host.algorithms.submit('historical-no-evidence', call), {
        code: 'ALGORITHM_WFD_ONLY',
      });
      assert.throws(() => host.algorithms.submit('historical-with-operator', call,
        { authority: 'operator-http', requestId: 'historical-with-operator', observedAtUtc: '2026-04-30T00:00:00Z' }), {
        code: 'ALGORITHM_WFD_ONLY',
      }, '授权声明不能重新启用已经退出的原件直接计算路线');
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks WHERE runtime_id=?')
        .get('bd.algorithms')?.n, before, '被拒绝的请求不能产生计算任务');
    } finally { await host.close(); }
  });

test('历史计算及 status 仅向模型返回原因计数，完整未来修订仅在原任务审计中', { skip: !python }, async () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'historical-preview-')));
  configure(root);
  const cutoff = reference.at!, reason = 'time_interval_starts_after_cutoff';
  const diagnostics = Array.from({ length: 65 }, (_, i) => ({ decision: 'ineligible', reason,
    revision_id: 'r_future_' + i, business_key: 'future-key-' + i, subject: { id: 'future-subject' } }));
  const observations = [{ ...marchRow, row: { ...marchRow.row, values: { close: marchRow.row.close,
    available_at: marchRow.row.available_at, trade_date: { value_state: 'valid_value', value: marchRow.row.trade_date } },
    observation_time: { ...marchRow.row.public_time, earliest_utc: '2026-02-28T16:00:00Z', latest_exclusive_utc: '2026-03-01T16:00:00Z' } } }];
  const selectedProduct = { ...product, payload_kind: 'tabular_rows', declaration: {
    field_definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' },
      ...['trade_date', 'available_at'].map(field_code => ({ field_code, data_type: 'text', unit_code: 'date' }))],
    semantic_context: { ...product.declaration.semantic_context, version: 'wfd.semantic-context/1.0', time: { frequency: 'day', timezone: 'Asia/Shanghai',
      roles: { observation: 'trade_date', availability: 'available_at', bar_closed: 'true' } },
      financial: { price_adjustment: { direction: 'raw' } } } } };
  const client = {
    discover: async () => ({ result: { products: [selectedProduct] }, transport: { operation: 'contract_discovery' } }),
    read: async () => ({ result: { snapshot_id: snapshot, perspective: 'market_known_at', at: cutoff,
      rows: observations, row_count: observations.length, diagnostics }, transport: { operation: 'fixed_read' } }),
  } as unknown as WfdProductMachineClient;
  const host = open(root, createWfdProductMachineSnapshotPort({ instanceId: reference.instanceId, client }));
  try {
    const origin = { conversationId: 'synthetic', branchId: 'history', parentRunId: 'preview' } as ModelTaskOrigin;
    const bridge = new ConversationAlgorithmBridge({ database: host.database, origin: () => origin, rulesVersion: () => 21,
      submissionContext: () => ({ authority: 'operator-http', requestId: 'history-purpose', observedAtUtc: cutoff }),
      companion: { algorithms: host.algorithms, tasks: host.tasks, derivedPublisher: { publish: async () => ({ published: false,
        state: 'not_requested' }) } } as unknown as WorkspaceServices });
    const request = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
      source: { kind: 'fixed_snapshot', reference: { ...reference, semantics: { ...reference.semantics,
        adjustmentBasis: 'WFD financial.price_adjustment.direction=raw' } } },
      usage: { purpose: 'historical_compute', historyMode: 'market_known_at', perspective: 'market_known_at', cutoff } };
    async function invoke(action: string, args: object, id: string) {
      const context = { task: { id, action, args }, signal: new AbortController().signal, assertAuthorized() {} } as unknown as TaskExecutionContext;
      const { data } = await bridge.execute(context);
      const preview = (data as { modelPreview: { taskId: string; status: string;
        error: { code: string; message: string } | null; result: { source: { resolution: {
          historicalRead: { historicalExclusions: { excludedCount: number; byReason: WfdRecord } } } } } | null } }).modelPreview;
      assert.doesNotMatch(JSON.stringify(preview), /r_future|future-key|future-subject/u);
      return preview;
    }
    for (const expected of ['succeeded', 'failed']) {
      const calculated = await invoke('algorithms.calculate', { calculationJson: JSON.stringify(request) }, 'calculate-' + expected);
      assert.equal(calculated.status, expected, JSON.stringify(calculated.error));
      const status = await invoke('algorithms.status', { taskId: calculated.taskId }, 'status-' + expected);
      assert.equal(status.status, expected);
      for (const preview of [calculated, status]) {
        const summary = preview.result?.source.resolution.historicalRead.historicalExclusions ?? JSON.parse(preview.error!.message);
        assert.equal(summary.excludedCount, 65);
        assert.deepEqual(summary.byReason, { [reason]: 65 });
      }
      if (expected === 'succeeded') {
        const persisted = host.algorithms.view(calculated.taskId).result!;
        const audit = persisted.source as { resolution: { historicalRead: { diagnostics: unknown[] } } };
        assert.deepEqual(audit.resolution.historicalRead.diagnostics, diagnostics);
        observations.length = 0;
      } else {
        assert.equal(status.error?.code, 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION');
        assert.doesNotMatch(host.tasks.get(calculated.taskId).error!.message, /r_future|future-key|future-subject/u);
        const callAudit = host.database.connection.prepare('SELECT state,raw_result_json,raw_result_digest FROM algorithm_calls WHERE task_id=?').get(calculated.taskId) as
          { state: string; raw_result_json: string | null; raw_result_digest: string | null };
        assert.equal(callAudit.state, 'failed');
        assert.ok(callAudit.raw_result_json && callAudit.raw_result_digest);
        const parsedAudit = JSON.parse(callAudit.raw_result_json);
        assert.equal(parsedAudit.kind, 'historical_no_eligible_version');
        assert.deepEqual(parsedAudit.diagnostics, diagnostics);
        const legacy = JSON.stringify({ diagnostics: diagnostics.slice(0, 64) });
        for (const message of [legacy, legacy.slice(0, 180)]) {
          host.database.connection.prepare('UPDATE tasks SET error=? WHERE id=?').run(
            JSON.stringify({ code: status.error!.code, message }), calculated.taskId);
          const old = await invoke('algorithms.status', { taskId: calculated.taskId }, 'legacy-status');
          assert.equal(old.error?.code, status.error!.code);
        }
        diagnostics.splice(0, diagnostics.length, { decision: 'indeterminate', reason: 'INSTANCE_HOLDING_COVERAGE_GAP',
          revision_id: 'r_future_indeterminate', subject: { id: 'future-subject' } } as typeof diagnostics[number]);
        const incomplete = await invoke('algorithms.calculate', { calculationJson: JSON.stringify(request) }, 'calculate-indeterminate-zero');
        assert.equal(incomplete.error?.code, 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE');
        assert.doesNotMatch(JSON.stringify(incomplete), /r_future|future-subject/u);
        const incompleteAudit = host.database.connection.prepare('SELECT state,raw_result_json,raw_result_digest FROM algorithm_calls WHERE task_id=?')
          .get(incomplete.taskId) as { state: string; raw_result_json: string | null; raw_result_digest: string | null };
        assert.equal(incompleteAudit.state, 'failed');
        assert.ok(incompleteAudit.raw_result_json && incompleteAudit.raw_result_digest);
        assert.equal(JSON.parse(incompleteAudit.raw_result_json).kind, 'historical_snapshot_incomplete');
        assert.deepEqual(JSON.parse(incompleteAudit.raw_result_json).diagnostics, diagnostics);
      }
    }
  } finally { await host.close(); }
});

test('本机算法固定快照：4月历史只接受3月版本，5月修订与暂停证据不得放行',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-snapshot-eligibility-')));
    configure(root);
    const request = (cutoff: string): AlgorithmCallRequest => ({ methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
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
      assert.deepEqual(result.rows.map(({ DIFF, DEA, MACD, ZERO }) => [DIFF, DEA, MACD, ZERO]), [[0, 0, 0, 0]]);
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
      if (done.error?.code === 'PURPOSE_ELIGIBILITY_INELIGIBLE') {
        assert.doesNotMatch(done.error.message, /r_synthetic_may|"checks"|"timings"|2026-05-/u);
        const parsedErr = JSON.parse(done.error.message) as { history: { mode: string; cutoff: string; perspective: string; historical: boolean } };
        assert.equal(parsedErr.history.mode, 'market_known_at');
        assert.equal(parsedErr.history.cutoff, '2026-04-30T00:00:00Z');
        assert.equal(parsedErr.history.perspective, 'market_known_at');
        assert.equal(parsedErr.history.historical, true);
        const auditRow = host.database.connection.prepare('SELECT raw_result_json,raw_result_digest FROM algorithm_calls WHERE task_id=?')
          .get(submitted.taskId) as { raw_result_json: string | null; raw_result_digest: string | null };
        assert.ok(auditRow.raw_result_json && auditRow.raw_result_digest);
        assert.ok(Array.isArray(JSON.parse(auditRow.raw_result_json).checks));
        const origin = { conversationId: 'c1', branchId: 'b1', parentRunId: 'r1' } as ModelTaskOrigin;
        const bridge = new ConversationAlgorithmBridge({ database: host.database, origin: () => origin, rulesVersion: () => 21,
          companion: { algorithms: host.algorithms, tasks: host.tasks, derivedPublisher: { publish: async () => ({ published: false,
            state: 'not_requested' }) } } as unknown as WorkspaceServices });
        host.database.connection.prepare('INSERT INTO conversation_algorithm_links VALUES(?,?,?,?,?)')
          .run(submitted.taskId, 'local-may', 'calculate', JSON.stringify(origin), Date.now());
        const statusReply = await bridge.execute({ task: { id: 'status-may', action: 'algorithms.status', args: { taskId: submitted.taskId } },
          signal: new AbortController().signal, assertAuthorized() {} } as unknown as TaskExecutionContext);
        assert.doesNotMatch(JSON.stringify(statusReply), /r_synthetic_may|"checks"|"timings"|2026-05-/u);
        const statusErr = JSON.parse(((statusReply.data as { modelPreview: { error: { message: string } } }).modelPreview).error.message);
        assert.deepEqual(statusErr.history, { mode: 'market_known_at', cutoff: '2026-04-30T00:00:00Z', perspective: 'market_known_at', historical: true });
      }
    } finally { await host.close(); }

    host = open(root, fakePort([marchRow], { publishable: false, compute_eligible: false, audit_reproduction: false,
      known_issues: [{ issue_id: 'CASE-1', reason: 'synthetic suspension' }] }));
    try {
      const current: AlgorithmCallRequest = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
        source: { kind: 'fixed_snapshot', reference: { ...reference, perspective: 'snapshot_contents', at: undefined } } };
      const submitted = host.algorithms.submit('snapshot-restricted', current);
      const done = await settle(host.tasks, submitted.taskId);
      assert.equal(done.error?.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE', JSON.stringify(done.error));
      assert.match(String(done.error?.message), /USAGE_RESTRICTED/);
      const origin = { conversationId: 'c-cur', branchId: 'b-cur', parentRunId: 'r-cur' } as ModelTaskOrigin;
      const bridge = new ConversationAlgorithmBridge({ database: host.database, origin: () => origin, rulesVersion: () => 21,
        companion: { algorithms: host.algorithms, tasks: host.tasks, derivedPublisher: { publish: async () => ({ published: false,
          state: 'not_requested' }) } } as unknown as WorkspaceServices });
      host.database.connection.prepare('INSERT INTO conversation_algorithm_links VALUES(?,?,?,?,?)')
        .run(submitted.taskId, 'local-cur', 'calculate', JSON.stringify(origin), Date.now());
      const curStatus = await bridge.execute({ task: { id: 'status-cur', action: 'algorithms.status', args: { taskId: submitted.taskId } },
        signal: new AbortController().signal, assertAuthorized() {} } as unknown as TaskExecutionContext);
      const curPreview = JSON.parse(((curStatus.data as { modelPreview: { error: { message: string } } }).modelPreview).error.message);
      assert.ok(Array.isArray(curPreview.checks) && curPreview.purpose === 'current_compute');
    } finally { await host.close(); }
  });


test('只有 bar_close（收盘时间声明）的原件，不能绕过 WFD 固定读取取得历史资格',
  { skip: missing.length ? `未显式选择 ${missing.join('、')}` : false, timeout: 90_000 }, async () => {
    const parent = process.env.XUAN_ALGORITHM_ELIGIBILITY_ROOT ?? process.env.XUAN_TEST_ROOT ?? tmpdir();
    const root = realpathSync(mkdtempSync(join(parent, 'algorithm-bar-close-')));
    configure(root);
    const host = open(root);
    try {
      const closeOnly = Buffer.from('date,close\n2025-01-01,1.0\n2025-01-02,2.0\n2025-01-03,3.0\n');
      const material = await host.material('close-only.csv', closeOnly);
      const call: AlgorithmCallRequest = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
        source: { kind: 'managed_table', materialId: material.materialId, materialSha256: sha(closeOnly), format: 'csv',
          fieldMapping: { timestamp: 'date', close: 'close' }, dateFormat: 'YYYY-MM-DD',
          semantics: { subject: 'synthetic close-only series', frequency: '1d', timezone: 'Asia/Shanghai',
            priceUnit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'synthetic',
            barClosed: true, synthetic: true, availability: { kind: 'bar_close', closeTime: '15:00:00' } },
          calendar: { mode: 'dense' } },
        usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff: '2025-02-01T00:00:00Z', perspective: 'market_known_at' } };
      assert.throws(() => host.algorithms.submit('bar-close-no-public-evidence', call,
        { authority: 'operator-http', requestId: 'bar-close-no-public-evidence', observedAtUtc: '2026-04-30T00:00:00Z' }),
      { code: 'ALGORITHM_WFD_ONLY' });
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks WHERE runtime_id=?')
        .get('bd.algorithms')?.n ?? 0, 0);
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
      const call: AlgorithmCallRequest = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
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
      const call: AlgorithmCallRequest = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
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

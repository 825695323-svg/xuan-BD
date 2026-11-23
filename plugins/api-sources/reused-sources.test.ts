import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import iconv from 'iconv-lite';
import test from 'node:test';
import type { JsonValue, TaskRecord, TaskResult } from '../../contracts/task-contracts.js';
import { readSourceReceiptFromTask } from '../../modules/collection/endpoint-adapter-registry.js';
import type { pinnedRequest } from '../../platform/capabilities/browser/public-web.js';
import { SourceSettingsService } from '../../platform/config/source-settings.js';
import type { TaskExecutionContext, TaskOperation } from '../../platform/jobs/tasks.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { directoryCapability } from '../../platform/runtime/file-workspace.js';
import { PermissionService, type PermissionCapability } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createSourceRuntime } from './runtime.js';

// 所有响应、证券、日期和请求预算都是合成夹具。只替换 HTTP/DNS 传输，
// 真实使用现有来源配置、权限、任务上下文、文件引用与暂存/发布管路，不访问线上。
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const daily = { symbol: '600001.SH', start: '2026-01-05', end: '2026-01-06', adjustment: 'none', limit: 2 };
const dailyBytes = bytes({ data: { timestamp: [Date.parse('2026-01-05T00:00:00+08:00'), Date.parse('2026-01-06T00:00:00+08:00')],
  open: [10, 11], high: [12, 12], low: [9, 10], close: [11, 11.5], volume: [101, null] } });
const reports = { category: 'stock', symbol: '600001.SH', start: '2026-01-01', end: '2026-01-31', page: 1, pageSize: 1 };
const reportBytes = bytes({ hits: 2, TotalPage: 2, pageNo: 1, data: [{ infoCode: 'AP202601050001', stockCode: '600001',
  title: 'synthetic report', publishDate: '2026-01-05 14:23:45.123', attachPages: null }] });
const argsOf = (operation: string, parameters: Record<string, JsonValue>) => ({ scopeId: 'CN/A_STOCK', operation, parameters: JSON.stringify(parameters) });
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

function fixture(responseBytes: Buffer, status = 200) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-reused-source-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  database.connection.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,action TEXT,args TEXT,status TEXT,result TEXT,versions TEXT,conversation_id TEXT);
    CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL);`);
  const permissions = new PermissionService({ database, isRunActive: () => true });
  const files = new FileReferenceService({ database, permissions });
  permissions.grant({ capabilities: (['read', 'write', 'delete'] as const).map(action => directoryCapability(action, artifactRoot)) });
  for (const origin of ['https://free-api.tickflow.org', 'https://reportapi.eastmoney.com', 'https://data.eastmoney.com', 'https://fuyao.aicubes.cn', 'https://push2his.eastmoney.com', 'https://www.sse.com.cn'])
    permissions.grant({ capabilities: [{ action: 'network', target: { kind: 'network', origin } }] });
  // 明确隔离档案路径，不能承接用户本机默认凭据引用。
  const settings = new SourceSettingsService(join(root, 'sources.json'), database, undefined, join(root, 'absent-connections.json'));
  const initial = settings.get();
  settings.update({ ...initial, execution: { ...initial.execution, minimumIntervalMs: 0 },
    plugins: initial.plugins.map(plugin => ['tickflow', 'eastmoney', 'ths'].includes(plugin.id) ? { ...plugin, enabled: true } : plugin),
    connections: initial.connections.map(connection => ({ ...connection, credential: null,
      ...(connection.pluginId === 'tickflow' ? { enabled: true } : {}) })),
    operationPolicies: [
      { scopeId: 'CN/A_STOCK', operationId: 'daily_bars', primary: 'tickflow-main', backups: [] },
      { scopeId: 'CN/A_STOCK', operationId: 'research_reports', primary: 'eastmoney-main', backups: [] },
      { scopeId: 'CN/A_STOCK', operationId: 'financial_statements', primary: 'ths-finance-api', backups: [] },
    ] });
  const calls: Parameters<typeof pinnedRequest>[0][] = [];
  const events: Parameters<TaskExecutionContext['emit']>[0][] = [];
  const capabilities: PermissionCapability[] = [];
  const state: { headers?: Record<string, string>; beforeBody?: () => void; closed: number;
    responseForCall?: (request: Parameters<typeof pinnedRequest>[0]) => { bytes: Buffer; status: number } } = { closed: 0 };
  const runtime = createSourceRuntime({ settings, files, artifactRoot, network: {
    // 只供 injected transport 使用的合成公开地址，不实际解析或连接此地址。
    resolve: async (_host, signal) => { signal.throwIfAborted(); return [{ address: '8.8.8.8', family: 4 }]; },
    transport: async request => {
      request.assertAuthorized(); request.signal.throwIfAborted(); calls.push(request);
      const selected = state.responseForCall?.(request) ?? { status, bytes: responseBytes };
      return { status: selected.status, headers: { 'content-type': 'application/json; charset=utf-8', ...state.headers },
        body: (async function* () { state.beforeBody?.(); yield selected.bytes; })(),
        close: async () => { state.closed += 1; } };
    },
  } });
  function context(action: string, args: Record<string, JsonValue>): TaskExecutionContext {
    const runId = 'run-fixture', attemptId = 'attempt-fixture', generation = 1;
    const operationScope = (operation: TaskOperation) => ({ ...operation, runId, attemptId, generation });
    const task: TaskRecord = { id: 'task-fixture', title: '合成来源接线验证', conversationId: null, runtimeId: 'direct', action, args,
      requestId: 'request-fixture', ownerRole: 'personal', subject: null, parentTaskId: null,
      versions: { directConfiguration: hash(JSON.stringify(runtime.configuration(action, args))) },
      budgetScope: 'synthetic-fixture', deadlineAt: null, controlGeneration: null, status: 'running', currentRunId: runId,
      currentAttemptId: attemptId, generation, checkpoint: null, result: null, resultRef: null, error: null, approvalId: null,
      requiresReview: false, dependencyIds: [], blockedReason: null, reviewRequired: false, sequence: 1, version: 1, createdAt: 0, updatedAt: 0 };
    database.connection.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(task.id, action, JSON.stringify(args), task.status, null, JSON.stringify(task.versions), null);
    database.connection.prepare('INSERT INTO task_runs VALUES(?,?)').run(runId, task.id);
    return { task, runId, attemptId, generation, controlGeneration: null, signal: new AbortController().signal,
      operationScope, consumeBudget: () => { throw new Error('Unexpected model budget use in a fixed source route'); }, emit: async event => { events.push(event); },
      assertAuthorized(operation, requestedCapabilities, authorization) {
        capabilities.push(...requestedCapabilities);
        return permissions.assertAuthorized(operationScope(operation), requestedCapabilities, authorization);
      },
      requestApproval: async () => { throw new Error('Unexpected approval request in isolated source fixture'); },
    };
  }
  function completed(context: TaskExecutionContext, result: TaskResult) {
    database.connection.prepare("UPDATE tasks SET status='succeeded',result=? WHERE id=?").run(JSON.stringify(result), context.task.id);
    const stored = database.connection.prepare('SELECT action,status,result,versions FROM tasks WHERE id=?').get(context.task.id)!;
    return readSourceReceiptFromTask({ action: String(stored.action), runtimeId: context.task.runtimeId, status: String(stored.status),
      versions: JSON.parse(String(stored.versions)), result: JSON.parse(String(stored.result)), requiresReview: false }, ['direct']);
  }
  const read = (id: string): Buffer => {
    const ref = files.verify(id);
    assert.equal(dirname(ref.invocationPath), artifactRoot);
    return readFileSync(ref.invocationPath);
  };
  return { root, artifactRoot, database, permissions, settings, files, runtime, calls, events, capabilities, state, context, completed, read,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('TickFlow executes the existing kline route and preserves originals, projection, receipt and candidate feedback', async () => {
  const f = fixture(dailyBytes);
  try {
    const args = argsOf('daily_bars', daily), context = f.context('source.kline.read', args);
    const registration = f.runtime.registrations.find(item => item.action === 'source.kline.read')!;
    registration.validate!(args);
    const result = await f.runtime.execute(context, 'source.kline.read', args), data = result.data as Record<string, any>;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url.hostname, 'free-api.tickflow.org');
    assert.equal(f.calls[0]!.url.searchParams.get('adjust'), 'none');
    assert.equal(f.calls[0]!.method, 'GET');
    assert.equal(f.calls[0]!.body, undefined);
    assert.ok(!f.capabilities.some(capability => capability.action === 'secret'));
    assert.equal(data.status, 'downloaded');
    assert.equal(data.sourceId, 'tickflow');
    assert.equal(data.dailyValidation.recordCount, 2);
    assert.equal(data.dailyValidation.volumeUnit, 'native_unverified');
    const raw = data.sourceReceipts[0];
    assert.equal(raw.sha256, hash(dailyBytes));
    assert.deepEqual(f.read(raw.fileRefId), dailyBytes);
    const projection = JSON.parse(f.read(data.dailyValidation.projectionRef).toString('utf8'));
    assert.equal(projection.rows[0].volume, 101);
    assert.equal(projection.rows[0].amount, null);
    assert.equal(projection.rows[0].trade_date, daily.start);
    assert.equal(data.candidateFeedback.observation.rowCount, 2);
    assert.equal(data.candidateFeedback.coverage.completeness, 'not_established');
    assert.equal(data.candidateFeedback.publication, 'not_requested');
    assert.equal(data.candidateFeedback.next, 'return_to_agents');
    assert.ok(result.artifactIds?.some(id => f.files.getRef(id).displayName.endsWith('receipt.json')));
    assert.equal(f.completed(context, result)?.receipts[0]?.sha256, hash(dailyBytes));
    assert.equal(f.state.closed, 1);
  } finally { f.close(); }
});

test('Eastmoney stock reports use controlled POST without secrets and produce an issuer-readable receipt', async () => {
  const f = fixture(reportBytes);
  try {
    const args = argsOf('research_reports', reports), context = f.context('source.api.read', args);
    f.runtime.registrations.find(item => item.action === 'source.api.read')!.validate!(args);
    const result = await f.runtime.execute(context, 'source.api.read', args), data = result.data as Record<string, any>;
    assert.equal(f.calls.length, 1);
    const sent = f.calls[0]!;
    assert.equal(sent.url.href, 'https://reportapi.eastmoney.com/report/list2');
    assert.equal(sent.method, 'POST');
    assert.equal(JSON.parse(sent.body!).code, '600001');
    assert.equal(JSON.parse(sent.body!).beginTime, reports.start);
    assert.ok(!f.capabilities.some(capability => capability.action === 'secret'));
    assert.equal(sent.headers?.['X-api-key'], undefined);
    assert.equal(data.sourceReceipts[0].method, 'POST');
    assert.equal(data.sourceReceipts[0].requestBodySha256, hash(sent.body!));
    assert.deepEqual(f.read(data.sourceReceipts[0].fileRefId), reportBytes);
    const projected = JSON.parse(f.read(data.projection.projectionRef).toString('utf8'));
    assert.equal(projected.rows[0].publish_time_raw, '2026-01-05 14:23:45.123');
    assert.equal(projected.rows[0].raw.publishDate, '2026-01-05 14:23:45.123');
    assert.deepEqual(data.candidateFeedback.evidence.subject, { requested_symbol: reports.symbol, stock_codes: ['600001'],
      subject_verified: false, subjectVerification: 'code_prefix_only_exchange_unverified' });
    assert.equal(data.pagination.nextPage, 2);
    assert.equal(data.pagination.total, 2);
    assert.equal(data.candidateFeedback.publication, 'not_requested');
    const receipt = f.completed(context, result);
    assert.equal(receipt?.operation, 'research_reports');
    assert.equal(receipt?.receipts[0]?.connectionId, 'eastmoney-main');
    assert.equal(receipt?.receipts[0]?.sha256, hash(reportBytes));
    assert.equal(f.state.closed, 1);
  } finally { f.close(); }
});

test('Missing Fuyao credentials fail before transport and cannot invoke an enabled but unselected source', async () => {
  const f = fixture(reportBytes);
  try {
    f.permissions.grant({ capabilities: [{ action: 'secret', target: { kind: 'secret', name: 'api-source.ths-finance-api' } }] });
    const args = argsOf('financial_statements', { thscode: '600001.SH', statement: 'income', period: 'quarterly', limit: 2 });
    const context = f.context('source.api.read', args);
    await assert.rejects(f.runtime.execute(context, 'source.api.read', args), code('SOURCE_NO_ELIGIBLE_CONNECTION'));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.settings.checks().map(item => item.id), ['ths-finance-api']);
    assert.ok(f.events.some(event => event.type === 'progress' && event.message.includes('凭据')));
  } finally { f.close(); }
});

test('HTTP 429 stops at headers, even with gzip, partial or oversized bodies and a configured backup', async () => {
  for (const headers of [{}, { 'content-encoding': 'gzip' }, { 'content-range': 'bytes 0-1/10', 'content-length': '99999999' }]) {
    const f = fixture(Buffer.from([0xff]), 429);
    try {
      f.state.headers = headers as Record<string, string>;
      f.state.beforeBody = () => assert.fail('429 response body consumed');
      const current = f.settings.get();
      f.settings.update({ ...current, operationPolicies: current.operationPolicies.map(policy => policy.operationId === 'daily_bars'
        ? { ...policy, backups: ['eastmoney-main'] } : policy) });
      const args = argsOf('daily_bars', daily), context = f.context('source.kline.read', args);
      await assert.rejects(f.runtime.execute(context, 'source.kline.read', args), code('SOURCE_RATE_LIMITED'));
      assert.equal(f.calls.length, 1); assert.equal(f.state.closed, 1);
      assert.ok(f.events.some(event => event.type === 'side_effect_result' && String(event.evidence).includes('429')));
      assert.equal(f.files.getRefs({ taskId: context.task.id }).length, 0);
    } finally { f.close(); }
  }
});

test('A disabled provider does not call transport; changing connection identity during a response stops processing', async () => {
  for (const mode of ['disabled', 'identity_changed', 'disabled_during_read'] as const) {
    const f = fixture(dailyBytes);
    try {
      const mutate = () => {
        const current = f.settings.get();
        f.settings.update(mode === 'identity_changed' ? { ...current, connections: current.connections.map(connection => connection.id === 'tickflow-main'
          ? { ...connection, scopes: ['CN/A_STOCK', 'HK/STOCK'] } : connection) }
          : { ...current, plugins: current.plugins.map(plugin => plugin.id === 'tickflow' ? { ...plugin, enabled: false } : plugin) });
      };
      if (mode === 'disabled') mutate(); else {
        const current = f.settings.get();
        f.settings.update({ ...current, operationPolicies: current.operationPolicies.map(policy => policy.operationId === 'daily_bars'
          ? { ...policy, backups: ['eastmoney-main'] } : policy) });
        f.state.beforeBody = mutate;
      }
      const args = argsOf('daily_bars', daily), context = f.context('source.kline.read', args);
      await assert.rejects(f.runtime.execute(context, 'source.kline.read', args), code(mode === 'disabled' ? 'SOURCE_NO_ELIGIBLE_CONNECTION' : 'SOURCE_CONFIGURATION_CHANGED'));
      assert.equal(f.calls.length, mode === 'disabled' ? 0 : 1);
      assert.ok(!f.files.getRefs({ taskId: context.task.id }).some(ref => ref.displayName.endsWith('daily-projection.json')));
      assert.equal(f.state.closed, mode === 'disabled' ? 0 : 1);
    } finally { f.close(); }
  }
});

test('A successful configured fallback owns candidate evidence while the failed primary original stays retained', async () => {
  const failedPrimary = bytes({ data: { ...JSON.parse(dailyBytes.toString()).data, volume: [] } });
  const backup = bytes({ rc: 0, data: { code: '600001', market: 1, fqt: 0,
    klines: ['2026-01-05,10.00,11.00,12.00,9.00,101,1001'] } });
  const f = fixture(failedPrimary);
  try {
    const current = f.settings.get();
    f.settings.update({ ...current, operationPolicies: current.operationPolicies.map(policy => policy.operationId === 'daily_bars'
      ? { ...policy, backups: ['eastmoney-main'] } : policy) });
    f.state.responseForCall = request => ({ status: 200, bytes: request.url.hostname === 'free-api.tickflow.org' ? failedPrimary : backup });
    const args = argsOf('daily_bars', daily), context = f.context('source.kline.read', args);
    const result = await f.runtime.execute(context, 'source.kline.read', args), data = result.data as Record<string, any>;
    assert.deepEqual(f.calls.map(call => call.url.hostname), ['free-api.tickflow.org', 'push2his.eastmoney.com']);
    assert.equal(data.actualSource, 'eastmoney-main');
    assert.equal(data.sourceReceipts.length, 2);
    assert.deepEqual(f.read(data.sourceReceipts[0].fileRefId), failedPrimary);
    assert.deepEqual(f.read(data.sourceReceipts[1].fileRefId), backup);
    for (const [index, raw] of data.sourceReceipts.entries()) {
      const attempt = data.attempts[index];
      assert.equal(attempt.connectionId, raw.connectionId);
      assert.equal(attempt.fileRefId, raw.fileRefId);
      assert.equal(attempt.sha256, raw.sha256);
      assert.ok(f.files.getRef(raw.fileRefId).displayName.includes(`attempt-${index + 1}-`));
    }
    assert.equal(data.dailyValidation.rawSha256, hash(backup));
    assert.deepEqual(data.candidateFeedback.evidence.originalRefs, [{ fileRefId: data.sourceReceipts[1].fileRefId, sha256: hash(backup) }]);
    assert.equal(data.candidateFeedback.actualSource.providerId, 'eastmoney');
    assert.equal(f.state.closed, 2);
  } finally { f.close(); }
});

test('Legacy settings add a disabled TickFlow once; explicit removal stays adopted across replay and reopen', () => {
  const f = fixture(dailyBytes);
  try {
    const current = f.settings.get();
    const historical = { ...current, plugins: current.plugins.filter(plugin => plugin.id !== 'tickflow'),
      connections: current.connections.filter(connection => connection.pluginId !== 'tickflow'),
      operationPolicies: current.operationPolicies.filter(policy => policy.operationId !== 'daily_bars') };
    writeFileSync(f.settings.path, JSON.stringify(historical) + '\n');
    const historicalBytes = readFileSync(f.settings.path);
    const migrated = f.settings.get();
    assert.equal(migrated.plugins.find(plugin => plugin.id === 'tickflow')?.enabled, false);
    assert.equal(migrated.connections.find(connection => connection.pluginId === 'tickflow')?.enabled, false);
    assert.deepEqual(readFileSync(f.settings.path), historicalBytes, 'Read migration does not rewrite historical settings');
    const removal = { ...migrated, connections: migrated.connections.filter(connection => connection.pluginId !== 'tickflow') };
    const saved = f.settings.update(removal, 'fixture-remove-tickflow');
    assert.ok(!saved.connections.some(connection => connection.pluginId === 'tickflow'));
    assert.equal(f.settings.operation('fixture-remove-tickflow')?.status, 'adopted');
    assert.equal(f.settings.operation('fixture-remove-tickflow')?.actualMatches, true);
    const savedBytes = readFileSync(f.settings.path);
    assert.equal(f.settings.update(removal, 'fixture-remove-tickflow').revision, saved.revision);
    assert.deepEqual(readFileSync(f.settings.path), savedBytes, 'Idempotent replay neither regenerates stub nor rewrites file');
    const reopened = new SourceSettingsService(f.settings.path, f.database, undefined, join(f.root, 'absent-connections.json'));
    assert.ok(!reopened.get().connections.some(connection => connection.pluginId === 'tickflow'));
    assert.equal(reopened.operation('fixture-remove-tickflow')?.status, 'adopted');
    assert.equal(reopened.operation('fixture-remove-tickflow')?.actualMatches, true);
  } finally { f.close(); }
});

// 两个独立合成引用允许备用真正入选，不接触用户的凭据文件或钥匙串。
function configureThs(f: ReturnType<typeof fixture>, secret: string, operationId: 'financial_statements' | 'index_constituents' | 'daily_bars',
  scopeId = 'CN/A_STOCK') {
  const config = f.settings.get(), primary = config.connections.find(connection => connection.pluginId === 'ths')!;
  const path = join(f.root, 'synthetic-refs.json');
  writeFileSync(path, JSON.stringify({ refs: { FIRST: secret, SECOND: 'synthetic-secondary' } }), { mode: 0o600 });
  primary.scopes = [scopeId, 'CN/A_STOCK'].filter((value, index, all) => all.indexOf(value) === index);
  primary.credential = { kind: 'dsh-ref', path, ref: 'FIRST' };
  const backup = { ...primary, id: 'ths-fixture-backup', credential: { ...primary.credential, ref: 'SECOND' } };
  config.connections.push(backup);
  config.operationPolicies = config.operationPolicies.filter(item => item.operationId !== operationId);
  config.operationPolicies.push({ scopeId, operationId, primary: primary.id, backups: [backup.id] });
  f.settings.update(config);
  for (const connection of [primary, backup]) f.permissions.grant({
    capabilities: [{ action: 'secret', target: { kind: 'secret', name: 'api-source.' + connection.id } }] });
}
const financial = { thscode: '600001.SH', statement: 'income', period: 'quarterly', limit: 2 };

test('Fuyao HTTP business rate limits and in-flight changes terminate before a second distinct account', async () => {
  for (const changed of [false, true]) {
    const f = fixture(bytes({ code: 4001 }), 503);
    try {
      configureThs(f, 'synthetic-only', 'financial_statements');
      if (changed) f.state.beforeBody = () => {
        const current = f.settings.get();
        current.connections.find(item => item.id === 'ths-finance-api')!.scopes.push('HK/STOCK');
        f.settings.update(current);
      };
      const args = argsOf('financial_statements', financial), context = f.context('source.api.read', args);
      await assert.rejects(f.runtime.execute(context, 'source.api.read', args), code(changed ? 'SOURCE_CONFIGURATION_CHANGED' : 'SOURCE_RATE_LIMITED'));
      assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  }
});

test('Fuyao compressed HTTP errors with unverifiable business codes stop before the backup account', async () => {
  for (const businessCode of [4001, 5000]) {
    const f = fixture(gzipSync(bytes({ code: businessCode })), 503);
    try {
      configureThs(f, 'synthetic-only', 'financial_statements');
      f.state.headers = { 'content-encoding': 'gzip' };
      const args = argsOf('financial_statements', financial);
      await assert.rejects(f.runtime.execute(f.context('source.api.read', args), 'source.api.read', args),
        code('SOURCE_RATE_LIMIT_UNVERIFIABLE'));
      assert.equal(f.calls.length, 1);
      assert.equal(f.state.closed, 1);
    } finally { f.close(); }
  }
});

test('Fuyao decodable HTTP service errors retain the configured fallback', async () => {
  const f = fixture(bytes({ code: 0, data: { item: [] } }));
  try {
    configureThs(f, 'synthetic-only', 'financial_statements');
    f.state.responseForCall = () => f.calls.length === 1 ? { bytes: bytes({ code: 5000 }), status: 503 }
      : { bytes: bytes({ code: 0, data: { item: [] } }), status: 200 };
    const args = argsOf('financial_statements', financial);
    await f.runtime.execute(f.context('source.api.read', args), 'source.api.read', args);
    assert.equal(f.calls.length, 2);
  } finally { f.close(); }
});

test('Credential echoes in raw text, URL encodings and JSON strings leave only restricted response metadata', async () => {
  const key = 'synthetic/"key +x';
  const spellings = [key, encodeURIComponent(key).replaceAll('%2F', '%2f'), new URLSearchParams({ k: key }).toString().slice(2),
    JSON.stringify(key).slice(1, -1), [...key].map(char => '\u005c' + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')];
  for (const spelling of spellings) {
    const body = Buffer.from('untrusted ' + spelling);
    const f = fixture(body, 403);
    try {
      configureThs(f, key, 'financial_statements');
      const args = argsOf('financial_statements', financial), context = f.context('source.api.read', args);
      await assert.rejects(f.runtime.execute(context, 'source.api.read', args), code('SOURCE_RESPONSE_CREDENTIAL_ECHO'));
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.events.at(-1), { type: 'checkpoint', checkpoint: { restrictedResponse: {
        status: 403, sha256: hash(body), byteLength: body.length, disposition: 'withheld_credential_echo' } } });
      assert.equal(f.files.getRefs({ taskId: context.task.id }).length, 0);
      for (const tokens of spellings) assert.ok(!JSON.stringify([f.events, f.settings.checks()]).includes(tokens));
    } finally { f.close(); }
  }
});

test('Fuyao existing daily and constituent actions read the declared charset and retain configured scope', async () => {
  const raw = iconv.encode(JSON.stringify({ code: 0, data: { item: ['中文'] } }), 'gbk');
  for (const operation of ['daily_bars', 'index_constituents'] as const) {
    const f = fixture(raw);
    try {
      configureThs(f, 'synthetic-only', operation, 'global');
      f.state.headers = { 'content-type': 'application/json; charset=gbk' };
      const args = { ...argsOf(operation, operation === 'daily_bars' ? { thscode: '600001.SH', start: 1, end: 2 } : { thscode: '000300.SH' }), scopeId: 'global' };
      const result = await f.runtime.execute(f.context('source.api.read', args), 'source.api.read', args);
      const data = result.data as Record<string, any>;
      assert.equal(data.scopeId, 'global');
      assert.deepEqual(f.read(data.sourceReceipts[0].fileRefId), raw);
      assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  }
});

test('An oversized local report projection leaves the source original and never calls a configured backup', async () => {
  const raw = bytes({ data: [{ infoCode: 'AP202601050001', title: 'x'.repeat(1100000) }] });
  const f = fixture(raw);
  try {
    const current = f.settings.get(), primary = current.connections.find(item => item.id === 'eastmoney-main')!;
    current.connections.push({ ...primary, id: 'eastmoney-backup' });
    current.operationPolicies.find(item => item.operationId === 'research_reports')!.backups = ['eastmoney-backup'];
    f.settings.update(current);
    const args = argsOf('research_reports', reports), context = f.context('source.api.read', args);
    await assert.rejects(f.runtime.execute(context, 'source.api.read', args), code('SOURCE_ARTIFACT_PUBLICATION_FAILED'));
    assert.equal(f.calls.length, 1);
    const refs = f.files.getRefs({ taskId: context.task.id });
    assert.equal(refs.length, 1);
    assert.deepEqual(f.read(refs[0].id), raw);
    assert.ok(!f.events.some(event => event.type === 'progress'));
  } finally { f.close(); }
});

test('Fuyao persists distinct upstream authentication and permission errors without adding arbitrary code text to diagnostics', async () => {
  for (const [status, business, expected] of [[401, 2001, 'SOURCE_UNAUTHORIZED'], [403, 2003, 'SOURCE_FORBIDDEN'],
    [200, 'synthetic-untrusted-upstream-text', 'SOURCE_BUSINESS_ERROR']] as const) {
    const f = fixture(bytes({ code: business }), status);
    try {
      configureThs(f, 'fixture-secret', 'financial_statements');
      const check = await f.runtime.check('ths-finance-api');
      assert.equal(check.status, 'blocked');
      if (typeof business === 'string') assert.ok(!check.reason.includes(business));
      else assert.ok(check.reason.includes(String(business)));
      const args = argsOf('financial_statements', financial);
      await assert.rejects(f.runtime.execute(f.context('source.api.read', args), 'source.api.read', args), code('SOURCE_NO_ELIGIBLE_CONNECTION'));
      const failures = f.events.filter(event => event.type === 'progress' && (event.data as { code?: string })?.code === expected);
      assert.equal(failures.length, 2);
    } finally { f.close(); }
  }
});


test('source.fetch 真实下载分支的产物、预览及任务回执共享登记操作，可直接签发适配证据', async () => {
  for (const [sourceId, operation, params] of [
    ['eastmoney', 'minute_bars', { symbol: '600001.SH', start: '20260105', end: '20260106' }],
    ['official_web', 'official_document', { url: 'https://www.sse.com.cn/synthetic.pdf' }],
  ] as const) {
    const f = fixture(bytes({ synthetic: true }));
    try {
      const args = { sourceId, scopeId: 'CN/A_STOCK', parameters: JSON.stringify(params) };
      const context = f.context('source.fetch', args);
      const result = await f.runtime.execute(context, 'source.fetch', args), data = result.data as Record<string, any>;
      const stored = JSON.parse(f.read(result.artifactIds!.at(-1)!).toString('utf8'));
      assert.equal(data.operation, operation); assert.equal(data.modelPreview.operation, operation); assert.equal(stored.operation, operation);
      const evidence = f.completed(context, result);
      assert.equal(evidence?.operation, operation); assert.equal(evidence?.observedAt, stored.observedAt);
      assert.ok(Date.parse(stored.observedAt)); assert.equal(evidence?.market, 'cn-a-share');
      assert.equal(evidence?.receipts[0]?.fileRefId, data.sourceReceipts[0].fileRefId);
    } finally { f.close(); }
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicWebRequestHeaders } from '../../platform/capabilities/browser/public-web.js';
import { buildApiReadRequest } from './api-read.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SourceConnection } from '../../contracts/source-settings.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import { SourceSettingsService } from '../../platform/config/source-settings.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { AuthorizationReceipt } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { publicKlineProviders } from './public-kline.js';
import { createSourceRuntime } from './runtime.js';
import { sourceRequestKey } from './source-acquisition.js';
import { sourceCandidateFeedback, sourceOperations } from './operations.js';
import { thsSource } from './providers/ths/api.js';

const providerBase = (id: 'eastmoney' | 'sina' | 'tencent'): string => publicKlineProviders.find(item => item.id === id)!.baseUrl;

/** 只使用全新临时设置文件与内存数据库；不读取、不写入真实来源设置。 */
function isolatedSettings(): { root: string; settings: SourceSettingsService } {
  const root = mkdtempSync(join(tmpdir(), 'source-routing-'));
  const settings = new SourceSettingsService(join(root, 'source-settings.json'), new CoreDatabase(':memory:'));
  const base = settings.get(), value = structuredClone(base);
  const connections: SourceConnection[] = [
    { id: 'tdx-primary', pluginId: 'tdx', alias: '通达信 · 主', enabled: true, baseUrl: 'tdxaidata://data-service', credential: null, scopes: ['CN/A_STOCK', 'HK/STOCK'], tdxMode: 'data_service' },
    { id: 'ths-scope-backup', pluginId: 'ths', alias: '同花顺 · 范围备用', enabled: true, baseUrl: thsSource.apiBaseUrl, credential: null, scopes: ['CN/A_STOCK', 'HK/STOCK'] },
    { id: 'eastmoney-disabled', pluginId: 'eastmoney', alias: '东方财富 · 停用', enabled: false, baseUrl: providerBase('eastmoney'), credential: null, scopes: ['CN/A_STOCK', 'HK/STOCK'] },
    { id: 'sina-disabled', pluginId: 'sina', alias: '新浪 · 停用', enabled: false, baseUrl: providerBase('sina'), credential: null, scopes: ['CN/A_STOCK', 'HK/STOCK'] },
    { id: 'tencent-disabled', pluginId: 'tencent', alias: '腾讯 · 停用', enabled: false, baseUrl: providerBase('tencent'), credential: null, scopes: ['CN/A_STOCK', 'HK/STOCK'] },
  ];
  value.connections = connections;
  value.policies = base.policies.map(policy => policy.scopeId === 'US/STOCK'
    ? { ...policy, mode: 'inherit', primary: null, backups: [] }
    : { ...policy, mode: 'override', primary: 'tdx-primary', backups: ['ths-scope-backup'] });
  // 中国A股分钟K线使用操作例外：完整替换范围组合，并显式拒绝任何备用。
  value.operationPolicies = [{ scopeId: 'CN/A_STOCK', operationId: 'minute_bars', primary: 'tdx-primary', backups: [] }];
  settings.update(value);
  return { root, settings };
}

function runtimeContext(): TaskExecutionContext {
  const task: TaskRecord = {
    id: 'task-source-routing', title: '来源路由测试', conversationId: null, runtimeId: 'direct', action: 'source.kline.read',
    args: {}, requestId: 'request-source-routing', ownerRole: 'personal', subject: null, parentTaskId: null,
    versions: { directConfiguration: 'frozen-for-test' }, budgetScope: 'test', deadlineAt: null, controlGeneration: null,
    status: 'running', currentRunId: 'run-source-routing', currentAttemptId: 'attempt-source-routing', generation: 1,
    checkpoint: null, result: null, resultRef: null, error: null, approvalId: null, requiresReview: false, dependencyIds: [],
    blockedReason: null, reviewRequired: false, sequence: 1, version: 1, createdAt: 0, updatedAt: 0,
  };
  return {
    task, runId: 'run-source-routing', attemptId: 'attempt-source-routing', generation: 1, controlGeneration: null,
    signal: new AbortController().signal,
    emit: async () => {},
    consumeBudget: () => { throw new Error('unused'); },
    operationScope: () => { throw new Error('unused'); },
    assertAuthorized: () => ({ approvalId: null } as unknown as AuthorizationReceipt),
    requestApproval: async () => { throw new Error('unused'); },
  };
}

const sourceCode = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

test('显式空备用与操作覆盖不会从范围或可选池补备', () => {
  const { root, settings } = isolatedSettings();
  try {
    assert.deepEqual(settings.operationCandidates('CN/A_STOCK', 'minute_bars').map(connection => connection.id), ['tdx-primary']);
    assert.throws(() => settings.assertOperationFallbackEnabled('ths-scope-backup', 'CN/A_STOCK', 'minute_bars'),
      (error: unknown) => sourceCode(error) === 'SOURCE_NOT_CONFIGURED');
    assert.throws(() => settings.assertOperationFallbackEnabled('eastmoney-disabled', 'CN/A_STOCK', 'minute_bars'),
      (error: unknown) => sourceCode(error) === 'SOURCE_DISABLED');
    // 香港范围没有操作例外，明确列出的范围备用仍是合法备用。
    assert.equal(settings.assertOperationFallbackEnabled('ths-scope-backup', 'HK/STOCK', 'minute_bars').id, 'ths-scope-backup');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('分钟K线执行只遍历明确选中的主备，不追加未入选连接', async () => {
  const { root, settings } = isolatedSettings();
  try {
    const artifactRoot = join(root, 'artifacts');
    mkdirSync(artifactRoot, { recursive: true });
    const runtime = createSourceRuntime({ settings, files: {} as FileReferenceService, artifactRoot });
    await assert.rejects(
      runtime.execute(runtimeContext(), 'source.kline.read', { scopeId: 'CN/A_STOCK', operation: 'minute_bars', parameters: '{}' }),
      (error: unknown) => sourceCode(error) === 'SOURCE_NO_ELIGIBLE_CONNECTION',
    );
    assert.deepEqual(settings.checks().map(check => check.id), ['tdx-primary']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('来源操作目录同时确定可见功能与执行器', () => {
  assert.equal(sourceOperations('ths').find(item => item.id === 'index_constituents')?.run.action, 'source.api.read');
  assert.equal(sourceOperations('tdx').find(item => item.id === 'minute_bars')?.run.action, 'source.fetch');
  assert.deepEqual(sourceOperations('tdx').find(item => item.id === 'minute_bars')?.run,
    { action: 'source.fetch', sourceId: 'tdx' });
  for (const id of ['eastmoney', 'sina', 'tencent', 'tickflow']) {
    for (const operation of sourceOperations(id).filter(item => item.id === 'daily_bars' || item.id === 'minute_bars'))
      assert.equal(operation.run.action, 'source.kline.read');
  }
  assert.equal(sourceOperations('eastmoney').find(item => item.id === 'research_reports')?.run.action, 'source.api.read');
  assert.equal(sourceOperations('ths').find(item => item.id === 'financial_statements')?.run.action, 'source.api.read');
});

test('公开行情检查只核对登记状态，不会使用同花顺凭据或发出真实请求', async () => {
  const { root, settings } = isolatedSettings();
  try {
    const value = structuredClone(settings.get());
    value.connections = value.connections.map(connection => ['eastmoney', 'sina', 'tencent'].includes(connection.pluginId)
      ? { ...connection, enabled: true } : connection);
    settings.update(value);
    const runtime = createSourceRuntime({ settings, files: {} as FileReferenceService, artifactRoot: join(root, 'artifacts') });
    for (const id of ['eastmoney-disabled', 'sina-disabled', 'tencent-disabled']) {
      const check = await runtime.check(id);
      assert.equal(check.status, 'partial');
      assert.equal(check.reachable, null);
      assert.equal(check.authorized, null);
      assert.equal(check.capabilityAvailable, null);
      assert.match(check.reason, /尚未发起真实读取/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('来源设置视图操作清单与唯一目录一致，不遗漏同花顺指数成分', async () => {
  const { root, settings } = isolatedSettings();
  try {
    const view = await settings.view();
    for (const plugin of view.apiPlugins) {
      assert.deepEqual(plugin.operations, sourceOperations(plugin.id), `来源 ${plugin.id} 的页面目录必须与运行目录相同`);
    }
    assert.ok(view.apiPlugins.find(plugin => plugin.id === 'ths')?.operations.some(operation => operation.id === 'index_constituents'));
    assert.deepEqual(view.supportedApiOperations.map(operation => operation.id),
      ['daily_bars', 'index_constituents', 'financial_statements', 'research_reports', 'research_report_detail']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('主源与历史备用资格共用校验，停用、显式空备用、市场范围规则保持一致', () => {
  const { root, settings } = isolatedSettings();
  const outcome = (check: () => SourceConnection) => {
    try { return { id: check().id }; } catch (error) { return { code: sourceCode(error) }; }
  };
  try {
    for (const [connection, scope] of [['tdx-primary', 'CN/A_STOCK'], ['ths-scope-backup', 'CN/A_STOCK'],
      ['eastmoney-disabled', 'CN/A_STOCK'], ['tdx-primary', 'US/STOCK'], ['tdx-primary', 'MISSING']] as const) {
      assert.deepEqual(outcome(() => settings.assertOperationFallbackEnabled(connection, scope, 'minute_bars')),
        outcome(() => settings.assertOperationConnectionEnabled(connection, scope, 'minute_bars')));
    }
    const current = settings.get();
    settings.update({ ...current, plugins: current.plugins.map(plugin => plugin.id === 'tdx' ? { ...plugin, enabled: false } : plugin) });
    assert.equal(outcome(() => settings.assertOperationFallbackEnabled('tdx-primary', 'CN/A_STOCK', 'minute_bars')).code, 'SOURCE_DISABLED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('one logical source request retains actual provider evidence without asserting completeness or WFD adoption', () => {
  const base = {
    scopeId: 'CN/A_STOCK', operationId: 'daily_bars' as const,
    acquiredAtUtc: '2026-11-14T00:00:00Z', subjectId: '600519.SH',
    start: '2026-01-01', end: '2026-01-31', adjustment: 'none',
    rowCount: 3, actualStart: '2026-01-05', actualEnd: '2026-01-07',
    originals: [{ fileRefId: 'current-source-file', sha256: 'a'.repeat(64) }],
  };
  const eastmoney = sourceCandidateFeedback({ ...base, providerId: 'eastmoney', connectionId: 'primary' });
  const tencent = sourceCandidateFeedback({ ...base, providerId: 'tencent', connectionId: 'secondary' });
  assert.deepEqual(eastmoney.logicalRequest, tencent.logicalRequest,
    'Logical request is not provider ID or transport version');
  assert.notDeepEqual(eastmoney.actualSource, tencent.actualSource,
    'Independent acquisition and provider evidence must not be collapsed');
  assert.equal(eastmoney.contract, 'bd.source-candidate-feedback/1');
  assert.equal(eastmoney.observation.state, 'rows_observed');
  assert.equal(eastmoney.coverage.completeness, 'not_established',
    'Three observed rows are not proof of all expected trading days');
  assert.equal(eastmoney.semanticStatus, 'not_verified');
  assert.equal(eastmoney.publication, 'not_requested');
  assert.equal(eastmoney.next, 'return_to_agents');
  assert.equal(eastmoney.evidence.originalRefs[0]!.sha256, 'a'.repeat(64));
});

test('empty response, raw-only source, and missing evidence are never reported as success with complete data', () => {
  const base = { scopeId: 'CN/A_STOCK', operationId: 'daily_bars' as const,
    providerId: 'eastmoney', connectionId: 'daily-source',
    acquiredAtUtc: '2026-11-14T00:00:00Z',
    originals: [{ fileRefId: 'real-original-ref', sha256: 'b'.repeat(64) }],
  };
  const empty = sourceCandidateFeedback({ ...base, rowCount: 0 });
  assert.equal(empty.observation.state, 'empty_unconfirmed');
  assert.equal(empty.observation.rowCount, 0);
  assert.equal(empty.coverage.completeness, 'not_established');
  assert.ok(empty.gaps.some(gap => gap.includes('不能补零')));
  const raw = sourceCandidateFeedback({ ...base, operationId: 'minute_bars' });
  assert.equal(raw.observation.state, 'raw_only');
  assert.equal(raw.observation.rowCount, null);
  assert.equal(raw.coverage.actualStart, null);
  assert.throws(() => sourceCandidateFeedback({ ...base, originals: [] }),
    /SOURCE_CANDIDATE_EVIDENCE/u);
  assert.throws(() => sourceCandidateFeedback({ ...base, rowCount: -1 }),
    /SOURCE_CANDIDATE_ROWS/u);
  assert.throws(() => sourceCandidateFeedback({ ...base, providerId: 'ths', operationId: 'minute_bars' }),
    /SOURCE_OPERATION_NOT_REGISTERED/u);
});

test('Public POST has one case-insensitive header per name, with the last explicit value', () => {
  const headers = publicWebRequestHeaders('POST', { Accept: 'text/html', 'Content-Type': 'application/json',
    'content-type': 'application/json; charset=utf-8', 'X-Fixture': 'first', 'x-fixture': 'last' });
  assert.deepEqual(Object.keys(headers).sort(), ['accept', 'accept-encoding', 'content-type', 'user-agent', 'x-fixture']);
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(headers['x-fixture'], 'last');
  assert.equal(headers.accept, 'text/html');
});

test('Receipt request keys bind the actual financial statement and report detail identifier', () => {
  const base = { scopeId: 'CN/A_STOCK', acquiredAtUtc: '2026-01-05T00:00:00Z', originals: [{ fileRefId: 'original', sha256: 'a'.repeat(64) }] };
  const common = { scopeId: base.scopeId, subjectId: null, start: null, end: null, adjustment: null };
  for (const [operationId, invalid] of [
    ['financial_statements', [{}, { statement: '' }, { statement: 'quarterly' }]],
    ['research_report_detail', [{}, { encodeUrl: ' ' }, { encodeUrl: 'x'.repeat(2049) }]],
  ] as const) {
    for (const fields of invalid) assert.throws(() => sourceRequestKey({ ...common, operationId, ...fields }),
      { code: 'SOURCE_REQUEST_INVALID' });
  }
  const reportKeys = ['income', 'balance_sheet', 'cash_flow'].map(statement => {
    const projection = buildApiReadRequest('ths', thsSource.apiBaseUrl, 'financial_statements', {
      thscode: '600001.SH', statement, period: 'quarterly', limit: 2 }).decode(Buffer.from('{"code":0,"data":{"item":[]}}'));
    const feedback = sourceCandidateFeedback({ ...base, ...projection, operationId: 'financial_statements', providerId: 'ths', connectionId: 'ths' });
    assert.equal(feedback.logicalRequest.statement, statement);
    return feedback.acquisition!.requestKey;
  });
  assert.equal(new Set(reportKeys).size, 3);
  const detailKeys = ['a+b/c=', 'a b/c='].map(encodeUrl => {
    const projection = buildApiReadRequest('eastmoney', 'https://push2his.eastmoney.com', 'research_report_detail', { category: 'macro', encodeUrl })
      .decode(Buffer.from('<script>window.pdf="https://pdf.dfcfw.com/pdf/H3_AP202601010001_1.pdf"</script>'));
    const feedback = sourceCandidateFeedback({ ...base, ...projection, operationId: 'research_report_detail', providerId: 'eastmoney', connectionId: 'eastmoney' });
    assert.equal(feedback.logicalRequest.encodeUrl, encodeUrl);
    return feedback.acquisition!.requestKey;
  });
  assert.notEqual(detailKeys[0], detailKeys[1]);
});

test('First registration chooses a stable free ID, preserves colliding policies and replays the pre-upgrade receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-migrate-')), database = new CoreDatabase(':memory:');
  try {
    const path = join(root, 'settings.json'), service = new SourceSettingsService(path, database);
    const original = service.get(), prior = { ...original, revision: 2,
      plugins: original.plugins.filter(item => item.id !== 'tickflow' && item.id !== 'sina'),
      connections: original.connections.filter(item => item.pluginId !== 'tickflow' && item.pluginId !== 'sina') };
    const origin = prior.connections.find(item => item.pluginId === 'ths')!;
    for (const id of ['tickflow-main', 'tickflow-main-2', 'sina-main']) prior.connections.push({ ...origin, id });
    prior.operationPolicies.push({ scopeId: 'CN/A_STOCK', operationId: 'daily_bars', primary: 'tickflow-main', backups: ['sina-main'] });
    const candidate = { ...prior, revision: 1 };
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    database.connection.prepare(`INSERT INTO source_settings_operations(request_id,content_hash,expected_revision,status,body,created_at,updated_at)
      VALUES(?,?,1,'saving',?,'fixture','fixture')`).run('old-save-request', hash(candidate), JSON.stringify(candidate));
    writeFileSync(path, JSON.stringify(prior));
    const migrated = service.get();
    assert.equal(migrated.connections.find(item => item.pluginId === 'tickflow')?.id, 'tickflow-main-3');
    assert.equal(migrated.connections.find(item => item.pluginId === 'sina')?.id, 'sina-main-2');
    assert.equal(migrated.connections.find(item => item.pluginId === 'sina')?.enabled, false);
    assert.deepEqual(service.operationCandidates('CN/A_STOCK', 'daily_bars').map(item => item.pluginId), ['ths', 'ths']);
    assert.deepEqual(service.update(candidate, 'old-save-request'), migrated);
    assert.equal(service.operation('old-save-request')?.actualMatches, true);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(prior));
    migrated.connections.find(item => item.pluginId === 'tickflow')!.alias += ' changed';
    writeFileSync(path, JSON.stringify(migrated));
    assert.equal(service.operation('old-save-request')?.actualMatches, false);
  } finally { database.close(); rmSync(root, { recursive: true }); }
});

test('Killed SQLite recovery releases its transaction; another process saves through a stale legacy guard', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'source-recovery-')), path = join(root, 'settings.json'), lock = path + '.lock';
  const db = new CoreDatabase(':memory:'), service = new SourceSettingsService(path, db);
  t.after(() => { db.close(); rmSync(root, { recursive: true }); });
  const initial = service.update(service.get());
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const dead = JSON.stringify({ version: 1, pid: exited.pid, token: 'exited-owner' });
  writeFileSync(lock, dead, { flag: 'wx' });
  writeFileSync(lock + '.recover', 'stale-legacy-guard', { flag: 'wx' });
  const program = `
    import { writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { SourceSettingsService } from './platform/config/source-settings.ts';
    import { CoreDatabase } from './platform/state/database.ts';
    const db = new CoreDatabase(':memory:');
    const service = new SourceSettingsService(process.argv[1], db);
    if (process.argv[2] === 'interrupt') {
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        const result = exec.call(this, sql);
        if (sql === 'BEGIN IMMEDIATE') {
          writeSync(1, 'locked');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return result;
      };
    }
    writeSync(1, String(service.update(service.get()).revision));
    db.close();`;
  const args = ['--import', 'tsx', '--input-type=module', '-e', program, path];
  const child = spawn(process.execPath, [...args, 'interrupt'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (!child.signalCode && child.exitCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  const ready = await Promise.race([once(child.stdout, 'data'), exit]);
  assert.equal(String(ready[0]), 'locked');
  const contender = new DatabaseSync(path + '.recover.sqlite');
  try {
    contender.exec('PRAGMA busy_timeout = 0');
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), { errcode: 5 }); // SQLITE_BUSY
  } finally { contender.close(); }
  assert.equal(readFileSync(lock, 'utf8'), dead);
  child.kill('SIGKILL');
  assert.deepEqual(await exit, [null, 'SIGKILL']);
  const next = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 8000 });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(Number(next.stdout), initial.revision + 1);
  assert.equal(service.get().revision, initial.revision + 1);
  assert.equal(statSync(path + '.recover.sqlite').mode & 0o777, 0o600);
  assert.ok(!existsSync(lock));
  const live = JSON.stringify({ version: 1, pid: process.pid, token: 'next-holder' });
  writeFileSync(lock, live, { flag: 'wx' });
  assert.throws(() => service.update(service.get()), { code: 'SOURCE_SETTINGS_BUSY' });
  assert.equal(readFileSync(lock, 'utf8'), live);
});

test('Recovery refuses symlinks and nonprivate SQLite guard files before reclaiming the primary lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-private-guard-')), db = new CoreDatabase(':memory:');
  try {
    const path = join(root, 'settings'), service = new SourceSettingsService(path, db), guard = path + '.recover.sqlite';
    const exited = spawnSync(process.execPath, ['-e', '']);
    assert.equal(exited.status, 0);
    const dead = JSON.stringify({ version: 1, pid: exited.pid, token: 'dead' });
    writeFileSync(path + '.lock', dead);
    const target = join(root, 'other');
    writeFileSync(target, 'other');
    symlinkSync(target, guard);
    assert.throws(() => service.update(service.get()), { code: 'SOURCE_SETTINGS_BUSY' });
    assert.equal(readFileSync(target, 'utf8'), 'other');
    rmSync(guard);
    writeFileSync(guard, '');
    chmodSync(guard, 0o644);
    assert.throws(() => service.update(service.get()), { code: 'SOURCE_SETTINGS_BUSY' });
    assert.equal(readFileSync(path + '.lock', 'utf8'), dead);
    chmodSync(guard, 0o600);
    const initial = service.get();
    assert.equal(service.update(initial).revision, initial.revision + 1);
  } finally { db.close(); rmSync(root, { recursive: true }); }
});

test('Racing saves from independent processes reclaim one stale settings lock and advance the revision once', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'source-lock-processes-')), database = new CoreDatabase(':memory:');
  t.after(() => { database.close(); rmSync(root, { recursive: true }); });
  const path = join(root, 'settings.json'), service = new SourceSettingsService(path, database);
  const current = service.update(service.get());
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  writeFileSync(path + '.lock', JSON.stringify({ version: 1, pid: exited.pid, token: 'exited-owner' }));
  const program = `
    import { SourceSettingsService } from './platform/config/source-settings.ts';
    import { CoreDatabase } from './platform/state/database.ts';
    const db = new CoreDatabase(':memory:');
    const service = new SourceSettingsService(process.argv[1], db);
    const candidate = service.get();
    process.once('message', () => {
      let outcome;
      try { service.update(candidate); outcome = 'saved'; } catch (error) { outcome = error.code; }
      db.close();
      process.send(outcome, () => process.disconnect());
    });
    process.send('ready');`;
  const children = Array.from({ length: 3 }, () => spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, path], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const exits = children.map(child => once(child, 'exit'));
  const ready = await Promise.all(children.map(child => once(child, 'message')));
  assert.ok(ready.every(([message]) => message === 'ready'));
  const results = Promise.all(children.map(child => once(child, 'message')));
  for (const child of children) child.send('save');
  const outcomes = (await results).map(([outcome]) => outcome);
  assert.equal(outcomes.filter(value => value === 'saved').length, 1);
  assert.ok(outcomes.every(value => ['saved', 'SOURCE_SETTINGS_BUSY', 'SOURCE_SETTINGS_CONFLICT'].includes(value)));
  assert.ok((await Promise.all(exits)).every(([code]) => code === 0));
  assert.equal(service.get().revision, current.revision + 1);
  assert.ok(!existsSync(path + '.lock') && !existsSync(path + '.lock.recover'));
});

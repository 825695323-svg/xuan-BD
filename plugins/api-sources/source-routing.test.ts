import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  for (const id of ['eastmoney', 'sina', 'tencent']) {
    for (const operation of sourceOperations(id)) assert.equal(operation.run.action, 'source.kline.read');
  }
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
    assert.deepEqual(view.supportedApiOperations.map(operation => operation.id), sourceOperations('ths').map(operation => operation.id));
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

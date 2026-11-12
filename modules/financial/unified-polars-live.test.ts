import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { canonicalWfdJson, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture } from '../../apps/server/full-chain-test-support.js';
import { UnifiedPolarsExecution, UNIFIED_POLARS_RUNTIME } from './unified-polars-execution.js';

const python = process.env.POLARS_PYTHON;
const enabled = !!python && !!process.env.XUAN_FULL_CHAIN_ROOT;
const fields = ['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period',
  'period_start', 'period_end', 'published_at', 'release_id', 'value'];
const current = { series_code: 'synthetic-index', region: 'CN', unit: 'count',
  seasonal_adjustment: 'not_adjusted', base_period: '2020', period_start: '2026-01-01',
  period_end: '2026-01-31', published_at: '2026-02-14T00:00:00Z', release_id: 'release-2026', value: '120' };
const previous = { ...current, period_start: '2025-01-01', period_end: '2025-01-31',
  published_at: '2025-02-14T00:00:00Z', release_id: 'release-2025', value: '100' };
const refs = [
  { snapshotId: 'snapshot-current', productId: 'product-macro', businessKey: 'current', recordVersion: 'version-current' },
  { snapshotId: 'snapshot-previous', productId: 'product-macro', businessKey: 'previous', recordVersion: 'version-previous' },
];
const connection = { instance: 'isolated-wfd', connectionId: 'frozen-reader' };
const rawRows: WfdRecord[] = [current, previous].map((values, index) => ({
  record_ref: { product_id: refs[index]!.productId, snapshot_id: refs[index]!.snapshotId,
    logical_key: refs[index]!.businessKey, revision_id: refs[index]!.recordVersion },
  subject: { kind: 'region', namespace: 'test', id: 'CN' },
  values: Object.fromEntries(fields.map(key => [key, { value: values[key as keyof typeof values],
    value_state: 'valid_value' }])),
}));

test('real Polars worker executes one unified algorithms.calculate task and freezes exact WFD source identities',
  { skip: !enabled ? 'Only runs with explicitly pinned POLARS_PYTHON and isolated XUAN_FULL_CHAIN_ROOT.' : false,
    timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'unified-polars-live', machine: false });
    const bindingsPath = join(fixture.runtime, 'config/machine.bindings.json');
    const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8'));
    // Keep the explicitly selected virtual-environment invocation path; the runtime checks canonical identity separately.
    bindings.resources.polars_python = { kind: 'program', path: resolve(python!) };
    bindings.revision++;
    writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2));
    const resources = new ResourceBindings(fixture.runtime);
    const processRuntime = new ProcessRuntime(resources);
    assert.equal(processRuntime.path('polars-python'), resolve(python!));
    const database = new CoreDatabase(join(fixture.runtime, 'state', 'unified-test.sqlite'));
    const registry = new TaskRuntimeRegistry();
    let tasks!: TaskService;
    const permissions = new PermissionService({ database, isRunActive: (run, generation) => tasks?.isRunActive(run, generation) === true });
    const workspace = {
      capabilities: () => ({ connection }),
      async readProduct(input: { snapshotId: string; productId: string; cursor?: string }) {
        const index = refs.findIndex(ref => ref.snapshotId === input.snapshotId && ref.productId === input.productId);
        assert.ok(index !== -1);
        assert.equal(input.cursor, undefined);
        return { connection, result: { snapshot_id: input.snapshotId, product_id: input.productId,
          page: { has_more: false, next_cursor: null }, rows: [rawRows[index]] } };
      },
    };
    const backend = new UnifiedPolarsExecution({ database, tasks: () => tasks, workspace: workspace as never, processRuntime });
    registry.register(backend.runtime);
    tasks = new TaskService({ database, permissions, runtimes: registry });
    permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: resolve(python!) } }],
      scope: { kind: 'persistent' }, label: 'isolated registered Polars worker' });
    try {
      assert.equal(backend.capabilities().status, 'ready');
      const calculation = { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
        knowledgeCutoff: '2026-02-15T00:00:00Z', inputs: refs };
      const req = { methodId: 'macro_yoy', source: { kind: 'fixed_snapshot' },
        calculation, usage: { purpose: 'current_compute' } };
      const initial = backend.submit('isolated-real-macro', req);
      assert.ok(initial.taskId);
      const task = await tasks.wait(initial.taskId);
      assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
      assert.equal(task.runtimeId, UNIFIED_POLARS_RUNTIME);
      assert.equal(task.action, 'algorithms.calculate');
      const view = backend.view(task.id);
      assert.equal(view.result?.methodId, 'macro_yoy');
      assert.equal(view.result?.rows[0]!.value, '20.00000000');
      assert.equal(view.result?.rows[0]!.unit, 'percent');
      assert.equal(view.result?.publication, 'candidate_only');
      const checked = await backend.verifyForPublication(task.id, new AbortController().signal);
      assert.equal(checked.methodId, 'macro_yoy');
      assert.equal(checked.fixedSourceRowsSha256.length, 2);
      assert.equal(backend.submit('isolated-real-macro', req).taskId, task.id);
      assert.equal(Number(database.connection.prepare(
        "SELECT count(*) AS n FROM tasks WHERE runtime_id=?").get(UNIFIED_POLARS_RUNTIME)?.n), 1,
        'There must be exactly one durable calculation task, no duplicate material/processing tasks.');
    } finally {
      await tasks.dispose();
      database.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

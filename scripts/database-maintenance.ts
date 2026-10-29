import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ResourceBindings, launcherPath, locateRuntimeRoot } from '../platform/resources/bindings.js';
import { acquireRuntimeStartupFence, readHarnessRuntime } from '../platform/runtime/runtime-profile.js';
import { CoreDatabase } from '../platform/state/database.js';
import { ownStateRoot } from '../apps/server/boot.js';
import { DatabaseLineService, type DatabaseLineIdentity } from '../adapters/database/line-selection.js';
import { isWfdRecord } from '../adapters/database/wfd-transport.js';

function readObject(path: string): Record<string, unknown> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('维护记录须为有界普通单链接文件。');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isWfdRecord(value)) throw new Error('维护记录须为明确对象。');
    return value;
  } finally { closeSync(fd); }
}
/** 离线维护沿原连接记账；不启动数据库、不修改用户停止偏好、不重发未知请求。 */
export async function databaseMaintenance(options: { operation: 'freeze' | 'status'; connectionId?: string; runtimeRoot?: string; launcherFile?: string }) {
  const locatorFile = options.launcherFile ?? launcherPath(), root = locateRuntimeRoot(options.runtimeRoot, process.env, locatorFile);
  const resources = new ResourceBindings(root), profile = readHarnessRuntime(root);
  const releases: (() => Promise<void>)[] = [], databases: CoreDatabase[] = [];
  let fence: ReturnType<typeof acquireRuntimeStartupFence> | undefined;
  try {
    fence = acquireRuntimeStartupFence(locatorFile, root);
    for (const role of ['personal', 'workspace']) {
      const path = resolve(resources.path('state'), role, 'core.sqlite');
      if (lstatSync(path, { throwIfNoEntry: false })) releases.push(await ownStateRoot(path));
    }
    fence.verify(); fence.release(); fence = undefined;
    const paths = ['personal', 'workspace'].map(role => resolve(resources.path('state'), role, 'core.sqlite'));
    const workspace = lstatSync(paths[1]!, { throwIfNoEntry: false }) ? new DatabaseSync(paths[1]!, { readOnly: true }) : undefined;
    let identities: DatabaseLineIdentity[] = [], selection: Record<string, unknown> | undefined;
    if (workspace) try {
      const has = (table: string) => !!workspace.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      identities = has('database_line_identities') ? workspace.prepare('SELECT identity_json FROM database_line_identities').all()
        .map(row => JSON.parse(String(row.identity_json)) as DatabaseLineIdentity) : [];
      selection = has('database_line_selection') ? workspace.prepare('SELECT s.*,c.state AS pending_state FROM database_line_selection s LEFT JOIN database_line_changes c ON c.id=s.pending_id WHERE s.singleton=1').get() : undefined;
    } finally { workspace.close(); }
    if (options.operation === 'freeze') {
      if (!options.connectionId || !selection || selection.connection_id !== options.connectionId) throw new Error('冻结须明确当前默认连接；其他连接先经受控选择，不猜测实例。');
      const registry = readObject(resources.path('connections_registry'));
      for (const identity of identities) {
        const registered = Array.isArray(registry.connections) ? registry.connections.filter(item => isWfdRecord(item) && item.id === identity.connectionId) : [];
        const item = registered[0];
        if (registered.length !== 1 || !isWfdRecord(item) || item.instance_id !== identity.instanceId || item.principal_id !== identity.principalId
          || item.mode !== identity.mode || item.purpose !== identity.purpose || item.protocol_schema_sha256 !== identity.schemaSha256
          || !isWfdRecord(item.harness_binding) || item.harness_binding.root !== root || item.harness_binding.root_id !== profile.runtimeIdentity) throw new Error('原连接登记与持久逻辑身份或当前应用归属不一致，保持原实例待核。');
      }
      for (const path of paths) if (lstatSync(path, { throwIfNoEntry: false })) databases.push(new CoreDatabase(path));
      const business = databases.find(database => database.path === paths[1])!;
      const personal = databases.find(database => database.path === paths[0]);
      const lines = new DatabaseLineService({ database: business, initialConnectionId: options.connectionId,
        lines: identities.map(identity => ({ identity, async verify() { throw new Error('离线维护不能替代数据库提供方实际鉴权核验。'); } })) });
      if (personal) lines.attachBusinessDatabase(personal);
      let status = lines.status();
      if (!status.pendingId) status = await lines.beginMaintenance({ connectionId: options.connectionId, expectedRevision: status.revision });
      if (!String(status.pending?.state).startsWith('maintenance')) throw new Error('已有其他默认连接核对意图，须先沿原意图恢复。');
      selection = { ...selection, pending_id: status.pendingId, pending_state: status.pending?.state };
    }
    const ledgerFacts = paths.map(path => {
      if (!lstatSync(path, { throwIfNoEntry: false })) return { databasePath: path, tasks: [], effects: [], workers: [], attempts: [], requests: [] };
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        const tasks = has('tasks') ? db.prepare("SELECT id,status,current_attempt_id,requires_review FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled') OR requires_review=1").all() : [];
        const effects = has('task_effects') ? db.prepare("SELECT attempt_id,id,status FROM task_effects WHERE status='started'").all() : [];
        const workers = has('task_workers') ? db.prepare("SELECT attempt_id,run_id,generation,kind,pid,start_identity,status FROM task_workers WHERE status<>'exited'").all() : [];
        const attempts = has('task_attempts') ? db.prepare('SELECT id,task_id,status,side_effect_started,unconfirmed_effects FROM task_attempts WHERE unconfirmed_effects>0').all() : [];
        const requests = ['conversation_data_cycles', 'conversation_result_publications'].flatMap(table => has(table)
          ? db.prepare(`SELECT id,state,envelope_json FROM ${table} WHERE state NOT IN ('verified','failed','rejected','cancelled')`).all().map(row => {
            const envelope = JSON.parse(String(row.envelope_json));
            return { id: row.id, state: row.state, requestId: envelope.request_id, instanceId: envelope.instance_id, operation: envelope.operation };
          }) : []);
        return { databasePath: path, tasks, effects, workers, attempts, requests };
      } finally { db.close(); }
    });
    const selectedIdentity = identities.find(identity => identity.connectionId === selection?.connection_id);
    const unresolved = ledgerFacts.flatMap(ledger => ledger.requests).filter(request => request.instanceId === selectedIdentity?.instanceId);
    const ready = !!selection?.pending_id && String(selection.pending_state).startsWith('maintenance') && unresolved.length === 0
      && ledgerFacts.every(item => item.tasks.length === 0 && item.effects.length === 0 && item.workers.length === 0 && item.attempts.length === 0);
    return { at: new Date().toISOString(), operation: options.operation, runtimeRoot: root, runtimeIdentity: profile.runtimeIdentity,
      maintenanceReady: ready, readinessScope: 'all-local-task-ledgers', selection: selection ?? null, connections: identities, unresolved, ledgerFacts,
      providerVerified: false, databaseStarted: false, userControlPreferencesChanged: false };
  } finally {
    for (const database of databases.reverse()) database.close();
    for (const release of releases.reverse()) await release();
    fence?.release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = process.argv.slice(2), positional = raw.filter(value => !value.startsWith('--')), flags = raw.filter(value => value.startsWith('--'));
    if (flags.some(value => !/^--(?:runtime-root|launcher)=.+$/u.test(value)) || new Set(flags.map(value => value.split('=')[0])).size !== flags.length) throw new Error('维护仅接受明确的运行根和启动定位选项。');
    const [operation, connectionId] = positional;
    if (!['freeze', 'status'].includes(operation ?? '') || positional.length > (operation === 'freeze' ? 2 : 1) || operation === 'freeze' && !connectionId) throw new Error('Usage: database-maintenance.ts status | freeze <connectionId> [--runtime-root=absolute-directory] [--launcher=absolute-file]');
    console.log(JSON.stringify(await databaseMaintenance({ operation: operation as 'freeze' | 'status', connectionId,
      runtimeRoot: flags.find(value => value.startsWith('--runtime-root='))?.slice('--runtime-root='.length),
      launcherFile: flags.find(value => value.startsWith('--launcher='))?.slice('--launcher='.length) }), null, 2));
  } catch (error) { console.error(JSON.stringify({ code: (error as { code?: string }).code ?? 'DATABASE_MAINTENANCE_FAILED', error: error instanceof Error ? error.message : '维护未完成。' })); process.exitCode = 1; }
}

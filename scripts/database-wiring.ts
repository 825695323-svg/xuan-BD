import { constants, openSync, closeSync, fstatSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ResourceBindings, launcherPath } from '../platform/resources/bindings.js';
import { acquireRuntimeStartupFence, assertRuntimeStopped, assertRuntimeQuiescent, readRuntimeLauncher, recoverRuntimeMaintenance } from '../platform/runtime/runtime-profile.js';
import { ownStateRoot, prepareStateRootRecovery, type StateOwnershipProof } from '../apps/server/boot.js';
import { ProcessRuntime } from '../platform/runtime/programs.js';
import { runDirectProcess } from '../platform/runtime/process.js';
import { canonicalWfdJson, createWfdTransport, isWfdRecord, wfdSha256, type WfdRecord } from '../adapters/database/wfd-transport.js';
import { assertStorageRecord } from '../adapters/database/native-lines.js';

type Item = { path: string; before: string; after: string; staged: string };
type Journal = { version: 1; id: string; phase: string; contractSha256: string; maintenanceIntent: string; items: Item[]; at: string };
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function readPinned(path: string): string {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) return fail('UNSAFE_WIRING_FILE', '登记必须使用无别名的绝对位置。');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, { bigint: true });
    if (!first.isFile() || first.nlink !== 1n || first.size > 8_388_608n) return fail('UNSAFE_WIRING_FILE', '登记不是有界普通单链接文件。');
    const raw = readFileSync(fd, 'utf8'), after = fstatSync(fd, { bigint: true });
    if (first.ino !== after.ino || first.size !== after.size || first.mtimeNs !== after.mtimeNs || first.ctimeNs !== after.ctimeNs) return fail('WIRING_CONFLICT', '登记在读取期间发生变化。');
    return raw;
  } finally { closeSync(fd); }
}
function atomic(path: string, bytes: string, expected: string | null) {
  const temporary = path + '.wiring-' + randomUUID(), fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (expected === null ? lstatSync(path, { throwIfNoEntry: false }) : sha(readPinned(path)) !== expected) fail('WIRING_CONFLICT', '登记或维护意图已变化，拒绝覆盖。');
    renameSync(temporary, path); const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
}
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export async function adoptDatabaseWiring(options: { contractPath: string; launcherFile: string; maintenanceIntent: string; resumeIntent?: string;
  /** Tests inject only an independent storage verifier and a crash boundary, never CLI flags. */
  testHooks?: { verifyStorage?(line: WfdRecord, resources: ResourceBindings): Promise<void>; afterFile?(ordinal: number): void } }) {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outsideCode = (path: string) => {
    const part = relative(codeRoot, resolve(path));
    if (!isAbsolute(path) || !part || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) return fail('WIRING_RECORD_LOCATION', '连接合同和实际恢复登记必须保存在工程外的明确绝对位置。');
  };
  outsideCode(options.contractPath);
  const contract = JSON.parse(readPinned(options.contractPath)) as WfdRecord;
  if (!Array.isArray(contract.lines) || contract.lines.length < 1 || contract.lines.length > 32
    || contract.lines.some(line => !isWfdRecord(line)) || typeof contract.source_root !== 'string'
    || !isAbsolute(contract.source_root) || realpathSync(contract.source_root) !== contract.source_root
    || !options.maintenanceIntent) return fail('WIRING_CONTRACT_INVALID', '合同需要明确提供方位置、一至多条连接及本次维护身份。');
  const lines = contract.lines as WfdRecord[];
  const launcher = readRuntimeLauncher(options.launcherFile), root = launcher.runtimeRoot, resources = new ResourceBindings(root);
  const connectionIds = lines.map(line => line.connection_id), instances = new Set(lines.map(line => line.instance_id));
  if (new Set(connectionIds).size !== lines.length || connectionIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) return fail('WIRING_CONTRACT_INVALID', '每条数据库连接必须有唯一明确编号。');
  for (const line of lines) {
    if (line.harness_root !== root || line.harness_root_id !== launcher.runtimeIdentity
      || !['user_test', 'production'].includes(String(line.environment)) || line.production_enabled !== (line.environment === 'production')
      || typeof line.instance_id !== 'string' || !line.instance_id || typeof line.principal_id !== 'string' || !line.principal_id
      || typeof line.credential_reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(line.credential_reference)) return fail('WIRING_PAIR_MISMATCH', '每条连接须由提供方明确绑定本应用身份、模式、用途及凭据引用。');
  }
  const contractSha256 = sha(canonicalWfdJson(contract)), fence = acquireRuntimeStartupFence(options.launcherFile, root);
  const releases: (() => Promise<void>)[] = [];
  try {
    assertRuntimeStopped(root);
    for (const role of ['personal', 'workspace']) {
      const path = join(resources.path('state'), role, 'core.sqlite');
      if (lstatSync(path, { throwIfNoEntry: false })) releases.push(await ownStateRoot(path));
    }
    fence.verify();
    assertRuntimeQuiescent(root);
    const workspacePath = join(resources.path('state'), 'workspace/core.sqlite');
    let pending: Record<string, unknown> | undefined;
    if (lstatSync(workspacePath, { throwIfNoEntry: false })) {
      const workspace = new DatabaseSync(workspacePath, { readOnly: true });
      try {
        const hasSelection = workspace.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_line_selection'").get();
        if (hasSelection) pending = workspace.prepare('SELECT s.connection_id,s.pending_id,c.state,c.from_connection_id FROM database_line_selection s LEFT JOIN database_line_changes c ON c.id=s.pending_id WHERE s.singleton=1').get();
      } finally { workspace.close(); }
    }
    if (pending) {
      if (pending.pending_id !== options.maintenanceIntent || !String(pending.state).startsWith('maintenance')
        || !connectionIds.includes(pending.from_connection_id)) return fail('WIRING_MAINTENANCE_REQUIRED', '受影响原连接必须仍持有本次原身份维护封闭。');
    } else if (options.maintenanceIntent !== 'initial-registration') return fail('WIRING_MAINTENANCE_REQUIRED', '未绑定新应用只接受明确的initial-registration初始登记。');
    for (const role of ['personal', 'workspace']) {
      const path = join(resources.path('state'), role, 'core.sqlite');
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        for (const table of ['conversation_data_cycles', 'conversation_result_publications']) {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
          for (const row of db.prepare(`SELECT envelope_json FROM ${table} WHERE state NOT IN ('verified','failed','rejected','cancelled')`).all()) {
            const envelope = JSON.parse(String(row.envelope_json));
            if (!pending || instances.has(envelope.instance_id)) fail('WIRING_UNRESOLVED', '受影响原实例仍有未核外部请求；先沿原身份核对，不采用或重发。');
          }
        }
      } finally { db.close(); }
    }
    for (const line of lines) {
      const runtimeRoot = String(line.runtime_root), outer = String(line.outer_database_root), production = line.environment === 'production';
      const schemaPath = resolve(contract.source_root, production ? 'protocol/harness-handoff-v0.2.schema.json' : 'protocol/harness-handoff-v0.1.schema.json');
      const serve = ['-B', '-m', 'core.server', 'serve', '--root', runtimeRoot, '--port', '0', '--harness-root-id', launcher.runtimeIdentity];
      if (!isAbsolute(outer) || realpathSync(outer) !== outer || runtimeRoot !== resolve(outer, 'data/mount/private/instance')
        || line.token_file !== resolve(runtimeRoot, 'auth/client.token') || line.discovery_file !== resolve(runtimeRoot, 'server-info.json')
        || line.schema_path !== schemaPath || line.schema_revision !== (production ? '0.2.0' : '0.1.3')
        || wfdSha256(readFileSync(schemaPath)) !== line.schema_sha256 || canonicalWfdJson(line.serve_command) !== canonicalWfdJson(serve)) return fail('WIRING_CONTRACT_INVALID', '连接根、协议、凭据引用或受控启动参数不一致。');
      const manifest = JSON.parse(readPinned(join(runtimeRoot, 'instance.json')));
      if (manifest.instance_id !== line.instance_id || manifest.principal_id !== line.principal_id || manifest.mode !== line.environment
        || manifest.purpose !== line.environment || manifest.schema_sha256 !== line.schema_sha256 || manifest.production_enabled !== production
        || !isWfdRecord(manifest.dataset_bindings)) return fail('WIRING_INSTANCE_MISMATCH', '已登记实例的身份、模式、用途或协议与合同不一致。');
      if (production && Object.keys(manifest.dataset_bindings).length) return fail('WIRING_PRODUCTION_NOT_EMPTY', '正式登记只接独立空只读实例，不复制测试目标。');
      const inputDataset = production ? undefined : line.input_dataset_id;
      if (!production && (typeof inputDataset !== 'string' || !Object.hasOwn(manifest.dataset_bindings, inputDataset))) return fail('WIRING_CONTRACT_INVALID', '用户测试连接缺少提供方登记的唯一材料目标。');
      createWfdTransport({ binding: production ? 'registered-production' : 'controlled-user-test', schemaPath,
        expectedSchemaSha256: String(line.schema_sha256), baseUrl: 'http://127.0.0.1:1', instanceId: String(line.instance_id),
        ...(typeof inputDataset === 'string' ? { datasetId: inputDataset } : {}),
        harnessRootId: launcher.runtimeIdentity, environment: production ? 'production' : 'user_test',
        resolveToken: () => fail('WIRING_READ_ONLY', '登记核对不读取凭据或发业务请求。') });
      const record = JSON.parse(readPinned(join(outer, 'data/storage.json')));
      assertStorageRecord(record, { libraryRoot: outer, mode: String(line.environment), runtimeRoot, harnessRoot: root, harnessRootId: launcher.runtimeIdentity });
      if (record.storage_id !== line.storage_id || record.native_volume_uuid !== line.native_volume_uuid || record.outer_volume_uuid !== line.outer_volume_uuid) return fail('WIRING_STORAGE_MISMATCH', '保管身份或原生/外盘卷与合同不同。');
      if (options.testHooks?.verifyStorage) await options.testHooks.verifyStorage(line, resources);
      else {
        const runtime = new ProcessRuntime(resources), result = await runDirectProcess({ runtime, binary: 'python3', args: ['-B', '-m', 'core.storage', 'check', '--outer-root', outer], cwd: contract.source_root,
          signal: new AbortController().signal, assertAuthorized: () => { runtime.path('python3'); }, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
        const checked = JSON.parse(result.stdout);
        if (!isWfdRecord(checked.binding) || canonicalWfdJson(checked.binding) !== canonicalWfdJson(record) || !isWfdRecord(checked.guard)
          || checked.guard.record_sha256 !== wfdSha256(canonicalWfdJson(record))) return fail('WIRING_STORAGE_MISMATCH', '实际保管核对没有证明同一库和封印。');
      }
    }
    const connectionsPath = resources.path('connections_registry');
    outsideCode(connectionsPath);
    const connectionsRaw = readPinned(connectionsPath), connectionRegistry = JSON.parse(connectionsRaw), credentialsPath = connectionRegistry.credential_registry;
    if (typeof credentialsPath !== 'string' || !Array.isArray(connectionRegistry.connections)) return fail('WIRING_REGISTRY_INVALID', '连接登记缺少凭据登记引用。');
    outsideCode(credentialsPath);
    const credentialsRaw = readPinned(credentialsPath), credentialRegistry = JSON.parse(credentialsRaw);
    if (!Array.isArray(credentialRegistry.credentials)) return fail('WIRING_REGISTRY_INVALID', '凭据引用登记格式不符。');
    const journalPath = connectionsPath + '.database-wiring.json';
    let journal: Journal | undefined;
    if (lstatSync(journalPath, { throwIfNoEntry: false })) journal = JSON.parse(readPinned(journalPath));
    if (journal && journal.phase !== 'committed' && (journal.id !== options.resumeIntent || journal.contractSha256 !== contractSha256 || journal.maintenanceIntent !== options.maintenanceIntent)) return fail('WIRING_PENDING', '已有未完成采用；只能明确引用原意图续接。');
    if (!journal || journal.phase === 'committed') {
      if (journal?.contractSha256 === contractSha256 && journal.items.every(item => sha(readPinned(item.path)) === item.after)) return { status: 'committed', id: journal.id, idempotent: true, maintenanceStillFrozen: true };
      for (const line of lines) {
        const connectionId = String(line.connection_id), credentialId = String(line.credential_reference);
        const prior = connectionRegistry.connections.filter((item: WfdRecord) => item.id === connectionId);
        if (prior.length > 1 || prior.length && (prior[0].instance_id !== line.instance_id || prior[0].principal_id !== line.principal_id
          || prior[0].mode !== line.environment || prior[0].purpose !== line.environment || prior[0].protocol_schema_sha256 !== line.schema_sha256
          || prior[0].credential_ref?.registry_id !== credentialId || prior[0].harness_binding?.root !== root
          || prior[0].harness_binding?.root_id !== launcher.runtimeIdentity)) return fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '已有连接的逻辑身份或应用归属不同，不能覆盖或接管其他根。');
        const credential = credentialRegistry.credentials.filter((item: WfdRecord) => item.id === credentialId);
        if (credential.length > 1 || credential.length && credential[0].instance_id !== line.instance_id) return fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '目标凭据引用已属于不同实例。');
        const profile = { ...(prior[0] ?? {}), id: connectionId, kind: 'native-loopback-service', mode: line.environment, purpose: line.environment,
          protocol: line.environment === 'production' ? 'wfd-harness-handoff/v0.2' : 'wfd-harness-handoff/v0.1', protocol_revision: line.schema_revision,
          ...(line.environment === 'user_test' ? { input_dataset_id: line.input_dataset_id } : {}),
          protocol_schema_sha256: line.schema_sha256, library_root: line.outer_database_root, runtime_root: line.runtime_root, instance_id: line.instance_id,
          principal_id: line.principal_id, instance_manifest: resolve(String(line.runtime_root), 'instance.json'), storage_id: line.storage_id,
          harness_binding: { root: line.harness_root, root_id: line.harness_root_id },
          startup: { owner: 'harness-agents backend', login_autostart: false, cwd: contract.source_root, argv: ['python3', ...(line.serve_command as string[])] },
          credential_ref: { kind: 'private-file-reference', registry_id: credentialId, path: line.token_file }, endpoint_reference: { path: line.discovery_file } };
        connectionRegistry.connections = connectionRegistry.connections.filter((item: WfdRecord) => item.id !== connectionId); connectionRegistry.connections.push(profile);
        credentialRegistry.credentials = credentialRegistry.credentials.filter((item: WfdRecord) => item.id !== credentialId);
        credentialRegistry.credentials.push({ ...(credential[0] ?? {}), id: credentialId, instance_id: line.instance_id, store: 'private-local-file', paths: [line.token_file] });
      }
      const id = randomUUID(), planned = [{ path: credentialsPath, before: sha(credentialsRaw), bytes: encoded(credentialRegistry) }, { path: connectionsPath, before: sha(connectionsRaw), bytes: encoded(connectionRegistry) }];
      const items = planned.map(item => { const staged = item.path + '.wiring-staged-' + id; atomic(staged, item.bytes, null); return { path: item.path, before: item.before, after: sha(item.bytes), staged }; });
      const next: Journal = { version: 1, id, phase: 'prepared', contractSha256, maintenanceIntent: options.maintenanceIntent, items, at: new Date().toISOString() };
      atomic(journalPath, encoded(next), journal ? sha(readPinned(journalPath)) : null); journal = next;
    }
    for (const [ordinal, item] of journal.items.entries()) {
      const current = sha(readPinned(item.path));
      if (current !== item.after) {
        if (current !== item.before) return fail('WIRING_CONFLICT', '登记已被其他修改替换，保留原采用意图待核。');
        const staged = readPinned(item.staged); if (sha(staged) !== item.after) return fail('WIRING_STAGED_CHANGED', '封闭采用内容发生变化。');
        atomic(item.path, staged, item.before);
      }
      options.testHooks?.afterFile?.(ordinal);
      const originalJournal = sha(readPinned(journalPath)); journal.phase = 'file-' + ordinal; atomic(journalPath, encoded(journal), originalJournal);
    }
    const originalJournal = sha(readPinned(journalPath)); journal.phase = 'committed'; atomic(journalPath, encoded(journal), originalJournal);
    for (const item of journal.items) if (lstatSync(item.staged, { throwIfNoEntry: false })) unlinkSync(item.staged);
    return { status: 'committed', id: journal.id, idempotent: false, maintenanceStillFrozen: true,
      connections: connectionIds, credentialReferencesOnly: true, tokensRead: false };
  } finally { for (const release of releases.reverse()) await release(); fence.release(); }
}
type RelocationJournal = Journal & { operation: 'relocate-client'; connectionId: string; instanceId: string;
  oldRoot: string; newRoot: string; rootId: string; storageId: string; sourceRoot: string; libraryRoot: string;
  beforeRaw: string; lineIdentitySha256: string; instanceSha256: string; selectionRevision: number };

type RelocationWork = { tasks: Set<string>; requests: Set<string> };
function relocationWork(resources: ResourceBindings, instanceId: string): RelocationWork {
  const db = new DatabaseSync(join(resources.path('state'), 'workspace/core.sqlite'), { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    const connections = new Set<string>();
    if (tables.has('database_line_identities')) for (const row of db.prepare('SELECT * FROM database_line_identities').all()) {
      const identity = JSON.parse(String(row.identity_json));
      if (identity.instanceId === instanceId) {
        if (sha(canonicalWfdJson(identity)) !== row.identity_sha256 || identity.connectionId !== row.connection_id) return fail('WIRING_LEDGER_UNAVAILABLE', '原实例的冻结连接身份无法核同。');
        connections.add(String(row.connection_id));
      }
    }
    const work: RelocationWork = { tasks: new Set(), requests: new Set() };
    if (tables.has('database_task_lines')) for (const row of db.prepare('SELECT task_id,connection_id FROM database_task_lines').all()) {
      if (connections.has(String(row.connection_id))) work.tasks.add(String(row.task_id));
    }
    if (tables.has('database_request_lines')) for (const row of db.prepare('SELECT request_id,task_id,connection_id FROM database_request_lines').all()) {
      if (connections.has(String(row.connection_id))) { work.requests.add(String(row.request_id)); if (row.task_id) work.tasks.add(String(row.task_id)); }
    }
    return work;
  } finally { db.close(); }
}
function assertRelocationWorkSettled(db: DatabaseSync, tables: Set<string>, work: RelocationWork, instanceId: string): void {
  const relevantTasks = new Set(work.tasks), relevantAttempts = new Set<string>();
  if (tables.has('task_effects')) {
    if (!tables.has('task_attempts')) return fail('WIRING_LEDGER_UNAVAILABLE', '动作账缺少原任务尝试，不能判断原实例未决事实。');
    const effects = db.prepare('SELECT e.attempt_id,e.status,e.operation,a.task_id FROM task_effects e LEFT JOIN task_attempts a ON a.id=e.attempt_id').all();
    for (const row of effects) {
      const operation = JSON.parse(String(row.operation));
      const relevant = relevantTasks.has(String(row.task_id)) || operation?.instanceId === instanceId || operation?.instance_id === instanceId
        || work.requests.has(String(operation?.requestId ?? operation?.request_id));
      if (!relevant) continue;
      relevantAttempts.add(String(row.attempt_id)); if (row.task_id) relevantTasks.add(String(row.task_id));
    }
    if (effects.some(row => row.status === 'started' && (relevantTasks.has(String(row.task_id)) || relevantAttempts.has(String(row.attempt_id))))) return fail('WIRING_UNRESOLVED_EFFECT', '原实例的外部动作仍为started，须沿原请求核对后再改址。');
  }
  if (tables.has('task_attempts')) for (const row of db.prepare('SELECT id,task_id,unconfirmed_effects FROM task_attempts WHERE unconfirmed_effects>0').all()) {
    if (relevantTasks.has(String(row.task_id)) || relevantAttempts.has(String(row.id))) return fail('WIRING_UNRESOLVED_EFFECT', '原实例的任务尝试仍标有未确认动作。');
  }
  if (tables.has('task_workers')) {
    if (!tables.has('task_attempts')) return fail('WIRING_LEDGER_UNAVAILABLE', '工具进程账缺少原任务尝试。');
    for (const row of db.prepare("SELECT w.attempt_id,a.task_id FROM task_workers w LEFT JOIN task_attempts a ON a.id=w.attempt_id WHERE w.kind='tool' AND w.status<>'exited'").all()) {
      if (relevantTasks.has(String(row.task_id)) || relevantAttempts.has(String(row.attempt_id))) return fail('WIRING_UNRESOLVED_WORKER', '原实例关联工具进程尚未确认退出，保持原请求及维护封闭。');
    }
  }
}

/** 显式恢复本次改址遗留所有权；仅释放核同的死进程锁，不核销任何业务结果。 */
export async function recoverRelocationLocks(options: { requestPath: string; launcherFile: string }) {
  const request: unknown = JSON.parse(readPinned(options.requestPath));
  const proofValid = (proof: unknown): proof is StateOwnershipProof => isWfdRecord(proof)
    && Object.keys(proof).sort().join() === 'device,inode,pid,sha256,token' && Number.isSafeInteger(proof.pid) && Number(proof.pid) > 0
    && typeof proof.token === 'string' && !!proof.token && typeof proof.device === 'string' && /^[0-9]+$/u.test(proof.device)
    && typeof proof.inode === 'string' && /^[0-9]+$/u.test(proof.inode) && typeof proof.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(proof.sha256);
  if (!isWfdRecord(request) || Object.keys(request).sort().join() !== 'connectionId,instanceId,intent,owners,runtimeIdentity,runtimeRoot,startup,version'
    || request.version !== 1 || typeof request.intent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.intent)
    || typeof request.connectionId !== 'string' || !request.connectionId || typeof request.instanceId !== 'string' || !request.instanceId
    || !proofValid(request.startup) || !Array.isArray(request.owners) || request.owners.length > 2) return fail('WIRING_RECOVERY_INVALID', '恢复请求须明确原维护、连接、运行身份及每把原锁的令牌和文件节点。');
  const startup = request.startup;
  const owners: { role: string; proof: StateOwnershipProof }[] = [];
  for (const value of request.owners) {
    if (!isWfdRecord(value) || Object.keys(value).sort().join() !== 'proof,role' || !['personal', 'workspace'].includes(String(value.role))
      || !proofValid(value.proof) || value.proof.pid !== startup.pid || owners.some(owner => owner.role === value.role)) return fail('WIRING_RECOVERY_INVALID', '只能恢复同一原进程持有的明确个人/工作台所有者锁。');
    owners.push({ role: String(value.role), proof: value.proof });
  }
  const launcher = readRuntimeLauncher(options.launcherFile), resources = new ResourceBindings(launcher.runtimeRoot);
  if (request.runtimeRoot !== launcher.runtimeRoot || request.runtimeIdentity !== launcher.runtimeIdentity) return fail('WIRING_RECOVERY_IDENTITY', '原维护运行身份与当前启动定位不一致。');
  const fencePath = options.launcherFile + '.runtime-maintenance.lock';
  const verifyFence = () => {
    const node = lstatSync(fencePath, { bigint: true }), raw = readPinned(fencePath), owner = JSON.parse(raw);
    if (!node.isFile() || node.nlink !== 1n || String(node.dev) !== startup.device || String(node.ino) !== startup.inode || sha(raw) !== startup.sha256
      || owner.version !== 1 || owner.pid !== startup.pid || owner.token !== startup.token || owner.operation !== 'relocate-client'
      || owner.runtimeRoot !== launcher.runtimeRoot || owner.intent !== request.intent || owner.connectionId !== request.connectionId) return fail('WIRING_RECOVERY_IDENTITY', '原启动围栏的节点、令牌或改址意图不符。');
    try { process.kill(startup.pid, 0); return fail('WIRING_RECOVERY_ACTIVE', '原维护进程仍在，拒绝释放任何锁。'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error; }
    const current = lstatSync(fencePath, { bigint: true });
    if (current.dev !== node.dev || current.ino !== node.ino || readPinned(fencePath) !== raw) return fail('WIRING_RECOVERY_IDENTITY', '原启动围栏在读取期间发生变化。');
  };
  verifyFence();
  const registryPath = resources.path('connections_registry'), registry = JSON.parse(readPinned(registryPath));
  const lines = Array.isArray(registry.connections) ? registry.connections.filter((line: unknown) => isWfdRecord(line) && line.id === request.connectionId) : [];
  const line = lines[0];
  if (lines.length !== 1 || !isWfdRecord(line) || line.kind !== 'native-loopback-service' || line.instance_id !== request.instanceId
    || !isWfdRecord(line.harness_binding) || line.harness_binding.root_id !== launcher.runtimeIdentity) return fail('WIRING_RECOVERY_IDENTITY', '原连接/实例及应用配对无法核同。');
  const journalPath = registryPath + '.database-wiring.json';
  if (lstatSync(journalPath, { throwIfNoEntry: false })) {
    const journal = JSON.parse(readPinned(journalPath));
    if (journal.id === request.intent || journal.phase !== 'committed') {
      if (journal.version !== 1 || journal.operation !== 'relocate-client' || journal.id !== request.intent || journal.maintenanceIntent !== request.intent
        || journal.connectionId !== request.connectionId || journal.instanceId !== request.instanceId || journal.newRoot !== launcher.runtimeRoot
        || journal.rootId !== launcher.runtimeIdentity || !['prepared', 'committed'].includes(journal.phase)) return fail('WIRING_RECOVERY_IDENTITY', '现有日志属于其他维护或身份不明，保留原锁。');
    }
  }
  const workspacePath = join(resources.path('state'), 'workspace/core.sqlite'), db = new DatabaseSync(workspacePath, { readOnly: true });
  try {
    const selection = db.prepare('SELECT s.*,c.expected_revision,c.from_connection_id,c.to_connection_id,c.state FROM database_line_selection s LEFT JOIN database_line_changes c ON c.id=s.pending_id WHERE s.singleton=1').get();
    const saved = db.prepare('SELECT identity_json,identity_sha256 FROM database_line_identities WHERE connection_id=?').get(String(request.connectionId));
    const identity = saved && JSON.parse(String(saved.identity_json));
    if (!selection || selection.connection_id !== request.connectionId || !identity || identity.instanceId !== request.instanceId
      || identity.connectionId !== request.connectionId || identity.harnessRootId !== launcher.runtimeIdentity || sha(canonicalWfdJson(identity)) !== saved?.identity_sha256
      || !isWfdRecord(line.credential_ref) || Object.entries({ instanceId: line.instance_id, principalId: line.principal_id, mode: line.mode, purpose: line.purpose,
        protocol: line.protocol, protocolRevision: line.protocol_revision, schemaSha256: line.protocol_schema_sha256, credentialReference: line.credential_ref.registry_id,
        runtimeRoot: line.runtime_root, libraryRoot: line.library_root, storageId: line.storage_id }).some(([key, value]) => value === undefined || identity[key] !== value)
      || selection.pending_id !== null && (selection.pending_id !== request.intent || !['maintenance', 'maintenance-blocked'].includes(String(selection.state))
        || selection.from_connection_id !== request.connectionId || selection.to_connection_id !== request.connectionId || selection.expected_revision !== selection.revision)) return fail('WIRING_RECOVERY_IDENTITY', '原工作台选择、冻结身份或维护事务不符，保留原锁。');
  } finally { db.close(); }
  const recoveries: { role: string; release(): Promise<void> }[] = [], alreadyReleased: string[] = [];
  for (const role of ['personal', 'workspace']) {
    const path = join(resources.path('state'), role, 'core.sqlite'), lock = join(dirname(path), '.harness-owner.lock');
    const expected = owners.find(owner => owner.role === role);
    if (lstatSync(lock, { throwIfNoEntry: false })) {
      if (!expected) return fail('WIRING_RECOVERY_IDENTITY', '发现请求未列明的状态所有者锁，拒绝部分释放。');
      recoveries.push({ role, release: await prepareStateRootRecovery(path, expected.proof) });
    } else if (expected) alreadyReleased.push(role);
  }
  // 原围栏始终保持：即使恢复进程中断，下一次仍只能提交同一原锁证明。
  for (const recovery of recoveries) { verifyFence(); await recovery.release(); }
  verifyFence(); recoverRuntimeMaintenance(options.launcherFile, startup.token, startup);
  return { status: 'recovered', intent: request.intent, connectionId: request.connectionId, instanceId: request.instanceId,
    releasedOwners: recoveries.map(owner => owner.role), alreadyReleased, startupReleased: true, businessStateChanged: false };
}

/** 原应用改址后，沿同一实例/主体/应用身份修复双方配对；在线核验前保留原维护封闭。 */
export async function relocateDatabaseClient(options: { connectionId: string; intent: string; launcherFile: string;
  /** 仅隔离测试注入提供方和中断边界；命令行不接受这些选项。 */
  testHooks?: { provider?(journal: Readonly<RelocationJournal>): Promise<unknown>;
    afterPhase?(phase: 'fenced' | 'personal-owned' | 'workspace-owned' | 'staged' | 'prepared' | 'maintenance' | 'provider' | 'registry' | 'committed'): void } }) {
  if (!options.connectionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.intent)) return fail('WIRING_INTENT_REQUIRED', '需要明确连接及稳定维护意图。');
  const launcher = readRuntimeLauncher(options.launcherFile), resources = new ResourceBindings(launcher.runtimeRoot);
  const fence = acquireRuntimeStartupFence(options.launcherFile, launcher.runtimeRoot, { intent: options.intent, connectionId: options.connectionId }), releases: (() => Promise<void>)[] = [];
  let workspace: DatabaseSync | undefined;
  try {
    options.testHooks?.afterPhase?.('fenced');
    assertRuntimeStopped(launcher.runtimeRoot);
    for (const role of ['personal', 'workspace']) {
      const path = join(resources.path('state'), role, 'core.sqlite');
      if (lstatSync(path, { throwIfNoEntry: false })) {
        releases.push(await ownStateRoot(path)); options.testHooks?.afterPhase?.(role === 'personal' ? 'personal-owned' : 'workspace-owned');
      }
    }
    fence.verify();
    const registryPath = resources.path('connections_registry'), journalPath = registryPath + '.database-wiring.json';
    const raw = readPinned(registryPath), registry = JSON.parse(raw);
    const selectLine = (value: WfdRecord): WfdRecord => {
      const matches = Array.isArray(value.connections) ? value.connections.filter(item => isWfdRecord(item) && item.id === options.connectionId) : [];
      if (matches.length !== 1) return fail('WIRING_CONNECTION_UNKNOWN', '须精确选择已登记的一条原连接。');
      return matches[0] as WfdRecord;
    };
    const line = selectLine(registry), binding = line.harness_binding;
    if (line.kind !== 'native-loopback-service' || !isWfdRecord(binding) || binding.root_id !== launcher.runtimeIdentity
      || typeof binding.root !== 'string' || !isAbsolute(binding.root) || resolve(binding.root) !== binding.root || !isWfdRecord(line.startup)
      || typeof line.startup.cwd !== 'string' || typeof line.library_root !== 'string'
      || typeof line.runtime_root !== 'string' || typeof line.instance_id !== 'string' || typeof line.storage_id !== 'string'
      || !['user_test', 'production'].includes(String(line.mode)) || line.purpose !== line.mode) return fail('WIRING_PAIR_MISMATCH', '只能修复原应用固定身份的既有数据库配对。');
    const existingRaw = lstatSync(journalPath, { throwIfNoEntry: false }) ? readPinned(journalPath) : undefined;
    const existing = existingRaw === undefined ? undefined : JSON.parse(existingRaw);
    const matching = existing?.operation === 'relocate-client' && existing.id === options.intent && existing.connectionId === options.connectionId;
    if (existing && existing.phase !== 'committed' && !matching) return fail('WIRING_PENDING', '另一个采用事务尚未完成，请沿其原意图恢复。');
    let journal = matching ? existing as RelocationJournal : undefined;
    const staged = registryPath + '.wiring-staged-' + options.intent;
    let beforeRaw = raw, original = registry;
    if (journal) {
      const keys = ['version', 'id', 'phase', 'contractSha256', 'maintenanceIntent', 'items', 'at', 'operation', 'connectionId', 'instanceId',
        'oldRoot', 'newRoot', 'rootId', 'storageId', 'sourceRoot', 'libraryRoot', 'beforeRaw', 'lineIdentitySha256', 'instanceSha256', 'selectionRevision'];
      if (Object.keys(journal).sort().join() !== keys.sort().join() || journal.version !== 1 || !['prepared', 'committed'].includes(journal.phase)
        || journal.maintenanceIntent !== options.intent || typeof journal.beforeRaw !== 'string' || journal.beforeRaw.length > 8_388_608
        || typeof journal.at !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.lineIdentitySha256)
        || !/^[a-f0-9]{64}$/u.test(journal.instanceSha256) || !Number.isSafeInteger(journal.selectionRevision)
        || !Array.isArray(journal.items) || journal.items.length !== 1 || !isWfdRecord(journal.items[0])
        || Object.keys(journal.items[0]).sort().join() !== 'after,before,path,staged'
        || journal.items[0].path !== registryPath || journal.items[0].staged !== staged) return fail('WIRING_JOURNAL_INVALID', '改址日志的身份、阶段或唯一登记项无效。');
      beforeRaw = journal.beforeRaw; original = JSON.parse(beforeRaw);
    }
    const prior = selectLine(original), priorBinding = prior.harness_binding;
    if (!isWfdRecord(priorBinding) || typeof priorBinding.root !== 'string' || !isAbsolute(priorBinding.root) || resolve(priorBinding.root) !== priorBinding.root
      || priorBinding.root_id !== launcher.runtimeIdentity || priorBinding.root === launcher.runtimeRoot
      || lstatSync(priorBinding.root, { throwIfNoEntry: false })) return fail('WIRING_RELOCATION_NOT_PROVEN', '原目录须已搬离，当前根须为同身份的新位置。');
    const after = { ...original, connections: (original.connections as WfdRecord[]).map(item => item.id === options.connectionId
      ? { ...item, harness_binding: { ...priorBinding, root: launcher.runtimeRoot } } : item) };
    const bytes = encoded(after), beforeSha = sha(beforeRaw), afterSha = sha(bytes);
    const contractSha256 = sha(canonicalWfdJson({ before: original, after }));
    if (journal && (journal.newRoot !== launcher.runtimeRoot || journal.oldRoot !== priorBinding.root || journal.rootId !== launcher.runtimeIdentity
      || journal.instanceId !== prior.instance_id || journal.storageId !== prior.storage_id || journal.sourceRoot !== (prior.startup as WfdRecord)?.cwd
      || journal.libraryRoot !== prior.library_root || journal.contractSha256 !== contractSha256
      || journal.items[0]!.before !== beforeSha || journal.items[0]!.after !== afterSha)) return fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '改址日志并非原登记只改变客户端位置的唯一投影。');
    if (raw !== beforeRaw && raw !== bytes || journal?.phase === 'committed' && raw !== bytes) return fail('WIRING_CONFLICT', '连接登记不是本意图的原件或唯一目标，拒绝覆盖。');
    const stagedExists = !!lstatSync(staged, { throwIfNoEntry: false });
    if (stagedExists && readPinned(staged) !== bytes || journal?.phase === 'prepared' && !stagedExists) return fail('WIRING_STAGED_CHANGED', '暂存缺失或不符合原登记的唯一目标。');
    const workspacePath = join(resources.path('state'), 'workspace/core.sqlite');
    let selected: WfdRecord | undefined, savedIdentity: WfdRecord | undefined;
    const work = relocationWork(resources, String(line.instance_id));
    for (const role of ['personal', 'workspace']) {
      const path = join(resources.path('state'), role, 'core.sqlite');
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
        for (const table of ['conversation_data_cycles', 'conversation_result_publications', 'candidate_submissions']) {
          if (!tables.has(table)) continue;
          for (const row of db.prepare(`SELECT envelope_json FROM ${table} WHERE state NOT IN ('verified','failed','rejected','cancelled')`).all()) {
            if (JSON.parse(String(row.envelope_json)).instance_id === line.instance_id) return fail('WIRING_UNRESOLVED', '原实例仍有未核提交，须先按原请求核对。');
          }
        }
        if (tables.has('database_line_selection')) {
          const selection = db.prepare('SELECT s.*,c.expected_revision,c.from_connection_id,c.to_connection_id,c.state FROM database_line_selection s LEFT JOIN database_line_changes c ON c.id=s.pending_id WHERE s.singleton=1').get();
          if (selection?.pending_id && (selection.pending_id !== options.intent || !['maintenance', 'maintenance-blocked'].includes(String(selection.state))
            || selection.from_connection_id !== options.connectionId || selection.to_connection_id !== options.connectionId
            || selection.expected_revision !== selection.revision)) return fail('WIRING_PENDING', '连接选择仍处于另一维护事务。');
          if (role === 'workspace') {
            if (!selection || selection.connection_id !== options.connectionId || !tables.has('database_line_identities')) return fail('WIRING_MAINTENANCE_REQUIRED', '改址必须沿原工作台当前选择的连接与身份。');
            selected = selection;
            savedIdentity = db.prepare('SELECT identity_json,identity_sha256 FROM database_line_identities WHERE connection_id=?').get(options.connectionId);
            if (tables.has('database_line_business_ledgers') && db.prepare('SELECT path FROM database_line_business_ledgers').all().some(row =>
              !['personal', 'workspace'].some(name => row.path === join(resources.path('state'), name, 'core.sqlite')))) return fail('WIRING_LEDGER_UNAVAILABLE', '原业务账尚未全部核到受锁状态，保持封闭。');
          }
        }
        assertRelocationWorkSettled(db, tables, work, String(line.instance_id));
        // 无关采集needs_review保留原账；只有活动执行须先收束。
        if (tables.has('tasks') && db.prepare("SELECT 1 FROM tasks WHERE status IN ('running','waiting','waiting_approval','pausing','cancelling') LIMIT 1").get()) return fail('WIRING_IN_USE', '应用仍有活动任务。');
        if (tables.has('runs') && db.prepare("SELECT 1 FROM runs WHERE state IN ('running','waiting') LIMIT 1").get()) return fail('WIRING_IN_USE', '应用仍有活动模型运行。');
      } finally { db.close(); }
    }
    if (!selected || !savedIdentity) return fail('WIRING_MAINTENANCE_REQUIRED', '原连接身份及工作台维护记录缺失，不能补猜或新建业务账。');
    const identity = JSON.parse(String(savedIdentity.identity_json));
    if (sha(canonicalWfdJson(identity)) !== savedIdentity.identity_sha256 || !isWfdRecord(prior.credential_ref)
      || Object.entries({ connectionId: options.connectionId, instanceId: prior.instance_id, principalId: prior.principal_id,
        mode: prior.mode, purpose: prior.purpose, protocol: prior.protocol, protocolRevision: prior.protocol_revision,
        schemaSha256: prior.protocol_schema_sha256, credentialReference: prior.credential_ref.registry_id,
        runtimeRoot: prior.runtime_root, libraryRoot: prior.library_root, storageId: prior.storage_id, harnessRootId: launcher.runtimeIdentity })
        .some(([key, value]) => value === undefined || identity[key] !== value)
      || journal && (journal.lineIdentitySha256 !== savedIdentity.identity_sha256 || journal.selectionRevision !== selected.revision)) return fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '原连接账的实例、主体、权限引用、协议或维护修订不符。');
    const manifestPath = join(String(prior.runtime_root), 'instance.json'), manifest = JSON.parse(readPinned(manifestPath));
    const instanceSha256 = sha(canonicalWfdJson(manifest));
    if (manifest.instance_id !== prior.instance_id || manifest.principal_id !== prior.principal_id || manifest.mode !== prior.mode
      || manifest.purpose !== prior.purpose || manifest.schema_sha256 !== prior.protocol_schema_sha256
      || manifest.production_enabled !== (prior.mode === 'production') || !isWfdRecord(manifest.dataset_bindings)
      || prior.mode === 'production' && Object.keys(manifest.dataset_bindings).length !== 0
      || journal && journal.instanceSha256 !== instanceSha256) return fail('WIRING_INSTANCE_MISMATCH', '实际实例的主体、协议、用途或权限元数据不是原连接。');
    const record = JSON.parse(readPinned(join(String(prior.library_root), 'data/storage.json')));
    if (!isWfdRecord(record.harness_binding) || ![priorBinding.root, launcher.runtimeRoot].includes(String(record.harness_binding.root))
      || !journal && record.harness_binding.root !== priorBinding.root) return fail('WIRING_STORAGE_MISMATCH', '提供方位置不是原件或本次目标。');
    assertStorageRecord(record, { libraryRoot: String(prior.library_root), mode: String(prior.mode), runtimeRoot: String(prior.runtime_root),
      harnessRoot: String(record.harness_binding.root), harnessRootId: launcher.runtimeIdentity });
    const originalStorage = { ...record, harness_binding: { ...record.harness_binding, root: priorBinding.root } };
    if (record.storage_id !== prior.storage_id || identity.storageBindingSha256 !== sha(canonicalWfdJson(originalStorage))) return fail('WIRING_STORAGE_MISMATCH', '保管原件摘要或固定身份与原连接账不符。');
    if (!journal) {
      if (!stagedExists) atomic(staged, bytes, null);
      options.testHooks?.afterPhase?.('staged');
      journal = { version: 1, id: options.intent, operation: 'relocate-client', phase: 'prepared', maintenanceIntent: options.intent,
        contractSha256, connectionId: options.connectionId, instanceId: String(prior.instance_id), storageId: String(prior.storage_id),
        oldRoot: priorBinding.root, newRoot: launcher.runtimeRoot, rootId: launcher.runtimeIdentity, sourceRoot: String((prior.startup as WfdRecord).cwd),
        libraryRoot: String(prior.library_root), beforeRaw, instanceSha256, lineIdentitySha256: String(savedIdentity.identity_sha256), selectionRevision: Number(selected.revision),
        items: [{ path: registryPath, before: beforeSha, after: afterSha, staged }], at: new Date().toISOString() };
      atomic(journalPath, encoded(journal), existingRaw === undefined ? null : sha(existingRaw));
    }
    options.testHooks?.afterPhase?.('prepared');
    workspace = new DatabaseSync(workspacePath);
    workspace.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      const current = workspace.prepare('SELECT s.*,c.expected_revision,c.from_connection_id,c.to_connection_id,c.state FROM database_line_selection s LEFT JOIN database_line_changes c ON c.id=s.pending_id WHERE s.singleton=1').get();
      const saved = workspace.prepare('SELECT identity_json,identity_sha256 FROM database_line_identities WHERE connection_id=?').get(options.connectionId);
      if (!current || current.connection_id !== options.connectionId || current.revision !== journal.selectionRevision || saved?.identity_sha256 !== journal.lineIdentitySha256
        || saved?.identity_json !== savedIdentity.identity_json
        || current.pending_id !== null && (current.pending_id !== options.intent || !['maintenance', 'maintenance-blocked'].includes(String(current.state))
          || current.expected_revision !== current.revision || current.from_connection_id !== options.connectionId || current.to_connection_id !== options.connectionId)) return fail('WIRING_MAINTENANCE_CONFLICT', '原连接维护围栏或修订已变化。');
      if (current.pending_id === null) {
        if (workspace.prepare('SELECT 1 FROM database_line_changes WHERE id=?').get(options.intent)) return fail('WIRING_MAINTENANCE_CONFLICT', '原意图已有结束或脱离选择的记录，不能重新开启。');
        workspace.prepare("INSERT INTO database_line_changes VALUES(?,?,?,?,'maintenance',NULL,NULL,?,?)")
          .run(options.intent, journal.selectionRevision, options.connectionId, options.connectionId, Date.now(), Date.now());
        workspace.prepare('UPDATE database_line_selection SET pending_id=? WHERE singleton=1').run(options.intent);
      }
      workspace.exec('COMMIT');
    } catch (error) { workspace.exec('ROLLBACK'); throw error; }
    options.testHooks?.afterPhase?.('maintenance');
    const runtime = new ProcessRuntime(resources);
    const receipt = options.testHooks?.provider ? await options.testHooks.provider(journal) : JSON.parse((await runDirectProcess({ runtime, binary: 'python3', cwd: journal.sourceRoot,
      args: ['-B', '-m', 'core.storage', 'rebind-client', '--outer-root', journal.libraryRoot, '--expected-instance', journal.instanceId,
        '--old-harness-root', journal.oldRoot, '--harness-root', journal.newRoot, '--harness-root-id', journal.rootId, '--intent', journal.id],
      signal: new AbortController().signal, assertAuthorized: () => { runtime.path('python3'); }, timeoutMs: 30_000, maxOutputBytes: 1_048_576 })).stdout);
    options.testHooks?.afterPhase?.('provider');
    if (sha(canonicalWfdJson(JSON.parse(readPinned(manifestPath)))) !== journal.instanceSha256) return fail('WIRING_INSTANCE_MISMATCH', '提供方改址期间实例元数据发生变化。');
    const adopted = JSON.parse(readPinned(join(journal.libraryRoot, 'data/storage.json')));
    const targetStorage = { ...originalStorage, harness_binding: { ...(originalStorage.harness_binding as WfdRecord), root: launcher.runtimeRoot } };
    if (!isWfdRecord(receipt) || receipt.state !== 'committed' || receipt.intent !== journal.id || receipt.instance_id !== prior.instance_id
      || receipt.storage_id !== journal.storageId || receipt.binding_sha256 !== sha(canonicalWfdJson(targetStorage))
      || canonicalWfdJson(adopted) !== canonicalWfdJson(targetStorage)) return fail('WIRING_PROVIDER_UNVERIFIED', '提供方未证明原保管只改变客户端位置。');
    if (readPinned(registryPath) !== bytes) atomic(registryPath, bytes, beforeSha);
    options.testHooks?.afterPhase?.('registry');
    fence.verify();
    if (readPinned(registryPath) !== bytes) return fail('WIRING_CONFLICT', '连接登记未读回本次唯一目标。');
    const previous = readPinned(journalPath);
    if (previous !== encoded(journal)) return fail('WIRING_CONFLICT', '原改址日志在维护期间发生变化。');
    journal.phase = 'committed'; atomic(journalPath, encoded(journal), sha(previous));
    options.testHooks?.afterPhase?.('committed');
    if (lstatSync(staged, { throwIfNoEntry: false })) {
      if (readPinned(staged) !== bytes) return fail('WIRING_STAGED_CHANGED', '已提交的暂存内容后来发生变化，保留现场。');
      unlinkSync(staged);
    }
    return { status: 'committed', id: journal.id, connectionId: options.connectionId, instanceId: prior.instance_id,
      rootId: launcher.runtimeIdentity, providerReceipt: receipt, credentialsChanged: false, permissionsChanged: false, maintenanceStillFrozen: true };
  } finally { workspace?.close(); for (const release of releases.reverse()) await release(); fence.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = process.argv.slice(2), positional = raw.filter(value => !value.startsWith('--'));
    const flags = raw.filter(value => value.startsWith('--'));
    if (flags.some(value => !value.startsWith('--launcher=')) || flags.length > 1) throw new Error('只接受明确的--launcher启动定位选项。');
    const [command, contractPath, maintenanceIntent, resumeIntent] = positional;
    const launcherFile = flags[0]?.slice('--launcher='.length) ?? launcherPath();
    if (command === 'recover-relocation-locks' && contractPath && positional.length === 2) {
      console.log(JSON.stringify(await recoverRelocationLocks({ requestPath: contractPath, launcherFile }), null, 2));
    } else if (!contractPath || !maintenanceIntent) throw new Error('需要提供连接合同/连接编号及明确维护意图。');
    else if (command === 'relocate-client' && positional.length === 3) {
      console.log(JSON.stringify(await relocateDatabaseClient({ connectionId: contractPath, intent: maintenanceIntent, launcherFile }), null, 2));
    } else if (command === 'apply' && positional.length <= 4) {
      console.log(JSON.stringify(await adoptDatabaseWiring({ contractPath, maintenanceIntent, resumeIntent, launcherFile }), null, 2));
    } else throw new Error('Usage: database-wiring.ts apply <contract> <intent> [resume] | relocate-client <connection-id> <intent> | recover-relocation-locks <request.json> [--launcher=file]');
  } catch (error) { console.error(JSON.stringify({ code: (error as { code?: string }).code ?? 'WIRING_FAILED', error: error instanceof Error ? error.message : '采用未完成。' })); process.exitCode = 1; }
}

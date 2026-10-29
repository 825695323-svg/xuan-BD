import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import type { TaskDispatchGuard } from '../jobs/tasks.js';
import { CoreDatabase } from '../state/database.js';
import { LocalDataLifecycleError } from './errors.js';

/**
 * 单份本地资料的停用/解除绑定控制。
 *
 * 边界：
 * - 只控制“采用关系”和新的派发代次；不删除文件、凭据或外部数据库，也不重建缺失原资料。
 * - 本类不创建用户认证、token 或多账号体系；调用方必须来自既有可信本机管理入口。
 * - 停用先持久化状态与递增 generation，再调用注入的收束钩子；旧代次之后不能派发新动作。
 * - 解绑只改采用关系；未收束、needs_review 或外部结果未知时保持停用并拒绝解绑。
 */

export type LocalDataLifecycleStatus = 'active' | 'deactivating' | 'inactive' | 'unbound';
export type LocalDataOperationKind = 'deactivate' | 'unbind';
export type LocalDataOperationState = 'pending' | 'settling' | 'unresolved' | 'settled' | 'completed' | 'stopped';
export type LocalDataSettlementOutcome = 'settled' | 'unresolved';

export interface LocalDataReloadRecord {
  readonly operationId: string;
  readonly dataId: string;
  readonly state: 'pending' | 'loaded';
  readonly expectedGeneration: number;
  readonly generation: number;
  readonly reason: string;
  readonly requestedAt: number;
  readonly loadedAt: number | null;
}

export interface LocalDataQuiescence {
  readonly operationId: string;
  readonly dataId: string;
  readonly evidence: string;
  readonly pendingTaskIds: readonly string[];
  readonly quiescedAt: number;
}

export interface LocalDataLifecycleRecord {
  readonly dataId: string;
  readonly status: LocalDataLifecycleStatus;
  readonly generation: number;
  readonly adopted: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  readonly lastOperation: LocalDataOperation | null;
  /** 已保存的重新加载请求；有待重启项时本进程不会自行打开个人资料。 */
  readonly reloadPending: LocalDataReloadRecord | null;
  /** 宿主已证明执行器停止、但外部结果仍需保留待核的善后记录。 */
  readonly quiescence: LocalDataQuiescence | null;
}

export interface LocalDataOperation {
  readonly operationId: string;
  readonly dataId: string;
  readonly kind: LocalDataOperationKind;
  readonly state: LocalDataOperationState;
  readonly expectedGeneration: number;
  readonly generation: number;
  readonly reason: string;
  readonly evidence: string | null;
  readonly pendingTaskIds: readonly string[];
  readonly stopRequested: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalDataSettlementContext {
  readonly dataId: string;
  readonly operationId: string;
  /** 已持久化并生效的新代次；旧代次在此之后必须被拒绝。 */
  readonly generation: number;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface LocalDataSettlementResult {
  readonly outcome: LocalDataSettlementOutcome;
  readonly evidence: string;
  /** 仍未收束或原状态为 needs_review 的任务；非空即强制未决，不能解绑。 */
  readonly pendingTaskIds?: readonly string[];
  /** 宿主有真实证据表明执行器已停（无活动任务/运行/审批/浏览器/采集），未决只来自外部结果。 */
  readonly executionStopped?: boolean;
}

export type LocalDataSettler = (context: LocalDataSettlementContext) => Promise<LocalDataSettlementResult>;

export interface LocalDataLifecycleOptions {
  /**
   * 持久控制库位置。由 launcher/注入逻辑给出，必须位于清理范围之外；
   * 本模块不把机器路径写死，也不把控制记录放在待停用/待清理资料根内。
   */
  controlDatabasePath: string;
  /** 本次清理/停用可能涉及的资料根；用于拒绝把控制记录放进清理范围。 */
  cleanupRoots?: readonly string[];
  settle: LocalDataSettler;
  /** 默认读取 task.args.localDataId；只认显式字段，不按路径猜测。 */
  dataIdFromTask?: (task: TaskRecord) => string | null;
  now?: () => number;
}

export interface LocalDataDeactivateInput {
  dataId: string;
  operationId: string;
  expectedGeneration: number;
  reason: string;
}

export interface LocalDataUnbindInput {
  dataId: string;
  operationId: string;
  expectedGeneration: number;
  reason: string;
}

export interface LocalDataResumeInput {
  dataId: string;
  operationId: string;
  expectedGeneration: number;
  reason: string;
}

export interface LocalDataStopInput {
  dataId: string;
  operationId: string;
}

export interface LocalDataReconcileInput {
  dataId: string;
  operationId: string;
  outcome: LocalDataSettlementOutcome;
  evidence: string;
  /** 省略时沿用原记录；显式空数组只允许在已有外部证据时表达“全部核清”。 */
  pendingTaskIds?: readonly string[];
  /** 只由宿主 settle 传入；客户端不能声明执行器已停。 */
  executionStopped?: boolean;
}

export interface LocalDataReloadInput {
  dataId: string;
  operationId: string;
  expectedGeneration: number;
  reason: string;
}

export interface LocalDataTaskControl {
  list(filter?: { limit?: number }): TaskRecord[];
  get(taskId: string): TaskRecord;
  cancel(taskId: string): Promise<TaskRecord>;
  wait?(taskId: string): Promise<TaskRecord>;
}

interface ControlRow {
  data_id: string;
  status: LocalDataLifecycleStatus;
  generation: number;
  adopted: number;
  revision: number;
  last_operation_id: string | null;
  created_at: number;
  updated_at: number;
}

interface OperationRow {
  operation_id: string;
  data_id: string;
  kind: LocalDataOperationKind;
  state: LocalDataOperationState;
  expected_generation: number;
  generation: number;
  reason: string;
  evidence: string | null;
  pending_task_ids: string;
  stop_requested: number;
  request_digest: string;
  created_at: number;
  updated_at: number;
}

interface ReloadRow {
  operation_id: string;
  data_id: string;
  state: 'pending' | 'loaded';
  expected_generation: number;
  generation: number;
  reason: string;
  requested_at: number;
  loaded_at: number | null;
}

interface QuiescenceRow {
  operation_id: string;
  data_id: string;
  evidence: string;
  pending_task_ids: string;
  quiesced_at: number;
}

interface IdentityRow {
  data_id: string;
  state_path: string;
  device: string;
  inode: string;
  digest: string;
  bound_at: number;
}

interface Admission {
  readonly managed: boolean;
  readonly dataId: string | null;
  readonly generation: number | null;
}

/** 控制记录格式：1 为原停用/解绑；2 增加待重启重载与身份；3 增加执行器已停但外部结果待核的善后记录。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_data_lifecycle (
  data_id TEXT PRIMARY KEY CHECK(length(data_id) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK(status IN ('active','deactivating','inactive','unbound')),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  adopted INTEGER NOT NULL CHECK(adopted IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  last_operation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_data_lifecycle_operations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 200),
  data_id TEXT NOT NULL REFERENCES local_data_lifecycle(data_id),
  kind TEXT NOT NULL CHECK(kind IN ('deactivate','unbind')),
  state TEXT NOT NULL CHECK(state IN ('pending','settling','unresolved','settled','completed','stopped')),
  expected_generation INTEGER NOT NULL CHECK(expected_generation >= 1),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  reason TEXT NOT NULL,
  evidence TEXT,
  pending_task_ids TEXT NOT NULL DEFAULT '[]',
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
  request_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS local_data_operations_data ON local_data_lifecycle_operations(data_id,created_at);
CREATE TABLE IF NOT EXISTS local_data_lifecycle_reloads (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 200),
  data_id TEXT NOT NULL REFERENCES local_data_lifecycle(data_id),
  state TEXT NOT NULL CHECK(state IN ('pending','loaded')),
  expected_generation INTEGER NOT NULL CHECK(expected_generation >= 1),
  generation INTEGER NOT NULL CHECK(generation >= expected_generation + 1),
  reason TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  loaded_at INTEGER
);
CREATE INDEX IF NOT EXISTS local_data_reloads_data ON local_data_lifecycle_reloads(data_id,requested_at);
CREATE TABLE IF NOT EXISTS local_data_lifecycle_quiescence (
  operation_id TEXT PRIMARY KEY REFERENCES local_data_lifecycle_operations(operation_id),
  data_id TEXT NOT NULL REFERENCES local_data_lifecycle(data_id),
  evidence TEXT NOT NULL,
  pending_task_ids TEXT NOT NULL DEFAULT '[]',
  quiesced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_data_lifecycle_identity (
  data_id TEXT PRIMARY KEY REFERENCES local_data_lifecycle(data_id),
  state_path TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  digest TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/u;
const UNSETTLED: readonly LocalDataOperationState[] = ['pending', 'settling', 'unresolved', 'stopped'];

export class LocalDataLifecycle implements TaskDispatchGuard {
  private readonly database: CoreDatabase;
  private readonly settle: LocalDataSettler;
  private readonly dataIdFromTask: (task: TaskRecord) => string | null;
  private readonly now: () => number;
  private readonly admissions = new Map<string, Admission>();
  private readonly running = new Map<string, Promise<LocalDataLifecycleRecord>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(options: LocalDataLifecycleOptions) {
    if (!options || typeof options.controlDatabasePath !== 'string' || !isAbsolute(options.controlDatabasePath)
      || options.controlDatabasePath.includes('\0')) throw new LocalDataLifecycleError('INVALID_CONTROL_PATH', '控制记录位置必须是明确的绝对路径。');
    if (typeof options.settle !== 'function') throw new LocalDataLifecycleError('INVALID_SETTLER', '停用必须注入当前组件的收束钩子。');
    assertOutsideCleanupRoots(options.controlDatabasePath, options.cleanupRoots ?? []);
    mkdirSync(dirname(resolve(options.controlDatabasePath)), { recursive: true, mode: 0o700 });
    this.database = new CoreDatabase(resolve(options.controlDatabasePath));
    chmodSync(resolve(options.controlDatabasePath), 0o600);
    this.database.migrate('local_data_lifecycle', 3, SCHEMA);
    this.settle = options.settle;
    this.dataIdFromTask = options.dataIdFromTask ?? defaultDataIdFromTask;
    this.now = options.now ?? Date.now;
    this.recoverOpenOperations();
  }

  /** 登记一份被采用的本地资料；重复登记只读回原代次，不复活已停用记录。 */
  register(dataId: string, options: { adopted?: boolean } = {}): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(dataId, '本地资料标识');
    return this.database.transaction(() => {
      const existing = this.readRecord(dataId);
      if (existing) return this.statusFrom(existing);
      const now = this.now(), adopted = options.adopted ?? true;
      if (typeof adopted !== 'boolean') throw new LocalDataLifecycleError('INVALID_ADOPTION', '采用状态必须是布尔值。');
      this.database.connection.prepare(`INSERT INTO local_data_lifecycle(data_id,status,generation,adopted,revision,last_operation_id,created_at,updated_at)
        VALUES(?,'active',1,?,1,NULL,?,?)`).run(dataId, Number(adopted), now, now);
      return this.statusFrom(this.requireRecord(dataId));
    });
  }

  status(dataId: string): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(dataId, '本地资料标识');
    return this.statusFrom(this.requireRecord(dataId));
  }

  list(): LocalDataLifecycleRecord[] {
    this.assertOpen();
    return this.database.connection.prepare('SELECT * FROM local_data_lifecycle ORDER BY data_id').all()
      .map((row) => this.statusFrom(row as unknown as ControlRow));
  }

  operation(operationId: string): LocalDataOperation | null {
    this.assertOpen();
    validId(operationId, '操作标识');
    const row = this.readOperation(operationId);
    return row ? operationFrom(row) : null;
  }

  /** 保存一次“重新加载同一已核身份”的请求；本进程不打开个人资料，重启后实际加载。 */
  requestReload(input: LocalDataReloadInput): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new LocalDataLifecycleError('INVALID_GENERATION', '代次必须为正整数。');
    const reason = validReason(input.reason);
    const record = this.database.transaction(() => {
      const current = this.requireRecord(input.dataId);
      if (current.status === 'active') throw new LocalDataLifecycleError('LOCAL_DATA_ALREADY_ACTIVE', '当前资料已经加载。');
      if (current.status !== 'inactive' && current.status !== 'unbound' && current.status !== 'deactivating') {
        throw new LocalDataLifecycleError('LOCAL_DATA_NOT_INACTIVE', '只有已停用、已解绑或执行器已停的未决资料可以保存重新加载。');
      }
      if (current.generation !== input.expectedGeneration) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '当前代次已经变化，请重新读取。');
      const previous = this.readReload(input.operationId);
      if (previous) {
        if (previous.data_id !== input.dataId) throw new LocalDataLifecycleError('OPERATION_CONFLICT', '同一操作标识不能用于其他资料。');
        return current;
      }
      const existing = this.readPendingReload(input.dataId);
      if (existing) return current;
      const last = current.last_operation_id ? this.readOperation(current.last_operation_id) : null;
      const settled = !!last && ['settled', 'completed'].includes(last.state)
        && ((current.status === 'inactive' && last.kind === 'deactivate') || (current.status === 'unbound' && last.kind === 'unbind'));
      // 执行器已停、外部结果仍待核：保留原 operation unresolved 与 pending IDs，允许显式保存重载，不伪结案。
      const quiesced = !!last && current.status === 'deactivating' && last.kind === 'deactivate'
        && UNSETTLED.includes(last.state) && !!this.readQuiescence(last.operation_id);
      if (!settled && !quiesced) throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_UNRESOLVED', '停用/解绑尚未确认收束且没有执行器已停证据，不能保存重新加载。');
      const now = this.now(), generation = current.generation + 1;
      this.database.connection.prepare(`INSERT INTO local_data_lifecycle_reloads(operation_id,data_id,state,expected_generation,generation,reason,requested_at,loaded_at)
        VALUES(?,?,'pending',?,?,?,?,NULL)`).run(input.operationId, input.dataId, input.expectedGeneration, generation, reason, now);
      // 代次立即失效；状态仍保持停用/未决，直到重启后真正打开原资料才标记 loaded。
      this.database.connection.prepare('UPDATE local_data_lifecycle SET generation=?,revision=revision+1,updated_at=? WHERE data_id=?')
        .run(generation, now, input.dataId);
      return this.requireRecord(input.dataId);
    });
    this.notify();
    return this.statusFrom(record);
  }

  /** 重启后真实打开原资料成功时调用；失败不得调用，记录保持待重启。 */
  markReloadLoaded(dataId: string): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(dataId, '本地资料标识');
    const record = this.database.transaction(() => {
      const current = this.requireRecord(dataId);
      const pending = this.readPendingReload(dataId);
      if (!pending) return current;
      if (Number(pending.generation) !== Number(current.generation)) {
        throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '待重启重新加载代次与当前控制记录不一致，不能标记已加载。');
      }
      const now = this.now();
      this.database.connection.prepare("UPDATE local_data_lifecycle_reloads SET state='loaded',loaded_at=? WHERE operation_id=? AND state='pending'")
        .run(now, pending.operation_id);
      this.database.connection.prepare("UPDATE local_data_lifecycle SET status='active',adopted=1,revision=revision+1,updated_at=? WHERE data_id=?")
        .run(now, dataId);
      return this.requireRecord(dataId);
    });
    this.notify();
    return this.statusFrom(record);
  }

  /** 绑定实际个人状态库对象身份；用于停用后重启时拒绝被替换或缺失的原资料。 */
  bindIdentity(dataId: string, statePath: string): void {
    this.assertOpen();
    validId(dataId, '本地资料标识');
    if (typeof statePath !== 'string' || !isAbsolute(statePath) || statePath.includes('\0')) throw new LocalDataLifecycleError('INVALID_IDENTITY_PATH', '个人资料位置必须是明确的绝对路径。');
    const identity = identityOf(statePath);
    this.database.transaction(() => {
      this.requireRecord(dataId);
      this.database.connection.prepare(`INSERT INTO local_data_lifecycle_identity(data_id,state_path,device,inode,digest,bound_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(data_id) DO UPDATE SET state_path=excluded.state_path,device=excluded.device,inode=excluded.inode,digest=excluded.digest,bound_at=excluded.bound_at`)
        .run(dataId, identity.path, identity.device, identity.inode, identity.digest, this.now());
    });
  }

  /** matched 才是同一份原资料；missing/replaced/unbound 都不能自动重建或替换。 */
  identityStatus(dataId: string, statePath: string): 'matched' | 'missing' | 'replaced' | 'unbound' {
    this.assertOpen();
    validId(dataId, '本地资料标识');
    const row = this.database.connection.prepare('SELECT * FROM local_data_lifecycle_identity WHERE data_id=?').get(dataId) as unknown as IdentityRow | undefined;
    if (!row) return 'unbound';
    const canonical = resolve(statePath);
    if (canonical !== row.state_path || !existsSync(canonical)) return 'missing';
    try {
      const stat = statSync(canonical, { bigint: true });
      if (!stat.isFile() || String(stat.dev) !== row.device || String(stat.ino) !== row.inode) return 'replaced';
      return identityOf(canonical).digest === row.digest ? 'matched' : 'replaced';
    } catch { return 'missing'; }
  }

  /**
   * 所有私有 HTTP/SSE 入口的同步资格核对：先确认采用与活动状态，再拒绝旧代次。
   * 缺少代次不等于可使用；客户端必须携带从 /current 读取的实际代次。
   */
  assertPrivateAccess(generation: number | null): LocalDataLifecycleRecord {
    const record = this.assertActive();
    if (!Number.isSafeInteger(generation) || generation === null || generation < 1) {
      throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_REQUIRED', '缺少当前本地资料代次，请先重新核对资格。', 409);
    }
    if (record.generation !== generation) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '本地资料代次已经失效，请先重新核对资格。', 409);
    return record;
  }

  /** 控制记录变化订阅；用于立即关闭已打开的事件流和拒绝迟到响应。 */
  subscribeChanges(listener: () => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 持久停用并使旧代次失效；只有落盘成功后才调用收束钩子。 */
  async deactivate(input: LocalDataDeactivateInput): Promise<LocalDataLifecycleRecord> {
    this.assertOpen();
    const prepared = this.prepareDeactivate(input);
    this.notify();
    if (!prepared.shouldRun) return this.status(prepared.dataId);
    const inFlight = this.running.get(prepared.operationId);
    if (inFlight) return inFlight;
    return this.runSettlement(prepared.operationId);
  }

  /** 只解除采用关系；不删除文件、凭据、外部数据库，也不重建原资料。 */
  unbind(input: LocalDataUnbindInput): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new LocalDataLifecycleError('INVALID_GENERATION', '代次必须为正整数。');
    const reason = validReason(input.reason);
    const digest = requestDigest('unbind', input.dataId, input.expectedGeneration, reason);
    const record = this.database.transaction(() => {
      const record = this.requireRecord(input.dataId);
      const previous = this.readOperation(input.operationId);
      if (previous) {
        if (previous.data_id !== input.dataId || previous.kind !== 'unbind' || previous.request_digest !== digest) {
          throw new LocalDataLifecycleError('OPERATION_CONFLICT', '同一操作标识不能用于不同的解绑请求。');
        }
        return this.statusFrom(record);
      }
      if (!record.adopted || record.status === 'unbound') throw new LocalDataLifecycleError('LOCAL_DATA_ALREADY_UNBOUND', '此本地资料已经解除采用关系。');
      if (this.readPendingReload(input.dataId)) throw new LocalDataLifecycleError('LOCAL_DATA_RELOAD_PENDING', '已保存重新加载，先重启核对或按原记录处理，不能同时解绑。');
      const last = record.last_operation_id ? this.readOperation(record.last_operation_id) : null;
      if (last && UNSETTLED.includes(last.state)) throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_UNRESOLVED', '停用尚未确认收束，不能解除绑定；未知外部结果继续保留。');
      if (record.status === 'deactivating') throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_UNRESOLVED', '停用尚未确认收束，不能解除绑定；未知外部结果继续保留。');
      if (record.status === 'active') throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_REQUIRED', '先完成停用并使旧代次失效，才能解除绑定。');
      if (record.generation !== input.expectedGeneration) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '当前代次已经变化，请重新读取停用状态。');
      const now = this.now(), generation = record.generation + 1;
      this.insertOperation({ operationId: input.operationId, dataId: input.dataId, kind: 'unbind', state: 'completed',
        expectedGeneration: input.expectedGeneration, generation, reason, evidence: '仅解除采用关系；未删除文件、凭据或外部数据库。',
        pendingTaskIds: [], stopRequested: false, digest, now });
      this.updateRecord(input.dataId, 'unbound', generation, false, now, input.operationId);
      return this.statusFrom(this.requireRecord(input.dataId));
    });
    this.notify();
    return record;
  }

  /** 原操作重开恢复：沿用同一操作标识与代次，不新建操作、不自动恢复业务。 */
  async resume(input: LocalDataResumeInput): Promise<LocalDataLifecycleRecord> {
    this.assertOpen();
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new LocalDataLifecycleError('INVALID_GENERATION', '代次必须为正整数。');
    const reason = validReason(input.reason);
    const operation = this.database.transaction(() => {
      const record = this.requireRecord(input.dataId);
      const previous = this.readOperation(input.operationId);
      if (!previous || previous.data_id !== input.dataId || previous.kind !== 'deactivate') {
        throw new LocalDataLifecycleError('OPERATION_NOT_FOUND', '没有找到该资料的停用操作。');
      }
      if (record.status !== 'deactivating') return previous;
      if (record.generation !== input.expectedGeneration) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '当前代次已经变化，请重新读取停用状态。');
      if (!UNSETTLED.includes(previous.state)) return previous;
      const now = this.now();
      // 保留原操作原因与 request digest；恢复原因只追加为证据。
      this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='pending',stop_requested=0,evidence=?,updated_at=? WHERE operation_id=?")
        .run(appendEvidence(previous.evidence, `按原操作恢复：${reason}`), now, input.operationId);
      this.touchRecord(input.dataId, now, 'deactivating');
      return this.readOperation(input.operationId)!;
    });
    this.notify();
    if (operation.state !== 'pending') return this.status(input.dataId);
    const inFlight = this.running.get(input.operationId);
    if (inFlight) return inFlight;
    return this.runSettlement(input.operationId);
  }

  /** 受限停止：只撤销本进程的收束等待，保持停用与未知事实，不恢复业务。 */
  stop(input: LocalDataStopInput): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    const record = this.database.transaction(() => {
      const current = this.requireRecord(input.dataId);
      const previous = this.readOperation(input.operationId);
      if (!previous || previous.data_id !== input.dataId || previous.kind === 'unbind') throw new LocalDataLifecycleError('OPERATION_NOT_FOUND', '没有找到该资料的停用操作。');
      if (previous.state === 'settled' || previous.state === 'completed') return current;
      if (!UNSETTLED.includes(previous.state)) throw new LocalDataLifecycleError('INVALID_OPERATION_STATE', '此停用操作不能停止。');
      const now = this.now();
      this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='stopped',stop_requested=1,evidence=?,updated_at=? WHERE operation_id=?")
        .run(appendEvidence(previous.evidence, '操作者停止收束等待；未确认的外部结果继续保留。'), now, input.operationId);
      this.database.connection.prepare('DELETE FROM local_data_lifecycle_quiescence WHERE operation_id=?').run(input.operationId);
      this.touchRecord(input.dataId, now, 'deactivating');
      return this.requireRecord(input.dataId);
    });
    this.controllers.get(input.operationId)?.abort(new LocalDataLifecycleError('LOCAL_DATA_SETTLEMENT_STOPPED', '停用收束已按操作者请求停止；未决事实保留。'));
    this.notify();
    return this.statusFrom(record);
  }

  /** 受限核对：只接受明确证据；未列明的原待核任务不能被静默清除。 */
  reconcile(input: LocalDataReconcileInput): LocalDataLifecycleRecord {
    this.assertOpen();
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    if (input.outcome !== 'settled' && input.outcome !== 'unresolved') throw new LocalDataLifecycleError('INVALID_RECONCILIATION', '核对结论无效。');
    if (input.executionStopped !== undefined && typeof input.executionStopped !== 'boolean') throw new LocalDataLifecycleError('INVALID_RECONCILIATION', '执行器停止结论必须是布尔值。');
    const evidence = validEvidence(input.evidence);
    const supplied = input.pendingTaskIds === undefined ? null : validTaskIds(input.pendingTaskIds);
    const record = this.database.transaction(() => {
      const record = this.requireRecord(input.dataId);
      if (record.status !== 'deactivating') throw new LocalDataLifecycleError('LOCAL_DATA_NOT_DEACTIVATING', '只有停用中的资料需要核对收束。');
      const previous = this.readOperation(input.operationId);
      if (!previous || previous.data_id !== input.dataId || previous.kind !== 'deactivate') throw new LocalDataLifecycleError('OPERATION_NOT_FOUND', '没有找到该资料的停用操作。');
      if (previous.state === 'settling') throw new LocalDataLifecycleError('LOCAL_DATA_SETTLING', '收束钩子仍在运行；先等待或停止后再核对。');
      if (previous.state === 'settled' || previous.state === 'completed') return this.statusFrom(record);
      const pending = supplied ?? parseTaskIds(previous.pending_task_ids);
      if (input.outcome === 'settled' && pending.length) throw new LocalDataLifecycleError('LOCAL_DATA_UNRESOLVED', '仍有未收束或待核任务，不能标记为已停用。');
      const now = this.now();
      this.database.connection.prepare('UPDATE local_data_lifecycle_operations SET state=?,evidence=?,pending_task_ids=?,stop_requested=?,updated_at=? WHERE operation_id=?')
        .run(input.outcome === 'settled' ? 'settled' : 'unresolved', appendEvidence(previous.evidence, evidence), JSON.stringify(pending),
          input.outcome === 'settled' ? 0 : Number(previous.stop_requested), now, input.operationId);
      if (input.outcome === 'unresolved' && input.executionStopped) {
        this.database.connection.prepare(`INSERT INTO local_data_lifecycle_quiescence(operation_id,data_id,evidence,pending_task_ids,quiesced_at)
          VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET evidence=excluded.evidence,pending_task_ids=excluded.pending_task_ids,quiesced_at=excluded.quiesced_at`)
          .run(input.operationId, input.dataId, appendEvidence(previous.evidence, evidence).slice(0, 32_000), JSON.stringify(pending), now);
      } else {
        this.database.connection.prepare('DELETE FROM local_data_lifecycle_quiescence WHERE operation_id=?').run(input.operationId);
      }
      const status: LocalDataLifecycleStatus = input.outcome === 'settled' ? 'inactive' : 'deactivating';
      this.touchRecord(input.dataId, now, status);
      return this.statusFrom(this.requireRecord(input.dataId));
    });
    this.notify();
    return record;
  }

  /** TaskService 同步派发闸门；在创建尝试的事务内调用。 */
  assertDispatch(task: TaskRecord): void {
    this.assertOpen();
    const dataId = this.dataIdFromTask(task);
    if (dataId === null) {
      this.admissions.set(task.id, { managed: false, dataId: null, generation: null });
      return;
    }
    validId(dataId, '任务中的本地资料标识');
    const record = this.readRecord(dataId);
    if (!record) throw new LocalDataLifecycleError('LOCAL_DATA_UNKNOWN', '任务引用的本地资料没有控制记录，禁止派发。');
    if (record.status !== 'active' || !record.adopted) throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATED', '本地资料已停用或解绑，不能派发新动作。');
    if (record.last_operation_id) {
      const operation = this.readOperation(record.last_operation_id);
      if (operation && UNSETTLED.includes(operation.state) && !this.hasLoadedReload(dataId, record.generation)) {
        throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_UNRESOLVED', '本地资料停用尚未收束，不能派发新动作。');
      }
    }
    // TaskService 的接收前置使用合成 receive 标识；只核对资格，不能留下无限增长的准入记录。
    if (task.id === 'receive') return;
    if (this.admissions.size >= 4096 && !this.admissions.has(task.id)) {
      const oldest = this.admissions.keys().next().value;
      if (oldest !== undefined) this.admissions.delete(oldest);
    }
    this.admissions.set(task.id, { managed: true, dataId, generation: record.generation });
  }

  /** 每次新动作/授权/预算计量前的同步代次检查；未知任务按失败关闭处理。 */
  assertAction(taskId: string, attemptGeneration: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) throw new LocalDataLifecycleError('INVALID_GENERATION', '任务尝试代次无效。');
    const admission = this.admissions.get(taskId);
    if (!admission) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '没有当前派发准入记录，旧任务不能继续新动作。');
    if (!admission.managed) return;
    const record = this.readRecord(admission.dataId!);
    if (!record || record.status !== 'active' || !record.adopted) throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATED', '本地资料已停用或解绑，当前尝试不能继续新动作。');
    if (record.generation !== admission.generation) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '本地资料代次已经失效，当前尝试不能继续新动作。');
  }

  release(taskId: string): void {
    this.admissions.delete(taskId);
  }

  /** 宿主接收/恢复/模型请求前的同步资格核对；不依赖客户端自报 dataId。 */
  assertActive(): LocalDataLifecycleRecord {
    this.assertOpen();
    const dataId = this.dataIdFromTask({ id: '', args: {} } as TaskRecord);
    if (!dataId) throw new LocalDataLifecycleError('LOCAL_DATA_UNKNOWN', '宿主未提供当前本地资料身份，禁止继续。');
    const record = this.readRecord(dataId);
    if (!record) throw new LocalDataLifecycleError('LOCAL_DATA_UNKNOWN', '当前本地资料没有控制记录，禁止继续。');
    if (!record.adopted || record.status !== 'active') throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATED', '当前本地资料已停用或解绑，不能接收新请求。');
    if (record.last_operation_id) {
      const operation = this.readOperation(record.last_operation_id);
      if (operation && UNSETTLED.includes(operation.state) && !this.hasLoadedReload(dataId, record.generation)) {
        throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATION_UNRESOLVED', '当前本地资料停用尚未收束，不能继续。');
      }
    }
    return this.statusFrom(record);
  }

  /** 当前受信宿主映射到的唯一本地资料标识；不读取客户端字段。 */
  currentDataId(): string | null {
    return this.dataIdFromTask({ id: '', args: {} } as TaskRecord);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort(new LocalDataLifecycleError('LOCAL_DATA_SETTLEMENT_STOPPED', '控制服务关闭，收束等待已撤销；事实保留。'));
    await Promise.allSettled([...this.running.values()]);
    this.listeners.clear();
    this.database.close();
  }

  private prepareDeactivate(input: LocalDataDeactivateInput): { dataId: string; operationId: string; shouldRun: boolean } {
    validId(input?.dataId, '本地资料标识');
    validId(input?.operationId, '操作标识');
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new LocalDataLifecycleError('INVALID_GENERATION', '代次必须为正整数。');
    const reason = validReason(input.reason);
    const digest = requestDigest('deactivate', input.dataId, input.expectedGeneration, reason);
    return this.database.transaction(() => {
      const record = this.requireRecord(input.dataId);
      const previous = this.readOperation(input.operationId);
      if (previous) {
        if (previous.data_id !== input.dataId || previous.kind !== 'deactivate' || previous.request_digest !== digest) {
          throw new LocalDataLifecycleError('OPERATION_CONFLICT', '同一操作标识不能用于不同的停用请求。');
        }
        return { dataId: input.dataId, operationId: input.operationId, shouldRun: false };
      }
      if (record.status === 'deactivating') throw new LocalDataLifecycleError('LOCAL_DATA_DEACTIVATING', '此本地资料已有停用操作尚未收束。');
      if (record.status !== 'active' || !record.adopted) throw new LocalDataLifecycleError('LOCAL_DATA_NOT_ACTIVE', '只有采用中的本地资料可以停用。');
      if (record.generation !== input.expectedGeneration) throw new LocalDataLifecycleError('STALE_LOCAL_DATA_GENERATION', '当前代次已经变化，请重新读取后再停用。');
      const now = this.now(), generation = record.generation + 1;
      this.insertOperation({ operationId: input.operationId, dataId: input.dataId, kind: 'deactivate', state: 'pending',
        expectedGeneration: input.expectedGeneration, generation, reason, evidence: null, pendingTaskIds: [], stopRequested: false, digest, now });
      this.updateRecord(input.dataId, 'deactivating', generation, true, now, input.operationId);
      return { dataId: input.dataId, operationId: input.operationId, shouldRun: true };
    });
  }

  private async runSettlement(operationId: string): Promise<LocalDataLifecycleRecord> {
    const existing = this.running.get(operationId);
    if (existing) return existing;
    const promise = this.settleOperation(operationId);
    this.running.set(operationId, promise);
    try { return await promise; }
    finally { this.running.delete(operationId); }
  }

  private async settleOperation(operationId: string): Promise<LocalDataLifecycleRecord> {
    const initial = this.requireOperation(operationId);
    if (initial.kind !== 'deactivate') throw new LocalDataLifecycleError('INVALID_OPERATION_STATE', '解绑操作没有收束钩子。');
    if (initial.state === 'settled' || initial.state === 'completed') return this.status(initial.data_id);
    if (initial.stop_requested) return this.markUnresolved(operationId, '操作者已停止收束等待；未确认的外部结果继续保留。', parseTaskIds(initial.pending_task_ids));
    this.database.transaction(() => {
      const now = this.now();
      this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='settling',updated_at=? WHERE operation_id=? AND state='pending'").run(now, operationId);
    });
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    try {
      const settlePromise = this.settle({ dataId: initial.data_id, operationId, generation: initial.generation,
        reason: initial.reason, signal: controller.signal });
      void settlePromise.catch(() => { /* 停止竞态后，迟到的拒绝仍由事实记录承担。 */ });
      const result = await Promise.race([settlePromise, abortRejection(controller.signal)]);
      const checked = validateSettlementResult(result);
      const latest = this.requireOperation(operationId);
      const pending = checked.pendingTaskIds ? [...checked.pendingTaskIds] : [];
      if (latest.stop_requested) return this.markUnresolved(operationId, appendEvidence(checked.evidence, '操作者已停止收束等待；不按钩子返回值声称已停用。'), pending);
      if (checked.outcome === 'settled' && pending.length === 0) {
        this.database.transaction(() => {
          const now = this.now();
          this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='settled',evidence=?,pending_task_ids='[]',updated_at=? WHERE operation_id=?")
            .run(checked.evidence, now, operationId);
          this.database.connection.prepare('DELETE FROM local_data_lifecycle_quiescence WHERE operation_id=?').run(operationId);
          this.touchRecord(initial.data_id, now, 'inactive');
        });
        this.notify();
      } else {
        return this.markUnresolved(operationId, checked.evidence, pending, checked.executionStopped === true);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.markUnresolved(operationId, `收束钩子未完成：${detail}`, parseTaskIds(this.requireOperation(operationId).pending_task_ids));
    } finally {
      this.controllers.delete(operationId);
    }
    return this.status(initial.data_id);
  }

  private markUnresolved(operationId: string, evidence: string, pendingTaskIds: readonly string[], executionStopped = false): LocalDataLifecycleRecord {
    const record = this.database.transaction(() => {
      const operation = this.requireOperation(operationId);
      const now = this.now();
      this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='unresolved',evidence=?,pending_task_ids=?,updated_at=? WHERE operation_id=?")
        .run(evidence.slice(0, 32_000), JSON.stringify(pendingTaskIds), now, operationId);
      if (executionStopped) {
        this.database.connection.prepare(`INSERT INTO local_data_lifecycle_quiescence(operation_id,data_id,evidence,pending_task_ids,quiesced_at)
          VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET evidence=excluded.evidence,pending_task_ids=excluded.pending_task_ids,quiesced_at=excluded.quiesced_at`)
          .run(operationId, operation.data_id, evidence.slice(0, 32_000), JSON.stringify(pendingTaskIds), now);
      } else {
        this.database.connection.prepare('DELETE FROM local_data_lifecycle_quiescence WHERE operation_id=?').run(operationId);
      }
      this.touchRecord(operation.data_id, now, 'deactivating');
      return this.statusFrom(this.requireRecord(operation.data_id));
    });
    this.notify();
    return record;
  }

  /** 进程重开只把未完成的收束标成未决并保留，不自动重发或自动恢复。 */
  private recoverOpenOperations(): void {
    const rows = this.database.connection.prepare("SELECT * FROM local_data_lifecycle_operations WHERE state IN ('pending','settling')").all() as unknown as OperationRow[];
    if (!rows.length) return;
    this.database.transaction(() => {
      const now = this.now();
      for (const row of rows) {
        this.database.connection.prepare("UPDATE local_data_lifecycle_operations SET state='unresolved',evidence=?,updated_at=? WHERE operation_id=?")
          .run(appendEvidence(row.evidence, '进程重开时收束钩子未确认完成；保留原操作，需人工核对或按原操作恢复。'), now, row.operation_id);
        this.touchRecord(row.data_id, now, 'deactivating');
      }
    });
  }

  private insertOperation(input: { operationId: string; dataId: string; kind: LocalDataOperationKind; state: LocalDataOperationState;
    expectedGeneration: number; generation: number; reason: string; evidence: string | null; pendingTaskIds: readonly string[];
    stopRequested: boolean; digest: string; now: number }): void {
    this.database.connection.prepare(`INSERT INTO local_data_lifecycle_operations(operation_id,data_id,kind,state,expected_generation,generation,
      reason,evidence,pending_task_ids,stop_requested,request_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.operationId, input.dataId, input.kind, input.state, input.expectedGeneration, input.generation, input.reason,
        input.evidence, JSON.stringify(input.pendingTaskIds), Number(input.stopRequested), input.digest, input.now, input.now);
  }

  private updateRecord(dataId: string, status: LocalDataLifecycleStatus, generation: number, adopted: boolean, updatedAt: number, lastOperationId: string): void {
    this.database.connection.prepare(`UPDATE local_data_lifecycle SET status=?,generation=?,adopted=?,revision=revision+1,last_operation_id=?,updated_at=? WHERE data_id=?`)
      .run(status, generation, Number(adopted), lastOperationId, updatedAt, dataId);
  }

  private touchRecord(dataId: string, updatedAt: number, status: LocalDataLifecycleStatus): void {
    this.database.connection.prepare('UPDATE local_data_lifecycle SET status=?,revision=revision+1,updated_at=? WHERE data_id=?')
      .run(status, updatedAt, dataId);
  }

  private statusFrom(row: ControlRow): LocalDataLifecycleRecord {
    const operation = row.last_operation_id ? this.readOperation(row.last_operation_id) : null;
    const reload = this.readPendingReload(row.data_id);
    const quiescence = operation && UNSETTLED.includes(operation.state) ? this.readQuiescence(operation.operation_id) : null;
    return { dataId: row.data_id, status: row.status, generation: Number(row.generation), adopted: Number(row.adopted) === 1,
      revision: Number(row.revision), updatedAt: Number(row.updated_at), lastOperation: operation ? operationFrom(operation) : null,
      reloadPending: reload ? reloadFrom(reload) : null, quiescence: quiescence ? quiescenceFrom(quiescence) : null };
  }

  private readReload(operationId: string): ReloadRow | null {
    const row = this.database.connection.prepare('SELECT * FROM local_data_lifecycle_reloads WHERE operation_id=?').get(operationId);
    return row ? row as unknown as ReloadRow : null;
  }

  private readPendingReload(dataId: string): ReloadRow | null {
    const row = this.database.connection.prepare("SELECT * FROM local_data_lifecycle_reloads WHERE data_id=? AND state='pending' ORDER BY requested_at DESC LIMIT 1").get(dataId);
    return row ? row as unknown as ReloadRow : null;
  }

  private readQuiescence(operationId: string): QuiescenceRow | null {
    const row = this.database.connection.prepare('SELECT * FROM local_data_lifecycle_quiescence WHERE operation_id=?').get(operationId);
    return row ? row as unknown as QuiescenceRow : null;
  }

  /** 当前代次已有实际加载完成的 reload；新代次可继续，但旧 operation 未决事实仍保留给 unbind 拒绝。 */
  private hasLoadedReload(dataId: string, generation: number): boolean {
    return !!this.database.connection.prepare("SELECT 1 FROM local_data_lifecycle_reloads WHERE data_id=? AND generation=? AND state='loaded' LIMIT 1").get(dataId, generation);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* 订阅者失败不能阻止控制记录生效。 */ }
    }
  }

  private requireRecord(dataId: string): ControlRow {
    const row = this.readRecord(dataId);
    if (!row) throw new LocalDataLifecycleError('LOCAL_DATA_UNKNOWN', '没有找到此本地资料的控制记录。');
    return row;
  }

  private readRecord(dataId: string): ControlRow | null {
    const row = this.database.connection.prepare('SELECT * FROM local_data_lifecycle WHERE data_id=?').get(dataId);
    return row ? row as unknown as ControlRow : null;
  }

  private requireOperation(operationId: string): OperationRow {
    const row = this.readOperation(operationId);
    if (!row) throw new LocalDataLifecycleError('OPERATION_NOT_FOUND', '没有找到此控制操作。');
    return row;
  }

  private readOperation(operationId: string): OperationRow | null {
    const row = this.database.connection.prepare('SELECT * FROM local_data_lifecycle_operations WHERE operation_id=?').get(operationId);
    return row ? row as unknown as OperationRow : null;
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalDataLifecycleError('LOCAL_DATA_CONTROL_CLOSED', '本地资料控制服务已经关闭。');
  }
}

/**
 * 用真实 TaskService 做最小收束适配：只取消仍在运行的该资料任务，保留 needs_review 等待核。
 * 不调用 resume/retry，不重建资料，也不把未知结果清掉。
 */
export function createTaskServiceSettler(tasks: LocalDataTaskControl): LocalDataSettler {
  return async ({ dataId }) => {
    const all = tasks.list({ limit: 1000 });
    if (all.length >= 1000) return { outcome: 'unresolved', evidence: '任务列表达到 1,000 条查询上限，不能确认全部收束。', pendingTaskIds: [] };
    const related = all.filter((task) => taskDataId(task) === dataId);
    const active = related.filter((task) => ['running', 'waiting_approval', 'pausing', 'cancelling'].includes(task.status));
    const results = await Promise.allSettled(active.map((task) => tasks.cancel(task.id)));
    const pending = new Set<string>();
    for (const task of related) {
      const current = safeGet(tasks, task.id);
      if (!current) { pending.add(task.id); continue; }
      if (current.requiresReview || current.status === 'needs_review'
        || ['running', 'waiting_approval', 'pausing', 'cancelling'].includes(current.status)) pending.add(current.id);
    }
    for (let index = 0; index < results.length; index += 1) if (results[index]!.status === 'rejected') pending.add(active[index]!.id);
    const evidence = `真实任务核对：关联 ${related.length}，请求停止 ${active.length}，保留待核 ${pending.size}。`;
    return { outcome: pending.size ? 'unresolved' : 'settled', evidence, pendingTaskIds: [...pending] };
  };
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function safeGet(tasks: LocalDataTaskControl, taskId: string): TaskRecord | null {
  try { return tasks.get(taskId); } catch { return null; }
}

function taskDataId(task: TaskRecord): string | null {
  return defaultDataIdFromTask(task);
}

function defaultDataIdFromTask(task: TaskRecord): string | null {
  const args = task.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, JsonValue>).localDataId;
  return typeof value === 'string' && value ? value : null;
}

function reloadFrom(row: ReloadRow): LocalDataReloadRecord {
  return { operationId: row.operation_id, dataId: row.data_id, state: row.state, expectedGeneration: Number(row.expected_generation),
    generation: Number(row.generation), reason: row.reason, requestedAt: Number(row.requested_at),
    loadedAt: row.loaded_at === null ? null : Number(row.loaded_at) };
}

function identityOf(path: string): { path: string; device: string; inode: string; digest: string } {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new LocalDataLifecycleError('INVALID_IDENTITY_FILE', '个人资料位置不是普通文件。');
  const canonical = resolve(path);
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino),
    digest: createHash('sha256').update(JSON.stringify([canonical, String(stat.dev), String(stat.ino)])).digest('hex') };
}

function quiescenceFrom(row: QuiescenceRow): LocalDataQuiescence {
  return { operationId: row.operation_id, dataId: row.data_id, evidence: row.evidence,
    pendingTaskIds: parseTaskIds(row.pending_task_ids), quiescedAt: Number(row.quiesced_at) };
}

function operationFrom(row: OperationRow): LocalDataOperation {
  return { operationId: row.operation_id, dataId: row.data_id, kind: row.kind, state: row.state,
    expectedGeneration: Number(row.expected_generation), generation: Number(row.generation), reason: row.reason,
    evidence: row.evidence === null ? null : String(row.evidence), pendingTaskIds: parseTaskIds(row.pending_task_ids),
    stopRequested: Number(row.stop_requested) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function parseTaskIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && ID.test(item)) : [];
  } catch { return []; }
}

function validateSettlementResult(value: unknown): LocalDataSettlementResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalDataLifecycleError('INVALID_SETTLEMENT', '收束钩子必须返回明确结论。');
  const result = value as Partial<LocalDataSettlementResult>;
  if (result.outcome !== 'settled' && result.outcome !== 'unresolved') throw new LocalDataLifecycleError('INVALID_SETTLEMENT', '收束结论无效。');
  const evidence = validEvidence(result.evidence);
  const pendingTaskIds = result.pendingTaskIds === undefined ? [] : validTaskIds(result.pendingTaskIds);
  if (result.executionStopped !== undefined && typeof result.executionStopped !== 'boolean') {
    throw new LocalDataLifecycleError('INVALID_SETTLEMENT', '执行器停止结论必须是布尔值。');
  }
  return { outcome: result.outcome, evidence, pendingTaskIds, executionStopped: result.executionStopped === true };
}

function validTaskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new LocalDataLifecycleError('INVALID_PENDING_TASKS', '待核任务列表无效。');
  return value.map((item) => { validId(item, '待核任务标识'); return item as string; });
}

function requestDigest(kind: LocalDataOperationKind, dataId: string, expectedGeneration: number, reason: string): string {
  return createHash('sha256').update(JSON.stringify({ kind, dataId, expectedGeneration, reason })).digest('hex');
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new LocalDataLifecycleError('INVALID_LOCAL_DATA_INPUT', `${label}无效。`);
  return value;
}

function validReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new LocalDataLifecycleError('INVALID_REASON', '操作原因需要 1 到 4,000 个字符。');
  return value.trim();
}

function validEvidence(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32_000) throw new LocalDataLifecycleError('INVALID_EVIDENCE', '收束证据需要 1 到 32,000 个字符。');
  return value.trim();
}

function appendEvidence(previous: string | null, next: string): string {
  return previous ? `${previous}\n${next}`.slice(-32_000) : next.slice(0, 32_000);
}

function assertOutsideCleanupRoots(path: string, roots: readonly string[]): void {
  const target = resolve(path);
  for (const root of roots) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new LocalDataLifecycleError('INVALID_CLEANUP_ROOT', '清理范围必须是明确的绝对路径。');
    const part = relative(resolve(root), target);
    if (part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))) {
      throw new LocalDataLifecycleError('CONTROL_PATH_IN_CLEANUP_SCOPE', '控制记录必须位于清理范围之外，不能随本地资料一起删除。');
    }
  }
}

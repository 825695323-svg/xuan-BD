import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import type { TaskDispatchGuard } from '../jobs/tasks.js';
import { CoreDatabase } from '../state/database.js';
import { LocalDataLifecycleError } from './errors.js';

/**
 * 本地资料身份与运行代次守卫。
 *
 * 只承担三件事：确认加载的是正确的本地状态库、让旧代次任务与私有请求不能越界、
 * 身份异常时由宿主拒绝危险操作。人工停用/解绑/重新采用业务已取消，本模块不再
 * 提供任何改变采用关系的命令，也不读写历史停用专用表。
 *
 * 控制库只依赖 local_data_lifecycle 与 local_data_lifecycle_identity 两张表；
 * 既有库中的停用专用表保留待归档，不删除、不迁移、不读写。
 */

export type LocalDataLifecycleStatus = 'active' | 'deactivating' | 'inactive' | 'unbound';

export interface LocalDataLifecycleRecord {
  readonly dataId: string;
  readonly status: LocalDataLifecycleStatus;
  readonly generation: number;
  readonly adopted: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  /** 兼容既有只读契约；停用业务取消后恒为 null。 */
  readonly lastOperation: null;
  readonly reloadPending: null;
  readonly quiescence: null;
}

export interface LocalDataLifecycleOptions {
  /** 持久控制库位置；由 launcher/注入逻辑给出，必须位于清理范围之外。 */
  controlDatabasePath: string;
  /** 可能涉及的资料根；用于拒绝把控制记录放进清理范围。 */
  cleanupRoots?: readonly string[];
  /** 默认读取 task.args.localDataId；只认显式字段，不按路径猜测。 */
  dataIdFromTask?: (task: TaskRecord) => string | null;
  now?: () => number;
}

interface ControlRow {
  data_id: string;
  status: LocalDataLifecycleStatus;
  generation: number;
  adopted: number;
  revision: number;
  created_at: number;
  updated_at: number;
  last_operation_id?: string | null;
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

/** 只建两张核心表；status 的 CHECK 保留历史取值以兼容既有控制库。 */
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

export class LocalDataLifecycle implements TaskDispatchGuard {
  private readonly database: CoreDatabase;
  private readonly dataIdFromTask: (task: TaskRecord) => string | null;
  private readonly now: () => number;
  private readonly admissions = new Map<string, Admission>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(options: LocalDataLifecycleOptions) {
    if (!options || typeof options.controlDatabasePath !== 'string' || !isAbsolute(options.controlDatabasePath)
      || options.controlDatabasePath.includes('\0')) throw new LocalDataLifecycleError('INVALID_CONTROL_PATH', '控制记录位置必须是明确的绝对路径。');
    assertOutsideCleanupRoots(options.controlDatabasePath, options.cleanupRoots ?? []);
    mkdirSync(dirname(resolve(options.controlDatabasePath)), { recursive: true, mode: 0o700 });
    this.database = new CoreDatabase(resolve(options.controlDatabasePath));
    chmodSync(resolve(options.controlDatabasePath), 0o600);
    this.database.migrate('local_data_lifecycle', 3, SCHEMA);
    this.dataIdFromTask = options.dataIdFromTask ?? defaultDataIdFromTask;
    this.now = options.now ?? Date.now;
  }

  /** 登记一份被采用的本地资料；重复登记只读回原代次，不重建或替换原资料。 */
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

  /** 绑定实际个人状态库对象身份；防止原资料被替换或缺失后错误加载。 */
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

  /** 所有私有 HTTP/SSE 入口的同步资格核对：先确认采用与活动状态，再拒绝旧代次。 */
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

  /** TaskService 同步派发闸门；在创建尝试的事务内固定当前代次。 */
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
    if (record.status !== 'active' || Number(record.adopted) !== 1) throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_CHANGED', '本地资料资格不可用，不能派发新动作。');
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
    if (!record || record.status !== 'active' || Number(record.adopted) !== 1) throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_CHANGED', '本地资料资格不可用，当前尝试不能继续新动作。');
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
    if (Number(record.adopted) !== 1 || record.status !== 'active') throw new LocalDataLifecycleError('LOCAL_DATA_QUALIFICATION_CHANGED', '当前本地资料资格不可用，不能接收新请求。');
    return this.statusFrom(record);
  }

  /** 当前受信宿主映射到的唯一本地资料标识；不读取客户端字段。 */
  currentDataId(): string | null {
    return this.dataIdFromTask({ id: '', args: {} } as TaskRecord);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.database.close();
  }

  private statusFrom(row: ControlRow): LocalDataLifecycleRecord {
    return { dataId: row.data_id, status: row.status, generation: Number(row.generation), adopted: Number(row.adopted) === 1,
      revision: Number(row.revision), updatedAt: Number(row.updated_at), lastOperation: null, reloadPending: null, quiescence: null };
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

  private assertOpen(): void {
    if (this.closed) throw new LocalDataLifecycleError('LOCAL_DATA_CONTROL_CLOSED', '本地资料控制服务已经关闭。');
  }
}

function defaultDataIdFromTask(task: TaskRecord): string | null {
  const args = task.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, JsonValue>).localDataId;
  return typeof value === 'string' && value ? value : null;
}

function identityOf(path: string): { path: string; device: string; inode: string; digest: string } {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new LocalDataLifecycleError('INVALID_IDENTITY_FILE', '个人资料位置不是普通文件。');
  const canonical = resolve(path);
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino),
    digest: createHash('sha256').update(JSON.stringify([canonical, String(stat.dev), String(stat.ino)])).digest('hex') };
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new LocalDataLifecycleError('INVALID_LOCAL_DATA_INPUT', `${label}无效。`);
  return value;
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

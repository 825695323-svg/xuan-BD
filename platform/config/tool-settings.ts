import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CoreDatabase } from '../state/database.js';
import { CoreError } from '../runtime/errors.js';
import { normalizePermissionPath } from '../security/permissions.js';
import type { DirectRuntimeConfiguration, ShortcutDefinition } from '../../contracts/direct-runtime.js';

export interface ToolSettings {
  revision: number;
  whisperModelPath: string | null;
  shortcutConfigPath: string | null;
  shortcuts: readonly ShortcutDefinition[];
  videoMaxMinutes: number;
  videoMaxBytes: number;
}
export type ToolSettingsOperationStatus = 'prepared' | 'saved' | 'adopted' | 'adopt_failed' | 'conflict';
/**
 * 原操作的持久回执。persistentMatches 只表示当前持久权威值仍是本次保存结果；
 * loadedMatches 才表示当前 direct 运行时实际加载值等于本次结果（未提供运行时时为 null）。
 */
export interface ToolSettingsOperation {
  requestId: string;
  status: ToolSettingsOperationStatus;
  expectedRevision: number;
  savedRevision: number | null;
  adoptedRevision: number | null;
  adopted: boolean;
  contentHash: string;
  persistentMatches: boolean;
  loadedMatches: boolean | null;
  loaded: DirectRuntimeConfiguration | null;
  /** 兼容旧查询：只等同 persistentMatches，绝不代表运行时已加载；新代码请用上面两个字段。 */
  actualMatches: boolean;
  currentRevision: number;
  result: ToolSettings | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
/** 一次提交的结果：只有 adoptable 时才可安装；旧修订已被替代时绝不安装旧候选。 */
export interface ToolSettingsCommit {
  value: ToolSettings;
  operation: ToolSettingsOperation;
  adoptable: boolean;
  superseded: boolean;
}
/** 供宿主启动/首次读取核实的入口；不自动安装，只给出应处理的下一步。 */
export interface ToolSettingsAdoptionCheck {
  requestId: string;
  status: ToolSettingsOperationStatus;
  savedRevision: number | null;
  persistentMatches: boolean;
  loadedMatches: boolean | null;
  action: 'none' | 'superseded' | 'record-adopted' | 'retry-adoption' | 'drifted' | 'unknown';
}
export interface ToolSettingsCandidate {
  requestId: string;
  expectedRevision: number;
  contentHash: string;
  /** 进入准备时已完整采用；重放不再写库、不再安装。 */
  replay: boolean;
  /** 进入准备时已持久保存（待采用或采用失败）；重放只重试安装。 */
  saved: boolean;
  value: Omit<ToolSettings, 'revision'>;
  commit(): ToolSettingsCommit;
  operation(): ToolSettingsOperation;
  adopted(value: ToolSettings): void;
  failed(message: string): void;
}

export class ToolSettingsService {
  constructor(private readonly database: CoreDatabase, initial: { whisperModelPath?: string; shortcutConfigPath?: string; shortcuts?: readonly ShortcutDefinition[] } = {},
    private readonly bundledWhisperModelPath?: string) {
    database.migrate('tool_settings', 1, `CREATE TABLE tool_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);`);
    // 新表单独迁移；既有工具设置行原样保留，不重写历史数据。
    database.migrate('tool_settings_operations', 1, `CREATE TABLE tool_settings_operations (
      request_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, expected_revision INTEGER NOT NULL,
      status TEXT NOT NULL, body TEXT NOT NULL, saved_revision INTEGER, adopted_revision INTEGER,
      result_body TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    database.connection.prepare('INSERT OR IGNORE INTO tool_settings(id,revision,body) VALUES(1,1,?)').run(JSON.stringify({
      whisperModelPath: initial.whisperModelPath ?? null, shortcutConfigPath: initial.shortcutConfigPath ?? null,
      shortcuts: initial.shortcuts ?? [], videoMaxMinutes: 30, videoMaxBytes: 256 * 1024 * 1024,
    }));
  }
  get(): ToolSettings {
    const row = this.database.connection.prepare('SELECT revision,body FROM tool_settings WHERE id=1').get()!;
    return { ...JSON.parse(String(row.body)), revision: Number(row.revision) } as ToolSettings;
  }
  isBundledWhisperModelPath(path: string | null): boolean {
    return this.bundledWhisperModelPath !== undefined && path === this.bundledWhisperModelPath;
  }
  update(value: Omit<ToolSettings, 'revision'>, revision: number): ToolSettings {
    return this.prepareUpdate(value, revision)();
  }
  /** 候选在提交前固定；一次性提交仍以持久修订作最终核对。 */
  prepareUpdate(value: Omit<ToolSettings, 'revision'>, revision: number): () => ToolSettings {
    const candidate = this.prepareOperation(randomUUID(), value, revision);
    return () => candidate.commit().value;
  }
  /**
   * 准备完整候选。历史回执先按 requestId 和内容哈希查询，再校验路径；
   * 因此旧候选的模型/快捷方式文件后来消失，也不影响原操作回执的重放查询。
   */
  prepareOperation(requestId: string, value: Omit<ToolSettings, 'revision'>, revision: number,
    runtime?: () => DirectRuntimeConfiguration | null): ToolSettingsCandidate {
    assertRequestId(requestId);
    const contentHash = createHash('sha256').update(JSON.stringify({ revision, value })).digest('hex');
    const existing = this.row(requestId);
    if (existing && String(existing.content_hash) !== contentHash) {
      throw new CoreError('SETTINGS_REQUEST_CONFLICT', '同一请求编号已用于不同设置内容，本次未覆盖当前设置；请重新读取并使用新的请求编号。', 409);
    }
    if (existing?.status === 'conflict') {
      throw new CoreError('SETTINGS_CONFLICT', '该请求编号此前因设置版本冲突未保存；请重新读取当前设置后使用新的请求编号。', 409);
    }
    let body: string;
    if (existing) body = String(existing.body);
    else {
      body = this.validateCandidate(value, revision);
      const now = new Date().toISOString();
      this.database.connection.prepare('INSERT INTO tool_settings_operations(request_id,content_hash,expected_revision,status,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(requestId, contentHash, revision, 'prepared', body, now, now);
    }
    const readRuntime = runtime ?? (() => null);
    const initial = this.operation(requestId, readRuntime())!;
    const replay = initial.status === 'adopted';
    const saved = replay || initial.status === 'saved' || initial.status === 'adopt_failed';
    let consumed = false;
    const candidate: ToolSettingsCandidate = {
      requestId, expectedRevision: revision, contentHash, replay, saved,
      value: JSON.parse(body) as Omit<ToolSettings, 'revision'>,
      operation: () => this.operation(requestId, readRuntime())!,
      commit: () => {
        if (consumed) throw new CoreError('SETTINGS_COMMIT_USED', '本次设置候选已经提交过，请重新读取并准备。');
        consumed = true;
        const current = this.operation(requestId, readRuntime())!;
        if (current.status === 'conflict') throw new CoreError('SETTINGS_CONFLICT', '该请求编号此前因设置版本冲突未保存；请重新读取当前设置。', 409);
        if (current.savedRevision !== null) {
          // 原操作只核对原事实：保存修订仍是当前权威值才允许继续采用同一候选；
          // 已被后续修订替代时返回最新持久值，绝不把旧候选装回运行时。
          const adoptable = current.persistentMatches;
          return { value: adoptable ? (current.result ?? this.get()) : this.get(),
            operation: this.operation(requestId, readRuntime())!, adoptable, superseded: !adoptable };
        }
        if (this.get().revision !== revision) {
          this.database.connection.prepare('UPDATE tool_settings_operations SET status=?,error=?,updated_at=? WHERE request_id=?')
            .run('conflict', '设置已在其他窗口变化，未保存本次候选。', new Date().toISOString(), requestId);
          throw new CoreError('SETTINGS_CONFLICT', '设置已在其他窗口变化，请重新读取。', 409);
        }
        try {
          return this.database.transaction(() => {
            const result = this.database.connection.prepare('UPDATE tool_settings SET revision=revision+1,body=? WHERE id=1 AND revision=?').run(body, revision);
            if (Number(result.changes) !== 1) throw new CoreError('SETTINGS_CONFLICT', '设置已在其他窗口变化，本次候选未保存。', 409);
            const saved = this.get();
            this.database.connection.prepare("UPDATE tool_settings_operations SET status='saved',saved_revision=?,result_body=?,error=NULL,updated_at=? WHERE request_id=?")
              .run(saved.revision, JSON.stringify(saved), new Date().toISOString(), requestId);
            return { value: saved, operation: this.operation(requestId, readRuntime())!, adoptable: true, superseded: false };
          });
        } catch (error) {
          if (error instanceof CoreError && error.code === 'SETTINGS_CONFLICT') {
            // 冲突状态必须在事务外写入，否则随回滚留下 prepared 假象。
            this.database.connection.prepare('UPDATE tool_settings_operations SET status=?,error=?,updated_at=? WHERE request_id=?')
              .run('conflict', '设置已在其他窗口变化，未保存本次候选。', new Date().toISOString(), requestId);
          }
          throw error;
        }
      },
      adopted: (saved) => {
        this.database.connection.prepare('UPDATE tool_settings_operations SET status=?,adopted_revision=?,result_body=?,error=NULL,updated_at=? WHERE request_id=?')
          .run('adopted', saved.revision, JSON.stringify(saved), new Date().toISOString(), requestId);
      },
      failed: (message) => {
        this.database.connection.prepare('UPDATE tool_settings_operations SET status=?,error=?,updated_at=? WHERE request_id=?')
          .run('adopt_failed', message.slice(0, 500), new Date().toISOString(), requestId);
      },
    };
    return candidate;
  }
  /** 准备阶段失败时丢弃尚未保存的候选记录，不留下“待提交”假象。 */
  discard(requestId: string): void {
    this.database.connection.prepare("DELETE FROM tool_settings_operations WHERE request_id=? AND status='prepared'").run(requestId);
  }
  /** 原操作查询；保存版本、采用版本、持久一致性与运行时加载一致性分开报告。 */
  operation(requestId: string, runtime: DirectRuntimeConfiguration | null = null): ToolSettingsOperation | null {
    assertRequestId(requestId);
    const row = this.row(requestId);
    if (!row) return null;
    const current = this.get();
    const result = row.result_body ? JSON.parse(String(row.result_body)) as ToolSettings : null;
    const persistentMatches = row.saved_revision !== null && current.revision === Number(row.saved_revision)
      && result !== null && JSON.stringify(stripRevision(current)) === JSON.stringify(stripRevision(result));
    const loadedMatches = runtime !== null && result !== null ? sameRuntime(runtime, result) : null;
    return {
      requestId, status: String(row.status) as ToolSettingsOperationStatus, expectedRevision: Number(row.expected_revision),
      savedRevision: row.saved_revision === null ? null : Number(row.saved_revision),
      adoptedRevision: row.adopted_revision === null ? null : Number(row.adopted_revision),
      adopted: row.status === 'adopted', contentHash: String(row.content_hash), persistentMatches, loadedMatches, loaded: runtime,
      actualMatches: persistentMatches, currentRevision: current.revision, result, error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
  /** 只读原候选的完整序列化；供旧快捷方式路径不可读时核对历史回执身份。 */
  storedCandidate(requestId: string): Omit<ToolSettings, 'revision'> | null {
    assertRequestId(requestId);
    const row = this.row(requestId);
    return row ? JSON.parse(String(row.body)) as Omit<ToolSettings, 'revision'> : null;
  }
  /**
   * 启动完成采用的核实入口：宿主提供当前 direct 运行时快照，逐条给出下一步；
   * 只有持久值仍是原保存结果时才会建议补记采用或重试采用，绝不安装被替代的候选。
   */
  adoptionChecks(runtime: DirectRuntimeConfiguration | null): ToolSettingsAdoptionCheck[] {
    const rows = this.database.connection.prepare('SELECT request_id FROM tool_settings_operations ORDER BY created_at DESC LIMIT 200').all() as { request_id: string }[];
    return rows.flatMap((row) => {
      const operation = this.operation(String(row.request_id), runtime);
      if (!operation || operation.savedRevision === null) return [];
      const action: ToolSettingsAdoptionCheck['action'] = !operation.persistentMatches ? 'superseded'
        : operation.status === 'adopted' ? (operation.loadedMatches === true ? 'none' : operation.loadedMatches === false ? 'drifted' : 'unknown')
          : operation.loadedMatches === true ? 'record-adopted' : operation.loadedMatches === false ? 'retry-adoption' : 'unknown';
      return [{ requestId: operation.requestId, status: operation.status, savedRevision: operation.savedRevision,
        persistentMatches: operation.persistentMatches, loadedMatches: operation.loadedMatches, action }];
    });
  }
  /** 只在持久值仍是原保存结果且运行时确实已加载该结果时补记采用回执。 */
  confirmAdopted(requestId: string, runtime: DirectRuntimeConfiguration): ToolSettingsOperation {
    const operation = this.operation(requestId, runtime);
    if (!operation || operation.savedRevision === null || !operation.persistentMatches || operation.loadedMatches !== true) {
      throw new CoreError('SETTINGS_ADOPTION_UNCONFIRMED', '持久值或运行时有效配置与本次保存结果不一致，不能补记已采用。', 409);
    }
    if (operation.status !== 'adopted') {
      this.database.connection.prepare('UPDATE tool_settings_operations SET status=?,adopted_revision=?,error=NULL,updated_at=? WHERE request_id=?')
        .run('adopted', operation.savedRevision, new Date().toISOString(), requestId);
    }
    return this.operation(requestId, runtime)!;
  }
  private row(requestId: string): Record<string, unknown> | undefined {
    return this.database.connection.prepare('SELECT * FROM tool_settings_operations WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined;
  }
  /** 完整候选校验；在写操作记录和持久值之前完成。 */
  private validateCandidate(value: Omit<ToolSettings, 'revision'>, revision: number): string {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new CoreError('INVALID_SETTINGS', '设置版本无效。', 400);
    if (this.bundledWhisperModelPath !== undefined && !this.isBundledWhisperModelPath(value.whisperModelPath)) {
      throw new CoreError('BUNDLED_MODEL_MAINTENANCE_REQUIRED', '普通工具设置不能清空或替换随包转录模型引用；请通过 scripts/adopt-bundled-resources.ts 受控资源采用入口核对和维护。', 400);
    }
    for (const path of [value.whisperModelPath, value.shortcutConfigPath]) {
      if (path === null) continue;
      if (typeof path !== 'string' || !isAbsolute(path) || normalizePermissionPath(path) !== path) throw new CoreError('INVALID_SETTINGS', '请选择明确的本机文件路径。', 400);
      let stat;
      try { stat = lstatSync(path); } catch { throw new CoreError('INVALID_SETTINGS', '所选工具配置或模型文件不存在，或当前无法读取。', 400); }
      if (!stat.isFile() || stat.nlink !== 1) throw new CoreError('INVALID_SETTINGS', '设置只接受普通文件，不接受链接。', 400);
    }
    if (!Number.isSafeInteger(value.videoMaxMinutes) || value.videoMaxMinutes < 1 || value.videoMaxMinutes > 180
      || !Number.isSafeInteger(value.videoMaxBytes) || value.videoMaxBytes < 1024 * 1024 || value.videoMaxBytes > 512 * 1024 * 1024) {
      throw new CoreError('INVALID_SETTINGS', '视频上限需要在 1–180 分钟、1–512 MB 内。', 400);
    }
    return JSON.stringify(value);
  }
}
function stripRevision(value: ToolSettings): Omit<ToolSettings, 'revision'> {
  const { revision: _revision, ...rest } = value;
  return rest;
}
function sameRuntime(runtime: DirectRuntimeConfiguration, saved: ToolSettings): boolean {
  return JSON.stringify({ whisperModelPath: runtime.whisperModelPath ?? null, shortcuts: runtime.shortcuts,
    videoMaxMinutes: runtime.videoMaxMinutes, videoMaxBytes: runtime.videoMaxBytes })
    === JSON.stringify({ whisperModelPath: saved.whisperModelPath ?? null, shortcuts: saved.shortcuts,
      videoMaxMinutes: saved.videoMaxMinutes, videoMaxBytes: saved.videoMaxBytes });
}
function assertRequestId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new CoreError('INVALID_SETTINGS_REQUEST', '请求编号缺失或格式无效；请使用稳定的 8–128 位字母、数字或 . _ : - 组合。', 400);
  }
}

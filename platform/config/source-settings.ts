import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { SourceCheck, SourceConnection, SourceOperationId, SourceOperationPolicy, SourcePolicy, SourceSettingsDocument, SourceSettingsView } from '../../contracts/source-settings.js';
import { CAPTURE_SOURCE_IDS, CAPTURE_SOURCES, type CaptureSourceId } from '../../plugins/capture-sources/contracts.js';
import { CAPTURE_SITE_RULES, captureSiteRule, normalizeCaptureArgs } from '../../plugins/capture-sources/sites.js';
import type { CaptureSessionService } from '../../plugins/capture-sources/session.js';
import { thsSource } from '../../plugins/api-sources/providers/ths/api.js';
import { publicKlineProvider, publicKlineProviders, publicKlineProviderIds } from '../../plugins/api-sources/public-kline.js';
import { sourceOperations } from '../../plugins/api-sources/operations.js';
import { validWerssBaseUrl } from '../../plugins/api-sources/providers/werss/cache.js';
import { CoreError } from '../runtime/errors.js';
import { directFileVersion } from '../plugins/direct-versions.js';
import type { CoreDatabase } from '../state/database.js';
import { readConnectionRegistry, registeredConnection } from './connections.js';

const scopes = [
  { id: 'global', country: 'GLOBAL', market: 'ALL', label: '全局默认' },
  { id: 'CN/A_STOCK', country: 'CN', market: 'A_STOCK', label: '中国 · A股' },
  { id: 'HK/STOCK', country: 'HK', market: 'STOCK', label: '中国香港 · 股票' },
  { id: 'US/STOCK', country: 'US', market: 'STOCK', label: '美国 · 股票' },
];
const operationIds: SourceOperationId[] = ['minute_bars', 'daily_bars', 'index_constituents'];
const providerIds = ['tdx', 'ths', ...publicKlineProviderIds, 'werss'] as const;
const providerIdSet = new Set<string>(providerIds);
/** 已由本次明确选择的脚本字节核对；更换脚本版本须受控更新实现。 */
export const WECHAT_EXTRACT_SHA256 = 'b8de2fb15ddb7ac9f34531d6d9922e6c6a390e047fdaf91533218fa326bb1af4';
const defaultWechatExtract = () => ({ enabled: false, scriptPath: null, sha256: WECHAT_EXTRACT_SHA256 });
const bad = (message: string): never => { throw new CoreError('SOURCE_SETTINGS_INVALID', message, 400); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,99}$/u.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** 忽略服务端更新时间，只比较配置内容；同一请求重放不因 updatedAt 被误判为不同内容。 */
const operationHash = (value: SourceSettingsDocument) => digest({ ...value, updatedAt: null });
const hasWerssPlugin = (value: SourceSettingsDocument) => value.plugins.some(item => item.id === 'werss');
/** 历史操作按其原 schema 比较；只有新增 WeRSS 仍完全禁用时，才忽略内存补出的默认登记。 */
function comparableForOperation(current: SourceSettingsDocument, historical: SourceSettingsDocument): SourceSettingsDocument {
  const comparable = !hasWerssPlugin(historical) && current.plugins.find(item => item.id === 'werss')?.enabled === false
    && !current.connections.some(item => item.pluginId === 'werss')
    ? { ...current, plugins: current.plugins.filter(item => item.id !== 'werss') } : current;
  return !Object.hasOwn(historical, 'wechatExtract') && comparable.wechatExtract.enabled === false
    ? Object.fromEntries(Object.entries(comparable).filter(([key]) => key !== 'wechatExtract')) as unknown as SourceSettingsDocument : comparable;
}
const assertRequestId = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new CoreError('INVALID_SOURCE_SETTINGS_REQUEST', '请求编号缺失或格式无效；请使用稳定的 8–128 位字母、数字或 . _ : - 组合。', 400);
  }
};
export type SourceSettingsOperationStatus = 'saving' | 'saved' | 'conflict' | 'adopted' | 'adopt_failed';
/** 持久原操作回执；actualMatches 每次按当前文件和修订重算。 */
export interface SourceSettingsOperation {
  requestId: string;
  status: SourceSettingsOperationStatus;
  expectedRevision: number;
  savedRevision: number | null;
  adoptedRevision: number | null;
  actualMatches: boolean;
  currentRevision: number;
  error: string | null;
  updatedAt: string;
}
interface SourceSettingsLock { path: string; device: bigint; inode: bigint; token: string }

/** 配置只有一个持久副本；页面、原任务和采集动作都读取同一保存结果。 */
export class SourceSettingsService {
  private readonly credentialFiles = new Set<string>();
  constructor(readonly path: string, private readonly database: CoreDatabase, private sessions?: CaptureSessionService, private readonly connectionsRegistryPath?: string) {
    database.migrate('source_checks', 1, 'CREATE TABLE source_checks(id TEXT PRIMARY KEY, body TEXT NOT NULL);');
    database.migrate('source_usage', 1, 'CREATE TABLE source_usage(account_id TEXT PRIMARY KEY, requests INTEGER NOT NULL, last_requested_at TEXT NOT NULL);');
    // 新表单独迁移；既有来源配置文件与检查/用量数据不受影响。
    database.migrate('source_settings_operations', 1, `CREATE TABLE source_settings_operations (
      request_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, expected_revision INTEGER NOT NULL,
      status TEXT NOT NULL, body TEXT NOT NULL, saved_revision INTEGER, adopted_revision INTEGER,
      result_hash TEXT, result_body TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  }
  /** 只保留已验证配置中的文件引用；切换账号后旧引用继续受普通文件入口保护。 */
  credentialPaths(): readonly string[] { return [...this.credentialFiles]; }
  setCaptureSessions(sessions: CaptureSessionService): void { this.sessions = sessions; }
  accountId(connection: SourceConnection): string {
    const ref = connection.credential;
    return digest([connection.pluginId, ref?.kind === 'keychain' ? ['keychain', ref.service, ref.account] : ref?.kind === 'dsh-ref' ? ['dsh-ref', ref.path, ref.ref] : null]);
  }
  /** 记录本机调用尝试，不声明远端已收到或供应商已计费。 */
  recordAttempt(connection: SourceConnection): void {
    this.database.connection.prepare('INSERT INTO source_usage(account_id,requests,last_requested_at) VALUES(?,1,?) ON CONFLICT(account_id) DO UPDATE SET requests=requests+1,last_requested_at=excluded.last_requested_at')
      .run(this.accountId(connection), new Date().toISOString());
  }
  checkIdentity(id: string): string {
    const value = this.get(), connection = value.connections.find(item => item.id === id);
    return digest(connection ? { ...executionConnection(connection), enabled: connection.enabled, plugin: value.plugins.find(item => item.id === connection.pluginId) } : value.capture.find(item => item.sourceId === id) ?? null);
  }
  checks(): SourceCheck[] {
    return (this.database.connection.prepare('SELECT body FROM source_checks ORDER BY id').all() as { body: string }[]).map(row => {
      const check = JSON.parse(row.body) as SourceCheck;
      return check.configurationDigest === this.checkIdentity(check.id) && check.validUntil && Date.parse(check.validUntil) > Date.now() ? check
        : { ...check, status: 'partial', reachable: null, authorized: null, capabilityAvailable: null, reason: '此前检查已过期或相关配置已变化，须重新检查；旧结果不证明当前可用。' };
    });
  }
  get(): SourceSettingsDocument {
    if (!existsSync(this.path)) return defaults(this.connectionsRegistryPath);
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new CoreError('SOURCE_SETTINGS_UNAVAILABLE', '来源配置当前无法读取，请保留原文件后检查。', 503); }
    // 旧配置没有按接口类型的策略；空数组合法表示沿用范围主备，不伪造历史编排。
    if (object(value) && !Object.hasOwn(value, 'operationPolicies')) value.operationPolicies = [];
    if (object(value)) migrateProviderNames(value);
    if (object(value)) migratePublicProviders(value);
    if (object(value)) migrateWerssProvider(value);
    if (object(value) && !Object.hasOwn(value, 'wechatExtract')) value.wechatExtract = defaultWechatExtract();
    const result = validate(value);
    for (const connection of result.connections) if (connection.credential?.kind === 'dsh-ref') this.credentialFiles.add(resolve(connection.credential.path));
    return result;
  }
  update(input: unknown, requestId?: string): SourceSettingsDocument {
    if (requestId !== undefined) {
      assertRequestId(requestId);
      const historical = this.operationRow(requestId);
      // 升级前的原请求只可凭既有 requestId 和原候选摘要精确重放；不把缺失 WeRSS 字段的内容当新配置提交。
      if (historical && object(input) && (Array.isArray(input.plugins)
        && !input.plugins.some(item => object(item) && item.id === 'werss') || !Object.hasOwn(input, 'wechatExtract'))) {
        this.assertReplay(historical, operationHash(input as unknown as SourceSettingsDocument));
        if (String(historical.status) === 'saving' && this.operation(requestId)?.status === 'saving') {
          throw new CoreError('SOURCE_SETTINGS_UNRESOLVED', '该旧请求的保存结果仍无法确认，未覆盖当前配置。', 409);
        }
        return this.get();
      }
    }
    const value = validate(input), contentHash = operationHash(value);
    if (requestId !== undefined) {
      // 锁外快路径只读原操作；真正写入前必须在锁内再次按稳定 requestId 核对。
      const existing = this.operationRow(requestId);
      if (existing) {
        this.assertReplay(existing, contentHash);
        if (String(existing.status) !== 'saving') return this.get();
      }
    }
    // 跨进程以独占锁串行“读当前修订→写临时文件→rename”；锁内重新核对请求编号与修订。
    return this.locked(() => {
      const current = this.get();
      if (requestId !== undefined) {
        const existing = this.operationRow(requestId);
        if (existing) {
          this.assertReplay(existing, contentHash);
          if (String(existing.status) === 'saving') {
            const recovered = this.operation(requestId);
            if (recovered?.status === 'saving') {
              throw new CoreError('SOURCE_SETTINGS_UNRESOLVED', '该请求编号的保存结果无法从当前文件确认，本次未再次覆盖；请重新读取当前设置后再决定。', 409);
            }
          }
          return this.get();
        }
      }
      if (value.revision !== current.revision) {
        if (requestId !== undefined) this.recordOperation(requestId, contentHash, value, 'conflict', null, null, '来源设置已在另一入口变化，未保存本次候选。');
        throw new CoreError('SOURCE_SETTINGS_CONFLICT', '来源设置已在另一入口变化，请重新读取后保存。', 409);
      }
      if (value.wechatExtract.enabled) this.wechatScriptVersion(value);
      const result = { ...value, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      if (requestId !== undefined) this.recordOperation(requestId, contentHash, value, 'saving', null, null, null);
      const temporary = join(dirname(this.path), `.source-settings-${randomUUID()}.tmp`);
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, this.path);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* 原文件未替换，临时文件可清理。 */ }
        if (requestId !== undefined) this.database.connection.prepare('DELETE FROM source_settings_operations WHERE request_id=?').run(requestId);
        throw error;
      }
      let saved: SourceSettingsDocument;
      try { saved = this.get(); }
      catch (error) {
        // rename 已是持久事实：只记录无法读回核对，不删除回执、不伪报保存失败。
        if (requestId !== undefined) {
          this.database.connection.prepare('UPDATE source_settings_operations SET error=?,updated_at=? WHERE request_id=?')
            .run('来源配置已替换，但读回核对失败；保存结果待重启核对。', new Date().toISOString(), requestId);
        }
        throw error;
      }
      if (requestId !== undefined) {
        const savedHash = operationHash(saved);
        // 先记录保存事实，再单独记录采用事实；两步之间崩溃仍可区分“未知”与“未保存”。
        this.database.connection.prepare("UPDATE source_settings_operations SET status='saved',saved_revision=?,result_hash=?,result_body=?,error=NULL,updated_at=? WHERE request_id=?")
          .run(saved.revision, savedHash, JSON.stringify(saved), new Date().toISOString(), requestId);
        const adopted = savedHash === operationHash(result);
        this.database.connection.prepare('UPDATE source_settings_operations SET status=?,adopted_revision=?,error=?,updated_at=? WHERE request_id=?')
          .run(adopted ? 'adopted' : 'adopt_failed', adopted ? saved.revision : null,
            adopted ? null : '来源配置已保存，但读回值与提交值不一致，待重启核对。', new Date().toISOString(), requestId);
      }
      return saved;
    });
  }
  /** 原操作持久查询：保存修订、采用修订与当前实际文件分开报告，不按当前文件猜原失败。 */
  operation(requestId: string): SourceSettingsOperation | null {
    assertRequestId(requestId);
    let row = this.operationRow(requestId);
    if (!row) return null;
    // 文件已替换但进程在写回执前崩溃：只有当前文件仍精确等于原候选的新修订时才补记；
    // 若后续修订已变化，保留 saving 为“未知”，绝不从当前文件推断原写入失败。
    if (String(row.status) === 'saving') {
      const body = JSON.parse(String(row.body)) as SourceSettingsDocument;
      const expected = { ...body, revision: Number(row.expected_revision) + 1 };
      const current = this.get();
      const comparable = comparableForOperation(current, body);
      if (current.revision === expected.revision && operationHash(comparable) === operationHash(expected)) {
        const now = new Date().toISOString();
        this.database.connection.prepare("UPDATE source_settings_operations SET status='saved',saved_revision=?,result_hash=?,result_body=?,error=NULL,updated_at=? WHERE request_id=?")
          .run(current.revision, operationHash(comparable), JSON.stringify(comparable), now, requestId);
        this.database.connection.prepare("UPDATE source_settings_operations SET status='adopted',adopted_revision=?,error=NULL,updated_at=? WHERE request_id=?")
          .run(current.revision, now, requestId);
        row = this.operationRow(requestId)!;
      }
    }
    // 保存事实与采用事实分开记录：崩溃在两步之间时，当前文件仍等于保存结果即可补记采用。
    if (String(row.status) === 'saved' && row.saved_revision !== null) {
      const current = this.get();
      const saved = row.result_body ? JSON.parse(String(row.result_body)) as SourceSettingsDocument : null;
      if (saved && current.revision === Number(row.saved_revision)
        && operationHash(comparableForOperation(current, saved)) === String(row.result_hash ?? '')) {
        this.database.connection.prepare("UPDATE source_settings_operations SET status='adopted',adopted_revision=?,error=NULL,updated_at=? WHERE request_id=?")
          .run(current.revision, new Date().toISOString(), requestId);
        row = this.operationRow(requestId)!;
      }
    }
    const current = this.get(), result = row.result_body ? JSON.parse(String(row.result_body)) as SourceSettingsDocument : null;
    const actualMatches = row.saved_revision !== null && current.revision === Number(row.saved_revision)
      && result !== null && operationHash(comparableForOperation(current, result)) === String(row.result_hash ?? '');
    return {
      requestId, status: String(row.status) as SourceSettingsOperationStatus, expectedRevision: Number(row.expected_revision),
      savedRevision: row.saved_revision === null ? null : Number(row.saved_revision),
      adoptedRevision: row.adopted_revision === null ? null : Number(row.adopted_revision),
      actualMatches, currentRevision: current.revision, error: row.error === null ? null : String(row.error), updatedAt: String(row.updated_at),
    };
  }
  /** 锁内重放核对：同一 requestId 只接受同一完整候选，冲突状态不再写入。 */
  private assertReplay(existing: Record<string, unknown>, contentHash: string): void {
    if (String(existing.content_hash) !== contentHash) {
      throw new CoreError('SOURCE_SETTINGS_REQUEST_CONFLICT', '同一请求编号已用于不同来源配置内容，本次未覆盖当前配置；请重新读取并使用新的请求编号。', 409);
    }
    if (String(existing.status) === 'conflict') {
      throw new CoreError('SOURCE_SETTINGS_CONFLICT', '该请求编号此前因来源设置版本冲突未保存；请重新读取当前设置后使用新的请求编号。', 409);
    }
  }
  private operationRow(requestId: string): Record<string, unknown> | undefined {
    return this.database.connection.prepare('SELECT * FROM source_settings_operations WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined;
  }
  private recordOperation(requestId: string, contentHash: string, value: SourceSettingsDocument, status: SourceSettingsOperationStatus,
    savedRevision: number | null, adoptedRevision: number | null, error: string | null): void {
    const now = new Date().toISOString();
    this.database.connection.prepare(`INSERT INTO source_settings_operations(request_id,content_hash,expected_revision,status,body,saved_revision,adopted_revision,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(requestId, contentHash, value.revision, status, JSON.stringify(value), savedRevision, adoptedRevision, error, now, now);
  }
  /**
   * 同主机文件锁：锁文件带 token 与 pid，不使用锁龄接管，也不忙等。
   * 已存在锁时只做一次受控核对：原主进程确已不存在、锁节点与字节均未变化才回收；
   * 活跃、无法读取或身份不明一律返回明确 busy，绝不删除当前锁。
   */
  private locked<T>(work: () => T): T {
    const lock = this.acquireLock();
    try { return work(); } finally { this.releaseLock(lock); }
  }
  private acquireLock(): SourceSettingsLock {
    const lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      let fd: number | undefined;
      let identity: BigIntStats | undefined;
      try {
        fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        identity = fstatSync(fd, { bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n) throw new CoreError('SOURCE_SETTINGS_LOCK_UNSAFE', '来源设置锁不是独立普通文件，拒绝写入。', 503);
        writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, token }));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        return { path: lockPath, device: identity.dev, inode: identity.ino, token };
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* 已关闭。 */ }
          try {
            const current = lstatSync(lockPath, { bigint: true });
            if (identity && current.dev === identity.dev && current.ino === identity.ino && current.nlink === 1n) unlinkSync(lockPath);
          } catch { /* 身份不明时保留现场。 */ }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EISDIR') throw new CoreError('SOURCE_SETTINGS_BUSY', '来源设置锁不是可核对的普通文件；本次未更改配置，请先核对锁路径。', 409);
        if (code !== 'EEXIST') throw error;
        if (attempt === 0 && this.recoverDeadLock(lockPath)) continue;
        throw new CoreError('SOURCE_SETTINGS_BUSY', '来源设置正在另一进程保存，或原锁身份无法确认；本次未更改配置，请稍后重试。', 409);
      }
    }
    throw new CoreError('SOURCE_SETTINGS_BUSY', '来源设置正在另一进程保存；本次未更改配置，请稍后重试。', 409);
  }
  private recoverDeadLock(lockPath: string): boolean {
    let fd: number | undefined, checkFd: number | undefined;
    try {
      const before = lstatSync(lockPath, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 1024n) return false;
      fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size > 1024n
        || opened.dev !== before.dev || opened.ino !== before.ino) return false;
      const raw = readFileSync(fd, 'utf8'), after = fstatSync(fd, { bigint: true });
      closeSync(fd); fd = undefined;
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return false;
      const owner = JSON.parse(raw) as { version?: unknown; pid?: unknown; token?: unknown };
      const pid = Number(owner?.pid);
      if (!owner || owner.version !== 1 || !Number.isSafeInteger(pid) || pid < 1 || typeof owner.token !== 'string' || !owner.token) return false;
      try { process.kill(pid, 0); return false; }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) return false; }
      const current = lstatSync(lockPath, { bigint: true });
      if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) return false;
      checkFd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const checkStat = fstatSync(checkFd, { bigint: true });
      if (checkStat.dev !== before.dev || checkStat.ino !== before.ino || checkStat.size !== before.size
        || readFileSync(checkFd, 'utf8') !== raw) return false;
      closeSync(checkFd); checkFd = undefined;
      unlinkSync(lockPath);
      return true;
    } catch { return false; }
    finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* 已关闭。 */ }
      if (checkFd !== undefined) try { closeSync(checkFd); } catch { /* 已关闭。 */ }
    }
  }
  private releaseLock(lock: SourceSettingsLock): void {
    let fd: number | undefined;
    try {
      fd = openSync(lock.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > 1024n || stat.dev !== lock.device || stat.ino !== lock.inode) return;
      const owner = JSON.parse(readFileSync(fd, 'utf8')) as { version?: unknown; pid?: unknown; token?: unknown };
      if (!owner || owner.version !== 1 || owner.pid !== process.pid || owner.token !== lock.token) return;
      closeSync(fd); fd = undefined;
      const current = lstatSync(lock.path, { bigint: true });
      if (!current.isFile() || current.nlink !== 1n || current.dev !== lock.device || current.ino !== lock.inode) return;
      unlinkSync(lock.path);
    } catch { /* 无法核对 token 与节点时保留锁，绝不删除当前锁。 */ }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 已关闭。 */ } }
  }
  async view(): Promise<SourceSettingsView> {
    const value = this.get();
    const session = new Map((await this.sessions?.list() ?? []).map(item => [item.sourceId, item]));
    return { ...value, scopes, apiPlugins: [{ id: 'tdx', title: '通达信官方数据', shortLabel: '通达信', upstream: '通达信数据服务或TQ客户端', version: 'tdx-official/1', applicationUrl: 'https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hjbgqpdhv114.html',
      defaultBaseUrl: 'tdxaidata://data-service', connectionModes: [{ id: 'data_service', label: '官方SDK后台数据服务', baseUrl: 'tdxaidata://data-service' }, { id: 'client_http', label: '本机TQ客户端HTTP接口',
        ...clientEndpoint(value) }],
      operations: sourceOperations('tdx'),
      capabilities: [
        { kind: 'minute_bars', supported: true, reason: '官方行情能力；后台数据服务Key类型、SDK依赖或TQ客户端须在本机核实。' },
        { kind: 'announcement', supported: false, reason: '本版未装配通达信公告原文动作。' },
        { kind: 'index_change', supported: false, reason: '本版未装配通达信指数变更公告动作。' },
      ] }, { id: 'ths', title: thsSource.displayName, shortLabel: '同花顺', upstream: 'fuyao.aicubes.cn', version: 'ths-read/1', applicationUrl: thsSource.applicationUrl, defaultBaseUrl: thsSource.apiBaseUrl,
      operations: sourceOperations('ths'),
      capabilities: [
        { kind: 'minute_bars', supported: false, reason: '服务公开文档未开放端外分钟K线。' },
        { kind: 'announcement', supported: false, reason: '本版没有已核实可公开取公告原文的端点。' },
        { kind: 'index_change', supported: false, reason: '当前成分表不能替代历史指数变更公告。' },
        { kind: 'index_constituents', supported: true, reason: '已装配公开GET成分表端点，仍须实际账号授权。' },
      ] }, ...publicKlineProviders.map(provider => ({ id: provider.id, title: provider.title, shortLabel: provider.shortLabel, upstream: provider.upstream, version: 'public-kline/1',
        applicationUrl: provider.applicationUrl, defaultBaseUrl: provider.baseUrl, operations: sourceOperations(provider.id), capabilities: [] })),
      { id: 'werss', title: 'WeRSS 本地缓存', shortLabel: 'WeRSS', upstream: '本机已配置的 WeRSS 服务', version: 'werss-cache-read/1',
        applicationUrl: null, defaultBaseUrl: '', operations: [], capabilities: [] }],
      capturePlugins: CAPTURE_SOURCE_IDS.map(sourceId => {
        const status = session.get(sourceId), enabled = value.capture.find(item => item.sourceId === sourceId)!.enabled;
        return { sourceId, label: CAPTURE_SOURCES[sourceId].label, loginRequired: CAPTURE_SOURCES[sourceId].loginRequired, available: enabled && !!status && !status.needsAttention,
          reason: !enabled ? '此采集源已停用。' : status?.needsAttention ? status.message : status ? null : '本站独立会话尚未装配。',
          operations: CAPTURE_SITE_RULES.filter(rule => rule.sourceId === sourceId).map(rule => ({ operation: rule.operation, parameters: rule.parameters })),
          scheduling: { supported: false as const, reason: '本版只支持明确单次执行，自动计划尚未实现。' } };
      }), checks: this.checks(),
      supportedKinds: ['minute_bars', 'announcement', 'index_change'],
      usage: [...new Set(value.connections.map(connection => this.accountId(connection)))].map(accountId => {
        const row = this.database.connection.prepare('SELECT requests,last_requested_at FROM source_usage WHERE account_id=?').get(accountId);
        return { accountId, connectionIds: value.connections.filter(connection => this.accountId(connection) === accountId).map(connection => connection.id), measurement: 'local_attempts' as const, attempts: Number(row?.requests ?? 0), lastAttemptedAt: row ? String(row.last_requested_at) : null };
      }),
      supportedApiOperations: sourceOperations('ths').map(operation => ({ id: operation.id, label: operation.label })),
      concurrency: { scope: 'shared_account', activeLimit: 1, numericOfficialLimit: null,
        reason: '每个共享账号串行1为本机保守策略；官方通用并发或每秒数未知，未进行并发上限测试。限流不立即重试。',
        references: [{ title: '同花顺官方调用频率与限流', url: 'https://fuyao.aicubes.cn/docs/api-reference/overview/' },
          { title: '通达信官方后台数据服务', url: 'https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hjbgqpdhv114.html' }] } };
  }
  saveCheck(check: SourceCheck): SourceCheck {
    const value = { ...check, configurationDigest: check.configurationDigest ?? this.checkIdentity(check.id), validUntil: new Date(Date.parse(check.checkedAt) + 5 * 60_000).toISOString() };
    this.database.connection.prepare('INSERT INTO source_checks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(value));
    return value;
  }
  assertCaptureEnabled(sourceId: CaptureSourceId): void {
    if (!this.get().capture.find(item => item.sourceId === sourceId)?.enabled) throw new CoreError('SOURCE_DISABLED', '当前采集源已停用，未发起新的调用。', 409);
  }
  /** 运行前和版本冻结时均核固定脚本字节；设置里的位置不能选择任意 Python 代码。 */
  wechatScriptVersion(value: SourceSettingsDocument = this.get()) {
    const configured = value.wechatExtract;
    if (!configured.enabled || !configured.scriptPath) throw new CoreError('SOURCE_DISABLED', '公众号正文提取脚本尚未登记启用。', 409);
    try {
      const stat = lstatSync(configured.scriptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000
        || realpathSync(configured.scriptPath) !== configured.scriptPath) throw new Error('script identity');
      const version = directFileVersion(configured.scriptPath);
      if (version.sha256 !== WECHAT_EXTRACT_SHA256) throw new Error('script digest');
      return version;
    } catch {
      throw new CoreError('WECHAT_SCRIPT_CHANGED', '公众号脚本的路径、对象或固定摘要未通过核对，未执行。', 409);
    }
  }
  /** 独立于行情国家市场主备；仅允许显式已启用的本机 WeRSS 连接。 */
  assertWerssConnectionEnabled(connectionId: string, feedId?: string): SourceConnection {
    const value = this.get(), connection = value.connections.find(item => item.id === connectionId);
    if (!value.plugins.find(item => item.id === 'werss')?.enabled || !connection?.enabled || connection.pluginId !== 'werss') {
      throw new CoreError('SOURCE_DISABLED', 'WeRSS 插件或明确连接未启用，未发起缓存读取。', 409);
    }
    if (!validWerssBaseUrl(connection.baseUrl) || connection.credential !== null || connection.scopes.length) {
      throw new CoreError('SOURCE_SETTINGS_INVALID', 'WeRSS 连接不是无凭据的本机回环服务。', 409);
    }
    if (feedId !== undefined && !connection.feedIds?.includes(feedId)) {
      throw new CoreError('SOURCE_FEED_NOT_CONFIGURED', '该 feed 未在当前 WeRSS 本地连接中明确登记，未发起缓存读取。', 409);
    }
    return connection;
  }
  werssConnectionVersion(connectionId: string): unknown {
    const connection = this.assertWerssConnectionEnabled(connectionId);
    return { connection: executionConnection(connection), enabled: connection.enabled, pluginEnabled: true,
      configurationDigest: this.checkIdentity(connectionId), configurationRevision: this.get().revision };
  }
  captureVersion(sourceId: CaptureSourceId): unknown {
    const setting = this.get().capture.find(item => item.sourceId === sourceId)!;
    // 版本只反映采集内容，不含启停开关；不能保留 undefined 值，否则序列化校验会失败。
    const { enabled: _enabled, ...versioned } = setting;
    return versioned;
  }
  /** 全范围覆盖，不拼接全局备用；范围停用与恢复继承是不同状态。 */
  effectivePolicy(scopeId: string): SourcePolicy {
    const value = this.get(), selected = value.policies.find(item => item.scopeId === scopeId);
    if (!selected || !selected.enabled) throw new CoreError('SOURCE_SCOPE_DISABLED', '当前范围不存在或已停用。', 409);
    return selected.mode === 'inherit' ? { ...value.policies.find(item => item.scopeId === 'global')!, scopeId } : selected;
  }
  candidates(scopeId: string): SourceConnection[] {
    const value = this.get(), policy = this.effectivePolicy(scopeId);
    if (!policy.enabled) throw new CoreError('SOURCE_SCOPE_DISABLED', '全局来源范围已停用。', 409);
    return [policy.primary, ...policy.backups].filter((item): item is string => item !== null).map(connectionId => value.connections.find(item => item.id === connectionId)!);
  }
  assertConnectionEnabled(connectionId: string, scopeId: string): SourceConnection {
    const value = this.get(), connection = value.connections.find(item => item.id === connectionId);
    const policy = this.effectivePolicy(scopeId);
    if (!policy.enabled || !connection?.enabled || !value.plugins.find(item => item.id === connection.pluginId)?.enabled) throw new CoreError('SOURCE_DISABLED', '当前来源插件、连接或范围已停用，未发起新的调用。', 409);
    if (![policy.primary, ...policy.backups].includes(connectionId)) throw new CoreError('SOURCE_NOT_CONFIGURED', '连接不在当前明确配置的来源组合中。', 409);
    if (!connection.scopes.includes(scopeId) && !connection.scopes.includes('global')) throw new CoreError('SOURCE_SCOPE_UNSUPPORTED', '连接不覆盖请求的国家市场范围。', 409);
    return connection;
  }
  operationPolicy(scopeId: string, operationId: SourceOperationId): SourceOperationPolicy | undefined {
    return this.get().operationPolicies.find(item => item.scopeId === scopeId && item.operationId === operationId);
  }
  /** 按接口类型的显式编排优先；没有编排时沿用该范围的原主备顺序。 */
  operationCandidates(scopeId: string, operationId: SourceOperationId): SourceConnection[] {
    const value = this.get(), explicit = value.operationPolicies.find(item => item.scopeId === scopeId && item.operationId === operationId);
    const ids = explicit
      ? [explicit.primary, ...explicit.backups].filter((item): item is string => item !== null)
      : this.candidates(scopeId).map(connection => connection.id);
    return ids.map(connectionId => value.connections.find(item => item.id === connectionId)!)
      .filter(connection => connection.scopes.includes(scopeId) || connection.scopes.includes('global'));
  }
  assertOperationConnectionEnabled(connectionId: string, scopeId: string, operationId: SourceOperationId): SourceConnection {
    const value = this.get(), connection = value.connections.find(item => item.id === connectionId), explicit = value.operationPolicies.find(item => item.scopeId === scopeId && item.operationId === operationId);
    const policy = this.effectivePolicy(scopeId), allowed = explicit ? [explicit.primary, ...explicit.backups] : [policy.primary, ...policy.backups];
    if (!policy.enabled || !connection?.enabled || !value.plugins.find(item => item.id === connection.pluginId)?.enabled) throw new CoreError('SOURCE_DISABLED', '当前来源插件、连接或范围已停用，未发起新的调用。', 409);
    if (!allowed.includes(connectionId)) throw new CoreError('SOURCE_NOT_CONFIGURED', '连接不在当前接口类型的来源组合中。', 409);
    if (!connection.scopes.includes(scopeId) && !connection.scopes.includes('global')) throw new CoreError('SOURCE_SCOPE_UNSUPPORTED', '连接不覆盖请求的国家市场范围。', 409);
    return connection;
  }
  /** 只用于冻结版本中的可选池清单；实际执行只使用明确解析出的主备组合。 */
  operationPoolCandidates(scopeId: string, operationId: SourceOperationId): SourceConnection[] {
    const value = this.get(), selected = new Set(this.operationCandidates(scopeId, operationId).map(connection => connection.id));
    return value.connections.filter(connection => (connection.scopes.includes(scopeId) || connection.scopes.includes('global')) && !selected.has(connection.id));
  }
  assertOperationFallbackEnabled(connectionId: string, scopeId: string, operationId: SourceOperationId): SourceConnection {
    const value = this.get(), connection = value.connections.find(item => item.id === connectionId), policy = this.effectivePolicy(scopeId);
    const explicit = value.operationPolicies.find(item => item.scopeId === scopeId && item.operationId === operationId);
    const allowed = explicit ? [explicit.primary, ...explicit.backups] : [policy.primary, ...policy.backups];
    if (!policy.enabled || !connection?.enabled || !value.plugins.find(item => item.id === connection.pluginId)?.enabled) throw new CoreError('SOURCE_DISABLED', '当前来源插件、连接或范围已停用，未发起新的调用。', 409);
    if (!allowed.includes(connectionId)) throw new CoreError('SOURCE_NOT_CONFIGURED', '连接不在当前接口类型的明确主备组合中。', 409);
    if (!connection.scopes.includes(scopeId) && !connection.scopes.includes('global')) throw new CoreError('SOURCE_SCOPE_UNSUPPORTED', '连接不覆盖请求的国家市场范围。', 409);
    return connection;
  }
  connectionVersion(scopeId: string, pluginId?: string, selection?: { operationId: SourceOperationId; includePool?: boolean }): unknown {
    const value = this.get(), policy = this.effectivePolicy(scopeId);
    const operationPolicies = value.operationPolicies.filter(item => item.scopeId === scopeId && (!selection || item.operationId === selection.operationId));
    const selected = selection ? this.operationCandidates(scopeId, selection.operationId) : this.candidates(scopeId);
    const pool = selection?.includePool ? this.operationPoolCandidates(scopeId, selection.operationId) : [];
    const connections = [...selected, ...pool].filter(connection => !pluginId || connection.pluginId === pluginId), ids = connections.map(connection => connection.id);
    return { policy: { scopeId, enabled: policy.enabled, primary: policy.primary && ids.includes(policy.primary) ? policy.primary : null, backups: policy.backups.filter(id => ids.includes(id)) },
      operationPolicies, selectedConnectionIds: selected.filter(connection => ids.includes(connection.id)).map(connection => connection.id),
      poolConnectionIds: pool.filter(connection => ids.includes(connection.id)).map(connection => connection.id),
      connections: connections.map(connection => ({ ...executionConnection(connection), enabled: connection.enabled,
        pluginEnabled: value.plugins.find(plugin => plugin.id === connection.pluginId)?.enabled ?? false })), execution: value.execution };
  }
  captureCheck(sourceId: CaptureSourceId): Promise<SourceCheck> {
    return Promise.resolve(this.sessions?.status(sourceId)).then(status => this.saveCheck({ id: sourceId, checkedAt: new Date().toISOString(), configurationRevision: this.get().revision,
      status: !this.get().capture.find(item => item.sourceId === sourceId)?.enabled || !status || status.needsAttention ? 'blocked' : 'partial', reachable: null, authorized: status ? !status.needsAttention : null,
      capabilityAvailable: status ? !status.needsAttention : false, freshness: 'unknown', reason: !this.get().capture.find(item => item.sourceId === sourceId)?.enabled ? '本站已停用。' : status?.message ?? '本站独立会话未装配；没有发起站点读取。' }));
  }
}
function migrateProviderNames(value: Record<string, unknown>): void {
  if (Array.isArray(value.plugins)) for (const plugin of value.plugins) if (object(plugin) && plugin.id === 'fuyao') plugin.id = 'ths';
  if (Array.isArray(value.connections)) for (const connection of value.connections) if (object(connection) && connection.pluginId === 'fuyao') connection.pluginId = 'ths';
}
function migratePublicProviders(value: Record<string, unknown>): void {
  if (!Array.isArray(value.plugins) || !Array.isArray(value.connections)) return;
  for (const provider of publicKlineProviders) {
    if (!value.plugins.some(item => object(item) && item.id === provider.id)) value.plugins.push({ id: provider.id, enabled: true });
    if (!value.connections.some(item => object(item) && item.pluginId === provider.id)) {
      value.connections.push({ id: `${provider.id}-main`, pluginId: provider.id, alias: provider.alias, enabled: true, baseUrl: provider.baseUrl, credential: null, scopes: ['CN/A_STOCK'] });
    }
  }
}
function migrateWerssProvider(value: Record<string, unknown>): void {
  if (Array.isArray(value.plugins) && !value.plugins.some(item => object(item) && item.id === 'werss')) {
    value.plugins.push({ id: 'werss', enabled: false });
  }
}
function executionConnection(connection: SourceConnection) {
  return { id: connection.id, pluginId: connection.pluginId, baseUrl: connection.baseUrl, credential: connection.credential,
    scopes: connection.scopes, ...(connection.tdxMode ? { tdxMode: connection.tdxMode } : {}),
    ...(connection.feedIds ? { feedIds: connection.feedIds } : {}) };
}

function defaults(connectionsRegistryPath?: string): SourceSettingsDocument {
  let reference: SourceConnection['credential'] = null, endpoint = thsSource.apiBaseUrl;
  // 只从已明确选择的本机连接档案承接公开端点与引用；不读取或复制凭据值。
  try {
    const selected = registeredConnection(readConnectionRegistry(connectionsRegistryPath), 'ths-finance-api'), credential = selected?.credential_ref;
    if (selected?.endpoint === thsSource.apiBaseUrl && object(credential) && credential.kind === 'keychain-item-reference'
      && typeof credential.service === 'string' && typeof credential.account === 'string') reference = { kind: 'keychain', service: credential.service, account: credential.account };
  } catch { /* 未配置机器保持缺项，按当前引用重新检查。 */ }
  return { revision: 1, updatedAt: null, plugins: [{ id: 'tdx', enabled: true }, { id: 'ths', enabled: true }, ...publicKlineProviders.map(provider => ({ id: provider.id, enabled: true })), { id: 'werss', enabled: false }],
    wechatExtract: defaultWechatExtract(),
    execution: { maxConcurrentPerAccount: 1, minimumIntervalMs: 1000 },
    connections: [{ id: 'tdx-main', pluginId: 'tdx', alias: '通达信 · 待核数据服务账号', enabled: false, baseUrl: 'tdxaidata://data-service', credential: null, scopes: ['CN/A_STOCK'], tdxMode: 'data_service' },
      { id: 'ths-finance-api', pluginId: 'ths', alias: '同花顺金融数据 · 本机账号', enabled: true, baseUrl: endpoint, credential: reference, scopes: ['CN/A_STOCK'] },
      ...publicKlineProviders.map(provider => ({ id: `${provider.id}-main`, pluginId: provider.id, alias: provider.alias, enabled: true, baseUrl: provider.baseUrl, credential: null, scopes: ['CN/A_STOCK'] }))],
    policies: scopes.map(scope => ({ scopeId: scope.id, enabled: true, mode: scope.id === 'global' ? 'override' : 'inherit', primary: scope.id === 'global' ? 'ths-finance-api' : null, backups: [] })),
    operationPolicies: [],
    capture: CAPTURE_SOURCE_IDS.map(sourceId => ({ sourceId, enabled: true, operation: CAPTURE_SITE_RULES.find(rule => rule.sourceId === sourceId)!.operation, parameters: {}, watchTargets: [] })) };
}
function clientEndpoint(value: SourceSettingsDocument): { baseUrl?: string } {
  const connection = value.connections.find(item => item.pluginId === 'tdx' && item.tdxMode === 'client_http');
  return connection ? { baseUrl: connection.baseUrl } : {};
}
function validClientEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && Number(url.port || 80) > 0 && Number(url.port || 80) <= 65535 && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
function validate(input: unknown): SourceSettingsDocument {
  if (!object(input) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !Array.isArray(input.plugins) || !Array.isArray(input.connections) || !Array.isArray(input.policies) || !Array.isArray(input.operationPolicies) || !Array.isArray(input.capture)) bad('来源配置格式无效。');
  const value = structuredClone(input) as unknown as SourceSettingsDocument;
  if (Object.keys(value).some(key => !['revision', 'updatedAt', 'plugins', 'connections', 'policies', 'operationPolicies', 'capture', 'execution', 'wechatExtract'].includes(key))) bad('来源配置包含未知字段。');
  if (!object(value.wechatExtract) || Object.keys(value.wechatExtract).some(key => !['enabled', 'scriptPath', 'sha256'].includes(key))
    || typeof value.wechatExtract.enabled !== 'boolean' || value.wechatExtract.sha256 !== WECHAT_EXTRACT_SHA256
    || (value.wechatExtract.scriptPath !== null && (typeof value.wechatExtract.scriptPath !== 'string'
      || !isAbsolute(value.wechatExtract.scriptPath) || value.wechatExtract.scriptPath.includes('\0')
      || basename(value.wechatExtract.scriptPath) !== 'wechat_extract.py'))
    || value.wechatExtract.enabled && value.wechatExtract.scriptPath === null) bad('公众号脚本登记只接受当前固定版脚本的本机绝对位置与摘要。');
  if (value.plugins.length !== providerIds.length || value.plugins.some(item => !object(item) || Object.keys(item).some(key => !['id', 'enabled'].includes(key))) || new Set(value.plugins.map(item => item.id)).size !== providerIds.length || value.plugins.some(item => !providerIdSet.has(item.id) || typeof item.enabled !== 'boolean')) bad('来源插件登记不符。');
  if (!value.execution || Object.keys(value.execution).some(key => !['maxConcurrentPerAccount', 'minimumIntervalMs'].includes(key)) || value.execution.maxConcurrentPerAccount !== 1 || !Number.isSafeInteger(value.execution.minimumIntervalMs) || value.execution.minimumIntervalMs < 0 || value.execution.minimumIntervalMs > 60_000) bad('本机执行策略需保持同一账号串行1，最小间隔为0至60000毫秒。');
  const ids = new Set<string>();
  for (const connection of value.connections) {
    if (!object(connection) || Object.keys(connection).some(key => !['id', 'pluginId', 'alias', 'enabled', 'baseUrl', 'credential', 'scopes', 'tdxMode', 'feedIds'].includes(key))
      || !id(connection.id) || ids.has(connection.id) || !providerIdSet.has(connection.pluginId) || typeof connection.enabled !== 'boolean'
      || typeof connection.alias !== 'string' || !connection.alias.trim() || connection.alias.length > 200 || /[\u0000-\u001f\u007f]/u.test(connection.alias)
      || connection.pluginId === 'ths' && connection.baseUrl !== thsSource.apiBaseUrl
      || connection.pluginId === 'tdx' && (!['data_service', 'client_http'].includes(String(connection.tdxMode)) || (connection.tdxMode === 'client_http' ? !validClientEndpoint(connection.baseUrl) : connection.baseUrl !== 'tdxaidata://data-service'))
      || connection.pluginId === 'werss' && (!validWerssBaseUrl(connection.baseUrl) || connection.credential !== null || connection.tdxMode !== undefined
        || !Array.isArray(connection.scopes) || connection.scopes.length !== 0 || !Array.isArray(connection.feedIds)
        || connection.feedIds.length < 1 || connection.feedIds.length > 20
        || connection.feedIds.some(feedId => typeof feedId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(feedId))
        || new Set(connection.feedIds).size !== connection.feedIds.length)
      || connection.pluginId !== 'werss' && connection.feedIds !== undefined
      || !!publicKlineProvider(connection.pluginId) && (connection.baseUrl !== publicKlineProvider(connection.pluginId)!.baseUrl || connection.credential !== null || connection.tdxMode !== undefined)
      || !Array.isArray(connection.scopes) || connection.scopes.some(scope => !scopes.some(item => item.id === scope))) bad('来源连接身份、服务地址或范围无效。');
    ids.add(connection.id);
    const credential = connection.credential;
    if (credential !== null && (!object(credential) || (credential.kind === 'keychain'
      ? Object.keys(credential).some(key => !['kind', 'service', 'account'].includes(key)) || typeof credential.service !== 'string' || !credential.service || typeof credential.account !== 'string' || !credential.account || /[\u0000-\u001f\u007f]/u.test(credential.service + credential.account)
      : credential.kind === 'dsh-ref' ? Object.keys(credential).some(key => !['kind', 'path', 'ref'].includes(key)) || typeof credential.path !== 'string' || !credential.path || typeof credential.ref !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(credential.ref) : true))) bad('来源凭据只接受明确安全引用，不接受密钥正文。');
  }
  if (value.connections.filter(connection => connection.pluginId === 'werss')
    .reduce((count, connection) => count + (connection.feedIds?.length ?? 0), 0) > 20) {
    bad('首版 WeRSS 连接和 feed 明确登记总数最多 20 对，避免动作发现超出模型分享预算。');
  }
  if (value.policies.some(item => !object(item) || Object.keys(item).some(key => !['scopeId', 'enabled', 'mode', 'primary', 'backups'].includes(key)))) bad('范围配置格式无效。');
  if (value.policies.length !== scopes.length || new Set(value.policies.map(item => item.scopeId)).size !== scopes.length) bad('范围配置缺失或重复。');
  for (const policy of value.policies) {
    if (!scopes.some(scope => scope.id === policy.scopeId) || typeof policy.enabled !== 'boolean' || !['inherit', 'override'].includes(policy.mode)
      || policy.scopeId === 'global' && policy.mode !== 'override' || !Array.isArray(policy.backups) || ![policy.primary, ...policy.backups].every(item => item === null || ids.has(item))) bad('主备组合引用无效。');
    const references = [policy.primary, ...policy.backups].filter(item => item !== null);
    if (references.some(connectionId => value.connections.find(item => item.id === connectionId)?.pluginId === 'werss')) bad('WeRSS 本地服务不能进入行情主备。');
    if (new Set(references).size !== references.length) bad('主源和备用源不能重复引用同一连接。');
    if (policy.scopeId !== 'global' && policy.mode === 'override' && references.some(connectionId => { const c = value.connections.find(item => item.id === connectionId)!; return !c.scopes.includes(policy.scopeId) && !c.scopes.includes('global'); })) bad('范围组合中的连接不覆盖该国家市场。');
  }
  if (value.operationPolicies.some(item => !object(item) || Object.keys(item).some(key => !['scopeId', 'operationId', 'primary', 'backups'].includes(key)))) bad('接口类型来源策略格式无效。');
  const operationKeys = new Set<string>();
  for (const policy of value.operationPolicies) {
    if (!Array.isArray(policy.backups) || policy.backups.length > 1) bad('接口类型只支持一个主源和一个备用源。');
    if (!scopes.some(scope => scope.id === policy.scopeId) || !operationIds.includes(policy.operationId)
      || ![policy.primary, ...policy.backups].every(item => item === null || ids.has(item))) bad('接口类型来源策略引用无效。');
    const key = `${policy.scopeId}:${policy.operationId}`;
    if (operationKeys.has(key)) bad('接口类型来源策略重复。');
    operationKeys.add(key);
    const references = [policy.primary, ...policy.backups].filter(item => item !== null);
    if (references.some(connectionId => value.connections.find(item => item.id === connectionId)?.pluginId === 'werss')) bad('WeRSS 本地服务不能进入行情接口主备。');
    if (new Set(references).size !== references.length) bad('接口类型主源和备用源不能重复引用同一连接。');
    if (policy.scopeId !== 'global' && references.some(connectionId => { const c = value.connections.find(item => item.id === connectionId)!; return !c.scopes.includes(policy.scopeId) && !c.scopes.includes('global'); })) bad('接口类型来源策略中的连接不覆盖该国家市场。');
  }
  if (value.capture.length !== CAPTURE_SOURCE_IDS.length || value.capture.some(item => !object(item) || Object.keys(item).some(key => !['sourceId', 'enabled', 'operation', 'parameters', 'watchTargets'].includes(key))) || new Set(value.capture.map(item => item.sourceId)).size !== CAPTURE_SOURCE_IDS.length) bad('八站采集配置缺失或重复。');
  for (const capture of value.capture) {
    if (!CAPTURE_SOURCE_IDS.includes(capture.sourceId) || typeof capture.enabled !== 'boolean' || !object(capture.parameters) || !Array.isArray(capture.watchTargets)
      || capture.watchTargets.length > 200 || capture.watchTargets.some(item => typeof item !== 'string' || item.length > 4096)) bad('采集源配置或关注对象无效。');
    const rule = captureSiteRule(capture.sourceId, capture.operation);
    // 配置允许必填参数暂缺；明确执行时仍由同一个规则完整校验。
    const supplied = Object.fromEntries(Object.entries(rule.parameters).filter(([key]) => Object.hasOwn(capture.parameters, key)).map(([key, definition]) => [key, { ...definition, required: false }]));
    normalizeCaptureArgs({ ...rule, parameters: supplied }, capture.parameters);
  }
  return value;
}

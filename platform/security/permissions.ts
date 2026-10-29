import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { CoreDatabase } from '../state/database.js';

export type PermissionAction = 'read' | 'write' | 'delete' | 'execute' | 'network' | 'secret';
export type PermissionTarget =
  | { kind: 'file'; path: string }
  | { kind: 'directory'; path: string; recursive: boolean }
  | { kind: 'network'; origin: string }
  | { kind: 'secret'; name: string };
export interface PermissionCapability { action: PermissionAction; target: PermissionTarget }
export interface OperationScope {
  runId: string;
  attemptId: string;
  generation: number;
  operationId: string;
  operationVersion: number;
  argsDigest: string;
  targets: readonly PermissionTarget[];
  /** 仅受信宿主按已登记实现生成；模型参数与 HTTP（网页接口）输入不能自报审批分类。 */
  approvalMode?: 'automatic' | 'review';
}
/** 本地授权只分持续授权与运行授权；撤销立即生效，恢复不自动重放旧请求。 */
export type GrantScope =
  | { kind: 'persistent' }
  | { kind: 'run'; runId: string; generation: number; attemptId?: string };
export interface PermissionGrant {
  id: string;
  capabilities: PermissionCapability[];
  effect: 'allow' | 'deny';
  scope: GrantScope;
  label: string | null;
  revoked: boolean;
  createdAt: number;
}
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'invalidated' | 'expired';
export interface ApprovalRequest {
  id: string;
  operation: OperationScope;
  requestedCapabilities: PermissionCapability[];
  approvedCapabilities: PermissionCapability[];
  policyVersion: number;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  reason: string | null;
}
export interface AuthorizationReceipt {
  policyVersion: number;
  operation: OperationScope;
  grantIds: string[];
  approvalId: string | null;
}
export interface PermissionDecision { decision: 'allow' | 'deny' | 'ask'; reason?: string }
export class PermissionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PermissionError'; }
}

export interface PathObjectIdentity {
  device: string;
  inode: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeNs: string;
  mtimeMs: number;
}
export interface PathIdentity {
  invocationPath: string;
  canonicalPath: string;
  exists: boolean;
  object: PathObjectIdentity | null;
  ancestor: { canonicalPath: string; device: string; inode: string };
  links: { path: string; device: string; inode: string; target: string }[];
}
interface BoundCapability { capability: PermissionCapability; identity?: PathIdentity }
interface BoundOperation { operation: OperationScope; targets: { target: PermissionTarget; identity?: PathIdentity }[] }
interface StoredApproval {
  id: string;
  binding: BoundOperation;
  requested: BoundCapability[];
  approved: BoundCapability[];
  policyVersion: number;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  reason: string | null;
}

const ACTIONS: readonly PermissionAction[] = ['read', 'write', 'delete', 'execute', 'network', 'secret'];
const SCHEMA = `
CREATE TABLE permission_policy (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO permission_policy VALUES (1, 1);
CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope TEXT NOT NULL, label TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE permission_approvals (
  id TEXT PRIMARY KEY, binding TEXT NOT NULL, requested TEXT NOT NULL, approved TEXT NOT NULL DEFAULT '[]',
  policy_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','invalidated','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT
);
CREATE TABLE permission_invalidated_attempts (
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
  PRIMARY KEY(run_id,attempt_id,generation)
);
CREATE INDEX permission_approvals_status ON permission_approvals(status);
`;

/** 只接受绝对路径；路径引用不能借由 .. 改变授权对象。 */
export function normalizePermissionPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !isAbsolute(value)
    || value.split(/[\\/]/u).includes('..')) {
    throw new PermissionError('INVALID_PATH', '文件权限需要不含路径穿越的绝对路径。');
  }
  return resolve(value);
}

/** 观察调用路径、符号链接和真实对象；本函数只读取元数据，不授予权限。 */
export function inspectPath(value: string, options: { allowMissing?: boolean } = {}): PathIdentity {
  const invocationPath = normalizePermissionPath(value);
  const links: PathIdentity['links'] = [];
  let prefix = parse(invocationPath).root;
  for (const part of invocationPath.slice(prefix.length).split(sep).filter(Boolean)) {
    prefix = join(prefix, part);
    try {
      const entry = lstatSync(prefix, { bigint: true });
      if (entry.isSymbolicLink()) links.push({ path: prefix, device: String(entry.dev), inode: String(entry.ino), target: readlinkSync(prefix) });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) break;
      throw new PermissionError('PATH_UNAVAILABLE', '无法核对文件路径。');
    }
  }
  let existing = invocationPath;
  let object: PathObjectIdentity | null = null;
  let exists = false;
  try {
    // lstat 让悬空链接不能作为一个尚不存在的输出文件处理。
    lstatSync(existing);
    object = objectIdentity(statSync(existing, { bigint: true }));
    exists = true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT') || !options.allowMissing) throw new PermissionError('PATH_UNAVAILABLE', '目标不存在或无法核对。');
    try {
      lstatSync(existing);
      throw new PermissionError('INVALID_PATH', '悬空符号链接不能作为输出路径。');
    } catch (entryError) {
      if (!hasCode(entryError, 'ENOENT')) throw entryError;
    }
    while (true) {
      existing = dirname(existing);
      try { lstatSync(existing); break; } catch (entryError) {
        if (!hasCode(entryError, 'ENOENT') || existing === dirname(existing)) throw new PermissionError('PATH_UNAVAILABLE', '无法核对目标的父目录。');
      }
    }
  }
  try {
    const canonicalExisting = realpathSync.native(existing);
    const ancestorStat = statSync(existing, { bigint: true });
    if (!exists && !ancestorStat.isDirectory()) throw new PermissionError('INVALID_PATH', '输出路径的父对象不是目录。');
    return {
      invocationPath,
      canonicalPath: exists ? canonicalExisting : join(canonicalExisting, relative(existing, invocationPath)),
      exists, object,
      ancestor: { canonicalPath: canonicalExisting, device: String(ancestorStat.dev), inode: String(ancestorStat.ino) },
      links,
    };
  } catch (error) {
    if (error instanceof PermissionError) throw error;
    throw new PermissionError('PATH_UNAVAILABLE', '无法解析目标的真实路径。');
  }
}

export function samePathIdentity(left: PathIdentity, right: PathIdentity, includeContent = false): boolean {
  if (left.invocationPath !== right.invocationPath || left.canonicalPath !== right.canonicalPath || left.exists !== right.exists
    || JSON.stringify(left.links) !== JSON.stringify(right.links)) return false;
  if (!left.exists) return left.ancestor.canonicalPath === right.ancestor.canonicalPath
    && left.ancestor.device === right.ancestor.device && left.ancestor.inode === right.ancestor.inode;
  const a = left.object;
  const b = right.object;
  return !!a && !!b && a.device === b.device && a.inode === b.inode && a.kind === b.kind
    && (!includeContent || a.kind === 'directory' || (a.size === b.size && a.mtimeNs === b.mtimeNs));
}

export function digestOperationArgs(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Core 的授权账本；不会提供操作系统沙箱，也不会执行被批准的动作。 */
/** 未经过内置代理分类的其他入口保留原授权语义。 */
const DEFAULT_ALLOWED = new Set(['read', 'write']);

export class PermissionService {
  private readonly database: CoreDatabase;
  private readonly isRunActive: (runId: string, generation: number) => boolean;
  private readonly now: () => number;

  constructor(options: { database: CoreDatabase; isRunActive: (runId: string, generation: number) => boolean; now?: () => number }) {
    this.database = options.database;
    this.isRunActive = options.isRunActive;
    this.now = options.now ?? Date.now;
    this.database.migrate('permissions', 1, SCHEMA);
  }

  get policyVersion(): number {
    const row = this.database.connection.prepare('SELECT version FROM permission_policy WHERE id=1').get();
    if (!row || !Number.isSafeInteger(Number(row.version))) throw new PermissionError('INVALID_POLICY', '权限策略记录无效。');
    return Number(row.version);
  }

  grant(input: { capabilities: readonly PermissionCapability[]; effect?: 'allow' | 'deny'; scope?: GrantScope; label?: string }): PermissionGrant {
    const capabilities = bindCapabilities(input.capabilities);
    const scope = validateGrantScope(input.scope ?? { kind: 'persistent' });
    const effect = input.effect ?? 'allow';
    if (effect !== 'allow' && effect !== 'deny') throw new PermissionError('INVALID_GRANT', '授权规则无效。');
    const id = randomUUID();
    const createdAt = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare('INSERT INTO permission_grants(id,capabilities,effect,scope,label,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, JSON.stringify(capabilities), effect, JSON.stringify(scope), input.label ?? null, createdAt);
      // 新增允许不使既有审批失效；拒绝、撤销及显式失效仍推进策略代次，执行时照常核权。
      if (effect === 'deny') this.advancePolicyInTransaction();
    });
    return { id, capabilities: capabilities.map((x) => x.capability), effect, scope, label: input.label ?? null, revoked: false, createdAt };
  }

  revoke(grantId: string): boolean {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare('UPDATE permission_grants SET revoked=1 WHERE id=? AND revoked=0').run(grantId);
      if (result.changes) this.advancePolicyInTransaction();
      return result.changes !== 0;
    });
  }

  getGrant(grantId: string): PermissionGrant {
    const row = this.database.connection.prepare('SELECT * FROM permission_grants WHERE id=?').get(grantId);
    if (!row) throw new PermissionError('GRANT_NOT_FOUND', '没有找到此授权。');
    return structuredClone({
      id: String(row.id), capabilities: readJson<BoundCapability[]>(row.capabilities).map((entry) => entry.capability),
      effect: String(row.effect) as PermissionGrant['effect'], scope: validateGrantScope(readJson<GrantScope>(row.scope)),
      label: row.label === null ? null : String(row.label), revoked: Number(row.revoked) === 1, createdAt: Number(row.created_at),
    });
  }

  listGrants(options: { includeRevoked?: boolean } = {}): PermissionGrant[] {
    return this.database.connection.prepare(`SELECT id FROM permission_grants ${options.includeRevoked ? '' : 'WHERE revoked=0'} ORDER BY created_at,id`).all()
      .map((row) => this.getGrant(String(row.id)));
  }

  advancePolicy(): number { return this.database.transaction(() => this.advancePolicyInTransaction()); }

  check(operation: OperationScope, capabilities: readonly PermissionCapability[], options: { approvalId?: string } = {}): PermissionDecision {
    try {
      this.authorize(operation, capabilities, options.approvalId);
      return { decision: 'allow' };
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
      return { decision: error.code === 'APPROVAL_REQUIRED' ? 'ask' : 'deny', reason: error.code };
    }
  }

  assertAuthorized(operation: OperationScope, capabilities: readonly PermissionCapability[], options: { approvalId?: string } = {}): AuthorizationReceipt {
    return this.authorize(operation, capabilities, options.approvalId);
  }

  requestApproval(operation: OperationScope, capabilities: readonly PermissionCapability[], options: { expiresInMs?: number; reason?: string } = {}): ApprovalRequest {
    const binding = bindOperation(operation);
    const requested = bindCapabilities(capabilities);
    assertTargetsDeclared(binding, requested);
    this.assertLive(operation);
    this.assertNoDenials(operation, requested);
    const duration = options.expiresInMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000) throw new PermissionError('INVALID_APPROVAL', '审批有效期需要在一天以内。');
    const createdAt = this.now();
    const approval: StoredApproval = {
      id: randomUUID(), binding, requested, approved: [], policyVersion: this.policyVersion,
      status: 'pending', createdAt, expiresAt: createdAt + duration, reason: options.reason ?? null,
    };
    this.database.transaction(() => {
      this.assertLive(operation);
      if (this.policyVersion !== approval.policyVersion) throw new PermissionError('POLICY_CHANGED', '权限策略已变化，请重新准备动作。');
      this.database.connection.prepare('INSERT INTO permission_approvals(id,binding,requested,policy_version,status,created_at,expires_at,reason) VALUES(?,?,?,?,?,?,?,?)')
        .run(approval.id, JSON.stringify(binding), JSON.stringify(requested), approval.policyVersion, 'pending', createdAt, approval.expiresAt, approval.reason);
    });
    return publicApproval(approval);
  }

  /** 只允许批准请求的子范围；批准不会建立可被其他动作借用的永久授权。 */
  approve(approvalId: string, capabilities: readonly PermissionCapability[]): ApprovalRequest {
    const approved = bindCapabilities(capabilities);
    const outcome = this.database.transaction(() => {
      const approval = this.readApproval(approvalId);
      const stale = this.approvalStaleReason(approval);
      if (stale) {
        this.invalidateApproval(approval.id, stale === 'APPROVAL_EXPIRED' ? 'expired' : 'invalidated');
        return { error: stale };
      }
      if (approval.status !== 'pending') throw new PermissionError('APPROVAL_NOT_PENDING', '此审批已经处理，不能再次批准。');
      if (!approved.every((capability) => approval.requested.some((requested) => covers(requested, capability)))) {
        throw new PermissionError('APPROVAL_EXPANSION', '批准范围不能超过原请求。');
      }
      this.assertNoDenials(approval.binding.operation, approved);
      this.database.connection.prepare("UPDATE permission_approvals SET approved=?,status='approved' WHERE id=? AND status='pending'")
        .run(JSON.stringify(approved), approval.id);
      approval.approved = approved;
      approval.status = 'approved';
      return { approval };
    });
    if (outcome.error) throw new PermissionError(outcome.error, '审批已失效，请重新核对当前动作。');
    return publicApproval(outcome.approval!);
  }

  deny(approvalId: string): ApprovalRequest {
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE permission_approvals SET status='denied' WHERE id=? AND status='pending'").run(approvalId);
    });
    return this.getApproval(approvalId);
  }

  getApproval(approvalId: string): ApprovalRequest {
    const approval = this.readApproval(approvalId);
    if (approval.status === 'pending' || approval.status === 'approved') {
      const reason = this.approvalStaleReason(approval);
      if (reason) approval.status = reason === 'APPROVAL_EXPIRED' ? 'expired' : 'invalidated';
    }
    return publicApproval(approval);
  }

  /** 只读审批账本的已记录决定；不检查当前执行资格，绝不是授权执行的收据。
   * 数据分享方还须核对自己的父运行、策略/期限、明确数据选择及对象身份。
   * 实际文件/网络/执行动作必须使用 assertAuthorized，不能用此历史决定放行。
   */
  getRecordedApproval(approvalId: string): ApprovalRequest {
    return publicApproval(this.readApproval(approvalId));
  }

  listApprovals(): ApprovalRequest[] {
    return this.database.connection.prepare('SELECT id FROM permission_approvals ORDER BY created_at,id').all()
      .map((row) => this.getApproval(String(row.id)));
  }

  cancelForRun(runId: string, generation: number): void {
    this.invalidateScope(runId, generation);
  }

  /** 撤销一个已停止动作的待审批；其他动作票据与策略版本保持原值。 */
  cancelPendingApproval(approvalId: string, expectedOperation: OperationScope): void {
    validId(approvalId);
    this.database.transaction(() => {
      const approval = this.readApproval(approvalId), actual = approval.binding.operation;
      if (actual.runId !== expectedOperation.runId || actual.attemptId !== expectedOperation.attemptId
        || actual.generation !== expectedOperation.generation || actual.operationId !== expectedOperation.operationId
        || actual.operationVersion !== expectedOperation.operationVersion || actual.argsDigest !== expectedOperation.argsDigest) {
        throw new PermissionError('APPROVAL_BINDING_MISMATCH', '审批不属于当前停止的动作。');
      }
      this.database.connection.prepare("UPDATE permission_approvals SET status='invalidated' WHERE id=? AND status='pending'").run(approvalId);
    });
  }

  invalidateAttempt(runId: string, attemptId: string, generation: number): void {
    this.invalidateScope(runId, generation, attemptId);
  }

  private invalidateScope(runId: string, generation: number, attemptId?: string): void {
    validId(runId);
    validGeneration(generation);
    if (attemptId !== undefined) validId(attemptId);
    this.database.transaction(() => {
      this.database.connection.prepare('INSERT OR IGNORE INTO permission_invalidated_attempts VALUES(?,?,?)').run(runId, attemptId ?? '*', generation);
      for (const row of this.database.connection.prepare("SELECT id,binding FROM permission_approvals WHERE status IN ('pending','approved')").all()) {
        const binding = readJson<BoundOperation>(row.binding);
        if (binding.operation.runId === runId && binding.operation.generation === generation
          && (attemptId === undefined || binding.operation.attemptId === attemptId)) this.invalidateApproval(String(row.id), 'invalidated');
      }
    });
  }

  private authorize(operation: OperationScope, capabilities: readonly PermissionCapability[], approvalId?: string): AuthorizationReceipt {
    const binding = bindOperation(operation);
    const needed = bindCapabilities(capabilities);
    assertTargetsDeclared(binding, needed);
    this.assertLive(operation);
    const grants = this.currentGrants(operation);
    if (needed.some((capability) => grants.some((grant) => grant.effect === 'deny' && grant.bound.some((entry) => denialOverlaps(entry, capability))))) {
      throw new PermissionError('POLICY_DENIED', '当前权限策略拒绝此动作。');
    }
    const approval = approvalId === undefined ? undefined : this.readApproval(approvalId);
    if (approval) {
      const stale = this.approvalStaleReason(approval);
      if (stale) throw new PermissionError(stale, '审批已失效，请重新核对。');
      if (approval.status !== 'approved') throw new PermissionError('APPROVAL_NOT_APPROVED', '动作尚未获得有效批准。');
      if (operationBindingDigest(approval.binding) !== operationBindingDigest(binding)) throw new PermissionError('APPROVAL_BINDING_CHANGED', '此批准不属于当前动作参数或目标。');
    }
    const used = new Set<string>();
    // 内置代理的删除或修改既有内容必须批准本次动作；持续允许不能代替本次审核。
    // 已登记的只读/新建工具由宿主标为 automatic，内部暂存写入与清理沿其原边界执行。
    const review = operation.approvalMode === 'review';
    if (review && !approval) throw new PermissionError('APPROVAL_REQUIRED', '删除或更改动作需要本次明确审核。');
    for (const capability of needed) {
      if (review) {
        if (!approval?.approved.some((entry) => covers(entry, capability))) throw new PermissionError('APPROVAL_REQUIRED', '此更改动作尚未获得完整批准。');
        continue;
      }
      if (operation.approvalMode === 'automatic' || DEFAULT_ALLOWED.has(capability.capability.action)
        && capability.capability.target.kind !== 'network' && capability.capability.target.kind !== 'secret') continue;
      const grant = grants.find((item) => item.effect === 'allow' && item.bound.some((entry) => covers(entry, capability)));
      if (grant) { used.add(grant.id); continue; }
      if (!approval?.approved.some((entry) => covers(entry, capability))) throw new PermissionError('APPROVAL_REQUIRED', '此动作需要明确的权限批准。');
    }
    return { policyVersion: this.policyVersion, operation: structuredClone(binding.operation), grantIds: [...used], approvalId: approval?.id ?? null };
  }

  private assertNoDenials(operation: OperationScope, needed: BoundCapability[]): void {
    if (this.currentGrants(operation).some((grant) => grant.effect === 'deny' && grant.bound.some((entry) => needed.some((capability) => denialOverlaps(entry, capability))))) {
      throw new PermissionError('POLICY_DENIED', '当前策略不允许请求此范围。');
    }
  }

  private currentGrants(operation: OperationScope): { id: string; effect: 'allow' | 'deny'; bound: BoundCapability[] }[] {
    return this.database.connection.prepare('SELECT id,capabilities,effect,scope FROM permission_grants WHERE revoked=0').all().flatMap((row) => {
      const scope = validateGrantScope(readJson<GrantScope>(row.scope));
      if (scope.kind === 'run' && (scope.runId !== operation.runId || scope.generation !== operation.generation
        || (scope.attemptId !== undefined && scope.attemptId !== operation.attemptId))) return [];
      const bound = readJson<BoundCapability[]>(row.capabilities);
      const current = bound.filter((capability) => bindingIsCurrent(capability, false));
      // 失去已授权路径的身份时不能授予新对象；拒绝规则则继续覆盖该路径，不能因换对象解除拒绝。
      return [{ id: String(row.id), effect: row.effect === 'deny' ? 'deny' as const : 'allow' as const, bound: row.effect === 'deny' ? bound : current }];
    });
  }

  private assertLive(operation: OperationScope): void {
    let active = false;
    try { active = this.isRunActive(operation.runId, operation.generation); } catch { /* 无法核对活动所有权时拒绝执行。 */ }
    const invalidated = this.database.connection.prepare("SELECT 1 FROM permission_invalidated_attempts WHERE run_id=? AND generation=? AND attempt_id IN (?, '*')")
      .get(operation.runId, operation.generation, operation.attemptId);
    if (!active || invalidated) throw new PermissionError('RUN_INACTIVE', '此运行或尝试已停止或被替换。');
  }

  private approvalStaleReason(approval: StoredApproval): string | undefined {
    if (this.now() >= approval.expiresAt) return 'APPROVAL_EXPIRED';
    if (approval.policyVersion !== this.policyVersion) return 'POLICY_CHANGED';
    try { this.assertLive(approval.binding.operation); } catch { return 'RUN_INACTIVE'; }
    try {
      if (operationBindingDigest(approval.binding) !== operationBindingDigest(bindOperation(approval.binding.operation))
        || ![...approval.requested, ...approval.approved].every((capability) => bindingIsCurrent(capability, true))) return 'TARGET_CHANGED';
    } catch { return 'TARGET_CHANGED'; }
    return undefined;
  }

  private readApproval(id: string): StoredApproval {
    const row = this.database.connection.prepare('SELECT * FROM permission_approvals WHERE id=?').get(id);
    if (!row) throw new PermissionError('APPROVAL_NOT_FOUND', '没有找到此审批。');
    return {
      id: String(row.id), binding: readJson<BoundOperation>(row.binding), requested: readJson<BoundCapability[]>(row.requested),
      approved: readJson<BoundCapability[]>(row.approved), policyVersion: Number(row.policy_version), status: String(row.status) as ApprovalStatus,
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), reason: row.reason === null ? null : String(row.reason),
    };
  }

  private invalidateApproval(id: string, status: 'invalidated' | 'expired'): void {
    this.database.connection.prepare("UPDATE permission_approvals SET status=? WHERE id=? AND status IN ('pending','approved')").run(status, id);
  }

  private advancePolicyInTransaction(): number {
    this.database.connection.prepare('UPDATE permission_policy SET version=version+1 WHERE id=1').run();
    this.database.connection.prepare("UPDATE permission_approvals SET status='invalidated' WHERE status IN ('pending','approved')").run();
    return this.policyVersion;
  }
}

function bindOperation(operation: OperationScope): BoundOperation {
  if (!operation || typeof operation !== 'object') throw new PermissionError('INVALID_OPERATION', '动作范围无效。');
  for (const id of [operation.runId, operation.attemptId, operation.operationId]) validId(id);
  validGeneration(operation.generation);
  if (!Number.isSafeInteger(operation.operationVersion) || operation.operationVersion < 1 || !/^[a-f0-9]{64}$/u.test(operation.argsDigest)) {
    throw new PermissionError('INVALID_OPERATION', '动作版本或参数摘要无效。');
  }
  if (!Array.isArray(operation.targets) || operation.targets.length < 1 || operation.targets.length > 128) throw new PermissionError('INVALID_TARGET', '动作必须声明明确目标。');
  if (operation.approvalMode !== undefined && operation.approvalMode !== 'automatic' && operation.approvalMode !== 'review') throw new PermissionError('INVALID_OPERATION', '动作审批分类无效。');
  const targets = operation.targets.map((target) => bindTarget(target, true));
  return { operation: {
    runId: operation.runId, attemptId: operation.attemptId, generation: operation.generation,
    operationId: operation.operationId, operationVersion: operation.operationVersion, argsDigest: operation.argsDigest,
    targets: targets.map((target) => target.target),
    ...(operation.approvalMode === undefined ? {} : { approvalMode: operation.approvalMode }),
  }, targets };
}

function operationBindingDigest(binding: BoundOperation): string {
  // 目录是授权命名空间根；正常增删目录项不会改变根身份。内容快照由文件引用另行核对。
  return digestOperationArgs({ ...binding, targets: binding.targets.map((entry) => {
    if (entry.target.kind !== 'directory' || !entry.identity?.object) return entry;
    const { device, inode, kind } = entry.identity.object;
    return { ...entry, identity: { ...entry.identity, object: { device, inode, kind } } };
  }) });
}

function bindCapabilities(capabilities: readonly PermissionCapability[]): BoundCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 128) throw new PermissionError('INVALID_CAPABILITY', '需要声明一项到 128 项具体权限。');
  return capabilities.map((capability) => {
    if (!capability || !ACTIONS.includes(capability.action)) throw new PermissionError('INVALID_CAPABILITY', '权限动作无效。');
    const target = bindTarget(capability.target, capability.action === 'write');
    const valid = capability.action === 'network' ? target.target.kind === 'network'
      : capability.action === 'secret' ? target.target.kind === 'secret'
        : target.target.kind === 'file' || target.target.kind === 'directory';
    if (!valid) throw new PermissionError('INVALID_CAPABILITY', '权限动作与目标类型不匹配。');
    return { capability: { action: capability.action, target: target.target }, ...target.identity ? { identity: target.identity } : {} };
  });
}

function bindTarget(target: PermissionTarget, allowMissing: boolean): { target: PermissionTarget; identity?: PathIdentity } {
  if (!target || typeof target !== 'object') throw new PermissionError('INVALID_TARGET', '权限目标无效。');
  if (target.kind === 'file' || target.kind === 'directory') {
    if (target.kind === 'directory' && typeof target.recursive !== 'boolean') throw new PermissionError('INVALID_TARGET', '目录权限必须声明是否包括后代。');
    const identity = inspectPath(target.path, { allowMissing });
    if (identity.object && identity.object.kind !== target.kind) throw new PermissionError('INVALID_TARGET', '文件与目录授权不能互换。');
    return { target: target.kind === 'file' ? { kind: 'file', path: identity.invocationPath } : { kind: 'directory', path: identity.invocationPath, recursive: target.recursive }, identity };
  }
  if (target.kind === 'network') {
    let endpoint: URL;
    try { endpoint = new URL(target.origin); } catch { throw new PermissionError('INVALID_TARGET', '网络授权需要明确的 HTTP、HTTPS 或带端口的 TCP 来源地址。'); }
    const tcp = endpoint.protocol === 'tcp:';
    if (!['http:', 'https:', 'tcp:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (tcp ? !['', '/'].includes(endpoint.pathname) || !endpoint.port || Number(endpoint.port) < 1 : endpoint.pathname !== '/')) {
      throw new PermissionError('INVALID_TARGET', '网络授权只能指定不含凭据的来源地址。');
    }
    return { target: { kind: 'network', origin: tcp ? `tcp://${endpoint.host.toLowerCase()}` : endpoint.origin } };
  }
  if (target.kind === 'secret') {
    if (typeof target.name !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/u.test(target.name)) throw new PermissionError('INVALID_TARGET', '凭据权限需要明确的引用名。');
    return { target: { kind: 'secret', name: target.name } };
  }
  throw new PermissionError('INVALID_TARGET', '不支持此权限目标。');
}

function assertTargetsDeclared(binding: BoundOperation, capabilities: BoundCapability[]): void {
  if (!capabilities.every((capability) => binding.targets.some((item) => JSON.stringify(item.target) === JSON.stringify(capability.capability.target)))) {
    throw new PermissionError('UNDECLARED_TARGET', '权限目标不在本动作声明中。');
  }
}

function covers(grant: BoundCapability, needed: BoundCapability): boolean {
  if (grant.capability.action !== needed.capability.action) return false;
  const a = grant.capability.target;
  const b = needed.capability.target;
  if (a.kind === 'network' && b.kind === 'network') return a.origin === b.origin;
  if (a.kind === 'secret' && b.kind === 'secret') return a.name === b.name;
  if (!grant.identity || !needed.identity) return false;
  if (a.kind === 'file') return b.kind === 'file' && a.path === b.path && samePathIdentity(grant.identity, needed.identity, false);
  if (a.kind !== 'directory' || (b.kind !== 'file' && b.kind !== 'directory')) return false;
  if (a.path === b.path) return b.kind === 'directory' && (!b.recursive || a.recursive)
    && samePathIdentity(grant.identity, needed.identity, false);
  if (!a.recursive) return false;
  return isDescendant(a.path, b.path) && isDescendant(grant.identity.canonicalPath, needed.identity.canonicalPath);
}

function bindingIsCurrent(bound: BoundCapability, includeContent: boolean): boolean {
  try {
    const current = bindCapabilities([bound.capability])[0]!;
    return bound.identity ? !!current.identity && samePathIdentity(bound.identity, current.identity,
      includeContent && bound.capability.target.kind === 'file') : !current.identity;
  } catch { return false; }
}

function denialOverlaps(denial: BoundCapability, needed: BoundCapability): boolean {
  if (denial.capability.action !== needed.capability.action) return false;
  const a = denial.capability.target;
  const b = needed.capability.target;
  if (a.kind === 'network' && b.kind === 'network') return a.origin === b.origin;
  if (a.kind === 'secret' && b.kind === 'secret') return a.name === b.name;
  if ((a.kind !== 'file' && a.kind !== 'directory') || (b.kind !== 'file' && b.kind !== 'directory')) return false;
  // 拒绝保留对命名路径的限制，换 inode 或链接不能解除策略；广域请求也不能包含被拒绝的子项。
  return a.path === b.path || (a.kind === 'directory' && a.recursive && isDescendant(a.path, b.path))
    || (b.kind === 'directory' && b.recursive && isDescendant(b.path, a.path))
    || (!!denial.identity && !!needed.identity && (denial.identity.canonicalPath === needed.identity.canonicalPath
      || (!!denial.identity.object && !!needed.identity.object && denial.identity.object.device === needed.identity.object.device
        && denial.identity.object.inode === needed.identity.object.inode)));
}

function isDescendant(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function objectIdentity(stat: BigIntStats): PathObjectIdentity {
  if (!stat.isFile() && !stat.isDirectory()) throw new PermissionError('INVALID_TARGET', '只接受普通文件或目录。');
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermissionError('INVALID_TARGET', '文件大小超出可记录范围。');
  return { device: String(stat.dev), inode: String(stat.ino), kind: stat.isDirectory() ? 'directory' : 'file', size: Number(stat.size), mtimeNs: String(stat.mtimeNs), mtimeMs: Number(stat.mtimeMs) };
}

function publicApproval(value: StoredApproval): ApprovalRequest {
  return structuredClone({
    id: value.id, operation: value.binding.operation, requestedCapabilities: value.requested.map((x) => x.capability),
    approvedCapabilities: value.approved.map((x) => x.capability), policyVersion: value.policyVersion, status: value.status,
    createdAt: value.createdAt, expiresAt: value.expiresAt, reason: value.reason,
  });
}

function validateGrantScope(scope: GrantScope): GrantScope {
  if (!scope || (scope.kind !== 'persistent' && scope.kind !== 'run')) throw new PermissionError('INVALID_GRANT', '授权范围无效。');
  if (scope.kind === 'run') { validId(scope.runId); validGeneration(scope.generation); if (scope.attemptId !== undefined) validId(scope.attemptId); }
  return scope.kind === 'persistent' ? { kind: 'persistent' } : {
    kind: 'run', runId: scope.runId, generation: scope.generation,
    ...scope.attemptId === undefined ? {} : { attemptId: scope.attemptId },
  };
}

function validId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) throw new PermissionError('INVALID_OPERATION', '运行或动作标识无效。');
}
function validGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PermissionError('INVALID_OPERATION', '运行代次无效。');
}
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function readJson<T>(value: unknown): T {
  try { return JSON.parse(String(value)) as T; } catch { throw new PermissionError('INVALID_STORAGE', '权限记录无法读取。'); }
}
function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) return JSON.stringify(input);
    if (!input || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && !Array.isArray(input)) || active.has(input)) {
      throw new PermissionError('INVALID_ARGUMENTS', '动作参数必须是无循环且可完整保存的 JSON 值。');
    }
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index))) {
          throw new PermissionError('INVALID_ARGUMENTS', '动作参数不能包含稀疏数组或附加字段。');
        }
        return `[${input.map(visit).join(',')}]`;
      }
      if (Reflect.ownKeys(input).some((key) => typeof key !== 'string')) throw new PermissionError('INVALID_ARGUMENTS', '动作参数不能包含符号字段。');
      return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${visit((input as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally { active.delete(input); }
  };
  return visit(value);
}

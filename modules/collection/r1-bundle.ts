import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { WFD_BUNDLE_FORMAT, WFD_BUNDLE_OPERATIONS, type WfdBundleOperation, type WfdBundleReceipt,
  isWfdBundleProducts, type WfdProductMachineTransport } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { CoreError } from '../../platform/runtime/errors.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { R1Runtime } from './r1-runtime.js';

export const R1_BUNDLE_VERSION = 'bd.r1-bundle/1';
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const snapshot = /^s_[a-f0-9]{24}$/u;
const sha = /^sha256:[a-f0-9]{64}$/u;
const packageName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
type BundleRuntime = Pick<R1Runtime, 'currentIdentity'> & {
  connection: Pick<R1Runtime['connection'], 'client' | 'configPath' | 'connectionId' | 'callerId' | 'trustedActorNamespace'>;
};
interface Options {
  runtime: BundleRuntime;
  database: CoreDatabase;
  control(): { stopped: boolean; generation: number };
}
function invalid(): never { throw new CoreError('R1_BUNDLE_INPUT', '分包请求须提供固定身份以及该操作声明的字段。', 400); }
function object(value: unknown, allowed: string[]) {
  if (!isWfdRecord(value) || Object.keys(value).some(k => !allowed.includes(k))) return invalid();
  return value;
}
function token(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid();
  return value;
}
function inputFor(operation: WfdBundleOperation, value: unknown) {
  const importing = WFD_BUNDLE_OPERATIONS[operation].write;
  const b = object(value, ['requestId', 'packageName', ...(importing ? ['descriptorSha256'] : ['snapshotId', 'products']),
    ...(operation === 'bundle_export_delta' ? ['baselineSnapshotId'] : [])]);
  const base = { requestId: token(b.requestId, id), packageName: token(b.packageName, packageName) };
  if (importing) return { ...base, kind: 'import' as const, descriptorSha256: token(b.descriptorSha256, sha) };
  if (!isWfdBundleProducts(b.products)) return invalid();
  const products = structuredClone(b.products);
  return { ...base, kind: 'export' as const, snapshotId: token(b.snapshotId, snapshot), products,
    ...(operation === 'bundle_export_delta' ? { baselineSnapshotId: token(b.baselineSnapshotId, snapshot) } : {}) };
}

type Reply = { requestId: string; operation: WfdBundleOperation; version: string; receipt: WfdBundleReceipt };

/** Synchronous host admission, durable RequestId binding, one real WFD dispatch per in-flight request. */
export class R1BundleService {
  readonly versionBinding = { r1Bundle: R1_BUNDLE_VERSION, protocol: WFD_BUNDLE_FORMAT } as const;
  private readonly binding: string;
  private readonly pending = new Map<string, Promise<Reply>>();

  constructor(private readonly options: Options) {
    this.binding = this.currentBinding();
    options.database.migrate('r1-bundle', 1, `CREATE TABLE r1_bundle_requests (
      request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, binding TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, receipt_json TEXT, error_code TEXT)`);
  }

  private currentBinding() {
    const identity = this.options.runtime.currentIdentity();
    if (identity.profile !== 'data_only') throw new CoreError('R1_PROFILE_REQUIRED', '独立小库需要 data_only 连接。');
    return wfdSha256(canonicalWfdJson([this.versionBinding, identity]));
  }

  private check(generation?: number) {
    const control = this.options.control();
    if (control.stopped || (generation !== undefined && generation !== control.generation))
      throw new CoreError('BD_STOPPED', '分包调度已停止或运行代次已变化。');
    if (this.currentBinding() !== this.binding) throw new CoreError('R1_CONNECTION_BINDING_CHANGED', '分包连接身份或配置摘要已变化。');
    return control.generation;
  }

  private verifyTransport(transport: WfdProductMachineTransport, generation: number) {
    this.check(generation);
    const c = this.options.runtime.connection;
    if (transport.connectionId !== c.connectionId || transport.callerId !== c.callerId
      || transport.trustedActorNamespace !== c.trustedActorNamespace)
      throw new CoreError('R1_CONNECTION_BINDING_CHANGED', 'WFD 分包回执与已登记的连接或调用者身份不一致。');
  }

  async capabilities() {
    const generation = this.check();
    const reply = await this.options.runtime.connection.client.bundleCapabilities();
    this.verifyTransport(reply.transport, generation);
    return { ...this.versionBinding, ...reply.result };
  }

  private row(requestId: string) {
    return this.options.database.connection.prepare('SELECT * FROM r1_bundle_requests WHERE request_id=?').get(requestId);
  }

  requestStatus(requestId: string) {
    this.check();
    const row = this.row(token(requestId, id));
    if (!row || row.binding !== this.binding) throw new CoreError('R1_BUNDLE_REQUEST_NOT_FOUND', '当前连接没有该分包请求。', 404);
    return { requestId, operation: row.operation, state: row.state, errorCode: row.error_code, version: R1_BUNDLE_VERSION,
      receipt: row.receipt_json ? JSON.parse(String(row.receipt_json)) as WfdBundleReceipt : null };
  }

  dispatch(operation: WfdBundleOperation, value: unknown): Promise<Reply> {
    if (!Object.hasOwn(WFD_BUNDLE_OPERATIONS, operation)) return invalid();
    const input = inputFor(operation, value);
    const { requestId } = input, generation = this.check();
    const fingerprint = wfdSha256(canonicalWfdJson([operation, input]));
    const db = this.options.database.connection;
    const cached = this.options.database.transaction(() => {
      const row = this.row(requestId);
      if (row && (row.binding !== this.binding || row.fingerprint !== fingerprint))
        throw new CoreError('R1_BUNDLE_REQUEST_CONFLICT', '原分包请求编号已绑定其他内容或连接。');
      if (row?.receipt_json) return JSON.parse(String(row.receipt_json)) as WfdBundleReceipt;
      db.prepare(`INSERT INTO r1_bundle_requests(request_id,operation,binding,fingerprint,state)
        VALUES(?,?,?,?,'dispatching') ON CONFLICT(request_id) DO UPDATE SET state='dispatching',error_code=NULL`)
        .run(requestId, operation, this.binding, fingerprint);
      return null;
    });
    const base = { requestId, operation, version: R1_BUNDLE_VERSION };
    if (cached) return Promise.resolve({ ...base, receipt: cached });
    const inflight = this.pending.get(requestId);
    if (inflight) return inflight;
    let received = false;
    const call = this.execute(operation, input).then(reply => {
      received = true;
      this.verifyTransport(reply.transport, generation);
      db.prepare(`UPDATE r1_bundle_requests SET receipt_json=COALESCE(receipt_json,?),state='succeeded',error_code=NULL
        WHERE request_id=?`).run(JSON.stringify(reply.result), requestId);
      return { ...base, receipt: JSON.parse(String(this.row(requestId)!.receipt_json)) as WfdBundleReceipt };
    }).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'R1_BUNDLE_DISPATCH_FAILED';
      const unknown = received || code === 'PROCESS_OUTPUT_FAILED' || (error instanceof Error && 'mayHaveBeenAccepted' in error && error.mayHaveBeenAccepted)
        || code === 'BD_STOPPED' || code === 'R1_CONNECTION_BINDING_CHANGED';
      db.prepare('UPDATE r1_bundle_requests SET state=?,error_code=? WHERE request_id=? AND receipt_json IS NULL')
        .run(unknown ? 'outcome_unknown' : 'failed', code, requestId);
      throw error;
    }).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, call);
    return call;
  }

  private async execute(operation: WfdBundleOperation, input: ReturnType<typeof inputFor>) {
    const runtime = this.options.runtime, client = runtime.connection.client;
    const raw = readFileSync(runtime.connection.configPath);
    if (wfdSha256(raw) !== runtime.currentIdentity().configSha256)
      throw new CoreError('R1_CONNECTION_BINDING_CHANGED', '读取分包目录时配置身份已变化。');
    const root: unknown = JSON.parse(raw.toString('utf8')).bundle_access?.package_root;
    if (typeof root !== 'string' || !isAbsolute(root) || normalize(root) !== root || realpathSync(root) !== root
      || !lstatSync(root).isDirectory()) throw new CoreError('R1_BUNDLE_ROOT_UNAVAILABLE', '尚未登记可用的规范分包目录。');
    const package_path = join(root, input.packageName);
    const entry = lstatSync(package_path, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new CoreError('BUNDLE_PATH_INVALID', '分包位置必须是受控目录。', 400);
    if (input.kind === 'import') {
      const args = { package_path, descriptor_sha256: input.descriptorSha256 };
      if (operation === 'bundle_import_full') return client.bundleImportFull(args, undefined, input.requestId);
      if (operation === 'bundle_apply_delta') return client.bundleApplyDelta(args, undefined, input.requestId);
      if (operation === 'bundle_register_reference') return client.bundleRegisterReference(args, undefined, input.requestId);
      return invalid();
    }
    const args = { package_path, snapshot_id: input.snapshotId, products: input.products };
    if (operation === 'bundle_export_full') return client.bundleExportFull(args, undefined, input.requestId);
    if (operation === 'bundle_export_delta') return client.bundleExportDelta({ ...args, baseline_snapshot_id: input.baselineSnapshotId! }, undefined, input.requestId);
    if (operation === 'bundle_export_reference') return client.bundleExportReference(args, undefined, input.requestId);
    return invalid();
  }
}

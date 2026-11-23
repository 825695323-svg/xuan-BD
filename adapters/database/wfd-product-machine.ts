import { R1_CONTEXT_OPERATIONS, type R1ContextOperation } from '../../contracts/r1-contracts.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DataServiceError } from './wfd-error.js';
import { isWfdRecord, wfdSha256, type WfdRecord } from './wfd-transport.js';
import type { TabularBatchChunk, TabularBatchHeader, TabularCell, TabularReadPage } from '../../contracts/tabular-batch.js';
import type { SourceMinuteBatchChunk, SourceMinuteBatchHeader, SourceMinuteCell, SourceMinuteReadPage } from '../../contracts/source-minute-batch.js';

/**
 * 公开本地结构化进程边界：WFD `wfd.product-machine/0.1`。
 *
 * 本适配只启动当前 WFD
 * 产品开发目录中的 `wfd_sdk/product_machine.py`，通过 stdin/stdout 传一个有界 JSON
 * 请求；不连接旧 `/v3/data-entry`，不借用旧六列或 user_test 线路，不直接读取
 * WFD 私有 catalog。store/runtime、调用者命名空间、角色、来源许可和单位只来自
 * 受控配置文件，请求参数不能自称权限。
 *
 * 本批接入 canonical 入口的 capabilities/schema、固定读取、submit/recovery、
 * evidence_ingest、request_status、read_product 分页与 batch_*。入口仍决定权限、
 * 来源角色/权威和合同；独立小库仅走显式 bundle_* 操作。通用 packages/export
 * 等未支持操作由入口明确返回 `OPERATION_UNSUPPORTED`，不伪造异步 job。
 */
export const WFD_PRODUCT_MACHINE_PROTOCOL = 'wfd.product-machine/0.1';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_STDERR_BYTES = 16_384;
export const WFD_BUNDLE_OPERATIONS = {
  bundle_export_full: { mode: 'full', writesDatabase: false, hasSideEffect: true, statuses: ['exported', 'already_exported'] },
  bundle_import_full: { mode: 'full', writesDatabase: true, hasSideEffect: true, statuses: ['imported_structured_readable', 'already_imported'] },
  bundle_export_delta: { mode: 'delta', writesDatabase: false, hasSideEffect: true, statuses: ['exported', 'already_exported'] },
  bundle_apply_delta: { mode: 'delta', writesDatabase: true, hasSideEffect: true, statuses: ['applied', 'already_applied'] },
  bundle_export_reference: { mode: 'reference', writesDatabase: false, hasSideEffect: true, statuses: ['exported', 'already_exported'] },
  bundle_register_reference: { mode: 'reference', writesDatabase: true, hasSideEffect: true, statuses: ['registered_reference_readable',
    'registered_reference_unavailable', 'reference_already_registered'] },
} as const;
export type WfdBundleOperation = keyof typeof WFD_BUNDLE_OPERATIONS;
export const WFD_BUNDLE_FORMAT = 'wfd.structured-bundle/1.0';

export function bundleHostPath(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f-\x9f]/u.test(value)) return null;
  if (sep === '\\') {
    if (!/^[A-Za-z]:[\\/]/u.test(value) || value.split(/[\\/]/u).includes('..')) return null;
  } else if (value.startsWith('//') || value.includes('\\') || value.split('/').includes('..')) return null;
  return resolve(value);
}
export interface WfdBundleProduct {
  product_id: string;
  fields?: string[];
  subject?: { kind: string; namespace: string; id: string };
  business_time_range?: { role: 'observation'; start: string; end: string; timezone: string };
}
const onlyKeys = (value: WfdRecord, allowed: string[]): boolean => Object.keys(value).every(k => allowed.includes(k));
const bundleIdPart = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID.test(v);
export function isWfdBundleProducts(value: unknown): value is WfdBundleProduct[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) return false;
  const unique = new Set<string>();
  for (const p of value) {
    if (!isWfdRecord(p) || !onlyKeys(p, ['product_id', 'fields', 'subject', 'business_time_range'])
      || !bundleIdPart(p.product_id) || unique.has(p.product_id)) return false;
    unique.add(p.product_id);
    if (p.fields !== undefined && (!Array.isArray(p.fields) || !p.fields.length || p.fields.length > 256
      || new Set(p.fields).size !== p.fields.length || !p.fields.every(bundleIdPart))) return false;
    const s = p.subject, t = p.business_time_range;
    if (s !== undefined && (!isWfdRecord(s) || !onlyKeys(s, ['kind', 'namespace', 'id'])
      || ![s.kind, s.namespace, s.id].every(bundleIdPart))) return false;
    if (t !== undefined && (!isWfdRecord(t) || !onlyKeys(t, ['role', 'start', 'end', 'timezone'])
      || t.role !== 'observation' || !bundleIdPart(t.start) || !bundleIdPart(t.end)
      || typeof t.timezone !== 'string' || !t.timezone || t.timezone.length > 128)) return false;
  }
  return true;
}
export interface WfdBundleExport { package_path: string; snapshot_id: string; products: WfdBundleProduct[] }
export interface WfdBundleDeltaExport extends WfdBundleExport { baseline_snapshot_id: string }
export interface WfdBundleImport { package_path: string; descriptor_sha256: string }
export interface WfdBundleReceipt {
  format_version: typeof WFD_BUNDLE_FORMAT; mode: 'full' | 'delta' | 'reference';
  status: (typeof WFD_BUNDLE_OPERATIONS)[WfdBundleOperation]['statuses'][number]; bundle_id: string; descriptor_sha256: string; source_snapshot_id: string;
  source_dataset_id: string; baseline_snapshot_id: string | null; target_snapshot_id: string | null;
  read_self_contained: boolean; source_permission_required: boolean; write_authority_granted: false;
  products: Array<{ product_id: string; source_product_id: string; row_count: number; rows_sha256: string }>;
  readable?: boolean; instance_id?: string | null; active_head?: null;
  dependency_gaps?: Array<{ product_id: string; reason: string }>;
}
export interface WfdBundleCapabilities {
  format_version: typeof WFD_BUNDLE_FORMAT; profile: 'wfd.data-only/1.0'; max_products: number;
  write_tracking?: boolean;
  operations: Record<WfdBundleOperation, { supported: boolean; writes_target: boolean; reason: string | null }>;
}
const bundleOperations = Object.entries(WFD_BUNDLE_OPERATIONS);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const fixedSnapshot = (value: unknown): value is string => typeof value === 'string' && /^s_[a-f0-9]{24}$/u.test(value);
function matchingBundleProofs(value: unknown, selected?: WfdBundleProduct[]): boolean {
  if (!Array.isArray(value) || !value.length || value.length > 64) return false;
  const sources = new Set<string>(), targets = new Set<string>();
  for (const item of value) {
    if (!isWfdRecord(item) || !bundleIdPart(item.product_id) || !bundleIdPart(item.source_product_id)
      || !Number.isSafeInteger(item.row_count) || Number(item.row_count) < 0 || !digest(item.rows_sha256)) return false;
    sources.add(item.source_product_id);
    targets.add(item.product_id);
  }
  return sources.size === value.length && targets.size === value.length
    && (!selected || (selected.length === value.length && selected.every(p => sources.has(p.product_id))));
}

function referenceStatusValid(receipt: WfdRecord): boolean {
  const gaps = receipt.dependency_gaps;
  return typeof receipt.readable === 'boolean' && Array.isArray(gaps) && gaps.length <= 64
    && receipt.readable === (gaps.length === 0)
    && gaps.every(gap => isWfdRecord(gap) && bundleIdPart(gap.product_id) && bundleIdPart(gap.reason));
}

const WRITE_OPERATIONS = new Set(['submit', 'recovery', 'evidence_ingest', 'batch_begin', 'batch_put_chunk', 'batch_finalize']);

/**
 * 计时侧信道：仅在设置 BD_WFD_TIMING_LOG 时逐次追加 JSONL，不改请求/回执形状。
 * 用于把一次提交拆成序列化、进程启动、传输、WFD 内部（机器自报 elapsed_ms）与读回。
 */
export interface WfdTimingEntry {
  at: number; operation: string; requestId: string; write: boolean; ok: boolean;
  requestBytes: number; responseBytes: number; serializeMs: number; spawnMs: number;
  stdinMs: number; waitMs: number; totalMs: number; machineElapsedMs: number | null;
}
function recordTiming(entry: WfdTimingEntry): void {
  const target = process.env.BD_WFD_TIMING_LOG;
  if (!target) return;
  try { appendFileSync(target, JSON.stringify(entry) + '\n'); } catch { /* 计时不得影响主流程 */ }
}

export interface WfdProductMachineConfiguration {
  /** 已安装 duckdb/jsonschema/thrift 依赖的 Python 解释器绝对路径。 */
  pythonPath: string;
  /** 薄入口脚本绝对路径；staging 或正式 wfd_sdk/product_machine.py 均可。 */
  entryPath: string;
  /** 受控连接配置绝对路径；权限、来源、store/runtime 只从这里来。 */
  configPath: string;
  /** WFD 产品开发根，用于 `python` 导入 wfd_sdk 包。 */
  projectRoot: string;
  /** 单次进程等待上限；默认 180 秒。 */
  timeoutMs?: number;
  /** stdout 响应上限；默认 32 MiB。 */
  maxResponseBytes?: number;
  /** stdin 请求上限；默认 1 MiB。 */
  maxRequestBytes?: number;
  /** 可选：调用方同一次读取已计算的受控配置 SHA-256，避免构造期间二次读盘。 */
  configSha256?: string;
}

export interface WfdProductMachineTransport {
  requestId: string;
  operation: string;
  elapsedMs: number | null;
  responseBytes: number;
  serviceVersion: string | null;
  contractVersion: string | null;
  schemaId: string | null;
  connectionId: string | null;
  callerId: string | null;
  trustedActorNamespace: string | null;
}

export interface WfdProductMachineReply {
  result: WfdRecord;
  response: WfdRecord;
  transport: WfdProductMachineTransport;
}

/** A local alias is only a plan reference; products/fields resolve in the pinned snapshot. */
export interface WfdFilterSubject { kind: 'entity' | 'instrument' | 'listing' | 'region'; namespace: string; id: string }
export interface WfdFilterConstant { data_type: 'decimal'; value: string; unit_code: string }
export type WfdFilterOperator = '=' | '>=' | '<=' | '>' | '<';
export type WfdFilterPredicate =
  | { compare: { metric: string; op: WfdFilterOperator; value: WfdFilterConstant } }
  | { between: { metric: string; low: WfdFilterConstant; high: WfdFilterConstant; include_low: boolean; include_high: boolean } }
  | { in: { metric: string; values: WfdFilterConstant[] } }
  | { compare_metrics: { left: string; right: string; op: WfdFilterOperator } }
  | { and: WfdFilterPredicate[] } | { or: WfdFilterPredicate[] } | { not: WfdFilterPredicate };
export interface WfdFilterPlan {
  protocol_version: 'wfd.filter-objects/1.4-product1'; operation: 'filter_objects';
  dataset_id: string; snapshot_id: string;
  history_mode: 'snapshot_contents' | 'market_known_at' | 'system_held_at';
  knowledge_cutoff: WfdRecord | null; held_scope: string | null; usable_stage: 'acquired' | 'custodied' | 'published_readable' | null;
  universe: { kind: 'explicit_subjects'; subjects: WfdFilterSubject[] };
  metrics: Array<{ metric: string; field: string; bindings: Array<{ subject: WfdFilterSubject; product_id: string }> }>;
  business_time_range: { role: string; start: string; end: string; timezone: string } | null;
  predicate: WfdFilterPredicate;
  order_by: Array<{ kind: 'subject'; direction: 'asc' | 'desc' }
    | { kind: 'metric'; metric: string; direction: 'asc' | 'desc'; nulls: 'first' | 'last' }>;
  page_size: number; max_scan_bytes: number; max_nodes: number; cursor?: string | null;
  /** Digest of a host-owned joint document/index context, when composed by BD. */
  context_digest?: string;
}

export interface WfdProductMachineReadOptions {
  snapshotId: string;
  productId?: string;
  perspective?: 'snapshot_contents' | 'market_known_at' | 'system_held_at';
  at?: string;
  heldScope?: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable';
  subject?: string;
  includeHistory?: boolean;
  rowProjection?: 'full' | 'compact';
}

/** Additive, fixed snapshot_contents selection; never a truncated fixed_read. */
export interface WfdProductMachineReadPageOptions {
  snapshotId: string;
  productId: string;
  recordRefs: Array<{ record_id: string; record_version: string }>;
  pageSize?: number;
  maxPageBytes?: number;
  cursor?: string | null;
}

/** Whole current nonwithdrawn product leaves; not an enlarged R1 selected-ref request. */
export interface WfdProductMachineReadProductPageOptions {
  snapshotId: string;
  productId: string;
  pageSize?: number;
  maxPageBytes?: number;
  cursor?: string | null;
}

export interface WfdProductMachineErrorOptions {
  operation: string;
  requestId: string;
  remoteCode?: string | null;
  action?: string | null;
  identity?: WfdRecord | null;
  service?: WfdRecord | null;
  cause?: unknown;
  /** 请求已写入子进程后，未知结果可能已在 WFD 写入；调用方必须沿原 identity 查询。 */
  mayHaveBeenAccepted?: boolean;
}

export class WfdProductMachineError extends DataServiceError {
  declare readonly operation: string;
  declare readonly requestId: string;
  declare readonly remoteCode: string | null;
  declare readonly action: string | null;
  declare readonly identity: WfdRecord | null;
  declare readonly service: WfdRecord | null;

  constructor(code: string, message: string, options: WfdProductMachineErrorOptions) {
    super(code, message, { mayHaveBeenAccepted: options.mayHaveBeenAccepted === true });
    this.name = 'WfdProductMachineError';
    this.operation = options.operation;
    this.requestId = options.requestId;
    this.remoteCode = options.remoteCode ?? null;
    this.action = options.action ?? null;
    this.identity = options.identity ?? null;
    this.service = options.service ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const fail = (code: string, message: string, options: WfdProductMachineErrorOptions): never => {
  throw new WfdProductMachineError(code, message, options);
};

export class WfdProductMachineClient {
  private readonly config: Required<Pick<WfdProductMachineConfiguration, 'pythonPath' | 'entryPath' | 'configPath'
    | 'projectRoot' | 'timeoutMs' | 'maxResponseBytes' | 'maxRequestBytes'>>;

  private readonly bundleConfigDigest: string;

  filterObjects(plan: WfdFilterPlan, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('filter_objects', plan as unknown as WfdRecord, signal);
  }

  constructor(configuration: WfdProductMachineConfiguration) {
    const config = {
      pythonPath: configuration.pythonPath,
      entryPath: configuration.entryPath,
      configPath: configuration.configPath,
      projectRoot: configuration.projectRoot,
      timeoutMs: configuration.timeoutMs ?? 180_000,
      maxResponseBytes: configuration.maxResponseBytes ?? 33_554_432,
      maxRequestBytes: configuration.maxRequestBytes ?? 1_048_576,
    };
    if (!isAbsolute(config.pythonPath) || !isAbsolute(config.entryPath) || !isAbsolute(config.configPath)
      || !isAbsolute(config.projectRoot)) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', '薄入口需要绝对 Python、入口、配置和 WFD 工程根路径。', {
        operation: 'config', requestId: 'config',
      });
    }
    for (const [label, path] of [['python', config.pythonPath], ['entry', config.entryPath], ['config', config.configPath]] as const) {
      let real: string;
      try {
        real = realpathSync(path);
        if (!statSync(real).isFile()) throw new Error('not a regular file');
      } catch (error) {
        throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', `薄入口${label}不是可读普通文件：${path}`, {
          operation: 'config', requestId: 'config', cause: error,
        });
      }
      // venv 的 python 通常是指向基础解释器的符号链接；保留原路径才能使用 venv 依赖。
      if (label !== 'python' && relative(real, resolve(path)) !== '') {
        throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', `薄入口${label}包含符号链接或非规范路径：${path}`, {
          operation: 'config', requestId: 'config',
        });
      }
    }
    let root: string;
    try {
      root = realpathSync(config.projectRoot);
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', `WFD 工程根不可用：${config.projectRoot}`, {
        operation: 'config', requestId: 'config', cause: error,
      });
    }
    if (relative(root, resolve(config.projectRoot)) !== '') {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', 'WFD 工程根包含符号链接或非规范路径。', {
        operation: 'config', requestId: 'config',
      });
    }
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 900_000) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', '薄入口等待上限须在 1–900 秒。', {
        operation: 'config', requestId: 'config',
      });
    }
    if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 65_536 || config.maxResponseBytes > 67_108_864) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', '薄入口响应上限须在 64 KiB–64 MiB。', {
        operation: 'config', requestId: 'config',
      });
    }
    if (!Number.isSafeInteger(config.maxRequestBytes) || config.maxRequestBytes < 1_024 || config.maxRequestBytes > 8_388_608) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_CONFIG', '薄入口请求上限须在 1 KiB–8 MiB。', {
        operation: 'config', requestId: 'config',
      });
    }
    this.config = config;
    const pinnedSha = typeof configuration.configSha256 === 'string' && /^[a-f0-9]{64}$/u.test(configuration.configSha256)
      ? configuration.configSha256 : wfdSha256(readFileSync(config.configPath));
    this.bundleConfigDigest = 'sha256:' + pinnedSha;
  }

  async capabilities(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    const reply = await this.request('capabilities', {}, signal);
    if (reply.result.bundle_write_tracking !== true && isWfdRecord(reply.result.operations)) {
      const ops = reply.result.operations as WfdRecord;
      for (const [name] of bundleOperations) {
        if (isWfdRecord(ops[name])) ops[name] = { ...ops[name], supported: false, reason: 'OPERATION_UNSUPPORTED' };
      }
    }
    return reply;
  }

  async bundleCapabilities(signal?: AbortSignal) {
    const reply = await this.request('bundle_capabilities', {}, signal);
    const caps = reply.result;
    if (caps.format_version !== WFD_BUNDLE_FORMAT || caps.profile !== 'wfd.data-only/1.0'
      || caps.max_products !== 64 || !isWfdRecord(caps.operations)
      || !bundleOperations.every(([name, spec]) => {
        const item = (caps.operations as WfdRecord)[name];
        return isWfdRecord(item) && typeof item.supported === 'boolean' && item.writes_target === spec.writesDatabase
          && (item.supported ? item.reason === null : typeof item.reason === 'string');
      })) throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '分包能力声明不完整。', reply.transport);
    if (caps.write_tracking !== true) {
      const ops = caps.operations as WfdRecord;
      for (const [name] of bundleOperations) {
        ops[name] = { ...(ops[name] as WfdRecord), supported: false, reason: 'OPERATION_UNSUPPORTED' };
      }
    }
    return { ...reply, result: caps as unknown as WfdBundleCapabilities };
  }

  bundleExportFull(input: WfdBundleExport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_export_full', input, signal, requestId);
  }
  bundleImportFull(input: WfdBundleImport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_import_full', input, signal, requestId);
  }
  bundleExportDelta(input: WfdBundleDeltaExport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_export_delta', input, signal, requestId);
  }
  bundleApplyDelta(input: WfdBundleImport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_apply_delta', input, signal, requestId);
  }
  bundleExportReference(input: WfdBundleExport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_export_reference', input, signal, requestId);
  }
  bundleRegisterReference(input: WfdBundleImport, signal?: AbortSignal, requestId?: string) {
    return this.bundle('bundle_register_reference', input, signal, requestId);
  }

  private async bundle(operation: WfdBundleOperation, input: WfdBundleExport | WfdBundleImport, signal?: AbortSignal, requestId?: string) {
    const spec = WFD_BUNDLE_OPERATIONS[operation], args: unknown = input;
    const allowed = spec.writesDatabase ? ['package_path', 'descriptor_sha256'] : ['package_path', 'snapshot_id', 'products'];
    if (operation === 'bundle_export_delta') allowed.push('baseline_snapshot_id');
    if (!isWfdRecord(args) || !onlyKeys(args, allowed)
      || (spec.writesDatabase ? !digest(args.descriptor_sha256) : !fixedSnapshot(args.snapshot_id) || !isWfdBundleProducts(args.products))
      || (operation === 'bundle_export_delta' && !fixedSnapshot(args.baseline_snapshot_id))) {
      return fail('WFD_PRODUCT_MACHINE_REQUEST', '分包参数须与显式操作及固定选择相符。', { operation, requestId: 'request' });
    }
    const packagePath = bundleHostPath(args.package_path);
    if (!packagePath)
      return fail('BUNDLE_PATH_INVALID', '分包操作需要规范绝对路径。', { operation, requestId: 'request' });
    const reply = await this.request(operation, { ...args, package_path: packagePath }, signal, requestId);
    const r = reply.result;
    const reference = spec.mode === 'reference';
    if (r.format_version !== WFD_BUNDLE_FORMAT || r.mode !== spec.mode
      || !(spec.statuses as readonly string[]).includes(String(r.status))
      || typeof r.bundle_id !== 'string' || !/^(sb|sd|sr)_[a-f0-9]{24}$/u.test(r.bundle_id)
      || !r.bundle_id.startsWith({ full: 'sb_', delta: 'sd_', reference: 'sr_' }[spec.mode])
      || !digest(r.descriptor_sha256) || !fixedSnapshot(r.source_snapshot_id)
      || (reference ? r.target_snapshot_id !== null : !fixedSnapshot(r.target_snapshot_id))
      || !bundleIdPart(r.source_dataset_id) || r.source_permission_required !== reference
      || (operation === 'bundle_import_full' && !bundleIdPart(r.instance_id))
      || (operation === 'bundle_apply_delta' && !(bundleIdPart(r.instance_id) || (r.status === 'already_applied' && r.instance_id === null)))
      || (spec.mode === 'delta' ? !fixedSnapshot(r.baseline_snapshot_id) : r.baseline_snapshot_id !== null)
      || (operation === 'bundle_export_delta' && r.baseline_snapshot_id !== args.baseline_snapshot_id)
      || r.write_authority_granted !== false || r.read_self_contained !== !reference
      || (spec.writesDatabase && r.active_head !== null)
      || ('snapshot_id' in input && r.source_snapshot_id !== input.snapshot_id)
      || ('descriptor_sha256' in input && r.descriptor_sha256 !== input.descriptor_sha256)
      || (operation === 'bundle_register_reference' && !referenceStatusValid(r))
      || !matchingBundleProofs(r.products, 'products' in input ? input.products : undefined)) {
      throw new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '独立小库回执的身份、范围或读回摘要无效。',
        { ...reply.transport, mayHaveBeenAccepted: spec.hasSideEffect });
    }
    return { ...reply, result: r as unknown as WfdBundleReceipt };
  }

  reviewDefinition(intent: import('../../contracts/r1-contracts.js').R1DefinitionIntent, signal?: AbortSignal) {
    return this.request('review_definition', { snapshot_id: intent.snapshotId, dataset_id: intent.datasetId,
      subject: intent.subject, semantic_code: intent.semanticCode, field_codes: intent.fieldCodes }, signal);
  }

  snapshotStatus(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('snapshot_status', {}, signal);
  }

  discover(snapshotId: string, subject?: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (typeof snapshotId !== 'string' || !snapshotId) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'contract_discovery 需要明确固定 snapshot_id。', {
        operation: 'contract_discovery', requestId: 'request',
      }));
    }
    return this.request('contract_discovery', { snapshot_id: snapshotId, ...(subject ? { subject } : {}) }, signal);
  }

  read(options: WfdProductMachineReadOptions, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!options || typeof options.snapshotId !== 'string' || !options.snapshotId) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'fixed_read 需要明确固定 snapshot_id。', {
        operation: 'fixed_read', requestId: 'request',
      }));
    }
    return this.request('fixed_read', {
      snapshot_id: options.snapshotId,
      ...(options.productId ? { product_id: options.productId } : {}),
      ...(options.perspective ? { perspective: options.perspective } : {}),
      ...(options.at ? { at: options.at } : {}),
      ...(options.heldScope ? { held_scope: options.heldScope } : {}),
      ...(options.usableStage ? { usable_stage: options.usableStage } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.includeHistory !== undefined ? { include_history: options.includeHistory } : {}),
      ...(options.rowProjection ? { row_projection: options.rowProjection } : {}),
    }, signal);
  }

  readPage(options: WfdProductMachineReadPageOptions, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (typeof options.snapshotId !== 'string' || !options.snapshotId || /^(latest|current)$/iu.test(options.snapshotId)
      || typeof options.productId !== 'string' || !options.productId || !Array.isArray(options.recordRefs)
      || options.recordRefs.length < 1 || options.recordRefs.length > 5000) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', '固定页需要准确快照、产品与 1–5000 个实际行版本。', {
        operation: 'fixed_read_page', requestId: 'request',
      }));
    }
    return this.request('fixed_read_page', { snapshot_id: options.snapshotId, product_id: options.productId,
      record_refs: options.recordRefs,
      ...(options.pageSize !== undefined ? { page_size: options.pageSize } : {}),
      ...(options.maxPageBytes !== undefined ? { max_page_bytes: options.maxPageBytes } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    }, signal);
  }

  /** One bounded full-product page; no automatic retry, selected-ref or full-read fallback. */
  readProductPage(options: WfdProductMachineReadProductPageOptions, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    const keys = new Set(['snapshotId', 'productId', 'pageSize', 'maxPageBytes', 'cursor']);
    if (!isWfdRecord(options) || Object.keys(options).some(key => !keys.has(key))
      || typeof options.snapshotId !== 'string' || !/^s_[0-9a-f]{24}$/u.test(options.snapshotId)
      || typeof options.productId !== 'string' || !/^p_[0-9a-f]{24}$/u.test(options.productId)
      || (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000))
      || (options.maxPageBytes !== undefined && (!Number.isSafeInteger(options.maxPageBytes) || options.maxPageBytes < 1 || options.maxPageBytes > 4_194_304))
      || (options.cursor !== undefined && options.cursor !== null && (typeof options.cursor !== 'string' || !options.cursor))) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', '整产品固定页需要准确快照/产品、1–1000 行及1 字节–4 MiB的完整结果预算；不能携带选行、历史或调用者权限参数。', {
        operation: 'fixed_read_product_page', requestId: 'request',
      }));
    }
    return this.request('fixed_read_product_page', { snapshot_id: options.snapshotId, product_id: options.productId,
      ...(options.pageSize !== undefined ? { page_size: options.pageSize } : {}),
      ...(options.maxPageBytes !== undefined ? { max_page_bytes: options.maxPageBytes } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    }, signal);
  }

  requestStatus(requestIdentity: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('request_status', { request_identity: requestIdentity }, signal);
  }

  requestStatusPage(requestIdentity: WfdRecord, options: { outputOffset?: number; outputLimit?: number;
    outputDetail?: 'summary' | 'full'; rowOffset?: number; rowLimit?: number } = {}, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('request_status', {
      request_identity: requestIdentity,
      ...(options.outputOffset !== undefined ? { output_offset: options.outputOffset } : {}),
      ...(options.outputLimit !== undefined ? { output_limit: options.outputLimit } : {}),
      ...(options.outputDetail !== undefined ? { output_detail: options.outputDetail } : {}),
      ...(options.rowOffset !== undefined ? { row_offset: options.rowOffset } : {}),
      ...(options.rowLimit !== undefined ? { row_limit: options.rowLimit } : {}),
    }, signal);
  }

  trace(productId: string, snapshotId: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('trace', { product_id: productId, snapshot_id: snapshotId }, signal);
  }

  serviceCapabilities(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('service_capabilities', {}, signal);
  }

  schema(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('schema', {}, signal);
  }

  submit(document: WfdRecord, signal?: AbortSignal, expectedCommitId?: string): Promise<WfdProductMachineReply> {
    if (!isWfdRecord(document)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'submit 需要完整文档对象。', {
        operation: 'submit', requestId: 'request',
      }));
    }
    return this.request('submit', { document, ...(expectedCommitId !== undefined ? { expected_commit_id: expectedCommitId } : {}) }, signal);
  }

  recovery(document: WfdRecord, signal?: AbortSignal, expectedCommitId?: string): Promise<WfdProductMachineReply> {
    if (!isWfdRecord(document)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'recovery 需要原文档对象。', {
        operation: 'recovery', requestId: 'request',
      }));
    }
    return this.request('recovery', { document, ...(expectedCommitId !== undefined ? { expected_commit_id: expectedCommitId } : {}) }, signal);
  }

  evidenceIngest(content: Uint8Array, originalName?: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!(content instanceof Uint8Array) || content.byteLength === 0) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'evidence_ingest 需要非空内容字节。', {
        operation: 'evidence_ingest', requestId: 'request',
      }));
    }
    return this.request('evidence_ingest', {
      content_base64: Buffer.from(content).toString('base64'),
      ...(originalName ? { original_name: originalName } : {}),
    }, signal);
  }

  readContext(operation: R1ContextOperation, request: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!R1_CONTEXT_OPERATIONS.includes(operation) || !isWfdRecord(request) || request.operation !== operation
      || request.protocol_version !== 'wfd.read/1.3-product1b'
      || !(request.history_mode === 'snapshot_contents'
        || ['read_relation_graph', 'read_event_timeline'].includes(operation) && request.history_mode === 'market_known_at'
          && isWfdRecord(request.knowledge_cutoff) && request.knowledge_cutoff.status === 'known'
          && (operation === 'read_event_timeline' || isWfdRecord(request.business_time_range) && request.business_time_range.role === 'validity')
          && request.held_scope === null && request.usable_stage === null
        || operation === 'read_relation_graph' && request.history_mode === 'system_held_at'
          && isWfdRecord(request.knowledge_cutoff) && request.knowledge_cutoff.status === 'known'
          && isWfdRecord(request.business_time_range) && request.business_time_range.role === 'validity'
          && typeof request.held_scope === 'string' && request.held_scope.length > 0
          && ['acquired', 'custodied', 'published_readable'].includes(String(request.usable_stage)))) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', '上下文须为四个明确操作的固定快照，或带明确公开截止的事件时间线及带公开/持有截止与独立有效期的关系图；内外操作必须一致。', { operation: 'context', requestId: 'request' }));
    }
    return this.request(operation, { request }, signal);
  }

  readProduct(request: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!isWfdRecord(request)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'read_product 需要完整查询请求对象。', {
        operation: 'read_product', requestId: 'request',
      }));
    }
    return this.request('read_product', { request }, signal);
  }

  batchBegin(batchId: string, header: WfdRecord, expectedChunks: number, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_begin', { batch_id: batchId, header, expected_chunks: expectedChunks }, signal);
  }

  batchPutChunk(batchId: string, outputKey: string, chunkId: string, rows: unknown[], digest?: string,
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_put_chunk', {
      batch_id: batchId, output_key: outputKey, chunk_id: chunkId, rows,
      ...(digest ? { digest } : {}),
    }, signal);
  }

  batchStatus(batchId: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_status', { batch_id: batchId }, signal);
  }

  batchFinalize(batchId: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_finalize', { batch_id: batchId }, signal);
  }

  tabularBatchBegin(batchId: string, header: TabularBatchHeader, chunks: TabularBatchChunk[],
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_begin', { batch_id: batchId, header, expected_chunks: chunks }, signal);
  }

  tabularBatchPut(batchId: string, outputKey: string, chunk: TabularBatchChunk, rows: TabularCell[][],
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.batchPutChunk(batchId, outputKey, chunk.chunk_id, rows, chunk.digest, signal);
  }

  tabularReadPage({ snapshot_id, product_id, partition, result_root, page_size, cursor }: TabularReadPage,
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_read_page', { snapshot_id, product_id, partition, result_root, page_size, cursor }, signal);
  }

  /** Explicit whole-date source-report mode; it does not change ordinary batch limits. */
  sourceMinuteBatchBegin(batchId: string, header: SourceMinuteBatchHeader, chunks: SourceMinuteBatchChunk[],
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_begin', { batch_id: batchId, header, expected_chunks: chunks }, signal);
  }

  sourceMinuteBatchPut(batchId: string, outputKey: string, chunk: SourceMinuteBatchChunk, rows: SourceMinuteCell[][],
    signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_put_chunk', { batch_id: batchId, output_key: outputKey,
      chunk_id: chunk.chunk_id, rows, digest: chunk.digest }, signal);
  }

  sourceMinuteReadPage(input: SourceMinuteReadPage, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('batch_read_page', { ...input }, signal);
  }

  /** 正式用途治理：暂停状态、显式审计复现、暂停登记、精确修复票据与解决说明。 */
  usageStatus(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_status', {}, signal);
  }
  usageAuditRead(snapshotId: string, issueId: string, productId?: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_audit_read', { snapshot_id: snapshotId, issue_id: issueId,
      ...(productId ? { product_id: productId } : {}) }, signal);
  }
  usageSuspend(declaration: WfdRecord, signal?: AbortSignal, expectedCommitId?: string): Promise<WfdProductMachineReply> {
    return this.request('usage_suspend', { declaration, ...(expectedCommitId !== undefined ? { expected_commit_id: expectedCommitId } : {}) }, signal);
  }
  usageAuthorizeRepair(declaration: WfdRecord, signal?: AbortSignal, expectedCommitId?: string): Promise<WfdProductMachineReply> {
    return this.request('usage_authorize_repair', { declaration, ...(expectedCommitId !== undefined ? { expected_commit_id: expectedCommitId } : {}) }, signal);
  }
  usageResolve(declaration: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_resolve', { declaration }, signal);
  }

  /** 只用于边界负向验证；入口仍会拒绝未支持操作，不因客户端调用而扩权。 */
  request(operation: string, args: WfdRecord, signal?: AbortSignal, requestId: string = 'bd-' + randomUUID()): Promise<WfdProductMachineReply> {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', '本机请求编号无效。', {
        operation, requestId,
      }));
    }
    if (signal?.aborted) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_ABORTED', '本次等待已中止；没有重发。', {
        operation, requestId,
      }));
    }
    const serializeStarted = Date.now();
    const requestedDescriptor = args.descriptor_sha256;
    const body = JSON.stringify({ protocol_version: WFD_PRODUCT_MACHINE_PROTOCOL, request_id: requestId, operation, arguments: args });
    const serializeMs = Date.now() - serializeStarted;
    if (Buffer.byteLength(body) > this.config.maxRequestBytes) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST_BUDGET', '薄入口请求超过有界上限；没有发送。', {
        operation, requestId,
      }));
    }
    return new Promise<WfdProductMachineReply>((resolveCall, reject) => {
      const started = Date.now();
      let spawnAt = 0, stdinAt = 0;
      const bundleSpec = Object.hasOwn(WFD_BUNDLE_OPERATIONS, operation) ? WFD_BUNDLE_OPERATIONS[operation as WfdBundleOperation] : undefined;
      const writesDatabase = bundleSpec?.writesDatabase ?? WRITE_OPERATIONS.has(operation);
      const hasSideEffect = bundleSpec?.hasSideEffect ?? writesDatabase;
      let dispatched = false;
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = '';
      let stdinError: unknown = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const launch = [this.config.entryPath, '--config', this.config.configPath];
      if (operation === 'bundle_capabilities' || Object.hasOwn(WFD_BUNDLE_OPERATIONS, operation)) {
        launch.push('--expected-config-sha256', this.bundleConfigDigest);
      }
      if (Object.hasOwn(WFD_BUNDLE_OPERATIONS, operation)) {
        launch.push('--require-bundle-write-tracking');
      }
      const child = spawn(this.config.pythonPath, launch, {
        cwd: this.config.projectRoot,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      });
      const timing = (ok: boolean, reply?: WfdProductMachineReply) => {
        const totalMs = Date.now() - started;
        recordTiming({ at: Date.now(), operation, requestId, write: writesDatabase,
          requestBytes: Buffer.byteLength(body), responseBytes: stdout.length, serializeMs,
          spawnMs: spawnAt ? spawnAt - started : -1, stdinMs: stdinAt && spawnAt ? stdinAt - spawnAt : -1,
          waitMs: totalMs, totalMs, machineElapsedMs: reply?.transport?.elapsedMs ?? null, ok });
      };
      const finish = (error?: unknown, reply?: WfdProductMachineReply) => {
        if (settled) return;
        settled = true;
        timing(!error, reply);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { reject(error); child.kill('SIGKILL'); } else resolveCall(reply!);
      };
      const abort = () => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_ABORTED', '本次等待已中止；没有重发；若已发送请按原 identity 查询。', {
        operation, requestId, mayHaveBeenAccepted: hasSideEffect && dispatched,
      }));
      timer = setTimeout(() => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TIMEOUT', `等待 WFD 产品进程超过 ${this.config.timeoutMs} ms；没有自动重发；若已发送请按原 identity 查询。`, {
        operation, requestId, mayHaveBeenAccepted: hasSideEffect && dispatched,
      })), this.config.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('spawn', () => {
        if (settled) return;
        spawnAt = Date.now();
        dispatched = true;
        child.stdin.end(body);
        stdinAt = Date.now();
      });
      child.on('error', error => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', '无法启动或等待 WFD 产品进程。', {
        operation, requestId, cause: error, mayHaveBeenAccepted: hasSideEffect && dispatched,
      })));
      child.stdin.on('error', error => {
        const errCode = (error as NodeJS.ErrnoException)?.code;
        if (errCode === 'EPIPE' || errCode === 'ERR_STREAM_DESTROYED') {
          stdinError = error;
          return;
        }
        finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', '写入薄入口请求失败。', {
          operation, requestId, cause: error, mayHaveBeenAccepted: hasSideEffect && dispatched,
        }));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > this.config.maxResponseBytes) {
          finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_OUTPUT_BUDGET', '薄入口响应超过有界上限；没有截断采用。', {
            operation, requestId, mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length);
      });
      child.on('close', (code, signalName) => {
        if (settled) return;
        const elapsedMs = Date.now() - started;
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); } catch (error) {
          if (Object.hasOwn(WFD_BUNDLE_OPERATIONS, operation)
            && stdout.length === 0 && code === 2
            && stderr.includes('unrecognized arguments: --require-bundle-write-tracking')) {
            return finish(new WfdProductMachineError('OPERATION_UNSUPPORTED', '所登记的 WFD 入口不支持分包写入状态追踪，未执行任何分包操作。', {
              operation, requestId, cause: stderr, mayHaveBeenAccepted: false,
            }));
          }
          if (stdinError) {
            return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', '写入薄入口请求失败。', {
              operation, requestId, cause: stdinError, mayHaveBeenAccepted: hasSideEffect && dispatched,
            }));
          }
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', `薄入口没有返回单个 JSON（exit=${String(code)}, signal=${String(signalName)}）。`, {
            operation, requestId, cause: stderr || error, mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
        if (!isWfdRecord(parsed)) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口响应不是 JSON 对象。', {
            operation, requestId, mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
        const response = parsed;
        if (response.protocol_version !== WFD_PRODUCT_MACHINE_PROTOCOL || response.request_id !== requestId
          || response.operation !== operation || typeof response.ok !== 'boolean'
          || (bundleSpec && (response.ok ? response.error != null : response.result != null))) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口响应的协议、请求编号或操作未核对。', {
            operation, requestId, service: isWfdRecord(response.service) ? response.service : null,
            cause: isWfdRecord(response.error) ? response.error : undefined,
            mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
        const service = isWfdRecord(response.service) ? response.service : null;
        const identity = isWfdRecord(response.identity) ? response.identity : null;
        const transport: WfdProductMachineTransport = {
          requestId,
          operation,
          elapsedMs: typeof response.elapsed_ms === 'number' ? response.elapsed_ms : elapsedMs,
          responseBytes: stdout.length,
          serviceVersion: typeof service?.service_version === 'string' ? service.service_version : null,
          contractVersion: typeof service?.contract_version === 'string' ? service.contract_version : null,
          schemaId: typeof service?.schema_id === 'string' ? service.schema_id : null,
          connectionId: typeof identity?.connection_id === 'string' ? identity.connection_id : null,
          callerId: typeof identity?.caller_id === 'string' ? identity.caller_id : null,
          trustedActorNamespace: typeof identity?.trusted_actor_namespace === 'string' ? identity.trusted_actor_namespace : null,
        };
        if (response.ok === false) {
          const error = isWfdRecord(response.error) ? response.error : {};
          if (bundleSpec && (typeof error.code !== 'string' || !error.code || typeof error.message !== 'string')) {
            return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '分包错误回执缺少错误身份或说明。', {
              operation, requestId, mayHaveBeenAccepted: hasSideEffect && dispatched,
            }));
          }
          const remoteCode = typeof error.code === 'string' ? error.code : 'WFD_PRODUCT_MACHINE_REMOTE';
          const message = typeof error.message === 'string' ? error.message : '薄入口返回失败但没有可读原因。';
          const action = typeof error.action === 'string' ? error.action : null;
          const errorDetails = isWfdRecord(error.details) ? error.details : {};
          const context = errorDetails.write_context;
          const explicitlyUnwritten = isWfdRecord(context) && context.operation === operation
            && context.may_have_written === false && (context.request_id === undefined || context.request_id === requestId)
            && (bundleSpec?.writesDatabase
              ? digest(requestedDescriptor) && context.descriptor_sha256 === requestedDescriptor
              : context.descriptor_sha256 == null || digest(context.descriptor_sha256))
            && (context.do_not_resubmit_with_new_identity === undefined || typeof context.do_not_resubmit_with_new_identity === 'boolean')
            && remoteCode !== 'PROCESS_OUTPUT_FAILED'
            && [errorDetails, context, errorDetails.cause_details].filter(isWfdRecord).every(item =>
              ['write_may_have_happened', 'may_have_written', 'operation_completed', 'operation_result_known']
                .every(key => !Object.hasOwn(item, key) || item[key] === false));
          return finish(new WfdProductMachineError(remoteCode, `${message}${action ? ' 下一步：' + action : ''}`, {
            operation, requestId, remoteCode, action,
            identity: isWfdRecord(error.identity) ? error.identity : identity,
            service: isWfdRecord(error.service) ? error.service : service,
            cause: typeof error.cause === 'string' ? error.cause : undefined,
            mayHaveBeenAccepted: hasSideEffect && dispatched && !explicitlyUnwritten,
          }));
        }
        if (!isWfdRecord(response.result)) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口成功响应缺少 result 对象。', {
            operation, requestId, service, mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
        if (code !== 0) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', `薄入口退出码 ${String(code)} 但响应标记成功；拒绝采用。`, {
            operation, requestId, service, mayHaveBeenAccepted: hasSideEffect && dispatched,
          }));
        }
        finish(undefined, { result: response.result, response, transport });
      });
    });
  }
}

import { R1_CONTEXT_OPERATIONS, type R1ContextOperation } from '../../contracts/r1-contracts.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DataServiceError } from './wfd-error.js';
import { isWfdRecord, type WfdRecord } from './wfd-transport.js';

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
 * 来源角色/权威和合同；客户端不传递 store/runtime/principal/roles。packages/export
 * 等未支持操作由入口明确返回 `OPERATION_UNSUPPORTED`，不伪造异步 job。
 */
export const WFD_PRODUCT_MACHINE_PROTOCOL = 'wfd.product-machine/0.1';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_STDERR_BYTES = 16_384;
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
      if (label !== 'python' && real !== resolve(path)) {
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
    if (root !== resolve(config.projectRoot)) {
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
  }

  capabilities(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('capabilities', {}, signal);
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

  submit(document: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!isWfdRecord(document)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'submit 需要完整文档对象。', {
        operation: 'submit', requestId: 'request',
      }));
    }
    return this.request('submit', { document }, signal);
  }

  recovery(document: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    if (!isWfdRecord(document)) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', 'recovery 需要原文档对象。', {
        operation: 'recovery', requestId: 'request',
      }));
    }
    return this.request('recovery', { document }, signal);
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
      || request.protocol_version !== 'wfd.read/1.3-product1b' || request.history_mode !== 'snapshot_contents') {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST', '上下文只允许四个明确操作及固定快照内容视角，内外操作必须一致。', { operation: 'context', requestId: 'request' }));
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

  /** 正式用途治理：暂停状态、显式审计复现、暂停登记、精确修复票据与解决说明。 */
  usageStatus(signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_status', {}, signal);
  }
  usageAuditRead(snapshotId: string, issueId: string, productId?: string, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_audit_read', { snapshot_id: snapshotId, issue_id: issueId,
      ...(productId ? { product_id: productId } : {}) }, signal);
  }
  usageSuspend(declaration: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_suspend', { declaration }, signal);
  }
  usageAuthorizeRepair(declaration: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_authorize_repair', { declaration }, signal);
  }
  usageResolve(declaration: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('usage_resolve', { declaration }, signal);
  }

  /** 只用于边界负向验证；入口仍会拒绝未支持操作，不因客户端调用而扩权。 */
  request(operation: string, args: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    const requestId = 'bd-' + randomUUID();
    if (!REQUEST_ID.test(requestId)) {
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
      const writeOperation = WRITE_OPERATIONS.has(operation);
      let dispatched = false;
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(this.config.pythonPath, [this.config.entryPath, '--config', this.config.configPath], {
        cwd: this.config.projectRoot,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      });
      const timing = (ok: boolean, reply?: WfdProductMachineReply) => {
        const totalMs = Date.now() - started;
        recordTiming({ at: Date.now(), operation, requestId, write: writeOperation,
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
        operation, requestId, mayHaveBeenAccepted: writeOperation && dispatched,
      }));
      timer = setTimeout(() => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TIMEOUT', `等待 WFD 产品进程超过 ${this.config.timeoutMs} ms；没有自动重发；若已发送请按原 identity 查询。`, {
        operation, requestId, mayHaveBeenAccepted: writeOperation && dispatched,
      })), this.config.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('spawn', () => { spawnAt = Date.now(); });
      child.on('error', error => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', '无法启动或等待 WFD 产品进程。', {
        operation, requestId, cause: error, mayHaveBeenAccepted: writeOperation && dispatched,
      })));
      child.stdin.on('error', error => finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', '写入薄入口请求失败。', {
        operation, requestId, cause: error, mayHaveBeenAccepted: writeOperation && dispatched,
      })));
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > this.config.maxResponseBytes) {
          finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_OUTPUT_BUDGET', '薄入口响应超过有界上限；没有截断采用。', {
            operation, requestId, mayHaveBeenAccepted: writeOperation && dispatched,
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
        try { parsed = JSON.parse(stdout.toString('utf8')); } catch (error) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', `薄入口没有返回单个 JSON（exit=${String(code)}, signal=${String(signalName)}）。`, {
            operation, requestId, cause: stderr || error, mayHaveBeenAccepted: writeOperation && dispatched,
          }));
        }
        if (!isWfdRecord(parsed)) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口响应不是 JSON 对象。', {
            operation, requestId, mayHaveBeenAccepted: writeOperation && dispatched,
          }));
        }
        const response = parsed;
        if (response.protocol_version !== WFD_PRODUCT_MACHINE_PROTOCOL || response.request_id !== requestId
          || response.operation !== operation || typeof response.ok !== 'boolean') {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口响应的协议、请求编号或操作未核对。', {
            operation, requestId, service: isWfdRecord(response.service) ? response.service : null,
            mayHaveBeenAccepted: writeOperation && dispatched,
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
          const remoteCode = typeof error.code === 'string' ? error.code : 'WFD_PRODUCT_MACHINE_REMOTE';
          const message = typeof error.message === 'string' ? error.message : '薄入口返回失败但没有可读原因。';
          const action = typeof error.action === 'string' ? error.action : null;
          const errorDetails = isWfdRecord(error.details) ? error.details : {};
          const writeContext = isWfdRecord(errorDetails.write_context) ? errorDetails.write_context : {};
          return finish(new WfdProductMachineError(remoteCode, `${message}${action ? ' 下一步：' + action : ''}`, {
            operation, requestId, remoteCode, action,
            identity: isWfdRecord(error.identity) ? error.identity : identity,
            service: isWfdRecord(error.service) ? error.service : service,
            cause: typeof error.cause === 'string' ? error.cause : undefined,
            mayHaveBeenAccepted: writeOperation && (errorDetails.write_may_have_happened === true
              || writeContext.may_have_written === true || remoteCode === 'PROCESS_OUTPUT_FAILED'),
          }));
        }
        if (!isWfdRecord(response.result)) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_RESPONSE', '薄入口成功响应缺少 result 对象。', {
            operation, requestId, service, mayHaveBeenAccepted: writeOperation && dispatched,
          }));
        }
        if (code !== 0) {
          return finish(new WfdProductMachineError('WFD_PRODUCT_MACHINE_TRANSPORT', `薄入口退出码 ${String(code)} 但响应标记成功；拒绝采用。`, {
            operation, requestId, service, mayHaveBeenAccepted: writeOperation && dispatched,
          }));
        }
        finish(undefined, { result: response.result, response, transport });
      });
      dispatched = true;
      child.stdin.end(body);
      stdinAt = Date.now();
    });
  }
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DataServiceError } from './wfd-error.js';
import { isWfdRecord, type WfdRecord } from './wfd-transport.js';

/**
 * 公开本地结构化进程边界：WFD `wfd.product-machine/0.1`。
 *
 * 与旧 `wfd.data-service/v1` generic-transport 完全分开：本适配只启动 WFD
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

export interface WfdProductMachineReadOptions {
  snapshotId: string;
  productId?: string;
  perspective?: 'snapshot_contents' | 'market_known_at' | 'system_held_at';
  at?: string;
  subject?: string;
  includeHistory?: boolean;
  rowProjection?: 'full' | 'compact';
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
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.includeHistory !== undefined ? { include_history: options.includeHistory } : {}),
      ...(options.rowProjection ? { row_projection: options.rowProjection } : {}),
    }, signal);
  }

  requestStatus(requestIdentity: WfdRecord, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('request_status', { request_identity: requestIdentity }, signal);
  }

  requestStatusPage(requestIdentity: WfdRecord, options: { outputOffset?: number; outputLimit?: number;
    outputDetail?: 'summary' | 'full' } = {}, signal?: AbortSignal): Promise<WfdProductMachineReply> {
    return this.request('request_status', {
      request_identity: requestIdentity,
      ...(options.outputOffset !== undefined ? { output_offset: options.outputOffset } : {}),
      ...(options.outputLimit !== undefined ? { output_limit: options.outputLimit } : {}),
      ...(options.outputDetail !== undefined ? { output_detail: options.outputDetail } : {}),
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
    const body = JSON.stringify({ protocol_version: WFD_PRODUCT_MACHINE_PROTOCOL, request_id: requestId, operation, arguments: args });
    if (Buffer.byteLength(body) > this.config.maxRequestBytes) {
      return Promise.reject(new WfdProductMachineError('WFD_PRODUCT_MACHINE_REQUEST_BUDGET', '薄入口请求超过有界上限；没有发送。', {
        operation, requestId,
      }));
    }
    return new Promise<WfdProductMachineReply>((resolveCall, reject) => {
      const started = Date.now();
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
      const finish = (error?: unknown, reply?: WfdProductMachineReply) => {
        if (settled) return;
        settled = true;
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
    });
  }
}

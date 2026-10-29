import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import { DataServiceError } from './wfd-error.js';
import Schema from 'typebox/schema';

export type WfdRecord = Record<string, unknown>;
export type WfdEnvelope = { protocol_version: 2; instance_id?: string; request_id: string; operation: string; arguments: WfdRecord };
export interface WfdTransportConfig {
  binding: 'isolated-synthetic' | 'controlled-user-test' | 'registered-production'; schemaPath: string; expectedSchemaSha256: string; baseUrl: string;
  /** 用户测试实例及预登记数据集仅由宿主给定，不接受工具参数覆盖。 */
  instanceId?: string; datasetId?: string;
  /** 宿主只在内存解析指定凭据；此层没有凭据文件或其他来源回退。 */
  resolveToken(): string | Promise<string>;
  timeoutMs?: number; maxResponseBytes?: number;
  harnessRootId?: string; environment?: 'user_test' | 'production';
}
export const isWfdRecord = (value: unknown): value is WfdRecord => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const wfdSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const isFixedWfdSnapshot = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && !/^(latest|current)$/i.test(value);
export function canonicalWfdJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new DataServiceError('WFD_JSON_INVALID', 'WFD JSON 超出结构深度预算。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalWfdJson(item, depth + 1)).join(',')}]`;
  if (isWfdRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalWfdJson(value[key], depth + 1)}`).join(',')}}`;
  throw new DataServiceError('WFD_JSON_INVALID', 'WFD 载荷必须为明确的有限 JSON。');
}
function fail(code: string, message: string): never { throw new DataServiceError(code, message); }

/** 收集交接与金融固定读取共用的唯一 v2（第2版）有界传输。没有重试或业务推理。 */
export function createWfdTransport(configuration: WfdTransportConfig) {
  const config = { ...configuration };
  if (!['isolated-synthetic', 'controlled-user-test', 'registered-production'].includes(config.binding) || !isAbsolute(config.schemaPath ?? '')
    || !/^[0-9a-f]{64}$/.test(config.expectedSchemaSha256 ?? '') || typeof config.resolveToken !== 'function'
    || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(config.baseUrl ?? '')) {
    fail('INVALID_CONFIG', 'WFD 需要明确隔离绑定、正式模式路径与摘要、内存凭据及数字回环地址。');
  }
  if ((config.harnessRootId !== undefined || config.environment !== undefined) && (typeof config.harnessRootId !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(config.harnessRootId)
    || config.environment !== (config.binding === 'registered-production' ? 'production' : config.binding === 'controlled-user-test' ? 'user_test' : undefined))) fail('WFD_ENVIRONMENT_UNBOUND', '请求必须固定同一受信框架根和数据库环境，不能单独覆盖环境头。');
  let url: URL;
  try { url = new URL('/v2/data-entry', config.baseUrl); } catch { return fail('INVALID_CONFIG', 'WFD 回环地址无效。'); }
  const timeoutMs = config.timeoutMs ?? 15_000, maxResponseBytes = config.maxResponseBytes ?? 4_194_304;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16_777_216) fail('INVALID_CONFIG', 'WFD 超时或响应预算无效。');
  let schema: WfdRecord;
  try {
    const bytes = readFileSync(config.schemaPath);
    if (wfdSha256(bytes) !== config.expectedSchemaSha256) fail('WFD_SCHEMA_MISMATCH', 'WFD 正式模式摘要与受信绑定不一致。');
    schema = JSON.parse(bytes.toString('utf8')) as WfdRecord;
  } catch (error) {
    if (error instanceof DataServiceError) throw error;
    return fail('WFD_SCHEMA_UNAVAILABLE', 'WFD 正式模式无法加载；未回退到其他版本。');
  }
  const userTest = config.binding === 'controlled-user-test', production = config.binding === 'registered-production';
  const bindings = schema['x-user-test-dataset-bindings'];
  const binding = userTest && Array.isArray(bindings) ? bindings.find(item => isWfdRecord(item) && item.dataset_id === config.datasetId)
    : production ? {} : schema['x-default-dataset-binding'];
  if (!production && (!(userTest ? schema['x-contract-revision'] === '0.1.3' : ['0.1.2', '0.1.3'].includes(String(schema['x-contract-revision'])))
    || schema['x-route'] !== 'POST /v2/data-entry' || !isWfdRecord(schema.definitions) || !isWfdRecord(binding)
    || binding.contract_version !== 'wfd-table/v0.2'
    || (userTest ? !isFixedWfdSnapshot(config.instanceId) || binding.dataset_id !== config.datasetId
      || !isWfdRecord(binding.descriptor_semantics) || binding.semantics_sha256 !== wfdSha256(canonicalWfdJson(binding.descriptor_semantics))
      : binding.mapping_version !== 'synthetic-daily/v0.2' || binding.definition_rev !== '2' || binding.schema_rev !== '2'))) {
    fail('WFD_SCHEMA_UNSUPPORTED', '需要受信模式修订、明确 v0.2 数值语义与逐项登记的测试实例和输出合同。');
  }
  if (production && (schema['x-contract-revision'] !== '0.2.0' || schema['x-route'] !== 'POST /v2/data-entry'
    || !isFixedWfdSnapshot(config.instanceId) || !isWfdRecord(schema.definitions)
    || !isWfdRecord(schema['x-production-profile']) || schema['x-production-profile'].id !== 'production-empty-read-only/v1')) {
    fail('WFD_SCHEMA_UNSUPPORTED', '正式线路仅支持已登记的0.2.0空只读合同，未借用用户测试目标。');
  }
  const validators = new Map<string, { Check(value: unknown): boolean }>();
  const check = (definition: string, value: unknown): boolean => {
    if (!Object.hasOwn(schema.definitions as WfdRecord, definition)) fail('WFD_SCHEMA_UNSUPPORTED', '正式模式缺少所需定义。');
    let validator = validators.get(definition);
    if (!validator) {
      validator = Schema.Compile({ ...schema, $ref: `#/definitions/${definition}` } as never);
      validators.set(definition, validator);
    }
    return validator.Check(value);
  };
  const boundEnvelope = (envelope: WfdEnvelope): WfdEnvelope => {
    if (envelope.instance_id !== undefined && envelope.instance_id !== config.instanceId) fail('WFD_INSTANCE_MISMATCH', '请求不能覆盖受信实例身份。');
    return config.instanceId ? { ...envelope, instance_id: config.instanceId } : envelope;
  };
  const validateRequest = (envelope: WfdEnvelope): void => {
    const bound = boundEnvelope(envelope);
    if (!check('request_envelope', bound) || Buffer.byteLength(canonicalWfdJson(bound)) > Number(schema['x-max-request-bytes'])) {
      fail('WFD_REQUEST_INVALID', '请求不符合正式 WFD 模式或超出字节预算。');
    }
  };
  return Object.freeze({ schema, datasetBinding: binding, contractDigest: config.expectedSchemaSha256, origin: url.origin,
    instanceId: config.instanceId ?? null,
    check, validateRequest,
    async call(envelope: WfdEnvelope, options?: { signal?: AbortSignal }): Promise<WfdRecord> {
      validateRequest(envelope);
      const signal = options?.signal;
      if (signal?.aborted) fail('CALL_ABORTED', '本次等待已中止。');
      const body = canonicalWfdJson(boundEnvelope(envelope)), writes = ['materials.receive', 'results.publish', 'data.jobs.resume', 'data.jobs.cancel'].includes(envelope.operation);
      return new Promise((resolveCall, reject) => {
        let dispatched = false, settled = false, req: ClientRequest | undefined;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: unknown, result?: WfdRecord): void => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) {
            const safe = error instanceof DataServiceError ? error : new DataServiceError('TRANSPORT_FAILED', 'WFD 连接或响应中断。');
            safe.mayHaveBeenAccepted = writes && dispatched;
            reject(safe); req?.destroy();
          } else resolveCall(result!);
        };
        const abort = (): void => finish(new DataServiceError('CALL_ABORTED', '本次等待已中止；业务状态需按原身份查询。'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new DataServiceError('CALL_TIMEOUT', '等待 WFD 超时；不自动重试。')), timeoutMs);
        if (signal?.aborted) { abort(); return; }
        void Promise.resolve().then(() => settled ? undefined : config.resolveToken()).then(token => {
          if (settled) return;
          if (signal?.aborted) { abort(); return; }
          if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]{16,4096}=*$/.test(token)) {
            finish(new DataServiceError('SERVICE_AUTH_INVALID', 'WFD 指定内存凭据无效。')); return;
          }
          try {
            req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
              authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body),
              ...(config.harnessRootId ? { 'X-WFD-Harness-Root-Id': config.harnessRootId, 'X-WFD-Environment': config.environment! } : {}) } }, response => {
              if (response.statusCode !== 200) { response.destroy(); finish(new DataServiceError('HTTP_ERROR', 'WFD 未返回成功响应；不跟随重定向。')); return; }
              if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers['content-type'] ?? '')) { response.destroy(); finish(new DataServiceError('INVALID_RESPONSE', 'WFD 响应不是 JSON。')); return; }
              const chunks: Buffer[] = []; let size = 0;
              response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxResponseBytes) { response.destroy(); finish(new DataServiceError('RESPONSE_TOO_LARGE', 'WFD 响应超出字节预算。')); }
                else chunks.push(chunk);
              });
              response.on('error', () => finish(new DataServiceError('TRANSPORT_FAILED', 'WFD 响应中断。')));
              response.on('end', () => {
                if (settled) return;
                try {
                  const received: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  if (!check('response_envelope', received) || !isWfdRecord(received)
                    || received.request_id !== envelope.request_id || received.operation !== envelope.operation) fail('INVALID_RESPONSE', 'WFD 响应包络或调用身份不匹配。');
                  if (received.error !== undefined) fail('SERVICE_REJECTED', `WFD 返回错误（${(received.error as WfdRecord).code}）；请核查原身份。`);
                  if ((userTest || production) && isWfdRecord(received.result) && received.result.instance_id !== undefined
                    && received.result.instance_id !== config.instanceId) fail('WFD_INSTANCE_MISMATCH', '响应不是受信用户测试实例。');
                  const responses = schema['x-response-definitions'];
                  const definition = isWfdRecord(responses) ? responses[envelope.operation] : undefined;
                  if (typeof definition !== 'string' || !check(definition, received.result)) fail('INVALID_RESPONSE', 'WFD操作结果不符合唯一模式的响应定义。');
                  finish(undefined, received.result as WfdRecord);
                } catch (error) { finish(error instanceof SyntaxError ? new DataServiceError('INVALID_RESPONSE', 'WFD 返回无效 JSON。') : error); }
              });
            });
            req.on('error', error => finish(error)); dispatched = true; req.end(body);
          } catch (error) { finish(error); }
        }, () => finish(new DataServiceError('SERVICE_AUTH_INVALID', 'WFD 指定凭据无法安全解析；未使用其他凭据。')));
      });
    },
  });
}

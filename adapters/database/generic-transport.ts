import { readFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import Schema from 'typebox/schema';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from './wfd-transport.js';
import { DataServiceError } from './wfd-error.js';

export const GENERIC_CONTRACT = 'wfd.data-service/v1';
export interface GenericEnvelope { protocol_version: 3; contract_version: typeof GENERIC_CONTRACT;
  request_id: string; instance_id: string; operation: string; arguments: WfdRecord }
export interface GenericDatabaseBinding {
  readonly instanceId: string; readonly contractDigest: string; readonly origin: string;
  readonly purpose: 'user_test';
  readonly credentialReference: string;
  readonly declarationContract: WfdRecord;
  call(envelope: GenericEnvelope, signal?: AbortSignal): Promise<WfdRecord>;
}
export class GenericDatabaseError extends DataServiceError {
  constructor(code: string, message: string, readonly sideEffects: string = 'none', readonly nextAction?: unknown) {
    super(code, message, { mayHaveBeenAccepted: !['none'].includes(sideEffects) });
  }
}
export function createGenericDatabaseBinding(configuration: { baseUrl: string; instanceId: string;
  schemaPath: string; schemaSha256: string; credentialReference: string; resolveToken(): string | Promise<string>; harnessRootId?: string }): GenericDatabaseBinding {
  const config = { ...configuration };
  const fail = (code: string, message: string): never => { throw new GenericDatabaseError(code, message); };
  if (!isAbsolute(config.schemaPath) || !/^[a-f0-9]{64}$/.test(config.schemaSha256)
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(config.baseUrl)) fail('WFD_GENERIC_CONFIG', '通用交接需要已发现的回环实例及独立模式摘要。');
  const bytes = readFileSync(config.schemaPath);
  if (wfdSha256(bytes) !== config.schemaSha256) fail('WFD_GENERIC_SCHEMA_CHANGED', '通用协议模式摘要与本次受信发现不符。');
  const schema = JSON.parse(bytes.toString('utf8')) as WfdRecord;
  if (schema['x-contract-version'] !== GENERIC_CONTRACT || schema['x-contract-revision'] !== '1.0.0'
    || schema['x-route'] !== 'POST /v3/data-entry' || !isWfdRecord(schema.definitions)) fail('WFD_GENERIC_SCHEMA_UNSUPPORTED', '需要明确的通用交接第1版模式；不借用旧六列合同。');
  const validators = new Map<string, { Check(value: unknown): boolean }>();
  const check = (definition: string, value: unknown) => {
    if (!Object.hasOwn(schema.definitions as WfdRecord, definition)) fail('WFD_GENERIC_SCHEMA_UNSUPPORTED', '通用模式缺少操作定义。');
    let validator = validators.get(definition);
    if (!validator) { validator = Schema.Compile({ ...schema, $ref: '#/definitions/' + definition } as never); validators.set(definition, validator); }
    return validator.Check(value);
  };
  const origin = new URL(config.baseUrl).origin;
  return Object.freeze({ instanceId: config.instanceId, contractDigest: config.schemaSha256, origin, purpose: 'user_test' as const, credentialReference: config.credentialReference, declarationContract: { declaration: (schema.definitions as WfdRecord).declaration, provenance: (schema.definitions as WfdRecord).provenance, coverage: (schema.definitions as WfdRecord).coverage },
    async call(envelope: GenericEnvelope, signal?: AbortSignal) {
      if (envelope.instance_id !== config.instanceId || !check('request_envelope', envelope)) fail('WFD_GENERIC_REQUEST', '请求未绑定原实例或不符合通用交接模式。');
      const body = canonicalWfdJson(envelope);
      if (Buffer.byteLength(body) > Number(schema['x-max-request-bytes'])) fail('WFD_GENERIC_REQUEST_BUDGET', '通用请求超过模式声明的字节预算。');
      signal?.throwIfAborted();
      const token = await config.resolveToken();
      if (!/^[A-Za-z0-9._~+\/-]{16,4096}=*$/.test(token)) fail('WFD_GENERIC_CREDENTIAL', '原实例凭据无效。');
      const writes = ['objects.put', 'data.submit', 'data.jobs.resume', 'data.jobs.cancel'].includes(envelope.operation);
      return await new Promise<WfdRecord>((resolveCall, reject) => {
        let settled = false, dispatched = false, req: ClientRequest | undefined;
        const finish = (error?: unknown, result?: WfdRecord) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) { const safe = error instanceof GenericDatabaseError ? error : new GenericDatabaseError('WFD_GENERIC_TRANSPORT', '数据库连接或响应中断。', writes && dispatched ? 'unknown' : 'none');
            reject(safe); req?.destroy(); } else resolveCall(result!);
        };
        const abort = () => finish(new GenericDatabaseError('WFD_GENERIC_ABORTED', '等待停止；沿原请求查询实际数据库状态。', writes && dispatched ? 'unknown' : 'none'));
        const timer = setTimeout(() => finish(new GenericDatabaseError('WFD_GENERIC_TIMEOUT', '等待数据库超时；没有自动重发。', writes && dispatched ? 'unknown' : 'none')), 30_000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        req = request(new URL('/v3/data-entry', origin), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
          authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(body), ...(config.harnessRootId ? { 'X-WFD-Harness-Root-Id': config.harnessRootId, 'X-WFD-Environment': 'user_test' } : {}) } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          if (response.statusCode !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers['content-type'] ?? '')) { response.destroy(); finish(new GenericDatabaseError('WFD_GENERIC_HTTP', '数据库未返回所需协议响应。', writes ? 'unknown' : 'none')); return; }
          response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8_388_608) { response.destroy(); finish(new GenericDatabaseError('WFD_GENERIC_RESPONSE_BUDGET', '数据库响应超过 8 MiB；没有截断采用。', writes ? 'unknown' : 'none')); } else chunks.push(chunk); });
          response.on('error', error => finish(error));
          response.on('end', () => {
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!isWfdRecord(value) || !check('response_envelope', value) || value.request_id !== envelope.request_id || value.operation !== envelope.operation
                || value.instance_id !== config.instanceId || value.contract_version !== GENERIC_CONTRACT || value.schema_sha256 !== config.schemaSha256
                || value.mode !== 'user_test' || value.purpose !== 'user_test') throw new GenericDatabaseError('WFD_GENERIC_RESPONSE', '响应的原请求、实例、模式或协议摘要未核对。', writes ? 'unknown' : 'none');
              if (isWfdRecord(value.error)) { finish(new GenericDatabaseError(String(value.error.code), String(value.error.message), String(value.error.side_effects), value.error.next_action)); return; }
              const definitions = schema['x-response-definitions'];
              const definition = isWfdRecord(definitions) ? definitions[envelope.operation] : undefined;
              if (!isWfdRecord(value.result) || typeof definition !== 'string' || !check(definition, value.result)) throw new GenericDatabaseError('WFD_GENERIC_RESPONSE', '数据库操作结果不符合冻结模式。', writes ? 'unknown' : 'none');
              finish(undefined, value.result);
            } catch (error) { finish(error instanceof GenericDatabaseError ? error : new GenericDatabaseError('WFD_GENERIC_RESPONSE', '数据库响应无法完整解析或校验。', writes ? 'unknown' : 'none')); }
          });
        });
        req.on('error', error => finish(error)); dispatched = true; req.end(body);
      });
    } });
}

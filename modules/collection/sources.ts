import { createHash } from 'node:crypto';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';

export interface FileInputRegistration {
  id: string;
  version: string;
  environment: 'synthetic-test';
  fileRefId: string;
  expectedSha256: string;
  maxBytes: number;
  mediaType: 'text/csv';
}

export interface SourcePage {
  cursor: string | null;
  nextCursor: string | null;
  bytesBase64: string;
  mediaType: 'text/csv';
  metadata?: JsonValue;
}

/** 仅由受信宿主登记；本阶段不提供 URL、程序或来源凭据的模型入参。 */
export interface SourceAdapter {
  readonly id: string;
  readonly version: string;
  readonly environment: 'synthetic-test';
  readonly definition: JsonValue;
  readonly maxPages: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  fetchPage(input: { cursor: string | null; requestId: string; signal: AbortSignal }): Promise<SourcePage>;
}

export function bytesDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function sealedBytes(bytesBase64: string, maxBytes: number): Buffer {
  if (typeof bytesBase64 !== 'string' || bytesBase64.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new TaskError('SOURCE_BYTE_LIMIT', '来源响应超出封闭字节预算。');
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (bytes.toString('base64') !== bytesBase64 || bytes.length > maxBytes) throw new TaskError('INVALID_SOURCE_BYTES', '来源字节编码不完整或超出预算。');
  return bytes;
}

export function validateFileInput(input: FileInputRegistration): void {
  sourceId(input.id); sourceId(input.version); sourceId(input.fileRefId);
  if (input.environment !== 'synthetic-test' || input.mediaType !== 'text/csv' || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new TaskError('INVALID_COLLECTION_INPUT', '文件入口需要受信宿主登记的合成版本、CSV 和原字节摘要。');
  byteLimit(input.maxBytes);
}
export function validateSource(adapter: SourceAdapter): void {
  sourceId(adapter.id); sourceId(adapter.version);
  if (adapter.environment !== 'synthetic-test' || typeof adapter.fetchPage !== 'function') throw new TaskError('INVALID_COLLECTION_SOURCE', '本阶段仅接受宿主登记的合成来源适配器。');
  byteLimit(adapter.maxBytes);
  if (!Number.isSafeInteger(adapter.maxPages) || adapter.maxPages < 1 || adapter.maxPages > 8
    || !Number.isSafeInteger(adapter.timeoutMs) || adapter.timeoutMs < 10 || adapter.timeoutMs > 60_000) throw new TaskError('INVALID_SOURCE_BUDGET', '来源页数或超时预算无效。');
}
export function sourceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new TaskError('INVALID_COLLECTION_ID', '登记身份或版本无效。');
}
function byteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000_000) throw new TaskError('INVALID_SOURCE_BUDGET', '本阶段原件预算需要在 1 到 2,000,000 字节之间。');
}

/** 已明确标注合成内容的分页夹具；保持每页 CSV 原字节，不建立真实来源连接。 */
export function createSyntheticPagedSource(options: { id: string; version: string; pages: readonly Uint8Array[]; timeoutMs?: number }): SourceAdapter {
  const pages = options.pages.map((page) => Buffer.from(page));
  if (!pages.length) throw new TaskError('INVALID_COLLECTION_SOURCE', '合成来源至少提供一页，可用仅表头 CSV 表示合法空响应。');
  const adapter: SourceAdapter = {
    id: options.id, version: options.version, environment: 'synthetic-test',
    definition: { kind: 'fixed-csv-pages', pageDigests: pages.map(bytesDigest) },
    maxPages: pages.length, maxBytes: Math.max(1, pages.reduce((sum, page) => sum + page.length, 0)), timeoutMs: options.timeoutMs ?? 5000,
    async fetchPage({ cursor, signal }) {
      signal.throwIfAborted();
      const ordinal = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= pages.length || (cursor !== null && String(ordinal) !== cursor)) throw new TaskError('INVALID_SOURCE_CURSOR', '合成来源游标不属于已冻结页范围。');
      return { cursor, nextCursor: ordinal + 1 < pages.length ? String(ordinal + 1) : null,
        bytesBase64: pages[ordinal]!.toString('base64'), mediaType: 'text/csv', metadata: { environment: 'synthetic-test', ordinal } };
    },
  };
  validateSource(adapter);
  return adapter;
}

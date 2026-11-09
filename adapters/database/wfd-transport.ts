import { createHash } from 'node:crypto';
import { DataServiceError } from './wfd-error.js';

export type WfdRecord = Record<string, unknown>;
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

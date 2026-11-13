import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../adapters/database/wfd-transport.js';
import { createSourceReportedMinuteResolver, sourceReportedDate, sourceReportedMinute } from '../modules/collection/source-reported-table.js';
import { TaskError } from '../platform/jobs/tasks.js';

export const TABULAR_BATCH_PROTOCOL = 'wfd.tabular-batch/1' as const;
export const TABULAR_CONTRACT_VERSION = 'wfd.tabular-contract/1' as const;
export const TABULAR_KEY_ALGORITHM = 'wfd.tabular-key/1' as const;
export const TABULAR_MAX_FIELDS = 64;
export type TabularCell = string | null;
export interface TabularBatchChunk { chunk_id: string; ordinal: number; row_count: number; digest: string }
export interface TabularFixedRow { cells: TabularCell[]; record_id: string; record_version: string; row_index: number }

export type TabularTimeContract = { kind: 'unknown' } |
  { kind: 'source_minute'; date_field: string; minute_field: string; timezone: string };
export interface TabularTableContract {
  version: typeof TABULAR_CONTRACT_VERSION;
  fields: string[];
  key_fields: string[];
  partition_field: string | null;
  time: TabularTimeContract;
  digest: string;
}
export interface TabularPartition { value: string }
export interface TabularBatchHeader {
  protocol_version: typeof TABULAR_BATCH_PROTOCOL;
  request_identity: {
    dataset_id: string;
    trusted_actor_namespace: string;
    request_id: string;
    submission_digest: string;
  };
  producer_namespace: string;
  expected_parent_snapshot_id: string | null;
  outputs: WfdRecord[];
  field_codes: string[];
  table_contract: TabularTableContract;
  partition: TabularPartition;
  row_count: number;
  rows_digest: string;
}
export interface TabularReadLocator { snapshot_id: string; product_id: string; partition: string; result_root: string }
export interface TabularReadPage extends TabularReadLocator {
  protocol_version: typeof TABULAR_BATCH_PROTOCOL;
  page_size: number;
  cursor: string | null;
}

const fail = (message: string): never => { throw new TaskError('TABULAR_CONTRACT', message); };
export const TABULAR_FIELD_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
export const tabularDigest = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
export const tabularIdentityRule = (contract: Pick<TabularTableContract, 'key_fields' | 'partition_field'>) =>
  TABULAR_KEY_ALGORITHM + ':' + canonicalWfdJson({ key_fields: contract.key_fields, partition_field: contract.partition_field });

export function tabularPartitionValue(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 512
    || /[\p{Cc}\p{Cs}]/u.test(value))
    return fail('分区值须为不含控制字符的非空 UTF-8 文本，最多 512 字节。');
  return value;
}

function exact(value: unknown, keys: string[]): value is WfdRecord {
  return isWfdRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function readTabularTableContract(value: unknown): TabularTableContract {
  if (!exact(value, ['version', 'fields', 'key_fields', 'partition_field', 'time', 'digest'])
    || value.version !== TABULAR_CONTRACT_VERSION) return fail('批量字段契约缺失或版本无效。');
  const codes = (items: unknown): items is string[] => Array.isArray(items) && items.length > 0
    && items.length <= TABULAR_MAX_FIELDS && new Set(items).size === items.length
    && items.every(item => typeof item === 'string' && TABULAR_FIELD_CODE.test(item));
  const { fields, key_fields, partition_field, time, digest, ...version } = value;
  if (!codes(fields) || !codes(key_fields) || key_fields.some(key => !fields.includes(key))
    || (partition_field !== null && (typeof partition_field !== 'string' || !fields.includes(partition_field))))
    return fail('字段、键字段或分区字段不符合批量字段契约。');
  if (exact(time, ['kind']) && time.kind === 'unknown') { /* no temporal axis */ }
  else if (exact(time, ['kind', 'date_field', 'minute_field', 'timezone']) && time.kind === 'source_minute'
    && typeof time.date_field === 'string' && fields.includes(time.date_field)
    && typeof time.minute_field === 'string' && fields.includes(time.minute_field)
    && time.date_field !== time.minute_field && typeof time.timezone === 'string'
    && /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/u.test(time.timezone)) {
    try { createSourceReportedMinuteResolver(time.timezone); } catch { return fail('分钟来源时区无效。'); }
  } else return fail('时间映射须明确为未知或登记来源日期、分钟与时区。');
  if (typeof digest !== 'string' || digest !== tabularDigest({ ...version, fields, key_fields, partition_field, time }))
    return fail('批量字段契约摘要不匹配。');
  return structuredClone(value) as unknown as TabularTableContract;
}

/** One semantic adapter for compilation and fixed readback. Partition and time mappings are independent. */
export function createTabularRowSemantics(raw: TabularTableContract, partition?: TabularPartition) {
  const contract = readTabularTableContract(raw);
  const keyIndices = contract.key_fields.map(code => contract.fields.indexOf(code));
  const partitionIndex = contract.partition_field === null ? -1 : contract.fields.indexOf(contract.partition_field);
  const fixed = partition && tabularPartitionValue(partition.value);
  const time = contract.time;
  const resolveMinute = time.kind === 'source_minute' ? createSourceReportedMinuteResolver(time.timezone) : null;
  const dateIndex = time.kind === 'source_minute' ? contract.fields.indexOf(time.date_field) : -1;
  const minuteIndex = time.kind === 'source_minute' ? contract.fields.indexOf(time.minute_field) : -1;
  const keyValues = (cells: readonly TabularCell[]): string[] => keyIndices.map(i => {
    const value = cells[i];
    if (typeof value !== 'string' || !value.replace(/[\s\u001c-\u001f\u0085]/gu, '')) return fail('业务键字段须为非空白原文。');
    return value;
  });
  const validate = (cells: readonly TabularCell[]) => {
    if (cells.length !== contract.fields.length || cells.some(cell => cell !== null && typeof cell !== 'string'))
      return fail('数据行须按完整契约提供原文或未知值。');
    const value = partitionIndex < 0 ? tabularPartitionValue(fixed) : tabularPartitionValue(cells[partitionIndex]);
    if (fixed !== undefined && value !== fixed) return fail('原件分区字段与冻结分区值不一致。');
    const key = keyValues(cells);
    let observation: WfdRecord = { status: 'unknown' };
    if (time.kind === 'source_minute') {
      const date = sourceReportedDate(cells[dateIndex], 'yyyymmdd');
      const minute = cells[minuteIndex];
      const normalized = sourceReportedMinute(minute);
      if (!date || typeof minute !== 'string' || !normalized || normalized.replace('T', ' ') !== minute || normalized.slice(0, 10) !== date)
        return fail('原报日期或分钟不符合时间映射。');
      const [start, end] = resolveMinute!(minute);
      observation = { status: 'known', earliest_utc: start, latest_exclusive_utc: end, precision: 'minute', source_timezone: time.timezone };
    }
    return { value, key, observation };
  };
  return {
    keyValues, validate,
    semanticRow(cells: readonly TabularCell[], subject: WfdRecord): WfdRecord {
      const { value, key, observation } = validate(cells);
      return { business_key: 'tabular_' + wfdSha256(canonicalWfdJson([value, key])), subject, observation_time: observation,
        values: Object.fromEntries(contract.fields.map((code, i) => [code, {
          data_type: 'text', value_state: cells[i] === null ? 'unknown' : 'valid_value', value: cells[i],
        }])) };
    },
  };
}

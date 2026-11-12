import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

/**
 * 数据生产统一的结构/精度核对门禁（不是新的任务、发布或授权服务）。
 * 原报五步与固定计算共用：先核完整行/有限值/字节和版本摘要，
 * 然后各自调用已有语义或方法独立数值核验，再交唯一 R1/WFD 发布。
 */
export const PRODUCTION_VERIFIER_VERSION = 'bd.production-verifier/1';
export interface ProductionRowsInput {
  kind: 'source' | 'derived';
  rows: readonly WfdRecord[];
  /** 来源表声明的精确字段集合，派生行采用其独立方法契约。 */
  fields?: readonly string[];
  expectedRowsSha256?: string;
  maxRows: number;
  maxBytes: number;
}

const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const safe = (value: unknown): boolean =>
  value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value);

/** null 只代表原契约中明确的缺失，绝不从错误类型/非有限数值生成空值。 */
export function verifyProductionRows(input: ProductionRowsInput): { bytes: Buffer; sha256: string; rowCount: number } {
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > input.maxRows
    || !Number.isSafeInteger(input.maxRows) || input.maxRows < 1
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    return fail('PRODUCTION_ROW_BUDGET', '生产输出缺完整行集或超过固定预算；不得截取、补值或伪造成功。');
  }
  const fields = input.fields ? [...input.fields] : null;
  if (fields && (!fields.length || new Set(fields).size !== fields.length
    || fields.some(field => typeof field !== 'string' || !field.trim()))) {
    return fail('PRODUCTION_FIELDS_INVALID', '来源输出字段必须明确、非空且互不重复。');
  }
  const expectedFields = fields?.slice().sort().join('\u0000');
  for (const [index, row] of input.rows.entries()) {
    if (!isWfdRecord(row) || !Object.keys(row).length) {
      return fail('PRODUCTION_ROW_INVALID', `第 ${index + 1} 行缺少完整的对象输出。`);
    }
    if (expectedFields && Object.keys(row).sort().join('\u0000') !== expectedFields) {
      return fail('PRODUCTION_FIELDS_INVALID', `第 ${index + 1} 行不符合冻结的输出字段契约。`);
    }
    if (Object.values(row).some(value => !safe(value))) {
      return fail('PRODUCTION_VALUE_INVALID', `第 ${index + 1} 行存在未经声明的对象、数组或非有限标量；未转换为 null。`);
    }
  }
  const bytes = Buffer.from(canonicalWfdJson(input.kind === 'source' ? { rows: input.rows } : input.rows));
  if (bytes.byteLength > input.maxBytes) {
    return fail('PRODUCTION_OUTPUT_BUDGET', '完整生产输出超过冻结字节预算，未截断为成功结果。');
  }
  const sha256 = wfdSha256(bytes);
  if (input.expectedRowsSha256 !== undefined && sha256 !== input.expectedRowsSha256) {
    return fail('PRODUCTION_OUTPUT_CHANGED', '生产输出字节与冻结摘要不同；不接受旧核对标签。');
  }
  return { bytes, sha256, rowCount: input.rows.length };
}

/**
 * 固定算法进入数据生产核对门禁。公式/来源重读由当前登记的方法核验器负责，
 * 本模块先核输出，再核方法；既不接受客户端选引擎，也不建立另一个发布账本。
 */
export async function verifyProductionDerived<T>(
  input: Omit<ProductionRowsInput, 'kind' | 'fields'>,
  methodVerifier: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  verifyProductionRows({ ...input, kind: 'derived' });
  const result = await methodVerifier(signal);
  signal.throwIfAborted();
  return result;
}

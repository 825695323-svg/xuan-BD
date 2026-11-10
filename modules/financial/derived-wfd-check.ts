import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { ALGORITHM_METHODS, type AlgorithmComputedResult } from './algorithm-types.js';
import { buildStructuredIngestDocument, type R1StructuredRequest, type R1SourceRef } from '../collection/r1-structured-handoff.js';

export const DERIVED_WFD_CHECK_VERSION = 'bd.derived-wfd-check/1';
export interface DerivedWfdBinding {
  namespace: string;
  mode: 'production' | 'user_test';
  expectedParentSnapshotId: string | null;
}
export interface CheckedDerivedWfd {
  structured: R1StructuredRequest;
  source: R1SourceRef;
  originalBytes: Buffer;
  sourceSha256: string;
  resultSha256: string;
}

/**
 * 唯一派生核验（Independent Derived Check）。
 * 不解析原文件、不运行五步清洗、不认可模型提供的计算行：
 * 使用原算法任务保存的完整行、WFD 固定读回逐行身份和实际算法版本构造 WFD 文档。
 */
export function checkDerivedForWfd(result: AlgorithmComputedResult, binding: DerivedWfdBinding, requestId: string): CheckedDerivedWfd {
  const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
  if (result.status !== 'computed' || !result.taskId || !result.inputDigest || !result.methodVersion || !result.implementationVersion)
    fail('DERIVED_RESULT_INCOMPLETE', '算法结果身份、版本或固定输入摘要缺失。');
  if (result.environment === 'synthetic-test' && binding.mode === 'production')
    fail('DERIVED_SYNTHETIC_FORBIDDEN', '合成测试算法结果不能进入正式 WFD。');
  if (result.eligibility?.input.status !== 'eligible')
    fail('DERIVED_INPUT_INELIGIBLE', '原 WFD 快照输入尚未通过实际用途资格，不允许把计算结果作为正式派生数据。');
  if (!Object.hasOwn(ALGORITHM_METHODS, result.methodId))
    fail('DERIVED_METHOD_UNKNOWN', '原结果的算法未登记为可执行固定方法。');
  const method = ALGORITHM_METHODS[result.methodId];
  if (result.methodVersion !== method.version)
    fail('DERIVED_METHOD_CHANGED', '结果方法版本与当前固定算法定义不一致，不能改用新公式冒充旧结果。');
  const src = isWfdRecord(result.source) ? result.source : null;
  const resolution = src && isWfdRecord(src.resolution) ? src.resolution : null;
  const envelope = resolution && isWfdRecord(resolution.envelope) ? resolution.envelope : null;
  const fields = resolution && isWfdRecord(resolution.fields) ? resolution.fields : null;
  const sourceRows = envelope && Array.isArray(envelope.rows) ? envelope.rows : null;
  if (!src || src.kind !== 'wfd_fixed_snapshot' || typeof src.productId !== 'string'
    || typeof src.snapshotId !== 'string' || src.snapshotId === 'latest'
    || typeof src.definitionRevision !== 'string' || !src.definitionRevision
    || !sourceRows || !Array.isArray(result.rows) || sourceRows.length !== result.rows.length
    || !result.rows.length || result.rows.length > 5000 || !fields || !Array.isArray(fields.definitions))
    fail('DERIVED_SOURCE_INVALID', '缺少真实 WFD 固定快照、字段定义或等长来源行版本；不按模型声明补齐。');
  if (resolution?.snapshotId !== src.snapshotId || resolution?.productId !== src.productId
    || resolution?.rowCount !== result.rows.length || result.coverage.suppliedRows !== result.rows.length)
    fail('DERIVED_SOURCE_MISMATCH', '算法结果与实际 WFD 快照读取的产品、快照或记录数量不一致。');

  const original = Buffer.from(canonicalWfdJson(result.rows), 'utf8');
  const originalSha256 = wfdSha256(original), resultSha256 = wfdSha256(canonicalWfdJson(result));
  const mapped = isWfdRecord(src.fieldMapping) ? src.fieldMapping : {};
  const column = String(mapped.close ?? '');
  const sourceField = fields.definitions.find(item => isWfdRecord(item) && item.field_code === column);
  const priceUnit = isWfdRecord(sourceField) && typeof sourceField.unit_code === 'string' ? sourceField.unit_code : '';
  if (result.methodId !== 'bullish_engulfing' && !priceUnit)
    fail('DERIVED_UNIT_UNKNOWN', 'WFD 原字段没有正式单位定义，不能推定派生数值单位。');
  if (result.metadata.frequency !== '1d' || !result.metadata.timezone)
    fail('DERIVED_TIME_UNSUPPORTED', '当前固定算法派生入库仅接受有明确时区的日频观测。');
  const outputFields = [...method.outputFields];
  if (!outputFields.length || new Set(outputFields).size !== outputFields.length)
    fail('DERIVED_FIELDS_INVALID', '算法没有稳定且不重复的输出字段。');
  const productSubject = isWfdRecord(sourceRows[0]) && isWfdRecord(sourceRows[0].subject)
    ? sourceRows[0].subject : null;
  if (!productSubject || !['kind','namespace','id'].every(key => typeof productSubject[key] === 'string'))
    fail('DERIVED_SUBJECT_MISSING', '来源快照缺少已核对的业务主体身份。');
  const rows: WfdRecord[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const data = result.rows[i]!, observed = sourceRows[i];
    if (!isWfdRecord(observed) || !isWfdRecord(observed.observation_time)
      || typeof observed.business_key !== 'string' || !observed.business_key
      || !isWfdRecord(observed.subject) || canonicalWfdJson(observed.subject) !== canonicalWfdJson(productSubject))
      fail('DERIVED_SOURCE_ROW_INVALID', `第 ${i+1} 条 WFD 来源缺业务键、时态或一致主体。`);
    const time = observed.observation_time, start = time.earliest_utc, end = time.latest_exclusive_utc;
    if (time.status !== 'known' || typeof start !== 'string' || typeof end !== 'string'
      || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end))
      fail('DERIVED_SOURCE_TIME_INVALID', `第 ${i+1} 条 WFD 来源业务时间不是可核对的已知区间。`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(data.timestamp))
      fail('DERIVED_TIMESTAMP_INVALID', `第 ${i+1} 条算法日期格式不符合日频合同。`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: result.metadata.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(start));
    const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
    const day = [part('year'), part('month'), part('day')].join('-');
    if (day !== data.timestamp)
      fail('DERIVED_TIME_MISMATCH', `第 ${i+1} 条算法日期与 WFD 原观测起始日期不一致。`);
    const values: WfdRecord = {};
    for (const code of outputFields) {
      if (!Object.hasOwn(data, code)) fail('DERIVED_OUTPUT_FIELD_MISSING', `第 ${i+1} 条缺少算法输出 ${code}。`);
      const value = data[code], booleanField = code === 'bullish_engulfing';
      if (value === null) {
        values[code] = { data_type: booleanField ? 'boolean' : 'decimal',
          value_state: 'insufficient_warmup', value: null };
      } else if (booleanField) {
        if (typeof value !== 'boolean') fail('DERIVED_OUTPUT_TYPE', `第 ${i+1} 条 ${code} 不是布尔结果。`);
        values[code] = { data_type: 'boolean', value_state: 'valid_value', value };
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value) || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(String(value)))
          fail('DERIVED_OUTPUT_TYPE', `第 ${i+1} 条 ${code} 不是无损可写入的十进制数。`);
        values[code] = { data_type: 'decimal', value_state: 'valid_value', value: String(value) };
      }
    }
    rows.push({ business_key: 'derived:' + wfdSha256(canonicalWfdJson({
      key: observed.business_key, method: result.methodId, parameters: result.parameters })).slice(0, 48),
      subject: productSubject, observation_time: time, values });
  }
  if (rows.some((row, i) => i > 0 && row.business_key === rows[i-1]!.business_key)
    || new Set(rows.map(row => row.business_key)).size !== rows.length)
    fail('DERIVED_BUSINESS_KEYS', '不同来源行生成了相同的派生业务键，拒绝丢失观测。');
  const methodIdentity = wfdSha256(canonicalWfdJson({ method: result.methodId,
    version: result.methodVersion, implementation: result.implementationVersion }));
  const definitionVersion = 'v' + methodIdentity.slice(0, 20);
  const scopeIdentity = wfdSha256(canonicalWfdJson({
    sourceProduct: src.productId, methodId: result.methodId, methodVersion: result.methodVersion,
    parameters: result.parameters,
  }));
  const derivedCode = 'bd.derived.' + result.methodId + '.' + scopeIdentity.slice(0, 16);
  const math = result.methodId === 'ma'
    ? 'MA[t] = sum(close[t-N+1..t]) / N; full observation window only'
    : result.methodId === 'macd'
      ? 'DIFF = EMA12(close) - EMA26(close); DEA = EMA9(DIFF); MACD = 2*(DIFF-DEA)'
      : 'previous close < previous open; current close > current open; strict body engulfing';
  const constants = Object.fromEntries(Object.entries(
    isWfdRecord(result.parameters) ? result.parameters : {}).filter(([,v]) =>
    typeof v === 'number' || typeof v === 'boolean' || v === null));
  const definition: WfdRecord = {
    semantic_code: derivedCode,
    measurement_nature: 'derived', unit_code: 'per_field',
    definition_authority: binding.namespace, time_role: 'observation',
    field_definitions: outputFields.map(field => ({ field_code: field,
      data_type: field === 'bullish_engulfing' ? 'boolean' : 'decimal',
      unit_code: field === 'bullish_engulfing' ? 'boolean' : priceUnit,
      measurement_nature: 'derived', time_role: 'observation' })),
    semantic_context: { version: 'wfd.semantic-context/1.0',
      content_nature: 'deterministic_derived',
      measurement_nature: 'derived',
      time: { period_type: 'natural', frequency: 'day', interval: 'half_open',
        timezone: result.metadata.timezone },
      derivation: { required: true } },
    algorithm_definition: {
      mathematical_definition: math,
      result_semantics: method.description,
      definition_version: definitionVersion,
      algorithm_ref: { kind: 'algorithm', namespace: binding.namespace,
        id: result.methodId, version: definitionVersion,
        digest: 'sha256:' + methodIdentity },
      constants },
  };
  const requestTime = new Date(result.computedAt).toISOString();
  const source: R1SourceRef = {
    source_id: 'bd.algorithm.' + result.methodId, provider: 'BD 内置固定基础算法',
    requested_url: 'urn:bd:algorithm:' + result.taskId,
    requested_at_utc: requestTime, acquired_at_utc: requestTime,
    usage_scope: 'WFD 固定快照确定性派生结果正式入库',
    authorization: { status: 'authorized',
      basis: 'BD 已核实固定算法来源、实际 WFD 读回、原任务结果及本次派生发布边界。' },
    sha256: originalSha256, bytes: original.length,
  };
  const version = wfdSha256(canonicalWfdJson({ inputDigest: result.inputDigest,
    sourceProduct: src.productId, sourceSnapshot: src.snapshotId, method: result.methodId }));
  const structured: R1StructuredRequest = {
    datasetId: 'bd.derived.' + wfdSha256(src.productId).slice(0,24),
    namespace: binding.namespace, producerNamespace: binding.namespace,
    requestId, submissionDigest: 'sha256:' + '0'.repeat(64),
    expectedParentSnapshotId: binding.expectedParentSnapshotId,
    outputKey: derivedCode,
    subject: productSubject, definition, inputMode: 'partial_observation',
    coverage: { scope: { input_product: src.productId, input_snapshot: src.snapshotId,
      range_start: result.metadata.window_start, range_end: result.metadata.window_end },
      basis: 'fixed_wfd_derived_check:' + DERIVED_WFD_CHECK_VERSION + ':' + version.slice(0,16),
      completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows },
    duplicatePolicy: 'skip_identical_append',
  };
  const document = buildStructuredIngestDocument(structured);
  const unsigned = structuredClone(document);
  delete (unsigned.request_identity as WfdRecord).submission_digest;
  structured.submissionDigest = 'sha256:' + wfdSha256(canonicalWfdJson(unsigned));
  return { structured, source, originalBytes: original, sourceSha256: originalSha256, resultSha256 };
}

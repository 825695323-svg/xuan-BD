import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { ALGORITHM_METHODS, ALGORITHM_NULL_STATES, MACD_SEMANTICS, isAlgorithmMethodId, type AlgorithmComputedResult, type AlgorithmData } from './algorithm-types.js';
import { verifyAlgorithmNumbers } from './algorithm-reference.js';
import { indexAlgorithmDiagnostics, normalizeDecimal } from './algorithm-service.js';
import { matchesVolumeDefinition } from './product-machine-snapshot.js';
import { add, negative, readExactDecimal } from '../collection/numeric-precision.js';
import { checkR1Cell } from '../collection/r1-tabular.js';
import { buildStructuredIngestDocument, type R1StructuredRequest, type R1SourceRef } from '../collection/r1-structured-handoff.js';

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

const MAX_SCALE = 18, MAX_PRECISION = 38;
const PUBLICATION_NOTES = `按原任务浮点值的最短往返十进制文本发布。超过 ${MAX_SCALE} 位小数时使用半偶舍入（round-half-even），去除小数尾零。原始浮点计算值保留在原算法任务结果中。`;
const publicationFormat = new Intl.NumberFormat('en-US', {
  useGrouping: false, maximumFractionDigits: MAX_SCALE, roundingMode: 'halfEven',
});
const halfQuantumDenominator = 2n * 10n ** BigInt(MAX_SCALE);

function fail(code: string, message: string): never { throw new TaskError(code, message); }

function publicationDecimal(value: number, code: string): string {
  const shortest: `${number}` = `${value}`;
  const original = normalizeDecimal(shortest);
  if ((original.split('.')[1]?.length ?? 0) <= MAX_SCALE) return original;
  const published = normalizeDecimal(publicationFormat.format(shortest));
  // 重读最终串，用精确有理数核对半个发布量子，避免转回 binary64 掩盖误差。
  const error = add(readExactDecimal(published, code), negative(readExactDecimal(original, code)));
  if ((error.n < 0n ? -error.n : error.n) * halfQuantumDenominator > error.d)
    fail('DERIVED_ROUNDING_MISMATCH', `${code} 的发布十进制与原计算值相差超过半个最小发布单位。`);
  return published;
}

/**
 * 唯一派生核验（Independent Derived Check）。
 * 不解析原文件、不运行五步清洗、不认可模型提供的计算行：
 * 使用原算法任务保存的完整行、WFD 固定读回逐行身份和实际算法版本构造 WFD 文档。
 */
export function checkDerivedForWfd(result: AlgorithmComputedResult, binding: DerivedWfdBinding, requestId: string,
  input: AlgorithmData, frozenDocument?: WfdRecord): CheckedDerivedWfd {
  if (result.status !== 'computed' || !result.taskId || !result.inputDigest || !result.methodVersion || !result.implementationVersion)
    fail('DERIVED_RESULT_INCOMPLETE', '算法结果身份、版本或固定输入摘要缺失。');
  if (binding.mode === 'production' && (result.environment === 'synthetic-test' || result.metadata.synthetic === true))
    fail('DERIVED_SYNTHETIC_FORBIDDEN', '合成测试算法结果不能进入正式 WFD。');
  if (result.eligibility?.input.status !== 'eligible')
    fail('DERIVED_INPUT_INELIGIBLE', '原 WFD 快照输入尚未通过实际用途资格，不允许把计算结果作为正式派生数据。');
  if (!isAlgorithmMethodId(result.methodId))
    fail('DERIVED_METHOD_UNKNOWN', '原结果的算法未登记为可执行固定方法。');
  const method = ALGORITHM_METHODS[result.methodId];
  const macd = result.methodId === 'macd';
  if (result.methodVersion !== method.version)
    fail('DERIVED_METHOD_CHANGED', '结果方法版本与当前固定算法定义不一致，不能改用新公式冒充旧结果。');
  const src = isWfdRecord(result.source) ? result.source : null;
  const resolution = src && isWfdRecord(src.resolution) ? src.resolution : null;
  const envelope = resolution && isWfdRecord(resolution.envelope) ? resolution.envelope : null;
  const fields = resolution && isWfdRecord(resolution.fields) ? resolution.fields : null;
  const sourceRows = envelope && Array.isArray(envelope.rows) ? envelope.rows : null;
  if (!src || src.kind !== 'wfd_fixed_snapshot' || typeof src.instanceId !== 'string'
    || !src.instanceId || typeof src.productId !== 'string'
    || typeof src.snapshotId !== 'string' || src.snapshotId === 'latest'
    || typeof src.definitionRevision !== 'string' || !src.definitionRevision
    || !sourceRows || !Array.isArray(result.rows) || sourceRows.length !== result.rows.length
    || !result.rows.length || result.rows.length > 5000 || !fields || !Array.isArray(fields.definitions))
    fail('DERIVED_SOURCE_INVALID', '缺少真实 WFD 固定快照、字段定义或等长来源行版本；不按模型声明补齐。');
  const verifiedSrc = src as WfdRecord;
  const verifiedFields = fields as WfdRecord;
  const verifiedSourceRows = sourceRows as unknown[];
  if (resolution?.snapshotId !== verifiedSrc.snapshotId || resolution?.productId !== verifiedSrc.productId
    || resolution?.instanceId !== verifiedSrc.instanceId
    || resolution?.rowCount !== result.rows.length || result.coverage.suppliedRows !== result.rows.length)
    fail('DERIVED_SOURCE_MISMATCH', '算法结果与实际 WFD 快照读取的产品、快照或记录数量不一致。');

  verifyAlgorithmNumbers(result, input);
  const mapped = isWfdRecord(verifiedSrc.fieldMapping) ? verifiedSrc.fieldMapping : {};
  const column = String(mapped.close ?? '');
  const definitions = (verifiedFields.definitions as unknown[]).filter(isWfdRecord);
  const sourceField = definitions.find(item => item.field_code === column);
  const priceUnit = isWfdRecord(sourceField) && typeof sourceField.unit_code === 'string' ? sourceField.unit_code : '';
  if (!priceUnit)
    fail('DERIVED_UNIT_UNKNOWN', 'WFD 原字段没有正式单位定义，不能推定派生数值单位。');
  const volumeUnit = result.metadata.volume_unit;
  if (method.requiredFields.includes('volume')) {
    const semantics = isWfdRecord(verifiedSrc.semantics) ? verifiedSrc.semantics : {};
    const volumeField = definitions.find(item => item.field_code === mapped.volume);
    if (typeof mapped.volume !== 'string' || !mapped.volume || volumeUnit !== semantics.volumeUnit
      || !matchesVolumeDefinition(volumeField, volumeUnit)) {
      fail('DERIVED_UNIT_UNKNOWN', `${method.operation} 须映射数值型成交量字段，且声明单位须与其固定数量单位一致。`);
    }
  }
  if (result.metadata.frequency !== '1d' || !result.metadata.timezone)
    fail('DERIVED_TIME_UNSUPPORTED', '当前固定算法派生入库仅接受有明确时区的日频观测。');
  const outputFields = [...method.outputFields];
  if (!outputFields.length || new Set(outputFields).size !== outputFields.length)
    fail('DERIVED_FIELDS_INVALID', '算法没有稳定且不重复的输出字段。');
  const productSubject = isWfdRecord(verifiedSourceRows[0]) && isWfdRecord(verifiedSourceRows[0].subject)
    ? verifiedSourceRows[0].subject : null;
  if (!productSubject || !['kind','namespace','id'].every(key => typeof productSubject[key] === 'string'))
    fail('DERIVED_SUBJECT_MISSING', '来源快照缺少已核对的业务主体身份。');
  const rows: WfdRecord[] = [];
  const reasons = indexAlgorithmDiagnostics(macd ? [] : result.diagnostics ?? [], 'DERIVED_NULL_REASON_MISSING');
  const columnDigits = new Map<string, { integer: number; scale: number }>();
  for (let i = 0; i < result.rows.length; i++) {
    const data = result.rows[i]!, observed = verifiedSourceRows[i];
    if (!isWfdRecord(observed) || !isWfdRecord(observed.observation_time)
      || typeof observed.business_key !== 'string' || !observed.business_key
      || !isWfdRecord(observed.subject) || canonicalWfdJson(observed.subject) !== canonicalWfdJson(productSubject))
      fail('DERIVED_SOURCE_ROW_INVALID', `第 ${i+1} 条 WFD 来源缺业务键、时态或一致主体。`);
    const validObserved = observed as WfdRecord;
    const time = validObserved.observation_time as WfdRecord, start = time.earliest_utc, end = time.latest_exclusive_utc;
    if (time.status !== 'known' || typeof start !== 'string' || typeof end !== 'string'
      || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end))
      fail('DERIVED_SOURCE_TIME_INVALID', `第 ${i+1} 条 WFD 来源业务时间不是可核对的已知区间。`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(data.timestamp))
      fail('DERIVED_TIMESTAMP_INVALID', `第 ${i+1} 条算法日期格式不符合日频合同。`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: result.metadata.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(String(start)));
    const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
    const day = [part('year'), part('month'), part('day')].join('-');
    if (day !== data.timestamp)
      fail('DERIVED_TIME_MISMATCH', `第 ${i+1} 条算法日期与 WFD 原观测起始日期不一致。`);
    const values: WfdRecord = {};
    for (const code of outputFields) {
      if (!Object.hasOwn(data, code)) fail('DERIVED_OUTPUT_FIELD_MISSING', `第 ${i+1} 条缺少算法输出 ${code}。`);
      const value = data[code];
      let cell: { data_type: 'decimal'; value_state: string; value: string | null };
      if (!macd && value === null) {
        const key = `${data.timestamp}/${code}`, reason = reasons.get(key);
        if (!reason) fail('DERIVED_NULL_REASON_MISSING', `${data.timestamp} 的 ${code} 空值缺少对应的合法诊断。`);
        cell = { data_type: 'decimal', value_state: ALGORITHM_NULL_STATES[reason], value: null };
        reasons.delete(key);
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value) || (macd && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(String(value))))
          fail('DERIVED_OUTPUT_TYPE', `第 ${i+1} 条 ${code} 不是无损可写入的十进制数。`);
        cell = { data_type: 'decimal', value_state: 'valid_value', value: macd ? String(value) : publicationDecimal(value, code) };
      }
      checkR1Cell('decimal', cell.value_state, cell.value, code);
      if (!macd && cell.value !== null) {
        // WFD 为整列选择同一个 DECIMAL，最多整数位和最多小数位可能来自不同行。
        const [whole, fraction = ''] = cell.value.split('.'), prior = columnDigits.get(code);
        const integer = Math.max(prior?.integer ?? 0, whole.replace(/^-/, '').length);
        const scale = Math.max(prior?.scale ?? 0, fraction.length);
        if (integer + scale > MAX_PRECISION)
          fail('DERIVED_COLUMN_PRECISION', `${code} 的整列需要 ${integer} 位整数和 ${scale} 位小数，超过 WFD 精度 ${MAX_PRECISION}。`);
        columnDigits.set(code, { integer, scale });
      }
      values[code] = cell;
    }
    rows.push({ business_key: 'derived:' + wfdSha256(canonicalWfdJson({
      key: validObserved.business_key, method: result.methodId, parameters: result.parameters })).slice(0, 48),
      subject: productSubject, observation_time: time, values });
  }
  if (rows.some((row, i) => i > 0 && row.business_key === rows[i-1]!.business_key)
    || new Set(rows.map(row => row.business_key)).size !== rows.length)
    fail('DERIVED_BUSINESS_KEYS', '不同来源行生成了相同的派生业务键，拒绝丢失观测。');
  if (reasons.size) fail('DERIVED_NULL_REASON_MISSING', '存在无法匹配到输出空值的计算诊断。');
  const mathDefinition = macd ? { method: result.methodId,
    version: result.methodVersion, semantics: MACD_SEMANTICS } : {
    version: result.methodVersion, semantics: { outputs: method.outputs, resultSemantics: method.resultSemantics },
    parameters: result.parameters,
  };
  let definitionVersion = 'v' + wfdSha256(canonicalWfdJson(macd ? mathDefinition
    : { ...mathDefinition, publication: PUBLICATION_NOTES })).slice(0, 20);
  const originalSemantics = macd ? MACD_SEMANTICS.resultSemantics
    : `${method.resultSemantics} 本次参数为 ${canonicalWfdJson(result.parameters)}。`;
  let resultSemantics = macd ? originalSemantics : `${originalSemantics} ${PUBLICATION_NOTES}`;
  if (frozenDocument) {
    // 只读旧请求的冻结身份，不给新准备增加旧路径，也不执行旧算法源码。
    const outputs = frozenDocument.outputs;
    const output = Array.isArray(outputs) && outputs.length === 1 && isWfdRecord(outputs[0]) ? outputs[0] : null;
    const algorithm = output && isWfdRecord(output.definition) && isWfdRecord(output.definition.algorithm_definition)
      ? output.definition.algorithm_definition : null;
    const legacyVersion = 'v' + wfdSha256(canonicalWfdJson(macd ? { method: result.methodId,
      version: result.methodVersion, implementation: result.implementationVersion } : mathDefinition)).slice(0, 20);
    const frozenVersion = typeof algorithm?.definition_version === 'string' ? algorithm.definition_version : '';
    if (frozenVersion !== definitionVersion && frozenVersion !== legacyVersion)
      fail('DERIVED_FROZEN_DEFINITION_CHANGED', '原请求的冻结数学定义身份与已核验结果不一致。');
    definitionVersion = frozenVersion;
    if (definitionVersion === legacyVersion) {
      // 沿用旧文案只为精确读回已经冻结、且逐格通过当前协议的文档。
      if (!macd && result.rows.some((row, index) => {
        const cells = rows[index].values as Record<string, { value: string | null }>;
        return outputFields.some(field => row[field] === null || normalizeDecimal(String(row[field])) !== cells[field].value);
      })) fail('DERIVED_FROZEN_DOCUMENT_CHANGED', '旧定义无法原样表达此次空值状态或发布精度。');
      resultSemantics = macd ? '调用既有 12/26/9 MACD 实现，以所供窗口首条收盘价初始化短、长 EMA 与 DEA；返回 DIFF、DEA、MACD 和 ZERO。'
        : originalSemantics;
    }
  }
  const scopeIdentity = wfdSha256(canonicalWfdJson({
    sourceProduct: verifiedSrc.productId, methodId: result.methodId, methodVersion: result.methodVersion,
    parameters: result.parameters,
  }));
  const derivedCode = 'bd.derived.' + result.methodId + '.' + scopeIdentity.slice(0, 16);
  const math = macd ? MACD_SEMANTICS.mathematicalDefinition
    : outputFields.map(field => method.outputs[field]!.expression).join('；');
  const constants = Object.fromEntries(Object.entries(
    isWfdRecord(result.parameters) ? result.parameters : {}).filter(([,v]) =>
    typeof v === 'number' || typeof v === 'boolean' || v === null));
  const definition: WfdRecord = {
    semantic_code: derivedCode,
    measurement_nature: 'derived', unit_code: 'per_field',
    definition_authority: binding.namespace, time_role: 'observation',
    field_definitions: outputFields.map(field => {
      const unit = method.outputs[field]!.unit;
      return { field_code: field, data_type: 'decimal',
        unit_code: unit === 'close' ? priceUnit : unit === 'volume' ? volumeUnit : unit,
        measurement_nature: 'derived', time_role: 'observation' };
    }),
    semantic_context: { version: 'wfd.semantic-context/1.0',
      content_nature: 'deterministic_derived',
      measurement_nature: 'derived',
      time: { period_type: 'natural', frequency: 'day', interval: 'half_open',
        timezone: result.metadata.timezone },
      derivation: { required: true } },
    algorithm_definition: {
      mathematical_definition: math,
      result_semantics: resultSemantics,
      definition_version: definitionVersion,
      // 不伪造尚未在 WFD 正式登记的算法引用；用真实公式、版本及 BD 内部冻结证明关联。
      constants },
  };
  const requestTime = new Date(result.computedAt).toISOString();
  const original = Buffer.from(canonicalWfdJson(result.rows), 'utf8');
  const originalSha256 = wfdSha256(original), resultSha256 = wfdSha256(canonicalWfdJson(result));
  const source: R1SourceRef = {
    source_id: 'bd.algorithm.' + result.methodId, provider: 'BD 内置固定基础算法',
    requested_url: 'urn:bd:algorithm:' + result.taskId,
    requested_at_utc: requestTime, acquired_at_utc: requestTime,
    usage_scope: 'WFD 固定快照确定性派生结果正式入库',
    authorization: { status: 'authorized',
      basis: 'BD 已核实固定算法来源、实际 WFD 读回、原任务结果及本次派生发布边界。' },
    sha256: originalSha256, bytes: original.length,
  };
  const structured: R1StructuredRequest = {
    datasetId: 'bd.derived.' + wfdSha256(String(verifiedSrc.productId)).slice(0,24),
    namespace: binding.namespace, producerNamespace: binding.namespace,
    requestId, submissionDigest: 'sha256:' + '0'.repeat(64),
    expectedParentSnapshotId: binding.expectedParentSnapshotId,
    outputKey: derivedCode,
    subject: productSubject as WfdRecord, definition, inputMode: 'partial_observation',
    coverage: { scope: { input_product: verifiedSrc.productId, input_snapshot: verifiedSrc.snapshotId,
      range_start: result.metadata.window_start, range_end: result.metadata.window_end },
      basis: 'observed_partial',
      completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows },
    duplicatePolicy: 'skip_identical_append',
  };
  const document = buildStructuredIngestDocument(structured);
  const unsigned = structuredClone(document);
  delete (unsigned.request_identity as WfdRecord).submission_digest;
  structured.submissionDigest = 'sha256:' + wfdSha256(canonicalWfdJson(unsigned));
  if (frozenDocument && canonicalWfdJson(buildStructuredIngestDocument(structured)) !== canonicalWfdJson(frozenDocument))
    fail('DERIVED_FROZEN_DOCUMENT_CHANGED', '原请求的输入范围、目标、数值或正式声明变化；不能沿原身份改写。');
  return { structured, source, originalBytes: original, sourceSha256: originalSha256, resultSha256 };
}

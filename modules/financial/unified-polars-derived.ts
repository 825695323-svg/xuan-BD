import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument, type R1SourceRef, type R1StructuredRequest } from '../collection/r1-structured-handoff.js';
import { FINANCIAL_LINEAR_ADMISSION_VERSION, financialAlgorithmDefinition } from '../collection/data-processing/financial-fixed.js';
import { macroYoYAlgorithmDefinition } from '../collection/data-processing/polars-fixed.js';
import type { UnifiedPolarsResult } from './unified-polars-execution.js';

export const UNIFIED_STRUCTURED_DERIVED_VERSION = 'bd.unified-structured-derived/1';
export interface UnifiedStructuredBinding {
  namespace: string;
  mode: 'production' | 'user_test';
  expectedParentSnapshotId: string | null;
}
export interface CheckedStructuredDerived {
  structured: R1StructuredRequest;
  source: R1SourceRef;
  originalBytes: Buffer;
  sourceSha256: string;
  resultSha256: string;
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const valid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
const utc = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value));

/** 将已通过方法专属独立数值复核的单值候选，映射到唯一 R1 数据提交合同。 */
export function checkUnifiedStructuredForWfd(
  result: UnifiedPolarsResult, binding: UnifiedStructuredBinding, requestId: string,
): CheckedStructuredDerived {
  if (!result || result.version !== 'bd.algorithms.polars/1' || result.publication !== 'candidate_only'
    || !valid(result.taskId) || !valid(requestId) || !valid(binding.namespace)
    || !['production', 'user_test'].includes(binding.mode)
    || !utc(result.computedAt) || !Array.isArray(result.rows) || result.rows.length !== 1
    || !isWfdRecord(result.evidence) || !isWfdRecord(result.algorithmDefinition)
    || result.inputDigest.length !== 64 || !/^[a-f0-9]{64}$/u.test(result.inputDigest)
    || digest(result.rows) !== result.candidateSha256
    || result.evidence.algorithmDefinition === undefined
    || canonicalWfdJson(result.evidence.algorithmDefinition) !== canonicalWfdJson(result.algorithmDefinition)) {
    return fail('UNIFIED_DERIVED_INVALID', '固定计算结果、原始证明、方法版本或候选行数不完整。');
  }
  if (result.methodId === 'financial_linear'
    && (result.methodVersion !== FINANCIAL_LINEAR_ADMISSION_VERSION
      || !['quarter_difference', 'ttm'].includes((result.calculation as { operation?: string }).operation ?? '')
      || digest(result.algorithmDefinition) !== digest(financialAlgorithmDefinition(
        (result.calculation as { operation: 'quarter_difference' | 'ttm' }).operation)))) {
    return fail('UNIFIED_DERIVED_METHOD', '固定财务单季/近十二个月方法身份或实际公式发生变化。');
  }
  if (result.methodId === 'macro_yoy'
    && (result.methodVersion !== 'bd.macro-yoy/1'
      || digest(result.algorithmDefinition) !== digest(macroYoYAlgorithmDefinition()))) {
    return fail('UNIFIED_DERIVED_METHOD', '固定宏观同比方法身份或实际公式发生变化。');
  }

  const actual = result.rows[0]!, isFinancial = result.methodId === 'financial_linear';
  const key = actual.business_key, start = actual.start_utc, end = actual.end_utc, value = actual.value;
  if (!valid(key) || !utc(start) || !utc(end) || Date.parse(start as string) >= Date.parse(end as string)
    || typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
    || actual.value_state !== 'valid_value' || result.candidateSha256.length !== 64
    || result.implementationVersion !== result.evidence.workerSha256) {
    return fail('UNIFIED_DERIVED_VALUE', '派生候选必须具有明确来源、期间、有效精确十进制值和冻结工作器。');
  }
  const unitCode = isFinancial ? 'cny' : 'percent';
  const namespace = isFinancial ? actual.subject_scheme : binding.namespace;
  const subjectId = isFinancial ? actual.subject_code : actual.region;
  if (!valid(namespace) || !valid(subjectId) || isFinancial && (actual.currency !== 'CNY' || actual.unit !== 'cny')
    || !isFinancial && actual.unit !== 'percent') {
    return fail('UNIFIED_DERIVED_SUBJECT', '财务/宏观派生主体或原始人民币元/百分比单位不可核对。');
  }
  const subject = { kind: isFinancial ? 'entity' : 'region', namespace, id: subjectId };
  const methodIdentity = digest({ method: result.methodId, version: result.methodVersion,
    implementation: result.implementationVersion, calculation: result.calculation });
  const outputKey = 'bd.derived.' + result.methodId + '.' + methodIdentity.slice(0, 18);
  const field = { field_code: 'value', data_type: 'decimal', unit_code: unitCode,
    measurement_nature: 'derived', time_role: 'observation' };
  const definition: WfdRecord = {
    semantic_code: outputKey, measurement_nature: 'derived', unit_code: 'per_field',
    definition_authority: binding.namespace, time_role: 'observation',
    field_definitions: [field],
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'deterministic_derived',
      measurement_nature: 'derived', derivation: { required: true } },
    algorithm_definition: result.algorithmDefinition,
  };
  const timestamp = { status: 'known', precision: 'second',
    earliest_utc: start, latest_exclusive_utc: end, source_timezone: 'UTC' };
  const structured: R1StructuredRequest = {
    datasetId: 'bd.derived.' + digest({ method: result.methodId, subject }).slice(0, 24),
    namespace: binding.namespace, producerNamespace: binding.namespace,
    requestId, submissionDigest: 'sha256:' + '0'.repeat(64),
    expectedParentSnapshotId: binding.expectedParentSnapshotId,
    outputKey, subject, definition, inputMode: 'partial_observation',
    coverage: { scope: { algorithmTaskId: result.taskId,
      inputDigest: result.inputDigest, sourceEvidenceSha256: digest(result.evidence),
      intervalStart: start, intervalEnd: end },
      basis: 'fixed_wfd_derived_check:' + UNIFIED_STRUCTURED_DERIVED_VERSION,
      completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'scalar_rows', rows: [{
      business_key: key, observation_time: timestamp, value_decimal: value, value_state: 'valid_value',
    }] },
    duplicatePolicy: 'skip_identical_append',
  };
  const document = buildStructuredIngestDocument(structured), unsigned = structuredClone(document);
  delete (unsigned.request_identity as WfdRecord).submission_digest;
  structured.submissionDigest = 'sha256:' + digest(unsigned);
  const originalBytes = Buffer.from(canonicalWfdJson(result.rows), 'utf8');
  const sourceSha256 = wfdSha256(originalBytes);
  const requestTime = new Date(result.computedAt).toISOString();
  const source: R1SourceRef = {
    source_id: 'bd.algorithm.' + result.methodId, provider: 'BD 固定金融算法：统一 Polars 执行器',
    requested_url: 'urn:bd:algorithm:' + result.taskId,
    requested_at_utc: requestTime, acquired_at_utc: requestTime,
    usage_scope: 'WFD 固定快照确定性金融派生结果正式发布',
    authorization: { status: 'authorized', basis: 'BD 原计算任务与真实 WFD 版本、方法公式、证据和结果已通过独立核验。' },
    sha256: sourceSha256, bytes: originalBytes.length,
  };
  return { structured, source, originalBytes, sourceSha256, resultSha256: digest(result) };
}

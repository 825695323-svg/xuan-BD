import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument, type R1SourceRef, type R1StructuredRequest } from '../collection/r1-structured-handoff.js';
import type { UnifiedPolarsResult } from './unified-polars-execution.js';
import { WFD_SOURCE_MA_VERSION, evaluateWfdMA20, type WfdSourceMACalculation } from './wfd-source-ma.js';
import type { UnifiedStructuredBinding, CheckedStructuredDerived } from './unified-polars-derived.js';

const fail = (message: string): never => { throw new TaskError('WFD_MA_DERIVED', message); };
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(v);
const utc = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value));

/**
 * Official WFD-only MA20 publication. All source observations, including incomplete
 * warm-up and missing windows, remain explicit scalar rows. No selection/truncation.
 */
export function checkWfdMADerivedForWfd(
  result: UnifiedPolarsResult, binding: UnifiedStructuredBinding, requestId: string,
): CheckedStructuredDerived {
  const evidence = result.evidence;
  const calculation = result.calculation as WfdSourceMACalculation;
  if (result.methodId !== 'source_observation_ma'
    || result.methodVersion !== WFD_SOURCE_MA_VERSION
    || result.publication !== 'candidate_only' || !id(result.taskId) || !id(requestId)
    || !id(binding.namespace) || !['production', 'user_test'].includes(binding.mode)
    || !utc(result.computedAt) || !Array.isArray(result.rows) || !result.rows.length
    || result.rows.length > 5000 || !isWfdRecord(evidence)
    || evidence.version !== WFD_SOURCE_MA_VERSION || evidence.historicalQualification !== 'not_asserted'
    || !Array.isArray(evidence.frozenInput) || !isWfdRecord(evidence.subject)
    || !id(evidence.unitCode) || !isWfdRecord(evidence.algorithmDefinition)
    || evidence.workerSha256 !== result.implementationVersion
    || digest(result.rows) !== result.candidateSha256
    || digest(result.algorithmDefinition) !== digest(evidence.algorithmDefinition)
    || digest(result.rows) !== digest(evaluateWfdMA20(evidence.frozenInput as never, String(evidence.unitCode ?? '')))
    || digest(calculation) !== digest(evidence.fixedCalculation)
    || typeof evidence.sourceRowsSha256 !== 'string'
    || typeof evidence.recordVersionsSha256 !== 'string') fail('全量均线结果缺少原始 WFD 来源、独立精确公式证明或有效冻结版本。');
  const subject = evidence.subject as WfdRecord;
  if (!id(subject.kind) || !id(subject.namespace) || !id(subject.id))
    fail('WFD 来源主体或市场口径不确定。');
  const unit = evidence.unitCode as string;
  for (const row of result.rows) {
    if (!isWfdRecord(row) || !utc(row.start_utc) || !utc(row.end_utc)
      || Date.parse(row.start_utc as string) >= Date.parse(row.end_utc as string)
      || !id(row.business_key) || row.unit !== unit
      || !['valid', 'warmup', 'window_missing'].includes(String(row.calculation_status))
      || (row.calculation_status === 'valid'
        ? typeof row.value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(row.value)
          || row.value_state !== 'valid_value'
        : row.value !== null || row.value_state !== 'unknown'))
      fail('均线结果包含越界、错值或将预热/缺失当有效数字的行。');
  }
  const methodIdentity = digest({ method: result.methodId, version: result.methodVersion,
    implementation: result.implementationVersion, calculation: result.calculation });
  const outputKey = 'bd.derived.source_observation_ma.' + methodIdentity.slice(0, 18);
  const definition: WfdRecord = {
    semantic_code: outputKey, measurement_nature: 'derived', unit_code: unit,
    definition_authority: binding.namespace, time_role: 'observation',
    field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: unit,
      measurement_nature: 'derived', time_role: 'observation' }],
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'deterministic_derived',
      measurement_nature: 'derived', derivation: { required: true } },
    algorithm_definition: result.algorithmDefinition,
  };
  const payloadRows = result.rows.map(row => ({
    business_key: 'ma20_' + digest({ logicalKey: row.business_key, methodIdentity }).slice(0, 32),
    observation_time: { status: 'known', precision: 'day',
      earliest_utc: row.start_utc, latest_exclusive_utc: row.end_utc,
      source_timezone: evidence.timeZone },
    value_decimal: row.value,
    value_state: row.calculation_status === 'warmup' ? 'insufficient_warmup'
      : row.calculation_status === 'window_missing' ? 'unknown' : 'valid_value',
  }));
  const structured: R1StructuredRequest = {
    datasetId: 'bd.derived.' + digest({ method: result.methodId, subject }).slice(0, 24),
    namespace: binding.namespace, producerNamespace: binding.namespace,
    requestId, submissionDigest: 'sha256:' + '0'.repeat(64),
    expectedParentSnapshotId: binding.expectedParentSnapshotId,
    outputKey, subject, definition, inputMode: 'partial_observation',
    coverage: { scope: { algorithmTaskId: result.taskId,
      sourceSnapshotId: calculation.snapshotId, sourceProductId: calculation.productId,
      sourceRowsSha256: evidence.sourceRowsSha256, recordVersionsSha256: evidence.recordVersionsSha256,
      sourceRowCount: result.rows.length, historyQualification: 'not_asserted' },
      basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'scalar_rows', rows: payloadRows },
    duplicatePolicy: 'skip_identical_append',
  };
  const document = buildStructuredIngestDocument(structured), unsigned = structuredClone(document);
  delete (unsigned.request_identity as WfdRecord).submission_digest;
  structured.submissionDigest = 'sha256:' + digest(unsigned);
  const originalBytes = Buffer.from(canonicalWfdJson(result.rows));
  const sourceSha256 = wfdSha256(originalBytes), requestTime = new Date(result.computedAt).toISOString();
  const source: R1SourceRef = {
    source_id: 'bd.algorithm.source_observation_ma',
    provider: 'BD 固定金融算法：统一 Polars 执行器',
    requested_url: 'urn:bd:algorithm:' + result.taskId,
    requested_at_utc: requestTime, acquired_at_utc: requestTime,
    usage_scope: 'WFD 固定快照完整来源序列的确定性均线；不宣称历史可得',
    authorization: { status: 'authorized',
      basis: '原计算任务、冻结快照全量读取、Polars MA20 和独立 BigInt 十进制复核。' },
    sha256: sourceSha256, bytes: originalBytes.length,
  };
  return { structured, source, originalBytes, sourceSha256, resultSha256: digest(result) };
}

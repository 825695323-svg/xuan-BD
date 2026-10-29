import { TaskError } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import { canonical, financialDigest } from '../../plugins/financial/local-compute/assets.js';
import { requireFinancialComputedResult } from '../../modules/financial/contracts.js';
import { FINANCIAL_CAPABILITIES, type FinancialOutputIdentity, type FinancialSnapshotInput } from '../../modules/financial/types.js';
import { FINANCIAL_PLUGIN_ID } from '../../modules/financial/types.js';
import { wfdSha256, type WfdEnvelope, type WfdRecord } from './wfd-transport.js';

export const FINANCIAL_FLOAT_ENCODING = 'binary64_hex_be/v1';
const SHA = /^[0-9a-f]{64}$/;
export interface FinancialPublicationInputLineage {
  reference: FinancialSnapshotInput;
  descriptorSha256: string;
  rowsResourceSha256: string;
  lineageSha256: string;
}
export interface FinancialPublicationTarget {
  datasetId: string;
  datasetMappingVersion: string;
  outputIdentity: FinancialOutputIdentity;
  /** 目标的旧版本；绝不使用输入行情快照作为目标父版本。 */
  parentSnapshotId: string | null;
  purpose: 'user_test' | 'isolation_test';
}
export interface FinancialPublicationField {
  name: string; dtype: 'string' | 'binary64_hex' | 'boolean'; role: 'key' | 'metadata' | 'value';
  unit: string; scale: '1'; nullable: boolean;
}
export interface FinancialPublicationCandidate {
  state: 'candidate'; resultId: string; sourceTaskId: string; sourceAttemptId: string;
  target: FinancialPublicationTarget;
  inputLineage: FinancialPublicationInputLineage;
  table: { fields: FinancialPublicationField[]; primaryKey: ['series_id', 'timestamp']; rowCount: number;
    rows: Array<Record<string, string | boolean | null>> };
  computation: JsonValue;
  candidateSha256: string;
}

/** WFD 冻结的二进制位编码；包括负零在内都保留原浮点位。 */
export function encodeFinancialBinary64Hex(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TaskError('FINANCIAL_PUBLICATION_NUMERIC_INVALID', '二进制64位结果必须是有限数。');
  const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return bytes.toString('hex');
}

/** 纯候选构造器；不创建提交编号、不发网络请求、不修改任务或数据库。 */
export function createFinancialPublicationCandidate(task: TaskRecord, configuration: {
  target: FinancialPublicationTarget; inputLineage: FinancialPublicationInputLineage;
}): FinancialPublicationCandidate {
  const computed = requireFinancialComputedResult(task), target = configuration.target, lineage = configuration.inputLineage;
  if (computed.capabilityId !== FINANCIAL_CAPABILITIES[0] && computed.capabilityId !== FINANCIAL_CAPABILITIES[1]) {
    throw new TaskError('FINANCIAL_PUBLICATION_UNSUPPORTED', '该方法没有已登记的派生保存目标，不能映射到既有均线或形态目标。');
  }
  for (const value of [target.datasetId, target.datasetMappingVersion, ...Object.values(target.outputIdentity)]) identifier(value);
  if (target.parentSnapshotId !== null) fixedSnapshot(target.parentSnapshotId);
  if (!['user_test', 'isolation_test'].includes(target.purpose)
    || (target.purpose === 'isolation_test' && computed.metadata.synthetic !== true)) {
    throw new TaskError('FINANCIAL_PUBLICATION_SCOPE_INVALID', '真实输入只能在获准 user_test（用户测试）目标保存。');
  }
  if (!lineage || !SHA.test(lineage.descriptorSha256) || !SHA.test(lineage.rowsResourceSha256) || !SHA.test(lineage.lineageSha256)
    || financialDigest(lineage.reference) !== financialDigest(computed.inputReference) || lineage.reference.kind !== 'snapshot') {
    throw new TaskError('FINANCIAL_PUBLICATION_INPUT_UNBOUND', '正式结果候选需要原计算固定快照的实际声明、资源与谱系摘要。');
  }
  fixedSnapshot(lineage.reference.snapshotId);
  if (!task.currentAttemptId) throw new TaskError('FINANCIAL_RESULT_UNAVAILABLE', '结果没有实际计算尝试身份。');
  const ma = computed.capabilityId === FINANCIAL_CAPABILITIES[0], field = ma ? 'MA' : 'bullish_engulfing';
  const fields: FinancialPublicationField[] = [
    { name: 'series_id', dtype: 'string', role: 'key', unit: 'opaque_series_id', scale: '1', nullable: false },
    { name: 'timestamp', dtype: 'string', role: 'key', unit: 'YYYY-MM-DD', scale: '1', nullable: false },
    { name: 'input_available_at', dtype: 'string', role: 'metadata', unit: 'ISO8601-with-timezone', scale: '1', nullable: false },
    { name: field, dtype: ma ? 'binary64_hex' : 'boolean', role: 'value', unit: ma ? computed.metadata.currency : 'boolean', scale: '1', nullable: true },
  ];
  const rows = computed.rows.map(row => ({ series_id: computed.metadata.series_id, timestamp: row.timestamp, input_available_at: row.available_at,
    [field]: row[field] === null ? null : ma ? encodeFinancialBinary64Hex(row[field] as number) : row[field] as boolean }));
  const payload = { state: 'candidate' as const, resultId: task.resultRef!, sourceTaskId: task.id, sourceAttemptId: task.currentAttemptId,
    target: JSON.parse(canonical(target)) as FinancialPublicationTarget,
    inputLineage: JSON.parse(canonical(lineage)) as FinancialPublicationInputLineage,
    table: { fields, primaryKey: ['series_id', 'timestamp'] as ['series_id', 'timestamp'], rowCount: rows.length, rows },
    computation: JSON.parse(canonical({ capabilityId: computed.capabilityId, pluginVersion: computed.pluginVersion,
      contractVersion: computed.contractVersion, methodVersion: computed.methodVersion, implementationVersion: computed.implementationVersion,
      inputDigest: computed.inputDigest, parameters: computed.parameters, metadata: computed.metadata,
      validInterval: computed.validInterval, invalidIntervals: computed.invalidIntervals, diagnostics: computed.diagnostics,
      limitations: computed.limitations, externalActionExecuted: false,
      numericalEncoding: { name: ma ? FINANCIAL_FLOAT_ENCODING : 'boolean_nullable/v1', scale: '1', rounding: 'none',
        meaning: ma ? 'big-endian IEEE-754 binary64 bits of the original finite result' : 'native boolean; null means insufficient history' },
    })) as JsonValue };
  return { ...payload, candidateSha256: financialDigest(payload) };
}

export interface FinancialPublicationEvidence {
  sealedInput: JsonValue;
  rawResultBytes: Uint8Array;
  methodEvidence: JsonValue;
  environmentEvidence: JsonValue;
  computedAt: string;
  parametersVersion: string;
  environmentVersion: string;
}
export interface WfdFinancialInputSnapshot {
  instance_id: string; dataset_id: string; dataset_mapping_version: string; snapshot_id: string; commit_id: string;
  target: { unit_id: string; output_id: string; definition_rev: string; schema_rev: string }; rows_sha256: string;
}

/** 按数据库正式模式生成封闭字节和独立计算谱系，仍是纯构造，不发送、不记录提交成功。 */
export function createWfdFinancialPublication(task: TaskRecord, configuration: {
  instanceId: string; requestId: string; publicationId: string; target: FinancialPublicationTarget;
  inputLineage: FinancialPublicationInputLineage; inputSnapshot: WfdFinancialInputSnapshot;
  descriptorSemantics: WfdRecord; evidence: FinancialPublicationEvidence;
  check(definition: string, value: unknown): boolean;
  completion?: 'accepted' | 'received' | 'committed';
}): WfdEnvelope {
  const candidate = createFinancialPublicationCandidate(task, configuration), computed = requireFinancialComputedResult(task);
  const { evidence, inputSnapshot, descriptorSemantics: semantics } = configuration;
  [configuration.instanceId, configuration.requestId, configuration.publicationId, evidence.parametersVersion, evidence.environmentVersion].forEach(identifier);
  const input = configuration.inputLineage.reference, expectedInputTarget = { unit_id: input.outputIdentity.unitId, output_id: input.outputIdentity.outputId,
    definition_rev: input.outputIdentity.definitionRevision, schema_rev: input.outputIdentity.schemaRevision };
  if (configuration.target.purpose !== 'user_test' || !configuration.check('snapshot_reference', inputSnapshot)
    || inputSnapshot.instance_id !== configuration.instanceId || inputSnapshot.dataset_id !== input.productId || inputSnapshot.snapshot_id !== input.snapshotId
    || inputSnapshot.rows_sha256 !== configuration.inputLineage.rowsResourceSha256
    || canonical(inputSnapshot.target) !== canonical(expectedInputTarget)
    || financialDigest(evidence.sealedInput) !== computed.inputDigest || !task.currentRunId || !task.currentAttemptId
    || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(evidence.computedAt) || !Number.isFinite(Date.parse(evidence.computedAt))) {
    throw new TaskError('FINANCIAL_PUBLICATION_EVIDENCE_INVALID', '发布须绑定真实计算、封闭输入、计算时刻和同一实例的固定输入快照。');
  }
  const identity = configuration.target.outputIdentity;
  if (semantics.unit_id !== identity.unitId || semantics.output_id !== identity.outputId || semantics.definition_rev !== identity.definitionRevision
    || semantics.schema_rev !== identity.schemaRevision || semantics.data_kind !== 'derived' || canonical(semantics.fields) !== canonical(candidate.table.fields)
    || canonical(semantics.primary_key) !== canonical(candidate.table.primaryKey) || canonical(semantics.allowed_purposes) !== canonical(['user_test'])) {
    throw new TaskError('FINANCIAL_PUBLICATION_TARGET_INVALID', '派生结果必须符合数据库实际登记的精确目标和字段语义。');
  }
  const rawBytes = Buffer.from(evidence.rawResultBytes);
  let rawResult: unknown;
  try { rawResult = JSON.parse(rawBytes.toString('utf8')); } catch { throw new TaskError('FINANCIAL_PUBLICATION_EVIDENCE_INVALID', '保管的原结果字节不是可核结构。'); }
  if (financialDigest(rawResult) !== financialDigest(computed.rawToolResult)) throw new TaskError('FINANCIAL_PUBLICATION_EVIDENCE_INVALID', '保管的原结果字节与实际计算结果不符。');
  const inline = (bytes: Uint8Array): WfdRecord => {
    const value = Buffer.from(bytes);
    const reference = { kind: 'inline-bytes', sha256: sha(value), byte_length: value.length, media_type: 'application/json', bytes_base64: value.toString('base64') };
    if (!configuration.check('object_reference', reference)) throw new TaskError('FINANCIAL_PUBLICATION_EVIDENCE_INVALID', '结果或必需证据超过正式字节合同。');
    return reference;
  };
  const jsonBytes = (value: unknown) => Buffer.from(canonical(value));
  const inputManifest = inline(jsonBytes(evidence.sealedInput)), originalResult = inline(rawBytes), method = inline(jsonBytes(evidence.methodEvidence)),
    environment = inline(jsonBytes(evidence.environmentEvidence)), parameters = inline(jsonBytes(computed.parameters));
  const validation = inline(jsonBytes({ version: 'financial-result-validation/1', taskId: task.id, resultId: task.resultRef,
    inputDigest: computed.inputDigest, implementationVersion: computed.implementationVersion, methodVersion: computed.methodVersion,
    rowCount: candidate.table.rowCount, validInterval: computed.validInterval, invalidIntervals: computed.invalidIntervals,
    outputSha256: financialDigest(candidate.table.rows), numericResultEncoding: computed.capabilityId === FINANCIAL_CAPABILITIES[0] ? FINANCIAL_FLOAT_ENCODING : 'boolean_nullable/v1',
    checks: ['original_task_and_versions', 'fixed_input', 'row_keys_and_times', 'warmup_nulls', 'finite_binary64_or_native_boolean', 'valid_interval'] }));
  const verification = [inputManifest, originalResult, method, environment, parameters, validation];
  const proofDigests = verification.map(item => String(item.sha256));
  const table = { entrypoint: '库说明.json', descriptor: { ...semantics, snapshot_id: null, row_count: candidate.table.rowCount,
    coverage: { complete: true, gaps: [], description: '完整保留所供固定窗口及原预热空值；有效区间和方法限制见计算验证证据，未取得严格历史可得资格。' },
    dependencies: { read: [], compute: [], regenerate: proofDigests.slice(0, 5), audit: proofDigests } }, rows: candidate.table.rows };
  if (!configuration.check('table_package', table)) throw new TaskError('FINANCIAL_PUBLICATION_TARGET_INVALID', '实际派生表格没有通过数据库正式候选包校验。');
  const snapshots = [inputSnapshot];
  const calculation = { task_id: task.id, run_id: task.currentRunId, attempt_id: task.currentAttemptId,
    plugin_id: FINANCIAL_PLUGIN_ID, plugin_version: computed.pluginVersion, tool_id: computed.capabilityId, tool_contract_version: computed.contractVersion,
    method_version: computed.methodVersion, method_evidence_sha256: method.sha256, implementation_version: computed.implementationVersion,
    implementation_sha256: computed.implementationVersion.replace(/^sha256:/, ''), parameters: computed.parameters, parameters_version: evidence.parametersVersion,
    parameters_sha256: parameters.sha256, environment_version: evidence.environmentVersion, environment_evidence_sha256: environment.sha256,
    computed_at: evidence.computedAt, calculation_input_sha256: computed.inputDigest, input_manifest_evidence_sha256: inputManifest.sha256,
    raw_result_sha256: originalResult.sha256, validation_evidence_sha256: validation.sha256,
    numeric_result_encoding: computed.capabilityId === FINANCIAL_CAPABILITIES[0] ? FINANCIAL_FLOAT_ENCODING : 'boolean_nullable/v1' };
  const args = { publication_version: 'wfd-results-publication/v0.1', publication_id: configuration.publicationId, result_id: task.resultRef!, output_slot: 'rows',
    value_field: computed.capabilityId === FINANCIAL_CAPABILITIES[0] ? 'MA' : 'bullish_engulfing', dataset_id: configuration.target.datasetId,
    dataset_mapping_version: configuration.target.datasetMappingVersion, contract_version: 'wfd-table/v0.2', purpose: 'user_test', completion: configuration.completion ?? 'committed',
    expected_parent_snapshot_id: configuration.target.parentSnapshotId, input_snapshots: snapshots, input_snapshots_sha256: financialDigest(snapshots),
    calculation, structured_result: inline(jsonBytes(table)), verification_evidence: verification };
  const envelope: WfdEnvelope = { protocol_version: 2, instance_id: configuration.instanceId, request_id: configuration.requestId, operation: 'results.publish', arguments: args };
  if (!configuration.check('publication', args) || !configuration.check('request_envelope', envelope)) throw new TaskError('FINANCIAL_PUBLICATION_EVIDENCE_INVALID', '发布包络、独立计算谱系或身份没有通过数据库正式模式。');
  return envelope;
}
function sha(bytes: Uint8Array): string { return wfdSha256(bytes); }
function identifier(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new TaskError('FINANCIAL_PUBLICATION_TARGET_INVALID', '发布目标必须是明确的有界身份。');
  }
}
function fixedSnapshot(value: unknown): void {
  identifier(value);
  if (/^(latest|current)$/i.test(String(value))) throw new TaskError('FINANCIAL_PUBLICATION_TARGET_INVALID', '发布只能固定真实快照身份，不接受最新别名。');
}

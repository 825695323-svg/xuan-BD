import { DataServiceError } from '../../adapters/database/wfd-error.js';
import type { SealedCollectionObject } from './handoff.js';
import { USER_TABLE_LIMITS, USER_TABLE_STEPS, userTableDigest, type UserTableStepExecution, type UserTableTarget } from './user-table-pipeline.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { canonicalWfdJson as canonical, createWfdTransport, isFixedWfdSnapshot, isWfdRecord, wfdSha256,
  type WfdEnvelope, type WfdRecord, type WfdTransportConfig } from '../../adapters/database/wfd-transport.js';

/** 共同交接结构只要求实际加工证据；附件语义与接口解码分别由各自处理程序负责。 */
export interface CompletedDailyPipeline {
  state: 'succeeded';
  plan: { target: UserTableTarget; originalManifestSha256: string };
  declaration: { originalSha256: string; useMode: 'analysis' };
  traces: UserTableStepExecution[]; tablePackage: JsonValue;
  original: SealedCollectionObject; evidence: SealedCollectionObject[];
}
type Reference = { kind: 'inline-bytes'; sha256: string; byte_length: number; media_type: string; bytes_base64: string };
export interface UserCycleContract {
  target: UserTableTarget; purpose: 'user_test'; instanceId: string; sourceKind: 'user_submitted'; sourceId: string; adapterId: string; adapterVersion: string;
}
export interface UserCyclePortConfig extends UserCycleContract { transport: WfdTransportConfig; principalId: string }
export interface UserCycleIdentity {
  requestId: string; handoffId: string; collectionTaskId: string; processingTaskId: string;
  parentSnapshotId: string | null; collectedAt: string;
}
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function fail(code: string, message: string): never { throw new DataServiceError(code, message); }
function invalid(): never { return fail('WFD_USER_CYCLE_RESPONSE', 'WFD 用户测试的身份、保管、固定快照或完整谱系核对失败。'); }
function object(value: unknown): WfdRecord { if (!isWfdRecord(value)) invalid(); return value; }
function copy<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function targetOf(target: UserTableTarget): WfdRecord { return { unit_id: target.unitId, output_id: target.outputId,
  definition_rev: target.definitionRevision, schema_rev: target.schemaRevision }; }
function fixed(value: unknown): void { if (!isFixedWfdSnapshot(value)) fail('WFD_FIXED_SNAPSHOT_REQUIRED', '需要数据库实际返回的固定快照，不能使用 latest/current。'); }
function identifier(value: unknown): void { if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('WFD_USER_CYCLE_IDENTITY', '交接身份必须是明确、有界的稳定标识。'); }
function reference(input: SealedCollectionObject): Reference {
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  if (!bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes || bytes.byteLength !== input.byteLength
    || bytes.toString('base64') !== input.bytesBase64 || wfdSha256(bytes) !== input.sha256 || typeof input.mediaType !== 'string' || !input.mediaType) {
    fail('WFD_USER_CYCLE_OBJECT', '原件或证据的原字节、摘要、长度或媒体类型不一致，或超过 1 MiB。');
  }
  return { kind: 'inline-bytes', sha256: input.sha256, byte_length: input.byteLength, media_type: input.mediaType, bytes_base64: input.bytesBase64 };
}
function validateContract(contract: UserCycleContract): void {
  const t = contract.target;
  if (!t || t.purpose !== 'user_test' || contract.purpose !== 'user_test' || !SHA.test(t.schemaSha256)
    || t.contractVersion !== 'wfd-table/v0.2' || t.dataKind !== 'user_submitted' || contract.sourceKind !== 'user_submitted') {
    fail('WFD_USER_CYCLE_UNBOUND', '需要冻结的用户测试目标、真实来源种类、模式摘要及 user_test 存储用途。');
  }
  for (const value of [t.datasetId, t.mappingVersion, t.unitId, t.outputId, t.definitionRevision, t.schemaRevision,
    contract.instanceId, contract.sourceId, contract.adapterId, contract.adapterVersion]) identifier(value);
}

/** 纯准备程序；未调用数据库。最终模式校验与发送由显式装配的端口完成。 */
export function prepareUserCycleIngest(pipeline: CompletedDailyPipeline, identity: UserCycleIdentity, contract: UserCycleContract): WfdEnvelope {
  validateContract(contract);
  if (pipeline.state !== 'succeeded' || !equal(pipeline.plan.target, contract.target) || pipeline.declaration.useMode !== 'analysis') fail('WFD_USER_CYCLE_PLAN', '原加工计划与冻结目标或回顾分析范围不一致。');
  for (const value of [identity.requestId, identity.handoffId, identity.collectionTaskId, identity.processingTaskId]) identifier(value);
  if (identity.parentSnapshotId !== null) fixed(identity.parentSnapshotId);
  if (typeof identity.collectedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(identity.collectedAt) || !Number.isFinite(Date.parse(identity.collectedAt))) fail('WFD_USER_CYCLE_COLLECTED_AT', '保管采集时刻须来自实际宿主记录并含时区，不作为市场可得时刻。');
  const original = reference(pipeline.original), evidence = pipeline.evidence.map(reference);
  const inputDigest = userTableDigest({ objects: [{ byte_length: original.byte_length, media_type: original.media_type, sha256: original.sha256 }] });
  if (inputDigest !== pipeline.plan.originalManifestSha256 || original.sha256 !== pipeline.declaration.originalSha256) fail('WFD_USER_CYCLE_INPUT', '封闭原件摘要与实际加工计划或声明不一致。');
  const table = object(pipeline.tablePackage), descriptor = object(table.descriptor), target = contract.target;
  if (table.entrypoint !== '库说明.json' || !equal(targetOf(target), Object.fromEntries(Object.keys(targetOf(target)).map(key => [key, descriptor[key]])))
    || descriptor.contract_version !== target.contractVersion || descriptor.data_kind !== target.dataKind || descriptor.snapshot_id !== null
    || !equal(descriptor.allowed_purposes, ['user_test']) || !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 512) fail('WFD_USER_CYCLE_TABLE', '结构化候选必须匹配冻结目标、用户测试用途及完整有界行。');
  const structuredBytes = Buffer.from(canonical(table)), structuredDigest = wfdSha256(structuredBytes);
  if (structuredBytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) fail('WFD_USER_CYCLE_OBJECT', '结构化候选超过 1 MiB。');
  if (pipeline.traces.length !== USER_TABLE_STEPS.length) fail('WFD_USER_CYCLE_STEPS', '交接须保留完整实际五步，不补造缺少的步骤。');
  const planDigest = userTableDigest(pipeline.plan), processing: WfdRecord = {};
  let previous = inputDigest;
  for (const [ordinal, name] of USER_TABLE_STEPS.entries()) {
    const step = pipeline.traces[ordinal]!;
    const verification = userTableDigest(step);
    if (step.stepId !== name || step.planSha256 !== planDigest || step.inputSha256 !== previous
      || step.outputSha256 !== userTableDigest(step.output) || !SHA.test(step.implementationSha256) || !SHA.test(step.runtime.dependenciesSha256)
      || !evidence.some(item => item.sha256 === verification) || !evidence.some(item => item.sha256 === step.implementationSha256)
      || !evidence.some(item => item.sha256 === step.runtime.dependenciesSha256)) fail('WFD_USER_CYCLE_STEPS', '五步顺序、输入输出链、实际实现或验证证据封闭不完整。');
    const parameters = Object.fromEntries(Object.entries(step.parameters).map(([key, value]) => [key,
      value === null || ['string', 'boolean', 'number'].includes(typeof value) ? value : canonical(value)]));
    processing[name] = { processor_id: name, processor_version: step.implementationVersion, implementation_sha256: step.implementationSha256,
      rule_id: name, rule_version: step.ruleVersion, method_id: name, method_version: step.methodVersion,
      parameters, parameters_version: 'harness-canonical-parameters/v1',
      environment: { runtime: `node/${step.runtime.platform}/${step.runtime.arch}`, runtime_version: step.runtime.nodeVersion,
        dependencies_sha256: step.runtime.dependenciesSha256 },
      input_version: ordinal === 0 ? 'original-manifest/wfd-0.1.1' : pipeline.traces[ordinal - 1]!.implementationVersion,
      input_sha256: step.inputSha256, output_version: step.implementationVersion, output_sha256: step.outputSha256,
      verification_evidence_sha256: verification, state: 'completed' };
    previous = step.outputSha256;
  }
  if (previous !== structuredDigest) fail('WFD_USER_CYCLE_OUTPUT', '实际结构化步骤输出与待发送候选的原字节摘要不同。');
  const envelope: WfdEnvelope = { protocol_version: 2, instance_id: contract.instanceId, request_id: identity.requestId, operation: 'materials.receive', arguments: {
    handoff_version: 'wfd-harness-handoff/v0.1', handoff_id: identity.handoffId, collection_task_id: identity.collectionTaskId,
    processing_task_id: identity.processingTaskId, dataset_id: target.datasetId, dataset_mapping_version: target.mappingVersion,
    contract_version: target.contractVersion, purpose: contract.purpose, completion: 'committed', expected_snapshot_id: identity.parentSnapshotId,
    input_sha256: inputDigest, source: { kind: contract.sourceKind, source_id: contract.sourceId, adapter_id: contract.adapterId,
      adapter_version: contract.adapterVersion, collected_at: identity.collectedAt }, processing,
    structured_result: { kind: 'inline-bytes', sha256: structuredDigest, byte_length: structuredBytes.byteLength,
      media_type: 'application/json', bytes_base64: structuredBytes.toString('base64') }, original_evidence: [original], verification_evidence: evidence,
  } };
  if (Buffer.byteLength(canonical(envelope)) > USER_TABLE_LIMITS.maxBundleBytes) fail('WFD_USER_CYCLE_BUDGET', '完整请求包络超过 8 MiB，未交接。');
  return freeze(copy(envelope));
}

/** 可恢复封闭请求的纯校验；不查内存记录、不推造外部回执。 */
export function verifyUserCycleReceipt(result: WfdRecord, envelope: WfdEnvelope | undefined, contract: UserCycleContract,
  expectedHandoffId?: string): WfdRecord {
  const target = contract.target;
  if (result.owner_service !== 'wfd' || result.protocol_schema_sha256 !== target.schemaSha256) invalid();
  if (result.state === 'not_found') {
    if (!expectedHandoffId || object(result.lookup).handoff_id !== expectedHandoffId) invalid();
    return result;
  }
  if (result.instance_id !== contract.instanceId || result.mode !== 'user_test' || result.purpose !== contract.purpose
    || result.operation !== 'materials.receive') invalid();
  if (expectedHandoffId && result.handoff_id !== expectedHandoffId) invalid();
  if (result.state === 'unknown') return result;
  if (result.dataset_id !== target.datasetId || result.dataset_mapping_version !== target.mappingVersion || !equal(result.target, targetOf(target))) invalid();
  if (envelope && (result.request_id !== envelope.request_id || result.handoff_id !== envelope.arguments.handoff_id)) invalid();
  if (['accepted', 'received', 'committed'].includes(String(result.state))) identifier(result.job_id);
  if (['received', 'committed'].includes(String(result.state)) && !isWfdRecord(result.custody)) invalid();
  if (['received', 'committed'].includes(String(result.state))) identifier(result.receipt_id);
  if (result.state === 'committed') { identifier(result.commit_id); fixed(result.snapshot_id); identifier(result.receipt_id); identifier(result.job_id); }
  if (isWfdRecord(result.custody) && envelope) {
    verifyUserWfdCustody(result, envelope, target.schemaSha256, { objects: (envelope.arguments.original_evidence as WfdRecord[])
      .map(item => ({ byte_length: item.byte_length, media_type: item.media_type, sha256: item.sha256 })) });
  }
  return result;
}

/** 对照0.1.3服务的真实_seal；调用方明确给定原件或独立发布的来源清单。 */
export function verifyUserWfdCustody(result: WfdRecord, envelope: WfdEnvelope, schemaSha256: string, sourceManifest: WfdRecord): void {
  const args = envelope.arguments, objects = new Map<string, number>();
  const original = Array.isArray(args.original_evidence) ? args.original_evidence.map(object) : [];
  const all = [object(args.structured_result), ...original, ...(args.verification_evidence as unknown[]).map(object)];
  for (const item of all) {
    const bytes = Buffer.from(item.bytes_base64 as string, 'base64');
    if (bytes.toString('base64') !== item.bytes_base64 || bytes.byteLength !== item.byte_length || wfdSha256(bytes) !== item.sha256
      || !bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) invalid();
    const old = objects.get(item.sha256 as string);
    if (old !== undefined && old !== item.byte_length) invalid();
    objects.set(item.sha256 as string, item.byte_length as number);
  }
  const manifest = { job_id: result.job_id, operation: envelope.operation,
    content_sha256: userTableDigest({ operation: envelope.operation, arguments: args }), schema_sha256: schemaSha256, entrypoint: '库说明.json',
    objects: [...objects.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sha256, byte_length]) => ({ sha256, byte_length })),
    structured_result_sha256: object(args.structured_result).sha256, source_manifest: sourceManifest };
  const custody = object(result.custody);
  if (custody.state !== 'stored' || custody.recovery_job_id !== result.job_id || custody.manifest_sha256 !== userTableDigest(manifest)
    || custody.object_count !== objects.size || custody.byte_length !== [...objects.values()].reduce((sum, n) => sum + n, 0)) invalid();
}

/** 返回实际登记项；head_snapshot_id由数据库heads表给出，不从列表顺序选取。 */
export function verifyUserWfdCapability(result: WfdRecord, target: UserTableTarget, instanceId: string, principalId?: string): WfdRecord {
  if (result.protocol_schema_sha256 !== target.schemaSha256 || result.instance_id !== instanceId || result.mode !== 'user_test'
    || result.purpose !== 'user_test' || (principalId !== undefined && result.principal_id !== principalId) || !Array.isArray(result.capabilities)) invalid();
  const matching = result.capabilities.filter(item => isWfdRecord(item) && item.dataset_id === target.datasetId);
  if (matching.length !== 1 || matching[0]!.mapping_version !== target.mappingVersion || !equal(matching[0]!.target, targetOf(target))
    || matching[0]!.contract_version !== target.contractVersion || matching[0]!.binding_registered !== true
    || matching[0]!.semantics_sha256 !== target.semanticsSha256 || !equal(matching[0]!.descriptor_semantics, target.descriptorSemantics)
    || !Object.hasOwn(matching[0]!, 'head_snapshot_id')) invalid();
  const item = matching[0] as WfdRecord;
  if (item.head_snapshot_id !== null) fixed(item.head_snapshot_id);
  return item;
}

/** 全字段、整份行资源及完整谱系逐项核对，返回数据库的原对象。 */
export function verifyUserCycleReadback(result: WfdRecord, receipt: WfdRecord, envelope: WfdEnvelope, contract: UserCycleContract): WfdRecord {
  verifyUserCycleReceipt(receipt, envelope, contract, envelope.arguments.handoff_id as string);
  if (receipt.state !== 'committed') fail('WFD_FIXED_SNAPSHOT_REQUIRED', '仅真实 committed 回执可以固定读回。');
  const args = envelope.arguments, reference = object(args.structured_result);
  const structuredBytes = Buffer.from(reference.bytes_base64 as string, 'base64');
  if (structuredBytes.toString('base64') !== reference.bytes_base64 || structuredBytes.byteLength !== reference.byte_length
    || wfdSha256(structuredBytes) !== reference.sha256 || structuredBytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes) invalid();
  const table = object(JSON.parse(structuredBytes.toString('utf8')));
  const candidate = object(table.descriptor), expectedRows = table.rows as WfdRecord[];
  const fields = (candidate.fields as WfdRecord[]).map(field => String(field.name));
  const expectedDescriptor = { ...candidate, snapshot_id: receipt.snapshot_id,
    data_resource: { path: 'rows.json', sha256: userTableDigest(expectedRows) } };
  const expectedLineage = { kind: 'materials.receive', request_id: envelope.request_id, handoff_id: args.handoff_id, collection_task_id: args.collection_task_id,
    processing_task_id: args.processing_task_id, input_sha256: args.input_sha256, structured_result_sha256: reference.sha256,
    source: args.source, processing: args.processing };
  const rows = result.rows, descriptor = object(result.descriptor), lineage = object(result.lineage);
  if (result.instance_id !== contract.instanceId || result.mode !== 'user_test' || result.purpose !== contract.purpose
    || !equal(result.qualification, { authenticity: 'not_verified', historical_eligibility: 'not_established' })
    || result.dataset_id !== contract.target.datasetId || result.dataset_mapping_version !== contract.target.mappingVersion
    || result.snapshot_id !== receipt.snapshot_id || result.commit_id !== receipt.commit_id || !equal(result.target, targetOf(contract.target))
    || result.protocol_schema_sha256 !== contract.target.schemaSha256 || result.time_capability !== 'fixed_snapshot_only'
    || !Array.isArray(rows) || rows.length > 512 || rows.length !== expectedRows.length || result.row_count !== rows.length
    || result.returned_rows !== rows.length || result.next_cursor !== null || !equal(result.fields, fields)
    || result.parent_snapshot_id !== args.expected_snapshot_id || typeof result.committed_at !== 'string'
    || !Number.isFinite(Date.parse(result.committed_at)) || result.descriptor_sha256 !== userTableDigest(expectedDescriptor)
    || !equal(result.coverage, candidate.coverage) || userTableDigest(descriptor) !== userTableDigest(expectedDescriptor)
    || userTableDigest(rows) !== userTableDigest(expectedRows) || userTableDigest(lineage) !== userTableDigest(expectedLineage)) invalid();
  return result;
}

/** 只有共用传输；稳定请求、未知结果、重放决定与持久状态归外层个人数据库。 */
export function createUserCyclePort(configuration: UserCyclePortConfig) {
  validateContract(configuration);
  identifier(configuration.principalId);
  const principalId = configuration.principalId;
  const contract: UserCycleContract = freeze(copy({ target: configuration.target, purpose: configuration.purpose,
    instanceId: configuration.instanceId, sourceKind: configuration.sourceKind, sourceId: configuration.sourceId, adapterId: configuration.adapterId, adapterVersion: configuration.adapterVersion }));
  if (configuration.transport.expectedSchemaSha256 !== contract.target.schemaSha256 || configuration.transport.binding !== 'controlled-user-test'
    || configuration.transport.instanceId !== contract.instanceId || configuration.transport.datasetId !== contract.target.datasetId) fail('WFD_USER_CYCLE_UNBOUND', '传输与用户目标必须固定同一受控实例、模式摘要及预登记数据集。');
  const transport = createWfdTransport(configuration.transport);
  const binding = transport.datasetBinding;
  if (binding.dataset_id !== contract.target.datasetId || binding.mapping_version !== contract.target.mappingVersion
    || binding.contract_version !== contract.target.contractVersion || binding.semantics_sha256 !== contract.target.semanticsSha256
    || !equal(binding.descriptor_semantics, contract.target.descriptorSemantics)
    || !equal(Object.fromEntries(Object.keys(targetOf(contract.target)).map(key => [key, binding[key]])), targetOf(contract.target))) {
    fail('WFD_USER_CYCLE_UNBOUND', '共用传输未固定当前用户数据集的真实登记映射，旧合成默认绑定不可采用。');
  }
  const checkReceipt = (result: WfdRecord, envelope?: WfdEnvelope, handoffId?: string): WfdRecord => {
    if (!transport.check(result.state === 'not_found' ? 'not_found' : 'receipt', result)) invalid();
    return verifyUserCycleReceipt(result, envelope, contract, handoffId);
  };
  const validate = (envelope: WfdEnvelope): void => {
    transport.validateRequest(envelope);
    const args = envelope.arguments;
    const source = object(args.source);
    if (envelope.instance_id !== contract.instanceId || envelope.operation !== 'materials.receive' || args.dataset_id !== contract.target.datasetId || args.dataset_mapping_version !== contract.target.mappingVersion
      || args.contract_version !== contract.target.contractVersion || args.purpose !== contract.purpose || source.kind !== contract.sourceKind
      || source.source_id !== contract.sourceId || source.adapter_id !== contract.adapterId || source.adapter_version !== contract.adapterVersion) fail('WFD_USER_CYCLE_REQUEST', '请求与当前用户测试绑定不同。');
    const ref = object(args.structured_result), bytes = Buffer.from(ref.bytes_base64 as string, 'base64');
    if (wfdSha256(bytes) !== ref.sha256 || bytes.byteLength !== ref.byte_length) fail('WFD_USER_CYCLE_OBJECT', '持久请求的结构化字节已改变。');
    const table = object(JSON.parse(bytes.toString('utf8')));
    if (!transport.check('table_package', table)) fail('WFD_USER_CYCLE_TABLE', '用户候选不符合冻结的唯一表格模式。');
    const descriptor = object(table.descriptor);
    if (!equal(Object.fromEntries(Object.keys(targetOf(contract.target)).map(key => [key, descriptor[key]])), targetOf(contract.target))
      || descriptor.contract_version !== contract.target.contractVersion || descriptor.data_kind !== contract.target.dataKind
      || descriptor.snapshot_id !== null || !equal(descriptor.allowed_purposes, [contract.purpose])) fail('WFD_USER_CYCLE_TABLE', '持久候选声明与当前冻结用户测试绑定不同。');
    const semantics = Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['snapshot_id', 'row_count', 'coverage', 'dependencies'].includes(key)));
    if (!equal(semantics, contract.target.descriptorSemantics) || userTableDigest(semantics) !== contract.target.semanticsSha256) fail('WFD_USER_CYCLE_TABLE', '用户候选的字段和声明语义未匹配固定登记摘要。');
  };
  const capabilities = async (signal?: AbortSignal): Promise<WfdRecord> => {
    const result = await transport.call({ protocol_version: 2, request_id: `user-capabilities-${userTableDigest(contract.target).slice(0, 32)}`,
      operation: 'capabilities.search', arguments: { dataset_id: contract.target.datasetId } }, { signal });
    if (!transport.check('capabilities_result', result)) invalid();
    verifyUserWfdCapability(result, contract.target, contract.instanceId, principalId);
    return result;
  };
  return Object.freeze({ target: contract.target, contractDigest: transport.contractDigest,
    prepareIngest(pipeline: CompletedDailyPipeline, identity: UserCycleIdentity): WfdEnvelope {
      const prepared = prepareUserCycleIngest(pipeline, identity, contract); validate(prepared); return prepared;
    },
    capabilities,
    async getHead(signal?: AbortSignal): Promise<WfdRecord> {
      return verifyUserWfdCapability(await capabilities(signal), contract.target, contract.instanceId, principalId);
    },
    async ingest(envelope: WfdEnvelope, signal?: AbortSignal): Promise<WfdRecord> {
      const wire = freeze(copy(envelope)); validate(wire);
      const result = await transport.call(wire, { signal });
      try { return checkReceipt(result, wire, wire.arguments.handoff_id as string); }
      catch (error) { if (error instanceof DataServiceError) error.mayHaveBeenAccepted = true; throw error; }
    },
    async lookup(handoffId: string, signal?: AbortSignal): Promise<WfdRecord> {
      identifier(handoffId);
      const result = await transport.call({ protocol_version: 2, request_id: `user-lookup-${wfdSha256(handoffId).slice(0, 40)}`,
        operation: 'data.jobs.get', arguments: { handoff_id: handoffId } }, { signal });
      return checkReceipt(result, undefined, handoffId);
    },
    async readCommitted(receipt: WfdRecord, envelope?: WfdEnvelope, signal?: AbortSignal): Promise<WfdRecord> {
      if (!envelope) fail('WFD_SEALED_REQUEST_REQUIRED', '核对真实固定读取必须提供个人数据库保存的原封闭请求，不从内存或名称补猜。');
      validate(envelope); checkReceipt(receipt, envelope, envelope.arguments.handoff_id as string);
      if (receipt.state !== 'committed') fail('WFD_FIXED_SNAPSHOT_REQUIRED', '读取需要实际 committed 回执与固定快照。');
      const ref = object(envelope.arguments.structured_result), table = object(JSON.parse(Buffer.from(ref.bytes_base64 as string, 'base64').toString('utf8')));
      const fields = (object(table.descriptor).fields as WfdRecord[]).map(field => String(field.name));
      const result = await transport.call({ protocol_version: 2, request_id: `user-read-${userTableDigest({ handoff: envelope.arguments.handoff_id, snapshot: receipt.snapshot_id }).slice(0, 40)}`,
        operation: 'data.read', arguments: { dataset_id: contract.target.datasetId, snapshot_id: receipt.snapshot_id, fields, limit: 512 } }, { signal });
      if (!transport.check('read_result', result)) invalid();
      return verifyUserCycleReadback(result, receipt, envelope, contract);
    },
  });
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

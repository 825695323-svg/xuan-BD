import { DataServiceError } from '../../adapters/database/wfd-error.js';
import { USER_TABLE_LIMITS, userTableDigest, type UserTableTarget } from './user-table-pipeline.js';
import { verifyUserWfdCapability, verifyUserWfdCustody } from './user-cycle-port.js';
import { canonicalWfdJson as canonical, createWfdTransport, isFixedWfdSnapshot, isWfdRecord, wfdSha256,
  type WfdEnvelope, type WfdRecord, type WfdTransportConfig } from '../../adapters/database/wfd-transport.js';

export interface UserPublicationContract { target: UserTableTarget; instanceId: string; purpose: 'user_test' }
export interface UserPublicationPortConfig extends UserPublicationContract { transport: WfdTransportConfig; principalId: string }
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const copy = <T>(value: T): T => JSON.parse(canonical(value)) as T;
function fail(code: string, message: string): never { throw new DataServiceError(code, message); }
function invalid(): never { return fail('WFD_PUBLICATION_RESPONSE', 'WFD 派生发布的身份、保管、固定快照或独立计算谱系核对失败。'); }
function object(value: unknown): WfdRecord { if (!isWfdRecord(value)) invalid(); return value; }
function identifier(value: unknown): void { if (typeof value !== 'string' || !ID.test(value)) invalid(); }
const targetOf = (target: UserTableTarget): WfdRecord => ({ unit_id: target.unitId, output_id: target.outputId,
  definition_rev: target.definitionRevision, schema_rev: target.schemaRevision });
function fixed(value: unknown): void { if (!isFixedWfdSnapshot(value)) fail('WFD_PUBLICATION_SNAPSHOT', '派生发布及输入只能使用实际固定快照，不能使用 latest/current。'); }
function validateContract(contract: UserPublicationContract, binding: WfdRecord): void {
  const t = contract.target;
  if (contract.purpose !== 'user_test' || t.purpose !== 'user_test' || t.dataKind !== 'derived' || !SHA.test(t.schemaSha256)
    || !ID.test(contract.instanceId) || binding.operation !== 'results.publish' || binding.dataset_id !== t.datasetId
    || binding.mapping_version !== t.mappingVersion || binding.contract_version !== t.contractVersion
    || binding.semantics_sha256 !== t.semanticsSha256 || userTableDigest(t.descriptorSemantics) !== t.semanticsSha256
    || !equal(binding.descriptor_semantics, t.descriptorSemantics)
    || !equal(Object.fromEntries(Object.keys(targetOf(t)).map(key => [key, binding[key]])), targetOf(t))
    || binding.output_slot !== 'rows' || !['MA', 'bullish_engulfing'].includes(String(binding.value_field))) {
    fail('WFD_PUBLICATION_UNBOUND', '派生端口需要同一受控用户实例及实际预登记的派生目标、方法与字段语义。');
  }
}
function decodeTable(envelope: WfdEnvelope): WfdRecord {
  const reference = object(envelope.arguments.structured_result), bytes = Buffer.from(reference.bytes_base64 as string, 'base64');
  if (!bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes || bytes.byteLength !== reference.byte_length
    || bytes.toString('base64') !== reference.bytes_base64 || wfdSha256(bytes) !== reference.sha256 || reference.media_type !== 'application/json') {
    fail('WFD_PUBLICATION_OBJECT', '派生候选原字节、长度或摘要不一致，或超过 1 MiB。');
  }
  let table: unknown;
  try { table = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('WFD_PUBLICATION_OBJECT', '派生候选不是有效 UTF-8 JSON。'); }
  return object(table);
}

/** 只核封闭请求和正式方法登记，不构造或重算算法结果。 */
export function verifyUserPublicationEnvelope(envelope: WfdEnvelope, contract: UserPublicationContract, binding: WfdRecord): WfdRecord {
  validateContract(contract, binding);
  const args = envelope.arguments, t = contract.target;
  if (envelope.operation !== 'results.publish' || envelope.instance_id !== contract.instanceId || args.purpose !== contract.purpose
    || args.dataset_id !== t.datasetId || args.dataset_mapping_version !== t.mappingVersion || args.contract_version !== t.contractVersion
    || args.output_slot !== binding.output_slot || args.value_field !== binding.value_field) fail('WFD_PUBLICATION_REQUEST', '发布请求与当前实例、派生目标或输出字段不同。');
  [envelope.request_id, args.publication_id, args.result_id].forEach(identifier);
  if (args.expected_parent_snapshot_id !== null) fixed(args.expected_parent_snapshot_id);
  const snapshots = args.input_snapshots;
  if (!Array.isArray(snapshots) || snapshots.length !== 1 || userTableDigest(snapshots) !== args.input_snapshots_sha256) fail('WFD_PUBLICATION_INPUT', '计算输入须保持独立、完整的固定快照清单及摘要。');
  for (const snapshot of snapshots) {
    const reference = object(snapshot);
    if (reference.instance_id !== contract.instanceId) fail('WFD_PUBLICATION_INPUT', '计算输入必须来自同一获准用户实例。');
    fixed(reference.snapshot_id);
  }
  const calculation = object(args.calculation);
  for (const key of ['plugin_id', 'plugin_version', 'tool_id', 'tool_contract_version', 'method_version']) {
    if (calculation[key] !== binding[key]) fail('WFD_PUBLICATION_METHOD', '原计算方法或插件版本与预登记的派生方法不同。');
  }
  if (!SHA.test(String(calculation.implementation_sha256)) || calculation.implementation_version !== `sha256:${calculation.implementation_sha256}`
    || userTableDigest(calculation.parameters) !== calculation.parameters_sha256) fail('WFD_PUBLICATION_METHOD', '计算实现或参数没有保持原固定摘要。');
  const objects = args.verification_evidence;
  if (!Array.isArray(objects) || !objects.length) fail('WFD_PUBLICATION_EVIDENCE', '发布必须保管独立计算证据，不能制造原件或五步加工。');
  const proofs = new Set<string>();
  for (const item of objects) {
    const ref = object(item), bytes = Buffer.from(ref.bytes_base64 as string, 'base64');
    if (!bytes.byteLength || bytes.byteLength > USER_TABLE_LIMITS.maxObjectBytes || bytes.byteLength !== ref.byte_length
      || bytes.toString('base64') !== ref.bytes_base64 || wfdSha256(bytes) !== ref.sha256) fail('WFD_PUBLICATION_EVIDENCE', '独立计算证据的原字节或摘要不同，或超过 1 MiB。');
    proofs.add(String(ref.sha256));
  }
  for (const key of ['method_evidence_sha256', 'environment_evidence_sha256', 'input_manifest_evidence_sha256',
    'raw_result_sha256', 'validation_evidence_sha256', 'calculation_input_sha256']) {
    if (!proofs.has(String(calculation[key]))) fail('WFD_PUBLICATION_EVIDENCE', '计算输入、原结果、方法、环境或验证的必需证据未封闭。');
  }
  const table = decodeTable(envelope), descriptor = object(table.descriptor);
  const semantics = Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['snapshot_id', 'row_count', 'coverage', 'dependencies'].includes(key)));
  if (table.entrypoint !== '库说明.json' || descriptor.snapshot_id !== null || !equal(semantics, t.descriptorSemantics)
    || userTableDigest(semantics) !== t.semanticsSha256 || !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 512
    || descriptor.row_count !== table.rows.length) fail('WFD_PUBLICATION_TABLE', '派生候选必须采用登记语义并保持完整有界行，不能截断预热空值。');
  if (Buffer.byteLength(canonical(envelope)) > USER_TABLE_LIMITS.maxBundleBytes) fail('WFD_PUBLICATION_BUDGET', '派生发布完整请求超过 8 MiB。');
  return table;
}

/** 发布保管来源清单来自DB_validate_publication，明确区别于原件清单。 */
export function verifyUserPublicationReceipt(result: WfdRecord, envelope: WfdEnvelope | undefined,
  contract: UserPublicationContract, binding: WfdRecord, expectedPublicationId?: string): WfdRecord {
  validateContract(contract, binding);
  if (result.owner_service !== 'wfd' || result.protocol_schema_sha256 !== contract.target.schemaSha256) invalid();
  if (result.state === 'not_found') {
    if (!expectedPublicationId || object(result.lookup).publication_id !== expectedPublicationId) invalid();
    return result;
  }
  if (result.instance_id !== contract.instanceId || result.mode !== 'user_test' || result.purpose !== contract.purpose || result.operation !== 'results.publish'
    || (expectedPublicationId && result.publication_id !== expectedPublicationId)) invalid();
  if (result.state === 'unknown') return result;
  if (result.dataset_id !== contract.target.datasetId || result.dataset_mapping_version !== contract.target.mappingVersion
    || !equal(result.target, targetOf(contract.target)) || result.output_slot !== binding.output_slot || result.value_field !== binding.value_field) invalid();
  if (envelope && (result.request_id !== envelope.request_id || result.publication_id !== envelope.arguments.publication_id
    || result.result_id !== envelope.arguments.result_id)) invalid();
  identifier(result.job_id); identifier(result.result_id);
  if (['received', 'committed'].includes(String(result.state))) { identifier(result.receipt_id); object(result.custody); }
  if (result.state === 'committed') { fixed(result.snapshot_id); identifier(result.commit_id); }
  if (envelope && isWfdRecord(result.custody)) {
    const args = envelope.arguments;
    verifyUserWfdCustody(result, envelope, contract.target.schemaSha256, { input_snapshots: args.input_snapshots,
      input_snapshots_sha256: args.input_snapshots_sha256, calculation_input_sha256: object(args.calculation).calculation_input_sha256 });
  }
  return result;
}

/** 原编码行逐字节摘要核验，不把浮点十六进制或null重新计算成另一个结果。 */
export function verifyUserPublicationReadback(result: WfdRecord, receipt: WfdRecord, envelope: WfdEnvelope,
  contract: UserPublicationContract, binding: WfdRecord): WfdRecord {
  const table = verifyUserPublicationEnvelope(envelope, contract, binding);
  verifyUserPublicationReceipt(receipt, envelope, contract, binding, envelope.arguments.publication_id as string);
  if (receipt.state !== 'committed') fail('WFD_PUBLICATION_SNAPSHOT', '固定读取需要实际派生提交回执。');
  const args = envelope.arguments, candidate = object(table.descriptor), expectedRows = table.rows;
  const expectedDescriptor = { ...candidate, snapshot_id: receipt.snapshot_id, data_resource: { path: 'rows.json', sha256: userTableDigest(expectedRows) } };
  const expectedLineage = { kind: 'results.publish', request_id: envelope.request_id, publication_id: args.publication_id,
    result_id: args.result_id, output_slot: args.output_slot, value_field: args.value_field, input_snapshots: args.input_snapshots,
    input_snapshots_sha256: args.input_snapshots_sha256, calculation: args.calculation, structured_result_sha256: object(args.structured_result).sha256 };
  const rows = result.rows, fields = (candidate.fields as WfdRecord[]).map(field => String(field.name));
  if (result.instance_id !== contract.instanceId || result.mode !== 'user_test' || result.purpose !== contract.purpose
    || !equal(result.qualification, { authenticity: 'not_verified', historical_eligibility: 'not_established' })
    || result.dataset_id !== contract.target.datasetId || result.dataset_mapping_version !== contract.target.mappingVersion || !equal(result.target, targetOf(contract.target))
    || result.snapshot_id !== receipt.snapshot_id || result.commit_id !== receipt.commit_id || result.parent_snapshot_id !== args.expected_parent_snapshot_id
    || typeof result.committed_at !== 'string' || !Number.isFinite(Date.parse(result.committed_at))
    || result.protocol_schema_sha256 !== contract.target.schemaSha256 || result.time_capability !== 'fixed_snapshot_only'
    || !Array.isArray(rows) || rows.length !== (expectedRows as unknown[]).length || rows.length > 512 || result.row_count !== rows.length
    || result.returned_rows !== rows.length || result.next_cursor !== null || !equal(result.fields, fields) || !equal(result.coverage, candidate.coverage)
    || result.descriptor_sha256 !== userTableDigest(expectedDescriptor) || userTableDigest(result.descriptor) !== userTableDigest(expectedDescriptor)
    || userTableDigest(rows) !== userTableDigest(expectedRows) || userTableDigest(result.lineage) !== userTableDigest(expectedLineage)) invalid();
  return result;
}

/** 只通信及核验；持久发布账、权限、业务目标与未知结果决定由外层宿主维护。 */
export function createUserPublicationPort(configuration: UserPublicationPortConfig) {
  identifier(configuration.principalId);
  const principalId = configuration.principalId;
  const contract: UserPublicationContract = freeze(copy({ target: configuration.target, instanceId: configuration.instanceId, purpose: configuration.purpose }));
  if (configuration.transport.binding !== 'controlled-user-test' || configuration.transport.instanceId !== contract.instanceId
    || configuration.transport.datasetId !== contract.target.datasetId || configuration.transport.expectedSchemaSha256 !== contract.target.schemaSha256) fail('WFD_PUBLICATION_UNBOUND', '派生传输必须绑定同一用户实例、数据集和模式摘要。');
  const transport = createWfdTransport(configuration.transport), binding = transport.datasetBinding;
  validateContract(contract, binding);
  const validate = (envelope: WfdEnvelope): WfdRecord => {
    transport.validateRequest(envelope);
    const table = verifyUserPublicationEnvelope(envelope, contract, binding);
    if (!transport.check('table_package', table)) fail('WFD_PUBLICATION_TABLE', '派生候选没有通过唯一正式表格模式。');
    return table;
  };
  const receipt = (result: WfdRecord, envelope?: WfdEnvelope, publicationId?: string): WfdRecord => {
    if (!transport.check(result.state === 'not_found' ? 'not_found' : 'receipt', result)) invalid();
    return verifyUserPublicationReceipt(result, envelope, contract, binding, publicationId);
  };
  return Object.freeze({ target: contract.target, contractDigest: transport.contractDigest,
    async getHead(signal?: AbortSignal): Promise<WfdRecord> {
      const result = await transport.call({ protocol_version: 2, request_id: `publication-head-${userTableDigest(contract.target).slice(0, 40)}`,
        operation: 'capabilities.search', arguments: { dataset_id: contract.target.datasetId } }, { signal });
      if (!transport.check('capabilities_result', result)) invalid();
      return verifyUserWfdCapability(result, contract.target, contract.instanceId, principalId);
    },
    async publish(envelope: WfdEnvelope, signal?: AbortSignal): Promise<WfdRecord> {
      const sealed = freeze(copy(envelope)); validate(sealed);
      const result = await transport.call(sealed, { signal });
      try { return receipt(result, sealed, sealed.arguments.publication_id as string); }
      catch (error) { if (error instanceof DataServiceError) error.mayHaveBeenAccepted = true; throw error; }
    },
    async lookup(publicationId: string, signal?: AbortSignal): Promise<WfdRecord> {
      identifier(publicationId);
      const result = await transport.call({ protocol_version: 2, request_id: `publication-lookup-${wfdSha256(publicationId).slice(0, 40)}`,
        operation: 'data.jobs.get', arguments: { publication_id: publicationId } }, { signal });
      return receipt(result, undefined, publicationId);
    },
    async readCommitted(committed: WfdRecord, envelope: WfdEnvelope, signal?: AbortSignal): Promise<WfdRecord> {
      const table = validate(envelope); receipt(committed, envelope, envelope.arguments.publication_id as string);
      if (committed.state !== 'committed') fail('WFD_PUBLICATION_SNAPSHOT', '派生固定读取需要实际 committed 回执。');
      const fields = (object(table.descriptor).fields as WfdRecord[]).map(field => String(field.name));
      const result = await transport.call({ protocol_version: 2, request_id: `publication-read-${userTableDigest({ publicationId: envelope.arguments.publication_id, snapshot: committed.snapshot_id }).slice(0, 40)}`,
        operation: 'data.read', arguments: { dataset_id: contract.target.datasetId, snapshot_id: committed.snapshot_id, fields, limit: 512 } }, { signal });
      if (!transport.check('read_result', result)) invalid();
      return verifyUserPublicationReadback(result, committed, envelope, contract, binding);
    },
  });
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

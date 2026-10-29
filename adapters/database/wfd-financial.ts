import type { CoreDatabase } from '../../platform/state/database.js';
import type { PermissionCapability } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { FinancialBar, FinancialMetadata, FinancialSnapshotInput, FinancialSnapshotRead } from '../../modules/financial/types.js';
import { validateFinancialData } from '../../modules/financial/service.js';
import { decodeWfdScaledInteger, encodeWfdScaledInteger } from './wfd-table.js';
import { canonicalWfdJson as canonical, createWfdTransport, isFixedWfdSnapshot, isWfdRecord, wfdSha256,
  type WfdEnvelope, type WfdRecord, type WfdTransportConfig } from './wfd-transport.js';

export interface WfdFinancialDeclaration {
  id: string;
  version: string;
  /** 字段可取声明映射的子集，其余身份、完整窗口和参考依赖必须逐项相同。 */
  reference: Omit<FinancialSnapshotInput, 'fields'>;
  descriptorSha256: string;
  rowsResourceSha256: string;
  rowCount: number;
  /** 明确授权完整的有界原字段读取，以验证整份 rows.json（数值行资源）摘要。 */
  sourceFields: string[];
  metadata: FinancialMetadata;
  fieldMapping: {
    timestamp: { field: string; encoding: 'YYYYMMDD' | 'YYYY-MM-DD'; unit: string };
    instrument: { field: string; storedValue: number; symbol: string; codebookRevision: string }
      | { field: string; storedValue: string; symbol: string; dtype: 'string'; unit: 'opaque_series_id' };
    prices: { close: string; open?: string; high?: string; low?: string };
    /** 原声明的价格字段单位；与 metadata.currency（明确币种）相同，每股含义由本声明承担。 */
    priceUnit: string;
    availability?: { availableAt: string; barClosed: string };
  };
  bars: Array<{ timestamp: string; available_at: string; bar_closed: true }>;
  provenance: JsonValue;
  lineageSha256: string;
  /** 受信宿主根据真实材料和已采用语义写入，模型不能自报归属。 */
  origin?: WfdFinancialOrigin;
}
export interface WfdFinancialOrigin {
  subjectId: string; conversationId: string; branchId: string; materialId: string; semanticDecisionId: string;
}
export interface WfdFinancialDatasetBinding {
  dataset_id: string; unit_id: string; output_id: string; definition_rev: string; schema_rev: string;
  mapping_version: string; contract_version: 'wfd-table/v0.2';
}
export interface WfdFinancialSemanticAdoption {
  state: 'adopted'; decisionId: string; semanticRecordSha256: string; originalSha256: string;
  subjectId: string; conversationId: string; branchId: string; materialId: string; source: JsonValue;
}
export interface WfdFinancialRegistration {
  declaration: WfdFinancialDeclaration; receipt: WfdRecord; readback: WfdRecord; semanticAdoption: WfdFinancialSemanticAdoption;
}
export type WfdFinancialReaderConfig = WfdTransportConfig & {
  credentialReference: string;
  instanceId?: string;
  declarations?: readonly WfdFinancialDeclaration[];
  registry?: {
    database: CoreDatabase; providerId: string; subjectId: string; purpose: 'user_test' | 'isolation_test';
    datasetBinding: WfdFinancialDatasetBinding;
    /** 来自实际模式及宿主绑定；不从数据集名字猜测。 */
    dataKind: string;
    assertReadable(reference: FinancialSnapshotInput, origin: WfdFinancialOrigin, context: TaskExecutionContext): void | Promise<void>;
  };
};
export interface WfdFinancialReader {
  readSnapshot(reference: FinancialSnapshotInput, context: TaskExecutionContext): Promise<FinancialSnapshotRead>;
  snapshotBinding: { version: string; contractDigest: string };
  snapshotCapabilities: readonly PermissionCapability[];
  registerCommittedSnapshot(registration: WfdFinancialRegistration): { declarationSha256: string; registeredAt: number };
  getDeclaration(reference: FinancialSnapshotInput | WfdFinancialDeclaration['reference']): WfdFinancialDeclaration | null;
  listDeclarations(): WfdFinancialDeclaration[];
}

const VERSION = 'wfd-financial-v0.2-2';
const SHA = /^[0-9a-f]{64}$/;
const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
function fail(code: string, message: string): never { throw new TaskError(code, message); }
function object(value: unknown): WfdRecord { if (!isWfdRecord(value)) fail('WFD_FINANCIAL_INVALID', 'WFD 金融声明或响应需要明确 JSON 对象。'); return value; }
function identifier(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value)) fail('WFD_FINANCIAL_INVALID', '金融声明身份必须为有界标识，不能是地址或路径。');
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('WFD_FINANCIAL_INVALID', '金融行声明需要有效业务日期。');
  return value;
}
function zonedInstant(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function target(reference: WfdFinancialDeclaration['reference']): WfdRecord {
  return { unit_id: reference.outputIdentity.unitId, output_id: reference.outputIdentity.outputId,
    definition_rev: reference.outputIdentity.definitionRevision, schema_rev: reference.outputIdentity.schemaRevision };
}
function active(context: Pick<TaskExecutionContext, 'signal'>): void {
  if (context.signal.aborted) fail('CALL_ABORTED', '金融固定读取的等待已中止。');
}

/** 独立金融读取边界；只接受宿主已封闭声明的精确快照，不依赖收集交接意图。 */
export function createWfdFinancialReader(configuration: WfdFinancialReaderConfig): WfdFinancialReader {
  identifier(configuration.credentialReference);
  const registry = configuration.registry ? { ...configuration.registry, datasetBinding: structuredClone(configuration.registry.datasetBinding) } : undefined;
  if ((!registry && (!Array.isArray(configuration.declarations) || !configuration.declarations.length))
    || (configuration.declarations !== undefined && (!Array.isArray(configuration.declarations) || configuration.declarations.length > 64))
    || (registry && configuration.declarations?.length)) fail('WFD_FINANCIAL_UNBOUND', '静态隔离声明与受信持久登记分别装配，动态路径必须逐份核登记证据。');
  if ((configuration.maxResponseBytes ?? 400_000) > 400_000) fail('WFD_FINANCIAL_INVALID', '金融固定读取响应预算最多 400,000 字节。');
  const transport = createWfdTransport({ ...configuration, maxResponseBytes: configuration.maxResponseBytes ?? 400_000 });
  const newProtocol = transport.schema['x-contract-revision'] === '0.1.3', instanceId = transport.instanceId;
  const datasetBinding = structuredClone(registry?.datasetBinding ?? transport.datasetBinding) as WfdFinancialDatasetBinding;
  if (registry) {
    identifier(registry.providerId); identifier(registry.subjectId);
    if (!transport.check('identifier', instanceId)) fail('WFD_FINANCIAL_INVALID', '动态声明需要宿主固定的真实WFD实例身份。');
    if (!['isolation_test', 'user_test'].includes(registry.purpose) || typeof registry.assertReadable !== 'function'
      || !registry.dataKind || !transport.check('target', { unit_id: datasetBinding.unit_id, output_id: datasetBinding.output_id,
        definition_rev: datasetBinding.definition_rev, schema_rev: datasetBinding.schema_rev })
      || datasetBinding.contract_version !== 'wfd-table/v0.2') fail('WFD_FINANCIAL_INVALID', '持久声明需要受控主体、提供方、实际目标和当前权限核对。');
    if (!transport.check('identifier', datasetBinding.dataset_id) || !transport.check('identifier', datasetBinding.mapping_version)) fail('WFD_FINANCIAL_INVALID', '动态声明的数据集或映射版本不符合正式身份合同。');
  }
  const declarations: WfdFinancialDeclaration[] = structuredClone([...(configuration.declarations ?? [])]);
  const registered = new Map<string, WfdFinancialDeclaration>();
  function assertFixtureProvenance(declaration: WfdFinancialDeclaration, semantic?: WfdFinancialSemanticAdoption): void {
    if (registry?.purpose !== 'user_test' || declaration.metadata.synthetic !== true) return;
    const source = object(object(declaration.provenance).declaration), sourceOrigin = object(source.origin);
    if (source.sourceKind !== 'self-generated-test' || source.synthetic !== true || !transport.check('identifier', source.testFixtureId)
      || !transport.check('sha256', source.originalSha256) || !transport.check('sha256', source.semanticRecordSha256)
      || source.materialId !== declaration.origin?.materialId || source.proposalId !== declaration.origin?.semanticDecisionId
      || sourceOrigin.conversationId !== declaration.origin?.conversationId || sourceOrigin.branchId !== declaration.origin?.branchId
      || (semantic && (source.originalSha256 !== semantic.originalSha256 || source.semanticRecordSha256 !== semantic.semanticRecordSha256))) {
      fail('WFD_FINANCIAL_REGISTRATION_UNVERIFIED', '用户测试的合成标记须来自受信自生成样本，原件、语义摘要及来源必须匹配实际采用记录。');
    }
  }
  function validateDeclaration(declaration: WfdFinancialDeclaration): void {
    const value = object(declaration);
    if (['id', 'version', 'reference', 'descriptorSha256', 'rowsResourceSha256', 'rowCount', 'sourceFields', 'metadata',
      'fieldMapping', 'bars', 'provenance', 'lineageSha256'].some(key => !Object.hasOwn(value, key))) fail('WFD_FINANCIAL_INVALID', '金融声明缺少必需字段。');
    if (Object.keys(value).some(key => !['id', 'version', 'reference', 'descriptorSha256', 'rowsResourceSha256', 'rowCount',
      'sourceFields', 'metadata', 'fieldMapping', 'bars', 'provenance', 'lineageSha256', 'origin'].includes(key))) fail('WFD_FINANCIAL_INVALID', '金融声明含未支持字段。');
    identifier(declaration.id); identifier(declaration.version);
    const reference = object(declaration.reference), mapping = declaration.fieldMapping;
    object(declaration.metadata); object(mapping); object(mapping.timestamp); object(mapping.instrument); object(mapping.prices);
    const outputIdentity = object(reference.outputIdentity);
    if (Object.keys(outputIdentity).sort().join(',') !== 'definitionRevision,outputId,schemaRevision,unitId') fail('WFD_FINANCIAL_INVALID', '金融声明的输出身份字段不完整。');
    Object.values(outputIdentity).forEach(identifier);
    if (Object.keys(reference).sort().join(',') !== 'kind,outputIdentity,productId,range,referenceDependencies,snapshotId,useMode'
      || reference.kind !== 'snapshot' || !isFixedWfdSnapshot(reference.snapshotId) || reference.useMode !== 'analysis'
      || reference.productId !== datasetBinding.dataset_id || !transport.check('target', target(declaration.reference))
      || target(declaration.reference).unit_id !== datasetBinding.unit_id || target(declaration.reference).output_id !== datasetBinding.output_id
      || target(declaration.reference).definition_rev !== datasetBinding.definition_rev || target(declaration.reference).schema_rev !== datasetBinding.schema_rev
      || !Array.isArray(reference.referenceDependencies) || reference.referenceDependencies.length !== 0
      || !SHA.test(declaration.descriptorSha256) || !SHA.test(declaration.rowsResourceSha256)
      || !SHA.test(declaration.lineageSha256)
      || !Number.isSafeInteger(declaration.rowCount) || declaration.rowCount < 1 || declaration.rowCount > 512
      || !Array.isArray(declaration.bars) || declaration.bars.length !== declaration.rowCount) {
      fail('WFD_FINANCIAL_INVALID', '声明必须绑定明确的 v0.2 快照、目标、完整窗口、空参考依赖及 1 至 512 行。');
    }
    if (!Array.isArray(declaration.sourceFields) || !declaration.sourceFields.length || declaration.sourceFields.length > 64
      || new Set(declaration.sourceFields).size !== declaration.sourceFields.length
      || declaration.sourceFields.some(field => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field))
      || !mapping || !['YYYYMMDD', 'YYYY-MM-DD'].includes(mapping.timestamp?.encoding)
      || mapping.timestamp.unit !== mapping.timestamp.encoding
      || !(typeof mapping.instrument?.storedValue === 'number' ? Number.isSafeInteger(mapping.instrument.storedValue)
        && 'codebookRevision' in mapping.instrument && !!mapping.instrument.codebookRevision
        : mapping.instrument && 'dtype' in mapping.instrument && mapping.instrument.dtype === 'string'
          && mapping.instrument.unit === 'opaque_series_id'
          && !!mapping.instrument.storedValue
          && mapping.instrument.storedValue === declaration.metadata.series_id)
      || typeof mapping.instrument.symbol !== 'string' || !mapping.instrument.symbol.trim() || !mapping.prices?.close
      || mapping.priceUnit !== declaration.metadata.currency || declaration.metadata.price_unit !== 'currency_per_share'
      || (registry?.purpose === 'user_test' ? typeof declaration.metadata.synthetic !== 'boolean' : declaration.metadata.synthetic !== true) || declaration.metadata.frequency !== '1d'
      || declaration.metadata.availability_basis !== 'explicit_per_bar' || declaration.provenance === null
      || !zonedInstant(declaration.metadata.as_of)
      || (typeof declaration.provenance === 'string' && !declaration.provenance.trim())
      || (isWfdRecord(declaration.provenance) && !Object.keys(declaration.provenance).length)
      || (typeof declaration.provenance !== 'string' && !isWfdRecord(declaration.provenance))) {
      fail('WFD_FINANCIAL_INVALID', '宿主须显式授权完整原字段集合、对象编码、时间映射、币种与每股含义以及声明出处。');
    }
    if (registry?.purpose === 'user_test' && (!mapping.availability
      || typeof mapping.instrument.storedValue !== 'string')) fail('WFD_FINANCIAL_INVALID', '用户测试须按实际文本序列身份和逐行可得、闭合字段读取。');
    assertFixtureProvenance(declaration);
    const priceNames = Object.keys(mapping.prices);
    if (priceNames.some(field => !PRICE_FIELDS.includes(field as typeof PRICE_FIELDS[number]))
      || new Set(Object.values(mapping.prices)).size !== priceNames.length
      || [mapping.timestamp.field, mapping.instrument.field, ...Object.values(mapping.prices), ...Object.values(mapping.availability ?? {})]
        .some(field => !declaration.sourceFields.includes(field))) fail('WFD_FINANCIAL_INVALID', '金融字段映射必须明确且在授权原字段集合内。');
    const range = object(reference.range);
    const start = day(range.start), end = day(range.end);
    if (start !== declaration.metadata.window_start || end !== declaration.metadata.window_end
      || start !== declaration.bars[0]!.timestamp || end !== declaration.bars.at(-1)!.timestamp) fail('WFD_FINANCIAL_INVALID', '只支持声明的完整窗口，不能隐式切片或扩围。');
    let previous = '';
    for (const bar of declaration.bars) {
      const date = day(bar.timestamp);
      if (date <= previous || bar.bar_closed !== true || !zonedInstant(bar.available_at)
        || Date.parse(bar.available_at) > Date.parse(declaration.metadata.as_of)) fail('WFD_FINANCIAL_INVALID', '逐行日期、可得时刻和闭合声明必须完整且有序。');
      previous = date;
    }
    // 复用现有完整金融语义核验，登记阶段也拒绝无效时区、币种和倒填可得时刻。
    validateFinancialData({ metadata: declaration.metadata, rows: declaration.bars.map(bar => ({ ...bar, close: 1 })) },
      'xuen.local-finance.ma', registry?.purpose === 'user_test' ? 'local-review' : 'synthetic-test');
    if (declaration.origin) validateOrigin(declaration.origin);
    if (registry && (!declaration.origin || declaration.origin.subjectId !== registry.subjectId)) fail('WFD_FINANCIAL_INVALID', '动态声明必须保留真实材料、语义决定和会话来源归属。');
  }
  for (const declaration of declarations) {
    validateDeclaration(declaration);
    const key = canonical(declaration.reference);
    if (registered.has(key)) fail('WFD_FINANCIAL_INVALID', '同一精确快照窗口不能绑定重复或冲突声明。');
    registered.set(key, declaration);
  }
  const registryBinding = registry ? { providerId: registry.providerId, subjectId: registry.subjectId, purpose: registry.purpose,
    datasetBinding, dataKind: registry.dataKind, version: 'financial-declaration-registry/2' } : null;
  // 动态声明归属实例及受控合同；端口仅决定本次网络能力，不进入持久逻辑身份。
  // 原静态路径继续绑定原网络地址，避免改变既有隔离声明与封闭任务的规则。
  const contractDigest = wfdSha256(canonical({ version: VERSION, protocolSchemaSha256: transport.contractDigest,
    ...(!registry ? { networkOrigin: transport.origin } : {}), credentialReference: configuration.credentialReference,
    ...(instanceId ? { instanceId } : {}),
    ...(registryBinding ? { registry: registryBinding } : {
      declarations: [...declarations].sort((a, b) => canonical(a.reference) < canonical(b.reference) ? -1 : canonical(a.reference) > canonical(b.reference) ? 1 : 0) }) }));
  if (registry) registry.database.migrate('financial_snapshot_declarations', 1, `CREATE TABLE financial_snapshot_declarations (
    binding_digest TEXT NOT NULL, reference_json TEXT NOT NULL, declaration_json TEXT NOT NULL, declaration_sha256 TEXT NOT NULL,
    registration_json TEXT NOT NULL, registration_sha256 TEXT NOT NULL, registered_at INTEGER NOT NULL,
    PRIMARY KEY(binding_digest,reference_json));`);
  function getDeclaration(reference: FinancialSnapshotInput | WfdFinancialDeclaration['reference']): WfdFinancialDeclaration | null {
    const { fields: _fields, ...scope } = reference as FinancialSnapshotInput;
    const key = canonical(scope);
    const row = registry?.database.connection.prepare('SELECT * FROM financial_snapshot_declarations WHERE binding_digest=? AND reference_json=?')
      .get(contractDigest, key);
    if (row) {
      if (wfdSha256(String(row.declaration_json)) !== row.declaration_sha256 || wfdSha256(String(row.registration_json)) !== row.registration_sha256) fail('WFD_FINANCIAL_REGISTRY_CHANGED', '原受信声明或登记证据与持久摘要不一致。');
      const declaration = JSON.parse(String(row.declaration_json)) as WfdFinancialDeclaration;
      validateDeclaration(declaration);
      if (canonical(declaration.reference) !== key) fail('WFD_FINANCIAL_REGISTRY_CHANGED', '持久声明的精确参考身份已变化。');
      if (registry?.purpose === 'user_test' && declaration.metadata.synthetic === true) {
        const registration = object(JSON.parse(String(row.registration_json)));
        if (canonical(registration.declaration) !== canonical(declaration)) fail('WFD_FINANCIAL_REGISTRY_CHANGED', '原受信声明与登记证据不一致。');
        assertFixtureProvenance(declaration, object(registration.semanticAdoption) as unknown as WfdFinancialSemanticAdoption);
      }
      return structuredClone(declaration);
    }
    return registered.has(key) ? structuredClone(registered.get(key)!) : null;
  }
  function listDeclarations(): WfdFinancialDeclaration[] {
    const values = new Map(registered);
    if (registry) for (const row of registry.database.connection.prepare('SELECT reference_json FROM financial_snapshot_declarations WHERE binding_digest=? ORDER BY reference_json').all(contractDigest)) {
      const scope = JSON.parse(String(row.reference_json)) as WfdFinancialDeclaration['reference'];
      values.set(canonical(scope), getDeclaration(scope)!);
    }
    return [...values.values()].map(value => structuredClone(value));
  }
  function decodeSnapshot(declaration: WfdFinancialDeclaration, request: FinancialSnapshotInput, response: WfdRecord): {
    data: FinancialSnapshotRead['data']; decodedPriceDecimals: Array<Record<string, string>>;
  } {
    const { fields } = request;
    const descriptor = object(response.descriptor), rows = response.rows;
    if (newProtocol && (!transport.check('read_result', response) || response.instance_id !== instanceId
      || response.purpose !== (registry?.purpose ?? 'isolation_test') || response.mode !== (registry?.purpose === 'user_test' ? 'user_test' : 'isolated_synthetic')
      || response.descriptor_sha256 !== declaration.descriptorSha256)) fail('WFD_FINANCIAL_RESPONSE', '固定读取的新模式、实例、用途或实际声明摘要不符。');
    if (response.dataset_id !== request.productId || response.dataset_mapping_version !== datasetBinding.mapping_version
      || response.snapshot_id !== request.snapshotId || canonical(response.target) !== canonical(target(declaration.reference))
      || response.protocol_schema_sha256 !== transport.contractDigest || response.time_capability !== 'fixed_snapshot_only'
      || typeof response.commit_id !== 'string' || !transport.check('identifier', response.commit_id)
      || wfdSha256(canonical(descriptor)) !== declaration.descriptorSha256 || descriptor.contract_version !== 'wfd-table/v0.2'
      || Object.entries(target(declaration.reference)).some(([key, value]) => descriptor[key] !== value)
      || descriptor.snapshot_id !== request.snapshotId
      || descriptor.data_kind !== (registry?.dataKind ?? 'synthetic')
      || canonical(descriptor.allowed_purposes) !== canonical([registry?.purpose ?? 'isolation_test']) || !Array.isArray(rows) || rows.length !== declaration.rowCount
      || rows.length > 512 || response.row_count !== rows.length || response.returned_rows !== rows.length
      || descriptor.row_count !== rows.length || response.next_cursor !== null
      || canonical(response.fields) !== canonical(declaration.sourceFields)
      || canonical(response.coverage) !== canonical(descriptor.coverage)) fail('WFD_FINANCIAL_RESPONSE', 'WFD 固定读取的身份、版本、声明摘要、完整字段或计数不一致。');
    const resource = object(descriptor.data_resource), lineage = object(response.lineage);
    if (Object.keys(resource).sort().join(',') !== 'path,sha256' || resource.path !== 'rows.json'
      || resource.sha256 !== declaration.rowsResourceSha256 || wfdSha256(canonical(rows)) !== declaration.rowsResourceSha256
      || wfdSha256(canonical(lineage)) !== declaration.lineageSha256
      || !transport.check('source', lineage.source) || !transport.check('processing', lineage.processing)
      || ['request_id', 'handoff_id', 'collection_task_id', 'processing_task_id'].some(key => !transport.check('identifier', lineage[key]))
      || !transport.check('sha256', lineage.input_sha256) || !transport.check('sha256', lineage.structured_result_sha256)) fail('WFD_FINANCIAL_RESPONSE', 'WFD 数值资源摘要或实际加工来源不完整。');
    if (newProtocol && (!transport.check('ingest_lineage', lineage) || lineage.kind !== 'materials.receive')) fail('WFD_FINANCIAL_RESPONSE', '金融行情必须来自实际材料交接谱系，不把派生计算当作原行情。');
    const { data_resource: _resource, ...candidateDescriptor } = descriptor;
    candidateDescriptor.snapshot_id = null;
    if (!transport.check('table_package', { entrypoint: '库说明.json', descriptor: candidateDescriptor, rows })) fail('WFD_FINANCIAL_RESPONSE', '实际读回表格不符合正式 v0.2 数值契约。');
    const fieldDefinitions = new Map((descriptor.fields as WfdRecord[]).map(field => [String(field.name), field]));
    if (canonical([...fieldDefinitions.keys()]) !== canonical(declaration.sourceFields)
      || rows.some(row => !isWfdRecord(row) || canonical(Object.keys(row).sort()) !== canonical([...declaration.sourceFields].sort()))) fail('WFD_FINANCIAL_RESPONSE', '完整资源的实际字段集合不符合宿主授权。');
    const mapping = declaration.fieldMapping, timeField = fieldDefinitions.get(mapping.timestamp.field),
      instrumentField = fieldDefinitions.get(mapping.instrument.field), stringIdentity = typeof mapping.instrument.storedValue === 'string';
    if (!timeField || timeField.unit !== mapping.timestamp.unit || timeField.scale !== '1' || timeField.role !== 'key'
      || timeField.dtype !== (mapping.timestamp.encoding === 'YYYYMMDD' ? 'safe_integer' : 'string')
      || !instrumentField || instrumentField.dtype !== (stringIdentity ? 'string' : 'safe_integer') || instrumentField.scale !== '1' || instrumentField.role !== 'key'
      || (stringIdentity && (!('unit' in mapping.instrument) || instrumentField.unit !== mapping.instrument.unit))) fail('WFD_FINANCIAL_SEMANTICS', '时间或对象编码的类型、单位、倍率与显式声明不符。');
    if (!stringIdentity) {
      const codebook = object(object(descriptor.codebooks)[mapping.instrument.field]);
      if (!('codebookRevision' in mapping.instrument) || codebook.revision !== mapping.instrument.codebookRevision
        || object(codebook.entries)[String(mapping.instrument.storedValue)] !== mapping.instrument.symbol) fail('WFD_FINANCIAL_SEMANTICS', '原数值身份的明确词表不符。');
    } else if (Object.hasOwn(object(descriptor.codebooks), mapping.instrument.field)) fail('WFD_FINANCIAL_SEMANTICS', '文本序列身份不额外套入数值代码表。');
    if (mapping.availability) {
      const available = fieldDefinitions.get(mapping.availability.availableAt), closed = fieldDefinitions.get(mapping.availability.barClosed);
      if (!available || available.dtype !== 'string' || available.unit !== 'ISO8601-with-timezone' || available.role !== 'metadata'
        || available.scale !== '1' || available.nullable !== false || !closed || closed.dtype !== 'boolean' || closed.unit !== 'boolean'
        || closed.role !== 'metadata' || closed.scale !== '1' || closed.nullable !== false) fail('WFD_FINANCIAL_SEMANTICS', '实际可得时刻和闭合字段的类型、单位、倍率不符。');
    }
    for (const name of Object.values(mapping.prices)) {
      const field = fieldDefinitions.get(name);
      if (!field || field.dtype !== 'safe_integer' || field.role !== 'value' || field.nullable !== false
        || field.unit !== mapping.priceUnit || typeof field.scale !== 'string' || !/^10{0,18}$/.test(field.scale)) fail('WFD_FINANCIAL_SEMANTICS', '价格必须按 v0.2 明确安全整数、倍率、单位和币种；不猜测旧版数值。');
    }
    const decodedPriceDecimals: Array<Record<string, string>> = [];
    const bars: FinancialBar[] = rows.map((rowValue, index) => {
      const row = object(rowValue), declaredBar = declaration.bars[index]!;
      const dateValue = row[mapping.timestamp.field];
      const timestamp = mapping.timestamp.encoding === 'YYYYMMDD' && typeof dateValue === 'number' && Number.isSafeInteger(dateValue)
        && /^\d{8}$/.test(String(dateValue)) ? `${String(dateValue).slice(0, 4)}-${String(dateValue).slice(4, 6)}-${String(dateValue).slice(6, 8)}` : dateValue;
      if (day(timestamp) !== declaredBar.timestamp || row[mapping.instrument.field] !== mapping.instrument.storedValue) fail('WFD_FINANCIAL_SEMANTICS', '实际行对象或日期与逐行金融声明不符。');
      if (mapping.availability && (row[mapping.availability.availableAt] !== declaredBar.available_at
        || row[mapping.availability.barClosed] !== true || row[mapping.availability.barClosed] !== declaredBar.bar_closed)) fail('WFD_FINANCIAL_SEMANTICS', '实际行可得时刻或闭合事实与已采用的金融声明不一致。');
      const prices: Record<string, number> = {};
      const exactPrices: Record<string, string> = {};
      for (const field of PRICE_FIELDS) if (fields.includes(field) && mapping.prices[field]) {
        const name = mapping.prices[field]!, stored = row[name];
        if (typeof stored !== 'number' || !Number.isSafeInteger(stored)) fail('WFD_FINANCIAL_SEMANTICS', '价格存储值不是精确安全整数。');
        const scale = String(fieldDefinitions.get(name)!.scale);
        exactPrices[field] = decodeWfdScaledInteger(stored, scale);
        const converted = Number(exactPrices[field]);
        let preservesStoredValue = false;
        try { preservesStoredValue = Number.isFinite(converted) && encodeWfdScaledInteger(String(converted), scale) === stored; }
        catch { /* 不能精确回编的计算表示不能使用原始声明的精确价格身份。 */ }
        if (!preservesStoredValue) fail('FINANCIAL_PRECISION_LOSS', '价格转为计算数值后不能按正式倍率精确回编原存储整数，已拒绝计算输入。');
        prices[field] = converted;
      }
      decodedPriceDecimals.push(exactPrices);
      return { timestamp: declaredBar.timestamp, ...prices, close: prices.close!,
        available_at: declaredBar.available_at, bar_closed: declaredBar.bar_closed };
    });
    const data = validateFinancialData({ metadata: structuredClone(declaration.metadata), rows: bars },
      fields.includes('open') ? 'xuen.local-finance.bullish_engulfing' : 'xuen.local-finance.ma', registry?.purpose === 'user_test' ? 'local-review' : 'synthetic-test');
    return { data, decodedPriceDecimals };
  }
  function registerCommittedSnapshot(registration: WfdFinancialRegistration): { declarationSha256: string; registeredAt: number } {
    if (!registry) fail('WFD_FINANCIAL_REGISTRY_UNBOUND', '静态隔离路径没有动态登记权。');
    const sealed = JSON.parse(canonical(registration)) as WfdFinancialRegistration;
    const { declaration, receipt, readback, semanticAdoption: semantic } = sealed;
    validateDeclaration(declaration);
    const origin = declaration.origin!;
    if (!transport.check('receipt', receipt) || receipt.state !== 'committed' || receipt.owner_service !== 'wfd'
      || (newProtocol && (receipt.instance_id !== instanceId || receipt.mode !== readback.mode || receipt.purpose !== readback.purpose || receipt.operation !== 'materials.receive'))
      || receipt.protocol_schema_sha256 !== transport.contractDigest || receipt.dataset_id !== datasetBinding.dataset_id
      || receipt.dataset_mapping_version !== datasetBinding.mapping_version || receipt.snapshot_id !== declaration.reference.snapshotId
      || receipt.commit_id !== readback.commit_id || canonical(receipt.target) !== canonical(target(declaration.reference))
      || !semantic || semantic.state !== 'adopted' || !SHA.test(semantic.semanticRecordSha256) || !SHA.test(semantic.originalSha256)
      || semantic.decisionId !== origin.semanticDecisionId || semantic.materialId !== origin.materialId
      || semantic.subjectId !== origin.subjectId || semantic.conversationId !== origin.conversationId || semantic.branchId !== origin.branchId
      || semantic.source === null || (typeof semantic.source !== 'string' && !isWfdRecord(semantic.source))
      || (typeof semantic.source === 'string' ? !semantic.source.trim() : Object.keys(semantic.source).length === 0)) {
      fail('WFD_FINANCIAL_REGISTRATION_UNVERIFIED', '动态声明需要真实已提交回执、实际固定读回及材料库已采用语义记录的摘要和原件来源。');
    }
    assertFixtureProvenance(declaration, semantic);
    const fields = ['timestamp', 'available_at', 'bar_closed', ...Object.keys(declaration.fieldMapping.prices)] as FinancialSnapshotInput['fields'];
    decodeSnapshot(declaration, { ...declaration.reference, fields }, readback);
    const lineage = object(readback.lineage);
    if (receipt.request_id !== lineage.request_id || receipt.handoff_id !== lineage.handoff_id) fail('WFD_FINANCIAL_REGISTRATION_UNVERIFIED', '提交回执与实际读取的上游交接身份不一致。');
    const dependencies = object(object(readback.descriptor).dependencies);
    if (!Array.isArray(dependencies.regenerate) || !dependencies.regenerate.includes(semantic.originalSha256)) fail('WFD_FINANCIAL_REGISTRATION_UNVERIFIED', '语义记录的原件摘要没有绑定本次固定快照的实际再生成来源。');
    const key = canonical(declaration.reference), declarationJson = canonical(declaration), declarationSha256 = wfdSha256(declarationJson);
    const registrationJson = canonical(sealed);
    if (Buffer.byteLength(registrationJson) > 400_000) fail('WFD_FINANCIAL_INVALID', '受信声明与实际登记证据超过有界保管预算。');
    return registry.database.transaction(() => {
      const previous = getDeclaration(declaration.reference);
      if (previous) {
        if (canonical(previous) !== declarationJson) fail('WFD_FINANCIAL_DECLARATION_CONFLICT', '同一精确快照参考已有不同声明；不能覆盖或借新语义改写。');
        const row = registry.database.connection.prepare('SELECT registered_at,registration_sha256 FROM financial_snapshot_declarations WHERE binding_digest=? AND reference_json=?').get(contractDigest, key);
        if (!row) fail('WFD_FINANCIAL_DECLARATION_CONFLICT', '静态声明不能被动态登记覆盖。');
        if (row.registration_sha256 !== wfdSha256(registrationJson)) fail('WFD_FINANCIAL_DECLARATION_CONFLICT', '同一声明的真实回执或语义来源证据不同，不能覆盖原登记。');
        return { declarationSha256, registeredAt: Number(row.registered_at) };
      }
      const count = registry.database.connection.prepare('SELECT COUNT(*) AS count FROM financial_snapshot_declarations WHERE binding_digest=?').get(contractDigest);
      if (Number(count?.count) >= 64) fail('WFD_FINANCIAL_INVALID', '本次有界用户测试最多登记64份固定窗口。');
      const registeredAt = Date.now();
      registry.database.connection.prepare('INSERT INTO financial_snapshot_declarations VALUES(?,?,?,?,?,?,?)')
        .run(contractDigest, key, declarationJson, declarationSha256, registrationJson, wfdSha256(registrationJson), registeredAt);
      return { declarationSha256, registeredAt };
    });
  }
  const snapshotCapabilities: readonly PermissionCapability[] = Object.freeze([
    { action: 'network', target: { kind: 'network', origin: transport.origin } },
    { action: 'secret', target: { kind: 'secret', name: configuration.credentialReference } },
  ]);
  return Object.freeze({ snapshotBinding: { version: VERSION, contractDigest }, snapshotCapabilities,
    registerCommittedSnapshot, getDeclaration, listDeclarations,
    async readSnapshot(reference: FinancialSnapshotInput, context: TaskExecutionContext): Promise<FinancialSnapshotRead> {
      active(context);
      const request = structuredClone(reference);
      const { fields, ...scope } = request;
      if (!isFixedWfdSnapshot(request.snapshotId) || !Array.isArray(fields) || new Set(fields).size !== fields.length
        || ['timestamp', 'close', 'available_at', 'bar_closed'].some(field => !fields.includes(field as typeof fields[number]))) fail('WFD_FINANCIAL_UNKNOWN', '金融读取只接受明确快照及所需字段。');
      const declaration = getDeclaration(scope);
      if (!declaration) fail('WFD_FINANCIAL_UNKNOWN', '此快照、目标、参考依赖或完整窗口没有受信声明；未发送请求。');
      const permitted = ['timestamp', 'available_at', 'bar_closed', ...Object.keys(declaration.fieldMapping.prices)];
      if (fields.some(field => !permitted.includes(field))) fail('WFD_FINANCIAL_UNKNOWN', '请求字段不在该快照的明确金融映射内。');
      if (registry) await registry.assertReadable(request, declaration.origin!, context);
      active(context);
      const declarationDigest = wfdSha256(canonical(declaration));
      const envelope: WfdEnvelope = { protocol_version: 2, request_id: `financial-read-${wfdSha256(canonical({ request, declarationDigest }))}`,
        operation: 'data.read', arguments: { dataset_id: request.productId, snapshot_id: request.snapshotId,
          fields: declaration.sourceFields, limit: 512 } };
      active(context);
      const response = await transport.call(envelope, { signal: context.signal });
      active(context);
      const { data, decodedPriceDecimals } = decodeSnapshot(declaration, request, response);
      if (registry) await registry.assertReadable(request, declaration.origin!, context);
      active(context);
      return { reference: request, data,
        raw: JSON.parse(canonical({ request: envelope, response, declaration, declarationSha256: declarationDigest,
          authorizedFullSourceFields: declaration.sourceFields, returnedFinancialFields: fields, decodedPriceDecimals,
          decoding: { contractVersion: 'wfd-table/v0.2', rule: 'declared_unit_value=stored_safe_integer/scale' } })) as JsonValue };
    },
  });
}

function validateOrigin(origin: WfdFinancialOrigin): void {
  if (!isWfdRecord(origin) || Object.keys(origin).sort().join(',') !== 'branchId,conversationId,materialId,semanticDecisionId,subjectId') fail('WFD_FINANCIAL_INVALID', '声明来源归属字段不完整。');
  Object.values(origin).forEach(identifier);
}

import type { JsonValue } from '../../contracts/task-contracts.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { AlgorithmSnapshotPort, AlgorithmSnapshotRead, AlgorithmSnapshotReference, AlgorithmSnapshotRowEvidence } from './algorithm-types.js';
import { wfdFixedReadEvidence } from '../collection/purpose-eligibility.js';

/**
 * 新 WFD 产品服务的固定快照端口。
 *
 * 通过 `wfd.product-machine/0.1`（产品机器协议）公开薄入口固定读取。调用者声明的
 * definitionRevision / semantics 必须与真实返回核对：
 *
 * - 定义版本、合同摘要、声明字段和时间轴来自该固定快照的 `contract_discovery`
 *   与 `fixed_read` 实际返回；调用者只能提供预期，必须逐项核对。
 * - 值行只投影 `reference.fields` 中、且被固定定义声明的 value 字段；
 *   business_key / observation_time / subject / record_ref / revision / definition_ref /
 *   contract_ref 等身份、时间、引用元信息放在独立 envelope，不冒充值字段。
 * - `rowsSha256` 保持 null：产品服务没有暴露 full-resource rows_sha256，本端口
 *   只有本地 value projection 摘要，不能假称服务端完整行摘要。
 * - 通过结构化金融语义检查确认日线、复权口径、价格单位、币种和可得时刻；
 *   无法核对时返回 `ALGORITHM_SNAPSHOT_SEMANTICS_UNSUPPORTED`。
 */
export const WFD_PRODUCT_MACHINE_SNAPSHOT_CONTRACT = 'wfd.product-machine/0.1';

export const MACD_SNAPSHOT_SEMANTIC_CONTRACT = Object.freeze({
  declaration: Object.freeze({
    version: 'wfd.semantic-context/1.0',
    frequency: Object.freeze({ day: '1d', '1d': '1d' }),
    timezone: 'Matches every fixed observation time zone',
    roles: Object.freeze({ observation: 'Mapped date field', availability: 'Mapped availability text field', bar_closed: 'true' }),
    priceAdjustmentDirection: 'raw',
  }),
  semantics: Object.freeze({
    frequency: '1d', adjustment: 'unadjusted',
    adjustmentBasis: 'WFD financial.price_adjustment.direction=raw',
    barClosed: true, availability: Object.freeze({ kind: 'column' }),
    currency: 'CNY', priceUnit: 'currency_per_share',
  }),
});

export interface WfdProductMachineSnapshotOptions {
  /** 缺省时端口报告 unavailable；装配真实客户端由受信宿主完成。 */
  client?: WfdProductMachineClient;
  /** 受控连接中固定的实例身份；不接受 reference 自行改写。 */
  instanceId: string;
}

export interface ProductMachineFieldDefinition {
  field_code: string;
  data_type: string | null;
  unit_code: string | null;
  time_role: string | null;
  measurement_nature: string | null;
}

export interface ProductMachineCellMetadata {
  row: number;
  field: string;
  present: boolean;
  value: unknown;
  value_state: string | null;
  data_type: string | null;
  unit_code: string | null;
  unit_ref: string | null;
  declared_unit_code: string | null;
  safe_value_state: boolean;
}

export interface ProductMachineCellInspection {
  cells: ProductMachineCellMetadata[];
  unsafe: ProductMachineCellMetadata[];
}

/**
 * 逐单元格保留 value/value_state/data_type/unit_code/unit_ref，不把
 * unknown/null 与 not_applicable/null 抹成同一个裸 null。算法只接受
 * value_state=valid_value 且 value 非 null 的单元格；其余明确拒绝。
 */
export function extractSelectedCells(rows: WfdRecord[], fields: string[], definitions?: ProductMachineFieldDefinition[],
  defaultUnitCode?: string | null): ProductMachineCellInspection {
  const cells: ProductMachineCellMetadata[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const field of fields) {
      const cell = valueCell(row, field);
      const present = cell !== null;
      const definition = definitions?.find(item => item.field_code === field);
      cells.push({
        row: rowIndex,
        field,
        present,
        value: cell?.value ?? null,
        value_state: cell?.value_state ?? null,
        data_type: cell?.data_type ?? null,
        unit_code: cell?.unit_code ?? null,
        unit_ref: cell?.unit_ref ?? null,
        declared_unit_code: definition?.unit_code ?? (fields.length === 1 ? defaultUnitCode ?? null : null),
        safe_value_state: present && cell?.value_state === 'valid_value'
          && cell.value !== null && cell.value !== undefined,
      });
    }
  }
  return { cells, unsafe: cells.filter(cell => !cell.safe_value_state) };
}

export interface ProductMachineSemanticsInspection {
  status: 'supported' | 'unsupported';
  product_id: string | null;
  payload_kind: string | null;
  definition: { version: string | null; digest: string | null; id: string | null };
  contract: { digest: string | null; set_version: string | null };
  declared_fields: { source: string; count: number; fields: ProductMachineFieldDefinition[] };
  observed: {
    semantic_code: string | null;
    definition_authority: string | null;
    measurement_nature: string | null;
    time_role: string | null;
    time_axis: { precisions: string[]; timezones: string[]; statuses: string[] };
    unit_codes: Record<string, string | null>;
    selected_fields: string[];
  };
  structured: Record<string, { value: unknown; source: string } | null>;
  derived: {
    frequency: { value: string | null; basis: string[] };
    timezone: { value: string | null; basis: string[] };
    currency: { value: string | null; basis: string[] };
    price_unit: { value: string | null; basis: string[] };
  };
  effective: {
    frequency: { value: string | null; source: string } | null;
    timezone: { value: string | null; source: string } | null;
    currency: { value: string | null; source: string } | null;
    adjustment: { value: string | null; source: string } | null;
    adjustment_basis: { value: string | null; source: string } | null;
    bar_closed: { value: unknown; source: string } | null;
    availability: { value: unknown; source: string } | null;
  };
  caller_expectations: WfdRecord | null;
  caller_expectations_used_as_truth: false;
  missing: string[];
  mismatches: string[];
  reason: string;
}

export function createWfdProductMachineSnapshotPort(options: WfdProductMachineSnapshotOptions): AlgorithmSnapshotPort {
  return {
    status() {
      return options.client
        ? { status: 'available' as const, reason: null }
        : { status: 'unavailable' as const, reason: 'WFD 产品进程端口尚未装配；没有受控连接客户端。' };
    },
    async read(reference, context): Promise<AlgorithmSnapshotRead> {
      const fixed = structuredClone(reference);
      assertReference(fixed);
      if (!options.client) throw new TaskError('ALGORITHM_SNAPSHOT_UNBOUND', 'WFD 产品进程端口尚未装配；没有受控连接客户端。');
      if (fixed.instanceId !== options.instanceId) {
        throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '固定快照实例与受控连接不同；不能跨实例读取。');
      }
      if (fixed.range !== undefined) {
        throw new TaskError('ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED', JSON.stringify({
          product_id: fixed.productId,
          snapshot_id: fixed.snapshotId,
          range: fixed.range,
          reason: 'range filtering is not implemented; refusing to return the whole product under a caller range claim',
          action: 'remove range for a whole fixed product read, or wait for P4 bounded range support',
        }));
      }
      if (fixed.expectedRowsSha256 !== undefined) {
        throw new TaskError('ALGORITHM_SNAPSHOT_UNSUPPORTED', '当前产品服务不返回完整行资源摘要；不能用本地投影冒充 expectedRowsSha256。');
      }
      context.signal.throwIfAborted();

      // 先发现固定快照中的实际产品/合同/定义，再读取值行；两者都来自服务端固定返回。
      const discovery = await options.client.discover(fixed.snapshotId, undefined, context.signal);
      const discovered = asArray(discovery.result.products).map(asRecord).filter(product => product.product_id === fixed.productId);
      if (discovered.length !== 1) {
        throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_INVALID',
          `固定快照中产品 ${fixed.productId} 的出现次数为 ${discovered.length}，无法唯一核对定义/合同。`);
      }
      const product = discovered[0];

      const reply = await options.client.read({
        snapshotId: fixed.snapshotId,
        productId: fixed.productId,
        ...(fixed.perspective ? { perspective: fixed.perspective } : {}),
        ...(fixed.at ? { at: fixed.at } : {}),
        ...(fixed.heldScope ? { heldScope: fixed.heldScope } : {}),
        ...(fixed.usableStage ? { usableStage: fixed.usableStage } : {}),
        ...(fixed.includeHistory !== undefined ? { includeHistory: fixed.includeHistory } : {}),
        rowProjection: 'full',
      }, context.signal);
      const result = reply.result;
      if (result.snapshot_id !== fixed.snapshotId) {
        throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '产品服务固定读取返回的 snapshot_id 与请求不同。');
      }
      if (fixed.perspective !== undefined && result.perspective !== fixed.perspective) {
        throw new TaskError('ALGORITHM_SNAPSHOT_PERSPECTIVE_MISMATCH', JSON.stringify({
          requested: fixed.perspective, actual: result.perspective ?? null,
          action: '历史/持有视角必须由实际 WFD 读取实际执行并返回；不能在本机改写视角标签。',
        }));
      }
      if (fixed.at !== undefined && (typeof result.at !== 'string' || result.at !== fixed.at)) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CUTOFF_MISMATCH', JSON.stringify({
          requested: fixed.at, actual: result.at ?? null,
          action: '历史截止必须由实际 WFD 读取固定并返回；不能用业务日期或当前时间替代。',
        }));
      }
      const rawRows = Array.isArray(result.rows) ? result.rows.filter(isWfdRecord) : [];
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      const declaredRows = typeof result.row_count === 'number' ? result.row_count : null;
      if (declaredRows === null || rawRows.length !== declaredRows) {
        throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '产品服务固定读取返回的行数与声明不一致；拒绝截断采用。');
      }
      if (rawRows.some(row => row.product_id !== fixed.productId)) {
        throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '固定读取结果含其他产品行；拒绝跨产品采用。');
      }
      if (rawRows.length === 0) {
        if (fixed.perspective !== undefined && fixed.perspective !== 'snapshot_contents') {
          throw new TaskError('ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION', JSON.stringify({
            product_id: fixed.productId, snapshot_id: fixed.snapshotId,
            perspective: fixed.perspective, at: fixed.at ?? null, diagnostics: diagnostics.slice(0, 64),
            action: '该固定快照没有在所请求历史视角/截止下合格的具体版本；不退回当前版本或快照内容。',
          }));
        }
        throw new TaskError('ALGORITHM_SNAPSHOT_EMPTY', '固定快照产品没有行；算法入口不接受空输入。');
      }
      if (fixed.expectedRowCount !== undefined && rawRows.length !== fixed.expectedRowCount) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '固定快照行数与本次明确引用不同。');
      }

      const identity = verifyFixedIdentity(product, rawRows, fixed);
      const fieldEvidence = verifyFixedFields(product, rawRows, fixed);
      const inspection = inspectProductMachineSemantics(product, rawRows, fixed);
      if (inspection.status !== 'supported') {
        throw new TaskError('ALGORITHM_SNAPSHOT_SEMANTICS_UNSUPPORTED', JSON.stringify({
          product_id: fixed.productId,
          snapshot_id: fixed.snapshotId,
          definition: identity.definition,
          contract: identity.contract,
          payload_kind: inspection.payload_kind,
          caller_expectations_used_as_truth: false,
          caller_expectations: inspection.caller_expectations,
          missing: inspection.missing,
          mismatches: inspection.mismatches,
          observed: inspection.observed,
          derived: inspection.derived,
          structured: inspection.structured,
          action: '核对 WFD 固定定义的 semantic_context（语义声明）、逐字段单位和逐行时间后再提交 MACD。',
        }));
      }

      const valueRows = projectValueRows(rawRows, fixed.fields);
      const envelopeRows = rawRows.map(projectEnvelopeRow);
      const cellInspection = extractSelectedCells(rawRows, fixed.fields, fieldEvidence.definitions,
        text(asRecord(product.declaration).unit_code));
      const projectionSha256 = wfdSha256(canonicalWfdJson(valueRows));
      const envelopeSha256 = wfdSha256(canonicalWfdJson(envelopeRows));
      const cellMetadataSha256 = wfdSha256(canonicalWfdJson(cellInspection.cells));
      const resolution = {
        contract: WFD_PRODUCT_MACHINE_SNAPSHOT_CONTRACT,
        operation: 'fixed_read',
        instanceId: options.instanceId,
        productId: fixed.productId,
        snapshotId: fixed.snapshotId,
        definition: identity.definition,
        contract_ref: identity.contract,
        fields: {
          requested: fixed.fields,
          declared: fieldEvidence.declared,
          definitions: fieldEvidence.definitions,
          projection: 'selected_declared_value_fields_only',
        },
        rowCount: valueRows.length,
        rowsSha256: null,
        rowsSha256Basis: 'not_exposed_by_wfd_product_service',
        valueProjectionSha256: projectionSha256,
        valueProjection: {
          basis: 'local_selected_declared_value_fields_only',
          fields: fixed.fields,
          rowCount: valueRows.length,
          sha256: projectionSha256,
          excludes: ['business_key', 'observation_time', 'subject', 'record_ref', 'revision', 'definition_ref', 'contract_ref', 'eligibility'],
        },
        cell_metadata: {
          basis: 'per_cell_value_state_type_unit_metadata_not_value_fields',
          fields: fixed.fields,
          cells: cellInspection.cells,
          unsafe: cellInspection.unsafe,
          sha256: cellMetadataSha256,
        },
        envelope: {
          basis: 'identity_time_reference_metadata_not_value_fields',
          rowCount: envelopeRows.length,
          sha256: envelopeSha256,
          rows: envelopeRows,
        },
        semantics: inspection,
        verification: {
          scope: 'server_identity_definition_contract_fields_and_value_projection',
          definitionVersionsChecked: identity.definitionVersions,
          contractDigestsChecked: identity.contractDigests,
          rowsDefinitionVerified: true,
          fieldsCheckedPerRow: true,
          declaredFieldsVerified: true,
          semanticsStatus: 'supported',
          rowsSha256RecomputedLocally: false,
          note: 'rowsSha256 is null: WFD product service does not expose a full-resource row digest. valueProjectionSha256 is local selected-value-only.',
        },
        transport: reply.transport,
        discoveryTransport: discovery.transport,
        historicalRead: {
          requestedPerspective: fixed.perspective ?? 'snapshot_contents',
          requestedAt: fixed.at ?? null,
          actualPerspective: result.perspective ?? null,
          actualAt: result.at ?? null,
          includeHistory: result.include_history ?? null,
          diagnostics: diagnostics.slice(0, 64),
        },
      } as unknown as JsonValue;
      // 逐行提取实际 WFD 资格、公开/持有时间、修订状态和治理证据，供共用用途资格规则消费。
      // 调用者不能覆盖这些字段；没有实际返回就保持空，不按声明补齐。
      const evidence: AlgorithmSnapshotRowEvidence[] = rawRows.map(row => {
        const bundle = wfdFixedReadEvidence({
          objectSha256: projectionSha256,
          product: product as WfdRecord,
          result: result as WfdRecord,
          row: row as WfdRecord,
          contentBasis: `WFD fixed_read 实际产品/定义/合同/字段/分页核对，本地选定值投影 ${projectionSha256}`,
          checkedAtUtc: new Date().toISOString(),
          usableStage: fixed.usableStage ?? null,
        });
        return { object: bundle.object, publicationTime: bundle.publicationTime, holdingTime: bundle.holdingTime,
          revision: bundle.revision, wfdHistory: bundle.wfdHistory, restriction: bundle.restriction,
          wfdDecision: bundle.wfdDecision };
      });
      // 该 union 是既有 AlgorithmSnapshotRead 的固定枚举；只有在本端口已逐行核对
      // 定义/合同/声明字段且语义 supported 后才会返回。更精确的范围见
      // resolution.verification.scope；rowsSha256 仍为 null。
      return {
        reference: fixed,
        rows: valueRows as Record<string, JsonValue>[],
        resolution,
        verifiedScope: 'server_identity_descriptor_and_projection',
        evidence,
      };
    },
  };
}

/** 审计辅助：只读取固定产品/值行的语义，不声称算法资格。 */
export function inspectProductMachineSemantics(
  product: WfdRecord,
  rows: WfdRecord[],
  reference?: AlgorithmSnapshotReference,
): ProductMachineSemanticsInspection {
  const declaration = asRecord(product.declaration);
  const contracts = asRecord(product.contracts);
  const context = asRecord(declaration.semantic_context);
  const contract = MACD_SNAPSHOT_SEMANTIC_CONTRACT;
  const semanticContext = context.version === contract.declaration.version ? context : {};
  const time = asRecord(semanticContext.time);
  const roles = asRecord(time.roles);
  const priceAdjustment = asRecord(asRecord(semanticContext.financial).price_adjustment);
  const declared = fieldDefinitions(product);
  const selected = reference?.fields ?? declared.fields.map(field => field.field_code);
  const selectedDefs = declared.fields.filter(field => selected.includes(field.field_code));
  const definitionRef = asRecord(product.definition_ref);
  const contractRef = asRecord(product.contract_ref);
  const timeAxis = inspectTimeAxis(rows);
  const timeRoles = uniqueText([
    declaration.time_role,
    ...declared.fields.map(field => field.time_role),
  ]);
  const unitCodes: Record<string, string | null> = {};
  for (const field of selectedDefs) unitCodes[field.field_code] = field.unit_code;

  const timestampField = reference?.fieldMapping.timestamp;
  const availabilityField = reference?.fieldMapping.available_at;
  const availabilityDef = selectedDefs.find(field => field.field_code === availabilityField);
  const rawPrice = priceAdjustment.direction === contract.declaration.priceAdjustmentDirection;
  const structured: ProductMachineSemanticsInspection['structured'] = {
    frequency: typeof time.frequency === 'string'
      ? { value: time.frequency === 'day' || time.frequency === '1d' ? contract.declaration.frequency[time.frequency] : time.frequency, source: 'declaration.semantic_context.time.frequency' } : null,
    timezone: typeof time.timezone === 'string'
      ? { value: time.timezone, source: 'declaration.semantic_context.time.timezone' } : null,
    adjustment: rawPrice
      ? { value: contract.semantics.adjustment, source: 'declaration.semantic_context.financial.price_adjustment.direction' } : null,
    adjustment_basis: rawPrice
      ? { value: contract.semantics.adjustmentBasis, source: 'declaration.semantic_context.financial.price_adjustment.direction' } : null,
    bar_closed: roles.bar_closed === contract.declaration.roles.bar_closed
      ? { value: contract.semantics.barClosed, source: 'declaration.semantic_context.time.roles.bar_closed' } : null,
    availability: availabilityDef?.data_type === 'text' && roles.availability === availabilityField
      ? { value: contract.semantics.availability, source: 'declaration.semantic_context.time.roles.availability' } : null,
  };

  const derived = {
    frequency: deriveFrequency(timeRoles, timeAxis.precisions),
    timezone: deriveTimezone(timeAxis.timezones),
    currency: deriveCurrency(selectedDefs),
    price_unit: derivePriceUnit(selectedDefs, reference?.fieldMapping.close),
  };
  const effective = {
    frequency: effectiveValue(structured.frequency, derived.frequency.value, derived.frequency.basis),
    timezone: effectiveValue(structured.timezone, derived.timezone.value, derived.timezone.basis),
    currency: effectiveValue(null, derived.currency.value, derived.currency.basis),
    adjustment: effectiveValue(structured.adjustment, null, []),
    adjustment_basis: effectiveValue(structured.adjustment_basis, null, []),
    bar_closed: effectiveRaw(structured.bar_closed),
    availability: effectiveRaw(structured.availability),
  };

  const missing: string[] = [];
  const mismatches: string[] = [];
  if (product.payload_kind !== 'tabular_rows') missing.push('payload.tabular_rows');
  if (declared.fields.length === 0) missing.push('contract.field_definitions');
  if (selected.length === 0) missing.push('value_fields.selected');
  const declaredCodes = new Set(declared.fields.map(field => field.field_code));
  for (const field of selected) if (!declaredCodes.has(field)) mismatches.push(`field.not_declared:${field}`);
  const timestampDef = declared.fields.find(field => field.field_code === timestampField);
  if (!timestampDef || timestampDef.data_type !== 'text' || timestampDef.unit_code !== 'date') {
    missing.push('value_field.timestamp_date');
  }
  const closeField = reference?.fieldMapping.close;
  const closeDef = declared.fields.find(field => field.field_code === closeField);
  if (!closeDef || closeDef.data_type !== 'decimal' || closeDef.unit_code !== 'cny_per_share') missing.push('value_field.close_price_unit');
  if (timeAxis.precisions.length !== 1) missing.push('time_axis.single_precision');
  if (timeAxis.timezones.length !== 1) missing.push('time_axis.single_timezone');
  if (timeAxis.statuses.some(status => status !== 'known')) missing.push('time_axis.known');
  if (roles.observation !== timestampField || !timestampField)
    mismatches.push('time.roles.observation: must identify the mapped date field');
  if (structured.frequency && derived.frequency.value && structured.frequency.value !== derived.frequency.value)
    mismatches.push('time.frequency: differs from fixed observation precision');
  if (structured.timezone && derived.timezone.value && structured.timezone.value !== derived.timezone.value)
    mismatches.push('time.timezone: differs from fixed observation timezone');
  const closeContext = asRecord(asRecord(declaration.field_semantic_context)[closeField ?? '']);
  const closeAdjustment = asRecord(closeContext.financial).price_adjustment;
  if (closeAdjustment !== undefined && asRecord(closeAdjustment).direction !== contract.declaration.priceAdjustmentDirection)
    mismatches.push('field_semantic_context: the mapped close field does not declare raw prices');
  if (effective.frequency?.value !== '1d' || derived.frequency.value !== '1d') missing.push('frequency.daily');
  if (!effective.timezone?.value || !derived.timezone.value) missing.push('timezone');
  if (!effective.currency?.value) missing.push('currency');
  if (effective.adjustment?.value !== contract.semantics.adjustment) missing.push('adjustment');
  const adjustmentBasis = String(effective.adjustment_basis?.value ?? '').trim();
  if (!adjustmentBasis || /^(unknown|undefined|n\/?a|未知|未确定|不明)$/iu.test(adjustmentBasis)) missing.push('adjustment_basis');
  if (effective.bar_closed?.value !== true) missing.push('bar_closed');
  if (!effective.availability?.value) missing.push('availability');

  const caller = reference?.semantics;
  if (caller) {
    compareExpectation(mismatches, 'frequency', caller.frequency, effective.frequency?.value);
    compareExpectation(mismatches, 'timezone', caller.timezone, effective.timezone?.value);
    compareExpectation(mismatches, 'currency', caller.currency, effective.currency?.value);
    compareExpectation(mismatches, 'adjustment', caller.adjustment, effective.adjustment?.value);
    compareExpectation(mismatches, 'adjustmentBasis', caller.adjustmentBasis, effective.adjustment_basis?.value);
    compareExpectation(mismatches, 'priceUnit', caller.priceUnit, derived.price_unit.value);
    if (effective.availability && caller.availability.kind !== contract.semantics.availability.kind)
      mismatches.push('availability: fixed definition uses the explicitly mapped availability column');
    if (effective.bar_closed && caller.barClosed !== effective.bar_closed.value) {
      mismatches.push(`barClosed: caller=${String(caller.barClosed)} actual=${String(effective.bar_closed.value)}`);
    }
  }

  const reason = missing.length || mismatches.length
    ? `missing=${missing.join(',') || 'none'}; mismatches=${mismatches.join(',') || 'none'}`
    : 'structured contract semantics and fixed value/time evidence are complete for this adapter';
  return {
    status: missing.length === 0 && mismatches.length === 0 ? 'supported' : 'unsupported',
    product_id: text(product.product_id),
    payload_kind: text(product.payload_kind),
    definition: { version: text(definitionRef.version), digest: text(definitionRef.digest), id: text(definitionRef.id) },
    contract: { digest: text(contractRef.digest), set_version: text(contracts.contract_set_version) },
    declared_fields: { source: declared.source, count: declared.fields.length, fields: declared.fields },
    observed: {
      semantic_code: text(declaration.semantic_code),
      definition_authority: text(declaration.definition_authority),
      measurement_nature: text(declaration.measurement_nature),
      time_role: timeRoles.length ? timeRoles.join(',') : null,
      time_axis: timeAxis,
      unit_codes: unitCodes,
      selected_fields: selected,
    },
    structured,
    derived,
    effective,
    caller_expectations: caller ? canonicalRecord(caller) : null,
    caller_expectations_used_as_truth: false,
    missing,
    mismatches,
    reason,
  };
}

function verifyFixedIdentity(product: WfdRecord, rows: WfdRecord[], reference: AlgorithmSnapshotReference) {
  const productDefinition = asRecord(product.definition_ref);
  const productContract = asRecord(product.contract_ref);
  const productVersion = text(productDefinition.version);
  const productDefinitionDigest = text(productDefinition.digest);
  const contractDigest = text(productContract.digest);
  if (!productVersion || !productDefinitionDigest || !contractDigest) {
    throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_INVALID', '固定产品缺少定义版本/定义摘要/合同摘要，不能核对固定身份。');
  }
  const rowVersions = new Set<string>();
  const rowDefinitionDigests = new Set<string>();
  const rowContractDigests = new Set<string>();
  for (const row of rows) {
    const definition = asRecord(row.definition_ref);
    const contract = asRecord(row.contract_ref);
    const version = text(definition.version);
    const definitionDigest = text(definition.digest);
    const rowContractDigest = text(contract.digest);
    if (!version || !definitionDigest || !rowContractDigest) {
      throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_INVALID', '固定读取行缺少定义版本/摘要或合同摘要。');
    }
    rowVersions.add(version);
    rowDefinitionDigests.add(definitionDigest);
    rowContractDigests.add(rowContractDigest);
  }
  if (rowVersions.size !== 1 || rowDefinitionDigests.size !== 1 || rowContractDigests.size !== 1) {
    throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH', JSON.stringify({
      product_id: reference.productId,
      snapshot_id: reference.snapshotId,
      actual_product_definition: productVersion,
      row_definition_versions: [...rowVersions],
      row_definition_digests: [...rowDefinitionDigests],
      row_contract_digests: [...rowContractDigests],
      reason: 'multiple definition/contract identities in one fixed product read',
    }));
  }
  const rowVersion = [...rowVersions][0];
  const rowDefinitionDigest = [...rowDefinitionDigests][0];
  const rowContractDigest = [...rowContractDigests][0];
  if (rowVersion !== productVersion || rowDefinitionDigest !== productDefinitionDigest || rowContractDigest !== contractDigest) {
    throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH', JSON.stringify({
      product_id: reference.productId,
      snapshot_id: reference.snapshotId,
      actual_product_definition: productVersion,
      actual_product_definition_digest: productDefinitionDigest,
      row_definition: rowVersion,
      row_definition_digest: rowDefinitionDigest,
      actual_product_contract_digest: contractDigest,
      row_contract_digest: rowContractDigest,
      reason: 'discovered product identity differs from fixed row identity',
    }));
  }
  if (reference.definitionRevision !== productVersion) {
    throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH', JSON.stringify({
      product_id: reference.productId,
      snapshot_id: reference.snapshotId,
      caller_definition_revision: reference.definitionRevision,
      actual_definition_version: productVersion,
      actual_definition_digest: productDefinitionDigest,
      reason: 'caller definitionRevision does not match the fixed service definition',
    }));
  }
  if (reference.expectedDefinitionSha256 !== undefined
    && reference.expectedDefinitionSha256 !== productDefinitionDigest.replace(/^sha256:/u, '')) {
    throw new TaskError('ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH', '固定快照定义摘要与调用者预期不同。');
  }
  if (reference.contractDigest !== undefined && reference.contractDigest !== contractDigest.replace(/^sha256:/u, '')) {
    throw new TaskError('ALGORITHM_SNAPSHOT_CONTRACT_MISMATCH', '固定快照合同摘要与调用者预期不同。');
  }
  return {
    definition: { version: productVersion, digest: productDefinitionDigest, id: text(productDefinition.id),
      sequence: product.definition_sequence ?? null, compatibility: product.definition_compatibility ?? null },
    contract: { digest: contractDigest, id: text(productContract.id), version: text(productContract.version),
      set_version: text(asRecord(product.contracts).contract_set_version) },
    definitionVersions: rowVersions.size,
    contractDigests: rowContractDigests.size,
  };
}

function verifyFixedFields(product: WfdRecord, rows: WfdRecord[], reference: AlgorithmSnapshotReference) {
  const declared = fieldDefinitions(product);
  if (declared.fields.length === 0) {
    throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_UNSUPPORTED', JSON.stringify({
      product_id: reference.productId,
      snapshot_id: reference.snapshotId,
      payload_kind: text(product.payload_kind),
      requested_fields: reference.fields,
      declared_field_source: declared.source,
      reason: 'fixed contract has no declared value-field definitions; cannot verify field semantics per row',
    }));
  }
  const codes = new Set(declared.fields.map(field => field.field_code));
  const missingDeclared = reference.fields.filter(field => !codes.has(field));
  if (missingDeclared.length) {
    throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `请求字段未在固定定义中声明：${missingDeclared.join(',')}`);
  }
  for (const [index, row] of rows.entries()) {
    for (const field of reference.fields) {
      const cell = valueCell(row, field);
      if (!cell) {
        throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `第 ${index} 行缺少固定定义字段 ${field}；不能只检查首行。`);
      }
      const definition = declared.fields.find(item => item.field_code === field);
      if (cell.data_type && definition?.data_type && cell.data_type !== definition.data_type) {
        throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `第 ${index} 行字段 ${field} 的 data_type 与固定定义不同。`);
      }
      if (cell.unit_code && definition?.unit_code && cell.unit_code !== definition.unit_code) {
        throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `第 ${index} 行字段 ${field} 的 unit_code 与固定定义不同。`);
      }
    }
  }
  const cellInspection = extractSelectedCells(rows, reference.fields, declared.fields);
  if (cellInspection.unsafe.length) {
    throw new TaskError('ALGORITHM_SNAPSHOT_CELL_STATE_UNSUPPORTED', JSON.stringify({
      product_id: reference.productId,
      snapshot_id: reference.snapshotId,
      reason: 'algorithm input requires value_state=valid_value and a non-null value for every selected cell',
      unsafe: cellInspection.unsafe.slice(0, 64),
    }));
  }
  const mappingFields = [reference.fieldMapping.timestamp, reference.fieldMapping.close,
    reference.fieldMapping.open, reference.fieldMapping.high, reference.fieldMapping.low, reference.fieldMapping.available_at]
    .filter((field): field is string => typeof field === 'string' && field.length > 0);
  const mappingNotRequested = mappingFields.filter(field => !reference.fields.includes(field));
  if (mappingNotRequested.length) {
    throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `fieldMapping 字段未包含在 reference.fields：${mappingNotRequested.join(',')}`);
  }
  return {
    declared: declared.fields.map(field => field.field_code),
    definitions: declared.fields.filter(field => reference.fields.includes(field.field_code)),
    source: declared.source,
  };
}

function projectValueRows(rows: WfdRecord[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      const cell = valueCell(row, field);
      if (!cell) throw new TaskError('ALGORITHM_SNAPSHOT_FIELDS_MISMATCH', `第 ${index} 行缺少固定定义字段 ${field}。`);
      projected[field] = cell.value;
    }
    return projected;
  });
}

function projectEnvelopeRow(row: WfdRecord): WfdRecord {
  const inner = asRecord(row.row);
  return {
    product_id: row.product_id ?? null,
    business_key: inner.business_key ?? null,
    observation_time: inner.observation_time ?? null,
    public_time: inner.public_time ?? null,
    subject: row.subject ?? inner.subject ?? null,
    record_ref: row.record_ref ?? null,
    revision: row.revision ?? null,
    revision_state: row.revision_state ?? null,
    definition_ref: row.definition_ref ?? null,
    contract_ref: row.contract_ref ?? null,
    eligibility: row.eligibility ?? null,
  };
}

function valueCell(row: WfdRecord, field: string): {
  value: unknown;
  value_state: string | null;
  data_type: string | null;
  unit_code: string | null;
  unit_ref: string | null;
} | null {
  const inner = asRecord(row.row);
  const values = asRecord(inner.values);
  const cell = values[field];
  if (isWfdRecord(cell) && Object.hasOwn(cell, 'value')) {
    return {
      value: cell.value,
      value_state: text(cell.value_state),
      data_type: text(cell.data_type),
      unit_code: text(cell.unit_code),
      unit_ref: text(cell.unit_ref),
    };
  }
  if (Object.hasOwn(inner, field) && field !== 'values') {
    return {
      value: inner[field],
      value_state: text(inner.value_state),
      data_type: null,
      unit_code: null,
      unit_ref: null,
    };
  }
  return null;
}

function fieldDefinitions(product: WfdRecord): { source: string; fields: ProductMachineFieldDefinition[] } {
  const declaration = asRecord(product.declaration);
  const declarationFields = asArray(declaration.field_definitions).map(asRecord).filter(field => text(field.field_code));
  if (declarationFields.length) return { source: 'declaration.field_definitions', fields: declarationFields.map(fieldDefinition) };
  const semantic = asRecord(asRecord(product.contracts).semantic);
  const semanticFields = asArray(semantic.fields).map(asRecord).filter(field => text(field.field_code));
  if (semanticFields.length) return { source: 'contracts.semantic.fields', fields: semanticFields.map(fieldDefinition) };
  return { source: 'none', fields: [] };
}

function fieldDefinition(field: WfdRecord): ProductMachineFieldDefinition {
  return {
    field_code: String(field.field_code),
    data_type: text(field.data_type),
    unit_code: text(field.unit_code),
    time_role: text(field.time_role),
    measurement_nature: text(field.measurement_nature),
  };
}

function inspectTimeAxis(rows: WfdRecord[]) {
  const precisions = new Set<string>();
  const timezones = new Set<string>();
  const statuses = new Set<string>();
  for (const row of rows) {
    const observation = asRecord(asRecord(row.row).observation_time);
    const precision = text(observation.precision);
    const timezone = text(observation.source_timezone);
    const status = text(observation.status);
    precisions.add(precision ?? '');
    timezones.add(timezone ?? '');
    statuses.add(status ?? 'unknown');
  }
  return { precisions: [...precisions].sort(), timezones: [...timezones].sort(), statuses: [...statuses].sort() };
}

function deriveFrequency(timeRoles: string[], precisions: string[]): { value: string | null; basis: string[] } {
  if (precisions.length !== 1) return { value: null, basis: ['multiple_or_missing_precision'] };
  const precision = precisions[0];
  const byPrecision: Record<string, string> = { year: '1y', quarter: '1q', month: '1m', day: '1d', hour: '1h' };
  const value = byPrecision[precision] ?? null;
  return { value, basis: [...timeRoles.map(role => `time_role:${role}`), `observation_time.precision:${precision}`] };
}

function deriveTimezone(timezones: string[]): { value: string | null; basis: string[] } {
  if (timezones.length !== 1) return { value: null, basis: ['multiple_or_missing_source_timezone'] };
  const value = timezones[0];
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return { value, basis: ['observation_time.source_timezone'] };
  } catch {
    return { value: null, basis: ['invalid_source_timezone'] };
  }
}

function deriveCurrency(fields: ProductMachineFieldDefinition[]): { value: string | null; basis: string[] } {
  const currencies = new Set<string>();
  for (const field of fields) {
    const currency = currencyForUnit(field.unit_code);
    if (currency) currencies.add(currency);
  }
  if (currencies.size !== 1) return { value: null, basis: [`unit_currencies:${[...currencies].sort().join(',') || 'none'}`] };
  return { value: [...currencies][0], basis: fields.filter(field => field.unit_code).map(field => `unit:${field.field_code}=${field.unit_code}`) };
}

function derivePriceUnit(fields: ProductMachineFieldDefinition[], closeField: string | undefined): { value: string | null; basis: string[] } {
  const field = fields.find(item => item.field_code === closeField);
  if (field?.unit_code === 'cny_per_share') return { value: 'currency_per_share', basis: [`unit:${field.field_code}=cny_per_share`] };
  return { value: null, basis: [`close_field_unit:${field?.unit_code ?? 'none'}`] };
}

function currencyForUnit(unit: string | null): string | null {
  if (!unit) return null;
  if (unit.startsWith('cny')) return 'CNY';
  if (unit.startsWith('usd')) return 'USD';
  return null;
}

function effectiveValue(structured: { value: unknown; source: string } | null | undefined, derived: string | null, basis: string[]) {
  if (structured) {
    return { value: typeof structured.value === 'string' ? structured.value : null, source: structured.source };
  }
  if (derived) return { value: derived, source: basis.join(';') };
  return null;
}

function effectiveRaw(structured: { value: unknown; source: string } | null | undefined) {
  return structured ? { value: structured.value, source: structured.source } : null;
}

function compareExpectation(mismatches: string[], label: string, caller: unknown, actual: unknown): void {
  if (actual === null || actual === undefined || typeof actual !== 'string') return;
  if (typeof caller === 'string' && caller !== actual) mismatches.push(`${label}: caller=${caller} actual=${actual}`);
}

function uniqueText(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
}

function assertReference(reference: AlgorithmSnapshotReference): void {
  if (!reference || reference.kind !== 'wfd_fixed_snapshot'
    || typeof reference.instanceId !== 'string' || !reference.instanceId
    || typeof reference.productId !== 'string' || !reference.productId
    || typeof reference.snapshotId !== 'string' || !reference.snapshotId
    || typeof reference.definitionRevision !== 'string' || !reference.definitionRevision
    || !Array.isArray(reference.fields) || reference.fields.length === 0
    || new Set(reference.fields).size !== reference.fields.length
    || reference.fields.some(field => typeof field !== 'string' || !field)) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照引用需要实例、产品、具体 snapshot、定义修订和明确字段。');
  }
}

function canonicalRecord(value: unknown): WfdRecord {
  return JSON.parse(canonicalWfdJson(value)) as WfdRecord;
}

function asRecord(value: unknown): WfdRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WfdRecord : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function isWfdRecord(value: unknown): value is WfdRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

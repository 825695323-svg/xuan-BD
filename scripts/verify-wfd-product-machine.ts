import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WFD_PRODUCT_MACHINE_PROTOCOL, WfdProductMachineClient, WfdProductMachineError,
  type WfdProductMachineTransport } from '../adapters/database/wfd-product-machine.js';
import { createWfdProductMachineSnapshotPort, extractSelectedCells, inspectProductMachineSemantics,
  type ProductMachineFieldDefinition } from '../modules/financial/product-machine-snapshot.js';
import { canonicalWfdJson } from '../adapters/database/wfd-transport.js';
import type { AlgorithmSnapshotReference } from '../modules/financial/algorithm-types.js';

/**
 * 定向 P6 进程边界验证：只走新 `wfd.product-machine/0.1` 薄入口。
 *
 * 不使用旧 `wfd.data-service/v1` generic-transport，不连接旧 `/v3/data-entry`，
 * 不读取 WFD 私有 catalog。真实 store 只由 WFD 薄入口按固定 snapshot_id 读取。
 *
 * 本版把两类能力分开记录：
 * - 通用 fixed_read：按固定产品读取真实行，逐行核对 definition/contract/声明字段。
 * - 金融算法端口：只有固定合同提供结构化 frequency/adjustment/bar_closed/
 *   availability/currency/时间轴时才可用；当前 P1 合同不具备，必须明确拒绝。
 *   caller 的 dailysemantics 只作预期，不能补成数据库事实。
 */
type Json = Record<string, unknown>;

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const required = (name: string): string => {
  const value = arg(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
};
const asRecord = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const asNumber = (value: unknown): number | null => typeof value === 'number' ? value : null;
const sha = (value: unknown): string => createHash('sha256').update(canonicalWfdJson(value)).digest('hex');
const write = (path: string, value: unknown): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

async function expectFailure(label: string, call: () => Promise<unknown>): Promise<Json> {
  try {
    await call();
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    let details: Json | null = null;
    const start = message.indexOf('{');
    if (start >= 0) {
      try { details = JSON.parse(message.slice(start)) as Json; } catch { details = null; }
    }
    return { label, code, message, details, returned_verified_scope: null };
  }
  throw new Error(label + ' unexpectedly succeeded; rejecting the run');
}

function rowHasValue(row: Json, field: string): boolean {
  const inner = asRecord(row.row);
  const values = asRecord(inner.values);
  const cell = values[field];
  return (cell !== null && typeof cell === 'object' && !Array.isArray(cell) && Object.hasOwn(cell as Json, 'value'))
    || Object.hasOwn(inner, field);
}

function assertSourceProjection(label: string, result: Json): void {
  const projection = asRecord(result.public_projection);
  if (!asString(projection.format_version)) throw new Error(label + ': public_projection.format_version missing');
  if (typeof projection.contract_bodies !== 'string' || typeof projection.complete_contract_bodies !== 'boolean') {
    throw new Error(label + ': contract partial/complete markers missing');
  }
  const contractProjections = asArray(projection.contract_projections).map(asRecord);
  if (!contractProjections.length) throw new Error(label + ': contract_projections missing');
  for (const item of contractProjections) {
    if (!asString(item.projection_digest)) throw new Error(label + ': projection_digest missing');
    if (!asString(asRecord(item.original_contract_ref).digest)) throw new Error(label + ': original_contract_ref missing');
  }
  if (!asArray(result.source_ids).length) throw new Error(label + ': source_ids missing');
  const products = asArray(result.products).map(asRecord);
  if (!products.length || !asRecord(products[0].contracts).semantic) throw new Error(label + ': public contracts missing');
  const rows = asArray(result.rows).map(asRecord);
  if (!rows.length) throw new Error(label + ': rows missing');
  if (!Array.isArray(rows[0].evidence_refs)) throw new Error(label + ': evidence_refs dropped');
  if (!asArray(asRecord(rows[0].source_binding).source_ids).length) throw new Error(label + ': source_binding.source_ids dropped');
}

async function main(): Promise<void> {
  const evidenceDir = resolve(required('evidence'));
  mkdirSync(evidenceDir, { recursive: true });
  const configPath = resolve(required('config'));
  const entryPath = resolve(required('entry'));
  const projectRoot = resolve(required('project'));
  const fileSha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  const serviceSourcePath = resolve(projectRoot, 'wfd_sdk/product_service.py');
  const governanceSourcePath = resolve(projectRoot, 'wfd_sdk/product_governance.py');
  const sourceHashesBefore = { service: fileSha(serviceSourcePath), governance: fileSha(governanceSourcePath) };
  const trusted = JSON.parse(readFileSync(configPath, 'utf8')) as Json;
  const caller = asRecord(trusted.caller);
  const snapshotId = required('snapshot');
  const instanceId = required('instance');
  const expected = required('expect');
  const traceProduct = required('trace-product');
  const portProduct = required('port-product');
  const identityPath = required('identity');
  const requestIdentity = JSON.parse(readFileSync(resolve(identityPath), 'utf8')) as Json;

  const client = new WfdProductMachineClient({
    pythonPath: resolve(required('python')),
    entryPath,
    configPath,
    projectRoot,
    timeoutMs: 180_000,
  });

  const calls: Json[] = [];
  const record = (label: string, reply: { transport: WfdProductMachineTransport }) => {
    calls.push({
      label,
      operation: reply.transport.operation,
      requestId: reply.transport.requestId,
      elapsedMs: reply.transport.elapsedMs,
      responseBytes: reply.transport.responseBytes,
      serviceVersion: reply.transport.serviceVersion,
      contractVersion: reply.transport.contractVersion,
      schemaId: reply.transport.schemaId,
      connectionId: reply.transport.connectionId,
      callerId: reply.transport.callerId,
      trustedActorNamespace: reply.transport.trustedActorNamespace,
    });
  };

  const capabilities = await client.capabilities();
  record('capabilities', capabilities);
  const caps = capabilities.result;
  if (caps.machine_protocol !== WFD_PRODUCT_MACHINE_PROTOCOL) throw new Error('machine protocol mismatch');
  const service = asRecord(capabilities.response.service);
  if (!asString(service.service_version) || !asString(service.contract_version) || !asString(service.schema_id)) {
    throw new Error('capability service identity missing');
  }
  const operations = asRecord(caps.operations);
  for (const operation of ['capabilities', 'contract_discovery', 'fixed_read', 'request_status', 'trace']) {
    if (asRecord(operations[operation]).supported !== true) throw new Error('missing supported operation ' + operation);
  }
  write(resolve(evidenceDir, 'capabilities.json'), capabilities.response);

  const discovery = await client.discover(snapshotId);
  record('contract_discovery', discovery);
  const summaries = asArray(discovery.result.product_summaries).map(asRecord);
  const fullProducts = asArray(discovery.result.products).map(asRecord);
  const productCount = asNumber(discovery.result.product_count);
  if (productCount !== summaries.length || productCount !== fullProducts.length) throw new Error('product count mismatch');
  write(resolve(evidenceDir, 'discovery.json'), {
    snapshot_id: discovery.result.snapshot_id,
    product_count: productCount,
    source_count: discovery.result.source_count,
    products: summaries.map(product => ({
      product_id: product.product_id, dataset_id: product.dataset_id, subject: product.subject,
      payload_kind: product.payload_kind, contract_ref: product.contract_ref, definition_ref: product.definition_ref,
    })),
  });

  const allRead = await client.read({ snapshotId, rowProjection: 'full' });
  record('fixed_read_all', allRead);
  const allRows = asArray(allRead.result.rows).map(asRecord);
  const allRowCount = asNumber(allRead.result.row_count);
  if (allRowCount !== allRows.length) throw new Error('fixed read row count mismatch');
  const counts = new Map<string, number>();
  for (const row of allRows) {
    const productId = asString(row.product_id) ?? '(missing)';
    counts.set(productId, (counts.get(productId) ?? 0) + 1);
  }
  const identitySets = new Map<string, Set<string>>();
  for (const row of allRows) {
    const productId = asString(row.product_id) ?? '(missing)';
    const definition = asRecord(row.definition_ref);
    const contract = asRecord(row.contract_ref);
    const identity = [asString(definition.version) ?? '(missing)', asString(definition.digest) ?? '(missing)',
      asString(contract.digest) ?? '(missing)'].join('|');
    if (!identitySets.has(productId)) identitySets.set(productId, new Set());
    identitySets.get(productId)!.add(identity);
  }
  const mixedIdentityProducts = [...identitySets.entries()].filter(([, set]) => set.size !== 1)
    .map(([productId, set]) => ({ product_id: productId, identities: [...set] }));
  if (mixedIdentityProducts.length) throw new Error('fixed read mixed definition/contract identities within a product');
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (expected === '0.2') {
    if (allRowCount !== 176 || productCount !== 12) throw new Error(`expected 12 products / 176 rows, got ${productCount}/${allRowCount}`);
    const top = ranked.slice(0, 3).map(([, count]) => count);
    if (top.join(',') !== '91,60,16') throw new Error('three business product row counts changed: ' + top.join(','));
  } else if (expected === 'p1b') {
    if (allRowCount !== 3 || productCount !== 1) throw new Error(`expected 1 product / 3 rows, got ${productCount}/${allRowCount}`);
  } else {
    throw new Error('unknown --expect (0.2|p1b)');
  }
  assertSourceProjection('all', allRead.result);
  write(resolve(evidenceDir, 'fixed-read-all.json'), {
    snapshot_id: allRead.result.snapshot_id,
    row_count: allRowCount,
    product_count: productCount,
    public_projection: allRead.result.public_projection,
    source_ids: allRead.result.source_ids,
    products: allRead.result.products,
    row_keys: Object.keys(allRows[0] ?? {}).sort(),
    first_row: allRows[0] ?? null,
    last_row: allRows[allRows.length - 1] ?? null,
    rows_sha256: sha(allRows),
    note: 'full public read; raw rows summarized to keep evidence bounded, source projection/products kept',
  });
  write(resolve(evidenceDir, 'fixed-read-all-summary.json'), {
    snapshot_id: allRead.result.snapshot_id,
    row_count: allRowCount,
    product_count: productCount,
    row_projection: allRead.result.row_projection,
    rows_sha256: sha(allRows),
    per_product: ranked.map(([productId, count]) => ({ product_id: productId, rows: count,
      definition_contract_identities: [...(identitySets.get(productId) ?? [])] })),
    mixed_identity_products: mixedIdentityProducts,
    response_sha256: sha(allRead.response),
  });

  const status = await client.requestStatus(requestIdentity);
  record('request_status', status);
  write(resolve(evidenceDir, 'request-status.json'), status.response);
  if (expected === 'p1b' && status.result.state !== 'published_formal') {
    throw new Error('P1b request status did not read back published_formal: ' + String(status.result.state));
  }

  const trace = await client.trace(traceProduct, snapshotId);
  record('trace', trace);
  const traceEvidence = asArray(trace.result.evidence).map(asRecord);
  const traceVerified = traceEvidence.length > 0 && traceEvidence.every(item => item.verified === true);
  write(resolve(evidenceDir, 'trace.json'), {
    product_id: traceProduct,
    snapshot_id: snapshotId,
    evidence_count: traceEvidence.length,
    all_evidence_verified: traceVerified,
    evidence: traceEvidence.map(item => ({ relative_path: item.relative_path, verified: item.verified,
      content_sha256: asRecord(item.reference).content_sha256 })),
    response_sha256: sha(trace.response),
  });
  if (!traceVerified) throw new Error('trace evidence was not verified');

  const portProductRecord = fullProducts.find(product => product.product_id === portProduct);
  if (!portProductRecord) throw new Error('port product not found in fixed discovery');
  const declaration = asRecord(portProductRecord.declaration);
  const declaredDefinitions: ProductMachineFieldDefinition[] = asArray(declaration.field_definitions).map(asRecord)
    .filter(field => asString(field.field_code))
    .map(field => ({
      field_code: String(field.field_code),
      data_type: asString(field.data_type),
      unit_code: asString(field.unit_code),
      time_role: asString(field.time_role),
      measurement_nature: asString(field.measurement_nature),
    }));
  const declaredFields = declaredDefinitions.map(field => field.field_code);
  const actualDefinition = asString(asRecord(portProductRecord.definition_ref).version);
  const actualDefinitionDigest = asString(asRecord(portProductRecord.definition_ref).digest);
  const actualContractDigest = asString(asRecord(portProductRecord.contract_ref).digest);
  if (!actualDefinition || !actualDefinitionDigest || !actualContractDigest) {
    throw new Error('fixed product identity is incomplete');
  }
  const fields = expected === '0.2' ? declaredFields : ['value_decimal'];
  if (fields.length === 0) throw new Error('no fields selected for focused product');

  const focused = await client.read({ snapshotId, productId: portProduct, rowProjection: 'full' });
  record('fixed_read_focused', focused);
  const focusedRows = asArray(focused.result.rows).map(asRecord);
  const focusedRowCount = asNumber(focused.result.row_count);
  if (focusedRowCount !== focusedRows.length) throw new Error('focused fixed read row count mismatch');
  const expectedFocusedRows = expected === '0.2' ? 60 : 3;
  if (focusedRowCount !== expectedFocusedRows) throw new Error(`focused read expected ${expectedFocusedRows} rows, got ${focusedRowCount}`);
  for (const [index, row] of focusedRows.entries()) {
    if (asString(asRecord(row.definition_ref).version) !== actualDefinition) {
      throw new Error(`row ${index} definition version differs from fixed discovery`);
    }
    if (asString(asRecord(row.contract_ref).digest) !== actualContractDigest) {
      throw new Error(`row ${index} contract digest differs from fixed discovery`);
    }
    for (const field of fields) {
      if (!rowHasValue(row, field)) throw new Error(`row ${index} missing declared field ${field}`);
    }
  }
  assertSourceProjection('focused', focused.result);
  const focusedCells = extractSelectedCells(focusedRows, fields, declaredDefinitions,
    asString(declaration.unit_code));
  const rawValueStatePreserved = focusedRows.every(row => fields.every(field => {
    const inner = asRecord(row.row);
    const cell = asRecord(inner.values)[field];
    return (cell !== null && typeof cell === 'object' && !Array.isArray(cell) && typeof (cell as Json).value_state === 'string')
      || typeof inner.value_state === 'string';
  }));
  if (!rawValueStatePreserved) throw new Error('generic fixed_read lost value_state');
  const genericFixedRead = {
    product_id: portProduct,
    snapshot_id: snapshotId,
    row_count: focusedRowCount,
    definition: { version: actualDefinition, digest: actualDefinitionDigest },
    contract: { digest: actualContractDigest },
    declared_fields: declaredFields,
    requested_fields: fields,
    fields_checked_per_row: true,
    definition_checked_per_row: true,
    first_row_keys: Object.keys(asRecord(focusedRows[0])).sort(),
    full_rows_sha256: sha(focusedRows),
    rows_sha256_basis: 'local_full_public_rows; not a server full-resource digest',
    raw_value_state_preserved: rawValueStatePreserved,
    cell_metadata: {
      basis: 'per_cell_value_state_type_unit_metadata',
      count: focusedCells.cells.length,
      unsafe_count: focusedCells.unsafe.length,
      first_cells: focusedCells.cells.slice(0, 12),
    },
  };
  write(resolve(evidenceDir, 'generic-fixed-read.json'), {
    ...genericFixedRead,
    public_projection: focused.result.public_projection,
    source_ids: focused.result.source_ids,
    products: focused.result.products,
    first_row: focusedRows[0] ?? null,
    last_row: focusedRows[focusedRows.length - 1] ?? null,
  });

  const reference: AlgorithmSnapshotReference = {
    kind: 'wfd_fixed_snapshot',
    instanceId,
    productId: portProduct,
    snapshotId,
    definitionRevision: actualDefinition,
    fields,
    fieldMapping: { timestamp: expected === '0.2' ? 'open' : 'business_key', close: expected === '0.2' ? 'close' : 'value_decimal' },
    semantics: {
      subject: portProduct, frequency: '1d', timezone: 'Asia/Shanghai', priceUnit: 'currency_per_share',
      currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis: 'not_applicable', barClosed: true,
      synthetic: false, availability: { kind: 'bar_close', closeTime: '15:00' },
    },
    calendar: { mode: 'not_verified', note: 'P6 process-boundary verification only; no calendar claim.' },
  };
  const inspection = inspectProductMachineSemantics(portProductRecord, focusedRows, reference);
  if (inspection.status !== 'unsupported') throw new Error('algorithm semantics unexpectedly supported');
  if (inspection.caller_expectations_used_as_truth !== false) throw new Error('caller expectations were treated as truth');
  if (expected === 'p1b') {
    if (inspection.derived.frequency.value !== '1y') throw new Error('P1b annual throughput was not read as 1y');
    if (inspection.derived.timezone.value !== 'America/Los_Angeles') throw new Error('P1b timezone was not read from time axis');
    if (!inspection.mismatches.some(item => item.includes('frequency: caller=1d actual=1y'))) {
      throw new Error('P1b fake daily expectation was not recorded as a mismatch');
    }
    if (!inspection.missing.includes('adjustment') || !inspection.missing.includes('bar_closed')) {
      throw new Error('P1b missing structured semantics were not recorded');
    }
  } else {
    if (inspection.derived.frequency.value !== '1d') throw new Error('0.2 daily time axis was not derived as 1d');
    if (inspection.derived.timezone.value !== 'Asia/Shanghai') throw new Error('0.2 timezone was not read from time axis');
    if (inspection.derived.currency.value !== 'CNY') throw new Error('0.2 currency was not read from unit evidence');
    for (const requiredMissing of ['value_field.timestamp_date', 'adjustment', 'adjustment_basis', 'bar_closed', 'availability']) {
      if (!inspection.missing.includes(requiredMissing)) throw new Error('0.2 missing semantics did not include ' + requiredMissing);
    }
    if (inspection.missing.includes('frequency.daily') || inspection.missing.includes('timezone') || inspection.missing.includes('currency')) {
      throw new Error('0.2 actual time/unit evidence was ignored');
    }
  }

  const port = createWfdProductMachineSnapshotPort({ client, instanceId });
  const statusView = port.status();
  if (statusView.status !== 'available') throw new Error('snapshot port is not available');

  // 最小反例：两个裸 null 的 value_state 不同，不能被抹成同一个 null。
  const nullStateRows: Json[] = [
    { row: { values: { close: { data_type: 'decimal', value: null, value_state: 'unknown', unit_code: 'cny_per_share' } } } },
    { row: { values: { close: { data_type: 'decimal', value: null, value_state: 'not_applicable', unit_code: 'cny_per_share' } } } },
  ];
  const nullStateCells = extractSelectedCells(nullStateRows, ['close']);
  if (nullStateCells.cells.length !== 2) throw new Error('null-state probe did not keep two cells');
  if (nullStateCells.cells[0].value_state === nullStateCells.cells[1].value_state) {
    throw new Error('null-state probe collapsed different value_state values');
  }
  if (nullStateCells.cells.some(cell => cell.safe_value_state)) {
    throw new Error('null cell was marked safe for algorithm input');
  }
  const nullStateProbe = {
    cells: nullStateCells.cells,
    unsafe_count: nullStateCells.unsafe.length,
    states_distinct: nullStateCells.cells[0].value_state !== nullStateCells.cells[1].value_state,
    any_safe_value_state: nullStateCells.cells.some(cell => cell.safe_value_state),
  };
  write(resolve(evidenceDir, 'null-state-probe.json'), nullStateProbe);

  const rangeNegative = await expectFailure('non-empty range',
    () => port.read({ ...reference, range: { start: '2020-01-01', end: '2030-01-01' } },
      { signal: new AbortController().signal }));
  if (rangeNegative.code !== 'ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED') {
    throw new Error('non-empty range did not fail with ALGORITHM_SNAPSHOT_RANGE_UNSUPPORTED: ' + rangeNegative.code);
  }

  const compactNegative = await expectFailure('compact row projection removed',
    () => client.read({ snapshotId, productId: portProduct, rowProjection: 'compact' }));
  if (compactNegative.code !== 'REQUEST_INVALID') {
    throw new Error('compact projection did not fail with REQUEST_INVALID: ' + compactNegative.code);
  }

  const wrongDefinition = await expectFailure('annual-throughput wrong definitionRevision',
    () => port.read({ ...reference, definitionRevision: 'v_intentionally_wrong_revision' },
      { signal: new AbortController().signal }));
  if (wrongDefinition.code !== 'ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH') {
    throw new Error('wrong definitionRevision did not fail with ALGORITHM_SNAPSHOT_DEFINITION_MISMATCH: ' + wrongDefinition.code);
  }
  const wrongDetails = asRecord(wrongDefinition.details);
  if (asString(wrongDetails.actual_definition_version) !== actualDefinition) {
    throw new Error('definition mismatch did not report the actual fixed definition');
  }

  const correctDefinitionFakeDaily = await expectFailure('correct definition + caller fake daily semantics',
    () => port.read(reference, { signal: new AbortController().signal }));
  const expectedSemanticCode = expected === '0.2'
    ? 'ALGORITHM_SNAPSHOT_SEMANTICS_UNSUPPORTED'
    : 'ALGORITHM_SNAPSHOT_FIELDS_UNSUPPORTED';
  if (correctDefinitionFakeDaily.code !== expectedSemanticCode) {
    throw new Error(`correct definition unexpected gate code: ${correctDefinitionFakeDaily.code}, expected ${expectedSemanticCode}`);
  }
  if (correctDefinitionFakeDaily.returned_verified_scope !== null) throw new Error('failed algorithm gate returned a verified scope');

  let declaredFieldNegative: Json | null = null;
  if (expected === '0.2') {
    declaredFieldNegative = await expectFailure('undeclared field selection',
      () => port.read({ ...reference, fields: ['open', 'not_a_declared_field'] }, { signal: new AbortController().signal }));
    if (declaredFieldNegative.code !== 'ALGORITHM_SNAPSHOT_FIELDS_MISMATCH') {
      throw new Error('undeclared field did not fail with ALGORITHM_SNAPSHOT_FIELDS_MISMATCH');
    }
  }

  const algorithmGate = {
    status: 'rejected',
    product_id: portProduct,
    snapshot_id: snapshotId,
    generic_fixed_read: genericFixedRead,
    algorithm_port: {
      status: 'rejected',
      port_status: statusView,
      definition: inspection.definition,
      contract: inspection.contract,
      caller_expectations: inspection.caller_expectations,
      caller_expectations_used_as_truth: false,
      observed: inspection.observed,
      structured: inspection.structured,
      derived: inspection.derived,
      missing: inspection.missing,
      mismatches: inspection.mismatches,
      wrong_definition_revision: wrongDefinition,
      correct_definition_fake_daily: correctDefinitionFakeDaily,
      undeclared_field_negative: declaredFieldNegative,
      range_negative: rangeNegative,
      compact_negative: compactNegative,
      null_state_probe: nullStateProbe,
      verified_scope_returned: null,
      note: '金融算法入口未通过；通用 fixed_read 已通过。拒绝原因是固定合同缺结构化金融算法语义，不是 mock 失败。',
    },
  };
  write(resolve(evidenceDir, 'algorithm-gate.json'), algorithmGate);

  let unsupported: Json | null = null;
  let permissionBoundary: Json | null = null;
  try {
    await client.request('submit', {});
    throw new Error('unsupported submit unexpectedly succeeded');
  } catch (error) {
    if (!(error instanceof WfdProductMachineError) || error.code !== 'OPERATION_UNSUPPORTED') throw error;
    if (!error.action || !error.requestId) throw new Error('unsupported error lacks actionable cause or request identity');
    if ('job_id' in error) throw new Error('unsupported error must not invent a job id');
    unsupported = {
      code: error.code, message: error.message, action: error.action, requestId: error.requestId,
      operation: error.operation, identity: error.identity, service: error.service,
      hasJobId: 'job_id' in error,
    };
  }
  try {
    await client.request('fixed_read', { snapshot_id: snapshotId, caller_roles: ['read', 'read_everything'] });
    throw new Error('request-supplied permission unexpectedly accepted');
  } catch (error) {
    if (!(error instanceof WfdProductMachineError) || error.code !== 'REQUEST_INVALID') throw error;
    permissionBoundary = {
      code: error.code, message: error.message, action: error.action, requestId: error.requestId,
      operation: error.operation, identity: error.identity,
    };
  }
  write(resolve(evidenceDir, 'negative-boundary.json'), { unsupported, permissionBoundary });

  const sourceHashesAfter = { service: fileSha(serviceSourcePath), governance: fileSha(governanceSourcePath) };
  if (sourceHashesBefore.service !== sourceHashesAfter.service
    || sourceHashesBefore.governance !== sourceHashesAfter.governance) {
    throw new Error('WFD product service/governance changed during the run; rerun against one stable source hash');
  }
  const summary = {
    status: 'complete',
    run_at: new Date().toISOString(),
    machine_protocol: caps.machine_protocol,
    transport: 'stdin/stdout single bounded JSON object',
    code_identity: {
      entry_sha256: fileSha(entryPath),
      config_sha256: fileSha(configPath),
      service_source_sha256: sourceHashesBefore.service,
      governance_source_sha256: sourceHashesBefore.governance,
      adapter_source_sha256: fileSha(fileURLToPath(new URL('../adapters/database/wfd-product-machine.ts', import.meta.url))),
      snapshot_source_sha256: fileSha(fileURLToPath(new URL('../modules/financial/product-machine-snapshot.ts', import.meta.url))),
      test_source_sha256: fileSha(fileURLToPath(import.meta.url)),
    },
    old_generic_transport_used: false,
    service_identity: service,
    connection: {
      connection_id: trusted.connection_id ?? null,
      caller_id: caller.caller_id ?? null,
      trusted_actor_namespace: caller.trusted_actor_namespace ?? null,
      store: trusted.store ?? null,
      runtime: trusted.runtime ?? null,
    },
    snapshot_id: snapshotId,
    product_count: productCount,
    row_count: allRowCount,
    business_products: ranked.slice(0, 3).map(([productId, count]) => ({ product_id: productId, rows: count })),
    fixed_read_rows_sha256: sha(allRows),
    trace: { product_id: traceProduct, evidence_count: traceEvidence.length, all_evidence_verified: traceVerified },
    request_status: {
      state: status.result.state, service_status: status.result.service_status,
      snapshot_id: status.result.snapshot_id,
    },
    generic_fixed_read: {
      product_id: portProduct,
      row_count: focusedRowCount,
      definition: genericFixedRead.definition,
      contract: genericFixedRead.contract,
      declared_fields: declaredFields,
      requested_fields: fields,
      fields_checked_per_row: true,
      definition_checked_per_row: true,
      full_rows_sha256: genericFixedRead.full_rows_sha256,
      raw_value_state_preserved: genericFixedRead.raw_value_state_preserved,
      cell_metadata_count: genericFixedRead.cell_metadata.count,
      cell_metadata_unsafe_count: genericFixedRead.cell_metadata.unsafe_count,
    },
    algorithm_port: {
      status: 'rejected',
      correct_definition_code: correctDefinitionFakeDaily.code,
      wrong_definition_code: wrongDefinition.code,
      undeclared_field_code: declaredFieldNegative?.code ?? null,
      range_code: rangeNegative.code,
      compact_code: compactNegative.code,
      null_state_states_distinct: nullStateProbe.states_distinct,
      null_state_any_safe_value_state: nullStateProbe.any_safe_value_state,
      caller_expectations_used_as_truth: false,
      observed: inspection.observed,
      derived: inspection.derived,
      missing: inspection.missing,
      mismatches: inspection.mismatches,
      rows_sha256: null,
      rows_sha256_basis: 'not_exposed_by_wfd_product_service',
    },
    source_projection: (() => {
      const publicProjection = asRecord(focused.result.public_projection);
      const publicProduct = asRecord(asArray(focused.result.products)[0]);
      const semantic = asRecord(asRecord(publicProduct.contracts).semantic);
      const unitDefinitions = asRecord(semantic.unit_definitions);
      const fieldUnitCodes = asArray(asRecord(publicProduct.declaration).field_definitions)
        .map(asRecord).map(field => asString(field.unit_code)).filter((unit): unit is string => Boolean(unit));
      return {
        format_version: asString(publicProjection.format_version),
        contract_bodies: asString(publicProjection.contract_bodies),
        complete_contract_bodies: publicProjection.complete_contract_bodies,
        projection_digest: asString(asRecord(asArray(publicProjection.contract_projections)[0]).projection_digest),
        source_count: asArray(focused.result.source_ids).length,
        contracts_present: Boolean(asRecord(publicProduct.contracts).semantic),
        units_present: Object.keys(unitDefinitions).length > 0 || fieldUnitCodes.length > 0,
        row_evidence_refs_present: Array.isArray(asRecord(focusedRows[0]).evidence_refs),
        row_source_binding_present: asArray(asRecord(asRecord(focusedRows[0]).source_binding).source_ids).length > 0,
      };
    })(),
    negative_boundary: { unsupported_code: unsupported?.code ?? null, permission_code: permissionBoundary?.code ?? null },
    calls,
    evidence_files: ['capabilities.json', 'discovery.json', 'fixed-read-all.json', 'fixed-read-all-summary.json',
      'request-status.json', 'trace.json', 'generic-fixed-read.json', 'algorithm-gate.json',
      'null-state-probe.json', 'negative-boundary.json', 'summary.json'],
    not_claimed: [
      '整个 P6 未通过；本批只验证公开本地进程边界、通用 fixed_read 与算法入口拒绝。',
      '金融算法端口当前未通过：固定合同缺结构化 frequency/adjustment/bar_closed/availability/currency/时间轴语义。',
      'submit/packages/export/company_view/calendar_read 明确未支持。',
      'Windows x64 与拔盘轮未由本批覆盖。',
      '未把 caller 声明的 definitionRevision 或 dailysemantics 当数据库事实。',
      'compact row projection 已移除：公开投影、合同/单位、evidence_refs/source_binding 不再被静默删减。',
      '非空 range 未实现实际过滤，已明确拒绝，未返回全域。',
      '未把旧 wfd.data-service/v1 generic-transport 或 /v3/data-entry 当新库。',
    ],
  };
  write(resolve(evidenceDir, 'summary.json'), summary);
  console.log(JSON.stringify({
    status: summary.status,
    service_version: asString(service.service_version),
    snapshot_id: snapshotId,
    product_count: productCount,
    row_count: allRowCount,
    business_products: summary.business_products,
    trace_verified: traceVerified,
    request_state: summary.request_status.state,
    generic_fixed_read_rows: focusedRowCount,
    algorithm_port_status: summary.algorithm_port.status,
    correct_definition_code: summary.algorithm_port.correct_definition_code,
    wrong_definition_code: summary.algorithm_port.wrong_definition_code,
    undeclared_field_code: summary.algorithm_port.undeclared_field_code,
    observed_frequency: inspection.derived.frequency.value,
    observed_timezone: inspection.derived.timezone.value,
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

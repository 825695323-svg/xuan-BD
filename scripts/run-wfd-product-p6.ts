import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { WfdProductMachineClient, type WfdProductMachineReply } from '../adapters/database/wfd-product-machine.js';

/**
 * 真实 BD 生产者/消费者闭环（定向，不是整套 P6 验收）。
 *
 * 只通过 canonical WFD `wfd.product-machine/0.1` 公开进程发送：
 * evidence_ingest → submit → request_status → contract_discovery → fixed_read →
 * read_product 分页。store/runtime/调用者/来源/单位仅来自 --config 受控配置；
 * 不传 root/principal/roles，不读 WFD 私有 catalog。
 */
type Json = Record<string, unknown>;
const required = (name: string): string => {
  const index = process.argv.indexOf('--' + name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('missing --' + name);
  return process.argv[index + 1];
};
const asRecord = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const write = (path: string, value: unknown) => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

function dayTime(day: string): Json {
  const start = new Date(day + 'T00:00:00+08:00');
  const end = new Date(start.getTime() + 86_400_000);
  return {
    status: 'known', precision: 'day',
    earliest_utc: start.toISOString().replace('.000Z', 'Z'),
    latest_exclusive_utc: end.toISOString().replace('.000Z', 'Z'),
    source_timezone: 'Asia/Shanghai',
  };
}

function submitDocument(fixture: Json, evidenceRef: Json, serviceVersion: string, datasetId: string,
  namespace: string, requestId: string): Json {
  const market = asRecord(fixture.market);
  const source = asArray(fixture.sources).map(asRecord).find(item => item.source_id === 'eastmoney_bars_2026q2');
  if (!source) throw new Error('fixture source eastmoney_bars_2026q2 missing');
  const rows = asArray(market.rows).map(value => {
    const row = asRecord(value);
    const day = asString(row.trade_date);
    if (!day) throw new Error('market row missing trade_date');
    const values: Json = {};
    for (const field of ['open', 'high', 'low', 'close', 'volume_lot', 'amount_cny']) {
      values[field] = { data_type: 'decimal', value_state: 'valid_value', value: String(row[field]) };
    }
    return {
      business_key: `000001:${day}`,
      subject: { kind: 'listing', namespace: 'cn.szse.listing', id: '000001:19910403' },
      observation_time: dayTime(day),
      values,
    };
  });
  const outputKey = 'cn.equity.daily_bar.unadjusted';
  return {
    protocol_version: 'wfd.ingest/1.3-candidate',
    intent: 'submit',
    producer_namespace: namespace,
    request_identity: {
      dataset_id: datasetId,
      trusted_actor_namespace: namespace,
      request_id: requestId,
      submission_digest: 'sha256:' + '0'.repeat(64),
    },
    expected_parent_snapshot_id: null,
    outputs: [{
      output_key: outputKey,
      logical_domain: 'observations',
      subject: { kind: 'listing', namespace: 'cn.szse.listing', id: '000001:19910403' },
      definition_mode: 'create',
      definition_ref: null,
      new_definition_declaration: {
        semantic_code: outputKey,
        measurement_nature: 'mixed_observation',
        unit_code: 'per_field',
        definition_authority: 'eastmoney.unadjusted_daily_bars',
        time_role: 'observation',
        field_definitions: [
          { field_code: 'open', data_type: 'decimal', unit_code: 'cny_per_share', measurement_nature: 'stock', time_role: 'trading_day' },
          { field_code: 'high', data_type: 'decimal', unit_code: 'cny_per_share', measurement_nature: 'stock', time_role: 'trading_day' },
          { field_code: 'low', data_type: 'decimal', unit_code: 'cny_per_share', measurement_nature: 'stock', time_role: 'trading_day' },
          { field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share', measurement_nature: 'stock', time_role: 'trading_day' },
          { field_code: 'volume_lot', data_type: 'decimal', unit_code: 'lot_100_shares', measurement_nature: 'flow', time_role: 'trading_day' },
          { field_code: 'amount_cny', data_type: 'decimal', unit_code: 'cny', measurement_nature: 'flow', time_role: 'trading_day' },
        ],
      },
      input_mode: 'partial_observation',
      coverage: {
        scope: { dataset: datasetId, bounded_product_release: true },
        basis: 'observed_partial',
        completeness: 'partial',
        coverage_evidence: [],
        absence_means: 'unknown',
      },
      payload: { kind: 'tabular_rows', rows },
      evidence_refs: [evidenceRef],
    }],
    source_bundle: {
      source_id: 'eastmoney_bars_2026q2',
      source_ids: ['eastmoney_bars_2026q2'],
      sources: [{
        source_id: 'eastmoney_bars_2026q2',
        provider: source.provider,
        requested_url: source.requested_url,
        request_method: source.request_method,
        request_form: source.request_form ?? null,
        requested_at_utc: source.requested_at_utc,
        license: source.license,
        usage_scope: source.usage_scope,
        http_status: source.http_status,
        response_url: source.response_url,
        content_type: source.content_type,
        acquired_at_utc: source.acquired_at_utc,
        response_sha256: source.response_sha256,
        response_bytes: source.response_bytes,
        sha256: source.sha256,
        url: source.url,
        evidence_ref: evidenceRef,
        original_file_name: 'eastmoney_bars_2026q2.response',
      }],
      license: source.license,
      usage_scope: source.usage_scope,
      public_time: { status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'Asia/Shanghai' },
      source_roles: { [outputKey]: [{ source_id: 'eastmoney_bars_2026q2', roles: ['definer', 'first_publisher', 'deliverer'] }] },
      product_service: { version: serviceVersion, outputs: { [outputKey]: { read_dependencies: [] } } },
    },
  };
}

function productAndSnapshot(receipt: Json): { productId: string; snapshotId: string } {
  const outputs = asArray(receipt.output_results).map(asRecord);
  const first = outputs[0] ?? {};
  const productId = asString(first.product_id) ?? asString(receipt.product_id);
  const snapshotId = asString(receipt.snapshot_id) ?? asString(first.snapshot_id);
  if (!productId || !snapshotId) throw new Error('submit receipt missing product_id/snapshot_id');
  return { productId, snapshotId };
}

async function main(): Promise<void> {
  const evidenceDir = resolve(required('evidence'));
  const configPath = resolve(required('config'));
  const fixturePath = resolve(required('fixture'));
  mkdirSync(evidenceDir, { recursive: true });
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Json;
  const trustedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Json;
  const projectRoot = asString(trustedConfig.project_root);
  if (!projectRoot) throw new Error('config project_root missing');
  const servicePath = resolve(projectRoot, 'wfd_sdk/product_service.py');
  const governancePath = resolve(projectRoot, 'wfd_sdk/product_governance.py');
  const sourceHashesBefore = { service: sha(readFileSync(servicePath)), governance: sha(readFileSync(governancePath)) };
  const entryPath = resolve(required('entry'));
  const client = new WfdProductMachineClient({
    pythonPath: resolve(required('python')),
    entryPath,
    configPath,
    projectRoot,
    timeoutMs: 300_000,
  });
  const calls: Json[] = [];
  const record = (label: string, reply: WfdProductMachineReply) => calls.push({
    label, operation: reply.transport.operation, requestId: reply.transport.requestId,
    elapsedMs: reply.transport.elapsedMs, responseBytes: reply.transport.responseBytes,
    serviceVersion: reply.transport.serviceVersion, connectionId: reply.transport.connectionId,
    callerId: reply.transport.callerId, namespace: reply.transport.trustedActorNamespace,
  });

  const capabilities = await client.capabilities();
  record('capabilities', capabilities);
  const serviceVersion = asString(asRecord(capabilities.response.service).service_version);
  if (!serviceVersion) throw new Error('service version missing');
  const operations = asRecord(capabilities.result.operations);
  for (const operation of ['evidence_ingest', 'submit', 'request_status', 'fixed_read', 'read_product', 'contract_discovery']) {
    if (asRecord(operations[operation]).supported !== true) throw new Error('missing operation ' + operation);
  }
  const schema = await client.schema();
  record('schema', schema);
  write(resolve(evidenceDir, 'capabilities.json'), capabilities.response);
  write(resolve(evidenceDir, 'schema.json'), schema.response);

  const source = asArray(fixture.sources).map(asRecord).find(item => item.source_id === 'eastmoney_bars_2026q2');
  if (!source || typeof source.path !== 'string') throw new Error('fixture source path missing');
  const raw = readFileSync(source.path);
  if (sha(raw) !== source.response_sha256) throw new Error('fixture response hash mismatch');
  const ingested = await client.evidenceIngest(raw, basename(source.path));
  record('evidence_ingest', ingested);
  const ingestedRef = asRecord(ingested.result);
  const evidenceRef = {
    ref_kind: asString(ingestedRef.ref_kind),
    ref_id: asString(ingestedRef.ref_id),
    content_sha256: asString(ingestedRef.content_sha256),
    binding_digest: ingestedRef.binding_digest ?? null,
    locator_generation: ingestedRef.locator_generation ?? null,
  };
  if (asString(evidenceRef.content_sha256) !== 'sha256:' + source.response_sha256) throw new Error('evidence digest mismatch');
  write(resolve(evidenceDir, 'evidence-ingest.json'), ingested.response);
  write(resolve(evidenceDir, 'source-evidence.json'), {
    source_id: source.source_id, bytes: raw.length, sha256: sha(raw),
    content_sha256: evidenceRef.content_sha256, ref_id: evidenceRef.ref_id,
    original_file_name: source.response_file ?? basename(source.path),
  });

  const datasetId = 'bd_p6_actual_20261027';
  const namespace = 'bd.p6.local';
  const requestId = 'p6-market-' + Date.now();
  const document = submitDocument(fixture, evidenceRef, serviceVersion, datasetId, namespace, requestId);
  write(resolve(evidenceDir, 'producer-request.json'), document);
  const submit = await client.submit(document);
  record('submit', submit);
  write(resolve(evidenceDir, 'submit-receipt.json'), submit.response);
  const receipt = submit.result;
  if (!asArray(receipt.output_results).length) throw new Error('submit returned no output_results');
  const { productId, snapshotId } = productAndSnapshot(receipt);
  write(resolve(evidenceDir, 'submitted-identity.json'), { datasetId, namespace, requestId, productId, snapshotId,
    request_identity: document.request_identity, status: receipt.status ?? receipt.request_state ?? null });

  const status = await client.requestStatus(asRecord(document.request_identity));
  record('request_status', status);
  write(resolve(evidenceDir, 'request-status.json'), status.response);

  const discovery = await client.discover(snapshotId);
  record('contract_discovery', discovery);
  write(resolve(evidenceDir, 'discovery.json'), discovery.response);
  const discovered = asArray(discovery.result.products).map(asRecord).find(product => product.product_id === productId);
  if (!discovered) throw new Error('submitted product not found in fixed snapshot');
  const definition = asRecord(discovered.definition_ref);
  const contract = asRecord(discovered.contract_ref);
  if (!asString(definition.version) || !asString(definition.digest) || !asString(contract.digest)) {
    throw new Error('discovered product identity incomplete');
  }
  const fixed = await client.read({ snapshotId, productId, rowProjection: 'full' });
  record('fixed_read', fixed);
  write(resolve(evidenceDir, 'fixed-read.json'), fixed.response);
  const fixedRows = asArray(fixed.result.rows).map(asRecord);
  if (fixedRows.length !== 60) throw new Error(`fixed_read expected 60 rows, got ${fixedRows.length}`);
  for (const row of fixedRows) {
    if (asString(asRecord(row.definition_ref).version) !== definition.version) throw new Error('fixed row definition mismatch');
    if (asString(asRecord(row.contract_ref).digest) !== contract.digest) throw new Error('fixed row contract mismatch');
  }

  const fields = ['open', 'high', 'low', 'close', 'volume_lot', 'amount_cny'];
  const pages: Json[] = [];
  const pageRequests: Json[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < 10; page += 1) {
    const request = {
      protocol_version: 'wfd.read/1.3-product1',
      dataset_id: datasetId,
      operation: 'read_product',
      snapshot_id: snapshotId,
      history_mode: 'snapshot_contents',
      knowledge_cutoff: null,
      held_scope: null,
      usable_stage: null,
      subject: null,
      max_nodes: 1000,
      product_id: productId,
      fields,
      page_size: 20,
      max_scan_bytes: 20_000_000,
      cursor,
    };
    pageRequests.push(request);
    const reply = await client.readProduct(request);
    record('read_product_' + page, reply);
    pages.push(reply.response);
    const rows = asArray(reply.result.rows).map(asRecord);
    total += rows.length;
    const next = asRecord(reply.result.page).next_cursor;
    if (next === null || next === undefined) { cursor = null; break; }
    if (typeof next !== 'string') throw new Error('read_product returned invalid cursor');
    cursor = next;
  }
  if (total !== 60) throw new Error(`read_product total rows expected 60, got ${total}`);
  write(resolve(evidenceDir, 'read-product-requests.json'), pageRequests);
  write(resolve(evidenceDir, 'read-product-pages.json'), pages);
  write(resolve(evidenceDir, 'read-product-summary.json'), {
    product_id: productId, snapshot_id: snapshotId, page_count: pages.length, row_count: total,
    fields, definition, contract,
    paged_read_complete: total === 60,
    rows_sha256: sha(JSON.stringify(pages)),
  });

  const trace = await client.trace(productId, snapshotId);
  record('trace', trace);
  write(resolve(evidenceDir, 'trace.json'), trace.response);

  const sourceHashesAfter = { service: sha(readFileSync(servicePath)), governance: sha(readFileSync(governancePath)) };
  if (sourceHashesBefore.service !== sourceHashesAfter.service
    || sourceHashesBefore.governance !== sourceHashesAfter.governance) {
    throw new Error('WFD service/governance changed during the run; rerun against one stable source hash');
  }
  const summary = {
    status: 'complete',
    run_at: new Date().toISOString(),
    machine_protocol: asString(capabilities.result.machine_protocol),
    service_version: serviceVersion,
    config_path: configPath,
    fixture_path: fixturePath,
    source_sha256: sha(raw),
    product_id: productId,
    snapshot_id: snapshotId,
    request_identity: document.request_identity,
    request_state: status.result.state ?? status.result.service_status ?? null,
    definition,
    contract,
    fixed_read_rows: fixedRows.length,
    read_product_pages: pages.length,
    read_product_rows: total,
    trace_evidence_count: asArray(trace.result.evidence).length,
    calls,
    code_identity: {
      entry_sha256: sha(readFileSync(entryPath)),
      config_sha256: sha(readFileSync(configPath)),
      service_source_sha256: sourceHashesBefore.service,
      governance_source_sha256: sourceHashesBefore.governance,
    },
    not_claimed: [
      '不是整套 P6/P7 验收；未覆盖 Windows、拔盘、包导入导出或正式生产。',
      '未注册实际 BD runtime 连接；本 run 使用受控候选 config 和 workspace 临时 store。',
      '算法消费未通过；当前合同仍缺结构化 frequency/adjustment/bar_closed/availability/currency。',
    ],
  };
  write(resolve(evidenceDir, 'summary.json'), summary);
  console.log(JSON.stringify({
    status: summary.status, service_version: serviceVersion, product_id: productId,
    snapshot_id: snapshotId, request_state: summary.request_state, fixed_rows: fixedRows.length,
    read_product_rows: total, pages: pages.length, trace_evidence_count: summary.trace_evidence_count,
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CoreDatabase } from '../platform/state/database.js';
import { WfdProductMachineClient } from '../adapters/database/wfd-product-machine.js';
import { buildStructuredIngestDocument, R1HandoffService, validateStructuredDocument,
  WfdStructuredIngestClient, type R1LocalReferences, type R1SourceRef } from '../modules/collection/r1-structured-handoff.js';
import { canonicalWfdJson, wfdSha256 } from '../adapters/database/wfd-transport.js';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const required = (name: string): string => {
  const value = arg(name);
  if (!value) throw new Error('missing --' + name);
  return value;
};
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const write = (path: string, value: unknown) => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
function dayTime(day: string) {
  const start = new Date(day + 'T00:00:00+08:00');
  const end = new Date(start.getTime() + 86_400_000);
  return { status: 'known', precision: 'day',
    earliest_utc: start.toISOString().replace('.000Z', 'Z'),
    latest_exclusive_utc: end.toISOString().replace('.000Z', 'Z'),
    source_timezone: 'Asia/Shanghai' };
}

async function prepare(dbPath: string, evidence: string, configPath: string, pythonPath: string,
  entryPath: string, fixturePath: string, schemaPath: string): Promise<void> {
  mkdirSync(evidence, { recursive: true });
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  const source = asArray(fixture.sources).map(asRecord).find(item => item.source_id === 'eastmoney_bars_2026q2');
  if (!source || typeof source.path !== 'string') throw new Error('fixture source missing');
  const raw = readFileSync(source.path);
  if (wfdSha256(raw) !== source.response_sha256) throw new Error('source hash mismatch');
  const sourceRef: R1SourceRef = {
    source_id: 'eastmoney_bars_2026q2', provider: String(source.provider),
    requested_url: String(source.requested_url), requested_at_utc: String(source.requested_at_utc),
    acquired_at_utc: String(source.acquired_at_utc), sha256: String(source.response_sha256),
    bytes: raw.byteLength, license: String(source.license), usage_scope: String(source.usage_scope),
  };
  const database = new CoreDatabase(dbPath);
  try {
    const service = new R1HandoffService({ database });
    const original = service.registerOriginal({ bytes: raw, originalName: basename(source.path), source: sourceRef });
    const market = asRecord(fixture.market);
    const rows = asArray(market.rows).slice(0, 3).map(value => {
      const row = asRecord(value);
      const day = String(row.trade_date);
      return { business_key: `000001:${day}`, value_decimal: String(row.close),
        value_state: 'valid_value', observation_time: dayTime(day) };
    });
    if (rows.length !== 3) throw new Error('need 3 real daily rows');
    const documentInput = {
      datasetId: 'bd_r1_local_20261028', namespace: 'bd.r1.local', producerNamespace: 'bd.r1.local',
      requestId: 'r1-close-20261028-001', submissionDigest: 'sha256:' + '0'.repeat(64),
      expectedParentSnapshotId: null, outputKey: 'cn.equity.close.unadjusted',
      subject: { kind: 'listing', namespace: 'cn.szse.listing', id: '000001:19910403' },
      definition: {
        semantic_code: 'cn.equity.close.unadjusted', measurement_nature: 'stock',
        unit_code: 'cny_per_share', definition_authority: 'eastmoney.unadjusted_daily_bars',
        time_role: 'observation',
        semantic_context: {
          version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'closed' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' },
        },
      },
      inputMode: 'partial_observation',
      coverage: { scope: { sample_only: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      payload: { kind: 'scalar_rows', rows },
    };
    const document = buildStructuredIngestDocument(documentInput);
    const documentSha = wfdSha256(canonicalWfdJson(document));
    const localRefs: R1LocalReferences = {
      originalIds: [original.originalId], materialIds: [], sourceRefs: [sourceRef],
      processRefs: [{ process_id: 'bd-r1-fixture-select/1', version: '1',
        input_sha256: 'sha256:' + source.response_sha256, output_sha256: documentSha,
        evidence_sha256: 'sha256:' + wfdSha256(canonicalWfdJson(sourceRef)) }],
      evidenceRefs: [{ ref_id: 'bd-evidence:002da38b07778f99997a6b38',
        content_sha256: 'sha256:' + source.response_sha256, kind: 'source_response' }],
    };
    const prepared = service.prepare({ structured: documentInput, localRefs });
    const schema = validateStructuredDocument(document, schemaPath);
    write(resolve(evidence, 'structured-request.json'), document);
    write(resolve(evidence, 'local-refs.json'), localRefs);
    write(resolve(evidence, 'schema-validation.json'), schema);

    const trustedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const projectRoot = asString(trustedConfig.project_root);
    if (!projectRoot) throw new Error('config project_root missing');
    const client = new WfdProductMachineClient({ pythonPath, entryPath, configPath, projectRoot });
    const structuredClient = new WfdStructuredIngestClient(client);
    const probe = await structuredClient.probeProfile();
    write(resolve(evidence, 'profile-probe.json'), probe);
    let submitDependency: Record<string, unknown>;
    try {
      await structuredClient.submit(document);
      submitDependency = { status: 'unexpected_success' };
    } catch (error) {
      submitDependency = { status: 'blocked', code: (error as { code?: string }).code ?? 'ERROR',
        message: error instanceof Error ? error.message : String(error) };
    }
    if (submitDependency.status !== 'blocked') throw new Error('structured profile unexpectedly accepted; refusing to claim pass');
    service.markProfileUnavailable(documentInput.requestId, String(submitDependency.code), String(submitDependency.message));
    write(resolve(evidence, 'profile-submit-blocked.json'), submitDependency);
    const recovery = await service.recoverStatus(documentInput.requestId, structuredClient);
    write(resolve(evidence, 'recovery-probe.json'), recovery);

    const malformed = await service.recordReceipt(documentInput.requestId, {
      dataset_id: documentInput.datasetId, output_key: documentInput.outputKey, product_id: '', definition_digest: '', snapshot_id: '',
      request_identity: document.request_identity as Record<string, unknown>,
      rows: [{ business_key: '', record_id: '', record_version: '1' }],
    }, structuredClient);
    write(resolve(evidence, 'pending-receipt.json'), malformed);
    const explanation = service.localExplanation(documentInput.requestId);
    write(resolve(evidence, 'local-explanation.json'), explanation);
    const summary = {
      status: 'prepared_profile_pending',
      protocol: 'wfd.structured-ingest/1.0',
      document_sha256: documentSha,
      source_sha256: 'sha256:' + source.response_sha256,
      original_id: original.originalId,
      row_count: rows.length,
      schema,
      profile: probe,
      submit: submitDependency,
      pending_receipt: malformed,
      associations: asArray(explanation.associations).length,
      local_originals: asArray(explanation.originals).length,
      not_claimed: [
        'WFD data_only profile 尚未在 canonical entry 广告；未发送 structured submit。',
        '没有实际 record_id/record_version；association 表为空，未用 snapshot_id 或自造 ID 代替。',
        'BD 本地原件/来源/加工/证据引用已落 SQLite，第二个进程只读回 attempt/local refs。',
      ],
    };
    write(resolve(evidence, 'summary.json'), summary);
    console.log(JSON.stringify({ status: summary.status, document_sha256: documentSha,
      profile_supported: probe.supported, submit_code: submitDependency.code ?? null,
      pending_state: malformed.state, associations: summary.associations, originals: summary.local_originals }));
  } finally { database.close(); }
}

function readback(dbPath: string, evidence: string): void {
  const database = new CoreDatabase(dbPath);
  try {
    const service = new R1HandoffService({ database });
    const attempt = service.attempt('r1-close-20261028-001');
    const explanation = service.localExplanation('r1-close-20261028-001');
    write(resolve(evidence, 'new-process-readback.json'), { attempt, explanation });
    console.log(JSON.stringify({ status: 'readback', state: attempt.state,
      document_sha256: attempt.document_sha256, originals: asArray(explanation.originals).length,
      associations: asArray(explanation.associations).length }));
  } finally { database.close(); }
}

const mode = required('mode');
const dbPath = resolve(required('db'));
const evidence = resolve(required('evidence'));
if (mode === 'prepare') {
  await prepare(dbPath, evidence, resolve(required('config')), resolve(required('python')),
    resolve(required('entry')), resolve(required('fixture')), resolve(required('schema')));
} else if (mode === 'read') {
  readback(dbPath, evidence);
} else throw new Error('mode must be prepare|read');

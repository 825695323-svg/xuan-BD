import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CoreDatabase } from '../platform/state/database.js';
import { WfdProductMachineClient } from '../adapters/database/wfd-product-machine.js';
import { buildStructuredIngestDocument, R1HandoffService, validateStructuredDocument,
  WfdStructuredIngestClient, type R1LocalReferences, type R1Receipt, type R1SourceRef } from '../modules/collection/r1-structured-handoff.js';
import { canonicalWfdJson, wfdSha256 } from '../adapters/database/wfd-transport.js';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const required = (name: string): string => { const v = arg(name); if (!v) throw new Error('missing --' + name); return v; };
const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
const write = (path: string, value: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8'); };
const dayTime = (day: string) => {
  const start = new Date(day + 'T00:00:00+08:00'), end = new Date(start.getTime() + 86_400_000);
  return { status: 'known', precision: 'day', earliest_utc: start.toISOString().replace('.000Z', 'Z'),
    latest_exclusive_utc: end.toISOString().replace('.000Z', 'Z'), source_timezone: 'Asia/Shanghai' };
};
const errorCode = (error: unknown) => typeof (error as { code?: unknown }).code === 'string'
  ? String((error as { code: string }).code) : 'ERROR';

async function main(): Promise<void> {
  const mode = required('mode');
  const dbPath = resolve(required('db'));
  const evidence = resolve(required('evidence'));
  if (mode === 'read') {
    const database = new CoreDatabase(dbPath);
    try {
      const service = new R1HandoffService({ database });
      const explanation = service.localExplanation('r1-real-20261028-001');
      write(resolve(evidence, 'new-process-readback.json'), explanation);
      console.log(JSON.stringify({ status: 'readback', state: explanation.state,
        associations: arr(explanation.associations).length, originals: arr(explanation.originals).length }));
    } finally { database.close(); }
    return;
  }
  mkdirSync(evidence, { recursive: true });
  const configPath = resolve(required('config'));
  const trustedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const projectRoot = str(trustedConfig.project_root);
  if (!projectRoot) throw new Error('config project_root missing');
  const entryPath = resolve(required('entry'));
  const schemaPath = resolve(required('schema'));
  const recoverConfigPath = arg('recover-config') ? resolve(String(arg('recover-config'))) : null;
  const fixture = JSON.parse(readFileSync(resolve(required('fixture')), 'utf8')) as Record<string, unknown>;
  const source = arr(fixture.sources).map(rec).find(item => item.source_id === 'eastmoney_bars_2026q2');
  if (!source || typeof source.path !== 'string') throw new Error('source fixture missing');
  const raw = readFileSync(source.path);
  if (wfdSha256(raw) !== source.response_sha256) throw new Error('source hash mismatch');
  const sourceRef: R1SourceRef = {
    source_id: 'eastmoney_bars_2026q2', provider: String(source.provider), requested_url: String(source.requested_url),
    requested_at_utc: String(source.requested_at_utc), acquired_at_utc: String(source.acquired_at_utc),
    sha256: String(source.response_sha256), bytes: raw.byteLength, license: String(source.license),
    usage_scope: String(source.usage_scope),
  };
  const database = new CoreDatabase(dbPath);
  try {
    const service = new R1HandoffService({ database });
    const original = service.registerOriginal({ bytes: raw, originalName: basename(source.path), source: sourceRef });
    const market = rec(fixture.market);
    const sourceRows = arr(market.rows).slice(0, 3).map(value => {
      const row = rec(value), day = String(row.trade_date);
      return { business_key: `000001:${day}`, value_decimal: String(row.close), value_state: 'valid_value',
        observation_time: dayTime(day) };
    });
    const structured = (requestId: string, parent: string | null = null) => ({
      datasetId: 'bd_r1_local_20261028', namespace: 'bd.r1.local', producerNamespace: 'bd.r1.local',
      requestId, submissionDigest: 'sha256:' + '0'.repeat(64), expectedParentSnapshotId: parent,
      outputKey: 'cn.equity.close.unadjusted',
      subject: { kind: 'listing', namespace: 'cn.szse.listing', id: '000001:19910403' },
      definition: { semantic_code: 'cn.equity.close.unadjusted', measurement_nature: 'stock',
        unit_code: 'cny_per_share', definition_authority: 'eastmoney.unadjusted_daily_bars',
        time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
          content_nature: 'observed_fact', time: { period_type: 'natural', frequency: 'day', interval: 'closed' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' } } },
      inputMode: 'partial_observation',
      coverage: { scope: { sample_only: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      payload: { kind: 'scalar_rows', rows: sourceRows },
    });
    const localRefs = (documentSha256: string): R1LocalReferences => ({
      originalIds: [original.originalId], materialIds: [], sourceRefs: [sourceRef],
      processRefs: [{ process_id: 'bd-r1-fixture-select/1', version: '1',
        input_sha256: 'sha256:' + source.response_sha256, output_sha256: documentSha256,
        evidence_sha256: 'sha256:' + wfdSha256(canonicalWfdJson(sourceRef)) }],
      evidenceRefs: [{ ref_id: 'bd-evidence:002da38b07778f99997a6b38',
        content_sha256: 'sha256:' + source.response_sha256, kind: 'source_response' }],
    });
    const realId = 'r1-real-20261028-001';
    const realInput = structured(realId);
    const realDoc = buildStructuredIngestDocument(realInput);
    const realRefs = localRefs(wfdSha256(canonicalWfdJson(realDoc)));
    const prepared = service.prepare({ structured: realInput, localRefs: realRefs });
    const schema = validateStructuredDocument(realDoc, schemaPath);
    const client = new WfdProductMachineClient({ pythonPath: resolve(required('python')), entryPath,
      configPath, projectRoot });
    const structuredClient = new WfdStructuredIngestClient(client, schemaPath);
    const recoverClient = recoverConfigPath
      ? new WfdStructuredIngestClient(new WfdProductMachineClient({ pythonPath: resolve(required('python')), entryPath,
        configPath: recoverConfigPath, projectRoot }), schemaPath)
      : null;
    const probe = await structuredClient.probeProfile();
    if (!probe.supported) throw new Error('data_only profile not advertised');
    const submitted = await service.submitAndAssociate(realId, structuredClient);
    const explanation = service.localExplanation(realId);
    const associations = arr(explanation.associations).map(rec);
    if (submitted.state !== 'associated' || associations.length !== 3) throw new Error('real association did not reach 3');
    const fixed = await structuredClient.fixedRead(String(associations[0].snapshot_id), String(associations[0].product_id));
    const fixedRows = arr(fixed.result.rows).map(rec);
    const receiptRows = fixedRows.map(row => ({ business_key: String(rec(row.row).business_key),
      record_id: String(row.record_id), record_version: String(row.record_version) }));
    const actualReceipt: R1Receipt = {
      dataset_id: 'bd_r1_local_20261028', output_key: 'cn.equity.close.unadjusted',
      product_id: String(associations[0].product_id), definition_digest: String(associations[0].definition_digest),
      snapshot_id: String(associations[0].snapshot_id), request_identity: realDoc.request_identity as Record<string, unknown>,
      rows: receiptRows,
    };
    const negativeId = 'r1-negative-20261028-001';
    const negativeInput = structured(negativeId);
    const negativeDoc = buildStructuredIngestDocument(negativeInput);
    service.prepare({ structured: negativeInput, localRefs: localRefs(wfdSha256(canonicalWfdJson(negativeDoc))) });
    const tamper = async (label: string, mutation: (receipt: R1Receipt) => void) => {
      const candidate = JSON.parse(JSON.stringify(actualReceipt)) as R1Receipt;
      candidate.request_identity = negativeDoc.request_identity as Record<string, unknown>;
      mutation(candidate);
      return { label, result: await service.recordReceipt(negativeId, candidate, structuredClient) };
    };
    const negatives = [
      await tamper('wrong_business_key', receipt => { receipt.rows[0].business_key = 'wrong:business:key'; }),
      await tamper('wrong_product', receipt => { receipt.product_id = 'p_caller_invented'; }),
      await tamper('wrong_definition', receipt => { receipt.definition_digest = 'sha256:' + '0'.repeat(64); }),
      await tamper('wrong_snapshot', receipt => { receipt.snapshot_id = 's_caller_invented'; }),
      await tamper('invented_record_version', receipt => { receipt.rows[0].record_version = 'r_caller_invented'; }),
      await tamper('wrong_request_identity', receipt => { receipt.request_identity = realDoc.request_identity as Record<string, unknown>; }),
    ];
    for (const item of negatives) if (item.result.associated !== 0 || item.result.state !== 'pending_receipt') {
      throw new Error('negative receipt was not rejected: ' + item.label);
    }
    // 主审实证：不同 attempt 同 business_key、值改 999.00，不能借旧真实回执关联。
    const crossId = 'r1-cross-value-20261028-001';
    const crossInput = structured(crossId);
    (crossInput.payload.rows[0] as Record<string, unknown>).value_decimal = '999.00';
    const crossDoc = buildStructuredIngestDocument(crossInput);
    service.prepare({ structured: crossInput, localRefs: localRefs(wfdSha256(canonicalWfdJson(crossDoc))) });
    const crossReceipt: R1Receipt = { ...actualReceipt, request_identity: crossDoc.request_identity as Record<string, unknown> };
    const crossResult = await service.recordReceipt(crossId, crossReceipt, structuredClient);
    if (crossResult.associated !== 0 || crossResult.state !== 'pending_receipt'
      || !crossResult.errors.some(error => error.includes('business_content:value_decimal'))) {
      throw new Error('cross-request changed value was not rejected');
    }
    let sourceMismatch: string;
    try {
      service.registerOriginal({ bytes: raw, originalName: 'x', source: { ...sourceRef, sha256: '0'.repeat(64) } });
      sourceMismatch = 'unexpected_success';
    } catch (error) { sourceMismatch = errorCode(error); }
    let multiSource: string;
    try {
      service.prepare({ structured: { ...structured('r1-multi-20261028-001') },
        localRefs: { ...localRefs(wfdSha256(canonicalWfdJson(realDoc))), originalIds: [original.originalId, original.originalId],
          sourceRefs: [sourceRef, sourceRef] } });
      multiSource = 'unexpected_success';
    } catch (error) { multiSource = errorCode(error); }
    const recovered = await service.recoverStatus(realId, structuredClient);
    const recoveredAgain = service.localExplanation(realId);
    const recoverId = 'r1-recover-20261028-002';
    const recoverInput = structured(recoverId);
    const recoverDoc = buildStructuredIngestDocument(recoverInput);
    service.prepare({ structured: recoverInput, localRefs: localRefs(wfdSha256(canonicalWfdJson(recoverDoc))) });
    if (!recoverClient) throw new Error('missing --recover-config');
    const lostReceiptSubmit = await recoverClient.submit(recoverDoc);
    write(resolve(evidence, 'lost-receipt-submit.json'), lostReceiptSubmit.response);
    if (lostReceiptSubmit.result.state !== 'published_formal') {
      throw new Error('recover submit not published: ' + String(lostReceiptSubmit.result.state) + ' ' + JSON.stringify(lostReceiptSubmit.result.errors ?? null));
    }
    const recoveredLost = await service.recoverStatus(recoverId, recoverClient);
    const recoveredLostAgain = await service.recoverStatus(recoverId, recoverClient);
    const lostExplanation = service.localExplanation(recoverId);
    if (arr(lostExplanation.associations).length !== 3) throw new Error('lost-receipt recovery did not associate 3');
    const summary = {
      status: 'complete', profile: probe, schema, document_sha256: wfdSha256(canonicalWfdJson(realDoc)),
      source_sha256: 'sha256:' + source.response_sha256, original_id: original.originalId,
      product_id: associations[0].product_id, snapshot_id: associations[0].snapshot_id,
      real_state: submitted.state, real_associations: associations.length,
      actual_receipt_rows: receiptRows, fixed_rows: fixedRows.length,
      negatives, cross_request_value_mismatch: crossResult,
      source_mismatch: sourceMismatch, multi_source: multiSource,
      recovery_already_associated: recovered.state ?? recovered,
      recovery_again_associations: arr(recoveredAgain.associations).length,
      lost_receipt_state: recoveredLost.state ?? recoveredLost,
      lost_receipt_associations: arr(lostExplanation.associations).length,
      lost_receipt_again: recoveredLostAgain.state ?? recoveredLostAgain,
      local_explanation_without_wfd: (() => { const exp = service.localExplanation(recoverId);
        return { state: exp.state, associations: arr(exp.associations).length, originals: arr(exp.originals).length }; })(),
    };
    write(resolve(evidence, 'real-association.json'), { explanation, receipt: actualReceipt });
    write(resolve(evidence, 'negative-receipts.json'), negatives);
    write(resolve(evidence, 'summary.json'), summary);
    console.log(JSON.stringify({ status: summary.status, product_id: summary.product_id,
      snapshot_id: summary.snapshot_id, real_associations: summary.real_associations,
      negatives_ok: negatives.every(item => item.result.associated === 0),
      source_mismatch: summary.source_mismatch, multi_source: summary.multi_source,
      lost_receipt_associations: summary.lost_receipt_associations,
      lost_receipt_again: summary.lost_receipt_again }));
  } finally { database.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });

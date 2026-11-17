import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { conversionText } from '../../platform/capabilities/conversion/storage.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

const sourceRoot = process.env.XUAN_COMPANY_ACTION_SOURCE_ROOT;
const sourceUrl = 'https://static.cninfo.com.cn/finalpage/2025-06-20/1223934491.PDF';
const sourceHash = '8ff3e6e370c75cece700e5474337c8ecf1adb87b01a1a696bae02fd25982af3b';
const reviewedNativeHash = 'adfc898c6ca41ce273f1c7240a129761b139943328cc8e179a8c7c17a400a770';
// Explicit opt-in official sample. No download, model, numeric calculation or original PDF in Git.
test('official company action: original PDF → native text → reviewed spans → source_claim event records → fixed restart read',
  { skip: !sourceRoot || !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300_000 }, async () => {
    const provenance = JSON.parse(readFileSync(join(sourceRoot!, 'manifest.json'), 'utf8'));
    assert.equal(provenance.kind, 'official_company_action_probe'); assert.equal(provenance.synthetic, false);
    assert.equal(provenance.sources.length, 1);
    const acquired = provenance.sources[0];
    assert.equal(acquired.url, sourceUrl); assert.equal(acquired.sha256, sourceHash); assert.equal(acquired.status, 200);
    assert.ok(Number.isFinite(Date.parse(acquired.requestedAt)) && Number.isFinite(Date.parse(acquired.acquiredAt)));
    assert.ok(Date.parse(acquired.acquiredAt) >= Date.parse(acquired.requestedAt));
    const original = readFileSync(join(sourceRoot!, 'implementation.pdf'));
    assert.equal(original.length, 181135); assert.equal(original.length, acquired.bytes); assert.equal(wfdSha256(original), sourceHash);
    const fixture = createFullChainFixture({ name: 'official-company-action', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      await host.call('/retrieval/settings', { requestId: 'action-no-auto-date', autoRegister: 'disabled' });
      const upload = await host.upload('implementation.pdf', 'data', original, 'action-original');
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const originalMaterial = host.services.materials!.getByTask(upload.jobId)!.envelope;
      const conversion = await host.call('/retrieval/documents/' + originalMaterial.materialId + '/convert', { requestId: 'action-native-conversion' }, 202);
      const converted = await host.settled(conversion.jobId); assert.equal(converted.status, 'succeeded', JSON.stringify(converted.error));
      const data = converted.result!.data as any;
      const envelope = JSON.parse(readFileSync(host.services.files.verify(data.structuredReference.fileRefId).invocationPath, 'utf8'));
      assert.equal(envelope.source.sha256, sourceHash);
      const native = conversionText(envelope); assert.ok(native !== undefined);
      const nativeBytes = Buffer.from(native), nativeHash = wfdSha256(nativeBytes);
      assert.equal(nativeHash, reviewedNativeHash, 'Native text changed: re-review the original and span positions, never silently replace the pin');
      writeFileSync(join(fixture.root, 'native-complete.txt'), nativeBytes, { flag: 'wx' });
      // Operator-reviewed regions of the pinned PDF (pages 2, 3 and 5). Anchor
      // lookup only locates these reviewed spans; it is not semantic extraction.
      const locate = (pattern: RegExp) => { const match = pattern.exec(native); assert.ok(match, String(pattern)); return match.index; };
      const cut = (start: number, end: number) => ({ start, end, quote: native.slice(start, end) });
      const excerpts = [
        cut(locate(/截至本公告日/u), locate(/2\.\s*本次差异化分红除权/u)),
        cut(locate(/（1）\s*由于公司本次进行差异化分红/u), locate(/三、相关日期/u)),
        cut(locate(/三、相关日期/u), locate(/四、分配实施办法/u)),
        cut(locate(/贵州茅台酒股份有限公司董事会/u), native.length),
      ];
      assert.deepEqual(excerpts.map(item => [item.start, item.end]), [[592, 767], [863, 1119], [1119, 1193], [2447, 2477]]);
      const compact = excerpts.map(item => item.quote.replace(/\s/gu, ''));
      assert.ok(compact[0]!.includes('27.673元（含税）'));
      assert.ok(compact[1]!.includes('27.600'));
      assert.ok(compact[2]!.includes('股权登记日') && compact[2]!.includes('2025/6/25') && compact[2]!.includes('2025/6/26'));
      assert.ok(compact[3]!.includes('2025年6月20日'));
      const reviewBasis = 'Operator-reviewed pinned original PDF pages 1/2/3/5: actual declared gross per-share cash 27.673 CNY and differential ex-dividend reference 27.600 CNY are distinct source claims; registration 2025-06-25, ex-dividend/payment 2025-06-26, signature 2025-06-20 are document dates only. No actual payment, exact public/event time, adjustment calculation or independent verification asserted. Derived text is the complete unchanged native conversion, not the PDF original. PDF SHA256=' + sourceHash + '; native UTF8 SHA256=' + nativeHash;
      const selection = { version: EVENT_TEXT_VERSION, sourceSha256: nativeHash, reviewBasis,
        occurrence: { namespace: 'cninfo', publisherId: 'issuer_600519', publicationId: '1223934491', kind: 'original', upstreamPublicationId: null }, excerpts };
      const uploadedText = await host.upload('implementation-native-derived.txt', 'data', nativeBytes, 'action-native-derived');
      assert.equal((await host.settled(uploadedText.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(uploadedText.jobId)!.envelope.materialId;
      const source = { source_id: 'cninfo-600519-1223934491', provider: 'Issuer announcement hosted by CNINFO', requested_url: sourceUrl,
        requested_at_utc: acquired.requestedAt, acquired_at_utc: acquired.acquiredAt, usage_scope: 'Authorized isolated official company-action source-claim pipeline verification only',
        authorization: { status: 'authorized', basis: 'User authorized free official company-action sample validation; original PDF and derived text provenance retained separately' } };
      const fields = ['text', 'content_sha256', 'assertion_kind', 'occurrence_identity_basis', 'independence_status', 'public_time_status'];
      const target = { datasetId: 'official_company_action', outputKey: 'official.action.claim', expectedParentSnapshotId: null,
        subject: { kind: 'entity', namespace: 'cn.exchange', id: '600519' },
        definition: { semantic_code: 'official.action.claim', measurement_nature: 'event', unit_code: 'not_applicable', definition_authority: 'bd.operator.reviewed', time_role: 'event',
          field_definitions: fields.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' })),
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
            time: { period_type: 'natural', frequency: 'notice', interval: 'half_open', timezone: 'Asia/Shanghai' },
            content: { assertion_status: 'operator_declared', target_period: '2024 annual distribution notice; not independently verified outcome' } } },
        inputMode: 'partial_observation', coverage: { scope: { excerpts: 'operator_reviewed_selected_regions' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
      const mapping = { kind: 'event_records', eventId: 'business_key', eventType: 'event_type', assertionKind: 'assertion_kind', contentNature: 'source_claim', status: 'unknown',
        eventTime: { status: 'unknown', sourceTimezone: 'Asia/Shanghai' }, publicTime: { status: 'unknown', sourceTimezone: 'Asia/Shanghai' },
        fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'metadata_state' })) };
      const values: Record<string, string> = { role: 'source_claim', informationNature: 'source_claim', businessObject: '600519 issuer distribution notice',
        objectTime: 'Document signature day 2025-06-20 only; event and public time unknown', purpose: source.usage_scope, structureGranularity: 'Operator-reviewed exact native-text spans, not independent event facts' };
      const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key], evidence: [{ source: 'operator', field: key, quote: values[key] }] }]));
      const accepted = await host.call('/processing/plans', { requestId: 'action-plan', input: {
        routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'claim', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
          tables: [{ materialId, format: 'text', eventTextSelection: selection, annotations: { metadata_state: 'valid_value', event_type: 'issuer_distribution_notice' } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: null } }] } }, 202);
      const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
      const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
      for (const kind of ['parse', 'structure', 'annotate', 'check']) {
        const step = host.services.processing!.get(planId).steps.find(item => item.kind === kind)!;
        if (step.state === 'succeeded') continue;
        const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: 'action-' + kind }, 202);
        const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      }
      const plan = host.services.processing!.get(planId); assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]!.gaps));
      const parse = plan.steps.find(step => step.kind === 'parse')!;
      const parsed = JSON.parse(host.services.processing!.artifact(planId, parse.stepId).bytes.toString());
      assert.equal(parsed.event_text_evidence.independentSemanticVerification, false);
      assert.equal(parsed.event_text_evidence.publicTimeEstablished, false);
      assert.deepEqual(parsed.event_text_evidence.selection, selection);
      const prepared = await host.call('/r1/prepare', { requestId: 'action-publish', planId, outputId: 'claim', source, target, mapping }, 201);
      const submit = await host.call('/r1/requests/action-publish/submit', { confirmationDigest: prepared.documentSha256 }, 202);
      const committed = await host.settled(submit.jobId, 180_000); assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
      const view = await host.call('/r1/requests/action-publish'); assert.equal(view.state, 'associated', JSON.stringify(view));
      const association = view.local.associations[0];
      const read = () => host.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id });
      const fixed = await read(); assert.equal(fixed.result.rows.length, excerpts.length);
      assert.deepEqual(fixed.result.rows.map((row: any) => row.values.text.value).sort(), excerpts.map(item => item.quote).sort());
      for (const row of fixed.result.rows) { assert.equal(row.values.content_sha256.value, wfdSha256(row.values.text.value)); assert.equal(row.values.assertion_kind.value, 'source_claim'); assert.equal(row.values.independence_status.value, 'not_established'); }
      const timeline = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: target.datasetId, snapshotId: association.snapshot_id, subject: target.subject });
      assert.equal(timeline.result.rows.length, excerpts.length);
      for (const row of timeline.result.rows) { assert.equal(row.event.content_nature, 'source_claim'); assert.equal(row.event.status, 'unknown'); assert.equal(row.times.event_time.status, 'unknown'); assert.equal(row.times.public_time.status, 'unknown'); }
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read()).result.rows, fixed.result.rows);
      writeFileSync(join(fixture.root, 'official-action-proof.json'), JSON.stringify({ source: acquired, sourcePdfSha256: sourceHash,
        originalMaterialId: originalMaterial.materialId, conversionTaskId: conversion.jobId, conversionRef: data.structuredReference,
        derivedTextMaterialId: materialId, completeNativeTextSha256: nativeHash, selection, planId, association,
        publicTimeEstablished: false, eventOccurrenceEstablished: false, adjustmentCalculated: false, independentSemanticVerification: false, reopenedFixedRows: true }, null, 2), { flag: 'wx' });
    } finally { await host.close(); }
  });

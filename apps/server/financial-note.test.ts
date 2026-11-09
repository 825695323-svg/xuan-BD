import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { projectFinancialPdf } from '../../modules/collection/data-processing/financial-pdf.js';
import { conversionText } from '../../platform/capabilities/conversion/storage.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

const sourceRoot = process.env.XUAN_FINANCIAL_SOURCE_ROOT;
test('official correction full necessary paragraph: original material → ordinary conversion → reviewed exact text → actual WFD → restart',
  { skip: !sourceRoot || !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-note', machine: true, units: { text: { dimension: 'text' } } });
    writeFileSync(join(fixture.root, 'financial-fixture.json'), JSON.stringify(fixture, null, 2));
    const provenance = JSON.parse(readFileSync(join(sourceRoot!, 'correction-necessary-provenance.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(sourceRoot!, '原件/correction-2024.source.json'), 'utf8'));
    const selection = provenance.necessarySelection, original = readFileSync(join(sourceRoot!, '原件/correction-2024.pdf'));
    assert.equal(wfdSha256(original), provenance.sourcePdfSha256);
    let host = await openFullChainHost(fixture);
    try {
      await host.call('/retrieval/settings', { requestId: 'note-no-auto-date', autoRegister: 'disabled' });
      const upload = await host.upload('correction-2024.pdf', 'data', original, 'note-original');
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const originalMaterial = host.services.materials!.getByTask(upload.jobId)!.envelope;
      const conversion = await host.call('/retrieval/documents/' + originalMaterial.materialId + '/convert', { requestId: 'note-real-native-conversion' }, 202);
      const converted = await host.settled(conversion.jobId); assert.equal(converted.status, 'succeeded', JSON.stringify(converted.error));
      const data = converted.result!.data as any;
      const envelope = JSON.parse(readFileSync(host.services.files.verify(data.structuredReference.fileRefId).invocationPath, 'utf8'));
      assert.equal(envelope.source.sha256, provenance.sourcePdfSha256);
      const native = conversionText(envelope); assert.ok(native !== undefined);
      assert.equal(wfdSha256(Buffer.from(native)), provenance.nativeTextSha256);
      const text = native.slice(0, provenance.nativeStart) + '\n\n' + native.slice(provenance.nativeStart, provenance.nativeEnd)
        + '\n\n' + native.slice(provenance.nativeEnd);
      assert.equal(wfdSha256(Buffer.from(text)), selection.sourceSha256);
      const uploadedText = await host.upload('correction-2024-paragraphs.txt', 'data', Buffer.from(text), 'note-reviewed-native-text');
      assert.equal((await host.settled(uploadedText.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(uploadedText.jobId)!.envelope.materialId;
      const expected = JSON.parse(readFileSync(join(sourceRoot!, '选区/correction-2024.necessary.rows.json'), 'utf8'))[0];
      const fields = ['text_role', 'text', 'document_version', 'purpose'];
      const acquisition = { source_id: 'cninfo-longxi-correction', provider: '龙溪股份监事会经巨潮资讯公开披露',
        requested_url: source.url, requested_at_utc: source.requestedAt, acquired_at_utc: source.acquiredAt,
        usage_scope: '本轮授权真实更正必要业务段的隔离发布与固定读回', authorization: { status: 'authorized', basis: '用户授权真实公开财报及更正材料整改与验收' } };
      const target = { datasetId: 'longxi_necessary_note', outputKey: 'financial.correction.scope', expectedParentSnapshotId: null,
        subject: { kind: 'entity', namespace: 'full.chain.test', id: 'longxi_600592' },
        definition: { semantic_code: 'financial.correction.scope', measurement_nature: 'relation', unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
          field_definitions: fields.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'observation' })),
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
            time: { period_type: 'natural', frequency: 'disclosure_day', interval: 'half_open', timezone: 'UTC' },
            content: { assertion_status: 'published', target_period: 'longxi-correction-published-2025-04-30' } } },
        inputMode: 'partial_observation', coverage: { scope: { report: 'correction-2024', page: 1, purpose: 'correction_scope' },
          basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
      const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
        precision: 'day', sourceTimezone: 'UTC', fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'metadata_state' })) };
      const values: Record<string, string> = { role: 'necessary_condition', informationNature: 'source_claim', businessObject: '龙溪股份600592更正披露的影响范围',
        objectTime: '2025-04-30披露日期桶，未认领历史可用时间', purpose: acquisition.usage_scope, structureGranularity: '完整原文业务段及其版本、摘要、用途' };
      const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key],
        evidence: [{ source: 'operator', field: key, quote: values[key] }] }]));
      const accepted = await host.call('/processing/plans', { requestId: 'note-plan', input: {
        routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'necessary', materialIds: [materialId], intendedAction: 'publish',
          tables: [{ materialId, format: 'text', necessaryTextSelection: selection,
            annotations: { start_utc: '2025-04-30T00:00:00Z', end_utc: '2025-05-01T00:00:00Z', metadata_state: 'valid_value' } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source: acquisition, target, mapping }, expectedSnapshotId: null } }] } }, 202);
      const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
      const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
      const run = await host.call('/processing/plans/' + planId + '/run', { requestId: 'note-run' }, 202);
      const ran = await host.settled(run.jobId); assert.equal(ran.status, 'succeeded', JSON.stringify(ran.error));
      const plan = host.services.processing!.get(planId); assert.equal(plan.status, 'completed', JSON.stringify(plan));
      assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]!.gaps));
      const parse = plan.steps.find(step => step.kind === 'parse')!;
      const proof = JSON.parse(host.services.processing!.artifact(planId, parse.stepId).bytes.toString());
      assert.equal(proof.necessary_text_evidence.conditionIntegrity, 'exact-complete-source-paragraphs');
      assert.equal(proof.necessary_text_evidence.independentSemanticVerification, false);
      const prepared = await host.call('/r1/prepare', { requestId: 'note-publish', planId, outputId: 'necessary', source: acquisition, target, mapping }, 201);
      const submit = await host.call('/r1/requests/note-publish/submit', { confirmationDigest: prepared.documentSha256 }, 202);
      const committed = await host.settled(submit.jobId, 180_000); assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
      const view = await host.call('/r1/requests/note-publish'); assert.equal(view.state, 'associated', JSON.stringify(view));
      const association = view.local.associations[0], fixed = await host.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id });
      assert.equal(fixed.result.rows.length, 1);
      for (const field of fields) assert.equal(fixed.result.rows[0].values[field].value, expected[field]);
      assert.ok(!Object.hasOwn(fixed.result.rows[0].values, 'text_sha256'));
      assert.ok(fixed.result.rows[0].values.text.value.includes('不涉及'));
      assert.ok(fixed.result.rows[0].values.text.value.includes('不会导致'));
      await host.close(); host = await openFullChainHost(fixture);
      assert.equal((await host.call('/r1/requests/note-publish')).state, 'associated');
      const again = await host.call('/r1/products/read', { snapshotId: association.snapshot_id, productId: association.product_id });
      assert.deepEqual(again.result.rows, fixed.result.rows);
      writeFileSync(join(fixture.root, 'necessary-fixed-proof.json'), JSON.stringify({ originalMaterialId: originalMaterial.materialId,
        originalSha256: provenance.sourcePdfSha256, conversionEntry: '/retrieval/documents/:id/convert',
        conversionTaskId: conversion.jobId, conversionRef: data.structuredReference,
        reviewedTextMaterialId: materialId, sourceTextSha256: selection.sourceSha256, planId, association, fixedRows: again.result.rows,
        completeParagraph: expected.text, independentSemanticVerification: false, reopenedFixedRows: true }, null, 2));
    } finally { await host.close(); }
  });

test('real split financial cell requires exact continuation and refuses altered original fragment',
  { skip: !sourceRoot, timeout: 30_000 }, async () => {
    const selection = JSON.parse(readFileSync(join(sourceRoot!, '选区/half-2024-corrected.consolidated.equity_changes.2024.page-45.cny.json'), 'utf8'));
    const bytes = readFileSync(join(sourceRoot!, '原件/half-2024-corrected.pdf'));
    const result = await projectFinancialPdf(bytes, selection, new AbortController().signal), rows = JSON.parse(result.jsonBytes.toString());
    const row = rows.find((row: any) => row.concept === '（三）利润分配' && row.dimension === '所有者权益合计');
    assert.equal(row.value, '-50743303.52');
    const modified = structuredClone(selection), region = modified.regions.find((region: any) => region.continuations);
    region.continuations[0].quote = '53';
    await assert.rejects(projectFinancialPdf(bytes, modified, new AbortController().signal), /原文与核定片段不符/u);
    delete region.continuations;
    await assert.rejects(projectFinancialPdf(bytes, modified, new AbortController().signal), /不符合冻结数值语法/u);
    assert.equal(canonicalWfdJson(rows), result.jsonBytes.toString());
  });

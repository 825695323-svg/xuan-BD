import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { acceptWorkspaceMaterial } from '../../modules/collection/accept-material.js';
import { mediaPacketDigest } from '../../modules/collection/data-processing/ocr-claim.js';
import { segmentsFromConversionArtifact } from '../../modules/collection/segments/from-conversion.js';
import { zipOfficeParts } from '../../platform/capabilities/conversion/office-test-support.js';
import { openMediaReviewCompanion } from './media-review-test-support.js';
import { createFullChainFixture, settleFixtureTask as settled } from './full-chain-test-support.js';
import { readRetrievalEvidence } from './retrieval-evidence.js';

const types = (part: string, mime: string) => `<Types><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${mime}.main+xml"/></Types>`;
const p = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
function docx() {
  return zipOfficeParts({
    '[Content_Types].xml': types('word/document.xml', 'wordprocessingml.document'),
    'word/document.xml': `<w:document xmlns:w="urn:word" xmlns:r="urn:rels"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>概览</w:t></w:r></w:p>
      <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>分项</w:t></w:r></w:p>
      <w:p><w:hyperlink r:id="unresolved"><w:r><w:t>分项原文</w:t><w:drawing/></w:r></w:hyperlink></w:p>
      <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('指标')}</w:tc><w:tc>${p('42')}</w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
    'word/styles.xml': '<w:styles xmlns:w="urn:word"><w:style w:type="paragraph" w:styleId="H"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="H"/></w:style></w:styles>',
    'word/footer1.xml': `<w:ftr xmlns:w="urn:word">${p('页脚附文')}</w:ftr>`,
  });
}
function pptx() {
  const shape = (body: string) => `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:spTree>${body}</p:spTree></p:sld>`;
  const para = (s: string) => `<a:p><a:r><a:t>${s}</a:t></a:r></a:p>`;
  return zipOfficeParts({
    '[Content_Types].xml': types('ppt/presentation.xml', 'presentationml.presentation'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="31" r:id="b"/><p:sldId id="87" r:id="a"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="a" Type="urn:r/slide" Target="slides/slide1.xml"/><Relationship Id="b" Type="urn:r/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide2.xml': shape(`<p:sp><p:txBody>${para('第一张')}</p:txBody></p:sp>`),
    'ppt/slides/slide1.xml': shape(`<p:sp><p:txBody>${para('第二张')}</p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody>${para('指标 42')}</a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame><p:pic/>`),
  });
}
async function host() {
  const f = createFullChainFixture({ name: 'native-segments', parentRoot: process.env.XUAN_TEST_ROOT ?? tmpdir() });
  const h = openMediaReviewCompanion(f), services = h.companion;
  services.permissions.grant({ label: 'isolated conversion artifacts', scope: { kind: 'persistent' },
    capabilities: (['read', 'write', 'delete'] as const).map(action => ({ action, target: { kind: 'directory', path: services.artifactRoot, recursive: true } })) });
  return { root: f.root, services, segments: services.segments!, close: () => h.close(), async intake(bytes: Buffer, name: string) {
    const taskId = await acceptWorkspaceMaterial(services, { bytes, name, category: 'data', requestId: name });
    const task = await settled(services.tasks, taskId);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    return services.materials!.getByTask(task.id)!.envelope;
  } };
}

test('real Office conversion tasks automatically index native parts and replay fixed byte evidence', async () => {
  const h = await host();
  try {
    const { services, segments } = h;
    for (const [format, bytes] of [['docx', docx()], ['pptx', pptx()]] as const) {
      const material = await h.intake(bytes, 'synthetic.' + format);
      const action = 'conversion.document', args = { fileRefId: material.fileRefId };
      const task = services.tasks.create({ action, args, requestId: 'convert-' + format, title: 'Native Office test',
        ownerRole: 'service', runtimeId: 'direct', versions: services.direct.registry.captureVersions(action, args) });
      services.tasks.start(task.id, task.version);
      const converted = await settled(services.tasks, task.id);
      assert.equal(converted.status, 'succeeded', JSON.stringify(converted.error));
      const auto = segments.automatic(material.materialId)[0] as any;
      assert.ok(auto?.task?.id, JSON.stringify(auto));
      const ingested = await settled(services.tasks, auto.task.id);
      assert.equal(ingested.status, 'succeeded', JSON.stringify(ingested.error));
      const indexVersion = (ingested.result!.data as any).indexVersion;
      const hits = segments.search({ method: 'exact', query: '42', indexVersion });
      const citation = hits.citations.find(item => item.document_id === material.materialId)!;
      assert.ok(citation); assert.equal(citation.kind, 'table');
      const input = { indexVersion, segmentId: citation.segment_id };
      const check = await readRetrievalEvidence(services, input);
      for (const part of [check.cache, check.artifact, check.original]) assert.equal(part.status, 'verified');
      const docs = segments.segments(material.materialId), table = segments.evidenceBinding(indexVersion, citation.segment_id).segment.table!;
      assert.equal(table.verification, 'native-structure'); assert.equal(table.rows[0]!.cells[0]!.x0, null);
      assert.equal(table.rows[0]!.cells[0]!.cell_ref.endsWith(':r1c1'), true);
      assert.equal(citation.bbox, null); assert.equal(citation.text_digest, wfdSha256(citation.excerpt));
      assert.ok(citation.document_issues!.includes('conversion_issue:OFFICE_NATIVE_OBJECT'));
      if (format === 'docx') {
        assert.equal(segments.documents().find(d => d.document_id === material.materialId)!.page_count, null);
        assert.equal(citation.page_number, null);
        assert.ok(table.rows[0]!.cells[1]!.cell_ref.endsWith(':r1c3'));
        assert.deepEqual(citation.section_path, ['概览', '分项']);
        assert.deepEqual(docs.map(d => d.excerpt), ['概览', '分项', '分项原文', '指标 | 42', '页脚附文']);
        assert.ok(docs[2]!.issues.includes('conversion_issue:RELATIONSHIP_MISSING'));
        assert.ok(docs[2]!.issues.includes('conversion_issue:OFFICE_NATIVE_OBJECT'));
        assert.deepEqual(docs.at(-1)!.section_path, ['word/footer1.xml']);
      } else {
        assert.deepEqual(docs.map(d => d.page_number), [1, 2, 2]);
        assert.deepEqual(citation.section_path, ['ppt/slides/slide1.xml']);
      }
      await assert.rejects(readRetrievalEvidence(services, { ...input, indexVersion: 'missing' }), /固定索引/u);
    }
  } finally { await h.close(); }
});

test('real XLSX stays on the structured registration route with no document or index membership', async () => {
  const h = await host();
  try {
    const bytes = zipOfficeParts({
      '[Content_Types].xml': types('xl/workbook.xml', 'spreadsheetml.sheet'),
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Synthetic" sheetId="1" r:id="s"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="s" Type="urn:r/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
    });
    // conversion.structured consumes an explicitly selected file. Managed upload copies have a separate table route.
    const path = join(h.root, 'synthetic.xlsx'); writeFileSync(path, bytes);
    const ref = h.services.files.register({ path, source: 'user-selected' });
    h.services.permissions.grant({ label: 'selected synthetic workbook', scope: { kind: 'persistent' },
      capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
    const custody = h.services.materials!.submit({ fileRefId: ref.id, category: 'data', expectedSha256: wfdSha256(bytes) }, 'selected-workbook');
    assert.equal((await settled(h.services.tasks, custody.id)).status, 'succeeded');
    const material = h.services.materials!.getByTask(custody.id)!.envelope;
    const action = 'conversion.structured', args = { fileRefId: material.fileRefId };
    const task = h.services.tasks.create({ action, args, requestId: 'convert-sheet', title: 'Structured test', ownerRole: 'service',
      runtimeId: 'direct', versions: h.services.direct.registry.captureVersions(action, args) });
    h.services.tasks.start(task.id, task.version);
    const converted = await settled(h.services.tasks, task.id); assert.equal(converted.status, 'succeeded', JSON.stringify(converted.error));
    const artifactRef = (converted.result!.data as any).structuredReference.fileRefId;
    const registered = await settled(h.services.tasks, h.segments.requestArtifact({ materialId: material.materialId,
      artifactRef, conversionTaskId: task.id }, 'sheet-registration').id);
    assert.equal(registered.status, 'succeeded', JSON.stringify(registered.error));
    assert.equal((registered.result!.data as any).reason, 'structured_table_route');
    assert.equal(h.segments.artifacts(material.materialId)[0]!.processing_status, 'registered');
    const renamed = join(h.services.artifactRoot, 'workbook-as-document.json');
    writeFileSync(renamed, JSON.stringify({ operation: 'conversion.document', source: { fileRefId: ref.id, sha256: material.sha256 },
      status: 'complete', issues: [], content: { format: 'pdf', pageCount: 1, pages: [{ page: 1 }] } }));
    const disguised = h.services.files.register({ path: renamed, source: 'generated' });
    const rejected = await settled(h.services.tasks, h.segments.requestArtifact({ materialId: material.materialId, artifactRef: disguised.id }, 'wrong-route').id);
    assert.equal(rejected.error?.code, 'SEGMENT_STRUCTURED_TABLE');
    assert.deepEqual(h.segments.documents(), []); assert.deepEqual(h.segments.indexVersions(), []);
  } finally { await h.close(); }
});

test('verified OCR packet admission, both reference forms, fixed readback, and tampering', async () => {
  const h = await host();
  try {
    const { segments, services } = h, source = await h.intake(Buffer.from('synthetic scanned page bytes'), 'synthetic.png');
    const text = '合成识别结果', taskId = 'synthetic-ocr-reader';
    const ref = (fileRefId: string, sha256: string) => ({ fileRefId, fileRefVersion: 1, sha256 });
    const packet = { schema: 'bd-ocr-review-packet/1', taskId, original: { sha256: source.sha256 },
      source: { ...ref('personal-original', source.sha256), materialId: source.materialId },
      textReference: ref('text-ref', wfdSha256(text)), evidenceReference: ref('evidence-ref', wfdSha256('synthetic native evidence')),
      text, observations: [{ page: 1, text, confidence: 0.8, boundingBox: { x: 0.25, y: 0.125, width: 0.5, height: 0.25 } }],
      coordinateUnit: 'original_image_page_1_top_left_normalized', textBasis: 'ocr_recognition',
      reviewStatus: 'not_recorded', eventEligibility: 'not_established', packetSha256: '' };
    packet.packetSha256 = mediaPacketDigest(packet);
    const request = { materialId: source.materialId, taskId, packetSha256: packet.packetSha256 };
    const unbound = await settled(services.tasks, segments.requestOcrReview(request, 'no-reader').id);
    assert.equal(unbound.error?.code, 'SEGMENT_OCR_READER_UNAVAILABLE');
    // Explicit trusted reader double. This tests packet admission, not Vision recognition.
    let current = structuredClone(packet);
    segments.bindOcrReviewReader(async (m, t) => { assert.equal(m, source.materialId); assert.equal(t, taskId); return current; }, () => ({ available: false }));
    assert.throws(() => segments.bindOcrReviewReader(async () => null), /已绑定/u);
    assert.equal((segments.capabilities() as any).ocr.runnerAvailable, false);
    const queued = segments.requestOcrReview(request, 'native-packet');
    const ingested = await settled(services.tasks, queued.id); assert.equal(ingested.status, 'succeeded', JSON.stringify(ingested.error));
    assert.equal(segments.requestOcrReview(request, 'native-packet').id, queued.id);
    const indexVersion = (ingested.result!.data as any).indexVersion;
    const [citation] = segments.search({ indexVersion, method: 'exact', query: text }).citations; assert.ok(citation);
    assert.deepEqual(citation.bbox, { x0: 0.25, y0: 0.125, x1: 0.75, y1: 0.375, coordinate_unit: packet.coordinateUnit });
    assert.deepEqual(citation.issues, ['ocr_unverified_recognition']); assert.equal(citation.text_digest, packet.textReference.sha256);
    const input = { indexVersion, segmentId: citation.segment_id };
    const read = () => readRetrievalEvidence(services, input);
    const good = await read();
    for (const check of [good.cache, good.artifact, good.original]) assert.equal(check.status, 'verified');
    assert.equal(good.factVerification, 'not_established');
    current.text = 'changed'; assert.equal((await read()).artifact.status, 'mismatch');
    current = structuredClone(packet); assert.deepEqual(await read(), good);

    const path = join(services.artifactRoot, 'review-packet.json');
    writeFileSync(path, canonicalWfdJson(packet));
    const stored = services.files.register({ path, source: 'generated', artifactId: 'synthetic-packet' });
    const file = await settled(services.tasks, segments.requestArtifact({ materialId: source.materialId, artifactRef: stored.id, documentVersion: 'file-packet' }, 'file-packet').id);
    assert.equal(file.status, 'succeeded', JSON.stringify(file.error));
    const fileSegment = segments.segments(source.materialId, 'file-packet')[0]!;
    const fileInput = { indexVersion: (file.result!.data as any).indexVersion, segmentId: fileSegment.segment_id };
    const proof = await readRetrievalEvidence(services, fileInput);
    assert.equal(proof.artifact.status, 'verified'); assert.equal(proof.original.status, 'verified');
    current.textReference.sha256 = '0'.repeat(64);
    assert.equal((await readRetrievalEvidence(services, fileInput)).artifact.status, 'mismatch');
    current = structuredClone(packet);

    const selection = { documentId: source.materialId, documentVersion: '1', artifactRef: stored.id };
    for (const bad of [{ ...packet, coordinateUnit: 'pdf' }, { ...packet, reviewStatus: 'verified' },
      { ...packet, observations: [{ ...packet.observations[0]!, boundingBox: { x: 1, y: 0, width: 1, height: 1 } }] },
      { ...packet, textReference: ref('text-ref', wfdSha256('different')) }, { ...packet, observations: [] }]) {
      bad.packetSha256 = mediaPacketDigest(bad);
      assert.throws(() => segmentsFromConversionArtifact(bad, selection));
    }
    const forged = { ...packet, text: 'rewritten' }; forged.packetSha256 = mediaPacketDigest(forged);
    writeFileSync(join(services.artifactRoot, 'forged.json'), JSON.stringify(forged));
    const fileRef = services.files.register({ path: join(services.artifactRoot, 'forged.json'), source: 'generated' });
    const rejected = await settled(services.tasks, segments.requestArtifact({ materialId: source.materialId, artifactRef: fileRef.id }, 'forged').id);
    assert.equal(rejected.error?.code, 'SEGMENT_OCR_PACKET_MISMATCH'); assert.equal(segments.documents().length, 2);
    for (const envelope of [{ operation: 'conversion.structured' }, { content: { native: { format: 'xlsx' } } }])
      assert.throws(() => segmentsFromConversionArtifact(envelope, selection), /结构化表登记路线/u);
  } finally { await h.close(); }
});

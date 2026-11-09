import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversionEnvelope } from '../../../contracts/conversion.js';
import { segmentsFromConversionArtifact } from '../../../modules/collection/segments/from-conversion.js';
import { CONVERSION_IMPLEMENTATION, CONVERSION_SCHEMA_VERSION, PDF_TEXT_REPRESENTATION,
  conversionText, pdfPageText, storedConversionEnvelope } from './storage.js';

function envelope(): ConversionEnvelope {
  return { schemaVersion: CONVERSION_SCHEMA_VERSION, implementation: CONVERSION_IMPLEMENTATION,
    operation: 'conversion.document', source: { fileRefId: 'file-original', fileRefVersion: 1,
      sha256: 'a'.repeat(64), bytes: 100, declaredName: 'native.pdf', detectedType: 'pdf' },
    status: 'partial', issues: [{ code: 'PDF_TEXT_EXTRACT_FAILED', location: { page: 2 }, message: '未生成此页文字' }],
    text: ' 原文🙂e\u0301\n\n\f\f第二页\n',
    content: { format: 'pdf', pageCount: 3, implementation: { pdfjs: '6.4.299', normalization: 'disabled' }, pages: [
      { page: 1, pageLabel: null, width: 595, height: 842, text: ' 原文🙂e\u0301\n\n',
        coordinateSystem: 'PDF-user-space/origin-native/transform-retained', originalView: [0, 0, 595, 842],
        originalItems: [
          { index: 0, type: 'beginMarkedContent', id: 'm1' },
          { index: 1, str: ' 原文🙂e\u0301', transform: [1, 0, 0, 1, 72, 700], width: 20, height: 12, hasEOL: true },
          { index: 2, str: '', transform: [1, 0, 0, 1, 92, 700], width: 0, height: 0, hasEOL: true },
        ], styles: { font1: { fontFamily: 'serif' } }, links: [{ target: 'https://example.org/' }], tableCandidates: [] },
      { page: 2, pageLabel: 'ii', width: 595, height: 842, extraction: { status: 'failed', code: 'PDF_TEXT_EXTRACT_FAILED' },
        text: '', originalItems: [], tableCandidates: [] },
      { page: 3, pageLabel: '3', width: 595, height: 842, text: '第二页\n',
        originalItems: [{ index: 0, str: '第二页', transform: [1, 0, 0, 1, 70, 600], width: 36, height: 12, hasEOL: true }],
        tableCandidates: [] },
    ] } };
}

test('PDF 新持久结构只省略可无损重建的页文和全文，原项及定位逐项保留', () => {
  const original = envelope(), snapshot = structuredClone(original), stored = storedConversionEnvelope(original);
  const oldContent = original.content as any, newContent = stored.content as any;
  assert.equal(Object.hasOwn(stored, 'text'), false);
  assert.equal(newContent.textRepresentation, PDF_TEXT_REPRESENTATION);
  for (const [index, page] of newContent.pages.entries()) {
    const { text, ...rest } = oldContent.pages[index];
    assert.equal(Object.hasOwn(page, 'text'), false);
    assert.deepEqual(page, rest);
    assert.equal(pdfPageText(page), text);
  }
  assert.equal(conversionText(stored), original.text);
  assert.deepEqual(original, snapshot, '生成新持久视图不得修改转换器内存结果。');
  const ref = { artifactRef: 'artifact-1', documentId: 'material-1', documentVersion: '1' };
  assert.deepEqual(segmentsFromConversionArtifact(stored, ref), segmentsFromConversionArtifact(original, ref));
});

test('旧版全文与逐页 text 的读取和既有信封保持兼容，不自动迁为新格式', () => {
  const legacy = { ...envelope(), schemaVersion: '1.0' as const,
    implementation: { name: 'harness-native-conversion' as const, version: '1.0.0' as const } };
  const before = JSON.stringify(legacy);
  assert.equal(storedConversionEnvelope(legacy), legacy);
  assert.equal(conversionText(legacy), legacy.text);
  assert.equal(pdfPageText((legacy.content as any).pages[0]), ' 原文🙂e\u0301\n\n');
  assert.equal(JSON.stringify(legacy), before);
});

test('新表示必须先核对全文及每页原文；不一致时不能省略内容', () => {
  const pageMismatch = envelope();
  (pageMismatch.content as any).pages[0].text += 'extra';
  assert.throws(() => storedConversionEnvelope(pageMismatch), { code: 'PDF_TEXT_VIEW_MISMATCH' });
  assert.throws(() => storedConversionEnvelope({ ...envelope(), text: 'mismatch' }), { code: 'PDF_TEXT_VIEW_MISMATCH' });
  const missingItems = envelope(); delete (missingItems.content as any).pages[0].originalItems;
  assert.throws(() => storedConversionEnvelope(missingItems), { code: 'PDF_TEXT_VIEW_INVALID' });
});

test('未知表示和非 PDF 不猜全文；失败产物仍保留原缺口', () => {
  assert.equal(conversionText({ content: { format: 'pdf', textRepresentation: 'unknown/2', pages: [] } }), undefined);
  assert.equal(conversionText({ content: { format: 'text' } }), undefined);
  assert.throws(() => conversionText({ content: { format: 'pdf', textRepresentation: PDF_TEXT_REPRESENTATION } }),
    { code: 'PDF_TEXT_VIEW_INVALID' });
  const failed = { ...envelope(), status: 'failed' as const, text: undefined, content: { format: 'pdf' } };
  assert.equal(storedConversionEnvelope(failed), failed);
});

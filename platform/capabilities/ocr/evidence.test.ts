import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVisionEvidence, VISION_EVIDENCE_SCHEMA, VISION_LIMITS } from './evidence.js';
const fixture = () => ({ schema: VISION_EVIDENCE_SCHEMA, width: 400, height: 200, revision: 3, osVersion: 'synthetic macOS', languages: ['zh-Hans', 'en-US'], observations: [{ page: 1, text: '公告 TEST', confidence: 0.75, boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 } }] });
test('OCR evidence retains observations and exact text without asserting truth', () => {
  const input = fixture();
  assert.deepEqual(parseVisionEvidence(JSON.stringify(input), '公告 TEST'), input);
  const empty = { ...input, observations: [] };
  assert.deepEqual(parseVisionEvidence(JSON.stringify(empty), ''), empty);
});
test('OCR evidence rejects missing, extra or tampered fields and text', () => {
  const changes: ((v: any) => void)[] = [
    v => { delete v.revision; }, v => { v.verified = true; }, v => { v.schema = 'other'; },
    v => { v.languages.reverse(); }, v => { v.observations[0].page = 2; },
    v => { delete v.observations[0].confidence; }, v => { v.observations[0].text = 'changed'; },
    v => { v.observations[0].text = '\ud800'; }, v => { v.osVersion = ''; },
    v => { v.observations[0].boundingBox.extra = 1; },
  ];
  for (const change of changes) { const value = fixture(); change(value); assert.throws(() => parseVisionEvidence(JSON.stringify(value), '公告 TEST'), /OCR_EVIDENCE_INVALID/); }
  assert.throws(() => parseVisionEvidence(JSON.stringify(fixture()), '公告 TEST\n'));
  assert.throws(() => parseVisionEvidence('{', ''));
});
test('OCR evidence rejects nonfinite, out-of-bounds coordinates and resource overages', () => {
  const changes: ((v: any) => void)[] = [
    v => { v.observations[0].confidence = NaN; }, v => { v.observations[0].confidence = 1.1; },
    v => { v.observations[0].boundingBox.x = -0.1; }, v => { v.observations[0].boundingBox.width = 0; },
    v => { v.observations[0].boundingBox.x = 0.9; }, v => { v.observations[0].boundingBox.y = Infinity; },
    v => { v.width = 0.5; }, v => { v.width = VISION_LIMITS.side + 1; },
    v => { v.width = 10000; v.height = 10000; }, v => { v.revision = 0; },
    v => { v.observations = Array(VISION_LIMITS.observations + 1).fill(v.observations[0]); },
  ];
  for (const change of changes) { const value = fixture(); change(value); assert.throws(() => parseVisionEvidence(JSON.stringify(value), '公告 TEST')); }
  assert.throws(() => parseVisionEvidence(' '.repeat(VISION_LIMITS.jsonBytes + 1), ''));
  assert.throws(() => parseVisionEvidence(JSON.stringify(fixture()), 'x'.repeat(VISION_LIMITS.textBytes + 1)));
});

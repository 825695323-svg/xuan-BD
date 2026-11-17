import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaterialOcrAdapter } from '../../../modules/collection/materials/ocr-adapter.js';
import type { DirectRuntimeBundle } from '../../../contracts/direct-runtime.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';

// Only the bounded projection is stubbed here. Actual Vision inference is covered
// separately by the explicit opt-in integration test, never by this unit test.
test('OCR adapter bounds preview bytes without dropping full evidence references', async () => {
  const source = { materialId: 'synthetic', fileRefId: 'source', fileRefVersion: 1, sha256: 'a'.repeat(64) };
  const reference = { fileRefId: 'full-evidence', fileRefVersion: 1, sha256: 'b'.repeat(64) };
  const segment = (length: number) => ({ text: 'x'.repeat(length), location: { page: 1, region: { x: 0, y: 0, width: 1, height: 1 } } });
  const executor: DirectRuntimeBundle['localOcr'] = { availability: () => ({ available: true }), captureVersions: () => ({}),
    execute: async () => ({ source, textReference: reference, evidenceReference: reference,
      segments: [segment(50_000), segment(50_000)], backend: 'apple-vision-local' }) };
  const adapter = createMaterialOcrAdapter(() => executor);
  const outcome = await adapter.execute(source, { task: { action: 'material.ocr' } } as TaskExecutionContext);
  assert.equal(outcome.status, 'extracted');
  if (outcome.status !== 'extracted') throw Error();
  assert.equal(outcome.result.segments.length, 1); assert.equal(outcome.result.segmentCount, 2);
  assert.equal(outcome.result.segmentsTruncated, true); assert.deepEqual(outcome.result.evidenceReference, reference);
  assert.ok(Buffer.byteLength(JSON.stringify(outcome.result.segments)) < 80_000);
});

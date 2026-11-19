import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { candidateImplementationDigest } from './candidate-pipeline.js';
import { ProcessingPlanService } from './processing-plan.js';

// Read-byte perturbation only: no repository file changes, external calls or processing output claims.
function processingDigest() {
  const database = new CoreDatabase();
  try {
    return new ProcessingPlanService({ database, tasks: () => null as never, materials: {} as never,
      objects: { put: () => { throw new Error('unused'); }, get: () => { throw new Error('unused'); }, verify: () => false } }).versionBinding.implementation;
  } finally { database.close(); }
}
test('both candidate and processing bindings change when only HTML or event projection implementation bytes change', () => {
  const baseline = { candidate: candidateImplementationDigest(), processing: processingDigest() };
  const original = fs.readFileSync;
  for (const suffix of ['/browser/html-extraction.ts', '/data-processing/event-text.ts']) {
    let hits = 0;
    try {
      fs.readFileSync = ((...args: any[]) => {
        const result = (original as any)(...args);
        if (args[0] instanceof URL && args[0].pathname.endsWith(suffix)) {
          hits++; return Buffer.concat([result, Buffer.from('\n// synthetic digest-only perturbation')]);
        }
        return result;
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      assert.notEqual(candidateImplementationDigest(), baseline.candidate, suffix);
      assert.notEqual(processingDigest(), baseline.processing, suffix);
      assert.equal(hits, 2);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.equal(candidateImplementationDigest(), baseline.candidate);
    assert.equal(processingDigest(), baseline.processing);
  }
});


test('processing binding includes the trusted OCR packet reader and native evidence validation', () => {
  const baseline = processingDigest(), original = fs.readFileSync;
  for (const suffix of ['/data-processing/ocr-claim.ts', '/apps/server/ocr-review.ts', '/apps/server/media-review-source.ts', '/ocr/evidence.ts']) {
    let hits = 0;
    try {
      fs.readFileSync = ((...args: any[]) => {
        const result = (original as any)(...args);
        if (args[0] instanceof URL && args[0].pathname.endsWith(suffix)) {
          hits++; return Buffer.concat([result, Buffer.from('\n// synthetic reader binding perturbation')]);
        }
        return result;
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      assert.notEqual(processingDigest(), baseline, suffix); assert.equal(hits, 1);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.equal(processingDigest(), baseline);
  }
});

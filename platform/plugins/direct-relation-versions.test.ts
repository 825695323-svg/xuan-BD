import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { directImplementationVersion } from './direct-versions.js';

function changeReadBytes(path: string, check: () => void) {
  const read = fs.readFileSync;
  let matched = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const original = read(...args);
    if (!String(args[0]).replaceAll('\\', '/').endsWith(path)) return original;
    matched++;
    return typeof original === 'string' ? original + '\n' : Buffer.concat([original, Buffer.from('\n')]);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { check(); assert.ok(matched > 0, path); }
  finally { fs.readFileSync = read; syncBuiltinESMExports(); }
}

test('Direct R1 implementation binding rejects changed relation, OCR claim/provenance code and existing identity schema', () => {
  const baseline = directImplementationVersion(['r1']);
  for (const suffix of ['modules/collection/r1-relation.ts', 'wfd/product/protocol/schemas/wfd-common.schema.json',
    'modules/collection/data-processing/ocr-claim.ts', 'apps/server/ocr-review.ts', 'apps/server/media-review-source.ts', 'platform/capabilities/ocr/evidence.ts', 'apps/server/transcription-review.ts', 'platform/capabilities/transcription/local.ts']) {
    changeReadBytes(suffix, () => assert.throws(() => directImplementationVersion(['r1']), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' }));
    assert.equal(directImplementationVersion(['r1']), baseline);
  }
});

test('controlled media, retrieval and Baidu consumers freeze their shared implementations', () => {
  for (const [dependency, affected, independent] of [
    ['platform/capabilities/transcription/probe.ts', ['transcription', 'r1'], ['retrieval']],
    ['modules/collection/segments/from-office.ts', ['retrieval'], ['algorithmRead']],
    ['apps/server/retrieval-evidence.ts', ['retrieval'], ['algorithms']],
    ['plugins/capture-sources/baidu-drive/contract.ts', ['baidu', 'material', 'artifactManifest'], ['retrieval']],
  ] as const) {
    changeReadBytes(dependency, () => {
      for (const group of affected) assert.throws(() => directImplementationVersion([group]), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' });
      assert.doesNotThrow(() => directImplementationVersion(independent));
    });
    for (const group of affected) assert.doesNotThrow(() => directImplementationVersion([group]));
  }
});

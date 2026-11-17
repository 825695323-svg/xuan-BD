import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { directImplementationVersion } from './direct-versions.js';

test('Direct R1 implementation binding rejects changed relation code and its existing identity schema', () => {
  const baseline = directImplementationVersion(['r1']), read = fs.readFileSync;
  for (const suffix of ['modules/collection/r1-relation.ts', 'wfd/product/protocol/schemas/wfd-common.schema.json']) {
    let matched = 0;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const original = read(...args);
      if (!String(args[0]).replaceAll('\\', '/').endsWith(suffix)) return original;
      matched++;
      return typeof original === 'string' ? original + '\n' : Buffer.concat([original, Buffer.from('\n')]);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try { assert.throws(() => directImplementationVersion(['r1']), { code: 'DIRECT_DEPENDENCY_UNAVAILABLE' }); assert.ok(matched > 0); }
    finally { fs.readFileSync = read; syncBuiltinESMExports(); }
    assert.equal(directImplementationVersion(['r1']), baseline);
  }
});

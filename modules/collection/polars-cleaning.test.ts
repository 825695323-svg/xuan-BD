import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { createFullChainFixture } from '../../apps/server/full-chain-test-support.js';
import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { cleanCandidateTable, parseTableSource, structureCandidateTable } from './candidate-pipeline.js';
import { PolarsSourceCleaner } from './data-processing/polars-cleaning.js';

const python = process.env.POLARS_PYTHON;
const enabled = !!python && !!process.env.XUAN_FULL_CHAIN_ROOT;
const csv = Buffer.from('symbol,value,other\n alpha , 10 ,x\nbeta,,2\n gamma ,0,3\n');

test('independent Polars cleaner executes strict declared columns and returns identical original cell evidence',
  { skip: !enabled ? 'Requires explicitly registered POLARS_PYTHON and isolated runtime.' : false,
    timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'source-polars-clean', machine: false });
    try {
      const binding = join(fixture.runtime, 'config/machine.bindings.json');
      const configuration = JSON.parse(readFileSync(binding, 'utf8'));
      configuration.resources.polars_python = { kind: 'program', path: realpathSync(python!) };
      configuration.revision++;
      writeFileSync(binding, JSON.stringify(configuration, null, 2));
      const cleaner = new PolarsSourceCleaner(new ProcessRuntime(new ResourceBindings(fixture.runtime)));
      assert.equal(cleaner.capabilities().status, 'ready');
      const parsed = parseTableSource(csv, { materialId: 'material-clean', format: 'csv' });
      const rules = { trim: ['symbol', 'value'], emptyToNull: ['value'] };
      const expected = cleanCandidateTable(parsed, rules);
      const receipts: unknown[] = [];
      const context = { signal: new AbortController().signal, task: { args: { step: 'clean' } },
        assertAuthorized: () => {}, emit: async (item: unknown) => { receipts.push(item); } } as unknown as TaskExecutionContext;
      const actual = await cleaner.clean(context, parsed, rules);
      assert.equal(canonicalWfdJson(actual.cleaned), canonicalWfdJson(expected));
      assert.equal(actual.evidence.engine, 'polars');
      assert.equal(actual.evidence.strictConversion, true);
      assert.equal(actual.evidence.fallback, false);
      assert.equal(actual.cleaned.rows[1]?.[1]?.value, null, 'declared emptyToNull only');
      assert.equal(actual.cleaned.rows[0]?.[0]?.original, ' alpha ', 'source text is unchanged');
      assert.ok(receipts.some(value => (value as { type?: string }).type === 'checkpoint'));
      await assert.rejects(cleaner.clean(context, parsed, { trim: ['missing_field'], emptyToNull: [] }),
        (error: unknown) => (error as { code?: string }).code === 'POLARS_CLEAN_RULES');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });


test('strict Polars declared schema conversion preserves exact decimals and rejects damaged values',
  { skip: !enabled ? 'Requires pinned Polars and isolated executor' : false, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'strict-polars-structure', machine: false });
    try {
      const binding = join(fixture.runtime, 'config/machine.bindings.json');
      const configuration = JSON.parse(readFileSync(binding, 'utf8'));
      configuration.resources.polars_python = { kind: 'program', path: realpathSync(python!) };
      configuration.revision++;
      writeFileSync(binding, JSON.stringify(configuration, null, 2));
      const cleaner = new PolarsSourceCleaner(new ProcessRuntime(new ResourceBindings(fixture.runtime)));
      assert.equal(cleaner.capabilities().status, 'ready');
      const context = { signal: new AbortController().signal, task: { args: { step: 'structure' } },
        assertAuthorized: () => {}, emit: async () => {} } as unknown as TaskExecutionContext;
      const types = { n: 'safe_integer' as const, v: 'decimal_string' as const,
        b: 'boolean' as const, f: 'binary64_hex' as const };
      const parsed = parseTableSource(Buffer.from(
        'n,v,b,f\n9007199254740991,123456789012345678901234567890.000010000,true,1.25\n-2,0.00000000000000001234,false,-5.5\n',
      ), { materialId: 'isolated-structure', format: 'csv', types });
      const projected = await cleaner.structure(context, parsed, types);
      const expected = structureCandidateTable(parsed, types);
      assert.equal(canonicalWfdJson(projected.structured), canonicalWfdJson(expected));
      assert.equal(projected.structured.rows[0]?.[0]?.value, 9007199254740991);
      assert.equal(projected.structured.rows[0]?.[1]?.value, '123456789012345678901234567890.00001');
      assert.equal(projected.structured.rows[0]?.[2]?.value, true);
      assert.equal(projected.structured.rows[0]?.[3]?.value, '3ff4000000000000');
      assert.equal(projected.evidence.strictConversion, true);
      assert.equal(projected.evidence.silentNullFallback, false);
      assert.equal(projected.structured.rows[0]?.[1]?.original, '123456789012345678901234567890.000010000');
      const bad = parseTableSource(Buffer.from('n,v,b,f\n1,oops,true,3\n'),
        { materialId: 'isolated-invalid', format: 'csv', types });
      await assert.rejects(cleaner.structure(context, bad, types),
        (error: unknown) => typeof (error as {code?: string}).code === 'string');
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

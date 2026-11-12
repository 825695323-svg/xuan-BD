import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { createFullChainFixture } from '../../apps/server/full-chain-test-support.js';
import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { cleanCandidateTable, parseTableSource } from './candidate-pipeline.js';
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

test('根对象转换信封保持 needs_adapter；带 BOM 的根行数组仍可进入现有 JSON 表解析',
  { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires a dedicated isolated output root.' : false }, async () => {
    const fixture = createFullChainFixture({ name: 'xlsx-view-qualification' });
    const host = await openFullChainHost(fixture);
    try {
      const largeRows = Buffer.from('\ufeff \r\n' + JSON.stringify(Array.from({ length: 40_000 }, (_, index) => ({ a: String(index), value: 'x'.repeat(50) }))));
      assert.ok(largeRows.byteLength > 2 * 1024 * 1024 && largeRows.byteLength < 64 * 1024 * 1024);
      const cases = [
        { name: 'conversion.json', request: 'conversion-envelope', bytes: Buffer.from(JSON.stringify({ schemaVersion: '1.0',
          implementation: { name: 'harness-native-conversion', version: '1.0.0' }, operation: 'conversion.structured',
          source: { detectedType: 'xlsx' }, status: 'complete', content: { native: { format: 'xlsx', sheets: [] } } })),
          routing: 'needs_adapter', formatGap: 'json-document', applicable: 'unknown' },
        { name: 'rows.json', request: 'json-row-array', bytes: largeRows,
          routing: 'needs_classification', formatGap: null, applicable: 'applicable' },
      ] as const;
      for (const sample of cases) {
        const uploaded = await host.upload(sample.name, 'data', sample.bytes, sample.request + '-upload');
        const intake = await host.settled(uploaded.jobId);
        assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
        const material = host.services.materials!.getByTask(intake.id)!;
        const materialId = material.envelope.materialId;
        if (sample.request === 'json-row-array') assert.equal(material.preview.checks.status, 'blocked', 'Large row array exceeds only the small preview budget.');
        const routed = await host.call('/processing/route', { requestId: sample.request + '-route', input: { materialId, intendedAction: 'inspect' } }, 202);
        assert.equal((await host.settled(routed.jobId)).status, 'succeeded');
        const decision = host.services.processing!.getDecision(materialId)!.material!;
        assert.equal(decision.routingState, sample.routing);
        const planned = await host.call('/processing/plans', { requestId: sample.request + '-plan', input: {
          routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
          outputs: [{ outputId: sample.request, materialIds: [materialId], intendedAction: 'inspect',
            tables: [{ materialId, format: 'json' }] }],
        } }, 202);
        const planTask = await host.settled(planned.jobId);
        assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
        const planId = host.services.processing!.getByTask(planTask.id)!.plan!.planId;
        const plan = host.services.processing!.get(planId), parse = plan.steps.find(step => step.kind === 'parse')!;
        assert.equal(parse.applicability, sample.applicable);
        if (sample.formatGap) assert.ok(parse.gaps.some(gap => gap.includes(sample.formatGap!)));
        else assert.deepEqual(parse.gaps, []);
        assert.notEqual(plan.outputs[0]!.publishEligible, true);
      }
    } finally { await host.close(); }
  });

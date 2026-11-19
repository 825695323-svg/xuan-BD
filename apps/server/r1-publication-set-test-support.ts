import assert from 'node:assert/strict';
import type { R1PrepareInput } from '../../contracts/r1-contracts.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import type { openFullChainHost } from './full-chain-test-support.js';
export function recipe(outputId: string): Omit<R1PrepareInput, 'requestId' | 'planId'> {
  return { outputId, source: { source_id: 'review-fixture', provider: 'synthetic-test', requested_url: 'test:review-fixture',
    requested_at_utc: '2026-01-06T09:00:00Z', acquired_at_utc: '2026-01-06T09:00:01Z', usage_scope: 'isolated-test',
    authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } },
    mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
      precision: 'day', sourceTimezone: 'Asia/Shanghai',
      fields: ['open','high','low','close','volume','amount'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' })),
      bar: { frequency: 'day', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume', amount: 'amount' } },
    target: { datasetId: 'r1_review_test', outputKey: 'review.' + outputId, expectedParentSnapshotId: null,
      subject: { kind: 'instrument', namespace: 'r1.review.test', id: outputId }, inputMode: 'partial_observation',
      coverage: { scope: { synthetic_sample: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'review.' + outputId, measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: 'r1.review.test', time_role: 'observation',
        field_definitions: ['open','high','low','close','volume','amount'].map((field_code, index) => ({ field_code, data_type: 'decimal',
          unit_code: index < 4 ? 'cny_per_share' : index === 4 ? 'share' : 'cny', measurement_nature: index < 4 ? 'stock' : 'flow', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'Asia/Shanghai' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' }, financial: { price_adjustment: { direction: 'raw' } } },
        field_semantic_context: { volume: { measurement: { aggregation: 'period_total' } }, amount: { measurement: { aggregation: 'period_total' } } } } } };
}

/** Fresh synthetic inputs, real host processing, no fabricated WFD records or receipts. */
export async function preparedSetPlan(host: Awaited<ReturnType<typeof openFullChainHost>>, prefix: string,
  options: { badMember?: boolean; unknownUnit?: boolean; setId?: string; thirdOutput?: boolean; expectedCommitId?: string } = {}) {
  const materials: { outputId: string; materialId: string }[] = [];
  for (const outputId of (options.thirdOutput ? ['left', 'right', 'other'] : ['left', 'right'])) {
    const raw = Buffer.from('key,start,end,open,high,low,close,volume,amount,state\n'
      + `${prefix}-${outputId},2026-01-04T16:00:00Z,2026-01-05T16:00:00Z,11.42,${options.badMember && outputId === 'right' ? '10' : '11.51'},11.41,11.50,100,1145,valid_value\n`);
    const uploaded = await host.upload(outputId + '.csv', 'data', raw, prefix + '-upload-' + outputId);
    const task = await host.settled(uploaded.jobId);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    materials.push({ outputId, materialId: host.services.materials!.getByTask(task.id)!.envelope.materialId });
  }
  const facts = { role: 'financial-record', informationNature: 'direct-observation', businessObject: 'market_bars',
    objectTime: 'synthetic set objects; explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
  const drafts = materials.map(({ outputId }) => {
    const draft = recipe(outputId);
    if (options.expectedCommitId !== undefined) draft.target.expectedCommitId = options.expectedCommitId;
    draft.source.source_id = prefix + '-' + outputId;
    if (options.unknownUnit && outputId === 'left') {
      const fields = draft.target.definition.field_definitions as { field_code: string; unit_code: string }[];
      for (const field of fields.filter(field => ['open','high','low','close'].includes(field.field_code)))
        field.unit_code = 'synthetic_unregistered_currency';
    }
    return draft;
  });
  const input = { consistencyGroups: { [options.setId ?? 'pair']: ['left','right'] },
    routing: { materials: materials.map((item, index) => ({ materialId: item.materialId, intendedAction: 'publish',
      dimensions: Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
        evidence: [{ source: 'operator', field: `routing.materials.${index}.dimensions.${key}`, quote: facts[key] }] }])) })) },
    outputs: materials.map(({ outputId, materialId }, index) => {
      const draft = drafts[index]!;
      return { outputId, materialIds: [materialId], intendedAction: 'publish', stages: ['parse','structure','check'],
        tables: [{ materialId, format: 'csv', types: Object.fromEntries(['open','high','low','close','volume','amount'].map(key => [key,'decimal_string'])) }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping, source: draft.source }, expectedSnapshotId: null } };
    }) };
  const prepared = await host.call('/processing/plans', { requestId: prefix + '-plan', input }, 202);
  const done = await host.settled(prepared.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const planId = host.services.processing!.getByTask(done.id)!.plan!.planId;
  for (const { outputId } of materials) for (const kind of ['parse','structure','check']) {
    const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
    const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `${prefix}-${outputId}-${kind}` }, 202);
    const result = await host.settled(accepted.jobId);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  }
  return { planId, drafts, materials, input };
}

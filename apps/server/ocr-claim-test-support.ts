import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OCR_CLAIM_FIELDS } from '../../modules/collection/data-processing/ocr-claim.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import type { ApplicationServices } from './services.js';

/** All declarations are explicit synthetic fixture choices, not a real user's media/publication approval. */
export async function prepareSyntheticOcrClaim(base: string, services: ApplicationServices, packet: any, options: { kind: 'ocr' | 'transcription'; segmentIndex?: number } = { kind: 'ocr' }) {
  const media = options.kind, transcription = media === 'transcription';
  const call = async (path: string, body?: unknown, status = body === undefined ? 200 : 202): Promise<any> => {
    const response = await fetch((base.endsWith('/api/bd') ? base : base + '/api/bd') + path, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const settled = async (taskId: string) => {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      const task = services.tasks.get(taskId);
      if (['succeeded', 'failed', 'needs_review', 'cancelled', 'paused', 'waiting_approval', 'blocked', 'interrupted'].includes(task.status)) return task;
      await delay(10);
    }
    throw new Error(`Synthetic ${media} claim task did not settle`);
  };
  const selection = { taskId: packet.taskId, packetSha256: packet.packetSha256, sourceSha256: packet.source.sha256,
    ...(transcription ? { segmentIndex: options.segmentIndex ?? 0 } : { observationIndex: 0 }), eventId: 'synthetic-recognized-claim', eventType: 'synthetic_announcement' };
  const source = { source_id: transcription ? 'synthetic-audio' : 'synthetic-image', provider: 'isolated-generated-fixture', requested_url: transcription ? 'https://fixture.example.test/synthetic.wav' : 'https://fixture.example.test/synthetic.png',
    requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:01Z', usage_scope: `Synthetic ${media} claim test only`,
    authorization: { status: 'authorized', basis: transcription ? 'Synthetic audio in an isolated runtime, not a supplier claim.' : 'Self-drawn synthetic image in an isolated runtime, not a supplier claim.' } };
  const target = { datasetId: `synthetic_${media}_claim`, outputKey: `${media}.claim`, expectedParentSnapshotId: null,
    subject: { kind: 'entity', namespace: 'full.chain.test', id: transcription ? 'synthetic_audio_statement' : 'synthetic_image_statement' }, inputMode: 'partial_observation',
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    definition: { semantic_code: `synthetic.${media}.recognition.claim`, measurement_nature: 'event', unit_code: 'not_applicable',
      definition_authority: 'full.chain.test', time_role: 'event', semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
      field_definitions: OCR_CLAIM_FIELDS.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' })) } };
  const mapping = { kind: 'event_records', eventId: 'event_id', eventType: 'event_type', assertionKind: 'assertion_kind', contentNature: 'source_claim', status: 'unknown',
    eventTime: { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: { status: 'unknown', sourceTimezone: 'UTC' },
    fields: OCR_CLAIM_FIELDS.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'value_state' })) };
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Synthetic recognition output claim only, no fact verification or public-time assertion.' }] }]));
  const request = { requestId: `synthetic-${media}-plan`, input: { routing: { materials: [{ materialId: packet.source.materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: 'claim', materialIds: [packet.source.materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'check'],
      tables: [{ materialId: packet.source.materialId, format: `${media}-review`, ...(transcription ? { transcriptionClaimSelection: selection } : { ocrClaimSelection: selection }) }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: null } }] } };
  const planTask = await call('/processing/plans', request);
  const planned = await settled(planTask.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const step = services.processing!.get(planId).steps.find(item => item.kind === kind)!;
    const started = await call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: media + '-claim-' + kind });
    const task = await settled(started.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  }
  return { call, settled, input: { requestId: `synthetic-${media}-publish`, planId, outputId: 'claim', source, target, mapping }, request, selection };
}

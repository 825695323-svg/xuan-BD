import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { TaskRecord } from '../../platform/jobs/tasks.js';
import { ProcessingPlanService, type OperatorContext, type ProcessingPlanInput } from './processing-plan.js';

// Actual request acceptance/SQLite and normalization; only task scheduling and original custody are doubles.
// The HTTP integration separately covers real upload, task execution, reopening and revision.
function fixture() {
  const database = new CoreDatabase(), records = new Map<string, TaskRecord>();
  let bytes = Buffer.from('name,value\nsynthetic,1.25\n');
  const tasks = { getControl: () => ({ stopped: false }), get: (id: string) => records.get(id)!,
    createInTransaction: () => {
      const task = { id: `synthetic-task-${records.size}`, version: 1 } as TaskRecord;
      records.set(task.id, task); return { task, publish: () => {} };
    }, start: (id: string) => records.get(id)! };
  const processing = new ProcessingPlanService({ database, tasks: () => tasks as never,
    materials: { get: () => ({ envelope: { filename: 'synthetic.csv', sha256: wfdSha256(bytes), byteLength: bytes.length,
      mediaType: 'text/csv' }, preview: { format: 'csv', support: 'supported' } }),
    readOriginal: () => ({ bytes, sha256: wfdSha256(bytes) }) } as never,
    objects: { put: () => { throw new Error('Request acceptance must not create processing artifacts'); },
      get: () => { throw new Error('Request acceptance must not read processing artifacts'); }, verify: () => false } });
  const operator: OperatorContext = { operatorId: 'synthetic-operator', requestId: 'synthetic-request', method: 'POST',
    path: '/api/bd/processing/plans', remoteAddress: '127.0.0.1', observedAt: Date.parse('2026-01-01T00:00:00Z') };
  const input: ProcessingPlanInput = { routing: { materials: [{ materialId: 'synthetic-material' }] },
    outputs: [{ outputId: 'synthetic-output', materialIds: ['synthetic-material'], stages: ['parse'],
      tables: [{ materialId: 'synthetic-material', format: 'csv', types: { value: 'decimal_string' } }] }] };
  return { database, processing, operator, input, records, changeOriginal: () => { bytes = Buffer.from('name,value\nsynthetic,2.5\n'); } };
}
const conflict = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'REQUEST_CONFLICT';

test('same plan request at a later HTTP arrival reuses the original task and frozen purpose evidence', () => {
  const f = fixture();
  try {
    const original = f.processing.preparePlan(f.input, f.operator);
    const before = f.database.connection.prepare('SELECT * FROM processing_requests').get()!;
    const retry = f.processing.preparePlan(structuredClone(f.input), { ...f.operator, observedAt: f.operator.observedAt + 5000 });
    assert.equal(retry.id, original.id); assert.equal(f.records.size, 1);
    assert.deepEqual(f.database.connection.prepare('SELECT * FROM processing_requests').get(), before);
    const frozen = JSON.parse(String(before.input_json));
    assert.equal(frozen.outputs[0].usage.purposeEvidence[0].observedAtUtc, '2026-01-01T00:00:00Z');
    assert.equal(frozen.operator.observedAt, f.operator.observedAt);
  } finally { f.database.close(); }
});

test('request replay still rejects original, rules, declarations, dimensions and operator changes', () => {
  const variations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.input.outputs[0]!.tables![0]!.types = { value: 'string' }; },
    f => { f.input.outputs[0]!.target = { productRef: { product_id: 'synthetic-other' } }; },
    f => { f.input.routing.materials[0]!.dimensions = { role: { status: 'unknown', gap: 'Changed synthetic evidence requirement' } }; },
    f => { f.operator.operatorId = 'other-synthetic-operator'; },
    f => { f.operator.path = '/api/bd/other'; },
    f => { f.changeOriginal(); },
  ];
  for (const change of variations) {
    const f = fixture();
    try {
      f.processing.preparePlan(f.input, f.operator); change(f);
      assert.throws(() => f.processing.preparePlan(f.input, { ...f.operator, observedAt: f.operator.observedAt + 5000 }), conflict);
      assert.equal(f.records.size, 1);
    } finally { f.database.close(); }
  }
});

test('conversation replay checks the current trusted message verifier and branch', () => {
  const f = fixture();
  try {
    let verified = true;
    f.operator = { ...f.operator, source: 'conversation', method: 'conversation',
      conversation: { conversationId: 'synthetic-conversation', branchId: 'synthetic-branch', verifyUserMessage: () => verified } };
    f.input.outputs[0]!.usage = { purpose: 'current_compute', messageId: 'synthetic-message', quote: 'Inspect this synthetic original.' };
    const original = f.processing.preparePlan(f.input, f.operator);
    assert.equal(f.processing.preparePlan(f.input, { ...f.operator, observedAt: f.operator.observedAt + 5000 }).id, original.id);
    assert.throws(() => f.processing.preparePlan(f.input, { ...f.operator,
      conversation: { ...f.operator.conversation!, branchId: 'other-branch' } }), conflict);
    verified = false;
    assert.throws(() => f.processing.preparePlan(f.input, { ...f.operator, observedAt: f.operator.observedAt + 5000 }),
      (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'PROCESSING_USAGE_EVIDENCE');
  } finally { f.database.close(); }
});

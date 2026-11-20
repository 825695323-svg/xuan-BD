import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { TaskExecutionContext, TaskRecord } from '../../platform/jobs/tasks.js';
import { FINANCIAL_PDF_VERSION, type FinancialPdfSelection } from './data-processing/financial-pdf.js';
import { ProcessingPlanService, type OperatorContext, type ProcessingPlanInput } from './processing-plan.js';

// Actual request acceptance/SQLite and normalization; only task scheduling and original custody are doubles.
// The HTTP integration separately covers real upload, task execution, reopening and revision.
function fixture(runSteps = false) {
  const database = new CoreDatabase(), records = new Map<string, TaskRecord>();
  const objects = new Map<string, Buffer>();
  let bytes = Buffer.from('name,value\nsynthetic,1.25\n');
  const tasks = { getControl: () => ({ stopped: false }), get: (id: string) => records.get(id)!, isRunActive: () => true,
    createInTransaction: (input: Partial<TaskRecord>) => {
      const task = { ...input, id: `synthetic-task-${records.size}`, version: 1, currentAttemptId: 'synthetic-attempt' } as TaskRecord;
      records.set(task.id, task); return { task, publish: () => {} };
    }, start: (id: string) => records.get(id)! };
  const processing = new ProcessingPlanService({ database, tasks: () => tasks as never,
    materials: { get: () => ({ envelope: { filename: 'synthetic.csv', sha256: wfdSha256(bytes), byteLength: bytes.length,
      mediaType: 'text/csv' }, preview: { format: 'csv', support: 'supported' } }),
    readOriginal: () => ({ bytes, sha256: wfdSha256(bytes) }) } as never,
    objects: { put: (value, media_type) => {
      assert.ok(runSteps, 'Request acceptance must not create processing artifacts');
      const sha256 = wfdSha256(value);
      objects.set(sha256, Buffer.from(value));
      return { kind: 'stored-object', sha256, media_type, byte_length: value.length };
    }, get: ref => objects.get(ref.sha256)!, verify: ref => objects.get(ref.sha256)?.length === ref.byte_length } });
  const operator: OperatorContext = { operatorId: 'synthetic-operator', requestId: 'synthetic-request', method: 'POST',
    path: '/api/bd/processing/plans', remoteAddress: '127.0.0.1', observedAt: Date.parse('2026-01-01T00:00:00Z') };
  const input: ProcessingPlanInput = { routing: { materials: [{ materialId: 'synthetic-material' }] },
    outputs: [{ outputId: 'synthetic-output', materialIds: ['synthetic-material'], stages: ['parse'],
      tables: [{ materialId: 'synthetic-material', format: 'csv', types: { value: 'decimal_string' } }] }] };
  const execute = (task: TaskRecord) => processing.runtime.execute({ task, runId: task.id, attemptId: 'synthetic-attempt',
    generation: 0, signal: new AbortController().signal, emit: async () => {}, consumeBudget: () => ({}) } as unknown as TaskExecutionContext);
  return { database, processing, operator, input, records, execute, changeOriginal: () => { bytes = Buffer.from('name,value\nsynthetic,2.5\n'); } };
}
const conflict = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'REQUEST_CONFLICT';

test('new PDF plans refuse unverified continuations and lossy conversions on the mapped value column', () => {
  const f = fixture();
  try {
    const numericFormat = { decimal: '.', grouping: ',', negative: 'minus', plus: false, percent: 'as_reported' } as const;
    const pdfSelection: FinancialPdfSelection = {
      version: FINANCIAL_PDF_VERSION, sourceSha256: 'a'.repeat(64),
      report: { id: 'synthetic-report', version: 'v1', subjectScheme: 'fixture', subjectCode: 'synthetic-company',
        accountingStandard: 'CAS', currency: 'CNY', auditStatus: 'audited' },
      regions: [{ page: 1, yMin: 100, yMax: 200, statement: 'income_statement', scope: 'consolidated', section: 'main',
        label: [0, 100], expectedLabels: ['Revenue'], rowBands: [{ yMin: 150, yMax: 165 }],
        columns: [{ xMin: 100, xMax: 180, dimension: 'current', periodType: 'duration', startDate: '2025-01-01',
          endDate: '2025-06-30', unit: 'percent', numericFormat }],
        continuations: [{ rowIndex: 0, columnIndex: 0, page: 2, yMin: 150, yMax: 165, xMin: 100, xMax: 180, quote: '.50%' }] }],
    };
    const table = { materialId: 'synthetic-material', format: 'pdf' as const, pdfSelection };
    f.input.outputs[0]!.tables = [table];
    assert.throws(() => f.processing.preparePlan(f.input, f.operator), { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
    delete pdfSelection.regions[0]!.continuations;
    f.input.outputs[0]!.tables = [{ ...table, fieldMapping: { value: 'raw_value' }, types: { raw_value: 'decimal_string' },
      numericFormats: { raw_value: { ...numericFormat, percent: 'fraction' } } }];
    assert.throws(() => f.processing.preparePlan(f.input, f.operator), { code: 'FINANCIAL_L1_TEMPLATE' });
    const column = pdfSelection.regions[0]!.columns[0]!;
    column.unit = 'ratio';
    column.numericFormat = { ...numericFormat, percent: 'reject' };
    for (const type of ['safe_integer', 'decimal_string'] as const) {
      f.input.outputs[0]!.tables = [{ ...table, fieldMapping: { value: 'raw_value' }, types: { raw_value: type } }];
      assert.throws(() => f.processing.preparePlan(f.input, f.operator), { code: 'FINANCIAL_L1_TEMPLATE' });
    }
    assert.equal(f.records.size, 0);
  } finally { f.database.close(); }
});

test('plan requests validate and execute dictionary-only annotation with persisted field dependencies', async () => {
  const f = fixture(true);
  try {
    const output = f.input.outputs[0]!, table = output.tables![0]!;
    output.stages = ['parse', 'structure', 'annotate', 'check'];
    table.fieldMapping = { name: 'raw_name' };
    const mapping = { sourceColumn: 'raw_name', dictionaryId: 'synthetic-terms', version: '1', entries: { synthetic: 'S' } };
    for (const invalid of [null, { ...mapping, entries: { synthetic: [] } }, { ...mapping, unmappedPolicy: 'ignore' }, { ...mapping, extra: true }]) {
      const request = structuredClone(f.input);
      Object.assign(request.outputs[0]!.tables![0]!, { dictionaryMappings: { code: invalid } });
      assert.throws(() => f.processing.preparePlan(request, f.operator), { code: 'CANDIDATE_DICTIONARY_MAPPING' });
    }
    table.dictionaryMappings = { code: mapping };
    await f.execute(f.processing.preparePlan(f.input, f.operator));
    const plan = f.processing.findByRequest(f.operator.requestId)!.plan!;
    assert.equal(plan.steps.find(step => step.kind === 'annotate')?.applicability, 'applicable');
    for (const step of plan.steps) await f.execute(f.processing.executeStep(plan.planId, step.stepId,
      { ...f.operator, requestId: `synthetic-${step.kind}` }));
    const checked = f.processing.outputArtifact(plan.planId, output.outputId);
    assert.deepEqual(JSON.parse(checked.bytes.toString()).rows, [{ raw_name: 'synthetic', value: '1.25', code: 'S' }]);
    const edge = f.processing.fieldDependencies(plan.planId, output.outputId).dependencies.find(item => item.outputField === 'code');
    assert.equal(edge?.inputField, 'name');
    assert.equal(edge?.kind, 'dictionary_mapping');
    assert.equal(edge?.dictionaryId, 'synthetic-terms');
    assert.equal(edge?.dictionaryVersion, '1');
  } finally { f.database.close(); }
});

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

test('request replay digests observedAt keys in dictionaries and annotations as business input', () => {
  const f = fixture();
  try {
    const table = f.input.outputs[0]!.tables![0]!;
    table.dictionaryMappings = { code: { sourceColumn: 'name', dictionaryId: 'synthetic-terms', version: '1',
      entries: { synthetic: 'S', observedAt: 'original dictionary value' } } };
    table.annotations = { observedAt: 'original annotation' };
    const original = f.processing.preparePlan(f.input, f.operator);
    const retryOperator = { ...f.operator, observedAt: f.operator.observedAt + 5000 };
    assert.equal(f.processing.preparePlan(structuredClone(f.input), retryOperator).id, original.id);
    const changed = structuredClone(f.input), changedTable = changed.outputs[0]!.tables![0]!;
    changedTable.dictionaryMappings!.code!.entries.observedAt = 'changed dictionary value';
    assert.throws(() => f.processing.preparePlan(changed, retryOperator), conflict);
    delete changedTable.dictionaryMappings!.code!.entries.observedAt;
    assert.throws(() => f.processing.preparePlan(changed, retryOperator), conflict);
    changedTable.dictionaryMappings = table.dictionaryMappings;
    changedTable.annotations!.observedAt = 'changed annotation';
    assert.throws(() => f.processing.preparePlan(changed, retryOperator), conflict);
    assert.equal(f.records.size, 1);
  } finally { f.database.close(); }
});

test('request replay uses stored business keys even when a historical digest omitted them', () => {
  const f = fixture();
  try {
    const table = f.input.outputs[0]!.tables![0]!;
    table.dictionaryMappings = { code: { sourceColumn: 'name', dictionaryId: 'synthetic-terms', version: '1', entries: { synthetic: 'S' } } };
    const original = f.processing.preparePlan(f.input, f.operator);
    const stored = f.database.connection.prepare('SELECT input_json FROM processing_requests').get()!;
    const historical = JSON.parse(String(stored.input_json));
    historical.outputs[0].tables[0].dictionaryMappings.code.entries.observedAt = 'frozen dictionary value';
    f.database.connection.prepare('UPDATE processing_requests SET input_json=?').run(JSON.stringify(historical));
    assert.throws(() => f.processing.preparePlan(f.input, f.operator), conflict);
    table.dictionaryMappings.code!.entries.observedAt = 'frozen dictionary value';
    assert.equal(f.processing.preparePlan(f.input, f.operator).id, original.id);
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

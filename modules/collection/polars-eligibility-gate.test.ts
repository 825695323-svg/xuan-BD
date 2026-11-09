import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { TaskRuntimeRegistry, TaskService, type TaskRecord } from '../../platform/jobs/tasks.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { POLARS_FIXED_RUNTIME, PolarsFixedService } from './polars-fixed-service.js';
import { PURPOSE_ELIGIBILITY_RULE_VERSION, evaluatePurposeEligibility, type PurposeEligibilityResult } from './purpose-eligibility.js';

const candidateRows: WfdRecord[] = [{ business_key: 'macro-current', start_utc: '2026-01-01T00:00:00Z',
  end_utc: '2026-02-01T00:00:00Z', value: '12.34567890', value_state: 'valid' }];
const algorithmDefinition: WfdRecord = { definition_version: '1.0.0', result_semantics: 'isolated test',
  mathematical_definition: '(current-previous)/previous*100', window: { count: 2 } };
const candidateSha256 = wfdSha256(canonicalWfdJson(candidateRows));
const computedAt = '2026-04-29T00:00:00Z';
const derivedInputs = [{ ref: 'macro-current', latestAvailableAtUtc: '2026-02-15T00:00:00Z',
  basis: 'source publication', evidenceSha256: wfdSha256(canonicalWfdJson({ input: 'macro-current' })) }];
const restriction = { authority: 'wfd_usage_governance_check' as const, result: 'no_known_issue' as const,
  checkedAtUtc: computedAt, evidenceSha256: wfdSha256(canonicalWfdJson({ governance: 'none' })) };

function eligibility(purpose: 'current_compute' | 'current_publish' = 'current_compute'): PurposeEligibilityResult {
  return evaluatePurposeEligibility({
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION, purpose,
    purposeEvidence: purpose === 'current_publish' ? [{ purpose: 'current_publish', authority: 'operator-http',
      quote: '本机操作者明确发布', observedAtUtc: computedAt, evidenceSha256: wfdSha256(canonicalWfdJson({ request: 'publish' })),
      requestId: 'publish-1' }] : null,
    history: { mode: null, cutoff: null, perspective: null },
    object: { objectSha256: candidateSha256, origin: 'derived_candidate', productId: null, snapshotId: null,
      recordVersion: null, definitionRevision: 'bd.polars-fixed/1', contentVerified: true,
      contentBasis: '隔离测试：候选按实际结果摘要核对' },
    publicationTime: null, holdingTime: null, revisions: null, wfdHistory: null,
    restriction, wfdDecision: null,
    derived: { methodVersion: 'bd.polars-fixed/1', businessTime: '2026-01-01', inputs: derivedInputs,
      computedAtUtc: computedAt, computedAtBasis: '实际计算完成', publishedAtUtc: null, usableAtUtc: null,
      resultObjectSha256: candidateSha256 },
  });
}

const publishUsage = (present = true) => present ? {
  purpose: 'current_publish', historyMode: null, cutoff: null, perspective: null,
  purposeEvidence: [{ purpose: 'current_publish', authority: 'operator-http',
    quote: 'structured action: intendedAction=publish; purpose=current_publish',
    observedAtUtc: '2026-04-30T00:00:00Z', evidenceSha256: 'e'.repeat(64), requestId: 'plan-request-1' }],
} : null;
const purposeDimension = () => ({ key: 'purpose', status: 'known', value: '当前发布用途，候选只作派生计算结果',
  gap: null, evidence: [{ source: 'operator-http', quote: '本机操作者明确发布', field: 'outputs.0.dimensions.purpose',
    requestId: 'plan-request-1', observedAt: 1_777_000_000_000 }], suggestions: [] });

async function fixture(input: { purposeEvidence?: boolean; restriction?: WfdRecord | null; contentNature?: string }) {
  const parent = process.env.XUAN_TEST_ROOT ?? tmpdir();
  const root = realpathSync(mkdtempSync(join(parent, 'polars-eligibility-gate-')));
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks!: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const runtimes = new TaskRuntimeRegistry();
  const data = { version: 'bd.polars-fixed/1', rows: candidateRows, evidence: { method: 'macro_yoy', governance: null },
    algorithmDefinition, candidateSha256, computedAt, publication: 'candidate_only', eligibility: eligibility(),
    restriction: input.restriction === undefined ? restriction : input.restriction, derivedInputs };
  runtimes.register({ id: POLARS_FIXED_RUNTIME, execute: async () => ({ summary: 'isolated candidate', data: data as never }) });
  tasks = new TaskService({ database, permissions, runtimes });
  database.connection.exec(`CREATE TABLE harness_material_uploads (
    request_id TEXT PRIMARY KEY, args_digest TEXT, local_name TEXT, file_ref_id TEXT, task_id TEXT, created_at INTEGER);`);
  const args = { input: { requestId: 'gate-test', method: 'macro_yoy', calculation: {
    version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents', knowledgeCutoff: '2026-04-30T00:00:00Z',
    inputs: [{ snapshotId: 's_0123456789abcdef01234567', productId: 'p_0123456789abcdef01234567',
      businessKey: 'macro-current', recordVersion: 'r_0123456789abcdef01234567' }] } },
    connection: { instance: 'isolated' }, python: '/isolated/polars-python' };
  const task = tasks.create({ title: 'polars eligibility gate fixture', ownerRole: 'service', runtimeId: POLARS_FIXED_RUNTIME,
    action: 'polars.fixed.calculate', requestId: 'polars:gate-test', args: args as never,
    versions: { polars: 'bd.polars-fixed/1', polarsDependency: '2.0.0', polarsWorker: '0'.repeat(64),
      polarsFinancial: 'bd.financial-linear-admission/1', polarsConnection: '0'.repeat(64), polarsInput: '0'.repeat(64) } });
  tasks.start(task.id, task.version);
  const settled = await tasks.wait(task.id);
  assert.equal(settled.status, 'succeeded', JSON.stringify(settled.error));
  database.connection.prepare('INSERT INTO harness_material_uploads VALUES(?,?,?,?,?,?)').run(
    'polars-stage:' + task.id, 'digest', 'isolated', null, 'custody-1', Date.now());
  const service = new PolarsFixedService({
    database, tasks: () => tasks,
    workspace: { capabilities: () => ({ connection: { instance: 'isolated' } }) } as never,
    auto: {} as never,
    processing: {
      get: () => ({ outputs: [{ outputId: 'out', materialIds: ['m1'], dimensions: [purposeDimension()],
        usage: publishUsage(input.purposeEvidence ?? true) }] }),
      outputArtifact: () => ({ bytes: Buffer.from(canonicalWfdJson({ rows: candidateRows })) }),
    } as never,
    materials: { getByTask: () => ({ envelope: { materialId: 'm1' } }), readOriginal: () => ({ sha256: candidateSha256, bytes: Buffer.from('[]') }) } as never,
    processRuntime: undefined, accept: async () => 'custody-1',
  });
  const definition = { semantic_context: { content_nature: input.contentNature ?? 'deterministic_derived' },
    measurement_nature: 'derived', algorithm_definition: algorithmDefinition,
    field_definitions: [{ field_code: 'value', data_type: 'decimal', measurement_nature: 'derived' }] };
  return { root, database, tasks, service, task, definition,
    async close() { await tasks.dispose(); database.close(); } };
}

test('R1 准备/首次发送共用核验器：真实计划用途证据与实际限制证据缺一不可', async () => {
  const host = await fixture({});
  try {
    host.service.verifyCandidate(host.task.id, { materialId: 'm1', planId: 'plan-1', outputId: 'out', definition: host.definition });
  } finally { await host.close(); }

  const missingPurpose = await fixture({ purposeEvidence: false });
  try {
    assert.throws(() => missingPurpose.service.verifyCandidate(missingPurpose.task.id,
      { materialId: 'm1', planId: 'plan-1', outputId: 'out', definition: missingPurpose.definition }),
      { code: 'POLARS_PUBLISH_USAGE_MISSING' });
  } finally { await missingPurpose.close(); }

  const missingRestriction = await fixture({ restriction: null });
  try {
    assert.throws(() => missingRestriction.service.verifyCandidate(missingRestriction.task.id,
      { materialId: 'm1', planId: 'plan-1', outputId: 'out', definition: missingRestriction.definition }),
      (error: any) => { assert.equal(error.code, 'PURPOSE_ELIGIBILITY_INSUFFICIENT'); assert.match(error.message, /RESTRICTION_EVIDENCE_REQUIRED/); return true; });
  } finally { await missingRestriction.close(); }

  const changedNature = await fixture({ contentNature: 'observed_fact' });
  try {
    assert.throws(() => changedNature.service.verifyCandidate(changedNature.task.id,
      { materialId: 'm1', planId: 'plan-1', outputId: 'out', definition: changedNature.definition }),
      { code: 'POLARS_DERIVED_CONTRACT' });
  } finally { await changedNature.close(); }
});

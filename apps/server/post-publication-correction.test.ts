import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

/**
 * 已发布错误更正闭环的真实隔离验收。
 *
 * 前置为明确标注的合成隔离状态：两个互不影响系列经真实 WFD 机器入口发布并
 * 固定读回，BD 持久关联按真实回执写入；错误计划/适配引用、发现时间、证据、
 * 冻结影响清单与逐项状态都由真实 HTTP 入口办理。修复值必须来自真实加工计划
 * 的固定结构产物，不允许正文 correctedRows 冒充；审批与正式替代走真实
 * TaskService/PermissionService 与 WFD writer_lock。
 *
 * 本测试不冒充完整加工五步之外的业务来源真实性，也不冒充供应商原件。
 */
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const ERROR_ADAPTER = { adapterId: 'correction.bad.adapter', version: '1', configDigest: 'b'.repeat(64) };
const FIXED_ADAPTER = { adapterId: 'correction.fixed.adapter', version: '2', configDigest: 'c'.repeat(64) };

function definition(semantic: string): WfdRecord {
  return { semantic_code: semantic, measurement_nature: 'stock', unit_code: 'count',
    definition_authority: 'correction.test', time_role: 'observation',
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
      time: { period_type: 'natural', frequency: 'day', interval: 'closed' },
      statistical: { price_basis: 'nominal', period_aggregation: 'period' } } };
}
function row(key: string, value: string): WfdRecord {
  return { business_key: key, value_decimal: value, value_state: 'valid_value',
    observation_time: { status: 'known', precision: 'day',
      earliest_utc: '2026-04-13T00:00:00Z', latest_exclusive_utc: '2026-04-14T00:00:00Z',
      source_timezone: 'UTC' } };
}
function output(key: string, semantic: string, value: string): WfdRecord {
  return { output_key: key, logical_domain: 'observations',
    subject: { kind: 'physical_object', namespace: 'correction.test', id: key },
    definition_mode: 'create', definition_ref: null, definition: definition(semantic),
    input_mode: 'partial_observation',
    coverage: { scope: { synthetic: true }, basis: 'observed_partial',
      completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'scalar_rows', rows: [row('row-' + key, value)] } };
}
function document(requestId: string, parent: string | null): WfdRecord {
  return { protocol_version: 'wfd.structured-ingest/1.0',
    request_identity: { dataset_id: 'correction_dataset', trusted_actor_namespace: 'full.chain.test',
      request_id: requestId, submission_digest: 'sha256:' + '0'.repeat(64) },
    intent: 'submit', producer_namespace: 'full.chain.test', expected_parent_snapshot_id: parent,
    outputs: [output('series_a', 'correction.series.a', '10'), output('series_b', 'correction.series.b', '20')] };
}

/** 捕获机器入口的明确拒绝，不断言成功。 */
async function deniedCode(call: () => Promise<unknown>, expected: RegExp): Promise<string> {
  try { await call(); } catch (error) {
    const code = (error as { code?: string }).code;
    assert.ok(code, JSON.stringify(error));
    assert.match(String(code), expected, JSON.stringify(error));
    return String(code);
  }
  assert.fail('预期被明确拒绝，但调用成功');
}

async function waitTask(host: FullChainHost, taskId: string, states: string[], label: string) {
  for (let tries = 0; tries < 1200; tries++) {
    const task = host.services.tasks.get(taskId);
    if (states.includes(task.status)) return task;
    await delay(50);
  }
  assert.fail('任务未达到预期状态：' + label + ' ' + JSON.stringify(host.services.tasks.get(taskId)));
}

/** 把真实 WFD 回执写成 BD 侧已完成的持久关联（合成隔离前置状态）。
 *  两个系列分别落在独立持久计划/请求/关联上，只有 series_a 带错误适配三元组。 */
function seedAssociations(host: FullChainHost, doc: WfdRecord, receipt: WfdRecord, caseTag: string,
  realMaterialId: string) {
  const db = host.database.connection;
  const now = Date.now();
  const outputs = receipt.output_results as WfdRecord[];
  const result: Record<string, { planId: string; outputId: string; requestId: string }> = {};
  for (const [index, item] of outputs.entries()) {
    const key = String(item.output_key);
    const isError = key === 'series_a';
    const planId = `correction-plan-${caseTag}-${key}`, outputId = `observations-${caseTag}-${key}`;
    const requestId = `correction-attempt-${caseTag}-${key}`;
    const requestKey = `correction-request-${caseTag}-${key}`;
    const singleOutput = (doc.outputs as WfdRecord[]).find(entry => entry.output_key === key)!;
    const singleDoc: WfdRecord = { ...doc, outputs: [singleOutput],
      request_identity: { ...(doc.request_identity as WfdRecord), request_id: requestId } };
    db.prepare(`INSERT INTO processing_requests(request_key,client_request_id,kind,plan_id,content_digest,input_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(requestKey, requestId, 'plan', planId,
        wfdSha256(canonicalWfdJson(singleDoc)), canonicalWfdJson({}), now);
    db.prepare(`INSERT INTO processing_plans(plan_id,request_key,plan_digest,scope_key,policy_version,
      policy_digest,policy_json,operator_json,material_manifest_json,plan_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(planId, requestKey, 'digest', 'scope', 'policy-v1',
        'policy-digest', '{}', '{}', '[]', canonicalWfdJson({
          version: 'bd-processing-plan/1', materials: [], outputs: [{ outputId, materialIds: [] }] }),
        'completed', now, now);
    db.prepare(`INSERT INTO processing_plan_steps(plan_id,step_id,ordinal,output_id,kind,required,applicability,
      depends_json,implementation,parameters_json,completion_json,spec_digest,state,input_json,
      check_scope_json,gaps_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      planId, 'parse:' + outputId, 0, outputId, 'parse', 1, 'applicable', '[]', 'impl',
      canonicalWfdJson({ materialId: realMaterialId, format: 'json',
        sourceAdapter: isError ? ERROR_ADAPTER : FIXED_ADAPTER,
        sourceProjection: { keyColumns: ['business_key'] } }),
      '{}', 'digest', 'completed', '{}', '[]', '[]');
    db.prepare(`INSERT INTO processing_plan_outputs(plan_id,output_id,state,structured_json,structured_digest,
      routing_state,dimensions_json,gaps_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      planId, outputId, 'structured', '{}', 'digest', 'ready_candidate', '[]', '[]', now);
    const material = host.services.materials!.readOriginal(realMaterialId);
    const sourceRef = { source_id: 'correction-test-source', provider: 'synthetic correction fixture',
      requested_url: 'https://correction.test/source', requested_at_utc: '2026-04-13T00:00:00Z',
      acquired_at_utc: '2026-04-13T00:00:01Z', usage_scope: 'synthetic-test',
      sha256: material.sha256, bytes: material.bytes.length };
    db.prepare(`INSERT INTO r1_handoff_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requestId, 'correction_dataset', 'full.chain.test', canonicalWfdJson(singleDoc),
      wfdSha256(canonicalWfdJson(singleDoc)), canonicalWfdJson({ originalIds: [], materialIds: [realMaterialId],
        sourceRefs: [sourceRef], processRefs: [], evidenceRefs: [] }), 'refs-digest', 'associated',
      canonicalWfdJson({ ...receipt, output_results: [item] }), 0, null, now, now);
    db.prepare(`INSERT INTO r1_workspace_requests VALUES(?,?,?,?,?,?,?,?)`).run(
      requestId, canonicalWfdJson({}), 'binding-digest', `recipe-${key}`, planId, outputId, null, now);
    for (const record of item.records as WfdRecord[]) {
      db.prepare(`INSERT INTO r1_record_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'correction_dataset', String(item.product_id), String((item.definition_ref as WfdRecord).digest),
        String(receipt.snapshot_id), String(record.record_id), String(record.record_version), requestId,
        `bd-original:${caseTag}-${key}`, 'correction-source', '[]', '[]', now + index);
    }
    result[key] = { planId, outputId, requestId };
  }
  return result;
}

/** 真实加工计划：同一原件 CSV 经 parse→clean→structure→annotate→check 生成
 *  含 business_key/value_decimal/value_state 的固定结构产物；修复值只从这里读。 */
async function createRepairPlan(host: FullChainHost, materialId: string, bytes: Buffer, tag: string) {
  const text = bytes.toString('utf8'), header = text.split('\n')[0]!.replace(/\r$/u, '');
  const fields = header.split(','), firstField = fields[0]!;
  const evidence = { source: 'material', materialId, quote: header, start: 0, end: header.length };
  const known = (value: string) => ({ status: 'known', value, evidence: [evidence] });
  const dimensions = {
    role: known('原件表头可核的 CSV 表格；本次仅检查结构'),
    informationNature: { status: 'unknown', gap: '来源真实性、数据生成口径和业务含义尚未验证。' },
    businessObject: known(`原件列有 ${fields.slice(0, 2).join('、')}；对象身份未核定`),
    objectTime: { status: 'unknown', gap: '日期或事件列不能证明逐行公开可得时刻、历史修订和有效期。' },
    purpose: { status: 'known', value: '隔离环境内生成合成更正候选，不授权发布',
      evidence: [{ source: 'operator', field: 'routing.materials.0.dimensions.purpose',
        quote: '隔离环境内生成合成更正候选，不授权发布' }] },
    structureGranularity: known('原件表头所列字段形成行列表；业务粒度未采用'),
  };
  const input = { routing: { materials: [{ materialId, dimensions, intendedAction: 'inspect' }] },
    outputs: [{ outputId: 'repair-output', materialIds: [materialId], intendedAction: 'inspect',
      tables: [{ materialId, format: 'csv', trim: [firstField], types: { value_decimal: 'decimal_string' },
        annotations: { source_original_sha256: wfdSha256(bytes) } }],
      coverage: { complete: false, scope: '本次只执行结构检查；未认定业务发布资格。',
        gaps: ['合成前置：来源许可、历史可得时刻和单位口径未核'] } }] };
  const planned = await host.call('/processing/plans', { requestId: `${tag}-plan`, input }, 202);
  const planTask = await host.settled(planned.jobId, 120_000);
  assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
  const planId = host.services.processing!.getByTask(planTask.id)!.plan!.planId;
  const run = await host.call(`/processing/plans/${planId}/run`, { requestId: `${tag}-run` }, 202);
  const runTask = await host.settled(run.jobId, 120_000);
  assert.equal(runTask.status, 'succeeded', JSON.stringify(runTask.error));
  const plan = await host.call(`/processing/plans/${planId}`);
  const output = plan.outputs.find((item: WfdRecord) => item.outputId === 'repair-output');
  assert.equal(output.state, 'structured', JSON.stringify(plan.outputs));
  const artifact = host.services.processing!.outputArtifact(planId, 'repair-output');
  const rows = JSON.parse(artifact.bytes.toString('utf8')).rows as WfdRecord[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.business_key, 'row-series_a');
  assert.equal(String(rows[0]!.value_decimal), '11');
  return { planId, outputId: 'repair-output', artifactSha256: wfdSha256(artifact.bytes) };
}

async function publish(host: FullChainHost, caseTag: string) {
  const doc = document('correction-original-' + caseTag, null);
  const reply = await host.services.r1Runtime!.connection.client.request('submit', { document: doc });
  assert.equal(reply.response.ok, true, JSON.stringify(reply.response.error));
  const receipt = reply.result as WfdRecord;
  assert.equal(receipt.state, 'published_formal', JSON.stringify(receipt));
  // 真实固定读回一致
  for (const item of receipt.output_results as WfdRecord[]) {
    const read = await host.services.r1Runtime!.client.fixedRead(String(receipt.snapshot_id), String(item.product_id));
    const readRows = (read.result as WfdRecord).rows;
    assert.equal(Array.isArray(readRows) ? readRows.length : -1, 1, JSON.stringify(read.result));
  }
  return { doc, receipt };
}

test('已发布错误更正：真实新加工产物、审批拒绝后重办、精确前驱与固定读回',
  { skip: !enabled, timeout: 900_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'post-pub-correction', machine: true,
      units: { count: { dimension: 'quantity' } } });
    let host = await openFullChainHost(fixture);
    const evidence: WfdRecord = { fixtureRoot: fixture.root, wfdStore: fixture.store };
    try {
      // 真实材料保管：修复必须复用同一原件字节，不接受正文自报摘要。
      const originalBytes = Buffer.from('business_key,value_decimal,value_state\nrow-series_a,11,valid_value\n', 'utf8');
      const upload = await host.upload('correction-original.csv', 'data', originalBytes, 'correction-material-upload');
      const intake = await host.settled(upload.jobId);
      assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
      const realMaterialId = host.services.materials!.getByTask(intake.id)!.envelope.materialId;
      const originalSha256 = host.services.materials!.readOriginal(realMaterialId).sha256;
      const published = await publish(host, 'main');
      const seeded = seedAssociations(host, published.doc, published.receipt, 'main', realMaterialId);
      const repairedPlan = await createRepairPlan(host, realMaterialId, originalBytes, 'correction-repair');
      const a = (published.receipt.output_results as WfdRecord[]).find(item => item.output_key === 'series_a')!;
      const b = (published.receipt.output_results as WfdRecord[]).find(item => item.output_key === 'series_b')!;
      const oldSnapshot = String(published.receipt.snapshot_id);
      const oldVersion = String((a.records as WfdRecord[])[0]!.record_version);
      const originalPlanDigest = (host.database.connection.prepare(
        'SELECT document_sha256 FROM r1_handoff_attempts WHERE request_id=?').get(seeded.series_a!.requestId) as
        { document_sha256: string }).document_sha256;

      const capabilities = await host.call('/corrections/capabilities');
      assert.equal(capabilities.authority, 'WFD catalog/usage_suspensions.json (shared writer_lock with submit)');
      const connectionSha256 = capabilities.connectionSha256;
      assert.equal(typeof connectionSha256, 'string');

      // 1) 错误登记（真实 HTTP 入口）
      const registered = await host.call('/corrections/cases', { requestId: 'correction-register',
        input: { caseId: 'case-main', kind: 'processing_repair', errorType: 'mapping_error',
          discoveredAt: '2026-11-07T02:00:00Z',
          evidence: '合成适配把字段位置 1 误映射为收盘价；固定读回后才由人工比对发现。',
          binding: { planOutput: { planId: seeded.series_a!.planId, outputId: seeded.series_a!.outputId } },
          connectionSha256 } }, 201);
      assert.equal(registered.state, 'registered');
      assert.equal(registered.coverage, 'proven_subset_only');

      // 2) 影响圈定：只命中错误计划对应的原报行，未影响系列不扩改
      const impact = await host.call('/corrections/cases/case-main/impact', { requestId: 'correction-impact' });
      assert.equal(impact.state, 'impact_frozen', JSON.stringify(impact.gaps));
      assert.equal(impact.items.some((item: WfdRecord) => item.productId === a.product_id), true);
      assert.equal(impact.items.some((item: WfdRecord) => item.productId === b.product_id), false);
      assert.ok(impact.gaps.some((gap: string) => gap.startsWith('coverage:')));

      // 3) 正式暂停落盘 WFD；磁盘重开仍生效
      const suspended = await host.call('/corrections/cases/case-main/suspend', { requestId: 'correction-suspend' });
      assert.equal(suspended.state, 'suspended');
      const status = (await host.services.r1Runtime!.connection.client.usageStatus()).result as WfdRecord;
      assert.equal((status.issues as WfdRecord[]).filter(issue => issue.issue_id === 'case-main' && issue.state === 'active').length, 1);
      await host.close();
      host = await openFullChainHost(fixture);
      const reopenedStatus = (await host.services.r1Runtime!.connection.client.usageStatus()).result as WfdRecord;
      assert.equal((reopenedStatus.issues as WfdRecord[]).filter(issue => issue.issue_id === 'case-main' && issue.state === 'active').length, 1);

      // 4) 默认业务读取/固定读/分页/计算取数均不能绕过；未影响系列保持可读
      const machine = host.services.r1Runtime!.connection.client;
      const fixedCode = await deniedCode(() => machine.request('fixed_read',
        { snapshot_id: oldSnapshot, product_id: a.product_id }), /USAGE_SUSPENDED/u);
      const pageCode = await deniedCode(() => machine.readProductPage(
        { snapshotId: oldSnapshot, productId: String(a.product_id) }), /USAGE_SUSPENDED|REQUEST_INVALID/u);
      const pageSelectedCode = await deniedCode(() => machine.readPage(
        { snapshotId: oldSnapshot, productId: String(a.product_id),
          recordRefs: [{ record_id: 'row-series_a', record_version: oldVersion }] }),
        /USAGE_SUSPENDED|REQUEST_INVALID/u);
      evidence.deniedReads = { fixedCode, pageCode, pageSelectedCode };
      const unaffected = await host.services.r1Runtime!.client.fixedRead(oldSnapshot, String(b.product_id));
      assert.equal(unaffected.response.ok, true, JSON.stringify(unaffected.response.error));
      // 显式审计复现带已知问题说明，且明确不可发布/计算
      const audit = await host.call(`/corrections/cases/case-main/audit?snapshotId=${oldSnapshot}&productId=${a.product_id}`);
      assert.equal(audit.publishable, false);
      assert.equal(audit.compute_eligible, false);
      assert.ok(JSON.stringify(audit).includes('case-main'));
      assert.equal((((audit.rows as WfdRecord[])[0]!.row) as WfdRecord).value_decimal, '10');
      const auditIssues = (audit.usage_governance as WfdRecord).known_issues;
      evidence.pause = { oldSnapshot, oldVersion, auditIssueCount: Array.isArray(auditIssues) ? auditIssues.length : -1 };

      // 5) 准备修复：正文 correctedRows 不能冒充实际加工；冻结摘要改变须重新确认
      const prepared = await host.call('/corrections/cases/case-main/prepare', { requestId: 'correction-prepare',
        input: { planId: repairedPlan.planId, outputId: repairedPlan.outputId,
          originalSha256, expectedParentSnapshotId: oldSnapshot,
          reason: '按来源字段位置对照矩阵重新映射，第一位置为交易日、第三位置为收盘价。' } });
      assert.equal(prepared.view.state, 'prepared');
      assert.ok(prepared.documentSha256 && prepared.frozenSha256);
      const fakeRows = await host.call('/corrections/cases/case-main/prepare', { requestId: 'correction-prepare-fake',
        input: { planId: repairedPlan.planId, outputId: repairedPlan.outputId,
          originalSha256, expectedParentSnapshotId: oldSnapshot,
          reason: '按来源字段位置对照矩阵重新映射，第一位置为交易日、第三位置为收盘价。',
          correctedRows: [{ ...row('row-series_a', '99') }] } }, 409);
      assert.equal(fakeRows.code, 'CORRECTION_ROWS_NOT_FROM_OUTPUT');
      const changed = await host.call('/corrections/cases/case-main/prepare', { requestId: 'correction-prepare-2',
        input: { planId: repairedPlan.planId, outputId: repairedPlan.outputId,
          originalSha256, expectedParentSnapshotId: oldSnapshot,
          reason: '按来源字段位置对照矩阵重新映射；本次冻结摘要明确改为第二版确认文本。' } });
      assert.notEqual(changed.frozenSha256, prepared.frozenSha256);
      await assert.rejects(async () => host.call('/corrections/cases/case-main/authorize',
        { requestId: 'correction-authorize-stale', input: { frozenSha256: prepared.frozenSha256,
          confirmationDigest: prepared.documentSha256 } }), (error: unknown) => error instanceof Error);

      // 6) 真实 TaskService/PermissionService 审批：拒绝后不写正式库、不解除限制，且可明确重办
      const deniedTask = await host.call('/corrections/cases/case-main/authorize', { requestId: 'correction-authorize-deny',
        input: { frozenSha256: changed.frozenSha256, confirmationDigest: changed.documentSha256 } }, 202);
      const waitingDeny = await waitTask(host, deniedTask.id, ['waiting_approval'], 'deny waiting');
      assert.ok(waitingDeny.approvalId);
      host.services.tasks.deny(waitingDeny.approvalId!);
      const deniedDone = await waitTask(host, deniedTask.id, ['failed', 'cancelled'], 'deny done');
      assert.equal(deniedDone.status, 'failed', JSON.stringify(deniedDone.error));
      const afterDeny = await host.call('/corrections/cases/case-main');
      assert.notEqual(afterDeny.state, 'resolved');
      assert.equal(String((await machine.usageStatus()).result.active_issues), '1');
      await deniedCode(() => machine.request('fixed_read',
        { snapshot_id: oldSnapshot, product_id: a.product_id }), /USAGE_SUSPENDED/u);

      // 同一冻结摘要显式重授权：新建独立审批任务，复用旧任务号不被前置状态挡住
      const retryTask = await host.call('/corrections/cases/case-main/authorize', { requestId: 'correction-authorize-retry',
        input: { frozenSha256: changed.frozenSha256, confirmationDigest: changed.documentSha256 } }, 202);
      assert.notEqual(retryTask.id, deniedTask.id);
      const waitingApprove = await waitTask(host, retryTask.id, ['waiting_approval'], 'approve waiting');
      assert.ok(waitingApprove.approvalId);
      host.services.tasks.approve(waitingApprove.approvalId!);
      const done = await waitTask(host, retryTask.id, ['succeeded', 'failed', 'cancelled', 'needs_review'], 'approve done');
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));

      // 7) 审批后：正式回执、固定读回、新旧替代、逐项结案、新 R1 关联与旧快照保留
      const finalView = await host.call('/corrections/cases/case-main');
      assert.equal(finalView.state, 'resolved', JSON.stringify(finalView));
      assert.ok(finalView.items.every((item: WfdRecord) => item.state === 'corrected'), JSON.stringify(finalView.items));
      const result = finalView.result as WfdRecord;
      const newSnapshot = String(result.newSnapshotId);
      assert.notEqual(newSnapshot, oldSnapshot);
      evidence.authorization = { deniedTaskId: deniedTask.id, retryTaskId: retryTask.id,
        state: finalView.state, frozenSha256: changed.frozenSha256, newSnapshot };
      const currentA = await machine.request('fixed_read', { snapshot_id: newSnapshot, product_id: a.product_id });
      assert.equal(currentA.response.ok, true, JSON.stringify(currentA.response.error));
      const currentRows = (currentA.result as WfdRecord).rows as WfdRecord[];
      assert.equal((currentRows[0]!.row as WfdRecord).value_decimal, '11');
      assert.equal((currentRows[0]!.revision as WfdRecord).supersedes, oldVersion);
      const currentB = await machine.request('fixed_read', { snapshot_id: newSnapshot, product_id: b.product_id });
      assert.equal((((currentB.result as WfdRecord).rows as WfdRecord[])[0]!.row as WfdRecord).value_decimal, '20');
      // 旧快照仅审计复现，原值/原字节/旧计划摘要不变；错误版本限制保留
      const oldAudit = await host.call(`/corrections/cases/case-main/audit?snapshotId=${oldSnapshot}&productId=${a.product_id}`);
      assert.equal((((oldAudit.rows as WfdRecord[])[0]!.row) as WfdRecord).value_decimal, '10');
      assert.equal(oldAudit.publishable, false);
      const originalPlanAfter = (host.database.connection.prepare(
        'SELECT document_sha256 FROM r1_handoff_attempts WHERE request_id=?').get(seeded.series_a!.requestId) as
        { document_sha256: string }).document_sha256;
      assert.equal(originalPlanAfter, originalPlanDigest);
      const associations = host.database.connection.prepare(`SELECT * FROM r1_record_associations
        WHERE request_id='correction:case-main'`).all() as unknown as WfdRecord[];
      assert.equal(associations.length, 1);
      const publicRead = await host.call('/r1/requests/correction:case-main');
      assert.equal(publicRead.state, 'associated', JSON.stringify(publicRead));
      assert.equal(String(associations[0]!.record_version), String((currentRows[0]!.record_ref as WfdRecord).revision_id));
      const resolvedStatus = (await machine.usageStatus()).result as WfdRecord;
      assert.equal((resolvedStatus.issues as WfdRecord[]).find(issue => issue.issue_id === 'case-main')!.state, 'resolved');
      writeFileSync(join(fixture.root, 'correction-acceptance.json'), JSON.stringify(evidence, null, 2));
    } finally {
      await host.close().catch(() => {});
    }
  });

test('错误适配绑定按真实裸 hex 配置摘要匹配计划', { skip: !enabled, timeout: 300_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'post-pub-adapter-digest', machine: true,
    units: { count: { dimension: 'quantity' } } });
  const host = await openFullChainHost(fixture);
  try {
    const bytes = Buffer.from('business_key,value_decimal,value_state\nrow-series_a,11,valid_value\n', 'utf8');
    const upload = await host.upload('digest.csv', 'data', bytes, 'digest-material');
    const intake = await host.settled(upload.jobId);
    assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
    const materialId = host.services.materials!.getByTask(intake.id)!.envelope.materialId;
    const published = await publish(host, 'digest');
    const seeded = seedAssociations(host, published.doc, published.receipt, 'digest', materialId);
    const capabilities = await host.call('/corrections/capabilities');
    await host.call('/corrections/cases', { requestId: 'digest-register', input: {
      caseId: 'case-digest', kind: 'processing_repair', errorType: 'mapping_error',
      discoveredAt: '2026-11-07T02:00:00Z', evidence: '合成错误适配摘要格式核对。',
      binding: { adapter: ERROR_ADAPTER }, connectionSha256: capabilities.connectionSha256 } }, 201);
    const impact = await host.call('/corrections/cases/case-digest/impact', { requestId: 'digest-impact' });
    assert.equal(impact.state, 'impact_frozen', JSON.stringify(impact.gaps));
    assert.equal(impact.items.some((item: WfdRecord) => item.productId ===
      (published.receipt.output_results as WfdRecord[]).find(entry => entry.output_key === 'series_a')!.product_id), true);
    // A legacy case may already have frozen a partial scan: do not send it to WFD.
    const db = host.database.connection;
    db.prepare(`UPDATE correction_cases SET impact_json=json_insert(impact_json,'$.gaps[#]','plan_scan_over_budget')
      WHERE case_id='case-digest'`).run();
    const legacyRejection = await host.call('/corrections/cases/case-digest/suspend', { requestId: 'digest-suspend' }, 409);
    assert.equal(legacyRejection.code, 'CORRECTION_SUSPEND_SCOPE');
    assert.equal(host.services.corrections!.view('case-digest').state, 'impact_incomplete');
    // The proven association precedes the scan cutoff; it cannot authorize freezing a prefix.
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<19999)
      INSERT INTO processing_plan_steps(plan_id,step_id,ordinal,output_id,kind,required,applicability,
        depends_json,implementation,parameters_json,completion_json,spec_digest,state,input_json,check_scope_json,gaps_json)
      SELECT ?, 'extra-'||i,i,'extra-'||i,'parse',1,'applicable','[]','impl','{}','{}','digest','completed','{}','[]','[]' FROM n`)
      .run(seeded.series_b!.planId);
    const overBudget = await host.call('/corrections/cases/case-digest/impact', { requestId: 'digest-rescan' });
    assert.equal(overBudget.state, 'impact_incomplete');
    assert.equal(overBudget.itemCount, 0);
    assert.ok(overBudget.gaps.includes('plan_scan_over_budget'));
    const budgetRejection = await host.call('/corrections/cases/case-digest/suspend', { requestId: 'digest-suspend-again' }, 409);
    assert.equal(budgetRejection.code, 'CORRECTION_STATE');
  } finally {
    await host.close().catch(() => {});
  }
});

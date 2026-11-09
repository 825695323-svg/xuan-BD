import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { fileURLToPath } from 'node:url';
import { publishRestrictionTarget } from '../../modules/collection/wfd-publish-restriction.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source = { source_id: 'purpose-entry-synthetic', provider: 'explicit synthetic fixture',
  requested_url: 'https://fixture.example.test/purpose-entry.csv', requested_at_utc: '2026-01-01T00:00:00Z',
  acquired_at_utc: '2026-02-01T00:00:00Z', usage_scope: 'explicit isolated purpose-entry verification; candidate only',
  authorization: { status: 'authorized' as const, basis: 'Operator selected generated fixed input for isolated processing/R1 purpose verification.' } };
const csv = Buffer.from('business_key,start_utc,end_utc,value_state,value\nk1,2025-01-01T00:00:00Z,2025-01-02T00:00:00Z,valid_value,1\n');
const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
  precision: 'day', sourceTimezone: 'UTC', fields: [{ fieldCode: 'value', value: 'value', state: 'value_state' }] };
const dimensionValues = { role: 'source_record', informationNature: 'observed_fact', businessObject: 'subject-1',
  objectTime: 'explicit day intervals', purpose: 'explicit isolated publish', structureGranularity: 'one row per business key' };
const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: dimensionValues[key],
  evidence: [{ source: 'operator', field: key, quote: dimensionValues[key] }] }]));

test('U01：历史发布用途缺实际公开证据时共同候选不得ready，R1准备必须拒绝',
  { skip: enabled ? false : `未显式选择 WFD_PYTHON/XUAN_FULL_CHAIN_ROOT`, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'purpose-entry-history', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const host = await openFullChainHost(fixture);
    try {
      const uploaded = await host.upload('purpose-entry.csv', 'data', csv, 'purpose-entry-upload');
      const received = await host.settled(uploaded.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
      const materialId = host.services.materials!.getByTask(received.id)!.envelope.materialId;
      const target = { datasetId: 'purpose_entry', outputKey: 'value', expectedParentSnapshotId: (await host.call('/r1/products/snapshot', {})).snapshotId,
        subject: { kind: 'entity', namespace: 'full.chain.test', id: 'subject-1' }, inputMode: 'partial_observation',
        coverage: { scope: { selectedRecords: 1 }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
        definition: { semantic_code: 'purpose.entry', measurement_nature: 'stock', unit_code: 'per_field', definition_authority: 'full.chain.test',
          time_role: 'observation', field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: 'count',
            measurement_nature: 'stock', time_role: 'observation' }],
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
            time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } } } };
      const planInput = { routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
        outputs: [{ outputId: 'value', materialIds: [materialId], intendedAction: 'publish',
          usage: { purpose: 'historical_publish', historyMode: 'market_known_at', cutoff: '2025-02-01T00:00:00Z', perspective: 'market_known_at' },
          tables: [{ materialId, format: 'csv', types: { value: 'decimal_string' } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping },
            expectedSnapshotId: target.expectedParentSnapshotId } }] };
      const planned = await host.call('/processing/plans', { requestId: 'purpose-entry-history-plan', input: planInput }, 202);
      const plannedTask = await host.settled(planned.jobId);
      assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
      const plan = host.services.processing!.get(host.services.processing!.getByTask(plannedTask.id)!.plan!.planId);
      assert.equal(plan.outputs[0]!.publishEligible, false, JSON.stringify(plan.outputs[0]));
      assert.equal(plan.outputs[0]!.routingState, 'needs_review');
      assert.ok(plan.outputs[0]!.gaps.some(gap => /PUBLIC_TIME_EVIDENCE_REQUIRED|PUBLICATION_TIME|用途资格/u.test(gap)), JSON.stringify(plan.outputs[0]!.gaps));

      const prepareInput = { requestId: 'purpose-entry-history-prepare', planId: plan.planId, outputId: 'value', source, target, mapping };
      const response = await fetch(host.base + '/r1/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify(prepareInput) });
      const value = await response.json();
      assert.notEqual(response.status, 201, JSON.stringify(value));
      assert.equal(value.code, 'R1_PROCESS_NOT_READY', JSON.stringify(value));
    } finally { await host.close(); }
  });

test('U01：publish动作不能声明current_compute用途，计划在形成候选前拒绝',
  { skip: enabled ? false : `未显式选择 WFD_PYTHON/XUAN_FULL_CHAIN_ROOT`, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'purpose-entry-invalid', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const host = await openFullChainHost(fixture);
    try {
      const uploaded = await host.upload('purpose-entry-invalid.csv', 'data', csv, 'purpose-entry-invalid-upload');
      const received = await host.settled(uploaded.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
      const materialId = host.services.materials!.getByTask(received.id)!.envelope.materialId;
      const response = await fetch(host.base + '/processing/plans', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ requestId: 'purpose-entry-invalid-plan', input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
          outputs: [{ outputId: 'value', materialIds: [materialId], intendedAction: 'publish',
            usage: { purpose: 'current_compute', historyMode: null, cutoff: null, perspective: null },
            tables: [{ materialId, format: 'csv' }] }] } }) });
      const value = await response.json();
      assert.equal(response.status, 409, JSON.stringify(value));
      assert.equal(value.code, 'PROCESSING_USAGE', JSON.stringify(value));
    } finally { await host.close(); }
  });


test('U01：R1准备后用途证据被改空，首次发送按当前证据重判并拒绝',
  { skip: enabled ? false : `未显式选择 WFD_PYTHON/XUAN_FULL_CHAIN_ROOT`, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'purpose-entry-first-send', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const host = await openFullChainHost(fixture);
    try {
      const uploaded = await host.upload('purpose-entry-first-send.csv', 'data', csv, 'purpose-entry-first-send-upload');
      const received = await host.settled(uploaded.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
      const materialId = host.services.materials!.getByTask(received.id)!.envelope.materialId;
      const parent = (await host.call('/r1/products/snapshot', {})).snapshotId;
      const target = { datasetId: 'purpose_entry_send', outputKey: 'value', expectedParentSnapshotId: parent,
        subject: { kind: 'entity', namespace: 'full.chain.test', id: 'subject-1' }, inputMode: 'partial_observation',
        coverage: { scope: { selectedRecords: 1 }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
        definition: { semantic_code: 'purpose.entry.send', measurement_nature: 'stock', unit_code: 'per_field', definition_authority: 'full.chain.test',
          time_role: 'observation', field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: 'count',
            measurement_nature: 'stock', time_role: 'observation' }],
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
            time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } } } };
      const planned = await host.call('/processing/plans', { requestId: 'purpose-entry-first-send-plan', input: {
        routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
        outputs: [{ outputId: 'value', materialIds: [materialId], intendedAction: 'publish',
          usage: { purpose: 'current_publish', historyMode: null, cutoff: null, perspective: null },
          tables: [{ materialId, format: 'csv', types: { value: 'decimal_string' } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
      const plannedTask = await host.settled(planned.jobId); assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
      const planId = host.services.processing!.getByTask(plannedTask.id)!.plan!.planId;
      const run = await host.call('/processing/plans/' + planId + '/run', { requestId: 'purpose-entry-first-send-run' }, 202);
      assert.equal((await host.settled(run.jobId)).status, 'succeeded');
      const plan = host.services.processing!.get(planId);
      assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]));
      const prepareInput = { requestId: 'purpose-entry-first-send-prepare', planId, outputId: 'value', source, target, mapping };
      const prepared = await host.call('/r1/prepare', prepareInput, 201);
      assert.equal(prepared.state, 'prepared_profile_pending');
      const prepareInputB = { ...prepareInput, requestId: 'purpose-entry-first-send-prepare-2' };
      const preparedB = await host.call('/r1/prepare', prepareInputB, 201);
      assert.equal(preparedB.state, 'prepared_profile_pending');

      // 模拟准备后证据变化：保留同一计划/请求号，只把结构化用途证据清空并同步计划摘要。
      const row = host.database.connection.prepare('SELECT plan_json FROM processing_plans WHERE plan_id=?').get(planId) as { plan_json: string };
      const document = JSON.parse(row.plan_json) as { outputs: Array<Record<string, unknown>> };
      const usage = document.outputs[0]!.usage as { purpose: string; purposeEvidence: Array<Record<string, unknown>> };
      // 第一条负例：usage 与其 claims 同时降为 current_compute，R1 发布边界必须显式拒绝。
      usage.purpose = 'current_compute';
      usage.purposeEvidence[0]!.purpose = 'current_compute';
      let planJson = canonicalWfdJson(document);
      let update = () => host.database.connection.prepare('UPDATE processing_plans SET plan_json=?, plan_digest=? WHERE plan_id=?')
        .run(planJson, wfdSha256(planJson), planId);
      update();
      let response = await fetch(host.base + '/r1/requests/' + prepareInput.requestId + '/submit', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ confirmationDigest: prepared.documentSha256 }) });
      let value = await response.json();
      assert.equal(response.status, 202, JSON.stringify(value));
      let task = await host.settled(value.jobId);
      assert.equal(task.status, 'failed', JSON.stringify(task.error));
      assert.equal(task.error?.code, 'R1_PUBLISH_PURPOSE_REQUIRED', JSON.stringify(task.error));

      // 第二条负例：只把 claims 保持 current_compute、usage 仍是 current_publish；首次发送仍须重判并拒绝。
      usage.purpose = 'current_publish';
      planJson = canonicalWfdJson(document);
      update();
      response = await fetch(host.base + '/r1/requests/' + prepareInputB.requestId + '/submit', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ confirmationDigest: preparedB.documentSha256 }) });
      value = await response.json();
      assert.equal(response.status, 202, JSON.stringify(value));
      task = await host.settled(value.jobId);
      assert.equal(task.status, 'failed', JSON.stringify(task.error));
      assert.equal(task.error?.code, 'PURPOSE_ELIGIBILITY_INSUFFICIENT', JSON.stringify(task.error));
    } finally { await host.close(); }
  });


test('真实 WFD 匹配限制：prepare 消费 usage_status 并阻断发布',
  { skip: enabled ? false : `未显式选择 WFD_PYTHON/XUAN_FULL_CHAIN_ROOT`, timeout: 120_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'purpose-entry-restricted', machine: true,
      units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const host = await openFullChainHost(fixture);
    try {
      const uploaded = await host.upload('purpose-entry-restricted.csv', 'data', csv, 'purpose-entry-restricted-upload');
      const received = await host.settled(uploaded.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
      const materialId = host.services.materials!.getByTask(received.id)!.envelope.materialId;
      const parent = (await host.call('/r1/products/snapshot', {})).snapshotId;
      const target = { datasetId: 'purpose_entry_restricted', outputKey: 'value', expectedParentSnapshotId: parent,
        subject: { kind: 'entity', namespace: 'full.chain.test', id: 'subject-1' }, inputMode: 'partial_observation',
        coverage: { scope: { selectedRecords: 1 }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
        definition: { semantic_code: 'purpose.entry.restricted', measurement_nature: 'stock', unit_code: 'per_field',
          definition_authority: 'full.chain.test', time_role: 'observation',
          field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: 'count',
            measurement_nature: 'stock', time_role: 'observation' }],
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
            time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } } } };
      const restrictionTarget = publishRestrictionTarget({ purpose: 'current_publish', expectedSnapshotId: parent,
        productRef: null, logicalDomain: 'observations', subject: target.subject, definition: target.definition,
        definitionMode: 'create', recordVersions: [] });
      assert.equal(restrictionTarget.productIds.length, 1);
      const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
      const client = new WfdProductMachineClient({ pythonPath: process.env.WFD_PYTHON!, configPath: fixture.configPath,
        projectRoot: join(projectRoot, 'wfd', 'product'), entryPath: join(projectRoot, 'wfd', 'product', 'wfd_sdk', 'product_machine.py') });
      const planned = await host.call('/processing/plans', { requestId: 'purpose-entry-restricted-plan', input: {
        routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
        outputs: [{ outputId: 'value', materialIds: [materialId], intendedAction: 'publish',
          tables: [{ materialId, format: 'csv', types: { value: 'decimal_string' } }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
      const plannedTask = await host.settled(planned.jobId); assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
      const planId = host.services.processing!.getByTask(plannedTask.id)!.plan!.planId;
      const run = await host.call('/processing/plans/' + planId + '/run', { requestId: 'purpose-entry-restricted-run' }, 202);
      assert.equal((await host.settled(run.jobId)).status, 'succeeded');

      const prepareBefore = { requestId: 'purpose-entry-restricted-before', planId, outputId: 'value', source, target, mapping };
      const preparedBefore = await host.call('/r1/prepare', prepareBefore, 201);
      assert.equal(preparedBefore.state, 'prepared_profile_pending');
      await client.usageSuspend({ issue_id: 'CASE-PUBLISH', error_type: 'synthetic', reason: 'purpose-entry matching publish restriction',
        evidence_digest: 'sha256:' + 'a'.repeat(64), error_binding_digest: 'sha256:' + 'b'.repeat(64),
        impact_digest: 'sha256:' + 'c'.repeat(64), declared_at_utc: '2026-11-07T00:00:00Z',
        scopes: [{ product_id: restrictionTarget.productIds[0], snapshot_id: 's_0123456789abcdef01234567',
          record_versions: ['r_synthetic'], usages: ['publish'] }] });
      // 准备后新增匹配限制：首次发送必须重新读取权威状态并阻断。
      const submitBefore = await fetch(host.base + '/r1/requests/' + prepareBefore.requestId + '/submit', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ confirmationDigest: preparedBefore.documentSha256 }) });
      const submitValue = await submitBefore.json();
      assert.equal(submitBefore.status, 202, JSON.stringify(submitValue));
      const submitTask = await host.settled(submitValue.jobId);
      assert.equal(submitTask.status, 'failed', JSON.stringify(submitTask.error));
      assert.equal(submitTask.error?.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE', JSON.stringify(submitTask.error));
      assert.match(String(submitTask.error?.message), /USAGE_RESTRICTED/u);
      // 新增限制后新的准备也必须阻断。
      const response = await fetch(host.base + '/r1/prepare', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
        body: JSON.stringify({ requestId: 'purpose-entry-restricted-prepare', planId, outputId: 'value', source, target, mapping }) });
      const value = await response.json();
      assert.equal(response.status, 409, JSON.stringify(value));
      assert.equal(value.code, 'PURPOSE_ELIGIBILITY_INELIGIBLE', JSON.stringify(value));
      assert.match(String(value.error), /USAGE_RESTRICTED/u);
    } finally { await host.close(); }
  });

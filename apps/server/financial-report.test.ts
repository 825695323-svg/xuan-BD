import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { financialAlgorithmDefinition, type FinancialCalculation } from '../../modules/collection/data-processing/financial-fixed.js';
import { pdfNative } from '../../platform/capabilities/conversion/pdf.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

const manifestPath = process.env.XUAN_FINANCIAL_MANIFEST;
const enabled = !!manifestPath && !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const fields = ['report_id', 'report_version', 'subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'audit_status',
  'statement', 'scope', 'section', 'concept', 'dimension', 'period_type', 'start_date', 'end_date', 'unit', 'value'];
async function fixedRows(host: Awaited<ReturnType<typeof openFullChainHost>>, snapshotId: string, productId: string): Promise<any[]> {
  const rows: any[] = []; let cursor: string | undefined;
  do {
    const fixed = await host.call('/r1/products/read', { snapshotId, productId, ...(cursor ? { cursor } : {}) });
    assert.equal(fixed.result.snapshot_id, snapshotId); assert.equal(fixed.result.product_id, productId);
    rows.push(...fixed.result.rows); cursor = fixed.result.page.has_more ? fixed.result.page.next_cursor : undefined;
    assert.ok(!fixed.result.page.has_more || cursor);
  } while (cursor);
  return rows;
}

test('selected official company reports: original PDF → declared regions → processing → actual WFD publication → fixed rows → restart',
  { skip: !enabled, timeout: 1_800_000 }, async () => {
    const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8')) as any[];
    assert.ok(manifest.length >= 5 && manifest.every(item => item.status === 'projected'), 'Unresolved source selections must be reported before publication.');
    const resumeRoot = process.env.XUAN_FINANCIAL_RESUME;
    const fixture = resumeRoot ? JSON.parse(readFileSync(join(resumeRoot, 'financial-fixture.json'), 'utf8'))
      : createFullChainFixture({ name: 'financial-reports', machine: true,
        units: { cny: { dimension: 'money' }, cny_per_share: { dimension: 'money_per_share' }, text: { dimension: 'text' } } });
    writeFileSync(join(fixture.root, 'financial-fixture.json'), JSON.stringify(fixture, null, 2));
    let host = await openFullChainHost(fixture);
    const ledger: any[] = resumeRoot ? JSON.parse(readFileSync(join(fixture.root, 'financial-published-ledger.json'), 'utf8')) : [];
    const materials = new Map<string, string>(ledger.map(item => [item.source.id, item.materialId]));
    const previouslyVerified = ledger.length; let reusedAssociated = 0, newSubmissions = 0;
    try {
      for (const [index, item] of manifest.entries()) {
        if (index < previouslyVerified) {
          assert.equal(ledger[index].source.sha256, item.source.sha256);
          assert.equal(ledger[index].rows, item.rows); continue;
        }
        const selection = JSON.parse(readFileSync(item.path, 'utf8'));
        const rows = JSON.parse(readFileSync(item.path.replace('.json', '.rows.json'), 'utf8')) as any[];
        // The selected manifest gives a trusted file path; HTTP cannot choose runtime/store paths.
        const originalPath = item.path.slice(0, item.path.lastIndexOf('/选区/')) + '/原件/' + item.id + '.pdf';
        const bytes = readFileSync(originalPath); assert.equal(wfdSha256(bytes), item.source.sha256);
        if (!materials.has(item.id)) {
          const uploaded = await host.upload(item.id + '.pdf', 'data', bytes, 'finance-upload-' + item.id);
          const task = await host.settled(uploaded.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
          const material = host.services.materials!.getByTask(task.id)!;
          materials.set(item.id, material.envelope.materialId);
          assert.deepEqual(host.services.materials!.readOriginal(material.envelope.materialId).bytes, bytes);
        }
        const materialId = materials.get(item.id)!, requestId = 'finance-l2-' + index;
        const source = { source_id: 'cninfo-longxi-600592', provider: '巨潮资讯：福建龙溪轴承（集团）股份有限公司披露',
          requested_url: item.source.url, requested_at_utc: item.source.requestedAt, acquired_at_utc: item.source.acquiredAt,
          usage_scope: '本轮授权真实财报的隔离加工、披露口径结构化、固定发布与读回验收',
          authorization: { status: 'authorized', basis: '用户授权公开披露原件取证并完成真实财报样本闭环；本次仅写全新隔离BD/WFD库' } };
        const unit = item.key.endsWith('cny_per_share') ? 'cny_per_share' : 'cny';
        const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
          precision: 'day', sourceTimezone: 'UTC', fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: fieldCode === 'value' ? 'value_state' : 'metadata_state' })) };
        const target = { datasetId: 'financial_longxi_l2', outputKey: 'financial.l2.' + index,
          expectedParentSnapshotId: ledger.at(-1)?.snapshotId ?? null, subject: { kind: 'entity', namespace: 'full.chain.test', id: 'longxi_600592' },
          definition: { semantic_code: 'financial.l2.' + index, measurement_nature: 'mixed_observation', unit_code: 'per_field',
            definition_authority: 'full.chain.test', time_role: 'observation',
            field_definitions: fields.map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
              unit_code: field_code === 'value' ? unit : 'text', measurement_nature: field_code === 'value' ? 'mixed_observation' : 'relation', time_role: 'observation' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              time: { period_type: 'natural', frequency: 'source_reported_calendar_period', interval: 'half_open', timezone: 'UTC' },
              content: { assertion_status: 'published', target_period: selection.report.id },
              financial: { consolidation_scope: item.key.startsWith('parent') ? 'parent' : 'consolidated' } } },
          inputMode: 'partial_observation', coverage: { scope: { report: selection.report.id, revision: selection.report.version,
            statement: selection.regions[0].statement, scope: selection.regions[0].scope, unit, selected_pages: [...new Set(selection.regions.map((region: any) => region.page))] },
            basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        const values: Record<string, string> = { role: 'financial-record', informationNature: 'source_claim', purpose: source.usage_scope,
          businessObject: '龙溪股份600592及明确的合并或母公司口径', objectTime: '原披露实际起止日期；UTC仅作日期存储桶，不认领会计日历或历史公开资格',
          structureGranularity: '原报主表逐科目、期间、范围及单位的格值；空白和破折号未知；每股金额独立产品' };
        const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key] ?? key,
          evidence: [{ source: 'operator', field: key, quote: values[key] ?? key }] }]));
        let prior: any = null;
        if (resumeRoot) {
          try { prior = host.services.r1Workspace!.get(requestId); }
          catch (error) { if ((error as { code?: string }).code !== 'R1_WORKSPACE_REQUEST_NOT_FOUND') throw error; }
        }
        let planId: string, documentSha256: string;
        if (prior) {
          assert.equal(prior.state, 'associated', 'A confirmed but uncertain original request must be explicitly recovered before continuing.');
          planId = prior.planId; documentSha256 = prior.documentSha256; reusedAssociated++;
        } else {
        const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
          outputs: [{ outputId: 'disclosed', materialIds: [materialId], intendedAction: 'publish',
            tables: [{ materialId, format: 'pdf', pdfSelection: selection, types: { value: 'decimal_string' }, annotations: { metadata_state: 'valid_value' } }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: target.expectedParentSnapshotId },
            coverage: { complete: true, gaps: ['选定表区之外未纳入；跨页词面片段保留原文，不按相似科目自动合并'], scope: canonicalWfdJson(target.coverage.scope) } }] } }, 202);
        const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
        const run = await host.call('/processing/plans/' + planId + '/run', { requestId: requestId + '-run' }, 202);
        const task = await host.settled(run.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
        const plan = host.services.processing!.get(planId); assert.equal(plan.status, 'completed', JSON.stringify(plan));
        assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]));
        const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'disclosed', source, target, mapping }, 201);
        const submit = await host.call('/r1/requests/' + requestId + '/submit', { confirmationDigest: prepared.documentSha256 }, 202);
        const committed = await host.settled(submit.jobId, 180_000); assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
        documentSha256 = prepared.documentSha256; newSubmissions++;
        }
        const plan = host.services.processing!.get(planId);
        const view = await host.call('/r1/requests/' + requestId); assert.equal(view.state, 'associated', JSON.stringify(view));
        assert.equal(view.local.associations.length, rows.length);
        const association = view.local.associations[0];
        const actualRows = await fixedRows(host, association.snapshot_id, association.product_id);
        assert.equal(actualRows.length, rows.length);
        const byKey = new Map(rows.map(row => [row.business_key, row]));
        let checked = 0;
        for (const actual of actualRows) {
          const expected = byKey.get(actual.record_ref.logical_key ?? actual.record_ref.record_id); assert.ok(expected);
          for (const field of fields) { assert.equal(actual.values[field].value, expected[field]); checked++; }
          assert.equal(actual.values.value.value_state, expected.value_state);
          assert.equal(actual.values.value.unit.unit_code, unit);
        }
        const parseStep = plan.steps.find(step => step.kind === 'parse')!;
        const parsed = JSON.parse(host.services.processing!.artifact(planId, parseStep.stepId).bytes.toString());
        assert.equal(parsed.source_sha256, item.source.sha256);
        assert.equal(parsed.financial_evidence.records.length, rows.length);
        ledger.push({ requestId, planId, materialId, report: selection.report, source: item.source, rows: rows.length,
          checkedValues: checked, snapshotId: association.snapshot_id, productId: association.product_id,
          documentSha256, outputSha256: plan.outputs[0]!.structured?.sha256 });
        writeFileSync(join(fixture.root, 'financial-published-ledger.json'), JSON.stringify(ledger, null, 2));
      }
      await host.close(); host = await openFullChainHost(fixture);
      for (const item of ledger) {
        const recovered = await host.call('/r1/requests/' + item.requestId); assert.equal(recovered.state, 'associated');
        assert.equal(recovered.documentSha256, item.documentSha256); assert.equal(recovered.local.associations.length, item.rows);
        const actualRows = await fixedRows(host, item.snapshotId, item.productId);
        assert.equal(actualRows.length, item.rows);
      }
      writeFileSync(join(fixture.root, 'financial-restart-readback.json'), JSON.stringify({ reports: materials.size, outputs: ledger.length,
        rows: ledger.reduce((sum, item) => sum + item.rows, 0), fixedSnapshots: ledger.map(item => item.snapshotId),
        reopenedOriginalRequests: true, resubmitted: false, previouslyVerified, reusedAssociated, newSubmissions }, null, 2));
    } finally { await host.close(); }
  });

const financialFixturePath = process.env.XUAN_FINANCIAL_FIXTURE;
test('financial actual fixed consistency independently checks disclosed balance identities and every correction triad',
  { skip: !financialFixturePath || !process.env.WFD_PYTHON, timeout: 180_000 }, async () => {
    const fixture = JSON.parse(readFileSync(join(financialFixturePath!, 'financial-fixture.json'), 'utf8'));
    const l2 = JSON.parse(readFileSync(join(fixture.root, 'financial-published-ledger.json'), 'utf8')) as any[];
    const fixedLedger = readdirSync(fixture.root).filter(name => /^financial-fixed-(?!complete-).+\.json$/u.test(name)).sort().at(-1)!;
    const l3l4 = JSON.parse(readFileSync(join(fixture.root, fixedLedger), 'utf8')) as any[];
    const host = await openFullChainHost(fixture), proof: any[] = [];
    const value = (row: any, code: string) => row.values[code].value;
    const cents = (raw: string) => { assert.match(raw, /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u); const [whole, fraction = ''] = raw.split('.'); return BigInt(whole + fraction.padEnd(2, '0')); };
    try {
      for (const entry of l3l4.filter(entry => entry.operation === 'standardize' && entry.rows.some((row: any) => value(row, 'concept') === 'total_assets'))) {
        const rows = await fixedRows(host, entry.snapshotId, entry.productId);
        const groups = new Map<string, Map<string, any>>();
        for (const row of rows) {
          const key = [value(row, 'report_id'), value(row, 'dimension'), value(row, 'end_date')].join(':');
          const fields = groups.get(key) ?? new Map(); fields.set(value(row, 'concept'), row); groups.set(key, fields);
        }
        for (const [key, fields] of groups) {
          const assets = fields.get('total_assets'), liabilities = fields.get('total_liabilities'), equity = fields.get('total_equity');
          assert.ok(assets && liabilities && equity, key);
          assert.equal(cents(value(assets, 'value')), cents(value(liabilities, 'value')) + cents(value(equity, 'value')), key);
          proof.push({ relation: 'assets=liabilities+equity', key, snapshotId: entry.snapshotId, productId: entry.productId,
            records: [assets, liabilities, equity].map(row => ({ ref: row.record_ref, value: value(row, 'value') })) });
        }
      }
      assert.equal(proof.length, 10);
      for (const entry of l2.filter(entry => entry.report.id === 'longxi-correction-2024')) {
        const rows = await fixedRows(host, entry.snapshotId, entry.productId), groups = new Map<string, Map<string, any>>();
        for (const row of rows) {
          const key = ['scope', 'section', 'concept', 'end_date'].map(code => value(row, code)).join(':');
          const fields = groups.get(key) ?? new Map(); fields.set(value(row, 'dimension'), row); groups.set(key, fields);
        }
        for (const [key, fields] of groups) {
          const before = fields.get('before_correction'), adjustment = fields.get('adjustment'), after = fields.get('after_correction');
          assert.ok(before && adjustment && after, key);
          assert.equal(cents(value(before, 'value')) + cents(value(adjustment, 'value')), cents(value(after, 'value')), key);
          proof.push({ relation: 'before+adjustment=after', key, snapshotId: entry.snapshotId, productId: entry.productId,
            records: [before, adjustment, after].map(row => ({ ref: row.record_ref, value: value(row, 'value') })) });
        }
      }
      assert.equal(proof.length, 32);
      writeFileSync(join(fixture.root, 'financial-independent-fixed-identities.json'), JSON.stringify({ balanceRelations: 10,
        correctionTriads: 22, source: 'actual fixed WFD rows through normal application reader', exactCents: true, proof }, null, 2));
    } finally { await host.close(); }
  });

test('financial fixed application entry standardizes actual pinned L2 records and publishes legal quarters/TTM with source-version evidence',
  { skip: !financialFixturePath || !process.env.WFD_PYTHON, timeout: 1_800_000 }, async () => {
    const fixture = JSON.parse(readFileSync(join(financialFixturePath!, 'financial-fixture.json'), 'utf8'));
    const l2 = JSON.parse(readFileSync(join(fixture.root, 'financial-published-ledger.json'), 'utf8')) as any[];
    let host = await openFullChainHost(fixture);
    const run = Date.now().toString(36), ledger: any[] = [], normalized: any[] = [];
    const valueOf = (row: any, key: string) => row.values[key].value;
    const rowKey = (row: any) => row.record_ref.logical_key ?? row.record_ref.record_id;
    const ref = (item: any, rows: any[]) => ({ snapshotId: item.snapshotId, productId: item.productId, businessKeys: rows.map(rowKey) });
    try {
      let parent = (await host.services.r1Workspace!.snapshotStatus()).snapshotId;
      const publish = async (calculation: FinancialCalculation, materialId: string, source: any) => {
        const index = ledger.length, requestId = `finance-fixed-${run}-${index}`;
        const targetFields = [...fields, 'original_concept'];
        const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC',
          fields: targetFields.map(fieldCode => ({ fieldCode, value: fieldCode, state: fieldCode === 'value' ? 'value_state' : 'metadata_state' })) };
        const target = { datasetId: 'financial_fixed_' + run, outputKey: 'financial.' + calculation.operation + '.' + run + '.' + index,
          expectedParentSnapshotId: parent, subject: { kind: 'entity', namespace: 'full.chain.test', id: 'longxi_600592' },
          definition: { semantic_code: 'financial.' + calculation.operation + '.' + run + '.' + index, measurement_nature: 'derived', unit_code: 'per_field',
            definition_authority: 'full.chain.test', time_role: 'observation', algorithm_definition: financialAlgorithmDefinition(calculation.operation),
            field_definitions: targetFields.map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
              unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'derived', time_role: 'observation' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'deterministic_derived',
              time: { period_type: 'natural', frequency: calculation.operation === 'standardize' ? 'source_reported_calendar_period' : calculation.operation,
                interval: 'half_open', timezone: 'UTC' }, financial: { consolidation_scope: 'consolidated' } } },
          inputMode: 'partial_observation', coverage: { scope: { company: '600592', operation: calculation.operation },
            basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        const dimensionValues = { role: 'calculated_result', informationNature: 'deterministic_derived', businessObject: '龙溪股份600592的合并财务报表固定记录',
          objectTime: '明确日期期间，固定输入内容视角，不主张历史公开时间资格', purpose: source.usage_scope,
          structureGranularity: '受信WFD固定记录的CAS主表科目映射或已登记可加流量期间派生' };
        const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: dimensionValues[key],
          evidence: [{ source: 'operator', field: key, quote: dimensionValues[key] }] }]));
        const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'calculated', materialIds: [materialId],
            intendedAction: 'publish', tables: [{ materialId, format: 'financial-fixed', financialCalculation: calculation,
              types: { value: 'decimal_string' }, annotations: { metadata_state: 'valid_value' } }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
        const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
        const execution = await host.call('/processing/plans/' + planId + '/run', { requestId: requestId + '-run' }, 202);
        const task = await host.settled(execution.jobId, 180_000); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
        const plan = host.services.processing!.get(planId); assert.equal(plan.status, 'completed', JSON.stringify(plan));
        assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]));
        const parsedStep = plan.steps.find(step => step.kind === 'parse')!;
        const parsed = JSON.parse(host.services.processing!.artifact(planId, parsedStep.stepId).bytes.toString());
        const proof = parsed.financial_evidence;
        assert.equal(proof.version, 'bd-financial-fixed/1'); assert.equal(proof.inputs.length, calculation.inputs.length);
        assert.ok(proof.inputs.every((input: any) => input.recordVersions.length === input.businessKeys.length));
        const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'calculated', source, target, mapping }, 201);
        const submit = await host.call('/r1/requests/' + requestId + '/submit', { confirmationDigest: prepared.documentSha256 }, 202);
        const committed = await host.settled(submit.jobId, 180_000); assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
        const view = await host.call('/r1/requests/' + requestId); assert.equal(view.state, 'associated');
        const associated = view.local.associations[0], rows = await fixedRows(host, associated.snapshot_id, associated.product_id);
        assert.equal(rows.length, proof.outputRows); parent = associated.snapshot_id;
        const entry = { requestId, planId, materialId, operation: calculation.operation, snapshotId: parent,
          productId: associated.product_id, rows, proof, documentSha256: prepared.documentSha256 };
        ledger.push(entry); writeFileSync(join(fixture.root, 'financial-fixed-' + run + '.json'), JSON.stringify(ledger, null, 2));
        return entry;
      };
      for (const item of l2.filter(item => item.report && !item.productId.endsWith('unused'))) {
        const originalRows = await fixedRows(host, item.snapshotId, item.productId);
        if (valueOf(originalRows[0], 'scope') !== 'consolidated' || valueOf(originalRows[0], 'unit') !== 'cny'
          || !['balance_sheet', 'income_statement', 'cash_flow'].includes(valueOf(originalRows[0], 'statement'))
          || item.report.id === 'longxi-correction-2024') continue;
        const source = { source_id: 'longxi-fixed-financial-computation', provider: 'BD受控固定财务映射', requested_url: item.source.url,
          requested_at_utc: item.source.requestedAt, acquired_at_utc: item.source.acquiredAt, usage_scope: '用户授权真实财报的隔离L3标准化及L4确定性期间派生验收',
          authorization: { status: 'authorized', basis: '用户授权本轮财报样本、受信固定行读取和受控财务映射计算，不扩大为历史回测资格' } };
        const calculation: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'standardize', inputs: [ref(item, originalRows)] };
        const entry = await publish(calculation, item.materialId, source); normalized.push({ ...entry, report: item.report, source });
      }
      assert.equal(normalized.length, 15, 'The five selected company reports each contribute the three registered consolidated monetary primary statements.');
      const find = (report: string, end: string, concept = 'net_profit_total', dimension = 'current') => {
        const item = normalized.find(item => item.report.id === 'longxi-' + report && item.rows.some((row: any) => valueOf(row, 'concept') === concept)); assert.ok(item, report);
        const rows = item.rows.filter((row: any) => valueOf(row, 'concept') === concept && valueOf(row, 'end_date') === end && valueOf(row, 'dimension') === dimension);
        assert.equal(rows.length, 1); return { item, row: rows[0], ref: ref(item, rows) };
      };
      const q1 = find('quarter1-2024-corrected', '2024-03-31'), half = find('half-2024-corrected', '2024-06-30'),
        nine = find('quarter3-2024-corrected', '2024-09-30'), annual = find('annual-2024', '2024-12-31');
      const q2 = await publish({ version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [half.ref, q1.ref] }, half.item.materialId, half.item.source);
      assert.equal(valueOf(q2.rows[0], 'value'), '29347286.84');
      const q3 = await publish({ version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [nine.ref, half.ref] }, nine.item.materialId, nine.item.source);
      assert.equal(valueOf(q3.rows[0], 'value'), '96446460.11');
      const sourceRoot = manifestPath!.slice(0, manifestPath!.lastIndexOf('/'));
      const correctionBytes = readFileSync(join(sourceRoot, '原件/correction-2024.pdf'));
      const converted = await pdfNative(correctionBytes, new AbortController().signal);
      const textBytes = Buffer.from(converted.text!);
      const held = await host.upload('correction-2024-native.txt', 'data', textBytes, 'finance-correction-text-' + run);
      const heldTask = await host.settled(held.jobId); assert.equal(heldTask.status, 'succeeded');
      const heldMaterialId = host.services.materials!.getByTask(heldTask.id)!.envelope.materialId;
      const quote = (converted.content as any).pages[0].text as string;
      const review = { materialId: heldMaterialId, originalSha256: wfdSha256(textBytes), quote };
      writeFileSync(join(fixture.root, 'correction-text-provenance-' + run + '.json'), JSON.stringify({ sourcePdfSha256: wfdSha256(correctionBytes),
        adapter: 'pdfjs-dist/6.4.299', derivedTextSha256: wfdSha256(textBytes), materialId: heldMaterialId, originalPage: 1, quote }, null, 2));
      const q4 = await publish({ version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [annual.ref, nine.ref], compatibilityReview: review }, heldMaterialId, nine.item.source);
      assert.equal(valueOf(q4.rows[0], 'value'), '-17259858.12');
      const priorAnnual = find('annual-2024', '2023-12-31', 'net_profit_total', 'comparison'), priorNine = find('quarter3-2024-corrected', '2023-09-30', 'net_profit_total', 'comparison');
      const ttm = await publish({ version: 'bd-financial-fixed/1', operation: 'ttm', inputs: [priorAnnual.ref, nine.ref, priorNine.ref], compatibilityReview: review }, heldMaterialId, nine.item.source);
      assert.equal(valueOf(ttm.rows[0], 'value'), '161679735');
      const nineRevenue = find('quarter3-2024-corrected', '2024-09-30', 'revenue'), halfRevenue = find('half-2024-corrected', '2024-06-30', 'revenue');
      const revenueQ3 = await publish({ version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [nineRevenue.ref, halfRevenue.ref] }, nine.item.materialId, nine.item.source);
      assert.equal(valueOf(revenueQ3.rows[0], 'value'), '456780603.01', 'Matches independently disclosed 2024Q3 single-quarter revenue in official corrected Q3 PDF page 1.');
      await host.close(); host = await openFullChainHost(fixture);
      for (const entry of ledger) {
        assert.equal((await host.call('/r1/requests/' + entry.requestId)).state, 'associated');
        const rows = await fixedRows(host, entry.snapshotId, entry.productId); assert.deepEqual(rows, entry.rows);
      }
      writeFileSync(join(fixture.root, 'financial-fixed-complete-' + run + '.json'), JSON.stringify({ standardizationOutputs: normalized.length,
        derivedOutputs: ledger.length - normalized.length, reopenedFixedRows: true, totalRows: ledger.reduce((sum, entry) => sum + entry.rows.length, 0),
        q2: '29347286.84', q3: '96446460.11', q4: '-17259858.12', netProfitTTM: '161679735', revenueQ3: '456780603.01' }, null, 2));
    } finally { await host.close(); }
  });

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { openPdf } from '../../platform/capabilities/conversion/pdf.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import type { FinancialPdfSelection } from '../../modules/collection/data-processing/financial-pdf.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const root = process.env.XUAN_OFFICIAL_FINANCIAL_ROOT;
const stagedRoot = process.env.XUAN_OFFICIAL_CORRECTION_AFTER_PUBLICATION_ROOT;
const enabled = !!root && !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const pinned = [
  { id: 'original-q1', url: 'https://static.cninfo.com.cn/finalpage/2024-04-27/1219876115.PDF',
    sha256: '4cdaa8a953995c5bfe0dc5ef056706b89e22c9cc25ce1658e9c81664f398b91f', page: 8, y: 753.48, expected: '546936730.12', archiveDate: '2024-04-27' },
  { id: 'corrected-q1', url: 'https://static.cninfo.com.cn/finalpage/2025-04-30/1223426121.PDF',
    sha256: '0675d50c70d2f130b404853c43427d233b19e764aa944dfb3795972a8637b929', page: 7, y: 185.45, expected: '473861731.94', archiveDate: '2025-04-30' },
  { id: 'correction-2024', url: 'https://static.cninfo.com.cn/finalpage/2025-04-30/1223426127.PDF',
    sha256: '3ffffb22d327f84001562d3f8de047fff6a6fc25be181ade6440374098c4ebeb', page: 2, y: 384.17, expected: '', archiveDate: '2025-04-30' },
];
const fields = ['report_id', 'report_version', 'subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'audit_status',
  'statement', 'scope', 'section', 'concept', 'dimension', 'period_type', 'start_date', 'end_date', 'unit', 'value'];
const numericFormat = { decimal: '.', grouping: ',', negative: 'minus', plus: false, percent: 'reject' } as const;
/** Coordinates/labels and metadata are manually checked against source pages, not auto-inferred. */
function selection(item: typeof pinned[number], stable = false): FinancialPdfSelection {
  const notice = item.id === 'correction-2024';
  return { version: 'bd-financial-pdf-regions/1', sourceSha256: item.sha256,
    ...(stable && !notice ? { factIdentity: { version: 'bd-financial-fact/1' as const, seriesId: 'longxi-600592-q1-revenue-correction-2025-04',
      periodBasis: 'Selected reports explicitly state 2024-01-01 through 2024-03-31; no annual fiscal-calendar assertion',
      basis: 'Operator-declared same selected consolidated revenue fact; correction notice SHA 3ffffb22d327f84001562d3f8de047fff6a6fc25be181ade6440374098c4ebeb page 2 before/after row',
      assertion: 'same_fact_across_report_editions' as const } } : {}),
    report: { id: 'longxi-600592-2024-q1', version: item.id, subjectScheme: 'SSE', subjectCode: '600592',
      accountingStandard: 'CAS', currency: 'CNY', auditStatus: notice ? 'not_asserted_for_notice' : 'unaudited' },
    regions: [{ page: item.page, yMin: item.y - 2, yMax: item.y + 2, statement: notice ? 'correction_notice' : 'income_statement',
      scope: 'consolidated', section: 'selected_revenue_only', label: notice ? [115, 210] : [85, 300],
      expectedLabels: [notice ? '营业收入' : '其中：营业收入'], rowBands: [{ yMin: item.y - 2, yMax: item.y + 2 }],
      columns: (notice ? [[215, 310, 'before'], [320, 420, 'adjustment'], [435, 530, 'after']] : [[325, 415, 'current_period']])
        .map(([xMin, xMax, dimension]) => ({ xMin: Number(xMin), xMax: Number(xMax), dimension: String(dimension),
          periodType: 'duration', startDate: '2024-01-01', endDate: '2024-03-31', unit: 'cny', numericFormat })) }] };
}
async function execute(host: FullChainHost, id: string, input: any) {
  const accepted = await host.call('/processing/plans', { requestId: id + '-plan', input }, 202);
  const planned = await host.settled(accepted.jobId);
  assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const step of host.services.processing!.get(planId).steps) {
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: id + '-' + step.stepId }, 202);
    const done = await host.settled(run.jobId);
    if (done.status !== 'succeeded') return { planId, done };
  }
  return { planId, done: { status: 'succeeded', error: null } };
}

for (const mode of ['independent', 'direct', 'quality'] as const) test('official PDF fixed source pipeline: ' + mode,
  { skip: mode === 'quality' && !stagedRoot ? 'Requires explicit new post-publication capture directory; test never fetches.' : !enabled ? 'Requires downloaded official manifest, explicit WFD_PYTHON and isolated root; never fetches automatically.' : false, timeout: 300_000 }, async () => {
    const stable = mode !== 'independent';
    const qualityCase = 'official-selected-revenue';
    let originalPlanId = '';
    const manifest = JSON.parse(readFileSync(join(root!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'official_financial_correction_probe'); assert.equal(manifest.synthetic, false);
    const fixture = createFullChainFixture({ name: 'official-financial-correction', machine: true,
      units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture), snapshotId: string | null = null;
    let correction: any = null;
    const selectedFields = stable ? [...fields, 'financial_fact_identity'] : fields;
    const fixed: any[] = [], materials: string[] = [], originalRows: any[] = [], heldTimes: string[] = [];
    let holdingInstance: string | null = null;
    assert.equal((await host.call('/r1/products/snapshot', {})).holdingInstance, null, 'Read-only empty status must not create an instance');
    try {
      for (const item of pinned) {
        if (item.id === 'corrected-q1' && heldTimes[0]) {
          const wait = Date.parse(heldTimes[0]) + 1100 - Date.now();
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        let captureRoot = root!, captureManifest = manifest;
        if (mode === 'quality' && item.id === 'corrected-q1') {
          assert.notEqual(stagedRoot, root, 'Post-publication capture must not reuse the initial directory');
          assert.equal(existsSync(join(stagedRoot!, 'manifest.json')), false,
            'Start a new capture only after the original publication ready signal');
          console.log('OFFICIAL_QUALITY_AWAITING_NEW_CAPTURE ' + stagedRoot);
          const deadline = Date.now() + 90_000;
          while (!existsSync(join(stagedRoot!, 'manifest.json')) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 100));
          assert.ok(existsSync(join(stagedRoot!, 'manifest.json')), 'New official capture did not arrive within 90 seconds');
          captureRoot = stagedRoot!;
          captureManifest = JSON.parse(readFileSync(join(captureRoot, 'manifest.json'), 'utf8'));
          assert.equal(captureManifest.kind, 'official_financial_correction_probe');
          assert.equal(captureManifest.synthetic, false);
        }
        const receipt = captureManifest.sources.find((entry: any) => entry.id === item.id);
        assert.equal(receipt.url, item.url); assert.equal(receipt.status, 200); assert.equal(receipt.sha256, item.sha256);
        const bytes = readFileSync(join(captureRoot, item.id + '.pdf'));
        assert.equal(wfdSha256(bytes), item.sha256); assert.equal(bytes.length, receipt.bytes);
        const loading = await openPdf(bytes);
        try {
          const pdf = await loading.promise, last = await pdf.getPage(pdf.numPages);
          const content = await last.getTextContent({ disableNormalization: true });
          const footer = content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').replace(/\s+/gu, '');
          assert.ok(footer.includes(item.id === 'correction-2024' ? '2025年4月29日' : '2024年4月26日'),
            'Corrected report retains original signed date; never promote that footer to correction public time');
        } finally { await loading.destroy(); }
        const uploaded = await host.upload(item.id + '.pdf', 'data', bytes, item.id + '-upload');
        assert.equal((await host.settled(uploaded.jobId)).status, 'succeeded');
        const materialId = host.services.materials!.getByTask(uploaded.jobId)!.envelope.materialId; materials.push(materialId);
        const source = { source_id: 'cninfo-longxi-600592', provider: '龙溪股份通过巨潮资讯公开披露', requested_url: item.url,
          requested_at_utc: receipt.requestedAt, acquired_at_utc: receipt.acquiredAt,
          usage_scope: 'Selected official financial correction evidence in isolated BD/WFD test only',
          authorization: { status: 'authorized', basis: 'User requested free official sample verification; isolated selected-cell publication' } };
        const target: any = { datasetId: 'official_longxi_q1', outputKey: 'financial.source.revenue', expectedParentSnapshotId: snapshotId,
          subject: { kind: 'entity', namespace: 'full.chain.test', id: 'longxi_600592' },
          definition: { semantic_code: 'financial.source.revenue', measurement_nature: 'mixed_observation', unit_code: 'per_field',
            definition_authority: 'full.chain.test', time_role: 'observation',
            field_definitions: selectedFields.map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
              unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'flow', time_role: 'observation' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              identity: { identity_resolution_rule: stable ? 'explicit_selected_financial_fact_axes' : 'explicit_report_edition_and_selected_axes' },
              coverage_quality: { completeness: 'partial', absence_means: 'unknown' },
              time: { period_type: 'natural', frequency: 'source_reported_calendar_period', interval: 'half_open', timezone: 'UTC' } } },
          inputMode: 'partial_observation', coverage: { scope: { issuer: '600592', report: item.id, selectedPage: item.page, selectedConcept: 'revenue' },
            basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        if (stable && item.id === 'corrected-q1') Object.assign(target, { inputMode: 'source_correction', definitionMode: 'reuse',
          definition: correction.definition, definitionRef: correction.definitionRef, revisions: { [correction.previous.logical_key]: { previous: correction.previous, reason: 'Explicit same selected fact, official correction notice before/after row' } } });
        const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
          precision: 'day', sourceTimezone: 'UTC', fields: selectedFields.map(fieldCode => ({ fieldCode, value: fieldCode,
            state: fieldCode === 'value' ? 'value_state' : 'metadata_state' })) };
        const adopted: Record<string, string> = { role: 'financial-record', informationNature: 'source_claim', purpose: source.usage_scope,
          businessObject: '600592 consolidated revenue', objectTime: 'Source-stated January-March 2024; not historical availability',
          structureGranularity: 'Manually selected native PDF row; exact original label and amount' };
        const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: adopted[key],
          evidence: [{ source: 'operator', field: key, quote: adopted[key] }] }]));
        const isNotice = item.id === 'correction-2024';
        const work = await execute(host, item.id, { routing: { materials: [{ materialId, dimensions, intendedAction: isNotice ? 'inspect' : 'publish' }] },
          outputs: [{ outputId: 'selected', materialIds: [materialId], intendedAction: isNotice ? 'inspect' : 'publish',
            stages: isNotice ? ['parse'] : ['parse', 'structure', 'annotate', 'check'],
            tables: [{ materialId, format: 'pdf', pdfSelection: selection(item, stable), types: { value: 'decimal_string' },
              annotations: { metadata_state: 'valid_value' } }],
            ...(!isNotice ? { target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping },
              expectedSnapshotId: snapshotId } } : {}) }] });
        assert.equal(work.done.status, 'succeeded', JSON.stringify(work.done.error));
        const plan = host.services.processing!.get(work.planId), parse = plan.steps.find(step => step.kind === 'parse')!;
        const artifact = JSON.parse(host.services.processing!.artifact(work.planId, parse.stepId).bytes.toString());
        assert.equal(artifact.financial_evidence.sourceSha256, item.sha256);
        assert.equal(artifact.financial_evidence.selectedScopeOnly, true);
        if (isNotice) {
          const values = artifact.financial_evidence.records.map((record: any) => record.value);
          assert.deepEqual(values, ['546936730.12', '-73074998.18', '473861731.94']);
          // Independent exact integer-cents check of this notice, not a new financial algorithm.
          assert.equal(54693673012n - 7307499818n, 47386173194n);
          continue;
        }
        assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan.outputs[0]!.gaps));
        let requestId = item.id;
        if (mode === 'quality' && item.id === 'corrected-q1') {
          const capabilities = await host.call('/corrections/capabilities');
          await host.call('/corrections/cases', { requestId: 'official-register', input: {
            caseId: qualityCase, kind: 'source_correction', errorType: 'source_content_correction',
            discoveredAt: new Date().toISOString(),
            evidence: 'Official notice SHA ' + pinned[2]!.sha256 + ' page 2: selected consolidated Q1 revenue 546936730.12 → 473861731.94; operator-declared complete fact axes only.',
            binding: { planOutput: { planId: originalPlanId, outputId: 'selected' } },
            connectionSha256: capabilities.connectionSha256 } }, 201);
          const path = '/corrections/cases/' + qualityCase;
          const impact = await host.call(path + '/impact', { requestId: 'official-impact' });
          assert.equal(impact.state, 'impact_frozen', JSON.stringify(impact));
          assert.equal(impact.coverage, 'proven_subset_only');
          assert.equal(impact.items.length, 1);
          assert.equal(impact.items[0].kind, 'original');
          assert.equal(impact.items[0].recordVersion, correction.previous.revision_id);
          assert.equal((await host.call(path + '/suspend', { requestId: 'official-suspend' })).state, 'suspended');
          const prepared = await host.call(path + '/prepare', { requestId: 'official-prepare', input: {
            planId: work.planId, outputId: 'selected', originalSha256: item.sha256,
            expectedParentSnapshotId: snapshotId, reason: 'Official corrected PDF, same explicitly selected financial fact',
            sourceRevision: { sourceId: source.source_id, provider: source.provider, requestedUrl: item.url,
              requestedAtUtc: receipt.requestedAt, acquiredAtUtc: receipt.acquiredAt,
              revisionBasis: 'New capture observation, not disclosure time; notice SHA ' + pinned[2]!.sha256 + ' page 2 before/after revenue',
              usageScope: source.usage_scope, originalSha256: item.sha256, previousOriginalSha256: pinned[0]!.sha256 } } });
          const authorized = await host.call(path + '/authorize', { requestId: 'official-authorize', input: {
            frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256 } }, 202);
          const waiting = await host.settled(authorized.id);
          assert.equal(waiting.status, 'waiting_approval', JSON.stringify(waiting));
          host.services.tasks.approve(waiting.approvalId!);
          const done = await host.settled(authorized.id);
          assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
          const resolved = await host.call(path);
          assert.equal(resolved.state, 'resolved', JSON.stringify(resolved));
          assert.ok(resolved.items.every((entry: any) => entry.state === 'corrected'));
          const publishedSnapshot = (await host.services.r1Runtime!.connection.client.snapshotStatus()).result;
          // Explicit local receipt-loss fault injection, not an actual outage or source event.
          host.database.connection.prepare("UPDATE correction_cases SET state='blocked',result_json=NULL WHERE case_id=?").run(qualityCase);
          await host.call(path + '/recover', { requestId: 'official-same-identity-recovery' });
          assert.equal((await host.call(path)).state, 'resolved');
          assert.deepEqual((await host.services.r1Runtime!.connection.client.snapshotStatus()).result, publishedSnapshot);
          assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_record_associations WHERE request_id=?')
            .get('correction:' + qualityCase)!.n, 1);
          requestId = 'correction:' + qualityCase;
        } else {
          const prepared = await host.call('/r1/prepare', { requestId, planId: work.planId, outputId: 'selected', source, target, mapping }, 201);
          const submitted = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
          assert.equal((await host.settled(submitted.jobId)).status, 'succeeded');
        }
        if (item.id === 'original-q1') originalPlanId = work.planId;
        const view = await host.call(`/r1/requests/${requestId}`); assert.equal(view.state, 'associated');
        const association = view.local.associations[0]; snapshotId = association.snapshot_id;
        const read = await host.call('/r1/products/read', { snapshotId, productId: association.product_id });
        const row = read.result.rows.find((row: any) => row.values.report_version.value === item.id);
        assert.equal(row.values.value.value, item.expected); assert.equal(row.values.currency.value, 'CNY');
        assert.equal(row.values.scope.value, 'consolidated'); assert.equal(row.values.unit.value, 'cny');
        if (stable) {
          const rawFixed = (await host.services.r1Runtime!.client.fixedRead(snapshotId!, association.product_id)).result as any;
          correction = { previous: rawFixed.rows[0].record_ref, definitionRef: rawFixed.products[0].definition_ref, definition: rawFixed.products[0].declaration };
        }
        const status = await host.call('/r1/products/snapshot', {});
        assert.equal(status.holdingInstance.bindingSource, 'target_instance');
        holdingInstance ??= status.holdingInstance.instanceId;
        assert.equal(status.holdingInstance.instanceId, holdingInstance);
        const held = await host.call('/r1/products/read', { snapshotId, productId: association.product_id,
          historyMode: 'system_held_at', at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
          heldScope: holdingInstance, usableStage: 'published_readable' });
        const heldRow = held.result.rows.find((value: any) => value.record_ref.revision_id === row.record_ref.revision_id);
        assert.ok(heldRow); assert.equal(heldRow.usable_stage, 'published_readable');
        assert.equal(heldRow.held_scope, holdingInstance); assert.equal(heldRow.eligibility.decision, 'eligible');
        assert.ok(Number.isFinite(Date.parse(heldRow.held_at))); heldTimes.push(heldRow.held_at);
        assert.notEqual(heldRow.held_at.slice(0, 10), item.archiveDate, 'Host holding time is not market archive time');
        originalRows.push(row);
        fixed.push({ snapshotId, productId: association.product_id, businessKeys: [row.record_ref.logical_key] });
        console.log('OFFICIAL_CORRECTION_SELECTED ' + JSON.stringify({ id: item.id, sha256: item.sha256, page: item.page,
          archiveDate: item.archiveDate, archiveDatePrecision: 'day_only_not_public_instant', value: item.expected,
          selectedScopeOnly: true, publication: stable ? 'isolated_explicit_selected_fact_correction' : 'isolated_source_claim_not_source_correction' }));
      }
      assert.ok(Date.parse(heldTimes[1]!) > Date.parse(heldTimes[0]!));
      const heldInput = { snapshotId, productId: fixed[1].productId, historyMode: 'system_held_at',
        heldScope: holdingInstance, usableStage: 'published_readable' };
      const beforeCorrection = await host.call('/r1/products/read', { ...heldInput, at: heldTimes[0] }, mode === 'quality' ? 409 : 200);
      if (mode === 'quality') assert.equal(beforeCorrection.code, 'USAGE_KNOWN_ISSUE_LEGACY');
      else {
        assert.equal(beforeCorrection.result.rows.length, 1);
        assert.equal(beforeCorrection.result.rows[0].values.value.value, '546936730.12');
      }
      const afterCorrection = await host.call('/r1/products/read', { ...heldInput, at: heldTimes[1] });
      assert.equal(afterCorrection.result.rows.length, stable ? 1 : 2);
      assert.ok(afterCorrection.result.rows.some((row: any) => row.values.value.value === '473861731.94'));
      for (const stage of ['acquired', 'custodied']) {
        const missingStage = await host.call('/r1/products/read', { ...heldInput, usableStage: stage, at: heldTimes[1] }, 409);
        assert.equal(missingStage.code, 'INSTANCE_HOLDING_UNKNOWN');
      }
      for (const [index, ref] of fixed.entries()) {
        const work = await execute(host, 'standardize-' + index, { routing: { materials: [{ materialId: materials[index], intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'mapped', materialIds: [materials[index]], intendedAction: 'inspect', stages: ['parse'],
            tables: [{ materialId: materials[index], format: 'financial-fixed', financialCalculation: {
              version: 'bd-financial-fixed/1', operation: 'standardize', inputs: [ref],
              history: { historyMode: 'system_held_at', at: heldTimes[index], heldScope: holdingInstance, usableStage: 'published_readable' } } }] }] });
        if (mode === 'quality' && index === 0) {
          assert.equal(work.done.status, 'failed');
          assert.match(JSON.stringify(work.done.error), /USAGE_KNOWN_ISSUE_LEGACY/u);
          continue;
        }
        assert.equal(work.done.status, 'succeeded', JSON.stringify(work.done.error));
        const artifact = JSON.parse(host.services.processing!.artifact(work.planId, 'parse:mapped:0').bytes.toString());
        assert.equal(artifact.financial_evidence.historicalQualification, 'system_held_at');
        assert.equal(artifact.rows[0][artifact.columns.indexOf('value')].value, pinned[index]!.expected);
      }
      const compatible = await execute(host, 'unasserted-compatibility', {
        routing: { materials: [{ materialId: materials[1], intendedAction: 'inspect' }] },
        outputs: [{ outputId: 'mapped', materialIds: [materials[1]], intendedAction: 'inspect', stages: ['parse'],
          tables: [{ materialId: materials[1], format: 'financial-fixed', financialCalculation: {
            version: 'bd-financial-fixed/1', operation: 'standardize', inputs: [fixed[1]],
            compatibleInputs: { periodType: 'duration', periods: [{ startDate: '2024-01-01', endDate: '2024-03-31' }] } } }] }] });
      assert.equal(compatible.done.status, 'failed');
      assert.match(JSON.stringify(compatible.done.error), /report_nature/u,
        'Official PDF source alone does not supply the additional compatible-input declarations');
      const historical = await host.call('/r1/products/read', { snapshotId: fixed[1].snapshotId, productId: fixed[1].productId,
        historyMode: 'market_known_at', at: '2025-05-01T00:00:00Z' }, 409);
      assert.equal(historical.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      // Default keeps both editions; only explicit complete fact identity opts into source correction.
      const latest = await host.call('/r1/products/read', { snapshotId, productId: fixed[1].productId });
      assert.equal(latest.result.rows.length, stable ? 1 : 2);
      assert.deepEqual(latest.result.rows.map((row: any) => row.values.value.value).sort(), stable ? ['473861731.94'] : ['473861731.94', '546936730.12']);
      await host.close(); host = await openFullChainHost(fixture);
      if (mode === 'quality') assert.equal((await host.call('/corrections/cases/' + qualityCase)).state, 'resolved');
      assert.equal((await host.call('/r1/products/snapshot', {})).holdingInstance.instanceId, holdingInstance);
      const reopenedHistory = await host.call('/r1/products/read', { ...heldInput, at: heldTimes[0] }, mode === 'quality' ? 409 : 200);
      if (mode === 'quality') assert.equal(reopenedHistory.code, 'USAGE_KNOWN_ISSUE_LEGACY');
      else assert.deepEqual(reopenedHistory.result.rows, beforeCorrection.result.rows);
      for (const [index, ref] of fixed.entries()) {
        if (mode === 'quality' && index === 0) {
          const audit = await host.call(`/corrections/cases/${qualityCase}/audit?snapshotId=${ref.snapshotId}&productId=${ref.productId}`);
          assert.equal(audit.publishable, false);
          assert.equal(audit.rows.length, 1);
          const original = originalRows[index];
          // Audit returns raw payload; the public reader adds resolved unit/field metadata.
          const rawValues = Object.fromEntries(Object.entries(original.values).map(([key, cell]) => {
            const { unit: _unit, field_code: _fieldCode, ...raw } = cell as any;
            return [key, raw];
          }));
          assert.deepEqual(audit.rows[0].row, { business_key: original.record_ref.logical_key,
            observation_time: original.business_time, subject: original.subject, values: rawValues });
          continue;
        }
        const read = await host.call('/r1/products/read', { snapshotId: ref.snapshotId, productId: ref.productId });
        assert.deepEqual(read.result.rows.find((row: any) => row.record_ref.logical_key === ref.businessKeys[0]), originalRows[index]);
      }
    } finally { await host.close(); }
  });

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { openPdf } from '../../platform/capabilities/conversion/pdf.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import type { FinancialPdfSelection } from '../../modules/collection/data-processing/financial-pdf.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const root = process.env.XUAN_OFFICIAL_FINANCIAL_ROOT;
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
function selection(item: typeof pinned[number]): FinancialPdfSelection {
  const notice = item.id === 'correction-2024';
  return { version: 'bd-financial-pdf-regions/1', sourceSha256: item.sha256,
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

test('official original, corrected report and correction notice preserve native cells through BD and fixed WFD reads without inventing revision eligibility',
  { skip: !enabled ? 'Requires downloaded official manifest, explicit WFD_PYTHON and isolated root; never fetches automatically.' : false, timeout: 300_000 }, async () => {
    const manifest = JSON.parse(readFileSync(join(root!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'official_financial_correction_probe'); assert.equal(manifest.synthetic, false);
    const fixture = createFullChainFixture({ name: 'official-financial-correction', machine: true,
      units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture), snapshotId: string | null = null;
    const fixed: any[] = [], materials: string[] = [], originalRows: any[] = [];
    try {
      for (const item of pinned) {
        const receipt = manifest.sources.find((entry: any) => entry.id === item.id);
        assert.equal(receipt.url, item.url); assert.equal(receipt.status, 200); assert.equal(receipt.sha256, item.sha256);
        const bytes = readFileSync(join(root!, item.id + '.pdf'));
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
        const target = { datasetId: 'official_longxi_q1', outputKey: 'financial.source.revenue', expectedParentSnapshotId: snapshotId,
          subject: { kind: 'entity', namespace: 'full.chain.test', id: 'longxi_600592' },
          definition: { semantic_code: 'financial.source.revenue', measurement_nature: 'mixed_observation', unit_code: 'per_field',
            definition_authority: 'full.chain.test', time_role: 'observation',
            field_definitions: fields.map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
              unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'flow', time_role: 'observation' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              time: { period_type: 'natural', frequency: 'source_reported_calendar_period', interval: 'half_open', timezone: 'UTC' } } },
          inputMode: 'partial_observation', coverage: { scope: { issuer: '600592', report: item.id, selectedPage: item.page, selectedConcept: 'revenue' },
            basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
          precision: 'day', sourceTimezone: 'UTC', fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode,
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
            tables: [{ materialId, format: 'pdf', pdfSelection: selection(item), types: { value: 'decimal_string' },
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
        const prepared = await host.call('/r1/prepare', { requestId: item.id, planId: work.planId, outputId: 'selected', source, target, mapping }, 201);
        const submitted = await host.call(`/r1/requests/${item.id}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        assert.equal((await host.settled(submitted.jobId)).status, 'succeeded');
        const view = await host.call(`/r1/requests/${item.id}`); assert.equal(view.state, 'associated');
        const association = view.local.associations[0]; snapshotId = association.snapshot_id;
        const read = await host.call('/r1/products/read', { snapshotId, productId: association.product_id });
        const row = read.result.rows.find((row: any) => row.values.report_version.value === item.id);
        assert.equal(row.values.value.value, item.expected); assert.equal(row.values.currency.value, 'CNY');
        assert.equal(row.values.scope.value, 'consolidated'); assert.equal(row.values.unit.value, 'cny');
        originalRows.push(row);
        fixed.push({ snapshotId, productId: association.product_id, businessKeys: [row.record_ref.logical_key] });
        console.log('OFFICIAL_CORRECTION_SELECTED ' + JSON.stringify({ id: item.id, sha256: item.sha256, page: item.page,
          archiveDate: item.archiveDate, archiveDatePrecision: 'day_only_not_public_instant', value: item.expected,
          selectedScopeOnly: true, publication: 'isolated_source_claim_not_source_correction' }));
      }
      for (const [index, ref] of fixed.entries()) {
        const work = await execute(host, 'standardize-' + index, { routing: { materials: [{ materialId: materials[index], intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'mapped', materialIds: [materials[index]], intendedAction: 'inspect', stages: ['parse'],
            tables: [{ materialId: materials[index], format: 'financial-fixed', financialCalculation: {
              version: 'bd-financial-fixed/1', operation: 'standardize', inputs: [ref] } }] }] });
        assert.equal(work.done.status, 'succeeded', JSON.stringify(work.done.error));
        const artifact = JSON.parse(host.services.processing!.artifact(work.planId, 'parse:mapped:0').bytes.toString());
        assert.equal(artifact.financial_evidence.historicalQualification, 'not_asserted');
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
      // Both editions remain source claims. No implicit source_correction or latest-edition winner.
      const latest = await host.call('/r1/products/read', { snapshotId, productId: fixed[1].productId });
      assert.equal(latest.result.rows.length, 2);
      assert.deepEqual(latest.result.rows.map((row: any) => row.values.value.value).sort(), ['473861731.94', '546936730.12']);
      await host.close(); host = await openFullChainHost(fixture);
      for (const [index, ref] of fixed.entries()) {
        const read = await host.call('/r1/products/read', { snapshotId: ref.snapshotId, productId: ref.productId });
        assert.deepEqual(read.result.rows.find((row: any) => row.record_ref.logical_key === ref.businessKeys[0]), originalRows[index]);
      }
    } finally { await host.close(); }
  });

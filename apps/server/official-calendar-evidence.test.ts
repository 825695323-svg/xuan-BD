import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { conversionText } from '../../platform/capabilities/conversion/storage.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

const rawRoot = process.env.XUAN_OFFICIAL_CALENDAR_ROOT;
const notices = [
  { exchange: 'SSE', url: 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml' },
  { exchange: 'SZSE', url: 'https://www.szse.cn/disclosure/notice/t20251222_618087.html' },
];
// Explicit captured-original opt-in: no network calls, credentials or automatic retry in this test.
test('captured official holiday notices retain source and conversion evidence without claiming a full trading calendar',
  { skip: !rawRoot || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'official-calendar-live' });
    let host = await openFullChainHost(fixture);
    const manifest = JSON.parse(readFileSync(join(rawRoot!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'explicit_official_holiday_notice_capture'); assert.equal(manifest.fixture, false);
    const proofs: any[] = [];
    try {
      await host.call('/retrieval/settings', { requestId: 'calendar-no-auto-register', autoRegister: 'disabled' });
      for (const notice of notices) {
        const receipt = manifest.entries.find((item: any) => item.exchange === notice.exchange && item.url === notice.url);
        assert.ok(receipt); assert.equal(receipt.status, 200);
        assert.equal(receipt.file, notice.exchange.toLowerCase() + '.html');
        const raw = readFileSync(join(rawRoot!, receipt.file));
        assert.equal(wfdSha256(raw), receipt.sha256); assert.equal(raw.length, receipt.bytes); assert.ok(raw.length < 1_048_576);
        const uploaded = await host.upload(notice.exchange + '-2026.html', 'data', raw, 'calendar-material-' + notice.exchange);
        assert.equal((await host.settled(uploaded.jobId)).status, 'succeeded');
        const material = host.services.materials!.getByTask(uploaded.jobId)!.envelope;
        assert.equal(material.sha256, receipt.sha256);
        const converted = await host.call(`/retrieval/documents/${material.materialId}/convert`,
          { requestId: 'calendar-convert-' + notice.exchange }, 202);
        const convertedTask = await host.settled(converted.jobId);
        assert.equal(convertedTask.status, 'succeeded', JSON.stringify(convertedTask.error));
        const conversionRef = (convertedTask.result!.data as any).structuredReference;
        const envelope = JSON.parse(readFileSync(host.services.files.verify(conversionRef.fileRefId).invocationPath, 'utf8'));
        assert.equal(envelope.source.sha256, receipt.sha256);
        const text = conversionText(envelope); assert.ok(text);
        for (const marker of ['2026', '元旦', '春节', '清明', '劳动', '端午', '中秋', '国庆', '休市', '照常开市'])
          assert.ok(text.includes(marker), notice.exchange + ': missing actual notice content: ' + marker);
        // Ordinary table preparation only. The text is preserved verbatim; no day grid, open-day inference or security state is produced.
        const rows = [{ exchange: notice.exchange, source_url: notice.url, source_sha256: receipt.sha256,
          converted_text_sha256: wfdSha256(text), notice_text: text, coverage: '2026_partial_holiday_notice_only' }];
        const table = await host.upload(notice.exchange + '-notice-evidence.json', 'data', Buffer.from(JSON.stringify(rows)),
          'calendar-evidence-' + notice.exchange);
        assert.equal((await host.settled(table.jobId)).status, 'succeeded');
        const materialId = host.services.materials!.getByTask(table.jobId)!.envelope.materialId;
        const planTask = await host.call('/processing/plans', { requestId: 'calendar-plan-' + notice.exchange, input: {
          routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'notice', materialIds: [materialId],
            intendedAction: 'inspect', stages: ['parse', 'clean', 'structure', 'check'],
            tables: [{ materialId, format: 'json', types: Object.fromEntries(Object.keys(rows[0]!).map(key => [key, 'string'])) }] }],
        } }, 202);
        const planned = await host.settled(planTask.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
        for (const kind of ['parse', 'clean', 'structure', 'check']) {
          const step = host.services.processing!.get(planId).steps.find(item => item.kind === kind)!;
          const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`,
            { requestId: 'calendar-' + notice.exchange + '-' + kind }, 202);
          const done = await host.settled(accepted.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
        }
        const result = await host.call(`/processing/plans/${planId}/outputs/notice/artifact`);
        assert.deepEqual(result.rows, rows);
        assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, false);
        proofs.push({ ...notice, acquisition: manifest.acquisition, bdSourceFetch: manifest.bdSourceFetch, receipt, materialId: material.materialId, conversionRef,
          derivedEvidenceMaterialId: materialId, planId, rowsSha256: wfdSha256(canonicalWfdJson(rows)),
          qualification: { scope: '2026_partial_holiday_notice_only', sourceAuthenticity: 'official_https_content_observed',
            independentCalendarVerification: false, fullSessionCalendar: 'unknown', securityLifecycle: 'unknown',
            vendorHistoryWindow: 'unknown', historicalAvailability: 'not_asserted', publication: 'not_requested', automaticBackfill: false } });
      }
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 0);
      await host.close(); host = await openFullChainHost(fixture);
      for (const proof of proofs) {
        const result = await host.call(`/processing/plans/${proof.planId}/outputs/notice/artifact`);
        assert.equal(wfdSha256(canonicalWfdJson(result.rows)), proof.rowsSha256);
        assert.equal(host.services.materials!.readOriginal(proof.materialId).sha256, proof.receipt.sha256);
      }
      writeFileSync(join(fixture.root, 'official-calendar-evidence.json'), JSON.stringify({ fixture, proofs }, null, 2));
      console.log('OFFICIAL_CALENDAR_EVIDENCE ' + join(fixture.root, 'official-calendar-evidence.json'));
    } finally { await host.close(); }
  });

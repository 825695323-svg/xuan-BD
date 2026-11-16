import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import type { AcquisitionCheckpoint } from '../../contracts/source-acquisition.js';
import { acceptSourcePage, beginSourceAcquisition, reviewSourceAcquisition } from '../../plugins/api-sources/source-acquisition.js';
import { inspectOfficialJsonPage, treasuryAdapterConfig, type OfficialPageSelection } from '../../plugins/api-sources/official-public.js';
import { parseEndpointSource } from '../../modules/collection/endpoint-adapter.js';
import type { CandidateTablePlan } from '../../modules/collection/candidate-pipeline.js';

const rawRoot = process.env.XUAN_OFFICIAL_PROBE_ROOT;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface ProbeReceipt {
  provider: string; page: number; state: 'received' | 'failed'; status?: number;
  requestedUrl: string; finalUrl?: string; acquiredAtUtc: string;
  file?: string; bytes?: number; sha256?: string; error?: string;
}
async function upload(host: FullChainHost, name: string, bytes: Buffer, requestId: string) {
  const accepted = await host.upload(name, 'data', bytes, requestId);
  const task = await host.settled(accepted.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const material = host.services.materials!.getByTask(task.id)!;
  assert.equal(material.envelope.sha256, sha(bytes));
  assert.deepEqual(host.services.materials!.readOriginal(material.envelope.materialId).bytes, bytes);
  return material.envelope;
}
async function inspectTable(host: FullChainHost, materialId: string,
  table: Omit<CandidateTablePlan, 'materialId'>, label: string) {
  const accepted = await host.call('/processing/plans', { requestId: label + '-plan', input: {
    routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
    outputs: [{ outputId: 'observed', materialIds: [materialId], intendedAction: 'inspect',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, ...table }] }],
  } }, 202);
  const prepared = await host.settled(accepted.jobId);
  assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared.error));
  const planId = host.services.processing!.getByTask(prepared.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const plan = host.services.processing!.get(planId);
    const step = plan.steps.find(item => item.kind === kind)!;
    assert.notEqual(step.state, 'succeeded', 'Next module cannot run before its explicit call');
    const execution = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`,
      { requestId: label + '-' + kind }, 202);
    const result = await host.settled(execution.jobId);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    const saved = host.services.processing!.get(planId).steps.find(item => item.stepId === step.stepId)!;
    assert.equal(saved.state, 'succeeded'); assert.equal(saved.outputDigest?.length, 64);
  }
  const plan = host.services.processing!.get(planId);
  assert.deepEqual(plan.steps.map(item => item.kind), ['parse', 'structure', 'check']);
  assert.equal(plan.outputs[0]!.publishEligible, false, 'Official source does not replace purpose and product adoption');
  const bytes = host.services.processing!.outputArtifact(planId, 'observed').bytes;
  const parsed = JSON.parse(host.services.processing!.artifact(planId, plan.steps.find(item => item.kind === 'parse')!.stepId).bytes.toString());
  return { planId, digest: sha(bytes), result: JSON.parse(bytes.toString()), parsed };
}

test('live official originals use existing custody, bounded pagination and individual BD processing modules', {
  skip: !rawRoot || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires explicit live manifest and isolated BD root; no implicit network calls.' : false,
  timeout: 240000,
}, async () => {
  assert.ok(rawRoot);
  const manifest = JSON.parse(readFileSync(join(rawRoot, 'manifest.json'), 'utf8')) as {
    kind: string; fixture: boolean; results: ProbeReceipt[];
  };
  assert.equal(manifest.kind, 'live_official_api_probe'); assert.equal(manifest.fixture, false);
  const failed = new Set(manifest.results.filter(item => item.state === 'failed').map(item => item.provider));
  const usable = manifest.results.filter(item => item.state === 'received' && !failed.has(item.provider));
  assert.ok(new Set(usable.map(item => item.provider)).size >= 2, 'Need actual successful evidence from at least two official providers');
  const fixture = createFullChainFixture({ name: 'official-live' });
  let host = await openFullChainHost(fixture);
  const checkpoints = new Map<string, AcquisitionCheckpoint>();
  const completed: { planId: string; digest: string }[] = [];
  const processedProviders = new Set<string>();
  let treasuryAdopted = false;
  try {
    for (const entry of usable) {
      assert.ok(entry.file && /^[a-z]+-[12]\.(json|csv)$/u.test(entry.file), 'Only manifest-selected bounded local filenames');
      const bytes = readFileSync(join(rawRoot, entry.file));
      assert.equal(entry.status, 200); assert.equal(entry.finalUrl, entry.requestedUrl);
      assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
      const label = 'official-' + entry.provider + '-' + entry.page;
      const original = await upload(host, entry.file, bytes, label + '-upload');
      if (entry.provider === 'hkma' || entry.provider === 'treasury') {
        const selection: OfficialPageSelection = { provider: entry.provider, page: entry.page, pageSize: 2,
          start: entry.provider === 'hkma' ? '2024-01-02' : '2024-03-31',
          end: entry.provider === 'hkma' ? '2024-01-05' : '2024-03-31' };
        const page = inspectOfficialJsonPage(selection, bytes, { fileRefId: original.fileRefId,
          sha256: original.sha256, requestedUrl: entry.requestedUrl });
        const previous = checkpoints.get(entry.provider) ?? beginSourceAcquisition(page.request, page.binding, { maxPages: 2, maxRows: 4 });
        const checkpoint = acceptSourcePage(JSON.parse(JSON.stringify(previous)), page.request, page.binding, page.page);
        assert.deepEqual(acceptSourcePage(checkpoint, page.request, page.binding, page.page), checkpoint);
        checkpoints.set(entry.provider, checkpoint);
        const review = reviewSourceAcquisition(checkpoint);
        assert.equal(review.coverage.state, 'not_established'); assert.equal(review.publication, 'not_requested');
        if (entry.page === 2) assert.equal(review.continuation.state, 'budget_exhausted');
        console.log('OFFICIAL_ACQUISITION ' + JSON.stringify({ provider: entry.provider, reportedTotal: page.reportedTotal,
          observedRows: review.rowCount, coverage: review.coverage.state, continuation: review.continuation.state,
          returnTo: review.returnTo, originalSha256: original.sha256 }));
        if (entry.provider === 'hkma') {
          // Nested datasize/records is preserved, not flattened behind the existing adapter's back.
          console.log('OFFICIAL_BD_SCOPE hkma=custody_and_pagination_metadata_only');
          continue;
        }
        if (!treasuryAdopted) {
          const config = treasuryAdapterConfig();
          await host.call('/processing/adapters/candidates', { requestId: 'official-treasury-candidate', input: { config } }, 201);
          const mutated = JSON.parse(bytes.toString()); mutated.data[0].exchange_rate = 'synthetic-invalid-number';
          const negative = await upload(host, 'synthetic-invalid-treasury.json', Buffer.from(JSON.stringify(mutated)), 'official-negative-upload');
          const replay = await host.call(`/processing/adapters/${config.adapterId}/1/replay`, {
            requestId: 'official-treasury-replay', input: { adapterId: config.adapterId, version: '1', samples: [
              { materialId: original.materialId, expectation: 'accept' },
              { materialId: negative.materialId, expectation: 'reject' },
            ] },
          });
          assert.equal(replay.passed, true, JSON.stringify(replay.results));
          const adopted = await host.call(`/processing/adapters/${config.adapterId}/1/adopt`, {
            requestId: 'official-treasury-adopt', input: { adapterId: config.adapterId, version: '1',
              evidenceDigest: replay.evidenceDigest, confirmationDigest: replay.evidenceDigest },
          });
          assert.equal(adopted.status, 'adopted'); treasuryAdopted = true;
        }
        const processed = await inspectTable(host, original.materialId,
          { format: 'json', sourceAdapter: { adapterId: treasuryAdapterConfig().adapterId } as CandidateTablePlan['sourceAdapter'] }, label);
        const source = parseEndpointSource(bytes, treasuryAdapterConfig());
        const rate = source.columns.indexOf('exchange_rate');
        assert.deepEqual(processed.result.rows.map((row: Record<string, unknown>) => row.exchange_rate),
          source.rows.map(row => row[rate]!.value));
        assert.equal(processed.result.rows.length, 2);
        completed.push(processed); processedProviders.add(entry.provider);
        console.log('OFFICIAL_BD_RESULT ' + JSON.stringify({ provider: entry.provider, page: entry.page,
          rows: processed.result.rows.length, stages: ['parse', 'structure', 'check'], originalSha256: original.sha256,
          outputSha256: processed.digest, publication: 'not_requested' }));
      } else if (entry.provider === 'ecb') {
        const processed = await inspectTable(host, original.materialId, { format: 'csv', types: { OBS_VALUE: 'decimal_string' } }, label);
        const valueIndex = processed.parsed.columns.indexOf('OBS_VALUE');
        assert.ok(valueIndex >= 0);
        assert.equal(processed.result.rows.length, 4);
        assert.deepEqual(processed.result.rows.map((row: Record<string, unknown>) => row.OBS_VALUE),
          processed.parsed.rows.map((row: { original: unknown }[]) => row[valueIndex]!.original));
        for (const row of processed.result.rows) {
          assert.equal(row.CURRENCY, 'USD'); assert.equal(row.CURRENCY_DENOM, 'EUR');
          assert.equal(row.EXR_TYPE, 'SP00'); assert.equal(typeof row.OBS_VALUE, 'string');
        }
        completed.push(processed); processedProviders.add(entry.provider);
        console.log('OFFICIAL_BD_RESULT ' + JSON.stringify({ provider: 'ecb', rows: processed.result.rows.length,
          stages: ['parse', 'structure', 'check'], originalSha256: original.sha256,
          outputSha256: processed.digest, publication: 'not_requested' }));
      } else {
        console.log('OFFICIAL_BD_SCOPE ' + entry.provider + '=custody_only_not_adapted');
      }
      assert.deepEqual(host.services.materials!.readOriginal(original.materialId).bytes, bytes);
    }
    assert.ok(completed.length >= 1, 'At least one actual official table must complete the real BD processing path');
    assert.equal(host.services.r1Workspace!.list().length, 0, 'Inspection never issues an implicit formal publication');
    await host.close(); host = await openFullChainHost(fixture);
    for (const saved of completed) assert.equal(sha(host.services.processing!.outputArtifact(saved.planId, 'observed').bytes), saved.digest);
    console.log('OFFICIAL_BD_SUMMARY ' + JSON.stringify({ processedProviders: [...processedProviders],
      completedTablePages: completed.length, reopenedReadback: true, failedProviders: [...failed],
      formalWfdPublication: 'not_tested_no_target_adoption' }));
  } finally { await host.close(); }
});

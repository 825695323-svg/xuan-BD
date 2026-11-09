import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { MaterialRecord } from '../../modules/collection/materials/contracts.js';
import { createFullChainFixture, grantSelectedFile, openFullChainHost, startDirect, type FullChainHost } from './full-chain-test-support.js';
import { conversionText } from '../../platform/capabilities/conversion/storage.js';

const sourceRoot = process.env.XUAN_TEST_UNSTRUCTURED_ROOT;
const outputRoot = process.env.XUAN_FULL_CHAIN_ROOT;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cases = [
  { id: 'stock-pdf', relative: '提取结果/研报/01_个股研报_沪电股份/original.pdf', mediaType: 'application/pdf', format: 'pdf', support: 'needs_adapter', pages: 4, convert: true },
  { id: 'industry-pdf', relative: '提取结果/研报/02_行业研报_大公国际IDC/original.pdf', mediaType: 'application/pdf', format: 'pdf', support: 'needs_adapter', pages: 13, convert: true },
  { id: 'source-list-rtf', relative: '静态来源类型测试.rtf', mediaType: 'application/rtf', format: 'unknown', support: 'unsupported', pages: 0, convert: true },
  { id: 'root-jpeg', relative: 'd1aff146c8c4169437c04f0c7e376d3f.jpg', mediaType: 'image/jpeg', format: 'image', support: 'needs_adapter', pages: 0, convert: false },
  { id: 'video-mp4', relative: '提取结果/字幕原始/video_BV15qJX64EBt.mp4', mediaType: 'video/mp4', format: 'video', support: 'needs_adapter', pages: 0, convert: false },
] as const;

function selectedPath(root: string, relative: string): string {
  const path = realpathSync(join(root, relative));
  assert.ok(path.startsWith(root + sep), 'Selected input must remain inside the explicit original package.');
  return path;
}

function artifact(host: FullChainHost, value: { fileRefId: string; fileRefVersion: number; sha256: string }) {
  const ref = host.services.files.verify(value.fileRefId);
  assert.equal(ref.version, value.fileRefVersion);
  const bytes = readFileSync(ref.invocationPath);
  assert.equal(digest(bytes), value.sha256);
  return bytes;
}

test('真实非结构化原件经材料保管、Direct 转换、证据和重开读回；不越过语义适配门',
  { skip: !sourceRoot || !outputRoot ? 'Requires explicitly selected original package and dedicated isolated output root.' : false,
    timeout: 600_000 }, async () => {
    const originalRoot = realpathSync(sourceRoot!);
    const fixture = createFullChainFixture({ name: 'unstructured-real', bundledTranscription: true });
    let host: FullChainHost | null = await openFullChainHost(fixture);
    const observations: any[] = [];
    const failures: string[] = [];
    let processingGate: any = null;
    try {
      for (const sample of cases) {
        const path = selectedPath(originalRoot, sample.relative), bytes = readFileSync(path), originalSha256 = digest(bytes);
        const reference = grantSelectedFile(host!, path, `${sample.id}-original-read-only`);
        const task = host!.services.materials!.submit({ fileRefId: reference.id, category: 'unclassified',
          mediaType: sample.mediaType, expectedSha256: originalSha256 }, sample.id);
        const received = await host!.settled(task.id, 120_000);
        const observation: any = { id: sample.id, relative: sample.relative, originalSha256,
          bytes: bytes.byteLength, fileRefId: reference.id, materialTaskId: task.id,
          materialTaskStatus: received.status, materialTaskError: received.error };
        observations.push(observation);
        if (received.status !== 'succeeded') { failures.push(`${sample.id}: material ${received.status} ${received.error?.code ?? ''}`); continue; }
        const material: MaterialRecord = host!.services.materials!.getByTask(task.id)!;
        const original = host!.services.materials!.readOriginal(material.envelope.materialId);
        observation.materialId = material.envelope.materialId;
        observation.preview = { format: material.preview.format, support: material.preview.support,
          checks: material.preview.checks, limitations: material.preview.limitations };
        assert.equal(material.envelope.sha256, originalSha256);
        assert.equal(material.envelope.byteLength, bytes.byteLength);
        assert.equal(material.envelope.environment, 'local-review');
        assert.equal(original.sha256, originalSha256);
        assert.equal(digest(original.bytes), originalSha256);
        assert.equal(material.preview.format, sample.format);
        assert.equal(material.preview.support, sample.support);
        const httpRecord = await host!.call(`/materials/${material.envelope.materialId}`);
        assert.equal(httpRecord.envelope.sha256, originalSha256);
        if (sample.id === 'stock-pdf') {
          const response: Response = await fetch(host!.base + `/materials/${material.envelope.materialId}/original`);
          assert.equal(response.status, 200);
          assert.equal(digest(new Uint8Array(await response.arrayBuffer())), originalSha256);
        }
        if (sample.convert) {
          const conversion = startDirect(host!, 'conversion.document', { fileRefId: reference.id, textExport: 'txt' }, `${sample.id}-convert`);
          const finished = await host!.settled(conversion.id, 180_000);
          observation.conversion = { taskId: conversion.id, taskStatus: finished.status, error: finished.error };
          if (finished.status !== 'succeeded' || !finished.result?.data || typeof finished.result.data !== 'object' || Array.isArray(finished.result.data)) {
            failures.push(`${sample.id}: conversion task ${finished.status} ${finished.error?.code ?? ''}`); continue;
          }
          const data = finished.result.data as any;
          observation.conversion.status = data.status;
          observation.conversion.issues = data.issues;
          if (data.status === 'failed') { failures.push(`${sample.id}: conversion payload failed ${JSON.stringify(data.issues)}`); continue; }
          assert.equal(data.source.fileRefId, reference.id);
          assert.equal(data.source.fileRefVersion, reference.version);
          assert.equal(data.source.sha256, originalSha256);
          assert.equal(data.source.bytes, bytes.byteLength);
          const structuredBytes = artifact(host!, data.structuredReference);
          const envelope = JSON.parse(structuredBytes.toString('utf8'));
          assert.equal(envelope.source.sha256, originalSha256);
          assert.equal(envelope.source.fileRefId, reference.id);
          assert.equal(envelope.status, data.status);
          assert.deepEqual(envelope.issues, data.issues);
          assert.ok(data.textReference, 'The explicitly requested full text view must be published.');
          const textBytes = artifact(host!, data.textReference);
          assert.equal(textBytes.toString('utf8'), conversionText(envelope));
          observation.conversion.structuredReference = data.structuredReference;
          observation.conversion.textReference = data.textReference;
          observation.conversion.textBytes = textBytes.byteLength;
          if (sample.pages) {
            assert.equal(envelope.content.pageCount, sample.pages);
            assert.equal(envelope.content.pages.length, sample.pages);
            const pages = envelope.content.pages.map((page: any) => ({ page: page.page, originalItemCount: page.originalItems?.length ?? -1,
              textItemCount: page.originalItems?.filter((item: any) => typeof item.str === 'string' && item.str.length > 0).length ?? 0,
              locatedTextItemCount: page.originalItems?.filter((item: any) => typeof item.str === 'string' && item.str.length > 0
                && Array.isArray(item.transform) && item.transform.length >= 6).length ?? 0,
              readingOrderBasis: page.readingOrder?.basis, extraction: page.extraction ?? null }));
            assert.deepEqual(pages.map((page: any) => page.page), Array.from({ length: sample.pages }, (_, i) => i + 1));
            assert.ok(pages.every((page: any) => page.originalItemCount >= 0));
            assert.ok(pages.some((page: any) => page.locatedTextItemCount > 0), 'The selected real PDF should contain native located text.');
            if (sample.id === 'industry-pdf') {
              assert.equal(data.status, 'partial');
              assert.deepEqual(pages.filter((page: any) => page.extraction?.status === 'failed').map((page: any) => page.page), [5]);
              assert.equal(pages.filter((page: any) => page.locatedTextItemCount > 0).length, 12);
              assert.ok(data.issues.some((issue: any) => issue.code === 'PDF_TEXT_EXTRACT_FAILED' && issue.location?.page === 5));
              assert.ok(!data.issues.some((issue: any) => issue.code === 'PDF_NO_TEXT_LAYER' && issue.location?.page === 5));
            }
            observation.conversion.pages = pages;
          } else {
            assert.equal(envelope.content.format, 'rtf');
            assert.ok(textBytes.byteLength > 0, 'The URL list RTF should yield native text.');
          }
        }
        assert.equal(digest(readFileSync(path)), originalSha256, 'Selected original bytes must stay unchanged.');
      }

      const video = observations.find(item => item.id === 'video-mp4' && item.materialId);
      assert.ok(video, 'The MP4 must be held before local transcription.');
      const audioAvailability = host!.services.direct.registry.get('audio.transcribe').availability;
      video.localTranscription = { availability: audioAvailability };
      assert.equal(audioAvailability.available, true, audioAvailability.reason ?? 'Local transcription unavailable.');
      const transcription = startDirect(host!, 'audio.transcribe', { fileRefId: video.fileRefId }, 'video-mp4-local-whisper');
      const transcribed = await host!.settled(transcription.id, 480_000);
      video.localTranscription.taskId = transcription.id;
      video.localTranscription.taskStatus = transcribed.status;
      video.localTranscription.error = transcribed.error;
      if (transcribed.status !== 'succeeded' || !transcribed.result?.data || typeof transcribed.result.data !== 'object' || Array.isArray(transcribed.result.data)) {
        failures.push(`video-mp4: local transcription ${transcribed.status} ${transcribed.error?.code ?? ''}`);
      } else {
        const data = transcribed.result.data as any;
        assert.equal(data.backend, 'whisper.cpp-local');
        assert.equal(data.source.fileRefId, video.fileRefId);
        assert.equal(data.source.sha256, video.originalSha256);
        const text = artifact(host!, data.textReference).toString('utf8');
        const evidence = JSON.parse(artifact(host!, data.evidenceReference).toString('utf8'));
        assert.ok(text.trim());
        assert.ok(Array.isArray(evidence.transcription));
        const cues = evidence.transcription.filter((cue: any) => typeof cue.text === 'string' && cue.text.trim());
        assert.equal(cues.length, data.segmentCount);
        assert.ok(cues.every((cue: any) => Number.isSafeInteger(cue.offsets?.from) && Number.isSafeInteger(cue.offsets?.to)
          && cue.offsets.from >= 0 && cue.offsets.to > cue.offsets.from));
        for (let i = 1; i < cues.length; i++) assert.ok(cues[i]!.offsets.from >= cues[i - 1]!.offsets.to);
        assert.ok(cues.at(-1)!.offsets.to <= 3_600_000);
        video.localTranscription = { ...video.localTranscription, backend: data.backend, source: data.source,
          textReference: data.textReference, evidenceReference: data.evidenceReference,
          textBytes: Buffer.byteLength(text), segmentCount: data.segmentCount,
          firstStartMs: cues[0]!.offsets.from, lastEndMs: cues.at(-1)!.offsets.to };
      }

      const pdf = observations.find(item => item.id === 'stock-pdf' && item.materialId);
      assert.ok(pdf, 'The first PDF must be held before checking the processing gate.');
      const planned = await host!.call('/processing/plans', { requestId: 'pdf-no-table-adapter-plan', input: {
        routing: { materials: [{ materialId: pdf.materialId, intendedAction: 'inspect' }] },
        outputs: [{ outputId: 'pdf-candidate', materialIds: [pdf.materialId], intendedAction: 'inspect',
          tables: [{ materialId: pdf.materialId, format: 'csv' }] }],
      } }, 202);
      const planTask = await host!.settled(planned.jobId);
      assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
      const planId = host!.services.processing!.getByTask(planTask.id)!.plan!.planId;
      const plan = host!.services.processing!.get(planId);
      const parse = plan.steps.find(step => step.kind === 'parse')!;
      processingGate = { planId, parseApplicability: parse.applicability, parseGaps: parse.gaps,
        outputState: plan.outputs[0]?.state, routingState: plan.outputs[0]?.routingState,
        publishEligible: plan.outputs[0]?.publishEligible };
      assert.equal(parse.applicability, 'unknown');
      assert.ok(parse.gaps.some(gap => gap.includes('缺对应解析器')));
      assert.notEqual(plan.outputs[0]?.publishEligible, true);
      assert.equal(Number(host!.database.connection.prepare('SELECT COUNT(*) n FROM r1_workspace_requests').get()!.n), 0);

      await host!.close(); host = await openFullChainHost(fixture);
      for (const observation of observations) {
        if (!observation.materialId) continue;
        const material = host.services.materials!.get(observation.materialId);
        const original = host.services.materials!.readOriginal(observation.materialId);
        assert.equal(material.envelope.sha256, observation.originalSha256);
        assert.equal(digest(original.bytes), observation.originalSha256);
        if (observation.conversion?.taskId && observation.conversion.structuredReference) {
          const task = host.services.tasks.get(observation.conversion.taskId);
          assert.equal(task.status, 'succeeded');
          artifact(host, observation.conversion.structuredReference);
          artifact(host, observation.conversion.textReference);
        }
        if (observation.localTranscription?.textReference) {
          const task = host.services.tasks.get(observation.localTranscription.taskId);
          assert.equal(task.status, 'succeeded');
          artifact(host, observation.localTranscription.textReference);
          artifact(host, observation.localTranscription.evidenceReference);
          assert.equal(task.result?.data && (task.result.data as any).source.sha256, observation.originalSha256);
        }
      }
      assert.equal(host.services.direct.registry.get('material.ocr').availability.available, false);
      assert.equal(host.services.direct.registry.get('material.transcribe').availability.available, false);
      assert.equal(host.services.direct.registry.get('audio.transcribe').availability.available, true);
      assert.equal(host.services.direct.registry.get('image.ocr').availability.available, false);
      assert.equal(host.services.semantics!.list(pdf.materialId).length, 0,
        'No model proposal was supplied; PDF quotes cannot be fabricated as a semantic result.');
      assert.equal(failures.length, 0, failures.join('\n'));
    } finally {
      writeFileSync(join(fixture.root, 'unstructured-readback.json'), JSON.stringify({
        sourceRoot: originalRoot, observations, processingGate, failures,
        ocrAvailability: host?.services.direct.registry.get('material.ocr').availability ?? null,
        serviceOnlyMaterialTranscriptionAvailability: host?.services.direct.registry.get('material.transcribe').availability ?? null,
        configuredLocalTranscriptionAvailability: host?.services.direct.registry.get('audio.transcribe').availability ?? null,
        semanticConclusion: 'PDF conversion products are not accepted as table input or R1 publish-eligible output',
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await host?.close();
    }
  });

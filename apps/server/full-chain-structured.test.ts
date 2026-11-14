import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { decodeText, zipMembers } from '../../platform/capabilities/conversion/formats.js';
import { createFullChainFixture, grantSelectedFile, openFullChainHost, startDirect } from './full-chain-test-support.js';

interface StructuredSample {
  domain: string;
  path: string;
  bytes: number;
  field_count: number;
  fields: string[];
  semantic_gaps: string[];
}
interface StructuredManifest {
  meta: { assets_root: string };
  selected_structured_samples: StructuredSample[];
}

const manifestPath = process.env.XUAN_STRUCTURED_ASSETS_JSON;
const outputRoot = process.env.XUAN_FULL_CHAIN_ROOT;

test('three real structured originals are processed by individually selected modules with semantic gaps retained',
  { skip: !manifestPath || !outputRoot ? 'Requires selected real-original manifest and dedicated isolated output root.' : false,
    timeout: 300_000 }, async () => {
    assert.ok(manifestPath && outputRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StructuredManifest;
    assert.deepEqual(manifest.selected_structured_samples.map(sample => sample.domain),
      ['industry_capital_flow', 'limit_up_down_events', 'issuer_and_concept_snapshot']);
    for (const sample of manifest.selected_structured_samples) {
      const sourcePath = join(manifest.meta.assets_root, sample.path);
      const bytes = readFileSync(sourcePath);
      assert.equal(statSync(sourcePath).size, sample.bytes);
      assert.equal(bytes.byteLength, sample.bytes);
      const originalSha256 = wfdSha256(bytes);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const header = text.split(/\r?\n/u, 1)[0]!;
      assert.ok(header.length > 0 && header.length < 10_000);
      const fixture = createFullChainFixture({ name: sample.domain });
      let host = await openFullChainHost(fixture);
      let closed = false;
      try {
        const uploaded = await host.upload(basename(sourcePath), 'data', bytes, `${sample.domain}-upload`);
        const intake = await host.settled(uploaded.jobId);
        assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
        const material = host.services.materials!.getByTask(intake.id)!;
        const materialId = material.envelope.materialId;
        assert.equal(material.envelope.environment, 'local-review');
        assert.equal(material.envelope.sha256, originalSha256);
        assert.equal(material.envelope.byteLength, bytes.byteLength);
        assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, bytes);

        const originalEvidence = { source: 'material', materialId, quote: header, start: 0, end: header.length };
        const knownFromHeader = (value: string) => ({ status: 'known', value, evidence: [originalEvidence] });
        const dimensions = {
          role: knownFromHeader('原件表头可核的 CSV 表格；本次仅检查结构'),
          informationNature: { status: 'unknown', gap: '来源真实性、数据生成口径和业务含义尚未验证。' },
          businessObject: knownFromHeader(`原件表头列有 ${sample.fields.slice(0, 2).join('、')}；对象身份未核定`),
          objectTime: { status: 'unknown', gap: '日期或事件列不能证明逐行公开可得时刻、历史修订和有效期。' },
          purpose: { status: 'known', value: '隔离环境内检查原表结构与原值保留，不授权发布',
            evidence: [{ source: 'operator', field: 'routing.materials.0.dimensions.purpose',
              quote: '隔离环境内检查原表结构与原值保留，不授权发布' }] },
          structureGranularity: knownFromHeader('原件表头所列字段形成行列表；业务粒度未采用'),
        };
        const input = { routing: { materials: [{ materialId, dimensions, intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'raw-table', materialIds: [materialId], intendedAction: 'inspect',
            stages: ['parse', 'clean', 'structure', 'annotate', 'check'],
            tables: [{ materialId, format: 'csv', trim: [sample.fields[0]],
              annotations: { source_original_sha256: originalSha256 } }],
            coverage: { complete: false, scope: '本次只执行结构检查；未认定金融业务语义或发布资格。',
              gaps: ['来源许可及转载链未知', '历史可得时刻与修订链未知', '字段单位及计量口径待核'] } }] };

        const forged = structuredClone(input);
        forged.routing.materials[0]!.dimensions.role.evidence[0]!.quote = `${header.slice(0, -1)}X`;
        const rejected = await host.call('/processing/plans', { requestId: `${sample.domain}-forged`, input: forged }, 409);
        assert.equal(rejected.code, 'PROCESSING_EVIDENCE_MISMATCH');
        assert.equal(host.services.processing!.findByRequest(`${sample.domain}-forged`), null);

        const planned = await host.call('/processing/plans', { requestId: `${sample.domain}-plan`, input }, 202);
        const planTask = await host.settled(planned.jobId);
        assert.equal(planTask.status, 'succeeded', JSON.stringify(planTask.error));
        const planId = host.services.processing!.getByTask(planTask.id)!.plan!.planId;
        // 五种能力仅因本样本逐项显式选择才运行；每一步完成后读取真实结果再推进。
        const declared = host.services.processing!.get(planId).steps;
        for (const kind of ['parse', 'clean', 'structure', 'annotate', 'check']) {
          const step = declared.find(item => item.kind === kind)!;
          const execution = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`,
            { requestId: `${sample.domain}-${kind}` }, 202);
          const result = await host.settled(execution.jobId, 180_000);
          assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
          const readback = host.services.processing!.get(planId).steps.find(item => item.stepId === step.stepId)!;
          assert.equal(readback.state, 'succeeded', `处理模块 ${kind} 没有完成`);
          assert.equal(readback.outputDigest?.length, 64, `处理模块 ${kind} 缺少持久化摘要`);
        }

        const plan = await host.call(`/processing/plans/${planId}`);
        const output = plan.outputs[0];
        assert.equal(plan.status, 'completed', JSON.stringify(plan.steps.map((step: any) => ({ kind: step.kind, state: step.state, error: step.error }))));
        assert.equal(output.state, 'structured');
        assert.equal(output.publishEligible, false);
        assert.notEqual(output.routingState, 'ready_candidate');
        assert.ok(output.semanticGaps.some((gap: string) => gap.startsWith('informationNature:')));
        assert.ok(output.semanticGaps.some((gap: string) => gap.startsWith('objectTime:')));
        assert.deepEqual(plan.steps.map((step: any) => step.kind), ['parse', 'clean', 'structure', 'annotate', 'check']);
        assert.ok(plan.steps.every((step: any) => step.state === 'succeeded'));
        assert.ok(plan.integrity.every((item: any) => item.present));

        const parsed = JSON.parse(host.services.processing!.artifact(planId, 'parse:raw-table:0').bytes.toString('utf8'));
        assert.equal(parsed.source_sha256, originalSha256);
        assert.equal(parsed.source_columns.length, sample.field_count);
        assert.deepEqual(parsed.source_columns, sample.fields);
        const artifact = host.services.processing!.outputArtifact(planId, 'raw-table');
        const artifactSha256 = wfdSha256(artifact.bytes);
        assert.equal(artifactSha256, artifact.ref.sha256);
        const rows = JSON.parse(artifact.bytes.toString('utf8')).rows;
        assert.equal(rows.length, parsed.total_rows);
        assert.ok(rows.length > 0);
        assert.ok(rows.every((row: Record<string, unknown>) => row.source_original_sha256 === originalSha256));
        const parsedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const sampledRows = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
        for (const rowIndex of sampledRows) {
          const sourceRow = parsed.rows[rowIndex];
          const outputRow = rows[rowIndex] as Record<string, unknown>;
          assert.equal(sourceRow.length, sample.field_count);
          assert.deepEqual(Object.keys(outputRow).sort(), [...sample.fields, 'source_original_sha256'].sort());
          for (const [columnIndex, field] of sample.fields.entries()) {
            const cell = sourceRow[columnIndex];
            assert.equal(parsedText.slice(cell.location.start, cell.location.end), cell.quote);
            assert.equal(outputRow[field], columnIndex === 0 ? cell.original.trim() : cell.original);
          }
        }
        assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 0);
        await host.close(); closed = true;

        host = await openFullChainHost(fixture); closed = false;
        const persisted = host.services.processing!.get(planId);
        assert.equal(persisted.status, 'completed');
        assert.equal(persisted.outputs[0]!.publishEligible, false);
        assert.ok(persisted.integrity.every(item => item.present));
        assert.equal(wfdSha256(host.services.processing!.outputArtifact(planId, 'raw-table').bytes), artifactSha256);
        assert.equal(host.services.materials!.readOriginal(materialId).sha256, originalSha256);
        assert.equal(wfdSha256(readFileSync(sourcePath)), originalSha256);
        assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 0);
        writeFileSync(join(fixture.root, 'structured-result.json'), JSON.stringify({
          domain: sample.domain, sourcePath, sourceBytes: bytes.byteLength, sourceSha256: originalSha256,
          sourceQuality: 'real_on_disk_original', httpCustody: true, evidenceForgeryRejected: rejected.code,
          previewSupport: material.preview.support, materialId, planId, sourceFieldCount: parsed.source_columns.length,
          parsedRows: parsed.total_rows, stages: persisted.steps.map(step => ({ kind: step.kind, state: step.state,
            outputDigest: step.outputDigest })), outputArtifactSha256: artifactSha256,
          sampledRowsCompared: sampledRows.map(index => index + 1), sampledCellsCompared: sampledRows.length * sample.field_count,
          sourceHashUnchanged: true,
          outputState: persisted.outputs[0]!.state, routingState: persisted.outputs[0]!.routingState,
          semanticGaps: persisted.outputs[0]!.semanticGaps, sourceSemanticGaps: sample.semantic_gaps,
          sourceLicense: 'unknown', historicalAvailableAt: 'unknown', measurementConvention: 'unknown',
          reopenedReadback: true, wfdPublished: false, productionAccepted: false,
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(`STRUCTURED_FULL_CHAIN_EVIDENCE_ROOT=${fixture.root}`);
      } finally {
        if (!closed) await host.close();
      }
    }
  });

test('smallest yearly real XLSX retains custody and complete native conversion across reopen',
  { skip: !manifestPath || !outputRoot ? 'Requires selected real-original manifest and dedicated isolated output root.' : false,
    timeout: 300_000 }, async () => {
    assert.ok(manifestPath && outputRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StructuredManifest;
    const relative = '静态数据库/原包/每日涨停/涨停分布表/涨停分布表_2023@余哈哈的数据仓库 原创整理.xlsx';
    const sourcePath = join(manifest.meta.assets_root, relative), bytes = readFileSync(sourcePath);
    assert.equal(bytes.byteLength, 1_177_542, 'Fixed small original selection changed; review before rerunning.');
    const sourceSha256 = wfdSha256(bytes), fixture = createFullChainFixture({ name: 'converted-distribution-xlsx' });
    assert.equal(sourceSha256, '1156fb9d5c38f9e6b81d22abfe0007da022dc6b49a5c0987c8902da8a6d851a1');
    let host = await openFullChainHost(fixture), closed = false;
    try {
      const selected = grantSelectedFile(host, sourcePath, 'real-small-xlsx-read-only');
      const intakeTask = host.services.materials!.submit({ fileRefId: selected.id, category: 'data',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expectedSha256: sourceSha256 },
      'real-small-xlsx-custody');
      assert.equal((await host.settled(intakeTask.id)).status, 'succeeded');
      const material = host.services.materials!.getByTask(intakeTask.id)!;
      assert.equal(material.envelope.sha256, sourceSha256);
      assert.equal(wfdSha256(host.services.materials!.readOriginal(material.envelope.materialId).bytes), sourceSha256);
      assert.equal(material.preview.format, 'excel');
      assert.equal(material.preview.support, 'needs_adapter');

      const conversionTask = startDirect(host, 'conversion.structured', { fileRefId: selected.id }, 'real-small-xlsx-convert');
      const finished = await host.settled(conversionTask.id, 180_000);
      assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
      const result = finished.result!.data as any;
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.issues, []);
      assert.equal(result.source.sha256, sourceSha256);
      assert.equal(result.source.bytes, bytes.byteLength);
      assert.equal(result.source.detectedType, 'xlsx');
      const sidecar = result.structuredReference;
      const outputRef = host.services.files.verify(sidecar.fileRefId);
      assert.equal(outputRef.version, sidecar.fileRefVersion);
      const outputBytes = readFileSync(outputRef.invocationPath), outputSha256 = wfdSha256(outputBytes);
      assert.equal(outputSha256, sidecar.sha256);
      assert.equal(outputBytes.byteLength, sidecar.bytes);
      assert.ok(outputBytes.byteLength > 0 && outputBytes.byteLength <= 64_000_000);
      const envelope = JSON.parse(outputBytes.toString('utf8'));
      assert.equal(envelope.source.sha256, sourceSha256);
      assert.equal(envelope.source.fileRefId, selected.id);
      assert.equal(envelope.operation, 'conversion.structured');
      assert.equal(envelope.status, 'complete');
      assert.deepEqual(envelope.issues, []);
      assert.equal(envelope.content.native.format, 'xlsx');
      assert.equal(outputBytes.toString('utf8'), JSON.stringify(envelope), 'XLSX sidecar stays compact without dropping JSON fields.');
      const native = envelope.content.native, sheet = native.sheets[0];
      assert.equal(native.sheets.length, 1);
      assert.equal(sheet.part, 'xl/worksheets/sheet1.xml');
      assert.equal(sheet.rows.length, 1906);
      const sourceXml = decodeText(zipMembers(bytes).find(member => member.path === sheet.part)!.read()).text;
      assert.equal(envelope.content.originalParts.find((part: any) => part.path === sheet.part)?.xml, sourceXml);
      const expectedCellKeys = ['address', 'formula', 'inlineString', 'location', 'rawStorage', 'rawXml',
        'resolvedSharedString', 'storageType', 'styleIndex'].sort();
      let convertedCells = 0, convertedFormulas = 0, sourcePosition = 0;
      for (const row of sheet.rows) for (const cell of row.cells) {
        assert.deepEqual(Object.keys(cell).sort(), expectedCellKeys);
        assert.equal(cell.location.part, sheet.part);
        assert.equal(cell.location.sheet, sheet.name);
        assert.equal(cell.location.cell, cell.address);
        const found = sourceXml.indexOf(cell.rawXml, sourcePosition);
        assert.ok(found >= sourcePosition, `原 XML 找不到 ${cell.address}`);
        sourcePosition = found + cell.rawXml.length;
        if (cell.formula !== null) convertedFormulas++;
        convertedCells++;
      }
      assert.equal(convertedCells, 87_676);
      assert.equal(convertedFormulas, 0, '真实原件零公式；公式正例由独立合成夹具覆盖。');
      assert.equal(sheet.rows[0].cells[0].inlineString, '@余哈哈的数据助手 原创整理');
      assert.equal(sheet.rows[950].cells[0].rawStorage, '45259');
      assert.equal(sheet.rows.at(-1).cells.at(-1).address, 'AT1906');
      assert.equal(wfdSha256(readFileSync(sourcePath)), sourceSha256);
      assert.equal(host.services.processing!.getDecision(material.envelope.materialId), null);
      assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_workspace_requests').get()!.n, 0);
      await host.close(); closed = true;

      host = await openFullChainHost(fixture); closed = false;
      assert.equal(host.services.tasks.get(conversionTask.id).status, 'succeeded');
      assert.equal(host.services.materials!.readOriginal(material.envelope.materialId).sha256, sourceSha256);
      const reopened = host.services.files.verify(sidecar.fileRefId);
      assert.equal(reopened.version, sidecar.fileRefVersion);
      const reopenedBytes = readFileSync(reopened.invocationPath);
      assert.equal(wfdSha256(reopenedBytes), outputSha256);
      assert.equal(reopenedBytes.byteLength, outputBytes.byteLength);
      const persistedEnvelope = JSON.parse(reopenedBytes.toString('utf8'));
      assert.equal(persistedEnvelope.status, 'complete');
      assert.equal(persistedEnvelope.content.native.sheets[0].rows.length, 1906);
      assert.equal(persistedEnvelope.content.native.sheets[0].rows[950].cells[0].rawStorage, '45259');
      assert.equal(host.services.processing!.getDecision(material.envelope.materialId), null);
      writeFileSync(join(fixture.root, 'xlsx-conversion-result.json'), JSON.stringify({
        relative, sourceBytes: bytes.byteLength, sourceSha256, sourceKind: 'real_on_disk_original',
        materialId: material.envelope.materialId, materialSupport: material.preview.support,
        conversionTaskId: conversionTask.id, conversionStatus: result.status, conversionIssues: result.issues,
        convertedRows: sheet.rows.length, convertedCells, convertedFormulas,
        outputBytes: outputBytes.byteLength, outputSha256, originalXmlCellsLocated: convertedCells,
        reopenedReadback: true, sourceHashUnchanged: true,
        automaticMaterialProcessing: false, wfdPublished: false, productionAccepted: false,
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`XLSX_FULL_CHAIN_EVIDENCE_ROOT=${fixture.root}`);
    } finally {
      if (!closed) await host.close();
    }
  });

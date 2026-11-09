import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
const workbook = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="rId1"/></sheets></workbook>';
const relations = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const crcTable = Array.from({ length: 256 }, (_, n) => { let value = n; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, count = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path), data = Buffer.from(xml), crc = crc32(data), head = Buffer.alloc(30), directory = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(head, name, data); central.push(directory, name); offset += head.length + name.length + data.length; count++;
  }
  const directoryBytes = central.reduce((sum, entry) => sum + entry.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function fixture(sheetData: string, extras: Record<string, string> = {}): Buffer {
  return zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': relations,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetData}</worksheet>`, ...extras });
}

const choice = { sheetName: 'Test', headerRow: 1, firstDataRow: 2, lastDataRow: 2, firstColumn: 'A', lastColumn: 'B',
  columns: [{ column: 'A', header: '标识', name: 'key', type: 'string' }, { column: 'B', header: '原值', name: 'value', type: 'decimal_string' }] };
const workbookBytes = () => fixture('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标识</t></is></c><c r="B1" t="inlineStr"><is><t>原值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>000001</t></is></c><c r="B2"><v>1.2300</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>000002</t></is></c><c r="B3"><v>9007199254740993</v></c></row></sheetData>');

test('手动投喂：XLSX明确选区进入五步，原位证据与派生偏移分开，重开可读且选区改变不复用旧解析',
  { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires a dedicated isolated output root.' : false }, async () => {
    const f = createFullChainFixture({ name: 'manual-xlsx' }); let h = await openFullChainHost(f);
    try {
      const bytes = workbookBytes(), upload = await h.upload('explicit.xlsx', 'data', bytes, 'manual-xlsx-upload');
      const intake = await h.settled(upload.jobId); assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
      const m = h.services.materials!.getByTask(intake.id)!, materialId = m.envelope.materialId;
      const preview = await h.call(`/materials/${materialId}/xlsx-preview`);
      assert.equal(preview.sha256, wfdSha256(bytes)); assert.equal(preview.preview.previewSheet, 'Test');
      const run = async (requestId: string, selection: typeof choice) => {
        const accepted = await h.call('/processing/plans', { requestId, input: {
          routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'selected', materialIds: [materialId],
            intendedAction: 'inspect', tables: [{ materialId, format: 'xlsx', xlsxSelection: selection }] }],
        } }, 202);
        const planned = await h.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        const planId = h.services.processing!.getByTask(planned.id)!.plan!.planId;
        const executed = await h.call(`/processing/plans/${planId}/run`, { requestId: requestId + '-run' }, 202);
        const done = await h.settled(executed.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
        return h.services.processing!.get(planId);
      };
      const first = await run('xlsx-selection-one', choice), parse = first.steps.find(x => x.kind === 'parse')!;
      assert.equal(first.outputs[0]!.state, 'structured'); assert.equal(first.outputs[0]!.publishEligible, false);
      const raw = JSON.parse(h.services.processing!.artifact(first.planId, parse.stepId).bytes.toString());
      assert.equal(raw.source_sha256, wfdSha256(bytes)); assert.equal(raw.source_projection.location_scope, 'derived-json-utf16');
      assert.equal(raw.source_projection.evidence.rows[0].cells[1].location.cell, 'B2');
      assert.equal(raw.source_projection.evidence.rows[0].cells[1].rawStorage, '1.2300');
      const output = h.services.processing!.outputArtifact(first.planId, 'selected');
      assert.deepEqual(JSON.parse(output.bytes.toString()).rows, [{ key: '000001', value: '1.23' }]);
      const second = await run('xlsx-selection-two', { ...choice, firstDataRow: 3, lastDataRow: 3 });
      assert.notEqual(second.steps.find(x => x.kind === 'parse')!.specDigest, parse.specDigest);
      assert.deepEqual(JSON.parse(h.services.processing!.outputArtifact(second.planId, 'selected').bytes.toString()).rows,
        [{ key: '000002', value: '9007199254740993' }]);
      await h.close(); h = await openFullChainHost(f);
      assert.equal(wfdSha256(h.services.processing!.outputArtifact(first.planId, 'selected').bytes), wfdSha256(output.bytes));
      assert.equal(h.services.materials!.readOriginal(materialId).sha256, wfdSha256(bytes));
    } finally { await h.close(); }
  });

test('手动投喂：未知二进制、代码与JSON信封保管后停在本地，不假称WFD拒绝或正式发布',
  { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires a dedicated isolated output root.' : false }, async () => {
    const f = createFullChainFixture({ name: 'manual-rejections' }), h = await openFullChainHost(f);
    try {
      for (const sample of [{ name: 'unknown.bin', category: 'unclassified' as const, bytes: Buffer.from([0, 255, 1, 2]) },
        { name: 'script.py', category: 'tool' as const, bytes: Buffer.from('print("sample")') },
        { name: 'envelope.json', category: 'data' as const, bytes: Buffer.from('{"rows":[{"x":"1"}]}') }]) {
        const uploaded = await h.upload(sample.name, sample.category, sample.bytes, sample.name + '-manual');
        const done = await h.settled(uploaded.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
        const material = h.services.materials!.getByTask(done.id)!;
        assert.equal(h.services.materials!.readOriginal(material.envelope.materialId).sha256, wfdSha256(sample.bytes));
        const accepted = await h.call('/processing/plans', { requestId: sample.name + '-plan', input: {
          routing: { materials: [{ materialId: material.envelope.materialId, intendedAction: 'inspect' }] },
          outputs: [{ outputId: 'local', materialIds: [material.envelope.materialId], intendedAction: 'inspect', tables: [{ materialId: material.envelope.materialId, format: 'json' }] }],
        } }, 202);
        const task = await h.settled(accepted.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
        const plan = h.services.processing!.getByTask(task.id)!.plan!;
        assert.equal(plan.outputs[0]!.publishEligible, false); assert.notEqual(plan.outputs[0]!.routingState, 'ready_candidate');
        assert.equal(plan.steps.find(x => x.kind === 'parse')!.applicability, 'unknown');
        assert.ok(plan.outputs[0]!.gaps.length > 0);
      }
      assert.equal(h.services.r1Workspace!.list().length, 0);
    } finally { await h.close(); }
  });

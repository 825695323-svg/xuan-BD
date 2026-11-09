import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createFullChainFixture, openFullChainHost, startDirect } from './full-chain-test-support.js';

function pdf() {
  const content = 'BT /F1 16 Tf 60 760 Td (Automatic evidence text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const offset = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(text);
}

test('ordinary material conversion automatically registers, indexes and reopens one linked artifact under persistent settings', async () => {
  const fixture = createFullChainFixture({ name: 'automatic-document' });
  let host = await openFullChainHost(fixture);
  try {
    await host.call('/retrieval/settings', { requestId: 'disable-auto-registration', autoRegister: 'disabled' });
    const uploaded = await host.upload('report.pdf', 'data', pdf(), 'automatic-pdf-source');
    await host.settled(uploaded.jobId);
    const material = host.services.materials!.getByTask(uploaded.jobId)!.envelope;
    const conversionView = await host.call('/retrieval/documents/' + material.materialId + '/convert', { requestId: 'automatic-conversion' }, 202);
    const conversion = { id: conversionView.jobId as string };
    const duplicate = await host.call('/retrieval/documents/' + material.materialId + '/convert', { requestId: 'automatic-conversion' }, 202);
    assert.equal(duplicate.jobId, conversion.id);
    await assert.rejects(() => host.call('/retrieval/documents/' + material.materialId + '/convert',
      { requestId: 'arbitrary-path-refused', destination: '/tmp/forbidden-conversion-output' }), /R1_WEB_INPUT|declared|已声明|接受/u);
    const result = await host.settled(conversion.id); assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(host.services.segments!.artifacts(material.materialId).length, 0);
    await host.call('/retrieval/settings', { requestId: 'enable-auto-registration', autoRegister: 'enabled' });
    let automatic: any;
    for (let n = 0; n < 100; n++) {
      const records = await host.call('/retrieval/documents/' + material.materialId + '/artifacts');
      automatic = records.automatic?.[0];
      if (automatic?.task?.status === 'succeeded') break;
      await delay(20);
    }
    assert.equal(automatic?.task?.status, 'succeeded', JSON.stringify(automatic));
    assert.equal(automatic.task.parentTaskId, conversion.id);
    const taskId = automatic.task.id;
    const protectedWrite = startDirect(host, 'conversion.document', { fileRefId: material.fileRefId,
      destination: host.services.files.verify(material.fileRefId).invocationPath }, 'protected-source-write');
    const refused = await host.settled(protectedWrite.id);
    assert.equal(refused.status, 'failed'); assert.equal(refused.error?.code, 'PROTECTED_RESOURCE');
    assert.deepEqual(readFileSync(host.services.files.verify(material.fileRefId).invocationPath), pdf());
    const found = await host.call('/retrieval/search', { method: 'exact', query: 'Automatic evidence text' });
    assert.equal(found.citations.length, 1);
    const citation = found.citations[0];
    await host.close(); host = await openFullChainHost(fixture);
    const reopened = await host.call('/retrieval/documents/' + material.materialId + '/artifacts');
    assert.equal(reopened.items.length, 1); assert.equal(reopened.automatic[0].task.id, taskId);
    const again = await host.call('/retrieval/search', { method: 'exact', query: 'Automatic evidence text' });
    assert.deepEqual(again.citations[0], citation);
  } finally { await host.close(); }
});

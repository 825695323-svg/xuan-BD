import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { TaskExecutionContext, TaskOperation } from '../../platform/jobs/tasks.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { PermissionService, digestOperationArgs, type OperationScope } from '../../platform/security/permissions.js';
import { directoryCapability } from '../../platform/runtime/file-workspace.js';
import { readPublicWeb, type PublicWebRequest, type PublicWebResponse } from '../../platform/capabilities/browser/public-web.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const publicAddress = [{ address: '8.8.8.8', family: 4 as const }];

function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-public-pdf-')));
  const artifactRoot = join(root, 'artifacts'); mkdirSync(artifactRoot);
  const database = new CoreDatabase(join(root, 'core.sqlite'));
  const permissions = new PermissionService({ database, isRunActive: () => true });
  const files = new FileReferenceService({ database, permissions });
  permissions.grant({ capabilities: [
    ...['read', 'write', 'delete'].map(action => directoryCapability(action as 'read' | 'write' | 'delete', artifactRoot)),
    ...['public.example.org', 'cdn.example.org'].map(host => ({ action: 'network' as const,
      target: { kind: 'network' as const, origin: `https://${host}` } })),
  ] });
  const context = (id: string, url = 'https://public.example.org/document') => {
    const runId = 'pdf-test-run', attemptId = `attempt-${id}`, generation = 1;
    const operationScope = (operation: TaskOperation): OperationScope => ({ ...operation, runId, attemptId, generation });
    return { task: { id, action: 'web.read_public', runtimeId: 'direct', args: { url }, conversationId: 'pdf-test-conversation' } as unknown as TaskRecord,
      runId, attemptId, generation, controlGeneration: null, signal: new AbortController().signal,
      emit: async () => {}, consumeBudget: () => { throw new Error('Unexpected budget consumption.'); }, operationScope,
      assertAuthorized: (operation, capabilities, options) => permissions.assertAuthorized(operationScope(operation), capabilities, options),
      requestApproval: async () => { throw new Error('Unexpected approval request.'); } } satisfies TaskExecutionContext;
  };
  const read = async (id: string, ctx: TaskExecutionContext) => {
    const reference = files.verify(id);
    const operation: TaskOperation = { operationId: 'test.pdf.readback', operationVersion: 1,
      argsDigest: digestOperationArgs({ id }), targets: [{ kind: 'file', path: reference.invocationPath }] };
    const bytes = await files.readBytes(id, { operation: ctx.operationScope(operation), maxBytes: 2 * 1024 * 1024 });
    return { reference, bytes };
  };
  return { root, artifactRoot, database, permissions, files, context, read,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

function response(status: number, contentType: string, bytes: Uint8Array, extra: Record<string, string> = {}, onClose?: () => void): PublicWebResponse {
  return { status, headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength), ...extra },
    body: (async function* () { yield bytes; })(), async close() { onClose?.(); } };
}

test('公开 PDF 经受控获取后保管真实原件与来源定位；HTML 仍返回原正文', async () => {
  const host = fixture();
  try {
    const requested: string[] = [], accepts: string[] = []; let closed = 0;
    const options = { resolve: async () => publicAddress, transport: async (request: PublicWebRequest) => {
      request.assertAuthorized(); requested.push(request.url.href); accepts.push(request.headers?.accept ?? '');
      if (request.url.hostname === 'public.example.org') return response(302, 'text/html', new Uint8Array(),
        { location: 'https://cdn.example.org/report.pdf' }, () => { closed++; });
      return response(200, 'application/pdf; charset=binary', pdf, { 'content-disposition': 'attachment; filename="../../outside.sh"' }, () => { closed++; });
    } };
    const ctx = host.context('pdf-success', 'https://public.example.org/document');
    const result = await readPublicWeb(ctx, { url: 'https://public.example.org/document' }, host.files, host.artifactRoot, options);
    assert.deepEqual(requested, ['https://public.example.org/document', 'https://cdn.example.org/report.pdf']);
    assert.equal(closed, 2); assert.ok(accepts.every(value => value.includes('application/pdf')));
    const data = result.data as Record<string, unknown>;
    assert.equal(data.fileRefId, data.rawRef); assert.equal(data.contentType, 'application/pdf');
    assert.equal(data.status, 'complete'); assert.equal(data.rawComplete, true);
    assert.equal(data.rawSha256, sha256(pdf));
    assert.equal(Object.hasOwn(data, 'textRef'), false); assert.equal(Object.hasOwn(data, 'text'), false);
    const modelPreview = data.modelPreview as Record<string, unknown>;
    assert.equal(modelPreview.fileRefId, data.rawRef);
    assert.equal(Object.hasOwn(modelPreview, 'textRef'), false);
    assert.match(String(modelPreview.guidance), /conversion\.document/u);
    assert.equal(result.artifactIds?.length, 2);
    const raw = await host.read(String(data.rawRef), ctx), locator = await host.read(String(data.locatorRef), ctx);
    assert.deepEqual(raw.bytes, pdf);
    assert.match(raw.reference.displayName, /^web-[a-f0-9-]+-source\.pdf$/u);
    assert.ok(raw.reference.relations.some(relation => relation.kind === 'task' && relation.id === ctx.task.id));
    const source = JSON.parse(locator.bytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(source.sourceURL, 'https://public.example.org/document');
    assert.equal(source.finalURL, 'https://cdn.example.org/report.pdf');
    assert.equal(source.rawRef, raw.reference.id); assert.equal(source.rawSha256, sha256(pdf));
    assert.equal(source.rawBytes, pdf.byteLength); assert.equal(source.contentType, 'application/pdf');
    assert.equal(source.httpStatus, 200); assert.equal(source.complete, true);
    assert.equal(Object.hasOwn(source, 'textRef'), false);
    assert.equal(readdirSync(host.artifactRoot).length, 2);

    const html = Buffer.from('<html><body><main>Existing HTML text</main></body></html>');
    const htmlCtx = host.context('html-unchanged');
    const htmlResult = await readPublicWeb(htmlCtx, { url: 'https://public.example.org/document' }, host.files, host.artifactRoot,
      { resolve: async () => publicAddress, transport: async request => {
        request.assertAuthorized(); return response(200, 'text/html; charset=utf-8', html);
      } });
    const htmlData = htmlResult.data as Record<string, unknown>;
    assert.equal(htmlResult.artifactIds?.length, 3);
    assert.notEqual(htmlData.fileRefId, htmlData.rawRef); assert.equal(htmlData.fileRefId, htmlData.textRef);
    assert.match((await host.read(String(htmlData.textRef), htmlCtx)).bytes.toString('utf8'), /Existing HTML text/u);
  } finally { host.close(); }
});

test('公开 PDF 拒绝伪内容、部分响应、非成功状态、长度错误、超限及私网地址', async () => {
  const host = fixture();
  try {
    const cases: { name: string; status: number; type: string; bytes: Uint8Array; extra?: Record<string, string>; code: string }[] = [
      { name: 'fake-pdf', status: 200, type: 'application/pdf', bytes: Buffer.from('<html>login</html>'), code: 'WEB_PDF_HEADER_INVALID' },
      { name: 'missing-version', status: 200, type: 'application/pdf', bytes: Buffer.from('%PDF-x.y\ninvalid'), code: 'WEB_PDF_HEADER_INVALID' },
      { name: 'other-binary', status: 200, type: 'application/octet-stream', bytes: pdf, code: 'WEB_CONTENT_UNSUPPORTED' },
      { name: 'partial-206', status: 206, type: 'application/pdf', bytes: pdf, code: 'WEB_PDF_RESPONSE_INCOMPLETE' },
      { name: 'partial-range', status: 200, type: 'application/pdf', bytes: pdf,
        extra: { 'content-range': 'bytes 0-31/100' }, code: 'WEB_PDF_RESPONSE_INCOMPLETE' },
      { name: 'http-404', status: 404, type: 'application/pdf', bytes: pdf, code: 'WEB_PDF_HTTP_STATUS' },
      { name: 'no-content-204', status: 204, type: 'application/pdf', bytes: new Uint8Array(), code: 'WEB_PDF_HTTP_STATUS' },
      { name: 'bad-length', status: 200, type: 'application/pdf', bytes: pdf,
        extra: { 'content-length': String(pdf.byteLength + 1) }, code: 'WEB_RESPONSE_INCOMPLETE' },
      { name: 'too-large', status: 200, type: 'application/pdf', bytes: Buffer.concat([pdf, Buffer.alloc(2 * 1024 * 1024)]),
        code: 'WEB_RESPONSE_LIMIT' },
    ];
    for (const item of cases) {
      const before = readdirSync(host.artifactRoot);
      let closed = 0;
      await assert.rejects(readPublicWeb(host.context(item.name), { url: 'https://public.example.org/document' }, host.files, host.artifactRoot,
        { resolve: async () => publicAddress, transport: async request => {
          request.assertAuthorized(); return response(item.status, item.type, item.bytes, item.extra, () => { closed++; });
        } }), { code: item.code });
      assert.equal(closed, 1, item.name); assert.deepEqual(readdirSync(host.artifactRoot), before, item.name);
    }
    let transported = false;
    await assert.rejects(readPublicWeb(host.context('private-dns'), { url: 'https://public.example.org/document' }, host.files, host.artifactRoot,
      { resolve: async () => [{ address: '127.0.0.1', family: 4 }], transport: async () => { transported = true; throw new Error('Private transport reached.'); } }),
    { code: 'WEB_ADDRESS_BLOCKED' });
    assert.equal(transported, false);
    let redirectCalls = 0, redirectClosed = 0;
    await assert.rejects(readPublicWeb(host.context('private-redirect'), { url: 'https://public.example.org/document' }, host.files, host.artifactRoot,
      { resolve: async () => publicAddress, transport: async request => {
        request.assertAuthorized(); redirectCalls++;
        return response(302, 'text/html', new Uint8Array(), { location: 'https://127.0.0.1/private.pdf' }, () => { redirectClosed++; });
      } }), { code: 'WEB_ADDRESS_BLOCKED' });
    assert.equal(redirectCalls, 1); assert.equal(redirectClosed, 1);
    await assert.rejects(readPublicWeb(host.context('ungranted', 'https://ungranted.example.org/document'),
      { url: 'https://ungranted.example.org/document' }, host.files, host.artifactRoot,
      { resolve: async () => publicAddress, transport: async () => { transported = true; throw new Error('Ungrant transport reached.'); } }),
    /Unexpected approval request/u);
    assert.equal(transported, false); assert.deepEqual(readdirSync(host.artifactRoot), []);
  } finally { host.close(); }
});

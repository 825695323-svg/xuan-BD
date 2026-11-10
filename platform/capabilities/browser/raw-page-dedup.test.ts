import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../state/database.js';
import { PermissionService } from '../../security/permissions.js';
import { TaskRuntimeRegistry, TaskService } from '../../jobs/tasks.js';
import { FileReferenceService } from '../../resources/files.js';
import { publishRawPage, type RawPageCapture } from './raw-page.js';

async function publish(input: { raw: string; text: string; dom?: string }) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'web-dedup-')));
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  const database = new CoreDatabase(join(root, 'db.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database, permissions });
  const runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database, permissions, runtimes });
  permissions.grant({ capabilities: (['read', 'write', 'delete'] as const).map(action => ({
    action, target: { kind: 'directory' as const, path: artifacts, recursive: true } })) });
  const capture: RawPageCapture = {
    action: 'web.read_public', sourceURL: 'https://example.test/page', finalURL: 'https://example.test/page',
    bytes: Buffer.from(input.raw), contentType: 'text/plain', charset: 'utf-8', sourceKind: 'http-response',
    httpStatus: 200, extraction: { text: input.text, title: 'test', extractor: 'raw-text', status: 'complete',
      complete: true, reasons: [], locations: [] },
    ...(input.dom === undefined ? {} : { domHTML: input.dom }),
  };
  runtimes.register({ id: 'web-dedup', execute: context => publishRawPage(context, files, artifacts, capture) });
  try {
    const started = tasks.create({ title: 'web dedup', runtimeId: 'web-dedup', action: 'web.read_public',
      args: { url: capture.sourceURL }, requestId: 'same-content', ownerRole: 'service' });
    tasks.start(started.id, started.version);
    const result = await tasks.wait(started.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    return result.result!;
  } finally { await tasks.dispose(); database.close(); }
}
test('byte-identical page, text and DOM reuse the same generated file and keep all semantic references', async () => {
  const result = await publish({ raw: 'raw original text', text: 'raw original text', dom: 'raw original text' });
  const data = result.data as Record<string, unknown>;
  assert.equal(data.rawRef, data.textRef);
  assert.equal(data.rawRef, data.domRef);
  assert.equal(new Set(result.artifactIds).size, result.artifactIds!.length);
  assert.equal(result.artifactIds!.length, 2, 'one content object plus locator');
});
test('different HTML or visible body remain independent evidence files', async () => {
  const result = await publish({ raw: '<html><body>before</body></html>', text: 'before', dom: '<html><body>after</body></html>' });
  const data = result.data as Record<string, unknown>;
  assert.notEqual(data.rawRef, data.textRef);
  assert.notEqual(data.rawRef, data.domRef);
  assert.equal(result.artifactIds!.length, 4);
});

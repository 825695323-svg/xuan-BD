import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { MaterialService } from '../../modules/collection/materials/service.js';
import { createMaterialOcrAdapter } from '../../modules/collection/materials/ocr-adapter.js';
import { createMediaPluginRegistrations } from '../../modules/collection/materials/plugins.js';
import type { MaterialMediaSourceReference } from '../../modules/collection/materials/plugins.js';
import { createLocalActions } from '../../platform/capabilities/local-actions.js';
import { parseVisionEvidence } from '../../platform/capabilities/ocr/evidence.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { createFullChainFixture } from './full-chain-test-support.js';

const binary = process.env.XUAN_TEST_VISION_OCR;
const optIn = process.platform === 'darwin' && binary && process.env.XUAN_FULL_CHAIN_ROOT;
function open(runtime: string, artifactRoot: string) {
  const database = new CoreDatabase(join(runtime, 'state/ocr-test.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (run, generation) => tasks.isRunActive(run, generation) });
  const resources = new ResourceBindings(runtime);
  const files = new FileReferenceService({ database, permissions, resources });
  const processRuntime = new ProcessRuntime(resources);
  const direct = createLocalActions({ files, artifactRoot, resources, processRuntime });
  const adapter = createMaterialOcrAdapter(() => direct.localOcr);
  direct.registry.register(createMediaPluginRegistrations(() => [adapter]).find(item => item.action === 'material.ocr')!);
  direct.registry.bindVersions('material.ocr', () => direct.localOcr.captureVersions());
  const runtimes = new TaskRuntimeRegistry();
  // Test dispatch harness only. The context, authority, task persistence, adapter,
  // staged process, actual Vision recognition and artifact publication are real.
  // This does NOT claim ConversationMaterialBridge/model-origin coverage.
  runtimes.register({ id: 'direct', async execute(context) {
    const source = context.task.args as unknown as MaterialMediaSourceReference;
    const outcome = await adapter.execute(source, context);
    return { summary: 'Actual local OCR adapter result', data: JSON.parse(JSON.stringify(outcome)) as JsonValue };
  } });
  const materials = new MaterialService({ database, tasks: () => tasks, files, resources, environment: 'synthetic-test' });
  runtimes.register(materials.runtime);
  tasks = new TaskService({ database, runtimes, permissions });
  const grant = (action: 'read' | 'write' | 'delete' | 'execute', path: string, directory = false) => permissions.grant({
    capabilities: [{ action, target: directory ? { kind: 'directory', path, recursive: true } : { kind: 'file', path } }],
    label: 'explicit isolated synthetic OCR test', scope: { kind: 'persistent' },
  });
  for (const action of ['read', 'write', 'delete'] as const) grant(action, artifactRoot, true);
  if (binary) grant('execute', realpathSync(binary));
  return { database, files, tasks, direct, adapter, grant, materials,
    async execute(source: MaterialMediaSourceReference) {
      const task = tasks.create({ title: 'Synthetic image OCR integration', runtimeId: 'direct', action: 'material.ocr',
        args: JSON.parse(JSON.stringify(source)), requestId: crypto.randomUUID(), versions: direct.localOcr.captureVersions() });
      tasks.start(task.id, task.version);
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        const current = tasks.get(task.id);
        if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return current;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('OCR_TASK_TIMEOUT');
    },
    async close() { await tasks.dispose(); database.close(); },
  };
}

test('actual optional local Vision through TaskService and material adapter preserves source and native evidence',
  { skip: optIn ? false : 'Requires macOS, XUAN_TEST_VISION_OCR compiled helper and isolated XUAN_FULL_CHAIN_ROOT.', timeout: 240000 }, async () => {
    const fixture = createFullChainFixture({ name: 'local-ocr-live' });
    const bindingPath = join(fixture.runtime, 'config/machine.bindings.json');
    const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
    bindings.resources.vision_ocr = { path: realpathSync(binary!), kind: 'program', sha256: wfdSha256(readFileSync(binary!)) };
    writeFileSync(bindingPath, JSON.stringify(bindings));
    const artifactRoot = join(fixture.root, 'artifacts'); mkdirSync(artifactRoot);
    const image = join(fixture.root, 'synthetic.png'), wrongFormat = join(fixture.root, 'synthetic.pdf');
    const canvas = createCanvas(1000, 240), context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 1000, 240);
    context.fillStyle = 'black'; context.font = '52px Arial'; context.fillText('SYNTHETIC TEST 2026', 40, 110);
    const bytes = canvas.toBuffer('image/png'), digest = wfdSha256(bytes);
    writeFileSync(image, bytes); writeFileSync(wrongFormat, bytes);
    let host = open(fixture.runtime, artifactRoot);
    try {
      assert.equal(host.adapter.availability().available, true);
      const reference = host.files.register({ path: image, source: 'user-selected' }); host.grant('read', image);
      const custody = host.materials.submit({ fileRefId: reference.id, category: 'unclassified', mediaType: 'image/png', expectedSha256: digest }, 'synthetic-custody');
      const custodyDeadline = Date.now() + 15000;
      while (!['succeeded', 'failed'].includes(host.tasks.get(custody.id).status) && Date.now() < custodyDeadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(host.tasks.get(custody.id).status, 'succeeded', JSON.stringify(host.tasks.get(custody.id).error));
      const held = host.materials.getByTask(custody.id)!.envelope;
      const source = { materialId: held.materialId, fileRefId: held.fileRefId, fileRefVersion: held.fileRefVersion, sha256: held.sha256 };
      assert.equal(source.sha256, digest);
      const finished = await host.execute(source);
      assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
      const outcome = finished.result!.data as any;
      assert.equal(outcome.status, 'extracted'); const result = outcome.result;
      assert.deepEqual(result.source, source);
      const artifact = (ref: any) => {
        const registered = host.files.verify(ref.fileRefId); assert.equal(registered.version, ref.fileRefVersion);
        const data = readFileSync(registered.invocationPath); assert.equal(wfdSha256(data), ref.sha256); return data.toString('utf8');
      };
      const text = artifact(result.textReference), json = artifact(result.evidenceReference);
      const evidence = parseVisionEvidence(json, text);
      assert.match(text, /SYNTHETIC TEST/u); // Coarse anchor, not accuracy certification.
      assert.equal(evidence.width, 1000); assert.equal(evidence.height, 240);
      assert.deepEqual(result.segments, evidence.observations.map(item => ({ text: item.text, location: { page: 1, region: item.boundingBox } })));
      assert.equal(result.segmentCount, evidence.observations.length);
      assert.equal(result.segmentsTruncated, false);
      assert.equal(wfdSha256(readFileSync(image)), digest);
      assert.throws(() => parseVisionEvidence(json, text + ' forged'));
      const changed = JSON.parse(json); changed.observations[0].boundingBox.x = 2;
      assert.throws(() => parseVisionEvidence(JSON.stringify(changed), text));
      for (const bad of [{ ...source, sha256: '0'.repeat(64) }, { ...source, fileRefVersion: source.fileRefVersion + 1 }]) {
        const denied = await host.execute(bad); assert.equal(denied.status, 'failed');
        assert.match(denied.error?.code ?? '', /MATERIAL_SOURCE_MISMATCH|MATERIAL_REFERENCE_CHANGED/);
      }
      const pdf = host.files.register({ path: wrongFormat, source: 'user-selected' }); host.grant('read', wrongFormat);
      const denied = await host.execute({ ...source, fileRefId: pdf.id, fileRefVersion: pdf.version });
      assert.equal(denied.status, 'failed'); assert.equal(denied.error?.code, 'UNSUPPORTED_INPUT');
      const count = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = open(fixture.runtime, artifactRoot);
      assert.equal(host.tasks.get(finished.id).status, 'succeeded');
      assert.equal(artifact(result.textReference), text); assert.equal(artifact(result.evidenceReference), json);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
      assert.equal(wfdSha256(readFileSync(image)), digest);
      await host.close();
      bindings.resources.vision_ocr.sha256 = '0'.repeat(64); writeFileSync(bindingPath, JSON.stringify(bindings));
      host = open(fixture.runtime, artifactRoot); assert.equal(host.adapter.availability().available, false);
      await host.close();
      delete bindings.resources.vision_ocr; writeFileSync(bindingPath, JSON.stringify(bindings));
      host = open(fixture.runtime, artifactRoot); assert.equal(host.adapter.availability().available, false);
    } finally { await host.close(); }
  });

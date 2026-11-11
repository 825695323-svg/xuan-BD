import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { BundledResources } from './bundled.js';
import { ResourceBindings } from './bindings.js';
import { ProcessRuntime } from '../runtime/programs.js';
import { DirectPathProtection } from '../security/path-protection.js';
import { fileCapability } from '../runtime/file-workspace.js';
import { trustedBundledDependencyRoot } from '../capabilities/local-actions.js';
import { createDirectRuntime } from '../../apps/server/capabilities.js';
import type { JsonValue } from '../../contracts/task-contracts.js';

const codeRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bundledPlatform = ['darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`);
const bundledResourceSkip = bundledPlatform && existsSync(join(codeRoot, 'resources/bundled/manifest.json'))
  ? false
  : '本项只验证 macOS arm64 / Windows x64 的真实随包资源；当前平台或资源清单不符合，必须在目标发行包单独验收。';
const testRoot = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bd-trusted-direct-')));
after(() => rmSync(testRoot, { recursive: true, force: true }));

function fixture(name: string, selected: Record<string, unknown>) {
  const root = join(testRoot, name);
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'artifacts'));
  mkdirSync(join(root, 'protected'));
  writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: name }));
  writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: name,
    resources: { ...selected, config: { path: join(root, 'config'), kind: 'directory' } } }));
  const resources = new ResourceBindings(root);
  return { root, resources, processRuntime: new ProcessRuntime(resources), artifactRoot: join(root, 'artifacts') };
}

test('fixed bundled video and transcription dependencies keep normal authorization and path boundaries', { skip: bundledResourceSkip }, async () => {
  const bundle = new BundledResources(codeRoot), host = fixture('bundled', bundle.selectedBindings());
  const model = bundle.model('whisper_base'), yt = bundle.executable('yt_dlp'), ffmpeg = bundle.executable('ffmpeg');
  const trusted = trustedBundledDependencyRoot(host, () => model);
  const protection = new DirectPathProtection([codeRoot, join(host.root, 'protected')], host.artifactRoot,
    { isRegisteredExecutable: path => host.processRuntime.isRegisteredExecutable(path) });
  const executeYt = fileCapability('execute', yt), executeFfmpeg = fileCapability('execute', ffmpeg), readModel = fileCapability('read', model);
  assert.equal(trusted('video.transcribe_url', executeYt), codeRoot);
  assert.equal(trusted('video.transcribe_url', executeFfmpeg), codeRoot);
  assert.equal(trusted('audio.transcribe', executeFfmpeg), codeRoot);
  assert.equal(trusted('material.transcribe', readModel), codeRoot);
  assert.doesNotThrow(() => protection.assertCapabilities([executeYt, readModel], capability => trusted('video.transcribe_url', capability)));
  assert.equal(trusted('audio.transcribe', executeYt), undefined);
  assert.equal(trusted('file.read', readModel), undefined);
  assert.throws(() => protection.assertPath(model), { code: 'PROTECTED_RESOURCE' });
  assert.throws(() => protection.assertCapabilities([fileCapability('write', yt)], capability => trusted('video.transcribe_url', capability)), { code: 'PROTECTED_RESOURCE' });
  const fake = join(host.root, 'protected/yt-dlp'); writeFileSync(fake, 'not bundled');
  assert.equal(trusted('video.transcribe_url', fileCapability('execute', fake)), undefined);
  assert.throws(() => protection.assertCapabilities([fileCapability('execute', fake)], capability => trusted('video.transcribe_url', capability)), { code: 'PROTECTED_RESOURCE' });
  const link = join(host.root, 'protected/yt-link'); symlinkSync(yt, link);
  assert.equal(trusted('video.transcribe_url', fileCapability('execute', link)), undefined);
  assert.throws(() => protection.assertPath(link), { code: 'PROTECTED_RESOURCE' });
  const ordinary = join(host.root, 'ordinary.txt'), hardlink = join(host.root, 'hardlink.txt');
  writeFileSync(ordinary, 'ordinary'); linkSync(ordinary, hardlink);
  assert.throws(() => protection.assertPath(hardlink), { code: 'HARDLINK_REFUSED' });
  const credentialProtection = new DirectPathProtection([codeRoot], host.artifactRoot,
    { credentialPaths: () => [model] });
  assert.throws(() => credentialProtection.assertCapabilities([readModel], capability => trusted('video.transcribe_url', capability)), { code: 'PROTECTED_RESOURCE' });

  // The path gate is before, not instead of, the existing TaskContext authorization.
  const direct = createDirectRuntime({ files: {} as never, artifactRoot: host.artifactRoot, resources: host.resources,
    processRuntime: host.processRuntime, protectedPaths: [codeRoot], whisperModelPath: model });
  const args = { url: 'https://www.bilibili.com/video/BV1rzJS6tEGt/' };
  const capabilities: unknown[][] = [];
  const denied = new Error('DENIED_BY_ORIGINAL_TASK_CONTEXT');
  const context = { task: { id: 'video-probe', action: 'video.transcribe_url', runtimeId: 'direct', args,
    versions: direct.registry.captureVersions('video.transcribe_url', args) }, signal: new AbortController().signal,
    emit: async () => {}, consumeBudget: () => {},
    assertAuthorized: (_operation: unknown, requested: unknown[]) => { capabilities.push(requested); throw denied; },
    requestApproval: async () => { throw new Error('unexpected approval'); } };
  await assert.rejects(direct.runtime.execute(context as never), error => error === denied);
  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0]!.map((capability: any) => [capability.action, capability.target.kind, capability.target.path]), [
    ['execute', 'file', yt], ['read', 'directory', host.artifactRoot], ['write', 'directory', host.artifactRoot],
    ['delete', 'directory', host.artifactRoot],
  ]);
  const audioFile = join(host.root, 'source.wav'); writeFileSync(audioFile, 'test audio bytes');
  const audioDirect = createDirectRuntime({ files: { verify: (id: string) => ({ kind: 'file', version: 1,
      invocationPath: id === 'model-source' ? model : audioFile, canonicalPath: id === 'model-source' ? model : audioFile }) } as never,
    artifactRoot: host.artifactRoot, resources: host.resources, processRuntime: host.processRuntime,
    protectedPaths: [codeRoot], whisperModelPath: model });
  const audioArgs = { fileRefId: 'audio-ref' }, audioCapabilities: unknown[][] = [];
  const audioContext = { task: { id: 'audio-probe', action: 'audio.transcribe', runtimeId: 'direct', args: audioArgs,
    versions: audioDirect.registry.captureVersions('audio.transcribe', audioArgs) }, signal: new AbortController().signal,
    emit: async () => {}, consumeBudget: () => {},
    assertAuthorized: (_operation: unknown, requested: unknown[]) => { audioCapabilities.push(requested); throw denied; },
    requestApproval: async () => { throw new Error('unexpected approval'); } };
  await assert.rejects(audioDirect.runtime.execute(audioContext as never), error => error === denied);
  assert.equal(audioCapabilities.length, 1);
  assert.deepEqual(audioCapabilities[0]!.map((capability: any) => [capability.action, capability.target.kind, capability.target.path]), [
    ['read', 'file', audioFile], ['read', 'file', model],
    ['execute', 'file', bundle.executable('ffmpeg')], ['execute', 'file', bundle.executable('ffprobe')],
    ['execute', 'file', bundle.executable('whisper_cli')],
    ['read', 'directory', host.artifactRoot], ['write', 'directory', host.artifactRoot], ['delete', 'directory', host.artifactRoot],
  ]);
  const blockedCases: Record<string, string>[] = [{ fileRefId: 'model-source' }, { fileRefId: 'audio-ref', destination: model }];
  for (const blockedArgs of blockedCases) {
    const previousCount: number = audioCapabilities.length;
    const blockedContext = { ...audioContext, task: { ...audioContext.task, args: blockedArgs,
      versions: audioDirect.registry.captureVersions('audio.transcribe', blockedArgs) } };
    await assert.rejects(audioDirect.runtime.execute(blockedContext as never), { code: 'PROTECTED_RESOURCE' });
    assert.equal(audioCapabilities.length, previousCount);
  }
  const fileDirect = createDirectRuntime({ files: { getRef: () => ({ invocationPath: model }) } as never,
    artifactRoot: host.artifactRoot, resources: host.resources, processRuntime: host.processRuntime,
    protectedPaths: [codeRoot], whisperModelPath: model });
  const fileArgs = { fileRefId: 'model-ref' };
  const fileContext = { task: { id: 'ordinary-file-probe', action: 'file.read', runtimeId: 'direct', args: fileArgs,
    versions: fileDirect.registry.captureVersions('file.read', fileArgs) }, signal: new AbortController().signal,
    emit: async () => {}, consumeBudget: () => {},
    assertAuthorized: () => { throw new Error('ordinary file action reached authorization'); },
    requestApproval: async () => { throw new Error('ordinary file action requested approval'); } };
  await assert.rejects(fileDirect.runtime.execute(fileContext as never), { code: 'PROTECTED_RESOURCE' });
});

test('media conversion trusts only its bundled ffmpeg and ffprobe executables', { skip: bundledResourceSkip }, async () => {
  const bundle = new BundledResources(codeRoot), host = fixture('media', bundle.selectedBindings());
  const ffmpeg = bundle.executable('ffmpeg'), ffprobe = bundle.executable('ffprobe');
  const yt = bundle.executable('yt_dlp'), model = bundle.model('whisper_base');
  const trusted = trustedBundledDependencyRoot(host, () => model);
  const protection = new DirectPathProtection([codeRoot], host.artifactRoot,
    { isRegisteredExecutable: path => host.processRuntime.isRegisteredExecutable(path) });
  for (const action of ['media.convert', 'conversion.media']) {
    assert.equal(trusted(action, fileCapability('execute', ffmpeg)), codeRoot);
    assert.equal(trusted(action, fileCapability('execute', ffprobe)), codeRoot);
    assert.equal(trusted(action, fileCapability('execute', yt)), undefined);
    assert.equal(trusted(action, fileCapability('read', model)), undefined);
    assert.equal(trusted(action, fileCapability('write', ffmpeg)), undefined);
    for (const capability of [fileCapability('execute', yt), fileCapability('read', model), fileCapability('write', ffmpeg)]) {
      assert.throws(() => protection.assertCapabilities([capability], requested => trusted(action, requested)), { code: 'PROTECTED_RESOURCE' });
    }
  }
  assert.equal(trusted('conversion.inspect', fileCapability('execute', ffmpeg)), undefined);

  const source = join(host.root, 'source.mp4'); writeFileSync(source, 'test media bytes');
  const denied = new Error('DENIED_BY_ORIGINAL_TASK_CONTEXT');
  const requested: unknown[][] = [];
  const files = {
    getRef: () => ({ id: 'media-ref', kind: 'file', invocationPath: source, canonicalPath: source }),
    verify: () => ({ id: 'media-ref', kind: 'file', invocationPath: source, canonicalPath: source }),
  };
  const direct = createDirectRuntime({ files: files as never, artifactRoot: host.artifactRoot,
    resources: host.resources, processRuntime: host.processRuntime, protectedPaths: [codeRoot], whisperModelPath: model });
  const contextFor = (action: string, args: Record<string, JsonValue>) => ({
    task: { id: action, action, runtimeId: 'direct', args, versions: direct.registry.captureVersions(action, args) },
    signal: new AbortController().signal, emit: async () => {}, consumeBudget: () => {},
    assertAuthorized: (_operation: unknown, capabilities: unknown[]) => { requested.push(capabilities); throw denied; },
    requestApproval: async () => { throw new Error('unexpected approval'); },
  });
  const cases: { action: string; args: Record<string, JsonValue> }[] = [
    { action: 'media.convert', args: { fileRefId: 'media-ref', format: 'mp3' } },
    { action: 'conversion.media', args: { fileRefId: 'media-ref', format: 'mp3', track: 0, startMs: 0, endMs: 1000 } },
  ];
  for (const { action, args } of cases) {
    await assert.rejects(direct.runtime.execute(contextFor(action, args) as never), error => error === denied);
    const capabilities = requested.at(-1)! as { action: string; target: { kind: string; path: string } }[];
    assert.deepEqual(capabilities.filter(capability => capability.action === 'execute')
      .map(capability => [capability.target.kind, capability.target.path]).sort(),
      [['file', ffmpeg], ['file', ffprobe]].sort());
  }
  assert.equal(requested.length, 2);

  for (const action of ['media.convert', 'conversion.media']) {
    const args: Record<string, JsonValue> = action === 'media.convert' ? { fileRefId: 'media-ref', format: 'mp3' }
      : { fileRefId: 'media-ref', format: 'mp3', track: 0, startMs: 0, endMs: 1000 };
    const blocked = createDirectRuntime({ files: { getRef: () => ({ kind: 'file', invocationPath: model, canonicalPath: model }),
      verify: () => ({ kind: 'file', invocationPath: model, canonicalPath: model }) } as never,
      artifactRoot: host.artifactRoot, resources: host.resources, processRuntime: host.processRuntime,
      protectedPaths: [codeRoot], whisperModelPath: model });
    const blockedContext = contextFor(action, args);
    blockedContext.task.versions = blocked.registry.captureVersions(action, args);
    await assert.rejects(blocked.runtime.execute(blockedContext as never), { code: 'PROTECTED_RESOURCE' });
    assert.equal(requested.length, 2);
    const outputArgs = { ...args, destination: model };
    const outputContext = contextFor(action, outputArgs);
    await assert.rejects(direct.runtime.execute(outputContext as never), { code: 'PROTECTED_RESOURCE' });
    assert.equal(requested.length, 2);
  }
});

test('binding and manifest drift remove trust; native policy does not enable transcription', { skip: bundledResourceSkip }, () => {
  const bundle = new BundledResources(codeRoot), host = fixture('drift', bundle.selectedBindings());
  const yt = bundle.executable('yt_dlp'), model = bundle.model('whisper_base');
  const trusted = trustedBundledDependencyRoot(host, () => model), execute = fileCapability('execute', yt), read = fileCapability('read', model);
  const ytBinding = host.resources.document.resources.yt_dlp!;
  ytBinding.sha256 = '0'.repeat(64);
  assert.equal(trusted('video.transcribe_url', execute), undefined);
  ytBinding.sha256 = bundle.manifest.platforms[bundle.platform]!.executables.yt_dlp!.sha256;
  ytBinding.path = join(host.root, 'protected/yt-dlp');
  assert.equal(trusted('video.transcribe_url', execute), undefined);
  ytBinding.path = yt;
  const modelBinding = host.resources.document.resources.whisper_base!;
  modelBinding.sha256 = '0'.repeat(64);
  assert.equal(trusted('audio.transcribe', read), undefined);
  modelBinding.sha256 = bundle.manifest.models.whisper_base!.sha256;
  const manifest = host.resources.document.resources.bundle_manifest!;
  manifest.sha256 = '0'.repeat(64);
  assert.equal(trusted('video.transcribe_url', execute), undefined);

  const native = fixture('native', {});
  const nativeTrusted = trustedBundledDependencyRoot(native, () => model);
  assert.equal(nativeTrusted('video.transcribe_url', execute), undefined);
  const direct = createDirectRuntime({ files: {} as never, artifactRoot: native.artifactRoot, resources: native.resources,
    processRuntime: native.processRuntime, protectedPaths: [codeRoot] });
  assert.equal(direct.registry.get('video.transcribe_url').availability.available, false);
  assert.equal(direct.registry.get('audio.transcribe').availability.available, false);
});

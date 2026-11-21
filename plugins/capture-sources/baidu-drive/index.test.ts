import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { TaskError, TaskRuntimeRegistry, TaskService } from '../../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../../platform/resources/bindings.js';
import { FileReferenceService } from '../../../platform/resources/files.js';
import { directoryCapability, fileCapability } from '../../../platform/runtime/file-workspace.js';
import { DirectProcessError } from '../../../platform/runtime/process.js';
import { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { digestOperationArgs, PermissionService, type PermissionCapability } from '../../../platform/security/permissions.js';
import { CoreDatabase } from '../../../platform/state/database.js';
import { createBaiduDriveActions, parseBaiduOutput, runBaiduSkillCommand, validateBaiduArgs } from './index.js';
import { BAIDU_DRIVE_SKILL } from './skill-snapshot.js';

const origin = 'https://pan.baidu.com';
const shareUrl = new URL('/s/' + randomUUID(), origin).href;
const destination = '/apps/bdpan/inbox', remotePath = destination + '/example.txt';
const viewUrl = origin + '/disk/main#/index?category=all';
const markdown = '[查看文件](' + viewUrl + ')';
const passcodeRef = 'fixture-share';
const list = { operation: 'transfer-list', shareUrl };
const select = { operation: 'transfer-select', shareUrl, fileIds: '90071992547409930001', path: destination };
const sourceDir = '/数据/一期';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('share action fields reject plaintext, ambiguous URLs, unsafe subdirectories and cross-operation parameters', () => {
  assert.equal(validateBaiduArgs({ ...list, sourceDir }), 'transfer-list');
  for (const path of ['', 'relative', '/a/../b', '/a\\b', '/a\u0000', '/a\u000a', '/'.padEnd(2049, 'a')])
    assert.throws(() => validateBaiduArgs({ ...list, sourceDir: path }), { code: 'BAIDU_ARGS_INVALID' });
  for (const action of [list, select]) {
    for (const ref of ['', '-option', '.ref', '/else', 'ref\n', 'a'.repeat(65)])
      assert.throws(() => validateBaiduArgs({ ...action, passcodeRef: ref }));
    for (const suffix of ['?', '#', '?pwd=', '#fragment', '\n', ' 提取码'])
      assert.throws(() => validateBaiduArgs({ ...action, shareUrl: shareUrl + suffix }));
    assert.throws(() => validateBaiduArgs({ ...action, passcode: randomBytes(5).toString('hex') }), { code: 'BAIDU_ARGS_INVALID' });
  }
  assert.equal(validateBaiduArgs({ ...list, path: sourceDir }), 'transfer-list');
  const invalidActions: Record<string, JsonValue>[] = [{ ...select, sourceDir }, { ...list, path: sourceDir, sourceDir }, { operation: 'ls', path: destination, passcodeRef }];
  for (const args of invalidActions)
    assert.throws(() => validateBaiduArgs(args));
});

/** 登记的离线替身只输出合成回执；它不记录命令行、分享地址或提取码。 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'bdpan-share-')));
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  const secret = randomBytes(6).toString('hex'), binaryPath = join(root, 'offline-bdpan');
  const configPath = join(root, 'config', 'offline.json'), credentialPath = join(root, 'config', 'fixture-refs.json');
  const resources: Record<string, unknown> = { bdpan: { kind: 'program', path: binaryPath } };
  for (const name of ['config', 'cache', 'temp', 'downloads']) {
    const path = join(root, name); mkdirSync(path);
    const stat = statSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path, owned: true, identity: 'fixture-' + name, device: String(stat.dev), inode: String(stat.ino) };
  }
  writeFileSync(binaryPath, `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
const [fixed, json, flag, config, command, ...args]=process.argv.slice(2);
if(fixed!=='--no-check-update'||json!=='--json'||flag!=='--config-path')throw Error('unexpected global flags');
const c=JSON.parse(fs.readFileSync(config)),index=args.indexOf('-p'),code=index<0?'':args[index+1];
if(command==='transfer'){
  if(c.protected !== (index>=0) || code && crypto.createHash('sha256').update(code).digest('hex')!==c.hash)throw Error('credential dispatch mismatch');
  if((args.includes('--source-dir') ? args[args.indexOf('--source-dir')+1] : null)!==c.sourceDir)throw Error('source directory mismatch');
  if(c.mode==='exit'){process.stderr.write('failed -p '+code);process.exit(2);}
  if(c.mode==='echo')console.log(JSON.stringify({items:[{name:'value '+code+' -p '+code}],return_markdown:c.markdown}));
  else process.stdout.write(c.transfer);
}else if(command==='ls'&&index<0){process.stdout.write(c.list);}
else if(command==='download'&&index<0){fs.writeFileSync(args[1],c.body,{flag:'wx'});console.log(JSON.stringify({status:'completed'}));}
else throw Error('unregistered command');
`, { mode: 0o700 });
  const securityPath = join(root, 'fixture-security'), started = join(root, 'keychain-read-started');
  writeFileSync(securityPath, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');
setTimeout(() => process.exit(2), 15000);`, { mode: 0o700 });
  resources.security = { kind: 'program', path: securityPath };
  writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'offline' }));
  writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'offline', resources }));
  const runtime = new ProcessRuntime(new ResourceBindings(root));
  const db = new CoreDatabase(join(root, 'state.sqlite'));
  const runtimes = new TaskRuntimeRegistry();
  let tasks: TaskService;
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  tasks = new TaskService({ database: db, runtimes, permissions });
  const files = new FileReferenceService({ database: db, permissions });
  const configuration = { binaryPath, configPath, sharePasscodeRefs: { [passcodeRef]: { kind: 'dsh-ref' as const, path: credentialPath, ref: 'FIXTURE_SHARE' } } };
  const actions = createBaiduDriveActions({ configuration, artifactRoot: artifacts, files, processRuntime: runtime, assertPath: () => {} });
  permissions.grant({ capabilities: [fileCapability('execute', binaryPath),
    ...['baidu-drive.native-login', 'baidu-drive.share-passcode.' + passcodeRef, 'baidu-drive.share-passcode.missing'].map(name =>
      ({ action: 'secret' as const, target: { kind: 'secret' as const, name } })),
    ...[origin, 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'].map(origin =>
      ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
    ...(['read', 'write', 'delete'] as const).map(action => directoryCapability(action, artifacts))] });
  runtimes.register({ id: 'direct', execute: context => actions.execute(context, context.task.args as Record<string, JsonValue>) });
  const credential = (value: string) => writeFileSync(credentialPath, JSON.stringify({ refs: { FIXTURE_SHARE: value } }), { mode: 0o600 });
  credential(secret);
  return { actions, files, secret, configuration, runtime, root, credential, tasks, securityPath, started,
    async run(args: Record<string, JsonValue>, config: Record<string, unknown> = {}) {
      writeFileSync(configPath, JSON.stringify({ hash: hash(secret), protected: !!args.passcodeRef, sourceDir: args.sourceDir ?? null,
        transfer: '{}', list: '[]', ...config }), { mode: 0o600 });
      const task = tasks.create({ action: 'baidu.drive', runtimeId: 'direct', title: '离线网盘核验', ownerRole: 'service', args, requestId: randomUUID() });
      tasks.start(task.id, task.version);
      return tasks.wait(task.id);
    },
    async close() { await tasks.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('private share list authorizes its exact reference, passes source-dir and redacts process diagnostics, previews and events', async () => {
  const f = fixture();
  try {
    const fields = f.actions.registrations[0]!.fields.map(item => item.key);
    assert.ok(fields.includes('sourceDir') && fields.includes('passcodeRef') && !fields.includes('passcode'));
    const result = await f.run({ ...list, sourceDir, passcodeRef }, { mode: 'echo', markdown });
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    const published = JSON.stringify({ result, events: f.tasks.events(result.id) });
    assert.ok(!published.includes(f.secret)); assert.match(published, /\[REDACTED\]/u);
    assert.equal((result.result?.data as Record<string, unknown>).return_markdown, markdown);
    const reflected = parseBaiduOutput(JSON.stringify({ items: ['-p', randomBytes(4).toString('hex'), f.secret],
      return_url: viewUrl + '&pwd=' + f.secret, return_markdown: '[查看](' + viewUrl + f.secret + ')' }), f.secret);
    assert.deepEqual(reflected, { items: ['-p', '[REDACTED]', '[REDACTED]'], return_url: null, return_markdown: null });
    const failed = await f.run({ ...list, passcodeRef }, { mode: 'exit' });
    assert.equal(failed.status, 'failed'); assert.ok(!JSON.stringify({ failed, events: f.tasks.events(failed.id) }).includes(f.secret));
    const context = { signal: new AbortController().signal, assertAuthorized: (_op: unknown, caps: { target: { name?: string } }[]) => {
      assert.ok(caps.some(cap => cap.target.name === 'baidu-drive.share-passcode.' + passcodeRef));
      throw new TaskError('DENIED_FIXTURE', '拒绝本次引用授权');
    } } as unknown as Parameters<typeof f.actions.execute>[0];
    await assert.rejects(f.actions.execute(context, { ...list, passcodeRef }), { code: 'DENIED_FIXTURE' });
    await assert.rejects(runBaiduSkillCommand({ context, configuration: f.configuration, processRuntime: f.runtime,
      workspacePath: f.root, assertCurrent() {}, args: ['transfer', 'list', shareUrl], sharePasscode: f.secret,
      runTool: async () => { throw new DirectProcessError('PROCESS_FAILED', '-p ' + f.secret, 'settled', 2, undefined, f.secret); } }),
    (error: unknown) => error instanceof DirectProcessError && error.diagnostic === '[REDACTED]' && !error.message.includes(f.secret));
    for (const value of ['', 'bad\nvalue', f.secret + '\n', '\t' + f.secret, 'too-long-for-this-reference', 'a/b!']) {
      f.credential(value);
      const unset = await f.run({ ...select, passcodeRef });
      assert.equal(unset.error?.code, 'BAIDU_PASSCODE_UNAVAILABLE');
      assert.ok(!f.tasks.events(unset.id).some(ev => ev.type === 'SIDE_EFFECT_STARTED'));
    }
    assert.equal((await f.run({ ...list, passcodeRef: 'missing' })).error?.code, 'BAIDU_PASSCODE_UNAVAILABLE');
  } finally { await f.close(); }
});

test('automatic permission policy requires the exact share secret even when another reference is granted', () => {
  const database = new CoreDatabase();
  try {
    const permissions = new PermissionService({ database, isRunActive: () => true });
    const secret = (ref: string): PermissionCapability => ({ action: 'secret', target: { kind: 'secret', name: 'baidu-drive.share-passcode.' + ref } });
    const requested = secret('selected');
    const operation = { approvalMode: 'automatic' as const, operationId: 'model.baidu.drive.transfer-list', operationVersion: 1,
      runId: 'synthetic-run', attemptId: 'synthetic-attempt', generation: 1, argsDigest: digestOperationArgs({ passcodeRef: 'selected' }),
      targets: [requested.target] };
    permissions.grant({ capabilities: [secret('different')] });
    assert.throws(() => permissions.assertAuthorized(operation, [requested]), { code: 'APPROVAL_REQUIRED' });
    const grant = permissions.grant({ capabilities: [requested] });
    assert.deepEqual(permissions.assertAuthorized(operation, [requested]).grantIds, [grant.id]);
  } finally { database.close(); }
});

test('keychain share lookup requires execute on the selected security binary and cancels the running lookup', {
  skip: process.platform !== 'darwin' && '系统钥匙串执行链仅在 macOS 可用', timeout: 10_000,
}, async () => {
  const f = fixture();
  try {
    const ref = 'keychain-slot';
    const actions = createBaiduDriveActions({ files: f.files, artifactRoot: join(f.root, 'artifacts'), processRuntime: f.runtime,
      configuration: { ...f.configuration, sharePasscodeRefs: { [ref]: { kind: 'keychain', service: 'fixture', account: 'fixture' } } }, assertPath() {} });
    // Fixture program only, no system keychain access. The selected client configuration must exist.
    writeFileSync(f.configuration.configPath, '{}');
    const stop = new AbortController(), args = { ...list, passcodeRef: ref };
    let checks = 0, deny = true;
    const context = { signal: stop.signal, assertAuthorized(_operation: unknown, capabilities: PermissionCapability[]) {
      checks++;
      assert.ok(capabilities.some(c => c.action === 'execute' && c.target.kind === 'file' && c.target.path === f.securityPath));
      assert.ok(capabilities.some(c => c.action === 'secret' && c.target.kind === 'secret' && c.target.name === 'baidu-drive.share-passcode.' + ref));
      if (deny) throw new TaskError('POLICY_DENIED', '合成执行授权拒绝。');
    } } as unknown as Parameters<typeof actions.execute>[0];
    await assert.rejects(actions.execute(context, args), { code: 'POLICY_DENIED' });
    assert.equal(existsSync(f.started), false);
    deny = false; checks = 0;
    const pending = actions.execute(context, args);
    try {
      for (let i = 0; i < 200 && !existsSync(f.started); i++) await delay(10);
      assert.ok(existsSync(f.started)); assert.ok(checks >= 4, '派发前和程序启动时均须复核任务授权');
    } finally { stop.abort(); }
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { await f.close(); }
});

test('transfer checks every selected source and destination ID, separates submitted and uncertain results, records business rejection', async () => {
  const f = fixture();
  const targetId = '90071992547409939999';
  const mapping = { from_fs_id: select.fileIds, to_fs_id: targetId, to: remotePath };
  const entry = { fs_id: targetId, path: remotePath, isdir: false, size: 19 };
  try {
    for (const [reply, listing, expected] of [
      [{ errno: 0 }, [], 'pending_verification'],
      [{ submitted: true, return_url: viewUrl }, [entry], 'submitted'],
      [{ status: 'completed', data: { extra: { list: [mapping] }, return_markdown: markdown } }, [entry], 'verified'],
      [{ data: { extra: { list: [mapping] } } }, [{ ...entry, fs_id: '9' }], 'pending_verification'],
      [{ list: [{ ...mapping, from_fs_id: '9' }] }, [entry], 'pending_verification'],
      [{ list: [mapping] }, { list: [entry], has_more: true }, 'pending_verification'],
      [{ list: [mapping] }, { data: { list: [entry] }, has_more: true }, 'pending_verification'],
      [{ list: [mapping] }, [{ ...entry, fsid: '9' }], 'pending_verification'],
      [{ list: [mapping] }, [entry, entry], 'pending_verification'],
    ] as const) {
      const task = await f.run({ ...select, passcodeRef }, { transfer: JSON.stringify(reply), list: JSON.stringify(listing) });
      const data = task.result?.data as Record<string, unknown>;
      assert.equal(data?.transferStatus, expected, JSON.stringify(task.error));
      assert.equal(data.complete, expected === 'verified'); assert.equal(task.requiresReview, expected !== 'verified');
      assert.equal(task.status, expected === 'verified' ? 'succeeded' : 'needs_review');
      assert.equal((task.checkpoint as Record<string, unknown>).transferStatus, expected);
      if (expected === 'verified') assert.equal(data.return_markdown, markdown);
      if (expected === 'submitted') assert.equal(data.return_url, viewUrl);
    }
    const batch = await f.run({ ...select, fileIds: select.fileIds + ',2' }, { transfer: JSON.stringify({ list: [mapping] }), list: JSON.stringify([entry]) });
    assert.equal((batch.result?.data as Record<string, unknown>).transferStatus, 'pending_verification');
    const secondTarget = destination + '/another.txt';
    const verifiedBatch = await f.run({ ...select, fileIds: select.fileIds + ',2' }, {
      transfer: JSON.stringify({ list: [mapping, { from_fs_id: 2, to_fs_id: 4, to: secondTarget }] }).replace('"' + targetId + '"', targetId),
      list: JSON.stringify([entry, { ...entry, fs_id: '4', path: secondTarget }]),
    });
    assert.equal((verifiedBatch.result?.data as Record<string, unknown>).transferStatus, 'verified');
    for (const reply of [{ code: 2 }, { data: { errno: -9 } }, { success: false }]) {
      const task = await f.run(select, { transfer: JSON.stringify({ ...reply, return_url: viewUrl }) });
      assert.equal((task.checkpoint as Record<string, unknown>).transferStatus, 'failed'); assert.equal(task.status, 'failed');
      assert.equal((task.checkpoint as Record<string, unknown>).return_url, viewUrl);
    }
    const body = 'fixture original\n';
    const signed = await f.run({ operation: 'download', path: remotePath }, { body, list: JSON.stringify([{ ...entry, size: Buffer.byteLength(body) }]) });
    assert.equal(signed.status, 'succeeded', JSON.stringify(signed.error));
    const data = signed.result!.data as Record<string, unknown>, file = f.files.verify(signed.result!.artifactIds![0]!);
    assert.equal(data.fileRefId, file.id); assert.equal(data.remotePath, remotePath); assert.equal(data.sha256, hash(readFileSync(file.invocationPath)));
  } finally { await f.close(); }
});

test('reviewed skill v3 freezes the matching guide and reference digests', () => {
  const skill = BAIDU_DRIVE_SKILL;
  assert.equal(skill.version, 3); assert.equal(skill.source.identifier, 'xuan-harness:reviewed-skill/baidu-drive');
  assert.equal(skill.originalBody, readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8'));
  for (const ref of skill.resources!) {
    assert.equal(ref.body, readFileSync(new URL('./' + ref.path, import.meta.url), 'utf8'));
    assert.equal(ref.digest, hash(ref.body));
  }
  assert.equal(skill.source.revision, hash(skill.originalBody + skill.resources!.map(ref => ref.path + '\n' + ref.digest + '\n').join('')));
});

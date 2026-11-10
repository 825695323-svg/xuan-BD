import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { FileReferenceService } from '../../platform/resources/files.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { PermissionService } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { CLOUD_EVIDENCE_ROOT, CLOUD_EVIDENCE_TOPICS, CLOUD_EVIDENCE_PURPOSES, cloudEvidenceDirectory, createBaiduCustodyBackend, type CloudCustodyBackend, type CloudObject, type CloudSession } from '../../plugins/storage/baidu-drive.js';

const sourceDirectory = '/apps/bdpan/selected';
const targetDirectory = cloudEvidenceDirectory('行情', '来源原件');
const topicDirectory = CLOUD_EVIDENCE_ROOT + '/行情';
const bytes = Buffer.from('item,value\nfixture,12\n');
const md5 = (value: Buffer) => createHash('md5').update(value).digest('hex');
type SessionInput = Parameters<CloudCustodyBackend['open']>[1];

/** 程序、账号引用、目录和状态库均为本测试新建；受控进程仅操作离线目录。 */
function fixture(sourcePath = sourceDirectory + '/renamed-original.csv') {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'baidu-copy-')));
  const runtime = join(root, 'runtime'), remoteRoot = join(root, 'offline-drive'), artifacts = join(root, 'artifacts');
  for (const directory of [runtime, remoteRoot, artifacts]) mkdirSync(directory);
  const resources: Record<string, unknown> = {};
  for (const name of ['config', 'cache', 'temp', 'downloads']) {
    const path = join(runtime, name); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[name] = { kind: 'directory', path, owned: true, identity: 'fixture-' + name, device: String(stat.dev), inode: String(stat.ino) };
  }
  const binaryPath = join(root, 'offline-bdpan'), configPath = join(runtime, 'config/offline-account.json');
  writeFileSync(configPath, JSON.stringify({ root: remoteRoot }), { mode: 0o600 });
  const source: CloudObject = { id: '90071992547409930001', path: sourcePath, kind: 'file', size: bytes.length, md5: md5(bytes) };
  const indexPath = join(remoteRoot, 'index.json');
  const rootObject: CloudObject = { id: '90071992547409930999', path: CLOUD_EVIDENCE_ROOT, kind: 'directory', size: 0, md5: null };
  writeFileSync(indexPath, JSON.stringify([source, rootObject])); writeFileSync(join(remoteRoot, source.id), bytes);
  writeFileSync(join(remoteRoot, 'calls.jsonl'), ''); writeFileSync(join(remoteRoot, 'fault'), '');
  writeFileSync(binaryPath, String.raw`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2);
if(args[0]!=='--no-check-update'||args[1]!=='--json'||args[2]!=='--config-path')throw Error('unsafe flags');
const root=JSON.parse(fs.readFileSync(args[3],'utf8')).root,indexPath=path.join(root,'index.json'),index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
const command=args[4],fault=fs.readFileSync(path.join(root,'fault'),'utf8');
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(args.slice(4))+'\n');
const publicObject=o=>({fsid:o.id,path:o.path,isdir:o.kind==='directory',size:o.size,md5:o.md5,download_url:'https://example.test/?token=synthetic-private-token',return_markdown:'synthetic account text'});
if(command==='ls'){
  if(fault==='list-failed')throw Error('offline listing failed');
  const start=Number(args[7]),limit=Number(args[9]);
  const children=index.filter(o=>path.posix.dirname(o.path)===args[5]).slice(start,start+limit);
  if(fault.startsWith('native-empty-')&&!children.length){
    const exact=index.find(o=>o.path===args[5]);
    const missing=fault==='native-empty-contradiction'?{code:1,data:null,error:'找不到指定的文件或目录（错误码 -9），请检查路径是否正确。',errno:-6}:fault==='native-empty-other-error'?{code:1,data:null,error:'访问权限不足（错误码 -6）。'}
      :fault==='native-empty-no-proof'?[]:fault==='native-empty-wrong-target'?[publicObject(index[0])]
      :{code:1,data:null,error:'找不到指定的文件或目录（错误码 -9），请检查路径是否正确。'};
    console.log(JSON.stringify(exact?[publicObject(exact)]:missing));
  }else console.log(JSON.stringify(children.map(publicObject)));
}else if(command==='cp'){
  const separator=args[5]==='--',positional=args.slice(separator?6:5);
  if(positional.length!==2||positional[0].startsWith('/')||positional[0].startsWith('-')&&!separator||positional[1]!=='证据盘/行情/来源原件')throw Error('copy needs app-relative arguments and an option separator for dash sources');
  const destination='/apps/bdpan/'+positional[1];
  if(!index.some(o=>o.path===destination&&o.kind==='directory'))throw Error('copy destination missing');
  const source=index.find(o=>o.path==='/apps/bdpan/'+positional[0]),target=path.posix.join(destination,path.posix.basename(source.path));
  if(index.some(o=>o.path===target))throw Error('offline fixture refuses overwrite');
  const content=fs.readFileSync(path.join(root,source.id));
  const copied={...source,id:String(BigInt(source.id)+1n),path:target};
  if(fault==='renamed')copied.path=target+'.renamed';
  if(fault==='target-mismatch')copied.md5='f'.repeat(32);
  if(fault==='source-changed')source.md5='e'.repeat(32);
  index.push(copied);fs.writeFileSync(path.join(root,copied.id),content,{flag:'wx'});fs.writeFileSync(indexPath,JSON.stringify(index));
  if(fault==='lost-response')process.stdout.write('{');
  else if(fault==='pending')console.log(JSON.stringify({status:'pending'}));
  else if(fault==='bad-receipt')console.log(JSON.stringify({...publicObject(copied),fsid:'123'}));
  else console.log(JSON.stringify({success:true,status:'completed'}));
}else if(command==='mkdir'){
  if(args.length!==6||!['证据盘/行情','证据盘/行情/来源原件'].includes(args[5]))throw Error('mkdir escaped the selected two-level directory or used an absolute argument');
  const target='/apps/bdpan/'+args[5];
  if(!index.some(o=>o.path===path.posix.dirname(target)&&o.kind==='directory')||index.some(o=>o.path===target))throw Error('mkdir parent missing or target occupied');
  const created={id:String(90071992547409931000n+BigInt(index.length)),path:target,kind:'directory',size:0,md5:null};
  index.push(created);fs.writeFileSync(indexPath,JSON.stringify(index));
  if(fault==='mkdir-lost-response')process.stdout.write('{');
  else if(fault==='mkdir-pending')console.log(JSON.stringify({status:'pending'}));
  else if(fault.startsWith('native-compact-'))console.log(JSON.stringify({code:0,data:{path:args[5]},error:''}));
  else console.log(JSON.stringify(publicObject(created)));
}else if(command==='upload'){
  if(args.length!==7||path.posix.dirname(args[6])!=='证据盘/行情/来源原件')throw Error('upload destination must be app-relative');
  const target='/apps/bdpan/'+args[6];
  if(!index.some(o=>o.path===path.posix.dirname(target)&&o.kind==='directory')||index.some(o=>o.path===target))throw Error('upload parent missing or target occupied');
  const content=fs.readFileSync(args[5]),created={id:String(90071992547409933000n+BigInt(index.length)),path:target,kind:'file',size:content.length,md5:crypto.createHash('md5').update(content).digest('hex')};
  index.push(created);fs.writeFileSync(path.join(root,created.id),content,{flag:'wx'});fs.writeFileSync(indexPath,JSON.stringify(index));
  if(fault==='upload-lost-response')process.stdout.write('{');
  else if(fault.startsWith('native-compact-'))console.log(JSON.stringify({code:0,data:{remote_path:args[6],fsid:created.id,
    ...(fault==='native-compact-contradiction'?{size:content.length+1}:fault==='native-compact-aliases'?{path:target,fs_id:'123',remote_path:'证据盘/行情/来源原件/wrong.csv'}:{})},error:''}));
  else console.log(JSON.stringify([publicObject(created)]));
}else if(command==='download'){
  const source=index.find(o=>o.path===args[5]);fs.writeFileSync(args[6],fs.readFileSync(path.join(root,source.id)),{flag:'wx'});
  console.log(JSON.stringify({success:true,status:'completed'}));
}else throw Error('offline fixture forbids other commands');
`, { mode: 0o700 });
  resources.bdpan = { kind: 'program', path: binaryPath };
  writeFileSync(join(runtime, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'offline-copy-fixture' }));
  writeFileSync(join(runtime, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'offline-copy-fixture', resources }));
  const processRuntime = new ProcessRuntime(new ResourceBindings(runtime)), db = new CoreDatabase(join(root, 'core.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database: db, isRunActive: (id, generation) => tasks?.isRunActive(id, generation) === true });
  const files = new FileReferenceService({ database: db, permissions }), runtimes = new TaskRuntimeRegistry();
  tasks = new TaskService({ database: db, runtimes, permissions });
  permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: binaryPath } },
    { action: 'secret', target: { kind: 'secret', name: 'baidu-drive.native-login' } },
    ...['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://d.pcs.baidu.com'].map(origin => ({ action: 'network' as const, target: { kind: 'network' as const, origin } })),
    ...(['read', 'write', 'delete'] as const).map(action => ({ action, target: { kind: 'directory' as const, path: artifacts, recursive: true } }))] });
  const backend = createBaiduCustodyBackend({ configuration: { binaryPath, configPath }, processRuntime, files, artifactRoot: artifacts });
  let work: (session: CloudSession) => Promise<void>, failure: unknown, completed = false;
  runtimes.register({ id: 'offline-copy', execute: async context => {
    const session = await backend.open(context, context.task.args as unknown as SessionInput);
    try { await work(session); completed = true; return { summary: '离线网盘定向核对完成', data: {} }; }
    catch (error) { failure = error; throw error; }
    finally { await session.close(); }
  } });
  return { root, source, backend,
    fault(value: string) { writeFileSync(join(remoteRoot, 'fault'), value); },
    addTarget(kind: CloudObject['kind'], content = bytes) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as CloudObject[];
      index.push({ ...source, id: '90071992547409930099', path: targetDirectory + '/renamed-original.csv', kind, size: content.length, md5: md5(content) });
      writeFileSync(indexPath, JSON.stringify(index));
    },
    addDirectory(path: string, kind: CloudObject['kind'] = 'directory') {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as CloudObject[];
      index.push({ id: String(90071992547409932000n + BigInt(index.length)), path, kind, size: 0, md5: null });
      writeFileSync(indexPath, JSON.stringify(index));
    },
    clearTarget() {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as CloudObject[];
      writeFileSync(indexPath, JSON.stringify([source, ...index.filter(item => item.kind === 'directory')]));
    },
    remove(path: string) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as CloudObject[];
      writeFileSync(indexPath, JSON.stringify(index.filter(item => item.path !== path)));
    },
    calls() { return readFileSync(join(remoteRoot, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]); },
    async run(action: (session: CloudSession) => Promise<void>, extra: Partial<SessionInput> = {}) {
      work = action; failure = undefined; completed = false;
      const input: SessionInput = { scopePath: sourceDirectory, sourceRemotePath: source.path, allowUpload: true, verifyBytes: true, targetDirectory, ...extra };
      const task = tasks.create({ title: '离线网盘复制', runtimeId: 'offline-copy', action: 'offline.copy', args: input as unknown as JsonValue, requestId: randomUUID() });
      tasks.start(task.id, task.version); const settled = await tasks.wait(task.id);
      if (failure) throw failure;
      assert.equal(completed, true, JSON.stringify(settled.error));
      return tasks.events(task.id);
    },
    async close() { await tasks.dispose(); db.close(); },
  };
}

test('registered offline CLI copies an unchanged source into the evidence directory and reads back its actual object without upload', async () => {
  const f = fixture();
  try {
    const events = await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, false), false);
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      const copied = await session.copy(f.source, targetDirectory);
      assert.equal(copied.path, targetDirectory + '/renamed-original.csv');
      assert.notEqual(copied.id, f.source.id); assert.equal(copied.size, bytes.length);
      assert.deepEqual(await session.read(copied, bytes.length), bytes);
      assert.deepEqual(await session.read(f.source, bytes.length), bytes);
      await assert.rejects(() => session.copy(f.source, targetDirectory));
    });
    assert.deepEqual(f.calls().filter(args => args[0] === 'mkdir'), [['mkdir', '证据盘/行情'], ['mkdir', '证据盘/行情/来源原件']]);
    assert.deepEqual(f.calls().filter(args => args[0] === 'cp'), [['cp', 'selected/renamed-original.csv', '证据盘/行情/来源原件']]);
    assert.equal(f.calls().some(args => args[0] === 'upload'), false);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-private-token|synthetic account text|download_url|return_markdown/u);
    assert.equal(f.backend.versionBinding.cloudBackend, 'baidu-drive-custody/3');
  } finally { await f.close(); }
});

test('app-relative copy uses an option separator for a root file beginning with a dash', async () => {
  const f = fixture('/apps/bdpan/-original.csv');
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      const copied = await session.copy(f.source, targetDirectory);
      assert.equal(copied.path, targetDirectory + '/-original.csv');
      assert.deepEqual(await session.read(copied, bytes.length), bytes);
    });
    assert.deepEqual(f.calls().filter(args => args[0] === 'cp'), [['cp', '--', '-original.csv', '证据盘/行情/来源原件']]);
    assert.equal(f.calls().some(args => args[0] === 'upload'), false);
  } finally { await f.close(); }
});

test('a new upload keeps its complete target identity but passes only an app-relative remote argument', async () => {
  const f = fixture();
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      const uploaded = await session.put(bytes, targetDirectory + '/new-original.csv');
      assert.equal(uploaded.path, targetDirectory + '/new-original.csv');
      assert.deepEqual(await session.read(uploaded, bytes.length), bytes);
    });
    const uploads = f.calls().filter(args => args[0] === 'upload');
    assert.equal(uploads.length, 1); assert.equal(uploads[0]![2], '证据盘/行情/来源原件/new-original.csv');
    assert.equal(uploads[0]![1]!.startsWith(f.root + '/artifacts/.direct-'), true);
    assert.equal(f.calls().some(args => args[0] === 'cp'), false);
  } finally { await f.close(); }
});

test('copy and mkdir require write authorization while old sessions remain readable', async () => {
  const f = fixture();
  try {
    for (const extra of [{ allowUpload: false }, { targetDirectory: sourceDirectory }]) {
      await f.run(async session => {
        await assert.rejects(() => session.copy(f.source, targetDirectory), { code: 'CLOUD_COPY_AUTHORIZATION_REQUIRED' });
        if (extra.targetDirectory === undefined) await assert.rejects(() => session.prepareDirectory(targetDirectory, true), { code: 'CLOUD_DIRECTORY_AUTHORIZATION_REQUIRED' });
      }, extra);
    }
    await f.run(async session => {
      await assert.rejects(() => session.copy(f.source, sourceDirectory), { code: 'CLOUD_COPY_AUTHORIZATION_REQUIRED' });
      await assert.rejects(() => session.put(bytes, sourceDirectory + '/new.csv'), { code: 'CLOUD_UPLOAD_AUTHORIZATION_REQUIRED' });
      assert.deepEqual(await session.read(f.source, bytes.length), bytes);
    }, { allowUpload: false, targetDirectory: sourceDirectory });
    assert.equal(f.calls().some(args => ['mkdir', 'cp', 'upload'].includes(args[0]!)), false);
  } finally { await f.close(); }
});

test('occupied names, changed frozen sources and failed listings never issue copy or upload', async () => {
  for (const kind of ['same-content', 'different-content', 'directory', 'source-changed', 'list-failed'] as const) {
    const f = fixture();
    try {
      if (kind === 'same-content') f.addTarget('file');
      if (kind === 'different-content') f.addTarget('file', Buffer.from('different content'));
      if (kind === 'directory') f.addTarget('directory');
      if (kind === 'list-failed') f.fault(kind);
      await f.run(async session => {
        if (kind !== 'list-failed') assert.equal(await session.prepareDirectory(targetDirectory, true), true);
        await assert.rejects(() => session.copy(kind === 'source-changed' ? { ...f.source, id: '456' } : f.source, targetDirectory));
      });
      assert.equal(f.calls().some(args => ['cp', 'upload'].includes(args[0]!)), false, kind);
    } finally { await f.close(); }
  }
});

test('a dispatched copy with an uncertain receipt or changed metadata preserves its target intent and refuses all further writes', async () => {
  for (const fault of ['lost-response', 'pending', 'bad-receipt', 'renamed', 'source-changed', 'target-mismatch']) {
    const f = fixture(); f.fault(fault);
    try {
      await f.run(async session => {
        assert.equal(await session.prepareDirectory(targetDirectory, true), true);
        await assert.rejects(() => session.copy(f.source, targetDirectory), { unknown: true });
        // 即使接着列举看不到目标，当前会话也不能复制重发或换成本地上传。
        f.clearTarget(); f.fault('');
        await assert.rejects(() => session.copy(f.source, targetDirectory));
        await assert.rejects(() => session.put(bytes, targetDirectory + '/renamed-original.csv'));
        await assert.rejects(() => session.put(bytes, targetDirectory + '/must-not-rename.csv'));
      });
      assert.equal(f.calls().filter(args => args[0] === 'cp').length, 1, fault);
      assert.equal(f.calls().some(args => args[0] === 'upload'), false, fault);
    } finally { await f.close(); }
  }
});

test('evidence paths accept only the bound two-level classification and read-only discovery creates nothing', async () => {
  assert.deepEqual(CLOUD_EVIDENCE_TOPICS, ['行情', '财报', '资讯', '资金流向', '市场情绪', '榜单', '待分类']);
  assert.deepEqual(CLOUD_EVIDENCE_PURPOSES, ['来源原件', '加工证据', '交接回执']);
  assert.equal(targetDirectory, '/apps/bdpan/证据盘/行情/来源原件');
  assert.throws(() => cloudEvidenceDirectory('行情/其他' as never, '来源原件'), { code: 'INVALID_CLOUD_EVIDENCE_CLASSIFICATION' });
  assert.throws(() => cloudEvidenceDirectory('行情', '任意用途' as never), { code: 'INVALID_CLOUD_EVIDENCE_CLASSIFICATION' });
  const f = fixture(); f.addDirectory(CLOUD_EVIDENCE_ROOT + '/财报');
  try {
    await f.run(async session => {
      for (const path of [CLOUD_EVIDENCE_ROOT, topicDirectory, targetDirectory + '/extra', cloudEvidenceDirectory('财报', '来源原件'), cloudEvidenceDirectory('行情', '加工证据')]) {
        await assert.rejects(() => session.prepareDirectory(path, true), { code: 'CLOUD_EVIDENCE_DIRECTORY_REQUIRED' });
        await assert.rejects(() => session.copy(f.source, path), { code: 'CLOUD_COPY_AUTHORIZATION_REQUIRED' });
        await assert.rejects(() => session.put(bytes, path + '/outside.csv'), { code: 'CLOUD_UPLOAD_AUTHORIZATION_REQUIRED' });
      }
      assert.equal(await session.prepareDirectory(targetDirectory, false), false);
    });
    assert.deepEqual(f.calls(), [['ls', '/apps/bdpan', '--start', '0', '--limit', '100'], ['ls', CLOUD_EVIDENCE_ROOT, '--start', '0', '--limit', '100']]);
  } finally { await f.close(); }
});

test('a missing evidence root is read-only false and is never created even for an authorized archive', async () => {
  const f = fixture(); f.remove(CLOUD_EVIDENCE_ROOT);
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, false), false);
      await assert.rejects(() => session.prepareDirectory(targetDirectory, true), { code: 'CLOUD_EVIDENCE_ROOT_MISSING' });
    });
    assert.equal(f.calls().some(args => args[0] === 'mkdir'), false);
  } finally { await f.close(); }
});

test('files occupying either classification level block creation without overwriting or renaming', async () => {
  for (const occupied of [topicDirectory, targetDirectory]) {
    const f = fixture();
    if (occupied === targetDirectory) f.addDirectory(topicDirectory);
    f.addDirectory(occupied, 'file');
    try {
      await f.run(async session => {
        await assert.rejects(() => session.prepareDirectory(targetDirectory, false), { code: 'CLOUD_DIRECTORY_CONFLICT' });
        await assert.rejects(() => session.prepareDirectory(targetDirectory, true), { code: 'CLOUD_DIRECTORY_CONFLICT' });
      });
      assert.equal(f.calls().some(args => ['mkdir', 'cp', 'upload'].includes(args[0]!)), false);
    } finally { await f.close(); }
  }
});

test('uncertain mkdir does not create the next level or repeat a creation and retains read-only source access', async () => {
  for (const fault of ['mkdir-lost-response', 'mkdir-pending']) {
    const f = fixture(); f.fault(fault);
    try {
      await f.run(async session => {
        await assert.rejects(() => session.prepareDirectory(targetDirectory, true), { unknown: true });
        f.remove(topicDirectory); f.fault('');
        await assert.rejects(() => session.prepareDirectory(targetDirectory, true), { code: 'CLOUD_WRITE_ALREADY_ATTEMPTED' });
        await assert.rejects(() => session.put(bytes, targetDirectory + '/original.csv'));
        assert.deepEqual(await session.read(f.source, bytes.length), bytes);
      });
      assert.deepEqual(f.calls().filter(args => args[0] === 'mkdir'), [['mkdir', '证据盘/行情']]);
      assert.equal(f.calls().some(args => ['cp', 'upload'].includes(args[0]!)), false);
    } finally { await f.close(); }
  }
});

test('a classification directory replaced after preparation blocks writing under its old identity', async () => {
  const f = fixture();
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      f.remove(topicDirectory); f.addDirectory(topicDirectory);
      await assert.rejects(() => session.copy(f.source, targetDirectory), { code: 'CLOUD_DIRECTORY_CHANGED' });
    });
    assert.equal(f.calls().filter(args => args[0] === 'mkdir').length, 2);
    assert.equal(f.calls().some(args => ['cp', 'upload'].includes(args[0]!)), false);
  } finally { await f.close(); }
});


test('native self-only directory remains unknown while exact child absence permits the declared new archive', async () => {
  const f = fixture(); f.fault('native-empty-self');
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, false), false);
      await assert.rejects(() => session.list(CLOUD_EVIDENCE_ROOT, 0, 100), { code: 'CLOUD_DIRECTORY_AMBIGUOUS' });
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      await assert.rejects(() => session.list(targetDirectory, 0, 100), { code: 'CLOUD_DIRECTORY_AMBIGUOUS' });
      const actual = await session.put(bytes, targetDirectory + '/exact-new-original.csv');
      assert.deepEqual(await session.read(actual, bytes.length), bytes);
    });
    assert.equal(f.calls().filter(args => args[0] === 'upload').length, 1);
    assert.ok(f.calls().some(args => args[0] === 'ls' && args[1] === targetDirectory + '/exact-new-original.csv'));
  } finally { await f.close(); }
});


test('exact child fallback does not turn access failure, empty arrays or other objects into absence', async () => {
  for (const [fault, code] of [['native-empty-contradiction', 'BAIDU_REJECTED'], ['native-empty-other-error', 'BAIDU_REJECTED'], ['native-empty-no-proof', 'CLOUD_OBJECT_UNVERIFIED'], ['native-empty-wrong-target', 'CLOUD_OBJECT_UNVERIFIED']]) {
    const f = fixture(); f.fault(fault!);
    try {
      await assert.rejects(() => f.run(session => session.prepareDirectory(targetDirectory, true).then(() => {})), { code });
      assert.equal(f.calls().some(args => ['mkdir', 'upload', 'cp'].includes(args[0]!)), false);
    } finally { await f.close(); }
  }
});


test('compact native receipts compare only supplied metadata against the exact persistent object and byte readback', async () => {
  const f = fixture(); f.fault('native-compact-receipt');
  try {
    await f.run(async session => {
      assert.equal(await session.prepareDirectory(targetDirectory, true), true);
      const actual = await session.put(bytes, targetDirectory + '/compact-original.csv');
      assert.deepEqual(await session.lookup!(actual.path), actual);
      assert.deepEqual(await session.read(actual, bytes.length), bytes);
    });
    assert.equal(f.calls().filter(args => args[0] === 'upload').length, 1);
  } finally { await f.close(); }
});

test('lost or contradictory upload receipts retain the staging and never repeat the issued upload', async () => {
  for (const fault of ['upload-lost-response', 'native-compact-contradiction', 'native-compact-aliases']) {
    const f = fixture(); f.fault(fault);
    const target = targetDirectory + '/uncertain-original.csv';
    try {
      await assert.rejects(() => f.run(async session => {
        assert.equal(await session.prepareDirectory(targetDirectory, true), true);
        await session.put(bytes, target);
      }), { code: 'CLOUD_UPLOAD_UNKNOWN_RESULT', unknown: true });
      assert.equal(f.calls().filter(args => args[0] === 'upload').length, 1);
      const retained = readdirSync(join(f.root, 'artifacts')).filter(name => name.startsWith('.direct-'));
      assert.equal(retained.length, 1);
      assert.ok(readdirSync(join(f.root, 'artifacts', retained[0]!)).length > 0);
      f.fault('');
      await f.run(async session => {
        const actual = await session.lookup!(target); assert.ok(actual);
        assert.deepEqual(await session.read(actual, bytes.length), bytes);
      }, { allowUpload: false, sourceRemotePath: target });
      assert.equal(f.calls().filter(args => args[0] === 'upload').length, 1);
    } finally { await f.close(); }
  }
});

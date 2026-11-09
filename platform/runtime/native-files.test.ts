import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromiumPipe, NativeFilesAdapter } from './native-files.js';
import { readWindowPlan } from '../../scripts/window.js';

test('只读窗口计划保留启动参数且不创建窗口资料或日志', () => {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'native-window-plan-')));
  try {
    mkdirSync(join(root, 'config'));
    const resources: Record<string, unknown> = {
      node: { kind: 'program', path: process.execPath }, browser_engine: { kind: 'program', path: process.execPath },
    };
    for (const name of ['browser_home', 'cache']) {
      const path = join(root, name);
      mkdirSync(path);
      const stat = lstatSync(path, { bigint: true });
      resources[name] = { path, kind: 'directory', owned: true, identity: name, device: String(stat.dev), inode: String(stat.ino) };
    }
    writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ application: 'xuan-bd', version: 1, identity: 'native-window-plan' }));
    writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'native-window-plan', resources }));
    const plan = readWindowPlan([`--runtime-root=${root}`, `--launcher=${join(root, 'unread-locator.json')}`], {});
    assert.equal(plan.url, 'http://127.0.0.1:4317/');
    assert.equal(plan.browserProgram, process.execPath);
    assert.ok(plan.browserArgs.includes('--remote-debugging-pipe'));
    assert.equal(plan.browserArgs.some(arg => arg.startsWith('--remote-debugging-port')), false);
    assert.equal(existsSync(plan.profilePath), false);
    assert.equal(existsSync(plan.logPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Chromium 私有管道支持分片、顺序及关闭时有界拒绝', async () => {
  const output = new PassThrough(), input = new PassThrough(), pipe = new ChromiumPipe(output, input);
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const first = pipe.send('Runtime.enable'), second = pipe.send('Page.enable');
  const requests = raw.split('\0').filter(Boolean).map(value => JSON.parse(value) as { id: number });
  assert.equal(requests.length, 2);
  const event = new Promise<string>(resolve => pipe.onEvent(value => resolve(value.method)));
  const replies = Buffer.from(JSON.stringify({ id: requests[1]!.id, result: { label: '中文' } }) + '\0'
    + JSON.stringify({ method: 'Page.frameNavigated', params: {} }) + '\0'
    + JSON.stringify({ id: requests[0]!.id, result: {} }) + '\0');
  input.write(replies.subarray(0, 17));
  input.write(replies.subarray(17));
  assert.deepEqual(await second, { label: '中文' });
  assert.deepEqual(await first, {});
  assert.equal(await event, 'Page.frameNavigated');
  const pending = pipe.send('DOM.getFileInfo');
  const rejected = assert.rejects(pending, /连接已失效/u);
  input.end();
  await rejected;
  await pipe.closed;
  await assert.rejects(pipe.send('Runtime.enable'), /连接已失效/u);
});

test('Chromium 私有管道的无响应命令有固定超时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = new PassThrough(), input = new PassThrough(), pipe = new ChromiumPipe(output, input);
  const pending = assert.rejects(pipe.send('DOM.getFileInfo'), /连接超时/u);
  t.mock.timers.tick(4_001);
  await pending;
  pipe.close();
});

test('页面安装异常返回 Error 对象时不会报告原路径桥就绪', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = new PassThrough(), input = new PassThrough(), pipe = new ChromiumPipe(output, input);
  const methods: string[] = [];
  let evaluated!: () => void;
  const evaluation = new Promise<void>(resolve => { evaluated = resolve; });
  const url = 'http://127.0.0.1:4317/';
  const target = { targetId: 'page', type: 'page', url };
  output.on('data', chunk => {
    const message = JSON.parse(chunk.toString().replace(/\0$/u, '')) as { id: number; method: string; sessionId?: string };
    methods.push(message.method);
    let result: object = {};
    if (message.method === 'Target.getTargets') result = { targetInfos: [target] };
    if (message.method === 'Target.attachToTarget') result = { sessionId: 'session' };
    if (message.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'frame', url } } };
    if (message.method === 'Runtime.enable') input.write(JSON.stringify({ method: 'Runtime.executionContextCreated', sessionId: 'session',
      params: { context: { id: 1, origin: new URL(url).origin, auxData: { isDefault: true, frameId: 'frame' } } } }) + '\0');
    if (message.method === 'Runtime.evaluate') result = { result: { type: 'object', subtype: 'error', objectId: 'exception-object' },
      exceptionDetails: { text: 'Uncaught' } };
    input.write(JSON.stringify({ id: message.id, result }) + '\0');
    if (message.method === 'Runtime.evaluate') evaluated();
  });
  const adapter = new NativeFilesAdapter(pipe, url);
  const rejected = assert.rejects(adapter.ready, /连接已失效/u);
  await evaluation;
  await Promise.resolve();
  t.mock.timers.tick(10_001);
  await rejected;
  assert.ok(methods.includes('Runtime.releaseObjectGroup'));
  await adapter.dispose();
  pipe.close();
});

const browserProgram = process.env.XUAN_NATIVE_FILES_BROWSER;
test('隔离真实 Chromium 的选择、拖放、无路径 File、来源限制与清理', { skip: !browserProgram, timeout: 60_000 }, async () => {
  assert.ok(browserProgram && isAbsolute(browserProgram), '必须明确指定受信 Chromium 程序的绝对路径');
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'native-file-bridge-'));
  const profile = join(root, 'chromium-profile');
  mkdirSync(join(root, '目录 一'));
  mkdirSync(join(root, '目录 二'));
  const first = join(root, '目录 一', '同名 文件.txt'), second = join(root, '目录 二', '同名 文件.txt');
  const large = join(root, '超过25MiB 稀疏原件.bin');
  writeFileSync(first, 'first'); writeFileSync(second, 'second'); writeFileSync(large, ''); truncateSync(large, 28 * 1024 * 1024);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><input id="files" type="file" multiple><script>'
      + 'document.addEventListener("drop", event => { event.preventDefault(); window.dropResult = window.__xuanNativeFiles.resolve(Array.from(event.dataTransfer.files)); });'
      + '</script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, url = `http://127.0.0.1:${port}/`;
  const child = spawn(browserProgram, [`--app=${url}`, `--user-data-dir=${profile}`, '--remote-debugging-pipe',
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--disable-gpu'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const input = child.stdio[4], output = child.stdio[3];
  assert.ok(input && 'read' in input && output && 'write' in output);
  const pipe = new ChromiumPipe(output, input), adapter = new NativeFilesAdapter(pipe, url);
  child.once('error', pipe.close); child.once('exit', pipe.close);
  const released = new Set<string>(), queried: string[] = [];
  const send = pipe.send.bind(pipe);
  let hold: Promise<void> | undefined, reached: (() => void) | undefined, release: (() => void) | undefined;
  pipe.send = async <T extends object = Record<string, unknown>>(method: string, params: object = {}, session?: string): Promise<T> => {
    if (method === 'Runtime.releaseObjectGroup') released.add((params as { objectGroup: string }).objectGroup);
    if (method === 'DOM.getFileInfo') {
      queried.push((params as { objectId: string }).objectId);
      if (hold) { reached?.(); await hold; }
    }
    try { return await send<T>(method, params, session); }
    catch (error) { throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const bounded = <T>(promise: Promise<T>, timeout = 3_000): Promise<T> => Promise.race([
    promise, delay(timeout).then(() => { throw new Error('隔离验收等待超时'); }),
  ]);
  const evaluate = async (expression: string, session: string): Promise<unknown> => {
    const reply = await pipe.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, session);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const sessionFor = async (targetId: string): Promise<string> => {
    const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Runtime.enable', {}, sessionId);
    return sessionId;
  };
  const waitForBridge = async (session: string): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate('typeof window.__xuanNativeFiles?.resolve === "function"', session).catch(() => false)) return;
      await delay(25);
    }
    throw new Error('本应用顶层桥未安装');
  };
  const setFiles = async (session: string, paths: string[]): Promise<void> => {
    const { root: document } = await pipe.send<{ root: { nodeId: number } }>('DOM.getDocument', {}, session);
    const { nodeId } = await pipe.send<{ nodeId: number }>('DOM.querySelector', { nodeId: document.nodeId, selector: '#files' }, session);
    await pipe.send('DOM.setFileInputFiles', { nodeId, files: paths }, session);
  };
  const pauseFileQuery = () => {
    hold = new Promise<void>(resolve => { release = resolve; });
    return new Promise<void>(resolve => { reached = resolve; });
  };
  try {
    await adapter.ready;
    const { targetInfos } = await pipe.send<{ targetInfos: { targetId: string; url: string }[] }>('Target.getTargets');
    const main = targetInfos.find(target => target.url === url);
    assert.ok(main);
    const session = await sessionFor(main.targetId);
    await waitForBridge(session);
    assert.equal(await evaluate('window.__xuanNativeFiles.version', session), 1);
    assert.equal(await evaluate('Object.getOwnPropertyNames(window).some(key => key.startsWith("__xuanFiles_"))', session), false);
    await evaluate(`(() => { for (const name of ['arrayBuffer', 'text', 'stream', 'slice', 'bytes']) {
      Object.defineProperty(Blob.prototype, name, { value() { throw new Error('禁止读取文件正文'); }, configurable: true });
    } })()`, session);
    await setFiles(session, [second, first, large]);
    assert.equal(await evaluate('document.querySelector("#files").files[2].size', session), 28 * 1024 * 1024);
    const selection = await evaluate(`window.__xuanNativeFiles.resolve([
      ...document.querySelector('#files').files,
      Object.assign(new File(['synthetic'], '伪造原件.txt'), { path: ${JSON.stringify(first)} })
    ])`, session);
    assert.deepEqual(selection, [second, first, large, null]);
    assert.deepEqual(await evaluate('window.__xuanNativeFiles.resolve([])', session), []);
    assert.equal(await evaluate(`window.__xuanNativeFiles.resolve([{ name: 'fake', path: ${JSON.stringify(first)} }]).then(() => false, () => true)`, session), true);
    await evaluate(`(() => {
      const dataTransfer = new DataTransfer();
      const files = document.querySelector('#files').files;
      dataTransfer.items.add(files[1]); dataTransfer.items.add(files[0]);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer }));
    })()`, session);
    assert.deepEqual(await evaluate('window.dropResult', session), [first, second]);
    assert.equal(await evaluate(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.onload = () => resolve(typeof frame.contentWindow.__xuanNativeFiles);
      frame.src = '/child'; document.body.append(frame);
    })`, session), 'undefined');
    assert.equal(await evaluate(`window.__xuanNativeFiles.resolve([new (document.querySelector('iframe').contentWindow.File)([], 'child')]).then(() => false, () => true)`, session), true);
    const { targetId: foreignTarget } = await pipe.send<{ targetId: string }>('Target.createTarget', { url: `http://localhost:${port}/` });
    const foreign = await sessionFor(foreignTarget);
    assert.equal(await evaluate('typeof window.__xuanNativeFiles', foreign), 'undefined');
    assert.equal(await evaluate('Object.getOwnPropertyNames(window).some(key => key.startsWith("__xuanFiles_"))', foreign), false);

    const navigationQuery = pauseFileQuery();
    const duringNavigation = evaluate(`window.__xuanNativeFiles.resolve([document.querySelector('#files').files[0]])`, session)
      .then(() => false, () => true);
    await bounded(navigationQuery);
    await pipe.send('Page.navigate', { url: `http://localhost:${port}/navigated` }, session);
    assert.equal(await bounded(duringNavigation), true);
    release?.(); hold = undefined;
    assert.equal(await evaluate('typeof window.__xuanNativeFiles', session), 'undefined');
    await pipe.send('Page.navigate', { url: url + 'next' }, session);
    await waitForBridge(session);
    await setFiles(session, [large]);
    const closingQuery = pauseFileQuery();
    const duringClose = evaluate(`window.__xuanNativeFiles.resolve([document.querySelector('#files').files[0]]).then(() => false, () => true)`, session);
    await bounded(closingQuery);
    await bounded(adapter.dispose());
    assert.equal(await bounded(duringClose), true);
    release?.(); hold = undefined;
    await delay(50);
    assert.ok(released.size >= 5, '批次与页面控制对象均应主动释放');
    assert.ok([...released].filter(group => group.includes('-request-')).length >= 4);
    assert.ok(queried.length >= 8);
    console.log(JSON.stringify({ nativeSelectionOrder: true, duplicateNamesUnicodeSpaces: true, largeOriginalBytes: 28 * 1024 * 1024,
      bodyReads: 0, syntheticFile: null, sharedDropResolver: true, subframeBridge: false, foreignOriginBridge: false,
      navigationRejected: true, closeRejected: true, releasedObjectGroups: released.size }));
  } finally {
    release?.(); hold = undefined;
    await adapter.dispose();
    await pipe.send('Browser.close').catch(() => {});
    pipe.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

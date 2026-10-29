import { request as httpRequest } from 'node:http';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { DirectError } from '../../runtime/file-workspace.js';
import { assertPublicWebAddress, pinnedGet, resolvePublic, responseKind, validatePublicWebUrl, type PublicWebOptions, type PublicWebResponse } from './public-web.js';
import { RAW_PAGE_MAX_BYTES } from './raw-page.js';

interface Connection { host: string; port: number }
export interface OwnedPageCapture {
  sourceURL: string; finalURL: string; bytes: Uint8Array; contentType: string; charset: string; httpStatus: number;
  domHTML?: string; reasons: string[]; observation: { blockedRequests: number; scriptsExecuted: false; cookiesImported: false; redirects: number; domLoadConfirmed: boolean };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hostForURL = (host: string) => host === '::1' ? '[::1]' : host;
function header(response: PublicWebResponse, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) throw new DirectError('WEB_HEADER_INVALID', '网页响应头不能唯一核对。');
  return typeof value === 'string' ? value : '';
}

/** 只取得已核自有 CDP（浏览器调试协议）端点；不发现其他端口或系统浏览器。 */
function browserSocket(connection: Connection, signal: AbortSignal, assertAuthorized: () => void): Promise<string> {
  return new Promise((done, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    const request = httpRequest({ hostname: connection.host, port: connection.port, path: '/json/version', method: 'GET', signal }, response => {
      response.on('data', chunk => { size += chunk.length; if (size > 32_000) request.destroy(new Error('CDP discovery exceeded')); else chunks.push(Buffer.from(chunk)); });
      response.once('error', fail); response.once('aborted', () => fail(new Error('CDP discovery aborted')));
      response.once('end', () => { try {
        assertAuthorized(); const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prefix = `ws://${hostForURL(connection.host)}:${connection.port}/devtools/browser/`;
        if (response.statusCode !== 200 || !object(value) || typeof value.webSocketDebuggerUrl !== 'string'
          || !value.webSocketDebuggerUrl.startsWith(prefix) || !/^[a-zA-Z0-9-]+$/u.test(value.webSocketDebuggerUrl.slice(prefix.length))) throw new Error('CDP discovery identity');
        done(value.webSocketDebuggerUrl);
      } catch { fail(new DirectError('BROWSER_CDP_UNVERIFIABLE', '原自有浏览器端点无法核对，未尝试其他连接。')); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error('CDP discovery timeout')));
    request.once('error', () => fail(new DirectError('BROWSER_CDP_UNAVAILABLE', '原自有浏览器调试端点未响应。')));
    try { assertAuthorized(); request.end(); } catch (error) { request.destroy(); fail(error); }
  });
}

/** 单个新建 about:blank（空白页）目标；固定导航/拦截/DOM 读取，不接受脚本、任意 CDP 命令或目标编号。 */
export async function captureOwnedPage(context: TaskExecutionContext, connection: Connection, source: URL, assertAuthorized: () => void, options: PublicWebOptions = {}): Promise<OwnedPageCapture> {
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
  const deadline = setTimeout(() => controller.abort(), 20_000);
  let socket: WebSocket | undefined, targetId: string | undefined, sessionId: string | undefined, frameId: string | undefined, sequence = 0, closing = false;
  const pending = new Map<number, { done(value: Record<string, unknown>): void; fail(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const requests = new Set<Promise<void>>(), reasons = new Set<string>();
  let blocked = 0, redirects = 0, responseCount = 0, navigating = false;
  let loaded!: () => void;
  const pageLoaded = new Promise<void>(done => { loaded = done; });
  let resolveCapture!: (value: OwnedPageCapture) => void, rejectCapture!: (error: unknown) => void;
  const captured = new Promise<OwnedPageCapture>((done, fail) => { resolveCapture = done; rejectCapture = fail; });
  void captured.catch(() => {});
  const stopped = () => { rejectCapture(new DirectError('BROWSER_REQUEST_STOPPED', '本次网页读取已停止；未自动重放导航。', true)); };
  signal.addEventListener('abort', stopped, { once: true });
  const send = (method: string, params: Record<string, unknown> = {}, session?: string, cleanup = false): Promise<Record<string, unknown>> => new Promise((done, fail) => {
    if (!cleanup) { try { signal.throwIfAborted(); assertAuthorized(); } catch (error) { fail(error); return; } }
    if (!socket || socket.readyState !== WebSocket.OPEN) { fail(new DirectError('BROWSER_CDP_UNKNOWN', '原浏览器连接已中断，本次目标状态待核。', true)); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); fail(new DirectError('BROWSER_CDP_UNKNOWN', '原浏览器命令未确认完成，不自动重放。', true)); }, cleanup ? 2000 : 10_000);
    pending.set(id, { done, fail, timer });
    try { socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })); }
    catch { clearTimeout(timer); pending.delete(id); fail(new DirectError('BROWSER_CDP_UNKNOWN', '本次浏览器命令发送结果待核。', true)); }
  });
  const paused = async (params: Record<string, unknown>, session: string): Promise<void> => {
    if (typeof params.requestId !== 'string') throw new DirectError('BROWSER_CDP_UNKNOWN', '浏览器拦截回执缺少原请求身份。', true);
    const failRequest = async (reason: string) => { blocked++; reasons.add(reason); await send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, session); };
    if (!object(params.request) || params.resourceType !== 'Document' || params.frameId !== frameId || session !== sessionId || params.request.method !== 'GET') {
      await failRequest('subresources-not-read'); return;
    }
    let url: URL;
    try { url = validatePublicWebUrl(String(params.request.url)); }
    catch { await failRequest('non-public-request-blocked'); throw new DirectError('BROWSER_NAVIGATION_BLOCKED', '网页试图访问非公开地址；访问前已拒绝。'); }
    if (url.origin !== source.origin) { await failRequest('outside-approved-origin-blocked'); throw new DirectError('BROWSER_REDIRECT_BLOCKED', '网页跳转超出本次获准来源，访问前已拒绝；需要另行明确目标。'); }
    if (++responseCount > 4) { await failRequest('redirect-limit'); throw new DirectError('WEB_REDIRECT_LIMIT', '网页超过本次三次同来源重定向上限。'); }
    let response: PublicWebResponse | undefined, next: URL | undefined, bytes = Buffer.alloc(0), kind: ReturnType<typeof responseKind> | undefined;
    try {
      const answers = await (options.resolve ?? resolvePublic)(url.hostname, signal);
      signal.throwIfAborted(); assertAuthorized();
      if (!answers.length || answers.length > 32) throw new DirectError('WEB_DNS_FAILED', '网页未解析到允许数量的公开地址。');
      for (const answer of answers) assertPublicWebAddress(answer);
      // 无凭据 GET（读取请求）；不导入、读取或转发本机 Cookie（登录凭据）。
      response = await (options.transport ?? pinnedGet)({ url, address: answers.find(answer => answer.family === 4) ?? answers[0]!, signal, assertAuthorized: () => { signal.throwIfAborted(); assertAuthorized(); } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 3) throw new DirectError('WEB_REDIRECT_LIMIT', '网页超过本次三次同来源重定向上限。');
        const location = header(response, 'location');
        if (!location || location.length > 4096) throw new DirectError('WEB_REDIRECT_INVALID', '网页重定向目标无效。');
        next = validatePublicWebUrl(new URL(location, url).href);
        if (next.origin !== source.origin) throw new DirectError('BROWSER_REDIRECT_BLOCKED', '网页重定向超出本次获准来源，尚未访问目标；需要另行明确网址。');
      } else {
        kind = responseKind(header(response, 'content-type'));
        if (kind.kind !== 'html') throw new DirectError('BROWSER_CONTENT_UNSUPPORTED', '浏览器原始提取只处理 HTML（网页源码）；普通文字或 JSON（结构化文本）请用公开网页读取。');
        const encoding = header(response, 'content-encoding'), length = header(response, 'content-length');
        if (encoding && encoding.toLowerCase() !== 'identity') throw new DirectError('WEB_ENCODING_UNSUPPORTED', '网页未返回本次要求的未压缩原始内容。');
        if (length && (!/^\d+$/u.test(length) || Number(length) > RAW_PAGE_MAX_BYTES)) throw new DirectError('WEB_RESPONSE_LIMIT', '网页原始响应超过本次 2 MiB 上限。');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted(); assertAuthorized();
          if (!(chunk instanceof Uint8Array) || (size += chunk.byteLength) > RAW_PAGE_MAX_BYTES) throw new DirectError('WEB_RESPONSE_LIMIT', '网页响应无效或超过本次 2 MiB 上限，未保留截断成功结果。');
          chunks.push(Buffer.from(chunk));
        }
        if (length && Number(length) !== size) throw new DirectError('WEB_RESPONSE_INCOMPLETE', '网页原始响应长度不完整。');
        bytes = Buffer.concat(chunks);
      }
    } finally {
      if (response) try { await response.close(); } catch { throw new DirectError('WEB_RESOURCES_UNKNOWN', '网页网络资源收束尚未确认。', true); }
    }
    signal.throwIfAborted(); assertAuthorized();
    await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: response!.status,
      responseHeaders: [{ name: 'Content-Type', value: next ? 'text/html; charset=utf-8' : `${kind!.mime}; charset=${kind!.charset}` },
        { name: 'Content-Length', value: String(bytes.length) },
        // 仅本次渲染视图关闭预连接、DNS（域名）预取和资源加载；原始响应字节不改写。
        { name: 'Content-Security-Policy', value: "default-src 'none'; base-uri 'none'; form-action 'none'; sandbox" },
        { name: 'X-DNS-Prefetch-Control', value: 'off' }, { name: 'Referrer-Policy', value: 'no-referrer' },
        { name: 'Cache-Control', value: 'no-store' }, { name: 'X-Content-Type-Options', value: 'nosniff' },
        ...(next ? [{ name: 'Location', value: next.href }] : [])], body: bytes.toString('base64') }, session);
    if (next) { redirects++; return; }
    resolveCapture({ sourceURL: source.href, finalURL: url.href, bytes, contentType: kind!.mime, charset: kind!.charset, httpStatus: response!.status,
      reasons: [], observation: { blockedRequests: 0, scriptsExecuted: false, cookiesImported: false, redirects, domLoadConfirmed: false } });
  };
  let result: OwnedPageCapture | undefined, failure: unknown;
  try {
    const endpoint = await browserSocket(connection, signal, assertAuthorized);
    socket = new WebSocket(endpoint);
    await new Promise<void>((done, fail) => { const abort = () => fail(new DirectError('BROWSER_REQUEST_STOPPED', '自有浏览器连接已停止。')); signal.addEventListener('abort', abort, { once: true });
      const finish = (error?: unknown) => { signal.removeEventListener('abort', abort); error ? fail(error) : done(); };
      socket!.addEventListener('open', () => finish(), { once: true }); socket!.addEventListener('error', () => finish(new DirectError('BROWSER_CDP_UNAVAILABLE', '原自有浏览器连接不可用。')), { once: true }); });
    socket.addEventListener('message', event => { try {
      const raw = String(event.data);
      if (Buffer.byteLength(raw, 'utf8') > RAW_PAGE_MAX_BYTES * 8) throw new Error('bounded CDP response exceeded');
      const value: unknown = JSON.parse(raw);
      if (!object(value)) throw new Error('invalid CDP envelope');
      if (typeof value.id === 'number') {
        const item = pending.get(value.id); if (!item) return;
        clearTimeout(item.timer); pending.delete(value.id);
        if (value.error || !object(value.result)) item.fail(new DirectError('BROWSER_CDP_UNKNOWN', '本次固定浏览器操作未得到完整确认。', true)); else item.done(value.result);
      } else if (!closing && navigating && value.method === 'Page.loadEventFired' && value.sessionId === sessionId) loaded();
      else if (!closing && value.method === 'Fetch.requestPaused' && object(value.params) && typeof value.sessionId === 'string') {
        const job = paused(value.params, value.sessionId).catch(error => { if (!closing || error instanceof DirectError && error.code === 'WEB_RESOURCES_UNKNOWN') { rejectCapture(error); failure ??= error; } }).finally(() => requests.delete(job)); requests.add(job);
      } else if (!closing && value.method === 'Target.attachedToTarget' && value.sessionId === sessionId && object(value.params) && object(value.params.targetInfo)
        && typeof value.params.targetInfo.targetId === 'string' && value.params.targetInfo.targetId !== targetId) {
        blocked++; reasons.add('child-target-not-read');
        const job = send('Target.closeTarget', { targetId: value.params.targetInfo.targetId }).then(() => {}).catch(error => { rejectCapture(error); failure ??= error; }).finally(() => requests.delete(job)); requests.add(job);
      }
    } catch { const error = new DirectError('BROWSER_CDP_UNKNOWN', '原浏览器返回超限或无效消息，目标状态待核。', true); rejectCapture(error); failure ??= error; } });
    socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.fail(new DirectError('BROWSER_CDP_UNKNOWN', '原浏览器连接已关闭，命令状态待核。', true)); } pending.clear(); if (!closing) stopped(); });
    const created = await send('Target.createTarget', { url: 'about:blank', background: true });
    if (typeof created.targetId !== 'string') throw new DirectError('BROWSER_CDP_UNKNOWN', '新建空白目标的身份未确认。', true);
    targetId = created.targetId;
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    if (typeof attached.sessionId !== 'string') throw new DirectError('BROWSER_CDP_UNKNOWN', '本次目标连接的身份未确认。', true);
    sessionId = attached.sessionId;
    await send('Page.enable', {}, sessionId);
    const tree = await send('Page.getFrameTree', {}, sessionId);
    if (!object(tree.frameTree) || !object(tree.frameTree.frame) || typeof tree.frameTree.frame.id !== 'string') throw new DirectError('BROWSER_CDP_UNKNOWN', '本次空白页主文档身份未确认。', true);
    frameId = tree.frameTree.frame.id;
    await send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
    await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    navigating = true;
    await send('Page.navigate', { url: source.href }, sessionId);
    result = await captured;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    result.observation.domLoadConfirmed = await Promise.race([pageLoaded.then(() => true), new Promise<boolean>(done => { loadTimer = setTimeout(() => done(false), 1500); })]);
    clearTimeout(loadTimer);
    if (result.observation.domLoadConfirmed) {
      const finalTree = await send('Page.getFrameTree', {}, sessionId);
      if (!object(finalTree.frameTree) || !object(finalTree.frameTree.frame) || finalTree.frameTree.frame.url !== result.finalURL) throw new DirectError('BROWSER_CDP_UNKNOWN', '本次文档树与已核原始响应来源不符。', true);
      const document = await send('DOM.getDocument', { depth: 0 }, sessionId);
      if (!object(document.root) || typeof document.root.nodeId !== 'number') throw new DirectError('BROWSER_CDP_UNKNOWN', '本次原始页面 DOM（文档树）未完整返回。', true);
      const dom = await send('DOM.getOuterHTML', { nodeId: document.root.nodeId }, sessionId);
      if (typeof dom.outerHTML !== 'string' || Buffer.byteLength(dom.outerHTML, 'utf8') > RAW_PAGE_MAX_BYTES) throw new DirectError('BROWSER_OUTPUT_LIMIT', '本次文档树超过读取预算；不把截断结果称为完整。');
      result.domHTML = dom.outerHTML;
    } else reasons.add('dom-load-not-confirmed');
  } catch (error) { failure ??= error; }
  finally {
    closing = true; controller.abort(); signal.removeEventListener('abort', stopped); clearTimeout(deadline);
    if (targetId && socket?.readyState === WebSocket.OPEN) {
      try { const closed = await send('Target.closeTarget', { targetId }, undefined, true); if (closed.success !== true) throw new Error('target closure unconfirmed'); }
      catch { failure = new DirectError('BROWSER_TARGET_CLOSE_UNKNOWN', '本次自有网页目标关闭尚未确认；保留原任务待核，不自动重放。', true); }
    } else if (targetId) failure = new DirectError('BROWSER_TARGET_CLOSE_UNKNOWN', '原连接中断，本次网页目标关闭尚未确认。', true);
    await Promise.allSettled([...requests]);
    for (const item of pending.values()) { clearTimeout(item.timer); item.fail(new DirectError('BROWSER_CDP_UNKNOWN', '本次连接正在收束。', true)); } pending.clear();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const activeSocket = socket;
      const closed = await new Promise<boolean>(done => { const timer = setTimeout(() => done(false), 2000); activeSocket.addEventListener('close', () => { clearTimeout(timer); done(true); }, { once: true }); activeSocket.close(); });
      if (!closed) failure = new DirectError('BROWSER_CDP_CLOSE_UNKNOWN', '本次浏览器连接收束尚未确认。', true);
    }
  }
  if (failure) throw failure;
  result!.reasons = [...reasons]; result!.observation.blockedRequests = blocked;
  return result!;
}

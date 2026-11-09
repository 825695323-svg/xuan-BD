import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

type Pending = { resolve(value: Record<string, any>): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> };
/** Optional isolated UI acceptance only. Uses an explicitly selected existing browser, never a logged-in profile. */
export async function openIsolatedBrowser(program: string, root: string) {
  const profile = join(root, 'browser-profile'), temp = join(root, 'browser-temp'); mkdirSync(profile); mkdirSync(temp);
  const child = spawn(program, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-sync', '--disable-extensions', '--password-store=basic', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--metrics-recording-only', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', 'about:blank'],
  { env: { HOME: root, TMPDIR: temp, PATH: '/usr/bin:/bin', LANG: 'zh_CN.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = ''; const timer = setTimeout(() => reject(new Error('Isolated browser did not expose loopback CDP: ' + stderr.slice(-2000))), 20000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); const found = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/u); if (found) { clearTimeout(timer); resolve(found[1]!); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated browser exited ${code}: ${stderr}`)); });
    });
    socket = new WebSocket(endpoint); await once(socket, 'open');
    const activeSocket = socket, pending = new Map<number, Pending>(), exceptions: unknown[] = [], blockedRequests: string[] = [], diagnostics: unknown[] = [];
    const requests: { url: string; method: string }[] = []; let id = 0;
    function call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
      return new Promise((resolve, reject) => { const requestId = ++id;
        diagnostics.push({ command: method, sessionId });
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP command timeout: ' + method + '; recent=' + JSON.stringify(diagnostics.slice(-20)))); }, 20000);
        pending.set(requestId, { resolve, reject, timer }); activeSocket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    activeSocket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') { const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result ?? {}); return; }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
      if (message.method === 'Fetch.requestPaused') {
        diagnostics.push({ event: message.method, sessionId: message.sessionId, request: message.params.request.url });
        const request = message.params, url = new URL(request.request.url), permitted = url.protocol === 'data:' || url.hostname === '127.0.0.1';
        if (!permitted) blockedRequests.push(url.origin);
        if (requests.length < 2048) requests.push({ url: request.request.url, method: request.request.method });
        void call(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: request.requestId, ...(!permitted ? { errorReason: 'BlockedByClient' } : {}) }, message.sessionId).catch(error => { diagnostics.push({ interceptionError: String(error) }); });
      }
    });
    activeSocket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Isolated browser connection closed')); } pending.clear(); });
    const target = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await call('Page.enable', {}, sessionId); await call('Runtime.enable', {}, sessionId);
    await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    const page = (method: string, params: Record<string, unknown> = {}) => call(method, params, sessionId);
    async function evaluate<T = unknown>(expression: string): Promise<T> {
      const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error('Page evaluation failed: ' + JSON.stringify(result.exceptionDetails)); return result.result.value as T;
    }
    async function until(expression: string, message: string, timeoutMs = 20000) {
      const start = Date.now(); while (Date.now() - start < timeoutMs) { if (await evaluate<boolean>(expression)) return; await delay(100); }
      throw new Error(message + ': ' + await evaluate('document.body.innerText.slice(-6000)') + '; browserState=' + JSON.stringify({
        exceptions, blockedRequests, requests: diagnostics.filter((item: any) => item.event).slice(-25), dom: await evaluate(`({page:document.querySelector('.app-shell')?.dataset.page,buttons:[...document.querySelectorAll('button[aria-label]')].map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled})),r1:document.querySelector('.r1-panel')?.getAttribute('aria-busy')})`) }));
    }
    async function click(text: string) {
      await until(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`, 'Button not available: ' + text);
      await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled); e.click();})()`);
      await until(`document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false'`, 'R1 action did not settle');
    }
    async function fill(label: string, value: string) {
      await evaluate(`(()=>{const label=[...document.querySelectorAll('.r1-panel label')].find(e=>e.firstChild?.textContent===${JSON.stringify(label)}); if(!label)throw new Error('Missing label');const e=label.querySelector('input,select,textarea'); if(!e||e.disabled)throw new Error('Input unavailable'); const type=e.tagName==='SELECT'?HTMLSelectElement:e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement; Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }
    return { page, evaluate, until, click, fill, exceptions, blockedRequests, requests, async close() {
      try { await call('Browser.close'); } catch { /* Browser close may close its socket before replying. */ }
      activeSocket.close(); if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exit, delay(5000, undefined, { ref: false })]); }
    } };
  } catch (error) { socket?.close(); if (child.exitCode === null) child.kill('SIGTERM'); throw error; }
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => { const channels = color.match(/[\d.]+/gu)?.slice(0, 3).map(value => Number(value) / 255); assert.ok(channels?.length === 3, color);
    return channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0); };
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

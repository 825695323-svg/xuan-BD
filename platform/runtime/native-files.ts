import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';

type Result = Record<string, unknown>;
export interface ChromiumEvent { method: string; params: Result; sessionId?: string }
interface Reply { id?: number; result?: Result; error?: { message: string }; method?: string; params?: Result; sessionId?: string }
const requestTimeout = 4_000;
const fileTimeout = 6_000;
const maxFiles = 128;
const unavailable = () => new Error('本机文件原路径连接已失效，请重新打开应用窗口。');

/** 只连接本启动器创建的 Chromium 私有管道；不监听网络端口。 */
export class ChromiumPipe {
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private ended = false;
  private readonly pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: ChromiumEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private finish!: () => void;
  readonly closed = new Promise<void>(resolve => { this.finish = resolve; });

  constructor(private readonly output: Writable, private readonly input: Readable) {
    input.on('data', this.receive);
    input.once('end', this.close);
    input.once('close', this.close);
    input.once('error', this.close);
    output.once('error', this.close);
  }

  send<T extends object = Result>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.ended) return Promise.reject(unavailable());
    const id = ++this.sequence;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本机文件原路径连接超时，请重新选择文件。'));
      }, requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
        if (error) this.close();
      });
    }) as Promise<T>;
  }

  onEvent(listener: (event: ChromiumEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    if (this.ended) listener(); else this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  close = (): void => {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.input.off('data', this.receive);
    this.input.destroy();
    this.output.destroy();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.listeners.clear();
    this.finish();
  };

  private receive = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(0)) !== -1) {
      const raw = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let message: Reply;
      try { message = JSON.parse(raw.toString('utf8')) as Reply; } catch { this.close(); return; }
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) listener({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
      }
    }
  };
}

interface Context {
  id: number;
  controller?: string;
  group: string;
  requests: Set<number>;
  groups: Set<string>;
}
interface Page { target: string; session: string; frame?: string; contexts: Map<number, Context> }
interface Target { targetId: string; type: string; url: string }
interface ExecutionContext { id: number; origin: string; auxData?: { isDefault?: boolean; frameId?: string } }

/** 页面只能提交已有 File 的批次编号；控制函数及远端对象引用始终留在宿主。 */
function bridgeSource(origin: string, binding: string): string {
  return `(() => {
    if (window !== window.top || location.origin !== ${JSON.stringify(origin)}) return;
    const notify = window[${JSON.stringify(binding)}];
    delete window[${JSON.stringify(binding)}];
    const pending = new Map();
    let sequence = 0, closed = false;
    const fail = () => new Error('本机文件原路径连接已失效，请重新打开应用窗口。');
    const finish = (id, paths, error) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      request.files.length = 0;
      if (error) request.reject(fail()); else request.resolve(paths);
    };
    const close = () => {
      closed = true;
      for (const id of pending.keys()) finish(id, null, true);
    };
    window.addEventListener('pagehide', close, { once: true });
    Object.defineProperty(window, '__xuanNativeFiles', { value: Object.freeze({ version: 1,
      resolve(files) {
        if (closed) return Promise.reject(fail());
        if (!Array.isArray(files) || files.length > ${maxFiles} || files.some(file => !(file instanceof File)))
          return Promise.reject(new TypeError('请选择浏览器提供的文件对象。'));
        if (!files.length) return Promise.resolve([]);
        if (pending.size >= 16) return Promise.reject(new Error('文件选择正在处理，请稍后重试。'));
        const copy = Array.from(files), id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(id, null, true), ${fileTimeout});
          pending.set(id, { files: copy, resolve, reject, timer });
          try { notify(JSON.stringify({ id, count: copy.length })); } catch { finish(id, null, true); }
        });
      }
    }) });
    return (operation, id, value) => {
      if (operation === 'take') return pending.get(id)?.files[value];
      if (operation === 'finish') finish(id, value, false);
      if (operation === 'fail') finish(id, null, true);
      if (operation === 'close') close();
    };
  })()`;
}

export class NativeFilesAdapter {
  private readonly origin: string;
  private readonly binding = '__xuanFiles_' + randomBytes(16).toString('hex');
  private readonly pages = new Map<string, Page>();
  private readonly attaching = new Set<string>();
  private stopped = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private readonly readyTimer = setTimeout(() => this.readyReject(unavailable()), 10_000);
  private readonly removeEvent: () => void;
  private removeClose: () => void = () => {};

  constructor(private readonly pipe: ChromiumPipe, applicationUrl: string) {
    this.origin = new URL(applicationUrl).origin;
    this.removeEvent = pipe.onEvent(this.event);
    this.removeClose = pipe.onClose(() => { void this.dispose(); });
    void this.discover().catch(error => { this.readyReject(error instanceof Error ? error : unavailable()); });
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.readyTimer);
    this.readyReject(unavailable());
    this.removeEvent();
    this.removeClose();
    await Promise.all([...this.pages.values()].map(page => this.clearPage(page)));
    this.pages.clear();
  }

  private allowed(url: string): boolean {
    try { return new URL(url).origin === this.origin; } catch { return false; }
  }

  private async discover(): Promise<void> {
    await this.pipe.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.pipe.send<{ targetInfos: Target[] }>('Target.getTargets');
    for (const target of targetInfos) this.target(target);
  }

  private target(target: Target): void {
    const page = [...this.pages.values()].find(candidate => candidate.target === target.targetId);
    if (target.type !== 'page' || !this.allowed(target.url)) {
      if (page) {
        this.pages.delete(page.session);
        void this.clearPage(page).finally(() => this.pipe.send('Target.detachFromTarget', { sessionId: page.session }).catch(() => {}));
      }
      return;
    }
    if (this.stopped || page || this.attaching.has(target.targetId)) return;
    this.attaching.add(target.targetId);
    void this.attach(target.targetId).catch(() => {}).finally(() => { this.attaching.delete(target.targetId); });
  }

  private async attach(target: string): Promise<void> {
    const { sessionId: session } = await this.pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target, flatten: true });
    if (this.stopped) return;
    const page: Page = { target, session, contexts: new Map() };
    this.pages.set(session, page);
    try {
      await this.pipe.send('Page.enable', {}, session);
      const { frameTree } = await this.pipe.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, session);
      if (!this.allowed(frameTree.frame.url)) throw unavailable();
      page.frame = frameTree.frame.id;
      await this.pipe.send('Runtime.enable', {}, session);
    } catch (error) {
      this.pages.delete(session);
      await this.clearPage(page);
      await this.pipe.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
      throw error;
    }
  }

  private event = ({ method, params, sessionId }: ChromiumEvent): void => {
    if (this.stopped) return;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') { this.target(params.targetInfo as Target); return; }
    if (method === 'Target.detachedFromTarget') {
      const page = this.pages.get(params.sessionId as string);
      if (page) { this.pages.delete(page.session); void this.clearPage(page); }
      return;
    }
    const page = sessionId ? this.pages.get(sessionId) : undefined;
    if (!page) return;
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context as unknown as ExecutionContext;
      if (context.origin === this.origin && context.auxData?.isDefault && context.auxData.frameId === page.frame)
        void this.install(page, context.id).catch(() => {});
    } else if (method === 'Runtime.executionContextDestroyed') {
      const context = page.contexts.get(params.executionContextId as number);
      if (context) { page.contexts.delete(context.id); void this.clearContext(page, context); }
    } else if (method === 'Runtime.executionContextsCleared') {
      void this.clearPage(page);
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame as { id: string; parentId?: string; url: string };
      if (!frame.parentId) { page.frame = frame.id; if (!this.allowed(frame.url)) void this.clearPage(page); }
    } else if (method === 'Runtime.bindingCalled' && params.name === this.binding) {
      const context = page.contexts.get(params.executionContextId as number);
      if (context?.controller && typeof params.payload === 'string') void this.resolveFiles(page, context, params.payload);
    }
  };

  private current(page: Page, context: Context): boolean {
    return !this.stopped && this.pages.get(page.session) === page && page.contexts.get(context.id) === context;
  }

  private async install(page: Page, id: number): Promise<void> {
    const context: Context = { id, group: `${this.binding}-${page.session}-${id}`, requests: new Set(), groups: new Set() };
    page.contexts.set(id, context);
    await this.pipe.send('Runtime.addBinding', { name: this.binding, executionContextId: id }, page.session);
    if (!this.current(page, context)) return;
    const { result, exceptionDetails } = await this.pipe.send<{ result: { objectId?: string; type: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: bridgeSource(this.origin, this.binding), contextId: id, objectGroup: context.group,
    }, page.session);
    if (exceptionDetails || result.type !== 'function' || !result.objectId) {
      if (page.contexts.get(id) === context) page.contexts.delete(id);
      await this.clearContext(page, context);
      return;
    }
    context.controller = result.objectId;
    if (!context.controller || !this.current(page, context)) { await this.clearContext(page, context); return; }
    clearTimeout(this.readyTimer);
    this.readyResolve();
  }

  private control<T extends object = Result>(page: Page, context: Context, args: unknown[], group?: string): Promise<T> {
    return this.pipe.send<T>('Runtime.callFunctionOn', {
      objectId: context.controller, functionDeclaration: 'function(...args) { return this(...args); }',
      arguments: args.map(value => ({ value })), ...(group ? { objectGroup: group } : { returnByValue: true }),
    }, page.session);
  }

  private async resolveFiles(page: Page, context: Context, payload: string): Promise<void> {
    let request: { id: number; count: number };
    try { request = JSON.parse(payload) as typeof request; } catch { return; }
    if (!request || !Number.isSafeInteger(request.id) || request.id < 1 || !Number.isSafeInteger(request.count)
      || request.count < 1 || request.count > maxFiles || context.requests.has(request.id) || context.requests.size >= 16) return;
    context.requests.add(request.id);
    const group = `${context.group}-request-${request.id}`;
    context.groups.add(group);
    try {
      const paths: (string | null)[] = [];
      for (let index = 0; index < request.count; index++) {
        if (!this.current(page, context)) throw unavailable();
        const { result } = await this.control<{ result: { objectId?: string } }>(page, context, ['take', request.id, index], group);
        if (!result.objectId || !this.current(page, context)) throw unavailable();
        const { path } = await this.pipe.send<{ path: string }>('DOM.getFileInfo', { objectId: result.objectId }, page.session);
        paths.push(typeof path === 'string' && isAbsolute(path) && !path.includes('\0') ? path : null);
      }
      if (this.current(page, context)) await this.control(page, context, ['finish', request.id, paths]);
    } catch {
      if (this.current(page, context)) await this.control(page, context, ['fail', request.id]).catch(() => {});
    } finally {
      context.requests.delete(request.id);
      context.groups.delete(group);
      await this.pipe.send('Runtime.releaseObjectGroup', { objectGroup: group }, page.session).catch(() => {});
    }
  }

  private async clearContext(page: Page, context: Context): Promise<void> {
    const closing = context.controller ? this.control(page, context, ['close']).catch(() => {}) : Promise.resolve();
    const releases = [context.group, ...context.groups].map(objectGroup =>
      this.pipe.send('Runtime.releaseObjectGroup', { objectGroup }, page.session).catch(() => {}));
    context.requests.clear();
    context.groups.clear();
    await Promise.all([closing, ...releases]);
  }

  private async clearPage(page: Page): Promise<void> {
    const contexts = [...page.contexts.values()];
    page.contexts.clear();
    await Promise.all(contexts.map(context => this.clearContext(page, context)));
  }
}

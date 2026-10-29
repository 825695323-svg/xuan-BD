import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import { acquireAuthority, DirectError, type DirectAuthority } from '../../runtime/file-workspace.js';
import { assertPublicWebAddress, resolvePublic, validatePublicWebUrl } from '../browser/public-web.js';

/** 仅给固定提取工具使用的临时 HTTPS 隧道。逐域批准、逐连接解析和钉住公开地址。 */
export async function createVideoProxy(context: TaskExecutionContext, maxBytes: number) {
  const token = randomBytes(24).toString('hex');
  const authorization = 'Basic ' + Buffer.from('mashiro:' + token).toString('base64');
  const sockets = new Set<Socket>(), pending = new Set<Promise<void>>(), closingSockets = new Set<Promise<void>>();
  let closeDone: Promise<void> | undefined;
  const authorities = new Map<string, DirectAuthority>();
  let authorizationQueue = Promise.resolve(), bytes = 0, closed = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on('error', () => {});
    const closed = new Promise<void>((resolve) => socket.once('close', () => { sockets.delete(socket); resolve(); }));
    closingSockets.add(closed); void closed.then(() => closingSockets.delete(closed));
  };
  server.on('connection', track);
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('connect', (req, client, head) => {
    const operation = (async () => {
      try {
        if (closed || req.headers['proxy-authorization'] !== authorization || !req.url || !/^[a-z0-9.-]+:443$/iu.test(req.url)) throw new Error('refused');
        const url = validatePublicWebUrl('https://' + req.url);
        let authority: DirectAuthority | undefined;
        const previous = authorizationQueue;
        authorizationQueue = (async () => {
          await previous;
          signal.throwIfAborted();
          authority = authorities.get(url.origin);
          if (!authority) {
            authority = await acquireAuthority({ ...context, signal }, 'video.network.' + url.hostname, { origin: url.origin }, [{ action: 'network', target: { kind: 'network', origin: url.origin } }]);
            authorities.set(url.origin, authority);
          }
        })();
        await authorizationQueue;
        if (client.destroyed) return;
        signal.throwIfAborted(); authority!.assert();
        const addresses = await resolvePublic(url.hostname, signal);
        if (!addresses.length || addresses.length > 32) throw new Error('dns');
        addresses.forEach(assertPublicWebAddress);
        const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
        signal.throwIfAborted(); authority!.assert();
        const remote = connect({ host: address.address, port: 443, family: address.family }); track(remote);
        const destroy = () => { remote.destroy(); client.destroy(); };
        remote.once('error', destroy); client.once('error', destroy);
        remote.once('close', () => client.destroy()); client.once('close', () => remote.destroy());
        remote.setTimeout(60_000, destroy);
        const check = (chunk: Buffer) => {
          try { signal.throwIfAborted(); authority!.assert(); bytes += chunk.length; if (bytes > maxBytes) throw new Error('budget'); }
          catch { destroy(); }
        };
        remote.on('data', check); client.on('data', check);
        remote.once('connect', () => {
          try { signal.throwIfAborted(); authority!.assert(); if (client.destroyed) return remote.destroy();
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) { check(head); if (!remote.destroyed) remote.write(head); }
            client.pipe(remote); remote.pipe(client);
          } catch { destroy(); }
        });
      } catch { client.destroy(); }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  });
  const abort = () => { for (const socket of sockets) socket.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new DirectError('VIDEO_PROXY_FAILED', '视频网络入口未启动。');
  return { url: `http://mashiro:${token}@127.0.0.1:${address.port}`,
    close(): Promise<void> {
      if (closeDone) return closeDone;
      closed = true; controller.abort(); abort();
      closeDone = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        const finish = Promise.all([Promise.allSettled([...pending]).then(() => Promise.all([...closingSockets])), serverClosed]);
        try {
          await Promise.race([finish, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DirectError('VIDEO_PROXY_CLOSE_UNKNOWN', '视频网络入口与连接收束未确认。', true)), 5000); })]);
        } catch (error) {
          if (error instanceof DirectError && error.unknown) throw error;
          throw new DirectError('VIDEO_PROXY_CLOSE_UNKNOWN', '视频网络入口与连接收束未确认。', true);
        } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
      })();
      return closeDone;

    } };
}

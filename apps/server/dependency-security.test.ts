import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('patched lock resolves runtime HTTP and development quoting dependencies consistently', () => {
  const expressRequire = createRequire(require.resolve('express'));
  assert.equal(expressRequire('body-parser/package.json').version, '2.4.0');
  assert.equal(require('undici/package.json').version, '8.12.2');
  const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  assert.equal(piRequire('undici/package.json').version, '8.12.2', 'The embedded runtime must not retain the vulnerable exact pin');
  const concurrentRequire = createRequire(require.resolve('concurrently'));
  assert.equal(concurrentRequire('shell-quote/package.json').version, '1.12.0');
  const quote = concurrentRequire('shell-quote').quote;
  // Only exercise string quoting. Never pass the adversarial input to a shell.
  assert.throws(() => quote(['echo', { comment: 'synthetic' }, 'value\nnot-a-command']), TypeError);
  assert.equal(quote(['safe value']), "'safe value'");
});

test('actual app JSON parser survives fragmented compressed trailing bytes in an isolated child process', { timeout: 20_000 }, () => {
  // Child owns an ephemeral loopback server; no production state, privileges, or host settings are used.
  // Split a compressed frame and invalid tail across writes. This tests containment, not every advisory timing.
  const appUrl = new URL('./app.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { request } from 'node:http';
    import { deflateSync, gzipSync } from 'node:zlib';
    import { createApp } from ${JSON.stringify(appUrl)};
    const app = createApp({}, {name:'isolated',backend:'demo',configured:false,model:null,provider:null,notice:'security regression'}, undefined, {serveWeb:false});
    app.post(['/security-echo', '/api/bd/security-echo'], (req,res)=>res.json(req.body));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    try {
      const good = await fetch('http://127.0.0.1:'+port+'/security-echo', {method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(Buffer.from('{"ok":true}'))});
      assert.equal(good.status, 200); assert.deepEqual(await good.json(), {ok:true});
      const oversized = await fetch('http://127.0.0.1:'+port+'/security-echo', {method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(Buffer.from(JSON.stringify({value:'x'.repeat(170000)})))});
      assert.equal(oversized.status, 413);
      for (const path of ['/security-echo', '/api/bd/security-echo']) {
        await new Promise((resolve, reject) => {
          const req = request({host:'127.0.0.1',port,path,method:'POST',headers:{'content-type':'application/json','content-encoding':'deflate','transfer-encoding':'chunked','x-mashiro-client':'web'}}, res => {
            assert.ok([200, 400, 404, 500].includes(res.statusCode));
            res.resume();
            res.on('end', () => {
              setTimeout(resolve, 100);
            });
          });
          req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('compressed request timed out')));
          req.write(deflateSync(Buffer.from('{}')));
          setTimeout(()=>req.end(Buffer.from('synthetic trailing bytes')), 100);
        });
        const health = await fetch('http://127.0.0.1:'+port+'/api/health');
        assert.equal(health.status, 200);
      }
      console.log('APP_SURVIVED_BOTH_PARSERS');
    } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /APP_SURVIVED_BOTH_PARSERS/u);
});

test('patched undici request and Agent retain streaming bytes, headers and abort behavior on loopback', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { Agent, request } = await import('undici');
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0, 255, 10, 13])); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const dispatcher = new Agent({ connect: { timeout: 1000 }, connections: 1, pipelining: 1, allowH2: false });
  try {
    const url = `http://127.0.0.1:${address.port}/synthetic`;
    const response = await request(url, { dispatcher, method: 'GET', headers: { 'accept-encoding': 'identity' }, headersTimeout: 1000, bodyTimeout: 1000 });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(await response.body.arrayBuffer()), Buffer.from([0, 255, 10, 13]));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(request(url, { dispatcher, signal: controller.signal }), /abort/iu);
  } finally { await dispatcher.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

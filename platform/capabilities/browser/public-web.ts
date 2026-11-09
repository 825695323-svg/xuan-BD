import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import type { FileReferenceService } from '../../resources/files.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import type { TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, DirectError } from '../../runtime/file-workspace.js';
import { extractPublicWebHtml, hasPdfHeader, publishRawPage, publishRawPdf,
  type HtmlExtraction, type RawPageCapture, type RawPdfCapture } from './raw-page.js';
export { extractPublicWebHtml } from './raw-page.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_QUERY = /^(?:access_token|api_key|apikey|token|auth|authorization|password|passwd|credential|key|signature|sig|x-amz-.+|x-goog-.+)$/iu;

export interface PublicWebAddress { address: string; family: 4 | 6 }
export interface PublicWebRequest {
  url: URL; address: PublicWebAddress; signal: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  /** 传输准备后、真正请求前再次检查当前权限；测试传输也必须遵守。 */
  assertAuthorized(): void;
}
export interface PublicWebResponse {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** 只有全部自有网络资源已经关闭才返回；拒绝表示收束未知。 */
  close(): Promise<void>;
}
export interface PublicWebOptions {
  /** 仅依赖注入供本机测试；DNS 查询必须响应 signal 并等自有资源收束。 */
  resolve?(hostname: string, signal: AbortSignal): Promise<readonly PublicWebAddress[]>;
  /** 只处理一个已钉住地址的 GET，不自动跳转、重试或携带凭据；拒绝前须收束资源。 */
  transport?(request: PublicWebRequest): Promise<PublicWebResponse>;
  timeoutMs?: number;
}

/** HTTPS 443、无凭据的明确公开对象；不把浏览器地址或登录状态当读取授权。 */
export function validatePublicWebUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value)) throw new DirectError('WEB_URL_INVALID', '请提供无空格的公开 HTTPS 网址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new DirectError('WEB_URL_INVALID', '网址无法解析。'); }
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || !host
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(host) || host.endsWith('.home.arpa')
    || (!isIP(host) && (!host.includes('.') || !/^[a-z0-9.-]+$/u.test(host)))
    || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
    throw new DirectError('WEB_URL_REFUSED', '当前只读取 HTTPS 443 的公开网址；本机地址、特殊端口和凭据参数不支持。');
  }
  if (isIP(host)) assertPublicWebAddress({ address: host, family: isIP(host) as 4 | 6 });
  url.hash = '';
  return url;
}

export function assertPublicWebAddress(value: PublicWebAddress): void {
  if (isIP(value.address) !== value.family) throw new DirectError('WEB_ADDRESS_BLOCKED', '域名解析结果不是有效的公开地址。');
  const address = ipaddr.parse(value.address);
  // 旧版 ipaddr 的分类不包含 RFC 2544 和新 IPv6 文档范围；补足这些明确特殊范围。
  const blocked = address instanceof ipaddr.IPv4
    ? address.range() !== 'unicast' || address.match(ipaddr.IPv4.parse('198.18.0.0'), 15)
    : address.range() !== 'unicast' || !address.match(ipaddr.IPv6.parse('2000::'), 3)
      || address.match(ipaddr.IPv6.parse('2001::'), 23) || address.match(ipaddr.IPv6.parse('3fff::'), 20);
  if (blocked) throw new DirectError('WEB_ADDRESS_BLOCKED', '网址解析到内网、特殊用途或不支持的地址，读取已拒绝。');
}

/** 钉住一个已检查的 IP；未知主机禁止回退到第二次 DNS 解析。 */
export function createPublicWebLookup(hostname: string, address: PublicWebAddress, assertAuthorized: () => void): LookupFunction {
  const expected = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return (host, options, callback) => {
    process.nextTick(() => {
      try {
        assertAuthorized(); assertPublicWebAddress(address);
        if (host.replace(/^\[|\]$/gu, '').toLowerCase() !== expected) throw new DirectError('WEB_PIN_MISMATCH', '网络连接的主机与本次核对地址不一致。');
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      } catch (error) { callback(error instanceof Error ? error : new DirectError('WEB_PIN_MISMATCH', '网络地址无法核对。'), '', address.family); }
    });
  };
}

export async function resolvePublic(hostname: string, signal: AbortSignal): Promise<readonly PublicWebAddress[]> {
  const literal = hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(literal);
  if (family) return [{ address: literal, family: family as 4 | 6 }];
  const resolver = new Resolver({ timeout: 10_000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted(); signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    return answers.flatMap((answer, index) => answer.status === 'fulfilled'
      ? answer.value.map((address) => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 })) : []);
  } finally { signal.removeEventListener('abort', cancel); }
}

export async function pinnedGet(parameters: PublicWebRequest): Promise<PublicWebResponse> {
  const dispatcher = new Agent({ connect: { lookup: createPublicWebLookup(parameters.url.hostname, parameters.address, parameters.assertAuthorized), timeout: 10_000 },
    connections: 1, pipelining: 1, maxHeaderSize: 16_384, allowH2: false });
  try {
    parameters.assertAuthorized(); parameters.signal.throwIfAborted();
    const response = await request(parameters.url, { dispatcher, method: 'GET', signal: parameters.signal, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS,
      headers: { accept: 'text/plain,text/markdown,application/json,text/html;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'MashiroAgent/0.1 (public-text-reader)', ...parameters.headers } });
    response.body.on('error', () => {});
    let closed = false;
    return { status: response.statusCode, headers: response.headers, body: response.body,
      async close() {
        if (closed) return;
        try { response.body.destroy(); }
        finally { await dispatcher.destroy(); }
        closed = true;
      } };
  } catch (error) {
    try { await dispatcher.destroy(); }
    catch { throw new DirectError('WEB_RESOURCES_UNKNOWN', '网络资源关闭尚未确认，需要核对任务记录。', true); }
    if (error instanceof DirectError) throw error;
    throw new DirectError('WEB_REQUEST_FAILED', '公开网页请求未能取得完整响应；没有自动重试。');
  }
}

function header(response: PublicWebResponse, name: string): string {
  const value = response.headers[name] ?? Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) throw new DirectError('WEB_HEADER_INVALID', '网页返回了无法唯一核对的响应头。');
  return typeof value === 'string' ? value : '';
}
export function responseKind(contentType: string): { kind: 'html' | 'text'; charset: string; mime: string } {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { kind: 'html', mime, charset: charset?.[1] ?? charset?.[2] ?? 'utf-8' };
  if (['text/plain', 'text/markdown', 'text/x-markdown', 'application/json'].includes(mime) || /^application\/[a-z0-9.+-]+\+json$/u.test(mime)) return { kind: 'text', mime, charset: charset?.[1] ?? charset?.[2] ?? 'utf-8' };
  throw new DirectError('WEB_CONTENT_UNSUPPORTED', '当前动作不支持此响应类型；公开 PDF 原件仅由 web.read_public 接收 application/pdf 响应。');
}

/** 公开读取与搜索共用同一网络通道；只有明确读取可保管 PDF 原件。 */
export function fetchPublicWeb(context: TaskExecutionContext, args: { url: string; action: 'web.search' }, options?: PublicWebOptions): Promise<RawPageCapture>;
export function fetchPublicWeb(context: TaskExecutionContext, args: { url: string; action?: 'web.read_public' }, options?: PublicWebOptions): Promise<RawPageCapture | RawPdfCapture>;
export async function fetchPublicWeb(context: TaskExecutionContext, args: { url: string; action?: 'web.read_public' | 'web.search' }, options: PublicWebOptions = {}): Promise<RawPageCapture | RawPdfCapture> {
  const original = validatePublicWebUrl(args.url);
  const action = args.action ?? 'web.read_public';
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new DirectError('WEB_BUDGET_INVALID', '网页读取时间预算无效。');
  let remainingMs = timeoutMs, current = original, bytes = 0;
  const visited = new Set<string>();
  let rawBytes: Uint8Array = new Uint8Array(), mime = '', charset = '', httpStatus = 0, extraction: HtmlExtraction | undefined, pdf = false;
  for (let hop = 0; ; hop++) {
    context.signal.throwIfAborted();
    if (visited.has(current.href)) throw new DirectError('WEB_REDIRECT_LOOP', '网页重定向形成循环。');
    visited.add(current.href);
    const authority = await acquireAuthority(context, `${action}.hop.${hop}`, { url: current.href, hop },
      [{ action: 'network', target: { kind: 'network', origin: current.origin } }]);
    const effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '核对公开地址并读取一次网页响应', operation: { url: current.href, hop } });
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remainingMs));
    timer.unref();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let response: PublicWebResponse | undefined, closeFailure = false, next: URL | undefined;
    let failure: unknown;
    try {
      signal.throwIfAborted(); authority.assert();
      const answers = await (options.resolve ?? resolvePublic)(current.hostname, signal);
      signal.throwIfAborted(); authority.assert();
      if (!answers.length || answers.length > 32) throw new DirectError('WEB_DNS_FAILED', '网址未解析到允许数量的公开地址。');
      for (const answer of answers) assertPublicWebAddress(answer);
      response = await (options.transport ?? pinnedGet)({ url: current, address: answers.find((answer) => answer.family === 4) ?? answers[0]!, signal,
        ...(action === 'web.read_public' ? { headers: { accept: 'application/pdf,text/plain,text/markdown,application/json,text/html;q=0.9' } } : {}),
        assertAuthorized: () => { signal.throwIfAborted(); authority.assert(); } });
      signal.throwIfAborted(); authority.assert();
      if (REDIRECTS.has(response.status)) {
        if (hop >= MAX_REDIRECTS) throw new DirectError('WEB_REDIRECT_LIMIT', '网页超过本次三次重定向上限。');
        const location = header(response, 'location');
        if (!location || location.length > 4096) throw new DirectError('WEB_REDIRECT_INVALID', '网页重定向目标无效。');
        next = validatePublicWebUrl(new URL(location, current).href);
      } else {
        if (header(response, 'content-encoding') && header(response, 'content-encoding').toLowerCase() !== 'identity') throw new DirectError('WEB_ENCODING_UNSUPPORTED', '网页忽略了本次不压缩请求，压缩内容尚不支持。');
        const contentType = header(response, 'content-type');
        const pdfResponse = action === 'web.read_public' && contentType.split(';', 1)[0]!.trim().toLowerCase() === 'application/pdf';
        const kind = pdfResponse ? null : responseKind(contentType);
        if (pdfResponse) {
          if (response.status === 206 || header(response, 'content-range')) throw new DirectError('WEB_PDF_RESPONSE_INCOMPLETE', 'PDF 返回了部分内容，未保管为完整原件。');
          if (response.status !== 200) throw new DirectError('WEB_PDF_HTTP_STATUS', 'PDF 未返回完整成功响应，未保管原件。');
        }
        const length = header(response, 'content-length');
        if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) throw new DirectError('WEB_RESPONSE_LIMIT', '网页响应超过本次 2 MiB 上限。');
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) {
          signal.throwIfAborted(); authority.assert();
          if (!(chunk instanceof Uint8Array)) throw new DirectError('WEB_RESPONSE_INVALID', '网页响应不是有效字节流。');
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES) throw new DirectError('WEB_RESPONSE_LIMIT', '网页响应超过本次 2 MiB 上限，未发布截断内容。');
          chunks.push(Buffer.from(chunk));
        }
        signal.throwIfAborted(); authority.assert();
        if (length && Number(length) !== bytes) throw new DirectError('WEB_RESPONSE_INCOMPLETE', '网页响应长度与声明不一致，未发布不完整内容。');
        rawBytes = Buffer.concat(chunks);
        if (pdfResponse) {
          if (!hasPdfHeader(rawBytes)) throw new DirectError('WEB_PDF_HEADER_INVALID', '响应声明为 PDF，但缺少可核对的 PDF 版本文件头；未保管为 PDF 原件。');
          mime = 'application/pdf'; charset = ''; httpStatus = response.status; pdf = true;
        } else {
          let text: string;
          try { text = new TextDecoder(kind!.charset, { fatal: true }).decode(rawBytes); }
          catch { throw new DirectError('WEB_TEXT_ENCODING_INVALID', '网页字符编码不支持或内容不是有效文字。'); }
          mime = kind!.mime; charset = kind!.charset; httpStatus = response.status;
          extraction = kind!.kind === 'html' ? extractPublicWebHtml(text) : { text, title: '', extractor: 'raw-text',
            status: text.trim() ? 'complete' : 'partial', complete: !!text.trim(), reasons: text.trim() ? [] : ['no-static-body-text'], locations: [] };
          if (Buffer.byteLength(extraction.text, 'utf8') > MAX_BYTES) throw new DirectError('WEB_TEXT_LIMIT', '提取文字超过本次 2 MiB 上限。');
        }
      }
    } catch (error) { failure = error; }
    finally {
      if (response) {
        try { await response.close(); }
        catch { closeFailure = true; }
      }
      clearTimeout(timer); remainingMs -= Date.now() - started;
    }
    if (closeFailure || failure instanceof DirectError && failure.unknown) throw new DirectError('WEB_RESOURCES_UNKNOWN', '网页读取的资源收束未确认，请核对任务记录。', true);
    if (failure) {
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '本次地址解析与网络调用已收束，未取得可用完整响应；此记录不证明远端未收到 GET。' });
      if (context.signal.aborted) context.signal.throwIfAborted();
      if (controller.signal.aborted || remainingMs <= 0) throw new DirectError('WEB_TIMEOUT', '网页读取达到本次 30 秒网络时间预算。');
      if (failure instanceof DirectError) throw failure;
      throw new DirectError('WEB_REQUEST_FAILED', '公开读取没有取得完整响应，没有自动重试。');
    }
    await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '本跳完整响应或重定向已核对，全部自有网络资源已关闭。', data: { status: response!.status, hop, bytes } });
    context.signal.throwIfAborted(); authority.assert();
    if (remainingMs <= 0) throw new DirectError('WEB_TIMEOUT', '网页读取达到本次 30 秒网络时间预算。');
    if (!next) break;
    current = next;
  }
  if (pdf) return { kind: 'pdf', action: 'web.read_public', sourceURL: original.href, finalURL: current.href,
    bytes: rawBytes, contentType: 'application/pdf', httpStatus: 200, sourceKind: 'http-response' };
  return { action, sourceURL: original.href, finalURL: current.href,
    bytes: rawBytes, contentType: mime, charset, httpStatus, sourceKind: 'http-response', extraction: extraction! };
}

/** 显式零模型读取；PDF 只保管原件，文字网页沿原正文路径发布。 */
export async function readPublicWeb(context: TaskExecutionContext, args: { url: string }, files: FileReferenceService, artifactRoot: string, options: PublicWebOptions = {}): Promise<TaskResult> {
  const capture = await fetchPublicWeb(context, args, options);
  return capture.kind === 'pdf' ? publishRawPdf(context, files, artifactRoot, capture) : publishRawPage(context, files, artifactRoot, capture);
}

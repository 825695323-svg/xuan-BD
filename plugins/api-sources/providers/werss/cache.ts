import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { extractPublicWebHtml } from '../../../../platform/capabilities/browser/html-extraction.js';
import { DirectError } from '../../../../platform/runtime/file-workspace.js';

export const WERSS_CACHE_LIMIT = 2 * 1024 * 1024;
export const WERSS_PROJECTION_VERSION = 'werss-derived-article-table/1';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const fail = (code: string, message: string): never => { throw new DirectError(code, message); };

/** Node HTTP 不自动解压或跟随跳转，保留本地服务实际响应实体字节。 */
export function readWerssCache(url: URL, signal: AbortSignal, assertCurrent: () => void): Promise<{
  status: number; contentType: string; contentEncoding: string; bytes: Buffer; observedAt: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: { status: number; contentType: string; contentEncoding: string; bytes: Buffer; observedAt: string }) => {
      if (settled) return; settled = true; if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(value!);
    };
    const req = request(url, { method: 'GET', agent: false,
      headers: { accept: 'application/json', 'accept-encoding': 'identity' }, signal }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        try {
          assertCurrent(); size += chunk.byteLength;
          if (size > WERSS_CACHE_LIMIT) throw new DirectError('WERSS_RESPONSE_BUDGET', 'WeRSS 响应超过本次 2 MiB 原件预算，已停止读取，未按截断正文接收。');
          chunks.push(Buffer.from(chunk));
        } catch (error) { req.destroy(error as Error); }
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(undefined, { status: response.statusCode ?? 0,
        contentType: String(response.headers['content-type'] ?? ''), contentEncoding: String(response.headers['content-encoding'] ?? ''),
        bytes: Buffer.concat(chunks), observedAt: new Date().toISOString() }));
    });
    deadline = setTimeout(() => req.destroy(new DirectError('WERSS_TIMEOUT', 'WeRSS 本地缓存读取超过 10 秒总时限；未自动重试。')), 10_000);
    deadline.unref();
    req.setTimeout(10_000, () => req.destroy(new DirectError('WERSS_TIMEOUT', 'WeRSS 本地缓存读取超时；未自动重试。')));
    req.once('error', error => finish(error));
    try { assertCurrent(); req.end(); } catch (error) { req.destroy(error as Error); }
  });
}

/** 仅接受字面数字回环地址；不用 localhost 或 DNS 解析作为边界。 */
export function validWerssBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/u.test(value)) return false;
  try { const port = Number(new URL(value).port); return port > 0 && port <= 65535; } catch { return false; }
}

export function cacheUrl(baseUrl: string, feedId: string, limit: number, offset: number): URL {
  if (!validWerssBaseUrl(baseUrl) || !/^[A-Za-z0-9_-]{1,80}$/u.test(feedId)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    return fail('WERSS_REQUEST_INVALID', 'WeRSS 缓存读取参数无效；仅接受已配置本机连接、明确 feed、1–20 条及有界偏移。');
  }
  const url = new URL(`/feed/${feedId}.json`, baseUrl);
  url.search = new URLSearchParams({ ctype: 'html', limit: String(limit), offset: String(offset), is_update: 'false' }).toString();
  return url;
}

export interface WerssArticle {
  id: string; index: number; title: string; description: string | null; link: string | null; updated: string; channelName: string;
  feed: { id: string; name: string | null; cover: string | null; intro: string | null };
  html: string; text: string; reasons: string[];
  locations: Array<{ selector: string; textNode: number; start: number; end: number }>;
}
export interface WerssPage { rawSha256: string; articles: WerssArticle[]; articleTable: Buffer; articleTableSha256: string }

/** 只解析 WeRSS 本地 cache feed 的 JSON；description 是摘要，不能替代 content。 */
export function parseWerssFeed(bytes: Buffer, feedId: string, requestedLimit?: number): WerssPage {
  if (!bytes.length || bytes.length > WERSS_CACHE_LIMIT) return fail('WERSS_RESPONSE_BUDGET', 'WeRSS 响应为空或超过本次 2 MiB 原件预算。');
  let root: unknown;
  try { root = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return fail('WERSS_RESPONSE_INVALID', 'WeRSS 响应不是有效 UTF-8 JSON；不得当作文章。'); }
  if (!record(root) || !Array.isArray(root.items) || root.items.length > (requestedLimit ?? 20)
    || ['name', 'link', 'description', 'cover'].some(key => root[key] !== null && typeof root[key] !== 'string')
    || typeof root.language !== 'string') {
    return fail('WERSS_RESPONSE_INVALID', 'WeRSS feed 根结构、条数或内容无效；未接收空页或登录提示。');
  }
  const seen = new Set<string>(), articles: WerssArticle[] = [];
  root.items.forEach((raw, index) => {
    if (!record(raw) || !record(raw.feed)) return fail('WERSS_ITEM_INVALID', 'WeRSS 文章或 feed 身份缺失。');
    const feed = raw.feed as Record<string, unknown>;
    const id = identity(raw.id), nestedFeedId = identity(feed.id);
    if (!id || nestedFeedId !== feedId) return fail('WERSS_FEED_MISMATCH', '文章所属 feed 与明确请求不符。');
    if (seen.has(id)) return fail('WERSS_ITEM_CONFLICT', '同一页中出现重复文章身份，未按时间去重或丢弃。');
    seen.add(id);
    if (['title', 'updated', 'content', 'channel_name'].some(key => typeof raw[key] !== 'string')
      || ['description', 'link'].some(key => raw[key] !== null && typeof raw[key] !== 'string')
      || ['name', 'cover', 'intro'].some(key => feed[key] !== null && typeof feed[key] !== 'string') || !String(raw.content).trim()) {
      return fail('WERSS_ITEM_INVALID', '文章正文或原值字段缺失，摘要不能代替正文。');
    }
    const extraction = extractPublicWebHtml(String(raw.content));
    if (extraction.status === 'login' || extraction.status === 'captcha' || !extraction.text.trim()) {
      return fail('WERSS_BODY_GATE', 'WeRSS content 仅有登录、验证码或空白提示；不能当作文章正文。');
    }
    articles.push({ id, index, title: String(raw.title), description: raw.description as string | null, link: raw.link as string | null,
      updated: String(raw.updated), channelName: String(raw.channel_name),
      feed: { id: nestedFeedId, name: feed.name as string | null, cover: feed.cover as string | null, intro: feed.intro as string | null },
      html: String(raw.content), text: extraction.text, reasons: extraction.reasons, locations: extraction.locations });
  });
  const rawSha256 = hash(bytes);
  // 此数组只是原值投影和结构抽取；不是微信页面原件，也不执行清洗、标注或语义推断。
  const rows = articles.map(article => ({ source_projection_version: WERSS_PROJECTION_VERSION, raw_sha256: rawSha256,
    raw_json_path: `$.items[${article.index}]`, feed_id: article.feed.id, article_id: article.id,
    title: article.title, description: article.description, link: article.link, updated_raw: article.updated,
    channel_name: article.channelName, feed_name: article.feed.name, feed_cover: article.feed.cover,
    feed_intro: article.feed.intro, content_html: article.html, visible_text: article.text }));
  const articleTable = Buffer.from(JSON.stringify(rows) + '\n');
  if (articleTable.byteLength > WERSS_CACHE_LIMIT) return fail('WERSS_PROJECTION_BUDGET', '文章原值投影超过本次 2 MiB 保管预算。');
  return { rawSha256, articles, articleTable, articleTableSha256: hash(articleTable) };
}

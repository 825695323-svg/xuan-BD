import { parseHTML } from 'linkedom';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import type { TaskExecutionContext } from '../../jobs/tasks.js';
import type { FileReferenceService } from '../../resources/files.js';
import { DirectError } from '../../runtime/file-workspace.js';
import { fetchPublicWeb, validatePublicWebUrl, type PublicWebOptions } from './public-web.js';
import { publishRawPage } from './raw-page.js';

type SearchResult = {
  title: string; url: string; snippet: string; sourceSelector: string;
  titleTruncated: boolean; snippetTruncated: boolean;
};

export function validateSearchArgs(args: { query: unknown; limit?: unknown }): { query: string; limit: number } {
  if (typeof args.query !== 'string' || args.query.length > 500 || !args.query.trim()
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(args.query)) {
    throw new DirectError('WEB_SEARCH_QUERY_INVALID', '请提供 1 到 500 字的单行搜索关键词，不含控制字符。');
  }
  const limit = args.limit === undefined ? 5 : args.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 10) throw new DirectError('WEB_SEARCH_LIMIT_INVALID', '搜索结果数量须为 1 到 10 的整数。');
  return { query: args.query.trim(), limit: Number(limit) };
}

function isBing(url: URL): boolean { return /^(?:(?:www|cn)\.)?bing\.com$/u.test(url.hostname.toLowerCase()); }

function resultURL(href: string, base: URL): string {
  if (href.length > 8192) throw new DirectError('WEB_URL_INVALID', '搜索结果网址过长。');
  let url = new URL(href, base);
  if (isBing(url) && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u') ?? '';
    if (!/^a1[A-Za-z0-9_-]+={0,2}$/u.test(encoded)) throw new DirectError('WEB_URL_INVALID', '搜索结果跳转网址无法核对。');
    url = new URL(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded.slice(2), 'base64url')));
  }
  return validatePublicWebUrl(url.href).href;
}

function selectorFor(element: Element): string {
  const parts: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    let index = 1;
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === current.tagName) index++;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
  }
  return parts.join(' > ');
}

/** 只发送明确关键词；搜索页与链接都是待核资料，不读取结果页或登录态。 */
export async function searchPublicWeb(context: TaskExecutionContext, args: { query: string; limit?: number }, files: FileReferenceService, artifactRoot: string, options: PublicWebOptions = {}): Promise<TaskResult> {
  const { query, limit } = validateSearchArgs(args), searchURL = new URL(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  const capture = await fetchPublicWeb(context, { url: searchURL.href, action: 'web.search' }, options);
  const finalURL = new URL(capture.finalURL), results: SearchResult[] = [], reasons: string[] = [];
  let searchStatus: 'results' | 'no-results' | 'unconfirmed' = 'unconfirmed', acceptedCount = 0;
  if (capture.httpStatus < 200 || capture.httpStatus >= 300) reasons.push('search-response-not-successful');
  else if (!isBing(finalURL) || finalURL.pathname !== '/search') reasons.push('search-provider-page-unconfirmed');
  else if (!capture.contentType.includes('html')) reasons.push('search-result-format-unconfirmed');
  else {
    const { document } = parseHTML(new TextDecoder(capture.charset, { fatal: true }).decode(capture.bytes));
    if (document.querySelector('#b_captcha,.b_captcha')) {
      capture.extraction = { ...capture.extraction, status: 'captcha', complete: false,
        reasons: [...capture.extraction.reasons, 'captcha-gate-observed'] };
    }
    if (capture.extraction.status !== 'captcha' && capture.extraction.status !== 'login') {
      // 在删除隐藏、脚本及表单前固定原始位置，与原件定位使用相同的结构路径。
      const candidates = [...document.querySelectorAll('li.b_algo')].map(card => {
        const anchor = card.querySelector('h2 a[href]');
        return { card, anchor, sourceSelector: anchor ? selectorFor(anchor) : '' };
      });
      for (const element of document.querySelectorAll('head,script,style,noscript,template,iframe,object,embed,svg,form,input,textarea,select,button,[hidden],[aria-hidden="true"]')) element.remove();
      const cleanText = (element: Element | null) => (element?.textContent ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
      for (const { card, anchor, sourceSelector } of candidates) {
        if (!anchor || !document.contains(anchor)) continue;
        const title = cleanText(anchor), snippet = cleanText(card.querySelector('.b_caption p') ?? card.querySelector('.b_snippet') ?? card.querySelector('p'));
        if (!title) { reasons.push('search-result-title-unavailable'); continue; }
        let url: string;
        try { url = resultURL(anchor.getAttribute('href')!, finalURL); }
        catch { reasons.push('search-result-url-rejected'); continue; }
        acceptedCount++;
        if (results.length < limit) results.push({ title: title.slice(0, 500), url, snippet: snippet.slice(0, 1000), sourceSelector,
          titleTruncated: title.length > 500, snippetTruncated: snippet.length > 1000 });
      }
      const noResults = cleanText(document.querySelector('#b_results > .b_no'));
      if (results.length) searchStatus = 'results';
      else if (!candidates.length && /no results|there are no results|没有找到|未找到|找不到.{0,30}结果|没有与/iu.test(noResults)) searchStatus = 'no-results';
      else reasons.push('search-results-or-layout-unconfirmed');
    }
  }
  const search = { provider: 'bing', query, limit, searchURL: searchURL.href, searchStatus, resultCount: results.length,
    results, resultsLimited: acceptedCount > results.length,
    resultsTruncated: acceptedCount > results.length || results.some(result => result.titleTruncated || result.snippetTruncated),
    contentScope: 'search-result-snippets', resultPagesRead: false, contentIsUntrustedReference: true };
  capture.reasons = reasons;
  capture.observation = search;
  const published = await publishRawPage(context, files, artifactRoot, capture), page = published.data as Record<string, JsonValue>;
  const modelPreview = { operation: 'search', ...search, sourceURL: capture.sourceURL, finalURL: capture.finalURL,
    status: page.status!, complete: page.complete!, reasons: page.reasons!, completenessScope: 'captured-search-result-page',
    rawRef: page.rawRef!, textRef: page.textRef!, locatorRef: page.locatorRef!, rawComplete: page.rawComplete!,
    contentType: capture.contentType, httpStatus: capture.httpStatus, modelCalls: 0, readOnly: true, readOnlyScope: 'source', sourceModified: false };
  return { ...published, summary: page.status === 'captcha' ? '已保留搜索验证码页；未绕过验证，无法确认搜索结果。'
    : page.status === 'login' ? '已保留搜索登录提示页；未读取登录态，无法确认搜索结果。'
    : searchStatus === 'results' ? `已取得 ${results.length} 条公开搜索结果摘要并保留来源；结果页正文尚未读取。`
    : searchStatus === 'no-results' ? '搜索页明确显示没有结果，已保留原件和来源定位。'
    : '已保留搜索页原件；本次无法确认有效结果，不能据此断言没有搜索结果。',
    data: { ...page, ...search, completenessScope: 'captured-search-result-page', modelPreview } };
}

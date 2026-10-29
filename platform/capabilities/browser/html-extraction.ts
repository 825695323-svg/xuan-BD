import { parseHTML } from 'linkedom';
import { DirectError } from '../../runtime/file-workspace.js';

export const RAW_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export type RawPageStatus = 'complete' | 'partial' | 'login' | 'captcha';
export interface PageTextLocation { selector: string; textNode: number; start: number; end: number }
export type HtmlBodyNode = { kind: 'element'; tag: string; attributes: Record<string, string>; selector: string; children: HtmlBodyNode[] }
  | { kind: 'text'; text: string; selector: string; textNode: number };
export type HtmlBodyLink = { selector: string; href: string; text: string };
export interface HtmlExtraction {
  text: string; title: string; extractor: 'html-structural' | 'document-text' | 'raw-text';
  status: RawPageStatus; complete: boolean; reasons: string[]; locations: PageTextLocation[];
  nativeTitle?: string; nativeBodyTree?: HtmlBodyNode | null; links?: HtmlBodyLink[];
}
const OMIT = 'head,script,style,noscript,template,iframe,object,embed,svg,form,input,textarea,select,button,[hidden],[aria-hidden="true"],nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';
const BLOCK = /^(?:ADDRESS|ARTICLE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIGCAPTION|FIGURE|H[1-6]|HR|LI|MAIN|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/u;

/** 只做确定性结构解析；保留字词、错字与重复，不摘要、纠错、去重或推断。 */
export function extractPublicWebHtml(html: string): HtmlExtraction {
  const { document } = parseHTML(html), elements = document.querySelectorAll('*');
  if (elements.length > 20_000) throw new DirectError('WEB_HTML_LIMIT', '页面元素超过本次 20,000 个上限。');
  const selectors = new Map<Element, string>(), depths = new Map<Element, number>(), siblingCounts = new Map<Element | null, Map<string, number>>();
  let selectorBytes = 0;
  for (const element of elements) {
    const parent = element.parentElement, depth = (parent ? depths.get(parent) ?? 0 : 0) + 1;
    if (depth > 256) throw new DirectError('WEB_HTML_LIMIT', '页面嵌套超过本次 256 层上限。');
    const counts = siblingCounts.get(parent) ?? new Map<string, number>(); siblingCounts.set(parent, counts);
    const index = (counts.get(element.tagName) ?? 0) + 1; counts.set(element.tagName, index);
    const parentSelector = parent ? selectors.get(parent) : undefined;
    const selector = `${parentSelector ? parentSelector + ' > ' : ''}${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    if ((selectorBytes += Buffer.byteLength(selector, 'utf8')) > 4 * 1024 * 1024) throw new DirectError('WEB_HTML_LIMIT', '原始正文位置超过本次 4 MiB 上限。');
    selectors.set(element, selector); depths.set(element, depth);
  }
  const nativeTitle = document.querySelector('title')?.textContent ?? '', title = nativeTitle.trim().slice(0, 500), visibleBefore = (document.querySelector('body')?.textContent ?? document.documentElement?.textContent ?? '').trim();
  const reasons: string[] = [];
  const challenge = !!document.querySelector('iframe[src*="captcha"],iframe[src*="challenge"],form[action*="captcha"],[id="captcha"],[id="challenge-form"]')
    || /captcha|verify (?:that )?you are human|人机验证|安全验证|验证访问/iu.test(title)
    || visibleBefore.length < 1200 && /(?:请完成|请通过|需要完成|perform|complete).{0,20}(?:人机验证|安全验证|captcha|human verification)/iu.test(visibleBefore);
  const login = !!document.querySelector('input[type="password"]')
    || /^(?:登录|用户登录|账号登录|账户登录|请登录|sign in|log in)(?:\s|$|[-_|])/iu.test(title);
  if (document.querySelector('script:not([type="application/ld+json"]):not([type="application/json"]),noscript')) reasons.push('script-content-not-executed');
  if (document.querySelector('iframe,frame,object,embed')) reasons.push('embedded-document-not-read');
  if (document.querySelector('img,audio,video,source,track,link[rel="stylesheet"],link[rel="preload"],link[rel="prefetch"],link[rel="preconnect"],link[rel="dns-prefetch"]')) reasons.push('linked-resources-not-read');
  if (document.querySelector('meta[http-equiv="refresh" i]')) reasons.push('document-refresh-not-followed');
  // 位置先按原始解析树记录；去除导航、表单和隐藏内容只影响正文视图，原始 HTML 单独保留。
  const nodePositions = new Map<Node, { selector: string; textNode: number }>();
  for (const element of elements) {
    let textNode = 0;
    for (const node of element.childNodes) if (node.nodeType === 3) nodePositions.set(node, { selector: selectors.get(element)!, textNode: ++textNode });
  }
  for (const element of document.querySelectorAll(OMIT)) element.remove();
  const mains = document.querySelectorAll('main,[role="main"]'), articles = document.querySelectorAll('article');
  const structured = mains.length === 1 ? mains[0] : articles.length === 1 ? articles[0] : undefined;
  // 不访问 linkedom 的 document.body getter（取值器）；它会向 HTML 片段插入空 body（正文）节点。
  const root = structured ?? document.querySelector('body') ?? (document.documentElement?.tagName === 'HTML' ? document.documentElement : document);
  const nativeNode = (node: Node): HtmlBodyNode | null => {
    if (node.nodeType === 3) {
      const position = nodePositions.get(node);
      return position ? { kind: 'text', text: node.textContent ?? '', ...position } : null;
    }
    if (node.nodeType === 9) return { kind: 'element', tag: '#document', attributes: {}, selector: '',
      children: [...node.childNodes].map(nativeNode).filter((child): child is HtmlBodyNode => child !== null) };
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    return { kind: 'element', tag: element.tagName.toLowerCase(), attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
      selector: selectors.get(element) ?? '', children: [...node.childNodes].map(nativeNode).filter((child): child is HtmlBodyNode => child !== null) };
  };
  const nativeBodyTree = root ? nativeNode(root) : null;
  const links: HtmlBodyLink[] = root ? [...root.querySelectorAll('a[href],area[href]')].map(element => ({ selector: selectors.get(element) ?? '',
    href: element.getAttribute('href')!, text: element.textContent ?? '' })) : [];
  let text = ''; const locations: PageTextLocation[] = [];
  const newline = () => { if (text && !text.endsWith('\n')) text += '\n'; };
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const value = (node.textContent ?? '').replace(/[\t\r\n ]+/gu, ' ');
      if (!value.trim()) return;
      const start = text.length; text += value;
      const location = nodePositions.get(node);
      if (location) locations.push({ ...location, start, end: text.length });
      return;
    }
    const block = node.nodeType === 1 && BLOCK.test((node as Element).tagName);
    if (block) newline();
    for (const child of node.childNodes) walk(child);
    if (block) newline();
  };
  if (root) walk(root);
  const leading = text.length - text.trimStart().length;
  text = text.trim();
  const adjusted = locations.map(location => ({ ...location, start: Math.max(0, location.start - leading), end: Math.min(text.length, location.end - leading) }))
    .filter(location => location.end > location.start);
  if (!text) reasons.push('no-static-body-text');
  if (challenge) reasons.push('captcha-gate-observed');
  else if (login) reasons.push('login-gate-observed');
  const status: RawPageStatus = challenge ? 'captcha' : login ? 'login' : reasons.length ? 'partial' : 'complete';
  return { text, title, nativeTitle, nativeBodyTree, links, extractor: structured ? 'html-structural' : 'document-text', status, complete: status === 'complete', reasons, locations: adjusted };
}


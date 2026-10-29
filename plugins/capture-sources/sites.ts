import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readBrowserBoundFile } from '../../platform/capabilities/browser/sites.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';
import type { CaptureSourceId } from './contracts.js';

type Parameter = { kind: 'text' | 'decimal' | 'bvid' | 'integer' | 'enum' | 'xhs_note' | 'wechat_url'; required?: boolean; min?: number; max?: number; values?: readonly string[] };
export interface CaptureSiteRule {
  sourceId: CaptureSourceId; operation: string; name: string; path: string; sha256: string; domain: string;
  parameters: Record<string, Parameter>; method: 'site-private-web-interface' | 'site-page-runtime' | 'page-dom';
}
const integer = (min: number, max: number): Parameter => ({ kind: 'integer', min, max });
export const CAPTURE_SITE_RULES: readonly CaptureSiteRule[] = [
  { sourceId: 'bilibili', operation: 'video-info', name: 'bilibili/video-info', path: 'bilibili/video-info.js', sha256: '38bc09fb346960967e3075b5ebbd15bf6db50d17c1816304c9dc6ac45dc87d2f', domain: 'www.bilibili.com', parameters: { bvid: { kind: 'bvid', required: true } }, method: 'site-private-web-interface' },
  { sourceId: 'bilibili', operation: 'search', name: 'bilibili/search', path: 'bilibili/search.js', sha256: '9876e3807e002d26bc57cfe6ff90e0da6daf12b6ae423c16def5af879a1ad8e7', domain: 'www.bilibili.com', parameters: { keyword: { kind: 'text', min: 1, max: 64 }, page: integer(1,10) }, method: 'site-private-web-interface' },
  { sourceId: 'bilibili', operation: 'comments', name: 'bilibili/comments', path: 'bilibili/comments.js', sha256: '68f66dc2be143e56713491a54912e3fddc2ff5e729bd7d2ec0bb44ec6bd9e3b4', domain: 'www.bilibili.com', parameters: { bvid: { kind: 'bvid', required: true }, page: integer(1,100), count: integer(1,30), sort: { kind: 'enum', values: ['0','2'] } }, method: 'site-private-web-interface' },
  { sourceId: 'bilibili', operation: 'popular', name: 'bilibili/popular', path: 'bilibili/popular.js', sha256: '6a8272d2757fd331d079520c125f2013401b381fc07dc1de380b205d7c3b9bc8', domain: 'www.bilibili.com', parameters: { count: integer(1,50), page: integer(1,10) }, method: 'site-private-web-interface' },
  { sourceId: 'bilibili', operation: 'trending', name: 'bilibili/trending', path: 'bilibili/trending.js', sha256: 'adf8c3198754b6d62db3175b0d9f14c5d979c8d0c802427834a8a58f1b5e3b6c', domain: 'www.bilibili.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'douyin', operation: 'hot', name: 'douyin/hot', path: 'douyin/hot.js', sha256: '2fbf3381bc28450f4905a56320ebf1f917a1aeca0913c944649e3e704952282b', domain: 'www.douyin.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'sogouwechat', operation: 'search', name: 'sogouwechat/search', path: 'sogou/wechat-search.js', sha256: '68b25fab898b9c1aa96aba98562f9b081d25e9c3a2d3f6e3d205311ebbb21ad1', domain: 'weixin.sogou.com', parameters: { query: { kind: 'text', min: 1, max: 64 }, page: integer(1,10) }, method: 'page-dom' },
  { sourceId: 'baidu', operation: 'hot', name: 'baidu/hot', path: 'baidu/hot.js', sha256: 'f47b3f7a521229c57fbcb5fde28a562914ec8541c4ef32e0866e2ea1a68b2300', domain: 'top.baidu.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'wechat', operation: 'article', name: 'wechat/article', path: 'wechat/article.js', sha256: 'c12a6c61b41eb05327d0de6c403e721079f8acd60d1eac3801edfbfa931a0480', domain: 'mp.weixin.qq.com', parameters: { url: { kind: 'wechat_url', required: true } }, method: 'page-dom' },
  { sourceId: 'xiaohongshu', operation: 'note', name: 'xiaohongshu/note', path: 'xiaohongshu/note.js', sha256: '2c3d1daacd4524db4230115dcf5ce901f1fb6ee88ec5202c0af18fe3701ccbc6', domain: 'www.xiaohongshu.com', parameters: { note_id: { kind: 'xhs_note', required: true } }, method: 'site-page-runtime' },
  { sourceId: 'xiaohongshu', operation: 'comments', name: 'xiaohongshu/comments', path: 'xiaohongshu/comments.js', sha256: '9081766eb46909e6c2cb42ac6f339422b029237be404d4ea84337d4d8fab09e2', domain: 'www.xiaohongshu.com', parameters: { note_id: { kind: 'xhs_note', required: true } }, method: 'site-page-runtime' },
  { sourceId: 'weibo', operation: 'comments', name: 'weibo/comments', path: 'weibo/comments.js', sha256: '79c67209b7f8cd031fe3cdac5962a4bafc3028f07e761e1cfe080dd62068fcf5', domain: 'weibo.com', parameters: { id: { kind: 'decimal', required: true }, count: integer(1,50), max_id: { kind: 'decimal' } }, method: 'site-private-web-interface' },
  { sourceId: 'weibo', operation: 'mobile-comments', name: 'm_weibo/comments', path: 'weibo/mobile-comments.js', sha256: '4abd85dbfcc177beb22a2dc44a800feff51bec681237e2975e321473fd4547bd', domain: 'm.weibo.cn', parameters: { id: { kind: 'decimal', required: true }, max_id: { kind: 'decimal' } }, method: 'site-private-web-interface' },
  { sourceId: 'weibo', operation: 'hot', name: 'weibo/hot', path: 'weibo/hot.js', sha256: '293b6b416b26738de12380f47cf32069bf9b600c964a2dd99a8bde73cb82fc94', domain: 'weibo.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'zhihu', operation: 'hot', name: 'zhihu/hot', path: 'zhihu/hot.js', sha256: '39dc8db9e5cf636a2fdecc29822d6173d31342ac01bf7611f53d66e4503d5d1a', domain: 'www.zhihu.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'zhihu', operation: 'question', name: 'zhihu/question', path: 'zhihu/question.js', sha256: '433f03edbbe58f814bebea1ce306510620e5ea9ab19219fcd58aa28e27c1e00b', domain: 'www.zhihu.com', parameters: { id: { kind: 'decimal', required: true }, count: integer(1,20) }, method: 'site-private-web-interface' },
  { sourceId: 'google', operation: 'search', name: 'google/search', path: 'google/search.js', sha256: '0e2892f77b9e4a1990ea435bc9dd225297e7a09d4cb2ed668d440ac194b09976', domain: 'www.google.com', parameters: { query: { kind: 'text', required: true }, count: integer(1,20) }, method: 'site-private-web-interface' },
  { sourceId: 'eastmoney', operation: 'guba-list', name: 'eastmoney/guba-list', path: 'eastmoney/guba-list.js', sha256: '7db504e0096d21fda3cce4eb3240a3b5505d057c619084aac5d00190576fff1b', domain: 'guba.eastmoney.com', parameters: { code: { kind: 'text', required: true }, page: integer(1,10) }, method: 'page-dom' },
  { sourceId: 'eastmoney', operation: 'news', name: 'eastmoney/news', path: 'eastmoney/news.js', sha256: '112d5d8234e6721d17aa378c4b06fa19ef3ae41bb4ad34dcacc1e4962300b5d1', domain: 'finance.eastmoney.com', parameters: { page: integer(1,10) }, method: 'site-private-web-interface' },
  { sourceId: 'eastmoney', operation: 'guba-post', name: 'eastmoney/guba-post', path: 'eastmoney/guba-post.js', sha256: '0b3ce976c8cb95ef7421dd7e600642835a54f1f837a96a2f13b8c92629f502e1', domain: 'guba.eastmoney.com', parameters: { code: { kind: 'text', required: true }, postId: { kind: 'decimal', required: true } }, method: 'page-dom' },
  { sourceId: 'xueqiu', operation: 'hot', name: 'xueqiu/hot', path: 'xueqiu/hot.js', sha256: 'd2c0e5a629e137095fbe5898c87b5d37507dca4a6a8699202133a55f8ec78c62', domain: 'xueqiu.com', parameters: { count: integer(1,50) }, method: 'site-private-web-interface' },
  { sourceId: 'xueqiu', operation: 'post', name: 'xueqiu/post', path: 'xueqiu/post.js', sha256: '8ec6b6f4d08a59574acbf631e9dbd4249997b35c5a76b5299ac4b7f78d85dc28', domain: 'xueqiu.com', parameters: { id: { kind: 'decimal', required: true }, count: integer(1,50) }, method: 'site-private-web-interface' },
];

export function captureSiteRule(sourceId: CaptureSourceId, operation: unknown): CaptureSiteRule {
  const rule = CAPTURE_SITE_RULES.find(rule => rule.sourceId === sourceId && rule.operation === operation);
  if (!rule) throw new DirectError('CAPTURE_OPERATION_INVALID', '采集操作不属于该站点的固定审核范围。');
  return rule;
}

export function normalizeCaptureArgs(rule: CaptureSiteRule, input: Record<string, unknown>): Record<string, string> {
  if (Object.keys(input).some(key => key !== 'operation' && !Object.hasOwn(rule.parameters,key))) invalid();
  const result: Record<string,string> = {};
  for (const [key,definition] of Object.entries(rule.parameters)) {
    const raw = input[key];
    if (raw === undefined) { if (definition.required) invalid(); continue; }
    const value = definition.kind === 'integer' && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
    if (definition.kind === 'decimal' && !/^[0-9]{1,30}$/u.test(value)) invalid();
    if (definition.kind === 'bvid' && !/^BV[a-z0-9]{10}$/iu.test(value)) invalid();
    if (definition.kind === 'integer' && (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < definition.min! || Number(value) > definition.max!)) invalid();
    if (definition.kind === 'enum' && !definition.values?.includes(value)) invalid();
    if (definition.kind === 'xhs_note' && !/^[a-f0-9]{24}$/iu.test(value)) {
      const url = parseURL(value);
      if (url.searchParams.has('xsec_token')) throw new DirectError('CAPTURE_CREDENTIAL_REF_REQUIRED', '带访问令牌的小红书链接尚缺安全凭据引用，请使用资源编号；不会静默删除令牌或写入任务参数。');
      if (url.protocol !== 'https:' || !['www.xiaohongshu.com','xiaohongshu.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash
        || !/^\/(?:explore|search_result)\/[a-f0-9]{24}$/iu.test(url.pathname) || [...url.searchParams.keys()].some(key => key !== 'xsec_source')) invalid();
    }
    if (definition.kind === 'wechat_url') {
      const url = parseURL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password || url.hash
        || !/^\/s(?:\/[-_a-z0-9]+)?$/iu.test(url.pathname) || [...url.searchParams.keys()].some(key => !['__biz','mid','idx','sn','chksm','scene','srcid','sharer_shareinfo','sharer_shareinfo_first','from','isappinstalled','subscene','clicktime','enterid'].includes(key))) invalid();
    }
    result[key] = value;
  }
  return result;
}
function invalid(): never { throw new DirectError('CAPTURE_ARGS_INVALID','采集参数无效或超出该站点的审核范围。'); }
function parseURL(value: string): URL { try { return new URL(value); } catch { return invalid(); } }

export function captureSourceURL(rule: CaptureSiteRule, args: Record<string,string>): URL {
  if (rule.sourceId === 'wechat') return new URL(args.url!);
  if (rule.sourceId === 'sogouwechat') return new URL(`https://${rule.domain}/weixin?type=2&query=${encodeURIComponent(args.query ?? '')}&page=${args.page ?? '1'}`);
  if (rule.sourceId === 'bilibili') return ['popular','trending','search'].includes(rule.operation)
    ? new URL(`https://${rule.domain}/`)
    : new URL(`https://${rule.domain}/video/${args.bvid}/`);
  if (rule.sourceId === 'xiaohongshu') return new URL(`/explore/${/^[a-f0-9]{24}$/iu.test(args.note_id!) ? args.note_id : new URL(args.note_id!).pathname.split('/').pop()}`,`https://${rule.domain}`);
  if (rule.sourceId === 'zhihu') return rule.operation === 'hot' ? new URL(`https://${rule.domain}/`) : new URL(`https://${rule.domain}/question/${args.id}`);
  if (rule.sourceId === 'weibo') return new URL(rule.domain === 'm.weibo.cn' ? `https://${rule.domain}/detail/${args.id}` : `https://${rule.domain}/`);
  if (rule.sourceId === 'eastmoney') return rule.operation === 'news' ? new URL('https://finance.eastmoney.com/a/c7x24.html') : new URL(rule.operation === 'guba-post'
    ? `https://${rule.domain}/news,${args.code},${args.postId}.html`
    : `https://${rule.domain}/list,${args.code},f_${args.page ?? '1'}.html`);
  if (rule.sourceId === 'xueqiu') return new URL(`https://${rule.domain}/`);
  if (rule.sourceId === 'douyin') return new URL(`https://${rule.domain}/`);
  if (rule.sourceId === 'baidu') return new URL(`https://${rule.domain}/board?tab=realtime`);
  const url = new URL(`https://${rule.domain}/search`); url.searchParams.set('q',args.query!); url.searchParams.set('num',args.count ?? '10'); return url;
}

export async function readCaptureScript(rule: CaptureSiteRule): Promise<string> {
  const path = fileURLToPath(new URL(rule.path,import.meta.url)), bytes = await readBrowserBoundFile(path,256*1024);
  if (createHash('sha256').update(bytes).digest('hex') !== rule.sha256) throw new DirectError('CAPTURE_SCRIPT_CHANGED','站点固定脚本摘要变化，须审核后再执行。');
  const content = bytes.toString('utf8'), block = /\/\*\s*@meta\s*\n([\s\S]*?)\*\//u.exec(content);
  let metadata: Record<string,unknown>; try { metadata = JSON.parse(block![1]!); } catch { throw new DirectError('CAPTURE_SCRIPT_INVALID','站点固定脚本元数据无法核对。'); }
  if (metadata.name !== rule.name || metadata.domain !== rule.domain || metadata.readOnly !== true || !metadata.args || typeof metadata.args !== 'object'
    || JSON.stringify(Object.keys(metadata.args)) !== JSON.stringify(Object.keys(rule.parameters))) throw new DirectError('CAPTURE_SCRIPT_INVALID','站点脚本名称、域名、只读或参数声明与合同不符。');
  return content;
}

/** 站点页面资源可运行，采集请求仅放行受审的读型端点；账号写入、任意跳转与媒体下载均拒绝。 */
export function captureRequestAllowed(rule: CaptureSiteRule, source: URL, args: Record<string,string>, method: string, rawURL: string, resourceType: string, postData?: string): boolean {
  let url: URL; try { url = new URL(rawURL); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  if (rule.sourceId === 'sogouwechat') {
    // 搜狗微信检索有反爬跳转与验证页：只放行该站及其 CDN 的只读 GET，其他一律拒绝。
    return method === 'GET' && (url.hostname === 'weixin.sogou.com' || url.hostname.endsWith('.sogou.com') || url.hostname.endsWith('.sogoucdn.com'));
  }
  if (method === 'GET' && resourceType === 'Document') return url.origin === source.origin && url.pathname === source.pathname && url.search === source.search;
  if (method === 'GET' && ['Script','Stylesheet'].includes(resourceType)) {
    if (!/\.(?:m?js|css)$/iu.test(url.pathname) || /\/(?:api|ajax|cgi-bin)\//iu.test(url.pathname)) return false;
    const suffixes: Partial<Record<CaptureSourceId,readonly string[]>> = { douyin:['douyin.com','iesdouyin.com','douyinpic.com'], baidu:['baidu.com','bdstatic.com'], bilibili:['bilibili.com','hdslb.com'],wechat:['weixin.qq.com','wx.qq.com','res.wx.qq.com'],sogouwechat:['sogou.com','sogoucdn.com'],xiaohongshu:['xiaohongshu.com','xhscdn.com'],weibo:['weibo.com','weibo.cn','sinaimg.cn','sinajs.cn'],zhihu:['zhihu.com','zhimg.com'],google:['google.com','gstatic.com'],eastmoney:['eastmoney.com','eastmoneycdn.com','eastmoneyapi.com'],xueqiu:['xueqiu.com','xueqiuimg.com'] };
    return (suffixes[rule.sourceId] ?? []).some(host => url.hostname === host || url.hostname.endsWith('.'+host));
  }
  if (method !== 'GET' && method !== 'OPTIONS') {
    if (rule.sourceId !== 'xiaohongshu' || method !== 'POST' || url.hostname !== 'edith.xiaohongshu.com' || url.pathname !== '/api/sns/web/v1/feed') return false;
    try { const body = JSON.parse(postData ?? ''); const id = /^[a-f0-9]{24}$/iu.test(args.note_id!) ? args.note_id : new URL(args.note_id!).pathname.split('/').pop();
      return body.source_note_id === id && Object.keys(body).every(key => ['source_note_id','image_formats','extra','xsec_source','xsec_token'].includes(key)); } catch { return false; }
  }
  if (rule.sourceId === 'douyin') {
    const keys = [...url.searchParams.keys()];
    return url.hostname === 'www.iesdouyin.com' && url.pathname === '/web/api/v2/hotsearch/billboard/word/' && keys.length === 0;
  }
  if (rule.sourceId === 'baidu') {
    const keys = [...url.searchParams.keys()].sort();
    return url.origin === source.origin && url.pathname === '/api/board' && url.searchParams.get('platform') === 'wise'
      && url.searchParams.get('tab') === 'realtime' && keys.every(key => key === 'platform' || key === 'tab');
  }
  if (rule.sourceId === 'bilibili') {
    const keys = [...url.searchParams.keys()];
    if (rule.operation === 'search') return url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/search/type'
      && url.searchParams.get('search_type') === 'video' && url.searchParams.get('order') === 'pubdate'
      && url.searchParams.get('keyword') === args.keyword && url.searchParams.get('page') === (args.page ?? '1')
      && keys.every(key => ['search_type','order','keyword','page'].includes(key));
    if (rule.operation === 'popular') return url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/popular'
      && url.searchParams.get('ps') === (args.count ?? '20') && url.searchParams.get('pn') === (args.page ?? '1')
      && keys.every(key => key === 'ps' || key === 'pn');
    if (rule.operation === 'trending') return url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/wbi/search/square'
      && url.searchParams.get('limit') === (args.count ?? '20') && keys.every(key => key === 'limit');
    return url.hostname === 'api.bilibili.com' && (url.pathname === '/x/web-interface/view' && url.searchParams.get('bvid') === args.bvid && keys.every(key=>key==='bvid')
      || rule.operation === 'comments' && url.pathname === '/x/v2/reply' && !!args.__verifiedAid && url.searchParams.get('oid') === args.__verifiedAid && url.searchParams.get('type') === '1'
        && url.searchParams.get('pn') === (args.page??'1') && url.searchParams.get('ps') === (args.count??'20') && url.searchParams.get('sort') === (args.sort??'2')
        && keys.every(key=>['type','oid','pn','ps','sort'].includes(key)));
  }
  if (rule.sourceId === 'google') return url.origin === source.origin && url.pathname === '/search' && url.searchParams.get('q') === args.query && url.searchParams.get('num') === (args.count??'10') && [...url.searchParams.keys()].every(key=>['q','num'].includes(key));
  if (rule.sourceId === 'wechat') return false;
  if (rule.sourceId === 'eastmoney') {
    if (rule.operation !== 'news') return false;
    return url.hostname === 'newsapi.eastmoney.com' && url.pathname === `/kuaixun/v1/getlist_102_ajaxResult_50_${args.page ?? '1'}_.html` && !url.search;
  }
  if (rule.sourceId === 'xueqiu') {
    if (url.origin !== source.origin) return false;
    const keys = [...url.searchParams.keys()];
    if (rule.operation === 'hot') {
      return url.pathname === '/statuses/hot/listV3.json'
        && keys.every(key => key === 'source' || key === 'page')
        && url.searchParams.get('source') === 'hot' && url.searchParams.get('page') === '1';
    }
    if (url.pathname === '/v4/statuses/status/show.json') {
      return keys.every(key => key === 'id') && url.searchParams.get('id') === args.id;
    }
    if (url.pathname !== '/statuses/comments.json') return false;
    const count = url.searchParams.get('count') ?? '20';
    return keys.every(key => ['id','count','page'].includes(key))
      && url.searchParams.get('id') === args.id && (url.searchParams.get('page') ?? '1') === '1'
      && /^[1-9][0-9]?$/u.test(count) && Number(count) <= 50;
  }
  if (rule.sourceId === 'zhihu') return url.origin === source.origin && (rule.operation === 'hot'
    ? url.pathname === '/api/v3/feed/topstory/hot-lists/total' && url.searchParams.get('limit') === '50' && [...url.searchParams.keys()].every(key => key === 'limit')
    : new RegExp(`^/api/v4/questions/${args.id}(?:/answers)?$`,'u').test(url.pathname));
  if (rule.sourceId === 'weibo') {
    if (rule.operation === 'hot') return url.origin === source.origin && url.pathname === '/ajax/statuses/hot_band' && url.search === '';
    return url.origin === source.origin && (rule.operation === 'comments' ? url.pathname === '/ajax/statuses/buildComments' && url.searchParams.get('count') === (args.count??'20') : url.pathname === '/comments/hotflow' && url.searchParams.get('mid') === args.id)
      && url.searchParams.get('id') === args.id && (url.searchParams.get('max_id')??'') === (args.max_id??'');
  }
  const id = /^[a-f0-9]{24}$/iu.test(args.note_id!) ? args.note_id : new URL(args.note_id!).pathname.split('/').pop();
  return ['www.xiaohongshu.com','edith.xiaohongshu.com'].includes(url.hostname) && (method === 'OPTIONS' && url.pathname === '/api/sns/web/v1/feed'
    || url.pathname === '/api/sns/web/v2/comment/page' && url.searchParams.get('note_id') === id || url.pathname === '/api/sns/web/v1/user/selfinfo');
}

export function captureResponseIsSource(rule: CaptureSiteRule, url: string, resourceType: string): boolean {
  if (resourceType === 'Document') return true;
  try { const value = new URL(url);
    return rule.sourceId === 'bilibili' ? value.hostname === 'api.bilibili.com'
      : rule.sourceId === 'google' ? value.pathname === '/search'
      : rule.sourceId === 'xiaohongshu' ? /\/api\/sns\/web\//u.test(value.pathname)
      : rule.sourceId === 'weibo' ? /\/(?:ajax\/statuses\/(?:buildComments|hot_band)|comments\/hotflow)$/u.test(value.pathname)
      : rule.sourceId === 'zhihu' ? /\/api\/(?:v4\/questions|v3\/feed\/topstory\/hot-lists)\//u.test(value.pathname)
      : rule.sourceId === 'eastmoney' ? false
      : rule.sourceId === 'xueqiu' ? value.origin === 'https://xueqiu.com'
        && /^\/(?:statuses\/(?:hot\/listV3|comments)\.json|v4\/statuses\/status\/show\.json)$/u.test(value.pathname)
      : false; } catch { return false; }
}

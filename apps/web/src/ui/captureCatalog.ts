/** 采集源目录：站点元数据、操作与图标，只描述已登记事实，不凭站点归类推定能力。 */
export interface CaptureSource { sourceId: string; label: string; available: boolean; loginRequired?: boolean; custom?: boolean; reason?: string; loginOpened?: boolean; operations?: { operation: string }[] }
export interface CustomSource { id: string; label: string; domain: string; loginUrl?: string; cookieNames: string[]; operations: string[] }

export const operationLabels: Record<string, string> = {
  'video-info': '视频信息 video-info', comments: '评论 comments', popular: '热门 popular', trending: '趋势 trending',
  article: '文章 article', note: '笔记 note', 'mobile-comments': '移动端评论 mobile-comments', hot: '热榜 hot',
  question: '问答 question', search: '搜索 search', 'guba-list': '股吧列表 guba-list', 'guba-post': '股吧帖子 guba-post',
  post: '帖子 post',
};
export const logos: Record<string, string> = {
  bilibili: 'bilibili.ico', wechat: 'wechat.png', xiaohongshu: 'xiaohongshu.ico', weibo: 'weibo.ico', douyin: 'douyin.ico', baidu: 'baidu.png', sogouwechat: 'sogou.png',
  zhihu: 'zhihu.ico', google: 'google.ico', eastmoney: 'eastmoney.ico', xueqiu: 'xueqiu.ico',
  'baidu-drive': 'baidu.ico',
};
export const TOPICS = ['宏观与政策', '金融与市场', '产业与企业', '科技与研究', '政治与地缘', '社会与民生', '自然与环境'] as const;
export const CHANNELS = ['官方网站', '新闻门户', '专业网站', '学术平台', '社交平台', '论坛社区', '搜索聚合'] as const;
export interface SourceMeta { topics: string[]; regions: string[]; channel: string; languages: string[]; opinion?: boolean }
/** 覆盖主题只按实际登记的频道/操作标注，不因为站点“理论上什么都有”就标全主题。 */
export const SOURCE_META: Record<string, SourceMeta> = {
  bilibili: { topics: ['科技与研究', '社会与民生'], regions: ['中国大陆'], channel: '社交平台', languages: ['中文'], opinion: true },
  wechat: { topics: ['产业与企业', '社会与民生'], regions: ['中国大陆'], channel: '社交平台', languages: ['中文'] },
  xiaohongshu: { topics: ['社会与民生'], regions: ['中国大陆'], channel: '社交平台', languages: ['中文'], opinion: true },
  weibo: { topics: ['社会与民生', '金融与市场'], regions: ['中国大陆'], channel: '社交平台', languages: ['中文'], opinion: true },
  zhihu: { topics: ['科技与研究', '社会与民生'], regions: ['中国大陆'], channel: '论坛社区', languages: ['中文'], opinion: true },
  google: { topics: ['宏观与政策', '科技与研究'], regions: ['全球'], channel: '搜索聚合', languages: ['中文', '英文'] },
  eastmoney: { topics: ['金融与市场'], regions: ['中国大陆'], channel: '专业网站', languages: ['中文'] },
  xueqiu: { topics: ['金融与市场'], regions: ['中国大陆'], channel: '论坛社区', languages: ['中文'], opinion: true },
  douyin: { topics: ['社会与民生'], regions: ['中国大陆'], channel: '社交平台', languages: ['中文'], opinion: true },
  baidu: { topics: ['社会与民生', '宏观与政策'], regions: ['中国大陆'], channel: '搜索聚合', languages: ['中文'] },
  sogouwechat: { topics: ['社会与民生', '产业与企业'], regions: ['中国大陆'], channel: '搜索聚合', languages: ['中文'], opinion: true },
  'baidu-drive': { topics: [], regions: [], channel: '工具', languages: ['中文'] },
};
export const FOLLOW_KEY = 'xuan.followedSources.v1';
export const readFollowed = (): string[] => {
  try {
    const raw = window.localStorage.getItem(FOLLOW_KEY), parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 60) : [];
  } catch { return []; }
};
export const baiduOperations = ['ls', 'search', 'download', 'upload', 'transfer-list', 'transfer-select'];
export const baiduLabels: Record<string, string> = {
  ls: '列目录 ls', search: '搜索 search', download: '下载 download',
  upload: '上传 upload', 'transfer-list': '分享列表 transfer-list', 'transfer-select': '转存 transfer-select',
};
export const monogram = (source: CaptureSource): string => source.sourceId === 'google' ? 'G' : source.label.slice(0, 1);
export const metaOf = (source: CaptureSource): SourceMeta => SOURCE_META[source.sourceId] ?? { topics: [], regions: [], channel: '其他', languages: [] };
export const sourceSearchText = (source: CaptureSource): string =>
  `${source.label} ${source.sourceId} ${(source.operations ?? []).map((item) => `${item.operation} ${operationLabels[item.operation] ?? ''}`).join(' ')}`;

/* @meta
{
  "name": "weibo/hot",
  "description": "微博热搜榜（词条、热度、分类、标签）",
  "domain": "weibo.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认30，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 30, 1), 50);
  var resp = await fetch('https://weibo.com/ajax/statuses/hot_band', {credentials: 'include'});
  if (!resp.ok) return {error: '热搜请求失败', status: resp.status, hint: '需要微博登录态'};
  var payload = await resp.json();
  if (!payload || !payload.ok) return {error: '需要微博登录态或接口拒绝', status: payload && payload.http_code, hint: '请先在微博专属窗口登录并保存'};

  var data = payload.data || {};
  var list = (data.band_list || []).slice(0, count);
  var items = list.map(function(item, index) {
    return {
      rank: item.realpos || (index + 1),
      word: item.word || null,
      hotValue: item.num == null ? null : item.num,
      rawHot: item.raw_hot == null ? null : item.raw_hot,
      category: item.category || null,
      label: item.label_name || null,
      isNew: !!item.is_new,
      url: item.word ? 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + item.word + '#') : null
    };
  });
  var top = data.hotgov ? {word: data.hotgov.word || data.hotgov.name || null, url: data.hotgov.url || null} : null;
  return {count: items.length, top: top, items: items};
}

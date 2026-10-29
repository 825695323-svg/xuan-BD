/* @meta
{
  "name": "douyin/hot",
  "description": "抖音热榜（榜单词条、热度值、跳转链接）",
  "domain": "www.douyin.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var resp = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', {credentials: 'omit'});
  if (!resp.ok) return {error: '抖音热榜请求失败', status: resp.status};
  var payload = await resp.json();
  if (!payload || payload.status_code !== 0 || !Array.isArray(payload.word_list)) return {error: '抖音返回结构异常', status: payload && payload.status_code};
  var items = payload.word_list.slice(0, count).map(function(entry, index) {
    var word = entry.word || '';
    return {
      rank: index + 1,
      word: word || null,
      hot: entry.hot_value == null ? null : entry.hot_value,
      label: entry.label == null ? null : entry.label,
      url: word ? 'https://www.douyin.com/search/' + encodeURIComponent(word) : null
    };
  });
  return {activeTime: payload.active_time || null, count: items.length, items: items};
}

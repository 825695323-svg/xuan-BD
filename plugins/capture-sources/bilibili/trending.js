/* @meta
{
  "name": "bilibili/trending",
  "description": "B站热搜关键词榜",
  "domain": "www.bilibili.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var resp = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/square?limit=' + count, {credentials: 'include'});
  if (!resp.ok) return {error: '热搜请求失败', status: resp.status};
  var payload = await resp.json();
  if (!payload || payload.code !== 0) return {error: 'B站返回错误', status: payload && payload.code, hint: payload && payload.message || null};

  var list = ((payload.data && payload.data.trending && payload.data.trending.list) || []).slice(0, count);
  var items = list.map(function(item, index) {
    return {
      rank: index + 1,
      keyword: item.keyword || null,
      showName: item.show_name || null,
      isHot: !!item.icon,
      url: item.keyword ? 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(item.keyword) : null
    };
  });
  return {count: items.length, items: items};
}

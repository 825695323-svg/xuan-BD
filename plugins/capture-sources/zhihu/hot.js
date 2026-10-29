/* @meta
{
  "name": "zhihu/hot",
  "description": "知乎热榜（问题、摘要、回答数、热度、趋势）",
  "domain": "www.zhihu.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var resp = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {credentials: 'include'});
  if (!resp.ok) return {error: '需要知乎登录态或接口拒绝', status: resp.status, hint: '请先在知乎专属窗口登录并保存'};
  var payload = await resp.json();
  if (!payload || payload.error) return {error: '需要知乎登录态', status: payload && payload.error && payload.error.code, hint: payload && payload.error && payload.error.message || null};

  var list = (payload.data || []).slice(0, count);
  var items = list.map(function(entry, index) {
    var target = entry.target || {};
    return {
      rank: index + 1,
      id: target.id == null ? null : String(target.id),
      title: target.title || null,
      excerpt: target.excerpt || null,
      answerCount: target.answer_count == null ? null : target.answer_count,
      followerCount: target.follower_count == null ? null : target.follower_count,
      heat: entry.detail_text || null,
      trend: entry.trend === 0 ? 'stable' : entry.trend > 0 ? 'up' : 'down',
      isNew: !!entry.debut,
      url: target.id ? 'https://www.zhihu.com/question/' + target.id : null
    };
  });
  return {count: items.length, items: items};
}

/* @meta
{
  "name": "xueqiu/hot",
  "description": "雪球热门讨论列表（讨论正文、作者、点赞、转发、回复、时间）",
  "domain": "xueqiu.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var resp = await fetch('https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1', {credentials: 'include'});
  var body = await resp.text();
  if (/^\s*</.test(body)) return {error: '站点返回风控页面，需要登录并通过本站验证', status: resp.status, hint: '请在本站专属窗口登录并完成验证后重试'};
  if (!resp.ok) return {error: '需要雪球登录态或接口拒绝', status: resp.status, hint: '请先在雪球专属窗口登录并保存'};
  var payload;
  try { payload = JSON.parse(body); } catch (e) { return {error: '返回内容不是可解析的讨论数据', status: resp.status}; }
  if (payload && payload.error_code) return {error: '需要雪球登录态', status: payload.error_code, hint: payload.error_description || null};

  var strip = function(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  };

  var list = (payload.list || payload.items || []).slice(0, count);
  var items = list.map(function(item, index) {
    var user = item.user || {};
    return {
      rank: index + 1,
      id: item.id == null ? null : String(item.id),
      text: strip(item.description || item.text),
      author: user.screen_name || null,
      authorId: user.id == null ? null : String(user.id),
      likes: item.fav_count == null ? null : item.fav_count,
      reposts: item.retweet_count == null ? null : item.retweet_count,
      replies: item.reply_count == null ? null : item.reply_count,
      createdAt: item.created_at ? new Date(item.created_at).toISOString() : null,
      url: user.id && item.id ? 'https://xueqiu.com/' + user.id + '/' + item.id : null
    };
  });
  return {count: items.length, items: items};
}

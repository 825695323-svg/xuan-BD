/* @meta
{
  "name": "xueqiu/post",
  "description": "雪球单条讨论正文与回复（需要本站有效登录态）",
  "domain": "xueqiu.com",
  "args": {
    "id": {"required": true, "description": "讨论编号，来自热门讨论结果"},
    "count": {"required": false, "description": "回复条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var id = String(args.id || '').trim();
  if (!/^[0-9]{1,30}$/.test(id)) return {error: '需要数字讨论编号', hint: '从雪球热门讨论结果取 id'};
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);

  var strip = function(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  };
  async function readJSON(url) {
    var resp = await fetch(url, {credentials: 'include'});
    var body = await resp.text();
    if (/^\s*</.test(body)) return {error: '站点返回风控页面，需要登录并通过本站验证', status: resp.status};
    if (!resp.ok) return {error: '需要雪球登录态或接口拒绝', status: resp.status};
    try { return {payload: JSON.parse(body)}; } catch (e) { return {error: '返回内容不是可解析的讨论数据', status: resp.status}; }
  }

  var shown = await readJSON('https://xueqiu.com/v4/statuses/status/show.json?id=' + id);
  if (!shown.payload) return shown;
  var payload = shown.payload;
  if (payload.error_code) return {error: '需要雪球登录态', status: payload.error_code, hint: payload.error_description || null};
  var status = payload.status || payload.data || payload;
  if (!status || (status.id == null && !status.description)) return {error: '未找到该讨论', id: id};
  var user = status.user || {};

  var replied = await readJSON('https://xueqiu.com/statuses/comments.json?id=' + id + '&count=' + count + '&page=1');
  var comments = [];
  if (replied.payload) {
    var raw = replied.payload.comments || replied.payload.list || [];
    comments = raw.slice(0, count).map(function(comment) {
      var author = comment.user || {};
      return {
        id: comment.id == null ? null : String(comment.id),
        text: strip(comment.description || comment.text),
        author: author.screen_name || null,
        likes: comment.like_count == null ? null : comment.like_count,
        createdAt: comment.created_at ? new Date(comment.created_at).toISOString() : null
      };
    });
  }

  return {
    id: status.id == null ? id : String(status.id),
    text: strip(status.description || status.text),
    author: user.screen_name || null,
    authorId: user.id == null ? null : String(user.id),
    createdAt: status.created_at ? new Date(status.created_at).toISOString() : null,
    likes: status.fav_count == null ? null : status.fav_count,
    reposts: status.retweet_count == null ? null : status.retweet_count,
    replies: status.reply_count == null ? null : status.reply_count,
    url: 'https://xueqiu.com/' + (user.id || '') + '/' + (status.id || id),
    comments: comments,
    commentsError: replied.error || null
  };
}

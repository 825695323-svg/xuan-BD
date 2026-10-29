/* @meta
{
  "name": "eastmoney/guba-post",
  "description": "东方财富股吧单帖正文（标题、作者、时间、阅读、评论、正文文本）",
  "domain": "guba.eastmoney.com",
  "args": {
    "code": {"required": true, "description": "6位股票代码，如 600519"},
    "postId": {"required": true, "description": "股吧帖子编号，来自列表结果"}
  },
  "readOnly": true
}
*/

async function(args) {
  var code = String(args.code || '').trim(), postId = String(args.postId || '').trim();
  if (!/^[0-9]{6}$/.test(code)) return {error: '需要6位股票代码', hint: '例如 600519'};
  if (!/^[0-9]{6,24}$/.test(postId)) return {error: '需要数字帖子编号', hint: '从股吧列表结果取 postId'};

  var data = (typeof window !== 'undefined' && window.post_article) || null;
  if (!data) return {error: '页面内没有可解析的帖子数据', hint: '帖子可能已删除、需登录或页面结构变化'};

  function text(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  var user = data.post_user || {};
  return {
    postId: String(data.post_id || postId),
    title: data.post_title || null,
    author: user.user_nickname || null,
    authorId: user.user_id || null,
    publishedAt: data.post_display_time || data.post_publish_time || null,
    read: data.post_click_count == null ? null : data.post_click_count,
    reply: data.post_comment_count == null ? null : data.post_comment_count,
    likes: data.post_like_count == null ? null : data.post_like_count,
    text: text(data.post_content),
    url: 'https://guba.eastmoney.com/news,' + code + ',' + (data.post_id || postId) + '.html'
  };
}

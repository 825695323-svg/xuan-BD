/* @meta
{
  "name": "eastmoney/guba-list",
  "description": "东方财富股吧帖子列表（标题、摘要、作者、阅读、评论、时间、链接）",
  "domain": "guba.eastmoney.com",
  "args": {
    "code": {"required": true, "description": "6位股票代码，如 600519"},
    "page": {"required": false, "description": "列表页码，默认1，最大10"}
  },
  "readOnly": true
}
*/

async function(args) {
  var code = String(args.code || '').trim();
  if (!/^[0-9]{6}$/.test(code)) return {error: '需要6位股票代码', hint: '例如 600519', code: code};
  var page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 10);
  var data = (typeof window !== 'undefined' && window.article_list) || null;
  if (!data || !Array.isArray(data.re)) return {error: '页面内没有可解析的股吧列表数据', hint: '页面结构可能变化，需重新审核脚本'};

  var strip = function(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  };

  var posts = data.re.slice(0, 50).map(function(item, index) {
    var user = item.post_user || {};
    var postId = String(item.post_id || '');
    var external = Number(item.post_type) === 20 && item.post_source_id;
    var abstract = strip(item.post_abstract || item.post_content).slice(0, 200);
    return {
      index: index + 1,
      postId: postId,
      title: item.post_title || null,
      abstract: abstract || null,
      author: user.user_nickname || null,
      authorId: user.user_id || null,
      read: item.post_click_count == null ? null : item.post_click_count,
      reply: item.post_comment_count == null ? null : item.post_comment_count,
      publishedAt: item.post_display_time || item.post_publish_time || null,
      url: external
        ? 'https://caifuhao.eastmoney.com/news/' + item.post_source_id
        : 'https://guba.eastmoney.com/news,' + code + ',' + postId + '.html',
      external: !!external
    };
  });

  return {bar: {code: code, name: data.bar_name || null}, page: page, count: posts.length, posts: posts};
}

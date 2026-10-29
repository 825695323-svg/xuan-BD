/* @meta
{
  "name": "sogouwechat/search",
  "description": "搜狗微信文章检索（标题、公众号、发布时间、摘要、原文链接）",
  "domain": "weixin.sogou.com",
  "args": {
    "query": {"required": true, "description": "检索关键词"},
    "page": {"required": false, "description": "页码，默认1，最大10"}
  },
  "readOnly": true
}
*/

async function(args) {
  var query = String(args.query || '').trim();
  if (!query) return {error: '需要检索关键词'};
  var page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 10);
  var url = 'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(query) + '&page=' + page;
  var resp = await fetch(url, {credentials: 'omit'});
  if (!resp.ok) return {error: '检索请求失败', status: resp.status};
  var html = await resp.text();
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var nodes = [].slice.call(doc.querySelectorAll('.news-list li'));
  var items = nodes.slice(0, 20).map(function(node) {
    var anchor = node.querySelector('h3 a') || node.querySelector('a');
    var href = anchor ? anchor.getAttribute('href') : null;
    var accountNode = node.querySelector('.account');
    var timeNode = node.querySelector('.s2, .s-p');
    var infoNode = node.querySelector('.txt-info');
    return {
      title: anchor ? anchor.textContent.trim() : null,
      account: accountNode ? accountNode.textContent.trim() : null,
      publishedAt: timeNode ? (timeNode.getAttribute('t') || timeNode.textContent.trim()) : null,
      summary: infoNode ? infoNode.textContent.trim().slice(0, 200) : null,
      url: href ? new URL(href, 'https://weixin.sogou.com/').href : null
    };
  }).filter(function(item) { return !!item.title; });
  return {query: query, page: page, count: items.length, items: items};
}

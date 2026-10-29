/* @meta
{
  "name": "eastmoney/news",
  "description": "东方财富 7×24 快讯（标题、摘要、时间、原文链接）",
  "domain": "finance.eastmoney.com",
  "args": {
    "page": {"required": false, "description": "页码，默认1，最大10"}
  },
  "readOnly": true
}
*/

async function(args) {
  var page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 10);
  var url = 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_' + page + '_.html';
  var resp = await fetch(url, {credentials: 'omit'});
  if (!resp.ok) return {error: '快讯请求失败', status: resp.status};
  var text = await resp.text();
  var start = text.indexOf('{');
  if (start < 0) return {error: '快讯响应格式异常'};
  var payload;
  try { payload = JSON.parse(text.slice(start)); } catch (e) { return {error: '快讯响应无法解析'}; }
  var list = (payload && payload.LivesList) || [];
  var items = list.slice(0, 50).map(function(entry) {
    return {
      id: entry.newsid || entry.id || null,
      title: entry.title || null,
      digest: entry.digest || null,
      time: entry.showtime || null,
      url: entry.url_w || entry.url_m || null
    };
  });
  return {page: page, count: items.length, items: items};
}

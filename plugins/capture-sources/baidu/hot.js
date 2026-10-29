/* @meta
{
  "name": "baidu/hot",
  "description": "百度实时热搜榜（词条、热度值、链接、摘要）",
  "domain": "top.baidu.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var resp = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {credentials: 'omit'});
  if (!resp.ok) return {error: '百度热榜请求失败', status: resp.status};
  var payload = await resp.json();
  var cards = payload && payload.data && payload.data.cards;
  if (!Array.isArray(cards)) return {error: '百度返回结构异常'};
  var content = [];
  cards.forEach(function(card) {
    if (Array.isArray(card.content)) card.content.forEach(function(entry) {
      if (Array.isArray(entry.content)) content = content.concat(entry.content);
    });
  });
  var items = content.slice(0, count).map(function(entry, index) {
    var word = entry.word || entry.query || '';
    return {
      rank: index + 1,
      word: word || null,
      hot: entry.hotScore == null ? null : Number(entry.hotScore),
      desc: entry.desc || null,
      tag: entry.tag || null,
      url: typeof entry.url === 'string' ? entry.url : (word ? 'https://www.baidu.com/s?wd=' + encodeURIComponent(word) : null)
    };
  });
  return {count: items.length, items: items};
}

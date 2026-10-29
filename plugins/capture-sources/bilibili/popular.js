/* @meta
{
  "name": "bilibili/popular",
  "description": "B站热门视频榜（标题、UP主、播放、点赞、弹幕、评论）",
  "domain": "www.bilibili.com",
  "args": {
    "count": {"required": false, "description": "返回条数，默认20，最大50"},
    "page": {"required": false, "description": "页码，默认1，最大10"}
  },
  "readOnly": true
}
*/

async function(args) {
  var count = Math.min(Math.max(parseInt(args.count, 10) || 20, 1), 50);
  var page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 10);
  var resp = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=' + count + '&pn=' + page, {credentials: 'include'});
  if (!resp.ok) return {error: '热门榜请求失败', status: resp.status};
  var payload = await resp.json();
  if (!payload || payload.code !== 0) return {error: 'B站返回错误', status: payload && payload.code, hint: payload && payload.message || null};

  var list = ((payload.data && payload.data.list) || []).slice(0, count);
  var items = list.map(function(video, index) {
    var stat = video.stat || {}, owner = video.owner || {};
    return {
      rank: (page - 1) * count + index + 1,
      bvid: video.bvid || null,
      title: video.title || null,
      author: owner.name || null,
      view: stat.view == null ? null : stat.view,
      like: stat.like == null ? null : stat.like,
      danmaku: stat.danmaku == null ? null : stat.danmaku,
      reply: stat.reply == null ? null : stat.reply,
      coin: stat.coin == null ? null : stat.coin,
      favorite: stat.favorite == null ? null : stat.favorite,
      share: stat.share == null ? null : stat.share,
      category: video.tname || null,
      duration: video.duration == null ? null : video.duration,
      pubDate: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : null,
      url: video.bvid ? 'https://www.bilibili.com/video/' + video.bvid : null
    };
  });
  return {page: page, count: items.length, items: items};
}

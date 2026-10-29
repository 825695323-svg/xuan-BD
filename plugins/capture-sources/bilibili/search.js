/* @meta
{
  "name": "bilibili/search",
  "description": "B站视频检索（按关键词，返回BV号、标题、UP主、播放、发布时间）",
  "domain": "www.bilibili.com",
  "args": {
    "keyword": {"required": true, "description": "检索关键词，例如 UP主名或主题词"},
    "page": {"required": false, "description": "页码，默认1，最大10"}
  },
  "readOnly": true
}
*/

async function(args) {
  var keyword = String(args.keyword || '').trim();
  if (!keyword) return {error: '需要检索关键词'};
  var page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 10);
  var url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=pubdate&keyword=' + encodeURIComponent(keyword) + '&page=' + page;
  var resp = await fetch(url, {credentials: 'include', headers: {'Referer': 'https://www.bilibili.com/'}});
  if (!resp.ok) return {error: '检索请求失败', status: resp.status};
  var payload = await resp.json();
  if (!payload || payload.code !== 0) return {error: 'B站返回错误', status: payload && payload.code, hint: payload && payload.message || null};
  var list = (payload.data && payload.data.result) || [];
  var items = list.slice(0, 20).map(function(video) {
    var bvid = video.bvid || null;
    return {
      bvid: bvid,
      title: String(video.title || '').replace(/<[^>]+>/g, '') || null,
      author: video.author || null,
      play: video.play == null ? null : video.play,
      danmaku: video.video_review == null ? null : video.video_review,
      pubDate: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : null,
      duration: video.duration || null,
      url: bvid ? 'https://www.bilibili.com/video/' + bvid : null
    };
  });
  return {keyword: keyword, page: page, count: items.length, items: items};
}

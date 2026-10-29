/* @meta
{
  "name": "bilibili/video-info",
  "description": "Read a Bilibili video's public description, title, author and source",
  "domain": "www.bilibili.com",
  "args": {
    "bvid": {"required": true, "description": "Video BV ID"}
  },
  "capabilities": ["network"],
  "readOnly": true
}
*/

async function(args) {
  const bvid = args.bvid;
  if (typeof bvid !== 'string' || !/^BV[a-z0-9]{10}$/i.test(bvid)) {
    return {error: 'BILIBILI_VIDEO_INFO_ARGS_INVALID'};
  }
  const apiSourceUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(apiSourceUrl, {credentials: 'include', redirect: 'error', signal: controller.signal});
    if (!response.ok) return {error: 'BILIBILI_VIDEO_INFO_HTTP', status: response.status};
    const envelope = await response.json();
    if (envelope?.code !== 0) return {error: 'BILIBILI_VIDEO_INFO_API', code: envelope?.code ?? null};
    const video = envelope.data;
    if (!video || video.bvid !== bvid || !Number.isSafeInteger(video.aid) || video.aid <= 0
        || typeof video.desc !== 'string') return {error: 'BILIBILI_VIDEO_INFO_SHAPE'};
    const result = {
      sourceUrl: 'https://www.bilibili.com/video/' + video.bvid + '/',
      apiSourceUrl,
      bvid: video.bvid,
      aid: String(video.aid),
      description: video.desc
    };
    if (typeof video.title === 'string') result.title = video.title;
    if (typeof video.owner?.name === 'string') result.author = {name: video.owner.name};
    return result;
  } catch {
    return {error: controller.signal.aborted ? 'BILIBILI_VIDEO_INFO_TIMEOUT' : 'BILIBILI_VIDEO_INFO_READ_FAILED'};
  } finally {
    clearTimeout(timer);
  }
}

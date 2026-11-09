import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheUrl, parseWerssFeed, validWerssBaseUrl } from './cache.js';

const fixture = (items: unknown[]) => Buffer.from(JSON.stringify({ name: '测试缓存', link: 'http://rss.local', description: '', language: 'zh', cover: '', items }));
const item = (id: string, updated = 'Fri, 30 Oct 2026 10:00:00 +0800') => ({ id, title: `标题${id}`, description: '摘要不算正文', link: `http://rss.local/views/article/${id}`,
  updated, content: `<p>正文${id}</p>`, channel_name: '测试缓存', feed: { id: 'feed-1', name: '测试缓存', cover: '', intro: '' } });

test('WeRSS 缓存解析保持同时间不同文章及原 HTML，不把摘要充当正文', () => {
  const parsed = parseWerssFeed(fixture([item('a'), item('b')]), 'feed-1');
  assert.equal(parsed.articles.length, 2);
  assert.deepEqual(parsed.articles.map(article => article.id), ['a', 'b']);
  assert.equal(parsed.articles[0]!.updated, 'Fri, 30 Oct 2026 10:00:00 +0800');
  assert.equal(parsed.articles[0]!.html, '<p>正文a</p>');
  assert.equal(parsed.articles[0]!.text, '正文a');
});

test('空 feed 页保留成功空页状态，不制造文章正文', () => {
  const parsed = parseWerssFeed(fixture([]), 'feed-1');
  assert.deepEqual(parsed.articles, []);
  assert.equal(parsed.articleTable.toString(), '[]\n');
});

test('WeRSS 可空元数据保持 null 原值，正文仍来自 content', () => {
  const raw = JSON.parse(fixture([item('a')]).toString()) as Record<string, any>;
  raw.name = null; raw.link = null; raw.description = null; raw.cover = null;
  raw.items[0].description = null; raw.items[0].link = null;
  raw.items[0].feed.name = null; raw.items[0].feed.cover = null; raw.items[0].feed.intro = null;
  const parsed = parseWerssFeed(Buffer.from(JSON.stringify(raw)), 'feed-1');
  assert.equal(parsed.articles[0]!.description, null);
  assert.equal(parsed.articles[0]!.feed.cover, null);
  const row = JSON.parse(parsed.articleTable.toString())[0];
  assert.equal(row.description, null);
  assert.equal(row.feed_name, null);
  assert.equal(row.visible_text, '正文a');
});

test('WeRSS 仅允许数字回环原点和固定本地 feed 路径', () => {
  assert.equal(validWerssBaseUrl('http://127.0.0.1:8080'), true);
  for (const url of ['https://127.0.0.1:8080', 'http://localhost:8080', 'http://127.0.0.1:8080/x', 'http://127.0.0.1:8080?x=1', 'http://user@127.0.0.1:8080']) assert.equal(validWerssBaseUrl(url), false);
  assert.equal(cacheUrl('http://127.0.0.1:8080', 'feed-1', 2, 4).href,
    'http://127.0.0.1:8080/feed/feed-1.json?ctype=html&limit=2&offset=4&is_update=false');
  assert.throws(() => cacheUrl('http://127.0.0.1:8080', '../fresh', 2, 0));
});

test('WeRSS 拒绝跨 feed、重复冲突、空正文与登录页', () => {
  assert.throws(() => parseWerssFeed(fixture([{ ...item('a'), feed: { id: 'other', name: 'x' } }]), 'feed-1'));
  assert.throws(() => parseWerssFeed(fixture([item('a'), item('a')]), 'feed-1'));
  assert.throws(() => parseWerssFeed(fixture([{ ...item('a'), content: '' }]), 'feed-1'));
  assert.throws(() => parseWerssFeed(Buffer.from('<html>请登录</html>'), 'feed-1'));
});

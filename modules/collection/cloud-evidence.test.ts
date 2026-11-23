import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCloudPage } from '../../plugins/storage/baidu-drive.js';
import { projectBaiduOutput } from '../../plugins/capture-sources/baidu-drive/index.js';

const viewUrl = 'https://pan.baidu.com/disk/main#/index?category=all';
const folder = '/apps/bdpan/selected';

test('listing preserves only official viewing links and keeps page links distinct from individual objects', () => {
  const object = { fsid: '61', path: folder + '/one.txt', isdir: false, size: 12 };
  const page = parseCloudPage({ return_url: viewUrl, data: [object] }, folder, 0, 100);
  assert.equal(page.returnUrl, viewUrl); assert.equal(page.items[0]!.returnUrl, null);
  const markdown = '已返回文件，请[查看原件](' + viewUrl + ')。';
  const item = parseCloudPage([{ ...object, return_url: viewUrl, return_markdown: markdown }], folder, 0, 100).items[0]!;
  assert.equal(item.returnUrl, viewUrl); assert.equal(item.returnMarkdown, markdown);
  const projected = projectBaiduOutput({ return_url: viewUrl, return_markdown: markdown });
  assert.equal(projected.return_url, viewUrl); assert.equal(projected.return_markdown, markdown);
  const multiple = markdown + '\n' + markdown;
  assert.equal(projectBaiduOutput({ return_markdown: multiple }).return_markdown, multiple);
  assert.equal(projectBaiduOutput({ return_markdown: markdown + ' [其它](https://example.test/)' }).return_markdown, null);
  const pageOnly = parseCloudPage({ data: { list: [object] }, has_more: true }, folder, 0, 100);
  assert.equal(pageOnly.hasMore, true);
  for (const url of ['http://pan.baidu.com/f', 'https://pan.baidu.com.example.test/f', 'https://other.test@pan.baidu.com/f',
    'https://pan.baidu.com:444/f', 'https://pan.baidu.com/f?%70wd=x', 'https://pan.baidu.com/f#/route?access_token=x',
    'https://pan.baidu.com/f\\x', 'javascript:alert(1)']) {
    const invalid = parseCloudPage([{ ...object, return_url: url, return_markdown: '[打开](' + url + ')' }], folder, 0, 100).items[0]!;
    assert.equal(invalid.returnUrl, null); assert.equal(invalid.returnMarkdown, null);
    const projected = projectBaiduOutput({ return_url: url, return_markdown: '[打开](' + url + ')' });
    assert.deepEqual(projected, { return_url: null, return_markdown: null });
  }
});

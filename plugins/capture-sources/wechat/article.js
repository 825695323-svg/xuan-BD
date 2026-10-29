/* @meta
{
  "name": "wechat/article",
  "description": "Read a WeChat article body and original image/link attributes with DOM locations",
  "domain": "mp.weixin.qq.com",
  "args": { "url": { "required": true, "description": "Explicit article URL" } },
  "readOnly": true
}
*/

async function(args) {
  const article = document.querySelector('#js_content');
  const text = document.body?.innerText || document.body?.textContent || '';
  const title = document.querySelector('#activity-name')?.textContent?.trim() || document.title || '';
  if (!article) return { error: /验证码|安全验证|captcha|verify/i.test(text + title) ? 'WECHAT_CAPTCHA' : /登录|login|sign in/i.test(text + title) ? 'WECHAT_LOGIN_REQUIRED' : 'WECHAT_ARTICLE_BODY_MISSING', title, pageText: text };
  const locator = node => {
    const path = [];
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      const index = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName).indexOf(node) + 1 : 1;
      path.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return path.join(' > ');
  };
  const attributes = node => Object.fromEntries([...node.attributes].filter(attribute => /^(?:src|data-src|data-original|data-backsrc|srcset|href|data-type|data-w|data-h|alt|title)$/i.test(attribute.name)).map(attribute => [attribute.name, attribute.value]));
  return {
    sourceURL: args.url, finalURL: location.href, title,
    author: document.querySelector('#js_name')?.textContent?.trim() || '',
    publishedText: document.querySelector('#publish_time')?.textContent?.trim() || '',
    bodyText: article.innerText || article.textContent || '',
    bodyHTML: article.outerHTML,
    bodyLocator: locator(article),
    images: [...article.querySelectorAll('img')].map((image, index) => ({ index, locator: locator(image), attributes: attributes(image), resolvedSrc: image.currentSrc || image.src || '' })),
    links: [...article.querySelectorAll('a[href]')].map((anchor, index) => ({ index, locator: locator(anchor), text: anchor.textContent || '', attributes: attributes(anchor), resolvedHref: anchor.href })),
    completenessScope: 'captured-article-dom', lazyImagesDownloaded: false, imageTextRecognized: false
  };
}

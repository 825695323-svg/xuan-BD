import { DirectError } from '../../../platform/runtime/file-workspace.js';

export const CLOUD_ROOT = '/apps/bdpan';
export function isBaiduPasscodeRefName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value)
    && value !== 'prototype' && !Object.hasOwn(Object.prototype, value);
}
export function isBaiduPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 2048 && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && !value.split('/').some(part => part === '..' || part === '.' || part === '~');
}
export function cloudPath(value: unknown): string {
  if (!isBaiduPath(value) || value !== CLOUD_ROOT && !value.startsWith(CLOUD_ROOT + '/')
    || value.split('/').slice(1).some(part => !part)) {
    throw new DirectError('INVALID_CLOUD_PATH', '需要已登记网盘根内的明确路径，不接受相对路径或目录穿越。');
  }
  return value;
}

/** 只接受 bdpan 实际提供的查看链接。保留网盘页面自身的路由和编码。 */
export function baiduReturnUrl(value: unknown, passcode?: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\/pan\.baidu\.com\//iu.test(value)
    || /[\s\\<>"\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(value);
    if (url.origin !== 'https://pan.baidu.com' || /[\u0000-\u001f\u007f]/u.test(decoded)
      || /[?&#;](?:[^?&#;=]*(?:token|pass[_-]?code|password|secret|api[_-]?key|authorization|cookie|提取码)[^?&#;=]*|pwd|p)=/iu.test(decoded)
      || passcode && (value.includes(passcode) || decoded.includes(passcode))) return null;
    return value;
  } catch { return null; }
}

/** 查看 Markdown 只接纳可核对的官方链接；任意账号文本、HTML 和其它链接均不进入回执。 */
export function baiduReturnMarkdown(value: unknown, passcode?: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) return null;
  const plain = (text: string) => !/[\[\]<>\\\x60]|[a-z][a-z0-9+.-]*:\/\/|www\.|@/iu.test(text.replaceAll('[REDACTED]', ''));
  const links = /\[((?:[^\[\]\r\n]|\[REDACTED\]){1,256})\]\(([^()\s]+)\)/gu;
  let end = 0, markdown = '';
  for (const link of value.matchAll(links)) {
    const prefix = value.slice(end, link.index), label = link[1]!, url = baiduReturnUrl(link[2], passcode);
    if (!url || !plain(label) || !plain(prefix) || prefix.endsWith('!')) return null;
    markdown += redactBaiduText(prefix, passcode) + '[' + redactBaiduText(label, passcode) + '](' + url + ')';
    end = link.index + link[0].length;
  }
  const tail = value.slice(end);
  return end && plain(tail) ? markdown + redactBaiduText(tail, passcode) : null;
}

export function redactBaiduText(value: string, passcode?: string): string {
  const text = value.replace(/https?:\/\/[^\s"'<>\])]+/giu, raw => {
    try {
      const url = new URL(raw); url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (/token|password|pass[_-]?code|secret|api.?key|authorization|cookie|提取码|^(pwd|p)$/iu.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return '[REDACTED]'; }
  }).replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|pass[_-]?code|secret|xsec[_-]?token|pwd|提取码)\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&,;]+)/giu, '$1[REDACTED]')
    .replace(/((?:^|[\s"'])-p(?:["']\s*,\s*|\s+|=))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu, '$1[REDACTED]');
  return passcode ? text.replaceAll(passcode, '[REDACTED]') : text;
}

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { buildEastmoneyReportDetailRequest, buildEastmoneyReportRequest, decodeEastmoneyReportDetail,
  decodeEastmoneyReports, normalizeEastmoneyReportRequest } from './api.js';

// 合成响应与预算，仅验证字段、分页和时间语义，不冒充线上来源验证。
const request = { category: 'industry' as const, start: '2026-01-01', end: '2026-01-31', page: 1, pageSize: 2 };
const row = (suffix: string) => ({ infoCode: 'AP2026010100' + suffix, title: 'synthetic report', publishDate: '2026-01-05 14:23:45.123',
  stockCode: null, orgSName: 'fixture institution', researcher: 'fixture author', attachPages: '12' });
const response = () => ({ hits: 3, TotalPage: 2, pageNo: 1, size: 2, data: [row('01'), row('02')] });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const html = (text: string) => new TextEncoder().encode(text);
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const invalidDetail = (message: string) => (error: unknown) =>
  code('SOURCE_REPORT_RESPONSE_INVALID')(error) && error instanceof Error && error.message === message;
const noPdf = invalidDetail('研报详情没有可验证的 PDF 附件定位。');

test('Eastmoney builds bounded category requests and uses POST JSON for stock reports only', () => {
  const industry = buildEastmoneyReportRequest(request);
  assert.equal(industry.method, 'GET');
  assert.equal(industry.url.origin, 'https://reportapi.eastmoney.com');
  assert.equal(industry.url.pathname, '/report/list');
  assert.equal(industry.url.searchParams.get('beginTime'), request.start);
  assert.equal(industry.url.searchParams.get('pageNo'), '1');
  for (const category of ['strategy', 'macro', 'new_stock']) assert.equal(buildEastmoneyReportRequest({ ...request, category }).method, 'GET');
  const stock = buildEastmoneyReportRequest({ ...request, category: 'stock', symbol: '600001.SH' });
  assert.equal(stock.method, 'POST');
  assert.equal(stock.url.pathname, '/report/list2');
  assert.equal(stock.url.search, '');
  assert.equal(JSON.parse(stock.body!).code, '600001');
  assert.equal(JSON.parse(stock.body!).qType, '0');
  const invalidParameters: Array<Record<string, JsonValue>> = [{ category: 'unknown' }, { start: '2026-02-30' }, { end: '2025-01-01' }, { page: 0 },
    { pageSize: null }, { pageSize: 101 }, { page: 10001 }, { symbol: '600001.SH' }, { category: 'stock' }, { category: 'stock', symbol: '600001' }, { hidden: true }];
  for (const delta of invalidParameters)
    assert.throws(() => normalizeEastmoneyReportRequest({ ...request, ...delta }), code('SOURCE_PARAMETERS_INVALID'));
});

test('Eastmoney preserves raw publication precision, attribution, paging and no-PIT status', () => {
  const result = decodeEastmoneyReports(request, bytes(response()));
  assert.equal(result.rows[0]!.publish_time_raw, '2026-01-05 14:23:45.123');
  assert.equal(result.rows[0]!.raw.publishDate, '2026-01-05 14:23:45.123');
  assert.equal(result.rows[0]!.publish_date, '2026-01-05');
  assert.equal(result.rows[0]!.publication_timezone, 'not_established');
  assert.equal(result.rows[0]!.attachment_pages, 12);
  assert.equal(result.rows[0]!.source_page, 1);
  assert.equal(result.rows[0]!.source_row, 1);
  assert.equal(result.rows[0]!.pdf_url, 'https://pdf.dfcfw.com/pdf/H3_AP202601010001_1.pdf');
  assert.equal(result.nextPage, 2);
  assert.equal(result.continuation, 'available');
  assert.equal(result.total, 3);
  assert.equal(result.coverageState, 'not_established');
  assert.equal(result.historyAvailability, 'not_established');
  const last = decodeEastmoneyReports({ ...request, page: 2 }, bytes({ ...response(), pageNo: 2, data: [row('03')] }));
  assert.equal(last.nextPage, null);
  assert.equal(last.continuation, 'finished');
});

test('Eastmoney empty or absent pagination remains distinct from confirmed full history', () => {
  const empty = decodeEastmoneyReports(request, bytes({ hits: 0, TotalPage: 0, pageNo: 1, data: [] }));
  assert.equal(empty.recordCount, 0);
  assert.equal(empty.continuation, 'finished');
  assert.equal(empty.coverageState, 'not_established');
  const absent = decodeEastmoneyReports(request, bytes({ data: [{ ...row('01'), publishDate: null, attachPages: null }] }));
  assert.equal(absent.continuation, 'not_declared');
  assert.equal(absent.total, null);
  assert.equal(absent.rows[0]!.publish_date, null);
  assert.equal(absent.rows[0]!.publication_precision, 'missing');
  const dayOnly = decodeEastmoneyReports(request, bytes({ data: [{ ...row('01'), publishDate: '2026-01-05' }] }));
  assert.equal(dayOnly.rows[0]!.publish_time_raw, '2026-01-05');
  assert.equal(dayOnly.rows[0]!.publication_precision, 'date');
});

test('Eastmoney rejects contradictory pages, duplicates, malformed identities and dates', () => {
  for (const variant of [{ ...response(), pageNo: 2 }, { ...response(), hits: 1 }, { ...response(), TotalPage: 3 },
    { TotalPage: 0, data: [row('01')] }, { ...response(), data: [] }, { ...response(), data: [row('01'), row('01')] }, { data: null },
    { data: [{ ...row('01'), infoCode: '../outside' }] }, { data: [{ ...row('01'), publishDate: '2026-02-01' }] },
    { data: [{ ...row('01'), publishDate: '2026-01-99' }] }])
    assert.throws(() => decodeEastmoneyReports(request, bytes(variant)), code('SOURCE_REPORT_RESPONSE_INVALID'));
  assert.throws(() => decodeEastmoneyReports({ ...request, category: 'stock', symbol: '600001.SH' },
    bytes({ data: [{ ...row('01'), stockCode: '600002' }] })), code('SOURCE_REPORT_RESPONSE_INVALID'));
});

test('Eastmoney strategy identifiers retain source strings and need explicit detail lookup', () => {
  const result = decodeEastmoneyReports({ ...request, category: 'strategy' }, bytes({ data: [{ title: 'fixture', encodeUrl: 'a+b/c=', publishDate: null }] }));
  assert.equal(result.rows[0]!.encode_url, 'a+b/c=');
  assert.equal(result.rows[0]!.pdf_url, null);
  const detail = new URL(result.rows[0]!.detail_url);
  assert.equal(detail.searchParams.get('encodeUrl'), 'a+b/c=');
  assert.equal(detail.hostname, 'data.eastmoney.com');
});

test('Eastmoney detail parsing locates a unique fixed-host attachment without downloading or executing scripts', () => {
  const request = { category: 'macro' as const, encodeUrl: 'a+b/c=' };
  const built = buildEastmoneyReportDetailRequest(request);
  assert.equal(built.url.searchParams.get('encodeUrl'), request.encodeUrl);
  const pdf = 'https://pdf.dfcfw.com/pdf/H3_AP202601010001_1.pdf';
  const result = decodeEastmoneyReportDetail(request, html(`<html><a href="${pdf}">PDF</a><script>window.pdf='${pdf}'</script></html>`));
  assert.equal(result.pdfUrl, pdf);
  assert.equal(result.infoCode, 'AP202601010001');
  assert.equal(result.attachmentFetched, false);
  assert.equal(result.rawSha256.length, 64);
  for (const body of ['<a href="https://example.test/other.pdf">x</a>', '<a href="http://pdf.dfcfw.com/pdf/H3_AP202601010001_1.pdf">x</a>',
    `<script>const falsePrefix='${pdf}.not-a-pdf';</script>`,
    `<a href="${pdf}">x</a><a href="https://pdf.dfcfw.com/pdf/H3_AP202601010002_1.pdf">y</a>`])
    assert.throws(() => decodeEastmoneyReportDetail(request, html(body)), noPdf);
  assert.throws(() => buildEastmoneyReportDetailRequest({ category: 'stock', encodeUrl: 'fixture' }), code('SOURCE_PARAMETERS_INVALID'));
});

test('Eastmoney distinguishes the requested exchange from the identity actually present in a stock report', () => {
  const stock = { ...request, category: 'stock' as const, symbol: '600001.SH' };
  for (const [stockCode, status] of [[null, 'unverified_missing_stock_code'], ['600001', 'code_prefix_only_exchange_unverified'],
    ['600001.SH', 'verified_full_code']] as const) {
    const result = decodeEastmoneyReports(stock, bytes({ data: [{ ...row('01'), stockCode }] }));
    assert.equal(result.rows[0].requested_symbol, stock.symbol);
    assert.equal(result.rows[0].stock_code, stockCode);
    assert.equal(result.rows[0].subjectVerification, status);
    assert.equal(result.subject?.subject_verified, stockCode === stock.symbol);
    assert.deepEqual(result.subject?.stock_codes, stockCode ? [stockCode] : []);
  }
  assert.throws(() => decodeEastmoneyReports(stock, bytes({ data: [{ ...row('01'), stockCode: '600001.SZ' }] })), code('SOURCE_REPORT_RESPONSE_INVALID'));
});

test('Eastmoney only binds the report detail attachment from its own metadata or download container', () => {
  const request = { category: 'macro' as const, encodeUrl: 'fixture' };
  const pdf = 'https://pdf.dfcfw.com/pdf/H3_AP202601010001_1.pdf', other = pdf.replace('0001', '0002');
  const related = `<aside><div class="report-download"><a href="${other}">相关阅读</a></div></aside>`;
  for (const main of [`<script>var zwinfo = ${JSON.stringify({ encodeUrl: 'fixture', infoCode: 'AP202601010001', attach_url: pdf })};</script>`,
    `<script>var zwinfo = { infoCode: 'AP202601010001', attach_url: '${pdf}' };</script>`,
    `<div class="report-download"><a href="${pdf}">下载本研报</a></div>`])
    assert.equal(decodeEastmoneyReportDetail(request, html(main + related)).pdfUrl, pdf);
  const mainLink = `<a download href="${pdf}">下载原文</a>`, otherLink = `<a download href="${other}">下载 PDF</a>`;
  for (const title of ['相关阅读', '相关研报', '推荐阅读', '延伸阅读']) {
    for (const section of [`<div>${title}：${otherLink}</div>`, `<section><h2>${title}</h2>${otherLink}</section>`,
      `<div><span>${title}：</span></div><ul><li>${otherLink}</li></ul>`,
      `<p><strong>${title}</strong></p><ul><li>${otherLink}</li></ul>`,
      `<p><strong>${title}</strong><br></p><ul><li>${otherLink}</li></ul>`,
      `<p>${title}<br></p><ul><li>${otherLink}</li></ul>`,
      `<p><em>${title}</em></p><ul><li>${otherLink}</li></ul>`,
      `<p><strong>${title}</strong></p><h3>小标题</h3><ul><li>${otherLink}</li></ul>`,
      `<p><b>${title}</b>：</p><div class="report-download">${otherLink}</div>`,
      `<p><small>${title}</small></p><ul><li>${otherLink}</li></ul>`,
      `<p><em>${title.slice(0, 2)}</em>${title.slice(2)}</p><ul><li>${otherLink}</li></ul>`,
      `<p><em>${title.slice(0, 2)}</em>${title.slice(2)}：${otherLink}</p>`,
      `<div>正文<span> </span><em>${title.slice(0, 2)}</em>${title.slice(2)}：${otherLink}</div>`,
      `<p>正文<span> </span><em>${title.slice(0, 2)}</em>${title.slice(2)}：</p><ul><li>${otherLink}</li></ul>`]) {
      assert.equal(decodeEastmoneyReportDetail(request, html(`<article id="zwinfo">${mainLink}${section}</article>`)).pdfUrl, pdf);
      assert.throws(() => decodeEastmoneyReportDetail(request, html(`<article id="zwinfo">${section}</article>`)), noPdf);
    }
  }
  for (const wrapper of [
    `<main id="zwinfo">${mainLink}<div>正文<span> </span><em>相关</em>阅读：${otherLink}</div></main>`,
    `<ul id="zwinfo"><li>${mainLink}</li><li>正文<span> </span><em>相关</em>阅读：${otherLink}</li></ul>`,
    `<div id="zwinfo">${mainLink}<div>相关阅读：${otherLink}</div><ul><li>${otherLink}</li></ul></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：<br>1. ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：<br><span>1. </span>${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：<br>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：1. ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 某行业研报<img alt="">${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<span><span role="heading" aria-level="2">相关阅读</span><img alt=""></span>1. 某行业研报 ${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<span role="heading" aria-level="2">相关阅读</span>1. 某行业研报 ${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 需求见底？三季度行业展望 ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 需求见底。三季度行业展望 ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 需求见底了吗？ ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<span class="title">相关阅读</span>1. 某行业研报 ${otherLink}</div>`,
    `<article id="zwinfo">${mainLink}<p><strong>相关阅读</strong></p>1. 某行业研报 ${otherLink}</article>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong><span><br>某行业研报 </span>${otherLink}</p></div>`,
    `<div id="zwinfo"><details><summary>附录</summary><span>相关阅读：${otherLink}</span></details>${mainLink}</div>`,
    `<div id="zwinfo"><figure><figcaption>附录</figcaption><span>相关阅读：${otherLink}</span></figure>${mainLink}</div>`,
    `<ul id="zwinfo"><li>${mainLink}</li><li>相关阅读：1. 某行业研报<div>${otherLink}</div></li></ul>`,
    `<div id="zwinfo">${mainLink}<h2>相关阅读</h2>${otherLink}<h2>本研报附件</h2></div>`,
    `<div id="zwinfo">${mainLink}<div class="report-download">附件入口<div class="report-download"><a href="/more">推荐阅读：</a><a class="report-download" href="${other}">推荐PDF</a></div></div></div>`,
    `<div id="zwinfo">${mainLink}<div class="report-download"><a href="/more">推荐阅读：</a><script>window.pdf="${other}";</script></div></div>`,
    `<div id="zwinfo">${mainLink}<div class="report-download"><a href="/more">推荐阅读</a><a href="${other}">下载 PDF</a></div></div>`,
    `<div id="zwinfo">${mainLink}<iframe data-encode-url="other" src="${other}"></iframe></div>`,
    `<div id="zwinfo">${mainLink}<span><iframe src="${other}"></iframe></span></div>`,
    `<div id="zwinfo">${mainLink}<a class="report-download" href="${other}"><span>相关阅读 </span><em>行业展望</em></a></div>`,
    `<div id="zwinfo">${mainLink}<a download href="${other}">相关<br>研报</a></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关\n  <br>研报</strong></p>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：行业展望</p><div class="report-download"><h2>附件下载</h2><a href="${other}">下载 PDF</a></div></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：行业展望</p><div class="report-download"><script>window.pdf="${other}";</script></div></div>`,
    `<div id="zwinfo">${mainLink}<h2>相关阅读</h2><p><span class="title"> </span><span data-encode-url="other">原文下载</span></p>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<h2>相关阅读</h2><h3><a data-encode-url="other" href="/report/2">原文下载</a></h3>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：行业展望</p><a data-encode-url="other" href="/report/2"><h2>原文下载</h2></a>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p>正文预览<a id="heading"></a><strong>相关阅读：</strong>行业展望</p>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：详见<a href="/report/zw_macresearch.jshtml?encodeUrl=other">本报告</a></p>${otherLink}</div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：相关研报的原文见${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p>相关阅读：《本报告的下载链接见附录》 <time>2026-01-05</time> ${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<div class="report-download"><a href="/more">相关阅读</a><a href="${other}">量</a></div></div>`,
    `<div id="zwinfo">${mainLink}<a download href="${other}"><span class="related">下载</span></a></div>`,
    `<div id="zwinfo">${mainLink}<a download href="${other}"><details>相关阅读</details></a></div>`,
    `<div id="zwinfo"><details><summary>附录</summary><span>相关阅读：${otherLink}</span></details>${mainLink}</div>`,
    `<div id="zwinfo"><figure><figcaption>附录</figcaption><span>相关阅读：${otherLink}</span></figure>${mainLink}</div>`,
    `<div id="zwinfo"><figure><figcaption>相关阅读</figcaption>${otherLink}</figure>${mainLink}</div>`,
    `<div id="zwinfo"><select><option>相关阅读</option></select>${mainLink}</div>`,
    `<div id="zwinfo"><form><button>相关阅读：</button></form>${mainLink}</div>`,
    `<div id="zwinfo"><p><strong>相关阅读</strong>量统计见${mainLink}。</p></div>`,
    `<div id="zwinfo"><a href="/more">相关阅读</a>量统计见${mainLink}。</div>`,
    `<div id="zwinfo"><p><a href="/more">相关阅读</a>量1. 统计见${mainLink}。</p></div>`,
    `<article id="zwinfo"><p><small>相关阅读量</small>是本研报分析指标。</p>${mainLink}</article>`,
    `<div id="zwinfo">预览<iframe src="${pdf}"></iframe>相关阅读：行业展望${otherLink}</div>`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(wrapper)).pdfUrl, pdf);
  }
  const attestedBox = `<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a href="${pdf}">下载原文</a></div>`;
  const attestedScript = `<script>var zwinfo=${JSON.stringify({ encodeUrl: 'fixture', infoCode: 'AP202601010001' })};</script>`;
  for (const body of [
    `<head>${attestedScript}</head><body><div id="zwinfo">${mainLink}<script class="related">window.pdf="${other}";</script></div></body>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<p><strong>相关阅读</strong></p><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><p>下载提示</p><h3>推荐阅读</h3><a href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<p><strong>相关阅读</strong></p><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><p>下载提示</p><h3>推荐阅读</h3><a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}<cite class="related">相关阅读：${otherLink}</cite><a data-encode-url="fixture" data-info-code="AP202601010001" href="${pdf}">下载原文</a></div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<div class="report-download title" data-encode-url="fixture" data-info-code="AP202601010001">推荐阅读：<a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a href="/more">推荐阅读：</a><a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001">${`<a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${pdf}">下载原文</a>`.repeat(1000)}</div></div>`,
    `<div id="zwinfo"><p>${' '.repeat(50000)}普通正文说明。</p>${mainLink}</div>`,
    `<div id="zwinfo">${'<div><p>普通正文说明。</p>'.repeat(300)}${mainLink}${'</div>'.repeat(300)}</div>`,
    `<div id="zwinfo">${'<div>'.repeat(300)}${'<h2>普通标题</h2>'.repeat(2000)}${mainLink}${'</div>'.repeat(300)}</div>`,
    `<div id="zwinfo">${'<div class="report-download">'.repeat(200)}${`<a href="${pdf}">下载原文</a>`.repeat(500)}${'</div>'.repeat(200)}</div>`,
    `<div id="zwinfo">${`<a class="report-download" href="${pdf}">`.repeat(200)}下载原文${'</a>'.repeat(200)}</div>`,
    `<div id="zwinfo">${`<a download href="${pdf}">\n`.repeat(200)}下载原文${'\n</a>'.repeat(200)}</div>`,
    `<div id="zwinfo"><p>${'<a href="/item">普通链接文本</a> '.repeat(1000)}${mainLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<script data-encode-url="other">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><p>相关阅读<wbr>量统计</p>${mainLink}</div>`,
    `<div id="zwinfo"><p>相关<input type="text" value="指标">阅读统计</p>${mainLink}</div>`,
    `<div id="zwinfo">${attestedScript}<h2>相关阅读</h2><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><script>window.pdf="${pdf}";</script></div></div>`,
    `<div id="zwinfo">${mainLink}<script>Object.assign(window.theme, { dark: true });</script></div>`,
    `<div id="zwinfo">${mainLink}<script><!-- window.pdf="caption";\n</script></div>`,
    `<script>window.pdf="${pdf}" // 附件地址\n</script>`,
    `<div id="zwinfo"><p>相关阅读<!-- 列标签 -->量统计</p>${mainLink}</div>`,
    `<div id="zwinfo"><p>相关</p><search>阅读统计</search>${mainLink}</div>`,
    `<div id="zwinfo"><span>相关</span><iframe src="/preview"></iframe><span>阅读统计</span>${mainLink}</div>`,
    `<div id="zwinfo"><svg/><iframe src="${pdf}"></iframe></div>`,
    `<script>// comment\u2028window.pdf="${pdf}";</script>`,
    `<script>// comment\u2029window.pdf="${pdf}";</script>`,
    `<script>var zwinfo={"infoCode":"AP202601010001","pdfUrl":"${pdf}","nested":${'['.repeat(64)}1${']'.repeat(64)}};</script>`,
    `<div id="zwinfo"><iframe src="${pdf}" href="${other}"></iframe></div>`,
    `<div id="zwinfo"><div class="report-download" ${Array.from({ length: 512 }, (_, i) => `data-x-${i}="1"`).join(' ')}>${`<a href="${pdf}">下载</a>`.repeat(512)}</div></div>`,
    `<div id="zwinfo">${'<div>'.repeat(512)}${'</span>'.repeat(512)}${mainLink}${'</div>'.repeat(512)}</div>`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(body)).pdfUrl, pdf);
  }
  for (const relatedSection of [
    '<p>1. 相关阅读：参见正文说明。</p>',
    '<p>1. 相关阅读：<br>参见正文说明。</p>',
    '<p><strong>1. 相关阅读：</strong>参见正文说明。</p>',
    `<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p>`,
    `<p><strong>相关阅读</strong></p>1. 某行业研报 ${otherLink}`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${attestedScript}${relatedSection}${attestedBox}</div>`)).pdfUrl, pdf);
    assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${relatedSection}</div>${attestedBox}${attestedScript}`)).pdfUrl, pdf);
  }
  // 严格 fail-closed：一旦出现相关/推荐/延伸阅读标记，未携带与 zwinfo 元数据一致归属证明的链接或脚本一律拒收，不做中文正文或标题重置猜测。
  for (const relOnly of [
    `<main id="zwinfo"><div>正文<span> </span><em>相关</em>阅读：${otherLink}</div></main>`,
    `<ul id="zwinfo"><li>正文<span> </span><em>相关</em>阅读：${otherLink}</li></ul>`,
    `<ul id="zwinfo"><li>相关阅读</li><li>${otherLink}</li></ul>`,
    `<div id="zwinfo"><div>相关阅读：${otherLink}</div><ul><li>${otherLink}</li></ul></div>`,
    `<div id="zwinfo"><p>相关阅读：<br>1. ${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读：<br><span>1. </span>${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读：<br>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 某行业研报<img alt="">${otherLink}</p></div>`,
    `<div id="zwinfo"><span><span role="heading" aria-level="2">相关阅读</span><img alt=""></span>1. 某行业研报 ${otherLink}</div>`,
    `<div id="zwinfo"><span role="heading" aria-level="2">相关阅读</span>1. 某行业研报 ${otherLink}</div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 需求见底？三季度行业展望 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 需求见底。三季度行业展望 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 《行业展望》。${otherLink}</p></div>`,
    `<div id="zwinfo"><p>【相关阅读】：1. 《行业展望》。${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读</strong>《行业展望》${otherLink}</p></div>`,
    `<div id="zwinfo"><h2>相关阅读：<a class="report-download" href="/index">下载目录</a></h2>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：1. 行业展望</p><div>${otherLink}<h2>本研报附件</h2></div></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2><ul><li><h2>行业展望</h2>${otherLink}</li></ul></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2><ul><li><a class="report-title" download href="${other}">某行业研报</a></li></ul></div>`,
    `<div id="zwinfo"><section><h2>相关阅读</h2></section>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：详见<a href="/report/zw_macresearch.jshtml?encodeUrl=other">本报告</a></p>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：相关研报的原文见${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读：推荐报告的下载地址见${otherLink}</p></div>`,
    `<div id="zwinfo">相关阅读：《本报告的下载链接见附录》 <time>2026-01-05</time> ${otherLink}</div>`,
    `<div id="zwinfo"><p>正文预览<a id="heading"></a><strong>相关阅读：</strong>行业展望</p>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：行业展望</p><div class="report-download"><h2>附件下载</h2><a href="${other}">下载 PDF</a></div></div>`,
    `<div id="zwinfo"><p>相关阅读：行业展望</p><div class="report-download"><script>window.pdf="${other}";</script></div></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2><p><span class="title"> </span><span data-encode-url="other">原文下载</span></p>${otherLink}</div>`,
    `<div id="zwinfo"><h2>相关阅读</h2><h3><a data-encode-url="other" href="/report/2">原文下载</a></h3>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：行业展望</p><a data-encode-url="other" href="/report/2"><h2>原文下载</h2></a>${otherLink}</div>`,
    `<div id="zwinfo"><p><strong>相关\n  <br>研报</strong></p>${otherLink}</div>`,
    `<div id="zwinfo"><p><strong>相关&nbsp;<br>研报</strong></p>${otherLink}</div>`,
    `<div id="zwinfo"><p><strong>相关\r\n研报</strong></p>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关阅读 量价分析见${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读<br>量价分析见${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读\u200b量价分析见${otherLink}</p></div>`,
    `<div id="zwinfo"><a href="/more">相关阅读</a><a download href="${other}">量</a></div>`,
    `<div id="zwinfo"><a href="/more">相关阅读</a><a href="/x">量</a>${otherLink}</div>`,
    `<div id="zwinfo"><a download href="${other}"><span class="related">下载</span></a></div>`,
    `<div id="zwinfo"><a download href="${other}"><details>相关阅读</details></a></div>`,
    `<div id="zwinfo"><div class="report-download"><a href="/more">推荐阅读：</a><a class="report-download" href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo"><div class="report-download"><a href="/more">推荐阅读：</a><script>window.pdf="${other}";</script></div></div>`,
    `<div id="zwinfo"><div class="report-download"><a href="/more">推荐阅读</a><a href="${other}">下载 PDF</a></div></div>`,
    `<div id="zwinfo"><iframe data-encode-url="other" src="${other}"></iframe></div>`,
    `<div id="zwinfo"><script class="related">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script data-encode-url="other">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><span><iframe src="${other}"></iframe></span></div>`,
    `<div id="zwinfo"><a class="report-download" href="${other}"><span>相关阅读 </span><em>行业展望</em></a></div>`,
    `<div id="zwinfo"><a download href="${other}">【相关<br>研报】</a></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<h2>本研报附件</h2>${mainLink}</div>`,
    `<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<p><span class="title">本研报附件</span></p>${mainLink}</div>`,
    `<div id="zwinfo"><p>相关阅读：详见正文。下载地址见${mainLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读：本段说明获取方式</p>${attestedScript}<a role="heading" aria-level="2" href="${pdf}">附件说明</a>${otherLink}</div>`,
    `<div id="zwinfo"><button><a download href="${other}">下载</a></button></div>`,
    `<div id="zwinfo"><a download href="${other}"><button>相关阅读</button></a></div>`,
    `<div id="zwinfo"><form><button>相关阅读</button><a download href="${other}">下载</a></form></div>`,
    `<div id="zwinfo"><a download href="${pdf}"><span class="related">相关阅读</span><script>window.pdf="${other}";</script></a></div>`,
    `<div id="zwinfo"><a download href="${pdf}"><span class="related">相关阅读</span><a download href="${other}">下载</a></a></div>`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><details><h3>推荐阅读</h3>${mainLink}</details></div></div>`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><figure><h3>推荐阅读</h3>${mainLink}</figure></div></div>`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><dialog><h3>推荐阅读</h3>${mainLink}</dialog></div></div>`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><div id="zwinfo"><h3>推荐阅读</h3>${mainLink}</div></div></div>`,
    `<div id="zwinfo">${attestedScript}<h2>相关阅读</h2><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001">${mainLink}<h3>推荐阅读</h3></div></div>`,
    `<div id="zwinfo"><a download href="${other}"><iframe class="related" src="/list-preview"></iframe></a></div>`,
    `<div id="zwinfo"><section><h2 class="related">相关阅读</h2>${otherLink}</section></div>`,
    `<div id="zwinfo"><section><p class="related">相关阅读</p>${otherLink}</section></div>`,
    `<div id="zwinfo"><p>相关<slot>阅读</slot></p>${otherLink}</div>`,
    `<div id="zwinfo"><p>相关<tt>阅读</tt></p>${otherLink}</div>`,
    `<div id="zwinfo"><fieldset disabled>${otherLink}</fieldset></div>`,
    `<div id="zwinfo"><fieldset disabled><script>window.pdf="${other}";</script></fieldset></div>`,
    `<div id="zwinfo"><section CLASS="related">${otherLink}</section></div>`,
    `<div id="zwinfo"><div DATA-ENCODE-URL="other"><a href="${other}">下载</a></div></div>`,
    `<div id="zwinfo"><script SRC="/placeholder.js">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><div class="report-download" data-encode-url="other" data-info-code="AP202601010001"><a data-encode-url="fixture" data-info-code="AP202601010002" href="${other}">下载</a></div></div>`,
    `<div id="zwinfo"><script type="text/plain">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script TYPE="application/json">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script type="module;draft">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script type="text/javascript;charset=utf-8">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script language="vbscript">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo">${attestedScript}<h2>相关阅读</h2><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001">${mainLink}<div class="report-download">推荐阅读</div></div></div>`,
    `<div id="zwinfo">${attestedScript}<h2>相关阅读</h2><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><script>window.pdf="${pdf}";</script><div class="report-download">推荐阅读</div></div></div>`,
    `<div id="zwinfo"><div class="related"><div class="related">相关阅读</div></div>${otherLink}</div>`,
    `<div id="zwinfo"><p class="report-download">说明<p><a href="${other}">下载</a></div>`,
    `<div id="zwinfo"><svg class="report-download"/><a href="${other}">下载</a></div>`,
    `<div id="zwinfo"><p>相&Tab;关阅读</p>${otherLink}</div>`,
    `<div id="zwinfo"><p>相&#0000000020851;阅读</p>${otherLink}</div>`,
    `<div id="zwinfo"><a\u00a0download href="${other}">下载</a></div>`,
    `<div id="zwinfo"><a download href="${other}"`,
    `<script>window.pdf="${other}";`,
    `<div id="zwinfo"><plaintext>${otherLink}</div>`,
    `<div id="zwinfo"><object form="f" data="/preview.txt">${otherLink}<script>window.pdf="${other}";</script></object></div>`,
    `<div id="zwinfo"><iframe srcdoc="<p>preview</p>" src="${other}"></iframe></div>`,
    `<div id="zwinfo"><div class="report&hyphen;download"><a href="${other}">普通链接</a></div></div>`,
    `<div id="zwinfo"><p>相&nbsp关阅读</p>${otherLink}</div>`,
    `<div id="zwinfo"><script type=" ">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script type=" module ">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script language=" javascript ">window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><script nomodule>window.pdf="${other}";</script></div>`,
    `<div id="zwinfo"><ul><li class="report-download">说明<li><a href="${other}">普通链接</a></ul></div>`,
    `<div id="zwinfo"><dl><dt class="report-download">说明<dd><a href="${other}">普通链接</a></dl></div>`,
    `<div id="zwinfo"><table><tr><td class="report-download">说明<td><a href="${other}">普通链接</a></tr></table></div>`,
    `<div id="zwinfo"><math><mrow><script>window.pdf="${other}";</script></mrow></math></div>`,
    `<div id="zwinfo"><script>window.pdf="${other}";</script x=">`,
    `<div id="zwinfo"><textarea>x</textarea data-label='> ${otherLink}'></div>`,
    `<div id="zwinfo"><div class="report-download"><a href="${other}">下载</a>推荐阅读<`,
    `<div id="zwinfo"><div class="related">相关<span class="related">阅读</span></div>${otherLink}</div>`,
    `<div id="zwinfo"><div class="related">相关阅读<script type="application/json">{}</script></div>${otherLink}</div>`,
    `<base href="http://example.test/"><div id="zwinfo"><a download href="//pdf.dfcfw.com/pdf/H3_AP202601010002_1.pdf">下载</a></div>`,
  ]) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(relOnly)), noPdf);
  }
  const deepSpanOpen = '<span>'.repeat(4000), deepSpanClose = '</span>'.repeat(4000);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${deepSpanOpen}普通正文说明。${mainLink}${deepSpanClose}</p></div>`)).pdfUrl, pdf);
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${deepSpanOpen}相关阅读：1. 某行业研报 ${otherLink}${deepSpanClose}</p></div>`)), noPdf);
  const wideSiblingSpans = '<span></span>'.repeat(64);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${wideSiblingSpans}普通正文说明。${mainLink}</p></div>`)).pdfUrl, pdf);
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${wideSiblingSpans}相关阅读：1. 某行业研报 ${otherLink}</p></div>`)), noPdf);
  for (const emptyLike of ['', 'plain text', '<!-- comment -->']) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(emptyLike)), noPdf);
  }
  const metadata = 'var zwinfo = {"infoCode":"AP202601010001"};', scriptPdf = (url: string) => `window.pdf="${url}";`;
  for (const declarations of [[metadata, scriptPdf(other)], [scriptPdf(other), metadata]]) {
    for (const separator of ['', '</script><script>'])
      assert.throws(() => decodeEastmoneyReportDetail(request, html('<script>' + declarations.join(separator) + '</script>')),
        invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  }
  assert.equal(decodeEastmoneyReportDetail(request, html(`<script>${metadata}${scriptPdf(pdf)}</script>`)).pdfUrl, pdf);
  for (const [declaration, reason] of [
    ['zwinfo.infoCode="AP202601010002";', '研报详情元数据与附件声明指向不同的 infoCode。'],
    ['log(); zwinfo.infoCode="AP202601010002";', '详情脚本包含无法静态核对的研报或附件声明。'],
  ] as const)
    assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>${declaration}</script><script>${scriptPdf(pdf)}</script>`)),
      invalidDetail(reason));
  for (const body of [related, `<nav><a href="${pdf}">相关</a></nav>`, `<a href="${pdf}">相关阅读</a>`,
    `<article id="zwinfo"><section><h2>相关阅读</h2><a href="${pdf}">PDF</a></section></article>`,
    `<aside>${attestedBox}</aside>${attestedScript}`,
    `<div id="zwinfo"><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><span>相关阅读：</span><a href="${pdf}">下载原文</a></div></div>${attestedScript}`,
    `<div id="zwinfo">${attestedScript}<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><h3>相关阅读</h3><a href="${pdf}">下载原文</a></div></div>`,
    `<div id="zwinfo">${attestedScript}<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p><div class="report-download" data-encode-url="fixture"><a href="${pdf}">下载原文</a></div></div>`,
    `<div id="zwinfo">${attestedScript}<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p><div class="report-download" data-info-code="AP202601010001"><a href="${pdf}">下载原文</a></div></div>`,
    `<div id="zwinfo" data-encode-url="fixture">${attestedScript}<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p><div class="report-download"><a data-info-code="AP202601010001" href="${pdf}">下载原文</a></div></div>`,
    `<div data-encode-url="other"><a href="${pdf}">PDF</a></div>`,
    `<script>var related = {"pdfUrl":"${pdf}"};</script>`])
    assert.throws(() => decodeEastmoneyReportDetail(request, html(body)), noPdf);
  for (const rootWrapper of [
    `<div class="report-download"><a href="${other}">下载</a></div><div id="zwinfo"><h2>相关阅读</h2></div>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><div id="zwinfo"><strong>相关阅读</strong></div>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><span id="zwinfo"><strong>相关阅读</strong></span>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><div><span id="zwinfo"><strong>相关阅读</strong></span></div>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><div class="title"><main><strong>相关阅读</strong></main></div>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><div class="title"><div class="report-download"><strong>相关阅读</strong></div></div>${attestedScript}`,
    `<div class="report-download"><a href="${other}">下载</a></div><div class="title" role="heading"><div class="report-download"><strong>相关阅读</strong></div></div>${attestedScript}`,
  ]) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(rootWrapper)),
      invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  }
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a href="${other}">下载原文</a></div>${attestedScript}`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><iframe data-info-code="AP202601010001" src="${other}"></iframe></div>${attestedScript}`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"infoCode":"AP202601010002","pdfUrl":"${pdf}"};</script>`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script data-info-code="AP202601010001">window.pdf="${other}";</script>`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div data-info-code="AP202601010001"><script>window.pdf="${other}";</script></div>`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a data-info-code="AP202601010002" href="${other}">下载</a></div>`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"encodeUrl":"fixture"}; zwinfo.encodeUrl="other";</script><script>window.pdf="${other}";</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>window.pdf="${pdf}"; window["pdf"]=getPdf();</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>window.pdf="${pdf}"; window["\\u0070df"]=getPdf();</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"infoCode":"AP202601010001","infoCode":"AP202601010002","pdfUrl":"${other}"};</script>`)),
    invalidDetail('研报详情元数据无法核对。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"encodeUrl":"other","encodeUrl":"fixture","pdfUrl":"${other}"};</script>`)),
    invalidDetail('研报详情元数据无法核对。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>// comment\rzwinfo.infoCode="AP202601010002";</script><div id="zwinfo">${mainLink}</div>`)),
    invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${mainLink}<!-- comment --!><script>zwinfo.infoCode="AP202601010002";</script></div>`)),
    invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>window.pdf="${pdf}"; pdf="";</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>window.pdf="${pdf}"; window.pdf++;</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>window.pdf="${pdf}"; const v = stats.return / (window.pdf = "");</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={title:"line1\nline2",pdfUrl:"${pdf}"};</script>`)),
    invalidDetail('研报详情元数据无法核对。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"__proto__":{"encodeUrl":"other"},"pdfUrl":"${pdf}"};</script>`)),
    invalidDetail('研报详情元数据无法核对。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${mainLink}<svg><title/></svg><script>zwinfo.infoCode="AP202601010002";</script></div>`)),
    invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${mainLink}<![CDATA[示例><script>zwinfo.infoCode="AP202601010002";</script>]]></div>`)),
    invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  for (const unverifiedScript of [
    `window.pdf="${pdf}"\n.slice(0,0);`,
    `window.pdf="${pdf}"; const n = {} / (window.pdf = "");`,
    `window.pdf="${pdf}"; const label="x\u2028"; window.pdf="";`,
    `window.pdf="${pdf}"; const label="x\u2029"; window.pdf="";`,
    `window.pdf="${pdf}"; Object.assign(window.self,{pdf:""});`,
    `window.pdf="${pdf}"; Reflect.deleteProperty(window,"pdf");`,
    `window.pdf="${pdf}"; (window).pdf="";`,
    `window.pdf="${pdf}"; delete (window.pdf);`,
    `window.pdf="${pdf}"; for (window.pdf of [""]) {}`,
    `window.pdf="${pdf}"; window.\\u{00000070}df="";`,
    `window.pdf="${pdf}"; const ;`,
    `var zwinfo={"pdfUrl":"${pdf}"}; zwinfo={};`,
  ]) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>${unverifiedScript}</script>`)),
      invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
  }
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"pdfUrl":"${pdf}"};</script><script>zwinfo={};</script>`)),
    invalidDetail('详情脚本包含无法静态核对的研报或附件声明。'));
});

const detailRequest = { category: 'macro' as const, encodeUrl: 'fixture' };
const infoA = 'AP202601010001', infoB = 'AP202601010002';
const fileA = `H3_${infoA}_1.pdf`, fileB = `H3_${infoB}_1.pdf`;
const pdfRoot = 'https://pdf.dfcfw.com/pdf/';
const pdfA = pdfRoot + fileA, pdfB = pdfRoot + fileB;
const detailPdf = (body: string) => decodeEastmoneyReportDetail(detailRequest, html(body)).pdfUrl;
const inlineScript = (body: string, attrs = '') => `<script ${attrs}>${body}</script>`;
const assignPdf = (pdf: string) => `window.pdf='${pdf}';`;
const anchor = (href: string, attrs = 'download') => `<a ${attrs} href="${href}">PDF</a>`;
const report = (body: string) => `<div id="zwinfo">${body}</div>`;
const unverified = invalidDetail('详情脚本包含无法静态核对的研报或附件声明。');
const conflictingCode = invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。');

test('Eastmoney verifies complete classic scripts and observes Annex B line boundaries and explicit semicolons', () => {
  const proof = assignPdf(pdfA);
  for (const body of [proof + ' /*', proof + ' --> trailing', proof + ' /* same line */ --> trailing', proof + ' const ;',
    '/* never closed ' + proof]) {
    assert.throws(() => detailPdf(report(anchor(pdfA)) + inlineScript(body)), unverified, body);
  }
  for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.equal(detailPdf(inlineScript(`window.pdf='${pdfA}'${newline};`)), pdfA);
    assert.equal(detailPdf(inlineScript(`window.pdf='${pdfA}' // comment${newline};`)), pdfA);
    assert.equal(detailPdf(inlineScript(`--> heading${newline}${proof}${newline} \t--> trailing`)), pdfA);
    assert.equal(detailPdf(inlineScript(`${proof} /* a${newline}b */ --> trailing`)), pdfA);
  }
  assert.equal(detailPdf(inlineScript('<!-- heading\n' + proof)), pdfA);
  for (const body of [proof, '<!-- heading\n' + proof, 'export {}; ' + proof]) {
    assert.throws(() => detailPdf(inlineScript(body, 'type=module')), unverified);
  }
  assert.equal(detailPdf(inlineScript('export {};', 'type=module nomodule') + inlineScript(proof)), pdfA);
});

test('Eastmoney applies nomodule and legacy for/event only to classic scripts', () => {
  const first = inlineScript(assignPdf(pdfA));
  for (const attrs of ['type=module nomodule', 'type=MoDuLe for=document event=click', 'type=module nomodule for="" event=""']) {
    assert.throws(() => detailPdf(first + inlineScript(assignPdf(pdfB), attrs)), unverified, attrs);
  }
  for (const attrs of ['nomodule', 'for=document event=onload', 'for=window event=onclick', 'for="" event=""',
    'for="window\u00a0" event=onload', 'for=window event="onload ( )"', 'language="javascript "']) {
    assert.throws(() => detailPdf(inlineScript(assignPdf(pdfB), attrs)), noPdf, attrs);
    assert.equal(detailPdf(first + inlineScript(assignPdf(pdfB), attrs)), pdfA, attrs);
  }
  for (const attrs of ['for=window event=onload', 'for=" \tWINDOW" event="OnLoad()\n"', 'for=document', 'event=onclick',
    'type="" language=vbscript', 'type=" Text/JavaScript "']) {
    assert.equal(detailPdf(inlineScript(assignPdf(pdfA), attrs)), pdfA, attrs);
  }
});

test('Eastmoney rejects unverified metadata mutations anywhere in executable scripts', () => {
  const first = inlineScript(assignPdf(pdfA));
  const mutations = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=', '**=']
    .map(operator => `pdf ${operator} "";`);
  mutations.push('function pdf() {}', 'function* pdf() {}', 'class pdf extends Base {}', 'let /* binding */ pdf\nvoid 0;',
    '++pdf;', 'pdf--;', 'delete (pdf);', '({key: pdf} = value);', '([pdf, ...rest] = value);',
    'for (pdf of list) {}', 'pdf /* gap */ &&= "";', String.raw`\u0070df ||= "";`, String.raw`\u{70}df = "";`,
    String.raw`const \u0061 = 1;`, String.raw`window.name = "\x78";`, 'self[key] = 1;', 'void globalThis.pdf;',
    'Object.defineProperty(this, "pdf", {});', 'log(zwinfo);');
  for (const body of mutations) {
    assert.throws(() => detailPdf(first + inlineScript(body)), unverified, body);
    assert.throws(() => detailPdf(first + `<aside>${inlineScript(body)}</aside>`), unverified, body);
  }
  assert.equal(detailPdf(first + inlineScript('Object.assign(window.theme, {dark: true});')), pdfA);
});

test('Eastmoney counts zwinfo objects before ownership filtering and checks statement order', () => {
  const object = `var zwinfo={"pdfUrl":"${pdfA}"};`;
  for (const wrapper of ['<aside>', '<div class=related>', '<fieldset>', '<div data-encode-url=other>']) {
    const extra = wrapper + inlineScript('zwinfo={};') + `</${wrapper.slice(1).split(/[ >]/u)[0]}>`;
    for (const body of [inlineScript(object) + extra, extra + inlineScript(object)]) assert.throws(() => detailPdf(body), unverified);
  }
  assert.equal(detailPdf(inlineScript(object) + '<template>' + inlineScript('zwinfo={};') + '</template>'), pdfA);
  assert.equal(detailPdf(inlineScript(object) + inlineScript('zwinfo={};', 'nomodule')), pdfA);
  const property = `zwinfo.infoCode='${infoA}';`;
  for (const binding of ['let', 'const', 'var']) {
    assert.throws(() => detailPdf(inlineScript(property + `${binding} zwinfo={};` + assignPdf(pdfA))), unverified);
    assert.equal(detailPdf(inlineScript(`${binding} zwinfo={};` + property + assignPdf(pdfA))), pdfA);
  }
  assert.throws(() => detailPdf(inlineScript('let zwinfo={}; window.' + property + assignPdf(pdfA))), unverified);
});

test('Eastmoney uses HTML and MathML integration points and the foreign-content breakout rules', () => {
  const conflict = inlineScript(`zwinfo.infoCode='${infoB}';`);
  const main = report(anchor(pdfA));
  const contexts: [string, string][] = [];
  for (const tag of ['foreignObject', 'desc', 'title']) contexts.push([`<svg><${tag}>`, `</${tag}></svg>`]);
  for (const tag of ['mi', 'mo', 'mn', 'ms', 'mtext']) contexts.push([`<math><${tag}>`, `</${tag}></math>`]);
  for (const encoding of ['TEXT/HTML', 'application/XHTML+xml']) {
    contexts.push([`<math><annotation-xml encoding="${encoding}">`, '</annotation-xml></math>']);
  }
  contexts.push(['<math><annotation-xml><svg><foreignObject>', '</foreignObject></svg></annotation-xml></math>']);
  for (const [open, close] of contexts) {
    assert.throws(() => detailPdf(main + open + conflict + close), conflictingCode, open);
    assert.equal(detailPdf(report(open + anchor(pdfB) + close)), pdfB, open);
    assert.throws(() => detailPdf(`<div data-encode-url="other">${open}${inlineScript(assignPdf(pdfB))}${close}</div>`), noPdf, open);
  }
  for (const tag of ['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr',
    'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
    'font color=""', 'font face=x', 'font size=1']) {
    assert.throws(() => detailPdf(main + `<svg><g><${tag}>${conflict}</g></svg>`), conflictingCode, tag);
  }
  for (const open of ['<svg><g><font>', '<math><mrow>', '<svg><title/>', '<math><mtext/>',
    '<math><mtext><mglyph>', '<math><mi><malignmark>', '<math><annotation-xml encoding=" text/html ">']) {
    assert.equal(detailPdf(main + open + conflict), pdfA, open);
  }
  for (const end of ['</p>', '</br>']) assert.throws(() => detailPdf(main + '<svg><g>' + end + conflict), conflictingCode);
  assert.throws(() => detailPdf(main + '<svg><title/></svg>' + conflict), conflictingCode);
});

test('Eastmoney tokenizes a leading equals sign as an attribute name on ordinary and raw end tags', () => {
  const a = inlineScript(assignPdf(pdfA)), b = inlineScript(assignPdf(pdfB));
  for (const prefix of ['<div></div', '<textarea>x</textarea', '<script>void 0;</script']) {
    for (const attr of [' ="', " ='", ' = "', ' foo="" ="']) {
      assert.throws(() => detailPdf(a + prefix + attr + '>' + b + '">'), conflictingCode, prefix + attr);
    }
    assert.equal(detailPdf(a + prefix + ` == " > ${b} ">`), pdfA);
  }
  assert.throws(() => detailPdf(a + '<div =">' + b + '">'), conflictingCode);
});

test('Eastmoney respects nested list scopes, optional end tags and sibling anchors', () => {
  const link = anchor(pdfB, '');
  for (const list of ['ul', 'ol', 'menu']) {
    const body = `<ul><li data-encode-url=other><${list}><li>${anchor(pdfB)}</${list}></ul>`;
    assert.throws(() => detailPdf(report(body)), noPdf, list);
  }
  for (const [first, second] of [
    ['<head class="report-download"><meta>', '<body>'], ['<head class="report-download"><title>t</title>', ''],
    ['<p class="report-download">a', '<section>'], ['<a class="report-download">a', ''],
    ['<ul><li class="report-download">a', '<li>'], ['<dl><dd class="report-download">a', '<dt>'],
    ['<ruby><rt class="report-download">a', '<rp>'], ['<ruby><rp class="report-download">a', '<rt>'],
    ['<table><colgroup class="report-download"><col>', '<tbody><tr><td>'],
    ['<table><caption class="report-download">a', '<tbody><tr><td>'],
    ['<table><thead class="report-download"><tr><th>a', '<tbody><tr><td>'],
    ['<table><tbody class="report-download"><tr><td>a', '<tbody><tr><td>'],
    ['<table><tbody class="report-download"><tr><td>a', '<tfoot><tr><td>'],
    ['<table><tfoot class="report-download"><tr><td>a', '<caption>'],
    ['<table><tr class="report-download"><td>a', '<tr><th>'],
    ['<table><tr><th class="report-download">a', '<td>'],
    ['<table><tr><td class="report-download">a', '<th>'],
  ]) assert.throws(() => detailPdf(first + second + link), noPdf, first + second);
  assert.equal(detailPdf(`<table><tbody class="report-download"><tr><td><table><tbody><tr><td>${link}</table></table>`), pdfB);
  assert.equal(detailPdf(report('<a data-encode-url=other>before' + anchor(pdfB))), pdfB);
  for (const tag of ['div', 'article', 'b', 'em']) {
    assert.throws(() => detailPdf(report(`<a><${tag} data-encode-url=other>text${anchor(pdfB)}`)), noPdf, tag);
    assert.equal(detailPdf(`<a><${tag} class=report-download>text${link}`), pdfB, tag);
  }
  assert.equal(detailPdf(report(`<a><span data-encode-url=other><div>text${anchor(pdfB)}`)), pdfB);
  const crossedAnchor = (blocks: number) => '<a class=report-download>' + '<div>'.repeat(blocks) + link;
  assert.throws(() => detailPdf(crossedAnchor(7)), noPdf);
  assert.equal(detailPdf(crossedAnchor(8)), pdfB);
  assert.equal(detailPdf(crossedAnchor(2048) + '<a></a>'.repeat(2048)), pdfB);
  for (const boundary of ['menu', 'section', 'article', 'fieldset']) {
    assert.throws(() => detailPdf(report(`<ul><li data-encode-url=other><${boundary}><li>${anchor(pdfB)}`)), noPdf);
  }
  assert.throws(() => detailPdf(report(`<ruby><rt data-encode-url=other><span><rp>${anchor(pdfB)}`)), noPdf);
  const tableInParagraph = `<p class=report-download><table><tr><td>${link}</table>`;
  assert.equal(detailPdf(tableInParagraph), pdfB);
  assert.throws(() => detailPdf('<!doctype html>' + tableInParagraph), noPdf);
  assert.equal(detailPdf('<!doctype html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">' + tableInParagraph), pdfB);
  assert.throws(() => detailPdf('<!doctype html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "legacy.dtd">' + tableInParagraph), noPdf);
  for (const tag of ['option', 'optgroup']) {
    for (const end of ['', `</${tag}>`]) {
      const select = `<select><${tag} class=related>相关阅读${end}<${tag}>${inlineScript('void 0;')}</select>`;
      assert.equal(detailPdf(report(select + anchor(pdfB))), pdfB);
    }
  }
  // select 之外只有当前 option 被隐式弹出。未闭合的 optgroup 可以包含后一个 optgroup。
  const outsideSelect = (tag: string) => report(`<${tag} class=related>相关阅读<${tag}>${inlineScript('void 0;')}</${tag}></${tag}>${anchor(pdfB)}`);
  assert.throws(() => detailPdf(outsideSelect('option')), noPdf);
  assert.equal(detailPdf(outsideSelect('optgroup')), pdfB);
});

test('Eastmoney uses the parent of the nearest table for fostered content', () => {
  const link = anchor(pdfB, '');
  for (const part of ['', '<thead>', '<tbody>', '<tfoot>', '<tr>', '<tbody><tr>']) {
    assert.throws(() => detailPdf(`<table class=report-download>${part}${link}</table>`), noPdf, part);
    assert.equal(detailPdf(`<div class=report-download><table data-encode-url=other>${part}<div>${link}</div></table></div>`), pdfB, part);
  }
  for (const part of ['<caption>', '<tr><th>', '<tbody><tr><td>']) {
    assert.equal(detailPdf(`<table class=report-download>${part}${link}</table>`), pdfB, part);
    assert.throws(() => detailPdf(report(`<table data-encode-url=other>${part}${anchor(pdfB)}</table>`)), noPdf, part);
  }
  assert.equal(detailPdf(`<div class=report-download><table data-encode-url=other><tbody><form>${link}</table></div>`), pdfB);
  assert.equal(detailPdf(report(`<table><caption>相关阅读</caption>${anchor(pdfB)}</table>`)), pdfB);
  assert.equal(detailPdf(`<table class=report-download><td><table data-encode-url=other>${link}</table></table>`), pdfB);
});

test('Eastmoney leaves noscript raw and keeps every close tag inside its innermost template', () => {
  const a = inlineScript(assignPdf(pdfA)), b = inlineScript(assignPdf(pdfB));
  assert.throws(() => detailPdf(a + '<noscript><textarea></noscript>' + b), conflictingCode);
  for (const tag of ['div', 'aside', 'table', 'span', 'svg']) {
    const open = tag === 'svg' ? '<svg><foreignObject>' : `<${tag}>`;
    assert.throws(() => detailPdf(open + `<template></${tag}>${b}${anchor(pdfB, 'class=report-download')}</template>`), noPdf, tag);
  }
  assert.equal(detailPdf(a + `<div><template><template></div></template>${b}</template></div>`), pdfA);
  assert.equal(detailPdf(a + `<noscript>${b}${anchor(pdfB, 'class=report-download')}</noscript>`), pdfA);
});

test('Eastmoney keeps related text contiguous across inert and empty scripts', () => {
  for (const script of [inlineScript('{}', 'type=application/json'), inlineScript('let x=1;', 'nomodule'),
    inlineScript(assignPdf(pdfA), 'for=document event=onload'), '<script></script>', '<script> \t\r\n </script>']) {
    for (const heading of ['相关' + script + '阅读', '相关阅读' + script]) {
      assert.throws(() => detailPdf(report(`<div class=related>${heading}</div>${anchor(pdfB)}`)), noPdf);
      assert.throws(() => detailPdf(report(`<h2>${heading}</h2>${anchor(pdfB)}`)), noPdf);
    }
  }
});

test('Eastmoney decodes all 106 case-sensitive legacy character references', () => {
  // 名称依 ISO-8859-1 码位顺序排列，另有四个 ASCII 字符及六个大写别名。
  const latin1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr '
    + 'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
    + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml '
    + 'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
    + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml '
    + 'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
  const names = [...latin1, 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG'];
  const expected = [...latin1.map((_, i) => String.fromCodePoint(160 + i)), ...'&<>"&<>"©®'].join('|');
  assert.equal(names.length, 106);
  for (const semi of ['', ';']) {
    const query = names.map(name => '&' + name + semi).join('|');
    assert.equal(detailPdf(report(anchor(pdfA + '?' + query))), new URL(pdfA + '?' + expected).href);
    assert.throws(() => detailPdf(report(`相&shy${semi}关阅读${anchor(pdfB)}`)), noPdf);
    assert.throws(() => detailPdf(report(`相&nbsp${semi}关阅读${anchor(pdfB)}`)), noPdf);
  }
  assert.equal(detailPdf(report('相&SHY关阅读' + anchor(pdfB))), pdfB);
  assert.equal(detailPdf(report(anchor(pdfA + '?q=&notin;|&centerdot;'))), new URL(pdfA + '?q=∉|·').href);
  assert.equal(detailPdf(report(anchor(pdfA + '?x=&copycat&y=&amp=z'))), pdfA + '?x=&copycat&y=&amp=z');
});

test('Eastmoney resolves anchors, embedded previews and related descendants against the first document base', () => {
  const base = `<base href="${pdfRoot}">`;
  for (const relative of [anchor(fileB), `<iframe src="${fileB}"></iframe>`, inlineScript(`var zwinfo={attachUrl:'${fileB}'};`)]) {
    for (const content of [base + relative, relative + base]) {
      assert.equal(detailPdf(report(content)), pdfB);
      assert.throws(() => detailPdf(report(anchor(pdfA) + content)), conflictingCode);
    }
  }
  for (const href of ['data:text/plain,x', 'javascript:void(0)', 'ftp://example.test/', 'https://[invalid']) {
    const baseFallback = `<base href="${href}"><base href="http://example.test/">`;
    const relative = anchor(pdfB.slice('https:'.length));
    assert.equal(detailPdf(report(relative) + baseFallback), pdfB, href);
    assert.throws(() => detailPdf(report(anchor(pdfA) + relative) + baseFallback), conflictingCode, href);
  }
  for (const inert of [`<template>${base}</template>`, `<noscript>${base}</noscript>`, `<svg><g>${base}</g></svg>`,
    `<math><mrow>${base}</mrow></math>`]) {
    assert.throws(() => detailPdf(report(anchor(fileB)) + inert), noPdf);
    assert.equal(detailPdf(inert + '<base>' + report(anchor(fileB)) + base), pdfB);
  }
  assert.equal(detailPdf('<svg><foreignObject>' + base + '</foreignObject></svg>' + report(anchor(fileB))), pdfB);
  // 真正的 PDF 后代使 related 成为自包含推荐区，普通链接保留标题对外层的作用。
  const related = (href: string) => report(`<div class=related>相关阅读${anchor(href)}</div>${anchor(pdfA)}`);
  assert.equal(detailPdf(related(fileB) + base), pdfA);
  assert.throws(() => detailPdf(related('article.html') + base), noPdf);
  // 同一原始 href 的每一次归属声明仍须独立核对。
  assert.throws(() => detailPdf(report(anchor(fileA) + anchor(fileA, `download data-info-code="${infoB}"`)) + base),
    invalidDetail('研报详情标识与附件标识不符。'));
});

// 通过公开入口测量实际传入 WHATWG URL 构造器的次数和字符量，计入基准 URL。
function measureDetail(t: TestContext, label: string, input: Uint8Array, check: () => void) {
  const NativeURL = globalThis.URL;
  let calls = 0, characters = 0;
  const instrumented = t.mock.method(globalThis, 'URL', class extends NativeURL {
    constructor(value: string | URL, base?: string | URL) {
      calls += 1;
      characters += String(value).length + (base === undefined ? 0 : String(base).length);
      super(value, base);
    }
  });
  const start = performance.now();
  try {
    check();
  } finally {
    instrumented.mock.restore();
  }
  const elapsed = performance.now() - start;
  t.diagnostic(`${label} · ${elapsed.toFixed(1)} ms · ${calls} URL constructions · ${characters} input characters`);
  assert.ok(elapsed < 2000, `${label} took ${elapsed} ms`);
  assert.ok(characters <= input.byteLength * 4, `${characters} URL characters for ${input.byteLength} bytes of HTML`);
  return calls;
}

test('Eastmoney bounds the 2,048-attribute, repeated-link and unmatched-close fixture', t => {
  const count = 2048;
  const attributes = Array.from({ length: count }, (_, i) => `data-x-${i}="1"`).join(' ');
  const tree = '<div>'.repeat(count) + '</span>'.repeat(count) + '</div>'.repeat(count);
  const input = html(report(`<div class="report-download" ${attributes}>${anchor(pdfA, '').repeat(count)}</div>${tree}`));
  const calls = measureDetail(t, '2,048 repeated links', input, () => {
    assert.equal(decodeEastmoneyReportDetail(detailRequest, input).pdfUrl, pdfA);
  });
  assert.ok(calls <= 4, `duplicates caused ${calls} URL constructions`);
});

test('Eastmoney coalesces short fragments on a long base and stops at the first distinct PDF or infoCode', t => {
  const basePdf = pdfA + '?signature=' + 'x'.repeat(65_536);
  const fragments = Array.from({ length: 2048 }, (_, i) => anchor('#' + i)).join('');
  const input = html(report(fragments) + `<base href="${basePdf}#initial">`);
  const calls = measureDetail(t, 'long base and 2,048 fragments', input, () => {
    assert.equal(decodeEastmoneyReportDetail(detailRequest, input).pdfUrl, basePdf);
  });
  assert.ok(calls <= 4, `fragment references caused ${calls} URL constructions`);

  const suffix = Array.from({ length: 2048 }, (_, i) => anchor('?unused=' + i)).join('');
  for (const [second, reason] of [[pdfB, conflictingCode], ['?different', invalidDetail('研报详情存在多个不同附件定位，须明确选择。')]] as const) {
    const ambiguous = html(`<base href="${basePdf}">` + report(anchor('#one') + anchor(second) + suffix));
    const calls = measureDetail(t, 'early conflict', ambiguous, () => {
      assert.throws(() => decodeEastmoneyReportDetail(detailRequest, ambiguous), reason);
    });
    assert.ok(calls <= 5, `the first conflict took ${calls} URL constructions`);
  }
});

test('Eastmoney resolves path and query references with bounded base lengths', t => {
  const deep = pdfRoot + 'folder/'.repeat(2048) + 'page';
  const misses = Array.from({ length: 2048 }, (_, i) => anchor('other' + i)).join('');
  const input = html(`<base href="${deep}">` + report(misses + anchor('../'.repeat(2048) + fileA)));
  measureDetail(t, 'deep base and short non-PDF references', input, () => {
    assert.equal(decodeEastmoneyReportDetail(detailRequest, input).pdfUrl, pdfA);
  });

  for (const base of [pdfA + '?token=one#old', pdfRoot + 'x/y/file', 'http://example.test/x', 'https://user:pass@pdf.dfcfw.com/pdf/file']) {
    for (const href of ['', '#page=2', '?q=1#p', '//pdf.dfcfw.com/pdf/' + fileB, '../' + fileB, fileB + ' #p',
      '/pdf/' + fileB + '?q=1  #p', '%2e%2e/' + fileB, 'https:#new', 'https:?' + fileB, 'https:http://invalid.test',
      '\\pdf\\' + fileA, '\\\\pdf.dfcfw.com\\pdf\\' + fileA]) {
      const expected = URL.parse(href, base);
      if (expected) expected.hash = '';
      const doc = report(anchor(href)) + `<base href="${base}">`;
      if (expected?.origin === 'https://pdf.dfcfw.com' && !expected.username && !expected.password && [fileA, fileB].some(file => expected.pathname === '/pdf/' + file)) {
        assert.equal(detailPdf(doc), expected.href, href);
      } else {
        assert.throws(() => detailPdf(doc), noPdf, href);
      }
    }
  }
});

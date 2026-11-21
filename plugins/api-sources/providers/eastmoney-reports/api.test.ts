import assert from 'node:assert/strict';
import test from 'node:test';
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
      `<p><em>相关</em>${title.slice(2)}</p><ul><li>${otherLink}</li></ul>`,
      `<p><em>相关</em>${title.slice(2)}：${otherLink}</p>`,
      `<div>正文<span> </span><em>相关</em>${title.slice(2)}：${otherLink}</div>`,
      `<p>正文<span> </span><em>相关</em>${title.slice(2)}：</p><ul><li>${otherLink}</li></ul>`]) {
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
    `<div id="zwinfo">相关阅读：${otherLink}<h2>本研报附件</h2>${mainLink}推荐阅读：<a download href="https://pdf.dfcfw.com/pdf/H3_AP202601010003_1.pdf">下载</a></div>`,
    `<div id="zwinfo"><span class="title">相关阅读</span>参见正文说明。${mainLink}</div>`,
    `<div id="zwinfo"><p>1. 相关阅读：参见正文说明。${mainLink}</p></div>`,
    `<div id="zwinfo"><p>1. 相关阅读：参见正文说明.${mainLink}</p></div>`,
    `<div id="zwinfo"><p><em>相关阅读</em> 参见正文说明。${mainLink}</p></div>`,
    `<div id="zwinfo"><p><em>相关阅读</em><span><br>参见正文说明。${mainLink}</span></p></div>`,
    `<div id="zwinfo"><p><em>相关阅读</em> 参见正文说明。</p>${mainLink}</div>`,
    `<div id="zwinfo"><p><em>相关阅读</em><br>参见正文说明。</p>${mainLink}</div>`,
    `<div id="zwinfo"><p>1. 相关阅读：参见正文说明。<br>${mainLink}</p></div>`,
    `<div id="zwinfo"><p><em>相关阅读</em><br>参见正文说明。</p></div><div class="report-download"><a href="${pdf}">下载原文</a></div>`,
    `<div id="zwinfo"><p>1. 相关阅读：<br>参见正文说明。</p></div><div class="report-download"><a href="${pdf}">下载原文</a></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<div><div><div><div><h2>本研报附件</h2>${mainLink}</div></div></div></div></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<section><h3>本研报附件</h3>${mainLink}</section></div>`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(wrapper)).pdfUrl, pdf);
  }
  const attestedBox = `<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a href="${pdf}">下载原文</a></div>`;
  const attestedScript = `<script>var zwinfo=${JSON.stringify({ encodeUrl: 'fixture', infoCode: 'AP202601010001' })};</script>`;
  for (const body of [
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读：</strong>1. 《行业展望》。${otherLink}</p></div>`,
    `<div id="zwinfo"><p>相关阅读：详见正文。下载地址见${mainLink}</p></div>`,
    `<div id="zwinfo"><figure><figcaption>相关阅读</figcaption>${otherLink}</figure>${mainLink}</div>`,
    `<div id="zwinfo">${mainLink}<p><strong>${' '.repeat(40)}相关阅读</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读</strong>量统计见${mainLink}。</p></div>`,
    `<div id="zwinfo">${mainLink}<a role="heading" aria-level="2">相关阅读</a>${otherLink}</div>`,
    `<div id="zwinfo">相关阅读：1. 某行业研报<div><p>下载说明</p><h2>本研报附件</h2>${mainLink}</div></div>`,
    `<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<div>${otherLink}<h2>本研报附件</h2>${mainLink}</div></div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<p><strong>相关阅读</strong></p><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><p>下载提示</p><h3>推荐阅读</h3><a href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<p><strong>相关阅读</strong></p><div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><p>下载提示</p><h3>推荐阅读</h3><a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${other}">推荐PDF</a></div></div>`,
    `<div id="zwinfo">${attestedScript}<cite class="related">相关阅读：${otherLink}</cite><a data-encode-url="fixture" data-info-code="AP202601010001" href="${pdf}">下载原文</a></div>`,
    `<div id="zwinfo"><p>${'<span>相关阅读：参见说明。</span>'.repeat(2000)}${mainLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p>【相关阅读】：1. 《行业展望》。${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<p><strong>相关阅读</strong>《行业展望》${otherLink}</p></div>`,
    `<div id="zwinfo">${mainLink}<h2>相关阅读</h2><ul><li><a class="report-title" download href="${other}">某行业研报</a></li></ul></div>`,
    `<div id="zwinfo">相关阅读：1. 行业展望<div>${otherLink}<h2>本研报附件</h2>${mainLink}</div></div>`,
    `<div id="zwinfo"><p>推荐阅读3.2节的完整论证。下载地址见${mainLink}</p></div>`,
    `<div id="zwinfo"><p>${' '.repeat(50000)}普通正文说明。</p>${mainLink}</div>`,
    `<div id="zwinfo">${'<div><p>普通正文说明。</p>'.repeat(300)}${mainLink}${'</div>'.repeat(300)}</div>`,
    `<div id="zwinfo">${attestedScript}${mainLink}<div class="report-download title" data-encode-url="fixture" data-info-code="AP202601010001">推荐阅读：<a class="report-download" data-encode-url="fixture" data-info-code="AP202601010001" href="${other}">推荐PDF</a></div></div>`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(body)).pdfUrl, pdf);
  }
  for (const numberedLead of [
    '<p>1. 相关阅读：参见正文说明。</p>',
    '<p>1. 相关阅读：<br>参见正文说明。</p>',
    '<p><strong>1. 相关阅读：</strong>参见正文说明。</p>',
    '<p>1. 相关阅读：参见正文说明。<br></p>',
    `<p><strong>相关阅读：</strong>1. 某行业研报 ${otherLink}</p>`,
    `<p><strong>相关阅读</strong></p>1. 某行业研报 ${otherLink}`,
  ]) {
    assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${attestedScript}${numberedLead}${attestedBox}</div>`)).pdfUrl, pdf);
    assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo">${numberedLead}</div>${attestedBox}${attestedScript}`)).pdfUrl, pdf);
  }
  for (const relOnly of [
    `<main id="zwinfo"><div>正文<span> </span><em>相关</em>阅读：${otherLink}</div></main>`,
    `<ul id="zwinfo"><li>正文<span> </span><em>相关</em>阅读：${otherLink}</li></ul>`,
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
    `<div id="zwinfo"><h2>相关阅读</h2><ul><li><a class="report-title" download href="${other}">某行业研报</a></li></ul></div>`,
    `<div id="zwinfo">相关阅读：1. 行业展望<div>${otherLink}<h2>本研报附件</h2></div></div>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong>1. 需求见底了吗？ ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>相关阅读</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo"><p><strong>${' '.repeat(40)}相关阅读</strong>1. 某行业研报 ${otherLink}</p></div>`,
    `<div id="zwinfo"><span class="title">相关阅读</span>1. 某行业研报 ${otherLink}</div>`,
    `<div id="zwinfo"><a role="heading" aria-level="2">相关阅读</a>${otherLink}</div>`,
    `<span id="zwinfo"><strong>相关阅读</strong>${otherLink}</span>`,
    `<article id="zwinfo"><p><strong>相关阅读</strong></p>1. 某行业研报 ${otherLink}</article>`,
    `<div id="zwinfo"><p><strong>相关阅读：</strong><span><br>某行业研报 </span>${otherLink}</p></div>`,
    `<div id="zwinfo"><details><summary>附录</summary><span>相关阅读：${otherLink}</span></details></div>`,
    `<div id="zwinfo"><figure><figcaption>附录</figcaption><span>相关阅读：${otherLink}</span></figure></div>`,
    `<div id="zwinfo"><figure><figcaption>相关阅读</figcaption>${otherLink}</figure></div>`,
    `<ul id="zwinfo"><li>相关阅读：1. 某行业研报<div>${otherLink}</div></li></ul>`,
  ]) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(relOnly)), noPdf);
  }
  const deepSpanOpen = '<span>'.repeat(4000), deepSpanClose = '</span>'.repeat(4000);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${deepSpanOpen}<em>相关阅读</em> 参见正文说明。${mainLink}${deepSpanClose}</p></div>`)).pdfUrl, pdf);
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${deepSpanOpen}相关阅读：1. 某行业研报 ${otherLink}${deepSpanClose}</p></div>`)), noPdf);
  const wideSiblingSpans = '<span></span>'.repeat(64);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${wideSiblingSpans}<em>相关阅读</em> 参见正文说明。${mainLink}</p></div>`)).pdfUrl, pdf);
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><p>${wideSiblingSpans}相关阅读：1. 某行业研报 ${otherLink}</p></div>`)), noPdf);
  for (const emptyLike of ['', 'plain text', '<!-- comment -->']) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(emptyLike)), noPdf);
  }
  assert.equal(decodeEastmoneyReportDetail(request, html(`<article id="zwinfo"><p><small>相关阅读量</small>是本研报分析指标。</p>${mainLink}</article>`)).pdfUrl, pdf);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<div><h2>本研报附件</h2>${mainLink}</div></div>`)).pdfUrl, pdf);
  const metadata = 'var zwinfo = {"infoCode":"AP202601010001"};', scriptPdf = (url: string) => `window.pdf="${url}";`;
  for (const declarations of [[metadata, scriptPdf(other)], [scriptPdf(other), metadata]]) {
    for (const separator of ['', '</script><script>'])
      assert.throws(() => decodeEastmoneyReportDetail(request, html('<script>' + declarations.join(separator) + '</script>')),
        invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  }
  assert.equal(decodeEastmoneyReportDetail(request, html(`<script>${metadata}${scriptPdf(pdf)}</script>`)).pdfUrl, pdf);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<h2>本研报附件</h2>${mainLink}</div>`)).pdfUrl, pdf);
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
  ]) {
    assert.throws(() => decodeEastmoneyReportDetail(request, html(rootWrapper)),
      invalidDetail('研报详情元数据与附件声明指向不同的 infoCode。'));
  }
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<div class="report-download" data-encode-url="fixture" data-info-code="AP202601010001"><a href="${other}">下载原文</a></div>${attestedScript}`)),
    invalidDetail('研报详情标识与附件标识不符。'));
  assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>var zwinfo={"infoCode":"AP202601010002","pdfUrl":"${pdf}"};</script>`)),
    invalidDetail('研报详情标识与附件标识不符。'));
});

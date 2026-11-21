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
    assert.throws(() => decodeEastmoneyReportDetail(request, html(body)), code('SOURCE_REPORT_RESPONSE_INVALID'));
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
      `<div><span>${title}：</span></div><ul><li>${otherLink}</li></ul>`]) {
      assert.equal(decodeEastmoneyReportDetail(request, html(`<article id="zwinfo">${mainLink}${section}</article>`)).pdfUrl, pdf);
      assert.throws(() => decodeEastmoneyReportDetail(request, html(`<article id="zwinfo">${section}</article>`)), code('SOURCE_REPORT_RESPONSE_INVALID'));
    }
  }
  const metadata = 'var zwinfo = {"infoCode":"AP202601010001"};', scriptPdf = (url: string) => `window.pdf="${url}";`;
  for (const declarations of [[metadata, scriptPdf(other)], [scriptPdf(other), metadata]]) {
    for (const separator of ['', '</script><script>'])
      assert.throws(() => decodeEastmoneyReportDetail(request, html('<script>' + declarations.join(separator) + '</script>')),
        code('SOURCE_REPORT_RESPONSE_INVALID'));
  }
  assert.equal(decodeEastmoneyReportDetail(request, html(`<script>${metadata}${scriptPdf(pdf)}</script>`)).pdfUrl, pdf);
  assert.equal(decodeEastmoneyReportDetail(request, html(`<div id="zwinfo"><h2>相关阅读</h2>${otherLink}<h2>本研报附件</h2>${mainLink}</div>`)).pdfUrl, pdf);
  for (const declaration of ['zwinfo.infoCode="AP202601010002";', 'log(); zwinfo.infoCode="AP202601010002";'])
    assert.throws(() => decodeEastmoneyReportDetail(request, html(`<script>${declaration}</script><script>${scriptPdf(pdf)}</script>`)),
      code('SOURCE_REPORT_RESPONSE_INVALID'));
  for (const body of [related, `<nav><a href="${pdf}">相关</a></nav>`, `<a href="${pdf}">相关阅读</a>`,
    `<article id="zwinfo"><section><h2>相关阅读</h2><a href="${pdf}">PDF</a></section></article>`,
    `<div data-encode-url="other"><a href="${pdf}">PDF</a></div>`,
    `<script>var related = {"pdfUrl":"${pdf}"};</script>`,
    `<script>var zwinfo={"infoCode":"AP202601010002","pdfUrl":"${pdf}"};</script>`])
    assert.throws(() => decodeEastmoneyReportDetail(request, html(body)), code('SOURCE_REPORT_RESPONSE_INVALID'));
});

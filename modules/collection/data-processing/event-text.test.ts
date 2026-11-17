import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { EVENT_TEXT_VERSION, projectEventText, readEventTextSelection, type EventTextSelection } from './event-text.js';
const source = '标题\n\n公司预计明年投产，仍须审批。\n', bytes = Buffer.from(source), quote = '公司预计明年投产，仍须审批。';
const selection = (): EventTextSelection => ({ version: EVENT_TEXT_VERSION, sourceSha256: wfdSha256(bytes),
  occurrence: { namespace: 'synthetic', publisherId: 'issuer', publicationId: 'notice-1', kind: 'original', upstreamPublicationId: null },
  reviewBasis: 'Synthetic explicit source selection, not an external fact.', excerpts: [{ start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, quote }] });
const records = (value: EventTextSelection) => JSON.parse(projectEventText(bytes, value).jsonBytes.toString());
test('event occurrences retain identical excerpts without claiming independent evidence or occurrence', () => {
  const original = selection(), repost = selection();
  repost.occurrence = { namespace: 'synthetic-news', publisherId: 'republisher', publicationId: 'repost-1', kind: 'repost', upstreamPublicationId: 'notice-1' };
  const a = records(original)[0], b = records(repost)[0];
  assert.equal(a.content_sha256, b.content_sha256);
  assert.notEqual(a.business_key, b.business_key);
  assert.notEqual(a.occurrence_id, b.occurrence_id);
  assert.deepEqual(records(original), records(selection()));
  assert.equal(a.assertion_kind, 'source_claim');
  assert.equal(b.independence_status, 'not_established');
  assert.equal(a.public_time_status, 'unknown');
  assert.equal(projectEventText(bytes, original).evidence.eventOccurrenceEstablished, false);
});
test('event evidence rejects altered bytes, mismatched quotes, overlaps, and clamped ranges', () => {
  assert.throws(() => projectEventText(Buffer.from(source + 'x'), selection()), /摘要不符/);
  const bad = selection(); bad.excerpts[0]!.quote = '公司已投产。';
  assert.throws(() => records(bad), /引用不一致/);
  const overlap = selection(); overlap.excerpts.push(overlap.excerpts[0]!);
  assert.throws(() => records(overlap), /重叠/);
  const clamped = selection(); clamped.excerpts = [{ start: 0, end: source.length + 10, quote: source }];
  assert.throws(() => records(clamped), /越界/);
});
test('event declaration keeps upstream unknown and rejects unmodeled factual authority', () => {
  const value = selection(); value.occurrence.kind = 'repost';
  assert.equal(records(value)[0].upstream_publication_id, null);
  assert.throws(() => readEventTextSelection({ ...selection(), verifiedFact: true }), /传播身份/);
});

test('explicit existing HTML text projection binds cross-node quotes and original DOM locations', () => {
  const html = Buffer.from('<html><body><article><p>公司<strong>预计</strong>明年投产。</p><script>已完成投产</script><p hidden>隐藏公告</p></article></body></html>');
  const projected = '公司预计明年投产。';
  const rule: EventTextSelection = { ...selection(), sourceSha256: wfdSha256(html),
    sourceView: { kind: 'html_static_text', rootSelector: 'article', textSha256: wfdSha256(projected) },
    excerpts: [{ start: 0, end: projected.length, quote: projected }] };
  const result = projectEventText(html, rule), row = JSON.parse(result.jsonBytes.toString())[0];
  assert.equal(row.text, projected); assert.equal(row.position_unit, 'html_static_text_utf16_code_units');
  assert.equal(row.source_sha256, wfdSha256(html)); assert.equal(row.public_time_status, 'unknown');
  assert.equal(result.evidence.sourceProjection!.positions[0]!.locations.length, 3);
  assert.equal(result.evidence.sourceProjection!.complete, false);
  assert.ok(result.evidence.sourceProjection!.reasons.includes('script-content-not-executed'));
  assert.throws(() => projectEventText(html, { ...rule, sourceView: { ...rule.sourceView!, textSha256: '0'.repeat(64) } }), /摘要/);
  assert.throws(() => projectEventText(html, { ...rule, sourceView: { ...rule.sourceView!, rootSelector: 'article,p' } }), /摘要|唯一/);
  assert.throws(() => projectEventText(html, { ...rule, sourceView: { ...rule.sourceView!, rootSelector: '[hidden]' } }), /唯一/);
  assert.throws(() => projectEventText(html, { ...rule, sourceView: { ...rule.sourceView!, rootSelector: 'script' } }), /唯一/);
  assert.throws(() => projectEventText(Buffer.from('<html><title>安全验证</title><body><article>公司预计明年投产。</article></body></html>'),
    { ...rule, sourceSha256: wfdSha256('<html><title>安全验证</title><body><article>公司预计明年投产。</article></body></html>') }), /验证页/);
});

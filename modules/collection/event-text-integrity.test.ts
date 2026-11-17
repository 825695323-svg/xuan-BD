import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { annotateCandidateTable, checkCandidateTables, cleanCandidateTable, parseTableSource, structureCandidateTable } from './candidate-pipeline.js';
import { EVENT_TEXT_VERSION } from './data-processing/event-text.js';
function parsed(quote = '  公司预计明年投产，尚须审批。  ') {
  const bytes = Buffer.from(quote);
  return parseTableSource(bytes, { materialId: 'synthetic_event', format: 'text', eventTextSelection: {
    version: EVENT_TEXT_VERSION, sourceSha256: wfdSha256(bytes),
    occurrence: { namespace: 'synthetic', publisherId: 'issuer', publicationId: 'notice', kind: 'original', upstreamPublicationId: null },
    reviewBasis: 'Synthetic source excerpts for processing integrity only.', excerpts: [{ start: 0, end: quote.length, quote }],
  } });
}
const rejected = (work: () => unknown) => assert.throws(work, (error: any) => error.code === 'EVENT_TEXT_REVIEW');
test('event excerpt integrity retains exact content and permits nonoverriding event annotations', () => {
  const structured = structureCandidateTable(parsed());
  const result = checkCandidateTables([annotateCandidateTable(structured, { event_type: 'production_start', state: 'valid_value' })]);
  assert.equal(result.rows[0]!.text, '  公司预计明年投产，尚须审批。  ');
  assert.equal(result.rows[0]!.event_type, 'production_start');
  assert.equal(result.rows[0]!.independence_status, 'not_established');
  const unchanged = structureCandidateTable(parsed('123'), { text: 'string' });
  assert.equal(checkCandidateTables([unchanged]).rows[0]!.text, '123');
});
test('event excerpt integrity rejects later trim and type conversion rather than retaining stale quote evidence', () => {
  rejected(() => checkCandidateTables([structureCandidateTable(cleanCandidateTable(parsed(), { trim: ['text'] }))]));
  rejected(() => checkCandidateTables([structureCandidateTable(parsed('123'), { text: 'safe_integer' })]));
});
test('event excerpt integrity rejects missing evidence, mutated identity, and annotation override', () => {
  const missing = structureCandidateTable(parsed()); delete missing.event_text_evidence;
  rejected(() => checkCandidateTables([missing]));
  const changed = structureCandidateTable(parsed()); changed.rows[0]![changed.columns.indexOf('publication_id')]!.value = 'another_notice';
  rejected(() => checkCandidateTables([changed]));
  rejected(() => checkCandidateTables([annotateCandidateTable(structureCandidateTable(parsed()), { text: '公司已投产。' })]));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcquisitionBinding, AcquisitionPage, AcquisitionRequest } from '../../contracts/source-acquisition.js';
import { acceptSourcePage, beginSourceAcquisition, reviewSourceAcquisition, sourceFailureDisposition,
  sourceReceiptReview, sourceRequestKey } from './source-acquisition.js';

// 全部为隔离合成参数，不是实际账号、交易日历、金融口径或供应商限额。
const request: AcquisitionRequest = { scopeId: 'TEST/MARKET', operationId: 'daily_bars', subjectId: 'TEST.OBJECT',
  start: '2026-01-01', end: '2026-01-03', adjustment: 'none' };
const binding: AcquisitionBinding = { providerId: 'fixture-provider', connectionId: 'fixture-connection', configurationDigest: 'a'.repeat(64) };
const original = (n: number) => ({ fileRefId: 'fixture-original-' + n, sha256: String(n).repeat(64) });
const first: AcquisitionPage = { cursor: null, nextCursor: 'test-page-2', rowCount: 1, keys: ['test-slot-1'], original: original(1) };
const second: AcquisitionPage = { cursor: 'test-page-2', nextCursor: null, rowCount: 1, keys: ['test-slot-2'], original: original(2) };
const coverage = { requestKey: sourceRequestKey(request), expectedKeys: ['test-slot-1', 'test-slot-2'], evidence: original(3) };
const begin = (maxPages = 3, maxRows = 10) => beginSourceAcquisition(request, binding, { maxPages, maxRows });
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

test('logical request identity excludes acquisition time and source implementation, not semantics', () => {
  const a = begin(), b = beginSourceAcquisition(request, { ...binding, providerId: 'fixture-backup' }, a.budget);
  assert.equal(a.requestKey, b.requestKey);
  assert.notEqual(a.requestKey, sourceRequestKey({ ...request, adjustment: 'qfq' }));
  assert.notEqual(a.requestKey, sourceRequestKey({ ...request, subjectId: 'TEST.OTHER' }));
  assert.equal(sourceReceiptReview(request, 0).outcome, 'undetermined');
  assert.equal(sourceReceiptReview(request, null).continuation, 'not_declared');
});

test('one page returns feedback, replay is idempotent, restart continues only its bound next page', () => {
  const start = begin(), page1 = acceptSourcePage(start, request, binding, first);
  assert.equal(start.pages.length, 0, 'Input checkpoint is never mutated');
  const partial = reviewSourceAcquisition(page1, coverage);
  assert.equal(partial.returnTo, 'agents');
  assert.equal(partial.continuation.state, 'available');
  assert.deepEqual(partial.coverage.missingKeys, ['test-slot-2']);
  assert.deepEqual(acceptSourcePage(page1, request, binding, { ...first, original: { ...first.original, fileRefId: 'reopened-ref' } }), page1);
  const restarted = JSON.parse(JSON.stringify(page1));
  const done = acceptSourcePage(restarted, request, binding, second), feedback = reviewSourceAcquisition(done, coverage);
  assert.equal(feedback.rowCount, 2);
  assert.equal(feedback.coverage.state, 'declared_scope_complete');
  assert.equal(feedback.publication, 'not_requested', 'Acquisition completeness is not WFD admission');
  assert.equal(feedback.continuation.state, 'finished');
});

test('wrong request, changed binding, modified replay and cursor cycles fail without dropping checkpoint', () => {
  const saved = acceptSourcePage(begin(), request, binding, first), before = JSON.stringify(saved);
  assert.throws(() => acceptSourcePage(saved, { ...request, end: '2026-02-01' }, binding, second), code('SOURCE_CONTINUATION_BINDING'));
  assert.throws(() => acceptSourcePage(saved, request, { ...binding, configurationDigest: 'b'.repeat(64) }, second), code('SOURCE_CONTINUATION_BINDING'));
  assert.throws(() => acceptSourcePage(saved, request, binding, { ...first, original: original(4) }), code('SOURCE_PAGE_CONFLICT'));
  assert.throws(() => acceptSourcePage(saved, request, binding, { ...second, cursor: 'foreign' }), code('SOURCE_CURSOR_MISMATCH'));
  assert.throws(() => acceptSourcePage(saved, request, binding, { ...second, nextCursor: 'test-page-2' }), code('SOURCE_CURSOR_CYCLE'));
  assert.equal(JSON.stringify(saved), before);
});

test('zero rows, unknown pagination and missing expectations never imply complete history', () => {
  const empty = acceptSourcePage(begin(), request, binding, { cursor: null, nextCursor: null, rowCount: 0, keys: [], original: original(1) });
  assert.equal(reviewSourceAcquisition(empty).outcome, 'undetermined');
  assert.equal(reviewSourceAcquisition(empty, coverage).coverage.state, 'incomplete');
  assert.equal(reviewSourceAcquisition(empty, { requestKey: sourceRequestKey(request), expectedKeys: [], evidence: original(3) }).outcome, 'confirmed_empty');
  const unknown = acceptSourcePage(begin(), request, binding, { ...first, nextCursor: undefined });
  assert.equal(reviewSourceAcquisition(unknown, coverage).continuation.state, 'unknown');
  assert.throws(() => acceptSourcePage(unknown, request, binding, second), code('SOURCE_CURSOR_MISMATCH'));
});

test('duplicates, out-of-scope rows and exhausted budgets are visible, never silently filtered', () => {
  const saved = acceptSourcePage(begin(), request, binding, first);
  const duplicate = acceptSourcePage(saved, request, binding, { ...second, keys: ['test-slot-1'] });
  assert.equal(reviewSourceAcquisition(duplicate, coverage).coverage.state, 'conflict');
  assert.equal(reviewSourceAcquisition(duplicate, coverage).rowCount, 2);
  const extra = acceptSourcePage(saved, request, binding, { ...second, keys: ['test-outside'] });
  assert.deepEqual(reviewSourceAcquisition(extra, coverage).coverage.unexpectedKeys, ['test-outside']);
  const bounded = acceptSourcePage(begin(1, 1), request, binding, first);
  assert.equal(reviewSourceAcquisition(bounded, coverage).continuation.state, 'budget_exhausted');
  assert.throws(() => acceptSourcePage(bounded, request, binding, second), code('SOURCE_BUDGET_EXCEEDED'));
  assert.throws(() => acceptSourcePage(begin(), request, binding, { ...first, rowCount: 2 }), code('SOURCE_PAGE_INVALID'));
});

test('failure classes preserve permission, history-window and readiness boundaries; no automatic retries', () => {
  for (const [error, outcome] of [['SOURCE_PERMISSION_DENIED','no_permission'], ['SOURCE_HISTORY_UNSUPPORTED','unsupported_history'],
    ['SOURCE_NOT_READY','not_ready'], ['SOURCE_RATE_LIMITED','not_ready'], ['SOURCE_HTTP_ERROR','failed']]) {
    assert.deepEqual(sourceFailureDisposition(error), { outcome, automaticRetry: false, returnTo: 'agents' });
  }
});


test('restored checkpoints revalidate evidence, row counts and budgets instead of trusting persisted completion', () => {
  const saved = acceptSourcePage(begin(), request, binding, first);
  const damaged = structuredClone(saved);
  damaged.pages[0]!.rowCount = 999;
  assert.throws(() => reviewSourceAcquisition(damaged, coverage), code('SOURCE_PAGE_INVALID'));
  const duplicated = structuredClone(saved);
  duplicated.pages.push(duplicated.pages[0]!);
  assert.throws(() => reviewSourceAcquisition(duplicated, coverage), code('SOURCE_CHECKPOINT_INVALID'));
  assert.throws(() => reviewSourceAcquisition({ ...saved, budget: { maxPages: 0, maxRows: 1 } }), code('SOURCE_BUDGET_INVALID'));
});


test('coverage and continuation cannot be qualified by unknown or unrelated request parameters', () => {
  assert.throws(() => beginSourceAcquisition({ ...request, subjectId: null }, binding, { maxPages: 3, maxRows: 10 }), code('SOURCE_REQUEST_INCOMPLETE'));
  const saved = acceptSourcePage(begin(), request, binding, first);
  assert.throws(() => reviewSourceAcquisition(saved, { ...coverage, requestKey: 'f'.repeat(64) }), code('SOURCE_COVERAGE_INVALID'));
});

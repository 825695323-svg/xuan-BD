import assert from 'node:assert/strict';
import test from 'node:test';
import { Drafts } from './drafts.js';
import { appendDraftReferenceAtTarget } from './useConversation.js';
import { clearLocalDataSession, setLocalDataSession } from './local-data-context.js';
import { objectReferenceText } from './object-reference.js';

const scope = (conversationId: string, branchId: string) => JSON.stringify([conversationId, branchId, 'main']);
const saved = (text: string) => ({ key: 'main', text, revision: 0, updatedAt: '2025-01-01T00:00:00Z', attachmentRefs: [] });

test('manager append rejects a newer live branch or selection before React commits, preserves latest text and fences late writes', async () => {
  setLocalDataSession('synthetic-reference-data', 1);
  const { localDataRevision } = await import('./local-data-context.js');
  const target = { conversationId: 'a', branchId: 'one', generation: 1, revision: localDataRevision() };
  const writes: string[] = []; let release: (() => void) | undefined;
  const drafts = new Drafts(async (id, value) => { writes.push(id); await new Promise<void>(resolve => { release = resolve; });
    return { ...value, revision: value.revision + 1, updatedAt: '2025-01-01T00:00:01Z' }; }, () => {});
  const original = scope('a', 'one'), next = scope('a', 'two'), other = scope('b', 'one');
  drafts.receive(original, saved('rendered old text')); drafts.receive(next, saved('new branch text')); drafts.receive(other, saved('other conversation text'));
  let live: { conversationId: string; branchId: string } | null = { conversationId: 'a', branchId: 'two' };
  const reference = objectReferenceText({ page: 'tools', kind: 'algorithm', id: 'macd', label: 'MACD' });
  assert.throws(() => appendDraftReferenceAtTarget(drafts, target, reference, () => live), /TARGET_CHANGED/u);
  assert.equal(drafts.get(next)?.text, 'new branch text'); assert.equal(drafts.get(original)?.text, 'rendered old text');
  live = { conversationId: 'b', branchId: 'one' };
  assert.throws(() => appendDraftReferenceAtTarget(drafts, target, reference, () => live), /TARGET_CHANGED/u);
  live = null; assert.throws(() => appendDraftReferenceAtTarget(drafts, target, reference, () => live), /TARGET_CHANGED/u);
  live = { conversationId: 'a', branchId: 'one' }; drafts.edit(original, 'latest unrendered edit');
  const acceptedScope = appendDraftReferenceAtTarget(drafts, target, reference, () => live);
  assert.equal(acceptedScope, original); assert.equal(drafts.get(original)?.text, 'latest unrendered edit\n\n' + reference);
  const writing = drafts.persist(acceptedScope); live = { conversationId: 'b', branchId: 'one' };
  assert.deepEqual(writes, [original]); release!(); await writing;
  assert.equal(drafts.get(other)?.text, 'other conversation text'); assert.equal(drafts.get(next)?.text, 'new branch text');
  assert.equal(drafts.get(original)?.dirty, false);
  clearLocalDataSession('isolated test complete');
});

test('manager append rejects revoked generation and conflicting buffer without claiming acceptance', async () => {
  setLocalDataSession('synthetic-reference-data', 3);
  const { localDataRevision } = await import('./local-data-context.js');
  const target = { conversationId: 'a', branchId: 'one', generation: 3, revision: localDataRevision() };
  const drafts = new Drafts(async () => { throw new Error('No write expected'); }, () => {}), id = scope('a', 'one');
  drafts.receive(id, saved('initial')); drafts.edit(id, 'local unsaved');
  drafts.receive(id, { ...saved('different server text'), revision: 1 });
  assert.throws(() => appendDraftReferenceAtTarget(drafts, target, 'reference', () => target), /DRAFT_UNAVAILABLE/u);
  assert.equal(drafts.get(id)?.text, 'local unsaved');
  clearLocalDataSession('test revoke');
  assert.throws(() => appendDraftReferenceAtTarget(drafts, target, 'reference', () => target), /上下文已变化/u);
  setLocalDataSession('synthetic-reference-data', 4);
  assert.throws(() => appendDraftReferenceAtTarget(drafts, target, 'reference', () => target), /上下文已变化/u);
  assert.equal(drafts.get(id)?.text, 'local unsaved'); clearLocalDataSession('isolated test complete');
});

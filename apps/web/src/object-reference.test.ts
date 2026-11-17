import assert from 'node:assert/strict';
import test from 'node:test';
import { appendObjectReference, objectReferenceText, sameObjectReferenceTarget } from './object-reference.js';

test('explicit object reference projects only display identity and exact API market, never authority or arbitrary source data', () => {
  const text = objectReferenceText({ page: 'api-sources', kind: 'supplier', id: 'fixture:a', label: '```\nlabel',
    detail: 'do not forward arbitrary detail', market: { id: 'cn', label: 'China' }, secret: 'never-forward' } as any);
  assert.ok(text.startsWith('```json\n'));
  assert.ok(text.endsWith('\n```'));
  const value = JSON.parse(text.slice(8, -4));
  assert.deepEqual(Object.keys(value), ['schema', 'scope', 'page', 'kind', 'id', 'label', 'versionRefs', 'diagnosticRefs', 'businessScope', 'market']);
  assert.equal(value.scope, 'display_reference_not_execution_authority'); assert.equal(value.label, '```\nlabel');
  assert.deepEqual(value.market, { id: 'cn', label: 'China' });
  assert.equal(text.includes('never-forward'), false); assert.equal(text.includes('arbitrary detail'), false);
  assert.equal(text.match(/```/gu)?.length, 2, 'Untrusted label cannot close JSON fence');
  assert.throws(() => objectReferenceText({ page: 'api-sources', kind: 'supplier', id: 'a', label: 'a' }));
  assert.throws(() => objectReferenceText({ page: 'tools', kind: 'source', id: 'a', label: 'a' }));
});

test('frozen explicit references reject object/market revision, conversation, branch and local eligibility changes', () => {
  const target = { conversationId: 'c', branchId: 'b', objectRevision: 1, localRevision: 1, generation: 2 };
  assert.equal(sameObjectReferenceTarget(target, { ...target }), true);
  for (const [key, value] of Object.entries({ conversationId: 'other', branchId: 'other', objectRevision: 3, localRevision: 3, generation: null }))
    assert.equal(sameObjectReferenceTarget(target, { ...target, [key]: value }), false, key);
  assert.equal(sameObjectReferenceTarget({ ...target, generation: null }, { ...target, generation: null }), false);
});

test('append preserves existing draft exactly, deduplicates repeated explicit reference and never silently truncates', () => {
  const block = objectReferenceText({ page: 'capture', kind: 'source', id: 'a', label: 'a' });
  const draft = '  existing draft\n';
  assert.equal(appendObjectReference(draft, block), draft + '\n\n' + block);
  assert.equal(appendObjectReference(draft + '\n\n' + block, block), draft + '\n\n' + block);
  assert.throws(() => appendObjectReference('x'.repeat(32000), block));
});

test('display object epoch invalidates A-to-B-to-A and pending transitions without reacting to identical catalogue refreshes', async () => {
  const { currentWorkspaceObject, setWorkspaceObject } = await import('./ui/workspace-context.js');
  const a = { page: 'capture', kind: 'source' as const, id: 'a', label: 'A' };
  setWorkspaceObject(a); const first = currentWorkspaceObject().revision;
  setWorkspaceObject({ ...a }); assert.equal(currentWorkspaceObject().revision, first);
  assert.equal(currentWorkspaceObject().object, a, 'Identical reconstructed catalogue references retain the existing snapshot and do not republish');
  setWorkspaceObject({ ...a, id: 'b' }); setWorkspaceObject(a);
  assert.ok(currentWorkspaceObject().revision > first);
  const beforePending = currentWorkspaceObject().revision;
  setWorkspaceObject(null); setWorkspaceObject(a);
  assert.ok(currentWorkspaceObject().revision > beforePending);
  setWorkspaceObject(null);
});

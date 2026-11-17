import type { WorkspaceObjectRef } from './ui/workspace-context';

/** Display-only identifier whitelist. Never conveys credential, execution or publication authority. */
export function objectReferenceText(value: WorkspaceObjectRef): string {
  const kinds: Record<string, readonly string[]> = { capture: ['source'], 'api-sources': ['supplier', 'market'], tools: ['algorithm'] };
  const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
  if (!kinds[value.page]?.includes(value.kind) || !text(value.id, 512) || !text(value.label, 1000)) throw new Error('OBJECT_REFERENCE_INVALID');
  if (value.page === 'api-sources' && (!value.market || !text(value.market.id, 512) || !text(value.market.label, 1000))) throw new Error('OBJECT_REFERENCE_INVALID');
  const reference = { schema: 'bd.ui-object-reference/1', scope: 'display_reference_not_execution_authority',
    page: value.page, kind: value.kind, id: value.id, label: value.label,
    ...(value.page === 'api-sources' ? { market: { id: value.market!.id, label: value.market!.label } } : {}) };
  // Backticks in catalogue labels cannot terminate the inert JSON fence.
  return '```json\n' + JSON.stringify(reference, null, 2).replace(/`/gu, '\\u0060') + '\n```';
}

export interface ObjectReferenceTarget { conversationId: string; branchId: string; objectRevision: number; localRevision: number; generation: number | null }
export function sameObjectReferenceTarget(a: ObjectReferenceTarget, b: ObjectReferenceTarget): boolean {
  return a.conversationId === b.conversationId && a.branchId === b.branchId && a.objectRevision === b.objectRevision
    && a.localRevision === b.localRevision && a.generation !== null && a.generation === b.generation;
}
export function appendObjectReference(draft: string, text: string): string {
  const value = draft.includes(text) ? draft : [draft, text].filter(Boolean).join('\n\n');
  if (value.length > 32000) throw new Error('OBJECT_REFERENCE_DRAFT_TOO_LONG');
  return value;
}

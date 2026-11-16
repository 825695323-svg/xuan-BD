/** Publication membership is independent of parser stages and provider versions. */
export type R1PublicationGroups = Record<string, string[]>;
export interface R1SetPrepareInput {
  kind: 'publication_set'; requestId: string; planId: string; setId: string;
}
export interface R1SetMemberView {
  outputId: string; outputKey: string; rowCount: number; previewRows: Record<string, unknown>[];
  state: 'not_submitted' | 'pending_receipt' | 'published' | 'failed';
  snapshotId: string | null; productId: string | null; errorCodes: string[];
}
export interface R1PublicationSetView {
  setId: string; atomicity: 'declared_set'; duplicatePolicy: 'reject_member_conflict'; members: R1SetMemberView[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stableId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/u.test(v);
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'R1_PUBLICATION_SET' }); }
/** Disjoint declared sets have explicit membership; absence keeps legacy plans ungrouped. */
export function readPublicationGroups(value: unknown, outputIds: readonly string[]): R1PublicationGroups {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 16) fail('发布集合必须是有界的明确成员登记。');
  const result: R1PublicationGroups = Object.create(null), used = new Set<string>();
  for (const key of Object.keys(value).sort()) {
    const members = value[key];
    if (!stableId(key) || !Array.isArray(members) || members.length < 2 || members.length > 16
      || members.some(id => typeof id !== 'string' || !outputIds.includes(id))
      || new Set(members).size !== members.length || members.some(id => used.has(id)))
      fail('发布集合须包含至少两个已声明输出，不能缺员、重员或交叠。');
    result[key] = [...members].sort();
    for (const id of members) used.add(id);
  }
  return result;
}

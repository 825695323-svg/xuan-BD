import { request, RequestError } from './api';
import { localDataGeneration, localDataRevision } from './local-data-context';

const counts = ['bytes', 'walBytes', 'segments', 'documents', 'indexVersions', 'textBytes', 'ftsTokenBytes', 'ftsIndexBytes', 'indexMembershipRows', 'sharedIndexVersions'] as const;
type Count = typeof counts[number];
export type RetrievalStorageView = Record<Count, number> & { oldestParsedAt: number | null; newestParsedAt: number | null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function invalid(): never { throw new RequestError('RETRIEVAL_STORAGE_INVALID', null, 'RETRIEVAL_STORAGE_INVALID'); }
export function storageView(raw: unknown): RetrievalStorageView {
  if (!object(raw) || raw.schema !== 'bd.retrieval-storage/1' || raw.basis !== 'sqlite_file_lengths_and_logical_contents'
    || !object(raw.database) || !object(raw.policy) || raw.policy.scope !== 'bd-retrieval-workspace'
    || raw.policy.automaticDeletion !== false || !object(raw.policy.rebuildable)
    || raw.policy.rebuildable.segments !== false || raw.policy.rebuildable.index !== true) invalid();
  const db = raw.database;
  if (counts.some(key => !count(db[key])) || ['oldestParsedAt', 'newestParsedAt'].some(key => db[key] !== null && (!count(db[key]) || Number(db[key]) > 8_640_000_000_000_000))
    || (db.oldestParsedAt === null) !== (db.newestParsedAt === null)
    || db.oldestParsedAt !== null && Number(db.oldestParsedAt) > Number(db.newestParsedAt)) invalid();
  return { ...Object.fromEntries(counts.map(key => [key, db[key]])), oldestParsedAt: db.oldestParsedAt, newestParsedAt: db.newestParsedAt } as RetrievalStorageView;
}
export async function readRetrievalStorage(): Promise<RetrievalStorageView> {
  const generation = localDataGeneration(), revision = localDataRevision();
  const value = storageView(await request('/api/bd/retrieval/storage'));
  if (generation !== localDataGeneration() || revision !== localDataRevision())
    throw new RequestError('RETRIEVAL_STORAGE_SCOPE_CHANGED', null, 'RETRIEVAL_STORAGE_SCOPE_CHANGED');
  return value;
}

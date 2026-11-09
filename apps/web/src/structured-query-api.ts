import type { R1ContextRead, R1ContextReadInput } from '../../../contracts/r1-contracts';
import { request, RequestError } from './api';

export type QueryRecord = Record<string, unknown>;
export const queryObject = (value: unknown): QueryRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as QueryRecord : {};
function filterResult(value: unknown): QueryRecord {
  const result = queryObject(value), page = queryObject(result.page);
  if (result.protocol_version !== 'wfd.filter-objects/1.4-product1' || !Array.isArray(result.objects)
    || !Array.isArray(result.indeterminate) || !Array.isArray(result.gaps) || typeof result.query_hash !== 'string'
    || typeof page.has_more !== 'boolean' || typeof page.result_exhausted !== 'boolean'
    || page.has_more && typeof page.next_cursor !== 'string') throw new RequestError('结构化筛选的固定身份或分页无法核对。');
  return result;
}
export const structuredQueryApi = {
  context: async (input: R1ContextReadInput): Promise<R1ContextRead> => {
    const value = queryObject(await request('/api/bd/r1/query/context', 'POST', input)), result = queryObject(value.result), page = queryObject(result.page);
    if (value.operation !== input.operation || value.snapshotId !== input.snapshotId || value.datasetId !== input.datasetId
      || value.historyMode !== 'snapshot_contents' || queryObject(value.connection).profile !== 'data_only'
      || result.operation !== input.operation || result.snapshot_id !== input.snapshotId || result.dataset_id !== input.datasetId
      || !Array.isArray(result.gaps) || !Array.isArray(input.operation === 'read_relation_graph' ? result.edges : result.rows)
      || typeof page.has_more !== 'boolean' || page.has_more && typeof page.next_cursor !== 'string') throw new RequestError('上下文读取的固定身份或分页无法核对。');
    return value as unknown as R1ContextRead;
  },
  filter: async (input: QueryRecord) => filterResult(await request('/api/bd/r1/query/filter', 'POST', input)),
  joint: async (input: QueryRecord) => {
    const value = queryObject(await request('/api/bd/retrieval/joint', 'POST', input));
    if (value.schema !== 'bd.structured-document-retrieval/1' || !Array.isArray(value.objects)
      || !Array.isArray(value.gaps) || !value.qualification) throw new RequestError('联合检索的身份、资格或文档引用无法核对。');
    filterResult(value.structured);
    return value;
  },
  indexes: async (): Promise<Array<{ index_version: string; built_at: number }>> => {
    const response = queryObject(await request('/api/bd/retrieval/index-versions'));
    if (!Array.isArray(response.items) || response.items.some(item => typeof queryObject(item).index_version !== 'string'
      || typeof queryObject(item).built_at !== 'number')) throw new RequestError('已登记文档索引无法核对。');
    return (response.items as Array<{ index_version: string; built_at: number }>).sort((a, b) => b.built_at - a.built_at);
  },
};

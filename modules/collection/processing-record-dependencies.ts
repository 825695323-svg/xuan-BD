import { canonicalWfdJson, isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { ParsedCandidateTable } from './candidate-pipeline.js';

export interface ParsedRecordDependency {
  parsedBusinessKey: string;
  sourceRecordRef: { snapshot_id: string; product_id: string; logical_key: string; revision_id: string };
}
const fixed = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f]/u.test(value) && !/^(latest|current)$/iu.test(value);
function record(value: unknown): ParsedRecordDependency['sourceRecordRef'] | null {
  if (!isWfdRecord(value) || !['snapshot_id', 'product_id', 'logical_key', 'revision_id'].every(key => fixed(value[key]))) return null;
  return { snapshot_id: String(value.snapshot_id), product_id: String(value.product_id),
    logical_key: String(value.logical_key), revision_id: String(value.revision_id) };
}
/** Only exact references persisted by the fixed reader, never concept/time-based inferred links. */
export function parsedRecordDependencies(parsed: ParsedCandidateTable, calculation: unknown): ParsedRecordDependency[] | null {
  const evidence = parsed.financial_evidence;
  if (parsed.kind !== 'parsed-table' || parsed.format !== 'financial-fixed' || parsed.adapter?.id !== 'bd-financial-fixed'
    || !isWfdRecord(evidence) || evidence.version !== 'bd-financial-fixed/1' || evidence.operation !== 'standardize'
    || !fixed(evidence.mappingVersion) || !isWfdRecord(calculation) || !Array.isArray(calculation.inputs)
    || !Array.isArray(evidence.inputs) || !Array.isArray(evidence.lineage)
    || evidence.inputs.length !== calculation.inputs.length || parsed.selection || parsed.sourceProjection) return null;
  const allowed = new Set<string>();
  for (let i = 0; i < evidence.inputs.length; i++) {
    const input = evidence.inputs[i], requested = calculation.inputs[i];
    if (!isWfdRecord(input) || !isWfdRecord(requested) || input.snapshotId !== requested.snapshotId || input.productId !== requested.productId
      || !Array.isArray(input.businessKeys) || !Array.isArray(requested.businessKeys)
      || canonicalWfdJson(input.businessKeys) !== canonicalWfdJson(requested.businessKeys)
      || !Array.isArray(input.recordVersions)
      || input.selectedRows !== requested.businessKeys.length || input.recordVersions.length !== requested.businessKeys.length) return null;
    const seen = new Set<string>();
    for (const raw of input.recordVersions) {
      const ref = record(raw);
      if (!ref || ref.snapshot_id !== requested.snapshotId || ref.product_id !== requested.productId
        || !requested.businessKeys.includes(ref.logical_key) || seen.has(ref.logical_key)) return null;
      seen.add(ref.logical_key); allowed.add(canonicalWfdJson(ref));
    }
  }
  if (!Array.isArray(parsed.source_columns) || !Array.isArray(parsed.rows) || !parsed.rows.every(Array.isArray)) return null;
  const keyColumn = parsed.source_columns.indexOf('business_key');
  if (keyColumn < 0 || parsed.total_rows !== parsed.rows.length || evidence.outputRows !== parsed.rows.length
    || evidence.lineage.length !== parsed.rows.length) return null;
  const actualKeys = new Set(parsed.rows.map(row => row[keyColumn]?.original));
  if (actualKeys.size !== parsed.rows.length) return null;
  const result: ParsedRecordDependency[] = [];
  for (const edge of evidence.lineage) {
    if (!isWfdRecord(edge) || !fixed(edge.businessKey) || !actualKeys.delete(edge.businessKey) || !isWfdRecord(edge.source)) return null;
    const ref = record(edge.source.record);
    if (!ref || edge.source.snapshot !== ref.snapshot_id || edge.source.product !== ref.product_id
      || edge.source.mapping !== evidence.mappingVersion || !allowed.has(canonicalWfdJson(ref))) return null;
    result.push({ parsedBusinessKey: edge.businessKey, sourceRecordRef: ref });
  }
  return result;
}

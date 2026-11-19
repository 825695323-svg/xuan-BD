import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import type { ParsedCandidateTable } from './candidate-pipeline.js';
import type { ProcessingPlanService } from './processing-plan.js';
import { parsedRecordDependencies } from './processing-record-dependencies.js';
import { checkR1MappedRows } from './r1-event.js';

/** Narrow unchanged standardize rows only. Never infer a join from matching business keys. */
export function fixedRowConsumption(processing: ProcessingPlanService, planId: string, outputId: string,
  identity: R1ConnectionIdentity, expected: WfdRecord[]) {
  const unknown = (reason: string) => ({ status: 'unknown' as const, reason, edges: [] as { source: WfdRecord; outputKey: string }[] });
  const candidate = processing.candidateOutput(planId, outputId), plan = processing.get(planId);
  const steps = plan.steps.filter(s => s.outputId === outputId);
  if (steps.some(s => !['parse', 'structure', 'annotate', 'check'].includes(s.kind) || s.state !== 'succeeded')
    || steps.filter(s => s.kind === 'parse').length !== 1 || steps.filter(s => s.kind === 'structure').length !== 1
    || steps.filter(s => s.kind === 'check').length !== 1 || steps.filter(s => s.kind === 'annotate').length > 1)
    return unknown('unsupported_or_incomplete_stages');
  const parse = steps.find(s => s.kind === 'parse')!, params = parse.parameters;
  const ancestry = new Set<string>();
  const visit = (id: string, path = new Set<string>()): boolean => {
    if (path.has(id)) return false;
    const step = steps.find(s => s.stepId === id);
    if (!step) return false;
    ancestry.add(id);
    return step.dependsOn.every(parent => visit(parent, new Set([...path, id])));
  };
  if (!visit(steps.find(s => s.kind === 'check')!.stepId) || ancestry.size !== steps.length)
    return unknown('disconnected_or_cyclic_stage_chain');
  if (params.format !== 'financial-fixed' || params.selection || params.sourceProjection || params.sourceAdapter)
    return unknown('not_one_to_one_standardize');
  const artifact = processing.artifact(planId, parse.stepId);
  if (wfdSha256(artifact.bytes) !== parse.outputDigest) return unknown('parse_digest_mismatch');
  const parsed = JSON.parse(artifact.bytes.toString('utf8')) as ParsedCandidateTable;
  const edges = parsedRecordDependencies(parsed, params.financialCalculation);
  const material = candidate.materials.find(m => m.materialId === params.materialId);
  if (!edges || !material || material.sha256 !== parsed.source_sha256) return unknown('parse_lineage_unverified');
  const readIdentity = Object.fromEntries(['connectionId', 'profile', 'mode', 'runtimeIdentity', 'callerId', 'namespace']
    .map(key => [key, identity[key as keyof R1ConnectionIdentity]]));
  if (params.financialReaderBinding !== wfdSha256(canonicalWfdJson(identity))
    || canonicalWfdJson(parsed.financial_evidence?.connection ?? null) !== canonicalWfdJson(readIdentity))
    return unknown('input_instance_not_verified');
  // Reject remapping, trimming, selections and any value conversion, even if the output key happens to agree.
  if (canonicalWfdJson(parsed.columns) !== canonicalWfdJson(parsed.source_columns)
    || parsed.trim.length || parsed.emptyToNull.length || parsed.selection || parsed.sourceProjection
    || parsed.rows.length > 128 || !parsed.rows.length) return unknown('unsupported_parse_transform');
  const annotations = steps.find(s => s.kind === 'annotate');
  const constants = annotations ? parsed.annotations : {};
  if (Object.keys(constants).some(k => parsed.columns.includes(k))) return unknown('overlapping_constants');
  const reconstructed: WfdRecord[] = [];
  for (const cells of parsed.rows) {
    if (cells.length !== parsed.columns.length || cells.some(c => c.original !== c.value || c.conversion || c.projection))
      return unknown('parse_value_changed');
    reconstructed.push({ ...Object.fromEntries(parsed.columns.map((name, i) => [name, cells[i]!.original])), ...constants });
  }
  const final = processing.outputArtifact(planId, outputId);
  if (wfdSha256(final.bytes) !== candidate.ref.sha256) return unknown('final_digest_mismatch');
  const finalValue: unknown = JSON.parse(final.bytes.toString('utf8'));
  if (!isWfdRecord(finalValue) || canonicalWfdJson(finalValue.rows) !== canonicalWfdJson(reconstructed))
    return unknown('final_rows_not_unchanged_parse_rows');
  const declaration = candidate.target?.declaration;
  if (!isWfdRecord(declaration) || !isWfdRecord(declaration.mapping) || declaration.mapping.kind !== 'tabular_rows'
    || declaration.mapping.businessKey !== 'business_key') return unknown('unsupported_frozen_mapping');
  const checked = checkR1MappedRows(reconstructed, declaration);
  if (checked.quality !== 'pass' || canonicalWfdJson(checked.rows) !== canonicalWfdJson(expected)
    || expected.length !== edges.length) return unknown('frozen_payload_not_actual_mapped_rows');
  const keys = expected.map(r => r.business_key);
  if (new Set(keys).size !== keys.length || edges.some(e => !keys.includes(e.parsedBusinessKey)))
    return unknown('not_unique_complete_row_mapping');
  return { status: 'verified' as const, reason: null,
    edges: edges.map(e => ({ source: e.sourceRecordRef as WfdRecord, outputKey: e.parsedBusinessKey })) };
}

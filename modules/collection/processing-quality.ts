import type { ProcessingQuality, ProcessingQualityIssue, ProcessingQualityArtifact } from '../../contracts/processing-quality.js';

interface StepIdentity { stepId: string; outputId: string | null; dependsOn: string[] }
interface SemanticEvidence {
  quality: string; gaps: string[]; ruleVersion?: string; error?: { code: string; message: string };
}
interface QualityStep extends StepIdentity {
  outputId: string;
  state: string; applicability?: string; gaps: string[];
  output: ProcessingQualityArtifact['artifact'] | null; outputDigest: string | null;
  error: Record<string, unknown> | null;
  semantic?: SemanticEvidence | null;
}
interface QualityOutput {
  outputId: string; materialIds: string[]; state: string; routingState: string;
  gaps: string[]; semanticGaps: string[]; rejectReason: string | null; semantic?: SemanticEvidence | null;
}
export interface ProcessingQualityInput {
  steps: QualityStep[];
  outputs: QualityOutput[];
  /** 规格只用于保留已缺失记录的依赖身份，不合成运行成功状态。 */
  expectedSteps?: { stepId: string; outputId?: string; dependsOn?: string[] }[];
  missingSteps: string[];
  missingOutputs: string[];
  integrity: { stepId: string; present: boolean }[];
}

/** 仅沿显式依赖传播；同一材料、相同模块名或相邻输出不产生隐式依赖。 */
export function affectedProcessingSteps(steps: readonly StepIdentity[], seeds: readonly string[]): string[] {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) if (!affected.has(step.stepId) && step.dependsOn.some(id => affected.has(id))) {
      affected.add(step.stepId); changed = true;
    }
  }
  return steps.filter(step => affected.has(step.stepId)).map(step => step.stepId);
}

/** 不解析错误文字中的数字；只有既有结构化位置可以称为已知位置。 */
function location(error: Record<string, unknown> | null): ProcessingQualityIssue['location'] {
  const value = error?.location;
  const supplied = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const row = supplied?.row, column = supplied?.column;
  return { row: typeof row === 'number' && Number.isSafeInteger(row) && row >= 0 ? row : null,
    column: typeof column === 'string' && column.length > 0 ? column
      : typeof column === 'number' && Number.isSafeInteger(column) && column >= 0 ? column : null };
}

export function processingQuality(input: ProcessingQualityInput): ProcessingQuality {
  const issues: ProcessingQualityIssue[] = [];
  const stepsById = new Map(input.steps.map(step => [step.stepId, step]));
  const identities = new Map<string, StepIdentity>((input.expectedSteps ?? []).map(step => [step.stepId,
    { stepId: step.stepId, outputId: step.outputId ?? null, dependsOn: step.dependsOn ?? [] }]));
  for (const step of input.steps) identities.set(step.stepId, step);
  const graph = [...identities.values()];
  const outputs = new Map(input.outputs.map(output => [output.outputId, output]));
  const integrity = new Map(input.integrity.map(item => [item.stepId, item.present]));
  const seeds = new Set<string>();
  const missing = new Set(input.missingSteps);
  const add = (kind: ProcessingQualityIssue['kind'], stepId: string | null, outputId: string | null,
    reason: string, next: ProcessingQualityIssue['next'], ruleCode: string | null = null,
    error: Record<string, unknown> | null = null) => {
    issues.push({ kind, stepId, outputId, materialIds: [...(outputId ? outputs.get(outputId)?.materialIds ?? [] : [])],
      location: location(error), ruleCode, reason, disposition: 'unresolved', next });
  };
  for (const step of graph) {
    if (!stepsById.has(step.stepId)) missing.add(step.stepId);
    for (const dependency of step.dependsOn) if (!stepsById.has(dependency)) missing.add(dependency);
  }
  for (const stepId of missing) {
    seeds.add(stepId);
    add('artifact_or_record_missing', stepId, identities.get(stepId)?.outputId ?? null,
      '计划依赖的步骤记录缺失，不能据此推断已完成。', 'repair_record', 'PROCESSING_STEP_RECORD_MISSING');
  }
  for (const outputId of input.missingOutputs) add('artifact_or_record_missing', null, outputId,
    '输出记录缺失；应核查原记录，不据此重复加工全部原件。', 'repair_record', 'PROCESSING_OUTPUT_RECORD_MISSING');

  for (const step of input.steps) {
    if (step.state === 'succeeded' && step.dependsOn.some(id => stepsById.get(id)?.state !== 'succeeded')) {
      seeds.add(step.stepId);
      add('dependency_blocked', step.stepId, step.outputId,
        '步骤成功记录与其未完成或缺失的依赖记录不一致；应先核查原记录。', 'repair_record', 'PROCESSING_DEPENDENCY_STATE');
    }
    if (step.state === 'failed') {
      seeds.add(step.stepId);
      const kind = step.error?.code === 'PROCESSING_DEPENDENCY' ? 'dependency_blocked'
        : step.error?.code === 'PROCESSING_ARTIFACT_CHANGED' ? 'artifact_or_record_missing' : 'execution_failure';
      add(kind, step.stepId, step.outputId,
        typeof step.error?.message === 'string' ? step.error.message : '步骤执行失败，原记录未提供具体原因。',
        'revise_affected_steps', typeof step.error?.code === 'string' ? step.error.code : null, step.error);
    }
    if (step.state === 'succeeded' && (!step.output || !step.outputDigest || step.output.sha256 !== step.outputDigest
      || integrity.get(step.stepId) === false)) {
      seeds.add(step.stepId);
      add('artifact_or_record_missing', step.stepId, step.outputId,
        '成功记录缺少一致、可用的产物引用或产物完整性检查未通过。', 'revise_affected_steps', 'PROCESSING_ARTIFACT_UNAVAILABLE');
    }
    if (step.semantic?.quality === 'fail') {
      seeds.add(step.stepId);
      add('semantic_failure', step.stepId, step.outputId,
        step.semantic.error?.message ?? (step.semantic.gaps.join('；') || '已记录的语义核对未通过。'),
        'revise_affected_steps', step.semantic.error?.code ?? step.semantic.ruleVersion ?? null);
    }
    if (step.applicability === 'unknown' || (step.state === 'blocked' && step.dependsOn.length === 0)
      || step.semantic?.quality === 'pending' || step.semantic?.quality === 'indeterminate') {
      add('needs_evidence', step.stepId, step.outputId,
        [...new Set([...step.gaps, ...(step.semantic?.gaps ?? [])])].join('；') || '模块适用条件或语义证据尚未明确。',
        'supply_evidence_or_target', step.semantic?.ruleVersion ?? null);
    }
  }
  const affected = affectedProcessingSteps(graph, [...seeds]);
  const affectedSet = new Set(affected);
  for (const step of input.steps) {
    const dependencies = step.dependsOn.filter(id => {
      const dependency = stepsById.get(id);
      return !dependency || dependency.state === 'failed' || dependency.state === 'blocked'
        || dependency.applicability === 'unknown' || affectedSet.has(id)
        || (step.state === 'blocked' && dependency.state !== 'succeeded');
    });
    if (dependencies.length && (step.state !== 'succeeded' || affectedSet.has(step.stepId))
      && !issues.some(issue => issue.kind === 'dependency_blocked' && issue.stepId === step.stepId)) add('dependency_blocked',
      step.stepId, step.outputId, `依赖尚不可用：${dependencies.join('、')}。`,
      affectedSet.has(step.stepId) ? 'revise_affected_steps' : 'supply_evidence_or_target', 'PROCESSING_DEPENDENCY');
  }
  for (const output of input.outputs) {
    if (input.missingOutputs.includes(output.outputId)) continue;
    if (output.rejectReason || output.routingState === 'rejected') {
      add('operator_rejected', null, output.outputId, output.rejectReason ?? '操作者已拒绝该输出。', 'operator_decision');
      continue;
    }
    const own = input.steps.filter(step => step.outputId === output.outputId);
    if (output.semantic?.quality === 'fail' && !own.some(step => step.semantic?.quality === 'fail')) {
      add('semantic_failure', null, output.outputId, output.semantic.error?.message
        ?? (output.semantic.gaps.join('；') || '已记录的输出语义核对未通过。'), 'supply_evidence_or_target',
      output.semantic.error?.code ?? output.semantic.ruleVersion ?? null);
    }
    // 执行错误已逐步骤给出，不能再把其汇总文字猜成独立语义错误。
    const gaps = [...new Set([...output.semanticGaps,
      ...(own.some(step => step.state === 'failed' || step.state === 'blocked') ? [] : output.gaps),
      ...(output.semantic?.quality !== 'fail' ? output.semantic?.gaps ?? [] : [])])];
    if (gaps.length) add('needs_evidence', null, output.outputId, gaps.join('；'), 'supply_evidence_or_target');
  }
  const retainedArtifacts = input.steps.filter(step => step.state === 'succeeded' && !!step.output && !!step.outputDigest
    && step.output.sha256 === step.outputDigest && integrity.get(step.stepId) !== false && !affectedSet.has(step.stepId))
    .map(step => ({ stepId: step.stepId, outputId: step.outputId, artifact: { ...step.output! }, outputDigest: step.outputDigest! }));
  return { contract: 'bd-processing-quality/1', status: issues.length ? 'reported_issues' : 'no_reported_issue',
    scope: 'recorded_plan_evidence_only', publication: 'not_granted', issues,
    revision: { affectedStepIds: affected, affectedOutputIds: [...new Set(graph.filter(step => affectedSet.has(step.stepId))
      .map(step => step.outputId).filter((id): id is string => id !== null))],
      retainedArtifacts, reuse: 'requires_revalidation' } };
}

/** 给模型的摘要有数量与文字上限，完整异常仍从原计划查询。 */
export function processingQualitySummary(quality: ProcessingQuality | undefined) {
  if (!quality) return null;
  const issues = quality.issues.slice(0, 6).map(issue => ({ ...issue, reason: issue.reason.slice(0, 400),
    materialIds: issue.materialIds.slice(0, 8), location: { ...issue.location,
      column: typeof issue.location.column === 'string' ? issue.location.column.slice(0, 160) : issue.location.column } }));
  return { contract: quality.contract, status: quality.status, scope: quality.scope, publication: quality.publication,
    issueCount: quality.issues.length, issues, issuesTruncated: quality.issues.length > issues.length,
    revision: { affectedStepIds: quality.revision.affectedStepIds.slice(0, 32), affectedStepCount: quality.revision.affectedStepIds.length,
      affectedOutputIds: quality.revision.affectedOutputIds.slice(0, 16), affectedOutputCount: quality.revision.affectedOutputIds.length,
      retainedArtifacts: quality.revision.retainedArtifacts.slice(0, 8), retainedArtifactCount: quality.revision.retainedArtifacts.length,
      reuse: quality.revision.reuse } };
}

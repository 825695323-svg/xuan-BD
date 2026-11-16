/** 从既有处理记录派生的异常视图；不是发布许可、修订指令或第二份状态账本。 */
export type ProcessingQualityIssueKind = 'execution_failure' | 'dependency_blocked' | 'artifact_or_record_missing'
  | 'semantic_failure' | 'needs_evidence' | 'operator_rejected';

export interface ProcessingQualityIssue {
  kind: ProcessingQualityIssueKind;
  outputId: string | null;
  stepId: string | null;
  materialIds: string[];
  location: { row: number | null; column: string | number | null };
  ruleCode: string | null;
  reason: string;
  disposition: 'unresolved';
  next: 'revise_affected_steps' | 'supply_evidence_or_target' | 'repair_record' | 'operator_decision';
}

export interface ProcessingQualityArtifact {
  stepId: string;
  outputId: string;
  artifact: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string };
  outputDigest: string;
}

export interface ProcessingQuality {
  contract: 'bd-processing-quality/1';
  status: 'reported_issues' | 'no_reported_issue';
  scope: 'recorded_plan_evidence_only';
  publication: 'not_granted';
  issues: ProcessingQualityIssue[];
  revision: {
    affectedStepIds: string[];
    affectedOutputIds: string[];
    retainedArtifacts: ProcessingQualityArtifact[];
    reuse: 'requires_revalidation';
  };
}

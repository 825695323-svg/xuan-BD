import type { TaskRecord } from '../../../contracts/task-contracts';
export type TaskRecoveryAction = 'resume' | 'retry' | 'recover';
/** State-based choices only. The existing service retains every execution/approval gate. */
export function taskRecoveryChoices(task: TaskRecord, recoverySupported: boolean): TaskRecoveryAction[] {
  const choices: TaskRecoveryAction[] = [];
  if (!task.requiresReview && ['paused', 'interrupted'].includes(task.status)) choices.push('resume');
  if (!task.requiresReview && ['failed', 'cancelled'].includes(task.status)) choices.push('retry');
  if (recoverySupported && ['paused', 'interrupted', 'failed', 'needs_review'].includes(task.status)) choices.push('recover');
  return choices;
}
export function sameTaskRecoveryTarget(a: TaskRecord, b: TaskRecord): boolean {
  return a.id === b.id && a.conversationId === b.conversationId && a.version === b.version
    && a.generation === b.generation && a.status === b.status && a.runtimeId === b.runtimeId
    && a.action === b.action && a.currentRunId === b.currentRunId && a.requiresReview === b.requiresReview;
}

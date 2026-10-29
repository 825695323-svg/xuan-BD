import { RequestError } from './api';
import type { TaskFailure, TaskResult, TaskStatus } from '../../../contracts/task-contracts';

export interface HarnessJob {
  ownerService: 'harness_agents';
  requestId: string;
  jobId: string;
  parentJobId: string | null;
  operation: string;
  status: TaskStatus;
  version: number;
  runId: string | null;
  attemptId: string | null;
  generation: number;
  controlGeneration: number | null;
  versions: Record<string, string | null>;
  resultRef: string | null;
  result: TaskResult | null;
  error: TaskFailure | null;
  requiresReview: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function readHarnessJob(value: unknown): HarnessJob {
  if (!isObject(value) || value.ownerService !== 'harness_agents' || typeof value.jobId !== 'string'
    || typeof value.requestId !== 'string' || typeof value.operation !== 'string'
    || !['blocked', 'awaiting_review', 'ready', 'running', 'waiting_approval', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted', 'needs_review'].includes(String(value.status))
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.requiresReview !== 'boolean') {
    throw new RequestError('任务确认无法读取，请保留原请求编号核对。');
  }
  return value as unknown as HarnessJob;
}

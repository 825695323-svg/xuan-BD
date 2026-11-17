import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskRecord, TaskStatus } from '../../../contracts/task-contracts';
import { sameTaskRecoveryTarget, taskRecoveryChoices } from './task-recovery.js';
const task = (status: TaskStatus, requiresReview = false) => ({ id: 'synthetic-task', conversationId: 'synthetic-conversation', status,
  version: 2, generation: 1, runtimeId: 'synthetic', action: 'fixture', currentRunId: 'synthetic-run', requiresReview } as TaskRecord);
test('recovery choices distinguish execution from supported original-result lookup, never approval or review acceptance', () => {
  assert.deepEqual(taskRecoveryChoices(task('paused'), false), ['resume']);
  assert.deepEqual(taskRecoveryChoices(task('interrupted'), true), ['resume', 'recover']);
  assert.deepEqual(taskRecoveryChoices(task('failed'), true), ['retry', 'recover']);
  assert.deepEqual(taskRecoveryChoices(task('cancelled'), true), ['retry']);
  assert.deepEqual(taskRecoveryChoices(task('needs_review', true), true), ['recover']);
  assert.deepEqual(taskRecoveryChoices(task('needs_review', true), false), []);
  assert.deepEqual(taskRecoveryChoices(task('paused', true), true), ['recover']);
  for (const status of ['ready', 'running', 'waiting_approval', 'pausing', 'cancelling', 'succeeded', 'blocked', 'awaiting_review'] as const)
    assert.deepEqual(taskRecoveryChoices(task(status), true), []);
});
test('recovery target rejects changed identity, conversation, runtime, state, version and generation', () => {
  const original = task('paused'); assert.equal(sameTaskRecoveryTarget(original, structuredClone(original)), true);
  for (const [key, value] of Object.entries({ id: 'another', conversationId: 'another', version: 3, generation: 2, status: 'running',
    runtimeId: 'another', action: 'another', currentRunId: 'another', requiresReview: true }))
    assert.equal(sameTaskRecoveryTarget(original, { ...original, [key]: value }), false, key);
});

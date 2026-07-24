import { describe, expect, it } from 'vitest';

import type { AgentProfileSkeleton, RunStatus, StepStatus, TaskStatus } from '@orion/contracts';

import {
  areEventSequencesMonotonic,
  assertRunTransition,
  assertStepTransition,
  assertTaskTransition,
  createRunProfileSnapshot,
  hasValidEventSequence,
  isAllowedRunTransition,
  isAllowedStepTransition,
  isAllowedTaskTransition,
  isEventSequenceMonotonic,
  isRunProfileSnapshotUnchanged,
} from '../src/index.js';

const taskStates: readonly TaskStatus[] = [
  'draft',
  'planning',
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'limit_reached',
];

const expectedTaskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['planning', 'cancelled'],
  planning: ['queued', 'failed', 'cancelled'],
  queued: ['running', 'cancelled', 'limit_reached'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'limit_reached'],
  waiting_approval: ['queued', 'cancelled', 'failed', 'limit_reached'],
  succeeded: [],
  failed: ['queued'], // M3 DEC-015 manual retry
  cancelled: [],
  limit_reached: [],
};

const stepStates: readonly StepStatus[] = [
  'waiting',
  'ready',
  'running',
  'retry_wait',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'interrupted',
];

const expectedStepTransitions: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  waiting: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'cancelled', 'skipped'],
  running: ['retry_wait', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  retry_wait: ['ready', 'failed', 'cancelled'],
  waiting_approval: ['ready', 'cancelled', 'failed'],
  succeeded: [],
  failed: ['ready'], // M3 DEC-015 manual retry
  skipped: [],
  cancelled: [],
  interrupted: ['ready', 'failed', 'cancelled'],
};

const runStates: readonly RunStatus[] = [
  'starting',
  'running',
  'stalled',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
];

const expectedRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['stalled', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
  stalled: ['running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  interrupted: [],
};

const profile: AgentProfileSkeleton = {
  id: 'atlas',
  version: 1,
  name: 'Atlas',
  displayName: 'Atlas Test Profile',
  description: 'Synthetic profile used to verify an immutable run snapshot copy.',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  fallbackModels: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
  reasoningEffort: 'high',
  permissionTemplate: 'advisor',
  permissions: {
    networkReadAllowed: true,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    externalActionsAllowed: false,
  },
  capabilities: ['strategy'],
  enabled: false,
  executionMode: 'skeleton',
};

describe('Task, Step, and Run state machines', () => {
  it('accepts every Task transition in the approved matrix and rejects omitted pairs', () => {
    for (const from of taskStates) {
      for (const to of taskStates) {
        const expected = expectedTaskTransitions[from].includes(to);
        expect(isAllowedTaskTransition(from, to)).toBe(expected);
        expect(assertTaskTransition(from, to)).toEqual(
          expected ? { ok: true, from, to } : { ok: false, code: 'INVALID_STATE_TRANSITION' },
        );
      }
    }
  });

  it('accepts every Step transition in the approved matrix and rejects omitted pairs', () => {
    for (const from of stepStates) {
      for (const to of stepStates) {
        const expected = expectedStepTransitions[from].includes(to);
        expect(isAllowedStepTransition(from, to)).toBe(expected);
        expect(assertStepTransition(from, to)).toEqual(
          expected ? { ok: true, from, to } : { ok: false, code: 'INVALID_STATE_TRANSITION' },
        );
      }
    }
  });

  it('accepts every Run transition in the approved matrix and rejects omitted pairs', () => {
    for (const from of runStates) {
      for (const to of runStates) {
        const expected = expectedRunTransitions[from].includes(to);
        expect(isAllowedRunTransition(from, to)).toBe(expected);
        expect(assertRunTransition(from, to)).toEqual(
          expected ? { ok: true, from, to } : { ok: false, code: 'INVALID_STATE_TRANSITION' },
        );
      }
    }
  });
});

describe('event sequence and profile snapshot rules', () => {
  it('requires valid task and run sequences and preserves task- and run-scoped monotonicity', () => {
    const events = [
      { taskId: 'task-a', runId: 'run-a', taskSequence: 1, runSequence: 1 },
      { taskId: 'task-a', runId: null, taskSequence: 2, runSequence: null },
      { taskId: 'task-a', runId: 'run-a', taskSequence: 3, runSequence: 2 },
      { taskId: 'task-b', runId: 'run-b', taskSequence: 1, runSequence: 1 },
    ];

    expect(events.every(hasValidEventSequence)).toBe(true);
    expect(isEventSequenceMonotonic(events[0]!, events[1]!)).toBe(true);
    expect(isEventSequenceMonotonic(events[0]!, events[2]!)).toBe(true);
    expect(areEventSequencesMonotonic(events)).toBe(true);
    expect(areEventSequencesMonotonic([...events, { ...events[2]!, taskSequence: 3 }])).toBe(false);
    expect(areEventSequencesMonotonic([...events, { ...events[2]!, runSequence: 2 }])).toBe(false);
    expect(
      hasValidEventSequence({ taskId: 'task-a', runId: null, taskSequence: 4, runSequence: 1 }),
    ).toBe(false);
    expect(
      hasValidEventSequence({
        taskId: 'task-a',
        runId: 'run-a',
        taskSequence: 4,
        runSequence: null,
      }),
    ).toBe(false);
  });

  it('copies a full profile for a Run and rejects a later profile snapshot rewrite', () => {
    const snapshot = createRunProfileSnapshot(profile);
    profile.capabilities.push('mutated-source-profile');
    profile.fallbackModels[0]!.model = 'mutated-fallback-model';

    expect(snapshot.capabilities).toEqual(['strategy']);
    expect(snapshot.fallbackModels).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-8' }]);
    expect(
      isRunProfileSnapshotUnchanged(
        { agentProfileSnapshot: snapshot },
        { agentProfileSnapshot: snapshot },
      ),
    ).toBe(true);
    expect(
      isRunProfileSnapshotUnchanged(
        { agentProfileSnapshot: snapshot },
        { agentProfileSnapshot: { ...snapshot, model: 'gpt-5.6-terra' } },
      ),
    ).toBe(false);
  });
});

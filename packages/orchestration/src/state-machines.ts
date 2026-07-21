import type {
  AgentProfileSkeleton,
  Event,
  Run,
  RunStatus,
  StepStatus,
  TaskStatus,
} from '@orion/contracts';

export type TransitionResult<State extends string> =
  { ok: true; from: State; to: State } | { ok: false; code: 'INVALID_STATE_TRANSITION' };

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

export const taskTransitionTable = {
  draft: ['planning', 'cancelled'],
  planning: ['queued', 'failed', 'cancelled'],
  queued: ['running', 'cancelled', 'limit_reached'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'limit_reached'],
  waiting_approval: ['queued', 'cancelled', 'failed', 'limit_reached'],
  succeeded: [],
  failed: [],
  cancelled: [],
  limit_reached: [],
} as const satisfies TransitionTable<TaskStatus>;

export const stepTransitionTable = {
  waiting: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'cancelled', 'skipped'],
  running: ['retry_wait', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  retry_wait: ['ready', 'failed', 'cancelled'],
  waiting_approval: ['ready', 'cancelled', 'failed'],
  interrupted: ['ready', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
} as const satisfies TransitionTable<StepStatus>;

export const runTransitionTable = {
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['stalled', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
  stalled: ['running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  interrupted: [],
} as const satisfies TransitionTable<RunStatus>;

export function isAllowedTransition<State extends string>(
  transitions: TransitionTable<State>,
  from: State,
  to: State,
): boolean {
  return transitions[from].includes(to);
}

export function assertTransition<State extends string>(
  transitions: TransitionTable<State>,
  from: State,
  to: State,
): TransitionResult<State> {
  if (isAllowedTransition(transitions, from, to)) {
    return { ok: true, from, to };
  }

  return { ok: false, code: 'INVALID_STATE_TRANSITION' };
}

export function isAllowedTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return isAllowedTransition(taskTransitionTable, from, to);
}

export function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): TransitionResult<TaskStatus> {
  return assertTransition(taskTransitionTable, from, to);
}

export function isAllowedStepTransition(from: StepStatus, to: StepStatus): boolean {
  return isAllowedTransition(stepTransitionTable, from, to);
}

export function assertStepTransition(
  from: StepStatus,
  to: StepStatus,
): TransitionResult<StepStatus> {
  return assertTransition(stepTransitionTable, from, to);
}

export function isAllowedRunTransition(from: RunStatus, to: RunStatus): boolean {
  return isAllowedTransition(runTransitionTable, from, to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): TransitionResult<RunStatus> {
  return assertTransition(runTransitionTable, from, to);
}

export type EventSequence = Pick<Event, 'taskId' | 'runId' | 'taskSequence' | 'runSequence'>;

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

export function hasValidEventSequence(event: EventSequence): boolean {
  if (!isPositiveSafeInteger(event.taskSequence)) {
    return false;
  }

  return event.runId === null
    ? event.runSequence === null
    : isPositiveSafeInteger(event.runSequence);
}

export function isEventSequenceMonotonic(previous: EventSequence, next: EventSequence): boolean {
  if (!hasValidEventSequence(previous) || !hasValidEventSequence(next)) {
    return false;
  }

  if (previous.taskId === next.taskId && next.taskSequence <= previous.taskSequence) {
    return false;
  }

  return !(
    previous.runId !== null &&
    previous.runId === next.runId &&
    next.runSequence !== null &&
    previous.runSequence !== null &&
    next.runSequence <= previous.runSequence
  );
}

export function areEventSequencesMonotonic(events: readonly EventSequence[]): boolean {
  const latestTaskSequence = new Map<string, number>();
  const latestRunSequence = new Map<string, number>();

  for (const event of events) {
    if (!hasValidEventSequence(event)) {
      return false;
    }

    const previousTaskSequence = latestTaskSequence.get(event.taskId);
    if (previousTaskSequence !== undefined && event.taskSequence <= previousTaskSequence) {
      return false;
    }
    latestTaskSequence.set(event.taskId, event.taskSequence);

    if (event.runId !== null && event.runSequence !== null) {
      const previousRunSequence = latestRunSequence.get(event.runId);
      if (previousRunSequence !== undefined && event.runSequence <= previousRunSequence) {
        return false;
      }
      latestRunSequence.set(event.runId, event.runSequence);
    }
  }

  return true;
}

export function createRunProfileSnapshot(profile: AgentProfileSkeleton): AgentProfileSkeleton {
  const registryOperationScopes = profile.permissions.registryOperationScopes;

  return {
    ...profile,
    fallbackModels: profile.fallbackModels.map((model) => ({ ...model })),
    permissions: {
      ...profile.permissions,
      ...(registryOperationScopes === undefined
        ? {}
        : { registryOperationScopes: [...registryOperationScopes] }),
    },
    capabilities: [...profile.capabilities],
  };
}

export function isRunProfileSnapshotUnchanged(
  before: Pick<Run, 'agentProfileSnapshot'>,
  after: Pick<Run, 'agentProfileSnapshot'>,
): boolean {
  return JSON.stringify(before.agentProfileSnapshot) === JSON.stringify(after.agentProfileSnapshot);
}

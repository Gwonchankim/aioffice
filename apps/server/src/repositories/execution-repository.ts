import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import {
  eventSchema,
  planSchema,
  runSchema,
  stepSchema,
  taskSchema,
  type Event,
  type EventPayload,
  type EventType,
  type Run,
  type RunStatus,
  type Step,
  type StepStatus,
  type Task,
  type TaskStatus,
} from '@orion/contracts';
import {
  assertRunTransition,
  assertStepTransition,
  assertTaskTransition,
} from '@orion/orchestration';

import { ApplicationError } from '../errors.js';
import { withImmediateTransaction } from '../database.js';

type TransitionEntity = 'task' | 'step' | 'run';
export interface TransitionCommand {
  readonly entity: TransitionEntity;
  readonly id: string;
  readonly to: TaskStatus | StepStatus | RunStatus;
  readonly event: {
    readonly id?: string;
    readonly type: EventType;
    readonly payload: EventPayload;
    readonly provider?: 'openai' | 'anthropic' | 'system' | null;
    readonly timestamp?: string;
  };
}

export class ExecutionRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public createTask(task: Task): void {
    const parsed = taskSchema.parse(task);
    this.database
      .prepare(
        `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json,
      max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.projectId,
        parsed.title,
        parsed.objective,
        JSON.stringify(parsed.successCriteria),
        JSON.stringify(parsed.inputArtifactIds),
        parsed.maxDurationMinutes,
        parsed.maxAgentRuns,
        parsed.requestedAgentIds === undefined ? null : JSON.stringify(parsed.requestedAgentIds),
        parsed.status,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.completedAt,
      );
  }

  public createPlan(plan: Parameters<typeof planSchema.parse>[0]): void {
    const parsed = planSchema.parse(plan);
    this.database
      .prepare(
        'INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        parsed.taskId,
        parsed.version,
        JSON.stringify(parsed.planJson),
        JSON.stringify(parsed.validationJson),
        parsed.createdAt,
      );
  }

  public createStep(step: Step): void {
    const parsed = stepSchema.parse(step);
    this.database
      .prepare(
        `INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.planVersion,
        JSON.stringify(parsed),
        parsed.status,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.completedAt,
      );
  }

  public createRun(run: Run): void {
    const parsed = runSchema.parse(run);
    const snapshot = JSON.stringify(parsed.agentProfileSnapshot);
    this.database
      .prepare(
        `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, session_id, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.stepId,
        parsed.attempt,
        parsed.provider,
        parsed.model,
        snapshot,
        createHash('sha256').update(snapshot).digest('hex'),
        parsed.status,
        parsed.sessionId,
        parsed.createdAt,
        parsed.startedAt,
        parsed.completedAt,
      );
  }

  public transitionWithEvent(command: TransitionCommand): Event {
    const context = this.transitionContext(command.entity, command.id);
    assertTransition(command.entity, context.status, command.to);
    const timestamp = command.event.timestamp ?? this.now().toISOString();
    return withImmediateTransaction(this.database, () => {
      const current = this.transitionContext(command.entity, command.id);
      assertTransition(command.entity, current.status, command.to);
      const changed = this.database
        .prepare(`UPDATE ${current.table} SET status = ? WHERE id = ? AND status = ?`)
        .run(command.to, command.id, current.status).changes;
      if (changed !== 1) {
        throw new ApplicationError(
          'INVALID_STATE_TRANSITION',
          'The current state changed before it could be persisted.',
          { statusCode: 409 },
        );
      }
      const taskSequence = this.allocateSequence('task_event_sequences', 'task_id', current.taskId);
      const runSequence =
        current.runId === null
          ? null
          : this.allocateSequence('run_event_sequences', 'run_id', current.runId);
      const event = eventSchema.parse({
        id: command.event.id ?? ulid(),
        taskId: current.taskId,
        stepId: current.stepId,
        runId: current.runId,
        provider: command.event.provider ?? current.provider ?? 'system',
        type: command.event.type,
        timestamp,
        payload: command.event.payload,
        taskSequence,
        runSequence,
      });
      this.database
        .prepare(
          `INSERT INTO events (id, task_id, step_id, run_id, provider, type, timestamp, payload_json, task_sequence, run_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.taskId,
          event.stepId,
          event.runId,
          event.provider,
          event.type,
          event.timestamp,
          JSON.stringify(event.payload),
          event.taskSequence,
          event.runSequence,
        );
      return event;
    });
  }

  public appendRunEvent(
    runId: string,
    event: Omit<TransitionCommand['event'], 'provider'> & {
      readonly provider?: 'openai' | 'anthropic' | 'system' | null;
    },
  ): Event {
    const timestamp = event.timestamp ?? this.now().toISOString();
    return withImmediateTransaction(this.database, () => {
      const current = this.transitionContext('run', runId);
      const taskSequence = this.allocateSequence('task_event_sequences', 'task_id', current.taskId);
      const runSequence = this.allocateSequence('run_event_sequences', 'run_id', runId);
      const parsed = eventSchema.parse({
        id: event.id ?? ulid(),
        taskId: current.taskId,
        stepId: current.stepId,
        runId,
        provider: event.provider ?? current.provider,
        type: event.type,
        timestamp,
        payload: event.payload,
        taskSequence,
        runSequence,
      });
      this.database
        .prepare(
          'INSERT INTO events (id, task_id, step_id, run_id, provider, type, timestamp, payload_json, task_sequence, run_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          parsed.id,
          parsed.taskId,
          parsed.stepId,
          parsed.runId,
          parsed.provider,
          parsed.type,
          parsed.timestamp,
          JSON.stringify(parsed.payload),
          parsed.taskSequence,
          parsed.runSequence,
        );
      return parsed;
    });
  }

  private allocateSequence(
    table: 'task_event_sequences' | 'run_event_sequences',
    key: 'task_id' | 'run_id',
    id: string,
  ): number {
    const row = this.database
      .prepare(
        `INSERT INTO ${table} (${key}, next_sequence) VALUES (?, 2)
      ON CONFLICT(${key}) DO UPDATE SET next_sequence = ${table}.next_sequence + 1
      RETURNING next_sequence - 1 AS sequence`,
      )
      .get(id) as { sequence: number };
    return row.sequence;
  }

  private transitionContext(
    entity: TransitionEntity,
    id: string,
  ): {
    readonly table: 'tasks' | 'task_steps' | 'runs';
    readonly status: string;
    readonly taskId: string;
    readonly stepId: string | null;
    readonly runId: string | null;
    readonly provider: 'openai' | 'anthropic' | null;
  } {
    if (entity === 'task') {
      const row = this.database.prepare('SELECT id, status FROM tasks WHERE id = ?').get(id) as
        { id: string; status: string } | undefined;
      if (row === undefined) throw new ApplicationError('NOT_FOUND', 'The task does not exist.');
      return {
        table: 'tasks',
        status: row.status,
        taskId: row.id,
        stepId: null,
        runId: null,
        provider: null,
      };
    }
    if (entity === 'step') {
      const row = this.database
        .prepare('SELECT id, task_id, status FROM task_steps WHERE id = ?')
        .get(id) as { id: string; task_id: string; status: string } | undefined;
      if (row === undefined) throw new ApplicationError('NOT_FOUND', 'The step does not exist.');
      return {
        table: 'task_steps',
        status: row.status,
        taskId: row.task_id,
        stepId: row.id,
        runId: null,
        provider: null,
      };
    }
    const row = this.database
      .prepare(
        `SELECT runs.id, runs.step_id, runs.status, runs.provider, task_steps.task_id
      FROM runs JOIN task_steps ON task_steps.id = runs.step_id WHERE runs.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          step_id: string;
          task_id: string;
          status: string;
          provider: 'openai' | 'anthropic';
        }
      | undefined;
    if (row === undefined) throw new ApplicationError('NOT_FOUND', 'The run does not exist.');
    return {
      table: 'runs',
      status: row.status,
      taskId: row.task_id,
      stepId: row.step_id,
      runId: row.id,
      provider: row.provider,
    };
  }
}

function assertTransition(entity: TransitionEntity, from: string, to: string): void {
  const result =
    entity === 'task'
      ? assertTaskTransition(from as TaskStatus, to as TaskStatus)
      : entity === 'step'
        ? assertStepTransition(from as StepStatus, to as StepStatus)
        : assertRunTransition(from as RunStatus, to as RunStatus);
  if (!result.ok) {
    throw new ApplicationError(
      'INVALID_STATE_TRANSITION',
      'The requested state transition is not permitted.',
      { statusCode: 409 },
    );
  }
}

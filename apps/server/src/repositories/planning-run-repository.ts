import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import {
  eventSchema,
  planningRunSchema,
  type Event,
  type EventPayload,
  type EventType,
  type FallbackReasonCode,
  type PlanningRun,
  type PlanningRunStatus,
  type Provider,
} from '@orion/contracts';

import { ApplicationError } from '../errors.js';
import { sqliteErrorCode, withImmediateTransaction } from '../database.js';
import { canonicalProfileConfigJson, sha256Hex } from './agent-profile-repository.js';

export interface PlanningRunInsert {
  readonly taskId: string;
  readonly attempt: PlanningRun['attempt'];
  readonly provider: Provider;
  readonly model: string;
  /** Agent-profile object stored verbatim; canonicalized and hashed here, then immutable. */
  readonly profileSnapshot: unknown;
  readonly fallbackReason?: FallbackReasonCode | null;
  readonly id?: string;
  readonly createdAt?: string;
}

export interface PlanningRunCompletion {
  readonly status: Exclude<PlanningRunStatus, 'running'>;
  /** When omitted the stored fallback provenance is preserved, never cleared. */
  readonly fallbackReason?: FallbackReasonCode | null;
  readonly completedAt?: string;
}

export interface PlanningEventInput {
  readonly type: EventType;
  readonly payload: EventPayload;
  readonly provider?: Provider | 'system' | null;
  readonly timestamp?: string;
  readonly id?: string;
}

interface PlanningRunRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly profile_snapshot_sha256: string;
  readonly status: string;
  readonly fallback_reason: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const PLANNING_RUN_COLUMNS =
  'id, task_id, attempt, provider, model, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at';

/** Parses a row through `planningRunSchema` so a corrupt row can never flow onward. */
function readPlanningRunRow(row: PlanningRunRow): PlanningRun {
  return planningRunSchema.parse({
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    provider: row.provider,
    model: row.model,
    profileSnapshotSha256: row.profile_snapshot_sha256,
    status: row.status,
    fallbackReason: row.fallback_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

/**
 * Persistence boundary for the Orion planning cycle (DEC-013/DEC-020/DEC-025).
 *
 * `planning_runs` is append-only and its profile snapshot is immutable: this
 * repository never DELETEs a row and never UPDATEs `profile_snapshot_json` or
 * `profile_snapshot_sha256`. The only permitted mutation is the single
 * `running -> succeeded | failed` completion, which the 0005 transition trigger
 * also enforces at the database level.
 */
export class PlanningRunRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Inserts the `running` row for one planning attempt together with its
   * immutable profile snapshot. The 0005 `planning_runs_one_running_per_task`
   * partial unique index serializes planning attempts per task (DEC-020); its
   * rejection is surfaced as `TASK_EXECUTION_CONFLICT` rather than swallowed.
   */
  public createRunning(input: PlanningRunInsert): PlanningRun {
    const snapshotJson = canonicalProfileConfigJson(input.profileSnapshot);
    const run = planningRunSchema.parse({
      id: input.id ?? ulid(),
      taskId: input.taskId,
      attempt: input.attempt,
      provider: input.provider,
      model: input.model,
      profileSnapshotSha256: sha256Hex(snapshotJson),
      status: 'running',
      fallbackReason: input.fallbackReason ?? null,
      createdAt: input.createdAt ?? this.now().toISOString(),
      completedAt: null,
    });

    try {
      withImmediateTransaction(this.database, () => {
        this.database
          .prepare(
            `INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json,
             profile_snapshot_sha256, status, fallback_reason, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL)`,
          )
          .run(
            run.id,
            run.taskId,
            run.attempt,
            run.provider,
            run.model,
            snapshotJson,
            run.profileSnapshotSha256,
            run.fallbackReason,
            run.createdAt,
          );
      });
    } catch (error) {
      throw planningRunError(error, input.taskId);
    }

    return run;
  }

  /**
   * Completes a `running` planning run. Fails closed when the row is not
   * currently running: the guarded UPDATE matches nothing, and any transition
   * the database trigger rejects is surfaced as `INVALID_STATE_TRANSITION`.
   */
  public complete(id: string, completion: PlanningRunCompletion): PlanningRun {
    const completedAt = completion.completedAt ?? this.now().toISOString();
    try {
      return withImmediateTransaction(this.database, () => {
        const changed = Number(
          this.database
            .prepare(
              `UPDATE planning_runs
                 SET status = ?, completed_at = ?, fallback_reason = COALESCE(?, fallback_reason)
               WHERE id = ? AND status = 'running'`,
            )
            .run(completion.status, completedAt, completion.fallbackReason ?? null, id).changes,
        );
        if (changed !== 1) {
          if (this.findById(id) === undefined) {
            throw new ApplicationError('NOT_FOUND', 'The planning run does not exist.');
          }
          throw new ApplicationError(
            'INVALID_STATE_TRANSITION',
            'The planning run is no longer running.',
            { statusCode: 409 },
          );
        }
        return this.requireById(id);
      });
    } catch (error) {
      throw planningRunError(error);
    }
  }

  public findById(id: string): PlanningRun | undefined {
    const row = this.database
      .prepare(`SELECT ${PLANNING_RUN_COLUMNS} FROM planning_runs WHERE id = ?`)
      .get(id) as PlanningRunRow | undefined;
    return row === undefined ? undefined : readPlanningRunRow(row);
  }

  public findRunningForTask(taskId: string): PlanningRun | undefined {
    const row = this.database
      .prepare(
        `SELECT ${PLANNING_RUN_COLUMNS} FROM planning_runs WHERE task_id = ? AND status = 'running'`,
      )
      .get(taskId) as PlanningRunRow | undefined;
    return row === undefined ? undefined : readPlanningRunRow(row);
  }

  public listForTask(taskId: string): readonly PlanningRun[] {
    const rows = this.database
      .prepare(
        `SELECT ${PLANNING_RUN_COLUMNS} FROM planning_runs WHERE task_id = ?
         ORDER BY attempt ASC, created_at ASC`,
      )
      .all(taskId) as unknown as PlanningRunRow[];
    return rows.map((row) => readPlanningRunRow(row));
  }

  /** Every planning run of a task, `running` rows included (DEC-020/DEC-025 item 12). */
  public countForTask(taskId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS total FROM planning_runs WHERE task_id = ?')
      .get(taskId) as { total: number };
    return Number(row.total);
  }

  /**
   * LIM-004 accounting basis (DEC-013): agent runs reached through the task's
   * steps plus every planning run of the task, `running` planning runs included.
   */
  public totalRunCountForTask(taskId: string): number {
    const row = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM runs
              JOIN task_steps ON task_steps.id = runs.step_id
             WHERE task_steps.task_id = ?)
         + (SELECT COUNT(*) FROM planning_runs WHERE task_id = ?) AS total`,
      )
      .get(taskId, taskId) as { total: number };
    return Number(row.total);
  }

  /** The next unused `task_plans.version` for a task; existing versions are never reused. */
  public nextPlanVersion(taskId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM task_plans WHERE task_id = ?')
      .get(taskId) as { max_version: number };
    return Number(row.max_version) + 1;
  }

  /**
   * Startup recovery (DEC-020): a `running` planning run left behind by a crash
   * cannot be resumed, so it is conservatively closed as `failed` and stays in
   * the run count. Returns how many rows were closed.
   */
  public failStaleRunning(): number {
    const completedAt = this.now().toISOString();
    try {
      return withImmediateTransaction(this.database, () =>
        Number(
          this.database
            .prepare(
              `UPDATE planning_runs SET status = 'failed', completed_at = ? WHERE status = 'running'`,
            )
            .run(completedAt).changes,
        ),
      );
    } catch (error) {
      throw planningRunError(error);
    }
  }

  /**
   * Appends a planning event as a task-level event (DEC-013): planning runs do
   * not live in `runs`, so `run_id` and `run_sequence` are always NULL and only
   * the task sequence is allocated.
   */
  public appendPlanningEvent(taskId: string, input: PlanningEventInput): Event {
    const timestamp = input.timestamp ?? this.now().toISOString();
    try {
      return withImmediateTransaction(this.database, () => {
        const taskSequence = this.allocateTaskSequence(taskId);
        const event = eventSchema.parse({
          id: input.id ?? ulid(),
          taskId,
          stepId: null,
          runId: null,
          provider: input.provider ?? 'system',
          type: input.type,
          timestamp,
          payload: input.payload,
          taskSequence,
          runSequence: null,
        });
        this.database
          .prepare(
            `INSERT INTO events (id, task_id, step_id, run_id, provider, type, timestamp, payload_json, task_sequence, run_sequence)
             VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            event.id,
            event.taskId,
            event.provider,
            event.type,
            event.timestamp,
            JSON.stringify(event.payload),
            event.taskSequence,
          );
        return event;
      });
    } catch (error) {
      throw planningRunError(error, taskId);
    }
  }

  private requireById(id: string): PlanningRun {
    const run = this.findById(id);
    if (run === undefined) {
      throw new ApplicationError('NOT_FOUND', 'The planning run does not exist.');
    }
    return run;
  }

  private allocateTaskSequence(taskId: string): number {
    const row = this.database
      .prepare(
        `INSERT INTO task_event_sequences (task_id, next_sequence) VALUES (?, 2)
         ON CONFLICT(task_id) DO UPDATE SET next_sequence = task_event_sequences.next_sequence + 1
         RETURNING next_sequence - 1 AS sequence`,
      )
      .get(taskId) as { sequence: number };
    return Number(row.sequence);
  }
}

function planningRunError(error: unknown, taskId?: string): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  const message = error instanceof Error ? error.message : '';
  // SQLite names the conflicting table column rather than the partial index that
  // enforces it, so both spellings are matched. `planning_runs.id` is deliberately
  // not matched: an id collision is not a concurrent-planning conflict.
  if (
    message.includes('planning_runs_one_running_per_task') ||
    message.includes('UNIQUE constraint failed: planning_runs.task_id')
  ) {
    return new ApplicationError(
      'TASK_EXECUTION_CONFLICT',
      taskId === undefined
        ? 'A planning run is already in progress for this task.'
        : `A planning run is already in progress for task "${taskId}".`,
      { statusCode: 409 },
    );
  }
  const code = sqliteErrorCode(error);
  if (code === 'INVALID_STATE_TRANSITION' || code === 'IMMUTABLE_PROFILE_SNAPSHOT') {
    return new ApplicationError(code, 'The requested planning run change is not permitted.', {
      statusCode: 409,
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new ApplicationError('NOT_FOUND', 'The referenced task does not exist.');
  }
  return new ApplicationError('DATABASE_UNAVAILABLE', 'The planning run could not be persisted.', {
    statusCode: 503,
    retryable: true,
  });
}

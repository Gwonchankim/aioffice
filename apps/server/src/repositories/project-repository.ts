import { ulid } from 'ulid';
import {
  projectSchema,
  type Project,
  type ProjectRegistrationInput,
  type ProjectUpdateInput,
} from '@orion/contracts';
import type { DatabaseSync } from 'node:sqlite';

import { ApplicationError } from '../errors.js';
import { withImmediateTransaction } from '../database.js';

type ProjectRow = {
  readonly id: string;
  readonly project_key: string;
  readonly name: string;
  readonly repository_path: string;
  readonly default_branch: string;
  readonly classification: string;
  readonly provider_policy_json: string;
  readonly allowed_agent_ids_json: string;
  readonly allowed_commands_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly unregistered_at: string | null;
};

export class ProjectRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(input: ProjectRegistrationInput, repositoryPath: string, id = ulid()): Project {
    const timestamp = this.now().toISOString();
    const project = projectSchema.parse({
      ...input,
      id,
      repositoryPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      unregisteredAt: null,
    });
    this.insert(project);
    return project;
  }

  public insert(project: Project): void {
    const parsed = projectSchema.parse(project);
    try {
      this.database
        .prepare(
          `INSERT INTO projects (
        id, project_key, name, repository_path, default_branch, classification, provider_policy_json,
        allowed_agent_ids_json, allowed_commands_json, created_at, updated_at, unregistered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.projectKey,
          parsed.name,
          parsed.repositoryPath,
          parsed.defaultBranch,
          parsed.classification,
          JSON.stringify(parsed.providerPolicy),
          JSON.stringify(parsed.allowedAgentIds),
          JSON.stringify(parsed.allowedCommands),
          parsed.createdAt,
          parsed.updatedAt,
          parsed.unregisteredAt,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The project key or repository path is already registered.',
          { statusCode: 409 },
        );
      }
      throw error;
    }
  }

  public findActiveById(id: string): Project | undefined {
    return this.rowToProject(
      this.database
        .prepare('SELECT * FROM projects WHERE id = ? AND unregistered_at IS NULL')
        .get(id) as ProjectRow | undefined,
    );
  }

  public findActiveByPath(repositoryPath: string): Project | undefined {
    return this.rowToProject(
      this.database
        .prepare('SELECT * FROM projects WHERE repository_path = ? AND unregistered_at IS NULL')
        .get(repositoryPath) as ProjectRow | undefined,
    );
  }

  public listActive(limit: number, cursor?: string): readonly Project[] {
    const rows =
      cursor === undefined
        ? this.database
            .prepare('SELECT * FROM projects WHERE unregistered_at IS NULL ORDER BY id LIMIT ?')
            .all(limit)
        : this.database
            .prepare(
              'SELECT * FROM projects WHERE unregistered_at IS NULL AND id > ? ORDER BY id LIMIT ?',
            )
            .all(cursor, limit);
    return (rows as ProjectRow[])
      .map((row) => this.rowToProject(row))
      .filter((project): project is Project => project !== undefined);
  }

  public update(id: string, patch: ProjectUpdateInput): Project {
    const current = this.findActiveById(id);
    if (current === undefined) {
      throw new ApplicationError('NOT_FOUND', 'The requested project is not registered.');
    }
    const fields = { ...patch };
    delete fields.fableWarningConfirmationId;
    const project = projectSchema.parse({
      ...current,
      ...fields,
      providerPolicy: fields.providerPolicy ?? current.providerPolicy,
      allowedAgentIds: fields.allowedAgentIds ?? current.allowedAgentIds,
      allowedCommands: fields.allowedCommands ?? current.allowedCommands,
      updatedAt: this.now().toISOString(),
    });
    this.database
      .prepare(
        `UPDATE projects SET name = ?, default_branch = ?, classification = ?, provider_policy_json = ?,
      allowed_agent_ids_json = ?, allowed_commands_json = ?, updated_at = ? WHERE id = ? AND unregistered_at IS NULL`,
      )
      .run(
        project.name,
        project.defaultBranch,
        project.classification,
        JSON.stringify(project.providerPolicy),
        JSON.stringify(project.allowedAgentIds),
        JSON.stringify(project.allowedCommands),
        project.updatedAt,
        id,
      );
    return project;
  }

  public softUnregister(id: string): Project {
    const current = this.findActiveById(id);
    if (current === undefined) {
      throw new ApplicationError('NOT_FOUND', 'The requested project is not registered.');
    }
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        'UPDATE projects SET unregistered_at = ?, updated_at = ? WHERE id = ? AND unregistered_at IS NULL',
      )
      .run(timestamp, timestamp, id);
    return projectSchema.parse({ ...current, updatedAt: timestamp, unregisteredAt: timestamp });
  }

  public unregisterWithBlockers(
    id: string,
    inImmediateTransaction = false,
  ): {
    readonly project: Project;
    readonly tasks: readonly { id: string; status: string }[];
    readonly worktrees: readonly WorktreeBlocker[];
  } {
    const unregister = () => {
      const project = this.findActiveById(id);
      if (project === undefined) {
        throw new ApplicationError('NOT_FOUND', 'The requested project is not registered.');
      }
      const tasks = this.database
        .prepare(
          `SELECT id, status FROM tasks WHERE project_id = ?
        AND status IN ('draft','planning','queued','running','waiting_approval') ORDER BY id`,
        )
        .all(id) as { id: string; status: string }[];
      const worktrees = this.database
        .prepare(
          `SELECT id, status, path, branch, task_id, run_id FROM git_worktrees
        WHERE project_id = ? AND status IN ('active','preserved') ORDER BY id`,
        )
        .all(id) as WorktreeRow[];
      if (tasks.length > 0 || worktrees.length > 0) {
        return { project, tasks, worktrees: worktrees.map(toWorktreeBlocker) };
      }
      const unregistered = this.softUnregister(id);
      this.writeAudit('system', 'project.unregistered', id, { projectId: id });
      return { project: unregistered, tasks, worktrees: [] };
    };
    return inImmediateTransaction
      ? unregister()
      : withImmediateTransaction(this.database, unregister);
  }

  public writeAudit(
    actor: string,
    action: string,
    projectId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        'INSERT INTO audit_log (id, actor, action, project_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(ulid(), actor, action, projectId, JSON.stringify(payload), this.now().toISOString());
  }

  private rowToProject(row: ProjectRow | undefined): Project | undefined {
    if (row === undefined) {
      return undefined;
    }
    return projectSchema.parse({
      id: row.id,
      projectKey: row.project_key,
      name: row.name,
      repositoryPath: row.repository_path,
      defaultBranch: row.default_branch,
      classification: row.classification,
      providerPolicy: JSON.parse(row.provider_policy_json),
      allowedAgentIds: JSON.parse(row.allowed_agent_ids_json),
      allowedCommands: JSON.parse(row.allowed_commands_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      unregisteredAt: row.unregistered_at,
    });
  }
}

type WorktreeRow = {
  readonly id: string;
  readonly status: 'active' | 'preserved';
  readonly path: string;
  readonly branch: string;
  readonly task_id: string | null;
  readonly run_id: string | null;
};
export type WorktreeBlocker = {
  readonly id: string;
  readonly status: 'active' | 'preserved';
  readonly path: string;
  readonly branch: string;
  readonly taskId: string | null;
  readonly runId: string | null;
};
function toWorktreeBlocker(row: WorktreeRow): WorktreeBlocker {
  return {
    id: row.id,
    status: row.status,
    path: row.path,
    branch: row.branch,
    taskId: row.task_id,
    runId: row.run_id,
  };
}

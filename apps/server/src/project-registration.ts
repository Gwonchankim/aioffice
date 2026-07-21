import { ulid } from 'ulid';
import type { DatabaseSync } from 'node:sqlite';
import {
  projectRegistrationInputSchema,
  projectUpdateInputSchema,
  type Project,
  type ProjectRegistrationInput,
  type ProjectUpdateInput,
  type ProjectWithGitStatus,
} from '@orion/contracts';

import { withImmediateTransaction } from './database.js';
import { ApplicationError } from './errors.js';
import type { GitReadRunner, GitStatus, RepositorySnapshot } from './git-runner.js';
import type { ProjectPolicyService } from './project-policy.js';
import { providerPolicyHash } from './project-policy.js';
import type { ProjectRepository } from './repositories/project-repository.js';
import type { ProviderPolicyConfirmationRepository } from './repositories/provider-policy-confirmation-repository.js';
import { canonicalProjectPath } from './windows-path-policy.js';

export class ProjectRegistrationService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly projects: ProjectRepository,
    private readonly confirmations: ProviderPolicyConfirmationRepository,
    private readonly policy: ProjectPolicyService,
    private readonly git: GitReadRunner,
    private readonly canonicalize: (path: string) => string = canonicalProjectPath,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public register(
    input: ProjectRegistrationInput,
    sessionScopeHash: string,
    inImmediateTransaction = false,
  ): ProjectWithGitStatus {
    const parsed = projectRegistrationInputSchema.parse(input);
    const repositoryPath = this.canonicalize(parsed.repositoryPath);
    const before = this.git.snapshot(repositoryPath, parsed.defaultBranch);
    this.policy.assertRegistrationPolicy(
      parsed.classification,
      parsed.providerPolicy,
      parsed.allowedAgentIds,
    );
    if (this.projects.findActiveByPath(repositoryPath) !== undefined)
      throw new ApplicationError('PROJECT_CONFLICT', 'The repository is already registered.', {
        statusCode: 409,
      });
    const id = ulid();
    const project = this.createProject(parsed, repositoryPath, id);
    const after = this.git.snapshot(repositoryPath, parsed.defaultBranch);
    this.assertUnchanged(before, after);
    const persist = () => {
      if (this.projects.findActiveByPath(repositoryPath) !== undefined)
        throw new ApplicationError('PROJECT_CONFLICT', 'The repository is already registered.', {
          statusCode: 409,
        });
      const beforeCommit = this.git.snapshot(repositoryPath, parsed.defaultBranch);
      this.assertUnchanged(after, beforeCommit);
      this.projects.insert(project);
      if (parsed.providerPolicy.allowFable) {
        this.confirmations.consume(
          parsed.fableWarningConfirmationId as string,
          sessionScopeHash,
          'project-create',
          parsed.projectKey,
          null,
          providerPolicyHash(parsed.providerPolicy),
        );
      }
      this.projects.writeAudit('session', 'project.registered', project.id, {
        projectId: project.id,
      });
      return { project, git: toGitStatus(beforeCommit) };
    };
    return inImmediateTransaction ? persist() : withImmediateTransaction(this.database, persist);
  }

  public update(
    id: string,
    patch: ProjectUpdateInput,
    sessionScopeHash: string,
    inImmediateTransaction = false,
  ): ProjectWithGitStatus {
    const parsed = projectUpdateInputSchema.parse(patch);
    const current = this.projects.findActiveById(id);
    if (current === undefined)
      throw new ApplicationError('NOT_FOUND', 'The requested project is not registered.');
    const candidate = {
      ...current,
      ...stripConfirmation(parsed),
      defaultBranch: parsed.defaultBranch ?? current.defaultBranch,
      classification: parsed.classification ?? current.classification,
      providerPolicy: parsed.providerPolicy ?? current.providerPolicy,
      allowedAgentIds: parsed.allowedAgentIds ?? current.allowedAgentIds,
      allowedCommands: parsed.allowedCommands ?? current.allowedCommands,
    };
    const active =
      Number(
        (
          this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND status IN ('draft','planning','queued','running','waiting_approval')`,
            )
            .get(id) as { count: number }
        ).count,
      ) > 0;
    this.policy.assertUpdatePolicy(current, candidate, active);
    const git = this.git.validate(current.repositoryPath, candidate.defaultBranch);
    const persist = () => {
      const project = this.projects.update(id, parsed);
      if (parsed.providerPolicy?.allowFable) {
        this.confirmations.consume(
          parsed.fableWarningConfirmationId as string,
          sessionScopeHash,
          'project-update',
          null,
          id,
          providerPolicyHash(project.providerPolicy),
        );
      }
      this.projects.writeAudit('session', 'project.updated', id, { projectId: id });
      return { project, git: toGitStatus(git) };
    };
    return inImmediateTransaction ? persist() : withImmediateTransaction(this.database, persist);
  }

  public status(id: string): ProjectWithGitStatus {
    const project = this.projects.findActiveById(id);
    if (project === undefined)
      throw new ApplicationError('NOT_FOUND', 'The requested project is not registered.');
    return {
      project,
      git: toGitStatus(this.git.validate(project.repositoryPath, project.defaultBranch)),
    };
  }

  public unregister(
    id: string,
    inImmediateTransaction = false,
  ): ReturnType<ProjectRepository['unregisterWithBlockers']> {
    return this.projects.unregisterWithBlockers(id, inImmediateTransaction);
  }

  private createProject(
    input: ProjectRegistrationInput,
    repositoryPath: string,
    id: string,
  ): Project {
    const timestamp = this.now().toISOString();
    return {
      id,
      projectKey: input.projectKey,
      name: input.name,
      repositoryPath,
      defaultBranch: input.defaultBranch,
      classification: input.classification,
      providerPolicy: input.providerPolicy,
      allowedAgentIds: input.allowedAgentIds,
      allowedCommands: input.allowedCommands,
      createdAt: timestamp,
      updatedAt: timestamp,
      unregisteredAt: null,
    };
  }

  private assertUnchanged(before: RepositorySnapshot, after: RepositorySnapshot): void {
    if (
      before.defaultBranch !== after.defaultBranch ||
      before.currentBranch !== after.currentBranch ||
      before.headSha !== after.headSha ||
      before.dirty !== after.dirty ||
      before.indexHash !== after.indexHash ||
      before.trackedHash !== after.trackedHash ||
      before.untrackedHash !== after.untrackedHash ||
      before.filesHash !== after.filesHash
    ) {
      throw new ApplicationError(
        'REPOSITORY_MUTATED_DURING_REGISTRATION',
        'The repository changed while it was being validated.',
        { statusCode: 409 },
      );
    }
  }
}

function stripConfirmation(
  input: ProjectUpdateInput,
): Omit<ProjectUpdateInput, 'fableWarningConfirmationId'> {
  const patch = { ...input };
  delete patch.fableWarningConfirmationId;
  return patch;
}
function toGitStatus(status: GitStatus): GitStatus {
  return {
    defaultBranch: status.defaultBranch,
    currentBranch: status.currentBranch,
    headSha: status.headSha,
    dirty: status.dirty,
  };
}

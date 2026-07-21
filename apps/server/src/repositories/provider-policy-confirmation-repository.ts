import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';

import { ApplicationError } from '../errors.js';

export interface ProviderPolicyConfirmation {
  readonly id: string;
  readonly sessionScopeHash: string;
  readonly scope: 'project-create' | 'project-update';
  readonly projectKey: string | null;
  readonly projectId: string | null;
  readonly policyHash: string;
  readonly warningStatementVersion: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export class ProviderPolicyConfirmationRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(
    input: Omit<ProviderPolicyConfirmation, 'id' | 'consumedAt'>,
    id = ulid(),
  ): ProviderPolicyConfirmation {
    const confirmation: ProviderPolicyConfirmation = { ...input, id, consumedAt: null };
    this.database
      .prepare(
        `INSERT INTO provider_policy_confirmations (id, session_scope_hash, scope, project_key, project_id, policy_hash,
      warning_statement_version, acknowledged_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        confirmation.id,
        confirmation.sessionScopeHash,
        confirmation.scope,
        confirmation.projectKey,
        confirmation.projectId,
        confirmation.policyHash,
        confirmation.warningStatementVersion,
        this.now().toISOString(),
        confirmation.expiresAt,
      );
    return confirmation;
  }

  public consume(
    id: string,
    sessionScopeHash: string,
    scope: 'project-create' | 'project-update',
    projectKey: string | null,
    projectId: string | null,
    policyHash: string,
  ): void {
    const consumedAt = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE provider_policy_confirmations SET consumed_at = ? WHERE id = ? AND session_scope_hash = ? AND scope = ?
      AND ((project_key IS NULL AND ? IS NULL) OR project_key = ?) AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
      AND policy_hash = ? AND expires_at > ? AND consumed_at IS NULL`,
      )
      .run(
        consumedAt,
        id,
        sessionScopeHash,
        scope,
        projectKey,
        projectKey,
        projectId,
        projectId,
        policyHash,
        consumedAt,
      );
    if (result.changes !== 1) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The Fable warning confirmation is invalid or expired.',
        { statusCode: 422 },
      );
    }
  }
}

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { archiveApprovalCommandSchema, type ArchiveApprovalCommand } from '@orion/contracts';

import { withImmediateTransaction } from './database.js';
import { ApplicationError } from './errors.js';
import type { ArcaRegistryRepository } from './repositories/arca-registry-repository.js';

export function archiveActionHash(
  command: Pick<
    ArchiveApprovalCommand,
    'action' | 'sourceId' | 'projectId' | 'expectedMetadataVersion'
  >,
): string {
  const canonical = JSON.stringify({
    action: command.action,
    metadataVersion: command.expectedMetadataVersion,
    projectId: command.projectId,
    sourceId: command.sourceId,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class ArcaArchiveApprovalConsumer {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly registry: ArcaRegistryRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public consume(command: ArchiveApprovalCommand): void {
    const parsed = archiveApprovalCommandSchema.parse(command);
    if (archiveActionHash(parsed) !== parsed.actionHash) {
      throw new ApplicationError('ARCHIVE_APPROVAL_INVALID', 'The archive approval is invalid.', {
        statusCode: 409,
      });
    }
    withImmediateTransaction(this.database, () => {
      const approval = this.database
        .prepare(
          `SELECT action, source_id, project_key, metadata_version, action_hash, status, expires_at, consumed_at
        FROM approvals WHERE id = ?`,
        )
        .get(parsed.approvalId) as ApprovalRow | undefined;
      const timestamp = this.now().toISOString();
      if (
        approval === undefined ||
        approval.action !== parsed.action ||
        approval.source_id !== parsed.sourceId ||
        approval.project_key !== parsed.projectId ||
        approval.metadata_version !== parsed.expectedMetadataVersion ||
        approval.action_hash !== parsed.actionHash ||
        approval.status !== 'approved' ||
        approval.consumed_at !== null ||
        approval.expires_at <= timestamp
      ) {
        throw new ApplicationError('ARCHIVE_APPROVAL_INVALID', 'The archive approval is invalid.', {
          statusCode: 409,
        });
      }
      const consumed = this.database
        .prepare(
          `UPDATE approvals SET consumed_at = ? WHERE id = ? AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(timestamp, parsed.approvalId, timestamp);
      if (consumed.changes !== 1)
        throw new ApplicationError('ARCHIVE_APPROVAL_INVALID', 'The archive approval is invalid.', {
          statusCode: 409,
        });
      this.registry.archiveApproved(parsed.sourceId, parsed.expectedMetadataVersion);
      this.registry.writeAudit({
        actor: 'system',
        action: 'source_archived',
        sourceId: parsed.sourceId,
        requestId: null,
        projectId: parsed.projectId,
        purpose: 'archive-approval',
        decision: 'allow',
        policyVersion: 'm1',
        connectorType: null,
        timestamp,
      });
    });
  }
}

type ApprovalRow = {
  readonly action: string;
  readonly source_id: string;
  readonly project_key: string;
  readonly metadata_version: number;
  readonly action_hash: string;
  readonly status: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
};

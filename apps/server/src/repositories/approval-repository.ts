import type { DatabaseSync } from 'node:sqlite';
import { approvalSchema, type Approval } from '@orion/contracts';

export class ApprovalRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public insert(approval: Approval): void {
    const parsed = approvalSchema.parse(approval);
    this.database
      .prepare(
        `INSERT INTO approvals (id, action, source_id, project_key, metadata_version, action_hash, status, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.action,
        parsed.sourceId,
        parsed.projectKey,
        parsed.metadataVersion,
        parsed.actionHash,
        parsed.status,
        parsed.expiresAt,
        parsed.consumedAt,
      );
  }
}

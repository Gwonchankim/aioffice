import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { agentProfileSkeletonSchema, type AgentProfileSkeleton } from '@orion/contracts';

export class AgentProfileRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public find(id: string, version = 1): AgentProfileSkeleton | undefined {
    const row = this.database
      .prepare('SELECT config_json FROM agent_profiles WHERE id = ? AND version = ?')
      .get(id, version) as { config_json?: string } | undefined;
    return row?.config_json === undefined
      ? undefined
      : agentProfileSkeletonSchema.parse(JSON.parse(row.config_json));
  }

  public list(): readonly AgentProfileSkeleton[] {
    return (
      this.database.prepare('SELECT config_json FROM agent_profiles ORDER BY seed_order').all() as {
        config_json: string;
      }[]
    ).map((row) => agentProfileSkeletonSchema.parse(JSON.parse(row.config_json)));
  }

  public insert(profile: AgentProfileSkeleton, seedOrder: number): void {
    const parsed = agentProfileSkeletonSchema.parse(profile);
    const configJson = JSON.stringify(parsed);
    const checksum = createHash('sha256').update(configJson).digest('hex');
    this.database
      .prepare(
        `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 'skeleton', ?)`,
      )
      .run(parsed.id, parsed.version, seedOrder, checksum, configJson, new Date().toISOString());
  }
}

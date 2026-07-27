import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  agentProfileFullSchema,
  agentProfileSchema,
  agentProfileSkeletonSchema,
  type AgentProfile,
  type AgentProfileFull,
  type AgentProfileSkeleton,
} from '@orion/contracts';
import {
  assertSoulPolicyCompliant,
  validateProfilePermissions,
  SoulPolicyViolationError,
} from '@orion/agent-catalog';

import { ApplicationError } from '../errors.js';

/**
 * Recursively sorts object keys (arrays keep their original element order)
 * so `JSON.stringify` is deterministic. Matches the canonicalization used by
 * `packages/agent-catalog/scripts/generate-full-profile-seeds.ts` for
 * migration 0006, so recomputed hashes agree with seeded rows.
 */
export function sortProfileKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortProfileKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortProfileKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical, key-sorted JSON representation of a profile, for hashing and storage. */
export function canonicalProfileConfigJson(profile: unknown): string {
  return JSON.stringify(sortProfileKeysDeep(profile));
}

/** SHA-256 hex digest of UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export class AgentProfileRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  /** Every stored profile row (every id and version), union-parsed and ordered deterministically. */
  public listAll(): readonly AgentProfile[] {
    const rows = this.database
      .prepare('SELECT config_json FROM agent_profiles ORDER BY seed_order ASC, version ASC')
      .all() as { config_json: string }[];
    return rows.map((row) => agentProfileSchema.parse(JSON.parse(row.config_json)));
  }

  /** The latest `execution_mode = 'full'` row for every id that has one (one row per id). */
  public listActiveFullProfiles(): readonly AgentProfileFull[] {
    const rows = this.database
      .prepare(
        `SELECT config_json FROM agent_profiles outer_row
         WHERE execution_mode = 'full'
           AND version = (
             SELECT MAX(inner_row.version)
             FROM agent_profiles inner_row
             WHERE inner_row.id = outer_row.id AND inner_row.execution_mode = 'full'
           )
         ORDER BY seed_order ASC`,
      )
      .all() as { config_json: string }[];
    return rows.map((row) => agentProfileFullSchema.parse(JSON.parse(row.config_json)));
  }

  /** Every stored version number for `id`, ascending. Empty when the id is unknown. */
  public getVersions(id: string): readonly number[] {
    const rows = this.database
      .prepare('SELECT version FROM agent_profiles WHERE id = ? ORDER BY version ASC')
      .all(id) as { version: number }[];
    return rows.map((row) => row.version);
  }

  /**
   * Appends a new `full` version for an id that already has at least one
   * stored version. Rejects: schema-invalid profiles, permission-ceiling
   * violations, SOUL policy violations, and any version that is not exactly
   * one greater than the current maximum for the id (covers both version
   * jumps and duplicates). `seed_order` is read from the id's existing rows
   * and reused, so it can never drift from the invariant enforced by the
   * `agent_profiles_seed_order_consistent` trigger.
   */
  public insertFullVersion(profile: AgentProfileFull): void {
    let parsed: AgentProfileFull;
    try {
      parsed = agentProfileFullSchema.parse(profile);
    } catch (error) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The agent profile failed full schema validation.',
        { details: error },
      );
    }

    if (!validateProfilePermissions(parsed)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Profile "${parsed.id}" permissions exceed the "${parsed.permissionTemplate}" template ceiling.`,
      );
    }

    try {
      assertSoulPolicyCompliant(parsed.soulMarkdown);
    } catch (error) {
      if (error instanceof SoulPolicyViolationError) {
        throw new ApplicationError('VALIDATION_FAILED', error.message, { details: error.reasons });
      }
      throw error;
    }

    const existingRows = this.database
      .prepare('SELECT version, seed_order FROM agent_profiles WHERE id = ? ORDER BY version ASC')
      .all(parsed.id) as { version: number; seed_order: number }[];
    if (existingRows.length === 0) {
      throw new ApplicationError(
        'NOT_FOUND',
        `No existing agent profile versions were found for id "${parsed.id}".`,
      );
    }
    const maxVersion = Math.max(...existingRows.map((row) => row.version));
    if (parsed.version !== maxVersion + 1) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Profile "${parsed.id}" version must be exactly ${maxVersion + 1}, got ${parsed.version}.`,
      );
    }
    const seedOrder = existingRows[0]!.seed_order;

    const configJson = canonicalProfileConfigJson(parsed);
    const configSha256 = sha256Hex(configJson);

    this.database
      .prepare(
        `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'full', ?)`,
      )
      .run(
        parsed.id,
        parsed.version,
        seedOrder,
        configSha256,
        configJson,
        parsed.enabled ? 1 : 0,
        this.now().toISOString(),
      );
  }
}

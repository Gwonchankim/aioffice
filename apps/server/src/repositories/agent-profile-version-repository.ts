import type { DatabaseSync } from 'node:sqlite';
import {
  agentProfileVersionSchema,
  runtimeSelectionSchema,
  type AgentProfileVersion,
  type RequestableAgentOrigin,
  type RuntimeSelection,
} from '@orion/contracts';
import { soulSha256 } from '@orion/agent-catalog';

import { withImmediateTransaction } from '../database.js';
import { ApplicationError } from '../errors.js';
import { canonicalProfileConfigJson, sha256Hex } from './agent-profile-repository.js';
import { appendAgentAuditEntry, workforceError } from './agent-workforce-support.js';

export interface AgentProfileVersionInsert {
  readonly agentId: string;
  /** Must be exactly `max + 1` over the union of both version stores. */
  readonly version: number;
  /** Profile body stored verbatim; canonicalized and hashed here, then immutable. */
  readonly config: unknown;
  readonly soulMarkdown: string;
  readonly harnessMarkdown?: string;
  readonly runtimeSelection: unknown;
  readonly createdBy: string;
  readonly createdAt?: string;
  /** Optional caller-supplied hashes; a disagreement with the recomputed value is rejected. */
  readonly expectedConfigSha256?: string;
  readonly expectedSoulSha256?: string;
  readonly expectedHarnessSha256?: string;
}

interface AgentProfileVersionRow {
  readonly agent_id: string;
  readonly version: number;
  readonly config_sha256: string;
  readonly soul_sha256: string;
  readonly harness_sha256: string | null;
  readonly runtime_selection_json: string;
  readonly origin: string;
  readonly created_by: string;
  readonly created_at: string;
}

const AGENT_PROFILE_VERSION_COLUMNS =
  'agent_id, version, config_sha256, soul_sha256, harness_sha256, runtime_selection_json, origin, created_by, created_at';

/** Parses a row through `agentProfileVersionSchema` so a corrupt row can never flow onward. */
function readAgentProfileVersionRow(row: AgentProfileVersionRow): AgentProfileVersion {
  return agentProfileVersionSchema.parse({
    agentId: row.agent_id,
    version: row.version,
    configSha256: row.config_sha256,
    soulSha256: row.soul_sha256,
    harnessSha256: row.harness_sha256,
    runtimeSelection: JSON.parse(row.runtime_selection_json),
    origin: row.origin,
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

/**
 * Persistence boundary for custom agent profile versions
 * (plan-delta-003 §2.2, WFM-004/030/032).
 *
 * `agent_profile_versions` holds the **custom** id space only: built-in agents
 * keep appending to `agent_profiles` through
 * `AgentProfileRepository.insertFullVersion()` (DEC-031). Both spaces are
 * disjoint by construction, which is what makes `(agent_id, version)` unique
 * across their union.
 *
 * The table is append-only — migration 0007 rejects every UPDATE and DELETE
 * with `PROFILE_VERSIONS_APPEND_ONLY`. This repository therefore exposes **no**
 * update, delete or generic `save` method: the absence is deliberate, not an
 * omission. A changed profile is a new version, never an edited one.
 */
export class AgentProfileVersionRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Appends one immutable version for a custom agent together with its
   * `agent.version_added` audit entry, inside a single `BEGIN IMMEDIATE`
   * transaction. The existence check, the version-sequence check and both
   * inserts share that transaction, so a concurrent writer can never squeeze a
   * second `max + 1` in between and a failure leaves neither a version row nor
   * an audit row behind.
   *
   * `origin` is never taken from the request: it is read from the definition's
   * stored `origin`, which migration 0007 makes unforgeable (append-only rows,
   * `builtin` reserved for the seed). A request body that carries `origin` is
   * rejected upstream by the strict request schema.
   */
  public appendVersion(input: AgentProfileVersionInsert): AgentProfileVersion {
    try {
      return withImmediateTransaction(this.database, () => {
        const origin = this.requireCustomDefinitionOrigin(input.agentId);
        this.assertNextVersion(input.agentId, input.version);

        const configJson = canonicalProfileConfigJson(input.config);
        const configSha256 = sha256Hex(configJson);
        // HARNESS deliberately reuses the SOUL normalization (UTF-8, CRLF->LF,
        // NFC, SHA-256) from `soul-hash.ts` rather than reimplementing it, so
        // the two hashes can never drift apart (plan §6, WFM-015).
        const computedSoulSha256 = soulSha256(input.soulMarkdown);
        const harnessSha256 =
          input.harnessMarkdown === undefined ? null : soulSha256(input.harnessMarkdown);

        this.assertExpectedHash('config', input.expectedConfigSha256, configSha256);
        this.assertExpectedHash('SOUL', input.expectedSoulSha256, computedSoulSha256);
        this.assertExpectedHash('HARNESS', input.expectedHarnessSha256, harnessSha256);

        const runtimeSelection = this.parseRuntimeSelection(input.runtimeSelection);
        const createdAt = input.createdAt ?? this.now().toISOString();

        const version = this.parseVersion({
          agentId: input.agentId,
          version: input.version,
          configSha256,
          soulSha256: computedSoulSha256,
          harnessSha256,
          runtimeSelection,
          origin,
          createdBy: input.createdBy,
          createdAt,
        });

        this.database
          .prepare(
            `INSERT INTO agent_profile_versions (agent_id, version, config_sha256, config_json,
             soul_sha256, harness_sha256, runtime_selection_json, origin, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            version.agentId,
            version.version,
            version.configSha256,
            configJson,
            version.soulSha256,
            version.harnessSha256,
            canonicalProfileConfigJson(version.runtimeSelection),
            version.origin,
            version.createdBy,
            version.createdAt,
          );

        appendAgentAuditEntry(
          this.database,
          {
            action: 'agent.version_added',
            actor: version.createdBy,
            payload: {
              agentId: version.agentId,
              version: version.version,
              origin: version.origin,
              configSha256: version.configSha256,
              soulSha256: version.soulSha256,
              harnessSha256: version.harnessSha256,
              selectionMode: version.runtimeSelection.selectionMode,
              selectionSource: version.runtimeSelection.selectionSource,
            },
            createdAt: version.createdAt,
          },
          () => this.now(),
        );

        return version;
      });
    } catch (error) {
      throw workforceError(error, { agentId: input.agentId });
    }
  }

  public find(agentId: string, version: number): AgentProfileVersion | undefined {
    const row = this.database
      .prepare(
        `SELECT ${AGENT_PROFILE_VERSION_COLUMNS} FROM agent_profile_versions
         WHERE agent_id = ? AND version = ?`,
      )
      .get(agentId, version) as AgentProfileVersionRow | undefined;
    return row === undefined ? undefined : readAgentProfileVersionRow(row);
  }

  /** Stored custom version numbers for `agentId`, ascending. Empty for an unknown id. */
  public listVersions(agentId: string): readonly number[] {
    const rows = this.database
      .prepare('SELECT version FROM agent_profile_versions WHERE agent_id = ? ORDER BY version ASC')
      .all(agentId) as { version: number }[];
    return rows.map((row) => Number(row.version));
  }

  public listForAgent(agentId: string): readonly AgentProfileVersion[] {
    const rows = this.database
      .prepare(
        `SELECT ${AGENT_PROFILE_VERSION_COLUMNS} FROM agent_profile_versions
         WHERE agent_id = ? ORDER BY version ASC`,
      )
      .all(agentId) as unknown as AgentProfileVersionRow[];
    return rows.map((row) => readAgentProfileVersionRow(row));
  }

  /**
   * The definition's stored origin, rejecting the two cases this table must
   * never hold. A built-in id is refused here, at the service layer, with
   * `VALIDATION_FAILED`; the `CUSTOM_VERSION_SPACE_VIOLATION` trigger in
   * migration 0007 is the second, independent line of defence.
   */
  private requireCustomDefinitionOrigin(agentId: string): RequestableAgentOrigin {
    const row = this.database
      .prepare('SELECT origin FROM agent_definitions WHERE id = ?')
      .get(agentId) as { origin?: string } | undefined;
    if (row?.origin === undefined) {
      throw new ApplicationError(
        'NOT_FOUND',
        `No agent definition exists for id "${agentId}", so no profile version can be appended.`,
      );
    }
    if (row.origin === 'builtin') {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Agent "${agentId}" is built-in: its versions live in "agent_profiles" and are appended through the built-in profile path.`,
      );
    }
    return row.origin as RequestableAgentOrigin;
  }

  /**
   * The next version number is `max + 1` over the **union** of both version
   * stores. The spaces are disjoint, so one of the two terms is always empty —
   * the union is computed anyway so the global `(agent_id, version)` uniqueness
   * invariant holds by construction rather than by assumption (plan §2.2).
   */
  private assertNextVersion(agentId: string, version: number): void {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS max_version FROM (
           SELECT version FROM agent_profiles WHERE id = ?
           UNION ALL
           SELECT version FROM agent_profile_versions WHERE agent_id = ?
         )`,
      )
      .get(agentId, agentId) as { max_version: number };
    const expected = Number(row.max_version) + 1;
    if (version !== expected) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Agent "${agentId}" profile version must be exactly ${expected}, got ${version}.`,
      );
    }
  }

  private assertExpectedHash(
    label: 'config' | 'SOUL' | 'HARNESS',
    expected: string | undefined,
    computed: string | null,
  ): void {
    if (expected === undefined) {
      return;
    }
    if (computed === null) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `A ${label} hash was supplied but the version carries no ${label} body.`,
      );
    }
    if (expected !== computed) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `The supplied ${label} hash does not match the ${label} content.`,
      );
    }
  }

  private parseRuntimeSelection(candidate: unknown): RuntimeSelection {
    const parsed = runtimeSelectionSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The runtime selection failed schema validation.',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private parseVersion(candidate: unknown): AgentProfileVersion {
    const parsed = agentProfileVersionSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The agent profile version failed schema validation.',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }
}

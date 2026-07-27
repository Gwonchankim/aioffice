import type { DatabaseSync } from 'node:sqlite';
import {
  agentProfileFullSchema,
  runtimeSelectionSchema,
  type AgentOrigin,
  type AgentProfileFull,
  type EmploymentState,
  type RuntimeSelection,
} from '@orion/contracts';

import { MAX_REGISTERED_AGENTS } from '../config.js';
import { ApplicationError } from '../errors.js';

/**
 * One agent as the registry sees it, merged from both version stores plus its
 * employment row.
 *
 * `latestProfileVersion` and `employedActiveVersion` are **different concepts
 * and must never be collapsed**:
 * - `latestProfileVersion` is the newest stored version. It is the
 *   export/versioning authority and answers "what is the next version number,
 *   and what does `includeHistory=false` export?".
 * - `employedActiveVersion` is the version the agent is actually employed on.
 *   It is the runtime authority and answers "what would a run use?". Adding a
 *   new version never promotes an employed agent onto it (plan §2.3), so the
 *   two values legitimately differ.
 */
export interface AgentRegistryEntry {
  readonly agentId: string;
  /** Which version store owns this agent's versions. */
  readonly source: 'builtin' | 'custom';
  readonly origin: AgentOrigin;
  /** Ascending union of both stores, without duplicates. */
  readonly versions: readonly number[];
  /** Newest stored version — export/versioning authority. */
  readonly latestProfileVersion: number | null;
  readonly employmentState: EmploymentState;
  /** Runtime authority; null unless the employment state is `active`. */
  readonly employedActiveVersion: number | null;
  readonly lastActiveVersion: number | null;
  readonly revision: number;
  readonly runtimeSelection: RuntimeSelection | null;
}

export interface AgentRegistryListOptions {
  /**
   * Required on purpose: a caller must state whether it wants the runtime
   * roster (`false`) or the full registry (`true`). There is no default,
   * because defaulting either way silently changes who may be planned or
   * spawned.
   */
  readonly includeInactive: boolean;
  readonly limit?: number;
  readonly cursorAgentId?: string;
}

interface DefinitionRow {
  readonly id: string;
  readonly origin: string;
  readonly source_rank: number;
}

interface EmploymentRow {
  readonly agent_id: string;
  readonly state: string;
  readonly active_version: number | null;
  readonly last_active_version: number | null;
  readonly revision: number;
}

/**
 * The single read entry point over both agent version stores
 * (plan-delta-003 §2.2 H-1, WFM-017/030).
 *
 * `agent_profiles` holds the built-in id space and `agent_profile_versions`
 * holds the custom one. Every caller that needs "does this agent exist / which
 * versions does it have / which one runs" must come through here instead of
 * querying one table, which is what makes custom agents visible to import,
 * export and planning without changing built-in behaviour.
 *
 * This class is read-only: it contains no INSERT, UPDATE or DELETE.
 */
export class AgentRegistryReadModel {
  public constructor(private readonly database: DatabaseSync) {}

  /** The registry entry for one agent, or `undefined` when no definition exists. */
  public find(agentId: string): AgentRegistryEntry | undefined {
    return this.buildEntries().find((entry) => entry.agentId === agentId);
  }

  /**
   * Registry entries in a deterministic total order: built-ins first by
   * `agent_profiles.seed_order`, then customs by
   * `agent_definitions.created_at ASC, id ASC`. The order is total, so the
   * keyset cursor can neither skip nor repeat an entry, and paging continues
   * straight across the built-in/custom boundary.
   */
  public list(options: AgentRegistryListOptions): readonly AgentRegistryEntry[] {
    const ordered = this.buildEntries();
    const position = new Map(ordered.map((entry, index) => [entry.agentId, index]));

    const visible = options.includeInactive
      ? ordered
      : ordered.filter((entry) => entry.employmentState === 'active');

    const after = this.resolveCursorPosition(options.cursorAgentId, position);
    const page =
      after === undefined
        ? visible
        : visible.filter((entry) => position.get(entry.agentId)! > after);

    const limit = this.parseLimit(options.limit);
    return limit === undefined ? page : page.slice(0, limit);
  }

  /**
   * Every currently employed agent, in registry order. Arca is `draft` and its
   * activation is blocked on three layers (plan §2.3), so it can never appear
   * here while M3 holds.
   */
  public activeRoster(): readonly AgentRegistryEntry[] {
    return this.list({ includeInactive: false });
  }

  /**
   * The version a run for this agent would use: the **employed active**
   * version, never the newest stored one. `null` whenever the agent is unknown
   * or not `active`, which is what keeps a dismissed or suspended agent out of
   * every spawn path.
   */
  public getRunTargetVersion(agentId: string): number | null {
    const row = this.database
      .prepare('SELECT state, active_version FROM agent_employments WHERE agent_id = ?')
      .get(agentId) as { state?: string; active_version?: number | null } | undefined;
    if (row?.state !== 'active') {
      return null;
    }
    return row.active_version === null || row.active_version === undefined
      ? null
      : Number(row.active_version);
  }

  /**
   * The newest FULL version of every agent — the `includeHistory=false` export
   * set (plan §2.2 I-5).
   *
   * "Latest" here means newest stored version, **not** employed: the export set
   * is deliberately not filtered by employment, so built-in export output stays
   * byte-identical to `AgentProfileRepository.listActiveFullProfiles()`. The
   * built-in half reuses that exact query and ordering; custom versions follow,
   * in registry order. Every `agent_profile_versions` row is a full profile by
   * construction (the table has no skeleton mode), so no execution-mode filter
   * applies to the custom half.
   */
  public listLatestFullVersionPerAgent(): readonly AgentProfileFull[] {
    const builtinRows = this.database
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

    const customRows = this.database
      .prepare(
        `SELECT outer_row.config_json AS config_json
         FROM agent_profile_versions outer_row
         JOIN agent_definitions definition ON definition.id = outer_row.agent_id
         WHERE outer_row.version = (
           SELECT MAX(inner_row.version)
           FROM agent_profile_versions inner_row
           WHERE inner_row.agent_id = outer_row.agent_id
         )
         ORDER BY definition.created_at ASC, definition.id ASC`,
      )
      .all() as { config_json: string }[];

    return [...builtinRows, ...customRows].map((row) =>
      agentProfileFullSchema.parse(JSON.parse(row.config_json)),
    );
  }

  private buildEntries(): readonly AgentRegistryEntry[] {
    const definitions = this.database
      .prepare(
        `SELECT definition.id AS id,
                definition.origin AS origin,
                CASE WHEN definition.origin = 'builtin' THEN 0 ELSE 1 END AS source_rank
         FROM agent_definitions definition
         ORDER BY source_rank ASC,
                  CASE WHEN definition.origin = 'builtin'
                       THEN (SELECT MIN(profile.seed_order) FROM agent_profiles profile
                             WHERE profile.id = definition.id)
                       ELSE NULL END ASC,
                  definition.created_at ASC,
                  definition.id ASC`,
      )
      .all() as unknown as DefinitionRow[];

    const employments = new Map<string, EmploymentRow>(
      (
        this.database
          .prepare(
            'SELECT agent_id, state, active_version, last_active_version, revision FROM agent_employments',
          )
          .all() as unknown as EmploymentRow[]
      ).map((row) => [row.agent_id, row]),
    );

    const versions = new Map<string, number[]>();
    for (const row of this.database
      .prepare(
        `SELECT agent_id, version FROM (
           SELECT id AS agent_id, version FROM agent_profiles
           UNION
           SELECT agent_id, version FROM agent_profile_versions
         ) ORDER BY agent_id ASC, version ASC`,
      )
      .all() as unknown as { agent_id: string; version: number }[]) {
      const list = versions.get(row.agent_id) ?? [];
      list.push(Number(row.version));
      versions.set(row.agent_id, list);
    }

    const builtinConfigs = new Map<string, string>(
      (
        this.database
          .prepare(
            `SELECT outer_row.id AS id, outer_row.config_json AS config_json
             FROM agent_profiles outer_row
             WHERE outer_row.version = (
               SELECT MAX(inner_row.version) FROM agent_profiles inner_row
               WHERE inner_row.id = outer_row.id
             )`,
          )
          .all() as unknown as { id: string; config_json: string }[]
      ).map((row) => [row.id, row.config_json]),
    );

    const customSelections = new Map<string, string>(
      (
        this.database
          .prepare(
            `SELECT outer_row.agent_id AS agent_id,
                    outer_row.runtime_selection_json AS runtime_selection_json
             FROM agent_profile_versions outer_row
             WHERE outer_row.version = (
               SELECT MAX(inner_row.version) FROM agent_profile_versions inner_row
               WHERE inner_row.agent_id = outer_row.agent_id
             )`,
          )
          .all() as unknown as { agent_id: string; runtime_selection_json: string }[]
      ).map((row) => [row.agent_id, row.runtime_selection_json]),
    );

    return definitions.map((definition) => {
      const employment = employments.get(definition.id);
      if (employment === undefined) {
        // Every definition is created together with its `draft` employment row,
        // so a missing one means the local store was mutated outside the
        // repositories. Fail loudly rather than invent a lifecycle state.
        throw new ApplicationError(
          'DATABASE_UNAVAILABLE',
          `Agent "${definition.id}" has a definition but no employment row.`,
        );
      }

      const source = definition.origin === 'builtin' ? 'builtin' : 'custom';
      const agentVersions = versions.get(definition.id) ?? [];
      const state = employment.state as EmploymentState;

      return {
        agentId: definition.id,
        source,
        origin: definition.origin as AgentOrigin,
        versions: agentVersions,
        latestProfileVersion:
          agentVersions.length === 0 ? null : agentVersions[agentVersions.length - 1]!,
        employmentState: state,
        employedActiveVersion:
          state === 'active' && employment.active_version !== null
            ? Number(employment.active_version)
            : null,
        lastActiveVersion:
          employment.last_active_version === null ? null : Number(employment.last_active_version),
        revision: Number(employment.revision),
        runtimeSelection:
          source === 'builtin'
            ? this.deriveBuiltinRuntimeSelection(builtinConfigs.get(definition.id))
            : this.readCustomRuntimeSelection(customSelections.get(definition.id)),
      } satisfies AgentRegistryEntry;
    });
  }

  /**
   * A built-in agent has no `runtime_selection_json`: its selection is the
   * catalog recommendation carried by the stored profile config, so it is
   * always `selectionMode: 'default'` with `selectionSource: 'catalog'`
   * (plan §5). When the stored row carries no usable model information the
   * result is `null` — values are never invented to fill the gap.
   */
  private deriveBuiltinRuntimeSelection(configJson: string | undefined): RuntimeSelection | null {
    if (configJson === undefined) {
      return null;
    }
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(configJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    const candidate = runtimeSelectionSchema.safeParse({
      selectionMode: 'default',
      selectionSource: 'catalog',
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fallbackModels: config.fallbackModels ?? [],
    });
    return candidate.success ? candidate.data : null;
  }

  /** A custom agent's selection is the one stored on its newest version. */
  private readCustomRuntimeSelection(selectionJson: string | undefined): RuntimeSelection | null {
    if (selectionJson === undefined) {
      return null;
    }
    try {
      const parsed = runtimeSelectionSchema.safeParse(JSON.parse(selectionJson));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private resolveCursorPosition(
    cursorAgentId: string | undefined,
    position: ReadonlyMap<string, number>,
  ): number | undefined {
    if (cursorAgentId === undefined) {
      return undefined;
    }
    const index = position.get(cursorAgentId);
    if (index === undefined) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The pagination cursor does not identify a registered agent.',
      );
    }
    return index;
  }

  /**
   * The registry can never hold more than `MAX_REGISTERED_AGENTS` agents, so
   * that is also the largest page that can ever carry new information. A route
   * applying the API Contract §3 page size must clamp to this bound.
   */
  private parseLimit(limit: number | undefined): number | undefined {
    if (limit === undefined) {
      return undefined;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REGISTERED_AGENTS) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `A registry page size must be between 1 and ${MAX_REGISTERED_AGENTS}.`,
      );
    }
    return limit;
  }
}

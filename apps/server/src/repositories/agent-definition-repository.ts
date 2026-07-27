import type { DatabaseSync } from 'node:sqlite';
import {
  agentDefinitionSchema,
  requestableAgentOriginSchema,
  type AgentDefinition,
  type RequestableAgentOrigin,
} from '@orion/contracts';

import { MAX_REGISTERED_AGENTS } from '../config.js';
import { withImmediateTransaction } from '../database.js';
import { ApplicationError } from '../errors.js';
import {
  appendAgentAuditEntry,
  isBuiltinAgentId,
  workforceError,
} from './agent-workforce-support.js';

export interface AgentDefinitionInsert {
  readonly id: string;
  readonly name: string;
  /**
   * Server-decided origin. `builtin` is unrepresentable here: it belongs to the
   * migration 0007 seed alone (plan §2.1, DEC-031, WFM-032).
   */
  readonly origin: RequestableAgentOrigin;
  readonly createdBy: string;
  readonly createdAt?: string;
}

export interface AgentDefinitionListOptions {
  readonly limit?: number;
  readonly cursorId?: string;
}

interface AgentDefinitionRow {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly created_by: string;
  readonly created_at: string;
}

const AGENT_DEFINITION_COLUMNS = 'id, name, origin, created_by, created_at';

function readAgentDefinitionRow(row: AgentDefinitionRow): AgentDefinition {
  return agentDefinitionSchema.parse({
    id: row.id,
    name: row.name,
    origin: row.origin,
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

/**
 * Persistence boundary for agent identity (plan-delta-003 §2.1, WFM-002/003/029/032).
 *
 * `agent_definitions` is append-only: migration 0007 rejects every UPDATE and
 * DELETE with `AGENT_DEFINITION_APPEND_ONLY`. This repository therefore exposes
 * **no** update, delete, rename or generic `save` method — the absence is
 * deliberate, not an omission. A changed agent is a new profile version; a
 * withdrawn agent is an employment transition to `retired`.
 */
export class AgentDefinitionRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Registers one custom agent: the definition row, its mandatory `draft`
   * employment row, and the `agent.created` audit entry, in a single
   * `BEGIN IMMEDIATE` transaction.
   *
   * The registration count and the INSERT share that one transaction on
   * purpose: `BEGIN IMMEDIATE` takes the write lock before the count is read,
   * so two concurrent callers can never both observe 63 rows and each create a
   * 64th (WFM-029). A failure at any step leaves neither a definition row, an
   * employment row, nor an audit row behind.
   */
  public create(input: AgentDefinitionInsert): AgentDefinition {
    try {
      return withImmediateTransaction(this.database, () => {
        const origin = this.parseRequestableOrigin(input.origin);
        const definition = this.parseDefinition({
          id: input.id,
          name: input.name,
          origin,
          createdBy: input.createdBy,
          createdAt: input.createdAt ?? this.now().toISOString(),
        });

        // Built-in id shadow, first line of defence. The `agent_definitions.id`
        // primary key is the second, and it also blocks a custom id collision.
        if (isBuiltinAgentId(this.database, definition.id)) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            `Agent id "${definition.id}" is reserved by a built-in agent.`,
          );
        }

        // Cumulative high-water mark: every row counts, `retired` included,
        // because dismissal never frees a slot (plan §4).
        const registered = this.count();
        if (registered >= MAX_REGISTERED_AGENTS) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            `The registry already holds ${registered} agents, which is the ${MAX_REGISTERED_AGENTS} agent registration cap.`,
          );
        }

        this.database
          .prepare(
            `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            definition.id,
            definition.name,
            definition.origin,
            definition.createdBy,
            definition.createdAt,
          );

        // `draft` is the only initial employment state the
        // `agent_employments_initial_state` trigger accepts, and WFM-002
        // requires the row to exist the moment the definition does.
        this.database
          .prepare(
            `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
             activated_at, deactivated_at, actor, reason, revision, updated_at)
             VALUES (?, 'draft', NULL, NULL, NULL, NULL, ?, NULL, 1, ?)`,
          )
          .run(definition.id, definition.createdBy, definition.createdAt);

        appendAgentAuditEntry(
          this.database,
          {
            action: 'agent.created',
            actor: definition.createdBy,
            payload: {
              agentId: definition.id,
              origin: definition.origin,
              employmentState: 'draft',
              registeredCount: registered + 1,
            },
            createdAt: definition.createdAt,
          },
          () => this.now(),
        );

        return definition;
      });
    } catch (error) {
      throw workforceError(error, { agentId: input.id });
    }
  }

  public findById(id: string): AgentDefinition | undefined {
    const row = this.database
      .prepare(`SELECT ${AGENT_DEFINITION_COLUMNS} FROM agent_definitions WHERE id = ?`)
      .get(id) as AgentDefinitionRow | undefined;
    return row === undefined ? undefined : readAgentDefinitionRow(row);
  }

  /**
   * Definitions in `created_at ASC, id ASC` order. The ordering is total, so
   * the keyset cursor below can never skip or repeat a row.
   */
  public list(options: AgentDefinitionListOptions = {}): readonly AgentDefinition[] {
    const limit = this.parseLimit(options.limit);
    const cursor = this.resolveCursor(options.cursorId);

    const parameters: (string | number)[] = [];
    let where = '';
    if (cursor !== undefined) {
      where = 'WHERE created_at > ? OR (created_at = ? AND id > ?)';
      parameters.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    let limitClause = '';
    if (limit !== undefined) {
      limitClause = 'LIMIT ?';
      parameters.push(limit);
    }

    const rows = this.database
      .prepare(
        `SELECT ${AGENT_DEFINITION_COLUMNS} FROM agent_definitions
       ${where}
       ORDER BY created_at ASC, id ASC
       ${limitClause}`,
      )
      .all(...(parameters as [])) as unknown as AgentDefinitionRow[];
    return rows.map((row) => readAgentDefinitionRow(row));
  }

  /** Every definition row, `retired` agents included — the WFM-029 accounting basis. */
  public count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS total FROM agent_definitions').get() as {
      total: number;
    };
    return Number(row.total);
  }

  private parseRequestableOrigin(origin: RequestableAgentOrigin): RequestableAgentOrigin {
    const parsed = requestableAgentOriginSchema.safeParse(origin);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'A created agent origin must be "user_created", "manager_proposed" or "imported"; "builtin" is reserved for the migration seed.',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private parseDefinition(candidate: {
    readonly id: string;
    readonly name: string;
    readonly origin: RequestableAgentOrigin;
    readonly createdBy: string;
    readonly createdAt: string;
  }): AgentDefinition {
    const parsed = agentDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The agent definition failed schema validation.',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private parseLimit(limit: number | undefined): number | undefined {
    if (limit === undefined) {
      return undefined;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REGISTERED_AGENTS) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `A definition page size must be between 1 and ${MAX_REGISTERED_AGENTS}.`,
      );
    }
    return limit;
  }

  private resolveCursor(cursorId: string | undefined): AgentDefinitionRow | undefined {
    if (cursorId === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(`SELECT ${AGENT_DEFINITION_COLUMNS} FROM agent_definitions WHERE id = ?`)
      .get(cursorId) as AgentDefinitionRow | undefined;
    if (row === undefined) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The pagination cursor does not identify a known agent definition.',
      );
    }
    return row;
  }
}

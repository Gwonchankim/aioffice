import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import {
  registerSourceInputSchema,
  sourceCardSchema,
  sourceRequestCreateInputSchema,
  sourceRequestSchema,
  type RegisterSourceInput,
  type SourceCard,
  type SourceCardStatus,
  type SourceRequest,
  type SourceRequestCreateInput,
} from '@orion/contracts';

import { ApplicationError } from '../errors.js';
import { withImmediateTransaction } from '../database.js';

export interface RegistryScope {
  readonly actor: string;
  readonly roles: readonly string[];
  readonly projectKeys: readonly string[];
  readonly purpose: string;
  readonly classificationAllowance: 'public' | 'internal' | 'confidential' | 'controlled';
  readonly policyVersion: string;
  readonly allowedOperations: readonly string[];
}
export interface ArcaAuditMetadata {
  readonly actor: string;
  readonly action: string;
  readonly sourceId: string | null;
  readonly requestId: string | null;
  readonly projectId: string | null;
  readonly purpose: string;
  readonly decision: 'allow' | 'deny';
  readonly policyVersion: string;
  readonly connectorType: string | null;
  readonly timestamp: string;
  readonly locator?: string;
  readonly excerptStart?: number;
  readonly excerptEnd?: number;
  readonly contentHash?: string;
}

type AuditSupplement = Partial<
  Pick<
    ArcaAuditMetadata,
    'connectorType' | 'locator' | 'excerptStart' | 'excerptEnd' | 'contentHash'
  >
>;

const auditActions = new Set([
  'source_registered',
  'source_lookup_not_found',
  'source_request_created',
  'source_request_resolved',
  'source_request_cancelled',
  'source_lifecycle_changed',
  'source_archived',
]);
const auditKeys = new Set([
  'actor',
  'action',
  'sourceId',
  'requestId',
  'projectId',
  'purpose',
  'decision',
  'policyVersion',
  'connectorType',
  'timestamp',
  'locator',
  'excerptStart',
  'excerptEnd',
  'contentHash',
]);
const connectorTypes = new Set(['local-folder', 'registered-git', 'google-drive', 'nas']);

const classificationRank = { public: 0, internal: 1, confidential: 2, controlled: 3 } as const;

export class ArcaRegistryRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
    private readonly ids: () => string = ulid,
  ) {}

  public registerSource(input: RegisterSourceInput, scope: RegistryScope): SourceCard {
    const parsed = registerSourceInputSchema.parse(input);
    this.assertScope(scope, parsed.projectId, 'sourcecard-register', parsed.classification);
    const timestamp = this.now().toISOString();
    const card = sourceCardSchema.parse({
      ...parsed,
      sourceId: this.ids(),
      summary: parsed.summary ?? null,
      recordedAt: timestamp,
      lastVerifiedAt: timestamp,
      status: 'active',
      metadataVersion: 1,
    });
    return withImmediateTransaction(this.database, () => {
      if (card.supersedesSourceId !== null) {
        const predecessor = this.loadCard(card.supersedesSourceId);
        if (
          predecessor === undefined ||
          predecessor.projectId !== card.projectId ||
          !['active', 'stale', 'missing'].includes(predecessor.status)
        ) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            'The source predecessor is not eligible for supersession.',
            { statusCode: 422 },
          );
        }
        if (this.hasLineage(card.supersedesSourceId, card.sourceId)) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            'The source lineage would create a cycle.',
            { statusCode: 422 },
          );
        }
        this.updateCardStatus(predecessor, 'superseded', predecessor.metadataVersion);
      }
      this.insertCard(card);
      this.writeScopedAudit(
        scope,
        'source_registered',
        card.sourceId,
        null,
        card.projectId,
        'allow',
        { connectorType: card.connectorType },
      );
      return card;
    });
  }

  public findVisibleById(sourceId: string, scope: RegistryScope): SourceCard | undefined {
    const cards = this.visibleCards(scope, 'sourcecard-update', 'source_cards.source_id = ?', [
      sourceId,
    ]);
    const card = cards[0];
    if (card === undefined) {
      this.writeScopedAudit(scope, 'source_lookup_not_found', null, null, null, 'deny', {});
    }
    return card;
  }

  public searchVisible(term: string, scope: RegistryScope): readonly SourceCard[] {
    if (!scope.allowedOperations.includes('registry-search')) return [];
    if (scope.projectKeys.length === 0 || scope.roles.length === 0) return [];
    const query = normalizeFtsTerm(term);
    if (query.length === 0) return [];
    try {
      return this.visibleCards(scope, 'registry-search', 'source_cards_fts MATCH ?', [query]);
    } catch {
      return [];
    }
  }

  public createRequest(input: SourceRequestCreateInput, scope: RegistryScope): SourceRequest {
    const parsed = sourceRequestCreateInputSchema.parse(input);
    this.assertScope(scope, parsed.projectId, 'sourcerequest-create', 'public');
    const request = sourceRequestSchema.parse({
      ...parsed,
      requestId: this.ids(),
      requestedAt: this.now().toISOString(),
      resolvedBySourceId: null,
      resolvedAt: null,
      status: 'open',
      metadataVersion: 1,
    });
    this.database
      .prepare(
        `INSERT INTO source_requests (request_id, project_id, requested_material, criteria, acceptable_formats_json, expected_locations_json,
      purpose, requester_role, requested_at, resolved_by_source_id, resolved_at, status, metadata_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'open', 1)`,
      )
      .run(
        request.requestId,
        request.projectId,
        request.requestedMaterial,
        request.criteria,
        JSON.stringify(request.acceptableFormats),
        JSON.stringify(request.expectedLocations),
        request.purpose,
        request.requesterRole,
        request.requestedAt,
      );
    this.writeScopedAudit(
      scope,
      'source_request_created',
      null,
      request.requestId,
      request.projectId,
      'allow',
      {},
    );
    return request;
  }

  public resolveRequest(
    requestId: string,
    expectedMetadataVersion: number,
    sourceId: string,
    scope: RegistryScope,
  ): SourceRequest {
    return withImmediateTransaction(this.database, () => {
      const request = this.loadRequest(requestId);
      if (request === undefined)
        throw new ApplicationError('NOT_FOUND', 'The source request does not exist.');
      this.assertScope(scope, request.projectId, 'sourcerequest-resolve', 'public');
      if (request.status !== 'open' || request.metadataVersion !== expectedMetadataVersion)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The source request version no longer matches.',
          { statusCode: 409 },
        );
      const source = this.loadCard(sourceId);
      if (
        source === undefined ||
        source.projectId !== request.projectId ||
        source.status === 'archived'
      )
        throw new ApplicationError('VALIDATION_FAILED', 'The resolution source is not available.', {
          statusCode: 422,
        });
      const resolvedAt = this.now().toISOString();
      const result = this.database
        .prepare(
          `UPDATE source_requests SET resolved_by_source_id = ?, resolved_at = ?, status = 'resolved', metadata_version = metadata_version + 1
        WHERE request_id = ? AND status = 'open' AND metadata_version = ?`,
        )
        .run(sourceId, resolvedAt, requestId, expectedMetadataVersion);
      if (result.changes !== 1)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The source request version no longer matches.',
          { statusCode: 409 },
        );
      const resolved = sourceRequestSchema.parse({
        ...request,
        resolvedBySourceId: sourceId,
        resolvedAt,
        status: 'resolved',
        metadataVersion: request.metadataVersion + 1,
      });
      this.writeScopedAudit(
        scope,
        'source_request_resolved',
        sourceId,
        requestId,
        request.projectId,
        'allow',
        {},
      );
      return resolved;
    });
  }

  public cancelRequest(
    requestId: string,
    expectedMetadataVersion: number,
    scope: RegistryScope,
  ): SourceRequest {
    return withImmediateTransaction(this.database, () => {
      const request = this.loadRequest(requestId);
      if (request === undefined)
        throw new ApplicationError('NOT_FOUND', 'The source request does not exist.');
      this.assertScope(scope, request.projectId, 'sourcerequest-resolve', 'public');
      if (request.status !== 'open' || request.metadataVersion !== expectedMetadataVersion)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The source request version no longer matches.',
          { statusCode: 409 },
        );
      const result = this.database
        .prepare(
          `UPDATE source_requests SET status = 'cancelled', metadata_version = metadata_version + 1
        WHERE request_id = ? AND status = 'open' AND metadata_version = ?`,
        )
        .run(requestId, expectedMetadataVersion);
      if (result.changes !== 1)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The source request version no longer matches.',
          { statusCode: 409 },
        );
      const cancelled = sourceRequestSchema.parse({
        ...request,
        status: 'cancelled',
        metadataVersion: request.metadataVersion + 1,
      });
      this.writeScopedAudit(
        scope,
        'source_request_cancelled',
        null,
        requestId,
        request.projectId,
        'allow',
        {},
      );
      return cancelled;
    });
  }

  public transitionCard(
    sourceId: string,
    expectedMetadataVersion: number,
    to: SourceCardStatus,
    scope: RegistryScope,
  ): SourceCard {
    return withImmediateTransaction(this.database, () => {
      const card = this.findVisibleById(sourceId, scope);
      if (card === undefined)
        throw new ApplicationError('NOT_FOUND', 'The source is not available.');
      if (
        card.metadataVersion !== expectedMetadataVersion ||
        !allowedCardTransition(card.status, to)
      )
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'The source card version or lifecycle is no longer valid.',
          { statusCode: 409 },
        );
      this.updateCardStatus(card, to, expectedMetadataVersion);
      const result = sourceCardSchema.parse({
        ...card,
        status: to,
        metadataVersion: card.metadataVersion + 1,
      });
      this.writeScopedAudit(
        scope,
        'source_lifecycle_changed',
        card.sourceId,
        null,
        card.projectId,
        'allow',
        {},
      );
      return result;
    });
  }

  public archiveApproved(sourceId: string, expectedMetadataVersion: number): SourceCard {
    const card = this.loadCard(sourceId);
    if (
      card === undefined ||
      !allowedCardTransition(card.status, 'archived') ||
      card.metadataVersion !== expectedMetadataVersion
    )
      throw new ApplicationError(
        'ARCHIVE_APPROVAL_INVALID',
        'The archive command cannot be applied.',
        { statusCode: 409 },
      );
    this.updateCardStatus(card, 'archived', expectedMetadataVersion);
    return sourceCardSchema.parse({
      ...card,
      status: 'archived',
      metadataVersion: card.metadataVersion + 1,
    });
  }

  public writeAudit(entry: ArcaAuditMetadata): void {
    const parsed = parseAuditMetadata(entry);
    const metadata = {
      ...(parsed.locator === undefined ? {} : { locator: parsed.locator }),
      ...(parsed.excerptStart === undefined ? {} : { excerptStart: parsed.excerptStart }),
      ...(parsed.excerptEnd === undefined ? {} : { excerptEnd: parsed.excerptEnd }),
      ...(parsed.contentHash === undefined ? {} : { contentHash: parsed.contentHash }),
    };
    this.database
      .prepare(
        `INSERT INTO registry_audit_log (id, actor, action, source_id, request_id, project_id, purpose, decision, policy_version, connector_type, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ids(),
        parsed.actor,
        parsed.action,
        parsed.sourceId,
        parsed.requestId,
        parsed.projectId,
        parsed.purpose,
        parsed.decision,
        parsed.policyVersion,
        parsed.connectorType,
        JSON.stringify(metadata),
        parsed.timestamp,
      );
  }

  private writeScopedAudit(
    scope: RegistryScope,
    action: string,
    sourceId: string | null,
    requestId: string | null,
    projectId: string | null,
    decision: 'allow' | 'deny',
    metadata: AuditSupplement,
  ): void {
    this.writeAudit({
      actor: scope.actor,
      action,
      sourceId,
      requestId,
      projectId,
      purpose: scope.purpose,
      decision,
      policyVersion: scope.policyVersion,
      connectorType: metadata.connectorType ?? null,
      timestamp: this.now().toISOString(),
      ...(metadata.locator === undefined ? {} : { locator: metadata.locator }),
      ...(metadata.excerptStart === undefined ? {} : { excerptStart: metadata.excerptStart }),
      ...(metadata.excerptEnd === undefined ? {} : { excerptEnd: metadata.excerptEnd }),
      ...(metadata.contentHash === undefined ? {} : { contentHash: metadata.contentHash }),
    });
  }

  private insertCard(card: SourceCard): void {
    this.database
      .prepare(
        `INSERT INTO source_cards (source_id, title, summary, project_id, connector_type, locator, owner, classification, version, checksum_algorithm,
      checksum, recorded_at, last_verified_at, status, supersedes_source_id, metadata_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.sourceId,
        card.title,
        card.summary,
        card.projectId,
        card.connectorType,
        card.locator,
        card.owner,
        card.classification,
        card.version,
        card.checksumAlgorithm,
        card.checksum,
        card.recordedAt,
        card.lastVerifiedAt,
        card.status,
        card.supersedesSourceId,
        card.metadataVersion,
      );
    for (const tag of card.tags)
      this.database
        .prepare('INSERT INTO source_card_tags (source_id, tag) VALUES (?, ?)')
        .run(card.sourceId, tag);
    for (const role of card.allowedRoles)
      this.database
        .prepare('INSERT INTO source_card_roles (source_id, role) VALUES (?, ?)')
        .run(card.sourceId, role);
    this.database
      .prepare(
        'INSERT INTO source_cards_fts (source_id, title, summary, tags, project_id, locator, owner, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        card.sourceId,
        card.title,
        card.summary ?? '',
        card.tags.join(' '),
        card.projectId,
        card.locator,
        card.owner,
        card.status,
      );
  }

  private updateCardStatus(
    card: SourceCard,
    status: SourceCardStatus,
    expectedMetadataVersion: number,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE source_cards SET status = ?, metadata_version = metadata_version + 1
      WHERE source_id = ? AND metadata_version = ?`,
      )
      .run(status, card.sourceId, expectedMetadataVersion);
    if (result.changes !== 1)
      throw new ApplicationError('PROJECT_CONFLICT', 'The source card version no longer matches.', {
        statusCode: 409,
      });
    this.database
      .prepare(`UPDATE source_cards_fts SET status = ? WHERE source_id = ?`)
      .run(status, card.sourceId);
  }

  private visibleCards(
    scope: RegistryScope,
    operation: string,
    clause: string,
    clauseValues: readonly (string | number | null)[],
  ): readonly SourceCard[] {
    if (
      !scope.allowedOperations.includes(operation) ||
      scope.projectKeys.length === 0 ||
      scope.roles.length === 0
    )
      return [];
    const projects = placeholders(scope.projectKeys.length);
    const roles = placeholders(scope.roles.length);
    const maximum = classificationRank[scope.classificationAllowance];
    const rows = this.database
      .prepare(
        `SELECT source_cards.* FROM source_cards JOIN source_cards_fts ON source_cards_fts.source_id = source_cards.source_id
      WHERE ${clause} AND source_cards.project_id IN (${projects}) AND CASE source_cards.classification
        WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 WHEN 'controlled' THEN 3 END <= ?
      AND EXISTS (SELECT 1 FROM source_card_roles WHERE source_card_roles.source_id = source_cards.source_id AND source_card_roles.role IN (${roles}))
      ORDER BY source_cards.source_id LIMIT 100`,
      )
      .all(...clauseValues, ...scope.projectKeys, maximum, ...scope.roles) as SourceCardRow[];
    return rows.map((row) => this.rowToCard(row));
  }

  private loadCard(sourceId: string): SourceCard | undefined {
    const row = this.database
      .prepare('SELECT * FROM source_cards WHERE source_id = ?')
      .get(sourceId) as SourceCardRow | undefined;
    return row === undefined ? undefined : this.rowToCard(row);
  }

  private loadRequest(requestId: string): SourceRequest | undefined {
    const row = this.database
      .prepare('SELECT * FROM source_requests WHERE request_id = ?')
      .get(requestId) as SourceRequestRow | undefined;
    if (row === undefined) return undefined;
    return sourceRequestSchema.parse({
      requestId: row.request_id,
      projectId: row.project_id,
      requestedMaterial: row.requested_material,
      criteria: row.criteria,
      acceptableFormats: JSON.parse(row.acceptable_formats_json),
      expectedLocations: JSON.parse(row.expected_locations_json),
      purpose: row.purpose,
      requesterRole: row.requester_role,
      requestedAt: row.requested_at,
      resolvedBySourceId: row.resolved_by_source_id,
      resolvedAt: row.resolved_at,
      status: row.status,
      metadataVersion: row.metadata_version,
    });
  }

  private rowToCard(row: SourceCardRow): SourceCard {
    const tags = (
      this.database
        .prepare('SELECT tag FROM source_card_tags WHERE source_id = ? ORDER BY tag')
        .all(row.source_id) as { tag: string }[]
    ).map((entry) => entry.tag);
    const roles = (
      this.database
        .prepare('SELECT role FROM source_card_roles WHERE source_id = ? ORDER BY role')
        .all(row.source_id) as { role: string }[]
    ).map((entry) => entry.role);
    return sourceCardSchema.parse({
      sourceId: row.source_id,
      title: row.title,
      summary: row.summary,
      tags,
      projectId: row.project_id,
      connectorType: row.connector_type,
      locator: row.locator,
      owner: row.owner,
      classification: row.classification,
      allowedRoles: roles,
      version: row.version,
      checksumAlgorithm: row.checksum_algorithm,
      checksum: row.checksum,
      recordedAt: row.recorded_at,
      lastVerifiedAt: row.last_verified_at,
      status: row.status,
      supersedesSourceId: row.supersedes_source_id,
      metadataVersion: row.metadata_version,
    });
  }

  private assertScope(
    scope: RegistryScope,
    projectId: string,
    operation: string,
    classification: keyof typeof classificationRank,
  ): void {
    if (
      !scope.allowedOperations.includes(operation) ||
      !scope.projectKeys.includes(projectId) ||
      classificationRank[classification] > classificationRank[scope.classificationAllowance]
    )
      throw new ApplicationError('SESSION_REQUIRED', 'The registry operation is not authorized.', {
        statusCode: 403,
      });
  }

  private hasLineage(predecessorId: string, candidateId: string): boolean {
    let current: string | null = predecessorId;
    const seen = new Set<string>();
    while (current !== null) {
      if (current === candidateId || seen.has(current)) return true;
      seen.add(current);
      const row = this.database
        .prepare('SELECT supersedes_source_id FROM source_cards WHERE source_id = ?')
        .get(current) as { supersedes_source_id: string | null } | undefined;
      current = row?.supersedes_source_id ?? null;
    }
    return false;
  }
}

type SourceCardRow = {
  readonly source_id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly project_id: string;
  readonly connector_type: 'local-folder' | 'registered-git' | 'google-drive' | 'nas';
  readonly locator: string;
  readonly owner: string;
  readonly classification: 'public' | 'internal' | 'confidential' | 'controlled';
  readonly version: string;
  readonly checksum_algorithm: 'sha256';
  readonly checksum: string;
  readonly recorded_at: string;
  readonly last_verified_at: string;
  readonly status: SourceCardStatus;
  readonly supersedes_source_id: string | null;
  readonly metadata_version: number;
};
type SourceRequestRow = {
  readonly request_id: string;
  readonly project_id: string;
  readonly requested_material: string;
  readonly criteria: string | null;
  readonly acceptable_formats_json: string;
  readonly expected_locations_json: string;
  readonly purpose: string;
  readonly requester_role: string;
  readonly requested_at: string;
  readonly resolved_by_source_id: string | null;
  readonly resolved_at: string | null;
  readonly status: 'open' | 'resolved' | 'cancelled';
  readonly metadata_version: number;
};
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
function normalizeFtsTerm(term: string): string {
  return term.normalize('NFC').trim().replaceAll('"', '""').slice(0, 256);
}
function allowedCardTransition(from: SourceCardStatus, to: SourceCardStatus): boolean {
  return (
    {
      active: ['stale', 'missing', 'superseded', 'archived'],
      stale: ['active', 'missing', 'superseded', 'archived'],
      missing: ['active', 'superseded', 'archived'],
      superseded: ['archived'],
      archived: [],
    } as Record<SourceCardStatus, readonly SourceCardStatus[]>
  )[from].includes(to);
}
function parseAuditMetadata(entry: ArcaAuditMetadata): ArcaAuditMetadata {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    Object.keys(entry).some((key) => !auditKeys.has(key)) ||
    Object.values(entry).some((value) => typeof value === 'object' && value !== null)
  ) {
    throw invalidAuditMetadata();
  }
  if (
    !isAuditString(entry.actor, 128) ||
    !auditActions.has(entry.action) ||
    !isNullableAuditString(entry.sourceId, 128) ||
    !isNullableAuditString(entry.requestId, 128) ||
    !isNullableAuditString(entry.projectId, 128) ||
    !isAuditString(entry.purpose, 500) ||
    (entry.decision !== 'allow' && entry.decision !== 'deny') ||
    !isAuditString(entry.policyVersion, 128) ||
    (entry.connectorType !== null &&
      (typeof entry.connectorType !== 'string' || !connectorTypes.has(entry.connectorType))) ||
    !isUtcTimestamp(entry.timestamp) ||
    (entry.locator !== undefined && !isAuditString(entry.locator, 2048)) ||
    (entry.excerptStart !== undefined && !isNonNegativeInteger(entry.excerptStart)) ||
    (entry.excerptEnd !== undefined && !isNonNegativeInteger(entry.excerptEnd)) ||
    (entry.excerptStart !== undefined &&
      entry.excerptEnd !== undefined &&
      entry.excerptEnd < entry.excerptStart) ||
    (entry.contentHash !== undefined &&
      (typeof entry.contentHash !== 'string' ||
        !/^(?:sha256:)?[a-f0-9]{64}$/.test(entry.contentHash)))
  ) {
    throw invalidAuditMetadata();
  }
  return entry;
}

function isAuditString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isNullableAuditString(value: unknown, maximum: number): value is string | null {
  return value === null || isAuditString(value, maximum);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.endsWith('Z') &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function invalidAuditMetadata(): ApplicationError {
  return new ApplicationError(
    'VALIDATION_FAILED',
    'Registry audit accepts approved metadata fields only.',
    { statusCode: 422 },
  );
}

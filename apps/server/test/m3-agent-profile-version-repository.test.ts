import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { soulSha256 } from '@orion/agent-catalog';
import type { AgentProfileFull, RequestableAgentOrigin, RuntimeSelection } from '@orion/contracts';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import {
  AgentProfileRepository,
  canonicalProfileConfigJson,
  sha256Hex,
} from '../src/repositories/agent-profile-repository.js';
import { AgentDefinitionRepository } from '../src/repositories/agent-definition-repository.js';
import { AgentProfileVersionRepository } from '../src/repositories/agent-profile-version-repository.js';

const iso = '2026-07-27T00:00:00.000Z';
const sha = 'a'.repeat(64);

const SOUL = '# SOUL\nI review changes carefully and never weaken a gate.\n';
const HARNESS = '# HARNESS\nRun the gates, report the exit codes verbatim.\n';

const OVERRIDE_SELECTION: RuntimeSelection = {
  selectionMode: 'override',
  selectionSource: 'user',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  fallbackModels: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
};

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-profile-versions-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  const now = () => new Date(iso);
  return {
    database: handle.database,
    definitions: new AgentDefinitionRepository(handle.database, now),
    versions: new AgentProfileVersionRepository(handle.database, now),
    profiles: new AgentProfileRepository(handle.database, now),
  };
}

type Database = ReturnType<typeof setup>['database'];

function count(database: Database, sql: string, ...parameters: unknown[]): number {
  const row = database.prepare(sql).get(...(parameters as [])) as { count: number };
  return Number(row.count);
}

interface RegistryCounts {
  readonly versions: number;
  readonly auditEntries: number;
}

function snapshotCounts(database: Database): RegistryCounts {
  return {
    versions: count(database, 'SELECT COUNT(*) AS count FROM agent_profile_versions'),
    auditEntries: count(database, 'SELECT COUNT(*) AS count FROM audit_log'),
  };
}

function expectApplicationError(run: () => unknown): ApplicationError {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ApplicationError);
  return caught as ApplicationError;
}

function defineCustom(
  definitions: AgentDefinitionRepository,
  id: string,
  origin: RequestableAgentOrigin = 'user_created',
): string {
  definitions.create({ id, name: 'Custom Agent', origin, createdBy: 'local-user', createdAt: iso });
  return id;
}

function versionInput(agentId: string, version: number, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    version,
    config: { id: agentId, version, description: 'a custom agent profile body' },
    soulMarkdown: SOUL,
    runtimeSelection: OVERRIDE_SELECTION,
    createdBy: 'local-user',
    createdAt: iso,
    ...overrides,
  };
}

/** The shipped `atlas` v2 profile, re-versioned — a valid full profile by construction. */
function atlasNextFullVersion(database: Database, version: number): AgentProfileFull {
  const row = database
    .prepare("SELECT config_json FROM agent_profiles WHERE id = 'atlas' AND version = 2")
    .get() as { config_json: string };
  return { ...(JSON.parse(row.config_json) as AgentProfileFull), version };
}

describe('M3 AgentProfileVersionRepository', () => {
  it('WFM-004: appends v1 then v2 and rejects a repeat or a skipped version', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'zeta-one');

    const first = versions.appendVersion(versionInput('zeta-one', 1));
    expect(first).toMatchObject({
      agentId: 'zeta-one',
      version: 1,
      origin: 'user_created',
      harnessSha256: null,
      createdBy: 'local-user',
      createdAt: iso,
    });
    expect(first.runtimeSelection).toEqual(OVERRIDE_SELECTION);

    const second = versions.appendVersion(
      versionInput('zeta-one', 2, { harnessMarkdown: HARNESS }),
    );
    expect(second.version).toBe(2);
    expect(second.harnessSha256).toBe(soulSha256(HARNESS));

    const before = snapshotCounts(database);
    const repeated = expectApplicationError(() =>
      versions.appendVersion(versionInput('zeta-one', 1)),
    );
    expect(repeated.code).toBe('VALIDATION_FAILED');
    expect(repeated.message).toContain('must be exactly 3');
    const skipped = expectApplicationError(() =>
      versions.appendVersion(versionInput('zeta-one', 4)),
    );
    expect(skipped.code).toBe('VALIDATION_FAILED');
    expect(snapshotCounts(database)).toEqual(before);

    expect(versions.listVersions('zeta-one')).toEqual([1, 2]);
    expect(versions.listForAgent('zeta-one').map((entry) => entry.version)).toEqual([1, 2]);
    expect(versions.find('zeta-one', 2)).toEqual(second);
    expect(versions.find('zeta-one', 9)).toBeUndefined();
    expect(versions.listVersions('never-defined')).toEqual([]);
  });

  it('WFM-004: the first version must be 1', () => {
    const { definitions, versions } = setup();
    defineCustom(definitions, 'zeta-two');

    expect(
      expectApplicationError(() => versions.appendVersion(versionInput('zeta-two', 2))).message,
    ).toContain('must be exactly 1');
    expect(
      expectApplicationError(() => versions.appendVersion(versionInput('zeta-two', 0))).code,
    ).toBe('VALIDATION_FAILED');
    expect(versions.appendVersion(versionInput('zeta-two', 1)).version).toBe(1);
  });

  it('WFM-032: the stored origin is the definition origin, never a request value', () => {
    const { definitions, versions } = setup();

    for (const origin of ['user_created', 'manager_proposed', 'imported'] as const) {
      const agentId = `origin-${origin.replace(/_/g, '-')}`;
      defineCustom(definitions, agentId, origin);
      // The insert input has no `origin` field at all: the server reads it from
      // the append-only definition row.
      const version = versions.appendVersion(versionInput(agentId, 1));
      expect(version.origin).toBe(origin);
    }
  });

  it('WFM-030: a built-in id is refused at the service layer and by the database', () => {
    const { database, versions } = setup();
    const before = snapshotCounts(database);

    // Service layer: built-in versions belong in `agent_profiles`.
    const rejected = expectApplicationError(() => versions.appendVersion(versionInput('atlas', 3)));
    expect(rejected.code).toBe('VALIDATION_FAILED');
    expect(rejected.statusCode).toBe(422);
    expect(rejected.message).toContain('built-in');
    expect(snapshotCounts(database)).toEqual(before);

    // Database layer: the same insert issued directly is still refused.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profile_versions (agent_id, version, config_sha256, config_json,
           soul_sha256, harness_sha256, runtime_selection_json, origin, created_by, created_at)
           VALUES ('atlas', 3, ?, '{}', ?, NULL, '{}', 'user_created', 'local-user', ?)`,
        )
        .run(sha, sha, iso),
    ).toThrow(/CUSTOM_VERSION_SPACE_VIOLATION/);
    expect(snapshotCounts(database)).toEqual(before);
  });

  it('WFM-030: a custom id cannot enter the built-in table and built-in appends still work', () => {
    const { database, definitions, versions, profiles } = setup();
    defineCustom(definitions, 'zeta-three');
    versions.appendVersion(versionInput('zeta-three', 1));

    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
           VALUES ('zeta-three', 1, 1, ?, '{"id":"zeta-three"}', 1, 'full', ?)`,
        )
        .run(sha, iso),
    ).toThrow(/BUILTIN_PROFILE_SPACE_VIOLATION/);

    // Regression: the built-in append path is untouched by the new guards.
    expect(() => profiles.insertFullVersion(atlasNextFullVersion(database, 3))).not.toThrow();
    expect(profiles.getVersions('atlas')).toEqual([1, 2, 3]);

    // And the union still holds no duplicate `(id, version)` pair.
    expect(
      database
        .prepare(
          `SELECT id, version FROM (
             SELECT id, version FROM agent_profiles
             UNION ALL
             SELECT agent_id AS id, version FROM agent_profile_versions
           ) GROUP BY id, version HAVING COUNT(*) > 1`,
        )
        .all(),
    ).toEqual([]);
  });

  it('WFM-004: stored versions are append-only in the database and in the repository surface', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'zeta-four');
    versions.appendVersion(versionInput('zeta-four', 1));

    expect(() =>
      database.prepare("UPDATE agent_profile_versions SET config_json = '{}'").run(),
    ).toThrow(/PROFILE_VERSIONS_APPEND_ONLY/);
    expect(() => database.prepare('DELETE FROM agent_profile_versions').run()).toThrow(
      /PROFILE_VERSIONS_APPEND_ONLY/,
    );
    expect(versions.listVersions('zeta-four')).toEqual([1]);

    for (const name of ['update', 'delete', 'remove', 'save', 'upsert', 'replaceVersion']) {
      expect(name in AgentProfileVersionRepository.prototype).toBe(false);
    }
  });

  it('returns NOT_FOUND when no definition owns the id', () => {
    const { database, versions } = setup();
    const before = snapshotCounts(database);

    const missing = expectApplicationError(() =>
      versions.appendVersion(versionInput('ghost-agent', 1)),
    );
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.statusCode).toBe(404);
    expect(snapshotCounts(database)).toEqual(before);
  });

  it('WFM-015: SOUL and HARNESS hashes ignore CRLF and NFC differences', () => {
    const { definitions, versions } = setup();
    const lfSoul = '# SOUL\ncafé stays café.\n';
    const crlfDecomposedSoul = '# SOUL\r\ncafé stays café.\r\n';

    defineCustom(definitions, 'hash-lf');
    defineCustom(definitions, 'hash-crlf');
    const lf = versions.appendVersion(
      versionInput('hash-lf', 1, { soulMarkdown: lfSoul, harnessMarkdown: HARNESS }),
    );
    const crlf = versions.appendVersion(
      versionInput('hash-crlf', 1, {
        soulMarkdown: crlfDecomposedSoul,
        harnessMarkdown: HARNESS.replace(/\n/g, '\r\n'),
      }),
    );

    expect(crlf.soulSha256).toBe(lf.soulSha256);
    expect(crlf.harnessSha256).toBe(lf.harnessSha256);
    expect(lf.soulSha256).toBe(soulSha256(lfSoul));

    // A caller may therefore supply the hash of either spelling.
    defineCustom(definitions, 'hash-expected');
    expect(() =>
      versions.appendVersion(
        versionInput('hash-expected', 1, {
          soulMarkdown: lfSoul,
          expectedSoulSha256: soulSha256(crlfDecomposedSoul),
        }),
      ),
    ).not.toThrow();
  });

  it('WFM-014: rejects a supplied hash that disagrees with the stored content', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'hash-guard');
    const before = snapshotCounts(database);

    for (const overrides of [
      { expectedConfigSha256: sha },
      { expectedSoulSha256: sha },
      { harnessMarkdown: HARNESS, expectedHarnessSha256: sha },
      // A HARNESS hash without a HARNESS body cannot be satisfied either.
      { expectedHarnessSha256: soulSha256(HARNESS) },
    ]) {
      const error = expectApplicationError(() =>
        versions.appendVersion(versionInput('hash-guard', 1, overrides)),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    }
    expect(snapshotCounts(database)).toEqual(before);

    // The matching hashes are accepted and are the ones actually stored.
    const configJson = canonicalProfileConfigJson({
      id: 'hash-guard',
      version: 1,
      description: 'a custom agent profile body',
    });
    const stored = versions.appendVersion(
      versionInput('hash-guard', 1, {
        harnessMarkdown: HARNESS,
        expectedConfigSha256: sha256Hex(configJson),
        expectedSoulSha256: soulSha256(SOUL),
        expectedHarnessSha256: soulSha256(HARNESS),
      }),
    );
    expect(stored.configSha256).toBe(sha256Hex(configJson));
    expect(
      database
        .prepare(
          'SELECT config_json FROM agent_profile_versions WHERE agent_id = ? AND version = 1',
        )
        .get('hash-guard'),
    ).toMatchObject({ config_json: configJson });
  });

  it('WFM-014: HARNESS is optional and its hash stays NULL when no body is supplied', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'no-harness');
    const version = versions.appendVersion(versionInput('no-harness', 1));

    expect(version.harnessSha256).toBeNull();
    expect(version.soulSha256).not.toBeNull();
    expect(
      database
        .prepare(
          'SELECT soul_sha256, harness_sha256 FROM agent_profile_versions WHERE agent_id = ?',
        )
        .get('no-harness'),
    ).toMatchObject({ soul_sha256: soulSha256(SOUL), harness_sha256: null });
  });

  it('WFM-012: the runtime selection is schema-checked and stored canonically', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'selection-agent');
    const before = snapshotCounts(database);

    for (const candidate of [
      // A default selection can only be attributed to the catalog.
      { ...OVERRIDE_SELECTION, selectionMode: 'default', selectionSource: 'user' },
      // An override can never be attributed to the catalog.
      { ...OVERRIDE_SELECTION, selectionSource: 'catalog' },
      // Unknown provider.
      { ...OVERRIDE_SELECTION, provider: 'acme' },
      // A fallback cannot duplicate the primary model.
      { ...OVERRIDE_SELECTION, fallbackModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }] },
      'not an object',
    ]) {
      expect(
        expectApplicationError(() =>
          versions.appendVersion(
            versionInput('selection-agent', 1, { runtimeSelection: candidate }),
          ),
        ).code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(snapshotCounts(database)).toEqual(before);

    versions.appendVersion(versionInput('selection-agent', 1));
    expect(
      database
        .prepare('SELECT runtime_selection_json FROM agent_profile_versions WHERE agent_id = ?')
        .get('selection-agent'),
    ).toMatchObject({ runtime_selection_json: canonicalProfileConfigJson(OVERRIDE_SELECTION) });
  });

  it('WFM-022: appending a version writes exactly one clean audit row', () => {
    const { database, definitions, versions } = setup();
    defineCustom(definitions, 'audited-agent');
    versions.appendVersion(versionInput('audited-agent', 1, { harnessMarkdown: HARNESS }));

    const rows = database
      .prepare(
        "SELECT actor, project_id, payload_json FROM audit_log WHERE action = 'agent.version_added'",
      )
      .all() as { actor: string; project_id: string | null; payload_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('local-user');
    expect(rows[0]!.project_id).toBeNull();

    const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
    expect(payload).toEqual({
      agentId: 'audited-agent',
      version: 1,
      origin: 'user_created',
      configSha256: expect.any(String),
      soulSha256: soulSha256(SOUL),
      harnessSha256: soulSha256(HARNESS),
      selectionMode: 'override',
      selectionSource: 'user',
    });
    // Only identifiers and hashes are audited: no body ever reaches the log.
    const serialized = rows[0]!.payload_json;
    expect(serialized).not.toContain('SOUL');
    expect(serialized).not.toContain('HARNESS');
  });
});

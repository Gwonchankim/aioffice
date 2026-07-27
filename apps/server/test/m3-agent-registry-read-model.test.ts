import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfileFull, RuntimeSelection } from '@orion/contracts';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import { AgentProfileRepository } from '../src/repositories/agent-profile-repository.js';
import { AgentDefinitionRepository } from '../src/repositories/agent-definition-repository.js';
import { AgentProfileVersionRepository } from '../src/repositories/agent-profile-version-repository.js';
import { AgentRegistryReadModel } from '../src/repositories/agent-registry-read-model.js';

const iso = '2026-07-27T00:00:00.000Z';
const sha = 'a'.repeat(64);

const SOUL = '# SOUL\nI review changes carefully and never weaken a gate.\n';

const OVERRIDE_SELECTION: RuntimeSelection = {
  selectionMode: 'override',
  selectionSource: 'user',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  reasoningEffort: 'medium',
  fallbackModels: [],
};

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-registry-read-model-'));
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
    registry: new AgentRegistryReadModel(handle.database),
  };
}

type Database = ReturnType<typeof setup>['database'];

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

/** Employment transitions are WF2's employment repository; here they are raw UPDATEs. */
function setEmployment(
  database: Database,
  agentId: string,
  state: string,
  activeVersion: number | null,
  lastActiveVersion: number | null,
): void {
  database
    .prepare(
      `UPDATE agent_employments
         SET state = ?, active_version = ?, last_active_version = ?, revision = revision + 1
       WHERE agent_id = ?`,
    )
    .run(state, activeVersion, lastActiveVersion, agentId);
}

/** A schema-valid full profile for a custom id, derived from the shipped `atlas` v2 row. */
function customFullProfile(database: Database, agentId: string, version: number): AgentProfileFull {
  const row = database
    .prepare("SELECT config_json FROM agent_profiles WHERE id = 'atlas' AND version = 2")
    .get() as { config_json: string };
  return {
    ...(JSON.parse(row.config_json) as AgentProfileFull),
    id: agentId,
    version,
    name: 'Custom Agent',
    displayName: 'Custom Agent — Registry Fixture',
  };
}

function seedCustom(
  helpers: ReturnType<typeof setup>,
  agentId: string,
  createdAt: string,
  version = 1,
): void {
  helpers.definitions.create({
    id: agentId,
    name: 'Custom Agent',
    origin: 'user_created',
    createdBy: 'local-user',
    createdAt,
  });
  helpers.versions.appendVersion({
    agentId,
    version,
    config: customFullProfile(helpers.database, agentId, version),
    soulMarkdown: SOUL,
    runtimeSelection: OVERRIDE_SELECTION,
    createdBy: 'local-user',
    createdAt,
  });
}

describe('M3 AgentRegistryReadModel', () => {
  it('exposes a built-in agent through the union of both version stores', () => {
    const { registry } = setup();

    expect(registry.find('atlas')).toEqual({
      agentId: 'atlas',
      source: 'builtin',
      origin: 'builtin',
      versions: [1, 2],
      latestProfileVersion: 2,
      employmentState: 'active',
      employedActiveVersion: 2,
      lastActiveVersion: 2,
      revision: 1,
      runtimeSelection: {
        selectionMode: 'default',
        selectionSource: 'catalog',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        fallbackModels: [
          { provider: 'anthropic', model: 'claude-opus-4-8' },
          { provider: 'openai', model: 'gpt-5.6-terra' },
        ],
      },
    });
    expect(registry.find('never-registered')).toBeUndefined();
  });
});

describe('M3 AgentRegistryReadModel — versioning authority', () => {
  it('keeps latestProfileVersion and employedActiveVersion apart', () => {
    const helpers = setup();
    const { database, registry } = helpers;
    seedCustom(helpers, 'delta-agent', '2026-07-27T01:00:00.000Z');

    // Employ the agent on v1, then publish v2 without promoting it.
    setEmployment(database, 'delta-agent', 'active', 1, 1);
    helpers.versions.appendVersion({
      agentId: 'delta-agent',
      version: 2,
      config: customFullProfile(database, 'delta-agent', 2),
      soulMarkdown: SOUL,
      runtimeSelection: OVERRIDE_SELECTION,
      createdBy: 'local-user',
      createdAt: '2026-07-27T02:00:00.000Z',
    });

    const entry = registry.find('delta-agent');
    expect(entry).toMatchObject({
      source: 'custom',
      origin: 'user_created',
      versions: [1, 2],
      latestProfileVersion: 2,
      employmentState: 'active',
      employedActiveVersion: 1,
      lastActiveVersion: 1,
    });
    expect(registry.getRunTargetVersion('delta-agent')).toBe(1);

    // Suspension clears the runtime target but preserves the restore point.
    setEmployment(database, 'delta-agent', 'suspended', null, 1);
    expect(registry.find('delta-agent')).toMatchObject({
      employmentState: 'suspended',
      employedActiveVersion: null,
      lastActiveVersion: 1,
    });
    expect(registry.getRunTargetVersion('delta-agent')).toBeNull();

    // So does dismissal, and an unknown agent has no run target at all.
    setEmployment(database, 'delta-agent', 'retired', null, 1);
    expect(registry.getRunTargetVersion('delta-agent')).toBeNull();
    expect(registry.getRunTargetVersion('arca')).toBeNull();
    expect(registry.getRunTargetVersion('never-registered')).toBeNull();
  });

  it('reports the union version history without duplicates', () => {
    const helpers = setup();
    const { database, registry } = helpers;
    seedCustom(helpers, 'union-agent', '2026-07-27T01:00:00.000Z');
    helpers.profiles.insertFullVersion({
      ...(JSON.parse(
        (
          database
            .prepare("SELECT config_json FROM agent_profiles WHERE id = 'atlas' AND version = 2")
            .get() as { config_json: string }
        ).config_json,
      ) as AgentProfileFull),
      version: 3,
    });

    const pairs = registry
      .list({ includeInactive: true })
      .flatMap((entry) => entry.versions.map((version) => `${entry.agentId}:${version}`));
    expect(new Set(pairs).size).toBe(pairs.length);

    for (const entry of registry.list({ includeInactive: true })) {
      expect([...entry.versions].sort((left, right) => left - right)).toEqual([...entry.versions]);
      expect(new Set(entry.versions).size).toBe(entry.versions.length);
      expect(entry.latestProfileVersion).toBe(
        entry.versions.length === 0 ? null : entry.versions[entry.versions.length - 1],
      );
    }

    expect(registry.find('atlas')?.versions).toEqual([1, 2, 3]);
    expect(registry.find('union-agent')?.versions).toEqual([1]);
  });

  it('reports a definition without any stored version as having none', () => {
    const helpers = setup();
    helpers.definitions.create({
      id: 'empty-agent',
      name: 'Empty',
      origin: 'imported',
      createdBy: 'local-user',
      createdAt: '2026-07-27T01:00:00.000Z',
    });

    expect(helpers.registry.find('empty-agent')).toMatchObject({
      source: 'custom',
      origin: 'imported',
      versions: [],
      latestProfileVersion: null,
      employmentState: 'draft',
      employedActiveVersion: null,
      runtimeSelection: null,
    });
  });
});

describe('M3 AgentRegistryReadModel — ordering, filtering and paging', () => {
  it('orders built-ins by seed order and customs by creation, and pages across the boundary', () => {
    const helpers = setup();
    const { database, registry } = helpers;
    // Created out of id order on purpose: creation time decides, id only breaks ties.
    seedCustom(helpers, 'zulu-agent', '2026-07-27T01:00:00.000Z');
    seedCustom(helpers, 'alpha-agent', '2026-07-27T02:00:00.000Z');

    const seedOrder = (
      database
        .prepare('SELECT id FROM agent_profiles WHERE version = 1 ORDER BY seed_order ASC')
        .all() as { id: string }[]
    ).map((row) => row.id);
    expect(seedOrder).toHaveLength(18);

    const all = registry.list({ includeInactive: true });
    expect(all.map((entry) => entry.agentId)).toEqual([...seedOrder, 'zulu-agent', 'alpha-agent']);
    expect(all.slice(0, 18).every((entry) => entry.source === 'builtin')).toBe(true);
    expect(all.slice(18).every((entry) => entry.source === 'custom')).toBe(true);

    // Paging reproduces exactly that order, including the built-in/custom seam.
    const paged: string[] = [];
    let cursorAgentId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const next = registry.list(
        cursorAgentId === undefined
          ? { includeInactive: true, limit: 7 }
          : { includeInactive: true, limit: 7, cursorAgentId },
      );
      if (next.length === 0) {
        break;
      }
      paged.push(...next.map((entry) => entry.agentId));
      cursorAgentId = next[next.length - 1]!.agentId;
    }
    expect(paged).toEqual(all.map((entry) => entry.agentId));

    // A page that starts on the last built-in continues into the customs.
    expect(
      registry
        .list({ includeInactive: true, limit: 3, cursorAgentId: seedOrder[16]! })
        .map((entry) => entry.agentId),
    ).toEqual([seedOrder[17]!, 'zulu-agent', 'alpha-agent']);

    expect(
      expectApplicationError(() =>
        registry.list({ includeInactive: true, cursorAgentId: 'no-such-agent' }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      expectApplicationError(() => registry.list({ includeInactive: true, limit: 0 })).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('honours includeInactive in both directions and keeps Arca out of the roster', () => {
    const helpers = setup();
    const { database, registry } = helpers;
    seedCustom(helpers, 'hired-agent', '2026-07-27T01:00:00.000Z');
    seedCustom(helpers, 'draft-agent', '2026-07-27T02:00:00.000Z');
    setEmployment(database, 'hired-agent', 'active', 1, 1);

    const everything = registry.list({ includeInactive: true });
    expect(everything).toHaveLength(20);
    expect(everything.map((entry) => entry.agentId)).toContain('arca');
    expect(everything.map((entry) => entry.agentId)).toContain('draft-agent');

    const employed = registry.list({ includeInactive: false });
    expect(employed.every((entry) => entry.employmentState === 'active')).toBe(true);
    expect(employed).toHaveLength(18);
    expect(employed.map((entry) => entry.agentId)).not.toContain('arca');
    expect(employed.map((entry) => entry.agentId)).not.toContain('draft-agent');
    expect(employed.map((entry) => entry.agentId)).toContain('hired-agent');

    // `activeRoster()` is exactly that view, and Arca can never enter it.
    expect(registry.activeRoster().map((entry) => entry.agentId)).toEqual(
      employed.map((entry) => entry.agentId),
    );
    expect(
      database.prepare("SELECT state FROM agent_employments WHERE agent_id = 'arca'").get(),
    ).toMatchObject({ state: 'draft' });

    // Dismissing a built-in removes it from the roster but not from the registry.
    setEmployment(database, 'forge', 'retired', null, 2);
    expect(registry.activeRoster().map((entry) => entry.agentId)).not.toContain('forge');
    expect(registry.list({ includeInactive: true }).map((entry) => entry.agentId)).toContain(
      'forge',
    );
    expect(registry.find('forge')).toMatchObject({
      employmentState: 'retired',
      employedActiveVersion: null,
      lastActiveVersion: 2,
    });
  });

  it('fails loudly when a definition has no employment row', () => {
    const { database, registry } = setup();
    database
      .prepare(
        `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
         VALUES ('orphan-agent', 'Orphan', 'user_created', 'local-user', ?)`,
      )
      .run(iso);

    const error = expectApplicationError(() => registry.list({ includeInactive: true }));
    expect(error.code).toBe('DATABASE_UNAVAILABLE');
    expect(error.message).toContain('orphan-agent');
  });
});

describe('M3 AgentRegistryReadModel — export set and runtime selection', () => {
  it('WFM-017: the export set keeps built-in output identical and is not employment-filtered', () => {
    const helpers = setup();
    const { database, profiles, registry } = helpers;

    const builtinOnly = registry.listLatestFullVersionPerAgent();
    expect(builtinOnly).toEqual(profiles.listActiveFullProfiles());
    expect(builtinOnly).toHaveLength(18);

    // A custom agent joins the export set behind the built-ins.
    seedCustom(helpers, 'export-agent', '2026-07-27T01:00:00.000Z');
    const withCustom = registry.listLatestFullVersionPerAgent();
    expect(withCustom.slice(0, 18)).toEqual(builtinOnly);
    expect(withCustom).toHaveLength(19);
    expect(withCustom[18]!.id).toBe('export-agent');
    expect(withCustom[18]!.version).toBe(1);

    // "Latest" means newest stored version, for both spaces.
    helpers.versions.appendVersion({
      agentId: 'export-agent',
      version: 2,
      config: customFullProfile(database, 'export-agent', 2),
      soulMarkdown: SOUL,
      runtimeSelection: OVERRIDE_SELECTION,
      createdBy: 'local-user',
      createdAt: '2026-07-27T02:00:00.000Z',
    });
    profiles.insertFullVersion({
      ...(JSON.parse(
        (
          database
            .prepare("SELECT config_json FROM agent_profiles WHERE id = 'atlas' AND version = 2")
            .get() as { config_json: string }
        ).config_json,
      ) as AgentProfileFull),
      version: 3,
    });
    const latest = registry.listLatestFullVersionPerAgent();
    expect(latest).toEqual(profiles.listActiveFullProfiles().concat(latest.slice(18)));
    expect(latest.find((profile) => profile.id === 'atlas')?.version).toBe(3);
    expect(latest.find((profile) => profile.id === 'export-agent')?.version).toBe(2);

    // Employment never filters the export set: a dismissed agent still exports.
    const beforeDismissal = registry.listLatestFullVersionPerAgent();
    setEmployment(database, 'forge', 'retired', null, 2);
    setEmployment(database, 'export-agent', 'retired', null, null);
    expect(registry.listLatestFullVersionPerAgent()).toEqual(beforeDismissal);
  });

  it('WFM-011: built-in selections are always catalog defaults and customs read their newest version', () => {
    const helpers = setup();
    const { database, registry } = helpers;

    for (const entry of registry.list({ includeInactive: true })) {
      expect(entry.source).toBe('builtin');
      expect(entry.runtimeSelection).not.toBeNull();
      expect(entry.runtimeSelection).toMatchObject({
        selectionMode: 'default',
        selectionSource: 'catalog',
      });
    }

    // A custom agent carries whatever its newest version stored.
    seedCustom(helpers, 'select-agent', '2026-07-27T01:00:00.000Z');
    expect(registry.find('select-agent')?.runtimeSelection).toEqual(OVERRIDE_SELECTION);

    const promoted: RuntimeSelection = {
      selectionMode: 'default',
      selectionSource: 'catalog',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      fallbackModels: [],
    };
    helpers.versions.appendVersion({
      agentId: 'select-agent',
      version: 2,
      config: customFullProfile(database, 'select-agent', 2),
      soulMarkdown: SOUL,
      runtimeSelection: promoted,
      createdBy: 'local-user',
      createdAt: '2026-07-27T02:00:00.000Z',
    });
    expect(registry.find('select-agent')?.runtimeSelection).toEqual(promoted);
  });

  it('returns null rather than inventing a selection when a stored row carries no model', () => {
    const { database, registry } = setup();

    // A newest built-in row without provider/model information.
    database
      .prepare(
        `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
         VALUES ('atlas', 3, 1, ?, '{"id":"atlas","version":3}', 0, 'skeleton', ?)`,
      )
      .run(sha, iso);

    const entry = registry.find('atlas');
    expect(entry?.latestProfileVersion).toBe(3);
    expect(entry?.runtimeSelection).toBeNull();
    // The export set still reads the newest FULL row, so it is unaffected.
    expect(
      registry.listLatestFullVersionPerAgent().find((profile) => profile.id === 'atlas')?.version,
    ).toBe(2);
  });
});

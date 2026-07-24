import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { agentProfileFullSchema, type AgentProfileFull } from '@orion/contracts';

import { validateProfilePermissions } from './permission-ceilings.js';
import { normalizeSoulMarkdown, soulSha256 } from './soul-hash.js';
import { assertSoulPolicyCompliant } from './soul-policy-guard.js';

/** Thrown for every full-profile load failure; `message` names the exact cause. */
export class FullProfileLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullProfileLoadError';
  }
}

/** Canonical 18-agent roster order, matching migrations/0002_agent_profile_seeds.sql. */
export const CANONICAL_FULL_PROFILE_ORDER = [
  'atlas',
  'nova',
  'miro',
  'aegis',
  'ledger',
  'forge',
  'luma',
  'iris',
  'verify',
  'sentinel',
  'archon',
  'orion',
  'helios',
  'regula',
  'insight',
  'keystone',
  'nexus',
  'arca',
] as const;

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'id',
  'version',
  'name',
  'displayName',
  'description',
  'soulPath',
  'soulSha256',
  'runtime',
  'permissions',
  'routing',
  'contracts',
  'enabled',
] as const;

const RUNTIME_KEYS = ['provider', 'model', 'reasoningEffort', 'fallbackModels'] as const;

const ROUTING_KEYS = [
  'capabilities',
  'triggers',
  'exclusions',
  'requiredCollaborators',
  'recommendedCollaborators',
] as const;

interface RawFallbackModel {
  provider: string;
  model: string;
}

interface RawProfileYaml {
  schemaVersion: unknown;
  id: string;
  version: number;
  name: string;
  displayName: string;
  description: string;
  soulPath: string;
  soulSha256: string;
  runtime: {
    provider: string;
    model: string;
    reasoningEffort: string;
    fallbackModels: RawFallbackModel[];
  };
  permissions: Record<string, unknown> & { template: string };
  routing: {
    capabilities: string[];
    triggers: string[];
    exclusions: string[];
    requiredCollaborators: string[];
    recommendedCollaborators: string[];
  };
  contracts: {
    outputSchema: string;
    requiredArtifactKinds: string[];
    stopConditions: string[];
  };
  enabled: boolean;
}

function assertNoUnknownKeys(value: unknown, allowed: readonly string[], context: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FullProfileLoadError(`${context} must be a mapping.`);
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new FullProfileLoadError(`${context} has unknown field(s): ${extra.join(', ')}.`);
  }
}

function packageRoot(): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)));
}

function assertRelativeMarkdownPath(soulPath: string, id: string): void {
  if (soulPath.length === 0) {
    throw new FullProfileLoadError(`Profile "${id}" has an empty soulPath.`);
  }
  if (/^[A-Za-z]:[\\/]/.test(soulPath) || soulPath.startsWith('/') || soulPath.startsWith('\\')) {
    throw new FullProfileLoadError(
      `Profile "${id}" soulPath must be a relative path, got "${soulPath}".`,
    );
  }
  if (!soulPath.toLowerCase().endsWith('.md')) {
    throw new FullProfileLoadError(`Profile "${id}" soulPath must reference a .md file.`);
  }
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function resolveSoulFile(
  profilesDir: string,
  catalogRoot: string,
  soulPath: string,
  id: string,
): string {
  const resolved = resolve(profilesDir, soulPath);
  const rootWithSep = withTrailingSeparator(catalogRoot);
  if (resolved !== catalogRoot && !resolved.startsWith(rootWithSep)) {
    throw new FullProfileLoadError(
      `Profile "${id}" soulPath escapes the catalog root: "${soulPath}".`,
    );
  }

  let realSoulPath: string;
  try {
    realSoulPath = realpathSync(resolved);
  } catch {
    throw new FullProfileLoadError(
      `Profile "${id}" soulPath does not resolve to an existing file: "${soulPath}".`,
    );
  }
  const realRoot = withTrailingSeparator(realpathSync(catalogRoot));
  if (realSoulPath !== realRoot.slice(0, -1) && !realSoulPath.startsWith(realRoot)) {
    throw new FullProfileLoadError(
      `Profile "${id}" soulPath symlink escapes the catalog root: "${soulPath}".`,
    );
  }
  return resolved;
}

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

/**
 * Loads, verifies, and validates the 18 full M3 AgentProfile YAML + SOUL.MD
 * pairs from `profiles/` and `souls/`. Throws `FullProfileLoadError` with a
 * specific reason for the first failure encountered. Returns a deterministic,
 * deep-frozen array ordered per `CANONICAL_FULL_PROFILE_ORDER`.
 */
export function loadFullAgentProfiles(): readonly AgentProfileFull[] {
  const root = packageRoot();
  const profilesDir = resolve(root, 'profiles');

  const fileNames = readdirSync(profilesDir)
    .filter((name) => name.endsWith('.yaml'))
    .sort((left, right) => left.localeCompare(right));

  if (fileNames.length !== CANONICAL_FULL_PROFILE_ORDER.length) {
    throw new FullProfileLoadError(
      `Expected exactly ${CANONICAL_FULL_PROFILE_ORDER.length} profile YAML files, found ${fileNames.length}.`,
    );
  }

  const byId = new Map<string, AgentProfileFull>();

  for (const fileName of fileNames) {
    const filePath = resolve(profilesDir, fileName);
    const text = readFileSync(filePath, 'utf8');

    let raw: RawProfileYaml;
    try {
      raw = parse(text, { uniqueKeys: true, strict: true }) as RawProfileYaml;
    } catch (error) {
      throw new FullProfileLoadError(
        `Profile file "${fileName}" failed strict YAML parsing: ${(error as Error).message}`,
      );
    }

    assertNoUnknownKeys(raw, TOP_LEVEL_KEYS, `Profile file "${fileName}"`);
    assertNoUnknownKeys(raw.runtime, RUNTIME_KEYS, `Profile "${raw.id}" runtime`);
    assertNoUnknownKeys(raw.routing, ROUTING_KEYS, `Profile "${raw.id}" routing`);

    if (raw.schemaVersion !== 1) {
      throw new FullProfileLoadError(
        `Profile "${fileName}" has unsupported schemaVersion ${String(raw.schemaVersion)}.`,
      );
    }
    if (byId.has(raw.id)) {
      throw new FullProfileLoadError(`Duplicate profile id "${raw.id}".`);
    }

    assertRelativeMarkdownPath(raw.soulPath, raw.id);
    const soulFilePath = resolveSoulFile(profilesDir, root, raw.soulPath, raw.id);
    const soulMarkdownRaw = readFileSync(soulFilePath, 'utf8');
    const normalizedSoul = normalizeSoulMarkdown(soulMarkdownRaw);
    const computedHash = soulSha256(soulMarkdownRaw);
    if (computedHash !== raw.soulSha256) {
      throw new FullProfileLoadError(
        `Profile "${raw.id}" soulSha256 mismatch: expected ${raw.soulSha256}, computed ${computedHash}.`,
      );
    }
    assertSoulPolicyCompliant(normalizedSoul);

    const { template, ...permissionRest } = raw.permissions;
    const candidate = {
      id: raw.id,
      version: raw.version,
      name: raw.name,
      displayName: raw.displayName,
      description: raw.description,
      provider: raw.runtime.provider,
      model: raw.runtime.model,
      fallbackModels: raw.runtime.fallbackModels,
      reasoningEffort: raw.runtime.reasoningEffort,
      permissionTemplate: template,
      permissions: permissionRest,
      capabilities: raw.routing.capabilities,
      routing: {
        capabilities: raw.routing.capabilities,
        triggers: raw.routing.triggers,
        exclusions: raw.routing.exclusions,
        requiredCollaborators: raw.routing.requiredCollaborators,
        recommendedCollaborators: raw.routing.recommendedCollaborators,
      },
      contracts: raw.contracts,
      soulMarkdown: normalizedSoul,
      soulSha256: raw.soulSha256,
      enabled: raw.enabled,
      executionMode: 'full' as const,
    };

    const parsed = agentProfileFullSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new FullProfileLoadError(
        `Profile "${raw.id}" failed full schema validation: ${parsed.error.message}`,
      );
    }

    if (!validateProfilePermissions(parsed.data)) {
      throw new FullProfileLoadError(
        `Profile "${raw.id}" permissions exceed the "${parsed.data.permissionTemplate}" template ceiling.`,
      );
    }

    byId.set(raw.id, parsed.data);
  }

  if (byId.size !== CANONICAL_FULL_PROFILE_ORDER.length) {
    throw new FullProfileLoadError(
      `Expected exactly ${CANONICAL_FULL_PROFILE_ORDER.length} unique profile ids, found ${byId.size}.`,
    );
  }
  for (const id of CANONICAL_FULL_PROFILE_ORDER) {
    if (!byId.has(id)) {
      throw new FullProfileLoadError(`Missing required profile id "${id}".`);
    }
  }

  const ordered = CANONICAL_FULL_PROFILE_ORDER.map((id) => byId.get(id)!);
  return deepFreeze(ordered) as readonly AgentProfileFull[];
}

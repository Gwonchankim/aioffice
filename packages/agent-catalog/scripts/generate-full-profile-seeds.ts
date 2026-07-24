import { createHash } from 'node:crypto';

import { loadFullAgentProfiles, CANONICAL_FULL_PROFILE_ORDER } from '../dist/index.js';

const MIGRATION_VERSION = 2;
const CREATED_AT = '2026-07-24T00:00:00.000Z';

/** Recursively sorts object keys (arrays keep their original element order) for a stable JSON.stringify. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalConfigJson(profile: unknown): string {
  return JSON.stringify(sortKeysDeep(profile));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main(): void {
  const profiles = loadFullAgentProfiles();
  if (profiles.length !== CANONICAL_FULL_PROFILE_ORDER.length) {
    throw new Error(
      `Expected ${CANONICAL_FULL_PROFILE_ORDER.length} full profiles, loaded ${profiles.length}.`,
    );
  }

  const insertLines: string[] = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    const expectedId = CANONICAL_FULL_PROFILE_ORDER[index]!;
    if (profile.id !== expectedId) {
      throw new Error(
        `Profile order mismatch at index ${index}: expected "${expectedId}", got "${profile.id}".`,
      );
    }
    const seedOrder = index + 1;
    const configJson = canonicalConfigJson(profile);
    const configSha256 = sha256Hex(configJson);
    const enabled = profile.id === 'arca' ? 0 : 1;

    insertLines.push(
      `INSERT OR IGNORE INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at) VALUES (${sqlStringLiteral(
        profile.id,
      )}, ${MIGRATION_VERSION}, ${seedOrder}, ${sqlStringLiteral(configSha256)}, ${sqlStringLiteral(
        configJson,
      )}, ${enabled}, 'full', ${sqlStringLiteral(CREATED_AT)});`,
    );
  }

  const sql = `${insertLines.join('\n')}

CREATE TABLE migration_0006_verify (id INTEGER PRIMARY KEY);
CREATE TRIGGER migration_0006_verify_guard BEFORE INSERT ON migration_0006_verify
WHEN (
  (SELECT COUNT(*) FROM agent_profiles WHERE version = 2 AND execution_mode = 'full') <> 18
  OR (SELECT COUNT(*) FROM agent_profiles WHERE version = 2 AND execution_mode = 'full' AND enabled = 1) <> 17
  OR (SELECT COUNT(*) FROM agent_profiles WHERE id = 'arca' AND version = 2 AND enabled = 0) <> 1
)
BEGIN SELECT RAISE(ABORT, 'M3_FULL_PROFILE_SEED_MANIFEST_INCOMPLETE'); END;
INSERT INTO migration_0006_verify (id) VALUES (1);
DROP TRIGGER migration_0006_verify_guard;
DROP TABLE migration_0006_verify;
`;

  process.stdout.write(sql);
}

main();

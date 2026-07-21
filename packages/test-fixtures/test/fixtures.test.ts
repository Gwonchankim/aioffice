import { describe, expect, it } from 'vitest';

import {
  forbiddenSourceFieldFixtures,
  syntheticAllowedCommands,
  syntheticGitStatus,
  syntheticProjectId,
  syntheticProjectKey,
  syntheticRegisterSourceInput,
  syntheticSourceCard,
  syntheticSourceRequest,
} from '../src/index.js';

const prohibitedFixtureKey =
  /(?:token|secret|password|authorization|cookie|rawcontent|rawexcerpt|credential|prompt|toollog)/i;

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
  }
  return [];
}

describe('synthetic M1 fixtures', () => {
  it('contains only invented metadata and keeps project ULID and project key distinct', () => {
    expect(syntheticProjectId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(syntheticProjectKey).toMatch(/^[a-z][a-z0-9_-]{1,63}$/);
    expect(syntheticSourceCard.projectId).toBe(syntheticProjectKey);
    expect(syntheticSourceRequest.projectId).toBe(syntheticProjectKey);
    expect(syntheticSourceCard.sourceId).not.toBe(syntheticProjectId);
    expect(syntheticGitStatus.headSha).toHaveLength(40);
    expect(syntheticAllowedCommands.read).toContainEqual(['git', 'status']);
  });

  it('isolates forbidden-field probes from valid metadata-only fixture payloads', () => {
    expect(collectKeys(syntheticSourceCard).some((key) => prohibitedFixtureKey.test(key))).toBe(
      false,
    );
    expect(collectKeys(syntheticSourceRequest).some((key) => prohibitedFixtureKey.test(key))).toBe(
      false,
    );
    expect(
      collectKeys(syntheticRegisterSourceInput).some((key) => prohibitedFixtureKey.test(key)),
    ).toBe(false);
    expect(forbiddenSourceFieldFixtures).toHaveLength(5);
    for (const field of forbiddenSourceFieldFixtures) {
      expect(collectKeys(field).some((key) => prohibitedFixtureKey.test(key))).toBe(true);
    }
  });
});

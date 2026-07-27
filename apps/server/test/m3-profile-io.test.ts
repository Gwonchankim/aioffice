import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { loadFullAgentProfiles, type AgentProfileFull } from '@orion/agent-catalog';
import { createDatabase, type DatabaseHandle } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { AgentProfileRepository, sha256Hex } from '../src/repositories/agent-profile-repository.js';
import { ProfileIoService } from '../src/profile-io-service.js';
import { writeStoreZip, readStoreZip } from '../src/profile-zip.js';
import { ApplicationError } from '../src/errors.js';

const iso = '2026-07-26T00:00:00.000Z';
const cleanup: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup(): {
  handle: DatabaseHandle;
  repository: AgentProfileRepository;
  service: ProfileIoService;
} {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-profile-io-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
  const service = new ProfileIoService(handle.database, repository, () => new Date(iso));
  return { handle, repository, service };
}

function findAtlas(): AgentProfileFull {
  const atlas = loadFullAgentProfiles().find((profile) => profile.id === 'atlas');
  if (atlas === undefined) throw new Error('atlas fixture missing');
  return atlas;
}

describe('ProfileIoService export/import round trips', () => {
  it('AGT-009: json format exports and a re-import is all skipped_identical with no DB change', () => {
    const { repository, service } = setup();
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    expect(exported.format).toBe('json');
    expect(typeof exported.content).toBe('string');

    const before = repository.listAll().length;
    const result = service.importProfiles(exported.content, { format: 'json', dryRun: false });
    expect(result.applied).toBe(false);
    expect(result.outcomes).toHaveLength(18);
    expect(result.outcomes.every((outcome) => outcome.outcome === 'skipped_identical')).toBe(true);
    expect(repository.listAll().length).toBe(before);
  });

  it('AGT-010: yaml format exports without inlining SOUL bodies in the profile section, and a re-import is all skipped_identical', () => {
    const { repository, service } = setup();
    const exported = service.exportProfiles({ format: 'yaml', includeHistory: false });
    expect(exported.format).toBe('yaml');
    const text = exported.content as string;

    const parsed = parseYaml(text, { uniqueKeys: true, strict: true }) as {
      profiles: readonly Record<string, unknown>[];
      souls: Record<string, string>;
    };
    expect(parsed.profiles.every((profile) => !('soulMarkdown' in profile))).toBe(true);
    expect(Object.keys(parsed.souls)).toHaveLength(18);

    const before = repository.listAll().length;
    const result = service.importProfiles(text, { format: 'yaml', dryRun: false });
    expect(result.applied).toBe(false);
    expect(result.outcomes.every((outcome) => outcome.outcome === 'skipped_identical')).toBe(true);
    expect(repository.listAll().length).toBe(before);
  });

  it('AGT-011: zip format round trips (with checksums.sha256) and a re-import is all skipped_identical', () => {
    const { repository, service } = setup();
    const exported = service.exportProfiles({ format: 'zip', includeHistory: false });
    expect(exported.format).toBe('zip');
    expect(Buffer.isBuffer(exported.content)).toBe(true);

    const zipEntries = readStoreZip(exported.content as Buffer);
    expect(zipEntries.some((entry) => entry.name === 'checksums.sha256')).toBe(true);
    expect(zipEntries.some((entry) => entry.name === 'manifest.json')).toBe(true);

    const before = repository.listAll().length;
    const result = service.importProfiles(exported.content, { format: 'zip', dryRun: false });
    expect(result.applied).toBe(false);
    expect(result.outcomes).toHaveLength(18);
    expect(result.outcomes.every((outcome) => outcome.outcome === 'skipped_identical')).toBe(true);
    expect(repository.listAll().length).toBe(before);
  });

  it('AGT-012: a dryRun import never applies, even for a genuinely new version', () => {
    const { repository, service } = setup();
    repository.insertFullVersion({
      ...findAtlas(),
      version: 3,
      description: '드라이런 검증을 위한 v3 설명 변경입니다.',
    });
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    const before = repository.listAll().length;

    const dryRunResult = service.importProfiles(exported.content, { format: 'json', dryRun: true });
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.applied).toBe(false);
    expect(repository.listAll().length).toBe(before);
  });

  it('AGT-013a: a zip entry using Deflate (method 8) is rejected', () => {
    const { service } = setup();
    const zip = buildMinimalValidZip();
    const tampered = setLocalAndCentralUInt16(zip, { methodOffset: 8 }, 8);
    expect(() => service.importProfiles(tampered, { format: 'zip', dryRun: true })).toThrow(
      ApplicationError,
    );
  });

  it('AGT-013b: a zip entry with a data-descriptor flag bit set is rejected', () => {
    const { service } = setup();
    const zip = buildMinimalValidZip();
    const tampered = setGeneralPurposeFlagBit(zip, 0x0008);
    expect(() => service.importProfiles(tampered, { format: 'zip', dryRun: true })).toThrow(
      ApplicationError,
    );
  });

  it('AGT-013c: an entry name that path-traverses ("..") is rejected', () => {
    expect(() => writeStoreZip([{ name: '../escape.json', data: Buffer.from('{}') }])).toThrow();
  });

  it('AGT-013d: an absolute entry name is rejected', () => {
    expect(() => writeStoreZip([{ name: '/etc/passwd', data: Buffer.from('x') }])).toThrow();
    expect(() => writeStoreZip([{ name: 'C:\\evil.txt', data: Buffer.from('x') }])).toThrow();
  });

  it('AGT-013e: a symlink external-attributes entry is rejected on read', () => {
    const zip = buildMinimalValidZip();
    const tampered = setExternalAttributesToSymlink(zip);
    expect(() => readStoreZip(tampered)).toThrow(/symlink/);
  });

  it('AGT-013f: case-insensitive duplicate entry names are rejected', () => {
    expect(() =>
      writeStoreZip([
        { name: 'manifest.json', data: Buffer.from('{}') },
        { name: 'MANIFEST.JSON', data: Buffer.from('{}') },
      ]),
    ).toThrow();
  });

  it('AGT-013g: a declared ZIP64 end-of-central-directory signature is rejected', () => {
    const zip = buildMinimalValidZip();
    const withZip64Marker = Buffer.concat([zip, Buffer.from([0x50, 0x4b, 0x06, 0x06])]);
    expect(() => readStoreZip(withZip64Marker)).toThrow(/ZIP64/);
  });

  it('AGT-014a: an unknown top-level bundle field is rejected', () => {
    const { service } = setup();
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    const parsed = JSON.parse(exported.content as string) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...parsed, extraField: 'not allowed' });
    expect(() => service.importProfiles(tampered, { format: 'json', dryRun: true })).toThrow(
      ApplicationError,
    );
  });

  it('AGT-014b: a duplicate JSON object key is rejected', () => {
    const { service } = setup();
    const duplicateKeyJson = '{"manifest": {}, "manifest": {}, "profiles": [], "souls": {}}';
    expect(() =>
      service.importProfiles(duplicateKeyJson, { format: 'json', dryRun: true }),
    ).toThrow(ApplicationError);
  });

  it('AGT-015: a tampered configSha256 (checksum mismatch) is rejected', () => {
    const { service } = setup();
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    const parsed = JSON.parse(exported.content as string) as {
      manifest: { entries: { configSha256: string }[] };
    };
    parsed.manifest.entries[0]!.configSha256 = 'f'.repeat(64);
    expect(() =>
      service.importProfiles(JSON.stringify(parsed), { format: 'json', dryRun: true }),
    ).toThrow(ApplicationError);
  });

  it('AGT-016: a bundle with one invalid entry among many valid ones applies zero DB changes', () => {
    const { repository, service } = setup();
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    const parsed = JSON.parse(exported.content as string) as {
      manifest: { entries: { id: string; soulSha256: string }[] };
    };
    parsed.manifest.entries[0]!.soulSha256 = 'a'.repeat(64);
    const before = repository.listAll().length;
    expect(() =>
      service.importProfiles(JSON.stringify(parsed), { format: 'json', dryRun: false }),
    ).toThrow(ApplicationError);
    expect(repository.listAll().length).toBe(before);
  });

  it('AGT-017: the same (id,version) with different content yields conflict and is not applied', () => {
    const { repository, service } = setup();
    const exported = service.exportProfiles({ format: 'json', includeHistory: false });
    const parsed = JSON.parse(exported.content as string) as {
      profiles: Record<string, unknown>[];
      manifest: { entries: { id: string; version: number; configSha256: string }[] };
    };
    const atlasIndex = parsed.profiles.findIndex((profile) => profile.id === 'atlas');
    const atlasEntryIndex = parsed.manifest.entries.findIndex((entry) => entry.id === 'atlas');
    const mutatedProfile = {
      ...parsed.profiles[atlasIndex],
      description: '변조된 v2 설명으로 원본과 달라진 내용입니다.',
    };
    parsed.profiles[atlasIndex] = mutatedProfile;

    const atlasFull = findAtlas();
    const mergedForHash = { ...atlasFull, ...mutatedProfile } as AgentProfileFull;
    parsed.manifest.entries[atlasEntryIndex]!.configSha256 = sha256Hex(
      JSON.stringify(sortKeysForTest(mergedForHash)),
    );

    const before = repository.listAll().length;
    const result = service.importProfiles(JSON.stringify(parsed), {
      format: 'json',
      dryRun: false,
    });
    expect(result.applied).toBe(false);
    const atlasOutcome = result.outcomes.find((outcome) => outcome.id === 'atlas');
    expect(atlasOutcome?.outcome).toBe('conflict');
    expect(repository.listAll().length).toBe(before);
  });

  it('exportProfiles(includeHistory: true) includes every stored full version', () => {
    const { repository, service } = setup();
    repository.insertFullVersion({
      ...findAtlas(),
      version: 3,
      description: '히스토리 포함 내보내기 검증을 위한 v3 설명입니다.',
    });
    const exported = service.exportProfiles({ format: 'json', includeHistory: true });
    const parsed = JSON.parse(exported.content as string) as { manifest: { entries: unknown[] } };
    expect(parsed.manifest.entries).toHaveLength(19);
  });
});

function sortKeysForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysForTest(item));
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysForTest((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** A tiny, structurally valid single-entry zip usable as a mutation target for malicious-zip tests. */
function buildMinimalValidZip(): Buffer {
  return writeStoreZip([{ name: 'manifest.json', data: Buffer.from('{"hello":"world"}') }]);
}

function setLocalAndCentralUInt16(
  buffer: Buffer,
  positions: { readonly methodOffset: number },
  value: number,
): Buffer {
  const mutated = Buffer.from(buffer);
  mutated.writeUInt16LE(value, positions.methodOffset);
  const eocdOffset = mutated.length - 22;
  const centralOffset = mutated.readUInt32LE(eocdOffset + 16);
  mutated.writeUInt16LE(value, centralOffset + 10);
  return mutated;
}

function setGeneralPurposeFlagBit(buffer: Buffer, bit: number): Buffer {
  const mutated = Buffer.from(buffer);
  const localFlag = mutated.readUInt16LE(6);
  mutated.writeUInt16LE(localFlag | bit, 6);
  const eocdOffset = mutated.length - 22;
  const centralOffset = mutated.readUInt32LE(eocdOffset + 16);
  const centralFlag = mutated.readUInt16LE(centralOffset + 8);
  mutated.writeUInt16LE(centralFlag | bit, centralOffset + 8);
  return mutated;
}

function setExternalAttributesToSymlink(buffer: Buffer): Buffer {
  const mutated = Buffer.from(buffer);
  const eocdOffset = mutated.length - 22;
  const centralOffset = mutated.readUInt32LE(eocdOffset + 16);
  const symlinkExternalAttributes = (0o120777 << 16) >>> 0;
  mutated.writeUInt32LE(symlinkExternalAttributes, centralOffset + 38);
  return mutated;
}

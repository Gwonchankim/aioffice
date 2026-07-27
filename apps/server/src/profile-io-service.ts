import type { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  agentProfileFullSchema,
  exportManifestSchema,
  importResultSchema,
  type AgentProfileFull,
  type ExportEntry,
  type ExportManifest,
  type ImportOutcome,
  type ImportResult,
} from '@orion/contracts';
import {
  assertSoulPolicyCompliant,
  soulSha256,
  validateProfilePermissions,
  SoulPolicyViolationError,
} from '@orion/agent-catalog';

import { ApplicationError } from './errors.js';
import { withImmediateTransaction } from './database.js';
import {
  type AgentProfileRepository,
  canonicalProfileConfigJson,
  sha256Hex,
} from './repositories/agent-profile-repository.js';
import {
  readStoreZip,
  writeStoreZip,
  ZipValidationError,
  type ZipEntryInput,
} from './profile-zip.js';

export type ProfileTransferFormat = 'json' | 'yaml' | 'zip';

export interface ExportProfilesOptions {
  readonly format: ProfileTransferFormat;
  readonly includeHistory: boolean;
}

export interface ExportedProfileBundle {
  readonly format: ProfileTransferFormat;
  readonly content: string | Buffer;
}

export interface ImportProfilesOptions {
  readonly format: ProfileTransferFormat;
  readonly dryRun: boolean;
}

type ProfileWithoutSoul = Omit<AgentProfileFull, 'soulMarkdown'>;

interface BundleDocument {
  readonly manifest: ExportManifest;
  readonly profiles: readonly ProfileWithoutSoul[];
  readonly souls: Readonly<Record<string, string>>;
}

const MANIFEST_ENTRY_NAME = 'manifest.json';
const CHECKSUMS_ENTRY_NAME = 'checksums.sha256';

function profilePathFor(id: string, version: number): string {
  return `profiles/${id}.v${version}.json`;
}

function soulPathFor(id: string, version: number): string {
  return `souls/${id}.v${version}.md`;
}

function stripSoul(profile: AgentProfileFull): ProfileWithoutSoul {
  const rest: Record<string, unknown> = { ...profile };
  delete rest.soulMarkdown;
  return rest as ProfileWithoutSoul;
}

function rejectValidation(message: string, details?: unknown): never {
  throw new ApplicationError('VALIDATION_FAILED', message, { details });
}

/**
 * Recursive-descent JSON parser that rejects duplicate object keys (native
 * `JSON.parse` silently keeps the last occurrence). Used for the `json`
 * bundle format and for every JSON file packed inside a `zip` bundle.
 */
export function parseJsonNoDuplicateKeys(text: string): unknown {
  let index = 0;
  const { length } = text;

  function fail(message: string): never {
    rejectValidation(`Invalid JSON bundle: ${message} at offset ${index}.`);
  }

  function skipWhitespace(): void {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  }

  function expect(char: string): void {
    if (text[index] !== char) {
      fail(`expected "${char}"`);
    }
    index += 1;
  }

  function parseString(): string {
    expect('"');
    let result = '';
    while (index < length) {
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return result;
      }
      if (char === '\\') {
        index += 1;
        const escape = text[index];
        if (escape === undefined) fail('unterminated escape sequence');
        switch (escape) {
          case '"':
            result += '"';
            break;
          case '\\':
            result += '\\';
            break;
          case '/':
            result += '/';
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
            result += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            fail(`invalid escape sequence "\\${escape}"`);
        }
        index += 1;
      } else {
        result += char;
        index += 1;
      }
    }
    fail('unterminated string');
  }

  function parseNumber(): number {
    const start = index;
    if (text[index] === '-') index += 1;
    while (index < length && text[index]! >= '0' && text[index]! <= '9') index += 1;
    if (text[index] === '.') {
      index += 1;
      while (index < length && text[index]! >= '0' && text[index]! <= '9') index += 1;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      index += 1;
      if (text[index] === '+' || text[index] === '-') index += 1;
      while (index < length && text[index]! >= '0' && text[index]! <= '9') index += 1;
    }
    const raw = text.slice(start, index);
    if (raw.length === 0 || raw === '-') fail('invalid number literal');
    return Number(raw);
  }

  function parseLiteral(literal: string, value: unknown): unknown {
    if (text.slice(index, index + literal.length) !== literal) fail(`expected "${literal}"`);
    index += literal.length;
    return value;
  }

  function parseArray(): unknown[] {
    expect('[');
    const values: unknown[] = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return values;
    }
    for (;;) {
      values.push(parseValue());
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      expect(']');
      return values;
    }
  }

  function parseObject(): Record<string, unknown> {
    expect('{');
    const result: Record<string, unknown> = {};
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (Object.hasOwn(result, key)) {
        fail(`duplicate object key "${key}"`);
      }
      skipWhitespace();
      expect(':');
      result[key] = parseValue();
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      expect('}');
      return result;
    }
  }

  function parseValue(): unknown {
    skipWhitespace();
    const char = text[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't') return parseLiteral('true', true);
    if (char === 'f') return parseLiteral('false', false);
    if (char === 'n') return parseLiteral('null', null);
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return parseNumber();
    fail('unexpected token');
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== length) {
    fail('unexpected trailing content');
  }
  return value;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    rejectValidation(`${context} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseBundleDocument(doc: unknown): BundleDocument {
  const record = asRecord(doc, 'The bundle');
  const allowedKeys = ['manifest', 'profiles', 'souls'];
  const extraKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length > 0) {
    rejectValidation(`The bundle has unknown field(s): ${extraKeys.join(', ')}.`);
  }
  const manifest = exportManifestSchema.parse(record.manifest);
  if (!Array.isArray(record.profiles)) {
    rejectValidation('The bundle "profiles" field must be an array.');
  }
  const souls = asRecord(record.souls, 'The bundle "souls" field');
  for (const [key, value] of Object.entries(souls)) {
    if (typeof value !== 'string') {
      rejectValidation(`The bundle soul entry "${key}" must be a string.`);
    }
  }
  return {
    manifest,
    profiles: record.profiles as ProfileWithoutSoul[],
    souls: souls as Record<string, string>,
  };
}

function findRawProfile(
  profiles: readonly ProfileWithoutSoul[],
  entry: ExportEntry,
): Record<string, unknown> {
  const match = profiles.find((candidate) => {
    const record = candidate as unknown as Record<string, unknown>;
    return record.id === entry.id && record.version === entry.version;
  });
  if (match === undefined) {
    rejectValidation(`No profile entry found for id "${entry.id}" version ${entry.version}.`);
  }
  return match as unknown as Record<string, unknown>;
}

/** Verified, hash-checked, fully-parsed import candidate for one manifest entry. */
interface ValidatedImportEntry {
  readonly entry: ExportEntry;
  readonly profile: AgentProfileFull;
}

function validateAndMergeEntries(bundle: BundleDocument): readonly ValidatedImportEntry[] {
  if (bundle.profiles.length !== bundle.manifest.entries.length) {
    rejectValidation(
      `The bundle declares ${bundle.manifest.entries.length} manifest entries but contains ${bundle.profiles.length} profiles.`,
    );
  }

  return bundle.manifest.entries.map((entry): ValidatedImportEntry => {
    const rawProfile = findRawProfile(bundle.profiles, entry);
    const soulMarkdown = bundle.souls[entry.soulPath];
    if (soulMarkdown === undefined) {
      rejectValidation(`No SOUL content found at path "${entry.soulPath}" for id "${entry.id}".`);
    }

    let profile: AgentProfileFull;
    try {
      profile = agentProfileFullSchema.parse({ ...rawProfile, soulMarkdown });
    } catch (error) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Profile "${entry.id}" version ${entry.version} failed full schema validation.`,
        { details: error },
      );
    }

    if (profile.id !== entry.id || profile.version !== entry.version) {
      rejectValidation(
        `Profile identity mismatch: manifest declares "${entry.id}" v${entry.version}, profile body declares "${profile.id}" v${profile.version}.`,
      );
    }

    const recomputedConfigSha256 = sha256Hex(canonicalProfileConfigJson(profile));
    if (recomputedConfigSha256 !== entry.configSha256) {
      rejectValidation(
        `Profile "${entry.id}" version ${entry.version} config checksum does not match the manifest.`,
      );
    }

    const recomputedSoulSha256 = soulSha256(soulMarkdown);
    if (recomputedSoulSha256 !== entry.soulSha256 || recomputedSoulSha256 !== profile.soulSha256) {
      rejectValidation(
        `Profile "${entry.id}" version ${entry.version} SOUL checksum does not match the manifest.`,
      );
    }

    if (!validateProfilePermissions(profile)) {
      rejectValidation(
        `Profile "${entry.id}" version ${entry.version} permissions exceed the "${profile.permissionTemplate}" template ceiling.`,
      );
    }

    try {
      assertSoulPolicyCompliant(profile.soulMarkdown);
    } catch (error) {
      if (error instanceof SoulPolicyViolationError) {
        rejectValidation(
          `Profile "${entry.id}" version ${entry.version} SOUL failed policy compliance: ${error.message}`,
        );
      }
      throw error;
    }

    return { entry, profile };
  });
}

export class ProfileIoService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly repository: AgentProfileRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public exportProfiles(options: ExportProfilesOptions): ExportedProfileBundle {
    const fullProfiles = options.includeHistory
      ? this.repository
          .listAll()
          .filter((profile): profile is AgentProfileFull => profile.executionMode === 'full')
      : this.repository.listActiveFullProfiles();

    if (fullProfiles.length === 0) {
      rejectValidation('There are no full agent profiles available to export.');
    }

    const entries: ExportEntry[] = [];
    const profiles: ProfileWithoutSoul[] = [];
    const souls: Record<string, string> = {};

    for (const profile of fullProfiles) {
      const profilePath = profilePathFor(profile.id, profile.version);
      const soulPath = soulPathFor(profile.id, profile.version);
      entries.push({
        id: profile.id,
        version: profile.version,
        profilePath,
        soulPath,
        configSha256: sha256Hex(canonicalProfileConfigJson(profile)),
        soulSha256: profile.soulSha256,
      });
      profiles.push(stripSoul(profile));
      souls[soulPath] = profile.soulMarkdown;
    }

    const manifest = exportManifestSchema.parse({
      schemaVersion: 1,
      exportedAt: this.now().toISOString(),
      includeHistory: options.includeHistory,
      entries,
    });

    const bundle: BundleDocument = { manifest, profiles, souls };

    if (options.format === 'json') {
      return { format: 'json', content: JSON.stringify(bundle, null, 2) };
    }
    if (options.format === 'yaml') {
      return { format: 'yaml', content: stringifyYaml(bundle) };
    }
    return { format: 'zip', content: this.writeZipBundle(bundle) };
  }

  public importProfiles(bundle: string | Buffer, options: ImportProfilesOptions): ImportResult {
    const document = this.parseBundle(bundle, options.format);
    const validatedEntries = validateAndMergeEntries(document);

    const existingProfiles = this.repository.listAll();
    const existingByKey = new Map<string, (typeof existingProfiles)[number]>(
      existingProfiles.map((profile) => [`${profile.id}@${profile.version}`, profile]),
    );
    const simulatedMaxVersion = new Map<string, number>();
    for (const profile of existingProfiles) {
      const current = simulatedMaxVersion.get(profile.id) ?? 0;
      simulatedMaxVersion.set(profile.id, Math.max(current, profile.version));
    }

    const sortedEntries = [...validatedEntries].sort((left, right) => {
      if (left.profile.id !== right.profile.id)
        return left.profile.id.localeCompare(right.profile.id);
      return left.profile.version - right.profile.version;
    });

    const outcomes: ImportOutcome[] = [];
    const toApply: AgentProfileFull[] = [];

    for (const { profile } of sortedEntries) {
      const key = `${profile.id}@${profile.version}`;
      const existing = existingByKey.get(key);
      if (existing !== undefined) {
        const identical =
          canonicalProfileConfigJson(existing) === canonicalProfileConfigJson(profile);
        outcomes.push({
          id: profile.id,
          version: profile.version,
          outcome: identical ? 'skipped_identical' : 'conflict',
        });
        continue;
      }

      const currentMax = simulatedMaxVersion.get(profile.id) ?? 0;
      if (profile.version !== currentMax + 1) {
        rejectValidation(
          `Profile "${profile.id}" version ${profile.version} is not the next sequential version (expected ${currentMax + 1}).`,
        );
      }
      simulatedMaxVersion.set(profile.id, profile.version);
      outcomes.push({ id: profile.id, version: profile.version, outcome: 'imported' });
      toApply.push(profile);
    }

    const hasConflict = outcomes.some((outcome) => outcome.outcome === 'conflict');
    const shouldApply = !options.dryRun && !hasConflict && toApply.length > 0;

    if (shouldApply) {
      withImmediateTransaction(this.database, () => {
        for (const profile of toApply) {
          this.repository.insertFullVersion(profile);
        }
      });
    }

    return importResultSchema.parse({
      dryRun: options.dryRun,
      outcomes,
      applied: shouldApply,
    });
  }

  private parseBundle(bundle: string | Buffer, format: ProfileTransferFormat): BundleDocument {
    if (format === 'zip') {
      if (!Buffer.isBuffer(bundle)) {
        rejectValidation('A "zip" format bundle must be provided as a Buffer.');
      }
      return this.parseZipBundle(bundle);
    }

    const text = Buffer.isBuffer(bundle) ? bundle.toString('utf8') : bundle;
    if (format === 'json') {
      return parseBundleDocument(parseJsonNoDuplicateKeys(text));
    }

    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(text, { uniqueKeys: true, strict: true });
    } catch (error) {
      throw new ApplicationError('VALIDATION_FAILED', 'The YAML bundle failed strict parsing.', {
        details: error,
      });
    }
    return parseBundleDocument(parsedYaml);
  }

  private writeZipBundle(bundle: BundleDocument): Buffer {
    const manifestJson = JSON.stringify(bundle.manifest);
    const fileEntries = new Map<string, Buffer>();
    fileEntries.set(MANIFEST_ENTRY_NAME, Buffer.from(manifestJson, 'utf8'));

    for (const entry of bundle.manifest.entries) {
      const rawProfile = findRawProfile(bundle.profiles, entry);
      fileEntries.set(entry.profilePath, Buffer.from(JSON.stringify(rawProfile), 'utf8'));
      const soulMarkdown = bundle.souls[entry.soulPath];
      if (soulMarkdown === undefined) {
        rejectValidation(`No SOUL content found at path "${entry.soulPath}" for id "${entry.id}".`);
      }
      fileEntries.set(entry.soulPath, Buffer.from(soulMarkdown, 'utf8'));
    }

    const checksums: Record<string, string> = {};
    for (const [name, data] of fileEntries) {
      checksums[name] = sha256Hex(data.toString('utf8'));
    }
    fileEntries.set(CHECKSUMS_ENTRY_NAME, Buffer.from(JSON.stringify(checksums), 'utf8'));

    const zipEntries: ZipEntryInput[] = [...fileEntries].map(([name, data]) => ({ name, data }));
    try {
      return writeStoreZip(zipEntries);
    } catch (error) {
      if (error instanceof ZipValidationError) {
        throw new ApplicationError('VALIDATION_FAILED', error.message);
      }
      throw error;
    }
  }

  private parseZipBundle(buffer: Buffer): BundleDocument {
    let zipEntries;
    try {
      zipEntries = readStoreZip(buffer);
    } catch (error) {
      if (error instanceof ZipValidationError) {
        throw new ApplicationError('VALIDATION_FAILED', error.message);
      }
      throw error;
    }

    const byName = new Map(zipEntries.map((entry) => [entry.name, entry.data] as const));

    const manifestData = byName.get(MANIFEST_ENTRY_NAME);
    if (manifestData === undefined) {
      rejectValidation(`The zip bundle is missing "${MANIFEST_ENTRY_NAME}".`);
    }
    const checksumsData = byName.get(CHECKSUMS_ENTRY_NAME);
    if (checksumsData === undefined) {
      rejectValidation(`The zip bundle is missing "${CHECKSUMS_ENTRY_NAME}".`);
    }

    const checksums = asRecord(
      parseJsonNoDuplicateKeys(checksumsData.toString('utf8')),
      `The "${CHECKSUMS_ENTRY_NAME}" file`,
    );
    for (const [name, data] of byName) {
      if (name === CHECKSUMS_ENTRY_NAME) continue;
      const declared = checksums[name];
      if (typeof declared !== 'string') {
        rejectValidation(`The zip bundle checksum file is missing an entry for "${name}".`);
      }
      const actual = sha256Hex(data.toString('utf8'));
      if (actual !== declared) {
        rejectValidation(`The zip bundle entry "${name}" does not match its declared checksum.`);
      }
    }

    const manifest = exportManifestSchema.parse(
      parseJsonNoDuplicateKeys(manifestData.toString('utf8')),
    );

    const expectedEntryCount = 2 + manifest.entries.length * 2;
    if (byName.size !== expectedEntryCount) {
      rejectValidation('The zip bundle contains unexpected or missing entries.');
    }

    const profiles: ProfileWithoutSoul[] = [];
    const souls: Record<string, string> = {};
    for (const entry of manifest.entries) {
      const profileData = byName.get(entry.profilePath);
      if (profileData === undefined) {
        rejectValidation(`The zip bundle is missing profile file "${entry.profilePath}".`);
      }
      const soulData = byName.get(entry.soulPath);
      if (soulData === undefined) {
        rejectValidation(`The zip bundle is missing SOUL file "${entry.soulPath}".`);
      }
      profiles.push(
        parseJsonNoDuplicateKeys(profileData.toString('utf8')) as unknown as ProfileWithoutSoul,
      );
      souls[entry.soulPath] = soulData.toString('utf8');
    }

    return { manifest, profiles, souls };
  }
}

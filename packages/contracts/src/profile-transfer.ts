import { z } from 'zod';

import {
  agentIdSchema,
  nfcStringSchema,
  positiveSafeIntegerSchema,
  sha256HexSchema,
  utcIso8601Schema,
} from './base.js';

export const exportEntrySchema = z
  .object({
    id: agentIdSchema,
    version: positiveSafeIntegerSchema,
    profilePath: nfcStringSchema(1, 256),
    soulPath: nfcStringSchema(1, 256),
    configSha256: sha256HexSchema,
    soulSha256: sha256HexSchema,
  })
  .strict();

export const exportManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: utcIso8601Schema,
    includeHistory: z.boolean(),
    entries: z.array(exportEntrySchema).min(1).max(256),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      const key = `${entry.id}:${entry.version}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Export entries must have unique (id, version) pairs.',
          path: ['entries', index],
        });
      }
      seen.add(key);
    }
  });

export const importOutcomeSchema = z
  .object({
    id: agentIdSchema,
    version: positiveSafeIntegerSchema,
    outcome: z.enum(['imported', 'skipped_identical', 'conflict']),
  })
  .strict();

export const importResultSchema = z
  .object({
    dryRun: z.boolean(),
    outcomes: z.array(importOutcomeSchema).max(256),
    applied: z.boolean(),
  })
  .strict();

export type ExportEntry = z.infer<typeof exportEntrySchema>;
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ImportOutcome = z.infer<typeof importOutcomeSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;

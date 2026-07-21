import { z } from 'zod';

import {
  absolutePathSchema,
  dataClassificationSchema,
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  projectKeySchema,
  sha256HexSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const sourceCardStatusSchema = z.enum([
  'active',
  'stale',
  'missing',
  'superseded',
  'archived',
]);
export const sourceRequestStatusSchema = z.enum(['open', 'resolved', 'cancelled']);
export const connectorTypeSchema = z.enum([
  'local-folder',
  'registered-git',
  'google-drive',
  'nas',
]);
export const checksumAlgorithmSchema = z.literal('sha256');

const sourceTitleSchema = nfcStringSchema(1, 500);
const approvedMinimalSummarySchema = nfcStringSchema(1, 4000);
const sourceTagsSchema = normalizedUniqueStringArraySchema(1, 20, 1, 80);
const allowedRolesSchema = normalizedUniqueStringArraySchema(1, 50, 1, 128);
const sourceVersionSchema = nfcStringSchema(1, 128);
const sourceOwnerSchema = nfcStringSchema(1, 128);

export const sourceCardSchema = z
  .object({
    sourceId: ulidSchema,
    title: sourceTitleSchema,
    summary: approvedMinimalSummarySchema.nullable(),
    tags: sourceTagsSchema,
    projectId: projectKeySchema,
    connectorType: connectorTypeSchema,
    locator: absolutePathSchema,
    owner: sourceOwnerSchema,
    classification: dataClassificationSchema,
    allowedRoles: allowedRolesSchema,
    version: sourceVersionSchema,
    checksumAlgorithm: checksumAlgorithmSchema,
    checksum: sha256HexSchema,
    recordedAt: utcIso8601Schema,
    lastVerifiedAt: utcIso8601Schema,
    status: sourceCardStatusSchema,
    supersedesSourceId: ulidSchema.nullable(),
    metadataVersion: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((card, context) => {
    if (card.lastVerifiedAt < card.recordedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'lastVerifiedAt cannot precede recordedAt.',
        path: ['lastVerifiedAt'],
      });
    }
    if (card.supersedesSourceId === card.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A source card cannot supersede itself.',
        path: ['supersedesSourceId'],
      });
    }
  });

export const registerSourceInputSchema = z
  .object({
    title: sourceTitleSchema,
    summary: approvedMinimalSummarySchema.nullable().optional(),
    tags: sourceTagsSchema,
    projectId: projectKeySchema,
    connectorType: connectorTypeSchema,
    locator: absolutePathSchema,
    owner: sourceOwnerSchema,
    classification: dataClassificationSchema,
    allowedRoles: allowedRolesSchema,
    version: sourceVersionSchema,
    checksumAlgorithm: checksumAlgorithmSchema,
    checksum: sha256HexSchema,
    supersedesSourceId: ulidSchema.nullable().optional().default(null),
  })
  .strict();

const requestedMaterialSchema = nfcStringSchema(1, 1000);
const sourceRequestCriteriaSchema = nfcStringSchema(1, 2000);
const acceptableFormatsSchema = normalizedUniqueStringArraySchema(0, 20, 1, 128);
const expectedLocationsSchema = normalizedUniqueStringArraySchema(0, 20, 1, 2048);
const sourceRequestPurposeSchema = nfcStringSchema(1, 500);
const requesterRoleSchema = nfcStringSchema(1, 128);

export const sourceRequestCreateInputSchema = z
  .object({
    projectId: projectKeySchema,
    requestedMaterial: requestedMaterialSchema,
    criteria: sourceRequestCriteriaSchema.nullable(),
    acceptableFormats: acceptableFormatsSchema,
    expectedLocations: expectedLocationsSchema,
    purpose: sourceRequestPurposeSchema,
    requesterRole: requesterRoleSchema,
  })
  .strict();

export const sourceRequestSchema = z
  .object({
    requestId: ulidSchema,
    ...sourceRequestCreateInputSchema.shape,
    requestedAt: utcIso8601Schema,
    resolvedBySourceId: ulidSchema.nullable(),
    resolvedAt: utcIso8601Schema.nullable(),
    status: sourceRequestStatusSchema,
    metadataVersion: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const isResolved = request.status === 'resolved';
    const hasResolution = request.resolvedBySourceId !== null && request.resolvedAt !== null;
    if (isResolved && !hasResolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resolved source requests require both resolution fields.',
        path: ['resolvedBySourceId'],
      });
    }
    if (!isResolved && (request.resolvedBySourceId !== null || request.resolvedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only resolved source requests can have resolution fields.',
        path: ['resolvedBySourceId'],
      });
    }
    if (request.resolvedAt !== null && request.resolvedAt < request.requestedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resolution time cannot precede request time.',
        path: ['resolvedAt'],
      });
    }
  });

export type SourceCardStatus = z.infer<typeof sourceCardStatusSchema>;
export type SourceRequestStatus = z.infer<typeof sourceRequestStatusSchema>;
export type ConnectorType = z.infer<typeof connectorTypeSchema>;
export type SourceCard = z.infer<typeof sourceCardSchema>;
export type RegisterSourceInput = z.infer<typeof registerSourceInputSchema>;
export type SourceRequestCreateInput = z.infer<typeof sourceRequestCreateInputSchema>;
export type SourceRequest = z.infer<typeof sourceRequestSchema>;

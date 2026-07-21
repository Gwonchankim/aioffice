import { z } from 'zod';

import {
  agentIdSchema,
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
} from './base.js';

export const providerSchema = z.enum(['openai', 'anthropic']);
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const permissionTemplateSchema = z.enum([
  'orchestrator',
  'advisor',
  'builder',
  'qa_writer',
  'reviewer',
  'integrator',
  'knowledge-registry',
]);

export const fallbackModelSchema = z
  .object({
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
  })
  .strict();

const registryOperationScopeSchema = z.enum([
  'project-metadata-read',
  'registry-search',
  'sourcecard-register',
  'sourcecard-update',
  'purpose-bound-excerpt-read',
  'sourcerequest-create',
  'sourcerequest-resolve',
  'audit-write',
  'sourcecard-archive-with-approval',
]);

const registryPermissionFields = [
  'registryProjectMetadataReadAllowed',
  'registrySearchAllowed',
  'sourceCardRegisterAllowed',
  'sourceCardUpdateAllowed',
  'purposeBoundExcerptReadAllowed',
  'sourceRequestCreateAllowed',
  'sourceRequestResolveAllowed',
  'auditWriteAllowed',
  'connectorReadAllowed',
  'sourceCardArchiveWithApprovalAllowed',
  'sourceRepositoryWriteAllowed',
  'sourceFileDeleteMoveRenameAllowed',
  'permissionChangeAllowed',
  'classificationDowngradeAllowed',
  'externalShareAllowed',
  'archiveDeleteWithoutApprovalAllowed',
  'sourceCardDeleteAllowed',
  'arbitraryNetworkEndpointAllowed',
] as const;

export const agentPermissionsSchema = z
  .object({
    networkReadAllowed: z.boolean(),
    projectReadAllowed: z.boolean(),
    artifactWriteAllowed: z.boolean(),
    worktreeWriteAllowed: z.boolean(),
    localCommitAllowed: z.boolean(),
    externalActionsAllowed: z.boolean(),
    registryProjectMetadataReadAllowed: z.boolean().optional(),
    registrySearchAllowed: z.boolean().optional(),
    sourceCardRegisterAllowed: z.boolean().optional(),
    sourceCardUpdateAllowed: z.boolean().optional(),
    purposeBoundExcerptReadAllowed: z.boolean().optional(),
    sourceRequestCreateAllowed: z.boolean().optional(),
    sourceRequestResolveAllowed: z.boolean().optional(),
    auditWriteAllowed: z.boolean().optional(),
    connectorReadAllowed: z.boolean().optional(),
    sourceCardArchiveWithApprovalAllowed: z.boolean().optional(),
    sourceRepositoryWriteAllowed: z.boolean().optional(),
    sourceFileDeleteMoveRenameAllowed: z.boolean().optional(),
    permissionChangeAllowed: z.boolean().optional(),
    classificationDowngradeAllowed: z.boolean().optional(),
    externalShareAllowed: z.boolean().optional(),
    archiveDeleteWithoutApprovalAllowed: z.boolean().optional(),
    sourceCardDeleteAllowed: z.boolean().optional(),
    arbitraryNetworkEndpointAllowed: z.boolean().optional(),
    registryOperationScopes: z.array(registryOperationScopeSchema).min(1).max(9).optional(),
  })
  .strict()
  .superRefine((permissions, context) => {
    const scopes = permissions.registryOperationScopes;
    if (scopes !== undefined && new Set(scopes).size !== scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Registry operation scopes must be unique.',
        path: ['registryOperationScopes'],
      });
    }
  });

export const agentProfileSkeletonSchema = z
  .object({
    id: agentIdSchema,
    version: positiveSafeIntegerSchema,
    name: nfcStringSchema(1, 40),
    displayName: nfcStringSchema(1, 100),
    description: nfcStringSchema(20, 500),
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    fallbackModels: z.array(fallbackModelSchema).max(3),
    reasoningEffort: reasoningEffortSchema,
    permissionTemplate: permissionTemplateSchema,
    permissions: agentPermissionsSchema,
    capabilities: normalizedUniqueStringArraySchema(1, 32, 1, 64),
    enabled: z.literal(false),
    executionMode: z.literal('skeleton'),
  })
  .strict()
  .superRefine((profile, context) => {
    const modelKeys = new Set<string>();
    for (const [index, fallback] of profile.fallbackModels.entries()) {
      const key = `${fallback.provider}:${fallback.model}`;
      if (fallback.provider === profile.provider && fallback.model === profile.model) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A fallback model cannot duplicate the primary model.',
          path: ['fallbackModels', index],
        });
      }
      if (modelKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Fallback models must be unique.',
          path: ['fallbackModels', index],
        });
      }
      modelKeys.add(key);
    }

    if (profile.id === 'arca') {
      if (profile.permissionTemplate !== 'knowledge-registry') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Arca requires the knowledge-registry permission template.',
          path: ['permissionTemplate'],
        });
      }
      for (const field of registryPermissionFields) {
        if (profile.permissions[field] === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Arca requires every registry permission ceiling field.',
            path: ['permissions', field],
          });
        }
      }
      if (profile.permissions.registryOperationScopes === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Arca requires registry operation scopes.',
          path: ['permissions', 'registryOperationScopes'],
        });
      }
      return;
    }

    if (profile.permissionTemplate === 'knowledge-registry') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only Arca can use the knowledge-registry permission template.',
        path: ['permissionTemplate'],
      });
    }
    for (const field of registryPermissionFields) {
      if (profile.permissions[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Registry permission ceiling fields are only valid for Arca.',
          path: ['permissions', field],
        });
      }
    }
    if (profile.permissions.registryOperationScopes !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Registry operation scopes are only valid for Arca.',
        path: ['permissions', 'registryOperationScopes'],
      });
    }
  });

export type Provider = z.infer<typeof providerSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type PermissionTemplate = z.infer<typeof permissionTemplateSchema>;
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
export type AgentProfileSkeleton = z.infer<typeof agentProfileSkeletonSchema>;

import { z } from 'zod';

import {
  agentIdSchema,
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  sha256HexSchema,
} from './base.js';

export const soulSha256Schema = sha256HexSchema;

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

export const agentRoutingSchema = z
  .object({
    capabilities: normalizedUniqueStringArraySchema(1, 32, 1, 64),
    triggers: z
      .array(nfcStringSchema(1, 100))
      .min(1)
      .max(32)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Routing triggers must be unique.',
          });
        }
      }),
    exclusions: z.array(nfcStringSchema(1, 200)).max(32),
    requiredCollaborators: z.array(agentIdSchema).max(8),
    recommendedCollaborators: z.array(agentIdSchema).max(8),
  })
  .strict();

export const agentContractsSchema = z
  .object({
    outputSchema: nfcStringSchema(1, 64),
    requiredArtifactKinds: normalizedUniqueStringArraySchema(0, 10, 1, 64),
    stopConditions: normalizedUniqueStringArraySchema(0, 10, 1, 64),
  })
  .strict();

const fullProfileCapabilitiesSchema = normalizedUniqueStringArraySchema(1, 32, 1, 64);

export const agentProfileFullSchema = z
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
    capabilities: fullProfileCapabilitiesSchema,
    routing: agentRoutingSchema,
    contracts: agentContractsSchema,
    soulMarkdown: nfcStringSchema(20, 200000),
    soulSha256: soulSha256Schema,
    enabled: z.boolean(),
    executionMode: z.literal('full'),
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
      if (profile.enabled !== false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Arca must remain disabled.',
          path: ['enabled'],
        });
      }
    } else {
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
    }

    if (
      profile.permissionTemplate === 'builder' &&
      !profile.routing.requiredCollaborators.some(
        (collaborator) => collaborator === 'verify' || collaborator === 'sentinel',
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Builder profiles require a QA collaborator (verify or sentinel).',
        path: ['routing', 'requiredCollaborators'],
      });
    }

    if (profile.id === 'orion' || profile.id === 'nexus') {
      if (profile.permissions.worktreeWriteAllowed !== false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Orion and Nexus cannot allow worktree writes.',
          path: ['permissions', 'worktreeWriteAllowed'],
        });
      }
      if (profile.permissions.localCommitAllowed !== false) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Orion and Nexus cannot allow local commits.',
          path: ['permissions', 'localCommitAllowed'],
        });
      }
    }

    if (profile.id === 'sentinel' && profile.permissionTemplate !== 'reviewer') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Sentinel must use the reviewer permission template.',
        path: ['permissionTemplate'],
      });
    }

    for (const key of ['requiredCollaborators', 'recommendedCollaborators'] as const) {
      const collaborators = profile.routing[key];
      const seen = new Set<string>();
      for (const [index, collaborator] of collaborators.entries()) {
        if (collaborator === profile.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A profile cannot list itself as a collaborator.',
            path: ['routing', key, index],
          });
        }
        if (seen.has(collaborator)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Collaborators must be unique.',
            path: ['routing', key, index],
          });
        }
        seen.add(collaborator);
      }
    }
  });

export const agentProfileSchema = z.union([agentProfileSkeletonSchema, agentProfileFullSchema]);

export type Provider = z.infer<typeof providerSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type PermissionTemplate = z.infer<typeof permissionTemplateSchema>;
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
export type AgentProfileSkeleton = z.infer<typeof agentProfileSkeletonSchema>;
export type AgentRouting = z.infer<typeof agentRoutingSchema>;
export type AgentContracts = z.infer<typeof agentContractsSchema>;
export type AgentProfileFull = z.infer<typeof agentProfileFullSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

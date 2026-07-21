import type { AgentPermissions, AgentProfileSkeleton, PermissionTemplate } from '@orion/contracts';

const registryOperationScopes = [
  'project-metadata-read',
  'registry-search',
  'sourcecard-register',
  'sourcecard-update',
  'purpose-bound-excerpt-read',
  'sourcerequest-create',
  'sourcerequest-resolve',
  'audit-write',
  'sourcecard-archive-with-approval',
] as const;

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

const permissionCeilingDefinitions: Record<PermissionTemplate, AgentPermissions> = {
  orchestrator: {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    externalActionsAllowed: false,
  },
  advisor: {
    networkReadAllowed: true,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    externalActionsAllowed: false,
  },
  builder: {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    externalActionsAllowed: false,
  },
  qa_writer: {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    externalActionsAllowed: false,
  },
  reviewer: {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    externalActionsAllowed: false,
  },
  integrator: {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    externalActionsAllowed: false,
  },
  'knowledge-registry': {
    networkReadAllowed: false,
    projectReadAllowed: true,
    artifactWriteAllowed: false,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    externalActionsAllowed: false,
    registryProjectMetadataReadAllowed: true,
    registrySearchAllowed: true,
    sourceCardRegisterAllowed: true,
    sourceCardUpdateAllowed: true,
    purposeBoundExcerptReadAllowed: true,
    sourceRequestCreateAllowed: true,
    sourceRequestResolveAllowed: true,
    auditWriteAllowed: true,
    connectorReadAllowed: true,
    sourceCardArchiveWithApprovalAllowed: true,
    sourceRepositoryWriteAllowed: false,
    sourceFileDeleteMoveRenameAllowed: false,
    permissionChangeAllowed: false,
    classificationDowngradeAllowed: false,
    externalShareAllowed: false,
    archiveDeleteWithoutApprovalAllowed: false,
    sourceCardDeleteAllowed: false,
    arbitraryNetworkEndpointAllowed: false,
    registryOperationScopes: [...registryOperationScopes],
  },
};

export const permissionCeilings = deepFreeze(permissionCeilingDefinitions);

const permissionBooleanFields = [
  'networkReadAllowed',
  'projectReadAllowed',
  'artifactWriteAllowed',
  'worktreeWriteAllowed',
  'localCommitAllowed',
  'externalActionsAllowed',
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
] as const satisfies readonly (keyof AgentPermissions)[];

export function validateProfilePermissions(
  profile: Pick<AgentProfileSkeleton, 'permissionTemplate' | 'permissions'>,
): boolean {
  const ceiling = permissionCeilings[profile.permissionTemplate];

  for (const field of permissionBooleanFields) {
    if (profile.permissions[field] === true && ceiling[field] !== true) {
      return false;
    }
  }

  const requestedScopes = profile.permissions.registryOperationScopes;
  if (requestedScopes === undefined) {
    return true;
  }

  const allowedScopes = ceiling.registryOperationScopes;
  return (
    allowedScopes !== undefined && requestedScopes.every((scope) => allowedScopes.includes(scope))
  );
}

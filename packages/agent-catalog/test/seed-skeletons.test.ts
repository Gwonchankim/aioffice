import { describe, expect, it } from 'vitest';

import { agentProfileSkeletonSchema } from '@orion/contracts';

import {
  agentProfileSeedSkeletons,
  permissionCeilings,
  validateProfilePermissions,
} from '../src/index.js';

const expectedIds = [
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
];

describe('agent profile seed skeletons', () => {
  it('contains exactly the ordered catalog roster with unique id and version pairs', () => {
    expect(agentProfileSeedSkeletons).toHaveLength(18);
    expect(agentProfileSeedSkeletons.map((profile) => profile.id)).toEqual(expectedIds);
    expect(
      new Set(agentProfileSeedSkeletons.map((profile) => `${profile.id}:${profile.version}`)).size,
    ).toBe(18);
  });

  it('contains only disabled, contract-valid skeleton profiles', () => {
    for (const profile of agentProfileSeedSkeletons) {
      expect(profile.version).toBe(1);
      expect(profile.enabled).toBe(false);
      expect(profile.executionMode).toBe('skeleton');
      expect(agentProfileSkeletonSchema.safeParse(profile).success).toBe(true);
    }
  });

  it('keeps every seed at or below its permission ceiling', () => {
    for (const profile of agentProfileSeedSkeletons) {
      expect(validateProfilePermissions(profile)).toBe(true);
    }

    const atlas = agentProfileSeedSkeletons.find((profile) => profile.id === 'atlas');
    expect(atlas).toBeDefined();
    expect(
      validateProfilePermissions({
        permissionTemplate: atlas!.permissionTemplate,
        permissions: { ...atlas!.permissions, worktreeWriteAllowed: true },
      }),
    ).toBe(false);
  });

  it('includes Arca with the default-deny registry ceiling and no Fable model', () => {
    const arca = agentProfileSeedSkeletons.find((profile) => profile.id === 'arca');

    expect(arca).toBeDefined();
    expect(arca!.permissionTemplate).toBe('knowledge-registry');
    expect(arca!.model.toLowerCase()).not.toContain('fable');
    expect(
      arca!.fallbackModels.every((model) => !model.model.toLowerCase().includes('fable')),
    ).toBe(true);
    expect(arca!.permissions).toMatchObject({
      networkReadAllowed: false,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      externalActionsAllowed: false,
      sourceRepositoryWriteAllowed: false,
      sourceFileDeleteMoveRenameAllowed: false,
      permissionChangeAllowed: false,
      classificationDowngradeAllowed: false,
      externalShareAllowed: false,
      archiveDeleteWithoutApprovalAllowed: false,
      sourceCardDeleteAllowed: false,
      arbitraryNetworkEndpointAllowed: false,
    });
    expect(arca!.permissions.registryOperationScopes).toEqual(
      permissionCeilings['knowledge-registry'].registryOperationScopes,
    );
    expect(
      validateProfilePermissions({
        permissionTemplate: 'knowledge-registry',
        permissions: { ...arca!.permissions, externalActionsAllowed: true },
      }),
    ).toBe(false);
  });

  it('deep-freezes seed definitions and permission ceilings', () => {
    expect(Object.isFrozen(agentProfileSeedSkeletons)).toBe(true);
    expect(Object.isFrozen(permissionCeilings)).toBe(true);

    for (const profile of agentProfileSeedSkeletons) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.permissions)).toBe(true);
      expect(Object.isFrozen(profile.capabilities)).toBe(true);
      expect(Object.isFrozen(profile.fallbackModels)).toBe(true);
    }
  });
});

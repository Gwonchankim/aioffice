import { describe, expect, it } from 'vitest';
import { agentProfileSeedSkeletons } from '@orion/agent-catalog';

import { ProjectPolicyService } from '../src/project-policy.js';
import { ProviderTransferPolicy } from '../src/provider-transfer-policy.js';

const fableProfile = {
  ...agentProfileSeedSkeletons[0]!,
  provider: 'anthropic' as const,
  model: 'claude-fable-synthetic',
  fallbackModels: [
    { provider: 'anthropic' as const, model: 'claude-fable-fallback' },
    { provider: 'anthropic' as const, model: 'claude-safe-synthetic' },
  ],
};

const project = {
  classification: 'internal' as const,
  providerPolicy: { openai: true, anthropic: true, allowFable: true },
};

describe('provider transfer policy', () => {
  it('ARCA-001 blocks controlled metadata, summaries, and excerpts before any provider effect', () => {
    const policy = new ProviderTransferPolicy();
    for (const payloadKind of ['metadata', 'summary', 'excerpt'] as const) {
      expect(() =>
        policy.assertAllowed({
          project,
          provider: 'openai',
          model: 'synthetic-model',
          payloadClassification: 'controlled',
          payloadKind,
          selection: 'direct',
        }),
      ).toThrow('Provider execution is not allowed by policy.');
    }
  });

  it('ARCA-002 intersects confidential provider policy and never substitutes another provider', () => {
    const policy = new ProviderTransferPolicy();
    expect(() =>
      policy.assertAllowed({
        project: {
          classification: 'confidential',
          providerPolicy: { openai: false, anthropic: true, allowFable: false },
        },
        provider: 'openai',
        model: 'synthetic-model',
        payloadClassification: 'confidential',
        payloadKind: 'summary',
        selection: 'direct',
      }),
    ).toThrow('Provider execution is not allowed by policy.');
  });

  it('ARCA-003 excludes Fable from every default and fallback even when direct Fable is allowed', () => {
    const transfer = new ProviderTransferPolicy();
    const projectPolicy = new ProjectPolicyService();
    expect(transfer.arcaCandidates(project, fableProfile)).toEqual([
      { provider: 'anthropic', model: 'claude-safe-synthetic' },
    ]);
    expect(projectPolicy.arcaCandidates(project, fableProfile)).toEqual([
      { provider: 'anthropic', model: 'claude-safe-synthetic' },
    ]);
    expect(projectPolicy.arcaFallbackCandidates(project, fableProfile)).toEqual([
      { provider: 'anthropic', model: 'claude-safe-synthetic' },
    ]);
    expect(() =>
      transfer.assertAllowed({
        project,
        provider: 'anthropic',
        model: 'claude-fable-synthetic',
        payloadClassification: 'internal',
        payloadKind: 'summary',
        selection: 'arca-default',
        fableConfirmationValid: true,
      }),
    ).toThrow();
    expect(() =>
      transfer.assertAllowed({
        project,
        provider: 'anthropic',
        model: 'claude-fable-synthetic',
        payloadClassification: 'internal',
        payloadKind: 'summary',
        selection: 'direct',
        fableConfirmationValid: true,
      }),
    ).not.toThrow();
  });
  it('ARCA-004 rejects restricted input, controlled projects, and unconfirmed direct Fable without content disclosure', () => {
    const policy = new ProviderTransferPolicy();
    for (const request of [
      {
        project,
        provider: 'openai' as const,
        model: 'synthetic-model',
        payloadClassification: 'restricted' as const,
        payloadKind: 'metadata' as const,
        selection: 'direct' as const,
      },
      {
        project: { ...project, classification: 'controlled' as const },
        provider: 'openai' as const,
        model: 'synthetic-model',
        payloadClassification: 'internal' as const,
        payloadKind: 'summary' as const,
        selection: 'direct' as const,
      },
      {
        project,
        provider: 'anthropic' as const,
        model: 'claude-fable-synthetic',
        payloadClassification: 'internal' as const,
        payloadKind: 'excerpt' as const,
        selection: 'direct' as const,
        fableConfirmationValid: false,
      },
    ]) {
      expect(() => policy.assertAllowed(request)).toThrow(
        'Provider execution is not allowed by policy.',
      );
    }
  });
});

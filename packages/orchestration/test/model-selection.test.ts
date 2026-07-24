import { describe, expect, it } from 'vitest';

import type { ModelSelectionInput, ModelSelectionProviderPolicy } from '../src/index.js';
import { selectModel } from '../src/index.js';

const openPolicy: ModelSelectionProviderPolicy = {
  openai: true,
  anthropic: true,
  allowFable: false,
};

const atlasProfile = {
  provider: 'openai' as const,
  model: 'gpt-5.6-sol',
  fallbackModels: [
    { provider: 'anthropic' as const, model: 'claude-opus-4-8' },
    { provider: 'openai' as const, model: 'gpt-5.6-terra' },
  ],
};

const irisProfile = {
  provider: 'anthropic' as const,
  model: 'claude-fable-5',
  fallbackModels: [
    { provider: 'anthropic' as const, model: 'claude-opus-4-8' },
    { provider: 'openai' as const, model: 'gpt-5.6-sol' },
  ],
};

const allAvailableStates = [
  { provider: 'openai' as const, model: 'gpt-5.6-sol', status: 'available' as const },
  { provider: 'openai' as const, model: 'gpt-5.6-terra', status: 'available' as const },
  { provider: 'anthropic' as const, model: 'claude-opus-4-8', status: 'available' as const },
  { provider: 'anthropic' as const, model: 'claude-sonnet-5', status: 'available' as const },
  { provider: 'anthropic' as const, model: 'claude-fable-5', status: 'available' as const },
];

function baseInput(overrides: Partial<ModelSelectionInput> = {}): ModelSelectionInput {
  return {
    profile: atlasProfile,
    projectClassification: 'internal',
    providerPolicy: openPolicy,
    modelStates: allAvailableStates,
    isArca: false,
    ...overrides,
  };
}

describe('selectModel', () => {
  it('selects the primary model when it is available (non-fallback fields are null)', () => {
    const result = selectModel(baseInput());

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        viaFallback: false,
        fallbackReasonCode: null,
        fromProvider: null,
        fromModel: null,
      },
    });
  });

  it('falls back to fallback[0] when the primary is unavailable, carrying MODEL_UNAVAILABLE provenance', () => {
    const modelStates = allAvailableStates.map((entry) =>
      entry.model === 'gpt-5.6-sol' ? { ...entry, status: 'unavailable' as const } : entry,
    );

    const result = selectModel(baseInput({ modelStates }));

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        viaFallback: true,
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
        fromProvider: 'openai',
        fromModel: 'gpt-5.6-sol',
      },
    });
  });

  it('skips a policy-blocked fallback[0] and reaches fallback[1], while preserving the primary rejection reason', () => {
    const modelStates = allAvailableStates.map((entry) =>
      entry.model === 'gpt-5.6-sol' ? { ...entry, status: 'unavailable' as const } : entry,
    );
    const providerPolicy: ModelSelectionProviderPolicy = { ...openPolicy, anthropic: false };

    const result = selectModel(baseInput({ modelStates, providerPolicy }));

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        viaFallback: true,
        // Primary (gpt-5.6-sol) was rejected for MODEL_UNAVAILABLE, not for the
        // CLASSIFICATION_POLICY_BLOCKED reason that knocked out fallback[0].
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
        fromProvider: 'openai',
        fromModel: 'gpt-5.6-sol',
      },
    });
  });

  it('returns NO_ELIGIBLE_MODEL with one reason per candidate when every candidate is rejected', () => {
    const modelStates = allAvailableStates.map((entry) => ({
      ...entry,
      status: 'unavailable' as const,
    }));

    const result = selectModel(baseInput({ modelStates }));

    expect(result).toEqual({
      ok: false,
      code: 'NO_ELIGIBLE_MODEL',
      reasons: [
        { provider: 'openai', model: 'gpt-5.6-sol', reason: 'MODEL_UNAVAILABLE' },
        { provider: 'anthropic', model: 'claude-opus-4-8', reason: 'MODEL_UNAVAILABLE' },
        { provider: 'openai', model: 'gpt-5.6-terra', reason: 'MODEL_UNAVAILABLE' },
      ],
    });
  });

  it('blocks controlled-classification projects immediately with zero candidates evaluated', () => {
    const result = selectModel(baseInput({ projectClassification: 'controlled' }));

    expect(result).toEqual({
      ok: false,
      code: 'CONTROLLED_EXECUTION_BLOCKED',
      reasons: [],
    });
  });

  it('AGT-007 iris: confidential classification skips fable even with allowFable+confirmation, falling back to opus', () => {
    const result = selectModel(
      baseInput({
        profile: irisProfile,
        projectClassification: 'confidential',
        providerPolicy: { ...openPolicy, allowFable: true },
        fableConfirmationValid: true,
      }),
    );

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        viaFallback: true,
        fallbackReasonCode: 'CLASSIFICATION_POLICY_BLOCKED',
        fromProvider: 'anthropic',
        fromModel: 'claude-fable-5',
      },
    });
  });

  it('internal + allowFable false skips fable and falls back to opus', () => {
    const result = selectModel(
      baseInput({
        profile: irisProfile,
        projectClassification: 'internal',
        providerPolicy: { ...openPolicy, allowFable: false },
      }),
    );

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        viaFallback: true,
        fallbackReasonCode: 'CLASSIFICATION_POLICY_BLOCKED',
        fromProvider: 'anthropic',
        fromModel: 'claude-fable-5',
      },
    });
  });

  it('internal + allowFable true but missing confirmation skips fable', () => {
    const result = selectModel(
      baseInput({
        profile: irisProfile,
        projectClassification: 'internal',
        providerPolicy: { ...openPolicy, allowFable: true },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection.model).toBe('claude-opus-4-8');
      expect(result.selection.fallbackReasonCode).toBe('CLASSIFICATION_POLICY_BLOCKED');
    }
  });

  it('internal + allowFable true + valid confirmation selects fable as the primary', () => {
    const result = selectModel(
      baseInput({
        profile: irisProfile,
        projectClassification: 'internal',
        providerPolicy: { ...openPolicy, allowFable: true },
        fableConfirmationValid: true,
      }),
    );

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-fable-5',
        viaFallback: false,
        fallbackReasonCode: null,
        fromProvider: null,
        fromModel: null,
      },
    });
  });

  it('isArca true unconditionally skips fable models regardless of policy or confirmation', () => {
    const result = selectModel(
      baseInput({
        profile: irisProfile,
        projectClassification: 'internal',
        providerPolicy: { ...openPolicy, allowFable: true },
        fableConfirmationValid: true,
        isArca: true,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection.model).toBe('claude-opus-4-8');
      expect(result.selection.viaFallback).toBe(true);
      expect(result.selection.fallbackReasonCode).toBe('CLASSIFICATION_POLICY_BLOCKED');
    }
  });

  it('reports CAPABILITY_MISMATCH when the primary model state is incompatible', () => {
    const modelStates = allAvailableStates.map((entry) =>
      entry.model === 'gpt-5.6-sol' ? { ...entry, status: 'incompatible' as const } : entry,
    );

    const result = selectModel(baseInput({ modelStates }));

    expect(result).toEqual({
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        viaFallback: true,
        fallbackReasonCode: 'CAPABILITY_MISMATCH',
        fromProvider: 'openai',
        fromModel: 'gpt-5.6-sol',
      },
    });
  });

  it('never reorders candidates: fallback[0] is chosen even when fallback[1] is also available', () => {
    const modelStates = allAvailableStates.map((entry) =>
      entry.model === 'gpt-5.6-sol' ? { ...entry, status: 'unavailable' as const } : entry,
    );

    const result = selectModel(baseInput({ modelStates }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection.model).toBe('claude-opus-4-8');
    }
  });
});

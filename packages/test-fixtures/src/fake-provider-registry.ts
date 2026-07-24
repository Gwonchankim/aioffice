import type { ModelStatus, Provider, ProviderModelState } from '@orion/contracts';

export interface FakeProviderModel {
  readonly provider: Provider;
  readonly model: string;
}

export const fakeProviderModels: readonly FakeProviderModel[] = [
  { provider: 'openai', model: 'gpt-5.6-sol' },
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'anthropic', model: 'claude-opus-4-8' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-fable-5' },
];

export interface FakeProviderRegistryOverrides {
  readonly unavailable?: readonly string[];
  readonly incompatible?: readonly string[];
}

export interface FakeProviderRegistry {
  readonly modelStates: readonly ProviderModelState[];
  /** Returns a new registry with `model`'s status replaced by `status`. */
  setStatus(model: string, status: ModelStatus): FakeProviderRegistry;
  /** Identity helper: freezes an explicit snapshot of model states. */
  asOf(states: readonly ProviderModelState[]): readonly ProviderModelState[];
}

function statusFor(model: string, overrides: FakeProviderRegistryOverrides): ModelStatus {
  if (overrides.unavailable?.includes(model)) {
    return 'unavailable';
  }
  if (overrides.incompatible?.includes(model)) {
    return 'incompatible';
  }
  return 'available';
}

function fromStates(modelStates: readonly ProviderModelState[]): FakeProviderRegistry {
  return {
    modelStates,
    setStatus(model: string, status: ModelStatus): FakeProviderRegistry {
      const next = modelStates.map((entry) =>
        entry.model === model ? { ...entry, status } : entry,
      );
      return fromStates(next);
    },
    asOf(states: readonly ProviderModelState[]): readonly ProviderModelState[] {
      return states;
    },
  };
}

/**
 * Synthetic, in-memory provider registry fixture. No process spawning and no
 * network access: this only produces plain `ProviderModelState[]` data for
 * injection into pure orchestration logic under test.
 */
export function createFakeProviderRegistry(
  overrides: FakeProviderRegistryOverrides = {},
): FakeProviderRegistry {
  const modelStates: readonly ProviderModelState[] = fakeProviderModels.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    status: statusFor(entry.model, overrides),
  }));

  return fromStates(modelStates);
}

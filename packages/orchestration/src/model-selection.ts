import {
  modelSelectionSchema,
  type DataClassification,
  type FallbackReasonCode,
  type ModelSelection,
  type Provider,
  type ProviderModelState,
} from '@orion/contracts';

export interface ModelSelectionCandidate {
  readonly provider: Provider;
  readonly model: string;
}

export interface ModelSelectionProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels: readonly ModelSelectionCandidate[];
}

export interface ModelSelectionProviderPolicy {
  readonly openai: boolean;
  readonly anthropic: boolean;
  readonly allowFable: boolean;
}

export interface ModelSelectionInput {
  readonly profile: ModelSelectionProfile;
  readonly projectClassification: DataClassification;
  readonly providerPolicy: ModelSelectionProviderPolicy;
  readonly modelStates: readonly ProviderModelState[];
  readonly fableConfirmationValid?: boolean;
  readonly isArca: boolean;
}

export interface ModelSelectionRejection {
  readonly provider: Provider;
  readonly model: string;
  readonly reason: FallbackReasonCode;
}

export type ModelSelectionResult =
  | { readonly ok: true; readonly selection: ModelSelection }
  | {
      readonly ok: false;
      readonly code: 'NO_ELIGIBLE_MODEL' | 'CONTROLLED_EXECUTION_BLOCKED';
      readonly reasons: readonly ModelSelectionRejection[];
    };

const FABLE_MODEL_PATTERN = /fable/i;

function evaluateCandidate(
  candidate: ModelSelectionCandidate,
  input: ModelSelectionInput,
): FallbackReasonCode | null {
  const { providerPolicy, projectClassification, isArca, fableConfirmationValid, modelStates } =
    input;

  if (!providerPolicy[candidate.provider]) {
    return 'CLASSIFICATION_POLICY_BLOCKED';
  }

  if (FABLE_MODEL_PATTERN.test(candidate.model)) {
    if (isArca) {
      return 'CLASSIFICATION_POLICY_BLOCKED';
    }
    if (projectClassification === 'confidential') {
      return 'CLASSIFICATION_POLICY_BLOCKED';
    }
    if (!(providerPolicy.allowFable && fableConfirmationValid === true)) {
      return 'CLASSIFICATION_POLICY_BLOCKED';
    }
  }

  const state = modelStates.find(
    (entry) => entry.provider === candidate.provider && entry.model === candidate.model,
  );

  if (!state || state.status === 'unavailable') {
    return 'MODEL_UNAVAILABLE';
  }
  if (state.status === 'incompatible') {
    return 'CAPABILITY_MISMATCH';
  }

  return null;
}

/**
 * Pure model selection: given an agent profile's primary model and its ordered
 * fallback chain, walk the chain strictly in order (primary -> fallback[0] ->
 * fallback[1] -> ...) and pick the first candidate that clears both the
 * classification/provider policy gate and the live model-state availability
 * check. Never reorders candidates.
 */
export function selectModel(input: ModelSelectionInput): ModelSelectionResult {
  if (input.projectClassification === 'controlled') {
    return { ok: false, code: 'CONTROLLED_EXECUTION_BLOCKED', reasons: [] };
  }

  const candidates: readonly ModelSelectionCandidate[] = [
    { provider: input.profile.provider, model: input.profile.model },
    ...input.profile.fallbackModels,
  ];

  const reasons: ModelSelectionRejection[] = [];
  let primaryReason: FallbackReasonCode | null = null;

  for (const [index, candidate] of candidates.entries()) {
    const reason = evaluateCandidate(candidate, input);

    if (reason === null) {
      const isPrimary = index === 0;
      const raw = isPrimary
        ? {
            provider: candidate.provider,
            model: candidate.model,
            viaFallback: false,
            fallbackReasonCode: null,
            fromProvider: null,
            fromModel: null,
          }
        : {
            provider: candidate.provider,
            model: candidate.model,
            viaFallback: true,
            fallbackReasonCode: primaryReason,
            fromProvider: input.profile.provider,
            fromModel: input.profile.model,
          };

      return { ok: true, selection: modelSelectionSchema.parse(raw) };
    }

    reasons.push({ provider: candidate.provider, model: candidate.model, reason });
    if (index === 0) {
      primaryReason = reason;
    }
  }

  return { ok: false, code: 'NO_ELIGIBLE_MODEL', reasons };
}

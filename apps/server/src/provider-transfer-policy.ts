import type {
  AgentProfileSkeleton,
  DataClassification,
  Project,
  Provider,
  ProviderPolicy,
} from '@orion/contracts';

import { ApplicationError } from './errors.js';

export type ProviderPayloadKind = 'metadata' | 'summary' | 'excerpt';
export type ProviderSelectionKind = 'arca-default' | 'arca-fallback' | 'direct';

export interface ProviderTransferRequest {
  readonly project: Pick<Project, 'classification' | 'providerPolicy'>;
  readonly provider: Provider;
  readonly model: string;
  readonly payloadClassification: DataClassification | 'restricted';
  readonly payloadKind: ProviderPayloadKind;
  readonly selection: ProviderSelectionKind;
  /** A caller validates the confirmation against the session before passing it here. */
  readonly fableConfirmationValid?: boolean;
}

export interface ProviderCandidate {
  readonly provider: Provider;
  readonly model: string;
}

/**
 * The policy seam deliberately has no process, resolver, schema, or payload
 * dependencies. Calling it is therefore safe before every pre-spawn effect.
 */
export class ProviderTransferPolicy {
  public assertAllowed(request: ProviderTransferRequest): void {
    assertClassification(request.project.classification);
    assertPayloadKind(request.payloadKind);
    assertClassification(request.payloadClassification);
    if (request.project.classification === 'controlled') {
      throw policyDenied('CONTROLLED_EXECUTION_BLOCKED', 403);
    }
    if (request.payloadClassification === 'controlled') {
      throw policyDenied('CONTROLLED_EXECUTION_BLOCKED', 403);
    }
    if (request.payloadClassification === 'restricted') {
      throw policyDenied('VALIDATION_FAILED', 422);
    }
    if (
      request.payloadClassification === 'confidential' &&
      !request.project.providerPolicy[request.provider]
    ) {
      throw policyDenied('VALIDATION_FAILED', 403);
    }
    if (
      (request.selection === 'arca-default' || request.selection === 'arca-fallback') &&
      isFable(request.model)
    ) {
      throw policyDenied('VALIDATION_FAILED', 403);
    }
    if (isFable(request.model)) {
      if (
        request.selection !== 'direct' ||
        !request.project.providerPolicy.allowFable ||
        !request.fableConfirmationValid ||
        !request.project.providerPolicy[request.provider]
      ) {
        throw policyDenied('VALIDATION_FAILED', 403);
      }
    }
  }

  public arcaCandidates(
    project: Pick<Project, 'providerPolicy'>,
    profile: Pick<AgentProfileSkeleton, 'provider' | 'model' | 'fallbackModels'>,
  ): readonly ProviderCandidate[] {
    return [{ provider: profile.provider, model: profile.model }, ...profile.fallbackModels].filter(
      (candidate) => project.providerPolicy[candidate.provider] && !isFable(candidate.model),
    );
  }
}

export function arcaCandidates(
  policy: ProviderPolicy,
  profile: Pick<AgentProfileSkeleton, 'provider' | 'model' | 'fallbackModels'>,
): readonly ProviderCandidate[] {
  return new ProviderTransferPolicy().arcaCandidates({ providerPolicy: policy }, profile);
}

function assertClassification(value: DataClassification | 'restricted'): void {
  if (
    value === 'public' ||
    value === 'internal' ||
    value === 'confidential' ||
    value === 'controlled'
  )
    return;
  throw policyDenied('VALIDATION_FAILED', 422);
}

function assertPayloadKind(value: ProviderPayloadKind): void {
  if (value === 'metadata' || value === 'summary' || value === 'excerpt') return;
  throw policyDenied('VALIDATION_FAILED', 422);
}
function isFable(model: string): boolean {
  return /fable/i.test(model);
}

function policyDenied(
  code: 'CONTROLLED_EXECUTION_BLOCKED' | 'VALIDATION_FAILED',
  statusCode: 403 | 422,
) {
  return new ApplicationError(code, 'Provider execution is not allowed by policy.', { statusCode });
}

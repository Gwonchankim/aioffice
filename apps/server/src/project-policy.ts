import { createHash } from 'node:crypto';
import {
  type AgentProfileSkeleton,
  type DataClassification,
  type Project,
  type Provider,
  type ProviderPolicy,
} from '@orion/contracts';
import { agentProfileSeedSkeletons, validateProfilePermissions } from '@orion/agent-catalog';

import { ApplicationError } from './errors.js';

const classificationRank: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  controlled: 3,
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function providerPolicyHash(policy: ProviderPolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}
export interface EffectiveProviderModel {
  readonly provider: Provider;
  readonly model: string;
}

export class ProjectPolicyService {
  public assertRegistrationPolicy(
    classification: DataClassification,
    policy: ProviderPolicy,
    allowedAgentIds: readonly string[],
  ): void {
    if (classification === 'confidential' && !policy.openai && !policy.anthropic) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Confidential projects require an approved provider allowlist.',
        { statusCode: 422 },
      );
    }
    if (
      classification === 'controlled' &&
      (policy.openai || policy.anthropic || policy.allowFable)
    ) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Controlled projects cannot enable remote providers.',
        { statusCode: 422 },
      );
    }
    const known = new Set(agentProfileSeedSkeletons.map((profile) => profile.id));
    if (allowedAgentIds.some((id) => !known.has(id))) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Projects may only permit catalog agent IDs.',
        { statusCode: 422 },
      );
    }
  }

  public assertUpdatePolicy(
    current: Project,
    next: Pick<
      Project,
      'classification' | 'providerPolicy' | 'allowedAgentIds' | 'allowedCommands'
    >,
    hasNonterminalTasks: boolean,
  ): void {
    this.assertRegistrationPolicy(next.classification, next.providerPolicy, next.allowedAgentIds);
    if (classificationRank[next.classification] < classificationRank[current.classification]) {
      throw new ApplicationError(
        'PROJECT_POLICY_CONFLICT',
        'Project classification cannot be lowered.',
        { statusCode: 409 },
      );
    }
    if (
      hasNonterminalTasks &&
      (this.expandsList(current.allowedAgentIds, next.allowedAgentIds) ||
        this.expandsCommands(current.allowedCommands, next.allowedCommands))
    ) {
      throw new ApplicationError(
        'PROJECT_POLICY_CONFLICT',
        'Project policy cannot expand while tasks are active.',
        { statusCode: 409 },
      );
    }
  }

  public assertCanPlanOrStart(project: Pick<Project, 'classification'>): void {
    if (project.classification === 'controlled') {
      throw new ApplicationError(
        'CONTROLLED_EXECUTION_BLOCKED',
        'Controlled projects cannot start planning or provider execution.',
        { statusCode: 403 },
      );
    }
  }

  public effectiveModels(
    project: Pick<Project, 'providerPolicy'>,
    profile: AgentProfileSkeleton,
  ): readonly EffectiveProviderModel[] {
    if (!validateProfilePermissions(profile)) return [];
    const candidates: readonly EffectiveProviderModel[] = [
      { provider: profile.provider, model: profile.model },
      ...profile.fallbackModels,
    ];
    return candidates.filter(
      (candidate) =>
        project.providerPolicy[candidate.provider] &&
        (project.providerPolicy.allowFable || !isFableModel(candidate.model)),
    );
  }
  /**
   * Arca selection is intentionally distinct from generic effective-model
   * filtering: its default and fallback lists never contain Fable.
   */
  public arcaCandidates(
    project: Pick<Project, 'providerPolicy'>,
    profile: AgentProfileSkeleton,
  ): readonly EffectiveProviderModel[] {
    if (!validateProfilePermissions(profile)) return [];
    return [{ provider: profile.provider, model: profile.model }, ...profile.fallbackModels].filter(
      (candidate) => project.providerPolicy[candidate.provider] && !isFableModel(candidate.model),
    );
  }

  public arcaFallbackCandidates(
    project: Pick<Project, 'providerPolicy'>,
    profile: AgentProfileSkeleton,
  ): readonly EffectiveProviderModel[] {
    return this.arcaCandidates(project, profile).filter(
      (candidate) => candidate.provider !== profile.provider || candidate.model !== profile.model,
    );
  }

  public effectiveProviders(
    project: Pick<Project, 'providerPolicy'>,
    profile: AgentProfileSkeleton,
  ): readonly Provider[] {
    return [
      ...new Set(this.effectiveModels(project, profile).map((candidate) => candidate.provider)),
    ];
  }

  private expandsList(current: readonly string[], next: readonly string[]): boolean {
    const allowed = new Set(current);
    return next.some((entry) => !allowed.has(entry));
  }

  private expandsCommands(
    current: Project['allowedCommands'],
    next: Project['allowedCommands'],
  ): boolean {
    return (['read', 'verify', 'localWrite'] as const).some((kind) =>
      next[kind].some(
        (command) =>
          !current[kind].some((existing) => canonicalJson(existing) === canonicalJson(command)),
      ),
    );
  }
}
function isFableModel(model: string): boolean {
  return /fable/i.test(model);
}

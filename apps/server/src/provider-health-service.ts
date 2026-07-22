import {
  providerHealthCollectionSchema,
  providerHealthSchema,
  type AgentRuntimeAdapter,
  type Provider,
  type ProviderHealth,
  type ProviderHealthCollection,
} from '@orion/contracts';

const providers: readonly Provider[] = ['openai', 'anthropic'];

/**
 * Keeps only the public health shape. Adapter inspection details deliberately
 * never cross this boundary.
 */
export class ProviderHealthService {
  private readonly adapters: ReadonlyMap<Provider, AgentRuntimeAdapter>;
  private latest: ProviderHealthCollection;

  public constructor(
    adapters: ReadonlyMap<Provider, AgentRuntimeAdapter> = new Map(),
    now = () => new Date(),
  ) {
    this.adapters = adapters;
    this.latest = providerHealthCollectionSchema.parse({
      providers: providers.map((provider) => unavailableHealth(provider, now())),
    });
  }

  public list(): ProviderHealthCollection {
    return this.latest;
  }

  public async refresh(): Promise<ProviderHealthCollection> {
    const checkedAt = new Date();
    const health = await Promise.all(
      providers.map(async (provider) => {
        const adapter = this.adapters.get(provider);
        if (adapter === undefined) return unavailableHealth(provider, checkedAt);
        try {
          return await sanitizeHealth(adapter.inspect(), provider, checkedAt);
        } catch {
          return inspectionFailureHealth(provider, checkedAt);
        }
      }),
    );
    this.latest = providerHealthCollectionSchema.parse({ providers: await Promise.all(health) });
    return this.latest;
  }
}

async function sanitizeHealth(
  inspection: Promise<ProviderHealth>,
  provider: Provider,
  checkedAt: Date,
): Promise<ProviderHealth> {
  const value = await inspection;
  const parsed = providerHealthSchema.safeParse({
    provider: value.provider,
    installed: value.installed,
    cliVersion: value.cliVersion,
    authenticated: value.authenticated,
    status: value.status,
    supportedModels: value.supportedModels,
    lastCheckedAt: value.lastCheckedAt,
    sanitizedError: value.sanitizedError,
  });
  if (!parsed.success || parsed.data.provider !== provider)
    return inspectionFailureHealth(provider, checkedAt);
  return parsed.data;
}

function unavailableHealth(provider: Provider, checkedAt: Date): ProviderHealth {
  return providerHealthSchema.parse({
    provider,
    installed: false,
    cliVersion: null,
    authenticated: false,
    status: 'not_installed',
    supportedModels: [],
    lastCheckedAt: checkedAt.toISOString(),
    sanitizedError: null,
  });
}

function inspectionFailureHealth(provider: Provider, checkedAt: Date): ProviderHealth {
  return providerHealthSchema.parse({
    provider,
    installed: true,
    cliVersion: null,
    authenticated: false,
    status: 'error',
    supportedModels: [],
    lastCheckedAt: checkedAt.toISOString(),
    sanitizedError: 'Provider inspection could not be completed.',
  });
}

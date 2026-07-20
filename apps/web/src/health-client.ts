import { healthSuccessSchema } from '@orion/contracts';
import type { HealthSuccess } from '@orion/contracts';

const healthEndpoint = '/api/v1/health';

export class HealthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthClientError';
  }
}

export async function fetchHealth(): Promise<HealthSuccess> {
  let response: Response;

  try {
    response = await fetch(healthEndpoint);
  } catch {
    throw new HealthClientError('Health request failed.');
  }

  if (!response.ok) {
    throw new HealthClientError(`Health request failed with status ${response.status}.`);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new HealthClientError('Health response was not valid JSON.');
  }

  const parsed = healthSuccessSchema.safeParse(payload);

  if (!parsed.success) {
    throw new HealthClientError('Health response did not match the health contract.');
  }

  return parsed.data;
}

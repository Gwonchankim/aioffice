import { canonicalM0DegradedHealth } from '@orion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth, HealthClientError } from '../src/health-client.js';

describe('fetchHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the health endpoint and returns contract-validated data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(canonicalM0DegradedHealth), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchHealth()).resolves.toEqual(canonicalM0DegradedHealth);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/health');
  });

  it('rejects a failed HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchHealth()).rejects.toBeInstanceOf(HealthClientError);
  });

  it('rejects a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await expect(fetchHealth()).rejects.toBeInstanceOf(HealthClientError);
  });

  it('rejects a response with invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new Error('invalid JSON')),
      }),
    );

    await expect(fetchHealth()).rejects.toBeInstanceOf(HealthClientError);
  });

  it('rejects a payload that does not match the health contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }))));

    await expect(fetchHealth()).rejects.toBeInstanceOf(HealthClientError);
  });
});

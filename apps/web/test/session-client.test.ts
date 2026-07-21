import { describe, expect, it, vi } from 'vitest';

import { bootstrapSession, SessionBootstrapError } from '../src/session-client.js';

const location = {
  hash: '#bootstrap_token=synthetic-bootstrap-token',
  pathname: '/',
  search: '?view=health',
};

describe('bootstrapSession', () => {
  it('does nothing when no bootstrap token exists in the fragment', async () => {
    const fetchMock = vi.fn();

    await expect(
      bootstrapSession({
        fetch: fetchMock,
        location: { ...location, hash: '' },
        history: { replaceState: vi.fn() },
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the fragment before exchanging the in-memory bootstrap token for a CSRF token', async () => {
    const events: string[] = [];
    const replaceState = vi.fn(() => events.push('fragment-cleared'));
    const fetchMock = vi.fn(async () => {
      events.push('bootstrap-requested');
      return new Response(JSON.stringify({ data: { csrfToken: 'synthetic-csrf-token' } }), {
        status: 201,
      });
    });

    await expect(
      bootstrapSession({ fetch: fetchMock, history: { replaceState }, location }),
    ).resolves.toEqual({ csrfToken: 'synthetic-csrf-token' });
    expect(events).toEqual(['fragment-cleared', 'bootstrap-requested']);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?view=health');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/bootstrap', {
      method: 'POST',
      headers: { 'x-orion-bootstrap-token': 'synthetic-bootstrap-token' },
      credentials: 'same-origin',
    });
  });

  it('clears the fragment even when bootstrap fails and never falls back to a persisted token', async () => {
    const replaceState = vi.fn();

    await expect(
      bootstrapSession({
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
        history: { replaceState },
        location,
      }),
    ).rejects.toBeInstanceOf(SessionBootstrapError);
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('rejects a malformed bootstrap response', async () => {
    await expect(
      bootstrapSession({
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 201 })),
        history: { replaceState: vi.fn() },
        location,
      }),
    ).rejects.toBeInstanceOf(SessionBootstrapError);
  });
});

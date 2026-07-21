export interface SessionBootstrapResult {
  readonly csrfToken: string;
}

export interface SessionBootstrapDependencies {
  readonly fetch?: typeof fetch;
  readonly history?: Pick<History, 'replaceState'>;
  readonly location?: Pick<Location, 'hash' | 'pathname' | 'search'>;
}

export class SessionBootstrapError extends Error {
  public constructor() {
    super('The local bootstrap session could not be established.');
  }
}

export async function bootstrapSession(
  dependencies: SessionBootstrapDependencies = {},
): Promise<SessionBootstrapResult | undefined> {
  const location = dependencies.location ?? window.location;
  const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap_token');
  if (token === null || token.length === 0) {
    return undefined;
  }

  const history = dependencies.history ?? window.history;
  history.replaceState(null, '', `${location.pathname}${location.search}`);

  const response = await (dependencies.fetch ?? window.fetch)('/api/v1/session/bootstrap', {
    method: 'POST',
    headers: { 'x-orion-bootstrap-token': token },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new SessionBootstrapError();
  }

  const payload: unknown = await response.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('data' in payload) ||
    typeof payload.data !== 'object' ||
    payload.data === null ||
    !('csrfToken' in payload.data) ||
    typeof payload.data.csrfToken !== 'string' ||
    payload.data.csrfToken.length === 0
  ) {
    throw new SessionBootstrapError();
  }

  return { csrfToken: payload.data.csrfToken };
}

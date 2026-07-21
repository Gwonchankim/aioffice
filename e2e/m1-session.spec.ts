import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { test } from './m1-fixture.js';

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  return errors;
}

function bootstrapToken(url: string): string {
  const token = new URL(url).hash.match(/(?:^#|&)bootstrap_token=([^&]+)/)?.[1];
  if (token === undefined) {
    throw new Error('The in-memory browser handoff did not contain a bootstrap token.');
  }
  return decodeURIComponent(token);
}

test('M1-E2E-003 exchanges a fragment token for a hardened session and enforces CSRF', async ({
  page,
  request,
  orion,
}) => {
  const consoleErrors = collectConsoleErrors(page);
  const token = bootstrapToken(orion.bootstrapUrl);
  const bootstrapResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${orion.baseURL}/api/v1/session/bootstrap` &&
      response.request().method() === 'POST',
  );

  await page.goto(orion.bootstrapUrl);
  const bootstrapResponse = await bootstrapResponsePromise;
  const bootstrap = (await bootstrapResponse.json()) as { data?: { csrfToken?: unknown } };
  if (typeof bootstrap.data?.csrfToken !== 'string' || bootstrap.data.csrfToken.length === 0) {
    throw new Error('The bootstrap exchange did not return a CSRF token.');
  }
  const csrfToken = bootstrap.data.csrfToken;

  expect(bootstrapResponse.status()).toBe(201);
  await expect(page).toHaveURL(new URL('/', orion.baseURL).toString());
  expect(page.url()).not.toContain('bootstrap_token');

  const cookies = await page.context().cookies(orion.baseURL);
  expect(cookies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'orion_session',
        domain: 'localhost',
        httpOnly: true,
        path: '/',
        sameSite: 'Strict',
        secure: true,
      }),
    ]),
  );
  const sessionCookie = cookies.find((cookie) => cookie.name === 'orion_session');
  if (sessionCookie === undefined) {
    throw new Error('Chromium did not retain the local secure session cookie.');
  }

  const repositoryPath = await orion.createGitRepository();
  const createProject = await page.evaluate(
    async ({ csrf, repository }) => {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': 'm1-e2e-create-project',
        },
        body: JSON.stringify({
          projectKey: 'm1-e2e-project',
          name: 'M1 E2E Project',
          repositoryPath: repository,
          defaultBranch: 'main',
          classification: 'internal',
          providerPolicy: { openai: false, anthropic: false, allowFable: false },
          allowedAgentIds: ['atlas'],
          allowedCommands: {
            read: [['git', 'status']],
            verify: [['pnpm', 'test']],
            localWrite: [['git', 'add']],
          },
        }),
      });
      return { body: await response.json(), status: response.status };
    },
    { csrf: csrfToken, repository: repositoryPath },
  );

  expect(createProject.status).toBe(201);
  const projectId = (createProject.body as { data?: { project?: { id?: unknown } } }).data?.project
    ?.id;
  if (typeof projectId !== 'string') {
    throw new Error('The CSRF-protected project mutation did not return a project ID.');
  }

  for (const [csrf, key] of [
    [undefined, 'm1-e2e-missing-csrf'],
    ['wrong-csrf-token', 'm1-e2e-wrong-csrf'],
  ] as const) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      'idempotency-key': key,
      origin: orion.baseURL,
    };
    if (csrf !== undefined) {
      headers['x-csrf-token'] = csrf;
    }
    const response = await request.patch(`${orion.baseURL}/api/v1/projects/${projectId}`, {
      data: { name: 'Rejected update' },
      headers,
    });
    const rejected = { body: await response.json(), status: response.status() };
    expect(rejected).toMatchObject({ status: 403, body: { error: { code: 'CSRF_REJECTED' } } });
  }

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === 'critical')).toEqual(
    [],
  );
  expect(orion.launcherOutput.join('\n')).not.toContain(token);
  expect(await orion.retainedArtifactPaths()).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

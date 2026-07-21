import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

import { test } from './m1-fixture.js';
interface HealthSuccess {
  readonly data: {
    readonly status: string;
    readonly database: string;
    readonly scheduler: {
      readonly status: string;
      readonly active: number;
      readonly capacity: number;
      readonly queued: number;
    };
    readonly retention: { readonly lastRunAt: string | null; readonly status: string };
    readonly resources: { readonly memoryPercent: number; readonly freeDiskBytes: number };
  };
}

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

function configuredBaseURL(testInfo: TestInfo): string {
  const { baseURL } = testInfo.project.use;

  if (typeof baseURL !== 'string') {
    throw new Error('The Playwright project must define a loopback baseURL.');
  }

  return baseURL;
}

function expectM1InitializedHealth(health: HealthSuccess): void {
  expect(health.data).toMatchObject({
    status: 'healthy',
    database: 'ok',
    scheduler: {
      status: 'not_initialized',
      active: 0,
      capacity: 0,
      queued: 0,
    },
    retention: {
      lastRunAt: null,
      status: 'not_initialized',
    },
  });
}

test('M1-E2E-001 renders initialized database health without console or critical axe errors', async ({
  page,
  orion,
}, testInfo) => {
  const consoleErrors = collectConsoleErrors(page);
  const baseURL = configuredBaseURL(testInfo);
  expect(orion.baseURL).toBe(baseURL);
  const healthResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${baseURL}/api/v1/health` && response.request().method() === 'GET',
  );

  await page.goto(baseURL);
  const healthResponse = await healthResponsePromise;

  expect(healthResponse.status()).toBe(200);
  const health = (await healthResponse.json()) as HealthSuccess;
  expectM1InitializedHealth(health);
  await expect(page.getByRole('heading', { name: 'Orion Console 대시보드' })).toBeVisible();

  const subsystems = page.getByRole('region', { name: 'M1 하위 시스템' });
  await expect(subsystems.getByText('정상 (ok)', { exact: true })).toHaveCount(1);
  await expect(subsystems.getByText('초기화되지 않음', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('region', { name: '서버 상태' })).toContainText('정상 (healthy)');

  const resources = page.getByRole('region', { name: '리소스' });
  await expect(resources).toContainText(`${health.data.resources.memoryPercent}%`);
  await expect(resources).toContainText(`${health.data.resources.freeDiskBytes} bytes`);

  const accessibility = await new AxeBuilder({ page }).analyze();
  const criticalViolations = accessibility.violations.filter(
    (violation) => violation.impact === 'critical',
  );

  expect(criticalViolations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('M1-E2E-002 serves dashboard and health from the isolated production loopback origin', async ({
  page,
  request,
  orion,
}, testInfo) => {
  const consoleErrors = collectConsoleErrors(page);
  const origin = orion.baseURL;

  expect(origin).toBe(configuredBaseURL(testInfo));
  expect(orion.runtimeDirectory).not.toContain(process.cwd());

  const dashboardResponse = await request.get(origin, {
    headers: { accept: 'text/html' },
  });
  expect(dashboardResponse.status()).toBe(200);
  expect(dashboardResponse.headers()['content-type']).toContain('text/html');
  expect(await dashboardResponse.text()).toContain('id="root"');

  const healthResponse = await request.get(`${origin}/api/v1/health`);
  expect(healthResponse.status()).toBe(200);
  expectM1InitializedHealth((await healthResponse.json()) as HealthSuccess);

  const apiPrecedenceResponse = await request.get(`${origin}/api/v1/not-a-route`);
  expect(apiPrecedenceResponse.status()).toBe(404);
  expect(apiPrecedenceResponse.headers()['content-type']).toContain('application/json');

  await page.goto(`${origin}/client-route`);
  await expect(page.getByRole('heading', { name: 'Orion Console 대시보드' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

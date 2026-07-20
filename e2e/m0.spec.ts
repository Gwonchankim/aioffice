import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { healthSuccessSchema } from '@orion/contracts';
import type { HealthSuccess } from '@orion/contracts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const runtimeMetadataPath = resolve(process.cwd(), '.orion-runtime', 'e2e', 'runtime.json');

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

function expectM0DegradedHealth(health: HealthSuccess): void {
  expect(health.data).toMatchObject({
    status: 'degraded',
    database: 'not_initialized',
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

async function getRecordedOrigin(): Promise<string> {
  const metadata: unknown = JSON.parse(await readFile(runtimeMetadataPath, 'utf8'));

  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('host' in metadata) ||
    metadata.host !== '127.0.0.1' ||
    !('port' in metadata) ||
    typeof metadata.port !== 'number' ||
    !Number.isSafeInteger(metadata.port)
  ) {
    throw new Error('The production runtime metadata did not contain a valid loopback origin.');
  }

  return `http://${metadata.host}:${metadata.port}`;
}

test('M0-E2E-001 renders truthful degraded health without console or critical axe errors', async ({
  page,
}, testInfo) => {
  const consoleErrors = collectConsoleErrors(page);
  const baseURL = configuredBaseURL(testInfo);
  const healthResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${baseURL}/api/v1/health` && response.request().method() === 'GET',
  );

  await page.goto(baseURL);
  const healthResponse = await healthResponsePromise;

  expect(healthResponse.status()).toBe(200);
  const health = healthSuccessSchema.parse(await healthResponse.json());
  expectM0DegradedHealth(health);
  await expect(page.getByRole('heading', { name: 'Orion Console 대시보드' })).toBeVisible();

  const subsystems = page.getByRole('region', { name: 'M1 하위 시스템' });
  await expect(subsystems.getByText('초기화되지 않음', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('region', { name: '서버 상태' })).toContainText('저하됨 (degraded)');

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

test('M0-E2E-002 serves dashboard and health from the recorded production loopback origin', async ({
  page,
  request,
}, testInfo) => {
  const consoleErrors = collectConsoleErrors(page);
  const origin = await getRecordedOrigin();

  expect(origin).toBe(configuredBaseURL(testInfo));

  const dashboardResponse = await request.get(origin, {
    headers: { accept: 'text/html' },
  });
  expect(dashboardResponse.status()).toBe(200);
  expect(dashboardResponse.headers()['content-type']).toContain('text/html');
  expect(await dashboardResponse.text()).toContain('id="root"');

  const healthResponse = await request.get(`${origin}/api/v1/health`);
  expect(healthResponse.status()).toBe(200);
  expectM0DegradedHealth(healthSuccessSchema.parse(await healthResponse.json()));

  const apiPrecedenceResponse = await request.get(`${origin}/api/v1/not-a-route`);
  expect(apiPrecedenceResponse.status()).toBe(404);
  expect(apiPrecedenceResponse.headers()['content-type']).toContain('application/json');

  await page.goto(`${origin}/client-route`);
  await expect(page.getByRole('heading', { name: 'Orion Console 대시보드' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

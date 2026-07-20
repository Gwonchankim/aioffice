import { devices, defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const e2ePort = 4317;
const baseURL = `http://127.0.0.1:${e2ePort}`;
const runtimeDirectory = resolve(process.cwd(), '.orion-runtime', 'e2e');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm start',
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORION_PORT: String(e2ePort),
      ORION_RUNTIME_DIR: runtimeDirectory,
    },
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { devices, defineConfig } from '@playwright/test';

const e2eServerPort = 4317;
const e2eProxyPort = 4517;
const baseURL = `http://localhost:${e2eProxyPort}`;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'orion-e2e-'));
const runtimeDirectory = join(temporaryRoot, 'runtime');
const outputDirectory = join(temporaryRoot, 'results');

assertOutsideRepository(temporaryRoot);
process.env.NODE_ENV = 'test';
process.env.ORION_E2E_TEMP_ROOT = temporaryRoot;
process.env.ORION_PORT = String(e2eServerPort);
process.env.ORION_RUNTIME_DIR = runtimeDirectory;
process.env.ORION_E2E_PROXY_PORT = String(e2eProxyPort);

function assertOutsideRepository(candidate: string): void {
  const relation = relative(resolve(process.cwd()), resolve(candidate));
  if (relation === '' || (!relation.startsWith('..') && !relation.includes(':'))) {
    throw new Error('Playwright runtime data must be outside the repository.');
  }
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  outputDir: outputDirectory,
  preserveOutput: 'never',
  globalTeardown: './e2e/global-teardown.ts',
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

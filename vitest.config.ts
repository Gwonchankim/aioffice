import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

const coverageTargets = [
  { directory: 'packages/contracts/src', include: 'packages/contracts/src/**/*.ts' },
  { directory: 'apps/server/src', include: 'apps/server/src/**/*.ts' },
  { directory: 'scripts', include: 'scripts/**/*.ts' },
  { directory: 'apps/web/src', include: 'apps/web/src/**/*.{ts,tsx}' },
] as const;

const existingCoverageIncludes = coverageTargets
  .filter(({ directory }) => existsSync(resolve(workspaceRoot, directory)))
  .map(({ include }) => include);

const coverageThresholds = Object.fromEntries(
  existingCoverageIncludes.map((include) => [include, { lines: 80 }]),
);

export default defineConfig({
  root: workspaceRoot,
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      'scripts/test/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      all: true,
      include: existingCoverageIncludes,
      exclude: [
        '**/*.d.ts',
        '**/fixtures/**',
        '**/index.ts',
        '**/test/**',
        // main.tsx only mounts React into the page root; it contains no dashboard behavior.
        'apps/web/src/main.tsx',
      ],
      thresholds: coverageThresholds,
    },
  },
});

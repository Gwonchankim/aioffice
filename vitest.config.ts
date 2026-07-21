import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

const coverageTargetIncludes = [
  'packages/contracts/src/**/*.ts',
  'apps/server/src/**/*.ts',
  'scripts/**/*.ts',
  'apps/web/src/**/*.{ts,tsx}',
  'packages/orchestration/src/**/*.ts',
  'packages/agent-catalog/src/**/*.ts',
  'packages/test-fixtures/src/**/*.ts',
] as const;

const coverageThresholds = Object.fromEntries(
  coverageTargetIncludes.map((include) => [include, { lines: 80 }]),
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
      include: coverageTargetIncludes,
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

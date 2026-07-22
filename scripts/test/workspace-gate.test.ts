import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type WorkspaceManifest = {
  scripts?: Record<string, string>;
  exports?: Record<string, { types?: string; default?: string }>;
};

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

const orderedPackages = [
  '@orion/contracts',
  '@orion/orchestration',
  '@orion/agent-catalog',
  '@orion/test-fixtures',
  '@orion/server',
] as const;

const buildPackages =
  'pnpm --filter @orion/contracts build && pnpm --filter @orion/orchestration build && pnpm --filter @orion/agent-catalog build && pnpm --filter @orion/test-fixtures build && pnpm --filter @orion/server build';

const gateScripts = {
  typecheck: 'pnpm run build:packages && pnpm -r --if-present run typecheck',
  test: 'pnpm run build:packages && pnpm -r --if-present run test',
  'test:coverage': 'pnpm run build:packages && vitest run --coverage',
} as const;

const distExportManifests = [
  {
    path: 'packages/contracts/package.json',
    types: './dist/index.d.ts',
    default: './dist/index.js',
  },
  {
    path: 'packages/orchestration/package.json',
    types: './dist/index.d.ts',
    default: './dist/index.js',
  },
  {
    path: 'packages/agent-catalog/package.json',
    types: './dist/index.d.ts',
    default: './dist/index.js',
  },
  {
    path: 'packages/test-fixtures/package.json',
    types: './dist/index.d.ts',
    default: './dist/index.js',
  },
  {
    path: 'apps/server/package.json',
    types: './dist/main.d.ts',
    default: './dist/main.js',
  },
] as const;

async function readManifest(path: string): Promise<WorkspaceManifest> {
  return JSON.parse(await readFile(resolve(workspaceRoot, path), 'utf8')) as WorkspaceManifest;
}

describe('workspace root gate contract', () => {
  it('CORR-M1-DX-001 keeps clean-checkout gates explicitly self-contained', async () => {
    const rootManifest = await readManifest('package.json');
    const scripts = rootManifest.scripts ?? {};

    expect(scripts['build:packages']).toBe(buildPackages);
    expect(buildPackages.split(' && ')).toEqual(
      orderedPackages.map((packageName) => `pnpm --filter ${packageName} build`),
    );
    expect(new Set(buildPackages.split(' && '))).toHaveLength(orderedPackages.length);

    for (const [gateName, expectedScript] of Object.entries(gateScripts)) {
      expect(scripts[gateName]).toBe(expectedScript);
      expect(scripts[gateName]?.startsWith('pnpm run build:packages && ')).toBe(true);
      expect(scripts[`pre${gateName}`]).toBeUndefined();
      expect(scripts[`post${gateName}`]).toBeUndefined();
    }

    expect(scripts['test:coverage']?.match(/vitest run --coverage/g)).toHaveLength(1);
    expect(scripts['test:coverage']?.endsWith('vitest run --coverage')).toBe(true);

    for (const { path, types, default: defaultExport } of distExportManifests) {
      const manifest = await readManifest(path);

      expect(manifest.exports?.['.']).toEqual({ types, default: defaultExport });
    }
  });
});

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, relative, resolve } from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const temporaryRoot = process.env.ORION_E2E_TEMP_ROOT;
  if (temporaryRoot === undefined) {
    return;
  }

  const resolvedRoot = resolve(temporaryRoot);
  const temporaryParent = resolve(tmpdir());
  const relation = relative(temporaryParent, resolvedRoot);
  if (
    relation === '' ||
    relation.startsWith('..') ||
    relation.includes(':') ||
    !basename(resolvedRoot).startsWith('orion-e2e-')
  ) {
    throw new Error('Refusing to remove a Playwright directory that is not an owned OS-temp path.');
  }

  rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

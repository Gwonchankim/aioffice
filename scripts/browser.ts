import { existsSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';

export type AbsoluteUrl = string & { readonly __absoluteUrl: unique symbol };

export interface BrowserLogger {
  warn(bindings: { code: string; url: string }, message: string): void;
}

export interface SpawnedBrowserProcess {
  once(event: 'error', listener: (error: Error) => void): void;
}

export type BrowserExecutableResolver = (systemRoot: string | undefined) => string;
export type BrowserSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<SpawnOptions>,
) => SpawnedBrowserProcess;

export interface BrowserDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly executableResolver?: BrowserExecutableResolver;
  readonly logger?: BrowserLogger;
  readonly output?: (value: string) => void;
  readonly spawn?: BrowserSpawner;
  readonly workingDirectory?: string;
}

const BROWSER_ARGUMENT_PREFIX = 'url.dll,FileProtocolHandler';

export function validateAbsoluteUrl(value: string): AbsoluteUrl {
  new URL(value);
  return value as AbsoluteUrl;
}

export function resolveWindowsBrowserExecutable(
  systemRoot: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (systemRoot === undefined || systemRoot.length === 0 || !win32.isAbsolute(systemRoot)) {
    throw new Error('SystemRoot must be an absolute Windows path.');
  }

  const executable = win32.join(systemRoot, 'System32', 'rundll32.exe');
  if (!win32.isAbsolute(executable) || !fileExists(executable)) {
    throw new Error('The canonical rundll32.exe executable is unavailable.');
  }

  return executable;
}

export function openBrowser(
  actualUrl: AbsoluteUrl,
  dependencies: BrowserDependencies = {},
): boolean {
  const logger = dependencies.logger ?? consoleBrowserLogger;
  const output = dependencies.output ?? console.log;

  try {
    const executable = (dependencies.executableResolver ?? resolveWindowsBrowserExecutable)(
      (dependencies.environment ?? process.env).SystemRoot,
    );
    if (!win32.isAbsolute(executable)) {
      throw new Error('The browser executable must be an absolute Windows path.');
    }
    const child = (dependencies.spawn ?? spawnBrowser)(
      executable,
      [BROWSER_ARGUMENT_PREFIX, actualUrl],
      { cwd: resolve(dependencies.workingDirectory ?? process.cwd()), shell: false },
    );
    child.once('error', () => {
      reportBrowserOpenFailure(actualUrl, logger, output);
    });
    return true;
  } catch {
    reportBrowserOpenFailure(actualUrl, logger, output);
    return false;
  }
}

export function reportBrowserOpenFailure(
  actualUrl: AbsoluteUrl,
  logger: BrowserLogger,
  output: (value: string) => void,
): void {
  const safeUrl = withoutFragment(actualUrl);
  logger.warn(
    { code: 'BROWSER_OPEN_FAILED', url: safeUrl },
    'Browser opener failed; open the URL manually.',
  );
  output(safeUrl);
}
function withoutFragment(url: AbsoluteUrl): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
}

function spawnBrowser(
  executable: string,
  arguments_: readonly string[],
  options: Readonly<SpawnOptions>,
): SpawnedBrowserProcess {
  return spawn(executable, arguments_, options);
}

const consoleBrowserLogger: BrowserLogger = {
  warn(bindings, message) {
    console.warn(bindings, message);
  },
};

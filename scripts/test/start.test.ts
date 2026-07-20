import { describe, expect, it, vi } from 'vitest';
const mockedModules = vi.hoisted(() => ({
  readFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockedModules.spawn }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: mockedModules.readFile,
}));

import { startServer, type StartedServer } from '@orion/server';

import {
  openBrowser,
  resolveWindowsBrowserExecutable,
  validateAbsoluteUrl,
  type SpawnedBrowserProcess,
} from '../browser.js';
import {
  createRuntimeReadinessReader,
  runDevelopmentCoordinator,
  type Clock,
  type OwnedChildProcess,
  type SignalSource,
} from '../coordinator.js';
import { runProductionLauncher } from '../start.js';

class FakeBrowserProcess implements SpawnedBrowserProcess {
  private errorListener: ((error: Error) => void) | undefined;

  public once(_event: 'error', listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  public emitError(): void {
    this.errorListener?.(new Error('browser failed'));
  }
}

class FakeChildProcess implements OwnedChildProcess {
  private readonly listeners: Record<'error' | 'exit', Array<() => void>> = {
    error: [],
    exit: [],
  };

  public readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.emit('exit');
    return signal === 'SIGINT';
  });

  public constructor(public readonly pid: number) {}

  public once(event: 'error' | 'exit', listener: () => void): void {
    this.listeners[event].push(listener);
  }

  public emit(event: 'error' | 'exit'): void {
    const listeners = this.listeners[event].splice(0);
    for (const listener of listeners) {
      listener();
    }
  }
}

class FakeSignals implements SignalSource {
  private listener: (() => void) | undefined;

  public once(_signal: 'SIGINT', listener: () => void): void {
    this.listener = listener;
  }

  public removeListener(_signal: 'SIGINT', listener: () => void): void {
    if (this.listener === listener) {
      this.listener = undefined;
    }
  }

  public emit(): void {
    this.listener?.();
  }
}

class FakeClock implements Clock {
  public current = 0;
  public readonly sleep = vi.fn(async (milliseconds: number) => {
    this.current += milliseconds;
  });

  public now(): number {
    return this.current;
  }
}

function serverAt(port: number): StartedServer {
  return {
    app: {} as StartedServer['app'],
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

function testLogger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

describe('@orion/scripts launchers', () => {
  it('START-001 opens the actual 4317 URL only after server metadata readiness', async () => {
    const events: string[] = [];
    const browserOpener = vi.fn((url: string) => {
      events.push(url);
    });

    const result = await runProductionLauncher({
      browserOpener,
      startServer: async () => {
        events.push('runtime.json');
        return serverAt(4317);
      },
    });

    expect(result).toBe(0);
    expect(events).toStrictEqual(['runtime.json', 'http://127.0.0.1:4317']);
  });

  it('START-002 opens the actual fallback 4318 URL', async () => {
    const browserOpener = vi.fn();

    const result = await runProductionLauncher({
      browserOpener,
      startServer: async () => serverAt(4318),
    });

    expect(result).toBe(0);
    expect(browserOpener).toHaveBeenCalledWith('http://127.0.0.1:4318');
  });

  it('START-003 warns and prints the URL when the browser opener fails while the server stays ready', async () => {
    const logger = testLogger();
    const output = vi.fn();
    const browser = new FakeBrowserProcess();
    const close = vi.fn();
    const started = { ...serverAt(4317), app: { close } as StartedServer['app'] };

    const result = await runProductionLauncher({
      browserOpener: (url) => {
        openBrowser(url, {
          environment: { SystemRoot: 'C:\\Windows' },
          executableResolver: () => 'C:\\Windows\\System32\\rundll32.exe',
          logger,
          output,
          spawn: () => browser,
          workingDirectory: 'C:\\work',
        });
        browser.emitError();
      },
      startServer: async () => started,
    });

    expect(result).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { code: 'BROWSER_OPEN_FAILED', url: 'http://127.0.0.1:4317' },
      'Browser opener failed; open the URL manually.',
    );
    expect(output).toHaveBeenCalledWith('http://127.0.0.1:4317');
  });

  it('START-004 does not open a browser when runtime metadata writing fails, closes the listener, and exits 1', async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const browserOpener = vi.fn();
    const logger = testLogger();
    const app = {
      close,
      server: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 4317 }) },
    } as unknown as StartedServer['app'];

    const result = await runProductionLauncher({
      browserOpener,
      startServer: () =>
        startServer({
          addressReader: () => ({ address: '127.0.0.1', family: 'IPv4', port: 4317 }),
          appFactory: async () => app,
          config: { assetRoot: 'unused', port: 4317, runtimeDirectory: 'runtime' },
          exit,
          logger: logger as never,
          portBinder: { bind: async () => 4317 },
          runtimeFileSystem: {
            ensureDirectory: async () => undefined,
            writeMetadata: async () => Promise.reject(new Error('metadata failed')),
          },
        }),
    });

    expect(result).toBe(1);
    expect(browserOpener).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('START-005 waits for Vite HTTP readiness and opens only the Vite URL', async () => {
    const api = new FakeChildProcess(101);
    const vite = new FakeChildProcess(202);
    const signals = new FakeSignals();
    const clock = new FakeClock();
    const spawn = vi.fn(() => (spawn.mock.calls.length === 1 ? api : vite));
    let viteChecks = 0;
    const browserOpener = vi.fn((url: string) => {
      expect(viteChecks).toBe(2);
      signals.emit();
      return url;
    });

    const result = await runDevelopmentCoordinator({
      browserOpener,
      clock,
      environment: {},
      runtimeReadinessReader: async () => ({
        host: '127.0.0.1',
        pid: 101,
        port: 4318,
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
      signalSource: signals,
      spawn,
      viteReadinessReader: async () => {
        viteChecks += 1;
        return viteChecks === 2;
      },
      workingDirectory: 'C:\\workspace',
    });

    expect(result).toBe(0);
    expect(browserOpener).toHaveBeenCalledWith('http://127.0.0.1:5173');
    expect(browserOpener).not.toHaveBeenCalledWith('http://127.0.0.1:4318');
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ ORION_API_ORIGIN: 'http://127.0.0.1:4318' }),
        shell: false,
      }),
    );
  });

  it('START-006 prevents Vite from starting when the API exits before readiness', async () => {
    const api = new FakeChildProcess(101);
    const clock = new FakeClock();
    const spawn = vi.fn(() => api);
    const originalSleep = clock.sleep.getMockImplementation();
    clock.sleep.mockImplementation(async (milliseconds: number) => {
      await originalSleep?.(milliseconds);
      api.emit('exit');
    });

    const result = await runDevelopmentCoordinator({
      clock,
      environment: {},
      runtimeReadinessReader: async () => undefined,
      signalSource: new FakeSignals(),
      spawn,
      viteReadinessReader: async () => true,
      workingDirectory: 'C:\\workspace',
    });

    expect(result).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('START-007 stops only the owned peer when either child exits early', async () => {
    for (const failedChild of ['API', 'Vite'] as const) {
      const api = new FakeChildProcess(101);
      const vite = new FakeChildProcess(202);
      const spawn = vi.fn(() => (spawn.mock.calls.length === 1 ? api : vite));

      const result = await runDevelopmentCoordinator({
        clock: new FakeClock(),
        environment: {},
        runtimeReadinessReader: async () => ({
          host: '127.0.0.1',
          pid: 101,
          port: 4317,
          startedAt: '2026-07-20T12:00:00.000Z',
        }),
        signalSource: new FakeSignals(),
        spawn,
        viteReadinessReader: async () => {
          (failedChild === 'API' ? api : vite).emit('exit');
          return true;
        },
        workingDirectory: 'C:\\workspace',
      });

      expect(result).toBe(1);
      const stoppedPeer = failedChild === 'API' ? vite : api;
      const exitedChild = failedChild === 'API' ? api : vite;
      expect(stoppedPeer.kill).toHaveBeenCalledWith('SIGINT');
      expect(exitedChild.kill).not.toHaveBeenCalled();
    }
  });

  it('START-008 handles SIGINT by stopping only exact owned children within the ten-second bound', async () => {
    const api = new FakeChildProcess(101);
    const vite = new FakeChildProcess(202);
    const signals = new FakeSignals();
    const clock = new FakeClock();
    const spawn = vi.fn(() => (spawn.mock.calls.length === 1 ? api : vite));

    const result = await runDevelopmentCoordinator({
      browserOpener: () => signals.emit(),
      clock,
      environment: {},
      runtimeReadinessReader: async () => ({
        host: '127.0.0.1',
        pid: 101,
        port: 4317,
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
      signalSource: signals,
      spawn,
      viteReadinessReader: async () => true,
      workingDirectory: 'C:\\workspace',
    });

    expect(result).toBe(0);
    expect(api.kill).toHaveBeenCalledWith('SIGINT');
    expect(vite.kill).toHaveBeenCalledWith('SIGINT');
    expect(clock.sleep).toHaveBeenCalledWith(10_000);
  });

  it('START-009 rejects missing, invalid, relative, and nonexistent SystemRoot values without a PATH lookup', () => {
    const fileExists = vi.fn(() => false);
    const url = validateAbsoluteUrl('http://127.0.0.1:4317');
    const spawn = vi.fn();
    const logger = testLogger();
    const output = vi.fn();

    for (const systemRoot of [undefined, '', 'Windows', 'C:\\Missing']) {
      expect(() => resolveWindowsBrowserExecutable(systemRoot, fileExists)).toThrow();
      const environment = systemRoot === undefined ? {} : { SystemRoot: systemRoot };
      expect(
        openBrowser(url, {
          environment,
          logger,
          output,
          spawn,
          workingDirectory: 'C:\\workspace',
        }),
      ).toBe(false);
    }

    expect(spawn).not.toHaveBeenCalled();
    expect(fileExists).toHaveBeenCalledWith('C:\\Missing\\System32\\rundll32.exe');
    expect(output).toHaveBeenCalledTimes(4);
  });

  it('START-010 resolves canonical rundll32.exe and uses the exact argv array with shell false', () => {
    const canonical = resolveWindowsBrowserExecutable('C:\\Windows', () => true);
    const browser = new FakeBrowserProcess();
    const spawn = vi.fn(() => browser);
    const url = validateAbsoluteUrl('http://127.0.0.1:4318');

    expect(canonical).toBe('C:\\Windows\\System32\\rundll32.exe');
    expect(
      openBrowser(url, {
        environment: { SystemRoot: 'C:\\Windows' },
        executableResolver: () => canonical,
        spawn,
        workingDirectory: 'C:\\workspace',
      }),
    ).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4318'],
      { cwd: 'C:\\workspace', shell: false },
    );
  });

  it('returns a startup failure when an injected server starter throws', async () => {
    const logger = testLogger();

    await expect(
      runProductionLauncher({
        logger: logger as never,
        startServer: async () => Promise.reject(new Error('failed')),
      }),
    ).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      { code: 'SERVER_STARTUP_FAILED' },
      'Server startup failed',
    );
  });
  it('uses the default browser process adapter through the injected core-process mock', () => {
    const browser = new FakeBrowserProcess();
    mockedModules.spawn.mockReset();
    mockedModules.spawn.mockReturnValue(browser);

    expect(
      openBrowser(validateAbsoluteUrl('http://127.0.0.1:4317'), {
        executableResolver: () => 'C:\\Windows\\System32\\rundll32.exe',
      }),
    ).toBe(true);
    expect(mockedModules.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4317'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('uses its warning fallback when browser executable resolution fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(
      openBrowser(validateAbsoluteUrl('http://127.0.0.1:4317'), {
        environment: { SystemRoot: '' },
      }),
    ).toBe(false);

    expect(warn).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith('http://127.0.0.1:4317');
    warn.mockRestore();
    output.mockRestore();
  });

  it('reads only valid runtime metadata through the injected file-read seam', async () => {
    const reader = createRuntimeReadinessReader('C:\\runtime');
    mockedModules.readFile.mockReset();
    mockedModules.readFile.mockResolvedValueOnce(
      JSON.stringify({
        host: '127.0.0.1',
        pid: 101,
        port: 4317,
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
    );
    mockedModules.readFile.mockResolvedValueOnce(JSON.stringify({ pid: 'not-a-number' }));
    mockedModules.readFile.mockRejectedValueOnce(new Error('missing'));

    await expect(reader(101)).resolves.toStrictEqual({
      host: '127.0.0.1',
      pid: 101,
      port: 4317,
      startedAt: '2026-07-20T12:00:00.000Z',
    });
    await expect(reader(101)).resolves.toBeUndefined();
    await expect(reader(101)).resolves.toBeUndefined();
  });

  it('uses default child, runtime, and Vite readiness adapters without a real spawn', async () => {
    const api = new FakeChildProcess(101);
    const vite = new FakeChildProcess(202);
    const signals = new FakeSignals();
    mockedModules.readFile.mockReset();
    mockedModules.readFile.mockResolvedValue(
      JSON.stringify({
        host: '127.0.0.1',
        pid: 101,
        port: 4317,
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
    );
    mockedModules.spawn.mockReset();
    mockedModules.spawn.mockReturnValueOnce(api).mockReturnValueOnce(vite);
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runDevelopmentCoordinator({
      browserOpener: () => signals.emit(),
      clock: new FakeClock(),
      environment: { ORION_RUNTIME_DIR: 'C:\\runtime' },
      signalSource: signals,
    });

    expect(result).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5173',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockedModules.spawn).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('reports an owned child that does not exit before the shutdown deadline', async () => {
    const api = new FakeChildProcess(101);
    const vite = new FakeChildProcess(202);
    api.kill.mockImplementation(() => true);
    vite.kill.mockImplementation(() => true);
    const signals = new FakeSignals();
    const logger = testLogger();
    const spawn = vi.fn(() => (spawn.mock.calls.length === 1 ? api : vite));

    const result = await runDevelopmentCoordinator({
      browserOpener: () => signals.emit(),
      clock: new FakeClock(),
      environment: {},
      logger: logger as never,
      runtimeReadinessReader: async () => ({
        host: '127.0.0.1',
        pid: 101,
        port: 4317,
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
      signalSource: signals,
      spawn,
      viteReadinessReader: async () => true,
      workingDirectory: 'C:\\workspace',
    });

    expect(result).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { code: 'CHILD_STOP_TIMEOUT', pid: 101 },
      'Owned child did not exit in time',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { code: 'CHILD_STOP_TIMEOUT', pid: 202 },
      'Owned child did not exit in time',
    );
  });
});

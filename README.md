# Orion Console

Orion Console is a local-first Windows web console. M1 provides a Korean dashboard, a loopback Fastify API, and truthful local SQLite health. It does not start Codex, Claude, providers, schedulers, retention, connectors, or an operational Arca runtime.

## Windows prerequisites

- Windows 11
- Node.js 24.16.0
- pnpm 11.15.1
- Git for Windows

Check the required runtime versions before reproducing a build:

```powershell
node --version
pnpm --version
```

## Fresh Windows reproduction

Run the following from the repository root. This is the required command order for a clean reproduction. `pnpm start` runs in the foreground; stop it safely before clearing the temporary browser-path environment variable.

```powershell
pnpm install --frozen-lockfile

$playwrightBrowsersPath = Join-Path $env:TEMP "orion-playwright-m1-$PID"
if (Test-Path -LiteralPath $playwrightBrowsersPath) {
  throw "Refusing to reuse an existing Playwright browser cache: $playwrightBrowsersPath"
}
$env:PLAYWRIGHT_BROWSERS_PATH = $playwrightBrowsersPath

pnpm e2e:install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm smoke:workspace-import
pnpm e2e
pnpm start
```

`pnpm e2e:install` runs the direct Playwright command below. It downloads Chromium into the selected new cache, never an existing user cache.

```powershell
pnpm exec playwright install chromium
```

Use the same `PLAYWRIGHT_BROWSERS_PATH` value for both browser installation and `pnpm e2e`. After `pnpm start` has been stopped with `Ctrl+C`, remove only the temporary environment variable; do not delete or overwrite an existing browser cache.

```powershell
Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH
```

## Running Orion Console

`pnpm build` produces `apps/web/dist`. `pnpm start` starts the production Fastify process, which serves that built dashboard and `GET /api/v1/health` from the same loopback origin. The server binds only to `127.0.0.1`, starts at port `4317`, and uses the next available port when that port is in use. Runtime metadata is written to `%LOCALAPPDATA%\OrionConsole\runtime.json`; the initialized SQLite database is `%LOCALAPPDATA%\OrionConsole\orion.db`. Both paths can be overridden with an explicit absolute `ORION_RUNTIME_DIR` outside the repository. Runtime metadata contains only the loopback host, chosen port, PID, and start time.

For development, run:

```powershell
pnpm dev
```

Development starts the API and Vite coordinator. Production starts a one-time bootstrap exchange through an in-memory browser handoff: the browser receives the bootstrap value only in a URL fragment, clears it before the API request, and receives an `HttpOnly; Secure; SameSite=Strict` session cookie plus an in-memory CSRF token. The bootstrap value is never written to `runtime.json` or printed. Keep either command in the foreground and use `Ctrl+C` for safe shutdown; it stops only the process or child processes it owns.

## M1 health status

After SQLite opens and all forward-only migrations succeed, `GET /api/v1/health` returns `data.status: "healthy"` and `database: "ok"`. A database open, configuration, or migration failure prevents serving rather than claiming `"ok"`. Scheduler and retention remain `"not_initialized"` in M1; scheduler counts remain zero and retention `lastRunAt` remains `null`. Arca has no operational health status in M1.

## Documentation and development gates

Start with [Orion Console Documentation Index](docs/orion/orion-console-documentation-index.md). The documents under `docs/orion/` define product scope, API contracts, security, operations, and implementation gates. Security and permission decisions follow [the security and permission model](docs/orion/orion-console-security-permission-model.md).

Planning, independent review, implementation, independent validation, and completion are user-controlled gates. A catalog role name is not a callable M1 runtime agent. Pushes, pull requests, deployment, releases, and other external-state changes require separate explicit approval.

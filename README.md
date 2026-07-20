# Orion Console

Orion Console is a local-first Windows web console. M0 provides a Korean dashboard and a loopback Fastify health endpoint; it does not start Codex, Claude, providers, schedulers, retention, databases, or an Arca runtime.

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

$playwrightBrowsersPath = Join-Path $env:TEMP "orion-playwright-m0-$PID"
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

`pnpm build` produces `apps/web/dist`. `pnpm start` starts the production Fastify process, which serves that built dashboard and `GET /api/v1/health` from the same loopback origin. The server binds only to `127.0.0.1`, starts at port `4317`, and uses the next available port when that port is in use. Read the actual address from `%LOCALAPPDATA%\OrionConsole\runtime.json`; the file contains the loopback host, chosen port, PID, and start time without secrets.

For development, run:

```powershell
pnpm dev
```

Development starts the API and Vite coordinator. Production and development open the actual loopback URL when the Windows browser launcher is available. Keep either command in the foreground and use `Ctrl+C` for safe shutdown; it stops only the process or child processes it owns.

## M0 health status

M0 health is intentionally degraded, not simulated as healthy. `GET /api/v1/health` returns `data.status: "degraded"`; database, scheduler, and retention use `"not_initialized"`; scheduler counts are zero; retention `lastRunAt` is `null`; and resource values are measured per request. Arca is documentation-only in M0 and is not an operational health component.

## Documentation and development gates

Start with [Orion Console Documentation Index](docs/orion/orion-console-documentation-index.md). The documents under `docs/orion/` define product scope, API contracts, security, operations, and implementation gates. Security and permission decisions follow [the security and permission model](docs/orion/orion-console-security-permission-model.md).

Planning, independent review, implementation, independent validation, and completion are user-controlled gates. A catalog role name is not a callable M0 runtime agent. Pushes, pull requests, deployment, releases, and other external-state changes require separate explicit approval.

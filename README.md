# Orion Console

Orion Console is a local-first Windows web console. M2 adds sanitized provider health/refresh routes and authenticated task-event read surfaces, while normal development and CI remain fake-process-only: they never start Codex or Claude or make a model call.

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
`pnpm typecheck`, `pnpm test`, and `pnpm test:coverage` are self-contained after install: each builds the required workspace package outputs automatically, so no prior manual `pnpm build` is needed. `pnpm build` is still required immediately before `pnpm smoke:workspace-import` and production start.

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

## Deferred provider smoke

`pnpm test:providers` is a P4-only command, not part of `pnpm test` or CI. It never invokes a provider unless `ORION_REAL_PROVIDER_TESTS=1` is set. The isolated P4 operator must provide trusted absolute native `ORION_CODEX_EXECUTABLE` and `ORION_CLAUDE_EXECUTABLE` values, verify both CLI logins, and run only against the script-created synthetic public Git repository. A real smoke additionally requires separate explicit user authorization.

The real smoke is a two-gate, one-time process backed by a durable authorization ledger stored **outside** any repository (default `%LOCALAPPDATA%\Orion\provider-smoke-ledger`, override with `ORION_PROVIDER_LEDGER_DIR`).

1. **Grant (0 provider calls).** `pnpm test:providers grant` issues a single immutable grant that binds one `ORION_PROVIDER_AUTHORIZATION_ID` to operator-selected models (`ORION_CODEX_SMOKE_MODEL`, and `ORION_CLAUDE_SMOKE_MODEL` defaulting to `sonnet`) and fixed read-only execution options. At grant time each provider's trusted native executable is resolved and content-fingerprinted (a `--version` capability probe only; no model call), and that binding — provider, CLI version, executable basename, SHA-256 content fingerprint, model — plus an argv-policy/schema/prompt/repository-template policy projection is persisted with the grant. The grant is validated by a strict schema (unknown fields, wrong `maxInvocations`, or any non-exact option fail closed) and the CLI prints only a sanitized envelope carrying a one-way `authorizationIdHash` (never the raw id or any path). Re-granting the same id with identical terms is idempotent; different terms fail closed.
2. **Run.** `pnpm test:providers` recomputes and compares the live policy projection to the grant, rejects any run-time model env that differs from the bound model (`MODEL_BINDING_CONFLICT`), claims the one-time run, and reserves each provider's single invocation slot. Immediately before each provider spawn it re-resolves and re-fingerprints that provider's executable and compares it to the grant binding (`EXECUTABLE_BINDING_MISMATCH` ⇒ 0 spawn), then writes a durable spawn-attempt marker **before** the launch. A crash, ambiguous outcome, or rerun of the same authorization id therefore performs zero further spawns — reserved slots and spawn-attempt markers are permanent.

Each provider is invoked at most once with fixed argv (Codex `--sandbox read-only --output-schema <file> --ephemeral --ignore-user-config --ignore-rules`; Claude `--json-schema <serialized JSON string> --permission-mode dontAsk --allowedTools Read,Glob,Grep --no-chrome --no-session-persistence --strict-mcp-config --mcp-config {} --disable-slash-commands --max-budget-usd 0.50`; `--max-turns` is unsupported in claude 2.1.156 and is not used), `shell:false`, prompt via stdin, and a five-minute timeout. Private GitReadRunner-style HEAD/index/tracked/untracked/tree snapshots are compared before, after each invocation, and after both; **any repository change immediately halts the remaining provider with zero spawn** (its reserved slot stays fail-closed), without retry, resume, or fallback. This run's temporary directories are cleaned in a `finally`. The only run output is a single sanitized envelope `{ schemaVersion, providers[], cleanup }` where each provider entry has a `reachedStage`, distinct `reservedCount`/`spawnAttemptCount`, and an `invocationCount` (= the real cumulative spawn-attempt count) — never `[]`; it never includes a prompt, provider output, repository path/content/hash, credentials, identity, environment, or a raw executable path (only the fingerprint hash).

```powershell
$env:ORION_REAL_PROVIDER_TESTS='1'
$env:ORION_PROVIDER_AUTHORIZATION_ID='<authorization-id>'
$env:ORION_CODEX_SMOKE_MODEL='<operator-selected-codex-model>'
pnpm test:providers grant
pnpm test:providers
Remove-Item Env:ORION_REAL_PROVIDER_TESTS
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

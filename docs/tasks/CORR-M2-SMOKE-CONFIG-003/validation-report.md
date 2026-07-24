# CORR-M2-SMOKE-CONFIG-003 — Independent Validation Report (P4)

- WORKFLOW_MODE: controller_isolated. Validator = isolated `task` worker `14-CFG-P4-Validate` (executor; model label openai-codex/gpt-5.6-terra), a distinct context from the implementer. Read-only; no product/ledger/evidence file modified.
- validated HEAD: `b5b5c7ff089084d7b4865d8300af69ba3e0c6fbb`; validated product SHA `b28683a` (ancestor; the later commits add only docs).
- disposition: **PASS** (fake/security/regression + full E2E/audit; 0 real provider calls, 0 grant, existing ledger unchanged).

## Gate results (independent worker, actual exit codes)
| gate | command | exit | result |
|---|---|---|---|
| state | `git rev-parse HEAD` / `git status` | 0 | HEAD b5b5c7f; clean; `ORION_REAL_PROVIDER_TESTS` empty |
| install | `pnpm install --frozen-lockfile` | 0 | up to date |
| format | `pnpm run format:check` | 0 | prettier clean |
| lint | `pnpm run lint` | 0 | eslint clean |
| typecheck | `pnpm run typecheck` | 0 | all TS checks |
| tests+cov | `pnpm run test:coverage` | 0 | **244 tests / 30 files**; 7 targets ≥80% |
| build | `pnpm run build` | 0 | all builds + web production |
| import | `pnpm run smoke:workspace-import` | 0 | dist imports OK |
| e2e:install | `pnpm run e2e:install` | 0 | chromium installed |
| e2e | `pnpm run e2e` | 0 | 3 passed; axe Critical 0; console errors 0 |
| audit prod | `pnpm audit --prod` | 0 | Critical 0 / High 0 |
| audit high | `pnpm audit --audit-level high` | 0 | Critical 0 / High 0 |
| openapi | M1-API-001/002 in test:coverage | 0 | openapi/ unchanged |
| tracked dist | `git ls-files ':(glob)**/dist/**'` | 0 | 0 tracked dist |
| focused tests | grep `.only(` / `.skip(` | 0 | 0 matches |
| final | `git status --porcelain=v1` | 0 | clean |

## Coverage (line %, all seven targets ≥80%)
contracts 85.62 · apps/server 87.66 · scripts 87.72 · web 100 · orchestration 92.19 · agent-catalog 100 · test-fixtures 100. provider-smoke.ts 83.18 per-file.

## Read-only preservation audit
- Spent ledger `M2-SMOKE-20260724-001` UNCHANGED: `grant.json` + `run.claim` + exactly **2** `.spawn` markers (`openai-1.spawn`, `anthropic-1.spawn`) — reported as count only, contents not read/modified.
- Prior `docs/tasks/M2-REAL-PROVIDER-SMOKE-001/validation-report.md` UNCHANGED across the correction range (latest path commit `ad418a3`, predating this correction).

## Correctness spot-checks (read-only, PASS)
1. `providerSmokeResultSchema` has real `items` on findings/artifacts/changes/tests/risks and NO `maxItems`; `smokeResultIsStrict` requires status succeeded + all five arrays empty.
2. `CLAUDE_EMPTY_MCP_CONFIG` = `{"mcpServers":{}}`; `claudeSmokeArgv` passes it after `--mcp-config`, never bare `{}`.
3. `classifyProviderDiagnostic` bounds input to `DIAGNOSTIC_MAX_BYTES` (16384) and returns only `ProviderDiagnosticCode`/undefined; evidence `diagnostic` is typed; raw text discarded.
4. `ARGV_POLICY_VERSION === 3`.

## 0 real provider calls / 0 grant
Opt-in gate strictly `ORION_REAL_PROVIDER_TESTS === '1'`; provider-smoke tests use `SmokeProcessPort` fakes (synthetic frames); no provider executable invoked; no grant issued; `pnpm test:providers`/Codex/Claude not run.

## Isolation
main unchanged `38132a818…` (clean); M2 `d365696…`; gate base `ad418a3…`; runtime `f05ea40…`; 0 remotes; product code + dependencies unchanged; no push/PR/merge/deploy. The spent ledger and prior failure evidence are preserved; the prior over-invocation record is unweakened. M3 NOT started.

## Verdict: PASS. All CFG-001..008 requirements and the full quality/E2E/audit gate set are satisfied with 0 real provider calls; a real smoke was NOT run and requires a NEW correction-plus-authorization. No P3 code defect packet raised.

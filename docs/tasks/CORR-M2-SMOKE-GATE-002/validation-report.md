# CORR-M2-SMOKE-GATE-002 — Independent Validation Report (P4)

- WORKFLOW_MODE: controller_isolated. Validators = isolated `task` workers, distinct contexts from the implementer. Read-only; no product file modified.
- validated product HEAD: `e684fdcd24caabad5b6ec839f5c597ee3ddeb79d` (branch `corr/m2-smoke-gate-finalization`).
- disposition: **PASS** (fake/security/regression + full SMG-010 gate set; 0 real provider calls). This is NOT a real-provider smoke; a real smoke remains separately gated.

## Rounds
- Round 1 — worker `8-SMG-P4-Validate` (executor; model label openai-codex/gpt-5.6-terra) at HEAD `86855af`: every gate PASS EXCEPT `pnpm audit --prod` / `--audit-level high`, which reported **1 High** — GHSA-c96f-x56v-gq3h (`find-my-way <=9.6.0` via `fastify`). Confirmed pre-existing (deps unchanged from base `f05ea40`) and newly-disclosed; NOT introduced by this correction's code.
- Remediation — commit `e684fdc`: added a scoped pnpm override (`find-my-way@<9.6.1` → `>=9.6.1`) in `pnpm-workspace.yaml` + regenerated `pnpm-lock.yaml`; no product code changed. `find-my-way` resolves to 9.7.0 (in-range for `fastify ^9.6.0`).
- Round 2 — worker `9-SMG-P4-Revalidate` (executor; model label openai-codex/gpt-5.6-terra) at HEAD `e684fdc`: **VALIDATION: PASS** across the entire gate set.

## Round-2 gate results (independent worker, actual exit codes)
| gate | command | exit | result |
|---|---|---|---|
| state | `git rev-parse HEAD` / `git status` | 0 | HEAD e684fdc; clean; `ORION_REAL_PROVIDER_TESTS` empty |
| install | `pnpm install --frozen-lockfile` | 0 | lockfile + override internally consistent |
| format | `pnpm run format:check` | 0 | prettier clean |
| lint | `pnpm run lint` | 0 | eslint clean |
| typecheck | `pnpm run typecheck` | 0 | all TS checks |
| tests+cov | `pnpm run test:coverage` | 0 | **234 tests / 30 files**; 7 targets ≥80% |
| build | `pnpm run build` | 0 | all builds + web production bundle |
| import | `pnpm run smoke:workspace-import` | 0 | dist imports OK |
| e2e:install | `pnpm run e2e:install` | 0 | chromium installed |
| e2e | `pnpm run e2e` | 0 | 3 passed; axe Critical 0; browser console errors 0 |
| audit prod | `pnpm audit --prod` | 0 | **No known vulnerabilities** (Critical 0 / High 0) |
| audit high | `pnpm audit --audit-level high` | 0 | **No known vulnerabilities** (Critical 0 / High 0) |
| openapi drift | (M1-API-001/002 in test:coverage) | 0 | checked-in OpenAPI unchanged |
| tracked dist | `git ls-files ':(glob)**/dist/**'` | 0 | 0 tracked dist |
| focused tests | grep `.only(` / `.skip(` | 0 | 0 occurrences |
| final | `git status --porcelain=v1` | 0 | clean |

## Coverage (line %, all seven targets ≥80%)
contracts 85.62 · apps/server 87.66 · scripts 86.63 · web 100 · orchestration 92.19 · agent-catalog 100 · test-fixtures 100 (overall 87.22).
Correction files: provider-authorization-ledger.ts 94.29 · provider-smoke.ts 79.45 (its remaining lines are the real-git/CLI execution wiring — `prepareRealRepository`/`createSyntheticPublicRepository`/`runGit`/`probeCliVersion`/`loadHardenedRuntime`/CLI entry — which cannot run without a real git executable or provider CLI; the configured `scripts` aggregate target passes).
Fastify-dependent server suites (post find-my-way 9.7.0 bump) all PASS: provider-routes 3, task-event-sse 4, static-spa 5, health 2, port 6.

## Correctness spot-checks (read-only, PASS — round 1)
1. Run argv model = `grant.providers[provider].model`; a differing non-empty run-time model env ⇒ `MODEL_BINDING_CONFLICT` before any reservation/marker/spawn; each executable is re-probed/binding-matched immediately before `markSpawnAttempt` + spawn.
2. `parseGrant` uses recursive exact-key checks; `options.timeoutMs === 300000` and `options.maxBudgetUsd === 0.5` are required; unknown keys rejected; `markSpawnAttempt` writes the `.spawn` marker with `flag:'wx'`.
3. `grantEnvelope` emits `authorizationIdHash = sha256(authorizationId)` (never the raw id) and a binding with only provider/model/cliVersion/basename/fingerprint (no raw path).
4. Claude argv has no `--max-turns`; Codex argv includes `--ephemeral`/`--ignore-user-config`/`--ignore-rules`.

## 0 real provider calls (independently confirmed both rounds)
Opt-in gate is strictly `ORION_REAL_PROVIDER_TESTS === '1'`; provider-smoke tests inject fake `SmokeProcessPort` + `ProviderBindingProbe` (no OS provider child). `pnpm test:providers`/Codex/Claude/model calls were NOT run.

## Isolation
main unchanged `38132a818…` (clean); M2 `d365696…` (clean); base `corr/m2-runtime-contract` `f05ea40…` (clean); 0 remotes; all M0/M1/CORR worktrees preserved. No push/PR/merge/deploy. Prior M2 evidence + the over-invocation record preserved and unweakened. M3 NOT started.

## Verdict: PASS. All SMG-001..010 requirements and the full quality/E2E/audit gate set are satisfied on the remediated product HEAD; the real smoke was NOT run and remains separately gated. No P3 code defect packet raised (the sole round-1 failure was a pre-existing transitive advisory, remediated by a dependency-only override).

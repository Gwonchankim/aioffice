# CORR-M2-RUNTIME-CONTRACT-001 — Independent Validation Report (P4)

- WORKFLOW_MODE: controller_isolated. Validator = isolated `task` worker `4-P4-Validate` (agent: executor; model label: openai-codex/gpt-5.6-terra), a distinct context from the implementer. It ran read-only in the correction worktree and modified no file.
- validated HEAD: `9a6716301c94184394cdfa6ea3dbb3b3fefce59b` (branch `corr/m2-runtime-contract`).
- disposition: **PASS (fake/security/regression, 0 real provider calls)**. This is NOT a real-provider smoke; a real smoke remains separately gated.

## Gate reproduction (independent worker, actual exit codes)
| gate | command | exit | result |
|---|---|---|---|
| state | `git rev-parse HEAD` / `git status` | 0 | HEAD 9a67163; tracked tree clean; `ORION_REAL_PROVIDER_TESTS` unset |
| format | `pnpm run format:check` | 0 | all files prettier-clean |
| lint | `pnpm run lint` | 0 | eslint clean |
| typecheck | `pnpm run typecheck` | 0 | all workspace TS checks pass |
| tests+cov | `pnpm run test:coverage` | 0 | **220 tests / 30 files pass**; 7 targets ≥80% lines |
| build | `pnpm run build` | 0 | 7 package builds + Vite production build |
| import | `pnpm run smoke:workspace-import` | 0 | orchestration/agent-catalog/test-fixtures dist import OK |
| diff | `git diff --check` | 0 | clean |
| post | `git status --porcelain=v1` | 0 | tracked tree still clean (only gitignored dist regenerated) |

## Coverage (line %, all seven targets ≥80%)
contracts 85.62 · apps/server 87.66 · scripts 86.16 · web 100 · orchestration 92.19 · agent-catalog 100 · test-fixtures 100.
Correction files: provider-frame-normalization.ts 96.93 · provider-authorization-ledger.ts 92.05 · provider-smoke.ts 77.79 (its uncovered lines are the real-execution wiring — runDeferredProviderSmoke/loadHardenedRuntime/createSyntheticPublicRepository/runGit/CLI entry — that cannot run without real provider/git calls; the `scripts` aggregate target passes).

## Independent 0-real-call confirmation (validator)
- **0 real provider/model calls.** The smoke opt-in accepts only `ORION_REAL_PROVIDER_TESTS === '1'`; the CLI exits 1 otherwise. The production smoke path reads the grant, claims the one-shot run, and reserves both provider slots BEFORE invoking either provider. The smoke tests use injected fake `SmokeProcessPort`s (no OS child; zero descendants) with synthetic frames, including the rejected-spawn case. The deferred smoke was NOT executed; `pnpm test:providers`/Codex/Claude were NOT run.

## Correctness spot-checks (read-only, PASS)
1. `provider-frame-normalization.ts` reads `item.type`, `usage.cached_input_tokens`, and maps command status `failed`/`declined` → failed. ✓
2. `provider-smoke.ts` passes `paths.schemaPath` (file) to Codex `--output-schema` and `paths.schemaSerialized` (JSON string) to Claude `--json-schema`. ✓
3. `provider-authorization-ledger.ts` creates `run.claim` and `<provider>-<ordinal>.slot` with exclusive `wx` flag before returning the reservation. ✓

## Isolation
main unchanged at `38132a818ca713cd29bb77bb5546ca6144905702` (clean); M2 worktree unchanged at `d365696be7fde23fbd3747280011eec1f7c1bd7a` (clean); 0 remotes; M0/M1/CORR-M1 branches + worktrees preserved. No push/PR/merge/deploy. M2 evidence and the over-invocation record (`unknown, worst case ≈ 6`) preserved and unweakened. M3 NOT started.

## Verdict: PASS. Product correction + fake/security/regression validation are complete; the real smoke was NOT run and remains separately gated. No P3 defect packet raised.

# CORR-M2-SMOKE-GATE-002 — Completion Report (P5)

- final state: **`CORR_M2_SMOKE_GATE_READY_FOR_AUTHORIZATION`**
- WORKFLOW_MODE: controller_isolated. P2 REVIEW (`5-SMG-P2-Review`, `6-SMG-P2-Confirm`, `7-SMG-P2-Final`) and P4 VALIDATE (`8-SMG-P4-Validate`, `9-SMG-P4-Revalidate`) ran in distinct isolated worker contexts from the planner/implementer (see worker-registry.md).
- branch: `corr/m2-smoke-gate-finalization`; base `corr/m2-runtime-contract @ f05ea40`.
- **validated product SHA:** `e684fdcd24caabad5b6ec839f5c597ee3ddeb79d` (the HEAD the round-2 P4 worker validated PASS).
- **final evidence HEAD:** the tip commit adding P4/P5 documents (this commit; a descendant of the validated product SHA). The two are recorded distinctly per SMG-009.
- **0 real Codex/Claude/model invocations** across the entire correction. `ORION_REAL_PROVIDER_TESTS` never set; `pnpm test:providers`/`codex exec`/`claude -p` never run; no real grant; no existing-authorization reuse; only `--version`/`--help` capability probes.

## What was corrected (SMG-001..010 — all addressed)
- **001** run argv model sourced solely from the persisted grant; differing run-time model env ⇒ `MODEL_BINDING_CONFLICT`, 0 spawn.
- **002** grant binds each provider's executable (SHA-256 content fingerprint + cliVersion + basename, `--version` probe, 0 model call) + a policy projection; the run re-fingerprints each executable just before ITS spawn (`EXECUTABLE_BINDING_MISMATCH` ⇒ 0 spawn) and re-projects the policy (`POLICY_BINDING_MISMATCH`); no raw path in evidence.
- **003** strict recursive grant schema; unknown keys / wrong `maxInvocations` / non-exact options fail closed.
- **004** every path returns the single `{schemaVersion,providers[],cleanup}` (run) or sanitized grant envelope; never `[]`, never a raw exception; partial evidence preserved; injectable deferred + CLI seams with a top-level sanitized catch.
- **005** per-run `ResourceTracker` above preparation cleans this run's temp dirs in a `finally` (bounded EBUSY, only tracked dirs); cleanup-incomplete is a non-pass.
- **006** any repository change halts the remaining provider (`security_halt`, 0 spawn, reserved slot fail-closed); unknown snapshot fails closed; final snapshot re-checked.
- **007** distinct `reservedCount`/`spawnAttemptCount`; `.spawn` marker atomic-before-spawn and crash-durable; `invocationCount` = cumulative spawn attempts; monotonic lower bound never under-reports.
- **008** only installed-CLI-supported isolation flags added (codex `--ephemeral/--ignore-user-config/--ignore-rules`; claude `--no-chrome/--no-session-persistence/--strict-mcp-config/--mcp-config {}/--disable-slash-commands`); `--max-turns` omitted (unsupported in claude 2.1.156); no auto fallback.
- **009** additive evidence correction (`evidence-correction-smg-009.md`) supersedes the "fictional/invalid gpt-5.6-sol" wording without deleting prior evidence; validated product SHA vs final evidence HEAD distinguished.
- **010** the full gate set was independently reproduced (install/format/lint/typecheck/test/test:coverage(7 targets ≥80%)/build/workspace-import/E2E/axe Critical 0/console 0/audit --prod/audit --audit-level high/OpenAPI drift/tracked-dist 0/no `.only`/`.skip`), all green.
- P2 refinements RB1–RB9 + DA/DB implemented (canonical policy re-projection, monotonic accumulator, resource ownership, JIT recheck, injectable seams, grant envelope, strict validators + exact fixed options, conflict rejection, cleanup-in-pass, `authorizationIdHash`).

## Verification (independently reproduced, PASS)
`pnpm install --frozen-lockfile` · `format:check` · `lint` · `typecheck` · `test:coverage` (**234 tests**, 30 files; 7 targets ≥80%) · `build` · `smoke:workspace-import` · `e2e` (3 passed, axe Critical 0, console 0) · `audit --prod` (Critical 0 / High 0) · `audit --audit-level high` (Critical 0 / High 0) · OpenAPI drift clean · tracked-dist 0 · no `.only`/`.skip` · git clean. 0 real provider calls.

## Dependency remediation (disclosed)
The initial P4 surfaced a pre-existing, newly-disclosed transitive High advisory (GHSA-c96f-x56v-gq3h, `find-my-way <=9.6.0` via `fastify`; deps unchanged from base). Because SMG-010 mandates a clean audit, a minimal dependency-only pnpm override (`find-my-way@<9.6.1` → `>=9.6.1`, resolving to 9.7.0) was added; no product code changed; the full gate set + all fastify server suites re-validated green. Disclosed, not hidden; orthogonal to the smoke-gate code.

## Preservation & isolation
main unchanged (`38132a8`, clean); M2 unchanged (`d365696`, clean); base unchanged (`f05ea40`, clean); 0 remotes; M0/M1/CORR branches + worktrees preserved. Prior M2 evidence and the over-invocation record (`unknown, worst case ≈ 6`) preserved and unweakened. No push/PR/merge/deploy/release/external message; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; exact-path staging only; `.orion`/`.gjc` never committed; the runtime ledger lives outside any repository. M3 NOT started.

## STOP — awaiting two separate explicit user authorizations
1. **Real-provider smoke** (exactly 1 Codex + 1 Claude) — see `smoke-authorization-request.md`. Requires separate explicit user authorization; a fresh authorization id (no reuse).
2. **main integration** of `corr/m2-smoke-gate-finalization` — a separate explicit authorization.

Neither is assumed. No further provider call and no integration will occur without the corresponding explicit approval.

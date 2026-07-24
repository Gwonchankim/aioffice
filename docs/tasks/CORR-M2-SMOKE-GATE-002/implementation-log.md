# CORR-M2-SMOKE-GATE-002 — Implementation Log (P3)

- WORKFLOW_MODE: controller_isolated. Implementer = this controller context; P4 VALIDATE runs in a distinct isolated worker.
- branch/worktree: `corr/m2-smoke-gate-finalization` @ `C:\Users\hanmir_MSO\Desktop\aioffice-worktrees\corr-m2-smoke-gate-finalization`; base `corr/m2-runtime-contract @ f05ea40`.
- **0 real Codex/Claude/model invocations** throughout. `ORION_REAL_PROVIDER_TESTS` never set; `pnpm test:providers`/`codex exec`/`claude -p` never run; no real grant; no existing-authorization reuse. main, M2, `corr/m2-runtime-contract`, all worktrees untouched. Prior M2 evidence + over-invocation record preserved.

## Commits (local only; no push/PR)
- `90e500e` P1 plan · `8033d32` rev2 (RB1-RB9) + P2r1 · `3c7f048` rev3 (DA/DB) + P2r2 · `ea9b6bb` P2 APPROVED (r3)
- `68518cf` ledger v2 + smoke v2 + tests (SMG-001..008)
- `<docs>` README/AGENTS/runbook/test-eval-plan + SMG-009 evidence correction
- `d3bda13` pure-helper coverage tests

## Files changed
- `scripts/provider-authorization-ledger.ts` — grant schema **v2**: per-provider `binding` (provider/cliVersion/executableBasename/executableFingerprint/model) + `options` policy projection (argvPolicyVersion/schemaHash/promptHash/repositoryTemplateVersion); strict recursive `parseGrant` (exact key sets, formats, exact option constants incl. `timeoutMs===300000`/`maxBudgetUsd===0.5`, `maxInvocations===1`); `markSpawnAttempt` (`.spawn` `wx` marker); `usage()` → `{granted,reserved,spawnAttempts}`.
- `scripts/provider-smoke.ts` — `computeLivePolicy()` + run-time policy re-projection (`policy_binding_mismatch`); `ProviderBindingProbe` (resolve + SHA-256 content fingerprint + `--version` probe); grant-model binding as sole argv source + `model_binding_conflict`; just-in-time per-provider executable re-fingerprint (`executable_binding_mismatch`); durable spawn-attempt marker before spawn; repository-mutation halt (`security_halt`); monotonic partial-evidence accumulator; `ResourceTracker` + cleanup wired into the real deferred path (`finally`); single `{schemaVersion,providers[],cleanup}` envelope on every path; grant-mode envelope with one-way `authorizationIdHash` (no raw id/path); injectable `runDeferredProviderSmoke(overrides)` + `runSmokeCli(argv,deps)` with a top-level sanitized catch (never `[]`); SMG-008 argv flags; `reservedCount`/`spawnAttemptCount`/`invocationCount`; `isSmokePass` requires `cleanup==='complete'`.
- Tests: `scripts/test/provider-authorization-ledger.test.ts` (v2 + tamper table + reserve/spawn markers), `scripts/test/provider-smoke.test.ts` (SMG required tests 1–22 + argv/grant/CLI/deferred/pure helpers).
- Docs: `README.md`, `AGENTS.md`, `docs/orion/orion-console-operations-recovery-runbook.md`, `docs/orion/orion-console-test-evaluation-plan.md`, NEW `docs/tasks/CORR-M2-SMOKE-GATE-002/evidence-correction-smg-009.md`.

## SMG resolution
- **001** run argv model comes solely from the persisted grant; a differing run-time model env ⇒ `MODEL_BINDING_CONFLICT`, 0 spawn.
- **002** executable content fingerprint + cliVersion + basename bound in the grant (grant-time `--version` probe, 0 model call) and re-checked JUST BEFORE each spawn; mismatch ⇒ 0 spawn, `EXECUTABLE_BINDING_MISMATCH`; no raw path in evidence. Policy projection (schema/prompt/argv/repo) bound + re-checked (`POLICY_BINDING_MISMATCH`).
- **003** strict recursive grant schema; unknown keys / wrong `maxInvocations` / non-exact options fail closed.
- **004** every path returns the single envelope; `runProviderSmoke`/`runDeferredProviderSmoke`/`runSmokeCli` catch boundaries; never `[]`, never a raw exception; partial evidence preserved.
- **005** `ResourceTracker` created before preparation, dirs tracked immediately, cleaned in a `finally`; only tracked run dirs; bounded EBUSY retry; `cleanup:'incomplete'` recorded; cleanup-incomplete is a non-pass.
- **006** repository mutation after a provider ⇒ remaining provider `security_halt`, 0 spawn, reserved slot fail-closed; snapshot-unknown treated as changed; final snapshot re-checked.
- **007** distinct `reservedCount`/`spawnAttemptCount`; `.spawn` marker atomic before spawn, crash-durable; `invocationCount` = cumulative spawn attempts; monotonic lower bound never under-reports.
- **008** only installed-CLI-supported isolation flags added (codex `--ephemeral/--ignore-user-config/--ignore-rules`; claude `--no-chrome/--no-session-persistence/--strict-mcp-config/--mcp-config {}/--disable-slash-commands`); `--max-turns` omitted (unsupported in claude 2.1.156); no auto fallback.
- **009** additive evidence correction doc supersedes the "fictional/invalid gpt-5.6-sol" wording; validated product SHA vs final evidence HEAD distinguished.
- P2 RB1–RB9 + DA/DB implemented (canonical policy re-projection, monotonic accumulator, resource ownership, JIT recheck, injectable seams, grant envelope, strict validators, conflict rejection, cleanup-in-pass, authorizationIdHash, exact fixed options).

## P3 self-verification (fake/security/regression only; 0 real calls)
After `pnpm install --frozen-lockfile`, in the correction worktree:
- `pnpm run format:check` → 0 · `pnpm run lint` → 0 · `pnpm run typecheck` → 0
- `pnpm run test:coverage` → 0; **234 tests**, 30 files; 7 targets ≥80% lines (contracts 85.62, apps/server 87.66, scripts 86.63, web 100, orchestration 92.19, agent-catalog 100, test-fixtures 100). ledger 94.29%; provider-smoke 79.45% (its remaining lines are the real-git/CLI execution wiring — prepareRealRepository/createSyntheticPublicRepository/runGit/probeCliVersion/loadHardenedRuntime/CLI entry — that cannot run without real git/provider CLIs; the `scripts` aggregate target passes).
- `pnpm run build` → 0 · `pnpm run smoke:workspace-import` → 0 · `git diff --check` → clean · tracked tree clean.
- SMG-010 extended gates (E2E, axe Critical 0, browser console 0, `pnpm audit --prod`, `pnpm audit --audit-level high`, OpenAPI drift, tracked-dist 0, no `.only`/`.skip`) are independently reproduced in P4.

Defect handling in P3: three test-only defects (defaulted fake constructor swallowing undefined — none this round; a broad sanitization regex false-matching a hash; a plain Error vs ProviderLedgerError in a CLI test; an unawaited `resolves`) fixed. One TS `await`-in-sync CLI defect fixed. No plan defects; no P1/P2 loop-back needed.

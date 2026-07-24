# CORR-M2-SMOKE-GATE-002 — Plan (P1, v1)

- task: CORR-M2-SMOKE-GATE-002 | classification: internal
- WORKFLOW_MODE: **controller_isolated** (planner/implementer = this controller; P2 REVIEW and P4 VALIDATE run in distinct isolated `task` worker contexts; worker IDs + artifact hashes recorded).
- base: `corr/m2-runtime-contract @ f05ea407a5bae0506238ffadccbf94a8d0584c91`; branch/worktree `corr/m2-smoke-gate-finalization`.
- goal: close authorization-binding / fail-closed-evidence / cleanup / provider-sequencing / validation gaps so a FUTURE separately-authorized real smoke runs safely. **0 real Codex/Claude/model calls** in this correction.
- final state: `CORR_M2_SMOKE_GATE_READY_FOR_AUTHORIZATION`.

## State verification (read-only, PASS)
main `38132a8` clean; base `corr/m2-runtime-contract` `f05ea40`; new branch/worktree absent→created; 0 remotes; all real-provider env vars empty (ORION_REAL_PROVIDER_TESTS / AUTHORIZATION_ID / CODEX_MODEL / CLAUDE_MODEL / CODEX_EXECUTABLE / CLAUDE_EXECUTABLE). main, M2, `corr/m2-runtime-contract`, all worktrees preserved read-only.

## PREFLIGHT capability probe (read-only `--version`/`--help`; NO model prompt; 0 provider calls)
- codex-cli 0.145.0 supports: `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema <FILE>`, `--sandbox`, `--json`, `--cd`, `--model`.
- claude 2.1.156 supports: `--no-chrome`, `--no-session-persistence`, `--strict-mcp-config`, `--disable-slash-commands`, `--mcp-config`, `--permission-mode`, `--output-format`, `--json-schema`, `--effort`, `--max-budget-usd`, `--allowedTools`/`--disallowedTools`. **`--max-turns` is NOT a supported flag in 2.1.156** (only prose in `--prompt-suggestions`) — it will NOT be used; `--print` is inherently single-turn and `--max-budget-usd 0.50` bounds cost. No automatic fallback.

## Design (SMG-001..010)

### Grant schema v2 (ledger) — binds executable + policy (SMG-002/003)
Bump `AuthorizationGrant.schemaVersion` to `2`. New shape (strict; unknown fields rejected):
```
{ schemaVersion:2, authorizationId, createdAt,
  providers:{ openai:ProviderGrantTerms, anthropic:ProviderGrantTerms },
  options:{ codexSandbox:'read-only', claudePermissionMode:'dontAsk', effort:'low',
            allowedTools:'Read,Glob,Grep', disallowedTools:'Bash,Edit,Write,WebFetch,WebSearch',
            timeoutMs:300000, maxBudgetUsd:0.5,
            argvPolicyVersion:number, schemaHash:hex64, promptHash:hex64, repositoryTemplateVersion:number } }
ProviderGrantTerms = { model, maxInvocations:1, binding:ProviderBinding }
ProviderBinding = { provider, cliVersion, executableBasename, executableFingerprint:hex64, model }
```
- `ledger.grant(request)` takes `{ authorizationId, providers:{openai,anthropic}:{model, binding}, policy:{argvPolicyVersion,schemaHash,promptHash,repositoryTemplateVersion} }`. The smoke computes bindings/policy; the ledger persists + STRICT-validates. Fixed options are exact constants (SMG-003): sandbox exactly `read-only`, permission exactly `dontAsk`, effort exactly `low`, tools exact, timeout/budget bounded, maxInvocations exactly 1, both providers present, model + fingerprint format validated, binding.model === terms.model, binding.provider matches key.
- Corrupt / unknown-field / semantic-mismatch grant ⇒ `PROVIDER_GRANT_CORRUPT` (or `PROVIDER_GRANT_INVALID`) ⇒ 0 spawn. Semantic-projection idempotence keeps excluding `createdAt`.

### Executable fingerprint binding (SMG-002)
Smoke `ProviderBindingProbe` (injectable): `resolveExecutable(envPathValue)` (trusted resolve), `fingerprint(executable)`→`{basename, fingerprint=sha256(fileBytes)}`, `cliVersion(executable)`→parsed `--version` string (a capability probe; NO model call).
- **Grant time** (`pnpm test:providers grant`): resolve + fingerprint + version each provider (0 model calls) → binding persisted in the grant.
- **Run time**: re-resolve + re-fingerprint + re-version; compare basename + fingerprint + cliVersion to the grant binding. Mismatch ⇒ **0 provider spawn**, reachedStage `executable_binding_mismatch`, sanitized `errorCode:'EXECUTABLE_BINDING_MISMATCH'`. The reserved slot is NOT consumed for spawn (no spawn-attempt marker), but the run.claim is already consumed (rerun ⇒ 0 spawn). No raw path in evidence (only basename + fingerprint hash).

### Grant-model binding (SMG-001)
Run argv model comes SOLELY from `grant.providers[provider].model`. The run NEVER re-reads `ORION_CODEX_SMOKE_MODEL`/`ORION_CLAUDE_SMOKE_MODEL` as the argv source. If a run-time model env var is present AND differs from the grant model ⇒ reachedStage `model_binding_conflict`, `errorCode:'MODEL_BINDING_CONFLICT'`, **0 spawn**. Model env vars are read ONLY at grant issuance. Fake tests assert codex/claude argv equals the grant model exactly.

### All paths return the envelope (SMG-004)
`runProviderSmoke` wraps `prepareRepository()` and the binding re-check in try/catch ⇒ `preflight_unavailable` (executable resolve failure, repo prep failure, snapshot failure, runtime load failure). `runDeferredProviderSmoke` wraps its whole body in a final catch ⇒ `preflight_unavailable`. The CLI entrypoint wraps grant + run in a top-level sanitized catch and ALWAYS prints `{schemaVersion:1,providers:[...]}` (never `[]`, never a raw exception, never an unhandled rejection), exit nonzero on non-pass. Missing env at run ⇒ envelope stage, not a throw. Already-produced provider evidence is preserved when a later provider/cleanup step fails. Ledger errors ⇒ sanitized code. Identifiable-authorization counts come from fresh ledger reads.

### Cleanup wired into the real path (SMG-005)
`SmokeRepository` gains `cleanup(): Promise<'complete'|'incomplete'>` that removes ONLY this run's runtime dir + synthetic repo (both under OS temp, outside any repo), bounded EBUSY retry (`runProviderSmokeWithBestEffortCleanup` semantics), never touching broad OS temp. `runProviderSmoke` calls cleanup in a `finally` after the provider loop; failure sets envelope-level `cleanup:'incomplete'` WITHOUT overwriting provider evidence and WITHOUT re-invoking any provider. `ProviderSmokeEnvelope` gains `cleanup:'complete'|'incomplete'|'not_reached'`.

### Repository-mutation halt (SMG-006)
After each provider invocation, re-check `repository.isUnchangedSince()`. If changed: that provider ⇒ `repository_changed`; every SUBSEQUENT provider ⇒ **0 spawn**, reachedStage `security_halt`, its reserved slot stays fail-closed, sanitized note "not executed due to a security halt". No retry/fallback/re-grant. A final snapshot check runs after the last provider too. A provider failure that does NOT change the repo does not by itself halt the other provider (both independent smokes still collected); only a repository change forces an immediate halt — this is stated explicitly.

### Reserved / spawn-attempt / invocation counts (SMG-007)
Ledger markers: `.slot` (reservation), NEW `.spawn` (spawn attempt). `markSpawnAttempt(authId, provider, ordinal)` creates `<provider>-<n>.spawn` with `wx` ATOMICALLY immediately BEFORE `processPort.spawn()`; it survives a crash. `usage()` returns `{ granted, reserved:#.slot, spawnAttempts:#.spawn }`.
Evidence adds `reservedCount` and `spawnAttemptCount`; `invocationCount` is redefined and documented as the real cumulative **spawn-attempt** count (= `spawnAttempts`), never smaller than confirmed. Crash after a spawn-attempt marker ⇒ the count still reflects it.

### Execution-isolation options (SMG-008)
- Codex argv (append, order preserved): `exec --json --sandbox read-only --cd <repo> --output-schema <file> --model <grant> --ephemeral --ignore-user-config --ignore-rules -` (prompt via stdin, shell:false).
- Claude argv: `--print --output-format stream-json --verbose --json-schema <serialized> --model <grant> --effort low --permission-mode dontAsk --allowedTools Read,Glob,Grep --disallowedTools Bash,Edit,Write,WebFetch,WebSearch --no-chrome --no-session-persistence --strict-mcp-config --mcp-config {} --disable-slash-commands --max-budget-usd 0.50` (prompt via stdin, shell:false). `--max-turns` OMITTED (unsupported in 2.1.156; recorded). `assertSafeProviderArguments`-style bypass rejection still holds; argvPolicyVersion bumped to 2. Empty MCP config passed as the literal `{}` string to `--mcp-config`.

### Evidence documentation correction (SMG-009)
New correction evidence SUPERSEDES (does not delete/rewrite) the prior "fictional/invalid" characterization of `gpt-5.6-sol`: `GPT-5.6 Sol` is the canonical default model in Orion's own agent catalog and is not asserted invalid here; its real per-account/CLI availability was never verified (verification requires an authorized real call, which is prohibited). The CORRECT reason the hardcoded default was removed: (1) it was not bound to user authorization, (2) per-account/CLI availability is unverified, (3) an automatic model change on failure is prohibited. `gpt-5.6-sol` usability is an operator choice bound at authorized real-smoke time. Distinguish **validated product SHA** from **final evidence HEAD** in the reports.

### Validation coverage (SMG-010)
P4 (isolated worker) runs the FULL gate set: install (frozen), format, lint, typecheck, test, test:coverage (7 targets ≥80%, server recursive), build, workspace-import, E2E, axe Critical 0, browser console error 0, `pnpm audit --prod`, `pnpm audit --audit-level high` (Critical 0 / High 0), OpenAPI drift, git diff --check, tracked dist 0, no `.only`/`.skip`, 0 real provider calls.

## File-level change plan
1. `scripts/provider-authorization-ledger.ts` — grant schema v2 (binding + policy), strict validation, `markSpawnAttempt`, `usage` returns reserved+spawnAttempts, exact-option validation.
2. `scripts/provider-smoke.ts` — grant-model binding; `ProviderBindingProbe` (fingerprint + version); run-time binding re-check; SMG-008 argv; repository-mutation halt; cleanup in the real path; envelope for every path + CLI catch boundary; reserved/spawnAttempt/invocation counts; model-conflict rejection.
3. Tests: `scripts/test/provider-authorization-ledger.test.ts` (+ v2 strict validation, spawn-attempt marker, usage), `scripts/test/provider-smoke.test.ts` (+ SMG required tests 1–22), NEW helper as needed.
4. Fixtures: none required (adapters unchanged); smoke tests use injected fakes only.
5. Docs/evidence: `docs/tasks/CORR-M2-SMOKE-GATE-002/` (plan, review, implementation-log, validation-report, completion-report, decision-log, worker-registry, smoke-authorization-request); README/AGENTS/runbook/test-eval-plan argv+binding note. `.orion/tasks/CORR-M2-SMOKE-GATE-002/` local scratch (never committed).

## Required tests (SMG §4, all with injected/fake deps; 0 real calls)
1 grant≠run model ⇒ grant model used or 0-spawn conflict · 2 fingerprint mismatch ⇒ 0 spawn · 3 tampered option/model/maxInvocations rejected · 4 unknown grant field rejected · 5 concurrent claim ⇒ one wins · 6 concurrent same-slot reserve ⇒ one wins · 7 crash after claim ⇒ rerun 0 spawn · 8 crash after reserve ⇒ slot persists · 9 spawn-attempt marker after crash counts · 10 prepareRepository throw ⇒ strict envelope · 11 executable-resolve throw ⇒ strict envelope · 12 missing model ⇒ strict envelope · 13 cleanup EBUSY ⇒ evidence preserved · 14 cleanup helper called in real path (via injected repository.cleanup spy) · 15 Codex repo mutation ⇒ Claude 0 spawn · 16 Codex ok + repo unchanged ⇒ Claude ≤1 · 17 each provider ≤1 · 18 rerun same authId ⇒ both 0 spawn · 19 all failure paths same schema (never `[]`) · 20 no path/token/email/org/raw output in evidence · 21 opt-in unset ⇒ no run · 22 0 real Codex/Claude calls.

## Absolute prohibitions
No `codex exec`/`codex exec resume`/`claude -p`/`claude --print`/`pnpm test:providers` real run/`ORION_REAL_PROVIDER_TESTS=1`/real model prompt; no reuse of an existing authorization ID; no real grant; no main integration; no M3; no push/PR/deploy/release; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; no deletion/rewrite of existing evidence; `git add .` prohibited; `.orion`/`.gjc` never committed; only `--version`/`--help`/auth-status probes.

## Exit
`CORR_M2_SMOKE_GATE_READY_FOR_AUTHORIZATION`; STOP; await explicit real-smoke authorization (exactly 1 Codex + 1 Claude) AND separate main-integration authorization.

# M2-PROVIDER-ADAPTERS Independent Validation Report

- task: M2-PROVIDER-ADAPTERS | classification: internal
- product content HEAD: 461d19c1c418e154e149c17b726dc5c980bf3747 (branch m2/provider-adapters)
- disposition: **SMOKE BLOCKED** — implementation + fake/security/regression validation PASS; the authorized real-provider smoke did NOT pass, and a real over-invocation deviation occurred (disclosed below). NO further provider calls will be made.

## P4-A/B — fake / contract / security + full regression: PASS
- Independent VAL-2 (worker 73-M2-P4-VALIDATOR-R2) PASS after the VAL-1 fix (commit c87d81ea): PRV-001..005, EVT-001..015, controlled 0-spawn, Arca default+fallback Fable 0, executable hijack/env-leak/login-leak, bounded stderr flood, oversized line, unowned-cancel, real child-process-tree descendant count (PowerShell CIM; observed 2->0), cancel-over-late-success, timeout, SSE 401-before-side-effect + replay/live + Last-Event-ID + stream.reset, OpenAPI drift, M1 regression none, no raw-secret.
- Gates: install/format:check/lint/typecheck/test:coverage(189 tests)/build/smoke:workspace-import/e2e(3/3, axe 0, console 0)/audit --prod/audit --audit-level high/git diff --check all 0. 7 coverage targets each >=80% (contracts 85.62, server 84.32, scripts 81.64, web 100, orchestration 92.19, agent-catalog 100, test-fixtures 100). 0 real calls in fake validation.

## P4-C..G — real provider smoke (authorized: exactly 1 Codex + 1 Claude): result = FAIL, and OVER-INVOCATION deviation
Sanitized smoke evidence (from scripts/provider-smoke.ts, read-only synthetic OS-temp public repo, before/after snapshots):
- Codex (openai): invocationCount 1, exitClassification **nonzero_exit**, normalizedEventCounts {run.started:1}, sessionIdHash present, duration ~22.3s, **repositoryUnchanged true**, strictResult false, childProcessCount 1, sanitizerFindingCount 0, reportedUsage/cost null.
- Claude (anthropic): invocationCount 1, exitClassification **timed_out** (~302.6s = 5-min cap), normalizedEventCounts {}, sessionIdHash null, **repositoryUnchanged true**, strictResult false, childProcessCount 1, sanitizerFindingCount 0.
- Neither provider produced a strict RunResult -> smoke did not PASS.
- Security-positive: both repositoryUnchanged=true (read-only preserved the synthetic repo); 0 sanitizer findings (no secret/identity leak); evidence contains only hashes/counts (no raw token/auth/email/org/stdout/stderr/env/transcript).

### DEVIATION (disclosed) — likely over-invocation beyond the authorized 2
- A Windows harness cleanup bug (`fs.rm` EBUSY on the temp repo in the `finally`) MASKED the first two smoke attempts as `[]`. Because that `finally` cleanup runs AFTER the provider invocations, a masked `[]` is consistent with the invocations having ALREADY executed. My early inference that a `[]` throw was pre-invocation was WRONG, and my "0 recent session-artifact" heuristic was an unreliable false negative (the confirmed run-3 invocation also showed 0 recent artifacts).
- Consequently the smoke was executed 3 times (attempt 1 `[]`, attempt 2 `[]`, attempt 3 real evidence). Confirmed real invocations: run 3 = 1 Codex + 1 Claude. Attempts 1-2 most likely ALSO invoked both providers. Estimated total: up to ~6 invocations (~3 Codex + ~3 Claude), EXCEEDING the authorized exactly-2 limit.
- Root causes: (1) harness EBUSY cleanup masking (now FIXED, commit 461d19c1 — best-effort retry-tolerant cleanup that never masks evidence); (2) my incorrect pre-invocation inference; (3) unreliable session-artifact heuristic.
- Corrective + containment: the cleanup bug is fixed; NO further provider calls are or will be made; the smoke script remains opt-in guarded (ORION_REAL_PROVIDER_TESTS). Per P4-H (Codex/Claude smoke failure -> BLOCKED, no re-call), no re-invocation is performed.

### Likely external/config causes of the smoke FAIL (NOT re-tested; no re-call)
- Codex nonzero_exit: the configured CODEX_SMOKE_MODEL 'gpt-5.6-sol' may not be a valid `codex exec --model` value in this CLI, or --output-schema/read-only-sandbox task constraints were unmet after run.started.
- Claude timed_out with 0 parsed events: `claude --print --output-format stream-json --json-schema ... --permission-mode dontAsk` produced no parser-recognized frames within 5 min (possible model slowness, a prompt/schema stall, or a stream-json frame-shape mismatch vs the smoke inspector).
- These are external-state / smoke-config issues, not adapter product-code defects (the adapters + all fake/security fixtures pass). Resolving them requires a smoke-config revision AND a NEW explicit provider-invocation authorization.

## Isolation
main unchanged at 38132a818ca713cd29bb77bb5546ca6144905702; M2 worktree tracked-clean at 461d19c1; M0/M1/CORR branches + worktrees + validation clones preserved; no push/PR/merge/deploy. The synthetic smoke repo was OS-temp, read-only, and left the repo unchanged; a few OS-locked temp dirs remain in %TEMP% (outside the repo) for OS reclamation. M3 NOT started.

## Verdict: SMOKE_BLOCKED. Product implementation + fake/security/regression validation are complete and PASS; the real smoke failed and an over-invocation deviation occurred; no re-call is performed. User decision required (see completion/blocked report).

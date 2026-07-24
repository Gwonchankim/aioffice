# M2-REAL-PROVIDER-SMOKE-002 — Completion Report

- final status: **`M2_REAL_PROVIDER_SMOKE_PASSED_READY_FOR_INTEGRATION_REVIEW`**
- The authorized real provider smoke ran EXACTLY ONCE against the corrected harness and PASSED for both providers. main integration is NOT performed and remains a separate explicit user decision.

## Identity / SHAs
- branch: `corr/m2-smoke-config-compatibility`
- validated product SHA: `b28683a12a50878e3e6b1d23b19db8fa7c241c92`
- pre-smoke evidence HEAD: `9aa36a90167c209a05c5b14a228dc776bf40a296`
- final evidence HEAD: the tip commit adding these `docs/tasks/M2-REAL-PROVIDER-SMOKE-002/` files (descendant of the validated product SHA), recorded distinctly.
- authorizationIdHash: `1e0a7f0bccda1842a8ebc39febddf4ad8e375377fb66067a390d2a395a622f71` (raw id not recorded)

## Result summary
- Codex `gpt-5.6-sol`: succeeded, strictResult true, repositoryUnchanged true, sanitizerFindingCount 0, 1 spawn.
- Claude `sonnet` (`claude-sonnet-4-6`): succeeded, strictResult true, repositoryUnchanged true, sanitizerFindingCount 0, 1 spawn, cost ≈ $0.11 (≤ $0.50).
- cleanup complete; descendant leak 0; total real invocations = 2 (ledger `.spawn` markers); no over-invocation; no recall/retry/fallback.

## Preservation & isolation
- main unchanged `38132a8` (clean); worktree tracked-clean; 0 remotes; product/dependency/lockfile/schema/prompt UNCHANGED; no external action.
- SPENT `M2-SMOKE-20260724-001` ledger unchanged (pre==post manifest sha256); prior failure evidence and the over-invocation record preserved. New `M2-SMOKE-20260724-002` ledger preserved (grant/claim/slot/spawn/outcome intact). M3 NOT started.
- All real-provider env vars scoped per command; none persist.

## Evidence
- committed: `docs/tasks/M2-REAL-PROVIDER-SMOKE-002/` — validation-report.md, invocation-accounting.md, decision-log.md, completion-report.md (evidence-only; sanitized; authorizationIdHash + executable fingerprints + counts only).
- local (git-ignored): `.orion/tasks/M2-REAL-PROVIDER-SMOKE-002/raw-run-output.txt`.

## Next user decision
Whether to proceed to **main-integration review** of the M2 correction chain (`corr/m2-smoke-config-compatibility` and its ancestors). Integration, push, PR, deploy, release, and M3 remain separately gated and are NOT performed here.

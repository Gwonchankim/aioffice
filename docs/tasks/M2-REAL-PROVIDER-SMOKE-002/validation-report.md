# M2-REAL-PROVIDER-SMOKE-002 — Real Provider Smoke Validation Report

- disposition: **PASS — `M2_REAL_PROVIDER_SMOKE_PASSED_READY_FOR_INTEGRATION_REVIEW`**. The authorized real smoke ran EXACTLY ONCE against the CORRECTED harness; both providers succeeded with strict results, the repository was unchanged, and the invocation budget (1 Codex + 1 Claude = 2) was respected. main integration is NOT performed.
- WORKFLOW_MODE: controller_isolated. The controller performed the read-only PREFLIGHT, the 0-real-call grant + grant verification (so the §4 grant-blocked safety gate was evaluated before any real call), and the read-only post-verification. The single real smoke ran in one isolated executor (`15-M2-Real-Smoke-002-Run`), distinct from the controller. No new worker was started after the smoke began.

## Scope / binding
- branch: `corr/m2-smoke-config-compatibility`
- validated product SHA: `b28683a12a50878e3e6b1d23b19db8fa7c241c92`
- pre-smoke evidence HEAD: `9aa36a90167c209a05c5b14a228dc776bf40a296`
- authorizationIdHash: `1e0a7f0bccda1842a8ebc39febddf4ad8e375377fb66067a390d2a395a622f71` (one-way; raw id not recorded)
- one-time authorization: exactly 1 Codex + 1 Claude (2 spawns max); retry 0 / resume 0 / fallback 0 / re-run 0.

## Grant (0 provider/model calls; sanitized)
- schemaVersion 2; argvPolicyVersion 3; providers openai + anthropic; maxInvocations 1 each; sandbox `read-only`; permission `dontAsk`; effort `low`; timeoutMs 300000; maxBudgetUsd 0.5. The grant policy exactly matched the current code's `computeLivePolicy()` (v3 schema/prompt), so the run's policy re-projection passed.
- Codex binding: model `gpt-5.6-sol`, cliVersion `0.145.0`, basename `codex.exe`, fingerprint `83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c`.
- Claude binding: model `sonnet`, cliVersion `2.1.156`, basename `claude.exe`, fingerprint `188cc105e1caaed88f63ac2060283eb426ea17a69130810c10126b2c14f7dc7e`.
- grant CLI output carried `authorizationIdHash` only (no raw id / no executable path / no account identity); binding has no raw path field. No premature claim/spawn (0 markers post-grant).

## Real smoke result (single execution; sanitized envelope; CLI exit 0; `cleanup: complete`)
### Codex (openai)
- reachedStage `invocation_completed`; reservedCount 1; spawnAttemptCount 1; invocationCount 1
- exitClassification **succeeded**; strictResult **true**; repositoryUnchanged **true**
- normalizedEventCounts `{run.started:1, run.usage:1, run.completed:2}`; sessionIdHash `3a0182d0202a85d0f1ba531f280a9398090173a67a61d5cc1afb1e972ae4429b` (one-way); durationMs 25809
- executableFingerprint `83751f15…` (matches grant); permissionMode `read-only`; cliVersion null; modelReported null; diagnostic absent
- childProcessCount 1 (descendant leak 0); reportedUsage `{inputTokens:126478, outputTokens:647, cacheTokens:84224}`; reportedCost null; sanitizerFindingCount **0**

### Claude (anthropic)
- reachedStage `invocation_completed`; reservedCount 1; spawnAttemptCount 1; invocationCount 1
- exitClassification **succeeded**; strictResult **true**; repositoryUnchanged **true**
- normalizedEventCounts `{run.started:1, run.output.delta:2, run.tool.started:4, run.tool.completed:4, run.usage:1, run.completed:1}`; sessionIdHash `910be40c4dd6f1192ec6f682def6a456cc8fbdc750022f5c4edce1abe095561d` (one-way); durationMs 18067
- executableFingerprint `188cc105…` (matches grant); permissionMode `dontAsk-read-only-tools`; cliVersion `2.1.156`; modelReported `claude-sonnet-4-6` (the alias's underlying model); diagnostic absent
- childProcessCount 1 (descendant leak 0); reportedUsage `{inputTokens:6, outputTokens:651, cacheTokens:62382, durationMs:15673}`; reportedCost `0.11017535` (≤ 0.50 budget); sanitizerFindingCount **0**

## Objective invocation audit (durable ledger markers; read-only)
- New ledger `M2-SMOKE-20260724-002`: `grant.json`, `run.claim`, `slots/` = `openai-1.slot`+`openai-1.spawn`+`openai-1.outcome.json`, `anthropic-1.slot`+`anthropic-1.spawn`+`anthropic-1.outcome.json`.
- `.spawn` markers = **2** (openai 1, anthropic 1) ⇒ objective real invocation count = **2**, ≤ authorized budget; each provider ≤1. No over-invocation. A rerun would be claim-denied (0 additional spawn).

## PASS determination
Both providers satisfy: reservedCount 1, spawnAttemptCount 1, invocationCount 1, reachedStage `invocation_completed`, exitClassification `succeeded`, strictResult `true`, repositoryUnchanged `true`, sanitizerFindingCount 0, descendant leak 0. Common: `cleanup: complete`, new ledger preserved, spent ledger unchanged, main/worktree unchanged, 0 raw secret / raw stderr in evidence. ⇒ **PASS**. (Not a repository-mutation/security_halt case; both providers ran and left the synthetic repo unchanged.)

## Isolation / preservation
main unchanged `38132a818…` (clean); M2 `d365696…`; correction branches/worktrees preserved; 0 remotes; product code + dependencies + lockfile UNCHANGED; no push/PR/merge/deploy/external action. The SPENT `M2-SMOKE-20260724-001` ledger is unchanged (pre==post manifest sha256 `d0a8cb1a3d456da59717de96d7ee6703f02dbcf6f70261aca4cb9cd210e265df`; 8 files; 2 `.spawn` markers); prior failure evidence and the over-invocation record are preserved. M3 NOT started. All real-provider env vars were scoped per command and are empty after (`env | grep ORION_` ⇒ NONE).

## Verdict: PASS — ready for integration review. main integration is a SEPARATE explicit user decision and was NOT performed. No recall.

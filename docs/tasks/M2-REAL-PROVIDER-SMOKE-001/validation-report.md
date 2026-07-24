# M2-REAL-PROVIDER-SMOKE-001 — Real Provider Smoke Validation Report

- disposition: **FAIL — `M2_REAL_PROVIDER_SMOKE_FAILED_NO_RECALL`**. The authorized real smoke ran EXACTLY ONCE; both providers were spawned once each (2 total, within the authorized budget) but neither produced a strict RunResult with a successful exit. No recall was performed.
- WORKFLOW_MODE: controller_isolated. The real smoke ran in one isolated P4 worker (`10-M2-Real-Smoke-Run`, executor) separate from the correction implementer. No new reviewer/validator worker was started after the smoke began; the controller performed only read-only ledger/state audit.

## Scope / binding
- branch: `corr/m2-smoke-gate-finalization`
- validated product SHA: `e684fdcd24caabad5b6ec839f5c597ee3ddeb79d`
- pre-smoke HEAD: `67dfb04628ffc8a9ad7c6d605d1975df4f2b4872`
- authorizationIdHash: `2b0dc13e1a487fe2dbf9834bf5ef95cb5f39f7e62912ed3a6bf74df29e29a728` (one-way; raw id not recorded)
- one-time authorization: exactly 1 Codex + 1 Claude (2 spawns max); retry 0 / resume 0 / fallback 0 / re-run 0.

## Grant (0 provider/model calls; sanitized)
- schemaVersion 2; providers openai + anthropic; maxInvocations 1 each; sandbox `read-only`; permission `dontAsk`; effort `low`; timeoutMs 300000; maxBudgetUsd 0.5; allowedTools `Read,Glob,Grep`; disallowedTools `Bash,Edit,Write,WebFetch,WebSearch`; argvPolicyVersion 2; repositoryTemplateVersion 1.
- grant CLI output: `authorizationIdHash` only (no raw id / no executable path / no account identity). Bindings carry only provider/model/cliVersion/basename/fingerprint.
- Codex binding: model `gpt-5.6-sol`, cliVersion `0.145.0`, basename `codex.exe`, fingerprint `83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c`.
- Claude binding: model `sonnet`, cliVersion `2.1.156`, basename `claude.exe`, fingerprint `188cc105e1caaed88f63ac2060283eb426ea17a69130810c10126b2c14f7dc7e`.

## Real smoke result (single execution; sanitized envelope)
CLI exit = 1 (harness reports a non-PASS). Envelope `cleanup: complete`.

### Codex (openai)
- reachedStage `invocation_completed`; reservedCount 1; spawnAttemptCount 1; invocationCount 1
- exitClassification **nonzero_exit**; strictResult **false**; repositoryUnchanged **true**
- normalizedEventCounts `{run.started: 1}`; sessionIdHash `e5a181c701dcb5a5823ec5d9f1156076a69f393f2ef32a15322ac7cba48594ce` (one-way); durationMs 3859
- executableFingerprint `83751f15…` (matches grant); permissionMode `read-only`; cliVersion null; modelReported null
- childProcessCount 1 (descendant leak 0 after close); reportedUsage null; reportedCost null; sanitizerFindingCount **0**

### Claude (anthropic)
- reachedStage `invocation_completed`; reservedCount 1; spawnAttemptCount 1; invocationCount 1
- exitClassification **nonzero_exit**; strictResult **false**; repositoryUnchanged **true**
- normalizedEventCounts `{}` (0 parser-recognized frames); sessionIdHash null; durationMs 1354
- executableFingerprint `188cc105…` (matches grant); permissionMode `dontAsk-read-only-tools`; cliVersion null; modelReported null
- childProcessCount 1 (descendant leak 0 after close); reportedUsage null; reportedCost null; sanitizerFindingCount **0**

## Objective invocation audit (durable ledger markers, read-only)
- `run.claim` present; `slots/` = `openai-1.slot`, `openai-1.spawn`, `openai-1.outcome.json`, `anthropic-1.slot`, `anthropic-1.spawn`, `anthropic-1.outcome.json`.
- **`.spawn` markers = 2** (openai 1 + anthropic 1) ⇒ objective real invocation count = **2**, matching the authorized budget. NO over-invocation. Re-running the same authorization id would be claim-denied (0 additional spawn).

## FAIL determination
PASS requires BOTH providers `invocation_completed` + `exitClassification: succeeded` + `strictResult: true` + `repositoryUnchanged: true`, cleanup complete, sanitizer 0, no descendant leak, total invocationCount ≤ 2. Observed: both `nonzero_exit` + `strictResult: false`. Therefore **FAIL**. (This is NOT a repository-mutation/security_halt case — Codex left the synthetic repo unchanged and Claude still ran; both simply exited nonzero without a strict result.)

Security-positive facts: both `repositoryUnchanged: true`; both `sanitizerFindingCount: 0`; descendant leak 0; `cleanup: complete`; evidence holds only hashes/counts. Both providers failed FAST (~3.9s / ~1.4s) — consistent with an external smoke-config/model cause (e.g. the Codex CLI not accepting the configured model or the output-schema/args, and Claude rejecting the model/args before any streamed frame). These are external-state/config causes, NOT adapter product-code defects (the adapters + all fake/security fixtures pass). Resolving them requires a smoke-config revision AND a NEW explicit provider-invocation authorization; NO re-call and NO automatic correction is performed here.

## Isolation / preservation
main unchanged `38132a818…` (clean); M2 `d365696…` (clean); base `f05ea40…` (clean); this worktree tracked-clean; 0 remotes; product code UNCHANGED; dependencies UNCHANGED; no push/PR/merge/deploy/external action. The ledger grant/claim/slot/spawn/outcome records are PRESERVED (not deleted or modified). The prior M2 over-invocation record is preserved and unweakened. M3 NOT started. No new provider-invocation authorization exists.

## Verdict: FAIL — no recall, no integration, no correction started. A safe next user decision is either (a) authorize a smoke-config revision + a NEW authorization id for a future retry, or (b) treat the smoke as blocked pending investigation of the external Codex/Claude model+config. main integration remains a separate explicit-authorization decision and is NOT recommended while the real smoke has not passed.

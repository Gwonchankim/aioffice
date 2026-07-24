# CORR-M2-SMOKE-GATE-002 — Real-Smoke Authorization Request

The deferred provider smoke runtime/authorization contract is corrected and independently validated (fake/security/regression + full E2E/audit, 0 real provider calls). This document REQUESTS — it does not assume — the two separate explicit user authorizations required before any real provider invocation or main integration.

## What is being requested
1. **Real-provider smoke authorization** for **exactly one Codex invocation + one Claude invocation** (2 total), against the script-created synthetic public repository only, under the corrected harness. This is a NEW authorization; no existing authorization id is reused.
2. **(separately) main-integration authorization** for merging `corr/m2-smoke-gate-finalization` (this is a distinct decision and is NOT part of the smoke authorization).

## Operator procedure once (1) is granted (run in the P4 isolated worker)
```powershell
# 1. one-time grant (0 provider calls): binds a fresh authorization id + operator-selected models + executable fingerprints
$env:ORION_PROVIDER_AUTHORIZATION_ID = '<fresh-unique-authorization-id>'
$env:ORION_CODEX_EXECUTABLE  = '<trusted absolute native codex.exe>'
$env:ORION_CLAUDE_EXECUTABLE = '<trusted absolute native claude.exe>'
$env:ORION_CODEX_SMOKE_MODEL  = '<operator-selected currently-valid Codex model>'   # e.g. gpt-5.6-sol, if the operator confirms availability
# ORION_CLAUDE_SMOKE_MODEL optional; defaults to 'sonnet'
pnpm test:providers grant     # prints a sanitized grant envelope with authorizationIdHash only

# 2. the one-time run (exactly 1 Codex + 1 Claude); the ledger + fingerprint binding guarantee no re-invocation
$env:ORION_REAL_PROVIDER_TESTS = '1'
pnpm test:providers
Remove-Item Env:ORION_REAL_PROVIDER_TESTS
```

## Guarantees enforced by the corrected harness
- The run model comes ONLY from the grant; a differing run-time model env is a 0-spawn conflict.
- Each executable is re-fingerprinted immediately before its spawn; a mismatch is 0 spawn.
- A durable spawn-attempt marker is written before each spawn; a crash/rerun of the same authorization id performs 0 further spawns.
- Any repository change halts the remaining provider with 0 spawn.
- The only output is one sanitized envelope with `reachedStage` + `reservedCount`/`spawnAttemptCount`/`invocationCount` + `cleanup`; no prompt, provider output, path, credential, identity, or environment is recorded.

## Explicit boundaries
- No real provider/model call, no grant, and no `ORION_REAL_PROVIDER_TESTS` have been executed by this correction.
- The prior over-invocation record (`unknown, worst case ≈ 6`) is preserved and unweakened.
- Neither authorization is assumed. This correction STOPS at `CORR_M2_SMOKE_GATE_READY_FOR_AUTHORIZATION`.

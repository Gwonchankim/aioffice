# CORR-M2-SMOKE-CONFIG-003 — New Real-Smoke Authorization Request (draft)

The smoke configuration/code defects the prior failed real smoke exposed are corrected and independently validated (fake/security/regression + full E2E/audit; 0 real provider calls). This document REQUESTS — it does not assume — a NEW explicit user authorization for a future real smoke. Nothing here is executed.

## What is requested
1. A **NEW real-provider smoke authorization** for **exactly one Codex invocation + one Claude invocation** (2 total), against the script-created synthetic public repository only, under the corrected harness.
2. A **NEW authorization id** (the prior `M2-SMOKE-20260724-001` is SPENT and MUST NOT be reused). The corrected policy (schema/prompt/argv v3) makes any prior grant fail `policy_binding_mismatch` (0 spawn) by construction, so a fresh grant with a fresh id is required.
3. (separately) **main-integration authorization** for the M2 correction chain remains a distinct decision and is NOT part of this smoke request.

## Why a new smoke may now succeed where the last failed
- Codex: the structured-output JSON Schema now provides `items` on every array (OpenAI structured-outputs requirement), so the schema should no longer be rejected.
- Claude: `--mcp-config` now uses the official empty shape `{"mcpServers":{}}` under `--strict-mcp-config`, so MCP validation should no longer fail pre-frame.
- On any residual failure, the run now reports a sanitized `diagnostic` enum (e.g. `INVALID_OUTPUT_SCHEMA`, `INVALID_MCP_CONFIG`, `MODEL_UNAVAILABLE`) without retaining raw text, making the next decision precise.

## Operator procedure once authorized (in one isolated P4 worker; exactly once)
```powershell
$env:ORION_PROVIDER_AUTHORIZATION_ID = '<fresh-unique-authorization-id>'   # NOT M2-SMOKE-20260724-001
$env:ORION_CODEX_EXECUTABLE  = '<trusted absolute native codex.exe>'
$env:ORION_CLAUDE_EXECUTABLE = '<trusted absolute native claude.exe>'
$env:ORION_CODEX_SMOKE_MODEL = 'gpt-5.6-sol'                               # supported model; operator-selected
# ORION_CLAUDE_SMOKE_MODEL optional; defaults to 'sonnet'
pnpm test:providers grant     # 0 provider calls; prints a sanitized grant envelope (authorizationIdHash only)

$env:ORION_REAL_PROVIDER_TESTS = '1'
pnpm test:providers           # exactly 1 Codex + 1 Claude; the ledger prevents re-invocation
Remove-Item Env:ORION_REAL_PROVIDER_TESTS
```

## Boundaries
- No real provider/model call, grant, or `ORION_REAL_PROVIDER_TESTS` has been executed by this correction.
- The spent authorization + prior failure evidence + the over-invocation record are preserved and unweakened.
- Neither authorization is assumed. This correction STOPS at `CORR_M2_SMOKE_CONFIG_READY_FOR_NEW_AUTHORIZATION`.

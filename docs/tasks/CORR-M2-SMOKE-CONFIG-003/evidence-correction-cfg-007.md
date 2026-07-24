# CFG-007 — Evidence Correction (additive supersession; prior evidence preserved)

This note SUPERSEDES a specific framing in the prior `M2-REAL-PROVIDER-SMOKE-001` validation report. It does NOT modify or delete that report or any other prior evidence, and it does NOT touch the spent `M2-SMOKE-20260724-001` ledger records.

## Superseded framing
- The prior report described both providers' `nonzero_exit` failures as "consistent with an external smoke-config/model cause … not adapter product-code defects" and stated the external cause "was NOT re-tested".

## Corrected framing
- The failure could NOT be confirmed as an external-state-only problem. Read-only inspection of the harness at the failing product SHA found two real smoke configuration/code defects:
  1. **Missing array `items` in the structured-output JSON Schema.** `providerSmokeResultSchema`'s `findings/artifacts/changes/tests/risks` were bare `{type:'array'}` with no `items`. OpenAI structured outputs REQUIRE `items` on every array, so Codex plausibly rejected the schema (`INVALID_OUTPUT_SCHEMA`), consistent with the observed fast `nonzero_exit` after `run.started`.
  2. **Non-official Claude empty MCP config.** The Claude argv passed `--mcp-config '{}'`, which is not the official empty-configuration shape `{"mcpServers":{}}`; under `--strict-mcp-config` this plausibly caused Claude to fail before emitting any frame (`INVALID_MCP_CONFIG`), consistent with the observed ~1.4s `nonzero_exit` with 0 parsed frames.
- Both are real smoke config/code defects in the harness, fixed by CORR-M2-SMOKE-CONFIG-003 (CFG-001, CFG-003). A precise root cause still cannot be asserted as definite without a NEW authorized real smoke (prohibited here); the above are grounded, corrected hypotheses, not confirmed certainties.
- **`gpt-5.6-sol` is NOT invalid or fictional.** It is a supported model and the operator's selected Codex model; the earlier characterizations that leaned toward "likely invalid/fictional" are withdrawn. The correct historical rationale for removing the hardcoded default remains: authorization-binding, unverified per-account availability, and no auto-change on failure.

## Authorization / non-reuse
- The prior authorization `M2-SMOKE-20260724-001` is SPENT (`run.claim` present; 2 durable `.spawn` markers) and is NOT reused. Its ledger records are preserved unchanged.
- A future real smoke requires BOTH this correction (a new schema/prompt/argv policy) AND a NEW explicit user authorization with a NEW authorization id. The policy hashes (schema/prompt/argv v3) changed, so any prior grant fails `policy_binding_mismatch` (0 spawn) by construction.

## SHA distinction
- Validated product SHA and final evidence HEAD are recorded distinctly in `completion-report.md`.
- The prior over-invocation record (`unknown, worst case ≈ 6`, from the earlier M2 deviation) is preserved and unweakened.

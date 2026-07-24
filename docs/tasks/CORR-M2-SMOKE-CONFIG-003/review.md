# CORR-M2-SMOKE-CONFIG-003 — Independent Review (P2)

WORKFLOW_MODE: controller_isolated. Independent reviewers ran in isolated `task` worker contexts distinct from the planner/implementer.

## Round 1
- worker id: `11-CFG-P2-Review` | agent: architect (bundled) | model label: openai-codex/gpt-5.6-sol | ~6m56s. Input: plan.md rev1 + source cross-check; 0 real provider calls (CONFIRMED).
- verdict: **CHANGES_REQUESTED**.
  - BLOCKER: `maxItems:0` is NOT cross-provider safe — Anthropic structured outputs support only array `minItems` (0/1) and reject `maxItems`; using it would make Claude reject the schema (reproducing the failure). → RB1: drop `maxItems`, keep real `items`, enforce emptiness via a smoke-local `smokeResultIsStrict` validator.
  - MAJOR: terminal failure frames (codex turn.failed/error, claude error result) could still pass on exit 0 + a valid result. → RB2: `terminalFailure` gates strict success.
  - MAJOR: diagnostic priority/patterns unspecified; INVALID_ARGUMENT + PROVIDER_INTERNAL_ERROR lacked explicit cases; outcome-ledger capture not asserted. → RB3: frozen 10-code priority table + bounded input + outcome payload capture.
  - MAJOR: legacy-policy regression not proven pre-mutation. → RB4: frozen gen-2 fixture; assert all 3 hashes differ + policy_binding_mismatch before any ledger mutation.
  - MINOR: prompt "forbid external tools" conflicts with permitted Read/Glob/Grep. → RB5: positive read-only allowlist.
  - MINOR: undefined negative fixtures; item-24 must be a read-only preservation audit (no spent-authId fixture). → RB6.
  - Confirmed: shared normalizer must stay unchanged (existing codex error→unknown assertion preserved); `gpt-5.6-sol` is a supported model (not fictional); 0 real provider calls.
- resolution: plan rev2 (RB1–RB6 + adopted test-migration list).

## Round 2 (confirmation)
- (recorded below)

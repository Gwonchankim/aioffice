# CORR-M2-SMOKE-GATE-002 — Independent Review (P2)

- mode: controller_isolated. Reviewer = isolated `task` worker, distinct context from the planner/implementer.

## Round 1
- worker id: `5-SMG-P2-Review` | agent: architect (bundled) | model label: openai-codex/gpt-5.6-sol | ~5m41s. Input: plan.md v1 + read-only source cross-check; 0 real provider calls (CONFIRMED).
- verdict: **CHANGES_REQUESTED** (BLOCK). SMG-008 and SMG-009 rated COVERED; SMG-001..007, 010 PARTIAL. Blockers folded into plan rev2 (RB1–RB9):
  1. Recompute+enforce grant policy bindings at run (drift). → RB1 canonical `computeLivePolicy()` re-projection + `policy_binding_mismatch`.
  2. Preserve partial evidence + monotonic counts. → RB2 state-machine accumulator; snapshot-unknown fail-closed; `max(inMemoryLowerBound,…)`.
  3. Clean partially-prepared resources. → RB3 outer `ResourceTracker` above `prepareRepository`.
  4. Just-in-time per-provider executable recheck (5-min swap window). → RB4.
  5. Injectable deferred + CLI seams. → RB5 `runDeferredProviderSmoke(overrides)` + `runSmokeCli(argv, deps)`.
  6. Grant-mode output ambiguity. → RB6 separate sanitized grant envelope.
  7. Strict per-field grant validators. → RB7 recursive exact key sets + formats + table-driven tamper tests.
  8. Test-1 must require conflict rejection. → RB8 absent/equal/different, different ⇒ `MODEL_BINDING_CONFLICT` 0 spawn.
  9. cleanup-incomplete must be a non-pass. → RB9 `isSmokePass` requires `cleanup==='complete'`.
- Adopted the full omitted-test-migration list verbatim (ledger v2 + smoke v2 fixtures/argv/counts/cleanup/binding).
- `gpt-5.6-sol` catalog grounding confirmed by the reviewer against `packages/agent-catalog/src/seed-skeletons.ts` (used as several profiles' primary/default model) — supports the SMG-009 additive supersession.

## Round 2
- worker id: `6-SMG-P2-Confirm` | agent: critic (bundled) | model label: openai-codex/gpt-5.6-sol | ~5m6s. Input: plan.md rev2 + source cross-check; 0 real provider calls (CONFIRMED).
- verdict: **CHANGES_REQUESTED** with **7 of 9 blockers CLOSED** (RB1–RB5, RB8, RB9); SMG-008/SMG-009/fake-only/zero-real-call "approved as written". 2 narrow items remained → resolved in plan rev3:
  - RB6: grant output carried raw `authorizationId`. → DA: emit `authorizationIdHash` (sha256) only; CLI test asserts no raw id/path/token/identity.
  - RB7: option validators accepted in-range `timeoutMs`/`maxBudgetUsd` vs the fixed constants. → DB: require exact `timeoutMs===300000` and `maxBudgetUsd===0.5`; in-range tamper (299999, 0.25) fails closed.

## Round 3 (final confirmation)
- worker id: `7-SMG-P2-Final` | agent: architect (bundled) | model label: openai-codex/gpt-5.6-sol | ~1m6s. Input: plan.md rev3 + constant/contract cross-check; 0 real provider calls (CONFIRMED).
- verdict: **APPROVED**. RB6 + RB7 CLOSED; DA/DB introduce no new contradiction; the 7 prior RBs + SMG-008/009 intact; 0 real provider calls. Findings: none.
- non-blocking P3 notes: (a) doc pass describes BOTH sanitized output shapes (grant + run) while keeping the no-identity/no-path contract; (b) the DA negative test uses explicit sentinel values (auth id/path/token/email/org) + exact-key + exact-sha256 assertions rather than a broad regex.

## P2 GATE RESULT: APPROVED
Independent isolated-worker review across 3 rounds (workers 5-SMG-P2-Review, 6-SMG-P2-Confirm, 7-SMG-P2-Final; distinct contexts). Final APPROVED on plan.md rev3. P3 implementation authorized within the approved plan scope; NO real provider call, NO main integration.

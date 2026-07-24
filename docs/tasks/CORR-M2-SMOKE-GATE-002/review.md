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
- (recorded below after the confirmation review of rev2)

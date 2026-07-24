# CORR-M2-RUNTIME-CONTRACT-001 — Independent Review (P2)

- mode: controller_isolated. Reviewer = isolated `task` worker, distinct context from the planner/implementer.

## Round 1
- worker id: `0-P2-Review` | agent: architect (bundled) | model label: openai-codex/gpt-5.6-sol | duration ~9m35s.
- input: plan.md rev1 + read-only source inspection; 0 real provider calls (reviewer CONFIRMED).
- verdict: **CHANGES_REQUESTED** (architectural BLOCK). Grounded against Codex `rust-v0.145.0` `exec_events.rs` and Claude 2.1.156 official docs (sources cited in worker output).

### Blockers and rev2 resolution
1. CORR-M2-003 — Codex modeled with obsolete `item_type` + nonexistent command `duration_ms`. → rev2 uses `item.id` + discriminator `item.type`; agent_message JSON-text result candidate; command_execution status without duration; usage `cached_input_tokens`; **run.tool.completed.durationMs derived adapter-side** (contract requires it; frame lacks it).
2. CORR-M2-007 — Codex model optional/ambient. → rev2 makes an operator-selected model MANDATORY in every provider grant; exact value passed in argv; immutable typed options.
3. CORR-M2-001 — Windows ledger transaction under-specified. → rev2 adopts immutable grant + exclusive per-slot marker files (`wx` atomic create; crash leaves marker = used; cumulative = marker count; no counter rewrite / global lock / lost-update). Corruption + path-containment fail-closed policies specified.
4. CORR-M2-004/006 — single-discriminant normalizer drops multi-block/terminal semantics. → rev2 normalizer returns COMPOSITE ordered items + optional result + metadata; production mapper emits all events per frame via existing `createEvents` (no parser-contract change); result+usage from one Claude frame handled.
5. CORR-M2-002 — evidence shape/cumulative semantics incomplete. → rev2 defines one sanitized envelope with an exhaustive `reachedStage` enum + locked cumulative `invocationCount` on every identifiable-authorization path; `[]` masking removed.

### Major findings resolved in rev2
- Ledger path override containment (reject workspace/worktree/`.orion`/`.gjc`/project + symlink/reparse) → specified.
- Concrete grant issuance workflow + immutable typed bounded options → specified (0-provider-call grant API/command).
- Enumerated existing-test migrations + new failure/concurrency coverage → added to plan (“Explicit existing-test migrations” + test plan).

### Existing-test migrations flagged (adopted verbatim into plan)
- fixtures test `stdout.toContain('"result"')` → provider-specific (codex agent_message JSON / claude structured_output); drop codex usage durationMs.
- preserve production argv-shape tests + M2-FIX exact spawnCapture argv (production command construction unchanged).
- smoke test: drop fictional CODEX_SMOKE_MODEL; grant-derived argv; inline serialized claude schema; real cumulative count/reachedStage.
- new dedicated tests for normalizer + ledger (80% coverage targets).

## Round 2
- worker id: `1-P2-Rereview` | agent: critic (bundled) | model label: openai-codex/gpt-5.6-sol | duration ~9m53s. Input: plan.md rev2 + source cross-check; 0 real provider calls (CONFIRMED).
- verdict: **CHANGES_REQUESTED**. Remaining issues → resolved in plan.md rev3 (see plan “Rev3 — exact resolution”):
  1. Composite identity used `#` which `providerEventIdentitySchema` forbids; Claude `message.id` can repeat per turn. → rev3 R1: colon-only IDs, frame identity = top-level `uuid`, distinct codex start/completion ids.
  2. Authoritative wire incomplete (Codex `declined` status; Claude `retry_delay_ms`/`uuid`; unknown-block tolerance). → rev3 R2.
  3. Duration state could be corrupted by pre-dedup `mapFrame`. → rev3 R3: state mutated only inside accepted `createEvents`.
  4. `maxInvocations>1` + just-in-time reservation didn't guarantee one-time authId. → rev3 R4: run-claim (`wx`) + reserve-all-before-first-spawn + maxInvocations=1.
  5. Two output shapes / ambiguous cumulative count. → rev3 R6: single `{schemaVersion,providers[]}` envelope, required `invocationCount`=fresh marker count, never `[]`.
  6. Grant schema/issuance + Windows containment underspecified. → rev3 R5: strict grant JSON, `grant` CLI mode, `assertSafeLedgerRoot` algorithm.
  7. Missing migrations/docs (both model constants, extra doc files). → rev3 R7.

## Round 3
- worker id: `2-P2-Confirm` | agent: architect (bundled) | model label: openai-codex/gpt-5.6-sol | duration ~5m45s. Input: plan.md rev3 + contract cross-check; 0 real provider calls (CONFIRMED).
- verdict: **CHANGES_REQUESTED** with R3 + R7 RESOLVED; 4 narrow contract refinements remained → adopted verbatim as plan.md rev4 (D1–D5):
  1. claim-denied `invocationCount` must reflect real durable markers, not forced 0. → D1: always fresh marker count.
  2. raw identity components unbounded/unvalidated. → D2: `composeFrameIdentity` validates the final composite vs the identity regex; invalid ⇒ invalidMapping.
  3. identifier-less `turn.completed` could double-emit. → D3: literal `turn.completed` / `result:<uuid>` dedup identity.
  4. absent Claude `retry_delay_ms` had no mapping to required `delayMs`. → D4: retry only when attempt+delay present, else unknown.
  5. grant equality included generated `createdAt`. → D5: semantic-projection equality excluding createdAt.

## Round 4 (final confirmation)
- worker id: `3-P2-Final` | agent: critic (bundled) | model label: openai-codex/gpt-5.6-sol | duration ~3m23s. Input: plan.md rev4 + contract/parser cross-check; 0 real provider calls (CONFIRMED).
- verdict: **APPROVED**. All four round-3 blockers CLOSED (D1 count, D2 identity validation, D3 terminal dedup, D4 retry-delay); dedup ordering (`acceptIdentity` before `result`/`createEvents`) confirmed; no new contradiction; R1–R7 + D1–D5 form an actionable path; fake/security/regression-only with 0 real provider calls. "Required Changes: None."
- non-blocking notes for P3: (a) `providerEventIdentitySchema` is module-private — the D2 helper hardcodes the identical regex and relies on `normalizedAdapterEventSchema.parse` tests as the drift check; (b) retain safe-integer guards incl. `run.retry.payload.attempt` max 3.

## P2 GATE RESULT: APPROVED
Independent isolated-worker review across 4 rounds (workers 0-P2-Review, 1-P2-Rereview, 2-P2-Confirm, 3-P2-Final; distinct contexts). Final APPROVED on plan.md rev4. P3 implementation authorized within the approved plan scope; NO real provider call, NO main integration.

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
- (recorded below after the re-review of rev2)

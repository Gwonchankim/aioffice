# CORR-M2-SMOKE-CONFIG-003 — Implementation Log (P3)

- WORKFLOW_MODE: controller_isolated. Implementer = this controller context; P4 VALIDATE runs in a distinct isolated worker.
- branch/worktree: `corr/m2-smoke-config-compatibility` @ `…/aioffice-worktrees/corr-m2-smoke-config-compatibility`; base `corr/m2-smoke-gate-finalization @ ad418a3` (validated product ancestor `e684fdc`).
- **0 real Codex/Claude/model calls; 0 grant; no ORION_REAL_PROVIDER_TESTS; no new/reused authorization id.** The spent `M2-SMOKE-20260724-001` ledger (2 `.spawn` markers) and prior `M2-REAL-PROVIDER-SMOKE-001` evidence are preserved untouched.

## Commits (local only)
- `895aeca` P1 plan · `8b82332` rev2 (RB1-RB6) + P2r1 · `1f1a1d3` rev3 (RB5) + P2r2 · `cf58889` P2 APPROVED (r3)
- `b28683a` implementation (CFG-001..008) · `bd6cb6f` docs + CFG-007 evidence correction

## Files changed
- `scripts/provider-smoke.ts`:
  - **CFG-001** `providerSmokeResultSchema` → strict cross-provider subset: real `items` on every array (incl. nested `changes.files`), `additionalProperties:false` + `required`=all-properties on every object, nullable via `type:['string','null']`, `status` enum `['succeeded']`, NO `maxItems`/`minLength` (Anthropic rejects array constraints). New authoritative `smokeResultIsStrict()` (Zod `runResultSchema` pass AND status succeeded AND all five arrays empty); `inspectProviderFrame` uses it.
  - **CFG-002/RB5** provider-neutral `smokePrompt` (read-only inspection + explicit prohibitions + exact 8-field output contract; no provider-specific tool names).
  - **CFG-003** `CLAUDE_EMPTY_MCP_CONFIG = JSON.stringify({mcpServers:{}})`; `claudeSmokeArgv` uses it (replacing bare `'{}'`), keeping `--strict-mcp-config`.
  - **CFG-004** `ProviderDiagnosticCode` enum + frozen priority table + `classifyProviderDiagnostic()` (≤16 KiB bounded, first-match-wins, unmatched→UNKNOWN); transient bounded stderr buffer in `consumeSanitizerStream` (classified then discarded); `ProviderSmokeEvidence.diagnostic?`; persisted via `sanitizedOutcome` to the outcome ledger. No raw stderr/stdout/message/path/identity retained.
  - **CFG-005/006** `captureFailureFrame` handles Codex `error`/`turn.failed` and Claude error-result frames → `terminalFailure` + `frameDiagnostic`; final `strictResult = hasStrictResult && !terminalFailure` (a valid result on exit 0 with a terminal-failure frame is NOT success). Claude pre-frame nonzero keeps 0 events + stderr diagnostic + no retry.
  - **CFG-008** `ARGV_POLICY_VERSION` 2→3; schema/prompt/argv changes ⇒ `computeLivePolicy()` differs ⇒ any prior grant fails `policy_binding_mismatch`.
  - The shared normalizer (`apps/server/src/providers/provider-frame-normalization.ts`) is UNCHANGED (codex `error`/`turn.failed` stay `unknownFrame`); handling is smoke-local.
- `scripts/test/provider-smoke.test.ts`: SMG-008 claude argv `'{}'`→`{"mcpServers":{}}`; `InMemoryLedger` captures the full outcome payload; new CFG tests (schema structure + `smokeResultIsStrict`; MCP exact + no bare `{}`; 10-code diagnostic taxonomy + precedence + 16 KiB bounds + empty→undefined; terminal-failure-on-exit-0; Claude pre-frame + no-raw; per-provider argv/prompt contract; legacy generation-2 grant rejection with 0 ledger mutation; diagnostic persisted to outcome).
- Docs: `README.md`, `docs/orion/orion-console-operations-recovery-runbook.md`, `docs/orion/orion-console-test-evaluation-plan.md` (`--mcp-config {"mcpServers":{}}` + diagnostic note); NEW `docs/tasks/CORR-M2-SMOKE-CONFIG-003/evidence-correction-cfg-007.md`.

## CFG resolution
CFG-001 strict schema + local empty-result validator; CFG-002 aligned neutral prompt; CFG-003 official empty MCP config; CFG-004 sanitized diagnostic taxonomy (no raw); CFG-005 Codex JSONL failure events; CFG-006 Claude pre-frame; CFG-007 additive evidence correction (gpt-5.6-sol NOT invalid; two real config/code defects; prior authorization spent, not reused); CFG-008 policy v3 + hash changes so prior grants fail closed. P2 RB1–RB6 + rev3 RB5 implemented.

## P3 self-verification (fake/security/regression; 0 real calls)
`format:check` 0 · `lint` 0 · `typecheck` 0 · `test:coverage` 0 (**244 tests**, 30 files; 7 targets ≥80%: contracts 85.62, apps/server 87.66, scripts 87.72, web 100, orchestration 92.19, agent-catalog 100, test-fixtures 100; provider-smoke.ts 83.18 per-file) · `build` 0 · `smoke:workspace-import` 0 · `git diff --check` clean · tree clean. Shared normalizer + adapter suites unchanged and green (normalization 14, adapters 58, security 9). Spent ledger untouched (2 `.spawn` markers). SMG-010-style E2E/axe/console/audit/OpenAPI/tracked-dist/no-`.only`.`.skip` gates are independently reproduced in P4.

Defect handling: one expected test migration (SMG-008 argv). No plan defects; no loop-back.

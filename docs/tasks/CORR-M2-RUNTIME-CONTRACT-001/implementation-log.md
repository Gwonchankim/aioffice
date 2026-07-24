# CORR-M2-RUNTIME-CONTRACT-001 — Implementation Log (P3)

- WORKFLOW_MODE: controller_isolated. Implementer = this controller context; P4 VALIDATE runs in a distinct isolated worker.
- branch/worktree: `corr/m2-runtime-contract` @ `C:\Users\hanmir_MSO\Desktop\aioffice-worktrees\corr-m2-runtime-contract`; base `m2/provider-adapters @ d365696`.
- **0 real Codex/Claude/model invocations** throughout. `ORION_REAL_PROVIDER_TESTS` never set; `pnpm test:providers`/`codex exec`/`claude -p` never run. main untouched. M2 worktree untouched. M2 evidence and the over-invocation record preserved.

## Commits (local only; no push/PR)
- `aafb2d7` P1 plan · `b82122a` rev2+P2r1 · `432e09e` rev3+P2r2 · `d1fb19b` rev4+P2r3 · `7643df9` P2 APPROVED
- `64ee0ee` shared composite normalizer + real Codex/Claude wire fixtures (CORR-M2-003/004/006)
- `0968318` normalizer unit tests
- `26372bc` persistent one-time authorization ledger (CORR-M2-001)
- `42343d1` smoke → ledger + shared normalizer + schema-string + mandatory model + reachedStage envelope (CORR-M2-002/005/006/007)
- `187aaba` docs (CORR-M2-007/R7)
- `3f9efbe` smoke coverage tests + cast cleanup
- `1097461` prettier formatting

## Files changed
- NEW `apps/server/src/providers/provider-frame-normalization.ts` — pure composite normalizer (codex/claude → ordered items + result + metadata; `composeFrameIdentity` validates every id against the contract regex).
- `apps/server/src/providers/adapter.ts` — `AdapterMapperContext.now`; `ToolTimer`; shared `buildProviderFrameMapping` (redaction + `runResultSchema` validation + create-time-only tool-duration derivation).
- `apps/server/src/providers/codex-adapter.ts`, `claude-adapter.ts` — mappers now delegate to the normalizer + shared builder (production argv unchanged).
- `apps/server/src/main.ts` — export the normalizer from `@orion/server` (shared with the smoke).
- `packages/test-fixtures/src/provider-process.ts` — real Codex (`item.id`/`item.type`/agent_message-JSON result/`cached_input_tokens`) + Claude (`message.content[]` blocks / `structured_output` / result-usage) frames; Claude spawn-capture argv parity.
- NEW `scripts/provider-authorization-ledger.ts` — immutable grant + `run.claim` (`wx`) + per-slot markers (`wx`); `assertSafeLedgerRoot` containment; fresh cumulative `usage`.
- `scripts/provider-smoke.ts` — shared-normalizer inspector; ledger orchestration (claim + reserve-all-before-first-spawn); Codex `--output-schema <file>` / Claude `--json-schema <serialized string>`; mandatory operator-selected model; single `{schemaVersion,providers[]}` `reachedStage` envelope; `grant` CLI mode; **no `[]` masking**.
- Tests: NEW `provider-frame-normalization.test.ts` (14), NEW `provider-authorization-ledger.test.ts` (8), rewritten `provider-smoke.test.ts` (12), migrated `provider-process.test.ts` assertions.
- Docs: `README.md`, `AGENTS.md`, `docs/orion/orion-console-operations-recovery-runbook.md`, `docs/orion/orion-console-test-evaluation-plan.md`.

## CORR-M2 item resolution
- **001** durable one-time ledger: run.claim + per-slot `wx` markers; crash/ambiguous ⇒ slot stays used; rerun same authId ⇒ 0 spawn; cumulative = live marker count.
- **002** atomic reservation BEFORE spawn; `[]` masking removed; every path emits the envelope with real cumulative `invocationCount` + `reachedStage`.
- **003** Codex `item.id`/`item.type`/agent_message (+ JSON-text result), `cached_input_tokens`, `declined→failed`, no fabricated duration — production parser AND smoke inspector share the normalizer.
- **004** Claude `structured_output`, `message.content[]` text/tool_use blocks, `user` tool_result; fixtures aligned.
- **005** Claude `--json-schema` receives the serialized JSON string; Codex keeps the schema file path.
- **006** single shared normalization (`@orion/server` export) used by both adapters and the smoke ⇒ no drift.
- **007** model mandatory + operator-selected, bound with immutable options to the authorization grant; fictional `gpt-5.6-sol` removed.
- P2 rev3/rev4 refinements (R1–R7, D1–D5) implemented: regex-safe colon-only identities validated at the boundary; create-time-only duration state; one-shot run claim; single evidence envelope; semantic-projection grant idempotence.

## P3 self-verification (fake/security/regression only; 0 real calls)
Run in the correction worktree after `pnpm install --frozen-lockfile`:
- `pnpm run format:check` → exit 0 (all files prettier-clean)
- `pnpm run lint` → exit 0
- `pnpm run typecheck` → exit 0
- `pnpm run test:coverage` → exit 0; **220 tests**, 30 files; 7 coverage targets ≥80% (contracts 85.62, apps/server 87.66, scripts 86.16, web 100, orchestration 92.19, agent-catalog 100, test-fixtures 100). New files: normalizer 96.93%, ledger 92.05%, smoke 77.79% (its uncovered lines are the real-execution wiring that cannot run without real provider/git calls; the `scripts` aggregate target passes).
- `pnpm run build` → exit 0
- `pnpm run smoke:workspace-import` → exit 0
- `git diff --check` → clean
- No `ORION_REAL_PROVIDER_TESTS`; no `pnpm test:providers`; 0 real provider/model calls.

Defect handling: one implementation defect (defaulted fake-ledger constructor swallowing `undefined`) fixed in P3; one type defect (`exactOptionalPropertyTypes` on `pruneUsage`) fixed in P3. No plan defects; no P1/P2 loop-back needed.

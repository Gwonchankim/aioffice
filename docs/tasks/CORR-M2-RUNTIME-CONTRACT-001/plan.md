# CORR-M2-RUNTIME-CONTRACT-001 — Plan (P1)

- task: CORR-M2-RUNTIME-CONTRACT-001 | classification: internal
- WORKFLOW_MODE: **controller_isolated** (planner/implementer = this controller context; P2 REVIEW and P4 VALIDATE run in distinct isolated `task` worker contexts with recorded worker IDs and artifact hashes).
- correction base: `m2/provider-adapters @ d365696be7fde23fbd3747280011eec1f7c1bd7a`
- correction branch/worktree: `corr/m2-runtime-contract` @ `C:\Users\hanmir_MSO\Desktop\aioffice-worktrees\corr-m2-runtime-contract`
- goal: fix the M2 provider real-smoke runtime/authorization/parser contract so a FUTURE separately-authorized smoke runs safely and correctly. **0 real Codex/Claude/model invocations** in this correction.

## State verification (read-only, PASS)
- main == `38132a818ca713cd29bb77bb5546ca6144905702`, tracked-clean.
- M2 evidence HEAD == `d365696be7fde23fbd3747280011eec1f7c1bd7a`, tracked-clean; product content `461d19c1…` is an ancestor (in history).
- 0 remotes. `.orion` and `.gjc` git-ignored. corr branch/worktree freshly created from d365696; other preserved branches/worktrees intact.
- Baseline `pnpm install --frozen-lockfile` (exit 0) + `pnpm test` (exit 0, all projects green).

## PREFLIGHT capability probe (read-only `--help`/`--version` only; NO model prompt; 0 provider calls)
- `codex --version` → `codex-cli 0.145.0`; `claude --version` → `2.1.156 (Claude Code)`.
- `codex exec --help`: `--json` (JSONL), `--output-schema <FILE>` (schema is a FILE path), `-m/--model <MODEL>` (no enumerated model list; no `models` subcommand), `--sandbox read-only`, `--cd <DIR>`. No model list is available read-only ⇒ the model must be operator-selected at authorization time (not a hardcoded constant). Prior `gpt-5.6-sol` is a fictional Orion-doc model and is NOT a valid installed model.
- `claude --help`: `--json-schema <schema>` documents an **inline JSON schema STRING** (`Example: {"type":"object",...}`), NOT a file path ⇒ smoke bug confirmed. `--permission-mode` includes `dontAsk`; `--effort` includes `low`; `--model` accepts the `sonnet` alias (valid). `--output-format stream-json` present.

## Correction scope & design (CORR-M2-001..007)

### CORR-M2-006 — single shared normalization (foundation)
New pure module `apps/server/src/providers/provider-frame-normalization.ts` exporting `normalizeCodexFrame(frame)` and `normalizeClaudeFrame(frame)` → discriminated `NormalizedProviderFrame`:
`session | output | tool.started | tool.completed | usage | retry | result(candidate:unknown) | metadata(cliVersion?/model?/usage?/costUsd?) | unknown | invalid(finalSchema?)`.
Pure classification only (no redaction, no schema validation). Consumers:
- Production `mapCodexFrame`/`mapClaudeFrame` (adapters) become thin wrappers that call the normalizer, then apply redaction + build `ProviderFrameMapping` (validate `result` candidate via `runResultSchema`).
- Smoke inspector calls the SAME normalizer for event counts / session hash / strict-result / metadata.
Exported from `@orion/server` (`main.ts`) so `scripts/provider-smoke.ts` imports it → drift eliminated by construction.

### CORR-M2-003 — official Codex `codex exec --json` frames
Real frame identity/type live on the `item` object, not the top-level frame:
- `item.started` / `item.completed` carry `item = { id, item_type, ... }` (id at `item.id`; discriminator `item.item_type`).
- `agent_message` item: `{ id, item_type:'agent_message', text }`. With `--output-schema`, the final structured RunResult is the terminal `agent_message.text` (JSON string) → normalizer parses it as the result candidate.
- `command_execution` item: `{ id, item_type, command, status, duration_ms }`.
- `thread.started`→session; `turn.completed`→usage; `system.api_retry`→retry.
Fixtures (`packages/test-fixtures/src/provider-process.ts`) and the smoke inspector updated to this structure in lockstep.

### CORR-M2-004 — Claude official `structured_output` + real stream structure
- `system`/`init` → session (top-level `session_id`).
- `assistant` message: text lives in `message.content[]` blocks (`{type:'text',text}`); tool calls are `{type:'tool_use',id,name,input}` content blocks (NOT a top-level `tool_use` frame).
- `user` message: `tool_result` arrives as `{type:'tool_result',tool_use_id,...}` content blocks.
- `result` message: strict object is `structured_output` (validated), `result` is the text; `usage`/`total_cost_usd` for usage/cost.
Fake fixtures aligned to this real structure.

### CORR-M2-005 — Claude schema passing (smoke)
Smoke passes a serialized JSON schema STRING to `--json-schema` (production adapter already does via `schema.serialized`). Codex keeps the schema FILE path for `--output-schema`. Smoke argv split: codex uses schema file path; claude uses schema serialized string.

### CORR-M2-001/002 — persistent one-time authorization ledger + atomic slot + no-`[]`-masking
New `scripts/provider-authorization-ledger.ts`:
- Durable JSON ledger OUTSIDE the repo (default `%LOCALAPPDATA%\Orion\provider-smoke-ledger.json`; overridable via `ORION_PROVIDER_LEDGER_PATH`). Never committed.
- `grant(authId, {codex:{maxInvocations,model?}, claude:{…}, options})`: create once per authId; re-grant with different terms throws; idempotent for identical terms.
- `reserve(authId, provider)`: lockfile-guarded atomic read→check(`used<granted`)→increment(`used`)→durable atomic write(temp+rename); returns `{ordinal}` or `null` when exhausted/unknown. **Reservation persists BEFORE spawn**; never rolled back ⇒ crash/ambiguous = USED slot. Re-running same authId ⇒ 0 capacity ⇒ 0 spawn.
- `recordOutcome(reservation, evidence)`: durable metadata append; never releases a slot.
- `usage(authId)`: real cumulative `{granted,used}` per provider.
Smoke (`runDeferredProviderSmoke`) rewrite:
- Require `ORION_PROVIDER_AUTHORIZATION_ID`; require an existing grant (single explicit authorization). Missing ⇒ NO spawn, structured evidence `reachedStage:'authorization_missing'|'grant_missing'`.
- Per provider: `reserve` BEFORE spawn; `null` ⇒ NO spawn, `reachedStage:'authorization_exhausted'`.
- Evidence `invocationCount` = REAL cumulative used slots from the ledger (via reservation ordinal), NOT the constant. New `reachedStage` field always reports the real reached stage.
- Remove the top-level `catch { '[]' }` masking: the CLI entrypoint always emits a structured evidence array (or a structured `{reachedStage:'error',…}` object) and never `[]`.

### CORR-M2-007 — model + option binding to a fresh authorization ID
- The smoke model per provider is bound in the authorization grant (recorded in the ledger), not hardcoded. Claude default alias `sonnet` (verified valid). Codex has NO fictional default; if the grant does not bind a Codex model, the smoke omits `--model` so Codex uses its own installed, definitionally-valid configured default. A bound model is shape-validated via `validateProviderModel`.
- Execution options (sandbox/permission/effort/timeout/budget) bound to the grant and echoed into evidence.

## File-level change plan
1. `apps/server/src/providers/provider-frame-normalization.ts` (NEW) + export via `apps/server/src/main.ts`.
2. `apps/server/src/providers/codex-adapter.ts` — mapper → normalizer wrapper.
3. `apps/server/src/providers/claude-adapter.ts` — mapper → normalizer wrapper.
4. `packages/test-fixtures/src/provider-process.ts` — real Codex/Claude frame fixtures.
5. `scripts/provider-authorization-ledger.ts` (NEW) — ledger.
6. `scripts/provider-smoke.ts` — shared normalization + ledger + schema string + model binding + no-`[]`.
7. Tests updated/added: `apps/server/test/providers/provider-adapters.test.ts`, `packages/test-fixtures/test/provider-process.test.ts`, `scripts/test/provider-smoke.test.ts`, NEW `apps/server/test/providers/provider-frame-normalization.test.ts`, NEW `scripts/test/provider-authorization-ledger.test.ts`.
8. Docs: `README.md` / `AGENTS.md` provider-smoke instructions updated for the authorization ID + ledger + schema-string contract if wording changes.

## Test / acceptance plan (fake/security/regression only; 0 real calls)
- Adapters consume real-structured fixtures → identical normalized event sequences and strict results.
- Normalizer unit tests: codex item.id/item_type/agent_message; claude content-block text, tool_use/tool_result, structured_output; invalid/unknown/finalSchema.
- Ledger tests: grant-once, atomic reserve increments durably, exhaustion ⇒ null, re-run same authId ⇒ 0 spawn, crash-before-outcome still counts a used slot, unknown authId ⇒ null, real cumulative counter.
- Smoke tests: codex uses `--output-schema <file>` + optional model; claude uses `--json-schema <serialized-string>`; no `[]` masking (structured evidence with reachedStage); invocationCount real; parser parity with production via shared normalizer.
- Full gates (P4, isolated worker): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`/`pnpm test:coverage` (≥ prior count; 7 targets ≥80%), `pnpm build`, `pnpm smoke:workspace-import`, `git diff --check`. **No** `pnpm test:providers`, **no** `ORION_REAL_PROVIDER_TESTS`, **no** provider calls.

## Absolute prohibitions (restated)
- No `ORION_REAL_PROVIDER_TESTS`; no `pnpm test:providers`, `codex exec`, `codex exec resume`, `claude -p/--print`, or any real provider/model call.
- No push/PR/merge/deploy/release/external message; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; exact-path staging only; `.orion`/`.gjc` never committed.
- Do NOT modify/delete existing M2 evidence or weaken the over-invocation record (exact cumulative real invocation count for the prior session = `unknown, worst case ≈ 6`).
- No main integration; no new real smoke; no M3.

## Exit
Final state `CORR_M2_RUNTIME_CONTRACT_READY_FOR_SMOKE_AUTHORIZATION`; STOP and await (a) explicit real-smoke authorization and (b) explicit main-integration authorization.

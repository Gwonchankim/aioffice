# CORR-M2-RUNTIME-CONTRACT-001 — Plan (P1, rev2 after P2 feedback)

- task: CORR-M2-RUNTIME-CONTRACT-001 | classification: internal
- WORKFLOW_MODE: **controller_isolated** (planner/implementer = this controller context; P2 REVIEW and P4 VALIDATE run in distinct isolated `task` worker contexts; worker IDs + artifact hashes recorded in review.md / validation-report.md).
- correction base: `m2/provider-adapters @ d365696…`; branch/worktree `corr/m2-runtime-contract`.
- rev2 incorporates P2 review `0-P2-Review` (architect) blockers verified against Codex `rust-v0.145.0` `exec_events.rs` and Claude 2.1.156 official docs.
- goal: fix M2 provider real-smoke runtime/authorization/parser contract for a FUTURE separately-authorized smoke. **0 real Codex/Claude/model invocations** in this correction.

## State verification (read-only, PASS)
main `38132a8…` clean; M2 evidence `d365696…` clean, product `461d19c…` ancestor; 0 remotes; `.orion`/`.gjc` ignored; baseline `pnpm install`+`pnpm test` green.

## PREFLIGHT capability probe (read-only `--help`/`--version`; NO model prompt; 0 provider calls)
codex-cli 0.145.0, claude 2.1.156. `codex exec`: `--json`, `--output-schema <FILE>` (file), `-m/--model`, `--sandbox read-only`, `--cd`; no read-only model list. `claude`: `--json-schema <schema>` = inline JSON STRING (help example), `--permission-mode dontAsk`, `--effort low`, `--model sonnet` valid.

## Verified provider wire contracts (authoritative for parsers + fixtures)

### Codex `codex exec --json` (rust-v0.145.0)
- `{"type":"thread.started","thread_id":"…"}` → session + run.started.
- `{"type":"turn.started"}` diagnostic (unknown/ignored).
- `{"type":"item.started"|"item.completed","item":{ "id":"item_0", "type":"<item_type>", …details }}` — **id at `item.id`; discriminator `item.type`**.
  - `agent_message`: `{id,type:"agent_message",text}` — text is NL, or a JSON string when `--output-schema` requested. Final result = terminal agent_message whose `text` JSON-parses AND validates `runResultSchema`; otherwise `run.output.delta`.
  - `command_execution`: `{id,type:"command_execution",command,aggregated_output?,exit_code?,status}` — status `in_progress|completed|failed`; **no `duration_ms`**.
  - `error`: `{id,type:"error",message}` → unknown (diagnostic).
- `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}` → run.usage (map cached_input_tokens→cacheTokens; **no duration**).
- `{"type":"error","message":"…"}` → unknown/diagnostic.

### Claude `--print --output-format stream-json` (2.1.156)
- `{"type":"system","subtype":"init","session_id":"…","model":"…",…}` → session + run.started (+ model metadata). `subtype:"api_retry"` (if present) → run.retry.
- `{"type":"assistant","message":{"id":"msg_…","content":[ {type:"text",text} | {type:"tool_use",id,name,input} … ]},"session_id":"…"}` → ordered per-block events: text→run.output.delta, tool_use→run.tool.started. Frame identity = message.id; per-event id = `assistant:<msgId>#<blockIndex>`.
- `{"type":"user","message":{"content":[{type:"tool_result",tool_use_id,is_error?}…]}}` → run.tool.completed per block (status from is_error).
- `{"type":"result","subtype":"success","result":"…text…","structured_output":{…},"usage":{input_tokens,output_tokens,cache_read_input_tokens,…},"total_cost_usd":N,"duration_ms":N,"session_id":"…"}` → ONE frame yields BOTH run.usage (usage + reportedCost/currency USD + durationMs) AND result = `structured_output` (validated). `result` text field is ignored for the strict object.
- Tolerate unrelated extra fields; reject only malformed required fields.

## Correction design (CORR-M2-001..007)

### CORR-M2-006 + 003/004 — single shared composite normalizer (foundation)
New pure module `apps/server/src/providers/provider-frame-normalization.ts`:
- `normalizeCodexFrame(frame): NormalizedFrame` and `normalizeClaudeFrame(frame): NormalizedFrame` (pure; no redaction, no schema validation).
- `NormalizedFrame = { kind:'recognized', items: readonly NormalizedItem[], sessionMarker?, frameIdentity?, result?: unknown, resultIdentity?, metadata?: {cliVersion?,model?,usage?,costUsd?} } | { kind:'unknown' } | { kind:'invalid', finalSchema?:boolean }`.
- `NormalizedItem` (ordered, one per emitted event) = discriminated: `session{sessionId} | output{text} | toolStarted{toolName,sanitizedInput?,externalMutation:false,toolId} | toolCompleted{toolName,status,toolId} | usage{usage} | retry{attempt,delayMs}`. Raw text only; **duration is NOT carried** (see tool-duration below).
- Consumers:
  - Production `mapCodexFrame`/`mapClaudeFrame` build ONE `ProviderFrameMapping` per frame: `createEvents` emits every item's event (redaction via `redactProviderText`; each event carries its own `providerEventId`); `providerEventId`(mapping)=frameIdentity for frame-level dedup; `sessionMarker` passthrough; `result` = the candidate validated via `runResultSchema` (invalidMapping(finalSchema=true) on mismatch). **No `IncrementalLineParser` contract change** — the existing `createEvents:()=>events[]` + single `result` already supports composite frames; existing parser + parser-security tests stay intact.
  - Smoke inspector calls the SAME normalizer for normalized-event counts, session hash, strict-result (runResultSchema), and metadata.
- Exported from `@orion/server` (`main.ts`) so `scripts/provider-smoke.ts` imports it → drift eliminated by construction.

### Tool duration (contract requires `run.tool.completed.durationMs`, Codex frame has none)
Derived adapter-side: `AdapterMapperContext` gains `now:()=>number`; each `createMapper` closure keeps a `Map<toolId, startMs>`. toolStarted records `now()`; toolCompleted computes `durationMs = max(0, now() - (start ?? now()))`. Claude tool_result also has no reliable duration → same derivation keyed by `tool_use_id`. Deterministic and `>=0`.

### CORR-M2-005 — Claude schema string (smoke)
Smoke splits schema by provider: codex `--output-schema <file path>`; claude `--json-schema <serialized JSON string>`. Production adapter already correct (`schema.serialized`).

### CORR-M2-007 — mandatory model + immutable options bound to a fresh authorization ID
- Every provider grant REQUIRES an operator-selected model string (shape-validated by `validateProviderModel`; current-model validity is operator attestation). The smoke passes that exact value as `--model`. NO fictional/ambient default; NO omission. `gpt-5.6-sol` removed.
- Execution options are a typed, bounded, IMMUTABLE record embedded in the grant: `{sandbox:'read-only', permissionMode:'dontAsk', effort:'low', allowedTools, disallowedTools, timeoutMs, maxBudgetUsd}`. Values are constants validated on grant; argv builders consume them; `assertSafeProviderArguments` still rejects any bypass; `shell:false` fixed.

### CORR-M2-001 — persistent one-time authorization ledger (immutable grant + exclusive per-slot markers)
New `scripts/provider-authorization-ledger.ts`. Store OUTSIDE any repo (default `%LOCALAPPDATA%\Orion\provider-smoke-ledger`; override `ORION_PROVIDER_LEDGER_DIR`). **Path containment**: canonicalize; reject non-absolute, symlink/reparse, and any path inside workspace root / any git worktree / `.orion` / `.gjc` / project trees → fail-closed `PROVIDER_LEDGER_PATH_UNSAFE`.
- Layout: `<ledgerDir>/<authId>/grant.json` (immutable; written once with `wx`; re-grant with different terms throws `PROVIDER_GRANT_CONFLICT`; identical terms = idempotent no-op) + `<authId>/slots/<provider>-<ordinal>.slot` marker files.
- `grant(authId, terms)`: validate authId shape + terms (mandatory model per provider, positive bounded maxInvocations, immutable options); create dir + `grant.json` via `wx`.
- `reserve(authId, provider)`: read grant (must exist, else `null`→no spawn); attempt exclusive `wx` create of `slots/<provider>-<n>.slot` for n=1..maxInvocations in order; first successful create returns `{ordinal:n}`; if all exist → exhausted `null`. The `wx` create is the ATOMIC reservation and is durable BEFORE spawn; a crash after reserve leaves the marker ⇒ slot stays USED; no counter rewrite, no global lock, no lost-update/stale-lock hazard.
- `recordOutcome(authId, reservation, sanitizedEvidence)`: write `slots/<provider>-<n>.outcome.json` (sanitized; best-effort; never releases the slot).
- `usage(authId)`: cumulative used = count of existing `.slot` markers per provider; granted from grant.
- Corruption policy: unreadable/invalid `grant.json` ⇒ fail-closed `PROVIDER_GRANT_CORRUPT` (never auto-repair, never over-grant). All errors are generic sanitized codes (no authId echo, no paths, no raw exceptions).
- Concurrency: two processes racing the same ordinal → one `wx` wins, the other gets EEXIST and advances to the next ordinal or exhaustion; never double-spawns a single slot.

### CORR-M2-002 — atomic reservation before spawn + no-`[]`-masking + real cumulative count
- `reserve` happens BEFORE `processPort.spawn`; `null` ⇒ no spawn.
- Evidence is ONE stable sanitized envelope per provider with an exhaustive `reachedStage` enum: `authorization_missing | grant_missing | grant_corrupt | ledger_unsafe | authorization_exhausted | preflight_unavailable | invocation_reserved | invocation_spawned | invocation_completed`, plus a locked cumulative `invocationCount` snapshot (real marker count) on EVERY identifiable-authorization path. `invocationCount` = ledger cumulative (via reservation ordinal / marker count), never the constant.
- Remove the CLI entrypoint `catch { '[]' }`. On any error the entrypoint emits a structured envelope `{reachedStage, error:<generic code>}` (array of per-provider envelopes when reached, else a single structured object) and exits nonzero. NEVER `[]`.

## File-level change plan
1. `apps/server/src/providers/provider-frame-normalization.ts` (NEW) + export via `apps/server/src/main.ts`.
2. `apps/server/src/providers/adapter.ts` — `AdapterMapperContext.now`; pass `now` from base adapter.
3. `apps/server/src/providers/codex-adapter.ts` — mapper → normalizer + tool-duration closure.
4. `apps/server/src/providers/claude-adapter.ts` — mapper → normalizer + tool-duration closure.
5. `packages/test-fixtures/src/provider-process.ts` — real Codex (`item.id`/`item.type`/agent_message-JSON result/`cached_input_tokens`) + Claude (`message.content[]` blocks / `structured_output` / result-usage-in-one-frame) fixtures; Korean split retained.
6. `scripts/provider-authorization-ledger.ts` (NEW) — ledger.
7. `scripts/provider-smoke.ts` — shared normalizer + ledger + schema string + mandatory model + reachedStage envelope + no `[]`.
8. Tests updated/added: `apps/server/test/providers/provider-adapters.test.ts`, `packages/test-fixtures/test/provider-process.test.ts`, `scripts/test/provider-smoke.test.ts`, NEW `apps/server/test/providers/provider-frame-normalization.test.ts`, NEW `scripts/test/provider-authorization-ledger.test.ts`.
9. Docs: `README.md` + `AGENTS.md` provider-smoke section — grant issuance (0 provider calls), authorization ID, two-gate future-smoke process, ledger stored outside repo.

## Explicit existing-test migrations (from P2)
- `packages/test-fixtures/test/provider-process.test.ts` `stdout.toContain('"result"')` → provider-specific: codex stdout contains `"type":"agent_message"` + JSON text; claude stdout contains `"structured_output"`. Update `expected.usage` to drop `durationMs` for codex; keep M2-FIX exact spawnCapture argv contract (production adapter argv is UNCHANGED — only parser/fixtures change); add exact Claude capture parity.
- `apps/server/test/providers/provider-adapters.test.ts`: production Codex/Claude argv-shape tests PRESERVED unchanged (normalization must not alter command construction); fixture-driven expectations extended for multi-block assistant, multiple tool blocks, result usage+structured_output, ordinary Codex agent text before final JSON, duplicate frames, missing tool duration.
- `scripts/test/provider-smoke.test.ts`: drop `CODEX_SMOKE_MODEL` fiction + global `providerSmokeModels`; assert grant-derived exact argv, mandatory model, claude inline serialized schema (not file path), codex `{item:{id,type:'agent_message',text:JSON.stringify(result)}}`, real cumulative count + reachedStage (not constant 1), no `[]`.

## Test / acceptance plan (fake/security/regression only; 0 real calls)
- Normalizer unit tests: codex item.id/item.type/agent_message JSON-result vs plain output/command status/usage cached_input_tokens/error/unknown; claude multi-block content, tool_use+tool_result, result usage+structured_output, invalid/finalSchema/unknown, metadata.
- Ledger tests (injected fs + temp dir): idempotent grant, grant conflict, mandatory model, exhaustion ⇒ null, re-run same authId ⇒ 0 reserve, crash-before-outcome still counts a used marker, unknown authId ⇒ null, corrupt grant ⇒ fail-closed, unsafe/override path containment reject, concurrent reservation (two reserves never share an ordinal), real cumulative usage snapshot.
- Smoke tests: schema string vs file path; mandatory model in argv; reachedStage envelope on missing/exhausted/spawned paths; invocationCount real; parser parity via shared normalizer; no `[]`.
- Full gates (P4 isolated worker): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`/`pnpm test:coverage` (>= prior count; 7 targets >=80%), `pnpm build`, `pnpm smoke:workspace-import`, `git diff --check`. **No** `pnpm test:providers`, **no** `ORION_REAL_PROVIDER_TESTS`, **no** provider calls.

## Absolute prohibitions
No `ORION_REAL_PROVIDER_TESTS`; no `pnpm test:providers`/`codex exec`/`codex exec resume`/`claude -p`/`--print`/any real provider-model call. No push/PR/merge/deploy/release/external message; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; exact-path staging only; `.orion`/`.gjc` never committed; ledger stored outside any repo. Do NOT modify/delete existing M2 evidence or weaken the over-invocation record (`unknown, worst case ≈ 6`). No main integration; no new real smoke; no M3.

## Exit
Final state `CORR_M2_RUNTIME_CONTRACT_READY_FOR_SMOKE_AUTHORIZATION`; STOP; await (a) explicit real-smoke authorization and (b) explicit main-integration authorization.

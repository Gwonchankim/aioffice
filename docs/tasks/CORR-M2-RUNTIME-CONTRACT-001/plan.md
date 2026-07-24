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

## Rev3 — exact resolution of P2 round-2 required changes (supersedes ambiguous rev2 wording)

### R1 Composite identity/dedup (fixes B4; regex-safe)
`providerEventIdentitySchema = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/` — **`#` is forbidden**; use colon-only IDs.
- Codex frame identity (= `ProviderFrameMapping.providerEventId`, used for parser dedup): `thread.started:<thread_id>` (session), `item.started:<item.id>`, `item.completed:<item.id>`, `turn.completed` (usage; no id ⇒ identity omitted, allowed once via createEvents), `system.api_retry` (omit id). Start and completion of one item stay DISTINCT (`item.started:<id>` ≠ `item.completed:<id>`).
- Claude frame identity = the frame's TOP-LEVEL `uuid` (NOT `message.id`, which several assistant messages in one turn can share): `system:<uuid>`, `assistant:<uuid>`, `user:<uuid>`, `result:<uuid>`, `retry:<uuid>`.
- Per-event `providerEventId` inside `createEvents` (regex-safe, unique): `assistant:<uuid>:<blockIndex>` (text), `assistant:<uuid>:tool:<blockIndex>` (tool_use), `user:<uuid>:<blockIndex>` (tool_result). Codex event ids reuse the frame identity (single event per codex frame).
- Frames lacking a required identity field ⇒ `invalidMapping()`.
- Tests: same `message.id` under different frame `uuid` both accepted; duplicate identical `uuid` dropped before `createEvents`; multi-block assistant emits ordered text+tool; Codex `item.started`/`item.completed` sharing `item.id` both accepted; every generated id parses through `normalizedAdapterEventSchema`.

### R2 Authoritative wire additions (fixes B1 completeness)
- Codex `command_execution.status`: `in_progress|completed|failed|declined` — `completed`→succeeded, `failed`/`declined`→failed.
- Codex usage keys: `input_tokens`,`cached_input_tokens`(→cacheTokens),`output_tokens`; no duration.
- Claude retry frame: real field `retry_delay_ms` (not `delay_ms`); tolerated if absent. Claude top-level `uuid` present on stream frames; unknown/unsupported content-block types ⇒ ignored (not invalid) so a text/tool frame with an extra block still yields its known events.
- Normalizer tests cover declined status, cached_input_tokens, retry_delay_ms, and unknown content-block tolerance.

### R3 Dedup-safe tool duration (fixes B4 timing)
Duration state is mutated ONLY inside the accepted mapping's `createEvents` callback (which runs after `IncrementalLineParser.acceptIdentity()`), never during `mapFrame`. Per-run closure `Map<toolId,{startedAt,toolName}>`: toolStarted's createEvents sets `{startedAt: now(), toolName}`; toolCompleted's createEvents samples `now()` once, `durationMs = max(0, now - startedAt)` (or `0` when no accepted start), then deletes the entry. Tests: exact deterministic duration via injected `now`; completion-without-start ⇒ 0; duplicate start/completion frames don't corrupt timing; Claude tool-name correlation via `tool_use_id`.

### R4 One-time authId semantics (fixes B3) — run-claim + per-slot markers, reserve-all-before-first-spawn
- Grant fixes `maxInvocations = 1` per provider (authorized smoke scope: exactly 1 Codex + 1 Claude).
- `claimRun(authId)`: `wx`-create `<authId>/run.claim`. If it already exists ⇒ return `null` ⇒ the ENTIRE run performs **0 spawn** (covers rerun/partial/early-return/crash — the claim persists). Atomic one-time gate.
- After a successful claim, reserve BOTH provider slots (`wx`-create `<authId>/slots/<provider>-1.slot`) BEFORE spawning EITHER provider. A concurrent-race loser on the claim performs 0 spawn.
- Crash after claim (even before Codex) ⇒ `run.claim` persists ⇒ rerun 0 spawn. Early Codex failure / repository-change return ⇒ claim already consumed ⇒ Claude slot cannot be revived on rerun.
- `usage(authId)`: cumulative used per provider = fresh count of that provider's `.slot` markers at assembly (0 or 1); total = sum.
- Fake-port end-to-end tests: full rerun ⇒ 0 spawn; crash after claim; crash after first provider; early repository-change return; two concurrent harness runners (only one claims).

### R5 Grant workflow + Windows containment (fixes B2/B3 major)
- Grant JSON (strict, canonical sorted-key serialization for equality): `{ schemaVersion:1, authorizationId, createdAt, providers:{ openai:{model,maxInvocations:1}, anthropic:{model,maxInvocations:1} }, options:{ codexSandbox:'read-only', claudePermissionMode:'dontAsk', effort:'low', allowedTools:'Read,Glob,Grep', disallowedTools:'Bash,Edit,Write,WebFetch,WebSearch', timeoutMs:300000, maxBudgetUsd:0.5 } }`. Models mandatory, `validateProviderModel`-shaped; options immutable constants (re-grant with different terms ⇒ `PROVIDER_GRANT_CONFLICT`; identical ⇒ idempotent).
- Zero-provider-call issuance: `provider-smoke.ts` CLI dispatches `argv[2]`: `grant` (writes grant only; 0 spawn) vs `run`/default (claim+reserve+spawn). Inputs via env `ORION_PROVIDER_AUTHORIZATION_ID`, `ORION_CODEX_SMOKE_MODEL`, `ORION_CLAUDE_SMOKE_MODEL`. No new root package script (reuse `test:providers` entry + documented mode arg).
- Windows ledger-dir containment `assertSafeLedgerRoot(dir, forbiddenRoots)`: require local drive-letter absolute; reject UNC (`\\`), device (`\\?\`,`\\.\`), ADS/`:`-in-segment; canonicalize nearest EXISTING ancestor (`realpathSync.native`); `lstat` each existing component, reject symlink/reparse; reject if canonical path is contained (case-insensitive) in any `forbiddenRoot` (workspace root + git worktree roots + `.orion`/`.gjc`); create dirs `{recursive,mode:0o700}`; REVALIDATE after creation and before grant/reserve/usage. Same-user path-swap TOCTOU acknowledged as outside Node guarantees. Tests: unsafe default/override, junction ancestor, non-existent override, post-create reparse, case-insensitive containment.

### R6 One evidence envelope (fixes B5)
Single strict top-level shape on EVERY path: `{ schemaVersion:1, providers: ProviderEvidence[] }`. `ProviderEvidence`: required `provider`, `reachedStage` (`authorization_missing|grant_missing|grant_corrupt|ledger_unsafe|run_claim_denied|authorization_exhausted|preflight_unavailable|invocation_reserved|invocation_spawned|invocation_completed|cleanup_incomplete`), required `invocationCount` (fresh marker count at assembly; `0` on no-auth/unsafe/corrupt/claim-denied), plus existing sanitized fields when reached. Already-produced provider evidence preserved when a later provider path fails. Each catch boundary maps to ONE generic sanitized error code + reachedStage. CLI ALWAYS prints this object and exits nonzero on any non-success; NEVER `[]`. Tests: every stage; concurrent-count; preserved-partial.

### R7 Complete migrations + docs
- Remove BOTH `CODEX_SMOKE_MODEL` and `CLAUDE_SMOKE_MODEL`; migrate `PROVIDER_SMOKE_MAX_INVOCATIONS`, `codexResumeArgv`, direct `invokeSmokeProvider` fixtures, provider-specific `expected.usage`/`standardUsage` (drop codex durationMs), and the generic `stdout.toContain('"result"')` assertion. Add exact Claude spawn-capture argv parity in the fixtures test.
- Docs: `README.md`, `AGENTS.md`, `docs/orion/orion-console-operations-recovery-runbook.md`, `docs/orion/orion-console-test-evaluation-plan.md` (latter hardcodes `--model sonnet` + one-gate) — grant-issuance + authorization-ID + two-gate future-smoke + ledger-outside-repo.
- P4 report: per-new-file coverage in addition to the aggregate 7-target gate.

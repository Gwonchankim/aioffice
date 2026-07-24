# CORR-M2-SMOKE-CONFIG-003 — Plan (P1)

- WORKFLOW_MODE: controller_isolated. Data classification: internal.
- branch: `corr/m2-smoke-config-compatibility`; base `corr/m2-smoke-gate-finalization @ ad418a3` (validated product ancestor `e684fdc`).
- **0 real Codex/Claude/model calls; no grant; no ORION_REAL_PROVIDER_TESTS; no new/reused authorization id.** Only `--version`/`--help` + fake process tests. The spent `M2-SMOKE-20260724-001` ledger records are preserved untouched; prior `M2-REAL-PROVIDER-SMOKE-001` evidence is preserved (superseded additively only).

## Root-cause reading of the failed real smoke (CORR-M2 evidence)
Both providers exited nonzero fast (Codex ~3.9s after `run.started`; Claude ~1.4s with 0 frames). Two real smoke-config/code defects plausibly caused this and are fixed here:
- The provider structured-output JSON Schema arrays had NO `items` — OpenAI structured outputs REQUIRE `items` on every array (⇒ likely Codex `INVALID_OUTPUT_SCHEMA`).
- Claude `--mcp-config '{}'` is not the official empty-config shape `{"mcpServers":{}}` (⇒ likely Claude `INVALID_MCP_CONFIG` before any frame).
These are real defects; the prior "external-state-only" framing cannot be confirmed. `gpt-5.6-sol` is NOT treated as invalid/fictional.

## CFG-001 — strict cross-provider structured-output schema (scripts/provider-smoke.ts `providerSmokeResultSchema`)
Rewrite to a strict subset both providers accept AND that yields a `runResultSchema`-valid empty result:
- Every array gets a real `items` schema (NOT `items: {}`) matching the `runResultSchema` element shape, plus `maxItems: 0` (require empty). `maxItems` and nullable `type:['string','null']` are within the documented OpenAI structured-outputs + Claude json-schema subsets (recorded as evaluated; real-provider acceptance is re-confirmed only at the next authorized smoke).
- Every object has `additionalProperties: false`; every object's `required` lists ALL of its `properties` (OpenAI strict). Optional runResult fields become required + nullable in the JSON schema (never instantiated because `maxItems: 0`).
- Root `required` = all 8 props; `status` enum restricted to `['succeeded']`; drop `minLength` (Zod enforces non-empty; fewer provider keywords).
- Result: `{status:'succeeded', summary, findings:[], artifacts:[], changes:[], tests:[], risks:[], handoff}` passes BOTH the JSON schema (maxItems 0) AND Zod `runResultSchema`. `schemaHash` changes ⇒ old grant policy auto-conflicts.

## CFG-002 — prompt/schema alignment (scripts/provider-smoke.ts `smokePrompt`)
Prompt requires exactly: status `succeeded`; summary = file count + detected languages of the synthetic repo; findings/artifacts/changes/tests/risks all `[]`; handoff = read-only confirmation. Explicitly forbids writing files, git, bash, network, artifacts, running tests, external tools. `promptHash` changes.

## CFG-003 — Claude empty MCP config (scripts/provider-smoke.ts `claudeSmokeArgv`)
Replace bare `'{}'` with `CLAUDE_EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} })` = `{"mcpServers":{}}`, keeping `--strict-mcp-config`. 0 MCP servers; no project/user MCP; disallowed tools unchanged. Unit-test: the value JSON.parses to exactly `{mcpServers:{}}` and the argv contains no bare `'{}'`. Connector/account info is never in evidence.

## CFG-004 — sanitized failure diagnostics (scripts/provider-smoke.ts)
Add `ProviderDiagnosticCode` enum (`MODEL_UNAVAILABLE | INVALID_OUTPUT_SCHEMA | INVALID_ARGUMENT | INVALID_MCP_CONFIG | AUTHENTICATION_FAILED | PERMISSION_DENIED | RATE_LIMITED | NETWORK_UNAVAILABLE | PROVIDER_INTERNAL_ERROR | UNKNOWN_PROVIDER_FAILURE`) and a pure `classifyProviderDiagnostic(text): ProviderDiagnosticCode | undefined`:
- Bounded input (slice ≤ 16 KiB), lowercased; priority-ordered regex list; first priority match wins; matched raw values are discarded (only the code is returned).
- stderr is accumulated into a transient bounded buffer (≤16 KiB, local — never in evidence) alongside the existing `sanitizerFindings` count; classified at stream end; the buffer is discarded.
- Final `diagnostic = frameDiagnostic ?? stderrDiagnostic ?? (nonzero/non-success ? UNKNOWN_PROVIDER_FAILURE : undefined)`.
- `ProviderSmokeEvidence` gains `diagnostic?: ProviderDiagnosticCode`; set in `invokeSmokeProvider`; stored in the outcome ledger via `recordOutcome`. No raw stderr/stdout/email/org/token/path retained.

## CFG-005 — Codex JSONL failure events (scripts/provider-smoke.ts `inspectProviderFrame`)
Before the recognized-frame early return, capture codex failure frames: `{type:'error', message}` and `{type:'turn.failed', error:{message?/code?}}` (and terminal error events) → `classifyProviderDiagnostic` → `summary.frameDiagnostic` (no raw retained). `turn.completed` without a strict result and `nonzero_exit` remain NON-success (already enforced by `classifyExit` + strictResult). The shared normalizer is unchanged (these stay `unknownFrame`); handling is smoke-local.

## CFG-006 — Claude pre-frame failure (scripts/provider-smoke.ts)
When Claude emits 0 recognized frames and exits nonzero: normalizedEventCounts stays `{}`, strictResult stays false, the stderr diagnostic is recorded, no raw stderr retained, no retry. Also classify claude error `result` frames (`is_error:true` / `subtype` error) to `frameDiagnostic`.

## CFG-007 — evidence correction (new doc, additive)
`docs/tasks/CORR-M2-SMOKE-CONFIG-003/evidence-correction-cfg-007.md`: records that the prior failure could NOT be confirmed as external-only; the schema lacked array `items` and the Claude MCP config differed from the official empty shape — both real smoke config/code defects; `gpt-5.6-sol` is a supported model (not invalid/fictional); the prior authorization is spent and not reused; the next real smoke requires this correction + a NEW user authorization. Prior evidence files are NOT modified.

## CFG-008 — policy/hash version bump (scripts/provider-smoke.ts)
Bump `ARGV_POLICY_VERSION` 2 → 3 (claude argv MCP value changed). `schemaHash` + `promptHash` change from the CFG-001/002 edits. `computeLivePolicy()` therefore differs from any prior grant ⇒ an old grant fails `policy_binding_mismatch` (0 spawn); only a new grant is usable. The existing ledger is untouched.

## File-level changes
- `scripts/provider-smoke.ts` — schema, prompt, claude argv (mcp), diagnostics (enum + classifier + stderr buffer + frame capture), evidence `diagnostic` field, `ARGV_POLICY_VERSION`.
- `scripts/test/provider-smoke.test.ts` — update the SMG-008 claude argv assertion (mcp value) + add the CFG fake tests (schema structure/items/additionalProperties/required alignment; empty-array Zod pass; schema-invalid Zod reject; mcp exact; no bare `'{}'`; diagnostic taxonomy incl. turn.failed/error/pre-frame/invalid-schema/invalid-mcp/model/auth/permission/rate/network/internal/unknown; bounded; no-raw-retention; strictResult-less nonzero FAIL).
- Docs: `README.md` + `AGENTS.md` smoke argv note (mcp config + diagnostic); CFG-007 evidence correction; plan/review/impl-log/validation-report/completion-report/decision-log/worker-registry/new-smoke-authorization-request.

## Test plan (CFG §4 tests 1–25)
All fake/injected, 0 real calls: schema `items` on every array (1); `additionalProperties:false` everywhere (2); properties/required alignment (3); schema-valid empty sample passes Zod (4/6); schema-invalid rejected by Zod (5); non-empty forbidden by `maxItems:0` structurally (7); MCP JSON exactly `{"mcpServers":{}}` (8) and no bare `'{}'` in argv (9); Codex argv+model unchanged contract (10); `turn.failed` (11) / codex `error` (12) / Claude pre-frame stderr (13) / invalid-schema (14) / invalid-mcp (15) / model-unavailable (16) / auth+permission+rate-limit+network (17) diagnostics; unmatched→unknown (18); bounded stderr (19); no raw/account/path/token retained (20); nonzero without strict result ⇒ FAIL (21); repository unchanged (22); rerun 0 spawn (23, via existing ledger claim-gate); spent authorization preserved (24); 0 real provider/model calls (25).

## Acceptance / prohibitions
P4 (independent): install/format/lint/typecheck/test/test:coverage(7 targets ≥80%)/build/workspace-import/E2E/axe 0/console 0/audit prod+high 0-0/OpenAPI drift/tracked-dist 0/no `.only`.`.skip`/0 real calls/0 real grant/ledger unchanged. NO real smoke, main integration, M3, push/PR/deploy, dependency change, or ledger/evidence mutation.

## Rev2 — exact resolution of P2 round-1 findings

### RB1 (BLOCKER) — drop `maxItems:0`; enforce emptiness with a smoke-local validator
Anthropic structured outputs support only array `minItems` (0/1) and REJECT `maxItems` (and other array constraints). `maxItems:0` would make Claude reject the schema — reproducing CFG-006. Resolution (reviewer's "viable fallback"):
- ONE shared `providerSmokeResultSchema` accepted by BOTH providers, WITHOUT `maxItems`: every array has a real non-empty `items` schema (incl. nested `changes.files: {type:'array', items:{type:'string'}}`); every object has `additionalProperties:false`; every object's `required` equals ALL of its property keys; nullable optional fields use `type:['string','null']` (4 union fields, under Anthropic's 16-union limit); `status` enum `['succeeded']`; NO `minLength`/`maxItems`/`format`.
- Emptiness + success are enforced smoke-locally and authoritatively: new pure `smokeResultIsStrict(result): boolean` = `runResultSchema.safeParse(result).success && result.status==='succeeded' && findings/artifacts/changes/tests/risks are each length 0`. `inspectProviderFrame` sets `hasStrictResult` via `smokeResultIsStrict` (replacing the bare `runResultSchema.safeParse().success`). The prompt still requires empty arrays; a non-empty or non-succeeded result ⇒ not strict ⇒ FAIL.
- Evaluation recorded (CFG-001 "검토"): `maxItems:0` is NOT cross-provider safe (Claude-unsupported); therefore omitted; emptiness is enforced locally. `schemaHash` still changes (arrays now carry items).

### RB2 (MAJOR) — terminal failure gates success
`summary.terminalFailure: boolean`. Set true on Codex `{type:'error'}` / `{type:'turn.failed'}` and Claude error result frames (`is_error:true` or error `subtype`). Final `strictResult = summary.hasStrictResult && !summary.terminalFailure`, computed in `invokeSmokeProvider` and fed to `classifyExit`. So exit 0 + a valid strict result but ALSO a terminal-failure frame ⇒ NOT succeeded. Tests: exit-0 mixed stream with each terminal frame form ⇒ strictResult false.

### RB3 (MAJOR) — frozen diagnostic priority table (all 10 codes, bounded, deterministic)
`classifyProviderDiagnostic(text): ProviderDiagnosticCode | undefined` — input sliced to ≤16384 chars, lowercased; FIRST match in this exact priority order wins; only the code is returned (matched raw discarded):
1. `INVALID_MCP_CONFIG` — `mcpservers` | (`mcp` & (`config`|`server`)) | `invalid mcp`
2. `INVALID_OUTPUT_SCHEMA` — `output schema`|`output-schema`|`json schema`|`json-schema`|`response_format`|`structured output`|`additionalproperties`|`maxitems`|(`schema` & (`invalid`|`unsupported`|`not supported`|`required`|`must`|`property`))
3. `INVALID_ARGUMENT` — `unknown option`|`unknown flag`|`unrecognized`|`unexpected argument`|`invalid argument`|`invalid option`|`invalid flag`|`no such option`
4. `MODEL_UNAVAILABLE` — `unknown model`|`no such model`|(`model` & (`not found`|`unavailable`|`does not exist`|`unknown`|`invalid`|`unsupported`|`not supported`|`deprecated`|`no access`))
5. `AUTHENTICATION_FAILED` — `unauthenticated`|`unauthorized`|`authentication`|`not logged in`|`invalid api key`|`invalid token`|`login required`|`401`
6. `PERMISSION_DENIED` — `permission denied`|`forbidden`|`not allowed`|`access denied`|`403`
7. `RATE_LIMITED` — `rate limit`|`rate-limit`|`ratelimit`|`too many requests`|`quota`|`429`
8. `NETWORK_UNAVAILABLE` — `econnrefused`|`etimedout`|`enotfound`|`network`|`dns`|`connection refused`|`offline`|`proxy`|`tls handshake`
9. `PROVIDER_INTERNAL_ERROR` — `internal server error`|`internal error`|`500`|`502`|`503`|`504`|`panic`|`segfault`|`unexpected error`
10. `UNKNOWN_PROVIDER_FAILURE` — non-empty text with no match.
Final evidence diagnostic = `frameDiagnostic ?? stderrDiagnostic ?? (nonSuccess ? UNKNOWN_PROVIDER_FAILURE : undefined)`. stderr is accumulated in a transient bounded (≤16 KiB) LOCAL buffer, classified at stream end, then discarded (never in evidence). `ProviderSmokeEvidence.diagnostic?` + stored in the outcome ledger payload. No raw stderr/stdout/email/org/token/path retained.

### RB4 (MAJOR) — legacy-policy regression (frozen gen-2 fixture, pre-mutation)
Test with a FROZEN generation-2 policy `{argvPolicyVersion:2, schemaHash:<old>, promptHash:<old>, repositoryTemplateVersion:1}` (literal constants, NOT recomputed): assert each of `argvPolicyVersion`/`schemaHash`/`promptHash` differs from `computeLivePolicy()`, then run `runProviderSmoke` with a grant carrying that old policy ⇒ `policy_binding_mismatch` for both providers with ZERO claim/reserve/spawn/markSpawnAttempt/recordOutcome (assert the injected ledger recorded no claim/reservation/spawn/outcome). No fixture contains the real spent authorization id.

### RB5 (MINOR) — prompt read-only allowlist
Prompt positively permits ONLY read-only inspection via the configured Read/Glob/Grep tools; explicitly prohibits Edit/Write, Bash/shell/git, web/network, running tests, and artifact creation. Output contract exactly matches the schema (status succeeded; summary = file count + detected languages; five empty arrays; handoff = read-only confirmation).

### RB6 (MINOR) — precise fixtures + read-only preservation audit
- Two distinct negative fixtures: (a) a Zod-invalid sample (e.g. empty `summary`, or `findings:[{}]`) rejected by `runResultSchema`; (b) a smoke-invalid but Zod-valid non-empty RunResult (e.g. `risks:['x']`) rejected by `smokeResultIsStrict` (empty-array contract) even though Zod accepts it.
- CFG §4 item 24 (spent authorization preserved) is a P4 READ-ONLY diff/hash audit of `M2-SMOKE-20260724-001` ledger + prior evidence (unchanged), NOT a fake test, and NO fixture contains/accesses that id.

### Test-migration list (adopted)
- `InMemoryLedger` in scripts/test/provider-smoke.test.ts captures the FULL sanitized `recordOutcome` payload (not only provider/ordinal) so diagnostic persistence + raw-data-absence are assertable.
- `fakeProcess` extended to inject stderr chunks and mixed stdout terminal-error frames (fully fake).
- SMG-008 claude argv assertion `'{}'` → `'{"mcpServers":{}}'` (+ assert no bare `'{}'` element; retain `--strict-mcp-config`).
- Add explicit numbered cases: INVALID_ARGUMENT, PROVIDER_INTERNAL_ERROR, precedence/overlap, exactly-16 KiB and over-limit input, terminal-error-plus-valid-result (exit 0 ⇒ FAIL), outcome serialization + no-raw.
- README.md/AGENTS.md `--mcp-config {}` → `{"mcpServers":{}}`.
- The shared-normalizer assertion (codex `error`/`turn.failed` ⇒ unknown) is NOT migrated; smoke-local handling is additive; the full server adapter/normalizer suite must stay green.

## Rev3 — final resolution of P2 round-2 blocker (RB5 prompt/tool provider-compatibility)
The shared `smokePrompt` must NOT name Claude-specific tools (`Read/Glob/Grep`) because it is sent to BOTH providers and Codex has no such tools (Codex inspects under `--sandbox read-only`). Resolution:
- `smokePrompt` is provider-NEUTRAL about mechanism: "Inspect this synthetic public repository read-only" + explicit prohibitions (do NOT modify/create files, run shell/bash/git, access the network, run tests, or create artifacts) + the exact output contract (status `succeeded`; summary = file count + detected languages; findings/artifacts/changes/tests/risks all `[]`; handoff = read-only-confirmation). No provider-specific tool name appears in the prompt.
- The per-provider read-only ENFORCEMENT stays in the argv (unchanged mechanism, provider-appropriate): Codex `--sandbox read-only` (its native read-only file inspection); Claude `--allowedTools Read,Glob,Grep --disallowedTools Bash,Edit,Write,WebFetch,WebSearch`.
- Add one argv/prompt contract test PER provider: (codex) argv contains `exec --json --sandbox read-only … --model <grant> …` and the neutral prompt is delivered via stdin with no Edit/Write/Bash affordance; (claude) argv contains `--allowedTools Read,Glob,Grep`, the disallowed set, `--strict-mcp-config`, `--mcp-config {"mcpServers":{}}`, and the same neutral prompt via stdin. Both assert the prompt contains no `Read,Glob,Grep`/write/git/network wording that would misdirect the other provider.

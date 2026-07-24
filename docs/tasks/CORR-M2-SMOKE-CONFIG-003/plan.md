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

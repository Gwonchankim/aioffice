# CORR-M2-SMOKE-CONFIG-003 — Completion Report (P5)

- final state: **`CORR_M2_SMOKE_CONFIG_READY_FOR_NEW_AUTHORIZATION`**
- WORKFLOW_MODE: controller_isolated. P2 REVIEW (`11-CFG-P2-Review`, `12-CFG-P2-Confirm`, `13-CFG-P2-Final`) and P4 VALIDATE (`14-CFG-P4-Validate`) ran in distinct isolated worker contexts (worker-registry.md).
- branch: `corr/m2-smoke-config-compatibility`; base `corr/m2-smoke-gate-finalization @ ad418a3`.
- **validated product SHA:** `b28683a` (validated at HEAD `b5b5c7f`; later commits add only docs).
- **final evidence HEAD:** the tip commit adding P4/P5 documents (this commit; a descendant of the validated product SHA), recorded distinctly from the product SHA per CFG-007.
- **0 real Codex/Claude/model calls; 0 grant; no ORION_REAL_PROVIDER_TESTS; no new/reused authorization id.** The spent `M2-SMOKE-20260724-001` ledger (2 `.spawn` markers) and prior `M2-REAL-PROVIDER-SMOKE-001` evidence are preserved untouched.

## What was corrected (CFG-001..008 — all addressed)
- **001** strict cross-provider structured-output schema (real `items` everywhere, `additionalProperties:false`, `required`=all-props, nullable optionals, `status:['succeeded']`, no `maxItems`/`minLength`) + authoritative smoke-local `smokeResultIsStrict`.
- **002** prompt aligned to the schema (status succeeded; summary = file count + languages; five empty arrays; handoff read-only) and provider-neutral.
- **003** Claude `--mcp-config` = official `{"mcpServers":{}}` under `--strict-mcp-config`; no bare `{}`.
- **004** sanitized `ProviderDiagnosticCode` taxonomy (frozen priority, ≤16 KiB bounded, unmatched→UNKNOWN) stored in evidence + outcome ledger; no raw text retained.
- **005** Codex JSONL `error`/`turn.failed` recognized as terminal failures (diagnostic; never success).
- **006** Claude pre-frame nonzero keeps 0 events + stderr diagnostic + strictResult false + no retry.
- **007** additive evidence correction (`evidence-correction-cfg-007.md`): prior "external-only" framing superseded; two real config/code defects; `gpt-5.6-sol` supported (not fictional); spent authorization not reused.
- **008** `ARGV_POLICY_VERSION` 2→3 + changed schema/prompt hashes ⇒ prior grants fail `policy_binding_mismatch` (proven by a frozen gen-2 regression with 0 ledger mutation).
- P2 refinements RB1–RB6 + rev3 RB5 implemented (smoke-local empty-result validator; terminal-failure gate; frozen diagnostic table + outcome capture; legacy-policy regression; provider-neutral prompt; precise negative fixtures + read-only preservation audit).

## Verification (independently reproduced, PASS)
`install --frozen-lockfile` · `format:check` · `lint` · `typecheck` · `test:coverage` (**244 tests**, 30 files; 7 targets ≥80%) · `build` · `smoke:workspace-import` · `e2e` (3 passed, axe Critical 0, console 0) · `audit --prod` (0/0) · `audit --audit-level high` (0/0) · OpenAPI drift clean · tracked-dist 0 · no `.only`/`.skip` · git clean. Read-only preservation audit: spent ledger unchanged (2 markers); prior evidence unchanged. 0 real provider calls / 0 grant.

## Preservation & isolation
main unchanged (`38132a8`, clean); M2 `d365696`; gate base `ad418a3`; runtime `f05ea40`; 0 remotes; product code + dependencies unchanged; no push/PR/merge/deploy/external message; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; exact-path staging only; `.orion`/`.gjc` never committed; existing ledger/authorization/slot/spawn/outcome + prior failure evidence preserved; over-invocation record unweakened. M3 NOT started.

## STOP — awaiting a NEW explicit user authorization
1. **New real-provider smoke** (exactly 1 Codex + 1 Claude) with a **NEW authorization id** (the prior one is spent) — see `new-smoke-authorization-request.md`. Requires separate explicit user authorization.
2. **main integration** of the M2 correction chain remains a separate explicit decision.

Neither is assumed. No provider call, grant, smoke, integration, or M3 start will occur without the corresponding explicit approval.

# CORR-M2-RUNTIME-CONTRACT-001 — Completion Report (P5)

- final state: **`CORR_M2_RUNTIME_CONTRACT_READY_FOR_SMOKE_AUTHORIZATION`**
- WORKFLOW_MODE: controller_isolated. Gates satisfied with distinct isolated `task` worker contexts: P2 REVIEW (`0-P2-Review`, `1-P2-Rereview`, `2-P2-Confirm`, `3-P2-Final`) and P4 VALIDATE (`4-P4-Validate`) ran in separate contexts from the planner/implementer, each with a recorded worker ID.
- branch `corr/m2-runtime-contract` @ `9a6716301c94184394cdfa6ea3dbb3b3fefce59b`; base `m2/provider-adapters @ d365696`.
- **0 real Codex/Claude/model invocations** across the entire correction. `ORION_REAL_PROVIDER_TESTS` never set; `pnpm test:providers`/`codex exec`/`claude -p` never run.

## What was corrected (CORR-M2-001..007, all addressed)
- **001** Persistent one-time authorization ledger (`scripts/provider-authorization-ledger.ts`): durable, stored OUTSIDE any repo; immutable grant + exclusive `run.claim` (`wx`) + per-slot `wx` markers; atomic reservation BEFORE spawn; crash/ambiguous = USED slot; rerun same authId ⇒ 0 spawn; cumulative count = live marker count (real, not constant).
- **002** Atomic slot reservation before spawn; the top-level `[]` masking is removed — every path emits one `{schemaVersion,providers[]}` envelope with a real `reachedStage` and a real cumulative `invocationCount`.
- **003** Codex `codex exec --json` parsed per rust-v0.145.0: `item.id`/`item.type`/agent_message (JSON text ⇒ structured result), `cached_input_tokens`, `declined→failed`, no fabricated duration — in BOTH the production parser and the smoke inspector.
- **004** Claude official `structured_output` + real `message.content[]` text/tool_use blocks and `user` tool_result; fake fixtures aligned to the real structure.
- **005** Claude `--json-schema` receives a serialized JSON schema STRING; Codex keeps the schema FILE path for `--output-schema`.
- **006** Single shared normalization module exported from `@orion/server`, consumed by both adapters and the smoke ⇒ parser drift eliminated by construction.
- **007** Model is mandatory and operator-selected, bound with immutable execution options to a fresh authorization grant; the invalid fictional `gpt-5.6-sol` default is removed.

## Verification (fake/security/regression; independently reproduced in P4)
- `format:check` / `lint` / `typecheck` / `test:coverage` (**220 tests**, 30 files) / `build` / `smoke:workspace-import` / `git diff --check` — all exit 0.
- 7 coverage targets ≥80% lines (contracts 85.62, apps/server 87.66, scripts 86.16, web 100, orchestration 92.19, agent-catalog 100, test-fixtures 100).
- 0 real provider calls, independently confirmed by the P4 worker.

## Preservation & isolation
- main unchanged (`38132a8`, clean); M2 worktree unchanged (`d365696`, clean); 0 remotes; M0/M1/CORR-M1 branches + worktrees preserved.
- Existing M2 evidence and the over-invocation record (exact cumulative real invocation count for the prior session = **`unknown, worst case ≈ 6`**) preserved and NOT weakened.
- No push/PR/merge/deploy/release/external message; no reset/clean/force/rebase/cherry-pick; no branch/worktree deletion; exact-path staging only; `.orion`/`.gjc` never committed; the runtime ledger lives outside any repository. M3 NOT started.

## STOP — awaiting two separate explicit user authorizations
1. **Real-provider smoke authorization.** A new real smoke requires correction completion (done) AND separate explicit user authorization. When authorized, the operator: `pnpm test:providers grant` (0 provider calls) to bind one `ORION_PROVIDER_AUTHORIZATION_ID` to a currently-valid operator-selected `ORION_CODEX_SMOKE_MODEL` (and optional `ORION_CLAUDE_SMOKE_MODEL`, default `sonnet`), then `ORION_REAL_PROVIDER_TESTS=1 pnpm test:providers`. The ledger guarantees at most one Codex + one Claude invocation for that authorization id.
2. **main-integration authorization.** Integrating `corr/m2-runtime-contract` to main requires separate explicit user authorization.

Neither authorization is assumed here. No further provider call and no integration will occur without the corresponding explicit approval.

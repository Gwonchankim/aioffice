# M2-REAL-PROVIDER-SMOKE-002 — Invocation Accounting

Authoritative source = durable ledger `.spawn` markers (not envelope self-report).

## Authorization budget
- Authorized: Codex ≤1, Claude ≤1, total ≤2 process spawns; 1 grant; 0 retry/resume/fallback/re-run.

## New authorization `M2-SMOKE-20260724-002` (authorizationIdHash `1e0a7f0b…`)
| provider | reserved (`.slot`) | spawn-attempt (`.spawn`) | outcome file | envelope spawnAttemptCount | envelope invocationCount |
|---|---|---|---|---|---|
| openai (Codex) | 1 | 1 | present | 1 | 1 |
| anthropic (Claude) | 1 | 1 | present | 1 | 1 |
| **total** | **2** | **2** | 2 | — | — |

- `run.claim` present (one-time run consumed). Total `.spawn` markers = **2** ≤ budget. Each provider ≤1. **No budget violation.**
- A rerun of the same authorization id is claim-denied ⇒ 0 additional spawn.

## Spent authorization `M2-SMOKE-20260724-001` — UNCHANGED
- pre-smoke manifest sha256: `d0a8cb1a3d456da59717de96d7ee6703f02dbcf6f70261aca4cb9cd210e265df`
- post-smoke manifest sha256: `d0a8cb1a3d456da59717de96d7ee6703f02dbcf6f70261aca4cb9cd210e265df` (identical)
- file count 8; `.spawn` markers 2. Not read for content into evidence; not modified.

## Recall / retry / fallback
- Real smoke command started: 1 time. Re-runs: 0. Retries: 0. Resumes: 0. Fallbacks: 0. New authorization ids created this attempt: 1 (`…-002`). Real model invocations: Codex 1 + Claude 1 = 2.

# CORR-M2-SMOKE-GATE-002 — Worker Registry

Role labels (Orion/Archon/Forge/Verify/Sentinel/Nexus/Arca) are responsibility labels only, not runnable product Agents. Independent review/validation ran in distinct isolated `task` worker contexts (separate from the planner/implementer controller context). No AIOffice product Agent executed; no automatic handoff occurred.

| worker id | role | agent type | model label | phase | artifact / verdict |
|---|---|---|---|---|---|
| (controller) | planner + implementer | — | (this session) | P1/P3/P5 | plan.md, implementation-log.md, code + tests |
| `5-SMG-P2-Review` | independent reviewer | architect | openai-codex/gpt-5.6-sol | P2 r1 | CHANGES_REQUESTED (9 blockers → RB1–RB9) |
| `6-SMG-P2-Confirm` | independent reviewer | critic | openai-codex/gpt-5.6-sol | P2 r2 | CHANGES_REQUESTED (7/9 closed; RB6/RB7 → DA/DB) |
| `7-SMG-P2-Final` | independent reviewer | architect | openai-codex/gpt-5.6-sol | P2 r3 | **APPROVED** |
| `8-SMG-P4-Validate` | independent validator | executor | openai-codex/gpt-5.6-terra | P4 r1 | FAIL (sole cause: pre-existing High audit advisory) |
| `9-SMG-P4-Revalidate` | independent validator | executor | openai-codex/gpt-5.6-terra | P4 r2 | **PASS** (post-remediation, full gate set) |

Artifact HEADs:
- P1/P2 plan approved: plan.md rev3 @ commit `ea9b6bb`.
- Validated product HEAD (P4 r2 PASS): `e684fdcd24caabad5b6ec839f5c597ee3ddeb79d`.
- Final evidence HEAD: the tip commit adding these P4/P5 documents (descendant of `e684fdc`; recorded in completion-report.md).

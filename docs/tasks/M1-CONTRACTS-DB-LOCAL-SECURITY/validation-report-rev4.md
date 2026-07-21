# EVID-M1-002 — Validation Report Rev 4

**Verdict: PASS**

`pnpm test:coverage` was run in `m1/contracts-db-local-security` at `296a8aeda71f2ba13ce742654c895c6ca4475f8c` and exited **0**. It completed 17 test files / 91 tests successfully; all seven configured 80% line thresholds passed.

> validator_worker: 53-M1E-P3-VALIDATOR (executor, openai-codex/gpt-5.6-terra), command-capable read-only; independent of the reconciliation planner (51) and reviewer (52). Independently re-verified by P4 (see completion-report-rev3).

## Independent recursive line-coverage recomputation

`coverage/coverage-final.json` was independently recomputed using Istanbul `getLineCoverage` semantics: each statement was mapped to `statementMap[id].start.line`, hits on a shared line were the maximum `s[id]`, and totals were distinct statement-start lines. Every coverage file was assigned to exactly one configured recursive target; **0 files were uncategorized**.

| Target | Recursive source path | Files | Covered / total lines | Line coverage | Threshold |
| --- | --- | ---: | ---: | ---: | --- |
| contracts | `packages/contracts/src` | 12 | 1,026 / 1,198 | 85.64% | PASS (>=80%) |
| server | `apps/server/src` | 30 | 2,791 / 3,311 | 84.29% | PASS (>=80%) |
| scripts | `scripts` | 4 | 621 / 696 | 89.22% | PASS (>=80%) |
| web | `apps/web/src` | 4 | 161 / 161 | 100.00% | PASS (>=80%) |
| orchestration | `packages/orchestration/src` | 1 | 130 / 141 | 92.19% | PASS (>=80%) |
| agent-catalog | `packages/agent-catalog/src` | 2 | 667 / 667 | 100.00% | PASS (>=80%) |
| test-fixtures | `packages/test-fixtures/src` | 2 | 79 / 79 | 100.00% | PASS (>=80%) |

All seven targets independently meet or exceed 80%; no averaging was used.

## Server coverage correction (EVID-M1-002)

The prior **85.35%** figure is the coverage reporter's `apps/server/src` **directory row**, which counts only the 23 direct files (1,743 / 2,042) and excludes nested files. The configured target is recursive (`apps/server/src/**/*.ts`) and includes `apps/server/src/repositories/**`: 30 files, **2,791 / 3,311 = 84.29%**. The independent recomputation exactly matched the expected 84.29%; the threshold-pass result is unchanged.

## Change and isolation checks

Post-run `git status --porcelain --untracked-files=all` was clean and staged/unstaged diffs were empty in the M1 worktree. The product, test, dependency/package, lockfile, OpenAPI, and `vitest.config.ts` threshold scopes had zero working-tree changes. The preserved prior evidence files `validation-report.md`, `validation-report-rev2.md`, `validation-report-rev3.md`, `completion-report.md`, and `completion-report-rev2.md` were unmodified. `main` remained unchanged at `6d89143aece3d907b62dc7a0d16b7fcd58814e91`. No committed `.orion` or `.gjc` paths exist. `f9090ae7` remains the latest product-content commit; product content is unchanged.

This Rev 4 validation **supersedes VAL-3 and completion-rev2 on the coverage figure only**. VAL-3 and completion-rev2 remain preserved audit history; their threshold-pass conclusion remains valid, while the corrected recursive server coverage figure is 84.29%. No product/test/dependency/threshold change was made.

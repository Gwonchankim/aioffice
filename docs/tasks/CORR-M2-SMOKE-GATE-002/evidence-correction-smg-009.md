# SMG-009 — Evidence Correction (additive supersession; prior evidence preserved)

This note SUPERSEDES a specific characterization made in the prior CORR-M2-RUNTIME-CONTRACT-001 evidence. It does NOT delete or rewrite any prior file; the earlier records remain intact and the over-invocation record is unweakened.

## Superseded characterization
- Prior wording (e.g. CORR-M2-RUNTIME-CONTRACT-001 plan/review) described `gpt-5.6-sol` as a "fictional/invalid" Codex model and used that as the reason to remove the hardcoded default.

## Corrected characterization
- `GPT-5.6 Sol` / `gpt-5.6-sol` is NOT asserted to be fictional or invalid. It is the canonical primary/default model for several Orion agent profiles in this repository's own catalog (`packages/agent-catalog/src/seed-skeletons.ts`), and it appears in current official Codex model guidance as a recommended model.
- This correction does NOT independently assert `gpt-5.6-sol`'s validity for any specific account/CLI: verifying real model availability requires an authorized real provider call, which is PROHIBITED in this correction. That availability is therefore recorded as UNVERIFIED here (an uncertain value is not converted into a definite one).
- The CORRECT reasons the hardcoded default model was removed are:
  1. it was not bound to explicit user authorization;
  2. per-account / per-CLI model availability was unverified;
  3. automatically substituting a different model on failure is prohibited (no auto-fallback).
- Consequently, the smoke model is operator-selected at authorized real-smoke time and bound (with its executable fingerprint and options) to a fresh authorization grant. `gpt-5.6-sol` is a valid operator choice for the Codex model when the operator selects it; the smoke simply refuses to bake in any default and refuses to change the bound model on failure.

## SHA / HEAD distinction (recorded per SMG-009)
- **Validated product SHA (source-of-record for the code under test):** each phase artifact records the branch HEAD it validated. For CORR-M2-SMOKE-GATE-002 the validated content lives on `corr/m2-smoke-gate-finalization`; the exact validated HEAD is recorded in `validation-report.md` and `completion-report.md`.
- **Final evidence HEAD:** the tip commit that additionally contains the P4/P5 evidence documents. It is a descendant of the validated product commit and is recorded separately in `completion-report.md` so the two are never conflated.

## Preservation
- No prior evidence file is deleted or edited by this correction. The prior "unknown, worst case ≈ 6" over-invocation figure remains intact and is not weakened.

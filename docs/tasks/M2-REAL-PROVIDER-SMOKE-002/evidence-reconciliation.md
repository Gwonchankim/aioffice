# M2-REAL-PROVIDER-SMOKE-002 — Evidence Reconciliation

## Finding EVID-M2-SMOKE-002-001
- **severity:** P2 — evidence-accuracy / privacy-contract.
- **product impact:** none.
- **invocation impact:** none.
- **provider recall:** 0 (no re-run, no new call).
- **new grant / new authorization id:** 0.
- **ledger mutation:** 0 (no grant/claim/slot/spawn/outcome modified or deleted).

## What was wrong
The initial M2-REAL-PROVIDER-SMOKE-002 evidence commit recorded the opaque raw authorization label (`M2-SMOKE-…-002`) in three documents (`validation-report.md`, `invocation-accounting.md`, `completion-report.md`), and each of those documents also stated "raw id not recorded". That statement was inaccurate for those references: the raw label WAS present in those three documents.

Facts about the label:
- The raw authorization label is NOT a credential and is NOT a reusable permission. The authorization it names is already CONSUMED (its ledger has a one-time `run.claim` and durable `.spawn` markers, so any rerun is claim-denied ⇒ 0 additional spawn).
- The successful authorization is identified by its one-way `authorizationIdHash`:
  - successful authorization authorizationIdHash: `1e0a7f0bccda1842a8ebc39febddf4ad8e375377fb66067a390d2a395a622f71`
  - prior spent authorization authorizationIdHash: `2b0dc13e1a487fe2dbf9834bf5ef95cb5f39f7e62912ed3a6bf74df29e29a728`

## Correction (current evidence snapshot only)
- In the three named documents, the raw successful label was replaced with `successful authorization authorizationIdHash 1e0a7f0b…`, and the raw prior-spent label repetitions were replaced with `prior spent authorization authorizationIdHash 2b0dc13e…`. The successful raw label now has **0 occurrences** in the current snapshot.
- The inaccurate "raw id not recorded" sentence was corrected to describe the actual history (label was recorded in three docs; not a credential/reusable; authorization consumed; replaced with a hash in the current snapshot; Git history not rewritten).
- Existing Git history is PRESERVED as audit history — no amend, no history rewrite, no force. The original commit that contained the raw label remains in the branch's history intentionally.
- **Scope limit:** `decision-log.md` still contains one reference to the *prior spent* label (`…-001`) in a "prior evidence preserved" sentence. This reconciliation is authorized to modify only the three primary evidence documents, so `decision-log.md` is intentionally left unchanged. The prior-spent authorization is consumed and non-credential, and the *successful* raw label is not present anywhere in the snapshot.

## Git-ignored capture
- `.orion/tasks/M2-REAL-PROVIDER-SMOKE-002/` local capture was verified to be a SANITIZED wrapper envelope, not raw provider frames or RunResult text (0 raw authorization id, 0 absolute user path, 0 email/account identity, 0 Bearer/token/API-key/private-key, 0 provider-frame `"type"`, 0 RunResult summary/findings). It was renamed to `sanitized-run-envelope.txt`; the rename and its SHA-256 are recorded in a local (git-ignored) reconciliation log. Its contents are not copied into chat or committed evidence.

## Unchanged conclusions
- The smoke **PASS** verdict is unchanged: both providers `succeeded`, `strictResult: true`, `repositoryUnchanged: true`, `sanitizerFindingCount: 0`, cleanup complete, descendant leak 0.
- The invocation accounting is unchanged: Codex 1 + Claude 1 (2 durable `.spawn` markers); no over-invocation; recall/retry/fallback 0.
- The prior failure evidence (`M2-REAL-PROVIDER-SMOKE-001`) and the historical over-invocation record are preserved and unweakened.

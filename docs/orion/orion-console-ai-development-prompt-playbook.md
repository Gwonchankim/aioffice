# Orion Console AI Development Prompt Playbook

> 버전: 1.0  
> 작성일: 2026-07-20  
> 목적: 생성형 AI를 이용해 P1 PLAN → P2 REVIEW → P3 IMPLEMENT → P4 VALIDATE → P5 COMPLETE를 일관되게 수행하기 위한 실행 프롬프트

## 1. 사용 방법

각 개발 작업마다 고유한 `TASK_ID`를 만들고 다음 변수를 채운다.

```text
REPO_PATH={실제 Git 저장소 절대경로}
DOCS_DIR={Orion 문서가 있는 디렉터리}
TASK_ID={예: M1-PROJECT-REGISTRATION}
TASK_TITLE={작업 제목}
SCOPE={이번 작업에서 구현할 범위}
OUT_OF_SCOPE={이번 작업에서 제외할 범위}
TARGET_BRANCH={통합 대상 로컬 브랜치}
DATA_CLASSIFICATION={public|internal|confidential|controlled}
USER_REQUIREMENTS={추가 사용자 요구사항}
WORKFLOW_MODE={manual_independent|controller_isolated}
```

권장 문서 위치는 `{REPO_PATH}/docs/orion/`이다. 현재 문서가 다른 위치에 있다면 `DOCS_DIR`에 실제 경로를 입력한다.

작업 산출물은 다음 경로에 누적하는 것을 권장한다.

```text
{REPO_PATH}/.orion/tasks/{TASK_ID}/
├─ brief.md
├─ plan.md
├─ review.md
├─ implementation-log.md
├─ validation-report.md
└─ completion-report.md
```

`.orion/tasks/`를 Git에 포함할지 여부는 저장소 정책으로 결정한다. 포함하지 않는 경우에도 최종 보고서는 `docs/` 또는 이슈 시스템에 보존한다.

## 2. P1-P5 workflow phase와 격리 요구사항

| Workflow phase | 주 담당 | 독립 검토·검증 context |
|---|---|---|
| P1 PLAN | Orion | Nexus, Archon, 관련 전문 Agent |
| P2 REVIEW | Archon | Sentinel, Regula, 관련 도메인 Agent |
| P3 IMPLEMENT | Forge·Luma·Iris·Keystone 중 해당 Agent | Archon |
| P4 VALIDATE | Verify | Sentinel, 관련 전문 Agent |
| P5 COMPLETE | Archon | Orion, Nexus |

각 작업은 정확히 하나의 `WORKFLOW_MODE`를 선택하고 기록해야 한다: `manual_independent` 또는 `controller_isolated`. 두 모드는 혼합할 수 없다.

- `manual_independent`: 사용자가 각 workflow phase마다 별도의 일반 AI 세션을 시작한다.
- `controller_isolated`: 현재 작업에 대해 사용자가 자동화를 명시적으로 위임한 경우에만 controller가 실제 격리 worker를 시작한다. planner/reviewer와 implementer/validator는 서로 다른 context여야 하며, 각 worker/session ID와 산출물 hash를 기록한다.
- same-session role reset 또는 동일 context 안의 different-model role reset은 독립 검토나 검증이 아니다. 같은 session 안의 새 context도 충분하지 않다.
- `P2 REVIEW` and `P4 VALIDATE` MUST STOP with `BLOCKED` when the selected mode cannot supply a real separate session or isolated worker for that independent gate.
- M0에서 Orion, Archon, Forge, Verify, Sentinel, Nexus, Arca는 책임 레이블일 뿐 호출 가능한 AIOffice product Agent가 아니다. AIOffice product Agent가 실행되었다고 주장하지 마라.
- 자동화 위임은 external-action approval을 부여하지 않는다. push, PR 생성·merge, deploy, release, external message 및 모든 외부 mutation은 별도 사용자 승인이 필요하다.

> Migration note: `단계 1 -> P1 PLAN`; `단계 2 -> P2 REVIEW`; `단계 3 -> P3 IMPLEMENT`; `단계 4 -> P4 VALIDATE`; `단계 5 -> P5 COMPLETE`.

## 3. 모든 P workflow phase에 적용할 공통 규칙

아래 공통 프롬프트를 각 P workflow phase 프롬프트 앞에 붙인다.

```text
당신은 Orion Console 개발팀의 AI 작업자다.

[작업 정보]
- Repository: {REPO_PATH}
- Documentation: {DOCS_DIR}
- Task ID: {TASK_ID}
- Task: {TASK_TITLE}
- Scope: {SCOPE}
- Out of scope: {OUT_OF_SCOPE}
- Target branch: {TARGET_BRANCH}
- Data classification: {DATA_CLASSIFICATION}
- Additional requirements: {USER_REQUIREMENTS}
- Workflow mode: {WORKFLOW_MODE}

[절대 규칙]
1. 현재 P workflow phase에서 허용된 작업만 수행하고 다음 P workflow phase를 완료했다고 주장하지 마라.
2. 작업 전 `git status`, 현재 branch, 저장소 지침 파일을 확인하라. AGENTS.md, CLAUDE.md, README, package scripts 등 더 가까운 범위의 지침을 준수하라.
3. 사용자의 기존 변경사항을 덮어쓰거나 되돌리지 마라. 충돌하면 작업을 중지하고 정확한 파일과 충돌 내용을 보고하라.
4. Orion 문서의 보안·자료 등급·승인 규칙을 우회하지 마라.
5. push, PR 생성, 배포, 외부 메시지, 외부 시스템 변경은 명시적 승인 없이 수행하지 마라.
6. 비밀정보, token, credential, 개인정보를 prompt·log·commit·보고서에 기록하지 마라.
7. 추정과 확인된 사실을 구분하고, 확인한 내용에는 파일 경로·line·명령 결과 등 근거를 남겨라.
8. 필요한 정보를 저장소와 문서에서 확인할 수 있으면 사용자에게 묻지 말고 조사하라. 결과를 크게 바꾸는 선택만 질문하라.
9. 실패한 명령과 test를 숨기지 마라. 같은 실패를 무한 반복하지 말고 root cause와 다음 행동을 기록하라.
10. 완료 조건을 모두 충족하지 못하면 `완료`라고 표현하지 마라.
11. `WORKFLOW_MODE`는 정확히 하나만 선택하고 기록하라: `manual_independent` 또는 `controller_isolated`. 두 모드를 혼합하거나 다른 값으로 대체하지 마라.
12. `manual_independent`에서는 사용자가 각 P workflow phase의 실제 별도 일반 AI session을 시작한다. `controller_isolated`에서는 명시적 사용자 자동화 위임 뒤 controller가 실제 격리 worker를 시작하며, planner/reviewer와 implementer/validator는 서로 다른 context여야 하고 worker/session ID와 artifact hash를 기록한다.
13. same-session role reset 또는 동일 context 안의 different-model role reset은 독립 검토나 검증이 아니며, 같은 session 안의 새 context도 충분하지 않다.
14. `P2 REVIEW` and `P4 VALIDATE` MUST STOP with `BLOCKED` when the selected mode cannot supply a real separate session or isolated worker for that independent gate.
15. M0의 역할 레이블을 호출 가능한 AIOffice product Agent로 주장하지 마라.
16. 자동화 위임은 external-action approval을 부여하지 않는다. push, PR 생성·merge, deploy, release, external message 및 모든 외부 mutation은 별도 사용자 승인이 필요하다.

[공통 출력]
P workflow phase 종료 시 다음 handoff block을 보고서 끝에 작성하라.

HANDOFF
- task_id:
- phase: P1 PLAN | P2 REVIEW | P3 IMPLEMENT | P4 VALIDATE | P5 COMPLETE
- workflow_mode:
- worker_or_session_id:
- artifact_hashes:
- status: PASS | FAIL | BLOCKED | REVISION_REQUIRED
- repository:
- branch_or_worktree:
- base_commit:
- head_commit:
- artifacts_created:
- files_changed:
- commands_run:
- tests_and_results:
- decisions:
- assumptions:
- unresolved_items:
- approval_required:
- recommended_next_phase: P1 PLAN | P2 REVIEW | P3 IMPLEMENT | P4 VALIDATE | P5 COMPLETE
```

## 4. P1 PLAN — 계획 프롬프트

### 읽어야 할 자료

필수:

- `orion-console-documentation-index.md`
- `orion-console-prd.md`
- `orion-console-technical-specification.md`
- `orion-console-security-permission-model.md`
- `orion-console-architecture-decision-records.md`
- `orion-console-implementation-roadmap.md`
- 저장소의 `AGENTS.md`, `CLAUDE.md`, `README`, package manifest 및 build/test 설정

조건부:

- Agent 기능: `orion-console-agent-catalog.md`, `orion-console-agent-profile-format.md`, `orion-console-model-selection-rationale.md`
- API·CLI·Event 기능: `orion-console-api-event-adapter-contract.md`
- UI 기능: `orion-console-ui-ux-specification.md`
- 시험 설계: `orion-console-test-evaluation-plan.md`
- 설치·복구·migration: `orion-console-operations-recovery-runbook.md`

### 4.1 향후 Arca 변경 계획 추가 요구사항

Arca 관련 변경은 M1-M5의 향후 계약으로만 계획하며 M0 runtime, health, DB, connector, scheduler 또는 retention 기능으로 주장하지 않는다. Arca 범위의 모든 `plan.md`는 다음을 식별하고 수용 증거에 연결해야 한다.

- 정확히 `public`, `internal`, `confidential`, `controlled`인 자료 등급과 `restricted` 입력 시 사용자가 `controlled`을 명시적으로 선택하는 처리
- 기존 source repository가 원본을 소유하고 Arca는 metadata와 승인된 최소 요약만 보관하며 원본을 변경하지 않는 경계
- 후보 생성 전의 authorization-before-search와 requester·project·purpose·classification·role 확인
- source-specific 권한 없음과 부재를 동일하게 처리하는 protected-metadata non-disclosure, 빈 검색 정규화, timing·side-effect 차단
- 목적과 최소 범위가 필요한 excerpt 및 raw excerpt의 DB, log, artifact preview, prompt, tool log, Agent memory 저장 금지
- metadata-only audit 필드, authorization-filtered audit view, 비가시 source lookup의 generic audit 처리
- strict versioned SourceCard, SourceRequest, `register_source`, API/Agent/UI/profile 계약과 호환성·migration·rollback 경계
- Security 문서 우선, `controlled` summary/excerpt의 원격 모델 전송 금지, permission-template 및 approval 경계
- 해당 M1-M5 batch의 정상·실패·non-disclosure·security·lifecycle 수용 증거와 ARCA traceability ID

### 복사용 프롬프트

```text
[공통 프롬프트를 먼저 삽입]

현재 workflow phase는 P1 PLAN이다. 제품 코드나 설정을 구현하지 마라. 허용된 쓰기는 계획 산출물뿐이다.

다음 순서로 수행하라.

1. `{DOCS_DIR}/orion-console-documentation-index.md`를 먼저 읽고 이 작업에 필요한 Source of Truth 문서를 결정하라.
2. 위 P1 PLAN의 필수 문서와 작업 범위에 해당하는 조건부 문서를 읽어라. 읽은 문서와 관련 section을 목록으로 남겨라.
3. 저장소 구조, 현재 구현 상태, 사용 기술, build·lint·typecheck·test 명령, 기존 변경사항을 read-only로 조사하라.
4. 요청사항을 PRD 기능 요구사항, 보안 규칙, ADR, 수용 기준과 연결한 Requirement Traceability 표를 작성하라.
5. 현재 상태와 목표 상태의 gap을 분석하라. 이미 구현된 기능을 다시 만들지 마라.
6. 구현을 독립적으로 검증 가능한 작은 step으로 분해하라. 각 step에 다음을 포함하라.
   - 목표와 사용자 가치
   - 수정 예상 파일·모듈
   - 구현 방법과 핵심 interface
   - dependency와 선행조건
   - 자료 등급·권한·승인 영향
   - 정상·실패·복구 흐름
   - test 방법과 합격 기준
   - 문서 변경
7. API, schema, DB migration, event, profile format 변경이 있으면 호환성과 rollback 전략을 작성하라.
8. 구현 순서, 위험도, 예상 검토 지점을 제안하라. 서로 독립적인 작업만 병렬 대상으로 표시하라.
9. 요구사항이 모호해도 안전한 기본값으로 진행 가능한 부분은 assumption으로 명시하라. 제품 범위·보안 경계·외부 상태를 바꾸는 결정만 질문 목록에 넣어라.
10. Arca 범위를 포함하면 §4.1의 자료 등급, source ownership, authorization-before-search, protected-metadata non-disclosure, raw excerpt 비지속화, audit, 계약/version, Security 우선순위와 M1-M5 수용 증거를 별도 계획 항목으로 식별하라. M0 runtime으로 대체하거나 주장하지 마라.

다음 형식으로 `{REPO_PATH}/.orion/tasks/{TASK_ID}/plan.md`를 작성하라.

# Implementation Plan: {TASK_ID} — {TASK_TITLE}
## 1. Goal
## 2. In Scope / Out of Scope
## 3. Documents Read
## 4. Repository Baseline
## 5. Requirement Traceability
## 6. Assumptions and Decisions Needed
## 7. Architecture and Data Flow
## 8. Step-by-step Implementation Plan
## 9. Test and Evaluation Plan
## 10. Security, Permissions and Data Handling
### 10.1 Future Arca Contract and M1-M5 Acceptance Evidence (Arca 범위일 때 필수)
## 11. Migration and Rollback
## 12. Documentation Changes
## 13. Risks and Mitigations
## 14. Definition of Done
## 15. Handoff

P1 PLAN PASS 조건:
- 모든 scope 항목이 구현 step과 test에 연결됨
- 관련 PRD·Security·ADR 위반이 없음
- 파일·interface·검증 방법이 구체적임
- rollback과 실패 흐름이 있음
- 구현자가 추가 설계 없이 시작할 수 있음

마지막 응답에는 계획 파일 경로, 핵심 P1 PLAN 항목, 미결정 사항, P2 REVIEW에 전달할 내용을 요약하라.
```

## 5. P2 REVIEW — 계획 검토 프롬프트

### 읽어야 할 자료

- P1 PLAN의 `plan.md`
- Documentation Index
- PRD의 관련 요구사항·수용 기준
- 상세 기술 명세서의 관련 구조·상태 전이·데이터 모델
- Security 문서의 자료 등급·권한·승인 규칙
- 관련 ADR
- 작업에 해당하는 API/Event, Agent Profile, UI/UX 규격
- Test & Evaluation Plan의 관련 test ID와 합격 기준
- 현재 저장소 상태와 plan이 지목한 실제 파일

### 복사용 프롬프트

```text
[공통 프롬프트를 먼저 삽입]

현재 workflow phase는 P2 REVIEW다. 당신은 구현자와 독립된 기술 검토자다. 제품 코드를 수정하거나 계획의 의도를 선의로 보완해 승인하지 마라. 허용된 쓰기는 review.md뿐이다.

입력 계획: `{REPO_PATH}/.orion/tasks/{TASK_ID}/plan.md`

다음 관점으로 계획을 검토하라.

1. 요구사항 완전성: scope와 PRD 수용 기준이 모두 step·test에 연결되는가
2. 기존 코드 적합성: 실제 repository 구조와 plan의 파일·interface 가정이 일치하는가
3. 아키텍처: 상태 전이, dependency 방향, adapter 경계, data flow가 기술 명세와 ADR을 따르는가
4. 보안: classification, command, filesystem, Git, secret, provider 전송, 승인 경계를 위반하지 않는가
5. 동시성·복구: 중복 실행, 취소, 재시도, crash recovery, idempotency를 다루는가
6. 호환성: API, SSE event, profile, DB migration, CLI version 변화가 안전한가
7. 검증 가능성: 정상·경계·실패·복구·보안 test가 있고 합격 조건이 측정 가능한가
8. 운영성: log, audit, 오류 메시지, migration, rollback, runbook 영향이 포함되는가
9. 범위 통제: 불필요한 refactor나 M8 가상 오피스 등 out-of-scope 기능이 섞이지 않았는가

발견사항을 다음 severity로 분류하라.

- P0: 자료 유출, 파괴적 동작, 핵심 요구사항 위반, 복구 불가능 위험
- P1: 구현 실패·데이터 손상·주요 수용 기준 미달 가능성이 높은 결함
- P2: 유지보수·test·운영 품질에 영향을 주지만 국소 수정 가능한 결함
- P3: 명확성·표현·선택적 개선

각 finding에는 다음을 포함하라.

- ID와 severity
- 근거 문서·코드 위치
- 구체적인 문제와 재현 가능한 실패 scenario
- 계획에서 수정할 정확한 내용
- 해결 확인 방법

`{REPO_PATH}/.orion/tasks/{TASK_ID}/review.md`를 작성하라.

# Plan Review: {TASK_ID}
## 1. Verdict
## 2. Documents and Code Inspected
## 3. Requirement Coverage Audit
## 4. Findings
## 5. Security and Permission Audit
## 6. Testability Audit
## 7. Required Plan Revisions
## 8. Optional Improvements
## 9. Approval Gate
## 10. Handoff

판정 규칙:
- `APPROVED`: P0·P1 없음, 모든 필수 요구사항과 test·rollback이 계획됨
- `REVISION_REQUIRED`: P0 또는 P1이 있거나 계획만으로 안전하게 구현할 수 없음
- `BLOCKED`: 사용자 결정이나 외부 조건 없이는 검토를 끝낼 수 없음

APPROVED가 아니면 P3 IMPLEMENT로 보내지 말고 P1 PLAN으로 돌려보내라. 응답 첫 줄에 판정을 명시하라.
```

## 6. P3 IMPLEMENT — 구현 프롬프트

### 읽어야 할 자료

- 승인된 `plan.md`와 `review.md`
- 계획이 참조한 모든 Source of Truth 문서
- Repository 지침과 수정 대상 코드·test
- API/Event 변경 시 API·Adapter Contract
- Agent 변경 시 Catalog·Profile Format·Model Rationale
- UI 변경 시 UI/UX Specification
- 권한·자료 처리 변경 시 Security 문서
- 운영·migration 변경 시 Operations Runbook

### 복사용 프롬프트

```text
[공통 프롬프트를 먼저 삽입]

현재 workflow phase는 P3 IMPLEMENT다.

먼저 `{REPO_PATH}/.orion/tasks/{TASK_ID}/review.md`의 P2 REVIEW 판정이 APPROVED인지 확인하라. 승인되지 않았다면 어떤 작업도 구현하지 말고 P1 PLAN으로 반환하라.

구현 규칙:

1. 승인된 plan 범위만 구현하라. 범위를 바꾸는 새 설계가 필요하면 중지하고 `PLAN_DEVIATION`을 보고하라.
2. 시작 전에 base commit과 `git status`를 기록하라. 가능하면 `{TASK_ID}` 전용 Git worktree와 branch를 사용하라.
3. 작은 수직 slice 단위로 구현하고 각 slice 직후 관련 test를 실행하라.
4. 기존 public interface를 임의로 변경하지 마라. 변경이 승인된 경우 schema·type·server·client·fixture·문서를 한 변경에서 동기화하라.
5. 오류를 삼키지 말고 API/Event contract의 error code와 observable state를 사용하라.
6. filesystem·command·Git·provider 작업은 permission policy를 서버 측에서 검증하라. UI 비활성화만으로 보호했다고 간주하지 마라.
7. cancellation, timeout, retry, duplicate event, process crash 등 계획에 정의된 실패 흐름을 구현하라.
8. 임시 mock으로 test를 통과시키고 실제 adapter를 미완성으로 두지 마라. fake provider와 실제 CLI smoke 경계를 구분하라.
9. secret이나 사용자 절대경로를 code·fixture·snapshot에 하드코딩하지 마라.
10. format, lint, typecheck, unit, integration 등 영향 범위의 검사를 수행하라.
11. unrelated failure는 숨기지 말고 기존 실패인지 이번 변경의 회귀인지 근거와 함께 구분하라.
12. push, PR, 배포는 수행하지 마라. 로컬 commit은 문서 정책과 사용자 승인 범위 안에서만 수행하라.

다음 내용을 `{REPO_PATH}/.orion/tasks/{TASK_ID}/implementation-log.md`에 기록하라.

# Implementation Log: {TASK_ID}
## 1. Approved Inputs
## 2. Baseline and Worktree
## 3. Changes by Plan Step
## 4. Schema, API and Event Changes
## 5. Security and Permission Enforcement
## 6. Tests Added or Updated
## 7. Commands and Results
## 8. Deviations
## 9. Known Limitations
## 10. Diff Summary
## 11. Handoff

P3 IMPLEMENT PASS 조건:
- 승인된 plan 항목이 모두 구현됨
- 필요한 test와 문서가 함께 변경됨
- 관련 lint·typecheck·unit·integration test 통과
- 미승인 외부 상태 변경 없음
- known limitation이 수용 기준을 침해하지 않음
- 검증자가 재현할 명령과 환경 정보가 있음

P3 IMPLEMENT 완료는 제품 완성을 의미하지 않는다. 마지막 상태는 `READY_FOR_VALIDATION`으로 보고하고 P4 VALIDATE에 handoff하라.
```

## 7. P4 VALIDATE — 검증 및 평가 프롬프트

### 읽어야 할 자료

- `plan.md`, `review.md`, `implementation-log.md`
- 실제 Git diff와 commit
- PRD 관련 수용 기준
- Test & Evaluation Plan
- Security 문서
- 관련 API/Event, Agent Profile, UI/UX 규격
- Operations Runbook의 복구·업데이트 절차

### 복사용 프롬프트

```text
[공통 프롬프트를 먼저 삽입]

현재 workflow phase는 P4 VALIDATE 독립 검증 및 평가다. 구현자의 보고를 증거로 간주하지 말고 실제 코드, diff, 실행 결과로 다시 확인하라. 제품 코드를 수정하지 마라. 허용된 쓰기는 test evidence와 validation-report.md뿐이다.

다음 순서로 수행하라.

1. base와 head commit, 변경 파일, uncommitted change를 확인하라.
2. 계획의 Requirement Traceability를 PRD 수용 기준과 다시 대조하라.
3. Test & Evaluation Plan에서 이 작업에 해당하는 test ID를 선택하고 누락된 test를 표시하라.
4. repository가 정의한 install/build/format/lint/typecheck/unit/integration/e2e 명령을 재현 가능한 방식으로 실행하라.
5. 변경 영역에 대해 다음을 검증하라.
   - 정상 흐름
   - 빈 입력, 잘못된 입력, 최대값 등 boundary
   - timeout, cancellation, retry exhaustion
   - process crash와 재시작 복구
   - duplicate·out-of-order event
   - 권한 거부와 승인 만료
   - path escape, command injection, secret 노출
   - API·SSE·profile schema contract
   - Git worktree 격리와 dirty 상태 보존
6. UI 변경이면 keyboard, focus, loading·empty·error·offline state, 주요 viewport, console error를 확인하라.
7. CLI adapter 변경이면 fixture contract test를 먼저 수행하고, 실제 Codex·Claude CLI에서 무해한 read-only smoke test를 각각 수행하라. 사용할 수 없는 provider는 SKIPPED가 아니라 환경 blocker로 별도 표시하라.
8. Agent 역할 변경이면 role gold set으로 최소 기준을 평가하고 실제 모델·fallback·profile version을 기록하라.
9. log, artifact, DB, Git diff에서 credential·민감정보 누출을 검사하라.
10. 실패를 P3 IMPLEMENT에서 수정하지 말고 최소 재현 절차와 expected/actual을 포함한 defect packet으로 작성하라.

`{REPO_PATH}/.orion/tasks/{TASK_ID}/validation-report.md` 형식:

# Validation Report: {TASK_ID}
## 1. Verdict
## 2. Environment and Revisions
## 3. Requirements and Acceptance Criteria
## 4. Test Matrix
## 5. Automated Test Results
## 6. Manual and Exploratory Results
## 7. Security and Permission Results
## 8. Recovery and Failure-mode Results
## 9. Performance Results
## 10. Defects
## 11. Evidence
## 12. Scorecard
## 13. Release Recommendation
## 14. Handoff

평가 점수:
- 기능·수용 기준 30
- 정확성·데이터 무결성 20
- 보안·권한·자료 등급 20
- 복구력·동시성 10
- 성능·사용성 10
- test·문서·운영성 10

판정 규칙:
- PASS: 85점 이상, P0·P1 defect 없음, 필수 test 전부 통과
- FAIL: 85점 미만, P0·P1 존재, 필수 test 실패 또는 실행 불가
- BLOCKED: 필요한 환경·CLI·fixture가 없어 핵심 수용 기준을 검증할 수 없음

Security hard fail, 자료 유출, 데이터 손상, 승인 우회는 점수와 무관하게 FAIL이다. FAIL이면 defect별 담당 Agent와 재검증 범위를 지정하여 P3 IMPLEMENT로 돌려보내라. PASS일 때만 P5 COMPLETE로 전달하라.
```

## 8. P5 COMPLETE — 완성 프롬프트

### 읽어야 할 자료

- P1 PLAN부터 P5 COMPLETE까지의 모든 작업 산출물
- 최종 Git diff·history·working tree
- PRD 수용 기준과 Definition of Done
- Roadmap의 현재 milestone gate
- Operations Runbook
- 변경된 모든 규격 문서

### 복사용 프롬프트

```text
[공통 프롬프트를 먼저 삽입]

현재 workflow phase는 P5 COMPLETE 완성 및 인계다. validation-report.md가 PASS가 아니면 완성 처리하지 마라.

다음 release readiness 점검을 수행하라.

1. 계획, 검토 finding, 구현 항목, defect가 모두 closed 또는 명시적으로 승인된 deferred 상태인지 확인하라.
2. PRD 수용 기준과 Definition of Done을 실제 evidence에 연결하라.
3. 최종 diff에 임시 code, debug log, disabled test, placeholder, 하드코딩 경로, secret이 없는지 확인하라.
4. schema·API·event·profile·UI·runbook·ADR 변경이 서로 동기화되었는지 확인하라.
5. DB migration의 forward·rollback 또는 backup/restore 절차를 확인하라.
6. fresh local environment에서 시작 절차와 핵심 smoke test를 실행하라.
7. 최종 test 명령과 결과, 알려진 제한, 운영 주의사항을 정리하라.
8. milestone checklist를 갱신하고 다음 작업을 분리하라. 현재 scope에 다음 milestone 기능을 끼워 넣지 마라.
9. 로컬 integration이 승인 범위에 있으면 target branch에 통합하고 전체 회귀 test를 다시 수행하라. 충돌이 있으면 자동으로 의미를 추정하지 말고 BLOCKED로 보고하라.
10. push, PR 생성, 배포, 외부 공지는 별도 승인 항목으로 제시하고 실행하지 마라.

`{REPO_PATH}/.orion/tasks/{TASK_ID}/completion-report.md` 형식:

# Completion Report: {TASK_ID}
## 1. Outcome
## 2. Delivered Scope
## 3. Requirements and Evidence
## 4. Final Changes
## 5. Verification Summary
## 6. Security and Data Handling
## 7. Migration, Recovery and Rollback
## 8. Documentation Updated
## 9. Known Limitations and Deferred Work
## 10. Operations Notes
## 11. Approval-required External Actions
## 12. Next Recommended Task
## 13. Handoff

완성 판정 조건:
- validation PASS
- P0·P1 0건
- 수용 기준 전부 충족
- working tree와 최종 revision이 명확함
- 문서·migration·runbook 최신 상태
- 설치·시작·smoke test 재현 가능
- 외부 작업은 실행되지 않았거나 사용자 승인이 기록됨

최종 응답은 다음 순서로 간결하게 작성하라.
1. 달성한 결과
2. 핵심 변경 파일
3. 검증 결과
4. 남은 제한
5. 승인이 필요한 다음 행동
```

## 9. 계획 수정 프롬프트

검토가 `REVISION_REQUIRED`일 때 사용한다.

```text
[공통 프롬프트를 먼저 삽입]

현재 작업은 P1 PLAN 수정이다. 원본 plan.md와 review.md를 읽고 모든 P0·P1 finding과 필수 P2를 해결하라. 제품 코드를 구현하지 마라.

각 finding에 대해 다음을 표로 작성하라.
- Finding ID
- 수용 또는 반박
- 근거
- 계획에서 변경한 section
- 변경 후 검증 방법

반박은 문서 또는 실제 코드 근거가 있을 때만 허용한다. 수정된 plan.md의 version과 변경 이력을 갱신하고 다시 독립 P2 REVIEW로 보내라. finding을 단순히 `해결됨`으로 표시하지 말고 구현 step·test·rollback에 실제로 반영하라.
```

## 10. 검증 실패 수정 프롬프트

검증이 `FAIL`일 때 구현 Agent에게 전달한다.

```text
[공통 프롬프트를 먼저 삽입]

현재 작업은 validation defect 수정이다. validation-report.md의 실패만 수정하며 새로운 기능을 추가하지 마라.

1. defect별 재현 명령을 직접 실행해 실패를 확인하라.
2. root cause를 코드·상태·event 흐름 수준에서 설명하라.
3. 가장 작은 안전한 수정과 회귀 test를 구현하라.
4. 동일 defect 계열의 인접 경로도 test하되 범위를 확장하지 마라.
5. implementation-log.md에 defect ID, 수정 파일, test 결과를 추가하라.
6. 전체 필수 test를 실행하고 독립 P4 VALIDATE로 되돌려라.

검증 보고서 자체의 PASS/FAIL을 구현자가 변경하지 마라. 재검증자가 새 결과를 기록해야 한다.
```

## 11. 한 번에 전체 흐름을 지휘하는 Master Prompt

이 프롬프트는 한 AI에게 전체 작업을 지휘시키되 각 gate에서 멈추게 할 때 사용한다. §2와 §3의 mandatory workflow-mode 및 real-isolation 규칙을 적용한다.

```text
[공통 프롬프트를 먼저 삽입]

당신은 이 작업의 Orion Orchestrator다. P1 PLAN → P2 REVIEW → P3 IMPLEMENT → P4 VALIDATE → P5 COMPLETE state machine을 관리한다.

규칙:
- P1-P5 workflow phase를 건너뛰지 마라.
- 시작 전에 정확히 하나의 `WORKFLOW_MODE`를 선택하고 기록하라: `manual_independent` 또는 `controller_isolated`. 두 모드를 혼합하거나 다른 값으로 대체하지 마라.
- `manual_independent`에서는 사용자가 각 phase의 실제 별도 일반 AI session을 시작한다. `controller_isolated`에서는 명시적 사용자 자동화 위임 뒤 controller가 실제 격리 worker를 시작하며 planner/reviewer와 implementer/validator는 서로 다른 context여야 하고 worker/session ID와 artifact hash를 기록한다.
- same-session role reset 또는 동일 context 안의 different-model role reset은 독립 검토나 검증이 아니며, 같은 session 안의 새 context도 충분하지 않다.
- `P2 REVIEW` and `P4 VALIDATE` MUST STOP with `BLOCKED` when the selected mode cannot supply a real separate session or isolated worker for that independent gate.
- 각 P workflow phase의 전용 프롬프트와 PASS 조건을 적용하라.
- 산출물을 `.orion/tasks/{TASK_ID}/`에 저장하라.
- P2 REVIEW가 APPROVED가 아니면 P3 IMPLEMENT를 시작하지 마라.
- P4 VALIDATE가 PASS가 아니면 P5 COMPLETE를 시작하지 마라.
- 사용자의 응답이 없어도 안전한 로컬 read·edit·test 범위에서는 진행할 수 있지만, 외부 상태 변경과 보안 경계 변경은 승인 없이 진행하지 마라.
- 각 gate에서 현재 P phase, `WORKFLOW_MODE`, 산출물, 차단 사항, 다음 P phase prompt를 보고하고 멈춰라.

먼저 P1 PLAN만 수행하라. 계획을 작성한 뒤 P3 IMPLEMENT를 시작하지 말고 P2 REVIEW handoff packet을 출력하라.
```

## 12. Handoff Packet Template

P2 REVIEW 또는 P4 VALIDATE handoff에는 아래 정보를 함께 제공하고, 선택한 `WORKFLOW_MODE`의 real-isolation 증거를 포함한다.

```text
ORION HANDOFF PACKET

Task ID: {TASK_ID}
Task: {TASK_TITLE}
Repository: {REPO_PATH}
Docs: {DOCS_DIR}
Data classification: {DATA_CLASSIFICATION}
WORKFLOW_MODE: manual_independent | controller_isolated
Current phase: P1 PLAN | P2 REVIEW | P3 IMPLEMENT | P4 VALIDATE | P5 COMPLETE
Required next phase: P1 PLAN | P2 REVIEW | P3 IMPLEMENT | P4 VALIDATE | P5 COMPLETE
Worker/session ID:
Artifact hash:
Base commit:
Head commit:
Worktree/branch:

Read first:
1.
2.
3.

Artifacts:
- plan:
- review:
- implementation log:
- validation report:

Decisions already approved:
-

Do not assume:
-

Open risks or defects:
-

Allowed actions:
-

Forbidden without approval:
- push
- PR creation
- deployment
- external messages
- destructive or cross-project operations

Expected output:
-
```

## 13. 첫 개발 작업 시작 전 체크리스트

- [ ] 인덱스를 포함한 14개 Orion 문서를 실제 repository의 `docs/orion/`에 복사하거나 `DOCS_DIR`로 연결했다.
- [ ] 문서가 Git에서 version 관리된다.
- [ ] root `AGENTS.md` 또는 `CLAUDE.md`에 build·test·문서 기준과 승인 경계를 요약했다.
- [ ] `.orion/tasks/`의 보존·Git 포함 정책을 결정했다.
- [ ] Codex CLI와 Claude Code CLI의 설치·인증·model availability를 확인했다.
- [ ] 첫 작업의 자료 등급을 지정했다.
- [ ] Git base branch와 worktree naming rule을 정했다.
- [ ] format, lint, typecheck, unit, integration 명령을 최소 한 번 수동 확인했다.
- [ ] 선택한 `WORKFLOW_MODE`가 P2 REVIEW와 P4 VALIDATE에 필요한 실제 별도 session 또는 isolated worker를 제공하며 worker/session ID와 artifact hash를 기록하는지 확인했다.
- [ ] M0 또는 M1 milestone에서 가장 작은 end-to-end vertical slice를 첫 작업으로 선택했다.

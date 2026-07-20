# Orion Console Documentation Index

> 문서 상태: Baseline v1.0  
> 기준일: 2026-07-20  
> 대상: Windows 로컬 환경에서 Codex CLI와 Claude Code CLI를 통합하는 멀티 에이전트 웹 콘솔

## 1. 이 문서의 목적

이 인덱스는 Orion Console을 기획·구현·검증·운영할 때 어떤 문서를 기준으로 판단해야 하는지 정의한다. 아래 13개 기준 문서는 하나의 규격 세트이며, 에이전트 프로필 18개와 모델 선정 근거, AI 개발 절차, 런타임 계약, 보안 정책, UI, 시험, 운영 절차까지 포함한다.
18번째 Arca 요구사항은 M1-M5 미래 계약으로만 [Agent Catalog](./orion-console-agent-catalog.md), [Security, Permission & Data Classification](./orion-console-security-permission-model.md), [Implementation Roadmap](./orion-console-implementation-roadmap.md), [API, Event & CLI Adapter Contract](./orion-console-api-event-adapter-contract.md), [Agent Profile Format](./orion-console-agent-profile-format.md), [UI/UX Specification](./orion-console-ui-ux-specification.md), [Test & Evaluation Plan](./orion-console-test-evaluation-plan.md), [Operations & Recovery Runbook](./orion-console-operations-recovery-runbook.md), [Architecture Decision Records](./orion-console-architecture-decision-records.md)에 연결한다. M0는 Arca runtime, profile seed, registry DB, scheduler 또는 health 운영 상태를 제공하지 않는다.

## 2. 문서 세트

| 분류 | 문서 | 핵심 내용 | 주 독자 |
|---|---|---|---|
| 제품 기준 | [PRD](./orion-console-prd.md) | 목표, 사용자, 범위, 기능·비기능 요구사항, 성공 지표, 수용 기준 | 제품 책임자, 전체 팀 |
| 기술 기준 | [상세 기술 명세서](./orion-console-technical-specification.md) | 시스템 구조, 데이터 모델, 오케스트레이션, 동시성, Git 격리, 구현 및 검증 방법 | 아키텍트, 개발자, QA |
| 에이전트 기준 | [Agent Catalog & SOUL](./orion-console-agent-catalog.md) | 18개 에이전트의 이름, 역할, 모델, 권한, 입출력, 협업 관계, 전체 `SOUL.md` | 제품 책임자, Agent 엔지니어 |
| 모델 선정 | [Model Selection Rationale](./orion-console-model-selection-rationale.md) | 공식 자료 기반 모델 특성, 역할별 배정 이유, 보안·비용·가용성 제약, 재평가 절차 | 기술 총괄, Agent 엔지니어, 보안 책임자 |
| 프로필 형식 | [Agent Profile Format](./orion-console-agent-profile-format.md) | YAML 스키마, 디렉터리 구조, 권한 템플릿, 버전·가져오기·내보내기 규칙 | 백엔드, Agent 엔지니어 |
| 연동 계약 | [API, Event & CLI Adapter Contract](./orion-console-api-event-adapter-contract.md) | REST API, SSE 이벤트, Codex·Claude 어댑터, 오류 분류, 호환성 시험 | 백엔드, 프론트엔드, QA |
| 보안 기준 | [Security, Permission & Data Classification](./orion-console-security-permission-model.md) | 위협 모델, 자료 등급, 명령·파일·Git 권한, 승인, 비밀정보, 감사, 사고 대응 | 보안 책임자, 전체 개발팀 |
| 화면 기준 | [UI/UX Specification](./orion-console-ui-ux-specification.md) | 정보 구조, 핵심 화면, 상태·오류 표시, 접근성, 반응형 범위, 2D 오피스 후순위 원칙 | 프론트엔드, 디자인, QA |
| 검증 기준 | [Test & Evaluation Plan](./orion-console-test-evaluation-plan.md) | 요구사항 추적, 기능·복구·보안·성능 시험, 에이전트 역할 평가, 출시 점수 | QA, 제품 책임자 |
| AI 개발 실행 | [AI Development Prompt Playbook](./orion-console-ai-development-prompt-playbook.md) | 계획·검토·구현·검증·완성 단계별 입력 문서, 복사용 프롬프트, gate와 handoff 형식 | 모든 AI 작업자, 기술 총괄 |
| 실행 계획 | [Implementation Roadmap](./orion-console-implementation-roadmap.md) | M0~M8 단계, 단계별 기능·방법·검증·완료 조건·출시 체크리스트 | 기술 총괄, 프로젝트 관리자 |
| 운영 기준 | [Operations & Recovery Runbook](./orion-console-operations-recovery-runbook.md) | 설치·실행·중지, 장애 진단, 작업·Git·DB 복구, 백업, 업데이트, 제거 | 운영자, 개발자 |
| 결정 기록 | [Architecture Decision Records](./orion-console-architecture-decision-records.md) | 로컬 우선, CLI 어댑터, SSE, SQLite, worktree, 승인, 자료 등급, 스케줄러 등 핵심 결정 | 아키텍트, 유지보수자 |

## 3. 권장 읽기 순서

### 3.1 의사결정자·제품 책임자

1. PRD
2. Agent Catalog & SOUL
3. Model Selection Rationale
4. Security, Permission & Data Classification
5. Implementation Roadmap
6. Test & Evaluation Plan

### 3.2 구현팀

1. PRD
2. 상세 기술 명세서
3. Architecture Decision Records
4. Model Selection Rationale
5. Agent Profile Format
6. API, Event & CLI Adapter Contract
7. Security, Permission & Data Classification
8. 담당 영역별 UI/UX 또는 Agent Catalog
9. Test & Evaluation Plan

### 3.3 QA·운영팀

1. PRD의 수용 기준
2. Test & Evaluation Plan
3. Security, Permission & Data Classification
4. Operations & Recovery Runbook
5. API, Event & CLI Adapter Contract

## 4. 영역별 Source of Truth

| 판단 대상 | 기준 문서 |
|---|---|
| 제품 목표, v1 범위, 사용자 가치, 최종 수용 여부 | PRD |
| 런타임 구성요소, 상태 전이, 스케줄링, 저장 구조 | 상세 기술 명세서 |
| 에이전트 이름·ID·역할·모델·행동 원칙·평가 기준 | Agent Catalog & SOUL |
| 모델 계열 특성, 역할별 모델 배정 근거, 모델 재평가 | Model Selection Rationale |
| 프로필 파일의 필드·타입·검증·버전 형식 | Agent Profile Format |
| 프론트엔드와 백엔드 및 CLI 어댑터 사이의 데이터 계약 | API, Event & CLI Adapter Contract |
| 허용·차단·승인·자료 반출·보존과 관련된 모든 판단 | Security, Permission & Data Classification |
| 화면 구조, 상태 표현, 조작 흐름, 접근성 | UI/UX Specification |
| 시험 사례, 합격 임계치, 증적, 출시 평가 | Test & Evaluation Plan |
| 생성형 AI 개발 단계, 단계별 prompt, gate, handoff | AI Development Prompt Playbook |
| 구현 순서, 마일스톤 진입·종료 조건 | Implementation Roadmap |
| 설치된 시스템의 진단·백업·복구·업데이트 | Operations & Recovery Runbook |
| 선택한 아키텍처와 대안·결과·변경 사유 | Architecture Decision Records |

## 5. 충돌 해결 규칙

1. 보안·권한·자료 반출 충돌에서는 `Security, Permission & Data Classification`의 더 엄격한 규칙을 적용한다.
2. 제품 범위와 수용 기준은 PRD를 따른다. 구현 상세가 이를 축소하거나 확장해서는 안 된다.
3. 데이터 구조와 통신 형식은 버전이 명시된 `Agent Profile Format` 및 `API, Event & CLI Adapter Contract`를 따른다.
4. 에이전트 정체성과 행동 규칙은 `Agent Catalog & SOUL`을 따른다. 런타임 설정은 해당 카탈로그의 권한 상한을 넘을 수 없다.
5. 승인된 ADR이 기존 구현 결정을 변경하면 영향을 받는 본문 문서도 같은 변경에서 함께 갱신한다. ADR만 추가하고 규격 본문을 방치하지 않는다.
6. 같은 영역 문서끼리 충돌하면 상태가 `Accepted`이고 버전 또는 승인일이 더 최신인 항목을 임시 기준으로 삼고, 기술 총괄이 문서 정합성 이슈를 등록한다.

## 6. 고정된 v1 기준값

| 항목 | 기준값 |
|---|---|
| 실행 환경 | Windows 로컬, 단일 사용자, `127.0.0.1` 바인딩 |
| Provider | Codex CLI, Claude Code CLI |
| 인증 | 각 CLI의 기존 로그인 세션 사용, API Key 자체 저장 금지 |
| 등록 에이전트 | 18개 |
| 전체 동시 실행 | 최대 8개 |
| Provider 기본 soft cap | Codex 4개, Claude 4개 |
| Provider 일시 차용 | 유휴 슬롯이 있으면 Provider당 최대 6개 |
| 동시 write 작업 | 최대 4개 |
| 작업 한도 | 최대 120분 또는 Agent Run 60회 |
| 단계 재시도 | 실패 후 최대 2회, 총 시도 최대 3회 |
| 자동 허용 | 로컬 편집, 테스트, 커밋, 통합 |
| 사용자 승인 필요 | push, PR 생성, 배포, 외부 메시지, 그 밖의 외부 상태 변경 |
| 자료 등급 | `public`, `internal`, `confidential`, `controlled` |
| 원격 모델 금지 | `controlled`; `confidential`의 Fable 사용은 기본 차단 |
| 로그·감사 기본 보존 | 90일 |
| 완료 worktree 보존 | 기본 7일. dirty 또는 미통합 상태는 자동 삭제 금지 |
| UI 언어 | 한국어 중심, 기술 용어는 영어 병기 가능 |
| 2D 가상 오피스 | v1 수용 기준 완료 후 M8에서 진행 |

## 7. 변경 관리

규격 변경 PR 또는 로컬 변경 묶음에는 다음 항목을 포함한다.

- 변경 이유와 사용자 영향
- 수정한 Source of Truth 문서
- 연관 문서의 동기화 여부
- 스키마·API·이벤트·프로필 버전 영향
- 보안 및 자료 등급 영향
- 추가·수정한 시험 사례와 증적
- 마이그레이션 및 되돌리기 방법

다음 변경은 반드시 ADR을 추가하거나 기존 ADR을 `Superseded` 처리한다.

- 실행 격리 방식 변경
- CLI가 아닌 직접 API 연동 도입
- 저장소 또는 이벤트 전송 기술 변경
- 승인 경계 완화
- 자료 반출 정책 변경
- 동시성·스케줄링 기본 구조 변경

## 8. 코드가 최종 기준이 되는 항목

문서는 의도와 계약의 기준이다. 실제 빌드 이후 다음 항목은 생성물 또는 실행 환경을 함께 확인해야 한다.

- 데이터베이스의 실제 적용 상태: migration 파일과 migration history
- API의 실제 제공 상태: 생성된 OpenAPI 문서와 contract test 결과
- 프로필 유효성: JSON Schema 및 profile validation 결과
- CLI 지원 옵션: 설치된 Codex·Claude CLI 버전과 캡처된 capability probe
- 패키지 버전: lockfile
- 보안 회귀 상태: 최신 보안 시험 보고서와 감사 로그

코드가 문서 계약과 다르면 이를 정상 상태로 간주하지 않는다. 구현을 고치거나 승인된 변경 절차로 문서와 ADR을 함께 갱신해야 한다.

## 9. 문서 완료 정의

- 인덱스를 제외한 13개 기준 문서가 모두 존재하고 링크가 유효하다.
- 18개 에이전트의 이름, 역할, 모델, 권한, `SOUL.md`, 평가 기준이 카탈로그에 있다.
- 프로필, API, 이벤트, 어댑터 계약이 구현 가능한 수준으로 타입과 오류를 정의한다.
- 보안 문서가 자료 등급, 승인 경계, 비밀정보, 파일·Git·명령 정책을 포함한다.
- PRD 기능 요구사항이 시험 계획의 사례와 추적된다.
- 단계별 구현 목표마다 검증 방법과 종료 조건이 있다.
- 설치, 장애, 복구, 백업, 업데이트 절차가 운영 런북에 있다.
- 2D 가상 오피스가 핵심 기능과 분리된 후순위 단계로 유지된다.

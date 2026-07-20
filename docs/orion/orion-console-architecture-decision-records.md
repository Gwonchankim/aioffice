# Orion Console Architecture Decision Records

> 문서 버전: 1.0  
> 작성일: 2026-07-20  
> 상태: v1 Accepted ADR 모음

## ADR 규칙

- ADR 번호는 재사용하지 않는다.
- Accepted 결정을 바꿀 때 기존 문서를 수정해 사실을 지우지 않고 새 ADR에서 supersede한다.
- 각 ADR은 Context, Decision, Alternatives, Consequences, Revisit Conditions를 가진다.

---

## ADR-001 — Local-first Loopback Web Application

**Status:** Accepted

### Context

두 CLI는 현재 Windows 사용자의 로컬 인증과 Git 프로젝트에 접근한다. v1은 단일 사용자가 같은 PC에서 사용한다.

### Decision

Node 서버를 `127.0.0.1`에만 bind하고 브라우저 SPA를 제공한다. 명령 한 번으로 서버를 시작하고 브라우저를 자동으로 연다.

### Alternatives

- Electron/Tauri 설치 앱
- Windows service
- 사내·클라우드 서버

### Consequences

- 기존 CLI 로그인과 로컬 파일을 재사용할 수 있다.
- 인증·배포 범위가 작다.
- 다른 PC·모바일에서 접속할 수 없다.
- 로컬 악성코드 방어는 OS 책임 영역으로 남는다.

### Revisit Conditions

- 다중 사용자, LAN/VPN, 항상 실행되는 background service가 필요할 때

---

## ADR-002 — CLI-first Provider Adapter

**Status:** Accepted

### Context

사용자는 Codex CLI와 Claude Code CLI를 모두 연동하려 하며 두 CLI가 이미 설치·로그인되어 있다.

### Decision

v1 실행기는 `codex exec --json`과 `claude --print --output-format stream-json`을 자식 프로세스로 사용한다. 공급자별 차이는 `AgentRuntimeAdapter` 뒤에 격리한다.

### Alternatives

- OpenAI·Anthropic API 직접 호출
- Codex SDK·Claude Agent SDK만 사용
- 한 공급자만 지원

### Consequences

- 기존 구독 로그인과 CLI 기능을 활용한다.
- CLI 출력·flag 변경에 대한 호환 계층과 fixture가 필요하다.
- SDK 전환 시 공통 adapter 계약을 유지할 수 있다.

### Revisit Conditions

- CLI protocol이 불안정하거나 production automation에 SDK가 더 적합해질 때

---

## ADR-003 — SSE for Runtime Events

**Status:** Accepted

### Context

실시간 데이터는 대부분 서버에서 브라우저로 흐르며 사용자 명령은 REST로 충분하다. 이벤트 replay와 단순 재연결이 중요하다.

### Decision

REST mutation/query와 Server-Sent Events를 사용한다. task별 sequence와 `Last-Event-ID`로 replay한다.

### Alternatives

- WebSocket
- polling
- GraphQL subscription

### Consequences

- 구현·프록시·재연결이 단순하다.
- 양방향 token streaming 입력에는 적합하지 않지만 v1 범위가 아니다.
- event DB와 sequence 계약이 필요하다.

### Revisit Conditions

- 실시간 양방향 steering·음성·멀티사용자 presence가 필요할 때

---

## ADR-004 — SQLite Event Persistence

**Status:** Accepted

### Context

단일 사용자 로컬 제품이며 프로젝트·task·event·approval을 transaction으로 보존해야 한다. 외부 DB 서비스는 부담이 크다.

### Decision

Node 24 `node:sqlite`, WAL mode, SQL migration, append-only event table을 사용한다.

### Alternatives

- PostgreSQL
- 파일 기반 JSONL만 사용
- embedded document DB

### Consequences

- 설치가 단순하고 transaction·query·backup을 제공한다.
- 다중 서버·고동시 write 확장에는 제한이 있다.
- 이벤트 폭주를 batch transaction으로 처리해야 한다.

### Revisit Conditions

- 다중 사용자·원격 server·수평 확장·대규모 조직 분석이 필요할 때

---

## ADR-005 — Git Worktree Isolation

**Status:** Accepted

### Context

여러 에이전트가 병렬 수정하면 같은 파일 충돌과 사용자 작업 손상 위험이 있다.

### Decision

모든 write run에 앱이 만든 독립 Git worktree와 branch를 부여한다. Archon은 별도 integration worktree에서 commit을 순차 통합한다.

### Alternatives

- 모든 agent가 한 working tree 공유
- patch 파일만 생성
- repository clone per run

### Consequences

- 사용자 기준 저장소와 병렬 변경이 격리된다.
- disk 사용과 worktree lifecycle 관리가 필요하다.
- 충돌을 명시적으로 통합 단계에서 해결할 수 있다.

### Revisit Conditions

- Git이 아닌 프로젝트 또는 원격 sandbox 실행을 지원할 때

---

## ADR-006 — LLM Planning with Deterministic Validation

**Status:** Accepted

### Context

고정 워크플로만으로 17개 역할과 다양한 과제를 처리하기 어렵지만 LLM에게 완전 자율 권한을 주면 예측 불가능하다.

### Decision

Orion이 structured DAG를 제안하고 서버가 agent, dependency, permission, quality gate, classification, limits를 결정론적으로 검증한다. 유효하지 않은 plan은 실행하지 않는다.

### Alternatives

- LLM 완전 자율 orchestration
- 고정 workflow templates만 사용
- 사용자 수동 계획

### Consequences

- 유연성과 안전 경계를 함께 유지한다.
- Plan schema와 validator를 별도 관리해야 한다.
- 새로운 필수 규칙은 server policy update가 필요하다.

### Revisit Conditions

- 충분한 평가 데이터로 자동 policy learning을 검토할 때

---

## ADR-007 — Human Approval for External Mutations

**Status:** Accepted

### Context

push, PR, 배포, 메시지, 구매·규제 행동은 되돌리기 어렵고 외부 사람·시스템에 영향을 준다.

### Decision

로컬 수정·테스트·커밋·통합은 자동화하지만 외부 변경은 ApprovalRequest와 사용자 승인을 거친 제한된 ExternalActionHandler만 수행한다.

### Alternatives

- 모든 행동 자동화
- 모든 로컬 commit부터 승인
- CLI 에이전트가 직접 외부 명령 실행

### Consequences

- 안전성과 감사 가능성이 높아진다.
- 완전 무인 배포는 지원하지 않는다.
- action hash·expiry·idempotency가 필수다.

### Revisit Conditions

- 특정 저위험 action에 정책 기반 사전 승인을 도입할 때

---

## ADR-008 — Mandatory Data Classification and Controlled Blocking

**Status:** Accepted

### Context

방산·코팅 기술, 재무·계약 자료를 원격 모델이 처리할 수 있어 반출 위험이 있다.

### Decision

모든 프로젝트에 public, internal, confidential, controlled 등급을 필수로 지정한다. Controlled는 모든 원격 LLM 실행을 차단한다. Confidential은 provider allowlist와 Fable 기본 차단을 적용한다.

### Alternatives

- 경고만 표시
- 분류 없음
- 모든 자료 원격 처리 금지

### Consequences

- 민감 자료 처리 경계가 명확하다.
- controlled 과제는 v1에서 실행할 수 없다.
- 향후 local model·승인된 보안 환경 adapter가 필요할 수 있다.

### Revisit Conditions

- 검증된 로컬 모델 또는 승인된 격리 inference 환경을 지원할 때

---

## ADR-009 — Versioned Agent Profiles and Immutable Run Snapshots

**Status:** Accepted

### Context

Description, SOUL, 모델, 권한이 변경되면 과거 실행 재현성과 감사가 깨질 수 있다.

### Decision

프로필 수정은 새 version을 만들고 Run 시작 시 YAML·SOUL·hash·공통 정책을 immutable snapshot으로 저장한다.

### Alternatives

- 현재 profile row 덮어쓰기
- Git history에만 의존
- SOUL만 version 관리

### Consequences

- 과거 실행을 정확히 설명할 수 있다.
- 저장 공간과 version UI가 필요하다.
- 권한 확대 이력이 분명해진다.

### Revisit Conditions

- 중앙 profile registry 또는 조직 정책 server를 도입할 때

---

## ADR-010 — 8-slot Adaptive Scheduler

**Status:** Accepted

### Context

사용자는 최대 8개 병렬 agent를 원하지만 현재 PC는 16GB memory이며 provider rate limit과 write conflict가 존재한다.

### Decision

총 8, provider soft 4/4, provider별 최대 6 차용, write 4, task integration 1을 적용한다. memory 80% 또는 free 2GB 미만에서 새 run을 지연한다.

### Alternatives

- 고정 2·4 slot
- 제한 없는 fan-out
- provider별 독립 8 slot

### Consequences

- 병렬 효과와 로컬 안정성을 균형화한다.
- resource governor와 property test가 필요하다.
- 모든 17개 agent를 동시에 실행하지 않는다.

### Revisit Conditions

- hardware 변화, remote execution, 실제 부하 측정 결과에 따라 조정할 때


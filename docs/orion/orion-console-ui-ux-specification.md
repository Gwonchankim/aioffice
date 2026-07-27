# Orion Console UI/UX Specification

> 문서 버전: 1.0  
> 작성일: 2026-07-20  
> 플랫폼: Windows 로컬 웹, 데스크톱 우선  
> 언어: 한국어 중심, 영문 기술 용어 병기

## 1. UX 목표

- 사용자가 터미널을 열지 않고 프로젝트 등록부터 최종 결과 검토까지 수행한다.
- 현재 어떤 에이전트가 왜 실행 중인지 5초 안에 파악할 수 있다.
- 실패·승인·한도·자료 등급 차단 시 다음 행동이 명확하다.
- 기술 로그와 경영 요약을 분리해 정보 과부하를 줄인다.
- 8개 병렬 실행과 100,000개 이벤트에서도 화면이 응답성을 유지한다.

## 2. 디자인 원칙

1. 통제실 우선: 장식보다 상태·위험·다음 행동을 우선한다.
2. 증거 연결: 결론에서 로그, 테스트, commit, 산출물로 내려갈 수 있어야 한다.
3. 안전한 기본값: 위험 행동은 시각적으로 구분하고 승인 전 비활성화한다.
4. 공급자 중립: Codex와 Claude는 동일한 작업·상태 언어로 표현한다.
5. 점진적 공개: 요약을 먼저 보여주고 원문 로그·도구 입력은 펼쳐서 본다.
6. 접근성: 색상만으로 상태를 전달하지 않는다.

## 3. 정보 구조

```text
Dashboard
Projects
  Project list
  Project detail / policy / Git status
Tasks
  New task
  Task list
  Task detail
    Overview
    Plan DAG
    Runs & logs
    Changes & tests
    Artifacts
    Audit
Agents
  Catalog
  Profile detail / versions / SOUL / HARNESS
  Employment (hire / suspend / resume / dismiss / rehire)   # M5
  Hire proposals                                            # M5
Approvals
Artifacts
Settings
  Providers
  Runtime & retention
  Security
  Import/export
```

## 4. 전역 레이아웃

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Orion Console   Codex ●  Claude ●  Slots 3/8  Memory 62%   [알림] │
├──────────────┬──────────────────────────────────────────────────────┤
│ 대시보드     │                                                      │
│ 프로젝트     │                    Main Content                      │
│ 과제         │                                                      │
│ 에이전트     │                                                      │
│ 승인         │                                                      │
│ 산출물       │                                                      │
│ 설정         │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

- 좌측 내비게이션 폭 240px, 축소 시 72px 아이콘 모드
- 상단 provider·slot 상태는 모든 화면에서 유지
- 위험·승인 알림은 우측 drawer에서 처리
- 최소 지원 viewport 1280×720, 권장 1440×900 이상

## 5. 디자인 토큰

### 5.1 색상

| 용도 | Token | 기본 값 예시 |
|---|---|---|
| 배경 | `--bg-app` | deep navy #0B1220 |
| 패널 | `--bg-panel` | #111B2E |
| 경계 | `--border` | #27344A |
| 기본 텍스트 | `--text-primary` | #F2F5FA |
| 보조 텍스트 | `--text-muted` | #9AA8BC |
| 강조 | `--accent` | #4DA3FF |
| 성공 | `--success` | #35C48D |
| 경고 | `--warning` | #F5B942 |
| 실패 | `--danger` | #F06464 |
| 승인 대기 | `--approval` | #B27CFF |

색상에는 항상 아이콘과 텍스트 label을 병기한다. 밝은 테마는 v1 필수 범위가 아니다.

### 5.2 타이포그래피·간격

- UI 기본: Pretendard, fallback `Segoe UI`, sans-serif
- 로그·SHA·명령: `Cascadia Mono`, monospace
- 본문 14~16px, 표 13~14px, H1 28px, H2 22px
- spacing 4px base scale
- panel radius 8px, 위험 승인 panel은 4px solid left border

## 6. 상태 표현

| 상태 | Label | 아이콘·표현 |
|---|---|---|
| draft | 초안 | 문서 아이콘, 회색 |
| planning | 계획 생성 중 | 회전 아이콘, 파랑 |
| queued | 대기 | 시계, 회색 |
| running | 실행 중 | pulse, 파랑 |
| retry_wait | 재시도 대기 | 순환 화살표, 노랑 |
| waiting_approval | 승인 필요 | 방패·손 아이콘, 보라 |
| succeeded | 완료 | 체크, 초록 |
| failed | 실패 | X, 빨강 |
| cancelled | 취소 | 금지 아이콘, 회색 |
| limit_reached | 한도 도달 | 게이지, 주황 |
| interrupted | 중단됨 | 끊긴 연결, 주황 |

## 7. 핵심 사용자 흐름

### 7.1 첫 실행

1. 서버가 브라우저를 자동으로 연다.
2. Provider 검사 화면에서 Codex·Claude 설치·로그인 상태를 표시한다.
3. 모두 정상일 경우 대시보드로 이동한다.
4. 문제가 있으면 공급자별 정확한 해결 명령과 재검사 버튼을 제공한다.

완료 조건: 로그인 token·이메일을 표시하지 않는다.

### 7.2 프로젝트 등록

1. 프로젝트 추가 버튼
2. 로컬 Git 경로 입력 또는 OS folder picker
3. 자동 Git 검증 결과 표시
4. 기준 branch 선택
5. 자료 등급 필수 선택
6. 공급자·Fable·웹 조회 정책 설정
7. 검증 명령 preset 확인·저장

controlled를 선택하면 원격 모델 실행 불가 설명과 등록만 가능함을 명확히 한다.

### 7.3 과제 생성·실행

1. 프로젝트 선택
2. 제목·목표·성공 기준 입력
3. 입력 artifact 추가
4. 기본 한도 120분·60회 확인
5. `계획 생성` 클릭
6. Orion DAG 미리보기와 validator 결과 확인
7. 유효하면 `자동 실행 시작`

계획 수정 시 structured form만 제공하고 임의 JSON 편집은 고급 모드로 숨긴다. 수정 후 재검증이 필수다.

### 7.4 승인

1. task가 waiting_approval로 전환되고 전역 알림 발생
2. 사용자가 승인 상세에서 target, SHA, 명령, 영향, 롤백 확인
3. 승인·거절·수정 요청 선택
4. 승인 후 action 진행 상태와 결과 표시

승인 버튼은 대상 정보를 끝까지 확인한 후 활성화한다. 파괴적 행동에는 확인 문구 입력을 요구한다.

## 8. 화면별 상세

### 8.1 Dashboard

```text
┌ Current Tasks ───────────┬ Agent Slots ─────────────┐
│ 실행 3 / 대기 5          │ Codex 2/4  Claude 1/4    │
│ 승인 1 / 실패 1          │ Write 2/4  Integrate 0/1 │
└──────────────────────────┴───────────────────────────┘
┌ 승인 필요 ──────────────────────────────────────────┐
│ [HIGH] git push / project A / abc123 / 27분 남음    │
└──────────────────────────────────────────────────────┘
┌ 최근 과제 ──────────────────────────────────────────┐
│ 상태 | 과제 | 프로젝트 | 현재 단계 | 모델 | 경과     │
└──────────────────────────────────────────────────────┘
```

필수 위젯:

- provider 상태
- 실행 슬롯과 resource governor
- 승인 필요
- 실패·한도·중단 알림
- 최근 task
- 90일 보존·디스크 경고

### 8.2 Project Detail

탭:

- 개요: path, branch, HEAD, dirty, 최근 task
- 정책: classification, provider, Fable, web, agent allowlist
- 명령: read, verify, localWrite allowlist
- Worktrees: 앱 생성 path, branch, 상태, 보존 기한
- Audit: 정책 변경·정리 기록

권한 확대와 classification 완화는 변경 전후 diff와 경고를 표시한다.

### 8.3 Task Detail

```text
┌ 제목 / 상태 / 경과 / Run 12/60 / [취소] ───────────┐
│ 목표와 성공 기준                                   │
├ Plan DAG ──────────────────────────────────────────┤
│ Nexus → Archon → Forge ─┐                          │
│                  Luma  ─┼→ Verify → Archon → Orion │
│                  Iris  ─┘                          │
├ Selected Step ─────────────────────────────────────┤
│ Agent / Model / Attempt / Session / Worktree        │
│ [요약] [원문 로그] [도구] [산출물]                 │
└────────────────────────────────────────────────────┘
```

상단:

- objective, criteria, classification, elapsed, deadline, run count
- cancel, retry, export report

DAG node:

- agent avatar·name
- step title
- state·attempt·model
- permission mode icon
- dependency failure 표시

상세 탭:

- Summary: 정제된 한국어 결과
- Raw log: 가상화, 검색, channel filter, auto-scroll toggle
- Tools: 도구 이름·status·duration·sanitized input/output
- Changes: file, diff summary, commit SHA
- Tests: command, result, duration, artifact
- Artifacts: preview/download/hash
- Audit: fallback, retry, approval, state transition

### 8.4 Agent Catalog

카드에는 name, role, model, effort, permission, enabled, health를 표시한다.

상세 편집:

- Metadata
- Description
- SOUL Markdown preview
- Runtime model/fallback
- Permission template
- Routing triggers/exclusions
- Collaborators
- Contracts/stop conditions
- Version history/diff

저장 버튼은 새 version을 생성한다. 권한 확대는 별도 danger confirmation을 요구한다.

**에이전트 인력 관리 UI (M5).** 이 부분은 M5의 UI 계약이다. M3는 backend와 headless API만 제공하므로 M3 시점에는 아래 화면·버튼·라우트가 존재하지 않는다.

**목록.** 카드에는 기존 항목에 더해 다음을 표시한다.

- `origin` badge: `기본 내장`, `사용자 생성`, `관리 에이전트 제안`, `가져오기`
- 고용 상태 label과 아이콘: `초안`(draft) · `고용 중`(active) · `일시 중지`(suspended) · `해고됨`(retired). 색상만으로 구분하지 않는다.
- 모델 선택 표시: 카탈로그 권장값을 그대로 쓰면 `Default` badge, 사용자·관리 에이전트가 바꾼 경우 `Override` indicator와 변경 출처(user / manager)를 함께 보여 준다.

목록 상단에는 등록 현황을 `등록 <n> / 상한 64` 형태로 표시하고, 상한에 도달하면 생성 버튼을 비활성화하며 **해고해도 슬롯이 회수되지 않는다**는 사실을 함께 안내한다.

**동작 버튼.** 상태에 따라 노출되는 버튼만 활성화한다.

| 현재 상태 | 노출 버튼 |
|---|---|
| 초안 | `고용`(활성화할 version 선택 필수), `폐기` |
| 고용 중 | `일시 중지`, `해고` |
| 일시 중지 | `재개`, `해고` |
| 해고됨 | `재고용`(version 미지정 시 직전 활성 version) |

- `고용`은 활성화할 version을 사용자가 명시해야 하며 UI가 최신 version을 임의로 선택하지 않는다. `재개`는 중단 중 새 version이 생겼더라도 승격하지 않는다는 점을 명시한다.
- `해고`는 파괴적 표현을 쓰지 않는다. 확인 대화상자는 "정의·버전·실행 기록은 보존되며 신규 계획과 신규 실행에서만 제외됩니다. 이후 재고용할 수 있습니다."를 명시한다. 물리 삭제 affordance는 제공하지 않는다.
- Arca는 M3·M5에서 활성화할 수 없으므로 고용·재고용·재개 버튼을 비활성화하고 사유(registry runtime 미구현)를 표시한다.
- 기본 내장 18개는 삭제·ID 변경 affordance를 제공하지 않는다.

**에이전트 생성 wizard.** ID → Description → SOUL → HARNESS → 모델·effort·fallback → 권한 템플릿 → 검증 결과 요약 순으로 진행한다. 생성 직후 상태는 `초안`이며 별도의 `고용` 동작 전에는 활성화되지 않는다는 점을 마지막 단계에서 명시한다. 기본 내장 ID와 중복되는 ID, 권한 상한 초과, 미등록 모델 조합, 존재하지 않는 collaborator는 저장 전에 인라인 오류로 표시한다.

**SOUL / HARNESS 편집기.** SOUL과 HARNESS는 서로 다른 탭으로 분리하고 각각 별도의 version·hash를 표시한다. 한 편집기에 두 문서를 합치지 않는다.

- HARNESS는 선택 항목이다. 비어 있으면 권한 템플릿별 기본 harness가 사용된다는 사실과 그 출처(`profile` / `template-default`)를 함께 표시한다.
- version diff는 SOUL과 HARNESS를 각각 좌우 비교로 제공하고 hash 변경 여부를 함께 보여 준다.
- 저장은 기존 version을 수정하지 않고 새 version을 만든다. 정책 검사에 걸린 문장은 저장 전에 해당 위치와 사유를 표시하며, 권한 상한 확대·승인 게이트 생략·시스템 프롬프트 우선순위 역전을 지시하는 내용은 저장할 수 없다.

**모델 선택.** provider·model·reasoningEffort·fallback dropdown은 registry에 등록된 값만 제공한다. `unavailable`·`incompatible` 모델은 저장은 가능하되 실행 불가임을 label로 명시한다. 모델을 카탈로그 권장값에서 바꾸면 `Override`로 표시하고, 권한은 모델 선택으로 변경되지 않는다는 사실을 안내한다.

**HireProposal 승인 UX.** 상세는 §8.7을 따른다.

### 8.5 Approval Center

목록 필터: pending, approved, rejected, expired, executed, failed.

상세:

- 위험 등급
- action type
- target repository/branch/SHA
- exact command 또는 API operation
- 영향·롤백
- 요청 agent·근거
- action hash·만료 countdown

승인 후 target이 바뀌면 “기존 승인 무효” 상태로 전환한다.
### 8.6 향후 Arca 지식 레지스트리 화면

이 절은 M5의 향후 UI 계약이다. M0에는 Arca 화면, 레지스트리, 검색, SourceRequest, 감사 UI 또는 관련 runtime이 없다.

레지스트리 목록·검색 화면은 요청자 역할, 프로젝트, 목적, 자료 등급과 `allowedRoles`를 검색 후보 생성 전에 적용한다. 권한 있는 결과에 한해 제목, 승인된 최소 요약, 위치, 버전, 소유자와 lifecycle 상태를 표시하며, 결과가 없거나 보이지 않는 결과만 있는 경우에는 count·facet·숨은 자료 존재를 드러내지 않는 동일한 빈 목록 상태를 표시한다.

Source detail은 허용된 자료에만 제공한다. source-specific 권한 거부로 비가시인 자료와 존재하지 않는 `sourceId`는 동일한 비공개 `자료를 찾을 수 없습니다` 상태로 렌더링하고, `permission_denied`, 존재 여부, 제목, 요약, 소유자, 위치, 버전, 자료 등급, 접근 사유를 표시하지 않는다. 이 상태에는 특정 source에 연결된 재시도·SourceRequest 생성 affordance도 제공하지 않는다. source를 검사하기 전 레지스트리 범위 자체가 없는 경우에만 source와 무관한 일반 권한 안내를 표시할 수 있다.

SourceRequest 화면은 사용자가 제공한 필요 자료, 기준, 예상 위치, 허용 형식, 목적을 입력해 요청을 생성하고 `open`/`resolved`/`cancelled` 상태를 표시한다. 해결은 같은 프로젝트의 허용된 비보관 SourceCard를 명시적으로 연결하며, 숨은 source를 추측하거나 자동 요청을 만들지 않는다.

lifecycle 상태는 색상 외 label과 아이콘으로 다음 값을 모두 표시한다: `active`, `stale`, `missing`, `superseded`, `archived`. `stale`은 checksum 또는 수정 시각 불일치, `missing`은 확인된 locator 실패, `superseded`는 새 버전 SourceCard 등록, `archived`는 승인된 논리 보관을 뜻한다. `archived`는 terminal이며 UI에서 unarchive나 원본 삭제를 제안하지 않는다.

자료 등급 입력·import 선택지는 정확히 `public`, `internal`, `confidential`, `controlled` 네 값이다. 입력값이 `restricted`이면 자동 변환하지 않고 처리를 멈춘 뒤 사용자가 `controlled`을 명시적으로 선택하도록 안내한다.

발췌 화면은 목적과 최소 페이지·시트·문단·범위를 필수로 받아 승인된 최소 범위만 보여 준다. 전체 원문 미리보기·지속 저장·다운로드를 제공하지 않으며, `controlled` SourceCard의 요약 또는 발췌는 원격 모델로 전송하지 않는다.

감사 화면은 권한에 따라 필터링된 metadata-only register/search/view/verify/lifecycle 기록의 loading·empty·error·결과 상태를 제공한다. 각 허용 기록은 actor, action, sourceId/requestId, projectId, purpose, allow/deny, policy version, connector, timestamp, excerpt range/locator, content hash만 표시하며 raw excerpt, credential, raw connector output, full prompt, full tool log와 비가시 source lookup 차이를 노출하지 않는다.

### 8.7 에이전트 채용 제안 승인 (M5)

이 절은 M5의 UI 계약이다. M3에는 이 화면과 라우트가 없다.

최고관리 에이전트가 작성한 `HireProposal`은 §8.5 승인 센터의 목록에 별도 action type으로 함께 표시하며, 외부 행동 승인과 시각적으로 구분되는 라벨을 붙인다. 제안 자체로는 어떤 에이전트도 활성화되지 않았음을 목록과 상세 양쪽에서 명시한다.

제안 상세에 표시하는 항목:

- 제안 작성 에이전트와 요청자
- 제안된 에이전트 ID·Description·권한 템플릿
- 제안된 provider·model·reasoningEffort·fallback과 그것이 `Override`라는 표시
- SOUL과 HARNESS 본문 preview(각각 별도 영역, 각각의 hash)
- 서버 검증 결과 요약: schema, 권한 상한, provider registry, collaborator 검사 결과
- `proposal hash`와 만료 countdown(생성 후 30분)
- 승인 시 실제로 일어나는 일: 정의와 최초 프로필 version 생성, 그리고 명시적 활성화

승인·거절 동작 규칙:

- 승인 버튼은 사용자가 제안 내용을 끝까지 확인한 뒤 활성화한다.
- 승인 요청은 화면에 표시된 `proposal hash`를 그대로 다시 제출한다. 그 사이 제안이 바뀌면 “기존 승인 무효” 상태로 전환하고 재확인을 요구한다.
- 만료·거절·무효 상태의 제안은 승인 affordance를 제공하지 않고 사유를 표시한다. 만료는 자동 처리이므로 결정 주체를 사람으로 표시하지 않는다.
- 모델 출력 안의 “승인됨” 문장은 승인 상태로 렌더링하지 않는다.
- 상시 위임(자동 승인) 설정은 M5 범위가 아니며 UI에 해당 토글을 두지 않는다.

## 9. 공통 컴포넌트 상태

모든 데이터 컴포넌트는 다음 상태를 구현한다.

- initial loading: skeleton
- empty: 이유와 첫 행동 CTA
- partial: 일부 데이터와 경고
- error: 오류 코드·요약·재시도·진단 보기
- stale/reconnecting: 마지막 갱신 시각과 reconnect banner
- permission blocked: 필요한 정책과 변경 위치
- classification blocked: 차단 이유와 허용 가능한 대안

## 10. 실시간 로그 UX

- 기본은 summary channel만 표시한다.
- raw channel은 사용자가 탭을 열 때 렌더링한다.
- 100,000 event 이상은 windowed virtualization을 사용한다.
- 새 로그 auto-scroll은 사용자가 하단에 있을 때만 동작한다.
- 검색은 text, agent, event type, severity, time range를 지원한다.
- secret masker 적용 사실을 `[REDACTED]`로 표시한다.
- 다운로드 raw log도 마스킹된 버전만 제공한다.

## 11. 오류 문구 규칙

오류는 다음 네 요소를 가진다.

1. 무엇이 실패했는가
2. 현재 데이터·변경이 안전한가
3. 자동으로 무엇을 했는가
4. 사용자가 다음에 무엇을 해야 하는가

예:

> Forge 실행이 중단되었습니다. 작업 내용은 격리 worktree에 보존되어 있으며 기준 저장소는 변경되지 않았습니다. Claude 세션 재개를 한 번 시도했지만 인증이 필요합니다. 설정 → 공급자에서 Claude 로그인을 확인한 뒤 이 단계를 재시도하세요.

## 12. 접근성

- WCAG 2.2 AA를 목표로 한다.
- focus indicator를 제거하지 않는다.
- DAG node와 edge는 키보드로 이동·선택할 수 있어야 한다.
- screen reader용 상태 live region은 중요한 상태 변경만 알린다.
- 애니메이션은 `prefers-reduced-motion`을 따른다.
- 텍스트 대비 4.5:1 이상, 큰 텍스트 3:1 이상
- 표에는 header와 caption을 제공한다.
- dialog focus trap과 Escape close를 지원하되 진행 중 위험 확인 dialog는 실수로 닫히지 않게 한다.

## 13. 성능 기준

- 일반 화면 전환 p95 300ms 이내
- event batch는 animation frame 또는 50ms 단위로 UI에 반영
- DAG 100 node에서 pan/zoom 50fps 이상
- 100,000 로그에서 scroll input latency p95 100ms 이하
- 백그라운드 탭 복귀 시 전체 로그를 재렌더하지 않고 sequence gap만 replay

## 14. 반응형 범위

- 1440px 이상: 전체 navigation + 2~3 column
- 1280~1439px: 축소 panel, task detail 2 column
- 1024~1279px: navigation icon mode, detail drawer
- 1024px 미만: 조회·승인 중심 제한 UI, DAG 편집은 desktop 필요 안내

v1은 모바일 원격 접속을 지원하지 않으므로 모바일 최적화는 필수가 아니다.

## 15. 2D 가상 오피스 후속 UX

가상 오피스는 별도 navigation item `Office`로 추가하며 핵심 대시보드를 대체하지 않는다.

상태 매핑:

- idle: 지정 좌석
- queued: 대기 구역
- running: 책상
- collaborating/synthesis: 회의실
- testing: QA Lab
- waiting_approval: 승인 데스크
- failed: 지원 구역과 경고 badge

아바타 클릭은 기존 Agent·Run 상세 drawer를 연다. 방향키 이동, 3D, 음성, 멀티플레이는 별도 후속 기능이다.

## 16. UI 검증 체크리스트

- [ ] 터미널 없이 프로젝트 등록→과제→결과 흐름 완료
- [ ] provider·slot·memory 상태를 모든 화면에서 확인 가능
- [ ] 승인 대상·영향·롤백이 한 화면에 표시
- [ ] task refresh·SSE reconnect 후 상태 유실 없음
- [ ] loading·empty·error·blocked·reconnecting 상태 구현
- [ ] 상태가 색상 외 아이콘·텍스트로 표현됨
- [ ] 키보드로 주요 기능 접근 가능
- [ ] axe Critical 위반 0
- [ ] 100,000 로그 성능 기준 충족
- [ ] 한국어 요약과 원문 기술 로그 분리
- [ ] 에이전트 고용 상태와 Default/Override가 색상 외 label로 구분됨
- [ ] 해고 확인 문구가 보존과 재고용 가능성을 명시함
- [ ] SOUL과 HARNESS가 별도 탭·별도 version·별도 hash로 표시됨
- [ ] 제안 승인 화면에 hash·만료·검증 결과가 함께 표시되고 승인 전 활성화가 없음
- [ ] 가상 오피스가 v1 핵심 흐름에 의존성을 만들지 않음


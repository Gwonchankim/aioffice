# Orion Console Model Selection Rationale

> 문서 버전: 1.0  
> 조사 기준일: 2026-07-20  
> 상태: 18개 기본 에이전트의 모델 선정 근거
> 적용 범위: GPT-5.6 Sol·Terra, Claude Fable 5·Opus 4.8·Sonnet 5

## 1. 목적

이 문서는 Orion Console의 모델 배정을 단순 선호가 아닌 역할 적합성, 신뢰성, 속도, 비용, 도구 사용, 자료 보안으로 설명한다. 실제 에이전트 이름·역할·SOUL·권한의 최종 기준은 `orion-console-agent-catalog.md`이며, 이 문서는 모델 선택의 근거와 재평가 절차를 제공한다.

## 2. 조사 원칙과 한계

- 모델 사양·가격·Provider 설명은 OpenAI와 Anthropic의 공식 문서를 우선했다.
- Provider가 제시한 benchmark와 고객 평가는 자기 보고 자료이므로 서로 다른 회사의 점수를 직접 서열화하지 않았다.
- Orion Console은 API Key가 아니라 Codex CLI와 Claude Code CLI의 기존 구독 로그인을 사용한다. 아래 API 가격은 상대적 비용 등급을 이해하기 위한 참고값이며 실제 CLI 구독 한도나 청구액을 뜻하지 않는다.
- API에서 제공되는 모델이 사용자의 CLI 계정에도 즉시 보인다고 가정하지 않는다. 앱 시작 시 capability probe로 설치 버전, 인증, 모델 선택 가능 여부를 확인한다.
- 모델의 성능과 가용성은 바뀔 수 있다. 공식 문서 검토와 Orion 전용 회귀 평가를 함께 통과해야 배정표를 변경한다.

## 3. 공식 자료에서 확인한 모델 특성

### 3.1 OpenAI GPT-5.6 계열

OpenAI는 GPT-5.6 Sol을 복잡한 reasoning과 coding을 위한 flagship, Terra를 intelligence와 cost의 균형형으로 설명한다. 두 모델 모두 1.05M context, 128K 최대 출력, 다양한 reasoning effort와 function·web·file search·computer use를 지원한다. `gpt-5.6`은 Sol로 연결되는 alias다. [OpenAI 모델 목록](https://developers.openai.com/api/docs/models), [GPT-5.6 Sol 상세](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

| 모델 | 공식 포지션 | Context / 최대 출력 | API 참고 가격 Input / Output MTok | Orion 해석 |
|---|---|---:|---:|---|
| GPT-5.6 Sol | 복잡한 전문 업무를 위한 frontier 모델 | 1.05M / 128K | $5 / $30 | 높은 판단 비용을 감수할 가치가 있는 전략, 과학, 아키텍처, 전체 조율에 적합 |
| GPT-5.6 Terra | 지능과 비용의 균형형 | 1.05M / 128K | $2.50 / $15 | 반복 분석, QA 분류, 데이터 탐색처럼 처리량과 품질을 함께 요구하는 업무에 적합 |

Orion Console의 CLI 기본 ID는 Sol에 `gpt-5.6`을 사용하되, capability probe 결과가 `gpt-5.6-sol`만 허용하면 그 ID를 사용한다. Terra는 `gpt-5.6-terra`를 사용한다.

### 3.2 Anthropic Claude 계열

Anthropic은 Fable 5를 가장 높은 공개 가용 capability를 가진 장기 실행 agent 모델, Opus 4.8을 복잡한 agentic coding과 enterprise 업무용, Sonnet 5를 속도와 지능의 균형형으로 설명한다. 세 모델 모두 1M context와 128K 최대 출력을 제공하며 adaptive thinking을 지원한다. [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

| 모델 | 공식 포지션 | 상대 지연 | Context / 최대 출력 | API 참고 가격 Input / Output MTok | Orion 해석 |
|---|---|---|---:|---:|---|
| Claude Fable 5 | 장기 실행 agent용 차세대 intelligence, Anthropic의 가장 강한 일반 공개 모델 | 느림 | 1M / 128K | $10 / $50 | 가장 어려운 장기·멀티모달 산출물에 제한적으로 사용 |
| Claude Opus 4.8 | 복잡한 agentic coding과 enterprise 업무 | 보통 | 1M / 128K | $5 / $25 | 고위험 검토, 재무·규정·복합 공정, adversarial QA에 적합 |
| Claude Sonnet 5 | 속도와 지능의 최적 균형 | 빠름 | 1M / 128K | $3 / $15 | 빈번한 코딩, 운영, 제품 업무의 기본 workhorse에 적합 |

Sonnet 5는 coding과 agentic task에서 이전 세대 대비 큰 향상이 있다고 명시되어 있고, adaptive thinking이 기본 활성화된다. 같은 텍스트가 이전 Sonnet보다 약 30% 많은 token으로 계산될 수 있으므로 고정 token budget을 그대로 재사용하지 않는다. [Sonnet 5 변경 사항](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)

Opus 4.8은 복잡한 multi-service 탐색, tool 사용, 장기 분석, 오류와 불확실성 표시가 개선된 모델로 소개된다. 이는 고위험 review 및 enterprise 산출물 역할에 유리하지만 Provider의 자체 평가와 고객 사례라는 점을 감안해 로컬 평가로 검증한다. [Opus 4.8 발표](https://www.anthropic.com/news/claude-opus-4-8)

Fable 5는 adaptive thinking이 항상 켜져 있고 safeguard가 요청을 거절할 수 있다. 공식 문서상 30일 data retention이 적용되며 zero data retention 대상이 아니므로 `confidential`의 기본 모델로 사용하지 않고 `controlled`에서는 완전히 차단한다. refusal은 실패와 구분하여 허용된 fallback으로 전환한다. [Fable 5 운영 특성](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)

## 4. 모델 선택 정책

### 4.1 Hard gate

모델 점수를 계산하기 전에 다음 조건을 적용한다.

1. `controlled`: 모든 원격 LLM 실행 차단
2. `confidential`: Fable 5 기본 차단, 프로젝트 provider allowlist 적용
3. CLI에서 모델을 선택할 수 없거나 계정 한도가 소진됨: 다음 허용 fallback 사용
4. 에이전트 permission보다 넓은 sandbox 또는 도구 권한을 요구함: 실행 차단
5. 분류되지 않은 프로젝트: 실행 차단 후 자료 등급 지정 요청

### 4.2 역할 적합성 점수

| 평가축 | 가중치 | 판단 질문 |
|---|---:|---|
| 역할별 reasoning·domain fit | 30 | 해당 업무의 복잡도와 오류 비용에 충분한가 |
| agentic coding·tool use | 20 | 장기 실행, 도구 호출, 수정·검증 loop에 적합한가 |
| 신뢰성·검토 품질 | 15 | 불확실성, 반례, 증거를 잘 다루는가 |
| 처리량·지연 | 15 | 호출 빈도와 사용자 대기시간에 적합한가 |
| 구독 한도·상대 비용 | 10 | 같은 품질을 더 적은 quota로 달성할 수 있는가 |
| 운영 호환성 | 10 | CLI, context, structured output, fallback 처리와 맞는가 |

최종 배정은 공식 사양만으로 확정하지 않는다. 같은 역할 평가 세트를 후보 모델별로 최소 20회 실행하고, 정확도·완결성·수정 횟수·벽시계 시간·실패율을 기록한다.

## 5. 18개 에이전트 최종 배정과 이유

| # | 에이전트 | 기본 모델 | 배정 이유 |
|---:|---|---|---|
| 1 | Atlas | GPT-5.6 Sol | 전사 전략은 상충하는 근거와 장기 영향을 합성해야 하므로 최고 수준의 복합 reasoning을 우선한다. |
| 2 | Nova | Claude Sonnet 5 | 운영·조직 업무는 빈번한 반복과 실무 산출물이 많아 속도와 agent 능력의 균형이 중요하다. |
| 3 | Miro | GPT-5.6 Terra | 시장·고객 분석은 반복 검색과 다수 가설 비교가 많아 처리량과 분석 품질의 균형을 택한다. |
| 4 | Aegis | GPT-5.6 Sol | 무기도료 재료과학의 높은 오류 비용, 다학제 추론, 시험 근거 연결 때문에 Sol을 사용한다. |
| 5 | Ledger | Claude Opus 4.8 | 재무 문서·가정·규정의 정밀 검토가 필요하고 자료가 기밀일 가능성이 높아 Fable 대신 enterprise형 Opus를 사용한다. |
| 6 | Forge | Claude Sonnet 5 | 백엔드 코딩의 편집·테스트 반복에 coding/agent 성능과 빠른 응답이 잘 맞는다. |
| 7 | Luma | Claude Sonnet 5 | 프론트엔드 구현은 작은 시각·상태 수정이 자주 발생하므로 빠른 coding loop를 우선한다. |
| 8 | Iris | Claude Fable 5 | 공개·내부 등급의 복잡한 디자인 시스템, 이미지 이해, 장기 end-to-end 산출물에 최고 capability를 제한적으로 쓴다. 기밀·거절·미가용 시 즉시 fallback한다. |
| 9 | Verify | GPT-5.6 Terra | 대량 test 결과 분류와 회귀 분석을 안정적인 비용·속도로 반복해야 한다. |
| 10 | Sentinel | Claude Opus 4.8 | 성능·보안·탐색 QA는 반례 생성과 긴 공격 경로 분석이 중요해 고급 agentic review를 우선한다. |
| 11 | Archon | GPT-5.6 Sol | 시스템 경계, 다중 worktree 통합, 아키텍처 trade-off를 동시에 다루는 최고 난도 coding 판단 역할이다. |
| 12 | Orion | GPT-5.6 Sol | 전체 계획, 구조화 출력, 도구 사용, 다수 하위 결과 합성을 맡는 control-plane이므로 Sol을 사용한다. |
| 13 | Helios | Claude Opus 4.8 | 공정·양산·품질은 다단계 원인 분석과 장문 기술자료의 일관된 검토가 중요하다. |
| 14 | Regula | Claude Opus 4.8 | 규제·계약·IP는 근거와 불확실성 관리가 핵심이며 반드시 사람의 법률 검토로 handoff한다. |
| 15 | Insight | GPT-5.6 Terra | 데이터 profiling, 지표 계산, 반복 분석을 높은 처리량으로 수행하고 고난도 판단은 Sol에 escalation한다. |
| 16 | Keystone | Claude Sonnet 5 | DevOps·SRE 코드와 설정의 빠른 수정·검증 loop에 적합하며 외부 배포는 모델과 무관하게 승인한다. |
| 17 | Nexus | Claude Sonnet 5 | 요구사항·backlog·수용 기준은 잦은 상호작용과 반복 편집이 많아 균형형 모델을 사용한다. |
| 18 | Arca | Claude Sonnet 5 | 향후 M1-M5 metadata-only registry 계약은 medium reasoning을 사용하며, 실행 전 프로젝트 classification과 provider policy를 확인한다. Fable은 기본·fallback으로 금지하고 fallback은 GPT-5.6 Terra → Claude Opus 4.8 순서만 허용한다. |

### 5.1 Default와 Override의 provenance (M3)

위 배정표는 **기본 내장 18개의 카탈로그 권장값**이다. M3부터 각 프로필 version은 모델 선택의 출처를 두 필드로 명시한다.

| 필드 | 값 | 의미 |
|---|---|---|
| `selectionMode` | `default` | 이 표의 카탈로그 권장값을 그대로 사용한다. |
| | `override` | 사용자 또는 최고관리 에이전트가 다른 조합을 지정했다. |
| `selectionSource` | `catalog` | `default`와만 결합한다. |
| | `user` | 사용자가 지정한 override. |
| | `manager` | 최고관리 에이전트가 제안한 override. |

- `default`는 `catalog` 출처로만 성립하고, `override`는 `user` 또는 `manager`로만 귀속된다. 두 조합 밖의 값은 저장 단계에서 거부한다.
- `selectionMode`·`selectionSource`·provider·model·reasoningEffort·fallback은 하나의 `runtimeSelection`으로 프로필 version에 함께 저장된다. **권한은 이 객체에 포함되지 않는다.** override는 어떤 경우에도 §4.1의 hard gate와 권한 상한을 넓히지 못하며, fallback도 기본 모델과 동일한 권한 템플릿을 사용한다.
- 모델을 바꾸는 것은 기존 version을 수정하는 것이 아니라 **새 프로필 version을 만드는 것**이다. 이 표를 바꾸지 않고도 개별 에이전트의 실행 모델을 override할 수 있으며, 반대로 override가 있다고 해서 이 문서의 카탈로그 배정이 변경되지는 않는다.
- override에도 §4.1 hard gate, 프로젝트 classification, provider allowlist, Fable 규칙을 다시 적용한다. 실제 선택 결과와 `selectionSource`는 Run 스냅샷과 `run.model_fallback` 이벤트에 기록한다.
- custom 에이전트는 이 배정표에 포함되지 않는다. custom 에이전트의 모델 선택도 같은 두 필드와 같은 검증을 따르며, 카탈로그 권장값이 없으므로 항상 `override`다.
- 임의의 모델 문자열이 실행 argv에 직접 전달되지 않는다. argv는 registry에 등록된 모델 식별자만 사용하고 effort는 adapter가 지원 범위로 매핑한다.

## 6. 기본 fallback 순서

| 기본 모델 | Fallback 1 | Fallback 2 | 비고 |
|---|---|---|---|
| GPT-5.6 Sol | Claude Opus 4.8 | GPT-5.6 Terra | 최고 난도 역할은 다른 Provider의 고성능 모델을 먼저 사용 |
| GPT-5.6 Terra | Claude Sonnet 5 | GPT-5.6 Sol | 처리량을 유지하되 품질 저하 시 Sol로 승격 |
| Claude Fable 5 | Claude Opus 4.8 | GPT-5.6 Sol | refusal, 자료 정책, quota, 미가용 모두 고려 |
| Claude Opus 4.8 | GPT-5.6 Sol | Claude Sonnet 5 | 고난도 판단을 먼저 보존 |
| Claude Sonnet 5 | GPT-5.6 Terra | Claude Opus 4.8 | workhorse 특성을 유지한 뒤 고성능 모델로 승격 |

Fallback은 다음 경우에만 자동으로 실행한다.

- `MODEL_UNAVAILABLE`, provider capacity, 구독 quota, CLI capability 불일치
- Fable safeguard refusal
- 프로젝트 자료 등급이 기본 모델을 금지하지만 fallback은 허용하는 경우
- 동일 입력의 일시적 provider 실패가 재시도 한도를 소진한 경우

품질이 낮아 보인다는 추정만으로 실행 도중 모델을 바꾸지 않는다. 품질 기준 미달은 step 실패로 기록하고 정책에 정의된 retry 또는 사람 review로 보낸다. 모든 변경은 `run.model_fallback` 이벤트와 최종 보고서에 원인, 원래 모델, 실제 모델을 남긴다.

## 7. Effort 기본값

| 역할 유형 | 기본 effort | 예외 |
|---|---|---|
| 전체 조율·아키텍처·과학·재무·규정·보안 QA | `high` | release blocker나 복합 root cause는 `xhigh` 후보 |
| 일반 코딩·운영·제품·디자인 | `medium` | 위험한 migration이나 대규모 refactor는 `high` |
| 반복 분류·단순 회귀·정형 요약 | `low` 또는 `medium` | 실패·불일치가 감지되면 한 단계 승격 |

Provider별 effort 명칭이 다르면 adapter가 지원 범위 안에서 가장 가까운 값으로 매핑하고 실제 값을 run metadata에 저장한다. Fable 5의 adaptive thinking은 끌 수 없으므로 effort로 깊이를 제어한다.

## 8. 모델 Registry와 런타임 검증

앱은 모델 이름을 UI에 고정해서 성공을 가정하지 않는다. 시작 시와 수동 새로고침 시 다음을 수행한다.

1. `codex --version`, `claude --version` 확인
2. 각 CLI 인증 상태 확인
3. 지원되는 model·effort·structured output·streaming option probe
4. 10초 이내의 무해한 read-only smoke prompt 실행
5. primary와 fallback의 `available`, `blockedByPolicy`, `quotaUnknown`, `lastCheckedAt` 저장
6. 문서의 논리 이름과 실제 CLI model ID를 registry alias로 연결

Model Registry가 공식 profile과 충돌하면 실행을 강행하지 않고 UI에 `MODEL_UNAVAILABLE` 또는 `CLI_INCOMPATIBLE`을 표시한다.

### 8.1 M3의 결정론적 fake capability matrix

위 1~6번 절차는 **실제 CLI probe**를 전제한다. M3는 이를 수행하지 않는다. M3의 (provider, model, reasoningEffort) 검증은 결정론적 fake capability matrix fixture로만 이루어지며, 실제 provider 호출은 0회다.

- 모델 목록과 포지션의 기준은 §3(GPT-5.6 Sol·Terra, Claude Fable 5·Opus 4.8·Sonnet 5), effort 기본값의 기준은 §7, 가용성 상태 값은 기존 provider 모델 상태 enum(`available` / `unavailable` / `incompatible`)이다.
- fixture는 기존 fake provider registry를 확장한 것이며 `codex --version`·`claude --version` 확인, 인증 상태 확인, option probe, read-only smoke prompt를 수행하지 않는다.
- 저장 시 검증(미등록·미지원 조합 거부)과 실행 시 판정(`unavailable`·`incompatible` 모델은 저장은 가능하되 활성 실행 불가)은 이 fixture 기준으로 동작한다. 따라서 M3의 `available` 판정은 **문서상 등록 여부**를 뜻하며 사용자 계정의 실제 가용성을 증명하지 않는다.
- 실제 CLI capability probe와 read-only smoke는 M6 범위이며, 그때까지 이 문서의 §8 1~6번은 목표 계약으로 남는다.

## 9. 재평가 방법과 합격 기준

### 9.1 재평가 Trigger

- Provider가 새 모델 또는 migration 공지를 발표함
- CLI model ID, effort, permission, output format이 변경됨
- 최근 30회 중 역할 평가 실패율이 10%를 넘음
- fallback 발생률이 5%를 넘음
- 평균 실행시간 또는 quota 소모가 기준선보다 25% 이상 악화됨
- 자료 보존, safeguard, 지역 가용성 정책이 변경됨

### 9.2 Champion–Challenger 평가

1. 실제 자료를 비식별화한 역할별 gold set을 준비한다.
2. 현재 모델과 후보 모델을 같은 prompt·tool fixture·시간 한도로 실행한다.
3. 자동 점수와 사람 blind review를 함께 수행한다.
4. 정확성·안전성 hard fail이 하나라도 있으면 후보를 탈락시킨다.
5. 후보는 역할 총점이 현재 모델보다 5점 이상 높거나, 총점 차이가 2점 이내이면서 시간·quota가 20% 이상 개선되어야 한다.
6. 10개 canary task에서 회귀가 없을 때 profile version을 올린다.

### 9.3 역할 공통 Scorecard

| 항목 | 배점 | Hard fail 예시 |
|---|---:|---|
| 사실·계산·코드 정확성 | 30 | 허위 출처, 재현 불가 계산, test 실패 은폐 |
| 요구사항 완결성 | 20 | 필수 산출물 또는 수용 기준 누락 |
| 근거·불확실성 관리 | 15 | 추정을 사실처럼 단정 |
| 안전·권한 준수 | 20 | 무승인 외부 작업, 자료 등급 우회 |
| 도구 사용·복구력 | 10 | 같은 실패를 무한 반복, 잘못된 경로 수정 |
| 간결성·handoff 품질 | 5 | 다음 담당자가 실행할 수 없는 결과 |

합격선은 85점이며, 안전·권한 또는 사실 정확성 hard fail은 총점과 무관하게 탈락이다.

## 10. 구현 체크리스트

- [ ] 18개 profile의 primary·fallback이 Agent Catalog와 일치한다.
- [ ] Ledger의 기본 모델은 Opus 4.8이며 Fable이 아니다.
- [ ] 향후 M1-M5의 Arca는 Fable을 기본 모델 또는 fallback으로 절대 사용하지 않는다.
- [ ] Fable은 `confidential`에서 기본 차단되고 `controlled`에서 전면 차단된다.
- [ ] Fable refusal을 일반 transport error와 구분한다.
- [ ] Sonnet 5 token budget은 해당 tokenizer 기준으로 측정한다.
- [ ] 모델별 CLI ID와 사용 가능 여부를 시작 시 probe한다.
- [ ] fallback 이벤트와 최종 보고서에 실제 모델을 공개한다.
- [ ] 모델 변경 시 profile version, 평가 증적, 관련 문서를 함께 갱신한다.
- [ ] 모든 프로필 version이 `selectionMode`와 `selectionSource`를 가지며 `default`는 `catalog`와만 결합한다.
- [ ] 모델 override와 fallback이 권한 상한을 넓히지 않는다.
- [ ] M3의 모델 가용성 판정이 실제 CLI probe가 아니라 결정론적 fixture 기준임을 보고서에 명시한다.
- [ ] Provider 공식 사양만이 아니라 Orion 역할별 gold set을 통과한다.
- [ ] 공식 자료의 기준일을 분기마다 갱신한다.

## 11. 공식 출처

- [OpenAI Models: GPT-5.6 Sol·Terra 선택 기준과 사양](https://developers.openai.com/api/docs/models)
- [OpenAI GPT-5.6 Sol: alias, context, output, tools](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Anthropic Models Overview: Fable 5·Opus 4.8·Sonnet 5 비교](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic Claude Sonnet 5 변경 사항](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)
- [Anthropic Claude Fable 5 운영·보존·fallback 특성](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)
- [Anthropic Claude Opus 4.8 발표와 capability 사례](https://www.anthropic.com/news/claude-opus-4-8)


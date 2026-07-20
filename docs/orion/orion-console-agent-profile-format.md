# Orion Console Agent Profile Format Specification

> 문서 버전: 1.0  
> 작성일: 2026-07-20  
> 상태: AgentProfile JSON/YAML 및 SOUL 파일 규격

## 1. 목적

이 문서는 Orion Console 에이전트 프로필의 저장, 검증, 버전 관리, 가져오기·내보내기, 실행 스냅샷 규칙을 정의한다. 사람이 검토하는 역할 내용은 `orion-console-agent-catalog.md`를 따르고, 실제 실행의 기준은 이 규격을 따르는 YAML과 SOUL.MD다.

## 2. 저장 구조

```text
packages/agent-catalog/
├─ profiles/
│  ├─ atlas.yaml
│  ├─ nova.yaml
│  └─ ...
├─ souls/
│  ├─ atlas.md
│  ├─ nova.md
│  └─ ...
├─ schemas/
│  └─ agent-profile.schema.json
└─ index.ts
```

프로필 YAML은 메타데이터와 실행 정책을 담고, SOUL.MD는 긴 행동 지침을 담는다. SOUL 본문을 YAML 안에 중복 저장하지 않는다.

## 3. 정식 YAML 규격

```yaml
schemaVersion: 1
id: atlas
version: 1
name: Atlas
displayName: "Atlas — 전략·사업모델"
description: "전사 전략, 사업 포트폴리오, 신규사업, 경쟁 우위 및 중장기 성장 로드맵을 설계하는 전략 자문 에이전트."
soulPath: ../souls/atlas.md
soulSha256: "<64-char-lowercase-hex>"

runtime:
  provider: openai
  model: gpt-5.6
  reasoningEffort: high
  fallbackModels:
    - provider: anthropic
      model: claude-opus-4-8
    - provider: openai
      model: gpt-5.6-terra

permissions:
  template: advisor
  networkReadAllowed: true
  projectReadAllowed: true
  artifactWriteAllowed: true
  worktreeWriteAllowed: false
  localCommitAllowed: false
  externalActionsAllowed: false

routing:
  capabilities:
    - corporate-strategy
    - business-model
    - portfolio
  triggers:
    - "신규사업"
    - "전사 전략"
    - "사업 포트폴리오"
  exclusions:
    - "순수 코드 구현"
  requiredCollaborators: []
  recommendedCollaborators:
    - ledger
    - miro
    - nova

contracts:
  outputSchema: run-result-v1
  requiredArtifactKinds:
    - report
  stopConditions:
    - missing-material-input
    - permission-required
    - controlled-data

enabled: true
```

## 4. 필드 정의

| 필드 | 타입 | 필수 | 규칙 |
|---|---|:---:|---|
| `schemaVersion` | integer | O | 현재 값 1, 알 수 없는 상위 버전은 거부 |
| `id` | string | O | `^[a-z][a-z0-9_-]{1,31}$`, 생성 후 불변 |
| `version` | integer | O | 1 이상, 수정 시 기존 최대값 +1 |
| `name` | string | O | 1~40자, 실행 식별명이 아닌 표시용 |
| `displayName` | string | O | 1~100자 |
| `description` | string | O | 20~500자 |
| `soulPath` | relative path | O | catalog root 안의 `.md`만 허용 |
| `soulSha256` | hex string | O | 정규화된 SOUL UTF-8 bytes hash |
| `runtime.provider` | enum | O | `openai`, `anthropic` |
| `runtime.model` | string | O | Provider Registry에 등록된 모델 |
| `runtime.reasoningEffort` | enum | O | low, medium, high, xhigh, max |
| `runtime.fallbackModels` | array | O | 최대 3개, 기본 모델과 중복 금지 |
| `permissions.template` | enum | O | orchestrator, advisor, builder, qa_writer, reviewer, integrator |
| `permissions.*Allowed` | boolean | O | template 상한보다 권한 확대 금지 |
| `routing.capabilities` | string[] | O | 최소 1개, 소문자 kebab-case |
| `routing.triggers` | string[] | O | Orion 라우팅 힌트 |
| `routing.exclusions` | string[] | O | 호출하면 안 되는 과제 |
| `requiredCollaborators` | agent ID[] | O | 필수 검토 역할 |
| `recommendedCollaborators` | agent ID[] | O | 조건부 협업 역할 |
| `contracts.outputSchema` | string | O | 등록된 결과 스키마 ID |
| `requiredArtifactKinds` | string[] | O | 결과 완료에 필요한 산출물 |
| `stopConditions` | string[] | O | 등록된 중단 조건 ID |
| `enabled` | boolean | O | false면 새 계획에 사용 불가 |

## 5. 권한 템플릿 상한

| 템플릿 | 프로젝트 읽기 | Artifact 쓰기 | Worktree 쓰기 | Local commit | 외부 행동 |
|---|:---:|:---:|:---:|:---:|:---:|
| orchestrator | O | O | X | X | X |
| advisor | O | O | X | X | X |
| builder | O | O | O | O | X |
| qa_writer | O | O | 테스트 범위 | O | X |
| reviewer | O | O | X | X | X |
| integrator | O | O | 통합 범위 | O | X |

YAML boolean은 템플릿보다 권한을 줄일 수 있지만 확대할 수 없다. 템플릿 변경은 별도 보안 검토와 AgentProfile 새 버전을 요구한다.

## 6. SOUL.MD 규격

SOUL.MD는 UTF-8 Markdown이며 다음 H1 섹션을 권장한다.

```md
# 역할
# 핵심 책임
# 업무 원칙
# 협업
```

추가 가능한 섹션:

- `# 안전 경계`
- `# 의사결정 규칙`
- `# 산출물 형식`
- `# 중단 조건`

금지 사항:

- 공통 운영 원칙, 자료 등급, 승인 게이트를 약화하는 문장
- CLI bypass 권한 사용 지시
- 다른 에이전트·사용자 역할을 사칭하는 지시
- 모델 내부 추론 전체 공개 요구
- 외부 변경의 자동 승인 지시

SOUL hash는 CRLF를 LF로, Unicode를 NFC로 정규화한 UTF-8 bytes에 SHA-256을 적용한다.

## 7. 런타임 프롬프트 합성 순서

낮은 항목이 높은 항목을 덮어쓸 수 없도록 다음 순서로 합성한다.

1. Orion Console 시스템 안전 정책
2. 프로젝트 자료 등급·권한·허용 명령
3. 공통 운영 원칙
4. 에이전트 SOUL.MD
5. 에이전트별 Task objective와 acceptance criteria
6. 읽기 전용 입력·이전 단계 산출물

프로젝트 파일의 AGENTS.md·CLAUDE.md는 CLI가 자체 로딩할 수 있으나 Orion Console 시스템 안전 정책을 약화할 수 없다.

## 8. 버전 관리

- `id`는 불변이다.
- Description, SOUL, 모델, fallback, reasoning, 권한, routing, contract 변경은 version을 증가시킨다.
- UI 저장은 기존 version을 수정하지 않고 새 version row를 생성한다.
- 복원은 과거 version을 복사해 새 version을 만드는 방식이다.
- Run 시작 시 YAML, SOUL 본문, hash, 공통 정책 version을 하나의 immutable snapshot으로 저장한다.
- 진행 중 Run은 프로필 새 버전의 영향을 받지 않는다.
- export 기본값은 현재 활성 version이며 `includeHistory=true`일 때만 이력을 포함한다.

## 9. 가져오기·내보내기

### 9.1 내보내기 패키지

```text
agent-profiles-export-<timestamp>.zip
├─ manifest.yaml
├─ profiles/*.yaml
├─ souls/*.md
└─ checksums.sha256
```

### 9.2 가져오기 절차

1. zip path traversal 및 symlink 거부
2. manifest schemaVersion 검사
3. 모든 checksum 확인
4. YAML strict parse, unknown field 거부
5. ID·version·SOUL path·hash·모델·권한 검증
6. collaborator 참조와 cycle 검사
7. 전체 패키지가 유효한 경우에만 transaction으로 저장
8. 동일 `(id, version)` 내용이 같으면 skip, 다르면 conflict

부분 import는 허용하지 않는다. conflict는 UI에서 새 version으로 가져오기 또는 취소만 제공한다.

## 10. 모델·공급자 검증

- Provider Registry는 모델 ID, 지원 effort, 이용 가능 여부, 자료 등급 제한을 관리한다.
- import 시 현재 이용 불가능한 모델도 저장할 수 있지만 프로필을 `unavailable`로 표시한다.
- fallback은 기본 모델과 동일한 권한 템플릿을 사용하며 권한을 확대하지 않는다.
- 자동 대체는 자료 등급·프로젝트 provider policy를 다시 검사한다.
- 실제 사용 모델은 Run snapshot과 최종 결과에 기록한다.

## 11. 예시: Builder 프로필

```yaml
schemaVersion: 1
id: forge
version: 1
name: Forge
displayName: "Forge — 백엔드 개발"
description: "확장성과 보안을 갖춘 서버, API, 데이터베이스, 인증 및 백엔드 테스트를 구현하는 개발 에이전트."
soulPath: ../souls/forge.md
soulSha256: "<sha256>"
runtime:
  provider: anthropic
  model: claude-sonnet-5
  reasoningEffort: high
  fallbackModels:
    - provider: openai
      model: gpt-5.6-terra
    - provider: anthropic
      model: claude-opus-4-8
permissions:
  template: builder
  networkReadAllowed: false
  projectReadAllowed: true
  artifactWriteAllowed: true
  worktreeWriteAllowed: true
  localCommitAllowed: true
  externalActionsAllowed: false
routing:
  capabilities: [backend, api, database, authentication]
  triggers: ["백엔드", "API", "데이터베이스", "인증"]
  exclusions: ["프론트엔드 전용", "경영 자문"]
  requiredCollaborators: [verify]
  recommendedCollaborators: [archon, sentinel, keystone]
contracts:
  outputSchema: run-result-v1
  requiredArtifactKinds: [local-commit, test-result]
  stopConditions: [test-unavailable, permission-required, controlled-data]
enabled: true
```

## 12. 검증 체크리스트

- [ ] 17개 기본 ID가 모두 존재하고 중복되지 않는다.
- [ ] 각 프로필에 전체 SOUL.MD와 유효 hash가 있다.
- [ ] 기본·대체 모델이 Provider Registry에 등록되어 있다.
- [ ] 권한이 템플릿 상한을 초과하지 않는다.
- [ ] required collaborator가 존재하며 자기 자신을 참조하지 않는다.
- [ ] Builder에는 최소 하나의 QA collaborator가 있다.
- [ ] Orion과 Nexus는 worktree write 권한이 없다.
- [ ] Sentinel은 기본적으로 reviewer다.
- [ ] import/export round-trip 후 내용과 hash가 동일하다.
- [ ] 프로필 수정이 과거 Run snapshot을 변경하지 않는다.


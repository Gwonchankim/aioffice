# Orion Console API, Event & CLI Adapter Contract

> 계약 버전: 1.0  
> 작성일: 2026-07-20  
> 적용 범위: Loopback REST API, SSE, Codex CLI, Claude Code CLI

## 1. 목적과 규범

이 문서는 웹 클라이언트와 서버, 서버와 CLI 실행기 사이의 공개 계약을 정의한다. 구현 코드는 Zod 스키마와 생성된 OpenAPI를 최종 기준으로 하며 이 문서는 의미, 예제, 오류·호환 규칙을 설명한다.

- REST base path: `/api/v1`
- Content-Type: `application/json; charset=utf-8`
- ID: ULID 문자열
- 시간: UTC ISO 8601
- 경로: 서버 API에서는 canonical absolute path, browser에는 필요한 범위만 노출
- 숫자 token·duration은 음수가 될 수 없다.

## 2. 공통 응답

### 2.1 성공

```json
{
  "data": {},
  "meta": {
    "requestId": "01...",
    "timestamp": "2026-07-20T02:00:00.000Z"
  }
}
```

### 2.2 실패

```json
{
  "error": {
    "code": "PLAN_VALIDATION_FAILED",
    "message": "실행 계획을 검증하지 못했습니다.",
    "details": [{"path": "steps[2].agentId", "reason": "UNKNOWN_AGENT"}],
    "retryable": false
  },
  "meta": {
    "requestId": "01...",
    "timestamp": "2026-07-20T02:00:00.000Z"
  }
}
```

원문 CLI stderr는 기본 error response에 포함하지 않고 연결된 diagnostic artifact로 제공한다.

## 3. HTTP 규칙

- 상태 변경 POST/PATCH/DELETE는 `Idempotency-Key` header를 요구한다.
- 같은 key와 body hash 재요청은 이전 응답을 반환한다.
- 같은 key에 다른 body면 `409 IDEMPOTENCY_CONFLICT`다.
- 목록 기본 page size는 50, 최대 200이다.
- pagination은 opaque cursor를 사용한다.
- 존재하지 않음과 사용자가 볼 수 없음은 모두 404로 처리한다.
- 실행 중 리소스 충돌은 409, schema 위반은 422다.

## 4. 오류 코드

| HTTP | Code | 의미 | 자동 재시도 |
|---:|---|---|:---:|
| 400 | `BAD_REQUEST` | JSON·query 형식 오류 | X |
| 401 | `SESSION_REQUIRED` | 로컬 웹 세션 없음 | X |
| 403 | `ORIGIN_REJECTED` | Host·Origin·CSRF 실패 | X |
| 404 | `NOT_FOUND` | 리소스 없음 | X |
| 409 | `INVALID_STATE_TRANSITION` | 현재 상태에서 명령 불가 | X |
| 409 | `IDEMPOTENCY_CONFLICT` | 같은 key, 다른 요청 | X |
| 409 | `WORKTREE_CONFLICT` | Git 통합·worktree 충돌 | X |
| 422 | `VALIDATION_FAILED` | Zod·도메인 검증 실패 | X |
| 422 | `PLAN_VALIDATION_FAILED` | DAG·권한·게이트 검증 실패 | 재계획 |
| 423 | `APPROVAL_REQUIRED` | 승인 전 외부 작업 | X |
| 429 | `TASK_LIMIT_REACHED` | 120분·60회 한도 | X |
| 503 | `PROVIDER_UNAVAILABLE` | CLI·모델·인증 불가 | 조건부 |
| 507 | `RESOURCE_EXHAUSTED` | 메모리·디스크 부족 | O |
| 500 | `INTERNAL_ERROR` | 예상하지 못한 서버 오류 | 조건부 |

## 5. 핵심 REST API

### 5.1 Health와 Provider

#### `GET /api/v1/health`

성공 응답은 공통 `{ data, meta }` envelope를 유지하며 HTTP `200`이다. 전체 상태 enum은 `"healthy" | "degraded" | "unhealthy"`이고, `database`, `scheduler.status`, `retention.status` enum은 각각 `"ok" | "not_initialized" | "error"`이다.

```ts
interface HealthSuccess {
  data: {
    status: "healthy" | "degraded" | "unhealthy";
    database: "ok" | "not_initialized" | "error";
    scheduler: {
      status: "ok" | "not_initialized" | "error";
      active: number; // 0 이상의 정수
      capacity: number; // 0 이상의 정수
      queued: number; // 0 이상의 정수
    };
    resources: {
      memoryPercent: number; // 유한한 0..100 값
      freeDiskBytes: number; // 0 이상의 safe integer
    };
    retention: {
      lastRunAt: string | null; // UTC ISO 8601 또는 아직 실행되지 않은 null
      status: "ok" | "not_initialized" | "error";
    };
  };
  meta: {
    requestId: string; // ULID
    timestamp: string; // UTC ISO 8601
  };
}
```

M0의 truthfully degraded 응답은 항상 `data.status: "degraded"`, `database: "not_initialized"`, `scheduler: { status: "not_initialized", active: 0, capacity: 0, queued: 0 }`, `retention: { lastRunAt: null, status: "not_initialized" }`를 사용한다. `resources`만 요청 시 실제 측정값을 반환한다. `healthy`는 필요한 초기화된 하위 시스템이 모두 `ok`일 때만 가능하고, `degraded`는 `not_initialized` 또는 치명적이지 않은 오류가 있는 상태이며, `unhealthy`는 필수 상태를 안정적으로 제공하거나 측정할 수 없는 상태다. M0에는 Arca를 포함한 M1 운영 하위 시스템이 없으므로 이를 `ok` 또는 운영 중으로 표시하지 않는다.

#### `GET /api/v1/providers`

반환 필드: provider, installed, cliVersion, authenticated, status, supportedModels, lastCheckedAt, sanitizedError. 이메일·조직·token은 반환하지 않는다.

#### `POST /api/v1/providers/refresh`

두 CLI의 path, version, login status를 다시 확인한다. 실행 중 run을 중단하지 않는다.

### 5.2 Project

#### `POST /api/v1/projects`

```json
{
  "name": "Orion Console",
  "repositoryPath": "C:\\work\\orion-console",
  "defaultBranch": "main",
  "classification": "internal",
  "providerPolicy": {"openai": true, "anthropic": true, "allowFable": true},
  "allowedCommands": {
    "read": [["git", "status"], ["git", "diff"]],
    "verify": [["pnpm", "test"], ["pnpm", "build"]],
    "localWrite": [["git", "add"], ["git", "commit"]]
  }
}
```

서버는 path canonicalization, Git repository, branch, duplicate path, 자료 등급을 검사한다. 응답에는 Project와 현재 HEAD SHA, dirty 여부가 포함된다.

#### `PATCH /api/v1/projects/:id`

수정 가능: name, defaultBranch, classification, providerPolicy, allowedAgentIds, allowedCommands. 실행 중 task가 있을 때 classification 완화와 권한 확대는 409다.

#### `DELETE /api/v1/projects/:id`

등록만 해제한다. 저장소·branch·worktree를 삭제하지 않는다. 실행 또는 보존 worktree가 있으면 409와 목록을 반환한다.

### 5.3 AgentProfile

#### `GET /api/v1/agents`

현재 활성 version과 provider health를 반환한다.

#### `POST /api/v1/agents/:id/versions`

요청은 AgentProfile 전체 payload와 SOUL Markdown을 포함한다. 서버가 새 version과 soul hash를 생성한다. 기존 version 수정은 지원하지 않는다.

#### `POST /api/v1/agents/import`

multipart zip 또는 JSON/YAML bundle을 받는다. dryRun query가 true면 저장 없이 검증 결과와 conflict를 반환한다.

#### `GET /api/v1/agents/export?format=yaml&includeHistory=false`

checksum이 포함된 zip을 반환한다.

### 5.4 Task

#### `POST /api/v1/tasks`

```json
{
  "projectId": "01...",
  "title": "인증 기능 구현",
  "objective": "인증된 사용자만 프로젝트 목록을 조회하도록 구현한다.",
  "successCriteria": [
    "비인증 요청은 401",
    "인증 요청은 프로젝트 목록 반환",
    "단위·E2E 테스트 통과"
  ],
  "inputArtifactIds": [],
  "maxDurationMinutes": 120,
  "maxAgentRuns": 60
}
```

응답 status는 draft다. controlled project는 task 생성은 가능하지만 plan/start는 거부한다.

#### `POST /api/v1/tasks/:id/plan`

Orion run을 생성해 plan을 만들고 validator 결과를 함께 반환한다. 이미 유효한 plan이 있으면 새 plan version을 만든다.

#### `POST /api/v1/tasks/:id/start`

유효한 최신 plan이 있어야 한다. 응답은 202와 task 상태 queued다.

#### `POST /api/v1/tasks/:id/cancel`

body: `{"reason":"사용자 요청"}`. 모든 준비 step을 취소하고 active run에 cancel을 전파한다.

#### `POST /api/v1/tasks/:id/retry`

body: `{"stepIds":["..."],"resumeSession":true}`. 성공 dependency가 변하지 않은 실패·중단 step만 허용한다.

### 5.5 Approval

#### `POST /api/v1/approvals/:id/approve`

```json
{
  "expectedActionHash": "sha256:...",
  "comment": "integration SHA 확인"
}
```

hash, target SHA, 만료시각, approval status를 transaction에서 확인하고 외부 action을 한 번만 queue한다.

#### `POST /api/v1/approvals/:id/reject`

body에 reason이 필수다. task는 기본적으로 waiting_approval에서 needs_attention으로 전환한다.

### 5.6 미래 Arca 지식 레지스트리 vNext 계약

이 절은 M1-M5의 versioned vNext 계약이며, 공통 success/error envelope, `ULID`, UTC ISO 8601, `Idempotency-Key`, `NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `INVALID_STATE_TRANSITION`, `APPROVAL_REQUIRED` taxonomy를 재사용한다. M0에는 아래 endpoint, event, registry DB, connector, search, excerpt fetch, Nexus/specialist invocation이 구현되지 않으며 `/api/v1`에 Arca route를 추가하지 않는다. 모든 vNext request/response schema는 strict하고 unknown field를 거부하며, SourceCard/SourceRequest의 필드·nullability·immutability·CAS·lifecycle는 기술 명세서의 SC-001..SC-006, SR-001..SR-004, RS-001..RS-004, LC-001..LC-005를 따른다.

#### 5.6.1 리소스와 endpoint

| Method | vNext path | 계약 |
|---|---|---|
| `POST` | `/api/vNext/registry/source-cards` | `register_source` strict input으로 SourceCard를 등록한다. generated-only field를 거부하고 성공 시 active card를 반환한다. |
| `GET` | `/api/vNext/registry/source-cards/:sourceId` | 인가된 SourceCard metadata만 반환한다. |
| `PATCH` | `/api/vNext/registry/source-cards/:sourceId` | 인가된 mutable metadata만 `expectedMetadataVersion` CAS로 갱신한다. source-content identity, classification downgrade, raw content는 거부한다. |
| `POST` | `/api/vNext/registry/query` | `projectId`, requester identity/role, `purpose`, query/filter, optional opaque cursor를 받는 authorization-constrained registry query다. |
| `POST` | `/api/vNext/registry/source-cards/:sourceId/excerpt` | path의 `sourceId`, body의 `purpose`, requester identity/role, 최소 `range`(sheet/page/paragraph/range)를 요구한다. authorization·classification 재검사 뒤 필요한 bounded excerpt만 반환한다. |
| `POST` | `/api/vNext/registry/source-cards/:sourceId/lifecycle` | `expectedMetadataVersion`, requested lifecycle action, verification evidence 또는 exact archive approval을 받으며 LC-001..LC-005의 허용 전이만 수행한다. physical source mutation·deletion endpoint는 없다. |
| `POST` | `/api/vNext/registry/source-requests` | caller-supplied missing-material SourceRequest만 생성한다. hidden source reference를 받거나 자동 생성하지 않는다. |
| `GET` | `/api/vNext/registry/source-requests/:requestId` | 인가된 SourceRequest를 반환한다. |
| `PATCH` | `/api/vNext/registry/source-requests/:requestId` | open state의 mutable detail만 `expectedMetadataVersion` CAS로 수정한다. |
| `POST` | `/api/vNext/registry/source-requests/:requestId/resolve` | 같은 project의 non-archived SourceCard와 `resolvedAt`을 검증해 `open -> resolved`만 원자적으로 수행한다. |
| `POST` | `/api/vNext/registry/source-requests/:requestId/cancel` | `open -> cancelled`만 수행한다. |
| `POST` | `/api/vNext/registry/invocations` | Nexus 또는 specialist caller가 `projectId`, requester identity/role, `purpose`, query 또는 source/range request를 명시해 versioned registry contract를 호출한다. 호출은 새 repository-write·permission-change·classification-downgrade·external-share·raw-content persistence 권한을 부여하지 않는다. |

검색 성공 응답은 공통 envelope의 `data.items`만 사용하고, visible result가 없을 때 `{"data":{"items":[]}}` 형태의 빈 collection을 반환한다. 총 개수, 존재 여부, source-derived cursor, facet은 반환하지 않는다. excerpt 응답은 metadata에 허용된 bounded range만 포함하며 raw excerpt를 DB, full prompt/tool log, artifact preview, Agent memory에 저장하지 않는다.

#### 5.6.2 레지스트리 audit event

vNext registry action은 기존 event envelope와 audit sink를 재사용할 수 있으며 다음 event type만 추가할 수 있다: `registry.source_registered`, `registry.source_updated`, `registry.source_queried`, `registry.excerpt_fetched`, `registry.source_lifecycle_changed`, `registry.source_request_created`, `registry.source_request_resolved`, `registry.source_request_cancelled`, `registry.source_lookup_not_found`. 각 audit record의 최소 필드는 `actor`, `action`, `sourceId` 또는 `requestId`, `projectId`, `purpose`, allow/deny `decision`, `policyVersion`, `connector`, `timestamp`, excerpt `range`/`locator`, `contentHash`다. raw content, raw excerpt, credential, raw connector output, full prompt, full tool log는 event 또는 audit에 넣지 않는다. audit view와 aggregate count도 authorization-filtered다.

#### 5.6.3 Source-specific non-disclosure

source-specific `GET`, bounded-excerpt fetch, lifecycle/detail operation, SourceRequest resolution의 source reference, 그리고 Nexus/specialist source-specific invocation은 동일한 non-disclosure contract를 따른다.

1. invisible/unauthorized source와 nonexistent source는 모두 같은 HTTP `404`와 표준 `NOT_FOUND` error envelope를 반환하며 source-derived `details`나 protected metadata를 넣지 않는다.
2. query는 requester role, project scope, purpose, classification, `allowedRoles` predicate를 candidate 생성 전에 적용한다. invisible-only result와 no-match result는 같은 empty success envelope를 반환한다.
3. `PERMISSION_DENIED`는 source ID, query, candidate, connector, SourceRequest를 검사하기 전의 source-independent missing registry-scope precondition에만 허용된다. source-specific path에서는 절대 사용하지 않는다.
4. 두 source-specific not-found 경로는 같은 authorization-constrained lookup, bounded response budget, response shape를 사용한다. candidate-specific connector/excerpt read, metadata hydration, conditional count, response-size branch, source-dependent fast/slow branch를 수행하지 않는다.
5. source-specific 결과로 SourceRequest, status change, notification, audit-view-visible event 또는 다른 caller-observable side effect를 자동 생성하지 않는다. zero-visible-result 뒤 caller가 명시적으로 만드는 SourceRequest는 caller-supplied material만 담고 hidden source reference를 포함하지 않는다.

이 계약은 source existence, title, summary, owner, locator, classification, version, result count, timing, metadata와 SourceRequest side-channel을 모두 보호한다. controlled SourceCard의 summary 또는 excerpt는 모델 선택과 무관하게 원격 모델로 절대 전송하지 않는다.

## 6. SSE 계약

### 6.1 연결

`GET /api/v1/tasks/:id/events`

- `Accept: text/event-stream`
- event `id`: task별 monotonic sequence
- event `event`: RunEvent type
- event `data`: RunEvent JSON
- 15초마다 `:heartbeat <timestamp>` comment
- 연결 시 `Last-Event-ID` 이후 DB 이벤트를 replay한 다음 live stream에 연결
- 보존 기간보다 오래된 ID면 `event: stream.reset`과 현재 snapshot URL을 보냄

### 6.2 공통 envelope

```json
{
  "schemaVersion": 1,
  "id": "01...",
  "sequence": 42,
  "taskId": "01...",
  "stepId": "01...",
  "runId": "01...",
  "provider": "anthropic",
  "type": "run.output.delta",
  "timestamp": "2026-07-20T02:10:00.000Z",
  "payload": {}
}
```

알 수 없는 event type은 클라이언트가 무시하고 diagnostic count만 증가시킨다. schemaVersion 상위 major는 stream을 중단하고 새로고침을 요구한다.

### 6.3 이벤트별 payload

| Type | 필수 payload |
|---|---|
| `task.status` | from, to, reason? |
| `step.status` | from, to, agentId, reason? |
| `run.started` | attempt, provider, model, profileVersion, sessionId? |
| `run.output.delta` | channel: summary/raw, text |
| `run.tool.started` | toolName, sanitizedInput, externalMutation:boolean |
| `run.tool.completed` | toolName, status, durationMs, sanitizedOutput? |
| `run.usage` | inputTokens?, outputTokens?, cacheTokens?, reportedCost?, currency? |
| `run.retry` | attempt, delayMs, reasonCode |
| `run.model_fallback` | fromProvider, fromModel, toProvider, toModel, reasonCode |
| `approval.requested` | approvalId, actionType, targetSummary, expiresAt |
| `artifact.created` | artifactId, kind, title, sizeBytes, sha256 |
| `git.commit` | commitSha, branch, filesChanged, summary |
| `test.result` | commandDisplay, status, durationMs, summary, artifactId? |
| `run.completed` | status, resultArtifactId, durationMs |
| `run.failed` | errorCode, retryable, sanitizedMessage, diagnosticArtifactId? |
| `run.cancelled` | requestedBy, reason |

`sanitizedInput`과 `sanitizedOutput`은 secret masker를 거친다. 전체 파일 본문과 환경 변수는 event payload에 넣지 않는다.

## 7. Adapter 공통 계약

```ts
interface AgentRuntimeAdapter {
  inspect(): Promise<ProviderHealth>;
  start(request: AgentRunRequest): AsyncIterable<NormalizedAdapterEvent>;
  resume(request: ResumeRunRequest): AsyncIterable<NormalizedAdapterEvent>;
  cancel(runtimeHandle: string): Promise<void>;
}
```

### 7.1 AgentRunRequest

필드: runId, taskId, stepId, agent snapshot, prompt, cwd, executionMode, outputSchemaPath, allowedTools, allowedCommands, timeoutAt, environmentVariableNames.

프롬프트와 secret 값은 DB event에 그대로 저장하지 않고 별도 접근 제한 log/artifact에 저장한다.

### 7.2 Adapter 결과 규칙

- JSON parse 오류 한 건으로 프로세스를 즉시 죽이지 않고 raw diagnostic에 저장한다.
- 연속 5개 invalid event 또는 final schema 미검증은 `ADAPTER_PROTOCOL_ERROR`다.
- stdout event 순서를 유지한다.
- stderr는 provider diagnostic이며 일반 output delta로 변환하지 않는다.
- process exit 0이라도 RunResult가 없거나 schema가 틀리면 실패다.
- 취소 요청 후 발생한 final success는 cancelled가 우선한다.

## 8. Codex Adapter Mapping

### 8.1 실행 명령

```text
codex exec --json --model <model> --sandbox <mode> --cd <cwd> --output-schema <schema> -
```

재개:

```text
codex exec resume <thread-id> --json -
```

### 8.2 이벤트 변환

| Codex event | Normalized event |
|---|---|
| `thread.started` | session ID 저장 + `run.started` 보강 |
| `turn.started` | diagnostic only |
| `item.started` tool/command | `run.tool.started` |
| `item.completed` tool/command | `run.tool.completed` |
| `item.completed` agent_message | `run.output.delta` 또는 final candidate |
| `turn.completed` usage | `run.usage` |
| `turn.failed` | `run.failed` |
| `error` | error 분류 후 retry/fail |

Codex가 알 수 없는 event를 추가하면 raw fixture를 보존하고 UI에는 unsupported event count만 표시한다.

## 9. Claude Adapter Mapping

### 9.1 실행 명령

```text
claude --print --output-format stream-json --verbose --model <model> --effort <level> --permission-mode <mode> --json-schema <schema-json>
```

### 9.2 이벤트 변환

| Claude message/event | Normalized event |
|---|---|
| system init | session ID 저장 + `run.started` 보강 |
| assistant text delta | `run.output.delta` |
| tool_use | `run.tool.started` |
| tool_result | `run.tool.completed` |
| result usage | `run.usage` |
| final structured output | RunResult candidate |
| `system/api_retry` | `run.retry` |
| result error | `run.failed` |

`--include-partial-messages`는 UI 실시간성이 필요할 때만 사용하며 fixture로 token delta 폭주를 검증한다.

## 10. Error Classification

| Provider 신호 | 분류 | 조치 |
|---|---|---|
| model unavailable | `MODEL_UNAVAILABLE` | fallback 새 run |
| overloaded/rate limit | `PROVIDER_THROTTLED` | 30s·120s 재시도 후 fallback |
| login/auth | `PROVIDER_AUTH_REQUIRED` | 중지, Provider 화면 안내 |
| permission denied | `PERMISSION_DENIED` | 중지, 권한 확대 자동 금지 |
| output schema invalid | `OUTPUT_SCHEMA_INVALID` | 같은 run prompt 보정 1회 후 실패 |
| process crash | `PROCESS_CRASHED` | retryable 2회 |
| timeout | `RUN_TIMED_OUT` | process 종료, needs_attention |
| user cancel | `RUN_CANCELLED` | 재시도 없음 |

## 11. 버전 호환성

### 11.1 기준 버전

| Provider | 검증 기준 | 최소 지원 정책 |
|---|---|---|
| Codex CLI | 0.138.0 | major/minor 기능 probe가 성공해야 함 |
| Claude Code | 2.1.156 | `--output-format stream-json`, `--json-schema` 필요 |

버전 문자열만으로 허용하지 않고 앱 시작 시 help·비용 없는 capability probe 결과를 ProviderHealth에 저장한다.

### 11.2 호환 규칙

- fixture 계약 테스트를 통과한 버전은 `supported`다.
- 알려지지 않은 상위 버전은 `untested` 경고 후 read-only smoke가 성공해야 실행 가능하다.
- 필수 flag가 없으면 `unsupported`이며 해당 provider를 비활성화한다.
- CLI upgrade 후 첫 write run 전에 read-only smoke를 요구한다.

## 12. 테스트 계약

필수 fixture:

- Codex 정상, tool, usage, schema error, turn failure, rate limit, unknown event
- Claude 정상, partial message, tool, API retry, schema error, unknown message
- line chunk 분할, stderr 폭주, UTF-8 다국어, 매우 긴 line

필수 검증:

- event ordering과 sequence 유실 0
- SSE reconnect 후 중복·누락 0
- idempotent POST 중복 side effect 0
- final schema 없는 exit 0을 성공으로 처리하지 않음
- secret pattern이 API·SSE에 노출되지 않음


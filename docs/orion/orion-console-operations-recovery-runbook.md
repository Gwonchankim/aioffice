# Orion Console Operations, Recovery & Troubleshooting Runbook

> 문서 버전: 1.0  
> 작성일: 2026-07-20  
> 대상: 로컬 단일 사용자·Windows 운영

## 1. 운영 범위

이 문서는 Orion Console의 설치, 시작·종료, 공급자 상태, 백업·복원, 중단 작업, Git worktree, 보존·삭제, 장애 대응과 제거 절차를 정의한다.

## 2. 요구 환경

| 구성 | 기준 |
|---|---|
| OS | Windows 11 |
| Node.js | 24.x |
| pnpm | 11.x |
| Git | 지원되는 최신 stable |
| Codex CLI | 기준 0.138.0 이상, capability probe 통과 |
| Claude Code | 기준 2.1.156 이상, stream-json/json-schema 지원 |
| Memory | 16GB 이상 권장 |
| Free disk | write run 시작 시 최소 10GB |

두 CLI는 현재 Windows 사용자 계정으로 로그인되어 있어야 한다. 앱은 token을 저장하지 않는다.

## 3. 설치·개발 실행

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```
`pnpm typecheck`, `pnpm test`, and `pnpm test:coverage` (when run) each prepare the required workspace package outputs after install, so no manual `pnpm build` is needed first. `pnpm build` still precedes `pnpm smoke:workspace-import` and production start.

제품 서버는 기본 `127.0.0.1:4317`을 사용하고 충돌 시 다음 포트를 찾은 뒤 브라우저를 자동으로 연다.

개발:

```powershell
pnpm dev
```

실제 provider smoke는 기본 검증, CI, P3 implementation에서 실행하지 않는다. P4 validation worker만 login status와 trusted absolute native `ORION_CODEX_EXECUTABLE`/`ORION_CLAUDE_EXECUTABLE`를 확인한 뒤 다음 opt-in command를 사용한다.

```powershell
$env:ORION_REAL_PROVIDER_TESTS='1'
pnpm test:providers
Remove-Item Env:ORION_REAL_PROVIDER_TESTS
```

이 command는 source repository 밖의 synthetic public temporary Git repository를 만들고, Codex와 Claude를 각각 한 번만 fixed read-only argv, `shell:false`, provider별 5분 timeout으로 실행한다. retry, fallback, resume, web lookup, write tool은 없다. GitReadRunner private HEAD/index/tracked/untracked/file-tree snapshot을 실행 전·Codex 후·Claude 후·both 후에 비교하며, 차이는 즉시 fail-closed한다. console evidence는 provider/version/non-identifying executable fingerprint, invocation/result/usage/cost/timing, normalized event count, one-way session hash, child count, sanitizer count, `repositoryUnchanged`만 허용하며 prompt, stdout/stderr, credentials, identity, path/content/hash, full environment은 기록하지 않는다.

## 4. Runtime 위치

```text
%LOCALAPPDATA%\OrionConsole\
  orion.db
  logs\
  artifacts\
  worktrees\
  schemas\
  exports\
  backups\
  runtime.json
```

소스 저장소와 runtime data를 혼합하지 않는다. runtime directory를 Git에 추가하지 않는다.
### 4.1 M1 local database boundary

M1 creates `%LOCALAPPDATA%\OrionConsole\orion.db` only after the runtime directory is available outside the repository. Every connection verifies foreign keys and WAL mode before the ordered forward-only migrations run. `DATABASE_OPEN_FAILED`, `DATABASE_CONFIGURATION_FAILED`, `MIGRATION_FAILED`, and `DATABASE_UNAVAILABLE` are stable sanitized failure codes; a failure prevents the listener from serving a false `database: "ok"` health result.

Before any forward fix or application upgrade, checkpoint/online-backup the DB, record its SHA-256, and dry-open/migrate a copy in a separate temporary runtime. Do not edit an applied migration, delete `schema_migrations`, or use rollback SQL; ship the next ordered migration after the backup and test.


## 5. 정상 시작 점검
M1 starts only the local database/API boundary. Scheduler, retention, provider execution, connectors, and an operational Arca runtime remain intentionally uninitialized; later runbook sections for those capabilities do not imply M1 availability.

### 5.1 M1 startup and browser session constraints

1. Verify the selected runtime directory is an absolute path outside the repository.
2. Start the server; DB open/configuration/migration succeeds before the loopback listener binds.
3. Read `runtime.json` only for the loopback host and selected port; it never contains a bootstrap secret.
4. The browser receives a one-time bootstrap value only through an in-memory fragment handoff, clears that fragment before exchange, and receives a host-only `HttpOnly; Secure; SameSite=Strict` session cookie plus an in-memory CSRF value.
5. `GET /api/v1/health` is healthy only when `database` is `"ok"`. Scheduler and retention must remain `"not_initialized"` with zero/null M1 values.

Do not copy a bootstrap fragment into logs, tickets, runtime metadata, screenshots, traces, video, or browser artifacts.


시작 순서:

M1 start sequence:

1. runtime path·disk check
2. DB open, WAL/foreign-key verification, and forward-only migration
3. loopback bind
4. in-memory browser bootstrap handoff
5. initialized health check

For M1, the Dashboard must show server/database healthy, scheduler/retention `not_initialized`, measured free disk, and no operational Arca status. Provider authentication, active scheduler slots, and retention success are not M1 checks.

## 6. 정상 종료

UI의 시스템 종료 또는 서버에 graceful shutdown을 사용한다.

1. 새 task·run 시작 중지
2. active process cancel 또는 설정된 grace period 대기
3. event flush
4. SQLite checkpoint
5. runtime lock 해제

터미널 창을 강제로 닫은 경우 다음 시작에서 active run이 interrupted로 복구된다.

## 7. 공급자 문제 해결

### 7.1 Codex 미설치

증상: Provider status `not_installed`.

조치:

- `Get-Command codex` 확인
- `codex --version` 확인
- 설치 후 앱의 `공급자 상태 다시 확인` 실행

### 7.2 Codex 로그인 만료

증상: `PROVIDER_AUTH_REQUIRED`.

조치:

- 터미널에서 `codex login status`
- 필요한 로그인 절차 수행
- 앱에서 provider refresh
- 실패 step만 재시도

### 7.3 Claude 로그인 만료

증상: Claude provider auth failure.

조치:

- `claude auth status`
- Claude Code 로그인 복구
- provider refresh
- 실패 step 재시도

### 7.4 Unsupported CLI version

증상: 필수 flag probe 실패 또는 unknown protocol event 반복.

조치:

- provider를 write disabled로 유지
- version과 `--help` 확인
- adapter fixture와 mapping 갱신
- read-only smoke 통과 후 write 재활성화

### 7.5 Rate limit·overload

앱이 30초·120초 backoff와 모델 fallback을 자동 처리한다. 반복되면:

- 대기 queue와 provider별 active 수 확인
- concurrency를 일시적으로 낮춤
- 모델 fallback 이력 확인
- auth error와 혼동하지 않음

## 8. Task 장애 대응

### 8.1 Stalled

120초 event 없음은 stalled 표시일 뿐 즉시 실패가 아니다.

- provider process 존재 여부 확인
- CPU·network·provider 상태 확인
- run timeout 전에는 불필요한 강제 종료를 피함
- 사용자가 취소하면 부분 artifact·worktree를 보존

### 8.2 Task limit reached

120분 또는 60 run 도달 시:

- 새 run이 시작되지 않는다.
- 성공·실패·미실행 step을 확인한다.
- 범위를 줄인 새 task를 만들거나 한도를 변경한 새 task를 생성한다.
- 기존 task 한도를 소급 확대하지 않는다.

### 8.3 Plan validation failed

- validator 오류 목록 확인
- Orion 재계획 2회 결과 확인
- unknown agent·권한·필수 QA·cycle을 수정
- 사용자 수동 plan 수정 후 재검증

### 8.4 Model fallback exhausted

- 자료 등급·provider policy가 fallback을 차단했는지 확인
- provider auth·model availability 확인
- 정책을 임의 완화하지 말고 profile 새 version 또는 사용자 승인을 통해 변경

## 9. 서버 중단 복구

재시작 시 앱은 다음을 수행한다.

- DB상 running인데 PID가 없는 run→interrupted
- read-only run + session ID→resume 후보
- write run→worktree 검사 recovery step
- dirty integration→자동 정리·재개 금지
- pending approval→상태 유지, expiry 연장 없음

운영자 체크:

- interrupted run 목록
- worktree dirty/untracked/unmerged 상태
- session resume 가능 여부
- 중복 active run이 없는지
- 외부 action이 executed인지 queued인지

중복 가능성이 있으면 scheduler를 중지하고 audit log와 action hash를 확인한다.

## 10. Git Worktree 복구

### 10.1 상태 확인

UI Worktrees 탭 또는 다음 read-only 명령을 사용한다.

```powershell
git -C <repository> worktree list --porcelain
git -C <worktree> status --short --branch
git -C <worktree> log -1 --oneline
```

### 10.2 Dirty agent worktree

- 자동 삭제하지 않는다.
- 해당 run의 artifact·log와 status를 연결한다.
- 같은 agent recovery run이 변경을 검토해 commit 또는 needs_attention으로 처리한다.

### 10.3 Integration conflict

- conflicted file·cherry-pick 상태 확인
- Archon 자동 해결 최대 2회 기록 확인
- 수동 해결 시 app 밖에서 branch를 바꾸지 말고 해당 integration worktree에서 처리
- 해결 후 Verify 검증을 다시 실행

### 10.4 Orphan worktree

DB에 없지만 app runtime root 안에 있는 worktree는 자동 삭제하지 않는다.

- Git metadata와 commit 확인
- 관련 task/run을 찾음
- 소유권을 확인한 후 UI에서 adopt 또는 보존·정리 결정

## 11. DB 백업

### 11.1 백업 시점

- 앱 upgrade·migration 전
- 정기 주 1회
- SEV-1/2 사건 직후 변경 전

### 11.2 백업 내용

- SQLite online backup 또는 checkpoint 후 DB copy
- profile export
- audit log
- 중요 artifact manifest

worktree 전체는 기본 DB backup에 포함하지 않는다. 미통합 commit은 Git bundle 또는 해당 worktree 보존으로 별도 관리한다.

### 11.3 검증

- backup SHA-256 기록
- 별도 임시 runtime에서 DB open·migration dry check
- project canonical path가 현재 환경에 존재하는지 report
- applied migration은 수정하지 않고 다음 ordered migration으로 forward fix 하는지 확인

## 12. DB 복원

1. Orion Console 종료
2. 현재 runtime DB와 logs를 별도 incident backup으로 보존
3. 선택 backup checksum 확인
4. DB 복원
5. app 시작 전에 migration dry check
6. app 시작, provider·project·worktree health 검사
7. running 상태는 자동으로 interrupted 처리
8. 외부 approval executed history를 확인한 후 scheduler 활성화

복원으로 task 기록이 과거로 돌아가도 이미 수행된 외부 action을 재실행하지 않는다. ExternalActionHandler는 remote target과 action hash를 추가 검증한다.

## 13. 보존·즉시 삭제

### 13.1 자동 정책

- task event·prompt·artifact·usage: 완료 후 90일
- app worktree: 완료 후 7일, 미통합 변경 제외
- profile version·project·audit: 사용자 삭제 전까지

### 13.2 즉시 삭제

- active task이면 먼저 cancel·process 종료
- 삭제 preview에서 DB rows, artifact, worktree 후보 표시
- 미통합 worktree는 별도 확인 없이 삭제하지 않음
- delete operation ID와 결과를 audit에 기록

### 13.3 삭제 실패

- 일부 파일 잠금·권한 오류를 retry queue에 저장
- 성공한 대상은 다시 삭제하지 않음
- 24시간 반복 실패 시 운영 경고

## 14. Resource 문제

### Memory

- 80% 이상 또는 free <2GB면 새 run 지연
- active slot을 8→4→2로 수동 낮출 수 있음
- 기존 run은 자동 종료하지 않음

### Disk

- free <10GB면 새 write worktree 차단
- 만료 artifact와 안전한 완료 worktree 정리
- 사용자 저장소·미통합 worktree를 정리 대상으로 사용하지 않음

### Event DB 성장

- task별 event 수와 DB size 확인
- 90일 retention 상태 확인
- VACUUM은 active run이 없고 backup 후 수행

## 15. 승인·외부 행동 장애

- approval 만료: 새 요청 생성
- target SHA 변경: 기존 승인 폐기, 새 diff·승인
- action 실행 실패: 같은 approval을 자동 반복하지 않음
- 결과 불명확: remote 상태를 read-only 확인한 후 executed/failed 결정
- 중복 의심: scheduler·ExternalActionHandler 중지, action hash와 remote 상태 조사

## 16. 보안 사건 Runbook

### SEV-1 즉시 조치

1. scheduler pause
2. 모든 child process cancel
3. ExternalActionHandler disable
4. DB·audit·log·worktree metadata backup
5. 사용자에게 사건 종류·영향 표시
6. 기준 저장소와 remote 상태 확인
7. 원인 수정·보안 검증 전 write run 금지

### Secret 노출

- 노출 위치와 기간 확인
- 관련 token을 공급자에서 폐기·재발급
- 보존 log·artifact 즉시 삭제
- masker fixture와 회귀 테스트 추가

### Controlled data 전송 의심

- provider run·task 즉시 중지
- 어떤 자료가 어떤 provider에 전송되었는지 audit metadata 확인
- 관련 조직 보안·법무 절차로 에스컬레이션
- 자동 로그 삭제 전에 증거 보존 정책 확인

## 17. Update

1. release notes와 ADR·migration 확인
2. DB·profile export backup
3. active task 없음 확인
4. clean install·test·build
5. 새 version 시작, migration 수행
6. provider capability probe와 read-only smoke
7. project·profile·task history 검사
8. write run 하나를 임시 저장소에서 검증

실패 시 이전 code와 DB backup을 함께 복원한다. worktree는 삭제하지 않는다.

## 18. Uninstall

- application code 제거와 runtime data 제거를 분리한다.
- 기본 uninstall은 runtime DB·artifact·worktree를 보존한다.
- 전체 데이터 삭제는 preview·backup 여부·미통합 worktree를 확인한다.
- CLI 로그인·Git credentials는 Orion Console 소유가 아니므로 삭제하지 않는다.
- 등록 프로젝트 자체는 삭제하지 않는다.

## 19. 운영 체크리스트

### 매 시작

- [ ] DB healthy
- [ ] Codex·Claude authenticated
- [ ] free disk·memory 정상
- [ ] interrupted run·pending approval 확인
- [ ] retention 최근 성공

### 주간

- [ ] DB backup·restore verification
- [ ] orphan·dirty worktree 확인
- [ ] provider version 변경 확인
- [ ] failed retention·security alert 확인
- [ ] 모델 fallback·rate limit 추세 확인

### 릴리스 전

- [ ] active task 0
- [ ] DB·profile backup
- [ ] migration·rollback 기준 검토
- [ ] 전체 test·E2E·security 통과
- [ ] provider smoke
- [ ] 임시 저장소 write workflow

## 20. 향후 Arca 레지스트리 운영·복구

이 절은 M1-M5의 향후 운영·복구 계약이다. M0에는 Arca 레지스트리, DB, connector, scheduler, retention 또는 Arca 운영 상태가 없으며, M0 health가 이들을 운영 가능으로 표시해서는 안 된다.

### 20.1 최신성·connector 점검

권한 있는 운영자는 metadata-only SourceCard의 저장 checksum과 수정 시각을 read-only로 재검증한다. checksum 또는 modification time 불일치는 `stale`, 확인된 broken 또는 unreachable locator는 `missing`으로 전이한다. 새 버전 또는 checksum의 자료는 기존 카드의 immutable identity를 수정하지 않고 별도 SourceCard로 등록하며, 동일 프로젝트의 이전 카드는 원자적으로 `superseded`가 된다.

M4의 `local-folder`와 `registered-git` connector 점검은 canonical absolute path와 symlink/junction 해석 뒤 등록된 allowed root 안에 완전히 포함되는지 확인한다. relative, traversal, device, UNC 또는 root 밖으로 탈출하는 locator는 허용하지 않는다. 점검·복구는 connector를 통해 source repository를 쓰지 않는다.

### 20.2 상태별 복구

| 상태 | 운영·복구 처리 |
|---|---|
| `stale` | 원본을 변경하지 않고 권한 있는 재검증을 수행한다. 저장된 identity/checksum이 현재임을 증명하면 `active`로 복귀하고 `lastVerifiedAt`과 `metadataVersion`을 갱신한다. |
| `missing` | locator 복구 후 저장된 identity/checksum을 재검증한 경우에만 `active`로 복귀한다. 추측으로 대체 자료를 연결하지 않는다. |
| `superseded` | 후속 SourceCard와 lineage를 확인한다. `active`·`stale`·`missing`으로 되돌리지 않으며, 별도 유효 승인으로만 논리 `archived` 전이가 가능하다. |
| `archived` | terminal 상태로 유지한다. unarchive, 물리 삭제 또는 source repository 정리를 수행하지 않는다. |

모든 lifecycle 전이와 검증 갱신은 정해진 상태 전이, compare-and-swap `metadataVersion`, 그리고 archive의 단일 사용·미만료·정확한 카드/action/version 결합 승인을 검증한다.

### 20.3 감사 검토와 불변 원본 경계

감사 검토는 metadata-only로 수행한다. 권한 있는 검토자는 actor, action, sourceId/requestId, projectId, purpose, allow/deny 결정, policy version, connector, timestamp, excerpt range/locator, content hash를 확인하고, raw excerpt, credential, raw connector output, full prompt, full tool log를 수집하거나 표시하지 않는다. 감사 조회도 권한 필터를 적용하며 비가시·존재하지 않는 source-specific lookup의 차이나 집계를 노출하지 않는다.

Arca는 source repository의 소유자가 아니다. 운영, 복구, 최신성 확인, connector 오류 대응, 보관 절차 중에도 원본 저장소에 write, delete, move, rename, commit 또는 그 밖의 mutation을 수행하지 않는다.
